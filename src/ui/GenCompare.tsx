// AI難易度生成：元の譜面・曲に既にある難易度・作った難易度を、曲全体を縦にスクロールする譜面にして横に並べる。
// 再生はエディタと同じ（▶・止めると ▶ に戻る・小節番号のクリックで ▶ を移す）。列を押すとその譜面を聴く。
import { tr, pl, locale, subscribeLang } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { estimateLevel } from '../check/level';
import { toMeasure } from '../dtx/base36';
import { chipColor, drumChannel, type DtxDoc } from '../dtx/model';
import { originOf } from '../dtx/origin';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { snapToGrid } from '../edit/ops';
import { chipHeight, columnAt, compareGeom, FOLLOW_AT, firstAtOrAfter, labelEvery, layoutColumns, LOOP_BAND_W, PAD_BOTTOM, pxToFit, type CompareGeom, type CompareLayout } from '../gen/compareView';
import { drumNotes, lastMeasure, type Note } from '../gen/features';
import type { Difficulty } from '../gen/simplify';
import type { Slot } from '../gen/targets';
import { slotOf, useInputSettings } from '../input/settings';
import { useAssist } from '../store/assist';
import { tempoOf } from '../store/derived';
import { useSidecar } from '../store/sidecar';
import { playFrom, setCursorBeat, setView, useEditor } from '../store/editor';
import { columnKind, compareColumns, isPassing, selectDiff, setGenView, setListen, shownLevel, stairCount, stairIssues, toggleChip, useGen, type DiffState, type GenState } from '../store/gen';
import { useDevice } from '../store/device';
import { setGenDetail } from './tablet/shared';
import { songEndM } from './hooks';
import { Icon } from './icons';
import { OriginBadge } from './OriginBadge';

const C = {
  bg: '#0B0E13',
  col: '#0D1116',
  laneSep: 'rgba(255,255,255,.035)',
  measure: 'rgba(255,255,255,.2)',
  beat: 'rgba(255,255,255,.055)',
  text: '#8B95A4',
  dim: '#5F6978',
  accent: '#4CC2FF',
  playhead: '#FFB547',
  loop: '#FFC768',
  section: 'rgba(76,194,255,.32)',
  removed: 'rgba(200,210,225,.38)',
  moved: '#FFB547',
  stair: 'rgba(255,181,71,.12)',
  stairEdge: 'rgba(255,181,71,.7)',
};

/** いま見えている拍の範囲（キーで ▶ を動かしたとき、見えなくなったら表示を動かすため） */
export const genViewport = { minBeat: 0, maxBeat: 0 };

const notesCache = new WeakMap<DtxDoc, Note[]>();
function notesOf(doc: DtxDoc, tempo: TempoMap): Note[] {
  let n = notesCache.get(doc);
  if (!n) notesCache.set(doc, (n = drumNotes(doc, tempo)));
  return n;
}

const lastCache = new WeakMap<DtxDoc, number>();

/** 曲の終わり（拍）。END の線か、最後のチップの次の小節 */
function endBeatOf(doc: DtxDoc, tempo: TempoMap): number {
  let last = lastCache.get(doc);
  if (last === undefined) lastCache.set(doc, (last = lastMeasure(doc)));
  return tempo.measureStart(Math.max(songEndM(doc), last + 1));
}

interface Local {
  w: number;
  h: number;
  dpr: number;
  cols: Slot[];
  lay: CompareLayout;
  dirty: boolean;
  /** 再生中に追いかけている表示の位置（止めたらそこに残す） */
  followScroll: number | null;
  hover: { x: number; y: number } | null;
  drag: { pointer: number } | null;
  /** 押したのがチップ（ダブルクリックで再生しない） */
  downOnChip: boolean;
}

/** 表示の位置と1拍の高さ（曲全体・n小節に合わせるときは、高さから決める） */
function effView(l: Local, g: GenState, tempo: TempoMap): { scroll: number; px: number } {
  const v = g.view;
  if (v.fit === 'all') {
    const total = g.master ? endBeatOf(g.master, tempo) : 16;
    return { scroll: -0.5, px: pxToFit(l.h, total + 1) };
  }
  return { scroll: v.scrollBeat, px: v.fit === null ? v.px : pxToFit(l.h, v.fit * 4) };
}

/** 見えている高さ（追いかけるときの位置の計算） */
function viewH(l: Local) {
  return l.h - PAD_BOTTOM;
}

function scrollNow(l: Local, g: GenState, tempo: TempoMap): { scroll: number; px: number; playBeat: number | null } {
  const ev = effView(l, g, tempo);
  let { scroll } = ev;
  let playBeat: number | null = null;
  const sec = engine.heardSec();
  if (sec !== null) {
    playBeat = tempo.secToBeat(sec);
    if (useEditor.getState().view.follow && g.view.fit !== 'all') {
      scroll = playBeat - (viewH(l) * FOLLOW_AT) / ev.px;
      l.followScroll = scroll;
    }
  }
  return { scroll, px: ev.px, playBeat };
}

function laneX(box: { x: number; laneW: number }, lane: number) {
  return box.x + slotOf(lane) * box.laneW + box.laneW / 2;
}

/** 列に描く譜面のチップ。作った難易度の列は、作った元の譜面のチップを、残した・削った・移したで描き分ける */
function columnNotes(g: GenState, col: Slot, tempo: TempoMap): { notes: Note[]; ds: DiffState | null } | null {
  const kind = columnKind(g, col);
  if (kind === 'source') return g.master ? { notes: notesOf(g.master, tempo), ds: null } : null;
  if (kind === 'existing') return { notes: notesOf(g.charts[col]!.doc, tempo), ds: null };
  if (kind === 'made') {
    const ds = g.diffs[col as Difficulty];
    return ds.result && ds.src ? { notes: notesOf(ds.src.doc, tempo), ds } : null;
  }
  return null;
}

/** チップの表示：レーン・色・どうなったか */
function chipLook(n: Note, ds: DiffState | null): { lane: number; color: string; kind: 'kept' | 'removed' | 'moved' } {
  let lane = n.lane;
  let alt = n.alt;
  let kind: 'kept' | 'removed' | 'moved' = 'kept';
  const f = ds?.result?.fate.get(n.id);
  if (f?.kind === 'removed') kind = 'removed';
  if (f?.kind === 'moved') {
    const d = drumChannel(f.ch)!;
    lane = d.lane;
    alt = d.alt;
    kind = 'moved';
  }
  return { lane, color: chipColor(lane, alt), kind };
}

function draw(ctx: CanvasRenderingContext2D, l: Local) {
  const g = useGen.getState();
  const s = useEditor.getState();
  const a = useAssist.getState();
  const W = l.w;
  const H = l.h;
  ctx.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const master = g.master;
  if (!master) return;
  const tempo = tempoOf(master);
  const { scroll, px, playBeat } = scrollNow(l, g, tempo);
  const geo = compareGeom(H, scroll, px);
  genViewport.minBeat = Math.max(0, geo.minBeat);
  genViewport.maxBeat = geo.maxBeat;
  const lay = l.lay;
  const right = lay.width;

  // 列の背景
  l.cols.forEach((col, i) => {
    const box = lay.cols[i];
    ctx.fillStyle = C.col;
    ctx.fillRect(box.x, 0, box.w, H);
    if (g.listen === col) {
      ctx.fillStyle = 'rgba(76,194,255,.045)';
      ctx.fillRect(box.x, 0, box.w, H);
    }
    for (let k = 1; k < 10; k++) {
      ctx.fillStyle = C.laneSep;
      ctx.fillRect(Math.round(box.x + k * box.laneW), 0, 1, H);
    }
  });

  // 段階が逆転している小節（作った難易度が、上の譜面よりノーツが多い・下の譜面より少ない）を琥珀色に
  l.cols.forEach((col, i) => {
    if (col === 'MASTER') return;
    const st = stairIssues(g, col);
    if (!st.denser.length && !st.thinner.length) return;
    const box = lay.cols[i];
    for (const m of [...st.denser, ...st.thinner]) {
      const y0 = geo.beatToY(tempo.measureStart(m + 1));
      const y1 = geo.beatToY(tempo.measureStart(m));
      if (y1 < 0 || y0 > H) continue;
      ctx.fillStyle = C.stair;
      ctx.fillRect(box.x, y0, box.w, y1 - y0);
      ctx.fillStyle = C.stairEdge;
      ctx.fillRect(box.x, y0, 3, y1 - y0);
    }
  });

  // 曲の終わり（END）より後は暗く
  const endM = songEndM(master);
  const endBeat = tempo.measureStart(endM);
  if (endM > 0) {
    const ey = geo.beatToY(endBeat);
    if (ey > 0) {
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(lay.gutter, 0, right - lay.gutter, Math.min(H, ey));
    }
  }

  // ループの範囲
  const loop = a.loop && a.loop.b > a.loop.a ? a.loop : null;
  if (loop) {
    const y0 = geo.beatToY(loop.b);
    const y1 = geo.beatToY(loop.a);
    ctx.fillStyle = loop.on ? 'rgba(255,199,104,.06)' : 'rgba(255,199,104,.025)';
    ctx.fillRect(lay.gutter, y0, right - lay.gutter, y1 - y0);
    ctx.fillStyle = loop.on ? C.loop : 'rgba(255,199,104,.4)';
    ctx.fillRect(1, y0, LOOP_BAND_W - 2, y1 - y0);
  } else if (a.loopMark) {
    const y = geo.beatToY(a.loopMark.beat);
    ctx.fillStyle = 'rgba(255,199,104,.6)';
    ctx.fillRect(1, y - 1, LOOP_BAND_W + 4, 2);
  }

  // 小節線・拍の線・小節番号
  const firstM = tempo.locate(Math.max(0, geo.minBeat)).m;
  const lastM = tempo.locate(Math.max(0, geo.maxBeat)).m + 1;
  const pxPerMeasure = px * 4;
  const every = labelEvery(pxPerMeasure);
  // セクションの印は、エディタで付けたものだけ（無いときの「8小節ごと」の区切りは出さない）
  const marked = useSidecar.getState().sections.length > 0;
  const sectionHeads = new Map(marked ? g.spans.map((sp) => [sp.from, sp.name]) : []);
  const numX = lay.gutter - 13;
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  for (let m = firstM; m <= lastM && m < 3600; m++) {
    const mb = tempo.measureStart(m);
    const y = Math.round(geo.beatToY(mb)) + 0.5;
    if (y < -20 || y > H + 20) continue;
    const head = sectionHeads.get(m);
    const strong = m % every === 0 || head !== undefined;
    if (strong || pxPerMeasure >= 6) {
      ctx.fillStyle = head !== undefined ? C.section : strong ? C.measure : 'rgba(255,255,255,.09)';
      for (const box of lay.cols) ctx.fillRect(box.x, y - 0.5, box.w, 1);
    }
    if (px >= 7) {
      const beats = tempo.measureBeats(m);
      ctx.fillStyle = C.beat;
      for (let k = 1; k < beats; k++) {
        const by = Math.round(geo.beatToY(mb + k)) + 0.5;
        for (const box of lay.cols) ctx.fillRect(box.x, by - 0.5, box.w, 1);
      }
    }
    if (m % every === 0) {
      ctx.fillStyle = C.dim;
      ctx.fillText(toMeasure(m), numX, y - 3);
    }
    if (head !== undefined && pxPerMeasure >= 40) {
      ctx.fillStyle = C.accent;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText(fitText(ctx, head, numX - LOOP_BAND_W - 2), numX, y - 15);
      ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    }
  }

  // チップ（どの列も、開いている譜面と同じ時間の並びに写してある）
  const ch = chipHeight(px);
  l.cols.forEach((col, ci) => {
    const box = lay.cols[ci];
    const cn = columnNotes(g, col, tempo);
    if (!cn) return;
    const { notes, ds } = cn;
    const i0 = firstAtOrAfter(notes, geo.minBeat - 0.1);
    const cw = Math.max(3, Math.min(26, box.laneW - 5));
    for (let i = i0; i < notes.length; i++) {
      const n = notes[i];
      if (n.beat > geo.maxBeat + 0.1) break;
      const yy = geo.beatToY(n.beat);
      const look = chipLook(n, ds);
      const xx = laneX(box, look.lane);
      if (look.kind === 'removed') {
        if (ch >= 4) {
          ctx.strokeStyle = C.removed;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(xx - cw / 2 + 0.5, yy - ch / 2 + 0.5, cw - 1, ch - 1);
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = 'rgba(200,210,225,.12)';
          ctx.fillRect(xx - cw / 2, yy - ch / 2, cw, ch);
        }
      } else {
        ctx.fillStyle = look.color;
        if (ch >= 4) {
          ctx.beginPath();
          ctx.roundRect(xx - cw / 2, yy - ch / 2, cw, ch, 2);
          ctx.fill();
        } else {
          ctx.fillRect(xx - cw / 2, yy - ch / 2, cw, ch);
        }
        if (look.kind === 'moved' && ch >= 4) {
          ctx.strokeStyle = C.moved;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }
      if (ds?.overrides.has(n.id) && ch >= 3) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(xx + cw / 2 + 2.5, yy - ch / 2, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  // まだ作っていない列
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '12px system-ui, sans-serif';
  l.cols.forEach((col, ci) => {
    if (columnKind(g, col) !== 'made') return;
    const ds = g.diffs[col as Difficulty];
    if (ds.result) return;
    const box = lay.cols[ci];
    const msg = statusText(ds.status);
    ctx.fillStyle = ds.status === 'error' ? '#FF7A7F' : C.dim;
    ctx.fillText(fitText(ctx, msg, box.w - 12), box.x + box.w / 2, H / 2);
  });

  // ▶ を置く位置の目安（小節番号の列・空いた所の上）
  if (l.hover && !l.drag) {
    const hb = hoverStart(l, geo);
    if (hb !== null && Math.abs(hb - s.cursorBeat) > 1e-6) {
      const y = Math.round(geo.beatToY(hb)) + 0.5;
      ctx.strokeStyle = 'rgba(76,194,255,.45)';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lay.gutter, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      startTag(ctx, lay.gutter, y, 0.45);
    }
  }

  // 再生を始める位置（▶）
  {
    const y = Math.round(geo.beatToY(s.cursorBeat)) + 0.5;
    if (y >= -10 && y <= H + 10) {
      ctx.strokeStyle = C.accent;
      ctx.globalAlpha = playBeat !== null ? 0.5 : 0.9;
      ctx.setLineDash([6, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(lay.gutter, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      startTag(ctx, lay.gutter, y, playBeat !== null ? 0.6 : 1);
    }
  }

  // 再生位置
  if (playBeat !== null) {
    const y = Math.round(geo.beatToY(playBeat));
    ctx.fillStyle = C.playhead;
    ctx.fillRect(LOOP_BAND_W, y - 1, right - LOOP_BAND_W, 2);
    // 聴いている列だけ光らせる
    const li = l.cols.indexOf(g.listen);
    if (li >= 0) {
      const box = lay.cols[li];
      ctx.shadowColor = C.playhead;
      ctx.shadowBlur = 8;
      ctx.fillRect(box.x, y - 1, box.w, 2);
      ctx.shadowBlur = 0;
    }
  }

  // 聴いている列の枠
  const li = l.cols.indexOf(g.listen);
  if (li >= 0) {
    const box = lay.cols[li];
    ctx.strokeStyle = 'rgba(76,194,255,.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, 0.5, box.w - 1, H - 1);
  }
}

function startTag(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.accent;
  ctx.beginPath();
  ctx.moveTo(x - 1, y);
  ctx.lineTo(x - 10, y - 6);
  ctx.lineTo(x - 10, y + 6);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, w: number): string {
  if (ctx.measureText(text).width <= w) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > w) t = t.slice(0, -1);
  return `${t}…`;
}

/** マウスの所に ▶ を置くときの拍（グリッドに吸着。エディタの小節番号の列と同じ）。チップの上なら null */
function hoverStart(l: Local, geo: CompareGeom): number | null {
  if (!l.hover) return null;
  if (chipAt(l, geo, l.hover.x, l.hover.y)) return null;
  if (columnAt(l.lay, l.hover.x) === null) return null;
  return snappedBeat(geo.yToBeat(l.hover.y));
}

function snappedBeat(beat: number): number {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const p = snapToGrid(tempo, Math.max(0, beat), s.view.div);
  return tempo.beatOf(p.m, p.f);
}

/** 作った難易度の列で、押した所のチップ（手直しで残す・削るを切り替える） */
function chipAt(l: Local, geo: CompareGeom, x: number, y: number): { diff: Difficulty; id: number } | null {
  const ci = columnAt(l.lay, x);
  if (ci === null || ci < 0) return null;
  const col = l.cols[ci];
  const g = useGen.getState();
  if (!g.master || columnKind(g, col) !== 'made') return null;
  const cn = columnNotes(g, col, tempoOf(g.master));
  if (!cn?.ds) return null;
  const { notes, ds } = cn;
  const box = l.lay.cols[ci];
  const reach = 14;
  const lo = geo.yToBeat(y + reach);
  const hi = geo.yToBeat(y - reach);
  let best: { id: number; d: number } | null = null;
  for (let i = firstAtOrAfter(notes, lo); i < notes.length && notes[i].beat <= hi; i++) {
    const n = notes[i];
    const look = chipLook(n, ds);
    const d = Math.hypot(laneX(box, look.lane) - x, (geo.beatToY(n.beat) - y) * 1.6);
    if (d < Math.min(16, box.laneW * 0.75 + 4) && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best ? { diff: ds.diff, id: best.id } : null;
}

const SHORT: Record<Slot, string> = { MASTER: 'MAS', EXTREME: 'EXT', ADVANCED: 'ADV', BASIC: 'BSC' };

/** 列を押したとき：その譜面を聴く（作る難易度・元の譜面より下の既存の譜面なら、右の判定・方針もその難易度に） */
function pickColumn(col: Slot) {
  const g = useGen.getState();
  if (columnKind(g, col) === 'made') selectDiff(col as Difficulty);
  else setListen(col);
}

/** 作っている途中・作れなかった・まだの文 */
function statusText(st: DiffState['status']): string {
  if (st === 'planning') return tr('AIが方針を考えています…', 'AI is planning…');
  if (st === 'building') return tr('作っています…', 'Building…');
  if (st === 'judging') return tr('AIがレベルを判定しています…', 'AI is rating the level…');
  if (st === 'error') return tr('作れませんでした', "Couldn't make it");
  return tr('まだ作っていません', 'Not made yet');
}

/** 列の見出し：押すとその譜面を聴く（作った難易度なら右の判定・方針もその難易度に）。w は列の幅（狭いときは短く書く） */
function ColHead({ col, w }: { col: Slot; w: number }) {
  const kind = useGen((s) => columnKind(s, col));
  const listen = useGen((s) => s.listen);
  const selected = useGen((s) => s.selected);
  const master = useGen((s) => s.master);
  const masterLabel = useGen((s) => s.masterLabel);
  const masterLevel = useGen((s) => s.masterLevel);
  const chart = useGen((s) => s.charts[col]);
  const ds = useGen((s) => (col === 'MASTER' ? null : s.diffs[col]));
  const stairN = useGen((s) => (col === 'MASTER' ? 0 : stairCount(s, col)));
  const doc = kind === 'source' ? master : kind === 'existing' ? (chart?.doc ?? null) : (ds?.result?.doc ?? null);
  const est = useMemo(() => (doc ? estimateLevel(doc, buildTempoMap(doc)) : null), [doc]);
  const masterNotes = useMemo(() => (master ? (estimateLevel(master, buildTempoMap(master))?.notes ?? 0) : 0), [master]);
  const masterOrigin = useMemo(() => (master ? originOf(master) : 'human'), [master]);
  const on = listen === col;
  const sel = kind !== 'source' && col !== 'MASTER' && selected === col;
  const playable = kind !== 'made' || !!ds?.result;
  const narrow = w < 210;
  const tiny = w < 160;
  // 作った難易度の見出しはレベルの出どころ（計算・AI判定）と ✓ も入るので、名前が切れないように早めに畳む
  const roomy = w >= 260;
  const full = kind === 'source' ? masterLabel : kind === 'existing' ? (chart?.label ?? col) : col;
  // 作る譜面の見出しは AI の印・レベル・✓ も入るので、狭い列では短い名前（聴く譜面の切り替えと同じ ADV など）
  const name = (tiny || (narrow && kind === 'made')) && full === col ? SHORT[col] : full;
  const made = kind === 'made' ? ds : null;
  const busy = made && (made.status === 'planning' || made.status === 'building' || made.status === 'judging');
  // 2行目：作っている途中ならその様子、作ってあればノーツ数（元の譜面に対する割合）・平均の密度・最大同時打数
  let sub: string;
  if (busy && made) sub = statusText(made.status);
  else if (est) {
    const pct = kind !== 'source' && masterNotes ? Math.round((est.notes / masterNotes) * 100) : null;
    const ratio = pct === null ? '' : tr(`（${pct}%）`, ` (${pct}%)`);
    sub = tr(
      `${est.notes.toLocaleString()}${tiny ? '' : 'ノーツ'}${ratio} · ${est.avgNps.toFixed(1)}/秒 · 同時${est.maxChord}`,
      `${est.notes.toLocaleString(locale())}${tiny ? '' : ' notes'}${ratio} · ${est.avgNps.toFixed(1)}/s · max ${est.maxChord}`,
    );
  } else sub = statusText(made?.status === 'error' ? 'error' : 'idle');
  // 何の列か：元の譜面・曲に既にある譜面（作者か AI か）・この画面で作る譜面（AI）
  let what: React.ReactNode = null;
  if (kind === 'source' && !narrow) what = <span className="lbl">{tr('元の譜面', 'Original')}</span>;
  else if (kind === 'existing' && chart) what = <OriginBadge origin={chart.origin} tab={tiny} />;
  else if (kind === 'made') what = <OriginBadge origin="ai" tab={tiny} />;
  const whatTitle =
    kind === 'source'
      ? tr('（元の譜面）', ' (the original chart)')
      : kind === 'existing'
        ? tr('（曲に既にある譜面）', ' (already in the song)')
        : chart
          ? tr('（この画面で作り直す譜面）', ' (being remade here)')
          : tr('（この画面で作る譜面）', ' (being made here)');
  return (
    <button
      className={`gen-colhead ${on ? 'on' : ''} ${sel ? 'sel' : ''} ${playable ? '' : 'empty'} ${kind ?? ''}`}
      onClick={() => {
        // タブレット: 聴いている列の見出しをもう一度タップすると、判定・方針の小窓を開け閉めする
        if (useDevice.getState().tablet && on && kind !== 'source') {
          setGenDetail((was) => !was);
          return;
        }
        pickColumn(col);
      }}
      aria-pressed={on}
      title={
        playable
          ? tr(`${full}${whatTitle} を聴く（←→ で切り替え。再生中ならそのまま切り替わります）`, `Listen to ${full}${whatTitle} (←→ to switch; switches right away while playing)`)
          : tr(`${full} はまだ作っていません`, `${full} isn't made yet`)
      }
    >
      <span className="gen-colhead-top">
        <span className="gen-spk">{on ? Icon.speaker(13) : null}</span>
        <b className="ellipsis">{name}</b>
        {what}
        {kind === 'source' && masterOrigin !== 'human' && !tiny && <OriginBadge origin={masterOrigin} />}
        <span className="grow" />
        {kind === 'source' ? (
          <span className="mono gen-colhead-lv">
            {tiny ? '' : 'Lv '}
            {masterLevel.toFixed(2)}
          </span>
        ) : kind === 'existing' && chart ? (
          <span className="mono gen-colhead-lv" title={chart.registered ? tr('登録レベル（#DLEVEL）', 'Registered level (#DLEVEL)') : tr('登録レベルが無いので計算のめやす', 'No registered level, so this is a computed estimate')}>
            {tiny ? '' : 'Lv '}
            {chart.registered ? '' : '≈'}
            {chart.level.toFixed(2)}
          </span>
        ) : made?.result ? (
          <>
            {roomy && <span className="lbl">{made.judge && !made.judgeStale ? tr('AI判定', 'AI') : tr('計算', 'Calc')}</span>}
            <span className="mono gen-colhead-lv">{shownLevel(made).toFixed(2)}</span>
            {isPassing(made) && stairN === 0 ? (
              <span className="gen-ok" title={tr('検証OK（目標の幅の中・どの小節も上の難易度より濃くない）', 'Checks passed (inside the target range, and no measure is denser than the harder chart)')}>
                ✓
              </span>
            ) : (
              <span
                className="gen-warn"
                title={
                  made.issues
                    ? tr(`叩けない所 ${made.issues}`, `${made.issues} unplayable ${pl(made.issues, 'spot')}`)
                    : !isPassing(made)
                      ? tr('目標の幅から外れ', 'Outside the target range')
                      : tr(`段階の逆転 ${stairN}小節（琥珀色の小節）`, `${stairN} ${pl(stairN, 'measure')} out of step (shown in amber)`)
                }
              >
                !
              </span>
            )}
          </>
        ) : null}
      </span>
      <span className="gen-colhead-sub lbl mono">{sub}</span>
    </button>
  );
}

/** 並べた譜面（見出し＋キャンバス） */
/** only: その 1 つの譜面だけを大きく出す（スマホの縦。聴く譜面を切り替えると替わる） */
export function GenCompare({ only }: { only?: Slot } = {}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cols = useGen((s) => compareColumns(s).join(','))
    .split(',')
    .filter((c) => c && (!only || c === only)) as Slot[];
  const [width, setWidth] = useState(0);
  const lay = useMemo(() => layoutColumns(width, cols.length), [width, cols.length]);
  const L = useRef<Local>({ w: 0, h: 0, dpr: 1, cols, lay, dirty: true, followScroll: null, hover: null, drag: null, downOnChip: false });
  L.current.cols = cols;
  L.current.lay = lay;
  L.current.dirty = true;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const l = L.current;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      l.dpr = window.devicePixelRatio || 1;
      l.w = Math.max(1, Math.floor(r.width));
      l.h = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(l.w * l.dpr);
      canvas.height = Math.floor(l.h * l.dpr);
      l.dirty = true;
      setWidth(wrap.current?.clientWidth ?? l.w);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const mark = () => {
      l.dirty = true;
    };
    const unsubs = [useGen.subscribe(mark), useEditor.subscribe(mark), useAssist.subscribe(mark), useInputSettings.subscribe(mark), subscribeLang(mark)];
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const playing = engine.playing;
      if (!playing && l.followScroll !== null) {
        // 止めても表示は止めた所のまま（エディタと同じ）
        setGenView({ scrollBeat: l.followScroll });
        l.followScroll = null;
      }
      if (!l.dirty && !playing) return;
      l.dirty = false;
      draw(ctx, l);
    };
    raf = requestAnimationFrame(loop);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = useGen.getState();
      if (!g.master) return;
      const tempo = tempoOf(g.master);
      const cur = scrollNow(l, g, tempo);
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+ホイール：マウスの所を中心に拡大・縮小
        const geo = compareGeom(l.h, cur.scroll, cur.px);
        const anchor = geo.yToBeat(e.offsetY);
        const px = Math.max(1, Math.min(160, cur.px * Math.exp(-e.deltaY * 0.0022)));
        l.followScroll = null;
        setGenView({ fit: null, px, scrollBeat: Math.max(-2, anchor - (l.h - PAD_BOTTOM - e.offsetY) / px) });
        return;
      }
      if (g.view.fit === 'all') return;
      const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * l.h : e.deltaY;
      const base = engine.playing && l.followScroll !== null ? l.followScroll : g.view.scrollBeat;
      l.followScroll = null;
      const end = endBeatOf(g.master, tempo);
      setView({ follow: false });
      setGenView({ scrollBeat: Math.max(-2, Math.min(end, base - dy / cur.px)) });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubs.forEach((u) => u());
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const geoNow = () => {
    const l = L.current;
    const g = useGen.getState();
    const tempo = tempoOf(g.master ?? useEditor.getState().doc);
    const cur = scrollNow(l, g, tempo);
    return compareGeom(l.h, l.followScroll ?? cur.scroll, cur.px);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const l = L.current;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const geo = geoNow();
    const hit = chipAt(l, geo, x, y);
    l.downOnChip = !!hit;
    if (hit) {
      // チップを押す：残す・削るを切り替える（その難易度を選んで聴く）
      selectDiff(hit.diff);
      toggleChip(hit.diff, hit.id);
      return;
    }
    const ci = columnAt(l.lay, x);
    if (ci === null) return;
    // 列の空いた所を押したら、その譜面を聴く
    if (ci >= 0) pickColumn(l.cols[ci]);
    // ▶ を置く（ドラッグで動かせる。再生中なら離したときにそこから続けて再生）
    setCursorBeat(snappedBeat(geo.yToBeat(y)));
    l.drag = { pointer: e.pointerId };
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    l.dirty = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = L.current;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    l.hover = { x, y };
    l.dirty = true;
    const geo = geoNow();
    if (l.drag) {
      setCursorBeat(snappedBeat(geo.yToBeat(y)));
      return;
    }
    (e.target as HTMLCanvasElement).style.cursor = chipAt(l, geo, x, y) ? 'pointer' : 'default';
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = L.current;
    if (!l.drag) return;
    l.drag = null;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch {
      // もう離している
    }
    if (useEditor.getState().playing) void playFrom(useEditor.getState().cursorBeat);
  };

  return (
    <div className="gen-compare" ref={wrap}>
      <div className="gen-heads" style={{ gridTemplateColumns: `${lay.gutter - 10}px ${lay.cols.map((c) => `${c.w}px`).join(' ')}`, width: lay.width }}>
        <span className="gen-heads-gut lbl" title={tr('小節番号。押すと ▶（再生を始める位置）を置きます', 'Measure numbers. Click to put ▶ (where playback starts)')}>
          {tr('小節', 'Bar')}
        </span>
        {cols.map((c, i) => (
          <ColHead key={c} col={c} w={lay.cols[i]?.w ?? 200} />
        ))}
      </div>
      <div className="gen-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="gen-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            L.current.hover = null;
            L.current.dirty = true;
          }}
          onDoubleClick={() => {
            // ダブルクリック：その位置から再生（チップの手直しのときは鳴らさない）
            if (L.current.downOnChip) return;
            if (!useEditor.getState().playing) void playFrom(useEditor.getState().cursorBeat);
          }}
        />
      </div>
    </div>
  );
}
