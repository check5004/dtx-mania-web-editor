// 原曲との照合：点線で出した予測のチップが、原曲で鳴っていそうかを確かめる（TAB補完の「原曲と照らし合わせる」）。
// ドラムの採譜モデル（ADTOF）の結果があればそれを使い（modelEvidence）、無ければ v0 の打点検出（原曲を3帯域に分けた打点）を使う。
// v0 で当たり外れを見分けられたのはスネアだけだった（打点のないスネアの予測は当たり 33%、打点のあるものは 90%）ので、
// v0 ではスネアだけを見る。採譜モデルでは、バスドラム・スネア・タムを見る（ADTOF.reliable。精度テスト docs/bench.md の
// 「原曲との照合」で、聞こえないと言った予測のチップの正解率が 4〜6割まで下がった種類。ハイハット・シンバルは 8割弱で見分けにならない）。
import { classifyEvents, detectEvents, type AnalysisLike } from '../bench/baseline';
import { classOfChannel, type DrumClass } from '../bench/classes';
import { ADTOF } from '../transcribe/model';

export interface Evidence {
  /** その種類の音が、原曲の t 秒の近くで鳴っているか。この方法では分からない種類なら null */
  heard(cls: DrumClass, t: number): boolean | null;
}

/** 打点を探す幅（秒）。精度テストの採点と同じ ±50ms */
export const EVIDENCE_TOL = 0.05;

/** v0 の打点検出で確かめる種類 */
const CHECKED: ReadonlySet<DrumClass> = new Set<DrumClass>(['SD']);

/** 種類ごとの打点の時刻（秒）から照合を作る。checked に無い種類は「分からない」 */
export function timesEvidence(times: ReadonlyMap<DrumClass, readonly number[]>, checked: ReadonlySet<DrumClass>, tol = EVIDENCE_TOL): Evidence {
  const sorted = new Map<DrumClass, number[]>();
  for (const [cls, arr] of times) sorted.set(cls, [...arr].sort((x, y) => x - y));
  return {
    heard(cls, t) {
      if (!checked.has(cls)) return null;
      const arr = sorted.get(cls) ?? [];
      // t 以上で最初の打点と、その1つ前のうち近い方
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      const near = Math.min(lo < arr.length ? arr[lo] - t : Infinity, lo > 0 ? t - arr[lo - 1] : Infinity);
      return near <= tol + 1e-9;
    },
  };
}

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
  return timesEvidence(times, CHECKED);
}

/**
 * ドラムの採譜モデルの打点で作る照合。checked は見る種類（精度テストで、当たり外れを見分けられた種類）。
 */
export function modelEvidence(hits: readonly { t: number; cls: DrumClass }[], checked: ReadonlySet<DrumClass> = MODEL_CHECKED): Evidence {
  const times = new Map<DrumClass, number[]>();
  for (const h of hits) {
    let arr = times.get(h.cls);
    if (!arr) times.set(h.cls, (arr = []));
    arr.push(h.t);
  }
  return timesEvidence(times, checked);
}

/** 採譜モデルで確かめる種類 */
export const MODEL_CHECKED: ReadonlySet<DrumClass> = new Set<DrumClass>(ADTOF.reliable);

/** チャンネルのチップが原曲で聞こえないと言えるか（聞こえない＝true。分からなければ false） */
export function unheard(ev: Evidence, ch: number, t: number): boolean {
  const cls = classOfChannel(ch);
  if (!cls) return false;
  return ev.heard(cls, t) === false;
}
