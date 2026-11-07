import { describe, expect, it } from 'vitest';
import { checkAll, checkSource } from '../scripts/safari-check.mjs';

// Safari（iPad）で動かなくなりやすい書き方が無いかを、npm test のたびに調べる（scripts/safari-check.mjs）。
// 引っかかったら docs/safari.md の該当の項を読み、直すか、確かめたうえで scripts/safari-check.mjs の表に足す

describe('Safari の決まり（docs/safari.md）', () => {
  it('src に Safari で問題になりやすい書き方が無い', () => {
    const found = checkAll()
      .map((f) => `${f.file}:${f.line}: [${f.rule}] ${f.msg}`)
      .join('\n');
    expect(found, `\n${found}\n（docs/safari.md を読んで直すか、確かめて scripts/safari-check.mjs の表に足してください）`).toBe('');
  });

  it('見つけ方：await のあとで鳴らす・表に無い所で鳴らす・出力を作る・直に読み込む・Safari に無い API', () => {
    const src = [
      "import { engine } from '../audio/engine';",
      'export async function later() {',
      '  await load();',
      '  engine.play(req);',
      '}',
      'export async function ready() {',
      '  engine.ensure();',
      '  await load();',
      '  engine.play(req);',
      '}',
      'export const made = () => new AudioContext();',
      'setTimeout(() => engine.preview(1), 10);',
      'const b = ctx.decodeAudioData(x);',
      'requestIdleCallback(() => {});',
      'const a = new Audio(url);',
      'interface W { showDirectoryPicker?: () => void }',
      '// new AudioContext() と書いただけ（コメント）は見ない',
      "const s = 'engine.play() という文字';",
    ].join('\n');
    const found = checkSource('src/x/demo.ts', src).map((f) => `${f.line} ${f.rule}`);
    expect(found).toEqual([
      '4 操作の中',
      '7 操作の中',
      '9 操作の中',
      '11 出力',
      '12 操作の中',
      '13 読み込み',
      '14 無いAPI',
      '15 media',
      '4 await の前',
    ]);
  });

  it('表にある所は通す（最初の await の前に ensure していれば、await のあとで鳴らしてよい）', () => {
    const src = ['export async function playFrom() {', '  engine.ensure();', '  await prepare();', '  engine.play(req);', '}'].join('\n');
    expect(checkSource('src/store/editor.ts', src)).toEqual([]);
  });
});
