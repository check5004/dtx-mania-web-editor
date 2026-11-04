// 曲フォルダの読み書き。Chrome/Edge は File System Access API でフォルダに直接保存する。
// 使えないブラウザはフォルダを読み込みだけ行い、保存はダウンロードにする。
import { tr } from '../i18n';

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
  dir?: FileSystemDirectoryHandle;
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

/** フォルダにファイルを書く（サブフォルダは作る） */
export async function writeFile(folder: SongFolder, path: string, bytes: Uint8Array): Promise<void> {
  if (!folder.dir) throw new Error(tr('このフォルダには直接保存できません', "Can't save directly to this folder"));
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.pop()!;
  let dir = folder.dir;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes as Uint8Array<ArrayBuffer>);
  await w.close();
  const rel = [...parts, name].join('/');
  folder.files.set(normPath(rel), { path: rel, name, size: bytes.length, getFile: () => fh.getFile(), ver: ++fileVer });
}

let fileVer = 0;

/**
 * 曲フォルダにファイルを置く。直接書けるフォルダなら書き、書けなければメモリに持っておき、
 * 保存（フォルダを選ぶ・ZIPでダウンロード）のときに一緒に書き出す。
 */
export async function putFile(folder: SongFolder, path: string, data: Uint8Array | File): Promise<'written' | 'memory'> {
  const rel = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (folder.dir) {
    try {
      if (await ensureWritable(folder)) {
        await writeFile(folder, rel, data instanceof File ? new Uint8Array(await data.arrayBuffer()) : data);
        return 'written';
      }
    } catch {
      // 書けなければメモリに持つ
    }
  }
  const name = rel.split('/').pop()!;
  const file = data instanceof File ? data : new File([data as Uint8Array<ArrayBuffer>], name);
  folder.files.set(normPath(rel), { path: rel, name, size: file.size, getFile: async () => file, ver: ++fileVer, pending: true });
  return 'memory';
}

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
  /** 難易度ラベルとファイル名（L1〜L5） */
  levels: { label: string; file: string }[];
}

/** set.def（#L1LABEL/#L1FILE …）を読む。複数の #TITLE ブロックにも対応 */
export function parseSetDef(text: string): SetDefEntry[] {
  const out: SetDefEntry[] = [];
  let cur: SetDefEntry | null = null;
  const labels: Record<number, string> = {};
  const files: Record<number, string> = {};
  const flush = () => {
    if (!cur) return;
    for (let i = 1; i <= 5; i++) if (files[i]) cur.levels.push({ label: labels[i] || defaultLabel(i), file: files[i] });
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
