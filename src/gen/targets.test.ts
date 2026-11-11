import { describe, expect, it } from 'vitest';
import { aimOf, isAbove, MAX_DROP, slotOf, targetBands, type Slot } from './targets';
import type { Difficulty } from './simplify';

// 手元の曲（作者の4難易度がそろっている5曲と、MASTER だけの Calc）の登録レベルと、
// BASIC を作る元の譜面をいちばん易しい段まで間引いたときのレベル（登録の目盛り、2026-11-04 に測った値）。
// 曲のデータはリポジトリに入れないので、数だけを持つ。
// 作者の ADVANCED・BASIC は MASTER の 0.6・0.37 倍くらいだが、楯さんの方針（2026-11-11）で、作る難易度はそれより高くする
const SONGS: { name: string; human: [number, number | null, number | null, number | null]; floor: [number, number, number] }[] = [
  { name: 'Bless your breath (152 BPM)', human: [8.3, 7.8, 5.6, 2.7], floor: [3.56, 3.66, 3.21] },
  { name: 'Calc (173 BPM)', human: [7.6, null, null, null], floor: [3.5, 3.5, 3.5] },
  { name: 'Mela (138 BPM)', human: [7.6, 6.2, 4.5, 2.9], floor: [2.26, 2.2, 2.39] },
  { name: 'Mephisto (150 BPM)', human: [7.0, 5.6, 4.0, 2.6], floor: [3.08, 2.52, 2.47] },
  { name: 'Nani ga Warui (122 BPM)', human: [6.9, 5.8, 4.0, 2.4], floor: [2.57, 2.31, 2.1] },
  { name: 'Wasureteyaranai (184 BPM)', human: [7.5, 6.3, 4.6, 3.3], floor: [3.86, 3.62, 3.14] },
];
const ORDER: Slot[] = ['MASTER', 'EXTREME', 'ADVANCED', 'BASIC'];

const ALL: Difficulty[] = ['EXTREME', 'ADVANCED', 'BASIC'];

describe('目標の幅', () => {
  it('難しい曲は下の難易度も引っ張られて高い（楯さんの例: MASTER 8.6 → 7.3・6.8・6.4）', () => {
    const b = targetBands({ known: { MASTER: 8.6 }, make: ALL, floor: null });
    expect(b.EXTREME!.center).toBeCloseTo(7.3, 1);
    expect(b.ADVANCED!.center).toBeCloseTo(6.8, 1);
    expect(b.BASIC!.center).toBeCloseTo(6.4, 1);
    // 比だけ（8.6 × 0.60・0.37 = 5.16・3.18）から引き上げた分と、その元
    expect(b.ADVANCED!).toMatchObject({ pulled: 1.64, pulledFrom: 'MASTER', raised: 0 });
    expect(b.BASIC!).toMatchObject({ pulled: 3.22, pulledFrom: 'MASTER', raised: 0 });
    // EXTREME は比のまま（8.6 × 0.85 = 7.31 の方が下げる幅 1.3 より小さい）
    expect(b.EXTREME!.pulled).toBeUndefined();
    // 幅は隣と重ならず、上から順に下がる
    expect(b.EXTREME!.min).toBeGreaterThanOrEqual(b.ADVANCED!.max - 1e-9);
    expect(b.ADVANCED!.min).toBeGreaterThanOrEqual(b.BASIC!.max - 1e-9);
    expect(b.EXTREME!.max).toBeLessThanOrEqual(8.6 - 0.3 + 1e-9);
  });

  it('どのレベルの曲でも、いちばん上から EXTREME 1.3・ADVANCED 1.8・BASIC 2.2 より下げない（BASIC でも元の音の約半分）', () => {
    expect(MAX_DROP).toEqual({ MASTER: 0, EXTREME: 1.3, ADVANCED: 1.8, BASIC: 2.2 });
    // レベルは1秒あたりの打数の対数（check/level の傾き 3.51）。BASIC で残す打数は元の半分くらい
    expect(Math.exp(-MAX_DROP.BASIC / 3.51)).toBeGreaterThan(0.5);
    for (const top of [5, 6, 7, 7.6, 8.3, 9, 9.5]) {
      const b = targetBands({ known: { MASTER: top }, make: ALL, floor: null });
      for (const d of ALL) expect(b[d]!.center, `${top} ${d}`).toBeGreaterThanOrEqual(top - MAX_DROP[d] - 1e-9);
      expect(b.EXTREME!.center).toBeGreaterThan(b.ADVANCED!.center + 0.3 - 1e-9);
      expect(b.ADVANCED!.center).toBeGreaterThan(b.BASIC!.center + 0.3 - 1e-9);
    }
  });

  it('低い曲は比のまま（比で決めた方が下げる幅が小さい）', () => {
    const b = targetBands({ known: { MASTER: 3 }, make: ALL, floor: null });
    expect(b.EXTREME!.center).toBeCloseTo(3 * 0.85, 2);
    expect(b.ADVANCED!.center).toBeCloseTo(3 * 0.6, 2);
    expect(b.BASIC!.center).toBeCloseTo(3 * 0.37, 2);
    for (const d of ALL) expect(b[d]!.pulled).toBeUndefined();
    const b4 = targetBands({ known: { MASTER: 4 }, make: ALL, floor: null });
    expect(b4.ADVANCED!.center).toBeCloseTo(4 * 0.6, 2);
    expect(b4.BASIC!.center).toBeCloseTo(4 - 2.2, 2);
  });

  it('手元の曲（MASTER だけから作る）：BASIC は元の音を削りすぎないレベルにする', () => {
    // 前は比だけで決めていて、Bless（8.3）の BASIC は 3.07（作者の BASIC 2.7 に近い）だった
    for (const song of SONGS) {
      const top = song.human[0]!;
      const b = targetBands({ known: { MASTER: top }, make: ALL, floor: song.floor[0] });
      expect(b.BASIC!.center, song.name).toBeCloseTo(top - 2.2, 2);
      expect(b.ADVANCED!.center, song.name).toBeCloseTo(top - 1.8, 2);
      // EXTREME は比（速い曲は底上げで少し上）のまま
      expect(b.EXTREME!.center, song.name).toBeGreaterThanOrEqual(top * 0.85 - 1e-9);
      expect(b.EXTREME!.center, song.name).toBeLessThanOrEqual(top * 0.85 + 0.2);
    }
  });

  it('作者の譜面がある曲では、そのあいだに収める（作者の譜面より上・下にはしない）', () => {
    let checked = 0;
    for (const song of SONGS) {
      for (let k = 1; k <= 3; k++) {
        if (song.human[k - 1] === null) continue;
        const known: Partial<Record<Slot, number>> = {};
        for (let i = 0; i < k; i++) known[ORDER[i]] = song.human[i]!;
        const make = ORDER.slice(k) as Difficulty[];
        const bands = targetBands({ known, make, floor: song.floor[k - 1] });
        for (const d of make) {
          const b = bands[d]!;
          expect(b.min, `${song.name} ${d}`).toBeLessThanOrEqual(b.center);
          expect(b.max, `${song.name} ${d}`).toBeGreaterThanOrEqual(b.center);
          // いちばん近い上の作者の譜面の 0.3 下まで
          const above = ORDER.slice(0, ORDER.indexOf(d)).filter((s) => known[s] !== undefined).pop()!;
          expect(b.max, `${song.name}: known ${k} → ${d}`).toBeLessThanOrEqual(known[above]! - 0.3 + 1e-9);
          // そこから下げすぎない（上の譜面との差のぶんだけ）
          expect(b.center, `${song.name}: known ${k} → ${d}`).toBeGreaterThanOrEqual(known[above]! - (MAX_DROP[d] - MAX_DROP[above]) - 1e-9);
          checked++;
        }
      }
    }
    expect(checked).toBe(33);
  });

  it('いちばん易しい段でも下がらない（速い・密な）曲は、引き上げより上なら底上げする', () => {
    // いちばん易しい段でも 6.5 までしか下がらない曲（MASTER 7.5）：BASIC は 6.0（引き上げの 5.3 より上）
    const fast = targetBands({ known: { MASTER: 7.5 }, make: ALL, floor: 6.5 });
    expect(fast.BASIC!.center).toBeCloseTo(6.0, 2);
    expect(fast.BASIC!.raised).toBeGreaterThan(3);
    expect(fast.BASIC!.pulled).toBeUndefined();
    expect(fast.ADVANCED!.center).toBeGreaterThan(fast.BASIC!.center + 0.3);
    // 引き上げの方が上なら、底上げではなく引き上げ（3.86 − 0.5 < 7.5 − 2.2）
    const usual = targetBands({ known: { MASTER: 7.5 }, make: ALL, floor: 3.86 });
    expect(usual.BASIC!).toMatchObject({ center: 5.3, raised: 0, pulledFrom: 'MASTER' });
  });

  it('既存の譜面のあいだに収め、既存の譜面とは 0.3 離す', () => {
    // MASTER と ADVANCED がある曲で EXTREME と BASIC を作る
    const b = targetBands({ known: { MASTER: 7, ADVANCED: 5 }, make: ['EXTREME', 'BASIC'], floor: 2 });
    expect(b.EXTREME!.max).toBeCloseTo(6.7, 5);
    expect(b.EXTREME!.min).toBeCloseTo(5.3, 5);
    expect(b.EXTREME!.capAbove).toEqual({ slot: 'MASTER', known: true });
    expect(b.EXTREME!.capBelow).toEqual({ slot: 'ADVANCED', known: true });
    // BASIC は既存の ADVANCED から下げすぎない（ADVANCED → BASIC は 0.4 まで）。ADVANCED の 0.3 下より下
    expect(b.BASIC!.center).toBeCloseTo(4.6, 2);
    expect(b.BASIC!.pulledFrom).toBe('ADVANCED');
    expect(b.BASIC!.max).toBeLessThanOrEqual(4.7);
  });

  it('EXTREME を開いて作る（MASTER が無い曲）：EXTREME のレベルから下を決める', () => {
    const b = targetBands({ known: { EXTREME: 6 }, make: ['ADVANCED', 'BASIC'], floor: null });
    // EXTREME から ADVANCED は 0.5、BASIC は 0.9 まで
    expect(b.ADVANCED!.center).toBeCloseTo(5.5, 2);
    expect(b.BASIC!.center).toBeCloseTo(5.1, 2);
    expect(b.ADVANCED!.max).toBeLessThanOrEqual(5.7 + 1e-9);
  });

  it('手で下げためやすの下の難易度は、それより下に並べる', () => {
    // MASTER 8.6 で ADVANCED を手で 5.0 にすると、BASIC は引き上げても 4.7 まで
    const b = targetBands({ known: { MASTER: 8.6 }, make: ALL, floor: null, manual: { ADVANCED: 5 } });
    expect(b.ADVANCED!.center).toBe(5);
    expect(b.ADVANCED!.pulled).toBeUndefined();
    expect(b.BASIC!.center).toBeCloseTo(4.7, 2);
  });

  it('手で決めためやすを使う（既存の譜面は越えない）', () => {
    const b = targetBands({ known: { MASTER: 7, EXTREME: 6 }, make: ['ADVANCED', 'BASIC'], floor: null, manual: { ADVANCED: 6.5 } });
    expect(b.ADVANCED!.center).toBeCloseTo(5.7, 5);
    expect(b.ADVANCED!.max).toBeCloseTo(5.7, 5);
    expect(b.ADVANCED!.raised).toBe(0);
  });

  it('作る難易度のめやすは ±0.3 の範囲で狙う（幅の中で）', () => {
    expect(aimOf({ min: 2, max: 4, center: 3 })).toEqual({ min: 2.7, max: 3.3 });
    expect(aimOf({ min: 2.9, max: 4, center: 3 })).toEqual({ min: 2.9, max: 3.3 });
  });
});

describe('難易度名', () => {
  it('set.def の難易度名を先に、無ければファイル名の終わりから', () => {
    expect(slotOf('MASTER', 'x.dtx')).toBe('MASTER');
    expect(slotOf('Extreme', 'x.dtx')).toBe('EXTREME');
    expect(slotOf('BSC', 'x.dtx')).toBe('BASIC');
    expect(slotOf(undefined, 'mstr.dtx')).toBe('MASTER');
    expect(slotOf(undefined, 'Song-mas.dtx')).toBe('MASTER');
    expect(slotOf(undefined, 'song-bas.dtx')).toBe('BASIC');
    expect(slotOf(undefined, 'song_adv.dtx')).toBe('ADVANCED');
    expect(slotOf('', 'ext.dtx')).toBe('EXTREME');
    expect(slotOf(undefined, 'song.dtx')).toBeNull();
    expect(slotOf('DTXMANIA', 'song.dtx')).toBeNull();
    // 難易度名がファイル名より先
    expect(slotOf('ADVANCED', 'mstr.dtx')).toBe('ADVANCED');
  });
  it('上の難易度か', () => {
    expect(isAbove('MASTER', 'EXTREME')).toBe(true);
    expect(isAbove('BASIC', 'ADVANCED')).toBe(false);
    expect(isAbove('EXTREME', 'EXTREME')).toBe(false);
  });
});
