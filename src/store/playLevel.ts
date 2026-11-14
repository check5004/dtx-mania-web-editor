// あなたが遊ぶレベル（6.5 など）。DTXMania の曲の「あいだに作る」で入れたレベル・AI難易度生成で空けた難易度のめやすを覚えて、
// 次の曲でもはじめに出す（楯さんの依頼 2026-11-14）。難易度ガイドラインでも同じ値を見せて、変えられる。
// このブラウザの localStorage に残す（前の版から同じ名前）。
import { create } from 'zustand';

const KEY = 'dtxe.insertLevel.v1';

function read(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null || raw.trim() === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 1 && v <= 9.9 ? v : null;
  } catch {
    return null;
  }
}

export const usePlayLevel = create<{ v: number | null }>(() => ({ v: read() }));

/** 遊ぶレベル（決めていなければ null） */
export function insertLevel(): number | null {
  return usePlayLevel.getState().v;
}

/** 遊ぶレベルを覚える（0.1 きざみ）。null で忘れる */
export function rememberInsertLevel(v: number | null) {
  if (v !== null && (!Number.isFinite(v) || v < 1 || v > 9.9)) return;
  const r = v === null ? null : Math.round(v * 10) / 10;
  usePlayLevel.setState({ v: r });
  try {
    if (r === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(r));
  } catch {
    // 覚えられなくても動く
  }
}
