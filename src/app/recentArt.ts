// 「最近の曲」の小さい画像（曲の #PREIMAGE、無ければ #STAGEFILE）。
// 自動保存のときに作って控えに入れる（data URL の JPEG）。曲フォルダの許可はリロードすると消えることがあるので、開いている間に作っておく
import type { DtxDoc } from '../dtx/model';
import type { SongFolder } from '../fs/folder';
import { findFile } from '../fs/folder';

/** 一覧では 48px の四角（画面の倍率 2 まできれいに） */
const ART_PX = 96;

/** 同じ画像なら作り直さない（曲フォルダ・パス・大きさが同じ） */
let last: { sig: string; art: string | undefined } | null = null;

/** 画像のパス（#PREIMAGE、無ければ #STAGEFILE） */
export function artPathOf(doc: DtxDoc): string {
  return (doc.fields['PREIMAGE'] || doc.fields['STAGEFILE'] || '').trim();
}

/** 控えに入れる画像（作れなければ空） */
export async function recentArt(doc: DtxDoc, folder: SongFolder | null): Promise<{ art?: string }> {
  const path = artPathOf(doc);
  if (!folder || !path) return {};
  const f = findFile(folder, path, doc.fields['PATH_WAV'] ?? '');
  if (!f) return {};
  const sig = `${folder.name}|${path.toLowerCase()}|${f.size}|${f.ver ?? 0}`;
  if (last?.sig !== sig) {
    let art: string | undefined;
    try {
      art = await squareJpeg(await f.getFile());
    } catch {
      // 読めない画像（TGA など）は画像なしで出す
      art = undefined;
    }
    last = { sig, art };
  }
  return last.art ? { art: last.art } : {};
}

/** 真ん中を四角に切り抜いた小さい JPEG */
async function squareJpeg(file: Blob): Promise<string | undefined> {
  if (file.size > 32 * 1024 * 1024 || typeof createImageBitmap !== 'function') return undefined;
  const bmp = await createImageBitmap(file);
  try {
    const side = Math.min(bmp.width, bmp.height);
    if (side < 1) return undefined;
    const c = document.createElement('canvas');
    c.width = ART_PX;
    c.height = ART_PX;
    const g = c.getContext('2d');
    if (!g) return undefined;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, ART_PX, ART_PX);
    return c.toDataURL('image/jpeg', 0.82);
  } finally {
    bmp.close();
  }
}
