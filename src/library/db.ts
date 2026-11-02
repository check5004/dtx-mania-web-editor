// 音源ライブラリの保存先（ブラウザ内の IndexedDB）。サンプルの情報・音声データ・キット・参照モードのフォルダを持つ。

export type Inst = 'kick' | 'snare' | 'hihat' | 'tom' | 'crash' | 'ride' | 'other';

export interface SampleSource {
  song: string;
  artist: string;
  /** 曲フォルダの中のパス */
  file: string;
  folder: string;
}

export interface SampleMeta {
  /** 中身のハッシュ（同じ中身は1つにまとめる） */
  id: string;
  /** 元のファイル名 */
  name: string;
  /** 曲フォルダに書き出すときの名前（ライブラリの中で重ならない） */
  file: string;
  size: number;
  inst: Inst;
  /** 楽器を自動で決めたか（手で直したら false） */
  instAuto: boolean;
  /** 自動判定の確からしさ（0〜1） */
  conf: number;
  /** 判定の理由（「SDレーンで94%使用」など） */
  reason: string;
  sources: SampleSource[];
  tags: string[];
  fav: boolean;
  /** 長さ（秒） */
  dur: number;
  sr: number;
  channels: number;
  /** 一覧の波形（0〜255 を 48 個） */
  peaks: number[];
  /** 似た音を探すための特徴量 */
  feat: number[];
  /** 参照モード：音声は持たず、覚えたフォルダから読む */
  ref?: { folderId: string; path: string };
  addedAt: number;
}

export interface LibraryKit {
  id: string;
  name: string;
  origin: 'song' | 'user';
  song?: string;
  artist?: string;
  /** チャンネル → サンプルの id */
  lanes: Record<number, string>;
  createdAt: number;
}

export interface RefFolder {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
}

const DB = 'dtx-web-editor-library';
const STORES = ['samples', 'audio', 'kits', 'folders'] as const;
type StoreName = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('samples', { keyPath: 'id' });
      db.createObjectStore('audio');
      db.createObjectStore('kits', { keyPath: 'id' });
      db.createObjectStore('folders', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function allSamples(): Promise<SampleMeta[]> {
  return wrap((await store('samples')).getAll() as IDBRequest<SampleMeta[]>);
}

export async function getSample(id: string): Promise<SampleMeta | undefined> {
  return wrap((await store('samples')).get(id) as IDBRequest<SampleMeta | undefined>);
}

export async function putSample(s: SampleMeta): Promise<void> {
  await wrap((await store('samples', 'readwrite')).put(s));
}

export async function deleteSample(id: string): Promise<void> {
  await wrap((await store('samples', 'readwrite')).delete(id));
  await wrap((await store('audio', 'readwrite')).delete(id));
}

export async function getAudio(id: string): Promise<ArrayBuffer | undefined> {
  return wrap((await store('audio')).get(id) as IDBRequest<ArrayBuffer | undefined>);
}

export async function putAudio(id: string, bytes: ArrayBuffer): Promise<void> {
  await wrap((await store('audio', 'readwrite')).put(bytes, id));
}

export async function allKits(): Promise<LibraryKit[]> {
  return wrap((await store('kits')).getAll() as IDBRequest<LibraryKit[]>);
}

export async function putKit(k: LibraryKit): Promise<void> {
  await wrap((await store('kits', 'readwrite')).put(k));
}

export async function deleteKit(id: string): Promise<void> {
  await wrap((await store('kits', 'readwrite')).delete(id));
}

export async function allFolders(): Promise<RefFolder[]> {
  return wrap((await store('folders')).getAll() as IDBRequest<RefFolder[]>);
}

export async function putFolder(f: RefFolder): Promise<void> {
  await wrap((await store('folders', 'readwrite')).put(f));
}

export async function clearLibrary(): Promise<void> {
  for (const s of STORES) await wrap((await store(s, 'readwrite')).clear());
}

/** 中身のハッシュ（SHA-256 の先頭 16 文字） */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
