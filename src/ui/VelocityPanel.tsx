// ベロシティの編集モードの右パネル（道具）。対象の範囲とレーン、分布、まとめて変える、原曲の打点から決める、拍の位置で強弱。
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

const SCOPES: [VelScope, string][] = [
  ['selection', '選択範囲'],
  ['visible', '表示中'],
  ['section', 'セクション'],
  ['song', '曲全体'],
];

const TOOLS: [VelTool, string, string][] = [
  ['select', '選択', 'ベロシティの列でクリックかドラッグしてチップを選びます。Alt+ホイールか Alt+↑↓ で選んだチップを5ずつ（Shift で1ずつ）変えます。'],
  ['pencil', '鉛筆', 'ベロシティの列をなぞると、なぞった位置のベロシティになります。'],
  ['line', '直線', 'ベロシティの列で始点から終点へドラッグすると、間のチップがなめらかに変わります（クレッシェンドなど）。'],
];

const ACCENT_PRESETS: [string, [number, number, number, number]][] = [
  ['表を強く', [100, 60, 80, 60]],
  ['4分ごと', [100, 60, 60, 60]],
  ['裏を強く', [60, 60, 100, 60]],
];

const SLOT_NAMES = ['表', '2つ目', '裏', '4つ目'];

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
    if (v.scope === 'selection') return chips.length ? `${chips.length} 個を選択中` : '譜面でチップを選んでください';
    const r = scopeRange(v.scope, vis);
    if (!r) return 'カーソルの小節にセクションがありません';
    if (!Number.isFinite(r.from)) return '曲全体';
    const a = tempo.locate(Math.max(0, r.from)).m;
    const b = Number.isFinite(r.to) ? tempo.locate(Math.max(0, r.to - 1e-6)).m : null;
    return b === null ? `${toMeasure(a)}〜` : `${toMeasure(a)}–${toMeasure(b)}`;
  })();

  const run = (label: string, fn: (cur: number, c: (typeof chips)[number]) => number | null) => {
    if (ids.length === 0) return;
    applyVel(`${label}（${ids.length}個）`, ids, fn);
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
    run(`ベロシティの幅を ${a}〜${b} に詰める`, (cur) => (mx === mn ? (a + b) / 2 : a + ((cur - mn) / (mx - mn)) * (b - a)));
  };

  return (
    <aside className="right-panel scroll vel-panel">
      <div className="row" style={{ padding: '2px 2px 0' }}>
        <span style={{ color: 'var(--accent)' }}>{Icon.bars(15)}</span>
        <b style={{ fontSize: 14 }}>ベロシティの編集</b>
        <span className="grow" />
        <span className="lbl">V か Esc で閉じる</span>
        <button className="ib" style={{ width: 26, height: 26 }} onClick={() => toggleVelMode(false)} aria-label="ベロシティの編集を閉じる">
          ✕
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="lbl">対象の範囲</span>
          <span className="grow" />
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
            {range}
          </span>
        </div>
        <div className="seg small" style={{ display: 'flex', marginBottom: 10 }}>
          {SCOPES.map(([k, label]) => (
            <button key={k} className={v.scope === k ? 'on' : ''} style={{ flex: 1 }} onClick={() => useVel.setState({ scope: k })}>
              {label}
            </button>
          ))}
        </div>
        <div className="vel-lanes" role="group" aria-label="ベロシティのレーンに出すレーン（3つまで）">
          {DRUM_LANES.map((l, i) => {
            const on = v.lanes.includes(i);
            return (
              <button
                key={l.key}
                className={on ? 'on' : ''}
                style={on ? { borderColor: l.color, color: l.color } : undefined}
                onClick={() => toggleVelLane(i)}
                title={`${l.name}のベロシティを出す（3つまで）`}
              >
                {l.key}
              </button>
            );
          })}
        </div>
        <div className="vel-hist" aria-label="ベロシティの分布">
          {hist.bins.map((n, i) => (
            <span key={i} style={{ height: `${Math.max(n ? 6 : 2, (n / maxBin) * 100)}%`, background: n ? (i >= 7 ? 'var(--accent)' : i >= 4 ? '#5D7189' : '#3A4656') : '#1C222B' }} title={`${i * 10 + 1}〜${(i + 1) * 10}: ${n}個`} />
          ))}
        </div>
        <div className="row lbl mono" style={{ justifyContent: 'space-between', marginTop: 2 }}>
          <span>1</span>
          <span>50</span>
          <span>100</span>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span style={{ fontSize: 12 }}>
            <b className="mono">{chips.length}</b> 個 · 平均 <span className="mono">{chips.length ? Math.round(hist.avg) : '-'}</span>
          </span>
          <span className="grow" />
          <button className="btn small" disabled={!chips.length} onClick={() => pick((x) => x <= 50)} title="ベロシティ50以下のチップだけを選ぶ">
            弱だけ選ぶ
          </button>
          <button className="btn small" disabled={!chips.length} onClick={() => pick((x) => x >= 80)} title="ベロシティ80以上のチップだけを選ぶ">
            強だけ選ぶ
          </button>
        </div>
      </div>

      <div className="card">
        <div className="seg" style={{ display: 'flex' }} role="radiogroup" aria-label="道具">
          {TOOLS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={v.tool === k} className={v.tool === k ? 'on' : ''} style={{ flex: 1 }} onClick={() => useVel.setState({ tool: k })}>
              {label}
            </button>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
          {TOOLS.find(([k]) => k === v.tool)![2]}
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>まとめて変える</b>
          <span className="grow" />
          <button className="btn small" disabled={!ids.length} onClick={() => run('ベロシティを -5', (c) => c - 5)}>
            -5
          </button>
          <button className="btn small" disabled={!ids.length} onClick={() => run('ベロシティを +5', (c) => c + 5)}>
            +5
          </button>
        </div>
        <div className="vel-ops">
          <label>
            <span className="lbl">そろえる</span>
            <span className="row" style={{ gap: 6 }}>
              <input className="field mono" value={setTo} onChange={(e) => setSetTo(e.target.value)} inputMode="numeric" />
              <button className="btn small" disabled={!ids.length} onClick={() => run(`ベロシティを ${num(setTo, 100)} にそろえる`, () => num(setTo, 100))}>
                適用
              </button>
            </span>
          </label>
          <label>
            <span className="lbl">倍率（%）</span>
            <span className="row" style={{ gap: 6 }}>
              <input className="field mono" value={scale} onChange={(e) => setScale(e.target.value)} inputMode="numeric" />
              <button className="btn small" disabled={!ids.length} onClick={() => run(`ベロシティを ${num(scale, 100)}% にする`, (c) => (c * num(scale, 100)) / 100)}>
                適用
              </button>
            </span>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="lbl">幅を詰める（今の強弱の差を保ったまま、この幅に収める）</span>
            <span className="row" style={{ gap: 4 }}>
              <input className="field mono" value={lo} onChange={(e) => setLo(e.target.value)} inputMode="numeric" aria-label="下限" />
              〜
              <input className="field mono" value={hi} onChange={(e) => setHi(e.target.value)} inputMode="numeric" aria-label="上限" />
              <button className="btn small" disabled={!ids.length} onClick={narrow}>
                適用
              </button>
            </span>
          </label>
          <label>
            <span className="lbl">ゆらぎ（±）</span>
            <span className="row" style={{ gap: 6 }}>
              <input className="field mono" value={jitter} onChange={(e) => setJitter(e.target.value)} inputMode="numeric" />
              <button
                className="btn small"
                disabled={!ids.length}
                onClick={() => {
                  const j = Math.abs(num(jitter, 3));
                  run(`ベロシティに ±${j} のゆらぎ`, (c) => c + Math.round((Math.random() * 2 - 1) * j));
                }}
              >
                適用
              </button>
            </span>
          </label>
        </div>
        <label className="row lbl" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={v.alsoSimilar} onChange={(e) => useVel.setState({ alsoSimilar: e.target.checked })} />
          同じパターンの小節にも同じ変更をする
        </label>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>原曲の打点から決める</b>
          <span className="grow" />
          {hasAudio && <span className="pill" title="波形・打点の解析に使っている音">解析元: {srcName || '原曲'}</span>}
        </div>
        <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
          同じ位置で鳴った原曲の音の強さを、指定した幅のベロシティに割り振ります。ゴーストノートの見分けに向いています。ドラムのステムを解析元にすると正確になります。
        </p>
        <div className="row" style={{ gap: 6 }}>
          <span className="lbl">ベロシティの幅</span>
          <input
            className="field mono"
            style={{ width: 56 }}
            value={v.audioRange[0]}
            onChange={(e) => useVel.setState({ audioRange: [num(e.target.value, 30), v.audioRange[1]] })}
            aria-label="弱い側"
          />
          〜
          <input
            className="field mono"
            style={{ width: 56 }}
            value={v.audioRange[1]}
            onChange={(e) => useVel.setState({ audioRange: [v.audioRange[0], num(e.target.value, 100)] })}
            aria-label="強い側"
          />
        </div>
        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          {v.proposal ? (
            <>
              <span className="lbl" style={{ color: 'var(--amber)' }}>
                点線の候補 {v.proposal.size} 個
              </span>
              <span className="grow" />
              <button className="btn small" onClick={() => setProposal(null)}>
                やめる
              </button>
              <button className="btn small primary" onClick={adoptProposal}>
                採用する
              </button>
            </>
          ) : (
            <button
              className="btn small"
              style={{ flex: 1 }}
              disabled={!hasAudio || !ids.length}
              title={hasAudio ? '' : '原曲（BGM）を読み込むと使えます'}
              onClick={() => setProposal(velFromAudio(chips, v.audioRange[0], v.audioRange[1]))}
            >
              候補を点線で見る
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>拍の位置で強弱をつける</b>
          <span className="grow" />
          <span className="lbl">1拍を4つに分けて</span>
        </div>
        <div className="vel-slots">
          {v.beatAccent.map((val, i) => (
            <label key={i}>
              <span className="lbl">{SLOT_NAMES[i]}</span>
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
          {ACCENT_PRESETS.map(([name, vals]) => (
            <button key={name} className="btn small ghost" onClick={() => useVel.setState({ beatAccent: vals })}>
              {name}
            </button>
          ))}
          <span className="grow" />
          <button
            className="btn small primary"
            disabled={!ids.length}
            onClick={() => run('拍の位置で強弱をつける', (_cur, c) => {
              const k = beatSlot(doc, c);
              return k === null ? null : v.beatAccent[k];
            })}
          >
            適用
          </button>
        </div>
        <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          16分の位置に無いチップ（3連など）は変えません。
        </p>
      </div>
    </aside>
  );
}
