// 譜面の縦スクロール表示と、マウスでの編集。下から上へ時間が進む（NXと同じ向き）。
// 右に「原曲の打点」（ドラムの採譜モデルの5種。使えないときは低・中・高の3帯域）と「原曲の波形」の列を出す。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Onset } from '../audio/analysis';
import { engine } from '../audio/engine';
import { SPEC_F_HI, SPEC_F_LO, specFreq, specPos, type SpectroData } from '../audio/spectro';
import { sameMeasures } from '../assist/similar';
import { toMeasure } from '../dtx/base36';
import { sub, type Frac } from '../dtx/fraction';
import { bgaChannel, CH, DRUM_LANES, drumChannel, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { posToBeatFrac, snapToGrid, type Pos } from '../edit/ops';
import {
  bandOnsets,
  beginLoopDrag,
  dragLoop,
  endLoopDrag,
  loopGrab,
  setBandFilter,
  setLoop,
  setWaveMode,
  useAssist,
  LOOP_DIV,
  type AssistState,
  type LoopDrag,
} from '../store/assist';
import { bgmSource, COL_BGA, COL_BGM, COL_BPM, chipViews, docStats, tempoOf, viewsInRange, wavVel, type ChipView } from '../store/derived';
import {
  autoEndMeasure,
  deleteChips,
  dragSongEnd,
  minSongEnd,
  moveSelection,
  openPage,
  placeBpmChange,
  placeChip,
  playFrom,
  resetSongEnd,
  setCursorBeat,
  setView,
  songEndReason,
  useEditor,
  zoom,
} from '../store/editor';
import { fixBpm, fixStart, fixStemLag, fmtMs, offsetBadge, offsetReport, stemLag, stemLagWarn, useOffset, STEM_LAG_LIMIT } from '../store/offset';
import { chooseAnalysisStem } from '../store/stems';
import { sectionAt, sectionColor, useSidecar } from '../store/sidecar';
import { applyVel, nudgeSelection, useVel, weakVel } from '../store/velocity';
import { laneAt, shiftLane, slotOf, useInputSettings } from '../input/settings';
import { useFind } from '../store/find';
import { usePhrase } from '../store/phrase';
import { doubtKey, setGhostRevealer, useComplete, visibleGhost, type Ghost } from '../store/complete';
import { CompleteBadge, type GhostAnchor } from './CompleteBadge';
import { genView, openMeasureGen, toggleGenKeep, toggleGenNote, useMeasureGen, type GenView } from '../store/measureGen';
import { noteId } from '../edit/merge';
import { GenBadge } from './GenBadge';
import { gotoNextIssue, issuesOf, useCheck, type Issue } from '../store/check';
import { bgaChipLabel, bgaVisible, materials, placeBga, useBga } from '../store/bga';
import { thumb, useThumbs } from './thumbs';
import { drumHitsByClass, drumStatusText, readyDrums, useDrums } from '../store/drums';
import { DRUM_CLASSES, CLASS_LABEL, type DrumClass } from '../bench/classes';
import { ADTOF } from '../transcribe/model';
import type { OffsetReport } from '../assist/offsetCheck';
import { promptDialog } from './dialogs';
import { songEndM, songSpan } from './hooks';
import { chipBpmLabel, formatTime, meterLabel } from './format';
import { SectionPopover } from './SectionPopover';
import { SPEC_ZONES, zoneLut, type SpecZone } from './specColors';
import { pickBgmFile } from '../app/fileActions';

export const GEO = {
  head: 30,
  bottom: 28,
  /** ループの帯（いちばん左。ドラッグでループの範囲） */
  loopW: 14,
  /** 小節の生成の ✨ の列（ループの帯の右。小節線ごとにボタン） */
  genW: 18,
  gutterW: 36,
  bpmX: 68,
  bpmW: 44,
  laneX: 116,
  laneW: 40,
  bgmX: 520,
  bgmW: 28,
  hitsX: 552,
  hitsW: 64,
  waveX: 620,
  waveW: 108,
  miniW: 86,
  /** 全体図の左のループの帯 */
  miniLoopW: 13,
  /** ベロシティのレーン（ベロシティの編集モード） */
  velGap: 10,
  velW: 84,
};

const BASE_W = GEO.bgmX + GEO.bgmW;

/** 小節番号の列の左端（✨ の列の右） */
const GUT_X = GEO.loopW + GEO.genW;
/** ✨ のボタンの中心（譜面の左端から）と、小節線からの当たりの幅 */
const GEN_CX = GEO.loopW + GEO.genW / 2;
const GEN_HIT = 9;

/** スペクトルを出すときの列の最大幅（画面に余裕があれば広げる） */
const SPEC_W_MAX = 196;

/** 原曲の波形・スペクトルの列の幅 */
function waveColW(): number {
  if (useAssist.getState().waveMode !== 'spec') return GEO.waveW;
  const v = useVel.getState();
  const vel = v.mode ? GEO.velGap + v.lanes.length * GEO.velW : 0;
  const room = viewport.w - GEO.miniW - 24 - GEO.waveX - vel;
  return Math.max(GEO.waveW, Math.min(SPEC_W_MAX, Math.floor(room)));
}

/** 原曲の列まで含めた幅 */
function fullW(): number {
  return GEO.waveX + waveColW();
}

const C = {
  bg: '#0B0E13',
  laneA: '#0E1217',
  laneB: '#10141A',
  col: '#0C1015',
  sep: '#1A2029',
  measure: '#3A4452',
  beat: '#252C37',
  grid: '#161B22',
  text: '#8B95A4',
  dim: '#5F6978',
  accent: '#4CC2FF',
  amber: '#FFC768',
  playhead: '#FFB547',
  bgm: '#5BD69A',
  se: '#7E8EA3',
  wave: '#5D7189',
  low: '#B9A6F2',
  mid: '#FFD54F',
  high: '#7FD3F9',
  loop: '#FFC768',
};

/** 「原曲の打点」の5種の色（帯域の色とそろえる：BD=低、SD=中、HH=高） */
const DRUM_COL: Record<DrumClass, string> = { BD: '#B9A6F2', SD: '#FFD54F', TT: '#7BD88F', HH: '#7FD3F9', CY: '#FF8FB3' };

/** 「原曲の打点」の列の中の小さな列（採譜モデルなら5種、無ければ3帯域）。x は列の左端から */
function hitLanes(model: boolean): { n: number; w: number; x: (i: number) => number } {
  const n = model ? DRUM_CLASSES.length : 3;
  const w = Math.floor((GEO.hitsW - 4) / n);
  return { n, w, x: (i) => 2 + i * w };
}

type Drag =
  | { type: 'pending'; x0: number; y0: number; lane: number; alt: boolean; pos: Pos; weak: boolean; bga?: boolean }
  | { type: 'rubber'; x0: number; y0: number; x1: number; y1: number; additive: boolean; base: number[] }
  | { type: 'velPencil'; idx: number; group: string; lastY: number }
  | { type: 'velLine'; idx: number; y0: number; v0: number; y1: number; v1: number }
  | { type: 'move'; anchor: ChipView; anchorBeat: Frac; grab: number; x0: number; dBeat: Frac | null; dLane: number; moved: boolean; clickedSelected: boolean }
  | { type: 'erase'; ids: Set<number> }
  | { type: 'cursor' }
  | { type: 'loop'; ld: LoopDrag; y0: number; where: 'chart' | 'mini' }
  | { type: 'mini' }
  /** 曲の終わり（END）の線。grab: 掴んだ所と線の差（拍） */
  | { type: 'end'; group: string; grab: number };

interface Hover {
  x: number;
  y: number;
  lane: number;
  pos: Pos | null;
  alt: boolean;
  /** 小節番号の列・波形の上：クリックで再生を始める位置（拍） */
  start?: number;
  /** ✨ の上：生成する小節 */
  gen?: number;
}

/** 譜面の上に出す説明（警告の中身・操作のヒント） */
interface Tip {
  key: string;
  x: number;
  y: number;
  level: 'error' | 'warn' | 'hint';
  title: string;
  lines: string[];
  /** 操作のヒントでも待たずに出す（ドラッグ中の位置など） */
  now?: boolean;
}

interface Local {
  w: number;
  h: number;
  dpr: number;
  dirty: boolean;
  drag: Drag | null;
  hover: Hover | null;
  followScroll: number | null;
  mini: { canvas: HTMLCanvasElement; doc: unknown; h: number; endBeat: number; sections: unknown } | null;
  spec: SpecTiles | null;
  pointer: { x: number; y: number } | null;
}

/** 右のパネルから「表示中の範囲」を知るための値 */
const viewport = { h: 600, w: 1000, follow: null as number | null };

/** 譜面で見えている拍の範囲 */
/** TAB補完の点線（小節 from から len 小節）が見えていなければ、見える所までスクロールする */
function revealMeasures(from: number, len: number) {
  const s = useEditor.getState();
  const tm = tempoOf(s.doc);
  const b0 = tm.measureStart(from);
  const b1 = tm.measureStart(from + len);
  const vis = visibleBeats();
  // 札の分（上に 40px ほど）も空ける
  const pad = 44 / s.view.pxPerBeat;
  if (b0 >= vis.from && b1 + pad <= vis.to) return;
  const span = vis.to - vis.from;
  // 点線が下から 3割の所から始まるように（長くて入らなければ点線の頭を見せる）
  setView({ scrollBeat: Math.max(-1, b1 - b0 + pad > span * 0.7 ? b0 - span * 0.1 : b0 - span * 0.3), follow: false });
}
setGhostRevealer(revealMeasures);

export function visibleBeats(): { from: number; to: number } {
  const s = useEditor.getState();
  const scroll = engine.playing && viewport.follow !== null ? viewport.follow : s.view.scrollBeat;
  return { from: Math.max(0, scroll), to: Math.max(0, scroll + (viewport.h - GEO.head - GEO.bottom) / s.view.pxPerBeat) };
}

/** BGA 列の左端（譜面の左端から）。原曲の列の右に置く */
const BGA_GAP = 6;
function coreWidth(): number {
  return useAssist.getState().audioCols ? fullW() : BASE_W;
}
function bgaW(): number {
  return useBga.getState().wide ? 92 : 46;
}
/** 幅が足りないときは、原曲の波形の列の右側に重ねて出す */
function bgaX(): number {
  const room = viewport.w - GEO.miniW - 16 - bgaW();
  return Math.max(BASE_W + BGA_GAP, Math.min(coreWidth() + BGA_GAP, room));
}

function baseWidth(): number {
  return bgaVisible() ? Math.max(coreWidth(), bgaX() + bgaW()) : coreWidth();
}

function chartWidth(): number {
  const v = useVel.getState();
  return baseWidth() + (v.mode ? GEO.velGap + v.lanes.length * GEO.velW : 0);
}

/** ベロシティのレーン i の左端（譜面の左端から） */
function velLaneX(i: number): number {
  return baseWidth() + GEO.velGap + i * GEO.velW;
}

const VEL_PAD = 6;
const velBarW = () => GEO.velW - VEL_PAD - 24;

function velFromX(rx: number, i: number): number {
  return Math.max(1, Math.min(100, Math.round(((rx - velLaneX(i) - VEL_PAD) / velBarW()) * 100)));
}

export function ChartCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const L = useRef<Local>({ w: 0, h: 0, dpr: 1, dirty: true, drag: null, hover: null, followScroll: null, mini: null, spec: null, pointer: null });
  const [popover, setPopover] = useState<{ m: number; x: number; y: number } | null>(null);
  const [help, setHelp] = useState<{ x: number; y: number } | null>(null);
  const [tip, setTipState] = useState<Tip | null>(null);
  const tipRef = useRef<{ key: string | null; timer: number; next: Tip | null }>({ key: null, timer: 0, next: null });
  /** 説明を出す。警告はすぐ、操作のヒントは少し止まってから。同じ説明なら位置と中身だけ変える */
  const showTip = (t: Tip | null) => {
    const r = tipRef.current;
    r.next = t;
    if ((t?.key ?? null) === r.key) {
      if (t) setTipState((cur) => (cur && cur.key === t.key ? t : cur));
      return;
    }
    r.key = t?.key ?? null;
    window.clearTimeout(r.timer);
    if (!t) {
      setTipState(null);
      return;
    }
    if (t.level === 'hint' && !t.now) {
      setTipState(null);
      r.timer = window.setTimeout(() => setTipState(r.next), 650);
    } else {
      setTipState(t);
    }
  };
  const inputMode = useAssist((s) => s.inputMode);
  const playing = useEditor((s) => s.playing);
  const div = useEditor((s) => s.view.div);
  /** 譜面の枠の大きさが変わった回数（TAB補完の札の位置を直すため） */
  const [sized, setSized] = useState(0);
  /** TAB補完の点線の、画面の上での位置 */
  const ghostAnchor = (from: number, len: number): GhostAnchor => {
    const l = L.current;
    const s = useEditor.getState();
    const g = geom(l, currentScroll(l), s.view.pxPerBeat);
    const tm = tempoOf(s.doc);
    return {
      left: g.ox + GEO.laneX,
      top: g.beatToY(tm.measureStart(from + len)),
      bottom: g.beatToY(tm.measureStart(from)),
      minY: GEO.head,
      maxY: l.h - GEO.bottom,
      w: l.w,
      h: l.h,
    };
  };

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const l = L.current;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      l.dpr = window.devicePixelRatio || 1;
      l.w = Math.max(1, Math.floor(r.width));
      l.h = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(l.w * l.dpr);
      canvas.height = Math.floor(l.h * l.dpr);
      canvas.style.width = `${l.w}px`;
      canvas.style.height = `${l.h}px`;
      viewport.h = l.h;
      viewport.w = l.w;
      l.mini = null;
      l.dirty = true;
      setSized((n) => n + 1);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const unsubs = [
      useEditor.subscribe(() => {
        l.dirty = true;
      }),
      useAssist.subscribe(() => {
        l.dirty = true;
      }),
      useSidecar.subscribe(() => {
        l.dirty = true;
      }),
      useInputSettings.subscribe(() => {
        l.dirty = true;
        l.mini = null;
      }),
      useFind.subscribe(() => {
        l.dirty = true;
      }),
      useBga.subscribe(() => {
        l.dirty = true;
      }),
      useCheck.subscribe(() => {
        l.dirty = true;
      }),
      useThumbs.subscribe(() => {
        l.dirty = true;
      }),
      usePhrase.subscribe(() => {
        l.dirty = true;
      }),
      useComplete.subscribe(() => {
        l.dirty = true;
      }),
      useMeasureGen.subscribe(() => {
        l.dirty = true;
      }),
      useDrums.subscribe(() => {
        l.dirty = true;
      }),
      useOffset.subscribe(() => {
        l.dirty = true;
      }),
    ];

    const unsubVel = useVel.subscribe(() => {
      l.dirty = true;
      l.mini = null;
    });
    unsubs.push(unsubVel);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const playing = engine.playing;
      if (!playing && l.followScroll !== null) {
        // 止めても表示は止めた所のまま（再生位置は ▶ に戻るが、聴いていた所をすぐ直せるように）
        setView({ scrollBeat: l.followScroll });
        l.followScroll = null;
      }
      autoScrollWhileDragging(l);
      if (!l.dirty && !playing) return;
      l.dirty = false;
      draw(ctx, l);
    };
    raf = requestAnimationFrame(loop);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = useEditor.getState();
      const g = geom(l, s.view.scrollBeat, s.view.pxPerBeat);
      if (e.altKey) {
        // Alt+ホイール：選んだチップのベロシティ（Shift で1ずつ）。ベロシティのレーンの上なら、そのチップ
        const h = hitTest(l, g, e.offsetX, e.offsetY);
        const step = e.shiftKey ? 1 : 5;
        const dir = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
        if (h?.kind === 'velChip' && !s.selection.includes(h.view.c.id)) {
          useEditor.setState({ selection: [h.view.c.id] });
        }
        nudgeSelection(dir * step);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const beat = g.yToBeat(e.offsetY);
        zoom(Math.exp(-e.deltaY * 0.0022), beat, l.h - GEO.bottom - e.offsetY);
        return;
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * l.h : e.deltaY;
      const base = engine.playing && l.followScroll !== null ? l.followScroll : s.view.scrollBeat;
      l.followScroll = null;
      setView({ scrollBeat: Math.max(-2, base - dy / s.view.pxPerBeat), follow: false });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubs.forEach((u) => u());
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const local = () => L.current;

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = local();
    const s = useEditor.getState();
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const g = geom(l, currentScroll(l), s.view.pxPerBeat);
    const h = hitTest(l, g, x, y);
    setPopover(null);
    setHelp(null);
    showTip(null);
    if (!h) return;
    // 見出しのボタン
    if (h.kind === 'header') {
      const rx = x - g.ox;
      if (useAssist.getState().audioCols && rx >= GEO.hitsX && rx < GEO.hitsX + GEO.hitsW) {
        setHelp({ x: g.ox + GEO.hitsX, y: GEO.head + 4 });
        return;
      }
      if (useAssist.getState().audioCols && rx >= GEO.waveX && rx < GEO.waveX + waveColW()) {
        const a = useAssist.getState();
        // スペクトルの帯域の見出し：その帯域だけ聴く（もう一度で全体）
        const z = a.waveMode === 'spec' && y >= SPEC_ZONE_Y ? specZoneAt(rx - GEO.waveX) : null;
        if (z) {
          setBandFilter(a.bandFilter === z.listen ? 'all' : z.listen);
          return;
        }
        setWaveMode(a.waveMode === 'wave' ? 'spec' : 'wave');
        return;
      }
    }
    if (h.kind === 'section') {
      setPopover({ m: h.m, x: g.ox + GEO.bpmX + 4, y: Math.max(GEO.head + 4, y - 10) });
      return;
    }
    // ✨：小節の生成（Shift で範囲を広げる）
    if (h.kind === 'genBtn') {
      if (e.button === 0) openMeasureGen(h.m, { extend: e.shiftKey });
      return;
    }
    // 生成の案：点線をクリックで外す・戻す、消えるチップ（赤い ×）をクリックで残す
    {
      const gv = e.button === 0 && !e.ctrlKey && !e.metaKey ? genView() : null;
      const t = gv ? genTargetAt(g, h, x, y, gv) : null;
      if (t?.kind === 'note') {
        toggleGenNote(t.id);
        return;
      }
      if (t?.kind === 'keep') {
        toggleGenKeep(t.chipId);
        return;
      }
    }
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    l.pointer = { x, y };
    if (h.kind === 'vel' || h.kind === 'velChip') {
      if (e.button !== 0) return;
      const tool = useVel.getState().tool;
      if (tool === 'pencil') {
        const group = `vel-pencil-${Date.now()}`;
        l.drag = { type: 'velPencil', idx: h.idx, group, lastY: y };
        pencilApply(l, g, h.idx, y, y, x, group);
        return;
      }
      if (tool === 'line') {
        const val = velFromX(x - g.ox, h.idx);
        l.drag = { type: 'velLine', idx: h.idx, y0: y, v0: val, y1: y, v1: val };
        return;
      }
      if (h.kind === 'velChip') {
        const id = h.view.c.id;
        const already = s.selection.includes(id);
        if (e.ctrlKey || e.metaKey) useEditor.setState({ selection: already ? s.selection.filter((i) => i !== id) : [...s.selection, id] });
        else if (e.shiftKey) useEditor.setState({ selection: already ? s.selection : [...s.selection, id] });
        else useEditor.setState({ selection: [id] });
        return;
      }
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      l.drag = { type: 'rubber', x0: x, y0: y, x1: x, y1: y, additive, base: additive ? s.selection : [] };
      return;
    }
    if (h.kind === 'end') {
      // 曲の終わり（END）の札：ドラッグで動かす（Undo 1回で戻せるように、ドラッグ中の変更はまとめる）
      if (e.button !== 0) return;
      const eb = endBeatOf(s.doc);
      l.drag = { type: 'end', group: `song-end-${Date.now()}`, grab: eb === null ? 0 : g.yToBeat(y) - eb };
      return;
    }
    if (e.button === 2) {
      if (h.kind === 'loop' || h.kind === 'miniLoop') {
        setLoop(null);
        return;
      }
      if (h.kind === 'chip') {
        l.drag = { type: 'erase', ids: new Set([h.view.c.id]) };
        l.dirty = true;
      }
      return;
    }
    if (e.button !== 0) return;
    if (h.kind === 'mini') {
      l.drag = { type: 'mini' };
      scrollFromMini(l, y);
      return;
    }
    if (h.kind === 'loop' || h.kind === 'miniLoop') {
      const at = loopBandAt(l, g, h.kind, y);
      l.drag = { type: 'loop', ld: beginLoopDrag(at.beat, at.tol, at.tab), y0: y, where: h.kind === 'loop' ? 'chart' : 'mini' };
      return;
    }
    if (h.kind === 'audio' && !useAssist.getState().data && (useAssist.getState().status === 'nosource' || useAssist.getState().status === 'none')) {
      // 原曲がまだ無い：波形の列をクリックで読み込む
      pickBgmFile();
      return;
    }
    if (h.kind === 'gutter' || h.kind === 'header' || h.kind === 'audio') {
      const tempo = tempoOf(s.doc);
      const beat = Math.max(0, g.yToBeat(y));
      const p = snapToGrid(tempo, beat, s.view.div);
      const b = tempo.beatOf(p.m, p.f);
      if (e.shiftKey && h.kind === 'gutter') {
        // Shift+ドラッグでもループの範囲を作れる（以前の操作）
        l.drag = { type: 'loop', ld: { mode: 'new', origin: b, a0: b, b0: b, moved: false }, y0: y, where: 'chart' };
        return;
      }
      l.drag = { type: 'cursor' };
      setCursorBeat(b);
      return;
    }
    if (h.kind === 'chip') {
      const id = h.view.c.id;
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      const already = s.selection.includes(id);
      if (e.ctrlKey || e.metaKey) {
        useEditor.setState({ selection: already ? s.selection.filter((i) => i !== id) : [...s.selection, id] });
        if (already) return;
      } else if (!already) {
        useEditor.setState({ selection: additive ? [...s.selection, id] : [id] });
      }
      const tempo = tempoOf(s.doc);
      l.drag = {
        type: 'move',
        anchor: h.view,
        anchorBeat: tempo.beatOfFrac(h.view.c.m, h.view.c.f),
        grab: g.yToBeat(y) - h.view.beat,
        x0: x,
        dBeat: null,
        dLane: 0,
        moved: false,
        clickedSelected: already && !additive,
      };
      return;
    }
    if (h.kind === 'lane' || h.kind === 'bgm' || h.kind === 'bpm' || h.kind === 'bga') {
      const beat = Math.max(0, g.yToBeat(y));
      const pos = snapToGrid(tempoOf(s.doc), beat, s.view.div);
      l.drag = { type: 'pending', x0: x, y0: y, lane: h.kind === 'lane' ? h.lane : -1, alt: e.shiftKey, pos, weak: e.altKey, bga: h.kind === 'bga' };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = local();
    const s = useEditor.getState();
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    l.pointer = { x, y };
    const g = geom(l, currentScroll(l), s.view.pxPerBeat);
    const d = l.drag;
    l.dirty = true;
    if (!d) {
      const h = hitTest(l, g, x, y);
      if (h && h.kind === 'lane') {
        const pos = snapToGrid(tempoOf(s.doc), Math.max(0, g.yToBeat(y)), s.view.div);
        l.hover = { x, y, lane: h.lane, pos, alt: e.shiftKey };
      } else if (h && (h.kind === 'gutter' || h.kind === 'audio')) {
        const tempo = tempoOf(s.doc);
        const p = snapToGrid(tempo, Math.max(0, g.yToBeat(y)), s.view.div);
        l.hover = { x, y, lane: -1, pos: null, alt: false, start: tempo.beatOf(p.m, p.f) };
      } else if (h && h.kind === 'genBtn') {
        l.hover = { x, y, lane: -1, pos: null, alt: false, gen: h.m };
      } else {
        l.hover = h && h.kind !== 'mini' && h.kind !== 'miniLoop' && h.kind !== 'vel' && h.kind !== 'velChip' ? { x, y, lane: -1, pos: null, alt: false } : null;
      }
      showTip(tipFor(l, g, h, x, y));
      const tool = useVel.getState().tool;
      const gv = genView();
      const onGen = gv ? genTargetAt(g, h, x, y, gv) : null;
      if (onGen && l.hover) l.hover = { ...l.hover, pos: null };
      const cur = onGen || h?.kind === 'genBtn'
        ? 'pointer'
        : h?.kind === 'vel' || h?.kind === 'velChip'
          ? tool === 'pencil' || tool === 'line'
            ? 'crosshair'
            : h.kind === 'velChip'
              ? 'pointer'
              : 'default'
          : h?.kind === 'chip'
          ? 'grab'
          : h?.kind === 'end'
          ? 'ns-resize'
          : h?.kind === 'section'
            ? 'pointer'
            : h?.kind === 'loop' || h?.kind === 'miniLoop'
              ? loopCursor(l, g, h.kind, y)
              : h?.kind === 'gutter' || h?.kind === 'audio'
                ? 'pointer'
                : h?.kind === 'mini'
                  ? 'ns-resize'
                  : h?.kind === 'header' && x - g.ox >= GEO.hitsX
                    ? 'pointer'
                    : 'default';
      canvasRef.current!.style.cursor = cur;
      return;
    }
    if (d.type === 'pending') {
      if (Math.hypot(x - d.x0, y - d.y0) > 4) {
        const additive = e.ctrlKey || e.metaKey || e.shiftKey;
        l.drag = { type: 'rubber', x0: d.x0, y0: d.y0, x1: x, y1: y, additive, base: additive ? s.selection : [] };
      }
      return;
    }
    if (d.type === 'rubber') {
      d.x1 = x;
      d.y1 = y;
      return;
    }
    if (d.type === 'velPencil') {
      pencilApply(l, g, d.idx, d.lastY, y, x, d.group);
      d.lastY = y;
      return;
    }
    if (d.type === 'velLine') {
      d.y1 = y;
      d.v1 = velFromX(x - g.ox, d.idx);
      return;
    }
    if (d.type === 'erase') {
      const h = hitTest(l, g, x, y);
      if (h?.kind === 'chip') d.ids.add(h.view.c.id);
      return;
    }
    if (d.type === 'cursor') {
      const tempo = tempoOf(s.doc);
      const p = snapToGrid(tempo, Math.max(0, g.yToBeat(y)), s.view.div);
      setCursorBeat(tempo.beatOf(p.m, p.f));
      return;
    }
    if (d.type === 'loop') {
      const beat = d.where === 'chart' ? Math.max(0, g.yToBeat(y)) : miniGeom(l).beatAt(y);
      dragLoop(d.ld, beat, LOOP_DIV, Math.abs(y - d.y0) > 3);
      return;
    }
    if (d.type === 'mini') {
      scrollFromMini(l, y);
      return;
    }
    if (d.type === 'end') {
      dragSongEnd(Math.max(0, g.yToBeat(y) - d.grab), d.group);
      showTip(endTip(x, y, true));
      return;
    }
    if (d.type === 'move') {
      const tempo = tempoOf(s.doc);
      const target = snapToGrid(tempo, Math.max(0, g.yToBeat(y) - d.grab), s.view.div);
      d.dBeat = sub(posToBeatFrac(tempo, target), d.anchorBeat);
      d.dLane = d.anchor.col >= 0 ? Math.round((x - d.x0) / GEO.laneW) : 0;
      if (d.dBeat.n !== 0 || d.dLane !== 0) d.moved = true;
      canvasRef.current!.style.cursor = 'grabbing';
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = local();
    const d = l.drag;
    l.drag = null;
    l.dirty = true;
    if (!d) return;
    const s = useEditor.getState();
    if (d.type === 'pending') {
      if (d.lane >= 0) placeChip(d.lane, d.alt, d.pos, d.weak ? weakVel() : undefined);
      else if (d.bga) placeBga(d.pos);
      else useEditor.setState({ selection: [] });
      return;
    }
    if (d.type === 'velPencil') return;
    if (d.type === 'velLine') {
      const g = geom(l, currentScroll(l), s.view.pxPerBeat);
      const lane = useVel.getState().lanes[d.idx];
      const bA = g.yToBeat(d.y0);
      const bB = g.yToBeat(d.y1);
      const lo = Math.min(bA, bB);
      const hi = Math.max(bA, bB);
      const span = hi - lo;
      const views = viewsInRange(chipViews(s.doc), lo - 1e-6, hi + 1e-6).filter((v) => v.col === lane && v.kind === 'normal');
      if (views.length === 0) return;
      const at = new Map(views.map((v) => [v.c.id, v.beat]));
      applyVel(
        `直線でベロシティを変える（${d.v0}→${d.v1}）`,
        [...at.keys()],
        (_cur, c) => {
          if (span < 1e-6) return d.v1;
          const t = ((at.get(c.id) ?? lo) - bA) / (bB - bA);
          return d.v0 + (d.v1 - d.v0) * Math.max(0, Math.min(1, t));
        },
      );
      return;
    }
    if (d.type === 'rubber') {
      const g = geom(l, currentScroll(l), s.view.pxPerBeat);
      const ids = chipsInRect(l, g, d.x0, d.y0, d.x1, d.y1);
      useEditor.setState({ selection: [...new Set([...d.base, ...ids])] });
      return;
    }
    if (d.type === 'erase') {
      deleteChips([...d.ids]);
      return;
    }
    if (d.type === 'cursor') {
      if (engine.playing) void playFrom(s.cursorBeat);
      return;
    }
    if (d.type === 'loop') {
      endLoopDrag(d.ld);
      return;
    }
    if (d.type === 'end') {
      showTip(null);
      return;
    }
    if (d.type === 'move') {
      if (d.moved && d.dBeat) {
        moveSelection(d.dBeat, d.dLane);
      } else if (d.clickedSelected && !(e.ctrlKey || e.metaKey)) {
        useEditor.setState({ selection: [d.anchor.c.id] });
      }
      canvasRef.current!.style.cursor = 'grab';
    }
  };

  const onDoubleClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const l = local();
    const s = useEditor.getState();
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const g = geom(l, currentScroll(l), s.view.pxPerBeat);
    const h = hitTest(l, g, x, y);
    if (h?.kind === 'end') {
      // END の札のダブルクリック：決めた終わりをやめて、原曲の鳴り終わりに合わせる
      showTip(null);
      resetSongEnd();
      return;
    }
    if (h?.kind === 'gutter') {
      // 小節番号のダブルクリック：その小節からセクションを始める（カーソルと同じく吸着した位置の小節）
      const { m } = snapToGrid(tempoOf(s.doc), Math.max(0, g.yToBeat(y)), s.view.div);
      setPopover({ m, x: g.ox + GEO.bpmX + 4, y: Math.max(GEO.head + 4, y - 10) });
      return;
    }
    if (h?.kind === 'audio') {
      // 波形のダブルクリック：そこから再生
      const tempo = tempoOf(s.doc);
      const p = snapToGrid(tempo, Math.max(0, g.yToBeat(y)), s.view.div);
      void playFrom(tempo.beatOf(p.m, p.f));
      return;
    }
    if (h?.kind !== 'bpm') return;
    const tempo = tempoOf(s.doc);
    const pos = snapToGrid(tempo, Math.max(0, g.yToBeat(y)), s.view.div);
    const cur = tempo.bpmAt(tempo.beatOf(pos.m, pos.f));
    const v = await promptDialog({
      title: `小節 ${toMeasure(pos.m)} にBPM変化を置く`,
      body: 'この位置からのBPMを入力してください（#BPMzz と ch08 で書き出します）。',
      value: String(Math.round(cur * 100) / 100),
      ok: '置く',
    });
    const bpm = v ? Number(v) : NaN;
    if (Number.isFinite(bpm) && bpm > 0) placeBpmChange(pos, bpm);
  };

  return (
    <div ref={wrapRef} className="chart-wrap">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          L.current.drag = null;
          L.current.dirty = true;
        }}
        onPointerLeave={() => {
          L.current.hover = null;
          L.current.dirty = true;
          showTip(null);
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="譜面"
      />
      {inputMode === 'rec' && (
        <div className={`rec-badge ${playing ? 'on' : ''}`}>
          <span className="rec-dot" />
          {playing ? '録音中' : '録音の待機中（再生すると記録）'} · {`1/${div}`}に吸着 · ループ毎に重ね録り
        </div>
      )}
      {inputMode === 'key' && <div className="rec-badge key">キー入力: カーソル位置に置く（↑↓で移動）</div>}
      <CompleteBadge anchor={ghostAnchor} sized={sized} />
      <GenBadge anchor={ghostAnchor} sized={sized} />
      {popover && <SectionPopover m={popover.m} x={popover.x} y={popover.y} onClose={() => setPopover(null)} />}
      {tip && !popover && <ChartTip tip={tip} />}
      <IssueBadge />
      {help && <OnsetHelp x={help.x} y={help.y} onClose={() => setHelp(null)} />}
    </div>
  );
}

/** 「原曲の打点」の見出しの ⓘ：何を出しているかの説明 */
function OnsetHelp({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const dr = useDrums();
  const model = dr.enabled && dr.status === 'ready';
  return (
    <div className="popover" style={{ left: x - 200, top: y, width: 300 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ marginBottom: 6 }}>
        <b>{model ? '原曲の打点（ドラムの採譜）' : '原曲の打点（低・中・高）'}</b>
        <span className="grow" />
        <button className="ib" style={{ width: 24, height: 24 }} onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      {model ? (
        <>
          <OffsetSection onClose={onClose} />
          <p className="lbl" style={{ margin: '0 0 6px', lineHeight: 1.7, color: 'var(--text2)' }}>
            ドラムの採譜モデルが原曲から聞き取った打点です。横棒が打点（幅は確からしさ）、薄い帯は「その音が鳴っていそうな度合い」です。
          </p>
          <div className="lbl" style={{ lineHeight: 1.8 }}>
            {DRUM_CLASSES.map((k) => (
              <div key={k}>
                <b className="mono" style={{ color: DRUM_COL[k] }}>
                  {k}
                </b>
                <span style={{ marginLeft: 8 }}>{CLASS_LABEL[k]}</span>
              </div>
            ))}
          </div>
          <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.7 }}>
            {ONSET_ACCURACY}右のパネルの「打点の感度」で増やしたり減らしたりできます。
          </p>
          <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.6, fontSize: 10.5 }}>
            モデル: {ADTOF.credit}・{ADTOF.license}（非商用）。音はこのブラウザの中だけで解析します。
          </p>
        </>
      ) : (
        <>
          <p className="lbl" style={{ margin: '0 0 6px', lineHeight: 1.7, color: 'var(--text2)' }}>
            原曲を3つの音域に分けて、音が鳴り始めた強さを横棒で出します。太いほど強い打点です。
          </p>
          <div className="lbl" style={{ lineHeight: 1.8 }}>
            <div>
              <b style={{ color: C.low }}>低</b>　だいたいキック（BD）
            </div>
            <div>
              <b style={{ color: C.mid }}>中</b>　だいたいスネア・タム
            </div>
            <div>
              <b style={{ color: C.high }}>高</b>　だいたいハイハット・シンバル
            </div>
          </div>
          <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.7 }}>
            {dr.enabled
              ? dr.status === 'loading' || dr.status === 'error'
                ? `${drumStatusText(dr)}。採譜が終わると、ドラムの5種（BD・SD・タム・HH・シンバル）の打点に切り替わります。`
                : '原曲が読み込まれると、ドラムの採譜モデルで5種の打点に切り替わります。'
              : 'ドラムの採譜モデルは右のパネルで切ってあります。入れると、ドラムの5種の打点に切り替わります（こちらより正確）。'}
          </p>
          <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.7 }}>
            波形だけでは埋もれて見えない音を探す目印です。「原曲の波形」の見出しをクリックするとスペクトログラムに切り替わります。
          </p>
        </>
      )}
    </div>
  );
}

/** ずれの見立ての1行（見出しのヒント・説明の段） */
function offsetSummary(r: OffsetReport): string {
  const n = r.pairs.length;
  if (r.verdict === 'start') {
    return `原曲の打点が、譜面のチップより ${Math.abs(Math.round(r.offset * 1000))}ms ${r.offset > 0 ? '後ろ' : '前'}にあります（${n} 打で測定。頭 ${fmtMs(r.head)}・終わり ${fmtMs(r.tail)}）。曲のどこでも同じだけずれているので、開始位置のずれです。`;
  }
  if (r.verdict === 'bpm' && r.bpmFit) {
    return `原曲の打点が、曲の後ろほど${r.tail > r.head ? '遅れて' : '早まって'}いきます（頭 ${fmtMs(r.head)} → 終わり ${fmtMs(r.tail)}、${n} 打で測定）。BPM が少し違います（${r.bpmFit.from} → ${r.bpmFit.bpm}）。`;
  }
  if (r.verdict === 'uneven') {
    return `場所によってずれ方が違います（${fmtMs(r.lo)}〜${fmtMs(r.hi)}、${n} 打で測定）。テンポが揺れている曲かもしれません。テンポ合わせで、ずれている所の小節の頭を合わせてください。`;
  }
  if (r.verdict === 'ok') return `譜面のチップと原曲の打点は合っています（${fmtMs(r.offset)}、${n} 打で測定）。`;
  if (r.chips < 16) return 'チップがまだ少ないため、ずれは測れません。チップを置いていくと測ります。';
  return `譜面のチップ ${r.chips} 個のうち、原曲の打点と組にできたのが ${n} 個だけなので、ずれは測れません（ドラムの入っていない原曲のときなど）。`;
}

/** ステムのずれの説明 */
function stemLagText(lag: number, name: string): string {
  return `解析元のステム（${name}）が、原曲より ${Math.abs(Math.round(lag * 1000))}ms ${lag > 0 ? '遅れて' : '早まって'}います。分離ソフトが MP3 の頭の無音を足したまま書き出したときなどに起こります。`;
}

/** 「原曲の打点」の ⓘ の上の段：譜面のチップとのずれと、直すボタン（打点がステムからなら、ステムと原曲のずれも） */
function OffsetSection({ onClose }: { onClose: () => void }) {
  useEditor((s) => s.doc);
  useAssist((s) => s.sensitivity);
  useOffset((s) => s.rev);
  useOffset((s) => s.stemLag);
  const dr = useDrums();
  const r = offsetReport();
  if (!r) return null;
  const fromStem = dr.key?.startsWith('stem:') ?? false;
  const sl = fromStem ? stemLag() : null;
  const slWarn = sl && sl.status === 'done' && sl.lag !== null && Math.abs(sl.lag) >= STEM_LAG_LIMIT ? sl.lag : null;
  const warn = r.verdict === 'start' || r.verdict === 'bpm' || r.verdict === 'uneven';
  const bgm = bgmSource(useEditor.getState().doc);
  const canOrig = fromStem && !sl && !!bgm && !!engine.buffer(bgm.wav);
  const box = (on: boolean): CSSProperties => ({
    margin: '0 0 8px',
    padding: '8px 10px',
    borderRadius: 8,
    background: on ? 'var(--amber-bg)' : 'var(--raise)',
    border: on ? '1px solid var(--amber-line)' : '1px solid transparent',
  });
  return (
    <>
      {sl && (
        <div style={box(slWarn !== null)}>
          <div className="row" style={{ marginBottom: 4 }}>
            <b style={{ fontSize: 12 }}>ステムと原曲のずれ</b>
            <span className="grow" />
            {sl.status === 'done' && sl.lag !== null && slWarn === null && <span className="pill ok">合っています</span>}
            {slWarn !== null && <span className="pill warn">{fmtMs(slWarn)}</span>}
          </div>
          <p className="lbl" style={{ margin: 0, lineHeight: 1.7, color: 'var(--text2)' }}>
            {sl.status === 'running'
              ? `解析元のステム（${sl.name}）と原曲の音を重ねて、ずれを測っています…`
              : sl.lag === null
                ? `解析元のステム（${sl.name}）と原曲は、重なる音が少なく、ずれを測れませんでした（原曲にその楽器が入っていないときなど）。`
                : slWarn !== null
                  ? stemLagText(slWarn, sl.name)
                  : `解析元のステム（${sl.name}）は原曲と合っています（${fmtMs(sl.lag)}）。`}
          </p>
          {slWarn !== null && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn small primary" onClick={() => fixStemLag()} title="ステムの「頭のずれ」を変えて原曲に合わせます（ステムとミックスの画面でも変えられます）">
                ステムの頭のずれを {fmtMs(-slWarn)} 直す
              </button>
            </div>
          )}
        </div>
      )}
      <div style={box(warn && slWarn === null)}>
        <div className="row" style={{ marginBottom: 4 }}>
          <b style={{ fontSize: 12 }}>譜面とのずれ</b>
          <span className="grow" />
          {slWarn === null && r.verdict === 'ok' && <span className="pill ok">合っています</span>}
          {slWarn === null && warn && <span className="pill warn">{r.verdict === 'bpm' ? 'BPM' : fmtMs(r.offset)}</span>}
        </div>
        <p className="lbl" style={{ margin: 0, lineHeight: 1.7, color: 'var(--text2)' }}>
          {slWarn !== null && r.verdict !== 'few'
            ? `ステムの打点はチップより ${fmtMs(r.offset)} ずれていますが、そのうち ${fmtMs(slWarn)} はステムのずれです。原曲と比べた譜面のずれは ${fmtMs(r.offset - slWarn)} です。ステムを直すと採譜し直して、もう一度測ります。`
            : offsetSummary(r)}
        </p>
        {slWarn === null && warn && (
          <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
            {r.verdict === 'start' && (
              <button className="btn small primary" onClick={() => fixStart()} title="原曲（BGM のチップ）を動かして、譜面のグリッドを原曲に合わせます。テンポ合わせの「開始位置」を動かすのと同じです">
                開始位置を {fmtMs(r.offset)} 直す
              </button>
            )}
            {r.verdict === 'bpm' && r.bpmFit && (
              <button className="btn small primary" onClick={() => fixBpm()} title="BPM を直し、原曲（BGM のチップ）の位置も合わせます。チップは同じ拍の位置のままです">
                BPM を {r.bpmFit.bpm} にして合わせる
              </button>
            )}
            {r.verdict === 'uneven' && (
              <button
                className="btn small"
                onClick={() => {
                  onClose();
                  openPage('tempo');
                }}
              >
                テンポ合わせを開く
              </button>
            )}
            {r.verdict === 'uneven' && Math.abs(r.offset) >= 0.012 && (
              <button className="link-btn" onClick={() => fixStart()} title="曲全体のずれの中央値の分だけ、開始位置を動かします">
                平均の {fmtMs(r.offset)} だけ直す
              </button>
            )}
          </div>
        )}
        {canOrig && (
          <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.6, fontSize: 10.5 }}>
            ステム（{dr.name}）の打点で測っています。
            <button
              className="link-btn"
              style={{ fontSize: 10.5 }}
              onClick={() => {
                onClose();
                chooseAnalysisStem(null);
              }}
              title="解析元（◉）を原曲にして、原曲から採譜し直します"
            >
              原曲で測る
            </button>
          </p>
        )}
      </div>
    </>
  );
}

/** 精度テスト（docs/bench.md）で測った当たり具合 */
const ONSET_ACCURACY =
  '精度テストでは、本物のドラムの録音入りの曲で、拾った打点の約7割が譜面と同じ位置にあり、譜面の打点の約3分の2を拾えました（BD・SD はよく当たり、タム・シンバルは取りこぼしや取り違えが多め。ハイハットはペダルの小さな音を拾えないことがあります）。';

/** TAB補完の点線（範囲の枠と、点線のチップ。原曲でその音が聞こえないチップはオレンジの枠） */
function drawGhost(ctx: CanvasRenderingContext2D, g: Geom, gh: Ghost, tm: TempoMap) {
  const left = g.ox + GEO.laneX;
  const w = GEO.laneW * DRUM_LANES.length;
  const yb = g.beatToY(tm.measureStart(gh.from));
  const yt = g.beatToY(tm.measureStart(gh.from + gh.measures.length));
  ctx.fillStyle = 'rgba(76,194,255,.05)';
  ctx.fillRect(left, yt, w, yb - yt);
  ctx.strokeStyle = 'rgba(76,194,255,.5)';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, yt + 0.5, w - 1, yb - yt - 1);
  ctx.setLineDash([]);
  gh.measures.forEach((notes, i) => {
    const m = gh.from + i;
    for (const n of notes) {
      const info = drumChannel(n.ch);
      if (!info) continue;
      const beat = tm.beatOf(m, n.f);
      if (beat < g.minBeat - 0.5 || beat > g.maxBeat + 0.5) continue;
      const y = g.beatToY(beat);
      const cx = g.ox + laneCX(info.lane);
      const lane = DRUM_LANES[info.lane];
      const color = info.alt && lane.altColor ? lane.altColor : lane.color;
      roundRect(ctx, cx - 17, y - 5, 34, 10, 3);
      ctx.fillStyle = color + (info.kind === 'normal' ? '38' : '12');
      ctx.fill();
      ctx.setLineDash(info.kind === 'normal' ? [3, 2] : [1, 2]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (info.alt) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, y, 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
      if (gh.doubt.has(doubtKey(m, n))) {
        // 原曲でこの音が聞こえない（外れのことが多い）
        roundRect(ctx, cx - 20, y - 8, 40, 16, 5);
        ctx.strokeStyle = '#FF9F43';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }
  });
}

/** 4つの角の星（✨ の形） */
function sparkPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + r * 0.18, cy - r * 0.18, cx + r, cy);
  ctx.quadraticCurveTo(cx + r * 0.18, cy + r * 0.18, cx, cy + r);
  ctx.quadraticCurveTo(cx - r * 0.18, cy + r * 0.18, cx - r, cy);
  ctx.quadraticCurveTo(cx - r * 0.18, cy - r * 0.18, cx, cy - r);
  ctx.closePath();
}

/** 小節線ごとの ✨（押すとその線から上の小節を生成）。詰まって見えるほど縮めたときは、指している所だけ */
function drawGenButtons(ctx: CanvasRenderingContext2D, g: Geom, tempo: TempoMap, firstM: number, lastM: number, H: number, hoverM: number | undefined) {
  const gs = useMeasureGen.getState();
  const cx = g.ox + GEN_CX;
  for (let m = firstM; m <= lastM + 1 && m < 3600; m++) {
    const y = g.beatToY(tempo.measureStart(m));
    if (y < GEO.head + 7 || y > H - 2) continue;
    const active = gs.open && m >= gs.from && m <= gs.to;
    const hover = hoverM === m;
    const tall = y - g.beatToY(tempo.measureStart(m + 1)) >= 22;
    if (!tall && !hover && !active) continue;
    roundRect(ctx, cx - 7.5, y - 7.5, 15, 15, 4);
    ctx.fillStyle = active ? '#FFC768' : hover ? 'rgba(255,199,104,.22)' : '#121820';
    ctx.fill();
    ctx.strokeStyle = active || hover ? '#FFC768' : 'rgba(255,199,104,.32)';
    ctx.lineWidth = 1;
    ctx.stroke();
    sparkPath(ctx, cx, y, 4.6);
    ctx.fillStyle = active ? '#1A1305' : hover ? '#FFD891' : 'rgba(255,199,104,.6)';
    ctx.fill();
  }
}

/** 生成する範囲の枠（案がまだ無いときも） */
function drawGenRange(ctx: CanvasRenderingContext2D, g: Geom, tm: TempoMap) {
  const gs = useMeasureGen.getState();
  const left = g.ox + GEO.laneX;
  const w = GEO.laneW * DRUM_LANES.length;
  const yb = g.beatToY(tm.measureStart(gs.from));
  const yt = g.beatToY(tm.measureStart(gs.to + 1));
  ctx.fillStyle = 'rgba(255,199,104,.045)';
  ctx.fillRect(left, yt, w, yb - yt);
  ctx.strokeStyle = 'rgba(255,199,104,.6)';
  ctx.setLineDash([5, 3]);
  ctx.lineWidth = 1.2;
  ctx.strokeRect(left + 0.5, yt + 0.5, w - 1, yb - yt - 1);
  ctx.setLineDash([]);
}

/**
 * 小節の生成の案：足すチップは点線（原曲で聞こえない BD・SD・TT はオレンジの枠）、外したチップは薄い点線、
 * 消えるチップには赤い ×、置き換えでも残すチップには緑の枠
 */
function drawGenPreview(ctx: CanvasRenderingContext2D, g: Geom, gv: GenView, tm: TempoMap, views: readonly ChipView[]) {
  drawGenRange(ctx, g, tm);
  const at = (n: { ch: number; m: number; f: Frac }) => {
    const info = drumChannel(n.ch);
    if (!info) return null;
    const beat = tm.beatOf(n.m, n.f);
    if (beat < g.minBeat - 0.5 || beat > g.maxBeat + 0.5) return null;
    const lane = DRUM_LANES[info.lane];
    return { info, y: g.beatToY(beat), cx: g.ox + laneCX(info.lane), color: info.alt && lane.altColor ? lane.altColor : lane.color };
  };
  // 外したチップ（クリックで戻せる）
  for (const sk of gv.plan.skipped) {
    if (sk.why !== 'rejected') continue;
    const p = at(sk.note);
    if (!p) continue;
    roundRect(ctx, p.cx - 17, p.y - 5, 34, 10, 3);
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  // 足すチップ
  for (const n of gv.plan.add) {
    const p = at(n);
    if (!p) continue;
    roundRect(ctx, p.cx - 17, p.y - 5, 34, 10, 3);
    ctx.fillStyle = p.color + '44';
    ctx.fill();
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
    if (p.info.alt) {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.cx, p.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (gv.doubt.has(doubtKey(n.m, n))) {
      roundRect(ctx, p.cx - 20, p.y - 8, 40, 16, 5);
      ctx.strokeStyle = '#FF9F43';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
  }
  // 消えるチップと、残すチップ
  if (gv.plan.remove.length === 0 && gv.kept.size === 0) return;
  const rm = new Set(gv.plan.remove);
  for (const v of views) {
    if (v.col < 0 || (!rm.has(v.c.id) && !gv.kept.has(v.c.id))) continue;
    if (v.beat < g.minBeat - 0.5 || v.beat > g.maxBeat + 0.5) continue;
    const y = g.beatToY(v.beat);
    const cx = g.ox + laneCX(v.col);
    if (rm.has(v.c.id)) {
      ctx.strokeStyle = '#FF5A61';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 5, y - 4.5);
      ctx.lineTo(cx + 5, y + 4.5);
      ctx.moveTo(cx + 5, y - 4.5);
      ctx.lineTo(cx - 5, y + 4.5);
      ctx.stroke();
    } else {
      roundRect(ctx, cx - 19, y - 7, 38, 14, 4);
      ctx.strokeStyle = '#5BD69A';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }
}

// ---- 座標 ---------------------------------------------------------------------

interface Geom {
  ox: number;
  px: number;
  scroll: number;
  beatToY: (b: number) => number;
  yToBeat: (y: number) => number;
  minBeat: number;
  maxBeat: number;
}

function currentScroll(l: Local): number {
  return l.followScroll ?? useEditor.getState().view.scrollBeat;
}

/** 再生位置を追いかけるとき、再生位置の線を置く高さ（譜面の下から、見えている高さの割合） */
const FOLLOW_AT = 0.22;

function geom(l: Local, scroll: number, px: number): Geom {
  const ox = Math.max(8, Math.floor((l.w - GEO.miniW - chartWidth()) / 2));
  const base = l.h - GEO.bottom;
  return {
    ox,
    px,
    scroll,
    beatToY: (b) => base - (b - scroll) * px,
    yToBeat: (y) => scroll + (base - y) / px,
    minBeat: scroll - GEO.bottom / px,
    maxBeat: scroll + (base - GEO.head) / px,
  };
}

type Hit =
  | { kind: 'chip'; view: ChipView }
  | { kind: 'lane'; lane: number }
  | { kind: 'gutter' }
  | { kind: 'genBtn'; m: number }
  | { kind: 'section'; m: number }
  | { kind: 'bpm' }
  | { kind: 'bgm' }
  | { kind: 'bga' }
  | { kind: 'audio' }
  | { kind: 'header' }
  | { kind: 'loop' }
  | { kind: 'mini' }
  | { kind: 'miniLoop' }
  | { kind: 'vel'; idx: number; lane: number }
  | { kind: 'velChip'; idx: number; lane: number; view: ChipView }
  /** 曲の終わり（END）の札 */
  | { kind: 'end' };

function colAt(g: Geom, x: number): number | 'gutter' | 'gen' | 'audio' | 'loop' | null {
  const rx = x - g.ox;
  if (rx < 0) return null;
  if (rx < GEO.loopW) return 'loop';
  if (rx < GUT_X) return 'gen';
  if (rx < GEO.bpmX) return 'gutter';
  if (rx < GEO.laneX) return COL_BPM;
  if (rx < GEO.laneX + GEO.laneW * 10) return laneAt(Math.floor((rx - GEO.laneX) / GEO.laneW)) ?? null;
  if (rx >= GEO.bgmX - 2 && rx < GEO.bgmX + GEO.bgmW) return COL_BGM;
  if (bgaVisible() && rx >= bgaX() && rx < bgaX() + bgaW()) return COL_BGA;
  if (useAssist.getState().audioCols && rx >= GEO.hitsX && rx < fullW()) return 'audio';
  return null;
}

/** セクション名の札（小節番号の右）の当たり判定 */
function sectionTagAt(g: Geom, x: number, y: number): number | null {
  const rx = x - g.ox;
  if (rx < GEO.bpmX || rx > GEO.laneX + 90) return null;
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  for (const sec of useSidecar.getState().sections) {
    const ty = g.beatToY(tempo.measureStart(sec.m));
    if (y <= ty - 2 && y >= ty - 18) return sec.m;
  }
  return null;
}

/** ✨ の列で、近い小節線の小節（その線から上の小節）。近くに線が無ければ null */
function genButtonAt(g: Geom, y: number): number | null {
  const tempo = tempoOf(useEditor.getState().doc);
  const { m } = tempo.locate(Math.max(0, g.yToBeat(y)));
  let best: number | null = null;
  let bestD = GEN_HIT + 1;
  for (const mm of [m, m + 1]) {
    if (mm >= 3600) continue;
    const d = Math.abs(g.beatToY(tempo.measureStart(mm)) - y);
    if (d < bestD) {
      best = mm;
      bestD = d;
    }
  }
  return bestD <= GEN_HIT ? best : null;
}

/** 生成の案の点線・消えるチップの上か（クリックで外す・残す） */
function genTargetAt(g: Geom, h: Hit | null, x: number, y: number, gv: GenView): { kind: 'note'; id: string } | { kind: 'keep'; chipId: number } | null {
  if (!h) return null;
  if (h.kind === 'chip' && (gv.plan.remove.includes(h.view.c.id) || gv.kept.has(h.view.c.id))) return { kind: 'keep', chipId: h.view.c.id };
  if (h.kind !== 'lane' && h.kind !== 'chip') return null;
  const col = colAt(g, x);
  if (typeof col !== 'number' || col < 0) return null;
  const tm = tempoOf(useEditor.getState().doc);
  let best: string | null = null;
  let bestD = 8;
  const consider = (n: { ch: number; m: number; f: Frac }) => {
    const info = drumChannel(n.ch);
    if (!info || info.lane !== col) return;
    const d = Math.abs(g.beatToY(tm.beatOf(n.m, n.f)) - y);
    if (d < bestD) {
      best = noteId(n);
      bestD = d;
    }
  };
  for (const n of gv.plan.add) consider(n);
  for (const sk of gv.plan.skipped) if (sk.why === 'rejected') consider(sk.note);
  return best ? { kind: 'note', id: best } : null;
}

/** 曲の終わり（END の線）の拍。分からなければ null */
function endBeatOf(doc: DtxDoc): number | null {
  const m = songEndM(doc);
  return m > 0 ? tempoOf(doc).measureStart(m) : null;
}

/** END の札の高さ（線から下へ下げる） */
const END_TAG_H = 13;

/** 曲の終わり（END）の札の上か（小節番号の列で、線のすぐ上から札の下まで） */
function endHandleAt(g: Geom, x: number, y: number): boolean {
  const rx = x - g.ox;
  if (rx < GUT_X || rx >= GEO.bpmX) return false;
  const eb = endBeatOf(useEditor.getState().doc);
  if (eb === null) return false;
  const ey = g.beatToY(eb);
  return y >= ey - 5 && y <= ey + END_TAG_H + 2;
}

function hitTest(l: Local, g: Geom, x: number, y: number): Hit | null {
  if (x >= l.w - GEO.miniW) return x < l.w - GEO.miniW + GEO.miniLoopW && y >= GEO.head ? { kind: 'miniLoop' } : { kind: 'mini' };
  if (y < GEO.head) return { kind: 'header' };
  if (endHandleAt(g, x, y)) return { kind: 'end' };
  const vs = useVel.getState();
  if (vs.mode) {
    const rx = x - g.ox;
    for (let i = 0; i < vs.lanes.length; i++) {
      const lx = velLaneX(i);
      if (rx < lx || rx >= lx + GEO.velW) continue;
      const lane = vs.lanes[i];
      const beat = g.yToBeat(y);
      const tol = 6 / g.px;
      let best: ChipView | null = null;
      let bestD = Infinity;
      for (const v of viewsInRange(chipViews(useEditor.getState().doc), beat - tol, beat + tol)) {
        if (v.col !== lane || v.kind !== 'normal') continue;
        const dd = Math.abs(v.beat - beat);
        if (dd < bestD) {
          best = v;
          bestD = dd;
        }
      }
      return best ? { kind: 'velChip', idx: i, lane, view: best } : { kind: 'vel', idx: i, lane };
    }
  }
  const sm = sectionTagAt(g, x, y);
  if (sm !== null) return { kind: 'section', m: sm };
  const col = colAt(g, x);
  if (col === null) return null;
  if (col === 'loop') return { kind: 'loop' };
  if (col === 'gen') {
    const m = genButtonAt(g, y);
    return m === null ? { kind: 'gutter' } : { kind: 'genBtn', m };
  }
  if (col === 'gutter') return { kind: 'gutter' };
  if (col === 'audio') return { kind: 'audio' };
  const s = useEditor.getState();
  const beat = g.yToBeat(y);
  const tol = 7 / g.px;
  let best: ChipView | null = null;
  let bestD = Infinity;
  for (const v of viewsInRange(chipViews(s.doc), beat - tol, beat + tol)) {
    if (v.col !== col) continue;
    const dd = Math.abs(v.beat - beat);
    if (dd < bestD) {
      best = v;
      bestD = dd;
    }
  }
  if (best) return { kind: 'chip', view: best };
  if (col === COL_BPM) return { kind: 'bpm' };
  if (col === COL_BGM) return { kind: 'bgm' };
  if (col === COL_BGA) return { kind: 'bga' };
  return { kind: 'lane', lane: col };
}

function chipsInRect(l: Local, g: Geom, x0: number, y0: number, x1: number, y1: number): number[] {
  const s = useEditor.getState();
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const b0 = g.yToBeat(Math.max(y0, y1));
  const b1 = g.yToBeat(Math.min(y0, y1));
  const out: number[] = [];
  const vs = useVel.getState();
  for (const v of viewsInRange(chipViews(s.doc), b0, b1)) {
    const cx = g.ox + colCenter(v.col);
    if (cx >= xa && cx <= xb) {
      out.push(v.c.id);
      continue;
    }
    if (vs.mode && v.kind === 'normal') {
      const i = vs.lanes.indexOf(v.col);
      if (i < 0) continue;
      const vx0 = g.ox + velLaneX(i);
      if (vx0 + GEO.velW >= xa && vx0 <= xb) out.push(v.c.id);
    }
  }
  void l;
  return out;
}

/** 鉛筆：なぞった縦の範囲にあるチップを、なぞった位置のベロシティにする */
function pencilApply(l: Local, g: Geom, idx: number, yA: number, yB: number, x: number, group: string) {
  const s = useEditor.getState();
  const lane = useVel.getState().lanes[idx];
  const tol = 5 / g.px;
  const lo = g.yToBeat(Math.max(yA, yB)) - tol;
  const hi = g.yToBeat(Math.min(yA, yB)) + tol;
  const ids = viewsInRange(chipViews(s.doc), lo, hi)
    .filter((v) => v.col === lane && v.kind === 'normal')
    .map((v) => v.c.id);
  if (ids.length === 0) return;
  const val = velFromX(x - g.ox, idx);
  applyVel('鉛筆でベロシティを変える', ids, () => val, { group, similar: false });
  void l;
}

/** レーンの中心の x（譜面の左端から。レーンの並びの設定に従う） */
function laneCX(lane: number): number {
  return GEO.laneX + slotOf(lane) * GEO.laneW + GEO.laneW / 2;
}

function colCenter(col: number): number {
  if (col >= 0) return laneCX(col);
  if (col === COL_BPM) return GEO.bpmX + GEO.bpmW / 2;
  if (col === COL_BGA) return bgaX() + bgaW() / 2;
  return GEO.bgmX + GEO.bgmW / 2;
}

function miniEnd(): number {
  const s = useEditor.getState();
  let end = Math.max(docStats(s.doc).lastBeat + 16, 64);
  // 譜面が空でも、曲の終わり（END）と原曲の鳴り終わりまでは見せる
  const span = songSpan(s.doc);
  if (span > 0) end = Math.max(end, tempoOf(s.doc).secToBeat(span) + 4);
  return end;
}

/** 全体図の縦の位置と拍 */
function miniGeom(l: Local) {
  const top = GEO.head + 6;
  const bottom = l.h - 6;
  const end = miniEnd();
  return {
    top,
    bottom,
    end,
    yOf: (b: number) => bottom - (b / end) * (bottom - top),
    beatAt: (y: number) => Math.max(0, ((bottom - y) / (bottom - top)) * end),
  };
}

function scrollFromMini(l: Local, y: number) {
  const s = useEditor.getState();
  const beat = miniGeom(l).beatAt(y);
  const viewBeats = (l.h - GEO.head - GEO.bottom) / s.view.pxPerBeat;
  l.followScroll = null;
  setView({ scrollBeat: Math.max(-2, beat - viewBeats / 2), follow: false });
}

/** 左端の帯・全体図の帯で、その高さの拍と、掴める近さ（線から・線の外に出ている印の長さ） */
function loopBandAt(l: Local, g: Geom, kind: 'loop' | 'miniLoop', y: number): { beat: number; tol: number; tab: number } {
  if (kind === 'loop') return { beat: Math.max(0, g.yToBeat(y)), tol: 7 / g.px, tab: 14 / g.px };
  const mg = miniGeom(l);
  const per = mg.end / (mg.bottom - mg.top);
  return { beat: mg.beatAt(y), tol: 6 * per, tab: 11 * per };
}

/** ループの帯の上のマウスの形（A・B の印は上下に動かせる） */
function loopCursor(l: Local, g: Geom, kind: 'loop' | 'miniLoop', y: number): string {
  const at = loopBandAt(l, g, kind, y);
  const mode = loopGrab(at.beat, at.tol, at.tab);
  return mode === 'move' ? 'grab' : mode === 'new' ? 'crosshair' : 'ns-resize';
}

/** マウスの下の説明（無理な配置の警告・ループの帯・再生を始める位置） */
function tipFor(l: Local, g: Geom, h: Hit | null, x: number, y: number): Tip | null {
  if (!h || l.drag) return null;
  const s = useEditor.getState();
  const issuesOn = useCheck.getState().showIssues;
  const at = (key: string, level: Tip['level'], title: string, lines: string[]): Tip => ({ key, x, y, level, title, lines });
  if (issuesOn && (h.kind === 'chip' || h.kind === 'gutter')) {
    let hits: Issue[] = [];
    if (h.kind === 'chip') {
      hits = issuesOf(s.doc).filter((is) => is.ids.includes(h.view.c.id));
    } else if (x - g.ox >= GUT_X && x - g.ox < GUT_X + 24) {
      hits = issuesOf(s.doc).filter((is) => Math.abs(g.beatToY(is.beat) - y) <= 8);
    }
    if (hits.length) {
      const level = hits.some((is) => is.level === 'error') ? 'error' : 'warn';
      return at(
        `issue:${hits.map((is) => `${is.kind}${is.ids[0]}`).join(',')}`,
        level,
        level === 'error' ? '叩けない配置' : '難しい配置',
        [...hits.map((is) => `${toMeasure(is.m)}小節: ${is.message}`), '一覧は右の「確かめる」。印は「譜面に印」で消せます'],
      );
    }
  }
  if (h.kind === 'loop' || h.kind === 'miniLoop') {
    const { loop, loopMark: mk } = useAssist.getState();
    if (!loop && mk) {
      const [me, other, key] = mk.side === 'a' ? ['A', 'B', 'O'] : ['B', 'A', 'I'];
      return at(`loop:${mk.side}`, 'hint', `ループの帯（${me} だけ）`, [
        `${other}（${key} キー・上のバーの ${other}）を決めるとループします`,
        `${me} の印をドラッグ: 動かす / 右クリック: 消す`,
        'ドラッグ: 新しい範囲 / クリック: その小節をループ',
      ]);
    }
    return at(loop ? 'loop' : 'loop:none', 'hint', 'ループの帯', loop
      ? ['ドラッグ: 新しい範囲 / A・B の印をドラッグ: 端を動かす', '範囲の中をドラッグ: 範囲ごと動かす / クリック: オン・オフ', '右クリック: ループを消す']
      : ['ドラッグしてループ（A–B）の範囲を作ります', 'クリックだけならその小節をループ', 'I・O キー（上のバーの A・B）で始まりと終わりを1つずつ決めても作れます']);
  }
  if (h.kind === 'end') return endTip(x, y, false);
  if (h.kind === 'gutter') return at('gutter', 'hint', '小節番号の列', ['クリック・ドラッグ: 再生を始める位置（▶）を置く', 'ダブルクリック: セクション名を付ける']);
  if (h.kind === 'genBtn') {
    const gs = useMeasureGen.getState();
    const mine = gs.open && h.m >= gs.from && h.m <= gs.to;
    return at(`gen:${h.m}:${mine}`, 'hint', `小節 ${toMeasure(h.m)} をAIで生成`, [
      mine && gs.from === gs.to ? 'クリック: 生成をやめる' : 'クリック: この小節の案を作る（AI・採譜・写す）',
      gs.open && !mine ? `Shift+クリック: 生成の範囲をここまで広げる（${toMeasure(Math.min(gs.from, h.m))}〜${toMeasure(Math.max(gs.to, h.m))}、4小節まで）` : 'Shift+クリック: 生成の範囲を広げる（4小節まで）',
      '入れるまで譜面は変わりません。Alt+G で ▶ の小節',
    ]);
  }
  {
    const gv = genView();
    const t = gv ? genTargetAt(g, h, x, y, gv) : null;
    if (t?.kind === 'note') {
      const off = gv!.rejected.has(t.id);
      return at(`gennote:${t.id}:${off}`, 'hint', off ? '外した案のチップ' : '足すチップ（案）', [off ? 'クリック: 戻す' : 'クリック: このチップは入れない']);
    }
    if (t?.kind === 'keep') {
      const kept = gv!.kept.has(t.chipId);
      return at(`genkeep:${t.chipId}:${kept}`, 'hint', kept ? '残すチップ' : '消えるチップ（置き換え）', [kept ? 'クリック: 案どおり消す' : 'クリック: このチップは残す']);
    }
  }
  const a = useAssist.getState();
  const rx = x - g.ox;
  if (h.kind === 'header' && a.audioCols && rx >= GEO.hitsX && rx < GEO.hitsX + GEO.hitsW) {
    const sl = stemLagWarn();
    if (sl) return at(`stemlag:${sl.key}`, 'warn', 'ステムと原曲のずれ', [stemLagText(sl.lag!, sl.name), 'クリック: 直し方']);
    const r = offsetReport();
    if (r && r.verdict !== 'ok' && r.verdict !== 'few') {
      return at(`offset:${r.verdict}`, 'warn', '譜面と原曲の打点のずれ', [offsetSummary(r), 'クリック: 直し方']);
    }
  }
  const inWave = a.audioCols && rx >= GEO.waveX && rx < GEO.waveX + waveColW();
  if (h.kind === 'header' && inWave) {
    const z = a.waveMode === 'spec' && y >= SPEC_ZONE_Y ? specZoneAt(rx - GEO.waveX) : null;
    if (z) {
      return at(`zone:${z.key}:${a.bandFilter}`, 'hint', `${z.label}の帯域`, [
        z.tip,
        a.bandFilter === z.listen ? 'クリック: 原曲を全体で聴くに戻す' : `クリック: 原曲をこの帯域だけで聴く（${LISTEN_LABEL[z.listen]}）`,
      ]);
    }
    return at(`wavehead:${a.waveMode}`, 'hint', a.waveMode === 'spec' ? 'スペクトル' : '原曲の波形', [
      a.waveMode === 'spec' ? 'クリック: 波形に切り替え' : 'クリック: スペクトル（ドラムの帯域ごとの色分け）に切り替え',
      ...(a.waveMode === 'spec' ? ['下の段の見出しをクリック: その帯域だけ聴く'] : []),
    ]);
  }
  if (h.kind === 'audio' && inWave && a.waveMode === 'spec' && rx < GEO.waveX + specVisW()) {
    const z = zoneOfFreq(specFreqAt(rx - GEO.waveX));
    return at(`spec:${z.key}`, 'hint', `スペクトル・${z.label}の帯域`, [
      '光った帯の下の端が、叩いた瞬間',
      '紫: キック　橙: 胴鳴り　黄: スネア　水色: HH・シンバル',
      'クリック: 再生を始める位置（▶）を置く',
      'ダブルクリック: そこから再生',
    ]);
  }
  if (h.kind === 'audio') return at('audio', 'hint', '原曲の打点・波形', ['クリック: 再生を始める位置（▶）を置く', 'ダブルクリック: そこから再生']);
  return null;
}

const END_HOW = { set: '', audio: '原曲の鳴り終わり', video: '参照映像の終わり', chips: '最後のチップのすぐ後' } as const;

/** 曲の終わり（END）の説明。dragging: ドラッグ中（待たずに出し、動かした先を見せる） */
function endTip(x: number, y: number, dragging: boolean): Tip {
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const m = songEndM(doc);
  const sec = tempo.beatToSec(tempo.measureStart(m));
  const why = songEndReason(doc);
  const head = `小節 ${toMeasure(m)} の頭 · ${formatTime(sec, false)}${END_HOW[why] ? `（${END_HOW[why]}）` : ''}`;
  const back = autoEndMeasure(doc) !== null ? '原曲の鳴り終わり' : '最後のチップのすぐ後';
  const lines = dragging
    ? [
        head,
        m <= minSongEnd(doc) ? '最後のチップより前にはできません' : `${back}の所に来ると、${back === '原曲の鳴り終わり' ? '原曲に合わせる（原曲を差し替えても付いていく）' : 'そこで止まります'}`,
      ]
    : [head, 'NX もここで演奏を終えます（最後の小節線）。DTX にも書き出します', `ドラッグ: 動かす（小節の頭に吸着） / ダブルクリック: ${back}に合わせる`];
  return { key: dragging ? 'end:drag' : `end:${m}:${why}`, x, y, level: 'hint', title: '曲の終わり（END）', lines, now: dragging };
}

function ChartTip({ tip }: { tip: Tip }) {
  const left = Math.min(tip.x + 16, viewport.w - 300);
  const top = Math.min(tip.y + 16, viewport.h - 30 - tip.lines.length * 18);
  return (
    <div className={`chart-tip ${tip.level}`} style={{ left: Math.max(4, left), top: Math.max(GEO.head + 2, top) }}>
      <b>
        {tip.level !== 'hint' && <span className="tip-mark">!</span>}
        {tip.title}
      </b>
      {tip.lines.map((t, i) => (
        <div key={i} className={i === tip.lines.length - 1 && tip.level !== 'hint' ? 'tip-foot' : undefined}>
          {t}
        </div>
      ))}
    </div>
  );
}

/** 無理な配置があるとき、譜面の右上に件数を出す（クリックで次の場所へ） */
function IssueBadge() {
  const doc = useEditor((s) => s.doc);
  const show = useCheck((s) => s.showIssues);
  if (!show) return null;
  const issues = issuesOf(doc);
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.length - errors;
  return (
    <button
      className={`issue-float ${errors ? 'error' : 'warn'}`}
      style={{ right: GEO.miniW + 10, top: GEO.head + 8 }}
      onClick={() => gotoNextIssue()}
      title="無理な配置（同時に叩けない・速すぎる連打など）。クリックで次の場所へ移ってチップを選びます。印にマウスを乗せると中身が出ます。一覧は右の「確かめる」"
    >
      <span className="tip-mark">!</span>
      {errors > 0 && <span>叩けない {errors}</span>}
      {warns > 0 && <span>難しい {warns}</span>}
      <span className="lbl">次へ ›</span>
    </button>
  );
}

function autoScrollWhileDragging(l: Local) {
  const d = l.drag;
  if (!d || !l.pointer || (d.type !== 'move' && d.type !== 'rubber' && d.type !== 'erase' && d.type !== 'end' && !(d.type === 'loop' && d.where === 'chart'))) return;
  const s = useEditor.getState();
  const { y } = l.pointer;
  let v = 0;
  if (y < GEO.head + 24) v = (GEO.head + 24 - y) / 6;
  else if (y > l.h - 16) v = -(y - (l.h - 16)) / 6;
  if (v === 0) return;
  const scrollBeat = Math.max(-2, s.view.scrollBeat + (v / s.view.pxPerBeat) * 4);
  setView({ scrollBeat });
  // END はマウスを止めていても、スクロールに合わせて動かす
  if (d.type === 'end') dragSongEnd(Math.max(0, geom(l, scrollBeat, s.view.pxPerBeat).yToBeat(y) - d.grab), d.group);
  l.dirty = true;
}

// ---- 描画 ---------------------------------------------------------------------

const shadeCache = new Map<string, string>();

/** 弱いチップほど暗くする（背景の色に寄せる） */
function shade(color: string, vel: number): string {
  if (vel >= 100) return color;
  const key = `${color}|${vel}`;
  let out = shadeCache.get(key);
  if (out) return out;
  const t = 0.3 + 0.7 * (vel / 100);
  const r = parseInt(color.slice(1, 3), 16);
  const gg = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const mix = (c: number, bg: number) => Math.round(bg + (c - bg) * t);
  out = `rgb(${mix(r, 11)},${mix(gg, 14)},${mix(b, 19)})`;
  shadeCache.set(key, out);
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function draw(ctx: CanvasRenderingContext2D, l: Local) {
  const s = useEditor.getState();
  const a = useAssist.getState();
  const side = useSidecar.getState();
  const doc = s.doc;
  const tempo = tempoOf(doc);
  const views = chipViews(doc);
  const px = s.view.pxPerBeat;
  const div = s.view.div;
  let scroll = s.view.scrollBeat;
  let playBeat: number | null = null;
  const sec = engine.heardSec();
  if (sec !== null) {
    playBeat = tempo.secToBeat(sec);
    if (s.view.follow) {
      scroll = playBeat - ((l.h - GEO.head - GEO.bottom) * FOLLOW_AT) / px;
      l.followScroll = scroll;
    }
  }
  viewport.follow = l.followScroll;
  const g = geom(l, scroll, px);
  const { ox } = g;
  const W = l.w;
  const H = l.h;
  const cw = chartWidth();

  ctx.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // 列の背景
  ctx.fillStyle = '#0A0D11';
  ctx.fillRect(ox, GEO.head, GEO.loopW, H);
  ctx.fillStyle = C.col;
  ctx.fillRect(ox + GEO.loopW, GEO.head, GEO.bpmX - GEO.loopW, H);
  ctx.fillStyle = '#0D1116';
  ctx.fillRect(ox + GEO.bpmX, GEO.head, GEO.bpmW, H);
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i % 2 === 0 ? C.laneA : C.laneB;
    ctx.fillRect(ox + GEO.laneX + i * GEO.laneW, GEO.head, GEO.laneW, H);
  }
  ctx.fillStyle = '#0D1116';
  ctx.fillRect(ox + GEO.bgmX, GEO.head, GEO.bgmW, H);
  ctx.fillStyle = C.sep;
  for (let i = 0; i <= 10; i++) ctx.fillRect(ox + GEO.laneX + i * GEO.laneW - 0.5, GEO.head, 1, H);
  ctx.fillRect(ox + GEO.bpmX - 0.5, GEO.head, 1, H);
  ctx.fillRect(ox + GEO.loopW - 0.5, GEO.head, 1, H);
  ctx.fillRect(ox + GEO.bgmX - 0.5, GEO.head, 1, H);
  ctx.fillRect(ox + GEO.bgmX + GEO.bgmW - 0.5, GEO.head, 1, H);

  // ループの範囲（列の背景だけ。印と線は最後に描く）
  if (a.loop && a.loop.b > a.loop.a) {
    const y0 = g.beatToY(a.loop.b);
    const y1 = g.beatToY(a.loop.a);
    ctx.fillStyle = a.loop.on ? 'rgba(255,199,104,.06)' : 'rgba(255,199,104,.025)';
    ctx.fillRect(ox + GEO.bpmX, y0, GEO.bgmX + GEO.bgmW - GEO.bpmX, y1 - y0);
  }

  // グリッド
  const firstM = tempo.locate(Math.max(0, g.minBeat)).m;
  const lastM = tempo.locate(Math.max(0, g.maxBeat)).m;
  const x0 = ox + GEO.bpmX;
  const x1 = ox + GEO.bgmX + GEO.bgmW;
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  const cursorM = tempo.locate(Math.max(0, s.cursorBeat)).m;
  const same = new Set(sameMeasures(doc, cursorM));
  const pinned = new Set(a.similarPin?.targets ?? []);
  for (let m = firstM; m <= lastM + 1 && m < 3600; m++) {
    const start = tempo.measureStart(m);
    const beats = tempo.measureBeats(m);
    const stepBeats = 4 / div;
    const stepPx = stepBeats * px;
    if (stepPx >= 5) {
      const steps = Math.ceil(beats / stepBeats - 1e-9);
      for (let k = 1; k < steps; k++) {
        const b = start + k * stepBeats;
        const onBeat = Math.abs(k * stepBeats - Math.round(k * stepBeats)) < 1e-9;
        const y = Math.round(g.beatToY(b)) + 0.5;
        if (y < GEO.head || y > H) continue;
        ctx.fillStyle = onBeat ? C.beat : C.grid;
        ctx.fillRect(x0, y, x1 - x0, 1);
      }
    } else if (px >= 6) {
      for (let k = 1; k < beats - 1e-9; k++) {
        const y = Math.round(g.beatToY(start + k)) + 0.5;
        if (y < GEO.head || y > H) continue;
        ctx.fillStyle = C.beat;
        ctx.fillRect(x0, y, x1 - x0, 1);
      }
    }
    const y = Math.round(g.beatToY(start));
    const yEnd = Math.round(g.beatToY(start + beats));
    // 似た小節（カーソルの小節と同じパターン）
    if (same.has(m) || pinned.has(m)) {
      ctx.fillStyle = pinned.has(m) ? 'rgba(255,199,104,.85)' : 'rgba(76,194,255,.7)';
      ctx.fillRect(ox + GUT_X + 4, yEnd + 2, 3, y - yEnd - 4);
    }
    if (y >= GEO.head - 2 && y <= H + 2) {
      ctx.fillStyle = C.measure;
      ctx.fillRect(x0, y - 1, x1 - x0, 2);
      ctx.fillStyle = m === cursorM ? '#C9D1DC' : C.text;
      ctx.textAlign = 'right';
      if (y - 8 > GEO.head) ctx.fillText(toMeasure(m), ox + GEO.bpmX - 4, y - 8);
    }
    // 小節長の変更
    const bl = doc.barLengths[m];
    if (bl !== undefined && y >= GEO.head && y <= H + 2) {
      ctx.fillStyle = C.amber;
      ctx.textAlign = 'left';
      ctx.fillText(meterLabel(bl), ox + GEO.bpmX + 4, y - 18);
    }
  }

  // 小節の生成の ✨（小節線ごと）
  drawGenButtons(ctx, g, tempo, firstM, lastM, H, l.hover?.gen);

  // セクション（左端の色の帯と、始まりの札）
  if (side.sections.length) {
    const top = Math.max(0, g.minBeat);
    for (let i = 0; i < side.sections.length; i++) {
      const sc = side.sections[i];
      const b0 = tempo.measureStart(sc.m);
      const b1 = i + 1 < side.sections.length ? tempo.measureStart(side.sections[i + 1].m) : Infinity;
      if (b1 < top || b0 > g.maxBeat + 1) continue;
      const color = sectionColor(sc.name, side.sectionColors);
      const ya = g.beatToY(Math.min(b1, g.maxBeat + 2));
      const yb = g.beatToY(b0);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = color;
      ctx.fillRect(ox + GEO.bpmX - 5, Math.max(GEO.head, ya), 3, yb - Math.max(GEO.head, ya));
      ctx.globalAlpha = 1;
      if (yb > GEO.head + 16 && yb < H + 4) {
        ctx.font = '700 10px system-ui, sans-serif';
        const tw = ctx.measureText(sc.name).width + 12;
        roundRect(ctx, ox + GEO.bpmX + 4, yb - 17, tw, 14, 7);
        ctx.fillStyle = color + '40';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'left';
        ctx.fillText(sc.name, ox + GEO.bpmX + 10, yb - 10);
        ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
      }
    }
  }

  // BPM（曲頭の #BPM と変化）
  ctx.textAlign = 'left';
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  for (const ev of tempo.events) {
    const y = g.beatToY(ev.beat);
    if (y < GEO.head - 10 || y > H + 10) continue;
    ctx.fillStyle = C.amber;
    ctx.fillRect(ox + GEO.bpmX + 2, Math.round(y) - 1, GEO.bpmW - 4, 2);
    ctx.fillText(chipBpmLabel(ev.bpm), ox + GEO.bpmX + 4, y - 8);
  }

  // 原曲の打点と波形
  if (a.audioCols) drawAudioCols(ctx, l, g, tempo, a, H);
  // BGA・動画の列
  if (bgaVisible()) {
    const bx = ox + bgaX();
    const bw = bgaW();
    ctx.fillStyle = '#0D1116';
    ctx.fillRect(bx, GEO.head, bw, H);
    ctx.fillStyle = C.sep;
    ctx.fillRect(bx - 0.5, GEO.head, 1, H);
    ctx.fillRect(bx + bw - 0.5, GEO.head, 1, H);
    for (let m = firstM; m <= lastM + 1 && m < 3600; m++) {
      const y = Math.round(g.beatToY(tempo.measureStart(m)));
      if (y < GEO.head || y > H) continue;
      ctx.fillStyle = C.measure;
      ctx.fillRect(bx, y - 1, bw, 2);
    }
  }

  const sel = new Set(s.selection);
  const d = l.drag;
  const erasing = d?.type === 'erase' ? d.ids : null;
  const moving = d?.type === 'move' && d.moved && d.dBeat ? d : null;
  const visible = viewsInRange(views, g.minBeat - 0.5, g.maxBeat + 0.5);

  const velMode = useVel.getState().mode;
  const issueOn = useCheck.getState().showIssues;
  const issueIds = new Map<number, 'error' | 'warn'>();
  if (issueOn) {
    for (const is of issuesOf(doc)) {
      if (is.beat > g.maxBeat + 1 || is.beat < g.minBeat - 4) continue;
      for (const id of is.ids) if (issueIds.get(id) !== 'error') issueIds.set(id, is.level);
    }
  }
  const fs = useFind.getState();
  const found = fs.open && fs.results.length ? new Set(fs.results) : null;
  const current = fs.open && fs.index >= 0 ? fs.results[fs.index] : null;
  const drawChip = (v: ChipView, beat: number, col: number, alpha: number, selected: boolean) => {
    const y = g.beatToY(beat);
    if (col >= 0) {
      const lane = DRUM_LANES[col];
      const color = v.alt && lane.altColor ? lane.altColor : lane.color;
      const cx = ox + laneCX(col);
      ctx.globalAlpha = alpha;
      roundRect(ctx, cx - 17, y - 5, 34, 10, 3);
      if (v.kind === 'normal') {
        const vel = wavVel(doc, v.c.v);
        ctx.fillStyle = shade(color, vel);
        ctx.fill();
        if (vel <= 50) {
          // 弱いチップは縁取り（点線のフレーズ候補とは見分けられるよう実線）
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (velMode && px >= 16) {
          ctx.fillStyle = vel > 50 ? 'rgba(11,14,19,.85)' : '#E7EBF1';
          ctx.font = '600 8.5px "JetBrains Mono", ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(String(vel), cx, y + 0.5);
        }
        if (v.alt) {
          // HHオープン・左バスドラムは中に印
          ctx.fillStyle = 'rgba(11,14,19,.75)';
          ctx.beginPath();
          ctx.arc(cx, y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = v.kind === 'hidden' ? 'rgba(255,255,255,.04)' : 'rgba(255,255,255,.02)';
        ctx.fill();
        ctx.setLineDash(v.kind === 'hidden' ? [3, 2] : [1, 2]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (selected) {
        roundRect(ctx, cx - 19, y - 7, 38, 14, 4);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      } else if (issueIds.has(v.c.id)) {
        // 無理な配置
        roundRect(ctx, cx - 19, y - 7, 38, 14, 4);
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = issueIds.get(v.c.id) === 'error' ? '#FF5A61' : '#FFB547';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (!selected && found?.has(v.c.id)) {
        // 検索で見つかったチップ
        roundRect(ctx, cx - 19, y - 7, 38, 14, 4);
        ctx.strokeStyle = C.amber;
        ctx.lineWidth = current === v.c.id ? 2.4 : 1.4;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    }
    const cx = ox + colCenter(col);
    ctx.globalAlpha = alpha;
    if (col === COL_BGA) {
      const w = bgaW() - 6;
      const info = bgaChannel(v.c.ch);
      const color = info?.movie ? '#B39DDB' : '#4DD0C0';
      const left = cx - w / 2;
      roundRect(ctx, left, y - 6, w, 12, 3);
      ctx.fillStyle = info?.swap ? color + '55' : color;
      ctx.fill();
      if (info?.swap) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = info?.swap ? '#E7EBF1' : '#0B0E13';
      ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(bgaChipLabel(v.c.ch, v.c.v), left + 4, y + 0.5);
      if (useBga.getState().wide && !info?.movie) {
        const mat = materials(doc).find((m2) => m2.kind === 'bmp' && m2.no === v.c.v);
        const img = mat ? thumb(mat.path) : null;
        if (img) {
          const th = 26;
          const tw = Math.min(46, (img.width / Math.max(1, img.height)) * th);
          ctx.drawImage(img, left + w - tw - 2, y - th - 7, tw, th);
          ctx.strokeStyle = 'rgba(255,255,255,.25)';
          ctx.lineWidth = 1;
          ctx.strokeRect(left + w - tw - 2 + 0.5, y - th - 7 + 0.5, tw - 1, th - 1);
        }
      }
      if (selected) {
        roundRect(ctx, left - 2, y - 8, w + 4, 16, 4);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (col === COL_BGM) {
      roundRect(ctx, cx - 11, y - 4, 22, 8, 2);
      ctx.fillStyle = v.c.ch === 1 ? C.bgm : v.c.ch === CH.FILLIN ? C.amber : v.c.ch === CH.FILLIN_SOUND ? '#F48FB1' : C.se;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(ox + GEO.bpmX + GEO.bpmW - 9, y - 5);
      ctx.lineTo(ox + GEO.bpmX + GEO.bpmW - 4, y);
      ctx.lineTo(ox + GEO.bpmX + GEO.bpmW - 9, y + 5);
      ctx.lineTo(ox + GEO.bpmX + GEO.bpmW - 14, y);
      ctx.closePath();
      ctx.fillStyle = C.amber;
      ctx.fill();
    }
    if (selected) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(cx - 13, y - 6, 26, 12);
    }
    ctx.globalAlpha = 1;
  };

  // フレーズ候補：範囲の今のチップは薄く、候補は点線で
  const ph = usePhrase.getState();
  const phCand = ph.open ? (ph.cands[ph.index] ?? null) : null;
  // 小節の生成：入れると消えるチップは薄く（× は後で描く）
  const gv = genView(doc);
  const genRemove = gv && gv.plan.remove.length ? new Set(gv.plan.remove) : null;
  for (const v of visible) {
    if (erasing?.has(v.c.id)) continue;
    const selected = sel.has(v.c.id);
    const replaced = (phCand && v.col >= 0 && v.kind === 'normal' && v.c.m >= ph.from && v.c.m <= ph.to) || genRemove?.has(v.c.id);
    drawChip(v, v.beat, v.col, replaced ? 0.22 : moving && selected ? 0.25 : 1, selected && !moving);
  }
  if (ph.open) {
    const tm = tempoOf(doc);
    const y0 = g.beatToY(tm.measureStart(ph.from));
    const y1 = g.beatToY(tm.measureStart(ph.to + 1));
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    ctx.fillStyle = 'rgba(160,140,240,.06)';
    ctx.fillRect(ox + GEO.laneX, top, GEO.laneW * DRUM_LANES.length, bottom - top);
    ctx.strokeStyle = 'rgba(160,140,240,.55)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + GEO.laneX + 0.5, top + 0.5, GEO.laneW * DRUM_LANES.length - 1, bottom - top - 1);
    ctx.setLineDash([]);
  }
  if (phCand) {
    const tm = tempoOf(doc);
    for (const n of phCand.notes) {
      const info = drumChannel(n.ch);
      if (!info) continue;
      const lane = DRUM_LANES[info.lane];
      const beat = tm.beatOf(n.m, n.f);
      if (beat < g.minBeat - 0.5 || beat > g.maxBeat + 0.5) continue;
      const y = g.beatToY(beat);
      const cx = ox + laneCX(info.lane);
      const color = info.alt && lane.altColor ? lane.altColor : lane.color;
      roundRect(ctx, cx - 17, y - 5, 34, 10, 3);
      ctx.fillStyle = color + '40';
      ctx.fill();
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
      if (info.alt) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // TAB補完：打った小節の続きを点線で
  const ghost = visibleGhost();
  if (ghost) drawGhost(ctx, g, ghost, tempoOf(doc));
  // 小節の生成：案の点線と、いまの譜面との違い
  if (gv) drawGenPreview(ctx, g, gv, tempo, visible);
  else if (useMeasureGen.getState().open) drawGenRange(ctx, g, tempo);
  // ✨ を指しているときは、生成する小節を薄く示す
  if (l.hover?.gen !== undefined && !d) {
    const ya = g.beatToY(tempo.measureStart(l.hover.gen + 1));
    const yb = g.beatToY(tempo.measureStart(l.hover.gen));
    ctx.fillStyle = 'rgba(255,199,104,.06)';
    ctx.fillRect(ox + GEO.laneX, ya, GEO.laneW * DRUM_LANES.length, yb - ya);
  }

  // 無理な配置の印（小節番号の列）
  if (issueOn) {
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    let lastY = Infinity;
    for (const is of issuesOf(doc)) {
      if (is.beat < g.minBeat - 0.5 || is.beat > g.maxBeat + 0.5) continue;
      const y = g.beatToY(is.beat);
      if (Math.abs(y - lastY) < 12) continue;
      lastY = y;
      const color = is.level === 'error' ? '#FF5A61' : '#FFB547';
      ctx.fillStyle = color;
      ctx.beginPath();
      const tx = ox + GUT_X + 10;
      ctx.moveTo(tx, y - 6);
      ctx.lineTo(tx + 7, y + 5);
      ctx.lineTo(tx - 7, y + 5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0B0E13';
      ctx.fillText('!', tx, y + 1.5);
    }
  }

  // 移動中のプレビュー
  if (moving) {
    const dB = moving.dBeat!.n / moving.dBeat!.d;
    for (const v of views) {
      if (!sel.has(v.c.id)) continue;
      const col = v.col >= 0 ? (shiftLane(v.col, moving.dLane) ?? -99) : v.col;
      if (col === -99) continue;
      drawChip(v, v.beat + dB, col, 0.9, true);
    }
  }

  // ベロシティのレーン
  if (velMode) drawVelLanes(ctx, g, H, sel, d);
  else drawVelBubble(ctx, g, sel, H);

  // 置く位置のプレビュー
  const hv = l.hover;
  if (hv && hv.pos && !d) {
    const lane = DRUM_LANES[hv.lane];
    const b = tempo.beatOf(hv.pos.m, hv.pos.f);
    const y = g.beatToY(b);
    const cx = ox + laneCX(hv.lane);
    ctx.globalAlpha = 0.38;
    roundRect(ctx, cx - 17, y - 5, 34, 10, 3);
    ctx.fillStyle = hv.alt && lane.altColor ? lane.altColor : lane.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 範囲選択
  if (d?.type === 'rubber') {
    const xa = Math.min(d.x0, d.x1);
    const ya = Math.min(d.y0, d.y1);
    ctx.fillStyle = 'rgba(76,194,255,.08)';
    ctx.fillRect(xa, ya, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    ctx.strokeStyle = 'rgba(76,194,255,.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(xa + 0.5, ya + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }
  // 曲の終わり（END）。その先は暗く
  const endBeat = endBeatOf(doc);
  if (endBeat !== null) drawSongEnd(ctx, g, H, cw, endBeat, tempo.beatToSec(endBeat), songEndReason(doc), d?.type === 'end');

  // ループ（帯・A と B の印・線）
  drawLoop(ctx, g, H, cw, a);

  // 再生を始める位置（▶）。小節番号の列か波形の上では、クリックしたときの位置を薄く出す
  const hs = hv?.start;
  if (hs !== undefined && !d && Math.abs(hs - s.cursorBeat) > 1e-6) {
    const y = Math.round(g.beatToY(hs)) + 0.5;
    ctx.strokeStyle = 'rgba(76,194,255,.45)';
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox + GEO.bpmX, y);
    ctx.lineTo(ox + cw, y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawStartTag(ctx, ox, y, 0.45);
  }
  {
    const y = Math.round(g.beatToY(s.cursorBeat)) + 0.5;
    if (y >= GEO.head && y <= H) {
      ctx.strokeStyle = C.accent;
      ctx.globalAlpha = playBeat !== null ? 0.5 : 0.9;
      ctx.setLineDash([6, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ox + GEO.bpmX, y);
      ctx.lineTo(ox + cw, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      drawStartTag(ctx, ox, y, playBeat !== null ? 0.6 : 1);
    }
  }

  // 再生位置
  if (playBeat !== null) {
    const y = Math.round(g.beatToY(playBeat));
    ctx.fillStyle = a.inputMode === 'rec' ? '#FF5A61' : C.playhead;
    ctx.fillRect(ox + GEO.loopW, y - 1, cw - GEO.loopW, 2);
    ctx.shadowColor = ctx.fillStyle as string;
    ctx.shadowBlur = 8;
    ctx.fillRect(ox + GEO.laneX, y - 1, GEO.laneW * 10, 2);
    ctx.shadowBlur = 0;
  }

  // レーン名
  ctx.fillStyle = '#0E1217';
  ctx.fillRect(0, 0, W, GEO.head);
  ctx.fillStyle = C.sep;
  ctx.fillRect(0, GEO.head - 1, W, 1);
  ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = C.text;
  ctx.fillText('BPM', ox + GEO.bpmX + GEO.bpmW / 2, GEO.head / 2);
  ctx.font = '700 8px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = a.loop?.on ? C.loop : '#8D7A55';
  ctx.fillText('A', ox + GEO.loopW / 2, GEO.head / 2 + 6);
  ctx.fillText('B', ox + GEO.loopW / 2, GEO.head / 2 - 5);
  ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = C.text;
  const ms = new Set(a.mute);
  const ss = new Set(a.solo);
  DRUM_LANES.forEach((lane, i) => {
    const cx = ox + laneCX(i);
    const silent = ss.size > 0 ? !ss.has(i) : ms.has(i);
    ctx.fillStyle = lane.color;
    ctx.globalAlpha = silent ? 0.3 : 1;
    ctx.fillText(lane.key, cx, GEO.head / 2);
    ctx.globalAlpha = 1;
    if (ss.has(i)) {
      ctx.fillStyle = C.amber;
      ctx.fillRect(cx - 8, GEO.head - 4, 16, 2);
    }
  });
  ctx.font = '600 8px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = C.text;
  ctx.fillText('BGM', ox + GEO.bgmX + GEO.bgmW / 2, GEO.head / 2 - 5);
  ctx.fillText('SE', ox + GEO.bgmX + GEO.bgmW / 2, GEO.head / 2 + 5);
  if (bgaVisible()) {
    ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = '#4DD0C0';
    ctx.fillText('BGA', ox + bgaX() + bgaW() / 2, GEO.head / 2);
  }
  if (a.audioCols) {
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = '#A3ADBB';
    // 譜面のチップと原曲の打点がずれていれば、見出しの代わりにずれを出す（クリックで直し方）
    const bgmH = bgmSource(doc);
    const badge = bgmH ? offsetBadge(tempo.beatToSec(g.yToBeat(H)) - bgmH.sec, tempo.beatToSec(g.yToBeat(GEO.head)) - bgmH.sec) : null;
    if (badge) {
      const bx = ox + GEO.hitsX + GEO.hitsW / 2;
      ctx.font = '600 9px system-ui, sans-serif';
      const tw = ctx.measureText(badge).width;
      ctx.fillStyle = 'rgba(255,199,104,.16)';
      roundRect(ctx, bx - tw / 2 - 5, 1.5, tw + 10, 13, 6.5);
      ctx.fill();
      ctx.fillStyle = C.amber;
      ctx.fillText(badge, bx, 8);
    } else {
      ctx.fillText('原曲の打点 ⓘ', ox + GEO.hitsX + GEO.hitsW / 2, 8);
    }
    const dr = useDrums.getState();
    if (readyDrums()) {
      // ドラムの採譜モデルの5種
      const hl = hitLanes(true);
      ctx.font = '600 8px "JetBrains Mono", ui-monospace, monospace';
      DRUM_CLASSES.forEach((k, i) => {
        ctx.fillStyle = DRUM_COL[k];
        ctx.fillText(k, ox + GEO.hitsX + hl.x(i) + hl.w / 2, 21);
      });
    } else if (dr.enabled && dr.status === 'loading') {
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = C.amber;
      ctx.fillText(dr.stage === 'run' ? `採譜中 ${Math.round(dr.progress * 100)}%` : '採譜の準備…', ox + GEO.hitsX + GEO.hitsW / 2, 21);
    } else {
      const hl = hitLanes(false);
      ctx.font = '600 10px system-ui, sans-serif';
      (['low', 'mid', 'high'] as const).forEach((b, i) => {
        ctx.fillStyle = C[b];
        ctx.fillText(['低', '中', '高'][i], ox + GEO.hitsX + hl.x(i) + hl.w / 2, 21);
      });
    }
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = C.text;
    // BGA の列が波形の上に重なっているときは、見えている所の真ん中に出す
    const waveRight = bgaVisible() && bgaX() < fullW() ? Math.max(GEO.waveX + 40, bgaX() - 2) : GEO.waveX + waveColW();
    const narrowWave = waveRight - GEO.waveX < 80;
    if (a.waveMode === 'spec') drawSpecHeader(ctx, ox, waveRight, a);
    else ctx.fillText(narrowWave ? '波形 ⇄' : '原曲の波形 ⇄', ox + (GEO.waveX + waveRight) / 2, GEO.head / 2);
  }

  if (velMode) {
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    useVel.getState().lanes.forEach((lane, i) => {
      const def = DRUM_LANES[lane];
      const cx = ox + velLaneX(i) + GEO.velW / 2;
      ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = def.color;
      ctx.fillText(`${def.key}`, cx, GEO.head / 2 - 6);
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = C.text;
      ctx.fillText('ベロシティ', cx, GEO.head / 2 + 7);
    });
  }

  drawMinimap(ctx, l, g, playBeat, a);
}

let hatchPat: CanvasPattern | null = null;

/** 曲の終わりより先に重ねる斜線 */
function hatch(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatchPat) return hatchPat;
  const c = document.createElement('canvas');
  c.width = 10;
  c.height = 10;
  const m = c.getContext('2d');
  if (!m) return null;
  m.strokeStyle = 'rgba(255,255,255,.045)';
  m.lineWidth = 1;
  m.beginPath();
  for (const o of [-10, 0, 10]) {
    m.moveTo(o, 10);
    m.lineTo(o + 10, 0);
  }
  m.stroke();
  hatchPat = ctx.createPattern(c, 'repeat');
  return hatchPat;
}

/**
 * 曲の終わり（END）：その先（上）を暗くして斜線、白い線、小節番号の列に「END」の札（線から下げる。ドラッグで動かす）、
 * 線の上に時刻と、どう決まっているか
 */
function drawSongEnd(
  ctx: CanvasRenderingContext2D,
  g: Geom,
  H: number,
  cw: number,
  endBeat: number,
  endSec: number,
  why: keyof typeof END_HOW,
  active: boolean,
) {
  const { ox } = g;
  const y = Math.round(g.beatToY(endBeat));
  // ループの帯と ✨ の列はそのまま（小節番号の列から右）
  const left = ox + GUT_X;
  const w = cw - GUT_X;
  const bottom = Math.min(H, y - 1);
  if (bottom > GEO.head) {
    ctx.fillStyle = 'rgba(4,6,9,.55)';
    ctx.fillRect(left, GEO.head, w, bottom - GEO.head);
    const pat = hatch(ctx);
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(left, GEO.head, w, bottom - GEO.head);
    }
  }
  if (y < GEO.head - END_TAG_H || y > H + 2) return;
  ctx.fillStyle = active ? '#FFFFFF' : 'rgba(231,235,241,.88)';
  ctx.fillRect(left, y - 1, w, 2);
  const tx = ox + GUT_X + 2;
  const tw = GEO.bpmX - GUT_X - 4;
  roundRect(ctx, tx, y - 1, tw, END_TAG_H, 2);
  ctx.fillStyle = active ? '#FFFFFF' : '#E7EBF1';
  ctx.fill();
  ctx.fillStyle = '#0B0E13';
  ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('END', tx + tw / 2, y - 1 + END_TAG_H / 2 + 0.5);
  if (y - 9 > GEO.head + 4) {
    const label = `曲の終わり ${formatTime(endSec, false)}`;
    const lx = ox + GEO.laneX + 6;
    ctx.textAlign = 'left';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = '#E7EBF1';
    ctx.fillText(label, lx, y - 9);
    if (END_HOW[why]) {
      const lw = ctx.measureText(label).width;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#A3ADBB';
      ctx.fillText(`· ${END_HOW[why]}`, lx + lw + 6, y - 9);
    }
  }
}

/** 再生を始める位置の印（小節番号の列の左） */
function drawStartTag(ctx: CanvasRenderingContext2D, ox: number, y: number, alpha: number) {
  const x = ox + GEO.bpmX - 1;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.accent;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 9, y - 6);
  ctx.lineTo(x - 9, y + 6);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** ループ：左端の帯に範囲と A・B の印、譜面に A・B の線。A だけ・B だけのときは、その印と点線 */
function drawLoop(ctx: CanvasRenderingContext2D, g: Geom, H: number, cw: number, a: AssistState) {
  const { ox } = g;
  const loop = a.loop && a.loop.b > a.loop.a ? a.loop : null;
  const mark = loop ? null : a.loopMark;
  if (!loop && !mark) return;
  // A・B の印（A は線の下、B は線の上。重ならない）
  ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tab = (y: number, label: string, below: boolean, col: string) => {
    const ty = below ? y : y - 13;
    if (ty + 13 < GEO.head || ty > H) return;
    roundRect(ctx, ox + 1, ty, GEO.loopW - 2, 13, 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.fillStyle = '#1A1408';
    ctx.fillText(label, ox + GEO.loopW / 2, ty + 7);
  };
  if (mark) {
    // 片方だけ：もう片方を決めるまでループしないので、線は点線
    const y = g.beatToY(mark.beat);
    if (y < GEO.head - 14 || y > H + 14) return;
    if (y >= GEO.head && y <= H) {
      ctx.strokeStyle = C.loop;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(ox, Math.round(y));
      ctx.lineTo(ox + cw, Math.round(y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    tab(y, mark.side === 'a' ? 'A' : 'B', mark.side === 'a', C.loop);
    return;
  }
  if (!loop) return;
  const yB = g.beatToY(loop.b);
  const yA = g.beatToY(loop.a);
  if (yA < GEO.head - 14 || yB > H + 14) return;
  const on = loop.on;
  const col = on ? C.loop : 'rgba(255,199,104,.45)';
  // 帯の範囲
  const top = Math.max(GEO.head, yB);
  const bottom = Math.min(H, yA);
  if (bottom > top) {
    ctx.fillStyle = on ? 'rgba(255,199,104,.35)' : 'rgba(255,199,104,.12)';
    ctx.fillRect(ox + 2, top, GEO.loopW - 4, bottom - top);
  }
  // 線
  ctx.fillStyle = col;
  for (const y of [yA, yB]) {
    if (y < GEO.head || y > H) continue;
    ctx.fillRect(ox, Math.round(y) - 0.5, cw, 1);
  }
  tab(yA, 'A', true, col);
  tab(yB, 'B', false, col);
}

// ---- ベロシティ -----------------------------------------------------------------------

function drawVelLanes(ctx: CanvasRenderingContext2D, g: Geom, H: number, sel: Set<number>, d: Drag | null) {
  const v = useVel.getState();
  const doc = useEditor.getState().doc;
  const views = viewsInRange(chipViews(doc), g.minBeat - 0.5, g.maxBeat + 0.5);
  const bw = velBarW();
  ctx.textBaseline = 'middle';
  v.lanes.forEach((lane, i) => {
    const x = g.ox + velLaneX(i);
    const bx = x + VEL_PAD;
    ctx.fillStyle = '#0D1015';
    ctx.fillRect(x, GEO.head, GEO.velW, H);
    ctx.fillStyle = C.sep;
    ctx.fillRect(x - 0.5, GEO.head, 1, H);
    ctx.fillRect(x + GEO.velW - 0.5, GEO.head, 1, H);
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.fillRect(Math.round(bx + bw * 0.5), GEO.head, 1, H);
    ctx.fillRect(Math.round(bx + bw), GEO.head, 1, H);
    const color = DRUM_LANES[lane].color;
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'left';
    for (const cv of views) {
      if (cv.col !== lane || cv.kind !== 'normal') continue;
      const y = g.beatToY(cv.beat);
      if (y < GEO.head - 6 || y > H + 6) continue;
      const vel = wavVel(doc, cv.c.v);
      const selected = sel.has(cv.c.id);
      const w = (bw * vel) / 100;
      ctx.globalAlpha = selected ? 1 : 0.7;
      ctx.fillStyle = color;
      ctx.fillRect(bx, y - 1.5, w, 3);
      ctx.beginPath();
      ctx.arc(bx + w, y, selected ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const prop = v.proposal?.get(cv.c.id);
      if (prop !== undefined) {
        const pw = (bw * prop) / 100;
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = C.amber;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(bx, y + 4);
        ctx.lineTo(bx + pw, y + 4);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.amber;
        ctx.fillRect(bx + pw - 1, y + 2, 2, 5);
      }
      if (g.px >= 12) {
        ctx.fillStyle = selected ? '#E7EBF1' : '#8B95A4';
        ctx.fillText(String(prop ?? vel), bx + Math.max(w, prop !== undefined ? (bw * prop) / 100 : 0) + 6, y - (prop !== undefined ? 3 : 0));
      }
    }
  });
  if (d?.type === 'velLine') {
    const x = g.ox + velLaneX(d.idx) + VEL_PAD;
    const xa = x + (bw * d.v0) / 100;
    const xb = x + (bw * d.v1) / 100;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = C.amber;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xa, d.y0);
    ctx.lineTo(xb, d.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = `直線 ${d.v0} → ${d.v1}`;
    ctx.font = '10px system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 12;
    const ly = Math.min(d.y0, d.y1) - 12;
    roundRect(ctx, x - 2, ly - 8, tw, 16, 4);
    ctx.fillStyle = '#1E1A12';
    ctx.fill();
    ctx.strokeStyle = '#6B5326';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.amber;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 4, ly);
  }
}

/** 1つだけ選んだチップの横にベロシティの吹き出し */
function drawVelBubble(ctx: CanvasRenderingContext2D, g: Geom, sel: Set<number>, H: number) {
  if (sel.size !== 1) return;
  const doc = useEditor.getState().doc;
  const id = [...sel][0];
  const v = chipViews(doc).find((x) => x.c.id === id);
  if (!v || v.col < 0 || v.kind !== 'normal') return;
  const y = g.beatToY(v.beat);
  if (y < GEO.head + 8 || y > H - 8) return;
  const vel = wavVel(doc, v.c.v);
  const x = g.ox + laneCX(v.col) + 22;
  ctx.font = '10px system-ui, sans-serif';
  const label = 'ベロシティ';
  const hint = 'Alt+ホイール';
  ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
  const numW = ctx.measureText(String(vel)).width;
  ctx.font = '10px system-ui, sans-serif';
  const w = ctx.measureText(label).width + numW + ctx.measureText(hint).width + 26;
  roundRect(ctx, x, y - 9, w, 18, 9);
  ctx.fillStyle = 'rgba(18,22,29,.94)';
  ctx.fill();
  ctx.strokeStyle = '#2C3440';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let tx = x + 8;
  ctx.fillStyle = '#A3ADBB';
  ctx.fillText(label, tx, y + 0.5);
  tx += ctx.measureText(label).width + 5;
  ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = '#E7EBF1';
  ctx.fillText(String(vel), tx, y + 0.5);
  tx += numW + 7;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = '#5F6978';
  ctx.fillText(hint, tx, y + 0.5);
}

// ---- 原曲の列 -------------------------------------------------------------------

function drawAudioCols(ctx: CanvasRenderingContext2D, l: Local, g: Geom, tempo: TempoMap, a: AssistState, H: number) {
  const { ox } = g;
  const hx = ox + GEO.hitsX;
  const wx = ox + GEO.waveX;
  const W = waveColW();
  ctx.fillStyle = '#0D1015';
  ctx.fillRect(hx, GEO.head, GEO.hitsW, H);
  ctx.fillRect(wx, GEO.head, W, H);
  ctx.fillStyle = C.sep;
  ctx.fillRect(hx - 0.5, GEO.head, 1, H);
  ctx.fillRect(wx - 0.5, GEO.head, 1, H);
  ctx.fillRect(wx + W - 0.5, GEO.head, 1, H);
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  // スペクトルは解析が済んでいなくても出せる（下のトラックで選んだステムなど）
  const spec = a.waveMode === 'spec' && a.spectro && bgm ? a.spectro : null;
  if ((!a.data && !spec) || !bgm) {
    ctx.save();
    ctx.translate(wx + W / 2, (GEO.head + H) / 2);
    ctx.fillStyle = C.dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const msg =
      a.status === 'loading'
        ? `原曲を解析中… ${Math.round(a.progress * 100)}%`
        : a.status === 'error'
          ? `解析できませんでした`
          : bgm
            ? '原曲のファイルがありません'
            : '原曲がありません';
    ctx.fillText(msg, 0, 0);
    if (a.status === 'nosource' || a.status === 'none') {
      ctx.fillStyle = C.accent;
      ctx.fillText('クリックして読み込む', 0, 20);
      ctx.fillStyle = C.dim;
      ctx.fillText('（右の「原曲」からも）', 0, 36);
    }
    ctx.restore();
    return;
  }
  const off = bgm.sec;
  const audioAt = (y: number) => tempo.beatToSec(g.yToBeat(y)) - off;

  // 波形 / スペクトログラム
  if (spec) {
    drawSpectro(ctx, l, g, tempo, off, spec, a, wx, specVisW(), H);
  } else if (a.data) {
    const data = a.data;
    ctx.fillStyle = C.wave;
    const pr = data.peakRate;
    const n = data.peaks.length;
    const mid = wx + W / 2;
    const half = W / 2 - 4;
    for (let y = GEO.head; y < H; y += 2) {
      const tTop = audioAt(y);
      const tBot = audioAt(y + 2);
      let i0 = Math.floor(Math.min(tTop, tBot) * pr);
      let i1 = Math.ceil(Math.max(tTop, tBot) * pr);
      if (i1 < 0 || i0 >= n) continue;
      i0 = Math.max(0, i0);
      i1 = Math.min(n - 1, Math.max(i0, i1));
      let m = 0;
      for (let i = i0; i <= i1; i++) if (data.peaks[i] > m) m = data.peaks[i];
      const w = Math.max(1, m * half);
      ctx.fillRect(mid - w, y, w * 2, 2);
    }
  }
  if (a.waveMode === 'spec' && a.spectroStatus !== 'ready') {
    // 作っている途中（見せ方を変えたときは前のスペクトルの上に出す）
    const label = a.spectroStatus === 'error' ? 'スペクトルを作れませんでした' : `スペクトルを作成中… ${Math.round(a.specProgress * 100)}%`;
    ctx.font = '10px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(11,14,19,0.85)';
    ctx.fillRect(wx + W / 2 - tw / 2 - 6, GEO.head + 4, tw + 12, 16);
    ctx.fillStyle = a.spectroStatus === 'error' ? '#FF8A80' : C.text;
    ctx.textAlign = 'center';
    ctx.fillText(label, wx + W / 2, GEO.head + 12);
  }
  const tMin = Math.min(audioAt(H), audioAt(GEO.head));
  const tMax = Math.max(audioAt(H), audioAt(GEO.head));
  /** 時刻の順の打点を、見えている所だけ横棒で描く */
  const drawBars = (list: readonly { t: number; s: number }[], cx: number, cw: number, color: string) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const md = (lo + hi) >> 1;
      if (list[md].t < tMin) lo = md + 1;
      else hi = md;
    }
    ctx.fillStyle = color;
    for (let i = lo; i < list.length && list[i].t <= tMax; i++) {
      const o = list[i];
      const y = g.beatToY(tempo.secToBeat(o.t + off));
      const w = Math.max(3, Math.round(cw * Math.min(1, o.s)));
      ctx.fillRect(cx + (cw - w) / 2, y - 2.5, w, 5);
    }
  };
  /** 1/fr 秒ごとの値（get(i)）を薄い帯で描く */
  const drawStrip = (n: number, fr: number, get: (i: number) => number, cx: number, cw: number, color: string, floor: number) => {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.18;
    for (let y = GEO.head; y < H; y += 2) {
      const tTop = audioAt(y);
      const tBot = audioAt(y + 2);
      let i0 = Math.floor(Math.min(tTop, tBot) * fr);
      let i1 = Math.ceil(Math.max(tTop, tBot) * fr);
      if (i1 < 0 || i0 >= n) continue;
      i0 = Math.max(0, i0);
      i1 = Math.min(n - 1, i1);
      let m = 0;
      for (let i = i0; i <= i1; i++) {
        const v = get(i);
        if (v > m) m = v;
      }
      if (m < floor) continue;
      const w = Math.min(cw, m * cw);
      ctx.fillRect(cx + (cw - w) / 2, y, w, 2);
    }
    ctx.globalAlpha = 1;
  };

  // ドラムの採譜モデル：5種の「鳴っていそうな度合い」（薄い帯）と打点（横棒）
  const drums = readyDrums();
  const byClass = drums ? drumHitsByClass(a.sensitivity) : null;
  if (drums && byClass) {
    const hl = hitLanes(true);
    const nCls = ADTOF.classes.length;
    DRUM_CLASSES.forEach((k, i) => {
      const c = ADTOF.classes.indexOf(k);
      const cx = hx + hl.x(i);
      drawStrip(drums.frames, drums.fps, (f) => drums.act[f * nCls + c], cx, hl.w - 2, DRUM_COL[k], 0.08);
      drawBars(byClass[k], cx, hl.w - 2, DRUM_COL[k]);
    });
    return;
  }

  // 使えないとき（読み込み中・切ってある・失敗）は、原曲を3帯域に分けた打点
  if (!a.data) return;
  const data = a.data;
  const hl = hitLanes(false);
  const bands = ['low', 'mid', 'high'] as const;
  bands.forEach((b, bi) => {
    const odf = data.odf[b];
    drawStrip(odf.length, data.frameRate, (i) => odf[i], hx + hl.x(bi), hl.w - 2, C[b], 0.04);
  });
  const on = bandOnsets();
  if (on) bands.forEach((b, bi) => drawBars(on[b] as Onset[], hx + hl.x(bi), hl.w - 2, C[b]));
}

// ---- スペクトル -------------------------------------------------------------------

/** 帯域の見出しの段（見出しの下半分） */
const SPEC_ZONE_Y = 15;

const LISTEN_LABEL: Record<'low' | 'mid' | 'high', string> = { low: '低域 〜160Hz', mid: '中域 200〜3500Hz', high: '高域 5kHz〜' };
/** 聴く帯域のフィルタが通す周波数（engine の帯域フィルタと同じ） */
const LISTEN_RANGE: Record<'low' | 'mid' | 'high', [number, number]> = { low: [0, 160], mid: [200, 3500], high: [5000, Infinity] };

function specRange(): { fLo: number; fHi: number } {
  const sp = useAssist.getState().spectro;
  return sp ? { fLo: sp.fLo, fHi: sp.fHi } : { fLo: SPEC_F_LO, fHi: SPEC_F_HI };
}

/**
 * スペクトルを描く幅。BGA の列が重なるほど狭いときは、重ならないところに縮めて全部の帯域を見せる
 * （右端のハイハット・シンバルの帯が隠れないように）
 */
function specVisW(): number {
  const W = waveColW();
  if (!bgaVisible()) return W;
  const bx = bgaX();
  return bx < GEO.waveX + W ? Math.max(40, Math.min(W, bx - 2 - GEO.waveX)) : W;
}

/** 列の中の x（列の左端から）→ 周波数 */
function specFreqAt(rx: number): number {
  const { fLo, fHi } = specRange();
  const p = Math.max(0, Math.min(1, (rx - 1) / (specVisW() - 2)));
  return specFreq(p, fLo, fHi);
}

/** 周波数 → 列の中の x（列の左端から） */
function specXAt(f: number): number {
  const { fLo, fHi } = specRange();
  return 1 + Math.max(0, Math.min(1, specPos(Math.max(f, fLo), fLo, fHi))) * (specVisW() - 2);
}

function zoneOfFreq(f: number): SpecZone {
  return SPEC_ZONES.find((z) => f < z.to) ?? SPEC_ZONES[SPEC_ZONES.length - 1];
}

function specZoneAt(rx: number): SpecZone | null {
  if (rx < 0 || rx >= specVisW()) return null;
  return zoneOfFreq(specFreqAt(rx));
}

function fmtHz(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}kHz` : `${Math.round(f / 10) * 10}Hz`;
}

/** スペクトルの列の見出し：上の段に「スペクトル ⇄」、下の段に帯域（クリックでその帯域だけ聴く） */
function drawSpecHeader(ctx: CanvasRenderingContext2D, ox: number, right: number, a: AssistState) {
  const x0 = ox + GEO.waveX;
  const x1 = ox + right;
  ctx.textAlign = 'center';
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = '#A3ADBB';
  ctx.fillText('スペクトル ⇄', (x0 + x1) / 2, 8);
  ctx.font = '600 9px system-ui, sans-serif';
  for (const z of SPEC_ZONES) {
    const za = x0 + specXAt(z.from);
    const zb = Math.min(x1, x0 + specXAt(z.to));
    if (zb - za < 6) continue;
    const on = a.bandFilter !== 'all' && a.bandFilter === z.listen;
    const off = a.bandFilter !== 'all' && !on;
    const label = ctx.measureText(z.label).width + 4 <= zb - za ? z.label : ctx.measureText(z.short).width + 2 <= zb - za ? z.short : '';
    ctx.globalAlpha = off ? 0.35 : z.key === 'mid' ? 0.7 : 1;
    ctx.fillStyle = z.color;
    if (label) ctx.fillText(label, (za + zb) / 2, 21);
    if (on) ctx.fillRect(za + 1, GEO.head - 3, zb - za - 2, 2);
    ctx.globalAlpha = 1;
  }
}

/** 縦に並べるスペクトルの画像の1枚の高さ（フレーム数）。長い曲は何枚かに分ける */
const SPEC_TILE = 2048;

interface SpecTiles {
  data: SpectroData;
  gain: number;
  lut: Uint8ClampedArray;
  tiles: (HTMLCanvasElement | null)[];
}

function specTile(t: SpecTiles, k: number): HTMLCanvasElement {
  const have = t.tiles[k];
  if (have) return have;
  const sp = t.data;
  const f0 = k * SPEC_TILE;
  const h = Math.max(1, Math.min(SPEC_TILE, sp.frames - f0));
  const c = document.createElement('canvas');
  c.width = sp.bins;
  c.height = h;
  const cx = c.getContext('2d')!;
  const img = cx.createImageData(sp.bins, h);
  const lut = t.lut;
  // 画像の上が新しい時刻（譜面と同じく下から上へ進む）
  for (let r = 0; r < h; r++) {
    const f = f0 + h - 1 - r;
    const src = f * sp.bins;
    const dst = r * sp.bins * 4;
    for (let b = 0; b < sp.bins; b++) {
      const o = (b * 256 + sp.data[src + b]) * 4;
      const q = dst + b * 4;
      img.data[q] = lut[o];
      img.data[q + 1] = lut[o + 1];
      img.data[q + 2] = lut[o + 2];
      img.data[q + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  t.tiles[k] = c;
  return c;
}

function drawSpectro(ctx: CanvasRenderingContext2D, l: Local, g: Geom, tempo: TempoMap, off: number, sp: SpectroData, a: AssistState, wx: number, W: number, H: number) {
  if (!l.spec || l.spec.data !== sp || l.spec.gain !== a.specGain) {
    l.spec = { data: sp, gain: a.specGain, lut: zoneLut(sp.bins, sp.fLo, sp.fHi, { gain: a.specGain, dimMid: sp.mode !== 'raw' }), tiles: [] };
  }
  const t = l.spec;
  const frames = sp.frames;
  const evs = tempo.events;
  ctx.imageSmoothingEnabled = true;
  // テンポが一定の区間ごとに、画像を伸ばして描く。フレーム f は [f, f+1) の帯で、真ん中が f / rate 秒
  for (let i = 0; i < evs.length; i++) {
    const bA = Math.max(evs[i].beat, g.minBeat);
    const bB = Math.min(i + 1 < evs.length ? evs[i + 1].beat : Infinity, g.maxBeat + 1);
    if (bB <= bA) continue;
    const eA = (tempo.beatToSec(bA) - off) * sp.rate + 0.5;
    const eB = (tempo.beatToSec(bB) - off) * sp.rate + 0.5;
    const ea = Math.max(0, eA);
    const eb = Math.min(frames, eB);
    if (eb <= ea) continue;
    const yOf = (e: number) => g.beatToY(tempo.secToBeat((e - 0.5) / sp.rate + off));
    const ya = yOf(ea);
    const yb = yOf(eb);
    if (ya - yb < 0.01) continue;
    const eAt = (y: number) => ea + ((ya - y) / (ya - yb)) * (eb - ea);
    for (let k = Math.floor(ea / SPEC_TILE); k * SPEC_TILE < eb; k++) {
      const t0 = k * SPEC_TILE;
      const th = Math.min(SPEC_TILE, frames - t0);
      const s0 = Math.max(ea, t0);
      const s1 = Math.min(eb, t0 + th);
      if (s1 <= s0) continue;
      const bottom = Math.min(H, ya - ((s0 - ea) / (eb - ea)) * (ya - yb));
      const top = Math.max(GEO.head, ya - ((s1 - ea) / (eb - ea)) * (ya - yb));
      if (bottom <= top) continue;
      const eTop = eAt(top);
      const eBot = eAt(bottom);
      const srcTop = t0 + th - eTop;
      ctx.drawImage(specTile(t, k), 0, srcTop, sp.bins, Math.max(0.05, eTop - eBot), wx + 1, top, W - 2, bottom - top);
    }
  }
  // 帯域の区切り
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (const z of SPEC_ZONES.slice(1)) ctx.fillRect(Math.round(wx + specXAt(z.from)) - 0.5, GEO.head, 1, H - GEO.head);
  // 帯域だけ聴いているときは、ほかの帯域を暗くする
  if (a.bandFilter !== 'all') {
    const [fa, fb] = LISTEN_RANGE[a.bandFilter];
    const xa = wx + (fa <= sp.fLo ? 1 : specXAt(fa));
    const xb = wx + (fb >= sp.fHi ? W - 1 : specXAt(fb));
    ctx.fillStyle = 'rgba(8,10,14,0.66)';
    if (xa > wx + 1) ctx.fillRect(wx + 1, GEO.head, xa - wx - 1, H - GEO.head);
    if (xb < wx + W - 1) ctx.fillRect(xb, GEO.head, wx + W - 1 - xb, H - GEO.head);
  }
  // マウスの位置の周波数
  const p = l.pointer;
  if (p && !l.drag && p.x >= wx && p.x < wx + W && p.y > GEO.head && p.y < H) {
    const f = specFreqAt(p.x - wx);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(Math.round(p.x) - 0.5, GEO.head, 1, H - GEO.head);
    const label = fmtHz(f);
    ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
    const tw = ctx.measureText(label).width;
    const lx = Math.max(wx + 2, Math.min(wx + W - tw - 8, p.x - tw / 2 - 3));
    ctx.fillStyle = 'rgba(11,14,19,0.9)';
    ctx.fillRect(lx, GEO.head + 2, tw + 6, 14);
    ctx.fillStyle = zoneOfFreq(f).color;
    ctx.textAlign = 'left';
    ctx.fillText(label, lx + 3, GEO.head + 9);
  }
}

// ---- 全体（ミニマップ） -------------------------------------------------------------

function drawMinimap(ctx: CanvasRenderingContext2D, l: Local, g: Geom, playBeat: number | null, a: AssistState) {
  const s = useEditor.getState();
  const side = useSidecar.getState();
  const doc = s.doc;
  const x = l.w - GEO.miniW;
  const ML = GEO.miniLoopW;
  const { top, bottom, end } = miniGeom(l);
  if (!l.mini || l.mini.doc !== doc || l.mini.h !== l.h || l.mini.endBeat !== end || l.mini.sections !== side.sections) {
    const c = l.mini?.canvas ?? document.createElement('canvas');
    c.width = Math.floor(GEO.miniW * l.dpr);
    c.height = Math.floor(l.h * l.dpr);
    const m = c.getContext('2d')!;
    m.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
    m.fillStyle = '#0D1116';
    m.fillRect(0, 0, GEO.miniW, l.h);
    m.fillStyle = '#0A0D11';
    m.fillRect(0, 0, ML, l.h);
    m.fillStyle = '#1A2029';
    m.fillRect(0, 0, 1, l.h);
    m.fillRect(ML, 0, 1, l.h);
    const tempo = tempoOf(doc);
    const yOf = (b: number) => bottom - (b / end) * (bottom - top);
    // セクションの色
    side.sections.forEach((sc, i) => {
      const b0 = tempo.measureStart(sc.m);
      const b1 = i + 1 < side.sections.length ? tempo.measureStart(side.sections[i + 1].m) : end;
      m.fillStyle = sectionColor(sc.name, side.sectionColors);
      m.globalAlpha = 0.8;
      m.fillRect(ML + 2, yOf(b1), 3, yOf(b0) - yOf(b1));
      m.globalAlpha = 1;
    });
    const lastM = tempo.locate(end).m;
    m.fillStyle = '#1C222B';
    for (let mm = 0; mm <= lastM; mm += 4) {
      const y = yOf(tempo.measureStart(mm));
      m.fillRect(ML + 6, Math.round(y), GEO.miniW - ML - 12, 1);
    }
    for (const v of chipViews(doc)) {
      if (v.col < 0) continue;
      m.fillStyle = DRUM_LANES[v.col].color;
      m.fillRect(ML + 6 + slotOf(v.col) * 6, Math.round(yOf(v.beat)), 5, 1);
    }
    // BPM の変化
    m.fillStyle = C.amber;
    for (const ev of tempo.events.slice(1)) m.fillRect(GEO.miniW - 6, Math.round(yOf(ev.beat)) - 1, 4, 2);
    l.mini = { canvas: c, doc, h: l.h, endBeat: end, sections: side.sections };
  }
  ctx.drawImage(l.mini.canvas, x, 0, GEO.miniW, l.h);
  // 曲の終わり（END）。その先は暗く
  const eb = endBeatOf(doc);
  if (eb !== null) {
    const ye = Math.round(bottom - (eb / end) * (bottom - top));
    if (ye > GEO.head) {
      ctx.fillStyle = 'rgba(4,6,9,.55)';
      ctx.fillRect(x + ML + 1, GEO.head, GEO.miniW - ML - 1, ye - GEO.head);
    }
    ctx.fillStyle = 'rgba(231,235,241,.9)';
    ctx.fillRect(x + ML + 1, ye - 1, GEO.miniW - ML - 1, 1);
  }
  // ループの範囲（左の帯に範囲と A・B の印）。A だけ・B だけのときは、その印と点線
  const miniTab = (ty: number, label: string, col: string) => {
    ctx.font = '700 8px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = col;
    roundRect(ctx, x + 1, ty, ML - 2, 10, 2);
    ctx.fill();
    ctx.fillStyle = '#1A1408';
    ctx.fillText(label, x + ML / 2, ty + 5.5);
  };
  if (a.loop && a.loop.b > a.loop.a) {
    const ya = bottom - (a.loop.b / end) * (bottom - top);
    const yb = bottom - (a.loop.a / end) * (bottom - top);
    const on = a.loop.on;
    const col = on ? C.loop : 'rgba(255,199,104,.5)';
    ctx.fillStyle = on ? 'rgba(255,199,104,.14)' : 'rgba(255,199,104,.06)';
    ctx.fillRect(x + ML + 1, ya, GEO.miniW - ML - 2, Math.max(2, yb - ya));
    ctx.fillStyle = on ? 'rgba(255,199,104,.45)' : 'rgba(255,199,104,.18)';
    ctx.fillRect(x + 2, ya, ML - 4, Math.max(2, yb - ya));
    ctx.fillStyle = col;
    ctx.fillRect(x + 1, Math.round(ya) - 1, GEO.miniW - 2, 1);
    ctx.fillRect(x + 1, Math.round(yb), GEO.miniW - 2, 1);
    miniTab(yb, 'A', col);
    miniTab(ya - 10, 'B', col);
  } else if (a.loopMark) {
    const mk = a.loopMark;
    const y = Math.round(bottom - (mk.beat / end) * (bottom - top)) - (mk.side === 'b' ? 1 : 0);
    ctx.strokeStyle = C.loop;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 1, y + 0.5);
    ctx.lineTo(x + GEO.miniW - 1, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    if (mk.side === 'a') miniTab(y, 'A', C.loop);
    else miniTab(y - 9, 'B', C.loop);
  }
  // 見えている範囲
  const y0 = bottom - (Math.max(0, g.maxBeat) / end) * (bottom - top);
  const y1 = bottom - (Math.max(0, g.minBeat) / end) * (bottom - top);
  ctx.fillStyle = 'rgba(76,194,255,.10)';
  ctx.fillRect(x + ML + 2, Math.max(top - 4, y0), GEO.miniW - ML - 4, Math.max(4, y1 - y0));
  ctx.strokeStyle = 'rgba(76,194,255,.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + ML + 2.5, Math.max(top - 4, y0) + 0.5, GEO.miniW - ML - 5, Math.max(4, y1 - y0));
  // 再生を始める位置
  {
    const y = Math.round(bottom - (s.cursorBeat / end) * (bottom - top));
    ctx.fillStyle = C.accent;
    ctx.beginPath();
    ctx.moveTo(x + ML + 6, y);
    ctx.lineTo(x + ML + 1, y - 4);
    ctx.lineTo(x + ML + 1, y + 4);
    ctx.closePath();
    ctx.fill();
  }
  if (playBeat !== null) {
    const y = bottom - (playBeat / end) * (bottom - top);
    ctx.fillStyle = C.playhead;
    ctx.fillRect(x + ML + 1, Math.round(y), GEO.miniW - ML - 2, 2);
  }
  ctx.fillStyle = '#0E1217';
  ctx.fillRect(x, 0, GEO.miniW, GEO.head);
  ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  ctx.fillText('全体', x + ML + (GEO.miniW - ML) / 2, GEO.head / 2);
  void sectionAt;
}
