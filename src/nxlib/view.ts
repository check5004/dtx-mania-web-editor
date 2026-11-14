// 「DTXMania の曲」の一覧の見せ方（しぼりこみ・並べ替え・BOX の数・空いた難易度の枠・set.def を作る／直す）。
// 画面からも試験からも使う、ファイルを触らない関数だけ。
import { checkFits, type BgmCheck } from './bgm';
import { relDtxPath } from './parse';
import { checkLevel, SLOT_KEYS, type LibBox, type LibChart, type LibSong, type SlotKey } from './scan';

export type NxSort = 'updated' | 'title' | 'artist' | 'bpm' | 'level' | 'checks';
export type NxFilter = 'missing' | 'bgmdrums' | 'edited' | 'ai' | 'drive' | 'synced' | 'draft' | 'checks';
/** synced（同期で変わった曲）は PC どうしの同期をしているときだけ出す */
export const NX_FILTERS: readonly NxFilter[] = ['missing', 'bgmdrums', 'edited', 'ai', 'drive', 'synced', 'draft', 'checks'];

/** しぼりこみと数に使う、一覧のほかの情報 */
export interface NxFilterCtx {
  /** 曲の id → 保存していない続きのある譜面 */
  drafts: Readonly<Record<string, readonly string[]>>;
  /** 同期で変わった曲（場所の鍵:曲のフォルダの並び。src/sync/store.ts の syncedSongs） */
  synced?: ReadonlySet<string>;
  /** 曲の id → BGM にドラムが入っているかを調べた結果（src/nxlib/bgm.ts） */
  bgm?: Readonly<Record<string, BgmCheck>>;
}

/** BOX のしぼりこみ：null はすべて、'' は BOX の外、ほかは BOX の鍵 */
export interface NxQuery extends NxFilterCtx {
  q: string;
  sort: NxSort;
  box: string | null;
  filter: NxFilter | null;
}

export const SLOT_LABEL: Record<SlotKey, string> = { BSC: 'BASIC', ADV: 'ADVANCED', EXT: 'EXTREME', MAS: 'MASTER' };

/** その枠の譜面 */
export function chartIn(s: LibSong, k: SlotKey): LibChart | undefined {
  return s.charts.find((c) => c.slot === k);
}

/** いちばん上の譜面（枠のある譜面のうちいちばん上。枠のある譜面が無ければ最後の譜面） */
export function topChart(s: LibSong): LibChart | undefined {
  for (const k of [...SLOT_KEYS].reverse()) {
    const c = chartIn(s, k);
    if (c) return c;
  }
  return s.charts[s.charts.length - 1];
}

/** 開ける譜面か（このエディタは .dtx だけ） */
export function canOpen(c: Pick<LibChart, 'file'>): boolean {
  return /\.dtx$/i.test(c.file);
}

/**
 * AI難易度生成で作れる空いた枠（いちばん上の譜面より下だけ）。いちばん上が .dtx のドラムの譜面のときだけ
 * （点検でドラムが無いと分かった曲・.gda などは作れない）
 */
export function addableSlots(s: LibSong): SlotKey[] {
  const top = topChart(s);
  if (!top?.slot || !canOpen(top) || s.drums === false) return [];
  const i = SLOT_KEYS.indexOf(top.slot);
  return SLOT_KEYS.slice(0, i).filter((k) => !chartIn(s, k));
}

/**
 * BGM を調べて、ステム分解をすすめられる曲か：いちばん上が .dtx のドラムの譜面（エディタで開いて分解する。
 * 点検でドラムが無いと分かった曲・.gda などは調べない）
 */
export function canSeparate(s: LibSong): boolean {
  const top = topChart(s);
  return !!top && canOpen(top) && s.drums !== false;
}

/** その曲の BGM を調べた結果（いまのいちばん上の譜面を調べたものだけ。まだ・譜面が変わったなら undefined） */
export function bgmOf(s: LibSong, bgm: NxFilterCtx['bgm']): BgmCheck | undefined {
  const c = bgm?.[s.id];
  return checkFits(c, topChart(s)) ? c : undefined;
}

/** BGM にドラムが入っていて、ステム分解（ドラム抜きの BGM）をすすめる曲か */
export function suggestsSeparation(s: LibSong, bgm: NxFilterCtx['bgm']): boolean {
  return canSeparate(s) && bgmOf(s, bgm)?.state === 'drums';
}

/** 枠の名前（AI難易度生成の難易度の名前） */
export const SLOT_OF_KEY: Record<SlotKey, 'BASIC' | 'ADVANCED' | 'EXTREME' | 'MASTER'> = { BSC: 'BASIC', ADV: 'ADVANCED', EXT: 'EXTREME', MAS: 'MASTER' };
export const KEY_OF_SLOT: Record<'BASIC' | 'ADVANCED' | 'EXTREME' | 'MASTER', SlotKey> = { BASIC: 'BSC', ADVANCED: 'ADV', EXTREME: 'EXT', MASTER: 'MAS' };

/**
 * あいだに作る（gen/insert）に渡す、枠ごとの譜面のレベル（無い枠は書かない。レベルの分からない譜面は null）。
 * 作れる曲（いちばん上がドラムの .dtx で、下に空いた枠がある）でなければ null
 */
export function slotLevels(s: LibSong): Partial<Record<'BASIC' | 'ADVANCED' | 'EXTREME' | 'MASTER', number | null>> | null {
  if (addableSlots(s).length === 0) return null;
  const out: Partial<Record<'BASIC' | 'ADVANCED' | 'EXTREME' | 'MASTER', number | null>> = {};
  for (const k of SLOT_KEYS) {
    const c = chartIn(s, k);
    if (c) out[SLOT_OF_KEY[k]] = c.head.level;
  }
  return out;
}

/** その枠を作る元の譜面（すぐ上にある譜面） */
export function sourceFor(s: LibSong, k: SlotKey): LibChart | undefined {
  const i = SLOT_KEYS.indexOf(k);
  for (const x of SLOT_KEYS.slice(i + 1)) {
    const c = chartIn(s, x);
    if (c && canOpen(c)) return c;
  }
  return undefined;
}

/** NX で困る点検の数（知らせるだけのものは数えない） */
export function warnCount(s: LibSong): number {
  return s.checks.filter((c) => checkLevel(c.kind) === 'warn').length;
}

export function hasFilter(s: LibSong, f: NxFilter, ctx: NxFilterCtx): boolean {
  switch (f) {
    case 'missing':
      return addableSlots(s).length > 0;
    case 'bgmdrums':
      return suggestsSeparation(s, ctx.bgm);
    case 'edited':
      return s.edited;
    case 'ai':
      return s.charts.some((c) => c.head.ai);
    case 'drive':
      // 成績だけ合わせている曲（PC どうしの同期）は入れない
      return s.drive?.state === 'linked' && !s.drive.play;
    case 'synced':
      return !!ctx.synced?.has(`${s.root}:${s.path.join('/')}`);
    case 'draft':
      return (ctx.drafts[s.id]?.length ?? 0) > 0;
    case 'checks':
      return s.checks.length > 0;
  }
}

const norm = (t: string) => t.normalize('NFKC').toLowerCase();

/** 曲名・アーティスト・フォルダで探す（空白で区切った言葉が全部入っている） */
export function matchQuery(s: LibSong, q: string): boolean {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm(`${s.title}\n${s.artist}\n${s.path.join('/')}\n${s.charts.map((c) => c.head.title).join('\n')}`);
  return words.every((w) => hay.includes(w));
}

export function inBox(s: LibSong, box: string | null): boolean {
  if (box === null) return true;
  if (box === '') return s.box.length === 0;
  return s.box.includes(box);
}

function topLevel(s: LibSong): number {
  return topChart(s)?.head.level ?? -1;
}

function bpmOf(s: LibSong): number {
  const n = parseFloat(s.bpm);
  return Number.isFinite(n) ? n : -1;
}

/** 点検の重さ（NX で困るものを先に） */
function checkWeight(s: LibSong): number {
  return warnCount(s) * 100 + s.checks.length;
}

const byText = (a: string, b: string) => a.localeCompare(b, 'ja', { sensitivity: 'base', numeric: true });

export function compareSongs(sort: NxSort): (a: LibSong, b: LibSong) => number {
  const tie = (a: LibSong, b: LibSong) => byText(a.title, b.title) || byText(a.path.join('/'), b.path.join('/'));
  switch (sort) {
    case 'updated':
      return (a, b) => b.updated - a.updated || tie(a, b);
    case 'title':
      return tie;
    case 'artist':
      return (a, b) => byText(a.artist, b.artist) || tie(a, b);
    case 'bpm':
      return (a, b) => bpmOf(b) - bpmOf(a) || tie(a, b);
    case 'level':
      return (a, b) => topLevel(b) - topLevel(a) || tie(a, b);
    case 'checks':
      return (a, b) => checkWeight(b) - checkWeight(a) || tie(a, b);
  }
}

export function viewSongs(songs: readonly LibSong[], o: NxQuery): LibSong[] {
  return songs.filter((s) => inBox(s, o.box) && (!o.filter || hasFilter(s, o.filter, o)) && matchQuery(s, o.q)).sort(compareSongs(o.sort));
}

/** BOX ごとの曲の数（中の BOX の曲も数える）。'' は BOX の外 */
export function boxCounts(songs: readonly LibSong[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of songs) {
    if (!s.box.length) m.set('', (m.get('') ?? 0) + 1);
    for (const b of s.box) m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

export function filterCounts(songs: readonly LibSong[], ctx: NxFilterCtx): Record<NxFilter, number> {
  const out = Object.fromEntries(NX_FILTERS.map((f) => [f, 0])) as Record<NxFilter, number>;
  for (const s of songs) for (const f of NX_FILTERS) if (hasFilter(s, f, ctx)) out[f]++;
  return out;
}

/** BGM を調べられる曲の数と、そのうち調べた曲の数（「BGM にドラム入り」のしぼりこみの知らせ） */
export function bgmCheckedCount(songs: readonly LibSong[], bgm: NxFilterCtx['bgm']): { can: number; checked: number } {
  let can = 0;
  let checked = 0;
  for (const s of songs) {
    if (!canSeparate(s)) continue;
    can++;
    if (bgmOf(s, bgm)) checked++;
  }
  return { can, checked };
}

/** 譜面の数（一覧の上に出す） */
export function chartCount(songs: readonly LibSong[]): number {
  return songs.reduce((a, s) => a + s.charts.length, 0);
}

// ---- set.def を作る・直す -------------------------------------------------------------

const L_INDEX: Record<SlotKey, number> = { BSC: 1, ADV: 2, EXT: 3, MAS: 4 };

/**
 * set.def の無い曲の set.def（NX で 1 曲にまとまる）。枠の譜面は L1〜L4、枠に入らない譜面は L5（1 つだけ）。
 * 曲名とファイル名は Shift_JIS で書く（呼ぶ側）
 */
export function setDefFor(title: string, charts: readonly Pick<LibChart, 'file' | 'slot'>[]): string {
  const lines = [`#TITLE ${title}`];
  const at = new Map<number, string>();
  for (const c of charts) if (c.slot) at.set(L_INDEX[c.slot], c.file);
  const extra = charts.find((c) => !c.slot);
  if (extra) at.set(5, extra.file);
  for (let i = 1; i <= 5; i++) {
    const f = at.get(i);
    if (!f) continue;
    const label = i === 5 ? 'DTXMANIA' : SLOT_LABEL[SLOT_KEYS[i - 1]];
    lines.push(`#L${i}LABEL ${label}`, `#L${i}FILE ${f.replace(/\//g, '\\')}`);
  }
  return lines.join('\r\n') + '\r\n';
}

/** set.def から、無い譜面の行（#LnFILE と同じブロックの #LnLABEL）を外す。ほかの行はそのまま */
export function fixSetDef(text: string, missing: readonly string[]): string {
  const gone = new Set(missing.map((f) => f.replace(/\\/g, '/').trim().toLowerCase()));
  const lines = text.split(/\r\n|\r|\n/);
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  // ブロック（#TITLE から次の #TITLE の前まで）ごとに、外す L の番号を決める
  const drop = new Set<number>();
  let start = 0;
  const flush = (end: number) => {
    const ns = new Set<string>();
    for (let i = start; i < end; i++) {
      const m = /^\s*#\s*L([1-5])FILE\s*:?\s*(.*?)\s*(;.*)?$/i.exec(lines[i]);
      if (m && gone.has(m[2].replace(/\\/g, '/').toLowerCase())) ns.add(m[1]);
    }
    for (let i = start; i < end; i++) {
      const m = /^\s*#\s*L([1-5])(?:FILE|LABEL)\b/i.exec(lines[i]);
      if (m && ns.has(m[1])) drop.add(i);
    }
  };
  lines.forEach((l, i) => {
    if (/^\s*#\s*TITLE\b/i.test(l) && i > start) {
      flush(i);
      start = i;
    }
  });
  flush(lines.length);
  return lines.filter((_, i) => !drop.has(i)).join(eol);
}

// ---- 探す場所 ------------------------------------------------------------------------

export interface RootSpec {
  /** 曲の id の頭（いちばん目の場所は ''） */
  key: string;
  /** DTXPath に書いてある形（「.\」「D:\DTX\」） */
  label: string;
  /** 選んだフォルダからのフォルダの並び。外のフォルダは null */
  rel: string[] | null;
  /** 外のフォルダなら、NxPlace.extra の番号 */
  extra?: number;
}

/**
 * 探す場所（NX と同じ：ゲームのフォルダなら DTXPath、DTXFiles を選んだならその中）。
 * DTXPath に重なる場所（「.\」と「.\DTXFiles\」）があれば、外側だけ探す（同じ曲を 2 回数えない）
 */
export function rootSpecs(place: { kind: 'game' | 'dtxfiles'; dtxPath: readonly string[]; extra: readonly { path: string }[] }): RootSpec[] {
  if (place.kind === 'dtxfiles') return [{ key: '', label: '.\\', rel: [] }];
  const inside: { label: string; rel: string[]; i: number }[] = [];
  place.dtxPath.forEach((p, i) => {
    const rel = relDtxPath(p);
    if (rel) inside.push({ label: p, rel, i });
  });
  const low = (r: string[]) => r.map((x) => x.toLowerCase());
  const under = (a: string[], b: string[]) => b.length <= a.length && low(b).every((x, j) => x === low(a)[j]);
  const keep = inside.filter((a, ai) => !inside.some((b, bi) => bi !== ai && under(a.rel, b.rel) && (b.rel.length < a.rel.length || bi < ai)));
  const out: RootSpec[] = keep.map((x, n) => ({ key: n === 0 ? '' : `p${x.i}`, label: x.label, rel: x.rel }));
  place.extra.forEach((x, j) => out.push({ key: `x${j}`, label: x.path, rel: null, extra: j }));
  return out;
}

// ---- 新しい曲を保存する所 ---------------------------------------------------------------

type PlaceLike = { kind: 'game' | 'dtxfiles'; name: string; dtxPath: readonly string[]; extra: readonly { path: string }[] };

/** 保存の画面の BOX の札（入れ子は「外 › 中」） */
export function saveBoxLabel(b: LibBox, boxes: readonly LibBox[]): string {
  const names = [b.title];
  for (let p = b.parent, n = 0; p && n < 8; n++) {
    const up = boxes.find((x) => x.key === p);
    if (!up) break;
    names.unshift(up.title);
    p = up.parent;
  }
  return names.join(' › ');
}

/** BOX の鍵の場所の鍵（「p1:rock」→「p1」） */
export function boxRootKey(b: Pick<LibBox, 'key' | 'root'>): string {
  return b.root ?? b.key.slice(0, b.key.indexOf(':'));
}

/** BOX の、場所からのフォルダの並び（前の版の一覧は小文字の並び） */
export function boxRel(b: Pick<LibBox, 'key' | 'path'>): string[] {
  return b.path ?? b.key.slice(b.key.indexOf(':') + 1).split('/').filter(Boolean);
}

/**
 * BOX の外に保存するときの、いちばん目の場所からのフォルダ。ゲームのフォルダそのもの（DTXPath が「.\」）なら、
 * exe の横に広げないよう DTXFiles の中（綴りは一覧から。無ければ作る）
 */
export function outsideRel(place: PlaceLike, songs: readonly Pick<LibSong, 'root' | 'path'>[], boxes: readonly Pick<LibBox, 'key' | 'root' | 'path'>[]): string[] {
  const spec = rootSpecs(place)[0];
  if (place.kind !== 'game' || !spec?.rel || spec.rel.length > 0) return [];
  const seen = [...songs.filter((s) => s.root === '').map((s) => s.path[0]), ...boxes.filter((b) => boxRootKey(b) === '').map((b) => b.path?.[0])];
  return [seen.find((n) => n?.toLowerCase() === 'dtxfiles') ?? 'DTXFiles'];
}

/**
 * 保存する所（曲のフォルダの外側）の、場所の名前からのフォルダの並び（「DTXManiaNX › DTXFiles › オリジナル」）。
 * box は BOX の鍵（'' は BOX の外）、newBox は BOX の外に新しく作る BOX の名前
 */
export function saveWhere(place: PlaceLike, songs: readonly Pick<LibSong, 'root' | 'path'>[], boxes: readonly LibBox[], box: string, newBox?: string): string[] {
  const specs = rootSpecs(place);
  const b = box ? boxes.find((x) => x.key === box) : undefined;
  const spec = (b && specs.find((s) => s.key === boxRootKey(b))) || specs[0];
  const head = spec?.rel ? [place.name, ...spec.rel] : [spec?.label ?? place.name];
  const rel = b ? boxRel(b) : outsideRel(place, songs, boxes);
  return [...head, ...rel, ...(!b && newBox ? [newBox] : [])];
}

// ---- 表示の文字 --------------------------------------------------------------------

/** BPM（「128.00」は「128」） */
export function bpmText(bpm: string): string {
  const n = parseFloat(bpm);
  if (!Number.isFinite(n) || n <= 0) return bpm.trim();
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** レベル（8.25 → 「8.25」。書いていなければ「?」） */
export function levelText(level: number | null): string {
  return level === null ? '?' : level.toFixed(2);
}

/** 大きさ（「412 MB」「1.3 GB」） */
export function bytesText(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  // 10 MB より小さいときは小数 1 けた（空きと大きさを比べるとき、丸めで同じに見えないように）
  if (n >= 1 << 20) return n < 10 * (1 << 20) ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / (1 << 20))} MB`;
  // 0 は 0 KB（中身があれば 1 KB より小さくても 1 KB）
  return `${n > 0 ? Math.max(1, Math.round(n / 1024)) : 0} KB`;
}
