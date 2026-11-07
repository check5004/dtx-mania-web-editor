// ベロシティの編集モードの右パネル（道具）。対象の範囲とレーン、分布、まとめて変える、原曲の打点から決める、拍の位置で強弱。
import { tr, pl } from '../i18n';
import { useState } from 'react';
import { toMeasure } from '../dtx/base36';
import { DRUM_LANES } from '../dtx/model';
import { useAssist } from '../store/assist';
import { tempoOf, wavVel } from '../store/derived';
import { useEditor } from '../store/editor';
import {
  adoptProposal,
  applyVel,
  beatSlot,
  scopeRange,
  setProposal,
  targetChips,
  toggleVelLane,
  toggleVelMode,
  useVel,
  velFromAudio,
  velHistogram,
  type VelScope,
  type VelTool,
} from '../store/velocity';
import { visibleBeats } from './ChartCanvas';
import { Icon } from './icons';

const scopes = (): [VelScope, string][] => [
  ['selection', tr('選択範囲', 'Selection')],
  ['visible', tr('表示中', 'Visible')],
  ['section', tr('セクション', 'Section')],
  ['song', tr('曲全体', 'Whole song')],
];

const tools = (): [VelTool, string, string][] => [
  [
    'select',
    tr('選択', 'Select'),
    tr(
      'ベロシティの列でクリックかドラッグしてチップを選びます。Alt+ホイールか Alt+↑↓ で選んだチップを5ずつ（Shift で1ずつ）変えます。',
      'Click or drag in the velocity column to select chips. Alt+wheel or Alt+↑↓ changes the selected chips by 5 (Shift: by 1).',
    ),
  ],
  ['pencil', tr('鉛筆', 'Pencil'), tr('ベロシティの列をなぞると、なぞった位置のベロシティになります。', 'Draw over the velocity column to set velocities to where you draw.')],
  [
    'line',
    tr('直線', 'Line'),
    tr(
      'ベロシティの列で始点から終点へドラッグすると、間のチップがなめらかに変わります（クレッシェンドなど）。',
      'Drag from a start point to an end point in the velocity column to ramp the chips in between (crescendos, etc.).',
    ),
  ],
];

const accentPresets = (): [string, [number, number, number, number]][] => [
  [tr('表を強く', 'Accent downbeats'), [100, 60, 80, 60]],
  [tr('4分ごと', 'Every quarter'), [100, 60, 60, 60]],
  [tr('裏を強く', 'Accent offbeats'), [60, 60, 100, 60]],
];

const slotNames = () => [tr('表', '1'), tr('2つ目', 'e'), tr('裏', '&'), tr('4つ目', 'a')];

function num(v: string, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function VelocityPanel() {
  const v = useVel();
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.selection);
  useEditor((s) => s.view.scrollBeat);
  useEditor((s) => s.cursorBeat);
  const hasAudio = useAssist((s) => !!s.data);
  const srcName = useAssist((s) => s.src?.name ?? '');
  const [setTo, setSetTo] = useState('100');
  const [scale, setScale] = useState('90');
  const [lo, setLo] = useState('60');
  const [hi, setHi] = useState('100');
  const [jitter, setJitter] = useState('3');

  const vis = visibleBeats();
  const chips = targetChips(vis);
  const ids = chips.map((c) => c.id);
  const hist = velHistogram(doc, chips);
  const maxBin = Math.max(1, ...hist.bins);
  const tempo = tempoOf(doc);
  const range = (() => {
    if (v.scope === 'selection') return chips.length ? tr(`${chips.length} 個を選択中`, `${chips.length} selected`) : tr('譜面でチップを選んでください', 'Select chips in the chart');
    const r = scopeRange(v.scope, vis);
    if (!r) return tr('カーソルの小節にセクションがありません', 'No section at the cursor measure');
    if (!Number.isFinite(r.from)) return tr('曲全体', 'Whole song');
    const a = tempo.locate(Math.max(0, r.from)).m;
    const b = Number.isFinite(r.to) ? tempo.locate(Math.max(0, r.to - 1e-6)).m : null;
    return b === null ? `${toMeasure(a)}〜` : `${toMeasure(a)}–${toMeasure(b)}`;
  })();

  const run = (label: string, fn: (cur: number, c: (typeof chips)[number]) => number | null) => {
    if (ids.length === 0) return;
    applyVel(tr(`${label}（${ids.length}個）`, `${label} (${ids.length})`), ids, fn);
  };

  const pick = (pred: (vel: number) => boolean) => {
    useEditor.setState({ selection: chips.filter((c) => pred(wavVel(doc, c.v))).map((c) => c.id) });
    useVel.setState({ scope: 'selection' });
  };

  const narrow = () => {
    const a = num(lo, 60);
    const b = num(hi, 100);
    const vals = chips.map((c) => wavVel(doc, c.v));
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    run(tr(`ベロシティの幅を ${a}〜${b} に詰める`, `Fit velocities into ${a}–${b}`), (cur) => (mx === mn ? (a + b) / 2 : a + ((cur - mn) / (mx - mn)) * (b - a)));
  };

  return (
    <aside className="right-panel scroll vel-panel">
      <div className="row" style={{ padding: '2px 2px 0' }}>
        <span style={{ color: 'var(--accent)' }}>{Icon.bars(15)}</span>
        <b style={{ fontSize: 14 }}>{tr('ベロシティの編集', 'Velocity editing')}</b>
        <span className="grow" />
        <span className="lbl">{tr('V か Esc で閉じる', 'V or Esc to close')}</span>
        <button className="ib" style={{ width: 26, height: 26 }} onClick={() => toggleVelMode(false)} aria-label={tr('ベロシティの編集を閉じる', 'Close velocity editing')}>
          ✕
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="lbl">{tr('対象の範囲', 'Range')}</span>
          <span className="grow" />
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
            {range}
          </span>
        </div>
        <div className="seg small" style={{ display: 'flex', marginBottom: 10 }}>
          {scopes().map(([k, label]) => (
            <button key={k} className={v.scope === k ? 'on' : ''} style={{ flex: 1 }} onClick={() => useVel.setState({ scope: k })}>
              {label}
            </button>
          ))}
        </div>
        <div className="vel-lanes" role="group" aria-label={tr('ベロシティのレーンに出すレーン（3つまで）', 'Lanes shown in the velocity column (up to 3)')}>
          {DRUM_LANES.map((l, i) => {
            const on = v.lanes.includes(i);
            return (
              <button
                key={l.key}
                className={on ? 'on' : ''}
                style={on ? { borderColor: l.color, color: l.color } : undefined}
                onClick={() => toggleVelLane(i)}
                title={tr(`${l.name}のベロシティを出す（3つまで）`, `Show ${l.name} velocities (up to 3)`)}
              >
                {l.key}
              </button>
            );
          })}
        </div>
        <div className="vel-hist" aria-label={tr('ベロシティの分布', 'Velocity distribution')}>
          {hist.bins.map((n, i) => (
            <span key={i} style={{ height: `${Math.max(n ? 6 : 2, (n / maxBin) * 100)}%`, background: n ? (i >= 7 ? 'var(--accent)' : i >= 4 ? '#5D7189' : '#3A4656') : '#1C222B' }} title={tr(`${i * 10 + 1}〜${(i + 1) * 10}: ${n}個`, `${i * 10 + 1}–${(i + 1) * 10}: ${n}`)} />
          ))}
        </div>
        <div className="row lbl mono" style={{ justifyContent: 'space-between', marginTop: 2 }}>
          <span>1</span>
          <span>50</span>
          <span>100</span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span style={{ fontSize: 12 }}>
            <b className="mono">{chips.length}</b> {tr('個 · 平均', `${pl(chips.length, 'chip')} · avg`)} <span className="mono">{chips.length ? Math.round(hist.avg) : '-'}</span>
          </span>
          <span className="grow" />
          <button className="btn small" disabled={!chips.length} onClick={() => pick((x) => x <= 50)} title={tr('ベロシティ50以下のチップだけを選ぶ', 'Select only chips with velocity 50 or less')}>
            {tr('弱だけ選ぶ', 'Select soft')}
          </button>
          <button className="btn small" disabled={!chips.length} onClick={() => pick((x) => x >= 80)} title={tr('ベロシティ80以上のチップだけを選ぶ', 'Select only chips with velocity 80 or more')}>
            {tr('強だけ選ぶ', 'Select hard')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="seg" style={{ display: 'flex' }} role="radiogroup" aria-label={tr('道具', 'Tool')}>
          {tools().map(([k, label]) => (
            <button key={k} role="radio" aria-checked={v.tool === k} className={v.tool === k ? 'on' : ''} style={{ flex: 1 }} onClick={() => useVel.setState({ tool: k })}>
              {label}
            </button>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
          {tools().find(([k]) => k === v.tool)![2]}
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>{tr('まとめて変える', 'Change in bulk')}</b>
          <span className="grow" />
          <button className="btn small" disabled={!ids.length} onClick={() => run(tr('ベロシティを -5', 'Velocity -5'), (c) => c - 5)}>
            -5
          </button>
          <button className="btn small" disabled={!ids.length} onClick={() => run(tr('ベロシティを +5', 'Velocity +5'), (c) => c + 5)}>
            +5
          </button>
        </div>
        <div className="vel-ops">
          <label>
            <span className="lbl">{tr('そろえる', 'Set all to')}</span>
            <span className="row" style={{ gap: 6 }}>
              <input className="field mono" value={setTo} onChange={(e) => setSetTo(e.target.value)} inputMode="numeric" />
              <button className="btn small" disabled={!ids.length} onClick={() => run(tr(`ベロシティを ${num(setTo, 100)} にそろえる`, `Set velocity to ${num(setTo, 100)}`), () => num(setTo, 100))}>
                {tr('反映', 'Apply')}
              </button>
            </span>
          </label>
          <label>
            <span className="lbl">{tr('倍率（%）', 'Scale (%)')}</span>
            <span className="row" style={{ gap: 6 }}>
              <input className="field mono" value={scale} onChange={(e) => setScale(e.target.value)} inputMode="numeric" />
              <button className="btn small" disabled={!ids.length} onClick={() => run(tr(`ベロシティを ${num(scale, 100)}% にする`, `Scale velocity to ${num(scale, 100)}%`), (c) => (c * num(scale, 100)) / 100)}>
                {tr('反映', 'Apply')}
              </button>
            </span>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="lbl">{tr('幅を詰める（今の強弱の差を保ったまま、この幅に収める）', 'Fit into a range (keeps the current dynamics, scaled into this range)')}</span>
            <span className="row" style={{ gap: 4 }}>
              <input className="field mono" value={lo} onChange={(e) => setLo(e.target.value)} inputMode="numeric" aria-label={tr('下限', 'Minimum')} />
              –
              <input className="field mono" value={hi} onChange={(e) => setHi(e.target.value)} inputMode="numeric" aria-label={tr('上限', 'Maximum')} />
              <button className="btn small" disabled={!ids.length} onClick={narrow}>
                {tr('反映', 'Apply')}
              </button>
            </span>
          </label>
          <label>
            <span className="lbl">{tr('ゆらぎ（±）', 'Humanize (±)')}</span>
            <span className="row" style={{ gap: 6 }}>
              <input className="field mono" value={jitter} onChange={(e) => setJitter(e.target.value)} inputMode="numeric" />
              <button
                className="btn small"
                disabled={!ids.length}
                onClick={() => {
                  const j = Math.abs(num(jitter, 3));
                  run(tr(`ベロシティに ±${j} のゆらぎ`, `Humanize velocity by ±${j}`), (c) => c + Math.round((Math.random() * 2 - 1) * j));
                }}
              >
                {tr('反映', 'Apply')}
              </button>
            </span>
          </label>
        </div>
        <label className="row lbl" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={v.alsoSimilar} onChange={(e) => useVel.setState({ alsoSimilar: e.target.checked })} />
          {tr('同じパターンの小節にも同じ変更をする', 'Apply the same change to measures with the same pattern')}
        </label>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>{tr('原曲の打点から決める', 'From hits in the original')}</b>
          <span className="grow" />
          {hasAudio && (
            <span className="pill" title={tr('波形・打点の解析に使っている音', 'Audio used to analyze the waveform and hits')}>
              {tr(`解析元: ${srcName || '原曲'}`, `Source: ${srcName || 'Original'}`)}
            </span>
          )}
        </div>
        <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
          {tr(
            '同じ位置で鳴った原曲の音の強さを、指定した幅のベロシティに割り振ります。ゴーストノートの見分けに向いています。ドラムのステムを解析元にすると正確になります。',
            'Maps how loud the original is at each chip to a velocity in the given range. Good for spotting ghost notes. Using a drum stem as the analysis source makes it more accurate.',
          )}
        </p>
        <div className="row" style={{ gap: 6 }}>
          <span className="lbl">{tr('ベロシティの幅', 'Velocity range')}</span>
          <input
            className="field mono"
            style={{ width: 56 }}
            value={v.audioRange[0]}
            onChange={(e) => useVel.setState({ audioRange: [num(e.target.value, 30), v.audioRange[1]] })}
            aria-label={tr('弱い側', 'Soft end')}
          />
          –
          <input
            className="field mono"
            style={{ width: 56 }}
            value={v.audioRange[1]}
            onChange={(e) => useVel.setState({ audioRange: [v.audioRange[0], num(e.target.value, 100)] })}
            aria-label={tr('強い側', 'Hard end')}
          />
        </div>
        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          {v.proposal ? (
            <>
              <span className="lbl" style={{ color: 'var(--amber)' }}>
                {tr(`点線の候補 ${v.proposal.size} 個`, `${v.proposal.size} dotted ${pl(v.proposal.size, 'suggestion')}`)}
              </span>
              <span className="grow" />
              <button className="btn small" onClick={() => setProposal(null)}>
                {tr('やめる', 'Cancel')}
              </button>
              <button className="btn small primary" onClick={adoptProposal}>
                {tr('反映', 'Apply')}
              </button>
            </>
          ) : (
            <button
              className="btn small"
              style={{ flex: 1 }}
              disabled={!hasAudio || !ids.length}
              title={hasAudio ? '' : tr('原曲（BGM）を読み込むと使えます', 'Available once the original (BGM) is loaded')}
              onClick={() => setProposal(velFromAudio(chips, v.audioRange[0], v.audioRange[1]))}
            >
              {tr('候補を点線で見る', 'Preview as dotted suggestions')}
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>{tr('拍の位置で強弱をつける', 'Accent by beat position')}</b>
          <span className="grow" />
          <span className="lbl">{tr('1拍を4つに分けて', 'Each beat split into 4')}</span>
        </div>
        <div className="vel-slots">
          {v.beatAccent.map((val, i) => (
            <label key={i}>
              <span className="lbl">{slotNames()[i]}</span>
              <input
                className="field mono"
                value={val}
                onChange={(e) => {
                  const next = [...v.beatAccent] as [number, number, number, number];
                  next[i] = num(e.target.value, val);
                  useVel.setState({ beatAccent: next });
                }}
              />
              <span className="slot-bar">
                <i style={{ height: `${Math.max(4, Math.min(100, val))}%` }} />
              </span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8, gap: 4, flexWrap: 'wrap' }}>
          {accentPresets().map(([name, vals]) => (
            <button key={name} className="btn small ghost" onClick={() => useVel.setState({ beatAccent: vals })}>
              {name}
            </button>
          ))}
          <span className="grow" />
          <button
            className="btn small primary"
            disabled={!ids.length}
            onClick={() =>
              run(tr('拍の位置で強弱をつける', 'Accent by beat position'), (_cur, c) => {
                const k = beatSlot(doc, c);
                return k === null ? null : v.beatAccent[k];
              })
            }
          >
            {tr('反映', 'Apply')}
          </button>
        </div>
        <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          {tr('16分の位置に無いチップ（3連など）は変えません。', 'Chips that are not on a 16th position (triplets, etc.) are left unchanged.')}
        </p>
      </div>
    </aside>
  );
}
