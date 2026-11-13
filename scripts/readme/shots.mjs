// README の画面写真を撮る（PC は 1440×900）。デモ曲は scripts/readme/demo-song.mjs で作る。
// 使い方:
//   node scripts/readme/demo-song.mjs
//   npx vite --port 5173 &              （開発サーバー。アプリと同じ store を import して画面を整える）
//   DPR=1.5 node scripts/readme/shots.mjs editor,stems,tempo,songinfo,library,preview,velocity,fx,ipad,home,ai
//   DPR=2 node scripts/readme/shots.mjs tab,gen,iphone      （切り抜きとスマホは 2 倍）
//   node scripts/readme/devices.mjs                          （iPad と iPhone を 1 枚に並べる）
//   python3 scripts/readme/shrink.py                         （256 色の PNG にして docs/readme/shots/ へ）
// 撮った物はいったん .readme-demo/shots/ に置く（コミットしない）。
// 画面の作りが変わると動かなくなることがある。そのときは直してから撮り直す。
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL = process.env.URL ?? 'http://localhost:5173/dtx-mania-web-editor/';
const OUT = path.resolve(process.env.OUT ?? path.join(root, '.readme-demo/shots'));
const SONG = path.resolve(process.env.SONG ?? path.join(root, '.readme-demo/Neon Skyline'));
const DPR = Number(process.env.DPR ?? 2);
const ONLY = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
mkdirSync(OUT, { recursive: true });

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], proxy });
const BASE = new globalThis.URL(URL).pathname;

/** アプリのモジュール（開発サーバーの /src/…）を読む関数をページに置く */
async function setup(page) {
  await page.addInitScript((base) => {
    window.__m = (p) => import(`${base}src/${p}`);
  }, BASE);
}

async function openSong(page, file = 'mstr.dtx') {
  await page.goto(URL);
  await page.waitForTimeout(1200);
  await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(SONG);
  await page.getByText(file).click();
  await page.waitForTimeout(1500);
  // 解析（波形）とドラムの採譜（原曲の打点）を待つ
  for (let i = 0; i < 120; i++) {
    const st = await page.evaluate(async () => ({
      a: (await window.__m('store/assist.ts')).useAssist.getState().status,
      d: (await window.__m('store/drums.ts')).useDrums.getState().status,
    }));
    if (st.a === 'ready' && st.d === 'ready') break;
    await page.waitForTimeout(1000);
  }
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
const clearToasts = (page) => ev(page, async () => (await window.__m('store/editor.ts')).useEditor.setState({ toasts: [] }));
async function waitSpectro(page) {
  for (let i = 0; i < 60; i++) {
    const st = await ev(page, async () => (await window.__m('store/assist.ts')).useAssist.getState().spectroStatus);
    if (st === 'ready' || st === 'done') return;
    await page.waitForTimeout(1000);
  }
}
async function shot(page, name, clip) {
  await clearToasts(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
  console.log('shot', name);
}
const want = (n) => !ONLY || ONLY.has(n);
// 譜面のまわり（左右のパネルと下のトラックを除く）
const CHART_CLIP = { x: 284, y: 104, width: 820, height: 590 };

// ---- PC ----
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('dtxe.lang', 'ja');
    } catch {}
  });
  const page = await ctx.newPage();
  await setup(page);
  page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
  await openSong(page);

  if (want('editor')) {
    // サビの頭（17 小節）。右の列はスペクトル、サビを A–B ループ
    await ev(page, async () => {
      const a = await window.__m('store/assist.ts');
      a.setWaveMode('spec');
    });
    await waitSpectro(page);
    await ev(page, async () => {
      const e = await window.__m('store/editor.ts');
      const a = await window.__m('store/assist.ts');
      a.setLoop({ on: true, a: 68, b: 84 });
      e.setCursorBeat(68);
      e.setView({ pxPerBeat: 44, scrollBeat: 64.5, follow: false });
    });
    await page.waitForTimeout(1500);
    await shot(page, 'editor');
  }

  if (want('tab') || want('gen')) {
    // サビの後半（21〜24 小節）を消して、21 小節の頭だけ書いた所。TAB補完が前のサビから続きを点線で出す
    await ev(page, async () => {
      const e = await window.__m('store/editor.ts');
      const { frac } = await window.__m('dtx/fraction.ts');
      const a = await window.__m('store/assist.ts');
      a.setLoop(null);
      const ids = e.useEditor.getState().doc.chips.filter((c) => c.m >= 21 && c.m <= 24 && c.ch >= 0x11 && c.ch <= 0x1c).map((c) => c.id);
      e.deleteChips(ids);
      // 21 小節は 17 小節と同じに書いた（レーンの番号: LC 0 HH 1 LP 2 SD 3 HT 4 BD 5 LT 6 FT 7 CY 8 RD 9）
      const { voiceLane } = await window.__m('dtx/model.ts');
      const doc = e.useEditor.getState().doc;
      const items = doc.chips
        .filter((c) => c.m === 17 && c.ch >= 0x11 && c.ch <= 0x1c)
        .map((c) => ({ ...voiceLane(c.ch), pos: { m: 21, f: c.f } }))
        .filter((x) => x.lane !== undefined);
      e.placeChips(items);
      e.setCursorBeat(88);
      e.setView({ pxPerBeat: 34, scrollBeat: 83.4, follow: false });
    });
    for (let i = 0; i < 20; i++) {
      const g = await ev(page, async () => !!(await window.__m('store/complete.ts')).visibleGhost());
      if (g) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(800);
    if (want('tab')) await shot(page, 'tab', CHART_CLIP);
  }

  if (want('gen')) {
    // ✨ 小節の生成（22 小節）。キーが無くても「写す」「採譜」の案は出る
    await ev(page, async () => {
      const c = await window.__m('store/complete.ts');
      c.dismissGhost();
      const g = await window.__m('store/measureGen.ts');
      g.openMeasureGen(22);
    });
    await page.waitForTimeout(2500);
    await shot(page, 'gen', CHART_CLIP);
    await ev(page, async () => (await window.__m('store/measureGen.ts')).closeMeasureGen());
  }

  // ---- ほかのページ ----
  const openPage = (p) => ev(page, async (p) => (await window.__m('store/editor.ts')).openPage(p), p);
  const backToChart = () => ev(page, async () => (await window.__m('store/editor.ts')).backToChart());
  for (const p of ['stems', 'tempo', 'songinfo', 'library']) {
    if (!want(p)) continue;
    await openPage(p);
    await page.waitForTimeout(3000);
    await shot(page, p);
    await backToChart();
    await page.waitForTimeout(800);
  }

  if (want('preview')) {
    // DTXMania風の落ちてくるプレビュー（右のパネル）。サビを鳴らしている途中
    await ev(page, async () => {
      const pv = await window.__m('store/preview.ts');
      pv.togglePreview('side');
      const e = await window.__m('store/editor.ts');
      e.setView({ pxPerBeat: 44, follow: true });
      await e.playFrom(17 * 4);
    });
    await page.waitForTimeout(3200);
    await shot(page, 'preview');
    await ev(page, async () => {
      const e = await window.__m('store/editor.ts');
      e.stop();
      (await window.__m('store/preview.ts')).togglePreview('side');
    });
  }

  if (want('velocity')) {
    // ベロシティの編集（V）
    await ev(page, async () => {
      const e = await window.__m('store/editor.ts');
      e.setCursorBeat(20);
      e.setView({ pxPerBeat: 40, scrollBeat: 19, follow: false });
    });
    await page.locator('canvas').first().hover();
    await page.keyboard.press('v');
    await page.waitForTimeout(1200);
    await shot(page, 'velocity');
    await page.keyboard.press('v');
  }

  if (want('fx')) {
    // チップのエフェクト（E）。B メロ（13〜16 小節）でハイカットを開いていき、サビで全開にする
    await ev(page, async () => {
      const fx = await window.__m('store/fx.ts');
      const { frac } = await window.__m('dtx/fraction.ts');
      const e = await window.__m('store/editor.ts');
      fx.openFx(true);
      const id = fx.addCurve('hicut');
      fx.addPoint(id, { m: 13, f: frac(0, 1) }, 400);
      fx.addPoint(id, { m: 15, f: frac(0, 1) }, 1200);
      fx.addPoint(id, { m: 16, f: frac(1, 2) }, 4000);
      fx.addPoint(id, { m: 17, f: frac(0, 1) }, 16000);
      fx.selectPoint(id, 2);
      e.setCursorBeat(13 * 4);
      e.setView({ pxPerBeat: 26, scrollBeat: 49.5, follow: false });
      window.__fxId = id;
    });
    await page.waitForTimeout(4000);
    await shot(page, 'fx');
    await ev(page, async () => {
      const fx = await window.__m('store/fx.ts');
      fx.removeCurve(window.__fxId);
      fx.openFx(false);
    });
    await page.waitForTimeout(1000);
  }

  const touchUi = (mode) => ev(page, async (mode) => (await window.__m('store/device.ts')).setTouchPrefs({ uiMode: mode }), mode);
  if (want('ipad')) {
    // iPad（横 1180×820）。入力パッドのパネル
    await page.setViewportSize({ width: 1180, height: 820 });
    await touchUi('tablet');
    await ev(page, async () => {
      const d = await window.__m('store/device.ts');
      d.openPanelT('pad');
      const e = await window.__m('store/editor.ts');
      e.setCursorBeat(68);
      e.setView({ scrollBeat: 66, follow: false });
    });
    await page.waitForTimeout(2000);
    await shot(page, 'ipad');
  }
  if (want('iphone')) {
    // iPhone（縦 402×874）
    await page.setViewportSize({ width: 402, height: 874 });
    await touchUi('phone');
    await ev(page, async () => {
      const e = await window.__m('store/editor.ts');
      e.setCursorBeat(68);
      e.setView({ scrollBeat: 67, follow: false });
    });
    await page.waitForTimeout(2000);
    await shot(page, 'iphone');
    await ev(page, async () => (await window.__m('store/device.ts')).openPhoneTab('pad'));
    await page.waitForTimeout(1500);
    await shot(page, 'iphone-pad');
  }
  if (want('ipad') || want('iphone')) {
    await touchUi('desktop');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(1000);
  }

  if (want('home')) {
    await ev(page, async () => (await window.__m('store/editor.ts')).goHome());
    await page.waitForTimeout(2500);
    await shot(page, 'home');
  }

  await ctx.close();
}

if (want('ai')) {
  // AI難易度生成。MASTER だけの曲（ほかの難易度は作る）。キーが無いのでルールだけで簡略化した結果
  const { cpSync, rmSync, writeFileSync } = await import('node:fs');
  const only = path.join(path.dirname(SONG), 'Neon Skyline (MASTER only)');
  rmSync(only, { recursive: true, force: true });
  cpSync(SONG, only, { recursive: true });
  for (const f of ['bsc.dtx', 'adv.dtx', 'ext.dtx']) rmSync(path.join(only, f));
  writeFileSync(path.join(only, 'set.def'), '#TITLE Neon Skyline\r\n#L4LABEL MASTER\r\n#L4FILE mstr.dtx\r\n');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('dtxe.lang', 'ja');
    } catch {}
  });
  const page = await ctx.newPage();
  await setup(page);
  await page.goto(URL);
  await page.waitForTimeout(1200);
  await page.locator('input[type=file][webkitdirectory]').first().setInputFiles(only);
  await page.waitForTimeout(3000);
  for (let i = 0; i < 120; i++) {
    const d = await ev(page, async () => (await window.__m('store/drums.ts')).useDrums.getState().status);
    if (d === 'ready') break;
    await page.waitForTimeout(1000);
  }
  await ev(page, async () => (await window.__m('store/editor.ts')).openPage('ai'));
  await page.waitForTimeout(3000);
  await page.locator('button.gen-make-all').click();
  await page.waitForTimeout(12000);
  // ADVANCED を選んで、右に方針と確かめた結果を出す
  await page.getByText('ADVANCED', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await shot(page, 'ai');
  await ctx.close();
}

await browser.close();
