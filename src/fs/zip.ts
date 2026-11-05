// ZIP にまとめた曲フォルダを開く。iPad の Safari はフォルダを選べないので、曲は ZIP で受け渡す
// （ファイル App の「圧縮」・PC で作った ZIP）。中身はメモリに持ち、保存は ZIP にまとめて共有・ダウンロードする。
import { unzip, type Unzipped } from 'fflate';
import { normPath, type FolderFile, type SongFolder } from './folder';

/**
 * ZIP の中のファイル名。UTF-8 の印が無い ZIP（Windows の日本語名は Shift_JIS）は fflate が 1バイト=1文字で読むので、
 * バイトに戻して UTF-8（だめなら Shift_JIS）で読み直す
 */
export function fixZipName(name: string): string {
  if (!/[\u0080-ÿ]/.test(name) || /[Ā-￿]/.test(name)) return name;
  const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(bytes);
    } catch {
      return name;
    }
  }
}

function unzipAsync(buf: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => unzip(buf, (err, data) => (err ? reject(err) : resolve(data))));
}

const skip = (p: string) => p.endsWith('/') || /(^|\/)__MACOSX\//.test(p) || /(^|\/)\.DS_Store$/i.test(p) || /(^|\/)\._/.test(p);

export interface ZipEntries {
  /** ZIP の名前（拡張子なし） */
  name: string;
  /** 直したパス → 中身 */
  files: Map<string, Uint8Array>;
}

export async function readZip(file: File): Promise<ZipEntries> {
  const raw = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
  const files = new Map<string, Uint8Array>();
  for (const [p, data] of Object.entries(raw)) {
    const path = fixZipName(p).replace(/\\/g, '/');
    if (skip(path)) continue;
    files.set(path, data);
  }
  return { name: file.name.replace(/\.zip$/i, ''), files };
}

/** ZIP の中の曲フォルダ（DTX があるフォルダ）ごとに、そのフォルダからのパスにした曲フォルダ。浅い所から */
export function songFoldersOf(z: ZipEntries): SongFolder[] {
  const dirs = new Set<string>();
  for (const p of z.files.keys()) {
    if (!/\.dtx$/i.test(p)) continue;
    const i = p.lastIndexOf('/');
    dirs.add(i < 0 ? '' : p.slice(0, i));
  }
  const list = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return list.map((dir) => folderOf(z, dir));
}

/** ZIP の dir（'' は一番上）を曲フォルダにする。中のフォルダ（WAV/ など）もそのまま */
export function folderOf(z: ZipEntries, dir: string): SongFolder {
  const prefix = dir ? `${dir}/` : '';
  const files = new Map<string, FolderFile>();
  for (const [p, data] of z.files) {
    if (!p.startsWith(prefix)) continue;
    const path = p.slice(prefix.length);
    if (!path) continue;
    const name = path.split('/').pop()!;
    let made: File | null = null;
    files.set(normPath(path), {
      path,
      name,
      size: data.length,
      getFile: async () => (made ??= new File([data as Uint8Array<ArrayBuffer>], name)),
    });
  }
  return { name: dir ? dir.split('/').pop()! : z.name, files };
}
