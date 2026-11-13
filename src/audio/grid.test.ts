import { describe, expect, it } from 'vitest';
import { analyzeAudio } from './analysis';
import { computeFrameFeatures } from './features';
import { chordChange, firstDownbeat, guessBars, pickDownbeat } from './grid';
import { eightBeat, synth, type SynthHit } from './testSignal';

const SR = 22050;

/** 何秒ずれているか（周期 period で、いちばん近い所との差） */
function offBy(t: number, at: number, period: number): number {
  const r = (((t - at) / period) % 1 + 1) % 1;
  return Math.min(r, 1 - r) * period;
}

/** キック 1・3 拍目、スネア 2・4 拍目、ハイハット 8 分。crash3 なら 3 拍目にシンバル（1 拍目と取り違えさせる） */
function rock(bpm: number, bars: number, lead: number, crash3 = false): SynthHit[] {
  const beat = 60 / bpm;
  const hits: SynthHit[] = [];
  for (let b = 0; b < bars; b++) {
    const t0 = lead + b * 4 * beat;
    hits.push({ t: t0, kind: 'kick' }, { t: t0 + 2 * beat, kind: 'kick' });
    hits.push({ t: t0 + beat, kind: 'snare' }, { t: t0 + 3 * beat, kind: 'snare' });
    for (let k = 0; k < 8; k++) hits.push({ t: t0 + k * 0.5 * beat, kind: 'hat' });
    if (crash3) hits.push({ t: t0 + 2 * beat, kind: 'crash' });
  }
  return hits.sort((a, b) => a.t - b.t);
}

/** 1 小節ごとに変わる和音（C・F・G・Am）を足す */
function addChords(x: Float32Array, sr: number, bpm: number, bars: number, lead: number) {
  const bar = 240 / bpm;
  const chords = [
    [261.63, 329.63, 392.0],
    [349.23, 440.0, 523.25],
    [392.0, 493.88, 587.33],
    [440.0, 523.25, 659.25],
  ];
  for (let b = 0; b < bars; b++) {
    const a = Math.round((lead + b * bar) * sr);
    const n = Math.round(bar * sr);
    for (const f of chords[b % 4]) {
      for (let i = 0; i < n && a + i < x.length; i++) {
        const env = Math.min(1, i / 200, (n - i) / 200);
        x[a + i] += 0.08 * env * Math.sin((2 * Math.PI * f * i) / sr);
      }
    }
  }
}

describe('拍の位置と 1 小節目の頭', () => {
  it('8 ビートで BPM（倍・半分でなく）と 1 拍目を当てる', () => {
    const lead = 0.5;
    const data = analyzeAudio([synth(eightBeat(120, 14, lead), SR, 30)], SR);
    expect(data.tempo[0].bpm).toBeCloseTo(120, 0);
    expect(data.tempo[0].kind).toBe('best');
    const g = data.bars[0];
    expect(g.bpm).toBe(data.tempo[0].bpm);
    const first = firstDownbeat(g, data.start);
    expect(first).toBeGreaterThan(lead - 0.1);
    expect(offBy(first, lead, 2)).toBeLessThan(0.015);
  });

  it('曲が拍の途中から始まっても、拍の位置と 1 拍目を合わせる', () => {
    const lead = 0.83;
    const bpm = 100;
    const data = analyzeAudio([synth(eightBeat(bpm, 10, lead), SR, 28)], SR);
    expect(data.tempo[0].bpm).toBeCloseTo(bpm, 0);
    const g = data.bars[0];
    expect(offBy(g.beat, lead, 60 / bpm)).toBeLessThan(0.015);
    expect(offBy(firstDownbeat(g, data.start), lead, 240 / bpm)).toBeLessThan(0.015);
  });

  it('速い曲（172）を半分にしない', () => {
    const data = analyzeAudio([synth(eightBeat(172, 20, 0.3), SR, 30)], SR);
    expect(data.tempo[0].bpm).toBeCloseTo(172, 0);
    expect(data.tempo.some((c) => c.kind === 'half' && Math.abs(c.bpm - 86) < 0.5)).toBe(true);
  });

  it('ほかの BPM でも測り直せる（候補に無い BPM は 1 つだけ返す）', () => {
    const data = analyzeAudio([synth(eightBeat(120, 14, 0.5), SR, 30)], SR);
    const [g] = guessBars(data, [120]);
    expect(g.bpm).toBe(120);
    expect(g.fit).toHaveLength(4);
    expect(offBy(firstDownbeat(g, data.start), 0.5, 2)).toBeLessThan(0.015);
  });

  it('ドラムの形が 1 拍目と 3 拍目で迷うとき、和音の変わり目で決める', () => {
    const bpm = 120;
    const lead = 0.5;
    const bars = 14;
    const x = synth(rock(bpm, bars, lead, true), SR, 30);
    addChords(x, SR, bpm, bars, lead);
    const data = analyzeAudio([x], SR);
    const g = data.bars[0];
    expect(g.bpm).toBeCloseTo(bpm, 0);
    // ドラムだけだと、3 拍目のシンバルにつられて 3 拍目を 1 拍目にする
    expect(offBy(firstDownbeat(g, data.start), lead + 1, 2)).toBeLessThan(0.015);
    // 和音は 1 拍目で変わる
    const chords = chordChange(computeFrameFeatures([x], SR), g.bpm, g.beat, data.start, data.duration);
    const k = pickDownbeat(g.fit, chords);
    expect(offBy(firstDownbeat(g, data.start, k), lead, 2)).toBeLessThan(0.015);
  });
});

describe('1 拍目の選び方', () => {
  it('形が同じくらいなら和音の変わり目で、和音がわからなければ形で', () => {
    const fit = [10, 2, 10.1, 2];
    expect(pickDownbeat(fit)).toBe(2);
    expect(pickDownbeat(fit, [5, 1, 1, 1])).toBe(0);
    // 和音の変わり目がどこも同じなら形のまま
    expect(pickDownbeat(fit, [3, 3, 3, 3])).toBe(2);
  });

  it('形がはっきりちがえば、和音の変わり目が少し強くても形を取る', () => {
    expect(pickDownbeat([16, 5, 8, 5], [1, 1.2, 1.1, 1])).toBe(0);
  });

  it('和音の変わり目は 4 拍ごとに足す', () => {
    // 1 秒 10 フレーム、1 拍 0.5 秒。拍の位置 0.2 秒から 1 拍目（k=1）＝ 0.7 + 2n 秒で和音が変わる
    const rate = 10;
    const frames = 300;
    const chroma = new Float32Array(frames * 12);
    for (let f = 0; f < frames; f++) {
      const t = f / rate;
      const bar = Math.floor((t - 0.7) / 2);
      chroma[f * 12 + (((bar % 3) + 3) % 3) * 4] = 1;
    }
    const chg = chordChange({ rate, frames, offset: 0, chroma }, 120, 0.2, 0, 30);
    expect(chg.indexOf(Math.max(...chg))).toBe(1);
  });
});
