// AI難易度生成の画面：難易度ごとの生成、元の譜面と作った難易度を曲全体で並べて聴き比べる（押して手直し）、
// AI のレベル判定と方針、set.def への書き出し。再生の操作はエディタと同じ（Space・Shift+Space・▶・ループ・速さ）。
import { tr, pl, locale } from '../i18n';
import { useEffect, useMemo } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { drumChannel, type DtxDoc } from '../dtx/model';
import { gridStep, snapToGrid } from '../edit/ops';
import { chartFeatures, FEATURE_DEFS, lastMeasure } from '../gen/features';
import { DEFAULT_RUNG, describePolicy, DIFFICULTIES, FILL_STYLES, MAX_RUNG, policyFor } from '../gen/simplify';
import { setLoopPoint, toggleLoop } from '../store/assist';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { tempoOf } from '../store/derived';
import { goBack, goToStart, openPage, openSettings, playFrom, setCursorBeat, togglePause, togglePlay, useEditor } from '../store/editor';
import {
  calcLevel,
  generate,
  generateAll,
  genShow,
  initGen,
  isPassing,
  listenChoices,
  selectDiff,
  setGenView,
  setKeep,
  setListen,
  setTarget,
  shiftRung,
  shownLevel,
  stepListen,
  useGen,
  writeOut,
  type DiffState,
  type GenFit,
  type Listen,
} from '../store/gen';
import { useGuideline } from '../store/guideline';
import { useSidecar } from '../store/sidecar';
import { genViewport, GenCompare } from './GenCompare';
import { Icon } from './icons';
import { MasterMixer, TrackMixStrip } from './MixPanel';
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

const SHORT: Record<Listen, string> = { MASTER: 'MASTER', EXTREME: 'EXT', ADVANCED: 'ADV', BASIC: 'BSC' };

/** 表示の大きさを変える。曲全体から拡大したときは ▶ の所を見せる */
function chooseFit(fit: GenFit) {
  if (useGen.getState().view.fit === 'all' && fit !== 'all') genShow(useEditor.getState().cursorBeat);
  setGenView({ fit });
}

/** この画面の再生バー（エディタと同じ部品）＋聴く譜面＋表示の大きさ */
function GenTransport() {
  const fit = useGen((s) => s.view.fit);
  const listen = useGen((s) => s.listen);
  const masterLabel = useGen((s) => s.masterLabel);
  const choices = useGen((s) => listenChoices(s).join(','));
  return (
    <div className="transport">
      <PlayControls show={genShow} where={tr('並べた譜面の小節番号の列や空いた所', 'the measure-number column or an empty spot in the charts')} />
      <div className="vsep" />
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl" style={{ whiteSpace: 'nowrap' }}>
          {tr('聴く', 'Listen')}
        </span>
        <div className="seg small" role="radiogroup" aria-label={tr('聴く譜面', 'Chart to hear')}>
          {(['MASTER', ...DIFFICULTIES] as Listen[]).map((x) => (
            <button
              key={x}
              role="radio"
              aria-checked={listen === x}
              className={listen === x ? 'on' : ''}
              disabled={!choices.split(',').includes(x)}
              onClick={() => setListen(x)}
              title={
                x === 'MASTER'
                  ? tr(`元の譜面（${masterLabel}）を聴く（←）`, `Hear the original chart (${masterLabel}) (←)`)
                  : tr(`${x} を聴く（←→ で切り替え。再生中ならそのまま切り替わります）`, `Hear ${x} (←→ to switch; switches right away while playing)`)
              }
            >
              {x === 'MASTER' ? masterLabel : SHORT[x]}
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
  useEffect(() => {
    initGen();
    window.addEventListener('keydown', onGenKey);
    return () => window.removeEventListener('keydown', onGenKey);
  }, []);
  const master = g.master;
  const ds = g.diffs[g.selected];
  const feat = useMemo(() => (master ? chartFeatures(master) : null), [master]);
  if (!master || !feat) return null;
  const last = lastMeasure(master);
  const anyResult = DIFFICULTIES.some((d) => g.diffs[d].result);
  const enabledCount = DIFFICULTIES.filter((d) => g.diffs[d].enabled).length;
  const fills = ds.result?.fills;
  const same = sameGroups(master);

  return (
    <div className="gen-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={goBack}>
          {Icon.back(14)} {tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        <span className="ai-spark">{Icon.sparkle(15)}</span>
        <h1>{tr('AI難易度生成', 'AI difficulty generator')}</h1>
        <span className="lbl ellipsis hide-narrow">
          {master.fields['TITLE'] || tr('無題', 'Untitled')} · {tr('元譜面', 'Source')} {g.masterLabel} Lv {g.masterLevel.toFixed(2)} · {feat.notes.toLocaleString(locale())}
          {tr('ノーツ', ' notes')}
        </span>
        <span className="grow" />
        <MasterMixer />
        <span className={`pill ${hasKey ? 'ok' : ''}`} title={hasKey ? tr(`1難易度 約 ${formatUsd(costPer)}＋判定`, `About ${formatUsd(costPer)} per difficulty + level check`) : noKeyTitle()}>
          {hasKey ? `● OpenRouter · ${model}` : tr('キー未設定 · ルールだけで簡略化', 'No API key · rule-based simplification only')}
        </span>
        {anyResult && (
          <button className="btn small" onClick={() => void generate(g.selected)} disabled={g.busy || ds.status === 'planning' || ds.status === 'judging'}>
            {tr('この難易度を作り直す', 'Regenerate this difficulty')}
          </button>
        )}
        <button className="btn small primary" onClick={() => void writeOut()} disabled={!anyResult || g.busy}>
          {tr('採用してset.defに書き出す', 'Accept and write to set.def')}
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
          <div className="lbl">{tr('作る難易度と目標レベル', 'Difficulties and target levels')}</div>
          {DIFFICULTIES.map((d) => (
            <DiffCard key={d} ds={g.diffs[d]} on={g.selected === d} />
          ))}
          {!anyResult && (
            <button className="btn primary" style={{ width: '100%', margin: '6px 0 4px' }} onClick={() => void generateAll()} disabled={g.busy || enabledCount === 0}>
              {Icon.sparkle(14)} {tr('選んだ難易度を作る', 'Generate selected difficulties')}
            </button>
          )}
          {!anyResult && hasKey && <div className="lbl">{tr(`1難易度 約 ${formatUsd(costPer)}＋レベル判定`, `About ${formatUsd(costPer)} per difficulty + level check`)}</div>}
          {anyResult && (
            <button className="btn small" style={{ width: '100%', margin: '6px 0 4px' }} onClick={() => void generateAll()} disabled={g.busy || enabledCount === 0}>
              {tr('選んだ難易度をすべて作り直す', 'Regenerate all selected difficulties')}
            </button>
          )}
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
            {ds.result ? (
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
                {anyResult
                  ? tr(`${ds.diff} はまだ作っていません。`, `${ds.diff} hasn't been generated yet. `)
                  : tr('左の「選んだ難易度を作る」で作ると、ここに並びます。', 'Use "Generate selected difficulties" on the left and the results line up here. ')}
                {tr('Space で再生、列の見出しか ←→ で聴く譜面を切り替えます。', 'Space plays; click a column heading or use ←→ to switch the chart you hear.')}
              </span>
            )}
            <span
              className="gen-legend"
              title={tr('作った難易度の列のチップを押すと、残す・削るを手直しできます（白い点が手直ししたチップ）', 'Click chips in a generated column to keep or remove them by hand (a white dot marks chips you changed)')}
            >
              <i className="kept" /> {tr('残した', 'Kept')} <i className="removed" /> {tr('削った', 'Removed')} <i className="moved" /> {tr('移した', 'Moved')}
            </span>
          </div>
          <TrackMixStrip />
        </main>
        <aside className="gen-right scroll">
          <JudgeCard ds={ds} />
          {ds.plan && (
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
          <Verdict ds={ds} />
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
        </aside>
      </div>
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

function DiffCard({ ds, on }: { ds: DiffState; on: boolean }) {
  const calib = useGen((s) => s.calib);
  const busy = ds.status === 'planning' || ds.status === 'building' || ds.status === 'judging';
  const pass = isPassing(ds, calib);
  const lv = ds.result ? shownLevel(ds, calib) : null;
  return (
    <div className={`card gen-diff ${on ? 'on' : ''}`} onClick={() => selectDiff(ds.diff)} role="button" tabIndex={0}>
      <div className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={ds.enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => useGen.setState((s) => ({ diffs: { ...s.diffs, [ds.diff]: { ...s.diffs[ds.diff], enabled: e.target.checked } } }))}
        />
        <b>{ds.diff}</b>
        <span className="grow" />
        {lv !== null && (
          <>
            <span className="lbl">{ds.judge && !ds.judgeStale ? 'AI' : tr('計算', 'Calc')}</span>
            <b className="mono">{lv.toFixed(2)}</b>
          </>
        )}
      </div>
      <div className="row lbl gen-diff-line">
        <span>{tr('目標', 'Target')}</span>
        <input
          className="gen-target mono"
          type="number"
          step={0.1}
          value={ds.target.center.toFixed(1)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setTarget(ds.diff, Number(e.target.value))}
        />
        <span className="mono">
          {ds.target.min.toFixed(2)}–{ds.target.max.toFixed(2)}
        </span>
      </div>
      <div className="row lbl gen-diff-line">
        {busy ? (
          <span>
            {ds.status === 'planning'
              ? tr('AIが方針を考えています…', 'The AI is planning…')
              : ds.status === 'judging'
                ? tr('AIがレベルを判定しています…', 'The AI is judging the level…')
                : tr('作っています…', 'Generating…')}
          </span>
        ) : ds.result ? (
          pass ? (
            <span style={{ color: 'var(--ok)' }}>{tr('✓ 検証OK', '✓ Checks passed')}</span>
          ) : (
            <span style={{ color: 'var(--amber)' }}>
              {tr(`! 要確認（${ds.issues ? `叩けない所 ${ds.issues}` : '目標から外れ'}）`, `! Needs review (${ds.issues ? `${ds.issues} unplayable` : 'off target'})`)}
            </span>
          )
        ) : ds.status === 'error' ? (
          <span style={{ color: 'var(--danger)' }}>{tr('失敗しました', 'Failed')}</span>
        ) : (
          <span>{tr('まだ作っていません', 'Not generated yet')}</span>
        )}
      </div>
    </div>
  );
}

function inRange(lv: number, t: { min: number; max: number }) {
  return lv >= t.min - 1e-9 && lv <= t.max + 1e-9;
}

function JudgeCard({ ds }: { ds: DiffState }) {
  const hasKey = useHasAiKey();
  const calib = useGen((s) => s.calib);
  const calc = calcLevel(ds, calib);
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
            {tr('目標', 'Target')} {ds.target.min.toFixed(2)}-{ds.target.max.toFixed(2)}
          </span>
        </div>
        <div className="lbl">
          {tr('試した段: ', 'Steps tried: ')}
          {r.tries.map((t) => `${t.rung}${t.ease ? `+${t.ease}/4` : ''}→${(t.level * calib).toFixed(2)}`).join(tr('、', ', '))}
        </div>
        {Math.abs(calib - 1) > 0.02 && (
          <div className="lbl">
            {tr(`元譜面の登録レベルに合わせて、機械的な推定を ×${calib.toFixed(2)} しています。`, `The computed estimate is scaled ×${calib.toFixed(2)} to match the source chart's listed level.`)}
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
          {tr('目標', 'Target')} {ds.target.min.toFixed(2)}-{ds.target.max.toFixed(2)} · {tr('計算', 'Calc')} {calc.toFixed(2)}
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
  const calib = useGen((s) => s.calib);
  const r = ds.result;
  if (!r) return null;
  const ok = inRange(shownLevel(ds, calib), ds.target);
  const msgs: string[] = [];
  msgs.push(
    tr(
      `${ds.judge && !ds.judgeStale ? `AI判定 ${ds.judge.level.toFixed(2)}・` : ''}計算 ${calcLevel(ds, calib).toFixed(2)}（目標 ${ds.target.min.toFixed(2)}–${ds.target.max.toFixed(2)}）`,
      `${ds.judge && !ds.judgeStale ? `AI check ${ds.judge.level.toFixed(2)}, ` : ''}calculated ${calcLevel(ds, calib).toFixed(2)} (target ${ds.target.min.toFixed(2)}–${ds.target.max.toFixed(2)})`,
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
        (r.rung >= MAX_RUNG && shownLevel(ds, calib) > ds.target.max ? (
          <div className="lbl">
            {tr(
              'いちばん簡単な段でも目標より高く出ました。人が作る BASIC でもこのくらいの曲はあります。このままでよければ書き出し、もっと下げたいときは中央の譜面のチップを押して削ってください。',
              "Even the easiest step came out above the target. Hand-made BASIC charts can be this hard for some songs too. Export it if that's fine, or click chips in the middle charts to remove more.",
            )}
          </div>
        ) : (
          <div className="lbl">{tr('目標から外れています。「易しく／難しく」で段を動かすか、目標を変えて作り直してください。', 'This is off target. Change the step with "Easier/Harder", or change the target and regenerate.')}</div>
        ))}
    </div>
  );
}
