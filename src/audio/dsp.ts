// 信号処理の小道具（フィルタ、モノラル化、リサンプリング）。ワーカーとテストの両方で使う。

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ の Audio EQ Cookbook の2次フィルタ */
export function biquad(type: 'lowpass' | 'highpass' | 'bandpass', f0: number, q: number, sr: number): Biquad {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.49)) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** フィルタをかける（out を省くと新しい配列に書く） */
export function applyBiquad(x: Float32Array, c: Biquad, out: Float32Array = new Float32Array(x.length)): Float32Array {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

/** 同じフィルタを続けてかける（2回で4次相当） */
export function applyChain(x: Float32Array, chain: Biquad[]): Float32Array {
  let y = x;
  for (const c of chain) y = applyBiquad(y, c, y === x ? undefined : y);
  return y === x ? new Float32Array(x) : y;
}

export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

/** 線形補間で sr → target に変える（下げるときは先に低域通過フィルタをかける） */
export function resample(x: Float32Array, sr: number, target: number): Float32Array {
  if (sr === target) return x;
  let src = x;
  if (target < sr) {
    const lp = biquad('lowpass', target * 0.45, 0.707, sr);
    src = applyChain(x, [lp, lp]);
  }
  const ratio = sr / target;
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    const a = src[j];
    const b = j + 1 < src.length ? src[j + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** 配列の分位点（間引いて並べ替える） */
export function quantile(x: ArrayLike<number>, q: number, maxSamples = 20000): number {
  const step = Math.max(1, Math.floor(x.length / maxSamples));
  const s: number[] = [];
  for (let i = 0; i < x.length; i += step) s.push(x[i]);
  if (s.length === 0) return 0;
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/** その場で複素FFT（長さは2のべき乗） */
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half];
        const ai = im[i + k + half];
        const tr = ar * cr - ai * ci;
        const ti = ar * ci + ai * cr;
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
