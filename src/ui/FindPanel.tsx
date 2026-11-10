// 検索と置換のパネル（譜面の右上に重ねて出す）。
import { tr, isJa } from '../i18n';
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

const kinds = (): [ChipKind, string][] => [
  ['normal', tr('通常', 'Normal')],
  ['hidden', tr('不可視', 'Invisible')],
  ['nochip', tr('音だけ', 'Sound only')],
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
        <b>{tr('検索と置換', 'Find and replace')}</b>
        <span className={`find-count mono ${n ? '' : 'none'}`}>{st.error ? '—' : n ? `${st.index >= 0 ? st.index + 1 : '–'} / ${n}` : tr('0 件', 'None')}</span>
        <span className="grow" />
        <button className="ib tiny" onClick={() => gotoResult(st.index - 1)} disabled={!n} title={tr('前の結果（Shift+Enter）', 'Previous result (Shift+Enter)')}>
          {Icon.chevronUp(13)}
        </button>
        <button className="ib tiny" onClick={() => gotoResult(st.index + 1)} disabled={!n} title={tr('次の結果（Enter・F3）', 'Next result (Enter, F3)')}>
          {Icon.chevronDown(13)}
        </button>
        <button className="ib tiny" onClick={closeFind} aria-label={tr('閉じる', 'Close')}>
          ✕
        </button>
      </div>
      <div className="find-sec">
        <div className="find-lbl">
          {tr('レーン', 'Lanes')}
          <button className="link-btn" onClick={() => setQuery({ lanes: [] })}>
            {q.lanes.length ? tr('すべてに戻す', 'Back to all') : tr('すべて', 'All')}
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
          <span className="find-lbl" title={tr('2種目：HHオープン・左バスドラム・リム', 'Second type: HH open, left bass drum, rim')}>
            {tr('HHO・LBD・リム', 'HHO / LBD / Rim')}
          </span>
          <div className="seg small">
            {(
              [
                ['any', tr('問わない', 'Any')],
                ['main', tr('除く', 'Exclude')],
                ['alt', tr('だけ', 'Only')],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={q.alt === k ? 'on' : ''} onClick={() => setQuery({ alt: k })}>
                {label}
              </button>
            ))}
          </div>
          <span className="find-lbl">{tr('種類', 'Type')}</span>
          <div className="seg small">
            {kinds().map(([k, label]) => (
              <button key={k} className={q.kinds.includes(k) ? 'on' : ''} onClick={() => toggleKind(k)}>
                {label}
              </button>
            ))}
          </div>
          <span className="find-lbl">{tr('WAV番号', 'WAV no.')}</span>
          <input
            className="field mono"
            value={q.wavs}
            onChange={(e) => setQuery({ wavs: e.target.value })}
            placeholder={tr('例: 0A 0B（空なら問わない）', 'e.g. 0A 0B (empty = any)')}
          />
          <span className="find-lbl">{tr('小節', 'Measures')}</span>
          <div className="row" style={{ gap: 4 }}>
            <input className="field mono" style={{ width: 58 }} value={q.from} onChange={(e) => setQuery({ from: e.target.value })} placeholder="000" aria-label={tr('小節の始め', 'First measure')} />
            <span className="lbl">{tr('〜', '–')}</span>
            <input className="field mono" style={{ width: 58 }} value={q.to} onChange={(e) => setQuery({ to: e.target.value })} placeholder={tr('最後', 'End')} aria-label={tr('小節の終わり', 'Last measure')} />
            <button className="btn small ghost" onClick={rangeFromSelection} disabled={!hasSel} title={tr('選んでいるチップの小節を範囲にします', 'Use the measures of the selected chips')}>
              {tr('選択から', 'From selection')}
            </button>
          </div>
        </div>
        {st.error && <div className="find-err">{st.error}</div>}
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button className="btn small" onClick={selectResults} disabled={!n}>
            {tr(`見つかった ${n} 個を選択`, `Select ${n} found`)}
          </button>
          <button className="btn small ghost" onClick={mirrorSelection} disabled={!n && !hasSel} title={tr('選んでいるチップ（無ければ見つかったチップ）を、画面の並びで左右反転します', 'Mirrors the selected chips (or the found chips) left to right in the on-screen lane order')}
          >
            {tr('左右反転', 'Mirror')}
          </button>
        </div>
      </div>
      <div className="seg full small" style={{ margin: '2px 0 8px' }}>
        <button className={tab === 'replace' ? 'on' : ''} onClick={() => setTab('replace')}>
          {tr('見つかったチップを置換', 'Replace found chips')}
        </button>
        <button className={tab === 'swap' ? 'on' : ''} onClick={() => setTab('swap')}>
          {tr('レーンの入れ替え', 'Swap lanes')}
        </button>
      </div>
      {tab === 'replace' ? (
        <div className="find-sec">
          <div className="find-row">
            <span className="find-lbl">{tr('レーンへ移す', 'Move to lane')}</span>
            <select className="field" value={toLane} onChange={(e) => setToLane(Number(e.target.value))}>
              {order.map((l) => (
                <option key={l} value={l}>
                  {DRUM_LANES[l].key} {DRUM_LANES[l].name}
                </option>
              ))}
            </select>
            <button className="btn small" disabled={!n} onClick={() => relaneResults(toLane, 'keep', resound)}>
              {tr('移す', 'Move')}
            </button>
          </div>
          <label className="row" style={{ gap: 6, margin: '2px 0 8px 92px' }}>
            <input type="checkbox" checked={resound} onChange={(e) => setResound(e.target.checked)} />
            <span className="lbl">{tr('音も移した先のレーンの音にする（ベロシティは保つ）', "Also use the new lane's sound (velocity is kept)")}</span>
          </label>
          <div className="find-row">
            <span className="find-lbl">{tr('WAV番号', 'WAV no.')}</span>
            <input className="field mono" value={wav} onChange={(e) => setWav(e.target.value)} placeholder={tr('例: 0C', 'e.g. 0C')} />
            <button className="btn small" disabled={!n || wavNo <= 0} onClick={() => replaceWavResults(wavNo)}>
              {tr('替える', 'Change')}
            </button>
          </div>
          <div className="find-row">
            <span className="find-lbl">{tr('種類', 'Set type')}</span>
            <div className="row" style={{ gap: 4 }}>
              {kinds().map(([k, label]) => (
                <button key={k} className="btn small ghost" disabled={!n} onClick={() => setKindResults(k)}>
                  {isJa() ? `${label}に` : label}
                </button>
              ))}
            </div>
          </div>
          <div className="find-row">
            <span className="find-lbl" />
            <button className="btn small ghost danger" disabled={!n} onClick={deleteResults}>
              {Icon.trash(12)} {tr(`見つかった ${n} 個を消す`, `Delete ${n} found`)}
            </button>
          </div>
        </div>
      ) : (
        <div className="find-sec">
          <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
            {tr(
              '上の「小節」の範囲（空なら曲全体）で、2つのレーンのチップを丸ごと入れ替えます。HHオープン・左バスドラムは、入れ替え先に2種目が無ければ通常のチップになります。',
              'Swaps all chips between two lanes within the "Measures" range above (empty = the whole song). HH open and left bass drum chips become normal chips if the other lane has no second type.',
            )}
          </p>
          <div className="row" style={{ gap: 6 }}>
            <select className="field" value={swapA} onChange={(e) => setSwapA(Number(e.target.value))} aria-label={tr('入れ替えるレーン1', 'Lane to swap 1')}>
              {order.map((l) => (
                <option key={l} value={l}>
                  {DRUM_LANES[l].key} {DRUM_LANES[l].name}
                </option>
              ))}
            </select>
            <span>⇄</span>
            <select className="field" value={swapB} onChange={(e) => setSwapB(Number(e.target.value))} aria-label={tr('入れ替えるレーン2', 'Lane to swap 2')}>
              {order.map((l) => (
                <option key={l} value={l}>
                  {DRUM_LANES[l].key} {DRUM_LANES[l].name}
                </option>
              ))}
            </select>
            <button className="btn small primary" disabled={swapA === swapB} onClick={() => swapLanesInRange(swapA, swapB)}>
              {tr('入れ替え', 'Swap')}
            </button>
          </div>
        </div>
      )}
      <p className="lbl" style={{ margin: '8px 0 0' }}>{tr('どの操作も Ctrl+Z で戻せます。', 'Every action can be undone with Ctrl+Z.')}</p>
    </div>
  );
}
