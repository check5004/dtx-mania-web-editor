// 2つの音の時刻のずれ（ステムと原曲など）を、音の立ち上がりの重なりから 1ms 単位で測る。
// 1/1000 秒ごとの「音が急に大きくなった度合い」を作り、ずらしながら重ねていちばん重なる所を探す。
// 分離ソフトによっては、MP3 の頭の無音（1105 サンプル＝44.1kHz で約25ms）を足したままステムを書き出すため。

/** 立ち上がりの強さを作る時間の細かさ（1秒あたり） */
export const LAG_RATE = 1000;

/** 1/rate 秒ごとの音の大きさ（e の from〜to 番目を書く） */
function hopEnergy(channels: readonly Float32Array[], hop: number, e: Float64Array, from: number, to: number) {
  const len = channels[0].length;
  for (let i = from; i < to; i++) {
    const a = Math.floor(i * hop);
    const b = Math.min(len, Math.floor((i + 1) * hop));
    let s = 0;
    for (const ch of channels) for (let j = a; j < b; j++) s += ch[j] * ch[j];
    e[i] = s;
  }
}

/** 音の大きさから立ち上がりの強さ（2ms の窓の dB が 5ms 前より増えた分） */
function risesFromEnergy(e: Float64Array, hop: number, nCh: number, rate: number): Float32Array {
  const n = e.length;
  const k = 1 / (2 * hop * Math.max(1, nCh));
  const db = new Float32Array(n);
  // −60dB より小さい音は同じとみなす（静かな所の揺れを拾わない）
  for (let i = 0; i < n; i++) db[i] = 10 * Math.log10((e[i] + (i + 1 < n ? e[i + 1] : e[i])) * k + 1e-6);
  const out = new Float32Array(n);
  const back = Math.max(1, Math.round(rate * 0.005));
  for (let i = back; i < n; i++) {
    const d = db[i] - db[i - back];
    out[i] = d > 0 ? d : 0;
  }
  return out;
}

/** 1/rate 秒ごとの立ち上がりの強さ（モノラルにして、2ms の窓の音の大きさ（dB）が 5ms 前より増えた分） */
export function onsetEnvelope(channels: readonly Float32Array[], sr: number, rate = LAG_RATE): Float32Array {
  const hop = sr / rate;
  const n = channels.length ? Math.floor(channels[0].length / hop) : 0;
  const e = new Float64Array(n);
  if (n) hopEnergy(channels, hop, e, 0, n);
  return risesFromEnergy(e, hop, channels.length, rate);
}

/**
 * b のはっきりした立ち上がり（5ms で 1.5dB 以上）の位置。多すぎれば強いものから MAX_RISES 個
 * （重ねる計算が少なくて済み、静かな所の小さな揺れも数えない）
 */
const MAX_RISES = 40000;
function strongRises(b: Float32Array, margin: number): number[] {
  let thr = 1.5;
  let count = 0;
  for (let j = margin; j < b.length - margin; j++) if (b[j] > thr) count++;
  if (count > MAX_RISES) {
    const vals: number[] = [];
    const step = Math.max(1, Math.floor(count / 20000));
    let c = 0;
    for (let j = margin; j < b.length - margin; j++) if (b[j] > thr && c++ % step === 0) vals.push(b[j]);
    vals.sort((x, y) => y - x);
    thr = vals[Math.min(vals.length - 1, Math.floor((vals.length * MAX_RISES) / count))];
  }
  const idx: number[] = [];
  for (let j = margin; j < b.length - margin; j++) if (b[j] > thr) idx.push(j);
  return idx;
}

/** ずらし方 k（k0〜k1）ごとの重なり。corr[k + L] に書く */
function corrRange(a: Float32Array, b: Float32Array, idx: readonly number[], L: number, k0: number, k1: number, corr: Float64Array) {
  for (let k = k0; k <= k1; k++) {
    let s = 0;
    for (const j of idx) {
      const i = j - k;
      if (i >= 0 && i < a.length) s += b[j] * a[i];
    }
    corr[k + L] = s;
  }
}

export interface LagResult {
  /** b が a より何秒遅れているか（負なら早い） */
  lag: number;
  /** 山のはっきりさ（山の高さが、ほかのずらし方の平均からばらつきの何倍か） */
  score: number;
}

/** 重なりのいちばん高い所（はっきりしなければ null） */
function peakOf(corr: Float64Array, L: number, rate: number, minScore: number): LagResult | null {
  let best = 0;
  for (let i = 1; i < corr.length; i++) if (corr[i] > corr[best]) best = i;
  // 山の周り ±5ms を除いた平均・ばらつき
  let sum = 0;
  let sum2 = 0;
  let m = 0;
  for (let i = 0; i < corr.length; i++) {
    if (Math.abs(i - best) <= 5) continue;
    sum += corr[i];
    sum2 += corr[i] * corr[i];
    m++;
  }
  const mean = sum / m;
  const sd = Math.sqrt(Math.max(1e-12, sum2 / m - mean * mean));
  const score = (corr[best] - mean) / sd;
  if (!(score >= minScore)) return null;
  // 山の頂を放物線で細かく
  let off = 0;
  if (best > 0 && best < corr.length - 1) {
    const y0 = corr[best - 1];
    const y1 = corr[best];
    const y2 = corr[best + 1];
    const den = y0 - 2 * y1 + y2;
    if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  return { lag: (best - L + off) / rate, score };
}

/** これより山がはっきりしなければ、測れなかったことにする */
const MIN_SCORE = 6;
/** 探すずれの幅（秒） */
const MAX_LAG = 0.15;

/**
 * b が a より何秒遅れているかを、−maxLag〜maxLag 秒の中で探す。山がはっきりしなければ null。
 * b はステム（はっきりした立ち上がりの所だけ数える）、a は原曲。
 */
export function estimateLag(a: Float32Array, b: Float32Array, rate = LAG_RATE, maxLag = MAX_LAG, minScore = MIN_SCORE): LagResult | null {
  const L = Math.round(maxLag * rate);
  const idx = strongRises(b, L);
  if (idx.length < 50) return null;
  const corr = new Float64Array(2 * L + 1);
  corrRange(a, b, idx, L, -L, L, corr);
  return peakOf(corr, L, rate, minScore);
}

/** 画面を止めないように少しずつ休む */
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

async function envelopeSlowly(channels: readonly Float32Array[], sr: number, isStale: () => boolean): Promise<Float32Array | null> {
  const hop = sr / LAG_RATE;
  const n = channels.length ? Math.floor(channels[0].length / hop) : 0;
  const e = new Float64Array(n);
  const chunk = 20000;
  for (let i = 0; i < n; i += chunk) {
    hopEnergy(channels, hop, e, i, Math.min(n, i + chunk));
    await pause();
    if (isStale()) return null;
  }
  return risesFromEnergy(e, hop, channels.length, LAG_RATE);
}

/**
 * ステム（stem）が原曲（orig）より何秒遅れているか。画面が固まらないように、少しずつ休みながら測る。
 * 測れなければ（原曲にその楽器が入っていないなど）・途中で要らなくなれば null。
 */
export async function measureLag(orig: readonly Float32Array[], stem: readonly Float32Array[], sr: number, isStale: () => boolean = () => false): Promise<LagResult | null> {
  const a = await envelopeSlowly(orig, sr, isStale);
  if (!a) return null;
  const b = await envelopeSlowly(stem, sr, isStale);
  if (!b) return null;
  const L = Math.round(MAX_LAG * LAG_RATE);
  const idx = strongRises(b, L);
  if (idx.length < 50) return null;
  const corr = new Float64Array(2 * L + 1);
  // 1回に重ねる量を 200万回くらいにして休む
  const step = Math.max(4, Math.floor(2000000 / Math.max(1, idx.length)));
  for (let k = -L; k <= L; k += step) {
    corrRange(a, b, idx, L, k, Math.min(L, k + step - 1), corr);
    await pause();
    if (isStale()) return null;
  }
  return peakOf(corr, L, LAG_RATE, MIN_SCORE);
}
