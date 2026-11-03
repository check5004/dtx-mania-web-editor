import { describe, expect, it } from 'vitest';
import { computeFrameFeatures } from '../audio/features';
import { eightBeat, synth, type SynthHit } from '../audio/testSignal';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { contentOf, contentSim, measureContents, predictBlock, predictChain, type AudioSimilarity, type ChartSource, type CNote } from './complete';
import { onsetEvidence } from './evidence';
import type { HeardDrums } from './heard';
import { measureAudio } from './measureAudio';

/** 8ビート（HH 8分、BD 1・3拍、SD 2・4拍） */
const A: CNote[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ ch: CH.HHC, f: frac(i, 8), v: 1 })),
  { ch: CH.BD, f: frac(0, 4), v: 2 },
  { ch: CH.BD, f: frac(2, 4), v: 2 },
  { ch: CH.SD, f: frac(1, 4), v: 3 },
  { ch: CH.SD, f: frac(3, 4), v: 3 },
];
/** A の4拍目の裏にバスドラムを足したもの */
const B: CNote[] = [...A, { ch: CH.BD, f: frac(7, 8), v: 2 }];
/** フィル（スネアの16分） */
const FILL: CNote[] = Array.from({ length: 16 }, (_, i) => ({ ch: CH.SD, f: frac(i, 16), v: 3 }));

function chartOf(ms: Record<number, CNote[]>, at: number): ChartSource {
  const contents = new Map(Object.entries(ms).map(([m, ns]) => [Number(m), contentOf(ns)]));
  return { contents, barLen: () => 1, canCopy: (m) => m >= 0 && m < at };
}

const sig = (ns: CNote[]) => contentOf(ns).sig;

describe('TAB補完の予測', () => {
  it('同じ小節が続いていれば、その続きを出す（点数は「次の小節がそのまま正解」の見込み）', () => {
    const ms: Record<number, CNote[]> = {};
    for (let m = 0; m < 8; m++) ms[m] = A;
    const top = predictBlock(chartOf(ms, 8), { at: 8, len: 4 })[0];
    expect(top.measures).toHaveLength(4);
    for (const ns of top.measures) expect(sig(ns)).toBe(sig(A));
    // 精度テストの曲では、4小節同じでも次がまったく同じなのは4割ほど
    expect(top.score).toBeGreaterThan(0.3);
    expect(top.score).toBeLessThan(0.6);
  });

  it('2小節の繰り返しは、その周期で先まで写す', () => {
    const ms: Record<number, CNote[]> = {};
    for (let m = 0; m < 8; m++) ms[m] = m % 2 ? B : A;
    const top = predictBlock(chartOf(ms, 8), { at: 8, len: 4 })[0];
    expect(top.measures.map(sig)).toEqual([A, B, A, B].map(sig));
  });

  it('入力の途中の小節は、もう置いたチップを全部含む候補だけ', () => {
    const ms: Record<number, CNote[]> = {};
    for (let m = 0; m < 8; m++) ms[m] = m % 2 ? B : A;
    const partial = contentOf([{ ch: CH.BD, f: frac(7, 8), v: 2 }]);
    const cands = predictBlock(chartOf(ms, 8), { at: 8, len: 1, partial });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) expect(contentOf(c.measures[0]).keys.has(`${CH.BD}@7/8`)).toBe(true);
  });

  it('小節の長さが違う所へは写さない', () => {
    const contents = new Map([0, 1, 2, 3].map((m) => [m, contentOf(A)]));
    const chart: ChartSource = { contents, barLen: (m) => (m === 5 ? 0.75 : 1), canCopy: (m) => m >= 0 && m < 4 };
    const top = predictBlock(chart, { at: 4, len: 4 })[0];
    expect(top.measures).toHaveLength(1);
  });

  it('原曲で同じに聞こえる小節があれば、その譜面を写す（2番のサビ＝1番のサビ）', () => {
    // 0〜7: A、8〜11: サビ（B とフィル）、12〜15: A。16 から2回目のサビ
    const ms: Record<number, CNote[]> = {};
    for (let m = 0; m < 16; m++) ms[m] = A;
    ms[8] = B;
    ms[9] = B;
    ms[10] = B;
    ms[11] = FILL;
    const section = (m: number) => (m >= 8 && m < 12) || m >= 16;
    const audio: AudioSimilarity = {
      sim: (a, b) => (a === b ? 1 : section(a) === section(b) && (a % 4) === (b % 4) ? 0.9 : -0.2),
    };
    const chart = chartOf(ms, 16);
    const withAudio = predictChain(chart, { at: 16, len: 4, audio, minNext: 0.2 })[0];
    expect(withAudio.kind).toBe('structure');
    expect(withAudio.src).toBe(8);
    expect(withAudio.measures.map(sig)).toEqual([B, B, B, FILL].map(sig));
    // 譜面だけなら、直前と同じ A を続ける
    const chartOnly = predictChain(chart, { at: 16, len: 4 })[0];
    expect(sig(chartOnly.measures[0])).toBe(sig(A));
  });

  it('採譜で、予測する小節にドラムが聞こえないと見込みが下がる', () => {
    const ms: Record<number, CNote[]> = {};
    for (let m = 0; m < 8; m++) ms[m] = A;
    const audio: AudioSimilarity = { sim: (a, b) => (a === b ? 1 : 0.5) };
    // 直前の小節までは譜面どおりに聞こえる。小節 8 で鳴りやむかどうか
    const agree = (silentFrom: number): HeardDrums => ({ agree: (notes, m) => (m >= silentFrom ? (notes.length ? 0 : 1) : 1) });
    const keepsPlaying = predictBlock(chartOf(ms, 8), { at: 8, len: 1, audio, heard: agree(99) })[0];
    const stops = predictBlock(chartOf(ms, 8), { at: 8, len: 1, audio, heard: agree(8) })[0];
    const noDrums = predictBlock(chartOf(ms, 8), { at: 8, len: 1, audio })[0];
    expect(sig(keepsPlaying.measures[0])).toBe(sig(A));
    expect(stops.score).toBeLessThan(keepsPlaying.score - 0.2);
    // 聞こえ方どおりなら、採譜なしのときと大きくは変わらない
    expect(Math.abs(keepsPlaying.score - noDrums.score)).toBeLessThan(0.15);
  });

  it('続けて予測するときは、見込みが下がった所で止める', () => {
    const ms: Record<number, CNote[]> = {};
    for (let m = 0; m < 8; m++) ms[m] = A;
    const chain = predictChain(chartOf(ms, 8), { at: 8, len: 4, minNext: 0.99 })[0];
    expect(chain.measures).toHaveLength(1);
    expect(chain.scores).toHaveLength(1);
  });

  it('譜面の近さ：同じなら1、どちらも空なら0.5、片方だけ空なら0', () => {
    expect(contentSim(contentOf(A), contentOf(A))).toBe(1);
    expect(contentSim(undefined, undefined)).toBe(0.5);
    expect(contentSim(contentOf(A), undefined)).toBe(0);
    expect(contentSim(contentOf(A), contentOf(B))).toBeCloseTo(12 / 13, 6);
  });

  it('小節ごとの中身はドラムのチップだけ（BGM は入れない）', () => {
    const doc: DtxDoc = emptyDoc();
    doc.chips.push({ id: 1, ch: CH.BGM, m: 0, f: frac(0, 1), v: 1 }, { id: 2, ch: CH.SD, m: 1, f: frac(1, 4), v: 3 });
    const c = measureContents(doc);
    expect([...c.keys()]).toEqual([1]);
    expect(c.get(1)!.keys.has(`${CH.SD}@1/4`)).toBe(true);
  });
});

describe('原曲の聞こえ方（曲の構造）', () => {
  const SR = 22050;
  const BPM = 120;
  const BAR = (4 * 60) / BPM;

  /** 小節ごとの和音とドラム。P と Q の2つの部分を P P P P Q Q Q Q P P P P に並べる */
  function song(): Float32Array {
    const bars = 12;
    const part = (m: number) => (m >= 4 && m < 8 ? 'Q' : 'P');
    const hits: SynthHit[] = [];
    for (let m = 0; m < bars; m++) {
      const one = eightBeat(BPM, 1, m * BAR);
      if (part(m) === 'Q') {
        // Q はスネアを抜いて、キックを4つ打ち
        for (const h of one) if (h.kind !== 'snare' && h.kind !== 'kick') hits.push(h);
        for (let k = 0; k < 4; k++) hits.push({ t: m * BAR + (k * BAR) / 4, kind: 'kick' });
      } else {
        hits.push(...one.filter((h) => h.kind !== 'crash'));
      }
    }
    const x = synth(hits, SR, bars * BAR + 0.5);
    for (let m = 0; m < bars; m++) {
      const fs = part(m) === 'P' ? [261.6, 329.6, 392] : [370, 466.2, 554.4];
      for (let i = Math.round(m * BAR * SR); i < Math.round((m + 1) * BAR * SR) && i < x.length; i++) {
        const t = i / SR;
        for (const f of fs) x[i] += 0.08 * Math.sin(2 * Math.PI * f * t);
      }
    }
    return x;
  }

  it('同じ部分の小節どうしは、違う部分の小節より似ている', () => {
    const x = song();
    const frames = computeFrameFeatures([x], SR);
    const doc = emptyDoc();
    doc.fields['BPM'] = String(BPM);
    const tempo = buildTempoMap(doc);
    const ma = measureAudio({ frames, offsetSec: 0, duration: x.length / SR }, tempo, 11);
    // 3回目の P（8〜11）と1回目の P（0〜3）、Q（4〜7）
    for (const m of [9, 10]) {
      const same = ma.sim(m, m - 8)!;
      const other = ma.sim(m, m - 4)!;
      expect(same).toBeGreaterThan(other);
      expect(same).toBeGreaterThan(0);
    }
    expect(ma.sim(5, 6)!).toBeGreaterThan(ma.sim(5, 9)!);
    // 原曲の外の小節は比べない
    expect(ma.has(20)).toBe(false);
    expect(ma.sim(3, 20)).toBeNull();
  });
});

describe('原曲との照合', () => {
  it('スネアの打点の近く（±50ms）なら聞こえる、離れていれば聞こえない。ほかの種類は分からない', () => {
    // 合成のスネアだけの音を解析したことにする（中域だけが立ち上がる）
    const frameRate = 100;
    const n = 400;
    const z = () => new Float32Array(n);
    const odf = { low: z(), mid: z(), high: z() };
    const env = { low: z(), mid: z(), high: z() };
    for (const t of [0.5, 1.5, 2.5]) odf.mid[Math.round(t * frameRate)] = 1;
    const ev = onsetEvidence({ frameRate, odf, env });
    expect(ev.heard('SD', 1.5)).toBe(true);
    expect(ev.heard('SD', 1.54)).toBe(true);
    expect(ev.heard('SD', 2.0)).toBe(false);
    expect(ev.heard('BD', 2.0)).toBeNull();
  });
});
