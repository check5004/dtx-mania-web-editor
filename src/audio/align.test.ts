import { describe, expect, it } from 'vitest';
import { ALIGN_FPS, alignFeatures, anchorDelta, buildRefIndex, decideOffset, nextProbe, searchProbe, Z_OK, type AlignMatch, type ProbeResult } from './align';
import { applyChain, biquad } from './dsp';
import { synth, type SynthHit } from './testSignal';

const SR = 44100;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 和音（毎小節変わる）＋ドラムの、曲らしいテスト音。小節ごとにリズムも少し変える */
function song(seconds: number, seed = 1): Float32Array {
  const r = rng(seed);
  const bpm = 128;
  const beat = 60 / bpm;
  const hits: SynthHit[] = [];
  for (let t = 0, k = 0; t < seconds; t += beat / 2, k++) {
    hits.push({ t, kind: 'hat' });
    if (k % 4 === 0 || r() < 0.18) hits.push({ t, kind: 'kick' });
    if (k % 4 === 2) hits.push({ t, kind: 'snare' });
    if (k % 32 === 0) hits.push({ t, kind: 'crash' });
  }
  const x = synth(hits, SR, seconds);
  const bar = 4 * beat;
  const roots = [0, 5, 7, 3, 8, 10, 2, 9];
  for (let b = 0; b * bar < seconds; b++) {
    const root = 48 + roots[Math.floor(r() * roots.length)];
    const notes = [root, root + (r() < 0.5 ? 3 : 4), root + 7, root + 12];
    const i0 = Math.floor(b * bar * SR);
    const i1 = Math.min(x.length, Math.floor((b + 1) * bar * SR));
    for (const m of notes) {
      const f = 440 * 2 ** ((m - 69) / 12);
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / SR;
        x[i] += 0.06 * Math.sin(2 * Math.PI * f * t) * Math.min(1, t / 0.01) * Math.exp(-t / 1.5);
      }
    }
  }
  return x;
}

/** 「YouTube 側」: 前置き（雑音）＋曲の一部、EQ・音量違い・雑音 */
function youtubeLike(src: Float32Array, preSec: number, from: number, to: number, seed = 9): Float32Array {
  const r = rng(seed);
  const pre = Math.round(preSec * SR);
  const body = src.subarray(Math.round(from * SR), Math.round(to * SR));
  const out = new Float32Array(pre + body.length);
  for (let i = 0; i < pre; i++) out[i] = 0.08 * (r() - 0.5) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3.3 * i) / SR));
  const eq = applyChain(body, [biquad('lowpass', 5000, 0.707, SR)]);
  for (let i = 0; i < body.length; i++) out[pre + i] = 0.7 * eq[i] + 0.004 * (r() - 0.5);
  return out;
}

const cut = (x: Float32Array, from: number, len: number) => x.slice(Math.round(from * SR), Math.round((from + len) * SR));

describe('YouTube との自動合わせ（特徴の比べ方）', () => {
  const ref = song(60);
  const idx = buildRefIndex(alignFeatures([ref], SR), 8 * ALIGN_FPS);
  // 動画 = 前置き 6 秒 + 曲の 0〜60 秒（動画の秒 = 原曲の秒 + 6）
  const vid = youtubeLike(ref, 6, 0, 60);

  it('前置き・EQ・音量が違っても、曲の所は 10ms 以内で見つかる', () => {
    for (const v0 of [20, 33, 47]) {
      const r = searchProbe(idx, alignFeatures([cut(vid, v0, 8)], SR));
      const b = r.cands[0];
      expect(b.z).toBeGreaterThan(Z_OK);
      expect(Math.abs(b.sec - (v0 - 6))).toBeLessThan(0.01);
    }
  });

  it('前置き（雑音だけ）の所は当てにならないと出る', () => {
    const r = searchProbe(idx, alignFeatures([cut(vid, 0, 5.5)], SR));
    expect(r.cands[0].z).toBeLessThan(Z_OK);
  });

  it('3 か所で聞き取ると、ずれは一定（const）で 6 秒', () => {
    const done: ProbeResult[] = [];
    for (;;) {
      const v = nextProbe({ vdur: vid.length / SR, adur: 60, len: 8, done });
      if (v === null) break;
      const r = searchProbe(idx, alignFeatures([cut(vid, v, 8)], SR));
      done.push({ v, len: 8, cands: r.cands, active: r.active });
    }
    expect(done.length).toBeLessThanOrEqual(4);
    const d = decideOffset(done)!;
    expect(d.kind).toBe('const');
    expect(d.offset).toBeCloseTo(6, 2);
    expect(d.conf).toBeGreaterThan(0.8);
  });
});

const m = (sec: number, z: number, score = 0.5): AlignMatch => ({ sec, z, score, parts: { onset: score, mel: score, chroma: score } });
const probe = (v: number, ...cands: AlignMatch[]): ProbeResult => ({ v, len: 8, cands, active: 1 });

describe('何か所かの結果のまとめ方', () => {
  it('繰り返しのサビで候補が割れても、ほかの探りと合う方を選ぶ', () => {
    // 正しいずれは 10。探り 1 は 30 秒後のサビとも同じくらい似る
    const d = decideOffset([probe(50, m(70, 16), m(40, 15)), probe(100, m(90, 18)), probe(20, m(10, 17))])!;
    expect(d.kind).toBe('const');
    expect(d.offset).toBeCloseTo(10, 3);
    expect(d.support).toBe(3);
  });

  it('ずれが時刻に比例して変わるとライブ（drift）、なめらかにつなぐ', () => {
    // 動画の秒 = 原曲の秒 × 0.98 + 20
    const v = (a: number) => a * 0.98 + 20;
    const d = decideOffset([probe(v(30) - 4, m(30 - 4, 14)), probe(v(90) - 4, m(90 - 4, 14)), probe(v(150) - 4, m(150 - 4, 14))])!;
    expect(d.kind).toBe('drift');
    for (const a of [10, 60, 120, 170]) expect(a + d.offset + anchorDelta(d.anchors, a)).toBeCloseTo(v(a), 1);
  });

  it('途中で飛ぶと編集違い（edit）。時間が戻る組み合わせは使わない', () => {
    // 原曲の 40 秒以降は動画で 20 秒先（ゲームサイズ）。探り 3 は似た別の所（時間が戻る）にも候補がある
    const d = decideOffset([probe(26, m(16, 15)), probe(90, m(50, 15)), probe(120, m(80, 14), m(20, 13))])!;
    expect(d.kind).toBe('edit');
    expect(20 + d.offset + anchorDelta(d.anchors, 20)).toBeCloseTo(30, 3);
    expect(70 + d.offset + anchorDelta(d.anchors, 70)).toBeCloseTo(110, 3);
  });

  it('当てになる候補が無ければ null か、自信の低い結果', () => {
    expect(decideOffset([probe(10, m(5, 2, 0.05))])).toBeNull();
    const d = decideOffset([probe(10, m(5, 7, 0.2))]);
    expect(d === null || d.conf < 0.5).toBe(true);
  });
});

describe('聞き取る所の決め方', () => {
  it('見当が無ければ動画の 35% から。1 か所合えば原曲の頭・終わりを聞く', () => {
    const v1 = nextProbe({ vdur: 200, adur: 180, len: 8, done: [] })!;
    expect(v1).toBeCloseTo(70, 5);
    const done = [probe(v1, m(v1 - 12, 20))];
    const v2 = nextProbe({ vdur: 200, adur: 180, len: 8, done })!;
    // 原曲の 10% （18 秒）を、ずれ 12 秒で動画の時刻に直した所
    expect(v2).toBeCloseTo(18 + 12 - 4, 5);
  });

  it('3 か所で合えば終わる', () => {
    const done = [probe(70, m(58, 20)), probe(26, m(14, 20)), probe(170, m(158, 20))];
    expect(nextProbe({ vdur: 200, adur: 180, len: 8, done })).toBeNull();
  });

  it('5 回で打ち切る', () => {
    const done = [0, 1, 2, 3, 4].map((i) => probe(10 + i * 30, m(0, 2, 0.05)));
    expect(nextProbe({ vdur: 200, adur: 180, len: 8, done })).toBeNull();
  });
});

describe('所ごとのずれ', () => {
  it('なめらかな所は補間し、外側も同じ傾きでのばす', () => {
    const an = [
      { a: 20, d: 0.4 },
      { a: 60, d: 0 },
    ];
    expect(anchorDelta(an, 40)).toBeCloseTo(0.2, 6);
    expect(anchorDelta(an, 80)).toBeCloseTo(-0.2, 6);
  });
  it('飛ぶ所は間の真ん中で切り替え、外側は端の値', () => {
    const an = [
      { a: 20, d: 0 },
      { a: 60, d: 20 },
    ];
    expect(anchorDelta(an, 39)).toBe(0);
    expect(anchorDelta(an, 41)).toBe(20);
    expect(anchorDelta(an, 100)).toBe(20);
    expect(anchorDelta([], 5)).toBe(0);
  });
});
