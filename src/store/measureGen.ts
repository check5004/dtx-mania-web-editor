// 小節の生成：小節線の ✨（または Alt+G）を押したときだけ、その小節（Shift+クリックで4小節まで）のドラムの案を作る。
// 案は3つの出どころから集める:
//  - AI（OpenRouter）: 原曲の打点と前後の譜面から、性格の違う3案（ai/measureGen）。キーが要る。
//  - 採譜から: ドラムの採譜モデルの打点をそのままチップにしたもの（assist/draft）。キー不要・すぐ出る。
//  - 写す: この曲でもう打った小節を写す（TAB補完と同じ点数の付け方）。キー不要・すぐ出る。
// 案は点線で見せ、いまの譜面との違い（足す・消す）も見せてから、マージのしかたを選んで入れる（edit/merge）。
// 入れるまで譜面は変わらない。再生すると、案を入れた譜面で鳴らす（聴き比べられる）。
import { produce } from 'immer';
import { create } from 'zustand';
import { buildMeasureContext, decodeMeasureCandidates, MEASURE_SCHEMA, measurePrompt } from '../ai/measureGen';
import { AiError } from '../ai/openrouter';
import { draftFromHits, learnStyle, styleLines } from '../assist/draft';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { drumChannel, type DtxDoc } from '../dtx/model';
import { applyMerge, drumChipsIn, lanesWithChanges, planMerge, type MergeMode, type MergePlan, type ProposedNote } from '../edit/merge';
import type { DrumActivations } from '../transcribe/model';
import { drumHits, type DrumHit } from '../transcribe/peaks';
import { hasAiKey, runAi } from './ai';
import { aiOnsets } from './assist';
import { addGhostBlocker, copyCandidates, heardFit, unheardKeys } from './complete';
import type { Candidate } from '../assist/complete';
import { bgmSource, tempoOf } from './derived';
import { drumsAudible, readyDrums, useDrums } from './drums';
import { edit, prepareSounds, refreshPlayback, setPlayDocTransform, toast, useEditor, wavForChannel } from './editor';
import { levelOfField } from './guideline';
import { closePhrase, usePhrase } from './phrase';
import { sectionAt, useSidecar } from './sidecar';

export type GenSource = 'ai' | 'draft' | 'copy';

export interface GenCandidate {
  /** 見分ける名前（外したチップの印を案ごとに覚える） */
  id: string;
  source: GenSource;
  name: string;
  reason: string;
  notes: ProposedNote[];
  /** 原曲で聞こえるドラム（採譜の BD・SD・TT）との合い方（0〜1）。分からなければ null */
  fit: number | null;
  /** 写した元の最初の小節（写す） */
  src?: number;
  /** TAB補完の見込み（写す） */
  score?: number;
}

export interface MeasureGenState {
  open: boolean;
  from: number;
  to: number;
  cands: GenCandidate[];
  index: number;
  mode: MergeMode;
  /** 案を使わないレーン（いまのまま） */
  offLanes: number[];
  /** 案ごとの、外したチップ（noteId）と、置き換えでも残すチップ（id） */
  marks: Record<string, { rejected: string[]; kept: number[] }>;
  ai: 'idle' | 'loading' | 'done' | 'error' | 'nokey';
  aiError: string | null;
  cost: number | null;
  /** 案を選び直した・チップを外した（AI の案が届いても勝手に切り替えない） */
  touched: boolean;
}

const initial: MeasureGenState = {
  open: false,
  from: 0,
  to: 0,
  cands: [],
  index: 0,
  mode: 'add',
  offLanes: [],
  marks: {},
  ai: 'idle',
  aiError: null,
  cost: null,
  touched: false,
};

export const useMeasureGen = create<MeasureGenState>(() => initial);
const get = useMeasureGen.getState;
const set = useMeasureGen.setState;

/** 生成できる小節の数 */
export const MAX_GEN_MEASURES = 4;

// ---- 案を作る -----------------------------------------------------------------------

let hitsMemo: { data: DrumActivations; hits: DrumHit[] } | null = null;
/** 採譜の打点（作者の閾値。TAB補完の照合と同じ） */
function modelHits(): DrumHit[] | null {
  const d = readyDrums();
  if (!d) return null;
  if (hitsMemo?.data !== d) hitsMemo = { data: d, hits: drumHits(d, 0.5) };
  return hitsMemo.hits;
}

const isNormal = (ch: number) => drumChannel(ch)?.kind === 'normal';

/** 採譜の打点から作った案。採譜ができていない・打点が無ければ null */
function draftCandidate(doc: DtxDoc, from: number, to: number): GenCandidate | null {
  if (drumsAudible() === false) return null;
  const hits = modelHits();
  const bgm = bgmSource(doc);
  if (!hits || !bgm) return null;
  const tempo = tempoOf(doc);
  const style = learnStyle(doc, tempo, from, to);
  const notes = draftFromHits(
    hits.map((h) => ({ t: h.t + bgm.sec, cls: h.cls, s: h.s })),
    tempo,
    from,
    to,
    style,
  );
  if (notes.length === 0) return null;
  return {
    id: 'draft',
    source: 'draft',
    name: '採譜から',
    reason: style.measures ? '原曲から聞き取った打点。レーンは前後の小節の書き方に合わせました' : '原曲から聞き取った打点',
    notes,
    fit: null,
  };
}

/**
 * 写す案を先に出す見込みの下限。精度テスト（Bless your breath、前から順に書いていく想定の32小節）で、
 * 見込みがこれ以上の写す案は作者の譜面と 0.9 前後一致し、採譜の下書き（0.65）より当たった
 */
const COPY_FIRST = 0.2;
/** AI の案が届いても写す案を先にしておく見込みの下限（ここから上は AI より写す方が当たった: 1.0 前後 対 0.8） */
const COPY_OVER_AI = 0.4;

/** 写す案の理由（名前に小節番号が入っているので、ここでは繰り返さない） */
function copyReason(c: Candidate, at: number): string {
  if (c.kind === 'structure') return '原曲で同じに聞こえる小節';
  if (c.src !== null && c.src > at) return '後ろにある、流れが同じ小節';
  if (c.period === 1) return '直前の小節を続ける';
  if (c.period !== null && c.period <= 8) return `${c.period}小節前と同じ流れ`;
  return '流れが同じ小節';
}

const copyScore = (c: GenCandidate | undefined) => (c?.source === 'copy' ? (c.score ?? 0) : 0);

/** キーなしですぐ出せる案（採譜から・写す）。当たりそうな順 */
export function localCandidates(doc: DtxDoc, from: number, to: number): GenCandidate[] {
  const copies: GenCandidate[] = [];
  const d = draftCandidate(doc, from, to);
  for (const c of copyCandidates(doc, from, to - from + 1, 2)) {
    const notes: ProposedNote[] = [];
    c.measures.forEach((ns, i) => {
      for (const n of ns) if (isNormal(n.ch)) notes.push({ ch: n.ch, m: from + i, f: n.f, v: n.v });
    });
    if (notes.length === 0 || c.src === null) continue;
    const pct = Number.isFinite(c.score) ? `（同じ形の見込み ${Math.round(c.score * 100)}%）` : '';
    copies.push({
      id: `copy:${c.src}`,
      source: 'copy',
      name: `小節 ${toMeasure(c.src)} を写す`,
      reason: `${copyReason(c, from)}${pct}`,
      notes,
      fit: heardFit(doc, notes, from, to),
      src: c.src,
      score: c.score,
    });
  }
  return arrange([], [...(d ? [d] : []), ...copies]);
}

/**
 * 案の並び（当たりそうな順）。採譜と写すは、見込みの高い写す案があれば写すを先に。
 * AI の案はその前に置くが、形がはっきり同じ写す案はさらに前（AI はそれを手本に違う所を直した案になる）。
 * AI の案が採譜・写すと同じ中身なら、もう見えている札（採譜・写す）を AI の順位に置く
 */
function arrange(ai: readonly GenCandidate[], local: readonly GenCandidate[]): GenCandidate[] {
  const draft = local.filter((c) => c.source === 'draft');
  const copies = local.filter((c) => c.source === 'copy');
  const sorted = copyScore(copies[0]) >= COPY_FIRST ? [...copies, ...draft] : [...draft, ...copies];
  const strong = sorted.filter((c) => copyScore(c) >= COPY_OVER_AI);
  return dedupe([...strong, ...ai, ...sorted.filter((c) => !strong.includes(c))], local);
}

function signature(c: GenCandidate): string {
  return c.notes
    .map((n) => `${n.m}|${n.ch}|${n.f.n}/${n.f.d}`)
    .sort()
    .join(',');
}

/**
 * 同じ中身の案は1つに（前にある方の位置に残す）。prefer に同じ中身があればそちらを残す
 * （AI の案が採譜・写すと同じなら、もう見えている札の名前のまま AI の順位に置く）
 */
function dedupe(cands: GenCandidate[], prefer: readonly GenCandidate[] = []): GenCandidate[] {
  const pref = new Map(prefer.map((c) => [signature(c), c]));
  const seen = new Set<string>();
  const out: GenCandidate[] = [];
  for (const c of cands) {
    const k = signature(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(pref.get(k) ?? c);
  }
  return out;
}

let aiAbort: AbortController | null = null;
let aiSeq = 0;

function cancelAi() {
  aiAbort?.abort();
  aiAbort = null;
}

/** AI に案を作ってもらう（今の範囲で）。届いたら前に足す */
async function runGenAi(instruction = '', focus = false) {
  const g = get();
  if (!g.open) return;
  if (!hasAiKey()) {
    set({ ai: 'nokey' });
    return;
  }
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  // ドラム抜きの BGM の打点は、ドラムの手がかりにならない（ほかの楽器の音だけ）ので送らない
  const drumless = drumsAudible() === false;
  const onsets = drumless ? null : aiOnsets();
  const bgm = bgmSource(doc);
  const sections = useSidecar.getState().sections;
  const ctx = buildMeasureContext(doc, tempo, {
    from: g.from,
    to: g.to,
    onsets: onsets && bgm ? onsets : null,
    offsetSec: bgm?.sec ?? 0,
    level: levelOfField(doc.fields['DLEVEL']),
    style: styleLines(learnStyle(doc, tempo, g.from, g.to)),
    sectionOf: (m) => sectionAt(sections, m)?.name ?? null,
    refs: g.cands.filter((c) => c.source === 'copy' && c.src !== undefined).map((c) => ({ src: c.src!, score: c.score ?? null })),
    drumless,
    instruction,
  });
  cancelAi();
  const ac = new AbortController();
  aiAbort = ac;
  const seq = ++aiSeq;
  const range = { from: g.from, to: g.to };
  set({ ai: 'loading', aiError: null });
  try {
    const r = await runAi<unknown>('measure', { ...measurePrompt(ctx), schema: MEASURE_SCHEMA, maxTokens: 3000, signal: ac.signal });
    if (aiAbort !== ac) return;
    aiAbort = null;
    const cur = get();
    if (!cur.open || cur.from !== range.from || cur.to !== range.to) return;
    if (!r) {
      set({ ai: 'idle' });
      return;
    }
    const pcs = decodeMeasureCandidates(r.data, range, tempo);
    if (pcs.length === 0) {
      set({ ai: 'error', aiError: 'AIの案が使える形になりませんでした。もう一度試してください', cost: r.costUsed });
      return;
    }
    const nowDoc = useEditor.getState().doc;
    const ai: GenCandidate[] = pcs.map((pc, i) => {
      const notes = pc.notes.map((n) => ({ ch: n.ch, m: n.m, f: n.f }));
      return { id: `ai:${seq}:${i}`, source: 'ai', name: pc.name, reason: pc.reason, notes, fit: heardFit(nowDoc, notes, range.from, range.to) };
    });
    const cands = arrange(
      ai,
      cur.cands.filter((c) => c.source !== 'ai'),
    );
    const keepId = cur.cands[cur.index]?.id;
    const keepAt = keepId ? cands.findIndex((c) => c.id === keepId) : -1;
    // 頼み直したとき（ひとこと・もう一度）は AI の1つめを見せる
    const firstAi = signature(ai[0]);
    const aiAt = cands.findIndex((c) => signature(c) === firstAi);
    const index = focus && aiAt >= 0 ? aiAt : cur.touched && keepAt >= 0 ? keepAt : 0;
    set({ cands, index, ai: 'done', aiError: null, cost: r.costUsed });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    if (aiAbort !== ac) return;
    aiAbort = null;
    set({ ai: 'error', aiError: e instanceof AiError ? e.message : (e as Error).message });
  }
}

// ---- 開く・閉じる・選ぶ ------------------------------------------------------------

/**
 * 小節 m の生成を始める（✨ を押したとき）。extend なら今の範囲を m まで広げる（4小節まで）。
 * 同じ1小節をもう一度押すと閉じる。
 */
export function openMeasureGen(m: number, o: { extend?: boolean } = {}) {
  const s = useEditor.getState();
  if (s.screen !== 'editor') return;
  const g = get();
  let from = Math.max(0, m);
  let to = from;
  if (o.extend && g.open) {
    from = Math.min(g.from, m);
    to = Math.max(g.to, m);
    if (to - from + 1 > MAX_GEN_MEASURES) {
      toast(`小節の生成は ${MAX_GEN_MEASURES} 小節までです`, 'warn');
      if (m < g.from) to = from + MAX_GEN_MEASURES - 1;
      else from = to - MAX_GEN_MEASURES + 1;
    }
  } else if (g.open && g.from === from && g.to === to) {
    closeMeasureGen();
    return;
  }
  if (usePhrase.getState().open) closePhrase();
  cancelAi();
  const cands = localCandidates(s.doc, from, to);
  set({
    ...initial,
    open: true,
    from,
    to,
    cands,
    ai: hasAiKey() ? 'loading' : 'nokey',
  });
  void runGenAi();
}

/** カーソル（▶）の小節で始める（Alt+G・メニュー・右のパネル） */
export function openMeasureGenAtCursor() {
  const s = useEditor.getState();
  openMeasureGen(tempoOf(s.doc).locate(Math.max(0, s.cursorBeat)).m);
}

export function closeMeasureGen() {
  cancelAi();
  if (!get().open) return;
  set({ ...initial });
}

/** AI にもう一度作ってもらう（前の AI の案は入れ替える） */
export function regenMeasureAi(instruction = '') {
  if (!get().open) return;
  void runGenAi(instruction, true);
}

export function stepMeasureGen(d: 1 | -1) {
  const g = get();
  if (g.cands.length < 2) return;
  set({ index: (g.index + d + g.cands.length) % g.cands.length, touched: true });
}

export function selectMeasureGen(i: number) {
  const g = get();
  if (i < 0 || i >= g.cands.length) return;
  set({ index: i, touched: true });
}

export function setGenMode(mode: MergeMode) {
  set({ mode, touched: true });
}

/** レーンの案を使う・使わない */
export function toggleGenLane(lane: number) {
  const off = new Set(get().offLanes);
  if (off.has(lane)) off.delete(lane);
  else off.add(lane);
  set({ offLanes: [...off], touched: true });
}

function editMarks(fn: (m: { rejected: string[]; kept: number[] }) => { rejected: string[]; kept: number[] }) {
  const g = get();
  const c = g.cands[g.index];
  if (!c) return;
  const cur = g.marks[c.id] ?? { rejected: [], kept: [] };
  set({ marks: { ...g.marks, [c.id]: fn(cur) }, touched: true });
}

/** 案のチップを外す・戻す（点線をクリック） */
export function toggleGenNote(id: string) {
  editMarks((m) => ({ ...m, rejected: m.rejected.includes(id) ? m.rejected.filter((x) => x !== id) : [...m.rejected, id] }));
}

/** 置き換えで消えるチップを残す・残さない（赤い × をクリック） */
export function toggleGenKeep(chipId: number) {
  editMarks((m) => ({ ...m, kept: m.kept.includes(chipId) ? m.kept.filter((x) => x !== chipId) : [...m.kept, chipId] }));
}

/** 外した・残した印を消す（今の案だけ） */
export function resetGenMarks() {
  editMarks(() => ({ rejected: [], kept: [] }));
}

// ---- マージの計画 -----------------------------------------------------------------

export interface GenView {
  cand: GenCandidate;
  plan: MergePlan;
  /** 範囲のいまのドラムの通常チップ */
  existing: ReturnType<typeof drumChipsIn>;
  /** 違いのあるレーン */
  lanes: number[];
  /** 原曲で聞こえない、足すチップ（doubtKey） */
  doubt: ReadonlySet<string>;
  rejected: ReadonlySet<string>;
  kept: ReadonlySet<number>;
}

let viewMemo: { doc: DtxDoc; g: MeasureGenState; out: GenView | null } | null = null;

/** 今の案と、いまの譜面へのマージの計画。開いていなければ null */
export function genView(doc: DtxDoc = useEditor.getState().doc): GenView | null {
  const g = get();
  if (!g.open) return null;
  if (viewMemo && viewMemo.doc === doc && viewMemo.g === g) return viewMemo.out;
  const cand = g.cands[g.index] ?? null;
  let out: GenView | null = null;
  if (cand) {
    const existing = drumChipsIn(doc, g.from, g.to);
    const mk = g.marks[cand.id];
    const rejected = new Set(mk?.rejected ?? []);
    const kept = new Set(mk?.kept ?? []);
    const plan = planMerge(existing, cand.notes, { mode: g.mode, offLanes: new Set(g.offLanes), rejected, kept });
    out = { cand, plan, existing, lanes: lanesWithChanges(existing, cand.notes), doubt: unheardKeys(doc, plan.add), rejected, kept };
  }
  viewMemo = { doc, g, out };
  return out;
}

/** 範囲に作者のチップがあるか */
export function rangeHasChips(doc: DtxDoc = useEditor.getState().doc): boolean {
  const g = get();
  return g.open && drumChipsIn(doc, g.from, g.to).length > 0;
}

/** 案の出どころの短い言い方 */
export function genSourceLabel(c: GenCandidate): string {
  return c.source === 'ai' ? 'AI' : c.source === 'draft' ? '採譜' : '写す';
}

/** 今の案を入れる。next なら、入れたあと次の小節の生成を始める */
export function applyMeasureGen(o: { next?: boolean } = {}): boolean {
  const g = get();
  const v = genView();
  if (!v) return false;
  const range = g.from === g.to ? `小節 ${toMeasure(g.from)}` : `小節 ${toMeasure(g.from)}〜${toMeasure(g.to)}`;
  const nextAt = g.to + 1;
  if (v.plan.add.length === 0 && v.plan.remove.length === 0) {
    toast('いまの譜面と違う所がありません', 'info');
    closeMeasureGen();
    if (o.next) openMeasureGen(nextAt);
    return false;
  }
  const fieldsBefore = Object.keys(useEditor.getState().doc.fields).length;
  const label = `${range} に${genSourceLabel(v.cand)}の案「${v.cand.name}」を入れる（+${v.plan.add.length}${v.plan.remove.length ? ` −${v.plan.remove.length}` : ''}）`;
  const ok = edit(label, (d) => applyMerge(d, v.plan, wavForChannel));
  closeMeasureGen();
  if (Object.keys(useEditor.getState().doc.fields).length !== fieldsBefore) void prepareSounds();
  if (ok) toast(`${range} に「${v.cand.name}」を入れました（Ctrl+Z で戻せます）`, 'ok');
  if (o.next) openMeasureGen(nextAt);
  return ok;
}

// ---- 案を鳴らす ----------------------------------------------------------------------

/** 案のチップを鳴らす WAV（読み込み済みの音だけ使う。無ければ鳴らさない） */
function soundingWav(doc: DtxDoc, ch: number): number {
  const base = drumChannel(ch)?.base ?? ch;
  const assigned = useEditor.getState().laneWav[base];
  if (assigned !== undefined && doc.fields['WAV' + toBase36x2(assigned)] !== undefined) return assigned;
  const count = new Map<number, number>();
  for (const c of doc.chips) if (c.ch === base) count.set(c.v, (count.get(c.v) ?? 0) + 1);
  let best = 0;
  let bn = 0;
  for (const [v, n] of count) if (n > bn) [best, bn] = [v, n];
  return best;
}

setPlayDocTransform((doc) => {
  const v = genView(doc);
  if (!v || (v.plan.add.length === 0 && v.plan.remove.length === 0)) return doc;
  return produce(doc, (d) => applyMerge(d, v.plan, (_d, ch) => soundingWav(doc, ch)));
});

// ---- ほかの状態とのつながり -------------------------------------------------------------

// 生成を開いている間は、TAB補完の点線を出さない
addGhostBlocker(() => get().open);

// 案・入れ方が変わったら、再生中なら鳴らし直す
useMeasureGen.subscribe((g, prev) => {
  if (g.open === prev.open && g.cands === prev.cands && g.index === prev.index && g.mode === prev.mode && g.offLanes === prev.offLanes && g.marks === prev.marks) return;
  refreshPlayback();
});

// 別の曲を開いた・画面を離れたら閉じる
useEditor.subscribe((s, prev) => {
  if (!get().open) return;
  if (s.meta !== prev.meta || s.screen !== prev.screen || s.page !== prev.page) closeMeasureGen();
});

// フレーズ候補を開いたら閉じる（同じ所に点線を出すため）
usePhrase.subscribe((p, prev) => {
  if (p.open && !prev.open) closeMeasureGen();
});

// 採譜があとから終わったら、「採譜から」の案を足す
useDrums.subscribe((d, prev) => {
  if (d.status === prev.status && d.data === prev.data) return;
  const g = get();
  if (!g.open || g.cands.some((c) => c.source === 'draft')) return;
  const doc = useEditor.getState().doc;
  const dc = draftCandidate(doc, g.from, g.to);
  if (!dc) return;
  const cands = arrange(
    g.cands.filter((c) => c.source === 'ai'),
    [dc, ...g.cands.filter((c) => c.source !== 'ai')],
  );
  const keepId = g.cands[g.index]?.id;
  set({ cands, index: Math.max(0, cands.findIndex((c) => c.id === keepId)) });
});
