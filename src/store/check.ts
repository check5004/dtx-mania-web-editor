// 確かめる：無理な配置の警告と推定レベル（譜面が変わるたびに計算し直す）。
import { tr, getLang, type Lang } from '../i18n';
import { create } from 'zustand';
import { estimateLevel, levelToField, type LevelEstimate } from '../check/level';
import { findIssues, type Issue } from '../check/playability';
export type { Issue };
import type { DtxDoc } from '../dtx/model';
import { tempoOf } from './derived';
import { setCursorBeat, setFieldValue, setView, useEditor } from './editor';

const KEY = 'dtxe.check.v1';

function loadShow(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export const useCheck = create<{ showIssues: boolean }>(() => ({ showIssues: loadShow() }));

export function setShowIssues(on: boolean) {
  useCheck.setState({ showIssues: on });
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // 覚えられなくても動く
  }
}

// 警告の文は言語ごとに作る（言語を切り替えたら作り直す）
const issueCache: Record<Lang, WeakMap<DtxDoc, Issue[]>> = { ja: new WeakMap(), en: new WeakMap() };
const levelCache = new WeakMap<DtxDoc, LevelEstimate | null>();

export function issuesOf(doc: DtxDoc): Issue[] {
  const cache = issueCache[getLang()];
  let v = cache.get(doc);
  if (!v) {
    v = findIssues(doc, tempoOf(doc));
    cache.set(doc, v);
  }
  return v;
}

export function levelOf(doc: DtxDoc): LevelEstimate | null {
  let v = levelCache.get(doc);
  if (v === undefined) {
    v = estimateLevel(doc, tempoOf(doc));
    levelCache.set(doc, v);
  }
  return v;
}

/** 今の位置より後ろの次の警告へ（最後まで行ったら最初へ） */
export function gotoNextIssue() {
  const s = useEditor.getState();
  const list = issuesOf(s.doc);
  if (!list.length) return;
  const next = list.find((is) => is.beat > s.cursorBeat + 1e-6) ?? list[0];
  gotoIssue(next);
}

/** 警告の種類の名前 */
export function issueLevelName(level: Issue['level']): string {
  return level === 'error' ? tr('叩けない配置', 'Unplayable') : tr('難しい配置', 'Hard to play');
}

/** 警告の場所へ移って、かかわるチップを選ぶ */
export function gotoIssue(is: Issue) {
  const px = useEditor.getState().view.pxPerBeat;
  setView({ scrollBeat: Math.max(-2, is.beat - 200 / px), follow: false });
  setCursorBeat(is.beat);
  useEditor.setState({ selection: [...is.ids] });
}

export function adoptLevel(lv: number) {
  setFieldValue('DLEVEL', levelToField(lv), tr(`ドラムのレベルを ${lv.toFixed(2)} にする`, `Set the drum level to ${lv.toFixed(2)}`));
}
