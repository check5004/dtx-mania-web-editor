import { useEffect, useState } from 'react';
import { virtualSound } from '../audio/sounds';
import { toBase36x2 } from '../dtx/base36';
import { DRUM_LANES } from '../dtx/model';
import { serializeHeader } from '../dtx/serialize';
import { parseDtx } from '../dtx/parse';
import { freeWavNumber, setField, setFieldComment } from '../edit/ops';
import type { HeaderLine } from '../dtx/model';
import { addMaterials, hasBga, IMAGE_EXT, materialFile, materials, MOVIE_EXT, pickMaterial, removeMaterial, setMaterialPath, useBga, type Material, type MaterialKind } from '../store/bga';
import { BGA_CHANNELS } from '../dtx/model';
import { thumb, useThumbs } from './thumbs';
import { audioFiles, findFile } from '../fs/folder';
import { wavPan, wavVolume } from '../store/derived';
import { edit, openPage, prepareSounds, previewFile, previewWav, setFieldValue, setLaneWav, toast, useEditor, type LeftTab } from '../store/editor';
import { applyKitToChips, kitChoices, kitFile, setKit, useKit } from '../store/kit';
import { useLibrary } from '../store/library';
import { chooseDialog, confirmDialog } from './dialogs';
import { formatLevel } from './format';
import { Icon } from './icons';

const TABS: [LeftTab, string][] = [
  ['kit', 'キット'],
  ['wav', 'WAV'],
  ['bga', '画像'],
  ['info', '曲情報'],
  ['header', 'ヘッダ'],
];

export function LeftPanel() {
  const tab = useEditor((s) => s.leftTab);
  return (
    <aside className="left-panel">
      <div className="tabs">
        {TABS.map(([k, label]) => (
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

/** レーンの音を「キットの音」に戻す（チップを置いたときにキットの音を登録する） */
function followKit(ch: number) {
  setLaneWav(ch, null);
  const file = kitFile(ch);
  if (file) void previewFile(file);
}

function KitTab() {
  const fields = useEditor((s) => s.doc.fields);
  const laneWav = useEditor((s) => s.laneWav);
  const folder = useEditor((s) => s.folder);
  const kitId = useKit((s) => s.kitId);
  useLibrary((s) => s.kits);
  useLibrary((s) => s.samples);
  const choices = kitChoices();
  const cur = choices.find((k) => k.id === kitId) ?? choices[0];
  const wavs = wavList(fields);
  const rows = DRUM_LANES.flatMap((l) => [
    { ch: l.main, name: l.mainName, color: l.color, key: l.key },
    ...(l.alt !== undefined ? [{ ch: l.alt, name: l.altName!, color: l.altColor ?? l.color, key: `${l.key}*` }] : []),
  ]);
  const groups = ['標準キット', '曲から', '自分のキット'] as const;
  return (
    <>
      <div className="section-title">使用中のキット</div>
      <div className="kit-pick">
        <span className="kit-ic">{Icon.drum(16)}</span>
        <select className="field" value={cur?.id} onChange={(e) => setKit(e.target.value)} aria-label="使うキット">
          {groups.map((g) => {
            const list = choices.filter((c) => c.group === g);
            return list.length ? (
              <optgroup key={g} label={g}>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
      </div>
      <p className="lbl" style={{ margin: 0, lineHeight: 1.6 }}>
        {cur?.desc}。これから置くチップに使い、保存するときに使った音だけを曲フォルダへ書き出します。
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button
          className="btn small"
          onClick={() => {
            const n = applyKitToChips();
            toast(n ? `置いてあるチップ ${n} 個の音を「${cur?.name}」にしました（Ctrl+Z で戻せます）` : '替えるチップはありませんでした', n ? 'ok' : 'info');
          }}
          title="置いてあるチップの音も、このキットの音に替えます（ベロシティは保ちます）"
        >
          置いてあるチップも替える
        </button>
        <button className="btn small ghost" onClick={() => openPage('library')}>
          {Icon.library(14)} ライブラリ
        </button>
      </div>
      <div className="section-title" style={{ marginTop: 6 }}>
        レーンの音
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
        const badge = own ? '曲' : vs?.sampleId ? '曲から' : '標準';
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
              title={vs ? `${path}（${vs.origin}）` : (path ?? '')}
              onChange={(e) => {
                if (e.target.value === 'kit') followKit(r.ch);
                else {
                  setLaneWav(r.ch, Number(e.target.value));
                  previewWav(Number(e.target.value));
                }
              }}
            >
              <option value="kit">キット: {kf?.replace(/^dtxweb_|^lib_/, '')}</option>
              {wavs.map((w) => (
                <option key={w.no} value={w.no}>
                  {toBase36x2(w.no)} {w.path}
                  {fields['VOLUME' + toBase36x2(w.no)] ? `（ベロシティ ${fields['VOLUME' + toBase36x2(w.no)]}）` : ''}
                </option>
              ))}
            </select>
            <span className={`kit-badge ${badge === '曲' ? 'own' : badge === '曲から' ? 'lib' : ''}`} title={vs?.origin ?? (own ? '曲フォルダの音' : '')}>
              {badge}
            </span>
            <button
              className="ib"
              style={{ width: 26, height: 26 }}
              title="試聴"
              aria-label={`${r.name}の音を試聴`}
              onClick={() => {
                if (valid) previewWav(no!);
                else if (kf) void previewFile(kf);
              }}
            >
              {Icon.speaker(14)}
            </button>
          </div>
        );
      })}
      <p className="lbl" style={{ margin: 0 }}>
        <kbd>Shift</kbd>+クリックで、HH は HHオープン、LP は左バスドラムを置きます（＊の行の音）。
      </p>
    </>
  );
}

function WavTab() {
  const doc = useEditor((s) => s.doc);
  const folder = useEditor((s) => s.folder);
  const missing = useEditor((s) => s.missingWavs);
  const wavs = wavList(doc.fields);
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const missSet = new Set(missing);
  const usage = new Map<number, number>();
  for (const c of doc.chips) if (c.ch !== 3 && c.ch !== 8) usage.set(c.v, (usage.get(c.v) ?? 0) + 1);

  const unused = wavs.filter((w) => !usage.get(w.no));
  const cleanup = async () => {
    const ok = await confirmDialog({
      title: `使っていない WAV を ${unused.length} 個消しますか？`,
      body: `どのチップも使っていない #WAV（${unused
        .slice(0, 8)
        .map((w) => toBase36x2(w.no))
        .join(' ')}${unused.length > 8 ? ' …' : ''}）と、その #VOLUME・#PAN を消します。曲フォルダのファイルは消えません。Ctrl+Z で戻せます。`,
      ok: '消す',
    });
    if (!ok) return;
    edit(`使っていない WAV を ${unused.length} 個消す`, (d) => {
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
      title: 'WAVを追加',
      body: '曲フォルダの音声ファイルから選びます。',
      options: files.slice(0, 200).map((f) => ({ label: f.path, sub: `${(f.size / 1024).toFixed(0)} KB`, value: f.path })),
    });
    if (!picked) return;
    const no = freeWavNumber(doc);
    if (no === null) return;
    setFieldValue('WAV' + toBase36x2(no), picked, `WAV${toBase36x2(no)} を追加`);
  };

  return (
    <>
      <div className="section-title">
        WAVリスト
        <span className="lbl mono">{wavs.length} / 1295</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void addWav()} disabled={!folder}>
          {Icon.plus(12)} 追加
        </button>
      </div>
      {unused.length > 0 && (
        <div className="row" style={{ gap: 6, margin: '-4px 0 8px' }}>
          <span className="lbl">使っていない WAV が {unused.length} 個あります</span>
          <button className="link-btn" onClick={() => void cleanup()}>
            整理する
          </button>
        </div>
      )}
      <table className="wav-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>No</th>
            <th>ファイル</th>
            <th style={{ width: 46 }}>音量</th>
            <th style={{ width: 44 }}>パン</th>
            <th style={{ width: 24 }} />
          </tr>
        </thead>
        <tbody>
          {wavs.map((w) => {
            const z = toBase36x2(w.no);
            const isMissing = missSet.has(w.no) || (!findFile(folder, w.path, pathWav) && !/^dtxweb_kit_/i.test(w.path) && !!folder);
            return (
              <tr key={w.no} className={isMissing ? 'missing' : ''} title={`${usage.get(w.no) ?? 0} 個のチップで使用${isMissing ? '・ファイルが見つかりません' : ''}`}>
                <td className="mono">
                  {z}
                  <span className="wav-uses">{usage.get(w.no) ?? 0}</span>
                </td>
                <td>
                  <CommitInput value={w.path} onCommit={(v) => setFieldValue('WAV' + z, v || undefined)} />
                  <CommitInput className="wav-label" value={commentOf(doc, 'WAV' + z)} placeholder="ラベル" onCommit={(v) => setComment('WAV' + z, v)} />
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
                  <button className="ib" style={{ width: 22, height: 22 }} onClick={() => previewWav(w.no)} title="試聴">
                    {Icon.play(11)}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {wavs.length === 0 && <p className="lbl">まだWAVはありません。譜面にチップを置くと内蔵キットの音が自動で登録されます。</p>}
    </>
  );
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

const INFO_FIELDS: { key: string; label: string; hint?: string; files?: RegExp }[] = [
  { key: 'TITLE', label: '曲名' },
  { key: 'ARTIST', label: 'アーティスト' },
  { key: 'GENRE', label: 'ジャンル' },
  { key: 'COMMENT', label: 'コメント' },
  { key: 'BPM', label: 'BPM', hint: '曲頭のBPM' },
  { key: 'DLEVEL', label: 'ドラムLv', hint: '825 → 8.25、82 → 8.20' },
  { key: 'PREVIEW', label: 'PREVIEW', hint: '選曲画面で流す音', files: /\.(ogg|wav|mp3)$/i },
  { key: 'PREIMAGE', label: 'PREIMAGE', hint: '選曲画面の画像', files: /\.(png|jpe?g|bmp)$/i },
  { key: 'STAGEFILE', label: 'STAGEFILE', hint: '読み込み中の画像', files: /\.(png|jpe?g|bmp)$/i },
];

function InfoTab() {
  const fields = useEditor((s) => s.doc.fields);
  const folder = useEditor((s) => s.folder);
  return (
    <>
      <div className="section-title">
        曲情報
        <span className="grow" />
        <button className="btn small" onClick={() => openPage('songinfo')} title="ヘッダの全項目、AIで調べる、サムネイルの切り取り">
          {Icon.sparkle(12)} 全項目・AI取得
        </button>
      </div>
      <div className="form-grid">
        {INFO_FIELDS.map((f) => {
          const options = f.files && folder ? [...folder.files.values()].filter((x) => f.files!.test(x.name)) : null;
          return (
            <InfoRow key={f.key} label={f.label} hint={f.key === 'DLEVEL' ? `表示 ${formatLevel(fields['DLEVEL'])}` : f.hint}>
              {options && options.length > 0 ? (
                <select className="field" value={fields[f.key] ?? ''} onChange={(e) => setFieldValue(f.key, e.target.value || undefined)}>
                  <option value="">なし</option>
                  {fields[f.key] && !options.some((o) => o.path === fields[f.key]) && <option value={fields[f.key]}>{fields[f.key]}（見つかりません）</option>}
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
                  onCommit={(v) => setFieldValue(f.key, v === '' ? undefined : v, `${f.label}を変更`)}
                />
              )}
            </InfoRow>
          );
        })}
      </div>
      <p className="lbl" style={{ margin: 0 }}>
        BPMの途中変化は譜面のBPM列をダブルクリックして置きます。拍子（小節長）は右の「小節」から変えられます。
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
      toast('チップの行（#00111: など）はヘッダには書けません。譜面で置いてください', 'error', 6000);
      return;
    }
    edit('ヘッダを書き換え', (d) => {
      d.header = parsed.header;
      d.fields = parsed.fields;
    });
    void prepareSounds();
    setDraft(null);
    toast('ヘッダを反映しました（Ctrl+Z で戻せます）', 'ok');
  };
  return (
    <>
      <div className="section-title">
        ヘッダ
        <span className="grow" />
        {draft === null ? (
          <button className="btn small" onClick={() => setDraft(lines.join('\n'))} title="DTXのヘッダを直接書き換えます（旧Creatorの自由入力）">
            直接編集
          </button>
        ) : (
          <>
            <button className="btn small ghost" onClick={() => setDraft(null)}>
              やめる
            </button>
            <button className="btn small primary" onClick={apply}>
              反映
            </button>
          </>
        )}
      </div>
      <p className="lbl" style={{ margin: 0 }}>
        {draft === null
          ? 'エディタが解釈しない行（#RANDOM やギター・ベースのチップなど）も、そのまま保存します。「直接編集」で好きなコマンドを書き足せます。'
          : '1行に1つのコマンド（#TITLE: 曲名 など）。「;」から後ろはコメントです。チップの行はここには書けません。'}
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
        <textarea className="raw-edit" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} aria-label="ヘッダ" />
      )}
      <div className="section-title">ファイル</div>
      <div className="form-grid">
        <span className="lbl">ファイル名</span>
        <span className="mono">{meta.fileName}</span>
        <span className="lbl">読み込み</span>
        <span>
          {meta.encoding === 'shift_jis'
            ? 'Shift_JIS'
            : meta.encoding === 'utf-8-bom'
              ? 'UTF-8（BOM付き）'
              : meta.encoding === 'utf-8'
                ? 'UTF-8（BOMなし）'
                : 'UTF-16（BOM付き）'}
        </span>
        <span className="lbl">保存</span>
        <span>Shift_JIS・CRLF</span>
        <span className="lbl">キットの音</span>
        <span className="lbl">曲フォルダに無い音は、保存するときに書き出します（dtxweb_*.wav・lib_*.wav）</span>
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
  edit(`#${key} のラベルを変更`, (d) => setFieldComment(d, key, text));
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
      toast(kind === 'avi' ? '曲フォルダに、まだ登録していない動画がありません' : '曲フォルダに、まだ登録していない画像がありません', 'info');
      return;
    }
    const picked = await chooseDialog({
      title: kind === 'avi' ? '動画を登録' : '画像を登録',
      body: '曲フォルダのファイルから選びます。',
      options: [
        { label: `まとめて全部（${list.length} 個）`, sub: '番号は空いているところから順に付けます', value: '*' },
        ...list.slice(0, 200).map((f) => ({ label: f.path, sub: `${(f.size / 1024).toFixed(0)} KB`, value: f.path })),
      ],
    });
    if (!picked) return;
    const n = addMaterials(kind, picked === '*' ? list.map((f) => f.path) : [picked]);
    if (n) toast(`${n} 個を #${kind === 'avi' ? 'AVI' : 'BMP'} に登録しました`, 'ok');
  };
  return (
    <>
      <div className="section-title">置くとき</div>
      <div className="form-grid" style={{ marginBottom: 8 }}>
        <span className="lbl">画像のレイヤー</span>
        <select className="field" value={st.layer} onChange={(e) => useBga.setState({ layer: Number(e.target.value) })}>
          {BGA_CHANNELS.filter((b) => !b.movie).map((b) => (
            <option key={b.ch} value={b.ch}>
              {b.name}（{b.ch.toString(16).toUpperCase().padStart(2, '0')}）
            </option>
          ))}
        </select>
        <span className="lbl">動画</span>
        <select className="field" value={st.movieCh} onChange={(e) => useBga.setState({ movieCh: Number(e.target.value) })}>
          {BGA_CHANNELS.filter((b) => b.movie).map((b) => (
            <option key={b.ch} value={b.ch}>
              {b.name}（{b.ch.toString(16).toUpperCase().padStart(2, '0')}）
            </option>
          ))}
        </select>
      </div>
      <label className="row lbl" style={{ gap: 6 }}>
        <input type="checkbox" checked={st.show || hasBga(doc)} disabled={hasBga(doc)} onChange={(e) => useBga.setState({ show: e.target.checked })} />
        譜面の右に BGA の列を出す
      </label>
      <label className="row lbl" style={{ gap: 6, marginBottom: 6 }}>
        <input type="checkbox" checked={st.wide} onChange={(e) => useBga.setState({ wide: e.target.checked, show: true })} />
        列を広げて画像のサムネイルを出す
      </label>
      <p className="lbl" style={{ margin: '0 0 10px', lineHeight: 1.6 }}>
        下の一覧で素材を選び、譜面の BGA 列をクリックすると置けます。右クリックで消す、ドラッグで動かすのはドラムと同じです。
      </p>

      <div className="section-title">
        画像（#BMP）
        <span className="lbl mono">{bmps.length}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void add('bmp')} disabled={!folder}>
          {Icon.plus(12)} 登録
        </button>
      </div>
      <MaterialList list={bmps} />
      <div className="section-title" style={{ marginTop: 14 }}>
        動画（#AVI）
        <span className="lbl mono">{avis.length}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void add('avi')} disabled={!folder}>
          {Icon.plus(12)} 登録
        </button>
      </div>
      <MaterialList list={avis} />
    </>
  );
}

function MaterialList({ list }: { list: Material[] }) {
  const st = useBga();
  if (!list.length) return <p className="lbl">まだありません。</p>;
  return (
    <div className="mat-list">
      {list.map((m) => {
        const on = st.kind === m.kind && st.no === m.no;
        const missing = !materialFile(m.path);
        const img = m.kind === 'bmp' ? thumb(m.path) : null;
        return (
          <div key={m.key} className={`mat-row ${on ? 'on' : ''} ${missing ? 'missing' : ''}`} onClick={() => pickMaterial(m.kind, m.no)} title={missing ? 'ファイルが見つかりません' : `${m.uses} 個のチップで使用`}>
            <span className="mat-thumb">{img ? <img src={img.src} alt="" /> : m.kind === 'avi' ? '🎬' : '🖼'}</span>
            <span className="mono">{m.key.replace(/^(BMP|BMPTEX|AVI)/, (k) => (k === 'BMPTEX' ? 'TEX' : ''))}</span>
            <span className="grow" style={{ minWidth: 0 }}>
              <CommitInput className="mat-path" value={m.path} onCommit={(v) => setMaterialPath(m.key, v)} />
            </span>
            <span className="mono lbl">{m.uses}</span>
            <button
              className="ib tiny"
              title="登録を消す"
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
