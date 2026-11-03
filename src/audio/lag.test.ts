import { describe, expect, it } from 'vitest';
import { estimateLag, measureLag, onsetEnvelope } from './lag';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SR = 44100;

/** ドラムのまね（ばらばらの時刻に、すぐ減衰する雑音の打撃）。delay サンプル遅らせて置く */
function drums(seconds: number, delay = 0, seed = 1): Float32Array {
  const r = rng(seed);
  const x = new Float32Array(Math.floor(seconds * SR));
  let t = 0.2;
  while (t < seconds - 0.5) {
    const at = Math.floor(t * SR) + delay;
    const amp = 0.3 + 0.6 * r();
    for (let i = 0; i < 4000 && at + i < x.length; i++) if (at + i >= 0) x[at + i] += amp * (r() * 2 - 1) * Math.exp(-i / 600);
    t += 0.12 + r() * 0.4;
  }
  return x;
}

/** ほかの楽器のまね（ゆっくり変わる和音） */
function pad(seconds: number, seed = 2): Float32Array {
  const r = rng(seed);
  const x = new Float32Array(Math.floor(seconds * SR));
  const fs = [220, 277, 330].map((f) => f * (1 + r() * 0.01));
  for (let i = 0; i < x.length; i++) {
    const env = 0.5 + 0.5 * Math.sin((i / SR) * 0.7);
    x[i] = 0.08 * env * fs.reduce((s, f) => s + Math.sin((2 * Math.PI * f * i) / SR), 0);
  }
  return x;
}

const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));

describe('ステムと原曲のずれ', () => {
  const sec = 30;
  const orig = mix(drums(sec), pad(sec));

  it('ずれていなければ 0、1105 サンプル遅れていれば +25ms、529 サンプル早ければ −12ms', () => {
    const a = onsetEnvelope([orig], SR);
    for (const d of [0, 1105, -529]) {
      const r = estimateLag(a, onsetEnvelope([drums(sec, d)], SR));
      expect(r).not.toBeNull();
      expect(Math.abs(r!.lag - d / SR)).toBeLessThan(0.0015);
    }
  });

  it('原曲にその音が入っていなければ測れない（null）', () => {
    const a = onsetEnvelope([pad(sec)], SR);
    expect(estimateLag(a, onsetEnvelope([drums(sec, 0, 5)], SR))).toBeNull();
    // 別の曲のドラム
    expect(estimateLag(onsetEnvelope([drums(sec, 0, 7)], SR), onsetEnvelope([drums(sec, 0, 9)], SR))).toBeNull();
  });

  it('少しずつ休みながら測っても同じ', async () => {
    const r = await measureLag([orig], [drums(sec, 1105)], SR);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.lag - 1105 / SR)).toBeLessThan(0.0015);
    // 途中で要らなくなれば null
    expect(await measureLag([orig], [drums(sec, 1105)], SR, () => true)).toBeNull();
  });
});
