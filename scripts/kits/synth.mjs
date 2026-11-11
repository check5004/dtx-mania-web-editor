// 自前の合成で作るドラムの音（トラップ・8ビット・FM 音源のキット）。録音を使わないので、権利はこのリポジトリだけのもの（CC0 で配る）。
// どれも決まった種の乱数を使うので、何度作っても同じ音になる。
import { biquad, rng, saturate } from './dsp.mjs';
import { SR } from './audio-io.mjs';

const TAU = Math.PI * 2;
const n = (sec) => Math.ceil(sec * SR);

/** 音程が下がっていくサイン波（キック・タム） */
export function sweepSine({ f0, f1, pitchTau, ampTau, len, phase = 0 }) {
  const y = new Float64Array(n(len));
  let ph = phase;
  for (let i = 0; i < y.length; i++) {
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / pitchTau);
    ph += (TAU * f) / SR;
    y[i] = Math.sin(ph) * Math.exp(-t / ampTau);
  }
  return y;
}

/** 白いノイズ（種つき） */
export function noise(len, seed = 7) {
  const r = rng(seed);
  const y = new Float64Array(n(len));
  for (let i = 0; i < y.length; i++) y[i] = r() * 2 - 1;
  return y;
}

/** 指数で減る包絡をかける（attack 秒でなめらかに立ち上げる） */
export function env(x, tau, attack = 0.0005) {
  const a = Math.max(1, Math.round(attack * SR));
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * Math.exp(-i / (tau * SR)) * (i < a ? i / a : 1);
  return y;
}

/** 金属の音（矩形波をいくつか重ねる。ハイハット・シンバルのもと） */
export function metal(freqs, len, seed = 3) {
  const r = rng(seed);
  const y = new Float64Array(n(len));
  const ph = freqs.map(() => r());
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      ph[k] = (ph[k] + freqs[k] / SR) % 1;
      s += ph[k] < 0.5 ? 1 : -1;
    }
    y[i] = s / freqs.length;
  }
  return y;
}

function add(...parts) {
  const len = Math.max(...parts.map(([x]) => x.length));
  const y = new Float64Array(len);
  for (const [x, g = 1, at = 0] of parts) for (let i = 0; i < x.length && i + at < len; i++) y[i + at] += x[i] * g;
  return y;
}

const bp = (x, hz, Q = 1) => biquad(x, { type: 'bpf_2p', hz, Q }, SR);
const hp = (x, hz, Q = 0.7071) => biquad(x, { type: 'hpf_2p', hz, Q }, SR);
const lp = (x, hz, Q = 0.7071) => biquad(x, { type: 'lpf_2p', hz, Q }, SR);
const click = (len = 0.004, seed = 11) => env(hp(noise(len, seed), 2000), 0.0012);

// ---- トラップ（長く低い 808 風のキック・軽いスネアとクラップ・細かいハット） ----

const TRAP_METAL = [263, 391, 437, 583, 627, 853];

export const trap = {
  bd: () => saturate(add([sweepSine({ f0: 150, f1: 46, pitchTau: 0.045, ampTau: 0.55, len: 1.6 })], [click(0.003, 21), 0.35]), 4, 0.6),
  sd: () =>
    add(
      [sweepSine({ f0: 260, f1: 185, pitchTau: 0.03, ampTau: 0.07, len: 0.4 }), 0.6],
      [env(bp(noise(0.5, 31), 4200, 0.6), 0.11), 0.9],
      [clap(), 0.7],
    ),
  hhc: () => env(hp(bp(metal(TRAP_METAL, 0.15, 41), 9000, 0.9), 6500), 0.022),
  hho: () => env(hp(bp(metal(TRAP_METAL, 0.9, 42), 9000, 0.8), 6000), 0.22, 0.001),
  lp: () => env(hp(bp(metal(TRAP_METAL, 0.08, 43), 8000, 1.2), 6000), 0.012),
  rim: () => add([env(bp(sweepSine({ f0: 1750, f1: 1700, pitchTau: 1, ampTau: 1, len: 0.06 }), 1700, 4), 0.012), 0.8], [env(bp(sweepSine({ f0: 480, f1: 470, pitchTau: 1, ampTau: 1, len: 0.08 }), 480, 2), 0.02), 0.6], [click(0.002, 51), 0.4]),
  ht: () => sweepSine({ f0: 230, f1: 175, pitchTau: 0.06, ampTau: 0.28, len: 1.0 }),
  lt: () => sweepSine({ f0: 170, f1: 128, pitchTau: 0.07, ampTau: 0.32, len: 1.1 }),
  ft: () => sweepSine({ f0: 125, f1: 92, pitchTau: 0.08, ampTau: 0.38, len: 1.3 }),
  lc: () => crash([340, 469, 517, 701, 773, 1043], 1.0, 61),
  cy: () => crash([389, 503, 611, 757, 829, 1163], 0.75, 62),
  rd: () => ride([1210, 1627, 1873, 2341], 1.3, 63),
};

/** クラップ（短いノイズを4回、少しずつずらす） */
export function clap() {
  const burst = (s) => env(bp(noise(0.03, s), 1300, 1.2), 0.006);
  const tail = env(bp(noise(0.35, 77), 1200, 0.9), 0.09);
  return add([burst(71), 1, 0], [burst(72), 0.9, Math.round(0.009 * SR)], [burst(73), 0.85, Math.round(0.018 * SR)], [tail, 0.7, Math.round(0.024 * SR)]);
}

/** クラッシュ（金属の音とノイズ、高い所だけ） */
export function crash(freqs, tau, seed) {
  const m = hp(metal(freqs, 3, seed), 3500);
  const nz = hp(noise(3, seed + 100), 5000);
  return env(add([m, 0.6], [nz, 0.5]), tau, 0.002);
}

/** ライド（はっきりした金属の音・ベルの成分を少し） */
export function ride(freqs, tau, seed) {
  const m = bp(metal(freqs, 3, seed), 4200, 0.7);
  const bell = env(bp(metal([freqs[0] * 2.01, freqs[1] * 1.49], 1.5, seed + 1), 3000, 3), 0.35);
  const nz = env(hp(noise(3, seed + 200), 7000), 0.45);
  return env(add([m, 0.7], [bell, 0.25], [nz, 0.2]), tau, 0.001);
}

// ---- 8ビット（4bit の音量・60 分の1秒ごとの変化・矩形波と三角波とノイズ） ----

const FRAME = SR / 60;

/** 長さ 15 ビットのノイズ（short で周期の短い金属っぽいノイズ） */
function lfsrNoise(len, period, short = false) {
  const y = new Float64Array(n(len));
  let reg = 1;
  let acc = 0;
  let out = 1;
  for (let i = 0; i < y.length; i++) {
    acc += 1;
    while (acc >= period) {
      acc -= period;
      const bit = (reg & 1) ^ ((reg >> (short ? 6 : 1)) & 1);
      reg = (reg >> 1) | (bit << 14);
      out = reg & 1 ? 1 : -1;
    }
    y[i] = out;
  }
  return y;
}

/** フレームごとの音量（0〜15）を当てはめる */
function frames(x, vols) {
  const y = new Float64Array(Math.min(x.length, Math.ceil(vols.length * FRAME)));
  for (let i = 0; i < y.length; i++) y[i] = (x[i] * vols[Math.min(vols.length - 1, Math.floor(i / FRAME))]) / 15;
  return y;
}

/** 音程がフレームごとに変わる矩形波・三角波 */
function stepOsc(freqs, wave = 'square', duty = 0.5) {
  const y = new Float64Array(Math.ceil(freqs.length * FRAME));
  let ph = 0;
  for (let i = 0; i < y.length; i++) {
    const f = freqs[Math.min(freqs.length - 1, Math.floor(i / FRAME))];
    ph = (ph + f / SR) % 1;
    if (wave === 'tri') {
      // 4bit の三角波（16 段）
      const v = ph < 0.5 ? ph * 2 : 2 - ph * 2;
      y[i] = Math.round(v * 15) / 7.5 - 1;
    } else y[i] = ph < duty ? 1 : -1;
  }
  return y;
}

const ramp = (from, to, count) => Array.from({ length: count }, (_, i) => Math.round(from + ((to - from) * i) / Math.max(1, count - 1)));
const decayVols = (start, count) => Array.from({ length: count }, (_, i) => Math.max(0, Math.round(start * (1 - i / count))));

export const chip = {
  bd: () => add([frames(stepOsc([210, 140, 95, 70, 58, 52, 50, 48], 'tri'), [15, 15, 14, 13, 12, 10, 8, 5]), 1], [frames(lfsrNoise(0.05, 8), [12, 4]), 0.4]),
  sd: () => add([frames(lfsrNoise(0.4, 12), decayVols(15, 14)), 0.8], [frames(stepOsc([240, 200, 180], 'square', 0.5), [12, 8, 4]), 0.35]),
  hhc: () => frames(lfsrNoise(0.1, 2, true), [12, 7, 3]),
  hho: () => frames(lfsrNoise(0.6, 2, true), decayVols(11, 22)),
  lp: () => frames(lfsrNoise(0.05, 3, true), [8, 3]),
  rim: () => frames(stepOsc([1320, 1320, 1250], 'square', 0.25), [13, 7, 2]),
  ht: () => frames(stepOsc(ramp(330, 230, 18), 'tri'), decayVols(15, 18)),
  lt: () => frames(stepOsc(ramp(250, 170, 20), 'tri'), decayVols(15, 20)),
  ft: () => frames(stepOsc(ramp(185, 120, 24), 'tri'), decayVols(15, 24)),
  lc: () => frames(lfsrNoise(1.6, 4), decayVols(14, 70)),
  cy: () => frames(lfsrNoise(1.4, 3, true), decayVols(12, 60)),
  rd: () => add([frames(stepOsc(Array(60).fill(1870), 'square', 0.125), decayVols(10, 60)), 0.6], [frames(lfsrNoise(1, 1, true), decayVols(6, 40)), 0.35]),
};

// ---- FM 音源（2 つのサイン波で、片方がもう片方の音程を揺らす） ----

/** 2オペレーターの FM。index は揺らす深さ（ラジアン）、indexTau で減る */
export function fm2({ fc, fcEnd = fc, pitchTau = 0.05, ratio, index, indexTau, ampTau, len, fixedMod }) {
  const y = new Float64Array(n(len));
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < y.length; i++) {
    const t = i / SR;
    const f = fcEnd + (fc - fcEnd) * Math.exp(-t / pitchTau);
    const fmod = fixedMod ?? f * ratio;
    pm += (TAU * fmod) / SR;
    const I = index * Math.exp(-t / indexTau);
    pc += (TAU * f) / SR;
    y[i] = Math.sin(pc + I * Math.sin(pm)) * Math.exp(-t / ampTau);
  }
  return y;
}

export const fm = {
  bd: () => add([fm2({ fc: 190, fcEnd: 52, pitchTau: 0.03, ratio: 1, index: 3, indexTau: 0.015, ampTau: 0.3, len: 1.0 }), 1], [click(0.002, 81), 0.25]),
  sd: () => add([fm2({ fc: 210, fcEnd: 180, pitchTau: 0.02, ratio: 2.72, index: 6, indexTau: 0.04, ampTau: 0.12, len: 0.6 }), 0.7], [env(hp(noise(0.6, 82), 1800), 0.13), 0.6]),
  hhc: () => hp(fm2({ fc: 5200, ratio: 1.41, index: 8, indexTau: 0.03, ampTau: 0.025, len: 0.15 }), 4000),
  hho: () => hp(fm2({ fc: 5200, ratio: 1.41, index: 8, indexTau: 0.4, ampTau: 0.25, len: 1.0 }), 4000),
  lp: () => hp(fm2({ fc: 4600, ratio: 1.41, index: 6, indexTau: 0.02, ampTau: 0.014, len: 0.08 }), 3500),
  rim: () => fm2({ fc: 880, ratio: 3.5, index: 4, indexTau: 0.006, ampTau: 0.018, len: 0.12 }),
  ht: () => fm2({ fc: 300, fcEnd: 210, pitchTau: 0.06, ratio: 1.5, index: 1.5, indexTau: 0.05, ampTau: 0.25, len: 1.0 }),
  lt: () => fm2({ fc: 220, fcEnd: 155, pitchTau: 0.07, ratio: 1.5, index: 1.5, indexTau: 0.06, ampTau: 0.3, len: 1.1 }),
  ft: () => fm2({ fc: 160, fcEnd: 108, pitchTau: 0.08, ratio: 1.5, index: 1.5, indexTau: 0.07, ampTau: 0.36, len: 1.3 }),
  lc: () => hp(add([fm2({ fc: 3150, ratio: 1.73, index: 12, indexTau: 1.2, ampTau: 0.9, len: 3 }), 0.8], [env(hp(noise(3, 83), 6000), 0.7), 0.3]), 2500),
  cy: () => hp(add([fm2({ fc: 3900, ratio: 2.41, index: 14, indexTau: 0.9, ampTau: 0.7, len: 3 }), 0.8], [env(hp(noise(3, 84), 6500), 0.55), 0.3]), 3000),
  rd: () => hp(add([fm2({ fc: 2650, ratio: 3.14, index: 3, indexTau: 1.5, ampTau: 1.1, len: 3 }), 0.8], [env(hp(noise(3, 85), 7000), 0.4), 0.12]), 1500),
};

// ---- アナログのリズムマシン風のライド（FreePats の音にライドが無いので） ----

export const analog = {
  rd: () => ride([1337, 1771, 2029, 2579], 1.5, 91),
};

// ---- ハウス（909 風のリム・タム・ライド） ----

/** 減っていくサイン波をいくつか（リムショットの「カン」） */
function ping(parts, len) {
  const y = new Float64Array(n(len));
  for (const [f, tau, g] of parts) for (let i = 0; i < y.length; i++) y[i] += Math.sin((TAU * f * i) / SR) * Math.exp(-i / (tau * SR)) * g;
  return y;
}

/** 909 風のタム（音程が下がるサイン波と、叩いた瞬間のノイズ） */
const tom909 = (f0, f1, ampTau, seed) =>
  add([sweepSine({ f0, f1, pitchTau: 0.05, ampTau, len: ampTau * 5 })], [env(bp(noise(0.1, seed), 2200, 0.8), 0.012), 0.18]);

export const house = {
  rim: () => add([ping([[520, 0.012, 0.5], [1680, 0.009, 0.8], [3150, 0.006, 0.45]], 0.08)], [click(0.003, 93), 0.5]),
  ht: () => tom909(265, 205, 0.2, 94),
  lt: () => tom909(205, 155, 0.24, 95),
  ft: () => tom909(150, 112, 0.3, 96),
  rd: () => hp(ride([1523, 1993, 2311, 2873], 1.6, 97), 4500),
};

export const SYNTH = { trap, chip, fm, analog, house };
