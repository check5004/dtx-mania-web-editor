// サビを探す（曲情報の「サビから試聴を作る」）。
// 1. 小節線を音の打点に合わせる（gridOffset。小節を 4 等分した所の立ち上がりがいちばん強くなるずらし、±80ms まで）。
//    譜面の小節線や、テンポ推定の 1 小節目の頭は数 ms〜数十 ms ずれることがあり、ずれたままだと小節の特徴が揺れて答えが変わる。
// 2. 小節ごとに聞こえ方をまとめる：拍ごとの和音（クロマ）と音色（帯域ごとの音量）、ドラムの形（16 分ごとの低・中・高の立ち上がり）。
//    フレームは小節に重なっている割合で数える（小節線が少しずれても特徴が少ししか変わらない）。features.ts の特徴から。
// 3. 小節どうしの近さから曲を部分に分け、同じに聞こえる部分に同じ印を付ける
//    （McFee & Ellis 2014「Analyzing song structure with spectral clustering」を小節の単位で。繰り返しのつながりと隣の小節のつながりを
//    合わせたグラフのラプラシアンの固有ベクトルを k-means で分ける）。つながりの濃さ（3 通り）と印の数（4〜8）を変えて最大 15 回分ける。
// 4. 分け方ごとに、印の点「盛り上がり（1.3〜5 kHz の明るさと音量）・繰り返しの数・1 回の長さ、前奏・後奏だけの印は下げる」で
//    いちばんの印を選ぶ。いちばんの印の小節を、ほかの分け方とよく重なる分け方どうしで多数決し、半分より多くがサビにした所をサビの所にする。
//    前奏の後の最初の所がサビ。1 回の分け方で決めると、小節線が数 ms ずれただけで別の部分（Aメロ・間奏）を選ぶことがあった。
// 5. 始まりは、分け目の 1 小節前〜1 小節後で直す：小節の頭の叩かれ方・前の小節が曲の中で 1 回きり（サビの前のフィル・きっかけ）か・
//    サビのドラムの形がその小節から始まるか（分け目はサビの前のフィルの小節を含んで 1 小節早くなりやすい）。
// 作者が作った試聴（DTXMania の曲 6 曲の pre.ogg）の位置と、README のデモ曲で確かめた（7 曲とも小節までぴったり。小節線を ±60ms ずらしても同じ）。
// 小節は譜面の小節線（音に合っていれば）。合っていなければ音から拍を追って 4 拍ごとに区切る（estimateBars）。
// 画面の外（テスト・ワーカー）でも動くよう、DOM を使わない。
import { estimateTempo, trackBeats } from './analysis';
import type { FrameFeatures } from './features';

export type ChorusFeatures = Pick<FrameFeatures, 'rate' | 'frames' | 'offset' | 'chroma' | 'bands' | 'fluxRate' | 'fluxOffset' | 'fluxFrames' | 'flux'>;

export interface ChorusInput {
  feat: ChorusFeatures;
  /** 曲の音の長さ（秒） */
  duration: number;
  /** 小節の頭（曲の音の秒、昇順）。曲の音の外にはみ出す小節は使わない */
  bars: readonly number[];
}

export interface ChorusPart {
  /** 曲の音の秒 */
  start: number;
  end: number;
  /** 同じに聞こえる部分は同じ番号 */
  label: number;
  /** サビの所か */
  chorus: boolean;
}

export interface ChorusPick {
  /** 曲の音の秒（bars の小節の頭。打点に合わせたずれは足さない） */
  start: number;
  end: number;
  /** bars の何番目の小節から始まるか */
  bar: number;
  score: number;
}

export interface ChorusResult {
  /** サビ（前奏の後の最初の所）。見つからなければ null */
  best: ChorusPick | null;
  /** 同じサビのほかの所（時刻の順） */
  repeats: ChorusPick[];
  /** ほかの候補（違う部分。よい順に最大 2 つ） */
  others: ChorusPick[];
  /** 曲の部分（色分けして見せる。サビの所は chorus） */
  parts: ChorusPart[];
}

/** 決めた値（6 曲とデモ曲で確かめた） */
export const CHORUS = {
  /** 印の数（分け方の細かさ） */
  ks: [4, 5, 6, 7, 8],
  /** つながりの濃さ：小節ごとに、互いに近い小節を n/16・n/12・n/9 個（n は小節の数。2 個より少なくしない） */
  neighborDivs: [16, 12, 9],
  neighborMin: 2,
  /** 盛り上がりの重み：明るさ（4 dB で 1）と音量（3 dB で 1） */
  bright: 1,
  loud: 0.5,
  /** 繰り返しの数（log2(1+回数)）と 1 回の長さ（16 小節で 1）の重み */
  repeat: 0.5,
  length: 0.6,
  /** 前奏から出てくる印・前奏と後奏にしか無い印を下げる */
  intro: 0.8,
  edge: 1,
  /** 前奏とみなす長さ（秒。曲の 10% より短ければ 10%） */
  introSec: 20,
  /** 小節線を打点に合わせるとき、探すずれの幅（秒） */
  gridSearch: 0.08,
  /** 始まりを直すときの重み：頭の叩かれ方（log2 の比）・前の小節が 1 回きりか・サビのドラムの形が始まるか・元の分け目から 1 小節離れるごとに引く値 */
  startAccent: 0.15,
  startUnique: 1,
  startGroove: 3,
  startShift: 0.05,
  /** サビのほかの所の頭を 1 回目に合わせるとき、探す幅（小節）と、動かすのに要る良さ（距離の平均の比） */
  alignBars: 4,
  alignGain: 0.7,
  /** これより近い（小節）サビの所は、同じかたまり（ほかの所に挙げない） */
  sameBlock: 12,
  /** 譜面の拍が、音から追った拍にこれだけ乗っていれば、譜面の小節線を使う（6 曲で 0.62〜0.99、ずらした線は 0.36 まで） */
  gridOk: 0.5,
} as const;

// ---- 小節ごとの特徴 -------------------------------------------------------------------

interface BarFeat {
  n: number;
  /** 使った小節の bars での番号 */
  index: Int32Array;
  t0: Float64Array;
  t1: Float64Array;
  /** n × D（和音と音色を合わせ、長さ 1） */
  x: Float64Array;
  d: number;
  /** 曲の中ほど（中央値）からの dB */
  loud: Float64Array;
  bright: Float64Array;
  /** 小節の頭の叩かれ方（高い帯域と低い帯域の立ち上がり。中央値との比の log2 の和） */
  accent: Float64Array;
  /** n × RD：ドラムの形（16 分の 16 か所 × 低・中・高の帯域の立ち上がり。長さ 1） */
  rhythm: Float64Array;
}

/** 1 小節の和音を見る区切り（拍ごと） */
const SLOTS = 4;
/** 小節の頭の叩かれ方を見る幅（秒、前後に三角の重み） */
const ACCENT_WIN = 0.08;
/** ドラムの形：16 分の数と、打点の帯域（features.ts の FLUX_EDGES の番号）。低（キック・ベース）・中（スネア・タム）・高（ハイハット・シンバル） */
const RSTEPS = 16;
const RGROUPS: readonly [number, number][] = [
  [0, 1],
  [2, 4],
  [6, 7],
];
const RD = RSTEPS * RGROUPS.length;
/** ドラムの形で 16 分の打点を見る幅（秒、前後に三角の重み） */
const RHYTHM_WIN = 0.03;

function median(a: ArrayLike<number>): number {
  const s = Array.from(a).sort((x, y) => x - y);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function barFeatures(inp: ChorusInput): BarFeat {
  const f = inp.feat;
  const NB = Math.round(f.bands.length / Math.max(1, f.frames));
  const NF = Math.round(f.flux.length / Math.max(1, f.fluxFrames));
  const HI0 = Math.round(NB * 0.7);
  let cmax = 0;
  for (let i = 0; i < f.chroma.length; i++) if (f.chroma[i] > cmax) cmax = f.chroma[i];
  cmax ||= 1;
  const frameAt = (sec: number) => sec * f.rate - f.offset;
  const idx: number[] = [];
  for (let i = 0; i + 1 < inp.bars.length; i++) if (inp.bars[i] >= 0 && inp.bars[i + 1] <= inp.duration && inp.bars[i + 1] > inp.bars[i]) idx.push(i);
  const n = idx.length;
  const C = new Float64Array(n * SLOTS * 12);
  const T = new Float64Array(n * NB);
  const loud = new Float64Array(n);
  const bright = new Float64Array(n);
  const ahi = new Float64Array(n);
  const alo = new Float64Array(n);
  const t0 = new Float64Array(n);
  const t1 = new Float64Array(n);
  // 区間 [a, b) に重なっているフレームと、重なっている割合（フレームは中心の前後 1/2 フレーム）
  const span = (a: number, b: number): [number, number, Float64Array] => {
    const fa = frameAt(a);
    const fb = frameAt(b);
    const lo = Math.max(0, Math.floor(fa - 0.5));
    const hi = Math.min(f.frames - 1, Math.ceil(fb + 0.5));
    const w = new Float64Array(Math.max(0, hi - lo + 1));
    for (let k = lo; k <= hi; k++) w[k - lo] = Math.max(0, Math.min(k + 0.5, fb) - Math.max(k - 0.5, fa));
    return [lo, hi, w];
  };
  // 時刻 t の前後 r 秒（三角の重み）で、帯域 b0〜b1 の立ち上がりの和のいちばん大きい所
  const onset = (t: number, b0: number, b1: number, r0: number) => {
    const c = t * f.fluxRate - f.fluxOffset;
    const r = r0 * f.fluxRate;
    let m = 0;
    for (let k = Math.max(0, Math.floor(c - r)); k <= Math.min(f.fluxFrames - 1, Math.ceil(c + r)); k++) {
      const w = 1 - Math.abs(k - c) / r;
      if (w <= 0) continue;
      let s = 0;
      for (let b = b0; b <= b1; b++) s += f.flux[k * NF + b];
      if (s * w > m) m = s * w;
    }
    return m;
  };
  for (let u = 0; u < n; u++) {
    const a = inp.bars[idx[u]];
    const b = inp.bars[idx[u] + 1];
    t0[u] = a;
    t1[u] = b;
    for (let q = 0; q < SLOTS; q++) {
      const [lo, hi, w] = span(a + ((b - a) * q) / SLOTS, a + ((b - a) * (q + 1)) / SLOTS);
      const o = (u * SLOTS + q) * 12;
      let s = 0;
      for (let c = 0; c < 12; c++) {
        let v = 0;
        for (let k = lo; k <= hi; k++) v += w[k - lo] * f.chroma[k * 12 + c];
        v = Math.log1p((100 * v) / cmax);
        C[o + c] = v;
        s += v * v;
      }
      s = Math.sqrt(s) + 1e-9;
      for (let c = 0; c < 12; c++) C[o + c] /= s;
    }
    const [lo, hi, w] = span(a, b);
    let pw = 0;
    let ph = 0;
    let cnt = 0;
    for (let k = lo; k <= hi; k++) {
      const wk = w[k - lo];
      if (wk <= 0) continue;
      cnt += wk;
      for (let c = 0; c < NB; c++) {
        const v = f.bands[k * NB + c];
        T[u * NB + c] += wk * v;
        const p = wk * 10 ** (v / 10);
        pw += p;
        if (c >= HI0) ph += p;
      }
    }
    cnt ||= 1;
    for (let c = 0; c < NB; c++) T[u * NB + c] /= cnt;
    loud[u] = 10 * Math.log10(pw / (cnt * NB) + 1e-12);
    bright[u] = 10 * Math.log10(ph / (cnt * (NB - HI0)) + 1e-12);
    if (NF >= 8) {
      ahi[u] = onset(a, NF - 2, NF - 1, ACCENT_WIN);
      alo[u] = onset(a, 0, 1, ACCENT_WIN);
    }
  }
  // 和音：曲全体の平均を引いて長さ 1。音色：帯域ごとに平均 0・ばらつき 1 にして長さ 1。合わせて長さ 1
  const DC = SLOTS * 12;
  const D = DC + NB;
  const x = new Float64Array(n * D);
  const mc = new Float64Array(DC);
  for (let u = 0; u < n; u++) for (let k = 0; k < DC; k++) mc[k] += C[u * DC + k] / n;
  const mt = new Float64Array(NB);
  const sd = new Float64Array(NB);
  for (let u = 0; u < n; u++) for (let k = 0; k < NB; k++) mt[k] += T[u * NB + k] / n;
  for (let u = 0; u < n; u++) for (let k = 0; k < NB; k++) sd[k] += (T[u * NB + k] - mt[k]) ** 2 / n;
  for (let k = 0; k < NB; k++) sd[k] = Math.sqrt(sd[k]) + 1e-9;
  for (let u = 0; u < n; u++) {
    let s = 0;
    for (let k = 0; k < DC; k++) s += (C[u * DC + k] - mc[k]) ** 2;
    s = Math.sqrt(s) + 1e-9;
    for (let k = 0; k < DC; k++) x[u * D + k] = (C[u * DC + k] - mc[k]) / s / Math.SQRT2;
    s = 0;
    for (let k = 0; k < NB; k++) s += ((T[u * NB + k] - mt[k]) / sd[k]) ** 2;
    s = Math.sqrt(s) + 1e-9;
    for (let k = 0; k < NB; k++) x[u * D + DC + k] = (T[u * NB + k] - mt[k]) / sd[k] / s / Math.SQRT2;
  }
  const ml = median(loud);
  const mb = median(bright);
  const mh = median(ahi) + 1e-9;
  const mlo = median(alo) + 1e-9;
  const accent = new Float64Array(n);
  for (let u = 0; u < n; u++) {
    loud[u] -= ml;
    bright[u] -= mb;
    accent[u] = Math.log2(Math.max(1e-3, (ahi[u] / mh) * (alo[u] / mlo)));
  }
  // ドラムの形：16 分ごとの低・中・高の立ち上がりを、帯域ごとの曲全体の平均で割って log1p、小節ごとに長さ 1
  const rhythm = new Float64Array(n * RD);
  if (NF >= 8) {
    const gm = RGROUPS.map(() => 0);
    for (let u = 0; u < n; u++) {
      for (let q = 0; q < RSTEPS; q++) {
        const t = t0[u] + ((t1[u] - t0[u]) * q) / RSTEPS;
        RGROUPS.forEach(([b0, b1], g) => {
          const v = onset(t, b0, b1, RHYTHM_WIN);
          rhythm[u * RD + g * RSTEPS + q] = v;
          gm[g] += v / (n * RSTEPS);
        });
      }
    }
    for (let u = 0; u < n; u++) {
      let s = 0;
      for (let g = 0; g < RGROUPS.length; g++) {
        for (let q = 0; q < RSTEPS; q++) {
          const o = u * RD + g * RSTEPS + q;
          rhythm[o] = Math.log1p(rhythm[o] / (gm[g] + 1e-12));
          s += rhythm[o] * rhythm[o];
        }
      }
      s = Math.sqrt(s) + 1e-9;
      for (let k = 0; k < RD; k++) rhythm[u * RD + k] /= s;
    }
  }
  return { n, index: Int32Array.from(idx), t0, t1, x, d: D, loud, bright, accent, rhythm };
}

// ---- 固有値（対称行列。JAMA の tred2・tql2 と同じ手順） ------------------------------------

/** 対称行列 a（n×n、行の順）の固有値（小さい順）と固有ベクトル（v の列） */
export function symEig(a: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
  const V = Float64Array.from(a);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  const at = (i: number, j: number) => i * n + j;
  // tred2：ハウスホルダー変換で三重対角に
  for (let j = 0; j < n; j++) d[j] = V[at(n - 1, j)];
  for (let i = n - 1; i > 0; i--) {
    let scale = 0;
    let h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]);
    if (scale === 0) {
      e[i] = d[i - 1];
      for (let j = 0; j < i; j++) {
        d[j] = V[at(i - 1, j)];
        V[at(i, j)] = 0;
        V[at(j, i)] = 0;
      }
    } else {
      for (let k = 0; k < i; k++) {
        d[k] /= scale;
        h += d[k] * d[k];
      }
      let f = d[i - 1];
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      for (let j = 0; j < i; j++) {
        f = d[j];
        V[at(j, i)] = f;
        g = e[j] + V[at(j, j)] * f;
        for (let k = j + 1; k <= i - 1; k++) {
          g += V[at(k, j)] * d[k];
          e[k] += V[at(k, j)] * f;
        }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) {
        e[j] /= h;
        f += e[j] * d[j];
      }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j] -= hh * d[j];
      for (let j = 0; j < i; j++) {
        f = d[j];
        g = e[j];
        for (let k = j; k <= i - 1; k++) V[at(k, j)] -= f * e[k] + g * d[k];
        d[j] = V[at(i - 1, j)];
        V[at(i, j)] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1; i++) {
    V[at(n - 1, i)] = V[at(i, i)];
    V[at(i, i)] = 1;
    const h = d[i + 1];
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = V[at(k, i + 1)] / h;
      for (let j = 0; j <= i; j++) {
        let g = 0;
        for (let k = 0; k <= i; k++) g += V[at(k, i + 1)] * V[at(k, j)];
        for (let k = 0; k <= i; k++) V[at(k, j)] -= g * d[k];
      }
    }
    for (let k = 0; k <= i; k++) V[at(k, i + 1)] = 0;
  }
  for (let j = 0; j < n; j++) {
    d[j] = V[at(n - 1, j)];
    V[at(n - 1, j)] = 0;
  }
  if (n > 0) V[at(n - 1, n - 1)] = 1;
  e[0] = 0;
  // tql2：三重対角の QL 法
  for (let i = 1; i < n; i++) e[i - 1] = e[i];
  if (n > 0) e[n - 1] = 0;
  let f = 0;
  let tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l++) {
    tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
    let m = l;
    while (m < n) {
      if (Math.abs(e[m]) <= eps * tst1) break;
      m++;
    }
    if (m > l) {
      let iter = 0;
      do {
        if (++iter > 60) break;
        let g = d[l];
        let p = (d[l + 1] - g) / (2 * e[l]);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l] / (p + r);
        d[l + 1] = e[l] * (p + r);
        const dl1 = d[l + 1];
        let h = g - d[l];
        for (let i = l + 2; i < n; i++) d[i] -= h;
        f += h;
        p = d[m];
        let c = 1;
        let c2 = c;
        let c3 = c;
        const el1 = e[l + 1];
        let s = 0;
        let s2 = 0;
        for (let i = m - 1; i >= l; i--) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i];
          h = c * p;
          r = Math.hypot(p, e[i]);
          e[i + 1] = s * r;
          s = e[i] / r;
          c = p / r;
          p = c * d[i] - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]);
          for (let k = 0; k < n; k++) {
            h = V[at(k, i + 1)];
            V[at(k, i + 1)] = s * V[at(k, i)] + c * h;
            V[at(k, i)] = c * V[at(k, i)] - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]) > eps * tst1);
    }
    d[l] += f;
    e[l] = 0;
  }
  // 小さい順に並べる
  for (let i = 0; i < n - 1; i++) {
    let k = i;
    let p = d[i];
    for (let j = i + 1; j < n; j++) {
      if (d[j] < p) {
        k = j;
        p = d[j];
      }
    }
    if (k !== i) {
      d[k] = d[i];
      d[i] = p;
      for (let j = 0; j < n; j++) {
        const t = V[at(j, i)];
        V[at(j, i)] = V[at(j, k)];
        V[at(j, k)] = t;
      }
    }
  }
  return { values: d, vectors: V };
}

// ---- 部分に分ける ---------------------------------------------------------------------

/** 繰り返しの線を残す斜めの中央値の幅（前後の小節数） */
const DIAG_MED = 2;
/** 固有ベクトルを時間の向きにならす中央値の幅（前後の小節数） */
const VEC_MED = 2;

/** 繰り返しと隣のつながりのグラフのラプラシアンの固有ベクトル（小さい順、n×n の列）。kk はつながりの濃さ（互いに近い小節の数） */
function structureVectors(bf: BarFeat, kk: number): Float64Array {
  const { n, x, d: D } = bf;
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      for (let k = 0; k < D; k++) {
        const v = x[i * D + k] - x[j * D + k];
        s += v * v;
      }
      dist[i * n + j] = s;
      dist[j * n + i] = s;
    }
  }
  // 互いに近い kk 個に入る組（すぐ隣は除く）
  const nb = new Uint8Array(n * n);
  const order = Array.from({ length: n }, (_, j) => j);
  for (let i = 0; i < n; i++) {
    const row = i * n;
    order.sort((a, b) => dist[row + a] - dist[row + b] || a - b);
    let cnt = 0;
    for (const j of order) {
      if (Math.abs(i - j) < 2) continue;
      nb[row + j] = 1;
      if (++cnt >= kk) break;
    }
  }
  const rec = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) rec[i * n + j] = nb[i * n + j] && nb[j * n + i] ? 1 : 0;
  // 斜めに 5 つの中央値（繰り返しの線を残し、ぽつんとした点を消す）
  const pos: number[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && dist[i * n + j] > 0) pos.push(dist[i * n + j]);
  const sig = median(pos) || 1;
  const R = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let ones = 0;
      let len = 0;
      for (let q = -DIAG_MED; q <= DIAG_MED; q++) {
        const a = i + q;
        const b = j + q;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        len++;
        ones += rec[a * n + b];
      }
      const med = ones * 2 > len ? 1 : ones * 2 === len ? 0.5 : 0;
      R[i * n + j] = med * Math.exp(-dist[i * n + j] / sig);
    }
  }
  // 隣の小節のつながり
  const dp: number[] = [];
  for (let i = 0; i + 1 < n; i++) dp.push(dist[i * n + i + 1]);
  const sp = median(dp) || 1;
  const degR = new Float64Array(n);
  const degP = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) degR[i] += R[i * n + j];
  for (let i = 0; i + 1 < n; i++) {
    const w = Math.exp(-dp[i] / sp);
    degP[i] += w;
    degP[i + 1] += w;
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += degP[i] * (degP[i] + degR[i]);
    den += (degP[i] + degR[i]) ** 2;
  }
  const mu = den > 0 ? num / den : 0.5;
  const A = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) A[i] = mu * R[i];
  for (let i = 0; i + 1 < n; i++) {
    const w = (1 - mu) * Math.exp(-dp[i] / sp);
    A[i * n + i + 1] += w;
    A[(i + 1) * n + i] += w;
  }
  const deg = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) deg[i] += A[i * n + j];
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const di = 1 / Math.sqrt(deg[i] + 1e-9);
    for (let j = 0; j < n; j++) L[i * n + j] = (i === j ? 1 : 0) - (di * A[i * n + j]) / Math.sqrt(deg[j] + 1e-9);
  }
  // 丸めの差で非対称にならないように
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) L[i * n + j] = L[j * n + i] = (L[i * n + j] + L[j * n + i]) / 2;
  return symEig(L, n).vectors;
}

/** k-means（いちばん遠い点を順に初めの中心にする。毎回同じ答え） */
function kmeans(X: Float64Array, n: number, d: number, k: number, iters = 50): Int32Array {
  const centers: number[] = [0];
  const near = new Float64Array(n).fill(Infinity);
  const dist2 = (i: number, c: Float64Array | number[], o: number) => {
    let s = 0;
    for (let q = 0; q < d; q++) s += (X[i * d + q] - c[o + q]) ** 2;
    return s;
  };
  while (centers.length < k) {
    const last = centers[centers.length - 1];
    let best = 0;
    for (let i = 0; i < n; i++) {
      near[i] = Math.min(near[i], dist2(i, X, last * d));
      if (near[i] > near[best]) best = i;
    }
    centers.push(best);
  }
  const C = new Float64Array(k * d);
  centers.forEach((c, j) => C.set(X.subarray(c * d, c * d + d), j * d));
  const lab = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let b = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const v = dist2(i, C, j * d);
        if (v < bd) {
          bd = v;
          b = j;
        }
      }
      lab[i] = b;
    }
    for (let j = 0; j < k; j++) {
      let cnt = 0;
      const s = new Float64Array(d);
      for (let i = 0; i < n; i++) {
        if (lab[i] !== j) continue;
        cnt++;
        for (let q = 0; q < d; q++) s[q] += X[i * d + q];
      }
      if (cnt) for (let q = 0; q < d; q++) C[j * d + q] = s[q] / cnt;
    }
  }
  return lab;
}

/** 印の数 K で小節に印を付ける */
function labelBars(V: Float64Array, n: number, K: number): Int32Array {
  // 固有ベクトルを時間の向きに 5 小節の中央値でならし、行の長さで割る
  const X = new Float64Array(n * K);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < K; c++) {
      const w: number[] = [];
      for (let q = Math.max(0, i - VEC_MED); q <= Math.min(n - 1, i + VEC_MED); q++) w.push(V[q * n + c]);
      const v = median(w);
      X[i * K + c] = v;
      s += v * v;
    }
    s = Math.sqrt(s) + 1e-9;
    for (let c = 0; c < K; c++) X[i * K + c] /= s;
  }
  return kmeans(X, n, K, K);
}

interface Seg {
  a: number;
  b: number;
  label: number;
}

function segments(lab: Int32Array): Seg[] {
  const out: Seg[] = [];
  let s = 0;
  for (let i = 1; i <= lab.length; i++) {
    if (i === lab.length || lab[i] !== lab[s]) {
      out.push({ a: s, b: i, label: lab[s] });
      s = i;
    }
  }
  return out;
}

interface LabelScore {
  label: number;
  score: number;
  segs: Seg[];
}

/** 小節ごとの盛り上がり（明るさと音量） */
function barEnergy(bf: BarFeat): Float64Array {
  const energy = new Float64Array(bf.n);
  const clip = (v: number) => Math.max(-1.5, Math.min(1.5, v));
  for (let i = 0; i < bf.n; i++) energy[i] = CHORUS.bright * clip(bf.bright[i] / 4) + CHORUS.loud * clip(bf.loud[i] / 3);
  return energy;
}

/** 印ごとのサビらしさ（よい順。4 小節より短い所は数えない） */
function scoreLabels(bf: BarFeat, segs: Seg[], duration: number): LabelScore[] {
  const { n } = bf;
  const energy = barEnergy(bf);
  // 音の出ている最初の小節
  let first = 0;
  while (first < n && bf.loud[first] <= -10) first++;
  const by = new Map<number, Seg[]>();
  for (const s of segs) {
    if (s.b - s.a < 4) continue;
    let g = by.get(s.label);
    if (!g) by.set(s.label, (g = []));
    g.push(s);
  }
  const out: LabelScore[] = [];
  for (const [label, ss] of by) {
    let en = 0;
    let cnt = 0;
    for (const s of ss) {
      for (let i = s.a; i < s.b; i++) en += energy[i];
      cnt += s.b - s.a;
    }
    en /= cnt;
    const meanLen = cnt / ss.length;
    const intro = ss[0].a <= first + 2 || bf.t0[ss[0].a] < CHORUS.introSec;
    const edge = ss.every((s) => bf.t0[s.a] < 0.12 * duration || bf.t0[s.a] > 0.85 * duration);
    const score = en + CHORUS.repeat * Math.log2(1 + ss.length) + (CHORUS.length * Math.min(meanLen, 16)) / 16 - (intro ? CHORUS.intro : 0) - (edge ? CHORUS.edge : 0);
    out.push({ label, score, segs: ss });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 前奏の後の最初の所（無ければ最初） */
function firstAfterIntro(bf: BarFeat, segs: Seg[], duration: number): Seg {
  const from = Math.max(CHORUS.introSec, 0.1 * duration);
  return segs.find((s) => bf.t0[s.a] >= from) ?? segs[0];
}

/** 1 回分の分け方 */
interface Run {
  /** 印の数 */
  K: number;
  segs: Seg[];
  /** 印ごとの点（よい順） */
  scores: LabelScore[];
}

/** つながりの濃さ（CHORUS.neighborDivs）と印の数（CHORUS.ks）を変えて分ける */
function partitions(bf: BarFeat, duration: number): Run[] {
  const { n } = bf;
  const runs: Run[] = [];
  const kks = [...new Set(CHORUS.neighborDivs.map((d) => Math.max(CHORUS.neighborMin, Math.round(n / d))))];
  for (const kk of kks) {
    const V = structureVectors(bf, kk);
    for (const K of CHORUS.ks) {
      if (K >= n / 2) continue;
      const segs = segments(labelBars(V, n, K));
      const scores = scoreLabels(bf, segs, duration);
      if (scores.length) runs.push({ K, segs, scores });
    }
  }
  return runs;
}

/**
 * 小節ごとに、いちばんの印に入れた分け方の割合（0〜1）。ほかの分け方といちばん重なる分け方（真ん中）と、
 * 半分以上重なる分け方だけで数える（違う部分をいちばんにした分け方は、数えるとサビの所をぼかすだけなので数えない）
 */
function consensus(runs: Run[], n: number): Float64Array {
  const sets = runs.map((r) => {
    const m = new Uint8Array(n);
    for (const s of r.scores[0].segs) for (let i = s.a; i < s.b; i++) m[i] = 1;
    return m;
  });
  const iou = (a: Uint8Array, b: Uint8Array) => {
    let both = 0;
    let any = 0;
    for (let i = 0; i < n; i++) {
      both += a[i] & b[i];
      any += a[i] | b[i];
    }
    return any ? both / any : 0;
  };
  let mid = 0;
  let midSum = -1;
  for (let i = 0; i < sets.length; i++) {
    let s = 0;
    for (let j = 0; j < sets.length; j++) s += iou(sets[i], sets[j]);
    if (s > midSum + 1e-9) {
      midSum = s;
      mid = i;
    }
  }
  const group = sets.filter((s) => iou(s, sets[mid]) >= 0.5);
  const member = new Float64Array(n);
  for (const s of group) for (let u = 0; u < n; u++) member[u] += s[u] / group.length;
  return member;
}

/** サビの所：半分より多くの分け方がいちばんの印に入れた小節のつながり（2 小節以上） */
function chorusSegs(member: Float64Array): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < member.length; ) {
    if (member[i] <= 0.5) {
      i++;
      continue;
    }
    let j = i;
    while (j < member.length && member[j] > 0.5) j++;
    if (j - i >= 2) out.push({ a: i, b: j, label: 0 });
    i = j;
  }
  return out;
}

/** サビのドラムの形（サビの所の、最初と最後を除いた小節の、次元ごとの中央値。長さ 1） */
function grooveOf(bf: BarFeat, occ: Seg[]): Float64Array {
  const cols: number[][] = Array.from({ length: RD }, () => []);
  for (const o of occ) for (let u = o.a + 1; u < o.b - 1; u++) for (let k = 0; k < RD; k++) cols[k].push(bf.rhythm[u * RD + k]);
  const g = new Float64Array(RD);
  let s = 0;
  for (let k = 0; k < RD; k++) {
    g[k] = median(cols[k]);
    s += g[k] * g[k];
  }
  s = Math.sqrt(s) + 1e-9;
  for (let k = 0; k < RD; k++) g[k] /= s;
  return g;
}

/** 小節 u と、ほかの所（4 小節以上離れた所）でいちばん似た小節との遠さ（距離の 2 乗、1 まで）。フィル・きっかけの小節は曲の中で 1 回きりなので遠い */
function uniqueness(bf: BarFeat, u: number): number {
  const { n, x, d: D } = bf;
  let m = Infinity;
  for (let v = 0; v < n; v++) {
    if (Math.abs(v - u) < 4) continue;
    let s = 0;
    for (let k = 0; k < D; k++) s += (x[u * D + k] - x[v * D + k]) ** 2;
    if (s < m) m = s;
  }
  return Math.min(1, m);
}

/**
 * サビの頭を、分け目 s0 の 1 小節前〜1 小節後で直す：頭の叩かれ方・前の小節が 1 回きりか・サビのドラムの形がその小節から始まるか。
 * 曲の最初の小節の前は、1 回きりでドラムの形も無いとみなす
 */
function refineStart(bf: BarFeat, groove: Float64Array, s0: number): number {
  const { n } = bf;
  const fit = (u: number) => {
    if (u < 0) return 0;
    let v = 0;
    for (let k = 0; k < RD; k++) v += bf.rhythm[u * RD + k] * groove[k];
    return v;
  };
  const uniq = (u: number) => (u < 0 ? 1 : uniqueness(bf, u));
  let best = s0;
  let bv = -Infinity;
  for (let s = Math.max(0, s0 - 1); s <= Math.min(n - 1, s0 + 1); s++) {
    const v = CHORUS.startAccent * bf.accent[s] + CHORUS.startUnique * (uniq(s - 1) - uniq(s)) + CHORUS.startGroove * (fit(s) - fit(s - 1)) - CHORUS.startShift * Math.abs(s - s0);
    if (v > bv) {
      bv = v;
      best = s;
    }
  }
  return best;
}

/**
 * サビのほかの所の頭 s1 を、1 回目のサビ（小節 first から len 小節。8 小節まで見る）と小節ごとにいちばんよく並ぶ所に合わせる
 * （前後 CHORUS.alignBars 小節）。並び方がはっきり良いとき（距離の平均が CHORUS.alignGain 倍より小さい）だけ動かす。
 * 分け目が前の部分（間奏・Cメロ）の終わりを含んで、2〜3 小節ずれることがある
 */
function alignRepeat(bf: BarFeat, first: number, len: number, s1: number): number {
  const { n, x, d: D } = bf;
  const L = Math.max(4, Math.min(8, len));
  const dist = (s: number) => {
    let t = 0;
    let c = 0;
    for (let j = 0; j < L && s + j < n && first + j < n; j++) {
      let v = 0;
      for (let k = 0; k < D; k++) v += (x[(first + j) * D + k] - x[(s + j) * D + k]) ** 2;
      t += v;
      c++;
    }
    return c >= 4 ? t / c : Infinity;
  };
  let best = s1;
  let bv = Infinity;
  for (let s = Math.max(0, s1 - CHORUS.alignBars); s <= Math.min(n - 1, s1 + CHORUS.alignBars); s++) {
    if (Math.abs(s - first) < L) continue;
    const v = dist(s);
    if (v < bv) {
      bv = v;
      best = s;
    }
  }
  return bv < CHORUS.alignGain * dist(s1) ? best : s1;
}

/** 小節線と音の打点のずれ（秒）。小節を 4 等分した所の立ち上がりの和がいちばん大きくなるずらし（±CHORUS.gridSearch。同じなら小さい方） */
export function gridOffset(f: ChorusFeatures, bars: readonly number[]): number {
  const NF = Math.round(f.flux.length / Math.max(1, f.fluxFrames));
  if (NF < 1 || f.fluxFrames < 4) return 0;
  const env = new Float64Array(f.fluxFrames);
  for (let k = 0; k < f.fluxFrames; k++) {
    let v = 0;
    for (let b = 0; b < NF; b++) v += f.flux[k * NF + b];
    env[k] = v;
  }
  const at = (t: number) => {
    const c = t * f.fluxRate - f.fluxOffset;
    const k = Math.floor(c);
    if (k < 0 || k + 1 >= env.length) return 0;
    return env[k] + (env[k + 1] - env[k]) * (c - k);
  };
  const pts: number[] = [];
  for (let i = 0; i + 1 < bars.length; i++) for (let q = 0; q < 4; q++) pts.push(bars[i] + ((bars[i + 1] - bars[i]) * q) / 4);
  let best = 0;
  let bv = -Infinity;
  const steps = Math.round(CHORUS.gridSearch / 0.002);
  for (let i = -steps; i <= steps; i++) {
    const d = i * 0.002;
    let s = 0;
    for (const t of pts) s += at(t + d);
    if (bv === -Infinity || s > bv * (1 + 1e-9) || (s >= bv * (1 - 1e-9) && Math.abs(d) < Math.abs(best))) {
      bv = s;
      best = d;
    }
  }
  return best;
}

export function findChorus(inp: ChorusInput): ChorusResult {
  const empty: ChorusResult = { best: null, repeats: [], others: [], parts: [] };
  // 小節線を打点に合わせて特徴を取る。答えの時刻は元の小節線で返す
  const off = gridOffset(inp.feat, inp.bars);
  const bf = barFeatures(off ? { ...inp, bars: inp.bars.map((t) => t + off) } : inp);
  const n = bf.n;
  if (n < 12) return empty;
  const runs = partitions(bf, inp.duration);
  if (!runs.length) return empty;
  const member = consensus(runs, n);
  const occ = chorusSegs(member);
  if (!occ.length) return empty;
  const groove = grooveOf(bf, occ);
  /** 所 seg を、頭を小節 s に直して答えの形に */
  const pickAt = (seg: Seg, s: number, score: number): ChorusPick => {
    const e = Math.max(s, seg.b - 1);
    return { start: inp.bars[bf.index[s]], end: inp.bars[bf.index[e] + 1], bar: bf.index[s], score };
  };
  const pick = (seg: Seg, score: number) => pickAt(seg, refineStart(bf, groove, seg.a), score);
  const score = runs.reduce((a, r) => a + r.scores[0].score, 0) / runs.length;
  const firstSeg = firstAfterIntro(bf, occ, inp.duration);
  const first = refineStart(bf, groove, firstSeg.a);
  const best = pickAt(firstSeg, first, score);
  // 同じサビのほかの所（頭は 1 回目のサビに小節ごとに並ぶ所に合わせる。近い所は同じかたまりとみなして 1 つに）
  const kept = [best];
  const repeats: ChorusPick[] = [];
  const again = occ
    .filter((seg) => seg !== firstSeg)
    .map((seg) => {
      const s1 = refineStart(bf, groove, seg.a);
      const s = alignRepeat(bf, first, firstSeg.b - first, s1);
      // 1 回目に合わせて動かした分は、終わりも動かす
      return pickAt({ ...seg, b: Math.min(n, seg.b + s - s1) }, s, score);
    });
  for (const p of again.sort((a, b) => a.start - b.start)) {
    if (kept.some((k) => Math.abs(k.bar - p.bar) < CHORUS.sameBlock)) continue;
    kept.push(p);
    repeats.push(p);
  }
  // 見せる分け方：いちばんの印がサビの所といちばん合う回（同じなら印の数が 6 に近い回）
  const agree = (r: Run) => {
    let a = 0;
    for (const s of r.scores[0].segs) for (let i = s.a; i < s.b; i++) a += member[i] > 0.5 ? 1 : -1;
    return a - Math.abs(r.K - 6) * 0.1;
  };
  const rep = runs.reduce((a, r) => (agree(r) > agree(a) ? r : a), runs[0]);
  // ほかの候補：その分け方の 2 番目より下の印（サビの所と重なるだけの印は除く）
  const others = rep.scores
    .slice(1)
    .filter((l) => !l.segs.every((s) => occ.some((o) => s.a < o.b && o.a < s.b)))
    .slice(0, 2)
    .map((l) => pick(firstAfterIntro(bf, l.segs, inp.duration), l.score));
  const parts: ChorusPart[] = rep.segs.map((s) => {
    let inC = 0;
    for (let i = s.a; i < s.b; i++) if (member[i] > 0.5) inC++;
    return { start: inp.bars[bf.index[s.a]], end: inp.bars[bf.index[s.b - 1] + 1], label: s.label, chorus: inC * 2 > s.b - s.a };
  });
  return { best, repeats, others, parts };
}

// ---- 小節の線 ---------------------------------------------------------------------

/** 立ち上がり（帯域ごと）から、全部の帯域・低い帯域（キック）・高い帯域（シンバル）の和 */
function fluxBands(f: ChorusFeatures): { all: Float32Array; low: Float32Array; high: Float32Array } {
  const NF = Math.round(f.flux.length / Math.max(1, f.fluxFrames));
  const all = new Float32Array(f.fluxFrames);
  const low = new Float32Array(f.fluxFrames);
  const high = new Float32Array(f.fluxFrames);
  for (let k = 0; k < f.fluxFrames; k++) {
    let s = 0;
    for (let b = 0; b < NF; b++) s += f.flux[k * NF + b];
    all[k] = s;
    low[k] = f.flux[k * NF] + f.flux[k * NF + Math.min(1, NF - 1)];
    high[k] = f.flux[k * NF + Math.max(0, NF - 2)] + f.flux[k * NF + NF - 1];
  }
  return { all, low, high };
}

/** 音から拍を追う（曲の音の秒）。拍が取れなければ [] */
export function trackAudioBeats(f: ChorusFeatures): { beats: number[]; bpm: number } {
  const { all } = fluxBands(f);
  const bpm = estimateTempo(all, f.fluxRate)[0]?.bpm ?? 0;
  if (!bpm) return { beats: [], bpm: 0 };
  const shift = f.fluxOffset / f.fluxRate;
  return { beats: trackBeats(all, f.fluxRate, bpm).map((t) => t + shift), bpm };
}

/**
 * 譜面の拍（grid、曲の音の秒）が、音から追った拍（tracked）にどれだけ乗っているか（0〜1）。
 * 譜面の拍が倍・半分の速さでも数える。0.5 より下なら、譜面の小節線は音に合っていない
 */
export function gridMatch(grid: readonly number[], tracked: readonly number[], tol = 0.05): number {
  if (tracked.length < 8) return 0;
  const lo = tracked[0] - tol;
  const hi = tracked[tracked.length - 1] + tol;
  // 追った拍の間（倍の速さの譜面のため）も入れる。ただし譜面の拍の間隔が追った拍の半分ほどのときだけ
  const steps: number[] = [];
  for (let i = 0; i + 1 < tracked.length; i++) steps.push(tracked[i + 1] - tracked[i]);
  const pt = median(steps);
  const gs: number[] = [];
  for (let i = 0; i + 1 < grid.length; i++) if (grid[i] >= lo && grid[i] <= hi) gs.push(grid[i + 1] - grid[i]);
  if (gs.length < 8) return 0;
  const pg = median(gs);
  const r = pg / pt;
  let pts = tracked as readonly number[];
  if (Math.abs(r - 0.5) < 0.03) {
    const mid: number[] = [];
    for (let i = 0; i + 1 < tracked.length; i++) mid.push(tracked[i], (tracked[i] + tracked[i + 1]) / 2);
    mid.push(tracked[tracked.length - 1]);
    pts = mid;
  } else if (Math.abs(r - 1) > 0.04 && Math.abs(r - 2) > 0.08) return 0;
  let hit = 0;
  let n = 0;
  let j = 0;
  for (const t of grid) {
    if (t < lo || t > hi) continue;
    n++;
    while (j + 1 < pts.length && pts[j + 1] <= t) j++;
    const d = Math.min(Math.abs(t - pts[j]), j + 1 < pts.length ? Math.abs(pts[j + 1] - t) : Infinity);
    if (d <= tol) hit++;
  }
  return n ? hit / n : 0;
}

/**
 * 音から小節の頭を推定する（曲の音の秒）。拍を追い、4 拍ごとに区切る。
 * どの拍を頭にするかは、和音の変わり目（前の 2 拍と後の 2 拍のクロマの違い）とキック・シンバルの強さで決める
 */
export function estimateBars(f: ChorusFeatures, tracked = trackAudioBeats(f)): { bars: number[]; bpm: number } {
  const beats = tracked.beats;
  if (beats.length < 16) return { bars: [], bpm: tracked.bpm };
  const { low, high } = fluxBands(f);
  const at = (arr: Float32Array, t: number) => {
    const c = Math.round(t * f.fluxRate - f.fluxOffset);
    let m = 0;
    for (let k = Math.max(0, c - 2); k <= Math.min(arr.length - 1, c + 2); k++) if (arr[k] > m) m = arr[k];
    return m;
  };
  const ml = median(beats.map((t) => at(low, t)).filter((v) => v > 0)) || 1e-9;
  const mh = median(beats.map((t) => at(high, t)).filter((v) => v > 0)) || 1e-9;
  const acc = [0, 0, 0, 0];
  beats.forEach((t, i) => (acc[i % 4] += Math.log2(Math.max(1e-3, (at(low, t) / ml) * (at(high, t) / mh)))));
  const chromaOf = (t0: number, t1: number) => {
    const v = new Float64Array(12);
    const a = Math.max(0, Math.ceil(t0 * f.rate - f.offset));
    const b = Math.min(f.frames - 1, Math.ceil(t1 * f.rate - f.offset) - 1);
    for (let k = a; k <= b; k++) for (let c = 0; c < 12; c++) v[c] += f.chroma[k * 12 + c];
    let s = 0;
    for (let c = 0; c < 12; c++) s += v[c] * v[c];
    s = Math.sqrt(s) + 1e-9;
    for (let c = 0; c < 12; c++) v[c] /= s;
    return v;
  };
  const chg = [0, 0, 0, 0];
  for (let i = 2; i + 2 < beats.length; i++) {
    const p = chromaOf(beats[i - 2], beats[i]);
    const q = chromaOf(beats[i], beats[i + 2]);
    let d = 0;
    for (let c = 0; c < 12; c++) d += p[c] * q[c];
    chg[i % 4] += 1 - d;
  }
  const z = (a: number[]) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const s = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1;
    return a.map((x) => (x - m) / s);
  };
  const za = z(acc);
  const zc = z(chg);
  let phase = 0;
  for (let p = 1; p < 4; p++) if (za[p] + zc[p] > za[phase] + zc[phase]) phase = p;
  const bars: number[] = [];
  for (let i = phase; i < beats.length; i += 4) bars.push(beats[i]);
  return { bars, bpm: tracked.bpm };
}

// ---- まとめ ---------------------------------------------------------------------

/** 譜面の小節の頭と拍（曲の音の秒） */
export interface ChorusGrid {
  bars: readonly number[];
  beats: readonly number[];
}

export interface ChorusFound extends ChorusResult {
  /** 使った小節の頭（曲の音の秒）。ChorusPick.bar はこの番号 */
  bars: number[];
  /** chart: 譜面の小節線（bar は譜面の小節番号）。audio: 譜面の線が音に合っていないので、音から推定した */
  grid: 'chart' | 'audio';
  /** 曲の音の長さ（秒） */
  duration: number;
}

/** 譜面の小節線が音に合っていればそれで、合っていなければ音から小節を推定してサビを探す（ワーカーで呼ぶ） */
export function findChorusAuto(feat: ChorusFeatures, duration: number, grid: ChorusGrid | null): ChorusFound {
  const tracked = trackAudioBeats(feat);
  let bars: number[] | null = null;
  let kind: ChorusFound['grid'] = 'audio';
  // 拍が追えない音（リズムの無い曲）は、譜面の線をそのまま使う
  if (grid && grid.bars.length >= 12 && (tracked.beats.length < 16 || gridMatch(grid.beats, tracked.beats) >= CHORUS.gridOk)) {
    bars = [...grid.bars];
    kind = 'chart';
  }
  bars ??= estimateBars(feat, tracked).bars;
  return { ...findChorus({ feat, duration, bars }), bars, grid: kind, duration };
}
