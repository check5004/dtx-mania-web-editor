// TAB補完の札：点線のすぐ上に出す（Tab で入れる・1小節だけ・前後の候補・AIに聞く・消す）。
import type { CSSProperties, PointerEvent } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { NO_KEY_TITLE, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { useAssist } from '../store/assist';
import { acceptGhost, askAi, dismissGhost, ghostBadge, sourceLabel, stepGhost, useComplete } from '../store/complete';
import { useEditor } from '../store/editor';
import { usePhrase } from '../store/phrase';
import { useVel } from '../store/velocity';
import { Icon } from './icons';

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

const SOURCE_TIP: Record<string, string> = {
  context: '直前の数小節と同じ並びの所を前から探して、そのときの続きを写しています。',
  structure: '原曲でこの先と同じに聞こえる、もう打ってある小節を写しています（2番のサビ＝1番のサビ など）。',
};

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
  const range = len === 1 ? toMeasure(b.at) : `${toMeasure(b.at)}〜${toMeasure(b.at + len - 1)}`;
  const aiTitle = hasKey ? `この先の続きをAIに3つ作ってもらいます（${model}・1回 約 ${formatUsd(cost)}）。設定 › AI の「フレーズ候補」のモデルを使います` : NO_KEY_TITLE;
  const stop = (e: PointerEvent) => e.stopPropagation();
  const aiButton = (
    <button className="tg-ai" onClick={() => void askAi()} disabled={!hasKey || c.aiLoading} title={aiTitle}>
      {Icon.sparkle(12)} {c.aiLoading ? '考え中…' : 'AIに聞く'}
    </button>
  );
  const close = (
    <button className="tg-x" onClick={() => dismissGhost()} title="消す（Esc）。次にチップを置くまで出しません" aria-label="TAB補完を消す">
      {Icon.close(12)}
    </button>
  );

  if (!g) {
    return (
      <div className="tab-ghost empty" style={style} onPointerDown={stop}>
        <div className="tg-row">
          <span className="tg-msg">
            {arrow}小節 <span className="mono">{toMeasure(b.at)}</span> から先：
            {c.aiLoading ? 'AIが続きを考えています…' : c.aiError ? <span className="tg-err">AI: {c.aiError}</span> : '続きの候補が見つかりません'}
          </span>
          {!c.aiLoading && aiButton}
          {close}
        </div>
      </div>
    );
  }

  const cand = g.cand;
  const pct = Number.isFinite(cand.score) ? Math.round(cand.score * 100) : null;
  const srcTip = cand.kind === 'ai' ? (cand.reason ?? '') : SOURCE_TIP[cand.kind];
  const scoreTip = pct !== null ? `\n見込み：次の小節がこのまま正解になる確からしさ（精度テストの結果から）。` : '';
  return (
    <div className="tab-ghost" style={style} onPointerDown={stop}>
      <div className="tg-row">
        <button className="tg-accept" onClick={() => acceptGhost()} title="点線の小節をまとめて入れます（Tab）。Ctrl+Z で戻せます">
          <kbd>Tab</kbd>
          {arrow}小節 <span className="mono">{range}</span> を入れる
        </button>
        {len > 1 && (
          <button onClick={() => acceptGhost(1)} title="最初の1小節だけ入れます（Shift+Tab）">
            1小節だけ
          </button>
        )}
        {g.count > 1 && (
          <span className="tg-step">
            <button onClick={() => stepGhost(-1)} title="前の候補（Alt+[）" aria-label="前の候補">
              ‹
            </button>
            <span className="mono">
              {g.index + 1}/{g.count}
            </span>
            <button onClick={() => stepGhost(1)} title="次の候補（Alt+]）" aria-label="次の候補">
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
              {' · 見込み '}
              <b className="mono">{pct}%</b>
            </>
          )}
        </span>
        {g.doubt.size > 0 && (
          <span className="tg-doubt" title="オレンジの枠のチップは、原曲でその音（バスドラム・スネア・タム）が聞こえません。外れのことが多い所なので、入れたあと聴いて確かめてください">
            {' · '}要確認 {g.doubt.size}
          </span>
        )}
        {c.aiError && (
          <span className="tg-err" title={c.aiError}>
            {' · '}AIは失敗しました
          </span>
        )}
      </div>
    </div>
  );
}
