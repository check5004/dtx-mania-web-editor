// DTXMania の曲（ゲームのフォルダ・DTXFiles）を、DTXManiaNX と同じ探し方で一覧にする（CSongManager と同じ決まり）。
// - set.def があるフォルダ：#TITLE ごとに 1 曲。#L1〜#L5 が難易度。書いてある譜面が無い難易度は出さない（NX と同じ）
// - set.def が無いフォルダ：NX は譜面 1 つずつを別の曲にする。ここではフォルダで 1 曲にまとめ、譜面が 2 つ以上なら点検に出す
// - 名前が「DTXFiles.」で始まるフォルダと box.def のあるフォルダは BOX。そのほかのフォルダは素通り（曲名のフォルダが二重でも中を探す）
// - set.def のあるフォルダの下も探す（NX と同じ）
// 読むのは名前と小さいファイル（set.def・box.def・譜面の頭・*.score.ini・つなぎの記録）だけ。何も書かない。
// 前の一覧（prev）があれば、大きさと更新時刻が同じ譜面は読み直さない。
import { normPath, parseSetDef } from '../fs/folder';
import { CHART_EXT } from '../fs/songDir';
import { slotOf } from '../gen/targets';
import { boxTitleOf, decodeHead, dotBoxName, headIncomplete, parseScoreIni, readChartHead, type ChartHead, type RefGroup, type ScoreRec } from './parse';

/** 一覧の難易度の枠（易しい順） */
export type SlotKey = 'BSC' | 'ADV' | 'EXT' | 'MAS';
export const SLOT_KEYS: readonly SlotKey[] = ['BSC', 'ADV', 'EXT', 'MAS'];

export interface LibChart {
  /** 曲のフォルダからのパス（元の綴り） */
  file: string;
  /** set.def の難易度名（set.def が無ければ ''） */
  label: string;
  /** set.def の L の番号（1〜5。set.def が無ければ 0） */
  index: number;
  /** 一覧の枠（入らない譜面は null。「+1」に数える） */
  slot: SlotKey | null;
  head: ChartHead;
  /** 成績（*.score.ini が無ければ null） */
  score: ScoreRec | null;
  size: number;
  mtime: number;
}

export type CheckKind = 'nosetdef' | 'setdef-missing' | 'missing' | 'badname' | 'dup' | 'nopreview' | 'noimage' | 'nodrums';

export interface LibCheck {
  kind: CheckKind;
  /** 数（見つからないファイルの数など） */
  n?: number;
  /** ファイルの名前（見つからない物など。先頭のいくつか） */
  files?: string[];
}

/** 点検で困る度合い（warn は NX で困る、info は知らせるだけ） */
export function checkLevel(k: CheckKind): 'warn' | 'info' {
  return k === 'nopreview' || k === 'noimage' || k === 'nodrums' ? 'info' : 'warn';
}

export interface LibDrive {
  /** linked：Drive とつないだ。skip：この曲は送らない */
  state: 'linked' | 'skip';
  /** Drive に送ったファイルの大きさの合計 */
  bytes: number;
  /** 動画を除いて送っている */
  noVideo?: boolean;
}

export interface LibSong {
  /** 一覧の中で 1 つ（場所の鍵・曲のフォルダのパス・set.def のブロックの番号） */
  id: string;
  /** どの場所の曲か（ScanRoot の key） */
  root: string;
  /** 場所からの曲のフォルダの並び（元の綴り） */
  path: string[];
  /** set.def の何番目の #TITLE か（無ければ 0） */
  block: number;
  title: string;
  artist: string;
  bpm: string;
  /** 入っている BOX の鍵（外から順に） */
  box: string[];
  /** 譜面（易しい順） */
  charts: LibChart[];
  setDef: boolean;
  /** 画像（曲のフォルダからのパス。無ければ ''） */
  image: string;
  imageSig: string;
  /** 試聴（曲のフォルダからのパス。無ければ ''） */
  preview: string;
  /** 譜面・set.def のいちばん新しい更新時刻 */
  updated: number;
  /** このアプリの作業ファイル（.dtxe.json）がある */
  edited: boolean;
  drive: LibDrive | null;
  /** 曲名のフォルダが二重（外のフォルダが同じ名前で、ほかに何も無い） */
  doubled: boolean;
  checks: LibCheck[];
  /** 点検（譜面を全部読む）を済ませた譜面の印。譜面が変わったら点検し直す */
  checkedSig?: string;
  /** 譜面が使うファイル（点検で読んだもの） */
  refs?: RefGroup[];
  /** ドラムのチップがある（点検で読んだもの。まだなら undefined） */
  drums?: boolean;
}

export interface LibBox {
  /** 場所の鍵とフォルダのパス */
  key: string;
  title: string;
  /** フォルダの名前（DTXFiles.EDM など） */
  dirName: string;
  /** 「DTXFiles.」で始まる名前の BOX */
  dot: boolean;
  /** 外の BOX（無ければ null） */
  parent: string | null;
  depth: number;
  /** 場所の鍵と、場所からのフォルダの並び（元の綴り。前の版の一覧には無い） */
  root?: string;
  path?: string[];
}

export interface ScanRoot {
  dir: FileSystemDirectoryHandle;
  /** 曲の id の頭に付ける（いちばん目の場所は ''） */
  key: string;
}

export interface ScanProgress {
  folders: number;
  songs: number;
}

export interface ScanOptions {
  /** 前の一覧（id → 曲）。同じ譜面は読み直さない */
  prev?: ReadonlyMap<string, LibSong>;
  onProgress?: (p: ScanProgress) => void;
  /** 見つけた曲（読み込み中に一覧へ出す） */
  onSong?: (s: LibSong) => void;
  /** 画像のファイル（一覧の小さい画像を作る。sig は大きさと更新時刻） */
  onImage?: (songId: string, file: FileSystemFileHandle, sig: string) => void;
  /** true になったら途中でやめる */
  stopped?: () => boolean;
  concurrency?: number;
  /** 前の一覧と同じ譜面も読み直す（「読み直す」。点検の結果は譜面が同じなら残す） */
  reread?: boolean;
  /** どこまで下のフォルダを探すか（0 は選んだフォルダだけ。1 曲を読み直すとき） */
  maxDepth?: number;
}

export interface ScanResult {
  songs: LibSong[];
  boxes: LibBox[];
  folders: number;
  /** 途中でやめた */
  stopped: boolean;
}

const HEAD_BYTES = 64 * 1024;
const MAX_DEPTH = 16;
const MAX_FOLDERS = 80000;
export const LINK_NAME = '.dtxe-drive.json';

export function songIdOf(root: string, path: readonly string[], block: number): string {
  return `${root}:${normPath(path.join('/'))}#${block}`;
}

export function boxKeyOf(root: string, path: readonly string[]): string {
  return `${root}:${normPath(path.join('/'))}`;
}

function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  return n(a) === n(b);
}

async function readText(fh: FileSystemFileHandle): Promise<string> {
  return decodeHead(new Uint8Array(await (await fh.getFile()).arrayBuffer()), true);
}

/** 曲のフォルダの中のファイル（サブフォルダの中も）を、名前の大文字・小文字を見ずに探す */
async function resolveIn(dir: FileSystemDirectoryHandle, files: ReadonlyMap<string, FileSystemFileHandle>, rel: string): Promise<{ handle: FileSystemFileHandle; path: string } | null> {
  const parts = rel.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  if (parts.length === 1) {
    const h = files.get(parts[0].toLowerCase());
    return h ? { handle: h, path: h.name } : null;
  }
  let cur = dir;
  const real: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let found: FileSystemHandle | null = null;
    try {
      for await (const [name, h] of cur.entries()) {
        if (name.toLowerCase() === parts[i].toLowerCase()) {
          found = h;
          break;
        }
      }
    } catch {
      return null;
    }
    if (!found) return null;
    real.push(found.name);
    if (i === parts.length - 1) return found.kind === 'file' ? { handle: found as FileSystemFileHandle, path: real.join('/') } : null;
    if (found.kind !== 'directory') return null;
    cur = found as FileSystemDirectoryHandle;
  }
  return null;
}

/**
 * 譜面を一覧の枠に入れる。難易度名（無ければファイル名）で分かる譜面はその枠、set.def の L1〜L4 はその枠、
 * 分からない譜面はレベルの高い順に、上の空いた枠から（入れた枠の並びとレベルの並びが逆にならない枠だけ）。
 * 入らない譜面は null（「+1」）
 */
export function assignSlots<T extends { label: string; file: string; index: number; slot: SlotKey | null; head: { level: number | null } }>(charts: T[]): void {
  const taken = new Map<SlotKey, number | null>();
  const byName: Record<string, SlotKey> = { BASIC: 'BSC', ADVANCED: 'ADV', EXTREME: 'EXT', MASTER: 'MAS' };
  const rest: T[] = [];
  for (const c of charts) {
    const s = slotOf(c.label || undefined, c.file.split('/').pop() ?? c.file);
    const k = s ? byName[s] : undefined;
    if (k && !taken.has(k)) {
      c.slot = k;
      taken.set(k, c.head.level);
    } else rest.push(c);
  }
  const left: T[] = [];
  for (const c of rest) {
    const k = c.index >= 1 && c.index <= 4 ? SLOT_KEYS[c.index - 1] : undefined;
    if (k && !taken.has(k)) {
      c.slot = k;
      taken.set(k, c.head.level);
    } else left.push(c);
  }
  left.sort((a, b) => (b.head.level ?? -1) - (a.head.level ?? -1));
  const fits = (k: SlotKey, lv: number | null) => {
    if (taken.has(k)) return false;
    if (lv === null) return true;
    const i = SLOT_KEYS.indexOf(k);
    for (const [s, l] of taken) {
      if (l === null) continue;
      const j = SLOT_KEYS.indexOf(s);
      // 上の枠に低いレベル、下の枠に高いレベルがあれば入れない
      if ((j > i && l < lv) || (j < i && l > lv)) return false;
    }
    return true;
  };
  for (const c of left) {
    const k = [...SLOT_KEYS].reverse().find((x) => fits(x, c.head.level));
    c.slot = k ?? null;
    if (k) taken.set(k, c.head.level);
  }
}

/** 易しい順（枠の順、枠の無い譜面は後ろ） */
function bySlot(a: LibChart, b: LibChart): number {
  const r = (c: LibChart) => (c.slot ? SLOT_KEYS.indexOf(c.slot) : 9);
  return r(a) - r(b) || a.index - b.index || a.file.localeCompare(b.file);
}

interface Task {
  dir: FileSystemDirectoryHandle;
  root: string;
  path: string[];
  boxes: string[];
  depth: number;
  /** 外のフォルダの名前と、外のフォルダにほかに何も無いか（曲名のフォルダが二重かを見る） */
  parentName: string | null;
  onlyChild: boolean;
}

/** 仕事を n 個ずつ並べて進める（仕事から仕事が増える） */
function runPool<T>(first: T[], n: number, work: (t: T, push: (t: T) => void) => Promise<void>, stopped: () => boolean): Promise<void> {
  const queue = [...first];
  let active = 0;
  return new Promise<void>((resolve) => {
    const next = () => {
      while (!stopped() && active < n && queue.length) {
        const t = queue.shift()!;
        active++;
        void work(t, (x) => queue.push(x))
          .catch(() => {
            // 読めないフォルダは飛ばす
          })
          .finally(() => {
            active--;
            next();
          });
      }
      if (active === 0 && (queue.length === 0 || stopped())) resolve();
    };
    next();
  });
}

/** 譜面を読む（前と同じ大きさ・更新時刻なら読み直さない） */
async function readChart(fh: FileSystemFileHandle, prev: LibChart | undefined): Promise<{ head: ChartHead; size: number; mtime: number }> {
  const file = await fh.getFile();
  if (prev && prev.size === file.size && prev.mtime === file.lastModified) return { head: prev.head, size: file.size, mtime: file.lastModified };
  const whole = file.size <= HEAD_BYTES;
  let head = readChartHead(decodeHead(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()), whole));
  if (!whole && headIncomplete(head)) head = readChartHead(decodeHead(new Uint8Array(await file.arrayBuffer()), true));
  return { head, size: file.size, mtime: file.lastModified };
}

async function readScore(files: ReadonlyMap<string, FileSystemFileHandle>, chart: string): Promise<ScoreRec | null> {
  const fh = files.get(`${chart.split('/').pop()!.toLowerCase()}.score.ini`);
  if (!fh) return null;
  try {
    return parseScoreIni(await readText(fh));
  } catch {
    return null;
  }
}

async function readDrive(files: ReadonlyMap<string, FileSystemFileHandle>): Promise<LibDrive | null> {
  const fh = files.get(LINK_NAME);
  if (!fh) return null;
  try {
    const j = JSON.parse(await (await fh.getFile()).text()) as { folderId?: string; skip?: boolean; noVideo?: boolean; files?: Record<string, { size?: number }> };
    if (typeof j.folderId === 'string' && j.folderId) {
      const bytes = Object.values(j.files ?? {}).reduce((a, f) => a + (Number(f?.size) || 0), 0);
      return { state: 'linked', bytes, ...(j.noVideo ? { noVideo: true } : {}) };
    }
    if (j.skip) return { state: 'skip', bytes: 0 };
  } catch {
    // 読めない記録は無いのと同じ
  }
  return null;
}

/** 文字の番号の順（いつも同じ順にする） */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function scanLibrary(roots: readonly ScanRoot[], o: ScanOptions = {}): Promise<ScanResult> {
  const stopped = o.stopped ?? (() => false);
  const songs: LibSong[] = [];
  const boxes = new Map<string, LibBox>();
  let folders = 0;
  const progress = () => o.onProgress?.({ folders, songs: songs.length });

  const work = async (t: Task, push: (t: Task) => void) => {
    if (folders >= MAX_FOLDERS) return;
    const files = new Map<string, FileSystemFileHandle>();
    const dirs: [string, FileSystemDirectoryHandle][] = [];
    for await (const [name, h] of t.dir.entries()) {
      if (h.kind === 'file') files.set(name.toLowerCase(), h as FileSystemFileHandle);
      else dirs.push([name, h as FileSystemDirectoryHandle]);
    }
    folders++;
    // BOX（選んだ場所そのものは BOX にしない）
    let inBoxes = t.boxes;
    if (t.depth > 0) {
      const name = t.path[t.path.length - 1];
      const dot = dotBoxName(name);
      let title: string | null = dot;
      if (title === null && files.has('box.def')) {
        try {
          title = boxTitleOf(await readText(files.get('box.def')!)) || name;
        } catch {
          title = name;
        }
      }
      if (title !== null) {
        const key = boxKeyOf(t.root, t.path);
        boxes.set(key, { key, title: title || name, dirName: name, dot: dot !== null, parent: t.boxes[t.boxes.length - 1] ?? null, depth: t.boxes.length, root: t.root, path: [...t.path] });
        inBoxes = [...t.boxes, key];
      }
    }
    // 曲
    const found = await songsHere(t, files, inBoxes, o);
    for (const s of found) {
      songs.push(s);
      o.onSong?.(s);
    }
    progress();
    if (t.depth >= Math.min(MAX_DEPTH, o.maxDepth ?? MAX_DEPTH)) return;
    const songMark = found.length > 0 || files.has('set.def') || [...files.keys()].some((n) => CHART_EXT.test(n));
    const onlyChild = dirs.length === 1 && !songMark;
    dirs.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, h] of dirs) push({ dir: h, root: t.root, path: [...t.path, name], boxes: inBoxes, depth: t.depth + 1, parentName: t.depth > 0 ? t.path[t.path.length - 1] : null, onlyChild });
  };

  await runPool<Task>(
    roots.map((r) => ({ dir: r.dir, root: r.key, path: [], boxes: [], depth: 0, parentName: null, onlyChild: false })),
    Math.max(1, o.concurrency ?? 6),
    work,
    stopped,
  );
  markDuplicates(songs);
  songs.sort((a, b) => byCode(a.id, b.id));
  return { songs, boxes: [...boxes.values()].sort((a, b) => byCode(a.key, b.key)), folders, stopped: stopped() };
}

/** このフォルダの曲（set.def のブロックごと。set.def が無ければ譜面をまとめて 1 曲） */
async function songsHere(t: Task, files: ReadonlyMap<string, FileSystemFileHandle>, inBoxes: string[], o: ScanOptions): Promise<LibSong[]> {
  const blocks: { title: string; charts: { file: string; label: string; index: number; handle: FileSystemFileHandle }[]; missing: string[] }[] = [];
  const setDefH = files.get('set.def');
  let setDefTime = 0;
  if (setDefH) {
    let text = '';
    try {
      const f = await setDefH.getFile();
      setDefTime = f.lastModified;
      text = decodeHead(new Uint8Array(await f.arrayBuffer()), true);
    } catch {
      text = '';
    }
    for (const b of parseSetDef(text)) {
      const charts: (typeof blocks)[number]['charts'] = [];
      const missing: string[] = [];
      for (const l of b.levels) {
        const r = await resolveIn(t.dir, files, l.file);
        if (r) charts.push({ file: r.path, label: l.label, index: l.index ?? 0, handle: r.handle });
        else missing.push(l.file);
      }
      blocks.push({ title: b.title, charts, missing });
    }
  } else {
    const charts = [...files.values()]
      .filter((h) => CHART_EXT.test(h.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((h) => ({ file: h.name, label: '', index: 0, handle: h }));
    if (charts.length) blocks.push({ title: '', charts, missing: [] });
  }
  if (!blocks.some((b) => b.charts.length)) return [];
  const edited = [...files.keys()].some((n) => n.endsWith('.dtxe.json'));
  const drive = await readDrive(files);
  const doubled = !!t.parentName && t.onlyChild && sameName(t.path[t.path.length - 1] ?? '', t.parentName);
  const out: LibSong[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    // 譜面が 1 つも無い #TITLE は NX も出さない
    if (!b.charts.length) continue;
    const id = songIdOf(t.root, t.path, bi);
    const prev = o.prev?.get(id);
    const charts: LibChart[] = [];
    for (const c of b.charts) {
      try {
        const r = await readChart(c.handle, o.reread ? undefined : prev?.charts.find((x) => x.file.toLowerCase() === c.file.toLowerCase()));
        charts.push({ file: c.file, label: setDefH ? c.label : '', index: c.index, slot: null, head: r.head, score: await readScore(files, c.file), size: r.size, mtime: r.mtime });
      } catch {
        // 読めない譜面は飛ばす
      }
    }
    if (!charts.length) continue;
    assignSlots(charts);
    charts.sort(bySlot);
    const top = [...charts].reverse();
    const pick = (f: (h: ChartHead) => string) => top.map((c) => f(c.head)).find((v) => v.trim()) ?? '';
    // 画像と試聴（上の難易度から、ファイルがあるもの）
    let image = '';
    let imageSig = '';
    for (const key of ['preimage', 'stagefile'] as const) {
      for (const c of top) {
        const p = c.head[key];
        if (!p || image) continue;
        const r = await resolveIn(t.dir, files, p);
        if (!r) continue;
        try {
          const f = await r.handle.getFile();
          image = r.path;
          imageSig = `${f.size}:${f.lastModified}`;
          o.onImage?.(id, r.handle, imageSig);
        } catch {
          // 読めない画像は無いのと同じ
        }
      }
    }
    let preview = '';
    for (const c of top) {
      if (!c.head.preview || preview) continue;
      const r = await resolveIn(t.dir, files, c.head.preview);
      if (r) preview = r.path;
    }
    const checks: LibCheck[] = [];
    if (b.missing.length) checks.push({ kind: 'setdef-missing', n: b.missing.length, files: b.missing.slice(0, 8) });
    if (!setDefH && charts.length >= 2) checks.push({ kind: 'nosetdef', n: charts.length });
    // 書いてあるのにファイルが無いときは、点検の「見つからない」に出す（ここでは書いていない曲だけ）
    if (!preview && !charts.some((c) => c.head.preview)) checks.push({ kind: 'nopreview' });
    if (!image && !charts.some((c) => c.head.preimage || c.head.stagefile)) checks.push({ kind: 'noimage' });
    const sig = chartsSig(charts);
    const keep = prev && prev.checkedSig === sig ? prev : undefined;
    out.push({
      id,
      root: t.root,
      path: t.path,
      block: bi,
      title: b.title.trim() || pick((h) => h.title) || t.path[t.path.length - 1] || t.dir.name,
      artist: pick((h) => h.artist),
      bpm: pick((h) => h.bpm),
      box: inBoxes,
      charts,
      setDef: !!setDefH,
      image,
      imageSig,
      preview,
      updated: Math.max(setDefTime, ...charts.map((c) => c.mtime)),
      edited,
      drive,
      doubled,
      checks,
      // 前の点検の結果（譜面が同じなら、点検し直すまでそのまま出す）
      ...(keep ? { checkedSig: keep.checkedSig, refs: keep.refs, drums: keep.drums } : {}),
    });
  }
  return out;
}

/** 譜面の印（点検をし直すか） */
export function chartsSig(charts: readonly Pick<LibChart, 'file' | 'size' | 'mtime'>[]): string {
  return charts.map((c) => `${c.file.toLowerCase()}:${c.size}:${c.mtime}`).join('|');
}

/** 同じ曲（曲名とアーティストが同じ）が 2 つ以上 */
export function markDuplicates(songs: LibSong[]): void {
  const key = (s: LibSong) => `${s.title.normalize('NFKC').trim().toLowerCase()}\u0000${s.artist.normalize('NFKC').trim().toLowerCase()}`;
  const groups = new Map<string, LibSong[]>();
  for (const s of songs) {
    s.checks = s.checks.filter((c) => c.kind !== 'dup');
    if (!s.title.trim()) continue;
    const k = key(s);
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const s of g) s.checks.push({ kind: 'dup', n: g.length - 1 });
  }
}
