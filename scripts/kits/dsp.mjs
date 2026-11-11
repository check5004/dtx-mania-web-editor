// キットを作るときの音の加工（音程・フィルター・コンプ・残響・歪み・ビット落とし・トリム）。
// どれも自前の素直な実装（ブラウザでは使わない。scripts/make-kits.mjs から）。

/** 読む速さ ratio で読み直す（3次エルミート補間）。ratio が 1 より大きいと高く短くなる */
export function resample(x, ratio, maxLen = Infinity) {
  if (Math.abs(ratio - 1) < 1e-9) return Float64Array.from(x.subarray(0, Math.min(x.length, maxLen)));
  const n = Math.max(0, Math.min(maxLen, Math.floor((x.length - 1) / ratio)));
  const y = new Float64Array(n);
  const at = (i) => (i < 0 ? 0 : i >= x.length ? 0 : x[i]);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const k = Math.floor(p);
    const t = p - k;
    const xm1 = at(k - 1);
    const x0 = at(k);
    const x1 = at(k + 1);
    const x2 = at(k + 2);
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    y[i] = ((c3 * t + c2) * t + c1) * t + x0;
  }
  return y;
}

/** 2次のフィルター（RBJ の式）。type: lpf_1p hpf_1p lpf_2p hpf_2p bpf_2p brf_2p peq lowshelf highshelf */
export function biquad(x, f, sr) {
  const y = new Float64Array(x.length);
  const hz = Math.max(10, Math.min(sr * 0.49, f.hz));
  if (f.type === 'lpf_1p' || f.type === 'hpf_1p') {
    const a = Math.exp((-2 * Math.PI * hz) / sr);
    let s = 0;
    for (let i = 0; i < x.length; i++) {
      s = (1 - a) * x[i] + a * s;
      y[i] = f.type === 'lpf_1p' ? s : x[i] - s;
    }
    return y;
  }
  const w = (2 * Math.PI * hz) / sr;
  const cs = Math.cos(w);
  const sn = Math.sin(w);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (f.type === 'peq' || f.type === 'lowshelf' || f.type === 'highshelf') {
    const A = 10 ** ((f.gain ?? 0) / 40);
    if (f.type === 'peq') {
      const bw = f.bw ?? 1;
      const alpha = sn * Math.sinh(((Math.LN2 / 2) * bw * w) / sn);
      b0 = 1 + alpha * A;
      b1 = -2 * cs;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cs;
      a2 = 1 - alpha / A;
    } else {
      const S = f.slope ?? 1;
      const alpha = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      const sq = 2 * Math.sqrt(A) * alpha;
      if (f.type === 'lowshelf') {
        b0 = A * (A + 1 - (A - 1) * cs + sq);
        b1 = 2 * A * (A - 1 - (A + 1) * cs);
        b2 = A * (A + 1 - (A - 1) * cs - sq);
        a0 = A + 1 + (A - 1) * cs + sq;
        a1 = -2 * (A - 1 + (A + 1) * cs);
        a2 = A + 1 + (A - 1) * cs - sq;
      } else {
        b0 = A * (A + 1 + (A - 1) * cs + sq);
        b1 = -2 * A * (A - 1 + (A + 1) * cs);
        b2 = A * (A + 1 + (A - 1) * cs - sq);
        a0 = A + 1 - (A - 1) * cs + sq;
        a1 = 2 * (A - 1 - (A + 1) * cs);
        a2 = A + 1 - (A - 1) * cs - sq;
      }
    }
  } else {
    const Q = f.Q ?? 0.7071 * 10 ** ((f.q ?? 0) / 20);
    const alpha = sn / (2 * Q);
    a0 = 1 + alpha;
    a1 = -2 * cs;
    a2 = 1 - alpha;
    if (f.type === 'hpf_2p') {
      b0 = (1 + cs) / 2;
      b1 = -(1 + cs);
      b2 = (1 + cs) / 2;
    } else if (f.type === 'bpf_2p') {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else if (f.type === 'brf_2p') {
      b0 = 1;
      b1 = -2 * cs;
      b2 = 1;
    } else {
      b0 = (1 - cs) / 2;
      b1 = 1 - cs;
      b2 = (1 - cs) / 2;
    }
  }
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** いくつかのフィルターを順にかける */
export function filters(x, list, sr) {
  let y = x;
  for (const f of list) y = biquad(y, f, sr);
  return y;
}

/** ピークの大きさ */
export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

export function scale(x, k) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * k;
  return y;
}

/** 足し合わせ（長いほうの長さ） */
export function mix(...parts) {
  const len = Math.max(...parts.map(([x]) => x.length));
  const y = new Float64Array(len);
  for (const [x, g = 1, at = 0] of parts) for (let i = 0; i < x.length && i + at < len; i++) y[i + at] += x[i] * g;
  return y;
}

/** コンプレッサー（ピークで見る。attack・release はミリ秒） */
export function compress(x, { threshold = -18, ratio = 4, attack = 3, release = 120, knee = 6, makeup = 0 }, sr) {
  const y = new Float64Array(x.length);
  const ga = Math.exp(-1 / ((attack / 1000) * sr));
  const gr = Math.exp(-1 / ((release / 1000) * sr));
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = a > env ? ga * env + (1 - ga) * a : gr * env + (1 - gr) * a;
    const db = 20 * Math.log10(env + 1e-12);
    const over = db - threshold;
    let red = 0;
    if (over > knee / 2) red = over * (1 - 1 / ratio);
    else if (over > -knee / 2) red = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
    y[i] = x[i] * 10 ** ((makeup - red) / 20);
  }
  return y;
}

/** やわらかい歪み（tanh）。drive は dB */
export function saturate(x, drive = 6, mixAmt = 1) {
  const k = 10 ** (drive / 20);
  const n = Math.tanh(k);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = (1 - mixAmt) * x[i] + (mixAmt * Math.tanh(x[i] * k)) / n;
  return y;
}

/** ビットを落とし、サンプリング周波数も落とす（hold で同じ値を保つ） */
export function crush(x, bits = 12, hold = 1) {
  const q = 2 ** (bits - 1);
  const y = new Float64Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) v = Math.round(x[i] * q) / q;
    y[i] = v;
  }
  return y;
}

/** 決まった種から作る乱数（同じキットを何度作っても同じ音に） */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * 残響（Freeverb の形: 並列のコム8本と直列のオールパス4本）
 * size 0〜1（長さ）、damp 0〜1（高い音の減り方）、predelay は秒、wet・dry は倍率
 */
export function reverb(x, { size = 0.8, damp = 0.4, predelay = 0.01, wet = 0.3, dry = 1, tail = 2 }, sr) {
  const k = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round(n * k));
  const aps = [556, 441, 341, 225].map((n) => Math.round(n * k));
  const fb = 0.7 + 0.28 * size;
  const pd = Math.round(predelay * sr);
  const len = x.length + Math.round(tail * sr);
  const out = new Float64Array(len);
  const inp = (i) => (i - pd >= 0 && i - pd < x.length ? x[i - pd] : 0);
  const cb = combs.map((n) => ({ buf: new Float64Array(n), i: 0, store: 0 }));
  const ab = aps.map((n) => ({ buf: new Float64Array(n), i: 0 }));
  for (let i = 0; i < len; i++) {
    const v = inp(i) * 0.015;
    let s = 0;
    for (const c of cb) {
      const o = c.buf[c.i];
      c.store = o * (1 - damp) + c.store * damp;
      c.buf[c.i] = v + c.store * fb;
      c.i = (c.i + 1) % c.buf.length;
      s += o;
    }
    for (const a of ab) {
      const o = a.buf[a.i];
      a.buf[a.i] = s + o * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      s = o - s;
    }
    out[i] = s * wet + (i < x.length ? x[i] * dry : 0);
  }
  return out;
}

/** ゲート（hold 秒のあと、release 秒で切る）。80 年代のゲートリバーブに */
export function gate(x, hold, release, sr) {
  const h = Math.round(hold * sr);
  const r = Math.max(1, Math.round(release * sr));
  const y = new Float64Array(Math.min(x.length, h + r));
  for (let i = 0; i < y.length; i++) y[i] = x[i] * (i < h ? 1 : Math.cos((((i - h) / r) * Math.PI) / 2) ** 2);
  return y;
}

/** 音の立ち上がりを強める・弱める（速い包絡と遅い包絡の差で） */
export function transient(x, amount = 0.5, sr = 44100) {
  const fa = Math.exp(-1 / (0.001 * sr));
  const sa = Math.exp(-1 / (0.03 * sr));
  let f = 0;
  let s = 0;
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    f = fa * f + (1 - fa) * a;
    s = sa * s + (1 - sa) * a;
    const d = Math.max(0, f - s) / (s + 1e-6);
    y[i] = x[i] * (1 + amount * Math.min(4, d));
  }
  return y;
}

/** 長さを変えずに、時間とともに音量を下げる（tau 秒で 1/e） */
export function decay(x, tau, sr) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * Math.exp(-i / (tau * sr));
  return y;
}

/**
 * 先読みのリミッター: ピークを reduction dB 下げる（叩いた瞬間だけを抑え、胴の音はそのまま。そろえたあと全体を上げると音が太くなる）
 * look 秒先まで見て下げ始め、release 秒で戻す
 */
export function limit(x, reduction, sr, { look = 0.0015, release = 0.06 } = {}) {
  const n = x.length;
  const ceil = peak(x) * 10 ** (-reduction / 20);
  const w = Math.max(1, Math.round(look * sr));
  const req = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    req[i] = a > ceil ? ceil / a : 1;
  }
  // 先 w サンプルの最小（ピークより前から下げる）
  const m = new Float64Array(n);
  const dq = [];
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length && req[dq[dq.length - 1]] >= req[i]) dq.pop();
    dq.push(i);
    while (dq[0] > i + w) dq.shift();
    m[i] = req[dq[0]];
  }
  // 前 w サンプルの平均でなめらかに（ピークの所では必ず要る分だけ下がっている）
  const s = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += m[i];
    if (i >= w) acc -= m[i - w];
    s[i] = acc / Math.min(i + 1, w);
  }
  const k = 1 - Math.exp(-1 / (release * sr));
  const y = new Float64Array(n);
  let g = 1;
  for (let i = 0; i < n; i++) {
    g = Math.min(s[i], g + (1 - g) * k);
    y[i] = x[i] * g;
  }
  return y;
}

/** 聞こえる大きさ（K 特性で重みをつけた最初の 0.4 秒の平均。dB）。キットどうし・レーンどうしの音量をそろえるのに使う */
export function loudness(x, sr) {
  let y = biquad(x, { type: 'highshelf', hz: 1681, gain: 4 }, sr);
  y = biquad(y, { type: 'hpf_2p', hz: 38, Q: 0.5 }, sr);
  const n = Math.round(0.4 * sr);
  let s = 0;
  for (let i = 0; i < Math.min(n, y.length); i++) s += y[i] * y[i];
  return -0.691 + 10 * Math.log10(s / n + 1e-12);
}
