// AI（OpenRouter）の設定と呼び出し。キー・処理ごとのモデル・使いすぎ防止・使った額の記録。
// キーは暗号化されないので、「保存しない」を選ぶとタブを閉じたら消える（sessionStorage）。
import { tr } from '../i18n';
import { create } from 'zustand';
import { AiError, chat, estimateTokens, fetchKeyInfo, fetchModels, isChatModel, missingKeys, parseJsonLoose, repairPrompt, type ChatResult, type Effort, type KeyInfo, type OrModel } from '../ai/openrouter';
import { estimateCost, modelInfo, taskDef, TASKS, type AiTask } from '../ai/tasks';
import { confirmDialog } from '../ui/dialogs';

export interface TaskConfig {
  model: string;
  effort: Effort;
  fallback: string | null;
}

export interface SpendLog {
  at: number;
  task: AiTask;
  model: string;
  cost: number;
}

export interface Spend {
  month: string;
  monthTotal: number;
  day: string;
  dayTotal: number;
  log: SpendLog[];
}

export interface AiState {
  key: string;
  remember: boolean;
  tasks: Record<AiTask, TaskConfig>;
  models: OrModel[];
  modelsAt: number;
  modelsStatus: 'idle' | 'loading' | 'error';
  modelsError: string | null;
  keyInfo: KeyInfo | null;
  keyStatus: 'none' | 'checking' | 'ok' | 'error';
  keyError: string | null;
  /** つながらなかったときの HTTP の番号（401 はキー違い・402 は残高不足。0 はネットにつながらない） */
  keyErrorCode: number;
  /** 1回の目安がこれを超えたら確認する（ドル） */
  confirmOver: number;
  /** このアプリで使う月の上限（ドル） */
  monthlyCap: number;
  spend: Spend;
  /** 実行中の処理 */
  running: Partial<Record<AiTask, number>>;
}

const K_SETTINGS = 'dtxe.ai.v1';
const K_KEY = 'dtxe.ai.key';
const K_MODELS = 'dtxe.ai.models.v1';
const K_SPEND = 'dtxe.ai.spend.v1';

export const defaultTasks = (): Record<AiTask, TaskConfig> =>
  Object.fromEntries(TASKS.map((t) => [t.id, { model: t.model, effort: t.effort, fallback: null }])) as Record<AiTask, TaskConfig>;

function readJson<T>(store: Storage | undefined, k: string): T | null {
  try {
    const raw = store?.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(store: Storage | undefined, k: string, v: unknown) {
  try {
    store?.setItem(k, JSON.stringify(v));
  } catch {
    // 保存できなくても動く
  }
}

const ls = typeof localStorage !== 'undefined' ? localStorage : undefined;
const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

function freshSpend(s: Spend | null): Spend {
  const base: Spend = s ?? { month: thisMonth(), monthTotal: 0, day: today(), dayTotal: 0, log: [] };
  const out = { ...base };
  if (out.month !== thisMonth()) Object.assign(out, { month: thisMonth(), monthTotal: 0 });
  if (out.day !== today()) Object.assign(out, { day: today(), dayTotal: 0 });
  return out;
}

function initial(): AiState {
  const saved = readJson<{ remember?: boolean; tasks?: Partial<Record<AiTask, TaskConfig>>; confirmOver?: number; monthlyCap?: number }>(ls, K_SETTINGS) ?? {};
  const remember = saved.remember ?? true;
  let key = '';
  try {
    key = (remember ? ls?.getItem(K_KEY) : ss?.getItem(K_KEY)) ?? ss?.getItem(K_KEY) ?? '';
  } catch {
    key = '';
  }
  const cache = readJson<{ at: number; models: OrModel[] }>(ls, K_MODELS);
  const tasks = defaultTasks();
  for (const t of TASKS) if (saved.tasks?.[t.id]) tasks[t.id] = { ...tasks[t.id], ...saved.tasks[t.id] };
  // 以前の版で選べてしまった :batch（チャットでは呼べない）は直す
  for (const t of TASKS) {
    const c = tasks[t.id];
    if (!isChatModel(c.model)) tasks[t.id] = { ...c, model: t.model };
    if (c.fallback && !isChatModel(c.fallback)) tasks[t.id] = { ...tasks[t.id], fallback: null };
  }
  return {
    key,
    remember,
    tasks,
    models: cache?.models ?? [],
    modelsAt: cache?.at ?? 0,
    modelsStatus: 'idle',
    modelsError: null,
    keyInfo: null,
    keyStatus: key ? 'checking' : 'none',
    keyError: null,
    keyErrorCode: 0,
    confirmOver: saved.confirmOver ?? 0.3,
    monthlyCap: saved.monthlyCap ?? 5,
    spend: freshSpend(readJson<Spend>(ls, K_SPEND)),
    running: {},
  };
}

export const useAi = create<AiState>(initial);
const get = useAi.getState;
const set = useAi.setState;

function persistSettings() {
  const s = get();
  writeJson(ls, K_SETTINGS, { remember: s.remember, tasks: s.tasks, confirmOver: s.confirmOver, monthlyCap: s.monthlyCap });
}

export const hasAiKey = (s: AiState = get()) => s.key.trim().length > 0;
export const useHasAiKey = () => useAi((s) => s.key.trim().length > 0);

/** AI のキーが無いときの説明（表示のたびに今の言語で）。画面のボタンは ui/aiGuide/KeyGate.tsx の説明を出す */
export function noKeyTitle(): string {
  return tr('OpenRouter のキーを入れると使えます', 'Available once you add an OpenRouter key');
}

export function setKey(key: string) {
  const k = key.trim();
  set({ key: k, keyInfo: null, keyStatus: k ? 'checking' : 'none', keyError: null, keyErrorCode: 0 });
  try {
    if (get().remember) {
      if (k) ls?.setItem(K_KEY, k);
      else ls?.removeItem(K_KEY);
      ss?.removeItem(K_KEY);
    } else {
      ls?.removeItem(K_KEY);
      if (k) ss?.setItem(K_KEY, k);
      else ss?.removeItem(K_KEY);
    }
  } catch {
    // 保存できなくてもこのタブでは使える
  }
  if (k) void checkKey();
}

export function setRemember(remember: boolean) {
  set({ remember });
  persistSettings();
  setKey(get().key);
}

let keyAbort: AbortController | null = null;

/** キーの確認と使用額の取得（/api/v1/key） */
export async function checkKey(): Promise<boolean> {
  const k = get().key;
  if (!k) return false;
  keyAbort?.abort();
  const ac = (keyAbort = new AbortController());
  set({ keyStatus: 'checking', keyError: null, keyErrorCode: 0 });
  try {
    const info = await fetchKeyInfo(k, ac.signal);
    if (ac.signal.aborted) return false;
    set({ keyInfo: info, keyStatus: 'ok' });
    return true;
  } catch (e) {
    if (ac.signal.aborted) return false;
    set({ keyStatus: 'error', keyError: (e as Error).message, keyErrorCode: e instanceof AiError ? e.status : 0 });
    return false;
  }
}

/** モデル一覧（キー不要）。1日たったら取り直す */
export async function refreshModels(force = false): Promise<void> {
  const s = get();
  if (s.modelsStatus === 'loading') return;
  if (!force && s.models.length > 0 && Date.now() - s.modelsAt < 24 * 3600 * 1000) return;
  set({ modelsStatus: 'loading', modelsError: null });
  try {
    const models = await fetchModels();
    const at = Date.now();
    set({ models, modelsAt: at, modelsStatus: 'idle' });
    writeJson(ls, K_MODELS, { at, models });
  } catch (e) {
    set({ modelsStatus: 'error', modelsError: (e as Error).message });
  }
}

export function setTaskConfig(task: AiTask, patch: Partial<TaskConfig>) {
  set((s) => ({ tasks: { ...s.tasks, [task]: { ...s.tasks[task], ...patch } } }));
  persistSettings();
}

export function resetTasks() {
  set({ tasks: defaultTasks() });
  persistSettings();
}

export function setLimits(patch: { confirmOver?: number; monthlyCap?: number }) {
  set(patch);
  persistSettings();
}

/** 処理ごとの1回の目安（ドル） */
export function taskCostEstimate(task: AiTask, s: AiState = get(), tokens?: { in: number; out: number }): number | null {
  const def = taskDef(task);
  const cfg = s.tasks[task];
  return estimateCost(modelInfo(cfg.model, s.models), tokens ?? def.est, cfg.effort, !!def.needs.web);
}

function recordSpend(task: AiTask, model: string, cost: number) {
  const sp = freshSpend(get().spend);
  const next: Spend = {
    ...sp,
    monthTotal: sp.monthTotal + cost,
    dayTotal: sp.dayTotal + cost,
    log: [{ at: Date.now(), task, model, cost }, ...sp.log].slice(0, 200),
  };
  set({ spend: next });
  writeJson(ls, K_SPEND, next);
}

export interface RunOptions {
  system: string;
  user: string;
  schema?: { name: string; schema: object };
  /** 出力の上限（トークン） */
  maxTokens?: number;
  signal?: AbortSignal;
  /** 確認ダイアログを出さない（再調整ループの2回目以降など） */
  quiet?: boolean;
}

export interface RunResult<T> extends ChatResult {
  data: T;
  costUsed: number;
}

/** AI を使う1回分（何度か呼ぶ処理も、まとめて1回と数える） */
export interface AiSession {
  key: string;
  cfg: TaskConfig;
  info: OrModel | null;
  /** 返ってきた答えの費用を記録して返す */
  charge: (r: ChatResult) => number;
  /** 終わったら必ず呼ぶ */
  end: () => void;
}

/** 今月の上限に届くなら止める */
export function checkMonthlyCap(add: number) {
  const s = get();
  if (freshSpend(s.spend).monthTotal + add > s.monthlyCap) {
    throw new AiError(
      tr(
        `今月の上限（$${s.monthlyCap.toFixed(2)}）に届くため止めました。設定 › AI で上限を変えられます`,
        `Stopped because this would go over this month's limit ($${s.monthlyCap.toFixed(2)}). You can change the limit in Settings › AI`,
      ),
    );
  }
}

/**
 * AI を使い始める。キーの有無・月の上限・1回の目安（est ドル）の確認を通す。断られたら null。
 * 使い終わったら end() を呼ぶ。
 */
export async function beginAi(task: AiTask, est: number, quiet = false): Promise<AiSession | null> {
  const s = get();
  if (!hasAiKey(s)) throw new AiError(noKeyTitle());
  const def = taskDef(task);
  const cfg = s.tasks[task];
  const info = modelInfo(cfg.model, s.models);
  checkMonthlyCap(est);
  if (!quiet && est > s.confirmOver) {
    const ok = await confirmDialog({
      title: tr(`${def.label}をAIに頼みますか？`, `Ask AI for: ${def.label}?`),
      body: tr(
        `1回の目安は約 $${est.toFixed(3)} です（設定の「確認する額」$${s.confirmOver.toFixed(2)} を超えています）。\nモデル: ${info?.name ?? cfg.model}`,
        `One run costs about $${est.toFixed(3)} (more than the “ask first above” amount of $${s.confirmOver.toFixed(2)} in Settings).\nModel: ${info?.name ?? cfg.model}`,
      ),
      ok: tr('頼む', 'Ask AI'),
    });
    if (!ok) return null;
  }
  set((st) => ({ running: { ...st.running, [task]: (st.running[task] ?? 0) + 1 } }));
  let ended = false;
  return {
    key: s.key,
    cfg,
    info,
    charge: (r: ChatResult) => {
      const used = r.model ? modelInfo(r.model, get().models) : info;
      const cost = r.cost ?? estimateCost(used, { in: r.promptTokens, out: r.completionTokens }, 'none', false) ?? est;
      recordSpend(task, r.model, cost);
      return cost;
    },
    end: () => {
      if (ended) return;
      ended = true;
      set((st) => ({ running: { ...st.running, [task]: Math.max(0, (st.running[task] ?? 1) - 1) } }));
    },
  };
}

/**
 * AI を呼ぶ。キーの有無・月の上限・1回の目安の確認を通してから送り、使った額を記録する。
 * 断られたら null を返す。
 */
export async function runAi<T>(task: AiTask, o: RunOptions): Promise<RunResult<T> | null> {
  const s = get();
  if (!hasAiKey(s)) throw new AiError(noKeyTitle());
  const def = taskDef(task);
  const cfg = s.tasks[task];
  const info = modelInfo(cfg.model, s.models);
  const tokensIn = estimateTokens(o.system + o.user) + 50;
  const est = estimateCost(info, { in: tokensIn, out: o.maxTokens ? Math.min(o.maxTokens, def.est.out * 1.5) : def.est.out }, cfg.effort, !!def.needs.web) ?? 0;
  const session = await beginAi(task, est, o.quiet);
  if (!session) return null;
  const spent = session.charge;
  try {
    const r = await chat({
      key: s.key,
      model: cfg.model,
      fallback: cfg.fallback,
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user },
      ],
      effort: cfg.effort,
      reasoning: info ? info.reasoning : undefined,
      schema: o.schema,
      structured: info?.structured ?? false,
      json: info ? info.json : true,
      web: !!def.needs.web,
      maxTokens: o.maxTokens,
      signal: o.signal,
    });
    const cost = spent(r);
    if (!o.schema) return { ...r, data: r.text as unknown as T, costUsed: cost };
    let data: T | null = null;
    try {
      data = parseJsonLoose<T>(r.text);
    } catch {
      data = null;
    }
    if (data !== null && missingKeys(o.schema.schema, data).length === 0) return { ...r, data, costUsed: cost };
    if (!r.text.trim()) {
      throw new AiError(
        r.finish === 'length'
          ? tr(
              'AIが考えている途中で出力の上限に届き、答えが空でした。推論の強さを下げるか、別のモデルを選んでください',
              'The AI hit its output limit while thinking and returned nothing. Lower the reasoning effort or choose another model',
            )
          : tr('AIの答えが空でした。もう一度試すか、別のモデルを選んでください', 'The AI returned an empty answer. Try again or choose another model'),
      );
    }
    // 形が崩れていたら（Web 検索を使うと指定の形を無視するモデルがある）、同じモデルに形だけ直してもらう。
    // Web 検索なし・推論は低めなので費用はわずか。
    const rp = repairPrompt(o.schema, r.text);
    const r2 = await chat({
      key: s.key,
      model: cfg.model,
      fallback: cfg.fallback,
      messages: [
        { role: 'system', content: rp.system },
        { role: 'user', content: rp.user },
      ],
      effort: 'low',
      reasoning: info ? info.reasoning : undefined,
      schema: o.schema,
      structured: info?.structured ?? false,
      json: info ? info.json : true,
      maxTokens: o.maxTokens,
      signal: o.signal,
    });
    const cost2 = spent(r2);
    const fixed = parseJsonLoose<T>(r2.text);
    const still = missingKeys(o.schema.schema, fixed);
    if (still.length)
      throw new AiError(
        tr(
          `AIの答えに必要な項目（${still.join('、')}）がありませんでした。もう一度試すか、別のモデルを選んでください`,
          `The AI's answer was missing required fields (${still.join(', ')}). Try again or choose another model`,
        ),
      );
    // 出典（Web 検索の結果）は最初の答えのものを使う
    return { ...r2, citations: r.citations.length ? r.citations : r2.citations, webSearches: r.webSearches, data: fixed, costUsed: cost + cost2 };
  } finally {
    session.end();
  }
}

/** 起動時：キーがあれば確かめる */
export function initAi() {
  if (get().key) void checkKey();
}
