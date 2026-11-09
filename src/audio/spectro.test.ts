import { describe, expect, it } from 'vitest';
import { binFreq, computeSpectro, renderSpectro, spectroDb, spectroZones, specFreq, specPos, SPEC_BINS, SPEC_RATE, type SpectroData } from './spectro';
import { eightBeat, synth } from './testSignal';
import { SPEC_ZONES, zoneLut } from '../ui/specColors';

const SR = 44100;

/** 周波数の範囲 [fa, fb) の段の平均（そのフレームで） */
function zone(sp: SpectroData, f: number, fa: number, fb: number): number {
  let s = 0;
  let n = 0;
  for (let b = 0; b < sp.bins; b++) {
    const fc = binFreq(b, sp.bins, sp.fLo, sp.fHi);
    if (fc < fa || fc >= fb) continue;
    s += sp.data[f * sp.bins + b];
    n++;
  }
  return n ? s / n : 0;
}

/** 範囲のフレームで、帯の値がいちばん大きいフレーム */
function peakFrame(sp: SpectroData, f0: number, f1: number, fa: number, fb: number): { f: number; v: number } {
  let best = { f: f0, v: -1 };
  for (let f = f0; f <= f1; f++) {
    const v = zone(sp, f, fa, fb);
    if (v > best.v) best = { f, v };
  }
  return best;
}

/** 帯の値が初めて最大の半分を超えるフレーム（光り始め＝叩いた瞬間） */
function riseFrame(sp: SpectroData, f0: number, f1: number, fa: number, fb: number): number {
  const top = peakFrame(sp, f0, f1, fa, fb).v;
  for (let f = f0; f <= f1; f++) if (zone(sp, f, fa, fb) >= top / 2) return f;
  return -1;
}

function noiseBurst(x: Float32Array, t: number, len: number, amp: number, seed = 1) {
  let s = seed;
  const start = Math.round(t * SR);
  const n = Math.round(len * SR);
  let prev = 0;
  for (let i = 0; i < n && start + i < x.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const w = s / 4294967296 - 0.5;
    // 高い音だけ（差分で低域を落とす）
    x[start + i] += (w - prev) * amp * Math.exp(-i / (0.02 * SR));
    prev = w;
  }
}

describe('ドラム向けのスペクトル', () => {
  it('周波数と列の位置は行き来できる', () => {
    for (const f of [30, 100, 1000, 5000, 16000]) expect(specFreq(specPos(f))).toBeCloseTo(f, 6);
    expect(specPos(30)).toBe(0);
    expect(specPos(16000)).toBeCloseTo(1, 9);
  });

  it('フレームの時刻は窓の真ん中（叩いた瞬間が早く見えない）', () => {
    // 1.000 秒ちょうどに短い高い音
    const x = new Float32Array(SR * 2);
    noiseBurst(x, 1.0, 0.08, 0.8);
    const r = spectroDb([x], SR);
    expect(r.frames).toBe(2 * SPEC_RATE);
    const at = 1.0 * SPEC_RATE;
    for (const mode of ['drum', 'attack', 'raw'] as const) {
      const sp = renderSpectro(r.db, r.frames, r.fHi, mode);
      // ハイハットの帯（5kHz〜）の光り始めは 1.000 秒の前後 10ms 以内
      const f = riseFrame(sp, at - 40, at + 40, 5000, 20000);
      expect(Math.abs(f - at), mode).toBeLessThanOrEqual(2);
    }
  });

  it('キック・スネア・ハイハットがそれぞれの帯で光る', () => {
    const hits = eightBeat(120, 4);
    const x = synth(hits, SR, 9);
    const sp = computeSpectro([x], SR, 'drum');
    const at = (t: number) => Math.round(t * SPEC_RATE);
    const kicks = hits.filter((h) => h.kind === 'kick');
    const hats = hits.filter((h) => h.kind === 'hat' && !hits.some((o) => o.kind !== 'hat' && Math.abs(o.t - h.t) < 0.01));
    // キックの時刻は低い帯が、ハイハットだけの時刻より明るい
    const kickLow = kicks.map((h) => peakFrame(sp, at(h.t) - 2, at(h.t) + 8, 30, 120).v);
    const hatLow = hats.map((h) => peakFrame(sp, at(h.t) - 2, at(h.t) + 8, 30, 120).v);
    expect(Math.min(...kickLow)).toBeGreaterThan(Math.max(...hatLow));
    // ハイハットの時刻は高い帯が光る
    for (const h of hats) expect(peakFrame(sp, at(h.t) - 2, at(h.t) + 6, 5000, 20000).v).toBeGreaterThan(40);
  });

  it('ドラム強調では伸びる音（ずっと鳴っている音）が消え、そのままでは見える', () => {
    const x = new Float32Array(SR * 4);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    noiseBurst(x, 2.0, 0.08, 0.8);
    const r = spectroDb([x], SR);
    const raw = renderSpectro(r.db, r.frames, r.fHi, 'raw');
    const drum = renderSpectro(r.db, r.frames, r.fHi, 'drum');
    let sumRaw = 0;
    let sumDrum = 0;
    let n = 0;
    for (let f = Math.round(0.5 * SPEC_RATE); f < Math.round(1.5 * SPEC_RATE); f++) {
      sumRaw += zone(raw, f, 400, 480);
      sumDrum += zone(drum, f, 400, 480);
      n++;
    }
    expect(sumRaw / n).toBeGreaterThan(150);
    expect(sumDrum / n).toBeLessThan(20);
    // 叩いた音は残る
    expect(peakFrame(drum, 395, 410, 5000, 20000).v).toBeGreaterThan(80);
  });

  it('色の表は段ごとに帯の色、明るさで強さ', () => {
    const lut = zoneLut(SPEC_BINS);
    expect(lut.length).toBe(SPEC_BINS * 256 * 4);
    // 値 0 は背景、255 は明るい
    const lum = (b: number, v: number) => lut[(b * 256 + v) * 4] + lut[(b * 256 + v) * 4 + 1] + lut[(b * 256 + v) * 4 + 2];
    expect(lum(0, 255)).toBeGreaterThan(lum(0, 0) + 300);
    // 明るさを上げると同じ値でも明るい
    const bright = zoneLut(SPEC_BINS, undefined, undefined, { gain: 2 });
    expect(bright[(10 * 256 + 60) * 4 + 1]).toBeGreaterThan(lut[(10 * 256 + 60) * 4 + 1]);
    expect(SPEC_ZONES.map((z) => z.listen)).toEqual(['low', 'mid', 'mid', 'mid', 'high']);
  });
});

describe('帯ごとの明るさ（AI に渡す）', () => {
  it('キックの帯はキックで、金物の帯はハイハットで明るく、ほかの所は暗い', () => {
    const hits = eightBeat(120, 4);
    const sp = computeSpectro([synth(hits, SR, 9)], SR, 'drum');
    const z = spectroZones(sp, [
      { from: 30, to: 120 },
      { from: 5000, to: 20000 },
    ]);
    expect(z.frames).toBe(sp.frames);
    expect(z.data.length).toBe(sp.frames * 2);
    // 打った時刻の前後（-20ms〜+40ms）でいちばん明るい所
    const at = (t: number, k: number) => {
      const f0 = Math.round(t * SPEC_RATE);
      let mx = 0;
      for (let f = f0 - 4; f <= f0 + 8; f++) mx = Math.max(mx, z.data[f * 2 + k]);
      return mx;
    };
    const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / a.length;
    const kicks = hits.filter((h) => h.kind === 'kick');
    const snares = hits.filter((h) => h.kind === 'snare');
    const hats = hits.filter((h) => h.kind === 'hat');
    expect(mean(kicks.map((h) => at(h.t, 0)))).toBeGreaterThan(200);
    expect(mean(snares.map((h) => at(h.t, 0)))).toBeLessThan(160);
    expect(mean(hats.map((h) => at(h.t, 1)))).toBeGreaterThan(180);
    // 8分のハイハットのあいだ（16分の裏）は暗い
    expect(mean(hats.map((h) => at(h.t + 0.125, 1)))).toBeLessThan(60);
  });
});
