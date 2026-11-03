// 譜面のチップと原曲の打点（ドラムの採譜）を照らし合わせて、時刻のずれを測る。
//   ・曲の頭から終わりまで同じだけずれている → 開始位置（BGM の位置）のずれ
//   ・後ろほどずれが大きくなる（BPM が一定の譜面）→ BPM が少し違う
//   ・場所によってばらばら → テンポが揺れる曲。テンポ合わせで何か所か合わせる
// 採譜の打点は 1/100 秒刻みだが、たくさんの打点の中央値を取るので数 ms の精度で測れる（docs/bench.md）。
import { produce, type Draft } from 'immer';
import { classOfChannel, type DrumClass } from '../bench/classes';
import { frac } from '../dtx/fraction';
import { CH, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { BGM_DIV } from './tempoPlan';

export interface ChipTime {
  /** 原曲の時刻（秒） */
  t: number;
  /** 譜面の拍 */
  beat: number;
  cls: DrumClass;
}

export interface HitTime {
  /** 原曲の時刻（秒） */
  t: number;
}

export type HitsByClass = Record<DrumClass, readonly HitTime[]>;

export interface OffsetPair {
  beat: number;
  /** チップの時刻（原曲の秒） */
  c: number;
  /** 原曲の打点の時刻 */
  h: number;
}

export type OffsetVerdict = 'ok' | 'start' | 'bpm' | 'uneven' | 'few';

export interface BpmFit {
  /** 今の BPM */
  from: number;
  /** 合う BPM（曲の長さの中でずれが 3ms 以内に収まる桁で丸めたもの） */
  bpm: number;
  /** その BPM で、譜面の 0 拍目が原曲の何秒か */
  t0: number;
  /** 直したあとに残るばらつき（秒） */
  resid: number;
}

export interface OffsetReport {
  /** 照らし合わせた組（チップの時刻の順） */
  pairs: OffsetPair[];
  /** 原曲が鳴っている範囲のチップの数 */
  chips: number;
  /** 原曲の打点 − チップ の中央値（秒）。正なら原曲の打点が後ろ（譜面のグリッドが早い） */
  offset: number;
  /** ばらつき（秒、中央値からの差の中央値 × 1.48） */
  spread: number;
  /** 曲の頭・終わりのあたりのずれ（秒）。照らし合わせた組を6つに分けた最初と最後の中央値 */
  head: number;
  tail: number;
  /** 6つに分けたずれの中央値の、いちばん小さい・大きいもの（秒） */
  lo: number;
  hi: number;
  /** BPM が一定の譜面で、BPM を直すと合うときの BPM（それ以外は null） */
  bpmFit: BpmFit | null;
  verdict: OffsetVerdict;
}

export const OFFSET_LIMITS = {
  /** これ以上ずれていたら直すよう出す（秒）。実際の録音では、正しい譜面でも 10ms くらいずれていることがある */
  start: 0.012,
  /** BPM が違うと見るのは、頭と終わりのずれの差がこれ以上のとき（秒） */
  drift: 0.015,
  /** 場所ごとのずれの幅がこれ以上なら、テンポが揺れていると見る（秒） */
  uneven: 0.025,
  /** 照らし合わせた組がこれより少なければ測らない */
  minPairs: 16,
  /** 照らし合わせられたチップがこの割合より少なければ測らない */
  minCoverage: 0.2,
};

/** 譜面のドラムのチップ（見えるもの）を原曲の時刻にする。原曲の外（頭より前・終わりより後）は除く */
export function chipTimes(doc: DtxDoc, tempo: TempoMap, bgmSec: number, dur: number): ChipTime[] {
  const out: ChipTime[] = [];
  for (const c of doc.chips) {
    const cls = classOfChannel(c.ch);
    if (!cls) continue;
    const beat = tempo.beatOf(c.m, c.f);
    const t = tempo.beatToSec(beat) - bgmSec;
    if (t < 0 || t > dur) continue;
    out.push({ t, beat, cls });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function mad(xs: readonly number[], center: number): number {
  return 1.4826 * median(xs.map((x) => Math.abs(x - center)));
}

/** t 以上の最初の打点 */
function lowerBound(list: readonly HitTime[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const md = (lo + hi) >> 1;
    if (list[md].t < t) lo = md + 1;
    else hi = md;
  }
  return lo;
}

/** 山を探す範囲（秒） */
const PEAK_W = 0.12;
/** 山の前後に打点を探す幅（秒） */
const TOL = 0.025;

/**
 * chips[i0..i1) と同じ種類の打点との時刻の差を数え、center ± 120ms の中でいちばん多い差（秒）を返す。
 * 細かい連打では 1打ずれた所にも山ができるので、center に近い方を少しだけ選びやすくする。
 */
function localPeak(chips: readonly ChipTime[], i0: number, i1: number, hits: HitsByClass, center: number): number | null {
  const R = Math.round(PEAK_W * 1000);
  const bins = new Float64Array(2 * R + 1);
  let votes = 0;
  for (let i = i0; i < i1; i++) {
    const c = chips[i];
    const list = hits[c.cls];
    const from = c.t + center;
    for (let j = lowerBound(list, from - PEAK_W); j < list.length && list[j].t <= from + PEAK_W; j++) {
      bins[Math.round((list[j].t - from) * 1000) + R] += 1;
      votes++;
    }
  }
  if (votes < 8) return null;
  // 採譜の打点は 10ms 刻みなので、±6ms の三角でならす
  const K = 6;
  const sm = new Float64Array(bins.length);
  for (let i = 0; i < bins.length; i++) {
    let v = 0;
    for (let k = -K; k <= K; k++) {
      const j = i + k;
      if (j >= 0 && j < bins.length) v += bins[j] * (K + 1 - Math.abs(k));
    }
    sm[i] = v * (1 - (0.15 * Math.abs(i - R)) / R);
  }
  let best = R;
  for (let i = 0; i < sm.length; i++) if (sm[i] > sm[best]) best = i;
  // 山と呼べるほど高くなければ（譜面と原曲が合っていない所）測らない
  const mean = sm.reduce((a, b) => a + b, 0) / sm.length;
  if (sm[best] < mean * 2) return null;
  return center + (best - R) / 1000;
}

/** チップの間がこれ以上空いたら（ドラムが休む所）、その先で探し直す（秒） */
const GAP = 3;

/**
 * チップごとに、同じ種類のいちばん近い打点を組にする（1つの打点は1つのチップだけ）。
 * ずれは曲の中でゆっくり変わってもよい（BPM が少し違う、テンポが揺れる）ように、直前の組のずれを追いかける。
 */
export function matchChips(chips: readonly ChipTime[], hits: HitsByClass): OffsetPair[] {
  const used = new Map<DrumClass, Set<number>>();
  const usedOf = (cls: DrumClass) => {
    let u = used.get(cls);
    if (!u) used.set(cls, (u = new Set()));
    return u;
  };
  const pairs: OffsetPair[] = [];
  let est: number | null = null;
  /** 最後に分かっていたずれ（探し直すときはこの近くから） */
  let last = 0;
  const recent: number[] = [];
  let misses = 0;
  let i = 0;
  while (i < chips.length) {
    if (est !== null && i > 0 && chips[i].t - chips[i - 1].t > GAP) {
      last = est;
      est = null;
    }
    if (est === null) {
      // 次の 15 秒（少なくとも 24 打）でいちばん多いずれを探す
      let j = i;
      while (j < chips.length && (chips[j].t < chips[i].t + 15 || j - i < 24)) j++;
      est = localPeak(chips, i, j, hits, last);
      recent.length = 0;
      misses = 0;
      if (est === null) {
        i = j;
        continue;
      }
    }
    const c = chips[i];
    const list = hits[c.cls];
    const want = c.t + est;
    const u = usedOf(c.cls);
    let bestK = -1;
    let bestD = Infinity;
    for (let k = lowerBound(list, want - TOL); k < list.length && list[k].t <= want + TOL; k++) {
      const d = Math.abs(list[k].t - want);
      if (d < bestD && !u.has(k)) {
        bestD = d;
        bestK = k;
      }
    }
    if (bestK >= 0) {
      u.add(bestK);
      pairs.push({ beat: c.beat, c: c.t, h: list[bestK].t });
      recent.push(list[bestK].t - c.t);
      if (recent.length > 24) recent.shift();
      if (recent.length >= 8) est = median(recent);
      misses = 0;
    } else if (++misses >= 16) {
      // しばらく見つからなければ、その先で探し直す
      last = est;
      est = null;
    }
    i++;
  }
  return pairs;
}

/** 最小二乗の直線 y = a + b·x */
function fitLine(xs: readonly number[], ys: readonly number[]): { a: number; b: number } {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** BPM が曲の頭から終わりまで同じなら、その BPM */
export function constantBpm(tempo: TempoMap): number | null {
  const evs = tempo.events;
  if (evs.length === 0) return tempo.initialBpm;
  const b = evs[0].bpm;
  return evs.every((e) => Math.abs(e.bpm - b) < 1e-6) ? b : null;
}

/** 合う BPM を、照らし合わせた範囲（拍数）の中でずれが 3ms 以内に収まるいちばん短い桁で丸める */
export function roundFitBpm(bpm: number, spanBeats: number): number {
  const beat = 60 / bpm;
  for (let k = 0; k <= 3; k++) {
    const p = 10 ** k;
    const r = Math.round(bpm * p) / p;
    if (Math.abs(60 / r - beat) * spanBeats <= 0.003) return r;
  }
  return Math.round(bpm * 1000) / 1000;
}

/** BPM が一定の譜面で、原曲の打点に合う BPM と 0 拍目の時刻を求める */
function fitBpm(pairs: readonly OffsetPair[], bpmNow: number): BpmFit | null {
  if (pairs.length < OFFSET_LIMITS.minPairs) return null;
  let use = pairs;
  let line = fitLine(
    use.map((p) => p.beat),
    use.map((p) => p.h),
  );
  // 外れた組を除いてもう一度
  for (let round = 0; round < 2; round++) {
    const res = use.map((p) => p.h - line.a - line.b * p.beat);
    const s = Math.max(mad(res, median(res)), 0.004);
    const keep = use.filter((_, i) => Math.abs(res[i]) <= 2.5 * s);
    if (keep.length < OFFSET_LIMITS.minPairs || keep.length === use.length) break;
    use = keep;
    line = fitLine(
      use.map((p) => p.beat),
      use.map((p) => p.h),
    );
  }
  if (!(line.b > 0)) return null;
  const span = use[use.length - 1].beat - use[0].beat;
  const bpm = roundFitBpm(60 / line.b, span);
  const per = 60 / bpm;
  const t0 = median(pairs.map((p) => p.h - p.beat * per));
  const resid = mad(
    pairs.map((p) => p.h - t0 - p.beat * per),
    0,
  );
  return { from: bpmNow, bpm, t0, resid };
}

/**
 * ずれを測って、開始位置か BPM か（テンポの揺れか）を見立てる。
 * bpmNow は BPM が一定の譜面のときの BPM（変わる譜面なら null。BPM は見立てない）。
 */
export function analyzeOffset(chips: readonly ChipTime[], hits: HitsByClass, bpmNow: number | null): OffsetReport {
  const pairs = matchChips(chips, hits);
  const d = pairs.map((p) => p.h - p.c);
  const offset = median(d);
  const spread = d.length ? mad(d, offset) : 0;
  // 6つに分けて、場所ごとのずれ
  const G = Math.max(1, Math.min(6, Math.floor(pairs.length / 6)));
  const groups: number[] = [];
  for (let g = 0; g < G; g++) {
    const a = Math.floor((g * d.length) / G);
    const b = Math.floor(((g + 1) * d.length) / G);
    groups.push(median(d.slice(a, b)));
  }
  // 頭・終わりは最初と最後の 1割（少なくとも 8 組）
  const edge = Math.min(d.length, Math.max(8, Math.floor(d.length / 10)));
  const head = median(d.slice(0, edge));
  const tail = median(d.slice(d.length - edge));
  const lo = groups.length ? Math.min(...groups) : 0;
  const hi = groups.length ? Math.max(...groups) : 0;
  const L = OFFSET_LIMITS;
  const enough = pairs.length >= L.minPairs && pairs.length >= chips.length * L.minCoverage;
  let bpmFit: BpmFit | null = null;
  let verdict: OffsetVerdict;
  if (!enough) {
    verdict = 'few';
  } else {
    if (bpmNow !== null) {
      const fit = fitBpm(pairs, bpmNow);
      // 頭と終わりで BPM のずれ分だけ差が出ていて、BPM を直すとばらつきが減るなら BPM
      const drift = fit ? (60 / bpmNow - 60 / fit.bpm) * (pairs[pairs.length - 1].beat - pairs[0].beat) : 0;
      if (fit && fit.bpm !== bpmNow && Math.abs(drift) >= L.drift && fit.resid <= Math.max(spread * 0.85, 0.008)) bpmFit = fit;
    }
    if (bpmFit) verdict = 'bpm';
    else if (hi - lo >= L.uneven) verdict = 'uneven';
    else if (Math.abs(offset) >= L.start) verdict = 'start';
    else verdict = 'ok';
  }
  return { pairs, chips: chips.length, offset, spread, head, tail, lo, hi, bpmFit, verdict };
}

/** 原曲の from〜to 秒の中で照らし合わせた組のずれ（少なければ null） */
export function localOffset(r: OffsetReport, from: number, to: number, min = 6): number | null {
  const ps = r.pairs;
  let lo = 0;
  let hi = ps.length;
  while (lo < hi) {
    const md = (lo + hi) >> 1;
    if (ps[md].c < from) lo = md + 1;
    else hi = md;
  }
  const d: number[] = [];
  for (let i = lo; i < ps.length && ps[i].c <= to; i++) d.push(ps[i].h - ps[i].c);
  return d.length >= min ? median(d) : null;
}

/**
 * BGM のチップ（原曲。ステムも一緒に動く）を dSec 秒だけ前へ動かす（負なら後ろへ）。
 * 原曲が dSec 早く始まるので、譜面のグリッドは原曲に対して dSec 後ろへずれる。
 * 位置は NX と同じ 1小節 384 分割に丸める。返り値は丸めでずれた量（ミリ秒、いちばん大きいもの）。
 * 譜面の頭より前に出てしまうときは何もせず null。
 */
export function shiftBgm(d: Draft<DtxDoc>, tempo: TempoMap, dSec: number): number | null {
  const moves: { i: number; m: number; n: number }[] = [];
  let err = 0;
  for (let i = 0; i < d.chips.length; i++) {
    const c = d.chips[i];
    if (c.ch !== CH.BGM) continue;
    const sec = tempo.beatToSec(tempo.beatOf(c.m, c.f)) - dSec;
    if (sec < -1e-6) return null;
    const beat = tempo.secToBeat(Math.max(0, sec));
    let { m } = tempo.locate(beat);
    let n = Math.round(((beat - tempo.measureStart(m)) / tempo.measureBeats(m)) * BGM_DIV);
    if (n >= BGM_DIV) {
      m += 1;
      n = 0;
    }
    const got = tempo.beatToSec(tempo.measureStart(m) + (n / BGM_DIV) * tempo.measureBeats(m));
    err = Math.max(err, Math.abs(got - sec) * 1000);
    moves.push({ i, m, n });
  }
  if (moves.length === 0) return null;
  for (const mv of moves) {
    d.chips[mv.i].m = mv.m;
    d.chips[mv.i].f = frac(mv.n, BGM_DIV);
  }
  return err;
}

/** shiftBgm した譜面（できなければ null） */
export function withShiftedBgm(doc: DtxDoc, tempo: TempoMap, dSec: number): DtxDoc | null {
  let ok = true;
  const next = produce(doc, (d) => {
    ok = shiftBgm(d, tempo, dSec) !== null;
  });
  return ok ? next : null;
}
