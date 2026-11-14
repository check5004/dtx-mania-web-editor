// 設定 › AI（OpenRouter）：キーと使用額、処理ごとのモデル・推論の強さ・予備のモデル、使いすぎ防止。
import { tr, locale } from '../i18n';
import { useEffect, useMemo, useState } from 'react';
import type { Effort, OrModel } from '../ai/openrouter';
import { formatUsd, meetsNeeds, modelInfo, perMillion, sortModels, taskDef, TASKS, type AiTask, type ModelSort } from '../ai/tasks';
import { checkKey, refreshModels, resetTasks, setKey, setLimits, setRemember, setTaskConfig, taskCostEstimate, useAi } from '../store/ai';
import { aiFeatures } from '../ai/features';
import { openAiGuide } from '../store/aiGuide';
import { Icon } from './icons';
import { KeyMark } from './aiGuide/KeyGate';

const efforts = (): { v: Effort; label: string }[] => [
  { v: 'none', label: tr('なし', 'None') },
  { v: 'low', label: tr('低', 'Low') },
  { v: 'medium', label: tr('中', 'Med') },
  { v: 'high', label: tr('高', 'High') },
];
const DATE_TIME: Intl.DateTimeFormatOptions = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };

export function AiSettings() {
  const [sel, setSel] = useState<AiTask>('level');
  useEffect(() => {
    void refreshModels();
    if (useAi.getState().key) void checkKey();
  }, []);
  return (
    <div className="ai-set">
      <div className="ai-set-main">
        <SetupHero />
        <ConnectionCard />
        <TaskTable sel={sel} onSel={setSel} />
        <div className="ai-set-2col">
          <LimitsCard />
          <PrivacyCard />
        </div>
        <SpendCard />
        <FeaturesCard />
      </div>
      <ModelPicker task={sel} />
    </div>
  );
}

function ConnectionCard() {
  const key = useAi((s) => s.key);
  const remember = useAi((s) => s.remember);
  const status = useAi((s) => s.keyStatus);
  const err = useAi((s) => s.keyError);
  const info = useAi((s) => s.keyInfo);
  const [draft, setDraft] = useState(key);
  const [show, setShow] = useState(false);
  useEffect(() => setDraft(key), [key]);
  const pill =
    status === 'ok' ? (
      <span className="pill ok">{tr('● 接続OK', '● Connected')}</span>
    ) : status === 'checking' ? (
      <span className="pill">{tr('確認中…', 'Checking…')}</span>
    ) : status === 'error' ? (
      <span className="pill warn">{tr('つながりません', "Can't connect")}</span>
    ) : (
      <span className="pill">{tr('キー未設定', 'No API key')}</span>
    );
  return (
    <section className="card ai-card">
      <div className="row" style={{ gap: 10 }}>
        <h3>{tr('OpenRouterとの接続', 'OpenRouter connection')}</h3>
        {pill}
        <span className="grow" />
        <button className="link-btn" onClick={() => openAiGuide(key ? 'care' : 'about')}>
          {tr('はじめかた・注意点', 'Getting started and tips')}
        </button>
        <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">
          {tr('OpenRouter の Keys を開く', 'Open OpenRouter Keys')}
        </a>
      </div>
      <div className="ai-conn">
        <div className="ai-key">
          <div className="lbl">{tr('APIキー', 'API key')}</div>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="field mono grow"
              type={show ? 'text' : 'password'}
              value={draft}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft !== key && setKey(draft)}
              onKeyDown={(e) => e.key === 'Enter' && setKey(draft)}
            />
            <button className="btn small ghost" onClick={() => setShow(!show)} title={tr('キーを表示する・隠す', 'Show or hide the key')}>
              {show ? tr('隠す', 'Hide') : tr('表示', 'Show')}
            </button>
            <button className="btn small" onClick={() => (draft !== key ? setKey(draft) : void checkKey())} disabled={!draft.trim()}>
              {tr('接続テスト', 'Test connection')}
            </button>
          </div>
        </div>
        <Tile label={tr('今日の使用額', 'Spent today')} value={info?.usageDaily ?? null} />
        <Tile label={tr('今月の使用額', 'Spent this month')} value={info?.usageMonthly ?? null} />
        <Tile label={tr('キーの残り上限', 'Key limit left')} value={info ? info.limitRemaining : null} empty={info && info.limit === null ? tr('上限なし', 'No limit') : '—'} />
      </div>
      {status === 'error' && err && <div className="ai-err">{err}</div>}
      <div className="row" style={{ gap: 18, marginTop: 8 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={remember} onChange={() => setRemember(true)} />
          {tr('このブラウザに保存する', 'Save in this browser')}
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={!remember} onChange={() => setRemember(false)} />
          {tr('保存しない（タブを閉じたら消す）', "Don't save (cleared when the tab closes)")}
        </label>
        {key && (
          <button className="link-btn" onClick={() => setKey('')}>
            {tr('キーを消す', 'Delete key')}
          </button>
        )}
      </div>
      <p className="lbl" style={{ margin: '6px 0 0' }}>
        {tr(
          '使用額と上限はキーの情報（/api/v1/key）から取得。キーは暗号化されずにこのブラウザに保存され、OpenRouter にだけ直接送ります。共用のPCでは「保存しない」を選んでください。',
          'Spending and limits come from the key info (/api/v1/key). The key is stored unencrypted in this browser and sent directly to OpenRouter only. On a shared PC, choose "Don\'t save".',
        )}
      </p>
    </section>
  );
}

/** キーが無いとき：いちばん上に、AI を使う準備（案内）への入口 */
function SetupHero() {
  const hasKey = useAi((s) => s.key.trim().length > 0);
  if (hasKey) return null;
  return (
    <section className="card ai-hero">
      <span className="ai-hero-i">{Icon.sparkle(20)}</span>
      <div className="grow">
        <h3>{tr('AI を使うには、OpenRouter のキーが要ります', 'AI features need an OpenRouter key')}</h3>
        <p className="lbl">
          {tr(
            'OpenRouter のアカウントを作り、クレジットを $5 ほど入れて、キーを作って下に貼ります（約 5 分）。手順は画面のイメージつきで案内します。',
            'Create an OpenRouter account, add about $5 of credits, make a key and paste it below (about 5 minutes). The guide walks you through it with pictures.',
          )}
        </p>
      </div>
      <button className="btn primary" onClick={() => openAiGuide('about')}>
        {Icon.sparkle(14)}
        {tr('AI を使う準備（約 5 分）', 'Set up AI (about 5 min)')}
      </button>
    </section>
  );
}

/** AI を使う機能の一覧（どこから・キーで増えること・キーが無いとき） */
function FeaturesCard() {
  const hasKey = useAi((s) => s.key.trim().length > 0);
  return (
    <section className="card ai-card">
      <div className="row" style={{ gap: 10 }}>
        <h3>{tr('AI を使う機能', 'Features that use AI')}</h3>
        <span className="lbl hide-narrow">
          {hasKey ? tr('キーが無いときは、右の列の形で動きます', 'Without a key, they work as in the right column') : tr('キーが無いあいだは、ボタンに鍵の印が付きます', 'Without a key, their buttons show a key mark')}
        </span>
      </div>
      <div className="ai-feat-table">
        <div className="ai-feat-h lbl">
          <span>{tr('機能・どこから', 'Feature and where')}</span>
          <span>{tr('キーで増えること', 'What a key adds')}</span>
          <span>{tr('キーが無いとき', 'Without a key')}</span>
        </div>
        {aiFeatures().map((f) => (
          <div key={f.id} className="ai-feat-r">
            <span>
              <b>
                {!hasKey && <KeyMark />}
                {f.name}
              </b>
              <span className="lbl">{f.where}</span>
            </span>
            <span>{f.withKey}</span>
            <span className="lbl">{f.withoutKey}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Tile({ label, value, empty = '—' }: { label: string; value: number | null; empty?: string }) {
  return (
    <div className="ai-tile">
      <div className="lbl">{label}</div>
      <div className="mono">{value === null ? empty : formatUsd(value)}</div>
    </div>
  );
}

function TaskTable({ sel, onSel }: { sel: AiTask; onSel: (t: AiTask) => void }) {
  const tasks = useAi((s) => s.tasks);
  const models = useAi((s) => s.models);
  useAi((s) => s.spend);
  return (
    <section className="card ai-card">
      <div className="row" style={{ gap: 10 }}>
        <h3>{tr('処理ごとのモデル', 'Model per task')}</h3>
        <span className="lbl hide-narrow">{tr('行を選ぶと右でモデルを選べます。料金は100万トークンあたり（入力 / 出力）', 'Select a row to pick its model on the right. Prices are per million tokens (input / output)')}</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={resetTasks}>
          {tr('すべておすすめに戻す', 'Reset all to recommended')}
        </button>
      </div>
      <div className="ai-table">
        <div className="ai-tr head">
          <span>{tr('処理', 'Task')}</span>
          <span>{tr('モデル', 'Model')}</span>
          <span>{tr('料金', 'Price')}</span>
          <span>{tr('推論の強さ', 'Reasoning')}</span>
          <span style={{ textAlign: 'right' }}>{tr('1回の目安', 'Per run')}</span>
        </div>
        {TASKS.map((t) => {
          const cfg = tasks[t.id];
          const m = modelInfo(cfg.model, models);
          const cost = taskCostEstimate(t.id);
          return (
            <div key={t.id} className={`ai-tr ${sel === t.id ? 'on' : ''}`} onClick={() => onSel(t.id)} role="button" tabIndex={0}>
              <span>
                <b>{t.label}</b>
                <span className="lbl" style={{ display: 'block' }}>
                  {tr('送る内容: ', 'Sends: ')}
                  {t.sends}
                </span>
              </span>
              <span>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <b>{m?.name ?? cfg.model}</b>
                  {cfg.model === t.model && <span className="ai-badge rec">{tr('おすすめ', 'Recommended')}</span>}
                </span>
                <span className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                  {m && <CapTags m={m} />}
                  {!m && <span className="lbl">{tr('一覧にないモデル', 'Not in the list')}</span>}
                  {cfg.fallback && (
                    <span className="lbl">
                      {tr('予備: ', 'Fallback: ')}
                      {modelInfo(cfg.fallback, models)?.name ?? cfg.fallback}
                    </span>
                  )}
                </span>
              </span>
              <span className="mono lbl">
                {m ? `${perMillion(m.pricePrompt)} / ${perMillion(m.priceCompletion)}` : '—'}
                {t.needs.web && m && <span style={{ display: 'block' }}>{tr(`Web検索 ${formatUsd(m.priceWebSearch || 0.02)}/回`, `Web search ${formatUsd(m.priceWebSearch || 0.02)}/each`)}</span>}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <div className="seg small">
                  {efforts().map((e) => (
                    <button
                      key={e.v}
                      className={cfg.effort === e.v ? 'on' : ''}
                      disabled={!!m && !m.reasoning && e.v !== 'none'}
                      title={m && !m.reasoning ? tr('このモデルは推論の強さを選べません', "This model doesn't support choosing the reasoning effort") : undefined}
                      onClick={() => setTaskConfig(t.id, { effort: e.v })}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </span>
              <span className="mono" style={{ textAlign: 'right' }}>
                {tr('約', '~')}
                {formatUsd(cost)}
                {t.per && <span className="lbl" style={{ display: 'block' }}>{t.per.replace(' / ', '/ ')}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="lbl" style={{ margin: '8px 0 0' }}>
        {tr(
          'おすすめは 2026-11-02 時点の OpenRouter の一覧から、処理に必要な機能と料金で選んでいます。アプリの更新でおすすめも見直します。',
          'Recommendations were picked from the OpenRouter list as of 2026-11-02, based on the features each task needs and price. They are reviewed with app updates.',
        )}
      </p>
    </section>
  );
}

function CapTags({ m }: { m: OrModel }) {
  return (
    <>
      {m.web && <span className="ai-tag">{tr('Web検索', 'Web search')}</span>}
      {m.reasoning && <span className="ai-tag">{tr('推論', 'Reasoning')}</span>}
      {m.json && <span className="ai-tag">JSON</span>}
    </>
  );
}

function LimitsCard() {
  const confirmOver = useAi((s) => s.confirmOver);
  const cap = useAi((s) => s.monthlyCap);
  const spend = useAi((s) => s.spend);
  const ratio = cap > 0 ? Math.min(1, spend.monthTotal / cap) : 0;
  return (
    <section className="card ai-card">
      <h3>{tr('使いすぎ防止', 'Spending limits')}</h3>
      <div className="ai-limits">
        <label>
          <span className="lbl">{tr('1回の目安がこれを超えたら確認する', 'Ask first when a run is estimated above')}</span>
          <MoneyInput value={confirmOver} onChange={(v) => setLimits({ confirmOver: v })} />
        </label>
        <label>
          <span className="lbl">{tr('このアプリで使う月の上限', 'Monthly cap for this app')}</span>
          <MoneyInput value={cap} onChange={(v) => setLimits({ monthlyCap: v })} />
        </label>
      </div>
      <div className="lbl" style={{ marginTop: 10 }}>
        {tr('今月このアプリで使った額 ', 'Spent in this app this month ')}
        <b className="mono" style={{ color: 'var(--text)' }}>
          {formatUsd(spend.monthTotal)}
        </b>{' '}
        {tr(`/ 上限 ${formatUsd(cap)}（今日 ${formatUsd(spend.dayTotal)}）`, `/ cap ${formatUsd(cap)} (today ${formatUsd(spend.dayTotal)})`)}
      </div>
      <div className="ai-bar">
        <i style={{ width: `${ratio * 100}%`, background: ratio > 0.9 ? 'var(--danger)' : ratio > 0.7 ? 'var(--amber)' : 'var(--accent)' }} />
      </div>
      <p className="lbl" style={{ margin: '6px 0 0' }}>
        {tr(
          '上限に届く呼び出しは送らずに止めます。費用は OpenRouter が返した額（無ければトークン数からの計算）で記録します。',
          "Calls that would hit the cap are stopped before sending. Costs are recorded from the amount OpenRouter returns (or calculated from token counts if it doesn't).",
        )}
      </p>
    </section>
  );
}

function MoneyInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [t, setT] = useState(value.toFixed(2));
  useEffect(() => setT(value.toFixed(2)), [value]);
  const commit = () => {
    const v = Number(t.replace(/^\$/, ''));
    if (Number.isFinite(v) && v >= 0) onChange(Math.round(v * 100) / 100);
    else setT(value.toFixed(2));
  };
  return (
    <div className="ai-money">
      <span>$</span>
      <input className="field mono" value={t} onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} inputMode="decimal" />
    </div>
  );
}

function PrivacyCard() {
  return (
    <section className="card ai-card">
      <h3>{tr('AIに送るもの・送らないもの', 'What is and isn\'t sent to the AI')}</h3>
      <ul className="ai-list">
        <li>{tr('音声そのものは送りません。原曲は「打点の強さ」の数値にしてから渡します', 'Audio itself is never sent. The original is turned into hit-strength numbers first')}</li>
        <li>{tr('譜面は小節・レーン・位置の一覧と、そこから出した特徴量だけを送ります', 'Charts are sent only as a list of measures, lanes and positions, plus features computed from them')}</li>
        <li>{tr('曲情報の取得では、曲名・アーティスト名・YouTubeの動画タイトルを送り、Web検索で裏を取ります', 'Song info lookups send the title, artist and YouTube video title, and verify them with web search')}</li>
        <li>{tr('キーはこのブラウザから OpenRouter に直接送ります（このアプリにサーバーはありません）', 'The key goes from this browser straight to OpenRouter (this app has no server)')}</li>
        <li>{tr('キーが無くても、AI以外の機能はすべて使えます', 'Without a key, everything except the AI features still works')}</li>
      </ul>
    </section>
  );
}

function SpendCard() {
  const log = useAi((s) => s.spend.log);
  const models = useAi((s) => s.models);
  if (log.length === 0) return null;
  return (
    <section className="card ai-card">
      <h3>{tr('最近の呼び出し', 'Recent calls')}</h3>
      <div className="ai-log">
        {log.slice(0, 8).map((l, i) => (
          <div key={i} className="row" style={{ gap: 10 }}>
            <span className="mono lbl">{new Date(l.at).toLocaleString(locale(), DATE_TIME)}</span>
            <span>{taskDef(l.task)?.label ?? l.task}</span>
            <span className="lbl ellipsis grow">{modelInfo(l.model, models)?.name ?? l.model}</span>
            <span className="mono">{formatUsd(l.cost)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ModelPicker({ task }: { task: AiTask }) {
  const def = taskDef(task);
  const cfg = useAi((s) => s.tasks[task]);
  const models = useAi((s) => s.models);
  const status = useAi((s) => s.modelsStatus);
  const err = useAi((s) => s.modelsError);
  const at = useAi((s) => s.modelsAt);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState(true);
  const [sort, setSort] = useState<ModelSort>('recommended');
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let arr = models.filter((m) => (!only || meetsNeeds(m, def)) && (!ql || m.id.toLowerCase().includes(ql) || m.name.toLowerCase().includes(ql)));
    // 一覧が取れていないときも初期のモデルは出す
    if (arr.length === 0 && models.length === 0) arr = TASKS.map((t) => modelInfo(t.model, [])!).filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i);
    return sortModels(arr, def, sort).slice(0, 80);
  }, [models, q, only, sort, def]);
  const fallbackOptions = useMemo(() => sortModels(models.filter((m) => meetsNeeds(m, def) && m.id !== cfg.model), def, 'recommended').slice(0, 40), [models, def, cfg.model]);
  const now = Date.now() / 1000;
  return (
    <aside className="ai-picker">
      <div className="lbl">{tr('モデルを選ぶ', 'Choose a model')}</div>
      <h3 style={{ margin: '2px 0 10px' }}>{tr(`${def.label} に使うモデル`, `Model for ${def.label}`)}</h3>
      <input className="field" placeholder={tr('名前・提供元で検索', 'Search by name or provider')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row" style={{ gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
        <button
          className={`tag ${only ? 'on' : ''}`}
          onClick={() => setOnly(!only)}
          title={tr(
            `必要な機能: ${[def.needs.json && 'JSON出力', def.needs.reasoning && '推論', def.needs.web && 'Web検索'].filter(Boolean).join('・')}`,
            `Needs: ${[def.needs.json && 'JSON output', def.needs.reasoning && 'reasoning', def.needs.web && 'web search'].filter(Boolean).join(', ')}`,
          )}
        >
          {tr('この処理に使えるものだけ', 'Only models that fit this task')}
        </button>
        <div className="seg small">
          {(
            [
              ['recommended', tr('おすすめ', 'Recommended')],
              ['cheap', tr('安い順', 'Cheapest')],
              ['new', tr('新しい順', 'Newest')],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="lbl" style={{ marginBottom: 6 }}>
        {status === 'loading'
          ? tr('OpenRouter から一覧を取得中…', 'Getting the list from OpenRouter…')
          : status === 'error'
            ? tr(`一覧を取得できませんでした（${err}）。初期のモデルだけ出しています`, `Couldn't get the list (${err}). Showing only the default models`)
            : at
              ? tr(`一覧 ${models.length} 件（${new Date(at).toLocaleString(locale(), DATE_TIME)} 取得）`, `${models.length} models (fetched ${new Date(at).toLocaleString(locale(), DATE_TIME)})`)
              : ''}{' '}
        <button className="link-btn" onClick={() => void refreshModels(true)}>
          {tr('取り直す', 'Refresh')}
        </button>
      </div>
      <div className="ai-models scroll">
        {list.map((m) => {
          const cost = taskCostEstimate(task, { ...useAi.getState(), tasks: { ...useAi.getState().tasks, [task]: { ...cfg, model: m.id } }, models: models.length ? models : [m] });
          const isNew = m.created > 0 && now - m.created < 30 * 86400;
          return (
            <button key={m.id} className={`ai-model ${cfg.model === m.id ? 'on' : ''}`} onClick={() => setTaskConfig(task, { model: m.id, fallback: cfg.fallback === m.id ? null : cfg.fallback })}>
              <div className="row" style={{ gap: 6 }}>
                <b className="ellipsis">{m.name}</b>
                {m.id === def.model && <span className="ai-badge rec">{tr('おすすめ', 'Recommended')}</span>}
                {isNew && m.id !== def.model && <span className="ai-badge new">{tr('新着', 'New')}</span>}
                <span className="grow" />
                {m.created > 0 && <span className="mono lbl">{new Date(m.created * 1000).toLocaleDateString(locale(), { month: '2-digit', day: '2-digit' })}</span>}
              </div>
              <div className="mono lbl ellipsis">{m.id}</div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <span className="mono lbl">
                  {perMillion(m.pricePrompt)} / {perMillion(m.priceCompletion)} · {tr(`1回 約 ${formatUsd(cost)}`, `~${formatUsd(cost)} per run`)}
                </span>
                <span className="grow" />
                <CapTags m={m} />
              </div>
            </button>
          );
        })}
        {list.length === 0 && <div className="lbl">{tr('見つかりません。「この処理に使えるものだけ」を外すと増えます。', 'Nothing found. Turn off "Only models that fit this task" to see more.')}</div>}
      </div>
      <div className="lbl" style={{ marginTop: 10 }}>
        {tr('このモデルが使えないときの予備', "Fallback when this model isn't available")}
      </div>
      <select className="field" value={cfg.fallback ?? ''} onChange={(e) => setTaskConfig(task, { fallback: e.target.value || null })}>
        <option value="">{tr('なし', 'None')}</option>
        {cfg.fallback && !fallbackOptions.some((m) => m.id === cfg.fallback) && <option value={cfg.fallback}>{cfg.fallback}</option>}
        {fallbackOptions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({perMillion(m.pricePrompt)} / {perMillion(m.priceCompletion)})
          </option>
        ))}
      </select>
      <p className="lbl" style={{ margin: '4px 0 0' }}>{tr('予備は OpenRouter のフォールバック指定（models）で渡します。', "The fallback is passed with OpenRouter's fallback setting (models).")}</p>
    </aside>
  );
}
