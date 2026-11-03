// AI に頼む処理と、その初期設定（2026-11-02 時点の OpenRouter の一覧から選んだ）。
import type { Effort, OrModel } from './openrouter';

export type AiTask = 'songinfo' | 'phrase' | 'measure' | 'level' | 'difficulty' | 'guideline';

export interface TaskDef {
  id: AiTask;
  label: string;
  /** 送る内容（設定画面に出す） */
  sends: string;
  needs: { json: boolean; web?: boolean; reasoning?: boolean };
  model: string;
  effort: Effort;
  why: string;
  /** 1回のおおよそのトークン数（入力・出力）と Web 検索の回数 */
  est: { in: number; out: number; web?: number };
  /** 「1回の目安」の後ろに付ける単位 */
  per?: string;
}

export const TASKS: readonly TaskDef[] = [
  {
    id: 'songinfo',
    label: '曲情報の取得',
    sends: '原曲のファイル名・タグ（曲名・アーティスト・アルバム・年）・曲の長さ・曲名・アーティスト名・YouTubeの動画タイトル',
    needs: { json: true, web: true },
    model: 'anthropic/claude-haiku-5.5',
    effort: 'low',
    why: 'Web検索と道具の呼び出しに対応していて安い。何度か検索して確かめる',
    // 検索して確かめる流れで 4〜5 回やりとりする（前の結果を毎回送り直す）
    est: { in: 24000, out: 2500, web: 3 },
  },
  {
    id: 'phrase',
    label: 'フレーズ候補',
    sends: '前後4小節のチップと原曲の打点の数値',
    needs: { json: true },
    model: 'openai/gpt-6-luna',
    effort: 'low',
    why: '安くて速い',
    est: { in: 2200, out: 1300 },
  },
  {
    id: 'measure',
    label: '小節の生成',
    sends: '前後4小節と似ている小節のチップ・原曲の打点の数値・前後の小節で使っているレーンの割合',
    needs: { json: true },
    model: 'openai/gpt-6.1-terra',
    effort: 'low',
    // 2026-11-03 隠した17小節の精度テストで GPT-6 Luna より当たり（作者の譜面との一致 0.86 対 0.74）、速い（約6秒 対 約20秒）
    why: '耳コピの精度テストで安いモデルより当たり、速い（約6秒）',
    est: { in: 3000, out: 600 },
  },
  {
    id: 'level',
    label: 'レベル判定',
    sends: 'ガイドライン・譜面の特徴量・似た譜面5つ',
    needs: { json: true, reasoning: true },
    model: 'openai/gpt-6.1-terra',
    effort: 'medium',
    why: '推論が強く、料金は中くらい',
    est: { in: 4000, out: 1500 },
  },
  {
    id: 'difficulty',
    label: '難易度生成の方針',
    sends: 'セクションごとの特徴量・ガイドライン・必ず残すもの',
    needs: { json: true, reasoning: true },
    model: 'anthropic/claude-sonnet-5.5',
    effort: 'high',
    why: '音楽的な判断の質を優先',
    est: { in: 6000, out: 3500 },
    per: ' / 1難易度',
  },
  {
    id: 'guideline',
    label: 'ガイドラインの下書き',
    sends: 'レベル帯ごとの出現率と代表譜面の特徴量',
    needs: { json: true, reasoning: true },
    model: 'anthropic/claude-sonnet-5.5',
    effort: 'high',
    why: 'たまにしか使わないので質を優先',
    est: { in: 9000, out: 7000 },
    per: ' / 全レベル帯',
  },
];

export const taskDef = (id: AiTask) => TASKS.find((t) => t.id === id)!;

/** 一覧が取れないときの料金（100万トークンあたりのドル） */
const KNOWN: Record<string, { name: string; p: number; c: number; web?: number; json: boolean; reasoning: boolean; webNative: boolean }> = {
  'anthropic/claude-haiku-5.5': { name: 'Claude Haiku 5.5', p: 0.1, c: 0.5, web: 0.01, json: true, reasoning: true, webNative: true },
  'openai/gpt-6-luna': { name: 'GPT-6 Luna', p: 0.1, c: 0.5, json: true, reasoning: true, webNative: false },
  'openai/gpt-6.1-terra': { name: 'GPT-6.1 Terra', p: 1, c: 5, json: true, reasoning: true, webNative: true },
  'anthropic/claude-sonnet-5.5': { name: 'Claude Sonnet 5.5', p: 2, c: 10, web: 0.01, json: true, reasoning: true, webNative: true },
};

/** 一覧に無いモデルでも、知っている範囲で形をそろえる */
export function modelInfo(id: string, models: readonly OrModel[]): OrModel | null {
  const m = models.find((x) => x.id === id);
  if (m) return m;
  const k = KNOWN[id];
  if (!k) return null;
  return {
    id,
    name: k.name,
    created: 0,
    context: 200000,
    pricePrompt: k.p / 1e6,
    priceCompletion: k.c / 1e6,
    priceRequest: 0,
    priceWebSearch: k.web ?? 0,
    params: [],
    json: k.json,
    structured: k.json,
    reasoning: k.reasoning,
    web: k.webNative,
    tools: true,
  };
}

export function modelLabel(id: string, models: readonly OrModel[]): string {
  return modelInfo(id, models)?.name ?? id;
}

const EFFORT_MUL: Record<Effort, number> = { none: 1, low: 1.4, medium: 2, high: 3 };
/** OpenRouter の検索（Exa）を使うときの1回の料金（5件） */
export const EXA_SEARCH_COST = 0.02;

/** 1回の費用の目安（ドル） */
export function estimateCost(m: OrModel | null, tokens: { in: number; out: number; web?: number }, effort: Effort, web: boolean): number | null {
  if (!m) return null;
  const outMul = m.reasoning ? EFFORT_MUL[effort] : 1;
  let c = tokens.in * m.pricePrompt + tokens.out * outMul * m.priceCompletion + m.priceRequest;
  if (web) c += (m.priceWebSearch > 0 ? m.priceWebSearch : EXA_SEARCH_COST) * (tokens.web ?? 1);
  return c;
}

export function meetsNeeds(m: OrModel, t: TaskDef): boolean {
  if (t.needs.json && !m.json) return false;
  if (t.needs.reasoning && !m.reasoning) return false;
  if (t.needs.web && !(m.web || m.tools)) return false;
  return true;
}

const MAJOR = /^(anthropic|openai|google|deepseek|moonshotai|x-ai|mistralai|qwen|minimax|meta-llama|z-ai)\//;

export type ModelSort = 'recommended' | 'cheap' | 'new';

export function sortModels(list: OrModel[], t: TaskDef, sort: ModelSort): OrModel[] {
  const cost = (m: OrModel) => estimateCost(m, t.est, 'low', false) ?? Infinity;
  const arr = [...list];
  if (sort === 'cheap') return arr.sort((a, b) => cost(a) - cost(b));
  if (sort === 'new') return arr.sort((a, b) => b.created - a.created);
  const score = (m: OrModel) => (m.id === t.model ? 1e12 : 0) + (meetsNeeds(m, t) ? 1e11 : 0) + (MAJOR.test(m.id) ? 1e10 : 0) + m.created;
  return arr.sort((a, b) => score(b) - score(a));
}

/** ドルの表示（小さい額は桁を増やす） */
export function formatUsd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (x === 0) return '$0';
  if (x < 0.01) return `$${x.toFixed(4)}`;
  if (x < 1) return `$${x.toFixed(3).replace(/0$/, '')}`;
  return `$${x.toFixed(2)}`;
}

/** 100万トークンあたりの料金 */
export function perMillion(x: number): string {
  const v = x * 1e6;
  if (v === 0) return '無料';
  return `$${v < 1 ? v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : v.toFixed(2).replace(/\.00$/, '')}`;
}
