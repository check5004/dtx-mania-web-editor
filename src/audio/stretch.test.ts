import { describe, expect, it } from 'vitest';
import { wsola } from './stretch';

function zeroCrossings(x: Float32Array, a: number, b: number) {
  let n = 0;
  for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) n++;
  return n;
}

describe('スロー再生の時間伸長', () => {
  const sr = 44100;
  const x = new Float32Array(sr * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);

  it('長さは 1/rate 倍になる', () => {
    const r = wsola([x, x], sr, 0.5, 0, sr);
    expect(r.channels.length).toBe(2);
    expect(r.channels[0].length).toBe(sr * 2);
  });

  it('音程（周波数）は変わらない', () => {
    const r = wsola([x], sr, 0.5, 0, sr);
    const y = r.channels[0];
    // 中ほどの 0.5 秒で数える。440Hz なら 0.5 秒で約 440 回ゼロを横切る
    const n = zeroCrossings(y, sr / 2, sr);
    expect(n).toBeGreaterThan(420);
    expect(n).toBeLessThan(460);
  });

  it('等倍ならそのまま切り出す', () => {
    const r = wsola([x], sr, 1, 100, 200);
    expect(r.channels[0].length).toBe(100);
    expect(r.channels[0][0]).toBe(x[100]);
  });
});
