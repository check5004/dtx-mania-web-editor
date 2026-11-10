// 作業ファイル（.dtxe.json）を曲フォルダと「最近の曲」の自動保存の控えから読む（画面は持たない）。
// 作業ファイルは保存したときだけ曲フォルダに書くので、分けたステムなど作業ファイルだけを変えてまだ保存していないと、
// 曲フォルダには前の作業ファイルが残っている。控えの方が新しければ控えを読み、保存していない変更として扱う
// （前は曲フォルダの作業ファイルを先に読んだので、リロード・難易度の切り替えで分けたステムが消えた）。
import type { SongFolder } from '../fs/folder';
import { findFile } from '../fs/folder';
import { sidecarUnsaved, type RecentEntry } from '../fs/recent';
import { parseSidecar, sidecarDiff, sidecarName, type SidecarData } from './sidecar';

/**
 * 自動保存の控えの作業ファイル。unsaved: 曲フォルダへ保存していない変更がある（分けたステムなど）、at: 控えた時刻。
 * 文字列だけなら、曲フォルダに作業ファイルが無いときに使う控え
 */
export interface RecentSidecar {
  text: string;
  unsaved: boolean;
  at: number;
}

/** 「最近の曲」の控えの作業ファイル（無ければ undefined） */
export function recentSidecarOf(e: RecentEntry | undefined): RecentSidecar | undefined {
  return e?.sidecar ? { text: e.sidecar, unsaved: sidecarUnsaved(e), at: e.updatedAt } : undefined;
}

/**
 * 作業ファイル（.dtxe.json）の中身。保存していない変更のある控え（分けたステムなど）が曲フォルダの作業ファイルより新しければ控え
 * （unsaved に曲フォルダの作業ファイルと違う欄）、そうでなければ曲フォルダの作業ファイル。フォルダに無ければ控えを使う
 */
export async function readSidecarFor(
  folder: SongFolder | null,
  fileName: string,
  recent?: string | RecentSidecar,
): Promise<{ data: SidecarData | null; unsaved: (keyof SidecarData)[] }> {
  const f = folder ? findFile(folder, sidecarName(fileName)) : undefined;
  const r = typeof recent === 'string' ? { text: recent, unsaved: false, at: 0 } : recent;
  let saved: SidecarData | null = null;
  let savedAt = 0;
  if (f) {
    try {
      const file = await f.getFile();
      savedAt = file.lastModified;
      saved = parseSidecar(await file.text());
    } catch {
      saved = null;
    }
  }
  if (r?.unsaved && (!f || r.at >= savedAt)) {
    const d = parseSidecar(r.text);
    if (d) return { data: d, unsaved: sidecarDiff(saved, d) };
  }
  return { data: saved ?? (r ? parseSidecar(r.text) : null), unsaved: [] };
}
