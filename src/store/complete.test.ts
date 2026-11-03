import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { addedMeasures, predictAt } from './complete';

function groove(doc: DtxDoc, m: number) {
  for (let i = 0; i < 8; i++) doc.chips.push({ id: doc.nextId++, ch: CH.HHC, m, f: frac(i, 8), v: 1 });
  doc.chips.push({ id: doc.nextId++, ch: CH.BD, m, f: frac(0, 4), v: 2 }, { id: doc.nextId++, ch: CH.SD, m, f: frac(1, 4), v: 3 });
}

function docOf(measures: number[]): DtxDoc {
  const doc = emptyDoc();
  doc.fields['BPM'] = '120';
  for (const m of measures) groove(doc, m);
  return doc;
}

describe('TAB補完の出し方', () => {
  it('チップを足した小節の範囲を見つける。消しただけなら removed、ドラムが変わらなければ null', () => {
    const a = docOf([1, 2]);
    const b = docOf([1, 2, 3, 5]);
    expect(addedMeasures(a, b)).toEqual({ min: 3, max: 5 });
    expect(addedMeasures(b, a)).toBe('removed');
    // WAV（強さ）だけ変えたときは変わっていない
    const c = structuredClone(a);
    c.chips[0].v = 9;
    expect(addedMeasures(a, c)).toBeNull();
    // 1つ動かした（消して足した）
    const d = structuredClone(a);
    d.chips[0].f = frac(1, 16);
    expect(addedMeasures(a, d)).toEqual({ min: 1, max: 1 });
  });

  it('空いている小節だけに出す（打ってある小節の手前で止める）', () => {
    const doc = docOf([0, 1, 2, 3, 4, 5, 6, 7, 10]);
    const cands = predictAt(doc, 8, { ahead: 4, min: 0, minNext: 0, audio: null });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.from).toBe(8);
      expect(c.measures.length).toBeLessThanOrEqual(2);
    }
    // 予測を始める小節が打ってあれば出さない
    expect(predictAt(doc, 10, { ahead: 4, min: 0, minNext: 0, audio: null })).toEqual([]);
  });

  it('見込みが基準より低い候補は出さない', () => {
    const doc = docOf([0, 1, 2, 3, 4, 5, 6, 7]);
    const all = predictAt(doc, 8, { ahead: 4, min: 0, minNext: 0, audio: null });
    const top = all[0].score;
    expect(predictAt(doc, 8, { ahead: 4, min: top + 0.01, minNext: 0, audio: null })).toEqual([]);
    expect(predictAt(doc, 8, { ahead: 1, min: 0, minNext: 0, audio: null })[0].measures).toHaveLength(1);
  });
});
