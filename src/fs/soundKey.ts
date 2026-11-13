// 読み込んだ音の鍵（曲フォルダの名前・パス・大きさ・版）。同じ鍵の音は、読み込み・原曲の解析・ドラムの採譜・スペクトルをやり直さない。
// 保存で曲フォルダが替わったとき（新しい曲を初めて保存した・ほかの曲も入ったフォルダから移した）は、
// 書き写した同じ中身のファイルを前の鍵のまま読む（carrySoundKeys）。中身が変われば（大きさ・版）新しい鍵になる
import { normPath, type FolderFile, type SongFolder } from './folder';

/** 新しい鍵 → 前の鍵 */
const alias = new Map<string, string>();

const rawKey = (folderName: string | undefined, f: Pick<FolderFile, 'path' | 'size' | 'ver'>) => `${folderName}|${f.path}|${f.size}|${f.ver ?? 0}`;

/** 曲フォルダのファイルの音の鍵 */
export function soundKey(folder: SongFolder | null | undefined, f: Pick<FolderFile, 'path' | 'size' | 'ver'>): string {
  const k = rawKey(folder?.name, f);
  return alias.get(k) ?? k;
}

/**
 * 曲フォルダを替えた（from のファイルを to へ書き写した）：同じパス・大きさのファイルは前の鍵で読む。
 * from はほかの曲も入ったフォルダのことがあるので、写した先（to）のファイルから引く
 */
export function carrySoundKeys(from: SongFolder | null | undefined, to: SongFolder) {
  if (!from || from === to) return;
  for (const t of to.files.values()) {
    const f = from.files.get(normPath(t.path));
    if (!f || f.size !== t.size) continue;
    const next = rawKey(to.name, t);
    const prev = soundKey(from, f);
    if (next !== prev) alias.set(next, prev);
  }
}

/** 同じ中身を同じ曲フォルダに書き直した（メモリにだけあったファイルを保存で書いた）：前の鍵で読む */
export function keepSoundKey(folder: SongFolder, before: Pick<FolderFile, 'path' | 'size' | 'ver'>) {
  const t = folder.files.get(normPath(before.path));
  if (!t || t.size !== before.size) return;
  const next = rawKey(folder.name, t);
  const prev = soundKey(folder, before);
  if (next !== prev) alias.set(next, prev);
}

/** テスト用 */
export function clearSoundKeys() {
  alias.clear();
}
