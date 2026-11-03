import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { DRUM_CLASSES, type DrumClass } from '../bench/classes';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { analyzeOffset, chipTimes, constantBpm, localOffset, roundFitBpm, shiftBgm, type ChipTime, type HitsByClass } from './offsetCheck';

/** 決まった乱数（テストを毎回同じにする） */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 4つ打ちのキック・2と4のスネア・8分（または16分）のハイハット・4小節ごとにシンバル */
function songDoc(bpm: number, measures: number, hh: 8 | 16 = 8, bgm = { m: 0, n: 0 }): DtxDoc {
  const d = emptyDoc();
  d.fields = { BPM: String(bpm), WAV01: 'song.ogg' };
  let id = 1;
  d.chips.push({ id: id++, ch: CH.BGM, m: bgm.m, f: frac(bgm.n, 384), v: 1 });
  for (let m = 1; m <= measures; m++) {
    for (let b = 0; b < 4; b++) d.chips.push({ id: id++, ch: CH.BD, m, f: frac(b, 4), v: 1 });
    for (const b of [1, 3]) d.chips.push({ id: id++, ch: CH.SD, m, f: frac(b, 4), v: 1 });
    for (let k = 0; k < hh; k++) d.chips.push({ id: id++, ch: CH.HHC, m, f: frac(k, hh), v: 1 });
    if (m % 4 === 1) d.chips.push({ id: id++, ch: CH.CY, m, f: frac(0), v: 1 });
  }
  d.nextId = id;
  return d;
}

/**
 * 採譜の打点のまね: チップの時刻に shift(t) を足し、少し揺らして 1/100 秒に丸める。
 * 15% は拾わず、関係ない打点も少し混ぜる。
 */
function fakeHits(chips: readonly ChipTime[], shift: (t: number) => number, seed = 1): HitsByClass {
  const r = rng(seed);
  const out = Object.fromEntries(DRUM_CLASSES.map((c) => [c, [] as { t: number }[]])) as Record<DrumClass, { t: number }[]>;
  const end = chips.length ? chips[chips.length - 1].t : 0;
  for (const c of chips) {
    if (r() < 0.15) continue;
    const t = c.t + shift(c.t) + (r() - 0.5) * 0.006;
    out[c.cls].push({ t: Math.round(t * 100) / 100 });
  }
  for (const cls of DRUM_CLASSES) {
    const n = Math.floor(out[cls].length * 0.1);
    for (let i = 0; i < n; i++) out[cls].push({ t: Math.round(r() * end * 100) / 100 });
    out[cls].sort((a, b) => a.t - b.t);
  }
  return out;
}

function setup(bpm: number, measures: number, hh: 8 | 16 = 8) {
  const doc = songDoc(bpm, measures, hh);
  const tempo = buildTempoMap(doc);
  const chips = chipTimes(doc, tempo, 0, 1e9);
  return { doc, tempo, chips };
}

describe('譜面と原曲の打点のずれ', () => {
  it('合っていれば ok', () => {
    const { chips, tempo } = setup(120, 48);
    const r = analyzeOffset(chips, fakeHits(chips, () => 0), constantBpm(tempo));
    expect(r.verdict).toBe('ok');
    expect(Math.abs(r.offset)).toBeLessThan(0.003);
    expect(r.pairs.length).toBeGreaterThan(chips.length * 0.7);
  });

  it('同じだけずれていれば開始位置（+24ms・−37ms）', () => {
    for (const off of [0.024, -0.037]) {
      const { chips, tempo } = setup(73, 60);
      const r = analyzeOffset(chips, fakeHits(chips, () => off, 7), constantBpm(tempo));
      expect(r.verdict).toBe('start');
      expect(Math.abs(r.offset - off)).toBeLessThan(0.003);
      expect(r.bpmFit).toBeNull();
    }
  });

  it('細かい連打（200BPM の16分）でも、1打となりにずれた山に引っぱられない', () => {
    const { chips, tempo } = setup(200, 64, 16);
    const r = analyzeOffset(chips, fakeHits(chips, () => 0.04, 3), constantBpm(tempo));
    expect(r.verdict).toBe('start');
    expect(Math.abs(r.offset - 0.04)).toBeLessThan(0.003);
  });

  it('後ろほどずれるなら BPM（譜面 73・原曲 72.95）', () => {
    const { chips, tempo } = setup(73, 90);
    // 譜面の t 秒の拍は、原曲では t × 73 / 72.95 秒。頭は +5ms ずれている
    const r = analyzeOffset(chips, fakeHits(chips, (t) => 0.005 + t * (73 / 72.95 - 1), 5), constantBpm(tempo));
    expect(r.verdict).toBe('bpm');
    expect(r.bpmFit).not.toBeNull();
    expect(r.bpmFit!.bpm).toBe(72.95);
    expect(r.bpmFit!.from).toBe(73);
    expect(Math.abs(r.bpmFit!.t0 - 0.005)).toBeLessThan(0.003);
    expect(r.bpmFit!.resid).toBeLessThan(0.005);
    expect(r.tail - r.head).toBeGreaterThan(0.1);
  });

  it('テンポが揺れる曲（±30ms で行ったり来たり）は uneven', () => {
    const { chips, tempo } = setup(120, 64);
    const r = analyzeOffset(chips, fakeHits(chips, (t) => 0.03 * Math.sin((t / 128) * 2 * Math.PI * 1.5), 9), constantBpm(tempo));
    expect(r.verdict).toBe('uneven');
    expect(r.hi - r.lo).toBeGreaterThan(0.025);
  });

  it('BPM が変わる譜面では BPM は見立てない', () => {
    const { chips } = setup(73, 60);
    const r = analyzeOffset(chips, fakeHits(chips, (t) => t * (73 / 72.95 - 1), 5), null);
    expect(r.bpmFit).toBeNull();
    expect(r.verdict).toBe('uneven');
  });

  it('照らし合わせられるチップが少なければ few', () => {
    const { chips, tempo } = setup(120, 1);
    const r = analyzeOffset(chips.slice(0, 10), fakeHits(chips, () => 0.02), constantBpm(tempo));
    expect(r.verdict).toBe('few');
  });

  it('原曲と関係ない打点だけなら few', () => {
    const { chips, tempo } = setup(120, 32);
    const r0 = rng(4);
    const hits = Object.fromEntries(DRUM_CLASSES.map((c) => [c, Array.from({ length: 80 }, () => ({ t: Math.round(r0() * 64 * 100) / 100 })).sort((a, b) => a.t - b.t)])) as unknown as HitsByClass;
    const r = analyzeOffset(chips, hits, constantBpm(tempo));
    expect(r.verdict).toBe('few');
  });

  it('見えている範囲のずれ', () => {
    const { chips, tempo } = setup(73, 90);
    const r = analyzeOffset(chips, fakeHits(chips, (t) => t * (73 / 72.95 - 1), 5), constantBpm(tempo));
    const early = localOffset(r, 0, 10)!;
    const late = localOffset(r, 250, 260)!;
    expect(early).toBeLessThan(0.01);
    expect(late).toBeGreaterThan(0.15);
    expect(localOffset(r, 1000, 1010)).toBeNull();
  });

  it('BPM は短い桁で丸める', () => {
    expect(roundFitBpm(72.9502, 300)).toBe(72.95);
    expect(roundFitBpm(120.0003, 400)).toBe(120);
    expect(roundFitBpm(72.9461, 300)).toBe(72.946);
  });
});

describe('開始位置を直す（BGM を動かす）', () => {
  it('BGM を前へ動かすと、チップの原曲の時刻がその分だけ後ろへ', () => {
    // 120BPM（1小節2秒）、BGM は 000 小節の 192/384（1秒）
    const doc = songDoc(120, 4, 8, { m: 0, n: 192 });
    const tempo = buildTempoMap(doc);
    const next = produce(doc, (d) => {
      const err = shiftBgm(d, tempo, 0.024);
      expect(err).not.toBeNull();
      expect(err!).toBeLessThan(2.7);
    });
    const bgm = next.chips.find((c) => c.ch === CH.BGM)!;
    const t2 = buildTempoMap(next);
    expect(t2.beatToSec(t2.beatOf(bgm.m, bgm.f))).toBeCloseTo(1 - 0.024, 2);
    // 小節の頭が原曲の 24ms 後ろに
    const before = chipTimes(doc, tempo, 1, 1e9)[0].t;
    const after = chipTimes(next, t2, t2.beatToSec(t2.beatOf(bgm.m, bgm.f)), 1e9)[0].t;
    expect(after - before).toBeCloseTo(0.024, 2);
  });

  it('譜面の頭より前には動かせない', () => {
    const doc = songDoc(120, 4);
    const tempo = buildTempoMap(doc);
    produce(doc, (d) => {
      expect(shiftBgm(d, tempo, 0.024)).toBeNull();
      expect(d.chips.find((c) => c.ch === CH.BGM)!.f).toEqual(frac(0));
    });
    // 後ろへは動かせる（小節をまたいで 384 分割に丸める）
    const next = produce(doc, (d) => {
      expect(shiftBgm(d, tempo, -2.5)).not.toBeNull();
    });
    const bgm = next.chips.find((c) => c.ch === CH.BGM)!;
    expect(bgm.m).toBe(1);
    expect(bgm.f).toEqual(frac(96, 384));
  });
});
