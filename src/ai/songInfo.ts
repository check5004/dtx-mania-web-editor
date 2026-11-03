// 曲情報：YouTube の公開情報（oEmbed）、配信サービスの公開アートワーク（iTunes Search）、AI による正式表記・ジャンル・年・コメントの下書き。
// 画像は AI に作らせず、実在する URL だけを候補にする（AI は画像 URL をでっち上げやすい）。

/** URL や ID から YouTube の動画 ID を取り出す */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    // URL でなければ下で null
  }
  return null;
}

export interface OEmbed {
  title: string;
  author: string;
  /** チャンネルの URL（https://www.youtube.com/@… など） */
  authorUrl: string;
  thumbnail: string | null;
}

export async function youtubeOEmbed(url: string, signal?: AbortSignal): Promise<OEmbed | null> {
  const targets = [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, `https://noembed.com/embed?url=${encodeURIComponent(url)}`];
  for (const t of targets) {
    try {
      const r = await fetch(t, { signal });
      if (!r.ok) continue;
      const j = (await r.json()) as { title?: string; author_name?: string; author_url?: string; thumbnail_url?: string; error?: string };
      if (j.error || !j.title) continue;
      return { title: j.title, author: j.author_name ?? '', authorUrl: j.author_url ?? '', thumbnail: j.thumbnail_url ?? null };
    } catch (e) {
      if (signal?.aborted) throw e;
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
  source: 'youtube' | 'itunes' | 'file' | 'web';
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
  trackTimeMillis?: number;
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
  /** 発売日（YYYY-MM-DD） */
  date: string;
  genre: string;
  /** 曲の長さ（秒）。分からなければ 0 */
  durationSec: number;
  art: ArtCandidate;
}

/** iTunes のアートワークの URL を指定の大きさにする（配信元が大きいものを持っていればその大きさで返る） */
export const itunesArt = (url100: string, px: number) => url100.replace(/\/\d+x\d+bb\./, `/${px}x${px}bb.`);

export async function itunesSearch(term: string, opts: { country?: string; limit?: number; signal?: AbortSignal } = {}): Promise<StoreHit[]> {
  if (!term.trim()) return [];
  const country = opts.country ?? 'JP';
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=${opts.limit ?? 8}&country=${country}${country === 'JP' ? '&lang=ja_jp' : ''}`;
  let data: { results?: ItunesResult[] };
  try {
    const r = await fetch(url, { signal: opts.signal });
    // 混み合うと 403 を返すことがある。そのときは JSONP で読み直す
    if (!r.ok) throw new Error(`iTunes ${r.status}`);
    data = await r.json();
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    data = await jsonp<{ results?: ItunesResult[] }>(url);
  }
  const out: StoreHit[] = [];
  for (const x of data.results ?? []) {
    if (!x.artworkUrl100) continue;
    const big = itunesArt(x.artworkUrl100, 1200);
    if (out.some((o) => o.art.big === big && o.title === (x.trackName ?? ''))) continue;
    out.push({
      title: x.trackName ?? '',
      album: x.collectionName ?? '',
      artist: x.artistName ?? '',
      year: (x.releaseDate ?? '').slice(0, 4),
      date: (x.releaseDate ?? '').slice(0, 10),
      genre: x.primaryGenreName ?? '',
      durationSec: x.trackTimeMillis ? Math.round(x.trackTimeMillis / 1000) : 0,
      art: { url: itunesArt(x.artworkUrl100, 300), big, label: `${x.collectionName ?? x.trackName ?? ''}（iTunes）`, source: 'itunes', w: 1200, h: 1200 },
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
