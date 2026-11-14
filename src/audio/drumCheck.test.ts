// 曲の音にドラムが入っているかを、ステム（ドラムとほかの楽器）と比べて見る（名前では分からないドラム抜きを見分ける）。
import { describe, expect, it } from 'vitest';
import { envelope, judgeDrums } from './drumCheck';
import { addSignals, drumsSignal, monoBuffer, othersSignal } from './testSignals';

const SR = 8000;

const buf = (x: Float32Array) => monoBuffer(x, SR);
const drums = (sec: number, seed = 1, beat = 0.25, phase = 0.05) => drumsSignal(sec, SR, seed, beat, phase);
const others = (sec: number, seed = 2) => othersSignal(sec, SR, seed);
const add = addSignals;
const env = (x: Float32Array, at = 0) => envelope([{ buf: buf(x), at }], x.length / SR + at);

describe('曲の音にドラムが入っているかを、ステムと比べて見る', () => {
  const sec = 40;
  const d = drums(sec);
  const n = others(sec);
  const ed = env(d);
  const en = env(n);

  it('ステムを全部足した音（原曲）はドラム入り、ドラム以外を足した音はドラム抜き（音量を変えて書き出していても）', () => {
    expect(judgeDrums(env(add(d, n)), ed, en, { lag: 0, span: 30 })?.drums).toBe(true);
    expect(judgeDrums(env(add(d, n).map((v) => v * 0.6)), ed, en, { lag: 0, span: 30 })?.drums).toBe(true);
    expect(judgeDrums(env(n), ed, en, { lag: 0, span: 30 })?.drums).toBe(false);
    expect(judgeDrums(env(n.map((v) => v * 1.7)), ed, en, { lag: 0, span: 30 })?.drums).toBe(false);
  });

  it('頭が少しずれていても（ステムの頭のずれ）見分ける', () => {
    const shifted = (x: Float32Array, ms: number) => {
      const k = Math.round((ms / 1000) * SR);
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) y[i] = x[i - k] ?? 0;
      return y;
    };
    expect(judgeDrums(env(shifted(add(d, n), 40)), ed, en, { lag: 0, span: 30 })?.drums).toBe(true);
    expect(judgeDrums(env(shifted(n, -60)), ed, en, { lag: 0, span: 30 })?.drums).toBe(false);
  });

  it('切り出した試聴も、曲のどこかを探して見分ける', () => {
    const cut = (x: Float32Array, from: number, len: number) => x.slice(Math.round(from * SR), Math.round((from + len) * SR));
    const full = judgeDrums(env(cut(add(d, n), 17.3, 12)), ed, en);
    expect(full?.drums).toBe(true);
    expect(Math.abs(full!.lag - 1730)).toBeLessThanOrEqual(2);
    expect(judgeDrums(env(cut(n, 9.1, 12)), ed, en)?.drums).toBe(false);
  });

  it('別の曲（テンポも和音も違う）の音は「わからない」', () => {
    const other = add(drums(sec, 7, 0.31, 0.12), others(sec, 8).reverse());
    expect(judgeDrums(env(other.map((v, i) => v * (1 + 0.8 * Math.sin(i / 3000)))), ed, en, { lag: 0, span: 30 })).toBeNull();
  });
});
