// 小節の生成の札：生成している小節のすぐ上に出す（案の切り替え・入れ方・レーンごと・入れる・やめる）。
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { DRUM_LANES } from '../dtx/model';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { useAssist } from '../store/assist';
import { drumsAudible, useDrums } from '../store/drums';
import { openSettings, useEditor } from '../store/editor';
import {
  applyMeasureGen,
  closeMeasureGen,
  genView,
  rangeHasChips,
  regenMeasureAi,
  resetGenMarks,
  selectMeasureGen,
  setGenMode,
  stepMeasureGen,
  toggleGenLane,
  useMeasureGen,
  type GenCandidate,
} from '../store/measureGen';
import type { GhostAnchor } from './CompleteBadge';
import { Icon } from './icons';

/** Alt+] ・Alt+[ の向き（Mac の Option では文字が変わるので、キーの位置でも見る） */
function bracketDir(e: KeyboardEvent): 1 | -1 | 0 {
  if (e.code === 'BracketRight' || e.key === ']') return 1;
  if (e.code === 'BracketLeft' || e.key === '[') return -1;
  return 0;
}

function tabLabel(c: GenCandidate, cands: readonly GenCandidate[]): string {
  if (c.source === 'ai') return `AI ${cands.filter((x) => x.source === 'ai').indexOf(c) + 1}`;
  if (c.source === 'draft') return '採譜';
  return `写す ${c.src !== undefined ? toMeasure(c.src) : ''}`;
}

const SOURCE_TIP: Record<GenCandidate['source'], string> = {
  ai: 'AI が、原曲の打点と前後の小節（作者の書き方）から作った案',
  draft: 'ドラムの採譜モデルが原曲から聞き取った打点を、そのままチップにした案。レーン（ライドかシンバルか、HHの開け閉め、タムの高さ）は前後の小節の書き方に合わせて選んでいます',
  copy: 'この曲でもう打った小節を写した案（TAB補完と同じ選び方）',
};

export function GenBadge({ anchor, sized }: { anchor: (from: number, len: number) => GhostAnchor; sized: number }) {
  const gs = useMeasureGen();
  // 位置と中身が変わるもの
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.view.scrollBeat);
  useEditor((s) => s.view.pxPerBeat);
  const playing = useEditor((s) => s.playing);
  // 採譜が終わったら「ドラム抜きの BGM か」が分かる
  useDrums((d) => d.status);
  const drumless = drumsAudible() === false;
  const inputMode = useAssist((s) => s.inputMode);
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.measure.model, s.models));
  const cost = useAi(() => taskCostEstimate('measure'));
  const [note, setNote] = useState<string | null>(null);
  /** 札の高さ（生成している小節に重ならない置き場所を選ぶため） */
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState(100);
  useLayoutEffect(() => {
    const h = boxRef.current?.offsetHeight;
    if (h && Math.abs(h - boxH) > 1) setBoxH(h);
  });
  void sized;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!useMeasureGen.getState().open) return;
      if (document.querySelector('.modal-back')) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      let done = true;
      if (e.key === 'Escape') closeMeasureGen();
      else if (e.key === 'Enter' && !mod) applyMeasureGen({ next: e.shiftKey });
      else if (e.key === 'Tab' && !mod && !e.altKey) stepMeasureGen(e.shiftKey ? -1 : 1);
      else if (e.altKey && !mod && bracketDir(e) !== 0) stepMeasureGen(bracketDir(e) as 1 | -1);
      else done = false;
      if (done) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  useEffect(() => {
    if (!gs.open) setNote(null);
  }, [gs.open]);

  if (!gs.open) return null;
  const v = genView(doc);
  const len = gs.to - gs.from + 1;
  const a = anchor(gs.from, len);
  const style: CSSProperties = { left: Math.max(8, a.left), maxWidth: Math.max(300, a.w - Math.max(8, a.left) - 8) };
  const topY = a.minY + 4 + (inputMode === 'mouse' ? 0 : 34);
  const shown = Math.max(0, Math.min(a.bottom, a.maxY) - Math.max(a.top, a.minY));
  const hidden = shown < (a.bottom - a.top) * 0.5;
  let arrow = '';
  if (playing) {
    // 再生中は譜面が流れるので、譜面の上の端に止めておく（案を切り替えて聞き比べられるように）
    style.top = topY;
  } else if (hidden && a.bottom > a.maxY) {
    style.bottom = a.h - a.maxY + 6;
    arrow = '↓ ';
  } else if (hidden) {
    style.top = topY;
    arrow = '↑ ';
  } else if (a.top - 6 - boxH >= topY) {
    // 小節のすぐ上
    style.bottom = a.h - (a.top - 6);
  } else if (a.bottom + 6 + boxH <= a.maxY) {
    // 上に入らなければ小節のすぐ下（生成している小節の点線を隠さない）
    style.top = a.bottom + 6;
  } else {
    style.top = topY;
  }
  const range = len === 1 ? toMeasure(gs.from) : `${toMeasure(gs.from)}〜${toMeasure(gs.to)}`;
  const stop = (e: PointerEvent) => e.stopPropagation();
  const hasChips = rangeHasChips(doc);
  const cand = v?.cand ?? null;
  const add = v?.plan.add.length ?? 0;
  const remove = v?.plan.remove.length ?? 0;
  const dropped = v ? v.plan.skipped.filter((x) => x.why === 'playable' || x.why === 'conflict').length : 0;
  const rejected = v ? v.plan.skipped.filter((x) => x.why === 'rejected').length : 0;
  const offLanes = new Set(gs.offLanes);
  const fitPct = cand && cand.fit !== null && cand.source !== 'draft' ? Math.round(cand.fit * 100) : null;
  const aiTitle = hasKey ? `AI にもう一度作ってもらいます（${model}・1回 約 ${formatUsd(cost)}）。設定 › AI の「小節の生成」のモデルを使います` : noKeyTitle();

  return (
    <div ref={boxRef} className="tab-ghost gen-badge" style={style} onPointerDown={stop}>
      <div className="tg-row">
        <span className="gen-title" title="小節の生成。入れるまで譜面は変わりません">
          {Icon.sparkle(12)} {arrow}小節 <span className="mono">{range}</span>
        </span>
        <span className="gen-tabs" role="tablist" aria-label="案">
          {gs.cands.map((c, i) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={i === gs.index}
              className={`gen-tab ${c.source} ${i === gs.index ? 'on' : ''}`}
              onClick={() => selectMeasureGen(i)}
              title={`${c.name}\n${c.reason}\n\n${SOURCE_TIP[c.source]}${c.fit !== null && c.source !== 'draft' ? `\n原曲で聞こえるドラム（BD・SD・タム）との合い方 ${Math.round(c.fit * 100)}%` : ''}`}
            >
              {tabLabel(c, gs.cands)}
              {c.fit !== null && c.source !== 'draft' && <span className="gen-fit mono">{Math.round(c.fit * 100)}</span>}
            </button>
          ))}
          {gs.ai === 'loading' && (
            <span className="gen-tab loading" title={`${model} が考えています`}>
              AI 考え中…
            </span>
          )}
        </span>
        {hasKey ? (
          <button className="tg-ai" onClick={() => regenMeasureAi(note ?? '')} disabled={gs.ai === 'loading'} title={aiTitle}>
            {Icon.sparkle(12)} {gs.ai === 'done' || gs.ai === 'error' ? 'AIでもう一度' : 'AIで作る'}
          </button>
        ) : (
          <button className="tg-ai" onClick={() => openSettings('ai')} title={noKeyTitle()}>
            {Icon.sparkle(12)} キーを設定するとAIの案も
          </button>
        )}
        {hasKey && note === null && (
          <button className="gen-note-btn" onClick={() => setNote('')} title="AI にひとこと添えて作り直します（例: ここはフィル、ライドで刻む）">
            ひとこと
          </button>
        )}
        <button className="tg-x" onClick={() => closeMeasureGen()} title="やめる（Esc）。譜面は変わりません" aria-label="小節の生成をやめる">
          {Icon.close(12)}
        </button>
      </div>
      {note !== null && (
        <div className="tg-row gen-note">
          <input
            className="field"
            autoFocus
            placeholder="AI へのひとこと（例: ここはフィル。最後はクラッシュ）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                regenMeasureAi(note);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setNote(null);
              }
            }}
          />
          <button onClick={() => regenMeasureAi(note)} disabled={gs.ai === 'loading'}>
            作り直す
          </button>
        </div>
      )}
      <div className="tg-info">
        {cand ? (
          <span title={`${cand.reason}\n\n${SOURCE_TIP[cand.source]}`}>
            <b>{cand.name}</b>
            {cand.reason && <span className="gen-reason"> · {cand.reason}</span>}
          </span>
        ) : gs.ai === 'loading' ? (
          <span>AIが案を考えています…（採譜も写せる小節も見つかりませんでした）</span>
        ) : (
          <span>案が見つかりませんでした。{!hasKey ? 'キーを設定すると AI に作ってもらえます。' : ''}</span>
        )}
        {fitPct !== null && (
          <span title="原曲で聞こえるドラム（採譜したバスドラム・スネア・タム）とどれだけ合うか">
            {' · '}原曲と <b className="mono">{fitPct}%</b>
          </span>
        )}
        {drumless && (
          <span
            className="gen-reason"
            title="BGM がドラム抜きの音源のようです（採譜でバスドラム・スネアがほとんど聞こえません）。採譜の案と、原曲との照合（要確認の枠・原曲と N%）は出しません。写す案と AI の案は前後の小節の流れから作ります"
          >
            {' · '}原曲にドラムが聞こえないので照合なし
          </span>
        )}
        {v && v.doubt.size > 0 && (
          <span className="tg-doubt" title="オレンジの枠のチップは、原曲でその音（バスドラム・スネア・タム）が聞こえません。外れのことが多い所です">
            {' · '}要確認 {v.doubt.size}
          </span>
        )}
        {gs.ai === 'error' && gs.aiError && (
          <span className="tg-err" title={gs.aiError}>
            {' · '}AI: {gs.aiError}
          </span>
        )}
        {gs.cost !== null && <span className="mono">{' · '}{formatUsd(gs.cost)}</span>}
      </div>
      {cand && v && (
        <div className="tg-row gen-merge">
          <button className="tg-accept" onClick={() => applyMeasureGen()} disabled={add + remove === 0} title="この案を入れます（Enter）。Ctrl+Z で戻せます">
            <kbd>Enter</kbd> 入れる
            <span className="gen-count mono">
              <span className="plus">+{add}</span>
              {remove > 0 && <span className="minus"> −{remove}</span>}
            </span>
          </button>
          <button onClick={() => applyMeasureGen({ next: true })} title="入れて、次の小節の生成を始めます（Shift+Enter）">
            入れて次へ
          </button>
          {hasChips && (
            <span className="seg small gen-mode" title="いまの譜面にチップがあるときの入れ方">
              <button className={gs.mode === 'add' ? 'on' : ''} onClick={() => setGenMode('add')} title="いまのチップはすべて残し、案にあって譜面に無いチップだけを足します">
                足す
              </button>
              <button className={gs.mode === 'replace' ? 'on' : ''} onClick={() => setGenMode('replace')} title="案に無いチップは消して、案のとおりにします（消えるチップに赤い × が付きます）">
                置き換え
              </button>
            </span>
          )}
          {v.lanes.length > 0 && (
            <span className="gen-lanes" title="レーンごとに、案を使うか（消すとそのレーンはいまのまま）">
              {v.lanes.map((ln) => {
                const def = DRUM_LANES[ln];
                const off = offLanes.has(ln);
                return (
                  <button
                    key={ln}
                    className={`gen-lane ${off ? 'off' : ''}`}
                    style={{ '--lane': def.color } as CSSProperties}
                    onClick={() => toggleGenLane(ln)}
                    title={`${def.name}：${off ? 'いまのまま（クリックで案を使う）' : '案を使う（クリックでいまのまま）'}`}
                  >
                    {def.key}
                  </button>
                );
              })}
            </span>
          )}
        </div>
      )}
      {cand && v && (
        <div className="tg-info gen-hint">
          点線をクリックで外す
          {remove > 0 || v.kept.size > 0 ? '・赤い × をクリックで残す' : ''}
          {rejected + v.kept.size > 0 && (
            <>
              {' · '}
              <button className="link-btn" onClick={resetGenMarks}>
                外した印を戻す
              </button>
            </>
          )}
          {dropped > 0 && <span title="いまのチップと同時に叩けない（手が3本・同じ場所に別の音）ので入れないチップ">{` · 叩けないので入れない ${dropped}`}</span>}
          {' · '}
          {playing ? <span className="gen-live">♪ 案の音で鳴らしています</span> : <span title="再生すると、案を入れた譜面で鳴ります（ループと合わせて聴き比べ）">再生すると案の音で鳴ります</span>}
          {' · '}
          <kbd>Tab</kbd> 次の案 <kbd>Shift</kbd>+<kbd>Enter</kbd> 入れて次へ
        </div>
      )}
    </div>
  );
}
