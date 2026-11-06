// パネルの境目：ドラッグで幅（高さ）を変え、ボタンかダブルクリックで開け閉めする。下のトラックの高さは止まる高さに吸い付く。
import { tr } from '../i18n';
import { useRef, useState } from 'react';
import { openCtxMenu } from '../store/ctxMenu';
import { deskTracksHeight, LAYOUT_LIMITS, maxTracksH, SEEK_CLOSED_H, setLayout, togglePanel, useLayout, type Layout } from '../store/layout';
import { deskStopHeight, deskTrackStops, magnetHeight, stepDeskStop, type DeskTrackStop } from '../store/sheetSnap';

/** 左右のパネルと譜面の境目 */
export function VSplitter({ side, open }: { side: 'left' | 'right'; open: boolean }) {
  const drag = useRef<{ x0: number; w0: number; moved: boolean } | null>(null);
  const label = side === 'left' ? tr('左のパネル', 'left panel') : tr('右のパネル', 'right panel');
  return (
    <div className={`vsplit ${side}`}>
      <div
        className="vsplit-hit"
        role="separator"
        aria-orientation="vertical"
        aria-label={tr(`${label}の幅`, `Width of the ${label}`)}
        title={tr(`ドラッグで${label}の幅を変える（ダブルクリックで${open ? '閉じる' : '開く'}）`, `Drag to resize the ${label} (double-click to ${open ? 'close' : 'open'} it)`)}
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
        title={tr(`${label}を${open ? '閉じる' : '開く'}`, `${open ? 'Close' : 'Open'} the ${label}`)}
        aria-label={tr(`${label}を${open ? '閉じる' : '開く'}`, `${open ? 'Close' : 'Open'} the ${label}`)}
      >
        {(side === 'left') === open ? '‹' : '›'}
      </button>
    </div>
  );
}

/** 閉じたパネルの細い帯（クリックで開く） */
export function PanelRail({ side, label }: { side: 'left' | 'right'; label: string }) {
  return (
    <button className={`panel-rail ${side}`} onClick={() => togglePanel(side, true)} title={tr(`${label}を開く`, `Open: ${label}`)} aria-label={tr(`${label}を開く`, `Open: ${label}`)}>
      <span className="rail-arrow">{side === 'left' ? '›' : '‹'}</span>
      <span className="rail-text">{label}</span>
    </button>
  );
}

/** PC の下のトラックの止まる高さの名前（境目のドラッグ中の札・右クリックのメニュー） */
export function trackStopLabel(stop: DeskTrackStop): string {
  switch (stop) {
    case 'closed':
      return tr('閉じる', 'Closed');
    case 'one':
      return tr('1本', 'One track');
    case 'slim':
      return tr('細く', 'Slim');
    case 'std':
      return tr('標準', 'Standard');
    case 'roomy':
      return tr('ゆったり', 'Roomy');
  }
}

/** 止まる高さの中身の説明 */
export function trackStopNote(stop: DeskTrackStop): string {
  switch (stop) {
    case 'closed':
      return tr('ループとセクションの帯だけ', 'Loop and section strip only');
    case 'one':
      return tr('トラック1本（ホイールで次へ）', 'One track (scroll for the next)');
    case 'slim':
      return tr('全部を1行ずつ', 'Every track on one line');
    case 'std':
      return tr('名前の下にファイル名', 'File name under each name');
    case 'roomy':
      return tr('波形を大きく', 'Bigger waveforms');
  }
}

/** 今の高さが止まる高さのどれか（閉じているなら閉じる、名前で止めていればその名前、px が止まる高さと同じならそれ） */
export function currentTrackStop(l: Layout, rows: number, maxH = maxTracksH()): DeskTrackStop | undefined {
  if (!l.seekOpen) return 'closed';
  if (l.tracksStop) return l.tracksStop;
  const h = deskTracksHeight(l, rows, maxH);
  return deskTrackStops(rows, SEEK_CLOSED_H, maxH).find((s) => s.h === h)?.stop;
}

/** 止まる高さにする（閉じるならトラックを閉じる） */
export function setTrackStop(stop: DeskTrackStop, rows: number) {
  if (stop === 'closed') setLayout({ seekOpen: false });
  else setLayout({ seekOpen: true, tracksH: deskStopHeight(stop, rows, SEEK_CLOSED_H), tracksStop: stop });
}

/** ドラッグ中に出す札（どの止まる高さに吸い付いたか。alt: Alt を押していて吸い付かない） */
interface DragHint {
  x: number;
  stop?: DeskTrackStop;
  alt: boolean;
}

/**
 * 下のトラックの上の境目：上下にドラッグで高さ（閉じる・1本・細く・標準・ゆったりに吸い付く。Alt を押しながらで自由な高さ）、
 * ダブルクリック・Enter で開け閉め、↑↓ で 1 段ずつ、右クリックで高さを選ぶメニュー。rows: トラックの数
 */
export function HSplitter({ rows }: { rows: number }) {
  const drag = useRef<{ y0: number; h0: number; moved: boolean } | null>(null);
  const [hint, setHint] = useState<DragHint | null>(null);
  const l = useLayout();
  const open = l.seekOpen;
  const maxH = maxTracksH();
  const cur = deskTracksHeight(l, rows, maxH);
  const curStop = currentTrackStop(l, rows, maxH);
  const apply = (h: number, stop?: DeskTrackStop) => {
    if (stop === 'closed') setLayout({ seekOpen: false });
    else setLayout({ seekOpen: true, tracksH: h, tracksStop: stop });
  };
  const end = (e?: React.PointerEvent<HTMLElement>) => {
    drag.current = null;
    setHint(null);
    document.body.classList.remove('resizing-y');
    // 押してもフォーカスを残さない（Space で再生できるように）
    if (e) (e.currentTarget as HTMLElement).blur();
  };
  return (
    <div
      className={`hsplit ${hint ? 'dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={tr('下のトラックの高さ', 'Height of the bottom tracks')}
      aria-valuemin={SEEK_CLOSED_H}
      aria-valuemax={maxH}
      aria-valuenow={cur}
      aria-valuetext={curStop ? trackStopLabel(curStop) : `${cur}px`}
      title={tr(
        `ドラッグで下のトラックの高さを変える（1本・細く・標準・ゆったりで止まる。Alt を押しながらで自由な高さ）/ ダブルクリックで${open ? '閉じる' : '開く'} / 右クリックで高さを選ぶ`,
        `Drag to resize the bottom tracks (stops at One track, Slim, Standard and Roomy; hold Alt for any height) / Double-click to ${open ? 'close' : 'open'} them / Right-click to pick a height`,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y0: e.clientY, h0: deskTracksHeight(useLayout.getState(), rows), moved: false };
        document.body.classList.add('resizing-y');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = d.y0 - e.clientY;
        if (!d.moved && Math.abs(dy) < 3) return;
        d.moved = true;
        const raw = d.h0 + dy;
        const maxH = maxTracksH();
        const minOpen = LAYOUT_LIMITS.seek[0];
        // いちばん上は「全部をゆったり」か画面の上限の低い方（下に空きを作らない）
        const top = Math.max(minOpen, Math.min(maxH, deskStopHeight('roomy', rows, SEEK_CLOSED_H)));
        let next: { h: number; stop?: DeskTrackStop };
        if (raw < (SEEK_CLOSED_H + minOpen) / 2) next = { h: SEEK_CLOSED_H, stop: 'closed' };
        else {
          const h = Math.round(Math.max(minOpen, Math.min(top, raw)));
          next = e.altKey ? { h } : magnetHeight(h, deskTrackStops(rows, SEEK_CLOSED_H, maxH));
        }
        apply(next.h, next.stop);
        setHint({ x: e.clientX, stop: next.stop, alt: e.altKey });
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={() => {
        if (drag.current) end();
      }}
      onDoubleClick={() => togglePanel('seek')}
      onContextMenu={(e) => {
        e.preventDefault();
        openCtxMenu({ kind: 'tracks', rows }, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        const maxH = maxTracksH();
        const stops = deskTrackStops(rows, SEEK_CLOSED_H, maxH);
        const h = deskTracksHeight(useLayout.getState(), rows, maxH);
        let to: { stop: DeskTrackStop; h: number } | null = null;
        if (e.key === 'ArrowUp') to = stepDeskStop(h, 1, stops);
        else if (e.key === 'ArrowDown') to = stepDeskStop(h, -1, stops);
        else if (e.key === 'Home') to = stops[0];
        else if (e.key === 'End') to = stops[stops.length - 1];
        else if (e.key === 'Enter') togglePanel('seek');
        else return;
        e.preventDefault();
        e.stopPropagation();
        if (to) apply(to.h, to.stop);
      }}
    >
      {hint && (
        <div className="hsplit-hint" style={hint.x > window.innerWidth / 2 ? { right: window.innerWidth - hint.x + 14 } : { left: hint.x + 14 }}>
          {hint.stop ? (
            <>
              <b>{trackStopLabel(hint.stop)}</b>
              <span>{trackStopNote(hint.stop)}</span>
              <span className="k">{tr('Alt で自由な高さ', 'Alt: any height')}</span>
            </>
          ) : (
            <>
              <b>{tr('自由な高さ', 'Any height')}</b>
              <span className="k">
                {hint.alt ? tr('Alt を離すと止まる高さに吸い付きます', 'Release Alt to snap to a stop') : tr('1本・細く・標準・ゆったりで止まります', 'Stops at One track, Slim, Standard and Roomy')}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
