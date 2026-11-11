// README の図（docs/readme/*.svg）を、いくつかの時刻で止めて 1 枚の PNG に並べる（動きの確かめ用）。
// 使い方: node scripts/readme/frames.mjs <出力先フォルダ> [名前.svg,…] [時刻(秒),…]
// あわせて <img> で読んだときに描けるか（外のファイルを読んでいないか）も確かめる。
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'docs/readme');
const out = path.resolve(process.argv[2] ?? '.');
mkdirSync(out, { recursive: true });
const names = process.argv[3] ? process.argv[3].split(',') : readdirSync(dir).filter((f) => f.endsWith('.svg'));
const times = process.argv[4] ? process.argv[4].split(',').map(Number) : [0, 0.8, 1.6, 2.4, 3.2, 4.0, 5.0, 6.5];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 1 });
for (const name of names) {
  const svg = readFileSync(path.join(dir, name), 'utf8');
  const w = Number(/width="(\d+)"/.exec(svg)[1]);
  const cols = w > 700 ? 2 : 4;
  // 時刻ごとに 1 つずつ並べ、それぞれのアニメーションをその時刻で止める
  const cells = times.map((t) => `<figure style="margin:0"><div class="f" data-t="${t}">${svg}</div><figcaption style="font:12px sans-serif;color:#555">${t}s</figcaption></figure>`).join('');
  await page.setViewportSize({ width: cols * (w + 20) + 20, height: 1200 });
  await page.setContent(`<!doctype html><body style="margin:0;padding:10px;background:#fff;display:grid;grid-template-columns:repeat(${cols},${w}px);gap:10px 20px">${cells}
<img id="as-img" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="display:none"></body>`);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    for (const f of document.querySelectorAll('.f')) {
      const t = Number(f.dataset.t) * 1000;
      for (const a of f.getAnimations({ subtree: true })) {
        a.pause();
        a.currentTime = t;
      }
    }
  });
  const ok = await page.evaluate(() => {
    const im = document.getElementById('as-img');
    return im.complete && im.naturalWidth > 0;
  });
  await page.waitForTimeout(100);
  const file = path.join(out, name.replace('.svg', '.frames.png'));
  writeFileSync(file, await page.screenshot({ fullPage: true }));
  console.log(name, ok ? 'img ok' : 'IMG FAILED', '→', file);
}
await browser.close();
