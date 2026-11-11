// DTXMania の曲の、このブラウザに残すもの（IndexedDB の nxlib）。
// - place：選んだフォルダ（FileSystemDirectoryHandle。Chrome が許可を覚えていれば、次から聞かれない）
// - list：読んだ曲の一覧（次に開いたらすぐ出し、裏で変わった曲だけ読み直す）
// - thumb:<曲の id>：一覧の小さい画像（JPEG）。元の画像の大きさと更新時刻（sig）が変わったら作り直す
import { idb, openAppDb } from '../fs/db';
import type { LibBox, LibSong } from './scan';

export interface NxExtra {
  /** Config.ini の DTXPath に書いてある、ゲームのフォルダの外のフォルダ（D:\DTX\ など） */
  path: string;
  /** 選んでもらったフォルダ（まだなら無い） */
  dir?: FileSystemDirectoryHandle;
}

export interface NxPlace {
  /** 選んだフォルダ */
  root: FileSystemDirectoryHandle;
  /** game：ゲームのフォルダ（Config.ini の DTXPath を読む）。dtxfiles：曲を集めたフォルダ（DTXFiles など） */
  kind: 'game' | 'dtxfiles';
  name: string;
  /** Config.ini の DTXPath（game のとき。無ければ NX の既定の「.\」） */
  dtxPath: string[];
  extra: NxExtra[];
  at: number;
}

export interface NxList {
  at: number;
  songs: LibSong[];
  boxes: LibBox[];
  folders: number;
}

type Rec = ({ id: 'place' } & NxPlace) | ({ id: 'list' } & NxList) | { id: string; sig: string; blob: Blob };

async function get<T>(id: string): Promise<T | null> {
  try {
    return ((await idb<Rec | undefined>('nxlib', 'readonly', (s) => s.get(id) as IDBRequest<Rec | undefined>)) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

async function put(rec: Rec): Promise<void> {
  try {
    await idb('nxlib', 'readwrite', (s) => s.put(rec));
  } catch {
    // 保存領域が使えない（プライベートモードなど）。一覧はこの画面の間だけになる
  }
}

export async function loadPlace(): Promise<NxPlace | null> {
  const r = await get<{ id: 'place' } & NxPlace>('place');
  if (!r?.root) return null;
  const { id: _id, ...p } = r;
  return p;
}

export function savePlace(p: NxPlace): Promise<void> {
  return put({ id: 'place', ...p });
}

export async function loadList(): Promise<NxList | null> {
  const r = await get<{ id: 'list' } & NxList>('list');
  if (!r || !Array.isArray(r.songs)) return null;
  const { id: _id, ...l } = r;
  return l;
}

export function saveList(l: NxList): Promise<void> {
  return put({ id: 'list', ...l });
}

const THUMB = 'thumb:';

export async function loadThumbs(): Promise<Map<string, { sig: string; blob: Blob }>> {
  const out = new Map<string, { sig: string; blob: Blob }>();
  try {
    const all = await idb<{ id: string; sig: string; blob: Blob }[]>(
      'nxlib',
      'readonly',
      (s) => s.getAll(IDBKeyRange.bound(THUMB, `${THUMB}\uffff`)) as IDBRequest<{ id: string; sig: string; blob: Blob }[]>,
    );
    for (const r of all) if (r.blob) out.set(r.id.slice(THUMB.length), { sig: r.sig, blob: r.blob });
  } catch {
    // 読めなければ画像なしで出す
  }
  return out;
}

export function saveThumb(songId: string, sig: string, blob: Blob): Promise<void> {
  return put({ id: `${THUMB}${songId}`, sig, blob });
}

/** 一覧と画像を全部消す（別のフォルダを選んだ・忘れる） */
export async function clearNxLib(keepPlace: boolean): Promise<void> {
  try {
    const db = await openAppDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('nxlib', 'readwrite');
      const s = t.objectStore('nxlib');
      if (keepPlace) {
        s.delete('list');
        s.delete(IDBKeyRange.bound(THUMB, `${THUMB}\uffff`));
      } else s.clear();
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onabort = () => {
        db.close();
        reject(t.error);
      };
    });
  } catch {
    // 消せなくても続ける
  }
}

/** もう一覧に無い曲の画像を消す */
export async function pruneThumbs(keep: ReadonlySet<string>): Promise<void> {
  try {
    const db = await openAppDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('nxlib', 'readwrite');
      const s = t.objectStore('nxlib');
      const req = s.getAllKeys(IDBKeyRange.bound(THUMB, `${THUMB}\uffff`));
      req.onsuccess = () => {
        for (const k of req.result as string[]) if (!keep.has(k.slice(THUMB.length))) s.delete(k);
      };
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onabort = () => {
        db.close();
        reject(t.error);
      };
    });
  } catch {
    // 消せなくても続ける
  }
}
