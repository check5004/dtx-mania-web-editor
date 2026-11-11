// ホームのいちばん下に目立たせずに置く、説明書（README）と GitHub のリンク、いまの版。PC・タブレット・スマホで同じ物を出す。
// README は使う人向けの入口（図と画面写真）で、すべての機能の説明 docs/manual.md へもそこから行ける。README は日本語だけ
import { tr } from '../i18n';
import { APP_VERSION } from '../store/pwa';
import { Icon } from './icons';

/** このアプリのリポジトリ */
export const REPO_URL = 'https://github.com/check5004/dtx-mania-web-editor';
/** 説明書（README を GitHub で開く） */
export const MANUAL_URL = `${REPO_URL}/blob/main/README.md`;

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
      <span className="home-links-ver" title={tr('いまの版', 'Current version')}>
        v{APP_VERSION}
      </span>
    </footer>
  );
}
