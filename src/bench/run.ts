// テスト曲を方式ごとに推定させて採点し、曲をまたいでまとめる。
import { DRUM_CLASSES } from './classes';
import type { BenchMethod } from './methods';
import { scoreEvents, sumScores, type Score } from './score';
import { MIX_KINDS, type MixKind, type TestCase } from './song';
import { CH } from '../dtx/model';

/** 正解のチャンネルの表示名（どのレーンを拾えていないかを見る） */
export const CH_KEY: Record<number, string> = {
  [CH.BD]: 'BD',
  [CH.LBD]: 'LBD',
  [CH.SD]: 'SD',
  [CH.HT]: 'HT',
  [CH.LT]: 'LT',
  [CH.FT]: 'FT',
  [CH.HHC]: 'HHC',
  [CH.HHO]: 'HHO',
  [CH.LP]: 'LP',
  [CH.LC]: 'LC',
  [CH.CY]: 'CY',
  [CH.RD]: 'RD',
};

export interface MethodResult {
  id: string;
  label: string;
  /** かかった時間（ms） */
  ms: number;
  score: Score;
  /** 正解のチャンネルごとの「拾えた数 / 正解の数」 */
  lanes: Record<string, { ref: number; hit: number }>;
}

export interface CaseResult {
  song: string;
  chart: string;
  mix: MixKind;
  duration: number;
  truth: number;
  dropped: number;
  notes: string[];
  methods: MethodResult[];
}

export async function evaluateCase(tc: TestCase, methods: readonly BenchMethod[], tol = 0.05, onMethod?: (m: BenchMethod) => void): Promise<CaseResult> {
  const cache = new Map<string, unknown>();
  const out: MethodResult[] = [];
  for (const m of methods) {
    onMethod?.(m);
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    const est = await m.run({ channels: tc.channels, sr: tc.sr, cache });
    const ms = performance.now() - t0;
    const d = scoreEvents(tc.truth, est, DRUM_CLASSES, tol);
    const lanes: Record<string, { ref: number; hit: number }> = {};
    tc.truth.forEach((h, i) => {
      for (const ch of h.chs) {
        const k = CH_KEY[ch] ?? String(ch);
        lanes[k] ??= { ref: 0, hit: 0 };
        lanes[k].ref++;
        if (d.hitRef.has(i)) lanes[k].hit++;
      }
    });
    out.push({ id: m.id, label: m.label, ms: Math.round(ms), score: d.score, lanes });
  }
  return { song: tc.song, chart: tc.chart, mix: tc.mix, duration: tc.duration, truth: tc.truth.length, dropped: tc.dropped, notes: tc.notes, methods: out };
}

export interface PooledRow {
  mix: MixKind;
  method: string;
  label: string;
  songs: number;
  score: Score;
}

/** 混ぜ方・方式ごとに、全曲の当たり・正解・推定を足して採点し直す */
export function poolResults(results: readonly CaseResult[]): PooledRow[] {
  const rows: PooledRow[] = [];
  const mixes = MIX_KINDS.filter((k) => results.some((r) => r.mix === k));
  for (const mix of mixes) {
    const rs = results.filter((r) => r.mix === mix);
    const ids = [...new Set(rs.flatMap((r) => r.methods.map((m) => m.id)))];
    for (const id of ids) {
      const ms = rs.flatMap((r) => r.methods.filter((m) => m.id === id));
      const score = sumScores(ms.map((m) => m.score));
      if (score) rows.push({ mix, method: id, label: ms[0].label, songs: ms.length, score });
    }
  }
  return rows;
}
