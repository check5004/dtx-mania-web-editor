import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { effectiveBarLen, opDeleteMeasures, opInsertMeasures, shiftMeasure } from './measures';

const chip = (id: number, ch: number, m: number, n = 0, d = 1, v = 1) => ({ id, ch, m, f: { n, d }, v });

function doc(): DtxDoc {
  return { ...emptyDoc(), chips: [chip(1, CH.SD, 0), chip(2, CH.SD, 1), chip(3, CH.BD, 2, 1, 2), chip(4, CH.SD, 3)], barLengths: { 2: 0.75, 3: 1 }, nextId: 5 };
}

describe('小節の挿入', () => {
  it('後ろのチップと小節長がずれ、入れた小節は元の小節と同じ長さ', () => {
    const d = produce(doc(), (x) => {
      opInsertMeasures(x, 2, 1);
    });
    expect(d.chips.map((c) => c.m)).toEqual([0, 1, 3, 4]);
    expect(effectiveBarLen(d.barLengths, 2)).toBe(0.75);
    expect(effectiveBarLen(d.barLengths, 3)).toBe(0.75);
    expect(effectiveBarLen(d.barLengths, 4)).toBe(1);
    expect(effectiveBarLen(d.barLengths, 1)).toBe(1);
  });
  it('全体の長さは入れた小節ぶんだけ伸びる', () => {
    const before = buildTempoMap(doc());
    const d = produce(doc(), (x) => {
      opInsertMeasures(x, 1, 2);
    });
    const after = buildTempoMap(d);
    expect(after.measureStart(6) - before.measureStart(4)).toBeCloseTo(8);
  });
});

describe('小節の削除', () => {
  it('消した小節のチップは消え、後ろが詰まる', () => {
    const d = produce(doc(), (x) => {
      const r = opDeleteMeasures(x, 1, 1);
      expect(r.removed).toBe(1);
    });
    expect(d.chips.map((c) => [c.id, c.m])).toEqual([
      [1, 0],
      [3, 1],
      [4, 2],
    ]);
    expect(effectiveBarLen(d.barLengths, 1)).toBe(0.75);
    expect(effectiveBarLen(d.barLengths, 2)).toBe(1);
  });
  it('小節長が変わった小節を消しても、次の小節の長さは保つ', () => {
    const d = produce(doc(), (x) => {
      opDeleteMeasures(x, 2, 1);
    });
    expect(effectiveBarLen(d.barLengths, 2)).toBe(1);
    expect(effectiveBarLen(d.barLengths, 1)).toBe(1);
  });
  it('BPM変化と BGM は詰めたあとの小節の頭に残す', () => {
    const base = doc();
    base.chips.push(chip(10, CH.BPM_EX, 1, 1, 2, 3), chip(11, CH.BGM, 1, 1, 4, 1));
    const d = produce(base, (x) => {
      const r = opDeleteMeasures(x, 1, 1);
      expect(r.kept).toBe(2);
    });
    const bpm = d.chips.find((c) => c.id === 10)!;
    expect([bpm.m, bpm.f.n]).toEqual([1, 0]);
    expect(d.chips.find((c) => c.id === 11)!.m).toBe(1);
  });
});

describe('小節番号のずらし', () => {
  it('挿入と削除', () => {
    expect(shiftMeasure(5, 3, 2, 'insert')).toBe(7);
    expect(shiftMeasure(2, 3, 2, 'insert')).toBe(2);
    expect(shiftMeasure(4, 3, 2, 'delete')).toBeNull();
    expect(shiftMeasure(6, 3, 2, 'delete')).toBe(4);
  });
});
