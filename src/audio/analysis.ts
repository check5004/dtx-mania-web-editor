// 原曲の解析。波形の山、帯域別（低・中・高）の打点の強さ、BPMの推定、拍の追跡。
// 重い処理（フィルタ・自己相関）はワーカーで、軽い処理（打点の拾い出し・拍の追跡）は画面側でも使う。
import { biquad, downmix, filtfilt, quantile, resample } from './dsp';
import { bpmPrior, guessBars, musicStart, type BarGuess } from './grid';

/** 打点の強さを出す細かさ（1秒あたりのフレーム数。5ms刻み） */
export const FRAME_RATE = 200;
/** 波形の山の細かさ（1秒あたり） */
export const PEAK_RATE = 400;
/** 解析に使うサンプリング周波数 */
export const ANALYSIS_SR = 22050;

export type Band = 'low' | 'mid' | 'high';
export const BANDS: readonly Band[] = ['low', 'mid', 'high'];

export interface TempoCandidate {
  bpm: number;
  /** 0〜1。1が最も拍とよく合う */
  score: number;
  kind: 'best' | 'half' | 'double' | 'other';
  /** 最初の拍の時刻（秒）。拍の位相 */
  phase: number;
}

export interface AnalysisData {
  duration: number;
  peakRate: number;
  /** 区間ごとの振幅の最大（0〜1） */
  peaks: Float32Array;
  frameRate: number;
  /** 帯域ごとの打点の強さ（立ち上がり。おおむね0〜1） */
  odf: Record<Band, Float32Array>;
  /** 帯域ごとの音量の包絡（おおむね0〜1） */
  env: Record<Band, Float32Array>;
  /** BPM の候補（いちばん合うものが先頭。倍・半分は小節の形で決める） */
  tempo: TempoCandidate[];
  /** BPM の候補ごとの拍の位置と 1 拍目（tempo と同じ順） */
  bars: BarGuess[];
  /** 音楽が始まる所（秒。低域がしっかり鳴り始める所） */
  start: number;
}

export interface Onset {
  /** 原曲の中の時刻（秒） */
  t: number;
  /** 強さ（おおむね0〜1） */
  s: number;
}

// ---- 波形 ---------------------------------------------------------------------

export function computePeaks(x: Float32Array, sr: number, rate = PEAK_RATE): Float32Array {
  const n = Math.ceil((x.length / sr) * rate);
  const out = new Float32Array(n);
  const hop = sr / rate;
  let max = 1e-9;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * hop);
    const b = Math.min(x.length, Math.floor((i + 1) * hop));
    let m = 0;
    for (let j = a; j < b; j++) {
      const v = x[j] < 0 ? -x[j] : x[j];
      if (v > m) m = v;
    }
    out[i] = m;
    if (m > max) max = m;
  }
  for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

// ---- 帯域別の打点 ---------------------------------------------------------------

const BAND_FILTERS: Record<Band, (sr: number) => ReturnType<typeof biquad>[]> = {
  // だいたいキック
  low: (sr) => {
    const lp = biquad('lowpass', 120, 0.707, sr);
    return [lp, lp, lp];
  },
  // だいたいスネア・タム
  mid: (sr) => {
    const hp = biquad('highpass', 180, 0.707, sr);
    const lp = biquad('lowpass', 3000, 0.707, sr);
    return [hp, hp, lp, lp];
  },
  // だいたいハイハット・シンバル
  high: (sr) => {
    const hp = biquad('highpass', 6000, 0.707, sr);
    return [hp, hp];
  },
};

/**
 * 帯域ごとの立ち上がりの遅れ（フレーム、5ms 単位）。キックの低音は鳴り始めてから大きくなるまでに時間がかかり
 * （50Hz の1周期は 20ms）、低域の立ち上がりの山は本当の打点より 10ms ほど遅れる。その分だけ前へずらして、
 * 中域・高域と時刻をそろえる（正解の譜面つきのテスト曲3曲で、譜面の音と本物のドラムの録音の両方で測った値）。
 */
export const ODF_LAG: Record<Band, number> = { low: 2, mid: 0, high: 0 };

/** 立ち上がりを lag フレーム前へずらす（後ろは 0） */
function shiftEarlier(x: Float32Array, lag: number): Float32Array {
  if (lag <= 0) return x;
  const out = new Float32Array(x.length);
  out.set(x.subarray(lag));
  return out;
}

/** 帯域の音量の包絡と、立ち上がりの強さ（対数の増え方）を出す */
export function bandEnvelope(x: Float32Array, sr: number, frameRate = FRAME_RATE): { env: Float32Array; odf: Float32Array } {
  const hop = sr / frameRate;
  const frames = Math.floor(x.length / hop);
  // hop ごとの二乗平均
  const blk = new Float32Array(frames + 1);
  for (let k = 0; k < frames; k++) {
    const a = Math.floor(k * hop);
    const b = Math.min(x.length, Math.floor((k + 1) * hop));
    let s = 0;
    for (let j = a; j < b; j++) s += x[j] * x[j];
    blk[k] = b > a ? s / (b - a) : 0;
  }
  // フレーム i は [i-1, i+1) の2ブロック（時刻 i/frameRate が中心）
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) env[i] = Math.sqrt(((i > 0 ? blk[i - 1] : 0) + blk[i]) / 2);
  const ref = Math.max(1e-6, quantile(env, 0.98));
  const comp = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    env[i] = Math.min(4, env[i] / ref);
    comp[i] = Math.log1p(2 * env[i]);
  }
  const odf = new Float32Array(frames);
  for (let i = 1; i < frames; i++) {
    let prev = comp[i - 1];
    if (i >= 2 && comp[i - 2] > prev) prev = comp[i - 2];
    if (i >= 3 && comp[i - 3] > prev) prev = comp[i - 3];
    const d = comp[i] - prev;
    odf[i] = d > 0 ? d : 0;
  }
  // 目立つ立ち上がりがだいたい1になるようにそろえる
  let nz = 0;
  for (let i = 0; i < frames; i++) if (odf[i] > 0.02) nz++;
  const scale = nz > 0 ? quantileNonZero(odf, 0.97) : 1;
  if (scale > 1e-6) for (let i = 0; i < frames; i++) odf[i] = Math.min(2, odf[i] / scale);
  return { env, odf };
}

function quantileNonZero(x: Float32Array, q: number): number {
  const s: number[] = [];
  const step = Math.max(1, Math.floor(x.length / 40000));
  for (let i = 0; i < x.length; i += step) if (x[i] > 0.02) s.push(x[i]);
  if (s.length === 0) return 1;
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))];
}

/** 3帯域を合わせた立ち上がり（BPMの推定用） */
export function combinedOdf(odf: Record<Band, Float32Array>): Float32Array {
  const n = Math.min(odf.low.length, odf.mid.length, odf.high.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = odf.low[i] + 0.8 * odf.mid[i] + 0.5 * odf.high[i];
  return out;
}

/**
 * 立ち上がりの強さから打点を拾う。sensitivity は 0（控えめ）〜1（たくさん拾う）。
 * 周りの平均より十分大きく、前後30msで一番大きい所を打点にする。
 */
export function pickOnsets(odf: Float32Array, frameRate: number, sensitivity: number): Onset[] {
  const n = odf.length;
  const sens = Math.max(0, Math.min(1, sensitivity));
  const delta = 0.34 - 0.28 * sens;
  const mult = 1.5 - 0.5 * sens;
  const W = Math.round(0.12 * frameRate);
  const near = Math.max(1, Math.round(0.03 * frameRate));
  const minGap = Math.round(0.045 * frameRate);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + odf[i];
  const out: Onset[] = [];
  let last = -minGap - 1;
  for (let i = 1; i < n - 1; i++) {
    const v = odf[i];
    if (v < delta) continue;
    const a = Math.max(0, i - W);
    const b = Math.min(n, i + W + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    if (v < mean * mult + delta * 0.5) continue;
    let isMax = true;
    for (let j = Math.max(0, i - near); j <= Math.min(n - 1, i + near); j++) {
      if (j === i) continue;
      if (odf[j] > v || (j < i && odf[j] === v)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (i - last < minGap) {
      // 近すぎる打点は強いほうを残す
      if (out.length && out[out.length - 1].s < v) out.pop();
      else continue;
    }
    // 放物線で山の位置を補間し、包絡の窓の分（半フレーム）だけ前にずらす
    const l = odf[i - 1];
    const r = odf[i + 1];
    const den = l - 2 * v + r;
    const off = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    out.push({ t: (i + off - 0.5) / frameRate, s: v });
    last = i;
  }
  return out;
}

// ---- BPM ----------------------------------------------------------------------

/** BPM ごとの「拍の位置にどれだけ打点がそろうか」。位相を64区分にたたんで一番そろう所を見る */
function combScore(odf: Float32Array, frameRate: number, bpm: number): { score: number; phase: number } {
  const P = (60 * frameRate) / bpm;
  const B = 64;
  const hist = new Float64Array(B);
  for (let i = 0; i < odf.length; i++) {
    const v = odf[i];
    if (v <= 0.05) continue;
    const ph = (i % P) / P;
    hist[Math.floor(ph * B) % B] += v;
  }
  let best = -1;
  let bestK = 0;
  for (let k = 0; k < B; k++) {
    const s = hist[(k + B - 1) % B] * 0.5 + hist[k] + hist[(k + 1) % B] * 0.5;
    if (s > best) {
      best = s;
      bestK = k;
    }
  }
  let total = 0;
  for (let k = 0; k < B; k++) total += hist[k];
  return { score: total > 0 ? best / total : 0, phase: ((bestK + 0.5) / B) * P };
}

function refineBpm(odf: Float32Array, frameRate: number, bpm: number, range = 0.02): { bpm: number; score: number; phase: number } {
  let best = { bpm, score: -1, phase: 0 };
  const lo = bpm * (1 - range);
  const hi = bpm * (1 + range);
  const coarse = Math.max(0.05, bpm * 0.0008);
  for (let b = lo; b <= hi; b += coarse) {
    const r = combScore(odf, frameRate, b);
    if (r.score > best.score) best = { bpm: b, score: r.score, phase: r.phase };
  }
  const c = best.bpm;
  for (let b = c - coarse; b <= c + coarse; b += 0.005) {
    const r = combScore(odf, frameRate, b);
    if (r.score > best.score) best = { bpm: b, score: r.score, phase: r.phase };
  }
  return best;
}

/** 曲全体のBPMを推定する。最もよく合うもの、その半分と倍を候補にする */
export function estimateTempo(odf: Float32Array, frameRate: number): TempoCandidate[] {
  const n = odf.length;
  if (n < frameRate * 4) return [];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = odf[i] - mean;
  const lagMin = Math.floor((60 * frameRate) / 260);
  const lagMax = Math.ceil((60 * frameRate) / 50);
  const acf = new Float64Array(lagMax + 2);
  for (let L = lagMin - 1; L <= lagMax + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += x[i] * x[i + L];
    acf[L] = s / (n - L);
  }
  // 自己相関の山。倍の周期（小節側）の山も足して、細かすぎる刻み（8分）を拍と取り違えにくくする。
  // よくある 80〜200 BPM を少しだけ優先する
  const acfAt = (lag: number) => {
    const L = Math.floor(lag);
    if (L + 1 >= acf.length || L < 0) return 0;
    const f = lag - L;
    return acf[L] * (1 - f) + acf[L + 1] * f;
  };
  const acfFar = (lag: number) => {
    if (lag > lagMax) {
      const L = Math.round(lag);
      let s = 0;
      for (let i = 0; i + L < n; i++) s += x[i] * x[i + L];
      return s / Math.max(1, n - L);
    }
    return acfAt(lag);
  };
  const levelScore = (lag: number) => acfAt(lag) + 0.5 * acfFar(2 * lag) + 0.25 * acfFar(4 * lag);
  const peaks: { lag: number; v: number }[] = [];
  for (let L = lagMin; L <= lagMax; L++) {
    if (acf[L] > acf[L - 1] && acf[L] >= acf[L + 1] && acf[L] > 0) {
      const den = acf[L - 1] - 2 * acf[L] + acf[L + 1];
      const off = den !== 0 ? (0.5 * (acf[L - 1] - acf[L + 1])) / den : 0;
      const lag = L + Math.max(-0.5, Math.min(0.5, off));
      const bpm = (60 * frameRate) / lag;
      peaks.push({ lag, v: Math.max(0, levelScore(lag)) * bpmPrior(bpm) });
    }
  }
  if (peaks.length === 0) return [];
  peaks.sort((a, b) => b.v - a.v);
  // 一番の山を細かく合わせる（拍の位置にそろうかで小数まで決める）
  const best = refineBpm(odf, frameRate, (60 * frameRate) / peaks[0].lag);
  const lagOf = (bpm: number) => (60 * frameRate) / bpm;
  const out: TempoCandidate[] = [{ bpm: best.bpm, score: peaks[0].v, kind: 'best', phase: best.phase / frameRate }];
  for (const [mul, kind] of [
    [0.5, 'half'],
    [2, 'double'],
  ] as const) {
    const b = best.bpm * mul;
    if (b < 40 || b > 320) continue;
    const r = refineBpm(odf, frameRate, b, 0.003);
    const lag = lagOf(r.bpm);
    const v = lag <= lagMax ? Math.max(0, levelScore(lag)) * bpmPrior(r.bpm) : Math.max(0, acfFar(lag) + 0.5 * acfFar(2 * lag)) * bpmPrior(r.bpm);
    out.push({ bpm: r.bpm, score: v, kind, phase: r.phase / frameRate });
  }
  const top = Math.max(...out.map((c) => c.score), 1e-9);
  for (const c of out) c.score = Math.max(0, Math.min(1, c.score / top));
  // 小数第2位まで丸める（近い整数ならそれに合わせる）
  for (const c of out) {
    const r = Math.round(c.bpm);
    c.bpm = Math.abs(c.bpm - r) < 0.03 ? r : Math.round(c.bpm * 100) / 100;
  }
  return out;
}

/**
 * 拍の追跡（Ellis の動的計画法）。BPM の近くでテンポの揺れについていく。
 * 返すのは拍の時刻（秒）。
 */
export function trackBeats(odf: Float32Array, frameRate: number, bpm: number, tightness = 100): number[] {
  const n = odf.length;
  if (n === 0 || bpm <= 0) return [];
  const P = (60 * frameRate) / bpm;
  // 標準偏差でそろえ、拍の幅のガウス窓でならす
  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i];
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (odf[i] - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const w = Math.max(1, Math.round(P / 2));
  const kern: number[] = [];
  for (let t = -w; t <= w; t++) kern.push(Math.exp(-0.5 * ((t * 32) / P) ** 2));
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < kern.length; k++) {
      const j = i + k - w;
      if (j >= 0 && j < n) s += (odf[j] / sd) * kern[k];
    }
    local[i] = s;
  }
  const lo = Math.round(-2 * P);
  const hi = Math.round(-P / 2);
  const txwt = new Float32Array(hi - lo + 1);
  for (let j = lo; j <= hi; j++) txwt[j - lo] = -tightness * Math.log(-j / P) ** 2;
  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bi = -1;
    for (let j = lo; j <= hi; j++) {
      const k = i + j;
      if (k < 0) continue;
      const v = cum[k] + txwt[j - lo];
      if (v > best) {
        best = v;
        bi = k;
      }
    }
    cum[i] = local[i] + (bi >= 0 ? best : 0);
    back[i] = bi;
  }
  // 終わりの1拍ぶんの中で一番よい所から逆にたどる
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.ceil(P)); i < n; i++) {
    if (cum[i] > bestEnd) {
      bestEnd = cum[i];
      end = i;
    }
  }
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  // 曲の前後の、音が弱い所の拍は落とす
  let avg = 0;
  for (const b of beats) avg += local[b];
  avg /= beats.length || 1;
  let a = 0;
  let z = beats.length;
  while (a < z && local[beats[a]] < avg * 0.4) a++;
  while (z > a && local[beats[z - 1]] < avg * 0.4) z--;
  return beats.slice(a, z).map((i) => i / frameRate);
}

// ---- まとめ ---------------------------------------------------------------------

/** 原曲を解析する（ワーカーで呼ぶ）。channels は元のサンプリング周波数のまま */
export function analyzeAudio(channels: Float32Array[], sr: number, progress?: (p: number) => void): AnalysisData {
  const mono = downmix(channels);
  const peaks = computePeaks(mono, sr);
  progress?.(0.15);
  const x = resample(mono, sr, ANALYSIS_SR);
  progress?.(0.3);
  const raw = {} as Record<Band, Float32Array>;
  const odf = {} as Record<Band, Float32Array>;
  const env = {} as Record<Band, Float32Array>;
  BANDS.forEach((b, i) => {
    // 往復でかける（片道だとフィルタの分だけ遅れる。低域の帯ではキックが 5ms ほど遅れて見えた）
    const y = filtfilt(x, BAND_FILTERS[b](ANALYSIS_SR));
    const r = bandEnvelope(y, ANALYSIS_SR);
    raw[b] = r.odf;
    odf[b] = shiftEarlier(r.odf, ODF_LAG[b]);
    env[b] = r.env;
    progress?.(0.3 + 0.15 * (i + 1));
  });
  // BPM の候補は帯域をずらす前の立ち上がりの自己相関で（帯域の重なり方が変わると候補の出方が変わるため、今までどおりに）
  const acf = estimateTempo(combinedOdf(raw), FRAME_RATE);
  // 倍・半分のどれか、拍の位置、1 拍目は、曲全体の打点をドラムの形に合わせて決める（grid.ts）
  const start = musicStart(odf.low, FRAME_RATE);
  const bars = guessBars({ odf, frameRate: FRAME_RATE }, acf.map((c) => c.bpm), start);
  const tempo = orderTempo(acf, bars);
  progress?.(1);
  return {
    duration: mono.length / sr,
    peakRate: PEAK_RATE,
    peaks,
    frameRate: FRAME_RATE,
    odf,
    env,
    tempo,
    bars: tempo.map((c) => bars.find((g) => g.bpm === c.bpm)!),
    start,
  };
}

/**
 * BPM の候補を小節の形の点（guessBars）の順に並べ直す。いちばん上を「いちばん合う」、その半分・倍を「半分」「倍」にし、
 * それ以外（4 分の 1 など）は外す。点はいちばん上を 1 にそろえる
 */
export function orderTempo(tempo: readonly TempoCandidate[], bars: readonly BarGuess[]): TempoCandidate[] {
  const top = bars[0];
  if (!top) return [...tempo];
  const out: TempoCandidate[] = [];
  for (const g of bars) {
    const c = tempo.find((x) => x.bpm === g.bpm);
    if (!c) continue;
    const r = g.bpm / top.bpm;
    const kind = g === top ? 'best' : Math.abs(r - 0.5) < 0.02 ? 'half' : Math.abs(r - 2) < 0.04 ? 'double' : null;
    if (!kind) continue;
    out.push({ bpm: c.bpm, score: top.score > 0 ? Math.max(0, Math.min(1, g.score / top.score)) : c.score, kind, phase: g.beat });
  }
  return out;
}
