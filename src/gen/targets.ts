// 作る難易度の目標レベル（幅）と、曲の中の難易度の並び（MASTER・EXTREME・ADVANCED・BASIC）。
// 楯さんの方針（2026-11-04）:
// - 目標は決まった値ではなく、幅（±1。「2くらいの幅」）で持つ
// - そもそもとても難しい・速い曲は、低い難易度も必然的に難しくなるので、目標を底上げする
// - 曲に既にある難易度（作者の譜面・前に作った譜面）があれば、そのあいだに収める
// 決め方:
//   1. 難易度の「位置」（BASIC 0 〜 MASTER 1）。作者の譜面の MASTER に対するレベルの比の中央値（EXT 0.85・ADV 0.60・BSC 0.37）から
//   2. 下の端（BASIC のめやす）= いちばん上の譜面のレベル × 比。ただし、いちばん易しい段まで間引いても下がらない曲（速い・密な曲）は
//      そのレベル −0.5 まで底上げする（作者の BASIC はそのくらいにある。2026-11-04、手元の5曲）
//   3. あいだの難易度は、決まっているレベル（元の譜面・残す既存の譜面・下の端）を位置で結んだ線の上に置く
//   4. 幅はめやすの ±1。既存の譜面とは 0.3 以上離し、隣の作る難易度とは真ん中で分ける（幅が重ならない）
// 手元の5曲（作者の4難易度がそろっている）では、作者の EXTREME・ADVANCED・BASIC がすべてこの幅に入る（gen/targets.test.ts）。
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

export interface TargetBand {
  min: number;
  max: number;
  /** めやす（ルールエンジンはここを狙う） */
  center: number;
  /** 曲の速さ・密度で底上げした分（0 ならしていない） */
  raised: number;
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
  for (const d of make) {
    let c = input.manual?.[d] ?? withFloor[d];
    if (c === undefined) continue;
    // 既存の譜面より上・下にはしない
    const above = SLOTS.slice(0, rank(d)).filter((s) => known[s] !== undefined).pop();
    const below = SLOTS.slice(rank(d) + 1).find((s) => known[s] !== undefined);
    if (above) c = Math.min(c, known[above]! - KNOWN_GAP);
    if (below) c = Math.max(c, known[below]! + KNOWN_GAP);
    center[d] = clampLv(c);
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
    const raised = input.manual?.[d] !== undefined ? 0 : Math.max(0, (withFloor[d] ?? c) - (noFloor[d] ?? c));
    out[d] = { min: round2(min), max: round2(max), center: round2(c), raised: round2(raised), capAbove, capBelow };
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
