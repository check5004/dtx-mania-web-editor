// ライブラリの音の解析：レーンでの使われ方から楽器を決める、一覧の波形、似た音を探す特徴量。
import { fft } from '../audio/dsp';
import { CH, DRUM_LANES, drumChannel } from '../dtx/model';
import type { Inst } from './db';

export const INSTS: { id: Inst; label: string; color: string }[] = [
  { id: 'kick', label: 'キック', color: '#9C84E0' },
  { id: 'snare', label: 'スネア', color: '#FFD54F' },
  { id: 'hihat', label: 'ハイハット', color: '#4FC3F7' },
  { id: 'tom', label: 'タム', color: '#66BB6A' },
  { id: 'crash', label: 'クラッシュ', color: '#FF5C8A' },
  { id: 'ride', label: 'ライド', color: '#80DEEA' },
  { id: 'other', label: 'その他', color: '#8B95A4' },
];

export const instInfo = (i: Inst) => INSTS.find((x) => x.id === i) ?? INSTS[INSTS.length - 1];

/** 通常チャンネル → 楽器 */
export function instOfChannel(ch: number): Inst | null {
  const d = drumChannel(ch);
  if (!d) return null;
  switch (d.base) {
    case CH.BD:
    case CH.LBD:
      return 'kick';
    case CH.SD:
      return 'snare';
    case CH.HHC:
    case CH.HHO:
    case CH.LP:
      return 'hihat';
    case CH.HT:
    case CH.LT:
    case CH.FT:
      return 'tom';
    case CH.LC:
    case CH.CY:
      return 'crash';
    case CH.RD:
      return 'ride';
  }
  return null;
}

const NAME_HINTS: [Inst, RegExp][] = [
  ['kick', /(kick|bd|bass ?drum|キック|バスドラ)/i],
  ['snare', /(snare|sd|rim|スネア)/i],
  ['hihat', /(hh|hat|hi-?hat|ハイハット|pedal)/i],
  ['tom', /(tom|タム|floor)/i],
  ['ride', /(ride|ライド|bell)/i],
  ['crash', /(crash|cym|china|splash|クラッシュ|シンバル)/i],
];

export function instFromName(name: string): Inst | null {
  for (const [k, re] of NAME_HINTS) if (re.test(name)) return k;
  return null;
}

/**
 * レーンでの使われ方（チャンネル → 回数）から楽器を決める。
 * 一番多く使われた楽器の割合を確からしさにする。迷うときはファイル名も見る。
 */
export function classifyUsage(usage: ReadonlyMap<number, number>, name: string): { inst: Inst; conf: number; reason: string } {
  const byInst = new Map<Inst, number>();
  const byLane = new Map<string, number>();
  let total = 0;
  for (const [ch, n] of usage) {
    const inst = instOfChannel(ch);
    if (!inst) continue;
    total += n;
    byInst.set(inst, (byInst.get(inst) ?? 0) + n);
    const lane = DRUM_LANES[drumChannel(ch)!.lane].key;
    byLane.set(lane, (byLane.get(lane) ?? 0) + n);
  }
  const hint = instFromName(name);
  if (total === 0) return hint ? { inst: hint, conf: 0.5, reason: 'ファイル名から' } : { inst: 'other', conf: 0, reason: '譜面で使われていない' };
  let best: Inst = 'other';
  let bn = 0;
  for (const [k, n] of byInst) if (n > bn) (best = k), (bn = n);
  let lane = '';
  let ln = 0;
  for (const [k, n] of byLane) if (n > ln) (lane = k), (ln = n);
  const conf = bn / total;
  if (conf < 0.6 && hint && hint !== best) return { inst: hint, conf: 0.55, reason: `ファイル名から（${lane}レーンで${Math.round((ln / total) * 100)}%使用）` };
  return { inst: best, conf, reason: `${lane}レーンで${Math.round((ln / total) * 100)}%使用` };
}

/** モノラルにする */
export function monoOf(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  const ch = buf.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

/** 一覧の波形（最初の2秒を 48 区切り、0〜255） */
export function miniPeaks(x: Float32Array, sr: number, bins = 48): number[] {
  const len = Math.min(x.length, Math.round(sr * 2));
  let peak = 1e-9;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(x[i]));
  const out: number[] = [];
  for (let b = 0; b < bins; b++) {
    const a = Math.floor((b * len) / bins);
    const e = Math.max(a + 1, Math.floor(((b + 1) * len) / bins));
    let m = 0;
    for (let i = a; i < e; i++) m = Math.max(m, Math.abs(x[i]));
    out.push(Math.round((m / peak) * 255));
  }
  return out;
}

const BANDS = [40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20000];

function bandEnergies(x: Float32Array, at: number, sr: number): number[] {
  const N = 2048;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = x[at + i] ?? 0;
    re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  fft(re, im);
  const e = new Array(BANDS.length - 1).fill(0);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    const p = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < e.length; b++) if (f >= BANDS[b] && f < BANDS[b + 1]) e[b] += p;
  }
  const sum = e.reduce((a, v) => a + v, 0) || 1;
  return e.map((v) => v / sum);
}

/**
 * 似た音を探すための特徴量。帯域ごとのエネルギー（鳴り始めと 120ms 後）、減衰の速さ、長さ、明るさ。
 * 値はだいたい 0〜1 にそろえる。
 */
export function features(x: Float32Array, sr: number): number[] {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak < 1e-6) return new Array(22).fill(0);
  let on = 0;
  while (on < x.length && Math.abs(x[on]) < peak * 0.05) on++;
  const frame = Math.round(sr * 0.01);
  const rms: number[] = [];
  for (let i = on; i < x.length; i += frame) {
    let s = 0;
    const e = Math.min(x.length, i + frame);
    for (let j = i; j < e; j++) s += x[j] * x[j];
    rms.push(Math.sqrt(s / Math.max(1, e - i)));
  }
  const top = Math.max(...rms, 1e-9);
  const decayTo = (db: number) => {
    const th = top * Math.pow(10, db / 20);
    let i = rms.indexOf(top);
    while (i < rms.length && rms[i] > th) i++;
    return i * 0.01;
  };
  const d20 = decayTo(-20);
  const d40 = decayTo(-40);
  const e0 = bandEnergies(x, on, sr);
  const e1 = bandEnergies(x, on + Math.round(sr * 0.12), sr);
  let cn = 0;
  let cd = 0;
  e0.forEach((v, i) => {
    cn += v * i;
    cd += v;
  });
  let zc = 0;
  const zlen = Math.min(x.length - on, Math.round(sr * 0.1));
  for (let i = on + 1; i < on + zlen; i++) if (x[i - 1] < 0 !== x[i] < 0) zc++;
  const sq = (v: number) => Math.sqrt(Math.max(0, v));
  return [
    ...e0.map(sq),
    ...e1.map(sq),
    Math.min(1, Math.log1p(d20 * 10) / 4),
    Math.min(1, Math.log1p(d40 * 10) / 4),
    cd ? cn / cd / (e0.length - 1) : 0,
    Math.min(1, zc / Math.max(1, zlen) * 4),
  ];
}

/** 特徴量の近さ（1 に近いほど似ている） */
export function similarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) * (a[i] - b[i]);
  return Math.exp(-Math.sqrt(d) * 1.2);
}
