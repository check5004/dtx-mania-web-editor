// ビルドのときに PWA（ホーム画面に追加できるアプリ）の物を作る Vite のプラグイン。vite.config.ts から使う（Node で動く）。
// vite.config.ts から読むファイルは import に .ts を付ける（Vite の設定の読み込み方が将来変わっても読めるように）
// - dist を見て、入れるときに取る物（precache）と、使ったときに取っておく大きい物（lazy）の目録を作る
// - src/pwa/sw.ts を1つの sw.js にまとめ、先頭に目録（__DTXE_SW_DATA__）を置いて dist に書く
// - iPad の起動画面（apple-touch-startup-image）の <link> を index.html に足す（src/pwa/splash.ts）
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build as viteBuild, type Plugin, type ResolvedConfig } from 'vite';
import { splashLinks } from './splash.ts';
import { precacheBytes, type SwData, type SwEntry } from './swCore.ts';

/** これより大きいファイルは入れるときに取らず、使ったときに取っておく（採譜・ステム分解の ONNX Runtime の WASM は 15〜30 MB） */
export const LAZY_BYTES = 3 * 1024 * 1024;

export interface DistFile {
  /** dist からの相対パス（/ 区切り） */
  path: string;
  bytes: number;
  /** 中身の SHA-256（16 進の先頭 16 文字） */
  rev: string;
}

/** アプリでは使わない物（開発用の bench・ライセンスの文・起動画面の画像・Service Worker 自身など） */
export function skipFile(p: string): boolean {
  if (p === 'sw.js' || p.endsWith('.map') || p.endsWith('.txt')) return true;
  if (p.split('/').some((s) => s.startsWith('.'))) return true;
  if (p.startsWith('splash/')) return true;
  return p.endsWith('.html') && p !== 'index.html';
}

/** dist のファイルを、入れるときに取る物と使ったときに取っておく物に分ける */
export function planPrecache(files: readonly DistFile[], exclude: ReadonlySet<string> = new Set()): { precache: SwEntry[]; lazy: string[] } {
  const precache: SwEntry[] = [];
  const lazy: string[] = [];
  for (const f of files) {
    if (exclude.has(f.path) || skipFile(f.path)) continue;
    if (f.bytes > LAZY_BYTES) lazy.push(f.path);
    else precache.push({ path: f.path, rev: f.rev, bytes: f.bytes });
  }
  precache.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  lazy.sort();
  return { precache, lazy };
}

export function revOf(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

async function listFiles(dir: string, rel = ''): Promise<DistFile[]> {
  const out: DistFile[] = [];
  for (const ent of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await listFiles(dir, p)));
    else if (ent.isFile()) {
      const buf = await readFile(path.join(dir, p));
      out.push({ path: p, bytes: buf.byteLength, rev: revOf(buf) });
    }
  }
  return out;
}

/** sw.ts を1つのスクリプト（モジュールでない）にまとめる */
async function bundleServiceWorker(root: string): Promise<string> {
  const res = await viteBuild({
    configFile: false,
    root,
    logLevel: 'warn',
    publicDir: false,
    build: {
      write: false,
      emptyOutDir: false,
      minify: true,
      target: 'es2020',
      lib: { entry: path.resolve(root, 'src/pwa/sw.ts'), formats: ['iife'], name: 'dtxeServiceWorker', fileName: () => 'sw.js' },
    },
  });
  const outs = Array.isArray(res) ? res : [res];
  for (const o of outs) {
    if (!('output' in o)) continue;
    const chunk = o.output.find((c) => c.type === 'chunk');
    if (chunk && chunk.type === 'chunk') return chunk.code;
  }
  throw new Error('sw.ts をまとめられませんでした'); // i18n-ignore（ビルドのエラー）
}

export function pwaPlugin(opts: { version: string; build: number }): Plugin {
  let config: ResolvedConfig;
  /** 開発用の bench の入口（アプリでは使わないので入れない） */
  const benchFiles = new Set<string>();
  return {
    name: 'dtxe-pwa',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.path !== '/index.html') return html;
        return {
          html,
          tags: splashLinks(config.base).map((l) => ({ tag: 'link', attrs: { rel: 'apple-touch-startup-image', href: l.href, media: l.media }, injectTo: 'head' as const })),
        };
      },
    },
    generateBundle(_o, bundle) {
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'chunk' && item.isEntry && item.name === 'bench') benchFiles.add(name);
      }
    },
    async closeBundle() {
      const outDir = path.resolve(config.root, config.build.outDir);
      const files = await listFiles(outDir);
      const { precache, lazy } = planPrecache(files, benchFiles);
      if (!precache.some((e) => e.path === 'index.html')) throw new Error('index.html が dist にありません'); // i18n-ignore
      const data: SwData = { version: opts.version, build: opts.build, precache, lazy };
      const code = await bundleServiceWorker(config.root);
      // 目録は先頭のグローバル変数で渡す（まとめたコードの中の名前は縮められても、グローバルの名前はそのまま）
      await writeFile(path.join(outDir, 'sw.js'), `var __DTXE_SW_DATA__=${JSON.stringify(data)};\n${code}`);
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      config.logger.info(
        `[dtxe-pwa] sw.js: ${precache.length} files (${mb(precacheBytes(data))} MB) precached, ${lazy.length} cached on first use (${mb(files.filter((f) => lazy.includes(f.path)).reduce((a, f) => a + f.bytes, 0))} MB)`,
      );
    },
  };
}
