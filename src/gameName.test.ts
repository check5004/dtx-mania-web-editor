import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

// ゲームの名前は「DTXMania」と書く（2026-11-13 楯さん「NX って呼んでるとこ、DTXMania って呼んで欲しい」）。
// 画面に出る文（src の文字列・テンプレート・JSX の文字。AI へのプロンプトも）と、README・説明書・README の図・ページの説明に
// 「NX」「DTXManiaNX」が無いかを npm test のたびに調べる。コードの名前（nxlib・NxPreview など）とコメントは見ない。

const root = fileURLToPath(new URL('..', import.meta.url));

/** 「NX」とだけ書いた所（ONNX・NX_FILTERS・save-nx は除く）と「DTXManiaNX」 */
const callsItNx = (s: string) => /(?<![A-Za-z0-9_])NX(?![A-Za-z0-9_])/.test(s) || /DTX\s*Mania\s*NX/i.test(s);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|d)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** src の文字列・テンプレート・JSX の文字のうち、NX と呼んでいる物（ファイル:行: 文） */
function nxInSources(): string[] {
  const found: string[] = [];
  for (const file of sources(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8');
    if (!/NX/i.test(src)) continue;
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
      if (text !== null && callsItNx(text)) found.push(`${relative(root, file)}:${lineOf(n.start ?? 0)}: ${text.trim().slice(0, 80)}`);
      for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
    };
    visit(parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }));
  }
  return found;
}

/** README・説明書（docs/*.md）・README の図・ページの説明の、NX と呼んでいる行 */
function nxInDocs(): string[] {
  const files = [
    'README.md',
    'index.html',
    'package.json',
    'public/manifest.webmanifest',
    ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
    ...readdirSync(join(root, 'docs/readme')).filter((f) => f.endsWith('.svg')).map((f) => `docs/readme/${f}`),
  ];
  return files.flatMap((f) =>
    readFileSync(join(root, f), 'utf8')
      .split('\n')
      .flatMap((l, i) => (callsItNx(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 80)}`] : [])),
  );
}

describe('ゲームの名前は DTXMania（NX と書かない）', () => {
  const hint = '（ゲームは「DTXMania」と書きます。NX・DTXManiaNX と書かない。README の図は scripts/readme/make-svgs.mjs で作り直す）';

  it('画面に出る文に NX が無い', () => {
    const found = nxInSources().join('\n');
    expect(found, `\n${found}\n${hint}`).toBe('');
  });

  it('README・説明書・README の図・ページの説明に NX が無い', () => {
    const found = nxInDocs().join('\n');
    expect(found, `\n${found}\n${hint}`).toBe('');
  });

  it('見つけ方：NX だけの所と DTXManiaNX は見つけ、ONNX やコードの名前は見ない', () => {
    expect(['NX風プレビュー', 'NX で遊ぶ', 'NX-style preview', 'Shift_JIS (NX)', 'DTXManiaNX.exe', 'DTXmania NX'].map(callsItNx)).toEqual([true, true, true, true, true, true]);
    expect(['DTXMania風プレビュー', 'ONNX Runtime', 'NX_FILTERS', 'NxPreview', 'save-nx.svg', 'src/nxlib/'].map(callsItNx)).toEqual([false, false, false, false, false, false]);
  });
});
