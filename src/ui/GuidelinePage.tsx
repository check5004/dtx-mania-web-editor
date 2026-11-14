// 難易度ガイドラインの画面。DTXMania の曲から裏で作った物差し（レベル帯ごとの要素の出現率・似た譜面・外れていそうな譜面）と、
// 成績からの遊ぶレベル、基準文（AI の下書き → 作者が確定）。物差しに入れていない譜面とわけも見せる。
// 曲の一覧（DTXMania の曲）の上の「難易度ガイドライン」と、エディタの道具・設定・AI難易度生成から開く。
import { tr, pl } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { downloadBytes } from '../fs/folder';
import { FEATURE_DEFS } from '../gen/features';
import { bandOf, type Ruler } from '../guide/ruler';
import { openNxPage } from '../nxlib/actions';
import { ensureNxPerm, pickNxPlace, rescanNx, setNxView, useNxLib } from '../nxlib/store';
import { canAddLevel } from '../nxlib/view';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { NO_FOLDER_PICK } from '../store/device';
import { goBack, openSettings, toast, useEditor } from '../store/editor';
import {
  addRow,
  BANDS,
  bandStats,
  clearImported,
  confirmBand,
  draftWithAi,
  exportGuideline,
  findOutliers,
  importGuideline,
  loadGuideline,
  pickAndScan,
  removeRow,
  representatives,
  scanFromFileList,
  scanFromZip,
  setExcluded,
  setRow,
  useGuideline,
  usePlayEstimate,
  useRuler,
} from '../store/guideline';
import { usePlayLevel } from '../store/playLevel';
import { confirmDialog } from './dialogs';
import { FolderInput } from './Editor';
import { PlayLevelCard } from './guide/PlayLevel';
import { SkippedCard } from './guide/Skipped';
import { Icon } from './icons';

/** 曲の一覧でその曲を出す（しぼりこみを外して選ぶ） */
function showSong(songId: string) {
  setNxView({ sel: songId, q: '', filter: null, box: null, guide: false });
  if (useEditor.getState().screen !== 'songs') {
    goBack();
    void openNxPage();
  }
}

/** 曲の一覧を「遊ぶレベルを足せる曲」でしぼりこむ */
function showAddable() {
  setNxView({ filter: 'mylevel', q: '', box: null, guide: false });
  if (useEditor.getState().screen !== 'songs') {
    goBack();
    void openNxPage();
  }
}

export function GuidelinePage({ onBack }: { onBack?: () => void } = {}) {
  const st = useGuideline();
  const r = useRuler();
  const hasKey = useHasAiKey();
  const running = useAi((s) => (s.running.guideline ?? 0) > 0);
  const model = useAi((s) => modelLabel(s.tasks.guideline.model, s.models));
  const cost = useAi(() => taskCostEstimate('guideline'));
  const folderInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const from = useEditor((s) => s.returnPage);
  const nxSupported = useNxLib((s) => s.supported);
  const place = useNxLib((s) => s.place);
  const perm = useNxLib((s) => s.perm);
  const scan = useNxLib((s) => s.scan);
  const songs = useNxLib((s) => s.songs);
  const play = usePlayLevel((s) => s.v);
  const [menu, setMenu] = useState(false);
  const back = onBack ?? goBack;
  useEffect(() => {
    void loadGuideline();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-back') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) back();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [back]);
  const stats = useMemo(() => bandStats(r.use), [r.use]);
  const outliers = useMemo(() => findOutliers(r.use), [r.use]);
  const { est, points } = usePlayEstimate();
  const shownPlay = play ?? est.level;
  const addable = useMemo(() => (place && shownPlay !== null ? songs.filter((s) => canAddLevel(s, shownPlay)).length : null), [place, songs, shownPlay]);
  const band = st.band;
  const bs = stats[band - 1];
  const gb = st.guide.bands[band] ?? { status: 'none', rows: [] };
  const reps = representatives(r.use, band, 3);
  const bandPlays = points.filter((p) => bandOf(p.level) === band);
  const youBand = shownPlay !== null ? bandOf(shownPlay) : null;
  const imported = st.charts.filter((c) => c.src !== 'nx').length;
  const empty = r.use.length === 0;

  const exportJson = () => downloadBytes('dtx-guideline.json', new TextEncoder().encode(exportGuideline()), 'application/json');

  return (
    <div className="guide-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={back}>
          {Icon.back(14)}{' '}
          {onBack
            ? tr('曲の一覧に戻る', 'Back to the song list')
            : from === 'ai'
              ? tr('AI難易度生成に戻る', 'Back to AI difficulties')
              : from === 'settings'
                ? tr('設定に戻る', 'Back to settings')
                : from === 'library'
                  ? tr('ライブラリに戻る', 'Back to library')
                  : tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        <h1>{tr('難易度ガイドライン', 'Difficulty guidelines')}</h1>
        <span className="lbl hide-narrow">{sourceText(r, imported)}</span>
        <span className="grow" />
        {st.analyzing && (
          <span className="gp-busy" title={tr('DTXMania の曲の譜面を読んで、物差しに足しています', 'Reading the charts of your DTXMania songs and adding them to the ruler')}>
            <i className="gp-spin" />
            {tr(`譜面を読んでいます ${st.analyzing.done} / ${st.analyzing.total}`, `Reading charts ${st.analyzing.done} / ${st.analyzing.total}`)}
          </span>
        )}
        <span className={`pill ${hasKey ? 'ok' : ''} hide-narrow`} title={hasKey ? undefined : noKeyTitle()}>
          {hasKey ? tr('● AI キー設定済み', '● AI key set') : tr('AI キー未設定（集計と手書きは使えます）', 'No AI key (stats and hand-written text still work)')}
        </span>
        <span className="nx-menu-wrap">
          <button className="btn small" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu">
            {Icon.dots(14)} {tr('その他', 'More')}
          </button>
          {menu && (
            <GuideMenu
              close={() => setMenu(false)}
              items={[
                NO_FOLDER_PICK
                  ? { label: tr('曲の ZIP から足す…', 'Add from a song ZIP…'), sub: tr('DTXMania の曲を使えないときに', "When DTXMania songs aren't available"), run: () => zipInput.current?.click() }
                  : { label: tr('曲のフォルダから足す…', 'Add from a song folder…'), sub: tr('DTXMania の外の曲も物差しに入れる', 'Count songs outside DTXMania too'), run: () => void pickAndScan(folderInput.current) },
                { label: tr('基準文を書き出す（.json）', 'Export guideline text (.json)'), run: exportJson },
                { label: tr('基準文を読み込む…', 'Import guideline text…'), run: () => jsonInput.current?.click() },
                ...(imported
                  ? [
                      {
                        label: tr(`足した譜面を忘れる（${imported}）`, `Forget added charts (${imported})`),
                        sub: tr('DTXMania の曲から作った分は残ります', 'What comes from your DTXMania songs stays'),
                        run: async () => {
                          const ok = await confirmDialog({
                            title: tr('足した譜面を忘れますか？', 'Forget the added charts?'),
                            body: tr(`フォルダ・ZIP・音源ライブラリから足した ${imported} 譜面を物差しから消します。ファイルは何も変わりません。`, `The ${imported} ${pl(imported, 'chart')} added from folders, ZIPs or the sound library are removed from the ruler. No files change.`),
                            ok: tr('忘れる', 'Forget'),
                            danger: true,
                          });
                          if (ok) await clearImported();
                        },
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </span>
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void scanFromZip(f);
          }}
        />
        <input
          ref={jsonInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const ok = await importGuideline(await f.text());
            toast(ok ? tr('ガイドラインを読み込みました', 'Imported the guidelines') : tr('ガイドラインのファイルではありません', "That isn't a guidelines file"), ok ? 'ok' : 'error');
          }}
        />
        <FolderInput inputRef={folderInput} onFiles={(l) => void scanFromFileList(l)} />
      </header>
      {st.scanning && (
        <div className="lib-banner">
          {st.scanning.label} {st.scanning.total ? `${st.scanning.done} / ${st.scanning.total}` : ''}
        </div>
      )}
      {place && perm !== 'granted' && (
        <div className="nx-notice info gp-notice">
          {Icon.info(14)}
          <div>
            <span>
              {tr(
                '前に作った物差しを出しています。増えた曲・変わった譜面を読むには、Chrome が DTXMania のフォルダの許可を 1 回聞きます。',
                'Showing the ruler from last time. To read new songs and changed charts, Chrome asks once for permission to the DTXMania folder.',
              )}
            </span>
            <div className="nx-notice-acts">
              <button
                className="btn small primary"
                onClick={async () => {
                  if (await ensureNxPerm()) void rescanNx();
                }}
              >
                {tr('続ける', 'Continue')}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="guide-body">
        <nav className="guide-bands" aria-label={tr('レベル帯', 'Level bands')}>
          <div className="lbl" style={{ padding: '0 6px 6px' }}>
            {tr('レベル帯', 'Level bands')}
          </div>
          {BANDS.map((b) => {
            const s = stats[b - 1];
            const g = st.guide.bands[b];
            const max = Math.max(1, ...stats.map((x) => x.count));
            return (
              <button key={b} className={`guide-band ${band === b ? 'on' : ''}`} onClick={() => useGuideline.setState({ band: b })} aria-pressed={band === b}>
                <div className="row gp-band-row">
                  <b>{tr(`Lv${b}台`, `Lv${b}.x`)}</b>
                  {youBand === b && <span className="gp-you-tag">{tr('あなた', 'You')}</span>}
                  <span className="grow" />
                  {g && g.status !== 'none' && (
                    <span className={`guide-st ${g.status}`} title={g.status === 'confirmed' ? tr('基準文を確定した', 'Guideline text is final') : tr('基準文の下書きがある', 'Has a draft of guideline text')}>
                      {g.status === 'confirmed' ? tr('確定', 'Final') : tr('下書き', 'Draft')}
                    </span>
                  )}
                  <span className="lbl">{tr(`${s.count}譜面`, `${s.count} ${pl(s.count, 'chart')}`)}</span>
                </div>
                <div className="guide-meter">
                  <i style={{ width: `${(s.count / max) * 100}%` }} />
                </div>
              </button>
            );
          })}
          <div className="card guide-note">
            <div className="gp-note-h">{tr('物差しの譜面', 'Charts in the ruler')}</div>
            <div className="gp-kv">
              <span>{tr('使う', 'Used')}</span>
              <b className="mono">
                {r.use.length.toLocaleString()}
                <span className="lbl">{tr(`（${r.songs} 曲）`, ` (${r.songs} ${pl(r.songs, 'song')})`)}</span>
              </b>
            </div>
            <button className="gp-kv link" onClick={() => document.getElementById('gp-skip')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              <span>{tr('入れていない', 'Not counted')}</span>
              <b className="mono">{r.skipped.length.toLocaleString()}</b>
            </button>
            {r.pending > 0 && (
              <div className="gp-kv">
                <span>{tr('まだ読んでいない', 'Not read yet')}</span>
                <b className="mono">{r.pending.toLocaleString()}</b>
              </div>
            )}
            <div className="lbl" style={{ marginTop: 6 }}>
              {tr('レベルは各譜面の #DLEVEL（#DLVDEC も）', "Levels come from each chart's #DLEVEL (and #DLVDEC)")}
            </div>
          </div>
        </nav>
        <main className="guide-main scroll">
          {empty && <EmptyCard nxSupported={nxSupported} hasPlace={!!place} granted={perm === 'granted'} scanning={!!scan || !!st.analyzing} analyzing={st.analyzing} onAdd={() => (NO_FOLDER_PICK ? zipInput.current?.click() : void pickAndScan(folderInput.current))} />}
          {(!empty || points.length > 0) && <PlayLevelCard est={est} points={points} addable={addable} onShowAddable={showAddable} />}
          <section className="card">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h3>{tr(`Lv${band}台の基準`, `Guidelines for Lv${band}.x`)}</h3>
              {gb.status === 'ai' && <span className="ai-badge rec">{tr('AIの下書き・未確定', 'AI draft · not final')}</span>}
              {gb.status === 'confirmed' && <span className="ai-badge ok">{tr('確定', 'Final')}</span>}
              <span className="grow" />
              <button className="btn small primary" disabled={gb.rows.length === 0 || gb.status === 'confirmed'} onClick={() => confirmBand(band)}>
                {tr('この基準で確定', 'Make final')}
              </button>
              <button className="btn small" onClick={() => addRow(band)}>
                {Icon.plus(13)} {tr('行を追加', 'Add row')}
              </button>
              <button
                className="btn small on-amber"
                disabled={!hasKey || running || bs.count === 0}
                title={hasKey ? tr(`${model} · 1回 約 ${formatUsd(cost)}（全レベル帯）`, `${model} · ~${formatUsd(cost)} per run (all level bands)`) : noKeyTitle()}
                onClick={() => void draftWithAi([band])}
              >
                {Icon.sparkle(13)} {running ? tr('下書き中…', 'Drafting…') : gb.rows.length ? tr('AIで下書きし直す', 'Redraft with AI') : tr('AIで下書き', 'Draft with AI')}
              </button>
            </div>
            <p className="lbl" style={{ margin: '6px 0 0' }}>
              {tr(
                '基準文は無くても使えます。AI のレベル判定と AI難易度生成には、このレベル帯の集計の数字を渡します。基準文を書くと、それも一緒に渡します。',
                "Text is optional. AI level checks and the AI difficulty generator get this band's numbers either way; if you write text, it goes along too.",
              )}
            </p>
            {!hasKey && (
              <p className="lbl" style={{ margin: '6px 0 0' }}>
                {noKeyTitle()}
                {tr('。基準文は「行を追加」で手で書けます。', '. You can write guidelines by hand with "Add row".')}{' '}
                <button className="link-btn" onClick={() => openSettings('ai')}>
                  {tr('キーを設定', 'Set API key')}
                </button>
              </p>
            )}
            {hasKey && r.use.length > 0 && BANDS.some((b) => (st.guide.bands[b]?.rows.length ?? 0) === 0 && stats[b - 1].count > 0) && (
              <p className="lbl" style={{ margin: '6px 0 0' }}>
                {tr('基準文の無いレベル帯があります。', 'Some level bands have no text.')}{' '}
                <button className="link-btn" disabled={running} onClick={() => void draftWithAi(BANDS.filter((b) => (st.guide.bands[b]?.rows.length ?? 0) === 0))}>
                  {tr('まとめてAIで下書き', 'Draft them all with AI')}
                </button>
              </p>
            )}
            <div className="guide-rows">
              {gb.rows.map((row, i) => (
                <div key={i} className="guide-row">
                  <span className="mono lbl">{i + 1}</span>
                  <div className="grow">
                    <RowInput value={row.text} onCommit={(v) => setRow(band, i, v)} />
                    {row.basis && (
                      <div className="lbl">
                        {tr('根拠: ', 'Basis: ')}
                        {row.basis}
                      </div>
                    )}
                  </div>
                  <span className={`ai-badge ${row.origin === 'ai' ? 'rec' : 'edit'}`}>{row.origin === 'ai' ? 'AI' : row.origin === 'edited' ? tr('手直し', 'Edited') : tr('手書き', 'Hand-written')}</span>
                  <button className="ib tiny" onClick={() => removeRow(band, i)} title={tr('この行を消す', 'Delete this row')}>
                    {Icon.close(12)}
                  </button>
                </div>
              ))}
            </div>
            <div className="guide-stats">
              <Stat label={tr('密度の中央値', 'Median density')} value={bs.count ? bs.density.toFixed(1) : '—'} unit={tr('ノーツ/秒', ' notes/s')} />
              <Stat label={tr('最大同時打数', 'Max simultaneous hits')} value={bs.count ? String(Math.round(bs.maxChord)) : '—'} />
              <Stat label={tr('BPMの中央値', 'Median BPM')} value={bs.count ? String(Math.round(bs.bpm)) : '—'} />
              <Stat label={tr('ノーツ数の中央値', 'Median note count')} value={bs.count ? String(Math.round(bs.notes)) : '—'} />
            </div>
            <div className="gp-band-foot">
              <div>
                <div className="lbl">{tr('代表の譜面（AI に見せる手本）', 'Typical charts (shown to the AI as examples)')}</div>
                {reps.length === 0 && <div className="lbl">{tr('このレベル帯の譜面はまだありません。', 'No charts in this level band yet.')}</div>}
                {reps.map((c) => (
                  <div key={c.id} className="gp-rep">
                    <span className="ellipsis grow">{c.song}</span>
                    <span className="lbl">{c.label}</span>
                    <span className="mono">{c.level!.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="lbl">{tr('このレベル帯のあなたの成績', 'Your records in this band')}</div>
                {bandPlays.length === 0 ? (
                  <div className="lbl">{tr('まだ遊んでいません。', 'Not played yet.')}</div>
                ) : (
                  <div className="gp-rep">
                    <span className="grow">{tr(`遊んだ ${bandPlays.length} 譜面`, `${bandPlays.length} played ${pl(bandPlays.length, 'chart')}`)}</span>
                    <span className="lbl">{tr('達成率の中央値', 'median')}</span>
                    <span className="mono">{medianOf(bandPlays.map((p) => p.skill)).toFixed(1)}%</span>
                  </div>
                )}
              </div>
            </div>
          </section>
          <section className="card">
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <h3>{tr('要素の出現率（レベル帯ごと）', 'How often elements appear (per level band)')}</h3>
              <span className="grow" />
              <span className="lbl hide-narrow">{tr('その要素が出てくる譜面の割合。列を押すとそのレベル帯に切り替わります', 'Share of charts that contain each element. Click a column to switch to that band')}</span>
            </div>
            <div className="guide-table-wrap">
              <table className="guide-table">
                <thead>
                  <tr>
                    <th />
                    {BANDS.map((b) => (
                      <th key={b} className={band === b ? 'on' : ''} onClick={() => useGuideline.setState({ band: b })}>
                        Lv{b}
                        {youBand === b && <span className="gp-th-you">{tr('あなた', 'You')}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="gp-count-row">
                    <td className="rowh">{tr('譜面の数', 'Charts')}</td>
                    {stats.map((s) => (
                      <td key={s.band} className={band === s.band ? 'on' : ''} onClick={() => useGuideline.setState({ band: s.band })}>
                        {s.count || '–'}
                      </td>
                    ))}
                  </tr>
                  {FEATURE_DEFS.map((d) => (
                    <tr key={d.key}>
                      <td className="rowh">{d.label}</td>
                      {stats.map((s) => {
                        const v = s.rates[d.key];
                        return (
                          <td key={s.band} className={band === s.band ? 'on' : ''} onClick={() => useGuideline.setState({ band: s.band })} style={{ background: s.count && v > 0 ? `rgba(76,194,255,${0.1 + v * 0.6})` : undefined }}>
                            {s.count === 0 || v === 0 ? '–' : `${Math.round(v * 100)}%`}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
        <aside className="guide-side scroll">
          <SkippedCard r={r} onSong={place ? showSong : undefined} />
          <div className="row" style={{ gap: 6, marginTop: 18 }}>
            <h3>{tr('レベルが外れていそうな譜面', 'Levels that look off')}</h3>
            <span className="grow" />
            <span className="lbl mono">{outliers.length}</span>
          </div>
          <p className="lbl" style={{ margin: '4px 0 0' }}>
            {tr('特徴の近いほかの曲の譜面と比べて、付いているレベルが 1.2 以上ちがう譜面。外すと物差しに入れません。', 'Charts whose level differs by 1.2 or more from charts of other songs with similar features. Leaving one out keeps it out of the ruler.')}
          </p>
          {outliers.length === 0 && (
            <p className="lbl">{r.use.length < 6 ? tr('譜面が増えると、ここに出します。', 'They show up here once there are more charts.') : tr('大きく外れている譜面はありません。', 'No charts stand out much.')}</p>
          )}
          {outliers.slice(0, 12).map((o) => (
            <div key={o.c.id} className="card guide-out">
              <div className="row" style={{ gap: 6 }}>
                <b className="ellipsis">{o.c.song}</b>
                <span className="grow" />
                <span className="lbl">{o.c.label}</span>
              </div>
              <div className="mono" style={{ fontSize: 12 }}>
                {tr('付いている', 'Listed')} {o.c.level!.toFixed(2)} → {tr('似た譜面だと', 'similar charts say')} <span style={{ color: 'var(--amber)' }}>{tr(`${o.predicted.toFixed(1)}前後`, `about ${o.predicted.toFixed(1)}`)}</span>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button className="btn small" onClick={() => void setExcluded(o.c.id, true)}>
                  {tr('物差しから外す', 'Leave it out')}
                </button>
                {o.c.songId && place && (
                  <button className="btn small ghost" onClick={() => showSong(o.c.songId!)}>
                    {tr('曲を見る', 'See the song')}
                  </button>
                )}
              </div>
            </div>
          ))}
          <p className="lbl" style={{ marginTop: 14 }}>
            {tr(
              'この物差しは、AI のレベル判定（「確かめる」）と AI難易度生成に使います。DTXMania の曲が増えたり譜面が変わったりすると、裏で読み直します。',
              'This ruler is used by AI level checks (“Check”) and the AI difficulty generator. When your DTXMania songs grow or charts change, it re-reads them in the background.',
            )}
          </p>
        </aside>
      </div>
    </div>
  );
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 頭の一行：どこから作った物差しか */
function sourceText(r: Ruler, imported: number): string {
  const parts: string[] = [];
  if (r.nx) parts.push(tr('DTXMania の曲から', 'From your DTXMania songs'));
  else if (imported) parts.push(tr('足した曲から', 'From added songs'));
  parts.push(tr(`${r.use.length.toLocaleString()} 譜面（${r.songs.toLocaleString()} 曲）`, `${r.use.length.toLocaleString()} ${pl(r.use.length, 'chart')} (${r.songs.toLocaleString()} ${pl(r.songs, 'song')})`));
  if (r.nx && imported) parts.push(tr(`足した曲を含む`, 'including added songs'));
  return parts.join(' · ');
}

function EmptyCard(p: { nxSupported: boolean; hasPlace: boolean; granted: boolean; scanning: boolean; analyzing: { done: number; total: number } | null; onAdd: () => void }) {
  if (p.analyzing || p.scanning) {
    const a = p.analyzing;
    return (
      <div className="card guide-empty">
        <h3>{tr('DTXMania の曲から物差しを作っています', 'Building the ruler from your DTXMania songs')}</h3>
        <p className="lbl">
          {a
            ? tr(`譜面を読んでいます（${a.done} / ${a.total}）。読んだ譜面から表に入ります。次からは、増えた曲・変わった譜面だけ読みます。`, `Reading charts (${a.done} / ${a.total}). Charts are added to the tables as they are read. From next time, only new songs and changed charts are read.`)
            : tr('曲の一覧を読んでいます…', 'Reading the song list…')}
        </p>
        {a && (
          <div className="gp-prog">
            <i style={{ width: `${(a.done / Math.max(1, a.total)) * 100}%` }} />
          </div>
        )}
      </div>
    );
  }
  if (p.nxSupported && !p.hasPlace) {
    return (
      <div className="card guide-empty">
        <h3>{tr('DTXMania の曲から、レベルの物差しを作ります', 'Build a level ruler from your DTXMania songs')}</h3>
        <p className="lbl">
          {tr(
            'DTXMania のフォルダを選ぶと、入っている曲の譜面を読んで、レベル帯ごとに「どの要素が出てくるか」を集計します。成績からは、あなたの遊ぶレベルも見積もります。始める操作はこれだけで、あとは曲が増えるたびに裏で足します。',
            'Choose your DTXMania folder and the charts of its songs are read, counting which elements appear in each level band. Your records also give an estimate of your playing level. This is the only step; new songs are added in the background.',
          )}
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => void pickNxPlace()}>
            {Icon.folder(14)} {tr('DTXMania のフォルダを選ぶ…', 'Choose the DTXMania folder…')}
          </button>
          <button className="btn" onClick={p.onAdd}>
            {tr('曲のフォルダから足す…', 'Add from a song folder…')}
          </button>
        </div>
      </div>
    );
  }
  if (p.hasPlace && !p.granted) {
    return (
      <div className="card guide-empty">
        <h3>{tr('DTXMania の曲を読む許可が要ります', 'Permission is needed to read your DTXMania songs')}</h3>
        <p className="lbl">{tr('上の「続ける」で許可すると、曲の譜面を読んで物差しを作ります。', 'Allow it with “Continue” above and the ruler is built from your charts.')}</p>
      </div>
    );
  }
  return (
    <div className="card guide-empty">
      <h3>{tr('手元の曲から、レベルの物差しを作ります', 'Build a level ruler from your songs')}</h3>
      <p className="lbl">
        {p.nxSupported
          ? tr('DTXMania の曲に、物差しに使える譜面がまだありません。', 'Your DTXMania songs have no charts the ruler can use yet.')
          : tr(
              'このブラウザでは DTXMania のフォルダを覚えられないので、曲のフォルダ（iPad は曲の ZIP）から足してください。PC の Chrome・Edge なら、DTXMania の曲から自動で作ります。',
              "This browser can't remember the DTXMania folder, so add songs from a song folder (a song ZIP on iPad). In Chrome or Edge on a PC, the ruler is built from your DTXMania songs automatically.",
            )}
      </p>
      <button className="btn primary" onClick={p.onAdd}>
        {NO_FOLDER_PICK ? tr('曲の ZIP から足す…', 'Add from a song ZIP…') : tr('曲のフォルダから足す…', 'Add from a song folder…')}
      </button>
    </div>
  );
}

function GuideMenu({ items, close }: { items: { label: string; sub?: string; run: () => void }[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.nx-menu-wrap')) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [close]);
  return (
    <div className="nx-pop" ref={ref} role="menu">
      {items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          onClick={() => {
            close();
            it.run();
          }}
        >
          <b>{it.label}</b>
          {it.sub && <span className="lbl">{it.sub}</span>}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="guide-stat">
      <div className="lbl">{label}</div>
      <div className="mono">
        {value}
        {unit && <span className="lbl">{unit}</span>}
      </div>
    </div>
  );
}

function RowInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea
      className="guide-text"
      rows={1}
      value={v}
      placeholder={tr('例: 8分のハイハットが土台で、サビの一部で16分の刻みが入る', 'e.g. 8th-note hi-hat as the base, with some 16th notes in parts of the chorus')}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}
