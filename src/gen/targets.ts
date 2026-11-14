// 作る難易度の目標レベル（幅）と、曲の中の難易度の並び（MASTER・EXTREME・ADVANCED・BASIC）。
// 楯さんの方針（2026-11-04）:
// - 目標は決まった値ではなく、幅（±1。「2くらいの幅」）で持つ
// - そもそもとても難しい・速い曲は、低い難易度も必然的に難しくなるので、目標を底上げする
// - 曲に既にある難易度（作者の譜面・前に作った譜面）があれば、そのあいだに収める
// 楯さんの方針（2026-11-11）:
// - 難しい曲は、下の難易度も上に引っ張られて難しくてよい（MASTER Lv8.6 なら 7.3・6.8・6.4 くらい）。
//   低い難易度に合わせて削りすぎると、曲として崩れるほど音が減る。初心者は易しい曲そのものを選ぶので、難しい曲は難しくてよい
// 決め方:
//   1. 難易度の「位置」（BASIC 0 〜 MASTER 1）。作者の譜面の MASTER に対するレベルの比の中央値（EXT 0.85・ADV 0.60・BSC 0.37）から
//   2. 下の端（BASIC のめやす）= いちばん上の譜面のレベル × 比。ただし、いちばん易しい段まで間引いても下がらない曲（速い・密な曲）は
//      そのレベル −0.5 まで底上げする（作者の BASIC はそのくらいにある。2026-11-04、手元の5曲）
//   3. あいだの難易度は、決まっているレベル（元の譜面・残す既存の譜面・下の端）を位置で結んだ線の上に置く
//   4. 上の譜面から下げすぎない（MAX_DROP。BASIC でも元の音の約半分は残す）。比だけだと上の曲ほど多く削るので、それを止める
//   5. 幅はめやすの ±1。既存の譜面とは 0.3 以上離し、隣の作る難易度とは真ん中で分ける（幅が重ならない）
// 比は作者の譜面の中央値だが、Lv7 前後より上の曲では 4. が効いて、作者の ADVANCED・BASIC（2.4〜5.6）より高くなる（楯さんの方針）。
import type { Difficulty } from './simplify';
import { TARGET_RATIO } from './simplify';

/** 曲の中の難易度。上から順に */
export type Slot = 'MASTER' | Difficulty;
export const SLOTS: readonly Slot[] = ['MASTER', 'EXTREME', 'ADVANCED', 'BASIC'];

/** MASTER に対するレベルの比（作者の譜面の中央値） */
export const SLOT_RATIO: Record<Slot, number> = { MASTER: 1, ...TARGET_RATIO };

/** 難易度の位置（BASIC 0 〜 MASTER 1） */
export function slotPos(s: Slot): number {
  return (SLOT_RATIO[s] - SLOT_RATIO.BASIC) / (1 - SLOT_RATIO.BASIC);
}

/** 目標の幅の半分（めやすの ±1） */
export const BAND_HALF = 1;
/** 既存の譜面とのあいだに空けるレベル */
export const KNOWN_GAP = 0.3;
/** いちばん易しい段のレベルから、BASIC のめやすをどれだけ下に置くか */
export const FLOOR_MARGIN = 0.5;

/**
 * いちばん上の難易度（MASTER）から、どこまでレベルを下げてよいか。楯さんの例（MASTER 8.6 → 7.3・6.8・6.4）から。
 * レベルは1秒あたりの打数の対数でほぼ決まる（check/level、傾き 3.51）ので、下げる幅を決めると残す音の割合が決まる:
 * EXTREME は元の約7割、ADVANCED は約6割、BASIC でも約半分の音を残す（どのレベルの曲でも同じ）。
 * 比（SLOT_RATIO）だけだと下げる幅がレベルに比例し、上の曲ほど多く削る（Lv8.6 の BASIC は 3.2 で、元の音の約2割）。
 * 低い曲（BASIC は Lv3.5 くらいまで・ADVANCED は Lv4.5 くらいまで）は比の方が下げる幅が小さいので、比のまま
 */
export const MAX_DROP: Record<Slot, number> = { MASTER: 0, EXTREME: 1.3, ADVANCED: 1.8, BASIC: 2.2 };

export interface TargetBand {
  min: number;
  max: number;
  /** めやす（ルールエンジンはここを狙う） */
  center: number;
  /** 曲の速さ・密度で底上げした分（0 ならしていない） */
  raised: number;
  /**
   * 上の譜面から下げすぎないように引き上げた分（MAX_DROP。比だけで決めためやすから。0 ならしていない）。
   * 引き上げたときは raised は 0（底上げより上にしたので）
   */
  pulled?: number;
  /** 引き上げの元にした上の譜面（決まっている譜面のうち、いちばん近い上） */
  pulledFrom?: Slot;
  /** 幅の上を決めた隣の譜面（既存の譜面なら known） */
  capAbove?: { slot: Slot; known: boolean };
  capBelow?: { slot: Slot; known: boolean };
}

export interface TargetInput {
  /** レベルが決まっている譜面（元の譜面と、作り直さない既存の譜面）。登録の目盛り */
  known: Partial<Record<Slot, number>>;
  /** 作る難易度 */
  make: readonly Difficulty[];
  /** BASIC を作る元の譜面を、いちばん易しい段まで間引いたときのレベル（登録の目盛り）。分からなければ null */
  floor?: number | null;
  /** 手で決めためやす */
  manual?: Partial<Record<Difficulty, number>>;
  /**
   * 曲にある譜面を下へ移して空けた難易度（あいだに作る）。上下の残す譜面のあいだが目標なので、上の譜面への引き上げ（MAX_DROP）はしない。
   * 引き上げは上の譜面だけから作るときに削りすぎないためのもので、下に残す譜面があれば、どこまで下げてよいかはその譜面が決めている
   */
  inserted?: readonly Difficulty[];
}

const clampLv = (x: number) => Math.max(1, Math.min(9.99, x));
const rank = (s: Slot) => SLOTS.indexOf(s);

/** めやすを位置で結んだ線の上に置く（決まっている点 = 既存の譜面と下の端） */
function centersOf(known: Partial<Record<Slot, number>>, make: readonly Difficulty[], floor: number | null): Partial<Record<Difficulty, number>> {
  const ks = SLOTS.filter((s) => known[s] !== undefined);
  const out: Partial<Record<Difficulty, number>> = {};
  if (ks.length === 0) return out;
  const top = ks[0];
  const kTop = known[top]!;
  // 下の端（BASIC のめやす）
  let bottom: number;
  if (known.BASIC !== undefined) bottom = known.BASIC;
  else {
    bottom = kTop * (SLOT_RATIO.BASIC / SLOT_RATIO[top]);
    if (floor !== null) bottom = Math.max(bottom, floor - FLOOR_MARGIN);
    // いちばん下の既存の譜面より、あいだの難易度の数ぶん下に
    const lowest = ks[ks.length - 1];
    bottom = Math.min(bottom, known[lowest]! - KNOWN_GAP * (rank('BASIC') - rank(lowest)));
    bottom = clampLv(bottom);
  }
  const pts = [...ks.map((s) => ({ pos: slotPos(s), lv: known[s]! })), ...(known.BASIC === undefined ? [{ pos: 0, lv: bottom }] : [])].sort((a, b) => a.pos - b.pos);
  for (const d of make) {
    if (known[d] !== undefined) continue;
    const p = slotPos(d);
    const lo = [...pts].reverse().find((x) => x.pos <= p + 1e-9);
    const hi = pts.find((x) => x.pos > p + 1e-9);
    let c: number;
    if (lo && Math.abs(lo.pos - p) < 1e-9) c = lo.lv;
    else if (lo && hi) c = lo.lv + ((hi.lv - lo.lv) * (p - lo.pos)) / (hi.pos - lo.pos);
    else c = kTop * (SLOT_RATIO[d] / SLOT_RATIO[top]);
    out[d] = c;
  }
  return out;
}

/** 作る難易度ごとの目標の幅 */
export function targetBands(input: TargetInput): Partial<Record<Difficulty, TargetBand>> {
  const { known } = input;
  const make = SLOTS.filter((s): s is Difficulty => s !== 'MASTER' && input.make.includes(s as Difficulty) && known[s] === undefined);
  const withFloor = centersOf(known, make, input.floor ?? null);
  const noFloor = centersOf(known, make, null);
  const center: Partial<Record<Difficulty, number>> = {};
  const pull: Partial<Record<Difficulty, { from: Slot; min: number }>> = {};
  for (const d of make) {
    const manual = input.manual?.[d];
    let c = manual ?? withFloor[d];
    if (c === undefined) continue;
    const above = SLOTS.slice(0, rank(d)).filter((s) => known[s] !== undefined).pop();
    const below = SLOTS.slice(rank(d) + 1).find((s) => known[s] !== undefined);
    // 上の譜面から下げすぎない（難しい曲は下の難易度も難しく。手で決めためやす・あいだに作る難易度はそのまま）
    if (above && manual === undefined && !input.inserted?.includes(d)) {
      const min = known[above]! - (MAX_DROP[d] - MAX_DROP[above]);
      pull[d] = { from: above, min };
      c = Math.max(c, min);
    }
    // 既存の譜面より上・下にはしない
    if (above) c = Math.min(c, known[above]! - KNOWN_GAP);
    if (below) c = Math.max(c, known[below]! + KNOWN_GAP);
    center[d] = clampLv(c);
  }
  // 作る難易度どうしも上から順に並べ、0.3 以上あける（引き上げで近づきすぎないように。手で決めためやすは動かさない）
  let prev: number | undefined;
  for (const s of SLOTS) {
    if (known[s] !== undefined) {
      prev = known[s];
      continue;
    }
    const c = center[s as Difficulty];
    if (c === undefined) continue;
    if (prev !== undefined && c > prev - KNOWN_GAP && input.manual?.[s as Difficulty] === undefined) center[s as Difficulty] = clampLv(prev - KNOWN_GAP);
    prev = center[s as Difficulty];
  }
  const out: Partial<Record<Difficulty, TargetBand>> = {};
  for (const d of make) {
    const c = center[d];
    if (c === undefined) continue;
    let max = Math.min(9.99, c + BAND_HALF);
    let min = Math.max(1, c - BAND_HALF);
    let capAbove: TargetBand['capAbove'];
    let capBelow: TargetBand['capBelow'];
    // 上の隣：既存の譜面なら 0.3 下まで、作る難易度なら真ん中まで
    for (const s of SLOTS.slice(0, rank(d)).reverse()) {
      const lim = known[s] !== undefined ? known[s]! - KNOWN_GAP : center[s as Difficulty] !== undefined ? (center[s as Difficulty]! + c) / 2 : null;
      if (lim === null) continue;
      if (lim < max) (max = lim), (capAbove = { slot: s, known: known[s] !== undefined });
      break;
    }
    for (const s of SLOTS.slice(rank(d) + 1)) {
      const lim = known[s] !== undefined ? known[s]! + KNOWN_GAP : center[s as Difficulty] !== undefined ? (center[s as Difficulty]! + c) / 2 : null;
      if (lim === null) continue;
      if (lim > min) (min = lim), (capBelow = { slot: s, known: known[s] !== undefined });
      break;
    }
    min = Math.min(min, c);
    max = Math.max(max, c);
    // 引き上げ（上の譜面から下げすぎない）が効いたか、底上げ（速い・密な曲）が効いたか
    const floorC = withFloor[d] ?? c;
    const p = pull[d];
    const pulled = p && p.min > floorC + 1e-9 && c > floorC + 1e-9 ? Math.max(0, c - (noFloor[d] ?? c)) : 0;
    const raised = input.manual?.[d] !== undefined || pulled > 0 ? 0 : Math.max(0, floorC - (noFloor[d] ?? c));
    out[d] = { min: round2(min), max: round2(max), center: round2(c), raised: round2(raised), capAbove, capBelow, ...(pulled > 0 ? { pulled: round2(pulled), pulledFrom: p!.from } : {}) };
  }
  return out;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** ルールエンジンが狙う範囲（めやすの ±0.3。幅の中で） */
export const AIM_HALF = 0.3;
export function aimOf(t: { min: number; max: number; center: number }): { min: number; max: number } {
  return { min: Math.max(t.min, t.center - AIM_HALF), max: Math.min(t.max, t.center + AIM_HALF) };
}

// ---- 難易度名 ---------------------------------------------------------------------------

/**
 * set.def の難易度名（無ければファイル名）から、曲の中のどの難易度か。分からなければ null。
 * 難易度名を先に見る（ファイル名は作者ごとにばらばら: mstr.dtx・song-mas.dtx・adv.dtx など）
 */
export function slotOf(label: string | undefined, file: string): Slot | null {
  const l = (label ?? '').trim().toUpperCase();
  if (/^(MASTER|MAS|MSTR)$/.test(l)) return 'MASTER';
  if (/^(EXTREME|EXT)$/.test(l)) return 'EXTREME';
  if (/^(ADVANCED|ADV)$/.test(l)) return 'ADVANCED';
  if (/^(BASIC|BSC|BAS)$/.test(l)) return 'BASIC';
  const b = file.replace(/\.dtx$/i, '').toLowerCase();
  const tail = /(?:^|[^a-z])([a-z]+)$/.exec(b)?.[1] ?? b;
  if (/^(mstr|master|mas)$/.test(tail)) return 'MASTER';
  if (/^(ext|extreme)$/.test(tail)) return 'EXTREME';
  if (/^(adv|advanced)$/.test(tail)) return 'ADVANCED';
  if (/^(bsc|bas|basic)$/.test(tail)) return 'BASIC';
  return null;
}

/** 上の難易度か（MASTER が一番上） */
export function isAbove(a: Slot, b: Slot): boolean {
  return rank(a) < rank(b);
}

export const slotRank = rank;
