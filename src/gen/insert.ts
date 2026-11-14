// あいだに作る：曲にある難易度のレベルのあいだに、決めたレベルの譜面を足すとき、どの難易度に作り、どの譜面を移すか。
// 楯さんの依頼（2026-11-14）: ADVANCED 5.10・EXTREME 7.50・MASTER 8.40 で BASIC が空いている曲に、自分に合う 6.5 くらいの譜面が欲しい。
// 今の 5.10 を BASIC に移して、空いた ADVANCED にあいだの譜面を作る。
// - 空いた難易度があいだにあれば、そこに作る（移さない）
// - 無ければ、下の隣の譜面から下へ、空いた難易度に当たるまで 1 つずつ移して空ける（移すのは set.def の段だけ。ファイルと成績はそのまま）
// - 作る元は上の隣の譜面（下の難易度は上の譜面を間引いて作るので、上の譜面より難しい譜面は作れない）
import type { Difficulty } from './simplify';
import { KNOWN_GAP, SLOTS, type Slot } from './targets';

/** 易しい順（BASIC → MASTER） */
const UP: readonly Slot[] = [...SLOTS].reverse();

/** 曲にある譜面を 1 つ下の難易度へ移す */
export interface MoveStep {
  from: Difficulty;
  to: Difficulty;
}

export interface InsertPlan {
  ok: true;
  /** 作る難易度 */
  make: Difficulty;
  /** 移す譜面（下から順に。先に動かすものから）。空いた難易度にそのまま作れるなら空 */
  moves: MoveStep[];
  /** 作る元（上の隣の譜面） */
  source: Slot;
  /** 上の隣・下の隣の譜面（移したあとの難易度で。下が無ければ null） */
  upper: { slot: Slot; level: number };
  lower: { slot: Slot; level: number } | null;
}

export interface InsertFail {
  ok: false;
  /**
   * top: いちばん上の譜面より 0.3 以上低くない（上の譜面を間引いて作るので）・bottom: BASIC より易しい・
   * near: 同じくらいのレベルの譜面がもうある・full: 移す先の空いた難易度が無い・unknown: レベルの分からない譜面がある
   */
  why: 'top' | 'bottom' | 'near' | 'full' | 'unknown' | 'empty';
  slot?: Slot;
  level?: number;
}

/** levels は曲にある譜面のレベル（無い難易度は書かない。レベルの分からない譜面は null） */
export function insertPlan(levels: Partial<Record<Slot, number | null>>, want: number): InsertPlan | InsertFail {
  const filled = UP.filter((s) => levels[s] !== undefined);
  if (filled.length === 0) return { ok: false, why: 'empty' };
  const unknown = filled.find((s) => levels[s] === null);
  if (unknown) return { ok: false, why: 'unknown', slot: unknown };
  const lv = (s: Slot) => levels[s] as number;
  const top = filled[filled.length - 1];
  if (want > lv(top) - KNOWN_GAP + 1e-9) return { ok: false, why: 'top', slot: top, level: lv(top) };
  const near = filled.find((s) => Math.abs(lv(s) - want) < KNOWN_GAP - 1e-9);
  if (near) return { ok: false, why: 'near', slot: near, level: lv(near) };
  // 上の隣：易しい方から見て、初めて want より高い譜面
  const ui = UP.findIndex((s) => levels[s] !== undefined && lv(s) > want);
  if (ui <= 0) return { ok: false, why: 'bottom', slot: UP[0], level: lv(UP[0]) };
  let li = ui - 1;
  while (li >= 0 && levels[UP[li]] === undefined) li--;
  const upper = { slot: UP[ui], level: lv(UP[ui]) };
  // あいだに空いた難易度がある：上の譜面に近ければ上の隣のすぐ下、下の譜面に近ければ下の隣のすぐ上
  if (ui - li > 1) {
    const lo = li >= 0 ? lv(UP[li]) : null;
    const i = lo === null || want - lo >= upper.level - want ? ui - 1 : li + 1;
    return { ok: true, make: UP[i] as Difficulty, moves: [], source: upper.slot, upper, lower: li >= 0 ? { slot: UP[li], level: lv(UP[li]) } : null };
  }
  // 空きが無い：下の隣から下へ、空いた難易度に当たるまで 1 つずつ移す
  let e = li - 1;
  while (e >= 0 && levels[UP[e]] !== undefined) e--;
  if (e < 0) return { ok: false, why: 'full' };
  const moves: MoveStep[] = [];
  for (let i = e + 1; i <= li; i++) moves.push({ from: UP[i] as Difficulty, to: UP[i - 1] as Difficulty });
  return { ok: true, make: UP[li] as Difficulty, moves, source: upper.slot, upper, lower: { slot: UP[li - 1], level: lv(UP[li]) } };
}

/**
 * はじめに出すレベル：前に入れたレベル（あれば）、無ければいちばん広いあいだの真ん中（0.1 刻み）。
 * 曲の譜面のレベルを易しい順に並べたあいだのうち、作れる所（いちばん上の譜面より下）
 */
export function defaultInsertLevel(levels: Partial<Record<Slot, number | null>>, remembered: number | null): number | null {
  if (remembered !== null && insertPlan(levels, remembered).ok) return remembered;
  const lv = UP.map((s) => levels[s]).filter((x): x is number => typeof x === 'number');
  let best: number | null = null;
  let width = 0;
  for (let i = 1; i < lv.length; i++) {
    const w = lv[i] - lv[i - 1];
    if (w > width + 1e-9) (width = w), (best = Math.round(((lv[i] + lv[i - 1]) / 2) * 10) / 10);
  }
  return best !== null && insertPlan(levels, best).ok ? best : remembered;
}
