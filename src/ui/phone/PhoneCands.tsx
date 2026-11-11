// スマホ：TAB補完・小節の生成（AI）・フレーズ候補（AI）の操作。点線の候補を見ながら選べるように、譜面の上には重ねない
// （PC・iPad の札は点線のすぐ上・譜面の上端に浮かぶが、スマホの譜面は 1 小節で画面がほぼ埋まるので、点線を隠してしまう）。
// - TAB補完：譜面の下の端に細い帯。チップを置くたびに出るので、譜面の大きさは変えない。点線は置いた小節より先（上）に
//   出るので、下の端なら隠れない。帯の陰は「見えていない所」とし、点線の頭が陰になったら帯の上まで送る
// - 小節の生成・フレーズ候補：譜面の下に並べて譜面を縮める（道具の帯の代わり。開くと下のシート・横のパネルは閉じ、
//   閉じると戻す）。開いたとき・範囲が変わったとき、範囲が見える所へ送る
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { pl, tr } from '../../i18n';
import { formatUsd, modelLabel } from '../../ai/tasks';
import { toMeasure } from '../../dtx/base36';
import { DRUM_LANES } from '../../dtx/model';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../../store/ai';
import { useAssist } from '../../store/assist';
import { acceptGhost, askAi, dismissGhost, ghostBadge, sourceLabel, stepGhost, useComplete } from '../../store/complete';
import { tempoOf } from '../../store/derived';
import { closePhoneTab, useDevice, type PhoneTab } from '../../store/device';
import { drumsAudible, useDrums } from '../../store/drums';
import { openSettings, useEditor } from '../../store/editor';
import {
  applyMeasureGen,
  closeMeasureGen,
  genView,
  rangeHasChips,
  regenMeasureAi,
  resetGenMarks,
  selectMeasureGen,
  setGenMode,
  toggleGenLane,
  useMeasureGen,
} from '../../store/measureGen';
import { applyCandidate, closePhrase, makeCandidates, setPhraseRange, stepCandidate, usePhrase } from '../../store/phrase';
import { useVel } from '../../store/velocity';
import { liftAboveCover, revealChartRange, revealGhost, setChartBottomCover, visibleBeats } from '../ChartCanvas';
import { genSourceTip, tabLabel, useGenKeys } from '../GenBadge';
import { Icon } from '../icons';
import { usePhraseKeys } from '../PhrasePanel';

/** 帯と譜面の下の端のすき間 */
const BAR_GAP = 6;

const stop = (e: PointerEvent) => e.stopPropagation();

// ---- 候補を出している間、知らせ（トースト）は画面の上に出す -------------------------------------
// ふだんの知らせは譜面の下の方に出るので、点線の頭（入れた次の小節など）や帯のボタンを隠してしまう

let candShown = 0;

function useToastOnTop() {
  useLayoutEffect(() => {
    candShown++;
    document.documentElement.classList.add('p-cand-on');
    return () => {
      candShown--;
      if (candShown <= 0) {
        candShown = 0;
        document.documentElement.classList.remove('p-cand-on');
      }
    };
  }, []);
}

// ---- 譜面の下のパネル：範囲が見える所へ送る ---------------------------------------------------

/**
 * 開いたとき・範囲が変わったとき（入れて次へ・範囲を変えた）、範囲が譜面に見える所へ送る。
 * パネルの高さが変わって譜面が縮んだ・伸びたとき（案が届いた・候補を作った）も見直す（もう見えていれば動かさない）
 */
function useRevealRange(ref: React.RefObject<HTMLElement | null>, from: number, len: number) {
  const want = useRef({ from, len });
  want.current = { from, len };
  useLayoutEffect(() => {
    revealChartRange(from, len);
  }, [from, len]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let h = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const nh = el.offsetHeight;
      if (Math.abs(nh - h) < 2) return;
      h = nh;
      revealChartRange(want.current.from, want.current.len);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

// ---- 小節の生成・フレーズ候補を開いたら、下のシート（横は右のパネル）を閉じ、閉じたら戻す -----------------

let restore: { tab: PhoneTab; high: boolean } | null = null;

function dockOpened() {
  const d = useDevice.getState();
  if (!d.phone || !d.pTab) return;
  restore = { tab: d.pTab, high: d.pHigh };
  closePhoneTab();
}

function dockClosed() {
  const r = restore;
  restore = null;
  if (!r || useMeasureGen.getState().open || usePhrase.getState().open) return;
  // 閉じている間にほかのタブを開いていたら、そのまま
  const d = useDevice.getState();
  if (!d.phone || d.pTab) return;
  useDevice.setState({ pTab: r.tab, pHigh: r.high });
}

useMeasureGen.subscribe((s, prev) => {
  if (s.open && !prev.open) dockOpened();
  else if (!s.open && prev.open) dockClosed();
});
usePhrase.subscribe((s, prev) => {
  if (s.open && !prev.open) dockOpened();
  else if (!s.open && prev.open) dockClosed();
});

/** 譜面の下に並べるパネル（小節の生成・フレーズ候補）を出しているか */
export function usePhoneDock(): 'gen' | 'phrase' | null {
  const gen = useMeasureGen((s) => s.open);
  const phrase = usePhrase((s) => s.open);
  return gen ? 'gen' : phrase ? 'phrase' : null;
}

// ---- TAB補完の帯（譜面の下の端） ---------------------------------------------------------------

/** TAB補完の帯。点線が出ているとき（と、呼び出したのに見つからない・AI を待っているとき）だけ */
export function PhoneTabBar() {
  // ghostBadge() が見ているもの
  useComplete();
  useEditor((s) => s.doc);
  useEditor((s) => s.playing);
  useEditor((s) => s.page);
  useEditor((s) => s.screen);
  usePhrase((s) => s.open);
  useMeasureGen((s) => s.open);
  useVel((s) => s.mode);
  useAssist((s) => s.data);
  const b = ghostBadge();
  if (!b) return null;
  return <TabBar at={b.at} />;
}

function TabBar({ at }: { at: number }) {
  const c = useComplete();
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.view.scrollBeat);
  useEditor((s) => s.view.pxPerBeat);
  const land = useDevice((s) => !s.portrait);
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.phrase.model, s.models));
  const cost = useAi(() => taskCostEstimate('phrase'));
  const ref = useRef<HTMLDivElement>(null);
  useToastOnTop();
  const g = ghostBadge()?.ghost ?? null;
  const len = g ? g.measures.length : 1;
  const key = `${at}|${len}|${g ? `${g.index}/${g.count}` : '-'}`;
  // 帯の陰は見えていない所。出たとき・候補が変わったとき、点線の頭が陰（か譜面の下の外）なら帯の上まで送る
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setChartBottomCover(el.offsetHeight + BAR_GAP + 4);
    liftAboveCover(tempoOf(useEditor.getState().doc).measureStart(at));
  }, [key]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = el.parentElement;
    const put = () => {
      setChartBottomCover(el.offsetHeight + BAR_GAP + 4);
      // 録音の札は帯の上に
      chart?.style.setProperty('--p-tabbar-h', `${el.offsetHeight + BAR_GAP}px`);
    };
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => {
      ro.disconnect();
      setChartBottomCover(0);
      chart?.style.removeProperty('--p-tabbar-h');
    };
  }, []);

  const tm = tempoOf(doc);
  const vis = visibleBeats();
  const b0 = tm.measureStart(at);
  const b1 = tm.measureStart(at + len);
  // 点線がまるごと画面の外なら、向きを示す（押すとそこへ送る）
  const arrow = b0 > vis.to ? '↑ ' : b1 < vis.from ? '↓ ' : '';
  const range = len === 1 ? toMeasure(at) : `${toMeasure(at)}${tr('〜', '–')}${toMeasure(at + len - 1)}`;
  const aiTitle = hasKey
    ? tr(
        `この先の続きをAIに3つ作ってもらいます（${model}・1回 約 ${formatUsd(cost)}）。設定 › AI の「フレーズ候補」のモデルを使います`,
        `Ask the AI for 3 ways to continue from here (${model}, about ${formatUsd(cost)} per run). Uses the "Phrase ideas" model in Settings › AI`,
      )
    : noKeyTitle();
  // 前後の候補と「1小節だけ」が両方あるときは、AI のボタンを短く
  const tight = !!g && g.count > 1 && len > 1;
  const aiButton = (
    <button className="p-btn sm p-cand-ai" onClick={() => void askAi()} disabled={c.aiLoading} title={aiTitle} aria-label={tr('AIに聞く', 'Ask AI')}>
      {Icon.sparkle(14)}
      <span>{c.aiLoading ? tr('考え中…', 'Thinking…') : tight ? 'AI' : tr('AIに聞く', 'Ask AI')}</span>
    </button>
  );

  let info: React.ReactNode;
  if (g) {
    const cand = g.cand;
    const pct = Number.isFinite(cand.score) ? Math.round(cand.score * 100) : null;
    info = (
      <>
        <span className="p-cand-where mono">
          {arrow}
          {tr('小節', 'Bar')} {range}
        </span>
        <span>{sourceLabel(cand)}</span>
        {pct !== null && (
          <span>
            {tr('見込み', 'Likely')} <b className="mono">{pct}%</b>
          </span>
        )}
        {g.doubt.size > 0 && (
          <span className="p-cand-doubt">
            {tr('要確認', 'Check')} {g.doubt.size}
          </span>
        )}
        {c.aiError && <span className="p-cand-err">{tr('AIは失敗しました', 'The AI failed')}</span>}
      </>
    );
  } else {
    info = (
      <>
        <span className="p-cand-where mono">
          {arrow}
          {tr('小節', 'Bar')} {toMeasure(at)}
        </span>
        <span className={c.aiError ? 'p-cand-err' : ''}>
          {c.aiLoading ? tr('AIが続きを考えています…', 'The AI is working on a continuation…') : c.aiError ? `AI: ${c.aiError}` : tr('続きの候補が見つかりません', 'No continuation found')}
        </span>
      </>
    );
  }

  return (
    <div
      ref={ref}
      className={`p-cand p-tabbar ${land ? 'land' : ''}`}
      role="toolbar"
      aria-label={tr('TAB補完', 'Tab completion')}
      onPointerDown={stop}
    >
      <button
        className="p-cand-info"
        onClick={() => revealGhost(at, len)}
        title={tr('点線の所へ送る', 'Scroll to the dashed measures')}
      >
        <span className="p-cand-tag">{Icon.sparkle(12)}TAB</span>
        <span className="p-cand-text">{info}</span>
      </button>
      <div className="p-cand-acts">
        {g && g.count > 1 && (
          <span className="p-cand-step">
            <button className="p-ib sm" onClick={() => stepGhost(-1)} aria-label={tr('前の候補', 'Previous idea')}>
              {Icon.chevronLeft(18)}
            </button>
            <span className="mono">
              {g.index + 1}/{g.count}
            </span>
            <button className="p-ib sm" onClick={() => stepGhost(1)} aria-label={tr('次の候補', 'Next idea')}>
              {Icon.chevronRight(18)}
            </button>
          </span>
        )}
        {(g || !c.aiLoading) && aiButton}
        <span className="grow" />
        {g && len > 1 && (
          <button className="p-btn sm" onClick={() => acceptGhost(1)} title={tr('最初の1小節だけ入れます', 'Insert only the first measure')}>
            {tr('1小節だけ', 'Just one')}
          </button>
        )}
        {g && (
          <button className="p-btn sm primary" onClick={() => acceptGhost()} title={tr('点線の小節を入れます（元に戻すで戻せます）', 'Insert the dashed measures (you can undo)')}>
            {len > 1 ? tr('全部入れる', 'Insert all') : tr('入れる', 'Insert')}
          </button>
        )}
      </div>
      <button className="p-ib sm p-cand-x" onClick={() => dismissGhost()} aria-label={tr('TAB補完を消す', 'Dismiss Tab completion')} title={tr('消す（次にチップを置くまで出しません）', "Dismiss (it won't come back until you place another chip)")}>
        {Icon.close(16)}
      </button>
    </div>
  );
}

// ---- 小節の生成（譜面の下） ----------------------------------------------------------------

/** 小節の生成のパネル（開いているときだけ。キーはいつも受ける） */
export function PhoneGenDock() {
  useGenKeys();
  const open = useMeasureGen((s) => s.open);
  return open ? <GenDock /> : null;
}

function GenDock() {
  const gs = useMeasureGen();
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const land = useDevice((s) => !s.portrait);
  // 採譜が終わったら「ドラム抜きの BGM か」が分かる
  useDrums((d) => d.status);
  const drumless = drumsAudible() === false;
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.measure.model, s.models));
  const cost = useAi(() => taskCostEstimate('measure'));
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useToastOnTop();
  // 作っている小節が見える所へ
  useRevealRange(ref, gs.from, gs.to - gs.from + 1);

  const v = genView(doc);
  const len = gs.to - gs.from + 1;
  const range = len === 1 ? toMeasure(gs.from) : `${toMeasure(gs.from)}${tr('〜', '–')}${toMeasure(gs.to)}`;
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
    <section ref={ref} className={`p-dock p-gen ${land ? 'land' : ''}`} aria-label={tr('小節の生成', 'Measure generation')} onPointerDown={stop}>
      <div className="p-dock-head">
        <span className="p-dock-title gen">
          {Icon.sparkle(13)}
          {tr('小節', 'Bar')} <span className="mono">{range}</span>
        </span>
        <span className="p-dock-info" title={cand ? `${cand.reason}\n\n${genSourceTip(cand.source)}` : undefined}>
          {cand ? (
            <>
              <b>{cand.name}</b>
              {fitPct !== null && (
                <span>
                  {tr('原曲と', 'Original match')} <b className="mono">{fitPct}%</b>
                </span>
              )}
              {v && v.doubt.size > 0 && (
                <span className="p-cand-doubt">
                  {tr('要確認', 'Check')} {v.doubt.size}
                </span>
              )}
              {gs.ai === 'error' && gs.aiError && <span className="p-cand-err">AI: {gs.aiError}</span>}
            </>
          ) : gs.ai === 'loading' ? (
            <span>{tr('AIが案を考えています…', 'The AI is working on an idea…')}</span>
          ) : (
            <span>
              {tr('案が見つかりませんでした。', 'No ideas found. ')}
              {!hasKey ? tr('キーを設定すると AI に作ってもらえます。', 'Set a key to have the AI make one.') : ''}
            </span>
          )}
        </span>
        <button className="p-ib sm" onClick={() => closeMeasureGen()} aria-label={tr('小節の生成をやめる', 'Cancel measure generation')} title={tr('やめる（譜面は変わりません）', "Cancel (the chart doesn't change)")}>
          {Icon.close(16)}
        </button>
      </div>
      <div className="p-dock-scroll" role="tablist" aria-label={tr('案', 'Ideas')}>
        {gs.cands.map((c, i) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={i === gs.index}
            className={`p-gen-tab ${c.source} ${i === gs.index ? 'on' : ''}`}
            onClick={() => selectMeasureGen(i)}
            title={`${c.name}\n${c.reason}\n\n${genSourceTip(c.source)}`}
          >
            {tabLabel(c, gs.cands)}
            {c.fit !== null && c.source !== 'draft' && <span className="p-gen-fit mono">{Math.round(c.fit * 100)}</span>}
          </button>
        ))}
        {gs.ai === 'loading' && <span className="p-gen-tab loading">{tr('AI 考え中…', 'AI thinking…')}</span>}
        {hasKey ? (
          <button className="p-btn sm p-cand-ai" onClick={() => regenMeasureAi(note ?? '')} disabled={gs.ai === 'loading'} title={aiTitle}>
            {Icon.sparkle(14)}
            <span>{gs.ai === 'done' || gs.ai === 'error' ? tr('AIでもう一度', 'AI again') : tr('AIで作る', 'Make with AI')}</span>
          </button>
        ) : (
          <button className="p-btn sm p-cand-ai" onClick={() => openSettings('ai')} title={noKeyTitle()}>
            {Icon.sparkle(14)}
            <span>{tr('キーを設定するとAIの案も', 'Set a key for AI ideas too')}</span>
          </button>
        )}
        {hasKey && note === null && (
          <button className="p-btn sm" onClick={() => setNote('')} title={tr('AI にひとこと添えて作り直します（例: ここはフィル、ライドで刻む）', 'Remake it with a short note to the AI (e.g. "fill here", "keep time on the ride")')}>
            {tr('ひとこと', 'Note')}
          </button>
        )}
      </div>
      {note !== null && (
        <div className="p-dock-row">
          <input
            className="field p-dock-input"
            autoFocus
            enterKeyHint="send"
            placeholder={tr('AI へのひとこと（例: ここはフィル）', 'A note for the AI (e.g. "a fill here")')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                regenMeasureAi(note);
              }
            }}
          />
          <button className="p-btn sm" onClick={() => regenMeasureAi(note)} disabled={gs.ai === 'loading'}>
            {tr('作り直す', 'Remake')}
          </button>
          <button className="p-ib sm" onClick={() => setNote(null)} aria-label={tr('ひとことをやめる', 'Close the note')}>
            {Icon.close(15)}
          </button>
        </div>
      )}
      {cand && v && (
        <div className="p-dock-row p-gen-acts">
          <button className="p-btn sm primary grow" onClick={() => applyMeasureGen()} disabled={add + remove === 0} title={tr('この案を入れます（元に戻すで戻せます）', 'Insert this idea (you can undo)')}>
            {tr('入れる', 'Insert')}
            <span className="p-gen-count mono">
              +{add}
              {remove > 0 && <span className="minus"> −{remove}</span>}
            </span>
          </button>
          <button className="p-btn sm" onClick={() => applyMeasureGen({ next: true })} title={tr('入れて、次の小節の生成を始めます', 'Insert and start on the next measure')}>
            {tr('入れて次へ', 'Insert & next')}
          </button>
          {hasChips && (
            <span className="p-seg p-gen-mode" title={tr('いまの譜面にチップがあるときの入れ方', 'How to insert when the chart already has chips here')}>
              <button className={gs.mode === 'add' ? 'on' : ''} onClick={() => setGenMode('add')} title={tr('いまのチップはすべて残し、案にあって譜面に無いチップだけを足します', "Keeps every current chip and only adds the idea's chips that aren't there yet")}>
                {tr('足す', 'Add')}
              </button>
              <button className={gs.mode === 'replace' ? 'on' : ''} onClick={() => setGenMode('replace')} title={tr('案に無いチップは消して、案のとおりにします（消えるチップに赤い × が付きます）', "Removes chips that aren't in the idea so it matches exactly (chips to be removed get a red ×)")}>
                {tr('置き換え', 'Replace')}
              </button>
            </span>
          )}
        </div>
      )}
      {cand && v && (
        <div className="p-dock-scroll p-gen-lanes">
          {v.lanes.map((ln) => {
            const def = DRUM_LANES[ln];
            const off = offLanes.has(ln);
            return (
              <button
                key={ln}
                className={`p-gen-lane ${off ? 'off' : ''}`}
                style={{ '--lane': def.color } as CSSProperties}
                onClick={() => toggleGenLane(ln)}
                aria-pressed={!off}
                title={`${def.name}${tr('：', ': ')}${off ? tr('いまのまま（押すと案を使う）', 'kept as is (tap to use the idea)') : tr('案を使う（押すといまのまま）', 'uses the idea (tap to keep as is)')}`}
              >
                {def.key}
              </button>
            );
          })}
          <span className="p-dock-hint">
            {tr('点線をタップで外す', 'Tap a dashed chip to drop it')}
            {remove > 0 || v.kept.size > 0 ? tr('・赤い × をタップで残す', ', tap a red × to keep it') : ''}
          </span>
          {rejected + v.kept.size > 0 && (
            <button className="p-btn sm" onClick={resetGenMarks}>
              {tr('外した印を戻す', 'Reset the marks')}
            </button>
          )}
          {dropped > 0 && <span className="p-dock-hint">{tr(`叩けないので入れない ${dropped}`, `Unplayable, left out: ${dropped}`)}</span>}
          {drumless && <span className="p-dock-hint">{tr('原曲にドラムが聞こえないので照合なし', 'No drums heard in the original, so no comparison')}</span>}
          <span className={`p-dock-hint ${playing ? 'live' : ''}`}>{playing ? tr('♪ 案の音で鳴らしています', '♪ Playing with the idea') : tr('再生すると案の音で鳴ります', 'Playback uses the idea')}</span>
          {gs.cost !== null && <span className="p-dock-hint mono">{formatUsd(gs.cost)}</span>}
        </div>
      )}
    </section>
  );
}

// ---- フレーズ候補（譜面の下） ----------------------------------------------------------------

/** フレーズ候補のパネル（開いているときだけ） */
export function PhonePhraseDock() {
  const open = usePhrase((s) => s.open);
  return open ? <PhraseDock /> : null;
}

function PhraseDock() {
  const p = usePhrase();
  const doc = useEditor((s) => s.doc);
  const land = useDevice((s) => !s.portrait);
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.phrase.model, s.models));
  const cost = useAi(() => taskCostEstimate('phrase'));
  const ref = useRef<HTMLElement>(null);
  useToastOnTop();
  usePhraseKeys();
  /** 候補があるときに、範囲・ひとことを直している */
  const [edit, setEdit] = useState(false);
  const has = p.cands.length > 0;
  // 候補が届いたら候補を見せる
  useEffect(() => {
    if (has) setEdit(false);
  }, [has]);
  // 範囲が見える所へ
  useRevealRange(ref, p.from, p.to - p.from + 1);

  const setup = !has || edit;
  const cand = has ? (p.cands[p.index] ?? null) : null;
  const stale = has && p.madeFor !== doc;
  const n = p.to - p.from + 1;
  const range = n === 1 ? toMeasure(p.from) : `${toMeasure(p.from)}${tr('〜', '–')}${toMeasure(p.to)}`;
  const stepBtn = (label: string, icon: React.ReactNode, disabled: boolean, run: () => void) => (
    <button className="p-ib sm boxed" onClick={run} disabled={disabled} aria-label={label} title={label}>
      {icon}
    </button>
  );

  return (
    <section ref={ref} className={`p-dock p-phrase ${land ? 'land' : ''}`} aria-label={tr('フレーズ候補', 'Phrase ideas')} onPointerDown={stop}>
      <div className="p-dock-head">
        <span className="p-dock-title phrase">
          {Icon.sparkle(13)}
          {tr('フレーズ候補', 'Phrase ideas')}
        </span>
        <span className="p-dock-info">
          <span className="mono">
            {tr('小節', 'Bar')} {range}
          </span>
          {has && <span>{p.kind === 'fill' ? tr('フィル', 'Fills') : tr('リズム', 'Grooves')}</span>}
        </span>
        {has && (
          <button className="p-btn sm" onClick={() => setEdit(!edit)}>
            {edit ? tr('候補に戻る', 'Back to ideas') : tr('条件を変える', 'Change')}
          </button>
        )}
        <button className="p-ib sm" onClick={closePhrase} aria-label={tr('フレーズ候補を閉じる', 'Close phrase ideas')} title={tr('閉じる（譜面は変わりません）', "Close (the chart doesn't change)")}>
          {Icon.close(16)}
        </button>
      </div>
      {setup && (
        <>
          <div className="p-dock-row p-phrase-range">
            <span className="lbl">{tr('範囲', 'Range')}</span>
            {stepBtn(tr('始まりを前の小節へ', 'Start one measure earlier'), Icon.minus(15), p.from <= 0, () => setPhraseRange(p.from - 1, p.to))}
            <b className="mono p-phrase-m">{toMeasure(p.from)}</b>
            {stepBtn(tr('始まりを次の小節へ', 'Start one measure later'), Icon.plus(15), false, () => setPhraseRange(p.from + 1, Math.max(p.from + 1, p.to)))}
            <span className="lbl">{tr('〜', '–')}</span>
            {stepBtn(tr('終わりを前の小節へ', 'End one measure earlier'), Icon.minus(15), p.to <= p.from, () => setPhraseRange(p.from, p.to - 1))}
            <b className="mono p-phrase-m">{toMeasure(p.to)}</b>
            {stepBtn(tr('終わりを次の小節へ（4小節まで）', 'End one measure later (up to 4)'), Icon.plus(15), n >= 4, () => setPhraseRange(p.from, p.to + 1))}
            <span className="lbl p-phrase-n">{tr(`${n}小節`, `${n} ${pl(n, 'bar')}`)}</span>
          </div>
          <div className="p-dock-row p-phrase-text">
            <input
              className="field p-dock-input"
              enterKeyHint="done"
              placeholder={hasKey ? tr('ひとこと（例: 着地はクラッシュ）', 'A note (e.g. "land on a crash")') : tr('ひとことはキーを設定すると使えます', 'Set a key to add a note')}
              value={p.instruction}
              disabled={!hasKey}
              onChange={(e) => usePhrase.setState({ instruction: e.target.value })}
            />
          </div>
          <div className="p-dock-row">
            <button className={`p-btn sm grow ${p.kind === 'fill' && has ? 'on' : ''}`} onClick={() => void makeCandidates('fill')} disabled={p.loading}>
              {tr('フィルの候補', 'Fill ideas')}
            </button>
            <button className={`p-btn sm grow ${p.kind === 'rhythm' && has ? 'on' : ''}`} onClick={() => void makeCandidates('rhythm')} disabled={p.loading}>
              {tr('リズムの候補', 'Groove ideas')}
            </button>
          </div>
          <div className="p-dock-note">
            {p.loading ? (
              tr('候補を作っています…', 'Making ideas…')
            ) : hasKey ? (
              <>
                {model} · {tr(`1回 約 ${formatUsd(cost)}`, `about ${formatUsd(cost)} per run`)}
              </>
            ) : (
              <>
                {tr('キーが無いので「似た小節からコピー」と「直前小節の複製」だけ出します。', 'No key, so only "copy from a similar measure" and "repeat the previous measure" are offered.')}{' '}
                <button className="link-btn" onClick={() => openSettings('ai')}>
                  {tr('キーを設定', 'Set a key')}
                </button>
              </>
            )}
          </div>
        </>
      )}
      {p.error && <div className="p-dock-note p-cand-err">{p.error}</div>}
      {!setup && cand && (
        <>
          <div className="p-dock-row p-phrase-pick">
            <button className="p-ib sm boxed" onClick={() => stepCandidate(-1)} aria-label={tr('前の候補', 'Previous idea')} disabled={p.cands.length < 2}>
              {Icon.chevronLeft(18)}
            </button>
            <div className="p-phrase-cur">
              <div className="p-phrase-name">
                <span className="mono lbl">
                  {p.index + 1}/{p.cands.length}
                </span>
                <b>{cand.name}</b>
              </div>
              <div className="p-phrase-sub">
                {tr(`${cand.notes.length}打`, `${cand.notes.length} ${pl(cand.notes.length, 'note')}`)}
                {cand.source !== 'ai' && <> · {cand.source === 'prev' ? tr('複製', 'Repeat') : tr('コピー', 'Copy')}</>}
                {cand.reason && <> · {cand.reason}</>}
              </div>
            </div>
            <button className="p-ib sm boxed" onClick={() => stepCandidate(1)} aria-label={tr('次の候補', 'Next idea')} disabled={p.cands.length < 2}>
              {Icon.chevronRight(18)}
            </button>
            <button className="p-btn sm primary" onClick={applyCandidate} title={tr('範囲のドラムを候補で置き換えます（元に戻すで戻せます）', 'Replace the drums in the range with this idea (you can undo)')}>
              {tr('反映', 'Apply')}
            </button>
          </div>
          {(stale || p.cost !== null) && (
            <div className="p-dock-note">
              {stale && <span className="p-cand-warn">{tr('候補を作ったあとに譜面が変わりました。', 'The chart changed after these ideas were made.')}</span>}
              {p.cost !== null && <span className="mono"> {formatUsd(p.cost)}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
