// 反映したら、エディタ（譜面の画面）で入った所を数秒光らせる：増えた難易度のタブ・BPM・原曲（BGM）の行。
// 別の画面（AI難易度生成・テンポ・ステム）で反映したときは、譜面の画面に戻ったときに光らせる。
import { create } from 'zustand';
import { openedDocs, useEditor } from './editor';

/** 光らせる所。diffs は難易度のファイル名 */
export interface GlowSpots {
  diffs?: string[];
  bpm?: true;
  bgm?: true;
}

interface GlowState {
  /** 譜面の画面に戻ったら光らせる所 */
  pending: GlowSpots;
  /** 今光らせている所 */
  on: GlowSpots;
}

export const useGlow = create<GlowState>(() => ({ pending: {}, on: {} }));

const GLOW_MS = 3600;
let timer = 0;

/** 入った所を光らせる。譜面の画面にいればすぐ、ほかの画面なら戻ったときに */
export function glowReflected(spots: GlowSpots) {
  useGlow.setState((s) => ({ pending: merge(s.pending, spots) }));
  flush();
}

function merge(a: GlowSpots, b: GlowSpots): GlowSpots {
  const diffs = [...new Set([...(a.diffs ?? []), ...(b.diffs ?? [])])];
  return { ...a, ...b, ...(diffs.length ? { diffs } : {}) };
}

function flush() {
  const e = useEditor.getState();
  if (e.screen !== 'editor' || e.page !== 'chart') return;
  const p = useGlow.getState().pending;
  if (!p.diffs && !p.bpm && !p.bgm) return;
  useGlow.setState((s) => ({ pending: {}, on: merge(s.on, p) }));
  window.clearTimeout(timer);
  timer = window.setTimeout(() => useGlow.setState({ on: {} }), GLOW_MS);
}

// 譜面の画面に戻ったら光らせる。別の譜面を開いたら、光らせる予定は捨てる
// （同じ曲の別の難易度へ切り替えたときは、難易度のタブだけ光らせ続ける。タブは同じなので）
let seen = openedDocs;
useEditor.subscribe((s, prev) => {
  if (openedDocs !== seen) {
    seen = openedDocs;
    const sameSong = !!s.folder && s.folder === prev.folder;
    useGlow.setState((g) => ({ pending: {}, on: sameSong && g.on.diffs ? { diffs: g.on.diffs } : {} }));
    return;
  }
  if (s.page !== prev.page || s.screen !== prev.screen) flush();
});

/** BPM・原曲の行を光らせているか */
export function useGlowing(spot: 'bpm' | 'bgm'): boolean {
  return useGlow((s) => !!s.on[spot]);
}

/** 光らせている難易度のファイル名（タブを並べる所で一度だけ読む） */
export function useGlowDiffs(): string[] | undefined {
  return useGlow((s) => s.on.diffs);
}

export const glowsDiff = (list: string[] | undefined, file: string) => !!list?.some((x) => x.toLowerCase() === file.toLowerCase());
