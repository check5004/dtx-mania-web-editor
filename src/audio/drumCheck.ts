// 曲の音にドラムが入っているかを、同じ曲のステム（ドラムとほかの楽器）と比べて見る（画面や状態を持たない）。
// 名前ではわからないとき（前の版でドラム抜きを原曲の名前のまま書き出した・ドラム抜きを完全な原曲として覚えた・
// ドラム抜きから試聴を作った など）に使う。ステムが無ければわからない。
// - 10 ms ごとの音の強さ（差分で高い音を強める。ドラムの打音が目立つ）を、曲の音 ≈ a × ドラム + b × ほかの楽器 として
//   最小二乗で解く（a・b は 0 以上）。a が b に比べて小さければドラム抜き
// - 曲の音がステムのどこにあたるか（頭のずれ・試聴の切り出し位置）は、強さの並びがいちばん合う所を探す

export interface AudioLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(c: number): Float32Array;
}

/** 強さを測る間隔と長さ（秒） */
export const ENV_HOP = 0.01;
/** 合っているとみなす当てはまり（1 − 残り ÷ 平均からのばらつき）。これより悪ければ別の音・別の所（わからない） */
const MIN_FIT = 0.5;
/** 曲の音の強さのうち、ドラムで説明できる割合がこれより小さければドラム抜き（ドラム入りの曲はふつう 9 割以上、ドラム抜きは 0 に近い） */
const DRUM_SHARE = 0.3;

/**
 * 音を足してモノラルにした、ENV_HOP ごとの強さ（隣り合う 2 区切りの差分の二乗和）。at：その音の 0 秒が、並べる時刻の何秒か。
 * 速くするため 32 kHz 以上の音は 1 つおきのサンプルで測る
 */
export function envelope(parts: readonly { buf: AudioLike; at: number }[], duration: number): Float32Array {
  const sr = parts[0]?.buf.sampleRate ?? 44100;
  const step = sr >= 32000 ? 2 : 1;
  const rate = sr / step;
  const hop = Math.max(1, Math.round(ENV_HOP * rate));
  const total = Math.max(0, Math.floor(duration * rate));
  const blocks = Math.ceil(total / hop);
  const e = new Float64Array(blocks + 1);
  const src = parts.map((p) => {
    const ch = Math.min(2, p.buf.numberOfChannels);
    return { data: Array.from({ length: ch }, (_, c) => p.buf.getChannelData(c)), ch, at: Math.round(p.at * rate), r: p.buf.sampleRate / rate };
  });
  let prev = 0;
  for (let i = 0; i < total; i++) {
    let s = 0;
    for (const p of src) {
      const j = Math.floor((i - p.at) * p.r);
      if (j < 0 || j >= p.data[0].length) continue;
      let v = 0;
      for (let c = 0; c < p.ch; c++) v += p.data[c][j];
      s += v / p.ch;
    }
    const y = s - 0.95 * prev;
    prev = s;
    e[Math.floor(i / hop)] += y * y;
  }
  const out = new Float32Array(Math.max(0, blocks - 1));
  for (let k = 0; k < out.length; k++) out[k] = e[k] + e[k + 1];
  return out;
}

export interface DrumShare {
  /** ドラムの強さの係数 */
  a: number;
  /** ほかの楽器の強さの係数 */
  b: number;
  /** 当てはまり（1 − 残り ÷ 平均からのばらつき） */
  fit: number;
  /** 曲の音の頭が、ステムの並びの何フレーム目か */
  lag: number;
  /** 曲の音の強さのうち、ドラムで説明できる割合（a × ドラムの強さ ÷ (a × ドラム + b × ほかの楽器)） */
  share: number;
}

/** c[i] ≈ a·d[i+lag] + b·n[i+lag]（a・b は 0 以上）を lag ごとに解き、いちばん当てはまる所 */
export function drumShare(c: Float32Array, d: Float32Array, n: Float32Array, lagFrom: number, lagTo: number): DrumShare | null {
  let best: DrumShare | null = null;
  for (let lag = lagFrom; lag <= lagTo; lag++) {
    let dd = 0, nn = 0, dn = 0, cd = 0, cn = 0, cc = 0, sc = 0, sd = 0, sn = 0, m = 0;
    const i0 = Math.max(0, -lag);
    const i1 = Math.min(c.length, d.length - lag, n.length - lag);
    for (let i = i0; i < i1; i++) {
      const x = d[i + lag];
      const y = n[i + lag];
      const z = c[i];
      dd += x * x;
      nn += y * y;
      dn += x * y;
      cd += z * x;
      cn += z * y;
      cc += z * z;
      sc += z;
      sd += x;
      sn += y;
      m++;
    }
    if (m < 50 || cc <= 0 || nn <= 0 || dd <= 0) continue;
    const det = dd * nn - dn * dn;
    let a = det > 0 ? (cd * nn - cn * dn) / det : 0;
    let b = det > 0 ? (cn * dd - cd * dn) / det : cn / nn;
    if (a < 0) {
      a = 0;
      b = Math.max(0, cn / nn);
    } else if (b < 0) {
      b = 0;
      a = Math.max(0, cd / dd);
    }
    const res = cc - 2 * (a * cd + b * cn) + a * a * dd + 2 * a * b * dn + b * b * nn;
    // 当てはまりは、平均からのばらつきに対して（強さの平均だけ合わせても、合ったことにしない）
    const tot = cc - (sc * sc) / m;
    if (tot <= 0) continue;
    const fit = 1 - res / tot;
    const share = a * sd + b * sn > 0 ? (a * sd) / (a * sd + b * sn) : 0;
    if (!best || fit > best.fit) best = { a, b, fit, lag, share };
  }
  return best;
}

/** 並びを k 個ずつ足して粗くする */
function coarse(x: Float32Array, k: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / k));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += x[i * k + j];
    out[i] = s;
  }
  return out;
}

/** c が s のどこにあたるか（粗い並びで、平均を引いた相関の高い順に count 個の lag） */
function alignCandidates(c: Float32Array, s: Float32Array, count: number): number[] {
  const mean = (x: Float32Array) => x.reduce((a, v) => a + v, 0) / Math.max(1, x.length);
  const mc = mean(c);
  const cz = c.map((v) => v - mc);
  const cn = Math.sqrt(cz.reduce((a, v) => a + v * v, 0)) || 1;
  const scores: { lag: number; r: number }[] = [];
  for (let lag = 0; lag + c.length <= s.length; lag++) {
    let sum = 0, sum2 = 0, dot = 0;
    for (let i = 0; i < c.length; i++) {
      const v = s[lag + i];
      sum += v;
      sum2 += v * v;
      dot += cz[i] * v;
    }
    const varS = sum2 - (sum * sum) / c.length;
    scores.push({ lag, r: varS > 0 ? dot / (cn * Math.sqrt(varS)) : 0 });
  }
  scores.sort((x, y) => y.r - x.r);
  const out: number[] = [];
  for (const x of scores) {
    if (out.every((l) => Math.abs(l - x.lag) > 4)) out.push(x.lag);
    if (out.length >= count) break;
  }
  return out;
}

export interface DrumVerdict extends DrumShare {
  /** ドラムが入っている */
  drums: boolean;
}

/**
 * 曲の音の強さ c が、ドラム d・ほかの楽器 n の強さ（同じ曲の頭からの並び）と比べてドラム入りか。合わなければ null（別の音・わからない）。
 * near：c の頭がどこか分かっているとき（そのフレームの前後 near.span フレームだけ探す）。無ければ曲全体から探す（試聴の切り出しなど）
 */
export function judgeDrums(c: Float32Array, d: Float32Array, n: Float32Array, near?: { lag: number; span: number }): DrumVerdict | null {
  if (c.length < 100 || d.length < 100) return null;
  let r: DrumShare | null = null;
  if (near) {
    r = drumShare(c, d, n, near.lag - near.span, near.lag + near.span);
  } else {
    if (c.length > d.length) return null;
    const K = 5;
    const s = new Float32Array(d.length);
    for (let i = 0; i < s.length; i++) s[i] = d[i] + n[i];
    // ドラム入りならステム全部の強さと、ドラム抜きならほかの楽器の強さとよく合う。両方の候補を最小二乗で比べる
    const cc = coarse(c, K);
    for (const lag of [...alignCandidates(cc, coarse(s, K), 3), ...alignCandidates(cc, coarse(n, K), 3)]) {
      const x = drumShare(c, d, n, lag * K - K, lag * K + K);
      if (x && (!r || x.fit > r.fit)) r = x;
    }
  }
  if (!r || r.fit < MIN_FIT) return null;
  return { ...r, drums: r.share >= DRUM_SHARE };
}
