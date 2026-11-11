// README の「iPad・iPhone でも」の 1 枚: iPad（横）と iPhone（縦 2 枚）の画面写真を、端末の枠に入れて並べる。
// 使い方: node scripts/readme/devices.mjs [写真のフォルダ（既定 .readme-demo/shots）] → そのフォルダの devices.png
// 写真は scripts/readme/shots.mjs の ipad・iphone・iphone-pad。枠は特定の機種に似せない、角の丸い板にする。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.resolve(process.argv[2] ?? path.join(root, '.readme-demo/shots'));
const img = (n) => `data:image/png;base64,${readFileSync(path.join(dir, `${n}.png`)).toString('base64')}`;

const W = 1830;
const H = 900;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;background:transparent;font-family:'Hiragino Sans','Yu Gothic UI','Noto Sans CJK JP','Noto Sans JP',sans-serif}
.card{position:relative;width:${W}px;height:${H}px;border-radius:40px;border:2px solid #223044;background:radial-gradient(900px 500px at 75% 30%,rgba(76,194,255,.16),transparent 70%),radial-gradient(700px 500px at 10% 90%,rgba(156,132,224,.14),transparent 70%),linear-gradient(135deg,#0B1018,#131C2A);overflow:hidden}
.dev{position:absolute;background:#04060A;border:2px solid #2E3B4F;box-shadow:0 30px 60px rgba(0,0,0,.55),inset 0 0 0 2px #0E141D}
.dev img{display:block;width:100%;height:100%;object-fit:cover}
.screen{width:100%;height:100%;overflow:hidden;background:#0b0e13}
.cap{position:absolute;color:#93A1B3;font-size:24px;text-align:center;letter-spacing:.02em}
.cap b{color:#E8EEF6;font-weight:700;margin-right:10px}
</style></head><body>
<div class="card">
  <div class="dev" style="left:60px;top:70px;width:984px;height:696px;padding:20px;border-radius:44px"><div class="screen" style="border-radius:22px"><img src="${img('ipad')}"></div></div>
  <div class="cap" style="left:60px;top:800px;width:984px"><b>iPad</b>横でも縦でも。入力パッドで叩いて入れる</div>
  <div class="dev" style="left:1090px;top:52px;width:344px;height:721px;padding:11px;border-radius:40px"><div class="screen" style="border-radius:28px"><img src="${img('iphone')}"></div></div>
  <div class="cap" style="left:1090px;top:800px;width:344px"><b>iPhone</b>譜面</div>
  <div class="dev" style="left:1450px;top:52px;width:344px;height:721px;padding:11px;border-radius:40px"><div class="screen" style="border-radius:28px"><img src="${img('iphone-pad')}"></div></div>
  <div class="cap" style="left:1450px;top:800px;width:344px">パッドで入れる</div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(500);
const out = path.join(dir, 'devices.png');
await page.locator('.card').screenshot({ path: out, omitBackground: true });
await browser.close();
console.log('→', out);
