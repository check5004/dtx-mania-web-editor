// アプリ（PWA）のアイコン・ファビコンと iPad の起動画面を作る。デザインを変えたときだけ手で動かし、できたファイルをコミットする。
// 使い方: node scripts/make-pwa-images.mjs
// 絵は scripts/icon-art.mjs（スネアのヘッドから 5 本のレーンが伸びる）。そこから:
// - public/icons/icon.svg（角丸のタイル）と icon-192/512.png（まわりは透明）
// - マスク用 icon-maskable-192/512.png（Android・Chrome が丸や角丸に切り抜く）は全面を地にし、絵を内側 80% の円に収める
// - apple-touch-icon.png（180×180、全面。角は iOS が丸める）
// - public/icons/mark.svg と favicon-32.png（16〜32px 用の小さい版。ファビコンと画面左上のロゴ）
// - iPad の起動画面は src/pwa/splash.ts の大きさ・向きごとに 1 枚（iOS は大きさがぴったり合う物しか使わない）
// Playwright（Chromium）で描く。文字は Google Fonts の IBM Plex Sans JP（つながらなければ手元の Inter）
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPLASH_SIZES, splashFile, splashPixels } from '../src/pwa/splash.ts';
import { MARK_SVG, iconSvg } from './icon-art.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const BG = '#0b0e13';

const anySvg = iconSvg({ mode: 'any' });
const fullSvg = iconSvg({ mode: 'full' });
const maskableSvg = iconSvg({ mode: 'maskable' });

await writeFile(path.join(pub, 'icons/icon.svg'), anySvg);
await writeFile(path.join(pub, 'icons/mark.svg'), MARK_SVG);
console.log('icons/icon.svg', 'icons/mark.svg');

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

const sized = (svg, n) => svg.replace('<svg ', `<svg width="${n}" height="${n}" `);

for (const n of [192, 512]) {
  await shot(`icons/icon-${n}.png`, n, n, sized(anySvg, n), true);
  await shot(`icons/icon-maskable-${n}.png`, n, n, sized(maskableSvg, n));
}
await shot('apple-touch-icon.png', 180, 180, sized(fullSvg, 180));
await shot('icons/favicon-32.png', 32, 32, sized(MARK_SVG, 32), true);

for (const s of SPLASH_SIZES) {
  for (const land of [false, true]) {
    const { width, height } = splashPixels(s, land);
    const icon = 128 * s.dpr;
    const html = `<div style="display:flex;flex-direction:column;align-items:center;gap:${26 * s.dpr}px;transform:translateY(${20 * s.dpr}px)">
${sized(anySvg, icon)}
<div style="font-family:'IBM Plex Sans JP',Inter,sans-serif;font-weight:600;font-size:${24 * s.dpr}px;color:#c9d1dc;letter-spacing:0.01em">DTX Web Editor</div></div>`;
    await shot(splashFile(s, land), width, height, html);
  }
}

await browser.close();
