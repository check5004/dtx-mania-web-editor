// AI を使う準備（OpenRouter のはじめかた）の小窓と、「キーが要ります」の説明の吹き出し。
// どちらも画面のどこからでも開ける（ホーム・エディタ・設定）。中身は src/ui/aiGuide/。
import { create } from 'zustand';
import type { AiFeatureId } from '../ai/features';

/** 案内の手順（この順に出す） */
export const GUIDE_STEPS = ['about', 'account', 'credits', 'key', 'paste', 'care'] as const;
export type GuideStep = (typeof GUIDE_STEPS)[number];

interface GuideState {
  open: boolean;
  step: GuideStep;
  /** どの機能から開いたか（その機能の名前を案内の頭に出す） */
  from: AiFeatureId | null;
  /** 開くたび・「もう一度」で増やす（動きを頭から流し直す） */
  play: number;
}

export const useAiGuide = create<GuideState>(() => ({ open: false, step: 'about', from: null, play: 0 }));

/** 案内を開く。キーを持っている人は step 'paste' から */
export function openAiGuide(step: GuideStep = 'about', from: AiFeatureId | null = null) {
  closeKeyGate();
  useAiGuide.setState((s) => ({ open: true, step, from, play: s.play + 1 }));
}

export function closeAiGuide() {
  useAiGuide.setState({ open: false });
}

export function setGuideStep(step: GuideStep) {
  useAiGuide.setState((s) => ({ step, play: s.play + 1 }));
}

/** 前・次の手順へ（端では止まる） */
export function stepGuide(d: 1 | -1) {
  const i = GUIDE_STEPS.indexOf(useAiGuide.getState().step);
  const j = Math.max(0, Math.min(GUIDE_STEPS.length - 1, i + d));
  if (j !== i) setGuideStep(GUIDE_STEPS[j]);
}

export function replayGuide() {
  useAiGuide.setState((s) => ({ play: s.play + 1 }));
}

// ---- 「キーが要ります」の吹き出し ----------------------------------------------------------

export interface GateRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface GateState {
  feature: AiFeatureId | null;
  /** 押したボタンの場所（吹き出しをその近くに出す）。無ければ画面の真ん中 */
  rect: GateRect | null;
}

export const useKeyGate = create<GateState>(() => ({ feature: null, rect: null }));

/** 「キーが要ります」の説明を、押したボタン（el）の近くに出す */
export function openKeyGate(feature: AiFeatureId, el?: Element | null) {
  const r = el?.getBoundingClientRect();
  useKeyGate.setState({ feature, rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null });
}

export function closeKeyGate() {
  if (useKeyGate.getState().feature) useKeyGate.setState({ feature: null, rect: null });
}
