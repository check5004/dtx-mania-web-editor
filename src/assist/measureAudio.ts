// 原曲の聞こえ方を小節ごとにまとめ、2つの小節がどれだけ同じに聞こえるかを出す（TAB補完の「曲の構造」）。
// 和音（拍ごとのクロマ）・音色（拍ごとの帯域の音量）・リズム（16分ごとの立ち上がり）の3つを比べる。
// どれも曲全体の平均との差で比べるので、曲じゅう同じように鳴っている成分では「似ている」にならない。
import { FLUX_BANDS, type FrameFeatures } from '../audio/features';
import type { TempoMap } from '../dtx/timing';
import type { AudioSimilarity } from './complete';

export interface OnsetBands {
  /** 1秒あたりのフレーム数 */
  rate: number;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export interface MeasureAudioSource {
  frames: FrameFeatures;
  /** 帯域ごとの立ち上がり（原曲の解析）。無ければリズムは比べない */
  onsets?: OnsetBands | null;
  /** 原曲の 0 秒が譜面の何秒か（BGM のチップの位置） */
  offsetSec: number;
  /** 原曲の長さ（秒） */
  duration: number;
}

export interface AudioWeights {
  chroma: number;
  timbre: number;
  /** 3帯域の立ち上がり（原曲の解析の打点） */
  rhythm: number;
  /** 8帯域の立ち上がり */
  flux: number;
}

/** 精度テストで決めた重み（どの組み合わせでもほぼ同じ点。打点を重く、和音は軽く） */
export const DEFAULT_AUDIO_WEIGHTS: AudioWeights = { chroma: 0.5, timbre: 1, rhythm: 0, flux: 2 };

type Block = 'chroma' | 'timbre' | 'rhythm' | 'flux';
const BLOCKS: readonly Block[] = ['chroma', 'timbre', 'rhythm', 'flux'];

interface MeasureVec {
  /** 長さの種類（拍の数と16分の数）。違う長さの小節どうしは比べない */
  shape: string;
  raw: Partial<Record<Block, Float32Array>>;
  vec: Partial<Record<Block, Float32Array>>;
}

export interface MeasureAudio extends AudioSimilarity {
  /** 原曲が鳴っている小節か */
  has(m: number): boolean;
  last: number;
}

/** 小節 0〜last の聞こえ方をまとめる */
export function measureAudio(src: MeasureAudioSource, tempo: TempoMap, last: number, weights: AudioWeights = DEFAULT_AUDIO_WEIGHTS): MeasureAudio {
  const fr = src.frames;
  const NB = fr.bands.length / Math.max(1, fr.frames);
  const vecs: (MeasureVec | null)[] = [];
  const toAudio = (beat: number) => tempo.beatToSec(beat) - src.offsetSec;
  const frameAt = (sec: number) => sec * fr.rate - fr.offset;
  for (let m = 0; m <= last; m++) {
    const start = tempo.measureStart(m);
    const beats = tempo.measureBeats(m);
    const a0 = toAudio(start);
    const a1 = toAudio(start + beats);
    // 半分以上が原曲の外なら比べない
    const inside = Math.max(0, Math.min(a1, src.duration) - Math.max(a0, 0));
    if (a1 <= a0 || inside < (a1 - a0) * 0.5) {
      vecs.push(null);
      continue;
    }
    const nb = Math.max(1, Math.round(beats));
    const steps = Math.max(4, Math.round(beats * 4));
    const raw: MeasureVec['raw'] = {};
    if (weights.chroma > 0 || weights.timbre > 0) {
      const chroma = new Float32Array(nb * 12);
      const timbre = new Float32Array(nb * NB);
      for (let b = 0; b < nb; b++) {
        const t0 = toAudio(start + (b * beats) / nb);
        const t1 = toAudio(start + ((b + 1) * beats) / nb);
        let f0 = Math.ceil(frameAt(t0));
        let f1 = Math.floor(frameAt(t1));
        if (f1 < f0) f0 = f1 = Math.round(frameAt((t0 + t1) / 2));
        f0 = Math.max(0, f0);
        f1 = Math.min(fr.frames - 1, f1);
        let n = 0;
        for (let f = f0; f <= f1; f++) {
          for (let k = 0; k < 12; k++) chroma[b * 12 + k] += fr.chroma[f * 12 + k];
          for (let k = 0; k < NB; k++) timbre[b * NB + k] += fr.bands[f * NB + k];
          n++;
        }
        if (n > 0) {
          let s = 0;
          for (let k = 0; k < 12; k++) s += chroma[b * 12 + k] ** 2;
          s = Math.sqrt(s) || 1;
          for (let k = 0; k < 12; k++) chroma[b * 12 + k] /= s;
          for (let k = 0; k < NB; k++) timbre[b * NB + k] /= n;
        }
      }
      raw.chroma = chroma;
      raw.timbre = timbre;
    }
    if (weights.rhythm > 0 && src.onsets) {
      const o = src.onsets;
      const rhythm = new Float32Array(steps * 3);
      const half = beats / steps / 2;
      for (let i = 0; i < steps; i++) {
        const c = start + (i * beats) / steps;
        const lo = Math.max(0, Math.floor(toAudio(c - half) * o.rate));
        const hi = Math.ceil(toAudio(c + half) * o.rate);
        [o.low, o.mid, o.high].forEach((band, bi) => {
          let mx = 0;
          for (let k = lo; k <= hi && k < band.length; k++) if (band[k] > mx) mx = band[k];
          rhythm[i * 3 + bi] = mx;
        });
      }
      raw.rhythm = rhythm;
    }
    if (weights.flux > 0 && fr.fluxFrames > 0) {
      const flux = new Float32Array(steps * FLUX_BANDS);
      const half = beats / steps / 2;
      for (let i = 0; i < steps; i++) {
        const c = start + (i * beats) / steps;
        const lo = Math.max(0, Math.floor(toAudio(c - half) * fr.fluxRate - fr.fluxOffset));
        const hi = Math.min(fr.fluxFrames - 1, Math.ceil(toAudio(c + half) * fr.fluxRate - fr.fluxOffset));
        for (let b = 0; b < FLUX_BANDS; b++) {
          let mx = 0;
          for (let k = lo; k <= hi; k++) {
            const v = fr.flux[k * FLUX_BANDS + b];
            if (v > mx) mx = v;
          }
          flux[i * FLUX_BANDS + b] = mx;
        }
      }
      raw.flux = flux;
    }
    vecs.push({ shape: `${nb}:${steps}`, raw, vec: {} });
  }
  // 同じ長さの小節どうしで平均を引き、長さ1にそろえる
  const groups = new Map<string, MeasureVec[]>();
  for (const v of vecs) {
    if (!v) continue;
    let g = groups.get(v.shape);
    if (!g) groups.set(v.shape, (g = []));
    g.push(v);
  }
  for (const g of groups.values()) {
    for (const bl of BLOCKS) {
      const first = g[0].raw[bl];
      if (!first) continue;
      const mean = new Float32Array(first.length);
      for (const v of g) {
        const r = v.raw[bl]!;
        for (let i = 0; i < r.length; i++) mean[i] += r[i] / g.length;
      }
      for (const v of g) {
        const r = v.raw[bl]!;
        const out = new Float32Array(r.length);
        let s = 0;
        for (let i = 0; i < r.length; i++) {
          out[i] = r[i] - mean[i];
          s += out[i] * out[i];
        }
        s = Math.sqrt(s);
        if (s > 1e-9) for (let i = 0; i < r.length; i++) out[i] /= s;
        v.vec[bl] = out;
      }
    }
  }
  const memo = new Map<number, number | null>();
  const W = last + 1;
  return {
    last,
    has: (m) => m >= 0 && m <= last && vecs[m] !== null,
    sim(a, b) {
      if (a < 0 || b < 0 || a > last || b > last) return null;
      const key = a < b ? a * W + b : b * W + a;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const va = vecs[a];
      const vb = vecs[b];
      let r: number | null = null;
      if (va && vb && va.shape === vb.shape) {
        let s = 0;
        let ws = 0;
        for (const bl of BLOCKS) {
          const w = weights[bl];
          const x = va.vec[bl];
          const y = vb.vec[bl];
          if (!(w > 0) || !x || !y) continue;
          let d = 0;
          for (let i = 0; i < x.length; i++) d += x[i] * y[i];
          s += w * d;
          ws += w;
        }
        r = ws > 0 ? s / ws : null;
      }
      memo.set(key, r);
      return r;
    },
  };
}
