// Service Worker 本体。ビルドのとき（src/pwa/vite-plugin.ts）に1つの sw.js にまとめ、__DTXE_SW_DATA__ に目録を埋め込む。
// 決めごとは swCore.ts。アプリの画面からは import しない（ここはページではなく Service Worker で動く）。
//
// - install: 版のキャッシュに目録のファイルを入れる（前の版と同じ中身は写す）。入れ終えたらすぐ有効にする（skipWaiting）。
//   画面はネット優先なので、新しい版をすぐ有効にしても、開いている古い画面には古い版のキャッシュ（KEEP_BUILDS まで残す）から返せる
// - activate: 開いている画面を受け持ち、古い版を消し、画面に「新しい版になった」と知らせる
// - fetch: routeOf の決めたとおりに返す
import {
  BUILD_CACHE_PREFIX,
  buildCacheName,
  buildsToDelete,
  canReuse,
  FONT_CACHE,
  FONT_MAX,
  KEEP_BUILDS,
  MANIFEST_PATH,
  PAGE_TIMEOUT_MS,
  parseSwData,
  precacheBytes,
  routeOf,
  RUNTIME_CACHE,
  runtimeToDelete,
  type CachedBuild,
  type Route,
  type SwData,
  type SwEntry,
} from './swCore';

// ---- Service Worker の型（tsconfig は DOM 向けなので、使う所だけ書く） ---------------------------------

interface SwExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwClient {
  readonly id: string;
  readonly url: string;
  postMessage(message: unknown): void;
}
interface SwMessageEvent extends SwExtendableEvent {
  readonly data: unknown;
  readonly source: SwClient | null;
  readonly ports: readonly MessagePort[];
}
interface SwGlobal {
  readonly registration: { readonly scope: string };
  readonly clients: { claim(): Promise<void>; matchAll(o?: { type?: string; includeUncontrolled?: boolean }): Promise<SwClient[]> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: SwExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: SwFetchEvent) => void): void;
  addEventListener(type: 'message', fn: (e: SwMessageEvent) => void): void;
}

declare const __DTXE_SW_DATA__: SwData;

const sw = self as unknown as SwGlobal;
const DATA: SwData = __DTXE_SW_DATA__;
const SCOPE = sw.registration.scope;
const CACHE = buildCacheName(DATA.build);
const PRECACHE = new Set(DATA.precache.map((e) => e.path));
const MATCH: CacheQueryOptions = { ignoreVary: true };

const urlOf = (path: string) => new URL(path, SCOPE).href;

// ---- 入れる ---------------------------------------------------------------------------------------

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 目録を読む（無ければ null） */
async function readManifest(cacheName: string): Promise<SwData | null> {
  try {
    const res = await (await caches.open(cacheName)).match(urlOf(MANIFEST_PATH), MATCH);
    return res ? parseSwData(await res.json()) : null;
  } catch {
    return null;
  }
}

/** 前の版のキャッシュ（と、使ったときに取っておいた物）から同じ中身を探す */
async function findReusable(entry: SwEntry, olds: readonly { name: string; data: SwData }[]): Promise<Response | undefined> {
  for (const o of olds) {
    const prev = o.data.precache.find((e) => e.path === entry.path);
    if (!canReuse(entry, prev)) continue;
    const hit = await (await caches.open(o.name)).match(urlOf(entry.path), MATCH);
    if (hit) return hit;
  }
  if (entry.path.startsWith('assets/')) return (await (await caches.open(RUNTIME_CACHE)).match(urlOf(entry.path), MATCH)) ?? undefined;
  return undefined;
}

/**
 * ネットから取る。assets/ 以外は中身が目録と同じか確かめる（Pages の配信が古い物を返したら、入れるのをやめて次の確認でやり直す）。
 * assets/ は名前が中身なので、ブラウザの HTTP キャッシュにあればそれでよい
 */
async function fetchEntry(entry: SwEntry): Promise<Response> {
  const immutable = entry.path.startsWith('assets/');
  for (const mode of immutable ? (['default'] as const) : (['no-cache', 'reload'] as const)) {
    const res = await fetch(urlOf(entry.path), { cache: mode, credentials: 'same-origin' });
    if (!res.ok || res.status !== 200 || res.redirected) throw new Error(`${entry.path}: HTTP ${res.status}`);
    if (immutable) return res;
    const buf = await res.arrayBuffer();
    if ((await sha256Hex(buf)).startsWith(entry.rev)) return new Response(buf, { status: 200, statusText: res.statusText, headers: res.headers });
  }
  throw new Error(`${entry.path}: 中身が目録と違います`); // i18n-ignore（開発者向けのログ）
}

async function pool<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

async function install(): Promise<void> {
  const cache = await caches.open(CACHE);
  // 前の版（新しい順）
  const olds: { name: string; data: SwData }[] = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith(BUILD_CACHE_PREFIX) || name === CACHE) continue;
    const data = await readManifest(name);
    if (data) olds.push({ name, data });
  }
  olds.sort((a, b) => b.data.build - a.data.build);
  await pool(DATA.precache, 6, async (entry) => {
    const url = urlOf(entry.path);
    if (await cache.match(url, MATCH)) return;
    const res = (await findReusable(entry, olds)) ?? (await fetchEntry(entry));
    await cache.put(url, res);
  });
  // 全部入れ終えたしるし
  await cache.put(urlOf(MANIFEST_PATH), new Response(JSON.stringify(DATA), { headers: { 'content-type': 'application/json' } }));
}

sw.addEventListener('install', (e) => {
  e.waitUntil(install().then(() => sw.skipWaiting()));
});

// ---- 有効にする -----------------------------------------------------------------------------------

async function cleanUp(): Promise<void> {
  const names = (await caches.keys()).filter((n) => n.startsWith(BUILD_CACHE_PREFIX));
  const builds: (CachedBuild & { data: SwData | null })[] = [];
  for (const name of names) {
    const data = name === CACHE ? DATA : await readManifest(name);
    builds.push({ name, build: data?.build ?? null, data });
  }
  const del = new Set(buildsToDelete(builds, CACHE, DATA.build, KEEP_BUILDS));
  await Promise.all([...del].map((n) => caches.delete(n)));
  // 実行時のキャッシュ：残す版のどれにも出てこない物（古い版の WASM など）を消す
  const kept = builds.filter((b) => !del.has(b.name) && b.data).map((b) => b.data as SwData);
  const rt = await caches.open(RUNTIME_CACHE);
  const reqs = await rt.keys();
  const paths = reqs.map((r) => (r.url.startsWith(SCOPE) ? r.url.slice(SCOPE.length) : r.url));
  const drop = new Set(runtimeToDelete(paths, kept));
  await Promise.all(reqs.filter((_, i) => drop.has(paths[i])).map((r) => rt.delete(r)));
}

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      await sw.clients.claim();
      try {
        await cleanUp();
      } catch {
        // 掃除に失敗しても動きは変わらない（次の版で消す）
      }
      for (const c of await sw.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'dtxe-sw-activated', ...buildInfo() });
    })(),
  );
});

// ---- 返す -----------------------------------------------------------------------------------------

/** 取っておいた画面（いまの版、無ければ残っている版のどれか） */
async function cachedPage(): Promise<Response | undefined> {
  const own = await (await caches.open(CACHE)).match(urlOf('index.html'), MATCH);
  if (own) return own;
  for (const name of (await caches.keys()).filter((n) => n.startsWith(BUILD_CACHE_PREFIX)).reverse()) {
    const hit = await (await caches.open(name)).match(urlOf('index.html'), MATCH);
    if (hit) return hit;
  }
  return undefined;
}

/** 画面: ネット優先（HTTP キャッシュは確かめ直す）。つながらない・遅い・エラーなら取っておいた画面 */
async function page(): Promise<Response> {
  const net = fetch(urlOf('index.html'), { cache: 'no-cache', credentials: 'same-origin' });
  net.catch(() => undefined);
  const cached = await cachedPage();
  if (!cached) return net;
  let timer = 0;
  const timeout = new Promise<null>((resolve) => {
    timer = self.setTimeout(() => resolve(null), PAGE_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([net, timeout]);
    if (res && res.ok && !res.redirected) return res;
    return cached;
  } catch {
    return cached;
  } finally {
    self.clearTimeout(timer);
  }
}

/** ハッシュ付きの物: 取っておいた物（どの版でも）→ ネット（取っておく） */
async function asset(e: SwFetchEvent): Promise<Response> {
  const hit = await caches.match(e.request.url, MATCH);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    e.waitUntil(
      caches
        .open(RUNTIME_CACHE)
        .then((c) => c.put(e.request.url, copy))
        .catch(() => undefined),
    );
  }
  return res;
}

async function precached(e: SwFetchEvent, path: string): Promise<Response> {
  const hit = (await (await caches.open(CACHE)).match(urlOf(path), MATCH)) ?? (await caches.match(urlOf(path), MATCH));
  return hit ?? fetch(e.request);
}

async function trimFonts(): Promise<void> {
  const c = await caches.open(FONT_CACHE);
  const keys = await c.keys();
  if (keys.length > FONT_MAX) await Promise.all(keys.slice(0, keys.length - FONT_MAX).map((k) => c.delete(k)));
}

/** フォントの CSS: 取っておいた物をすぐ返し、裏で新しくする */
async function fontCss(e: SwFetchEvent): Promise<Response> {
  const c = await caches.open(FONT_CACHE);
  const hit = await c.match(e.request, MATCH);
  const net = fetch(e.request)
    .then((res) => {
      if (res.ok) e.waitUntil(c.put(e.request, res.clone()).catch(() => undefined));
      return res;
    })
    .catch(() => undefined);
  if (hit) {
    e.waitUntil(net);
    return hit;
  }
  return (await net) ?? Response.error();
}

/** フォントのファイル: 取っておいた物 → ネット（取っておく） */
async function font(e: SwFetchEvent): Promise<Response> {
  const c = await caches.open(FONT_CACHE);
  const hit = await c.match(e.request, MATCH);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok) {
    const copy = res.clone();
    e.waitUntil(
      c
        .put(e.request, copy)
        .then(trimFonts)
        .catch(() => undefined),
    );
  }
  return res;
}

function respond(e: SwFetchEvent, route: Route): Promise<Response> {
  switch (route.kind) {
    case 'page':
      return page();
    case 'precache':
      return precached(e, route.path);
    case 'asset':
      return asset(e);
    case 'font-css':
      return fontCss(e);
    case 'font':
      return font(e);
  }
}

sw.addEventListener('fetch', (e) => {
  const r = e.request;
  const route = routeOf({ url: r.url, method: r.method, mode: r.mode, hasRange: r.headers.has('range') }, SCOPE, PRECACHE);
  if (!route) return;
  // ここで失敗したら（キャッシュが壊れた等）、ふつうにネットから取る
  e.respondWith(respond(e, route).catch(() => fetch(r)));
});

// ---- 画面とのやりとり -------------------------------------------------------------------------------

function buildInfo() {
  return { version: DATA.version, build: DATA.build, bytes: precacheBytes(DATA) };
}

sw.addEventListener('message', (e) => {
  const d = e.data as { type?: string } | null;
  if (d?.type !== 'dtxe-sw-build') return;
  const reply = { type: 'dtxe-sw-build', ...buildInfo() };
  // 画面は MessageChannel で聞く（返事を待てるように）。無ければ送ってきた画面へ
  if (e.ports[0]) e.ports[0].postMessage(reply);
  else e.source?.postMessage(reply);
});
