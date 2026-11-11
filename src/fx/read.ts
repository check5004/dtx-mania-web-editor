// 原曲から読み取る（AI は使わない）。原曲のスペクトル（そのまま・帯域ごとに曲全体の大きさでそろえたもの）で、
// ほかの帯域は鳴っているのに高い帯域（ローカットなら低い帯域）だけが暗い所を探し、境目の周波数を点の並びにする。
// 目安なので、画面では点線の案として出し、聴いてから採用してもらう。
import { specFreq, type SpectroData } from '../audio/spectro';
import { FX_HI, FX_LO } from './model';

/** 見る間隔（秒） */
const STEP = 0.25;
/** 鳴っている帯域とみなす大きさ（中ほどの帯域より何 dB 下まで） */
const PRESENT_DB = 15;
/** 暗い所とみなす、ふだんの境目からの離れ（オクターブ）。始まりと終わりは浅い方で広げる */
const DEEP_OCT = 0.75;
const SHALLOW_OCT = 0.33;
/** 見つけた所の短さの下限（秒） */
const MIN_SEC = 1;

export type ReadKind = 'hicut' | 'locut';

/** 読み取った点（秒は原曲の中の時刻、v は Hz。最初と最後は「かけない」） */
export interface ReadKey {
  sec: number;
  v: number;
}

export interface ReadRegion {
  type: ReadKind;
  from: number;
  to: number;
  /** 細かい点（間引く前） */
  raw: ReadKey[];
}

/** そのまま（raw）の 0〜255 → 段の基準からの dB（−36〜0） */
const relDb = (v: number) => 36 * Math.cbrt(v / 255) - 36;

interface Win {
  sec: number;
  /** 段ごとの大きさ（dB、段の基準から） */
  rel: Float32Array;
  /** 中ほど（200 Hz〜2 kHz）の大きさ */
  mid: number;
}

function windows(sp: SpectroData, from: number, to: number): Win[] {
  const out: Win[] = [];
  const bins = sp.bins;
  const lo = Math.max(0, Math.floor(from / STEP));
  const hi = Math.floor(to / STEP);
  const midLo = Math.max(0, Math.floor((Math.log(200 / sp.fLo) / Math.log(sp.fHi / sp.fLo)) * bins));
  const midHi = Math.min(bins, Math.ceil((Math.log(2000 / sp.fLo) / Math.log(sp.fHi / sp.fLo)) * bins));
  for (let k = lo; k <= hi; k++) {
    const f0 = Math.floor(k * STEP * sp.rate);
    const f1 = Math.min(sp.frames, Math.floor((k + 1) * STEP * sp.rate));
    if (f1 <= f0) continue;
    const rel = new Float32Array(bins);
    for (let f = f0; f < f1; f++) for (let b = 0; b < bins; b++) rel[b] += relDb(sp.data[f * bins + b]);
    for (let b = 0; b < bins; b++) rel[b] /= f1 - f0;
    let mid = 0;
    for (let b = midLo; b < midHi; b++) mid += rel[b];
    out.push({ sec: (k + 0.5) * STEP, rel, mid: mid / Math.max(1, midHi - midLo) });
  }
  return out;
}

/** 窓の境目の周波数（ハイカットは鳴っているいちばん高い所、ローカットはいちばん低い所）。静かな窓は null */
function edgeOf(w: Win, sp: SpectroData, kind: ReadKind): number | null {
  if (w.mid < -28) return null;
  const bins = sp.bins;
  const at = (b: number) => (w.rel[Math.max(0, b - 1)] + w.rel[b] + w.rel[Math.min(bins - 1, b + 1)]) / 3;
  const floor = w.mid - PRESENT_DB;
  if (kind === 'hicut') {
    for (let b = bins - 1; b >= 0; b--) if (at(b) >= floor) return specFreq((b + 1) / bins, sp.fLo, sp.fHi);
    return null;
  }
  for (let b = 0; b < bins; b++) if (at(b) >= floor) return specFreq(b / bins, sp.fLo, sp.fHi);
  return null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/** ふだんからどれだけ離れているか（オクターブ。暗い側が正） */
const depth = (kind: ReadKind, f: number, typical: number) => (kind === 'hicut' ? Math.log2(typical / f) : Math.log2(f / typical));

/**
 * from〜to 秒（原曲の中の時刻）で、kind の暗い所を探す。ふだんの境目は曲全体で決める
 */
export function readCuts(sp: SpectroData, kind: ReadKind, from: number, to: number): ReadRegion[] {
  const all = windows(sp, 0, sp.frames / sp.rate);
  const edges = all.map((w) => edgeOf(w, sp, kind));
  const typical = median(edges.filter((e): e is number => e !== null));
  if (!typical) return [];
  const out: ReadRegion[] = [];
  const inScope = (w: Win) => w.sec >= from && w.sec <= to;
  let i = 0;
  while (i < all.length) {
    const e = edges[i];
    if (!inScope(all[i]) || e === null || depth(kind, e, typical) < DEEP_OCT) {
      i++;
      continue;
    }
    // 深い所から前後へ、浅い所まで広げる（静かな窓は 1 つまで越える）
    let a = i;
    while (a > 0 && inScope(all[a - 1]) && (edges[a - 1] === null || depth(kind, edges[a - 1]!, typical) >= SHALLOW_OCT)) a--;
    let b = i;
    while (b + 1 < all.length && inScope(all[b + 1]) && (edges[b + 1] === null || depth(kind, edges[b + 1]!, typical) >= SHALLOW_OCT)) b++;
    while (a < b && edges[a] === null) a++;
    while (b > a && edges[b] === null) b--;
    i = b + 1;
    const fromSec = all[a].sec - STEP / 2;
    const toSec = all[b].sec + STEP / 2;
    if (toSec - fromSec < MIN_SEC) continue;
    // 3 つの中央値でならした境目
    const raw: ReadKey[] = [];
    for (let k = a; k <= b; k++) {
      const near = [edges[k - 1], edges[k], edges[k + 1]].filter((x, j): x is number => x !== null && x !== undefined && k - 1 + j >= a && k - 1 + j <= b);
      if (!near.length) continue;
      raw.push({ sec: all[k].sec, v: Math.max(FX_LO, Math.min(FX_HI, median(near))) });
    }
    const open = kind === 'hicut' ? FX_HI : FX_LO;
    out.push({ type: kind, from: fromSec, to: toSec, raw: [{ sec: Math.max(0, fromSec - STEP), v: open }, ...raw, { sec: toSec + STEP, v: open }] });
  }
  return out;
}

/** 点を間引く（時間と、周波数のオクターブで見て、eps オクターブより外れない所は消す。最初と最後は残す） */
export function thinKeys(keys: readonly ReadKey[], eps: number, secPerOct = 2): ReadKey[] {
  if (keys.length <= 2) return [...keys];
  const xy = keys.map((k) => [k.sec / secPerOct, Math.log2(k.v)] as const);
  const keep = new Uint8Array(keys.length);
  keep[0] = 1;
  keep[keys.length - 1] = 1;
  const stack: [number, number][] = [[0, keys.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1;
    let bd = 0;
    const [x0, y0] = xy[s];
    const [x1, y1] = xy[e];
    for (let i = s + 1; i < e; i++) {
      const [x, y] = xy[i];
      // 縦（オクターブ）の離れ：線の上の同じ時刻の値との差
      const p = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      const d = Math.abs(y - (y0 + (y1 - y0) * p));
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0 && bd > eps) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return keys.filter((_, i) => keep[i]);
}
