// エディタの IndexedDB（最近の曲の自動保存・本体に置いた曲の一覧・DTXMania の曲の一覧）。
// v1: recent（最近の曲）、v2: songs（本体 = このブラウザの保存領域に置いた曲フォルダの一覧。中身は OPFS）、
// v3: nxlib（DTXMania の曲：覚えたゲームのフォルダ・読んだ曲の一覧・一覧の小さい画像。src/nxlib/db.ts）

const DB = 'dtx-web-editor';
const VERSION = 3;

export type AppStore = 'recent' | 'songs' | 'nxlib';

export function openAppDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recent')) db.createObjectStore('recent', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('nxlib')) db.createObjectStore('nxlib', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // ほかのタブが新しい版で開こうとしたら閉じて譲る
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 1回の読み書き（終わったら閉じる） */
export async function idb<T>(store: AppStore, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openAppDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () => reject(req.error);
    // 書き込みは確定してから返す
    t.oncomplete = () => {
      db.close();
      resolve(result);
    };
    t.onabort = () => {
      db.close();
      reject(t.error ?? req.error);
    };
  });
}
