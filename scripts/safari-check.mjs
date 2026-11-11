// Safari（iPad・iPhone・Mac）で動かなくなりやすい書き方を探す。決まりと理由は docs/safari.md
//   node scripts/safari-check.mjs [ファイルやフォルダ…]   既定は src 全体（テストと耳コピ精度テストのページは除く）
// npm test（src/safariRules.test.ts）でも走る。引っかかったら docs/safari.md の該当の項を読み、
// 直すか、確かめたうえで下の表に足す（表の値には、なぜ大丈夫かを一言書く）。
//
// 調べること:
//   [操作の中]   再生用の出力を作ることがある engine の関数（GATED）を呼ぶ所は、タップ・キーの操作の中か。表 GESTURE_OK にある所だけ
//   [await の前] 上の関数を await のあとで呼ぶなら、最初の await より前に engine.ensure() などを呼んでいるか
//   [出力]       new AudioContext は src/audio/engine.ts だけ
//   [読み込み]   decodeAudioData は engine.decodeAudio() を通す（オフラインの context で読む所は表 DECODE_OK）
//   [無いAPI]    Safari に無い API は、使えるか確かめてから使う（表 API_OK）
//   [media]      <audio>・<video> を作って鳴らす所は表 MEDIA_OK
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'rolldown/parseAst';

/** 再生用の出力（AudioContext）を作る・起こすことがある engine の関数。Safari ではタップ・キーの操作の中でしか起きない */
const GATED = new Set(['ensure', 'play', 'preview', 'previewBuffer', 'audition', 'testTone', 'resetOutput', 'clickAt']);

/**
 * GATED を呼んでよい所（ファイル#関数の並び）。どれもタップ・キー・クリックの中から（await より前に）呼ばれる。
 * タイマー・読み込みのあと・購読（subscribe）・MIDI の中から呼ぶ所は足さない（docs/safari.md「音を鳴らし始める所」）
 */
export const GESTURE_OK = {
  'src/store/editor.ts#playFrom': '▶・Space・ダブルクリックなど。最初の await の前に ensure',
  'src/store/editor.ts#previewWav': 'チップを置いた・動かした（ドラッグは動かしている間。出力は押したとき ChartCanvas>mouseDown で用意）・WAV の試聴ボタン',
  'src/ui/ChartCanvas.tsx#ChartCanvas>mouseDown': 'チップを押したとき（動かすと移動先の音を鳴らすので、マウスのボタンを押した操作の中で出力を用意する）',
  'src/store/editor.ts#previewFile': 'previewWav（操作の中）から。頭で ensure してから読み込む',
  'src/store/hits.ts#previewVoice': 'レーン・特殊ノーツの音（previewLane・previewKind から）。キー・パッド・試し打ち（パッドは指が触れたとき。Safari は指を離したときにも出力を起こす）・種類の設定の試聴ボタン',
  'src/store/hits.ts#previewVoice>then': '内蔵キットの音の読み込みを待って鳴らす。出力は previewVoice の頭（操作の中）で用意してある',
  'src/store/tempoUi.ts#playPlan': 'テンポ合わせの ▶',
  'src/store/assist.ts#setBandFilter': '帯域のボタン・スペクトルの見出しのクリック',
  'src/store/audition.ts#playAudition': '試聴の ▶。最初の await の前に ensure',
  'src/store/flam.ts#previewFlam': 'フラムにする操作（Alt+F・右クリック）',
  'src/ui/ytAlign.ts#startAutoAlign': '「自動で合わせる」ボタン（読み込んだときの自動は Chrome・Edge だけ＝canCaptureTab）',
  'src/ui/SettingsPage.tsx#LatencySettings>start': '遅延テストのボタン',
  'src/ui/tablet/TouchSettings.tsx#PadLatencyTest>start': 'パッドの遅れを測るボタン（タブレット）',
  'src/ui/AudioCheck.tsx#AudioCheck>onClick': 'テスト音・出力の作り直しのボタン',
  'src/ui/SafariNotice.tsx#SafariNotice>onClick': 'テスト音のボタン',
};

/** decodeAudioData を直に呼んでよいファイル（どれもオフラインの context で読む） */
export const DECODE_OK = {
  'src/audio/engine.ts': 'decodeAudio の中（Safari で出力が無ければオフライン）',
  'src/audio/sounds.ts': 'ライブラリ用の OfflineAudioContext',
  'src/separate/client.ts': 'ステム分解用の OfflineAudioContext',
};

/** Safari（iPad）に無い API。使うファイルは、使えるか確かめてから使い、無いときの道を用意する */
const SAFARI_MISSING = {
  showDirectoryPicker: 'フォルダを選ぶ（Chrome・Edge だけ）',
  showOpenFilePicker: 'ファイルを選ぶ（Chrome・Edge だけ）',
  showSaveFilePicker: '保存先を選ぶ（Chrome・Edge だけ）',
  requestMIDIAccess: 'Web MIDI（Safari に無い）',
  getDisplayMedia: 'タブの音（iPad に無い）',
  requestIdleCallback: '無い Safari がある（無ければ setTimeout で代わりを用意する）',
  webkitdirectory: 'フォルダの選択（iPad は選べない）',
};

/** 上の API を使ってよいファイル（使えるか確かめている） */
export const API_OK = {
  'src/fs/folder.ts': 'showDirectoryPicker の有無を見る',
  'src/app/songPlace.ts': 'pickDir は supportsDirectWrite() のとき・PC の曲フォルダ（isDiskFolder）のときだけ呼ぶ（fileActions。無いときは webkitdirectory の input・本体・ZIP）',
  'src/store/guideline.ts': 'window.showDirectoryPicker があるときだけ',
  'src/store/library.ts': 'window.showDirectoryPicker があるときだけ',
  'src/nxlib/store.ts': 'DTXMania の曲は PC だけ（initNxLib が supportsDirectWrite() を見て、無ければ入口を出さない）。選ぶ関数も window.showDirectoryPicker を見る',
  'src/input/midi.ts': "'requestMIDIAccess' in navigator を見る",
  'src/store/device.ts': '使えるかの判定そのもの',
  'src/audio/tabCapture.ts': 'getDisplayMedia の有無を見る（iPad はボタンを出さない）',
  'src/ui/Editor.tsx': 'webkitdirectory の input（iPad は NO_FOLDER_PICK で出さない）',
};

/** <audio>・<video> を作るファイル（iPad はタップの中でしか鳴らせない・OGG は 18.4 から） */
export const MEDIA_OK = {
  'src/store/songinfo.ts': '長さを読むだけで鳴らさない',
};

const root = new URL('..', import.meta.url).pathname;

function walk(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) walk(join(p, f), out);
  } else if (/\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p) && !/\.d\.ts$/.test(p)) {
    out.push(p);
  }
  return out;
}

/** 型の宣言の中（実行されない）。`x!` や `as` は式なので入れない */
const TYPE_NODES = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSTypeAnnotation', 'TSTypeLiteral', 'TSPropertySignature', 'TSMethodSignature', 'TSModuleDeclaration', 'TSTypeReference', 'TSQualifiedName', 'TSDeclareFunction', 'TSFunctionType']);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const keyName = (k) => (k?.type === 'Identifier' ? k.name : k?.type === 'Literal' ? String(k.value) : k?.type === 'PrivateIdentifier' ? `#${k.name}` : null);
const isFn = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

/** 関数の名前（無名なら、JSX の属性名・渡した先の関数名） */
function fnLabel(node, anc) {
  if (node.id?.name) return node.id.name;
  const p = anc[anc.length - 1];
  const gp = anc[anc.length - 2];
  if (p?.type === 'VariableDeclarator' && p.id?.type === 'Identifier') return p.id.name;
  if ((p?.type === 'Property' || p?.type === 'MethodDefinition' || p?.type === 'PropertyDefinition') && !p.computed) return keyName(p.key) ?? '(無名)';
  if (p?.type === 'JSXExpressionContainer' && gp?.type === 'JSXAttribute') return gp.name?.name ?? '(無名)';
  if (p?.type === 'CallExpression') {
    const c = p.callee;
    if (c?.type === 'Identifier') return c.name;
    if (c?.type === 'MemberExpression' && !c.computed) return keyName(c.property) ?? '(無名)';
  }
  return '(無名)';
}

/** その関数の中（入れ子の関数は除く）で、最初の await の位置 */
function firstAwait(fn) {
  let best = Infinity;
  const visit = (n, top) => {
    if (!n || typeof n.type !== 'string') return;
    if (!top && isFn(n)) return;
    if ((n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await)) && n.start < best) best = n.start;
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c, false);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, false);
    }
  };
  visit(fn.body, false);
  return best;
}

/**
 * ファイルを調べて、見つかった所を返す。used には、使った表の行（表の名前:キー）を入れる。
 * @returns {{ file: string; line: number; rule: string; msg: string }[]}
 */
export function checkSource(rel, src, used = new Set()) {
  const found = [];
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
  const add = (node, rule, msg) => found.push({ file: rel, line: lineOf(node.start), rule, msg });
  let ast;
  try {
    ast = parseAst(src, { lang: rel.endsWith('.tsx') ? 'tsx' : 'ts' });
  } catch (e) {
    return [{ file: rel, line: 1, rule: '読めない', msg: String(e.message) }];
  }
  /** 関数ごとの、GATED を呼んだ位置 */
  const gatedIn = new Map();
  const visit = (node, anc, labels) => {
    if (!node || typeof node.type !== 'string') return;
    let nextLabels = labels;
    if (isFn(node)) nextLabels = [...labels, fnLabel(node, anc)];
    // engine.ensure() など
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && !node.callee.computed) {
      const obj = node.callee.object;
      const name = keyName(node.callee.property);
      if (obj?.type === 'Identifier' && obj.name === 'engine' && GATED.has(name)) {
        const key = `${rel}#${labels.join('>') || '(ファイルの頭)'}`;
        used.add(`GESTURE_OK:${key}`);
        if (!has(GESTURE_OK, key)) {
          add(node, '操作の中', `engine.${name}() を呼ぶ所（${key}）が表にありません。タップ・キーの操作の中から呼ぶ所か確かめ、scripts/safari-check.mjs の GESTURE_OK に足してください（タイマー・読み込みのあと・購読の中からは呼ばない）`);
        }
        const fn = [...anc].reverse().find(isFn);
        if (fn) {
          const list = gatedIn.get(fn) ?? [];
          list.push({ node, name });
          gatedIn.set(fn, list);
        }
      }
      if (name === 'decodeAudioData' && has(DECODE_OK, rel)) used.add(`DECODE_OK:${rel}`);
      if (name === 'decodeAudioData' && !has(DECODE_OK, rel)) {
        add(node, '読み込み', '音の読み込みは engine.decodeAudio() を通してください（Safari では、タップの外で再生用の出力を作らないようオフラインで読みます）');
      }
    }
    // new AudioContext
    if (node.type === 'NewExpression') {
      const c = node.callee;
      const n = c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' ? keyName(c.property) : null;
      if ((n === 'AudioContext' || n === 'webkitAudioContext') && rel !== 'src/audio/engine.ts') {
        add(node, '出力', '再生用の AudioContext は src/audio/engine.ts の ensure() だけで作ります（読み込み・計算には OfflineAudioContext か engine.workCtx()）');
      }
      if (n === 'Audio' && has(MEDIA_OK, rel)) used.add(`MEDIA_OK:${rel}`);
      if (n === 'Audio' && !has(MEDIA_OK, rel)) {
        add(node, 'media', '<audio> を作る所は表 MEDIA_OK にありません。iPad はタップの中でしか鳴らせず、OGG は Safari 18.4 からです。確かめて足してください');
      }
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && keyName(node.callee.property) === 'createElement') {
      const a = node.arguments?.[0];
      if (a?.type === 'Literal' && (a.value === 'audio' || a.value === 'video') && has(MEDIA_OK, rel)) used.add(`MEDIA_OK:${rel}`);
      if (a?.type === 'Literal' && (a.value === 'audio' || a.value === 'video') && !has(MEDIA_OK, rel)) {
        add(node, 'media', `<${a.value}> を作る所は表 MEDIA_OK にありません。iPad はタップの中でしか鳴らせません。確かめて足してください`);
      }
    }
    // Safari に無い API（名前の参照と、'webkitdirectory' などの文字列）
    const apiName = node.type === 'Identifier' ? node.name : node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
    if (apiName && has(SAFARI_MISSING, apiName)) {
      const p = anc[anc.length - 1];
      // 型の宣言（interface の中など）は見ない
      const inType = anc.some((a) => TYPE_NODES.has(a.type));
      if (!inType && p?.type !== 'ImportSpecifier' && has(API_OK, rel)) used.add(`API_OK:${rel}`);
      else if (!inType && p?.type !== 'ImportSpecifier') {
        add(node, '無いAPI', `${apiName}: ${SAFARI_MISSING[apiName]}。使えるか確かめてから使い、無いときの道を用意して、表 API_OK に足してください`);
      }
    }
    const next = [...anc, node];
    for (const k of Object.keys(node)) {
      if (k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) visit(c, next, nextLabels);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, next, nextLabels);
    }
  };
  visit(ast, [], []);
  // await のあとで鳴らすなら、最初の await より前に一度呼んで出力を用意しておく
  for (const [fn, calls] of gatedIn) {
    const aw = firstAwait(fn);
    if (aw === Infinity) continue;
    const before = calls.some((c) => c.node.start < aw);
    if (before) continue;
    for (const c of calls) {
      if (c.node.start > aw) {
        add(c.node, 'await の前', `engine.${c.name}() を await のあとで呼んでいます。Safari は await のあとでは出力を起こせないので、最初の await より前に engine.ensure() を呼んでください`);
      }
    }
  }
  return found;
}

/** src 全体（または渡したファイル・フォルダ）を調べる。src 全体のときは、もう使っていない表の行も出す */
export function checkAll(targets = ['src']) {
  const files = targets.flatMap((t) => walk(join(root, t), [])).filter((f) => !/\/src\/bench\//.test(f));
  const out = [];
  const used = new Set();
  for (const f of files) {
    const rel = relative(root, f).split('\\').join('/');
    out.push(...checkSource(rel, readFileSync(f, 'utf8'), used));
  }
  if (targets.length === 1 && targets[0] === 'src') {
    for (const [name, table] of Object.entries({ GESTURE_OK, DECODE_OK, API_OK, MEDIA_OK })) {
      for (const k of Object.keys(table)) {
        if (!used.has(`${name}:${k}`)) out.push({ file: 'scripts/safari-check.mjs', line: 1, rule: '表', msg: `${name} の「${k}」はもう使われていません。消すか、名前を変えたなら直してください` });
      }
    }
  }
  return out;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2);
  const found = checkAll(args.length ? args : ['src']);
  for (const f of found) console.log(`${f.file}:${f.line}: [${f.rule}] ${f.msg}`);
  console.log(found.length ? `\nSafari で問題になりやすい所: ${found.length} か所（docs/safari.md）` : 'Safari で問題になりやすい所はありません');
  process.exitCode = found.length ? 1 : 0;
}
