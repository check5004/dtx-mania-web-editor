// 曲情報：YouTube の公開情報（oEmbed）、配信サービスの公開アートワーク（iTunes Search）、AI による正式表記・ジャンル・年・コメントの下書き。
// 画像は AI に作らせず、実在する URL だけを候補にする（AI は画像 URL をでっち上げやすい）。

export interface OEmbed {
  title: string;
  author: string;
  thumbnail: string | null;
}

export async function youtubeOEmbed(url: string): Promise<OEmbed | null> {
  const targets = [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, `https://noembed.com/embed?url=${encodeURIComponent(url)}`];
  for (const t of targets) {
    try {
      const r = await fetch(t);
      if (!r.ok) continue;
      const j = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string; error?: string };
      if (j.error || !j.title) continue;
      return { title: j.title, author: j.author_name ?? '', thumbnail: j.thumbnail_url ?? null };
    } catch {
      // 次を試す
    }
  }
  return null;
}

export interface ArtCandidate {
  url: string;
  /** 大きい画像（あれば） */
  big: string;
  label: string;
  source: 'youtube' | 'itunes' | 'file';
  w?: number;
  h?: number;
}

export function youtubeThumbs(id: string): ArtCandidate[] {
  return [
    { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, big: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, label: 'YouTube（最大）', source: 'youtube' },
    { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, big: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, label: 'YouTube（標準）', source: 'youtube' },
  ];
}

interface ItunesResult {
  trackName?: string;
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
  releaseDate?: string;
  primaryGenreName?: string;
}

/** iTunes Search API（JSONP。CORS が無くても読める） */
function jsonp<T>(url: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = `__dtxe_jsonp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const s = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const done = () => {
      delete w[cb];
      s.remove();
      window.clearTimeout(timer);
    };
    const timer = window.setTimeout(() => {
      done();
      reject(new Error('時間切れ'));
    }, timeoutMs);
    w[cb] = (data: T) => {
      done();
      resolve(data);
    };
    s.src = `${url}${url.includes('?') ? '&' : '?'}callback=${cb}`;
    s.onerror = () => {
      done();
      reject(new Error('読み込めませんでした'));
    };
    document.head.appendChild(s);
  });
}

export interface StoreHit {
  title: string;
  album: string;
  artist: string;
  year: string;
  genre: string;
  art: ArtCandidate;
}

export async function itunesSearch(term: string): Promise<StoreHit[]> {
  if (!term.trim()) return [];
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=8&country=JP&lang=ja_jp`;
  let data: { results?: ItunesResult[] };
  try {
    const r = await fetch(url);
    data = await r.json();
  } catch {
    data = await jsonp<{ results?: ItunesResult[] }>(url);
  }
  const out: StoreHit[] = [];
  for (const x of data.results ?? []) {
    if (!x.artworkUrl100) continue;
    const big = x.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.');
    if (out.some((o) => o.art.big === big)) continue;
    out.push({
      title: x.trackName ?? '',
      album: x.collectionName ?? '',
      artist: x.artistName ?? '',
      year: (x.releaseDate ?? '').slice(0, 4),
      genre: x.primaryGenreName ?? '',
      art: { url: x.artworkUrl100, big, label: `${x.collectionName ?? x.trackName ?? ''}（iTunes）`, source: 'itunes', w: 600, h: 600 },
    });
  }
  return out;
}

export interface SongInfoAnswer {
  title: string;
  artist: string;
  genre: string;
  year: string;
  comment: string;
  panel: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export const SONG_INFO_SCHEMA = {
  name: 'song_info',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '曲の正式な表記（公式の表記。分からなければ入力のまま）' },
      artist: { type: 'string', description: 'アーティストの正式な表記' },
      genre: { type: 'string', description: 'ジャンル（短く。例: J-ROCK, アニメ, ボカロ, メタル, ポップス, フュージョン）' },
      year: { type: 'string', description: 'リリース年（4桁。分からなければ空）' },
      comment: { type: 'string', description: '選曲画面のコメント（日本語で60字以内。曲の特徴や聴きどころ）' },
      panel: { type: 'string', description: '演奏中に流れるパネル文（日本語で40字以内。曲名・アーティスト・出典など）' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string', description: '確かめたこと・分からなかったこと（日本語で短く）' },
    },
    required: ['title', 'artist', 'genre', 'year', 'comment', 'panel', 'confidence', 'notes'],
    additionalProperties: false,
  },
};

export function songInfoPrompt(input: { title: string; artist: string; youtubeTitle?: string; youtubeAuthor?: string; bpm?: number; genre?: string }): { system: string; user: string } {
  const system = [
    'あなたはドラム譜面（DTXMania 用）の曲情報を整える手伝いをします。',
    'Web検索で裏を取り、公式の表記（大文字小文字・記号・全角半角）に合わせてください。',
    '確かめられないことは推測で埋めず、空にするか入力のままにして notes に書いてください。',
    '画像や URL は作らないでください。',
    '答えは指定の JSON だけで返してください。',
  ].join('\n');
  const lines = [
    `曲名（入力）: ${input.title || '（未入力）'}`,
    `アーティスト（入力）: ${input.artist || '（未入力）'}`,
  ];
  if (input.youtubeTitle) lines.push(`YouTube の動画タイトル: ${input.youtubeTitle}${input.youtubeAuthor ? `（チャンネル: ${input.youtubeAuthor}）` : ''}`);
  if (input.genre) lines.push(`今のジャンル: ${input.genre}`);
  if (input.bpm) lines.push(`BPM: ${input.bpm}`);
  lines.push('', '正式な曲名・アーティスト・ジャンル・リリース年を調べ、選曲画面のコメントと演奏中のパネル文を日本語で下書きしてください。');
  // Web 検索を使うと response_format が効かないモデルがあるので、キー名を文でも伝える
  lines.push(
    '',
    '答えは次のキーを持つ JSON 1つだけ（キー名は英語のまま）:',
    'title（正式な曲名）, artist（正式なアーティスト表記）, genre（短いジャンル）, year（リリース年を4桁、分からなければ空）, comment（選曲画面のコメント、60字以内）, panel（演奏中のパネル文、40字以内）, confidence（high / medium / low）, notes（確かめたこと・分からなかったこと）',
    'comment・panel・notes に URL やリンクの記法は入れないでください。',
  );
  return { system, user: lines.join('\n') };
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim();
/** [文字](URL) は文字だけにし、むき出しの URL は消す */
const noLinks = (t: string) =>
  t
    .replace(/\[([^\]]*)\]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/[（(]?\s*https?:\/\/[^\s)）]+\s*[)）]?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/** AI の答えを画面と DTX に入れられる形にそろえる（型の違い・年の書き方・リンクの混入） */
export function cleanSongInfo(raw: Partial<Record<keyof SongInfoAnswer, unknown>> | null | undefined): SongInfoAnswer {
  const r = raw ?? {};
  const conf = r.confidence === 'high' || r.confidence === 'medium' ? r.confidence : 'low';
  return {
    title: str(r.title),
    artist: str(r.artist),
    genre: str(r.genre),
    year: /(?:19|20)\d{2}/.exec(str(r.year))?.[0] ?? '',
    comment: noLinks(str(r.comment)),
    panel: noLinks(str(r.panel)),
    confidence: conf,
    notes: noLinks(str(r.notes)),
  };
}
