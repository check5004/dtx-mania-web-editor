// テストで使う、ドラムとほかの楽器の音（決まった種から作るので、テストのたびに同じ音）。アプリからは使わない。
import type { AudioLike } from './drumCheck';

/** 決まった種から作る乱数（-0.5〜0.5） */
export function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** ドラム：beat 秒ごとのハイハット（雑音の短い打音）と、2・4 拍目のスネア（長めの雑音）。強さは少しずつ違う */
export function drumsSignal(sec: number, sr: number, seed = 1, beat = 0.25, phase = 0.05): Float32Array {
  const r = rand(seed);
  const x = new Float32Array(Math.round(sec * sr));
  const hit = (t: number, g: number, decay: number) => {
    const i0 = Math.round(t * sr);
    for (let i = 0; i < 6 * decay * sr && i0 + i < x.length; i++) x[i0 + i] += g * r() * 2 * Math.exp(-i / (decay * sr));
  };
  for (let k = 0; phase + k * beat < sec; k++) {
    const t = phase + k * beat;
    hit(t, 0.3 + 0.1 * Math.abs(r()), 0.02);
    if (k % 4 === 1 || k % 4 === 3) hit(t, 0.6 + 0.1 * Math.abs(r()), 0.06);
  }
  return x;
}

/** ほかの楽器：0.5 秒ごとに音の高さが変わる和音（頭は少しなめらか）と、ゆっくり大きさの変わる雑音 */
export function othersSignal(sec: number, sr: number, seed = 2): Float32Array {
  const r = rand(seed);
  const x = new Float32Array(Math.round(sec * sr));
  let f = 220;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const k = Math.floor(t / 0.5);
    if (i % Math.round(sr / 2) === 0) f = 180 + ((k * 37) % 9) * 40;
    const att = Math.min(1, (t - k * 0.5) / 0.02);
    const amp = 0.25 + 0.1 * Math.sin(t * 0.7);
    x[i] = att * amp * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * 2.01 * f * t) + 0.3 * Math.sin(2 * Math.PI * 3.02 * f * t)) + 0.05 * amp * r();
  }
  return x;
}

/** 2 つの音を足す（b は gb 倍） */
export const addSignals = (a: Float32Array, b: Float32Array, gb = 1) => a.map((v, i) => v + gb * (b[i] ?? 0));

/** モノラルの音を AudioBuffer の代わりにする */
export function monoBuffer(x: Float32Array, sr: number): AudioLike & { duration: number } {
  return { sampleRate: sr, length: x.length, duration: x.length / sr, numberOfChannels: 1, getChannelData: () => x };
}
