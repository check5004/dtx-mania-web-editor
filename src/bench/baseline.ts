// 段階0で外した「候補チップ」の検出（v0 方式）。精度テストで今後の方式と比べるために残す。
// 混ざった原曲を3帯域（低・中・高）に分け、帯域ごとの打点をまとめて BD・SD・HH・CY に振り分けるだけの方式。
import { pickOnsets, type Band } from '../audio/analysis';

export type BaselineLane = 'BD' | 'SD' | 'HH' | 'CY';

export interface HitEvent {
  /** 原曲の中の時刻（秒） */
  t: number;
  low: number;
  mid: number;
  high: number;
  /** 高域の残り具合（0〜1。シンバルは長く残る） */
  sustain: number;
}

export interface Hit {
  t: number;
  lane: BaselineLane;
  s: number;
}

export interface AnalysisLike {
  frameRate: number;
  odf: Record<Band, Float32Array>;
  env: Record<Band, Float32Array>;
}

/** 3帯域の打点を、近いもの（25ms以内）どうしで1つの出来事にまとめる */
export function detectEvents(a: AnalysisLike, sensitivity: number): HitEvent[] {
  const all: { t: number; s: number; b: Band }[] = [];
  for (const b of ['low', 'mid', 'high'] as const) for (const o of pickOnsets(a.odf[b], a.frameRate, sensitivity)) all.push({ ...o, b });
  all.sort((x, y) => x.t - y.t);
  const out: HitEvent[] = [];
  let cur: HitEvent | null = null;
  let start = -1;
  for (const o of all) {
    if (!cur || o.t - start > 0.025) {
      cur = { t: o.t, low: 0, mid: 0, high: 0, sustain: 0 };
      start = o.t;
      out.push(cur);
    }
    if (o.s > cur[o.b]) cur[o.b] = o.s;
    // 時刻は低域 > 中域 > 高域の順に信用する（低域が一番遅れにくいわけではないが、まとめ方をそろえる）
    if (o.t < cur.t) cur.t = o.t;
  }
  // 長く残るか（シンバルらしさ）: 次の高域の打点の手前までで、いちばん下がった所の強さ
  const env = a.env.high;
  const fr = a.frameRate;
  for (let k = 0; k < out.length; k++) {
    const e = out[k];
    if (e.high <= 0) continue;
    const i = Math.round(e.t * fr);
    let peak = 0;
    for (let j = i; j < i + Math.round(0.03 * fr) && j < env.length; j++) if (env[j] > peak) peak = env[j];
    let next = Infinity;
    for (let q = k + 1; q < out.length; q++) {
      if (out[q].high > 0) {
        next = out[q].t;
        break;
      }
    }
    const from = e.t + 0.05;
    const to = Math.max(from + 0.04, Math.min(e.t + 0.35, next - 0.015));
    let low = Infinity;
    for (let j = Math.round(from * fr); j <= Math.round(to * fr) && j < env.length; j++) if (env[j] < low) low = env[j];
    if (!Number.isFinite(low)) low = 0;
    e.sustain = peak > 1e-6 ? Math.min(1, low / peak) : 0;
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * 出来事をレーンに振り分ける。
 * - 低域 → バスドラム
 * - 中域 → スネア。ただしキックと同時で、キックの中域への漏れ（曲の中の典型的な比）程度なら出さない
 * - 高域 → ハイハット。長く残る強い音はシンバル。スネアと同時でスネアのノイズ程度なら出さない
 */
export function classifyEvents(events: HitEvent[]): Hit[] {
  const kickRatio = median(events.filter((e) => e.low >= 0.5).map((e) => e.mid / e.low));
  const out: Hit[] = [];
  for (const e of events) {
    const bd = e.low > 0;
    if (bd) out.push({ t: e.t, lane: 'BD', s: e.low });
    const sd = e.mid > 0 && !(bd && e.mid < Math.max(0.15, 1.3 * kickRatio * e.low));
    if (sd) out.push({ t: e.t, lane: 'SD', s: e.mid });
    if (e.high > 0 && !(sd && e.high < 0.45 * e.mid)) {
      const crash = e.sustain >= 0.4 && e.high >= 0.55;
      out.push({ t: e.t, lane: crash ? 'CY' : 'HH', s: e.high });
    }
  }
  return out;
}
