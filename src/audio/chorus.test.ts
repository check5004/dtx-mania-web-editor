// サビを探す（src/audio/chorus.ts）。本物の曲 6 曲での確かめは試作のときに行った（ファイルの頭のコメント）。
// ここでは作った特徴（前奏・A・サビ・A・サビ・間奏・サビ・後奏）で、決まりどおりに動くかを見る。
import { describe, expect, it } from 'vitest';
import { findChorus, findChorusAuto, gridMatch, gridOffset, symEig, type ChorusFeatures } from './chorus';

/** 毎回同じ乱数 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const BPM = 120;
const BAR = (60 / BPM) * 4;
/** 部分と小節の数。B がサビ（明るく大きい） */
const FORM: [string, number][] = [
  ['I', 8],
  ['A', 8],
  ['B', 8],
  ['A', 8],
  ['B', 8],
  ['C', 4],
  ['B', 8],
  ['O', 4],
];
const LEAD = 0.5;

/** 部分ごとの和音（拍ごとの音名）と音色 */
const SECTION: Record<string, { chords: number[][]; level: number; bright: number; tilt: number }> = {
  I: { chords: [[0, 4, 7], [0, 4, 7], [5, 9, 0], [5, 9, 0]], level: -12, bright: -6, tilt: -0.4 },
  A: { chords: [[9, 0, 4], [9, 0, 4], [5, 9, 0], [7, 11, 2]], level: 0, bright: 0, tilt: 0 },
  B: { chords: [[0, 4, 7], [7, 11, 2], [9, 0, 4], [5, 9, 0]], level: 3, bright: 7, tilt: 0.3 },
  C: { chords: [[2, 5, 9], [2, 5, 9], [7, 11, 2], [7, 11, 2]], level: -2, bright: -2, tilt: -0.2 },
  O: { chords: [[0, 4, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]], level: -14, bright: -8, tilt: -0.5 },
};

function makeSong(): { feat: ChorusFeatures; duration: number; bars: number[]; beats: number[]; chorusBars: number[] } {
  const rand = rng(7);
  const sections: string[] = [];
  for (const [s, n] of FORM) for (let i = 0; i < n; i++) sections.push(s);
  const nBars = sections.length;
  const duration = LEAD + nBars * BAR + 2;
  const rate = 11025 / 512;
  const offset = 2;
  const frames = Math.floor(duration * rate);
  const chroma = new Float32Array(frames * 12);
  const bands = new Float32Array(frames * 20);
  const secAt = (t: number) => sections[Math.max(0, Math.min(nBars - 1, Math.floor((t - LEAD) / BAR)))];
  for (let f = 0; f < frames; f++) {
    const t = (f + offset) / rate;
    const inSong = t >= LEAD && t < LEAD + nBars * BAR;
    const sec = SECTION[inSong ? secAt(t) : 'O'];
    const beat = Math.max(0, Math.floor(((t - LEAD) % BAR) / (BAR / 4)));
    for (let c = 0; c < 12; c++) chroma[f * 12 + c] = 0.05 + 0.05 * rand();
    for (const pc of sec.chords[beat % 4]) chroma[f * 12 + pc] += 1 + 0.1 * rand();
    for (let b = 0; b < 20; b++) bands[f * 20 + b] = (inSong ? 0 : -30) + sec.level + sec.tilt * (b - 10) + (b >= 14 ? sec.bright : 0) + rand();
  }
  // 打点：拍ごとにキックとスネア、8 分でハイハット、サビの頭でクラッシュ
  const fluxRate = 22050 / 256;
  const fluxOffset = 2;
  const fluxFrames = Math.floor(duration * fluxRate);
  const flux = new Float32Array(fluxFrames * 8);
  const hit = (t: number, b: number, v: number) => {
    const k = Math.round(t * fluxRate - fluxOffset);
    if (k >= 0 && k < fluxFrames) flux[k * 8 + b] += v;
  };
  const bars: number[] = [];
  const beats: number[] = [];
  for (let m = 0; m < nBars + 1; m++) bars.push(LEAD + m * BAR);
  for (let m = 0; m < nBars; m++) {
    const s = SECTION[sections[m]];
    const quiet = s.level < -10 ? 0.3 : 1;
    for (let q = 0; q < 8; q++) {
      const t = LEAD + m * BAR + (q * BAR) / 8;
      if (q % 2 === 0) beats.push(t);
      if (q === 0 || q === 4) {
        hit(t, 0, 3 * quiet);
        hit(t, 1, 2 * quiet);
      }
      if (q === 2 || q === 6) {
        hit(t, 2, 2 * quiet);
        hit(t, 3, 2 * quiet);
      }
      hit(t, 6, 0.8 * quiet);
      hit(t, 7, 0.6 * quiet);
    }
    if (sections[m] === 'B' && sections[m - 1] !== 'B') {
      hit(LEAD + m * BAR, 6, 4);
      hit(LEAD + m * BAR, 7, 4);
    }
  }
  for (let k = 0; k < flux.length; k++) flux[k] += 0.02 * rand();
  const chorusBars = sections.flatMap((s, i) => (s === 'B' && sections[i - 1] !== 'B' ? [i] : []));
  return { feat: { rate, frames, offset, chroma, bands, fluxRate, fluxOffset, fluxFrames, flux }, duration, bars, beats, chorusBars };
}

describe('サビを探す', () => {
  const song = makeSong();

  it('前奏の後の最初のサビを選び、ほかのサビも挙げる', () => {
    const r = findChorus({ feat: song.feat, duration: song.duration, bars: song.bars });
    expect(r.best).not.toBeNull();
    expect(r.best!.bar).toBe(song.chorusBars[0]);
    expect(r.best!.start).toBeCloseTo(song.bars[song.chorusBars[0]], 5);
    expect(r.repeats.map((p) => p.bar)).toEqual(song.chorusBars.slice(1));
    // サビの印の部分は 3 か所
    const chorusParts = r.parts.filter((p) => p.chorus);
    expect(chorusParts.length).toBe(3);
  });

  it('小節線が打点から少しずれていても、同じ小節を選ぶ（答えの時刻は渡した小節線のまま）', () => {
    for (const ms of [-40, -24, -10, -4, 4, 10, 24, 40]) {
      const bars = song.bars.map((t) => t + ms / 1000);
      const r = findChorus({ feat: song.feat, duration: song.duration, bars });
      expect(r.best!.bar).toBe(song.chorusBars[0]);
      expect(r.best!.start).toBeCloseTo(bars[song.chorusBars[0]], 9);
      expect(r.repeats.map((p) => p.bar)).toEqual(song.chorusBars.slice(1));
    }
  });

  it('小節線と打点のずれを測る', () => {
    expect(Math.abs(gridOffset(song.feat, song.bars))).toBeLessThanOrEqual(0.006);
    for (const ms of [-60, -30, 20, 50]) expect(Math.abs(gridOffset(song.feat, song.bars.map((t) => t + ms / 1000)) + ms / 1000)).toBeLessThanOrEqual(0.006);
  });

  it('小節が少なすぎれば探さない', () => {
    const r = findChorus({ feat: song.feat, duration: song.duration, bars: song.bars.slice(0, 8) });
    expect(r.best).toBeNull();
    expect(r.parts).toEqual([]);
  });

  it('譜面の拍が音の拍に乗っているか', () => {
    const half = (60 / BPM) / 2;
    expect(gridMatch(song.beats, song.beats)).toBe(1);
    // 半拍ずれた線・テンポの違う線は乗っていない
    expect(gridMatch(song.beats.map((t) => t + half), song.beats)).toBe(0);
    expect(gridMatch(Array.from({ length: 200 }, (_, i) => i * (60 / 97)), song.beats)).toBeLessThan(0.3);
    // 倍の速さ・半分の速さの譜面は乗っている
    const dbl = song.beats.flatMap((t, i) => (i + 1 < song.beats.length ? [t, (t + song.beats[i + 1]) / 2] : [t]));
    expect(gridMatch(dbl, song.beats)).toBeGreaterThan(0.9);
    expect(gridMatch(song.beats.filter((_, i) => i % 2 === 0), song.beats)).toBeGreaterThan(0.9);
  });

  it('譜面の小節線が合っていれば使い、合っていなければ音から小節を推定する', () => {
    const ok = findChorusAuto(song.feat, song.duration, { bars: song.bars, beats: song.beats });
    expect(ok.grid).toBe('chart');
    expect(ok.best!.bar).toBe(song.chorusBars[0]);
    // テンポの違う譜面（97 BPM、曲の頭から）
    const p = 60 / 97;
    const wrong = { bars: Array.from({ length: 60 }, (_, i) => i * p * 4), beats: Array.from({ length: 240 }, (_, i) => i * p) };
    const est = findChorusAuto(song.feat, song.duration, wrong);
    expect(est.grid).toBe('audio');
    expect(Math.abs(est.best!.start - song.bars[song.chorusBars[0]])).toBeLessThan(BAR + 0.1);
  });
});

describe('対称行列の固有値', () => {
  it('A v = λ v で、固有ベクトルは直交し、小さい順', () => {
    const n = 12;
    const rand = rng(3);
    const a = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) a[i * n + j] = a[j * n + i] = rand() * 2 - 1;
    const { values, vectors } = symEig(a, n);
    for (let k = 0; k + 1 < n; k++) expect(values[k]).toBeLessThanOrEqual(values[k + 1]);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        let av = 0;
        for (let j = 0; j < n; j++) av += a[i * n + j] * vectors[j * n + k];
        expect(av).toBeCloseTo(values[k] * vectors[i * n + k], 9);
      }
      for (let l = 0; l < n; l++) {
        let d = 0;
        for (let i = 0; i < n; i++) d += vectors[i * n + k] * vectors[i * n + l];
        expect(d).toBeCloseTo(k === l ? 1 : 0, 9);
      }
    }
  });
});
