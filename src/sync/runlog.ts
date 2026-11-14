// 同期の記録（新しい順。IndexedDB の sync:log）に 1 回の同期を足す決まり。書くのは src/sync/store.ts。
// - 何かあった同期だけ残す（30 日・300 件まで）
// - 聞いていること（確かめてほしいこと）は、いちばん新しい記録にだけ残す。画面は log[0].asks を出す
import type { Ask, RunReport } from './types';

/** 記録の 1 件（1 回の同期）。done は「これでよい」を押した物（newer の path） */
export type LogEntry = RunReport & { done?: string[] };

/** 記録を残す日数 */
export const LOG_DAYS = 30;
const LOG_MAX = 300;

/** 聞いたことが、その曲についてか */
function askOf(a: Ask, libs: ReadonlySet<string>): boolean {
  if (a.kind === 'same') return libs.has(a.driveLib.toLowerCase()) || libs.has(a.localLib.toLowerCase());
  return libs.has(a.lib.toLowerCase());
}

/** 聞いていることが同じか（id で） */
function sameAsks(a: readonly Ask[], b: readonly Ask[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id);
}

/**
 * 記録に 1 回の同期を足した物（変わらなければ null）。only は 1 曲だけの同期（保存したとき・「取り込む」）。
 * - 1 曲だけの同期は、ほかの曲で聞いていることを知らない：前の分を残し、その曲の分だけ今回の物にする
 * - 途中で止まった同期（error）は、聞いていることを見ていない：前の分を残す。同じ失敗が続いたら 1 件にまとめる
 * - 何も無い同期は足さない。聞いていることが変わったときだけ、いちばん新しい記録に映す（5 分ごとに同じ物を足さない）
 */
export function addRun(log: readonly LogEntry[], rep: RunReport, o: { only?: boolean; now?: number } = {}): LogEntry[] | null {
  if (rep.dry) return null;
  const top = log[0];
  let asks = rep.asks;
  if (o.only) {
    const libs = new Set([...rep.songs.map((x) => x.lib), ...rep.asks.map((a) => (a.kind === 'same' ? a.localLib : a.lib))].map((x) => x.toLowerCase()));
    const ids = new Set(rep.asks.map((a) => a.id));
    asks = [...(top?.asks ?? []).filter((a) => !ids.has(a.id) && !askOf(a, libs)), ...rep.asks];
  } else if (rep.error && !rep.songs.length) asks = top?.asks ?? [];
  if (!rep.songs.length && !rep.error) {
    if (top) return sameAsks(top.asks, asks) ? null : [{ ...top, asks }, ...log.slice(1)];
    if (!asks.length) return null;
  }
  const again = !!rep.error && !rep.songs.length && !!top && !top.songs.length && top.error === rep.error;
  const limit = (o.now ?? Date.now()) - LOG_DAYS * 86_400_000;
  const prev = (again ? log.slice(1) : log).map((l) => (l.asks.length ? { ...l, asks: [] } : l));
  return [{ ...rep, asks }, ...prev].filter((l) => l.at >= limit).slice(0, LOG_MAX);
}
