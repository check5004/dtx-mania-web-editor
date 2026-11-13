// DTXMania風の落下プレビューの表示状態。
import { create } from 'zustand';

const KEY = 'dtxe.preview.v1';

interface PreviewState {
  mode: 'off' | 'side' | 'full';
  /** スクロールの速さ（NX のハイスピードのような倍率） */
  speed: number;
  /** 背景に BGA を出す */
  bga: boolean;
}

function load(): Pick<PreviewState, 'speed' | 'bga'> {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PreviewState>;
    return { speed: typeof j.speed === 'number' && j.speed >= 0.5 && j.speed <= 4 ? j.speed : 1.5, bga: j.bga !== false };
  } catch {
    return { speed: 1.5, bga: true };
  }
}

export const usePreview = create<PreviewState>(() => ({ mode: 'off', ...load() }));

usePreview.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ speed: s.speed, bga: s.bga }));
  } catch {
    // 覚えられなくても動く
  }
});

export function togglePreview(mode: 'side' | 'full') {
  usePreview.setState((s) => ({ mode: s.mode === mode ? 'off' : mode }));
}
