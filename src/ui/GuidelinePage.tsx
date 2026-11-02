// 難易度ガイドラインの画面：レベル帯ごとの要素の出現率、基準文（AI の下書き → 作者が確定）、基準から外れた譜面、代表譜面。
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { downloadBytes } from '../fs/folder';
import { FEATURE_DEFS } from '../gen/features';
import { NO_KEY_TITLE, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { goBack, openSettings, toast, useEditor } from '../store/editor';
import {
  addRow,
  BANDS,
  bandStats,
  confirmBand,
  draftWithAi,
  exportGuideline,
  findOutliers,
  importGuideline,
  loadGuideline,
  pickAndScan,
  removeRow,
  representatives,
  scanFromFileList,
  setExcluded,
  setRow,
  useGuideline,
} from '../store/guideline';
import { FolderInput } from './Editor';
import { Icon } from './icons';

export function GuidelinePage() {
  const st = useGuideline();
  const hasKey = useHasAiKey();
  const running = useAi((s) => (s.running.guideline ?? 0) > 0);
  const model = useAi((s) => modelLabel(s.tasks.guideline.model, s.models));
  const cost = useAi(() => taskCostEstimate('guideline'));
  const folderInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const from = useEditor((s) => s.returnPage);
  useEffect(() => {
    void loadGuideline();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-back') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) goBack();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const stats = useMemo(() => bandStats(st.charts), [st.charts]);
  const outliers = useMemo(() => findOutliers(st.charts), [st.charts]);
  const band = st.band;
  const bs = stats[band - 1];
  const gb = st.guide.bands[band] ?? { status: 'none', rows: [] };
  const used = st.charts.filter((c) => !c.excluded && c.level !== null).length;
  const excluded = st.charts.filter((c) => c.excluded).length;
  const songs = new Set(st.charts.map((c) => `${c.folder}/${c.song}`)).size;
  const reps = representatives(st.charts, band, 3);
  const noLevel = st.charts.filter((c) => c.level === null).length;

  const exportJson = () => downloadBytes('dtx-guideline.json', new TextEncoder().encode(exportGuideline()), 'application/json');

  return (
    <div className="guide-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={goBack}>
          {Icon.back(14)} {from === 'ai' ? 'AI難易度生成に戻る' : from === 'settings' ? '設定に戻る' : from === 'library' ? 'ライブラリに戻る' : 'エディタに戻る'}
        </button>
        <div className="vsep" />
        <h1>難易度ガイドライン</h1>
        <span className="lbl hide-narrow">
          v{st.guide.version} · 手元{songs}曲・{st.charts.length}譜面から作成{st.guide.updatedAt ? ` · ${new Date(st.guide.updatedAt).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })} 更新` : ''}
        </span>
        <span className="grow" />
        <span className={`pill ${hasKey ? 'ok' : ''}`} title={hasKey ? undefined : NO_KEY_TITLE}>
          {hasKey ? '● OpenRouter · キー設定済み' : 'キー未設定（集計と手書きは使えます）'}
        </span>
        <button className="btn small" onClick={() => jsonInput.current?.click()}>
          読み込み
        </button>
        <button className="btn small" onClick={exportJson}>
          書き出し（.json）
        </button>
        <button className="btn small primary" onClick={() => void pickAndScan(folderInput.current)} disabled={!!st.scanning}>
          {Icon.plus(14)} 曲を取り込んで再集計
        </button>
        <input
          ref={jsonInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const ok = await importGuideline(await f.text());
            toast(ok ? 'ガイドラインを読み込みました' : 'ガイドラインのファイルではありません', ok ? 'ok' : 'error');
          }}
        />
        <FolderInput inputRef={folderInput} onFiles={(l) => void scanFromFileList(l)} />
      </header>
      {st.scanning && (
        <div className="lib-banner">
          {st.scanning.label} {st.scanning.total ? `${st.scanning.done} / ${st.scanning.total}` : ''}
        </div>
      )}
      <div className="guide-body">
        <nav className="guide-bands">
          <div className="lbl" style={{ padding: '0 6px 6px' }}>
            レベル帯
          </div>
          {BANDS.map((b) => {
            const s = stats[b - 1];
            const g = st.guide.bands[b];
            const max = Math.max(1, ...stats.map((x) => x.count));
            return (
              <button key={b} className={`guide-band ${band === b ? 'on' : ''}`} onClick={() => useGuideline.setState({ band: b })}>
                <div className="row" style={{ gap: 6 }}>
                  <b>Lv{b}台</b>
                  <span className="lbl">{s.count}譜面</span>
                  <span className="grow" />
                  <span className={`guide-st ${g?.status ?? 'none'}`}>{g?.status === 'confirmed' ? '● 確定' : g?.status === 'ai' ? '● AI下書き' : '● 未作成'}</span>
                </div>
                <div className="guide-meter">
                  <i style={{ width: `${(s.count / max) * 100}%` }} />
                </div>
              </button>
            );
          })}
          <div className="card guide-note">
            基準に使う譜面 {used} / {st.charts.length}
            <br />
            外した譜面 {excluded}
            {noLevel > 0 && (
              <>
                <br />
                レベル未記入 {noLevel}（集計に入れない）
              </>
            )}
            <br />
            レベルは各曲の #DLEVEL をそのまま使います
          </div>
        </nav>
        <main className="guide-main scroll">
          {st.charts.length === 0 && (
            <div className="card guide-empty">
              <h3>手元の曲から基準を作ります</h3>
              <p className="lbl">
                「曲を取り込んで再集計」で DTXFiles などの曲フォルダ（親フォルダでも可）を選ぶと、各譜面を解析してレベル帯ごとに「どの要素が出てくるか」を集計します。音は取り込みません。音源ライブラリに曲を取り込んだときも集計に加わります。
              </p>
            </div>
          )}
          <section className="card">
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <h3>要素の出現率（レベル帯ごと）</h3>
              <span className="grow" />
              <span className="lbl hide-narrow">その要素が出てくる譜面の割合。列を押すと下と右の基準に切り替わります</span>
            </div>
            <div className="guide-table-wrap">
              <table className="guide-table">
                <thead>
                  <tr>
                    <th />
                    {BANDS.map((b) => (
                      <th key={b} className={band === b ? 'on' : ''} onClick={() => useGuideline.setState({ band: b })}>
                        Lv{b}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FEATURE_DEFS.map((d) => (
                    <tr key={d.key}>
                      <td className="rowh">{d.label}</td>
                      {stats.map((s) => {
                        const r = s.rates[d.key];
                        return (
                          <td key={s.band} className={band === s.band ? 'on' : ''} onClick={() => useGuideline.setState({ band: s.band })} style={{ background: s.count && r > 0 ? `rgba(76,194,255,${0.1 + r * 0.6})` : undefined }}>
                            {s.count === 0 || r === 0 ? '–' : `${Math.round(r * 100)}%`}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h3>Lv{band}台の基準</h3>
              {gb.status === 'ai' && <span className="ai-badge rec">AIの下書き・未確定</span>}
              {gb.status === 'confirmed' && <span className="ai-badge ok">確定</span>}
              <span className="grow" />
              <button className="btn small primary" disabled={gb.rows.length === 0 || gb.status === 'confirmed'} onClick={() => confirmBand(band)}>
                この基準で確定
              </button>
              <button className="btn small" onClick={() => addRow(band)}>
                {Icon.plus(13)} 行を追加
              </button>
              <button
                className="btn small on-amber"
                disabled={!hasKey || running || bs.count === 0}
                title={hasKey ? `${model} · 1回 約 ${formatUsd(cost)}（全レベル帯）` : NO_KEY_TITLE}
                onClick={() => void draftWithAi([band])}
              >
                {Icon.sparkle(13)} {running ? '下書き中…' : gb.rows.length ? 'AIで下書きし直す' : 'AIで下書き'}
              </button>
            </div>
            {!hasKey && (
              <p className="lbl" style={{ margin: '6px 0 0' }}>
                {NO_KEY_TITLE}。基準文は「行を追加」で手で書けます。{' '}
                <button className="link-btn" onClick={() => openSettings('ai')}>
                  キーを設定
                </button>
              </p>
            )}
            {hasKey && st.charts.length > 0 && BANDS.some((b) => (st.guide.bands[b]?.rows.length ?? 0) === 0 && stats[b - 1].count > 0) && (
              <p className="lbl" style={{ margin: '6px 0 0' }}>
                基準の無いレベル帯があります。{' '}
                <button className="link-btn" disabled={running} onClick={() => void draftWithAi(BANDS.filter((b) => (st.guide.bands[b]?.rows.length ?? 0) === 0))}>
                  まとめてAIで下書き
                </button>
              </p>
            )}
            <div className="guide-rows">
              {gb.rows.length === 0 && <div className="lbl">まだ基準文がありません。</div>}
              {gb.rows.map((r, i) => (
                <div key={i} className="guide-row">
                  <span className="mono lbl">{i + 1}</span>
                  <div className="grow">
                    <RowInput value={r.text} onCommit={(v) => setRow(band, i, v)} />
                    {r.basis && <div className="lbl">根拠: {r.basis}</div>}
                  </div>
                  <span className={`ai-badge ${r.origin === 'ai' ? 'rec' : 'edit'}`}>{r.origin === 'ai' ? 'AI' : r.origin === 'edited' ? '手直し' : '手書き'}</span>
                  <button className="ib tiny" onClick={() => removeRow(band, i)} title="この行を消す">
                    {Icon.close(12)}
                  </button>
                </div>
              ))}
            </div>
            <div className="guide-stats">
              <Stat label="密度の中央値" value={bs.count ? bs.density.toFixed(1) : '—'} unit="ノーツ/秒" />
              <Stat label="最大同時打数" value={bs.count ? String(Math.round(bs.maxChord)) : '—'} />
              <Stat label="BPMの中央値" value={bs.count ? String(Math.round(bs.bpm)) : '—'} />
              <Stat label="ノーツ数の中央値" value={bs.count ? String(Math.round(bs.notes)) : '—'} />
            </div>
          </section>
        </main>
        <aside className="guide-side scroll">
          <div className="row" style={{ gap: 6 }}>
            <h3>基準から外れている譜面</h3>
            <span className="grow" />
            <span className="lbl">{outliers.length}件</span>
          </div>
          {outliers.length === 0 && <p className="lbl">{st.charts.length < 6 ? '譜面が増えると、近い譜面と比べて外れているものを出します。' : '大きく外れている譜面はありません。'}</p>}
          {outliers.slice(0, 12).map((o) => (
            <div key={o.c.id} className={`card guide-out ${o.c.excluded ? 'off' : ''}`}>
              <div className="row" style={{ gap: 6 }}>
                <b className="ellipsis">{o.c.song}</b>
                <span className="grow" />
                <span className="mono lbl">{o.c.label}</span>
              </div>
              <div className="mono" style={{ fontSize: 12 }}>
                登録 {o.c.level!.toFixed(2)} → 基準だと <span style={{ color: 'var(--amber)' }}>{o.predicted.toFixed(1)}前後</span>
              </div>
              <div className="lbl">{o.predicted < o.c.level! ? '特徴の近い譜面より登録レベルが高めです' : '特徴の近い譜面より登録レベルが低めです'}</div>
              <button className="btn small" style={{ marginTop: 6 }} onClick={() => void setExcluded(o.c.id, !o.c.excluded)}>
                {o.c.excluded ? '基準に戻す' : '基準から外す'}
              </button>
            </div>
          ))}
          <div className="row" style={{ gap: 6, marginTop: 14 }}>
            <h3>Lv{band}台の代表譜面</h3>
            <span className="grow" />
            <span className="lbl">判定の比較に使う</span>
          </div>
          <div className="guide-reps">
            {reps.length === 0 && <div className="lbl">このレベル帯の譜面はまだありません。</div>}
            {reps.map((c) => (
              <div key={c.id} className="row" style={{ gap: 6 }}>
                <span className="ellipsis grow">{c.song}</span>
                <span className="mono lbl">{c.label}</span>
                <span className="mono">{c.level!.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <p className="lbl" style={{ marginTop: 12 }}>
            この基準は、AIのレベル判定とAI難易度生成の目標の両方に使います。曲を取り込むたびに出現率を集計し直し、外れた譜面をここに出します。
          </p>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="guide-stat">
      <div className="lbl">{label}</div>
      <div className="mono">
        {value}
        {unit && <span className="lbl">{unit}</span>}
      </div>
    </div>
  );
}

function RowInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea
      className="guide-text"
      rows={1}
      value={v}
      placeholder="例: 8分のハイハットが土台で、サビの一部で16分の刻みが入る"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}
