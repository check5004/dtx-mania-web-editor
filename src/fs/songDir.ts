// 曲フォルダかどうかを見分ける。
// NX は DTXFiles の中を下までたどり、譜面（.dtx など）・set.def があるフォルダを1曲、box.def があるフォルダを曲のまとまりとして読む。
// だから曲フォルダの中に「譜面のあるサブフォルダ」があれば、それはほかの曲。DTXFiles のような曲を集めたフォルダを曲フォルダとして
// 選んでしまったときに、そこへ曲のファイルを広げたり、ほかの曲まで Google Drive に送ったりしないために使う。
import { joinPath, normPath, type FolderFile, type SongFolder } from './folder';

/** 譜面のファイル（NX が曲として読む） */
export const CHART_EXT = /\.(dtx|gda|g2d|bms|bme|bml)$/i;

/**
 * 曲フォルダにしか無いファイル：譜面・set.def・box.def と、NX が譜面の横に書く成績（*.score.ini）。
 * 成績は小さいので、途中まで送った曲フォルダ（譜面より先に送られた）でも見分けられる
 */
export function isSongMark(name: string): boolean {
  return CHART_EXT.test(name) || /^(set|box)\.def$/i.test(name) || /\.score\.ini$/i.test(name);
}

/**
 * 相対パスの一覧から、ほかの曲のフォルダを返す：直下に譜面・set.def・box.def（成績）があるサブフォルダ。
 * いちばん浅い所だけ（中にある曲のフォルダは、その外のフォルダにまとめる）。正規化したパス（小文字・'/' 区切り）
 */
export function otherSongDirs(paths: Iterable<string>): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = normPath(p).split('/');
    if (parts.length < 2 || !isSongMark(parts[parts.length - 1])) continue;
    dirs.add(parts.slice(0, -1).join('/'));
  }
  const out: string[] = [];
  for (const d of [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b))) if (!out.some((o) => d.startsWith(`${o}/`))) out.push(d);
  return out.sort();
}

/** パスが、どれかのフォルダの中か（dirs は otherSongDirs の形） */
export function inDirs(path: string, dirs: readonly string[]): boolean {
  if (!dirs.length) return false;
  const key = normPath(path);
  return dirs.some((d) => key.startsWith(`${d}/`));
}

/** フォルダの中の、ほかの曲のフォルダ（曲フォルダなら空） */
export function otherSongsIn(folder: SongFolder | null | undefined): string[] {
  return folder ? otherSongDirs([...folder.files.values()].map((f) => f.path)) : [];
}

/** ほかの曲のフォルダの、元の綴りの名前（知らせる文に出す） */
export function dirLabel(folder: SongFolder, dir: string): string {
  const n = dir.split('/').length;
  for (const f of folder.files.values()) {
    if (normPath(f.path).startsWith(`${dir}/`)) return f.path.split('/').slice(0, n).join('/');
  }
  return dir;
}

/** 名前の一覧を短く（「a、b、c ほか 12 個」） */
export function fewNames(names: readonly string[], max: number, sep: string, more: (n: number) => string): string {
  const shown = names.slice(0, max).join(sep);
  return names.length > max ? `${shown}${more(names.length - max)}` : shown;
}

// ---- 曲のフォルダの名前 --------------------------------------------------------------

/** Windows・mac でフォルダの名前に使えない文字を除く */
export function safeFolderName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  s = s.replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s;
}

/** 仮の名前（新しい曲・選んだファイル）。日本語と英語のどちらで作った曲でも見分ける */
const PLACEHOLDER_NAMES = [
  ['新しい曲', 'New song'],
  ['選んだファイル', 'Selected files'],
];

/**
 * 新しく作る曲のフォルダの名前。いまの曲フォルダの名前（ZIP の曲フォルダなど）を使い、仮の名前や
 * 曲を集めたフォルダ（DTXFiles など）なら曲名にする
 */
export function songFolderName(o: { folder?: string; title?: string; library?: boolean }): string {
  const folder = o.folder?.trim() ?? '';
  const placeholder = PLACEHOLDER_NAMES.some((p) => p.includes(folder.replace(/\s*\(\d+\)$/, '')));
  const own = folder && !o.library && !placeholder ? safeFolderName(folder) : '';
  return own || safeFolderName(o.title ?? '') || (folder && !o.library ? safeFolderName(folder) : '') || 'song';
}

function sameName(a: string, b: string): boolean {
  return safeFolderName(a).toLowerCase() === safeFolderName(b).toLowerCase();
}

// ---- 選んだフォルダを見る（名前だけ） ------------------------------------------------------

export interface FolderLook {
  name: string;
  /** 直下のファイル・フォルダの数（OS が作る物は数えない） */
  entries: number;
  /** 直下の譜面 */
  charts: string[];
  /** 直下に set.def・box.def がある */
  setDef: boolean;
  box: boolean;
  /** 中にある曲のフォルダ（見つけた所まで） */
  songs: string[];
}

const OS_FILES = /^(\.ds_store|thumbs\.db|desktop\.ini)$/i;

/**
 * 選んだフォルダの直下と、その下（深さ3まで）を名前だけ見る。中身は読まないので、DTXFiles のように曲が数百あっても速い。
 * 曲のフォルダは max 個見つけたらやめる（一覧が要るときは max を大きく）
 */
export async function lookAtFolder(dir: FileSystemDirectoryHandle, max = 3): Promise<FolderLook> {
  const look: FolderLook = { name: dir.name, entries: 0, charts: [], setDef: false, box: false, songs: [] };
  const queue: [string, FileSystemDirectoryHandle, number][] = [];
  for await (const [name, h] of dir.entries()) {
    if (OS_FILES.test(name)) continue;
    look.entries++;
    if (h.kind === 'directory') queue.push([name, h as FileSystemDirectoryHandle, 1]);
    else if (/^set\.def$/i.test(name)) look.setDef = true;
    else if (/^box\.def$/i.test(name)) look.box = true;
    else if (CHART_EXT.test(name)) look.charts.push(name);
  }
  let seen = 0;
  while (queue.length && look.songs.length < max && seen < 20000) {
    const [path, h, depth] = queue.shift()!;
    let song = false;
    const kids: typeof queue = [];
    try {
      for await (const [name, k] of h.entries()) {
        seen++;
        if (k.kind === 'directory') {
          if (depth < 3) kids.push([`${path}/${name}`, k as FileSystemDirectoryHandle, depth + 1]);
        } else if (isSongMark(name)) song = true;
      }
    } catch {
      // 読めないフォルダは見ない
    }
    if (song) look.songs.push(path);
    else queue.push(...kids);
  }
  look.songs.sort((a, b) => a.localeCompare(b));
  return look;
}

/** 曲を集めたフォルダ（DTXFiles・box など）か */
export function isLibraryLook(look: FolderLook): boolean {
  return look.songs.length > 0 || look.box;
}

/**
 * 選んだフォルダにどう保存するか。
 * here：そのフォルダが曲のフォルダ（空のフォルダ・同じ名前の曲フォルダ）。
 * inside：中に曲のフォルダを作る（DTXFiles のように曲を集めたフォルダ・ほかの物が入ったフォルダ）。
 * other-song：ほかの曲のフォルダ（譜面がある）。混ぜないように聞く
 */
export function decidePlace(look: FolderLook, songName: string): 'here' | 'inside' | 'other-song' {
  if (isLibraryLook(look)) return 'inside';
  if (look.charts.length || look.setDef) return sameName(look.name, songName) ? 'here' : 'other-song';
  if (look.entries === 0) return /^dtxfiles$/i.test(look.name) ? 'inside' : 'here';
  return 'inside';
}

// ---- この曲のファイル ---------------------------------------------------------------

/** 譜面が使うファイル（#WAV・#BMP・#AVI・#PREVIEW など、値がファイル名の行）。正規化したパス */
export function chartRefs(text: string): string[] {
  const out = new Set<string>();
  const vals: string[] = [];
  let pathWav = '';
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*#([A-Za-z0-9_]+)\s*:?\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    const semi = v.indexOf(';');
    if (semi >= 0) v = v.slice(0, semi).trim();
    if (m[1].toUpperCase() === 'PATH_WAV') {
      pathWav = v;
      continue;
    }
    if (/\.[A-Za-z0-9]{2,4}$/.test(v)) vals.push(v);
  }
  for (const v of vals) {
    out.add(normPath(v));
    if (pathWav) out.add(normPath(joinPath(pathWav, v)));
  }
  return [...out];
}

/** 譜面の横に置く、この曲のファイルか（作業ファイル・つなぎの記録・set.def） */
function songSideFile(key: string): boolean {
  return key === 'set.def' || key === '.dtxe-drive.json' || /\.dtxe\.json$/.test(key) || CHART_EXT.test(key);
}

/** 曲の音・画像・動画（譜面がいま使っていなくても、書き出したミックスや差し替える前の原曲など、この曲の物と見てよい） */
const MEDIA_EXT = /\.(wav|ogg|mp3|xa|flac|m4a|opus|aac|wma|png|jpe?g|bmp|gif|webp|avi|mp4|wmv|mpe?g|mov|webm|mkv)$/i;

/**
 * 別の曲フォルダへ移すときに写す、この曲のファイル。
 * song：曲フォルダなら全部（中にほかの曲のフォルダが見つかれば library と同じ）。
 * library：ほかの曲も入ったフォルダ（DTXFiles など）。譜面が使うファイル・ステム（stems/）と、直下の譜面・作業ファイル・
 * set.def・つなぎの記録・成績・音・画像・動画だけ（直下にある ZIP や説明書きなど、曲の物でないファイルは写さない）。
 * strict：元の場所から消してよい物だけ。直下の譜面・作業ファイル・set.def・つなぎの記録・譜面が使うファイルと、stems/ の中
 * （サブフォルダは stems/ のほかには触らない。ほかの曲のファイルを消さないため）
 */
export function songFilesOf(folder: SongFolder, refs: ReadonlySet<string>, mode: 'song' | 'library' | 'strict' = 'song'): FolderFile[] {
  const files = [...folder.files.values()];
  const others = otherSongDirs(files.map((f) => f.path));
  if (mode === 'song' && !others.length) return files;
  return files.filter((f) => {
    const key = normPath(f.path);
    if (inDirs(key, others)) return false;
    if (mode === 'strict') return key.includes('/') ? key.startsWith('stems/') : refs.has(key) || songSideFile(key);
    if (refs.has(key) || key.startsWith('stems/')) return true;
    return !key.includes('/') && (songSideFile(key) || MEDIA_EXT.test(key) || /\.score\.ini$/.test(key));
  });
}

/** 曲を集めたフォルダの中の、1つの曲のフォルダ（読み込み済みのファイルから。dir は normPath の形） */
export function subFolder(folder: SongFolder, dir: string): SongFolder {
  const label = dirLabel(folder, dir);
  const n = dir.split('/').length;
  const files = new Map<string, FolderFile>();
  for (const f of folder.files.values()) {
    if (!normPath(f.path).startsWith(`${dir}/`)) continue;
    const path = f.path.split('/').slice(n).join('/');
    files.set(normPath(path), { ...f, path });
  }
  return { name: label.split('/').pop() || label, files };
}
