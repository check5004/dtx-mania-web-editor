import { describe, expect, it } from 'vitest';
import { frac, type Frac } from '../dtx/fraction';
import { CH, emptyDoc, type Chip, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { beatsLabel, beatsOfMeasure, exactCells, fitCells, fitMeasureCells, locateInBeats, parseSteps } from './beatGrid';
import { decodeCandidates, measureGrid, measureLayout, onsetGrid } from './phrase';

let nextId = 1;
const chip = (ch: number, m: number, n: number, d: number): Chip => ({ id: nextId++, ch, m, f: frac(n, d), v: 1 });
function docWith(chips: Chip[], barLengths: Record<number, number> = {}): DtxDoc {
  const d = emptyDoc();
  d.fields = { BPM: '120' };
  d.chips = chips;
  d.barLengths = barLengths;
  d.nextId = nextId;
  return d;
}
const str = (fs: Frac[]) => fs.map((f) => `${f.n}/${f.d}`);

describe('拍の並び', () => {
  it('4/4 は4拍、7/8 は3拍と半分', () => {
    const t = buildTempoMap(docWith([], { 1: 0.875 }));
    expect(beatsOfMeasure(t, 0).beats).toHaveLength(4);
    const b = beatsOfMeasure(t, 1);
    expect(b.beats).toHaveLength(4);
    expect(b.beats[3].dur).toEqual(frac(1, 2));
    expect(beatsLabel(b.beats)).toBe('3拍と1/2拍（最後の拍が短い）');
  });

  it('拍の頭の少し前の打点はその拍の頭の側', () => {
    const { beats } = beatsOfMeasure(buildTempoMap(docWith([])), 0);
    expect(locateInBeats(beats, 0.97)).toMatchObject({ i: 1 });
    expect(locateInBeats(beats, 0.875)).toMatchObject({ i: 0 });
    expect(locateInBeats(beats, 3.99)).toBeNull();
  });
});

describe('拍の細かさ', () => {
  it('チップがちょうど乗るいちばん粗い細かさ', () => {
    const one = frac(1);
    expect(exactCells(one, [frac(0), frac(1, 2)])).toBe(4);
    expect(exactCells(one, [frac(0), frac(1, 3), frac(2, 3)])).toBe(3);
    expect(exactCells(one, [frac(1, 6)])).toBe(6);
    expect(exactCells(one, [frac(1, 8)])).toBe(8);
    expect(exactCells(one, [frac(1, 4), frac(1, 3)])).toBe(12);
    expect(exactCells(one, [frac(1, 5)])).toBeNull();
  });

  it('原曲の打点の時刻から、16分・3連・32分を聞き分ける（少しずれていても）', () => {
    const one = frac(1);
    const spq = 0.4; // 150 BPM
    const at = (ps: number[], jitter = 0.008) => ps.map((p, i) => ({ p: p + ((i % 2 ? 1 : -1) * jitter) / spq, s: 0.8 }));
    expect(fitCells(one, at([0, 0.25, 0.5, 0.75]), spq)).toBe(4);
    expect(fitCells(one, at([0, 1 / 3, 2 / 3]), spq)).toBe(3);
    expect(fitCells(one, at([0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]), spq)).toBe(6);
    expect(fitCells(one, at([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]), spq)).toBe(8);
    // 拍の頭だけなら16分のまま
    expect(fitCells(one, at([0]), spq)).toBe(4);
    expect(fitCells(one, [], spq)).toBe(4);
  });
});

describe('小節でまとめて見る拍の細かさ', () => {
  const { beats } = beatsOfMeasure(buildTempoMap(docWith([])), 0);
  const spq = 0.4;
  it('外れた打点が1つだけの拍は16分のまま（時刻のぶれで3連にしない）', () => {
    const per = [[{ p: 0, s: 0.9 }], [{ p: 0, s: 0.9 }, { p: 0.17, s: 0.9 }], [{ p: 0, s: 0.9 }], [{ p: 0, s: 0.9 }]];
    expect(fitMeasureCells(beats, per, spq)).toEqual([4, 4, 4, 4]);
  });
  it('拍ごとに1つずつ3連に外れる（シャッフル）なら3連', () => {
    const per = beats.map(() => [
      { p: 0, s: 0.9 },
      { p: 2 / 3, s: 0.8 },
    ]);
    expect(fitMeasureCells(beats, per, spq)).toEqual([3, 3, 3, 3]);
  });
  it('3連のフィルの拍だけ3連', () => {
    const tri = [0, 1 / 3, 2 / 3].map((p) => ({ p, s: 0.8 }));
    const per = [[{ p: 0, s: 0.9 }], [{ p: 0, s: 0.9 }, { p: 0.5, s: 0.9 }], tri, tri];
    expect(fitMeasureCells(beats, per, spq)).toEqual([4, 4, 3, 3]);
  });
});

describe('格子の読み書き', () => {
  it('3連と32分のチップを、その拍だけ細かくして書く', () => {
    const d = docWith([
      chip(CH.BD, 0, 0, 1),
      chip(CH.SD, 0, 1, 4),
      // 3拍目に8分3連
      chip(CH.SD, 0, 2, 4),
      chip(CH.SD, 0, 2 * 3 + 1, 12),
      chip(CH.SD, 0, 2 * 3 + 2, 12),
      // 4拍目に32分
      chip(CH.HT, 0, 3 * 8 + 1, 32),
      chip(CH.HT, 0, 3 * 8 + 3, 32),
    ]);
    const g = measureGrid(d, buildTempoMap(d), 0);
    expect(g.lines).toEqual(['SD: ----|x---|xxx|--------', 'HT: ----|----|---|-x-x----', 'BD: x---|----|---|--------']);
    expect(g.rounded).toBe(false);
  });

  it('拍ごとの行を位置にする。| が無い行は小節の等分として読む', () => {
    const { beats, total } = beatsOfMeasure(buildTempoMap(docWith([])), 0);
    expect(str(parseSteps('x---|----|xxx|xxxxxx', beats, total))).toEqual(['0/1', '1/2', '7/12', '2/3', '3/4', '19/24', '5/6', '7/8', '11/12', '23/24']);
    expect(str(parseSteps('x---x---x---x---', beats, total))).toEqual(['0/1', '1/4', '1/2', '3/4']);
    expect(str(parseSteps('x--x--x--x--', beats, total))).toEqual(['0/1', '1/4', '1/2', '3/4']);
    // 拍の数と合わない区切りは、全体の等分として読む
    expect(str(parseSteps('x-|x-', beats, total))).toEqual(['0/1', '1/2']);
    // 前後の余分な | は気にしない
    expect(str(parseSteps('|x---|----|----|----|', beats, total))).toEqual(['0/1']);
  });

  it('AI の答えの3連をそのままチップにする', () => {
    const d = docWith([]);
    const c = decodeCandidates(
      { candidates: [{ name: '3連フィル', reason: '', measures: [{ index: 0, lanes: [{ lane: 'SD', steps: 'x---|x---|xxx|xxx' }, { lane: 'BD', steps: 'x---|----|---|---' }] }] }] },
      { from: 2, to: 2 },
      buildTempoMap(d),
    );
    const sd = c[0].notes.filter((n) => n.ch === CH.SD).map((n) => `${n.f.n}/${n.f.d}`);
    expect(sd).toEqual(['0/1', '1/4', '1/2', '7/12', '2/3', '3/4', '5/6', '11/12']);
  });

  it('生成する小節は、原曲の打点の時刻から拍の細かさを選び、打点もその格子で書く', () => {
    const d = docWith([]);
    const t = buildTempoMap(d);
    // 120 BPM：1拍 0.5秒。小節 1（2秒から）の3拍目に8分3連のスネア、ほかは16分のハイハット
    const sd = [0, 1 / 3, 2 / 3].map((p) => ({ t: 2 + (2 + p) * 0.5, s: 0.9 }));
    const hh = [0, 0.5, 1, 1.5, 3, 3.5].map((q) => ({ t: 2 + q * 0.5, s: 0.8 }));
    const onsets = { BD: [], SD: sd, TT: [], HH: hh, CY: [] };
    const lay = measureLayout(d, t, 1, { onsets, offsetSec: 0, fit: true });
    expect(lay.cells).toEqual([4, 4, 3, 4]);
    const rows = onsetGrid(onsets, t, 1, 0, lay);
    expect(rows).toContain('SD: 0000|0000|888|0000');
    expect(rows).toContain('HH: 7070|7070|000|7070');
  });
});
