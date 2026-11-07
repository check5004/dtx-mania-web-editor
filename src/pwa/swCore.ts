// Service Worker（src/pwa/sw.ts）の決めごと。ブラウザの API を使わない関数だけをここに置き、テストする。
//
// しくみ:
// - 版ごとのキャッシュ（dtxe-app-b-<ビルド時刻>）に、アプリの画面・JS・CSS・キットの音・アイコンを入れる（オフラインで開ける）。
//   前の版と中身が同じ物（assets/ のハッシュ付きの名前、rev が同じ物）はネットから取り直さずに写す
// - 画面（index.html）はネット優先（いつもの「再読み込みで最新」のまま）、つながらない・4 秒で返らないときは取っておいた物
// - 採譜・ステム分解の WASM のような大きい物は、使ったときに dtxe-app-runtime へ取っておく
// - Google Fonts は dtxe-app-fonts に取っておく。ほかのオリジン（AI・YouTube・Google のログイン・モデルの置き場など）は触らない
// - キャッシュの名前はすべて dtxe-app- で始める。採譜・ステム分解のモデル（dtxe-models-v1）などほかの物は消さない

/** 入れるときに取ってくるファイル */
export interface SwEntry {
  /** スコープ（/dtx-mania-web-editor/）からの相対パス */
  path: string;
  /** 中身の SHA-256（16 進の先頭 16 文字） */
  rev: string;
  bytes: number;
}

/** ビルドのときに sw.js へ埋め込む目録 */
export interface SwData {
  /** package.json の版 */
  version: string;
  /** ビルドした時刻（ミリ秒）。ページに埋め込む __DTXE_BUILD_TIME__ と同じ値で、新しい版かどうかはこれで比べる */
  build: number;
  precache: SwEntry[];
  /** 使ったときに取っておく大きいファイル（古い版の物を掃除するときに、まだ要る物か見分ける） */
  lazy: string[];
}

export const CACHE_PREFIX = 'dtxe-app-';
export const BUILD_CACHE_PREFIX = 'dtxe-app-b-';
export const RUNTIME_CACHE = 'dtxe-app-runtime';
export const FONT_CACHE = 'dtxe-app-fonts';
/** 版のキャッシュに、全部入れ終えた最後に置く目録（スコープからの相対パス。サーバーには無い名前） */
export const MANIFEST_PATH = '__dtxe-sw-manifest.json';
/** 残す版の数（いまの版を含む）。古い版のまま開いている画面が、あとから読む JS を失わないように */
export const KEEP_BUILDS = 3;
/** フォントのキャッシュに残す数 */
export const FONT_MAX = 400;
/** 画面をネットから取るのを待つ時間（これを過ぎたら取っておいた画面を出す） */
export const PAGE_TIMEOUT_MS = 4000;

export function buildCacheName(build: number): string {
  return BUILD_CACHE_PREFIX + build.toString(36);
}

/** 版のキャッシュの名前からビルド時刻を読む（読めなければ null） */
export function buildOfCacheName(name: string): number | null {
  if (!name.startsWith(BUILD_CACHE_PREFIX)) return null;
  const n = parseInt(name.slice(BUILD_CACHE_PREFIX.length), 36);
  return Number.isFinite(n) ? n : null;
}

/** 中身が変われば名前も変わるファイル（Vite は assets/ にハッシュ付きの名前で置く）。同じ名前なら同じ中身 */
export function isImmutablePath(path: string): boolean {
  return path.startsWith('assets/');
}

export type Route =
  /** アプリの画面（index.html）: ネット優先、だめなら取っておいた物 */
  | { kind: 'page' }
  /** 版のキャッシュに入れた物 */
  | { kind: 'precache'; path: string }
  /** 版のキャッシュに無いハッシュ付きの物（大きい WASM・別の版の JS）: 取っておいた物を優先、無ければネットから取って取っておく */
  | { kind: 'asset'; path: string }
  | { kind: 'font-css' }
  | { kind: 'font' };

export interface RouteRequest {
  url: string;
  method: string;
  mode: string;
  /** Range 付き（音声・動画の一部だけ）。Safari は 206 の返事を求めるので、手を出さない */
  hasRange: boolean;
}

/** どう返すか。null は Service Worker が手を出さない（ブラウザがそのままネットへ） */
export function routeOf(req: RouteRequest, scope: string, precache: ReadonlySet<string>): Route | null {
  if (req.method !== 'GET' || req.hasRange) return null;
  let url: URL;
  let base: URL;
  try {
    url = new URL(req.url);
    base = new URL(scope);
  } catch {
    return null;
  }
  if (url.origin === base.origin) {
    if (!url.pathname.startsWith(base.pathname)) return null;
    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice(base.pathname.length));
    } catch {
      return null;
    }
    if (req.mode === 'navigate') return path === '' || path === 'index.html' ? { kind: 'page' } : null;
    // 問い合わせ付き（?…）は、ここで作った物ではないので素通し
    if (url.search) return null;
    if (path === 'sw.js' || path === MANIFEST_PATH) return null;
    if (precache.has(path)) return { kind: 'precache', path };
    if (isImmutablePath(path)) return { kind: 'asset', path };
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === 'fonts.googleapis.com') return { kind: 'font-css' };
  if (url.hostname === 'fonts.gstatic.com') return { kind: 'font' };
  return null;
}

/** 前の版のキャッシュに同じ中身があれば、そこから写せる（ネットから取り直さない） */
export function canReuse(entry: SwEntry, old: SwEntry | undefined): boolean {
  if (!old || old.path !== entry.path) return false;
  return isImmutablePath(entry.path) || old.rev === entry.rev;
}

export interface CachedBuild {
  name: string;
  /** 目録のビルド時刻。目録が無い（入れている途中・失敗した）物は null */
  build: number | null;
}

/**
 * 消す版のキャッシュ。いまの版と、目録のある残りの新しい順に KEEP_BUILDS-1 個を残す。
 * 目録の無い物は入れ終わらなかった物なので消す。ただし、いまより新しい版の物は入れている最中かもしれないので残す
 */
export function buildsToDelete(caches: readonly CachedBuild[], current: string, currentBuild: number, keep = KEEP_BUILDS): string[] {
  const del: string[] = [];
  const done: { name: string; build: number }[] = [];
  for (const c of caches) {
    if (c.name === current || !c.name.startsWith(BUILD_CACHE_PREFIX)) continue;
    if (c.build === null) {
      const b = buildOfCacheName(c.name);
      if (b === null || b <= currentBuild) del.push(c.name);
      continue;
    }
    done.push({ name: c.name, build: c.build });
  }
  done.sort((a, b) => b.build - a.build);
  for (const c of done.slice(Math.max(0, keep - 1))) del.push(c.name);
  return del;
}

/** 実行時のキャッシュ（大きい WASM など）から消す物：残す版のどれにも出てこないファイル */
export function runtimeToDelete(paths: readonly string[], kept: readonly SwData[]): string[] {
  const want = new Set<string>();
  for (const d of kept) {
    for (const e of d.precache) want.add(e.path);
    for (const p of d.lazy) want.add(p);
  }
  return paths.filter((p) => !want.has(p));
}

/** ページの版とサービスワーカーの版を比べて、新しい版があるか */
export function isNewerBuild(swBuild: number | null | undefined, pageBuild: number): boolean {
  return typeof swBuild === 'number' && Number.isFinite(swBuild) && swBuild > pageBuild;
}

/** 目録として読めるか（壊れた・古い形の物は使わない） */
export function parseSwData(v: unknown): SwData | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Partial<SwData>;
  if (typeof d.version !== 'string' || typeof d.build !== 'number' || !Array.isArray(d.precache) || !Array.isArray(d.lazy)) return null;
  const ok = d.precache.every((e) => e && typeof e.path === 'string' && typeof e.rev === 'string' && typeof e.bytes === 'number');
  return ok ? (d as SwData) : null;
}

/** 入れる物の合計の大きさ（バイト） */
export function precacheBytes(d: SwData): number {
  return d.precache.reduce((a, e) => a + e.bytes, 0);
}
