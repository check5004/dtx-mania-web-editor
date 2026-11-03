// 操作バーの「フラム」：オンにするとクリックでフラム（同じレーンの2打をほんの少しずらす）を置く。▾ で置き方・間隔・ベロシティ。
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FLAM_DIVS, FLAM_TARGET_MS, type FlamSide } from '../edit/flam';
import { useEditor } from '../store/editor';
import { FLAM_MOD_LABEL, flamChips, flamStateOf, gapAt, gapText, setFlam, toggleFlamMode, unflamChips, useFlam } from '../store/flam';
import { Icon } from './icons';

export function FlamButton() {
  const mode = useFlam((s) => s.mode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tip = mode
    ? `フラムで置く：オン。クリックで同じレーンに2打をほんの少しずらして置きます（${FLAM_MOD_LABEL}+クリックなら1打）。選んだチップは Alt+F でフラムにする／1打に戻す`
    : `フラムで置く：オフ。オンにするとクリックでフラム（両手でほんの少しずらして叩く2打）を置きます。オフのままでも ${FLAM_MOD_LABEL}+クリックで1回だけフラム。選んだチップは Alt+F`;
  return (
    <div ref={ref} className={`flam-ctl ${mode ? 'on' : ''}`} role="group" aria-label="フラム">
      <button className="flam-toggle" aria-pressed={mode} onClick={() => toggleFlamMode()} title={tip}>
        {Icon.flam(14)}
        フラム
      </button>
      <button className="flam-more" aria-expanded={open} aria-label="フラムの置き方・間隔" title="フラムの置き方・間隔・1打目のベロシティ" onClick={() => setOpen((v) => !v)}>
        {Icon.chevronDown(12)}
      </button>
      {open && <FlamPanel anchor={ref} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** 置き方の小さな図。横線が拍（グリッド）、下が先（譜面と同じ向き）。薄いのが1打目 */
function SideFigure({ side }: { side: FlamSide }) {
  const beat = 13;
  const graceY = side === 'after' ? beat : beat + 5.5;
  const mainY = side === 'after' ? beat - 5.5 : beat;
  return (
    <svg width="34" height="24" viewBox="0 0 34 24" aria-hidden="true">
      <line x1="1" x2="33" y1={beat} y2={beat} stroke="currentColor" strokeOpacity=".55" strokeDasharray="2 2" />
      <rect x="6" y={graceY - 2.6} width="22" height="5.2" rx="1.6" fill="#FFD54F" opacity=".45" />
      <rect x="6" y={mainY - 2.6} width="22" height="5.2" rx="1.6" fill="#FFD54F" stroke="#0B0E13" strokeWidth=".8" />
    </svg>
  );
}

const SIDES: { side: FlamSide; title: string; sub: string }[] = [
  { side: 'after', title: '1打目を拍の上に', sub: '2打目をすぐ後ろへ。よく見る書き方' },
  { side: 'before', title: '2打目を拍の上に', sub: '1打目をすぐ前へ。叩くタイミングどおり' },
];

function FlamPanel({ anchor, onClose }: { anchor: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const f = useFlam();
  const selection = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  const cursorBeat = useEditor((s) => s.cursorBeat);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 372)), top: r.bottom + 6 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  // 外をクリック・Esc で閉じる
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [anchor, onClose]);

  const st = useMemo(() => flamStateOf(selection), [selection, doc, f.gap]);
  const here = useMemo(() => gapAt(cursorBeat), [cursorBeat, doc, f.gap]);

  return createPortal(
    <div ref={panel} className="popover flam-panel" style={{ position: 'fixed', left: pos.left, top: pos.top, width: 364 }}>
      <div className="row" style={{ gap: 8 }}>
        <b>フラム</b>
        <span className="lbl">同じレーンに2打をほんの少しずらして置く</span>
        <span className="grow" />
        <button className="ib" style={{ width: 24, height: 24 }} onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">
          ✕
        </button>
      </div>

      <div className="flam-label">置き方</div>
      <div className="flam-sides" role="radiogroup" aria-label="置き方">
        {SIDES.map((s) => (
          <button key={s.side} role="radio" aria-checked={f.side === s.side} className={`flam-side ${f.side === s.side ? 'on' : ''}`} onClick={() => setFlam({ side: s.side })}>
            <SideFigure side={s.side} />
            <span>
              <b>{s.title}</b>
              <span className="lbl">{s.sub}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="flam-row">
        <span className="flam-label">間隔</span>
        <select
          className="field mono"
          value={String(f.gap)}
          onChange={(e) => setFlam({ gap: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}
          title="自動は、その所の BPM で約40ミリ秒にいちばん近い細かさ（184BPM なら 1/32、138BPM なら 1/48）"
        >
          <option value="auto">自動（約{FLAM_TARGET_MS}ms）</option>
          {FLAM_DIVS.map((d) => (
            <option key={d} value={d}>
              1/{d}
            </option>
          ))}
        </select>
      </div>
      <div className="flam-note lbl">
        ▶ の所（BPM {Math.round(here.bpm * 100) / 100}）では <b className="mono">{gapText(here.div, here.bpm)}</b>
      </div>

      <div className="flam-row">
        <span className="flam-label">1打目のベロシティ</span>
        <div className="row" style={{ gap: 8 }}>
          <input
            type="range"
            min={30}
            max={100}
            step={5}
            value={f.grace}
            onChange={(e) => setFlam({ grace: Number(e.target.value) })}
            style={{ flex: 1 }}
            aria-label="1打目のベロシティ（2打目に対する割合）"
          />
          <span className="mono" style={{ width: 40, textAlign: 'right' }}>
            {f.grace}%
          </span>
        </div>
      </div>
      <div className="flam-note lbl">先に鳴る1打目を、2打目のベロシティのこの割合で置きます（100% なら同じ）</div>

      <label className="row flam-check" title="グリッドより細かい間で同じレーンを2回叩いたとき、後の1打で前の1打を消さずにフラムにします">
        <input type="checkbox" checked={f.rec} onChange={(e) => setFlam({ rec: e.target.checked })} />
        <span>録音で、グリッドでは分けられないすばやい2打をフラムにする</span>
      </label>

      <div className="row" style={{ gap: 6, marginTop: 12 }}>
        <button className="btn small primary" disabled={st.single.length === 0} onClick={() => flamChips(selection)} title="選んだチップをフラムにします（Alt+F）">
          選んだチップをフラムにする{st.single.length > 1 ? `（${st.single.length}）` : ''}
        </button>
        <button className="btn small" disabled={st.pairs.length === 0} onClick={() => unflamChips(selection)} title="選んだフラムを1打に戻します（Alt+F）">
          1打に戻す{st.pairs.length > 1 ? `（${st.pairs.length}）` : ''}
        </button>
      </div>

      <ul className="flam-help lbl">
        <li>
          <b>「フラム」をオン</b>：クリックでフラムを置く（キー入力も）
        </li>
        <li>
          <b>{FLAM_MOD_LABEL}+クリック</b>：1回だけ逆（オフならフラム、オンなら1打）
        </li>
        <li>
          <b>Alt+F</b>・右クリック：選んだチップをフラムにする／1打に戻す
        </li>
      </ul>
    </div>,
    document.body,
  );
}
