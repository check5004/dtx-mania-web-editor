// ステム分解の信号処理。モデル（BS-RoFormer・SCNet）は複素スペクトログラムを受け取って楽器ごとのスペクトログラムを返すので、
// その前後（STFT と逆 STFT）と、曲を区切ってモデルに流し、重ねて戻す処理をここでやる。
//
// - STFT・逆 STFT は torch.stft / torch.istft（center=True・reflect で端を埋める・窓の2乗の和で割る）と同じ結果になるように書いている。
//   左右のチャンネルを1回の複素 FFT でまとめて変換する（実数の信号2本を実部と虚部に入れる）。
// - 区切り方と重ね方は Demucs の apply_model と同じ（25% ずつ重ね、三角の重みで足し、重みの和で割る。最後の短い区切りは前の音を足して中央に置く）。
//   ブラウザ版の作り方は unblend（Ryan Fahey、MIT）を参考にした。
//
// このファイルは何も import しない（Node の精度テスト scripts/separate-bench.mjs からもそのまま読めるように）。

/** モデルの前後の信号処理の形 */
export interface Geometry {
  nfft: number;
  hop: number;
  /** 1回にモデルへ流す長さ（サンプル） */
  chunk: number;
  /** モデルの入力の長さ。chunk より長ければ後ろを 0 で埋める（SCNet）。省くと chunk */
  input?: number;
  window: 'hann' | 'rect';
  /** STFT を 1/√nfft 倍するか（SCNet） */
  normalized: boolean;
}

/** 長さ n（2 のべき乗）の複素 FFT。ビットの並べ替えと回転因子の表を先に作っておく */
export class Fft {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT の長さは 2 のべき乗にしてください（${n}）`);
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** その場で変換する。inverse なら e^{+i…}（1/n 倍はしない） */
  transform(re: Float64Array, im: Float64Array, inverse: boolean) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const cos = this.cos;
    const sin = this.sin;
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t];
          const wi = sgn * sin[t];
          const j = i + k;
          const l = j + half;
          const xr = re[l];
          const xi = im[l];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }
}

/** torch の hann_window（periodic）か、全部 1 の窓 */
export function makeWindow(n: number, kind: 'hann' | 'rect'): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = kind === 'rect' ? 1 : 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * 1区切りぶんの STFT と逆 STFT。スペクトログラムの並びはモデルの入出力と同じ [チャンネル][周波数][フレーム]。
 * 同じインスタンスを同時に2つの処理で使わないこと（作業用の配列を使い回す）。
 */
export class SegmentStft {
  readonly g: Geometry;
  readonly nfft: number;
  readonly hop: number;
  /** モデルの入力の長さ（サンプル） */
  readonly length: number;
  readonly bins: number;
  readonly frames: number;
  private fft: Fft;
  private win: Float64Array;
  private scaleF: number;
  private scaleI: number;
  private invEnv: Float64Array;
  private zr: Float64Array;
  private zi: Float64Array;
  private accL: Float64Array;
  private accR: Float64Array;

  constructor(g: Geometry) {
    this.g = g;
    this.nfft = g.nfft;
    this.hop = g.hop;
    this.length = g.input ?? g.chunk;
    if (this.length % g.hop !== 0) throw new Error(`モデルの入力の長さ ${this.length} が hop ${g.hop} で割り切れません`);
    this.bins = g.nfft / 2 + 1;
    this.frames = this.length / g.hop + 1;
    this.fft = new Fft(g.nfft);
    this.win = makeWindow(g.nfft, g.window);
    // torch: normalized=True は STFT に 1/√n を掛け、逆 STFT で √n を掛けてから irfft（1/n）
    this.scaleF = g.normalized ? 1 / Math.sqrt(g.nfft) : 1;
    this.scaleI = g.normalized ? 1 / Math.sqrt(g.nfft) : 1 / g.nfft;
    const outLen = (this.frames - 1) * g.hop + g.nfft;
    const env = new Float64Array(outLen);
    for (let f = 0; f < this.frames; f++) for (let i = 0; i < g.nfft; i++) env[f * g.hop + i] += this.win[i] * this.win[i];
    this.invEnv = new Float64Array(outLen);
    for (let i = 0; i < outLen; i++) this.invEnv[i] = env[i] > 1e-11 ? 1 / env[i] : 0;
    this.zr = new Float64Array(g.nfft);
    this.zi = new Float64Array(g.nfft);
    this.accL = new Float64Array(outLen);
    this.accR = new Float64Array(outLen);
  }

  /** スペクトログラム1本（2チャンネル）の要素数 */
  get specSize(): number {
    return 2 * this.bins * this.frames;
  }

  /** 左右（それぞれ length サンプル）の STFT を re・im（specSize、[ch][bin][frame]）に書く */
  forward(left: Float32Array, right: Float32Array, re: Float32Array, im: Float32Array) {
    const { nfft, hop, bins, frames, length } = this;
    const half = nfft / 2;
    const win = this.win;
    const zr = this.zr;
    const zi = this.zi;
    const s = this.scaleF * 0.5;
    const plane = bins * frames;
    for (let f = 0; f < frames; f++) {
      const start = f * hop - half;
      for (let i = 0; i < nfft; i++) {
        // reflect（端の値は繰り返さない）
        let idx = start + i;
        if (idx < 0) idx = -idx;
        else if (idx >= length) idx = 2 * (length - 1) - idx;
        zr[i] = left[idx] * win[i];
        zi[i] = right[idx] * win[i];
      }
      this.fft.transform(zr, zi, false);
      // 実数の信号2本（左＝実部、右＝虚部）の FFT を分ける: L = (Z[k] + conj Z[n-k]) / 2、R = (Z[k] - conj Z[n-k]) / 2i
      for (let k = 0; k < bins; k++) {
        const m = k === 0 ? 0 : nfft - k;
        const a = zr[k];
        const b = zi[k];
        const c = zr[m];
        const d = zi[m];
        const o = k * frames + f;
        re[o] = (a + c) * s;
        im[o] = (b - d) * s;
        re[plane + o] = (b + d) * s;
        im[plane + o] = (c - a) * s;
      }
    }
  }

  /**
   * re・im の offset から始まるスペクトログラム1本（2チャンネル）を音に戻し、outL・outR（length サンプル）に書く。
   * DC とナイキストの虚部は捨てる（torch.istft の irfft と同じ）。
   */
  inverse(re: Float32Array, im: Float32Array, offset: number, outL: Float32Array, outR: Float32Array) {
    const { nfft, hop, bins, frames, length } = this;
    const half = nfft / 2;
    const win = this.win;
    const zr = this.zr;
    const zi = this.zi;
    const accL = this.accL;
    const accR = this.accR;
    accL.fill(0);
    accR.fill(0);
    const plane = bins * frames;
    const s = this.scaleI;
    for (let f = 0; f < frames; f++) {
      // Z = L + iR（L・R は実数の信号のスペクトル）。逆 FFT すると実部が L、虚部が R
      for (let k = 0; k < bins; k++) {
        const o = offset + k * frames + f;
        const lr = re[o];
        const li = k === 0 || k === half ? 0 : im[o];
        const rr = re[o + plane];
        const ri = k === 0 || k === half ? 0 : im[o + plane];
        zr[k] = lr - ri;
        zi[k] = li + rr;
        if (k > 0 && k < half) {
          zr[nfft - k] = lr + ri;
          zi[nfft - k] = rr - li;
        }
      }
      this.fft.transform(zr, zi, true);
      const base = f * hop;
      for (let i = 0; i < nfft; i++) {
        const w = win[i] * s;
        accL[base + i] += zr[i] * w;
        accR[base + i] += zi[i] * w;
      }
    }
    const env = this.invEnv;
    for (let i = 0; i < length; i++) {
      outL[i] = accL[half + i] * env[half + i];
      outR[i] = accR[half + i] * env[half + i];
    }
  }
}

/** 曲の1区切り */
export interface Segment {
  /** 曲の中の始まり（サンプル） */
  start: number;
  /** この区切りが受け持つ長さ（最後以外は chunk） */
  len: number;
  /** モデルに流す窓の始まり（曲の中、負や曲の外は 0 で埋める）。短い区切りは前の音を足して中央に置く */
  from: number;
  /** モデルの出力のうち使う所の始まり */
  trim: number;
}

/** 曲（n サンプル）を chunk ごとに overlap ずつ重ねて区切る（Demucs の apply_model と同じ） */
export function planSegments(n: number, chunk: number, overlap = 0.25): Segment[] {
  const step = Math.max(1, Math.floor(chunk * (1 - overlap)));
  const out: Segment[] = [];
  for (let start = 0; start < n; start += step) {
    const len = Math.min(chunk, n - start);
    const trim = (chunk - len) >> 1;
    out.push({ start, len, from: start - trim, trim });
  }
  return out;
}

/** 区切りを重ねるときの三角の重み（Demucs の _split_weight、transition_power=1） */
export function splitWeight(chunk: number): Float32Array {
  const half = Math.floor(chunk / 2);
  const peak = Math.max(half, chunk - half);
  const w = new Float32Array(chunk);
  for (let i = 0; i < chunk; i++) w[i] = (i < half ? i + 1 : chunk - i) / peak;
  return w;
}

/** 曲の from から len サンプルを取り出す（外は 0）。dst の残りも 0 にする */
export function readWindow(src: Float32Array, from: number, len: number, dst: Float32Array) {
  dst.fill(0);
  const a = Math.max(0, -from);
  const b = Math.min(len, src.length - from);
  if (b > a) dst.set(src.subarray(from + a, from + b), a);
}

/** 重みの和（区切りの並びだけで決まるので、ステムどうしで共有する）。割るときに使う逆数で返す */
export function inverseWeightSum(n: number, segs: readonly Segment[], weight: Float32Array): Float32Array {
  const sum = new Float32Array(n);
  for (const seg of segs) for (let i = 0; i < seg.len; i++) sum[seg.start + i] += weight[i];
  for (let i = 0; i < n; i++) sum[i] = sum[i] > 0 ? 1 / sum[i] : 0;
  return sum;
}

/** 区切りごとの出力を三角の重みで足していく（ステム1本、ステレオ）。最後に重みの和で割る */
export class OverlapAdd {
  readonly left: Float32Array;
  readonly right: Float32Array;
  private weight: Float32Array;

  constructor(n: number, weight: Float32Array) {
    this.left = new Float32Array(n);
    this.right = new Float32Array(n);
    this.weight = weight;
  }

  /** モデルの出力（outL・outR の trim から seg.len サンプル）を足す */
  add(seg: Segment, outL: Float32Array, outR: Float32Array) {
    const w = this.weight;
    const L = this.left;
    const R = this.right;
    for (let i = 0; i < seg.len; i++) {
      const k = w[i];
      L[seg.start + i] += outL[seg.trim + i] * k;
      R[seg.start + i] += outR[seg.trim + i] * k;
    }
  }

  /** 重みの和（inverseWeightSum の逆数）で割って仕上げる */
  finish(invSum: Float32Array) {
    const L = this.left;
    const R = this.right;
    for (let i = 0; i < L.length; i++) {
      L[i] *= invSum[i];
      R[i] *= invSum[i];
    }
  }
}
