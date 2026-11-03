// 画面に出る文で、英語を持たない日本語が残っていないかを調べる（多言語対応の確認用）。
//   node scripts/i18n-check.mjs [ファイルやフォルダ…]   既定は src 全体（テストと耳コピ精度テストのページは除く）
// 日本語を含む文字列・テンプレート・JSX の文字で、次のどれでもないものを出す:
//   - tr('日本語', 'English') の1つ目の引数の中
//   - isJa() ? (日本語) : (英語) の日本語側（if (isJa()) {…} も）
//   - ['日本語', 'English'] の組（日本語を含まない2つ目がある2要素の配列）
//   - 正規表現、import、オブジェクトのキー
//   - その行か直前の行に「i18n-ignore」と書いた所、「i18n-ignore-start」〜「i18n-ignore-end」の間（AI へのプロンプトや、ファイル名の照合など）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'rolldown/parseAst';

const JP = /[぀-ヿ一-鿿！-～]/;
const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const targets = args.length ? args : ['src'];

function walkDir(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) walkDir(join(p, f), out);
  } else if (/\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p) && !/\.d\.ts$/.test(p)) {
    out.push(p);
  }
  return out;
}

const files = targets.flatMap((t) => walkDir(join(root, t), [])).filter((f) => !/\/src\/bench\//.test(f) && !/\/src\/i18n\//.test(f));

const isTrCall = (n) => n && n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'tr';
const isJaCall = (n) => n && n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'isJa' && n.arguments.length === 0;
const hasJp = (s) => typeof s === 'string' && JP.test(s);
const strOf = (n) => (n?.type === 'Literal' && typeof n.value === 'string' ? n.value : n?.type === 'TemplateLiteral' ? n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('') : null);

let total = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!JP.test(src)) continue;
  const lines = src.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  // 無視する行
  const ignored = new Set();
  let inBlock = false;
  lines.forEach((l, i) => {
    if (l.includes('i18n-ignore-start')) inBlock = true;
    if (inBlock || l.includes('i18n-ignore')) ignored.add(i + 1);
    if (l.includes('i18n-ignore') && !l.includes('i18n-ignore-start') && !l.includes('i18n-ignore-end')) ignored.add(i + 2);
    if (l.includes('i18n-ignore-end')) inBlock = false;
  });
  // ソースの位置は UTF-16 の位置（oxc は UTF-16 に直して返す）
  let ast;
  try {
    ast = parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  } catch (e) {
    console.log(`${relative(root, file)}: 読めません: ${e.message}`);
    continue;
  }
  const found = [];
  const visit = (node, anc) => {
    if (!node || typeof node.type !== 'string') return;
    const parent = anc[anc.length - 1];
    // 許す場所の下は見ない
    if (node.type === 'ImportDeclaration' || node.type === 'TSImportType') return;
    if (parent && isTrCall(parent) && parent.arguments[0] === node) return;
    if (parent && parent.type === 'ConditionalExpression' && parent.consequent === node && isJaCall(parent.test)) return;
    if (parent && parent.type === 'IfStatement' && parent.consequent === node && isJaCall(parent.test)) return;
    if (parent && parent.type === 'LogicalExpression' && parent.operator === '&&' && parent.right === node && isJaCall(parent.left)) return;
    if (parent && parent.type === 'ArrayExpression' && parent.elements.length === 2 && parent.elements[0] === node) {
      const en = strOf(parent.elements[1]);
      if (en !== null && !hasJp(en)) return;
    }
    if (parent && (parent.type === 'Property' || parent.type === 'TSPropertySignature') && parent.key === node && !parent.computed) return;
    if (parent && parent.type === 'TSLiteralType') return;
    let text = null;
    if (node.type === 'Literal' && typeof node.value === 'string' && !node.regex) text = node.value;
    else if (node.type === 'TemplateLiteral') text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('…');
    else if (node.type === 'JSXText') text = node.value;
    if (text !== null && hasJp(text)) {
      const line = lineOf(node.start);
      if (!ignored.has(line)) found.push({ line, text: text.replace(/\s+/g, ' ').trim() });
      if (node.type !== 'TemplateLiteral') return;
    }
    const next = [...anc, node];
    for (const k of Object.keys(node)) {
      if (k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) visit(c, next);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, next);
    }
  };
  visit(ast, []);
  if (found.length) {
    const seen = new Set();
    for (const f of found) {
      const key = `${f.line}:${f.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`${relative(root, file)}:${f.line}: ${f.text.slice(0, 140)}`);
      total++;
    }
  }
}
console.log(total ? `\n英語の無い日本語: ${total} か所` : '英語の無い日本語はありません');
process.exitCode = total ? 1 : 0;
