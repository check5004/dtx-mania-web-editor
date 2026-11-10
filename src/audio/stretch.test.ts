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

  it('伸ばした音は元の時刻 / rate の所で鳴る（チップより早くならない）', () => {
    // 1kHz の音が幅 60ms でふくらむ所を 5 つ。ふくらみの真ん中（音の大きさの重心）を比べる
    const times = [0.5, 1.1, 1.73, 2.4, 3.05];
    const y0 = new Float32Array(sr * 4);
    for (let i = 0; i < y0.length; i++) {
      let env = 0;
      for (const t of times) env += Math.exp(-(((i / sr - t) / 0.03) ** 2));
      y0[i] = 0.5 * env * Math.sin((2 * Math.PI * 1000 * i) / sr);
    }
    for (const rate of [0.75, 0.5, 0.25]) {
      const y = wsola([y0], sr, rate, 0, y0.length).channels[0];
      for (const t of times) {
        const c = Math.round((t / rate) * sr);
        const h = Math.round((0.12 / rate) * sr);
        let m = 0;
        let e = 0;
        for (let i = c - h; i < c + h; i++) {
          m += y[i] ** 2 * i;
          e += y[i] ** 2;
        }
        // 窓の頭どうしで合わせていたときは 50% で 26ms、25% で 74ms 早かった
        expect(Math.abs((m / e / sr - t / rate) * 1000)).toBeLessThan(8);
      }
    }
  });

  it('音の頭は欠けず、小さくもならない（短い SE の打音の頭）', () => {
    const hit = new Float32Array(sr / 2);
    for (let i = 0; i < hit.length; i++) hit[i] = Math.exp(-i / (sr * 0.02)) * Math.sin((2 * Math.PI * 3000 * i) / sr);
    for (const rate of [0.75, 0.5, 0.25]) {
      const y = wsola([hit], sr, rate, 0, hit.length).channels[0];
      // はじめの 5ms は元の音のまま
      for (let i = 0; i < sr * 0.005; i++) expect(y[i]).toBeCloseTo(hit[i], 4);
    }
  });

  it('等倍ならそのまま切り出す', () => {
    const r = wsola([x], sr, 1, 100, 200);
    expect(r.channels[0].length).toBe(100);
    expect(r.channels[0][0]).toBe(x[100]);
  });
});
