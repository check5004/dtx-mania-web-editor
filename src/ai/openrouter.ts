// OpenRouter の呼び出し。キーはブラウザの中だけに置き、ブラウザから直接送る（サーバーは通さない）。
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

export async function fetchModels(signal?: AbortSignal): Promise<OrModel[]> {
  const r = await fetch(`${BASE}/models`, { signal });
  if (!r.ok) throw new AiError(`モデル一覧を取れませんでした（${r.status}）`, r.status);
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
    const j = (await r.json()) as { error?: { message?: string } };
    detail = j.error?.message ?? '';
  } catch {
    // 本文が JSON でなくてもよい
  }
  const msg =
    r.status === 401
      ? 'キーが正しくないか、無効になっています'
      : r.status === 402
        ? 'OpenRouter の残高が足りません'
        : r.status === 403
          ? 'このキーでは使えません（上限やモデルの制限）'
          : r.status === 408
            ? '時間がかかりすぎて止まりました'
            : r.status === 429
              ? '混み合っています。少し待ってからやり直してください'
              : r.status >= 500
                ? 'OpenRouter かモデルの提供元でエラーが起きました'
                : `呼び出しに失敗しました（${r.status}）`;
  return new AiError(detail ? `${msg}: ${detail}` : msg, r.status);
}

export type Effort = 'none' | 'low' | 'medium' | 'high';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  web?: boolean;
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
  if (req.web) body.tools = [{ type: 'openrouter:web_search', parameters: { max_results: 5 } }];
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
    throw new AiError('OpenRouter につながりませんでした（ネットワークを確かめてください）');
  }
  if (!r.ok) throw await errorOf(r);
  const j = (await r.json()) as {
    model?: string;
    error?: { message?: string };
    choices?: { message?: { content?: unknown; annotations?: { type?: string; url_citation?: { url?: string; title?: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; server_tool_use?: { web_search_requests?: number } };
  };
  if (j.error) throw new AiError(j.error.message ?? 'モデルがエラーを返しました');
  const msg = j.choices?.[0]?.message;
  const c = msg?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('') : '';
  const citations: Citation[] = [];
  for (const a of msg?.annotations ?? []) {
    const u = a.url_citation;
    if (a.type === 'url_citation' && u?.url && !citations.some((x) => x.url === u.url)) citations.push({ url: u.url, title: u.title ?? u.url });
  }
  return {
    text,
    model: j.model ?? req.model,
    citations,
    promptTokens: j.usage?.prompt_tokens ?? 0,
    completionTokens: j.usage?.completion_tokens ?? 0,
    cost: typeof j.usage?.cost === 'number' ? j.usage.cost : null,
    webSearches: j.usage?.server_tool_use?.web_search_requests ?? (req.web ? 1 : 0),
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
  throw new AiError('AIの答えをJSONとして読めませんでした。もう一度試すか、別のモデルを選んでください');
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
