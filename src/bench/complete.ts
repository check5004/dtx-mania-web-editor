// TAB補完の精度テスト。打ち終わっている譜面を「前から順に打っている途中」とみなし、
// 小節 at より前だけを入力済みにして先の4小節を予測させ、正解（その譜面の続き）と比べる。
// チップはチャンネルと小節の中の位置が同じなら当たり（WAV は見ない）。
import {
  contentSim,
  measureContents,
  noteKey,
  predictBlock,
  predictChain,
  type AudioSimilarity,
  type Candidate,
  type ChartSource,
  type MeasureContent,
  type PredictOptions,
} from '../assist/complete';
import type { DtxDoc } from '../dtx/model';
import { tempoOf } from '../store/derived';

/** 何小節先まで測るか */
export const AHEAD = 4;

export interface CompletionMethod {
  id: string;
  label: string;
  note: string;
  /** 原曲の聞こえ方を使うか（使う方式は、原曲が無い曲では測らない） */
  audio?: boolean;
  pick(chart: ChartSource, at: number, audio: AudioSimilarity | null, truth: (m: number) => MeasureContent | undefined): Candidate | null;
}

/** 先の i 小節目（0 が次の小節）ごとの集計 */
export interface OffsetStats {
  /** 予測した小節の数（at の数） */
  blocks: number;
  /** 点線を出した小節（中身のある予測） */
  shown: number;
  /** 出した小節のうち、正解とまったく同じだった数 */
  exact: number;
  tp: number;
  fp: number;
  fn: number;
  /** 正解のチップの数（出さなかった小節も含む） */
  refAll: number;
  /** 正解が空でない小節の数 */
  nonEmpty: number;
}

export interface CalibPoint {
  score: number;
  /** 次の小節がまったく同じだったか */
  exact: boolean;
  /** 次の小節のチップの F 値 */
  f: number;
}

export interface MethodCompletion {
  id: string;
  label: string;
  offsets: OffsetStats[];
  calib: CalibPoint[];
  ms: number;
}

export interface ChartCompletion {
  song: string;
  chart: string;
  /** 測った小節の数 */
  blocks: number;
  audio: boolean;
  methods: MethodCompletion[];
}

const emptyStats = (): OffsetStats => ({ blocks: 0, shown: 0, exact: 0, tp: 0, fp: 0, fn: 0, refAll: 0, nonEmpty: 0 });

/** 予測と正解の1小節を比べる */
export function compareMeasure(pred: readonly { ch: number; f: { n: number; d: number } }[], truth: MeasureContent | undefined) {
  const ref = truth?.keys ?? new Set<string>();
  const est = new Set(pred.map((n) => noteKey(n.ch, n.f as never)));
  let tp = 0;
  for (const k of est) if (ref.has(k)) tp++;
  return { tp, fp: est.size - tp, fn: ref.size - tp, exact: tp === ref.size && tp === est.size };
}

/** 入力済みを at より前に限った譜面の見方 */
export function historyView(doc: DtxDoc, at: number): ChartSource {
  const all = measureContents(doc);
  const contents = new Map<number, MeasureContent>();
  for (const [m, c] of all) if (m < at) contents.set(m, c);
  const tempo = tempoOf(doc);
  return { contents, barLen: (m) => tempo.barLen(m), canCopy: (m) => m >= 0 && m < at };
}

export function evaluateCompletion(song: string, chart: string, doc: DtxDoc, methods: readonly CompletionMethod[], audio: AudioSimilarity | null): ChartCompletion {
  const truthAll = measureContents(doc);
  const ms = [...truthAll.keys()].filter((m) => (truthAll.get(m)?.keys.size ?? 0) > 0);
  const first = Math.min(...ms);
  const last = Math.max(...ms);
  const truth = (m: number) => truthAll.get(m);
  const out: MethodCompletion[] = [];
  let blocks = 0;
  for (const method of methods) {
    if (method.audio && !audio) continue;
    const offsets = Array.from({ length: AHEAD }, emptyStats);
    const calib: CalibPoint[] = [];
    const t0 = performance.now();
    blocks = 0;
    for (let at = first + 1; at <= last; at++) {
      blocks++;
      const view = historyView(doc, at);
      const cand = method.pick(view, at, audio, truth);
      for (let i = 0; i < AHEAD; i++) {
        const st = offsets[i];
        const tr = truth(at + i);
        st.blocks++;
        st.refAll += tr?.keys.size ?? 0;
        if (tr && tr.keys.size) st.nonEmpty++;
        const pred = cand?.measures[i];
        if (!pred || pred.length === 0) continue;
        const r = compareMeasure(pred, tr);
        st.shown++;
        st.tp += r.tp;
        st.fp += r.fp;
        st.fn += r.fn;
        if (r.exact) st.exact++;
      }
      if (cand && cand.measures[0]?.length) {
        const r = compareMeasure(cand.measures[0], truth(at));
        calib.push({ score: cand.score, exact: r.exact, f: (2 * r.tp) / Math.max(1, 2 * r.tp + r.fp + r.fn) });
      }
    }
    out.push({ id: method.id, label: method.label, offsets, calib, ms: Math.round(performance.now() - t0) });
  }
  return { song, chart, blocks, audio: !!audio, methods: out };
}

// ---- 比べる方式 -----------------------------------------------------------------------

/** 直前の小節をそのまま続ける（Ctrl+D と同じ。物差しの基準） */
export const PREV_MEASURE: CompletionMethod = {
  id: 'prev',
  label: '直前の小節を続ける',
  note: '直前の1小節を、先の4小節にそのまま写す（Ctrl+D を続けたのと同じ）。基準',
  pick(chart, at) {
    const c = chart.contents.get(at - 1);
    if (!c || c.notes.length === 0) return null;
    const measures = [];
    for (let i = 0; i < AHEAD; i++) {
      if (Math.abs(chart.barLen(at + i) - chart.barLen(at - 1)) > 1e-9) break;
      measures.push(c.notes);
    }
    return { kind: 'context', from: at, measures, src: at - 1, score: 1, ctx: 1, audio: null, period: 1 };
  },
};

type Extra = Pick<PredictOptions, 'scorer' | 'audioCut'>;

export function contextMethod(id: string, label: string, extra: Extra = {}, minScore = 0): CompletionMethod {
  return {
    id,
    label,
    note: '直前の数小節と同じ・似た並びを前から探し、そのときの続きを写す（譜面だけ）',
    pick(chart, at) {
      const c = predictBlock(chart, { at, len: AHEAD, ...extra })[0] ?? null;
      return c && c.score >= minScore ? c : null;
    },
  };
}

export function audioMethod(id: string, label: string, extra: Extra = {}, minScore = 0): CompletionMethod {
  return {
    id,
    label,
    note: '原曲で先の小節と同じに聞こえる、打ってある小節を写す（直前の並びも合わせて点数にする）',
    audio: true,
    pick(chart, at, audio) {
      const c = predictBlock(chart, { at, len: AHEAD, audio, ...extra })[0] ?? null;
      return c && c.score >= minScore ? c : null;
    },
  };
}

/** 入力済みの小節から写すやり方の上限（正解を見て、いちばん合う元を選ぶ。ずるい参考値） */
export const ORACLE: CompletionMethod = {
  id: 'oracle',
  label: '上限（正解を見て元を選ぶ）',
  note: '入力済みの小節のどれかを写すやり方で、いちばん当たる元を正解を見て選んだもの。写すやり方の限界の目安',
  pick(chart, at, _audio, truth) {
    const all = predictBlock(chart, { at, len: AHEAD });
    let best: Candidate | null = null;
    let bestV = -Infinity;
    for (const c of all) {
      let v = 0;
      c.measures.forEach((ns, i) => {
        const r = compareMeasure(ns, truth(at + i));
        v += (r.exact ? 1000 : 0) * (i === 0 ? 10 : 1) + r.tp - r.fp;
      });
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    return best;
  },
};

/**
 * エディタと同じ出し方：原曲があれば曲の構造も使い、見込みが基準以上のときだけ出す。
 * 2小節目からは、見込みが基準以上の間だけ1小節ずつ続けて予測する。
 */
export function appMethod(min = 0.35): CompletionMethod {
  return {
    id: 'app',
    label: `TAB補完（エディタと同じ・基準 ${min}）`,
    note: `原曲があれば曲の構造も使い、見込み ${min} 以上のときだけ出す。2小節目からは、見込みが ${min} 以上の間だけ続けて予測する（エディタの「出す量：ふつう」）`,
    pick(chart, at, audio) {
      const c = predictChain(chart, { at, len: AHEAD, audio, minNext: min, alternatives: 1 })[0] ?? null;
      return c && c.score >= min ? c : null;
    },
  };
}

/** 精度テストのページで比べる方式 */
export const COMPLETION_METHODS: readonly CompletionMethod[] = [
  PREV_MEASURE,
  contextMethod('context', '前回の続き（譜面だけ）'),
  audioMethod('audio', '曲の構造も使う（原曲）'),
  appMethod(),
  ORACLE,
];

/** 見込みの区切りごとに、そのまま正解だった割合と F 値の平均（見込みが当てになるか） */
export function calibBins(points: readonly CalibPoint[], edges: readonly number[] = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 1.0001]) {
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const ps = points.filter((p) => p.score >= lo && p.score < hi);
    return {
      lo,
      hi: Math.min(1, hi),
      n: ps.length,
      exact: ps.length ? ps.filter((p) => p.exact).length / ps.length : null,
      f: ps.length ? ps.reduce((a, p) => a + p.f, 0) / ps.length : null,
    };
  });
}

/** 曲をまたいで足す */
export function poolCompletion(list: readonly ChartCompletion[]): { id: string; label: string; charts: number; offsets: OffsetStats[]; calib: CalibPoint[] }[] {
  const ids = [...new Set(list.flatMap((c) => c.methods.map((m) => m.id)))];
  return ids.map((id) => {
    const ms = list.flatMap((c) => c.methods.filter((m) => m.id === id));
    const offsets = Array.from({ length: AHEAD }, (_, i) => {
      const s = emptyStats();
      for (const m of ms) {
        const o = m.offsets[i];
        s.blocks += o.blocks;
        s.shown += o.shown;
        s.exact += o.exact;
        s.tp += o.tp;
        s.fp += o.fp;
        s.fn += o.fn;
        s.refAll += o.refAll;
        s.nonEmpty += o.nonEmpty;
      }
      return s;
    });
    return { id, label: ms[0].label, charts: ms.length, offsets, calib: ms.flatMap((m) => m.calib) };
  });
}

/** 表に出す数（出した小節の割合・そのまま使える割合・チップの F 値・手間の減り） */
export function offsetSummary(o: OffsetStats) {
  const p = o.tp + o.fp > 0 ? o.tp / (o.tp + o.fp) : null;
  const r = o.tp + o.fn > 0 ? o.tp / (o.tp + o.fn) : null;
  return {
    /** 正解が空でない小節のうち、点線を出した割合 */
    coverage: o.nonEmpty > 0 ? Math.min(1, o.shown / o.nonEmpty) : null,
    /** 出した小節のうち、正解とまったく同じだった割合（そのまま Tab で済む） */
    exactRate: o.shown > 0 ? o.exact / o.shown : null,
    precision: p,
    recall: r,
    f: p !== null && r !== null && p + r > 0 ? (2 * p * r) / (p + r) : null,
    /** 全部採用して直したときに減るクリックの割合（(当たり − 外れ) ÷ 正解のチップ全部） */
    saved: o.refAll > 0 ? (o.tp - o.fp) / o.refAll : null,
  };
}

export { contentSim };
