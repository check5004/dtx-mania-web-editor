// 新しい版が出たときの知らせ（知らせの並びの一番上。閉じるまで出したまま）。読み込み直すと新しい版になる
import { tr } from '../../i18n';
import { applyUpdate, dismissUpdate, usePwa } from '../../store/pwa';
import { Icon } from '../icons';
import './pwa.css';

export function UpdateNotice() {
  const update = usePwa((s) => s.update);
  const dismissed = usePwa((s) => s.updateDismissed);
  if (!update || dismissed) return null;
  return (
    <div className="toast has-action pwa-update" role="status">
      <span>{tr(`新しい版（v${update.version}）があります`, `A new version (v${update.version}) is available`)}</span>
      <button className="toast-action" onClick={() => void applyUpdate()}>
        {tr('読み込み直す', 'Reload')}
      </button>
      <button
        className="pwa-update-x"
        onClick={dismissUpdate}
        aria-label={tr('閉じる', 'Close')}
        title={tr('閉じる（設定の「アプリとして使う」からも読み込み直せます）', 'Close (you can also reload from Settings › Use as an app)')}
      >
        {Icon.close(14)}
      </button>
    </div>
  );
}
