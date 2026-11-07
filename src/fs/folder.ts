// 曲フォルダの読み書き。Chrome/Edge は File System Access API でフォルダに直接保存する。
// フォルダを選んでいない曲（iPad・ZIP・落としたファイル・新しい曲）は本体（このブラウザの保存領域、src/fs/local.ts）に置き、
// 同じように直接書く。どちらも使えないときはメモリに持ち、保存はダウンロードにする。
import { tr } from '../i18n';
import { isQuotaError, writeSongFile } from './opfs';

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
}

export interface FolderFile {
  /** フォルダからの相対パス（'/' 区切り、元の綴り） */
  path: string;
  name: string;
  size: number;
  getFile: () => Promise<File>;
  /** 書き換えた回数（同じ名前で書き直したとき、読み込み直すため） */
  ver?: number;
  /** フォルダにまだ書けていない（メモリにだけある）ファイル。保存やダウンロードで一緒に書き出す */
  pending?: boolean;
}

export interface SongFolder {
  name: string;
  /** 直接書けるフォルダ（PC で選んだ曲フォルダ、または本体の曲のフォルダ） */
  dir?: FileSystemDirectoryHandle;
  /** 本体（このブラウザの保存領域）に置いた曲の id（src/fs/local.ts）。dir はそのフォルダ */
  local?: string;
  /** 正規化したパス（小文字・'/' 区切り）→ ファイル */
  files: Map<string, FolderFile>;
}

/** DTX に書かれたパスをフォルダ内の検索キーにする（NXはWindowsなので大文字小文字を区別しない） */
export function normPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\//, '')
    .toLowerCase();
}

export function joinPath(base: string, p: string): string {
  if (!base) return p;
  const b = base.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${b}/${p}`;
}

export function supportsDirectWrite(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** 本体（このブラウザの保存領域）に置いた曲か */
export function isLocalFolder(folder: SongFolder | null | undefined): folder is SongFolder & { local: string; dir: FileSystemDirectoryHandle } {
  return !!folder?.local && !!folder.dir;
}

/** PC で選んだ曲フォルダ（ディスクのフォルダ）か */
export function isDiskFolder(folder: SongFolder | null | undefined): folder is SongFolder & { dir: FileSystemDirectoryHandle } {
  return !!folder?.dir && !folder.local;
}

const MAX_FILES = 8000;
const MAX_DEPTH = 4;

async function walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number, out: Map<string, FolderFile>) {
  for await (const [name, h] of dir.entries()) {
    if (out.size >= MAX_FILES) return;
    const path = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'file') {
      const fh = h as FileSystemFileHandle;
      let size = 0;
      try {
        size = (await fh.getFile()).size;
      } catch {
        // 読めないファイルは大きさ0で登録しておく
      }
      out.set(normPath(path), { path, name, size, getFile: () => fh.getFile() });
    } else if (depth < MAX_DEPTH) {
      await walk(h as FileSystemDirectoryHandle, path, depth + 1, out);
    }
  }
}

export async function folderFromHandle(dir: FileSystemDirectoryHandle): Promise<SongFolder> {
  const files = new Map<string, FolderFile>();
  await walk(dir, '', 0, files);
  return { name: dir.name, dir, files };
}

/** フォルダ選択ダイアログ（書き込み可）。キャンセルなら null */
export async function pickFolder(): Promise<SongFolder | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    const dir = await window.showDirectoryPicker({ id: 'dtx-song', mode: 'readwrite' });
    return await folderFromHandle(dir);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** <input webkitdirectory> で選んだファイル一覧から作る（読み込み専用） */
export function folderFromFileList(list: FileList | File[]): SongFolder {
  const arr = [...list];
  const files = new Map<string, FolderFile>();
  let root = '';
  for (const f of arr) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    if (parts.length > 1) {
      root = root || parts[0];
      parts.shift();
    }
    const path = parts.join('/');
    files.set(normPath(path), { path, name: f.name, size: f.size, getFile: async () => f });
  }
  return { name: root || tr('選んだファイル', 'Selected files'), files };
}

/** 単体のファイル（DTX や音声）から作る仮のフォルダ */
export function folderFromFiles(list: File[], name = tr('新しい曲', 'New song')): SongFolder {
  const files = new Map<string, FolderFile>();
  for (const f of list) files.set(normPath(f.name), { path: f.name, name: f.name, size: f.size, getFile: async () => f });
  return { name, files };
}

export function findFile(folder: SongFolder | null, path: string, pathWav = ''): FolderFile | undefined {
  if (!folder || !path) return undefined;
  return folder.files.get(normPath(joinPath(pathWav, path))) ?? folder.files.get(normPath(path));
}

export function dtxFiles(folder: SongFolder): FolderFile[] {
  return [...folder.files.values()]
    .filter((f) => /\.dtx$/i.test(f.name) && !f.path.includes('/'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const AUDIO_EXT = /\.(ogg|wav|mp3|xa|m4a|flac|opus)$/i;

export function audioFiles(folder: SongFolder): FolderFile[] {
  return [...folder.files.values()].filter((f) => AUDIO_EXT.test(f.name)).sort((a, b) => a.path.localeCompare(b.path));
}

export async function ensureWritable(folder: SongFolder): Promise<boolean> {
  const dir = folder.dir;
  if (!dir) return false;
  if (dir.queryPermission && (await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (dir.requestPermission) return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  return true;
}

/** 本体に書けなかったとき（容量が足りないなど）に知らせる先。画面の側で決める */
let onWriteError: ((e: unknown, folder: SongFolder, path: string) => void) | null = null;
export function setWriteErrorHandler(fn: typeof onWriteError) {
  onWriteError = fn;
}

/** フォルダにファイルを書く（サブフォルダは作る） */
export async function writeFile(folder: SongFolder, path: string, data: Uint8Array | Blob): Promise<void> {
  if (!folder.dir) throw new Error(tr('このフォルダには直接保存できません', "Can't save directly to this folder"));
  let rel = path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  const size = data instanceof Blob ? data.size : data.length;
  if (folder.local) {
    // 本体は大文字・小文字を区別するので、同じファイル（NX は区別しない）があればその綴りに書く
    rel = folder.files.get(normPath(rel))?.path ?? rel;
    const name = rel.split('/').pop()!;
    const fh = await writeSongFile(folder.local, rel, data);
    folder.files.set(normPath(rel), { path: rel, name, size, getFile: () => fh.getFile(), ver: ++fileVer });
    return;
  }
  const parts = rel.split('/');
  const name = parts.pop()!;
  let dir = folder.dir;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data as Blob);
  await w.close();
  folder.files.set(normPath(rel), { path: rel, name, size, getFile: () => fh.getFile(), ver: ++fileVer });
}

let fileVer = 0;

/**
 * 曲フォルダにファイルを置く。直接書けるフォルダ（PC の曲フォルダ・本体）なら書き、書けなければメモリに持っておき、
 * 保存（フォルダを選ぶ・本体に入れる・ZIPでダウンロード）のときに一緒に書き出す。
 */
export async function putFile(folder: SongFolder, path: string, data: Uint8Array | File): Promise<'written' | 'memory'> {
  const rel = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (folder.dir) {
    try {
      if (await ensureWritable(folder)) {
        await writeFile(folder, rel, data);
        return 'written';
      }
    } catch (e) {
      // 書けなければメモリに持つ（本体の容量が足りないときは知らせる）
      if (folder.local) onWriteError?.(e, folder, rel);
    }
  }
  const name = rel.split('/').pop()!;
  const file = data instanceof File ? data : new File([data as Uint8Array<ArrayBuffer>], name);
  folder.files.set(normPath(rel), { path: rel, name, size: file.size, getFile: async () => file, ver: ++fileVer, pending: true });
  return 'memory';
}

export { isQuotaError };

/** まだフォルダに書けていないファイル */
export function pendingFiles(folder: SongFolder | null): FolderFile[] {
  return folder ? [...folder.files.values()].filter((f) => f.pending) : [];
}

export function downloadBytes(name: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- set.def ------------------------------------------------------------------

export interface SetDefEntry {
  title: string;
  /** 難易度ラベルとファイル名（L1〜L5）。index は L の番号 */
  levels: { label: string; file: string; index?: number }[];
}

/** set.def（#L1LABEL/#L1FILE …）を読む。複数の #TITLE ブロックにも対応 */
export function parseSetDef(text: string): SetDefEntry[] {
  const out: SetDefEntry[] = [];
  let cur: SetDefEntry | null = null;
  const labels: Record<number, string> = {};
  const files: Record<number, string> = {};
  const flush = () => {
    if (!cur) return;
    for (let i = 1; i <= 5; i++) if (files[i]) cur.levels.push({ label: labels[i] || defaultLabel(i), file: files[i], index: i });
    out.push(cur);
    for (let i = 1; i <= 5; i++) delete labels[i], delete files[i];
  };
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*#\s*([A-Za-z0-9]+)\s*:?\s*(.*?)\s*(;.*)?$/.exec(raw);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const val = m[2];
    if (key === 'TITLE') {
      flush();
      cur = { title: val, levels: [] };
      continue;
    }
    if (!cur) cur = { title: '', levels: [] };
    const lv = /^L([1-5])(LABEL|FILE)$/.exec(key);
    if (lv) (lv[2] === 'LABEL' ? labels : files)[Number(lv[1])] = val;
  }
  flush();
  return out;
}

export function defaultLabel(i: number): string {
  return ['BASIC', 'ADVANCED', 'EXTREME', 'MASTER', 'DTXMANIA'][i - 1] ?? `L${i}`;
}
