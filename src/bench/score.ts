// 採点。正解の打点と推定した打点を、種類ごとに許容幅（既定 ±50ms）の中で1対1に組にして F 値を出す。
// 時刻の単位は問わない（秒でも拍でもよい。許容幅も同じ単位で渡す）。

export interface TimedEvent {
  t: number;
  cls: string;
}

export interface ClassScore {
  /** 正解の数 */
  ref: number;
  /** 推定の数 */
  est: number;
  /** 当たった数 */
  tp: number;
  /** 適合率（推定のうち当たった割合）。推定が0なら null */
  precision: number | null;
  /** 再現率（正解のうち拾えた割合）。正解が0なら null */
  recall: number | null;
  /** F 値。正解も推定も0なら null */
  f: number | null;
  /** 当たった組のずれ（推定−正解）の合計。平均は devSum / tp */
  devSum: number;
}

export interface Score {
  tol: number;
  classes: Record<string, ClassScore>;
  /** 全種類をまとめたもの（当たり・正解・推定の数を足してから計算する） */
  all: ClassScore;
}

export function classScore(ref: number, est: number, tp: number, devSum = 0): ClassScore {
  return {
    ref,
    est,
    tp,
    precision: est > 0 ? tp / est : null,
    recall: ref > 0 ? tp / ref : null,
    f: ref + est > 0 ? (2 * tp) / (ref + est) : null,
    devSum,
  };
}

/**
 * 昇順に並んだ正解と推定を、ずれが tol 以下のものどうしで1対1に組にする。
 * 正解の窓はどれも同じ幅なので、前から順に「窓の中でいちばん早い、まだ使っていない推定」を取れば
 * 組の数が最大になる。返すのは [正解の番号, 推定の番号] の組。
 */
export function matchSorted(ref: readonly number[], est: readonly number[], tol: number): [number, number][] {
  const out: [number, number][] = [];
  let j = 0;
  const eps = 1e-9;
  for (let i = 0; i < ref.length; i++) {
    while (j < est.length && est[j] < ref[i] - tol - eps) j++;
    if (j < est.length && est[j] <= ref[i] + tol + eps) {
      out.push([i, j]);
      j++;
    }
  }
  return out;
}

export interface ScoreDetail {
  score: Score;
  /** 当たった正解の番号（ref の並びのまま） */
  hitRef: Set<number>;
  /** 当たった推定の番号（est の並びのまま） */
  hitEst: Set<number>;
}

/** 種類ごとに組にして採点する。classes に無い種類の推定は数えない */
export function scoreEvents(ref: readonly TimedEvent[], est: readonly TimedEvent[], classes: readonly string[], tol = 0.05): ScoreDetail {
  const out: Record<string, ClassScore> = {};
  const hitRef = new Set<number>();
  const hitEst = new Set<number>();
  let R = 0;
  let E = 0;
  let T = 0;
  let D = 0;
  for (const cls of classes) {
    const ri = ref.map((e, i) => [e.t, i] as const).filter((_, i) => ref[i].cls === cls).sort((a, b) => a[0] - b[0]);
    const ei = est.map((e, i) => [e.t, i] as const).filter((_, i) => est[i].cls === cls).sort((a, b) => a[0] - b[0]);
    const pairs = matchSorted(
      ri.map((x) => x[0]),
      ei.map((x) => x[0]),
      tol,
    );
    let dev = 0;
    for (const [a, b] of pairs) {
      hitRef.add(ri[a][1]);
      hitEst.add(ei[b][1]);
      dev += ei[b][0] - ri[a][0];
    }
    out[cls] = classScore(ri.length, ei.length, pairs.length, dev);
    R += ri.length;
    E += ei.length;
    T += pairs.length;
    D += dev;
  }
  return { score: { tol, classes: out, all: classScore(R, E, T, D) }, hitRef, hitEst };
}

/** 曲をまたいでまとめる（当たり・正解・推定の数を足す） */
export function sumScores(list: readonly Score[]): Score | null {
  if (list.length === 0) return null;
  const classes: Record<string, ClassScore> = {};
  const keys = [...new Set(list.flatMap((s) => Object.keys(s.classes)))];
  for (const k of keys) {
    let r = 0;
    let e = 0;
    let t = 0;
    let d = 0;
    for (const s of list) {
      const c = s.classes[k];
      if (!c) continue;
      r += c.ref;
      e += c.est;
      t += c.tp;
      d += c.devSum;
    }
    classes[k] = classScore(r, e, t, d);
  }
  const all = list.reduce((a, s) => ({ r: a.r + s.all.ref, e: a.e + s.all.est, t: a.t + s.all.tp, d: a.d + s.all.devSum }), { r: 0, e: 0, t: 0, d: 0 });
  return { tol: list[0].tol, classes, all: classScore(all.r, all.e, all.t, all.d) };
}
