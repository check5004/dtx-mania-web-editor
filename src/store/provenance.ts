// 自動で入れた小節を覚える。TAB補完・小節の生成（✨）・フレーズ候補・似た小節へのまとめての反映で入れた小節は、
// 入れたときのドラムの中身の印を作業ファイル（.dtxe.json）に残す。中身が印のままの小節は「自動で入れたまま作者が確かめていない小節」として、
// AI の手本・前後の小節の譜面・書き方の要約に使わない。作者が手で直すと中身が変わるので、その小節は作者の小節（手本）になる。
// 元に戻すで入れる前の中身に戻ると印と合わなくなり、やり直すとまた合う（印は履歴に入れなくてよい）。
import { GRID_LANES } from '../ai/phrase';
import type { DtxDoc } from '../dtx/model';
import { setAutoMarks, useSidecar, type AutoMark } from './sidecar';

const DRUM = new Set(GRID_LANES.map((l) => l.ch));

/** 小節ごとのドラムのチップ（「チャンネル@位置」）。measures を渡すとその小節だけ */
function drumKeys(doc: DtxDoc, measures?: ReadonlySet<number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const c of doc.chips) {
    if (!DRUM.has(c.ch) || (measures && !measures.has(c.m))) continue;
    let a = out.get(c.m);
    if (!a) out.set(c.m, (a = []));
    a.push(`${c.ch}@${(c.f.n / c.f.d).toFixed(6)}`);
  }
  return out;
}

/** チップの並びの印（数と FNV-1a。無ければ ''） */
function sigOf(keys: string[] | undefined): string {
  if (!keys?.length) return '';
  const text = [...keys].sort().join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${keys.length}:${h.toString(16).padStart(8, '0')}`;
}

/** 小節のドラムの中身の印（チップが無ければ ''） */
export function measureSig(doc: DtxDoc, m: number): string {
  return sigOf(drumKeys(doc, new Set([m])).get(m));
}

/** 自動で入れた小節として覚える（入れた直後に呼ぶ）。チップが無くなった小節は忘れる */
export function markAuto(doc: DtxDoc, measures: Iterable<number>) {
  const ms = new Set([...measures].filter((m) => m >= 0));
  if (ms.size === 0) return;
  const keys = drumKeys(doc, ms);
  const next: AutoMark[] = useSidecar.getState().auto.filter((a) => !ms.has(a.m));
  for (const m of ms) {
    const sig = sigOf(keys.get(m));
    if (sig) next.push({ m, sig });
  }
  next.sort((a, b) => a.m - b.m);
  setAutoMarks(next);
}

let memo: { doc: DtxDoc; marks: readonly AutoMark[]; set: Set<number> } | null = null;

/** 自動で入れたまま（中身が入れたときのまま）の小節 */
export function autoMeasures(doc: DtxDoc, marks: readonly AutoMark[] = useSidecar.getState().auto): Set<number> {
  if (memo && memo.doc === doc && memo.marks === marks) return memo.set;
  const set = new Set<number>();
  if (marks.length) {
    const keys = drumKeys(doc, new Set(marks.map((a) => a.m)));
    for (const a of marks) if (sigOf(keys.get(a.m)) === a.sig) set.add(a.m);
  }
  memo = { doc, marks, set };
  return set;
}

/** 作者が書いた（確かめた）小節か。チップの無い小節も true（自動で入れたものではない） */
export function humanMeasure(doc: DtxDoc): (m: number) => boolean {
  const auto = autoMeasures(doc);
  return (m) => !auto.has(m);
}
