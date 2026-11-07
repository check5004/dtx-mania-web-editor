// 保存していない変更：譜面（DTX）と作業ファイル（.dtxe.json）。保存の ● は両方を数え、何が残っているかを見せる。
import { tr } from '../i18n';
import { useMemo } from 'react';
import { isDirty, unsavedChart, useEditor, type EditorState } from './editor';
import { useSidecar, type SidecarData } from './sidecar';

export interface Unsaved {
  /** 譜面の変更（新しい順の履歴の名前）。保存してあれば null */
  chart: { labels: string[]; undone: number } | null;
  /** 作業ファイルで変えたもの。保存してあれば null */
  work: string[] | null;
}

const WORK_LABEL: Record<keyof SidecarData, () => string> = {
  sections: () => tr('セクション', 'sections'),
  sectionColors: () => tr('セクション', 'sections'),
  youtube: () => tr('参照映像', 'reference video'),
  anchors: () => tr('テンポのアンカー', 'tempo anchors'),
  stems: () => tr('ステム', 'stems'),
  analysisStem: () => tr('ステム', 'stems'),
  mix: () => tr('聴く音量', 'listening volume'),
};

export function unsavedOf(s: Pick<EditorState, 'doc' | 'savedDoc' | 'past' | 'savedHistory'>, side: { dirty: boolean; changed: readonly (keyof SidecarData)[] }): Unsaved | null {
  const chart = unsavedChart(s);
  const work = side.dirty ? [...new Set(side.changed.map((k) => WORK_LABEL[k]()))] : null;
  return chart || work ? { chart, work } : null;
}

/** 譜面か作業ファイルに、保存していない変更があるか */
export function hasUnsaved(s: EditorState = useEditor.getState()): boolean {
  return isDirty(s) || useSidecar.getState().dirty;
}

/** 画面で使う（譜面・履歴・作業ファイルが変わると描き直す） */
export function useUnsaved(): Unsaved | null {
  const doc = useEditor((s) => s.doc);
  const savedDoc = useEditor((s) => s.savedDoc);
  const past = useEditor((s) => s.past);
  const savedHistory = useEditor((s) => s.savedHistory);
  const dirty = useSidecar((s) => s.dirty);
  const changed = useSidecar((s) => s.changed);
  return useMemo(() => unsavedOf({ doc, savedDoc, past, savedHistory }, { dirty, changed }), [doc, savedDoc, past, savedHistory, dirty, changed]);
}

/** 「譜面（BGM を反映 ほか2件）· 作業ファイル（ステム）」 */
export function unsavedText(u: Unsaved): string {
  const parts: string[] = [];
  if (u.chart) {
    const l = u.chart.labels;
    const what = l.length ? (l.length > 1 ? tr(`${l[0]} ほか${l.length - 1}件`, `${l[0]} + ${l.length - 1} more`) : l[0]) : u.chart.undone ? tr('元に戻した変更', 'undone changes') : '';
    parts.push(what ? tr(`譜面（${what}）`, `chart (${what})`) : tr('譜面', 'chart'));
  }
  if (u.work) parts.push(u.work.length ? tr(`作業ファイル（${u.work.join('・')}）`, `work file (${u.work.join(', ')})`) : tr('作業ファイル', 'work file'));
  return parts.join(' · ');
}
