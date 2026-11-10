// 動いているブラウザ・端末の判定。どのモジュールからも読めるように、ほかのファイルに頼らない。
// Safari（WebKit）向けの分岐はここの値で行う。決まりは docs/safari.md
// UA を引数で渡せる関数はテスト用（画面ではモジュールの定数を使う）。ホーム画面のアプリかは src/pwa/display.ts の isStandalone()。

type Nav = Pick<Navigator, 'userAgent' | 'maxTouchPoints'>;

const nav: Nav | null = typeof navigator !== 'undefined' ? navigator : null;

/** iPad・iPhone か（iPadOS の Safari は Mac と名乗るので、指で触れるかで見分ける） */
export function detectIos(ua: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** WebKit で動いているか（Mac の Safari と、iPad・iPhone のすべてのブラウザ。iPad の Chrome も WebKit） */
export function detectWebkit(ua: string, maxTouchPoints: number): boolean {
  if (detectIos(ua, maxTouchPoints)) return true;
  return /AppleWebKit\//.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Android/.test(ua);
}

/** Safari そのものか（iPad・iPhone の Chrome・Firefox・Edge などは除く）。chromeIos は Chrome が入れる印があるか */
export function detectSafari(ua: string, maxTouchPoints: number, chromeIos = false): boolean {
  if (!detectWebkit(ua, maxTouchPoints) || chromeIos) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|Ddg\//.test(ua);
}

/** Safari の版（Version/18.4 → [18, 4]）。iPad・iPhone で Version が無ければ OS の版。分からなければ null */
export function parseSafariVersion(ua: string): [number, number] | null {
  const v = /Version\/(\d+)(?:\.(\d+))?/.exec(ua);
  if (v) return [Number(v[1]), Number(v[2] ?? 0)];
  const os = /(?:CPU OS|iPhone OS) (\d+)[_.](\d+)/.exec(ua);
  if (os) return [Number(os[1]), Number(os[2])];
  return null;
}

const ua = nav?.userAgent ?? '';
const touch = nav?.maxTouchPoints ?? 0;
// iPad の Chrome はページに __gCrWeb を入れる（「PC 用サイトを表示」で UA が Mac になっても見分けられる）
const chromeIos = typeof window !== 'undefined' && '__gCrWeb' in window;

/** iPad・iPhone */
export const IS_IOS = detectIos(ua, touch);
/** iPhone（iPod touch も）。案内の文で「iPad」を「iPhone」にするときに使う */
export const IS_IPHONE = /iPhone|iPod/.test(ua);

/** 案内の文の「iPad」を iPhone では「iPhone」に、「iPadOS」を「iOS」にする。PC・iPad ではそのまま */
export function iosName(text: string, iphone = IS_IPHONE): string {
  return iphone ? text.replace(/iPadOS/g, 'iOS').replace(/iPad/g, 'iPhone') : text;
}
/** WebKit（Safari の仕組み）で動いている。iPad・iPhone のブラウザはすべて */
export const IS_WEBKIT = detectWebkit(ua, touch);
/** Safari そのもの（Mac・iPad・iPhone）。iPad の Chrome などは含まない */
export const IS_SAFARI = detectSafari(ua, touch, chromeIos);
/** Safari（WebKit）の版。分からなければ null */
export const SAFARI_VERSION: [number, number] | null = IS_WEBKIT ? parseSafariVersion(ua) : null;

/** WebKit の版がこれ以上か。WebKit でなければ true、版が分からなければ null */
export function webkitAtLeast(major: number, minor = 0): boolean | null {
  if (!IS_WEBKIT) return true;
  if (!SAFARI_VERSION) return null;
  const [a, b] = SAFARI_VERSION;
  return a > major || (a === major && b >= minor);
}

/** OGG（Vorbis・Opus）を読めない WebKit か（iPadOS・iOS・macOS の 18.4 より前）。分からなければ false */
export function oggUnsupported(): boolean {
  return webkitAtLeast(18, 4) === false;
}

/** 画面の確認用：ブラウザの名前と版 */
export function browserLabel(): string {
  const v = SAFARI_VERSION ? ` ${SAFARI_VERSION[0]}.${SAFARI_VERSION[1]}` : '';
  if (IS_SAFARI) return `Safari${v}${IS_IOS ? ' (iPadOS/iOS)' : ''}`;
  if (IS_IOS) return `${/CriOS/.test(ua) || chromeIos ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge' : 'Browser'} (WebKit${v})`;
  const c = /(Edg|OPR|Chrome|Firefox)\/(\d+)/.exec(ua);
  if (c) return `${c[1] === 'Edg' ? 'Edge' : c[1] === 'OPR' ? 'Opera' : c[1]} ${c[2]}`;
  return IS_WEBKIT ? `WebKit${v}` : 'Browser';
}
