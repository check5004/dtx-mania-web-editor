// 下のトラック：DTM の音声トラックのように、原曲・ステム・譜面の音を1本ずつ並べる。
// トラックごとにミュート・ソロ・音量、解析元、譜面の右の列にスペクトルを出すチェック。上の帯はループとセクション。
import { tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { computePeaks, stemKindInfo } from '../audio/stems';
import { engine, type Mix } from '../audio/engine';
import { chipColor, DRUM_LANES, drumChannel, isSeChannel, type DtxDoc } from '../dtx/model';
import { pickBgmFile } from '../app/fileActions';
import { beginLoopDrag, dragLoop, endLoopDrag, LOOP_DIV, setSpecSource, setWaveMode, useAssist, type LoopDrag } from '../store/assist';
import { closeCtxMenu, dismissedBy, openCtxMenu } from '../store/ctxMenu';
import { bgmSource, tempoOf, wavPath } from '../store/derived';
import { dragSongEnd, openPage, playFrom, resetSongEnd, setCursorBeat, setView, toast, useEditor } from '../store/editor';
import { deskTracksHeight, SEEK_CLOSED_H, togglePanel, useLayout } from '../store/layout';
import { sectionColor, useSidecar, type StemTrack } from '../store/sidecar';
import {
  anySolo,
  chooseAnalysisStem,
  effectiveAnalysisStem,
  importStems,
  PEAK_RATE,
  setChartTrack,
  setOrigTrack,
  setSeTrack,
  soloOnly,
  stemAudible,
  stemPeaks,
  trackAudio,
  updateStem,
  useStems,
} from '../store/stems';
import { formatTime } from './format';
import { songLength, useBoxSize, useFold, usePlayBeat, useSoundsVersion } from './hooks';
import { DESK_TRACK_ROW, fitRowHeight } from '../store/sheetSnap';
import { Icon } from './icons';
import { useLang } from '../i18n/useLang';
import { StemTrackPopover } from './StemTrackPopover';
import { openSeparation, separating, useSeparate } from '../store/separate';

/** トラックの見出しの幅 */
export const HEAD_W = 344;

/**
 * タブレット版のトラックの寸法：上の帯の高さ、1本の高さ（指で押せる最小・帯を止める高さ・最大）。
 * 横の帯は「上の帯＋1本ずつ（stop）」の高さで止まる
 */
export const TABLET_TRACK_ROW = { ruler: 52, min: 48, stop: 56, max: 72 } as const;

/** 幅がこれより狭い PC の画面では、トラックの見出しを詰める（音量の数字を隠し、スペクトルは図だけに） */
const DESK_NARROW_W = 1000;
/** 詰めたときの見出しの幅 */
const NARROW_HEAD_W = 272;

/** トラックの寸法：見出しの幅・上の帯の高さ（ループの帯・セクションの段）・1本の高さ。タブレット版は指で触れるように大きく */
const TD = { headW: HEAD_W, ruler: SEEK_CLOSED_H, loopH: 12, secH: 14, secTop: 14, rowMin: DESK_TRACK_ROW.min, rowMax: DESK_TRACK_ROW.max, grab: 6, tablet: false, narrow: false };
const DESK_TD = { ...TD };
const DESK_NARROW_TD = { ...TD, headW: NARROW_HEAD_W, narrow: true };
const TABLET_TD = {
  headW: 340,
  ruler: TABLET_TRACK_ROW.ruler,
  loopH: 20,
  secH: 20,
  secTop: 26,
  rowMin: TABLET_TRACK_ROW.min,
  rowMax: TABLET_TRACK_ROW.max,
  grab: 14,
  tablet: true,
  narrow: false,
};

function applyTrackDims(tablet: boolean, narrow = false) {
  Object.assign(TD, tablet ? TABLET_TD : narrow ? DESK_NARROW_TD : DESK_TD);
}

const ORIG_COLOR = '#8FA3BC';
const CHART_COLOR = '#4CC2FF';
const SE_COLOR = '#C3A6FF';

/** 曲の長さが分からない空の譜面でも、シークバーで動けるように2分ぶん取っておく */
const seekLength = (length: number) => (length > 0.5 ? length : 120);

const pct = (v: number) => Math.round(v * 100);

export type TrackRow =
  | { type: 'orig'; id: 'orig'; name: string; sub: string; color: string; state: 'ready' | 'none' | 'missing' | 'loading' }
  | { type: 'stem'; id: string; name: string; sub: string; color: string; t: StemTrack }
  | { type: 'chart'; id: 'chart'; name: string; sub: string; color: string }
  /** SE のチャンネル（61〜92）で鳴らす音。原曲のドラム（drums.ogg など）を SE で鳴らす譜面がある */
  | { type: 'se'; id: 'se'; name: string; sub: string; color: string };
type Row = TrackRow;

/** SE のチャンネルで鳴らすファイル（出てくる順・重なりなし） */
const seFilesCache = new WeakMap<DtxDoc, string[]>();
function seFiles(doc: DtxDoc): string[] {
  let out = seFilesCache.get(doc);
  if (out) return out;
  const seen = new Set<string>();
  out = [];
  for (const c of doc.chips) {
    if (!isSeChannel(c.ch)) continue;
    const f = (wavPath(doc, c.v) ?? '').split(/[\\/]/).pop() || `WAV${c.v}`;
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  seFilesCache.set(doc, out);
  return out;
}

/** 並べるトラック：譜面の音・原曲（ステムがあるときは原曲のファイルが読めたときだけ）・ステム。AI難易度生成の音量の列でも使う */
export function useTrackRows(): Row[] {
  const doc = useEditor((s) => s.doc);
  const loading = useEditor((s) => s.loading);
  const stems = useSidecar((s) => s.stems);
  const status = useStems((s) => s.status);
  useStems((s) => s.version);
  useSoundsVersion();
  // 譜面の音をいちばん上に（トラックが多くて下に隠れても、編集している音はいつも見える）
  const rows: Row[] = [{ type: 'chart', id: 'chart', name: tr('譜面の音', 'Chart'), sub: tr('置いたチップのドラム', 'Drum chips'), color: CHART_COLOR }];
  const bgm = bgmSource(doc);
  const origBuf = bgm ? engine.buffer(bgm.wav) : null;
  const origFile = bgm ? ((wavPath(doc, bgm.wav) ?? '').split(/[\\/]/).pop() ?? '') : '';
  if (origBuf || stems.length === 0) {
    rows.push({
      type: 'orig',
      id: 'orig',
      name: tr('原曲', 'Original'),
      sub: origFile || tr('音声ファイルなし', 'No audio file'),
      color: ORIG_COLOR,
      state: origBuf ? 'ready' : !bgm ? 'none' : loading ? 'loading' : 'missing',
    });
  }
  const se = seFiles(doc);
  if (se.length) {
    rows.push({ type: 'se', id: 'se', name: 'SE', sub: se.length > 1 ? tr(`${se[0]} ほか${se.length - 1}`, `${se[0]} + ${se.length - 1} more`) : se[0], color: SE_COLOR });
  }
  for (const t of stems) {
    const st = status[t.file];
    rows.push({
      type: 'stem',
      id: t.file,
      name: t.name,
      sub: `${t.file.replace(/^stems\//, '')}${st === 'missing' ? tr(' · 見つかりません', ' · not found') : st === 'error' ? tr(' · 読めません', ' · unreadable') : st === 'loading' ? tr(' · 読み込み中…', ' · loading…') : ''}`,
      color: stemKindInfo(t.kind).color,
      t,
    });
  }
  return rows;
}

/** トラックが鳴るか（ミュート・ソロ・曲の音をまとめて消しているか） */
export function rowAudible(r: Row): boolean {
  const a = engine.audible();
  if (r.type === 'orig') return a.orig;
  if (r.type === 'chart') return a.chart;
  if (r.type === 'se') return a.se;
  return a.song && stemAudible(r.t);
}

/** トラックのミュート・ソロ・音量（原曲・譜面の音はミックス、ステムはステムの設定）と、音量の上限・ダブルクリックで戻す値 */
export function trackMix(row: Row, mix: Mix) {
  return {
    muted: row.type === 'orig' ? mix.origMute : row.type === 'chart' ? mix.drumMute : row.type === 'se' ? mix.seMute : row.t.mute,
    soloed: row.type === 'orig' ? mix.origSolo : row.type === 'chart' ? mix.drumSolo : row.type === 'se' ? mix.seSolo : row.t.solo,
    gain: row.type === 'orig' ? mix.bgm : row.type === 'chart' ? mix.drums : row.type === 'se' ? mix.se : row.t.gain,
    maxGain: row.type === 'stem' ? 1.5 : 1,
    defGain: row.type === 'orig' ? 0.8 : row.type === 'chart' ? 0.9 : 1,
  };
}

/** トラックの音量・ミュート・ソロを変える */
export function setTrack(row: Row, p: { gain?: number; mute?: boolean; solo?: boolean }) {
  if (row.type === 'orig') setOrigTrack(p);
  else if (row.type === 'chart') setChartTrack(p);
  else if (row.type === 'se') setSeTrack(p);
  else updateStem(row.id, p);
}

/** 自分ではミュートしていないのに鳴らないわけ（ほかのトラックのソロ・曲の音をまとめて消している） */
export function silentWhy(row: Row, mix: Mix, on: boolean, muted: boolean, soloed: boolean): string {
  if (on || muted) return '';
  if (anySolo() && !soloed) return tr('（他のトラックがソロ）', ' (another track is soloed)');
  if (mix.bgmMute && row.type !== 'chart') return tr('（曲の音をまとめて消しています）', ' (the song audio is muted as a whole)');
  return '';
}

// 原曲の波形（ステムはステムの読み込みで作る）
const origPeaks = new Map<string, Float32Array>();
function peaksOfOrig(): Float32Array | null {
  const bgm = bgmSource(useEditor.getState().doc);
  const got = bgm ? engine.buffer(bgm.wav) : null;
  if (!got) return null;
  let p = origPeaks.get(got.key);
  if (!p) {
    p = computePeaks(got.buf, PEAK_RATE);
    origPeaks.clear();
    origPeaks.set(got.key, p);
  }
  return p;
}

// SE の音の波形（drums.ogg など長い音。ファイルごとに作っておく）
const sePeaks = new Map<string, Float32Array>();
function peaksOfSe(key: string, buf: AudioBuffer): Float32Array {
  let p = sePeaks.get(key);
  if (!p) {
    if (sePeaks.size >= 8) sePeaks.clear();
    p = computePeaks(buf, PEAK_RATE);
    sePeaks.set(key, p);
  }
  return p;
}

/** SE のトラック：鳴らし始める所からその音の長さぶんの波形（1秒より短い音は印だけ） */
function drawSeLane(c: CanvasRenderingContext2D, doc: DtxDoc, top: number, rowH: number, W: number, len: number, color: string) {
  const tempo = tempoOf(doc);
  const secPerPx = len / Math.max(1, W);
  const mid = top + rowH / 2;
  const amp = rowH / 2 - 3;
  c.fillStyle = color;
  let n = 0;
  for (const ch of doc.chips) {
    if (!isSeChannel(ch.ch)) continue;
    if (++n > 400) break;
    const sec0 = tempo.beatToSec(tempo.beatOf(ch.m, ch.f));
    const x0 = (sec0 / len) * W;
    const got = engine.buffer(ch.v);
    if (!got || got.buf.duration < 1) {
      c.fillRect(Math.floor(x0), top + 4, 1.5, Math.max(1, rowH - 8));
      continue;
    }
    const peaks = peaksOfSe(got.key, got.buf);
    for (let x = Math.max(0, Math.floor(x0)); x < W; x++) {
      const t0 = x * secPerPx - sec0;
      if (t0 > got.buf.duration) break;
      let i0 = Math.floor(t0 * PEAK_RATE);
      let i1 = Math.ceil((t0 + secPerPx) * PEAK_RATE);
      if (i1 < 0 || i0 >= peaks.length) continue;
      i0 = Math.max(0, i0);
      i1 = Math.min(peaks.length - 1, Math.max(i0, i1));
      let mx = 0;
      for (let k = i0; k <= i1; k++) if (peaks[k] > mx) mx = peaks[k];
      const h = Math.max(0.5, mx * amp);
      c.fillRect(x, mid - h, 1, h * 2);
    }
  }
}

// ---- 操作（シーク・ループ） --------------------------------------------------------

type SeekDrag =
  | { type: 'seek' }
  | { type: 'loop'; ld: LoopDrag; x0: number }
  | { type: 'end'; group: string }
  /** 右ボタン：離したらループの帯・END のメニュー */
  | { type: 'menu'; what: 'loop' | 'end'; beat: number; cx: number; cy: number }
  | null;

/** 上の帯の「END」の札の幅 */
const END_TAB_W = 26;

/** END の札の左端（線の右に出す。右端で入らなければ線の左） */
function endTabX(xe: number, W: number): number {
  return xe + END_TAB_W + 1 <= W ? xe + 1 : xe - END_TAB_W - 1;
}

/**
 * 上の帯とトラックの両方で使う、クリックで再生を始める位置・ループの端・曲の終わり（END）のドラッグ。
 * span: 横幅に入れる長さ（秒）
 */
function useSeekPointer(span: number, ruler: boolean) {
  const drag = useRef<SeekDrag>(null);
  const geomAt = (c: HTMLCanvasElement, clientX: number, clientY: number) => {
    const r = c.getBoundingClientRect();
    const sec = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * seekLength(span);
    const tempo = tempoOf(useEditor.getState().doc);
    return { beat: tempo.secToBeat(sec), y: clientY - r.top, x: clientX - r.left, w: r.width };
  };
  /** 曲の終わり（END）の線の近く。上の帯では「END」の札も */
  const nearEnd = (x: number, y: number, w: number): boolean => {
    const end = songLength(useEditor.getState().doc);
    if (end <= 0) return false;
    const xe = (end / seekLength(span)) * w;
    if (ruler) {
      if (y < TD.loopH + 1) return false;
      const tx = endTabX(xe, w);
      if (y >= TD.secTop && y <= TD.secTop + TD.secH && x >= tx - 1 && x <= tx + END_TAB_W + 1) return true;
    }
    return Math.abs(x - xe) <= TD.grab - 1;
  };
  /** A・B の線の近く（どの段でも掴める）。上の帯では線の外に出ている印（A は左、B は右）も */
  const nearHandle = (x: number, w: number): boolean => {
    const { loop: l, loopMark: mk } = useAssist.getState();
    const tempo = tempoOf(useEditor.getState().doc);
    const len = seekLength(span);
    const xOf = (b: number) => (tempo.beatToSec(b) / len) * w;
    const near = (xl: number, side: 'a' | 'b') =>
      Math.abs(x - xl) <= TD.grab || (ruler && (side === 'a' ? x >= xl - 12 && x < xl : x > xl && x <= xl + 12));
    if (l && l.b > l.a) return near(xOf(l.a), 'a') || near(xOf(l.b), 'b');
    return !!mk && near(xOf(mk.beat), mk.side);
  };
  const beatTol = (w: number) => {
    const tempo = tempoOf(useEditor.getState().doc);
    const secPerPx = seekLength(span) / Math.max(1, w);
    return tempo.secToBeat(secPerPx * (TD.grab + 2)) - tempo.secToBeat(0);
  };
  const inBand = (y: number) => ruler && y < TD.loopH + 1;
  const seek = (c: HTMLCanvasElement, clientX: number, commit: boolean) => {
    const { beat: b } = geomAt(c, clientX, 0);
    setCursorBeat(b);
    setView({ scrollBeat: Math.max(-1, b - 4), follow: true });
    if (commit && useEditor.getState().playing) void playFrom(b);
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = e.currentTarget;
      const g = geomAt(c, e.clientX, e.clientY);
      // 右クリックのメニューを閉じるための押下は、ここでは何もしない
      const dismissed = dismissedBy(e.timeStamp) || closeCtxMenu();
      if (e.button === 2) {
        // 上の帯・END の線の右クリック：譜面の左端の帯と同じメニュー（離したときに出す）
        const what = inBand(g.y) ? 'loop' : nearEnd(g.x, g.y, g.w) ? 'end' : null;
        if (what) {
          c.setPointerCapture(e.pointerId);
          drag.current = { type: 'menu', what, beat: g.beat, cx: e.clientX, cy: e.clientY };
        }
        return;
      }
      if (e.button !== 0 || dismissed) return;
      c.setPointerCapture(e.pointerId);
      const near = nearHandle(g.x, g.w);
      if (inBand(g.y) || near) {
        drag.current = { type: 'loop', ld: beginLoopDrag(g.beat, beatTol(g.w)), x0: e.clientX };
        // 線・印を掴んだのに範囲の外（や中）と判定されたら、近い方の端（A だけ・B だけならその印）にする
        const ld = drag.current.ld;
        if (near && (ld.mode === 'new' || ld.mode === 'move')) {
          const l = useAssist.getState().loop;
          ld.mode = !l || l.b <= l.a ? 'mark' : Math.abs(g.beat - l.a) < Math.abs(g.beat - l.b) ? 'a' : 'b';
        }
        return;
      }
      if (nearEnd(g.x, g.y, g.w)) {
        // 曲の終わり（END）：ドラッグで小節の頭へ（Undo 1回で戻せるようにまとめる）
        drag.current = { type: 'end', group: `song-end-${Date.now()}` };
        return;
      }
      drag.current = { type: 'seek' };
      seek(c, e.clientX, false);
    },
    onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = e.currentTarget;
      const d = drag.current;
      const g = geomAt(c, e.clientX, e.clientY);
      if (!d) {
        c.style.cursor = nearHandle(g.x, g.w) || nearEnd(g.x, g.y, g.w) ? 'ew-resize' : inBand(g.y) ? 'crosshair' : 'pointer';
        return;
      }
      if (d.type === 'seek') seek(c, e.clientX, false);
      else if (d.type === 'end') dragSongEnd(g.beat, d.group);
      else if (d.type === 'menu') {
        if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 5) drag.current = null;
      } else dragLoop(d.ld, g.beat, LOOP_DIV, Math.abs(e.clientX - d.x0) > 3);
    },
    onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.type === 'seek') seek(e.currentTarget, e.clientX, true);
      else if (d.type === 'loop') endLoopDrag(d.ld);
      else if (d.type === 'menu') openCtxMenu(d.what === 'loop' ? { kind: 'loop', beat: d.beat } : { kind: 'end' }, d.cx, d.cy);
    },
    onDoubleClick: (e: React.MouseEvent<HTMLCanvasElement>) => {
      const g = geomAt(e.currentTarget, e.clientX, e.clientY);
      if (nearHandle(g.x, g.w) || !nearEnd(g.x, g.y, g.w)) return;
      // END のダブルクリック：決めた終わりをやめて、原曲の鳴り終わりに合わせる
      resetSongEnd();
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

/** canvas の大きさを合わせて描く（ResizeObserver で描き直す） */
function useDraw(ref: React.RefObject<HTMLCanvasElement | null>, draw: (ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number) => void, deps: unknown[]) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.floor(r.width * dpr) || c.height !== Math.floor(r.height * dpr)) {
        c.width = Math.floor(r.width * dpr);
        c.height = Math.floor(r.height * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current(ctx, r.width, r.height, dpr);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * 曲の終わり（END。その先を暗く）・ループ（範囲と A・B の線。A だけ・B だけならその点線）・再生を始める位置（▶）・再生位置を上に重ねる。
 * span: 横幅に入れる長さ（秒）、end: 曲の終わり（秒）
 */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  span: number,
  top: number,
  opts: { tabs: boolean; cursor: number; beat: number; playing: boolean; end: number },
) {
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const len = seekLength(span);
  if (opts.end > 0) {
    const xe = Math.round((opts.end / len) * W);
    if (xe < W) {
      ctx.fillStyle = 'rgba(4,6,9,.55)';
      ctx.fillRect(xe, top, W - xe, H - top);
    }
    ctx.fillStyle = 'rgba(231,235,241,.85)';
    ctx.fillRect(xe - 1, top, 2, H - top);
    if (opts.tabs) {
      const tx = endTabX(xe, W);
      ctx.beginPath();
      ctx.roundRect(tx, TD.secTop, END_TAB_W, TD.secH, 2);
      ctx.fillStyle = '#E7EBF1';
      ctx.fill();
      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#0B0E13';
      ctx.fillText('END', tx + END_TAB_W / 2, TD.secTop + TD.secH / 2 + 0.5);
      ctx.textAlign = 'left';
    }
  }
  const { loop, loopMark } = useAssist.getState();
  const xOf = (b: number) => (tempo.beatToSec(Math.max(0, b)) / len) * W;
  const tab = (x: number, label: string, col: string) => {
    ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(x, 0, 12, TD.loopH, 2);
    ctx.fill();
    ctx.fillStyle = '#1A1408';
    ctx.fillText(label, x + 6, TD.loopH / 2 + 0.5);
    ctx.textAlign = 'left';
  };
  if (loop && loop.b > loop.a) {
    const xa = xOf(loop.a);
    const xb = xOf(loop.b);
    const on = loop.on;
    ctx.fillStyle = on ? 'rgba(255,199,104,.14)' : 'rgba(255,199,104,.05)';
    ctx.fillRect(xa, top, Math.max(2, xb - xa), H - top);
    const col = on ? '#FFC768' : 'rgba(255,199,104,.55)';
    if (opts.tabs) {
      ctx.fillStyle = on ? 'rgba(255,199,104,.45)' : 'rgba(255,199,104,.16)';
      ctx.fillRect(xa, 0, Math.max(2, xb - xa), TD.loopH);
    }
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(xa), 0, 1, H);
    ctx.fillRect(Math.round(xb) - 1, 0, 1, H);
    if (opts.tabs) {
      // A は線の左、B は線の右（重ならない）
      tab(xa - 12, 'A', col);
      tab(xb, 'B', col);
    }
  } else if (loopMark) {
    // 片方だけ：もう片方を決めるまでループしないので、線は点線
    const x = Math.round(xOf(loopMark.beat)) - (loopMark.side === 'b' ? 1 : 0);
    ctx.strokeStyle = '#FFC768';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
    ctx.setLineDash([]);
    if (opts.tabs) {
      if (loopMark.side === 'a') tab(x - 12, 'A', '#FFC768');
      else tab(x + 1, 'B', '#FFC768');
    }
  }
  // 再生を始める位置（▶）
  const xc = Math.round(xOf(opts.cursor));
  ctx.fillStyle = '#4CC2FF';
  ctx.globalAlpha = opts.playing ? 0.55 : 1;
  ctx.fillRect(xc - 1, top, 2, H - top);
  if (opts.tabs) {
    ctx.beginPath();
    ctx.moveTo(xc - 5, top);
    ctx.lineTo(xc + 5, top);
    ctx.lineTo(xc, top + 7);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (opts.playing) {
    const x = Math.round(xOf(opts.beat));
    ctx.fillStyle = '#FFB547';
    ctx.fillRect(x - 1, top, 2, H - top);
  }
}

// ---- パネル -----------------------------------------------------------------------

/** M・S・音量・チェックを触ったあとも Space で再生できるように、フォーカスを外す */
export function releaseFocus(e: React.PointerEvent<HTMLElement>) {
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && e.currentTarget.contains(a) && a.tagName !== 'SELECT') a.blur();
}

/**
 * length: 曲の長さ（曲の終わり END。秒）、span: 横幅に入れる長さ（END と原曲の鳴り終わりの遅い方）。
 * tablet: タブレット版（開閉と高さはタブレット版の画面が持つ。寸法を指で触れる大きさに）。
 * inSheet: 縦のシートの中（開け閉めはシートのタブとつまみでするので、角の「トラック」ボタンは出さない）
 */
export function TrackPanel({
  length,
  span,
  tablet,
}: {
  length: number;
  span: number;
  tablet?: { open: boolean; height: number; onToggle?: () => void; inSheet?: boolean };
}) {
  const box = useRef<HTMLDivElement>(null);
  const boxW = useBoxSize(box).w;
  // PC の狭い画面では見出しを詰める
  const narrow = !tablet && boxW > 0 && boxW < DESK_NARROW_W;
  applyTrackDims(!!tablet, narrow);
  const deskOpen = useLayout((s) => s.seekOpen);
  const open = tablet ? tablet.open : deskOpen;
  const tracksH = useLayout((s) => s.tracksH);
  const tracksStop = useLayout((s) => s.tracksStop);
  const [winH, setWinH] = useState(() => window.innerHeight);
  useEffect(() => {
    const h = () => setWinH(window.innerHeight);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  void winH;
  const rows = useTrackRows();
  // PC：止まる高さ（1本・細く・標準・ゆったり）ならトラックの数に合わせた高さ。全部をゆったり並べた高さより高くしない
  const height = tablet ? tablet.height : deskTracksHeight({ seekOpen: deskOpen, tracksH, tracksStop }, rows.length);
  const bodyH = Math.max(0, height - TD.ruler - 1);
  // 入りきらないときは、半端な高さで切れないよう入る本数で割る
  const rowH = fitRowHeight(bodyH, rows.length, TD.rowMin, TD.rowMax);
  const body = useRef<HTMLDivElement>(null);
  useRowWheel(body, rowH, open);
  return (
    <div ref={box} className={`tracks ${tablet ? 't-tracks' : ''} ${tablet?.inSheet ? 'in-sheet' : ''} ${narrow ? 'narrow' : ''}`} style={{ height }} onPointerUp={releaseFocus}>
      <div className="tracks-top" style={{ height: TD.ruler }}>
        <Corner length={length} open={open} rows={rows.length} onToggle={tablet?.inSheet ? undefined : tablet?.onToggle} />
        <Ruler length={length} span={span} />
      </div>
      {open && (
        <div ref={body} className="tracks-body scroll" style={{ height: bodyH }}>
          <div className="tracks-grid" style={{ gridTemplateColumns: `${TD.headW}px minmax(0, 1fr)`, minHeight: '100%' }}>
            <div className="tracks-heads">
              {rows.map((r) => (
                <TrackHead key={r.id} row={r} h={rowH} />
              ))}
            </div>
            <Lanes rows={rows} rowH={rowH} length={length} span={span} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 下のトラックがスクロールするとき、ホイールで 1 本ずつ送る（1本の高さでも、間を飛ばさずに次のトラックへ）。
 * トラックパッドの細かい動きは 40px ためて 1 本
 */
function useRowWheel(ref: React.RefObject<HTMLDivElement | null>, rowH: number, open: boolean) {
  const step = useRef(rowH);
  step.current = rowH;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let acc = 0;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (el.scrollHeight <= el.clientHeight + 1) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      if (e.timeStamp - last > 1000 || Math.sign(dy) !== Math.sign(acc)) acc = 0;
      last = e.timeStamp;
      acc += dy;
      if (Math.abs(acc) < 40) return;
      const dir = Math.sign(acc);
      acc = 0;
      const row = Math.max(1, step.current);
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.max(0, Math.min(max, (Math.round(el.scrollTop / row) + dir) * row));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, open]);
}

/** 下のトラックの音量・M・S は、どこに効くか */
const TRACKS_SCOPE = () =>
  tr(
    '下のトラックの音量・M・S は、エディタで聴くための設定です（作業ファイルに覚えます）。ゲームの音は変わりません。ゲームで鳴るのは「BGM」の印の原曲と、譜面のチップの音です。',
    'The volume, M and S in these tracks are for listening in the editor (kept in the work file). They don’t change what plays in the game: the game plays the original marked “BGM” and the chart’s chip sounds.',
  );

/**
 * 角が狭いときに畳む順：1 曲の長さ、2 「トラック」の文字（タブレットの横の開け閉め。開くと行が見えるので）、
 * 3 「ステム」の文字（＋だけに）、4 「エディタだけ」、5 「分解」。行の音量・M・S が何に効くかは、なるべく残す
 */
const FOLD_ORDER = { len: 1, trk: 2, stems: 3, tag: 4, split: 5 };
const CORNER_FOLDS = 5;

function Corner({ length, open, rows, onToggle }: { length: number; open: boolean; rows: number; onToggle?: () => void }) {
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const stems = useSidecar((s) => s.stems);
  const busy = useStems((s) => s.busy);
  const sepPhase = useSeparate((s) => s.phase);
  const sepProgress = useSeparate((s) => s.progress);
  const file = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const lang = useLang();
  const sepBusy = separating();
  const tablet = TD.tablet;
  // 入りきらなければ FOLD_ORDER の順に畳む
  const fc = (k: keyof typeof FOLD_ORDER) => `t-fold-${FOLD_ORDER[k]}`;
  const fold = useFold(box, CORNER_FOLDS, `${lang}|${open}|${!!onToggle}|${stems.length}|${!!busy}|${sepBusy}|${TD.headW}`);
  return (
    <div
      ref={box}
      className={`tracks-corner ${fold > 0 ? `fold-${fold}` : ''}`}
      style={{ width: TD.headW }}
      // PC：右クリックで下のトラックの高さを選ぶ
      onContextMenu={
        tablet
          ? undefined
          : (e) => {
              e.preventDefault();
              openCtxMenu({ kind: 'tracks', rows }, e.clientX, e.clientY);
            }
      }
    >
      {tablet ? (
        onToggle ? (
          // タブレット版：押しやすい「^ トラック」（上の縁をドラッグで高さ）
          <button className="t-btn t-trk-toggle" onClick={onToggle} aria-expanded={open} aria-label={open ? tr('トラックを閉じる', 'Close the tracks') : tr('トラックを開く', 'Open the tracks')}>
            {open ? Icon.chevronDown(16) : Icon.chevronUp(16)}
            <span className={fc('trk')}>{tr('トラック', 'Tracks')}</span>
          </button>
        ) : null
      ) : (
        <button
          className="ib tiny"
          onClick={() => togglePanel('seek')}
          title={
            open
              ? tr('トラックを閉じる（上の境目をドラッグで高さを変えられます。右クリックで高さを選ぶ）', 'Close the tracks (drag the edge above to change their height; right-click to pick a height)')
              : tr('トラックを開く（右クリックで高さを選ぶ）', 'Open the tracks (right-click to pick a height)')
          }
          aria-expanded={open}
        >
          {open ? Icon.chevronDown(14) : Icon.chevronUp(14)}
        </button>
      )}
      <span className="mono t-now">{formatTime(tempoOf(doc).beatToSec(Math.max(0, beat)))}</span>
      <span className={`mono lbl ${fc('len')}`}>/ {formatTime(length)}</span>
      <span className="grow" />
      {/* ここの音量・M・S は聴くための設定（ゲームの音は変わらない）。押すと説明（タブレットはホバーが無いので） */}
      <button className={`scope-tag ${fc('tag')}`} onClick={() => toast(TRACKS_SCOPE(), 'info', 9000)} title={TRACKS_SCOPE()}>
        {tr('エディタだけ', 'Editor only')}
      </button>
      {onToggle && !open ? null : busy ? (
        <span className="lbl ellipsis" title={busy}>
          {busy}
        </span>
      ) : sepBusy ? (
        <button className="link-btn" onClick={openSeparation} title={tr('原曲をステムに分解しています（ステムとミックスの画面で、ようすを見る・中止する）', 'Splitting the original into stems (watch or cancel it on the Stems and mix screen)')}>
          {tr('分解中', 'Splitting')} {sepPhase === 'run' || sepPhase === 'encode' ? `${Math.round(sepProgress * 100)}%` : '…'}
        </button>
      ) : (
        <>
          <button
            className="link-btn"
            onClick={() => file.current?.click()}
            title={tr('ステム（ドラム・ベース・ボーカルなどに分けた音）を読み込んでトラックにする', 'Load stems (audio split into drums, bass, vocals, etc.) as tracks')}
            aria-label={tr('ステムを読み込む', 'Load stems')}
          >
            {Icon.plus(tablet ? 14 : 12)} <span className={fc('stems')}>{tr('ステム', 'Stems')}</span>
          </button>
          {stems.length === 0 && bgmSource(doc) && (
            <button className={`link-btn ${fc('split')}`} onClick={openSeparation} title={tr('原曲をブラウザの中でドラムとドラム抜き（または楽器ごと）に分けて、ステムのトラックにする', 'Split the original in the browser into drums and no-drums (or per instrument) and add them as stem tracks')}>
              {tr('分解', 'Split')}
            </button>
          )}
          {stems.length > 0 && (
            <button className="link-btn" onClick={() => openPage('stems')} title={tr('ステムとミックスの画面（頭のずれ・パン・書き出し）', 'Stems and mix screen (start offset, pan, export)')}>
              {Icon.layers(12)}
            </button>
          )}
        </>
      )}
      <input
        ref={file}
        type="file"
        multiple
        accept="audio/*,.ogg,.wav,.mp3,.flac,.m4a,.opus"
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void importStems(files);
        }}
      />
    </div>
  );
}

/** 上の帯：ループ（A–B）とセクション、曲の終わり（END）の札 */
function Ruler({ length, span }: { length: number; span: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const cursor = useEditor((s) => s.cursorBeat);
  const playing = useEditor((s) => s.playing);
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const sections = useSidecar((s) => s.sections);
  const colors = useSidecar((s) => s.sectionColors);
  const cache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);
  const handlers = useSeekPointer(span, true);
  const lang = useLang();
  useDraw(
    ref,
    (ctx, W, H, dpr) => {
      const len = seekLength(span);
      const tempo = tempoOf(doc);
      const key = [doc, W, H, len, sections, colors, dpr, lang];
      if (!cache.current || cache.current.key.some((v, i) => v !== key[i])) {
        const off = cache.current?.canvas ?? document.createElement('canvas');
        off.width = Math.floor(W * dpr);
        off.height = Math.floor(H * dpr);
        const c = off.getContext('2d')!;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, H);
        c.fillStyle = '#0A0D11';
        c.fillRect(0, 0, W, TD.loopH);
        c.font = '10px system-ui, sans-serif';
        c.textBaseline = 'middle';
        c.fillStyle = '#4E4532';
        c.fillText(TD.tablet ? tr('A–B ループ: ここをなぞる', 'A–B loop: drag here') : tr('A–B ループ: ここをドラッグ', 'A–B loop: drag here'), 6, TD.loopH / 2 + 1);
        if (sections.length === 0) {
          c.fillStyle = '#151A21';
          c.fillRect(0, TD.secTop, W, TD.secH);
          c.fillStyle = '#5F6978';
          c.fillText(
            TD.tablet ? tr('セクション: 小節番号のメニューで付けられます', 'Sections: add one from the measure-number menu') : tr('セクション: 小節番号をダブルクリックで付けられます', 'Sections: double-click a measure number to add one'),
            6,
            TD.secTop + TD.secH / 2 + 1,
          );
        } else {
          const firstX = (tempo.beatToSec(tempo.measureStart(sections[0].m)) / len) * W;
          if (firstX > 2) {
            c.fillStyle = '#151A21';
            c.fillRect(0, TD.secTop, firstX - 2, TD.secH);
          }
          sections.forEach((sc, i) => {
            const x0 = (tempo.beatToSec(tempo.measureStart(sc.m)) / len) * W;
            const x1 = i + 1 < sections.length ? (tempo.beatToSec(tempo.measureStart(sections[i + 1].m)) / len) * W : W;
            const col = sectionColor(sc.name, colors);
            c.fillStyle = col + '55';
            c.beginPath();
            c.roundRect(x0, TD.secTop, Math.max(2, x1 - x0 - 2), TD.secH, 3);
            c.fill();
            c.fillStyle = col;
            c.fillRect(x0, TD.secTop, 2, TD.secH);
            c.save();
            c.beginPath();
            c.rect(x0, TD.secTop, Math.max(0, x1 - x0 - 4), TD.secH);
            c.clip();
            c.fillStyle = '#E7EBF1';
            c.fillText(sc.name, x0 + 5, TD.secTop + TD.secH / 2 + 1);
            c.restore();
          });
        }
        cache.current = { key, canvas: off };
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(cache.current.canvas, 0, 0);
      ctx.restore();
      drawOverlay(ctx, W, H, span, TD.secTop, { tabs: true, cursor, beat, playing, end: length });
    },
    [doc, length, span, beat, cursor, playing, loop, loopMark, sections, colors, lang],
  );
  return (
    <canvas
      ref={ref}
      className="tracks-ruler"
      {...handlers}
      aria-label={tr(
        'ループの帯とセクション。クリックで再生を始める位置、上の帯のドラッグでループの範囲、END の札のドラッグで曲の終わり',
        'Loop strip and sections. Click to set the playback start, drag the top strip for the loop range, drag the END tag for the song end',
      )}
      title={tr(
        'クリック: 再生を始める位置（▶）/ 上の帯をドラッグ: ループ（A–B）の範囲、A・B の印をドラッグで端を動かす / 右クリック（上の帯）: ループのメニュー（消す・ここを A・B に）/ END の札をドラッグ: 曲の終わりを動かす（ダブルクリックで原曲の終わりに戻す、右クリックでメニュー）',
        'Click: playback start (▶) / Drag the top strip: loop range (A–B); drag the A or B mark to move that end / Right-click (top strip): loop menu (clear, set A or B here) / Drag the END tag: move the song end (double-click to go back to the end of the original audio, right-click for a menu)',
      )}
    />
  );
}

/** トラックの波形（原曲・ステム）と譜面の音（レーンごとの色の印） */
function Lanes({ rows, rowH, length, span }: { rows: Row[]; rowH: number; length: number; span: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const mix = useEditor((s) => s.mix);
  const beat = usePlayBeat();
  const cursor = useEditor((s) => s.cursorBeat);
  const playing = useEditor((s) => s.playing);
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const sections = useSidecar((s) => s.sections);
  const stems = useSidecar((s) => s.stems);
  const version = useStems((s) => s.version);
  const sounds = useSoundsVersion();
  const cache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);
  const handlers = useSeekPointer(span, false);
  const lang = useLang();
  const H = rows.length * rowH;
  const audible = rows.map(rowAudible).join('');
  useDraw(
    ref,
    (ctx, W, Hc, dpr) => {
      const len = seekLength(span);
      const tempo = tempoOf(doc);
      const bgm = bgmSource(doc);
      const at = bgm?.sec ?? 0;
      const key = [doc, W, Hc, len, rowH, rows.map((r) => r.id).join('|'), audible, sections, stems, version, sounds, dpr, lang];
      if (!cache.current || cache.current.key.some((v, i) => v !== key[i])) {
        const off = cache.current?.canvas ?? document.createElement('canvas');
        off.width = Math.floor(W * dpr);
        off.height = Math.floor(Hc * dpr);
        const c = off.getContext('2d')!;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, Hc);
        c.fillStyle = '#090B0F';
        c.fillRect(0, 0, W, Hc);
        const secPerPx = len / Math.max(1, W);
        rows.forEach((r, i) => {
          const top = i * rowH;
          c.fillStyle = i % 2 ? '#0D1116' : '#0B0E13';
          c.fillRect(0, top, W, rowH);
          c.fillStyle = '#161B22';
          c.fillRect(0, top + rowH - 1, W, 1);
          const on = rowAudible(r);
          c.globalAlpha = on ? 0.9 : 0.28;
          if (r.type === 'chart') {
            // レーンごとの色の印（上が左シンバル、下がライド。色はチップと同じで、HHオープンはシルバー）
            const pad = 3;
            const laneH = (rowH - pad * 2) / DRUM_LANES.length;
            for (const ch of doc.chips) {
              const d = drumChannel(ch.ch);
              if (!d || d.kind !== 'normal') continue;
              const x = (tempo.beatToSec(tempo.beatOf(ch.m, ch.f)) / len) * W;
              c.fillStyle = DRUM_LANES[d.lane] ? chipColor(d.lane, d.alt) : CHART_COLOR;
              c.fillRect(Math.floor(x), top + pad + d.lane * laneH, 1.5, Math.max(1, laneH - 0.5));
            }
          } else if (r.type === 'se') {
            drawSeLane(c, doc, top, rowH, W, len, r.color);
          } else {
            const peaks = r.type === 'orig' ? peaksOfOrig() : stemPeaks(r.id);
            if (peaks) {
              c.fillStyle = r.color;
              const mid = top + rowH / 2;
              const amp = rowH / 2 - 3;
              for (let x = 0; x < W; x++) {
                const t0 = x * secPerPx - at;
                const t1 = t0 + secPerPx;
                let i0 = Math.floor(t0 * PEAK_RATE);
                let i1 = Math.ceil(t1 * PEAK_RATE);
                if (i1 < 0 || i0 >= peaks.length) continue;
                i0 = Math.max(0, i0);
                i1 = Math.min(peaks.length - 1, Math.max(i0, i1));
                let mx = 0;
                for (let k = i0; k <= i1; k++) if (peaks[k] > mx) mx = peaks[k];
                const h = Math.max(0.5, mx * amp);
                c.fillRect(x, mid - h, 1, h * 2);
              }
            } else {
              c.globalAlpha = 1;
              c.font = '11px system-ui, sans-serif';
              c.textBaseline = 'middle';
              c.fillStyle = '#5F6978';
              const msg =
                r.type === 'orig'
                  ? r.state === 'loading'
                    ? tr('読み込み中…', 'Loading…')
                    : r.state === 'missing'
                      ? tr('原曲のファイルが曲フォルダに見つかりません', 'The original audio file is not in the song folder')
                      : tr('原曲（音声ファイル）を読み込むと波形が出ます。ステムだけでも使えます（「＋ステム」）', 'Load the original audio file to see its waveform. Stems alone also work ("+ Stems")')
                  : tr('読み込み中…', 'Loading…');
              c.fillText(msg, 8, top + rowH / 2);
            }
          }
          c.globalAlpha = 1;
        });
        // セクションの区切り
        c.fillStyle = 'rgba(231,235,241,.08)';
        for (const sc of sections) {
          const x = Math.round((tempo.beatToSec(tempo.measureStart(sc.m)) / len) * W);
          c.fillRect(x, 0, 1, Hc);
        }
        cache.current = { key, canvas: off };
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(cache.current.canvas, 0, 0);
      ctx.restore();
      drawOverlay(ctx, W, Hc, span, 0, { tabs: false, cursor, beat, playing, end: length });
    },
    [doc, length, span, beat, cursor, playing, loop, loopMark, sections, stems, version, sounds, rowH, rows.length, audible, mix, lang],
  );
  return (
    <canvas
      ref={ref}
      className="tracks-lanes"
      style={{ height: H }}
      {...handlers}
      aria-label={tr(
        'トラックの波形。クリックで再生を始める位置、A・B の線をドラッグでループの端、END の線のドラッグで曲の終わり',
        'Track waveforms. Click to set the playback start, drag the A or B line for the loop ends, drag the END line for the song end',
      )}
      title={tr(
        'クリック: 再生を始める位置（▶）/ A・B の線をドラッグ: ループの端を動かす / END（白い線）をドラッグ: 曲の終わりを動かす',
        'Click: playback start (▶) / Drag the A or B line: move that loop end / Drag END (white line): move the song end',
      )}
    />
  );
}

// ---- トラックの見出し --------------------------------------------------------------

function TrackHead({ row, h }: { row: Row; h: number }) {
  const mix = useEditor((s) => s.mix);
  useSidecar((s) => s.analysisStem);
  useSidecar((s) => s.stems);
  const waveMode = useAssist((s) => s.waveMode);
  const specSource = useAssist((s) => s.specSource);
  const srcKey = useAssist((s) => s.src?.key ?? null);
  // 名前と種類を変える小窓（ステムのトラックだけ）
  const [edit, setEdit] = useState<DOMRect | null>(null);
  const tall = h >= 42;
  const on = rowAudible(row);

  if (row.type === 'orig' && row.state !== 'ready') {
    return (
      <div className="trk off" style={{ height: h, borderLeftColor: row.color }}>
        <div className="trk-name">
          <b>{row.name}</b>
          {tall && (
            <span className="sub ellipsis">
              {row.state === 'missing' ? tr(`${row.sub} · 見つかりません`, `${row.sub} · not found`) : row.state === 'loading' ? tr('読み込み中…', 'Loading…') : tr('まだありません', 'None yet')}
            </span>
          )}
        </div>
        <button className="btn small" onClick={pickBgmFile} title={tr('原曲（音声ファイル）を読み込む。曲フォルダにコピーして BGM（#WAV・ch01）に登録します', 'Load the original audio file. It is copied into the song folder and registered as the BGM (#WAV, ch01)')}>
          {Icon.plus(13)} {tr('原曲を読み込む', 'Load original')}
        </button>
      </div>
    );
  }

  // 解析元（波形・原曲の打点・BPM推定に使う音）
  const eff = effectiveAnalysisStem();
  const isAnalysis = row.type === 'stem' ? eff?.file === row.id : row.type === 'orig' ? eff === null : false;
  const audio = row.type === 'orig' || row.type === 'stem' ? trackAudio(row.id) : null;
  const specOn = !!audio && waveMode === 'spec' && (specSource ? specSource === audio.key : audio.key === srcKey);

  const { muted, soloed, gain, maxGain, defGain } = trackMix(row, mix);
  const set = (p: { gain?: number; mute?: boolean; solo?: boolean }) => setTrack(row, p);
  const why = silentWhy(row, mix, on, muted, soloed);
  const isStem = row.type === 'stem';
  const openEdit = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget.closest('.trk');
    if (el) setEdit(el.getBoundingClientRect());
  };

  return (
    <div
      className={`trk ${on ? '' : 'off'}`}
      style={{ height: h, borderLeftColor: row.color }}
      title={why ? tr(`鳴っていません${why}`, `Not playing${why}`) : undefined}
      onContextMenu={
        isStem
          ? (e) => {
              e.preventDefault();
              openEdit(e);
            }
          : undefined
      }
    >
      <div className="trk-name">
        <span className="trk-title">
          <b className="ellipsis" onDoubleClick={isStem ? openEdit : undefined} title={isStem ? tr(`${row.name}（ダブルクリックで名前と種類を変える）`, `${row.name} (double-click to change the name and type)`) : undefined}>
            {row.name}
          </b>
          {row.type === 'orig' && (
            // ゲームで鳴るのはこの音（譜面の BGM）。ステムはエディタで聴くためだけ
            <span className="trk-tag" title={tr('譜面の BGM（#WAV・ch01）です。ゲームではこの音が鳴ります', 'The chart’s BGM (#WAV, ch01). This is what plays in the game')}>
              BGM
            </span>
          )}
          {isStem && (
            <button className={`ib trk-edit ${edit ? 'open' : ''}`} onClick={openEdit} title={tr('名前と種類を変える（名前のダブルクリック・右クリックでも）', 'Change the name and type (or double-click / right-click the name)')} aria-label={tr(`${row.name}の名前と種類を変える`, `Change the name and type of ${row.name}`)}>
              {Icon.pencil(11)}
            </button>
          )}
        </span>
        {tall && (
          <span className="sub ellipsis" title={row.sub}>
            {row.sub}
          </span>
        )}
      </div>
      {row.type === 'orig' || row.type === 'stem' ? (
        <button
          className={`radio-btn small ${isAnalysis ? 'on' : ''}`}
          onClick={() => {
            if (row.type === 'orig') chooseAnalysisStem(null);
            else chooseAnalysisStem(isAnalysis && !eff?.auto ? null : row.id);
          }}
          title={
            isAnalysis
              ? tr('解析元：波形・原曲の打点・BPM推定をこのトラックから作っています', 'Analysis source: the waveform, detected hits and BPM estimate come from this track')
              : tr('解析元にする（波形・原曲の打点・BPM推定をこのトラックから作る）', 'Use as the analysis source (the waveform, detected hits and BPM estimate come from this track)')
          }
          aria-label={tr(`${row.name}を解析元にする`, `Use ${row.name} as the analysis source`)}
          aria-pressed={isAnalysis}
        />
      ) : (
        <span className="radio-pad" />
      )}
      <button className={`ms m ${muted ? 'on' : ''}`} onClick={() => set({ mute: !muted })} aria-label={tr(`${row.name}をミュート`, `Mute ${row.name}`)} title={`${tr('ミュート', 'Mute')}${row.type === 'chart' ? tr('（Alt+2）', ' (Alt+2)') : ''}`}>
        M
      </button>
      <button
        className={`ms s ${soloed ? 'on' : ''}`}
        onClick={(e) => (e.altKey ? soloOnly(row.id) : set({ solo: !soloed }))}
        aria-label={tr(`${row.name}をソロ`, `Solo ${row.name}`)}
        title={tr('ソロ（Alt+クリックでこのトラックだけ）', 'Solo (Alt+click for this track only)')}
      >
        S
      </button>
      <input
        type="range"
        className="trk-vol"
        min={0}
        max={maxGain}
        step={0.01}
        value={gain}
        style={{ accentColor: row.color }}
        onChange={(e) => set({ gain: Number(e.target.value) })}
        onDoubleClick={() => set({ gain: defGain })}
        aria-label={tr(`${row.name}の音量`, `${row.name} volume`)}
        title={tr(`${row.name}の音量 ${pct(gain)}（ダブルクリックで ${pct(defGain)} に戻す）`, `${row.name} volume ${pct(gain)} (double-click to reset to ${pct(defGain)})`)}
      />
      <span className="mono trk-v">{pct(gain)}</span>
      {row.type === 'orig' || row.type === 'stem' ? (
        <label className={`trk-spec ${specOn ? 'on' : ''}`} title={tr('譜面の右の列にこのトラックのスペクトルを出す（外すと波形に戻ります）', "Show this track's spectrum in the column right of the chart (uncheck to go back to the waveform)")}>
          <input
            type="checkbox"
            checked={specOn}
            disabled={!audio}
            onChange={(e) => {
              if (e.target.checked && audio) {
                useAssist.setState({ audioCols: true });
                setSpecSource(audio);
              } else {
                setSpecSource(null);
                setWaveMode('wave');
              }
            }}
          />
          {TD.tablet || TD.narrow ? (
            <>
              <span className="t-spec-ic" aria-hidden="true">
                {Icon.spectrum(TD.tablet ? 18 : 14)}
              </span>
              <span className="sr-only">{tr('スペクトル', 'Spectrum')}</span>
            </>
          ) : (
            tr('スペクトル', 'Spectrum')
          )}
        </label>
      ) : (
        <span className="trk-spec pad" />
      )}
      {edit && isStem && <StemTrackPopover file={row.id} anchor={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
