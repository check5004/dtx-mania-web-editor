// アプリとして追加するやり方（ブラウザごと）。ホームの案内（InstallCard）と設定の「アプリとして使う」で使う。
import { tr } from '../../i18n';
import { IS_IOS } from '../../store/device';
import { IS_IPHONE } from '../../platform';

/**
 * - standalone: もうアプリとして開いている
 * - prompt: Chrome・Edge がインストールの案内を出せる（ボタンで出す）
 * - ios: iPad・iPhone（Safari も Chrome も「共有 › ホーム画面に追加」）
 * - mac-safari: Mac の Safari（ファイル › Dock に追加）
 * - chromium: Chrome・Edge だが案内が来ていない（入れてある・条件が揃っていない）→ アドレスバー・メニューから
 * - none: 追加できないブラウザ（Firefox など）
 */
export type InstallWay = 'standalone' | 'prompt' | 'ios' | 'mac-safari' | 'chromium' | 'none';

const UA = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const CHROMIUM = /Chrome\/|Chromium\/|Edg\//.test(UA) && !IS_IOS;
const MAC_SAFARI = !IS_IOS && /Macintosh/.test(UA) && /Safari\//.test(UA) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//.test(UA);

export function installWay(standalone: boolean, canInstall: boolean): InstallWay {
  if (standalone) return 'standalone';
  if (canInstall) return 'prompt';
  if (IS_IOS) return 'ios';
  if (MAC_SAFARI) return 'mac-safari';
  if (CHROMIUM) return 'chromium';
  return 'none';
}

/** iOS の「ホーム画面に追加」のマーク（四角に＋） */
export function AddToHomeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="3" />
      <path d="M8 5.5v5M5.5 8h5" />
    </svg>
  );
}

/** iOS の共有のマーク（四角から上へ矢印） */
export function ShareIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 6.5H4.5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1h-1" />
      <path d="M8 9.5V1.8M5.6 4.2 8 1.8l2.4 2.4" />
    </svg>
  );
}

/** iPad・iPhone で追加する手順 */
export function IosSteps() {
  return (
    <ol className="pwa-steps">
      <li>
        <span className="pwa-step-ic">
          <ShareIcon size={18} />
        </span>
        <span>
          {IS_IPHONE
            ? tr(
                '共有ボタンをタップ（Safari は下のバー、見つからなければ「…」の中。Chrome はアドレスバーの右）',
                'Tap the Share button (in Safari it is in the bottom bar, or inside the "…" menu; in Chrome it is at the right of the address bar)',
              )
            : tr(
                '共有ボタンをタップ（Safari はアドレスバーの右、見つからなければ「…」の中。Chrome もアドレスバーの右）',
                'Tap the Share button (in Safari it is at the right of the address bar, or inside the "…" menu; in Chrome it is at the right of the address bar too)',
              )}
        </span>
      </li>
      <li>
        <span className="pwa-step-ic">
          <AddToHomeIcon size={18} />
        </span>
        <span>{tr('「ホーム画面に追加」を選ぶ', 'Choose "Add to Home Screen"')}</span>
      </li>
      <li>
        <span className="pwa-step-ic pwa-step-n">3</span>
        <span>
          {tr(
            '「Web アプリとして開く」が出たらオンのまま「追加」。ホーム画面の「DTX Editor」から開きます',
            'If "Open as Web App" is shown, leave it on and tap Add. Then open "DTX Editor" from the Home Screen',
          )}
        </span>
      </li>
    </ol>
  );
}

/** Chrome・Edge で、案内が来ていないとき */
export function chromiumHelp(): string {
  return tr(
    'アドレスバーの右端のインストールのボタン（またはブラウザのメニューの「アプリとしてインストール」）から追加できます。もう入れてあれば、アドレスバーの「アプリで開く」から開けます。',
    'Use the install button at the right end of the address bar (or "Install as app" in the browser menu). If it is already installed, use "Open in app" in the address bar.',
  );
}

export function macSafariHelp(): string {
  return tr('メニューバーの「ファイル › Dock に追加…」から追加できます（macOS Sonoma 以降）。', 'Use "File › Add to Dock…" in the menu bar (macOS Sonoma or later).');
}

export function noInstallHelp(): string {
  return tr(
    'このブラウザはアプリとしての追加に対応していません。PC なら Chrome か Edge、iPad なら Safari で追加できます。追加しなくても、このままオフラインで開けます。',
    "This browser can't add web apps. On a PC use Chrome or Edge; on iPad use Safari. Even without installing, the editor still opens offline in this browser.",
  );
}
