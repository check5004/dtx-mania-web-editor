// YouTube の参照映像と原曲（音声ファイル）のずれを、音の特徴を比べて見つける。
//
// 波形そのものではなく、次の3つを比べる。MV・ライブ版のように音質や演奏が少し違っても、
// 曲の部分どうしが一番似ている所を探せる。
//   打点 … 低・中・高の帯域ごとの「音の立ち上がり」の強さ（10ms 刻み。ずれを細かく決める）
//   音色 … 帯域ごとの音の大きさ（24 段、dB）。帯域ごとに平均を引くので、EQ の違いは効かない
//   和音 … 12 音の強さ（50ms 刻み）。ライブ版やドラム抜きの音源でも似る
// 前置きのセリフ・効果音は曲のどこにも似ないので「似ていない」と出る（別の所で測り直す）。
//
// ・探り（YouTube から聞き取った十数秒）を原曲の全体と少しずつずらして比べる（正規化相互相関を FFT で一度に）
// ・3つの似かたを平均して一番高い所を選び、ほかの所よりどれだけ飛び抜けているか（z）を自信の目安にする
// ・何か所かで測った結果を突き合わせて、ずれが一定（MV・演奏動画）か、少しずつ変わる（ライブ）か、
//   途中で飛ぶ（編集の違い・ゲームサイズ）かを見分ける（decideOffset）
import { downmix, fft, resample } from './dsp';

export const ALIGN_SR = 16000;
/** 打点・音色の 1 秒あたりのフレーム数（10ms 刻み） */
export const ALIGN_FPS = 100;
const HOP = ALIGN_SR / ALIGN_FPS;
const WIN = 512;
export const MEL_BANDS = 24;
const MEL_LO = 40;
const MEL_HI = 7600;
/** 打点を分ける帯域の境目（Hz）: 低（キック・ベース）／中（スネア・声・ギター）／高（ハイハット・シンバル） */
const ONSET_SPLIT = [220, 2000];
const CHROMA_SR = 8000;
/** 和音の 1 秒あたりのフレーム数（50ms 刻み） */
export const CHROMA_FPS = 20;
const CHOP = CHROMA_SR / CHROMA_FPS;
const CWIN = 2048;
const C_RATIO = ALIGN_FPS / CHROMA_FPS;

/** 音の特徴。各チャンネルは時間方向に並ぶ（channel-major）。フレーム t の時刻は t / fps 秒（窓の真ん中） */
export interface AlignFeat {
  n: number;
  /** 打点の強さ（低・中・高）。各 n */
  onset: Float32Array[];
  /** 帯域ごとの音の大きさ（dB）。MEL_BANDS × n */
  mel: Float32Array;
  /** フレームの音の大きさ（dB、曲の大きい所が 0） */
  level: Float32Array;
  /** 和音のフレーム数 */
  cn: number;
  /** 12 音の強さ。12 × cn（フレームごとに長さ 1） */
  chroma: Float32Array;
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
  return w;
}

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

interface Tri {
  k0: number;
  w: Float32Array;
  center: number;
}

function melBank(n: number, sr: number): Tri[] {
  const m0 = hz2mel(MEL_LO);
  const m1 = hz2mel(MEL_HI);
  const df = sr / n;
  const out: Tri[] = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const lo = mel2hz(m0 + ((m1 - m0) * b) / (MEL_BANDS + 1));
    const c = mel2hz(m0 + ((m1 - m0) * (b + 1)) / (MEL_BANDS + 1));
    const hi = mel2hz(m0 + ((m1 - m0) * (b + 2)) / (MEL_BANDS + 1));
    const k0 = Math.max(1, Math.floor(lo / df));
    const k1 = Math.min(n / 2, Math.ceil(hi / df));
    const w = new Float32Array(Math.max(1, k1 - k0 + 1));
    let sum = 0;
    for (let k = k0; k <= k1; k++) {
      const f = k * df;
      const v = f <= c ? (f - lo) / Math.max(1e-9, c - lo) : (hi - f) / Math.max(1e-9, hi - c);
      w[k - k0] = Math.max(0, v);
      sum += w[k - k0];
    }
    // 狭い段（低い音）でも 1 本は拾う
    if (sum <= 0) w[Math.min(w.length - 1, Math.round(c / df) - k0)] = 1;
    out.push({ k0, w, center: c });
  }
  return out;
}

/** 大きい所（98% 点）が 0.1 になるように音量を揃えた信号（探りと原曲で音量が違っても特徴が同じになるように） */
function normalizeLevel(x: Float32Array, sr: number): Float32Array {
  const blk = Math.max(1, Math.round(sr * 0.05));
  const rms: number[] = [];
  for (let i = 0; i + blk <= x.length; i += blk) {
    let s = 0;
    for (let j = i; j < i + blk; j++) s += x[j] * x[j];
    rms.push(Math.sqrt(s / blk));
  }
  if (rms.length === 0) return x;
  rms.sort((a, b) => a - b);
  const ref = rms[Math.min(rms.length - 1, Math.floor(rms.length * 0.98))];
  if (!(ref > 1e-6)) return x;
  const g = 0.1 / ref;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

/** 音から特徴を作る（原曲は数秒、探りは一瞬） */
export function alignFeatures(channels: Float32Array[], sr: number, progress?: (p: number) => void): AlignFeat {
  const x = normalizeLevel(resample(downmix(channels), sr, ALIGN_SR), ALIGN_SR);
  const n = Math.max(1, Math.floor(x.length / HOP));

  // ---- 打点・音色（512 点、10ms 刻み） ----
  const win = hann(WIN);
  const bank = melBank(WIN, ALIGN_SR);
  const re = new Float32Array(WIN);
  const im = new Float32Array(WIN);
  const pow = new Float32Array(WIN / 2 + 1);
  const melE = new Float32Array(MEL_BANDS * n);
  const totE = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const c = t * HOP - WIN / 2;
    for (let i = 0; i < WIN; i++) {
      const j = c + i;
      re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= WIN / 2; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
    let tot = 0;
    for (let b = 0; b < MEL_BANDS; b++) {
      const f = bank[b];
      let s = 0;
      for (let i = 0; i < f.w.length; i++) s += pow[f.k0 + i] * f.w[i];
      melE[b * n + t] = s;
      tot += s;
    }
    totE[t] = tot;
    if (progress && (t & 4095) === 0) progress((0.6 * t) / n);
  }
  // dB（大きい所を 0 dB、下は -80 dB まで）
  const ref = Math.max(1e-12, quantileOf(totE, 0.99));
  const floor = ref * 1e-8;
  const mel = new Float32Array(MEL_BANDS * n);
  for (let i = 0; i < mel.length; i++) mel[i] = 10 * Math.log10(Math.max(melE[i], floor * 0.04) / ref);
  const level = new Float32Array(n);
  for (let t = 0; t < n; t++) level[t] = 10 * Math.log10(Math.max(totE[t], floor) / ref);

  // 打点: 帯域ごとの dB の上がり分を、低・中・高でまとめる
  const group = bank.map((f) => (f.center < ONSET_SPLIT[0] ? 0 : f.center < ONSET_SPLIT[1] ? 1 : 2));
  const counts = [0, 0, 0];
  for (const g of group) counts[g]++;
  const onset = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let b = 0; b < MEL_BANDS; b++) {
    const o = onset[group[b]];
    const row = b * n;
    for (let t = 1; t < n; t++) {
      const d = mel[row + t] - mel[row + t - 1];
      if (d > 0) o[t] += d;
    }
  }
  for (let g = 0; g < 3; g++) {
    const o = onset[g];
    const k = 1 / Math.max(1, counts[g]);
    // 少しなめらかにする（録り方による数 ms の揺れで似かたが落ちないように）
    let p = 0;
    for (let t = 0; t < n; t++) {
      const cur = o[t] * k;
      const next = t + 1 < n ? o[t + 1] * k : 0;
      o[t] = 0.25 * p + 0.5 * cur + 0.25 * next;
      p = cur;
    }
  }

  // ---- 和音（8kHz・2048 点・50ms 刻み） ----
  const y = resample(x, ALIGN_SR, CHROMA_SR);
  const cn = Math.max(1, Math.floor(y.length / CHOP));
  const cwin = hann(CWIN);
  const cre = new Float32Array(CWIN);
  const cim = new Float32Array(CWIN);
  const df = CHROMA_SR / CWIN;
  const kLo = Math.ceil(55 / df);
  const kHi = Math.min(CWIN / 2 - 1, Math.floor(3600 / df));
  const pcA = new Int8Array(kHi + 1);
  const pcW = new Float32Array(kHi + 1);
  for (let k = kLo; k <= kHi; k++) {
    const p = 69 + 12 * Math.log2((k * df) / 440);
    const f = Math.floor(p);
    pcA[k] = ((f % 12) + 12) % 12;
    pcW[k] = 1 - (p - f);
  }
  const chroma = new Float32Array(12 * cn);
  const v = new Float64Array(12);
  for (let t = 0; t < cn; t++) {
    const c = t * CHOP - CWIN / 2;
    for (let i = 0; i < CWIN; i++) {
      const j = c + i;
      cre[i] = j >= 0 && j < y.length ? y[j] * cwin[i] : 0;
      cim[i] = 0;
    }
    fft(cre, cim);
    v.fill(0);
    for (let k = kLo; k <= kHi; k++) {
      const m = Math.log1p(40 * Math.sqrt(cre[k] * cre[k] + cim[k] * cim[k]));
      const a = pcA[k];
      v[a] += m * pcW[k];
      v[(a + 1) % 12] += m * (1 - pcW[k]);
    }
    let s = 0;
    for (let q = 0; q < 12; q++) s += v[q] * v[q];
    const inv = s > 1e-9 ? 1 / Math.sqrt(s) : 0;
    for (let q = 0; q < 12; q++) chroma[q * cn + t] = v[q] * inv;
    if (progress && (t & 1023) === 0) progress(0.6 + (0.4 * t) / cn);
  }
  progress?.(1);
  return { n, onset, mel, level, cn, chroma };
}

function quantileOf(x: ArrayLike<number>, q: number): number {
  const step = Math.max(1, Math.floor(x.length / 20000));
  const s: number[] = [];
  for (let i = 0; i < x.length; i += step) s.push(x[i]);
  if (s.length === 0) return 0;
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/** 探りの一部（秒）を切り出す（長い聞き取りを、曲の所だけで比べ直すとき） */
export function sliceFeat(f: AlignFeat, fromSec: number, toSec: number): AlignFeat {
  const t0 = Math.max(0, Math.min(f.n, Math.round(fromSec * ALIGN_FPS)));
  const t1 = Math.max(t0, Math.min(f.n, Math.round(toSec * ALIGN_FPS)));
  const c0 = Math.max(0, Math.min(f.cn, Math.round(fromSec * CHROMA_FPS)));
  const c1 = Math.max(c0, Math.min(f.cn, Math.round(toSec * CHROMA_FPS)));
  const n = t1 - t0;
  const cn = c1 - c0;
  const mel = new Float32Array(MEL_BANDS * n);
  for (let b = 0; b < MEL_BANDS; b++) mel.set(f.mel.subarray(b * f.n + t0, b * f.n + t1), b * n);
  const chroma = new Float32Array(12 * cn);
  for (let q = 0; q < 12; q++) chroma.set(f.chroma.subarray(q * f.cn + c0, q * f.cn + c1), q * cn);
  return { n, onset: f.onset.map((o) => o.slice(t0, t1)), mel, level: f.level.slice(t0, t1), cn, chroma };
}

/** 曲の音が鳴っているフレームの割合（無音・ほぼ無音の探りは比べても当てにならない） */
export function activeRatio(f: AlignFeat, thresholdDb = -45): number {
  if (f.n === 0) return 0;
  let k = 0;
  for (let t = 0; t < f.n; t++) if (f.level[t] > thresholdDb) k++;
  return k / f.n;
}

// ---- 比べる（正規化相互相関） ---------------------------------------------------------------

type Group = 'onset' | 'mel' | 'chroma';
const GROUPS: Group[] = ['onset', 'mel', 'chroma'];

function channelsOf(f: AlignFeat, g: Group): { ch: Float32Array[]; len: number } {
  if (g === 'onset') return { ch: f.onset, len: f.n };
  if (g === 'mel') return { ch: Array.from({ length: MEL_BANDS }, (_, b) => f.mel.subarray(b * f.n, (b + 1) * f.n)), len: f.n };
  return { ch: Array.from({ length: 12 }, (_, q) => f.chroma.subarray(q * f.cn, (q + 1) * f.cn)), len: f.cn };
}

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
/** 探りが原曲の端からはみ出してよい割合 */
const EDGE = 0.15;

interface GroupIndex {
  /** 探りの長さ（フレーム） */
  m: number;
  /** 原曲の前後に足した余白（フレーム）。探りの 15% まではみ出してよい（端の半端な重なりは偶然似やすいので狭く） */
  pad: number;
  L: number;
  /** 原曲（平均を引いて余白を足したもの）の FFT。チャンネルごとに re・im */
  spec: { re: Float32Array; im: Float32Array }[];
  /** ずらし l' ごとの、窓の中の分散の合計（チャンネルの和） */
  yvar: Float64Array;
}

/** 原曲の側の下ごしらえ（探りの長さごとに作り、使い回す） */
export interface RefIndex {
  feat: AlignFeat;
  m: number;
  groups: Record<Group, GroupIndex>;
}

function buildGroup(ref: AlignFeat, g: Group, m: number): GroupIndex {
  const { ch, len } = channelsOf(ref, g);
  const pad = Math.floor(m * EDGE);
  const total = len + 2 * pad;
  const L = pow2(total + m);
  const lags = Math.max(1, total - m + 1);
  const yvar = new Float64Array(lags);
  const spec = ch.map((c) => {
    let mean = 0;
    for (let i = 0; i < len; i++) mean += c[i];
    mean /= Math.max(1, len);
    const re = new Float32Array(L);
    const im = new Float32Array(L);
    for (let i = 0; i < len; i++) re[pad + i] = c[i] - mean;
    // 窓の分散（余白は平均＝0 として数える）
    const s1 = new Float64Array(total + 1);
    const s2 = new Float64Array(total + 1);
    for (let i = 0; i < total; i++) {
      const v = re[i];
      s1[i + 1] = s1[i] + v;
      s2[i + 1] = s2[i] + v * v;
    }
    for (let l = 0; l < lags; l++) {
      const a = s1[l + m] - s1[l];
      const b = s2[l + m] - s2[l];
      yvar[l] += Math.max(0, b - (a * a) / m);
    }
    fft(re, im);
    return { re, im };
  });
  return { m, pad, L, spec, yvar };
}

export function buildRefIndex(ref: AlignFeat, probeFrames: number): RefIndex {
  const m = Math.max(10, Math.floor(probeFrames));
  const mc = Math.max(4, Math.floor(m / C_RATIO));
  return {
    feat: ref,
    m,
    groups: { onset: buildGroup(ref, 'onset', m), mel: buildGroup(ref, 'mel', m), chroma: buildGroup(ref, 'chroma', mc) },
  };
}

/** ずらし l'（余白込み）ごとの正規化相互相関 */
function nccGroup(idx: GroupIndex, probe: AlignFeat, g: Group): Float32Array {
  const { ch } = channelsOf(probe, g);
  const { m, L, spec, yvar } = idx;
  const accRe = new Float64Array(L);
  const accIm = new Float64Array(L);
  const re = new Float32Array(L);
  const im = new Float32Array(L);
  let xn = 0;
  ch.forEach((c, i) => {
    let mean = 0;
    const k = Math.min(m, c.length);
    for (let t = 0; t < k; t++) mean += c[t];
    mean /= Math.max(1, k);
    re.fill(0);
    im.fill(0);
    for (let t = 0; t < k; t++) {
      const v = c[t] - mean;
      re[t] = v;
      xn += v * v;
    }
    fft(re, im);
    const s = spec[i];
    // Y · conj(X)
    for (let f = 0; f < L; f++) {
      accRe[f] += s.re[f] * re[f] + s.im[f] * im[f];
      accIm[f] += s.im[f] * re[f] - s.re[f] * im[f];
    }
  });
  // 逆 FFT（共役をとって FFT）
  for (let f = 0; f < L; f++) {
    re[f] = accRe[f];
    im[f] = -accIm[f];
  }
  fft(re, im);
  const lags = yvar.length;
  const out = new Float32Array(lags);
  if (xn <= 1e-12) return out;
  for (let l = 0; l < lags; l++) {
    const num = re[l] / L;
    const den = Math.sqrt(xn * yvar[l]);
    out[l] = den > 1e-9 ? num / den : 0;
  }
  return out;
}

export interface AlignMatch {
  /** 探りの頭（0 秒）が原曲の何秒か */
  sec: number;
  /** 3 つの似かたの平均（-1〜1。同じ録音なら 0.5 以上、別の演奏なら 0.2〜0.4 くらい） */
  score: number;
  /** ほかのずらしと比べてどれだけ飛び抜けているか（ロバストな z。8 以上なら当てになる） */
  z: number;
  parts: Record<Group, number>;
}

export interface AlignSearch {
  cands: AlignMatch[];
  /** 探りの中で音が鳴っていた割合 */
  active: number;
  /**
   * ずらしごとの z（候補に出なかった所も含む全体）。原曲の秒 = (l - pad) / ALIGN_FPS。
   * 「ほかの探りが決めたずれでも、この探りは似ているか」を確かめるのに使う
   */
  zc?: Float32Array;
  pad?: number;
}

export const ALIGN_WEIGHTS: Record<Group, number> = { onset: 1, mel: 1, chroma: 1 };

/**
 * 探りを原曲の全体と比べ、似ている所の候補（よい順）を返す。
 * idx は探りの長さ（フレーム）で作ったもの（違う長さの探りは頭から idx.m フレームだけ使う）
 */
export function searchProbe(idx: RefIndex, probe: AlignFeat, maxCands = 6): AlignSearch {
  const active = activeRatio(probe);
  const og = idx.groups.onset;
  const curves = {} as Record<Group, Float32Array>;
  for (const g of GROUPS) curves[g] = nccGroup(idx.groups[g], probe, g);
  // 100fps のずらし l（原曲の秒 = l / 100）でまとめる
  const lagsN = og.yvar.length;
  const comb = new Float32Array(lagsN);
  const wsum = GROUPS.reduce((s, g) => s + ALIGN_WEIGHTS[g], 0);
  const cg = idx.groups.chroma;
  const partAt = (g: Group, l: number): number => {
    // l は余白込み（onset の l'）。原曲のフレーム = l - pad
    if (g !== 'chroma') return curves[g][l] ?? 0;
    const fc = (l - og.pad) / C_RATIO + cg.pad;
    const i = Math.floor(fc);
    const f = fc - i;
    const c = curves.chroma;
    if (i < 0) return c[0] ?? 0;
    if (i + 1 >= c.length) return c[c.length - 1] ?? 0;
    return c[i] * (1 - f) + c[i + 1] * f;
  };
  for (let l = 0; l < lagsN; l++) {
    let s = 0;
    for (const g of GROUPS) s += ALIGN_WEIGHTS[g] * partAt(g, l);
    comb[l] = s / wsum;
  }
  // ロバストな散らばり（中央値と MAD）
  const med = quantileOf(comb, 0.5);
  const dev = new Float32Array(Math.ceil(lagsN / 3));
  for (let i = 0, l = 0; l < lagsN; l += 3, i++) dev[i] = Math.abs(comb[l] - med);
  const mad = Math.max(1e-4, quantileOf(dev, 0.5) * 1.4826);
  // 山の頂（1.5 秒以内に重ならないように）
  const order = Array.from({ length: lagsN }, (_, i) => i).filter((l) => (l === 0 || comb[l] >= comb[l - 1]) && (l === lagsN - 1 || comb[l] >= comb[l + 1]));
  order.sort((a, b) => comb[b] - comb[a]);
  const picked: number[] = [];
  for (const l of order) {
    if (picked.length >= maxCands) break;
    if (picked.some((p) => Math.abs(p - l) < 1.5 * ALIGN_FPS)) continue;
    picked.push(l);
  }
  const cands: AlignMatch[] = picked.map((l) => {
    // 頂を 2 次式で細かく
    let d = 0;
    if (l > 0 && l < lagsN - 1) {
      const a = comb[l - 1];
      const b = comb[l];
      const c = comb[l + 1];
      const den = a - 2 * b + c;
      if (den < -1e-9) d = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    const parts = { onset: partAt('onset', l), mel: partAt('mel', l), chroma: partAt('chroma', l) };
    return { sec: (l - og.pad + d) / ALIGN_FPS, score: comb[l], z: (comb[l] - med) / mad, parts };
  });
  const zc = new Float32Array(lagsN);
  for (let l = 0; l < lagsN; l++) zc[l] = (comb[l] - med) / mad;
  return { cands, active, zc, pad: og.pad };
}

// ---- 何か所かの結果をまとめる --------------------------------------------------------------

/** 1 回の探り（聞き取り）の結果 */
export interface ProbeResult {
  /** 探りの頭の、動画の時刻（秒） */
  v: number;
  /** 探りの長さ（秒） */
  len: number;
  cands: AlignMatch[];
  active: number;
  /** ずらしごとの z（AlignSearch.zc）。無ければ候補だけで判断する */
  zc?: Float32Array;
  pad?: number;
}

/** 原曲の時刻 a の所の、動画とのずれ（動画の秒 = a + offset + d） */
export interface AlignAnchor {
  a: number;
  d: number;
}

export type AlignKind = 'const' | 'drift' | 'edit';

export interface AlignDecision {
  /** 動画の秒 = 原曲の秒 + offset（anchors があるときはその所ごとに d を足す） */
  offset: number;
  /** ずれが所ごとに違うとき（ライブ・編集違い）の、所ごとの差。一定なら空 */
  anchors: AlignAnchor[];
  kind: AlignKind;
  /** 自信（0〜1） */
  conf: number;
  /** 同じずれを支持した探りの数 */
  support: number;
  /** 使った候補（探りごと。使わなかった探りは null） */
  picks: (AlignMatch | null)[];
  /** 決めたずれでは全く合わないのに、ほかの探りがそろわず、ずれを変える根拠にしなかった探り（確かめ直す） */
  doubt: number[];
}

/** 候補がどれだけ当てになるか（0〜1） */
export function candWeight(c: AlignMatch): number {
  const z = Math.max(0, Math.min(1, (c.z - 5) / 10));
  const s = Math.max(0, Math.min(1, (c.score - 0.1) / 0.3));
  return z * (0.4 + 0.6 * s);
}

/** 当てになる候補とみなす z */
export const Z_OK = 8;
/** 組み合わせの候補に入れる z の下限 */
const Z_MIN = 6;
/** 同じずれとみなす差（秒） */
export const SAME_TOL = 0.08;
/** ライブのテンポ違いとみなす、ずれの変わり方の上限（間の長さに対する割合） */
const DRIFT_MAX = 0.06;

/** 探りが、あるずれを「支える」とみなす z（その探りでいちばん似る所に対する割合） */
const SUPPORT_RATIO = 0.55;
/** 探りが、あるずれを「否定する」とみなす z の割合（これより似ていなければ、そのずれでは合わない） */
const DENY_RATIO = 0.4;

interface Pick {
  p: number;
  c: AlignMatch;
  /** 動画の秒 − 原曲の秒 */
  o: number;
  /** 探りの真ん中の、原曲の秒 */
  a: number;
  w: number;
}

/**
 * 探り pr を、ずれ o（動画の秒 − 原曲の秒）の ±tol 秒の範囲で見たときに、いちばん似る所。
 * z の曲線があればそこから（候補に出なかった所でも分かる）、無ければ候補から探す
 */
export function peakNear(pr: ProbeResult, o: number, tol = SAME_TOL): AlignMatch | null {
  const s = pr.v - o;
  const zc = pr.zc;
  if (zc && pr.pad !== undefined) {
    const c = Math.round(s * ALIGN_FPS) + pr.pad;
    const r = Math.max(1, Math.round(tol * ALIGN_FPS));
    let best = -1;
    for (let l = Math.max(0, c - r); l <= Math.min(zc.length - 1, c + r); l++) if (best < 0 || zc[l] > zc[best]) best = l;
    if (best < 0) return null;
    let d = 0;
    if (best > 0 && best < zc.length - 1) {
      const a = zc[best - 1];
      const b = zc[best];
      const e = zc[best + 1];
      const den = a - 2 * b + e;
      if (den < -1e-9) d = Math.max(-0.5, Math.min(0.5, (0.5 * (a - e)) / den));
    }
    const sec = (best - pr.pad + d) / ALIGN_FPS;
    // 候補に同じ所があれば、そちらの似かた（score）も使う
    const same = pr.cands.find((x) => Math.abs(x.sec - sec) < 0.03);
    return same ?? { sec, z: zc[best], score: NaN, parts: { onset: NaN, mel: NaN, chroma: NaN } };
  }
  let m: AlignMatch | null = null;
  for (const c of pr.cands) if (Math.abs(c.sec - s) <= tol && (!m || c.z > m.z)) m = c;
  return m;
}

/** 探り pr が、ずれ o のときにどれだけ似ているか（z。似る所が無ければ 0） */
export function zAt(pr: ProbeResult, o: number, tol = SAME_TOL): number {
  return peakNear(pr, o, tol)?.z ?? 0;
}

const zTopOf = (pr: ProbeResult) => pr.cands[0]?.z ?? 0;
const actOf = (pr: ProbeResult) => Math.min(1, pr.active / 0.6);
/** z からの重み（0〜1） */
const wOfZ = (pr: ProbeResult, z: number) => Math.max(0, Math.min(1, (z - 5) / 10)) * actOf(pr);

/** 探り pr はずれ o を支えるか（そのずれでも、いちばん似る所に近いくらい似る）。支えるなら z、でなければ 0 */
function supportZ(pr: ProbeResult, o: number): number {
  const z = zAt(pr, o);
  return z >= Math.max(Z_MIN, SUPPORT_RATIO * zTopOf(pr)) ? z : 0;
}

/** 探り pr はずれ o をはっきり否定するか（当てになる所がほかにあり、o ではほとんど似ない） */
function denies(pr: ProbeResult, o: number): boolean {
  const top = zTopOf(pr);
  return top >= Z_OK && pr.active >= 0.3 && zAt(pr, o) < Math.max(4, DENY_RATIO * top);
}

/** ずれの候補に使う、探りの選びうる候補（いちばんの候補よりずっと弱いものは使わない） */
function optionsOf(pr: ProbeResult, p: number): Pick[] {
  const top = zTopOf(pr);
  return pr.cands
    .filter((c) => c.z >= Math.max(Z_MIN, top * 0.7))
    .slice(0, 3)
    .map((c) => ({ p, c, o: pr.v - c.sec, a: c.sec + pr.len / 2, w: wOfZ(pr, c.z) }))
    .filter((x) => x.w > 0);
}

/**
 * 探りの結果をまとめて、ずれを決める。「曲の最初で合ったずれのまま」が基本で、ずれを変えるのは強い根拠があるときだけ。
 * 1. ずれの見込み（各探りの候補）ごとに、それを支える探りの重みを足し、いちばん支えられたずれを基準にする
 *    （支える = そのずれでも、その探りでいちばん似る所に近いくらい似る。繰り返しのサビで別の所が一番でも、
 *    正しい所でも同じくらい似ていれば支える。ほぼ同じなら、曲の早い所で合う方）
 * 2. 基準のずれではほとんど似ない探りが 2 か所以上あり、それらが同じ別のずれでそろい、基準の探りより
 *    全部あと（または全部まえ）なら、途中で飛ぶ（edit。ゲームサイズ・編集違い）
 * 3. そうでなく、ずれがなめらかに一方向へ少しずつ変わる並びなら drift（テンポが少し違うライブ版）。
 *    雑音で少し弱い探り（z 6〜8）も、この並びの根拠には使う
 * 4. どちらでもなければ一定（const）。食い違った探りは doubt に入れる（1 か所だけでは、ずれを変えない）
 */
export function decideOffset(probes: ProbeResult[]): AlignDecision | null {
  const none = (): (AlignMatch | null)[] => probes.map(() => null);
  const hyps: number[] = [];
  probes.forEach((pr) => {
    for (const c of pr.cands) if (c.z >= Z_MIN) hyps.push(pr.v - c.sec);
  });
  if (hyps.length === 0) {
    // どれも弱い: いちばんましな候補を、自信低めで返す
    let m: Pick | null = null;
    probes.forEach((pr, p) => {
      const c = pr.cands[0];
      if (!c) return;
      const w = candWeight(c) * actOf(pr);
      if (!m || w > m.w) m = { p, c, o: pr.v - c.sec, a: c.sec + pr.len / 2, w };
    });
    const best = m as Pick | null;
    if (!best || best.c.z < 4) return null;
    const picks = none();
    picks[best.p] = best.c;
    return { offset: best.o, anchors: [], kind: 'const', conf: Math.min(0.3, best.w + 0.1), support: 1, picks, doubt: [] };
  }

  // 1. 基準のずれ
  const scored = hyps.map((o) => {
    let score = 0;
    let first = Infinity;
    for (const pr of probes) {
      const z = supportZ(pr, o);
      if (z <= 0) continue;
      score += wOfZ(pr, z);
      first = Math.min(first, pr.v - o);
    }
    return { o, score, first };
  });
  const top = Math.max(...scored.map((x) => x.score));
  if (!(top > 0)) return null;
  const b0 = scored.filter((x) => x.score >= top * 0.95 - 1e-9).sort((x, y) => x.first - y.first)[0].o;

  /** 基準を支える探り */
  const S: Pick[] = [];
  /** 基準を支えず、ほかの所でははっきり似る探り（ずれが変わった根拠の候補） */
  const D: number[] = [];
  /** D のうち、基準のずれではほとんど似ない探り（途中で飛んだ根拠の候補） */
  const C: number[] = [];
  const N: number[] = [];
  probes.forEach((pr, p) => {
    if (supportZ(pr, b0) > 0) {
      const c = peakNear(pr, b0)!;
      S.push({ p, c, o: pr.v - c.sec, a: c.sec + pr.len / 2, w: wOfZ(pr, c.z) });
      return;
    }
    // ほかの所で似る（ライブのずれの変わり方の根拠には、雑音で少し弱くなった探りも使う）
    if (zTopOf(pr) >= Z_MIN && pr.active >= 0.3) D.push(p);
    else N.push(p);
    // 途中で飛ぶ根拠には、当てになる所がほかにあり、基準のずれではほとんど似ない探りだけを使う
    if (denies(pr, b0)) C.push(p);
  });
  const wsum = S.reduce((s, x) => s + x.w, 0);
  const base = wsum > 0 ? S.reduce((s, x) => s + x.o * x.w, 0) / wsum : b0;
  const vOf = (x: Pick) => x.a + x.o;

  const constResult = (): AlignDecision => {
    const picks = none();
    for (const x of S) picks[x.p] = x.c;
    const wTop = Math.max(0, ...S.map((x) => x.w));
    let conf = S.length >= 2 ? Math.min(1, 0.6 + 0.12 * S.length + 0.25 * wTop) : Math.min(0.6, 0.25 + 0.4 * wTop);
    // 食い違った探りがあれば少し下げる
    if (D.length > 0) conf = Math.min(conf, 0.85);
    return { offset: base, anchors: [], kind: 'const', conf, support: S.length, picks, doubt: D };
  };
  if (D.length < 2 || S.length === 0) return constResult();

  const finish = (chain: Pick[], kind: AlignKind): AlignDecision => {
    const ps = [...chain].sort((x, y) => x.a - y.a);
    // 曲の最初の所のずれを基準にする（「一定にする」とこのずれが残る）
    const offset = ps[0].o;
    const picks = none();
    for (const x of ps) picks[x.p] = x.c;
    const conf = Math.min(0.8, 0.3 + 0.25 * Math.min(...ps.map((x) => x.w)) + 0.1 * ps.length);
    const used = new Set(ps.map((x) => x.p));
    return {
      offset,
      anchors: ps.map((x) => ({ a: x.a, d: x.o - offset })),
      kind,
      conf,
      support: ps.length,
      picks,
      doubt: D.filter((p) => !used.has(p)),
    };
  };

  // 2. 途中で飛ぶ（edit）: 否定した探りのうち 2 か所以上が同じ別のずれでそろい、基準の探りより全部あと（まえ）
  let edit: { grp: Pick[]; w: number } | null = null;
  for (const p of C) {
    for (const opt of optionsOf(probes[p], p)) {
      const o2 = opt.o;
      if (Math.abs(o2 - base) <= SAME_TOL) continue;
      // 基準の探りの多くも o2 で似るなら、繰り返しの多い曲でずれが決めきれないだけ（飛んだ根拠にしない）。
      // 1 つだけなら、飛ぶ所をまたいだ探り（両方を含む）かもしれない
      const both = S.filter((x) => supportZ(probes[x.p], o2) > 0).length;
      if (both >= Math.max(2, Math.ceil(S.length / 2))) continue;
      const grp: Pick[] = [];
      for (const q of C) {
        if (supportZ(probes[q], o2) <= 0) continue;
        const c = peakNear(probes[q], o2)!;
        grp.push({ p: q, c, o: probes[q].v - c.sec, a: c.sec + probes[q].len / 2, w: wOfZ(probes[q], c.z) });
      }
      if (grp.length < 2) continue;
      const after = Math.min(...grp.map((x) => x.a)) > Math.max(...S.map((x) => x.a)) && Math.min(...grp.map(vOf)) > Math.max(...S.map(vOf)) + 0.5;
      const before = Math.max(...grp.map((x) => x.a)) < Math.min(...S.map((x) => x.a)) && Math.max(...grp.map(vOf)) + 0.5 < Math.min(...S.map(vOf));
      if (!after && !before) continue;
      const w = grp.reduce((s, x) => s + x.w, 0);
      if (!edit || w > edit.w) edit = { grp, w };
    }
  }

  // 3. 少しずつ変わる（drift）: 基準の探り＋ほかの所で似る探り（＋どちらでもない探り）が、なめらかで一方向の並びになる。
  //    ほかの所で似る探りが 2 か所以上入っていること（1 か所だけの取り違えでは、ずれを変えない）
  let drift: { chain: Pick[]; w: number } | null = null;
  {
    // 基準の探りは、近く（±0.4 秒）でいちばん似る所のずれを使う（ライブではそこが本当の位置）
    const fixed = S.map((x) => {
      const c = peakNear(probes[x.p], base, 0.4) ?? x.c;
      return { ...x, c, o: probes[x.p].v - c.sec, a: c.sec + probes[x.p].len / 2 };
    });
    const free = [...D, ...N];
    const opts = free.map((p) => optionsOf(probes[p], p));
    const cur: Pick[] = [];
    const walk = (i: number) => {
      if (i === free.length) {
        const nD = cur.filter((x) => D.includes(x.p)).length;
        if (nD < 2) return;
        const ps = [...fixed, ...cur].sort((x, y) => x.a - y.a);
        // ずれは一方向に少しずつ変わる（テンポが違えば遅れ・進みがたまっていく）。行ったり来たりするのは取り違え
        const trend = ps[ps.length - 1].o - ps[0].o;
        if (Math.abs(trend) <= 2 * SAME_TOL) return;
        for (let k = 1; k < ps.length; k++) {
          const da = ps[k].a - ps[k - 1].a;
          if (da < 1 || vOf(ps[k]) <= vOf(ps[k - 1]) + 0.5) return;
          const dd = ps[k].o - ps[k - 1].o;
          if (Math.abs(dd) > DRIFT_MAX * da) return;
          if (dd * Math.sign(trend) < -SAME_TOL) return;
        }
        const w = ps.reduce((s, x) => s + x.w, 0);
        if (!drift || w > drift.w) drift = { chain: ps, w };
        return;
      }
      walk(i + 1);
      for (const o of opts[i]) {
        cur.push(o);
        walk(i + 1);
        cur.pop();
      }
    };
    walk(0);
  }

  const ed = edit as { grp: Pick[]; w: number } | null;
  const dr = drift as { chain: Pick[]; w: number } | null;
  if (ed) {
    // 飛ぶ所がなめらか（間に対して小さい）で、なめらかな並びでも説明できるなら drift
    const g = [...ed.grp].sort((x, y) => x.a - y.a);
    const ss = [...S].sort((x, y) => x.a - y.a);
    const after = g[0].a > ss[ss.length - 1].a;
    const p = after ? ss[ss.length - 1] : g[g.length - 1];
    const q = after ? g[0] : ss[0];
    const smooth = Math.abs(q.o - p.o) <= DRIFT_MAX * Math.max(1e-6, q.a - p.a);
    if (!(smooth && dr)) return finish([...S, ...ed.grp], 'edit');
  }
  if (dr) return finish(dr.chain, 'drift');
  return constResult();
}

/**
 * 原曲の秒 a → そこでのずれの差 d（anchors の補間）。
 * 隣どうしのずれの差が、間の長さの 6% 以内ならなめらかにつなぎ（ライブのテンポの揺れ。外側も同じ傾きでのばす）、
 * それより大きければ間の真ん中で切り替える（編集で飛んでいる。外側は端の値のまま）
 */
export function anchorDelta(anchors: readonly AlignAnchor[], a: number): number {
  if (anchors.length === 0) return 0;
  if (anchors.length === 1) return anchors[0].d;
  const smooth = (p: AlignAnchor, q: AlignAnchor) => Math.abs(q.d - p.d) <= DRIFT_MAX * Math.max(1e-6, q.a - p.a);
  const line = (p: AlignAnchor, q: AlignAnchor) => p.d + ((q.d - p.d) * (a - p.a)) / Math.max(1e-6, q.a - p.a);
  const n = anchors.length;
  if (a <= anchors[0].a) return smooth(anchors[0], anchors[1]) ? line(anchors[0], anchors[1]) : anchors[0].d;
  if (a >= anchors[n - 1].a) return smooth(anchors[n - 2], anchors[n - 1]) ? line(anchors[n - 2], anchors[n - 1]) : anchors[n - 1].d;
  for (let i = 1; i < n; i++) {
    const p = anchors[i - 1];
    const q = anchors[i];
    if (a > q.a) continue;
    if (smooth(p, q)) return line(p, q);
    return a < (p.a + q.a) / 2 ? p.d : q.d;
  }
  return anchors[n - 1].d;
}

// ---- どこを聞き取るか -------------------------------------------------------------------------

/** 1 回の探りの長さ（秒） */
export const PROBE_SEC = 8;
/** 探りの回数の上限（ふつうは 3 回。食い違いを確かめる・ライブや編集違いを細かく見るときだけ増える） */
export const MAX_PROBES = 6;
/** 曲の頭・真ん中・終わりの 3 か所で合えば十分 */
const WANT_GOOD = 3;

export interface ProbePlanInput {
  /** 動画の長さ（秒） */
  vdur: number;
  /** 原曲の長さ（秒） */
  adur: number;
  len: number;
  done: ProbeResult[];
  /** 今のずれ（合わせたことがあれば、その辺りから探す） */
  hint?: number | null;
}

/** 次に聞き取る所（動画の秒）。もう十分なら null */
export function nextProbe(inp: ProbePlanInput): number | null {
  const { vdur, adur, len, done } = inp;
  if (done.length >= MAX_PROBES || vdur < len + 0.5) return null;
  const maxV = Math.max(0, vdur - len - 0.25);
  const clampV = (v: number) => Math.max(0, Math.min(maxV, v));
  const near = (v: number) => done.some((d) => Math.abs(d.v - v) < len * 0.75);
  const good = done.filter((d) => d.cands[0] && d.cands[0].z >= Z_OK && d.active >= 0.3);
  const dec = good.length > 0 ? decideOffset(done) : null;
  if (good.length >= WANT_GOOD) {
    if (!dec) return null;
    if (dec.kind === 'const') {
      // 1 か所だけ、決めたずれでは全く合わなかった: その探りのずれで近くをもう一度聞いて確かめる
      // （本当に途中で飛んでいれば 2 か所目もそろう。繰り返しのサビの取り違えなら、決めたずれに合う）
      const sa = dec.picks.flatMap((c, p) => (c ? [c.sec + done[p].len / 2] : []));
      if (sa.length === 0) return null;
      const lo = Math.min(...sa);
      const hi = Math.max(...sa);
      for (const p of dec.doubt) {
        const c = done[p].cands[0];
        if (!c) continue;
        const od = done[p].v - c.sec;
        const ad = c.sec + len / 2;
        // 基準の探りに挟まれた所なら、飛んだのではない（時間は戻らない）
        if (ad > lo && ad < hi) continue;
        // 基準の探りから離れる向き（飛んだ先の側）を先に、入らなければ反対側を聞く
        const dir = ad >= hi ? 1 : -1;
        for (const at of [ad + dir * 1.6 * len, ad - dir * 1.6 * len]) {
          // 曲の終わり際（小さくなっていく所）は当てにならないので避ける
          if (at < len || at > adur - len) continue;
          const v = clampV(at + od - len / 2);
          const prev = done.find((d) => Math.abs(d.v - v) < len * 0.75);
          // まだ聞いていなければ聞く。聞いて当てになる結果が出ていれば確かめ済み。当てにならなければ反対側を聞く
          if (!prev) return v;
          if (good.includes(prev)) break;
        }
      }
      return null;
    }
    const an = dec.anchors;
    if (dec.kind === 'edit') {
      // 途中で飛ぶ（編集違い）: 飛ぶ所を挟み込む（後ろのずれで間の真ん中を聞く。合えば飛ぶ所はそれより前）
      let gap: { a: number; o: number } | null = null;
      let widest = 0;
      for (let i = 1; i < an.length; i++) {
        const span = an[i].a - an[i - 1].a;
        if (Math.abs(an[i].d - an[i - 1].d) > DRIFT_MAX * span && span > 2.5 * len && span > widest) {
          widest = span;
          gap = { a: (an[i].a + an[i - 1].a) / 2, o: dec.offset + an[i].d };
        }
      }
      if (!gap) return null;
      const v = clampV(gap.a + gap.o - len / 2);
      return near(v) ? null : v;
    }
    // 少しずつずれる（ライブ）: いちばん広い間（端も含む）を埋める
    const pts = [0, ...an.map((x) => x.a), adur];
    let at = -1;
    let widest = adur * 0.3;
    for (let i = 1; i < pts.length; i++) {
      const span = (pts[i] - pts[i - 1]) * (i === 1 || i === pts.length - 1 ? 2 : 1);
      if (span > widest) {
        widest = span;
        at = i === 1 ? pts[1] / 2 : i === pts.length - 1 ? (pts[i - 1] + adur) / 2 : (pts[i - 1] + pts[i]) / 2;
      }
    }
    if (at < 0) return null;
    const v = clampV(at + dec.offset + anchorDelta(an, at) - len / 2);
    return near(v) ? null : v;
  }
  // ずれの見当（当てになる探り、無ければ前に合わせたずれ）
  const guess = dec ? dec.offset : (inp.hint ?? null);
  if (guess !== null && adur > len) {
    // 原曲の最初（いちばん大事。必ず近くを聞く）・終わり・真ん中（まだ聞いていない所）を、動画の時刻に直して聞く
    const heard = good.map((d) => d.cands[0].sec + len / 2);
    const wide = Math.max(len, adur * 0.12);
    const targets = [
      { a: Math.min(20, Math.max(len, 0.08 * adur)), r: len },
      { a: 0.9 * adur, r: wide },
      { a: 0.5 * adur, r: wide },
      { a: 0.3 * adur, r: wide },
      { a: 0.7 * adur, r: wide },
    ];
    for (const t of targets) {
      if (heard.some((h) => Math.abs(h - t.a) < t.r)) continue;
      const v = clampV(t.a + guess - len / 2);
      if (!near(v)) return v;
      // そこでは見当のずれで合わなかった（編集で飛んでいるかもしれない）: 動画の同じ割合の所で聞き直す
      const vb = clampV((t.a / adur) * vdur - len / 2);
      if (!near(vb)) return vb;
    }
    if (good.length > 0) return null;
  }
  // 見当が無い: 動画の真ん中より少し前から（前置きのセリフ・効果音を避ける）
  for (const q of [0.35, 0.6, 0.15, 0.82, 0.05]) {
    const v = clampV(q * vdur);
    if (!near(v)) return v;
  }
  return null;
}
