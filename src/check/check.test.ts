import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { estimateLevel, levelToField, migrateLevel } from './level';
import { findIssues } from './playability';

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });
const doc = (chips: ReturnType<typeof chip>[], bpm = 120): DtxDoc => ({ ...emptyDoc(), fields: { BPM: String(bpm) }, chips, nextId: 999 });

describe('無理な配置', () => {
  it('手が3本いる同時打ち', () => {
    const d = doc([chip(1, CH.HHC, 0), chip(2, CH.SD, 0), chip(3, CH.CY, 0), chip(4, CH.BD, 0)]);
    const is = findIssues(d, buildTempoMap(d));
    expect(is.map((i) => i.kind)).toEqual(['hands']);
    expect(is[0].ids.sort()).toEqual([1, 2, 3]);
  });
  it('左足で2つ同時', () => {
    const d = doc([chip(1, CH.LP, 0), chip(2, CH.LBD, 0), chip(3, CH.SD, 0)]);
    expect(findIssues(d, buildTempoMap(d)).map((i) => i.kind)).toEqual(['leftFoot']);
  });
  it('バスドラムの速すぎる連打はまとめて1つ', () => {
    // 120BPM の 32分 = 62.5ms
    const d = doc(Array.from({ length: 8 }, (_, i) => chip(i + 1, CH.BD, 0, i, 32)));
    const is = findIssues(d, buildTempoMap(d));
    expect(is).toHaveLength(1);
    expect(is[0].kind).toBe('fast');
    expect(is[0].ids).toHaveLength(8);
  });
  it('ふつうの8ビートは何も出ない', () => {
    const chips = [];
    let id = 1;
    for (let m = 0; m < 4; m++)
      for (let k = 0; k < 8; k++) {
        chips.push(chip(id++, CH.HHC, m, k, 8));
        if (k % 4 === 0) chips.push(chip(id++, CH.BD, m, k, 8));
        if (k % 4 === 2) chips.push(chip(id++, CH.SD, m, k, 8));
      }
    const d = doc(chips);
    expect(findIssues(d, buildTempoMap(d))).toEqual([]);
  });
});

describe('推定レベル', () => {
  const beat8 = (bars: number, bpm: number, sixteen = false) => {
    const chips = [];
    let id = 1;
    const div = sixteen ? 16 : 8;
    for (let m = 0; m < bars; m++)
      for (let k = 0; k < div; k++) {
        chips.push(chip(id++, CH.HHC, m, k, div));
        if (k % (div / 2) === 0) chips.push(chip(id++, CH.BD, m, k, div));
        if (k % (div / 2) === div / 4) chips.push(chip(id++, CH.SD, m, k, div));
      }
    return doc(chips, bpm);
  };
  it('密度が高いほど高い', () => {
    const easy = estimateLevel(beat8(16, 100), buildTempoMap(beat8(16, 100)))!;
    const hard = estimateLevel(beat8(16, 180, true), buildTempoMap(beat8(16, 180, true)))!;
    expect(easy.level).toBeLessThan(hard.level);
    expect(easy.level).toBeGreaterThanOrEqual(1);
    expect(hard.level).toBeLessThanOrEqual(9.99);
  });
  it('人の作った譜面の目盛りに合わせてある（平均5打/秒前後で Lv5 前後）', () => {
    // 16分のハイハットを抜いた8ビート（HH 8分・BD・SD）148BPM ≒ 平均6打/秒。手元の曲では ADVANCED（Lv5前後）がこの形
    const d = beat8(16, 148);
    const e = estimateLevel(d, buildTempoMap(d))!;
    expect(e.level).toBeGreaterThan(4.5);
    expect(e.level).toBeLessThan(6.5);
  });
  it('前の版の推定（ガイドラインに保存したもの）を今の式に直せる', () => {
    const d = beat8(16, 160, true);
    const e = estimateLevel(d, buildTempoMap(d))!;
    const eff = Math.max(1, 0.7 * e.avgNps + 0.3 * e.peakNps);
    const aux = e.level - (3.51 * Math.log(eff) - 0.93);
    const old = 3.1 * Math.log(eff) - 1.9 + aux;
    expect(migrateLevel(old, e.avgNps, e.peakNps)).toBeCloseTo(e.level, 1);
  });
  it('#DLEVEL の書き方', () => {
    expect(levelToField(6.65)).toBe('665');
  });
});
