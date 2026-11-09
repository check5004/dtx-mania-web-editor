// ドラムの耳コピ向けのスペクトログラム（譜面の右の列に出す）。
//
// ・時刻: 窓の真ん中をそのフレームの時刻にする（窓の頭にすると、打点が窓の長さぶん早く見える）
// ・多重解像度: 低い音は長い窓（周波数を細かく）、高い音は短い窓（時刻を細かく）で測って1枚にまとめる。
//   キックの胴鳴りは 46ms、スネアの胴は 23ms、スネアの響きは 12ms、ハイハット・シンバルは 6ms の窓。
// ・帯域ごとの正規化: 帯域ごとに曲全体の大きさで揃える（低音に埋もれず、小さなハイハットも見える）。
// ・見せ方:
//   drum   … 伸びる音（ベース・声・和音）を引いて、叩いた音だけを残す（ドラム強調）
//   attack … 音の立ち上がりだけを出す（叩いた瞬間がはっきり分かる）
//   raw    … そのまま
import { biquad, downmix, fft, filtfilt, resample } from './dsp';

export type SpecMode = 'drum' | 'attack' | 'raw';
export const SPEC_MODES: readonly SpecMode[] = ['drum', 'attack', 'raw'];

/** 1秒あたりのフレーム数（5ms 刻み） */
export const SPEC_RATE = 200;
/** 周波数の段数（対数） */
export const SPEC_BINS = 128;
export const SPEC_F_LO = 30;
export const SPEC_F_HI = 16000;

export interface SpectroData {
  /** 1秒あたりのフレーム数。フレーム f の時刻は f / rate 秒（窓の真ん中） */
  rate: number;
  bins: number;
  frames: number;
  /** frames × bins の 0〜255。各フレームの中は低い周波数から順 */
  data: Uint8Array;
  fLo: number;
  fHi: number;
  mode: SpecMode;
}

/** 周波数 → 列の中の位置（0 = 左端 fLo、1 = 右端 fHi） */
export function specPos(f: number, fLo = SPEC_F_LO, fHi = SPEC_F_HI): number {
  return Math.log(f / fLo) / Math.log(fHi / fLo);
}

/** 列の中の位置 → 周波数 */
export function specFreq(p: number, fLo = SPEC_F_LO, fHi = SPEC_F_HI): number {
  return fLo * (fHi / fLo) ** p;
}

/** 段 b の真ん中の周波数 */
export function binFreq(b: number, bins = SPEC_BINS, fLo = SPEC_F_LO, fHi = SPEC_F_HI): number {
  return specFreq((b + 0.5) / bins, fLo, fHi);
}

/** 測り方の段（低い音ほど長い窓） */
interface Res {
  /** 窓の長さ（秒） */
  win: number;
  /** この段で受け持つ周波数の上限 */
  fMax: number;
}
const RESOLUTIONS: Res[] = [
  { win: 0.046, fMax: 160 },
  { win: 0.023, fMax: 1500 },
  { win: 0.0116, fMax: 5000 },
  { win: 0.0058, fMax: Infinity },
];

function decimate(x: Float32Array, dec: number, sr: number, cutoff: number): Float32Array {
  if (dec <= 1) return x;
  const lp = biquad('lowpass', cutoff, 0.707, sr);
  const y = filtfilt(x, [lp, lp]);
  const n = Math.floor(y.length / dec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = y[i * dec];
  return out;
}

const pow2 = (v: number) => 2 ** Math.round(Math.log2(v));

/**
 * 対数周波数のパワー（dB）を出す。frames × bins の Float32Array。
 * 重い処理なのでワーカーで呼ぶ。見せ方を変えるときは、これを取っておいて renderSpectro だけやり直す。
 */
export function spectroDb(channels: Float32Array[], srIn: number, progress?: (p: number) => void): { db: Float32Array; frames: number; fHi: number } {
  let x = downmix(channels);
  let sr = srIn;
  if (sr > 50000) {
    x = resample(x, sr, 48000);
    sr = 48000;
  }
  const fHi = Math.min(SPEC_F_HI, sr * 0.45);
  const bins = SPEC_BINS;
  const duration = x.length / sr;
  const frames = Math.max(1, Math.floor(duration * SPEC_RATE));
  const db = new Float32Array(frames * bins);
  const edges = new Float64Array(bins + 1);
  for (let b = 0; b <= bins; b++) edges[b] = specFreq(b / bins, SPEC_F_LO, fHi);

  let lo = 0;
  RESOLUTIONS.forEach((r, ri) => {
    // この段で受け持つ周波数の段 [lo, hi)
    let hi = lo;
    while (hi < bins && binFreq(hi, bins, SPEC_F_LO, fHi) < r.fMax) hi++;
    if (ri === RESOLUTIONS.length - 1) hi = bins;
    if (hi <= lo) return;
    const top = Math.min(edges[hi], fHi);
    // 受け持つ周波数の 2.5 倍まで残して間引く（計算を軽くする）
    let dec = 1;
    while (dec < 8 && sr / (dec * 2) / 2 > top * 2.5) dec *= 2;
    const srd = sr / dec;
    const y = decimate(x, dec, sr, Math.min(srd * 0.45, top * 2));
    const N = Math.max(64, pow2(srd * r.win));
    const win = new Float32Array(N);
    let wsum = 0;
    for (let i = 0; i < N; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N);
      wsum += win[i] * win[i];
    }
    const df = srd / N;
    // 段ごとに、使う FFT の番号と重み
    const map: { k0: number; k1: number; w0: number; w1: number; avg: boolean }[] = [];
    for (let b = lo; b < hi; b++) {
      const a = edges[b] / df;
      const z = edges[b + 1] / df;
      const ka = Math.ceil(a);
      const kz = Math.floor(z);
      if (kz - ka >= 1) map.push({ k0: ka, k1: Math.min(N / 2, kz), w0: 0, w1: 0, avg: true });
      else {
        // 狭い段は真ん中の周波数で隣どうしを補間
        const c = binFreq(b, bins, SPEC_F_LO, fHi) / df;
        const k = Math.min(N / 2 - 1, Math.floor(c));
        const f = c - k;
        map.push({ k0: k, k1: k + 1, w0: 1 - f, w1: f, avg: false });
      }
    }
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const pa = new Float32Array(N / 2 + 1);
    const pb = new Float32Array(N / 2 + 1);
    const half = N / 2;
    const scale = 1 / (wsum * srd) / 4;
    // 長い窓は 2 フレームおきに測って間を補う（窓が長いので見た目は変わらない）
    const stepF = r.win >= 0.02 ? 2 : 1;
    const todo: number[] = [];
    for (let f = 0; f < frames; f += stepF) todo.push(f);
    if (todo[todo.length - 1] !== frames - 1) todo.push(frames - 1);
    const fill = (buf: Float32Array, f: number) => {
      const start = Math.round((f / SPEC_RATE) * srd - half);
      for (let i = 0; i < N; i++) {
        const j = start + i;
        buf[i] = j >= 0 && j < y.length ? y[j] * win[i] : 0;
      }
    };
    const put = (f: number, pw: Float32Array) => {
      const row = f * bins;
      for (let i = 0; i < map.length; i++) {
        const m = map[i];
        let p: number;
        if (m.avg) {
          let s = 0;
          for (let k = m.k0; k <= m.k1; k++) s += pw[k];
          p = s / (m.k1 - m.k0 + 1);
        } else p = pw[m.k0] * m.w0 + pw[m.k1] * m.w1;
        db[row + lo + i] = 10 * Math.log10(p * scale + 1e-14);
      }
    };
    // 実数の 2 フレームを 1 回の複素 FFT で（実部に1つ目、虚部に2つ目）
    for (let t = 0; t < todo.length; t += 2) {
      const fa = todo[t];
      const fb = t + 1 < todo.length ? todo[t + 1] : -1;
      fill(re, fa);
      if (fb >= 0) fill(im, fb);
      else im.fill(0);
      fft(re, im);
      for (let k = 0; k <= half; k++) {
        const k2 = (N - k) & (N - 1);
        const ar = re[k] + re[k2];
        const ai = im[k] - im[k2];
        const br = im[k] + im[k2];
        const bi = re[k2] - re[k];
        pa[k] = ar * ar + ai * ai;
        pb[k] = br * br + bi * bi;
      }
      put(fa, pa);
      if (fb >= 0) put(fb, pb);
    }
    if (stepF > 1) {
      for (let f = 1; f < frames - 1; f += stepF) {
        const row = f * bins;
        for (let b = lo; b < hi; b++) db[row + b] = 0.5 * (db[row - bins + b] + db[row + bins + b]);
      }
    }
    progress?.((ri + 1) / RESOLUTIONS.length);
    lo = hi;
  });
  return { db, frames, fHi };
}

/** 段ごとの分位点（間引いて数える） */
function binQuantile(db: Float32Array, frames: number, bins: number, b: number, q: number): number {
  const step = Math.max(1, Math.floor(frames / 6000));
  const s: number[] = [];
  for (let f = 0; f < frames; f += step) s.push(db[f * bins + b]);
  s.sort((u, v) => u - v);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] ?? -140;
}

/** 段ごとの基準の大きさ（曲の中の大きい音）。小さすぎる段は持ち上げすぎない */
export function binRefs(db: Float32Array, frames: number, bins: number): Float32Array {
  const ref = new Float32Array(bins);
  let top = -Infinity;
  for (let b = 0; b < bins; b++) {
    ref[b] = binQuantile(db, frames, bins, b, 0.985);
    if (ref[b] > top) top = ref[b];
  }
  // 曲全体でいちばん大きい段から 30dB 以上は持ち上げない（MP3 の高域の切れ目などが光らないように）
  for (let b = 0; b < bins; b++) ref[b] = Math.max(ref[b], top - 30);
  return ref;
}

/** 小さな配列の中央値（並べ替え） */
function median(buf: Float32Array, n: number): number {
  const a = buf.subarray(0, n);
  a.sort();
  return n % 2 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

/**
 * 伸びる音の大きさ（時間方向の中央値）。dB のまま、4フレームごとに測って補間する。
 * 叩いた音は短いので中央値に残らず、伸びる音（ベース・声・和音・パッド）だけが残る。
 */
export function sustained(db: Float32Array, frames: number, bins: number, spanSec: number): Float32Array {
  const D = 4;
  const n = Math.ceil(frames / D);
  const coarse = new Float32Array(n * bins);
  // 4フレームの平均
  for (let i = 0; i < n; i++) {
    const f0 = i * D;
    const f1 = Math.min(frames, f0 + D);
    for (let b = 0; b < bins; b++) {
      let s = 0;
      for (let f = f0; f < f1; f++) s += db[f * bins + b];
      coarse[i * bins + b] = s / (f1 - f0);
    }
  }
  const half = Math.max(1, Math.round((spanSec * SPEC_RATE) / D / 2));
  const med = new Float32Array(n * bins);
  const buf = new Float32Array(half * 2 + 1);
  for (let b = 0; b < bins; b++) {
    for (let i = 0; i < n; i++) {
      let k = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) buf[k++] = coarse[j * bins + b];
      med[i * bins + b] = median(buf, k);
    }
  }
  const out = new Float32Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    const p = (f + 0.5) / D - 0.5;
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(p)));
    const i1 = Math.min(n - 1, i0 + 1);
    const t = Math.max(0, Math.min(1, p - i0));
    for (let b = 0; b < bins; b++) out[f * bins + b] = med[i0 * bins + b] * (1 - t) + med[i1 * bins + b] * t;
  }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 3段×2フレームでならす（短い窓の細かいゆらぎを消す） */
function smooth(db: Float32Array, frames: number, bins: number): Float32Array {
  const out = new Float32Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    const row = f * bins;
    const prev = f > 0 ? row - bins : row;
    for (let b = 0; b < bins; b++) {
      const b0 = b > 0 ? b - 1 : b;
      const b1 = b + 1 < bins ? b + 1 : b;
      out[row + b] = (db[row + b0] + db[row + b] + db[row + b1] + db[prev + b0] + db[prev + b] + db[prev + b1]) / 6;
    }
  }
  return out;
}

/** dB のスペクトルを見せ方に合わせて 0〜255 にする */
export function renderSpectro(db: Float32Array, frames: number, fHi: number, mode: SpecMode): SpectroData {
  const bins = SPEC_BINS;
  const data = new Uint8Array(frames * bins);
  const ref = binRefs(db, frames, bins);
  if (mode === 'raw') {
    const range = 36;
    for (let f = 0; f < frames; f++) {
      const row = f * bins;
      for (let b = 0; b < bins; b++) {
        const v = clamp01((db[row + b] - (ref[b] - range)) / range);
        data[row + b] = Math.round(v * v * v * 255);
      }
    }
  } else if (mode === 'drum') {
    // 伸びる音（前後 0.25 秒の中央値）より どれだけ大きいか × 曲の中でどれだけ大きいか。
    // 重みは手元の3曲（正解の譜面つき）で、打点の時刻にその太鼓の帯がいちばん目立つように合わせた
    const bg = sustained(db, frames, bins, 0.25);
    for (let f = 0; f < frames; f++) {
      const row = f * bins;
      for (let b = 0; b < bins; b++) {
        const d = db[row + b];
        const over = clamp01((d - bg[row + b] - 1) / 20);
        const level = clamp01((d - (ref[b] - 42)) / 42);
        data[row + b] = Math.round(Math.sqrt(over) * level * 255);
      }
    }
  } else {
    // 立ち上がり：少し前のフレーム（周りの段の大きい方）より どれだけ大きくなったか
    const sm = smooth(db, frames, bins);
    const lag = new Int32Array(bins);
    for (let b = 0; b < bins; b++) {
      const fc = binFreq(b, bins, SPEC_F_LO, fHi);
      const r = RESOLUTIONS.find((x) => fc < x.fMax) ?? RESOLUTIONS[RESOLUTIONS.length - 1];
      lag[b] = Math.max(2, Math.round((r.win * SPEC_RATE) / 2) + 1);
    }
    const hold = new Float32Array(bins);
    for (let f = 0; f < frames; f++) {
      const row = f * bins;
      for (let b = 0; b < bins; b++) {
        const d = sm[row + b];
        let prev = -140;
        for (let pf = Math.max(0, f - lag[b] - 1); pf <= f - lag[b]; pf++) {
          const pr = pf * bins;
          for (let j = Math.max(0, b - 1); j <= Math.min(bins - 1, b + 1); j++) if (sm[pr + j] > prev) prev = sm[pr + j];
        }
        const rise = clamp01((d - prev - 3) / 12);
        const level = clamp01((d - (ref[b] - 36)) / 36);
        const v = rise * level;
        // 叩いた後に少しだけ尾を引かせる（打点を見落とさない）
        hold[b] = Math.max(v, hold[b] * 0.7);
        data[row + b] = Math.round(hold[b] * 255);
      }
    }
  }
  return { rate: SPEC_RATE, bins, frames, data, fLo: SPEC_F_LO, fHi, mode };
}

/** まとめて作る（テスト・ワーカー用） */
export function computeSpectro(channels: Float32Array[], sr: number, mode: SpecMode): SpectroData {
  const r = spectroDb(channels, sr);
  return renderSpectro(r.db, r.frames, r.fHi, mode);
}

/** 帯ごとの明るさ（AI に渡す）。frames × 帯の数の 0〜255 */
export interface SpectroZones {
  rate: number;
  frames: number;
  data: Uint8Array;
}

/**
 * スペクトルを帯ごとの明るさにする（帯の段の平均）。帯ごとに、曲の中のふつうの明るさ（中央値）を 0、
 * 明るい所（上から1%）を 255 にそろえる（帯によって明るさの出方が違うので、数字を読み比べやすくする）
 */
export function spectroZones(sp: SpectroData, zones: readonly { from: number; to: number }[]): SpectroZones {
  const nz = zones.length;
  const ranges = zones.map((z) => {
    const bins: number[] = [];
    for (let b = 0; b < sp.bins; b++) {
      const f = binFreq(b, sp.bins, sp.fLo, sp.fHi);
      if (f >= z.from && f < z.to) bins.push(b);
    }
    return bins;
  });
  const data = new Uint8Array(sp.frames * nz);
  const col = new Float32Array(sp.frames);
  ranges.forEach((bins, z) => {
    for (let f = 0; f < sp.frames; f++) {
      const row = f * sp.bins;
      let s = 0;
      for (const b of bins) s += sp.data[row + b];
      col[f] = bins.length ? s / bins.length : 0;
    }
    const sorted = col.slice().sort();
    const lo = sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0;
    const hi = sorted[Math.floor((sorted.length - 1) * 0.99)] ?? 0;
    const span = Math.max(1, hi - lo);
    for (let f = 0; f < sp.frames; f++) data[f * nz + z] = Math.round(clamp01((col[f] - lo) / span) * 255);
  });
  return { rate: sp.rate, frames: sp.frames, data };
}
