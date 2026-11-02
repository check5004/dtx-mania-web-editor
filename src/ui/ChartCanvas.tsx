// 譜面の縦スクロール表示と、マウスでの編集。下から上へ時間が進む（NXと同じ向き）。
import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { toMeasure } from '../dtx/base36';
import { sub, type Frac } from '../dtx/fraction';
import { DRUM_LANES } from '../dtx/model';
import { posToBeatFrac, snapToGrid, type Pos } from '../edit/ops';
import { chipBpmLabel, meterLabel } from './format';
import { COL_BGM, COL_BPM, chipViews, docStats, tempoOf, viewsInRange, type ChipView } from '../store/derived';
import {
  deleteChips,
  moveSelection,
  placeBpmChange,
  placeChip,
  playFrom,
  setCursorBeat,
  setView,
  useEditor,
  zoom,
} from '../store/editor';
import { promptDialog } from './dialogs';

export const GEO = {
  head: 30,
  bottom: 28,
  gutterW: 36,
  bpmX: 36,
  bpmW: 44,
  laneX: 84,
  laneW: 40,
  bgmX: 488,
  bgmW: 28,
  chartW: 516,
  miniW: 72,
};

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
};

type Drag =
  | { type: 'pending'; x0: number; y0: number; lane: number; alt: boolean; pos: Pos }
  | { type: 'rubber'; x0: number; y0: number; x1: number; y1: number; additive: boolean; base: number[] }
  | { type: 'move'; anchor: ChipView; anchorBeat: Frac; grab: number; x0: number; dBeat: Frac | null; dLane: number; moved: boolean; clickedSelected: boolean }
  | { type: 'erase'; ids: Set<number> }
  | { type: 'cursor' }
  | { type: 'mini' };

interface Hover {
  x: number;
  y: number;
  lane: number;
  pos: Pos | null;
  alt: boolean;
}

interface Local {
  w: number;
  h: number;
  dpr: number;
  dirty: boolean;
  drag: Drag | null;
  hover: Hover | null;
  followScroll: number | null;
  mini: { canvas: HTMLCanvasElement; doc: unknown; h: number; endBeat: number } | null;
  pointer: { x: number; y: number } | null;
}

export function ChartCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const L = useRef<Local>({ w: 0, h: 0, dpr: 1, dirty: true, drag: null, hover: null, followScroll: null, mini: null, pointer: null });

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
      l.mini = null;
      l.dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const unsub = useEditor.subscribe(() => {
      l.dirty = true;
    });

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const playing = engine.playing;
      if (!playing && l.followScroll !== null) {
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
      unsub();
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
    if (!h) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    l.pointer = { x, y };
    if (e.button === 2) {
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
    if (h.kind === 'gutter' || h.kind === 'header') {
      l.drag = { type: 'cursor' };
      const beat = Math.max(0, g.yToBeat(y));
      const p = snapToGrid(tempoOf(s.doc), beat, s.view.div);
      setCursorBeat(tempoOf(s.doc).beatOf(p.m, p.f));
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
    if (h.kind === 'lane' || h.kind === 'bgm' || h.kind === 'bpm') {
      const beat = Math.max(0, g.yToBeat(y));
      const pos = snapToGrid(tempoOf(s.doc), beat, s.view.div);
      l.drag = { type: 'pending', x0: x, y0: y, lane: h.kind === 'lane' ? h.lane : -1, alt: e.shiftKey, pos };
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
      } else {
        l.hover = h && h.kind !== 'mini' ? { x, y, lane: -1, pos: null, alt: false } : null;
      }
      canvasRef.current!.style.cursor = h?.kind === 'chip' ? 'grab' : h?.kind === 'gutter' || h?.kind === 'mini' ? 'ns-resize' : 'default';
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
    if (d.type === 'mini') {
      scrollFromMini(l, y);
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
      if (d.lane >= 0) placeChip(d.lane, d.alt, d.pos);
      else useEditor.setState({ selection: [] });
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
    if (d.type === 'move') {
      if (d.moved && d.dBeat) {
        if (!moveSelection(d.dBeat, d.dLane)) {
          // 範囲外には動かせない
        }
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
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="譜面"
      />
    </div>
  );
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

function geom(l: Local, scroll: number, px: number): Geom {
  const ox = Math.max(8, Math.floor((l.w - GEO.miniW - GEO.chartW) / 2));
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
  | { kind: 'bpm' }
  | { kind: 'bgm' }
  | { kind: 'header' }
  | { kind: 'mini' };

function colAt(g: Geom, x: number): number | 'gutter' | null {
  const rx = x - g.ox;
  if (rx < 0) return null;
  if (rx < GEO.bpmX) return 'gutter';
  if (rx < GEO.laneX) return COL_BPM;
  if (rx < GEO.laneX + GEO.laneW * 10) return Math.floor((rx - GEO.laneX) / GEO.laneW);
  if (rx >= GEO.bgmX - 2 && rx < GEO.bgmX + GEO.bgmW) return COL_BGM;
  return null;
}

function hitTest(l: Local, g: Geom, x: number, y: number): Hit | null {
  if (x >= l.w - GEO.miniW) return { kind: 'mini' };
  if (y < GEO.head) return { kind: 'header' };
  const col = colAt(g, x);
  if (col === null) return null;
  if (col === 'gutter') return { kind: 'gutter' };
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
  return { kind: 'lane', lane: col };
}

function chipsInRect(l: Local, g: Geom, x0: number, y0: number, x1: number, y1: number): number[] {
  const s = useEditor.getState();
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const b0 = g.yToBeat(Math.max(y0, y1));
  const b1 = g.yToBeat(Math.min(y0, y1));
  const out: number[] = [];
  for (const v of viewsInRange(chipViews(s.doc), b0, b1)) {
    const cx = g.ox + colCenter(v.col);
    if (cx >= xa && cx <= xb) out.push(v.c.id);
  }
  void l;
  return out;
}

function colCenter(col: number): number {
  if (col >= 0) return GEO.laneX + col * GEO.laneW + GEO.laneW / 2;
  if (col === COL_BPM) return GEO.bpmX + GEO.bpmW / 2;
  return GEO.bgmX + GEO.bgmW / 2;
}

function miniEnd(): number {
  const s = useEditor.getState();
  return Math.max(docStats(s.doc).lastBeat + 16, 64);
}

function scrollFromMini(l: Local, y: number) {
  const s = useEditor.getState();
  const top = GEO.head + 6;
  const bottom = l.h - 6;
  const end = miniEnd();
  const beat = ((bottom - y) / (bottom - top)) * end;
  const viewBeats = (l.h - GEO.head - GEO.bottom) / s.view.pxPerBeat;
  l.followScroll = null;
  setView({ scrollBeat: Math.max(-2, beat - viewBeats / 2), follow: false });
}

function autoScrollWhileDragging(l: Local) {
  const d = l.drag;
  if (!d || !l.pointer || (d.type !== 'move' && d.type !== 'rubber' && d.type !== 'erase')) return;
  const s = useEditor.getState();
  const { y } = l.pointer;
  let v = 0;
  if (y < GEO.head + 24) v = (GEO.head + 24 - y) / 6;
  else if (y > l.h - 16) v = -(y - (l.h - 16)) / 6;
  if (v === 0) return;
  setView({ scrollBeat: Math.max(-2, s.view.scrollBeat + v / s.view.pxPerBeat * 4) });
  if (d.type === 'rubber') l.dirty = true;
}

// ---- 描画 ---------------------------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function draw(ctx: CanvasRenderingContext2D, l: Local) {
  const s = useEditor.getState();
  const doc = s.doc;
  const tempo = tempoOf(doc);
  const views = chipViews(doc);
  const px = s.view.pxPerBeat;
  const div = s.view.div;
  let scroll = s.view.scrollBeat;
  let playBeat: number | null = null;
  const sec = engine.currentSec();
  if (sec !== null) {
    playBeat = tempo.secToBeat(sec);
    if (s.view.follow) {
      scroll = playBeat - ((l.h - GEO.head - GEO.bottom) * 0.22) / px;
      l.followScroll = scroll;
    }
  }
  const g = geom(l, scroll, px);
  const { ox } = g;
  const W = l.w;
  const H = l.h;

  ctx.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // 列の背景
  ctx.fillStyle = C.col;
  ctx.fillRect(ox, GEO.head, GEO.bpmX, H);
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
  ctx.fillRect(ox + GEO.bgmX - 0.5, GEO.head, 1, H);
  ctx.fillRect(ox + GEO.bgmX + GEO.bgmW - 0.5, GEO.head, 1, H);

  // グリッド
  const firstM = tempo.locate(Math.max(0, g.minBeat)).m;
  const lastM = tempo.locate(Math.max(0, g.maxBeat)).m;
  const x0 = ox + GEO.bpmX;
  const x1 = ox + GEO.bgmX + GEO.bgmW;
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';
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
    if (y >= GEO.head - 2 && y <= H + 2) {
      ctx.fillStyle = C.measure;
      ctx.fillRect(x0, y - 1, x1 - x0, 2);
      ctx.fillStyle = C.text;
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

  // BPM（曲頭の #BPM と変化）
  ctx.textAlign = 'left';
  for (const ev of tempo.events) {
    const y = g.beatToY(ev.beat);
    if (y < GEO.head - 10 || y > H + 10) continue;
    ctx.fillStyle = C.amber;
    ctx.fillRect(ox + GEO.bpmX + 2, Math.round(y) - 1, GEO.bpmW - 4, 2);
    ctx.fillText(chipBpmLabel(ev.bpm), ox + GEO.bpmX + 4, y - 8);
  }

  const sel = new Set(s.selection);
  const d = l.drag;
  const erasing = d?.type === 'erase' ? d.ids : null;
  const moving = d?.type === 'move' && d.moved && d.dBeat ? d : null;
  const visible = viewsInRange(views, g.minBeat - 0.5, g.maxBeat + 0.5);

  const drawChip = (v: ChipView, beat: number, col: number, alpha: number, selected: boolean) => {
    const y = g.beatToY(beat);
    if (col >= 0) {
      const lane = DRUM_LANES[col];
      const color = v.alt && lane.altColor ? lane.altColor : lane.color;
      const cx = ox + GEO.laneX + col * GEO.laneW + GEO.laneW / 2;
      ctx.globalAlpha = alpha;
      roundRect(ctx, cx - 17, y - 5, 34, 10, 3);
      if (v.kind === 'normal') {
        ctx.fillStyle = color;
        ctx.fill();
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
      }
      ctx.globalAlpha = 1;
      return;
    }
    const cx = ox + colCenter(col);
    ctx.globalAlpha = alpha;
    if (col === COL_BGM) {
      roundRect(ctx, cx - 11, y - 4, 22, 8, 2);
      ctx.fillStyle = v.c.ch === 1 ? C.bgm : C.se;
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

  for (const v of visible) {
    if (erasing?.has(v.c.id)) continue;
    const selected = sel.has(v.c.id);
    drawChip(v, v.beat, v.col, moving && selected ? 0.25 : 1, selected && !moving);
  }

  // 移動中のプレビュー
  if (moving) {
    const dB = moving.dBeat!.n / moving.dBeat!.d;
    for (const v of views) {
      if (!sel.has(v.c.id)) continue;
      const col = v.col >= 0 ? v.col + moving.dLane : v.col;
      if (v.col >= 0 && (col < 0 || col > 9)) continue;
      drawChip(v, v.beat + dB, col, 0.9, true);
    }
  }

  // 置く位置のプレビュー
  const hv = l.hover;
  if (hv && hv.pos && !d) {
    const lane = DRUM_LANES[hv.lane];
    const b = tempo.beatOf(hv.pos.m, hv.pos.f);
    const y = g.beatToY(b);
    const cx = ox + GEO.laneX + hv.lane * GEO.laneW + GEO.laneW / 2;
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

  // カーソル（F6で再生を始める位置）
  {
    const y = Math.round(g.beatToY(s.cursorBeat)) + 0.5;
    if (y >= GEO.head && y <= H) {
      ctx.strokeStyle = C.accent;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox + GEO.bpmX, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.moveTo(ox + GEO.bpmX - 1, y);
      ctx.lineTo(ox + GEO.bpmX - 8, y - 5);
      ctx.lineTo(ox + GEO.bpmX - 8, y + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 再生位置
  if (playBeat !== null) {
    const y = Math.round(g.beatToY(playBeat));
    ctx.fillStyle = C.playhead;
    ctx.fillRect(ox, y - 1, x1 - ox, 2);
    ctx.shadowColor = C.playhead;
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
  DRUM_LANES.forEach((lane, i) => {
    const cx = ox + GEO.laneX + i * GEO.laneW + GEO.laneW / 2;
    ctx.fillStyle = lane.color;
    ctx.fillText(lane.key, cx, GEO.head / 2);
  });
  ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = C.text;
  ctx.fillText('BGM', ox + GEO.bgmX + GEO.bgmW / 2, GEO.head / 2);

  drawMinimap(ctx, l, g, playBeat);
}

function drawMinimap(ctx: CanvasRenderingContext2D, l: Local, g: Geom, playBeat: number | null) {
  const s = useEditor.getState();
  const doc = s.doc;
  const x = l.w - GEO.miniW;
  const top = GEO.head + 6;
  const bottom = l.h - 6;
  const end = miniEnd();
  if (!l.mini || l.mini.doc !== doc || l.mini.h !== l.h || l.mini.endBeat !== end) {
    const c = l.mini?.canvas ?? document.createElement('canvas');
    c.width = Math.floor(GEO.miniW * l.dpr);
    c.height = Math.floor(l.h * l.dpr);
    const m = c.getContext('2d')!;
    m.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
    m.fillStyle = '#0D1116';
    m.fillRect(0, 0, GEO.miniW, l.h);
    m.fillStyle = '#1A2029';
    m.fillRect(0, 0, 1, l.h);
    const tempo = tempoOf(doc);
    const lastM = tempo.locate(end).m;
    m.fillStyle = '#1C222B';
    for (let mm = 0; mm <= lastM; mm += 4) {
      const y = bottom - (tempo.measureStart(mm) / end) * (bottom - top);
      m.fillRect(6, Math.round(y), GEO.miniW - 12, 1);
    }
    for (const v of chipViews(doc)) {
      if (v.col < 0) continue;
      const y = bottom - (v.beat / end) * (bottom - top);
      m.fillStyle = DRUM_LANES[v.col].color;
      m.fillRect(6 + v.col * 6, Math.round(y), 5, 1);
    }
    l.mini = { canvas: c, doc, h: l.h, endBeat: end };
  }
  ctx.drawImage(l.mini.canvas, x, 0, GEO.miniW, l.h);
  // 見えている範囲
  const y0 = bottom - (Math.max(0, g.maxBeat) / end) * (bottom - top);
  const y1 = bottom - (Math.max(0, g.minBeat) / end) * (bottom - top);
  ctx.fillStyle = 'rgba(76,194,255,.10)';
  ctx.fillRect(x + 2, Math.max(top - 4, y0), GEO.miniW - 4, Math.max(4, y1 - y0));
  ctx.strokeStyle = 'rgba(76,194,255,.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 2.5, Math.max(top - 4, y0) + 0.5, GEO.miniW - 5, Math.max(4, y1 - y0));
  if (playBeat !== null) {
    const y = bottom - (playBeat / end) * (bottom - top);
    ctx.fillStyle = C.playhead;
    ctx.fillRect(x + 2, Math.round(y), GEO.miniW - 4, 2);
  }
  ctx.fillStyle = '#0E1217';
  ctx.fillRect(x, 0, GEO.miniW, GEO.head);
  ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  ctx.fillText('全体', x + GEO.miniW / 2, GEO.head / 2);
}
