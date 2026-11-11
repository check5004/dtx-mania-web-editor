// 音の切り出し: 鳴り始めを探す・次の音の手前で切る・整える・重ねて平均する・WAV にする
import { describe, expect, it } from 'vitest';
import { autoRange, cutPcm, DEFAULT_SHAPE, findOnset, fingerprint, lowShareDb, msToSamples, pcmLength, peakOf, preDb, recommend, similarity, stackPcm, wavBytes, type Pcm } from './cut';

const SR = 44100;

/** 決まった乱数（テストが毎回同じになるように） */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

/** クラップのような音（雑音を速く減衰させる）を at サンプルから足す */
function addBurst(x: Float32Array, at: number, gain: number, seed: number, decayMs = 60) {
  const r = rand(seed);
  const n = msToSamples(SR, 400);
  for (let i = 0; i < n && at + i < x.length; i++) if (at + i >= 0) x[at + i] += gain * 2 * r() * Math.exp(-i / msToSamples(SR, decayMs));
}

/** 低い音（バスドラムのような 60 Hz） */
function addKick(x: Float32Array, at: number, gain: number) {
  const n = msToSamples(SR, 300);
  for (let i = 0; i < n && at + i < x.length; i++) x[at + i] += gain * Math.sin((2 * Math.PI * 60 * i) / SR) * Math.exp(-i / msToSamples(SR, 120));
}

function stereo(len: number): Pcm {
  return { sr: SR, ch: [new Float32Array(len), new Float32Array(len)] };
}

describe('鳴り始め', () => {
  it('チップの時刻が少しずれていても、本当の鳴り始めを 1 ms 以内で見つける', () => {
    const p = stereo(SR);
    const truth = msToSamples(SR, 500);
    for (const x of p.ch) addBurst(x, truth, 0.5, 7);
    for (const off of [-20, -5, 0, 12, 25]) {
      const o = findOnset(p, truth + msToSamples(SR, off));
      expect(o.found).toBe(true);
      expect(Math.abs(o.at - truth)).toBeLessThanOrEqual(msToSamples(SR, 1));
    }
  });

  it('前の音が鳴り続けていても、その上に立ち上がった所を取る', () => {
    const p = stereo(SR);
    const truth = msToSamples(SR, 500);
    for (const x of p.ch) {
      addBurst(x, truth - msToSamples(SR, 80), 0.4, 3, 200);
      addBurst(x, truth, 0.6, 9);
    }
    const o = findOnset(p, truth + msToSamples(SR, 8));
    expect(Math.abs(o.at - truth)).toBeLessThanOrEqual(msToSamples(SR, 1.5));
    expect(o.before).toBeGreaterThan(0.01);
  });

  it('音が無ければ見つからない', () => {
    const p = stereo(SR);
    expect(findOnset(p, 2000).found).toBe(false);
  });
});

describe('切り方と整え方', () => {
  it('鳴り始めの 2 ms 前から、次の音の 16 ms 手前まで。整えるといちばん大きい所が −1 dB、終わりは 0 へ', () => {
    const p = stereo(SR);
    const a = msToSamples(SR, 300);
    const b = msToSamples(SR, 626);
    for (const x of p.ch) {
      addBurst(x, a, 0.3, 1);
      addBurst(x, b, 0.3, 2);
    }
    const r = autoRange(p, a + msToSamples(SR, 5), b - msToSamples(SR, 4));
    expect(Math.abs(r.start - (a - msToSamples(SR, 2)))).toBeLessThanOrEqual(msToSamples(SR, 1));
    expect(r.next).not.toBeNull();
    expect(Math.abs(r.end - (b - msToSamples(SR, 16)))).toBeLessThanOrEqual(msToSamples(SR, 1));
    const c = cutPcm(p, r.start, r.end, DEFAULT_SHAPE);
    expect(pcmLength(c)).toBe(r.end - r.start);
    expect(20 * Math.log10(peakOf(c))).toBeCloseTo(-1, 2);
    expect(Math.abs(c.ch[0][pcmLength(c) - 1])).toBeLessThan(1e-3);
    expect(Math.abs(c.ch[0][0])).toBeLessThan(1e-3);
    // 元の音は書き換えない
    expect(peakOf(p)).toBeLessThan(0.7);
  });

  it('次の音が無ければ長くても 1 秒。手で決めた長さにもできる。モノラルにできる', () => {
    const p = stereo(SR * 3);
    for (const x of p.ch) addBurst(x, SR, 0.3, 5);
    const r = autoRange(p, SR, null);
    expect(r.end - r.start).toBe(msToSamples(SR, 1000));
    const m = autoRange(p, SR, null, { align: true, lenMs: 250 });
    expect(m.end - m.start).toBe(msToSamples(SR, 250));
    expect(cutPcm(p, m.start, m.end, { ...DEFAULT_SHAPE, mono: true }).ch).toHaveLength(1);
  });

  it('低い音を弱めると、バスドラムの混ざりが減る', () => {
    const p = stereo(SR);
    const a = msToSamples(SR, 200);
    for (const x of p.ch) {
      addBurst(x, a, 0.3, 11);
      addKick(x, a, 0.6);
    }
    const r = autoRange(p, a, null, { align: true, lenMs: 300 });
    const raw = cutPcm(p, r.start, r.end, { ...DEFAULT_SHAPE, lowCut: false });
    const cut = cutPcm(p, r.start, r.end, DEFAULT_SHAPE);
    expect(lowShareDb(cut)).toBeLessThan(lowShareDb(raw) - 10);
  });

  it('鳴り始めの前が静かなら低い値（dB）', () => {
    const p = stereo(SR);
    const a = msToSamples(SR, 300);
    for (const x of p.ch) addBurst(x, a, 0.5, 4);
    const o = findOnset(p, a);
    expect(preDb(p, o)).toBeLessThan(-60);
  });
});

describe('重ねる', () => {
  it('ずれた所をそろえて平均すると、毎回は鳴っていない音が小さくなる', () => {
    const list: Pcm[] = [];
    const shifts = [0, 37, -51, 88, -12, 64];
    shifts.forEach((s, i) => {
      const len = msToSamples(SR, 300);
      const p = stereo(len);
      const noise = rand(100 + i);
      for (const x of p.ch) {
        addBurst(x, msToSamples(SR, 2) + s, 0.5 * (1 + i * 0.1), 42);
        // 毎回ちがう音（ハイハットの残りなど）
        for (let n = 0; n < len; n++) x[n] += 0.03 * noise();
      }
      list.push(p);
    });
    const st = stackPcm(list);
    // 1 つ目に合わせたずれ（1 サンプルまで）
    st.shifts.forEach((v, i) => expect(Math.abs(v - (shifts[i] - shifts[0]))).toBeLessThanOrEqual(1));
    expect(st.stacked).toBeLessThan(st.single - 7);
    expect(pcmLength(st.out)).toBeGreaterThan(msToSamples(SR, 290) - 90);
  });
});

describe('WAV', () => {
  it('16bit・チャンネル数・サンプリング周波数を書く', () => {
    const p: Pcm = { sr: 48000, ch: [new Float32Array([0, 0.5, -0.5, 1])] };
    const b = wavBytes(p);
    const v = new DataView(b.buffer);
    expect(String.fromCharCode(...b.slice(0, 4))).toBe('RIFF');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(44 + 2, true)).toBe(Math.round(0.5 * 0x7fff - 0.5));
  });
});

describe('似た所を選ぶ', () => {
  /** 同じ音（seed が同じ）に、毎回ちがう雑音を足した音。鳴り始めの 2 ms 前から */
  function hit(seed: number, noiseSeed: number, noise = 0.02): Pcm {
    const len = msToSamples(SR, 200);
    const p = stereo(len);
    const r = rand(noiseSeed);
    for (const x of p.ch) {
      addBurst(x, msToSamples(SR, 2), 0.5, seed);
      for (let n = 0; n < len; n++) x[n] += noise * r();
    }
    return p;
  }

  it('同じ音どうしは似ていて、ちがう音とは似ていない', () => {
    const a = fingerprint(hit(42, 1));
    const b = fingerprint(hit(42, 2));
    const c = fingerprint(hit(77, 3));
    expect(similarity(a, b, SR)).toBeGreaterThan(0.8);
    expect(similarity(a, c, SR)).toBeLessThan(0.3);
  });

  it('おすすめは、いちばん多い同じ音の所だけ（ちがう音の所は入らない）', () => {
    // 0・2・3・5 は同じ音、1・4 はちがう音
    const seeds = [42, 7, 42, 42, 9, 42];
    const fps = seeds.map((s, i) => fingerprint(hit(s, 10 + i)));
    const pick = recommend(fps, [0, 1, 2, 3, 4, 5], SR);
    expect([...pick].sort()).toEqual([0, 2, 3, 5]);
    // 多すぎるときは max まで
    expect(recommend(fps, [0, 1, 2, 3, 4, 5], SR, 2)).toHaveLength(2);
  });

  it('似た所が無ければ 1 か所だけ', () => {
    const fps = [1, 2, 3, 4].map((s) => fingerprint(hit(s, 20 + s)));
    expect(recommend(fps, [0, 1, 2, 3], SR)).toHaveLength(1);
  });
});
