// ホーム画面に追加した（インストールした）アプリとして開いているか。
// - iPad・iPhone: ホーム画面のアプリは navigator.standalone が true（古い決まりだが今も使える）。
//   manifest の display が standalone でも display-mode: fullscreen にしか当たらないことがある（WebKit bug 264218）ので、
//   iOS では fullscreen も「アプリとして開いている」に数える
// - PC・Android の Chrome・Edge: display-mode が standalone・minimal-ui・window-controls-overlay。
//   Chrome はタブを「アプリで開く」と読み込み直さずにアプリの窓へ移すので、変わったら onDisplayModeChange で知らせる
// iPad では Safari のタブとホーム画面のアプリは保存（IndexedDB・Cache・OPFS）が別。

/** iPad・iPhone（iPadOS の Safari は Mac と名乗るので、指で触れるかで見分ける。store/device の IS_IOS と同じ） */
const IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

const APP_MODES = ['(display-mode: standalone)', '(display-mode: minimal-ui)', '(display-mode: window-controls-overlay)'];

function matches(q: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
}

/** いま、ホーム画面・アプリの窓から開いているか */
export function isStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  if (APP_MODES.some(matches)) return true;
  return IOS && matches('(display-mode: fullscreen)');
}

/**
 * 開いたときにアプリとして開いていたか。iPad では途中で変わらない（Safari のタブとホーム画面のアプリは別の窓）ので、
 * 保存の注意などはこれを見ればよい。PC の Chrome はタブからアプリの窓へ移せるので、画面の表示は onDisplayModeChange も見る
 */
export const STANDALONE_AT_START = isStandalone();

/** アプリの窓へ移った・タブに戻ったときに呼ぶ。戻り値で止める */
export function onDisplayModeChange(cb: (standalone: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const lists = APP_MODES.map((q) => window.matchMedia(q));
  const fire = () => cb(isStandalone());
  for (const l of lists) l.addEventListener('change', fire);
  return () => {
    for (const l of lists) l.removeEventListener('change', fire);
  };
}
