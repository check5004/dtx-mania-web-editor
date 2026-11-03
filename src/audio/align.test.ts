import { describe, expect, it } from 'vitest';
import {
  ALIGN_FPS,
  alignFeatures,
  anchorDelta,
  buildRefIndex,
  decideOffset,
  FINE_HOP,
  FINE_WIN,
  fineNeeds,
  MAX_PROBES_EDIT,
  nextProbe,
  planProbe,
  searchProbe,
  Z_OK,
  type AlignMatch,
  type LocalSim,
  type ProbeResult,
} from './align';
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

  it('雑音で少し弱い（z 7〜8）探りでも、ずれがなめらかに続けばライブ（drift）。曲の頭も合う', () => {
    // 動画の秒 = 20 + 原曲の秒 / 1.02。真ん中の探りだけがよく似て、前後は雑音で z 7.7〜7.8
    const v = (a: number) => 20 + a / 1.02;
    const at = (a: number, z: number) => probe(v(a) - 4, m(a - 4, z));
    const d = decideOffset([at(33, 7.8), at(68, 12), at(109, 7.7)])!;
    expect(d.kind).toBe('drift');
    for (const a of [5, 10, 60, 120]) expect(Math.abs(a + d.offset + anchorDelta(d.anchors, a) - v(a))).toBeLessThan(0.05);
  });

  it('ずれが行ったり来たりする並び（拍や小節の取り違え）は、ライブにしない', () => {
    // 正しいずれは 10。探り 2・4 は雑音で正しい所が弱く、1 小節（1.6 秒）ずれた所にいちばん似る
    const d = decideOffset([
      probe(26, m(16, 15)),
      probe(66, m(54.4, 7.5), m(56, 5)),
      probe(106, m(96, 15)),
      probe(146, m(134.4, 7.5), m(136, 5)),
    ])!;
    expect(d.kind).toBe('const');
    expect(d.offset).toBeCloseTo(10, 3);
    expect(d.doubt).toEqual([1, 3]);
  });

  it('途中で飛ぶと編集違い（edit）。飛んだ先も 2 か所以上でそろったときだけ。時間が戻る組み合わせは使わない', () => {
    // 動画の秒 = 原曲の秒 + 10、原曲の 40 秒以降は + 40（動画の側に 30 秒ぶん別の場面）。探り 4 は似た別の所（時間が戻る）にも候補がある
    const d = decideOffset([probe(26, m(16, 15)), probe(12, m(2, 16)), probe(90, m(50, 15)), probe(120, m(80, 14), m(20, 13))])!;
    expect(d.kind).toBe('edit');
    // 基準は曲の最初の所のずれ
    expect(d.offset).toBeCloseTo(10, 3);
    expect(20 + d.offset + anchorDelta(d.anchors, 20)).toBeCloseTo(30, 3);
    expect(70 + d.offset + anchorDelta(d.anchors, 70)).toBeCloseTo(110, 3);
  });

  it('飛んだ先が 1 か所だけなら、ずれは変えない（確かめる探りに回す）', () => {
    const d = decideOffset([probe(26, m(16, 15)), probe(12, m(2, 16)), probe(120, m(80, 14))])!;
    expect(d.kind).toBe('const');
    expect(d.offset).toBeCloseTo(10, 3);
    expect(d.doubt).toEqual([2]);
  });

  it('1 か所だけ別のサビにいちばん似ても、正しい所でも十分似ていれば飛ばない（途切れていない動画）', () => {
    // 正しいずれは 10。探り 2 は 30 秒あとのサビに z 18 で似るが、正しい所も z 11（0.61 倍）
    const d1 = decideOffset([probe(20, m(10, 17)), probe(60, m(80, 18), m(50, 11)), probe(100, m(90, 17))])!;
    expect(d1.kind).toBe('const');
    expect(d1.offset).toBeCloseTo(10, 3);
    expect(d1.support).toBe(3);
    // 終わりの探りで、似たサビが 3 つ上に並び、正しい所は 4 番目
    const d2 = decideOffset([probe(20, m(10, 17)), probe(60, m(50, 18)), probe(100, m(110, 18), m(70, 17), m(130, 16.5), m(90, 16))])!;
    expect(d2.kind).toBe('const');
    expect(d2.offset).toBeCloseTo(10, 3);
    expect(d2.doubt).toEqual([]);
  });

  it('どの探りでもよく似るずれ（繰り返しの多い曲）は、飛んだ根拠にしない', () => {
    // 探り 3・4 は 20 秒あとのずれでもよく似るが、探り 1・2 もそのずれで同じくらい似る
    const d = decideOffset([
      probe(20, m(10, 17), m(-10, 15)),
      probe(40, m(30, 17), m(10, 15)),
      probe(80, m(50, 17), m(70, 12)),
      probe(100, m(70, 17), m(90, 12)),
    ])!;
    expect(d.kind).toBe('const');
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
    // 原曲の最初（8%、14.4 秒）を、ずれ 12 秒で動画の時刻に直した所
    expect(v2).toBeCloseTo(14.4 + 12 - 4, 5);
  });

  it('3 か所で合えば終わる', () => {
    const done = [probe(70, m(58, 20)), probe(26, m(14, 20)), probe(170, m(158, 20))];
    expect(nextProbe({ vdur: 200, adur: 180, len: 8, done })).toBeNull();
  });

  it('6 回で打ち切る', () => {
    const done = [0, 1, 2, 3, 4, 5].map((i) => probe(10 + i * 30, m(0, 2, 0.05)));
    expect(nextProbe({ vdur: 200, adur: 180, len: 8, done })).toBeNull();
  });

  it('1 か所だけ食い違ったら、その探りのずれで先をもう一度聞き、確かめたら終わる', () => {
    // ずれ 12 で 3 か所合い、終わりの 1 か所（動画の 150 秒）だけ ずれ -8（原曲の 158 秒）に似る
    const done = [probe(70, m(58, 20)), probe(26, m(14, 20)), probe(110, m(98, 20)), probe(150, m(158, 18))];
    const v = nextProbe({ vdur: 220, adur: 200, len: 8, done })!;
    // 原曲の 162 + 12.8 秒を、ずれ -8 で動画の時刻に直した所
    expect(v).toBeCloseTo(162 + 12.8 - 8 - 4, 5);
    // 聞き直して決めたずれに合った（取り違えだった）なら、それで終わり
    const again = [...done, probe(v, m(v - 12, 19))];
    expect(nextProbe({ vdur: 220, adur: 200, len: 8, done: again })).toBeNull();
    expect(decideOffset(again)!.kind).toBe('const');
    // 曲の終わり際しか先が無ければ、手前側で確かめる
    const v2 = nextProbe({ vdur: 200, adur: 180, len: 8, done })!;
    expect(v2).toBeCloseTo(162 - 12.8 - 8 - 4, 5);
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

describe('編集違いの切れ目を細かく決める', () => {
  /** 動画の秒 → そこで鳴っている原曲の秒（原曲に無い所なら null） */
  type Truth = (t: number) => number | null;
  /** 探りの所ごとの似かた（合っている割合に比例。dip は雑音などで似かたが下がる所） */
  const localOf = (truth: Truth, v: number, o: number, adur: number, dip?: (a: number, o: number) => number, win = 2, hop = 0.25): LocalSim => {
    const n = Math.round((8 - win) / hop) + 1;
    const sim = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = v - o + win / 2 + k * hop;
      if (a - win / 2 < 0 || a + win / 2 > adur) {
        sim[k] = NaN;
        continue;
      }
      let ok = 0;
      for (let j = 0; j < 20; j++) {
        const x = a - win / 2 + ((j + 0.5) * win) / 20;
        const r = truth(x + o);
        if (r !== null && Math.abs(r - x) < 0.05) ok++;
      }
      sim[k] = 0.05 + 0.75 * (ok / 20) * (dip ? dip(a, o) : 1);
    }
    return { o, t0: win / 2, hop, sim };
  };
  /** first から聞き始め、聞き取る所の決め方に従って最後まで聞く */
  const simulate = (truth: Truth, vdur: number, adur: number, first: number, os: number[], dip?: (a: number, o: number) => number) => {
    const done: ProbeResult[] = [];
    let pl: { v: number; cut: boolean } | null = { v: first, cut: false };
    while (pl && done.length < 20) {
      const v = pl.v;
      const r = truth(v + 4);
      const cands = r === null ? [m(5, 4)] : [m(r - 4, 15)];
      done.push({ v, len: 8, cands, active: 1, cut: pl.cut || undefined, local: os.map((o) => localOf(truth, v, o, adur, dip)), floor: 0.05 });
      pl = planProbe({ vdur, adur, len: 8, done });
    }
    // 決まった切れ目の前後を短い窓で比べ直す
    for (const { p, os: fos } of fineNeeds(done, decideOffset(done))) done[p].fine = fos.map((o) => localOf(truth, done[p].v, o, adur, dip, FINE_WIN, FINE_HOP));
    const dec = decideOffset(done)!;
    const at = (a: number) => a + dec.offset + anchorDelta(dec.anchors, a);
    return { done, dec, at };
  };
  // 原曲は 40〜70 秒を切った版（120 秒）、動画はフル（前置き 10 秒）: 原曲の 40 秒より前はずれ 10、後はずれ 40
  const shortRef: Truth = (t) => (t < 10 ? null : t < 50 ? t - 10 : t < 80 ? null : t - 40 <= 120 ? t - 40 : null);

  it('原曲を短くした版: 切れ目の近くを聞き足して、0.1 秒以内で切り替える', () => {
    for (const first of [26, 57.75, 100]) {
      const { done, dec, at } = simulate(shortRef, 165, 120, first, [10, 40]);
      expect(dec.kind).toBe('edit');
      expect(done.length).toBeLessThanOrEqual(MAX_PROBES_EDIT);
      expect(done.some((d) => d.cut)).toBe(true);
      expect(done.some((d) => d.fine)).toBe(true);
      expect(Math.abs(dec.cuts![0].at! - 40)).toBeLessThan(0.1);
      expect(at(39.85)).toBeCloseTo(49.85, 3);
      expect(at(40.15)).toBeCloseTo(80.15, 3);
      expect(at(15)).toBeCloseTo(25, 3);
      expect(at(100)).toBeCloseTo(140, 3);
    }
  });

  it('前のずれで探りの端まで似なくなっても（ドラムだけの所・雑音）、後のずれで確かめて切れ目にしない', () => {
    // 原曲の 25〜31 秒は、合っていても似かたがほとんど無い。最初の探りはちょうどそこで端まで似なくなる
    const dip = (a: number, o: number) => (o === 10 && a > 25 && a < 31 ? 0.1 : 1);
    const { dec, at } = simulate(shortRef, 165, 120, 31, [10, 40], dip);
    expect(dec.kind).toBe('edit');
    expect(Math.abs(dec.cuts![0].at! - 40)).toBeLessThan(0.3);
    expect(at(30)).toBeCloseTo(40, 3);
    expect(at(41)).toBeCloseTo(81, 3);
  });

  it('動画を短くした版: 1 か所の探りで前のずれの終わりと後のずれの始まりがそろう', () => {
    // 原曲はフル（150 秒）、動画は原曲の 40〜60 秒を切った版: 原曲の 40 秒より前はずれ 0、60 秒より後はずれ -20
    const shortVid: Truth = (t) => (t < 40 ? t : t + 20 <= 150 ? t + 20 : null);
    const { dec, at } = simulate(shortVid, 130, 150, 45.5, [0, -20]);
    expect(dec.kind).toBe('edit');
    const c = dec.cuts![0];
    expect(c.at! - 40).toBeGreaterThan(-0.3);
    expect(c.at! - 40).toBeLessThan(0.3);
    expect(at(39.6)).toBeCloseTo(39.6, 3);
    expect(at(60.4)).toBeCloseTo(40.4, 3);
  });
});
