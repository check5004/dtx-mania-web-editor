// 曲フォルダと Google Drive の曲フォルダを合わせる。
// - Drive には「DTX Web Editor」フォルダを作り、その中に曲フォルダと同じ並び（サブフォルダも）で置く。Drive の画面からそのまま落として NX で使える。
// - どのファイルを合わせたかは、曲フォルダの中の .dtxe-drive.json に書く（Drive のファイル id と MD5）。PC の曲フォルダでも本体の曲でも同じ。
// - 変わったかは MD5 で比べる（Drive は md5Checksum を持つ）。大きさと更新時刻が前に合わせた時と同じなら計算しない。
// - 両方で変わったファイルは、保存のときだけ聞く（自動保存のときは送らずに置いておく）。消したファイルは消さない（Drive に残す）。
// - 自動保存（まだ保存していない続き）は .dtxe-autosave/<譜面>.json に送る。どの版の譜面への続きか（base = 譜面の MD5）も書く。
// - 合わせるのは曲のファイルだけ。曲フォルダの中の「ほかの曲のフォルダ」（譜面などがあるサブフォルダ。src/fs/songDir.ts）は
//   送らない・取らない。ほかの曲も入ったフォルダ（DTXFiles など）は丸ごと送らない（間違って選んだときに数百曲を送らないため）。
//   Drive の曲フォルダに入ってしまったほかの曲（JunkDir）は、知らせてゴミ箱に移せるようにする。
import { pl, tr } from '../i18n';
import { normPath, writeFile, type FolderFile, type SongFolder } from '../fs/folder';
import { inDirs, isSongMark, otherSongDirs } from '../fs/songDir';
import { createFolder, download, downloadText, DriveError, FOLDER_MIME, getFile, listChildren, listFiles, trashFile, updateMeta, upload, type DriveFile } from './api';
import { md5Blob } from './md5';

export const LINK_FILE = '.dtxe-drive.json';
export const AUTOSAVE_DIR = '.dtxe-autosave';
const ROOT_NAME = 'DTX Web Editor';
const ROOT_QUERY = `appProperties has { key='dtxe' and value='root' } and mimeType = '${FOLDER_MIME}' and trashed = false`;
/** 曲のフォルダ（「DTX Web Editor」の直下にも、PC どうしの同期の「DTXFiles/<BOX>/」の中にもある） */
export const SONG_QUERY = `appProperties has { key='dtxe' and value='song' } and mimeType = '${FOLDER_MIME}' and trashed = false`;

/** Drive と合わせるファイルか（つなぎの記録・自動保存・書き込み途中のファイル・OS のファイルは除く） */
export function syncedPath(path: string): boolean {
  const low = path.replace(/\\/g, '/').toLowerCase();
  if (low === LINK_FILE || low === AUTOSAVE_DIR || low.startsWith(`${AUTOSAVE_DIR}/`)) return false;
  const name = low.split('/').pop() ?? '';
  return !(name.endsWith('.crswap') || name === '.ds_store' || name === 'thumbs.db' || name === 'desktop.ini');
}

// ---- つなぎの記録（.dtxe-drive.json） ---------------------------------------------

export interface LinkRec {
  id: string;
  md5: string;
  size: number;
  /** 合わせたときの、この端末でのファイルの更新時刻（同じなら MD5 を計算し直さない） */
  mtime: number;
  path: string;
}

export interface DriveLink {
  v: 1;
  folderId: string;
  name: string;
  /** 正規化したパス → 前に合わせたファイル */
  files: Record<string, LinkRec>;
  /** 自動保存のフォルダと、譜面ごとのファイル（「譜面の名前.json」の小文字 → Drive の id） */
  autosaveDir?: string;
  autosave?: Record<string, string>;
  syncedAt: number;
  /** 動画（.mp4 など）は送らない（大きい曲を初めて送るときに「動画を除いて送る」を選んだ）。動画はこの端末の曲フォルダに残る */
  noVideo?: boolean;
  /** PC どうしの同期（src/sync/）：前に合わせたときの成績（譜面のパスの小文字 → score.ini の中身）。両方で遊んだら、ここから増えた分を足す */
  scores?: Record<string, string>;
  /** scores の中身を取ったときのファイルの MD5（違えば取り直す。ほかの取り込みで変わったとき） */
  scoresMd5?: Record<string, string>;
  /** PC どうしの同期：成績だけ合わせる曲（作るファイルは送りも取りもしない） */
  play?: boolean;
  /** PC どうしの同期：初めて合わせたときに聞いて、まだ答えていないファイル（鍵） */
  ask?: string[];
}

export function newLink(folderId: string, name: string): DriveLink {
  return { v: 1, folderId, name, files: {}, syncedAt: 0 };
}

export function parseLink(text: string): DriveLink | null {
  try {
    const j = JSON.parse(text) as Partial<DriveLink>;
    if (j?.v !== 1 || typeof j.folderId !== 'string' || !j.folderId) return null;
    return {
      v: 1,
      folderId: j.folderId,
      name: String(j.name ?? ''),
      files: j.files && typeof j.files === 'object' ? j.files : {},
      autosaveDir: typeof j.autosaveDir === 'string' ? j.autosaveDir : undefined,
      autosave: j.autosave && typeof j.autosave === 'object' ? j.autosave : undefined,
      syncedAt: Number(j.syncedAt) || 0,
      ...(j.noVideo === true ? { noVideo: true } : {}),
      ...(j.scores && typeof j.scores === 'object' ? { scores: j.scores } : {}),
      ...(j.scoresMd5 && typeof j.scoresMd5 === 'object' ? { scoresMd5: j.scoresMd5 } : {}),
      ...(j.play === true ? { play: true } : {}),
      ...(Array.isArray(j.ask) ? { ask: j.ask.filter((x): x is string => typeof x === 'string') } : {}),
    };
  } catch {
    return null;
  }
}

export async function readLink(folder: SongFolder): Promise<DriveLink | null> {
  const f = folder.files.get(LINK_FILE);
  if (!f) return null;
  try {
    return parseLink(await (await f.getFile()).text());
  } catch {
    return null;
  }
}

export async function writeLink(folder: SongFolder, link: DriveLink): Promise<void> {
  await writeFile(folder, LINK_FILE, new TextEncoder().encode(JSON.stringify(link)));
}

/**
 * 「この曲は Drive に送らない」の印（つないでいない曲の .dtxe-drive.json に {v:1, skip:true}）。
 * 保存しても送らない。押して送ったら、つなぎの記録で上書きされて消える
 */
export function isSkipText(text: string): boolean {
  try {
    const j = JSON.parse(text) as { skip?: unknown; folderId?: unknown };
    return j?.skip === true && !j.folderId;
  } catch {
    return false;
  }
}

export async function readDriveSkip(folder: SongFolder): Promise<boolean> {
  const f = folder.files.get(LINK_FILE);
  if (!f) return false;
  try {
    return isSkipText(await (await f.getFile()).text());
  } catch {
    return false;
  }
}

export async function writeDriveSkip(folder: SongFolder): Promise<void> {
  await writeFile(folder, LINK_FILE, new TextEncoder().encode(JSON.stringify({ v: 1, skip: true })));
}

// ---- どうするかを決める（純粋な関数） ----------------------------------------------

export interface RemoteEntry {
  id: string;
  path: string;
  md5: string;
  size: number;
  modifiedTime: string;
  /** 送った PC の名前（PC どうしの同期で送ったファイル） */
  dev?: string;
}

export interface LocalEntry {
  path: string;
  /** 分かっていれば（計算した・前と同じ） */
  md5?: string;
}

export type Step =
  /** 送る（id があれば上書き） */
  | { op: 'up'; key: string; path: string; id?: string }
  /** 取る */
  | { op: 'down'; key: string; path: string; remote: RemoteEntry }
  /** 同じ（記録だけ直す） */
  | { op: 'same'; key: string; path: string; remote: RemoteEntry }
  /** 両方で変わった */
  | { op: 'conflict'; key: string; path: string; remote: RemoteEntry }
  /** 送るときに、Drive の方が新しい・Drive にだけある（取り込みを勧める） */
  | { op: 'newer'; key: string; path: string; remote: RemoteEntry };

/**
 * push：この端末 → Drive。pull：Drive → この端末。
 * 前に合わせた MD5（recs）と比べて、どちらで変わったかを見る
 */
export function planSync(local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, recs: Record<string, LinkRec>, mode: 'push' | 'pull'): Step[] {
  const out: Step[] = [];
  for (const [key, l] of local) {
    const r = remote.get(key);
    const rec = recs[key];
    if (!r) {
      if (mode === 'push') out.push({ op: 'up', key, path: l.path });
      continue;
    }
    const lm = l.md5 ?? rec?.md5;
    if (lm && lm === r.md5) {
      out.push({ op: 'same', key, path: l.path, remote: r });
      continue;
    }
    if (rec && r.md5 === rec.md5) {
      // この端末だけで変わった
      if (mode === 'push') out.push({ op: 'up', key, path: l.path, id: r.id });
      continue;
    }
    if (rec && lm === rec.md5) {
      // Drive だけで変わった
      out.push(mode === 'push' ? { op: 'newer', key, path: l.path, remote: r } : { op: 'down', key, path: l.path, remote: r });
      continue;
    }
    out.push({ op: 'conflict', key, path: l.path, remote: r });
  }
  for (const [key, r] of remote) {
    if (local.has(key)) continue;
    // この端末で消したファイル（前に合わせた）は、どちらにもしない
    if (recs[key]) continue;
    out.push(mode === 'push' ? { op: 'newer', key, path: r.path, remote: r } : { op: 'down', key, path: r.path, remote: r });
  }
  return out;
}

// ---- Drive の曲フォルダ --------------------------------------------------------

let rootCache: { id: string; at: number } | null = null;

/** 「DTX Web Editor」フォルダ（無ければ作る） */
export async function appRoot(create = true): Promise<string | null> {
  if (rootCache && Date.now() - rootCache.at < 10 * 60_000) return rootCache.id;
  const found = await listFiles(ROOT_QUERY);
  let id = found[0]?.id;
  if (!id && create) {
    id = (
      await createFolder(ROOT_NAME, null, {
        appProperties: { dtxe: 'root' },
        description: tr('DTX Web Editor が曲を保存するフォルダです。', 'DTX Web Editor keeps your songs in this folder.'),
      })
    ).id;
  }
  if (id) rootCache = { id, at: Date.now() };
  return id ?? null;
}

export function forgetRoot() {
  rootCache = null;
}

/** Drive の一覧に出す曲の情報（曲フォルダの説明に JSON で書く） */
export interface SongInfo {
  /** 曲名 */
  t?: string;
  /** アーティスト */
  a?: string;
  /** BPM */
  b?: string;
  /** レベル */
  l?: string;
  /** 保存した時刻 */
  u?: number;
  /** ファイルの数・大きさ */
  n?: number;
  s?: number;
}

export interface DriveSong {
  id: string;
  name: string;
  modifiedTime: string;
  info: SongInfo;
}

function songOf(f: DriveFile): DriveSong {
  let info: SongInfo = {};
  try {
    info = f.description ? (JSON.parse(f.description) as SongInfo) : {};
  } catch {
    // 説明が JSON でない
  }
  return { id: f.id, name: f.name, modifiedTime: f.modifiedTime ?? '', info };
}

/**
 * Drive の曲の一覧（新しい順）。「DTX Web Editor」の直下の曲と、PC どうしの同期で「DTXFiles/<BOX>/」に置いた曲（印 dtxe=song）。
 * 印の無い古い曲のフォルダ（直下）も出す
 */
export async function listDriveSongs(): Promise<DriveSong[]> {
  const roots = await listFiles(ROOT_QUERY);
  const out = new Map<string, DriveSong>();
  for (const f of await listFiles(SONG_QUERY)) out.set(f.id, songOf(f));
  for (const r of roots) for (const f of await listChildren(r.id)) if (f.mimeType === FOLDER_MIME && !f.appProperties?.dtxe) out.set(f.id, songOf(f));
  const t = (s: DriveSong) => s.info.u ?? (Date.parse(s.modifiedTime) || 0);
  return [...out.values()].sort((a, b) => t(b) - t(a));
}

/**
 * Drive の曲フォルダの中の、この曲の物ではないもの（ゴミ箱に移す単位）。
 * song：ほかの曲のフォルダ（直下に譜面・set.def・box.def・成績がある。曲を集めたフォルダごと送ってしまったときなど）。
 * dir・file：この端末の曲フォルダに無いフォルダ・ファイル（extrasOf）
 */
export interface JunkDir {
  kind: 'song' | 'dir' | 'file';
  /** 曲フォルダからのパス（元の綴り） */
  path: string;
  id: string;
  /** 中のファイルの数と大きさ（ほかの曲のフォルダは直下だけを数える） */
  files: number;
  bytes: number;
}

export interface DriveTree {
  /** この曲のファイル（ほかの曲のフォルダの中・自動保存は除く） */
  files: Map<string, RemoteEntry>;
  dirs: Map<string, string>;
  autosaves: Map<string, DriveFile>;
  /** ほかの曲のフォルダ（この曲として見ない） */
  junk: JunkDir[];
}

/** Drive の曲フォルダの中身（サブフォルダも）。自動保存は別に返す。ほかの曲のフォルダは中を見ずに junk に入れる */
export async function listTree(folderId: string): Promise<DriveTree> {
  const files = new Map<string, RemoteEntry>();
  const dirs = new Map<string, string>([['', folderId]]);
  const autosaves = new Map<string, DriveFile>();
  const junk: JunkDir[] = [];
  const queue: [string, string, number][] = [['', folderId, 0]];
  while (queue.length) {
    const [prefix, id, depth] = queue.shift()!;
    const kids = await listChildren(id);
    if (depth > 0 && kids.some((f) => f.mimeType !== FOLDER_MIME && isSongMark(f.name))) {
      const own = kids.filter((f) => f.mimeType !== FOLDER_MIME);
      junk.push({ kind: 'song', path: prefix, id, files: own.length, bytes: own.reduce((a, f) => a + Number(f.size ?? 0), 0) });
      continue;
    }
    for (const f of kids) {
      const path = prefix ? `${prefix}/${f.name}` : f.name;
      const key = normPath(path);
      if (f.mimeType === FOLDER_MIME) {
        dirs.set(key, f.id);
        if (key === AUTOSAVE_DIR) {
          for (const a of await listChildren(f.id)) if (a.mimeType !== FOLDER_MIME) autosaves.set(a.name.toLowerCase(), a);
        } else if (depth < 4) queue.push([path, f.id, depth + 1]);
        continue;
      }
      // Google ドキュメントなど（中身を取れない）は見ない
      if (f.mimeType.startsWith('application/vnd.google-apps')) continue;
      if (!syncedPath(path)) continue;
      const e: RemoteEntry = { id: f.id, path, md5: f.md5Checksum ?? '', size: Number(f.size ?? 0), modifiedTime: f.modifiedTime ?? '', ...(f.appProperties?.dev ? { dev: f.appProperties.dev } : {}) };
      // 同じ名前が2つあれば新しい方
      const old = files.get(key);
      if (!old || old.modifiedTime < e.modifiedTime) files.set(key, e);
    }
  }
  junk.sort((a, b) => a.path.localeCompare(b.path));
  return { files, dirs, autosaves, junk };
}

/** フォルダの中に、パスのサブフォルダを作る（あればそれ） */
async function ensureDir(dirs: Map<string, string>, path: string): Promise<string> {
  const parts = path.split('/').slice(0, -1);
  let key = '';
  let id = dirs.get('')!;
  for (const p of parts) {
    key = key ? `${key}/${p.toLowerCase()}` : p.toLowerCase();
    const have = dirs.get(key);
    if (have) {
      id = have;
      continue;
    }
    id = (await createFolder(p, id)).id;
    dirs.set(key, id);
  }
  return id;
}

// ---- 進み具合 ---------------------------------------------------------------------

export interface SyncProgress {
  phase: 'check' | 'up' | 'down';
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  /** いま扱っているファイル */
  file?: string;
}

// ---- 送る・取る ---------------------------------------------------------------------

/** 動画（src/audio/videoAudio.ts の VIDEO_EXT と同じ。動画を除いて送るとき） */
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|flv|3gp)$/i;

/** 曲フォルダの、Drive と合わせるファイル（ほかの曲のフォルダの中は除く。noVideo なら動画も除く） */
function localFiles(folder: SongFolder, noVideo = false): Map<string, FolderFile> {
  const others = otherSongDirs([...folder.files.values()].map((f) => f.path));
  const m = new Map<string, FolderFile>();
  for (const [key, f] of folder.files) if (syncedPath(f.path) && !inDirs(key, others) && !(noVideo && VIDEO.test(f.path))) m.set(key, f);
  return m;
}

/** 初めて送るときの大きさ（送るファイルの合計と、そのうちの動画） */
export function pushSize(folder: SongFolder): { total: number; video: number; videos: string[] } {
  let total = 0;
  let video = 0;
  const videos: string[] = [];
  for (const f of localFiles(folder).values()) {
    total += f.size;
    if (VIDEO.test(f.path)) {
      video += f.size;
      videos.push(f.path);
    }
  }
  return { total, video, videos };
}

/** ほかの曲も入ったフォルダ（曲フォルダではない）か。入っている曲のフォルダ（正規化したパス） */
export function songsInside(folder: SongFolder): string[] {
  return otherSongDirs([...folder.files.values()].map((f) => f.path));
}

/** つなぎの記録から、ほかの曲のフォルダの中の記録を外す */
function pruneLink(link: DriveLink, junk: readonly JunkDir[]): boolean {
  const dirs = junk.map((j) => normPath(j.path));
  let changed = false;
  for (const key of Object.keys(link.files)) {
    if (inDirs(key, dirs) || dirs.includes(key)) {
      delete link.files[key];
      changed = true;
    }
  }
  return changed;
}

/** 前に合わせた時から変わっていなければ MD5 を計算しない。Drive に同じ名前があるときだけ計算する */
async function localState(files: Map<string, FolderFile>, remote: Map<string, RemoteEntry>, recs: Record<string, LinkRec>, progress: (p: SyncProgress) => void) {
  const out = new Map<string, LocalEntry>();
  const blobs = new Map<string, File>();
  const need: [string, File][] = [];
  for (const [key, f] of files) {
    const file = await f.getFile();
    blobs.set(key, file);
    const rec = recs[key];
    if (rec && rec.size === file.size && rec.mtime === file.lastModified && rec.md5) {
      out.set(key, { path: f.path, md5: rec.md5 });
    } else if (remote.has(key)) {
      need.push([key, file]);
      out.set(key, { path: f.path });
    } else out.set(key, { path: f.path });
  }
  const totalBytes = need.reduce((a, [, f]) => a + f.size, 0);
  let bytes = 0;
  for (let i = 0; i < need.length; i++) {
    const [key, file] = need[i];
    progress({ phase: 'check', done: i, total: need.length, bytes, totalBytes, file: file.name });
    const md5 = await md5Blob(file, (n) => (bytes += n));
    out.get(key)!.md5 = md5;
  }
  return { state: out, blobs };
}

const AUDIO = /\.(ogg|wav|mp3|xa|m4a|flac|opus|mp4|avi|wmv|mpg|mpeg)$/i;

/** 小さい物（譜面・作業ファイル）を先に、大きい音声を後に */
function upOrder(a: { path: string; size: number }, b: { path: string; size: number }) {
  const av = AUDIO.test(a.path) ? 1 : 0;
  const bv = AUDIO.test(b.path) ? 1 : 0;
  return av - bv || a.size - b.size;
}

export interface Autosave {
  fileName: string;
  text: string;
  sidecar?: string;
  savedAt: number;
}

export interface AutosaveFile extends Autosave {
  v: 1;
  /** どの版の譜面への続きか（Drive の譜面の MD5。譜面がまだ無ければ空） */
  base: string;
  device?: string;
}

export interface PushOptions {
  /** つないでいない曲は Drive に作ってつなぐ（保存のとき。自動保存では作らない） */
  create: boolean;
  /** 新しくつなぐとき、動画を除いて送る（つなぎの記録に残り、次からも送らない） */
  noVideo?: boolean;
  /** 両方で変わったファイルをどうするか。null なら送らない */
  resolve?: (paths: string[]) => Promise<'mine' | 'theirs' | null>;
  /** Drive に同じ名前の曲があるとき（つなぐ前）。'join' はその曲に合わせる、'new' は別の曲として作る */
  sameName?: (name: string) => Promise<'join' | 'new' | null>;
  autosave?: Autosave | null;
  info?: SongInfo;
  device?: string;
  progress?: (p: SyncProgress | null) => void;
  /** 自動保存のとき：ファイルが前に合わせた時のままなら、Drive の中身を見ずに控えだけ送る */
  quick?: boolean;
  /** quick で、ファイルが変わっていたら送らずにやめる（PC どうしの同期で合わせる曲。曲のファイルは同期が送る） */
  quickOnly?: boolean;
}

export interface PushResult {
  link: DriveLink | null;
  sent: number;
  bytes: number;
  /** Drive の方が新しい・Drive にだけある（取り込みを勧める） */
  newer: string[];
  /** 両方で変わって送らなかった */
  conflicts: string[];
  /** Drive の曲フォルダに入っている、ほかの曲のフォルダ（送りも取りもしない。ゴミ箱に移せる） */
  junk: JunkDir[];
  /** やめた（つないでいない・聞いてやめた・曲フォルダではない） */
  skipped?: boolean;
  /** 曲フォルダではない（ほかの曲も入ったフォルダ）ので送らなかった。入っている曲のフォルダ */
  notSong?: string[];
}

function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

const NONE = { sent: 0, bytes: 0, newer: [] as string[], conflicts: [] as string[], junk: [] as JunkDir[] };

/** この端末の曲フォルダを Drive に送る（変わったファイルだけ）。ほかの曲も入ったフォルダは送らない */
export async function pushSong(folder: SongFolder, o: PushOptions): Promise<PushResult> {
  const progress = o.progress ?? (() => {});
  const others = songsInside(folder);
  if (others.length) return { link: null, ...NONE, skipped: true, notSong: others };
  let link = await readLink(folder);
  if (link && o.quick && (await unchangedSince(folder, link))) {
    if (o.autosave) {
      const before = JSON.stringify([link.autosaveDir, link.autosave]);
      await putAutosave(link, o.autosave, o.device);
      if (JSON.stringify([link.autosaveDir, link.autosave]) !== before) await writeLink(folder, link);
    }
    return { link, ...NONE };
  }
  if (o.quickOnly) return { link, ...NONE, skipped: true };
  if (link) {
    const f = await getFile(link.folderId);
    if (!f || f.trashed) {
      // Drive で消された。同じ曲が Drive に 2 つあって、PC どうしの同期が使っていない方として片付けた（印 dup）なら、保存のときに残した方につなぎ直す
      // （同じ名前の曲と合わせるときと同じ。前に合わせた記録は無いものとして、中身が違うファイルは聞く）
      const to = o.create && f?.appProperties?.dup ? await getFile(f.appProperties.dup) : null;
      link = to && !to.trashed && to.appProperties?.dtxe === 'song' ? { ...newLink(to.id, to.name), ...(link.noVideo ? { noVideo: true } : {}) } : null;
    }
  }
  if (!link) {
    if (!o.create) return { link: null, ...NONE, skipped: true };
    const root = (await appRoot(true))!;
    const kids = (await listChildren(root)).filter((f) => f.mimeType === FOLDER_MIME);
    const same = kids.find((f) => f.name.toLowerCase() === folder.name.toLowerCase());
    let target: DriveFile | null = null;
    if (same) {
      const how = o.sameName ? await o.sameName(same.name) : 'new';
      if (!how) return { link: null, ...NONE, skipped: true };
      if (how === 'join') target = same;
    }
    target ??= await createFolder(freeName(folder.name, new Set(kids.map((k) => k.name.toLowerCase()))), root, { appProperties: { dtxe: 'song' } });
    link = newLink(target.id, target.name);
    if (o.noVideo) link.noVideo = true;
  }
  progress({ phase: 'check', done: 0, total: 0, bytes: 0, totalBytes: 0 });
  const tree = await listTree(link.folderId);
  pruneLink(link, tree.junk);
  const files = localFiles(folder, link.noVideo);
  const { state, blobs } = await localState(files, tree.files, link.files, progress);
  let steps = planSync(state, tree.files, link.files, 'push');
  const conflicts = steps.filter((s) => s.op === 'conflict');
  if (conflicts.length) {
    const how = o.resolve ? await o.resolve(conflicts.map((c) => c.path)) : null;
    if (how === 'mine') steps = steps.map((s) => (s.op === 'conflict' ? { op: 'up', key: s.key, path: s.path, id: s.remote.id } : s));
  }
  const ups = steps.filter((s): s is Extract<Step, { op: 'up' }> => s.op === 'up').map((s) => ({ ...s, size: blobs.get(s.key)!.size }));
  ups.sort(upOrder);
  const totalBytes = ups.reduce((a, s) => a + s.size, 0);
  let bytes = 0;
  let sent = 0;
  try {
    for (const s of steps) {
      if (s.op !== 'same') continue;
      const file = blobs.get(s.key)!;
      link.files[s.key] = { id: s.remote.id, md5: s.remote.md5, size: file.size, mtime: file.lastModified, path: s.path };
    }
    for (const s of ups) {
      const file = blobs.get(s.key)!;
      progress({ phase: 'up', done: sent, total: ups.length, bytes, totalBytes, file: file.name });
      const parent = s.id ? undefined : await ensureDir(tree.dirs, s.path);
      const base = bytes;
      const res = await upload({ id: s.id, name: s.path.split('/').pop()!, parent, data: file, onProgress: (n) => progress({ phase: 'up', done: sent, total: ups.length, bytes: base + n, totalBytes, file: file.name }) });
      bytes = base + file.size;
      sent++;
      link.files[s.key] = { id: res.id, md5: res.md5Checksum ?? '', size: file.size, mtime: file.lastModified, path: s.path };
      // 途中で切れても、送れた所までは覚えておく
      if (sent % 8 === 0) await writeLink(folder, link);
    }
    if (o.autosave) await putAutosave(link, o.autosave, o.device, tree);
    const all = [...files.values()];
    const info: SongInfo = { ...o.info, u: Date.now(), n: all.length, s: all.reduce((a, f) => a + f.size, 0) };
    await updateMeta(link.folderId, { description: JSON.stringify(info) });
    link.syncedAt = Date.now();
  } finally {
    await writeLink(folder, link);
    progress(null);
  }
  return {
    link,
    sent,
    bytes,
    newer: steps.filter((s) => s.op === 'newer').map((s) => s.path),
    conflicts: steps.filter((s) => s.op === 'conflict').map((s) => s.path),
    junk: tree.junk,
  };
}

/** ファイルが前に合わせた時のまま（大きさと更新時刻が同じ・増えていない）か */
async function unchangedSince(folder: SongFolder, link: DriveLink): Promise<boolean> {
  for (const [key, f] of localFiles(folder, link.noVideo)) {
    const rec = link.files[key];
    if (!rec) return false;
    const file = await f.getFile();
    if (rec.size !== file.size || rec.mtime !== file.lastModified) return false;
  }
  return true;
}

/** 自動保存（まだ保存していない続き）を送る */
async function putAutosave(link: DriveLink, a: Autosave, device?: string, tree?: DriveTree) {
  const dtx = link.files[normPath(a.fileName)];
  const body: AutosaveFile = { v: 1, ...a, base: dtx?.md5 ?? '', device };
  const name = `${a.fileName}.json`;
  const key = name.toLowerCase();
  const data = new Blob([JSON.stringify(body)], { type: 'application/json' });
  const findDir = async (): Promise<string> => {
    const have = tree?.dirs.get(AUTOSAVE_DIR) ?? (await listChildren(link.folderId)).find((f) => f.mimeType === FOLDER_MIME && f.name.toLowerCase() === AUTOSAVE_DIR)?.id;
    return have ?? (await createFolder(AUTOSAVE_DIR, link.folderId)).id;
  };
  let id = link.autosave?.[key] ?? tree?.autosaves.get(key)?.id;
  if (!id) {
    link.autosaveDir ??= await findDir();
    id = (await listChildren(link.autosaveDir)).find((f) => f.name.toLowerCase() === key)?.id;
  }
  let res: DriveFile;
  try {
    res = await upload({ id, name, parent: id ? undefined : link.autosaveDir, data });
  } catch (e) {
    if (!(e instanceof DriveError) || e.status !== 404) throw e;
    // 控えのファイル・フォルダが Drive で消されていた：作り直す
    link.autosaveDir = await findDir();
    res = await upload({ name, parent: link.autosaveDir, data });
  }
  link.autosave = { ...link.autosave, [key]: res.id };
}

/** Drive の自動保存を読む（譜面の名前の小文字 → 中身） */
export async function readAutosaves(tree: DriveTree): Promise<Map<string, AutosaveFile>> {
  const out = new Map<string, AutosaveFile>();
  for (const [name, f] of tree.autosaves) {
    if (!name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await downloadText(f.id)) as AutosaveFile;
      if (j?.v === 1 && typeof j.text === 'string' && typeof j.fileName === 'string') out.set(j.fileName.toLowerCase(), j);
    } catch {
      // 読めない控えは見ない
    }
  }
  return out;
}

export interface PullOptions {
  resolve?: (paths: string[]) => Promise<'mine' | 'theirs' | null>;
  progress?: (p: SyncProgress | null) => void;
}

export interface PullResult {
  link: DriveLink;
  got: number;
  bytes: number;
  tree: DriveTree;
  /** 両方で変わって取らなかった */
  conflicts: string[];
  /** Drive の曲フォルダに入っている、ほかの曲のフォルダ（取らない） */
  junk: JunkDir[];
}

/** ほかの曲も入ったフォルダ（曲フォルダではない）へは取らない */
export class NotSongFolderError extends DriveError {
  constructor(
    readonly folderName: string,
    readonly songs: string[],
  ) {
    super(
      tr(`「${folderName}」にはほかの曲も入っているので、Google Drive とは合わせません`, `"${folderName}" also has other songs in it, so it isn't synced with Google Drive`),
      0,
      'not-song',
    );
    this.name = 'NotSongFolderError';
  }
}

/** Drive の曲フォルダをこの端末の曲フォルダへ取る（変わったファイルだけ）。folder は直接書けるフォルダ */
export async function pullSong(folder: SongFolder, link: DriveLink, o: PullOptions = {}): Promise<PullResult> {
  const progress = o.progress ?? (() => {});
  const others = songsInside(folder);
  if (others.length) throw new NotSongFolderError(folder.name, others);
  progress({ phase: 'check', done: 0, total: 0, bytes: 0, totalBytes: 0 });
  const tree = await listTree(link.folderId);
  pruneLink(link, tree.junk);
  const files = localFiles(folder, link.noVideo);
  const { state, blobs } = await localState(files, tree.files, link.files, progress);
  let steps = planSync(state, tree.files, link.files, 'pull');
  const conflicts = steps.filter((s) => s.op === 'conflict');
  if (conflicts.length) {
    const how = o.resolve ? await o.resolve(conflicts.map((c) => c.path)) : null;
    if (how === 'theirs') steps = steps.map((s) => (s.op === 'conflict' ? { op: 'down', key: s.key, path: s.path, remote: s.remote } : s));
  }
  const downs = steps.filter((s): s is Extract<Step, { op: 'down' }> => s.op === 'down').sort((a, b) => upOrder({ path: a.path, size: a.remote.size }, { path: b.path, size: b.remote.size }));
  const totalBytes = downs.reduce((a, s) => a + s.remote.size, 0);
  let bytes = 0;
  let got = 0;
  try {
    for (const s of steps) {
      if (s.op !== 'same') continue;
      const file = blobs.get(s.key)!;
      link.files[s.key] = { id: s.remote.id, md5: s.remote.md5, size: file.size, mtime: file.lastModified, path: s.path };
    }
    for (const s of downs) {
      progress({ phase: 'down', done: got, total: downs.length, bytes, totalBytes, file: s.path.split('/').pop() });
      const base = bytes;
      const blob = await download(s.remote.id, (n) => progress({ phase: 'down', done: got, total: downs.length, bytes: base + n, totalBytes, file: s.path.split('/').pop() }));
      // 手元に同じファイル（大文字・小文字違い）があればその綴りに書く
      const path = folder.files.get(s.key)?.path ?? s.path;
      await writeFile(folder, path, blob);
      const file = await folder.files.get(normPath(path))!.getFile();
      bytes = base + s.remote.size;
      got++;
      link.files[s.key] = { id: s.remote.id, md5: s.remote.md5, size: file.size, mtime: file.lastModified, path };
      if (got % 8 === 0) await writeLink(folder, link);
    }
    link.syncedAt = Date.now();
  } finally {
    await writeLink(folder, link);
    progress(null);
  }
  return { link, got, bytes, tree, conflicts: steps.filter((s) => s.op === 'conflict').map((s) => s.path), junk: tree.junk };
}

/**
 * Drive の方が新しいファイルがあるか（開いた曲を、ほかの端末で保存していないか）。
 * Drive の曲フォルダに入っているほかの曲のフォルダは newer に入れず、junk で返す
 */
export async function remoteChanges(folder: SongFolder, link: DriveLink): Promise<{ newer: string[]; junk: JunkDir[] }> {
  const tree = await listTree(link.folderId);
  const newer: string[] = [];
  for (const [key, r] of tree.files) {
    const rec = link.files[key];
    if (rec ? rec.md5 !== r.md5 : !folder.files.has(key)) newer.push(r.path);
  }
  return { newer, junk: tree.junk };
}

// ---- 片付ける ---------------------------------------------------------------------

/**
 * Drive にだけあって、この端末の曲フォルダに無いもの。サブフォルダが丸ごと無ければフォルダで（ゴミ箱に移す回数を減らす）。
 * ほかの曲のフォルダ（tree.junk）は入れない
 */
export function extrasOf(folder: SongFolder, tree: DriveTree): JunkDir[] {
  const local = localFiles(folder);
  const localTops = new Set([...local.keys()].filter((k) => k.includes('/')).map((k) => k.split('/')[0]));
  const out = new Map<string, JunkDir>();
  for (const [key, r] of tree.files) {
    if (local.has(key)) continue;
    const top = key.split('/')[0];
    const dirId = key.includes('/') && !localTops.has(top) ? tree.dirs.get(top) : undefined;
    if (dirId) {
      const e = out.get(top) ?? { kind: 'dir' as const, path: r.path.split('/')[0], id: dirId, files: 0, bytes: 0 };
      e.files++;
      e.bytes += r.size;
      out.set(top, e);
    } else out.set(key, { kind: 'file', path: r.path, id: r.id, files: 1, bytes: r.size });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Drive の物をゴミ箱に移す（Drive のゴミ箱から 30 日は戻せる）。つなぎの記録からも外す。
 * folder を渡せば、その曲フォルダのつなぎの記録を書き直す
 */
export async function trashJunk(items: readonly JunkDir[], o: { folder?: SongFolder; link?: DriveLink | null; progress?: (done: number, total: number) => void } = {}): Promise<number> {
  let done = 0;
  for (const j of items) {
    o.progress?.(done, items.length);
    try {
      await trashFile(j.id);
    } catch (e) {
      // もう無い（ほかの端末で片付けた）なら、それでよい
      if (!(e instanceof DriveError && e.status === 404)) throw e;
    }
    done++;
  }
  if (o.folder && o.link) {
    pruneLink(o.link, items);
    await writeLink(o.folder, o.link);
  }
  return done;
}

export function describeFiles(paths: string[], max = 4): string {
  const shown = paths.slice(0, max).join(tr('、', ', '));
  return paths.length > max ? tr(`${shown} ほか ${paths.length - max} 個`, `${shown} and ${paths.length - max} more ${pl(paths.length - max, 'file')}`) : shown;
}
