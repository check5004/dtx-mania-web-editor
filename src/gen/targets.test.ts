import { describe, expect, it } from 'vitest';
import { aimOf, isAbove, slotOf, targetBands, type Slot } from './targets';
import type { Difficulty } from './simplify';

// 手元の曲（作者の4難易度がそろっている5曲と、MASTER だけの Calc）の登録レベルと、
// BASIC を作る元の譜面をいちばん易しい段まで間引いたときのレベル（登録の目盛り、2026-11-04 に測った値）。
// 曲のデータはリポジトリに入れないので、数だけを持つ
const SONGS: { name: string; human: [number, number | null, number | null, number | null]; floor: [number, number, number] }[] = [
  { name: 'Bless your breath (152 BPM)', human: [8.3, 7.8, 5.6, 2.7], floor: [3.56, 3.66, 3.21] },
  { name: 'Calc (173 BPM)', human: [7.6, null, null, null], floor: [3.5, 3.5, 3.5] },
  { name: 'Mela (138 BPM)', human: [7.6, 6.2, 4.5, 2.9], floor: [2.26, 2.2, 2.39] },
  { name: 'Mephisto (150 BPM)', human: [7.0, 5.6, 4.0, 2.6], floor: [3.08, 2.52, 2.47] },
  { name: 'Nani ga Warui (122 BPM)', human: [6.9, 5.8, 4.0, 2.4], floor: [2.57, 2.31, 2.1] },
  { name: 'Wasureteyaranai (184 BPM)', human: [7.5, 6.3, 4.6, 3.3], floor: [3.86, 3.62, 3.14] },
];
const ORDER: Slot[] = ['MASTER', 'EXTREME', 'ADVANCED', 'BASIC'];

describe('目標の幅', () => {
  it('作者の譜面は、上から k 個の難易度が決まっているとき、残りの難易度の幅に入る（手元の5曲）', () => {
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
          const h = song.human[ORDER.indexOf(d)];
          if (h === null) continue;
          expect(h, `${song.name}: known ${k} → ${d} ${b.min}–${b.max}`).toBeGreaterThanOrEqual(b.min - 1e-9);
          expect(h, `${song.name}: known ${k} → ${d} ${b.min}–${b.max}`).toBeLessThanOrEqual(b.max + 1e-9);
          checked++;
        }
      }
    }
    expect(checked).toBe(30);
  });

  it('幅はめやすの ±1 で、隣の作る難易度とは重ならない（上から順に下がる）', () => {
    const b = targetBands({ known: { MASTER: 7 }, make: ['EXTREME', 'ADVANCED', 'BASIC'], floor: null });
    expect(b.EXTREME!.max).toBeLessThanOrEqual(7 - 0.3 + 1e-9);
    expect(b.EXTREME!.min).toBeGreaterThanOrEqual(b.ADVANCED!.max - 1e-9);
    expect(b.ADVANCED!.min).toBeGreaterThanOrEqual(b.BASIC!.max - 1e-9);
    expect(b.BASIC!.max - b.BASIC!.min).toBeLessThanOrEqual(2 + 1e-9);
    expect(b.BASIC!.center).toBeCloseTo(7 * 0.37, 2);
    expect(b.BASIC!.raised).toBe(0);
  });

  it('いちばん易しい段でも下がらない（速い・密な）曲は、BASIC とあいだの難易度を底上げする', () => {
    const plain = targetBands({ known: { MASTER: 7.5 }, make: ['ADVANCED', 'BASIC'], floor: null });
    const fast = targetBands({ known: { MASTER: 7.5 }, make: ['ADVANCED', 'BASIC'], floor: 3.86 });
    expect(fast.BASIC!.center).toBeCloseTo(3.36, 2);
    expect(fast.BASIC!.raised).toBeGreaterThan(0.5);
    expect(fast.BASIC!.center).toBeGreaterThan(plain.BASIC!.center);
    expect(fast.ADVANCED!.center).toBeGreaterThan(plain.ADVANCED!.center);
    // いちばん易しい段のレベル（3.86）が幅に入る
    expect(fast.BASIC!.max).toBeGreaterThanOrEqual(3.86);
  });

  it('既存の譜面のあいだに収め、既存の譜面とは 0.3 離す', () => {
    // MASTER と ADVANCED がある曲で EXTREME と BASIC を作る
    const b = targetBands({ known: { MASTER: 7, ADVANCED: 5 }, make: ['EXTREME', 'BASIC'], floor: 2 });
    expect(b.EXTREME!.max).toBeCloseTo(6.7, 5);
    expect(b.EXTREME!.min).toBeCloseTo(5.3, 5);
    expect(b.EXTREME!.capAbove).toEqual({ slot: 'MASTER', known: true });
    expect(b.EXTREME!.capBelow).toEqual({ slot: 'ADVANCED', known: true });
    // BASIC はいちばん上の譜面の比から（ADVANCED の 0.3 下より下）
    expect(b.BASIC!.center).toBeCloseTo(2.59, 2);
    expect(b.BASIC!.max).toBeLessThanOrEqual(4.7);
  });

  it('EXTREME を開いて作る（MASTER が無い曲）：EXTREME のレベルから下を決める', () => {
    const b = targetBands({ known: { EXTREME: 6 }, make: ['ADVANCED', 'BASIC'], floor: null });
    expect(b.BASIC!.center).toBeCloseTo((6 * 0.37) / 0.85, 2);
    expect(b.ADVANCED!.max).toBeLessThanOrEqual(5.7 + 1e-9);
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
