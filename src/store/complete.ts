// TAB補完の状態：打った小節の続き（先の1〜4小節）を点線で出し、Tab で入れる。
// 予測は assist/complete（この曲で打った小節を写す）、原曲の構造は assist/measureAudio、原曲との照合は assist/evidence、
// 原曲で聞こえるドラム（採譜モデルの打点）との合い方は assist/heard が受け持つ。
// 点線を出すのは、チップを置いた（足した）ときだけ。足した中でいちばん後ろの小節の次から、空いている小節にだけ出す。
import { tr, withTr } from '../i18n';
import { create } from 'zustand';
import { AiError } from '../ai/openrouter';
import { buildContext, decodeCandidates, phraseSchema, phrasePrompt, type PhraseCandidate } from '../ai/phrase';
import { measureContents, noteKey, predictChain, type Candidate, type ChartSource, type CNote } from '../assist/complete';
import { modelEvidence, onsetEvidence, unheard, type Evidence } from '../assist/evidence';
import { heardDrums, type HeardDrums } from '../assist/heard';
import { measureAudio, type MeasureAudio } from '../assist/measureAudio';
import type { AnalysisData } from '../audio/analysis';
import type { FrameFeatures } from '../audio/features';
import * as wk from '../audio/workerClient';
import { toBase36x2, toMeasure } from '../dtx/base36';
import type { Frac } from '../dtx/fraction';
import type { DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { hasAiKey, noKeyTitle, runAi } from './ai';
import { aiOnsets, useAssist } from './assist';
import { drumsAudible, readyDrums, useDrums } from './drums';
import { drumHits, type DrumHit } from '../transcribe/peaks';
import type { DrumActivations } from '../transcribe/model';
import { bgmSource, tempoOf } from './derived';
import { edit, toast, useEditor, wavForChannel } from './editor';
import { levelOfField } from './guideline';
import { usePhrase } from './phrase';
import { useVel } from './velocity';

export type CompleteAmount = 'few' | 'normal' | 'many';

/**
 * 点線を出す基準（次の小節がそのまま正解になる見込み）。精度テスト（6曲23譜面）では、
 * 見込み 0.3〜0.4 の予測でそのまま正解が 39%、0.4〜0.5 で 54%、0.5 以上で 65% だった（docs/bench.md の「TAB補完」）。
 */
export const AMOUNT: Record<CompleteAmount, { label: string; min: number; tip: string }> = {
  few: withTr(
    { min: 0.5 } as { label: string; min: number; tip: string },
    { label: ['控えめ', 'Fewer'], tip: ['当たりやすいときだけ出します。5小節に1回ほど出て、約3分の2がそのまま正解', 'Shows ideas only when they are likely right. About once every 5 measures, and about two thirds are right as is'] },
  ),
  normal: withTr(
    { min: 0.35 } as { label: string; min: number; tip: string },
    { label: ['ふつう', 'Normal'], tip: ['2小節に1回ほど出て、半分強がそのまま正解。外れても少し直すだけのことが多い', 'About once every 2 measures, and a bit over half are right as is. Misses usually need only small fixes'] },
  ),
  many: withTr(
    { min: 0.2 } as { label: string; min: number; tip: string },
    { label: ['多め', 'More'], tip: ['自信が低くても出します。3小節に2回ほど出て、そのまま正解は約半分（直す前提の下書き）', 'Shows ideas even with low confidence. About 2 of every 3 measures, and about half are right as is (a draft to fix up)'] },
  ),
};

/** Alt+] で呼び出したとき（自分から求めたときは、見込みが低くても出す） */
const SUMMON_MIN = 0.05;

interface Settings {
  enabled: boolean;
  /** 先の何小節まで出すか（1〜4） */
  ahead: number;
  amount: CompleteAmount;
}

const KEY = 'dtxe.complete.v1';
const DEFAULTS: Settings = { enabled: true, ahead: 4, amount: 'normal' };

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>;
  } catch {
    saved = {};
  }
  return {
    enabled: saved.enabled !== false,
    ahead: Math.max(1, Math.min(4, Math.round(Number(saved.ahead) || DEFAULTS.ahead))),
    amount: saved.amount && saved.amount in AMOUNT ? saved.amount : DEFAULTS.amount,
  };
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 覚えられなくても、この画面の間は使える
  }
}

export interface CompleteState extends Settings {
  /** 予測を始める小節（最後にチップを足した小節の次）。無ければ null */
  at: number | null;
  /** 候補（Alt+] で切り替える）。AI の候補は前に足す */
  cands: Candidate[];
  index: number;
  /** Alt+] で呼び出した（基準を下げて出している） */
  summoned: boolean;
  /** Esc で消した（次にチップを足すまで出さない） */
  dismissed: boolean;
  /** 原曲の構造（小節ごとの聞こえ方）の用意 */
  audio: 'none' | 'loading' | 'ready' | 'error';
  aiLoading: boolean;
  aiError: string | null;
}

export const useComplete = create<CompleteState>(() => ({
  ...loadSettings(),
  at: null,
  cands: [],
  index: 0,
  summoned: false,
  dismissed: false,
  audio: 'none',
  aiLoading: false,
  aiError: null,
}));

const get = useComplete.getState;
const set = useComplete.setState;

export function setCompleteSettings(p: Partial<Settings>) {
  set(p);
  const c = get();
  saveSettings({ enabled: c.enabled, ahead: c.ahead, amount: c.amount });
  if (!c.enabled) {
    cancelAi();
    set({ cands: [], index: 0, summoned: false });
    return;
  }
  ensureAudio();
  refresh();
}

// ---- 出している点線 ---------------------------------------------------------------

export interface Ghost {
  /** 点線の最初の小節 */
  from: number;
  /** 小節ごとの点線のチップ */
  measures: CNote[][];
  cand: Candidate;
  index: number;
  count: number;
  /** 原曲で聞こえない点線のチップ（doubtKey） */
  doubt: ReadonlySet<string>;
}

export const doubtKey = (m: number, n: { ch: number; f: Frac }) => `${m}|${noteKey(n.ch, n.f)}`;

/** 点線を出さない間（小節の生成を開いている間など。循環を避けるため関数で受け取る） */
const blockers: (() => boolean)[] = [];
export function addGhostBlocker(fn: () => boolean) {
  blockers.push(fn);
}

/** 点線を出せる画面か（譜面の画面で、止まっていて、ほかの候補やベロシティの編集を開いていない） */
function canShow(): boolean {
  const s = useEditor.getState();
  if (s.screen !== 'editor' || s.page !== 'chart' || s.playing) return false;
  return !usePhrase.getState().open && !useVel.getState().mode && !blockers.some((b) => b());
}

/** 今出している点線。出していなければ null */
export function visibleGhost(): Ghost | null {
  const c = get();
  if (!c.enabled || c.dismissed || c.at === null || c.cands.length === 0 || !canShow()) return null;
  const index = Math.min(c.index, c.cands.length - 1);
  const cand = c.cands[index];
  const doc = useEditor.getState().doc;
  const contents = measureContents(doc);
  // 点線の小節に何か打ったら（予測し直すまで）出さない
  for (let i = 0; i < cand.measures.length; i++) if (contents.has(cand.from + i)) return null;
  return { from: cand.from, measures: cand.measures, cand, index, count: c.cands.length, doubt: doubtOf(cand, doc) };
}

/** 譜面の上に出す札（点線、または「見つからない」「AIが考え中」の知らせ） */
export function ghostBadge(): { at: number; ghost: Ghost | null } | null {
  const c = get();
  if (!c.enabled || c.dismissed || c.at === null || !canShow()) return null;
  const g = visibleGhost();
  if (g) return { at: g.from, ghost: g };
  if (c.summoned || c.aiLoading || c.aiError) {
    if (measureContents(useEditor.getState().doc).has(c.at)) return null;
    return { at: c.at, ghost: null };
  }
  return null;
}

/** 候補の出どころ（札に出す） */
export function sourceLabel(c: Candidate): string {
  if (c.kind === 'ai') return tr(`AI：${c.name ?? '候補'}`, `AI: ${c.name ?? 'idea'}`);
  if (c.src === null) return '';
  if (c.kind === 'structure') return tr(`原曲で同じに聞こえる 小節 ${toMeasure(c.src)} から`, `From measure ${toMeasure(c.src)}, which sounds the same in the original`);
  if (c.period === 1) return tr('直前の小節を続ける', 'Continue the previous measure');
  if (c.period !== null && c.period <= 8) return tr(`${c.period}小節前と同じ流れ`, `Same flow as ${c.period} measures back`);
  return tr(`小節 ${toMeasure(c.src)} と同じ流れ`, `Same flow as measure ${toMeasure(c.src)}`);
}

// ---- 原曲との照合（聞こえない所に印） --------------------------------------------------

const EMPTY: ReadonlySet<string> = new Set();
let evMemo: { data: AnalysisData | DrumActivations; ev: Evidence } | null = null;

/** 採譜モデルの打点（作者の閾値。「打点の感度」のつまみには合わせない：照合の当てになり方は精度テストで測った値で決めてある） */
let hitsMemo: { d: DrumActivations; hits: DrumHit[] } | null = null;
function modelHits(): DrumHit[] | null {
  const d = readyDrums();
  if (!d) return null;
  if (hitsMemo?.d !== d) hitsMemo = { d, hits: drumHits(d, 0.5) };
  return hitsMemo.hits;
}

/** 照合のしかた：採譜モデルがあればその打点、無ければ v0 の打点（スネアだけ） */
function evidence(): Evidence | null {
  const d = readyDrums();
  const hits = modelHits();
  if (d && hits) {
    if (evMemo?.data !== d) evMemo = { data: d, ev: modelEvidence(hits) };
    return evMemo.ev;
  }
  const data = useAssist.getState().data;
  if (!data) return null;
  if (evMemo?.data !== data) evMemo = { data, ev: onsetEvidence(data) };
  return evMemo.ev;
}

/** 原曲で聞こえるドラム（採譜モデルの打点）。曲の構造と同じ音・同じずれで */
let heardMemo: { hits: DrumHit[]; tempo: TempoMap; off: number; dur: number; h: HeardDrums } | null = null;
function heardOf(doc: DtxDoc, tempo: TempoMap): HeardDrums | null {
  const d = readyDrums();
  const hits = modelHits();
  const bgm = bgmSource(doc);
  if (!d || !hits || !bgm) return null;
  const dur = d.frames / d.fps;
  if (heardMemo && heardMemo.hits === hits && heardMemo.tempo === tempo && heardMemo.off === bgm.sec && heardMemo.dur === dur) return heardMemo.h;
  const h = heardDrums(hits, tempo, bgm.sec, dur);
  heardMemo = { hits, tempo, off: bgm.sec, dur, h };
  return h;
}

const doubtMemo = new WeakMap<Candidate, { ev: Evidence; tempo: TempoMap; off: number; out: ReadonlySet<string> }>();

/** 原曲で聞こえない（BD・SD・TT の）チップ。doubtKey の集まり。照合ができなければ空 */
export function unheardKeys(doc: DtxDoc, notes: readonly { ch: number; m: number; f: Frac }[]): ReadonlySet<string> {
  // ドラム抜きの BGM では、どのチップも「聞こえない」になってしまうので照合しない
  if (drumsAudible() === false) return EMPTY;
  const ev = evidence();
  const bgm = bgmSource(doc);
  if (!ev || !bgm) return EMPTY;
  const tempo = tempoOf(doc);
  const out = new Set<string>();
  for (const n of notes) if (unheard(ev, n.ch, tempo.beatToSec(tempo.beatOf(n.m, n.f)) - bgm.sec)) out.add(doubtKey(n.m, n));
  return out;
}

/**
 * 小節 from〜to に notes を打ったとき、原曲で聞こえるドラム（採譜の BD・SD・TT）とどれだけ合うか（0〜1、小節の平均）。
 * 採譜ができていない・原曲の外なら null
 */
export function heardFit(doc: DtxDoc, notes: readonly { ch: number; m: number; f: Frac }[], from: number, to: number): number | null {
  if (drumsAudible() === false) return null;
  const tempo = tempoOf(doc);
  const heard = heardOf(doc, tempo);
  if (!heard) return null;
  let sum = 0;
  let n = 0;
  for (let m = from; m <= to; m++) {
    const a = heard.agree(
      notes.filter((x) => x.m === m),
      m,
    );
    if (a === null) continue;
    sum += a;
    n++;
  }
  return n ? sum / n : null;
}

/**
 * 小節 at から len 小節に、この曲でもう打った小節を写す候補（小節の生成の「写す」）。
 * TAB補完と同じ点数の付け方で、範囲にもうチップがあっても予測する。点数の高い順に max 個まで
 */
export function copyCandidates(doc: DtxDoc, at: number, len: number, max = 2): Candidate[] {
  const tempo = tempoOf(doc);
  const audio = structureAudio(doc, tempo);
  const heard = audio ? heardOf(doc, tempo) : null;
  const contents = measureContents(doc);
  const chart: ChartSource = {
    contents,
    barLen: (m) => tempo.barLen(m),
    canCopy: (m) => m >= 0 && (m < at || m >= at + len) && contents.has(m),
  };
  return predictChain(chart, { at, len, audio, heard, alternatives: max, minNext: 0 });
}

function doubtOf(cand: Candidate, doc: DtxDoc): ReadonlySet<string> {
  const ev = evidence();
  const bgm = bgmSource(doc);
  if (!ev || !bgm) return EMPTY;
  const tempo = tempoOf(doc);
  const hit = doubtMemo.get(cand);
  if (hit && hit.ev === ev && hit.tempo === tempo && hit.off === bgm.sec) return hit.out;
  const out = new Set<string>();
  cand.measures.forEach((ns, i) => {
    const m = cand.from + i;
    for (const n of ns) if (unheard(ev, n.ch, tempo.beatToSec(tempo.beatOf(m, n.f)) - bgm.sec)) out.add(doubtKey(m, n));
  });
  doubtMemo.set(cand, { ev, tempo, off: bgm.sec, out });
  return out;
}

// ---- 原曲の構造（小節ごとの聞こえ方） ---------------------------------------------------

interface FeatCache {
  key: string;
  frames: FrameFeatures;
  duration: number;
}
let feat: FeatCache | null = null;
let featKey = '';
let maMemo: { feat: FeatCache; tempo: TempoMap; off: number; ma: MeasureAudio } | null = null;

function requestFeatures(key: string) {
  if (featKey === key) return;
  featKey = key;
  set({ audio: 'loading' });
  wk.features(key).then(
    (r) => {
      if (featKey !== key) return;
      feat = { key, frames: r.frames, duration: r.duration };
      maMemo = null;
      set({ audio: 'ready' });
      // 原曲の構造も使って予測し直す（出している点線が変わることがある）
      if (get().at !== null && !get().aiLoading) refresh();
    },
    () => {
      // 同じ音では頼み直さない（解析元が変われば、また調べる）
      if (featKey === key) set({ audio: 'error' });
    },
  );
}

/** 原曲の解析ができていれば、構造を調べ始める */
function ensureAudio() {
  const a = useAssist.getState();
  if (!get().enabled) return;
  if (a.status === 'ready' && a.src) requestFeatures(a.src.key);
  else if (a.status !== 'loading' && get().audio !== 'none') set({ audio: 'none' });
}

function structureAudio(doc: DtxDoc, tempo: TempoMap): MeasureAudio | null {
  const a = useAssist.getState();
  if (!a.src || a.status !== 'ready') return null;
  if (!feat || feat.key !== a.src.key) {
    requestFeatures(a.src.key);
    return null;
  }
  const bgm = bgmSource(doc);
  if (!bgm) return null;
  if (maMemo && maMemo.feat === feat && maMemo.tempo === tempo && maMemo.off === bgm.sec) return maMemo.ma;
  const last = Math.min(3599, tempo.locate(tempo.secToBeat(bgm.sec + feat.duration)).m + 1);
  const ma = measureAudio({ frames: feat.frames, offsetSec: bgm.sec, duration: feat.duration }, tempo, last);
  maMemo = { feat, tempo, off: bgm.sec, ma };
  return ma;
}

// ---- 予測 ------------------------------------------------------------------------

/** 小節 at からの続きを予測する（空いている小節だけ、設定の小節数まで） */
export function predictAt(doc: DtxDoc, at: number, o: { ahead: number; min: number; minNext: number; audio: MeasureAudio | null; heard?: HeardDrums | null }): Candidate[] {
  const tempo = tempoOf(doc);
  const contents = measureContents(doc);
  let len = 0;
  while (len < o.ahead && at + len < 3600 && !contents.has(at + len) && (!o.audio || o.audio.has(at + len))) len++;
  if (len === 0) return [];
  const chart: ChartSource = {
    contents,
    barLen: (m) => tempo.barLen(m),
    // 前の小節（空いていても「打たない小節」として）と、後ろの打ってある小節を写せる
    canCopy: (m) => m >= 0 && (m < at || contents.has(m)),
  };
  return predictChain(chart, { at, len, audio: o.audio, heard: o.heard ?? null, minNext: o.minNext, alternatives: 3 }).filter((c) => c.score >= o.min);
}

function refresh() {
  const c = get();
  if (!c.enabled || c.at === null) return;
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const audio = structureAudio(doc, tempo);
  const heard = audio ? heardOf(doc, tempo) : null;
  const min = AMOUNT[c.amount].min;
  const cands = predictAt(doc, c.at, { ahead: c.ahead, min: c.summoned ? SUMMON_MIN : min, minNext: min, audio, heard });
  set({ cands, index: 0 });
}

let queued = false;

/** 点線が画面に見えるようにする（ChartCanvas が受け持つ。循環を避けるため関数で受け取る） */
let revealer: ((from: number, len: number) => void) | null = null;
export function setGhostRevealer(fn: ((from: number, len: number) => void) | null) {
  revealer = fn;
}
/** 次に予測したら、その点線（無ければこの範囲）を見えるようにする（Tab で入れたあと） */
let revealAfter: { from: number; len: number } | null = null;

function revealCurrent(fallback: { from: number; len: number } | null = null) {
  const c = get();
  const cand = c.cands[c.index];
  if (cand) revealer?.(cand.from, cand.measures.length);
  else if (fallback) revealer?.(fallback.from, fallback.len);
}

/** 小節 at からの予測をやり直す（同じ操作の中の変更は1回にまとめる） */
function schedule(at: number) {
  cancelAi();
  set({ at, summoned: false, dismissed: false, aiError: null, cands: [], index: 0 });
  if (!get().enabled || queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    refresh();
    if (revealAfter) {
      const r = revealAfter;
      revealAfter = null;
      revealCurrent(r);
    }
  });
}

/**
 * チップを足した小節の範囲。消しただけなら 'removed'、ドラムが変わっていなければ null。
 * （強さ＝WAV だけの変更は変わっていないとみなす）
 */
export function addedMeasures(prev: DtxDoc, next: DtxDoc): { min: number; max: number } | 'removed' | null {
  const a = measureContents(prev);
  const b = measureContents(next);
  let changed = false;
  let min = Infinity;
  let max = -1;
  for (const [m, c] of b) {
    const old = a.get(m);
    if (old?.sig === c.sig) continue;
    changed = true;
    let added = !old;
    if (old) {
      for (const k of c.keys) {
        if (!old.keys.has(k)) {
          added = true;
          break;
        }
      }
    }
    if (!added) continue;
    if (m < min) min = m;
    if (m > max) max = m;
  }
  if (max >= 0) return { min, max };
  if (changed) return 'removed';
  for (const m of a.keys()) if (!b.has(m)) return 'removed';
  return null;
}

/** 続けて打っているとみなす範囲（これより広い所にまとめて足したとき＝貼り付け・まとめて反映・生成などでは出さない） */
const TYPING_SPAN = 4;

function reset() {
  cancelAi();
  pending = null;
  set({ at: null, cands: [], index: 0, summoned: false, dismissed: false, aiError: null });
}

/** 再生中（録音など）に足した小節の範囲。止めたら予測する */
let pending: { min: number; max: number } | null = null;

function hide() {
  cancelAi();
  set({ at: null, cands: [], index: 0, summoned: false, aiError: null });
}

useEditor.subscribe((s, prev) => {
  if (s.meta !== prev.meta || s.screen !== prev.screen) {
    reset();
    return;
  }
  if (s.doc !== prev.doc) {
    const r = addedMeasures(prev.doc, s.doc);
    if (r === 'removed') hide();
    else if (r && s.playing) pending = pending ? { min: Math.min(pending.min, r.min), max: Math.max(pending.max, r.max) } : r;
    else if (r && r.max - r.min < TYPING_SPAN) schedule(r.max + 1);
    else if (r) hide();
  }
  if (prev.playing && !s.playing && pending) {
    const r = pending;
    pending = null;
    if (r.max - r.min < TYPING_SPAN) schedule(r.max + 1);
  }
});

useAssist.subscribe((a, prev) => {
  if (a.src?.key === prev.src?.key && a.status === prev.status) return;
  ensureAudio();
});

// 採譜が終わったら、出している点線を予測し直す（聞こえるドラムとの合い方と照合の印が変わる）
useDrums.subscribe((d, prev) => {
  if (d.status === prev.status && d.data === prev.data && d.enabled === prev.enabled) return;
  if (get().at !== null && !get().aiLoading) refresh();
});

// ---- 操作 ------------------------------------------------------------------------

/** 点線をまとめて（count を渡すとその小節数だけ）入れる。入れたら true */
export function acceptGhost(count?: number): boolean {
  const g = visibleGhost();
  if (!g) return false;
  const n = Math.max(1, Math.min(count ?? g.measures.length, g.measures.length));
  const from = g.from;
  const to = from + n - 1;
  const label =
    n === 1
      ? tr(`TAB補完で小節 ${toMeasure(from)} を入れる`, `Tab completion: fill measure ${toMeasure(from)}`)
      : tr(`TAB補完で小節 ${toMeasure(from)}〜${toMeasure(to)} を入れる`, `Tab completion: fill measures ${toMeasure(from)}–${toMeasure(to)}`);
  edit(label, (d) => {
    for (let i = 0; i < n; i++) {
      for (const c of g.measures[i]) {
        // 写した元の音（ベロシティ違いも）のまま。AI の候補はレーンの音
        const v = c.v > 0 && d.fields['WAV' + toBase36x2(c.v)] !== undefined ? c.v : wavForChannel(d, c.ch);
        d.chips.push({ id: d.nextId++, ch: c.ch, m: from + i, f: { n: c.f.n, d: c.f.d }, v });
      }
    }
  });
  // 入れた小節の次から続ける（最後に入れた小節が空でも、その次から）
  revealAfter = { from, len: n };
  schedule(to + 1);
  return true;
}

/** 次・前の候補へ。点線が出ていなければ、カーソルの小節から呼び出す */
export function stepGhost(d: 1 | -1): boolean {
  const c = get();
  if (!c.enabled || !visibleGhost()) {
    summon();
    return true;
  }
  if (c.cands.length > 1) set({ index: (c.index + d + c.cands.length) % c.cands.length });
  revealCurrent();
  return true;
}

/** カーソルの小節（打ってあればその先の空いた小節）から、基準を下げて予測する */
export function summon() {
  const s = useEditor.getState();
  if (!get().enabled) {
    toast(tr('TAB補完はオフです。右のパネルの「TAB補完」の「使う」にチェックを入れると使えます', 'Tab completion is off. Check "Use" under "Tab completion" in the right panel to turn it on'), 'info');
    return;
  }
  if (!canShow()) return;
  const contents = measureContents(s.doc);
  let m = tempoOf(s.doc).locate(Math.max(0, s.cursorBeat)).m;
  for (let guard = 0; contents.has(m) && guard < 512; guard++) m++;
  cancelAi();
  set({ at: m, summoned: true, dismissed: false, aiError: null });
  refresh();
  revealCurrent({ from: m, len: 1 });
}

/** 点線を消す（次にチップを足すまで出さない）。消したら true */
export function dismissGhost(): boolean {
  if (!ghostBadge()) return false;
  cancelAi();
  set({ dismissed: true, summoned: false, aiError: null });
  return true;
}

// ---- AI に聞く（変わり目など、写す元が無い所） -------------------------------------------

let aiAbort: AbortController | null = null;

function cancelAi() {
  aiAbort?.abort();
  aiAbort = null;
  if (get().aiLoading) set({ aiLoading: false });
}

// AI への指示（日本語のまま。返す文の言語は aiLangRule で別に指定する）
const AI_NOTE = // i18n-ignore
  'TAB補完：直前までの譜面から自然に続くドラムを。曲の流れ（同じ所の繰り返し、区切りのフィル）と原曲の打点に合わせ、いちばんありそうなものを最初に。';

function aiCandidate(pc: PhraseCandidate, from: number, len: number): Candidate {
  const measures: CNote[][] = Array.from({ length: len }, () => []);
  for (const n of pc.notes) {
    const i = n.m - from;
    if (i >= 0 && i < len) measures[i].push({ ch: n.ch, f: n.f, v: 0 });
  }
  while (measures.length > 1 && measures[measures.length - 1].length === 0) measures.pop();
  return { kind: 'ai', from, measures, src: null, score: Number.NaN, ctx: 0, audio: null, period: null, name: pc.name, reason: pc.reason };
}

/** 点線の最初の小節（無ければ予測を始める小節）から、設定の小節数の続きを AI に作ってもらう */
export async function askAi() {
  const c = get();
  if (!c.enabled) return;
  if (!hasAiKey()) {
    toast(noKeyTitle(), 'warn');
    return;
  }
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const g = visibleGhost();
  const from = g?.from ?? c.at;
  if (from === null) return;
  // 点線の長さによらず、設定の小節数まで（変わり目のフィルとその先を一緒に考えてもらう）
  const contents = measureContents(doc);
  let len = 0;
  while (len < c.ahead && from + len < 3600 && !contents.has(from + len)) len++;
  if (len === 0) return;
  cancelAi();
  const ac = new AbortController();
  aiAbort = ac;
  set({ aiLoading: true, aiError: null, at: from, dismissed: false });
  try {
    const onsets = aiOnsets();
    const bgm = bgmSource(doc);
    const ctx = buildContext(doc, tempo, {
      kind: 'rhythm',
      from,
      to: from + len - 1,
      instruction: AI_NOTE,
      targetLevel: levelOfField(doc.fields['DLEVEL']),
      onsets: onsets && bgm ? onsets : null,
      offsetSec: bgm?.sec ?? 0,
    });
    const r = await runAi<Parameters<typeof decodeCandidates>[0]>('phrase', { ...phrasePrompt(ctx), schema: phraseSchema(), maxTokens: 3000, signal: ac.signal });
    if (aiAbort !== ac) return;
    aiAbort = null;
    if (!r) {
      set({ aiLoading: false });
      return;
    }
    const ai = decodeCandidates(r.data, { from, to: from + len - 1 }, tempo).map((pc) => aiCandidate(pc, from, len));
    if (ai.length === 0) {
      set({ aiLoading: false, aiError: tr('AIの候補が使える形になりませんでした', "The AI's ideas couldn't be used") });
      return;
    }
    const rest = get().at === from ? get().cands.filter((x) => x.kind !== 'ai') : [];
    set({ aiLoading: false, aiError: null, at: from, cands: [...ai, ...rest], index: 0, dismissed: false });
    revealCurrent();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    if (aiAbort !== ac) return;
    aiAbort = null;
    set({ aiLoading: false, aiError: e instanceof AiError ? e.message : (e as Error).message });
  }
}

ensureAudio();
