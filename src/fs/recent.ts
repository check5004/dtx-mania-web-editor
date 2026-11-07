// 最近の曲。編集中の譜面はブラウザ内（IndexedDB）に自動保存して、閉じても失わないようにする。
// 本体（このブラウザの保存領域）に置いた曲は local に曲の id を持ち、開き直すと音ごと戻る。
import { idb } from './db';

export interface RecentEntry {
  id: string;
  title: string;
  artist: string;
  bpm: string;
  level: string;
  fileName: string;
  folderName: string;
  /** PC で選んだ曲フォルダ（File System Access） */
  dir?: FileSystemDirectoryHandle;
  /** 本体に置いた曲（src/fs/local.ts の id） */
  local?: string;
  /** Google Drive の曲フォルダの id（Drive とつないだ曲） */
  drive?: string;
  /** 最後に自動保存した DTX の本文 */
  text: string;
  /** 作業ファイル（.dtxe.json）の中身 */
  sidecar?: string;
  /** フォルダに保存済みの内容と同じか */
  saved: boolean;
  updatedAt: number;
}

export async function putRecent(e: RecentEntry): Promise<void> {
  try {
    await idb('recent', 'readwrite', (s) => s.put(e));
  } catch {
    // FileSystemDirectoryHandle を保存できないブラウザでは、フォルダなしで保存する
    try {
      await idb('recent', 'readwrite', (s) => s.put({ ...e, dir: undefined }));
    } catch {
      // 保存領域が使えない（プライベートモードなど）
    }
  }
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const all = await idb<RecentEntry[]>('recent', 'readonly', (s) => s.getAll() as IDBRequest<RecentEntry[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function getRecent(id: string): Promise<RecentEntry | undefined> {
  try {
    return await idb<RecentEntry | undefined>('recent', 'readonly', (s) => s.get(id) as IDBRequest<RecentEntry | undefined>);
  } catch {
    return undefined;
  }
}

export async function deleteRecent(id: string): Promise<void> {
  try {
    await idb('recent', 'readwrite', (s) => s.delete(id));
  } catch {
    // 無視
  }
}

/** 本体の曲の自動保存をまとめて消す（曲を本体から消した・曲フォルダへ移したとき） */
export async function deleteRecentOfLocal(localId: string): Promise<void> {
  for (const e of await listRecent()) if (e.local === localId) await deleteRecent(e.id);
}

const MAX_RECENT = 12;

/**
 * 古い自動保存を消す。本体の曲は数えない・消さない（音も一緒に消えてしまうので、一覧の ✕ で消してもらう）
 */
export async function trimRecent() {
  const all = (await listRecent()).filter((e) => !e.local);
  for (const e of all.slice(MAX_RECENT)) await deleteRecent(e.id);
}
