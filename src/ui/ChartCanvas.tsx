// 譜面の縦スクロール表示と、マウスでの編集。下から上へ時間が進む（NXと同じ向き）。
// 右に「原曲の打点（低・中・高）」と「原曲の波形」の列、レーンには候補チップ（点線）を出す。
import { useEffect, useRef, useState } from 'react';
import type { Onset } from '../audio/analysis';
import { engine } from '../audio/engine';
import type { Ghost } from '../assist/ghosts';
import { sameMeasures } from '../assist/similar';
import { toMeasure } from '../dtx/base36';
import { sub, type Frac } from '../dtx/fraction';
import { DRUM_LANES } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { posToBeatFrac, snapToGrid, type Pos } from '../edit/ops';
import { bandOnsets, currentGhosts, dismissGhosts, ghostsInRange, setLoop, setWaveMode, useAssist, type AssistState } from '../store/assist';
import { bgmSource, COL_BGM, COL_BPM, chipViews, docStats, tempoOf, viewsInRange, type ChipView } from '../store/derived';
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
import { sectionAt, sectionColor, useSidecar } from '../store/sidecar';
import { promptDialog } from './dialogs';
import { songLength } from './hooks';
import { chipBpmLabel, meterLabel } from './format';
import { SectionPopover } from './SectionPopover';

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
  hitsX: 520,
  hitsW: 64,
  waveX: 588,
  waveW: 108,
  miniW: 72,
};

const BASE_W = GEO.bgmX + GEO.bgmW;
const FULL_W = GEO.waveX + GEO.waveW;

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

type Drag =
  | { type: 'pending'; x0: number; y0: number; lane: number; alt: boolean; pos: Pos }
  | { type: 'rubber'; x0: number; y0: number; x1: number; y1: number; additive: boolean; base: number[] }
  | { type: 'move'; anchor: ChipView; anchorBeat: Frac; grab: number; x0: number; dBeat: Frac | null; dLane: number; moved: boolean; clickedSelected: boolean }
  | { type: 'erase'; ids: Set<number>; ghosts: Set<string> }
  | { type: 'cursor' }
  | { type: 'loop'; a: number; b: number }
  | { type: 'mini' };

interface Hover {
  x: number;
  y: number;
  lane: number;
  pos: Pos | null;
  alt: boolean;
  ghost: Ghost | null;
}

interface Local {
  w: number;
  h: number;
  dpr: number;
  dirty: boolean;
  drag: Drag | null;
  hover: Hover | null;
  followScroll: number | null;
  mini: { canvas: HTMLCanvasElement; doc: unknown; h: number; endBeat: number; ghosts: unknown; sections: unknown } | null;
  spec: { canvas: HTMLCanvasElement; data: unknown } | null;
  pointer: { x: number; y: number } | null;
}

/** 右のパネルから「表示中の範囲」を知るための値 */
const viewport = { h: 600, follow: null as number | null };

/** 譜面で見えている拍の範囲 */
export function visibleBeats(): { from: number; to: number } {
  const s = useEditor.getState();
  const scroll = engine.playing && viewport.follow !== null ? viewport.follow : s.view.scrollBeat;
  return { from: Math.max(0, scroll), to: Math.max(0, scroll + (viewport.h - GEO.head - GEO.bottom) / s.view.pxPerBeat) };
}

function chartWidth(): number {
  return useAssist.getState().audioCols ? FULL_W : BASE_W;
}

export function ChartCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const L = useRef<Local>({ w: 0, h: 0, dpr: 1, dirty: true, drag: null, hover: null, followScroll: null, mini: null, spec: null, pointer: null });
  const [popover, setPopover] = useState<{ m: number; x: number; y: number } | null>(null);
  const [help, setHelp] = useState<{ x: number; y: number } | null>(null);
  const inputMode = useAssist((s) => s.inputMode);
  const playing = useEditor((s) => s.playing);
  const div = useEditor((s) => s.view.div);

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
      l.mini = null;
      l.dirty = true;
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
    ];

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
    if (!h) return;
    // 見出しのボタン
    if (h.kind === 'header') {
      const rx = x - g.ox;
      if (useAssist.getState().audioCols && rx >= GEO.hitsX && rx < GEO.hitsX + GEO.hitsW) {
        setHelp({ x: g.ox + GEO.hitsX, y: GEO.head + 4 });
        return;
      }
      if (useAssist.getState().audioCols && rx >= GEO.waveX && rx < GEO.waveX + GEO.waveW) {
        setWaveMode(useAssist.getState().waveMode === 'wave' ? 'spec' : 'wave');
        return;
      }
    }
    if (h.kind === 'section') {
      setPopover({ m: h.m, x: g.ox + GEO.bpmX + 4, y: Math.max(GEO.head + 4, y - 10) });
      return;
    }
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    l.pointer = { x, y };
    if (e.button === 2) {
      if (h.kind === 'chip') {
        l.drag = { type: 'erase', ids: new Set([h.view.c.id]), ghosts: new Set() };
        l.dirty = true;
      } else if (h.kind === 'ghost') {
        l.drag = { type: 'erase', ids: new Set(), ghosts: new Set([h.ghost.key]) };
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
    if (h.kind === 'ghost') {
      // 候補を採用（その位置にチップを置く）
      placeChip(h.ghost.lane, false, h.ghost.pos);
      return;
    }
    if (h.kind === 'gutter' || h.kind === 'header' || h.kind === 'audio') {
      const tempo = tempoOf(s.doc);
      const beat = Math.max(0, g.yToBeat(y));
      const p = snapToGrid(tempo, beat, s.view.div);
      const b = tempo.beatOf(p.m, p.f);
      if (e.shiftKey && h.kind === 'gutter') {
        l.drag = { type: 'loop', a: b, b };
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
        l.hover = { x, y, lane: h.lane, pos, alt: e.shiftKey, ghost: null };
      } else if (h && h.kind === 'ghost') {
        l.hover = { x, y, lane: h.ghost.lane, pos: null, alt: false, ghost: h.ghost };
      } else {
        l.hover = h && h.kind !== 'mini' ? { x, y, lane: -1, pos: null, alt: false, ghost: null } : null;
      }
      const cur =
        h?.kind === 'chip'
          ? 'grab'
          : h?.kind === 'ghost' || h?.kind === 'section'
            ? 'pointer'
            : h?.kind === 'gutter' || h?.kind === 'mini' || h?.kind === 'audio'
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
    if (d.type === 'erase') {
      const h = hitTest(l, g, x, y);
      if (h?.kind === 'chip') d.ids.add(h.view.c.id);
      if (h?.kind === 'ghost') d.ghosts.add(h.ghost.key);
      return;
    }
    if (d.type === 'cursor') {
      const tempo = tempoOf(s.doc);
      const p = snapToGrid(tempo, Math.max(0, g.yToBeat(y)), s.view.div);
      setCursorBeat(tempo.beatOf(p.m, p.f));
      return;
    }
    if (d.type === 'loop') {
      const tempo = tempoOf(s.doc);
      const p = snapToGrid(tempo, Math.max(0, g.yToBeat(y)), s.view.div);
      d.b = tempo.beatOf(p.m, p.f);
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
      dismissGhosts([...d.ghosts]);
      return;
    }
    if (d.type === 'cursor') {
      if (engine.playing) void playFrom(s.cursorBeat);
      return;
    }
    if (d.type === 'loop') {
      const a = Math.min(d.a, d.b);
      let b = Math.max(d.a, d.b);
      if (b - a < 1e-6) {
        // クリックだけならその小節
        const tempo = tempoOf(s.doc);
        const { m } = tempo.locate(a);
        setLoop({ on: true, a: tempo.measureStart(m), b: tempo.measureStart(m + 1) });
        return;
      }
      if (b <= a) b = a + 1;
      setLoop({ on: true, a, b });
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
    if (h?.kind === 'gutter') {
      // 小節番号のダブルクリック：その小節からセクションを始める（カーソルと同じく吸着した位置の小節）
      const { m } = snapToGrid(tempoOf(s.doc), Math.max(0, g.yToBeat(y)), s.view.div);
      setPopover({ m, x: g.ox + GEO.bpmX + 4, y: Math.max(GEO.head + 4, y - 10) });
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
      {popover && <SectionPopover m={popover.m} x={popover.x} y={popover.y} onClose={() => setPopover(null)} />}
      {help && (
        <div className="popover" style={{ left: help.x - 200, top: help.y, width: 280 }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="row" style={{ marginBottom: 6 }}>
            <b>原曲の打点（低・中・高）</b>
            <span className="grow" />
            <button className="ib" style={{ width: 24, height: 24 }} onClick={() => setHelp(null)} aria-label="閉じる">
              ✕
            </button>
          </div>
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
            波形だけでは埋もれて見えない音を探す目印で、点線の候補チップもここから作っています。「原曲の波形」の見出しをクリックするとスペクトログラムに切り替わります。
          </p>
        </div>
      )}
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
  | { kind: 'ghost'; ghost: Ghost }
  | { kind: 'lane'; lane: number }
  | { kind: 'gutter' }
  | { kind: 'section'; m: number }
  | { kind: 'bpm' }
  | { kind: 'bgm' }
  | { kind: 'audio' }
  | { kind: 'header' }
  | { kind: 'mini' };

function colAt(g: Geom, x: number): number | 'gutter' | 'audio' | null {
  const rx = x - g.ox;
  if (rx < 0) return null;
  if (rx < GEO.bpmX) return 'gutter';
  if (rx < GEO.laneX) return COL_BPM;
  if (rx < GEO.laneX + GEO.laneW * 10) return Math.floor((rx - GEO.laneX) / GEO.laneW);
  if (rx >= GEO.bgmX - 2 && rx < GEO.bgmX + GEO.bgmW) return COL_BGM;
  if (useAssist.getState().audioCols && rx >= GEO.hitsX && rx < FULL_W) return 'audio';
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

function hitTest(l: Local, g: Geom, x: number, y: number): Hit | null {
  if (x >= l.w - GEO.miniW) return { kind: 'mini' };
  if (y < GEO.head) return { kind: 'header' };
  const sm = sectionTagAt(g, x, y);
  if (sm !== null) return { kind: 'section', m: sm };
  const col = colAt(g, x);
  if (col === null) return null;
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
  if (col >= 0) {
    let bg: Ghost | null = null;
    let bd = Infinity;
    for (const gh of ghostsInRange(beat - tol, beat + tol)) {
      if (gh.lane !== col) continue;
      const dd = Math.abs(gh.beat - beat);
      if (dd < bd) {
        bg = gh;
        bd = dd;
      }
    }
    if (bg) return { kind: 'ghost', ghost: bg };
  }
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
  let end = Math.max(docStats(s.doc).lastBeat + 16, 64);
  // 譜面が空でも、原曲・映像の長さぶんは見せる
  const len = songLength(s.doc);
  if (len > 0) end = Math.max(end, tempoOf(s.doc).secToBeat(len) + 4);
  return end;
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
  if (!d || !l.pointer || (d.type !== 'move' && d.type !== 'rubber' && d.type !== 'erase' && d.type !== 'loop')) return;
  const s = useEditor.getState();
  const { y } = l.pointer;
  let v = 0;
  if (y < GEO.head + 24) v = (GEO.head + 24 - y) / 6;
  else if (y > l.h - 16) v = -(y - (l.h - 16)) / 6;
  if (v === 0) return;
  setView({ scrollBeat: Math.max(-2, s.view.scrollBeat + (v / s.view.pxPerBeat) * 4) });
  l.dirty = true;
}

// ---- 描画 ---------------------------------------------------------------------

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
  const sec = engine.currentSec();
  if (sec !== null) {
    playBeat = tempo.secToBeat(sec);
    if (s.view.follow) {
      scroll = playBeat - ((l.h - GEO.head - GEO.bottom) * 0.22) / px;
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

  // ループの範囲
  if (a.loop && a.loop.b > a.loop.a) {
    const y0 = g.beatToY(a.loop.b);
    const y1 = g.beatToY(a.loop.a);
    ctx.fillStyle = a.loop.on ? 'rgba(255,199,104,.055)' : 'rgba(255,199,104,.025)';
    ctx.fillRect(ox + GEO.bpmX, y0, GEO.bgmX + GEO.bgmW - GEO.bpmX, y1 - y0);
    ctx.fillStyle = a.loop.on ? C.loop : 'rgba(255,199,104,.4)';
    ctx.fillRect(ox + 2, y0, 3, y1 - y0);
    ctx.fillRect(ox + GEO.bpmX, Math.round(y0), GEO.bgmX + GEO.bgmW - GEO.bpmX, 1);
    ctx.fillRect(ox + GEO.bpmX, Math.round(y1), GEO.bgmX + GEO.bgmW - GEO.bpmX, 1);
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
      ctx.fillRect(ox + 6, yEnd + 2, 3, y - yEnd - 4);
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

  const sel = new Set(s.selection);
  const d = l.drag;
  const erasing = d?.type === 'erase' ? d.ids : null;
  const erasingGhosts = d?.type === 'erase' ? d.ghosts : null;
  const moving = d?.type === 'move' && d.moved && d.dBeat ? d : null;
  const visible = viewsInRange(views, g.minBeat - 0.5, g.maxBeat + 0.5);

  // 候補チップ（点線）
  if (a.ghostsOn && a.data) {
    const hv = l.hover?.ghost?.key;
    for (const gh of ghostsInRange(g.minBeat - 0.5, g.maxBeat + 0.5)) {
      if (erasingGhosts?.has(gh.key)) continue;
      const lane = DRUM_LANES[gh.lane];
      const y = g.beatToY(gh.beat);
      const cx = ox + GEO.laneX + gh.lane * GEO.laneW + GEO.laneW / 2;
      ctx.globalAlpha = hv === gh.key ? 1 : 0.45 + 0.45 * gh.s;
      roundRect(ctx, cx - 16, y - 5, 32, 10, 3);
      ctx.fillStyle = hv === gh.key ? lane.color + '55' : 'rgba(255,255,255,.04)';
      ctx.fill();
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = lane.color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

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
  // ループ範囲のドラッグ
  if (d?.type === 'loop') {
    const ya = g.beatToY(Math.max(d.a, d.b));
    const yb = g.beatToY(Math.min(d.a, d.b));
    ctx.fillStyle = 'rgba(255,199,104,.12)';
    ctx.fillRect(ox, ya, x1 - ox, Math.max(2, yb - ya));
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
      ctx.lineTo(ox + cw, y);
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
    ctx.fillStyle = a.inputMode === 'rec' ? '#FF5A61' : C.playhead;
    ctx.fillRect(ox, y - 1, cw, 2);
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
  const ms = new Set(a.mute);
  const ss = new Set(a.solo);
  DRUM_LANES.forEach((lane, i) => {
    const cx = ox + GEO.laneX + i * GEO.laneW + GEO.laneW / 2;
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
  if (a.audioCols) {
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = '#A3ADBB';
    ctx.fillText('原曲の打点 ⓘ', ox + GEO.hitsX + GEO.hitsW / 2, 8);
    ctx.font = '600 10px system-ui, sans-serif';
    (['low', 'mid', 'high'] as const).forEach((b, i) => {
      ctx.fillStyle = C[b];
      ctx.fillText(['低', '中', '高'][i], ox + GEO.hitsX + 11 + i * 20, 21);
    });
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = C.text;
    ctx.fillText(a.waveMode === 'wave' ? '原曲の波形 ⇄' : 'スペクトル ⇄', ox + GEO.waveX + GEO.waveW / 2, GEO.head / 2);
  }

  drawMinimap(ctx, l, g, playBeat, a);
}

// ---- 原曲の列 -------------------------------------------------------------------

function drawAudioCols(ctx: CanvasRenderingContext2D, l: Local, g: Geom, tempo: TempoMap, a: AssistState, H: number) {
  const { ox } = g;
  const hx = ox + GEO.hitsX;
  const wx = ox + GEO.waveX;
  ctx.fillStyle = '#0D1015';
  ctx.fillRect(hx, GEO.head, GEO.hitsW, H);
  ctx.fillRect(wx, GEO.head, GEO.waveW, H);
  ctx.fillStyle = C.sep;
  ctx.fillRect(hx - 0.5, GEO.head, 1, H);
  ctx.fillRect(wx - 0.5, GEO.head, 1, H);
  ctx.fillRect(wx + GEO.waveW - 0.5, GEO.head, 1, H);
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  if (!a.data || !bgm) {
    ctx.save();
    ctx.translate(wx + GEO.waveW / 2, (GEO.head + H) / 2);
    ctx.fillStyle = C.dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const msg =
      a.status === 'loading'
        ? `原曲を解析中… ${Math.round(a.progress * 100)}%`
        : a.status === 'error'
          ? `解析できませんでした`
          : '原曲（BGM）がありません';
    ctx.fillText(msg, 0, 0);
    if (a.status === 'nosource' || a.status === 'none') {
      ctx.fillText('曲フォルダを開くか、', 0, 18);
      ctx.fillText('テンポ合わせで指定', 0, 34);
    }
    ctx.restore();
    return;
  }
  const data = a.data;
  const off = bgm.sec;
  const audioAt = (y: number) => tempo.beatToSec(g.yToBeat(y)) - off;

  // 小節線を薄く通す
  // 波形 / スペクトログラム
  if (a.waveMode === 'spec' && a.spectro) {
    drawSpectro(ctx, l, g, tempo, off, a.spectro, wx, H);
  } else {
    ctx.fillStyle = C.wave;
    const pr = data.peakRate;
    const n = data.peaks.length;
    const mid = wx + GEO.waveW / 2;
    const half = GEO.waveW / 2 - 4;
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
    if (a.waveMode === 'spec') {
      ctx.fillStyle = C.dim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(a.spectroStatus === 'error' ? '作れませんでした' : '作成中…', mid, GEO.head + 14);
    }
  }

  // 打点の強さ（薄い帯）と打点（横棒）
  const fr = data.frameRate;
  const bands = ['low', 'mid', 'high'] as const;
  bands.forEach((b, bi) => {
    const odf = data.odf[b];
    const cx = hx + 2 + bi * 20;
    ctx.fillStyle = C[b];
    ctx.globalAlpha = 0.18;
    for (let y = GEO.head; y < H; y += 2) {
      const tTop = audioAt(y);
      const tBot = audioAt(y + 2);
      let i0 = Math.floor(Math.min(tTop, tBot) * fr);
      let i1 = Math.ceil(Math.max(tTop, tBot) * fr);
      if (i1 < 0 || i0 >= odf.length) continue;
      i0 = Math.max(0, i0);
      i1 = Math.min(odf.length - 1, i1);
      let m = 0;
      for (let i = i0; i <= i1; i++) if (odf[i] > m) m = odf[i];
      if (m < 0.04) continue;
      const w = Math.min(18, m * 18);
      ctx.fillRect(cx + (18 - w) / 2, y, w, 2);
    }
    ctx.globalAlpha = 1;
  });
  const on = bandOnsets();
  if (on) {
    const tMin = Math.min(audioAt(H), audioAt(GEO.head));
    const tMax = Math.max(audioAt(H), audioAt(GEO.head));
    bands.forEach((b, bi) => {
      const list: Onset[] = on[b];
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const md = (lo + hi) >> 1;
        if (list[md].t < tMin) lo = md + 1;
        else hi = md;
      }
      const cx = hx + 2 + bi * 20;
      ctx.fillStyle = C[b];
      for (let i = lo; i < list.length && list[i].t <= tMax; i++) {
        const o = list[i];
        const y = g.beatToY(tempo.secToBeat(o.t + off));
        const w = Math.max(3, Math.round(18 * Math.min(1, o.s)));
        ctx.fillRect(cx + (18 - w) / 2, y - 2.5, w, 5);
      }
    });
  }
}

const SPEC_COLORS = (() => {
  // 暗い紺 → 青緑 → 黄
  const stops: [number, number, number, number][] = [
    [0, 11, 14, 19],
    [0.35, 22, 60, 110],
    [0.6, 40, 150, 170],
    [0.8, 160, 210, 120],
    [1, 255, 230, 120],
  ];
  const out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    out[i * 4] = r0 + (r1 - r0) * f;
    out[i * 4 + 1] = g0 + (g1 - g0) * f;
    out[i * 4 + 2] = b0 + (b1 - b0) * f;
    out[i * 4 + 3] = 255;
  }
  return out;
})();

function drawSpectro(ctx: CanvasRenderingContext2D, l: Local, g: Geom, tempo: TempoMap, off: number, sp: NonNullable<AssistState['spectro']>, wx: number, H: number) {
  if (!l.spec || l.spec.data !== sp) {
    // 縦（下が古い時刻）× 横（周波数、左が低い）の画像を作る
    const frames = Math.min(sp.frames, 32000);
    const c = document.createElement('canvas');
    c.width = sp.bins;
    c.height = Math.max(1, frames);
    const cx = c.getContext('2d')!;
    const img = cx.createImageData(sp.bins, Math.max(1, frames));
    for (let f = 0; f < frames; f++) {
      const row = frames - 1 - f;
      for (let b = 0; b < sp.bins; b++) {
        const v = sp.data[f * sp.bins + b];
        const o = (row * sp.bins + b) * 4;
        img.data[o] = SPEC_COLORS[v * 4];
        img.data[o + 1] = SPEC_COLORS[v * 4 + 1];
        img.data[o + 2] = SPEC_COLORS[v * 4 + 2];
        img.data[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    l.spec = { canvas: c, data: sp };
  }
  const frames = l.spec.canvas.height;
  const evs = tempo.events;
  ctx.imageSmoothingEnabled = true;
  // テンポが一定の区間ごとに1回ずつ伸ばして描く
  for (let i = 0; i < evs.length; i++) {
    const bA = Math.max(evs[i].beat, g.minBeat);
    const bB = Math.min(i + 1 < evs.length ? evs[i + 1].beat : Infinity, g.maxBeat + 1);
    if (bB <= bA) continue;
    const fA = (tempo.beatToSec(bA) - off) * sp.rate;
    const fB = (tempo.beatToSec(bB) - off) * sp.rate;
    const fa = Math.max(0, fA);
    const fb = Math.min(frames, fB);
    if (fb <= fa) continue;
    const yA = g.beatToY(tempo.secToBeat(fa / sp.rate + off));
    const yB = g.beatToY(tempo.secToBeat(fb / sp.rate + off));
    const top = Math.max(GEO.head, yB);
    const bottom = Math.min(H, yA);
    if (bottom <= top) continue;
    // 画像の行は下が古い：行 = frames - フレーム
    const srcTop = frames - fb + ((top - yB) / (yA - yB)) * (fb - fa);
    const srcH = ((bottom - top) / (yA - yB)) * (fb - fa);
    ctx.drawImage(l.spec.canvas, 0, srcTop, l.spec.canvas.width, Math.max(0.5, srcH), wx + 1, top, GEO.waveW - 2, bottom - top);
  }
}

// ---- 全体（ミニマップ） -------------------------------------------------------------

function drawMinimap(ctx: CanvasRenderingContext2D, l: Local, g: Geom, playBeat: number | null, a: AssistState) {
  const s = useEditor.getState();
  const side = useSidecar.getState();
  const doc = s.doc;
  const x = l.w - GEO.miniW;
  const top = GEO.head + 6;
  const bottom = l.h - 6;
  const end = miniEnd();
  const ghosts = a.ghostsOn && a.data ? currentGhosts() : null;
  if (!l.mini || l.mini.doc !== doc || l.mini.h !== l.h || l.mini.endBeat !== end || l.mini.ghosts !== ghosts || l.mini.sections !== side.sections) {
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
    const yOf = (b: number) => bottom - (b / end) * (bottom - top);
    // セクションの色
    side.sections.forEach((sc, i) => {
      const b0 = tempo.measureStart(sc.m);
      const b1 = i + 1 < side.sections.length ? tempo.measureStart(side.sections[i + 1].m) : end;
      m.fillStyle = sectionColor(sc.name, side.sectionColors);
      m.globalAlpha = 0.8;
      m.fillRect(2, yOf(b1), 3, yOf(b0) - yOf(b1));
      m.globalAlpha = 1;
    });
    const lastM = tempo.locate(end).m;
    m.fillStyle = '#1C222B';
    for (let mm = 0; mm <= lastM; mm += 4) {
      const y = yOf(tempo.measureStart(mm));
      m.fillRect(6, Math.round(y), GEO.miniW - 12, 1);
    }
    if (ghosts) {
      m.globalAlpha = 0.35;
      for (const gh of ghosts) {
        m.fillStyle = DRUM_LANES[gh.lane].color;
        m.fillRect(6 + gh.lane * 6, Math.round(yOf(gh.beat)), 5, 1);
      }
      m.globalAlpha = 1;
    }
    for (const v of chipViews(doc)) {
      if (v.col < 0) continue;
      m.fillStyle = DRUM_LANES[v.col].color;
      m.fillRect(6 + v.col * 6, Math.round(yOf(v.beat)), 5, 1);
    }
    // BPM の変化
    m.fillStyle = C.amber;
    for (const ev of tempo.events.slice(1)) m.fillRect(GEO.miniW - 6, Math.round(yOf(ev.beat)) - 1, 4, 2);
    l.mini = { canvas: c, doc, h: l.h, endBeat: end, ghosts, sections: side.sections };
  }
  ctx.drawImage(l.mini.canvas, x, 0, GEO.miniW, l.h);
  // ループの範囲
  if (a.loop && a.loop.b > a.loop.a) {
    const ya = bottom - (a.loop.b / end) * (bottom - top);
    const yb = bottom - (a.loop.a / end) * (bottom - top);
    ctx.fillStyle = a.loop.on ? 'rgba(255,199,104,.25)' : 'rgba(255,199,104,.1)';
    ctx.fillRect(x + 2, ya, GEO.miniW - 4, Math.max(2, yb - ya));
  }
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
  void sectionAt;
}
