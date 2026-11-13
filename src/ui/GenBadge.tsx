// 小節の生成の札：生成している小節のすぐ上に出す（案の切り替え・入れ方・レーンごと・入れる・やめる）。
import { tr } from '../i18n';
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
import { revealChartRange } from './ChartCanvas';
import { Icon } from './icons';

/** Alt+] ・Alt+[ の向き（Mac の Option では文字が変わるので、キーの位置でも見る） */
function bracketDir(e: KeyboardEvent): 1 | -1 | 0 {
  if (e.code === 'BracketRight' || e.key === ']') return 1;
  if (e.code === 'BracketLeft' || e.key === '[') return -1;
  return 0;
}

export function tabLabel(c: GenCandidate, cands: readonly GenCandidate[]): string {
  if (c.source === 'ai') return `AI ${cands.filter((x) => x.source === 'ai').indexOf(c) + 1}`;
  if (c.source === 'draft') return tr('採譜', 'Detected');
  return `${tr('写す', 'Copy')} ${c.src !== undefined ? toMeasure(c.src) : ''}`;
}

export const genSourceTip = (k: GenCandidate['source']): string =>
  ({
    ai: tr('AI が、原曲の打点と前後の小節（作者の書き方）から作った案', "Made by the AI from the original's hits and the measures around it (the charter's style)"),
    draft: tr(
      'ドラムの採譜モデルが原曲から聞き取った打点を、そのままチップにした案。レーン（ライドかシンバルか、HHの開け閉め、タムの高さ）は前後の小節の書き方に合わせて選んでいます',
      'The hits the drum detection model heard in the original, turned straight into chips. Lanes (ride or cymbal, open or closed HH, tom pitch) follow how the nearby measures are written',
    ),
    copy: tr('この曲でもう打った小節を写した案（TAB補完と同じ選び方）', 'A copy of a measure already charted in this song (picked the same way as Tab completion)'),
  })[k];

/** 小節の生成のキー（Esc・Enter・Shift+Enter・Tab・Alt+] / Alt+[）。生成を開いている間だけ効く */
export function useGenKeys() {
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
}

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
  useGenKeys();
  // 開いたとき・範囲が変わったとき（入れて次へ・Alt+G）、範囲が譜面の外なら見える所へ送る（再生中は動かさない）
  useLayoutEffect(() => {
    if (!gs.open || useEditor.getState().playing) return;
    revealChartRange(gs.from, gs.to - gs.from + 1);
  }, [gs.open, gs.from, gs.to]);

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
  const range = len === 1 ? toMeasure(gs.from) : `${toMeasure(gs.from)}${tr('〜', '–')}${toMeasure(gs.to)}`;
  const stop = (e: PointerEvent) => e.stopPropagation();
  const hasChips = rangeHasChips(doc);
  const cand = v?.cand ?? null;
  const add = v?.plan.add.length ?? 0;
  const remove = v?.plan.remove.length ?? 0;
  const dropped = v ? v.plan.skipped.filter((x) => x.why === 'playable' || x.why === 'conflict').length : 0;
  const rejected = v ? v.plan.skipped.filter((x) => x.why === 'rejected').length : 0;
  const offLanes = new Set(gs.offLanes);
  const fitPct = cand && cand.fit !== null && cand.source !== 'draft' ? Math.round(cand.fit * 100) : null;
  const aiTitle = hasKey
    ? tr(
        `AI にもう一度作ってもらいます（${model}・1回 約 ${formatUsd(cost)}）。設定 › AI の「小節の生成」のモデルを使います`,
        `Ask the AI for another one (${model}, about ${formatUsd(cost)} per run). Uses the "Measure generation" model in Settings › AI`,
      )
    : noKeyTitle();

  return (
    <div ref={boxRef} className="tab-ghost gen-badge" style={style} onPointerDown={stop}>
      <div className="tg-row">
        <span className="gen-title" title={tr('小節の生成。入れるまで譜面は変わりません', "Measure generation. The chart doesn't change until you insert")}>
          {Icon.sparkle(12)} {arrow}
          {tr('小節', 'Measure')} <span className="mono">{range}</span>
        </span>
        <span className="gen-tabs" role="tablist" aria-label={tr('案', 'Ideas')}>
          {gs.cands.map((c, i) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={i === gs.index}
              className={`gen-tab ${c.source} ${i === gs.index ? 'on' : ''}`}
              onClick={() => selectMeasureGen(i)}
              title={`${c.name}\n${c.reason}\n\n${genSourceTip(c.source)}${c.fit !== null && c.source !== 'draft' ? tr(`\n原曲で聞こえるドラム（BD・SD・タム）との合い方 ${Math.round(c.fit * 100)}%`, `\nMatch with the drums heard in the original (BD, SD, toms): ${Math.round(c.fit * 100)}%`) : ''}`}
            >
              {tabLabel(c, gs.cands)}
              {c.fit !== null && c.source !== 'draft' && <span className="gen-fit mono">{Math.round(c.fit * 100)}</span>}
            </button>
          ))}
          {gs.ai === 'loading' && (
            <span className="gen-tab loading" title={tr(`${model} が考えています`, `${model} is thinking`)}>
              {tr('AI 考え中…', 'AI thinking…')}
            </span>
          )}
        </span>
        {hasKey ? (
          <button className="tg-ai" onClick={() => regenMeasureAi(note ?? '')} disabled={gs.ai === 'loading'} title={aiTitle}>
            {Icon.sparkle(12)} {gs.ai === 'done' || gs.ai === 'error' ? tr('AIでもう一度', 'AI again') : tr('AIで作る', 'Make with AI')}
          </button>
        ) : (
          <button className="tg-ai" onClick={() => openSettings('ai')} title={noKeyTitle()}>
            {Icon.sparkle(12)} {tr('キーを設定するとAIの案も', 'Set a key for AI ideas too')}
          </button>
        )}
        {hasKey && note === null && (
          <button
            className="gen-note-btn"
            onClick={() => setNote('')}
            title={tr('AI にひとこと添えて作り直します（例: ここはフィル、ライドで刻む）', 'Remake it with a short note to the AI (e.g. "fill here", "keep time on the ride")')}
          >
            {tr('ひとこと', 'Note')}
          </button>
        )}
        <button
          className="tg-x"
          onClick={() => closeMeasureGen()}
          title={tr('やめる（Esc）。譜面は変わりません', "Cancel (Esc). The chart doesn't change")}
          aria-label={tr('小節の生成をやめる', 'Cancel measure generation')}
        >
          {Icon.close(12)}
        </button>
      </div>
      {note !== null && (
        <div className="tg-row gen-note">
          <input
            className="field"
            autoFocus
            placeholder={tr('AI へのひとこと（例: ここはフィル。最後はクラッシュ）', 'A note for the AI (e.g. "a fill here, end on a crash")')}
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
            {tr('作り直す', 'Remake')}
          </button>
        </div>
      )}
      <div className="tg-info">
        {cand ? (
          <span title={`${cand.reason}\n\n${genSourceTip(cand.source)}`}>
            <b>{cand.name}</b>
            {cand.reason && <span className="gen-reason"> · {cand.reason}</span>}
            {cand.basis !== undefined && (
              <span className="gen-reason" title={tr('AI がこの小節の譜面を土台にして、原曲の分析が違う所だけ直した案です', 'The AI started from this measure and changed only where the analysis of the original differs')}>
                {' · '}
                {tr(`小節 ${toMeasure(cand.basis)} が土台`, `Based on measure ${toMeasure(cand.basis)}`)}
              </span>
            )}
          </span>
        ) : gs.ai === 'loading' ? (
          <span>{tr('AIが案を考えています…（採譜も写せる小節も見つかりませんでした）', 'The AI is working on an idea… (no detected hits or measures to copy were found)')}</span>
        ) : (
          <span>
            {tr('案が見つかりませんでした。', 'No ideas found. ')}
            {!hasKey ? tr('キーを設定すると AI に作ってもらえます。', 'Set a key to have the AI make one.') : ''}
          </span>
        )}
        {fitPct !== null && (
          <span title={tr('原曲で聞こえるドラム（採譜したバスドラム・スネア・タム）とどれだけ合うか', 'How well it matches the drums heard in the original (detected kick, snare and toms)')}>
            {' · '}
            {tr('原曲と', 'Original match')} <b className="mono">{fitPct}%</b>
          </span>
        )}
        {drumless && (
          <span
            className="gen-reason"
            title={tr(
              'BGM がドラム抜きの音源のようです（採譜でバスドラム・スネアがほとんど聞こえません）。採譜の案と、原曲との照合（要確認の枠・原曲と N%）は出しません。写す案と AI の案は前後の小節の流れから作ります',
              'The BGM seems to have no drums (detection hears almost no kick or snare). Detected ideas and the comparison with the original (check frames, "Original match N%") are not shown. Copy and AI ideas are based on the surrounding measures',
            )}
          >
            {' · '}
            {tr('原曲にドラムが聞こえないので照合なし', 'No drums heard in the original, so no comparison')}
          </span>
        )}
        {v && v.doubt.size > 0 && (
          <span
            className="tg-doubt"
            title={tr(
              'オレンジの枠のチップは、原曲でその音（バスドラム・スネア・タム）が聞こえません。外れのことが多い所です',
              "Chips with an orange frame aren't heard in the original (kick, snare, toms). These are often wrong",
            )}
          >
            {' · '}
            {tr('要確認', 'Check')} {v.doubt.size}
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
          <button
            className="tg-accept"
            onClick={() => applyMeasureGen()}
            disabled={add + remove === 0}
            title={tr('この案を入れます（Enter）。Ctrl+Z で戻せます', 'Insert this idea (Enter). Undo with Ctrl+Z')}
          >
            <kbd>Enter</kbd> {tr('入れる', 'Insert')}
            <span className="gen-count mono">
              <span className="plus">+{add}</span>
              {remove > 0 && <span className="minus"> −{remove}</span>}
            </span>
          </button>
          <button onClick={() => applyMeasureGen({ next: true })} title={tr('入れて、次の小節の生成を始めます（Shift+Enter）', 'Insert and start on the next measure (Shift+Enter)')}>
            {tr('入れて次へ', 'Insert & next')}
          </button>
          {hasChips && (
            <span className="seg small gen-mode" title={tr('いまの譜面にチップがあるときの入れ方', 'How to insert when the chart already has chips here')}>
              <button
                className={gs.mode === 'add' ? 'on' : ''}
                onClick={() => setGenMode('add')}
                title={tr('いまのチップはすべて残し、案にあって譜面に無いチップだけを足します', "Keeps every current chip and only adds the idea's chips that aren't there yet")}
              >
                {tr('足す', 'Add')}
              </button>
              <button
                className={gs.mode === 'replace' ? 'on' : ''}
                onClick={() => setGenMode('replace')}
                title={tr('案に無いチップは消して、案のとおりにします（消えるチップに赤い × が付きます）', "Removes chips that aren't in the idea so it matches exactly (chips to be removed get a red ×)")}
              >
                {tr('置き換え', 'Replace')}
              </button>
            </span>
          )}
          {v.lanes.length > 0 && (
            <span className="gen-lanes" title={tr('レーンごとに、案を使うか（消すとそのレーンはいまのまま）', 'Use the idea per lane (turn a lane off to keep it as it is)')}>
              {v.lanes.map((ln) => {
                const def = DRUM_LANES[ln];
                const off = offLanes.has(ln);
                return (
                  <button
                    key={ln}
                    className={`gen-lane ${off ? 'off' : ''}`}
                    style={{ '--lane': def.color } as CSSProperties}
                    onClick={() => toggleGenLane(ln)}
                    title={`${def.name}${tr('：', ': ')}${off ? tr('いまのまま（クリックで案を使う）', 'kept as is (click to use the idea)') : tr('案を使う（クリックでいまのまま）', 'uses the idea (click to keep as is)')}`}
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
          {tr('点線をクリックで外す', 'Click a dashed chip to drop it')}
          {remove > 0 || v.kept.size > 0 ? tr('・赤い × をクリックで残す', ', click a red × to keep it') : ''}
          {rejected + v.kept.size > 0 && (
            <>
              {' · '}
              <button className="link-btn" onClick={resetGenMarks}>
                {tr('外した印を戻す', 'Reset the marks')}
              </button>
            </>
          )}
          {dropped > 0 && (
            <span title={tr('いまのチップと同時に叩けない（手が3本・同じ場所に別の音）ので入れないチップ', "Chips left out because they can't be played with the current chips (three hands, or another sound in the same spot)")}>
              {tr(` · 叩けないので入れない ${dropped}`, ` · Unplayable, left out: ${dropped}`)}
            </span>
          )}
          {' · '}
          {playing ? (
            <span className="gen-live">{tr('♪ 案の音で鳴らしています', '♪ Playing with the idea')}</span>
          ) : (
            <span title={tr('再生すると、案を入れた譜面で鳴ります（ループと合わせて聴き比べ）', 'Playback uses the chart with the idea inserted (compare using a loop)')}>
              {tr('再生すると案の音で鳴ります', 'Playback uses the idea')}
            </span>
          )}
          {' · '}
          <kbd>Tab</kbd> {tr('次の案', 'next idea')} <kbd>Shift</kbd>+<kbd>Enter</kbd> {tr('入れて次へ', 'insert & next')}
        </div>
      )}
    </div>
  );
}
