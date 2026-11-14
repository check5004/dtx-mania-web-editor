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

/**
 * 打数の項の係数。2026-11-03 に、楯さんの手元の6曲23譜面（作者5人、Lv2.40〜8.30）の #DLEVEL で合わせ直した。
 * 前の 3.1・-1.9 は登録より低く（BASIC で半分前後、MASTER で7割）出ていた。誤差は二乗平均で 1.73 → 0.43
 * （曲ごとに抜いて確かめても 0.52）。残りの誤差は主に作者ごとのつけ方の違いで、ガイドラインと似た譜面で埋める。
 */
const SLOPE = 3.51;
const BASE = -0.93;
const OLD_SLOPE = 3.1;
const OLD_BASE = -1.9;
/** 推定の式の版。ガイドラインに保存した古い推定を直すのに使う */
export const LEVEL_VERSION = 2;

const effOf = (avgNps: number, peakNps: number) => Math.max(1, 0.7 * avgNps + 0.3 * peakNps);
const clampLevel = (lv: number) => Math.round(Math.max(1, Math.min(9.99, lv)) * 100) / 100;

/** 前の版の式で出した推定を今の式に直す。密度は保存してあるので、ほかの項は前の推定から逆算する */
export function migrateLevel(old: number, avgNps: number, peakNps: number): number {
  const eff = effOf(avgNps, peakNps);
  const aux = Math.max(0, old - (OLD_SLOPE * Math.log(eff) + OLD_BASE));
  return clampLevel(SLOPE * Math.log(eff) + BASE + aux);
}

export function estimateLevel(doc: DtxDoc, tempo: TempoMap): LevelEstimate | null {
  const ev: { sec: number; lane: number; ch: number }[] = [];
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    ev.push({ sec: tempo.beatToSec(tempo.beatOf(c.m, c.f)), lane: d.lane, ch: c.ch });
  }
  if (ev.length < 8) return null;
  // 同じ時刻の音はチャンネルの順に並べる。手のレーンの切り替えの数が、譜面の中のチップの並び（読み込んだファイルの行の順・
  // 手で足した順）で変わらないように。保存すると行はチャンネルの順になるので、AI難易度生成で作った譜面の値と、
  // 書き出して開き直した譜面の値がそろう（並びで 0.01 変わっていた）
  ev.sort((a, b) => a.sec - b.sec || a.ch - b.ch);
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
  // 打数は対数で効かせる（平均2.5打/秒 ≒ Lv2.5、5打/秒 ≒ Lv5、10打/秒 ≒ Lv8 前後）
  const lv = SLOPE * Math.log(effOf(avgNps, peakNps)) + BASE + 0.4 * fastRatio + 0.15 * Math.min(2, Math.max(0, maxChord - 2)) + 0.03 * movesPs;
  return { level: clampLevel(lv), notes: ev.length, duration, avgNps, peakNps, maxChord, fastRatio, moves: movesPs };
}

/** #DLEVEL に書く値（6.65 → 665） */
export function levelToField(lv: number): string {
  return String(Math.round(lv * 100));
}
