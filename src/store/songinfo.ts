// 曲情報を調べる流れ：手がかり（原曲のタグ・ファイル名・長さ）を集め、AI のエージェント（キーがあれば）か、
// タグと iTunes だけ（キーが無くても）で、曲名・アーティストなどの案と、公式の YouTube・ジャケットの候補を出す。
import { tr, pl } from '../i18n';
import { create } from 'zustand';
import { AiError, chat } from '../ai/openrouter';
import { bestStoreMatch, fileStem, isGenericName, normKey, runSongAgent, searchTerms, titleIsFileName, type AgentStep, type AgentTools, type SongClues, type YtPick } from '../ai/songAgent';
import { itunesSearch, youtubeOEmbed, youtubeId, type ArtCandidate, type StoreHit } from '../ai/songInfo';
import type { Citation } from '../ai/openrouter';
import { engine } from '../audio/engine';
import { findFile } from '../fs/folder';
import { hasTagInfo, readAudioTags, type AudioTags } from '../fs/tags';
import { beginAi, checkMonthlyCap, hasAiKey, taskCostEstimate, useAi } from './ai';
import { useAssist } from './assist';
import { bgmSource, wavPath } from './derived';
import { useEditor } from './editor';
import { useSidecar } from './sidecar';

export type InfoField = 'TITLE' | 'ARTIST' | 'GENRE' | 'COMMENT' | 'PANEL';
export type SuggestSource = 'AI' | 'tag' | 'iTunes';

export interface Suggestion {
  value: string;
  src: SuggestSource;
}

export interface LookupResult {
  ai: boolean;
  fields: Partial<Record<InfoField, Suggestion>>;
  /** 曲名の別表記（英語・ローマ字など） */
  titleAlt: string;
  year: string;
  confidence: 'high' | 'medium' | 'low' | null;
  notes: string;
  youtube: YtPick[];
  /** ジャケットのおすすめ */
  jacket: ArtCandidate | null;
  /** 画像の候補（おすすめが先頭） */
  art: ArtCandidate[];
  sources: Citation[];
  cost: number;
  model: string;
  webSearches: number;
}

export interface SongInfoState {
  /** どの譜面・原曲の手がかりか */
  key: string;
  clues: SongClues | null;
  /** 原曲に埋め込まれたジャケット（blob URL） */
  picture: string | null;
  status: 'idle' | 'running' | 'done' | 'error';
  steps: AgentStep[];
  result: LookupResult | null;
  error: string | null;
}

const initial = (): SongInfoState => ({ key: '', clues: null, picture: null, status: 'idle', steps: [], result: null, error: null });
export const useSongInfo = create<SongInfoState>(initial);
const set = useSongInfo.setState;
const get = useSongInfo.getState;

let abort: AbortController | null = null;
let cluesSeq = 0;

function bgmFile() {
  const s = useEditor.getState();
  const bgm = bgmSource(s.doc);
  const path = bgm ? wavPath(s.doc, bgm.wav) : undefined;
  const f = path ? findFile(s.folder, path, s.doc.fields['PATH_WAV'] ?? '') : undefined;
  return { bgm, path, f };
}

function docKey(): string {
  const s = useEditor.getState();
  const { path, f } = bgmFile();
  return [s.folder?.name ?? '', s.meta.fileName, path ?? '', f?.size ?? 0, f?.ver ?? 0].join('|');
}

/** 曲情報の画面を開いたとき：譜面や原曲が変わっていれば、手がかりを集め直す */
export function ensureClues() {
  const k = docKey();
  if (get().key === k && get().clues) {
    // 譜面の値（曲名など）は今のものにする
    set({ clues: { ...get().clues!, fields: currentFields(), youtube: currentYoutube(get().clues!.youtube) } });
    return;
  }
  stopLookup();
  const old = get().picture;
  if (old) URL.revokeObjectURL(old);
  set({ ...initial(), key: k });
  void loadClues(k);
}

function currentFields(): SongClues['fields'] {
  const f = useEditor.getState().doc.fields;
  return { title: f['TITLE'] ?? '', artist: f['ARTIST'] ?? '', genre: f['GENRE'] ?? '', bpm: f['BPM'] ?? '' };
}

function currentYoutube(prev: SongClues['youtube']): SongClues['youtube'] {
  const y = useSidecar.getState().youtube;
  if (!y) return null;
  return prev && prev.url === y.url ? prev : { url: y.url };
}

async function loadClues(k: string) {
  const seq = ++cluesSeq;
  const s = useEditor.getState();
  const { bgm, path, f } = bgmFile();
  let tags: AudioTags | null = null;
  let dur = (bgm ? engine.duration(bgm.wav) : 0) || useAssist.getState().data?.duration || 0;
  if (f) {
    try {
      const file = await f.getFile();
      tags = await readAudioTags(file);
      if (!dur) dur = await audioDuration(file);
    } catch {
      tags = null;
    }
  }
  if (seq !== cluesSeq) return;
  // 変換ソフトが入れた「bgm」「Track01」のようなタグは手がかりにならない
  if (tags?.title && isGenericName(tags.title)) delete tags.title;
  if (tags?.artist && isGenericName(tags.artist)) delete tags.artist;
  if (tags?.album && isGenericName(tags.album)) delete tags.album;
  let picture: string | null = null;
  if (tags?.picture) picture = URL.createObjectURL(new Blob([tags.picture.data as BlobPart], { type: tags.picture.mime }));
  const { picture: _p, ...plain } = tags ?? { format: 'id3v2' as const };
  const fileName = path ? (path.split(/[\\/]/).pop() ?? path) : null;
  // ファイルを落として作った譜面のフォルダ名は、ファイル名か曲名の写しなので手がかりにしない
  const fn = s.folder?.name ?? '';
  // 既定のフォルダ名はどちらの言語でも i18n-ignore
  const copied = !fn || fn === '新しい曲' || fn === 'New song' || normKey(fn) === normKey(fileStem(fileName ?? '')) || normKey(fn) === normKey(s.doc.fields['TITLE'] ?? '');
  const clues: SongClues = {
    fileName,
    folderName: copied ? null : fn,
    tags: hasTagInfo(tags) ? plain : null,
    tagPicture: !!picture,
    durationSec: dur > 0 ? Math.round(dur * 10) / 10 : null,
    fields: currentFields(),
    youtube: currentYoutube(null),
  };
  set({ key: k, clues, picture });
}

/** 音声ファイルの長さ（秒）。ブラウザの audio 要素で頭だけ読む。分からなければ 0 */
function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined') return resolve(0);
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (v: number) => {
      window.clearTimeout(timer);
      a.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    };
    const timer = window.setTimeout(() => done(0), 5000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

export function stopLookup() {
  abort?.abort();
  abort = null;
}

const thumb = (id: string): ArtCandidate => ({ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, big: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, label: tr('YouTube のサムネイル', 'YouTube thumbnail'), source: 'youtube', w: 1280, h: 720 });

/** ブラウザで使う道具 */
const browserTools: AgentTools = {
  searchItunes: (term, country, signal) => itunesSearch(term, { country, signal }),
  checkYoutube: async (url, signal) => {
    const o = await youtubeOEmbed(url, signal);
    return o ? { title: o.title, channel: o.author, channelUrl: o.authorUrl } : null;
  },
  checkImage: (url, signal) =>
    new Promise((resolve) => {
      const im = new Image();
      const timer = window.setTimeout(() => done(null), 10000);
      const done = (v: { w: number; h: number } | null) => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        im.onload = im.onerror = null;
        resolve(v);
      };
      const onAbort = () => done(null);
      signal?.addEventListener('abort', onAbort);
      im.onload = () => done(im.naturalWidth > 1 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
      im.onerror = () => done(null);
      im.referrerPolicy = 'no-referrer';
      im.src = url;
    }),
};

/**
 * 曲情報を調べる。useAi が true で AI のキーがあれば、Web 検索するエージェントに頼む。
 * そうでなければ、タグと iTunes（無料）だけで案を出す。
 * quiet：AI の費用を確かめない（おまかせで準備。準備の画面で AI を使うと選んである）
 */
export async function lookupSong(useAiAgent: boolean, opts: { quiet?: boolean } = {}): Promise<void> {
  if (get().status === 'running') return;
  ensureClues();
  // 手がかりの読み込みを待つ
  for (let i = 0; i < 100 && !get().clues; i++) await new Promise((r) => setTimeout(r, 50));
  const clues = get().clues;
  if (!clues) return;
  const ac = (abort = new AbortController());
  let stepNo = 1000;
  const steps: AgentStep[] = [];
  const onStep = (st: AgentStep) => {
    const i = steps.findIndex((x) => x.id === st.id);
    if (i >= 0) steps[i] = st;
    else steps.push(st);
    if (abort === ac) set({ steps: [...steps] });
  };
  const local = (x: Omit<AgentStep, 'id'>, id?: number) => {
    const st = { ...x, id: id ?? ++stepNo };
    onStep(st);
    return st.id;
  };
  set({ status: 'running', steps: [], error: null });
  const t = clues.tags;
  local({
    kind: 'clue',
    state: 'ok',
    text: t
      ? tr(`タグ: ${[t.title, t.artist, t.album, t.year].filter(Boolean).join(' / ')}`, `Tags: ${[t.title, t.artist, t.album, t.year].filter(Boolean).join(' / ')}`)
      : clues.fileName
        ? tr(`ファイル名: ${clues.fileName}（タグなし）`, `File name: ${clues.fileName} (no tags)`)
        : tr('原曲のファイルなし。譜面の曲名から調べます', "No original audio file. Looking up the chart's title"),
    detail: clues.durationSec
      ? tr(`曲の長さ ${Math.floor(clues.durationSec / 60)}:${String(Math.round(clues.durationSec % 60)).padStart(2, '0')}`, `Length ${Math.floor(clues.durationSec / 60)}:${String(Math.round(clues.durationSec % 60)).padStart(2, '0')}`)
      : undefined,
  });
  const withAi = useAiAgent && hasAiKey(useAi.getState());
  try {
    // まず iTunes（無料）。見つかった曲はエージェントにも渡す
    const terms = searchTerms(clues);
    let hits: StoreHit[] = [];
    let term = '';
    for (const tm of terms.slice(0, 2)) {
      const id = local({ kind: 'itunes', state: 'run', text: tr(`iTunes で「${tm}」を検索`, `Searching iTunes for "${tm}"`) });
      try {
        hits = await itunesSearch(tm, { signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) throw e;
        hits = [];
      }
      term = tm;
      const best = bestStoreMatch(hits, clues);
      local(
        {
          kind: 'itunes',
          state: hits.length ? 'ok' : 'fail',
          text: tr(`iTunes で「${tm}」を検索 — ${hits.length}件`, `Searched iTunes for "${tm}" — ${hits.length} ${pl(hits.length, 'result')}`),
          detail: best
            ? tr(`合う曲: ${best.hit.title} / ${best.hit.artist}（${best.hit.year}）`, `Match: ${best.hit.title} / ${best.hit.artist} (${best.hit.year})`)
            : hits.length
              ? tr('長さや名前の合う曲はありません', 'No song matches the length or name')
              : undefined,
        },
        id,
      );
      if (best) break;
    }
    if (!terms.length) local({ kind: 'warn', state: 'info', text: tr('曲名もファイル名も無いので、iTunes では探せません', "There's no title or file name, so iTunes can't be searched") });
    const best = bestStoreMatch(hits, clues);

    if (!withAi) {
      if (useAiAgent) local({ kind: 'warn', state: 'info', text: tr('AI のキーを設定すると、Web検索で公式の YouTube や曲の情報も探します', 'Set an AI key to also search the web for the official YouTube video and song info') });
      set({ status: 'done', result: localResult(clues, best?.hit ?? null, hits), steps: [...steps] });
      return;
    }

    const est = taskCostEstimate('songinfo') ?? 0.05;
    const session = await beginAi('songinfo', est, opts.quiet);
    if (!session) {
      set({ status: 'idle', steps: [] });
      return;
    }
    try {
      const out = await runSongAgent({
        clues,
        tools: browserTools,
        seed: hits.length ? { term, hits } : undefined,
        signal: ac.signal,
        budget: Math.max(0.1, est * 4),
        onStep,
        call: async (messages, tools, web) => {
          checkMonthlyCap(0.01);
          const r = await chat({
            key: session.key,
            model: session.cfg.model,
            fallback: session.cfg.fallback,
            messages,
            tools,
            web: web || undefined,
            effort: session.cfg.effort,
            reasoning: session.info ? session.info.reasoning : undefined,
            maxTokens: 4000,
            signal: ac.signal,
          });
          return { ...r, costUsed: session.charge(r) };
        },
      });
      set({ status: 'done', result: aiResult(clues, out, best?.hit ?? null), steps: [...steps] });
    } finally {
      session.end();
    }
  } catch (e) {
    if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      local({ kind: 'warn', state: 'info', text: tr('止めました', 'Stopped') });
      set({ status: get().result ? 'done' : 'idle', steps: [...steps] });
      return;
    }
    set({ status: 'error', error: e instanceof AiError ? e.message : tr(`失敗しました: ${(e as Error).message}`, `Failed: ${(e as Error).message}`), steps: [...steps] });
  } finally {
    if (abort === ac) abort = null;
  }
}

function pushArt(list: ArtCandidate[], c: ArtCandidate | null | undefined) {
  if (c && !list.some((x) => x.big === c.big)) list.push(c);
}

function embedded(): ArtCandidate | null {
  const p = get().picture;
  return p ? { url: p, big: p, label: tr('原曲のファイルに入っていたジャケット', "Cover art embedded in the original's file"), source: 'file' } : null;
}

/** タグと iTunes だけの案 */
function localResult(c: SongClues, hit: StoreHit | null, hits: StoreHit[]): LookupResult {
  const fields: LookupResult['fields'] = {};
  const put = (k: InfoField, v: string | undefined, src: SuggestSource) => {
    if (v && v.trim() && !fields[k]) fields[k] = { value: v.trim(), src };
  };
  // iTunes の正式表記を先に（タグは省略や誤字があることがある）。合う曲が無ければタグ
  put('TITLE', hit?.title.replace(/\s*[(（](?:feat|ft)\.?[^)）]*[)）]\s*$/i, ''), 'iTunes');
  put('ARTIST', hit?.artist, 'iTunes');
  put('TITLE', c.tags?.title, 'tag');
  put('ARTIST', c.tags?.artist ?? c.tags?.albumArtist, 'tag');
  put('GENRE', c.tags?.genre, 'tag');
  put('GENRE', hit?.genre, 'iTunes');
  const art: ArtCandidate[] = [];
  const jacket = embedded() ?? hit?.art ?? null;
  pushArt(art, jacket);
  pushArt(art, hit?.art);
  for (const h of hits.slice(0, 4)) pushArt(art, h.art);
  const yt = c.youtube ? youtubeId(c.youtube.url) : null;
  if (yt) pushArt(art, thumb(yt));
  return {
    ai: false,
    fields,
    titleAlt: '',
    year: c.tags?.year || hit?.year || '',
    confidence: null,
    notes: hit
      ? ''
      : titleIsFileName(c) && !c.tags
        ? tr(
            'タグが無く、ファイル名からは曲を特定できませんでした。曲名とアーティストを入れるか、AI のキーを設定すると Web 検索で探します。',
            "There are no tags, and the song couldn't be identified from the file name. Enter the title and artist, or set an AI key to search the web.",
          )
        : '',
    youtube: [],
    jacket,
    art,
    sources: [],
    cost: 0,
    model: '',
    webSearches: 0,
  };
}

function aiResult(c: SongClues, out: Awaited<ReturnType<typeof runSongAgent>>, hit: StoreHit | null): LookupResult {
  const a = out.answer;
  const base = localResult(c, hit, [...out.itunes.values()]);
  const fields: LookupResult['fields'] = {};
  const put = (k: InfoField, v: string) => {
    if (v.trim()) fields[k] = { value: v.trim(), src: 'AI' };
  };
  put('TITLE', a.title);
  put('ARTIST', a.artist);
  put('GENRE', a.genre);
  put('COMMENT', a.comment);
  put('PANEL', a.panel);
  // AI が空にした項目は、タグか iTunes の案を出す
  for (const k of ['TITLE', 'ARTIST', 'GENRE'] as const) if (!fields[k] && base.fields[k]) fields[k] = base.fields[k];
  const youtube: YtPick[] = [];
  for (const y of a.youtube) {
    const info = out.youtube.get(youtubeId(y.url)!);
    if (info) youtube.push({ ...info, kind: y.kind, official: y.official, why: y.why });
  }
  let jacket: ArtCandidate | null = null;
  if (a.jacket && out.itunes.has(a.jacket)) jacket = out.itunes.get(a.jacket)!.art;
  else if (a.jacket && out.images.has(a.jacket)) {
    const im = out.images.get(a.jacket)!;
    jacket = { url: im.url, big: im.url, label: tr('Web で見つけた画像', 'Image found on the web'), source: 'web', w: im.w, h: im.h };
  }
  jacket ??= base.jacket;
  const art: ArtCandidate[] = [];
  pushArt(art, jacket);
  pushArt(art, embedded());
  for (const y of youtube) pushArt(art, thumb(y.id));
  for (const im of out.images.values()) pushArt(art, { url: im.url, big: im.url, label: tr('Web で見つけた画像', 'Image found on the web'), source: 'web', w: im.w, h: im.h });
  for (const x of base.art) pushArt(art, x);
  const sources = [...out.citations];
  for (const x of a.sources) if (!sources.some((y) => y.url === x.url)) sources.push(x);
  for (const y of youtube) if (!sources.some((x) => youtubeId(x.url) === y.id)) sources.push({ url: y.url, title: tr(`${y.title}（YouTube）`, `${y.title} (YouTube)`) });
  return {
    ai: true,
    fields,
    titleAlt: a.titleAlt && a.titleAlt !== a.title ? a.titleAlt : '',
    year: a.year || base.year,
    confidence: a.confidence,
    notes: a.notes,
    youtube,
    jacket,
    art: art.slice(0, 12),
    sources: sources.filter((x) => /^https?:\/\/[^/]+\/./.test(x.url)).slice(0, 8),
    cost: out.cost,
    model: out.model,
    webSearches: out.webSearches,
  };
}
