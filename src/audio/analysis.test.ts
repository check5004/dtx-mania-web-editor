import { describe, expect, it } from 'vitest';
import { analyzeAudio, combinedOdf, downbeatPhase, pickOnsets, trackBeats, type Onset } from './analysis';
import { eightBeat, synth } from './testSignal';

const SR = 44100;

function near(onsets: Onset[], t: number, tol = 0.02) {
  return onsets.some((o) => Math.abs(o.t - t) <= tol);
}

describe('原曲の解析', () => {
  const hits = eightBeat(120, 12);
  const x = synth(hits, SR, 26);
  const data = analyzeAudio([x], SR);

  it('波形の山と長さ', () => {
    expect(data.duration).toBeCloseTo(26, 1);
    expect(data.peaks.length).toBe(Math.ceil(26 * data.peakRate));
    expect(Math.max(...data.peaks)).toBeCloseTo(1, 5);
  });

  it('低域でキック、中域でスネア、高域でハイハットを拾う', () => {
    const low = pickOnsets(data.odf.low, data.frameRate, 0.5);
    const mid = pickOnsets(data.odf.mid, data.frameRate, 0.5);
    const high = pickOnsets(data.odf.high, data.frameRate, 0.5);
    const kicks = hits.filter((h) => h.kind === 'kick');
    const snares = hits.filter((h) => h.kind === 'snare');
    const hats = hits.filter((h) => h.kind === 'hat');
    expect(kicks.filter((h) => near(low, h.t)).length).toBe(kicks.length);
    expect(snares.filter((h) => near(mid, h.t)).length).toBe(snares.length);
    expect(hats.filter((h) => near(high, h.t)).length).toBeGreaterThanOrEqual(hats.length * 0.85);
    // 低域はほぼキックだけ
    const lowFalse = low.filter((o) => !kicks.some((k) => Math.abs(k.t - o.t) < 0.03));
    expect(lowFalse.length).toBeLessThanOrEqual(2);
  });

  it('打点の時刻は 10ms 以内', () => {
    const low = pickOnsets(data.odf.low, data.frameRate, 0.5);
    for (const k of hits.filter((h) => h.kind === 'kick')) {
      const o = low.reduce((a, b) => (Math.abs(b.t - k.t) < Math.abs(a.t - k.t) ? b : a));
      expect(Math.abs(o.t - k.t)).toBeLessThan(0.01);
    }
  });

  it('感度を上げると打点が増える（下げると減る）', () => {
    const a = pickOnsets(data.odf.mid, data.frameRate, 0.1).length;
    const b = pickOnsets(data.odf.mid, data.frameRate, 0.9).length;
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('BPM を推定し、半分と倍も候補に出す', () => {
    expect(data.tempo.length).toBeGreaterThanOrEqual(2);
    const best = data.tempo[0];
    expect(best.kind).toBe('best');
    expect(best.bpm).toBeCloseTo(120, 0);
    expect(data.tempo.some((c) => c.kind === 'half' && Math.abs(c.bpm - 60) < 0.5)).toBe(true);
  });

  it('拍を追跡し、小節の頭を見つける', () => {
    const beats = trackBeats(combinedOdf(data.odf), data.frameRate, 120);
    expect(beats.length).toBeGreaterThan(40);
    for (let i = 1; i < beats.length; i++) expect(beats[i] - beats[i - 1]).toBeCloseTo(0.5, 1);
    // 最初の拍は 0.5 秒付近
    expect(Math.abs(beats[0] - 0.5)).toBeLessThan(0.03);
    const p = downbeatPhase(beats, data.odf, data.frameRate);
    // 小節の頭は 0.5 + 2k 秒
    const head = beats[p];
    const r = ((head - 0.5) / 2) % 1;
    expect(Math.min(r, 1 - r)).toBeLessThan(0.03);
  });
});

describe('テンポの違う曲', () => {
  it('172 BPM', () => {
    const x = synth(eightBeat(172, 16, 0.3), SR, 24);
    const d = analyzeAudio([x], SR);
    expect(d.tempo[0].bpm).toBeCloseTo(172, 0);
  });
});
