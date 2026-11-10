// スマホで置くときの吹き出し（承認されたデザイン「置き方（吹き出し）」）。
// 指で隠れる所を指の上に出す：指の下の 3 レーン・レーン名・小節.拍.位置・グリッド。離すと置く（チップの上なら選ぶ、譜面の外ならやめる）
import { useLayoutEffect, useRef, useState } from 'react';
import { tr } from '../../i18n';
import { chipColor, DRUM_LANES } from '../../dtx/model';
import { laneAt, slotOf } from '../../input/settings';

export interface AimInfo {
  /** 指の位置（譜面の枠の中） */
  x: number;
  y: number;
  lane: number;
  alt: boolean;
  /** 小節.拍.位置 */
  pos: string;
  grid: string;
  /** place: 離すと置く・chip: 離すと選ぶ・out: 譜面の外（離すとやめる） */
  mode: 'place' | 'chip' | 'out';
  /** 譜面の枠の幅と、見出しの高さ（吹き出しを枠の中に収める） */
  w: number;
  head: number;
}

/** 指の半径と、指と吹き出しの間 */
const FINGER_R = 23;
const GAP = 14;

function laneKey(lane: number, alt: boolean): string {
  if (lane === 1) return alt ? 'HHO' : 'HHC';
  if (lane === 2 && alt) return 'LBD';
  return DRUM_LANES[lane].key;
}

function laneName(lane: number, alt: boolean): string {
  const d = DRUM_LANES[lane];
  return alt ? (d.altName ?? d.mainName) : d.mainName;
}

export function PlaceBubble({ aim }: { aim: AimInfo }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 210, h: 64 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setSize((cur) => (cur.w === w && cur.h === h ? cur : { w, h }));
  });
  const out = aim.mode === 'out';
  const color = out ? '#5F6978' : chipColor(aim.lane, aim.alt);
  // 指の上に出す。上に入らなければ指の下へ
  const above = aim.y - FINGER_R - GAP - size.h >= aim.head + 4;
  const top = above ? aim.y - FINGER_R - GAP - size.h : aim.y + FINGER_R + GAP;
  const left = Math.max(4, Math.min(aim.w - size.w - 4, aim.x - size.w / 2));
  const tail = Math.max(14, Math.min(size.w - 14, aim.x - left));
  const slot = slotOf(aim.lane);
  const cells = [slot - 1, slot, slot + 1].map((sl) => {
    const lane = laneAt(sl);
    if (lane === undefined) return <span key={sl} className="p-bubble-cell none" />;
    const on = sl === slot && !out;
    const c = on ? color : DRUM_LANES[lane].color;
    return (
      <span key={sl} className={`p-bubble-cell mono ${on ? 'on' : ''}`} style={{ ['--c' as string]: c }}>
        {DRUM_LANES[lane].key}
      </span>
    );
  });
  const hint = out ? tr('離すとやめる', 'Release to cancel') : aim.mode === 'chip' ? tr('離すと選ぶ', 'Release to select') : tr('離すと置く', 'Release to place');
  return (
    <div
      ref={ref}
      className={`p-bubble ${out ? 'out' : ''} ${above ? 'above' : 'below'}`}
      style={{ left, top, ['--c' as string]: color, ['--tail' as string]: `${tail}px` }}
      role="status"
      aria-live="polite"
      aria-label={hint}
    >
      <span className="p-bubble-lanes">{cells}</span>
      <span className="p-bubble-text">
        <span className="p-bubble-name">
          <b className="mono">{out ? '—' : laneKey(aim.lane, aim.alt)}</b>
          <span>{out ? tr('譜面の外', 'Outside the chart') : laneName(aim.lane, aim.alt)}</span>
        </span>
        <span className="p-bubble-pos mono">
          {aim.pos} <span>{aim.grid}</span>
        </span>
        <span className="p-bubble-hint">{hint}</span>
      </span>
      <i className="p-bubble-tail" />
    </div>
  );
}
