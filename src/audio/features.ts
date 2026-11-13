// 小節どうしの「原曲での聞こえ方の近さ」を比べるための特徴（TAB補完の根拠）。
// 和音（クロマ：12音それぞれの強さ）と音色（帯域ごとの音量）を約46ms ごとに、
// 打点（8つの帯域ごとの音の立ち上がり）を約12ms ごとに出す。重いのでワーカーで計算する。
import { downmix, fft, resample } from './dsp';

/** 特徴を出すサンプリング周波数（和音には十分。高い音の様子はリズムの特徴で見る） */
export const FEAT_SR = 11025;
const N = 2048;
const HOP = 512;
/** 音色の帯域の数（60Hz〜5kHz を対数で分ける） */
export const FEAT_BANDS = 20;

/** 打点の帯域（Hz の区切り）。キック・ベース・スネアの胴・スネアの響き・ハイハット・シンバル をだいたい分ける */
export const FLUX_EDGES = [30, 90, 180, 400, 900, 2000, 4500, 8000, 11000];
export const FLUX_BANDS = FLUX_EDGES.length - 1;

export interface FrameFeatures {
  /** 1秒あたりのフレーム数 */
  rate: number;
  frames: number;
  /** フレーム f の中心の時刻（秒）= (f + offset) / rate */
  offset: number;
  /** frames × 12（C, C#, …, B の強さ） */
  chroma: Float32Array;
  /** frames × 12。低い音（40〜200Hz：ベースと低い和音）だけのクロマ。ベースの音は小節の頭で変わりやすい（1 拍目の手がかり） */
  bass: Float32Array;
  /** frames × FEAT_BANDS（帯域の音量、dB） */
  bands: Float32Array;
  /** 打点のフレーム（1秒あたり）。フレーム f の中心は (f + fluxOffset) / fluxRate 秒 */
  fluxRate: number;
  fluxOffset: number;
  fluxFrames: number;
  /** fluxFrames × FLUX_BANDS（帯域ごとの音の立ち上がり。0以上） */
  flux: Float32Array;
}

export function computeFrameFeatures(channels: Float32Array[], sr: number, progress?: (p: number) => void): FrameFeatures {
  const x = resample(downmix(channels), sr, FEAT_SR);
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const chroma = new Float32Array(frames * 12);
  const bass = new Float32Array(frames * 12);
  const bands = new Float32Array(frames * FEAT_BANDS);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const binHz = FEAT_SR / N;
  // クロマ：65Hz（C2）〜2.1kHz の成分を音名に振り分ける。ベースのクロマは 40〜200Hz
  const pc = new Int8Array(N / 2).fill(-1);
  const pcBass = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    const name = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
    if (f >= 65 && f <= 2100) pc[k] = name;
    if (f >= 40 && f <= 200) pcBass[k] = name;
  }
  // 音色：60Hz〜5kHz を対数で区切る
  const edges: number[] = [];
  for (let b = 0; b <= FEAT_BANDS; b++) edges.push(Math.max(1, Math.round((60 * (5000 / 60) ** (b / FEAT_BANDS)) / binHz)));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const co = f * 12;
    for (let k = 1; k < N / 2; k++) {
      const p = pc[k];
      const q = pcBass[k];
      if (p < 0 && q < 0) continue;
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (p >= 0) chroma[co + p] += mag;
      if (q >= 0) bass[co + q] += mag;
    }
    const bo = f * FEAT_BANDS;
    for (let b = 0; b < FEAT_BANDS; b++) {
      const a = edges[b];
      const z = Math.max(a + 1, edges[b + 1]);
      let s = 0;
      for (let k = a; k < z; k++) s += re[k] * re[k] + im[k] * im[k];
      bands[bo + b] = 10 * Math.log10(s / (z - a) + 1e-10);
    }
    if (progress && f % 500 === 0) progress((0.5 * f) / Math.max(1, frames));
  }
  const fl = computeFlux(channels, sr, (p) => progress?.(0.5 + 0.5 * p));
  return { rate: FEAT_SR / HOP, frames, offset: N / 2 / HOP, chroma, bass, bands, ...fl };
}

/** 帯域ごとの音の立ち上がり（対数の音量の増え方）。22.05kHz、1024点、256 ずつ */
function computeFlux(channels: Float32Array[], sr: number, progress?: (p: number) => void): { fluxRate: number; fluxOffset: number; fluxFrames: number; flux: Float32Array } {
  const SR2 = 22050;
  const N2 = 1024;
  const H2 = 256;
  const x = resample(downmix(channels), sr, SR2);
  const frames = Math.max(0, Math.floor((x.length - N2) / H2) + 1);
  const flux = new Float32Array(frames * FLUX_BANDS);
  const win = new Float32Array(N2);
  for (let i = 0; i < N2; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N2 - 1));
  const binHz = SR2 / N2;
  const edges = FLUX_EDGES.map((f) => Math.max(1, Math.min(N2 / 2, Math.round(f / binHz))));
  const re = new Float32Array(N2);
  const im = new Float32Array(N2);
  const prev = new Float32Array(FLUX_BANDS);
  const cur = new Float32Array(FLUX_BANDS);
  for (let f = 0; f < frames; f++) {
    const off = f * H2;
    for (let i = 0; i < N2; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < FLUX_BANDS; b++) {
      let s = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) s += re[k] * re[k] + im[k] * im[k];
      cur[b] = Math.log1p(s * 1000);
      const d = cur[b] - prev[b];
      flux[f * FLUX_BANDS + b] = f > 0 && d > 0 ? d : 0;
      prev[b] = cur[b];
    }
    if (progress && f % 2000 === 0) progress(f / Math.max(1, frames));
  }
  return { fluxRate: SR2 / H2, fluxOffset: N2 / 2 / H2, fluxFrames: frames, flux };
}
