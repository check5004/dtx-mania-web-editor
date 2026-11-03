// AI難易度生成の画面：難易度ごとの生成、MASTER との比較（押して手直し）、AI のレベル判定と方針、set.def への書き出し。
import { useEffect, useMemo, useRef } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { estimateLevel } from '../check/level';
import { toMeasure } from '../dtx/base36';
import { DRUM_LANES, drumChannel, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures, FEATURE_DEFS, lastMeasure } from '../gen/features';
import { DEFAULT_RUNG, describePolicy, DIFFICULTIES, FILL_STYLES, MAX_RUNG, policyFor, type ChipFate } from '../gen/simplify';
import { slotOf, useInputSettings } from '../input/settings';
import { NO_KEY_TITLE, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { goBack, openPage, openSettings } from '../store/editor';
import { calcLevel, generate, generateAll, initGen, isPassing, setKeep, setTarget, shiftRung, shownLevel, toggleChip, useGen, writeOut, type DiffState } from '../store/gen';
import { useGuideline } from '../store/guideline';
import { useSidecar } from '../store/sidecar';
import { Icon } from './icons';

const KEEP_ITEMS: { k: keyof ReturnType<typeof useGen.getState>['keep']; label: string }[] = [
  { k: 'backbeat', label: '2・4拍のスネア（バックビート）' },
  { k: 'kick1', label: '1拍目のキック' },
  { k: 'sectionCrash', label: 'セクション頭のクラッシュ' },
  { k: 'fillLanding', label: 'フィルの着地' },
  { k: 'openHH', label: 'オープンHHのアクセント' },
];

const WIN = 4;

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
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-back') || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape') goBack();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const s = useGen.getState();
        useGen.setState({ win: Math.max(0, s.win + (e.key === 'ArrowLeft' ? -WIN : WIN)) });
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
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
        <main className="gen-main scroll">
          <div className="row" style={{ gap: 10, marginBottom: 8 }}>
            <b>比較</b>
            <span className="mono lbl">
              {toMeasure(g.win)}-{toMeasure(g.win + WIN - 1)}
              {sectionName(g.spans, g.win)}
            </span>
            <button className="btn small ghost" onClick={() => useGen.setState({ win: Math.max(0, g.win - WIN) })} title="前（←）">
              ‹
            </button>
            <button className="btn small ghost" onClick={() => useGen.setState({ win: Math.min(last, g.win + WIN) })} title="次（→）">
              ›
            </button>
            <span className="grow" />
            <span className="gen-legend">
              <i className="kept" /> 残したチップ <i className="removed" /> 削ったチップ <i className="moved" /> 移したチップ
            </span>
          </div>
          <div className="gen-compare">
            <div>
              <div className="gen-col-title">{g.masterLabel}（元の譜面）</div>
              <MiniChart doc={master} from={g.win} />
            </div>
            <div className="gen-arrow">{Icon.chevronRight(18)}</div>
            <div>
              <div className="gen-col-title amber">{ds.diff}（{ds.planSource === 'ai' ? 'AI生成' : '自動生成'}・手直し可）</div>
              {ds.result ? (
                <MiniChart doc={master} from={g.win} fate={ds.result.fate} overrides={ds.overrides} onToggle={(id) => toggleChip(ds.diff, id)} />
              ) : (
                <div className="gen-empty">
                  {ds.status === 'planning' ? 'AIが方針を考えています…' : ds.status === 'building' ? '作っています…' : ds.status === 'error' ? ds.error : `左の「選んだ難易度を作る」で ${ds.diff} を作ります`}
                </div>
              )}
            </div>
          </div>
          {ds.result && <CompareStats master={master} gen={ds.result.doc} />}
          {ds.result && (
            <div className="row lbl" style={{ gap: 8, marginTop: 10, whiteSpace: 'nowrap' }}>
              簡略化の段 <b className="mono" style={{ color: 'var(--text)' }}>{ds.result.rung}</b> / {MAX_RUNG}
              {ds.result.ease > 0 && <span>（4小節のうち{ds.result.ease}小節は次の段）</span>}
              <button className="btn small ghost" onClick={() => shiftRung(ds.diff, -1)} disabled={ds.result.rung <= 0 && ds.result.ease === 0} title="元の譜面に近づける">
                難しく
              </button>
              <button className="btn small ghost" onClick={() => shiftRung(ds.diff, 1)} disabled={ds.result.rung >= MAX_RUNG} title="もっと簡単に">
                易しく
              </button>
              <span className="ellipsis">{describePolicy(policyFor(ds.result.rung))}</span>
            </div>
          )}
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
                  <button key={s.from} className="card gen-plan" onClick={() => useGen.setState({ win: s.from })}>
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

function sectionName(spans: { name: string; from: number; to: number }[], m: number): string {
  const s = spans.find((x) => m >= x.from && m <= x.to);
  return s ? `（${s.name}）` : '';
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
    <div className={`card gen-diff ${on ? 'on' : ''}`} onClick={() => useGen.setState({ selected: ds.diff })} role="button" tabIndex={0}>
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

function CompareStats({ master, gen }: { master: DtxDoc; gen: DtxDoc }) {
  const a = useMemo(() => estimateLevel(master, buildTempoMap(master)), [master]);
  const b = useMemo(() => estimateLevel(gen, buildTempoMap(gen)), [gen]);
  return (
    <div className="gen-stats">
      <div className="card">
        <div className="lbl">ノーツ数</div>
        <div className="mono">
          {(a?.notes ?? 0).toLocaleString()} → {(b?.notes ?? 0).toLocaleString()}
        </div>
      </div>
      <div className="card">
        <div className="lbl">平均密度（ノーツ/秒）</div>
        <div className="mono">
          {(a?.avgNps ?? 0).toFixed(1)} → {(b?.avgNps ?? 0).toFixed(1)}
        </div>
      </div>
      <div className="card">
        <div className="lbl">最大同時打数</div>
        <div className="mono">
          {a?.maxChord ?? 0} → {b?.maxChord ?? 0}
        </div>
      </div>
    </div>
  );
}

/** 4小節ぶんの小さな譜面。fate があれば生成側（削った・移したを描き分け、押すと手直し） */
function MiniChart({ doc, from, fate, overrides, onToggle }: { doc: DtxDoc; from: number; fate?: Map<number, ChipFate>; overrides?: Map<number, 'keep' | 'drop'>; onToggle?: (id: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const order = useInputSettings((s) => s.laneOrder);
  const hits = useRef<{ id: number; x: number; y: number }[]>([]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const tempo = buildTempoMap(doc);
    const b0 = tempo.measureStart(from);
    const b1 = tempo.measureStart(from + WIN);
    const pad = 10;
    const gut = 30;
    const laneW = (W - gut - 8) / 10;
    const y = (beat: number) => H - pad - ((beat - b0) / (b1 - b0)) * (H - pad * 2);
    const x = (lane: number) => gut + slotOf(lane) * laneW + laneW / 2;
    // 背景
    g.fillStyle = '#0d1116';
    g.fillRect(gut, 0, W - gut - 8, H);
    for (let i = 0; i <= 10; i++) {
      g.fillStyle = 'rgba(255,255,255,.035)';
      g.fillRect(gut + i * laneW, 0, 1, H);
    }
    for (let m = from; m <= from + WIN; m++) {
      const by = y(tempo.measureStart(m));
      g.fillStyle = 'rgba(255,255,255,.22)';
      g.fillRect(gut, by, W - gut - 8, 1);
      if (m < from + WIN) {
        g.fillStyle = '#5f6978';
        g.font = '10px "JetBrains Mono", monospace';
        g.textAlign = 'right';
        g.fillText(toMeasure(m), gut - 4, by - 2);
        const beats = tempo.measureBeats(m);
        for (let k = 1; k < beats; k++) {
          g.fillStyle = 'rgba(255,255,255,.06)';
          g.fillRect(gut, y(tempo.measureStart(m) + k), W - gut - 8, 1);
        }
      }
    }
    const list: { id: number; x: number; y: number }[] = [];
    const cw = Math.min(26, laneW - 6);
    for (const ch of doc.chips) {
      if (ch.m < from || ch.m >= from + WIN) continue;
      const d = drumChannel(ch.ch);
      if (!d || d.kind !== 'normal') continue;
      const beat = tempo.beatOf(ch.m, ch.f);
      const yy = y(beat);
      const f = fate?.get(ch.id);
      let lane = d.lane;
      let alt = d.alt;
      if (f?.kind === 'moved') {
        const nd = drumChannel(f.ch)!;
        lane = nd.lane;
        alt = nd.alt;
      }
      const def = DRUM_LANES[lane];
      const color = alt && def.altColor ? def.altColor : def.color;
      const xx = x(lane);
      g.beginPath();
      g.roundRect(xx - cw / 2, yy - 3.5, cw, 7, 2);
      if (f?.kind === 'removed') {
        g.setLineDash([3, 2]);
        g.strokeStyle = 'rgba(200,210,225,.45)';
        g.lineWidth = 1;
        g.stroke();
        g.setLineDash([]);
      } else {
        g.fillStyle = color;
        g.fill();
        if (f?.kind === 'moved') {
          g.strokeStyle = '#ffb547';
          g.lineWidth = 1.6;
          g.stroke();
        }
      }
      if (overrides?.has(ch.id)) {
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(xx + cw / 2 + 3, yy - 3, 2, 0, Math.PI * 2);
        g.fill();
      }
      list.push({ id: ch.id, x: xx, y: yy });
    }
    hits.current = list;
  }, [doc, from, fate, overrides, order]);
  return (
    <canvas
      ref={ref}
      className={`gen-mini ${onToggle ? 'edit' : ''}`}
      onClick={(e) => {
        if (!onToggle) return;
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        let best: { id: number; d: number } | null = null;
        for (const h of hits.current) {
          const d = Math.hypot(h.x - px, (h.y - py) * 1.6);
          if (d < 16 && (!best || d < best.d)) best = { id: h.id, d };
        }
        if (best) onToggle(best.id);
      }}
    />
  );
}
