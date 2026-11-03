// 画像の候補を読み込み、切り取って曲フォルダに PNG で書き出し、#PREIMAGE などに設定する。
import type { ArtCandidate } from '../ai/songInfo';
import { downloadBytes, findFile, putFile } from '../fs/folder';
import { setFieldValue, useEditor } from '../store/editor';

export interface ArtPreset {
  id: string;
  label: string;
  key: 'PREIMAGE' | 'STAGEFILE' | 'BACKGROUND';
  w: number;
  h: number;
  file: string;
}

export const ART_PRESETS: ArtPreset[] = [
  { id: 'pre-sq', label: 'PREIMAGE 正方形 400×400', key: 'PREIMAGE', w: 400, h: 400, file: 'preimage.png' },
  { id: 'pre-old', label: 'PREIMAGE 縦長 204×269（旧DTXMania）', key: 'PREIMAGE', w: 204, h: 269, file: 'preimage.png' },
  { id: 'stage', label: 'STAGEFILE 1280×720', key: 'STAGEFILE', w: 1280, h: 720, file: 'stagefile.png' },
  { id: 'bg', label: 'BACKGROUND 1280×720', key: 'BACKGROUND', w: 1280, h: 720, file: 'background.png' },
];

export const artPreset = (id: string) => ART_PRESETS.find((p) => p.id === id)!;

function loadImg(src: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('読み込めませんでした'));
    im.src = src;
  });
}

/**
 * 候補の画像を読み込む。大きい画像を先に試す。tainted は配信元が書き出しを許していない（切り取れない）とき。
 */
export async function loadArtImage(cand: ArtCandidate): Promise<{ img: HTMLImageElement; tainted: boolean }> {
  const srcs = cand.big !== cand.url ? [cand.big, cand.url] : [cand.url];
  for (const src of srcs) {
    try {
      const im = await loadImg(src, cand.source !== 'file');
      // YouTube の maxres が無いときは 120×90 の灰色が返る
      if (im.naturalWidth <= 120 && src !== srcs[srcs.length - 1]) continue;
      return { img: im, tainted: false };
    } catch {
      try {
        return { img: await loadImg(src, false), tainted: true };
      } catch {
        // 次
      }
    }
  }
  throw new Error('画像を読み込めませんでした');
}

/** 縦横比を合わせて真ん中を切り取る範囲（画像の画素） */
export function coverRect(iw: number, ih: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const aspect = w / h;
  const cw = Math.min(iw, ih * aspect);
  const ch = cw / aspect;
  return { x: (iw - cw) / 2, y: (ih - ch) / 2, w: cw, h: ch };
}

/**
 * 切り取って PNG にし、曲フォルダに書いて（無ければダウンロード）#キー に設定する。書いたファイル名と、どこに書いたかを返す。
 * 配信元が書き出しを許していなければ Error。
 */
export async function saveArt(img: HTMLImageElement, rect: { x: number; y: number; w: number; h: number }, preset: ArtPreset): Promise<{ name: string; where: 'written' | 'memory' | 'download' }> {
  const c = document.createElement('canvas');
  c.width = preset.w;
  c.height = preset.h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, preset.w, preset.h);
  let blob: Blob | null = null;
  try {
    blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  } catch {
    blob = null;
  }
  if (!blob) throw new Error('この画像は配信元が書き出しを許可していないため切り取れません。画像を保存してから「画像ファイルを選ぶ」で選んでください');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const folder = useEditor.getState().folder;
  let name = preset.file;
  if (folder) {
    // 同じ名前があれば番号を付ける
    for (let i = 2; findFile(folder, name) && i < 50; i++) name = preset.file.replace('.png', `_${i}.png`);
    const where = await putFile(folder, name, bytes);
    setFieldValue(preset.key, name, `#${preset.key} を ${name} にする`);
    return { name, where };
  }
  downloadBytes(name, bytes, 'image/png');
  setFieldValue(preset.key, name, `#${preset.key} を ${name} にする`);
  return { name, where: 'download' };
}

/** 候補を読み込んで、真ん中を切り取って設定する */
export async function saveArtCentered(cand: ArtCandidate, preset: ArtPreset) {
  const { img } = await loadArtImage(cand);
  return saveArt(img, coverRect(img.naturalWidth, img.naturalHeight, preset.w, preset.h), preset);
}
