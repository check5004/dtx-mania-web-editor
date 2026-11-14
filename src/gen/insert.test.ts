// あいだに作る：決めたレベルの譜面を、曲の難易度のどこに作り、どの譜面を下へ移すか（楯さんの依頼 2026-11-14）。
import { describe, expect, it } from 'vitest';
import { defaultInsertLevel, insertPlan } from './insert';

describe('あいだに作る案', () => {
  it('ADVANCED 5.10・EXTREME 7.50・MASTER 8.40 で 6.5：5.10 を BASIC に移して、空いた ADVANCED に EXTREME から作る', () => {
    const p = insertPlan({ ADVANCED: 5.1, EXTREME: 7.5, MASTER: 8.4 }, 6.5);
    expect(p).toEqual({
      ok: true,
      make: 'ADVANCED',
      moves: [{ from: 'ADVANCED', to: 'BASIC' }],
      source: 'EXTREME',
      upper: { slot: 'EXTREME', level: 7.5 },
      lower: { slot: 'BASIC', level: 5.1 },
    });
  });

  it('あいだに空いた難易度があれば、移さずにそこへ作る（上の譜面に近ければ上の隣のすぐ下、下に近ければ下の隣のすぐ上）', () => {
    const levels = { BASIC: 2.0, MASTER: 8.4 };
    expect(insertPlan(levels, 7.0)).toMatchObject({ ok: true, make: 'EXTREME', moves: [], source: 'MASTER', lower: { slot: 'BASIC', level: 2.0 } });
    expect(insertPlan(levels, 3.0)).toMatchObject({ ok: true, make: 'ADVANCED', moves: [], source: 'MASTER' });
    // いちばん下の譜面より易しい：空いた BASIC にそのまま
    expect(insertPlan({ ADVANCED: 5.1, MASTER: 8.4 }, 4.0)).toMatchObject({ ok: true, make: 'BASIC', moves: [], source: 'ADVANCED', lower: null });
  });

  it('下の隣のすぐ下が埋まっていれば、空いた難易度に当たるまで下から順に移す', () => {
    const p = insertPlan({ ADVANCED: 5.1, EXTREME: 7.5, MASTER: 9.5 }, 8.5);
    expect(p).toMatchObject({
      ok: true,
      make: 'EXTREME',
      moves: [
        { from: 'ADVANCED', to: 'BASIC' },
        { from: 'EXTREME', to: 'ADVANCED' },
      ],
      source: 'MASTER',
      lower: { slot: 'ADVANCED', level: 7.5 },
    });
  });

  it('作れないとき：いちばん上の譜面に近すぎる・同じくらいの譜面がある・下に空きが無い・BASIC より易しい・レベルが分からない', () => {
    expect(insertPlan({ ADVANCED: 5.1, EXTREME: 7.5, MASTER: 8.4 }, 8.2)).toMatchObject({ ok: false, why: 'top', slot: 'MASTER' });
    expect(insertPlan({ ADVANCED: 5.1, EXTREME: 7.5, MASTER: 8.4 }, 5.3)).toMatchObject({ ok: false, why: 'near', slot: 'ADVANCED' });
    expect(insertPlan({ BASIC: 3.0, ADVANCED: 5.1, MASTER: 8.4 }, 4.0)).toMatchObject({ ok: false, why: 'full' });
    expect(insertPlan({ BASIC: 3.0, EXTREME: 7.5, MASTER: 8.4 }, 2.0)).toMatchObject({ ok: false, why: 'bottom', slot: 'BASIC' });
    expect(insertPlan({ ADVANCED: null, EXTREME: 7.5, MASTER: 8.4 }, 6.0)).toMatchObject({ ok: false, why: 'unknown', slot: 'ADVANCED' });
    expect(insertPlan({}, 6.0)).toMatchObject({ ok: false, why: 'empty' });
  });

  it('はじめのレベル：前に入れたレベル（作れるなら）、無ければいちばん広いあいだの真ん中', () => {
    const levels = { ADVANCED: 5.1, EXTREME: 7.5, MASTER: 8.4 };
    expect(defaultInsertLevel(levels, 6.5)).toBe(6.5);
    expect(defaultInsertLevel(levels, null)).toBe(6.3);
    // 前のレベルがこの曲では作れない（いちばん上より上）なら真ん中
    expect(defaultInsertLevel({ BASIC: 2.0, MASTER: 5.0 }, 6.5)).toBe(3.5);
  });
});
