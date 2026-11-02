// 履歴の一覧。好きな時点をクリックするとそこまで戻る（やり直す）。
import { useEffect, useRef, useState } from 'react';
import { jumpHistory, useEditor } from '../store/editor';
import { Icon } from './icons';

const hm = (t?: number) => (t ? new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '');

export function HistoryButton() {
  const [open, setOpen] = useState(false);
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  // 新しい順：やり直せる操作（未来）→ 今 → 過去 → 開いたとき
  const futureRows = [...future].map((h, i) => ({ h, n: past.length + future.length - i }));
  const pastRows = [...past].map((h, i) => ({ h, n: i + 1 })).reverse();
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className={`ib ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="編集の履歴（好きな時点へ戻れます）" disabled={!past.length && !future.length}>
        {Icon.history()}
      </button>
      {open && (
        <div className="history-pop scroll" role="menu">
          <div className="lbl" style={{ padding: '4px 8px 6px' }}>
            履歴 {past.length + future.length} 件 · クリックでその操作のあとに戻ります
          </div>
          {futureRows.map(({ h, n }) => (
            <button key={`f${n}`} className="history-item future" onClick={() => jumpHistory(n)} title="やり直す">
              <span className="dotc" />
              <span className="ellipsis">{h.label}</span>
              <span className="mono lbl">{hm(h.at)}</span>
            </button>
          ))}
          {pastRows.map(({ h, n }) => (
            <button key={`p${n}`} className={`history-item ${n === past.length ? 'now' : ''}`} onClick={() => jumpHistory(n)}>
              <span className="dotc" />
              <span className="ellipsis">{h.label}</span>
              <span className="mono lbl">{n === past.length ? '今' : hm(h.at)}</span>
            </button>
          ))}
          <button className={`history-item ${past.length === 0 ? 'now' : ''}`} onClick={() => jumpHistory(0)}>
            <span className="dotc" />
            <span className="ellipsis">開いたとき（編集する前）</span>
            <span className="mono lbl">{past.length === 0 ? '今' : ''}</span>
          </button>
        </div>
      )}
    </div>
  );
}
