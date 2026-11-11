// README の図（アニメーションつきの SVG）を作る。node scripts/readme/make-svgs.mjs → docs/readme/*.svg
// GitHub の README は <img> で SVG を出すので、スクリプトと外のファイル（フォントも）は使えない。動きは CSS のアニメーションだけ。
// 文字は利用者の手元のフォント（ヒラギノ・游ゴシック・メイリオ・Noto）。動きを減らす設定の人には止めた絵（できあがりの形）を出す。
// 確かめ方: node scripts/readme/frames.mjs <出力先>（いくつかの時刻で止めて PNG にする）
//
// アニメーションの決まり
// - くり返す長さ L の中で「いつ何が起きるか」を秒で書き、keyframes() で % にする。
// - 何度も同じ形で光る物（落ちるチップ・叩いた光）は共通の @keyframes に負の animation-delay（t − L）をつける
//   （正の遅れだと、初めの 1 回が始まるまで止めた絵が見えてしまう）。
// - CSS の transform は SVG の transform 属性を上書きするので、動かす物は位置を決める <g> の内側に置く。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_DEFS, ICON_BEAMS, ICON_DRUM, ICON_HIT, ICON_LANES, MARK_SVG, chipBox, chipPath } from '../icon-art.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(root, 'docs/readme');
mkdirSync(OUT, { recursive: true });

const FONT = `'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic UI','Yu Gothic','Meiryo','Noto Sans JP','Noto Sans CJK JP',system-ui,sans-serif`;
const MONO = `'JetBrains Mono','SF Mono','Cascadia Mono',Consolas,Menlo,monospace`;
const C = {
  text: '#E8EEF6',
  sub: '#93A1B3',
  dim: '#5E6B7C',
  line: '#223044',
  card: '#121A26',
  card2: '#0E141D',
  accent: '#4CC2FF',
  purple: '#9C84E0',
  amber: '#FFB547',
  green: '#5BD69A',
  red: '#FF6B6B',
};
// レーンの色（src/dtx/model.ts の DRUM_LANES と同じ）
const LANE = { LC: '#FF5C8A', HH: '#4FC3F7', HHO: '#C9CFD6', LP: '#F48FB1', SD: '#FFD54F', HT: '#66BB6A', BD: '#9C84E0', LT: '#EF5350', FT: '#FF9800', CY: '#42A5F5', RD: '#80DEEA' };
const LANES10 = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY', 'RD'];
// 原曲の打点の色（src/ui/ChartCanvas.tsx の DRUM_COL と同じ）
const HIT = { BD: '#B9A6F2', SD: '#FFD54F', TT: '#7BD88F', HH: '#7FD3F9', CY: '#FF8FB3' };
const HIT_OF = { LC: 'CY', HH: 'HH', HHO: 'HH', LP: null, SD: 'SD', HT: 'TT', BD: 'BD', LT: 'TT', FT: 'TT', CY: 'CY', RD: 'CY' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const p2 = (x) => `${(Math.round(x * 100) / 100).toString()}`;
const pc = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(3).replace(/\.?0+$/, '')}%`;

/** 1 枚の SVG */
function doc({ w, h, title, desc, css = '', defs = '', body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<style>
text{font-family:${FONT}}
.mono{font-family:${MONO}}
.fb{transform-box:fill-box;transform-origin:50% 50%}
.fl{transform-box:fill-box;transform-origin:0 50%}
${css}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<defs>${defs}</defs>
${body}
</svg>
`;
}

/** @keyframes。frames は [秒, CSS] の並び（L はくり返しの長さ） */
const keyframes = (name, L, frames) => `@keyframes ${name}{${frames.map(([t, css]) => `${pc(t / L)}{${css}}`).join('')}}`;
/** 不透明度だけの @keyframes */
const opKf = (name, L, frames) => keyframes(name, L, frames.map(([t, o]) => [t, `opacity:${o}`]));

/** 暗いカードの地（全体） */
const cardDefs = (id = 'bg') =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0B1018"/><stop offset="1" stop-color="#131C2A"/></linearGradient>`;
const card = (w, h, id = 'bg') => `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="20" fill="url(#${id})" stroke="#223044"/>`;

/** 文字の幅のめやす（全角 1、英大文字・数字 0.66、小文字 0.56、空白 0.3） */
function tw(s, size) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80) w += 1;
    else if (ch === ' ') w += 0.3;
    else if (/[il.,:;'|!()]/.test(ch)) w += 0.32;
    else if (/[mwMW]/.test(ch)) w += 0.86;
    else if (/[A-Z0-9+]/.test(ch)) w += 0.66;
    else w += 0.56;
  }
  return w * size;
}

/** 複数行の文字 */
function text(x, y, lines, { size = 15, lh = 1.55, fill = C.text, weight, anchor = 'start', cls = '', ls, op } = {}) {
  const arr = Array.isArray(lines) ? lines : [lines];
  return `<text x="${p2(x)}" y="${p2(y)}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${cls ? ` class="${cls}"` : ''}${ls ? ` letter-spacing="${ls}"` : ''}${op !== undefined ? ` opacity="${op}"` : ''}>${arr
    .map((s, i) => `<tspan x="${p2(x)}"${i ? ` dy="${p2(size * lh)}"` : ''}>${esc(s)}</tspan>`)
    .join('')}</text>`;
}

/** 角丸の札 */
function pill(x, y, label, { color = C.accent, size = 14, pad = 12, h = 30, w } = {}) {
  const width = w ?? Math.round(tw(label, size) + pad * 2 + 14);
  return `<g transform="translate(${p2(x)} ${p2(y)})"><rect width="${width}" height="${h}" rx="${h / 2}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-opacity="0.45"/><circle cx="${pad + 4}" cy="${h / 2}" r="4" fill="${color}"/>${text(pad + 14, h / 2 + size * 0.36, label, { size, fill: C.text })}</g>`;
}

/** キー（押すと沈む。押す動きは cls で内側の <g> に付ける） */
function keycap(x, y, label, { w, h = 30, size = 14, cls = '' } = {}) {
  const width = w ?? Math.round(Math.max(h, tw(label, size) + 22));
  return {
    w: width,
    svg: `<g transform="translate(${p2(x)} ${p2(y)})"><rect y="3.5" width="${width}" height="${h}" rx="7" fill="#04070B"/><g${cls ? ` class="${cls}"` : ''}><rect width="${width}" height="${h}" rx="7" fill="#1E2A3C" stroke="#41536E"/><rect x="1.5" y="1.5" width="${width - 3}" height="${h / 2}" rx="6" fill="#fff" fill-opacity="0.05"/>${text(width / 2, h / 2 + size * 0.37, label, { size, anchor: 'middle', cls: 'mono', weight: 700, fill: '#DCE7F3' })}</g></g>`,
  };
}

/** バッジ（丸に数字） */
const badge = (x, y, n, color = C.accent, r = 13) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.7"/>${text(x, y + r * 0.42, String(n), { size: r * 1.15, anchor: 'middle', weight: 700, fill: color })}`;

/** チップ（譜面の 1 打） */
const chip = (x, y, w, h, color, attrs = '') => `<rect x="${p2(x)}" y="${p2(y)}" width="${p2(w)}" height="${p2(h)}" rx="${p2(Math.min(3, h / 2.4))}" fill="${color}"${attrs}/>`;
/** HHオープンのチップ（シルバーに黒い点） */
const chipHHO = (x, y, w, h, attrs = '') => `<g${attrs}>${chip(x, y, w, h, LANE.HHO)}<circle cx="${p2(x + w / 2)}" cy="${p2(y + h / 2)}" r="${p2(h * 0.26)}" fill="#1B2330"/></g>`;
/** 点線のチップ（TAB補完の案・削ったチップ） */
const ghost = (x, y, w, h, color, attrs = '', fillOp = 0.16) =>
  `<rect x="${p2(x + 0.6)}" y="${p2(y + 0.6)}" width="${p2(w - 1.2)}" height="${p2(h - 1.2)}" rx="${p2(Math.min(3, h / 2.4))}" fill="${color}" fill-opacity="${fillOp}" stroke="${color}" stroke-width="1.2" stroke-dasharray="3 2"${attrs}/>`;

/** 波形（上下対称の面）。amp(t) は 0〜1 */
function wavePath(x, y, w, h, amp, n = 160, vertical = false) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = Math.max(0.02, Math.min(1, amp(t))) * (vertical ? w : h) * 0.5;
    pts.push([t, a]);
  }
  if (vertical) {
    const cx = x + w / 2;
    const top = pts.map(([t, a]) => `${p2(cx + a)} ${p2(y + h - t * h)}`);
    const bot = [...pts].reverse().map(([t, a]) => `${p2(cx - a)} ${p2(y + h - t * h)}`);
    return `M${top.join(' L')} L${bot.join(' L')} Z`;
  }
  const cy = y + h / 2;
  const top = pts.map(([t, a]) => `${p2(x + t * w)} ${p2(cy - a)}`);
  const bot = [...pts].reverse().map(([t, a]) => `${p2(x + t * w)} ${p2(cy + a)}`);
  return `M${top.join(' L')} L${bot.join(' L')} Z`;
}
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
/** 打点の並び → 波形の大きさ（0〜1）。hits は [時刻 0〜1, 強さ, 減り方] */
const envelope = (hits, base = 0.16, noise = 0.08) => {
  const nz = Array.from({ length: 400 }, () => rnd());
  return (t) => {
    let a = base + nz[Math.floor(t * 399)] * noise;
    for (const [h, g, d] of hits) if (t >= h) a = Math.max(a, g * Math.exp(-(t - h) / d) + nz[Math.floor(t * 399)] * noise);
    return a;
  };
};

/** アプリのロゴ（小さい版）を中に入れる */
const markInner = MARK_SVG.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const files = {};

// =====================================================================================
// 1. 看板（hero）: 左に名前と一言、右にアイコンの絵（スネアへチップが降りてくる）
// =====================================================================================
{
  const W = 960;
  const H = 420;
  const BAR = 2.4; // 1 小節（100 BPM）
  const TRAVEL = 1.8; // 奥からヘッドまで
  // 1 小節の 8 分（0〜7）: [レーン, 8 分の位置]
  const pattern = [
    [0, 0], [3, 0],
    [1, 1],
    [1, 2], [2, 2],
    [1, 3], [3, 3],
    [1, 4], [3, 4], [4, 4],
    [1, 5],
    [1, 6], [2, 6],
    [1, 7], [3, 7.5],
  ];
  const steps = 12;
  const kf = ICON_LANES.map((_, li) => {
    const base = chipBox(li, 0);
    const frames = [];
    for (let k = 0; k <= steps; k++) {
      const u = 1 - k / steps; // 奥（1）→ ヘッド（0）
      const b = chipBox(li, u);
      const t = (k / steps) * (TRAVEL / BAR);
      frames.push(`${pc(t)}{transform:translate(${p2(b.cx - base.cx)}px,${p2(b.cy - base.cy)}px) scale(${p2(b.w / base.w)},${p2(b.h / base.h)})}`);
    }
    const end = TRAVEL / BAR;
    return `@keyframes hl${li}{${frames.join('')}${pc(end + 0.0001)}{transform:translate(0,0) scale(1,1)}100%{transform:translate(0,0) scale(1,1)}}`;
  });
  const fadeKf = `@keyframes hf{0%{opacity:0}${pc(0.12)}{opacity:1}${pc(TRAVEL / BAR - 0.005)}{opacity:1}${pc(TRAVEL / BAR + 0.03)}{opacity:0}100%{opacity:0}}`;
  const chips = pattern.map(([li, e], i) => {
    const hit = (e / 8) * BAR; // ヘッドに当たる時刻
    const delay = hit - TRAVEL - BAR; // 負の遅れ（初めから回っている形）
    const base = chipBox(li, 0);
    // 止めた絵（動きを減らす設定）では、時刻 0 の位置に置く
    const until = ((hit % BAR) + BAR) % BAR;
    const u = Math.min(1, until / TRAVEL);
    const b = chipBox(li, u);
    const still = until <= TRAVEL ? `transform:translate(${p2(b.cx - base.cx)}px,${p2(b.cy - base.cy)}px) scale(${p2(b.w / base.w)},${p2(b.h / base.h)})` : 'opacity:0';
    return {
      css: `.hc${i}{animation:hl${li} ${BAR}s linear ${p2(delay)}s infinite,hf ${BAR}s linear ${p2(delay)}s infinite;${still}}`,
      el: `<g class="hc hc${i}"><path d="${chipPath(li, 0)}" fill="${ICON_LANES[li].color}"/><path d="${chipPath(li, 0)}" fill="url(#ic-gloss)"/></g>`,
    };
  });
  // ヘッドが光る（スネア・バスドラムの所）
  const hits = [...new Set(pattern.filter(([li]) => li === 2 || li === 3).map(([, e]) => e))];
  const hitKf = `@keyframes hh{0%{opacity:0.25}${hits
    .map((e) => {
      const t = (e / 8) * BAR;
      return `${pc(t / BAR)}{opacity:1}${pc(t / BAR + 0.07)}{opacity:0.25}`;
    })
    .join('')}100%{opacity:0.25}}`;
  const css = `
.hc{transform-box:fill-box;transform-origin:50% 50%}
${kf.join('\n')}
${fadeKf}
${hitKf}
.hit{animation:hh ${BAR}s linear 0s infinite}
@keyframes glow{0%,100%{opacity:.55}50%{opacity:.9}}
.glowa{animation:glow 4.8s ease-in-out infinite}
${chips.map((c) => c.css).join('\n')}
`;
  const defs = `${cardDefs()}${ICON_DEFS.replace(/^<defs>|<\/defs>$/g, '')}
<radialGradient id="g1" cx="0.8" cy="0.72" r="0.48"><stop offset="0" stop-color="#4CC2FF" stop-opacity="0.26"/><stop offset="1" stop-color="#4CC2FF" stop-opacity="0"/></radialGradient>
<radialGradient id="g2" cx="0.1" cy="0.08" r="0.55"><stop offset="0" stop-color="#9C84E0" stop-opacity="0.2"/><stop offset="1" stop-color="#9C84E0" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#FFFFFF" stroke-opacity="0.035"/></pattern>
<clipPath id="clipCard"><rect width="${W}" height="${H}" rx="20"/></clipPath>`;
  const pills = [
    ['耳コピのアシスト', LANE.HH],
    ['TAB補完', LANE.SD],
    ['AI難易度生成', C.amber],
    ['NX でそのまま遊べる', LANE.BD],
  ];
  let px = 48;
  const pillEls = pills
    .map(([l, c]) => {
      const w = Math.round(tw(l, 14) + 40);
      const el = pill(px, 266, l, { color: c, w });
      px += w + 10;
      return el;
    })
    .join('');
  const body = `${card(W, H)}
<g clip-path="url(#clipCard)">
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#g1)" class="glowa"/>
  <rect width="${W}" height="${H}" fill="url(#g2)"/>
  <g transform="translate(580 8) scale(0.78)">
    ${ICON_BEAMS}
    <g>${chips.map((c) => c.el).join('')}</g>
    ${ICON_DRUM}
    <g class="hit">${ICON_HIT}</g>
  </g>
</g>
${text(48, 122, 'DTX Web Editor', { size: 50, weight: 700, ls: '0.5' })}
${text(50, 172, '原曲を聴きながら、ブラウザでドラム譜面を作る。', { size: 22, fill: '#CFE3F5' })}
${text(50, 213, ['DTXManiaNX 向けの、無料のドラム譜面エディタ。', 'インストールなしで、PC・iPad・iPhone から。'], { size: 15.5, fill: C.sub, lh: 1.6 })}
${pillEls}
<g transform="translate(50 330)">${LANES10.map((k, i) => `<rect x="${i * 26}" y="0" width="22" height="7" rx="3.5" fill="${LANE[k]}"/>`).join('')}</g>
${text(50 + 10 * 26 + 10, 337, '10 レーン・4 シンバル対応', { size: 13, fill: C.sub })}
`;
  files['hero.svg'] = doc({ w: W, h: H, title: 'DTX Web Editor', desc: '原曲を聴きながら、ブラウザでドラム譜面を作る DTXManiaNX 向けのエディタ。スネアのヘッドへ、レーンを降りてくるチップのアニメーション。', css, defs, body });
}

// =====================================================================================
// 2. 「ブラウザで開く」のボタン
// =====================================================================================
{
  const W = 300;
  const H = 60;
  const css = `@keyframes shine{0%,55%{transform:translateX(-140px)}85%,100%{transform:translateX(${W + 40}px)}}.shine{animation:shine 4.5s ease-in-out infinite}`;
  const defs = `<linearGradient id="bt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5CCBFF"/><stop offset="1" stop-color="#8E7CF0"/></linearGradient>
<linearGradient id="sh" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="bc"><rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="${(H - 4) / 2}"/></clipPath>`;
  const body = `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="${(H - 4) / 2}" fill="url(#bt)"/>
<g clip-path="url(#bc)"><rect class="shine" x="0" y="0" width="90" height="${H}" fill="url(#sh)" transform="skewX(-20)"/></g>
<circle cx="40" cy="${H / 2}" r="15" fill="#07131D" fill-opacity="0.85"/><path d="M35.5 ${H / 2 - 7} L47 ${H / 2} L35.5 ${H / 2 + 7} Z" fill="#7FD6FF"/>
${text(66, H / 2 + 7.5, 'ブラウザで開く', { size: 21, weight: 700, fill: '#06121B' })}
<rect x="228" y="${H / 2 - 12}" width="48" height="24" rx="12" fill="#06121B" fill-opacity="0.82"/>
${text(252, H / 2 + 4.6, '無料', { size: 13, weight: 700, fill: '#8FDCFF', anchor: 'middle' })}`;
  files['open.svg'] = doc({ w: W, h: H, title: 'ブラウザで開く（無料）', desc: 'DTX Web Editor を開くボタン', css, defs, body });
}

// =====================================================================================
// 3. はじめかた: 開く → 曲を入れる → 書いて保存（カードを順に光らせ、それぞれの中で小さく動かす）
// =====================================================================================
{
  const W = 960;
  const H = 272;
  const L = 9;
  const seg = L / 3;
  const CW = 296;
  const CH = 232;
  const xs = [20, 332, 644];
  const css = [];
  // 枠の光（いまの手順）
  const hl = [
    [[0, 1], [seg - 0.05, 1], [seg + 0.25, 0], [L - 0.3, 0], [L, 1]],
    [[0, 0], [seg, 0], [seg + 0.3, 1], [2 * seg - 0.05, 1], [2 * seg + 0.25, 0], [L, 0]],
    [[0, 0], [2 * seg, 0], [2 * seg + 0.3, 1], [L - 0.3, 1], [L, 0]],
  ];
  hl.forEach((fr, i) => {
    css.push(opKf(`sh${i}`, L, fr));
    css.push(`.sh${i}{opacity:0;animation:sh${i} ${L}s linear infinite}`);
  });

  // ---- 1. ブラウザで開く ----
  css.push(
    keyframes('ptr', L, [
      [0, 'transform:translate(150px,30px);opacity:0'],
      [0.3, 'opacity:1'],
      [1.0, 'transform:translate(0,0)'],
      [1.12, 'transform:translate(0,0) scale(0.88)'],
      [1.3, 'transform:translate(0,0) scale(1)'],
      [L - 0.4, 'transform:translate(0,0);opacity:1'],
      [L - 0.1, 'transform:translate(0,0);opacity:0'],
      [L, 'transform:translate(150px,30px);opacity:0'],
    ]),
    `.ptr{animation:ptr ${L}s ease-out infinite;transform-box:fill-box;transform-origin:0 0}`,
    keyframes('rip', L, [
      [0, 'transform:scale(0.3);opacity:0'],
      [1.08, 'transform:scale(0.3);opacity:0.9'],
      [1.6, 'transform:scale(1.9);opacity:0'],
      [L, 'transform:scale(1.9);opacity:0'],
    ]),
    `.rip{opacity:0;animation:rip ${L}s ease-out infinite}`,
    opKf('tsel', L, [[0, 0], [1.1, 0], [1.25, 1], [L - 0.3, 1], [L - 0.05, 0], [L, 0]]),
    `.tsel{animation:tsel ${L}s linear infinite}`,
  );
  const tile = (x, label, icon) =>
    `<g transform="translate(${x} 70)"><rect width="66" height="44" rx="6" fill="#141E2C" stroke="#2A3850"/>${icon}${text(33, 37, label, { size: 9, anchor: 'middle', fill: C.sub })}</g>`;
  const noteIcon = `<path d="M30 8 v12.5 a3.6 3.6 0 1 1 -2 -3.2 V10 l9 -2.4 v3 z" fill="${C.accent}"/>`;
  const folderIcon = `<path d="M24 11 h6 l2 2.5 h10 v12 h-18 z" fill="${C.amber}" fill-opacity="0.85"/>`;
  const fileIcon = `<path d="M27 8 h9 l4 4 v14 h-13 z" fill="none" stroke="${C.sub}" stroke-width="1.5"/>`;
  const ill1 = `<rect x="28" y="22" width="240" height="104" rx="8" fill="#0F1621" stroke="#2A3850"/>
<path d="M28 30 a8 8 0 0 1 8 -8 h224 a8 8 0 0 1 8 8 v10 h-240 z" fill="#1A2434"/>
<circle cx="38" cy="31" r="2.6" fill="#FF5F57"/><circle cx="47" cy="31" r="2.6" fill="#FEBC2E"/><circle cx="56" cy="31" r="2.6" fill="#28C840"/>
<rect x="66" y="25.5" width="194" height="11" rx="5.5" fill="#0A0F16"/>${text(73, 33.6, 'check5004.github.io/dtx-mania-web-editor', { size: 7.4, cls: 'mono', fill: C.sub })}
<g transform="translate(37 46) scale(0.22)">${markInner.replace(/mk-/g, 's1-')}</g>${text(55, 57, 'DTX Web Editor', { size: 9, weight: 700 })}
${tile(37, '原曲から', noteIcon)}${tile(109, '曲フォルダ', folderIcon)}${tile(181, '空の譜面', fileIcon)}
<rect class="tsel" x="37" y="70" width="66" height="44" rx="6" fill="${C.accent}" fill-opacity="0.14" stroke="${C.accent}" stroke-width="1.6"/>
<g transform="translate(92 100)"><circle class="rip fb" r="12" fill="none" stroke="${C.accent}" stroke-width="2"/></g>
<g transform="translate(92 100)"><g class="ptr"><path d="M0 0 L0 15 L4 11.4 L6.8 17.6 L9.3 16.5 L6.6 10.4 L11.6 10.4 Z" fill="#fff" stroke="#0B0F15" stroke-width="1.2" stroke-linejoin="round"/></g></g>`;

  // ---- 2. 曲を入れる ----
  const t2 = seg;
  css.push(
    keyframes('file', L, [
      [0, 'transform:translate(110px,-64px);opacity:0'],
      [t2 + 0.1, 'transform:translate(110px,-64px);opacity:0'],
      [t2 + 0.35, 'opacity:1'],
      [t2 + 1.0, 'transform:translate(0,0) scale(1)'],
      [t2 + 1.15, 'transform:translate(0,0) scale(0.9);opacity:1'],
      [t2 + 1.35, 'transform:translate(0,0) scale(0.9);opacity:0'],
      [L, 'transform:translate(0,0) scale(0.9);opacity:0'],
    ]),
    `.file{opacity:0;animation:file ${L}s ease-in-out infinite}`,
    opKf('dlab', L, [[0, 1], [t2 + 1.0, 1], [t2 + 1.2, 0], [L - 0.2, 0], [L, 1]]),
    `.dlab{opacity:0;animation:dlab ${L}s linear infinite}`,
    opKf('dhov', L, [[0, 0], [t2 + 0.5, 0], [t2 + 0.8, 1], [t2 + 1.3, 1], [t2 + 1.6, 0.45], [L - 0.3, 0.45], [L, 0]]),
    `.dhov{opacity:0.45;animation:dhov ${L}s linear infinite}`,
    keyframes('wv', L, [
      [0, 'transform:scaleX(0);opacity:1'],
      [t2 + 1.3, 'transform:scaleX(0);opacity:1'],
      [t2 + 2.1, 'transform:scaleX(1)'],
      [L - 0.5, 'transform:scaleX(1);opacity:1'],
      [L - 0.25, 'transform:scaleX(1);opacity:0'],
      [L, 'transform:scaleX(0);opacity:0'],
    ]),
    `.wv{animation:wv ${L}s ease-out infinite}`,
    opKf('wcap', L, [[0, 0], [t2 + 1.5, 0], [t2 + 1.8, 1], [L - 0.5, 1], [L - 0.25, 0], [L, 0]]),
    `.wcap{animation:wcap ${L}s linear infinite}`,
  );
  const wv2 = wavePath(44, 50, 208, 58, envelope(Array.from({ length: 28 }, (_, i) => [i / 28, i % 4 === 0 ? 0.95 : i % 2 ? 0.45 : 0.75, 0.012]), 0.22, 0.12), 220);
  const ill2 = `<rect x="30" y="22" width="236" height="104" rx="10" fill="#0D141E" stroke="#3A4A61" stroke-dasharray="5 4"/>
<rect class="dhov" x="30" y="22" width="236" height="104" rx="10" fill="${C.accent}" fill-opacity="0.06" stroke="${C.accent}" stroke-width="1.6"/>
<g class="dlab">${text(148, 82, 'ここにドロップ', { size: 12, anchor: 'middle', fill: C.dim })}<path d="M148 50 v14 m-6 -6 l6 6 l6 -6" fill="none" stroke="${C.dim}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>
<g class="wv fl"><path d="${wv2}" fill="url(#s2w)"/></g>
<g class="wcap">${text(44, 40, 'BGM: song.mp3 → 新しい譜面', { size: 9.5, fill: C.sub })}</g>
<g transform="translate(98 62)"><g class="file fb"><rect width="100" height="30" rx="6" fill="#1C2738" stroke="#4A5E7E"/>${text(16, 21, '♪', { size: 15, fill: C.accent, anchor: 'middle' })}${text(28, 19.5, 'song.mp3', { size: 11, cls: 'mono', fill: C.text })}</g></g>`;

  // ---- 3. 書いて保存 ----
  const t3 = 2 * seg;
  const lanes3 = ['HH', 'SD', 'HT', 'BD', 'CY'];
  const pat3 = [[0, 'CY'], [0, 'BD'], [1, 'HH'], [2, 'HH'], [2, 'SD'], [3, 'HH'], [3, 'BD'], [4, 'HH'], [4, 'BD'], [5, 'HH'], [6, 'HH'], [6, 'SD'], [7, 'HT']];
  const lx = (k) => 34 + lanes3.indexOf(k) * 22;
  const ly = (s) => 116 - s * 11.2;
  const chips3 = pat3
    .map(([s, k], i) => {
      const t = t3 + 0.12 + i * 0.075;
      css.push(opKf(`c3${i}`, L, [[0, 0], [t, 0], [t + 0.06, 1], [L - 0.25, 1], [L, 0]]));
      return chip(lx(k) + 2, ly(s) - 3, 18, 6, LANE[k], ` style="animation:c3${i} ${L}s linear infinite"`);
    })
    .join('');
  const kCtrl = keycap(172, 30, 'Ctrl', { w: 46, h: 26, size: 11.5, cls: 'kp3' });
  const kS = keycap(236, 30, 'S', { w: 28, h: 26, size: 11.5, cls: 'kp3' });
  css.push(
    keyframes('kp3', L, [
      [0, 'transform:translateY(0)'],
      [t3 + 1.25, 'transform:translateY(0)'],
      [t3 + 1.32, 'transform:translateY(3px)'],
      [t3 + 1.55, 'transform:translateY(3px)'],
      [t3 + 1.65, 'transform:translateY(0)'],
      [L, 'transform:translateY(0)'],
    ]),
    `.kp3{animation:kp3 ${L}s linear infinite}`,
    keyframes('fold', L, [
      [0, 'transform:scale(0.6);opacity:0'],
      [t3 + 1.55, 'transform:scale(0.6);opacity:0'],
      [t3 + 1.8, 'transform:scale(1.08);opacity:1'],
      [t3 + 1.95, 'transform:scale(1);opacity:1'],
      [L - 0.25, 'transform:scale(1);opacity:1'],
      [L, 'transform:scale(1);opacity:0'],
    ]),
    `.fold{animation:fold ${L}s ease-out infinite}`,
  );
  const ill3 = `<g>${lanes3.map((k, i) => `<rect x="${34 + i * 22}" y="24" width="22" height="100" fill="${i % 2 ? '#0F1620' : '#0C121B'}"/>`).join('')}
<line x1="34" x2="144" y1="120" y2="120" stroke="#3A4A61"/><line x1="34" x2="144" y1="30.4" y2="30.4" stroke="#3A4A61"/>
${[1, 2, 3].map((b) => `<line x1="34" x2="144" y1="${p2(120 - b * 22.4)}" y2="${p2(120 - b * 22.4)}" stroke="#1C2736"/>`).join('')}</g>
${chips3}
${text(198, 22, '保存', { size: 0.1, fill: 'none' })}
${kCtrl.svg}${text(226, 47.5, '+', { size: 13, anchor: 'middle', fill: C.sub })}${kS.svg}
<g transform="translate(188 74)"><g class="fold fb"><path d="M0 6 a4 4 0 0 1 4 -4 h14 l5 5 h25 a4 4 0 0 1 4 4 v23 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z" fill="${C.amber}" fill-opacity="0.9"/><circle cx="50" cy="31" r="9" fill="${C.green}"/><path d="M45.5 31 l3 3 l6 -6.5" fill="none" stroke="#06121B" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${text(25, 54, '曲フォルダ', { size: 9.5, anchor: 'middle', fill: C.sub })}</g></g>`;

  const cards = [
    { ill: ill1, title: 'ブラウザで開く', desc: ['インストールも登録もいりません。', 'PC は Chrome か Edge がおすすめ。'] },
    { ill: ill2, title: '曲を入れる', desc: ['原曲の MP3・WAV・動画をドロップ。', 'DTX の曲フォルダも開けます。'] },
    { ill: ill3, title: '書いて保存', desc: ['Ctrl+S で曲フォルダへ。', 'DTXManiaNX でそのまま遊べます。'] },
  ];
  const body = cards
    .map(
      (c, i) => `<g transform="translate(${xs[i]} 20)">
<rect width="${CW}" height="${CH}" rx="16" fill="url(#bg)" stroke="#223044"/>
<rect class="sh${i}" x="1" y="1" width="${CW - 2}" height="${CH - 2}" rx="15" fill="none" stroke="${C.accent}" stroke-width="2"/>
<rect x="14" y="14" width="${CW - 28}" height="120" rx="12" fill="#0A0F16" stroke="#1B2636"/>
${c.ill}
${badge(30, 165, i + 1)}
${text(52, 171, c.title, { size: 18, weight: 700 })}
${text(18, 200, c.desc, { size: 13, fill: C.sub, lh: 1.62 })}
</g>`,
    )
    .join('\n');
  const defs = `${cardDefs()}<linearGradient id="s2w" x1="0" x2="1"><stop offset="0" stop-color="#4CC2FF"/><stop offset="1" stop-color="#9C84E0"/></linearGradient>`;
  files['steps.svg'] = doc({ w: W, h: H, title: 'はじめかた', desc: '1. ブラウザで開く 2. 曲（原曲の音声か DTX の曲フォルダ）を入れる 3. 書いて保存すると DTXManiaNX でそのまま遊べる。', css: css.join('\n'), defs, body });
}

// =====================================================================================
// 4. 耳コピの流れ: 再生すると、原曲の波形・採譜 AI の打点に合わせて譜面が埋まっていく
// =====================================================================================
{
  const W = 960;
  const H = 430;
  const L = 7.2;
  const T0 = 0.5;
  const PLAY = 4.8; // 2 小節（100 BPM）
  const top = 74;
  const bot = 404;
  const span = bot - top;
  const stepH = span / 32;
  const yOf = (s) => bot - s * stepH;
  const tOf = (s) => T0 + (s / 32) * PLAY;
  const LX = 40;
  const LW = 24; // 10 レーン → 40..280
  const OX = 300;
  const OW = 22; // 打点の 5 列 → 300..410
  const WX = 428;
  const WW = 100; // 波形 → 428..528
  // 2 小節の 16 分（0〜31）。最後の拍はフィル
  const ev = [];
  const add = (s, ...ks) => ks.forEach((k) => ev.push([s, k]));
  add(0, 'CY', 'BD');
  for (const s of [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26]) add(s, 'HH');
  add(4, 'SD'); add(12, 'SD'); add(20, 'SD');
  add(6, 'BD'); add(8, 'BD'); add(11, 'BD'); add(16, 'BD'); add(22, 'BD'); add(24, 'BD');
  add(28, 'SD'); add(29, 'HT'); add(30, 'LT'); add(31, 'FT');
  // 採譜の打点（ほぼ譜面どおり、弱い物と聞き間違いも少し）
  const onsets = ev.map(([s, k]) => [s, HIT_OF[k], k === 'HH' ? 0.9 : k === 'LT' || k === 'FT' ? 0.7 : 1]).filter(([, c]) => c);
  onsets.push([15, 'HH', 0.35], [27, 'SD', 0.3]);
  const OCLS = ['BD', 'SD', 'TT', 'HH', 'CY'];
  const css = [];
  // 再生位置の線
  css.push(
    keyframes('ph', L, [
      [0, `transform:translateY(0);opacity:0`],
      [T0 - 0.25, 'transform:translateY(0);opacity:1'],
      [T0, 'transform:translateY(0)'],
      [T0 + PLAY, `transform:translateY(${-span}px);opacity:1`],
      [T0 + PLAY + 0.3, `transform:translateY(${-span}px);opacity:0`],
      [L, `transform:translateY(${-span}px);opacity:0`],
    ]),
    `.ph{animation:ph ${L}s linear infinite;transform:translateY(${-span * 0.55}px)}`,
    // 打点が光る（共通の形に負の遅れ）
    `@keyframes fl{0%{opacity:1}5%{opacity:0}100%{opacity:0}}`,
    `.fl1{opacity:0;animation:fl ${L}s ease-out infinite}`,
  );
  // 行（同じ時刻）ごとに、チップが現れる
  const rows = [...new Set(ev.map(([s]) => s))].sort((a, b) => a - b);
  for (const s of rows) {
    const t = tOf(s);
    css.push(
      keyframes(`r${s}`, L, [
        [0, 'opacity:0;transform:scale(1.7)'],
        [t - 0.01, 'opacity:0;transform:scale(1.7)'],
        [t + 0.16, 'opacity:1;transform:scale(1)'],
        [L - 0.55, 'opacity:1;transform:scale(1)'],
        [L - 0.2, 'opacity:0;transform:scale(1)'],
        [L, 'opacity:0;transform:scale(1.7)'],
      ]),
    );
  }
  const chipEls = ev
    .map(([s, k]) => {
      const x = LX + LANES10.indexOf(k) * LW + 2;
      const y = yOf(s) - 4;
      return chip(x, y, LW - 4, 8, LANE[k], ` class="fb" style="animation:r${s} ${L}s ease-out infinite"`);
    })
    .join('');
  const onsetEls = onsets
    .map(([s, c, a]) => {
      const x = OX + OCLS.indexOf(c) * OW + 5;
      const y = yOf(s) - 2.5;
      return `<rect x="${p2(x)}" y="${p2(y)}" width="${OW - 10}" height="5" rx="1.5" fill="${HIT[c]}" opacity="${a}"/>`;
    })
    .join('');
  const flashEls = onsets
    .filter(([, , a]) => a > 0.5)
    .map(([s, c]) => {
      const x = OX + OCLS.indexOf(c) * OW + OW / 2;
      const y = yOf(s);
      return `<ellipse class="fl1" cx="${p2(x)}" cy="${p2(y)}" rx="12" ry="7" fill="${HIT[c]}" style="animation-delay:${p2(tOf(s) - L)}s" filter="url(#ef-blur)"/>`;
    })
    .join('');
  // 波形（打点の強さから）
  const wHits = ev.map(([s, k]) => [s / 32, k === 'BD' ? 0.95 : k === 'SD' ? 0.85 : k === 'CY' ? 1 : k === 'HH' ? 0.42 : 0.75, k === 'CY' ? 0.09 : k === 'HH' ? 0.01 : 0.022]);
  const wave = wavePath(WX + 4, top, WW - 8, span, envelope(wHits, 0.22, 0.16), 330, true);
  const grid = [];
  for (let b = 0; b <= 8; b++) {
    const y = bot - b * (span / 8);
    grid.push(`<line x1="${LX}" x2="${WX + WW}" y1="${p2(y)}" y2="${p2(y)}" stroke="${b % 4 === 0 ? '#3A4A61' : '#1A2433'}" stroke-width="${b % 4 === 0 ? 1.2 : 1}"/>`);
  }
  const laneBg = LANES10.map((k, i) => `<rect x="${LX + i * LW}" y="${top}" width="${LW}" height="${span}" fill="${i % 2 ? '#0E141D' : '#0B1018'}"/>`).join('');
  const onBg = OCLS.map((k, i) => `<rect x="${OX + i * OW}" y="${top}" width="${OW}" height="${span}" fill="${i % 2 ? '#0E141D' : '#0B1018'}"/>`).join('');
  const right = 560;
  const step = (n, y, title, lines) => `${badge(right + 14, y - 6, n)}${text(right + 38, y, title, { size: 17, weight: 700 })}${text(right + 38, y + 25, lines, { size: 13.5, fill: C.sub, lh: 1.6 })}`;
  const body = `${card(W, H)}
${text(LX, 36, '譜面', { size: 13.5, weight: 700 })}${text(OX, 36, '原曲の打点', { size: 13.5, weight: 700 })}${text(WX, 36, '原曲の波形', { size: 13.5, weight: 700 })}
${LANES10.map((k, i) => text(LX + i * LW + LW / 2, 60, k, { size: 10, anchor: 'middle', fill: LANE[k], weight: 700, cls: 'mono' })).join('')}
${OCLS.map((k, i) => text(OX + i * OW + OW / 2, 60, k, { size: 9.5, anchor: 'middle', fill: HIT[k], weight: 700, cls: 'mono' })).join('')}
${laneBg}${onBg}<rect x="${WX}" y="${top}" width="${WW}" height="${span}" fill="#0B1018"/>
${grid.join('')}
${text(LX + 4, bot - 5, '017', { size: 9.5, fill: C.dim, cls: 'mono' })}${text(LX + 4, bot - span / 2 - 5, '018', { size: 9.5, fill: C.dim, cls: 'mono' })}
<path d="${wave}" fill="#8796AD" fill-opacity="0.85"/>
${onsetEls}
${flashEls}
${chipEls}
<g class="ph"><line x1="${LX - 8}" x2="${WX + WW}" y1="${bot}" y2="${bot}" stroke="${C.accent}" stroke-width="2"/><path d="M${LX - 14} ${bot - 6} L${LX - 6} ${bot} L${LX - 14} ${bot + 6} Z" fill="${C.accent}"/><rect x="${LX}" y="${bot - 9}" width="${WX + WW - LX}" height="18" fill="${C.accent}" opacity="0.08"/></g>
<line x1="${right - 18}" x2="${right - 18}" y1="40" y2="${H - 40}" stroke="#1E2A3B"/>
${step(1, 80, 'ゆっくり・くり返し聴く', ['A–B ループ、スロー（25〜75%）、', '低・中・高の帯域だけを聴く'])}
${step(2, 186, '原曲の打点を見る', ['ブラウザの中の採譜 AI が、BD・SD・', 'タム・HH・シンバルを聞き取る'])}
${step(3, 292, '打点に合わせて置く', ['キーボード・マウス・電子ドラム（MIDI）。', '原曲とずれていれば教えてくれる'])}
${text(right + 38, 392, '波形はスペクトルにも切り替えられます', { size: 12, fill: C.dim })}
`;
  const defs = `${cardDefs()}<filter id="ef-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5"/></filter>`;
  files['ear-copy.svg'] = doc({
    w: W,
    h: H,
    title: '耳コピのアシスト',
    desc: '再生すると、原曲の波形と、採譜 AI が聞き取った打点（BD・SD・タム・HH・シンバル）が譜面の横に並ぶ。打点に合わせてチップを置いていく。',
    css: css.join('\n'),
    defs,
    body,
  });
}

// =====================================================================================
// 5. TAB補完: 書いた 2 小節の続きを点線で出し、Tab で入れる
// =====================================================================================
{
  const W = 960;
  const H = 400;
  const L = 8;
  const LX = 64;
  const LW = 26; // 10 レーン → 64..324
  const top = 52;
  const bot = 372;
  const barH = (bot - top) / 4;
  const e8 = barH / 8;
  const yOf = (bar, e) => bot - bar * barH - e * e8;
  const bars = [
    [[0, 'CY'], [0, 'BD'], [1, 'HH'], [2, 'HH'], [2, 'SD'], [3, 'HH'], [3, 'BD'], [4, 'HH'], [4, 'BD'], [5, 'HH'], [6, 'HH'], [6, 'SD'], [7, 'HH']],
    [[0, 'HH'], [0, 'BD'], [1, 'HHO'], [2, 'HH'], [2, 'SD'], [3, 'HHO'], [3, 'BD'], [4, 'HH'], [4, 'BD'], [5, 'HHO'], [6, 'SD'], [6, 'HH'], [7, 'HT']],
  ];
  const laneOf = (k) => (k === 'HHO' ? 1 : LANES10.indexOf(k));
  const css = [];
  const TIN = 0.9;
  const TAB = 2.7;
  css.push(
    opKf('gh', L, [[0, 0], [TIN, 0], [TIN + 0.4, 1], [TAB + 0.05, 1], [TAB + 0.3, 0], [L, 0]]),
    `.gh{animation:gh ${L}s linear infinite}`,
    opKf('ban', L, [[0, 0], [TIN + 0.1, 0], [TIN + 0.5, 1], [TAB + 0.1, 1], [TAB + 0.4, 0], [L, 0]]),
    `.ban{animation:ban ${L}s linear infinite}`,
    keyframes('sol', L, [
      [0, 'opacity:0'],
      [TAB + 0.05, 'opacity:0'],
      [TAB + 0.25, 'opacity:1'],
      [L - 0.6, 'opacity:1'],
      [L - 0.15, 'opacity:0'],
      [L, 'opacity:0'],
    ]),
    `.sol{opacity:0;animation:sol ${L}s linear infinite}`,
    keyframes('kp', L, [
      [0, 'transform:translateY(0)'],
      [TAB - 0.08, 'transform:translateY(0)'],
      [TAB, 'transform:translateY(3.5px)'],
      [TAB + 0.22, 'transform:translateY(3.5px)'],
      [TAB + 0.32, 'transform:translateY(0)'],
      [L, 'transform:translateY(0)'],
    ]),
    `.kp{animation:kp ${L}s linear infinite}`,
    opKf('kglow', L, [[0, 0], [TAB - 0.08, 0], [TAB, 1], [TAB + 0.6, 0], [L, 0]]),
    `.kglow{opacity:0;animation:kglow ${L}s linear infinite}`,
    opKf('done', L, [[0, 0], [TAB + 0.3, 0], [TAB + 0.6, 1], [TAB + 2.4, 1], [TAB + 2.8, 0], [L, 0]]),
    `.done{opacity:0;animation:done ${L}s linear infinite}`,
    keyframes('cur', L, [
      [0, 'transform:translateY(0)'],
      [TAB + 0.1, 'transform:translateY(0)'],
      [TAB + 0.45, `transform:translateY(${-2 * barH}px)`],
      [L - 0.6, `transform:translateY(${-2 * barH}px)`],
      [L - 0.15, 'transform:translateY(0)'],
      [L, 'transform:translateY(0)'],
    ]),
    `.cur{animation:cur ${L}s ease-in-out infinite}`,
  );
  const drawBar = (bi, pos, kind) =>
    bars[bi]
      .map(([e, k]) => {
        const x = LX + laneOf(k) * LW + 2;
        const y = yOf(pos, e) - 3.5;
        if (kind === 'ghost') return ghost(x, y, LW - 4, 7, LANE[k]);
        if (k === 'HHO') return chipHHO(x, y, LW - 4, 7);
        return chip(x, y, LW - 4, 7, LANE[k]);
      })
      .join('');
  const laneBg = LANES10.map((k, i) => `<rect x="${LX + i * LW}" y="${top}" width="${LW}" height="${bot - top}" fill="${i % 2 ? '#0E141D' : '#0B1018'}"/>`).join('');
  const grid = [];
  for (let b = 0; b <= 16; b++) {
    const y = bot - b * (barH / 4);
    grid.push(`<line x1="${LX}" x2="${LX + 10 * LW}" y1="${p2(y)}" y2="${p2(y)}" stroke="${b % 4 === 0 ? '#3A4A61' : '#171F2C'}"/>`);
  }
  const nums = [0, 1, 2, 3].map((b) => text(LX - 8, bot - b * barH - 4, `00${9 + b}`.slice(-3), { size: 10, anchor: 'end', fill: C.dim, cls: 'mono' })).join('');
  // 札（アプリの TAB補完の札をまねた形）
  const bx = 344;
  const by = top + 30;
  const banner = `<g class="ban"><rect x="${LX + 2}" y="${top + 2}" width="${10 * LW - 4}" height="${2 * barH - 4}" rx="4" fill="${C.accent}" fill-opacity="0.04" stroke="${C.accent}" stroke-opacity="0.5" stroke-dasharray="4 3"/>
<path d="M${LX + 10 * LW} ${by + 30} L${bx} ${by + 30}" stroke="${C.accent}" stroke-opacity="0.5" stroke-dasharray="3 3"/>
<g transform="translate(${bx} ${by})"><rect width="258" height="62" rx="9" fill="#0C1724" stroke="${C.accent}" stroke-opacity="0.55"/>
<rect x="10" y="9" width="34" height="20" rx="4" fill="${C.accent}" fill-opacity="0.18" stroke="${C.accent}" stroke-opacity="0.6"/>${text(27, 23, 'Tab', { size: 11, anchor: 'middle', cls: 'mono', weight: 700, fill: C.accent })}
${text(52, 24, '小節 011〜012 を入れる', { size: 12.5, weight: 700 })}
${text(12, 49, '小節 009 から写す · 見込み 79%', { size: 11.5, fill: C.sub })}</g></g>`;
  const done = `<g class="done" transform="translate(${bx} ${by + 14})"><rect width="196" height="32" rx="16" fill="${C.green}" fill-opacity="0.14" stroke="${C.green}" stroke-opacity="0.6"/><path d="M14 16 l4 4 l8 -8.5" fill="none" stroke="${C.green}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>${text(34, 20.5, '2 小節を入れました', { size: 12.5, fill: C.text })}</g>`;
  const curY = bot - 2 * barH;
  const cursor = `<g class="cur"><line x1="${LX - 4}" x2="${LX + 10 * LW}" y1="${curY}" y2="${curY}" stroke="${C.accent}" stroke-width="1.6" stroke-dasharray="5 3"/><path d="M${LX - 12} ${curY - 6} L${LX - 4} ${curY} L${LX - 12} ${curY + 6} Z" fill="${C.accent}"/></g>`;
  // 右の説明とキー
  const RX = 630;
  const kTab = keycap(RX, 168, 'Tab', { w: 64, h: 34, size: 14, cls: 'kp' });
  const kShift = keycap(RX, 220, 'Shift', { w: 64, h: 34, size: 13 });
  const kTab2 = keycap(RX + 86, 220, 'Tab', { w: 54, h: 34, size: 13 });
  const kEsc = keycap(RX, 272, 'Esc', { w: 64, h: 34, size: 13 });
  const body = `${card(W, H)}
${LANES10.map((k, i) => text(LX + i * LW + LW / 2, top - 12, k, { size: 9.5, anchor: 'middle', fill: LANE[k], weight: 700, cls: 'mono' })).join('')}
${laneBg}${grid.join('')}${nums}
${drawBar(0, 0, 'solid')}${drawBar(1, 1, 'solid')}
<g class="gh">${drawBar(0, 2, 'ghost')}${drawBar(1, 3, 'ghost')}</g>
<g class="sol">${drawBar(0, 2, 'solid')}${drawBar(1, 3, 'solid')}</g>
${cursor}
${banner}${done}
${text(RX, 74, 'TAB補完', { size: 24, weight: 700 })}
${text(RX, 106, ['書いた小節から続きを予想して、', '先の小節に点線で出します。'], { size: 14, fill: C.sub, lh: 1.6 })}
<rect class="kglow" x="${RX - 4}" y="164" width="72" height="46" rx="10" fill="${C.accent}" fill-opacity="0.25" filter="url(#tb-blur)"/>
${kTab.svg}${text(RX + 82, 191, 'まとめて入れる', { size: 14 })}
${kShift.svg}${text(RX + 75, 243, '+', { size: 14, anchor: 'middle', fill: C.sub })}${kTab2.svg}${text(RX + 152, 243, '1 小節だけ', { size: 14 })}
${kEsc.svg}${text(RX + 82, 295, '消す', { size: 14 })}
${text(RX, 344, ['原曲で同じに聞こえる所（2 番のサビなど）も探します。', '写す元が無い所は AI に頼めます（キーが要ります）。'], { size: 12, fill: C.dim, lh: 1.6 })}
`;
  const defs = `${cardDefs()}<filter id="tb-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>`;
  files['tab-complete.svg'] = doc({ w: W, h: H, title: 'TAB補完', desc: '書いた 2 小節の続きが点線で出て、Tab キーでまとめて入る。Shift+Tab で 1 小節だけ、Esc で消す。', css: css.join('\n'), defs, body });
}

// =====================================================================================
// 6. 10 レーン: NX と同じ 10 レーンの落ちてくる譜面と、上から見たドラムセット（叩いた所が光る）
// =====================================================================================
{
  const W = 960;
  const H = 380;
  const L = 4.8; // 2 小節（100 BPM）
  const E = 0.3; // 8 分
  const TRAVEL = 1.5;
  const LX = 36;
  const LW = 36; // 10 レーン → 36..396
  const top = 22;
  const judge = 300;
  const dist = judge - top;
  // [8 分の位置, レーン]
  const ev = [];
  const add = (e, ...ks) => ks.forEach((k) => ev.push([e, k]));
  add(0, 'LC', 'BD'); add(1, 'HH'); add(2, 'HH', 'SD'); add(3, 'HH', 'BD'); add(4, 'HH', 'BD'); add(5, 'HH'); add(6, 'HH', 'SD'); add(7, 'HH', 'LP');
  add(8, 'CY', 'BD'); add(9, 'RD'); add(10, 'RD', 'SD'); add(11, 'RD', 'BD'); add(12, 'RD', 'BD'); add(13, 'HT'); add(14, 'LT'); add(15, 'FT', 'BD');
  const css = [];
  const travelFrac = TRAVEL / L;
  css.push(
    `@keyframes fall{0%{transform:translateY(0);opacity:0}6%{opacity:1}${pc(travelFrac)}{transform:translateY(${dist}px);opacity:1}${pc(travelFrac + 0.012)}{transform:translateY(${dist}px);opacity:0}100%{transform:translateY(${dist}px);opacity:0}}`,
    `.fa{animation:fall ${L}s linear infinite}`,
    `@keyframes blip{0%{opacity:1}7%{opacity:0}100%{opacity:0}}`,
    `.bl{opacity:0;animation:blip ${L}s ease-out infinite}`,
    `@keyframes blipk{0%{opacity:1;transform:scale(1.12)}9%{opacity:0;transform:scale(1)}100%{opacity:0;transform:scale(1)}}`,
    `.bk{opacity:0;animation:blipk ${L}s ease-out infinite;transform-box:fill-box;transform-origin:50% 50%}`,
  );
  const chips = ev
    .map(([e, k]) => {
      const t = e * E;
      const delay = t - TRAVEL - L;
      const x = LX + LANES10.indexOf(k) * LW + 3;
      // 止めた絵: 時刻 0.9 秒の位置
      const at = 0.9;
      const until = (((t - at) % L) + L) % L;
      const still = until <= TRAVEL ? `transform:translateY(${p2(dist * (1 - until / TRAVEL))}px)` : 'opacity:0';
      return `<g class="fa" style="animation-delay:${p2(delay)}s;${still}">${chip(x, top - 5, LW - 6, 10, LANE[k])}<rect x="${x}" y="${top - 5}" width="${LW - 6}" height="4" rx="2" fill="#fff" opacity="0.28"/></g>`;
    })
    .join('');
  const flashes = ev
    .map(([e, k]) => {
      const x = LX + LANES10.indexOf(k) * LW;
      return `<rect class="bl" x="${x + 1}" y="${judge - 26}" width="${LW - 2}" height="30" fill="url(#lf-${k})" style="animation-delay:${p2(e * E - L)}s"/>`;
    })
    .join('');
  const laneBg = LANES10.map((k, i) => `<rect x="${LX + i * LW}" y="${top - 8}" width="${LW}" height="${judge - top + 22}" fill="${i % 2 ? '#0E141D' : '#0B1018'}"/>`).join('');
  const laneDefs = LANES10.map((k) => `<linearGradient id="lf-${k}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${LANE[k]}" stop-opacity="0.9"/><stop offset="1" stop-color="${LANE[k]}" stop-opacity="0"/></linearGradient>`).join('');
  const labels = LANES10.map((k, i) => text(LX + i * LW + LW / 2, judge + 36, k, { size: 12, anchor: 'middle', fill: LANE[k], weight: 700, cls: 'mono' })).join('');
  // ドラムセット（上から見た所。下が叩く人の側）
  const kit = {
    LC: { x: 528, y: 92, r: 44, cym: true, name: '左シンバル', lx: 528, ly: 156 },
    CY: { x: 806, y: 80, r: 46, cym: true, name: '右シンバル', lx: 806, ly: 146 },
    RD: { x: 884, y: 210, r: 46, cym: true, name: 'ライド', lx: 884, ly: 275 },
    HH: { x: 506, y: 222, r: 36, cym: true, name: 'ハイハット', lx: 506, ly: 278 },
    HT: { x: 640, y: 128, r: 28, name: 'ハイタム', lx: 640, ly: 82 },
    LT: { x: 722, y: 128, r: 30, name: 'ロータム', lx: 722, ly: 82 },
    SD: { x: 594, y: 262, r: 34, name: 'スネア', lx: 594, ly: 316 },
    FT: { x: 790, y: 270, r: 40, name: 'フロアタム', lx: 790, ly: 330 },
  };
  const bdBox = { x: 640, y: 176, w: 100, h: 118 };
  const lpBox = { x: 470, y: 300, w: 40, h: 24 };
  const bdPedal = { x: 676, y: 298, w: 28, h: 30 };
  const piece = (k, p) => {
    const c = LANE[k];
    const rings = p.cym
      ? `<circle cx="${p.x}" cy="${p.y}" r="${p.r * 0.66}" fill="none" stroke="${c}" stroke-opacity="0.35"/><circle cx="${p.x}" cy="${p.y}" r="${p.r * 0.22}" fill="${c}" fill-opacity="0.35"/>`
      : `<circle cx="${p.x}" cy="${p.y}" r="${p.r - 5}" fill="#E9EEF4" fill-opacity="0.1" stroke="${c}" stroke-opacity="0.35"/>`;
    return `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-opacity="0.75" stroke-width="2"/>${rings}`;
  };
  const kitLabels = Object.entries(kit)
    .map(([k, p]) => `${text(p.x, p.y + 4.5, k, { size: 13, anchor: 'middle', weight: 700, fill: LANE[k], cls: 'mono' })}${text(p.lx, p.ly, p.name, { size: 11, anchor: 'middle', fill: C.sub })}`)
    .join('');
  const kitHits = ev
    .map(([e, k]) => {
      const d = p2(e * E - L);
      if (k === 'BD') return `<rect class="bk" x="${bdBox.x}" y="${bdBox.y}" width="${bdBox.w}" height="${bdBox.h}" rx="14" fill="${LANE.BD}" fill-opacity="0.55" style="animation-delay:${d}s"/>`;
      if (k === 'LP') return `<rect class="bk" x="${lpBox.x}" y="${lpBox.y}" width="${lpBox.w}" height="${lpBox.h}" rx="5" fill="${LANE.LP}" fill-opacity="0.8" style="animation-delay:${d}s"/>`;
      const p = kit[k];
      return `<circle class="bk" cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${LANE[k]}" fill-opacity="0.6" style="animation-delay:${d}s"/>`;
    })
    .join('');
  const body = `${card(W, H)}
${laneBg}
<line x1="${LX}" x2="${LX + 10 * LW}" y1="${judge}" y2="${judge}" stroke="#E8EEF6" stroke-opacity="0.85" stroke-width="3"/>
${flashes}
<g>${chips}</g>
<rect x="${LX}" y="${top - 8}" width="${10 * LW}" height="56" fill="url(#lt-fade)"/>
${labels}
${text(LX, judge + 62, 'NX と同じ 10 レーン（左シンバル・HH・右シンバル・ライドの 4 シンバル）', { size: 12, fill: C.sub })}
<line x1="430" x2="430" y1="36" y2="${H - 36}" stroke="#1E2A3B"/>
<rect x="${bdBox.x}" y="${bdBox.y}" width="${bdBox.w}" height="${bdBox.h}" rx="14" fill="${LANE.BD}" fill-opacity="0.12" stroke="${LANE.BD}" stroke-opacity="0.75" stroke-width="2"/>
${text(bdBox.x + bdBox.w / 2, bdBox.y + 74, 'BD', { size: 13, anchor: 'middle', weight: 700, fill: LANE.BD, cls: 'mono' })}${text(bdBox.x + bdBox.w / 2, bdBox.y + 92, 'バスドラム', { size: 11, anchor: 'middle', fill: C.sub })}
<rect x="${bdPedal.x}" y="${bdPedal.y}" width="${bdPedal.w}" height="${bdPedal.h}" rx="5" fill="#1C2738" stroke="#41536E"/>
<rect x="${lpBox.x}" y="${lpBox.y}" width="${lpBox.w}" height="${lpBox.h}" rx="5" fill="${LANE.LP}" fill-opacity="0.14" stroke="${LANE.LP}" stroke-opacity="0.75" stroke-width="2"/>
${text(lpBox.x + lpBox.w / 2, lpBox.y + 16.5, 'LP', { size: 11.5, anchor: 'middle', weight: 700, fill: LANE.LP, cls: 'mono' })}${text(lpBox.x + lpBox.w / 2, lpBox.y + 42, '左ペダル', { size: 11, anchor: 'middle', fill: C.sub })}
${kitHits}
${Object.entries(kit)
  .map(([k, p]) => piece(k, p))
  .join('')}
${kitLabels}
`;
  const defs = `${cardDefs()}${laneDefs}<linearGradient id="lt-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0B1018"/><stop offset="1" stop-color="#0B1018" stop-opacity="0"/></linearGradient>`;
  files['lanes.svg'] = doc({ w: W, h: H, title: '10 レーン・4 シンバル', desc: 'DTXManiaNX と同じ 10 レーン（LC HH LP SD HT BD LT FT CY RD）。落ちてくるチップと、上から見たドラムセットの叩いた所が光る。', css: css.join('\n'), defs, body });
}

// =====================================================================================
// 7. ステム: 原曲をドラム・ベース・ボーカル・その他に分け、ドラムだけ／ドラム抜きで聴く
// =====================================================================================
{
  const W = 960;
  const H = 340;
  const L = 9;
  const css = [];
  const stems = [
    { name: 'ドラム', color: '#F2955B', amp: envelope(Array.from({ length: 48 }, (_, i) => [i / 48, i % 4 === 0 ? 0.95 : i % 2 ? 0.4 : 0.8, 0.008]), 0.05, 0.08) },
    { name: 'ベース', color: '#9C84E0', amp: (t) => 0.42 + 0.25 * Math.abs(Math.sin(t * Math.PI * 12)) * (0.7 + 0.3 * Math.sin(t * 7)) + rnd() * 0.06 },
    { name: 'ボーカル', color: '#5BD69A', amp: (t) => ((t > 0.08 && t < 0.42) || (t > 0.52 && t < 0.9) ? 0.35 + 0.35 * Math.abs(Math.sin(t * 31)) + rnd() * 0.08 : 0.03) },
    { name: 'その他', color: '#D6C85A', amp: (t) => 0.3 + 0.12 * Math.sin(t * 9) + rnd() * 0.05 },
  ];
  const MX = 36;
  const MY = 108;
  const MW = 290;
  const MH = 112;
  const mixAmp = envelope(Array.from({ length: 32 }, (_, i) => [i / 32, i % 4 === 0 ? 1 : i % 2 ? 0.62 : 0.85, 0.014]), 0.5, 0.12);
  const SX = 440;
  const RW = 496;
  const RH = 56;
  const rowY = (i) => 38 + i * (RH + 12);
  // 時刻
  const tSplit = 0.6;
  const tSolo = 3.0;
  const tMute = 5.6;
  const tEnd = L - 0.6;
  css.push(
    opKf('mode0', L, [[0, 1], [tSolo - 0.2, 1], [tSolo, 0], [tEnd + 0.15, 0], [tEnd + 0.35, 1], [L, 1]]),
    opKf('mode1', L, [[0, 0], [tSolo - 0.1, 0], [tSolo + 0.1, 1], [tMute - 0.2, 1], [tMute, 0], [L, 0]]),
    opKf('mode2', L, [[0, 0], [tMute - 0.1, 0], [tMute + 0.1, 1], [tEnd, 1], [tEnd + 0.2, 0], [L, 0]]),
    '.m0{animation:mode0 9s linear infinite}.m1{opacity:0;animation:mode1 9s linear infinite}.m2{opacity:0;animation:mode2 9s linear infinite}',
    // ドラムの行: 「ドラム抜き」で暗く
    opKf('dr', L, [[0, 1], [tMute, 1], [tMute + 0.25, 0.22], [tEnd, 0.22], [tEnd + 0.25, 1], [L, 1]]),
    // ほかの行: 「ドラムだけ」で暗く
    opKf('ot', L, [[0, 1], [tSolo, 1], [tSolo + 0.25, 0.22], [tMute, 0.22], [tMute + 0.25, 1], [L, 1]]),
    opKf('sOn', L, [[0, 0], [tSolo, 0], [tSolo + 0.15, 1], [tMute, 1], [tMute + 0.15, 0], [L, 0]]),
    opKf('mOn', L, [[0, 0], [tMute, 0], [tMute + 0.15, 1], [tEnd, 1], [tEnd + 0.15, 0], [L, 0]]),
    `.dr{animation:dr ${L}s linear infinite}.ot{animation:ot ${L}s linear infinite}.sOn{opacity:0;animation:sOn ${L}s linear infinite}.mOn{opacity:0;animation:mOn ${L}s linear infinite}`,
    keyframes('play', L, [[0, 'transform:translateX(0)'], [L, `transform:translateX(${RW - 132}px)`]]),
    opKf('playo', L, [[0, 0], [tSplit + 0.9, 0], [tSplit + 1.4, 0.9], [L - 0.35, 0.9], [L, 0]]),
    `.playo{animation:playo ${L}s linear infinite}`,
    `.play{animation:play ${L}s linear infinite}`,
    keyframes('playm', L, [[0, 'transform:translateX(0)'], [L, `transform:translateX(${MW}px)`]]),
    `.playm{animation:playm ${L}s linear infinite}`,
  );
  stems.forEach((_, i) => {
    const t = tSplit + i * 0.32;
    css.push(
      keyframes(`in${i}`, L, [
        [0, 'transform:translateX(-90px);opacity:0'],
        [t, 'transform:translateX(-90px);opacity:0'],
        [t + 0.5, 'transform:translateX(0);opacity:1'],
        [L - 0.35, 'transform:translateX(0);opacity:1'],
        [L, 'transform:translateX(0);opacity:0'],
      ]),
      `.in${i}{animation:in${i} ${L}s ease-out infinite}`,
    );
  });
  const rows = stems
    .map((s, i) => {
      const y = rowY(i);
      const wp = wavePath(SX + 120, y + 8, RW - 132, RH - 16, s.amp, 200);
      const dimCls = i === 0 ? 'dr' : 'ot';
      return `<g class="in${i}"><g class="${dimCls}">
<rect x="${SX}" y="${y}" width="${RW}" height="${RH}" rx="10" fill="#0F1622" stroke="#1E2A3B"/>
<rect x="${SX}" y="${y + 8}" width="4" height="${RH - 16}" rx="2" fill="${s.color}"/>
${text(SX + 16, y + 24, s.name, { size: 14, weight: 700 })}
<g transform="translate(${SX + 16} ${y + 31})"><rect width="20" height="16" rx="3.5" fill="#1C2738" stroke="#41536E"/>${text(10, 12, 'M', { size: 10, anchor: 'middle', weight: 700, fill: C.sub, cls: 'mono' })}<rect x="25" width="20" height="16" rx="3.5" fill="#1C2738" stroke="#41536E"/>${text(35, 12, 'S', { size: 10, anchor: 'middle', weight: 700, fill: C.sub, cls: 'mono' })}</g>
<path d="${wp}" fill="${s.color}" fill-opacity="0.9"/>
</g>
${i === 0 ? `<g class="sOn" transform="translate(${SX + 41} ${y + 31})"><rect width="20" height="16" rx="3.5" fill="${C.amber}"/>${text(10, 12, 'S', { size: 10, anchor: 'middle', weight: 700, fill: '#1A1204', cls: 'mono' })}</g><g class="mOn" transform="translate(${SX + 16} ${y + 31})"><rect width="20" height="16" rx="3.5" fill="${C.red}"/>${text(10, 12, 'M', { size: 10, anchor: 'middle', weight: 700, fill: '#1A0606', cls: 'mono' })}</g>` : ''}
</g>`;
    })
    .join('\n');
  const mixWave = wavePath(MX, MY, MW, MH, mixAmp, 240);
  const caption = (cls, title, sub, color) =>
    `<g class="${cls}"><rect x="${MX}" y="250" width="${MW}" height="56" rx="12" fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-opacity="0.5"/>${text(MX + 16, 274, title, { size: 15, weight: 700 })}${text(MX + 16, 294, sub, { size: 12, fill: C.sub })}</g>`;
  const body = `${card(W, H)}
${text(MX, 70, '原曲', { size: 15, weight: 700 })}${text(MX + 40, 70, 'bgm.ogg', { size: 12, fill: C.dim, cls: 'mono' })}
<rect x="${MX - 8}" y="${MY - 10}" width="${MW + 16}" height="${MH + 20}" rx="12" fill="#0F1622" stroke="#1E2A3B"/>
<path d="${mixWave}" fill="#8796AD" fill-opacity="0.9"/>
<g class="playm"><line x1="${MX}" x2="${MX}" y1="${MY - 6}" y2="${MY + MH + 6}" stroke="${C.accent}" stroke-width="1.6"/></g>
<g transform="translate(${MX + MW + 18} ${MY + MH / 2})"><path d="M0 0 H64" stroke="${C.accent}" stroke-width="2.4"/><path d="M58 -7 L70 0 L58 7 Z" fill="${C.accent}"/>${text(34, -14, '分ける', { size: 13, anchor: 'middle', weight: 700, fill: C.accent })}${text(34, 24, 'ブラウザ内', { size: 10.5, anchor: 'middle', fill: C.dim })}</g>
${rows}
<g class="playo"><g class="play"><line x1="${SX + 120}" x2="${SX + 120}" y1="${rowY(0) + 4}" y2="${rowY(3) + RH - 4}" stroke="${C.accent}" stroke-width="1.6"/></g></g>
${caption('m0', '楽器ごとに分ける', 'ドラム・ベース・ボーカル・その他（4〜6 本）', C.accent)}
${caption('m1', 'ドラムだけを聴く', '耳コピしたい音だけ、くっきり', C.amber)}
${caption('m2', 'ドラム抜きで聴く', 'そのまま BGM（ドラム抜き）にもできる', C.red)}
`;
  files['stems.svg'] = doc({ w: W, h: H, title: 'ステム分解', desc: '原曲をブラウザの中でドラム・ベース・ボーカル・その他に分ける。ドラムだけを聴いたり、ドラム抜きを BGM にしたりできる。', css: css.join('\n'), defs: cardDefs(), body });
}

// =====================================================================================
// 8. AI難易度生成: MASTER から EXTREME・ADVANCED・BASIC を間引いて作る
// =====================================================================================
{
  const W = 960;
  const H = 440;
  const L = 9;
  const lanes = ['HH', 'SD', 'HT', 'BD', 'FT', 'CY'];
  const LW = 20;
  const top = 108;
  const bot = 410;
  const stepH = (bot - top) / 32;
  // MASTER（2 小節の 16 分）
  const M = [];
  const add = (s, k, tag) => M.push({ s, k, tag });
  // HH は 8 分に、ところどころ 16 分を足す（フィルの間は叩かない）
  for (const s of [0, 2, 4, 6, 8, 10, 18, 20, 22, 24, 26, 28, 30, 1, 3, 5, 9, 17, 21, 25, 29]) add(s, 'HH');
  for (const s of [4, 12, 20, 28]) add(s, 'SD', 'keep');
  add(7, 'SD', 'ghost'); add(31, 'SD', 'ghost'); add(13, 'SD');
  add(14, 'HT'); add(15, 'FT');
  for (const s of [0, 2, 6, 8, 10, 16, 18, 22, 23, 24, 26, 30]) add(s, 'BD', s === 0 || s === 16 ? 'keep' : undefined);
  add(16, 'CY', 'keep');
  // 段ごとに削る物
  const rmEXT = (n) => (n.k === 'HH' && n.s % 2 === 1) || n.tag === 'ghost';
  const rmADV = (n) => rmEXT(n) || (n.k === 'BD' && [2, 10, 18, 23, 26].includes(n.s));
  const rmBSC = (n) => rmADV(n) || (n.k === 'BD' && [6, 22, 30].includes(n.s)) || (n.k === 'SD' && n.s === 13) || (n.k === 'FT' && n.s === 15);
  const cols = [
    { name: 'MASTER', level: '7.45', color: '#C77DFF', rm: () => false },
    { name: 'EXTREME', level: '6.19', color: '#FF6B6B', rm: rmEXT },
    { name: 'ADVANCED', level: '5.70', color: '#FFB547', rm: rmADV },
    { name: 'BASIC', level: '5.17', color: '#4CC2FF', rm: rmBSC },
  ];
  const css = [];
  const tStage = [0, 0.9, 2.1, 3.3];
  const tKeep = 4.7;
  const tReset = L - 0.7;
  cols.forEach((c, i) => {
    if (!i) return;
    const t = tStage[i];
    css.push(
      opKf(`so${i}`, L, [[0, 1], [t, 1], [t + 0.6, 0], [tReset, 0], [tReset + 0.5, 1], [L, 1]]),
      opKf(`do${i}`, L, [[0, 0], [t + 0.1, 0], [t + 0.6, 1], [tReset, 1], [tReset + 0.5, 0], [L, 0]]),
      opKf(`lv${i}`, L, [[0, 0], [t + 0.5, 0], [t + 0.8, 1], [tReset, 1], [tReset + 0.4, 0], [L, 0]]),
      `.so${i}{opacity:0;animation:so${i} ${L}s ease-in-out infinite}.do${i}{animation:do${i} ${L}s ease-in-out infinite}.lv${i}{animation:lv${i} ${L}s linear infinite}`,
    );
  });
  css.push(
    keyframes('ring', L, [
      [0, 'opacity:0'],
      [tKeep, 'opacity:0'],
      [tKeep + 0.25, 'opacity:1'],
      [tKeep + 0.7, 'opacity:0.35'],
      [tKeep + 1.0, 'opacity:1'],
      [tKeep + 1.6, 'opacity:0'],
      [L, 'opacity:0'],
    ]),
    `.ring{opacity:0;animation:ring ${L}s ease-in-out infinite}`,
    opKf('lgk', L, [[0, 0.55], [tKeep, 0.55], [tKeep + 0.25, 1], [tKeep + 1.6, 1], [tKeep + 1.9, 0.55], [L, 0.55]]),
    `.lgk{animation:lgk ${L}s linear infinite}`,
  );
  const CWID = 152;
  const colX = (i) => 24 + i * 170;
  const colEls = cols
    .map((c, i) => {
      const x0 = colX(i);
      const lx = x0 + 16;
      const laneBg = lanes.map((k, j) => `<rect x="${lx + j * LW}" y="${top}" width="${LW}" height="${bot - top}" fill="${j % 2 ? '#0E141D' : '#0B1018'}"/>`).join('');
      const grid = [];
      for (let b = 0; b <= 8; b++) {
        const y = bot - b * ((bot - top) / 8);
        grid.push(`<line x1="${lx}" x2="${lx + lanes.length * LW}" y1="${p2(y)}" y2="${p2(y)}" stroke="${b % 4 === 0 ? '#3A4A61' : '#171F2C'}"/>`);
      }
      const keep = [];
      const solid = [];
      const dashed = [];
      const rings = [];
      for (const n of M) {
        const x = lx + lanes.indexOf(n.k) * LW + 2;
        const y = bot - n.s * stepH - 3.2;
        const removed = c.rm(n);
        if (n.tag === 'keep') rings.push(`<rect x="${p2(x - 2.5)}" y="${p2(y - 2.5)}" width="${LW - 4 + 5}" height="11.4" rx="4" fill="none" stroke="#fff" stroke-width="1.6"/>`);
        if (!removed) keep.push(chip(x, y, LW - 4, 6.4, LANE[n.k]));
        else {
          solid.push(chip(x, y, LW - 4, 6.4, LANE[n.k]));
          dashed.push(ghost(x, y, LW - 4, 6.4, '#7E8CA0', '', 0.05));
        }
      }
      const count = M.filter((n) => !c.rm(n)).length;
      const pct = Math.round((count / M.length) * 100);
      const check = `<g transform="translate(${x0 + 82} 63)"><circle r="7" fill="${C.green}" fill-opacity="0.2"/><path d="M-3.2 0 l2.2 2.2 l4.4 -4.8" fill="none" stroke="${C.green}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>`;
      const head = `${text(x0 + 14, 42, c.name, { size: 13, weight: 700, fill: c.color, ls: '0.4' })}
<g${i ? ` class="lv${i}"` : ''}>${text(x0 + 14, 71, c.level, { size: 23, weight: 700, cls: 'mono' })}${i ? check : ''}${text(x0 + CWID - 14, 60, `${count} ノーツ`, { size: 11, anchor: 'end', fill: C.sub })}${i ? text(x0 + CWID - 14, 75, `${pct}%`, { size: 11, anchor: 'end', fill: C.dim, cls: 'mono' }) : ''}</g>`;
      return `<g>
<rect x="${x0}" y="18" width="${CWID}" height="${H - 36}" rx="14" fill="#0F1622" stroke="${i ? '#1E2A3B' : '#3A2F55'}"/>
<rect x="${x0 + 14}" y="84" width="${CWID - 28}" height="3" rx="1.5" fill="${c.color}" opacity="0.8"/>
${head}
${laneBg}${grid.join('')}
${lanes.map((k, j) => text(lx + j * LW + LW / 2, top - 6, k, { size: 8.5, anchor: 'middle', fill: LANE[k], weight: 700, cls: 'mono' })).join('')}
${keep.join('')}
${i ? `<g class="do${i}">${dashed.join('')}</g><g class="so${i}">${solid.join('')}</g>` : ''}
<g class="ring">${rings.join('')}</g>
</g>`;
    })
    .join('\n');
  // 矢印（MASTER → ほか）
  const arrows = [1, 2, 3].map((i) => `<path d="M${colX(i) - 14} 60 h8" stroke="${C.dim}" stroke-width="2"/><path d="M${colX(i) - 7} 55.5 l5 4.5 l-5 4.5" fill="none" stroke="${C.dim}" stroke-width="2"/>`).join('');
  const RX = 718;
  const legendKeep = [
    ['2・4 拍のスネア', LANE.SD],
    ['1 拍目のキック', LANE.BD],
    ['フィルの着地のシンバル', LANE.CY],
  ];
  const body = `${card(W, H)}
${colEls}
${arrows}
${text(RX, 52, 'AI難易度生成', { size: 20, weight: 700 })}
${text(RX, 80, ['MASTER から 3 つの難易度を', 'まとめて作ります。'], { size: 13.5, fill: C.sub, lh: 1.6 })}
<g class="lgk">${text(RX, 146, '必ず残すもの', { size: 14, weight: 700 })}
${legendKeep.map(([l, c], i) => `<rect x="${RX}" y="${161 + i * 26}" width="16" height="7" rx="2.5" fill="${c}"/><rect x="${RX - 2.5}" y="${158.5 + i * 26}" width="21" height="12" rx="4" fill="none" stroke="#fff" stroke-width="1.4"/>${text(RX + 28, 169 + i * 26, l, { size: 13 })}`).join('')}</g>
${chip(RX, 260, 16, 7, LANE.HH)}${text(RX + 28, 268, '残した', { size: 13, fill: C.sub })}
${ghost(RX + 90, 260, 16, 7, '#7E8CA0', '', 0.05)}${text(RX + 118, 268, '削った', { size: 13, fill: C.sub })}
${text(RX, 312, ['AI が「どこをどう削るか」を決め、', 'チップはルールで置きます。', 'キーが無くても、ルールだけで', '作れます。'], { size: 12.5, fill: C.dim, lh: 1.6 })}
`;
  files['ai-difficulty.svg'] = doc({
    w: W,
    h: H,
    title: 'AI難易度生成',
    desc: 'MASTER（Lv 7.45）から EXTREME 6.19・ADVANCED 5.70・BASIC 5.17 を作る。2・4 拍のスネア、1 拍目のキック、フィルの着地は残し、ほかを段ごとに間引く。',
    css: css.join('\n'),
    defs: cardDefs(),
    body,
  });
}

// =====================================================================================
// 9. NX へ保存: Ctrl+S で曲フォルダにファイルが並び、DTXManiaNX の曲になる
// =====================================================================================
{
  const W = 960;
  const H = 360;
  const L = 8;
  const css = [];
  const tPress = 0.6;
  const tFiles = 1.0;
  const tCard = 3.0;
  const tReset = L - 0.6;
  const filesList = [
    ['set.def', '難易度の一覧', C.sub],
    ['mstr.dtx', 'MASTER', '#C77DFF'],
    ['ext.dtx', 'EXTREME', '#FF6B6B'],
    ['adv.dtx', 'ADVANCED', '#FFB547'],
    ['bsc.dtx', 'BASIC', '#4CC2FF'],
    ['bgm.ogg', '原曲', C.sub],
    ['preview.ogg', '選曲の試聴', C.sub],
    ['jacket.png', 'ジャケット', C.sub],
    ['dtxweb_rock_*.wav', '使った音だけ', C.sub],
  ];
  css.push(
    keyframes('kps', L, [
      [0, 'transform:translateY(0)'],
      [tPress - 0.06, 'transform:translateY(0)'],
      [tPress, 'transform:translateY(3.5px)'],
      [tPress + 0.25, 'transform:translateY(3.5px)'],
      [tPress + 0.35, 'transform:translateY(0)'],
      [L, 'transform:translateY(0)'],
    ]),
    `.kps{animation:kps ${L}s linear infinite}`,
    opKf('kgs', L, [[0, 0], [tPress - 0.06, 0], [tPress, 1], [tPress + 0.7, 0], [L, 0]]),
    `.kgs{opacity:0;animation:kgs ${L}s linear infinite}`,
  );
  filesList.forEach((_, i) => {
    const t = tFiles + i * 0.17;
    css.push(
      keyframes(`f${i}`, L, [
        [0, 'transform:translateX(-14px);opacity:0'],
        [t, 'transform:translateX(-14px);opacity:0'],
        [t + 0.25, 'transform:translateX(0);opacity:1'],
        [tReset, 'transform:translateX(0);opacity:1'],
        [tReset + 0.4, 'transform:translateX(0);opacity:0'],
        [L, 'transform:translateX(-14px);opacity:0'],
      ]),
      `.f${i}{animation:f${i} ${L}s ease-out infinite}`,
    );
  });
  css.push(
    keyframes('card', L, [
      [0, 'transform:translateY(14px);opacity:0'],
      [tCard, 'transform:translateY(14px);opacity:0'],
      [tCard + 0.45, 'transform:translateY(0);opacity:1'],
      [tReset, 'transform:translateY(0);opacity:1'],
      [tReset + 0.4, 'transform:translateY(0);opacity:0'],
      [L, 'transform:translateY(14px);opacity:0'],
    ]),
    `.card{animation:card ${L}s ease-out infinite}`,
    opKf('arw', L, [[0, 0], [tCard - 0.4, 0], [tCard, 1], [tReset, 1], [tReset + 0.4, 0], [L, 0]]),
    `.arw{animation:arw ${L}s linear infinite}`,
  );
  [0, 1, 2, 3].forEach((i) => {
    const t = tCard + 0.5 + i * 0.15;
    css.push(opKf(`dp${i}`, L, [[0, 0], [t, 0], [t + 0.2, 1], [tReset, 1], [tReset + 0.4, 0], [L, 0]]), `.dp${i}{animation:dp${i} ${L}s linear infinite}`);
  });
  css.push(
    keyframes('sel', L, [
      [0, 'opacity:0'],
      [tCard + 1.4, 'opacity:0'],
      [tCard + 1.7, 'opacity:1'],
      [tCard + 2.3, 'opacity:0.4'],
      [tCard + 2.9, 'opacity:1'],
      [tReset, 'opacity:1'],
      [tReset + 0.4, 'opacity:0'],
      [L, 'opacity:0'],
    ]),
    `.sel{animation:sel ${L}s ease-in-out infinite}`,
  );
  // 左: 保存のキー
  const k1 = keycap(44, 148, 'Ctrl', { w: 70, h: 40, size: 15, cls: 'kps' });
  const k2 = keycap(140, 148, 'S', { w: 44, h: 40, size: 15, cls: 'kps' });
  const left = `${text(44, 70, '保存', { size: 20, weight: 700 })}
${text(44, 98, ['曲フォルダに、NX が', 'そのまま読める形で'], { size: 13, fill: C.sub, lh: 1.6 })}
<rect class="kgs" x="38" y="142" width="152" height="54" rx="12" fill="${C.accent}" fill-opacity="0.28" filter="url(#sv-blur)"/>
${k1.svg}${text(127, 175, '+', { size: 16, anchor: 'middle', fill: C.sub })}${k2.svg}
${text(44, 236, ['Shift_JIS・CRLF', 'Chrome・Edge は曲フォルダへ', 'じかに、ほかは ZIP で'], { size: 12, fill: C.dim, lh: 1.65 })}`;
  // 中: フォルダ
  const FX = 236;
  const tree = `<rect x="${FX}" y="30" width="330" height="300" rx="14" fill="#0F1622" stroke="#1E2A3B"/>
<g transform="translate(${FX + 18} 44)"><path d="M0 5 a3 3 0 0 1 3 -3 h9 l3.5 3.5 h15 a3 3 0 0 1 3 3 v13 a3 3 0 0 1 -3 3 h-27.5 a3 3 0 0 1 -3 -3 z" fill="${C.amber}" fill-opacity="0.9"/></g>
${text(FX + 60, 62, 'DTXFiles / Neon Skyline', { size: 13.5, weight: 700, cls: 'mono' })}
${filesList
  .map(([f, d, col], i) => {
    const y = 84 + i * 26;
    return `<g class="f${i}"><rect x="${FX + 30}" y="${y}" width="284" height="22" rx="5" fill="#141E2C"/><circle cx="${FX + 42}" cy="${y + 11}" r="3" fill="${col}"/>${text(FX + 54, y + 15.5, f, { size: 12, cls: 'mono' })}${text(FX + 304, y + 15.5, d, { size: 11, anchor: 'end', fill: col === C.sub ? C.dim : col })}</g>`;
  })
  .join('')}`;
  // 右: ゲームの曲（NX の画面をまねず、曲のカードとして描く）
  const GX = 612;
  const diffs = [
    ['BASIC', '5.17', '#4CC2FF'],
    ['ADVANCED', '5.70', '#FFB547'],
    ['EXTREME', '6.19', '#FF6B6B'],
    ['MASTER', '7.45', '#C77DFF'],
  ];
  const jacket = `<g transform="translate(${GX + 18} 92)"><rect width="84" height="84" rx="8" fill="url(#jk-sky)"/><circle cx="42" cy="54" r="20" fill="url(#jk-sun)"/>
${[[0, 60, 10, 24], [12, 50, 9, 34], [23, 64, 11, 20], [36, 46, 8, 38], [46, 58, 12, 26], [60, 52, 9, 32], [71, 62, 13, 22]].map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#140A2A"/>`).join('')}
<rect y="74" width="84" height="10" fill="#0A0518"/><path d="M0 76 H84" stroke="#FF5CA8" stroke-opacity="0.8"/>${text(42, 20, 'NEON', { size: 11, anchor: 'middle', weight: 700, fill: '#FFE3F6', ls: '1.5' })}${text(42, 31, 'SKYLINE', { size: 7.5, anchor: 'middle', weight: 700, fill: '#BFE8FF', ls: '1.2' })}</g>`;
  const game = `<g class="arw"><path d="M${FX + 344} 180 H${GX - 10}" stroke="${C.accent}" stroke-width="2.4"/><path d="M${GX - 16} 173 L${GX - 4} 180 L${GX - 16} 187 Z" fill="${C.accent}"/></g>
<g class="card"><rect x="${GX}" y="48" width="320" height="270" rx="16" fill="#120C22" stroke="#3A2F55"/>
${text(GX + 18, 76, 'DTXManiaNX', { size: 13, weight: 700, fill: '#D9C9FF', ls: '0.5' })}${text(GX + 302, 76, '曲を選ぶ', { size: 11, anchor: 'end', fill: C.dim })}
${jacket}
${text(GX + 116, 116, 'Neon Skyline', { size: 18, weight: 700 })}${text(GX + 116, 138, 'DTX Web Editor demo', { size: 11.5, fill: C.sub })}${text(GX + 116, 160, '172 BPM', { size: 11.5, fill: C.dim, cls: 'mono' })}
${diffs
  .map(([n, lv, col], i) => {
    const y = 196 + i * 28;
    return `<g class="dp${i}"><rect x="${GX + 18}" y="${y}" width="284" height="23" rx="6" fill="${col}" fill-opacity="0.1" stroke="${col}" stroke-opacity="0.45"/>${text(GX + 30, y + 16, n, { size: 12, weight: 700, fill: col })}${text(GX + 290, y + 16.5, lv, { size: 13, weight: 700, anchor: 'end', cls: 'mono' })}</g>`;
  })
  .join('')}
<rect class="sel" x="${GX + 16}" y="${196 + 3 * 28 - 2}" width="288" height="27" rx="7" fill="none" stroke="#fff" stroke-width="2"/>
</g>`;
  const defs = `${cardDefs()}<filter id="sv-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
<linearGradient id="jk-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A0F55"/><stop offset="0.6" stop-color="#9B2A8A"/><stop offset="1" stop-color="#FF7A59"/></linearGradient>
<linearGradient id="jk-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE27A"/><stop offset="1" stop-color="#FF4F9A"/></linearGradient>`;
  const body = `${card(W, H)}
${left}
${tree}
${game}
`;
  files['save-nx.svg'] = doc({
    w: W,
    h: H,
    title: 'DTXManiaNX へ保存',
    desc: 'Ctrl+S で曲フォルダに set.def・4 難易度の DTX・原曲・試聴・ジャケット・使った音が並び、DTXManiaNX でそのまま遊べる。',
    css: css.join('\n'),
    defs,
    body,
  });
}

for (const [name, svg] of Object.entries(files)) {
  writeFileSync(path.join(OUT, name), svg);
  console.log(name, `${(svg.length / 1024).toFixed(1)} KB`);
}
