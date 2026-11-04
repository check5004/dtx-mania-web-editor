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
import { DEFAULT_KEEP, DEFAULT_RUNG, DIFFICULTIES, generateToTarget, levelOfDoc, MAX_EASE, MAX_RUNG, simplify, type Difficulty, type Generated, type MustKeep } from '../gen/simplify';
import { aimOf, isAbove, SLOTS, slotOf, slotRank, targetBands, type Slot, type TargetBand } from '../gen/targets';
import { confirmDialog } from '../ui/dialogs';
import { hasAiKey, runAi } from './ai';
import { judgeDoc, type JudgeResult } from './aiLevel';
import { levelOf } from './check';
import { addPlayDocTransform, addSoundDocs, prepareSounds, refreshPlayback, songEndMeasure, stop, toast, useEditor } from './editor';
import { bandOf, guidelineText, levelOfField, loadGuideline, useGuideline } from './guideline';
import { useSidecar } from './sidecar';

/** 作る元の譜面（いま開いている譜面か、作り直さない既存の譜面） */
export interface SourceRef {
  slot: Slot;
  file: string;
  doc: DtxDoc;
  /** 登録レベル ÷ 機械的な推定（作った譜面の計算値にかけて登録レベルの目盛りにする） */
  calib: number;
  level: number;
}

/** 曲に既にあるほかの難易度 */
export interface ExistingChart {
  slot: Slot;
  /** set.def の難易度名（無ければ難易度） */
  label: string;
  file: string;
  /** いま開いている譜面の時間の並び・WAV 番号の上に写した譜面（gen/project） */
  doc: DtxDoc;
  /** 登録レベル（#DLEVEL）。無ければ推定 × 開いている譜面の倍率 */
  level: number;
  registered: boolean;
  /** 作者の譜面か、このアプリで作った譜面か */
  origin: ChartOrigin;
  calib: number;
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
  /** いま開いている譜面の難易度（set.def の難易度名かファイル名から。分からなければ MASTER） */
  sourceSlot: Slot;
  /** 登録レベル ÷ 機械的な推定（開いている譜面で合わせる倍率） */
  calib: number;
  spans: SectionSpan[];
  /** 曲に既にあるほかの難易度 */
  charts: Partial<Record<Slot, ExistingChart>>;
  chartsLoading: boolean;
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
  sourceSlot: 'MASTER',
  calib: 1,
  spans: [],
  charts: {},
  chartsLoading: false,
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

const clampCalib = (x: number) => Math.max(0.6, Math.min(1.6, x));
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

/** レベルが決まっている譜面（開いている譜面と、残す既存の譜面） */
export function knownLevels(s: GenState = get()): Partial<Record<Slot, number>> {
  const k: Partial<Record<Slot, number>> = { [s.sourceSlot]: s.masterLevel };
  for (const slot of SLOTS) if (keepsExisting(s, slot)) k[slot] = s.charts[slot]!.level;
  return k;
}

/** 作る元：いちばん近い上の、残す譜面（開いている譜面か、作り直さない既存の譜面） */
export function sourceFor(s: GenState, d: Difficulty): SourceRef | null {
  if (!s.master) return null;
  const open: SourceRef = { slot: s.sourceSlot, file: s.masterFile, doc: s.master, calib: s.calib, level: s.masterLevel };
  for (const slot of SLOTS.slice(0, slotRank(d)).reverse()) {
    if (slot === s.sourceSlot) return open;
    const c = s.charts[slot];
    if (c && keepsExisting(s, slot)) return { slot, file: c.file, doc: c.doc, calib: c.calib, level: c.level };
  }
  return open;
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
  return lv * src.calib;
}

/** 目標の幅を決め直す（既存の譜面を読んだ・作り直すかを変えた・必ず残すものを変えた・めやすを手で変えた） */
export function recomputeTargets() {
  const s = get();
  if (!s.master) return;
  const known = knownLevels(s);
  const make = belowSource(s).filter((d) => known[d] === undefined);
  const manual: Partial<Record<Difficulty, number>> = {};
  for (const d of make) if (s.diffs[d].manual !== null) manual[d] = s.diffs[d].manual!;
  const bands = targetBands({ known, make, floor: known.BASIC === undefined ? floorOf(s) : null, manual });
  set((st) => {
    const diffs = { ...st.diffs };
    for (const d of DIFFICULTIES) if (bands[d]) diffs[d] = { ...diffs[d], target: bands[d]! };
    return { diffs };
  });
}

/** 画面を開いたとき：いまの譜面を元の譜面にする（同じ譜面なら前の結果を残す）。曲に既にある難易度を読む */
let loadToken = 0;
export function initGen() {
  void loadGuideline();
  const s = useEditor.getState();
  const g = get();
  if (g.master === s.doc) return;
  const doc = s.doc;
  const mech = levelOfDoc(doc);
  const masterLevel = levelOfField(doc.fields['DLEVEL']) ?? levelOf(doc)?.level ?? mech;
  const calib = clampCalib(masterLevel / Math.max(0.5, mech));
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
    sourceSlot,
    calib,
    spans,
    charts: {},
    chartsLoading: !!s.folder,
    diffs: freshDiffs(sourceSlot),
    selected: below.includes('ADVANCED') ? 'ADVANCED' : (below[0] ?? 'BASIC'),
    listen: sourceSlot,
    // 表示は ▶（再生を始める位置）から。エディタで見ていた所から聴ける
    view: { ...get().view, scrollBeat: Math.max(-0.5, s.cursorBeat - 2) },
  });
  recomputeTargets();
  if (s.folder) void loadCharts(s.folder, ++loadToken);
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
      // 計算のレベルは写した譜面で（下の難易度を作るときに測るのも写した譜面なので、倍率がそろう）
      const mech = levelOfDoc(projected[i]);
      const reg = levelOfField(x.doc.fields['DLEVEL']);
      charts[x.slot] = {
        slot: x.slot,
        label: x.label,
        file: x.file,
        doc: projected[i],
        level: reg ?? Math.min(9.99, mech * g.calib),
        registered: reg !== null,
        origin: originOf(x.doc),
        calib: reg !== null ? clampCalib(reg / Math.max(0.5, mech)) : g.calib,
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
  patchDiff(d, { enabled: on });
  // 既存の譜面を残すか作り直すかで、ほかの難易度の目標と作る元が変わる
  if (get().charts[d]) recomputeTargets();
  const s = get();
  if (!columnDoc(s, s.listen)) set({ listen: s.sourceSlot });
}

function defaultPlan(spans: SectionSpan[]): DifficultyPlan {
  return {
    summary: tr(
      '標準の方針です。機械的な推定が目標のめやすの近くに入るまで簡略化の段を上げ下げし、段のあいだは4小節のうち何小節かだけ次の段にして合わせます。',
      'Standard plan: the simplification step goes up or down until the computed estimate lands near the target; between two steps, only some of every 4 measures use the next step to fine-tune.',
    ),
    sections: spans.map((s) => ({ name: s.name, from: s.from, to: s.to, shift: 0 })),
  };
}

/** 目標より難しくなる指定（元に近く・フィルを残す）を外した方針。外すものが無ければ null */
export function relaxPlan(plan: DifficultyPlan): DifficultyPlan | null {
  const strong = (s: DifficultyPlan['sections'][number]) => s.shift < 0 || s.fill === 'keep' || s.fill === 'thin';
  if (!plan.sections.some(strong)) return null;
  return {
    summary: `${plan.summary}${plan.summary ? ' ' : ''}${tr(
      '（この方針では目標のレベルまで簡単にできなかったので、「元の譜面に近く」「フィルを残す」の指定を外して作りました）',
      '(This plan could not get down to the target level, so it was made without the “closer to the original” and “keep fills” settings.)',
    )}`,
    sections: plan.sections.map((s) => ({ ...s, shift: Math.max(0, s.shift), fill: s.fill === 'keep' || s.fill === 'thin' ? undefined : s.fill })),
  };
}

/** 目標の幅からどれだけ外れているか（中なら 0） */
function targetGap(lv: number, t: { min: number; max: number }) {
  return lv < t.min ? t.min - lv : lv > t.max ? lv - t.max : 0;
}

function inTarget(lv: number, t: { min: number; max: number }) {
  return lv >= t.min - 1e-9 && lv <= t.max + 1e-9;
}

/** 計算のレベル（登録レベルの目盛りに合わせたもの） */
export function calcLevel(ds: DiffState, calib = ds.src?.calib ?? get().calib): number {
  return ds.result ? Math.min(9.99, ds.result.level * calib) : 0;
}

/** 書き出しと判定に使うレベル：AI の判定があればそれ、無ければ計算 */
export function shownLevel(ds: DiffState, calib = ds.src?.calib ?? get().calib): number {
  return ds.judge && !ds.judgeStale ? ds.judge.level : calcLevel(ds, calib);
}

export function isPassing(ds: DiffState, calib = ds.src?.calib ?? get().calib): boolean {
  return !!ds.result && ds.issues === 0 && inTarget(shownLevel(ds, calib), ds.target);
}

function issueCount(doc: DtxDoc): number {
  return findIssues(doc, buildTempoMap(doc)).filter((i) => i.level === 'error').length;
}

/** 難易度の名前（画面・AI に渡す。既存の譜面なら作者の譜面か AI で作った譜面か） */
export function slotLabel(s: GenState, slot: Slot): string {
  if (slot === s.sourceSlot) return s.masterLabel;
  return s.charts[slot]?.label ?? slot;
}

/** 曲にあるほかの難易度（AI の方針に渡す。作る元の譜面は別の行で渡すので除く） */
function othersForPlan(s: GenState, d: Difficulty, src: Slot): string[] {
  const out: string[] = [];
  const known = knownLevels(s);
  for (const slot of SLOTS) {
    if (slot === d || slot === src || known[slot] === undefined) continue;
    const c = s.charts[slot];
    // i18n-ignore-start（AI へのプロンプト）
    const who = slot === s.sourceSlot ? '開いている譜面' : c?.origin === 'human' ? '既存・作者の譜面' : '既存・このアプリで作った譜面';
    out.push(`${slot}（${who}）Lv${known[slot]!.toFixed(2)}`);
    // i18n-ignore-end
  }
  return out;
}

/** 1つの難易度を作る（AI の方針 → ルールで配置 → めやすに入るまで段を調整 → AI 判定 → 幅から外れたら1回だけ直す） */
export async function generate(diff: Difficulty, opts: { useAi?: boolean } = {}) {
  const g = get();
  if (!g.master || !belowSource(g).includes(diff)) return;
  const src = sourceFor(g, diff)!;
  const ds = g.diffs[diff];
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
          masterLevel: src.level,
          others: othersForPlan(g, diff, src.slot),
          rung: DEFAULT_RUNG[diff],
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
      plan = cleanPlan(r.data, g.spans, diff);
      planSource = 'ai';
    }
    patchDiff(diff, { status: 'building', plan, planSource, cost });
    // 2. 配置と再調整（機械的な推定で、めやすの近くを狙う。幅の中なら合格）
    let base = { doc: src.doc, sections: plan.sections, keep: get().keep, overrides };
    const calib = src.calib;
    const t = ds.target;
    const aim = aimOf(t);
    const rawAim = { min: aim.min / calib, max: aim.max / calib };
    let result = generateToTarget(base, DEFAULT_RUNG[diff], rawAim);
    // AI の方針（元に近く・フィルを残す）が強すぎて、いちばん簡単な段でも幅に入らないときは、それを外して作り直す
    if (result.level * calib > t.max + 1e-9) {
      const relaxed = relaxPlan(plan);
      if (relaxed) {
        const base2 = { ...base, sections: relaxed.sections };
        const r2 = generateToTarget(base2, DEFAULT_RUNG[diff], rawAim);
        if (r2.level < result.level) {
          result = r2;
          base = base2;
          plan = relaxed;
        }
      }
    }
    // 3. AI 判定。幅から外れたら、AI と計算のずれのぶん狙いを動かして1回だけ作り直す（段のあいだの細かい調整も使う）。
    //    AI の判定は 0.1〜0.2 ほどぶれるので、作り直しはめやすを狙い、2つのうち幅に近い方を採る。
    let judge: JudgeResult | null = null;
    if (useAi) {
      patchDiff(diff, { status: 'judging', result, issues: issueCount(result.doc), src });
      const sections = useSidecar.getState().sections;
      judge = await judgeDoc(result.doc, { title, label: diff, sections, mech: result.level * calib, quiet: true });
      if (judge) {
        cost += judge.cost;
        if (!inTarget(judge.level, t)) {
          const center = t.center - (judge.level - result.level * calib);
          const r2 = generateToTarget(base, result.rung, { min: (center - 0.1) / calib, max: (center + 0.1) / calib });
          if (r2.rung !== result.rung || r2.ease !== result.ease) {
            const j2 = await judgeDoc(r2.doc, { title, label: diff, sections, mech: r2.level * calib, quiet: true });
            if (j2) {
              cost += j2.cost;
              if (targetGap(j2.level, t) <= targetGap(judge.level, t)) {
                result = { ...r2, tries: [...result.tries, ...r2.tries] };
                judge = j2;
              }
            }
          }
        }
      }
    }
    patchDiff(diff, { status: 'done', plan, result, judge, issues: issueCount(result.doc), cost, src });
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
    for (const d of belowSource()) if (get().diffs[d].enabled) await generate(d);
  } finally {
    set({ busy: false });
  }
}

/** 方針はそのままで作り直す（手直し・必ず残すものの変更のあと） */
export function rebuild(diff: Difficulty) {
  const g = get();
  const ds = g.diffs[diff];
  if (!ds.src || !ds.result || !ds.plan) return;
  const r = simplify({ doc: ds.src.doc, rung: ds.result.rung, ease: ds.result.ease, sections: ds.plan.sections, keep: g.keep, overrides: ds.overrides });
  const level = levelOfDoc(r.doc);
  patchDiff(diff, { result: { ...ds.result, ...r, level }, issues: issueCount(r.doc), judgeStale: !!ds.judge });
}

/** 簡略化の段を手で上げ下げする */
export function shiftRung(diff: Difficulty, d: 1 | -1) {
  const ds = get().diffs[diff];
  if (!ds.result) return;
  // 細かい調整があれば先にそれを動かす（易しく: 0→1→2→3→次の段、難しく: その逆）
  let rung = ds.result.rung;
  let ease = ds.result.ease + d;
  if (ease > MAX_EASE) (rung += 1), (ease = 0);
  else if (ease < 0) (rung -= 1), (ease = rung >= 0 ? MAX_EASE : 0);
  if (rung < 0) (rung = 0), (ease = 0);
  if (rung > MAX_RUNG) (rung = MAX_RUNG), (ease = 0);
  patchDiff(diff, { result: { ...ds.result, rung, ease } });
  rebuild(diff);
}

/** 比較の譜面のチップを押したとき：消えたものは戻し、残ったものは消す */
export function toggleChip(diff: Difficulty, id: number) {
  const ds = get().diffs[diff];
  if (!ds.result) return;
  const fate = ds.result.fate.get(id);
  if (!fate) return;
  const ov = new Map(ds.overrides);
  const cur = ov.get(id);
  if (cur) ov.delete(id);
  else ov.set(id, fate.kind === 'removed' ? 'keep' : 'drop');
  patchDiff(diff, { overrides: ov });
  rebuild(diff);
}

export function setKeep(patch: Partial<MustKeep>) {
  set((s) => ({ keep: { ...s.keep, ...patch } }));
  for (const d of DIFFICULTIES) rebuild(d);
  // いちばん易しい段のレベル（目標の底上げ）が変わる
  recomputeTargets();
}

/** めやすを手で決める（null で自動に戻す）。幅はめやすの ±1（隣の譜面とは重ねない） */
export function setTarget(diff: Difficulty, center: number | null) {
  const c = center === null || !Number.isFinite(center) ? null : Math.max(1, Math.min(9.9, center));
  patchDiff(diff, { manual: c });
  recomputeTargets();
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

// ---- 書き出し ---------------------------------------------------------------------------

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
  o: { sourceSlot?: Slot; kept?: { slot: Slot; label: string; file: string }[] } = {},
): string {
  const sourceSlot = o.sourceSlot ?? 'MASTER';
  const blocks = existing ? parseSetDef(existing) : [];
  const block = blocks.find((b) => b.levels.some((l) => sameFile(l.file, sourceFile))) ?? blocks[0] ?? null;
  const slots = new Map<number, { label: string; file: string }>();
  const madeFiles = new Set(made.map((m) => m.file.toLowerCase()));
  for (const m of made) slots.set(SLOT_INDEX[m.diff], { label: m.diff, file: m.file });
  slots.set(SLOT_INDEX[sourceSlot], { label: sourceSetDefLabel(sourceLabel, sourceSlot), file: sourceFile });
  const rest: { label: string; file: string; at?: number }[] = [];
  for (const l of block?.levels ?? []) {
    if (sameFile(l.file, sourceFile) || madeFiles.has(l.file.toLowerCase())) continue;
    // 作った難易度に置き換わるもの
    const sl = slotOf(l.label, l.file);
    if (sl && sl !== 'MASTER' && made.some((m) => m.diff === sl)) continue;
    rest.push({ label: l.label, file: l.file, at: l.index });
  }
  for (const k of o.kept ?? []) {
    if (sameFile(k.file, sourceFile) || madeFiles.has(k.file.toLowerCase()) || rest.some((r) => sameFile(r.file, k.file))) continue;
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

/** set.def に今ある難易度のうち、作った譜面に置き換わるもの（同じ難易度で別のファイル） */
export function replacedInSetDef(existing: string | null, sourceFile: string, made: { diff: Difficulty; file: string }[]): { label: string; file: string }[] {
  if (!existing) return [];
  const blocks = parseSetDef(existing);
  const block = blocks.find((b) => b.levels.some((l) => sameFile(l.file, sourceFile))) ?? blocks[0];
  if (!block) return [];
  const madeFiles = new Set(made.map((m) => m.file.toLowerCase()));
  return block.levels
    .filter((l) => !madeFiles.has(l.file.toLowerCase()) && !sameFile(l.file, sourceFile) && made.some((m) => m.diff === slotOf(l.label, l.file)))
    .map((l) => ({ label: l.label, file: l.file }));
}

/** 作った難易度を曲フォルダに書き出し、set.def を更新する */
export async function writeOut(): Promise<boolean> {
  const g = get();
  const s = useEditor.getState();
  const folder = s.folder;
  if (!g.master) return false;
  const made = belowSource(g).filter((d) => g.diffs[d].enabled && g.diffs[d].result);
  if (made.length === 0) {
    toast(tr('まだ難易度を作っていません', "You haven't made any difficulties yet"), 'warn');
    return false;
  }
  if (!folder) {
    toast(tr('先に曲を保存して、曲フォルダを決めてください', 'Save the song first to choose its song folder'), 'warn', 6000);
    return false;
  }
  // 残す既存の譜面（set.def に残す・上書きしない）
  const kept = SLOTS.filter((x) => keepsExisting(g, x)).map((x) => ({ slot: x, label: g.charts[x]!.label, file: g.charts[x]!.file }));
  // 作り直す譜面が、このアプリで作ってから手を入れていない譜面なら、そのファイルに上書きする
  const prefer: Partial<Record<Difficulty, string>> = {};
  for (const d of made) if (g.charts[d]?.origin === 'ai') prefer[d] = g.charts[d]!.file;
  const files = await chooseOutFiles(folder, g.masterFile, made, kept.map((k) => k.file), undefined, prefer);
  let existing: string | null = null;
  const sd = findFile(folder, 'set.def');
  if (sd) {
    try {
      existing = decodeDtx(new Uint8Array(await (await sd.getFile()).arrayBuffer())).text;
    } catch {
      existing = null;
    }
  }
  const exists = files.filter((f) => f.overwrite);
  const replaced = replacedInSetDef(existing, g.masterFile, files);
  if (exists.length || replaced.length) {
    const sep = tr('、', ', ');
    const body = [
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
      title: exists.length ? tr('同じ名前の譜面があります', 'Charts with the same names exist') : tr('set.def の難易度を置き換えます', 'Replace difficulties in set.def'),
      body,
      ok: exists.length ? tr('上書き', 'Overwrite') : tr('置き換える', 'Replace'),
      danger: true,
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
    setField(doc, 'DLEVEL', levelToField(shownLevel(ds)));
    // このアプリで作った印（NX の表示は変わらない）
    markOrigin(doc, ds.src?.file ?? g.masterFile);
    const { bytes } = encodeDtx(serializeDtx(doc), 'shift_jis');
    if ((await putFile(folder, file, bytes)) === 'memory') memory = true;
  }
  const text = buildSetDef(existing, g.master.fields['TITLE'] || g.masterFile, g.masterFile, g.masterLabel, files, { sourceSlot: g.sourceSlot, kept });
  if ((await putFile(folder, 'set.def', encodeDtx(text, 'shift_jis').bytes)) === 'memory') memory = true;
  // 難易度の切り替えタブを更新する（作った譜面には AI の印）
  const labels = new Map<string, string>();
  for (const b of parseSetDef(text)) for (const l of b.levels) labels.set(l.file.toLowerCase(), l.label);
  const written = new Set(files.map((f) => f.file.toLowerCase()));
  useEditor.setState((st) => {
    const prevOrigin = new Map(st.meta.siblings.map((x) => [x.file.toLowerCase(), x.origin]));
    return {
      meta: {
        ...st.meta,
        siblings: dtxFiles(folder).map((f) => ({
          file: f.name,
          label: labels.get(f.name.toLowerCase()) ?? f.name.replace(/\.dtx$/i, ''),
          origin: written.has(f.name.toLowerCase()) ? ('ai' as const) : prevOrigin.get(f.name.toLowerCase()),
        })),
      },
    };
  });
  toast(
    tr(
      `${files.map((f) => `${f.diff}（${f.file}）`).join('、')} と set.def を${memory ? '作りました。保存（Ctrl+S）で曲フォルダに書き出します' : '曲フォルダに書き出しました'}`,
      `${memory ? 'Made' : 'Wrote'} ${files.map((f) => `${f.diff} (${f.file})`).join(', ')} and set.def${memory ? '. Save (Ctrl+S) to write them to the song folder' : ' to the song folder'}`,
    ),
    'ok',
    8000,
  );
  return true;
}
