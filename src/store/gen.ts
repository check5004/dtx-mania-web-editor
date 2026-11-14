// AI 難易度生成：いま開いている譜面（元の譜面。ふつうは MASTER）から、それより下の難易度を作り、並べて聴き比べて手直しし、
// set.def と一緒に書き出す。
// - 曲に既にある難易度（作者の譜面・前に作った譜面）は並べて見せ、作り直さない限りそのまま残す
// - 下の難易度は、いちばん近い上の譜面から作る（既存の EXTREME があれば ADVANCED はそこから。下の難易度が上からはみ出さない）
// - 目標のレベルは幅（±1）。元の譜面・既存の譜面・曲の速さから決める（gen/targets）
// - 作った譜面には、このアプリで作った印（#DTXE_ORIGIN）を付けて書き出す（dtx/origin）
// AI は区間ごとの方針だけを決め、配置は gen/simplify のルールで行う。キーが無ければ標準の方針で作る。
// 再生はエディタと共通（▶・ループ・速さ）で、この画面にいる間は「聴く」譜面（元の譜面・既存の譜面・作った難易度）の音を鳴らす。
import { tr } from '../i18n';
import { create } from 'zustand';
import { cleanPlan, planSchema, planPrompt, sectionSpans, type DifficultyPlan, type SectionSpan } from '../ai/judge';
import { AiError } from '../ai/openrouter';
import { findIssues } from '../check/playability';
import { levelToField } from '../check/level';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import type { DtxDoc } from '../dtx/model';
import { hasOriginLine, markOrigin, originOf, type ChartOrigin } from '../dtx/origin';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import { buildTempoMap } from '../dtx/timing';
import { setField } from '../edit/ops';
import { dtxFiles, findFile, parseSetDef, putFile, type FolderFile, type SongFolder } from '../fs/folder';
import { stepIn } from '../gen/compareView';
import { lastMeasure } from '../gen/features';
import { projectCharts } from '../gen/project';
import { DEFAULT_KEEP, DIFFICULTIES, easeSteps, generateToTarget, levelOfDoc, MAX_RUNG, simplify, type Difficulty, type Generated, type MustKeep, type SectionPlan } from '../gen/simplify';
import { alignPlan, chartProfile, clampRange, keptIds, matchIds, profileLine, stairCheck, stepRange, type StairCheck } from '../gen/stairs';
import { aimOf, isAbove, KNOWN_GAP, SLOTS, slotOf, slotRank, targetBands, type Slot, type TargetBand } from '../gen/targets';
import type { InsertPlan } from '../gen/insert';
import { chooseDialog, confirmDialog } from '../ui/dialogs';
import { sortByDifficulty } from '../gen/diffTabs';
import { hasAiKey, runAi } from './ai';
import { judgeDoc, type JudgeResult } from './aiLevel';
import { levelOf } from './check';
import { addPlayDocTransform, addSoundDocs, goBack, prepareSounds, refreshPlayback, songEndMeasure, stop, toast, useEditor } from './editor';
import { bandOf, guidelineText, levelOfField, loadGuideline, useGuideline } from './guideline';
import { useSidecar } from './sidecar';
import { glowReflected } from './glow';

/** 作る元の譜面（いま開いている譜面か、作り直さない既存の譜面） */
export interface SourceRef {
  slot: Slot;
  file: string;
  doc: DtxDoc;
  /** 登録レベル（無ければ計算） */
  level: number;
  /** 計算のレベル（エディタの推定と同じ。目標の幅はこれから決める） */
  calc: number;
}

/** 曲に既にあるほかの難易度 */
export interface ExistingChart {
  slot: Slot;
  /** set.def の難易度名（無ければ難易度） */
  label: string;
  file: string;
  /** いま開いている譜面の時間の並び・WAV 番号の上に写した譜面（gen/project） */
  doc: DtxDoc;
  /** 登録レベル（#DLEVEL）。無ければ計算 */
  level: number;
  registered: boolean;
  /** 作者の譜面か、このアプリで作った譜面か */
  origin: ChartOrigin;
  /** 計算のレベル（その譜面をエディタで開いたときの推定と同じ） */
  calc: number;
  /** 下の難易度へ移した譜面なら、元の難易度と set.def の名前（あいだに作る。gen/insert） */
  movedFrom?: Difficulty;
  fromLabel?: string;
}

/**
 * 曲にある譜面を 1 つ下の難易度へ移したこと（空いた難易度に、上下の譜面のあいだの譜面を作るため）。
 * エディタに反映するまでは、この画面の中だけ。反映すると set.def の段と名前だけを変える（ファイル・中身・DTXMania の成績はそのまま）
 */
export interface ChartMove {
  from: Difficulty;
  to: Difficulty;
  file: string;
  /** 移す前の 2 つの難易度と譜面（戻すときにそのまま戻す） */
  before: { from: DiffState; to: DiffState; chart: ExistingChart };
  /** エディタに反映した（set.def に書いた）。もう戻さない */
  written: boolean;
}

export interface DiffState {
  diff: Difficulty;
  /** 作る（既存の譜面がある難易度では「作り直す」） */
  enabled: boolean;
  target: TargetBand;
  /** めやすを手で決めた（null は自動） */
  manual: number | null;
  plan: DifficultyPlan | null;
  planSource: 'ai' | 'rule' | null;
  result: Generated | null;
  overrides: Map<number, 'keep' | 'drop'>;
  judge: JudgeResult | null;
  /** 判定のあとに手直しした */
  judgeStale: boolean;
  status: 'idle' | 'planning' | 'building' | 'judging' | 'done' | 'error';
  error: string | null;
  issues: number;
  cost: number;
  /** 作った元（result のチップの id はこの譜面のもの） */
  src: SourceRef | null;
  /** エディタに反映したとき（書いたファイルと、そのときの譜面）。result.doc が変わったら「反映のあとに変えた」 */
  applied: { file: string; doc: DtxDoc } | null;
  /** 作ったときの段階の決まり（上の難易度に残した音・下の難易度に残した音。gen/stairs） */
  stairs: StairSets | null;
  /** 作ったときの隣の難易度（レベルの範囲をそれに合わせて狭めたか） */
  step: { upper: Slot | null; lower: Slot | null; clipped: boolean } | null;
}

/** 段階の決まり：within は上の難易度に残した音（これ以外は置かない。null は決まりなし）、atLeast は残す音 */
export interface StairSets {
  within: Set<number> | null;
  atLeast: Set<number>;
}

/** 再生で鳴らす譜面（並べている列）：元の譜面・既存の譜面・作った難易度 */
export type Listen = Slot;

/** 並べた譜面の見え方。fit は「何小節が画面に収まるか」（'all' は曲全体、null は Ctrl+ホイールで決めた px） */
export type GenFit = 'all' | 4 | 8 | 16 | null;
export interface GenView {
  /** 画面のいちばん下に見えている拍 */
  scrollBeat: number;
  /** 1拍の高さ（fit が null のとき） */
  px: number;
  fit: GenFit;
}

export interface GenState {
  /** いま開いている譜面（元の譜面） */
  master: DtxDoc | null;
  masterFile: string;
  masterLabel: string;
  masterLevel: number;
  /** いま開いている譜面の計算のレベル（エディタの推定と同じ） */
  masterCalc: number;
  /** いま開いている譜面の難易度（set.def の難易度名かファイル名から。分からなければ MASTER） */
  sourceSlot: Slot;
  spans: SectionSpan[];
  /** 曲に既にあるほかの難易度（下へ移した譜面は移した先に） */
  charts: Partial<Record<Slot, ExistingChart>>;
  chartsLoading: boolean;
  /** 下へ移した譜面（移した順） */
  moves: ChartMove[];
  diffs: Record<Difficulty, DiffState>;
  /** 右の判定・方針と、易しく・難しくの対象 */
  selected: Difficulty;
  /** 再生で鳴らす譜面 */
  listen: Listen;
  view: GenView;
  keep: MustKeep;
  instruction: string;
  busy: boolean;
}

const VIEW_KEY = 'dtxe.genView.v1';
const FITS: readonly GenFit[] = ['all', 16, 8, 4, null];

/** 表示の大きさは覚えておく（はじめは曲全体を並べる） */
function loadView(): GenView {
  const v: GenView = { scrollBeat: -0.5, px: 26, fit: 'all' };
  try {
    const j = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<GenView>;
    if (FITS.includes(j.fit as GenFit)) v.fit = j.fit as GenFit;
    if (typeof j.px === 'number' && j.px >= 1 && j.px <= 160) v.px = j.px;
  } catch {
    // 覚えられなくても動く
  }
  return v;
}

const emptyTarget = (): TargetBand => ({ min: 1, max: 9.99, center: 5, raised: 0 });

const emptyDiff = (diff: Difficulty, enabled = true): DiffState => ({
  diff,
  enabled,
  target: emptyTarget(),
  manual: null,
  plan: null,
  planSource: null,
  result: null,
  overrides: new Map(),
  judge: null,
  judgeStale: false,
  status: 'idle',
  error: null,
  issues: 0,
  cost: 0,
  src: null,
  applied: null,
  stairs: null,
  step: null,
});

/** 開いている譜面より下の難易度だけ作る */
const freshDiffs = (source: Slot): Record<Difficulty, DiffState> => ({
  EXTREME: emptyDiff('EXTREME', isAbove(source, 'EXTREME')),
  ADVANCED: emptyDiff('ADVANCED', isAbove(source, 'ADVANCED')),
  BASIC: emptyDiff('BASIC', isAbove(source, 'BASIC')),
});

export const useGen = create<GenState>(() => ({
  master: null,
  masterFile: '',
  masterLabel: 'MASTER',
  masterLevel: 5,
  masterCalc: 5,
  sourceSlot: 'MASTER',
  spans: [],
  charts: {},
  chartsLoading: false,
  moves: [],
  diffs: freshDiffs('MASTER'),
  selected: 'ADVANCED',
  listen: 'MASTER',
  view: loadView(),
  keep: { ...DEFAULT_KEEP },
  instruction: '',
  busy: false,
}));
const get = useGen.getState;
const set = useGen.setState;

function patchDiff(d: Difficulty, patch: Partial<DiffState>) {
  set((s) => ({ diffs: { ...s.diffs, [d]: { ...s.diffs[d], ...patch } } }));
}

const sameFile = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---- 曲の中の難易度 -----------------------------------------------------------------------

/** 開いている譜面より下の（作れる）難易度 */
export function belowSource(s: Pick<GenState, 'sourceSlot'> = get()): Difficulty[] {
  return DIFFICULTIES.filter((d) => isAbove(s.sourceSlot, d));
}

/** 既存の譜面をそのまま残す難易度か（開いている譜面より上の既存の譜面はいつも残す） */
export function keepsExisting(s: Pick<GenState, 'charts' | 'diffs' | 'sourceSlot'>, slot: Slot): boolean {
  if (!s.charts[slot] || slot === s.sourceSlot) return false;
  return slot === 'MASTER' || !isAbove(s.sourceSlot, slot) || !s.diffs[slot as Difficulty].enabled;
}

/** レベルが決まっている譜面（開いている譜面と、残す既存の譜面）の登録レベル（ゲームに出る #DLEVEL。無ければ計算）。並びにだけ使う */
export function knownLevels(s: GenState = get()): Partial<Record<Slot, number>> {
  const k: Partial<Record<Slot, number>> = { [s.sourceSlot]: s.masterLevel };
  for (const slot of SLOTS) if (keepsExisting(s, slot)) k[slot] = s.charts[slot]!.level;
  return k;
}

/** レベルが決まっている譜面の計算のレベル（エディタの推定と同じ）。作る譜面と同じ物差しで、目標の幅はこれから決める */
export function knownCalcs(s: GenState = get()): Partial<Record<Slot, number>> {
  const k: Partial<Record<Slot, number>> = { [s.sourceSlot]: s.masterCalc };
  for (const slot of SLOTS) if (keepsExisting(s, slot)) k[slot] = s.charts[slot]!.calc;
  return k;
}

/**
 * 決まっている譜面から、作る譜面を離すレベル：上の譜面なら登録と計算の低い方（どちらでも 0.3 以上易しく）、
 * 下の譜面なら高い方（どちらでも 0.3 以上難しく）。作る譜面のレベルは計算で測るので計算でそろえ、
 * 登録でも並びが逆にならないようにする（ゲームの中で上の難易度より高い Lv が出ないように）
 */
export function stairLevel(level: number, calc: number, up: boolean): number {
  return up ? Math.min(level, calc) : Math.max(level, calc);
}

/** 作る元：いちばん近い上の、残す譜面（開いている譜面か、作り直さない既存の譜面） */
export function sourceFor(s: GenState, d: Difficulty): SourceRef | null {
  if (!s.master) return null;
  const open: SourceRef = { slot: s.sourceSlot, file: s.masterFile, doc: s.master, level: s.masterLevel, calc: s.masterCalc };
  for (const slot of SLOTS.slice(0, slotRank(d)).reverse()) {
    if (slot === s.sourceSlot) return open;
    const c = s.charts[slot];
    if (c && keepsExisting(s, slot)) return { slot, file: c.file, doc: c.doc, level: c.level, calc: c.calc };
  }
  return open;
}

// ---- 難易度の段階 ---------------------------------------------------------------------------
// どの小節も、下の難易度は上の難易度より濃くしない（gen/stairs）。同じ元の譜面から作った難易度どうしはチップの id で、
// 曲に既にある譜面は同じ時刻・同じ楽器の音で合わせる。

/** この画面で作って書き出す難易度か（作り直す既存の譜面も） */
function isMade(s: Pick<GenState, 'sourceSlot' | 'charts' | 'diffs'>, slot: Slot): slot is Difficulty {
  return slot !== 'MASTER' && isAbove(s.sourceSlot, slot) && s.diffs[slot].enabled && !keepsExisting(s, slot);
}

/**
 * 上・下の隣の譜面：離すレベル（作った譜面は計算。元の譜面・既存の譜面は登録と計算の、上なら低い方・下なら高い方）と方針
 */
export interface StairNeighbors {
  upper: { slot: Slot; level: number; plan: DifficultyPlan | null } | null;
  lower: { slot: Slot; level: number } | null;
}

const matchCache = new WeakMap<DtxDoc, WeakMap<DtxDoc, Set<number>>>();
function matchedIds(root: DtxDoc, chart: DtxDoc): Set<number> {
  let m = matchCache.get(root);
  if (!m) matchCache.set(root, (m = new WeakMap()));
  let ids = m.get(chart);
  if (!ids) m.set(chart, (ids = matchIds(root, chart)));
  return ids;
}

/**
 * 難易度 d を、作る元の譜面 root から作るときの段階の決まりと隣の譜面。
 * - within: 上の難易度（root から作った、いちばん近い上の作った難易度）に残した音。無ければ null（root がいちばん上）
 * - atLeast: 下の難易度に残した音（作った難易度は id で、既存の譜面は同じ時刻・同じ楽器の root の音）
 * pending はこれから作り直す難易度（まとめて作るとき）。前の結果は下の譜面として使わない（手で「残す」にした音だけは残す）
 */
export function stairsFor(s: GenState, d: Difficulty, root: SourceRef, pending: ReadonlySet<Difficulty> = new Set()): StairSets & StairNeighbors {
  const out: StairSets & StairNeighbors = { within: null, atLeast: new Set(), upper: null, lower: null };
  const r = slotRank(d);
  for (const slot of SLOTS.slice(0, r).reverse()) {
    if (slot === root.slot) {
      out.upper = { slot, level: stairLevel(root.level, root.calc, true), plan: null };
      break;
    }
    if (!isMade(s, slot) || pending.has(slot)) continue;
    const u = s.diffs[slot];
    if (!u.result || u.src?.doc !== root.doc) continue;
    out.within = keptIds(u.result.fate);
    out.upper = { slot, level: calcLevel(u), plan: u.plan };
    break;
  }
  for (const slot of SLOTS.slice(r + 1)) {
    if (keepsExisting(s, slot)) {
      for (const id of matchedIds(root.doc, s.charts[slot]!.doc)) out.atLeast.add(id);
      out.lower ??= { slot, level: stairLevel(s.charts[slot]!.level, s.charts[slot]!.calc, false) };
      break;
    }
    if (!isMade(s, slot)) continue;
    const l = s.diffs[slot];
    if (!l.result || l.src?.doc !== root.doc) continue;
    if (pending.has(slot)) {
      for (const [id, v] of l.overrides) if (v === 'keep') out.atLeast.add(id);
      continue;
    }
    for (const id of keptIds(l.result.fate)) out.atLeast.add(id);
    out.lower ??= { slot, level: calcLevel(l) };
  }
  return out;
}

/** 並べている列のうち、書き出す譜面（元の譜面・残す既存の譜面・作る難易度の結果） */
function stairDoc(s: GenState, slot: Slot): DtxDoc | null {
  const k = columnKind(s, slot);
  if (k === 'made') return isMade(s, slot) ? (s.diffs[slot as Difficulty].result?.doc ?? null) : null;
  return columnDoc(s, slot);
}

export interface StairIssues extends StairCheck {
  upper: Slot | null;
  lower: Slot | null;
}

/** 作った難易度の段階の確かめ：隣の上の譜面よりノーツの多い小節・隣の下の譜面より少ない小節 */
export function stairIssues(s: GenState, d: Difficulty): StairIssues {
  const doc = isMade(s, d) ? s.diffs[d].result?.doc : null;
  if (!doc) return { denser: [], thinner: [], upper: null, lower: null };
  const r = slotRank(d);
  const upper = SLOTS.slice(0, r).reverse().find((x) => stairDoc(s, x)) ?? null;
  const lower = SLOTS.slice(r + 1).find((x) => stairDoc(s, x)) ?? null;
  return { ...stairCheck(doc, upper && stairDoc(s, upper), lower && stairDoc(s, lower)), upper, lower };
}

/** 段階が逆転している小節の数（見出しの再描画用に数だけ） */
export function stairCount(s: GenState, d: Difficulty): number {
  const x = stairIssues(s, d);
  return x.denser.length + x.thinner.length;
}

/** いちばん易しい段まで間引いたときのレベル（BASIC を作る元で。目標の底上げに使う） */
const floorCache = new WeakMap<DtxDoc, Map<string, number>>();
function floorOf(s: GenState): number | null {
  const src = sourceFor(s, 'BASIC');
  if (!src) return null;
  const key = `${JSON.stringify(s.keep)}|${s.spans.length}`;
  let m = floorCache.get(src.doc);
  if (!m) floorCache.set(src.doc, (m = new Map()));
  let lv = m.get(key);
  if (lv === undefined) {
    const r = simplify({ doc: src.doc, rung: MAX_RUNG, sections: defaultPlan(s.spans).sections, keep: s.keep });
    m.set(key, (lv = levelOfDoc(r.doc)));
  }
  return lv;
}

/** 目標の幅を決め直す（既存の譜面を読んだ・作り直すかを変えた・必ず残すものを変えた・めやすを手で変えた） */
export function recomputeTargets() {
  const s = get();
  if (!s.master) return;
  // 目標の幅は計算（作る譜面と同じ物差し）から。登録レベルは並びにだけ使う
  const known = knownCalcs(s);
  const make = belowSource(s).filter((d) => known[d] === undefined);
  const manual: Partial<Record<Difficulty, number>> = {};
  for (const d of make) if (s.diffs[d].manual !== null) manual[d] = s.diffs[d].manual!;
  const bands = targetBands({ known, listed: knownLevels(s), make, floor: known.BASIC === undefined ? floorOf(s) : null, manual, inserted: insertedSlots(s) });
  set((st) => {
    const diffs = { ...st.diffs };
    for (const d of DIFFICULTIES) if (bands[d]) diffs[d] = { ...diffs[d], target: bands[d]! };
    return { diffs };
  });
}

/**
 * 画面を開いたとき：いまの譜面を元の譜面にする（同じ譜面なら前の結果を残す）。曲に既にある難易度を読む。
 * 返すのは曲にある難易度を読み終えるまで（あいだに作る案を当てるのは、読み終えてから）
 */
let loadToken = 0;
let loading: Promise<void> = Promise.resolve();
export function initGen(): Promise<void> {
  void loadGuideline();
  const s = useEditor.getState();
  const g = get();
  if (g.master === s.doc) return loading;
  const doc = s.doc;
  // 計算のレベルはエディタの「確かめる」の推定レベルと同じ（作った譜面もこれで測り、そのまま #DLEVEL に書く）
  const mech = levelOf(doc)?.level ?? levelOfDoc(doc);
  const masterLevel = levelOfField(doc.fields['DLEVEL']) ?? mech;
  const last = lastMeasure(doc);
  const spans = sectionSpans(useSidecar.getState().sections, last);
  const base = s.meta.fileName.replace(/\.dtx$/i, '').toLowerCase();
  const found = s.meta.siblings.find((x) => sameFile(x.file, s.meta.fileName))?.label;
  // set.def にラベルが無いときはファイル名が入っている
  const fromSetDef = found && found.toLowerCase() !== base ? found : undefined;
  const sourceSlot = slotOf(fromSetDef, s.meta.fileName) ?? 'MASTER';
  const below = belowSource({ sourceSlot });
  set({
    master: doc,
    masterFile: s.meta.fileName,
    masterLabel: fromSetDef ?? sourceSlot,
    masterLevel,
    masterCalc: mech,
    sourceSlot,
    spans,
    charts: {},
    chartsLoading: !!s.folder,
    moves: [],
    diffs: freshDiffs(sourceSlot),
    selected: below.includes('ADVANCED') ? 'ADVANCED' : (below[0] ?? 'BASIC'),
    listen: sourceSlot,
    // 表示は ▶（再生を始める位置）から。エディタで見ていた所から聴ける
    view: { ...get().view, scrollBeat: Math.max(-0.5, s.cursorBeat - 2) },
  });
  recomputeTargets();
  // 別の譜面を読み終える前に開き直しても、古い読み込みは捨てる（loadToken）
  loading = s.folder ? loadCharts(s.folder, ++loadToken).catch(() => undefined) : Promise.resolve();
  return loading;
}

/** 曲フォルダの set.def（無ければ DTX のファイル名）から、ほかの難易度を読む */
async function loadCharts(folder: SongFolder, token: number) {
  const g = get();
  const base = g.master;
  if (!base) return;
  try {
    let entries: { label: string; file: string }[] = [];
    const sd = findFile(folder, 'set.def');
    if (sd) {
      try {
        const blocks = parseSetDef(decodeDtx(new Uint8Array(await (await sd.getFile()).arrayBuffer())).text);
        const block = blocks.find((b) => b.levels.some((l) => sameFile(l.file, g.masterFile))) ?? (blocks.length === 1 ? blocks[0] : undefined);
        entries = block?.levels ?? [];
      } catch {
        entries = [];
      }
    }
    // set.def が無い（か、開いている譜面が載っていない）ときは、曲フォルダの DTX をファイル名で
    if (entries.length === 0) entries = dtxFiles(folder).map((f) => ({ label: '', file: f.name }));
    const found: { slot: Slot; label: string; file: string; doc: DtxDoc }[] = [];
    for (const e of entries) {
      if (sameFile(e.file, g.masterFile)) continue;
      const slot = slotOf(e.label, e.file);
      if (!slot || slot === g.sourceSlot || found.some((x) => x.slot === slot)) continue;
      const f = findFile(folder, e.file);
      if (!f) continue;
      try {
        const doc = parseDtx(decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer())).text).doc;
        found.push({ slot, label: e.label || slot, file: f.name, doc });
      } catch {
        // 読めない譜面は並べない
      }
    }
    if (token !== loadToken || get().master !== base) return;
    const projected = projectCharts(base, found.map((x) => x.doc));
    const charts: Partial<Record<Slot, ExistingChart>> = {};
    found.forEach((x, i) => {
      // 計算のレベルは、その譜面をエディタで開いたときの推定と同じ（読んだままの譜面で測る。写した譜面で測っても手元の 6 曲では同じ値）
      const mech = levelOfDoc(x.doc);
      const reg = levelOfField(x.doc.fields['DLEVEL']);
      charts[x.slot] = {
        slot: x.slot,
        label: x.label,
        file: x.file,
        doc: projected[i],
        level: reg ?? mech,
        registered: reg !== null,
        origin: originOf(x.doc),
        calc: mech,
      };
    });
    set((st) => {
      const diffs = { ...st.diffs };
      // 既存の譜面がある難易度は、はじめは作り直さない（作者の譜面・手で直した譜面）。
      // このアプリで作ってから手を入れていない譜面は、はじめから作り直す（書き出すときはその譜面に上書きする）
      for (const d of DIFFICULTIES) if (charts[d] && charts[d]!.origin !== 'ai') diffs[d] = { ...diffs[d], enabled: false };
      const make = belowSource(st).filter((d) => diffs[d].enabled);
      const selected = make.includes(st.selected) ? st.selected : (make[0] ?? st.selected);
      return { charts, chartsLoading: false, diffs, selected };
    });
    // 写した譜面にだけある音（作者が難易度ごとに音量を変えている音など）を読み込む
    if (found.length) void prepareSounds();
  } finally {
    if (token === loadToken && get().chartsLoading) set({ chartsLoading: false });
  }
  recomputeTargets();
}

/** 既存の譜面を作り直すか（作る難易度のチェック） */
export function setEnabled(d: Difficulty, on: boolean) {
  if (!belowSource().includes(d)) return;
  // 下へ移した譜面は作り直さない（移すのをやめるなら「戻す」）
  if (pendingMoveTo(get(), d)) return;
  patchDiff(d, { enabled: on });
  // 既存の譜面を残すか作り直すかで、ほかの難易度の目標と作る元が変わる
  if (get().charts[d]) recomputeTargets();
  const s = get();
  if (!columnDoc(s, s.listen)) set({ listen: s.sourceSlot });
}

// ---- あいだに作る（曲にある譜面を下の難易度へ移す） -----------------------------------------
// 楯さんの依頼（2026-11-14）: ADVANCED 5.10・EXTREME 7.50・MASTER 8.40 で BASIC が空いている曲に、6.5 くらいの譜面が欲しい。
// 5.10 を BASIC に移して、空いた ADVANCED に上下のあいだの譜面を作る。
// - 移すのは set.def の段（L1〜L4）と難易度名だけ。ファイルも中身も変えないので、DTXMania の成績（<譜面>.score.ini）も付いたまま
// - 新しく作る譜面は別の名前にする（古い名前を使うと、DTXMania が前の譜面の成績を新しい譜面に付けてしまう）
// - 作る元は上の譜面。下に移した譜面にある音は残す（段階の決まりは今までと同じ）
// - エディタに反映するまでは、この画面の中だけ（戻せる）

const INSERT_LEVEL_KEY = 'dtxe.insertLevel.v1';

/** 前にあいだに作ったときのレベル（あなたが遊ぶレベル。次の曲でもはじめに出す） */
export function insertLevel(): number | null {
  try {
    const v = Number(localStorage.getItem(INSERT_LEVEL_KEY));
    return Number.isFinite(v) && v >= 1 && v <= 9.9 ? v : null;
  } catch {
    return null;
  }
}

export function rememberInsertLevel(v: number) {
  if (!Number.isFinite(v) || v < 1 || v > 9.9) return;
  try {
    localStorage.setItem(INSERT_LEVEL_KEY, String(Math.round(v * 10) / 10));
  } catch {
    // 覚えられなくても動く
  }
}

/** 譜面を下へ移して空けた難易度（まだ何も入っていない所。目標は上下の譜面のあいだ） */
export function insertedSlots(s: Pick<GenState, 'moves' | 'charts'>): Difficulty[] {
  return [...new Set(s.moves.map((m) => m.from))].filter((d) => !s.charts[d]);
}

/** まだ反映していない、その難易度へ移した譜面（作り直さない・「戻す」の対象） */
export function pendingMoveTo(s: Pick<GenState, 'moves'>, d: Slot): ChartMove | null {
  return [...s.moves].reverse().find((m) => m.to === d && !m.written) ?? null;
}

/** 最後の移した譜面（まだ反映していなければ戻せる） */
export function undoableMove(s: Pick<GenState, 'moves'>): ChartMove | null {
  const m = s.moves[s.moves.length - 1];
  return m && !m.written ? m : null;
}

/**
 * その難易度の譜面を 1 つ下へ移せるなら、移す先。開いている譜面より下の、曲にある譜面で、すぐ下の難易度が空いているときだけ
 * （開いている譜面は「上の譜面を開き直して移す」: sourceShift）
 */
export function moveTarget(s: Pick<GenState, 'sourceSlot' | 'charts' | 'diffs' | 'chartsLoading'>, slot: Slot): Difficulty | null {
  if (slot === 'MASTER' || s.chartsLoading || !s.charts[slot] || slot === s.sourceSlot || !isAbove(s.sourceSlot, slot)) return null;
  // 作り直して反映した難易度の古い譜面は移さない（set.def にはもう作った譜面が載っている）
  if (s.diffs[slot].applied) return null;
  const to = SLOTS[slotRank(slot) + 1] as Difficulty | undefined;
  if (!to || s.charts[to] || s.diffs[to].applied) return null;
  return to;
}

/**
 * 画面で「下へ移す」を出す難易度：移せる譜面のうち、移す先がいま空けた難易度でないもの
 * （ADVANCED を BASIC に移した直後に、EXTREME を空けた ADVANCED へ移す案まで出すと、何をあいだに作るのか分かりにくい。
 * 2 つ続けて移すのは、DTXMania の曲の「あいだに作る」でレベルから決めたときだけ）
 */
export function offeredMove(s: Pick<GenState, 'sourceSlot' | 'charts' | 'diffs' | 'chartsLoading' | 'moves'>, slot: Slot): Difficulty | null {
  const to = moveTarget(s, slot);
  return to && !insertedSlots(s).includes(to) ? to : null;
}

/**
 * 空けた難易度のはじめのめやす：前に入れたレベルが上下の譜面のあいだに入れば、それ。入らなければ自動（上下の譜面のあいだ）。
 * あいだは目標の幅と同じく、上の譜面の登録と計算の低い方・下の譜面の高い方から 0.3 離す
 */
function rememberedAimFor(s: GenState, d: Difficulty): number | null {
  const r = insertLevel();
  if (r === null) return null;
  const known = knownLevels(s);
  const calcs = knownCalcs(s);
  const up = SLOTS.slice(0, slotRank(d)).filter((x) => known[x] !== undefined).pop();
  const down = SLOTS.slice(slotRank(d) + 1).find((x) => known[x] !== undefined);
  if (up && r > stairLevel(known[up]!, calcs[up] ?? known[up]!, true) - KNOWN_GAP) return null;
  if (down && r < stairLevel(known[down]!, calcs[down] ?? known[down]!, false) + KNOWN_GAP) return null;
  return r;
}

/**
 * 曲にある譜面を 1 つ下の難易度へ移し、空いた難易度を作る難易度にする（めやすは aim か、前に入れたレベル）。
 * 下の難易度で作っていた結果は消える（「戻す」で戻る）
 */
export function moveDown(slot: Difficulty, o: { aim?: number | null } = {}): boolean {
  const s = get();
  const to = moveTarget(s, slot);
  if (!to) return false;
  const c = s.charts[slot]!;
  const charts = { ...s.charts };
  delete charts[slot];
  charts[to] = { ...c, slot: to, label: to, movedFrom: c.movedFrom ?? slot, fromLabel: c.fromLabel ?? c.label };
  const move: ChartMove = { from: slot, to, file: c.file, before: { from: s.diffs[slot], to: s.diffs[to], chart: c }, written: false };
  set({
    charts,
    moves: [...s.moves, move],
    diffs: { ...s.diffs, [to]: emptyDiff(to, false), [slot]: emptyDiff(slot, true) },
    selected: slot,
    listen: s.listen === slot ? to : s.listen,
  });
  const aim = o.aim ?? rememberedAimFor(get(), slot);
  if (aim !== null && Number.isFinite(aim)) patchDiff(slot, { manual: Math.max(1, Math.min(9.9, aim)) });
  recomputeTargets();
  return true;
}

/** 最後に移した譜面を元の難易度に戻す（空けた難易度で作った結果は消える。消えるときは聞く） */
export async function undoMove(): Promise<boolean> {
  const m = undoableMove(get());
  if (!m) return false;
  if (get().diffs[m.from].result) {
    const ok = await confirmDialog({
      title: tr(`${m.before.chart.label} を ${m.from} に戻しますか？`, `Move ${m.before.chart.label} back to ${m.from}?`),
      body: tr(`あいだに作った ${m.from} は消えます。`, `The ${m.from} you made in between is discarded.`),
      ok: tr('戻す', 'Move back'),
      danger: true,
    });
    if (!ok || undoableMove(get()) !== m) return false;
  }
  const s = get();
  const charts = { ...s.charts };
  delete charts[m.to];
  charts[m.from] = m.before.chart;
  set({
    charts,
    moves: s.moves.slice(0, -1),
    diffs: { ...s.diffs, [m.from]: m.before.from, [m.to]: m.before.to },
    listen: s.listen === m.to ? m.from : s.listen,
  });
  recomputeTargets();
  const g = get();
  if (!columnDoc(g, g.listen)) set({ listen: g.sourceSlot });
  return true;
}

/**
 * 開いている譜面を下へ移すとき：移す先（すぐ下の空いた難易度）と、開き直す上の譜面（いちばん近い上の、曲にある譜面）。
 * 新しく作る譜面は上の譜面を間引いて作るので、上の譜面を開いて作る
 */
export function sourceShift(s: Pick<GenState, 'sourceSlot' | 'charts' | 'diffs' | 'chartsLoading' | 'moves'>): { to: Difficulty; above: Slot } | null {
  if (s.sourceSlot === 'MASTER' || s.chartsLoading) return null;
  const r = slotRank(s.sourceSlot);
  const to = SLOTS[r + 1] as Difficulty | undefined;
  if (!to || s.charts[to] || s.diffs[to].applied || insertedSlots(s).includes(to)) return null;
  const above = SLOTS.slice(0, r)
    .reverse()
    .find((x) => s.charts[x]);
  return above ? { to, above } : null;
}

/** 開いている譜面を下へ移す：上の譜面をエディタで開き直し、この画面を作り直してから移す（作ってまだ反映していない難易度があれば聞く） */
export async function moveSourceDown(o: { aim?: number | null } = {}): Promise<boolean> {
  const g = get();
  const plan = sourceShift(g);
  if (!plan) return false;
  const from = g.sourceSlot as Difficulty;
  const above = g.charts[plan.above]!;
  const lost = unreflected(g);
  if (lost.length) {
    const ok = await confirmDialog({
      title: tr(`${above.label} を開き直して作ります`, `Reopen ${above.label} to make it`),
      body: tr(
        `新しい ${from} は ${above.label} から作るので、${above.label} を開き直します。まだエディタに反映していない ${lost.join('・')} は消えます。`,
        `The new ${from} is made from ${above.label}, so ${above.label} is reopened. ${lost.join(' and ')} (not added to the editor yet) ${lost.length === 1 ? 'is' : 'are'} discarded.`,
      ),
      ok: tr('開き直す', 'Reopen'),
      danger: true,
    });
    if (!ok) return false;
  }
  const { switchDifficulty } = await import('../app/fileActions');
  await switchDifficulty(above.file);
  if (!sameFile(useEditor.getState().meta.fileName, above.file)) return false;
  await initGen();
  return moveDown(from, o);
}

/**
 * あいだに作る案（gen/insert）をこの画面に当てる：曲にある譜面を下から順に移し、作る難易度のめやすを want にする。
 * 作る元（案の source）の譜面を開いてから呼ぶ
 */
export async function applyInsertPlan(plan: InsertPlan, want: number): Promise<boolean> {
  await initGen();
  rememberInsertLevel(want);
  for (const m of plan.moves) if (!moveDown(m.from, { aim: want })) return false;
  if (!belowSource().includes(plan.make)) return false;
  if (plan.moves.length === 0) {
    if (get().charts[plan.make]) return false;
    selectDiff(plan.make);
    setTarget(plan.make, want);
  }
  return true;
}

function defaultPlan(spans: SectionSpan[]): DifficultyPlan {
  return {
    summary: tr(
      '標準の方針です。音の役割と拍の強さで決めた「省く順番」を曲全体に同じに当て、機械的な推定が目標のめやすの近くに入る段で止めます。同じ役割の音は、曲のどこでも同じ扱いです。',
      'Standard plan: one fixed order of what to drop (by each note’s musical role and how strong its beat is) is applied to the whole song, stopping at the step where the computed estimate lands near the target. Notes with the same role are treated the same everywhere in the song.',
    ),
    sections: spans.map((s) => ({ name: s.name, from: s.from, to: s.to, shift: 0 })),
  };
}

/** 目標の幅からどれだけ外れているか（中なら 0） */
function targetGap(lv: number, t: { min: number; max: number }) {
  return lv < t.min ? t.min - lv : lv > t.max ? lv - t.max : 0;
}

function inTarget(lv: number, t: { min: number; max: number }) {
  return lv >= t.min - 1e-9 && lv <= t.max + 1e-9;
}

/**
 * 作った譜面のレベル：エディタの「確かめる」の推定レベルと同じ計算（check/level）。そのまま #DLEVEL に書くので、
 * 反映した譜面をエディタで開くと同じ値が出る（2026-11-14 楯さん「作ったあとの難易度が、エディタで計算し直すとずれる」。
 * 前は元の譜面の登録レベル ÷ 推定の倍率をかけ、AI の判定があればそれを書いていた）
 */
export function calcLevel(ds: DiffState): number {
  return ds.result ? ds.result.level : 0;
}

export function isPassing(ds: DiffState): boolean {
  return !!ds.result && ds.issues === 0 && inTarget(calcLevel(ds), ds.target);
}

function issueCount(doc: DtxDoc): number {
  return findIssues(doc, buildTempoMap(doc)).filter((i) => i.level === 'error').length;
}

/** 難易度の名前（画面・AI に渡す。既存の譜面なら作者の譜面か AI で作った譜面か） */
export function slotLabel(s: GenState, slot: Slot): string {
  if (slot === s.sourceSlot) return s.masterLabel;
  return s.charts[slot]?.label ?? slot;
}

/** AI に渡すレベル：計算（目標の幅と同じ物差し）。登録が違えば、それも添える */
function levelForAi(calc: number, listed: number): string {
  // i18n-ignore（AI へのプロンプト）
  return `Lv${calc.toFixed(2)}${Math.abs(listed - calc) >= 0.05 ? `（登録は Lv${listed.toFixed(2)}）` : ''}`;
}

/** 曲にあるほかの難易度（AI の方針に渡す。作る元の譜面は別の行で渡すので除く） */
function othersForPlan(s: GenState, d: Difficulty, src: Slot): string[] {
  const out: string[] = [];
  const known = knownLevels(s);
  const calcs = knownCalcs(s);
  for (const slot of SLOTS) {
    if (slot === d || slot === src || known[slot] === undefined) continue;
    const c = s.charts[slot];
    // i18n-ignore-start（AI へのプロンプト）
    const who = slot === s.sourceSlot ? '開いている譜面' : c?.origin === 'human' ? '既存・作者の譜面' : '既存・このアプリで作った譜面';
    out.push(`${slot}（${who}）${levelForAi(calcs[slot] ?? known[slot]!, known[slot]!)}`);
    // i18n-ignore-end
  }
  return out;
}

/**
 * AI に渡す：ほかの難易度の作り方（区間ごとに作る元の譜面の音をどれだけ残しているか・フィルの前後・この画面で作った譜面なら方針）。
 * 作る元の譜面は別の行で渡すので除く。pending（これから作り直す難易度）の前の結果は渡さない
 */
function neighborsForPlan(s: GenState, d: Difficulty, src: SourceRef, pending: ReadonlySet<Difficulty>): { above: string[]; below: string[] } {
  const out = { above: [] as string[], below: [] as string[] };
  for (const slot of SLOTS) {
    // 作る元の譜面は別の行で渡す。それより上の譜面（作る元が既存の EXTREME のときの MASTER など）は隣ではない
    if (slot === d || slot === src.slot || isAbove(slot, src.slot)) continue;
    let pick: { doc: DtxDoc; who: string; level: number; plan?: SectionPlan[] | null; rung?: number } | null = null;
    // i18n-ignore-start（AI へのプロンプト）
    if (slot === s.sourceSlot && s.master) pick = { doc: s.master, who: '開いている譜面', level: s.masterCalc };
    else if (keepsExisting(s, slot)) {
      const c = s.charts[slot]!;
      pick = { doc: c.doc, who: c.origin === 'human' ? '既存・作者の譜面' : '既存・このアプリで作った譜面', level: c.calc };
    } else if (isMade(s, slot) && !pending.has(slot) && s.diffs[slot].result) {
      const x = s.diffs[slot];
      pick = { doc: x.result!.doc, who: x.planSource === 'ai' ? '作りたて・AI の方針' : '作りたて・標準の方針', level: calcLevel(x), plan: x.plan?.sections, rung: x.result!.rung };
    }
    // i18n-ignore-end
    if (!pick) continue;
    const line = profileLine({ label: slotLabel(s, slot), who: pick.who, level: pick.level, profile: chartProfile(src.doc, pick.doc, s.spans), plan: pick.plan, rung: pick.rung });
    (isAbove(slot, d) ? out.above : out.below).push(line);
  }
  return out;
}

/**
 * 1つの難易度を作る（AI の方針 → 上の難易度の方針に合わせる → ルールで配置 → めやすに入るまで段を調整 → AI 判定 → 幅から外れたら1回だけ直す）。
 * 上・下の難易度（作りたての譜面・既存の譜面）を見て、どの小節もそのあいだに収める（gen/stairs）。
 * pending はこのあと作り直す難易度（まとめて作るとき。上から順に作り、下の難易度の前の結果は見ない）
 */
export async function generate(diff: Difficulty, opts: { useAi?: boolean; pending?: ReadonlySet<Difficulty> } = {}) {
  const g = get();
  if (!g.master || !belowSource(g).includes(diff)) return;
  const src = sourceFor(g, diff)!;
  const ds = g.diffs[diff];
  const pending = opts.pending ?? new Set<Difficulty>();
  const hadResult = !!ds.result;
  const useAi = (opts.useAi ?? true) && hasAiKey();
  const title = g.master.fields['TITLE'] || g.masterFile;
  // 作る元が変わったら、前の手直し（元のチップの id で覚えている）は使えない
  const overrides = ds.src?.doc === src.doc ? ds.overrides : new Map<number, 'keep' | 'drop'>();
  patchDiff(diff, { status: useAi ? 'planning' : 'building', error: null, judge: null, judgeStale: false, cost: 0, overrides });
  let cost = 0;
  try {
    // 1. 方針
    let plan = defaultPlan(g.spans);
    let planSource: DiffState['planSource'] = 'rule';
    if (useAi) {
      const gl = useGuideline.getState();
      const guide = guidelineText(gl.guide, [bandOf(ds.target.center)]);
      const r = await runAi<Partial<DifficultyPlan>>('difficulty', {
        ...planPrompt({
          doc: src.doc,
          title,
          genre: g.master.fields['GENRE'] ?? '',
          diff,
          target: ds.target,
          sourceLabel: src.slot,
          // レベルは目標の幅と同じ計算で渡す（登録が違えば添える）
          masterLevel: src.calc,
          listedLevel: src.level,
          others: othersForPlan(g, diff, src.slot),
          neighbors: neighborsForPlan(g, diff, src, pending),
          sections: g.spans,
          guide,
          keep: g.keep,
          instruction: g.instruction,
        }),
        schema: planSchema(),
        maxTokens: 6000,
      });
      if (!r) {
        patchDiff(diff, { status: ds.result ? 'done' : 'idle' });
        return;
      }
      cost += r.costUsed;
      plan = cleanPlan(r.data, g.spans);
      // セクションの役割は、作者の指示があるときだけ使う（指示が無いのに AI がセクションごとに変えると、曲全体の一貫性が崩れる）
      if (!g.instruction.trim()) plan = { ...plan, sections: plan.sections.map((s) => (s.shift ? { ...s, shift: 0 } : s)) };
      planSource = 'ai';
    }
    patchDiff(diff, { status: 'building', plan, planSource, cost });
    // 2. 段階：上・下の難易度（AI を待つあいだに手直しなどで変わることがあるので、ここで読み直す）。
    //    上の難易度が薄くした区間は、こちらも同じだけ薄くする（考え方をそろえる）
    const st = stairsFor(get(), diff, src, pending);
    if (st.upper?.plan) plan = { ...plan, sections: alignPlan(plan.sections, st.upper.plan.sections, st.upper.slot) };
    // 3. 配置と再調整（計算のレベル＝エディタの推定で、めやすの近くを狙う。幅の中なら合格）。上の難易度に無い音は置かず、下の難易度にある音は残す
    const base = { doc: src.doc, sections: plan.sections, keep: get().keep, overrides, within: st.within ?? undefined, atLeast: st.atLeast };
    const t = ds.target;
    // 隣の難易度とのあいだ（上より 0.3 下、下より 0.3 上）にも収める（作りたての上の難易度が目標より易しく出たときなど）
    const step = stepRange(st.upper?.level ?? null, st.lower?.level ?? null);
    const aim0 = aimOf(t);
    const aim = clampRange(aim0, step);
    const clipped = aim.min !== aim0.min || aim.max !== aim0.max;
    // 省く順番は曲全体で同じ。セクションの役割（AI の方針）は段のあいだの調整にだけ使うので、どの方針でも目標まで下げられる。
    // 段の間が広くて狙いに入らないときは、目標の幅（隣の難易度とのあいだに狭めたもの）に入る段を先に採る
    const pass = clampRange(t, step);
    let result = generateToTarget(base, aim, pass);
    // 4. AI 判定（参考）。反映するレベルは計算のまま。AI が幅から外れたと見たら、AI と計算のずれのぶん狙いを動かして
    //    1回だけ作り直す。狙いは幅（隣の難易度とのあいだに狭めたもの）の中に収め、反映するレベル（計算）は幅から出さない。
    //    AI の判定は 0.1〜0.2 ほどぶれるので、2つのうち AI の判定が幅に近い方を採る
    let judge: JudgeResult | null = null;
    const stairs: StairSets = { within: st.within, atLeast: st.atLeast };
    if (useAi) {
      patchDiff(diff, { status: 'judging', result, issues: issueCount(result.doc), src, stairs });
      const sections = useSidecar.getState().sections;
      // 頼み方はエディタの「AIのレベル判定」と同じ（難易度の名前は渡さない。難しい曲は BASIC でもレベルが高いので、名前に引っ張られないように）
      judge = await judgeDoc(result.doc, { title, sections, mech: result.level, quiet: true });
      if (judge) {
        cost += judge.cost;
        const want = pass;
        if (!inTarget(judge.level, want)) {
          const wantCenter = Math.max(want.min, Math.min(want.max, t.center));
          const center = Math.max(want.min, Math.min(want.max, wantCenter - (judge.level - result.level)));
          const r2 = generateToTarget(base, clampRange({ min: center - 0.1, max: center + 0.1 }, want), want);
          // 作り直しても、反映するレベル（計算）は幅から遠ざけない
          if ((r2.rung !== result.rung || r2.ease !== result.ease) && targetGap(r2.level, want) <= targetGap(result.level, want) + 1e-9) {
            const j2 = await judgeDoc(r2.doc, { title, sections, mech: r2.level, quiet: true });
            if (j2) {
              cost += j2.cost;
              if (targetGap(j2.level, want) <= targetGap(judge.level, want)) {
                result = { ...r2, tries: [...result.tries, ...r2.tries] };
                judge = j2;
              }
            }
          }
        }
      }
    }
    patchDiff(diff, {
      status: 'done',
      plan,
      result,
      judge,
      issues: issueCount(result.doc),
      cost,
      src,
      stairs,
      step: { upper: st.upper?.slot ?? null, lower: st.lower?.slot ?? null, clipped },
    });
    // 初めて作れたら、選んでいる難易度を聴く（元の譜面を聴いていたときだけ）
    if (!hadResult && get().selected === diff && get().listen === get().sourceSlot) set({ listen: diff });
  } catch (e) {
    patchDiff(diff, { status: 'error', error: e instanceof AiError ? e.message : tr(`作れませんでした: ${(e as Error).message}`, `Couldn't make it: ${(e as Error).message}`), cost });
  }
}

export async function generateAll() {
  if (get().busy) return;
  set({ busy: true });
  try {
    // 上の難易度から順に作る。下の難易度は作りたての上の難易度を見て作る（まだ作り直していない難易度の前の結果は見ない）
    const todo = belowSource().filter((d) => get().diffs[d].enabled);
    for (let i = 0; i < todo.length; i++) await generate(todo[i], { pending: new Set(todo.slice(i + 1)) });
  } finally {
    set({ busy: false });
  }
}

/**
 * 方針はそのままで作り直す（手直し・必ず残すものの変更のあと）。段階の決まり（上・下の難易度に残した音）は、
 * 渡さなければいまの上・下の譜面から決める。pending はまだ作り直していない難易度（下の譜面として見ない）
 */
export function rebuild(diff: Difficulty, o: { stairs?: StairSets; pending?: ReadonlySet<Difficulty> } = {}) {
  const g = get();
  const ds = g.diffs[diff];
  if (!ds.src || !ds.result || !ds.plan) return;
  const st = o.stairs ?? stairsFor(g, diff, ds.src, o.pending);
  const r = simplify({
    doc: ds.src.doc,
    rung: ds.result.rung,
    ease: ds.result.ease,
    sections: ds.plan.sections,
    keep: g.keep,
    overrides: ds.overrides,
    within: st.within ?? undefined,
    atLeast: st.atLeast,
  });
  const level = levelOfDoc(r.doc);
  patchDiff(diff, { result: { ...ds.result, ...r, level }, issues: issueCount(r.doc), judgeStale: !!ds.judge, stairs: { within: st.within, atLeast: st.atLeast } });
}

/** 作った難易度をすべて作り直す。上から順に（下の難易度は作り直した上の難易度に合わせる） */
function rebuildAll() {
  const made = DIFFICULTIES.filter((d) => get().diffs[d].result);
  made.forEach((d, i) => rebuild(d, { pending: new Set(made.slice(i + 1)) }));
}

/** 簡略化の段を手で上げ下げする（上・下の難易度は越えない：上の難易度に無い音は置かず、下の難易度にある音は残す） */
export function shiftRung(diff: Difficulty, d: 1 | -1) {
  const ds = get().diffs[diff];
  if (!ds.result) return;
  // セクションの役割があれば、段のあいだの調整を先に動かす（易しく: 0→1→2→次の段、難しく: その逆）
  const maxEase = easeSteps(ds.plan?.sections ?? []);
  let rung = ds.result.rung;
  let ease = ds.result.ease + d;
  if (ease > maxEase) (rung += 1), (ease = 0);
  else if (ease < 0) (rung -= 1), (ease = rung >= 0 ? maxEase : 0);
  if (rung < 0) (rung = 0), (ease = 0);
  if (rung > MAX_RUNG) (rung = MAX_RUNG), (ease = 0);
  patchDiff(diff, { result: { ...ds.result, rung, ease } });
  rebuild(diff);
}

const keptIn = (ds: DiffState, id: number) => {
  const f = ds.result?.fate.get(id);
  return !!f && f.kind !== 'removed';
};

/**
 * 比較の譜面のチップを押したとき：消えたものは戻し、残ったものは消す。
 * 段階を保つため、同じ元から作ったほかの難易度にもその音だけ伝える：残したら上の難易度にも残し、削ったら下の難易度からも削る
 * （押し直して戻すと、伝えた分も戻る）。食い違う手直し（上の「削る」・下の「残す」）は、あとから押したほうを通す
 */
export function toggleChip(diff: Difficulty, id: number) {
  const ds0 = get().diffs[diff];
  if (!ds0.result || !ds0.src || !ds0.result.fate.has(id)) return;
  const was = keptIn(ds0, id);
  // 作ったときの決まりのまま作り直す（押した音のほかは変えない）
  const stairs = ds0.stairs ?? undefined;
  if (ds0.overrides.has(id)) {
    const ov = new Map(ds0.overrides);
    ov.delete(id);
    patchDiff(diff, { overrides: ov });
    rebuild(diff, { stairs });
  }
  // 手直しを外しても逆にならなければ（はじめての手直し・決まりで残っている音）、手直しを入れる
  if (keptIn(get().diffs[diff], id) === was) {
    const ov = new Map(get().diffs[diff].overrides);
    ov.set(id, was ? 'drop' : 'keep');
    patchDiff(diff, { overrides: ov });
    rebuild(diff, { stairs });
  }
  const before = new Map(DIFFICULTIES.map((d) => [d, keptIn(get().diffs[d], id)] as const));
  propagateChip(diff, id);
  // ほかの難易度も変わったら知らせる
  const sep = tr('・', ', ');
  const gained = DIFFICULTIES.filter((d) => d !== diff && !before.get(d) && keptIn(get().diffs[d], id));
  const lost = DIFFICULTIES.filter((d) => d !== diff && before.get(d) && !keptIn(get().diffs[d], id));
  if (gained.length)
    toast(
      tr(`${gained.join(sep)} にも残しました（下の難易度にある音は、上の難易度にも置きます）`, `Also kept in ${gained.join(sep)} (a note in an easier chart stays in the harder ones)`),
      'ok',
      5000,
    );
  if (lost.length)
    toast(
      tr(`${lost.join(sep)} からも削りました（上の難易度に無い音は、下の難易度にも置きません）`, `Also removed from ${lost.join(sep)} (an easier chart never has a note the harder one lacks)`),
      'ok',
      5000,
    );
}

/**
 * 1つの音の手直しを、同じ元から作ったほかの難易度へ伝える。下の難易度（近い順）は「上の難易度に残っているか」、
 * そのあと上の難易度は「下の難易度に残っているか」を、作ったときの決まりのその音だけ入れ替えて作り直す。
 * 上の難易度の順：音を足したときは上から（いちばん上が足してから、その下が上に合わせて足す）、
 * 削ったときは近い順（近い難易度が削ってから、その上が「下にあるから残す」を外す）
 */
function propagateChip(diff: Difficulty, id: number) {
  const root = get().diffs[diff].src?.doc;
  if (!root) return;
  const same = (d: Difficulty) => {
    const s = get();
    return d !== diff && isMade(s, d) && !!s.diffs[d].result && s.diffs[d].src?.doc === root;
  };
  const r = slotRank(diff);
  const lowers = DIFFICULTIES.filter((d) => slotRank(d) > r && same(d));
  const uppers = DIFFICULTIES.filter((d) => slotRank(d) < r && same(d));
  if (!keptIn(get().diffs[diff], id)) uppers.reverse();
  for (const d of [...lowers, ...uppers]) {
    const s = get();
    const x = s.diffs[d];
    const now = stairsFor(s, d, x.src!);
    const old: StairSets = x.stairs ?? { within: now.within, atLeast: now.atLeast };
    const within = old.within || now.within ? new Set(old.within ?? now.within!) : null;
    if (within) {
      if (!now.within || now.within.has(id)) within.add(id);
      else within.delete(id);
    }
    const atLeast = new Set(old.atLeast);
    if (now.atLeast.has(id)) atLeast.add(id);
    else atLeast.delete(id);
    // あとから押したほうを通す：上の難易度に無くなった音の「残す」、下の難易度に残っている音の「削る」は外す
    const ov = x.overrides.get(id);
    const clash = (ov === 'keep' && within && !within.has(id)) || (ov === 'drop' && atLeast.has(id));
    if (clash) {
      const m = new Map(x.overrides);
      m.delete(id);
      patchDiff(d, { overrides: m });
    }
    const moved = (within?.has(id) ?? true) !== (old.within?.has(id) ?? true) || atLeast.has(id) !== old.atLeast.has(id);
    if (clash || moved || !x.stairs) rebuild(d, { stairs: { within, atLeast } });
  }
}

export function setKeep(patch: Partial<MustKeep>) {
  set((s) => ({ keep: { ...s.keep, ...patch } }));
  rebuildAll();
  // いちばん易しい段のレベル（目標の底上げ）が変わる
  recomputeTargets();
}

/** めやすを手で決める（null で自動に戻す）。幅はめやすの ±1（隣の譜面とは重ねない） */
export function setTarget(diff: Difficulty, center: number | null) {
  const c = center === null || !Number.isFinite(center) ? null : Math.max(1, Math.min(9.9, center));
  patchDiff(diff, { manual: c });
  recomputeTargets();
  // あいだに作る難易度のめやすは、次の曲でもはじめに出す（あなたが遊ぶレベル）
  if (c !== null && insertedSlots(get()).includes(diff)) rememberInsertLevel(c);
}

// ---- 並べて聴く ---------------------------------------------------------------------------

/** 並べる列の中身：元の譜面（開いている譜面）・既存の譜面・作る難易度 */
export type ColumnKind = 'source' | 'existing' | 'made';

export function columnKind(s: Pick<GenState, 'sourceSlot' | 'charts' | 'diffs'>, slot: Slot): ColumnKind | null {
  if (slot === s.sourceSlot) return 'source';
  if (keepsExisting(s, slot)) return 'existing';
  if (slot === 'MASTER' || !isAbove(s.sourceSlot, slot)) return null;
  const ds = s.diffs[slot];
  return ds.enabled || ds.result ? 'made' : null;
}

/** 並べる列（上の難易度から） */
export function compareColumns(s: Pick<GenState, 'sourceSlot' | 'charts' | 'diffs'> = get()): Slot[] {
  return SLOTS.filter((x) => columnKind(s, x) !== null);
}

/** 列の譜面（作っていない難易度は null） */
export function columnDoc(s: Pick<GenState, 'sourceSlot' | 'charts' | 'diffs' | 'master'>, slot: Slot): DtxDoc | null {
  const k = columnKind(s, slot);
  if (k === 'source') return s.master;
  if (k === 'existing') return s.charts[slot]!.doc;
  if (k === 'made') return s.diffs[slot as Difficulty].result?.doc ?? null;
  return null;
}

/** 聴ける譜面（並べている順） */
export function listenChoices(s: GenState = get()): Listen[] {
  return compareColumns(s).filter((x) => columnDoc(s, x));
}

/** 再生で鳴らす譜面を変える。下の難易度なら、右の判定・方針もその難易度にする。再生中なら今の位置から鳴らし直す */
export function setListen(x: Listen) {
  const s = get();
  if (!columnDoc(s, x)) return;
  set(x !== 'MASTER' && x !== s.sourceSlot && belowSource(s).includes(x) ? { listen: x, selected: x } : { listen: x });
}

/** ←→：聴く譜面を隣の列へ */
export function stepListen(dir: 1 | -1) {
  const next = stepIn(listenChoices(), get().listen, dir);
  if (next) setListen(next);
}

/** 難易度を選ぶ（左のカード・列の見出し）。聴ける列なら、その譜面を聴く */
export function selectDiff(d: Difficulty) {
  set((s) => (columnDoc(s, d) ? { selected: d, listen: d } : { selected: d }));
}

/** 鳴らしている譜面（DtxDoc） */
function heardOf(s: GenState): DtxDoc | null {
  return columnDoc(s, s.listen) ?? s.master;
}

/**
 * この画面にいる間は、聴く列の譜面を鳴らす（作った譜面・写した既存の譜面は、開いている譜面からドラムのチップを
 * 入れ替えただけなので、原曲・テンポは同じ。止める所・ループ・▶ はエディタと共通のまま使える）
 */
export function heardGenDoc(doc: DtxDoc): DtxDoc {
  if (useEditor.getState().page !== 'ai') return doc;
  const g = get();
  if (g.listen === g.sourceSlot || doc !== g.master) return doc;
  return columnDoc(g, g.listen) ?? doc;
}
addPlayDocTransform(heardGenDoc);

// 既存の譜面の音（開いている譜面に無い音量違いなど）も読み込む（同じ譜面を開いている間は、ほかの画面にいても残す。
// 音の表は読み込むたびに作り直すので、戻ってきたときに読み直さなくてよいように）
addSoundDocs(() => {
  const g = get();
  if (!g.master || g.master !== useEditor.getState().doc) return [];
  return SLOTS.map((x) => g.charts[x]?.doc).filter((d): d is DtxDoc => !!d);
});

// 聴く譜面を切り替えた・手直しで譜面が変わったら、再生中なら鳴らしていない所から鳴らし直す
useGen.subscribe((g, prev) => {
  if (heardOf(g) !== heardOf(prev) && useEditor.getState().page === 'ai') refreshPlayback();
});

// この画面を離れたら止める（作った譜面の音のまま、ほかの画面で鳴り続けないように。設定・ガイドラインへ移ったときも）
useEditor.subscribe((s, prev) => {
  if (prev.page === 'ai' && s.page !== 'ai' && s.playing) stop();
});

export function setGenView(v: Partial<GenView>) {
  set((s) => ({ view: { ...s.view, ...v } }));
}

useGen.subscribe((g, prev) => {
  if (g.view.fit === prev.view.fit && g.view.px === prev.view.px) return;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ fit: g.view.fit, px: g.view.px }));
  } catch {
    // 覚えられなくても動く
  }
});

/** その拍が見えるように動かす（下から少し上に置く。エディタの譜面と同じ） */
export function genShow(beat: number) {
  setGenView({ scrollBeat: Math.max(-0.5, beat - 2) });
}

// ---- エディタへの反映（書き出し） ------------------------------------------------------------
// 作った難易度は、この画面の中だけにある。「エディタに反映」で曲フォルダに譜面を書き、set.def に載せると、
// エディタの難易度タブに加わって開けるようになる。反映しないまま戻ろうとしたら聞く（leaveGen）。

/**
 * 作った難易度がエディタに入っているか。none: 作っていない（作らない）、pending: 作ったがまだ反映していない、
 * applied: 反映した、changed: 反映のあとに作り直した・手直しした
 */
export type ReflectState = 'none' | 'pending' | 'applied' | 'changed';

export function reflectState(ds: DiffState): ReflectState {
  if (!ds.enabled || !ds.result) return 'none';
  if (!ds.applied) return 'pending';
  return ds.applied.doc === ds.result.doc ? 'applied' : 'changed';
}

/** 作ったのに、まだエディタに反映していない難易度（反映のあとに変えたものも） */
export function unreflected(s: Pick<GenState, 'sourceSlot' | 'diffs'> = get()): Difficulty[] {
  return belowSource(s).filter((d) => {
    const r = reflectState(s.diffs[d]);
    return r === 'pending' || r === 'changed';
  });
}

/**
 * この画面を離れる（エディタに戻る・Esc）。作ってまだ反映していない難易度があれば、反映するか聞く
 * （黙って戻ると、作った難易度がエディタのどこにも出てこない）
 */
export async function leaveGen(): Promise<boolean> {
  const pending = unreflected();
  if (pending.length) {
    const names = pending.join(tr('・', ', '));
    const choice = await chooseDialog<'apply' | 'leave'>({
      title: tr('作った難易度をエディタに反映しますか？', 'Add the new difficulties to the editor?'),
      body: tr(`${names} はまだエディタに入っていません。`, `${names} ${pending.length === 1 ? "isn't" : "aren't"} in the editor yet.`),
      options: [
        {
          label: tr('反映して戻る', 'Add and go back'),
          sub: tr('難易度タブに加わり、エディタで開いて直せます（曲フォルダに譜面を書き、set.def に載せます）', 'They join the difficulty tabs so you can open and edit them (the charts are written to the song folder and listed in set.def)'),
          value: 'apply',
        },
        {
          label: tr('反映せずに戻る', 'Go back without adding'),
          sub: tr('作った結果はこの画面に残ります（エディタで譜面を変えると消えます）', 'The results stay on this page (they are cleared if you change the chart in the editor)'),
          value: 'leave',
        },
      ],
    });
    if (choice === null) return false;
    if (choice === 'apply' && !(await writeOut())) return false;
  }
  goBack();
  return true;
}

const SLOT_INDEX: Record<Slot, number> = { BASIC: 1, ADVANCED: 2, EXTREME: 3, MASTER: 4 };
const DIFF_TOKEN = /^(?:(.*?)([_\-\s.]))?(mstr|master|mas|ext|extreme|adv|advanced|bsc|bas|basic)$/i;

/**
 * 作った難易度のファイル名。元の譜面のファイル名が難易度の名前で終わるなら、そこだけを変える
 * （mstr.dtx → adv.dtx、song-mas.dtx → song-adv.dtx。DTXCreatorAL の -mas の曲は BASIC を -bas に）。
 * そうでなければ後ろに付ける（song.dtx → song_adv.dtx）
 */
export function outFileName(sourceFile: string, diff: Difficulty): string {
  const stem = sourceFile.replace(/\.dtx$/i, '') || 'song';
  const m = DIFF_TOKEN.exec(stem);
  if (m) {
    const head = m[1] ?? '';
    const sep = m[2] ?? '';
    const tok = m[3].toLowerCase();
    const suffix = diff === 'BASIC' ? (tok === 'mas' ? 'bas' : 'bsc') : diff === 'ADVANCED' ? 'adv' : 'ext';
    return `${head}${head || sep ? sep : ''}${suffix}.dtx`;
  }
  return `${stem}_${diff === 'BASIC' ? 'bsc' : diff === 'ADVANCED' ? 'adv' : 'ext'}.dtx`;
}

/** 同じ名前の譜面を上書きしないときの名前（adv.dtx → adv_ai.dtx → adv_ai2.dtx） */
export function variantName(file: string, k: number): string {
  return `${file.replace(/\.dtx$/i, '')}_ai${k > 1 ? k : ''}.dtx`;
}

/** ファイルの譜面が、このアプリで作ってから手を入れていない譜面か（そのときだけ上書きする） */
async function isUneditedAi(f: FolderFile): Promise<boolean> {
  try {
    const text = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer())).text;
    if (!hasOriginLine(text)) return false;
    return originOf(parseDtx(text).doc) === 'ai';
  } catch {
    return false;
  }
}

/**
 * 書き出すファイル名を決める。作者の譜面・手で直した譜面・残す譜面・開いている譜面は上書きしない（別の名前にする）。
 * このアプリで作ってから手を入れていない譜面だけ上書きする
 */
export async function chooseOutFiles(
  folder: SongFolder,
  sourceFile: string,
  made: readonly Difficulty[],
  protect: readonly string[],
  isOverwritable: (f: FolderFile) => Promise<boolean> = isUneditedAi,
  /** 先に試す名前（作り直す、このアプリで作った既存の譜面のファイル） */
  prefer: Partial<Record<Difficulty, string>> = {},
): Promise<{ diff: Difficulty; file: string; overwrite: boolean }[]> {
  const taken = new Set([sourceFile, ...protect].map((x) => x.toLowerCase()));
  const out: { diff: Difficulty; file: string; overwrite: boolean }[] = [];
  for (const diff of made) {
    const own = prefer[diff];
    if (own && !taken.has(own.toLowerCase())) {
      const f = findFile(folder, own);
      if (f && (await isOverwritable(f))) {
        taken.add(own.toLowerCase());
        out.push({ diff, file: f.name, overwrite: true });
        continue;
      }
    }
    const pref = outFileName(sourceFile, diff);
    let name = pref;
    for (let k = 1; k < 100; k++) {
      const lower = name.toLowerCase();
      const f = findFile(folder, name);
      if (!taken.has(lower) && (!f || (await isOverwritable(f)))) break;
      name = variantName(pref, k);
    }
    taken.add(name.toLowerCase());
    out.push({ diff, file: name, overwrite: !!findFile(folder, name) });
  }
  return out;
}

/** set.def の難易度名にする元の譜面の名前（難易度の名前でないもの（DTXMANIA など）はそのまま） */
function sourceSetDefLabel(label: string, slot: Slot): string {
  const s = slotOf(label, '');
  return !label || (s !== null && s !== slot) ? slot : label;
}

/**
 * set.def を作る。作った難易度は決まった段（L1 BASIC〜L4 MASTER）に、元の譜面はその難易度の段に置く。
 * ほかの難易度（残す既存の譜面・L5 など）は元の段に（空いていなければ空いている段に）残す。
 * kept は set.def に載っていなくても残す既存の譜面（set.def が無い曲で、ファイル名から見つけたもの）
 */
export function buildSetDef(
  existing: string | null,
  title: string,
  sourceFile: string,
  sourceLabel: string,
  made: { diff: Difficulty; file: string }[],
  o: { sourceSlot?: Slot; kept?: { slot: Slot; label: string; file: string }[]; moved?: { file: string; to: Slot }[] } = {},
): string {
  const sourceSlot = o.sourceSlot ?? 'MASTER';
  const blocks = existing ? parseSetDef(existing) : [];
  const block = blocks.find((b) => b.levels.some((l) => sameFile(l.file, sourceFile))) ?? blocks[0] ?? null;
  const slots = new Map<number, { label: string; file: string }>();
  const madeFiles = new Set(made.map((m) => m.file.toLowerCase()));
  const movedFiles = new Set((o.moved ?? []).map((m) => m.file.toLowerCase()));
  for (const m of made) slots.set(SLOT_INDEX[m.diff], { label: m.diff, file: m.file });
  slots.set(SLOT_INDEX[sourceSlot], { label: sourceSetDefLabel(sourceLabel, sourceSlot), file: sourceFile });
  // 下へ移した譜面は、移した先の段にその難易度の名前で（ファイルはそのまま）
  for (const m of o.moved ?? []) if (!slots.has(SLOT_INDEX[m.to])) slots.set(SLOT_INDEX[m.to], { label: m.to, file: m.file });
  const rest: { label: string; file: string; at?: number }[] = [];
  for (const l of block?.levels ?? []) {
    if (sameFile(l.file, sourceFile) || madeFiles.has(l.file.toLowerCase()) || movedFiles.has(l.file.toLowerCase())) continue;
    // 作った難易度に置き換わるもの
    const sl = slotOf(l.label, l.file);
    if (sl && sl !== 'MASTER' && made.some((m) => m.diff === sl)) continue;
    rest.push({ label: l.label, file: l.file, at: l.index });
  }
  for (const k of o.kept ?? []) {
    if (sameFile(k.file, sourceFile) || madeFiles.has(k.file.toLowerCase()) || movedFiles.has(k.file.toLowerCase()) || rest.some((r) => sameFile(r.file, k.file))) continue;
    rest.push({ label: k.label, file: k.file, at: SLOT_INDEX[k.slot] });
  }
  for (const r of rest) {
    let at = r.at !== undefined && !slots.has(r.at) ? r.at : undefined;
    for (let i = 1; at === undefined && i <= 5; i++) if (!slots.has(i)) at = i;
    if (at !== undefined) slots.set(at, { label: r.label, file: r.file });
  }
  const lines = [`#TITLE ${block?.title || title}`];
  for (let i = 1; i <= 5; i++) {
    const s = slots.get(i);
    if (!s) continue;
    lines.push(`#L${i}LABEL ${s.label}`, `#L${i}FILE ${s.file}`);
  }
  // 別の曲のブロックはそのまま残す
  const others = blocks.filter((b) => b !== block);
  for (const b of others) {
    lines.push('', `#TITLE ${b.title}`);
    b.levels.forEach((l, i) => lines.push(`#L${l.index ?? i + 1}LABEL ${l.label}`, `#L${l.index ?? i + 1}FILE ${l.file}`));
  }
  return lines.join('\r\n') + '\r\n';
}

/** set.def に今ある難易度のうち、作った譜面に置き換わるもの（同じ難易度で別のファイル。下へ移す譜面は置き換わらない） */
export function replacedInSetDef(existing: string | null, sourceFile: string, made: { diff: Difficulty; file: string }[], movedFiles: readonly string[] = []): { label: string; file: string }[] {
  if (!existing) return [];
  const blocks = parseSetDef(existing);
  const block = blocks.find((b) => b.levels.some((l) => sameFile(l.file, sourceFile))) ?? blocks[0];
  if (!block) return [];
  const madeFiles = new Set(made.map((m) => m.file.toLowerCase()));
  const moved = new Set(movedFiles.map((f) => f.toLowerCase()));
  return block.levels
    .filter((l) => !madeFiles.has(l.file.toLowerCase()) && !moved.has(l.file.toLowerCase()) && !sameFile(l.file, sourceFile) && made.some((m) => m.diff === slotOf(l.label, l.file)))
    .map((l) => ({ label: l.label, file: l.file }));
}

/**
 * エディタに反映する：作った難易度（まだ反映していないもの）を曲フォルダに書き、set.def に載せ、
 * エディタの難易度タブに加える
 */
export async function writeOut(): Promise<boolean> {
  const g = get();
  const s = useEditor.getState();
  const folder = s.folder;
  if (!g.master) return false;
  // 反映したままの難易度は書き直さない（set.def にはもう載っている）
  const made = unreflected(g);
  if (made.length === 0) {
    const done = belowSource(g).some((d) => reflectState(g.diffs[d]) === 'applied');
    toast(done ? tr('作った難易度は、もうエディタに反映しています', 'The new difficulties are already in the editor') : tr('まだ難易度を作っていません', "You haven't made any difficulties yet"), done ? 'info' : 'warn');
    return false;
  }
  if (!folder) {
    toast(tr('先に曲を保存して、曲フォルダを決めてください', 'Save the song first to choose its song folder'), 'warn', 6000);
    return false;
  }
  // 残す既存の譜面（set.def に残す・上書きしない）
  const kept = SLOTS.filter((x) => keepsExisting(g, x)).map((x) => ({ slot: x, label: g.charts[x]!.label, file: g.charts[x]!.file }));
  // 下へ移した譜面（set.def の段と名前だけ変える。ファイルと DTXMania の成績はそのまま）。newlyMoved はまだ set.def に書いていないもの
  const moved = SLOTS.filter((x) => keepsExisting(g, x) && g.charts[x]!.movedFrom).map((x) => ({ to: x, file: g.charts[x]!.file, from: g.charts[x]!.movedFrom!, level: g.charts[x]!.level }));
  const newlyMoved = moved.filter((x) => g.moves.some((m) => !m.written && sameFile(m.file, x.file)));
  // 反映したままの難易度のファイルも上書きしない
  const appliedFiles = belowSource(g)
    .filter((d) => !made.includes(d) && g.diffs[d].applied)
    .map((d) => g.diffs[d].applied!.file);
  // 作り直す譜面が、このアプリで作ってから手を入れていない譜面なら、そのファイルに上書きする（反映したことがあればそのファイル）
  const prefer: Partial<Record<Difficulty, string>> = {};
  for (const d of made) {
    const own = g.diffs[d].applied?.file ?? (g.charts[d]?.origin === 'ai' ? g.charts[d]!.file : undefined);
    if (own) prefer[d] = own;
  }
  const files = await chooseOutFiles(folder, g.masterFile, made, [...kept.map((k) => k.file), ...appliedFiles], undefined, prefer);
  let existing: string | null = null;
  const sd = findFile(folder, 'set.def');
  if (sd) {
    try {
      existing = decodeDtx(new Uint8Array(await (await sd.getFile()).arrayBuffer())).text;
    } catch {
      existing = null;
    }
  }
  // 上書きを聞くのは、この画面で反映したファイル（作り直した・手直しした難易度）以外
  const exists = files.filter((f) => f.overwrite && !sameFile(f.file, g.diffs[f.diff].applied?.file ?? ''));
  const replaced = replacedInSetDef(existing, g.masterFile, files, moved.map((m) => m.file));
  if (exists.length || replaced.length || newlyMoved.length) {
    const sep = tr('、', ', ');
    const body = [
      ...newlyMoved.map((m) =>
        tr(
          `${m.file}（${m.from} Lv ${m.level.toFixed(2)}）を ${m.to} に移します。ファイルはそのままで、DTXMania の成績も付いたままです。`,
          `${m.file} (${m.from}, Lv ${m.level.toFixed(2)}) moves to ${m.to}. The file stays as it is, and so do your DTXMania records for it.`,
        ),
      ),
      ...files
        .filter((f) => newlyMoved.some((m) => m.from === f.diff))
        .map((f) => tr(`新しい ${f.diff} は ${f.file} に書きます。`, `The new ${f.diff} is written to ${f.file}.`)),
      exists.length
        ? tr(
            `${exists.map((f) => f.file).join(sep)} を上書きします（このアプリで作ってから手を入れていない譜面です）。`,
            `This overwrites ${exists.map((f) => f.file).join(sep)} (made by this app and not edited since).`,
          )
        : '',
      replaced.length
        ? tr(
            `set.def の ${replaced.map((l) => `${l.label}（${l.file}）`).join(sep)} を、作った譜面に置き換えます（元の譜面のファイルは消しません）。`,
            `In set.def, ${replaced.map((l) => `${l.label} (${l.file})`).join(sep)} will point to the new charts (the old chart files are not deleted).`,
          )
        : '',
      tr('よろしいですか？', 'Continue?'),
    ]
      .filter(Boolean)
      .join('\n');
    const ok = await confirmDialog({
      title: exists.length
        ? tr('同じ名前の譜面があります', 'Charts with the same names exist')
        : newlyMoved.length && !replaced.length
          ? tr('set.def の難易度を移します', 'Move difficulties in set.def')
          : tr('set.def の難易度を置き換えます', 'Replace difficulties in set.def'),
      body,
      ok: exists.length ? tr('上書き', 'Overwrite') : newlyMoved.length && !replaced.length ? tr('移して反映', 'Move and add') : tr('置き換える', 'Replace'),
      danger: !!(exists.length || replaced.length),
    });
    if (!ok) return false;
  }
  let memory = false;
  // どの難易度も、元の譜面と同じ所で曲を終える（原曲の鳴り終わりに合わせているときも）
  const end = songEndMeasure(g.master);
  for (const { diff, file } of files) {
    const ds = g.diffs[diff];
    const doc: DtxDoc = structuredClone(ds.result!.doc);
    if (end > 0) doc.endMeasure = end;
    // エディタの推定レベルと同じ計算（開くと「確かめる」の推定と同じ値）
    setField(doc, 'DLEVEL', levelToField(calcLevel(ds)));
    // このアプリで作った印（NX の表示は変わらない）
    markOrigin(doc, ds.src?.file ?? g.masterFile);
    const { bytes } = encodeDtx(serializeDtx(doc), 'shift_jis');
    if ((await putFile(folder, file, bytes)) === 'memory') memory = true;
  }
  const text = buildSetDef(existing, g.master.fields['TITLE'] || g.masterFile, g.masterFile, g.masterLabel, files, {
    sourceSlot: g.sourceSlot,
    kept,
    moved: moved.map((m) => ({ file: m.file, to: m.to })),
  });
  if ((await putFile(folder, 'set.def', encodeDtx(text, 'shift_jis').bytes)) === 'memory') memory = true;
  // 反映した印（このあと作り直す・手直しすると「反映のあとに変えた」になる）
  for (const { diff, file } of files) patchDiff(diff, { applied: { file, doc: g.diffs[diff].result!.doc } });
  // 移した譜面は set.def に書いたので、もう戻さない
  if (newlyMoved.length) set((st) => ({ moves: st.moves.map((m) => (m.written ? m : { ...m, written: true })) }));
  // 難易度の切り替えタブを更新する（易しい順。作った譜面には AI の印）
  const labels = new Map<string, string>();
  for (const b of parseSetDef(text)) for (const l of b.levels) labels.set(l.file.toLowerCase(), l.label);
  const written = new Set(files.map((f) => f.file.toLowerCase()));
  useEditor.setState((st) => {
    const prevOrigin = new Map(st.meta.siblings.map((x) => [x.file.toLowerCase(), x.origin]));
    return {
      meta: {
        ...st.meta,
        siblings: sortByDifficulty(
          dtxFiles(folder).map((f) => ({
            file: f.name,
            label: labels.get(f.name.toLowerCase()) ?? f.name.replace(/\.dtx$/i, ''),
            origin: written.has(f.name.toLowerCase()) ? ('ai' as const) : prevOrigin.get(f.name.toLowerCase()),
          })),
          [...labels.keys()],
        ),
      },
    };
  });
  const names = files.map((f) => f.diff).join(tr('・', ', '));
  const list = files.map((f) => f.file).join(tr('・', ', '));
  const movedText = newlyMoved.map((m) => tr(`${m.from}（${m.file}）を ${m.to} に移し、`, `Moved ${m.from} (${m.file}) to ${m.to}. `)).join('');
  // 「開く」は、この画面で最後に見ていた難易度（反映したものの中に無ければ最初のもの）
  const open = files.find((f) => f.diff === get().selected) ?? files[0];
  toast(
    movedText +
    tr(
      `${names} をエディタに反映しました。難易度の切り替えから開けます（${memory ? `${list} と set.def は、保存（Ctrl+S）で曲フォルダに書き出します` : `曲フォルダに ${list} と set.def を書きました`}）`,
      `Added ${names} to the editor. Open ${files.length === 1 ? 'it' : 'them'} from the difficulty switcher (${memory ? `${list} and set.def are written to the song folder when you save (Ctrl+S)` : `wrote ${list} and set.def to the song folder`})`,
    ),
    'ok',
    14000,
    { label: tr(`${open.diff} を開く`, `Open ${open.diff}`), run: () => void openReflected(open.file) },
  );
  // エディタに戻ったら、増えた難易度・移した難易度のタブを光らせる
  glowReflected({ diffs: [...files.map((f) => f.file), ...newlyMoved.map((m) => m.file)] });
  return true;
}

/** 反映した難易度をエディタで開く（この画面にいれば、離れてから。まだ反映していない難易度があれば聞く） */
async function openReflected(file: string) {
  if (useEditor.getState().page === 'ai' && !(await leaveGen())) return;
  const { switchDifficulty } = await import('../app/fileActions');
  await switchDifficulty(file);
}
