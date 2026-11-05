// 難易度ガイドラインの画面：レベル帯ごとの要素の出現率、基準文（AI の下書き → 作者が確定）、基準から外れた譜面、代表譜面。
import { tr, pl, locale } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd, modelLabel } from '../ai/tasks';
import { downloadBytes } from '../fs/folder';
import { FEATURE_DEFS } from '../gen/features';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { NO_FOLDER_PICK } from '../store/device';
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
  scanFromZip,
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
  const zipInput = useRef<HTMLInputElement>(null);
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
          {Icon.back(14)}{' '}
          {from === 'ai'
            ? tr('AI難易度生成に戻る', 'Back to AI difficulties')
            : from === 'settings'
              ? tr('設定に戻る', 'Back to settings')
              : from === 'library'
                ? tr('ライブラリに戻る', 'Back to library')
                : tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        <h1>{tr('難易度ガイドライン', 'Difficulty guidelines')}</h1>
        <span className="lbl hide-narrow">
          {tr(`v${st.guide.version} · 手元${songs}曲・${st.charts.length}譜面から作成`, `v${st.guide.version} · built from ${songs} local ${pl(songs, 'song')}, ${st.charts.length} ${pl(st.charts.length, 'chart')}`)}
          {st.guide.updatedAt
            ? tr(
                ` · ${new Date(st.guide.updatedAt).toLocaleDateString(locale(), { month: '2-digit', day: '2-digit' })} 更新`,
                ` · updated ${new Date(st.guide.updatedAt).toLocaleDateString(locale(), { month: '2-digit', day: '2-digit' })}`,
              )
            : ''}
        </span>
        <span className="grow" />
        <span className={`pill ${hasKey ? 'ok' : ''}`} title={hasKey ? undefined : noKeyTitle()}>
          {hasKey ? tr('● OpenRouter · キー設定済み', '● OpenRouter · key set') : tr('キー未設定（集計と手書きは使えます）', 'No API key (stats and hand-written guidelines still work)')}
        </span>
        <button className="btn small" onClick={() => jsonInput.current?.click()}>
          {tr('読み込み', 'Import')}
        </button>
        <button className="btn small" onClick={exportJson}>
          {tr('書き出し（.json）', 'Export (.json)')}
        </button>
        {NO_FOLDER_PICK ? (
          // iPad：フォルダを選べないので、曲フォルダの ZIP から
          <button className="btn small primary" onClick={() => zipInput.current?.click()} disabled={!!st.scanning}>
            {Icon.zip(14)} {tr('曲のZIPを取り込んで再集計', 'Import a song ZIP and recompute')}
          </button>
        ) : (
          <button className="btn small primary" onClick={() => void pickAndScan(folderInput.current)} disabled={!!st.scanning}>
            {Icon.plus(14)} {tr('曲を取り込んで再集計', 'Import songs and recompute')}
          </button>
        )}
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void scanFromZip(f);
          }}
        />
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
            toast(ok ? tr('ガイドラインを読み込みました', 'Imported the guidelines') : tr('ガイドラインのファイルではありません', "That isn't a guidelines file"), ok ? 'ok' : 'error');
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
            {tr('レベル帯', 'Level bands')}
          </div>
          {BANDS.map((b) => {
            const s = stats[b - 1];
            const g = st.guide.bands[b];
            const max = Math.max(1, ...stats.map((x) => x.count));
            return (
              <button key={b} className={`guide-band ${band === b ? 'on' : ''}`} onClick={() => useGuideline.setState({ band: b })}>
                <div className="row" style={{ gap: 6 }}>
                  <b>{tr(`Lv${b}台`, `Lv${b}.x`)}</b>
                  <span className="lbl">{tr(`${s.count}譜面`, `${s.count} ${pl(s.count, 'chart')}`)}</span>
                  <span className="grow" />
                  <span className={`guide-st ${g?.status ?? 'none'}`}>
                    {g?.status === 'confirmed' ? tr('● 確定', '● Final') : g?.status === 'ai' ? tr('● AI下書き', '● AI draft') : tr('● 未作成', '● None')}
                  </span>
                </div>
                <div className="guide-meter">
                  <i style={{ width: `${(s.count / max) * 100}%` }} />
                </div>
              </button>
            );
          })}
          <div className="card guide-note">
            {tr('基準に使う譜面', 'Charts used')} {used} / {st.charts.length}
            <br />
            {tr('外した譜面', 'Excluded')} {excluded}
            {noLevel > 0 && (
              <>
                <br />
                {tr(`レベル未記入 ${noLevel}（集計に入れない）`, `No level ${noLevel} (not counted)`)}
              </>
            )}
            <br />
            {tr('レベルは各曲の #DLEVEL をそのまま使います', "Levels come straight from each song's #DLEVEL")}
          </div>
        </nav>
        <main className="guide-main scroll">
          {st.charts.length === 0 && (
            <div className="card guide-empty">
              <h3>{tr('手元の曲から基準を作ります', 'Build guidelines from your local songs')}</h3>
              <p className="lbl">
                {tr(
                  '「曲を取り込んで再集計」で DTXFiles などの曲フォルダ（親フォルダでも可）を選ぶと、各譜面を解析してレベル帯ごとに「どの要素が出てくるか」を集計します。音は取り込みません。音源ライブラリに曲を取り込んだときも集計に加わります。',
                  'Use "Import songs and recompute" to choose a song folder such as DTXFiles (a parent folder works too). Each chart is analyzed, and which elements appear is counted per level band. No audio is imported. Songs imported into the sound library are counted too.',
                )}
              </p>
            </div>
          )}
          <section className="card">
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <h3>{tr('要素の出現率（レベル帯ごと）', 'How often elements appear (per level band)')}</h3>
              <span className="grow" />
              <span className="lbl hide-narrow">{tr('その要素が出てくる譜面の割合。列を押すと下と右の基準に切り替わります', 'Share of charts that contain each element. Click a column to switch the guidelines below and on the right')}</span>
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
              <h3>{tr(`Lv${band}台の基準`, `Guidelines for Lv${band}.x`)}</h3>
              {gb.status === 'ai' && <span className="ai-badge rec">{tr('AIの下書き・未確定', 'AI draft · not final')}</span>}
              {gb.status === 'confirmed' && <span className="ai-badge ok">{tr('確定', 'Final')}</span>}
              <span className="grow" />
              <button className="btn small primary" disabled={gb.rows.length === 0 || gb.status === 'confirmed'} onClick={() => confirmBand(band)}>
                {tr('この基準で確定', 'Make final')}
              </button>
              <button className="btn small" onClick={() => addRow(band)}>
                {Icon.plus(13)} {tr('行を追加', 'Add row')}
              </button>
              <button
                className="btn small on-amber"
                disabled={!hasKey || running || bs.count === 0}
                title={hasKey ? tr(`${model} · 1回 約 ${formatUsd(cost)}（全レベル帯）`, `${model} · ~${formatUsd(cost)} per run (all level bands)`) : noKeyTitle()}
                onClick={() => void draftWithAi([band])}
              >
                {Icon.sparkle(13)} {running ? tr('下書き中…', 'Drafting…') : gb.rows.length ? tr('AIで下書きし直す', 'Redraft with AI') : tr('AIで下書き', 'Draft with AI')}
              </button>
            </div>
            {!hasKey && (
              <p className="lbl" style={{ margin: '6px 0 0' }}>
                {noKeyTitle()}
                {tr('。基準文は「行を追加」で手で書けます。', '. You can write guidelines by hand with "Add row".')}{' '}
                <button className="link-btn" onClick={() => openSettings('ai')}>
                  {tr('キーを設定', 'Set API key')}
                </button>
              </p>
            )}
            {hasKey && st.charts.length > 0 && BANDS.some((b) => (st.guide.bands[b]?.rows.length ?? 0) === 0 && stats[b - 1].count > 0) && (
              <p className="lbl" style={{ margin: '6px 0 0' }}>
                {tr('基準の無いレベル帯があります。', 'Some level bands have no guidelines.')}{' '}
                <button className="link-btn" disabled={running} onClick={() => void draftWithAi(BANDS.filter((b) => (st.guide.bands[b]?.rows.length ?? 0) === 0))}>
                  {tr('まとめてAIで下書き', 'Draft them all with AI')}
                </button>
              </p>
            )}
            <div className="guide-rows">
              {gb.rows.length === 0 && <div className="lbl">{tr('まだ基準文がありません。', 'No guidelines yet.')}</div>}
              {gb.rows.map((r, i) => (
                <div key={i} className="guide-row">
                  <span className="mono lbl">{i + 1}</span>
                  <div className="grow">
                    <RowInput value={r.text} onCommit={(v) => setRow(band, i, v)} />
                    {r.basis && (
                      <div className="lbl">
                        {tr('根拠: ', 'Basis: ')}
                        {r.basis}
                      </div>
                    )}
                  </div>
                  <span className={`ai-badge ${r.origin === 'ai' ? 'rec' : 'edit'}`}>{r.origin === 'ai' ? 'AI' : r.origin === 'edited' ? tr('手直し', 'Edited') : tr('手書き', 'Hand-written')}</span>
                  <button className="ib tiny" onClick={() => removeRow(band, i)} title={tr('この行を消す', 'Delete this row')}>
                    {Icon.close(12)}
                  </button>
                </div>
              ))}
            </div>
            <div className="guide-stats">
              <Stat label={tr('密度の中央値', 'Median density')} value={bs.count ? bs.density.toFixed(1) : '—'} unit={tr('ノーツ/秒', ' notes/s')} />
              <Stat label={tr('最大同時打数', 'Max simultaneous hits')} value={bs.count ? String(Math.round(bs.maxChord)) : '—'} />
              <Stat label={tr('BPMの中央値', 'Median BPM')} value={bs.count ? String(Math.round(bs.bpm)) : '—'} />
              <Stat label={tr('ノーツ数の中央値', 'Median note count')} value={bs.count ? String(Math.round(bs.notes)) : '—'} />
            </div>
          </section>
        </main>
        <aside className="guide-side scroll">
          <div className="row" style={{ gap: 6 }}>
            <h3>{tr('基準から外れている譜面', 'Charts that stand out')}</h3>
            <span className="grow" />
            <span className="lbl">{tr(`${outliers.length}件`, String(outliers.length))}</span>
          </div>
          {outliers.length === 0 && (
            <p className="lbl">
              {st.charts.length < 6
                ? tr('譜面が増えると、近い譜面と比べて外れているものを出します。', 'With more charts, ones that differ from similar charts are shown here.')
                : tr('大きく外れている譜面はありません。', 'No charts stand out much.')}
            </p>
          )}
          {outliers.slice(0, 12).map((o) => (
            <div key={o.c.id} className={`card guide-out ${o.c.excluded ? 'off' : ''}`}>
              <div className="row" style={{ gap: 6 }}>
                <b className="ellipsis">{o.c.song}</b>
                <span className="grow" />
                <span className="mono lbl">{o.c.label}</span>
              </div>
              <div className="mono" style={{ fontSize: 12 }}>
                {tr('登録', 'Listed')} {o.c.level!.toFixed(2)} → {tr('基準だと', 'guidelines say')} <span style={{ color: 'var(--amber)' }}>{tr(`${o.predicted.toFixed(1)}前後`, `about ${o.predicted.toFixed(1)}`)}</span>
              </div>
              <div className="lbl">
                {o.predicted < o.c.level!
                  ? tr('特徴の近い譜面より登録レベルが高めです', 'Its listed level is higher than charts with similar features')
                  : tr('特徴の近い譜面より登録レベルが低めです', 'Its listed level is lower than charts with similar features')}
              </div>
              <button className="btn small" style={{ marginTop: 6 }} onClick={() => void setExcluded(o.c.id, !o.c.excluded)}>
                {o.c.excluded ? tr('基準に戻す', 'Include again') : tr('基準から外す', 'Exclude')}
              </button>
            </div>
          ))}
          <div className="row" style={{ gap: 6, marginTop: 14 }}>
            <h3>{tr(`Lv${band}台の代表譜面`, `Representative Lv${band}.x charts`)}</h3>
            <span className="grow" />
            <span className="lbl">{tr('判定の比較に使う', 'Used for comparison in level checks')}</span>
          </div>
          <div className="guide-reps">
            {reps.length === 0 && <div className="lbl">{tr('このレベル帯の譜面はまだありません。', 'No charts in this level band yet.')}</div>}
            {reps.map((c) => (
              <div key={c.id} className="row" style={{ gap: 6 }}>
                <span className="ellipsis grow">{c.song}</span>
                <span className="mono lbl">{c.label}</span>
                <span className="mono">{c.level!.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <p className="lbl" style={{ marginTop: 12 }}>
            {tr(
              'この基準は、AIのレベル判定とAI難易度生成の目標の両方に使います。曲を取り込むたびに出現率を集計し直し、外れた譜面をここに出します。',
              'These guidelines are used both for AI level checks and for targets in the AI difficulty generator. Each import recomputes the rates and shows charts that stand out here.',
            )}
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
      placeholder={tr('例: 8分のハイハットが土台で、サビの一部で16分の刻みが入る', 'e.g. 8th-note hi-hat as the base, with some 16th notes in parts of the chorus')}
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
