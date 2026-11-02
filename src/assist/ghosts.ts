// 候補チップ（ゴースト）。原曲の打点からレーンと位置を推定し、譜面にまだ無いものを薄く出す。
// 自動採譜ではなく耳コピの下書きなので、迷うものは出しすぎない側に倒す。
import { pickOnsets, type Band } from '../audio/analysis';
import { drumChannel, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { snapToGrid, type Pos } from '../edit/ops';

export type GhostLane = 'BD' | 'SD' | 'HH' | 'CY';
export const GHOST_LANES: readonly GhostLane[] = ['BD', 'SD', 'HH', 'CY'];

/** 候補のレーン → 譜面のレーン番号 */
export const GHOST_LANE_INDEX: Record<GhostLane, number> = { BD: 5, SD: 3, HH: 1, CY: 8 };

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
  lane: GhostLane;
  s: number;
}

export interface Ghost {
  key: string;
  lane: number;
  ghostLane: GhostLane;
  pos: Pos;
  beat: number;
  /** 強さ 0〜1 */
  s: number;
  /** 原曲の中の時刻（秒） */
  t: number;
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

// ---- 譜面に置く位置 -------------------------------------------------------------

/** 同じ打点を「もう置いてある」とみなすレーンの組 */
const EXPLAINED_BY: Record<GhostLane, (lane: number, alt: boolean) => boolean> = {
  BD: (lane, alt) => lane === 5 || (lane === 2 && alt),
  SD: (lane) => lane === 3 || lane === 4 || lane === 6 || lane === 7,
  HH: (lane) => lane === 0 || lane === 1 || lane === 8 || lane === 9,
  CY: (lane) => lane === 0 || lane === 1 || lane === 8 || lane === 9,
};

export function ghostKey(lane: GhostLane, p: Pos): string {
  return `${lane}:${p.m}:${p.f.n}/${p.f.d}`;
}

export interface GhostParams {
  /** 原曲の 0 秒が譜面の何秒か（BGMチップの位置） */
  offsetSec: number;
  div: number;
  lanes: Record<GhostLane, boolean>;
  dismissed: ReadonlySet<string>;
}

/** 打点を譜面のグリッドに吸着し、すでに置いてある所と捨てた所を除く */
export function placeGhosts(hits: Hit[], doc: DtxDoc, tempo: TempoMap, p: GhostParams): Ghost[] {
  // レーンの組ごとに、置いてあるチップの拍を並べておく
  const placed: Record<GhostLane, number[]> = { BD: [], SD: [], HH: [], CY: [] };
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d || d.kind === 'nochip') continue;
    const beat = tempo.beatOf(c.m, c.f);
    for (const g of GHOST_LANES) if (EXPLAINED_BY[g](d.lane, d.alt)) placed[g].push(beat);
  }
  for (const g of GHOST_LANES) placed[g].sort((a, b) => a - b);
  const tol = (4 / p.div) * 0.6;
  const near = (arr: number[], b: number) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < b - tol) lo = mid + 1;
      else hi = mid;
    }
    return lo < arr.length && arr[lo] <= b + tol;
  };
  const byKey = new Map<string, Ghost>();
  for (const h of hits) {
    if (!p.lanes[h.lane]) continue;
    const sec = h.t + p.offsetSec;
    if (sec < 0) continue;
    const beat0 = tempo.secToBeat(sec);
    const pos = snapToGrid(tempo, beat0, p.div);
    const beat = tempo.beatOf(pos.m, pos.f);
    if (near(placed[h.lane], beat)) continue;
    const key = ghostKey(h.lane, pos);
    if (p.dismissed.has(key)) continue;
    const prev = byKey.get(key);
    if (prev && prev.s >= h.s) continue;
    byKey.set(key, { key, lane: GHOST_LANE_INDEX[h.lane], ghostLane: h.lane, pos, beat, s: Math.min(1, h.s), t: h.t });
  }
  // シンバルとハイハットが同じ所に出たらシンバルだけ残す
  const out = [...byKey.values()].filter((g) => !(g.ghostLane === 'HH' && byKey.has(ghostKey('CY', g.pos))));
  return out.sort((a, b) => a.beat - b.beat);
}
