// スマホの縦で、横向きでだけ使う画面（テンポと開始位置・難易度ガイドライン）を開いたとき。
// 横にするとそのまま本当の画面に替わる（Editor が向きを見て出し分ける）
import { tr } from '../../i18n';
import { goBack } from '../../store/editor';
import { Icon } from '../icons';

export function LandscapeOnly({ title, why }: { title: string; why: string }) {
  return (
    <div className="p-rotate">
      <header className="p-rotate-top">
        <button className="p-btn sm" onClick={goBack}>
          {Icon.back(16)}
          <span>{tr('戻る', 'Back')}</span>
        </button>
        <b className="ellipsis">{title}</b>
      </header>
      <div className="p-rotate-body">
        <span className="p-rotate-icon" aria-hidden="true">
          <i />
        </span>
        <h2>{tr('横向きにすると開きます', 'Turn your phone sideways to open this')}</h2>
        <p>{why}</p>
        <button className="p-btn" onClick={goBack}>
          {tr('エディタに戻る', 'Back to the editor')}
        </button>
      </div>
    </div>
  );
}
