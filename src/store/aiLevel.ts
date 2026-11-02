// AI のレベル判定（「確かめる」に機械的な推定と並べて出す）。
import { create } from 'zustand';
import { cleanJudgement, LEVEL_SCHEMA, levelPrompt, sectionSpans, type LevelJudgement } from '../ai/judge';
import { AiError } from '../ai/openrouter';
import type { DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures, lastMeasure } from '../gen/features';
import { runAi } from './ai';
import { bandOf, guidelineText, loadGuideline, nearestCharts, useGuideline } from './guideline';
import { useEditor } from './editor';
import { useSidecar } from './sidecar';
import { levelOf } from './check';

export interface JudgeResult extends LevelJudgement {
  cost: number;
  model: string;
  nearCount: number;
}

/** 譜面1つを AI に判定してもらう */
export async function judgeDoc(doc: DtxDoc, o: { title: string; label?: string; sections: { m: number; name: string }[]; mech: number; quiet?: boolean }): Promise<JudgeResult | null> {
  await loadGuideline();
  const g = useGuideline.getState();
  const tempo = buildTempoMap(doc);
  const feat = chartFeatures(doc, tempo);
  const near = nearestCharts(feat, g.charts, 5, o.title);
  // 基準文は推定レベルの前後の帯だけ渡す（短くする）
  const b = bandOf(o.mech);
  const guide = guidelineText(g.guide, [b - 1, b, b + 1].filter((x) => x >= 1 && x <= 9));
  const p = levelPrompt({ doc, title: o.title, label: o.label, sections: sectionSpans(o.sections, lastMeasure(doc)), guide, near, mech: o.mech, feat });
  const r = await runAi<Partial<LevelJudgement>>('level', { ...p, schema: LEVEL_SCHEMA, maxTokens: 2500, quiet: o.quiet });
  if (!r) return null;
  return { ...cleanJudgement(r.data), cost: r.costUsed, model: r.model, nearCount: near.length };
}

interface AiLevelState {
  doc: DtxDoc | null;
  result: JudgeResult | null;
  loading: boolean;
  error: string | null;
}

export const useAiLevel = create<AiLevelState>(() => ({ doc: null, result: null, loading: false, error: null }));

export async function judgeCurrent() {
  const s = useEditor.getState();
  const mech = levelOf(s.doc)?.level ?? 1;
  useAiLevel.setState({ loading: true, error: null });
  try {
    const label = s.meta.siblings.find((x) => x.file.toLowerCase() === s.meta.fileName.toLowerCase())?.label;
    const r = await judgeDoc(s.doc, { title: s.doc.fields['TITLE'] || s.meta.fileName, label, sections: useSidecar.getState().sections, mech });
    if (r) useAiLevel.setState({ doc: s.doc, result: r, loading: false });
    else useAiLevel.setState({ loading: false });
  } catch (e) {
    useAiLevel.setState({ loading: false, error: e instanceof AiError ? e.message : `判定できませんでした: ${(e as Error).message}` });
  }
}
