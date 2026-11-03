// 画面の配置：左右のパネルの幅と開閉、下の波形（シークバー）の高さと開閉。ブラウザに覚える。
import { create } from 'zustand';

export interface Layout {
  leftW: number;
  rightW: number;
  /** 下の波形（シークバー）の高さ */
  seekH: number;
  leftOpen: boolean;
  rightOpen: boolean;
  seekOpen: boolean;
  /** 最後に開いたパネル（狭い画面では、もう一方を先に細くする） */
  prefer?: 'left' | 'right';
}

export const LAYOUT_LIMITS = {
  left: [200, 560] as const,
  right: [260, 640] as const,
  seek: [48, 300] as const,
};

/** 閉じたパネルの細い帯の幅 */
export const RAIL_W = 26;
/** 波形を閉じたときのシークバーの高さ（ループの帯とセクションだけ） */
export const SEEK_CLOSED_H = 28;

const KEY = 'dtxe.layout.v1';

const DEFAULT: Layout = { leftW: 280, rightW: 340, seekH: 76, leftOpen: true, rightOpen: true, seekOpen: true };

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, Math.round(v)));

function load(): Layout {
  let saved: Partial<Layout> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Layout>;
  } catch {
    saved = {};
  }
  const l = { ...DEFAULT, ...saved };
  // 初めて開いた狭い画面では右のパネルを閉じておく（以前は 1180px 未満で隠していた）
  if (saved.rightOpen === undefined && typeof window !== 'undefined' && window.innerWidth < 1180) l.rightOpen = false;
  return {
    leftW: clamp(Number(l.leftW) || DEFAULT.leftW, LAYOUT_LIMITS.left),
    rightW: clamp(Number(l.rightW) || DEFAULT.rightW, LAYOUT_LIMITS.right),
    seekH: clamp(Number(l.seekH) || DEFAULT.seekH, LAYOUT_LIMITS.seek),
    leftOpen: l.leftOpen !== false,
    rightOpen: l.rightOpen !== false,
    seekOpen: l.seekOpen !== false,
  };
}

export const useLayout = create<Layout>(() => load());

export function setLayout(p: Partial<Layout>) {
  const cur = useLayout.getState();
  const next: Layout = {
    ...cur,
    ...p,
    leftW: clamp(p.leftW ?? cur.leftW, LAYOUT_LIMITS.left),
    rightW: clamp(p.rightW ?? cur.rightW, LAYOUT_LIMITS.right),
    seekH: clamp(p.seekH ?? cur.seekH, LAYOUT_LIMITS.seek),
  };
  useLayout.setState(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 覚えられなくても動く
  }
}

export function togglePanel(which: 'left' | 'right' | 'seek', open?: boolean) {
  const l = useLayout.getState();
  if (which === 'left') setLayout({ leftOpen: open ?? !l.leftOpen, prefer: 'left' });
  else if (which === 'right') setLayout({ rightOpen: open ?? !l.rightOpen, prefer: 'right' });
  else setLayout({ seekOpen: open ?? !l.seekOpen });
}

/** 譜面の列に最低限残したい幅 */
const CHART_MIN = 480;

/**
 * 画面の幅に収まるように、実際に使う幅を決める（覚えている値は変えない）。
 * 収まらなければ右、次に左のパネルを細い帯にする。
 */
export function effectiveColumns(l: Layout, width: number, hasLeft: boolean): { left: number; right: number; leftOpen: boolean; rightOpen: boolean } {
  let leftOpen = hasLeft && l.leftOpen;
  let rightOpen = l.rightOpen;
  const lw = () => (hasLeft ? (leftOpen ? l.leftW : RAIL_W) : 0);
  const rw = () => (rightOpen ? l.rightW : RAIL_W);
  // 最後に開いた方は残し、もう一方を細くする（どちらも開いていなければ右、次に左）
  const narrow = () => width - lw() - rw() < CHART_MIN;
  if (narrow()) {
    if (l.prefer === 'right') leftOpen = false;
    else if (l.prefer === 'left') rightOpen = false;
    else {
      rightOpen = false;
      if (narrow()) leftOpen = false;
    }
  }
  return { left: lw(), right: rw(), leftOpen, rightOpen };
}
