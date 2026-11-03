// 原曲で聞こえるドラム（採譜モデルの打点）と、小節の譜面がどれだけ合うか（TAB補完の候補の点数に使う）。
// 打点も譜面のチップも種類（バスドラム・スネア・タム）にまとめ、±50ms で1対1に組にした F 値（0〜1）を出す。
// ハイハット・シンバルは採譜が拾いきれないことが多いので使わない（ADTOF.reliable。5種全部で測るより候補選びが当たらなかった）。
import { classOfChannel, type DrumClass } from '../bench/classes';
import { matchSorted } from '../bench/score';
import type { Frac } from '../dtx/fraction';
import type { TempoMap } from '../dtx/timing';
import { ADTOF } from '../transcribe/model';

/** 照らし合わせる幅（秒）。精度テストの採点と同じ */
export const HEARD_TOL = 0.05;

export interface HeardDrums {
  /**
   * 小節 m に notes を打ったとき、原曲の打点とどれだけ合うか（0〜1）。
   * 譜面も打点も無ければ 1。原曲の外の小節なら null。
   */
  agree(notes: readonly { ch: number; f: Frac }[], m: number): number | null;
}

/** 比べる種類 */
const CLASSES: readonly DrumClass[] = ADTOF.reliable;

/**
 * 原曲の打点（音の頭が 0 秒）から作る。offsetSec は原曲の 0 秒が譜面の何秒か（BGM のチップの位置）、
 * duration は原曲の長さ（秒）。
 */
export function heardDrums(hits: readonly { t: number; cls: DrumClass }[], tempo: TempoMap, offsetSec: number, duration: number): HeardDrums {
  // 種類ごとに、譜面の時刻（秒）の昇順
  const by = new Map<DrumClass, number[]>(CLASSES.map((c) => [c, []]));
  for (const h of hits) by.get(h.cls)?.push(h.t + offsetSec);
  for (const arr of by.values()) arr.sort((a, b) => a - b);
  const secOf = (m: number, f: Frac) => tempo.beatToSec(tempo.beatOf(m, f));
  const range = (arr: readonly number[], lo: number, hi: number) => {
    // lo 以上 hi 未満
    let a = 0;
    let b = arr.length;
    while (a < b) {
      const md = (a + b) >> 1;
      if (arr[md] < lo) a = md + 1;
      else b = md;
    }
    const out: number[] = [];
    for (let i = a; i < arr.length && arr[i] < hi; i++) out.push(arr[i]);
    return out;
  };
  return {
    agree(notes, m) {
      const t0 = tempo.beatToSec(tempo.measureStart(m));
      const t1 = tempo.beatToSec(tempo.measureStart(m) + tempo.measureBeats(m));
      // 半分以上が原曲の外なら分からない
      const inside = Math.max(0, Math.min(t1, offsetSec + duration) - Math.max(t0, offsetSec));
      if (t1 <= t0 || inside < (t1 - t0) * 0.5) return null;
      // 小節の頭の少し前の打点（早めに叩いた頭の拍）も、この小節に数える
      const lo = t0 - HEARD_TOL;
      const hi = t1 - HEARD_TOL;
      let tp = 0;
      let nNotes = 0;
      let nHits = 0;
      for (const cls of CLASSES) {
        const ns = [...new Set(notes.filter((n) => classOfChannel(n.ch) === cls).map((n) => Math.round(secOf(m, n.f) * 1000)))].map((x) => x / 1000).sort((a, b) => a - b);
        const hs = range(by.get(cls)!, lo, hi);
        nNotes += ns.length;
        nHits += hs.length;
        if (ns.length && hs.length) tp += matchSorted(ns, hs, HEARD_TOL).length;
      }
      if (nNotes + nHits === 0) return 1;
      return (2 * tp) / (nNotes + nHits);
    },
  };
}
