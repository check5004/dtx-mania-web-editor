// 似た小節（同じパターンの小節）を探す。ドラムのチップの並びだけを比べ、WAV の違いは無視する。
import type { Draft } from 'immer';
import { drumChannel, type DtxDoc } from '../dtx/model';

const sigCache = new WeakMap<DtxDoc, Map<number, string>>();

/** 小節ごとのパターンの文字列（空の小節は入らない） */
export function measureSignatures(doc: DtxDoc): Map<number, string> {
  let m = sigCache.get(doc);
  if (m) return m;
  const parts = new Map<number, string[]>();
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d) continue;
    let arr = parts.get(c.m);
    if (!arr) parts.set(c.m, (arr = []));
    arr.push(`${c.ch.toString(36)}@${c.f.n}/${c.f.d}`);
  }
  m = new Map();
  for (const [k, arr] of parts) m.set(k, arr.sort().join(','));
  sigCache.set(doc, m);
  return m;
}

/** m と同じパターンの小節（m 自身は除く） */
export function sameMeasures(doc: DtxDoc, m: number, sig?: string): number[] {
  const sigs = measureSignatures(doc);
  const s = sig ?? sigs.get(m);
  if (!s) return [];
  const out: number[] = [];
  for (const [k, v] of sigs) if (k !== m && v === s) out.push(k);
  return out.sort((a, b) => a - b);
}

/** from 小節のドラムのチップを to の各小節に写す（写し先のドラムのチップは消す） */
export function copyMeasureInto(d: Draft<DtxDoc>, from: number, to: number[]): number {
  const targets = new Set(to.filter((m) => m !== from));
  const src = d.chips.filter((c) => c.m === from && drumChannel(c.ch)).map((c) => ({ ch: c.ch, f: { n: c.f.n, d: c.f.d }, v: c.v }));
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (targets.has(c.m) && drumChannel(c.ch)) d.chips.splice(i, 1);
  }
  for (const m of targets) for (const c of src) d.chips.push({ id: d.nextId++, ch: c.ch, m, f: { ...c.f }, v: c.v });
  return targets.size;
}
