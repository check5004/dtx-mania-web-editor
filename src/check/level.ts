// 推定レベル：ノーツの密度・最大同時打数・速い連打・手の移動から機械的に出す目安（1.00〜9.99）。
import { drumChannel, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';

export interface LevelEstimate {
  level: number;
  notes: number;
  /** 演奏している時間（秒） */
  duration: number;
  /** 平均の打数（1秒あたり） */
  avgNps: number;
  /** 一番密な2秒間の打数（1秒あたり） */
  peakNps: number;
  /** 最大同時打数 */
  maxChord: number;
  /** 16分（120BPM）より速い間隔の割合（同じ手足で） */
  fastRatio: number;
  /** 手のレーンの移動の多さ（1秒あたりのレーンの切り替え） */
  moves: number;
}

const HAND = new Set([0, 1, 3, 4, 6, 7, 8, 9]);

export function estimateLevel(doc: DtxDoc, tempo: TempoMap): LevelEstimate | null {
  const ev: { sec: number; lane: number }[] = [];
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    ev.push({ sec: tempo.beatToSec(tempo.beatOf(c.m, c.f)), lane: d.lane });
  }
  if (ev.length < 8) return null;
  ev.sort((a, b) => a.sec - b.sec);
  const duration = Math.max(1, ev[ev.length - 1].sec - ev[0].sec);
  const avgNps = ev.length / duration;
  // 一番密な2秒
  let peak = 0;
  for (let i = 0, j = 0; i < ev.length; i++) {
    while (ev[i].sec - ev[j].sec > 2) j++;
    peak = Math.max(peak, i - j + 1);
  }
  const peakNps = Math.min(peak / 2, ev.length / Math.min(2, duration));
  // 同時打ち
  let maxChord = 1;
  for (let i = 0; i < ev.length; ) {
    let j = i + 1;
    while (j < ev.length && ev[j].sec - ev[i].sec <= 0.012) j++;
    maxChord = Math.max(maxChord, j - i);
    i = j;
  }
  // 同じ手足の速い間隔
  const last = new Map<number, number>();
  let fast = 0;
  let pairs = 0;
  for (const e of ev) {
    const p = last.get(e.lane);
    last.set(e.lane, e.sec);
    if (p === undefined) continue;
    const dt = e.sec - p;
    if (dt <= 0.012) continue;
    pairs++;
    if (dt < 0.125) fast++;
  }
  const fastRatio = pairs ? fast / pairs : 0;
  // 手のレーンの切り替え
  let moves = 0;
  let prevHand = -1;
  for (const e of ev) {
    if (!HAND.has(e.lane)) continue;
    if (prevHand >= 0 && e.lane !== prevHand) moves++;
    prevHand = e.lane;
  }
  const movesPs = moves / duration;
  // 打数は対数で効かせる（8ビート120BPM ≒ 3.8、16ビート140BPM ≒ 6、BDの多い16分180BPM ≒ 7.5）
  const eff = 0.7 * avgNps + 0.3 * peakNps;
  let lv = 3.1 * Math.log(Math.max(1, eff)) - 1.9 + 0.4 * fastRatio + 0.15 * Math.min(2, Math.max(0, maxChord - 2)) + 0.03 * movesPs;
  lv = Math.max(1, Math.min(9.99, lv));
  return { level: Math.round(lv * 100) / 100, notes: ev.length, duration, avgNps, peakNps, maxChord, fastRatio, moves: movesPs };
}

/** #DLEVEL に書く値（6.65 → 665） */
export function levelToField(lv: number): string {
  return String(Math.round(lv * 100));
}
