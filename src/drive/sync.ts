// 曲フォルダと Google Drive の曲フォルダを合わせる。
// - Drive には「DTX Web Editor」フォルダを作り、その中に曲フォルダと同じ並び（サブフォルダも）で置く。Drive の画面からそのまま落として NX で使える。
// - どのファイルを合わせたかは、曲フォルダの中の .dtxe-drive.json に書く（Drive のファイル id と MD5）。PC の曲フォルダでも本体の曲でも同じ。
// - 変わったかは MD5 で比べる（Drive は md5Checksum を持つ）。大きさと更新時刻が前に合わせた時と同じなら計算しない。
// - 両方で変わったファイルは、保存のときだけ聞く（自動保存のときは送らずに置いておく）。消したファイルは消さない（Drive に残す）。
// - 自動保存（まだ保存していない続き）は .dtxe-autosave/<譜面>.json に送る。どの版の譜面への続きか（base = 譜面の MD5）も書く。
import { pl, tr } from '../i18n';
import { normPath, writeFile, type FolderFile, type SongFolder } from '../fs/folder';
import { createFolder, download, downloadText, DriveError, FOLDER_MIME, getFile, listChildren, listFiles, updateMeta, upload, type DriveFile } from './api';
import { md5Blob } from './md5';

export const LINK_FILE = '.dtxe-drive.json';
export const AUTOSAVE_DIR = '.dtxe-autosave';
const ROOT_NAME = 'DTX Web Editor';
const ROOT_QUERY = `appProperties has { key='dtxe' and value='root' } and mimeType = '${FOLDER_MIME}' and trashed = false`;

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

// ---- どうするかを決める（純粋な関数） ----------------------------------------------

export interface RemoteEntry {
  id: string;
  path: string;
  md5: string;
  size: number;
  modifiedTime: string;
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

/** Drive の曲の一覧（新しい順） */
export async function listDriveSongs(): Promise<DriveSong[]> {
  const roots = await listFiles(ROOT_QUERY);
  const out: DriveSong[] = [];
  for (const r of roots) for (const f of await listChildren(r.id)) if (f.mimeType === FOLDER_MIME) out.push(songOf(f));
  const t = (s: DriveSong) => s.info.u ?? (Date.parse(s.modifiedTime) || 0);
  return out.sort((a, b) => t(b) - t(a));
}

/** Drive の曲フォルダの中身（サブフォルダも）。自動保存は別に返す */
export async function listTree(folderId: string): Promise<{ files: Map<string, RemoteEntry>; dirs: Map<string, string>; autosaves: Map<string, DriveFile> }> {
  const files = new Map<string, RemoteEntry>();
  const dirs = new Map<string, string>([['', folderId]]);
  const autosaves = new Map<string, DriveFile>();
  const queue: [string, string, number][] = [['', folderId, 0]];
  while (queue.length) {
    const [prefix, id, depth] = queue.shift()!;
    for (const f of await listChildren(id)) {
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
      const e: RemoteEntry = { id: f.id, path, md5: f.md5Checksum ?? '', size: Number(f.size ?? 0), modifiedTime: f.modifiedTime ?? '' };
      // 同じ名前が2つあれば新しい方
      const old = files.get(key);
      if (!old || old.modifiedTime < e.modifiedTime) files.set(key, e);
    }
  }
  return { files, dirs, autosaves };
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

/** 曲フォルダの、Drive と合わせるファイル */
function localFiles(folder: SongFolder): Map<string, FolderFile> {
  const m = new Map<string, FolderFile>();
  for (const [key, f] of folder.files) if (syncedPath(f.path)) m.set(key, f);
  return m;
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
}

export interface PushResult {
  link: DriveLink | null;
  sent: number;
  bytes: number;
  /** Drive の方が新しい・Drive にだけある（取り込みを勧める） */
  newer: string[];
  /** 両方で変わって送らなかった */
  conflicts: string[];
  /** やめた（つないでいない・聞いてやめた） */
  skipped?: boolean;
}

function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** この端末の曲フォルダを Drive に送る（変わったファイルだけ） */
export async function pushSong(folder: SongFolder, o: PushOptions): Promise<PushResult> {
  const progress = o.progress ?? (() => {});
  let link = await readLink(folder);
  if (link && o.quick && (await unchangedSince(folder, link))) {
    if (o.autosave) {
      const before = JSON.stringify([link.autosaveDir, link.autosave]);
      await putAutosave(link, o.autosave, o.device);
      if (JSON.stringify([link.autosaveDir, link.autosave]) !== before) await writeLink(folder, link);
    }
    return { link, sent: 0, bytes: 0, newer: [], conflicts: [] };
  }
  if (link) {
    const f = await getFile(link.folderId);
    if (!f || f.trashed) link = null; // Drive で消された
  }
  if (!link) {
    if (!o.create) return { link: null, sent: 0, bytes: 0, newer: [], conflicts: [], skipped: true };
    const root = (await appRoot(true))!;
    const kids = (await listChildren(root)).filter((f) => f.mimeType === FOLDER_MIME);
    const same = kids.find((f) => f.name.toLowerCase() === folder.name.toLowerCase());
    let target: DriveFile | null = null;
    if (same) {
      const how = o.sameName ? await o.sameName(same.name) : 'new';
      if (!how) return { link: null, sent: 0, bytes: 0, newer: [], conflicts: [], skipped: true };
      if (how === 'join') target = same;
    }
    target ??= await createFolder(freeName(folder.name, new Set(kids.map((k) => k.name.toLowerCase()))), root, { appProperties: { dtxe: 'song' } });
    link = newLink(target.id, target.name);
  }
  progress({ phase: 'check', done: 0, total: 0, bytes: 0, totalBytes: 0 });
  const tree = await listTree(link.folderId);
  const files = localFiles(folder);
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
  };
}

/** ファイルが前に合わせた時のまま（大きさと更新時刻が同じ・増えていない）か */
async function unchangedSince(folder: SongFolder, link: DriveLink): Promise<boolean> {
  for (const [key, f] of localFiles(folder)) {
    const rec = link.files[key];
    if (!rec) return false;
    const file = await f.getFile();
    if (rec.size !== file.size || rec.mtime !== file.lastModified) return false;
  }
  return true;
}

/** 自動保存（まだ保存していない続き）を送る */
async function putAutosave(link: DriveLink, a: Autosave, device?: string, tree?: Awaited<ReturnType<typeof listTree>>) {
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
export async function readAutosaves(tree: Awaited<ReturnType<typeof listTree>>): Promise<Map<string, AutosaveFile>> {
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
  tree: Awaited<ReturnType<typeof listTree>>;
  /** 両方で変わって取らなかった */
  conflicts: string[];
}

/** Drive の曲フォルダをこの端末の曲フォルダへ取る（変わったファイルだけ）。folder は直接書けるフォルダ */
export async function pullSong(folder: SongFolder, link: DriveLink, o: PullOptions = {}): Promise<PullResult> {
  const progress = o.progress ?? (() => {});
  progress({ phase: 'check', done: 0, total: 0, bytes: 0, totalBytes: 0 });
  const tree = await listTree(link.folderId);
  const files = localFiles(folder);
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
  return { link, got, bytes, tree, conflicts: steps.filter((s) => s.op === 'conflict').map((s) => s.path) };
}

/** Drive の方が新しいファイルがあるか（開いた曲を、ほかの端末で保存していないか） */
export async function remoteChanges(folder: SongFolder, link: DriveLink): Promise<string[]> {
  const tree = await listTree(link.folderId);
  const out: string[] = [];
  for (const [key, r] of tree.files) {
    const rec = link.files[key];
    if (rec ? rec.md5 !== r.md5 : !folder.files.has(key)) out.push(r.path);
  }
  return out;
}

export function describeFiles(paths: string[], max = 4): string {
  const shown = paths.slice(0, max).join(tr('、', ', '));
  return paths.length > max ? tr(`${shown} ほか ${paths.length - max} 個`, `${shown} and ${paths.length - max} more ${pl(paths.length - max, 'file')}`) : shown;
}
