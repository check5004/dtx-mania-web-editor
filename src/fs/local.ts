// 本体（このブラウザの保存領域）に置いた曲フォルダの一覧と開き方。
// iPad の Safari と、PC でフォルダを選んでいない曲（ZIP・落としたファイル・新しい曲・フォルダに書けないブラウザ）は、
// 曲フォルダごと本体に置き、PC の「曲フォルダに直接保存」と同じように読み書きする。
// 一覧（名前・大きさ）は IndexedDB の songs、中身は OPFS の songs/<id>/。
import { idb } from './db';
import { folderFromHandle, type SongFolder } from './folder';
import { checkOpfs, listSongDirs, opfsReady, removeSongDir, songDir } from './opfs';
import { deleteRecentOfLocal } from './recent';

export interface LocalSong {
  id: string;
  /** 曲フォルダの名前（ZIP の中のフォルダ名など） */
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 中のファイルの大きさの合計（だいたい） */
  bytes: number;
  files: number;
  /** まだ入れている途中（入れ終わる前に閉じたら、次に開いたときに消す） */
  incomplete?: boolean;
  /** PC（フォルダに直接保存できるブラウザ）で、保存のときに曲フォルダを選ばず、本体に保存する */
  keepInBrowser?: boolean;
  /** Google Drive の曲フォルダの id（Drive とつないだ曲。Drive から開くとき、この端末の曲を使う） */
  drive?: string;
}

export { checkOpfs as checkLocal, opfsReady as localReady };

export async function listLocalSongs(): Promise<LocalSong[]> {
  try {
    const all = await idb<LocalSong[]>('songs', 'readonly', (s) => s.getAll() as IDBRequest<LocalSong[]>);
    return all.filter((x) => !x.incomplete).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function getLocalSong(id: string): Promise<LocalSong | undefined> {
  try {
    return await idb<LocalSong | undefined>('songs', 'readonly', (s) => s.get(id) as IDBRequest<LocalSong | undefined>);
  } catch {
    return undefined;
  }
}

export async function putLocalSong(rec: LocalSong): Promise<void> {
  await idb('songs', 'readwrite', (s) => s.put(rec));
}

export async function updateLocalSong(id: string, patch: Partial<LocalSong>): Promise<void> {
  const rec = await getLocalSong(id);
  if (rec) await putLocalSong({ ...rec, ...patch });
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 新しい曲の場所を作る（入れ終わったら finishLocalSong） */
export async function createLocalSong(name: string): Promise<LocalSong> {
  const now = Date.now();
  const rec: LocalSong = { id: newId(), name, createdAt: now, updatedAt: now, bytes: 0, files: 0, incomplete: true };
  // 一覧を先に書く（途中で閉じても、次に開いたときに片付けられるように）
  await putLocalSong(rec);
  await songDir(rec.id, true);
  return rec;
}

/** 入れ終わった・保存した：大きさと時刻を書く */
export async function finishLocalSong(id: string, folder: SongFolder): Promise<void> {
  let bytes = 0;
  for (const f of folder.files.values()) bytes += f.size;
  await updateLocalSong(id, { incomplete: false, updatedAt: Date.now(), bytes, files: folder.files.size, name: folder.name });
}

/** 本体から曲を消す（音・ステム・自動保存も） */
export async function deleteLocalSong(id: string): Promise<void> {
  await removeSongDir(id);
  try {
    await idb('songs', 'readwrite', (s) => s.delete(id));
  } catch {
    // 一覧が使えない
  }
  await deleteRecentOfLocal(id);
}

/** 本体の曲を曲フォルダとして開く。無い（消えた・入れている途中だった）なら null */
export async function openLocalSong(id: string): Promise<SongFolder | null> {
  const rec = await getLocalSong(id);
  if (!rec || rec.incomplete) return null;
  try {
    const dir = await songDir(id);
    const folder = await folderFromHandle(dir);
    return { ...folder, name: rec.name, local: id };
  } catch {
    return null;
  }
}

/** 同じ名前の曲が本体にあるか（ZIP・フォルダを入れ直したとき） */
export async function findLocalByName(name: string): Promise<LocalSong | undefined> {
  const key = name.trim().toLowerCase();
  return (await listLocalSongs()).find((x) => x.name.trim().toLowerCase() === key);
}

/** 同じ名前が本体にあれば「名前 (2)」にする */
export async function freeLocalName(name: string): Promise<string> {
  const taken = new Set((await listLocalSongs()).map((x) => x.name.trim().toLowerCase()));
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let i = 2; i < 100; i++) if (!taken.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`;
  return `${name} (${Date.now()})`;
}

/**
 * 開いたときの片付け：入れている途中で閉じた曲（10分以上前）と、一覧に無いフォルダを消す
 */
export async function cleanupLocal(now = Date.now()): Promise<number> {
  if (!(await checkOpfs())) return 0;
  let removed = 0;
  let recs: LocalSong[] = [];
  try {
    recs = await idb<LocalSong[]>('songs', 'readonly', (s) => s.getAll() as IDBRequest<LocalSong[]>);
  } catch {
    return 0;
  }
  for (const r of recs) {
    if (r.incomplete && now - r.updatedAt > 10 * 60_000) {
      await deleteLocalSong(r.id);
      removed++;
    }
  }
  const known = new Set(recs.map((r) => r.id));
  for (const id of await listSongDirs()) {
    if (known.has(id)) continue;
    await removeSongDir(id);
    removed++;
  }
  return removed;
}

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

export async function storageInfo(): Promise<StorageInfo | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  } catch {
    return null;
  }
}

/** 消えないようにブラウザに頼む（Safari・Chrome は自分で決め、Firefox は聞いてくる）。結果を返す */
export async function requestPersist(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
