// AI 難易度生成：MASTER（いま開いている譜面）から BASIC・ADVANCED・EXTREME を作り、比べて手直しし、set.def と一緒に書き出す。
// AI は区間ごとの方針だけを決め、配置は gen/simplify のルールで行う。キーが無ければ標準の方針で作る。
import { create } from 'zustand';
import { cleanPlan, PLAN_SCHEMA, planPrompt, sectionSpans, type DifficultyPlan, type SectionSpan } from '../ai/judge';
import { AiError } from '../ai/openrouter';
import { findIssues } from '../check/playability';
import { levelToField } from '../check/level';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import type { DtxDoc } from '../dtx/model';
import { serializeDtx } from '../dtx/serialize';
import { buildTempoMap } from '../dtx/timing';
import { setField } from '../edit/ops';
import { dtxFiles, findFile, parseSetDef, putFile } from '../fs/folder';
import { lastMeasure } from '../gen/features';
import { DEFAULT_KEEP, DEFAULT_RUNG, DIFFICULTIES, generateToTarget, levelOfDoc, MAX_EASE, MAX_RUNG, simplify, targetRange, type Difficulty, type Generated, type MustKeep } from '../gen/simplify';
import { confirmDialog } from '../ui/dialogs';
import { hasAiKey, runAi } from './ai';
import { judgeDoc, type JudgeResult } from './aiLevel';
import { levelOf } from './check';
import { toast, useEditor } from './editor';
import { bandOf, guidelineText, levelOfField, loadGuideline, useGuideline } from './guideline';
import { useSidecar } from './sidecar';

export interface DiffState {
  diff: Difficulty;
  enabled: boolean;
  target: { min: number; max: number; center: number };
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
}

export interface GenState {
  master: DtxDoc | null;
  masterFile: string;
  masterLabel: string;
  masterLevel: number;
  /** 登録レベル ÷ 機械的な推定（元譜面で合わせる倍率。作った譜面の計算値にかけて登録レベルの目盛りにする） */
  calib: number;
  spans: SectionSpan[];
  diffs: Record<Difficulty, DiffState>;
  selected: Difficulty;
  keep: MustKeep;
  instruction: string;
  /** 比べる窓の最初の小節 */
  win: number;
  busy: boolean;
}

const emptyDiff = (diff: Difficulty, masterLevel: number): DiffState => ({
  diff,
  enabled: true,
  target: targetRange(diff, masterLevel),
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
});

export const useGen = create<GenState>(() => ({
  master: null,
  masterFile: '',
  masterLabel: 'MASTER',
  masterLevel: 5,
  calib: 1,
  spans: [],
  diffs: { EXTREME: emptyDiff('EXTREME', 5), ADVANCED: emptyDiff('ADVANCED', 5), BASIC: emptyDiff('BASIC', 5) },
  selected: 'ADVANCED',
  keep: { ...DEFAULT_KEEP },
  instruction: '',
  win: 0,
  busy: false,
}));
const get = useGen.getState;
const set = useGen.setState;

function patchDiff(d: Difficulty, patch: Partial<DiffState>) {
  set((s) => ({ diffs: { ...s.diffs, [d]: { ...s.diffs[d], ...patch } } }));
}

/** 画面を開いたとき：いまの譜面を MASTER にする（同じ譜面なら前の結果を残す） */
export function initGen() {
  void loadGuideline();
  const s = useEditor.getState();
  const g = get();
  if (g.master === s.doc) return;
  const doc = s.doc;
  const mech = levelOfDoc(doc);
  const masterLevel = levelOfField(doc.fields['DLEVEL']) ?? levelOf(doc)?.level ?? mech;
  const calib = Math.max(0.6, Math.min(1.6, masterLevel / Math.max(0.5, mech)));
  const last = lastMeasure(doc);
  const spans = sectionSpans(useSidecar.getState().sections, last);
  const base = s.meta.fileName.replace(/\.dtx$/i, '').toLowerCase();
  const found = s.meta.siblings.find((x) => x.file.toLowerCase() === s.meta.fileName.toLowerCase())?.label;
  // set.def にラベルが無いときはファイル名が入っているので MASTER にする
  const label = found && found.toLowerCase() !== base ? found : 'MASTER';
  // 比べる窓：いちばん密なセクションの頭
  const tempo = buildTempoMap(doc);
  let win = 0;
  let best = -1;
  for (const sp of spans) {
    const n = doc.chips.filter((c) => c.m >= sp.from && c.m <= sp.to).length;
    const secs = Math.max(1, tempo.beatToSec(tempo.measureStart(sp.to + 1)) - tempo.beatToSec(tempo.measureStart(sp.from)));
    if (n / secs > best) (best = n / secs), (win = sp.from);
  }
  set({
    master: doc,
    masterFile: s.meta.fileName,
    masterLabel: label,
    masterLevel,
    calib,
    spans,
    diffs: { EXTREME: emptyDiff('EXTREME', masterLevel), ADVANCED: emptyDiff('ADVANCED', masterLevel), BASIC: emptyDiff('BASIC', masterLevel) },
    win,
  });
}

function defaultPlan(spans: SectionSpan[]): DifficultyPlan {
  return { summary: '標準の方針です。機械的な推定が目標のレベルに入るまで簡略化の段を上げ下げし、段のあいだは4小節のうち何小節かだけ次の段にして合わせます。', sections: spans.map((s) => ({ name: s.name, from: s.from, to: s.to, shift: 0 })) };
}

/** 目標より難しくなる指定（元に近く・フィルを残す・ライドを残す）を外した方針。外すものが無ければ null */
export function relaxPlan(plan: DifficultyPlan): DifficultyPlan | null {
  const strong = (s: DifficultyPlan['sections'][number]) => s.shift < 0 || s.fill === 'keep' || s.fill === 'thin' || !!s.keepRide;
  if (!plan.sections.some(strong)) return null;
  return {
    summary: `${plan.summary}${plan.summary ? ' ' : ''}（この方針では目標のレベルまで簡単にできなかったので、「元の譜面に近く」「フィルを残す」「ライドを残す」の指定を外して作りました）`,
    sections: plan.sections.map((s) => ({ ...s, shift: Math.max(0, s.shift), fill: s.fill === 'keep' || s.fill === 'thin' ? undefined : s.fill, keepRide: false })),
  };
}

/** 目標の帯からどれだけ外れているか（中なら 0） */
function targetGap(lv: number, t: { min: number; max: number }) {
  return lv < t.min ? t.min - lv : lv > t.max ? lv - t.max : 0;
}

function inTarget(lv: number, t: { min: number; max: number }) {
  return lv >= t.min - 1e-9 && lv <= t.max + 1e-9;
}

/** 計算のレベル（登録レベルの目盛りに合わせたもの） */
export function calcLevel(ds: DiffState, calib = get().calib): number {
  return ds.result ? Math.min(9.99, ds.result.level * calib) : 0;
}

/** 書き出しと判定に使うレベル：AI の判定があればそれ、無ければ計算 */
export function shownLevel(ds: DiffState, calib = get().calib): number {
  return ds.judge && !ds.judgeStale ? ds.judge.level : calcLevel(ds, calib);
}

export function isPassing(ds: DiffState, calib = get().calib): boolean {
  return !!ds.result && ds.issues === 0 && inTarget(shownLevel(ds, calib), ds.target);
}

function issueCount(doc: DtxDoc): number {
  return findIssues(doc, buildTempoMap(doc)).filter((i) => i.level === 'error').length;
}

/** 1つの難易度を作る（AI の方針 → ルールで配置 → 目標に入るまで段を調整 → AI 判定 → 外れたら1回だけ直す） */
export async function generate(diff: Difficulty, opts: { useAi?: boolean } = {}) {
  const g = get();
  if (!g.master) return;
  const master = g.master;
  const ds = g.diffs[diff];
  const useAi = (opts.useAi ?? true) && hasAiKey();
  const title = master.fields['TITLE'] || g.masterFile;
  patchDiff(diff, { status: useAi ? 'planning' : 'building', error: null, judge: null, judgeStale: false, cost: 0 });
  let cost = 0;
  try {
    // 1. 方針
    let plan = defaultPlan(g.spans);
    let planSource: DiffState['planSource'] = 'rule';
    if (useAi) {
      const gl = useGuideline.getState();
      const guide = guidelineText(gl.guide, [bandOf(ds.target.center)]);
      const r = await runAi<Partial<DifficultyPlan>>('difficulty', {
        ...planPrompt({ doc: master, title, genre: master.fields['GENRE'] ?? '', diff, target: ds.target, masterLevel: g.masterLevel, rung: DEFAULT_RUNG[diff], sections: g.spans, guide, keep: g.keep, instruction: g.instruction }),
        schema: PLAN_SCHEMA,
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
    // 2. 配置と再調整（機械的な推定で）
    let base = { doc: master, sections: plan.sections, keep: get().keep, overrides: get().diffs[diff].overrides };
    const calib = g.calib;
    const rawTarget = { min: ds.target.min / calib, max: ds.target.max / calib };
    let result = generateToTarget(base, DEFAULT_RUNG[diff], rawTarget);
    // AI の方針（元に近く・フィルを残す・ライドを残す）が強すぎて、いちばん簡単な段でも目標に届かないときは、それを外して作り直す
    if (result.level > rawTarget.max + 1e-9) {
      const relaxed = relaxPlan(plan);
      if (relaxed) {
        const base2 = { ...base, sections: relaxed.sections };
        const r2 = generateToTarget(base2, DEFAULT_RUNG[diff], rawTarget);
        if (r2.level < result.level) {
          result = r2;
          base = base2;
          plan = relaxed;
        }
      }
    }
    // 3. AI 判定。外れたら、AI と計算のずれのぶん狙いを動かして1回だけ作り直す（段のあいだの細かい調整も使う）。
    //    AI の判定は 0.1〜0.2 ほどぶれるので、作り直しは目標の真ん中を狙い、2つのうち目標に近い方を採る。
    let judge: JudgeResult | null = null;
    if (useAi) {
      patchDiff(diff, { status: 'judging', result, issues: issueCount(result.doc) });
      const sections = useSidecar.getState().sections;
      judge = await judgeDoc(result.doc, { title, label: diff, sections, mech: result.level * calib, quiet: true });
      if (judge) {
        cost += judge.cost;
        if (!inTarget(judge.level, ds.target)) {
          const center = ds.target.center - (judge.level - result.level * calib);
          const r2 = generateToTarget(base, result.rung, { min: (center - 0.1) / calib, max: (center + 0.1) / calib });
          if (r2.rung !== result.rung || r2.ease !== result.ease) {
            const j2 = await judgeDoc(r2.doc, { title, label: diff, sections, mech: r2.level * calib, quiet: true });
            if (j2) {
              cost += j2.cost;
              if (targetGap(j2.level, ds.target) <= targetGap(judge.level, ds.target)) {
                result = { ...r2, tries: [...result.tries, ...r2.tries] };
                judge = j2;
              }
            }
          }
        }
      }
    }
    patchDiff(diff, { status: 'done', plan, result, judge, issues: issueCount(result.doc), cost });
  } catch (e) {
    patchDiff(diff, { status: 'error', error: e instanceof AiError ? e.message : `作れませんでした: ${(e as Error).message}`, cost });
  }
}

export async function generateAll() {
  if (get().busy) return;
  set({ busy: true });
  try {
    for (const d of DIFFICULTIES) if (get().diffs[d].enabled) await generate(d);
  } finally {
    set({ busy: false });
  }
}

/** 方針はそのままで作り直す（手直し・必ず残すものの変更のあと） */
export function rebuild(diff: Difficulty) {
  const g = get();
  const ds = g.diffs[diff];
  if (!g.master || !ds.result || !ds.plan) return;
  const r = simplify({ doc: g.master, rung: ds.result.rung, ease: ds.result.ease, sections: ds.plan.sections, keep: g.keep, overrides: ds.overrides });
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
}

export function setTarget(diff: Difficulty, center: number) {
  const c = Math.max(1, Math.min(9.5, center));
  patchDiff(diff, { target: { min: Math.max(1, c - 0.3), max: c + 0.3, center: c } });
}

// ---- 書き出し ---------------------------------------------------------------------------

const SUFFIX: Record<Difficulty, string> = { BASIC: 'bsc', ADVANCED: 'adv', EXTREME: 'ext' };
const SLOT: Record<Difficulty | 'MASTER', number> = { BASIC: 1, ADVANCED: 2, EXTREME: 3, MASTER: 4 };

export function outFileName(masterFile: string, diff: Difficulty): string {
  const orig = masterFile.replace(/\.dtx$/i, '') || 'song';
  const base = orig.replace(/[_-]?(mstr|master|mas)$/i, '') || orig;
  return `${base}_${SUFFIX[diff]}.dtx`;
}

/** set.def を作る。ほかの難易度（L5 など）は残す */
export function buildSetDef(existing: string | null, title: string, masterFile: string, masterLabel: string, made: { diff: Difficulty; file: string }[]): string {
  const blocks = existing ? parseSetDef(existing) : [];
  const block = blocks.find((b) => b.levels.some((l) => l.file.toLowerCase() === masterFile.toLowerCase())) ?? blocks[0] ?? null;
  const slots = new Map<number, { label: string; file: string }>();
  const madeFiles = new Set(made.map((m) => m.file.toLowerCase()));
  const leftovers: { label: string; file: string }[] = [];
  for (const l of block?.levels ?? []) {
    if (l.file.toLowerCase() === masterFile.toLowerCase() || madeFiles.has(l.file.toLowerCase())) continue;
    if (made.some((m) => m.diff === l.label.toUpperCase())) continue;
    leftovers.push(l);
  }
  for (const m of made) slots.set(SLOT[m.diff], { label: m.diff, file: m.file });
  slots.set(SLOT.MASTER, { label: masterLabel && !/^(BASIC|ADVANCED|EXTREME)$/i.test(masterLabel) ? masterLabel : 'MASTER', file: masterFile });
  for (const l of leftovers) {
    for (let i = 1; i <= 5; i++) {
      if (!slots.has(i)) {
        slots.set(i, l);
        break;
      }
    }
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
    b.levels.forEach((l, i) => lines.push(`#L${i + 1}LABEL ${l.label}`, `#L${i + 1}FILE ${l.file}`));
  }
  return lines.join('\r\n') + '\r\n';
}

/** set.def に今ある難易度のうち、作った譜面に置き換わるもの（同じ難易度名で別のファイル） */
export function replacedInSetDef(existing: string | null, masterFile: string, made: { diff: Difficulty; file: string }[]): { label: string; file: string }[] {
  if (!existing) return [];
  const blocks = parseSetDef(existing);
  const block = blocks.find((b) => b.levels.some((l) => l.file.toLowerCase() === masterFile.toLowerCase())) ?? blocks[0];
  if (!block) return [];
  const madeFiles = new Set(made.map((m) => m.file.toLowerCase()));
  return block.levels.filter((l) => !madeFiles.has(l.file.toLowerCase()) && l.file.toLowerCase() !== masterFile.toLowerCase() && made.some((m) => m.diff === l.label.toUpperCase()));
}

/** 作った難易度を曲フォルダに書き出し、set.def を更新する */
export async function writeOut(): Promise<boolean> {
  const g = get();
  const s = useEditor.getState();
  const folder = s.folder;
  if (!g.master) return false;
  const made = DIFFICULTIES.filter((d) => g.diffs[d].enabled && g.diffs[d].result);
  if (made.length === 0) {
    toast('まだ難易度を作っていません', 'warn');
    return false;
  }
  if (!folder) {
    toast('先に曲を保存して、曲フォルダを決めてください', 'warn', 6000);
    return false;
  }
  const files = made.map((d) => ({ diff: d, file: outFileName(g.masterFile, d) }));
  let existing: string | null = null;
  const sd = findFile(folder, 'set.def');
  if (sd) {
    try {
      existing = decodeDtx(new Uint8Array(await (await sd.getFile()).arrayBuffer())).text;
    } catch {
      existing = null;
    }
  }
  const exists = files.filter((f) => findFile(folder, f.file));
  const replaced = replacedInSetDef(existing, g.masterFile, files);
  if (exists.length || replaced.length) {
    const body = [
      exists.length ? `${exists.map((f) => f.file).join('、')} を上書きします。` : '',
      replaced.length ? `set.def の ${replaced.map((l) => `${l.label}（${l.file}）`).join('、')} を、作った譜面に置き換えます（元の譜面のファイルは消しません）。` : '',
      'よろしいですか？',
    ].filter(Boolean).join('\n');
    const ok = await confirmDialog({ title: exists.length ? '同じ名前の譜面があります' : 'set.def の難易度を置き換えます', body, ok: exists.length ? '上書き' : '置き換える', danger: true });
    if (!ok) return false;
  }
  let memory = false;
  for (const { diff, file } of files) {
    const ds = g.diffs[diff];
    const doc: DtxDoc = structuredClone(ds.result!.doc);
    const lv = shownLevel(ds, g.calib);
    setField(doc, 'DLEVEL', levelToField(lv));
    const { bytes } = encodeDtx(serializeDtx(doc), 'shift_jis');
    if ((await putFile(folder, file, bytes)) === 'memory') memory = true;
  }
  const text = buildSetDef(existing, g.master.fields['TITLE'] || g.masterFile, g.masterFile, g.masterLabel, files);
  if ((await putFile(folder, 'set.def', encodeDtx(text, 'shift_jis').bytes)) === 'memory') memory = true;
  // 難易度の切り替えタブを更新する
  const labels = new Map<string, string>();
  for (const b of parseSetDef(text)) for (const l of b.levels) labels.set(l.file.toLowerCase(), l.label);
  useEditor.setState((st) => ({ meta: { ...st.meta, siblings: dtxFiles(folder).map((f) => ({ file: f.name, label: labels.get(f.name.toLowerCase()) ?? f.name.replace(/\.dtx$/i, '') })) } }));
  toast(
    `${files.map((f) => `${f.diff}（${f.file}）`).join('、')} と set.def を${memory ? '作りました。保存（Ctrl+S）で曲フォルダに書き出します' : '曲フォルダに書き出しました'}`,
    'ok',
    8000,
  );
  return true;
}
