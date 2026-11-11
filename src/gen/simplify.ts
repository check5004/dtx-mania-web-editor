// 低難易度の生成（ルールエンジン）。MASTER の譜面から音を間引いて易しくする。
// 楽器や奏法を別のものに書き換えない（ライドはライド、オープンHHはオープン、左シンバルは左のまま）。
// 書き換えると曲として間違った譜面になり、叩きやすくもならない（楯さんの方針: 音楽理論を正義に）。
// 例外は左バスドラム→右バスドラムだけ（同じバスドラムを片足で踏むだけで、鳴る音は変わらない）。
// どの音をどの順番で省くかは gen/reduce（音の役割と拍の強さで決めた1本の順番を、曲全体に同じに当てる）。
// 「段」は、その順番の何番目まで省いたか。作者が指示したときだけ、AI が「どのセクションが静か・山場か」を決め、
// 段のあいだの細かい調整（ease）で次の段を静かなセクションから先に当てる（どのセクションも曲全体と1段しか違わない）。
// 同じ中身の小節には同じ結果が出るので、曲としての一貫性が保たれる。
import { tr } from '../i18n';
import { CH, type DtxDoc } from '../dtx/model';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { estimateLevel } from '../check/level';
import { drumNotes, HAND_LANES, TOM_LANES, type Note } from './features';
import { assignRoles, describeRung, MAX_EASE as REDUCE_MAX_EASE, MAX_STEPS, mergesLeftFoot, sectionRoles, SLOW_BPM, type Roles } from './reduce';

/** 段の数（0 はそのまま、MAX_RUNG は省く順番をすべて当てた段） */
export const MAX_RUNG = MAX_STEPS;

/** 段の説明に使う（段の番号と、曲が遅いか。遅い曲は刻みの8分を省く順番が後ろ） */
export interface Policy {
  rung: number;
  slow: boolean;
}

export type Difficulty = 'BASIC' | 'ADVANCED' | 'EXTREME';
export const DIFFICULTIES: readonly Difficulty[] = ['EXTREME', 'ADVANCED', 'BASIC'];
/**
 * MASTER のレベルに対するレベルの比（楯さんの手元の5曲の人が作った譜面の平均: 0.85・0.60・0.37）。
 * 目標そのものではなく、難易度の並びの位置に使う（目標の幅は gen/targets）
 */
export const TARGET_RATIO: Record<Difficulty, number> = { EXTREME: 0.85, ADVANCED: 0.6, BASIC: 0.37 };

export interface MustKeep {
  /** 2・4拍のスネア */
  backbeat: boolean;
  /** 1拍目のキック */
  kick1: boolean;
  /** セクション頭のクラッシュ */
  sectionCrash: boolean;
  /** フィルの着地（次の小節頭のクラッシュとキック） */
  fillLanding: boolean;
  /** オープンハイハットのアクセント（8分の位置）を、ハイハットを間引く段でも残す */
  openHH: boolean;
}

export const DEFAULT_KEEP: MustKeep = { backbeat: true, kick1: true, sectionCrash: true, fillLanding: true, openHH: false };

/** 区間（セクション）ごとの方針（AI が決める。無ければ元の譜面の濃さから） */
export interface SectionPlan {
  name: string;
  from: number;
  to: number;
  /**
   * セクションの役割。+ は静かな所（段のあいだの調整で、次の段を先に当てる）、− は山場（最後まで元に近く残す）、0 はふつう。
   * 省く順番は曲全体で同じで、どのセクションも曲全体と1段しか違わない（gen/reduce）
   */
  shift: number;
  comment?: string;
  /** 上の難易度の方針に合わせて shift を上げた（その難易度の名前。gen/stairs alignPlan） */
  alignedTo?: string;
  /** 合わせる前の、この難易度の方針の shift（画面で「AIの方針は…でしたが」と出す） */
  ownShift?: number;
}

export interface SimplifyInput {
  doc: DtxDoc;
  rung: number;
  sections: SectionPlan[];
  keep: MustKeep;
  /** 手で直したもの：元のチップの id → 残す／消す */
  overrides?: ReadonlyMap<number, 'keep' | 'drop'>;
  /**
   * 段のあいだの細かい調整：次の段を、静かなセクションから何番目の役割まで先に当てるか（0〜2。1 は静かな所だけ、
   * 2 は静か・ふつう。山場は次の段まで元のまま）
   */
  ease?: number;
  /**
   * 難易度の段階（gen/stairs）：上の難易度に残した音。これに無い音は置かない（どの小節も上の難易度より濃くしない）。
   * 手直しで「残す」にした音は別
   */
  within?: ReadonlySet<number>;
  /** 下の難易度に残した音。これは残す（どの小節も下の難易度より薄くしない）。within に無い音は置かない（上を優先） */
  atLeast?: ReadonlySet<number>;
}

/** 段のあいだの細かい調整の最大 */
export const MAX_EASE = REDUCE_MAX_EASE;

export type ChipFate = { kind: 'kept' } | { kind: 'removed' } | { kind: 'moved'; ch: number };

export interface SimplifyResult {
  doc: DtxDoc;
  fate: Map<number, ChipFate>;
  notesBefore: number;
  notesAfter: number;
  fills: number;
  /** 遅い曲（刻みの8分を省く順番が後ろ。段の説明に使う） */
  slow: boolean;
}

const EPS = 1e-6;
const onGrid = (x: number, step: number) => Math.abs(x / step - Math.round(x / step)) < 1e-4;

/** 段の説明に使う方針（slow は遅い曲か。SimplifyResult.slow） */
export function policyFor(rung: number, slow = false): Policy {
  return { rung: Math.max(0, Math.min(MAX_RUNG, Math.round(rung))), slow };
}

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

/**
 * 小節の始まりを告げるクラッシュ（左右のシンバル）の id：小節の頭のものと、食い（小節の最後の8分の裏で鳴らし、
 * 次の小節の頭にはクラッシュが無いもの）。どの段でも残す。
 * 作者の譜面（2026-11-03、手元の6曲）では BASIC でも頭の 73〜90%、食いの 8割を残している。
 * 左シンバルは2小節目の頭や食いに多いので、4小節ごとの頭だけを残すと左だけが消えていた。
 */
export function crashStarts(notes: readonly Note[]): Set<number> {
  const isCrash = (n: Note) => n.lane === 0 || n.lane === 8;
  const heads = new Set<number>();
  for (const n of notes) if (isCrash(n) && n.inBeat < EPS) heads.add(n.m);
  const out = new Set<number>();
  for (const n of notes) {
    if (!isCrash(n)) continue;
    if (n.inBeat < EPS) out.add(n.id);
    else if (Math.abs(n.mBeats - n.inBeat - 0.5) < 1e-4 && !heads.has(n.m + 1)) out.add(n.id);
  }
  return out;
}

// 手の数・同じ足で残すとき（手直し・段階の決まりで残した音がぶつかったとき）の重み。大きいほど残す
const PRIORITY: Record<number, number> = {
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

/** 曲のおもな BPM（いちばん長く続く BPM。拍で数える） */
export function mainBpm(tempo: TempoMap, lastBeat: number): number {
  const ev = tempo.events;
  const span = new Map<number, number>();
  for (let i = 0; i < ev.length; i++) {
    const a = ev[i].beat;
    const b = i + 1 < ev.length ? ev[i + 1].beat : Math.max(a, lastBeat);
    if (b > a) span.set(ev[i].bpm, (span.get(ev[i].bpm) ?? 0) + (b - a));
  }
  let best = tempo.initialBpm;
  let len = -1;
  for (const [bpm, l] of span) if (l > len) (best = bpm), (len = l);
  return best;
}

/** 作る元の譜面を読んだもの（段を変えて何度も作るときに使い回す） */
export interface Prepared {
  doc: DtxDoc;
  notes: Note[];
  roles: Roles;
  fills: Map<number, number>;
  group: (m: number) => 0 | 1 | 2;
  /** セクションの役割があるか（無ければ段のあいだの調整は使わない） */
  hasRoles: boolean;
  slow: boolean;
}

export function prepare(input: Pick<SimplifyInput, 'doc' | 'sections' | 'keep'>): Prepared {
  const tempo = buildTempoMap(input.doc);
  const notes = drumNotes(input.doc, tempo);
  const fills = detectFills(notes);
  const bpm = mainBpm(tempo, notes.length ? notes[notes.length - 1].beat : 0);
  const roles = assignRoles({
    notes,
    fills,
    backbeat: backbeatSnares(notes, fills),
    starts: crashStarts(notes),
    sectionHeads: new Set(input.sections.map((s) => s.from)),
    keep: input.keep,
    bpm,
  });
  const sr = sectionRoles(input.sections);
  return { doc: input.doc, notes, roles, fills, group: sr.group, hasRoles: sr.hasRoles, slow: bpm < SLOW_BPM };
}

type Alive = { n: Note; ch: number; protect: boolean };

/** 読んだ譜面から、段 rung（と段のあいだの調整 ease）で作る */
export function build(prep: Prepared, o: Omit<SimplifyInput, 'doc' | 'sections' | 'keep'>): SimplifyResult {
  const { notes, roles } = prep;
  const rung = Math.max(0, Math.min(MAX_RUNG, Math.round(o.rung)));
  const ease = rung < MAX_RUNG && prep.hasRoles ? Math.max(0, Math.min(MAX_EASE, Math.round(o.ease ?? 0))) : 0;
  const merge = mergesLeftFoot(roles, rung);
  const alive = new Map<number, Alive>();
  for (const n of notes) {
    const r = roles.byId.get(n.id)!;
    let ok = !(r.step <= rung || (r.step === rung + 1 && prep.group(n.m) < ease));
    let protect = r.protect;
    const ch = merge && n.lane === 2 && n.alt ? CH.BD : n.ch;
    // 難易度の段階：下の難易度にある音は残し、上の難易度に無い音は置かない（食い違うときは上に合わせる）
    if (o.atLeast?.has(n.id)) (ok = true), (protect = true);
    if (o.within && !o.within.has(n.id)) (ok = false), (protect = false);
    const ov = o.overrides?.get(n.id);
    if (ov === 'keep') (ok = true), (protect = true);
    if (ov === 'drop') (ok = false), (protect = false);
    if (ok) alive.set(n.id, { n, ch, protect });
  }

  // 手直し・段階の決まりで残した音がぶつかったときだけ：同じ時刻・同じチャンネルは1つ、手は2本まで
  const byTime = new Map<number, Alive[]>();
  for (const a of alive.values()) {
    const k = Math.round(a.n.beat * 960);
    let g = byTime.get(k);
    if (!g) byTime.set(k, (g = []));
    g.push(a);
  }
  for (const g of byTime.values()) {
    if (g.length < 2) continue;
    const seen = new Set<number>();
    for (const a of [...g].sort((x, y) => (x.ch === x.n.ch ? 0 : 1) - (y.ch === y.n.ch ? 0 : 1))) {
      if (seen.has(a.ch)) alive.delete(a.n.id);
      else seen.add(a.ch);
    }
    const hands = g.filter((a) => alive.has(a.n.id) && HAND_LANES.has(a.n.lane));
    if (hands.length > 2) {
      const order = [...hands].sort((x, y) => (y.protect ? 100 : 0) + (PRIORITY[y.ch] ?? 1) - ((x.protect ? 100 : 0) + (PRIORITY[x.ch] ?? 1)));
      for (const a of order.slice(2)) alive.delete(a.n.id);
    }
    // 左ペダルと左バスドラムは同じ足
    const lp = g.filter((a) => alive.has(a.n.id) && (a.ch === CH.LP || a.ch === CH.LBD));
    if (lp.length > 1) for (const a of lp.slice(1)) alive.delete(a.n.id);
  }

  const out: DtxDoc = structuredClone(prep.doc);
  const noteIds = new Set(notes.map((n) => n.id));
  out.chips = out.chips.filter((c) => !noteIds.has(c.id) || alive.has(c.id));
  for (const c of out.chips) {
    const a = alive.get(c.id);
    if (a && a.ch !== c.ch) c.ch = a.ch;
  }
  const fate = new Map<number, ChipFate>();
  for (const n of notes) {
    const a = alive.get(n.id);
    fate.set(n.id, !a ? { kind: 'removed' } : a.ch !== n.ch ? { kind: 'moved', ch: a.ch } : { kind: 'kept' });
  }
  return { doc: out, fate, notesBefore: notes.length, notesAfter: alive.size, fills: prep.fills.size, slow: prep.slow };
}

export function simplify(input: SimplifyInput): SimplifyResult {
  return build(prepare(input), input);
}

export interface Generated extends SimplifyResult {
  rung: number;
  level: number;
  /** 段のあいだの細かい調整（次の段を先に当てたセクションの役割の数。0〜2） */
  ease: number;
  tries: { rung: number; level: number; ease?: number }[];
}

/** 段のあいだの調整の数（セクションの役割が無ければ 0） */
export function easeSteps(sections: readonly { shift: number }[]): number {
  return sections.some((s) => s.shift !== 0) ? MAX_EASE : 0;
}

/**
 * 目標のレベル帯に入る段を探す。段を上げるほど音は減る（前の段の音の一部だけになる）ので、二分探索で幅の上の端を見つけ、
 * 幅の中に入るもののうち、まん中にいちばん近いものを採る（同じなら元に近いほう）。
 * 幅に入らなければ、いちばん近いもの（同じなら元に近いほう）
 */
export function generateToTarget(base: Omit<SimplifyInput, 'rung' | 'ease'>, target: { min: number; max: number }): Generated {
  const prep = prepare(base);
  // 段と調整を1本の並びにした番号（大きいほど易しい。どの番号も、それより小さい番号の譜面の音の一部だけ）
  const per = (prep.hasRoles ? MAX_EASE : 0) + 1;
  const CONFIGS = MAX_RUNG * per + 1;
  const configOf = (i: number) => ({ rung: Math.floor(i / per), ease: i % per });
  const tries: Generated['tries'] = [];
  const cache = new Map<number, { r: SimplifyResult; level: number }>();
  const at = (i: number) => {
    let x = cache.get(i);
    if (!x) {
      const c = configOf(i);
      const r = build(prep, { ...base, ...c });
      x = { r, level: levelOfDoc(r.doc) };
      cache.set(i, x);
      tries.push({ rung: c.rung, level: x.level, ...(c.ease ? { ease: c.ease } : {}) });
    }
    return x;
  };
  const errOf = (lv: number) => (lv > target.max ? lv - target.max : lv < target.min ? target.min - lv : 0);
  // 幅の上の端より易しい最初の番号
  let lo = 0;
  let hi = CONFIGS - 1;
  if (at(lo).level <= target.max + 1e-9) hi = lo;
  else if (at(hi).level > target.max + 1e-9) lo = hi;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at(mid).level <= target.max + 1e-9) hi = mid;
      else lo = mid;
    }
  }
  // 候補：境目の前後と、幅の中に続くもの
  const cands = new Set<number>([Math.max(0, hi - 1), hi]);
  for (let i = hi + 1; i < CONFIGS && at(i - 1).level >= target.min - 1e-9; i++) cands.add(i);
  const mid = (target.min + target.max) / 2;
  let best = -1;
  let bestKey = [Infinity, Infinity];
  for (const i of [...cands].sort((a, b) => a - b)) {
    const lv = at(i).level;
    const key = [errOf(lv), Math.abs(lv - mid)];
    if (key[0] < bestKey[0] - 1e-9 || (Math.abs(key[0] - bestKey[0]) <= 1e-9 && key[1] < bestKey[1] - 1e-9)) (best = i), (bestKey = key);
  }
  const c = configOf(best);
  const x = at(best);
  return { ...x.r, ...c, level: x.level, tries };
}

export function levelOfDoc(doc: DtxDoc, tempo: TempoMap = buildTempoMap(doc)): number {
  return estimateLevel(doc, tempo)?.level ?? 1;
}

/** 段で省いたものを、楽器ごとの人が読める文にする */
export function describePolicy(p: Policy): string {
  return describeRung(p.rung, p.slow);
}

/** 段のあいだの調整の説明（ease が 0 なら空） */
export function describeEase(ease: number): string {
  if (ease <= 0) return '';
  return ease === 1
    ? tr('（静かなセクションは次の段）', '(the calm sections use the next step)')
    : tr('（山場のほかは次の段）', '(all but the high points use the next step)');
}
