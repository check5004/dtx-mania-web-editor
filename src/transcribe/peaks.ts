// モデルの出力（1/100 秒ごとの 0〜1）から打点を拾う。ADTOF の作者と同じ madmom の NotePeakPickingProcessor を写したもの:
// 前 0.1 秒・後 0.01 秒の平均より閾値以上高く、前 0.02 秒・後 0.01 秒の中で一番高いフレームを打点にし、
// 0.02 秒以内に続いた打点は最初の1つにまとめる。
import type { DrumClass } from '../bench/classes';
import { ADTOF, type DrumActivations } from './model';

export interface PeakOptions {
  /** 平均を取る範囲（秒）：前・後 */
  preAvg: number;
  postAvg: number;
  /** 一番高いかを見る範囲（秒）：前・後 */
  preMax: number;
  postMax: number;
  /** これ以内に続いた打点はまとめる（秒） */
  combine: number;
}

export const MADMOM_PEAKS: PeakOptions = { preAvg: 0.1, postAvg: 0.01, preMax: 0.02, postMax: 0.01, combine: 0.02 };

export interface Peak {
  /** 秒 */
  t: number;
  /** その打点の高さ（0〜1） */
  s: number;
}

/**
 * act の c 列目（nCls 列のうち）から打点を拾う。scipy の uniform_filter・maximum_filter（mode='constant'）と同じく、
 * 範囲の外は 0 として数える。
 */
export function pickPeaks(act: Float32Array, nCls: number, c: number, fps: number, threshold: number, o: PeakOptions = MADMOM_PEAKS): Peak[] {
  const n = Math.floor(act.length / nCls);
  const preAvg = Math.round(o.preAvg * fps);
  const postAvg = Math.round(o.postAvg * fps);
  const preMax = Math.round(o.preMax * fps);
  const postMax = Math.round(o.postMax * fps);
  const avgLen = preAvg + postAvg + 1;
  const a = (i: number) => act[i * nCls + c];
  // 累積和で移動平均
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + a(i);
  const det = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - preAvg);
    const hi = Math.min(n - 1, i + postAvg);
    const avg = (cum[hi + 1] - cum[lo]) / avgLen;
    const v = a(i);
    det[i] = v >= avg + threshold ? v : 0;
  }
  const out: Peak[] = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = det[i];
    if (!(v > 0)) continue;
    let mx = 0;
    for (let k = Math.max(0, i - preMax); k <= Math.min(n - 1, i + postMax); k++) if (det[k] > mx) mx = det[k];
    if (v !== mx) continue;
    const t = i / fps;
    // まとめる（'left'：まとまりの最初の打点を残す）
    if (out.length && t - last <= o.combine + 1e-12) continue;
    out.push({ t, s: v });
    last = t;
  }
  return out;
}

/**
 * 原曲にドラムが聞こえるとみなす、採譜したバスドラム・スネアの1分あたりの数（store/drums の drumsAudible）。
 * 2026-11-03 の手元の曲で、ドラム入りの原曲は 300 前後、ドラム抜きの BGM（bgm_d.ogg）は 2 だった。
 * 「DTXMania の曲」の BGM を調べるとき（src/nxlib/bgm.ts）も同じ数で決める
 */
export const AUDIBLE_PER_MIN = 20;

export interface DrumHit {
  /** 音の時刻（秒、音の頭が 0） */
  t: number;
  cls: DrumClass;
  /** 確からしさ（0〜1） */
  s: number;
}

/**
 * 採譜の結果から打点を拾う。sensitivity（0〜1、0.5 が作者の閾値）で閾値を上下させる
 * （1 で半分、0 で 2 倍）。時刻の順に並べて返す。
 */
export function drumHits(d: DrumActivations, sensitivity = 0.5, classes: readonly DrumClass[] = ADTOF.classes): DrumHit[] {
  const scale = 2 ** ((0.5 - sensitivity) * 2);
  const nCls = ADTOF.classes.length;
  const out: DrumHit[] = [];
  ADTOF.classes.forEach((cls, c) => {
    if (!classes.includes(cls)) return;
    const thr = Math.min(0.95, ADTOF.thresholds[c] * scale);
    for (const p of pickPeaks(d.act, nCls, c, d.fps, thr)) out.push({ t: p.t, cls, s: p.s });
  });
  return out.sort((x, y) => x.t - y.t);
}
