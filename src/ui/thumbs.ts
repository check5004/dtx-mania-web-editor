// 曲フォルダの画像を読み込んでおく（BGA 列のサムネイルとプレビュー）。
import { create } from 'zustand';
import { materialFile } from '../store/bga';
import { useEditor } from '../store/editor';

const cache = new Map<string, { img: HTMLImageElement | null; url: string | null; loading: boolean }>();
export const useThumbs = create<{ ver: number }>(() => ({ ver: 0 }));

/** 画像を返す（まだ読めていなければ null を返し、読めたら useThumbs が変わる） */
export function thumb(path: string): HTMLImageElement | null {
  const key = path.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit.img;
  const f = materialFile(path);
  cache.set(key, { img: null, url: null, loading: true });
  if (!f) return null;
  void (async () => {
    try {
      const file = await f.getFile();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        cache.set(key, { img, url, loading: false });
        useThumbs.setState((s) => ({ ver: s.ver + 1 }));
      };
      img.onerror = () => cache.set(key, { img: null, url, loading: false });
      img.src = url;
    } catch {
      cache.set(key, { img: null, url: null, loading: false });
    }
  })();
  return null;
}

/** 動画などの URL（<video> 用） */
export async function fileUrl(path: string): Promise<string | null> {
  const key = `url:${path.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit?.url) return hit.url;
  const f = materialFile(path);
  if (!f) return null;
  const url = URL.createObjectURL(await f.getFile());
  cache.set(key, { img: null, url, loading: false });
  return url;
}

/** 曲を開き直したら捨てる */
export function clearThumbs() {
  for (const v of cache.values()) if (v.url) URL.revokeObjectURL(v.url);
  cache.clear();
  useThumbs.setState((s) => ({ ver: s.ver + 1 }));
}

let lastFolder: unknown = null;
useEditor.subscribe((s) => {
  if (s.folder === lastFolder) return;
  lastFolder = s.folder;
  clearThumbs();
});
