// フレーズ候補のパネル（譜面の右下に重ねる）。候補は譜面に点線で出し、適用するまで譜面は変わらない。
import { useEffect } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { setView, useEditor } from '../store/editor';
import { tempoOf } from '../store/derived';
import { applyCandidate, closePhrase, makeCandidates, setPhraseRange, stepCandidate, usePhrase } from '../store/phrase';
import { Icon } from './icons';
import { openSettings } from '../store/editor';

export function PhrasePanel() {
  const p = usePhrase();
  const doc = useEditor((s) => s.doc);
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.phrase.model, s.models));
  const cost = useAi(() => taskCostEstimate('phrase'));
  const cand = p.cands[p.index] ?? null;
  const stale = p.cands.length > 0 && p.madeFor !== doc;

  // 範囲が見えるようにする
  useEffect(() => {
    const s = useEditor.getState();
    const t = tempoOf(s.doc);
    const b = t.measureStart(p.from);
    const px = s.view.pxPerBeat;
    if (b < s.view.scrollBeat || b > s.view.scrollBeat + 600 / px) setView({ scrollBeat: Math.max(-1, b - 80 / px), follow: false });
  }, [p.from]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-back')) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePhrase();
      } else if (usePhrase.getState().cands.length && (e.key === 'Tab' || e.key === ',' || e.key === '.')) {
        e.preventDefault();
        e.stopPropagation();
        stepCandidate(e.key === ',' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
      } else if (usePhrase.getState().cands.length && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        applyCandidate();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  return (
    <div className="find-panel phrase-panel">
      <div className="row" style={{ gap: 8 }}>
        <span className="ai-spark">{Icon.sparkle(14)}</span>
        <b>フレーズ候補</b>
        <span className="grow" />
        <button className="ib tiny" onClick={closePhrase} title="閉じる（Esc）">
          {Icon.close(14)}
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <span className="lbl">範囲</span>
        <MeasureInput value={p.from} onChange={(v) => setPhraseRange(v, Math.max(v, p.to))} />
        <span className="lbl">〜</span>
        <MeasureInput value={p.to} onChange={(v) => setPhraseRange(p.from, v)} />
        <span className="lbl">（{p.to - p.from + 1}小節・4小節まで）</span>
      </div>
      <input
        className="field"
        style={{ marginTop: 8 }}
        placeholder={hasKey ? 'ひとこと（例: 着地はクラッシュ、タムは高い順に）' : 'ひとことはキーを設定すると使えます'}
        value={p.instruction}
        disabled={!hasKey}
        onChange={(e) => usePhrase.setState({ instruction: e.target.value })}
      />
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className={`btn small grow ${p.kind === 'fill' && p.cands.length ? 'on' : ''}`} onClick={() => void makeCandidates('fill')} disabled={p.loading}>
          フィルの候補
        </button>
        <button className={`btn small grow ${p.kind === 'rhythm' && p.cands.length ? 'on' : ''}`} onClick={() => void makeCandidates('rhythm')} disabled={p.loading}>
          リズムの候補
        </button>
      </div>
      <div className="lbl" style={{ marginTop: 6 }}>
        {hasKey ? (
          <>
            {model} · 1回 約 {formatUsd(cost)}
          </>
        ) : (
          <>
            <span title={noKeyTitle()}>キーが無いので「似た小節からコピー」と「直前小節の複製」だけ出します。</span>{' '}
            <button className="link-btn" onClick={() => openSettings('ai')}>
              キーを設定
            </button>
          </>
        )}
      </div>
      {p.loading && <div className="lbl" style={{ marginTop: 8 }}>候補を作っています…</div>}
      {p.error && <div className="ai-err">{p.error}</div>}
      {p.cands.length > 0 && (
        <div className="phrase-list">
          {p.cands.map((c, i) => (
            <button key={i} className={`phrase-cand ${i === p.index ? 'on' : ''}`} onClick={() => usePhrase.setState({ index: i })}>
              <div className="row" style={{ gap: 6 }}>
                <span className="mono lbl">{i + 1}</span>
                <b className="ellipsis">{c.name}</b>
                <span className="grow" />
                <span className="lbl">{c.notes.length}打</span>
                {c.source !== 'ai' && <span className="ai-tag">{c.source === 'prev' ? '複製' : 'コピー'}</span>}
              </div>
              {c.reason && <div className="lbl">{c.reason}</div>}
            </button>
          ))}
          {stale && <div className="lbl" style={{ color: 'var(--amber)' }}>候補を作ったあとに譜面が変わりました。</div>}
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <button className="btn small ghost" onClick={() => stepCandidate(-1)} title="前の候補（,）">
              ‹
            </button>
            <button className="btn small ghost" onClick={() => stepCandidate(1)} title="次の候補（. か Tab）">
              ›
            </button>
            <span className="grow" />
            {p.cost !== null && <span className="lbl mono">{formatUsd(p.cost)}</span>}
            <button className="btn small primary" onClick={applyCandidate} disabled={!cand} title="範囲のドラムを候補で置き換えます（Enter、Ctrl+Z で戻せます）">
              適用
            </button>
          </div>
        </div>
      )}
      <p className="lbl" style={{ margin: '8px 0 0' }}>
        小節 {toMeasure(p.from)}{p.to !== p.from ? `〜${toMeasure(p.to)}` : ''} の候補を点線で出します。適用するまで譜面は変わりません。
      </p>
    </div>
  );
}

function MeasureInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      className="field mono"
      style={{ width: 64 }}
      type="number"
      min={0}
      value={value}
      onChange={(e) => {
        const v = Math.max(0, Math.trunc(Number(e.target.value)));
        if (Number.isFinite(v)) onChange(v);
      }}
    />
  );
}
