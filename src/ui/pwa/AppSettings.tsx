// 設定 › アプリ：アプリとして追加する（ホーム画面・インストール）、オフラインで開けるか、版と更新。
import { useState } from 'react';
import { locale, tr } from '../../i18n';
import { IS_IOS } from '../../store/device';
import { APP_VERSION, applyUpdate, BUILD_TIME, checkForUpdate, promptInstall, usePwa } from '../../store/pwa';
import { Icon } from '../icons';
import { chromiumHelp, installWay, IosSteps, macSafariHelp, noInstallHelp } from './installHelp';
import './pwa.css';

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

export function AppSettings() {
  return (
    <div className="settings-col pwa-set">
      <h2>{tr('アプリとして使う', 'Use as an app')}</h2>
      <InstallCardSection />
      <OfflineSection />
      <VersionSection />
    </div>
  );
}

function InstallCardSection() {
  const standalone = usePwa((s) => s.standalone);
  const canInstall = usePwa((s) => s.canInstall);
  const way = installWay(standalone, canInstall);
  return (
    <section className="card pwa-card">
      <div className="row" style={{ gap: 10 }}>
        <h3>{IS_IOS ? tr('ホーム画面に追加', 'Add to Home Screen') : tr('インストール', 'Install')}</h3>
        {way === 'standalone' && <span className="pill ok">{tr('● アプリとして開いています', '● Running as an app')}</span>}
      </div>
      {way === 'standalone' && (
        <p className="lbl">
          {IS_IOS
            ? tr(
                'ホーム画面のアプリで開いています。Safari のバーが無いぶん譜面が広く、ネットにつながっていなくても開けます。',
                'You opened it from the Home Screen. Without the Safari bars the chart has more room, and it opens without an internet connection.',
              )
            : tr('アプリの窓で開いています。ネットにつながっていなくても開けます。', 'You opened it in its own app window. It opens without an internet connection too.')}
        </p>
      )}
      {way === 'prompt' && (
        <>
          <p className="lbl">
            {tr(
              '専用の窓で開き、ネットにつながっていなくても起動できます。アプリの一覧やデスクトップ・タスクバーから開けます。',
              'It opens in its own window and starts without an internet connection. Open it from your apps, the desktop or the taskbar.',
            )}
          </p>
          <div>
            <button className="btn primary" onClick={() => void promptInstall()}>
              {tr('アプリとしてインストール', 'Install as an app')}
            </button>
          </div>
        </>
      )}
      {way === 'ios' && (
        <>
          <p className="lbl">
            {tr(
              'Safari のバーが消えて譜面が広くなり、ネットにつながっていなくても開けます。Safari のタブでは、Safari を7日使う間に一度も開かないと保存した物が消されることがありますが、ホーム画面のアプリは対象外です。',
              'The Safari bars go away so the chart gets more room, and it opens without an internet connection. In a Safari tab, saved data may be cleared if you use Safari for 7 days without opening this site; Home Screen apps are exempt.',
            )}
          </p>
          <IosSteps />
        </>
      )}
      {way === 'mac-safari' && <p className="lbl">{macSafariHelp()}</p>}
      {way === 'chromium' && <p className="lbl">{chromiumHelp()}</p>}
      {way === 'none' && <p className="lbl">{noInstallHelp()}</p>}
      {(IS_IOS || way === 'standalone') && (
        <p className="pwa-note">
          {Icon.info(14)}
          <span>
            {IS_IOS
              ? tr(
                  'ホーム画面のアプリと Safari は保存が別です（最近の曲・iPad 本体に保存した曲と音・音源ライブラリ・設定・AI のキー）。Safari で使っていた分は移らないので、どちらか一方で使ってください。',
                  'The Home Screen app and Safari keep separate storage (recent songs, songs kept on the iPad with their audio, the sound library, settings, the AI key). Nothing carries over from Safari, so stick to one of them.',
                )
              : tr(
                  'アプリの窓とブラウザのタブは、同じ保存（最近の曲・ブラウザ内に保存した曲・音源ライブラリ・設定）を使います。',
                  'The app window and browser tabs share the same storage (recent songs, songs kept in the browser, the sound library, settings).',
                )}
          </span>
        </p>
      )}
    </section>
  );
}

function OfflineSection() {
  const sw = usePwa((s) => s.sw);
  const bytes = usePwa((s) => s.offlineBytes);
  const pill =
    sw === 'ready' ? (
      <span className="pill ok">{tr('● 使えます', '● Ready')}</span>
    ) : sw === 'installing' ? (
      <span className="pill">{tr('準備しています…', 'Preparing…')}</span>
    ) : sw === 'dev' ? (
      <span className="pill">{tr('開発サーバーでは使いません', 'Off on the dev server')}</span>
    ) : (
      <span className="pill warn">{tr('このブラウザでは使えません', 'Not available in this browser')}</span>
    );
  return (
    <section className="card pwa-card">
      <div className="row" style={{ gap: 10 }}>
        <h3>{tr('オフラインで開く', 'Open offline')}</h3>
        {pill}
      </div>
      <p className="lbl">
        {sw === 'ready' && bytes > 0
          ? tr(
              `エディタの画面・内蔵キットの音（${mb(bytes)} MB）をこの端末に入れてあり、ネットにつながっていなくても開けます。`,
              `The editor and the built-in kit sounds (${mb(bytes)} MB) are stored on this device, so it opens without an internet connection.`,
            )
          : tr(
              'エディタの画面と内蔵キットの音をこの端末に入れて、ネットにつながっていなくても開けるようにします。',
              'The editor and the built-in kit sounds are stored on this device so that it opens without an internet connection.',
            )}
      </p>
      <ul className="pwa-list lbl">
        <li>
          {tr(
            'ネットが要る物：AI（OpenRouter）、曲情報の検索、YouTube の参照映像、Google Fonts の文字（無ければ端末の文字で表示）。',
            'Needs the internet: AI (OpenRouter), song info lookup, YouTube reference videos, and Google Fonts (the device font is used without it).',
          )}
        </li>
        <li>
          {tr(
            '採譜・ステム分解は、一度使うとエンジンとモデルがこの端末に残り、次からはオフラインでも動きます。',
            'Transcription and stem separation keep their engine and model on this device after the first use, so they also work offline afterwards.',
          )}
        </li>
      </ul>
    </section>
  );
}

function VersionSection() {
  const update = usePwa((s) => s.update);
  const checking = usePwa((s) => s.checking);
  const result = usePwa((s) => s.checkResult);
  const sw = usePwa((s) => s.sw);
  const [asked, setAsked] = useState(false);
  const built = BUILD_TIME ? new Date(BUILD_TIME).toLocaleString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const msg =
    !asked || checking
      ? null
      : result === 'latest'
        ? tr('いまの版が最新です。', 'You have the latest version.')
        : result === 'offline'
          ? tr('つながりませんでした。ネットにつながったら確かめ直します。', "Couldn't connect. It will check again when you are online.")
          : null;
  return (
    <section className="card pwa-card">
      <div className="row" style={{ gap: 10 }}>
        <h3>{tr('版と更新', 'Version and updates')}</h3>
        <span className="pill mono">v{APP_VERSION}</span>
        {built && <span className="lbl">{tr(`${built} に作った版`, `built ${built}`)}</span>}
      </div>
      {update ? (
        <div className="pwa-update-row">
          <span>{tr(`新しい版（v${update.version}）を入れました。読み込み直すと使えます。`, `The new version (v${update.version}) is ready. Reload to use it.`)}</span>
          <button className="btn primary" onClick={() => void applyUpdate()}>
            {tr('読み込み直す', 'Reload')}
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 10 }}>
          <button
            className="btn"
            disabled={checking || sw === 'dev' || sw === 'unsupported' || sw === 'error'}
            onClick={() => {
              setAsked(true);
              void checkForUpdate();
            }}
          >
            {checking ? tr('確かめています…', 'Checking…') : tr('新しい版を確かめる', 'Check for updates')}
          </button>
          {msg && <span className="lbl">{msg}</span>}
        </div>
      )}
      <p className="lbl">
        {tr(
          'ネットにつながっていれば、開くたびに最新の版になります。開いたままのときは 30 分ごとと画面に戻ったときに確かめ、新しい版があれば知らせます（読み込み直すかは選べます）。',
          'When online, it opens the latest version every time. While it stays open, it checks every 30 minutes and when you come back to it, and lets you know when a new version is ready (you choose when to reload).',
        )}
      </p>
    </section>
  );
}
