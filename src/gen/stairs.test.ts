// 難易度の段階（gen/stairs）：下の難易度は、小節ごとにも上の難易度より濃くしない
import { describe, expect, it } from 'vitest';
import { setLang } from '../i18n';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { DEFAULT_KEEP, simplify, type ChipFate, type SectionPlan } from './simplify';
import { rungOf } from './reduce';
import { alignPlan, chartProfile, clampRange, fillHabit, keptIds, matchIds, measureCounts, measureList, profileLine, stairCheck, stepRange } from './stairs';

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });
const docOf = (chips: ReturnType<typeof chip>[]): DtxDoc => ({ ...emptyDoc(), fields: { BPM: '120' }, chips, nextId: 10000 });

/** 8ビート：HH 8分、BD 1・3拍、SD 2・4拍。4小節目ごとに後半2拍がタムのフィル */
function song(measures = 8): DtxDoc {
  const chips = [];
  let id = 1;
  for (let m = 0; m < measures; m++) {
    const fill = m % 4 === 3;
    for (let k = 0; k < 8; k++) {
      if (fill && k >= 4) {
        chips.push(chip(id++, k < 6 ? CH.HT : CH.FT, m, k, 8));
        continue;
      }
      chips.push(chip(id++, CH.HHC, m, k, 8));
      if (k === 0 || k === 4) chips.push(chip(id++, CH.BD, m, k, 8));
      if (k === 2 || k === 6) chips.push(chip(id++, CH.SD, m, k, 8));
    }
  }
  return docOf(chips);
}

/** 元の譜面から、条件に合うチップを除いた譜面（チップの id はそのまま） */
const without = (doc: DtxDoc, drop: (c: DtxDoc['chips'][number]) => boolean): DtxDoc => ({ ...doc, chips: doc.chips.filter((c) => !drop(c)) });

describe('残した音・既存の譜面の音を合わせる', () => {
  it('残した音は、レーンを移したものも含む', () => {
    const fate = new Map<number, ChipFate>([
      [1, { kind: 'kept' }],
      [2, { kind: 'removed' }],
      [3, { kind: 'moved', ch: CH.HHC }],
    ]);
    expect([...keptIds(fate)].sort()).toEqual([1, 3]);
  });

  it('既存の譜面の音は、同じ時刻・同じ楽器の元の音に合わせる（左バスドラムはバスドラム、オープンとクローズのHHは同じ）', () => {
    const root = docOf([chip(1, CH.BD, 0, 0, 4), chip(2, CH.SD, 0, 1, 4), chip(3, CH.HHC, 0, 0, 4), chip(4, CH.HHO, 0, 2, 4)]);
    const chart = docOf([chip(51, CH.LBD, 0, 0, 4), chip(52, CH.HHC, 0, 2, 4), chip(53, CH.SD, 0, 1, 8)]);
    expect([...matchIds(root, chart)].sort()).toEqual([1, 4]);
  });
});

describe('小節ごとの段階の確かめ', () => {
  it('上の譜面よりノーツの多い小節、下の譜面より少ない小節を出す', () => {
    const hard = docOf([chip(1, CH.BD, 0, 0, 4), chip(2, CH.SD, 0, 1, 4), chip(3, CH.BD, 1, 0, 4)]);
    const easy = docOf([chip(1, CH.BD, 0, 0, 4), chip(3, CH.BD, 1, 0, 4), chip(4, CH.SD, 1, 1, 4)]);
    expect(measureCounts(easy)).toEqual(
      new Map([
        [0, 1],
        [1, 2],
      ]),
    );
    expect(stairCheck(easy, hard, null)).toEqual({ denser: [1], thinner: [] });
    expect(stairCheck(hard, null, easy)).toEqual({ denser: [], thinner: [1] });
    expect(stairCheck(hard, null, null)).toEqual({ denser: [], thinner: [] });
  });

  it('上の難易度に残した音だけで作れば、どの小節も上より濃くならない', () => {
    const root = song(16);
    // 上の難易度：A を静か（先にやさしく）にして、刻みを4分まで。下の難易度：それより手前の段で、A を山場（元に近く）に。食い違う方針でも
    const upper = simplify({ doc: root, rung: rungOf('time8', true) - 1, ease: 1, sections: [{ name: 'A', from: 0, to: 7, shift: 1 }, { name: 'B', from: 8, to: 15, shift: 0 }], keep: DEFAULT_KEEP });
    const lowerPlan: SectionPlan[] = [
      { name: 'A', from: 0, to: 7, shift: -1 },
      { name: 'B', from: 8, to: 15, shift: 0 },
    ];
    const free = simplify({ doc: root, rung: 4, ease: 2, sections: lowerPlan, keep: DEFAULT_KEEP });
    expect(stairCheck(free.doc, upper.doc).denser.length).toBeGreaterThan(0);
    const within = keptIds(upper.fate);
    const lower = simplify({ doc: root, rung: 4, ease: 2, sections: lowerPlan, keep: DEFAULT_KEEP, within });
    expect(stairCheck(lower.doc, upper.doc).denser).toEqual([]);
    for (const id of keptIds(lower.fate)) expect(within.has(id)).toBe(true);
  });

  it('下の難易度に残した音は、上の難易度でも残す（手直しより弱く、上に無い音の決まりより弱い）', () => {
    const root = song(8);
    const sections: SectionPlan[] = [{ name: 'A', from: 0, to: 7, shift: 0 }];
    const lower = simplify({ doc: root, rung: 4, sections, keep: DEFAULT_KEEP });
    const atLeast = keptIds(lower.fate);
    const upper = simplify({ doc: root, rung: rungOf('time24', true), sections, keep: DEFAULT_KEEP, atLeast });
    for (const id of atLeast) expect(keptIds(upper.fate).has(id)).toBe(true);
    expect(stairCheck(upper.doc, null, lower.doc).thinner).toEqual([]);
    // 上に無い音（within の外）は、下にあっても置かない
    const someId = [...atLeast][0];
    const capped = simplify({ doc: root, rung: rungOf('time24', true), sections, keep: DEFAULT_KEEP, atLeast, within: new Set([...atLeast].filter((x) => x !== someId)) });
    expect(keptIds(capped.fate).has(someId)).toBe(false);
    // 手で「削る」にした音は、下にあっても削る
    const dropped = simplify({ doc: root, rung: rungOf('time24', true), sections, keep: DEFAULT_KEEP, atLeast, overrides: new Map([[someId, 'drop' as const]]) });
    expect(keptIds(dropped.fate).has(someId)).toBe(false);
  });
});

describe('上の難易度の方針に合わせる', () => {
  it('上の難易度が静か（shift が +）にした区間は、こちらも静かにする。山場にした区間はこちらの判断のまま', () => {
    const mine: SectionPlan[] = [
      { name: 'A', from: 0, to: 7, shift: -1 },
      { name: 'B', from: 8, to: 15, shift: 1 },
      { name: 'C', from: 16, to: 23, shift: 0 },
    ];
    const upper: SectionPlan[] = [
      { name: 'A', from: 0, to: 7, shift: 1 },
      { name: 'B', from: 8, to: 15, shift: -1 },
      { name: 'C', from: 16, to: 23, shift: 1 },
    ];
    const out = alignPlan(mine, upper, 'EXTREME');
    expect(out.map((s) => s.shift)).toEqual([1, 1, 1]);
    expect(out.map((s) => s.alignedTo ?? null)).toEqual(['EXTREME', null, 'EXTREME']);
    expect(out.map((s) => s.ownShift ?? null)).toEqual([-1, null, 0]);
  });

  it('区間の分け方が違うときは、頭を含む上の区間に合わせる', () => {
    const out = alignPlan([{ name: 'B', from: 8, to: 11, shift: 0 }], [{ name: 'A', from: 0, to: 15, shift: 1 }], 'ADVANCED');
    expect(out[0]).toMatchObject({ shift: 1, alignedTo: 'ADVANCED' });
  });
});

describe('隣の難易度とのレベルのあいだ', () => {
  it('上より 0.3 下・下より 0.3 上。近すぎるときは真ん中', () => {
    const r = stepRange(6.7, 3.5);
    expect(r.min).toBeCloseTo(3.8);
    expect(r.max).toBeCloseTo(6.4);
    expect(stepRange(null, null)).toEqual({ min: 1, max: 9.99 });
    const tight = stepRange(5, 4.8);
    expect(tight.min).toBeCloseTo(4.9);
    expect(tight.max).toBeCloseTo(4.9);
  });

  it('目標の幅を隣とのあいだに収める（重ならなければ近い端）', () => {
    const step = { min: 3.8, max: 6.4 };
    expect(clampRange({ min: 5, max: 7 }, step)).toEqual({ min: 5, max: 6.4 });
    expect(clampRange({ min: 6.5, max: 7 }, step)).toEqual({ min: 6.4, max: 6.4 });
    expect(clampRange({ min: 1, max: 3 }, step)).toEqual({ min: 3.8, max: 3.8 });
  });
});

describe('AI に渡す、ほかの難易度の作り方', () => {
  const spans = [
    { name: 'A', from: 0, to: 3 },
    { name: 'B', from: 4, to: 7 },
  ];

  it('フィルの手前を薄くした譜面と、フィルを薄くした譜面を見分ける', () => {
    const root = song(8);
    // フィルは小節 3・7、その手前の小節は 2・6
    const preThin = without(root, (c) => c.m === 2 || c.m === 6);
    const p1 = chartProfile(root, preThin, spans);
    expect(p1.preFill).toBe(0);
    expect(p1.fill).toBe(1);
    expect(p1.groove).toBe(1);
    expect(p1.sections.map((s) => s.ratio)).toEqual([0.75, 0.75].map((x) => expect.closeTo(x, 1)));
    expect(fillHabit(p1)).toBe('フィルを残して、その手前の小節を薄くしている');

    const fillThin = without(root, (c) => c.ch === CH.HT || c.ch === CH.FT);
    const p2 = chartProfile(root, fillThin, spans);
    expect(p2.fill).toBe(0);
    expect(p2.preFill).toBe(1);
    expect(fillHabit(p2)).toBe('フィルを薄くして、ビートを残している');

    expect(fillHabit(chartProfile(root, root, spans))).toBe('フィルもビートも同じくらいに間引いている');
    // フィルの前の小節を残してフィルを薄くしているのも「ビートを残している」
    expect(fillHabit({ sections: [], fill: 0.28, preFill: 0.5, groove: 0.37 })).toBe('フィルを薄くして、ビートを残している');
  });

  it('1行の要約：区間ごとの割合と方針、フィルの前後、レベルと段', () => {
    const root = song(8);
    const preThin = without(root, (c) => c.m === 2 || c.m === 6);
    const line = profileLine({
      label: 'EXTREME',
      who: '作りたて・AI の方針',
      level: 6.7,
      profile: chartProfile(root, preThin, spans),
      plan: [
        { name: 'A', from: 0, to: 3, shift: 1 },
        { name: 'B', from: 4, to: 7, shift: 0 },
      ],
      rung: 5,
    });
    expect(line).toContain('EXTREME（作りたて・AI の方針・Lv6.70・全体の段 5）');
    expect(line).toContain('0〜3 ');
    expect(line).toContain('（+1 静か）');
    expect(line).toContain('フィルの前の小節 0%');
    expect(line).toContain('（フィルを残して、その手前の小節を薄くしている）');
  });

  it('小節の並びは3つまで書き、残りは数で', () => {
    setLang('ja', false);
    expect(measureList([1, 2, 3, 4, 5], String)).toBe('1・2・3 ほか2');
    setLang('en', false);
    expect(measureList([1, 2], String)).toBe('1, 2');
    expect(measureList([1, 2, 3, 4], String)).toBe('1, 2, 3 and 1 more');
    setLang('ja', false);
  });
});
