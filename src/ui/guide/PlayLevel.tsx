// 難易度ガイドラインの「あなたの遊ぶレベル」：DTXMania の成績（遊んだ譜面のいちばん良い達成率）を、レベルを横に並べて見せる。
// ならした達成率が S（80%）に届くいちばん上のレベルを「めやす」に出し、決めたレベル（あいだに作ると同じ値）を変えられる。
import { tr, pl } from '../../i18n';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { S_LINE, type PlayEstimate, type PlayPoint } from '../../guide/ruler';
import { rememberInsertLevel, usePlayLevel } from '../../store/playLevel';
import { Icon } from '../icons';

/** 決めたレベルを 0.1 ずつ */
function step(v: number | null, d: number, fallback: number) {
  const base = v ?? fallback;
  rememberInsertLevel(Math.max(1, Math.min(9.9, Math.round((base + d) * 10) / 10)));
}

export function PlayLevelCard({ est, points, addable, onShowAddable }: { est: PlayEstimate; points: PlayPoint[]; addable: number | null; onShowAddable: () => void }) {
  const play = usePlayLevel((s) => s.v);
  const [table, setTable] = useState(false);
  const shown = play ?? est.level;
  return (
    <section className="card gp-play" aria-labelledby="gp-play-h">
      <div className="row gp-card-head">
        <h3 id="gp-play-h">{tr('あなたの遊ぶレベル', 'Your playing level')}</h3>
        <span className="lbl hide-narrow">{tr('「あいだに作る」と同じ値です。DTXMania の成績から見積もります', 'The same value as “Make one in between”. Estimated from your DTXMania records')}</span>
        <span className="grow" />
        {points.length > 0 && (
          <div className="seg" role="group" aria-label={tr('見せ方', 'View')}>
            <button className={table ? '' : 'on'} aria-pressed={!table} onClick={() => setTable(false)}>
              {tr('図', 'Chart')}
            </button>
            <button className={table ? 'on' : ''} aria-pressed={table} onClick={() => setTable(true)}>
              {tr('表', 'Table')}
            </button>
          </div>
        )}
      </div>
      <div className="gp-play-body">
        <div className="gp-play-side">
          <div className="lbl">{tr('決めたレベル', 'Your level')}</div>
          <div className="gp-play-set">
            <button className="ib gp-step" onClick={() => step(play, -0.1, est.level ?? 5)} aria-label={tr('0.1 下げる', 'Lower by 0.1')}>
              {Icon.minus(14)}
            </button>
            <b className={`gp-big mono ${play === null ? 'unset' : ''}`}>{shown !== null ? shown.toFixed(1) : '—'}</b>
            <button className="ib gp-step" onClick={() => step(play, 0.1, est.level ?? 5)} aria-label={tr('0.1 上げる', 'Raise by 0.1')}>
              {Icon.plus(14)}
            </button>
          </div>
          {play === null && est.level !== null && <div className="lbl">{tr('まだ決めていません（めやすを出しています）', 'Not set yet (showing the estimate)')}</div>}
          <div className="gp-est">
            <div>
              {tr('成績からのめやす', 'Estimate from records')} <b className="mono">{est.level !== null ? est.level.toFixed(1) : '—'}</b>
            </div>
            <div className="lbl">
              {est.level !== null
                ? tr(`遊んだ ${est.n} 譜面から。ならした達成率が S（${S_LINE}%）に届くいちばん上のレベル`, `From ${est.n} played ${pl(est.n, 'chart')}: the highest level where your smoothed achievement reaches S (${S_LINE}%)`)
                : points.length < 3
                  ? tr('成績のある譜面が 3 つより少ないので、まだ出せません', 'Fewer than 3 charts have records, so there is no estimate yet')
                  : tr(`遊んだ譜面で S（${S_LINE}%）に届いたレベル帯がまだありません`, `No level range has reached S (${S_LINE}%) in your played charts yet`)}
              {est.atTop && tr('。もっと上のレベルを遊ぶと、めやすが上がるかもしれません', '. Playing harder charts may raise it')}
            </div>
            {est.level !== null && play !== est.level && (
              <button className="btn small" onClick={() => rememberInsertLevel(est.level)}>
                {tr(`めやすの ${est.level.toFixed(1)} にする`, `Use ${est.level.toFixed(1)}`)}
              </button>
            )}
          </div>
          {addable !== null && shown !== null && (
            <button className="btn small primary gp-addable" onClick={onShowAddable} disabled={addable === 0}>
              {tr(`${shown.toFixed(1)} を足せる曲 ${addable} 曲を見る`, `See ${addable} ${pl(addable, 'song')} that can take a ${shown.toFixed(1)}`)}
              {Icon.chevronRight(13)}
            </button>
          )}
          {addable !== null && shown !== null && (
            <div className="lbl">{tr('曲の一覧の「あいだに作る」で、このレベルの譜面を作れる曲', 'Songs where “Make one in between” in the song list can make a chart at this level')}</div>
          )}
        </div>
        {points.length === 0 ? (
          <div className="gp-play-empty lbl">
            {tr(
              'まだ成績がありません。DTXMania で遊ぶと、譜面の横の「譜面の名前.score.ini」に達成率が残り、ここに並びます。',
              'No records yet. When you play in DTXMania, the achievement is kept in “chart name.score.ini” next to the chart and shows up here.',
            )}
          </div>
        ) : table ? (
          <PlayTable points={points} />
        ) : (
          <PlayChart points={points} curve={est.curve} play={shown} est={est.level} />
        )}
      </div>
    </section>
  );
}

const PAD = { l: 40, r: 14, t: 14, b: 26 };

function PlayChart({ points, curve, play, est }: { points: PlayPoint[]; curve: PlayEstimate['curve']; play: number | null; est: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(280, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  const h = 230;
  const dom = useMemo(() => {
    const lv = points.map((p) => p.level);
    let x0 = Math.max(1, Math.floor(Math.min(...lv, play ?? 99) - 0.2));
    let x1 = Math.min(10, Math.ceil(Math.max(...lv, play ?? 0) + 0.2));
    if (x1 - x0 < 3) {
      x1 = Math.min(10, x0 + 3);
      x0 = Math.max(1, x1 - 3);
    }
    const y0 = Math.max(0, Math.min(60, Math.floor((Math.min(...points.map((p) => p.skill)) - 5) / 10) * 10));
    return { x0, x1, y0, y1: 100 };
  }, [points, play]);
  const X = (x: number) => PAD.l + ((x - dom.x0) / (dom.x1 - dom.x0)) * (w - PAD.l - PAD.r);
  const Y = (y: number) => PAD.t + (1 - (y - dom.y0) / (dom.y1 - dom.y0)) * (h - PAD.t - PAD.b);
  const xs: number[] = [];
  for (let x = Math.ceil(dom.x0); x <= dom.x1; x++) xs.push(x);
  const ys: number[] = [];
  for (let y = Math.ceil(dom.y0 / 10) * 10; y <= 100; y += 10) ys.push(y);
  const line = curve
    .filter((c) => c.x >= dom.x0 && c.x <= dom.x1)
    .map((c, i) => `${i ? 'L' : 'M'}${X(c.x).toFixed(1)},${Y(Math.max(dom.y0, c.y)).toFixed(1)}`)
    .join(' ');
  const hp = hover !== null ? points[hover] : null;
  const label = tr(
    `遊んだ ${points.length} 譜面の、レベルといちばん良い達成率の図${est !== null ? `。めやすは ${est.toFixed(1)}` : ''}`,
    `Level and best achievement of ${points.length} played ${pl(points.length, 'chart')}${est !== null ? `. Estimate: ${est.toFixed(1)}` : ''}`,
  );
  return (
    <div className="gp-chart" ref={ref}>
      <svg width={w} height={h} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
        {/* 目盛り（細い線） */}
        {ys.map((y) => (
          <g key={`y${y}`}>
            <line x1={PAD.l} x2={w - PAD.r} y1={Y(y)} y2={Y(y)} className="gp-grid" />
            <text x={PAD.l - 6} y={Y(y) + 3.5} className="gp-tick" textAnchor="end">
              {y}%
            </text>
          </g>
        ))}
        {xs.map((x) => (
          <g key={`x${x}`}>
            <line x1={X(x)} x2={X(x)} y1={PAD.t} y2={h - PAD.b} className="gp-grid" />
            <text x={X(x)} y={h - PAD.b + 16} className="gp-tick" textAnchor="middle">
              Lv{x}
            </text>
          </g>
        ))}
        {/* S の線 */}
        <line x1={PAD.l} x2={w - PAD.r} y1={Y(S_LINE)} y2={Y(S_LINE)} className="gp-sline" />
        <text x={w - PAD.r - 2} y={Y(S_LINE) - 5} className="gp-tick strong" textAnchor="end">
          S {S_LINE}%
        </text>
        {/* 決めたレベル */}
        {play !== null && play >= dom.x0 && play <= dom.x1 && (
          <g>
            <line x1={X(play)} x2={X(play)} y1={PAD.t} y2={h - PAD.b} className="gp-you" />
            <text x={X(play) + 5} y={PAD.t + 10} className="gp-you-t">
              {tr(`あなた ${play.toFixed(1)}`, `You ${play.toFixed(1)}`)}
            </text>
          </g>
        )}
        {/* ならした達成率 */}
        {line && <path d={line} className="gp-curve" />}
        {/* めやす：ならした線が S に届くいちばん上 */}
        {est !== null && est >= dom.x0 && est <= dom.x1 && <circle cx={X(est)} cy={Y(S_LINE)} r={5} className="gp-est-dot" />}
        {/* 遊んだ譜面 */}
        {points.map((p, i) => (
          <circle key={p.key} cx={X(p.level)} cy={Y(Math.max(dom.y0, p.skill))} r={4} className={`gp-dot ${hover === i ? 'on' : ''}`} />
        ))}
        {/* 押しやすい当たり（点より大きく） */}
        {points.map((p, i) => (
          <circle key={`h${p.key}`} cx={X(p.level)} cy={Y(Math.max(dom.y0, p.skill))} r={12} className="gp-hit" onPointerEnter={() => setHover(i)} />
        ))}
      </svg>
      {hp && (
        <div className="gp-tip" style={{ left: Math.min(w - 220, Math.max(0, X(hp.level) + 12)), top: Math.max(0, Y(Math.max(dom.y0, hp.skill)) - 50) }} role="status">
          <b className="mono">{hp.skill.toFixed(1)}%</b>
          {hp.rank && <span className="gp-rank">{hp.rank}</span>}
          <span className="lbl mono">Lv{hp.level.toFixed(2)}</span>
          <div className="ellipsis">{hp.song}</div>
          <div className="lbl">
            {hp.label} · {tr(`${hp.plays} 回`, `${hp.plays} ${pl(hp.plays, 'play')}`)}
          </div>
        </div>
      )}
      <div className="gp-legend lbl">
        <span>
          <i className="gp-lg-dot" />
          {tr('遊んだ譜面（いちばん良い達成率）', 'Played charts (best achievement)')}
        </span>
        <span>
          <i className="gp-lg-line" />
          {tr('ならした達成率', 'Smoothed achievement')}
        </span>
        {est !== null && (
          <span>
            <i className="gp-lg-est" />
            {tr('めやす', 'Estimate')}
          </span>
        )}
      </div>
    </div>
  );
}

function PlayTable({ points }: { points: PlayPoint[] }) {
  return (
    <div className="gp-ptable scroll">
      <table>
        <thead>
          <tr>
            <th>{tr('曲', 'Song')}</th>
            <th>{tr('難易度', 'Difficulty')}</th>
            <th className="num">{tr('レベル', 'Level')}</th>
            <th className="num">{tr('達成率', 'Achievement')}</th>
            <th>{tr('ランク', 'Rank')}</th>
            <th className="num">{tr('回数', 'Plays')}</th>
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((p) => (
            <tr key={p.key}>
              <td className="ellipsis">{p.song}</td>
              <td className="lbl">{p.label}</td>
              <td className="num mono">{p.level.toFixed(2)}</td>
              <td className="num mono">{p.skill.toFixed(1)}%</td>
              <td className="mono">{p.rank ?? '—'}</td>
              <td className="num mono">{p.plays}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
