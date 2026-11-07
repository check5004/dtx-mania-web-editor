// iPad のホーム画面のアプリを開いたときの起動画面（apple-touch-startup-image）。
// iOS は manifest から起動画面を作らず、画面の大きさと向きがぴったり合う画像だけを使う（無いと無地の画面になる）。
// 画像は scripts/make-pwa-images.mjs で作って public/splash/ に置き、<link> はビルドのとき（vite-plugin.ts）に index.html へ足す。
// スマホ版はまだ無いので iPad だけ。

export interface SplashSize {
  /** 縦向きの幅・高さ（CSS ピクセル）。iOS の device-width・device-height は向きで入れ替わらない */
  w: number;
  h: number;
  dpr: number;
  /** どの iPad か（メモ） */
  name: string;
}

export const SPLASH_SIZES: readonly SplashSize[] = [
  { w: 744, h: 1133, dpr: 2, name: 'iPad mini (6th/7th gen)' },
  { w: 768, h: 1024, dpr: 2, name: 'iPad 9.7", iPad mini (5th gen)' },
  { w: 810, h: 1080, dpr: 2, name: 'iPad 10.2" (7th-9th gen)' },
  { w: 820, h: 1180, dpr: 2, name: 'iPad (10th/11th gen), iPad Air 11"' },
  { w: 834, h: 1112, dpr: 2, name: 'iPad Air 10.5", iPad Pro 10.5"' },
  { w: 834, h: 1194, dpr: 2, name: 'iPad Pro 11" (1st-4th gen)' },
  { w: 834, h: 1210, dpr: 2, name: 'iPad Pro 11" (M4 and later)' },
  { w: 1024, h: 1366, dpr: 2, name: 'iPad Pro 12.9", iPad Air 13"' },
  { w: 1032, h: 1376, dpr: 2, name: 'iPad Pro 13" (M4 and later)' },
];

/** 画像のファイル名（public/ からの相対） */
export function splashFile(s: SplashSize, landscape: boolean): string {
  return `splash/ipad-${s.w}x${s.h}-${landscape ? 'land' : 'port'}.png`;
}

/** 画像の大きさ（ピクセル） */
export function splashPixels(s: SplashSize, landscape: boolean): { width: number; height: number } {
  const a = s.w * s.dpr;
  const b = s.h * s.dpr;
  return landscape ? { width: b, height: a } : { width: a, height: b };
}

export function splashMedia(s: SplashSize, landscape: boolean): string {
  return `(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: ${landscape ? 'landscape' : 'portrait'})`;
}

/** index.html に足す <link>（base は Vite の base。例 /dtx-mania-web-editor/） */
export function splashLinks(base: string): { href: string; media: string }[] {
  return SPLASH_SIZES.flatMap((s) => [false, true].map((land) => ({ href: base + splashFile(s, land), media: splashMedia(s, land) })));
}
