// 音源ライブラリの画面：サンプルとキットの一覧、絞り込み、試聴、楽器の直し、似た音、レーンへの割り当て、取り込みとバックアップ。
import { tr, pl, locale } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN_KITS, KIT_LANES, laneByCh } from '../audio/sounds';
import { toBase36x2 } from '../dtx/base36';
import { CH } from '../dtx/model';
import { freeWavNumber, setField } from '../edit/ops';
import { INSTS, instInfo } from '../library/analyze';
import type { Inst, LibraryKit } from '../library/db';
import { playAudition, useStopAuditionOnClose } from '../store/audition';
import { backToChart, edit, openPage, prepareSounds, previewWav, setLaneWav, toast, useEditor } from '../store/editor';
import { kitFile, setKit, useKit } from '../store/kit';
import {
  allItems,
  auditionItem,
  auditionKey,
  auditionSound,
  exportZip,
  filteredItems,
  grantFolders,
  importFromFileList,
  importZip,
  kitCount,
  loadBuiltinItems,
  pickAndImport,
  removeKit,
  removeSample,
  requestPersist,
  saveUserKit,
  setInst,
  setTags,
  similarItems,
  songsInLibrary,
  TAG_PRESETS,
  tagLabel,
  toggleFav,
  useLibrary,
  type LibItem,
} from '../store/library';
import { chooseDialog, confirmDialog, promptDialog } from './dialogs';
import { AuditionButton } from './Audition';
import { Icon } from './icons';
import { FolderInput } from './Editor';

const LIMIT = 300;

/** 楽器 → 割り当てるときの初期のレーン */
const DEFAULT_CH: Record<Inst, number> = { kick: CH.BD, snare: CH.SD, hihat: CH.HHC, tom: CH.HT, crash: CH.LC, ride: CH.RD, other: CH.SD };

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);

function Wave({ peaks, color, w = 120, h = 26, fluid }: { peaks: number[]; color: string; w?: number; h?: number; fluid?: boolean }) {
  const d = useMemo(() => {
    if (!peaks.length) return '';
    const step = w / peaks.length;
    const mid = h / 2;
    let top = `M0 ${mid}`;
    let bot = '';
    peaks.forEach((p, i) => {
      const y = Math.max(0.6, (p / 255) * (mid - 1));
      top += ` L${(i * step).toFixed(1)} ${(mid - y).toFixed(1)}`;
      bot = ` L${(i * step).toFixed(1)} ${(mid + y).toFixed(1)}` + bot;
    });
    return `${top} L${w} ${mid}${bot} Z`;
  }, [peaks, w, h]);
  return (
    <svg width={fluid ? '100%' : w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" style={{ display: 'block' }}>
      <path d={d} fill={color} opacity={0.85} />
    </svg>
  );
}

/** 今の譜面のレーンに、その音を割り当てる（#WAV に登録してレーンの音にする） */
async function assignToLane(item: LibItem, ch: number) {
  const s = useEditor.getState();
  if (s.screen !== 'editor') return;
  const file = item.file;
  let no = -1;
  for (const [k, v] of Object.entries(s.doc.fields)) {
    if (/^WAV[0-9A-Z]{2}$/.test(k) && v.toLowerCase() === file.toLowerCase() && s.doc.fields['VOLUME' + k.slice(3)] === undefined) no = parseInt(k.slice(3), 36);
  }
  if (no < 0) {
    const lane = laneByCh.get(ch)?.label ?? tr('レーン', 'lane');
    edit(tr(`${lane}に ${item.name} を割り当て`, `Assign ${item.name} to ${lane}`), (d) => {
      no = freeWavNumber(d) ?? -1;
      if (no > 0) setField(d, 'WAV' + toBase36x2(no), file);
    });
  }
  if (no <= 0) {
    toast(tr('WAV番号が足りません', 'Out of WAV numbers'), 'error');
    return;
  }
  setLaneWav(ch, no);
  await prepareSounds();
  previewWav(no);
  toast(tr(`${laneByCh.get(ch)?.label} の音を ${item.name} にしました（これから置くチップに使います）`, `${laneByCh.get(ch)?.label} now uses ${item.name} (for chips you place from now on)`), 'ok');
}

export function LibraryPage() {
  const st = useLibrary();
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [showAll, setShowAll] = useState(false);
  useStopAuditionOnClose('lib:');
  useEffect(() => {
    void loadBuiltinItems();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-back') && !(e.target instanceof HTMLInputElement)) backToChart();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const items = filteredItems(st);
  const all = allItems(st);
  const songs = songsInLibrary(st);
  const sel = all.find((x) => x.id === st.selected) ?? null;
  const counts = new Map<string, number>();
  for (const it of all) counts.set(it.inst, (counts.get(it.inst) ?? 0) + 1);
  const tags = [...new Set([...TAG_PRESETS, ...st.samples.flatMap((x) => x.tags)])];

  const startImport = async () => {
    const mode = await chooseDialog({
      title: tr('曲フォルダから取り込む', 'Import from song folders'),
      body: tr(
        'DTXManiaの曲フォルダ（またはその親フォルダ）を選ぶと、譜面で使われている音を楽器ごとに分けて取り込みます。曲で使われた組み合わせは「曲名キット」になります。',
        "Choose a DTXMania song folder (or its parent folder) to import the sounds its charts use, sorted by instrument. Each song's set of sounds becomes a kit named after the song.",
      ),
      options: [
        { label: tr('音声ごと取り込む（おすすめ）', 'Copy the audio (recommended)'), sub: tr('ブラウザ内に音をコピーします。元のフォルダが無くなっても使えます', 'Copies the sounds into the browser. They keep working even if the original folder is gone'), value: 'copy' as const },
        {
          label: tr('参照モード（容量を使わない）', "Reference mode (doesn't use storage)"),
          sub: tr(
            'フォルダの場所だけ覚え、使うときにそこから読みます。ブラウザを開き直すと許可のクリックが1回要ります（Chrome・Edge）',
            'Remembers only where the folder is and reads from it when needed. After reopening the browser, one click to grant access is needed (Chrome, Edge)',
          ),
          value: 'ref' as const,
        },
      ],
    });
    if (mode) await pickAndImport(mode, fileInput.current);
  };

  return (
    <div className="lib-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={backToChart}>
          {Icon.back(14)} {tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        <h1>{tr('音源ライブラリ', 'Sound library')}</h1>
        <label className="lib-search">
          {Icon.search(14)}
          <input value={st.q} onChange={(e) => useLibrary.setState({ q: e.target.value })} placeholder={tr('名前・曲名・タグで検索', 'Search by name, song or tag')} />
        </label>
        <span className="grow" />
        <button className="btn small ghost" onClick={() => openPage('guideline')} title={tr('手元の曲のレベル帯ごとの集計と基準文', 'Stats and guideline text by level band, from your local songs')}>
          {tr('難易度ガイドライン', 'Difficulty guidelines')}
        </button>
        <button className="btn small" onClick={() => void exportZip()} disabled={st.samples.length === 0} title={tr('ライブラリ全体を ZIP に書き出します', 'Export the whole library as a ZIP')}>
          {tr('ZIPでバックアップ', 'Back up as ZIP')}
        </button>
        <button className="btn small primary" onClick={() => void startImport()} disabled={!!st.importing}>
          {Icon.plus(14)} {tr('曲フォルダから取り込む', 'Import from song folders')}
        </button>
        <FolderInput inputRef={fileInput} onFiles={(l) => void importFromFileList(l)} />
        <input
          ref={zipInput}
          type="file"
          accept=".zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importZip(f);
          }}
        />
      </header>
      <div className="lib-body">
        <aside className="lib-side scroll">
          <div className="seg full">
            <button className={st.tab === 'samples' ? 'on' : ''} onClick={() => useLibrary.setState({ tab: 'samples' })}>
              {tr('サンプル', 'Samples')}
            </button>
            <button className={st.tab === 'kits' ? 'on' : ''} onClick={() => useLibrary.setState({ tab: 'kits' })}>
              {tr('キット', 'Kits')}
            </button>
          </div>
          {st.tab === 'samples' && (
            <>
              <div className="lib-h">{tr('楽器（自動判定）', 'Instrument (auto-detected)')}</div>
              <SideRow on={st.inst === 'all'} color="#E7EBF1" label={tr('すべて', 'All')} n={all.length} onClick={() => useLibrary.setState({ inst: 'all' })} />
              {INSTS.map((i) => (
                <SideRow key={i.id} on={st.inst === i.id} color={i.color} label={i.label} n={counts.get(i.id) ?? 0} onClick={() => useLibrary.setState({ inst: i.id })} />
              ))}
              <div className="lib-h">{tr('出典', 'Source')}</div>
              <SideRow on={st.source === 'all' && !st.song} label={tr('すべて', 'All')} n={all.length} onClick={() => useLibrary.setState({ source: 'all', song: null })} />
              <SideRow on={st.source === 'builtin'} label={tr('標準キット（GM）', 'Built-in kits (GM)')} n={st.builtins.length} onClick={() => useLibrary.setState({ source: 'builtin', song: null })} />
              <SideRow
                on={st.source === 'imported' && !st.song}
                label={tr('取り込んだ曲', 'Imported songs')}
                n={songs.length}
                unit={tr('曲', '')}
                onClick={() => useLibrary.setState({ source: 'imported', song: null })}
              />
              <SideRow on={st.source === 'fav'} label={tr('お気に入り', 'Favorites')} n={st.samples.filter((x) => x.fav).length} onClick={() => useLibrary.setState({ source: 'fav', song: null })} />
              {songs.length > 0 && (
                <select
                  className="field"
                  style={{ marginTop: 6, height: 28 }}
                  value={st.song ?? ''}
                  onChange={(e) => useLibrary.setState({ song: e.target.value || null, source: 'all' })}
                  aria-label={tr('曲で絞り込む', 'Filter by song')}
                >
                  <option value="">{tr('曲で絞り込む…', 'Filter by song…')}</option>
                  {songs.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
              <div className="lib-h">{tr('音色タグ', 'Tone tags')}</div>
              <div className="lib-tags">
                {tags.map((t) => (
                  <button key={t} className={st.tag === t ? 'on' : ''} onClick={() => useLibrary.setState({ tag: st.tag === t ? null : t })}>
                    {tagLabel(t)}
                  </button>
                ))}
              </div>
            </>
          )}
          {st.tab === 'kits' && (
            <p className="lbl" style={{ lineHeight: 1.7 }}>
              {tr(
                'キットは「レーンとサンプルの対応表」です。譜面のキットのタブで選ぶと、これから置くチップにその音を使います。',
                'A kit maps lanes to samples. Choose one on the Kit tab of the chart screen to use its sounds for the chips you place from then on.',
              )}
            </p>
          )}
          <span className="grow" />
          <div className="lib-store">
            {st.storage && (
              <div>
                {tr('保存先: ブラウザ内（', 'Stored in: this browser (')}
                {mb(st.storage.usage)}
                {st.storage.quota ? tr(` / 空き ${mb(Math.max(0, st.storage.quota - st.storage.usage))}`, ` / ${mb(Math.max(0, st.storage.quota - st.storage.usage))} free`) : ''}
                {tr('）', ')')}
              </div>
            )}
            <div>{tr(`参照モードの曲フォルダ: ${st.folders.length}件`, `Reference-mode song folders: ${st.folders.length}`)}</div>
            {st.needPermission.length > 0 && (
              <button className="btn small" style={{ marginTop: 6 }} onClick={() => void grantFolders()}>
                {tr('参照フォルダを読む許可を出す', 'Allow reading the reference folders')}
              </button>
            )}
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {st.storage && !st.storage.persisted && (
                <button
                  className="btn small ghost"
                  onClick={async () =>
                    toast(
                      (await requestPersist())
                        ? tr('消えないように保存する設定にしました', 'Storage is now set to persist')
                        : tr('ブラウザが永続化を許可しませんでした（ZIPでバックアップしておくと安心です）', "The browser didn't allow persistent storage (backing up as a ZIP is a good idea)"),
                      'info',
                      6000,
                    )
                  }
                >
                  {tr('消えないようにする', 'Keep it from being cleared')}
                </button>
              )}
              <button className="btn small ghost" onClick={() => zipInput.current?.click()}>
                {tr('ZIPから戻す', 'Restore from ZIP')}
              </button>
            </div>
          </div>
        </aside>

        <main className="lib-main scroll">
          {st.importing && (
            <div className="lib-banner busy">
              <span className="spin" />
              <div>
                <b>{st.importing.label}</b>
                {st.importing.total > 0 && (
                  <div className="lbl">
                    {st.importing.done} / {st.importing.total} {tr('曲', pl(st.importing.total, 'song'))}
                  </div>
                )}
              </div>
            </div>
          )}
          {!st.importing && st.lastImport && (
            <div className="lib-banner ok">
              <span className="ok-ic">✓</span>
              <div>
                <b>
                  {tr(
                    `${st.lastImport.songs.length === 1 ? `「${st.lastImport.songs[0]}」` : `${st.lastImport.songs.length} 曲`}から ${st.lastImport.added} 音を取り込みました`,
                    `Imported ${st.lastImport.added} ${pl(st.lastImport.added, 'sound')} from ${st.lastImport.songs.length === 1 ? `"${st.lastImport.songs[0]}"` : `${st.lastImport.songs.length} songs`}`,
                  )}
                </b>
                <div className="lbl">
                  {tr('レーンでの使われ方から楽器を判定しました。', 'Instruments were detected from how each sound is used in the lanes. ')}
                  {st.lastImport.merged > 0 &&
                    tr(
                      `ライブラリにあったのと同じ中身の${st.lastImport.merged}音は1つにまとめています。`,
                      `${st.lastImport.merged} ${pl(st.lastImport.merged, 'sound')} identical to ones already in the library ${st.lastImport.merged === 1 ? 'was' : 'were'} merged. `,
                    )}
                  {st.lastImport.kits.length > 0 &&
                    tr(
                      `曲名キット「${st.lastImport.kits.slice(0, 3).join('」「')}」${st.lastImport.kits.length > 3 ? ' ほか' : ''}も作成済みです。`,
                      `Song kits "${st.lastImport.kits.slice(0, 3).join('", "')}"${st.lastImport.kits.length > 3 ? ' and more' : ''} were created too.`,
                    )}
                </div>
              </div>
              <span className="grow" />
              <button className="btn small ghost" onClick={() => useLibrary.setState({ lastImport: null })}>
                {tr('閉じる', 'Close')}
              </button>
            </div>
          )}
          {st.tab === 'samples' ? (
            items.length === 0 ? (
              <div className="lib-empty">
                {all.length === 0 ? tr('標準キットの音を読み込んでいます…', 'Loading the built-in kit sounds…') : tr('条件に合う音がありません。', 'No sounds match.')}
                {st.samples.length === 0 && (
                  <p className="lbl">
                    {tr(
                      '「曲フォルダから取り込む」で、DTXManiaの曲フォルダにある音をライブラリに入れられます。譜面で使われているレーンから楽器を自動で判定します。',
                      'Use "Import from song folders" to add sounds from DTXMania song folders to the library. Instruments are detected automatically from the lanes the charts use them in.',
                    )}
                  </p>
                )}
              </div>
            ) : (
              <div className="lib-table">
                <div className="lib-tr head">
                  <span />
                  <span>{tr('波形', 'Wave')}</span>
                  <span>{tr('名前', 'Name')}</span>
                  <span>{tr('楽器', 'Instrument')}</span>
                  <span>{tr('出典', 'Source')}</span>
                  <span>{tr('長さ', 'Length')}</span>
                  <span>{tr('キット', 'Kits')}</span>
                </div>
                {(showAll ? items : items.slice(0, LIMIT)).map((it) => (
                  <Row key={it.id} it={it} on={st.selected === it.id} />
                ))}
                {!showAll && items.length > LIMIT && (
                  <button className="btn small ghost" style={{ margin: 10 }} onClick={() => setShowAll(true)}>
                    {tr(`残り ${items.length - LIMIT} 音も出す`, `Show the other ${items.length - LIMIT}`)}
                  </button>
                )}
              </div>
            )
          ) : (
            <KitsList />
          )}
        </main>

        <aside className="lib-detail scroll">
          {sel ? <Detail it={sel} /> : <p className="lbl">{tr('一覧から音を選ぶと、ここに詳しい情報と似た音が出ます。', 'Select a sound in the list to see its details and similar sounds here.')}</p>}
        </aside>
      </div>
    </div>
  );
}

function SideRow({ on, color, label, n, unit, onClick }: { on: boolean; color?: string; label: string; n: number; unit?: string; onClick: () => void }) {
  return (
    <button className={`lib-side-row ${on ? 'on' : ''}`} onClick={onClick}>
      {color && <i style={{ background: color }} />}
      <span className="grow ellipsis">{label}</span>
      <span className="mono lbl">
        {n.toLocaleString(locale())}
        {unit ?? ''}
      </span>
    </button>
  );
}

function Row({ it, on }: { it: LibItem; on: boolean }) {
  const info = instInfo(it.inst);
  useLibrary((s) => s.kits);
  return (
    <div className={`lib-tr ${on ? 'on' : ''}`} onClick={() => useLibrary.setState({ selected: it.id })} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && void auditionItem(it)}>
      <AuditionButton k={auditionKey(it)} load={() => auditionSound(it)} label={it.name} className="play-mini" onPress={() => useLibrary.setState({ selected: it.id })} />
      <Wave peaks={it.peaks} color={info.color} />
      <span className="nm">
        <span className="ellipsis">
          {it.fav && <span style={{ color: 'var(--amber)' }}>★ </span>}
          {it.name}
        </span>
        <span className="lbl ellipsis">{it.tags.length ? it.tags.map(tagLabel).join(' · ') : it.ref ? tr('参照モード', 'Reference mode') : tr('タグなし', 'No tags')}</span>
      </span>
      <span className="row" style={{ gap: 6, minWidth: 0 }}>
        <i className="stem-dot" style={{ background: info.color }} />
        <span className="ellipsis">{info.label}</span>
        {it.builtin ? (
          <span className="kit-badge">{tr('標準', 'Built-in')}</span>
        ) : it.instAuto ? (
          <span className="kit-badge lib">
            {tr('自動', 'Auto')} {Math.round(it.conf * 100)}%
          </span>
        ) : null}
      </span>
      <span className="ellipsis" title={it.sources.map((s) => s.song).join('、')}>
        {it.builtin ? tr('標準キット', 'Built-in kit') : it.sources[0]?.song}
        {it.sources.length > 1 ? tr(` ほか${it.sources.length - 1}`, ` +${it.sources.length - 1}`) : ''}
      </span>
      <span className="mono lbl">{Math.round(it.dur * 1000).toLocaleString(locale())} ms</span>
      <span className="mono lbl">{it.builtin ? '' : kitCount(it.id)}</span>
    </div>
  );
}

function Detail({ it }: { it: LibItem }) {
  const info = instInfo(it.inst);
  const [ch, setCh] = useState(DEFAULT_CH[it.inst]);
  const inEditor = useEditor((s) => s.screen === 'editor');
  useEffect(() => setCh(DEFAULT_CH[it.inst]), [it.id, it.inst]);
  const sims = similarItems(it.id, 6);
  return (
    <div className="lib-detail-in">
      <div className="lbl">{tr('選択中のサンプル', 'Selected sample')}</div>
      <div className="big-wave">
        <Wave peaks={it.peaks} color={info.color} w={270} h={90} fluid />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <AuditionButton k={auditionKey(it)} load={() => auditionSound(it)} label={it.name} className="play-btn" size={16} />
        <div style={{ minWidth: 0 }}>
          <b className="ellipsis" style={{ display: 'block' }}>
            {it.name}
          </b>
          <span className="lbl">
            {Math.round(it.dur * 1000)} ms · {(it.sr / 1000).toFixed(1)} kHz · {it.channels === 1 ? tr('モノラル', 'Mono') : tr('ステレオ', 'Stereo')}
          </span>
        </div>
        <span className="grow" />
        {!it.builtin && (
          <button className="ib" onClick={() => void toggleFav(it.id)} title={it.fav ? tr('お気に入りから外す', 'Remove from favorites') : tr('お気に入りにする', 'Add to favorites')} style={{ color: it.fav ? 'var(--amber)' : undefined }}>
            {Icon.star(16, it.fav)}
          </button>
        )}
      </div>
      <div className="kvs">
        <span className="lbl">{tr('楽器', 'Instrument')}</span>
        {it.builtin ? (
          <span>{info.label}</span>
        ) : (
          <select className="field" value={it.inst} onChange={(e) => void setInst(it.id, e.target.value as Inst)}>
            {INSTS.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        )}
        <span className="lbl">{tr('判定理由', 'Why')}</span>
        <span>{it.reason}</span>
        <span className="lbl">{tr('出典', 'Source')}</span>
        <span>
          {it.sources.map((s, i) => (
            <span key={i} style={{ display: 'block' }}>
              {s.song}
              {s.artist ? <span className="lbl"> / {s.artist}</span> : null}
            </span>
          ))}
        </span>
        <span className="lbl">{tr('ファイル名', 'File name')}</span>
        <span className="mono" style={{ fontSize: 11 }}>
          {it.file}
        </span>
        {!it.builtin && (
          <>
            <span className="lbl">{tr('タグ', 'Tags')}</span>
            <span className="lib-tags">
              {TAG_PRESETS.map((t) => (
                <button key={t} className={it.tags.includes(t) ? 'on' : ''} onClick={() => void setTags(it.id, it.tags.includes(t) ? it.tags.filter((x) => x !== t) : [...it.tags, t])}>
                  {tagLabel(t)}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
      <div className="lbl" style={{ marginTop: 12 }}>
        {tr('似た音', 'Similar sounds')}
      </div>
      <div className="sims">
        {sims.map(({ item, sim }) => (
          <button
            key={item.id}
            onClick={() => {
              useLibrary.setState({ selected: item.id });
              void playAudition(auditionKey(item), () => auditionSound(item));
            }}
          >
            <span className="ellipsis mono">{item.name}</span>
            <span className="mono lbl">{sim.toFixed(2)}</span>
          </button>
        ))}
      </div>
      <div className="lib-assign">
        <select className="field" value={ch} onChange={(e) => setCh(Number(e.target.value))} aria-label={tr('割り当てるレーン', 'Lane to assign')}>
          {KIT_LANES.map((l) => (
            <option key={l.ch} value={l.ch}>
              {l.label}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={!inEditor} onClick={() => void assignToLane(it, ch)} title={tr('今の譜面のこのレーンに、この音を使います', "Use this sound for this lane in the current chart")}>
          {tr('今の譜面のレーンに割り当て', 'Assign to a lane in this chart')}
        </button>
      </div>
      {!it.builtin && (
        <button
          className="btn small ghost danger"
          style={{ marginTop: 8, alignSelf: 'flex-start' }}
          onClick={async () => {
            if (
              await confirmDialog({
                title: tr(`${it.name} をライブラリから消しますか？`, `Remove ${it.name} from the library?`),
                body: tr('キットからも使えなくなります。曲フォルダのファイルは消えません。', "Kits can't use it anymore either. Files in song folders aren't deleted."),
                ok: tr('消す', 'Remove'),
                danger: true,
              })
            )
              void removeSample(it.id);
          }}
        >
          {Icon.trash(13)} {tr('ライブラリから消す', 'Remove from library')}
        </button>
      )}
    </div>
  );
}

function KitsList() {
  const kits = useLibrary((s) => s.kits);
  const samples = useLibrary((s) => s.samples);
  const builtins = useLibrary((s) => s.builtins);
  const kitId = useKit((s) => s.kitId);
  const byId = new Map<string, LibItem>([...samples, ...builtins].map((x) => [x.id, x]));
  const name = (sid: string | undefined) => (sid ? (byId.get(sid)?.name ?? tr('（見つからない音）', '(missing sound)')) : '');
  const newKit = async () => {
    const n = await promptDialog({
      title: tr('新しいキット', 'New kit'),
      body: tr('今使っているキットの音を元に作ります。あとでレーンごとに音を選べます。', 'Starts from the sounds of the kit you use now. You can pick a sound for each lane later.'),
      value: tr('マイキット', 'My kit'),
      ok: tr('作る', 'Create'),
    });
    if (!n) return;
    const lanes: Record<number, string> = {};
    const cur = kitId;
    for (const l of KIT_LANES) {
      if (cur.startsWith('lib:')) {
        const k = kits.find((x) => `lib:${x.id}` === cur);
        if (k?.lanes[l.ch]) lanes[l.ch] = k.lanes[l.ch];
        continue;
      }
      const kitName = BUILTIN_KITS.some((b) => b.id === cur) && cur !== 'synth' ? cur : 'std';
      lanes[l.ch] = `builtin:${kitName}/${l.key}`;
    }
    const k = await saveUserKit(n, lanes);
    setKit(`lib:${k.id}`);
    toast(tr(`キット「${n}」を作り、使うキットにしました`, `Created the kit "${n}" and switched to it`), 'ok');
  };
  return (
    <div className="kits">
      <div className="row" style={{ marginBottom: 10 }}>
        <b>{tr('キット', 'Kits')}</b>
        <span className="grow" />
        <button className="btn small" onClick={() => void newKit()}>
          {Icon.plus(14)} {tr('新しいキット', 'New kit')}
        </button>
      </div>
      {BUILTIN_KITS.map((k) => (
        <KitCard key={k.id} id={k.id} title={k.name} sub={tr(`標準キット · ${k.desc}`, `Built-in kit · ${k.desc}`)} on={kitId === k.id} lanes={KIT_LANES.map((l) => ({ ch: l.ch, label: l.label, name: kitFile(l.ch, k.id) ?? '' }))} />
      ))}
      {kits.map((k) => (
        <KitCard
          key={k.id}
          id={`lib:${k.id}`}
          kit={k}
          title={k.name}
          sub={k.origin === 'song' ? tr(`曲から${k.artist ? ` · ${k.artist}` : ''}`, `From a song${k.artist ? ` · ${k.artist}` : ''}`) : tr('自分のキット', 'Your kit')}
          on={kitId === `lib:${k.id}`}
          lanes={KIT_LANES.map((l) => ({ ch: l.ch, label: l.label, name: k.lanes[l.ch] ? name(k.lanes[l.ch]) : tr('（標準キット）', '(built-in kit)') }))}
        />
      ))}
    </div>
  );
}

function KitCard({ id, kit, title, sub, on, lanes }: { id: string; kit?: LibraryKit; title: string; sub: string; on: boolean; lanes: { ch: number; label: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const samples = useLibrary((s) => s.samples);
  const builtins = useLibrary((s) => s.builtins);
  const editable = kit?.origin === 'user';
  return (
    <div className={`kit-card ${on ? 'on' : ''}`}>
      <div className="row">
        <button className="link-btn" style={{ color: 'var(--text)', fontSize: 13.5, fontWeight: 600 }} onClick={() => setOpen(!open)}>
          {open ? Icon.chevronDown(13) : Icon.chevronRight(13)} {title}
        </button>
        <span className="lbl ellipsis">{sub}</span>
        <span className="grow" />
        {on ? (
          <span className="kit-badge own">{tr('使用中', 'In use')}</span>
        ) : (
          <button
            className="btn small"
            onClick={() => {
              setKit(id);
              toast(tr(`「${title}」をこれから置くチップに使います`, `Using "${title}" for the chips you place from now on`), 'ok');
            }}
          >
            {tr('このキットを使う', 'Use this kit')}
          </button>
        )}
        {kit && (
          <button
            className="ib tiny"
            title={tr('キットを消す', 'Delete kit')}
            onClick={async () => {
              if (
                await confirmDialog({
                  title: tr(`キット「${title}」を消しますか？`, `Delete the kit "${title}"?`),
                  body: tr('音（サンプル）はライブラリに残ります。', 'The sounds (samples) stay in the library.'),
                  ok: tr('消す', 'Delete'),
                  danger: true,
                })
              ) {
                if (on) setKit('std');
                void removeKit(kit.id);
              }
            }}
          >
            {Icon.trash(13)}
          </button>
        )}
      </div>
      {open && (
        <div className="kit-lanes">
          {lanes.map((l) => (
            <div key={l.ch} className="kit-lane">
              <span className="lbl">{l.label}</span>
              {editable ? (
                <select
                  className="field"
                  value={kit!.lanes[l.ch] ?? ''}
                  onChange={async (e) => {
                    const next = { ...kit!, lanes: { ...kit!.lanes, [l.ch]: e.target.value } };
                    if (!e.target.value) delete next.lanes[l.ch];
                    const { putKit } = await import('../library/db');
                    await putKit(next);
                    useLibrary.setState({ kits: useLibrary.getState().kits.map((k) => (k.id === next.id ? next : k)) });
                  }}
                >
                  <option value="">{tr('（標準キット）', '(built-in kit)')}</option>
                  {[...samples, ...builtins]
                    .filter((x) => x.inst === (DEFAULT_INST[l.ch] ?? x.inst))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
              ) : (
                <span className="mono ellipsis" style={{ fontSize: 11.5 }}>
                  {l.name}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_INST: Record<number, Inst> = {
  [CH.LC]: 'crash',
  [CH.HHC]: 'hihat',
  [CH.HHO]: 'hihat',
  [CH.LP]: 'hihat',
  [CH.LBD]: 'kick',
  [CH.SD]: 'snare',
  [CH.HT]: 'tom',
  [CH.BD]: 'kick',
  [CH.LT]: 'tom',
  [CH.FT]: 'tom',
  [CH.CY]: 'crash',
  [CH.RD]: 'ride',
};
