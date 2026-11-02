import { sameMeasures } from '../assist/similar';
import { GHOST_LANE_INDEX } from '../assist/ghosts';
import type { BgmFilter } from '../audio/engine';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { fracToString } from '../dtx/fraction';
import { CH, DRUM_LANES, drumChannel } from '../dtx/model';
import {
  adoptGhosts,
  applySimilar,
  clearMuteSolo,
  clearSimilarPin,
  currentGhosts,
  ghostsInRange,
  GHOST_LANES,
  restoreGhosts,
  setBandFilter,
  setGhostLane,
  toggleMute,
  toggleSolo,
  useAssist,
} from '../store/assist';
import { docStats, tempoOf, wavPath, wavVel } from '../store/derived';
import { useInputSettings } from '../input/settings';
import { setSelectionVel, toggleVelMode, VEL_PRESET_NAMES } from '../store/velocity';
import { useState } from 'react';
import { deleteSelection, setMeasureLength, setKind, setMix, setSelectionWav, useEditor } from '../store/editor';
import { chipBpmLabel, meterLabel } from './format';
import { usePlayBeat } from './hooks';
import { visibleBeats } from './ChartCanvas';
import { Icon } from './icons';
import { ReferenceCard } from './ReferenceCard';

export function RightPanel() {
  return (
    <aside className="right-panel scroll">
      <ReferenceCard />
      <AssistCard />
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
            <VelRow chips={drums} />
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

/** 選んだチップの強さ（スライダーと強・中・弱） */
function VelRow({ chips }: { chips: { v: number }[] }) {
  const doc = useEditor((s) => s.doc);
  const presets = useInputSettings((s) => s.velPresets);
  const vals = chips.map((c) => wavVel(doc, c.v));
  const same = vals.every((x) => x === vals[0]);
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length));
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? avg;
  return (
    <>
      <span className="lbl">強さ</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="vel-row">
          <span className="mono" style={{ fontSize: 12 }}>
            {same || drag !== null ? shown : `~${avg}`}
          </span>
          <input
            type="range"
            min={1}
            max={100}
            value={shown}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={() => {
              if (drag !== null) setSelectionVel(drag);
              setDrag(null);
            }}
            onKeyUp={() => {
              if (drag !== null) setSelectionVel(drag);
              setDrag(null);
            }}
            aria-label="選んだチップの強さ"
          />
          <button className="ib" style={{ width: 26, height: 26 }} onClick={() => toggleVelMode(true)} title="強さの編集（V）" aria-label="強さの編集">
            {Icon.bars(14)}
          </button>
        </div>
        <div className="seg small" style={{ display: 'flex' }}>
          {VEL_PRESET_NAMES.map((name, i) => (
            <button key={name} style={{ flex: 1 }} className={same && vals[0] === presets[i] ? 'on' : ''} onClick={() => setSelectionVel(presets[i])}>
              {name} <span className="mono lbl">{presets[i]}</span>
            </button>
          ))}
        </div>
      </div>
    </>
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

const BANDS: [BgmFilter, string, string][] = [
  ['all', '全体', '原曲をそのまま'],
  ['low', '低域', 'キックが聴きやすい（〜160Hz）'],
  ['mid', '中域', 'スネア・タムが聴きやすい（200〜3500Hz）'],
  ['high', '高域', 'ハイハット・シンバルが聴きやすい（5000Hz〜）'],
];

function measureRange(from: number, to: number, tempo: ReturnType<typeof tempoOf>): string {
  const a = tempo.locate(from).m;
  const b = tempo.locate(Math.max(from, to - 1e-6)).m;
  return a === b ? toMeasure(a) : `${toMeasure(a)}–${toMeasure(b)}`;
}

function AssistCard() {
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.view.scrollBeat);
  useEditor((s) => s.view.pxPerBeat);
  const cursor = useEditor((s) => s.cursorBeat);
  usePlayBeat();
  const a = useAssist();
  const tempo = tempoOf(doc);
  const vis = visibleBeats();
  const inView = a.data && a.ghostsOn ? ghostsInRange(vis.from, vis.to) : [];
  const total = a.data && a.ghostsOn ? currentGhosts().length : 0;
  const cm = tempo.locate(Math.max(0, cursor)).m;
  const same = sameMeasures(doc, cm);
  const pin = a.similarPin;

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <span style={{ fontWeight: 700 }}>耳コピアシスト</span>
        <span className="grow" />
        <span className="lbl mono">{measureRange(vis.from, vis.to, tempo)} を表示中</span>
      </div>
      {a.status === 'loading' && (
        <div style={{ marginBottom: 10 }}>
          <div className="lbl" style={{ marginBottom: 4 }}>
            原曲を解析中… {Math.round(a.progress * 100)}%（{a.src?.name}）
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(a.progress * 100)}%` }} />
          </div>
        </div>
      )}
      {(a.status === 'nosource' || a.status === 'none') && (
        <div className="notice info" style={{ marginBottom: 10 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{Icon.info(14)}</span>
          <span>原曲（BGMチップ ch01）が鳴らせないため、波形と候補チップは出ません。曲フォルダを開くか、テンポ合わせ画面で原曲を選んでください。</span>
        </div>
      )}
      {a.status === 'error' && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{Icon.warn(14)}</span>
          <span>原曲を解析できませんでした: {a.error}</span>
        </div>
      )}
      <div className="ghost-box">
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={a.ghostsOn} onChange={(e) => useAssist.setState({ ghostsOn: e.target.checked })} />
            候補チップ
          </label>
          <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
            {inView.length}
          </span>
          <span className="lbl">件（全体 {total}）</span>
          <span className="grow" />
        </div>
        <div className="lbl">クリックで1つずつ採用、右クリックで捨てる。Enter でカーソルの小節をまとめて採用。</div>
        <div className="row">
          <button className="btn small primary grow" style={{ justifyContent: 'center' }} disabled={inView.length === 0} onClick={() => adoptGhosts(inView)}>
            表示中をすべて採用
          </button>
          <button className="btn small grow" style={{ justifyContent: 'center' }} disabled={a.dismissed.size === 0} onClick={restoreGhosts} title="捨てた候補を戻す">
            候補を戻す
          </button>
        </div>
        <label className="slider-row" title="上げると弱い音も拾います（誤検出も増えます）">
          <span className="lbl">検出の感度</span>
          <input type="range" min={0} max={1} step={0.05} value={a.sensitivity} onChange={(e) => useAssist.setState({ sensitivity: Number(e.target.value) })} />
          <span className="mono lbl">{Math.round(a.sensitivity * 100)}</span>
        </label>
        <div className="lane-toggles">
          {GHOST_LANES.map((g) => (
            <button
              key={g}
              className={`lane-toggle ${a.ghostLanes[g] ? 'on' : ''}`}
              style={{ ['--c' as string]: DRUM_LANES[GHOST_LANE_INDEX[g]].color }}
              onClick={() => setGhostLane(g, !a.ghostLanes[g])}
              title={`${DRUM_LANES[GHOST_LANE_INDEX[g]].name}の候補を${a.ghostLanes[g] ? '出さない' : '出す'}`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="lbl" style={{ marginBottom: 6 }}>
          原曲を聴く帯域
        </div>
        <div className="seg" style={{ display: 'flex' }}>
          {BANDS.map(([k, label, tip]) => (
            <button key={k} className={a.bandFilter === k ? 'on' : ''} style={{ flex: 1 }} title={tip} onClick={() => setBandFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {pin ? (
        <div className="similar-box pinned">
          <span style={{ fontSize: 12 }}>
            小節 <b className="mono">{toMeasure(pin.base)}</b> を直しました。直す前に同じだった小節:
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--amber)' }}>
            {pin.targets.map(toMeasure).join(' · ')}
          </span>
          <div className="row">
            <button className="btn small primary" onClick={() => applySimilar()}>
              {pin.targets.length} 小節にまとめて反映
            </button>
            <button className="btn small ghost" onClick={clearSimilarPin}>
              やめる
            </button>
          </div>
        </div>
      ) : same.length > 0 ? (
        <div className="similar-box">
          <span style={{ fontSize: 12 }}>
            <b className="mono">{toMeasure(cm)}</b> と同じパターンの小節（{same.length}）
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
            {same.slice(0, 16).map(toMeasure).join(' · ')}
            {same.length > 16 ? ' …' : ''}
          </span>
          <span className="lbl">この小節を直すと、ほかの小節にもまとめて反映できます。</span>
        </div>
      ) : null}
      <label className="row lbl" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={a.audioCols} onChange={(e) => useAssist.setState({ audioCols: e.target.checked })} />
        譜面の右に原曲の打点と波形を出す
      </label>
    </div>
  );
}

function MixCard() {
  const mix = useEditor((s) => s.mix);
  const previewOnPlace = useEditor((s) => s.previewOnPlace);
  const mute = useAssist((s) => s.mute);
  const solo = useAssist((s) => s.solo);
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
        <div className="row" style={{ marginTop: 6 }}>
          <span className="lbl">レーンごとに消す（M）・それだけ鳴らす（S）</span>
          <span className="grow" />
          {(mute.length > 0 || solo.length > 0) && (
            <button className="btn small ghost" style={{ height: 22 }} onClick={clearMuteSolo}>
              解除
            </button>
          )}
        </div>
        <div className="ms-grid">
          {DRUM_LANES.map((l, i) => (
            <div key={l.key} className="ms-cell">
              <span className="k" style={{ color: l.color }}>
                {l.key}
              </span>
              <span className="bs">
                <button className={`m ${mute.includes(i) ? 'on' : ''}`} onClick={() => toggleMute(i)} title={`${l.name}を消す`}>
                  M
                </button>
                <button className={`s ${solo.includes(i) ? 'on' : ''}`} onClick={() => toggleSolo(i)} title={`${l.name}だけ鳴らす`}>
                  S
                </button>
              </span>
            </div>
          ))}
        </div>
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
