// 最近の曲。編集中の譜面はブラウザ内（IndexedDB）に自動保存して、閉じても失わないようにする。

export interface RecentEntry {
  id: string;
  title: string;
  artist: string;
  bpm: string;
  level: string;
  fileName: string;
  folderName: string;
  dir?: FileSystemDirectoryHandle;
  /** 最後に自動保存した DTX の本文 */
  text: string;
  /** フォルダに保存済みの内容と同じか */
  saved: boolean;
  updatedAt: number;
}

const DB = 'dtx-web-editor';
const STORE = 'recent';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function putRecent(e: RecentEntry): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(e));
  } catch {
    // FileSystemDirectoryHandle を保存できないブラウザでは、フォルダなしで保存する
    try {
      await tx('readwrite', (s) => s.put({ ...e, dir: undefined }));
    } catch {
      // 保存領域が使えない（プライベートモードなど）
    }
  }
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const all = await tx<RecentEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecentEntry[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteRecent(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    // 無視
  }
}

const MAX_RECENT = 12;

export async function trimRecent() {
  const all = await listRecent();
  for (const e of all.slice(MAX_RECENT)) await deleteRecent(e.id);
}
