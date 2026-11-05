// AI難易度生成の画面：曲の難易度（元の譜面・曲に既にある譜面・作る難易度）と目標の幅、難易度ごとの生成、
// 曲全体で並べて聴き比べる（押して手直し）、AI のレベル判定と方針、set.def への書き出し。
// 再生の操作はエディタと同じ（Space・Shift+Space・▶・ループ・速さ）。
import { tr, pl, locale } from '../i18n';
import { useEffect, useMemo } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { drumChannel, type DtxDoc } from '../dtx/model';
import { gridStep, snapToGrid } from '../edit/ops';
import { chartFeatures, FEATURE_DEFS, lastMeasure } from '../gen/features';
import { DEFAULT_RUNG, describePolicy, FILL_STYLES, MAX_RUNG, policyFor, type Difficulty } from '../gen/simplify';
import { SLOTS, type Slot } from '../gen/targets';
import { originOf } from '../dtx/origin';
import { setLoopPoint, toggleLoop } from '../store/assist';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { tempoOf } from '../store/derived';
import { goBack, goToStart, openPage, openSettings, playFrom, setCursorBeat, togglePause, togglePlay, useEditor } from '../store/editor';
import {
  belowSource,
  calcLevel,
  columnKind,
  generate,
  generateAll,
  genShow,
  initGen,
  isPassing,
  knownLevels,
  listenChoices,
  selectDiff,
  setEnabled,
  setGenView,
  setKeep,
  setListen,
  setTarget,
  shiftRung,
  shownLevel,
  slotLabel,
  sourceFor,
  stepListen,
  useGen,
  writeOut,
  type DiffState,
  type ExistingChart,
  type GenFit,
  type GenState,
} from '../store/gen';
import { useGuideline } from '../store/guideline';
import { useSidecar } from '../store/sidecar';
import { useDevice } from '../store/device';
import { genViewport, GenCompare } from './GenCompare';
import { setGenDetail, useTabletUi } from './tablet/shared';
import { Icon } from './icons';
import { MasterMixer, TrackMixStrip } from './MixPanel';
import { OriginBadge, originTitle } from './OriginBadge';
import { FollowToggle, LoopControls, PlayControls, SpeedControl } from './Transport';

const keepItems = (): { k: keyof ReturnType<typeof useGen.getState>['keep']; label: string }[] => [
  { k: 'backbeat', label: tr('2・4拍のスネア（バックビート）', 'Snare on beats 2 and 4 (backbeat)') },
  { k: 'kick1', label: tr('1拍目のキック', 'Kick on beat 1') },
  { k: 'sectionCrash', label: tr('セクション頭のクラッシュ', 'Crash at the start of each section') },
  { k: 'fillLanding', label: tr('フィルの着地', 'Fill landings') },
  { k: 'openHH', label: tr('オープンHHのアクセント', 'Open hi-hat accents') },
];

/** 入力欄で文字を打っているか（チェックボックスは別。Space で再生できるように） */
function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'range'].includes((t as HTMLInputElement).type);
  return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

/**
 * この画面のキー。再生まわりはエディタと同じ（Space・Shift+Space・↑↓ で ▶・Home・I/O/ /）。
 * ←→ は聴く譜面の切り替え。F5〜F7・Alt+1/2（曲の音・譜面の音を消す）・Ctrl+S はエディタの共通のキーで効く
 */
function onGenKey(e: KeyboardEvent) {
  if (document.querySelector('.modal-back') || typing(e)) return;
  if (e.ctrlKey || e.metaKey) return;
  const k = e.key;
  if (k === 'Escape') {
    // ミックスの小窓が開いているときは、小窓を閉じるだけ（エディタには戻らない）
    if (!document.querySelector('.mix-pop')) goBack();
    return;
  }
  if (k === ' ') {
    // Space：再生・停止（止めると ▶ に戻る）。Shift+Space：ここで止める（▶ を止めた所へ）
    e.preventDefault();
    if (e.shiftKey) togglePause();
    else togglePlay();
    return;
  }
  if (e.altKey) return;
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    stepListen(k === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    // ▶ を動かす（エディタと同じ：グリッドの1つぶん、Shift で4拍）
    e.preventDefault();
    const s = useEditor.getState();
    const tempo = tempoOf(s.doc);
    const step = e.shiftKey ? frac(4) : gridStep(s.view.div);
    const p = snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
    const nb = Math.max(0, tempo.beatOf(p.m, p.f) + ((k === 'ArrowUp' ? 1 : -1) * step.n) / step.d);
    setCursorBeat(nb);
    if (nb < genViewport.minBeat || nb > genViewport.maxBeat) genShow(nb);
    return;
  }
  if (k === 'Home') {
    e.preventDefault();
    goToStart();
    genShow(0);
    return;
  }
  if (!e.shiftKey && (e.code === 'KeyI' || e.code === 'KeyO')) {
    e.preventDefault();
    setLoopPoint(e.code === 'KeyI' ? 'a' : 'b');
    return;
  }
  if (k === '/' || e.code === 'Slash' || e.code === 'NumpadDivide') {
    e.preventDefault();
    toggleLoop();
  }
}

/** セクションの頭へ ▶ を移す（再生中ならそこから続けて再生） */
function jumpToMeasure(m: number) {
  const b = tempoOf(useEditor.getState().doc).measureStart(m);
  setCursorBeat(b);
  genShow(b);
  if (useEditor.getState().playing) void playFrom(b);
}

const fits = (): { fit: GenFit; label: string; tip: string }[] => [
  { fit: 'all', label: tr('曲全体', 'Whole song'), tip: tr('曲全体を1画面に並べる（密度の違いを見渡す）', 'Fit the whole song on one screen (to compare density at a glance)') },
  { fit: 16, label: tr('16小節', '16 bars'), tip: tr('16小節が画面に収まる大きさ', 'Fit 16 measures on screen') },
  { fit: 8, label: tr('8小節', '8 bars'), tip: tr('8小節が画面に収まる大きさ', 'Fit 8 measures on screen') },
  { fit: 4, label: tr('4小節', '4 bars'), tip: tr('4小節が画面に収まる大きさ', 'Fit 4 measures on screen') },
];

const SHORT: Record<Slot, string> = { MASTER: 'MASTER', EXTREME: 'EXT', ADVANCED: 'ADV', BASIC: 'BSC' };

/** 表示の大きさを変える。曲全体から拡大したときは ▶ の所を見せる */
function chooseFit(fit: GenFit) {
  if (useGen.getState().view.fit === 'all' && fit !== 'all') genShow(useEditor.getState().cursorBeat);
  setGenView({ fit });
}

/** この画面の再生バー（エディタと同じ部品）＋聴く譜面＋表示の大きさ */
function GenTransport() {
  const fit = useGen((s) => s.view.fit);
  const listen = useGen((s) => s.listen);
  const sourceSlot = useGen((s) => s.sourceSlot);
  const masterLabel = useGen((s) => s.masterLabel);
  const choices = useGen((s) => listenChoices(s).join(','));
  const kinds = useGen((s) => SLOTS.map((x) => columnKind(s, x) ?? '').join(',')).split(',');
  return (
    <div className="transport">
      <PlayControls show={genShow} where={tr('並べた譜面の小節番号の列や空いた所', 'the measure-number column or an empty spot in the charts')} />
      <div className="vsep" />
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl" style={{ whiteSpace: 'nowrap' }}>
          {tr('聴く', 'Listen')}
        </span>
        <div className="seg small" role="radiogroup" aria-label={tr('聴く譜面', 'Chart to hear')}>
          {SLOTS.map((x, i) => (
            <button
              key={x}
              role="radio"
              aria-checked={listen === x}
              className={listen === x ? 'on' : ''}
              disabled={!choices.split(',').includes(x)}
              onClick={() => setListen(x)}
              title={
                x === sourceSlot
                  ? tr(`元の譜面（${masterLabel}）を聴く（←→ で切り替え）`, `Hear the original chart (${masterLabel}) (←→ to switch)`)
                  : kinds[i] === 'existing'
                    ? tr(`曲に既にある ${x} を聴く（←→ で切り替え。再生中ならそのまま切り替わります）`, `Hear the ${x} already in the song (←→ to switch; switches right away while playing)`)
                    : tr(`${x} を聴く（←→ で切り替え。再生中ならそのまま切り替わります）`, `Hear ${x} (←→ to switch; switches right away while playing)`)
              }
            >
              {x === sourceSlot && masterLabel !== x ? masterLabel : SHORT[x]}
            </button>
          ))}
        </div>
      </div>
      <div className="vsep" />
      <LoopControls />
      <SpeedControl />
      <div className="vsep" />
      <FollowToggle />
      <span className="grow" />
      <span className="lbl" style={{ whiteSpace: 'nowrap' }}>
        {tr('表示', 'View')}
      </span>
      <div className="seg small" role="radiogroup" aria-label={tr('表示の大きさ', 'Zoom')}>
        {fits().map((f) => (
          <button
            key={String(f.fit)}
            role="radio"
            aria-checked={fit === f.fit}
            className={fit === f.fit ? 'on' : ''}
            onClick={() => chooseFit(f.fit)}
            title={tr(`${f.tip}。Ctrl+ホイールでも拡大・縮小できます`, `${f.tip}. Ctrl+wheel also zooms in and out`)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AiGenPage() {
  const g = useGen();
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.difficulty.model, s.models));
  const costPer = useAi(() => taskCostEstimate('difficulty'));
  const guide = useGuideline((s) => s.guide);
  const charts = useGuideline((s) => s.charts.length);
  const sections = useSidecar((s) => s.sections);
  const tablet = useDevice((s) => s.tablet);
  const detail = useTabletUi((s) => s.genDetail);
  useEffect(() => {
    initGen();
    window.addEventListener('keydown', onGenKey);
    return () => {
      window.removeEventListener('keydown', onGenKey);
      setGenDetail(false);
    };
  }, []);
  const master = g.master;
  const ds = g.diffs[g.selected];
  const feat = useMemo(() => (master ? chartFeatures(master) : null), [master]);
  if (!master || !feat) return null;
  const last = lastMeasure(master);
  const below = belowSource(g);
  const makes = below.filter((d) => g.diffs[d].enabled);
  const anyResult = makes.some((d) => g.diffs[d].result);
  const selKind = columnKind(g, g.selected);
  // 右・下に出すもの：作る難易度（作った・まだ）か、残す既存の譜面か
  const selChart = selKind === 'existing' ? g.charts[g.selected] : undefined;
  const selMade = below.includes(g.selected) && !selChart;
  const fills = selMade ? ds.result?.fills : undefined;
  const same = sameGroups(master);

  return (
    <div className="gen-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={goBack}>
          {Icon.back(14)} {tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        <span className="ai-spark">{Icon.sparkle(15)}</span>
        {/* タブレットは題と説明を2段に */}
        <div className={tablet ? 'tempo-title' : undefined} style={tablet ? undefined : { display: 'contents' }}>
          <h1>{tr('AI難易度生成', 'AI difficulty generator')}</h1>
          <span className={`lbl ellipsis ${tablet ? '' : 'hide-narrow'}`}>
            {master.fields['TITLE'] || tr('無題', 'Untitled')} · {tr('元譜面', 'Source')} {g.masterLabel} Lv {g.masterLevel.toFixed(2)} · {feat.notes.toLocaleString(locale())}
            {tr('ノーツ', ' notes')}
          </span>
        </div>
        <span className="grow" />
        <MasterMixer />
        <span className={`pill ${hasKey ? 'ok' : ''}`} title={hasKey ? tr(`1難易度 約 ${formatUsd(costPer)}＋判定`, `About ${formatUsd(costPer)} per difficulty + level check`) : noKeyTitle()}>
          {hasKey ? `● OpenRouter · ${model}` : tr('キー未設定 · ルールだけで簡略化', 'No API key · rule-based simplification only')}
        </span>
        {selMade && ds.enabled && ds.result && (
          <button className="btn small" onClick={() => void generate(g.selected)} disabled={g.busy || ds.status === 'planning' || ds.status === 'judging'}>
            {tr('この難易度を作り直す', 'Regenerate this difficulty')}
          </button>
        )}
        <button className="btn small primary" onClick={() => void writeOut()} disabled={!anyResult || g.busy} title={tablet ? tr('採用してset.defに書き出す', 'Accept and write to set.def') : undefined}>
          {tablet ? tr('採用して書き出す', 'Accept & write out') : tr('採用してset.defに書き出す', 'Accept and write to set.def')}
        </button>
      </header>
      <GenTransport />
      <div className="gen-body">
        <aside className="gen-left scroll">
          <div className="lbl">{tr('使う基準', 'Reference')}</div>
          <button className="card gen-guide" onClick={() => openPage('guideline')}>
            <span className="gen-doc">{Icon.file(15)}</span>
            <span className="grow" style={{ textAlign: 'left' }}>
              <b>
                {tr('難易度ガイドライン', 'Difficulty guidelines')} v{guide.version}
              </b>
              <span className="lbl" style={{ display: 'block' }}>
                {charts ? tr(`手元 ${charts} 譜面から作成`, `Built from ${charts} local ${pl(charts, 'chart')}`) : tr('まだ集計していません', 'Not compiled yet')}
              </span>
            </span>
            <span className="link-btn">{tr('開く', 'Open')}</span>
          </button>
          <p className="lbl" style={{ margin: '4px 0 12px' }}>
            {tr('目標レベルの帯の基準文と集計をAIに渡します。', "The AI gets the guideline text and stats for the target level's band.")}
          </p>
          <div className="row" style={{ gap: 6 }}>
            <span className="lbl">{tr('曲の難易度と目標レベル', 'Difficulties and target levels')}</span>
            <span className="grow" />
            {g.chartsLoading && <span className="lbl">{tr('曲にある難易度を読んでいます…', 'Reading the song’s charts…')}</span>}
          </div>
          {SLOTS.map((slot) => (
            <SlotCard key={slot} slot={slot} />
          ))}
          {below.length === 0 ? (
            <p className="lbl" style={{ margin: '6px 0 4px' }}>
              {tr(
                `いま開いている譜面（${g.masterLabel}）より下の難易度はありません。上の難易度の譜面を開いてから作ってください。`,
                `There is no difficulty below the open chart (${g.masterLabel}). Open a harder chart to make easier ones from it.`,
              )}
            </p>
          ) : !anyResult ? (
            <button className="btn primary" style={{ width: '100%', margin: '6px 0 4px' }} onClick={() => void generateAll()} disabled={g.busy || g.chartsLoading || makes.length === 0}>
              {Icon.sparkle(14)} {tr('選んだ難易度を作る', 'Generate selected difficulties')}
            </button>
          ) : (
            <button className="btn small" style={{ width: '100%', margin: '6px 0 4px' }} onClick={() => void generateAll()} disabled={g.busy || g.chartsLoading || makes.length === 0}>
              {tr('選んだ難易度をすべて作り直す', 'Regenerate all selected difficulties')}
            </button>
          )}
          {below.length > 0 && makes.length === 0 && !g.chartsLoading && (
            <div className="lbl">
              {tr('作る難易度がありません（曲に既にある譜面を残しています）。作り直すときは、その難易度の「作り直す」を押してください。', 'Nothing to make (the charts already in the song are kept). To remake one, press “Remake” on it.')}
            </div>
          )}
          {!anyResult && hasKey && makes.length > 0 && <div className="lbl">{tr(`1難易度 約 ${formatUsd(costPer)}＋レベル判定`, `About ${formatUsd(costPer)} per difficulty + level check`)}</div>}
          <div className="lbl" style={{ marginTop: 12 }}>
            {tr('必ず残すもの', 'Always keep')}
          </div>
          {keepItems().map((it) => (
            <label key={it.k} className="row gen-check">
              <input type="checkbox" checked={g.keep[it.k]} onChange={(e) => setKeep({ [it.k]: e.target.checked })} />
              {it.label}
            </label>
          ))}
          <div className="lbl" style={{ marginTop: 12 }}>
            {tr('曲の解析結果', 'Song analysis')}
          </div>
          <div className="card gen-facts">
            {master.fields['GENRE'] ? `${master.fields['GENRE']} · ` : ''}
            {Math.round(feat.bpm)} BPM ·{' '}
            {feat.feel === '16'
              ? tr('16ビート中心', 'Mostly 16th-note beat')
              : feat.feel === '8'
                ? tr('8ビート中心', 'Mostly 8th-note beat')
                : feat.feel === '4'
                  ? tr('4分の刻み中心', 'Mostly quarter-note pulse')
                  : tr('刻みは混在', 'Mixed pulse')}
            <br />
            {tr(`セクション ${g.spans.length}`, `${g.spans.length} ${pl(g.spans.length, 'section')}`)}
            {sections.length ? tr('（マーカーから）', ' (from markers)') : tr('（マーカーが無いので8小節ごと）', ' (every 8 measures, since there are no markers)')}
            <br />
            {fills !== undefined ? tr(`フィル ${fills}か所 · `, `${fills} ${pl(fills, 'fill')} · `) : ''}
            {tr(`同じパターンの小節 ${same}組`, `${same} ${pl(same, 'group')} of repeated measures`)}
            <br />
            {tr('要素: ', 'Elements: ')}
            {FEATURE_DEFS.filter((d) => feat.has[d.key])
              .map((d) => d.label)
              .join(tr('、', ', ')) || tr('なし', 'none')}
          </div>
          <div className="lbl" style={{ marginTop: 12 }}>
            {tr('AIへの追加の指示（任意）', 'Extra instructions for the AI (optional)')}
          </div>
          <textarea
            className="field"
            rows={3}
            placeholder={hasKey ? tr('例: サビは元の譜面に近く、Aメロはもっと簡単に', 'e.g. Keep the chorus close to the original and make the verse easier') : noKeyTitle()}
            disabled={!hasKey}
            value={g.instruction}
            onChange={(e) => useGen.setState({ instruction: e.target.value })}
          />
        </aside>
        <main className="gen-main">
          <GenCompare />
          <div className="gen-foot">
            {selMade && ds.result ? (
              <>
                <b className="gen-foot-name">{ds.diff}</b>
                <span>{tr('簡略化の段', 'Simplification step')}</span>
                <b className="mono" style={{ color: 'var(--text)' }}>
                  {ds.result.rung}
                </b>
                <span>/ {MAX_RUNG}</span>
                {ds.result.ease > 0 && <span>{tr(`（4小節のうち${ds.result.ease}小節は次の段）`, `(${ds.result.ease} of every 4 measures use the next step)`)}</span>}
                <button
                  className="btn small ghost"
                  onClick={() => shiftRung(ds.diff, -1)}
                  disabled={ds.result.rung <= 0 && ds.result.ease === 0}
                  title={tr('元の譜面に近づける', 'Closer to the original chart')}
                >
                  {tr('難しく', 'Harder')}
                </button>
                <button className="btn small ghost" onClick={() => shiftRung(ds.diff, 1)} disabled={ds.result.rung >= MAX_RUNG} title={tr('もっと簡単に', 'Make it easier')}>
                  {tr('易しく', 'Easier')}
                </button>
                <span className="ellipsis gen-foot-policy" title={describePolicy(policyFor(ds.result.rung))}>
                  {describePolicy(policyFor(ds.result.rung))}
                </span>
              </>
            ) : (
              <span className="ellipsis gen-foot-policy">
                {selChart
                  ? tr(`${selChart.label} は曲に既にある譜面です（残します）。`, `${selChart.label} is already in the song (kept). `)
                  : anyResult
                  ? tr(`${ds.diff} はまだ作っていません。`, `${ds.diff} hasn't been generated yet. `)
                  : tr('左の「選んだ難易度を作る」で作ると、ここに並びます。', 'Use "Generate selected difficulties" on the left and the results line up here. ')}
                {tablet
                  ? tr('見出しをタップで聴く譜面を切り替え、もう一度タップで判定と方針。', 'Tap a heading to switch the chart you hear; tap it again for rating & plan.')
                  : tr('Space で再生、列の見出しか ←→ で聴く譜面を切り替えます。', 'Space plays; click a column heading or use ←→ to switch the chart you hear.')}
              </span>
            )}
            <span
              className="gen-legend"
              title={tr('作った難易度の列のチップを押すと、残す・削るを手直しできます（白い点が手直ししたチップ）', 'Click chips in a generated column to keep or remove them by hand (a white dot marks chips you changed)')}
            >
              <i className="kept" /> {tr('残した', 'Kept')} <i className="removed" /> {tr('削った', 'Removed')} <i className="moved" /> {tr('移した', 'Moved')}
            </span>
            {tablet && below.length > 0 && (
              <button className={`btn small ${detail ? 'on' : ''}`} onClick={() => setGenDetail((was) => !was)} aria-pressed={detail}>
                {tr('判定と方針', 'Rating & plan')}
              </button>
            )}
          </div>
          {!tablet && <TrackMixStrip />}
        </main>
        <aside className={`gen-right scroll ${tablet ? `t-gen-pop ${detail ? 'open' : ''}` : ''}`} aria-hidden={tablet && !detail ? true : undefined}>
          {tablet && (
            <div className="row t-gen-pop-head">
              <b>{tr('判定と方針', 'Rating & plan')}</b>
              <span className="grow" />
              <button className="ib" onClick={() => setGenDetail(false)} aria-label={tr('閉じる', 'Close')}>
                {Icon.close(16)}
              </button>
            </div>
          )}
          {below.length === 0 ? null : selChart ? <ExistingInfo chart={selChart} /> : <JudgeCard ds={ds} />}
          {selMade && ds.plan && (
            <>
              <div className="row" style={{ gap: 6, margin: '14px 0 6px' }}>
                <b>{tr(`${ds.planSource === 'ai' ? 'AIの方針' : '方針'}（${ds.diff}）`, `${ds.planSource === 'ai' ? "AI's plan" : 'Plan'} (${ds.diff})`)}</b>
                <span className="grow" />
                <span className="lbl">{tr('セクションごと', 'By section')}</span>
              </div>
              {ds.plan.summary && (
                <div className="card gen-plan">
                  <div className="row">
                    <b>{tr('全体', 'Overall')}</b>
                    <span className="grow" />
                    <span className="mono lbl">
                      {toMeasure(0)}-{toMeasure(last)}
                    </span>
                  </div>
                  <div>{ds.plan.summary}</div>
                  {ds.result && ds.result.rung !== DEFAULT_RUNG[ds.diff] && (
                    <div className="lbl" style={{ marginTop: 6 }}>
                      {tr(
                        `方針は段 ${DEFAULT_RUNG[ds.diff]} を基準に書かれています。目標のレベルに合わせて、全体を段 ${ds.result.rung} に変えて作りました（セクションごとの差はそのまま）。`,
                        `The plan was written for step ${DEFAULT_RUNG[ds.diff]}. To hit the target level, the whole chart was built at step ${ds.result.rung} (differences between sections stay the same).`,
                      )}
                    </div>
                  )}
                </div>
              )}
              {ds.plan.sections
                .filter((s) => s.comment || s.shift || s.fill)
                .map((s) => (
                  <button
                    key={s.from}
                    className="card gen-plan"
                    onClick={() => jumpToMeasure(s.from)}
                    title={tr('このセクションの頭に ▶ を置く（再生中ならそこから続けて再生）', 'Put ▶ at the start of this section (keeps playing from there if playing)')}
                  >
                    <div className="row">
                      <b>{s.name}</b>
                      <span className="grow" />
                      <span className="mono lbl">
                        {toMeasure(s.from)}-{toMeasure(s.to)}
                      </span>
                    </div>
                    <div>
                      {s.comment ||
                        [
                          s.shift
                            ? s.shift > 0
                              ? tr(`全体より${s.shift}段やさしく`, `${s.shift} ${pl(s.shift, 'step')} easier than overall`)
                              : tr(`全体より${-s.shift}段元に近く`, `${-s.shift} ${pl(-s.shift, 'step')} closer to the original than overall`)
                            : '',
                          s.fill ? FILL_STYLES[s.fill].label : '',
                        ]
                          .filter(Boolean)
                          .join(tr('。', '. '))}
                    </div>
                  </button>
                ))}
            </>
          )}
          {selMade && <Verdict ds={ds} />}
          <p className="lbl" style={{ marginTop: 12 }}>
            {tr(
              'ノーツの配置はAIではなくルールエンジンが行います。AIは「どこをどう簡略化するか」とレベルの判定だけを担当します。中央の譜面のチップを押すと、残す・削るを手直しできます。',
              'Notes are placed by a rule engine, not the AI. The AI only decides where and how to simplify, and judges the level. Click chips in the charts in the middle to keep or remove them by hand.',
            )}
          </p>
          {!hasKey && (
            <p className="lbl">
              {noKeyTitle()}
              {tr('。いまは標準の方針で、機械的な推定が目標に入るまで段を調整しています。', '. For now, the standard plan is used, and the step is adjusted until the computed estimate reaches the target.')}{' '}
              <button className="link-btn" onClick={() => openSettings('ai')}>
                {tr('キーを設定', 'Set API key')}
              </button>
            </p>
          )}
          {tablet && <p className="lbl t-gen-pop-hint">{tr('見出しをタップで聴く譜面を切り替え、もう一度タップでこの詳細。', 'Tap a heading to switch the chart you hear; tap it again for these details.')}</p>}
        </aside>
      </div>
      {tablet && (
        <div className="t-gen-mix">
          <TrackMixStrip />
        </div>
      )}
    </div>
  );
}

function sameGroups(doc: DtxDoc): number {
  const sig = new Map<string, number>();
  const per = new Map<number, string[]>();
  for (const c of doc.chips) {
    if (!drumChannel(c.ch)) continue;
    let a = per.get(c.m);
    if (!a) per.set(c.m, (a = []));
    a.push(`${c.ch}@${c.f.n}/${c.f.d}`);
  }
  for (const a of per.values()) {
    const k = a.sort().join(',');
    sig.set(k, (sig.get(k) ?? 0) + 1);
  }
  return [...sig.values()].filter((n) => n >= 2).length;
}

/** 左の難易度の並びの1行：元の譜面・曲に既にある譜面・作る難易度・曲に無い難易度 */
function SlotCard({ slot }: { slot: Slot }) {
  const g = useGen();
  if (slot === g.sourceSlot) return <SourceCard />;
  const chart = g.charts[slot];
  const below = belowSource(g).includes(slot as Difficulty);
  if (!below) return chart ? <ExistingCard chart={chart} on={false} canRemake={false} /> : <MissingRow slot={slot} />;
  const d = slot as Difficulty;
  if (chart && !g.diffs[d].enabled) return <ExistingCard chart={chart} on={g.selected === d} canRemake />;
  return <DiffCard ds={g.diffs[d]} on={g.selected === d} />;
}

/** いま開いている譜面（ここから下の難易度を作る） */
function SourceCard() {
  const master = useGen((s) => s.master);
  const label = useGen((s) => s.masterLabel);
  const level = useGen((s) => s.masterLevel);
  const file = useGen((s) => s.masterFile);
  const slot = useGen((s) => s.sourceSlot);
  const origin = useMemo(() => (master ? originOf(master) : 'human'), [master]);
  return (
    <div
      className="card gen-diff gen-slot"
      onClick={() => setListen(slot)}
      role="button"
      tabIndex={0}
      title={tr('いま開いている譜面。これより下の難易度を作ります（押すとこの譜面を聴きます）', 'The chart you have open. Easier difficulties are made from it (click to hear it)')}
    >
      <div className="row" style={{ gap: 8 }}>
        <span className="gen-slot-pad" />
        <b>{label}</b>
        <span className="lbl">{tr('元の譜面', 'Original')}</span>
        {origin !== 'human' && <OriginBadge origin={origin} />}
        <span className="grow" />
        <b className="mono">{level.toFixed(2)}</b>
      </div>
      <div className="row lbl gen-diff-line">
        <span className="ellipsis">{file}</span>
      </div>
    </div>
  );
}

/** 曲に既にある譜面（作者の譜面・前に作った譜面）。元の譜面より下なら作り直せる */
function ExistingCard({ chart, on, canRemake }: { chart: ExistingChart; on: boolean; canRemake: boolean }) {
  return (
    <div
      className={`card gen-diff gen-slot existing ${on ? 'on' : ''}`}
      onClick={() => setListen(chart.slot)}
      role="button"
      tabIndex={0}
      title={tr(`${originTitle(chart.origin)}。押すとこの譜面を聴きます`, `${originTitle(chart.origin)}. Click to hear it`)}
    >
      <div className="row" style={{ gap: 8 }}>
        <span className="gen-slot-pad" />
        <b className="ellipsis">{chart.label}</b>
        <OriginBadge origin={chart.origin} />
        <span className="grow" />
        <b className="mono" title={chart.registered ? tr('登録レベル（#DLEVEL）', 'Listed level (#DLEVEL)') : tr('登録レベルが無いので計算のめやす', 'No listed level, so this is a computed estimate')}>
          {chart.registered ? '' : '≈'}
          {chart.level.toFixed(2)}
        </b>
      </div>
      <div className="row lbl gen-diff-line">
        <span className="ellipsis">{chart.file}</span>
        <span className="grow" />
        <span>{tr('残す', 'Kept')}</span>
        {canRemake && (
          <button
            className="link-btn"
            onClick={(e) => {
              e.stopPropagation();
              remake(chart.slot as Difficulty);
            }}
            title={tr('この難易度も作り直す（書き出すまで、曲フォルダの譜面は変わりません）', 'Make this difficulty again too (the chart in the song folder stays as it is until you write out)')}
          >
            {tr('作り直す', 'Remake')}
          </button>
        )}
      </div>
    </div>
  );
}

/** 曲に既にある譜面を作り直すことにする（右の判定・方針もその難易度に） */
function remake(d: Difficulty) {
  setEnabled(d, true);
  selectDiff(d);
}

/** 元の譜面より上で、曲に無い難易度 */
function MissingRow({ slot }: { slot: Slot }) {
  return (
    <div className="row lbl gen-slot-missing">
      <span className="gen-slot-pad" />
      <b>{slot}</b>
      <span>{tr('曲にありません', 'Not in the song')}</span>
    </div>
  );
}

/** 目標の幅の決め方（カードの説明） */
function bandTitle(g: GenState, ds: DiffState): string {
  const t = ds.target;
  const parts = [
    tr(
      `目標の幅 Lv ${t.min.toFixed(2)}〜${t.max.toFixed(2)}（めやす ${t.center.toFixed(2)} の ±1。この中なら合格。作るときはめやすの近くを狙います）`,
      `Target range Lv ${t.min.toFixed(2)}–${t.max.toFixed(2)} (aim ${t.center.toFixed(2)} ±1; anything inside passes, and generation aims near the aim)`,
    ),
  ];
  if (ds.manual !== null) parts.push(tr('めやすは手で決めた値です', 'The aim was set by hand'));
  const known = knownLevels(g);
  const capText = (c: NonNullable<typeof t.capAbove>, up: boolean) => {
    const name = slotLabel(g, c.slot);
    const lv = known[c.slot];
    return c.known && lv !== undefined
      ? tr(`${up ? '上' : '下'}は ${name}（Lv ${lv.toFixed(2)}）から 0.3 離しています`, `The ${up ? 'upper' : 'lower'} end stays 0.3 away from ${name} (Lv ${lv.toFixed(2)})`)
      : tr(`${up ? '上' : '下'}は ${name} のめやすとの真ん中で分けています`, `The ${up ? 'upper' : 'lower'} end is halfway to ${name}'s aim`);
  };
  if (t.capAbove) parts.push(capText(t.capAbove, true));
  if (t.capBelow) parts.push(capText(t.capBelow, false));
  if (t.raised >= 0.05)
    parts.push(
      tr(
        `速い・密な曲なので +${t.raised.toFixed(2)} 底上げしています（いちばん易しい段まで間引いても、これより下がらないため）`,
        `Raised by +${t.raised.toFixed(2)}: this song is fast or dense, so even the easiest step can't get lower`,
      ),
    );
  return parts.join('\n');
}

/** 作る難易度（曲に既にある譜面を作り直すときも） */
function DiffCard({ ds, on }: { ds: DiffState; on: boolean }) {
  const g = useGen();
  const chart = g.charts[ds.diff];
  const src = sourceFor(g, ds.diff);
  const busy = ds.status === 'planning' || ds.status === 'building' || ds.status === 'judging';
  const pass = isPassing(ds);
  const lv = ds.result ? shownLevel(ds) : null;
  const t = ds.target;
  // 作ったあとで作る元が変わった（上の既存の譜面を作り直す・残すに変えた）
  const srcChanged = !!ds.result && !!ds.src && !!src && ds.src.doc !== src.doc;
  return (
    <div className={`card gen-diff ${on ? 'on' : ''} ${ds.enabled ? '' : 'off'}`} onClick={() => selectDiff(ds.diff)} role="button" tabIndex={0}>
      <div className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={ds.enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEnabled(ds.diff, e.target.checked)}
          title={chart ? tr('チェックを外すと、曲に既にある譜面を残します', 'Uncheck to keep the chart already in the song') : tr('この難易度を作る', 'Make this difficulty')}
        />
        <b>{ds.diff}</b>
        {chart && <span className="lbl">{tr('作り直し', 'Remake')}</span>}
        <span className="grow" />
        {lv !== null && (
          <>
            <span className="lbl">{ds.judge && !ds.judgeStale ? tr('AI判定', 'AI') : tr('計算', 'Calc')}</span>
            <b className="mono">{lv.toFixed(2)}</b>
          </>
        )}
      </div>
      {ds.enabled && (
        <>
          <div className="row lbl gen-diff-line wrap" title={bandTitle(g, ds)}>
            <span>{tr('目標', 'Target')}</span>
            <b className="mono gen-band">
              {t.min.toFixed(2)}–{t.max.toFixed(2)}
            </b>
            <span className="row gen-aim">
              <span>{tr('めやす', 'Aim')}</span>
              <input
                className="gen-target mono"
                type="number"
                step={0.1}
                min={1}
                max={9.9}
                value={t.center.toFixed(1)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setTarget(ds.diff, e.target.value === '' ? null : Number(e.target.value))}
                title={tr('めやすを手で決める（幅はその ±1。隣の難易度とは重ねません）', 'Set the aim by hand (the range is ±1 around it and never overlaps the neighbors)')}
              />
              {ds.manual !== null && (
                <button
                  className="link-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTarget(ds.diff, null);
                  }}
                  title={tr('自動のめやすに戻す', 'Back to the automatic aim')}
                >
                  {tr('自動', 'Auto')}
                </button>
              )}
            </span>
          </div>
          {t.raised >= 0.05 && (
            <div className="lbl gen-diff-line gen-diff-note gen-raised" title={bandTitle(g, ds)}>
              {tr(`速い・密な曲なので +${t.raised.toFixed(2)} 底上げ`, `Raised +${t.raised.toFixed(2)} for a fast or dense song`)}
            </div>
          )}
          {src && src.slot !== g.sourceSlot && (
            <div className="lbl gen-diff-line gen-diff-note">
              {tr(`元: ${slotLabel(g, src.slot)}（既存・Lv ${src.level.toFixed(2)}）`, `From: ${slotLabel(g, src.slot)} (existing, Lv ${src.level.toFixed(2)})`)}
            </div>
          )}
          {chart && (
            <div className="lbl gen-diff-line gen-diff-note">
              {tr(`曲にある ${chart.label}（Lv ${chart.level.toFixed(2)}）と置き換え`, `Replaces the song’s ${chart.label} (Lv ${chart.level.toFixed(2)})`)}
            </div>
          )}
        </>
      )}
      <div className="row lbl gen-diff-line">
        {busy ? (
          <span>
            {ds.status === 'planning'
              ? tr('AIが方針を考えています…', 'The AI is planning…')
              : ds.status === 'judging'
                ? tr('AIがレベルを判定しています…', 'The AI is judging the level…')
                : tr('作っています…', 'Generating…')}
          </span>
        ) : !ds.enabled ? (
          <span>{tr('作らない（書き出しません）', 'Not made (not written out)')}</span>
        ) : ds.result ? (
          pass ? (
            <span style={{ color: 'var(--ok)' }}>{tr('✓ 検証OK', '✓ Checks passed')}</span>
          ) : (
            <span style={{ color: 'var(--amber)' }}>
              {tr(`! 要確認（${ds.issues ? `叩けない所 ${ds.issues}` : '目標の幅から外れ'}）`, `! Needs review (${ds.issues ? `${ds.issues} unplayable` : 'outside the target range'})`)}
            </span>
          )
        ) : ds.status === 'error' ? (
          <span style={{ color: 'var(--danger)' }}>{tr('失敗しました', 'Failed')}</span>
        ) : (
          <span>{tr('まだ作っていません', 'Not generated yet')}</span>
        )}
      </div>
      {srcChanged && ds.enabled && (
        <div className="lbl gen-diff-line gen-diff-note" style={{ color: 'var(--amber)' }}>
          {tr('作る元の譜面が変わりました。作り直すと反映されます', 'The chart it is made from has changed. Regenerate to use it')}
        </div>
      )}
    </div>
  );
}

/** 右：残す既存の譜面を選んでいるとき */
function ExistingInfo({ chart }: { chart: ExistingChart }) {
  const g = useGen();
  const below = belowSource(g);
  const canRemake = below.includes(chart.slot as Difficulty);
  // この譜面から作る難易度（次の残す譜面まで）
  const from = below.filter((d) => g.diffs[d].enabled && sourceFor(g, d)?.slot === chart.slot);
  return (
    <div className="card gen-judge">
      <div className="row" style={{ gap: 6 }}>
        <b>{chart.label}</b>
        <OriginBadge origin={chart.origin} />
        <span className="grow" />
        <span className="gen-lv mono">{chart.level.toFixed(2)}</span>
      </div>
      <div className="lbl">
        {chart.file} · {chart.registered ? tr('登録レベル（#DLEVEL）', 'listed level (#DLEVEL)') : tr('登録レベルが無いので計算のめやす', 'no listed level, so a computed estimate')}
      </div>
      <div>
        {tr(`${originTitle(chart.origin)}です。曲フォルダの譜面はそのまま残します。`, `${originTitle(chart.origin)}. The chart in the song folder stays as it is.`)}
        {from.length > 0 &&
          tr(
            ` ${from.join('・')} はこの譜面から作ります（上の難易度からはみ出さないように）。`,
            ` ${from.join(' and ')} ${from.length === 1 ? 'is' : 'are'} made from this chart (so they never go beyond it).`,
          )}
      </div>
      {canRemake && (
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => remake(chart.slot as Difficulty)}>
          {tr('この難易度も作り直す', 'Remake this difficulty too')}
        </button>
      )}
    </div>
  );
}

function inRange(lv: number, t: { min: number; max: number }) {
  return lv >= t.min - 1e-9 && lv <= t.max + 1e-9;
}

function JudgeCard({ ds }: { ds: DiffState }) {
  const hasKey = useHasAiKey();
  const openCalib = useGen((s) => s.calib);
  const label = useGen((s) => (ds.src ? slotLabel(s, ds.src.slot) : s.masterLabel));
  const calib = ds.src?.calib ?? openCalib;
  const calc = calcLevel(ds);
  const j = ds.judge;
  const r = ds.result;
  if (!r) return <div className="card gen-judge lbl">{tr('作るとここにレベルの判定が出ます。', 'The level check appears here after you generate.')}</div>;
  if (!j)
    return (
      <div className="card gen-judge">
        <div className="row">
          <b>{hasKey ? tr('レベル（計算）', 'Level (calculated)') : tr('レベル（機械的な推定）', 'Level (computed estimate)')}</b>
          <span className="grow" />
          {ds.status === 'judging' && <span className="lbl">{tr('AIが判定中…', 'AI is judging…')}</span>}
        </div>
        <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
          <span className="gen-lv mono">{calc.toFixed(2)}</span>
          <span className="lbl mono">
            {tr('目標', 'Target')} {ds.target.min.toFixed(2)}–{ds.target.max.toFixed(2)}
          </span>
        </div>
        <div className="lbl">
          {tr('試した段: ', 'Steps tried: ')}
          {r.tries.map((t) => `${t.rung}${t.ease ? `+${t.ease}/4` : ''}→${(t.level * calib).toFixed(2)}`).join(tr('、', ', '))}
        </div>
        {Math.abs(calib - 1) > 0.02 && (
          <div className="lbl">
            {tr(`作る元の譜面（${label}）の登録レベルに合わせて、機械的な推定を ×${calib.toFixed(2)} しています。`, `The computed estimate is scaled ×${calib.toFixed(2)} to match the listed level of the chart it is made from (${label}).`)}
          </div>
        )}
      </div>
    );
  return (
    <div className="card gen-judge ai">
      <div className="row" style={{ gap: 6 }}>
        <span className="ai-spark">{Icon.sparkle(13)}</span>
        <b>{tr('AIのレベル判定', "AI's level check")}</b>
        <span className="grow" />
        <span className={`ai-conf ${j.confidence}`}>
          {j.confidence === 'high' ? tr('自信度 高', 'High confidence') : j.confidence === 'medium' ? tr('自信度 中', 'Medium confidence') : tr('自信度 低', 'Low confidence')}
        </span>
      </div>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span className="gen-lv mono">{j.level.toFixed(2)}</span>
        <span className="lbl mono">
          {tr('目標', 'Target')} {ds.target.min.toFixed(2)}–{ds.target.max.toFixed(2)} · {tr('計算', 'Calc')} {calc.toFixed(2)}
        </span>
      </div>
      <ul className="ai-reasons">
        {j.reasons.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
        {j.hardest && (
          <li>
            {tr('難所: ', 'Hardest part: ')}
            {j.hardest}
          </li>
        )}
      </ul>
      {ds.judgeStale && (
        <div className="lbl" style={{ color: 'var(--amber)' }}>
          {tr('判定のあとに手直ししました。書き出しのレベルは計算の値を使います。', 'You edited it after the check. The exported level uses the calculated value.')}
        </div>
      )}
      <div className="lbl">
        {tr('この難易度の費用', 'Cost for this difficulty')} {formatUsd(ds.cost)}
      </div>
    </div>
  );
}

function Verdict({ ds }: { ds: DiffState }) {
  const r = ds.result;
  if (!r) return null;
  const ok = inRange(shownLevel(ds), ds.target);
  const msgs: string[] = [];
  msgs.push(
    tr(
      `${ds.judge && !ds.judgeStale ? `AI判定 ${ds.judge.level.toFixed(2)}・` : ''}計算 ${calcLevel(ds).toFixed(2)}（目標の幅 ${ds.target.min.toFixed(2)}–${ds.target.max.toFixed(2)}、めやす ${ds.target.center.toFixed(2)}）`,
      `${ds.judge && !ds.judgeStale ? `AI check ${ds.judge.level.toFixed(2)}, ` : ''}calculated ${calcLevel(ds).toFixed(2)} (target range ${ds.target.min.toFixed(2)}–${ds.target.max.toFixed(2)}, aim ${ds.target.center.toFixed(2)})`,
    ),
  );
  if (ds.issues)
    msgs.push(
      tr(
        `叩けない組み合わせが ${ds.issues} か所あります（作ったあとエディタの「確かめる」で直せます）`,
        `There ${ds.issues === 1 ? 'is 1 unplayable combination' : `are ${ds.issues} unplayable combinations`} (fix them later with "Check" in the editor)`,
      ),
    );
  else msgs.push(tr('手足で叩けない組み合わせ、同じレーンの詰まりすぎはありません', 'No combinations that hands and feet can\'t play, and no lanes that are too crowded'));
  const pass = ok && ds.issues === 0;
  return (
    <div className={`card gen-verdict ${pass ? 'ok' : 'warn'}`}>
      <b>{pass ? tr('✓ 検証を通過', '✓ Passed the checks') : tr('! 確認してください', '! Please review')}</b>
      <div>{tr(`${msgs.join('。')}。`, `${msgs.join('. ')}.`)}</div>
      {!ok &&
        (r.rung >= MAX_RUNG && shownLevel(ds) > ds.target.max ? (
          <div className="lbl">
            {tr(
              'いちばん簡単な段でも目標より高く出ました。人が作る BASIC でもこのくらいの曲はあります。このままでよければ書き出し、もっと下げたいときは中央の譜面のチップを押して削ってください。',
              "Even the easiest step came out above the target. Hand-made BASIC charts can be this hard for some songs too. Export it if that's fine, or click chips in the middle charts to remove more.",
            )}
          </div>
        ) : (
          <div className="lbl">{tr('目標の幅から外れています。「易しく／難しく」で段を動かすか、めやすを変えて作り直してください。', 'This is outside the target range. Change the step with "Easier/Harder", or change the aim and regenerate.')}</div>
        ))}
    </div>
  );
}
