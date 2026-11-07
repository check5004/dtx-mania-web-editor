import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildCacheName,
  buildOfCacheName,
  buildsToDelete,
  canReuse,
  isNewerBuild,
  MANIFEST_PATH,
  parseSwData,
  precacheBytes,
  routeOf,
  runtimeToDelete,
  type SwData,
} from './swCore';
import { LAZY_BYTES, planPrecache, skipFile } from './vite-plugin';
import { SPLASH_SIZES, splashFile, splashLinks, splashPixels } from './splash';

const SCOPE = 'https://check5004.github.io/dtx-mania-web-editor/';
const PRE = new Set(['index.html', 'assets/main-abc.js', 'kits/std/sd.ogg', 'manifest.webmanifest']);
const req = (url: string, o: Partial<{ method: string; mode: string; hasRange: boolean }> = {}) => ({ url, method: 'GET', mode: 'cors', hasRange: false, ...o });

describe('routeOf（どう返すか）', () => {
  it('アプリの画面への移動はネット優先の画面', () => {
    expect(routeOf(req(SCOPE, { mode: 'navigate' }), SCOPE, PRE)).toEqual({ kind: 'page' });
    expect(routeOf(req(SCOPE + 'index.html', { mode: 'navigate' }), SCOPE, PRE)).toEqual({ kind: 'page' });
    expect(routeOf(req(SCOPE + '?lang=ja', { mode: 'navigate' }), SCOPE, PRE)).toEqual({ kind: 'page' });
  });

  it('開発用の bench.html やスコープの外への移動には手を出さない', () => {
    expect(routeOf(req(SCOPE + 'bench.html', { mode: 'navigate' }), SCOPE, PRE)).toBeNull();
    expect(routeOf(req('https://check5004.github.io/other-repo/', { mode: 'navigate' }), SCOPE, PRE)).toBeNull();
    expect(routeOf(req('https://check5004.github.io/dtx-mania-web-editor', { mode: 'navigate' }), SCOPE, PRE)).toBeNull();
  });

  it('入れた物・ハッシュ付きの物', () => {
    expect(routeOf(req(SCOPE + 'assets/main-abc.js'), SCOPE, PRE)).toEqual({ kind: 'precache', path: 'assets/main-abc.js' });
    expect(routeOf(req(SCOPE + 'kits/std/sd.ogg'), SCOPE, PRE)).toEqual({ kind: 'precache', path: 'kits/std/sd.ogg' });
    // 入れていない大きい WASM・別の版の JS は、使ったときに取っておく
    expect(routeOf(req(SCOPE + 'assets/ort-wasm-simd-threaded-x.wasm'), SCOPE, PRE)).toEqual({ kind: 'asset', path: 'assets/ort-wasm-simd-threaded-x.wasm' });
    expect(routeOf(req(SCOPE + 'assets/main-old.js'), SCOPE, PRE)).toEqual({ kind: 'asset', path: 'assets/main-old.js' });
  });

  it('GET 以外・Range 付き・問い合わせ付き・sw.js・目録は素通し', () => {
    expect(routeOf(req(SCOPE + 'assets/main-abc.js', { method: 'POST' }), SCOPE, PRE)).toBeNull();
    expect(routeOf(req(SCOPE + 'kits/std/sd.ogg', { hasRange: true }), SCOPE, PRE)).toBeNull();
    expect(routeOf(req(SCOPE + 'assets/main-abc.js?v=1'), SCOPE, PRE)).toBeNull();
    expect(routeOf(req(SCOPE + 'sw.js'), SCOPE, PRE)).toBeNull();
    expect(routeOf(req(SCOPE + MANIFEST_PATH), SCOPE, PRE)).toBeNull();
    expect(routeOf(req(SCOPE + 'kits/LICENSE-GeneralUser-GS.txt'), SCOPE, PRE)).toBeNull();
  });

  it('ほかのオリジンは Google Fonts だけ。AI・Google のログイン・Drive・モデルの置き場には手を出さない', () => {
    expect(routeOf(req('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP'), SCOPE, PRE)).toEqual({ kind: 'font-css' });
    expect(routeOf(req('https://fonts.gstatic.com/s/ibmplexsansjp/v5/a.woff2'), SCOPE, PRE)).toEqual({ kind: 'font' });
    for (const u of [
      'https://openrouter.ai/api/v1/chat/completions',
      'https://accounts.google.com/gsi/client',
      'https://apis.google.com/js/api.js',
      'https://www.googleapis.com/drive/v3/files',
      'https://huggingface.co/Ryan5453/unblend/resolve/x/model.onnx',
      'https://www.youtube.com/iframe_api',
      'https://i.ytimg.com/vi/a/hqdefault.jpg',
    ]) {
      expect(routeOf(req(u), SCOPE, PRE)).toBeNull();
    }
  });
});

const data = (build: number, precache: [string, string][], lazy: string[] = []): SwData => ({
  version: '1.0.0',
  build,
  precache: precache.map(([path, rev]) => ({ path, rev, bytes: 10 })),
  lazy,
});

describe('入れる・消す', () => {
  it('前の版から写せるのは、assets/ の同じ名前か、rev が同じ物', () => {
    expect(canReuse({ path: 'assets/a-1.js', rev: 'x', bytes: 1 }, { path: 'assets/a-1.js', rev: 'y', bytes: 1 })).toBe(true);
    expect(canReuse({ path: 'index.html', rev: 'x', bytes: 1 }, { path: 'index.html', rev: 'x', bytes: 1 })).toBe(true);
    expect(canReuse({ path: 'index.html', rev: 'x', bytes: 1 }, { path: 'index.html', rev: 'y', bytes: 1 })).toBe(false);
    expect(canReuse({ path: 'index.html', rev: 'x', bytes: 1 }, undefined)).toBe(false);
  });

  it('版のキャッシュの名前とビルド時刻', () => {
    const n = buildCacheName(1794053440016);
    expect(n.startsWith('dtxe-app-b-')).toBe(true);
    expect(buildOfCacheName(n)).toBe(1794053440016);
    expect(buildOfCacheName('dtxe-models-v1')).toBeNull();
  });

  it('いまの版と新しい順に 2 つを残し、入れ終わらなかった古い物を消す。ほかのキャッシュには触らない', () => {
    const cur = buildCacheName(500);
    const del = buildsToDelete(
      [
        { name: buildCacheName(100), build: 100 },
        { name: buildCacheName(300), build: 300 },
        { name: buildCacheName(200), build: 200 },
        { name: cur, build: 500 },
        { name: buildCacheName(50), build: null },
        // いまより新しい版を入れている最中（目録がまだ無い）
        { name: buildCacheName(900), build: null },
        { name: 'dtxe-models-v1', build: null },
        { name: 'dtxe-app-runtime', build: null },
      ],
      cur,
      500,
    );
    expect(new Set(del)).toEqual(new Set([buildCacheName(100), buildCacheName(50)]));
  });

  it('実行時のキャッシュは、残す版のどれにも出てこない物を消す', () => {
    const kept = [data(2, [['assets/main-2.js', 'a']], ['assets/ort-2.wasm']), data(1, [['assets/main-1.js', 'b']], ['assets/ort-1.wasm'])];
    expect(runtimeToDelete(['assets/ort-2.wasm', 'assets/ort-1.wasm', 'assets/ort-0.wasm', 'assets/main-1.js'], kept)).toEqual(['assets/ort-0.wasm']);
  });

  it('新しい版か（ビルド時刻で比べる）', () => {
    expect(isNewerBuild(200, 100)).toBe(true);
    expect(isNewerBuild(100, 100)).toBe(false);
    expect(isNewerBuild(50, 100)).toBe(false);
    expect(isNewerBuild(undefined, 100)).toBe(false);
  });

  it('目録を読む', () => {
    const d = data(5, [['index.html', 'r']]);
    expect(parseSwData(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(precacheBytes(d)).toBe(10);
    expect(parseSwData({ version: '1', build: 'x', precache: [], lazy: [] })).toBeNull();
    expect(parseSwData(null)).toBeNull();
  });
});

describe('ビルドの目録（vite-plugin）', () => {
  it('アプリで使わない物は入れず、大きいファイルは使ったときに取っておく', () => {
    const f = (path: string, bytes = 100) => ({ path, bytes, rev: 'r' + path.length });
    const { precache, lazy } = planPrecache(
      [
        f('index.html'),
        f('bench.html'),
        f('sw.js'),
        f('.nojekyll'),
        f('assets/main-a.js', 1_300_000),
        f('assets/bench-b.js'),
        f('assets/main-a.js.map'),
        f('assets/ort-wasm-simd-threaded-c.wasm', 15_000_000),
        f('kits/std/sd.ogg'),
        f('kits/LICENSE-GeneralUser-GS.txt'),
        f('splash/ipad-820x1180-port.png'),
        f('manifest.webmanifest'),
      ],
      new Set(['assets/bench-b.js']),
    );
    expect(precache.map((e) => e.path)).toEqual(['assets/main-a.js', 'index.html', 'kits/std/sd.ogg', 'manifest.webmanifest']);
    expect(lazy).toEqual(['assets/ort-wasm-simd-threaded-c.wasm']);
    expect(LAZY_BYTES).toBeGreaterThan(1_300_000);
    expect(skipFile('icons/icon-192.png')).toBe(false);
  });
});

describe('iPad の起動画面', () => {
  it('大きさ・向きごとの <link> と、その画像がある', () => {
    const links = splashLinks('/dtx-mania-web-editor/');
    expect(links).toHaveLength(SPLASH_SIZES.length * 2);
    expect(links[0].href).toBe('/dtx-mania-web-editor/splash/ipad-744x1133-port.png');
    expect(links[0].media).toContain('(device-width: 744px) and (device-height: 1133px)');
    expect(links[1].media).toContain('(orientation: landscape)');
    expect(splashPixels(SPLASH_SIZES[0], true)).toEqual({ width: 2266, height: 1488 });
    for (const s of SPLASH_SIZES) {
      for (const land of [false, true]) {
        const file = new URL(`../../public/${splashFile(s, land)}`, import.meta.url);
        expect(existsSync(file), splashFile(s, land)).toBe(true);
        // PNG の幅・高さ（IHDR）が画面とぴったり合う
        const png = readFileSync(file);
        const { width, height } = splashPixels(s, land);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
      }
    }
  });

  it('manifest のアイコンがある', () => {
    const m = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8')) as {
      icons: { src: string; sizes: string; purpose: string }[];
      start_url: string;
      scope: string;
      display: string;
    };
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    for (const i of m.icons) expect(existsSync(new URL(`../../public/${i.src}`, import.meta.url)), i.src).toBe(true);
    expect(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
    expect(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
  });
});
