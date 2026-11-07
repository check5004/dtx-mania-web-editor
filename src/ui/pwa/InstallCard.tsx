// ホームの「アプリとして使う」案内。アプリとして開いていないときだけ出し、閉じたら出さない（設定の「アプリとして使う」にはいつもある）。
// - Chrome・Edge（インストールの案内を出せるとき）: 1行の知らせと「インストール」
// - iPad・iPhone: ホーム画面に追加する手順（Safari のタブだと保存が消えることがあるので、ホーム画面のアプリをすすめる）
import { tr } from '../../i18n';
import { useDevice } from '../../store/device';
import { closeInstallHint, promptInstall, usePwa } from '../../store/pwa';
import { Icon } from '../icons';
import { AddToHomeIcon, installWay, IosSteps } from './installHelp';
import './pwa.css';

/** ホームに案内を出すなら、そのやり方（Chrome・Edge のインストール／iPad のホーム画面に追加）。出さないなら null */
export function useInstallHint(): 'prompt' | 'ios' | null {
  const standalone = usePwa((s) => s.standalone);
  const canInstall = usePwa((s) => s.canInstall);
  const closed = usePwa((s) => s.hintClosed);
  const way = installWay(standalone, canInstall);
  return !closed && (way === 'prompt' || way === 'ios') ? way : null;
}

export function InstallCard() {
  const tablet = useDevice((s) => s.tablet);
  const way = useInstallHint();
  if (!way) return null;

  const closeBtn = (
    <button
      className={tablet ? 't-ib' : 'ib'}
      onClick={closeInstallHint}
      aria-label={tr('閉じる', 'Close')}
      title={tr('閉じる（設定の「アプリとして使う」からいつでも追加できます）', 'Close (you can always install from Settings › Use as an app)')}
    >
      {Icon.close(tablet ? 20 : 14)}
    </button>
  );

  if (way === 'prompt') {
    return (
      <div className={`pwa-hint ${tablet ? 'tablet' : ''}`} role="note">
        <span className="pwa-hint-ic">
          <AddToHomeIcon size={tablet ? 22 : 16} />
        </span>
        <span className="pwa-hint-text">
          <b>{tr('アプリとしてインストールできます', 'Install it as an app')}</b>
          <span>{tr('専用の窓で開き、ネットにつながっていなくても起動できます。', 'It opens in its own window and starts even without an internet connection.')}</span>
        </span>
        <button className={tablet ? 't-btn primary' : 'btn small primary'} onClick={() => void promptInstall()}>
          {tr('インストール', 'Install')}
        </button>
        {closeBtn}
      </div>
    );
  }

  return (
    <section className={`pwa-hint ios ${tablet ? 'tablet' : ''}`} role="note">
      <div className="pwa-hint-head">
        <span className="pwa-hint-ic">
          <AddToHomeIcon size={tablet ? 22 : 16} />
        </span>
        <span className="pwa-hint-text">
          <b>{tr('ホーム画面に追加して使うのがおすすめです', 'Add it to your Home Screen')}</b>
          <span>
            {tr(
              'Safari のバーが消えて譜面が広くなり、ネットにつながっていなくても開けます。Safari のタブより保存した物が消えにくくなります。',
              'The Safari bars go away so the chart gets more room, and it opens without an internet connection. What you save is also less likely to be cleared than in a Safari tab.',
            )}
          </span>
        </span>
        {closeBtn}
      </div>
      <IosSteps />
      <p className="pwa-hint-foot lbl">
        {tr(
          'ホーム画面のアプリは Safari とは別に保存します。Safari で使っていた最近の曲・音源ライブラリ・設定は移らないので、追加したらそちらで使い始めてください。',
          'The Home Screen app keeps its own storage, separate from Safari. Recent songs, the sound library and settings from Safari do not carry over, so start using the app once it is added.',
        )}
      </p>
    </section>
  );
}
