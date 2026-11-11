// かけた音を作る（ブラウザの中で。ワーカーとテストでも使えるよう、AudioBuffer を使わない）。
// - ピッチ：サンプラーと同じく速さを変えて読む（高くすると短く・低くすると長く）。上げるときは先に高い所を落として折り返しを防ぐ
// - ハイカット・ローカット：24 dB/oct（2 次を 2 段。バターワース）。境目の強調は 2 段目の Q を上げる（DJ ミキサーのフィルターのクセ）
// - 余韻の中で値が動くもの：キーのあいだを周波数の比・半音でなめらかにつなぎ、フィルターは 32 サンプルごとに係数を替える
//   （状態変数フィルター。係数を替えても乱れにくい）
import type { FxKey, FxSpec } from './model';

/** 2 段のバターワースの Q（4 次） */
const BW_Q1 = 0.5412;
const BW_Q2 = 1.3066;
/** 境目の強調の 2 段目の Q（なし・少し・強め）。境目で約 +4 dB・+10 dB */
const EMPH_Q2 = [BW_Q2, 3, 6] as const;

/** 状態変数フィルター（2 次）。lp なら低い音を通す、でなければ高い音を通す */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 0;
  constructor(
    private readonly lp: boolean,
    private readonly q: number,
  ) {}
  set(fc: number, sr: number) {
    const f = Math.max(5, Math.min(fc, sr * 0.45));
    const g = Math.tan((Math.PI * f) / sr);
    this.k = 1 / this.q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return this.lp ? v2 : x - this.k * v1 - v2;
  }
}

/** キーの並びの、時刻 t（秒）の値。log なら比でつなぐ。かけない所（0）は open の値として扱う */
export function keyValue(keys: readonly FxKey[], t: number, open: number, log: boolean): number {
  const val = (v: number) => (v === 0 ? open : v);
  if (keys.length === 1 || t <= keys[0].t) return val(keys[0].v);
  for (let i = 1; i < keys.length; i++) {
    if (t > keys[i].t) continue;
    const a = keys[i - 1];
    const b = keys[i];
    const p = (t - a.t) / Math.max(1e-9, b.t - a.t);
    const va = val(a.v);
    const vb = val(b.v);
    return log ? Math.exp(Math.log(va) + (Math.log(vb) - Math.log(va)) * p) : va + (vb - va) * p;
  }
  return val(keys[keys.length - 1].v);
}

/** 4 点の 3 次補間 */
function cubic(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const n = x.length;
  const x0 = x[i - 1 >= 0 ? i - 1 : 0];
  const x1 = x[i];
  const x2 = i + 1 < n ? x[i + 1] : 0;
  const x3 = i + 2 < n ? x[i + 2] : 0;
  return x1 + 0.5 * f * (x2 - x0 + f * (2 * x0 - 5 * x1 + 4 * x2 - x3 + f * (3 * (x1 - x2) + x3 - x0)));
}

/** 低い音を通すフィルター（4 次）をかける（ピッチを上げる前の、折り返し防ぎ） */
function lowpass4(x: Float32Array, fc: number, sr: number): Float32Array {
  const a = new Svf(true, BW_Q1);
  const b = new Svf(true, BW_Q2);
  a.set(fc, sr);
  b.set(fc, sr);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = b.tick(a.tick(x[i]));
  return out;
}

/** ピッチを変える（半音のキー）。出力の長さは速さで決まる */
function pitchShift(chans: Float32Array[], sr: number, keys: readonly FxKey[]): Float32Array[] {
  const rateAt = (t: number) => Math.pow(2, keyValue(keys, t, 0, false) / 12);
  const maxRate = Math.max(...keys.map((k) => Math.pow(2, k.v / 12)));
  const src = maxRate > 1.0001 ? chans.map((x) => lowpass4(x, (sr * 0.45) / maxRate, sr)) : chans;
  const len = src[0]?.length ?? 0;
  if (len === 0) return chans.map(() => new Float32Array(0));
  // 読む位置の並び（どのチャンネルも同じ）
  const fixed = keys.length === 1 ? rateAt(0) : null;
  const n = fixed !== null ? Math.max(1, Math.floor((len - 1) / fixed) + 1) : -1;
  const positions: number[] = [];
  if (fixed === null) {
    let pos = 0;
    let i = 0;
    while (pos <= len - 1) {
      positions.push(pos);
      pos += rateAt(i / sr);
      i++;
    }
  }
  const count = fixed !== null ? n : positions.length;
  return src.map((x) => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = cubic(x, fixed !== null ? i * fixed : positions[i]);
    return out;
  });
}

/** フィルター（4 次）。keys の値で、lp ならハイカット、でなければローカット */
function filter4(x: Float32Array, sr: number, keys: readonly FxKey[], lp: boolean, q: number): Float32Array {
  const open = lp ? Math.min(20000, sr * 0.45) : 10;
  const a = new Svf(lp, BW_Q1);
  const b = new Svf(lp, EMPH_Q2[q] ?? BW_Q2);
  const out = new Float32Array(x.length);
  const moving = keys.length > 1;
  const block = 32;
  for (let i = 0; i < x.length; i += block) {
    if (i === 0 || moving) {
      const fc = keyValue(keys, i / sr, open, true);
      a.set(fc, sr);
      b.set(fc, sr);
    }
    const end = Math.min(x.length, i + block);
    for (let j = i; j < end; j++) out[j] = b.tick(a.tick(x[j]));
  }
  return out;
}

/** 音（チャンネルごとの配列）にかけ方 spec をかけた音を返す。大きくなりすぎたら（強調で）全体を下げる */
export function renderFx(chans: readonly Float32Array[], sr: number, spec: FxSpec): Float32Array[] {
  let out: Float32Array[] = chans.map((x) => x);
  if (spec.pt) out = pitchShift(out, sr, spec.pt);
  if (spec.lc) out = out.map((x) => filter4(x, sr, spec.lc!, false, spec.lq ?? 0));
  if (spec.hc) out = out.map((x) => filter4(x, sr, spec.hc!, true, spec.hq ?? 0));
  if (out.some((x, i) => x === chans[i])) out = out.map((x, i) => (x === chans[i] ? x.slice() : x));
  let peak = 0;
  for (const x of out) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0.999) {
    const k = 0.999 / peak;
    for (const x of out) for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  return out;
}
