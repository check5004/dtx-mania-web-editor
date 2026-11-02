import { describe, expect, it } from 'vitest';
import { fitTaps, tapBpm, tapPhase } from './tapTempo';

/** 決まった揺れ（疑似乱数）で叩いた時刻を作る */
function taps(bpm: number, start: number, n: number, jitter: number, skip: number[] = []): number[] {
  const p = 60 / bpm;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    if (skip.includes(k)) continue;
    out.push(start + k * p + rnd() * 2 * jitter);
  }
  return out;
}

describe('fitTaps', () => {
  it('needs 4 taps', () => {
    expect(fitTaps([0, 0.5, 1])).toBeNull();
  });

  it('measures BPM and the first beat', () => {
    const t = taps(128, 3.2, 16, 0.015);
    const f = fitTaps(t)!;
    expect(Math.abs(f.bpm - 128)).toBeLessThan(0.6);
    expect(tapBpm(f, true)).toBe(128);
    expect(Math.abs(tapPhase(t, f, 128) - 3.2)).toBeLessThan(0.012);
  });

  it('counts skipped beats', () => {
    const t = taps(100, 1, 20, 0.01, [5, 6, 12]);
    const f = fitTaps(t)!;
    expect(tapBpm(f, true)).toBe(100);
    expect(f.ks[5]).toBe(7);
  });

  it('drops a stray tap', () => {
    const t = taps(90, 0.5, 12, 0.008);
    t[6] += 0.2;
    const f = fitTaps(t)!;
    expect(f.ks[6]).toBe(-1);
    expect(Math.abs(f.bpm - 90)).toBeLessThan(0.3);
  });

  it('keeps decimals when far from an integer', () => {
    const t = taps(123.5, 2, 32, 0.003);
    const f = fitTaps(t)!;
    expect(tapBpm(f, true)).toBeCloseTo(123.5, 0);
    expect(Number.isInteger(tapBpm(f, true))).toBe(false);
  });
});
