import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type Chip, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { draftFromHits, learnStyle, styleLines, type DraftHit } from './draft';

// BPM 120・4/4：1小節 2秒、16分 0.125秒
const SEC16 = 0.125;
let nextId = 1;
const chip = (ch: number, m: number, step: number): Chip => ({ id: nextId++, ch, m, f: frac(step, 16), v: 1 });
const hit = (cls: DraftHit['cls'], m: number, step: number, dt = 0): DraftHit => ({ cls, t: m * 2 + step * SEC16 + dt, s: 0.9 });

function docWith(chips: Chip[]): DtxDoc {
  const d = emptyDoc();
  d.fields = { BPM: '120' };
  d.chips = chips;
  d.nextId = nextId;
  return d;
}

/** 作者の書き方：ライドの4分・左ペダルの裏・HHは使わない・クラッシュは小節の頭に1つ */
function rideSong(target: number): DtxDoc {
  const chips: Chip[] = [];
  for (let m = 0; m <= 8; m++) {
    if (m === target) continue;
    for (const s of [0, 4, 8, 12]) chips.push(chip(CH.RD, m, s), chip(CH.BD, m, s));
    for (const s of [2, 6, 10, 14]) chips.push(chip(CH.LP, m, s));
    for (const s of [4, 12]) chips.push(chip(CH.SD, m, s));
    if (m % 4 === 0) chips.push(chip(CH.CY, m, 0));
  }
  return docWith(chips);
}

const at = (notes: { ch: number; f: { n: number; d: number } }[], ch: number) =>
  notes
    .filter((n) => n.ch === ch)
    .map((n) => (n.f.n / n.f.d) * 16)
    .sort((a, b) => a - b);

describe('learnStyle', () => {
  it('刻みと単発を分けて数え、範囲の中は見ない', () => {
    const doc = rideSong(4);
    doc.chips.push(chip(CH.HHC, 4, 0));
    const st = learnStyle(doc, buildTempoMap(doc), 4, 4);
    expect([...st.pattern.CY.keys()]).toEqual([CH.RD]);
    expect(st.accent.CY.get(CH.CY)).toBeGreaterThan(0);
    expect(st.pattern.HH.get(CH.LP)).toBeGreaterThan(0);
    // 範囲の中の HHC は数えない
    expect(st.pattern.HH.has(CH.HHC) || st.accent.HH.has(CH.HHC)).toBe(false);
    expect(st.hhAt.get(2)?.get(CH.LP)).toBeGreaterThan(0);
  });

  it('要約にレーンの割合が入る', () => {
    const doc = rideSong(4);
    const lines = styleLines(learnStyle(doc, buildTempoMap(doc), 4, 4));
    expect(lines.some((l) => l.startsWith('シンバル類の刻み') && l.includes('RD（ライド） 100%'))).toBe(true);
    expect(lines.some((l) => l.startsWith('ハイハット類の刻み') && l.includes('LP（左ペダル） 100%'))).toBe(true);
  });
});

describe('draftFromHits', () => {
  const doc = rideSong(4);
  const tempo = buildTempoMap(doc);
  const style = learnStyle(doc, tempo, 4, 4);

  it('シンバルの刻みは作者が刻みに使うレーン（ライド）、1つだけなら単発のレーン（クラッシュ）', () => {
    const many = draftFromHits([0, 2, 4, 6, 8, 10, 12, 14].map((s) => hit('CY', 4, s)), tempo, 4, 4, style);
    expect(at(many, CH.RD)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    const one = draftFromHits([hit('CY', 4, 0)], tempo, 4, 4, style);
    expect(at(one, CH.CY)).toEqual([0]);
  });

  it('ハイハットは、その位置で作者が使うもの（ここでは左ペダル）', () => {
    const notes = draftFromHits([hit('HH', 4, 2), hit('HH', 4, 6)], tempo, 4, 4, style);
    expect(at(notes, CH.LP)).toEqual([2, 6]);
  });

  it('ハイハットの開け閉めは位置ごと', () => {
    const chips: Chip[] = [];
    for (const m of [0, 1, 2, 3, 5, 6]) for (const s of [0, 2, 4, 6, 8, 10, 12, 14]) chips.push(chip(s === 14 ? CH.HHO : CH.HHC, m, s));
    const d = docWith(chips);
    const t = buildTempoMap(d);
    const notes = draftFromHits([0, 2, 4, 6, 8, 10, 12, 14].map((s) => hit('HH', 4, s)), t, 4, 4, learnStyle(d, t, 4, 4));
    expect(at(notes, CH.HHO)).toEqual([14]);
    expect(at(notes, CH.HHC)).toEqual([0, 2, 4, 6, 8, 10, 12]);
  });

  it('タムのフィルは時間の順に高い方から', () => {
    const notes = draftFromHits([hit('TT', 4, 12), hit('TT', 4, 13), hit('TT', 4, 14)], tempo, 4, 4, style);
    expect(at(notes, CH.HT)).toEqual([12]);
    expect(at(notes, CH.LT)).toEqual([13]);
    expect(at(notes, CH.FT)).toEqual([14]);
  });

  it('小節の頭の少し前の打点は頭に寄せ、範囲の外は入れない', () => {
    const notes = draftFromHits([hit('BD', 4, 0, -0.03), hit('BD', 5, 0), hit('SD', 3, 15)], tempo, 4, 4, style);
    expect(notes.map((n) => [n.ch, n.m, (n.f.n / n.f.d) * 16])).toEqual([[CH.BD, 4, 0]]);
  });

  it('前の小節の最後の拍から頭に寄る打点も頭に置き、範囲の次の小節の頭に寄るものは入れない', () => {
    // 40ms 早い（拍の頭の前の幅より外なので、前の小節の最後の拍で丸めて頭に寄る）
    const notes = draftFromHits([hit('SD', 4, 0, -0.04), hit('BD', 5, 0, -0.04)], tempo, 4, 4, style);
    expect(notes.map((n) => [n.ch, n.m, (n.f.n / n.f.d) * 16])).toEqual([[CH.SD, 4, 0]]);
  });

  // 小節の頭からの位置 q（4分音符の数）の打点
  const hitQ = (cls: DraftHit['cls'], m: number, q: number): DraftHit => ({ cls, t: m * 2 + q * 0.5, s: 0.9 });
  const pos = (notes: { m: number; f: { n: number; d: number } }[]) => notes.map((n) => `${n.f.n}/${n.f.d}`).sort();

  it('3連に聞こえる拍は3連の位置に置く（グリッドの設定に関係なく）', () => {
    const notes = draftFromHits([hitQ('TT', 4, 2), hitQ('TT', 4, 2 + 1 / 3), hitQ('TT', 4, 2 + 2 / 3), hitQ('BD', 4, 3)], tempo, 4, 4, style);
    expect(pos(notes.filter((n) => n.ch === CH.HT || n.ch === CH.LT || n.ch === CH.FT))).toEqual(['1/2', '2/3', '7/12']);
    expect(at(notes, CH.HT)).toEqual([8]);
    expect(at(notes, CH.BD)).toEqual([12]);
  });

  it('3連寄りの打点が1つだけなら16分に置く（時刻のぶれで3連にしない）', () => {
    const notes = draftFromHits([hitQ('SD', 4, 1.32), hitQ('BD', 4, 0)], tempo, 4, 4, style);
    expect(at(notes, CH.SD)).toEqual([5]);
  });

  it('32分が続く拍は32分の位置に置く', () => {
    const notes = draftFromHits([0, 1, 2, 3, 4, 5, 6, 7].map((k) => hitQ('SD', 4, 3 + k / 8)), tempo, 4, 4, style);
    expect(at(notes, CH.SD)).toEqual([12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5]);
  });
});
