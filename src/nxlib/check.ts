// 点検（NX で困る所）のうち、譜面を全部読む物：譜面が使うファイルが無い・読めない名前（文字化け）・ドラムの譜面が無い。
// 一覧を出したあとに裏で 1 曲ずつ。譜面が前の点検と同じなら、前に読んだ「使うファイル」を使い、フォルダの中だけ見直す。
import { sjisCanWrite } from '../dtx/encoding';
import { normPath } from '../fs/folder';
import { CHART_EXT, isSongMark } from '../fs/songDir';
import { chartRefGroups, decodeHead, hasDrumChips, type RefGroup } from './parse';
import { chartsSig, type LibCheck, type LibSong } from './scan';

/** 点検で入れる種類（このほかは一覧を作るときに入れる） */
const DEEP_KINDS = new Set<LibCheck['kind']>(['missing', 'badname', 'nodrums']);

const MAX_LIST_DEPTH = 4;

/** 曲のフォルダのファイル（サブフォルダの中も。ほかの曲のフォルダ（譜面などがある）の中は除く）。正規化したパス → 元の名前 */
export async function listSongFiles(dir: FileSystemDirectoryHandle): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number, top: boolean) => {
    const files: string[] = [];
    const dirs: [string, FileSystemDirectoryHandle][] = [];
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'file') files.push(name);
      else dirs.push([name, h as FileSystemDirectoryHandle]);
    }
    // 曲のフォルダの中のサブフォルダに譜面などがあれば、それはほかの曲
    if (!top && files.some((n) => isSongMark(n))) return;
    for (const n of files) out.set(normPath(prefix ? `${prefix}/${n}` : n), n);
    if (depth >= MAX_LIST_DEPTH) return;
    for (const [n, h] of dirs) {
      try {
        await walk(h, prefix ? `${prefix}/${n}` : n, depth + 1, false);
      } catch {
        // 読めないフォルダは見ない
      }
    }
  };
  await walk(dir, '', 0, true);
  return out;
}

/** 名前に Shift_JIS で書けない字がある（NX の譜面からは呼べない名前） */
export function unreadableName(name: string): boolean {
  for (const ch of name) if (!sjisCanWrite(ch)) return true;
  return false;
}

export interface DeepCheck {
  checks: LibCheck[];
  checkedSig: string;
  refs: RefGroup[];
  drums: boolean;
}

/**
 * 1 曲を点検する。譜面を全部読むのは、前の点検から譜面が変わったときだけ。
 * 返す checks は、一覧を作るときの点検に、譜面を読んだ点検を足したもの
 */
export async function deepCheck(dir: FileSystemDirectoryHandle, song: LibSong): Promise<DeepCheck> {
  const sig = chartsSig(song.charts);
  let refs = song.checkedSig === sig ? song.refs : undefined;
  let drums = song.checkedSig === sig ? song.drums : undefined;
  const files = await listSongFiles(dir);
  if (!refs || drums === undefined) {
    const groups = new Map<string, RefGroup>();
    drums = false;
    for (const c of song.charts) {
      const h = files.has(normPath(c.file)) ? await fileAt(dir, c.file) : null;
      if (!h) continue;
      const text = decodeHead(new Uint8Array(await (await h.getFile()).arrayBuffer()), true);
      // 譜面がサブフォルダにあれば、使うファイルはその譜面のフォルダから
      const slash = c.file.lastIndexOf('/');
      const base = slash > 0 ? c.file.slice(0, slash) : '';
      for (const g of chartRefGroups(text)) {
        const r = base ? { name: `${base}/${g.name}`, keys: g.keys.map((k) => normPath(`${base}/${k}`)) } : g;
        if (!groups.has(r.keys[0])) groups.set(r.keys[0], r);
      }
      // .dtx のほか（.gda・.bms など）はドラムがあるものとする
      if (!drums && (hasDrumChips(text) || !/\.dtx$/i.test(c.file))) drums = true;
    }
    refs = [...groups.values()];
  }
  const missing = refs.filter((g) => !g.keys.some((k) => files.has(k))).map((g) => g.name);
  const checks = song.checks.filter((c) => !DEEP_KINDS.has(c.kind));
  if (missing.length) {
    checks.push({ kind: 'missing', n: missing.length, files: missing.slice(0, 8) });
    const bad = [...files.values()].filter((n) => unreadableName(n) && !CHART_EXT.test(n));
    if (bad.length) checks.push({ kind: 'badname', n: bad.length, files: bad.slice(0, 8) });
  }
  if (!drums) checks.push({ kind: 'nodrums' });
  return { checks, checkedSig: sig, refs, drums };
}

/** 曲のフォルダの中のファイル（'/' 区切りのパス。大文字・小文字は見ない） */
export async function fileAt(dir: FileSystemDirectoryHandle, rel: string): Promise<FileSystemFileHandle | null> {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  let cur = dir;
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i].toLowerCase();
    let found: FileSystemHandle | null = null;
    try {
      // まずはそのままの名前で（速い）
      found = i === parts.length - 1 ? await cur.getFileHandle(parts[i]) : await cur.getDirectoryHandle(parts[i]);
    } catch {
      for await (const [n, h] of cur.entries()) {
        if (n.toLowerCase() === want && h.kind === (i === parts.length - 1 ? 'file' : 'directory')) {
          found = h;
          break;
        }
      }
    }
    if (!found) return null;
    if (i === parts.length - 1) return found as FileSystemFileHandle;
    cur = found as FileSystemDirectoryHandle;
  }
  return null;
}

/** 場所からのフォルダの並びをたどる（大文字・小文字は見ない）。無ければ null */
export async function dirAt(root: FileSystemDirectoryHandle, path: readonly string[]): Promise<FileSystemDirectoryHandle | null> {
  let cur = root;
  for (const p of path) {
    let next: FileSystemDirectoryHandle | null = null;
    try {
      next = await cur.getDirectoryHandle(p);
    } catch {
      for await (const [n, h] of cur.entries()) {
        if (h.kind === 'directory' && n.toLowerCase() === p.toLowerCase()) {
          next = h as FileSystemDirectoryHandle;
          break;
        }
      }
    }
    if (!next) return null;
    cur = next;
  }
  return cur;
}
