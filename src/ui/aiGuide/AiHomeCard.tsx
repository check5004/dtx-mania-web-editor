// ホームの「AI（OpenRouter）」の札。キーが無ければ AI を使う準備（案内）へ、あればつながり具合と今月の額を出す。
// Google Drive の札（DriveUi.tsx の DriveHomeCard）と同じ形。
import { tr } from '../../i18n';
import { useEffect } from 'react';
import { formatUsd } from '../../ai/tasks';
import { checkKey, useAi } from '../../store/ai';
import { openAiGuide } from '../../store/aiGuide';
import { Icon } from '../icons';
import './aiGuide.css';

/** 入っているキーをこのタブで確かめたか（ホームを開くたびには聞かない） */
let checked = false;

export function AiHomeCard({ tablet = false }: { tablet?: boolean }) {
  const hasKey = useAi((s) => s.key.trim().length > 0);
  const status = useAi((s) => s.keyStatus);
  const info = useAi((s) => s.keyInfo);
  const month = useAi((s) => s.spend.monthTotal);
  const cap = useAi((s) => s.monthlyCap);
  // 入っているキーは、このタブで一度だけ確かめる（料金はかからない）
  useEffect(() => {
    if (checked || !useAi.getState().key) return;
    checked = true;
    if (useAi.getState().keyStatus !== 'ok') void checkKey();
  }, []);
  const btn = tablet ? 't-btn' : 'btn small';
  const state = !hasKey
    ? tr('キーが入っていません', 'No key yet')
    : status === 'ok'
      ? tr('● つながっています', '● Connected')
      : status === 'error'
        ? tr('つながりません', "Can't connect")
        : tr('確かめています…', 'Checking…');
  return (
    <section className={`local-card ai-home-card ${tablet ? 't' : ''}`} aria-label={tr('AI（OpenRouter）', 'AI (OpenRouter)')}>
      <div className="local-head">
        <span className="local-i ai-home-i">{Icon.sparkle(tablet ? 22 : 18)}</span>
        <span className="local-title">
          <b>{tr('AI（OpenRouter）', 'AI (OpenRouter)')}</b>
          <span className={`lbl ellipsis ${hasKey && status === 'ok' ? 'ai-home-ok' : hasKey && status === 'error' ? 'ai-home-err' : ''}`}>{state}</span>
        </span>
        {hasKey && (
          <button className={`${btn} ghost`} onClick={() => openAiGuide(status === 'error' ? 'paste' : 'care')}>
            {status === 'error' ? tr('キーを入れ直す', 'Re-enter key') : tr('はじめかた・注意点', 'Guide and tips')}
          </button>
        )}
      </div>
      <p className="lbl local-body">
        {!hasKey
          ? tr(
              '小節の AI 案・TAB補完の「AIに聞く」・レベル判定・曲情報の Web 検索などの AI の機能は、OpenRouter のキーを入れると使えます。ほかの機能は、キーが無くてもすべて使えます。',
              "AI features such as AI measure ideas, Ask AI in Tab completion, level rating and web song lookup work once you add an OpenRouter key. Everything else works without a key.",
            )
          : status === 'error'
            ? tr('キーが違うか、消したキーかもしれません。「キーを入れ直す」から確かめてください。', 'The key may be wrong or deleted. Check it with “Re-enter key”.')
            : tr(
                `AI の機能が使えます。今月このアプリで使った額 ${formatUsd(month)}（上限 ${formatUsd(cap)}）${info && info.limit !== null ? `・このキーの残り上限 ${formatUsd(info.limitRemaining)}` : ''}。`,
                `AI features are ready. Spent in this app this month: ${formatUsd(month)} (cap ${formatUsd(cap)})${info && info.limit !== null ? `, key limit left ${formatUsd(info.limitRemaining)}` : ''}.`,
              )}
      </p>
      {!hasKey && (
        <div className="local-row">
          <span className="grow" />
          <button className={`${btn} ghost`} onClick={() => openAiGuide('paste')}>
            {tr('キーを持っている', 'I have a key')}
          </button>
          <button className={`${btn} primary`} onClick={() => openAiGuide('about')}>
            {Icon.sparkle(tablet ? 18 : 14)}
            {tr('AI を使う準備（約 5 分）', 'Set up AI (about 5 min)')}
          </button>
        </div>
      )}
    </section>
  );
}
