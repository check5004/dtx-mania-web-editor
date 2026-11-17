// ホームのいちばん下に目立たせずに置く、説明書（README）と GitHub のリンク、プライバシーポリシー・利用規約、いまの版。PC・タブレット・スマホで同じ物を出す。
// README は使う人向けの入口（図と画面写真）で、すべての機能の説明 docs/manual.md へもそこから行ける。README は日本語だけ
// プライバシーポリシー・利用規約は public/privacy.html・public/terms.html（日本語と English の 1 枚ずつ）。Google の OAuth 同意画面に同じ URL を書いていて、
// Google はアプリのホームからリンクしていることを求めるので、ここから外さない（docs/drive.md の「Google Cloud の設定」）
import { getLang, tr } from '../i18n';
import { APP_VERSION } from '../store/pwa';
import { Icon } from './icons';

/** このアプリのリポジトリ */
export const REPO_URL = 'https://github.com/check5004/dtx-mania-web-editor';
/** 説明書（README を GitHub で開く） */
export const MANUAL_URL = `${REPO_URL}/blob/main/README.md`;

/** プライバシーポリシー（今の言語で開く）。part に 'google' を渡すと「Google のデータの扱い」から */
export function privacyUrl(part?: 'google'): string {
  const l = getLang();
  return `${import.meta.env.BASE_URL}privacy.html?lang=${l}${part ? `#${part}-${l}` : ''}`;
}

/** 利用規約（今の言語で開く） */
export function termsUrl(): string {
  return `${import.meta.env.BASE_URL}terms.html?lang=${getLang()}`;
}

export function HomeLinks() {
  return (
    <footer className="home-links">
      <a href={MANUAL_URL} target="_blank" rel="noreferrer" title={tr('説明書（GitHub の README）を開きます', 'Opens the manual (the README on GitHub, in Japanese)')}>
        {Icon.book(15)}
        {tr('説明書', 'Manual (Japanese)')}
      </a>
      <a href={REPO_URL} target="_blank" rel="noreferrer" title={tr('ソースコードと不具合の報告（Issues）', 'Source code and bug reports (Issues)')}>
        {Icon.github(14)}
        GitHub
      </a>
      <a href={privacyUrl()} target="_blank" rel="noreferrer" title={tr('このアプリがデータをどう扱うか（Google Drive につないだときも）', 'How this app handles your data (including when you connect Google Drive)')}>
        {tr('プライバシーポリシー', 'Privacy Policy')}
      </a>
      <a href={termsUrl()} target="_blank" rel="noreferrer">
        {tr('利用規約', 'Terms of Use')}
      </a>
      <span className="home-links-ver" title={tr('いまの版', 'Current version')}>
        v{APP_VERSION}
      </span>
    </footer>
  );
}
