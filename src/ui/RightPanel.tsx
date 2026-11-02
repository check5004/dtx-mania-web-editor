import { toBase36x2, toMeasure } from '../dtx/base36';
import { fracToString } from '../dtx/fraction';
import { CH, DRUM_LANES, drumChannel } from '../dtx/model';
import { docStats, tempoOf, wavPath } from '../store/derived';
import { deleteSelection, setMeasureLength, setKind, setMix, setSelectionWav, useEditor } from '../store/editor';
import { chipBpmLabel, meterLabel } from './format';
import { usePlayBeat } from './hooks';
import { Icon } from './icons';

export function RightPanel() {
  return (
    <aside className="right-panel scroll">
      <SelectionCard />
      <MeasureCard />
      <MixCard />
      <StatsCard />
      <NoticeCard />
    </aside>
  );
}

function channelName(ch: number): string {
  const d = drumChannel(ch);
  if (d) return d.name;
  if (ch === CH.BGM) return 'BGM';
  if (ch === CH.BPM || ch === CH.BPM_EX) return 'BPM変化';
  return `SE（ch ${ch.toString(16).toUpperCase()}）`;
}

function SelectionCard() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const ids = new Set(selection);
  const chips = selection.length ? doc.chips.filter((c) => ids.has(c.id)) : [];
  const drums = chips.filter((c) => drumChannel(c.ch));
  const wavs = Object.keys(doc.fields)
    .filter((k) => /^WAV[0-9A-Z]{2}$/.test(k))
    .map((k) => parseInt(k.slice(3), 36))
    .sort((a, b) => a - b);

  if (chips.length === 0) {
    return (
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          操作のしかた
        </div>
        <div className="lbl" style={{ lineHeight: 1.9, color: 'var(--text3)' }}>
          <div>クリック … チップを置く</div>
          <div>
            <kbd>Shift</kbd>+クリック … HHオープン／左バスドラム
          </div>
          <div>右クリック（ドラッグ） … 消す</div>
          <div>空いた所をドラッグ … 範囲を選ぶ</div>
          <div>チップをドラッグ／<kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> … 動かす</div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>C</kbd>／<kbd>V</kbd> … コピー／カーソル位置に貼り付け
          </div>
          <div>左端の小節番号をクリック … カーソルを置く</div>
          <div>
            <kbd>Ctrl</kbd>+ホイール … ズーム、<kbd>[</kbd> <kbd>]</kbd> … グリッド
          </div>
        </div>
      </div>
    );
  }
  const one = chips.length === 1 ? chips[0] : null;
  const kinds = new Set(drums.map((c) => drumChannel(c.ch)!.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  const vset = new Set(drums.map((c) => c.v));
  const v = vset.size === 1 ? [...vset][0] : null;
  const color = one && drumChannel(one.ch) ? DRUM_LANES[drumChannel(one.ch)!.lane].color : 'var(--accent)';

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="dot" style={{ background: color, width: 10, height: 10 }} />
        <span style={{ fontWeight: 600 }}>{one ? channelName(one.ch) : `${chips.length} 個のチップ`}</span>
        {one && <span className="lbl mono">ch {one.ch.toString(16).toUpperCase().padStart(2, '0')}</span>}
        <span className="grow" />
        <button className="ib" style={{ width: 28, height: 28 }} onClick={deleteSelection} title="削除（Delete）">
          {Icon.trash(14)}
        </button>
      </div>
      <div className="form-grid">
        {one && (
          <>
            <span className="lbl">位置</span>
            <span className="mono">
              小節 {toMeasure(one.m)} · {fracToString(one.f)}
            </span>
          </>
        )}
        {drums.length > 0 && (
          <>
            <span className="lbl">WAV</span>
            <select className="field mono" style={{ height: 28, fontSize: 12 }} value={v ?? ''} onChange={(e) => setSelectionWav(Number(e.target.value))}>
              {v === null && <option value="">（いろいろ）</option>}
              {v !== null && doc.fields['WAV' + toBase36x2(v)] === undefined && <option value={v}>{toBase36x2(v)}（未定義）</option>}
              {wavs.map((n) => (
                <option key={n} value={n}>
                  {toBase36x2(n)} {wavPath(doc, n)}
                </option>
              ))}
            </select>
            <span className="lbl">種類</span>
            <div className="seg">
              {(
                [
                  ['normal', '通常'],
                  ['hidden', '不可視'],
                  ['nochip', '音だけ'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} title={k === 'hidden' ? '叩く必要はあるが見えないチップ' : k === 'nochip' ? '空打ちしたときに鳴る音（チップは出ない）' : ''}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        {one && (one.ch === CH.BPM || one.ch === CH.BPM_EX) && (
          <>
            <span className="lbl">BPM</span>
            <span className="mono">{chipBpmLabel(tempoOf(doc).bpmAt(tempoOf(doc).beatOf(one.m, one.f)))}</span>
          </>
        )}
      </div>
    </div>
  );
}

const METERS: [string, number][] = [
  ['4/4', 1],
  ['3/4', 0.75],
  ['2/4', 0.5],
  ['5/4', 1.25],
  ['6/4', 1.5],
  ['7/8', 0.875],
  ['6/8', 0.75],
  ['5/8', 0.625],
];

function MeasureCard() {
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const { m } = tempo.locate(Math.max(0, beat));
  const cur = tempo.barLen(m);
  const own = doc.barLengths[m];
  const apply = (len: number) => setMeasureLength(m, len);
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        小節 <span className="mono">{toMeasure(m)}</span>
        <span className="lbl">（カーソル位置）</span>
      </div>
      <div className="form-grid">
        <span className="lbl">拍子</span>
        <select className="field mono" style={{ height: 28 }} value={METERS.find(([, v]) => v === cur)?.[0] ?? 'other'} onChange={(e) => {
          const hit = METERS.find(([k]) => k === e.target.value);
          if (hit) apply(hit[1]);
        }}>
          {!METERS.some(([, v]) => v === cur) && <option value="other">{meterLabel(cur)}</option>}
          {METERS.map(([k]) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="lbl">BPM</span>
        <span className="mono">{chipBpmLabel(tempo.bpmAt(tempo.measureStart(m)))}</span>
      </div>
      <p className="lbl" style={{ margin: '8px 0 0' }}>
        {own !== undefined ? `この小節で長さを ${own} に変えています（#${toMeasure(m)}02）。` : '拍子を変えると、この小節だけが変わります（次の小節は元に戻します）。'}
      </p>
    </div>
  );
}

function MixCard() {
  const mix = useEditor((s) => s.mix);
  const previewOnPlace = useEditor((s) => s.previewOnPlace);
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        ミックス
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="slider-row">
          <span className="lbl">原曲</span>
          <input type="range" min={0} max={1} step={0.01} value={mix.bgm} onChange={(e) => setMix({ bgm: Number(e.target.value) })} />
          <span className="mono lbl">{Math.round(mix.bgm * 100)}</span>
        </label>
        <label className="slider-row">
          <span className="lbl">ドラム</span>
          <input type="range" min={0} max={1} step={0.01} value={mix.drums} onChange={(e) => setMix({ drums: Number(e.target.value) })} />
          <span className="mono lbl">{Math.round(mix.drums * 100)}</span>
        </label>
        <label className="row lbl" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={mix.metronome} onChange={(e) => setMix({ metronome: e.target.checked })} />
          再生中にメトロノームを鳴らす
        </label>
        <label className="row lbl">
          <input type="checkbox" checked={previewOnPlace} onChange={(e) => useEditor.setState({ previewOnPlace: e.target.checked })} />
          チップを置いたときに音を鳴らす
        </label>
      </div>
    </div>
  );
}

function StatsCard() {
  const doc = useEditor((s) => s.doc);
  const st = docStats(doc);
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        レーン別のノーツ
        <span className="grow" />
        <span className="mono lbl">合計 {st.notes}</span>
      </div>
      <div className="stat-grid">
        {DRUM_LANES.map((l, i) => (
          <div key={l.key} className="stat-cell">
            <small style={{ color: l.color }}>{l.key}</small>
            {st.perLane[i]}
          </div>
        ))}
      </div>
    </div>
  );
}

function NoticeCard() {
  const meta = useEditor((s) => s.meta);
  const missing = useEditor((s) => s.missingWavs);
  const doc = useEditor((s) => s.doc);
  const folder = useEditor((s) => s.folder);
  const items: { level: 'warn' | 'info'; text: string }[] = [];
  if (meta.encodingNote) items.push({ level: 'warn', text: meta.encodingNote });
  if (meta.hasRandom) items.push({ level: 'info', text: '#RANDOM/#IF の分岐があります。分岐の中のチップは表示・編集できませんが、保存してもそのまま残ります。' });
  if (!folder) items.push({ level: 'info', text: '曲フォルダを開いていないため、原曲や曲フォルダの音は鳴りません。チップの音は内蔵キットで鳴ります。' });
  if (missing.length > 0) {
    const names = missing.slice(0, 6).map((n) => `${toBase36x2(n)} ${wavPath(doc, n) ?? ''}`);
    items.push({ level: 'warn', text: `見つからない・読めない音が ${missing.length} 個あります: ${names.join('、')}${missing.length > 6 ? ' …' : ''}（MP3以外の形式やファイル名を確認してください）` });
  }
  for (const w of meta.warnings.slice(0, 6)) items.push({ level: 'warn', text: `${w.line}行目: ${w.message}` });
  if (meta.warnings.length > 6) items.push({ level: 'warn', text: `ほかに ${meta.warnings.length - 6} 件の注意があります` });
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it, i) => (
        <div key={i} className={`notice ${it.level === 'info' ? 'info' : ''}`}>
          <span style={{ flex: 'none', marginTop: 1 }}>{it.level === 'info' ? Icon.info(14) : Icon.warn(14)}</span>
          <span>{it.text}</span>
        </div>
      ))}
    </div>
  );
}
