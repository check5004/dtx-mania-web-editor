// 音の切り出し（ステム・原曲から、チップを置いた所の音を 1 つの WAV にする）の中身。画面は ui/CutDialog、操作は store/cut。
// 決まり（承認済みのデザインの「音の切り出し」）:
// - チップの時刻の前後 30 ms で鳴り始めを探し、その 2 ms 前から切る。終わりは次の音の 16 ms 手前まで（長くても 1 秒）。
// - フェードアウト 40 ms。低い音を弱める（150 Hz より下。バスドラムの混ざりを減らす）。いちばん大きい所を −1 dB にそろえる。
// - 重ねる: 何か所かを鳴り始めでそろえて（相互相関で 1 サンプルまで）平均する。毎回は鳴っていない音（ハイハットの残りなど）が小さくなる。
// 画面の外（テスト）でも動くように、AudioBuffer ではなく Pcm（チャンネルごとの Float32Array）で扱う。
import { applyChain, biquad, downmix } from './dsp';

export interface Pcm {
  sr: number;
  ch: Float32Array[];
}

export const CUT_PRE_MS = 2;
export const CUT_SEARCH_MS = 30;
export const CUT_GAP_MS = 16;
export const CUT_MAX_MS = 1000;
export const CUT_MIN_MS = 40;
export const CUT_FADE_MS = 40;
export const LOWCUT_HZ = 150;
export const PEAK_DB = -1;

export const msToSamples = (sr: number, ms: number) => Math.round((sr * ms) / 1000);

export function pcmLength(p: Pcm): number {
  return p.ch[0]?.length ?? 0;
}

/** AudioBuffer（や同じ形の物）の中身。コピーしない */
export function pcmOf(buf: { sampleRate: number; numberOfChannels: number; getChannelData(c: number): Float32Array }): Pcm {
  return { sr: buf.sampleRate, ch: Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c)) };
}

/** from〜to（サンプル）を取り出す。範囲の外は 0 */
export function slicePcm(p: Pcm, from: number, to: number): Pcm {
  const n = Math.max(0, to - from);
  return {
    sr: p.sr,
    ch: p.ch.map((x) => {
      const out = new Float32Array(n);
      const a = Math.max(0, from);
      const b = Math.min(x.length, to);
      if (b > a) out.set(x.subarray(a, b), a - from);
      return out;
    }),
  };
}

/** 左右を混ぜた絶対値の、hop サンプルごとの最大（from〜to。範囲の外は 0） */
function envelope(p: Pcm, from: number, to: number, hop: number): Float32Array {
  const n = Math.max(1, Math.ceil((to - from) / hop));
  const env = new Float32Array(n);
  const len = pcmLength(p);
  const k = 1 / p.ch.length;
  for (let i = 0; i < n; i++) {
    const a = from + i * hop;
    let mx = 0;
    for (let s = Math.max(0, a); s < Math.min(len, a + hop); s++) {
      let v = 0;
      for (const x of p.ch) v += x[s];
      v = Math.abs(v * k);
      if (v > mx) mx = v;
    }
    env[i] = mx;
  }
  return env;
}

export interface Onset {
  /** 鳴り始め（サンプル） */
  at: number;
  /** 鳴った音のいちばん大きい所（振幅 0〜1） */
  peak: number;
  /** 鳴り始めの前（4 ms）の大きさ（振幅） */
  before: number;
  /** 音が見つかったか（見つからなければ at は探した時刻のまま） */
  found: boolean;
}

/**
 * at（サンプル）の前後 search ms で鳴り始めを探す。包絡がいちばん大きく立ち上がる所を見つけ、
 * そこからいちばん大きい所までのうち、前の大きさから立ち上がりの 1 割を超えた所を鳴り始めにする。
 * 前の音が鳴り続けていても、その上に立ち上がった所を取る
 */
export function findOnset(p: Pcm, at: number, search = CUT_SEARCH_MS): Onset {
  const sr = p.sr;
  const hop = Math.max(1, msToSamples(sr, 0.5));
  const lo = at - msToSamples(sr, search + 12);
  const hi = at + msToSamples(sr, search + 40);
  const env = envelope(p, lo, hi, hop);
  const idx = (s: number) => Math.max(0, Math.min(env.length - 1, Math.floor((s - lo) / hop)));
  const k0 = idx(at - msToSamples(sr, search));
  const k1 = idx(at + msToSamples(sr, search));
  const ahead = 4;
  const behind = 8;
  let best = -1;
  let bestRise = 0;
  for (let k = k0; k <= k1; k++) {
    let a = 0;
    for (let j = k; j < Math.min(env.length, k + ahead); j++) a = Math.max(a, env[j]);
    let b = 0;
    for (let j = Math.max(0, k - behind); j < k; j++) b = Math.max(b, env[j]);
    const rise = a - b;
    if (rise > bestRise) {
      bestRise = rise;
      best = k;
    }
  }
  if (best < 0 || bestRise < 1e-4) return { at, peak: 0, before: 0, found: false };
  let pk = best;
  for (let j = best; j < Math.min(env.length, best + 40); j++) if (env[j] > env[pk]) pk = j;
  const peak = env[pk];
  let base = 0;
  for (let j = Math.max(0, best - behind); j < best; j++) base = Math.max(base, env[j]);
  const th = base + (peak - base) * 0.1;
  let k = pk;
  while (k > Math.max(0, best - behind) && env[k - 1] > th) k--;
  // 包絡の hop の中で、しきい値を超えた最初のサンプル
  let s = lo + Math.max(0, k - 1) * hop;
  const end = lo + pk * hop + hop;
  const len = pcmLength(p);
  const kk = 1 / p.ch.length;
  for (; s < end; s++) {
    if (s < 0 || s >= len) continue;
    let v = 0;
    for (const x of p.ch) v += x[s];
    if (Math.abs(v * kk) > th) break;
  }
  return { at: Math.min(s, lo + pk * hop), peak, before: base, found: true };
}

export interface CutRange {
  /** 切り始め（サンプル） */
  start: number;
  /** 切り終わり（サンプル） */
  end: number;
  onset: Onset;
  /** 次の音の鳴り始め（無ければ null） */
  next: number | null;
}

/**
 * 1 か所の切り方（自動）。鳴り始めの 2 ms 前（align を外すとチップの時刻）から、次の音の 16 ms 手前まで。
 * 長くても 1 秒、短くても 40 ms。nextAt は譜面の次のチップの時刻（サンプル。その前後で次の音の鳴り始めを探す）
 */
export function autoRange(p: Pcm, at: number, nextAt: number | null, o: { align: boolean; lenMs?: number | null } = { align: true }): CutRange {
  const sr = p.sr;
  const onset = findOnset(p, at);
  const head = onset.found ? onset.at : at;
  const start = o.align ? head - msToSamples(sr, CUT_PRE_MS) : at;
  let next: number | null = null;
  if (nextAt !== null) {
    const n = findOnset(p, nextAt, 12);
    next = n.found && n.at > head + msToSamples(sr, 8) ? n.at : nextAt;
  }
  let end = start + msToSamples(sr, CUT_MAX_MS);
  if (next !== null) end = Math.min(end, next - msToSamples(sr, CUT_GAP_MS));
  if (o.lenMs) end = start + msToSamples(sr, o.lenMs);
  end = Math.max(end, start + msToSamples(sr, CUT_MIN_MS));
  return { start, end, onset, next };
}

export interface Shape {
  /** 低い音を弱める（150 Hz より下） */
  lowCut: boolean;
  /** いちばん大きい所を −1 dB にそろえる */
  normalize: boolean;
  /** 左右を混ぜて 1 チャンネルに */
  mono: boolean;
  /** フェードアウト（ms） */
  fadeMs: number;
}

export const DEFAULT_SHAPE: Shape = { lowCut: true, normalize: true, mono: false, fadeMs: CUT_FADE_MS };

/** 低い音を弱める（2 次の高域通過を 2 回。前の 30 ms から通して、フィルタの立ち上がりを切り落とす） */
function lowCut(x: Float32Array, pre: number, sr: number): Float32Array {
  const hp = biquad('highpass', LOWCUT_HZ, Math.SQRT1_2, sr);
  return applyChain(x, [hp, hp]).subarray(pre);
}

/** 頭を 1 ms で開き、終わりを fadeMs で閉じる（cos の形） */
function fade(x: Float32Array, sr: number, fadeMs: number) {
  const a = Math.min(x.length, msToSamples(sr, 1));
  for (let i = 0; i < a; i++) x[i] *= i / a;
  const f = Math.min(x.length, msToSamples(sr, fadeMs));
  for (let i = 0; i < f; i++) {
    const t = i / f;
    x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * t);
  }
}

export function peakOf(p: Pcm): number {
  let mx = 0;
  for (const x of p.ch) for (let i = 0; i < x.length; i++) mx = Math.max(mx, Math.abs(x[i]));
  return mx;
}

/** 整える: 低い音を弱め、左右を混ぜ、頭と終わりを閉じ、いちばん大きい所を −1 dB に */
export function shapePcm(p: Pcm, s: Shape, pre = 0): Pcm {
  // どれも新しい配列（元の音は書き換えない）
  let ch = p.ch.map((x) => (s.lowCut ? lowCut(x, pre, p.sr) : x.slice(pre)));
  if (s.mono && ch.length > 1) ch = [downmix(ch)];
  for (const x of ch) fade(x, p.sr, s.fadeMs);
  const out = { sr: p.sr, ch };
  if (s.normalize) {
    const pk = peakOf(out);
    if (pk > 1e-6) {
      const g = 10 ** (PEAK_DB / 20) / pk;
      for (const x of ch) for (let i = 0; i < x.length; i++) x[i] *= g;
    }
  }
  return out;
}

/** start〜end を切り出して整える */
export function cutPcm(p: Pcm, start: number, end: number, s: Shape): Pcm {
  const pre = s.lowCut ? msToSamples(p.sr, 30) : 0;
  return shapePcm(slicePcm(p, start - pre, end), s, pre);
}

/** 2 つの大きさの比（dB）。小さすぎる物は -120 dB */
export const toDb = (ratio: number) => (ratio > 1e-6 ? 20 * Math.log10(ratio) : -120);

function rms(x: Float32Array, from = 0, to = x.length): number {
  let e = 0;
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return b > a ? Math.sqrt(e / (b - a)) : 0;
}

/** 低い音（150 Hz より下）の割合（dB。音全体に対して） */
export function lowShareDb(p: Pcm): number {
  const x = downmix(p.ch);
  const lp = biquad('lowpass', LOWCUT_HZ, Math.SQRT1_2, p.sr);
  const low = applyChain(x, [lp, lp]);
  return toDb(rms(low) / Math.max(1e-9, rms(x)));
}

export interface Stack {
  out: Pcm;
  /** それぞれの所を、1 つ目に合わせてずらしたサンプル数 */
  shifts: number[];
  /** 1 か所だけの音に入っているほかの音（重ねた音との違い。dB） */
  single: number;
  /** 重ねた音に残るほかの音（dB） */
  stacked: number;
}

/** 低い音を弱めた音（新しい配列） */
export function lowCutPcm(p: Pcm): Pcm {
  return { sr: p.sr, ch: p.ch.map((x) => lowCut(x, 0, p.sr)) };
}

/**
 * 重ねる: list の音（どれも鳴り始めの 2 ms 前から切った、整える前の音）を、1 つ目の鳴り始めにそろえて平均する。
 * low を付けると先に低い音を弱める（同時に鳴ったバスドラムで、そろえ方と大きさが狂わないように）。
 * そろえるのは頭の 30 ms の相互相関（±3 ms。400 Hz より上で見る）。大きさは頭の 50 ms の RMS を 1 つ目に合わせる。
 * 長さはいちばん短い所に合わせる
 */
export function stackPcm(list0: readonly Pcm[], o: { low?: boolean } = {}, maxShiftMs = 3): Stack {
  const list = o.low ? list0.map(lowCutPcm) : list0;
  const ref = list[0];
  const sr = ref.sr;
  const nch = Math.min(...list.map((p) => p.ch.length));
  const hp = biquad('highpass', 400, Math.SQRT1_2, sr);
  const monos = list.map((p) => applyChain(downmix(p.ch), [hp, hp]));
  const W = msToSamples(sr, 30);
  const L = msToSamples(sr, maxShiftMs);
  const r0 = monos[0];
  const shifts = monos.map((m, i) => {
    if (i === 0) return 0;
    let best = 0;
    let bestC = -Infinity;
    for (let lag = -L; lag <= L; lag++) {
      let c = 0;
      for (let n = 0; n < W; n++) {
        const j = n + lag;
        if (j < 0 || j >= m.length || n >= r0.length) continue;
        c += r0[n] * m[j];
      }
      if (c > bestC) {
        bestC = c;
        best = lag;
      }
    }
    return best;
  });
  const head = msToSamples(sr, 50);
  const full = list.map((p) => downmix(p.ch));
  const refRms = rms(full[0], 0, head);
  const gains = full.map((m, i) => {
    const r = rms(m, shifts[i], shifts[i] + head);
    return r > 1e-9 ? refRms / r : 0;
  });
  // そろえたあとの長さ（どれにも音がある所まで）
  let len = Infinity;
  list.forEach((p, i) => (len = Math.min(len, pcmLength(p) - Math.max(0, shifts[i]))));
  len = Math.max(0, Math.floor(len));
  const ch = Array.from({ length: nch }, () => new Float32Array(len));
  const used = list.filter((_, i) => gains[i] > 0).length || 1;
  list.forEach((p, i) => {
    const g = gains[i] / used;
    if (!g) return;
    for (let c = 0; c < nch; c++) {
      const x = p.ch[c];
      const y = ch[c];
      for (let n = 0; n < len; n++) {
        const j = n + shifts[i];
        if (j >= 0 && j < x.length) y[n] += x[j] * g;
      }
    }
  });
  // 1 か所ずつの音と重ねた音の違い（毎回は鳴っていない音）。重ねると数の分だけ小さくなる
  let er = 0;
  let es = 0;
  list.forEach((p, i) => {
    if (!gains[i]) return;
    for (let c = 0; c < nch; c++) {
      const x = p.ch[c];
      const y = ch[c];
      for (let n = 0; n < len; n++) {
        const j = n + shifts[i];
        const v = j >= 0 && j < x.length ? x[j] * gains[i] : 0;
        er += (v - y[n]) ** 2;
      }
    }
  });
  for (const y of ch) for (let n = 0; n < len; n++) es += y[n] * y[n];
  const single = es > 0 ? 10 * Math.log10(Math.max(1e-12, er / used / es)) : -120;
  const stacked = used > 1 ? single - 10 * Math.log10(used) : single;
  return { out: { sr, ch }, shifts, single, stacked };
}

/** 16bit の WAV にする */
export function wavBytes(p: Pcm): Uint8Array {
  const nch = p.ch.length;
  const len = pcmLength(p);
  const bytes = new Uint8Array(44 + len * nch * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + len * nch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, p.sr, true);
  v.setUint32(28, p.sr * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, len * nch * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, p.ch[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return bytes;
}

/** WAV にしたときの大きさ（バイト） */
export const wavSize = (p: Pcm) => 44 + pcmLength(p) * p.ch.length * 2;

/** 波形の形（列ごとの最大と最小。描く用） */
export function minMax(x: Float32Array, from: number, to: number, cols: number): { lo: Float32Array; hi: Float32Array } {
  const lo = new Float32Array(cols);
  const hi = new Float32Array(cols);
  const span = (to - from) / cols;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(from + c * span);
    const b = Math.max(a + 1, Math.floor(from + (c + 1) * span));
    let mn = 0;
    let mx = 0;
    for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) {
      if (x[i] < mn) mn = x[i];
      if (x[i] > mx) mx = x[i];
    }
    lo[c] = mn;
    hi[c] = mx;
  }
  return { lo, hi };
}

/** 鳴り始めの前（30 ms〜2 ms 前）の大きさ（dB。鳴った音のいちばん大きい所に対して） */
export function preDb(p: Pcm, onset: Onset): number {
  if (!onset.found || onset.peak <= 0) return 0;
  // 見る所だけを混ぜる（曲全体を混ぜると、候補ごとに何百 ms もかかる）
  const len = pcmLength(p);
  const from = Math.max(0, onset.at - msToSamples(p.sr, 30));
  const to = Math.min(len, onset.at - msToSamples(p.sr, 2));
  if (to <= from) return toDb(0);
  const r = rms(downmix(slicePcm(p, from, to).ch));
  return toDb(r / onset.peak);
}

// ---- 似た所を選ぶ（重ねる所のおすすめ） ----------------------------------------------------

const FP_MS = 40;
const SIM_LAG_MS = 2;

/** 似かたを比べる形: 400 Hz より上のモノラルの、頭の 40 ms（鳴り始めの 2 ms 前から切った音に使う） */
export function fingerprint(p: Pcm): Float32Array {
  const n = Math.min(pcmLength(p), msToSamples(p.sr, FP_MS + SIM_LAG_MS));
  const hp = biquad('highpass', 400, Math.SQRT1_2, p.sr);
  return applyChain(downmix(slicePcm(p, 0, n).ch), [hp, hp]);
}

/** 2 つの形の似かた（±2 ms ずらしたときの正規化した相互相関のいちばん大きい値。0〜1） */
export function similarity(a: Float32Array, b: Float32Array, sr: number): number {
  const L = msToSamples(sr, SIM_LAG_MS);
  const W = Math.min(a.length, msToSamples(sr, FP_MS));
  let ea = 0;
  for (let i = 0; i < W; i++) ea += a[i] * a[i];
  let best = 0;
  for (let lag = -L; lag <= L; lag++) {
    let s = 0;
    let eb = 0;
    for (let i = 0; i < W; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      s += a[i] * b[j];
      eb += b[j] * b[j];
    }
    const c = s / Math.sqrt(ea * eb + 1e-12);
    if (c > best) best = c;
  }
  return best;
}

/**
 * 重ねる所のおすすめ: order（重なりの少ない順の候補の番号）の初めの方から、ほかといちばん似ている所を 1 つ選び、
 * それと似ている所（0.35 以上）を似ている順に max 個まで。鳴り始めを取り違えた所や、ほかの音が大きい所は入らない
 */
export function recommend(fps: readonly Float32Array[], order: readonly number[], sr: number, max = 8, pool = 16): number[] {
  const cand = order.slice(0, pool);
  if (cand.length <= 1) return cand.slice();
  const sim = cand.map(() => new Float32Array(cand.length));
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const v = similarity(fps[cand[i]], fps[cand[j]], sr);
      sim[i][j] = v;
      sim[j][i] = v;
    }
  }
  let center = 0;
  let bestSum = -1;
  sim.forEach((row, i) => {
    const sum = row.reduce((s, v) => s + v, 0);
    if (sum > bestSum) {
      bestSum = sum;
      center = i;
    }
  });
  const rest = cand
    .map((c, i) => ({ c, v: sim[center][i], i }))
    .filter((x) => x.i !== center && x.v >= 0.35)
    .sort((a, b) => b.v - a.v)
    .slice(0, max - 1)
    .map((x) => x.c);
  return [cand[center], ...rest];
}
