#!/usr/bin/env node
// 精度テスト（bench.html）をヘッドレスの Chromium で回し、結果を JSON と Markdown に書き出す。
//
// 使い方:
//   npm run bench -- <曲フォルダ か 曲フォルダの入ったフォルダ> [...] [--full 曲名] [--mix drums,chips,stem,full,nodrums] [--tol 0.05] [--out bench-results]
//   --full は BGM がドラム入りの原曲そのものの曲（何度でも指定できる）。
// 必要なもの: Playwright と Chromium（npx playwright install chromium）。
import { createRequire } from 'node:module';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright が見つかりません。npm i -D playwright && npx playwright install chromium を実行してください。');
  process.exit(1);
}

const args = process.argv.slice(2);
const dirs = [];
const full = [];
let mixes;
let tol = 0.05;
let out = 'bench-results';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--full') full.push(args[++i]);
  else if (a === '--mix') mixes = args[++i].split(',');
  else if (a === '--tol') tol = Number(args[++i]);
  else if (a === '--out') out = args[++i];
  else dirs.push(resolve(a));
}
if (dirs.length === 0) {
  console.error('曲フォルダを指定してください。例: npm run bench -- ~/DTXFiles/MySongs --full "曲名"');
  process.exit(1);
}
for (const d of dirs) if (!statSync(d).isDirectory()) throw new Error(`フォルダではありません: ${d}`);

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const addr = server.httpServer.address();
const base = `http://127.0.0.1:${addr.port}/dtx-mania-web-editor/`;
const browser = await chromium.launch();
const results = [];
const skipped = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
  await page.goto(base + 'bench.html');
  await page.waitForFunction(() => !!window.__bench);
  let last = '';
  const timer = setInterval(async () => {
    const s = await page.locator('#status').textContent().catch(() => '');
    if (s && s !== last) {
      last = s;
      console.log(s);
    }
  }, 1000);
  try {
    for (const d of dirs) {
      await page.locator('#pick').setInputFiles(d);
      const names = await page.evaluate(() => window.__bench.songs());
      console.log(`${d}: ${names.join(', ')}`);
      const r = await page.evaluate((opts) => window.__bench.run(opts), { mixes, full, tol, wav: false });
      results.push(...r.results);
      skipped.push(...r.skipped);
    }
  } finally {
    clearInterval(timer);
  }
  const pooled = await page.evaluate((r) => window.__bench.pool(r), results);
  const at = new Date().toISOString();
  mkdirSync(out, { recursive: true });
  const stamp = at.slice(0, 19).replace(/[:T]/g, '-');
  writeFileSync(join(out, `bench-${stamp}.json`), JSON.stringify({ at, tol, results, pooled, skipped }, null, 1));
  const md = report({ at, tol, results, pooled, skipped });
  writeFileSync(join(out, `bench-${stamp}.md`), md);
  console.log('\n' + md);
  console.log(`書き出しました: ${join(out, `bench-${stamp}.{json,md}`)}`);
} finally {
  await browser.close();
  await server.close();
}

function report({ at, tol, results, pooled, skipped }) {
  const C = ['BD', 'SD', 'TT', 'HH', 'CY'];
  const mixLabel = { drums: 'ドラムだけ', chips: '合成', stem: '実録音', full: '原曲', nodrums: 'ドラム無し（対照）' };
  const f = (c) => (!c || c.f === null ? '–' : c.f.toFixed(2));
  const pr = (c) => (!c || c.f === null ? '' : ` (${c.precision === null ? '–' : c.precision.toFixed(2)}/${c.recall === null ? '–' : c.recall.toFixed(2)})`);
  const row = (head, s) => `| ${head} | **${f(s.all)}**${pr(s.all)} | ${C.map((k) => f(s.classes[k])).join(' | ')} | ${s.all.ref} | ${s.all.est} |`;
  const th = (head) => `| ${head} | 全体 F (適合/再現) | ${C.join(' | ')} | 正解 | 推定 |\n|${'---|'.repeat(C.length + 4)}`;
  let s = `# 耳コピ精度テスト ${at.slice(0, 10)}\n\n許容のずれ ±${Math.round(tol * 1000)}ms。曲をまたいで当たり・正解・推定を足して計算。\n\n## まとめ\n\n${th('混ぜ方・方式')}\n`;
  for (const r of pooled) s += row(`${mixLabel[r.mix]}（${r.songs}曲）・${r.label}`, r.score) + '\n';
  const ids = [...new Set(results.flatMap((r) => r.methods.map((m) => m.id)))];
  for (const id of ids) {
    const label = results.flatMap((r) => r.methods).find((m) => m.id === id)?.label ?? id;
    s += `\n## 曲ごと：${label}\n\n${th('曲・混ぜ方')}\n`;
    for (const r of results) {
      const m = r.methods.find((x) => x.id === id);
      if (m) s += row(`${r.song}・${mixLabel[r.mix]}`, m.score) + '\n';
    }
  }
  if (skipped.length) s += `\n## 作れなかったテスト曲\n\n${skipped.map((x) => `- ${x.song}・${mixLabel[x.mix]}：${x.why}`).join('\n')}\n`;
  return s;
}
