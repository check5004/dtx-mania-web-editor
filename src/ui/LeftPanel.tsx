import { useEffect, useState } from 'react';
import { KIT_SOUNDS, kitByChannel } from '../audio/kit';
import { toBase36x2 } from '../dtx/base36';
import { DRUM_LANES } from '../dtx/model';
import { serializeHeader } from '../dtx/serialize';
import { freeWavNumber, setField } from '../edit/ops';
import { audioFiles, findFile } from '../fs/folder';
import { wavPan, wavVolume } from '../store/derived';
import { edit, prepareSounds, previewWav, setFieldValue, setLaneWav, useEditor, type LeftTab } from '../store/editor';
import { chooseDialog } from './dialogs';
import { formatLevel } from './format';
import { Icon } from './icons';

const TABS: [LeftTab, string][] = [
  ['kit', 'キット'],
  ['wav', 'WAV'],
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

/** 内蔵キットの音を WAV に登録して、そのレーンの音にする */
function useKitSound(ch: number) {
  const kit = kitByChannel.get(ch);
  if (!kit) return;
  let no = -1;
  edit(`${kit.label}に内蔵キットの音を使う`, (d) => {
    for (const [k, v] of Object.entries(d.fields)) {
      if (/^WAV[0-9A-Z]{2}$/.test(k) && v.toLowerCase() === kit.file.toLowerCase()) no = parseInt(k.slice(3), 36);
    }
    if (no < 0) {
      no = freeWavNumber(d) ?? 1;
      setField(d, 'WAV' + toBase36x2(no), kit.file);
    }
  });
  if (no < 0) {
    // 変化が無かった（すでに登録済み）
    const f = Object.entries(useEditor.getState().doc.fields).find(([k, v]) => /^WAV/.test(k) && v.toLowerCase() === kit.file.toLowerCase());
    if (f) no = parseInt(f[0].slice(3), 36);
  }
  if (no > 0) setLaneWav(ch, no);
  void prepareSounds();
}

function KitTab() {
  const fields = useEditor((s) => s.doc.fields);
  const laneWav = useEditor((s) => s.laneWav);
  const wavs = wavList(fields);
  const rows = DRUM_LANES.flatMap((l) => [
    { ch: l.main, name: l.mainName, color: l.color, key: l.key },
    ...(l.alt !== undefined ? [{ ch: l.alt, name: l.altName!, color: l.altColor ?? l.color, key: `${l.key}*` }] : []),
  ]);
  return (
    <>
      <div className="section-title">レーンに置く音</div>
      <p className="lbl" style={{ margin: 0 }}>
        譜面をクリックして置くチップの音です。曲フォルダに音が無いレーンは、内蔵キットの音を使い、保存するときにWAVファイルとして曲フォルダに書き出します。
      </p>
      {rows.map((r) => {
        const no = laneWav[r.ch];
        const valid = no !== undefined && fields['WAV' + toBase36x2(no)] !== undefined;
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
              onChange={(e) => {
                if (e.target.value === 'kit') useKitSound(r.ch);
                else setLaneWav(r.ch, Number(e.target.value));
              }}
            >
              <option value="kit">内蔵キット</option>
              {wavs.map((w) => (
                <option key={w.no} value={w.no}>
                  {toBase36x2(w.no)} {w.path}
                </option>
              ))}
            </select>
            <button
              className="ib"
              style={{ width: 26, height: 26 }}
              title="試聴"
              onClick={() => {
                if (valid) previewWav(no!);
                else useKitSound(r.ch);
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
                <td className="mono">{z}</td>
                <td>
                  <CommitInput value={w.path} onCommit={(v) => setFieldValue('WAV' + z, v || undefined)} />
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
function CommitInput({ value, onCommit, className, placeholder }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string }) {
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
      <div className="section-title">曲情報</div>
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
  return (
    <>
      <div className="section-title">ヘッダ</div>
      <p className="lbl" style={{ margin: 0 }}>
        エディタが解釈しない行（#RANDOM や BGA、ギター・ベースのチップなど）も、そのまま保存します。
      </p>
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
      <div className="section-title">ファイル</div>
      <div className="form-grid">
        <span className="lbl">ファイル名</span>
        <span className="mono">{meta.fileName}</span>
        <span className="lbl">読み込み</span>
        <span>{meta.encoding === 'shift_jis' ? 'Shift_JIS' : meta.encoding === 'utf-8-bom' ? 'UTF-8（BOM付き）' : 'UTF-8（BOMなし）'}</span>
        <span className="lbl">保存</span>
        <span>Shift_JIS・CRLF</span>
        <span className="lbl">内蔵キット</span>
        <span className="lbl">{KIT_SOUNDS.length} 音（dtxweb_kit_*.wav）</span>
      </div>
    </>
  );
}
