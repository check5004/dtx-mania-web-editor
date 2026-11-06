// タブレットの入力パッド（キット 4×3・レーン）。押した瞬間に鳴らす。指が滑っても隣のパッドは鳴らさない（押した所だけ）
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLang } from '../../i18n/useLang';
import { tr } from '../../i18n';
import { DRUM_LANES } from '../../dtx/model';
import { useInputSettings } from '../../input/settings';
import { useAssist } from '../../store/assist';
import { tempoOf } from '../../store/derived';
import { setSheetSize, setTouchPrefs, useDevice, type PadLayout } from '../../store/device';
import { openSettings, useEditor } from '../../store/editor';
import { clearAtCursor, padDown, padModeOf, padUp, setPadMode, stepBack, stepRest, toggleRecording, type PadMode } from '../../store/pads';
import { useChartLanes } from '../ChartCanvas';
import { formatPosition } from '../format';
import { useBoxSize, useFold } from '../hooks';
import { padDensity } from '../../store/sheetSnap';
import { Icon } from '../icons';

/** キットの並びの1つ（"レーン:0|1"）を [レーン, Shift で置く物か] に */
export function kitSlot(k: string): [number, boolean] {
  const [l, a] = k.split(':');
  return [Number(l), a === '1'];
}

export function padKey(lane: number, alt: boolean): string {
  if (lane === 1) return alt ? 'HHO' : 'HHC';
  if (lane === 2 && alt) return 'LBD';
  return DRUM_LANES[lane].key;
}

export function padName(lane: number, alt: boolean): string {
  const d = DRUM_LANES[lane];
  return alt ? (d.altName ?? d.mainName) : d.mainName;
}

export function padColor(lane: number, alt: boolean): string {
  const d = DRUM_LANES[lane];
  return alt && d.altColor ? d.altColor : d.color;
}

/** キーボードの割り当て（レーン → 表示する文字） */
function useKeyLabels(): Map<number, string> {
  const keys = useInputSettings((s) => s.keys);
  const m = new Map<number, string>();
  for (const [code, lane] of Object.entries(keys)) {
    if (m.has(lane)) continue;
    m.set(lane, code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'N'));
  }
  return m;
}

/** 1つのパッド。押した瞬間に鳴らして色を変え、離したら戻す（何本の指で押しているかを数える） */
function Pad({ lane, alt, className = '', sub }: { lane: number; alt: boolean; className?: string; sub?: string }) {
  const [hit, setHit] = useState(false);
  const fingers = useRef(new Set<number>());
  const up = (id: number) => {
    if (!fingers.current.delete(id)) return;
    padUp();
    if (fingers.current.size === 0) setHit(false);
  };
  const color = padColor(lane, alt);
  return (
    <button
      type="button"
      className={`t-pad ${hit ? 'hit' : ''} ${className}`}
      style={{ ['--pad' as string]: color }}
      onPointerDown={(e) => {
        e.preventDefault();
        fingers.current.add(e.pointerId);
        setHit(true);
        padDown(lane, alt, e.timeStamp || performance.now());
      }}
      onPointerUp={(e) => up(e.pointerId)}
      onPointerCancel={(e) => up(e.pointerId)}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={padName(lane, alt)}
    >
      <span className="t-pad-key">
        <i style={{ background: color }} />
        {padKey(lane, alt)}
      </span>
      {sub !== undefined ? <span className="t-pad-sub">{sub}</span> : <span className="t-pad-name">{padName(lane, alt)}</span>}
    </button>
  );
}

function ModeSeg() {
  const mode = padModeOf(useAssist((s) => s.inputMode));
  const items: [PadMode, string][] = [
    ['aud', tr('試し打ち', 'Audition')],
    ['step', tr('ステップ', 'Step')],
    ['rec', tr('録音', 'Record')],
  ];
  return (
    <div className="seg t-seg t-mode-seg" role="radiogroup" aria-label={tr('パッドで入れるしかた', 'What the pads do')}>
      {items.map(([k, label]) => (
        <button key={k} role="radio" aria-checked={mode === k} className={`${mode === k ? 'on' : ''} ${k === 'rec' ? 'rec' : ''}`} onClick={() => setPadMode(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function LayoutSeg() {
  const layout = useDevice((s) => s.padLayout);
  const items: [PadLayout, string, React.ReactNode][] = [
    ['kit', tr('キット', 'Kit'), Icon.grid(16)],
    ['lane', tr('レーン', 'Lanes'), Icon.lanes(16)],
  ];
  return (
    <div className="seg t-seg t-layout-seg" role="radiogroup" aria-label={tr('パッドの並び', 'Pad layout')}>
      {items.map(([k, label, icon]) => (
        <button key={k} role="radio" aria-checked={layout === k} aria-label={label} className={layout === k ? 'on' : ''} onClick={() => setTouchPrefs({ padLayout: k })}>
          {icon}
          <span className="t-seg-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** ステップの ▶ の位置と、戻る・休み・消す */
function StepControls({ compact = false }: { compact?: boolean }) {
  const doc = useEditor((s) => s.doc);
  const cursor = useEditor((s) => s.cursorBeat);
  const tempo = tempoOf(doc);
  return (
    <div className={`t-step ${compact ? 'compact' : ''}`}>
      <span className="t-step-pos mono">
        <span className="t-step-tri">▶</span>
        {formatPosition(tempo, Math.max(0, cursor))}
      </span>
      <span className="grow" />
      <button className="t-ib boxed" onClick={stepBack} title={tr('1グリッド戻る', 'Back one grid step')} aria-label={tr('1グリッド戻る', 'Back one grid step')}>
        {Icon.arrowDown(18)}
      </button>
      <button className="t-ib boxed" onClick={stepRest} title={tr('休み（置かずに1グリッド進む）', 'Rest (move on one grid step without placing)')} aria-label={tr('休み', 'Rest')}>
        {Icon.arrowUp(18)}
      </button>
      <button className="t-ib boxed danger" onClick={clearAtCursor} title={tr('▶ の所のチップを消す', 'Delete the chips at ▶')} aria-label={tr('▶ の所のチップを消す', 'Delete the chips at ▶')}>
        {Icon.trash(18)}
      </button>
    </div>
  );
}

/** 入れ方ごとの説明と操作（ステップの位置・録音のボタン） */
function ModeBox({ layout }: { layout: 'panel' | 'side' }) {
  const mode = padModeOf(useAssist((s) => s.inputMode));
  const playing = useEditor((s) => s.playing);
  const overdub = useDevice((s) => s.recOverdub);
  const latency = useDevice((s) => s.padLatencyMs);
  if (mode === 'aud') {
    return (
      <div className={`t-modebox ${layout}`}>
        <p className="t-hint">{tr('押した瞬間に鳴らすだけです。譜面は変えません。', 'Just plays the sound the moment you press. The chart does not change.')}</p>
      </div>
    );
  }
  if (mode === 'step') {
    return (
      <div className={`t-modebox ${layout}`}>
        <StepControls compact={layout === 'side'} />
        <p className="t-hint">
          {tr('叩くと ▶ に置いて 1グリッド進みます。同時に押したパッドは同じ位置に置き、指を全部離したら進みます。', 'Tapping places a chip at ▶ and moves on one grid step. Pads pressed together go to the same spot; it moves on when all fingers are lifted.')}
        </p>
      </div>
    );
  }
  return (
    <div className={`t-modebox ${layout}`}>
      <button className={`t-rec-btn ${playing ? 'on' : ''}`} onClick={toggleRecording}>
        <span className="rec-dot" />
        {playing ? tr('録音を止める', 'Stop recording') : tr('録音を始める', 'Start recording')}
      </button>
      <label className="t-check">
        <input type="checkbox" checked={overdub} onChange={(e) => setTouchPrefs({ recOverdub: e.target.checked })} />
        <span>{tr('ループ中は重ねて録る', 'Overdub while looping')}</span>
      </label>
      <p className="t-hint">
        {tr(`グリッドに吸着。パッドの遅れの補正 ${latency} ms（`, `Snaps to the grid. Pad latency correction ${latency} ms (`)}
        <button className="link-btn" onClick={() => openSettings('pads')}>
          {tr('設定', 'Settings')}
        </button>
        {tr('）', ')')}
      </p>
    </div>
  );
}

/** キット 4×3（並びは設定の「入力パッド」で入れ替えられる） */
function KitGrid() {
  const order = useDevice((s) => s.kitOrder);
  return (
    <div className="t-kit">
      {order.map((k) => {
        const [lane, alt] = kitSlot(k);
        return <Pad key={k} lane={lane} alt={alt} />;
      })}
    </div>
  );
}

/** レーンの並び（譜面と同じ順）のパッド。HH・LP は上下に2つ（上が HHオープン・左バスドラム） */
function LaneGrid() {
  const order = useInputSettings((s) => s.laneOrder);
  const keys = useKeyLabels();
  return (
    <div className="t-lanegrid">
      {order.map((lane) => {
        const d = DRUM_LANES[lane];
        return (
          <div key={lane} className="t-lanegrid-col">
            {d.alt !== undefined && <Pad lane={lane} alt className="half" sub="Shift" />}
            <Pad lane={lane} alt={false} className={d.alt !== undefined ? 'half' : ''} sub={keys.get(lane) ?? ''} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * 縦のシート：譜面のレーンの真下に、同じ幅で並べる。
 * slim（シートが低い）：HH・LP を上下に割ると押せないほど小さくなるので、HHオープン・左バスドラムはレーンの右（入らなければ左）の空きに並べる
 */
function LaneStrip({ slim = false }: { slim?: boolean }) {
  const order = useInputSettings((s) => s.laneOrder);
  const keys = useKeyLabels();
  const geo = useChartLanes();
  const ref = useRef<HTMLDivElement>(null);
  const [left0, setLeft0] = useState(0);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setLeft0(r.left);
      setW(r.width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const laneW = geo ? geo.laneW : Math.floor(w / 10);
  const x0 = geo ? geo.left - left0 : 0;
  const right0 = x0 + order.length * laneW;
  // 細いとき：上下に割らずに、Shift で置く音（HHオープン・左バスドラム）を空いた所へ
  const alts = order.filter((lane) => DRUM_LANES[lane].alt !== undefined);
  const ALT_GAP = 6;
  const altW = (room: number) => Math.min(76, Math.floor((room - 8 - ALT_GAP * (alts.length - 1)) / Math.max(1, alts.length)));
  const roomR = w - right0;
  const roomL = x0;
  const side: 'right' | 'left' | null = !slim || alts.length === 0 ? null : altW(roomR) >= 44 ? 'right' : altW(roomL) >= 44 ? 'left' : null;
  const aw = side === 'right' ? altW(roomR) : side === 'left' ? altW(roomL) : 0;
  const altLeft = (i: number) => (side === 'right' ? right0 + 8 + i * (aw + ALT_GAP) : 8 + i * (aw + ALT_GAP));
  const split = (lane: number) => DRUM_LANES[lane].alt !== undefined && side === null;
  return (
    <div className={`t-lanestrip ${slim ? 'slim' : ''}`} ref={ref}>
      {(!geo || x0 > 90) && side !== 'left' ? (
        <span className="t-lanestrip-note">{tr('レーンのパッド', 'Lane pads')}</span>
      ) : null}
      {order.map((lane, slot) => {
        const style = { left: x0 + slot * laneW + 2, width: laneW - 4 };
        return (
          <div key={lane} className="t-lanestrip-col" style={style}>
            {split(lane) && <Pad lane={lane} alt className="half" sub="Shift" />}
            <Pad lane={lane} alt={false} className={split(lane) ? 'half' : ''} sub={keys.get(lane) ?? ''} />
          </div>
        );
      })}
      {side &&
        alts.map((lane, i) => (
          <div key={`alt-${lane}`} className="t-lanestrip-col alt" style={{ left: altLeft(i), width: aw }}>
            <Pad lane={lane} alt sub="Shift" />
          </div>
        ))}
      {geo && side !== 'right' && w - right0 > 70 ? (
        <span className="t-lanestrip-note right" style={{ left: right0 + 8 }}>
          {tr('叩くと ▶ に置く', 'Tap to place at ▶')}
        </span>
      ) : null}
    </div>
  );
}

/** 横のパネル：これより低ければパッドを低くする（キット 4×3 の 84 の段と説明がそのまま入る高さ） */
const PANEL_ROOMY_H = 500;

/** パッドのパネル。where: 横のパネル（360）か縦のシート */
/** パッドを初めて開いたか（設定の「パッドを叩いたとき（はじめ）」の入れ方にするのは、開いた最初の1回だけ） */
let padsOpened = false;

export function PadPanel({ where }: { where: 'panel' | 'sheet' }) {
  const layout = useDevice((s) => s.padLayout);
  const mode = padModeOf(useAssist((s) => s.inputMode));
  const box = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const { w, h } = useBoxSize(box);
  const lang = useLang();
  useEffect(() => {
    if (padsOpened) return;
    padsOpened = true;
    setPadMode(useDevice.getState().padStart);
  }, []);
  // パッドのパネルを開いたら、Space などのキーが入力欄に取られないように
  useEffect(() => {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && a.closest('.t-pads')) a.blur();
  }, [layout]);
  const density = padDensity(layout, w, h);
  // 見出しの行が入りきらなければ、並びの文字 → ▶ の位置の順に畳む
  const fold = useFold(row, where === 'sheet' ? 2 : 0, `${lang}|${mode}|${layout}|${density}`);
  if (where === 'panel') {
    // 横のパネルが低いとき（下のトラックを開いたなど）はパッドを低く
    const short = h > 0 && h < PANEL_ROOMY_H;
    return (
      <div className={`t-pads where-panel scroll ${short ? 'd-compact' : 'd-roomy'}`} ref={box}>
        <LayoutSeg />
        <ModeSeg />
        {layout === 'kit' ? <KitGrid /> : <LaneGrid />}
        <ModeBox layout="panel" />
      </div>
    );
  }
  // 入れ方の操作（ステップの位置・録音）は、右の説明の箱が無いときは見出しの行に
  const inRow = layout === 'lane' || density !== 'roomy';
  return (
    <div className={`t-pads where-sheet ${layout} d-${density}`} ref={box}>
      <div className={`t-pads-row ${fold > 0 ? `fold-${fold}` : ''}`} ref={row}>
        <ModeSeg />
        {inRow && mode === 'step' ? <StepControls /> : <span className="grow" />}
        {inRow && mode === 'rec' && <RecMini />}
        <LayoutSeg />
        {layout === 'lane' && (
          <button className="t-ib" onClick={() => setSheetSize('tabs')} title={tr('シートを閉じる', 'Close the sheet')} aria-label={tr('シートを閉じる', 'Close the sheet')}>
            {Icon.close(18)}
          </button>
        )}
      </div>
      {layout === 'lane' ? (
        <LaneStrip slim={density === 'row'} />
      ) : density === 'roomy' ? (
        <div className="t-pads-body">
          <KitGrid />
          <ModeBox layout="side" />
        </div>
      ) : (
        <KitGrid />
      )}
    </div>
  );
}

/** 縦のレーンのパッドの列に入れる、録音の小さなボタン */
function RecMini() {
  const playing = useEditor((s) => s.playing);
  return (
    <button className={`t-rec-btn mini ${playing ? 'on' : ''}`} onClick={toggleRecording}>
      <span className="rec-dot" />
      {playing ? tr('止める', 'Stop') : tr('録音', 'Record')}
    </button>
  );
}
