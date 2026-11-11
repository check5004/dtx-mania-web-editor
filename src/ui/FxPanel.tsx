// エフェクトの編集の右パネル：カーブの一覧（かけるレーン・境目の強調）・カーブを足す・テンプレート・原曲から読み取る、
// 選んだ点（値の ‹ ›・次の点までの形）、作る音（数・なめらかさ・長く鳴る音）。
import { pl, tr } from '../i18n';
import { useState } from 'react';
import { DRUM_LANES, drumChannel } from '../dtx/model';
import { FX_COLORS, pointBeat, sortPoints, type FxEmphasis, type FxRes, type FxType } from '../fx/model';
import { FX_TEMPLATES } from '../fx/templates';
import { useAssist } from '../store/assist';
import { tempoOf } from '../store/derived';
import { useEditor } from '../store/editor';
import {
  addCurve,
  adoptProposals,
  applyTemplate,
  curveRegions,
  dropProposals,
  fxStats,
  FX_SHAPES,
  lanesText,
  openFx,
  openRead,
  readFromOriginal,
  removeCurve,
  selectCurve,
  setCurveLanes,
  setCurveQ,
  setFxRes,
  setFxTails,
  setPointShape,
  setReadOpts,
  shapeName,
  stepSelectedPoint,
  thinProposals,
  toggleCurveLane,
  typeName,
  useFx,
  valueText,
  WAV_LOW,
  type FxReadScope,
  type FxReadWhat,
} from '../store/fx';
import { useSidecar } from '../store/sidecar';
import { visibleBeats } from './ChartCanvas';
import { formatPosition, formatTime } from './format';
import { Icon } from './icons';

const TYPES: readonly FxType[] = ['hicut', 'locut', 'pitch'];

const emphNames = (): [FxEmphasis, string][] => [
  [0, tr('なし', 'None')],
  [1, tr('少し', 'A little')],
  [2, tr('強め', 'Strong')],
];

const resNames = (): [FxRes, string, string][] => [
  [3, tr('粗い', 'Coarse'), '1/3 oct'],
  [6, tr('ふつう', 'Normal'), '1/6 oct'],
  [12, tr('細かい', 'Fine'), '1/12 oct'],
];

const scopeNames = (): [FxReadScope, string][] => [
  ['view', tr('表示中', 'Visible')],
  ['loop', tr('ループ', 'Loop')],
  ['song', tr('曲全体', 'Whole song')],
];

const whatNames = (): [FxReadWhat, string][] => [
  ['hicut', tr('ハイカット', 'High cut')],
  ['locut', tr('ローカット', 'Low cut')],
  ['both', tr('両方', 'Both')],
];

/** 形の小さな絵（次の点までの線） */
function ShapeIcon({ s }: { s: string }) {
  const d =
    s === 'slow'
      ? 'M2 12 Q12 12 18 3'
      : s === 'fast'
        ? 'M2 12 Q6 3 18 3'
        : s === 'scurve'
          ? 'M2 12 C10 12 10 3 18 3'
          : s === 'hold'
            ? 'M2 12 H16 V3'
            : 'M2 12 L18 3';
  return (
    <svg width="20" height="15" viewBox="0 0 20 15" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1000))}KB`);

export function FxPanel() {
  const fx = useFx();
  const side = useSidecar((s) => s.fx);
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  useEditor((s) => s.view.scrollBeat);
  const hasLoop = useAssist((s) => !!s.loop);
  const hasAudio = useAssist((s) => !!s.data);
  const [adding, setAdding] = useState(false);
  const [templates, setTemplates] = useState(false);
  const live = fx.live ?? side;
  const curves = live?.curves ?? [];
  const sel = curves.find((c) => c.id === fx.curveId) ?? null;
  const pts = sel ? sortPoints(sel.points) : [];
  const point = sel && fx.point !== null ? pts[fx.point] : undefined;
  const tempo = tempoOf(doc);
  const stats = fxStats(doc);
  const res = live?.res ?? 6;
  const tails = live?.tails ?? true;
  const selIds = selection.filter((id) => {
    const c = doc.chips.find((x) => x.id === id);
    return !!c && !!drumChannel(c.ch);
  });

  return (
    <aside className="right-panel scroll fx-panel">
      <div className="row" style={{ padding: '2px 2px 0' }}>
        <span style={{ color: FX_COLORS.hicut }}>{Icon.fx(16)}</span>
        <b style={{ fontSize: 14 }}>{tr('エフェクトの編集', 'Effect editing')}</b>
        <span className="grow" />
        <span className="lbl">{tr('E か Esc で閉じる', 'E or Esc to close')}</span>
        <button className="ib" style={{ width: 26, height: 26 }} onClick={() => openFx(false)} aria-label={tr('エフェクトの編集を閉じる', 'Close effect editing')}>
          ✕
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>{tr('カーブ', 'Curves')}</b>
          <span className="grow" />
          <span className="lbl">{tr('曲全体に引く線（DAW と同じ）', 'Lines across the whole song (like a DAW)')}</span>
        </div>
        {curves.length === 0 && (
          <p className="lbl fx-empty">
            {tr(
              '右の列（原曲のスペクトル）をクリックすると、ハイカットのカーブに点を足します。チップを選んで右クリックのテンプレートからも引けます。',
              'Click the column on the right (the spectrum of the original) to add points to a high cut curve. You can also use the templates from the right-click menu on selected chips.',
            )}
          </p>
        )}
        <div className="fx-curves">
          {curves.map((c) => (
            <button
              key={c.id}
              className={`fx-curve ${c.id === fx.curveId ? 'on' : ''}`}
              style={{ ['--c' as string]: FX_COLORS[c.type] }}
              onClick={() => selectCurve(c.id === fx.curveId ? null : c.id)}
            >
              <span className="dot" style={{ background: FX_COLORS[c.type] }} />
              <b>{typeName(c.type)}</b>
              <span className="lbl ellipsis">{lanesText(c.lanes)}</span>
              <span className="grow" />
              <span className="lbl mono">{c.points.length ? tr(`${curveRegions(c)} か所`, `${curveRegions(c)} ${pl(curveRegions(c), 'part')}`) : tr('点なし', 'no points')}</span>
            </button>
          ))}
        </div>
        {sel && (
          <div className="fx-sel">
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="lbl">{tr(`${typeName(sel.type)}をかけるレーン`, `Lanes for the ${typeName(sel.type).toLowerCase()}`)}</span>
              <span className="grow" />
              <button className={`link-btn ${sel.lanes ? '' : 'on'}`} onClick={() => setCurveLanes(sel.id, null)}>
                {tr('全部', 'All')}
              </button>
            </div>
            <div className="fx-lanes">
              {DRUM_LANES.map((l) => {
                const on = !sel.lanes || sel.lanes.includes(l.key);
                return (
                  <button
                    key={l.key}
                    className={on ? 'on' : ''}
                    style={on ? { borderColor: l.color, color: l.color } : undefined}
                    onClick={() => toggleCurveLane(sel.id, l.key)}
                    title={sel.lanes ? tr(`${l.name}を${on ? '外す' : '足す'}`, `${on ? 'Remove' : 'Add'} ${l.name}`) : tr(`${l.name}だけにする`, `Only ${l.name}`)}
                  >
                    {l.key}
                  </button>
                );
              })}
            </div>
            {sel.type !== 'pitch' && (
              <div className="row" style={{ marginTop: 8 }}>
                <span className="lbl" style={{ minWidth: 64 }}>
                  {tr('境目の強調', 'Emphasis')}
                </span>
                <div className="seg small" style={{ display: 'flex', flex: 1 }}>
                  {emphNames().map(([q, label]) => (
                    <button key={q} className={sel.q === q ? 'on' : ''} style={{ flex: 1 }} onClick={() => setCurveQ(sel.id, q)} title={tr('DJ ミキサーのフィルターのように、境目の音を持ち上げる', 'Boosts the sound around the cutoff, like a DJ mixer filter')}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
              <button className="link-btn danger" onClick={() => removeCurve(sel.id)}>
                {tr('このカーブを消す', 'Delete this curve')}
              </button>
            </div>
          </div>
        )}
        <div className="fx-btns">
          <button className={`btn small ${adding ? 'on' : ''}`} onClick={() => setAdding(!adding)}>
            {Icon.plus(12)} {tr('カーブ', 'Curve')}
          </button>
          <button className={`btn small ${templates ? 'on' : ''}`} onClick={() => setTemplates(!templates)}>
            {tr('テンプレート', 'Templates')}
          </button>
          <button className={`btn small fx-read-btn ${fx.read ? 'on' : ''}`} onClick={() => openRead()}>
            {Icon.sparkle(12)} {tr('原曲から読み取る', 'Read from original')}
          </button>
        </div>
        {adding && (
          <div className="fx-add">
            {TYPES.map((t) => (
              <button
                key={t}
                className="btn small"
                style={{ borderColor: FX_COLORS[t] }}
                onClick={() => {
                  setAdding(false);
                  addCurve(t);
                }}
              >
                <span className="dot" style={{ background: FX_COLORS[t] }} /> {typeName(t)}
              </button>
            ))}
          </div>
        )}
        {templates && (
          <div className="fx-tpl">
            <p className="lbl" style={{ margin: '0 0 6px' }}>
              {selIds.length
                ? tr(`選んだ ${selIds.length} 個のチップの時間に引きます（かかるのは時間とレーンで決まります）`, `Draws over the time of the ${selIds.length} selected ${pl(selIds.length, 'chip')} (the time and lanes decide where it applies)`)
                : tr('譜面でチップを選ぶと使えます（選んだチップの時間に引きます）', 'Select chips in the chart first (it draws over their time)')}
            </p>
            <div className="fx-tpl-grid">
              {FX_TEMPLATES.map((t) => (
                <button key={t.id} className="btn small" disabled={!selIds.length} onClick={() => applyTemplate(t.id, selIds)}>
                  <span className="dot" style={{ background: FX_COLORS[t.type] }} /> {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {fx.read && (
        <div className="card fx-read">
          <div className="row" style={{ marginBottom: 8 }}>
            <b style={{ fontSize: 13, color: FX_COLORS.hicut }}>
              {Icon.sparkle(12)} {tr('原曲から読み取る', 'Read from the original')}
            </b>
            <span className="grow" />
            <span className="lbl">{tr('AI は使いません', 'No AI')}</span>
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="lbl" style={{ minWidth: 60 }}>
              {tr('探す範囲', 'Range')}
            </span>
            <div className="seg small" style={{ display: 'flex', flex: 1 }}>
              {scopeNames().map(([k, label]) => (
                <button key={k} className={fx.read!.scope === k ? 'on' : ''} disabled={k === 'loop' && !hasLoop} style={{ flex: 1 }} onClick={() => setReadOpts({ scope: k })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="lbl" style={{ minWidth: 60 }}>
              {tr('探すもの', 'Find')}
            </span>
            <div className="seg small" style={{ display: 'flex', flex: 1 }}>
              {whatNames().map(([k, label]) => (
                <button key={k} className={fx.read!.what === k ? 'on' : ''} style={{ flex: 1 }} onClick={() => setReadOpts({ what: k })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.65 }}>
            {tr(
              '原曲のスペクトルで、ほかの帯域は鳴っているのに高い帯域（ローカットなら低い帯域）だけが暗くなっている所を探し、境目の周波数を点線で出します。目安なので、聴いてから直して使ってください。',
              'Looks in the spectrum of the original for places where only the high band (or the low band for a low cut) goes dark while the rest keeps playing, and shows the cutoff as a dashed line. It is a rough guide, so listen and adjust it.',
            )}
          </p>
          {fx.proposals ? (
            <div className="fx-found">
              <div className="row" style={{ marginBottom: 4 }}>
                <b style={{ fontSize: 12 }}>{tr(`見つかった所 ${fx.proposals.reduce((a, p) => a + p.regions.length, 0)} か所`, `Found ${fx.proposals.reduce((a, p) => a + p.regions.length, 0)}`)}</b>
                <span className="grow" />
                <span className="lbl mono">{tr(`点 ${fx.proposals.reduce((a, p) => a + p.points.length, 0)} つ`, `${fx.proposals.reduce((a, p) => a + p.points.length, 0)} points`)}</span>
              </div>
              {fx.proposals.flatMap((p) =>
                p.regions.slice(0, 6).map((r, i) => (
                  <div key={`${p.type}${i}`} className="lbl fx-found-row">
                    <span className="dot" style={{ background: FX_COLORS[p.type] }} /> {r.text}
                  </div>
                )),
              )}
              <div className="fx-btns" style={{ marginTop: 8 }}>
                <button className="btn small primary" onClick={() => adoptProposals()}>
                  {tr('採用する', 'Use it')}
                </button>
                <button className="btn small" onClick={() => thinProposals()}>
                  {tr('点を減らす', 'Fewer points')}
                </button>
                <button className="btn small" onClick={() => dropProposals()}>
                  {tr('やめる', 'Discard')}
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn small primary" disabled={fx.read.busy || !hasAudio} onClick={() => void readFromOriginal(visibleBeats())}>
                {fx.read.busy ? tr('探しています…', 'Looking…') : tr('読み取る', 'Read')}
              </button>
              <span className="lbl" style={{ marginLeft: 8 }}>
                {fx.read.note ?? (hasAudio ? '' : tr('原曲を読み込むと使えます', 'Load the original audio first'))}
              </span>
            </div>
          )}
          <p className="lbl" style={{ margin: '8px 0 0' }}>
            {tr('ステムを入れていれば、解析元のステム（ドラム抜きなど）で探します。', 'If you have stems, it looks in the stem used for analysis (such as the one without drums).')}
          </p>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>{tr('選んだ点', 'Selected point')}</b>
          <span className="grow" />
          {point && (
            <span className="lbl mono">
              {formatPosition(tempo, pointBeat(tempo, point))} · {formatTime(tempo.beatToSec(pointBeat(tempo, point)))}
            </span>
          )}
        </div>
        {sel && point && fx.point !== null ? (
          <>
            <div className="row fx-val">
              <span className="lbl" style={{ minWidth: 56 }}>
                {sel.type === 'pitch' ? tr('高さ', 'Pitch') : tr('周波数', 'Frequency')}
              </span>
              <button className="ib" onClick={() => stepSelectedPoint(-1)} aria-label={tr('1 段下げる', 'One step down')} title={tr('1 段下げる（←）', 'One step down (←)')}>
                ‹
              </button>
              <span className="fx-val-box mono" style={{ color: FX_COLORS[sel.type] }}>
                {valueText(sel.type, point.v)}
                <span className="lbl">{tr('‹ › で 1 段', '‹ › one step')}</span>
              </span>
              <button className="ib" onClick={() => stepSelectedPoint(1)} aria-label={tr('1 段上げる', 'One step up')} title={tr('1 段上げる（→）', 'One step up (→)')}>
                ›
              </button>
            </div>
            <div className="lbl" style={{ marginTop: 10, marginBottom: 4 }}>
              {tr('次の点までの形', 'Shape to the next point')}
            </div>
            <div className="fx-shapes" style={{ ['--c' as string]: FX_COLORS[sel.type] }}>
              {FX_SHAPES.map((sh) => (
                <button key={sh} className={(point.s ?? 'smooth') === sh ? 'on' : ''} disabled={fx.point === pts.length - 1} onClick={() => setPointShape(sel.id, fx.point!, sh)}>
                  <ShapeIcon s={sh} />
                  <span>{shapeName(sh)}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="lbl" style={{ margin: 0, lineHeight: 1.6 }}>
            {tr(
              '列の点をクリックで選びます。ドラッグで動かし（Shift で縦か横だけ）、Delete か右クリックで消します。',
              'Click a point in the column to select it. Drag to move it (Shift: only vertically or horizontally); Delete or right-click to remove it.',
            )}
          </p>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>{tr('作る音', 'Sounds to make')}</b>
          <span className="grow" />
          <span className="lbl">{tr('保存のときに fx/ に書き出す', 'Written to fx/ when you save')}</span>
        </div>
        <div className="fx-stats">
          <div>
            <b className="mono">{stats.chips}</b>
            <span className="lbl">{tr('かかったチップ', 'chips with effects')}</span>
          </div>
          <div>
            <b className="mono">
              {stats.files} <small>{stats.files ? mb(stats.bytes) : ''}</small>
            </b>
            <span className="lbl">{tr('音のファイル', 'sound files')}</span>
          </div>
          <div className={stats.free < WAV_LOW ? 'warn' : ''} title={tr(`WAV 番号の残り ${stats.free.toLocaleString()}（01〜ZZ の 1,295 まで）`, `${stats.free.toLocaleString()} WAV numbers left (up to 1,295: 01–ZZ)`)}>
            <b className="mono">+{stats.wavs}</b>
            <span className="lbl">{tr(`WAV 番号・残り ${stats.free.toLocaleString()}`, `WAVs · ${stats.free.toLocaleString()} left`)}</span>
          </div>
        </div>
        {fx.rendering > 0 && <p className="lbl" style={{ margin: '6px 0 0' }}>{tr(`音を作っています… ${fx.rendering}`, `Making sounds… ${fx.rendering}`)}</p>}
        <div className="row" style={{ marginTop: 10 }}>
          <span className="lbl" style={{ minWidth: 64 }}>
            {tr('なめらかさ', 'Smoothness')}
          </span>
          <div className="seg small" style={{ display: 'flex', flex: 1 }}>
            {resNames().map(([r, label, note]) => (
              <button key={r} className={res === r ? 'on' : ''} style={{ flex: 1 }} onClick={() => setFxRes(r)} title={note}>
                {label}
              </button>
            ))}
          </div>
          <span className="lbl mono" style={{ marginLeft: 6 }}>
            {resNames().find(([r]) => r === res)?.[2]}
          </span>
        </div>
        <label className="row fx-tails">
          <input type="checkbox" checked={tails} onChange={(e) => setFxTails(e.target.checked)} />
          <span>{tr('長く鳴る音（シンバルなど）は余韻もカーブどおり', 'Long sounds (cymbals, etc.) follow the curve through their tails')}</span>
        </label>
        <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          {tr(
            '同じ曲のほかの難易度にも、保存のときに同じカーブを入れます（前から同じだった難易度だけ。音はそれぞれの譜面で作ります）。',
            'When you save, the same curves go into the other difficulties of this song too (only those that matched before; each chart makes its own sounds).',
          )}
        </p>
      </div>
    </aside>
  );
}
