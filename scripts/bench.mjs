#!/usr/bin/env node
// 精度テスト（bench.html）をヘッドレスの Chromium で回し、結果を JSON と Markdown に書き出す。
//
// 使い方:
//   npm run bench -- <曲フォルダ か 曲フォルダの入ったフォルダ> [...] [--full 曲名] [--mix drums,chips,stem,stemonly,full,nodrums] [--tol 0.05] [--out bench-results]
//   --full は BGM がドラム入りの原曲そのものの曲（何度でも指定できる）。
//   --complete を付けると、打点の推定の代わりに TAB補完（先の小節の予測）を測る。
//   --train（--complete と一緒に）を付けると、候補の点数の重みを学習するための行も書き出す（train-*.json）。
//   --no-drums を付けると、ドラムの採譜モデル（ADTOF）を使う方式を測らない。
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
let complete = false;
let train = false;
let drums = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--full') full.push(args[++i]);
  else if (a === '--complete') complete = true;
  else if (a === '--train') train = true;
  else if (a === '--no-drums') drums = false;
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
// 採譜モデルを Hugging Face から読むので、プロキシの内側ではプロキシを通す（手元のサーバーは通さない）
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {});
const results = [];
const skipped = [];
const trainRows = [];
try {
  const page = await browser.newPage(proxy ? { ignoreHTTPSErrors: true } : {});
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
      const r = complete
        ? await page.evaluate((opts) => window.__bench.runComplete(opts), { train, drums })
        : await page.evaluate((opts) => window.__bench.run(opts), { mixes, full, tol, wav: false });
      if (r.train) trainRows.push(...r.train);
      results.push(...r.results);
      skipped.push(...r.skipped);
    }
  } finally {
    clearInterval(timer);
  }
  const at = new Date().toISOString();
  mkdirSync(out, { recursive: true });
  const stamp = at.slice(0, 19).replace(/[:T]/g, '-');
  if (complete) {
    const pooled = await page.evaluate((r) => window.__bench.poolComplete(r), results);
    const evidence = await page.evaluate((r) => window.__bench.poolEvidence(r), results);
    writeFileSync(join(out, `complete-${stamp}.json`), JSON.stringify({ at, results, pooled, evidence, skipped }, null, 1));
    if (train) {
      writeFileSync(join(out, `train-${stamp}.json`), JSON.stringify(trainRows));
      console.log(`学習用の行: ${join(out, `train-${stamp}.json`)}`);
    }
    const md = completeReport({ at, results, pooled, skipped, evidence });
    writeFileSync(join(out, `complete-${stamp}.md`), md);
    console.log('\n' + md);
    console.log(`書き出しました: ${join(out, `complete-${stamp}.{json,md}`)}`);
  } else {
    const pooled = await page.evaluate((r) => window.__bench.pool(r), results);
    writeFileSync(join(out, `bench-${stamp}.json`), JSON.stringify({ at, tol, results, pooled, skipped }, null, 1));
    const md = report({ at, tol, results, pooled, skipped });
    writeFileSync(join(out, `bench-${stamp}.md`), md);
    console.log('\n' + md);
    console.log(`書き出しました: ${join(out, `bench-${stamp}.{json,md}`)}`);
  }
} finally {
  await browser.close();
  await server.close();
}

function report({ at, tol, results, pooled, skipped }) {
  const C = ['BD', 'SD', 'TT', 'HH', 'CY'];
  const mixLabel = { drums: 'ドラムだけ', chips: '合成', stem: '実録音', stemonly: '録音のドラムだけ', full: '原曲', nodrums: 'ドラム無し（対照）' };
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

function completeReport({ at, results, pooled, skipped, evidence }) {
  const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
  const f2 = (x) => (x === null || x === undefined ? '–' : x.toFixed(2));
  const songs = new Set(results.map((r) => r.song)).size;
  let s = `# TAB補完の精度 ${at.slice(0, 10)}\n\n${songs} 曲 ${results.length} 譜面（原曲あり ${results.filter((r) => r.audio).length}）。各セルは「出した小節のうちそのまま正解」（出した割合）。\n\n`;
  s += `| 方式 | 譜面 | +1 | +2 | +3 | +4 | 次の小節の F (適合/再現) | 手間の減り |\n|---|---|---|---|---|---|---|---|\n`;
  for (const m of pooled) {
    const o = m.offsets;
    s += `| ${m.label} | ${m.charts} | ${o.map((x) => `${pct(x.exactRate)} (${pct(x.coverage)})`).join(' | ')} | ${f2(o[0].f)} (${f2(o[0].precision)}/${f2(o[0].recall)}) | ${pct(o[0].saved)} |\n`;
  }
  const cal = pooled.find((m) => m.id === 'audio') ?? pooled.find((m) => m.id === 'context');
  if (cal) {
    s += `\n## 見込みごとのそのまま正解の割合（${cal.label}）\n\n| 見込み | 数 | そのまま正解 | F の平均 |\n|---|---|---|---|\n`;
    for (const b of cal.calib) s += `| ${b.lo.toFixed(1)}〜${b.hi.toFixed(1)} | ${b.n} | ${pct(b.exact)} | ${f2(b.f)} |\n`;
  }
  if (evidence && Object.keys(evidence).length) {
    const C = ['BD', 'SD', 'TT', 'HH', 'CY'];
    s += `\n## 原曲との照合（曲の構造も使う・見込み0.2以上・次の小節）\n\n各セルは「聞こえる と言ったチップの正解率 / 聞こえない と言ったチップの正解率」（数）。\n\n| 照合 | ${C.join(' | ')} |\n|${'---|'.repeat(C.length + 1)}\n`;
    for (const [k, t] of Object.entries(evidence)) {
      s += `| ${k} | ${C.map((c) => {
        const x = t[c];
        return x.heard + x.unheard ? `${pct(x.heard ? x.heardOk / x.heard : null)} / ${pct(x.unheard ? x.unheardOk / x.unheard : null)} (${x.heard}/${x.unheard})` : '–';
      }).join(' | ')} |\n`;
    }
  }
  if (skipped.length) s += `\n## 測らなかった譜面\n\n${skipped.map((x) => `- ${x}`).join('\n')}\n`;
  return s;
}
