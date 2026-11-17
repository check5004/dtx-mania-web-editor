import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

// PC どうしの同期は、PC が何台でもよく、PC に役割は無い（どの PC も作れて遊べる）。
// 2026-11-17 楯さん「台数制限やこいつはエディタPCだ！って言い切る表現、よくないのよ」。
// 画面に出る文（src の文字列・テンプレート・JSX の文字）と README・説明書に、PC を役割で呼ぶ言い方・2 台だけと決めた言い方が無いかを
// npm test のたびに調べる。コードの名前とコメント、試験の中の例の名前は見ない。

const root = fileURLToPath(new URL('..', import.meta.url));

/** PC を役割で呼ぶ（作る PC・遊ぶ PC・エディタ PC…）・2 台だけと決める（2 台目・両方の PC・the other PC…） */
const PATTERNS: RegExp[] = [
  /(作る|遊ぶ|作り用の?|遊び用の?|エディタ|エディター|プレイ用の?|プレイ)\s?PC/,
  /[2２二]\s?台目/,
  /両方の\s?PC/,
  /\b(making|playing|editing|editor|player)\s+PC\b/i,
  /\bPC you (make|play|edit) on\b/i,
  /\bsecond PC\b/i,
  /\bboth PCs\b/i,
  /\bthe other PC\b/i,
];
const callsByRole = (s: string) => PATTERNS.some((re) => re.test(s));

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|testutil|d)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** src の文字列・テンプレート・JSX の文字のうち、PC を役割で呼んでいる物（ファイル:行: 文） */
function rolesInSources(): string[] {
  const found: string[] = [];
  for (const file of sources(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8');
    if (!/PC/.test(src)) continue;
    const lineOf = (pos: number) => src.slice(0, pos).split('\n').length;
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      const n = node as { type?: string; value?: unknown; start?: number };
      const text =
        n.type === 'Literal' && typeof n.value === 'string'
          ? n.value
          : n.type === 'TemplateElement'
            ? ((n.value as { cooked?: string; raw: string }).cooked ?? (n.value as { raw: string }).raw)
            : n.type === 'JSXText'
              ? String(n.value)
              : null;
      if (text !== null && callsByRole(text)) found.push(`${relative(root, file)}:${lineOf(n.start ?? 0)}: ${text.trim().slice(0, 80)}`);
      for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
    };
    visit(parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }));
  }
  return found;
}

/** README・説明書（docs/*.md）・README の図の、PC を役割で呼んでいる行 */
function rolesInDocs(): string[] {
  const files = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), ...readdirSync(join(root, 'docs/readme')).filter((f) => f.endsWith('.svg')).map((f) => `docs/readme/${f}`)];
  return files.flatMap((f) =>
    readFileSync(join(root, f), 'utf8')
      .split('\n')
      .flatMap((l, i) => (callsByRole(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 80)}`] : [])),
  );
}

describe('PC どうしの同期：PC は何台でも、役割で呼ばない', () => {
  const hint = '（PC は何台でもよく、どの PC も作れて遊べます。「この PC」「ほかの PC」と書き、作る PC・遊ぶ PC・2 台目などと書かない）';

  it('画面に出る文に、PC を役割で呼ぶ言い方が無い', () => {
    const found = rolesInSources().join('\n');
    expect(found, `\n${found}\n${hint}`).toBe('');
  });

  it('README・説明書に、PC を役割で呼ぶ言い方が無い', () => {
    const found = rolesInDocs().join('\n');
    expect(found, `\n${found}\n${hint}`).toBe('');
  });

  it('見つけ方：役割の名前と 2 台だけの言い方は見つけ、ふつうの言い方は見ない', () => {
    expect(['作るPC', '遊ぶ PC の成績', 'エディタPC', '2 台目の PC', '両方の PC で遊んでも', 'Making PC', 'the PC you play on', 'your second PC', 'on both PCs', 'the other PC'].map(callsByRole)).toEqual(Array(10).fill(true));
    expect(['この PC', 'ほかの PC', 'ノートPC', 'デスクトップ', 'PC は何台でも', '譜面を作る', 'another PC', 'other PCs', 'this PC', 'PC sync'].map(callsByRole)).toEqual(Array(10).fill(false));
  });
});
