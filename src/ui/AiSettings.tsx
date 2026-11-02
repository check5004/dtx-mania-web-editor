// 設定 › AI（OpenRouter）：キーと使用額、処理ごとのモデル・推論の強さ・予備のモデル、使いすぎ防止。
import { useEffect, useMemo, useState } from 'react';
import type { Effort, OrModel } from '../ai/openrouter';
import { formatUsd, meetsNeeds, modelInfo, perMillion, sortModels, taskDef, TASKS, type AiTask, type ModelSort } from '../ai/tasks';
import { checkKey, refreshModels, resetTasks, setKey, setLimits, setRemember, setTaskConfig, taskCostEstimate, useAi } from '../store/ai';

const EFFORTS: { v: Effort; label: string }[] = [
  { v: 'none', label: 'なし' },
  { v: 'low', label: '低' },
  { v: 'medium', label: '中' },
  { v: 'high', label: '高' },
];

export function AiSettings() {
  const [sel, setSel] = useState<AiTask>('level');
  useEffect(() => {
    void refreshModels();
    if (useAi.getState().key) void checkKey();
  }, []);
  return (
    <div className="ai-set">
      <div className="ai-set-main">
        <ConnectionCard />
        <TaskTable sel={sel} onSel={setSel} />
        <div className="ai-set-2col">
          <LimitsCard />
          <PrivacyCard />
        </div>
        <SpendCard />
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
      <span className="pill ok">● 接続OK</span>
    ) : status === 'checking' ? (
      <span className="pill">確認中…</span>
    ) : status === 'error' ? (
      <span className="pill warn">つながりません</span>
    ) : (
      <span className="pill">キー未設定</span>
    );
  return (
    <section className="card ai-card">
      <div className="row" style={{ gap: 10 }}>
        <h3>OpenRouterとの接続</h3>
        {pill}
        <span className="grow" />
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
          キーを発行する（OpenRouter）
        </a>
      </div>
      <div className="ai-conn">
        <div className="ai-key">
          <div className="lbl">APIキー</div>
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
            <button className="btn small ghost" onClick={() => setShow(!show)} title="キーを表示する・隠す">
              {show ? '隠す' : '表示'}
            </button>
            <button className="btn small" onClick={() => (draft !== key ? setKey(draft) : void checkKey())} disabled={!draft.trim()}>
              接続テスト
            </button>
          </div>
        </div>
        <Tile label="今日の使用額" value={info?.usageDaily ?? null} />
        <Tile label="今月の使用額" value={info?.usageMonthly ?? null} />
        <Tile label="キーの残り上限" value={info ? info.limitRemaining : null} empty={info && info.limit === null ? '上限なし' : '—'} />
      </div>
      {status === 'error' && err && <div className="ai-err">{err}</div>}
      <div className="row" style={{ gap: 18, marginTop: 8 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={remember} onChange={() => setRemember(true)} />
          このブラウザに保存する
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={!remember} onChange={() => setRemember(false)} />
          保存しない（タブを閉じたら消す）
        </label>
        {key && (
          <button className="link-btn" onClick={() => setKey('')}>
            キーを消す
          </button>
        )}
      </div>
      <p className="lbl" style={{ margin: '6px 0 0' }}>
        使用額と上限はキーの情報（/api/v1/key）から取得。キーは暗号化されずにこのブラウザに保存され、OpenRouter にだけ直接送ります。共用のPCでは「保存しない」を選んでください。
      </p>
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
        <h3>処理ごとのモデル</h3>
        <span className="lbl hide-narrow">行を選ぶと右でモデルを選べます。料金は100万トークンあたり（入力 / 出力）</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={resetTasks}>
          すべておすすめに戻す
        </button>
      </div>
      <div className="ai-table">
        <div className="ai-tr head">
          <span>処理</span>
          <span>モデル</span>
          <span>料金</span>
          <span>推論の強さ</span>
          <span style={{ textAlign: 'right' }}>1回の目安</span>
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
                  送る内容: {t.sends}
                </span>
              </span>
              <span>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <b>{m?.name ?? cfg.model}</b>
                  {cfg.model === t.model && <span className="ai-badge rec">おすすめ</span>}
                </span>
                <span className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                  {m && <CapTags m={m} />}
                  {!m && <span className="lbl">一覧にないモデル</span>}
                  {cfg.fallback && <span className="lbl">予備: {modelInfo(cfg.fallback, models)?.name ?? cfg.fallback}</span>}
                </span>
              </span>
              <span className="mono lbl">
                {m ? `${perMillion(m.pricePrompt)} / ${perMillion(m.priceCompletion)}` : '—'}
                {t.needs.web && m && <span style={{ display: 'block' }}>Web検索 {formatUsd(m.priceWebSearch || 0.02)}/回</span>}
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <div className="seg small">
                  {EFFORTS.map((e) => (
                    <button
                      key={e.v}
                      className={cfg.effort === e.v ? 'on' : ''}
                      disabled={!!m && !m.reasoning && e.v !== 'none'}
                      title={m && !m.reasoning ? 'このモデルは推論の強さを選べません' : undefined}
                      onClick={() => setTaskConfig(t.id, { effort: e.v })}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </span>
              <span className="mono" style={{ textAlign: 'right' }}>
                約 {formatUsd(cost)}
                {t.per && <span className="lbl" style={{ display: 'block' }}>{t.per.replace(' / ', '/ ')}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="lbl" style={{ margin: '8px 0 0' }}>
        おすすめは 2026-11-02 時点の OpenRouter の一覧から、処理に必要な機能と料金で選んでいます。アプリの更新でおすすめも見直します。
      </p>
    </section>
  );
}

function CapTags({ m }: { m: OrModel }) {
  return (
    <>
      {m.web && <span className="ai-tag">Web検索</span>}
      {m.reasoning && <span className="ai-tag">推論</span>}
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
      <h3>使いすぎ防止</h3>
      <div className="ai-limits">
        <label>
          <span className="lbl">1回の目安がこれを超えたら確認する</span>
          <MoneyInput value={confirmOver} onChange={(v) => setLimits({ confirmOver: v })} />
        </label>
        <label>
          <span className="lbl">このアプリで使う月の上限</span>
          <MoneyInput value={cap} onChange={(v) => setLimits({ monthlyCap: v })} />
        </label>
      </div>
      <div className="lbl" style={{ marginTop: 10 }}>
        今月このアプリで使った額 <b className="mono" style={{ color: 'var(--text)' }}>{formatUsd(spend.monthTotal)}</b> / 上限 {formatUsd(cap)}（今日 {formatUsd(spend.dayTotal)}）
      </div>
      <div className="ai-bar">
        <i style={{ width: `${ratio * 100}%`, background: ratio > 0.9 ? 'var(--danger)' : ratio > 0.7 ? 'var(--amber)' : 'var(--accent)' }} />
      </div>
      <p className="lbl" style={{ margin: '6px 0 0' }}>上限に届く呼び出しは送らずに止めます。費用は OpenRouter が返した額（無ければトークン数からの計算）で記録します。</p>
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
      <h3>AIに送るもの・送らないもの</h3>
      <ul className="ai-list">
        <li>音声そのものは送りません。原曲は「打点の強さ」の数値にしてから渡します</li>
        <li>譜面は小節・レーン・位置の一覧と、そこから出した特徴量だけを送ります</li>
        <li>曲情報の取得では、曲名・アーティスト名・YouTubeの動画タイトルを送り、Web検索で裏を取ります</li>
        <li>キーはこのブラウザから OpenRouter に直接送ります（このアプリにサーバーはありません）</li>
        <li>キーが無くても、AI以外の機能はすべて使えます</li>
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
      <h3>最近の呼び出し</h3>
      <div className="ai-log">
        {log.slice(0, 8).map((l, i) => (
          <div key={i} className="row" style={{ gap: 10 }}>
            <span className="mono lbl">{new Date(l.at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
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
      <div className="lbl">モデルを選ぶ</div>
      <h3 style={{ margin: '2px 0 10px' }}>{def.label} に使うモデル</h3>
      <input className="field" placeholder="名前・提供元で検索" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row" style={{ gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
        <button className={`tag ${only ? 'on' : ''}`} onClick={() => setOnly(!only)} title={`必要な機能: ${[def.needs.json && 'JSON出力', def.needs.reasoning && '推論', def.needs.web && 'Web検索'].filter(Boolean).join('・')}`}>
          この処理に使えるものだけ
        </button>
        <div className="seg small">
          {(
            [
              ['recommended', 'おすすめ'],
              ['cheap', '安い順'],
              ['new', '新しい順'],
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
          ? 'OpenRouter から一覧を取得中…'
          : status === 'error'
            ? `一覧を取得できませんでした（${err}）。初期のモデルだけ出しています`
            : at
              ? `一覧 ${models.length} 件（${new Date(at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 取得）`
              : ''}{' '}
        <button className="link-btn" onClick={() => void refreshModels(true)}>
          取り直す
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
                {m.id === def.model && <span className="ai-badge rec">おすすめ</span>}
                {isNew && m.id !== def.model && <span className="ai-badge new">新着</span>}
                <span className="grow" />
                {m.created > 0 && <span className="mono lbl">{new Date(m.created * 1000).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })}</span>}
              </div>
              <div className="mono lbl ellipsis">{m.id}</div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <span className="mono lbl">
                  {perMillion(m.pricePrompt)} / {perMillion(m.priceCompletion)} · 1回 約 {formatUsd(cost)}
                </span>
                <span className="grow" />
                <CapTags m={m} />
              </div>
            </button>
          );
        })}
        {list.length === 0 && <div className="lbl">見つかりません。「この処理に使えるものだけ」を外すと増えます。</div>}
      </div>
      <div className="lbl" style={{ marginTop: 10 }}>
        このモデルが使えないときの予備
      </div>
      <select className="field" value={cfg.fallback ?? ''} onChange={(e) => setTaskConfig(task, { fallback: e.target.value || null })}>
        <option value="">なし</option>
        {cfg.fallback && !fallbackOptions.some((m) => m.id === cfg.fallback) && <option value={cfg.fallback}>{cfg.fallback}</option>}
        {fallbackOptions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}（{perMillion(m.pricePrompt)} / {perMillion(m.priceCompletion)}）
          </option>
        ))}
      </select>
      <p className="lbl" style={{ margin: '4px 0 0' }}>予備は OpenRouter のフォールバック指定（models）で渡します。</p>
    </aside>
  );
}
