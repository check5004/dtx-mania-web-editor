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
 * 出力の j サンプル目はおおよそ元の from + j × rate サンプル目に当たる。
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
  let prev = from;
  for (let k = 0; k < frames; k++) {
    const outPos = k * Hs;
    const nominal = Math.round(from + k * Ha);
    let start = nominal;
    if (k > 0) {
      const natural = prev + Hs;
      // 大まかな探索（間引いた信号）
      const nd = Math.floor(natural / D);
      let best = -Infinity;
      let bestD = 0;
      for (let d = -Math.floor(tol / D); d <= Math.floor(tol / D); d++) {
        const cd = Math.floor((nominal + d * D) / D);
        if (cd < 0 || cd + Ld >= dec.length || nd + Ld >= dec.length) continue;
        let s = 0;
        for (let i = 0; i < Ld; i++) s += dec[nd + i] * dec[cd + i];
        if (s > best) {
          best = s;
          bestD = d * D;
        }
      }
      // 細かい探索（元の信号）
      let fine = bestD;
      best = -Infinity;
      for (let d = bestD - D; d <= bestD + D; d++) {
        const c = nominal + d;
        if (c < 0 || c + L >= len || natural + L >= len) continue;
        let s = 0;
        for (let i = 0; i < L; i += 2) s += mono[natural + i] * mono[c + i];
        if (s > best) {
          best = s;
          fine = d;
        }
      }
      start = nominal + fine;
    }
    start = Math.max(0, Math.min(len - 1, start));
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = out[ch];
      for (let i = 0; i < N; i++) {
        const si = start + i;
        if (si >= len) break;
        const oi = outPos + i;
        if (oi >= dst.length) break;
        dst[oi] += src[si] * w[i];
      }
    }
    prev = start;
  }
  // 最初の半窓は窓の立ち上がりで小さくなっているので、元の音をそのまま入れる
  for (let ch = 0; ch < channels.length; ch++) {
    const src = channels[ch];
    const dst = out[ch];
    for (let i = 0; i < Hs && from + i < len; i++) dst[i] = src[from + i];
  }
  return { channels: out.map((c) => c.subarray(0, outLen).slice()), fromSample: from };
}
