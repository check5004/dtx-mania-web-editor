// TAB補完の札：点線のすぐ上に出す（Tab で入れる・1小節だけ・前後の候補・AIに聞く・消す）。
import { tr } from '../i18n';
import type { CSSProperties, PointerEvent } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { useAssist } from '../store/assist';
import { acceptGhost, askAi, dismissGhost, ghostBadge, sourceLabel, stepGhost, useComplete } from '../store/complete';
import { useEditor } from '../store/editor';
import { usePhrase } from '../store/phrase';
import { useVel } from '../store/velocity';
import { Icon } from './icons';
import { AiButton } from './aiGuide/KeyGate';

export interface GhostAnchor {
  /** 点線を出すレーンの左端 */
  left: number;
  /** 点線の範囲の上端・下端（画面の y） */
  top: number;
  bottom: number;
  /** 譜面が見えている範囲（y） */
  minY: number;
  maxY: number;
  /** 譜面の枠の大きさ */
  w: number;
  h: number;
}

const sourceTip = (k: string): string | undefined =>
  ({
    context: tr(
      '直前の数小節と同じ並びの所を前から探して、そのときの続きを写しています。',
      'Finds an earlier place with the same pattern as the last few measures and copies what came next there.',
    ),
    structure: tr(
      '原曲でこの先と同じに聞こえる、もう打ってある小節を写しています（2番のサビ＝1番のサビ など）。',
      'Copies already-charted measures that sound the same as what comes next in the original (e.g. 2nd chorus = 1st chorus).',
    ),
  })[k];

export function CompleteBadge({ anchor, sized }: { anchor: (from: number, len: number) => GhostAnchor; sized: number }) {
  const c = useComplete();
  // 位置と出す・出さないが変わるもの
  useEditor((s) => s.doc);
  useEditor((s) => s.view.scrollBeat);
  useEditor((s) => s.view.pxPerBeat);
  useEditor((s) => s.playing);
  useEditor((s) => s.page);
  usePhrase((s) => s.open);
  useVel((s) => s.mode);
  useAssist((s) => s.data);
  const inputMode = useAssist((s) => s.inputMode);
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.phrase.model, s.models));
  const cost = useAi(() => taskCostEstimate('phrase'));
  void sized;
  const b = ghostBadge();
  if (!b) return null;
  const g = b.ghost;
  const len = g ? g.measures.length : 1;
  const a = anchor(b.at, len);
  const style: CSSProperties = { left: Math.max(8, a.left), maxWidth: Math.max(260, a.w - Math.max(8, a.left) - 8) };
  // 上に寄せるときは、キー入力・録音の札の下に
  const topY = a.minY + 4 + (inputMode === 'mouse' ? 0 : 34);
  // 点線の半分以上が画面の外なら、矢印で向きを示す
  const shown = Math.max(0, Math.min(a.bottom, a.maxY) - Math.max(a.top, a.minY));
  const hidden = shown < (a.bottom - a.top) * 0.5;
  let arrow = '';
  if (hidden && a.bottom > a.maxY) {
    style.bottom = a.h - a.maxY + 6;
    arrow = '↓ ';
  } else if (a.top - 6 - 50 < topY) {
    style.top = topY;
    if (hidden) arrow = '↑ ';
  } else {
    style.bottom = a.h - (a.top - 6);
  }
  const range = len === 1 ? toMeasure(b.at) : `${toMeasure(b.at)}${tr('〜', '–')}${toMeasure(b.at + len - 1)}`;
  // キーが無いときは AiButton が「キーが要ります」の説明に替える
  const aiTitle = hasKey
    ? tr(
        `この先の続きをAIに3つ作ってもらいます（${model}・1回 約 ${formatUsd(cost)}）。設定 › AI の「フレーズ候補」のモデルを使います`,
        `Ask the AI for 3 ways to continue from here (${model}, about ${formatUsd(cost)} per run). Uses the "Phrase ideas" model in Settings › AI`,
      )
    : undefined;
  const stop = (e: PointerEvent) => e.stopPropagation();
  const aiButton = (
    <AiButton feature="tabAsk" className="tg-ai" onClick={() => void askAi()} disabled={c.aiLoading} title={aiTitle} keySize={10}>
      {Icon.sparkle(12)} {c.aiLoading ? tr('考え中…', 'Thinking…') : tr('AIに聞く', 'Ask AI')}
    </AiButton>
  );
  const close = (
    <button
      className="tg-x"
      onClick={() => dismissGhost()}
      title={tr('消す（Esc）。次にチップを置くまで出しません', "Dismiss (Esc). It won't come back until you place another chip")}
      aria-label={tr('TAB補完を消す', 'Dismiss Tab completion')}
    >
      {Icon.close(12)}
    </button>
  );

  if (!g) {
    return (
      <div className="tab-ghost empty" style={style} onPointerDown={stop}>
        <div className="tg-row">
          <span className="tg-msg">
            {arrow}
            {tr('小節', 'From measure')} <span className="mono">{toMeasure(b.at)}</span> {tr('から先：', 'on: ')}
            {c.aiLoading ? (
              tr('AIが続きを考えています…', 'The AI is working on a continuation…')
            ) : c.aiError ? (
              <span className="tg-err">AI: {c.aiError}</span>
            ) : (
              tr('続きの候補が見つかりません', 'No continuation found')
            )}
          </span>
          {!c.aiLoading && aiButton}
          {close}
        </div>
      </div>
    );
  }

  const cand = g.cand;
  const pct = Number.isFinite(cand.score) ? Math.round(cand.score * 100) : null;
  const srcTip = cand.kind === 'ai' ? (cand.reason ?? '') : (sourceTip(cand.kind) ?? '');
  const scoreTip =
    pct !== null
      ? tr('\n見込み：次の小節がこのまま正解になる確からしさ（精度テストの結果から）。', '\nLikelihood: how likely the next measure is right as is (from the accuracy tests).')
      : '';
  return (
    <div className="tab-ghost" style={style} onPointerDown={stop}>
      <div className="tg-row">
        <button className="tg-accept" onClick={() => acceptGhost()} title={tr('点線の小節をまとめて入れます（Tab）。Ctrl+Z で戻せます', 'Insert the dashed measures (Tab). Undo with Ctrl+Z')}>
          <kbd>Tab</kbd>
          {arrow}
          {tr('小節', 'Insert measure')} <span className="mono">{range}</span>
          {tr(' を入れる', '')}
        </button>
        {len > 1 && (
          <button onClick={() => acceptGhost(1)} title={tr('最初の1小節だけ入れます（Shift+Tab）', 'Insert only the first measure (Shift+Tab)')}>
            {tr('1小節だけ', 'Just one')}
          </button>
        )}
        {g.count > 1 && (
          <span className="tg-step">
            <button onClick={() => stepGhost(-1)} title={tr('前の候補（Alt+[）', 'Previous idea (Alt+[)')} aria-label={tr('前の候補', 'Previous idea')}>
              ‹
            </button>
            <span className="mono">
              {g.index + 1}/{g.count}
            </span>
            <button onClick={() => stepGhost(1)} title={tr('次の候補（Alt+]）', 'Next idea (Alt+])')} aria-label={tr('次の候補', 'Next idea')}>
              ›
            </button>
          </span>
        )}
        {aiButton}
        {close}
      </div>
      <div className="tg-info">
        <span title={srcTip + scoreTip}>
          {sourceLabel(cand)}
          {pct !== null && (
            <>
              {tr(' · 見込み ', ' · Likelihood ')}
              <b className="mono">{pct}%</b>
            </>
          )}
        </span>
        {g.doubt.size > 0 && (
          <span
            className="tg-doubt"
            title={tr(
              'オレンジの枠のチップは、原曲でその音（バスドラム・スネア・タム）が聞こえません。外れのことが多い所なので、入れたあと聴いて確かめてください',
              "Chips with an orange frame aren't heard in the original (kick, snare, toms). These are often wrong, so listen after inserting",
            )}
          >
            {' · '}
            {tr('要確認', 'Check')} {g.doubt.size}
          </span>
        )}
        {c.aiError && (
          <span className="tg-err" title={c.aiError}>
            {' · '}
            {tr('AIは失敗しました', 'The AI failed')}
          </span>
        )}
      </div>
    </div>
  );
}
