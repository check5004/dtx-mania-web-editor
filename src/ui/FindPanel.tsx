// 検索と置換のパネル（譜面の右上に重ねて出す）。
import { useEffect, useRef, useState } from 'react';
import { parseBase36x2 } from '../dtx/base36';
import { DRUM_LANES, type ChipKind } from '../dtx/model';
import { useInputSettings } from '../input/settings';
import {
  closeFind,
  deleteResults,
  gotoResult,
  mirrorSelection,
  rangeFromSelection,
  relaneResults,
  replaceWavResults,
  selectResults,
  setKindResults,
  setQuery,
  swapLanesInRange,
  useFind,
} from '../store/find';
import { useEditor } from '../store/editor';
import { Icon } from './icons';

const KINDS: [ChipKind, string][] = [
  ['normal', '通常'],
  ['hidden', '不可視'],
  ['nochip', '音だけ'],
];

export function FindPanel() {
  const st = useFind();
  const order = useInputSettings((s) => s.laneOrder);
  const hasSel = useEditor((s) => s.selection.length > 0);
  const [tab, setTab] = useState<'replace' | 'swap'>('replace');
  const [toLane, setToLane] = useState(4);
  const [resound, setResound] = useState(true);
  const [wav, setWav] = useState('');
  const [swapA, setSwapA] = useState(3);
  const [swapB, setSwapB] = useState(4);
  const ref = useRef<HTMLDivElement>(null);
  const q = st.q;
  const n = st.results.length;
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  const toggleLane = (l: number) => setQuery({ lanes: q.lanes.includes(l) ? q.lanes.filter((x) => x !== l) : [...q.lanes, l] });
  const toggleKind = (k: ChipKind) => {
    const next = q.kinds.includes(k) ? q.kinds.filter((x) => x !== k) : [...q.kinds, k];
    if (next.length) setQuery({ kinds: next });
  };
  const wavNo = /^[0-9A-Za-z]{1,2}$/.test(wav.trim()) ? parseBase36x2(wav.trim().toUpperCase().padStart(2, '0')) : -1;
  return (
    <div
      ref={ref}
      className="find-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closeFind();
        }
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          gotoResult(st.index + (e.shiftKey ? -1 : 1));
        }
        e.stopPropagation();
      }}
    >
      <div className="row find-head">
        <b>検索と置換</b>
        <span className={`find-count mono ${n ? '' : 'none'}`}>{st.error ? '—' : n ? `${st.index >= 0 ? st.index + 1 : '–'} / ${n}` : '0 件'}</span>
        <span className="grow" />
        <button className="ib tiny" onClick={() => gotoResult(st.index - 1)} disabled={!n} title="前の結果（Shift+Enter）">
          {Icon.chevronUp(13)}
        </button>
        <button className="ib tiny" onClick={() => gotoResult(st.index + 1)} disabled={!n} title="次の結果（Enter・F3）">
          {Icon.chevronDown(13)}
        </button>
        <button className="ib tiny" onClick={closeFind} aria-label="閉じる">
          ✕
        </button>
      </div>
      <div className="find-sec">
        <div className="find-lbl">
          レーン
          <button className="link-btn" onClick={() => setQuery({ lanes: [] })}>
            {q.lanes.length ? 'すべてに戻す' : 'すべて'}
          </button>
        </div>
        <div className="find-lanes">
          {order.map((l) => {
            const d = DRUM_LANES[l];
            const on = q.lanes.includes(l);
            return (
              <button key={l} className={`mono ${on ? 'on' : ''}`} style={{ ['--c' as string]: d.color }} onClick={() => toggleLane(l)} title={d.name}>
                {d.key}
              </button>
            );
          })}
        </div>
        <div className="find-grid">
          <span className="find-lbl">HHO・LBD</span>
          <div className="seg small">
            {(
              [
                ['any', '問わない'],
                ['main', '除く'],
                ['alt', 'だけ'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={q.alt === k ? 'on' : ''} onClick={() => setQuery({ alt: k })}>
                {label}
              </button>
            ))}
          </div>
          <span className="find-lbl">種類</span>
          <div className="seg small">
            {KINDS.map(([k, label]) => (
              <button key={k} className={q.kinds.includes(k) ? 'on' : ''} onClick={() => toggleKind(k)}>
                {label}
              </button>
            ))}
          </div>
          <span className="find-lbl">WAV番号</span>
          <input className="field mono" value={q.wavs} onChange={(e) => setQuery({ wavs: e.target.value })} placeholder="例: 0A 0B（空なら問わない）" />
          <span className="find-lbl">小節</span>
          <div className="row" style={{ gap: 4 }}>
            <input className="field mono" style={{ width: 58 }} value={q.from} onChange={(e) => setQuery({ from: e.target.value })} placeholder="000" aria-label="小節の始め" />
            <span className="lbl">〜</span>
            <input className="field mono" style={{ width: 58 }} value={q.to} onChange={(e) => setQuery({ to: e.target.value })} placeholder="最後" aria-label="小節の終わり" />
            <button className="btn small ghost" onClick={rangeFromSelection} disabled={!hasSel} title="選んでいるチップの小節を範囲にします">
              選択から
            </button>
          </div>
        </div>
        {st.error && <div className="find-err">{st.error}</div>}
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button className="btn small" onClick={selectResults} disabled={!n}>
            見つかった {n} 個を選択
          </button>
          <button className="btn small ghost" onClick={mirrorSelection} disabled={!n && !hasSel} title="選んでいるチップ（無ければ見つかったチップ）を、画面の並びで左右反転します">
            左右反転
          </button>
        </div>
      </div>
      <div className="seg full small" style={{ margin: '2px 0 8px' }}>
        <button className={tab === 'replace' ? 'on' : ''} onClick={() => setTab('replace')}>
          見つかったチップを置換
        </button>
        <button className={tab === 'swap' ? 'on' : ''} onClick={() => setTab('swap')}>
          レーンの入れ替え
        </button>
      </div>
      {tab === 'replace' ? (
        <div className="find-sec">
          <div className="find-row">
            <span className="find-lbl">レーンへ移す</span>
            <select className="field" value={toLane} onChange={(e) => setToLane(Number(e.target.value))}>
              {order.map((l) => (
                <option key={l} value={l}>
                  {DRUM_LANES[l].key} {DRUM_LANES[l].name}
                </option>
              ))}
            </select>
            <button className="btn small" disabled={!n} onClick={() => relaneResults(toLane, 'keep', resound)}>
              移す
            </button>
          </div>
          <label className="row" style={{ gap: 6, margin: '2px 0 8px 92px' }}>
            <input type="checkbox" checked={resound} onChange={(e) => setResound(e.target.checked)} />
            <span className="lbl">音も移した先のレーンの音にする（ベロシティは保つ）</span>
          </label>
          <div className="find-row">
            <span className="find-lbl">WAV番号</span>
            <input className="field mono" value={wav} onChange={(e) => setWav(e.target.value)} placeholder="例: 0C" />
            <button className="btn small" disabled={!n || wavNo <= 0} onClick={() => replaceWavResults(wavNo)}>
              替える
            </button>
          </div>
          <div className="find-row">
            <span className="find-lbl">種類</span>
            <div className="row" style={{ gap: 4 }}>
              {KINDS.map(([k, label]) => (
                <button key={k} className="btn small ghost" disabled={!n} onClick={() => setKindResults(k)}>
                  {label}に
                </button>
              ))}
            </div>
          </div>
          <div className="find-row">
            <span className="find-lbl" />
            <button className="btn small ghost danger" disabled={!n} onClick={deleteResults}>
              {Icon.trash(12)} 見つかった {n} 個を消す
            </button>
          </div>
        </div>
      ) : (
        <div className="find-sec">
          <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
            上の「小節」の範囲（空なら曲全体）で、2つのレーンのチップを丸ごと入れ替えます。HHオープン・左バスドラムは、入れ替え先に2種目が無ければ通常のチップになります。
          </p>
          <div className="row" style={{ gap: 6 }}>
            <select className="field" value={swapA} onChange={(e) => setSwapA(Number(e.target.value))} aria-label="入れ替えるレーン1">
              {order.map((l) => (
                <option key={l} value={l}>
                  {DRUM_LANES[l].key} {DRUM_LANES[l].name}
                </option>
              ))}
            </select>
            <span>⇄</span>
            <select className="field" value={swapB} onChange={(e) => setSwapB(Number(e.target.value))} aria-label="入れ替えるレーン2">
              {order.map((l) => (
                <option key={l} value={l}>
                  {DRUM_LANES[l].key} {DRUM_LANES[l].name}
                </option>
              ))}
            </select>
            <button className="btn small primary" disabled={swapA === swapB} onClick={() => swapLanesInRange(swapA, swapB)}>
              入れ替え
            </button>
          </div>
        </div>
      )}
      <p className="lbl" style={{ margin: '8px 0 0' }}>どの操作も Ctrl+Z で戻せます。</p>
    </div>
  );
}
