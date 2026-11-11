import { tr, pl, isJa } from '../i18n';
import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import { KIT_GENRES, kitSourceById, virtualSound } from '../audio/sounds';
import { toBase36x2 } from '../dtx/base36';
import { CH, DRUM_LANES, isSeChannel, laneVoice } from '../dtx/model';
import { serializeHeader } from '../dtx/serialize';
import { parseDtx } from '../dtx/parse';
import { freeWavNumber, setField, setFieldComment } from '../edit/ops';
import type { HeaderLine } from '../dtx/model';
import { addMaterials, hasBga, IMAGE_EXT, materialFile, materials, MOVIE_EXT, pickMaterial, removeMaterial, setMaterialPath, useBga, type Material, type MaterialKind } from '../store/bga';
import { BGA_CHANNELS } from '../dtx/model';
import { thumb, useThumbs } from './thumbs';
import { audioFiles, findFile } from '../fs/folder';
import { wavPan, wavVolume } from '../store/derived';
import { playAudition, useStopAuditionOnClose } from '../store/audition';
import { edit, fileBuffer, openPage, prepareSounds, setFieldValue, setLaneWav, toast, useEditor, wavAuditionSound, type LeftTab } from '../store/editor';
import { editSong, setSongField, toastSongEdit } from '../store/songSync';
import { applyKitToChips, kitChoices, kitFile, setKit, useKit } from '../store/kit';
import { useLibrary } from '../store/library';
import { AuditionButton, AuditionProgress } from './Audition';
import { SpecialKitSection } from './SpecialUi';
import { chooseDialog, confirmDialog } from './dialogs';
import { formatLevel } from './format';
import { Icon } from './icons';

const tabs = (): [LeftTab, string][] => [
  ['kit', tr('キット', 'Kit')],
  ['wav', 'WAV'],
  ['bga', tr('画像', 'Images')],
  ['info', tr('曲情報', 'Info')],
  ['header', tr('ヘッダ', 'Header')],
];

export function LeftPanel() {
  const tab = useEditor((s) => s.leftTab);
  return (
    <aside className="left-panel">
      <div className="tabs">
        {tabs().map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => useEditor.setState({ leftTab: k })}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body scroll">
        {tab === 'kit' && <KitTab />}
        {tab === 'wav' && <WavTab />}
        {tab === 'bga' && <BgaTab />}
        {tab === 'info' && <InfoTab />}
        {tab === 'header' && <HeaderTab />}
      </div>
    </aside>
  );
}

function wavList(fields: Record<string, string>): { no: number; path: string }[] {
  return Object.entries(fields)
    .filter(([k]) => /^WAV[0-9A-Z]{2}$/.test(k))
    .map(([k, v]) => ({ no: parseInt(k.slice(3), 36), path: v }))
    .sort((a, b) => a.no - b.no);
}

/** ファイルの音を試聴するときの音 */
async function fileSound(path: string) {
  const buf = await fileBuffer(path);
  return buf ? { buf } : null;
}

/** レーンの音を「キットの音」に戻す（チップを置いたときにキットの音を登録する） */
function followKit(ch: number) {
  setLaneWav(ch, null);
  const file = kitFile(ch);
  if (file) void playAudition(`kit:${ch}`, () => fileSound(file));
}

function KitTab() {
  const fields = useEditor((s) => s.doc.fields);
  const laneWav = useEditor((s) => s.laneWav);
  const folder = useEditor((s) => s.folder);
  const kitId = useKit((s) => s.kitId);
  useLibrary((s) => s.kits);
  useLibrary((s) => s.samples);
  useStopAuditionOnClose('kit:');
  const choices = kitChoices();
  const cur = choices.find((k) => k.id === kitId) ?? choices[0];
  const wavs = wavList(fields);
  // 行は音の番号ごと（スネアのリムはスネアと別の行。リムの音は SD_RIM）
  const rows = DRUM_LANES.flatMap((l, i) => [
    { ch: l.main, name: l.mainName, color: l.color, key: l.key },
    ...(l.alt !== undefined ? [{ ch: laneVoice(i, true), name: l.altName!, color: l.altColor ?? l.color, key: `${l.key}*` }] : []),
  ]);
  // 標準キットはジャンルごと、ライブラリのキットは曲から・自分のキット
  const groups: { key: string; label: string; list: typeof choices }[] = [
    ...KIT_GENRES.map((g) => ({ key: g.id, label: tr(`標準キット · ${g.name}`, `Built-in · ${g.name}`), list: choices.filter((c) => c.group === 'builtin' && c.genre === g.id) })),
    { key: 'song', label: tr('曲から', 'From songs'), list: choices.filter((c) => c.group === 'song') },
    { key: 'own', label: tr('自分のキット', 'My kits'), list: choices.filter((c) => c.group === 'own') },
  ];
  const credits = (cur?.sources ?? []).map((id) => kitSourceById.get(id)).filter((x) => !!x);
  return (
    <>
      <div className="section-title">{tr('使用中のキット', 'Current kit')}</div>
      <div className="kit-pick">
        <span className="kit-ic">{Icon.drum(16)}</span>
        <select className="field" value={cur?.id} onChange={(e) => setKit(e.target.value)} aria-label={tr('使うキット', 'Kit to use')}>
          {groups.map(({ key, label, list }) =>
            list.length ? (
              <optgroup key={key} label={label}>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
      </div>
      <p className="lbl" style={{ margin: 0, lineHeight: 1.6 }}>
        {tr(
          `${cur?.desc ?? ''}。これから置くチップに使い、保存するときに使った音だけを曲フォルダへ書き出します。`,
          `${cur?.desc ?? ''}. Used for chips you place from now on; only the sounds actually used are written to the song folder when saving.`,
        )}
      </p>
      {credits.length > 0 && (
        <p className="lbl" style={{ margin: 0, lineHeight: 1.6 }} title={tr('どの音も、作った譜面に入れて配れます', 'You can include any of these sounds in the charts you share')}>
          {tr('音: ', 'Sounds: ')}
          {credits.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ' / '}
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
              ) : (
                c.name
              )}
              {` (${c.license})`}
            </span>
          ))}
        </p>
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button
          className="btn small"
          onClick={() => {
            const n = applyKitToChips();
            toast(
              n
                ? tr(`置いてあるチップ ${n} 個の音を「${cur?.name}」にしました（Ctrl+Z で戻せます）`, `Switched ${n} placed ${pl(n, 'chip')} to "${cur?.name}" (Ctrl+Z to undo)`)
                : tr('替えるチップはありませんでした', 'There were no chips to switch'),
              n ? 'ok' : 'info',
            );
          }}
          title={tr('置いてあるチップの音も、このキットの音に替えます（ベロシティは保ちます）', 'Also switch the sounds of the chips already placed to this kit (velocities are kept)')}
        >
          {tr('置いてあるチップも替える', 'Apply to placed chips')}
        </button>
        <button className="btn small ghost" onClick={() => openPage('library')}>
          {Icon.library(14)} {tr('ライブラリ', 'Library')}
        </button>
      </div>
      <div className="section-title" style={{ marginTop: 6 }}>
        {tr('レーンの音', 'Lane sounds')}
      </div>
      {rows.map((r) => {
        const no = laneWav[r.ch];
        const kf = kitFile(r.ch);
        const assignedPath = no !== undefined ? fields['WAV' + toBase36x2(no)] : undefined;
        // キットの音をそのまま使っている（登録済みでも）なら「キット」と出す
        const followsKit = assignedPath === undefined || (!!kf && assignedPath.toLowerCase() === kf.toLowerCase() && !fields['VOLUME' + toBase36x2(no!)]);
        const valid = !followsKit;
        const path = valid ? assignedPath : kf;
        const own = valid && !!findFile(folder, path ?? '', fields['PATH_WAV'] ?? '');
        const vs = !own && path ? virtualSound(path) : null;
        const badge: 'own' | 'lib' | 'std' = own ? 'own' : vs?.sampleId ? 'lib' : 'std';
        const badgeText = badge === 'own' ? tr('曲', 'Song') : badge === 'lib' ? tr('曲から', 'Library') : tr('標準', 'Built-in');
        return (
          <div key={r.ch} className="kit-row">
            <span className="dot" style={{ background: r.color }} />
            <span className="ellipsis" style={{ fontSize: 11.5 }} title={r.name}>
              {r.name}
            </span>
            <select
              className="field mono"
              style={{ height: 26, fontSize: 11.5 }}
              value={valid ? String(no) : 'kit'}
              title={vs ? tr(`${path}（${vs.origin}）`, `${path} (${vs.origin})`) : (path ?? '')}
              onChange={(e) => {
                if (e.target.value === 'kit') followKit(r.ch);
                else {
                  const picked = Number(e.target.value);
                  setLaneWav(r.ch, picked);
                  void playAudition(`kit:${r.ch}`, () => wavAuditionSound(picked));
                }
              }}
            >
              <option value="kit">{tr(`キット: ${kf?.replace(/^dtxweb_|^lib_/, '') ?? ''}`, `Kit: ${kf?.replace(/^dtxweb_|^lib_/, '') ?? ''}`)}</option>
              {wavs.map((w) => (
                <option key={w.no} value={w.no}>
                  {toBase36x2(w.no)} {w.path}
                  {fields['VOLUME' + toBase36x2(w.no)] ? tr(`（ベロシティ ${fields['VOLUME' + toBase36x2(w.no)]}）`, ` (velocity ${fields['VOLUME' + toBase36x2(w.no)]})`) : ''}
                </option>
              ))}
            </select>
            <span className={`kit-badge ${badge === 'std' ? '' : badge}`} title={vs?.origin ?? (own ? tr('曲フォルダの音', 'Sound from the song folder') : '')}>
              {badgeText}
            </span>
            <AuditionButton
              k={`kit:${r.ch}`}
              load={() => (valid ? wavAuditionSound(no!) : kf ? fileSound(kf) : null)}
              label={tr(`${r.name}の音`, `${r.name} sound`)}
              size={14}
              idleIcon={Icon.speaker(14)}
              style={{ width: 26, height: 26 }}
            />
            <AuditionProgress k={`kit:${r.ch}`} />
          </div>
        );
      })}
      <p className="lbl" style={{ margin: 0 }}>
        {isJa() ? (
          <>
            <kbd>Shift</kbd>+クリックで、HH は HHオープン、LP は左バスドラム、SD はリム（クロススティック）を置きます（＊の行の音）。リムは NX ではスネアのチップで、音だけが違います。
          </>
        ) : (
          <>
            <kbd>Shift</kbd>+click places HH open on HH, the left bass drum on LP and a rim (cross-stick) on SD (the sounds in the * rows). In NX a rim is a snare chip with a different sound.
          </>
        )}
      </p>
      <SpecialKitSection />
    </>
  );
}

function WavTab() {
  const doc = useEditor((s) => s.doc);
  const folder = useEditor((s) => s.folder);
  const missing = useEditor((s) => s.missingWavs);
  useEditor((s) => s.soundsVersion);
  useStopAuditionOnClose('wav:');
  const wavs = wavList(doc.fields);
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const missSet = new Set(missing);
  const usage = new Map<number, number>();
  // 原曲（BGM レーン）・SE レーンで鳴らす音には印を付ける（ドラムの音と並んでいても分かるように）
  const bgmNos = new Set<number>();
  const seNos = new Set<number>();
  for (const c of doc.chips) {
    if (c.ch === CH.BPM || c.ch === CH.BPM_EX) continue;
    usage.set(c.v, (usage.get(c.v) ?? 0) + 1);
    if (c.ch === CH.BGM) bgmNos.add(c.v);
    else if (isSeChannel(c.ch)) seNos.add(c.v);
  }

  const unused = wavs.filter((w) => !usage.get(w.no));
  const unusedList = `${unused
    .slice(0, 8)
    .map((w) => toBase36x2(w.no))
    .join(' ')}${unused.length > 8 ? ' …' : ''}`;
  const cleanup = async () => {
    const ok = await confirmDialog({
      title: tr(`使っていない WAV を ${unused.length} 個消しますか？`, `Remove ${unused.length} unused ${pl(unused.length, 'WAV')}?`),
      body: tr(
        `どのチップも使っていない #WAV（${unusedList}）と、その #VOLUME・#PAN を消します。曲フォルダのファイルは消えません。Ctrl+Z で戻せます。`,
        `Removes the #WAV entries no chip uses (${unusedList}) and their #VOLUME and #PAN. Files in the song folder are kept. Ctrl+Z to undo.`,
      ),
      ok: tr('消す', 'Remove'),
    });
    if (!ok) return;
    edit(tr(`使っていない WAV を ${unused.length} 個消す`, `Remove ${unused.length} unused ${pl(unused.length, 'WAV')}`), (d) => {
      for (const w of unused) {
        const z = toBase36x2(w.no);
        for (const k of ['WAV', 'VOLUME', 'WAVVOL', 'PAN', 'WAVPAN', 'SIZE']) if (d.fields[k + z] !== undefined) setField(d, k + z, undefined);
      }
    });
  };

  const addWav = async () => {
    if (!folder) return;
    const files = audioFiles(folder);
    const picked = await chooseDialog({
      title: tr('WAVを追加', 'Add WAV'),
      body: tr('曲フォルダの音声ファイルから選びます。', 'Pick an audio file from the song folder.'),
      options: files.slice(0, 200).map((f) => ({ label: f.path, sub: `${(f.size / 1024).toFixed(0)} KB`, value: f.path })),
    });
    if (!picked) return;
    const no = freeWavNumber(doc);
    if (no === null) return;
    setFieldValue('WAV' + toBase36x2(no), picked, tr(`WAV${toBase36x2(no)} を追加`, `Add WAV${toBase36x2(no)}`));
  };

  return (
    <>
      <div className="section-title">
        {tr('WAVリスト', 'WAV list')}
        <span className="lbl mono">{wavs.length} / 1295</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void addWav()} disabled={!folder}>
          {Icon.plus(12)} {tr('追加', 'Add')}
        </button>
      </div>
      {unused.length > 0 && (
        <div className="row" style={{ gap: 6, margin: '-4px 0 8px' }}>
          <span className="lbl">{tr(`使っていない WAV が ${unused.length} 個あります`, `${unused.length} unused ${pl(unused.length, 'WAV')}`)}</span>
          <button className="link-btn" onClick={() => void cleanup()}>
            {tr('整理する', 'Clean up')}
          </button>
        </div>
      )}
      <table className="wav-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>No</th>
            <th>{tr('ファイル', 'File')}</th>
            <th style={{ width: 46 }}>{tr('音量', 'Vol')}</th>
            <th style={{ width: 44 }}>{tr('パン', 'Pan')}</th>
            <th style={{ width: 24 }} />
          </tr>
        </thead>
        <tbody>
          {wavs.map((w) => {
            const z = toBase36x2(w.no);
            const isMissing = missSet.has(w.no) || (!findFile(folder, w.path, pathWav) && !/^dtxweb_kit_/i.test(w.path) && !!folder);
            const kind: 'bgm' | 'se' | null = bgmNos.has(w.no) ? 'bgm' : seNos.has(w.no) ? 'se' : null;
            const dur = engine.duration(w.no);
            const long = dur >= LONG_SOUND_SEC;
            return (
              <tr
                key={w.no}
                className={isMissing ? 'missing' : ''}
                title={tr(
                  `${usage.get(w.no) ?? 0} 個のチップで使用${isMissing ? '・ファイルが見つかりません' : ''}`,
                  `Used by ${usage.get(w.no) ?? 0} ${pl(usage.get(w.no) ?? 0, 'chip')}${isMissing ? ' · file not found' : ''}`,
                )}
              >
                <td className="mono wav-no">
                  {z}
                  <span className="wav-uses" style={kind ? { visibility: 'hidden' } : undefined}>
                    {usage.get(w.no) ?? 0}
                  </span>
                  {kind && (
                    <span className={`wav-kind ${kind === 'bgm' ? 'bgm' : ''}`} title={kindHint(kind)}>
                      {kind === 'bgm' ? tr('原曲', 'BGM') : 'SE'}
                    </span>
                  )}
                </td>
                <td className="wav-file">
                  <CommitInput value={w.path} onCommit={(v) => setFieldValue('WAV' + z, v || undefined)} />
                  <div className="wav-sub">
                    <CommitInput className="wav-label" value={commentOf(doc, 'WAV' + z)} placeholder={tr('ラベル', 'Label')} onCommit={(v) => setComment('WAV' + z, v)} />
                    {long && (
                      <span className="wav-len mono" title={tr(`${formatDur(dur)} の長い音（試聴は ■ か Esc で止められます）`, `A long sound (${formatDur(dur)}). Stop the preview with ■ or Esc`)}>
                        {formatDur(dur)}
                      </span>
                    )}
                  </div>
                  <AuditionProgress k={`wav:${w.no}`} />
                </td>
                <td>
                  <CommitInput
                    className="mono"
                    value={String(wavVolume(doc, w.no))}
                    onCommit={(v) => setFieldValue('VOLUME' + z, v === '' || v === '100' ? undefined : v)}
                  />
                </td>
                <td>
                  <CommitInput className="mono" value={String(wavPan(doc, w.no))} onCommit={(v) => setFieldValue('PAN' + z, v === '' || v === '0' ? undefined : v)} />
                </td>
                <td>
                  <AuditionButton k={`wav:${w.no}`} load={() => wavAuditionSound(w.no)} label={tr(`WAV${z}（${w.path}）`, `WAV${z} (${w.path})`)} style={{ width: 22, height: 22 }} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {wavs.length === 0 && <p className="lbl">{tr('まだWAVはありません。譜面にチップを置くと内蔵キットの音が自動で登録されます。', 'No WAVs yet. Placing chips registers the built-in kit sounds automatically.')}</p>}
    </>
  );
}

/** これより長い音は WAV リストに長さを出す（原曲・SE の伴奏など） */
const LONG_SOUND_SEC = 10;

const kindHint = (k: 'bgm' | 'se'): string =>
  k === 'bgm'
    ? tr('原曲（BGM レーン ch01 で鳴らす音）。DTX では原曲も #WAV に登録して鳴らします', 'The original (played on the BGM lane, ch01). In DTX the original is also registered as a #WAV')
    : tr('SE レーン（ch61〜）で鳴らす音', 'Played on an SE lane (ch61 and up)');

function formatDur(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** フォーカスを外したか Enter で確定する入力欄 */
export function CommitInput({ value, onCommit, className, placeholder }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={className}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

const infoFields = (): { key: string; label: string; hint?: string; files?: RegExp }[] => [
  { key: 'TITLE', label: tr('曲名', 'Title') },
  { key: 'ARTIST', label: tr('アーティスト', 'Artist') },
  { key: 'GENRE', label: tr('ジャンル', 'Genre') },
  { key: 'COMMENT', label: tr('コメント', 'Comment') },
  { key: 'BPM', label: 'BPM', hint: tr('曲頭のBPM', 'BPM at the start') },
  { key: 'DLEVEL', label: tr('ドラムLv', 'Drum Lv'), hint: tr('825 → 8.25、82 → 8.20', '825 → 8.25, 82 → 8.20') },
  { key: 'PREVIEW', label: 'PREVIEW', hint: tr('選曲画面で流す音', 'Audio played on the song select screen'), files: /\.(ogg|wav|mp3)$/i },
  { key: 'PREIMAGE', label: 'PREIMAGE', hint: tr('選曲画面の画像', 'Image on the song select screen'), files: /\.(png|jpe?g|bmp)$/i },
  { key: 'STAGEFILE', label: 'STAGEFILE', hint: tr('読み込み中の画像', 'Image shown while loading'), files: /\.(png|jpe?g|bmp)$/i },
];

function InfoTab() {
  const fields = useEditor((s) => s.doc.fields);
  const folder = useEditor((s) => s.folder);
  return (
    <>
      <div className="section-title">
        {tr('曲情報', 'Song info')}
        <span className="grow" />
        <button className="btn small" onClick={() => openPage('songinfo')} title={tr('ヘッダの全項目、AIで調べる、サムネイルの切り取り', 'All header fields, AI lookup, thumbnail cropping')}>
          {Icon.sparkle(12)} {tr('全項目・AI取得', 'All fields · AI')}
        </button>
      </div>
      <div className="form-grid">
        {infoFields().map((f) => {
          const options = f.files && folder ? [...folder.files.values()].filter((x) => f.files!.test(x.name)) : null;
          return (
            <InfoRow key={f.key} label={f.label} hint={f.key === 'DLEVEL' ? tr(`表示 ${formatLevel(fields['DLEVEL'])}`, `Shown as ${formatLevel(fields['DLEVEL'])}`) : f.hint}>
              {options && options.length > 0 ? (
                <select className="field" value={fields[f.key] ?? ''} onChange={(e) => setSongField(f.key, e.target.value || undefined)}>
                  <option value="">{tr('なし', 'None')}</option>
                  {fields[f.key] && !options.some((o) => o.path === fields[f.key]) && (
                    <option value={fields[f.key]}>
                      {fields[f.key]}
                      {tr('（見つかりません）', ' (not found)')}
                    </option>
                  )}
                  {options.map((o) => (
                    <option key={o.path} value={o.path}>
                      {o.path}
                    </option>
                  ))}
                </select>
              ) : (
                <CommitInput
                  className={`field ${f.key === 'BPM' || f.key === 'DLEVEL' ? 'mono' : ''}`}
                  value={fields[f.key] ?? ''}
                  onCommit={(v) => setSongField(f.key, v === '' ? undefined : v, tr(`${f.label}を変更`, `Change ${f.label}`))}
                />
              )}
            </InfoRow>
          );
        })}
      </div>
      <p className="lbl" style={{ margin: 0 }}>
        {tr(
          'BPMの途中変化は譜面のBPM列をダブルクリックして置きます。拍子（小節長）は右の「小節」から変えられます。',
          'To change the BPM mid-song, double-click the BPM column in the chart. Change the meter (measure length) under "Measure" on the right.',
        )}
      </p>
    </>
  );
}

function InfoRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <>
      <span className="lbl" title={hint}>
        {label}
        {hint && <span style={{ display: 'block', fontSize: 10, color: 'var(--dim)' }}>{hint}</span>}
      </span>
      {children}
    </>
  );
}

function HeaderTab() {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const lines = serializeHeader(doc);
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    if (draft === null) return;
    const { doc: parsed } = parseDtx(draft);
    if (parsed.chips.length > 0 || Object.keys(parsed.barLengths).length > 0 || parsed.endMeasure !== undefined) {
      toast(tr('チップの行（#00111: など）はヘッダには書けません。譜面で置いてください', "Chip lines (like #00111:) can't go in the header. Place them in the chart instead"), 'error', 6000);
      return;
    }
    // 曲のもの（曲名・試聴・BPM など）を変えたら、同じだったほかの難易度にも入れる
    const r = editSong(tr('ヘッダを書き換え', 'Edit header'), (d) => {
      d.header = parsed.header;
      d.fields = parsed.fields;
    });
    void prepareSounds();
    setDraft(null);
    void toastSongEdit(r, tr('ヘッダを反映しました（Ctrl+Z で戻せます）', 'Header applied (Ctrl+Z to undo)'), 'ok', 4000);
  };
  return (
    <>
      <div className="section-title">
        {tr('ヘッダ', 'Header')}
        <span className="grow" />
        {draft === null ? (
          <button className="btn small" onClick={() => setDraft(lines.join('\n'))} title={tr('DTXのヘッダを直接書き換えます（旧Creatorの自由入力）', 'Edit the DTX header directly (like the free input in the old DTXCreator)')}>
            {tr('直接編集', 'Edit directly')}
          </button>
        ) : (
          <>
            <button className="btn small ghost" onClick={() => setDraft(null)}>
              {tr('やめる', 'Cancel')}
            </button>
            <button className="btn small primary" onClick={apply}>
              {tr('反映', 'Apply')}
            </button>
          </>
        )}
      </div>
      <p className="lbl" style={{ margin: 0 }}>
        {draft === null
          ? tr(
              'エディタが解釈しない行（#RANDOM やギター・ベースのチップなど）も、そのまま保存します。「直接編集」で好きなコマンドを書き足せます。',
              'Lines the editor doesn\'t interpret (#RANDOM, guitar/bass chips, etc.) are saved as is. Use "Edit directly" to add any command.',
            )
          : tr(
              '1行に1つのコマンド（#TITLE: 曲名 など）。「;」から後ろはコメントです。チップの行はここには書けません。',
              'One command per line (like #TITLE: name). Everything after ";" is a comment. Chip lines can\'t go here.',
            )}
      </p>
      {draft === null ? (
        <div className="raw-header scroll">
          {lines.map((t, i) => {
            if (t.startsWith('#')) {
              const m = /^(#\S+)(.*)$/.exec(t)!;
              return (
                <div key={i}>
                  <span className="k">{m[1]}</span>
                  {m[2]}
                </div>
              );
            }
            return (
              <div key={i} className="c">
                {t || ' '}
              </div>
            );
          })}
        </div>
      ) : (
        <textarea className="raw-edit" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} aria-label={tr('ヘッダ', 'Header')} />
      )}
      <div className="section-title">{tr('ファイル', 'File')}</div>
      <div className="form-grid">
        <span className="lbl">{tr('ファイル名', 'File name')}</span>
        <span className="mono">{meta.fileName}</span>
        <span className="lbl">{tr('読み込み', 'Read as')}</span>
        <span>
          {meta.encoding === 'shift_jis'
            ? 'Shift_JIS'
            : meta.encoding === 'utf-8-bom'
              ? tr('UTF-8（BOM付き）', 'UTF-8 (with BOM)')
              : meta.encoding === 'utf-8'
                ? tr('UTF-8（BOMなし）', 'UTF-8 (no BOM)')
                : tr('UTF-16（BOM付き）', 'UTF-16 (with BOM)')}
        </span>
        <span className="lbl">{tr('保存', 'Saved as')}</span>
        <span>Shift_JIS · CRLF</span>
        <span className="lbl">{tr('キットの音', 'Kit sounds')}</span>
        <span className="lbl">{tr('曲フォルダに無い音は、保存するときに書き出します（dtxweb_*.wav・lib_*.wav）', 'Sounds not in the song folder are written out when saving (dtxweb_*.wav, lib_*.wav)')}</span>
      </div>
    </>
  );
}

/** ヘッダの行のコメント（WAV のラベル） */
function commentOf(doc: { header: readonly HeaderLine[] }, key: string): string {
  for (const h of doc.header) if (h.kind === 'field' && h.key === key) return h.comment?.trim() ?? '';
  return '';
}

function setComment(key: string, text: string) {
  edit(tr(`#${key} のラベルを変更`, `Change label of #${key}`), (d) => setFieldComment(d, key, text));
}

// ---- 画像（BMP）・動画（AVI） ----------------------------------------------------

function BgaTab() {
  const doc = useEditor((s) => s.doc);
  const folder = useEditor((s) => s.folder);
  const st = useBga();
  useThumbs((s) => s.ver);
  const mats = materials(doc);
  const bmps = mats.filter((m) => m.kind === 'bmp');
  const avis = mats.filter((m) => m.kind === 'avi');
  const files = folder ? [...folder.files.values()] : [];
  const images = files.filter((f) => IMAGE_EXT.test(f.name));
  const movies = files.filter((f) => MOVIE_EXT.test(f.name));
  const registered = new Set(mats.map((m) => m.path.toLowerCase()));
  const add = async (kind: MaterialKind) => {
    const list = (kind === 'avi' ? movies : images).filter((f) => !registered.has(f.path.toLowerCase()));
    if (!list.length) {
      toast(kind === 'avi' ? tr('曲フォルダに、まだ登録していない動画がありません', 'No unregistered movies in the song folder') : tr('曲フォルダに、まだ登録していない画像がありません', 'No unregistered images in the song folder'), 'info');
      return;
    }
    const picked = await chooseDialog({
      title: kind === 'avi' ? tr('動画を登録', 'Register movie') : tr('画像を登録', 'Register image'),
      body: tr('曲フォルダのファイルから選びます。', 'Pick a file from the song folder.'),
      options: [
        { label: tr(`まとめて全部（${list.length} 個）`, `All of them (${list.length})`), sub: tr('番号は空いているところから順に付けます', 'Numbers are assigned from the first free one'), value: '*' },
        ...list.slice(0, 200).map((f) => ({ label: f.path, sub: `${(f.size / 1024).toFixed(0)} KB`, value: f.path })),
      ],
    });
    if (!picked) return;
    const n = addMaterials(kind, picked === '*' ? list.map((f) => f.path) : [picked]);
    if (n) toast(tr(`${n} 個を #${kind === 'avi' ? 'AVI' : 'BMP'} に登録しました`, `Registered ${n} as #${kind === 'avi' ? 'AVI' : 'BMP'}`), 'ok');
  };
  return (
    <>
      <div className="section-title">{tr('置くとき', 'When placing')}</div>
      <div className="form-grid" style={{ marginBottom: 8 }}>
        <span className="lbl">{tr('画像のレイヤー', 'Image layer')}</span>
        <select className="field" value={st.layer} onChange={(e) => useBga.setState({ layer: Number(e.target.value) })}>
          {BGA_CHANNELS.filter((b) => !b.movie).map((b) => (
            <option key={b.ch} value={b.ch}>
              {b.name} ({b.ch.toString(16).toUpperCase().padStart(2, '0')})
            </option>
          ))}
        </select>
        <span className="lbl">{tr('動画', 'Movie')}</span>
        <select className="field" value={st.movieCh} onChange={(e) => useBga.setState({ movieCh: Number(e.target.value) })}>
          {BGA_CHANNELS.filter((b) => b.movie).map((b) => (
            <option key={b.ch} value={b.ch}>
              {b.name} ({b.ch.toString(16).toUpperCase().padStart(2, '0')})
            </option>
          ))}
        </select>
      </div>
      <label className="row lbl" style={{ gap: 6 }}>
        <input type="checkbox" checked={st.show || hasBga(doc)} disabled={hasBga(doc)} onChange={(e) => useBga.setState({ show: e.target.checked })} />
        {tr('譜面の右に BGA の列を出す', 'Show BGA columns right of the chart')}
      </label>
      <label className="row lbl" style={{ gap: 6, marginBottom: 6 }}>
        <input type="checkbox" checked={st.wide} onChange={(e) => useBga.setState({ wide: e.target.checked, show: true })} />
        {tr('列を広げて画像のサムネイルを出す', 'Widen the columns to show image thumbnails')}
      </label>
      <p className="lbl" style={{ margin: '0 0 10px', lineHeight: 1.6 }}>
        {tr(
          '下の一覧で素材を選び、譜面の BGA 列をクリックすると置けます。ダブルクリックで消す、ドラッグで動かす、右クリックでメニューはドラムと同じです。',
          'Pick an asset in the list below, then click a BGA column in the chart to place it. Double-click to delete, drag to move and right-click for a menu, just like drums.',
        )}
      </p>

      <div className="section-title">
        {tr('画像（#BMP）', 'Images (#BMP)')}
        <span className="lbl mono">{bmps.length}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void add('bmp')} disabled={!folder}>
          {Icon.plus(12)} {tr('登録', 'Register')}
        </button>
      </div>
      <MaterialList list={bmps} />
      <div className="section-title" style={{ marginTop: 14 }}>
        {tr('動画（#AVI）', 'Movies (#AVI)')}
        <span className="lbl mono">{avis.length}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void add('avi')} disabled={!folder}>
          {Icon.plus(12)} {tr('登録', 'Register')}
        </button>
      </div>
      <MaterialList list={avis} />
    </>
  );
}

function MaterialList({ list }: { list: Material[] }) {
  const st = useBga();
  if (!list.length) return <p className="lbl">{tr('まだありません。', 'None yet.')}</p>;
  return (
    <div className="mat-list">
      {list.map((m) => {
        const on = st.kind === m.kind && st.no === m.no;
        const missing = !materialFile(m.path);
        const img = m.kind === 'bmp' ? thumb(m.path) : null;
        return (
          <div key={m.key} className={`mat-row ${on ? 'on' : ''} ${missing ? 'missing' : ''}`} onClick={() => pickMaterial(m.kind, m.no)} title={missing ? tr('ファイルが見つかりません', 'File not found') : tr(`${m.uses} 個のチップで使用`, `Used by ${m.uses} ${pl(m.uses, 'chip')}`)}>
            <span className="mat-thumb">{img ? <img src={img.src} alt="" /> : m.kind === 'avi' ? '🎬' : '🖼'}</span>
            <span className="mono">{m.key.replace(/^(BMP|BMPTEX|AVI)/, (k) => (k === 'BMPTEX' ? 'TEX' : ''))}</span>
            <span className="grow" style={{ minWidth: 0 }}>
              <CommitInput className="mat-path" value={m.path} onCommit={(v) => setMaterialPath(m.key, v)} />
            </span>
            <span className="mono lbl">{m.uses}</span>
            <button
              className="ib tiny"
              title={tr('登録を消す', 'Unregister')}
              onClick={(e) => {
                e.stopPropagation();
                removeMaterial(m.key);
              }}
            >
              {Icon.trash(12)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
