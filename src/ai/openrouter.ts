// OpenRouter の呼び出し。キーはブラウザの中だけに置き、ブラウザから直接送る（サーバーは通さない）。
import { tr } from '../i18n';
const BASE = 'https://openrouter.ai/api/v1';

export interface OrModel {
  id: string;
  name: string;
  /** 公開日（UNIX 秒） */
  created: number;
  context: number;
  /** 1トークンあたりのドル */
  pricePrompt: number;
  priceCompletion: number;
  /** 1回の呼び出しの固定料金 */
  priceRequest: number;
  /** Web検索1回の料金（モデルが自前で検索するとき） */
  priceWebSearch: number;
  params: string[];
  json: boolean;
  structured: boolean;
  reasoning: boolean;
  /** 自前の Web 検索がある（無くても OpenRouter の検索で使える） */
  web: boolean;
  tools: boolean;
}

interface RawModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: Record<string, string | number | undefined>;
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[]; input_modalities?: string[] };
}

const num = (x: unknown) => {
  const v = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
};

export function parseModels(raw: { data?: RawModel[] }): OrModel[] {
  const out: OrModel[] = [];
  for (const m of raw.data ?? []) {
    if (!m?.id) continue;
    // :batch はバッチ API 専用で、chat/completions では 404 になる
    if (!isChatModel(m.id)) continue;
    const outMod = m.architecture?.output_modalities;
    if (outMod && !outMod.includes('text')) continue;
    const params = m.supported_parameters ?? [];
    const p = m.pricing ?? {};
    out.push({
      id: m.id,
      name: (m.name ?? m.id).replace(/^[^:]+:\s*/, ''),
      created: m.created ?? 0,
      context: m.context_length ?? 0,
      pricePrompt: num(p.prompt),
      priceCompletion: num(p.completion),
      priceRequest: num(p.request),
      priceWebSearch: num(p.web_search),
      params,
      json: params.includes('response_format') || params.includes('structured_outputs'),
      structured: params.includes('structured_outputs'),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      web: params.includes('web_search_options') || num(p.web_search) > 0,
      tools: params.includes('tools'),
    });
  }
  return out;
}

/** chat/completions で呼べるモデルか（バッチ専用の :batch は呼べない） */
export function isChatModel(id: string): boolean {
  return !/:batch$/i.test(id);
}

export async function fetchModels(signal?: AbortSignal): Promise<OrModel[]> {
  const r = await fetch(`${BASE}/models`, { signal });
  if (!r.ok) throw new AiError(tr(`モデル一覧を取れませんでした（${r.status}）`, `Couldn't get the model list (${r.status})`), r.status);
  return parseModels(await r.json());
}

export interface KeyInfo {
  label: string;
  usage: number;
  usageDaily: number | null;
  usageMonthly: number | null;
  limit: number | null;
  limitRemaining: number | null;
  isFree: boolean;
}

export async function fetchKeyInfo(key: string, signal?: AbortSignal): Promise<KeyInfo> {
  const r = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!r.ok) throw await errorOf(r);
  const d = ((await r.json()) as { data?: Record<string, unknown> }).data ?? {};
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    label: String(d.label ?? ''),
    usage: n(d.usage) ?? 0,
    usageDaily: n(d.usage_daily),
    usageMonthly: n(d.usage_monthly),
    limit: n(d.limit),
    limitRemaining: n(d.limit_remaining),
    isFree: d.is_free_tier === true,
  };
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

async function errorOf(r: Response): Promise<AiError> {
  let detail = '';
  try {
    const j = (await r.json()) as { error?: { message?: string; metadata?: { raw?: unknown } } };
    detail = j.error?.message ?? '';
    // 「Provider returned error」だけでは分からないので、提供元のことばを足す
    const raw = j.error?.metadata?.raw;
    if (typeof raw === 'string') {
      let inner = raw;
      try {
        inner = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw;
      } catch {
        // そのまま
      }
      if (inner && !detail.includes(inner)) detail = `${detail}${tr('（', ' (')}${inner.slice(0, 200)}${tr('）', ')')}`;
    }
  } catch {
    // 本文が JSON でなくてもよい
  }
  const msg =
    r.status === 401
      ? tr('キーが正しくないか、無効になっています', 'The key is wrong or has been disabled')
      : r.status === 402
        ? tr('OpenRouter の残高が足りません', 'Not enough OpenRouter credits')
        : r.status === 403
          ? tr('このキーでは使えません（上限やモデルの制限）', "This key can't be used for this (a limit or model restriction)")
          : r.status === 408
            ? tr('時間がかかりすぎて止まりました', 'It took too long and was stopped')
            : r.status === 429
              ? tr('混み合っています。少し待ってからやり直してください', 'Too many requests right now. Wait a moment and try again')
              : r.status >= 500
                ? tr('OpenRouter かモデルの提供元でエラーが起きました', 'An error happened at OpenRouter or the model provider')
                : tr(`呼び出しに失敗しました（${r.status}）`, `The request failed (${r.status})`);
  return new AiError(detail ? `${msg}: ${detail}` : msg, r.status);
}

export type Effort = 'none' | 'low' | 'medium' | 'high';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 自分で用意する道具（関数）。モデルが呼びたいと言ったら、こちらで動かして結果を返す */
export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Web 検索（OpenRouter が代わりに検索する道具）の設定 */
export interface WebSearchOptions {
  /** 1回の検索で返すページ数 */
  maxResults?: number;
  /** 1回の呼び出しで検索してよい回数 */
  maxUses?: number;
}

export interface ChatRequest {
  key: string;
  model: string;
  fallback?: string | null;
  messages: ChatMessage[];
  effort?: Effort;
  /** モデルが推論に対応しているか（分からなければ送る） */
  reasoning?: boolean;
  schema?: { name: string; schema: object };
  /** JSON Schema で縛れるか。縛れなければ json_object を頼む */
  structured?: boolean;
  json?: boolean;
  web?: boolean | WebSearchOptions;
  /** 自分で用意する道具 */
  tools?: FunctionTool[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Citation {
  url: string;
  title: string;
}

export interface ChatResult {
  text: string;
  model: string;
  citations: Citation[];
  promptTokens: number;
  completionTokens: number;
  /** OpenRouter が返した費用（ドル）。無ければ null */
  cost: number | null;
  webSearches: number;
  /** 止まった理由（stop・length など） */
  finish: string;
  /** モデルが呼びたい道具 */
  toolCalls: ToolCall[];
  /** 会話を続けるときにそのまま返す、モデルの発言（推論の署名を含む） */
  message: Extract<ChatMessage, { role: 'assistant' }>;
}

export function buildChatBody(req: Omit<ChatRequest, 'key' | 'signal'>): Record<string, unknown> {
  const body: Record<string, unknown> = { messages: req.messages };
  if (req.fallback && req.fallback !== req.model) body.models = [req.model, req.fallback];
  else body.model = req.model;
  if (req.effort && req.reasoning !== false) body.reasoning = { effort: req.effort };
  if (req.schema && req.structured) {
    body.response_format = { type: 'json_schema', json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } };
  } else if (req.schema && req.json !== false) {
    body.response_format = { type: 'json_object' };
  }
  const tools: object[] = [];
  if (req.web) {
    const w = typeof req.web === 'object' ? req.web : {};
    const parameters: Record<string, number> = { max_results: w.maxResults ?? 5 };
    if (w.maxUses) parameters.max_uses = w.maxUses;
    tools.push({ type: 'openrouter:web_search', parameters });
  }
  if (req.tools?.length) tools.push(...req.tools);
  if (tools.length) body.tools = tools;
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  body.usage = { include: true };
  return body;
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const { key, signal, ...rest } = req;
  let r: Response;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin + location.pathname,
        'X-Title': 'DTX Web Editor',
      },
      body: JSON.stringify(buildChatBody(rest)),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new AiError(tr('OpenRouter につながりませんでした（ネットワークを確かめてください）', "Couldn't reach OpenRouter (check your network)"));
  }
  if (!r.ok) throw await errorOf(r);
  const j = (await r.json()) as {
    model?: string;
    error?: { message?: string };
    choices?: {
      finish_reason?: string;
      message?: { content?: unknown; tool_calls?: ToolCall[]; reasoning_details?: unknown[]; annotations?: { type?: string; url_citation?: { url?: string; title?: string } }[] };
    }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      server_tool_use?: { web_search_requests?: number };
      server_tool_use_details?: { web_search_requests?: number };
    };
  };
  if (j.error) throw new AiError(j.error.message ?? tr('モデルがエラーを返しました', 'The model returned an error'));
  const msg = j.choices?.[0]?.message;
  const c = msg?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('') : '';
  const citations: Citation[] = [];
  for (const a of msg?.annotations ?? []) {
    const u = a.url_citation;
    if (a.type === 'url_citation' && u?.url && !citations.some((x) => x.url === u.url)) citations.push({ url: u.url, title: u.title ?? u.url });
  }
  const toolCalls = (msg?.tool_calls ?? []).filter((t) => t?.function?.name);
  const message: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments ?? '{}' } }));
  if (msg?.reasoning_details?.length) message.reasoning_details = msg.reasoning_details;
  const u = j.usage;
  return {
    text,
    model: j.model ?? req.model,
    citations,
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    cost: typeof u?.cost === 'number' ? u.cost : null,
    webSearches: u?.server_tool_use_details?.web_search_requests ?? u?.server_tool_use?.web_search_requests ?? (req.web && !req.tools?.length ? 1 : 0),
    finish: j.choices?.[0]?.finish_reason ?? '',
    toolCalls,
    message,
  };
}

/** 返ってきた文から JSON を取り出す（```json で囲まれていても、前後に文があっても読む） */
export function parseJsonLoose<T = unknown>(text: string): T {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fence ? fence[1] : t;
  try {
    return JSON.parse(body) as T;
  } catch {
    const a = body.indexOf('{');
    const b = body.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(body.slice(a, b + 1)) as T;
      } catch {
        // 下で投げる
      }
    }
  }
  throw new AiError(tr('AIの答えをJSONとして読めませんでした。もう一度試すか、別のモデルを選んでください', "Couldn't read the AI's answer as JSON. Try again or pick another model"));
}

/**
 * 答えが JSON Schema の形になっているか（一番外の必須キーと型だけ見る）。足りないキーを返す。
 * Web 検索などのツールを使うと、モデルによっては response_format の指定が効かず、勝手なキー名で返してくる。
 */
export function missingKeys(schema: object, data: unknown): string[] {
  const sc = schema as { required?: string[]; properties?: Record<string, { type?: string }> };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return sc.required?.length ? [...sc.required] : ['(object)'];
  const d = data as Record<string, unknown>;
  const out: string[] = [];
  for (const k of sc.required ?? []) {
    const v = d[k];
    const t = sc.properties?.[k]?.type;
    if (v === undefined || v === null) out.push(k);
    else if (t === 'array' && !Array.isArray(v)) out.push(k);
    else if (t === 'string' && typeof v !== 'string') out.push(k);
    else if ((t === 'number' || t === 'integer') && typeof v !== 'number') out.push(k);
  }
  return out;
}

/** 形の崩れた答えを、指定の JSON の形に直してもらうための頼み方 */
export function repairPrompt(schema: { name: string; schema: object }, text: string): { system: string; user: string } {
  const keys = Object.keys((schema.schema as { properties?: object }).properties ?? {});
  // 中身はそのまま（言語も変えない）で形だけ直してもらうので、言語の指示は足さない i18n-ignore-start
  return {
    system: [
      'あなたは JSON の形をそろえる係です。',
      '下の「AIの答え」の中身を変えずに、指定の JSON Schema の形に直してください。',
      `一番外のキーは ${keys.join(', ')} です。キー名が違うものは意味の合うキーに移し、答えに無い項目は空の文字列（数なら 0、配列なら空）にしてください。`,
      '新しい事実を足したり、推測で埋めたりしないでください。直したことの説明はどの項目にも書かないでください。答えは JSON だけで返してください。',
    ].join('\n'),
    user: `JSON Schema:\n${JSON.stringify(schema.schema)}\n\nAIの答え:\n${text.slice(0, 12000)}`,
  };
  // i18n-ignore-end
}

/** 文字数からトークン数をおおまかに見積もる（日本語は1文字≒1トークン、英数字は4文字≒1トークン） */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.6 + other * 1.1);
}
