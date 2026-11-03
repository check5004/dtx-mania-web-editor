import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { heardDrums } from '../assist/heard';
import { modelEvidence } from '../assist/evidence';
import { ADTOF, type DrumActivations } from './model';
import { drumHits, pickPeaks } from './peaks';

const N = ADTOF.classes.length;

/** frames フレームぶんの空の出力に、[フレーム, 種類, 高さ] の山を置く（山の前後も少し高くする） */
function acts(frames: number, peaks: [number, number, number][]): DrumActivations {
  const act = new Float32Array(frames * N);
  for (const [i, c, v] of peaks) {
    act[i * N + c] = Math.max(act[i * N + c], v);
    if (i > 0) act[(i - 1) * N + c] = Math.max(act[(i - 1) * N + c], v * 0.4);
    if (i + 1 < frames) act[(i + 1) * N + c] = Math.max(act[(i + 1) * N + c], v * 0.5);
  }
  return { model: ADTOF.id, fps: ADTOF.fps, frames, act };
}

describe('採譜の出力から打点を拾う', () => {
  it('閾値より高い山の頂上だけを拾い、時刻は フレーム÷100 秒', () => {
    const d = acts(300, [
      [50, 0, 0.9],
      [120, 0, 0.1], // 低い山は拾わない
      [200, 0, 0.6],
    ]);
    const p = pickPeaks(d.act, N, 0, d.fps, 0.22);
    expect(p.map((x) => x.t)).toEqual([0.5, 2.0]);
    expect(p[0].s).toBeCloseTo(0.9, 6);
  });

  it('0.02 秒以内に続いた山は最初の1つにまとめる', () => {
    const d = acts(100, [
      [40, 1, 0.8],
      [42, 1, 0.8],
    ]);
    expect(pickPeaks(d.act, N, 1, d.fps, 0.2).map((x) => x.t)).toEqual([0.4]);
  });

  it('感度を上げると閾値が下がり、小さな打点も拾う（種類ごと・時刻順）', () => {
    const d = acts(300, [
      [30, 0, 0.9],
      [60, 1, 0.9],
      [150, 0, 0.2], // 作者の閾値 0.22 より低い
    ]);
    expect(drumHits(d, 0.5).map((h) => [h.t, h.cls])).toEqual([
      [0.3, 'BD'],
      [0.6, 'SD'],
    ]);
    expect(drumHits(d, 1).map((h) => [h.t, h.cls])).toEqual([
      [0.3, 'BD'],
      [0.6, 'SD'],
      [1.5, 'BD'],
    ]);
  });
});

describe('採譜の打点で原曲と照合する', () => {
  it('バスドラム・スネア・タムは打点の有無で答え、ハイハット・シンバルは分からない', () => {
    const ev = modelEvidence([
      { t: 1, cls: 'BD' },
      { t: 2, cls: 'SD' },
      { t: 3, cls: 'HH' },
    ]);
    expect(ev.heard('BD', 1.03)).toBe(true);
    expect(ev.heard('BD', 2)).toBe(false);
    expect(ev.heard('SD', 2)).toBe(true);
    expect(ev.heard('TT', 2)).toBe(false);
    expect(ev.heard('HH', 3)).toBeNull();
    expect(ev.heard('CY', 3)).toBeNull();
  });
});

describe('聞こえるドラムと小節の譜面の合い方', () => {
  // BPM 120・4/4 なので1小節 2 秒。原曲の 0 秒が譜面の 0 秒
  const doc = emptyDoc();
  doc.fields['BPM'] = '120';
  const tempo = buildTempoMap(doc);
  const beat = [
    { ch: CH.BD, f: frac(0, 4) },
    { ch: CH.SD, f: frac(1, 4) },
    { ch: CH.BD, f: frac(2, 4) },
    { ch: CH.SD, f: frac(3, 4) },
    { ch: CH.HHC, f: frac(1, 8) },
  ];
  const hits = [0, 2, 4].flatMap((t0) => [
    { t: t0 + 0.0, cls: 'BD' as const },
    { t: t0 + 0.5, cls: 'SD' as const },
    { t: t0 + 1.02, cls: 'BD' as const },
    { t: t0 + 1.5, cls: 'SD' as const },
  ]);
  const heard = heardDrums(hits, tempo, 0, 6);

  it('同じ位置にあれば 1（ハイハットは数えない）', () => {
    expect(heard.agree(beat, 0)).toBe(1);
    expect(heard.agree(beat, 2)).toBe(1);
  });

  it('足りないチップ・余分なチップがあると下がる（F 値）', () => {
    expect(heard.agree(beat.slice(1), 1)).toBeCloseTo(6 / 7, 6);
    expect(heard.agree([...beat, { ch: CH.SD, f: frac(7, 8) }], 1)).toBeCloseTo(8 / 9, 6);
    expect(heard.agree([], 1)).toBe(0);
  });

  it('原曲の外の小節は分からない（null）', () => {
    expect(heard.agree(beat, 3)).toBeNull();
  });
});
