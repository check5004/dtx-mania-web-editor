// スロー再生用の時間伸長（WSOLA）。音程を変えずに長さだけを 1/rate 倍にする。
// 似た形の所をつなぐ探索は、間引いた信号で大まかに探してから元の信号で詰める。

export interface StretchResult {
  channels: Float32Array[];
  /** 出力の 0 サンプル目が元の何サンプル目か */
  fromSample: number;
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * channels の [from, to) を rate 倍の速さにする（rate < 1 で遅く、長くなる）。
 * 出力の j サンプル目は元の from + j × rate サンプル目に当たる（窓の真ん中どうしで合わせる）。
 * from より前・to より後も、channels にあれば似た所を探すのに使う（区切りの前後を少し足して渡す）
 */
export function wsola(channels: Float32Array[], sr: number, rate: number, from: number, to: number): StretchResult {
  const len = channels[0].length;
  from = Math.max(0, Math.min(len, Math.floor(from)));
  to = Math.max(from, Math.min(len, Math.floor(to)));
  if (rate >= 0.999) return { channels: channels.map((c) => c.slice(from, to)), fromSample: from };
  let N = 1;
  while (N < sr * 0.04) N <<= 1;
  const Hs = N >> 1;
  const Ha = Hs * rate;
  // 出力の窓の真ん中（k × Hs + Hs）が元の from + (k × Hs + Hs) × rate に当たるよう、元の窓の頭を Hs × (1 − rate) 前にする。
  // 窓の頭どうしで合わせると、伸ばした音がチップより早く聞こえる（50% で約 20ms、25% で約 70ms）
  const lead = Hs * (1 - rate);
  const tol = Math.round(sr * 0.012);
  const D = 4;
  const w = hann(N);
  const outLen = Math.ceil((to - from) / rate);
  const out = channels.map(() => new Float32Array(outLen + N));
  // 似た所を探すためのモノラル（元の長さ）と、4分の1に間引いたもの
  const mono = new Float32Array(len);
  for (const c of channels) for (let i = 0; i < len; i++) mono[i] += c[i];
  const dec = new Float32Array(Math.ceil(len / D));
  for (let i = 0; i < dec.length; i++) {
    let s = 0;
    for (let k = 0; k < D && i * D + k < len; k++) s += mono[i * D + k];
    dec[i] = s;
  }
  const L = Hs; // 重なり部分の長さ
  const Ld = Math.floor(L / D);
  const frames = Math.ceil(outLen / Hs) + 1;
  let prev = 0;
  // 頭の半窓（出力の 0〜Hs）も窓の重なりで作るため、k = −1 の窓から始める（窓の立ち上がりで小さくならない）
  for (let k = -1; k < frames; k++) {
    const outPos = k * Hs;
    const nominal = Math.round(from + k * Ha - lead);
    let start = nominal;
    const natural = prev + Hs;
    if (k === 0 && nominal < 0) {
      // 音の頭：k = −1 の窓の続きから（頭の打音を欠けさせず、窓の立ち上がりで小さくしない）
      start = from;
    } else if (k >= 0 && natural >= 0 && natural + L < len) {
      // 大まかな探索（間引いた信号）。同じ似かたなら元の位置（nominal）に近い所を選ぶ（無音の所で端に寄らない）
      const nd = Math.floor(natural / D);
      const coarse = (d: number) => {
        const cd = Math.floor((nominal + d * D) / D);
        if (cd < 0 || cd + Ld >= dec.length || nd + Ld >= dec.length) return -Infinity;
        let s = 0;
        for (let i = 0; i < Ld; i++) s += dec[nd + i] * dec[cd + i];
        return s;
      };
      let best = coarse(0);
      let bestD = 0;
      for (let d = 1; d <= Math.floor(tol / D); d++) {
        for (const dd of [-d, d]) {
          const s = coarse(dd);
          if (s > best) {
            best = s;
            bestD = dd * D;
          }
        }
      }
      // 細かい探索（元の信号）
      const exact = (d: number) => {
        const c = nominal + d;
        if (c < 0 || c + L >= len) return -Infinity;
        let s = 0;
        for (let i = 0; i < L; i += 2) s += mono[natural + i] * mono[c + i];
        return s;
      };
      let fine = bestD;
      best = exact(bestD);
      for (let d = 1; d <= D; d++) {
        for (const dd of [bestD - d, bestD + d]) {
          const s = exact(dd);
          if (s > best) {
            best = s;
            fine = dd;
          }
        }
      }
      start = nominal + fine;
    }
    start = Math.min(len - 1, start);
    // 音の頭より前（start < 0）は無音として重ねる
    const i0 = Math.max(0, -start, -outPos);
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = out[ch];
      for (let i = i0; i < N; i++) {
        const si = start + i;
        if (si >= len) break;
        const oi = outPos + i;
        if (oi >= dst.length) break;
        dst[oi] += src[si] * w[i];
      }
    }
    prev = start;
  }
  return { channels: out.map((c) => c.subarray(0, outLen).slice()), fromSample: from };
}
