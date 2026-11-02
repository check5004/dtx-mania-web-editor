// 曲に合わせて叩いた（クリックした）時刻から、BPMと拍の位置を求める。
//   ・叩き損ねて拍が飛んでも、間隔の中央値で「何拍目か」を数えてから直線を当てはめる
//   ・大きく外れた1打は外してもう一度当てはめる

export interface TapFit {
  /** 測ったBPM */
  bpm: number;
  /** 1拍の長さ（秒） */
  period: number;
  /** 最初に叩いた拍の時刻（当てはめた直線の上） */
  t0: number;
  /** 使った打数 */
  count: number;
  /** 叩いた位置のばらつき（ミリ秒） */
  jitterMs: number;
  /** BPMの誤差の目安（±） */
  errBpm: number;
  /** それぞれの打が何拍目か（外した打は -1） */
  ks: number[];
}

interface Line {
  period: number;
  t0: number;
  rms: number;
  se: number;
}

function regress(ts: readonly number[], ks: readonly number[]): Line | null {
  const n = ts.length;
  if (n < 2) return null;
  let kb = 0;
  let tb = 0;
  for (let i = 0; i < n; i++) {
    kb += ks[i];
    tb += ts[i];
  }
  kb /= n;
  tb /= n;
  let skk = 0;
  let skt = 0;
  for (let i = 0; i < n; i++) {
    skk += (ks[i] - kb) ** 2;
    skt += (ks[i] - kb) * (ts[i] - tb);
  }
  if (skk <= 0) return null;
  const period = skt / skk;
  const t0 = tb - period * kb;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ts[i] - (t0 + period * ks[i])) ** 2;
  const rms = Math.sqrt(ss / Math.max(1, n - 2));
  return { period, t0, rms, se: rms / Math.sqrt(skk) };
}

/** 叩いた時刻（秒、昇順）から BPM を求める。4打より少ないときや、間隔がおかしいときは null */
export function fitTaps(times: readonly number[]): TapFit | null {
  if (times.length < 4) return null;
  const iv: number[] = [];
  for (let i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
  const sorted = [...iv].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  // 24〜400 BPM の範囲だけ
  if (!(med >= 0.15 && med <= 2.5)) return null;
  const ks = [0];
  for (let i = 0; i < iv.length; i++) ks.push(ks[i] + Math.max(1, Math.round(iv[i] / med)));
  const first = regress(times, ks);
  if (!first || first.period <= 0) return null;
  let line = first;
  // 外れた打を外してやり直す（ずれの中央値の数倍より外れた打）
  const res = times.map((t, i) => Math.abs(t - (first.t0 + first.period * ks[i])));
  const mad = [...res].sort((a, b) => a - b)[Math.floor(res.length / 2)];
  const limit = Math.min(first.period * 0.3, Math.max(0.04, mad * 6));
  const keep: number[] = [];
  for (let i = 0; i < times.length; i++) if (res[i] <= limit) keep.push(i);
  let usedKs = ks;
  if (keep.length >= 4 && keep.length < times.length) {
    const l2 = regress(
      keep.map((i) => times[i]),
      keep.map((i) => ks[i]),
    );
    if (l2 && l2.period > 0) {
      line = l2;
      usedKs = ks.map((k, i) => (keep.includes(i) ? k : -1));
    }
  }
  const bpm = 60 / line.period;
  return {
    bpm,
    period: line.period,
    t0: line.t0,
    count: usedKs.filter((k) => k >= 0).length,
    jitterMs: line.rms * 1000,
    errBpm: (60 / line.period ** 2) * line.se,
    ks: usedKs,
  };
}

/** 画面に出す・譜面に入れるBPM。整数に近ければ整数にそろえる */
export function tapBpm(fit: TapFit, roundToInt: boolean): number {
  const r = Math.round(fit.bpm);
  if (roundToInt && Math.abs(fit.bpm - r) <= Math.max(0.35, fit.errBpm * 2.5)) return r;
  return Math.round(fit.bpm * 100) / 100;
}

/** BPMを決めたあと、叩いた位置にいちばん合う「最初の拍」の時刻 */
export function tapPhase(times: readonly number[], fit: TapFit, bpm: number): number {
  const p = 60 / bpm;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < times.length; i++) {
    const k = fit.ks[i];
    if (k < 0) continue;
    sum += times[i] - k * p;
    n++;
  }
  return n ? sum / n : fit.t0;
}
