// アプリ（PWA）のアイコンと iPad の起動画面を作る。デザインを変えたときだけ手で動かし、できた PNG をコミットする。
// 使い方: node scripts/make-pwa-images.mjs
// - public/icons/icon.svg（ファビコンと同じ絵）から icon-192/512.png（角丸・透明の縁）を作る
// - マスク用（Android・Chrome が丸や角丸に切り抜く）は全面を青にし、バーを内側 80% の円に収める
// - iPad の起動画面は src/pwa/splash.ts の大きさ・向きごとに 1 枚（iOS は大きさがぴったり合う物しか使わない）
// - apple-touch-icon.png（180×180、全面）は前からある物をそのまま使う
// Playwright（Chromium）で描く。文字は Google Fonts の IBM Plex Sans JP（つながらなければ手元の Inter）
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPLASH_SIZES, splashFile, splashPixels } from '../src/pwa/splash.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const BG = '#0b0e13';
const BLUE = '#4CC2FF';
const INK = '#0B0E13';
const BARS = `<rect x="5" y="13" width="4" height="3" rx="1" fill="${INK}"/><rect x="9" y="8" width="4" height="3" rx="1" fill="${INK}"/><rect x="13" y="4" width="4" height="3" rx="1" fill="${INK}"/>`;

const anySvg = await readFile(path.join(pub, 'icons/icon.svg'), 'utf8');
// バーの組の中心 (11, 10) を絵の中心 (11, 11) に寄せ、縮めて安全な円（半径 0.4×22）の内側に収める
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><rect width="22" height="22" fill="${BLUE}"/><g transform="translate(11 11) scale(0.8) translate(-11 -10)">${BARS}</g></svg>`;

const launch = { args: ['--force-color-profile=srgb'] };
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY };
const browser = await chromium.launch(launch);
const ctx = await browser.newContext({ deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

async function shot(file, width, height, html, transparent = false) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@600&display=block">
<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${transparent ? 'transparent' : BG}}
body{display:grid;place-items:center} svg{display:block}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(pub, file);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, await page.screenshot({ type: 'png', omitBackground: transparent }));
  console.log(file, `${width}x${height}`);
}

for (const n of [192, 512]) {
  await shot(`icons/icon-${n}.png`, n, n, anySvg.replace('<svg ', `<svg width="${n}" height="${n}" `), true);
  await shot(`icons/icon-maskable-${n}.png`, n, n, maskableSvg.replace('<svg ', `<svg width="${n}" height="${n}" `));
}

for (const s of SPLASH_SIZES) {
  for (const land of [false, true]) {
    const { width, height } = splashPixels(s, land);
    const icon = 128 * s.dpr;
    const html = `<div style="display:flex;flex-direction:column;align-items:center;gap:${26 * s.dpr}px;transform:translateY(${20 * s.dpr}px)">
${anySvg.replace('<svg ', `<svg width="${icon}" height="${icon}" `)}
<div style="font-family:'IBM Plex Sans JP',Inter,sans-serif;font-weight:600;font-size:${24 * s.dpr}px;color:#c9d1dc;letter-spacing:0.01em">DTX Web Editor</div></div>`;
    await shot(splashFile(s, land), width, height, html);
  }
}

await browser.close();
