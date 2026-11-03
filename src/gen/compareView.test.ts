import { describe, expect, it } from 'vitest';
import { chipHeight, COL_GAP, columnAt, compareGeom, firstAtOrAfter, GUTTER_W, labelEvery, layoutColumns, MAX_COL_W, MIN_COL_W, PAD_BOTTOM, PAD_TOP, pxToFit, stepIn } from './compareView';

describe('並べた譜面の列', () => {
  it('小節番号の列のあとに同じ幅で並べ、広すぎるときは上限で止める', () => {
    const lay = layoutColumns(1000, 4);
    expect(lay.cols).toHaveLength(4);
    const w = Math.floor((1000 - GUTTER_W - COL_GAP * 3) / 4);
    expect(lay.cols[0]).toEqual({ x: GUTTER_W, w, laneW: w / 10 });
    expect(lay.cols[3].x).toBe(GUTTER_W + 3 * (w + COL_GAP));
    expect(lay.width).toBeLessThanOrEqual(1000);
    // 元の譜面だけのときは横に間延びさせない
    const one = layoutColumns(1000, 1);
    expect(one.cols[0].w).toBe(MAX_COL_W);
    expect(one.width).toBe(GUTTER_W + MAX_COL_W);
    // 狭すぎるときは下限
    expect(layoutColumns(300, 4).cols[0].w).toBe(MIN_COL_W);
  });

  it('x がどの列か（小節番号の列は -1、列のあいだは null）', () => {
    const lay = layoutColumns(1000, 3);
    expect(columnAt(lay, 10)).toBe(-1);
    expect(columnAt(lay, lay.cols[0].x + 1)).toBe(0);
    expect(columnAt(lay, lay.cols[1].x + lay.cols[1].w - 1)).toBe(1);
    expect(columnAt(lay, lay.cols[0].x + lay.cols[0].w + 2)).toBeNull();
    expect(columnAt(lay, lay.width + 5)).toBeNull();
  });

  it('拍と高さの変換は下から上へ、往復で戻る', () => {
    const g = compareGeom(500, 8, 20);
    expect(g.beatToY(9)).toBeLessThan(g.beatToY(8));
    expect(g.yToBeat(g.beatToY(13.25))).toBeCloseTo(13.25, 9);
    expect(g.minBeat).toBeLessThan(8);
    expect(g.maxBeat).toBeCloseTo(8 + 490 / 20, 9);
  });

  it('聴く譜面を隣へ（端で止まる・無ければ先頭）', () => {
    const list = ['MASTER', 'EXTREME', 'BASIC'];
    expect(stepIn(list, 'MASTER', 1)).toBe('EXTREME');
    expect(stepIn(list, 'BASIC', 1)).toBe('BASIC');
    expect(stepIn(list, 'MASTER', -1)).toBe('MASTER');
    expect(stepIn(list, 'ADVANCED', 1)).toBe('MASTER');
    expect(stepIn([], 'MASTER', 1)).toBeNull();
  });

  it('小節番号は重ならない間隔で書く', () => {
    expect(labelEvery(100)).toBe(1);
    expect(labelEvery(10)).toBe(2);
    expect(labelEvery(5)).toBe(4);
    expect(labelEvery(1)).toBe(16);
  });

  it('見える範囲の最初のチップを二分探索で探す', () => {
    const list = [0, 1, 1, 2.5, 4].map((beat) => ({ beat }));
    expect(firstAtOrAfter(list, -1)).toBe(0);
    expect(firstAtOrAfter(list, 1)).toBe(1);
    expect(firstAtOrAfter(list, 1.1)).toBe(3);
    expect(firstAtOrAfter(list, 5)).toBe(5);
  });

  it('n 小節が収まる大きさ・チップの高さ', () => {
    expect(pxToFit(500, 32)).toBeCloseTo((500 - PAD_BOTTOM - PAD_TOP) / 32, 9);
    expect(pxToFit(10, 1000)).toBe(0.5);
    expect(chipHeight(100)).toBe(7);
    expect(chipHeight(2)).toBe(2);
  });
});
