// パネルの境目：ドラッグで幅（高さ）を変え、ボタンかダブルクリックで開け閉めする。
import { useRef } from 'react';
import { LAYOUT_LIMITS, SEEK_CLOSED_H, setLayout, togglePanel, useLayout } from '../store/layout';

/** 左右のパネルと譜面の境目 */
export function VSplitter({ side, open }: { side: 'left' | 'right'; open: boolean }) {
  const drag = useRef<{ x0: number; w0: number; moved: boolean } | null>(null);
  const label = side === 'left' ? '左のパネル' : '右のパネル';
  return (
    <div className={`vsplit ${side}`}>
      <div
        className="vsplit-hit"
        role="separator"
        aria-orientation="vertical"
        aria-label={`${label}の幅`}
        title={`ドラッグで${label}の幅を変える（ダブルクリックで${open ? '閉じる' : '開く'}）`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const l = useLayout.getState();
          const w0 = open ? (side === 'left' ? l.leftW : l.rightW) : 0;
          drag.current = { x0: e.clientX, w0, moved: false };
          document.body.classList.add('resizing-x');
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = (e.clientX - d.x0) * (side === 'left' ? 1 : -1);
          if (!d.moved && Math.abs(dx) < 3) return;
          d.moved = true;
          const w = d.w0 + dx;
          const [min] = LAYOUT_LIMITS[side];
          // 最小より十分小さくしたら閉じる
          if (w < min - 70) {
            if (side === 'left') setLayout({ leftOpen: false });
            else setLayout({ rightOpen: false });
            return;
          }
          if (side === 'left') setLayout({ leftOpen: true, leftW: w, prefer: 'left' });
          else setLayout({ rightOpen: true, rightW: w, prefer: 'right' });
        }}
        onPointerUp={() => {
          drag.current = null;
          document.body.classList.remove('resizing-x');
        }}
        onPointerCancel={() => {
          drag.current = null;
          document.body.classList.remove('resizing-x');
        }}
        onDoubleClick={() => togglePanel(side)}
      />
      <button
        className="vsplit-btn"
        onClick={() => togglePanel(side)}
        title={`${label}を${open ? '閉じる' : '開く'}`}
        aria-label={`${label}を${open ? '閉じる' : '開く'}`}
      >
        {(side === 'left') === open ? '‹' : '›'}
      </button>
    </div>
  );
}

/** 閉じたパネルの細い帯（クリックで開く） */
export function PanelRail({ side, label }: { side: 'left' | 'right'; label: string }) {
  return (
    <button className={`panel-rail ${side}`} onClick={() => togglePanel(side, true)} title={`${label}を開く`} aria-label={`${label}を開く`}>
      <span className="rail-arrow">{side === 'left' ? '›' : '‹'}</span>
      <span className="rail-text">{label}</span>
    </button>
  );
}

/** 下の波形（シークバー）の上の境目：上下にドラッグで高さ、ダブルクリックで開け閉め */
export function HSplitter() {
  const drag = useRef<{ y0: number; h0: number; moved: boolean } | null>(null);
  const open = useLayout((s) => s.seekOpen);
  return (
    <div
      className="hsplit"
      role="separator"
      aria-orientation="horizontal"
      aria-label="下の波形の高さ"
      title={`ドラッグで下の波形の高さを変える（ダブルクリックで${open ? '閉じる' : '開く'}）`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const l = useLayout.getState();
        drag.current = { y0: e.clientY, h0: l.seekOpen ? l.seekH : SEEK_CLOSED_H, moved: false };
        document.body.classList.add('resizing-y');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = d.y0 - e.clientY;
        if (!d.moved && Math.abs(dy) < 3) return;
        d.moved = true;
        const h = d.h0 + dy;
        if (h < LAYOUT_LIMITS.seek[0] - 14) setLayout({ seekOpen: false });
        else setLayout({ seekOpen: true, seekH: h });
      }}
      onPointerUp={() => {
        drag.current = null;
        document.body.classList.remove('resizing-y');
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.classList.remove('resizing-y');
      }}
      onDoubleClick={() => togglePanel('seek')}
    />
  );
}
