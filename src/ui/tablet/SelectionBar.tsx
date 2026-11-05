// タブレット版の選択バー：チップを選んでいる間、譜面の上端に浮かせる（手で隠れない）。
// ↓↑ は1グリッド前・後ろ、←→ はレーン、ベロシティは長押しメニューと同じ中身、… はそのほか
import { useRef, useState } from 'react';
import { tr } from '../../i18n';
import { frac, mul } from '../../dtx/fraction';
import { gridStep } from '../../edit/ops';
import { openCtxMenu } from '../../store/ctxMenu';
import { copySelection, cutSelection, deleteChips, moveSelection, paste, selectAll, toast, undo, useEditor } from '../../store/editor';
import { toggleFlamSelection } from '../../store/flam';
import { Icon } from '../icons';

function BarBtn({ icon, label, onClick, danger, disabled, title }: { icon: React.ReactNode; label?: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; danger?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button className={`t-selbar-btn ${label ? '' : 'icon'} ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={title ?? label}>
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}

/** 選んだチップを1グリッド動かす（dir: 1 で後ろ＝上、-1 で前＝下）・レーンを1つずらす */
function nudge(dBeat: -1 | 0 | 1, dLane: -1 | 0 | 1) {
  const s = useEditor.getState();
  const ok = moveSelection(dBeat ? mul(gridStep(s.view.div), frac(dBeat)) : frac(0), dLane);
  if (!ok) toast(dLane ? tr('これ以上レーンを動かせません', "Can't move the lanes any further") : tr('これ以上動かせません', "Can't move any further"), 'info', 1800);
}

export function SelectionBar() {
  const sel = useEditor((s) => s.selection);
  const clip = useEditor((s) => s.clipboard.length);
  const [more, setMore] = useState(false);
  const velRef = useRef<HTMLDivElement>(null);
  if (sel.length === 0) return null;
  const n = sel.length;
  const openVel = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // メニューの中身は長押しと同じ（ベロシティ・レーン・フラム・コピー・削除）。ボタンの下に出す
    openCtxMenu({ kind: 'chips', ids: [...sel], anchor: sel[0] }, r.left - 36, r.bottom + 38, true);
  };
  const del = () => {
    deleteChips([...sel]);
    toast(tr(`${n}個のチップを消しました`, `Deleted ${n} chip${n > 1 ? 's' : ''}`), 'info', 3500, { label: tr('元に戻す', 'Undo'), run: undo });
  };
  return (
    <div className="t-selbar" role="toolbar" aria-label={tr('選んだチップ', 'Selected chips')} onPointerDown={(e) => e.stopPropagation()}>
      <div className="t-selbar-count">
        <b className="mono">{n}</b>
        <span>{tr('個', n > 1 ? 'chips' : 'chip')}</span>
      </div>
      <i className="t-selbar-sep" />
      <BarBtn icon={Icon.arrowDown(20)} onClick={() => nudge(-1, 0)} title={tr('1グリッド前へ（下）', 'One grid step earlier (down)')} />
      <BarBtn icon={Icon.arrowUp(20)} onClick={() => nudge(1, 0)} title={tr('1グリッド後ろへ（上）', 'One grid step later (up)')} />
      <BarBtn icon={Icon.arrowLeft(20)} onClick={() => nudge(0, -1)} title={tr('左のレーンへ', 'To the lane on the left')} />
      <BarBtn icon={Icon.arrowRight(20)} onClick={() => nudge(0, 1)} title={tr('右のレーンへ', 'To the lane on the right')} />
      <i className="t-selbar-sep" />
      <div className="t-selbar-grp" ref={velRef}>
        <BarBtn icon={Icon.bars(18)} label={tr('ベロシティ', 'Velocity')} onClick={openVel} />
        <BarBtn icon={Icon.flam(18)} label={tr('フラム', 'Flam')} onClick={() => toggleFlamSelection()} title={tr('フラムにする・1打に戻す（Alt+F）', 'Make a flam / back to one note (Alt+F)')} />
        <BarBtn icon={Icon.copy(18)} label={tr('コピー', 'Copy')} onClick={() => toast(tr(`${copySelection()}個をコピーしました（貼り付けは ▶ の所・長押しメニュー）`, `Copied ${n} (paste at ▶ or from the long-press menu)`), 'ok', 2500)} />
        <BarBtn icon={Icon.cut(18)} label={tr('切り取り', 'Cut')} onClick={() => cutSelection()} />
        <BarBtn icon={Icon.trash(18)} label={tr('削除', 'Delete')} danger onClick={del} />
      </div>
      <div className="t-selbar-more">
        <BarBtn icon={Icon.dots(20)} onClick={() => setMore((v) => !v)} title={tr('そのほか', 'More')} />
        {more && (
          <div className="t-pop t-selbar-pop" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="t-pop-item"
              disabled={!clip}
              onClick={() => {
                setMore(false);
                paste();
              }}
            >
              {Icon.paste(16)}
              <span>{clip ? tr(`▶ の所に貼り付け（${clip} 個）`, `Paste at ▶ (${clip})`) : tr('▶ の所に貼り付け', 'Paste at ▶')}</span>
            </button>
            <button
              className="t-pop-item"
              onClick={() => {
                setMore(false);
                selectAll();
              }}
            >
              {Icon.selectBox(16)}
              <span>{tr('ドラムのチップを全部選ぶ', 'Select all drum chips')}</span>
            </button>
          </div>
        )}
      </div>
      <i className="t-selbar-sep" />
      <BarBtn icon={Icon.close(20)} onClick={() => useEditor.setState({ selection: [] })} title={tr('選ぶのをやめる', 'Clear the selection')} />
    </div>
  );
}
