// 曲全体の拍と小節の頭を推定する：BPM の倍・半分のどれか、拍の位置、どの拍が 1 拍目か。
// 打点の強さ（低・中・高の帯域）を曲全体で小節の長さにたたみ、よくあるドラムの形
// （キックが 1・3 拍目、スネアが 2・4 拍目、1 拍目にシンバル）にいちばん合う所を探す。
// 形だけだと 1 拍目と 3 拍目はほとんど差が出ないので、和音（クロマ）とベースの音があれば、
// それが変わる所（前の 1 小節と後の 1 小節がいちばん違う拍）も手がかりにする。
// テスト曲 6 曲と README のデモ曲で BPM・1 小節目の頭とも作者の譜面と合う（前の推定は BPM 5 曲・頭 3/5 曲。
// 和音を 2 拍ずつ比べていた v0.53.0 はデモ曲で頭を 3 拍目にし、テスト曲 2 曲も僅差だった）。
import type { Band } from './analysis';
import type { FrameFeatures } from './features';

export interface GridInput {
  odf: Record<Band, Float32Array>;
  frameRate: number;
}

export interface BarGuess {
  bpm: number;
  /** 拍の位置（秒。0 以上 1 拍未満） */
  beat: number;
  /** 拍の位置から k 拍目（k = 0〜3）を 1 拍目としたときの、ドラムの形の合い方 */
  fit: number[];
  /** 1 拍目（拍の位置から何拍目か。0〜3） */
  k: number;
  /** 倍・半分を比べる点（形の合い方 × よくある BPM か） */
  score: number;
}

/** 1〜4 拍目の重み。キック（低域）・スネア（中域）・シンバル（高域） */
const KICK = [1, -0.3, 0.6, -0.3];
const SNARE = [-0.3, 1, -0.3, 1];
const CYMBAL = [0.3, 0, -0.1, 0];
/** 拍の裏の中域（4 つ打ちで裏にハイハットが入る曲で、2・4 拍目の裏に寄せる） */
const OFFBEAT = [-0.3, 0.5, -0.3, 0.5];
/** 和音の変わり目の重み（形と和音の変わり目は、どちらも平均 0・ばらつき 1 にそろえて足す） */
export const CHORD_WEIGHT = 0.75;

/** よくある BPM ほど 1 に近い（130 を中心に、倍・半分で下がる） */
export function bpmPrior(bpm: number): number {
  return Math.exp(-0.5 * (Math.log2(bpm / 130) / 0.85) ** 2);
}

/** 音楽が始まる所（秒）：低域の立ち上がりが、曲でいちばん強い所の 3 割を初めて超える所 */
export function musicStart(low: Float32Array, frameRate: number): number {
  let max = 0;
  for (let i = 0; i < low.length; i++) if (low[i] > max) max = low[i];
  if (!(max > 0)) return 0;
  for (let i = 0; i < low.length; i++) if (low[i] > max * 0.3) return i / frameRate;
  return 0;
}

/** 周期 periodSec（秒）で N 区分にたたむ（from 秒から後ろ）。平均を 1 にそろえる */
function fold(odf: Float32Array, fr: number, periodSec: number, from: number, N: number): Float64Array {
  const per = periodSec * fr;
  const h = new Float64Array(N);
  for (let i = Math.max(0, Math.floor(from * fr)); i < odf.length; i++) {
    const v = odf[i];
    if (!(v > 0)) continue;
    const pos = ((i / per) % 1) * N;
    const k = Math.min(N - 1, Math.floor(pos));
    const f = pos - k;
    h[k] += v * (1 - f);
    h[(k + 1) % N] += v * f;
  }
  let s = 0;
  for (let k = 0; k < N; k++) s += h[k];
  const m = s / N || 1;
  for (let k = 0; k < N; k++) h[k] /= m;
  return h;
}

/**
 * 拍の位置（秒。0 以上 1 拍未満）：低域＋中域（キック・スネア）を 1 拍の長さでたたんだ山。
 * シンバルの裏打ちに引っぱられないよう、高域は入れない
 */
export function beatPhase(inp: GridInput, bpm: number, from: number, B = 96): number {
  const fr = inp.frameRate;
  const beat = 60 / bpm;
  const lo = inp.odf.low;
  const mid = inp.odf.mid;
  const h = new Float64Array(B);
  const n = Math.min(lo.length, mid.length);
  for (let i = Math.max(0, Math.floor(from * fr)); i < n; i++) {
    const v = lo[i] + mid[i];
    if (!(v > 0.05)) continue;
    const pos = ((i / fr / beat) % 1) * B;
    const k = Math.min(B - 1, Math.floor(pos));
    const f = pos - k;
    h[k] += v * (1 - f);
    h[(k + 1) % B] += v * f;
  }
  const g = (k: number) => h[((k % B) + B) % B];
  const sm = (k: number) => g(k - 1) * 0.5 + g(k) + g(k + 1) * 0.5;
  let best = 0;
  for (let k = 1; k < B; k++) if (sm(k) > sm(best)) best = k;
  const l = sm(best - 1);
  const c = sm(best);
  const r = sm(best + 1);
  const den = l - 2 * c + r;
  const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
  const t = ((best + off) / B) * beat;
  return ((t % beat) + beat) % beat;
}

/**
 * BPM の候補ごとに、拍の位置と 1 拍目を推定し、倍・半分を比べる点をつける（点の高い順）。
 * 候補どうしを比べられるように、いちばん遅い候補の 1 小節の長さで一緒にたたむ（区分の細かさも秒でそろう）。
 * from は音楽が始まる所（秒。前の無音や前奏の雑音を入れない）
 */
export function guessBars(inp: GridInput, bpms: readonly number[], from = musicStart(inp.odf.low, inp.frameRate)): BarGuess[] {
  const list = bpms.filter((b) => Number.isFinite(b) && b > 0);
  if (list.length === 0 || inp.odf.low.length === 0) return [];
  const fr = inp.frameRate;
  const slow = Math.min(...list);
  const fast = Math.max(...list);
  const periodSec = 240 / slow;
  // いちばん速い候補で 1 拍 16 区分
  const N = Math.max(64, Math.round((fast / slow) * 64));
  const L = fold(inp.odf.low, fr, periodSec, from, N);
  const M = fold(inp.odf.mid, fr, periodSec, from, N);
  const H = fold(inp.odf.high, fr, periodSec, from, N);
  // 打点が少し前後しても拾えるよう、前後 1 区分の大きいほう
  const at = (p: Float64Array, x: number) => {
    const c = Math.round(x);
    let m = 0;
    for (let d = -1; d <= 1; d++) m = Math.max(m, p[(((c + d) % N) + N) % N]);
    return m;
  };
  const out = list.map((bpm): BarGuess => {
    const Lb = (N * slow) / (4 * bpm);
    const nBars = Math.max(1, Math.round(N / Lb / 4));
    const beat = beatPhase(inp, bpm, from);
    const phi = ((((beat / periodSec) % 1) + 1) % 1) * N;
    const fit: number[] = [];
    for (let k = 0; k < 4; k++) {
      let d = 0;
      for (let j = 0; j < nBars; j++) {
        for (let b = 0; b < 4; b++) {
          const x = phi + (j * 4 + k + b) * Lb;
          d += KICK[b] * at(L, x) + SNARE[b] * at(M, x) + CYMBAL[b] * at(H, x) + OFFBEAT[b] * at(M, x + Lb / 2);
        }
      }
      fit.push(d / nBars);
    }
    const k = pickDownbeat(fit);
    return { bpm, beat, fit, k, score: fit[k] * bpmPrior(bpm) };
  });
  return out.sort((a, b) => b.score - a.score);
}

/** 4 つを平均 0・ばらつき 1 にそろえる（みな同じなら 0） */
function zscore(a: readonly number[]): number[] {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  return a.map((x) => (sd > 1e-12 ? (x - m) / sd : 0));
}

/** ドラムの形（fit）と和音の変わり目（chords）から 1 拍目を選ぶ（拍の位置から何拍目か） */
export function pickDownbeat(fit: readonly number[], chords?: readonly number[] | null, w = CHORD_WEIGHT): number {
  const zf = zscore(fit);
  const zc = chords && chords.length === 4 ? zscore(chords) : [0, 0, 0, 0];
  let k = 0;
  for (let q = 1; q < 4; q++) if (zf[q] + w * zc[q] > zf[k] + w * zc[k]) k = q;
  return k;
}

/** 1 拍目の時刻（秒）：音楽が始まる所（from）より後で最初の 1 拍目。k は拍の位置から何拍目か */
export function firstDownbeat(g: Pick<BarGuess, 'bpm' | 'beat' | 'k'>, from: number, k = g.k): number {
  const len = 60 / g.bpm;
  const bar = 4 * len;
  const phase = g.beat + k * len;
  let t = phase + Math.ceil((from - 0.08 - phase) / bar) * bar;
  while (t < 0) t += bar;
  return t;
}

/** 和音の変わり目を比べる長さ（拍）。和音もベースの音も小節の頭で変わりやすいので、1 小節ずつ比べる */
export const CHORD_SPAN = 4;

/**
 * 和音の変わり目：拍の位置から k 拍目（k = 0〜3。4 拍ごと）の拍で、前の 1 小節と後の 1 小節の和音（クロマ）と
 * ベースの音（低い音のクロマ）がどれだけ違うかを、from〜to 秒の間で足したもの。
 * 本当の 1 拍目なら前後の窓がちょうど 1 小節ずつになり、違いがいちばん大きい（3 拍目だと窓が小節をまたいで、
 * 前後に同じ和音が混ざる）。2 拍ずつ比べると、小節の途中で変わるメロディーに引っぱられた。
 * ドラムだけの音では意味が無いので、和音の入った音（原曲・ドラム抜き）で測る。
 * ベースのクロマが無ければ（古い形の特徴）和音だけで測る
 */
export function chordChange(
  f: Pick<FrameFeatures, 'rate' | 'frames' | 'offset' | 'chroma'> & Partial<Pick<FrameFeatures, 'bass'>>,
  bpm: number,
  beat: number,
  from: number,
  to: number,
): number[] {
  const out = [0, 0, 0, 0];
  if (!(bpm > 0) || f.frames === 0) return out;
  const len = 60 / bpm;
  const W = CHORD_SPAN;
  const v = new Float64Array(12);
  const w = new Float64Array(12);
  /** t0〜t1 秒の 12 音の和を長さ 1 にそろえる */
  const sumOf = (src: Float32Array, t0: number, t1: number, dst: Float64Array) => {
    dst.fill(0);
    const a = Math.max(0, Math.ceil(t0 * f.rate - f.offset));
    const b = Math.min(f.frames - 1, Math.ceil(t1 * f.rate - f.offset) - 1);
    for (let k = a; k <= b; k++) for (let c = 0; c < 12; c++) dst[c] += src[k * 12 + c];
    let s = 0;
    for (let c = 0; c < 12; c++) s += dst[c] * dst[c];
    s = Math.sqrt(s) + 1e-9;
    for (let c = 0; c < 12; c++) dst[c] /= s;
  };
  /** t 秒の前と後の W 拍の違い（1 − 似ている度合い） */
  const change = (src: Float32Array, t: number) => {
    sumOf(src, t - W * len, t, v);
    sumOf(src, t, t + W * len, w);
    let d = 0;
    for (let c = 0; c < 12; c++) d += v[c] * w[c];
    return 1 - d;
  };
  for (let i = Math.ceil((Math.max(0, from) - beat) / len) + W; beat + (i + W) * len <= to; i++) {
    const t = beat + i * len;
    // ベースの無い曲では低い音はキックぐらいで、小節ごとにほとんど変わらず和音の違いの邪魔をしない（それぞれをそろえずに足す）
    out[((i % 4) + 4) % 4] += change(f.chroma, t) + (f.bass ? change(f.bass, t) : 0);
  }
  return out;
}
