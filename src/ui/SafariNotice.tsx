// Safari（と、Safari の仕組みで動くホーム画面のアプリ）で開いたときの、ホームの案内。閉じたら出さない。
// 実機の Safari で確かめられていないので、うまく動かないときの手と、Chrome を勧めることを書く。決まりは docs/safari.md
import { useState } from 'react';
import { engine } from '../audio/engine';
import { tr } from '../i18n';
import { IS_SAFARI, IS_WEBKIT, oggUnsupported } from '../platform';
import { isStandalone } from '../pwa/display';
import { Icon } from './icons';

const KEY = 'dtxe.safariNotice.closed';

function closedBefore(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** 案内を出すか：Safari そのもの、または WebKit のホーム画面のアプリ（iPad の Chrome は Chrome で確かめているので出さない） */
export function shouldShowSafariNotice(): boolean {
  return IS_SAFARI || (IS_WEBKIT && isStandalone());
}

export function SafariNotice() {
  const [show, setShow] = useState(() => shouldShowSafariNotice() && !closedBefore());
  const [played, setPlayed] = useState(false);
  if (!show) return null;
  const close = () => {
    setShow(false);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // 覚えられなくても閉じる
    }
  };
  const app = isStandalone();
  return (
    <div className="notice info safari-notice" role="note">
      <span className="safari-notice-i">{Icon.info(16)}</span>
      <div className="safari-notice-body">
        <b>
          {app
            ? tr('ホーム画面のアプリ（Safari の仕組み）での動作は、まだ実機で確かめていません', "This Home Screen app (which runs on Safari) hasn't been tested on a real device yet")
            : tr('Safari での動作は、まだ実機で確かめていません', "This app hasn't been tested in Safari on a real device yet")}
        </b>
        <span>
          {tr(
            '音が出ないときは、もう一度 ▶ を押すか、下のテスト音で確かめてください（エディタの設定の「音の出力」に詳しい様子が出ます）。それでもうまく動かないときは Chrome をお使いください（Chrome で確かめています）。',
            "If there's no sound, press ▶ again or try the test tone below (Settings › Audio output in the editor shows the details). If it still doesn't work well, please use Chrome (that's where it's tested).",
          )}
          {oggUnsupported() && tr(' この Safari は OGG の音を読めません（18.4 以降で読めます）。', " This version of Safari can't read OGG audio (18.4 or later can).")}
        </span>
        <span className="safari-notice-actions">
          <button
            className="btn small"
            onClick={() => {
              engine.testTone();
              setPlayed(true);
            }}
          >
            {tr('テスト音を鳴らす', 'Play test tone')}
          </button>
          {played && <span className="lbl">{tr('「ピッポッ」と聞こえなければ、音量と消音（コントロールセンターのベル）を確かめてください。', 'If you hear no "beep-boop", check the volume and Silent Mode (the bell in Control Center).')}</span>}
        </span>
      </div>
      <button className="ib safari-notice-x" onClick={close} aria-label={tr('閉じる', 'Close')} title={tr('閉じる（次からは出しません）', "Close (won't show again)")}>
        {Icon.close(16)}
      </button>
    </div>
  );
}
