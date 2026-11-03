// 低難易度の生成（ルールエンジン）。MASTER の譜面から音を間引き、必要ならレーンを寄せる。
// AI は「どの区間をどれだけ簡略化するか」だけを決め、ノーツの配置はここで決定的に行う。
// 同じ中身の小節には同じ結果が出る（位置と中身だけで決める）ので、曲としての一貫性が保たれる。
import { CH, type DtxDoc } from '../dtx/model';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { estimateLevel } from '../check/level';
import { drumNotes, HAND_LANES, TOM_LANES, type Note } from './features';

/** 残す一番細かい間隔（拍）。0 は全部残す、null は残さない */
export type Step = 0 | 0.25 | 0.5 | 1 | 2 | 4;

export interface Policy {
  hh: Step;
  kick: Step;
  snare: Step | 'backbeat';
  toms: Step;
  /** フィル：前半と最後の拍の間隔（前半 null は消す） */
  fillEarly: Step | null;
  fillLast: Step;
  /** クラッシュ：'heads' は小節の頭・セクションの頭・フィルの着地だけ */
  cymbals: 'keep' | 'heads';
  openHH: boolean;
  /** 左足：merge は左バスドラムを右へ寄せる、drop は左ペダルも消す */
  leftFoot: 'keep' | 'merge' | 'drop';
  ride: 'keep' | 'toHH';
  leftCymbal: 'keep' | 'toRight';
  maxChord: number;
}

/** 簡略化の段（0 がほぼそのまま、8 がいちばん簡単） */
export const LADDER: readonly Policy[] = [
  { hh: 0, kick: 0, snare: 0, toms: 0, fillEarly: 0, fillLast: 0, cymbals: 'keep', openHH: true, leftFoot: 'keep', ride: 'keep', leftCymbal: 'keep', maxChord: 4 },
  { hh: 0.25, kick: 0.25, snare: 0.25, toms: 0.25, fillEarly: 0.25, fillLast: 0.25, cymbals: 'keep', openHH: true, leftFoot: 'keep', ride: 'keep', leftCymbal: 'keep', maxChord: 3 },
  { hh: 0.25, kick: 0.5, snare: 0.25, toms: 0.25, fillEarly: 0.25, fillLast: 0.25, cymbals: 'keep', openHH: true, leftFoot: 'merge', ride: 'keep', leftCymbal: 'keep', maxChord: 3 },
  { hh: 0.5, kick: 0.5, snare: 0.5, toms: 0.25, fillEarly: 0.5, fillLast: 0.25, cymbals: 'keep', openHH: true, leftFoot: 'merge', ride: 'keep', leftCymbal: 'keep', maxChord: 3 },
  { hh: 0.5, kick: 0.5, snare: 0.5, toms: 0.5, fillEarly: 0.5, fillLast: 0.5, cymbals: 'keep', openHH: true, leftFoot: 'merge', ride: 'keep', leftCymbal: 'keep', maxChord: 2 },
  { hh: 0.5, kick: 1, snare: 0.5, toms: 0.5, fillEarly: 1, fillLast: 0.5, cymbals: 'keep', openHH: true, leftFoot: 'drop', ride: 'keep', leftCymbal: 'keep', maxChord: 2 },
  { hh: 1, kick: 1, snare: 'backbeat', toms: 1, fillEarly: 1, fillLast: 0.5, cymbals: 'heads', openHH: false, leftFoot: 'drop', ride: 'toHH', leftCymbal: 'keep', maxChord: 2 },
  { hh: 1, kick: 2, snare: 'backbeat', toms: 1, fillEarly: null, fillLast: 0.5, cymbals: 'heads', openHH: false, leftFoot: 'drop', ride: 'toHH', leftCymbal: 'toRight', maxChord: 2 },
  { hh: 2, kick: 2, snare: 'backbeat', toms: 1, fillEarly: null, fillLast: 1, cymbals: 'heads', openHH: false, leftFoot: 'drop', ride: 'toHH', leftCymbal: 'toRight', maxChord: 2 },
  // 速い曲の BASIC 用：キックは小節の頭だけ（人の作った BASIC は 180BPM 前後でこの形が多い）
  { hh: 2, kick: 4, snare: 'backbeat', toms: 1, fillEarly: null, fillLast: 1, cymbals: 'heads', openHH: false, leftFoot: 'drop', ride: 'toHH', leftCymbal: 'toRight', maxChord: 2 },
];

export const MAX_RUNG = LADDER.length - 1;

export type Difficulty = 'BASIC' | 'ADVANCED' | 'EXTREME';
export const DIFFICULTIES: readonly Difficulty[] = ['EXTREME', 'ADVANCED', 'BASIC'];
/** 難易度ごとの最初の段 */
export const DEFAULT_RUNG: Record<Difficulty, number> = { EXTREME: 1, ADVANCED: 4, BASIC: 6 };
/** MASTER のレベルに対する目標の割合（楯さんの手元の5曲の人が作った譜面の平均: 0.85・0.60・0.37） */
export const TARGET_RATIO: Record<Difficulty, number> = { EXTREME: 0.85, ADVANCED: 0.6, BASIC: 0.37 };

export function targetRange(diff: Difficulty, masterLevel: number): { min: number; max: number; center: number } {
  const c = Math.max(1, Math.min(9.5, masterLevel * TARGET_RATIO[diff]));
  return { min: Math.max(1, c - 0.3), max: c + 0.3, center: c };
}

export interface MustKeep {
  /** 2・4拍のスネア */
  backbeat: boolean;
  /** 1拍目のキック */
  kick1: boolean;
  /** セクション頭のクラッシュ */
  sectionCrash: boolean;
  /** フィルの着地（次の小節頭のクラッシュとキック） */
  fillLanding: boolean;
  /** オープンハイハットのアクセント */
  openHH: boolean;
}

export const DEFAULT_KEEP: MustKeep = { backbeat: true, kick1: true, sectionCrash: true, fillLanding: true, openHH: false };

/** 区間ごとの方針（AI が決める。無ければ全体と同じ） */
export interface SectionPlan {
  name: string;
  from: number;
  to: number;
  /** 全体の段からの増減（+ でより簡単に） */
  shift: number;
  fill?: 'keep' | 'thin' | 'short' | 'last';
  keepRide?: boolean;
  keepOpenHH?: boolean;
  comment?: string;
}

export interface SimplifyInput {
  doc: DtxDoc;
  rung: number;
  sections: SectionPlan[];
  keep: MustKeep;
  /** 手で直したもの：元のチップの id → 残す／消す */
  overrides?: ReadonlyMap<number, 'keep' | 'drop'>;
  /** 段のあいだの細かい調整：4小節のうち何小節を1段やさしくするか（0〜3） */
  ease?: number;
}

/** 細かい調整でやさしくする小節の順（4小節の中の位置。頭の小節は最後） */
const EASE_ORDER = [1, 3, 2];
export const MAX_EASE = EASE_ORDER.length;

function easedMeasure(m: number, ease: number): boolean {
  return ease > 0 && EASE_ORDER.slice(0, ease).includes(((m % 4) + 4) % 4);
}

export type ChipFate = { kind: 'kept' } | { kind: 'removed' } | { kind: 'moved'; ch: number };

export interface SimplifyResult {
  doc: DtxDoc;
  fate: Map<number, ChipFate>;
  notesBefore: number;
  notesAfter: number;
  fills: number;
}

const EPS = 1e-6;
const onGrid = (x: number, step: number) => step === 0 || Math.abs(x / step - Math.round(x / step)) < 1e-4;

export function policyFor(rung: number, plan?: SectionPlan): Policy {
  const r = Math.max(0, Math.min(MAX_RUNG, Math.round(rung + (plan?.shift ?? 0))));
  const p = { ...LADDER[r] };
  if (plan?.fill) {
    const f = FILL_STYLES[plan.fill];
    p.fillEarly = f.early;
    p.fillLast = f.last;
  }
  if (plan?.keepRide) p.ride = 'keep';
  if (plan?.keepOpenHH) p.openHH = true;
  return p;
}

export const FILL_STYLES: Record<NonNullable<SectionPlan['fill']>, { early: Step | null; last: Step; label: string }> = {
  keep: { early: 0.25, last: 0.25, label: 'フィルはほぼそのまま' },
  thin: { early: 0.5, last: 0.5, label: 'フィルは8分に間引く' },
  short: { early: 1, last: 0.5, label: 'フィルは最後の拍を残して短く' },
  last: { early: null, last: 1, label: 'フィルは最後の拍だけ' },
};

/**
 * バックビートとして残すスネア。ふつうは2・4拍（0 から数えて奇数の拍）のスネア。
 * 2・4拍にスネアが無いグルーヴ（2拍目・4拍目の裏だけで鳴らすなど）では、その半小節のスネアのうち
 * 8分の位置にあって2・4拍にいちばん近いものを代わりにする（無ければ16分の位置のもの）。フィルの中は見ない。
 */
export function backbeatSnares(notes: Note[], fills: ReadonlyMap<number, number>): Set<number> {
  const out = new Set<number>();
  const byM = new Map<number, Note[]>();
  for (const n of notes) {
    if (n.ch !== CH.SD) continue;
    const f = fills.get(n.m);
    if (f !== undefined && n.inBeat >= f - EPS) continue;
    let a = byM.get(n.m);
    if (!a) byM.set(n.m, (a = []));
    a.push(n);
  }
  for (const ns of byM.values()) {
    const beats = Math.round(ns[0].mBeats);
    for (let b = 1; b < beats; b += 2) {
      const on = ns.filter((n) => Math.abs(n.inBeat - b) < EPS);
      if (on.length) {
        for (const n of on) out.add(n.id);
        continue;
      }
      const near = ns.filter((n) => n.inBeat >= b - 1 - EPS && n.inBeat < b + 1 - EPS);
      const rank = (n: Note) => (onGrid(n.inBeat, 0.5) ? 0 : 10) + Math.abs(n.inBeat - b) + (n.inBeat > b ? 0 : 0.01);
      const best = near.sort((x, y) => rank(x) - rank(y))[0];
      if (best) out.add(best.id);
    }
  }
  return out;
}

/** フィルの範囲：タムが2打以上ある小節で、最初のタム（か直前のスネアの連続）から小節の終わりまで */
export function detectFills(notes: Note[]): Map<number, number> {
  const byM = new Map<number, Note[]>();
  for (const n of notes) {
    let a = byM.get(n.m);
    if (!a) byM.set(n.m, (a = []));
    a.push(n);
  }
  const out = new Map<number, number>();
  for (const [m, ns] of byM) {
    const toms = ns.filter((n) => TOM_LANES.has(n.lane));
    const half = ns[0].mBeats / 2;
    // 後半のスネアの連打（16分以下の間隔で3打以上続く）。16分の裏に散らばるだけのスネア（シンコペーションのグルーヴ）はフィルにしない
    const roll = snareRoll(ns.filter((n) => n.lane === 3 && n.inBeat >= half - EPS).map((n) => n.inBeat));
    if (toms.length < 2 && roll === null) continue;
    let start = toms.length >= 2 ? toms[0].inBeat : Infinity;
    if (roll !== null) start = Math.min(start, Math.floor(roll + EPS));
    // 直前のスネアの連続を含める（同じ拍の中だけ）
    const limit = Math.floor(start + EPS);
    const snares = ns.filter((n) => n.lane === 3 && n.inBeat < start - EPS && n.inBeat >= limit - EPS).map((n) => n.inBeat);
    for (let i = snares.length - 1; i >= 0; i--) {
      if (start - snares[i] <= 0.5 + EPS) start = snares[i];
      else break;
    }
    // 小節の頭から始まるタム（ビートの一部）だけならフィルとしない
    if (start <= EPS && toms.length < 4) continue;
    out.set(m, Math.max(0, Math.floor(start * 4 + EPS) / 4));
  }
  return out;
}

/** 16分以下の間隔で3打以上続くスネアの最初の位置（拍）。無ければ null */
function snareRoll(beats: number[]): number | null {
  const b = [...new Set(beats.map((x) => Math.round(x * 960) / 960))].sort((x, y) => x - y);
  let runStart = 0;
  for (let i = 1; i < b.length; i++) {
    if (b[i] - b[i - 1] > 0.25 + EPS) runStart = i;
    else if (i - runStart + 1 >= 3) return b[runStart];
  }
  return null;
}

const PRIORITY: Record<number, number> = {
  // 大きいほど残す
  [CH.CY]: 9,
  [CH.LC]: 9,
  [CH.SD]: 8,
  [CH.BD]: 7,
  [CH.HT]: 6,
  [CH.LT]: 6,
  [CH.FT]: 6,
  [CH.HHO]: 5,
  [CH.HHC]: 4,
  [CH.RD]: 4,
  [CH.LBD]: 3,
  [CH.LP]: 2,
};

export function simplify(input: SimplifyInput): SimplifyResult {
  const { doc, keep } = input;
  const tempo = buildTempoMap(doc);
  const notes = drumNotes(doc, tempo);
  const fills = detectFills(notes);
  const backbeat = backbeatSnares(notes, fills);
  const sectionHeads = new Set(input.sections.map((s) => s.from));
  const planOf = (m: number) => input.sections.find((s) => m >= s.from && m <= s.to);
  const fate = new Map<number, ChipFate>();
  // 残す候補と、移す先のチャンネル
  const alive = new Map<number, { n: Note; ch: number; protect: boolean }>();

  for (const n of notes) {
    const p = policyFor(input.rung + (easedMeasure(n.m, input.ease ?? 0) ? 1 : 0), planOf(n.m));
    const fillStart = fills.get(n.m);
    const inFill = fillStart !== undefined && n.inBeat >= fillStart - EPS;
    const isHead = n.inBeat < EPS;
    const landing = isHead && fills.has(n.m - 1);
    let ch = n.ch;
    let protect = false;
    let ok: boolean;
    // 必ず残すもの
    if (keep.kick1 && n.ch === CH.BD && isHead) protect = true;
    if (keep.backbeat && n.ch === CH.SD && !inFill && backbeat.has(n.id)) protect = true;
    if (keep.sectionCrash && (n.ch === CH.CY || n.ch === CH.LC) && isHead && sectionHeads.has(n.m)) protect = true;
    if (keep.fillLanding && landing && (n.ch === CH.CY || n.ch === CH.LC || n.ch === CH.BD)) protect = true;

    if (inFill) {
      const lastBeatStart = Math.max(fillStart!, Math.ceil(n.mBeats - 1 - EPS));
      const step = n.inBeat >= lastBeatStart - EPS ? p.fillLast : p.fillEarly;
      ok = step !== null && onGrid(n.inBeat, step);
      // フィルの中のシンバル・キックはビートと同じに扱う
      if (n.lane === 0 || n.lane === 8) ok = onGrid(n.inBeat, Math.max(p.toms, 0.5));
      if (n.lane === 5 || n.lane === 2) ok = step !== null && onGrid(n.inBeat, Math.max(step, p.kick));
      if (n.lane === 2 && n.alt && p.leftFoot !== 'keep') ch = CH.BD;
      if (n.lane === 2 && !n.alt && p.leftFoot === 'drop') ok = false;
      if (n.lane === 1 || n.lane === 9) ok = step !== null && onGrid(n.inBeat, Math.max(step, p.hh));
    } else {
      switch (n.lane) {
        case 1: // ハイハット
          ok = onGrid(n.inBeat, p.hh);
          if (n.alt && !p.openHH && !keep.openHH) ch = CH.HHC;
          break;
        case 9: // ライド
          ok = onGrid(n.inBeat, p.hh);
          if (p.ride === 'toHH') ch = CH.HHC;
          break;
        case 0:
        case 8: // クラッシュ
          ok = p.cymbals === 'keep' ? onGrid(n.inBeat, Math.max(0.5, p.hh)) : isHead && (n.m === 0 || sectionHeads.has(n.m) || landing || isPhraseHead(n.m, input.sections));
          if (n.lane === 0 && p.leftCymbal === 'toRight') ch = CH.CY;
          break;
        case 3: // スネア
          ok = p.snare === 'backbeat' ? backbeat.has(n.id) : onGrid(n.inBeat, p.snare);
          break;
        case 5: // バスドラム
          ok = onGrid(n.inBeat, p.kick);
          break;
        case 2: // 左ペダル・左バスドラム
          if (n.alt) {
            ok = onGrid(n.inBeat, p.kick);
            if (p.leftFoot !== 'keep') ch = CH.BD;
          } else {
            ok = p.leftFoot === 'drop' ? false : p.leftFoot === 'merge' ? onGrid(n.inBeat, 1) : onGrid(n.inBeat, p.hh);
          }
          break;
        default: // タム
          ok = onGrid(n.inBeat, p.toms);
      }
    }
    if (keep.openHH && n.lane === 1 && n.alt && onGrid(n.inBeat, 0.5)) (ok = true), (ch = n.ch);
    const ov = input.overrides?.get(n.id);
    if (ov === 'keep') (ok = true), (protect = true);
    if (ov === 'drop') (ok = false), (protect = false);
    if (ok || protect) alive.set(n.id, { n, ch, protect });
  }

  // 同じ時刻・同じチャンネルになったもの（左バスドラム→右など）は1つにする
  const byTime = new Map<number, { n: Note; ch: number; protect: boolean }[]>();
  for (const a of alive.values()) {
    const k = Math.round(a.n.beat * 960);
    let g = byTime.get(k);
    if (!g) byTime.set(k, (g = []));
    g.push(a);
  }
  for (const g of byTime.values()) {
    // 同じチャンネル
    const seen = new Map<number, { n: Note; ch: number; protect: boolean }>();
    for (const a of [...g].sort((x, y) => (x.ch === x.n.ch ? 0 : 1) - (y.ch === y.n.ch ? 0 : 1))) {
      if (seen.has(a.ch)) alive.delete(a.n.id);
      else seen.set(a.ch, a);
    }
    const rest = g.filter((a) => alive.has(a.n.id));
    // 手は2本まで、全体は maxChord まで（守るものは残す）
    const m0 = rest[0]?.n.m ?? 0;
    const p = policyFor(input.rung + (easedMeasure(m0, input.ease ?? 0) ? 1 : 0), planOf(m0));
    const order = [...rest].sort((x, y) => (y.protect ? 100 : 0) + (PRIORITY[y.ch] ?? 1) - ((x.protect ? 100 : 0) + (PRIORITY[x.ch] ?? 1)));
    let hands = 0;
    let total = 0;
    for (const a of order) {
      const hand = HAND_LANES.has(laneOfCh(a.ch));
      if ((hand && hands >= 2) || (!a.protect && total >= p.maxChord)) {
        alive.delete(a.n.id);
        continue;
      }
      if (hand) hands++;
      total++;
    }
    // 左ペダルと左バスドラムは同じ足
    const lp = rest.filter((a) => alive.has(a.n.id) && (a.ch === CH.LP || a.ch === CH.LBD));
    if (lp.length > 1) for (const a of lp.slice(1)) alive.delete(a.n.id);
  }

  const out: DtxDoc = structuredClone(doc);
  const keepIds = new Set(alive.keys());
  const noteIds = new Set(notes.map((n) => n.id));
  out.chips = out.chips.filter((c) => !noteIds.has(c.id) || keepIds.has(c.id));
  for (const c of out.chips) {
    const a = alive.get(c.id);
    if (a && a.ch !== c.ch) c.ch = a.ch;
  }
  for (const n of notes) {
    const a = alive.get(n.id);
    fate.set(n.id, !a ? { kind: 'removed' } : a.ch !== n.ch ? { kind: 'moved', ch: a.ch } : { kind: 'kept' });
  }
  return { doc: out, fate, notesBefore: notes.length, notesAfter: keepIds.size, fills: fills.size };
}

function laneOfCh(ch: number): number {
  switch (ch) {
    case CH.LC:
      return 0;
    case CH.HHC:
    case CH.HHO:
      return 1;
    case CH.LP:
    case CH.LBD:
      return 2;
    case CH.SD:
      return 3;
    case CH.HT:
      return 4;
    case CH.BD:
      return 5;
    case CH.LT:
      return 6;
    case CH.FT:
      return 7;
    case CH.CY:
      return 8;
    default:
      return 9;
  }
}

/** セクションが無いときも、4小節ごとの頭はフレーズの頭として扱う */
function isPhraseHead(m: number, sections: SectionPlan[]): boolean {
  const s = sections.find((x) => m >= x.from && m <= x.to);
  const from = s ? s.from : 0;
  return (m - from) % 4 === 0;
}

export interface Generated extends SimplifyResult {
  rung: number;
  level: number;
  /** 段のあいだの細かい調整（4小節のうち1段やさしくした小節の数） */
  ease: number;
  tries: { rung: number; level: number; ease?: number }[];
}

/**
 * 目標のレベル帯に入るまで段を上げ下げして作り直す（再調整ループ）。
 * 隣り合う段のあいだに目標があるときは、4小節のうち1〜3小節だけ次の段にして細かく合わせる。
 */
export function generateToTarget(
  base: Omit<SimplifyInput, 'rung' | 'ease'>,
  startRung: number,
  target: { min: number; max: number },
  maxTries = LADDER.length,
): Generated {
  const tries: Generated['tries'] = [];
  const errOf = (level: number) => (level > target.max ? level - target.max : level < target.min ? target.min - level : 0);
  let rung = Math.max(0, Math.min(MAX_RUNG, startRung));
  let best: Generated | null = null;
  let bestErr = Infinity;
  const seen = new Map<number, number>();
  for (let i = 0; i < maxTries && !seen.has(rung); i++) {
    const r = simplify({ ...base, rung });
    const level = levelOfDoc(r.doc);
    seen.set(rung, level);
    tries.push({ rung, level });
    const err = errOf(level);
    if (err < bestErr) {
      bestErr = err;
      best = { ...r, rung, level, ease: 0, tries };
    }
    if (err === 0) break;
    const next = level > target.max ? rung + 1 : rung - 1;
    if (next < 0 || next > MAX_RUNG) break;
    rung = next;
  }
  // 段の刻みが粗くて目標を飛び越えたとき：難しすぎる段で、4小節のうち何小節かを次の段にする
  const hard = [...seen].find(([r, lv]) => lv > target.max && (seen.get(r + 1) ?? Infinity) < target.min)?.[0];
  if (bestErr > 0 && hard !== undefined) {
    for (let ease = 1; ease <= MAX_EASE; ease++) {
      const r = simplify({ ...base, rung: hard, ease });
      const level = levelOfDoc(r.doc);
      tries.push({ rung: hard, level, ease });
      const err = errOf(level);
      if (err < bestErr) {
        bestErr = err;
        best = { ...r, rung: hard, level, ease, tries };
      }
      if (err === 0 || level < target.min) break;
    }
  }
  return { ...best!, tries };
}

export function levelOfDoc(doc: DtxDoc, tempo: TempoMap = buildTempoMap(doc)): number {
  return estimateLevel(doc, tempo)?.level ?? 1;
}

/** 方針を人が読める文にする */
export function describePolicy(p: Policy): string {
  const g = (s: Step | null | 'backbeat') => (s === null ? 'なし' : s === 'backbeat' ? '2・4拍' : s === 0 ? 'そのまま' : s === 0.25 ? '16分' : s === 0.5 ? '8分' : s === 1 ? '4分' : s === 2 ? '2分' : '小節の頭だけ');
  const parts = [`ハイハット ${g(p.hh)}`, `キック ${g(p.kick)}`, `スネア ${g(p.snare)}`, `フィル ${p.fillEarly === null ? '最後の拍だけ' : g(p.fillEarly)}`];
  if (p.cymbals === 'heads') parts.push('クラッシュは頭だけ');
  if (!p.openHH) parts.push('オープンHHは閉じる');
  if (p.leftFoot === 'merge') parts.push('左バスは右へ');
  if (p.leftFoot === 'drop') parts.push('左足なし');
  if (p.ride === 'toHH') parts.push('ライドはHHへ');
  if (p.leftCymbal === 'toRight') parts.push('左シンバルは右へ');
  parts.push(`同時 ${p.maxChord} まで`);
  return parts.join('・');
}
