// 確かめる：無理な配置の警告と推定レベル（譜面が変わるたびに計算し直す）。
import { create } from 'zustand';
import { estimateLevel, levelToField, type LevelEstimate } from '../check/level';
import { findIssues, type Issue } from '../check/playability';
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

const issueCache = new WeakMap<DtxDoc, Issue[]>();
const levelCache = new WeakMap<DtxDoc, LevelEstimate | null>();

export function issuesOf(doc: DtxDoc): Issue[] {
  let v = issueCache.get(doc);
  if (!v) {
    v = findIssues(doc, tempoOf(doc));
    issueCache.set(doc, v);
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

/** 警告の場所へ移って、かかわるチップを選ぶ */
export function gotoIssue(is: Issue) {
  const px = useEditor.getState().view.pxPerBeat;
  setView({ scrollBeat: Math.max(-2, is.beat - 200 / px), follow: false });
  setCursorBeat(is.beat);
  useEditor.setState({ selection: [...is.ids] });
}

export function adoptLevel(lv: number) {
  setFieldValue('DLEVEL', levelToField(lv), `ドラムのレベルを ${lv.toFixed(2)} にする`);
}
