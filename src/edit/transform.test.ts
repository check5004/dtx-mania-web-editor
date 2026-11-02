import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { channelToLane, opMapLanes, opRelane, opSwapLanes } from './transform';

const chip = (id: number, ch: number, m: number, n = 0, d = 1, v = 1) => ({ id, ch, m, f: { n, d }, v });
const doc = (...chips: ReturnType<typeof chip>[]): DtxDoc => ({ ...emptyDoc(), chips, nextId: 100 });

describe('レーンを移す', () => {
  it('種類と2種目を保つ', () => {
    expect(channelToLane(CH.HHO, 9)).toBe(CH.RD);
    expect(channelToLane(CH.HHC + 0x20, 3)).toBe(CH.SD + 0x20);
    expect(channelToLane(CH.SD, 1, 'alt')).toBe(CH.HHO);
  });
  it('移した先のチップは上書き', () => {
    const d = produce(doc(chip(1, CH.SD, 0), chip(2, CH.HT, 0), chip(3, CH.SD, 0, 1, 2)), (x) => {
      expect(opRelane(x, new Set([1, 3]), 4)).toBe(2);
    });
    expect(d.chips.map((c) => [c.id, c.ch]).sort()).toEqual([
      [1, CH.HT],
      [3, CH.HT],
    ]);
  });
});

describe('入れ替えと反転', () => {
  it('小節の範囲だけ入れ替える', () => {
    const d = produce(doc(chip(1, CH.SD, 0), chip(2, CH.HT, 0, 1, 4), chip(3, CH.SD, 2)), (x) => {
      opSwapLanes(x, 3, 4, 0, 1);
    });
    expect(d.chips.find((c) => c.id === 1)!.ch).toBe(CH.HT);
    expect(d.chips.find((c) => c.id === 2)!.ch).toBe(CH.SD);
    expect(d.chips.find((c) => c.id === 3)!.ch).toBe(CH.SD);
  });
  it('左右反転は並びの逆', () => {
    const d = produce(doc(chip(1, CH.LC, 0), chip(2, CH.BD, 0)), (x) => {
      opMapLanes(x, new Set([1, 2]), (l) => 9 - l);
    });
    expect(d.chips.find((c) => c.id === 1)!.ch).toBe(CH.RD);
    expect(d.chips.find((c) => c.id === 2)!.ch).toBe(CH.HT);
  });
});
