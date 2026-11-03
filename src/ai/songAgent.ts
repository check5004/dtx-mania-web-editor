// 曲情報を調べる小さなエージェント。
// 手がかり（原曲のファイル名・タグ・曲の長さ・譜面の値）から曲を特定し、道具（Web検索・iTunes・YouTube の確認・画像の確認）を
// 自分で選んで使い、正式表記・ジャンル・年・コメント・公式の YouTube 動画・ジャケットを答える。
// URL はでっち上げやすいので、答えに入れてよいのは道具で確かめたものだけにする。
import type { AudioTags } from '../fs/tags';
import { AiError, parseJsonLoose, type ChatMessage, type ChatResult, type Citation, type FunctionTool, type ToolCall, type WebSearchOptions } from './openrouter';
import { cleanSongInfo, SONG_INFO_SCHEMA, youtubeId, type SongInfoAnswer, type StoreHit } from './songInfo';

// ---- 手がかり ----------------------------------------------------------------------

export interface SongClues {
  /** 原曲の音声ファイル名 */
  fileName: string | null;
  /** 曲フォルダの名前 */
  folderName: string | null;
  /** 音声ファイルのタグ（画像は除く） */
  tags: Omit<AudioTags, 'picture'> | null;
  /** タグにジャケット画像が入っているか */
  tagPicture: boolean;
  /** 曲の長さ（秒） */
  durationSec: number | null;
  /** 譜面に今入っている値 */
  fields: { title: string; artist: string; genre: string; bpm: string };
  /** 参照映像（設定済みなら） */
  youtube: { url: string; title?: string; channel?: string } | null;
}

/** 拡張子を外す */
export const fileStem = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]{1,5}$/, '');

const NOISE =
  /\s*[([（【［〔「『]\s*[^)\]）】］〕」』]*?(official|music\s*video|lyric|audio|video|\bmv\b|\bpv\b|full|ver\.?|version|\bhd\b|\b4k\b|drum|ドラム|叩いて|cover|カバー|歌って|instrumental|inst|off\s*vocal|オフボーカル|remaster|live|ライブ|short|tv\s*size)[^)\]）】］〕」』]*?\s*[)\]）】］〕」』]/gi;

/** ファイル名やフォルダ名を検索語にする（先頭の番号・「Official Video」などの飾りを外す） */
export function cleanName(s: string): string {
  return fileStem(s)
    .replace(/_/g, ' ')
    .replace(NOISE, ' ')
    .replace(/^\s*(?:disc\s*\d+\s*)?\d{1,3}(?:\s*[-._)]\s*|\s+)/i, '')
    .replace(/^[\s\-–—_.]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 「アーティスト - 曲名」の形なら分ける（どちらが曲名かは決めない） */
export function splitDash(s: string): [string, string] | null {
  const m = /^(.+?)\s+[-–—／/]\s+(.+)$/.exec(s);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

/** 比べるための形（全角半角・大文字小文字・記号・空白をそろえる） */
export function normKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/feat\.?|ft\.|featuring/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 譜面の曲名がファイル名から作った仮のものか（新しい譜面を音声ファイルから作るとファイル名が入る） */
export function titleIsFileName(c: SongClues): boolean {
  if (!c.fields.title) return true;
  const t = normKey(c.fields.title);
  return [c.fileName, c.folderName].some((n) => n && normKey(fileStem(n)) === t);
}

/** 曲を表さない名前（bgm.ogg・Track01.mp3・drums.wav など） */
export function isGenericName(s: string): boolean {
  const k = normKey(cleanName(s));
  return k.length < 2 || /^(track|トラック|audio|song|music|sound|bgm|bgmd|bgmnodrums|drums?|drumless|bass|guitar|vocals?|other|inst|instrumental|preview|pre|mix|master|mstr|new|untitled|無題|新しい曲|音声|録音)\d*$/.test(k);
}

/** iTunes で探す語の候補（よさそうな順） */
export function searchTerms(c: SongClues): string[] {
  const out: string[] = [];
  const add = (s: string | undefined | null) => {
    const t = (s ?? '').replace(/\s{2,}/g, ' ').trim();
    if (t && !isGenericName(t) && !out.some((o) => normKey(o) === normKey(t))) out.push(t);
  };
  if (c.tags?.title) add(`${c.tags.title} ${c.tags.artist ?? c.tags.albumArtist ?? ''}`);
  if (c.fields.title && !titleIsFileName(c)) add(`${c.fields.title} ${c.fields.artist}`);
  if (c.fileName) add(cleanName(c.fileName).replace(/\s+[-–—／/]\s+/, ' '));
  if (c.folderName) add(cleanName(c.folderName).replace(/\s+[-–—／/]\s+/, ' '));
  if (c.fields.title) add(`${cleanName(c.fields.title)} ${c.fields.artist}`);
  return out.slice(0, 3);
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}分${String(Math.round(sec % 60)).padStart(2, '0')}秒`;

/** AI に渡す手がかりの文 */
export function cluesText(c: SongClues): string {
  const lines: string[] = [];
  if (c.fileName) lines.push(`- 原曲のファイル名: ${c.fileName}${isGenericName(c.fileName) ? '（曲名を表さない名前）' : ''}`);
  if (c.folderName) lines.push(`- 曲フォルダの名前: ${c.folderName}`);
  const t = c.tags;
  if (t && (t.title || t.artist || t.album || t.year || t.genre)) {
    const parts = [
      t.title && `曲名「${t.title}」`,
      t.artist && `アーティスト「${t.artist}」`,
      t.albumArtist && t.albumArtist !== t.artist && `アルバムアーティスト「${t.albumArtist}」`,
      t.album && `アルバム「${t.album}」`,
      t.year && `年 ${t.year}`,
      t.genre && `ジャンル「${t.genre}」`,
      t.bpm && `BPM ${t.bpm}`,
    ].filter(Boolean);
    lines.push(`- ファイルのタグ: ${parts.join(' ')}`);
  } else if (c.fileName) {
    lines.push('- ファイルのタグ: なし');
  }
  if (c.tagPicture) lines.push('- タグにジャケット画像あり');
  if (c.durationSec) lines.push(`- 曲の長さ: ${mmss(c.durationSec)}（${Math.round(c.durationSec)}秒）`);
  const f = c.fields;
  const fake = titleIsFileName(c);
  const now = [
    f.title && `曲名「${f.title}」${fake ? '（ファイル名から仮に入れたもの）' : ''}`,
    f.artist && `アーティスト「${f.artist}」`,
    f.genre && `ジャンル「${f.genre}」`,
    f.bpm && `BPM ${f.bpm}`,
  ].filter(Boolean);
  lines.push(`- 譜面に今入っている値: ${now.length ? now.join(' ') : 'なし'}`);
  if (c.youtube) lines.push(`- 設定済みの参照動画: ${c.youtube.url}${c.youtube.title ? `（「${c.youtube.title}」チャンネル: ${c.youtube.channel ?? '不明'}）` : ''}`);
  return lines.join('\n');
}

/** iTunes の結果が手がかりの曲とどれだけ合うか（0〜。3 以上なら同じ曲とみなしてよい） */
export function matchScore(h: StoreHit, c: SongClues): number {
  const titles = [c.tags?.title, titleIsFileName(c) ? '' : c.fields.title, c.fileName && cleanName(c.fileName), c.folderName && cleanName(c.folderName)]
    .filter((x): x is string => !!x && !isGenericName(x))
    .map(normKey)
    .filter((x) => x.length >= 2);
  const artists = [c.tags?.artist, c.tags?.albumArtist, c.fields.artist].filter((x): x is string => !!x).map(normKey).filter((x) => x.length >= 2);
  const ht = normKey(h.title);
  const ha = normKey(h.artist);
  let s = 0;
  if (ht && titles.some((t) => t === ht)) s += 2;
  else if (ht.length >= 3 && titles.some((t) => t.includes(ht) || ht.includes(t))) s += 1.5;
  if (ha && artists.some((a) => a === ha || a.includes(ha) || ha.includes(a))) s += 1.5;
  else if (ha.length >= 3 && titles.some((t) => t.includes(ha))) s += 1; // 「アーティスト - 曲名」のファイル名
  if (c.durationSec && h.durationSec) {
    const d = Math.abs(c.durationSec - h.durationSec);
    if (d <= 3) s += 1.5;
    else if (d <= 8) s += 0.7;
    // 原曲のほうがずっと長いなら別の版。短いのはゲーム用に縮めた版のことが多いので減らさない
    else if (c.durationSec > h.durationSec + 30) s -= 1;
  }
  return s;
}

// ---- 道具 ------------------------------------------------------------------------

export interface YtInfo {
  id: string;
  url: string;
  title: string;
  channel: string;
  channelUrl: string;
}

export interface CheckedImage {
  url: string;
  w: number;
  h: number;
}

/** エージェントが使う道具の中身（ブラウザでは fetch と <img> で動かす） */
export interface AgentTools {
  searchItunes(term: string, country: string, signal?: AbortSignal): Promise<StoreHit[]>;
  checkYoutube(url: string, signal?: AbortSignal): Promise<Omit<YtInfo, 'id' | 'url'> | null>;
  checkImage(url: string, signal?: AbortSignal): Promise<{ w: number; h: number } | null>;
}

const SUBMIT = 'submit_song_info';

export const AGENT_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_itunes',
      description:
        'Apple Music（iTunes）の配信情報を検索する。正式な曲名・アーティスト・アルバム・発売日・ジャンル・曲の長さ（秒）が分かる。ジャケット画像も持っていて、結果の id（it1 など）を答えの jacket に入れると使える。',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: '検索語（曲名とアーティスト名。余分な語は入れない）' },
          country: { type: 'string', enum: ['JP', 'US'], description: 'ストアの国。日本の曲は JP（日本語の正式表記が出る）' },
        },
        required: ['term'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_youtube',
      description: 'YouTube 動画の URL を確かめる。動画タイトルとチャンネル名・チャンネルの URL を返す。消えた動画や非公開の動画は ok:false。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_image',
      description: 'Web で見つけた画像の URL（.jpg・.png など画像そのもの）が実在するかと大きさを確かめる。結果の id（img1 など）を答えに入れると使える。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: SUBMIT,
      description: '調べ終わったら、これを1回呼んで答えを出す。確かめられなかった項目は空にする。',
      parameters: {
        type: 'object',
        properties: {
          ...SONG_INFO_SCHEMA.schema.properties,
          title_alt: { type: 'string', description: '別の表記（英語・ローマ字・原題など。無ければ空）' },
          jacket: { type: 'string', description: 'ジャケットに使う画像の id（search_itunes の it1 など、check_image の img1 など）。無ければ空' },
          youtube: {
            type: 'array',
            description: '公式の YouTube 動画（check_youtube で確かめたものだけ、よい順に3つまで）',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                kind: { type: 'string', enum: ['mv', 'audio', 'live', 'other'], description: 'mv=ミュージックビデオ, audio=公式の音源・Topic, live=公式のライブ映像' },
                official: { type: 'boolean', description: 'アーティスト本人・レーベル・事務所・Topic の公式チャンネルか' },
                why: { type: 'string', description: 'そう判断した理由（短く）' },
              },
              required: ['url', 'kind', 'official', 'why'],
            },
          },
          sources: {
            type: 'array',
            description: '確かめるのに使ったページ（検索結果に出た URL だけ）',
            items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] },
          },
        },
        required: [...SONG_INFO_SCHEMA.schema.required, 'title_alt', 'jacket', 'youtube', 'sources'],
      },
    },
  },
];

export function agentSystemPrompt(): string {
  return [
    'あなたは DTXMania（ドラムの音楽ゲーム）の譜面を作る人のために、曲の情報を調べる小さなエージェントです。',
    '手がかり（原曲のファイル名・タグ・曲の長さなど）から曲を特定し、道具で裏を取ってから submit_song_info で答えを出してください。',
    '',
    '進め方:',
    '1. 手がかりから曲名とアーティストの見当を付ける。ファイル名は「アーティスト - 曲名」「01 曲名」「曲名 (Official Video)」などの形がある。番号や Official・MV・叩いてみた などの飾りは外して考える。',
    '2. search_itunes で配信の情報を探す。長さが近い（数秒以内）ものは同じ曲の可能性が高い。ただし音楽ゲーム用に短く編集した版（ゲームサイズ）のことも多いので、長さが合わなくても名前が合えば同じ曲としてよい。日本の曲は country JP で日本語の正式表記を確かめる。',
    '3. Web検索で、正式な表記・リリース年・ジャンル・曲の背景（タイアップなど）と、公式の YouTube 動画を探す。公式とは、アーティスト本人・レーベル・事務所の公式チャンネル、または「アーティスト名 - Topic」のこと。MV を優先し、無ければ公式の音源やライブ映像。',
    '4. YouTube の URL は必ず check_youtube で確かめ、チャンネル名で公式かどうかを判断する。確かめていない URL は答えに入れない。歌ってみた・叩いてみた・カバー・切り抜き・ファンの再アップロードは公式ではない。',
    '5. 分かったら submit_song_info を呼んで終える。道具はぜんぶで7回くらいまでにする。',
    '',
    '決まり:',
    '- 推測で埋めない。確かめられない項目は空にして notes に書く。手がかりと違う曲（同名の別の曲など）を選ばない。',
    '- URL を作らない。ジャケットは search_itunes の id（it1 など）か check_image の id（img1 など）で選ぶ。',
    '- 曲名・アーティストは公式の表記（大文字小文字・記号・全角半角まで）。日本の曲で公式が日本語ならそれを title に、英語やローマ字の表記があれば title_alt に入れる。',
    '- comment は選曲画面に出す日本語の紹介文（60字以内。曲の特徴・タイアップ・聴きどころ）。panel は演奏中に流れる日本語の文（40字以内。例:「曲名 / アーティスト」やタイアップ名）。どちらにも URL は入れない。',
    '- 道具を呼ぶときは、その前に「分かったこと → 次にすること」を日本語で1行だけ書く。',
  ].join('\n');
}

export function agentUserPrompt(c: SongClues, seed?: { term: string; hits: [string, StoreHit][] }): string {
  const lines = ['この曲について調べてください。', '', '手がかり:', cluesText(c)];
  if (seed?.hits.length) {
    lines.push('', `先に iTunes で「${seed.term}」を検索した結果（id はそのまま答えに使えます。合わなければ別の語で検索し直してください）:`);
    for (const [id, h] of seed.hits) lines.push(`- ${id}: ${h.title} / ${h.artist} / アルバム「${h.album}」 / ${h.date} / ${h.genre}${h.durationSec ? ` / ${h.durationSec}秒` : ''}`);
  }
  return lines.join('\n');
}

// ---- 進み具合 ----------------------------------------------------------------------

export type StepKind = 'clue' | 'think' | 'web' | 'itunes' | 'youtube' | 'image' | 'answer' | 'warn';

export interface AgentStep {
  id: number;
  kind: StepKind;
  state: 'run' | 'ok' | 'fail' | 'info';
  text: string;
  detail?: string;
}

// ---- 答え ------------------------------------------------------------------------

export interface YtPick extends YtInfo {
  kind: 'mv' | 'audio' | 'live' | 'other';
  official: boolean;
  why: string;
}

export interface AgentAnswer extends SongInfoAnswer {
  titleAlt: string;
  /** 'it1'・'img1' など。確かめられなかったら空 */
  jacket: string;
  youtube: { url: string; kind: YtPick['kind']; official: boolean; why: string }[];
  sources: Citation[];
}

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim();

/** submit_song_info の引数をそろえる */
export function cleanAgentAnswer(raw: unknown): AgentAnswer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = cleanSongInfo(r);
  const yt = Array.isArray(r.youtube) ? r.youtube : [];
  const kinds = ['mv', 'audio', 'live', 'other'] as const;
  const youtube: AgentAnswer['youtube'] = [];
  for (const y of yt) {
    if (!y || typeof y !== 'object') continue;
    const o = y as Record<string, unknown>;
    const url = s(o.url);
    if (!youtubeId(url) || youtube.some((x) => youtubeId(x.url) === youtubeId(url))) continue;
    const kind = kinds.find((k) => k === o.kind) ?? 'other';
    youtube.push({ url, kind, official: o.official === true || o.official === 'true', why: s(o.why) });
  }
  const sources: Citation[] = [];
  for (const x of Array.isArray(r.sources) ? r.sources : []) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const url = s(o.url);
    if (/^https?:\/\//.test(url) && !sources.some((c) => c.url === url)) sources.push({ url, title: s(o.title) || url });
  }
  return { ...base, titleAlt: s(r.title_alt), jacket: s(r.jacket), youtube: youtube.slice(0, 3), sources };
}

// ---- 実行 ------------------------------------------------------------------------

export interface AgentCallResult extends ChatResult {
  costUsed: number;
}

export interface AgentRunOptions {
  clues: SongClues;
  tools: AgentTools;
  /** AI を1回呼ぶ（費用の記録は呼ぶ側で） */
  call: (messages: ChatMessage[], tools: FunctionTool[], web: WebSearchOptions | false) => Promise<AgentCallResult>;
  onStep: (s: AgentStep) => void;
  signal?: AbortSignal;
  /** AI を呼ぶ回数の上限 */
  maxTurns?: number;
  /** これを超えたら次で終わらせる（ドル） */
  budget?: number;
  /** 先に検索しておいた iTunes の結果（AI を呼ぶ回数を1回減らす） */
  seed?: { term: string; hits: StoreHit[] };
}

export interface AgentOutcome {
  answer: AgentAnswer;
  itunes: Map<string, StoreHit>;
  youtube: Map<string, YtInfo>;
  images: Map<string, CheckedImage>;
  citations: Citation[];
  cost: number;
  webSearches: number;
  turns: number;
  model: string;
  /** submit_song_info で答えずに終わった */
  incomplete: boolean;
}

const short = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export async function runSongAgent(o: AgentRunOptions): Promise<AgentOutcome> {
  const maxTurns = o.maxTurns ?? 6;
  const budget = o.budget ?? 0.25;
  const itunes = new Map<string, StoreHit>();
  const youtube = new Map<string, YtInfo>();
  const images = new Map<string, CheckedImage>();
  const citations: Citation[] = [];
  let cost = 0;
  let webSearches = 0;
  let model = '';
  let stepId = 0;
  const step = (x: Omit<AgentStep, 'id'>, id?: number) => {
    const st = { ...x, id: id ?? ++stepId };
    o.onStep(st);
    return st.id;
  };
  const seeded: [string, StoreHit][] = [];
  for (const h of o.seed?.hits.slice(0, 6) ?? []) {
    const key = `it${itunes.size + 1}`;
    itunes.set(key, h);
    seeded.push([key, h]);
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: agentSystemPrompt() },
    { role: 'user', content: agentUserPrompt(o.clues, o.seed ? { term: o.seed.term, hits: seeded } : undefined) },
  ];
  let answer: AgentAnswer | null = null;
  let nudged = false;
  let turns = 0;
  const abortIf = () => {
    if (o.signal?.aborted) throw new DOMException('止めました', 'AbortError');
  };

  for (let turn = 0; turn < maxTurns && !answer; turn++) {
    abortIf();
    const last = turn === maxTurns - 1 || cost > budget * 0.7;
    if (last && turn > 0) messages.push({ role: 'user', content: `道具はここまでです。分かったことで ${SUBMIT} を呼んで答えてください。` });
    const think = step({ kind: 'think', state: 'run', text: turn === 0 ? '手がかりから曲を探しています…' : '次の手を考えています…' });
    const web = last ? (false as const) : { maxResults: 5, maxUses: 3 };
    let r: AgentCallResult;
    try {
      r = await o.call(messages, AGENT_TOOLS, web);
    } catch (e) {
      // 推論の署名つきの発言を返すと、提供元に「書き換えた」と断られることがある。外して1回だけやり直す
      const signed = messages.some((m) => m.role === 'assistant' && m.reasoning_details);
      if (!(e instanceof AiError && e.status === 400 && signed)) throw e;
      for (const m of messages) if (m.role === 'assistant') delete m.reasoning_details;
      r = await o.call(messages, AGENT_TOOLS, web);
    }
    turns++;
    cost += r.costUsed;
    model = r.model || model;
    webSearches += r.webSearches;
    for (const c of r.citations) if (!citations.some((x) => x.url === c.url)) citations.push(c);
    const memo = (r.text ?? '').trim();
    step({ kind: 'think', state: 'ok', text: memo && r.toolCalls.length ? short(memo.split('\n').filter(Boolean).pop() ?? memo, 90) : r.toolCalls.length ? '調べることを決めました' : 'まとめています' }, think);
    if (r.webSearches > 0) {
      const titles = r.citations.slice(0, 3).map((c) => c.title);
      step({ kind: 'web', state: 'ok', text: `Web検索 ${r.webSearches}回`, detail: titles.length ? titles.join(' / ') : undefined });
    }
    if (!r.toolCalls.length) {
      // 文で答えてきたとき：JSON なら答えとして使う
      try {
        const data = parseJsonLoose<Record<string, unknown>>(r.text);
        if (data && (data.title || data.artist)) {
          answer = cleanAgentAnswer(data);
          break;
        }
      } catch {
        // 下で頼み直す
      }
      if (nudged) break;
      nudged = true;
      messages.push(r.message.content ? r.message : { role: 'assistant', content: r.text || '（空）' });
      messages.push({ role: 'user', content: `答えは ${SUBMIT} を呼んで出してください。` });
      continue;
    }
    // Web 検索をした回の推論は、検索結果と組みで署名されていて、そのまま返すと断られる。外して返す
    const { reasoning_details, ...plain } = r.message;
    messages.push(r.webSearches > 0 || !reasoning_details ? plain : r.message);
    const results = await Promise.all(r.toolCalls.map((tc) => runTool(tc)));
    for (const [i, tc] of r.toolCalls.entries()) {
      const out = results[i];
      if (out.answer) answer = out.answer;
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.content });
    }
  }

  async function runTool(tc: ToolCall): Promise<{ content: string; answer?: AgentAnswer }> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      return { content: JSON.stringify({ ok: false, error: '引数が JSON として読めませんでした' }) };
    }
    const name = tc.function.name;
    try {
      if (name === SUBMIT) {
        const a = cleanAgentAnswer(args);
        return { content: JSON.stringify({ ok: true }), answer: a };
      }
      if (name === 'search_itunes') {
        const term = s(args.term);
        const country = s(args.country) === 'US' ? 'US' : 'JP';
        const id = step({ kind: 'itunes', state: 'run', text: `iTunes で「${short(term, 40)}」を検索` });
        const hits = term ? await o.tools.searchItunes(term, country, o.signal) : [];
        const results = hits.slice(0, 6).map((h) => {
          let key = [...itunes.entries()].find(([, v]) => v.art.big === h.art.big && v.title === h.title)?.[0];
          if (!key) {
            key = `it${itunes.size + 1}`;
            itunes.set(key, h);
          }
          return { id: key, title: h.title, artist: h.artist, album: h.album, release_date: h.date, genre: h.genre, length_sec: h.durationSec || undefined };
        });
        const top = results[0];
        step({ kind: 'itunes', state: results.length ? 'ok' : 'fail', text: `iTunes で「${short(term, 40)}」を検索 — ${results.length}件`, detail: top ? `${top.title} / ${top.artist}（${top.release_date.slice(0, 4)}）` : undefined }, id);
        return { content: JSON.stringify({ ok: true, country, results }) };
      }
      if (name === 'check_youtube') {
        const url = s(args.url);
        const vid = youtubeId(url);
        const id = step({ kind: 'youtube', state: 'run', text: 'YouTube の動画を確認' });
        if (!vid) {
          step({ kind: 'youtube', state: 'fail', text: 'YouTube の URL ではありませんでした', detail: short(url) }, id);
          return { content: JSON.stringify({ ok: false, error: 'YouTube の動画の URL ではありません' }) };
        }
        const info = await o.tools.checkYoutube(`https://www.youtube.com/watch?v=${vid}`, o.signal);
        if (!info) {
          step({ kind: 'youtube', state: 'fail', text: 'YouTube の動画が見つかりませんでした', detail: vid }, id);
          return { content: JSON.stringify({ ok: false, error: '動画が見つかりません（削除・非公開・URL の誤り）' }) };
        }
        youtube.set(vid, { id: vid, url: `https://www.youtube.com/watch?v=${vid}`, ...info });
        step({ kind: 'youtube', state: 'ok', text: `YouTube「${short(info.title, 44)}」`, detail: `チャンネル: ${info.channel}` }, id);
        return { content: JSON.stringify({ ok: true, url: `https://www.youtube.com/watch?v=${vid}`, title: info.title, channel: info.channel, channel_url: info.channelUrl }) };
      }
      if (name === 'check_image') {
        const url = s(args.url);
        const id = step({ kind: 'image', state: 'run', text: '画像を確認' });
        const size = /^https?:\/\//.test(url) ? await o.tools.checkImage(url, o.signal) : null;
        if (!size) {
          step({ kind: 'image', state: 'fail', text: '画像を読み込めませんでした', detail: short(url) }, id);
          return { content: JSON.stringify({ ok: false, error: '画像として読み込めませんでした' }) };
        }
        let key = [...images.entries()].find(([, v]) => v.url === url)?.[0];
        if (!key) {
          key = `img${images.size + 1}`;
          images.set(key, { url, ...size });
        }
        step({ kind: 'image', state: 'ok', text: `画像 ${size.w}×${size.h}`, detail: short(url) }, id);
        return { content: JSON.stringify({ ok: true, id: key, width: size.w, height: size.h }) };
      }
      return { content: JSON.stringify({ ok: false, error: `${name} という道具はありません` }) };
    } catch (e) {
      if (o.signal?.aborted) throw e;
      return { content: JSON.stringify({ ok: false, error: (e as Error).message || '失敗しました' }) };
    }
  }

  abortIf();
  if (!answer && turns === 0) throw new AiError('AIに頼めませんでした');
  const incomplete = !answer;
  const a = answer ?? cleanAgentAnswer({ confidence: 'low', notes: '調べきれずに終わりました。見つかった候補だけ出しています。' });
  // 答えに入っていても、確かめていない YouTube は入れない（でっち上げを防ぐ）。確かめられたら入れる
  const yt: AgentAnswer['youtube'] = [];
  for (const y of a.youtube) {
    const vid = youtubeId(y.url)!;
    if (!youtube.has(vid)) {
      const info = await o.tools.checkYoutube(`https://www.youtube.com/watch?v=${vid}`, o.signal).catch(() => null);
      if (!info) continue;
      youtube.set(vid, { id: vid, url: `https://www.youtube.com/watch?v=${vid}`, ...info });
    }
    yt.push(y);
  }
  a.youtube = yt;
  if (a.jacket && !itunes.has(a.jacket) && !images.has(a.jacket)) {
    // id ではなく URL で答えたとき
    const byUrl = [...itunes.entries()].find(([, h]) => h.art.big === a.jacket || h.art.url === a.jacket)?.[0] ?? [...images.entries()].find(([, v]) => v.url === a.jacket)?.[0];
    a.jacket = byUrl ?? '';
  }
  step({ kind: 'answer', state: incomplete ? 'info' : 'ok', text: incomplete ? '調べきれませんでした（見つかった候補を出します）' : 'まとめました' });
  return { answer: a, itunes, youtube, images, citations, cost, webSearches, turns, model, incomplete };
}

/** AI を使わずに分かること（タグ・ファイル名・iTunes で長さの合う曲） */
export function bestStoreMatch(hits: StoreHit[], c: SongClues): { hit: StoreHit; score: number } | null {
  let best: { hit: StoreHit; score: number } | null = null;
  for (const h of hits) {
    const sc = matchScore(h, c);
    // 同じくらい合うなら古いほう（再発売やベスト盤より最初の発売）
    if (!best || sc > best.score + 0.01 || (Math.abs(sc - best.score) <= 0.01 && h.year && h.year < best.hit.year)) best = { hit: h, score: sc };
  }
  return best && best.score >= 3 ? best : null;
}
