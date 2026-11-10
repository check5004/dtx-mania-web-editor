// 最近の曲。編集中の譜面はブラウザ内（IndexedDB）に自動保存して、閉じても失わないようにする。
// 本体（このブラウザの保存領域）に置いた曲は local に曲の id を持ち、開き直すと音ごと戻る。
// 控えは難易度（DTX）ごとに持つ（保存していない続きを難易度ごとに残すため）が、一覧には曲ごとに1つだけ出す（groupRecent）。
import { idb } from './db';
import type { FolderFile, SongFolder } from './folder';

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

/**
 * 同じ曲の控えをまとめる鍵。本体の曲は曲の id、曲フォルダの曲はフォルダの名前（控えの id と同じく大文字・小文字は見ない）、
 * フォルダの無い新しい曲は控えごとに別の曲
 */
export function songKeyOf(e: Pick<RecentEntry, 'id' | 'local' | 'folderName'>): string {
  if (e.local) return `local:${e.local}`;
  if (e.folderName) return `folder:${e.folderName.toLowerCase()}`;
  return `entry:${e.id}`;
}

/** 「最近の曲」の1曲 */
export interface RecentSong {
  key: string;
  /** いちばん新しい控え（一覧にはこの難易度を出し、押すとこれを開く） */
  latest: RecentEntry;
  /** この曲の控え（難易度ごと。新しい順） */
  entries: RecentEntry[];
}

/** 控えを曲ごとにまとめる（難易度を切り替えても同じ曲が並ばないように）。新しい順 */
export function groupRecent(all: readonly RecentEntry[]): RecentSong[] {
  const songs = new Map<string, RecentSong>();
  for (const e of [...all].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = songKeyOf(e);
    const song = songs.get(key);
    if (song) song.entries.push(e);
    else songs.set(key, { key, latest: e, entries: [e] });
  }
  return [...songs.values()];
}

/** 「最近の曲」の一覧（曲ごとに1つ） */
export async function listRecentSongs(): Promise<RecentSong[]> {
  return groupRecent(await listRecent());
}

const MAX_RECENT = 12;

/** 古いので消す控え：曲ごとに数えて、新しい max 曲より前の曲の控えを全部。本体の曲は数えない・消さない */
export function staleRecent(all: readonly RecentEntry[], max = MAX_RECENT): RecentEntry[] {
  return groupRecent(all.filter((e) => !e.local))
    .slice(max)
    .flatMap((s) => s.entries);
}

/**
 * 古い自動保存を消す。本体の曲は数えない・消さない（音も一緒に消えてしまうので、一覧の ✕ で消してもらう）
 */
export async function trimRecent() {
  for (const e of staleRecent(await listRecent())) await deleteRecent(e.id);
}

/** 曲フォルダの譜面の控えの鍵（本体の曲は曲の id、曲フォルダの曲はフォルダの名前とファイル名。大文字・小文字は見ない） */
export function recentIdFor(folder: Pick<SongFolder, 'name' | 'local'> | null, fileName: string) {
  if (folder?.local) return `local:${folder.local}/${fileName}`.toLowerCase();
  return `${folder?.name ?? 'new'}/${fileName}`.toLowerCase();
}

/**
 * 難易度の保存していない続き（自動保存の控え）。譜面のファイルのほうが新しい（AI難易度生成で反映し直した・ほかで書き換えた）
 * ときは、古い続きなので使わない
 */
export async function draftFor(folder: SongFolder, file: FolderFile): Promise<RecentEntry | undefined> {
  const e = await getRecent(recentIdFor(folder, file.name));
  if (!e || e.saved) return undefined;
  try {
    return e.updatedAt >= (await file.getFile()).lastModified ? e : undefined;
  } catch {
    return undefined;
  }
}
