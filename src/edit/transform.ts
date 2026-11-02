// まとめての書き換え：レーンを移す・入れ替える・左右反転・WAV番号の置き換え。
import type { Draft } from 'immer';
import { channelFor, drumChannel, DRUM_LANES, type Chip, type DtxDoc } from '../dtx/model';
import { conflictKey } from './ops';

/** 2種目（HHオープン・左バスドラム）をどうするか */
export type AltMode = 'keep' | 'main' | 'alt';

/** そのチップを、別のレーンへ移したときのチャンネル（種類は保つ） */
export function channelToLane(ch: number, lane: number, alt: AltMode = 'keep'): number | null {
  const info = drumChannel(ch);
  const def = DRUM_LANES[lane];
  if (!info || !def) return null;
  const wantAlt = alt === 'keep' ? info.alt : alt === 'alt';
  const base = wantAlt && def.alt !== undefined ? def.alt : def.main;
  return channelFor(base, info.kind);
}

const posKey = (c: Pick<Chip, 'ch' | 'm' | 'f'>) => `${conflictKey(c.ch)}@${c.m}:${c.f.n}/${c.f.d}`;

/**
 * チャンネルをまとめて変える。変えた先に（変えていない）チップがあれば消し、
 * 変えたチップどうしが重なったら後のものを残す。変えた数を返す。
 */
export function applyChannels(d: Draft<DtxDoc>, changes: ReadonlyMap<number, number>): number {
  let n = 0;
  for (const c of d.chips) {
    const to = changes.get(c.id);
    if (to !== undefined && to !== c.ch) {
      c.ch = to;
      n++;
    }
  }
  if (n === 0) return 0;
  const seen = new Map<string, number>();
  const drop = new Set<number>();
  // 変えたチップを優先して残す
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (!changes.has(c.id)) continue;
    const k = posKey(c);
    if (seen.has(k)) drop.add(c.id);
    else seen.set(k, c.id);
  }
  for (const c of d.chips) if (!changes.has(c.id) && seen.has(posKey(c))) drop.add(c.id);
  if (drop.size) {
    for (let i = d.chips.length - 1; i >= 0; i--) if (drop.has(d.chips[i].id)) d.chips.splice(i, 1);
  }
  return n;
}

/** 選んだチップを lane へ移す */
export function opRelane(d: Draft<DtxDoc>, ids: ReadonlySet<number>, lane: number, alt: AltMode = 'keep'): number {
  const changes = new Map<number, number>();
  for (const c of d.chips) {
    if (!ids.has(c.id)) continue;
    const ch = channelToLane(c.ch, lane, alt);
    if (ch !== null) changes.set(c.id, ch);
  }
  return applyChannels(d, changes);
}

/** レーンの対応表で移す（左右反転など） */
export function opMapLanes(d: Draft<DtxDoc>, ids: ReadonlySet<number> | null, map: (lane: number) => number | null, inRange: (c: Chip) => boolean = () => true): number {
  const changes = new Map<number, number>();
  for (const c of d.chips) {
    if (ids && !ids.has(c.id)) continue;
    if (!inRange(c as Chip)) continue;
    const info = drumChannel(c.ch);
    if (!info) continue;
    const to = map(info.lane);
    if (to === null || to === info.lane) continue;
    const ch = channelToLane(c.ch, to, 'keep');
    if (ch !== null) changes.set(c.id, ch);
  }
  return applyChannels(d, changes);
}

/** 小節の範囲で、2つのレーンのチップを入れ替える */
export function opSwapLanes(d: Draft<DtxDoc>, a: number, b: number, from: number, to: number): number {
  if (a === b) return 0;
  return opMapLanes(d, null, (l) => (l === a ? b : l === b ? a : null), (c) => c.m >= from && c.m <= to);
}

/** WAV 番号を置き換える */
export function opReplaceWav(d: Draft<DtxDoc>, ids: ReadonlySet<number>, v: number): number {
  let n = 0;
  for (const c of d.chips) {
    if (ids.has(c.id) && c.v !== v && drumChannel(c.ch)) {
      c.v = v;
      n++;
    }
  }
  return n;
}
