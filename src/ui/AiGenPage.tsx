// AI難易度生成の画面：曲の難易度（元の譜面・曲に既にある譜面・作る難易度）と目標の幅、難易度ごとの生成、
// 曲全体で並べて聴き比べる（押して手直し）、AI のレベル判定と方針、エディタへの反映（曲フォルダに譜面を書き set.def に載せる）。
// 再生の操作はエディタと同じ（Space・Shift+Space・▶・ループ・速さ）。
import { tr, pl, locale } from '../i18n';
import { useEffect, useMemo, useState } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { drumChannel, type DtxDoc } from '../dtx/model';
import { gridStep, snapToGrid } from '../edit/ops';
import { chartFeatures, FEATURE_DEFS, lastMeasure } from '../gen/features';
import { describeEase, describePolicy, MAX_RUNG, policyFor, type Difficulty } from '../gen/simplify';
import { measureList, STEP_GAP } from '../gen/stairs';
import { MAX_DROP, SLOTS, type Slot } from '../gen/targets';
import { originOf } from '../dtx/origin';
import { setLoopPoint, toggleLoop } from '../store/assist';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { tempoOf } from '../store/derived';
import { goToStart, openPage, openSettings, playFrom, setCursorBeat, togglePause, togglePlay, useEditor } from '../store/editor';
import {
  belowSource,
  calcLevel,
  columnKind,
  generate,
  generateAll,
  genShow,
  initGen,
  insertedSlots,
  isPassing,
  knownCalcs,
  knownLevels,
  leaveGen,
  listenChoices,
  moveDown,
  moveSourceDown,
  offeredMove,
  pendingMoveTo,
  reflectState,
  selectDiff,
  setEnabled,
  setGenView,
  setKeep,
  setListen,
  setTarget,
  shiftRung,
  slotLabel,
  sourceFor,
  sourceShift,
  stairIssues,
  stepListen,
  undoableMove,
  undoMove,
  unreflected,
  useGen,
  writeOut,
  type DiffState,
  type ExistingChart,
  type GenFit,
  type GenState,
  type StairIssues,
} from '../store/gen';
import { useGuideline, useRuler } from '../store/guideline';
import { useSidecar } from '../store/sidecar';
import { useDevice } from '../store/device';
import { genViewport, GenCompare } from './GenCompare';
import { setGenDetail, useTabletUi } from './tablet/shared';
import { Icon } from './icons';
import { MasterMixer, TrackMixStrip } from './MixPanel';
import { OriginBadge, originTitle } from './OriginBadge';
import { FollowToggle, LoopControls, PlayControls, SpeedControl } from './Transport';
import { PlayButtons } from './phone/PhoneEditor';
import { AimStepper, TargetStrip } from './phone/PhoneGen';
import { PosBox, VolumeButton } from './phone/PhoneParts';

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
    // ミックスの小窓が開いているときは、小窓を閉じるだけ（エディタには戻らない）。
    // 作った難易度をまだ反映していなければ、反映するか聞いてから戻る
    if (!document.querySelector('.mix-pop')) void leaveGen();
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

/** スマホ：再生・位置・聴く譜面・音量（承認されたデザインの AI 難易度生成のとおり） */
function PhoneGenTransport() {
  const listen = useGen((s) => s.listen);
  const choices = useGen((s) => listenChoices(s).join(','));
  return (
    <div className="pg-transport">
      <PlayButtons />
      <PosBox />
      <div className="p-seg pg-listen" role="radiogroup" aria-label={tr('聴く譜面', 'Chart to hear')}>
        {SLOTS.map((x) => (
          <button key={x} role="radio" aria-checked={listen === x} className={listen === x ? 'on' : ''} disabled={!choices.split(',').includes(x)} onClick={() => setListen(x)}>
            {SHORT_SLOT[x]}
          </button>
        ))}
      </div>
      <span className="grow" />
      <VolumeButton dir="up-end" />
    </div>
  );
}

const SHORT_SLOT: Record<Slot, string> = { MASTER: 'MAS', EXTREME: 'EXT', ADVANCED: 'ADV', BASIC: 'BSC' };

export function AiGenPage() {
  const g = useGen();
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.difficulty.model, s.models));
  const costPer = useAi(() => taskCostEstimate('difficulty'));
  const guide = useGuideline((s) => s.guide);
  const ruler = useRuler();
  const sections = useSidecar((s) => s.sections);
  const tablet = useDevice((s) => s.tablet);
  const phone = useDevice((s) => s.phone);
  const portrait = useDevice((s) => s.portrait);
  // スマホの縦：1 つずつ大きく見せる。作る設定は下からのシート
  const one = phone && portrait;
  const [setup, setSetup] = useState(false);
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
  // エディタにまだ反映していない難易度（作った・反映のあとに変えた）
  const pending = unreflected(g);
  const allApplied = anyResult && pending.length === 0;
  const selKind = columnKind(g, g.selected);
  // 右・下に出すもの：作る難易度（作った・まだ）か、残す既存の譜面か
  const selChart = selKind === 'existing' ? g.charts[g.selected] : undefined;
  const selMade = below.includes(g.selected) && !selChart;
  const fills = selMade ? ds.result?.fills : undefined;
  const same = sameGroups(master);
  // スマホの縦の下の操作は、見ている譜面（聴いている列）について。元の譜面を見ているときは「まとめて作る」
  const focus = one && below.includes(g.listen as Difficulty) ? (g.listen as Difficulty) : null;
  const focusKept = focus !== null && columnKind(g, focus) === 'existing';
  const fds = focus ? g.diffs[focus] : null;
  // 使う基準（ガイドライン）。スマホは作る難易度と目標を先に出し、これは後ろへ
  const guideBlock = (
    <>
      <div className="lbl">{tr('使う基準', 'Reference')}</div>
      <button className="card gen-guide" onClick={() => openPage('guideline')}>
        <span className="gen-doc">{Icon.file(15)}</span>
        <span className="grow" style={{ textAlign: 'left' }}>
          <b>
            {tr('難易度ガイドライン', 'Difficulty guidelines')}
            {guide.version > 0 && ` v${guide.version}`}
          </b>
          <span className="lbl" style={{ display: 'block' }}>
            {ruler.use.length
              ? ruler.nx
                ? tr(`DTXMania の曲 ${ruler.use.length} 譜面の物差し`, `Ruler from ${ruler.use.length} DTXMania ${pl(ruler.use.length, 'chart')}`)
                : tr(`足した曲 ${ruler.use.length} 譜面の物差し`, `Ruler from ${ruler.use.length} added ${pl(ruler.use.length, 'chart')}`)
              : tr('物差しがまだありません（開くと作り方が出ます）', 'No ruler yet (open it to see how to build one)')}
          </span>
        </span>
        <span className="link-btn">{tr('開く', 'Open')}</span>
      </button>
      <p className="lbl" style={{ margin: '4px 0 12px' }}>
        {tr('目標レベルの帯の集計（手元の曲で何がどれだけ出てくるか）と、基準文があればそれも AI に渡します。', "The AI gets the target band's stats (what appears how often in your songs), plus the guideline text if there is any.")}
      </p>
    </>
  );

  return (
    <div className={`gen-page ${one ? 'pg-one' : ''} ${one && setup ? 'pg-setup' : ''}`}>
      <header className="tempo-head">
        <button className="btn small ghost" onClick={() => void leaveGen()}>
          {Icon.back(14)} {phone ? tr('戻る', 'Back') : tr('エディタに戻る', 'Back to editor')}
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
        {one && (
          <button className={`p-ib boxed ${setup ? 'on' : ''}`} onClick={() => setSetup(!setup)} aria-pressed={setup} aria-label={tr('作る設定', 'Generation settings')} title={tr('作る設定（作る難易度・目標レベル・必ず残すもの・AIへの指示）', 'Generation settings (which difficulties, target levels, what to keep, instructions for the AI)')}>
            {Icon.sliders(19)}
          </button>
        )}
        {!phone && <MasterMixer />}
        {!phone && (
          <span className={`pill ${hasKey ? 'ok' : ''}`} title={hasKey ? tr(`1難易度 約 ${formatUsd(costPer)}＋判定`, `About ${formatUsd(costPer)} per difficulty + level check`) : noKeyTitle()}>
            {hasKey ? `● OpenRouter · ${model}` : tr('キー未設定 · ルールだけで簡略化', 'No API key · rule-based simplification only')}
          </span>
        )}
        {/* 1つの難易度の作り直し・易しく・難しくは、その難易度のカードの中（右上はエディタに反映だけ） */}
        <button
          className={`btn small ${allApplied ? 'gen-applied' : 'primary'}`}
          onClick={() => void writeOut()}
          disabled={pending.length === 0 || g.busy}
          title={
            allApplied
              ? tr('作った難易度はエディタに入っています（エディタの難易度の切り替えから開けます）', 'The new difficulties are in the editor (open them from the difficulty switcher)')
              : tr(
                  '作った難易度を曲に加え、エディタの難易度の切り替えから開けるようにします（曲フォルダに譜面を書き、set.def に載せます）',
                  'Add the new difficulties to the song so you can open them from the difficulty switcher in the editor (the charts are written to the song folder and listed in set.def)',
                )
          }
        >
          {allApplied
            ? tr('✓ エディタに反映済み', '✓ In the editor')
            : pending.length > 0
              ? tr(`エディタに反映（${pending.length}）`, `Add to editor (${pending.length})`)
              : tr('エディタに反映', 'Add to editor')}
        </button>
      </header>
      {phone ? <PhoneGenTransport /> : <GenTransport />}
      <div className="gen-body">
        {one && (setup || detail) && (
          <div
            className="pg-back"
            onClick={() => {
              setSetup(false);
              setGenDetail(false);
            }}
            aria-hidden="true"
          />
        )}
        <aside className="gen-left scroll">
          {one && (
            <div className="row t-gen-pop-head">
              <b>{tr('作る設定', 'Generation settings')}</b>
              <span className="grow" />
              <button className="ib" onClick={() => setSetup(false)} aria-label={tr('閉じる', 'Close')}>
                {Icon.close(16)}
              </button>
            </div>
          )}
          {!phone && guideBlock}
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
            <button className="btn primary gen-make-all" style={{ width: '100%', margin: '6px 0 4px' }} onClick={() => void generateAll()} disabled={g.busy || g.chartsLoading || makes.length === 0}>
              {Icon.sparkle(14)} {tr(`チェックした難易度を作る（${makes.length}）`, `Generate checked difficulties (${makes.length})`)}
            </button>
          ) : (
            <button
              className="btn small gen-make-all"
              style={{ width: '100%', margin: '6px 0 4px' }}
              onClick={() => void generateAll()}
              disabled={g.busy || g.chartsLoading || makes.length === 0}
              title={tr('チェックした難易度をまとめて作り直します（1つだけなら、その難易度のカードの「作り直す」）', 'Regenerates every checked difficulty (to remake just one, use “Regenerate” on its card)')}
            >
              {Icon.sparkle(13)} {tr(`チェックした難易度を作り直す（${makes.length}）`, `Regenerate checked difficulties (${makes.length})`)}
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
          {phone && <div style={{ height: 12 }} />}
          {phone && guideBlock}
          <div className="lbl" style={{ marginTop: phone ? 0 : 12 }}>
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
          {one && <TargetStrip />}
          <GenCompare only={one ? g.listen : undefined} />
          <div className="gen-foot">
            {selMade && ds.result ? (
              <>
                <b className="gen-foot-name">{ds.diff}</b>
                <span>{tr('簡略化の段', 'Simplification step')}</span>
                <b className="mono" style={{ color: 'var(--text)' }}>
                  {ds.result.rung}
                </b>
                <span>/ {MAX_RUNG}</span>
                {ds.result.ease > 0 && <span>{describeEase(ds.result.ease)}</span>}
                <span className="ellipsis gen-foot-policy" title={describePolicy(policyFor(ds.result.rung, ds.result.slow))}>
                  {describePolicy(policyFor(ds.result.rung, ds.result.slow))}
                </span>
              </>
            ) : (
              <span className="ellipsis gen-foot-policy">
                {selChart
                  ? selChart.movedFrom
                    ? tr(`${selChart.label} は ${selChart.fromLabel ?? selChart.movedFrom} から移した譜面です。`, `${selChart.label} is the chart moved from ${selChart.fromLabel ?? selChart.movedFrom}. `)
                    : tr(`${selChart.label} は曲に既にある譜面です（残します）。`, `${selChart.label} is already in the song (kept). `)
                  : anyResult
                  ? tr(`${ds.diff} はまだ作っていません。`, `${ds.diff} hasn't been generated yet. `)
                  : tr('左の「チェックした難易度を作る」で作ると、ここに並びます。', 'Use "Generate checked difficulties" on the left and the results line up here. ')}
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
            {tablet && !one && below.length > 0 && (
              <button className={`btn small ${detail ? 'on' : ''}`} onClick={() => setGenDetail((was) => !was)} aria-pressed={detail}>
                {tr('判定と方針', 'Rating & plan')}
              </button>
            )}
            {one && (
              <span className="pill pg-turn">
                {Icon.screen(14)} {tr('横にすると並べて聴き比べ', 'Turn sideways to compare side by side')}
              </span>
            )}
          </div>
          {one && below.length > 0 && (
            <div className="pg-acts">
              {fds && !focusKept && (
                <button className="p-btn" onClick={() => void generate(fds.diff)} disabled={g.busy}>
                  <span>{fds.result ? tr('作り直す', 'Regenerate') : tr('作る', 'Generate')}</span>
                </button>
              )}
              {focus && focusKept && (
                <button className="p-btn" onClick={() => remake(focus)} disabled={g.busy} title={tr('この難易度も作り直す（エディタに反映するまで、曲フォルダの譜面は変わりません）', 'Make this difficulty again too (the chart in the song folder stays as it is until you add it to the editor)')}>
                  <span>{tr('作り直す', 'Remake')}</span>
                </button>
              )}
              {fds && !focusKept && fds.result && (
                <button className="p-btn" onClick={() => shiftRung(fds.diff, 1)} disabled={g.busy || fds.result.rung >= MAX_RUNG} title={tr('もっと簡単に（簡略化の段を上げる）', 'Make it easier (raise the simplification step)')}>
                  {Icon.arrowDown(14)}
                  <span>{tr('易しく', 'Easier')}</span>
                </button>
              )}
              {fds && !focusKept && fds.result && (
                <button
                  className="p-btn"
                  onClick={() => shiftRung(fds.diff, -1)}
                  disabled={g.busy || (fds.result.rung <= 0 && fds.result.ease === 0)}
                  title={tr('元の譜面に近づける（簡略化の段を下げる）', 'Closer to the original chart (lower the simplification step)')}
                >
                  {Icon.arrowUp(14)}
                  <span>{tr('難しく', 'Harder')}</span>
                </button>
              )}
              {!focus && (
                <button className="p-btn primary pg-make-all" onClick={() => void generateAll()} disabled={g.busy || g.chartsLoading || makes.length === 0}>
                  {Icon.sparkle(14)}
                  <span>{anyResult ? tr(`まとめて作り直す（${makes.length}）`, `Regenerate all (${makes.length})`) : tr(`まとめて作る（${makes.length}）`, `Generate all (${makes.length})`)}</span>
                </button>
              )}
              {!focus && (
                <button className={`p-btn ${setup ? 'on' : ''}`} onClick={() => setSetup(true)} title={tr('作る設定（必ず残すもの・AIへの指示・使う基準）', 'Generation settings (what to keep, instructions for the AI, reference)')}>
                  {Icon.sliders(15)}
                  <span>{tr('設定', 'Settings')}</span>
                </button>
              )}
              {focus && (
                <button className={`p-btn ${detail ? 'on' : ''}`} onClick={() => setGenDetail((was) => !was)} aria-pressed={detail}>
                  {tr('判定と方針', 'Rating & plan')}
                </button>
              )}
            </div>
          )}
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
                  {ds.result && (
                    <div className="lbl" style={{ marginTop: 6 }}>
                      {tr(
                        `省く順番は曲全体で同じです（同じ役割の音は、どこでも同じ扱い）。目標のレベルに合わせて段 ${ds.result.rung} まで当てました${ds.result.ease ? '。セクションの役割（静か・山場）で、次の段を静かな所から先に当てています' : ''}。`,
                        `The order of what to drop is the same for the whole song (notes with the same role are treated the same everywhere). It goes up to step ${ds.result.rung} to hit the target level${ds.result.ease ? '; the next step is applied to the calm sections first, by section role (calm / high point)' : ''}.`,
                      )}
                    </div>
                  )}
                </div>
              )}
              {ds.plan.sections
                .filter((s) => s.comment || s.shift)
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
                      {s.shift ? <b className="gen-role">{shiftText(s.shift)}</b> : null}
                      {s.shift && s.comment ? ' ' : null}
                      {s.comment}
                    </div>
                    {s.alignedTo && s.shift > 0 && (
                      <div className="lbl gen-aligned">
                        {s.ownShift !== undefined &&
                          tr(
                            `${ds.planSource === 'ai' ? 'AIの方針' : '方針'}は「${shiftText(s.ownShift)}」でしたが、`,
                            `${ds.planSource === 'ai' ? "The AI's plan" : 'The plan'} said “${shiftText(s.ownShift)}”, but `,
                          )}
                        {tr(
                          `${s.alignedTo} がここを静かな所（先にやさしくする）にしているので、こちらも合わせました（難しさの段階をそろえるため）`,
                          `${s.alignedTo} treats this section as calm (simplified first), so this one does too (to keep the difficulties in step)`,
                        )}
                      </div>
                    )}
                  </button>
                ))}
            </>
          )}
          {selMade && <Verdict ds={ds} />}
          <p className="lbl" style={{ marginTop: 12 }}>
            {tr(
              'ノーツの配置はAIではなくルールエンジンが行います。音の役割と拍の強さで決めた「省く順番」を曲全体に同じに当てるので、同じ形の所はどこでも同じに易しくなります。AIは方針の説明とレベルの判定を担当し、「AIへの追加の指示」でセクションごとの違いを頼んだときだけ、セクションの役割（静か・山場）を付けます。中央の譜面のチップを押すと、残す・削るを手直しできます。',
              'Notes are placed by a rule engine, not the AI. It applies one order of what to drop, based on each note’s role and the strength of the beat, to the whole song, so the same pattern is simplified the same way everywhere. The AI explains the plan and judges the level, and gives sections a role (calm / high point) only when you ask for differences between sections in the extra instructions. Click chips in the charts in the middle to keep or remove them by hand.',
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
      {tablet && !phone && (
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

/**
 * 登録レベルと計算（エディタの推定）が違う譜面に、計算の値を小さく出す。作る譜面は計算で測り、目標の幅も計算から決めるので、
 * 目標の幅がなぜそこかが分かるように
 */
function CalcNote({ level, calc }: { level: number; calc: number }) {
  if (Math.abs(calc - level) < 0.05) return null;
  return (
    <span
      className="mono"
      title={tr(
        'エディタの「確かめる」の推定レベル。作る譜面はこの計算で測って #DLEVEL に書き、目標の幅もこの計算から決めます（登録レベルは、ゲームの中で並びが逆にならないようにだけ使います）',
        "The estimated level in the editor's Checks. New charts are measured by this calculation and get it as #DLEVEL, and target ranges come from it too (the listed level is only used to keep the in-game order)",
      )}
    >
      {tr(`計算 ${calc.toFixed(2)}`, `calc ${calc.toFixed(2)}`)}
    </span>
  );
}

/** いま開いている譜面（ここから下の難易度を作る） */
function SourceCard() {
  const master = useGen((s) => s.master);
  const label = useGen((s) => s.masterLabel);
  const level = useGen((s) => s.masterLevel);
  const calc = useGen((s) => s.masterCalc);
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
        <span className="grow" />
        <CalcNote level={level} calc={calc} />
      </div>
      <SourceMoveLink />
    </div>
  );
}

/**
 * 開いている譜面を下へ移して、あいだに作る（上の譜面を開き直す）。例: ADVANCED を開いていて BASIC が空いているとき、
 * ADVANCED を BASIC に移し、EXTREME を開き直して、あいだの ADVANCED を EXTREME から作る
 */
function SourceMoveLink() {
  const g = useGen();
  const plan = sourceShift(g);
  if (!plan) return null;
  const from = g.sourceSlot;
  const above = g.charts[plan.above]!;
  return (
    <button
      className="link-btn gen-move-link"
      onClick={(e) => {
        e.stopPropagation();
        void moveSourceDown();
      }}
      disabled={g.busy}
      title={tr(
        `この譜面を ${plan.to} に移し（ファイルと DTXMania の成績はそのまま）、${above.label}（Lv ${above.level.toFixed(2)}）を開き直して、あいだの ${from} を作ります。エディタに反映するまで、曲フォルダは変わりません`,
        `Moves this chart to ${plan.to} (the file and your DTXMania records stay as they are), reopens ${above.label} (Lv ${above.level.toFixed(2)}) and makes a new ${from} in between. The song folder doesn't change until you add it to the editor`,
      )}
    >
      {Icon.arrowDown(12)}
      {tr(`${plan.to} へ移して、あいだに作る`, `Move to ${plan.to} and make one in between`)}
    </button>
  );
}

/** 曲にある譜面を下へ移すリンク（すぐ下の難易度が空いているとき） */
function MoveLink({ chart }: { chart: ExistingChart }) {
  const g = useGen();
  const to = offeredMove(g, chart.slot);
  if (!to) return null;
  const up = SLOTS.slice(0, SLOTS.indexOf(chart.slot))
    .reverse()
    .find((x) => x === g.sourceSlot || g.charts[x]);
  const upName = up ? slotLabel(g, up) : null;
  return (
    <button
      className="link-btn gen-move-link"
      onClick={(e) => {
        e.stopPropagation();
        moveDown(chart.slot as Difficulty);
      }}
      disabled={g.busy}
      title={tr(
        `この譜面を ${to} に移し（ファイルと DTXMania の成績はそのまま）、空いた ${chart.slot} に${upName ? ` ${upName} とのあいだの` : ''}譜面を作ります。エディタに反映するまで、曲フォルダは変わりません`,
        `Moves this chart to ${to} (the file and your DTXMania records stay as they are) and makes a new ${chart.slot}${upName ? ` between it and ${upName}` : ''}. The song folder doesn't change until you add it to the editor`,
      )}
    >
      {Icon.arrowDown(12)}
      {tr(`${to} へ移して、あいだに作る`, `Move to ${to} and make one in between`)}
    </button>
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
        {chart.movedFrom && <MovedChip chart={chart} />}
        <span className="grow" />
        <b className="mono" title={chart.registered ? tr('登録レベル（#DLEVEL）', 'Listed level (#DLEVEL)') : tr('登録レベルが無いので計算のめやす', 'No listed level, so this is a computed estimate')}>
          {chart.registered ? '' : '≈'}
          {chart.level.toFixed(2)}
        </b>
      </div>
      <div className="row lbl gen-diff-line">
        <span className="ellipsis">{chart.file}</span>
        <span className="grow" />
        {chart.registered && <CalcNote level={chart.level} calc={chart.calc} />}
        {chart.movedFrom ? <MovedState chart={chart} /> : <span>{tr('残す', 'Kept')}</span>}
        {canRemake && !chart.movedFrom && (
          <button
            className="link-btn"
            onClick={(e) => {
              e.stopPropagation();
              remake(chart.slot as Difficulty);
            }}
            title={tr('この難易度も作り直す（エディタに反映するまで、曲フォルダの譜面は変わりません）', 'Make this difficulty again too (the chart in the song folder stays as it is until you add it to the editor)')}
          >
            {tr('作り直す', 'Remake')}
          </button>
        )}
      </div>
      <MoveLink chart={chart} />
    </div>
  );
}

const SHORT_NAME: Record<Slot, string> = { MASTER: 'MAS', EXTREME: 'EXT', ADVANCED: 'ADV', BASIC: 'BSC' };

/** 下へ移した譜面の印（元の難易度） */
function MovedChip({ chart }: { chart: ExistingChart }) {
  if (!chart.movedFrom) return null;
  return (
    <span className="gen-moved" title={tr(`${chart.fromLabel ?? chart.movedFrom} から移した譜面`, `Moved here from ${chart.fromLabel ?? chart.movedFrom}`)}>
      ← {SHORT_NAME[chart.movedFrom]}
    </span>
  );
}

/** 下へ移した譜面の様子：まだ反映していなければ「移す」と「戻す」、反映したら「移しました」 */
function MovedState({ chart }: { chart: ExistingChart }) {
  const g = useGen();
  const pending = pendingMoveTo(g, chart.slot);
  const undo = undoableMove(g);
  if (!pending)
    return (
      <span className="gen-reflect ok" title={tr('set.def で移しました（ファイルと DTXMania の成績はそのまま）', 'Moved in set.def (the file and your DTXMania records stay as they are)')}>
        {tr('✓ 移しました', '✓ Moved')}
      </span>
    );
  return (
    <>
      <span title={tr('エディタに反映すると、set.def でこの難易度に移します（ファイルと DTXMania の成績はそのまま）', 'When you add to the editor, set.def moves it to this difficulty (the file and your DTXMania records stay as they are)')}>{tr('移す', 'Moving')}</span>
      {undo?.to === chart.slot && (
        <button
          className="link-btn"
          onClick={(e) => {
            e.stopPropagation();
            void undoMove();
          }}
          disabled={g.busy}
          title={tr(`${chart.fromLabel ?? chart.movedFrom} に戻す`, `Move it back to ${chart.fromLabel ?? chart.movedFrom}`)}
        >
          {tr('戻す', 'Undo')}
        </button>
      )}
    </>
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
  const calcs = knownCalcs(g);
  // 決まっている譜面のレベルの見せ方（登録と計算が違えば、どちらか）
  const lvText = (slot: Slot, lv: number) => {
    const reg = known[slot];
    if (reg === undefined || Math.abs(reg - (calcs[slot] ?? reg)) < 0.005) return `Lv ${lv.toFixed(2)}`;
    return Math.abs(lv - reg) < 0.005 ? tr(`登録 Lv ${lv.toFixed(2)}`, `listed Lv ${lv.toFixed(2)}`) : tr(`計算 ${lv.toFixed(2)}`, `calculated ${lv.toFixed(2)}`);
  };
  const capText = (c: NonNullable<typeof t.capAbove>, up: boolean) => {
    const name = slotLabel(g, c.slot);
    const lv = c.level ?? calcs[c.slot];
    if (!c.known || lv === undefined) return tr(`${up ? '上' : '下'}は ${name} のめやすとの真ん中で分けています`, `The ${up ? 'upper' : 'lower'} end is halfway to ${name}'s aim`);
    if (c.listed) {
      const calc = calcs[c.slot]!;
      return up
        ? tr(
            `上は ${name} の登録 Lv ${lv.toFixed(2)} から 0.3 離しています（計算 ${calc.toFixed(2)} より登録が低いので、ゲームの中でも ${name} より低い Lv になるように）`,
            `The upper end stays 0.3 below ${name}'s listed Lv ${lv.toFixed(2)} (lower than its calculated ${calc.toFixed(2)}, so the new chart also shows a lower Lv in the game)`,
          )
        : tr(
            `下は ${name} の登録 Lv ${lv.toFixed(2)} から 0.3 離しています（計算 ${calc.toFixed(2)} より登録が高いので、ゲームの中でも ${name} より高い Lv になるように）`,
            `The lower end stays 0.3 above ${name}'s listed Lv ${lv.toFixed(2)} (higher than its calculated ${calc.toFixed(2)}, so the new chart also shows a higher Lv in the game)`,
          );
    }
    return tr(`${up ? '上' : '下'}は ${name}（${lvText(c.slot, lv)}）から 0.3 離しています`, `The ${up ? 'upper' : 'lower'} end stays 0.3 away from ${name} (${lvText(c.slot, lv)})`);
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
  if ((t.pulled ?? 0) >= 0.05 && t.pulledFrom) {
    const name = slotLabel(g, t.pulledFrom);
    const lv = t.pulledLevel ?? calcs[t.pulledFrom];
    const at = lv === undefined ? '' : tr(`（${lvText(t.pulledFrom, lv)}）`, ` (${lvText(t.pulledFrom, lv)})`);
    const d = (s: Slot) => MAX_DROP[s].toFixed(1);
    parts.push(
      tr(
        `${name}${at}に合わせて +${t.pulled!.toFixed(2)} 引き上げています。難しい曲は下の難易度も難しくてよく、削りすぎると曲として崩れるので、いちばん上の譜面から EXTREME は ${d('EXTREME')}・ADVANCED は ${d('ADVANCED')}・BASIC は ${d('BASIC')} までしか下げません（BASIC でも元の音の約半分を残します）`,
        `Raised by +${t.pulled!.toFixed(2)} to stay near ${name}${at}. Hard songs may keep their lower difficulties hard: thinning too much breaks the song, so from the top chart EXTREME drops at most ${d('EXTREME')}, ADVANCED ${d('ADVANCED')} and BASIC ${d('BASIC')} (even BASIC keeps about half of the notes)`,
      ),
    );
  }
  return parts.join('\n');
}

/** セクションの役割（方針の shift の向き。+ は静か、− は山場） */
function shiftText(n: number): string {
  if (n > 0) return tr('静か：先にやさしく', 'Calm: simplified first');
  if (n < 0) return tr('山場：最後まで元に近く', 'High point: kept closest to the original');
  return tr('ふつう', 'Normal');
}

/** 「要確認」のわけ：叩けない所・目標の幅から外れ・段階の逆転（上の譜面より濃い・下の譜面より薄い小節） */
function reviewWhy(ds: DiffState, stairN: number): string {
  const out: string[] = [];
  if (ds.issues) out.push(tr(`叩けない所 ${ds.issues}`, `${ds.issues} unplayable`));
  if (ds.result && !inRange(calcLevel(ds), ds.target)) out.push(tr('目標の幅から外れ', 'outside the target range'));
  if (stairN) out.push(tr(`段階の逆転 ${stairN}小節`, `${stairN} ${pl(stairN, 'measure')} out of step`));
  return out.join(tr('・', ', '));
}

/** 段階の名前：作った難易度はその名前、元の譜面・残す既存の譜面は譜面の名前 */
function stairName(g: GenState, slot: Slot): string {
  return columnKind(g, slot) === 'made' ? slot : slotLabel(g, slot);
}

/** 段階が逆転している小節（カードの「要確認」に重ねる説明） */
function stairTitle(g: GenState, st: StairIssues): string {
  const fmt = (m: number) => toMeasure(m);
  const parts: string[] = [];
  if (st.upper && st.denser.length) parts.push(tr(`${stairName(g, st.upper)} よりノーツの多い小節: ${measureList(st.denser, fmt)}`, `Measures with more notes than ${stairName(g, st.upper)}: ${measureList(st.denser, fmt)}`));
  if (st.lower && st.thinner.length) parts.push(tr(`${stairName(g, st.lower)} よりノーツの少ない小節: ${measureList(st.thinner, fmt)}`, `Measures with fewer notes than ${stairName(g, st.lower)}: ${measureList(st.thinner, fmt)}`));
  return parts.join('\n');
}

/** 作る難易度（曲に既にある譜面を作り直すときも） */
function DiffCard({ ds, on }: { ds: DiffState; on: boolean }) {
  const g = useGen();
  // スマホはめやすを「− 値 ＋」で（押して打つこともできる）
  const phone = useDevice((s) => s.phone);
  const chart = g.charts[ds.diff];
  const src = sourceFor(g, ds.diff);
  const busy = ds.status === 'planning' || ds.status === 'building' || ds.status === 'judging';
  // 段階：上の譜面より濃い小節・下の譜面より薄い小節が無いか
  const stair = stairIssues(g, ds.diff);
  const stairN = stair.denser.length + stair.thinner.length;
  const pass = isPassing(ds) && stairN === 0;
  const lv = ds.result ? calcLevel(ds) : null;
  const t = ds.target;
  // 作ったあとで作る元が変わった（上の既存の譜面を作り直す・残すに変えた）
  const srcChanged = !!ds.result && !!ds.src && !!src && ds.src.doc !== src.doc;
  // 曲にある譜面を下へ移して空けた難易度（上下の譜面のあいだに作る）
  const between = !chart && insertedSlots(g).includes(ds.diff) ? betweenOf(g, ds.diff) : null;
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
            <span className="lbl">{tr('計算', 'Calc')}</span>
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
              {phone ? <AimStepper ds={ds} /> : <AimNumber ds={ds} />}
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
          {(t.pulled ?? 0) >= 0.05 && t.pulledFrom && (
            <div className="lbl gen-diff-line gen-diff-note gen-raised" title={bandTitle(g, ds)}>
              {tr(`${slotLabel(g, t.pulledFrom)} に合わせて +${t.pulled!.toFixed(2)} 引き上げ（削りすぎない）`, `Raised +${t.pulled!.toFixed(2)} to stay near ${slotLabel(g, t.pulledFrom)}`)}
            </div>
          )}
          {between && (
            <div className="lbl gen-diff-line gen-diff-note gen-between">
              {between.lower && between.upper
                ? tr(
                    `${between.lower.name}（${between.lower.level.toFixed(2)}）と ${between.upper.name}（${between.upper.level.toFixed(2)}）のあいだに作る`,
                    `Made in between ${between.lower.name} (${between.lower.level.toFixed(2)}) and ${between.upper.name} (${between.upper.level.toFixed(2)})`,
                  )
                : tr('上下の譜面のあいだに作る', 'Made in between the charts above and below')}
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
          <span>{tr('作らない（エディタに反映しません）', 'Not made (not added to the editor)')}</span>
        ) : ds.result ? (
          pass ? (
            <span style={{ color: 'var(--ok)' }}>{tr('✓ 検証OK', '✓ Checks passed')}</span>
          ) : (
            <span style={{ color: 'var(--amber)' }} title={stairN ? stairTitle(g, stair) : undefined}>
              {tr(`! 要確認（${reviewWhy(ds, stairN)}）`, `! Needs review (${reviewWhy(ds, stairN)})`)}
            </span>
          )
        ) : ds.status === 'error' ? (
          <span style={{ color: 'var(--danger)' }}>{tr('失敗しました', 'Failed')}</span>
        ) : (
          <span>{tr('まだ作っていません', 'Not generated yet')}</span>
        )}
        {!busy && <span className="grow" />}
        {!busy && <ReflectBadge ds={ds} />}
      </div>
      {srcChanged && ds.enabled && (
        <div className="lbl gen-diff-line gen-diff-note" style={{ color: 'var(--amber)' }}>
          {tr('作る元の譜面が変わりました。作り直すと反映されます', 'The chart it is made from has changed. Regenerate to use it')}
        </div>
      )}
      {on && ds.enabled && <DiffActions ds={ds} busy={busy || g.busy} />}
    </div>
  );
}

/** あいだに作る難易度の上下の譜面（名前とレベル） */
function betweenOf(g: GenState, d: Difficulty): { lower: { name: string; level: number } | null; upper: { name: string; level: number } | null } {
  const known = knownLevels(g);
  const i = SLOTS.indexOf(d);
  const up = SLOTS.slice(0, i)
    .filter((x) => known[x] !== undefined)
    .pop();
  const down = SLOTS.slice(i + 1).find((x) => known[x] !== undefined);
  return {
    upper: up ? { name: slotLabel(g, up), level: known[up]! } : null,
    lower: down ? { name: slotLabel(g, down), level: known[down]! } : null,
  };
}

/**
 * めやすの数字の欄（PC・タブレット）。打っている間は打った文字のまま出す
 * （「6」で 6.0 に書き換えると、続けて「.4」と打てなかった）。数として読めたらその都度決める
 */
function AimNumber({ ds }: { ds: DiffState }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = ds.target.center.toFixed(1);
  return (
    <input
      className="gen-target mono"
      type="number"
      step={0.1}
      min={1}
      max={9.9}
      value={draft ?? shown}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => setDraft(shown)}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        // 空は打っている途中（「6.」など）。自動に戻すのは「自動」で
        if (text === '') return;
        const v = Number(text);
        if (Number.isFinite(v)) setTarget(ds.diff, v);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      title={tr('めやすを手で決める（幅はその ±1。隣の難易度とは重ねません）', 'Set the aim by hand (the range is ±1 around it and never overlaps the neighbors)')}
    />
  );
}

/** 選んでいる難易度のカードの中の操作：この難易度だけ作り直す・易しく・難しく（変わるのはこのカードと中央の同じ列だけ） */
function DiffActions({ ds, busy }: { ds: DiffState; busy: boolean }) {
  const r = ds.result;
  return (
    <div className="gen-diff-acts" onClick={(e) => e.stopPropagation()}>
      {r && (
        <div className="row lbl gen-diff-line wrap">
          <span>{tr('簡略化の段', 'Simplification step')}</span>
          <b className="mono" style={{ color: 'var(--text)' }}>
            {r.rung}
          </b>
          <span>/ {MAX_RUNG}</span>
          {r.ease > 0 && <span>{describeEase(r.ease)}</span>}
        </div>
      )}
      <div className="row gen-diff-btns">
        <button
          className="btn small"
          onClick={() => void generate(ds.diff)}
          disabled={busy}
          title={
            r
              ? tr(`${ds.diff} だけ作り直します（エディタに反映するまで、エディタの譜面は変わりません）`, `Regenerates only ${ds.diff} (the editor’s chart doesn’t change until you add it to the editor)`)
              : tr(`${ds.diff} だけ作ります`, `Generates only ${ds.diff}`)
          }
        >
          {Icon.sparkle(12)} {r ? tr('作り直す', 'Regenerate') : tr('作る', 'Generate')}
        </button>
        {r && (
          <>
            <button className="btn small" onClick={() => shiftRung(ds.diff, 1)} disabled={busy || r.rung >= MAX_RUNG} title={tr('もっと簡単に（簡略化の段を上げる）', 'Make it easier (raise the simplification step)')}>
              {tr('易しく', 'Easier')}
            </button>
            <button
              className="btn small"
              onClick={() => shiftRung(ds.diff, -1)}
              disabled={busy || (r.rung <= 0 && r.ease === 0)}
              title={tr('元の譜面に近づける（簡略化の段を下げる）', 'Closer to the original chart (lower the simplification step)')}
            >
              {tr('難しく', 'Harder')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 作った難易度がエディタに入っているか（カードの右下） */
function ReflectBadge({ ds }: { ds: DiffState }) {
  const r = reflectState(ds);
  if (r === 'none') return null;
  if (r === 'applied')
    return (
      <span className="gen-reflect ok" title={tr(`エディタに入っています（${ds.applied!.file}）。難易度の切り替えから開けます`, `In the editor (${ds.applied!.file}). Open it from the difficulty switcher`)}>
        {tr('✓ 反映済み', '✓ In editor')}
      </span>
    );
  if (r === 'changed')
    return (
      <span className="gen-reflect changed" title={tr('エディタに反映したあとに作り直した・手直ししました。右上の「エディタに反映」でエディタの譜面も変わります', 'Regenerated or edited after it was added. Press “Add to editor” at the top right to update the editor’s chart too')}>
        {tr('反映後に変更', 'Changed')}
      </span>
    );
  return (
    <span className="gen-reflect pending" title={tr('まだエディタに入っていません。右上の「エディタに反映」で難易度の切り替えに加わります', 'Not in the editor yet. Press “Add to editor” at the top right to add it to the difficulty switcher')}>
      {tr('未反映', 'Not added')}
    </span>
  );
}

/** 右：残す既存の譜面を選んでいるとき */
function ExistingInfo({ chart }: { chart: ExistingChart }) {
  const g = useGen();
  const below = belowSource(g);
  const canRemake = below.includes(chart.slot as Difficulty);
  // この譜面から作る難易度（次の残す譜面まで）
  const from = below.filter((d) => g.diffs[d].enabled && sourceFor(g, d)?.slot === chart.slot);
  const to = offeredMove(g, chart.slot);
  const pending = pendingMoveTo(g, chart.slot);
  const undo = undoableMove(g);
  const was = chart.fromLabel ?? chart.movedFrom;
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
        {chart.registered && Math.abs(chart.calc - chart.level) >= 0.05 && tr(` · 計算 ${chart.calc.toFixed(2)}`, ` · calculated ${chart.calc.toFixed(2)}`)}
      </div>
      <div>
        {!chart.movedFrom
          ? tr(`${originTitle(chart.origin)}です。曲フォルダの譜面はそのまま残します。`, `${originTitle(chart.origin)}. The chart in the song folder stays as it is.`)
          : pending
            ? tr(
                `${was} から移す譜面です。エディタに反映すると、set.def でこの譜面を ${chart.slot} に移します。ファイル（${chart.file}）も中身も変えないので、DTXMania の成績も付いたままです。空いた ${chart.movedFrom} には、新しい譜面を別の名前で作ります。`,
                `This chart moves here from ${was}. When you add to the editor, set.def lists it as ${chart.slot}. Its file (${chart.file}) and content don't change, so your DTXMania records stay with it. The new ${chart.movedFrom} is written under a different name.`,
              )
            : tr(`${was} から移した譜面です（set.def で ${chart.slot} に移しました。ファイルと DTXMania の成績はそのまま）。`, `Moved here from ${was} (set.def lists it as ${chart.slot}; the file and your DTXMania records stay as they are).`)}
        {from.length > 0 &&
          tr(
            ` ${from.join('・')} はこの譜面から作ります（上の難易度からはみ出さないように）。`,
            ` ${from.join(' and ')} ${from.length === 1 ? 'is' : 'are'} made from this chart (so they never go beyond it).`,
          )}
      </div>
      {(canRemake && !chart.movedFrom) || to || undo?.to === chart.slot ? (
        <div className="row wrap gen-info-acts">
          {canRemake && !chart.movedFrom && (
            <button className="btn small" onClick={() => remake(chart.slot as Difficulty)}>
              {tr('この難易度も作り直す', 'Remake this difficulty too')}
            </button>
          )}
          {to && (
            <button className="btn small" onClick={() => moveDown(chart.slot as Difficulty)} disabled={g.busy}>
              {Icon.arrowDown(12)} {tr(`${to} へ移して、あいだに作る`, `Move to ${to} and make one in between`)}
            </button>
          )}
          {undo?.to === chart.slot && (
            <button className="btn small" onClick={() => void undoMove()} disabled={g.busy}>
              {tr(`${was} に戻す`, `Move back to ${was}`)}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function inRange(lv: number, t: { min: number; max: number }) {
  return lv >= t.min - 1e-9 && lv <= t.max + 1e-9;
}

function JudgeCard({ ds }: { ds: DiffState }) {
  const calc = calcLevel(ds);
  const j = ds.judge;
  const r = ds.result;
  if (!r) return <div className="card gen-judge lbl">{tr('作るとここにレベルの判定が出ます。', 'The level check appears here after you generate.')}</div>;
  return (
    <div className="card gen-judge">
      <div className="row">
        <b>{tr('レベル（計算）', 'Level (calculated)')}</b>
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
        {tr(
          'エディタの「確かめる」の推定レベルと同じ計算です。エディタに反映すると、この値を譜面の Lv（#DLEVEL）に書きます。',
          "The same calculation as the estimated level in the editor's Checks. Adding to the editor writes this value as the chart's Lv (#DLEVEL).",
        )}
      </div>
      <div className="lbl">
        {tr('試した段: ', 'Steps tried: ')}
        {[...r.tries]
          .sort((a, b) => a.rung - b.rung || (a.ease ?? 0) - (b.ease ?? 0))
          .map((t) => `${t.rung}${t.ease ? `+${t.ease}/3` : ''}→${t.level.toFixed(2)}`)
          .join(tr('、', ', '))}
      </div>
      {j && (
        <div className="gen-ai-judge">
          <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
            <span className="ai-spark">{Icon.sparkle(13)}</span>
            <b>{tr('AIの判定', "AI's check")}</b>
            <span className="mono">{j.level.toFixed(2)}</span>
            <span className="lbl">{tr('（参考）', '(for reference)')}</span>
            <span className="grow" />
            <span className={`ai-conf ${j.confidence}`}>
              {j.confidence === 'high' ? tr('自信度 高', 'High confidence') : j.confidence === 'medium' ? tr('自信度 中', 'Medium confidence') : tr('自信度 低', 'Low confidence')}
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
            {j.gap && (
              <li>
                {tr('計算との違い: ', 'Vs. calculated: ')}
                {j.gap}
              </li>
            )}
          </ul>
          <div className="lbl">
            {ds.judgeStale
              ? tr('判定のあとに手直ししました（AI の判定は手直しの前の譜面のものです）。', 'You edited it after the check (the AI checked the chart before your edits).')
              : tr(
                  'AI の判定は Lv に書きません。使うときは、反映した譜面をエディタで開き、「確かめる」の「AIのレベル判定」で判定して「Lv に反映」を押してください。',
                  "The AI's check isn't written as the Lv. To use it, open the chart in the editor after adding it, rate it with \"AI level rating\" in Checks and press \"Set as Lv\".",
                )}
          </div>
          <div className="lbl">
            {tr('この難易度の費用', 'Cost for this difficulty')} {formatUsd(ds.cost)}
          </div>
        </div>
      )}
    </div>
  );
}

function Verdict({ ds }: { ds: DiffState }) {
  const g = useGen();
  const r = ds.result;
  if (!r) return null;
  const ok = inRange(calcLevel(ds), ds.target);
  const stair = stairIssues(g, ds.diff);
  const stairN = stair.denser.length + stair.thinner.length;
  const msgs: string[] = [];
  const ai = ds.judge && !ds.judgeStale ? ds.judge.level.toFixed(2) : null;
  msgs.push(
    tr(
      `計算 ${calcLevel(ds).toFixed(2)}（目標の幅 ${ds.target.min.toFixed(2)}–${ds.target.max.toFixed(2)}、めやす ${ds.target.center.toFixed(2)}）${ai ? `・AIの判定 ${ai}（参考）` : ''}`,
      `calculated ${calcLevel(ds).toFixed(2)} (target range ${ds.target.min.toFixed(2)}–${ds.target.max.toFixed(2)}, aim ${ds.target.center.toFixed(2)})${ai ? `, AI check ${ai} (for reference)` : ''}`,
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
  const up = stair.upper ? stairName(g, stair.upper) : null;
  const down = stair.lower ? stairName(g, stair.lower) : null;
  if (!stairN && up && down) msgs.push(tr(`どの小節も ${up} よりノーツが多くなく、${down} より少なくありません`, `No measure has more notes than ${up} or fewer than ${down}`));
  else if (!stairN && up) msgs.push(tr(`どの小節も ${up} よりノーツが多くありません`, `No measure has more notes than ${up}`));
  else if (!stairN && down) msgs.push(tr(`どの小節も ${down} よりノーツが少なくありません`, `No measure has fewer notes than ${down}`));
  const pass = ok && ds.issues === 0 && stairN === 0;
  return (
    <div className={`card gen-verdict ${pass ? 'ok' : 'warn'}`}>
      <b>{pass ? tr('✓ 検証を通過', '✓ Passed the checks') : tr('! 確認してください', '! Please review')}</b>
      <div>{tr(`${msgs.join('。')}。`, `${msgs.join('. ')}.`)}</div>
      {!ok &&
        (r.rung >= MAX_RUNG && calcLevel(ds) > ds.target.max ? (
          <div className="lbl">
            {tr(
              'いちばん簡単な段でも目標より高く出ました。人が作る BASIC でもこのくらいの曲はあります。このままでよければエディタに反映し、もっと下げたいときは中央の譜面のチップを押して削ってください。',
              "Even the easiest step came out above the target. Hand-made BASIC charts can be this hard for some songs too. Add it to the editor if that's fine, or click chips in the middle charts to remove more.",
            )}
          </div>
        ) : (
          <div className="lbl">{tr('目標の幅から外れています。難易度のカードの「易しく・難しく」で段を動かすか、めやすを変えて作り直してください。', 'This is outside the target range. Change the step with “Easier/Harder” on the difficulty’s card, or change the aim and regenerate.')}</div>
        ))}
      {stairN > 0 && <StairWarn st={stair} up={up} down={down} />}
      {ds.step?.clipped && (
        <div className="lbl">
          {tr(
            `隣の難易度とレベルが近づきすぎないように（${STEP_GAP} 以上あける）、狙うレベルを目標の幅の中で寄せて作りました。`,
            `To keep the level at least ${STEP_GAP} away from the neighboring difficulties, the aim was moved within the target range.`,
          )}
        </div>
      )}
    </div>
  );
}

/** 段階が逆転している小節（押すとその小節へ ▶ を移す） */
function StairWarn({ st, up, down }: { st: StairIssues; up: string | null; down: string | null }) {
  const row = (ms: number[], text: string) =>
    ms.length > 0 && (
      <div className="gen-stair">
        <span>{text}</span>
        {ms.slice(0, 8).map((m) => (
          <button key={m} className="link-btn mono" onClick={() => jumpToMeasure(m)} title={tr('この小節に ▶ を置く', 'Put ▶ at this measure')}>
            {toMeasure(m)}
          </button>
        ))}
        {ms.length > 8 && <span className="lbl">{tr(`ほか${ms.length - 8}`, `and ${ms.length - 8} more`)}</span>}
      </div>
    );
  return (
    <div className="gen-stairs">
      {up && row(st.denser, tr(`${up} よりノーツの多い小節:`, `More notes than ${up}:`))}
      {down && row(st.thinner, tr(`${down} よりノーツの少ない小節:`, `Fewer notes than ${down}:`))}
      <div className="lbl">
        {tr(
          'その小節のチップを押して手直しするか、作り直してください（作り直すと、上の難易度に無い音は置かず、下の難易度にある音は残します）。',
          'Click chips in those measures to fix them by hand, or regenerate (regenerating never adds a note the harder chart lacks and keeps every note the easier chart has).',
        )}
      </div>
    </div>
  );
}
