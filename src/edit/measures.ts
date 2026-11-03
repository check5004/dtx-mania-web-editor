// 小節の挿入・削除。チップ・小節長・BPM変化・BGM の開始位置をずらす。
import type { Draft } from 'immer';
import { CH, type DtxDoc } from '../dtx/model';
import { MAX_MEASURES } from '../dtx/timing';

/** その小節の長さ（小節長の変更は次の変更まで続く） */
export function effectiveBarLen(bl: Readonly<Record<number, number>>, m: number): number {
  let cur = 1;
  let at = -1;
  for (const [k, v] of Object.entries(bl)) {
    const km = Number(k);
    if (km <= m && km > at && v > 0) {
      at = km;
      cur = v;
    }
  }
  return cur;
}

/** m 小節目の前に n 小節の空の小節を入れる。入れた小節の長さは m 小節目と同じにする */
export function opInsertMeasures(d: Draft<DtxDoc>, m: number, n: number): boolean {
  if (n <= 0) return false;
  let last = 0;
  for (const c of d.chips) last = Math.max(last, c.m);
  if (last + n >= MAX_MEASURES) return false;
  const len = effectiveBarLen(d.barLengths, m);
  for (const c of d.chips) if (c.m >= m) c.m += n;
  const next: Record<number, number> = {};
  for (const [k, v] of Object.entries(d.barLengths)) {
    const km = Number(k);
    if (km + (km >= m ? n : 0) < MAX_MEASURES) next[km >= m ? km + n : km] = v;
  }
  if (effectiveBarLen(next, m) !== len) next[m] = len;
  // 入れた小節のあとは元の m 小節目なので、同じ長さが続くなら書かなくてよい
  if (next[m + n] !== undefined && next[m + n] === effectiveBarLen(next, m + n - 1)) delete next[m + n];
  d.barLengths = next;
  // 曲の終わりも後ろへ（終わりの小節の前に入れたときも、曲が延びる）
  if (d.endMeasure !== undefined && d.endMeasure >= m) d.endMeasure = Math.min(MAX_MEASURES - 1, d.endMeasure + n);
  return true;
}

export interface DeleteResult {
  removed: number;
  /** 消した小節から次の小節の頭へ移した BPM 変化・BGM */
  kept: number;
}

/**
 * m 小節目から n 小節を消して、後ろを詰める。
 * 消す小節にある BPM 変化（最後のもの）と BGM の開始は、詰めたあとの m 小節目の頭へ移す（曲のテンポと原曲の再生がずれないように）。
 */
export function opDeleteMeasures(d: Draft<DtxDoc>, m: number, n: number): DeleteResult {
  const res: DeleteResult = { removed: 0, kept: 0 };
  if (n <= 0) return res;
  const end = m + n;
  const lenAfter = effectiveBarLen(d.barLengths, end);
  // 消す範囲の最後の BPM 変化と BGM
  let lastBpm: (typeof d.chips)[number] | null = null;
  const bgm: (typeof d.chips)[number][] = [];
  const pos = (c: { m: number; f: { n: number; d: number } }) => c.m + c.f.n / c.f.d;
  for (const c of d.chips) {
    if (c.m < m || c.m >= end) continue;
    if (c.ch === CH.BPM || c.ch === CH.BPM_EX) {
      if (!lastBpm || pos(c) >= pos(lastBpm)) lastBpm = c;
    } else if (c.ch === CH.BGM) bgm.push(c);
  }
  const bpmAtHead = d.chips.some((c) => c.m === end && c.f.n === 0 && (c.ch === CH.BPM || c.ch === CH.BPM_EX));
  const keep = new Set<number>();
  if (lastBpm && !bpmAtHead) keep.add(lastBpm.id);
  for (const c of bgm) if (!d.chips.some((o) => o.ch === CH.BGM && o.m === end && o.f.n === 0 && o.v === c.v)) keep.add(c.id);
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (c.m >= end) c.m -= n;
    else if (c.m >= m) {
      if (keep.has(c.id)) {
        c.m = m;
        c.f = { n: 0, d: 1 };
        res.kept++;
      } else {
        d.chips.splice(i, 1);
        res.removed++;
      }
    }
  }
  const next: Record<number, number> = {};
  for (const [k, v] of Object.entries(d.barLengths)) {
    const km = Number(k);
    if (km < m) next[km] = v;
    else if (km >= end) next[km - n] = v;
  }
  if (effectiveBarLen(next, m) !== lenAfter) next[m] = lenAfter;
  if (next[m] !== undefined && next[m] === effectiveBarLen(next, m - 1) && m > 0) delete next[m];
  d.barLengths = next;
  // 曲の終わりも詰める（消した範囲の中にあれば、消したところ）
  if (d.endMeasure !== undefined) {
    if (d.endMeasure >= end) d.endMeasure -= n;
    else if (d.endMeasure > m) d.endMeasure = m;
    if (d.endMeasure < 1) delete d.endMeasure;
  }
  return res;
}

/** 小節番号を持つもの（セクション・テンポのアンカー）を挿入・削除に合わせてずらす。消えた小節のものは null */
export function shiftMeasure(x: number, m: number, n: number, mode: 'insert' | 'delete'): number | null {
  if (mode === 'insert') return x >= m ? x + n : x;
  if (x >= m + n) return x - n;
  if (x >= m) return null;
  return x;
}
