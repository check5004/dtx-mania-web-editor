// 原曲との照合：点線で出した予測のチップが、原曲で鳴っていそうかを確かめる（TAB補完の「原曲と照らし合わせる」）。
// 今は v0 の打点検出（原曲を3帯域に分けた打点）を使う。精度テストでは、これで当たり外れを見分けられたのはスネアだけだった
// （打点のないスネアの予測は当たり 33%、打点のあるものは 90%）。ほかの種類は見ない（印を出すと、かえって迷わせる）。
// 段階3でドラムの採譜モデルを入れたら、Evidence をそのモデルの結果で作り直して差し替える。
import { classifyEvents, detectEvents, type AnalysisLike } from '../bench/baseline';
import { classOfChannel, type DrumClass } from '../bench/classes';

export interface Evidence {
  /** その種類の音が、原曲の t 秒の近くで鳴っているか。この方法では分からない種類なら null */
  heard(cls: DrumClass, t: number): boolean | null;
}

/** 打点を探す幅（秒）。精度テストの採点と同じ ±50ms */
export const EVIDENCE_TOL = 0.05;

/** v0 の打点検出で確かめる種類 */
const CHECKED: ReadonlySet<DrumClass> = new Set<DrumClass>(['SD']);

/** v0 の打点検出（感度 0.5）で作る照合 */
export function onsetEvidence(a: AnalysisLike, sensitivity = 0.5): Evidence {
  const times = new Map<DrumClass, number[]>();
  for (const h of classifyEvents(detectEvents(a, sensitivity))) {
    const cls = h.lane as DrumClass;
    if (!CHECKED.has(cls)) continue;
    let arr = times.get(cls);
    if (!arr) times.set(cls, (arr = []));
    arr.push(h.t);
  }
  for (const arr of times.values()) arr.sort((x, y) => x - y);
  return {
    heard(cls, t) {
      if (!CHECKED.has(cls)) return null;
      const arr = times.get(cls) ?? [];
      // t 以上で最初の打点と、その1つ前のうち近い方
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      const near = Math.min(lo < arr.length ? arr[lo] - t : Infinity, lo > 0 ? t - arr[lo - 1] : Infinity);
      return near <= EVIDENCE_TOL + 1e-9;
    },
  };
}

/** チャンネルのチップが原曲で聞こえないと言えるか（聞こえない＝true。分からなければ false） */
export function unheard(ev: Evidence, ch: number, t: number): boolean {
  const cls = classOfChannel(ch);
  if (!cls) return false;
  return ev.heard(cls, t) === false;
}
