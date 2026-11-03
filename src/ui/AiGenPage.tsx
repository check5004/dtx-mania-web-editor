// AI難易度生成の画面：難易度ごとの生成、元の譜面と作った難易度を曲全体で並べて聴き比べる（押して手直し）、
// AI のレベル判定と方針、set.def への書き出し。再生の操作はエディタと同じ（Space・Shift+Space・▶・ループ・速さ）。
import { useEffect, useMemo } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { toMeasure } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { drumChannel, type DtxDoc } from '../dtx/model';
import { gridStep, snapToGrid } from '../edit/ops';
import { chartFeatures, FEATURE_DEFS, lastMeasure } from '../gen/features';
import { DEFAULT_RUNG, describePolicy, DIFFICULTIES, FILL_STYLES, MAX_RUNG, policyFor } from '../gen/simplify';
import { setLoopPoint, toggleLoop } from '../store/assist';
import { NO_KEY_TITLE, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
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

const KEEP_ITEMS: { k: keyof ReturnType<typeof useGen.getState>['keep']; label: string }[] = [
  { k: 'backbeat', label: '2・4拍のスネア（バックビート）' },
  { k: 'kick1', label: '1拍目のキック' },
  { k: 'sectionCrash', label: 'セクション頭のクラッシュ' },
  { k: 'fillLanding', label: 'フィルの着地' },
  { k: 'openHH', label: 'オープンHHのアクセント' },
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

const FITS: { fit: GenFit; label: string; tip: string }[] = [
  { fit: 'all', label: '曲全体', tip: '曲全体を1画面に並べる（密度の違いを見渡す）' },
  { fit: 16, label: '16小節', tip: '16小節が画面に収まる大きさ' },
  { fit: 8, label: '8小節', tip: '8小節が画面に収まる大きさ' },
  { fit: 4, label: '4小節', tip: '4小節が画面に収まる大きさ' },
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
      <PlayControls show={genShow} where="並べた譜面の小節番号の列や空いた所" />
      <div className="vsep" />
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl" style={{ whiteSpace: 'nowrap' }}>
          聴く
        </span>
        <div className="seg small" role="radiogroup" aria-label="聴く譜面">
          {(['MASTER', ...DIFFICULTIES] as Listen[]).map((x) => (
            <button
              key={x}
              role="radio"
              aria-checked={listen === x}
              className={listen === x ? 'on' : ''}
              disabled={!choices.split(',').includes(x)}
              onClick={() => setListen(x)}
              title={x === 'MASTER' ? `元の譜面（${masterLabel}）を聴く（←）` : `${x} を聴く（←→ で切り替え。再生中ならそのまま切り替わります）`}
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
        表示
      </span>
      <div className="seg small" role="radiogroup" aria-label="表示の大きさ">
        {FITS.map((f) => (
          <button key={String(f.fit)} role="radio" aria-checked={fit === f.fit} className={fit === f.fit ? 'on' : ''} onClick={() => chooseFit(f.fit)} title={`${f.tip}。Ctrl+ホイールでも拡大・縮小できます`}>
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
          {Icon.back(14)} エディタに戻る
        </button>
        <div className="vsep" />
        <span className="ai-spark">{Icon.sparkle(15)}</span>
        <h1>AI難易度生成</h1>
        <span className="lbl ellipsis hide-narrow">
          {master.fields['TITLE'] || '無題'} · 元譜面 {g.masterLabel} Lv {g.masterLevel.toFixed(2)} · {feat.notes.toLocaleString()}ノーツ
        </span>
        <span className="grow" />
        <MasterMixer />
        <span className={`pill ${hasKey ? 'ok' : ''}`} title={hasKey ? `1難易度 約 ${formatUsd(costPer)}＋判定` : NO_KEY_TITLE}>
          {hasKey ? `● OpenRouter · ${model}` : 'キー未設定 · ルールだけで簡略化'}
        </span>
        {anyResult && (
          <button className="btn small" onClick={() => void generate(g.selected)} disabled={g.busy || ds.status === 'planning' || ds.status === 'judging'}>
            この難易度を作り直す
          </button>
        )}
        <button className="btn small primary" onClick={() => void writeOut()} disabled={!anyResult || g.busy}>
          採用してset.defに書き出す
        </button>
      </header>
      <GenTransport />
      <div className="gen-body">
        <aside className="gen-left scroll">
          <div className="lbl">使う基準</div>
          <button className="card gen-guide" onClick={() => openPage('guideline')}>
            <span className="gen-doc">{Icon.file(15)}</span>
            <span className="grow" style={{ textAlign: 'left' }}>
              <b>難易度ガイドライン v{guide.version}</b>
              <span className="lbl" style={{ display: 'block' }}>
                {charts ? `手元 ${charts} 譜面から作成` : 'まだ集計していません'}
              </span>
            </span>
            <span className="link-btn">開く</span>
          </button>
          <p className="lbl" style={{ margin: '4px 0 12px' }}>
            目標レベルの帯の基準文と集計をAIに渡します。
          </p>
          <div className="lbl">作る難易度と目標レベル</div>
          {DIFFICULTIES.map((d) => (
            <DiffCard key={d} ds={g.diffs[d]} on={g.selected === d} />
          ))}
          {!anyResult && (
            <button className="btn primary" style={{ width: '100%', margin: '6px 0 4px' }} onClick={() => void generateAll()} disabled={g.busy || enabledCount === 0}>
              {Icon.sparkle(14)} 選んだ難易度を作る
            </button>
          )}
          {!anyResult && hasKey && <div className="lbl">1難易度 約 {formatUsd(costPer)}＋レベル判定</div>}
          {anyResult && (
            <button className="btn small" style={{ width: '100%', margin: '6px 0 4px' }} onClick={() => void generateAll()} disabled={g.busy || enabledCount === 0}>
              選んだ難易度をすべて作り直す
            </button>
          )}
          <div className="lbl" style={{ marginTop: 12 }}>
            必ず残すもの
          </div>
          {KEEP_ITEMS.map((it) => (
            <label key={it.k} className="row gen-check">
              <input type="checkbox" checked={g.keep[it.k]} onChange={(e) => setKeep({ [it.k]: e.target.checked })} />
              {it.label}
            </label>
          ))}
          <div className="lbl" style={{ marginTop: 12 }}>
            曲の解析結果
          </div>
          <div className="card gen-facts">
            {master.fields['GENRE'] ? `${master.fields['GENRE']} · ` : ''}
            {Math.round(feat.bpm)} BPM · {feat.feel === '16' ? '16ビート中心' : feat.feel === '8' ? '8ビート中心' : feat.feel === '4' ? '4分の刻み中心' : '刻みは混在'}
            <br />
            セクション {g.spans.length}
            {sections.length ? '（マーカーから）' : '（マーカーが無いので8小節ごと）'}
            <br />
            {fills !== undefined ? `フィル ${fills}か所 · ` : ''}同じパターンの小節 {same}組
            <br />
            要素: {FEATURE_DEFS.filter((d) => feat.has[d.key])
              .map((d) => d.label)
              .join('、') || 'なし'}
          </div>
          <div className="lbl" style={{ marginTop: 12 }}>
            AIへの追加の指示（任意）
          </div>
          <textarea
            className="field"
            rows={3}
            placeholder={hasKey ? '例: サビのライドは低難易度でも残したい' : 'キーを設定すると使えます'}
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
                <span>簡略化の段</span>
                <b className="mono" style={{ color: 'var(--text)' }}>
                  {ds.result.rung}
                </b>
                <span>/ {MAX_RUNG}</span>
                {ds.result.ease > 0 && <span>（4小節のうち{ds.result.ease}小節は次の段）</span>}
                <button className="btn small ghost" onClick={() => shiftRung(ds.diff, -1)} disabled={ds.result.rung <= 0 && ds.result.ease === 0} title="元の譜面に近づける">
                  難しく
                </button>
                <button className="btn small ghost" onClick={() => shiftRung(ds.diff, 1)} disabled={ds.result.rung >= MAX_RUNG} title="もっと簡単に">
                  易しく
                </button>
                <span className="ellipsis gen-foot-policy" title={describePolicy(policyFor(ds.result.rung))}>
                  {describePolicy(policyFor(ds.result.rung))}
                </span>
              </>
            ) : (
              <span className="ellipsis gen-foot-policy">
                {anyResult ? `${ds.diff} はまだ作っていません。` : '左の「選んだ難易度を作る」で作ると、ここに並びます。'}Space で再生、列の見出しか ←→ で聴く譜面を切り替えます。
              </span>
            )}
            <span className="gen-legend" title="作った難易度の列のチップを押すと、残す・削るを手直しできます（白い点が手直ししたチップ）">
              <i className="kept" /> 残した <i className="removed" /> 削った <i className="moved" /> 移した
            </span>
          </div>
          <TrackMixStrip />
        </main>
        <aside className="gen-right scroll">
          <JudgeCard ds={ds} />
          {ds.plan && (
            <>
              <div className="row" style={{ gap: 6, margin: '14px 0 6px' }}>
                <b>{ds.planSource === 'ai' ? 'AIの方針' : '方針'}（{ds.diff}）</b>
                <span className="grow" />
                <span className="lbl">セクションごと</span>
              </div>
              {ds.plan.summary && (
                <div className="card gen-plan">
                  <div className="row">
                    <b>全体</b>
                    <span className="grow" />
                    <span className="mono lbl">
                      {toMeasure(0)}-{toMeasure(last)}
                    </span>
                  </div>
                  <div>{ds.plan.summary}</div>
                  {ds.result && ds.result.rung !== DEFAULT_RUNG[ds.diff] && (
                    <div className="lbl" style={{ marginTop: 6 }}>
                      方針は段 {DEFAULT_RUNG[ds.diff]} を基準に書かれています。目標のレベルに合わせて、全体を段 {ds.result.rung} に変えて作りました（セクションごとの差はそのまま）。
                    </div>
                  )}
                </div>
              )}
              {ds.plan.sections
                .filter((s) => s.comment || s.shift || s.fill)
                .map((s) => (
                  <button key={s.from} className="card gen-plan" onClick={() => jumpToMeasure(s.from)} title="このセクションの頭に ▶ を置く（再生中ならそこから続けて再生）">
                    <div className="row">
                      <b>{s.name}</b>
                      <span className="grow" />
                      <span className="mono lbl">
                        {toMeasure(s.from)}-{toMeasure(s.to)}
                      </span>
                    </div>
                    <div>{s.comment || [s.shift ? (s.shift > 0 ? `全体より${s.shift}段やさしく` : `全体より${-s.shift}段元に近く`) : '', s.fill ? FILL_STYLES[s.fill].label : ''].filter(Boolean).join('。')}</div>
                  </button>
                ))}
            </>
          )}
          <Verdict ds={ds} />
          <p className="lbl" style={{ marginTop: 12 }}>
            ノーツの配置はAIではなくルールエンジンが行います。AIは「どこをどう簡略化するか」とレベルの判定だけを担当します。中央の譜面のチップを押すと、残す・削るを手直しできます。
          </p>
          {!hasKey && (
            <p className="lbl">
              {NO_KEY_TITLE}。いまは標準の方針で、機械的な推定が目標に入るまで段を調整しています。{' '}
              <button className="link-btn" onClick={() => openSettings('ai')}>
                キーを設定
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
            <span className="lbl">{ds.judge && !ds.judgeStale ? 'AI' : '計算'}</span>
            <b className="mono">{lv.toFixed(2)}</b>
          </>
        )}
      </div>
      <div className="row lbl gen-diff-line">
        <span>目標</span>
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
          <span>{ds.status === 'planning' ? 'AIが方針を考えています…' : ds.status === 'judging' ? 'AIがレベルを判定しています…' : '作っています…'}</span>
        ) : ds.result ? (
          pass ? (
            <span style={{ color: 'var(--ok)' }}>✓ 検証OK</span>
          ) : (
            <span style={{ color: 'var(--amber)' }}>! 要確認（{ds.issues ? `叩けない所 ${ds.issues}` : '目標から外れ'}）</span>
          )
        ) : ds.status === 'error' ? (
          <span style={{ color: 'var(--danger)' }}>失敗しました</span>
        ) : (
          <span>まだ作っていません</span>
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
  if (!r) return <div className="card gen-judge lbl">作るとここにレベルの判定が出ます。</div>;
  if (!j)
    return (
      <div className="card gen-judge">
        <div className="row">
          <b>{hasKey ? 'レベル（計算）' : 'レベル（機械的な推定）'}</b>
          <span className="grow" />
          {ds.status === 'judging' && <span className="lbl">AIが判定中…</span>}
        </div>
        <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
          <span className="gen-lv mono">{calc.toFixed(2)}</span>
          <span className="lbl mono">
            目標 {ds.target.min.toFixed(2)}-{ds.target.max.toFixed(2)}
          </span>
        </div>
        <div className="lbl">試した段: {r.tries.map((t) => `${t.rung}${t.ease ? `+${t.ease}/4` : ''}→${(t.level * calib).toFixed(2)}`).join('、')}</div>
        {Math.abs(calib - 1) > 0.02 && <div className="lbl">元譜面の登録レベルに合わせて、機械的な推定を ×{calib.toFixed(2)} しています。</div>}
      </div>
    );
  return (
    <div className="card gen-judge ai">
      <div className="row" style={{ gap: 6 }}>
        <span className="ai-spark">{Icon.sparkle(13)}</span>
        <b>AIのレベル判定</b>
        <span className="grow" />
        <span className={`ai-conf ${j.confidence}`}>{j.confidence === 'high' ? '自信度 高' : j.confidence === 'medium' ? '自信度 中' : '自信度 低'}</span>
      </div>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span className="gen-lv mono">{j.level.toFixed(2)}</span>
        <span className="lbl mono">
          目標 {ds.target.min.toFixed(2)}-{ds.target.max.toFixed(2)} · 計算 {calc.toFixed(2)}
        </span>
      </div>
      <ul className="ai-reasons">
        {j.reasons.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
        {j.hardest && <li>難所: {j.hardest}</li>}
      </ul>
      {ds.judgeStale && <div className="lbl" style={{ color: 'var(--amber)' }}>判定のあとに手直ししました。書き出しのレベルは計算の値を使います。</div>}
      <div className="lbl">この難易度の費用 {formatUsd(ds.cost)}</div>
    </div>
  );
}

function Verdict({ ds }: { ds: DiffState }) {
  const calib = useGen((s) => s.calib);
  const r = ds.result;
  if (!r) return null;
  const ok = inRange(shownLevel(ds, calib), ds.target);
  const msgs: string[] = [];
  msgs.push(`${ds.judge && !ds.judgeStale ? `AI判定 ${ds.judge.level.toFixed(2)}・` : ''}計算 ${calcLevel(ds, calib).toFixed(2)}（目標 ${ds.target.min.toFixed(2)}–${ds.target.max.toFixed(2)}）`);
  if (ds.issues) msgs.push(`叩けない組み合わせが ${ds.issues} か所あります（作ったあとエディタの「確かめる」で直せます）`);
  else msgs.push('手足で叩けない組み合わせ、同じレーンの詰まりすぎはありません');
  const pass = ok && ds.issues === 0;
  return (
    <div className={`card gen-verdict ${pass ? 'ok' : 'warn'}`}>
      <b>{pass ? '✓ 検証を通過' : '! 確認してください'}</b>
      <div>{msgs.join('。')}。</div>
      {!ok &&
        (r.rung >= MAX_RUNG && shownLevel(ds, calib) > ds.target.max ? (
          <div className="lbl">いちばん簡単な段でも目標より高く出ました。人が作る BASIC でもこのくらいの曲はあります。このままでよければ書き出し、もっと下げたいときは中央の譜面のチップを押して削ってください。</div>
        ) : (
          <div className="lbl">目標から外れています。「易しく／難しく」で段を動かすか、目標を変えて作り直してください。</div>
        ))}
    </div>
  );
}
