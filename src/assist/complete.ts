// TAB補完：入力した小節の続き（先の1〜4小節）を予測する。画面への出し方は store/complete が受け持つ。
//
// 候補はどれも、この曲の中ですでに打った小節を写して作る（ドラムの譜面は曲の中で何度も繰り返すため）。
//  - 前回の続き（譜面だけ）: 直前の数小節と同じ・似た並びが前にあれば、そのときの続きを写す。
//    「1・2・4小節の繰り返し」は、すぐ前が同じ並びという特別な形としてここに含まれる。
//  - 曲の構造（原曲）: 先の小節と原曲で同じに聞こえる小節が打ってあれば、その譜面を写す（2番のサビ＝1番のサビ）。
//    原曲の聞こえ方は AudioSimilarity として外から渡す。
//  - 原曲で聞こえるドラム（採譜モデルの打点）: 候補の小節が、予測する小節で聞こえる打点とどれだけ合うかを点数に足す（HeardDrums）。
// AI の候補は押したときだけ store 側で足す。
import type { Frac } from '../dtx/fraction';
import { drumChannel, type DtxDoc } from '../dtx/model';
import type { HeardDrums } from './heard';

/** 小節の中の1打（写した元の WAV 番号のまま） */
export interface CNote {
  ch: number;
  f: Frac;
  v: number;
}

export interface MeasureContent {
  notes: CNote[];
  /** チャンネルと位置の組（WAV は見ない） */
  keys: ReadonlySet<string>;
  /** 並びの文字列（同じ小節かどうかの比較用） */
  sig: string;
}

export const noteKey = (ch: number, f: Frac) => `${ch}@${f.n}/${f.d}`;

export function contentOf(notes: CNote[]): MeasureContent {
  const keys = new Set(notes.map((n) => noteKey(n.ch, n.f)));
  return { notes, keys, sig: [...keys].sort().join(',') };
}

const contentCache = new WeakMap<DtxDoc, Map<number, MeasureContent>>();

/** 小節ごとのドラムのチップ（通常・不可視・音だけのどれも）。チップの無い小節は入らない */
export function measureContents(doc: DtxDoc): Map<number, MeasureContent> {
  let out = contentCache.get(doc);
  if (out) return out;
  const by = new Map<number, CNote[]>();
  for (const c of doc.chips) {
    if (!drumChannel(c.ch)) continue;
    let a = by.get(c.m);
    if (!a) by.set(c.m, (a = []));
    a.push({ ch: c.ch, f: c.f, v: c.v });
  }
  out = new Map();
  for (const [m, notes] of by) out.set(m, contentOf(notes));
  contentCache.set(doc, out);
  return out;
}

/**
 * 2つの小節の譜面の近さ（0〜1）。同じなら1。
 * どちらも空の小節は「似ている」とまでは言えないので 0.5（曲頭の無音どうしで続きを決めないように）。
 */
export function contentSim(a: MeasureContent | undefined, b: MeasureContent | undefined): number {
  const na = a?.keys.size ?? 0;
  const nb = b?.keys.size ?? 0;
  if (na === 0 && nb === 0) return 0.5;
  if (na === 0 || nb === 0) return 0;
  if (a!.sig === b!.sig) return 1;
  let inter = 0;
  for (const k of a!.keys) if (b!.keys.has(k)) inter++;
  return inter / (na + nb - inter);
}

/** 原曲で2つの小節がどれだけ同じに聞こえるか。-1〜1（1が同じ）。分からなければ null */
export interface AudioSimilarity {
  sim(a: number, b: number): number | null;
}

/** 予測に使う譜面の見方 */
export interface ChartSource {
  contents: ReadonlyMap<number, MeasureContent>;
  barLen(m: number): number;
  /** 写す元にしてよい（入力済みの）小節か */
  canCopy(m: number): boolean;
}

export interface Candidate {
  kind: 'context' | 'structure' | 'ai';
  /** 予測した最初の小節 */
  from: number;
  /** 小節ごとの中身（入力途中の小節は、もう置いたチップも含む） */
  measures: CNote[][];
  /** 写した元の最初の小節（AI は null） */
  src: number | null;
  /** 0〜1。表示するかどうかと並び順に使う（最初の小節がまったく同じになる確からしさ） */
  score: number;
  /** 小節ごとの確からしさ（続けて予測したとき） */
  scores?: number[];
  /** 直前の並びの一致（0〜1） */
  ctx: number;
  /** 原曲の似ている度合い（-1〜1、無ければ null） */
  audio: number | null;
  /** 写した元が何小節前か（前回の続きのとき） */
  period: number | null;
  name?: string;
  reason?: string;
}

export interface PredictOptions {
  /** 予測を始める小節 */
  at: number;
  /** 何小節ぶん予測するか（ふつうは空いている小節だけ、4まで） */
  len: number;
  audio?: AudioSimilarity | null;
  /** 原曲で聞こえるドラム（採譜モデルの打点）。原曲の聞こえ方（audio）と一緒に使う */
  heard?: HeardDrums | null;
  /** 予測を始める小節にもう置いてあるチップ（入力の途中）。候補はこれを全部含むものだけ */
  partial?: MeasureContent | null;
  /** 候補の点数の付け方（精度テストで差し替える）。省くと学習した重み */
  scorer?: (x: readonly number[], mode: ScoreMode) => number;
  /** 原曲がこれより似ていない小節で候補を切る（2小節目から。省くと切らない） */
  audioCut?: number;
  /** 同じ中身の候補をまとめない（重みの学習用） */
  keepAll?: boolean;
}

/**
 * 候補ごとの特徴（点数の材料）。並びは FEATURE_NAMES と同じ。
 * 直前の並びの一致・原曲の似ている度合い・何小節前か・4小節や8小節の区切りがそろうか・
 * 原曲で聞こえるドラム（バスドラム・スネア・タム）との合い方（予測する小節の候補・直前の打ってある小節）。
 */
export const FEATURE_NAMES = ['c1', 'c2', 'c3', 'c4', 'a0', 'a1', 'aPrev', 'near1', 'near2', 'phase4', 'phase8', 'dist', 's0', 'sPrev'] as const;

/** 点数の付け方：譜面だけ・原曲の聞こえ方も・聞こえるドラムも */
export type ScoreMode = 'chart' | 'audio' | 'drums';

/**
 * 学習した重み。精度テストの6曲23譜面で「次の小節がまったく同じになるか」をロジスティック回帰で当てた
 * （docs/bench.md の「TAB補完」）。点数はそのまま「次の小節がまったく同じになる確からしさ」として読める。
 */
export const WEIGHTS = {
  /** 原曲が無いとき（譜面だけ） */
  chart: { bias: -4.214, w: [3.156, -0.056, -0.395, 0.739, 0, 0, 0, 0.112, 0.43, 0.459, 0.055, -0.438] },
  /** 原曲があるとき */
  audio: { bias: -4.631, w: [2.753, -0.132, -0.435, 0.706, 1.836, 1.3, 0.314, -0.008, 0.291, 0.374, -0.008, -0.225] },
  /**
   * 原曲があり、ドラムの採譜もできたとき。原曲があるときの点数に、聞こえるドラムとの合い方（候補 s0 と直前の小節 sPrev）を
   * 足して学び直し、各小節で一番の候補の見込みが「そのまま正解」の割合に合うよう較正した（どちらも曲ごとの交差検証で確かめた）。
   * s0 と sPrev の重みがほぼ逆向きなので、効くのは「直前の小節より、候補の方が聞こえるドラムに合うか」。
   */
  drums: { bias: -3.744, w: [2.351, -0.113, -0.372, 0.603, 1.568, 1.11, 0.268, -0.007, 0.249, 0.319, -0.007, -0.192, 1.947, -2.017] },
};

export function logistic(x: readonly number[], m: { bias: number; w: readonly number[] }): number {
  let z = m.bias;
  for (let i = 0; i < m.w.length; i++) z += m.w[i] * (x[i] ?? 0);
  return 1 / (1 + Math.exp(-z));
}

export const defaultScorer = (x: readonly number[], mode: ScoreMode) => logistic(x, WEIGHTS[mode]);

/** 直前の何小節の並びを比べるか */
const CONTEXT = 4;
/** 原曲でこれ以上似ていれば「同じに聞こえる」と言う（候補の出どころの表示だけに使う） */
const STRUCTURE_SIM = 0.4;

/**
 * 先の len 小節の候補を、点数の高い順に返す（同じ中身の候補は1つにまとめる）。
 * 中身がすべて空の候補（何も打たない）は返さない。
 */
export function predictBlock(chart: ChartSource, o: PredictOptions): (Candidate & { feat: number[] })[] {
  const { at, len } = o;
  if (len <= 0) return [];
  const get = (m: number) => chart.contents.get(m);
  const partial = o.partial && o.partial.keys.size ? o.partial : null;
  const audio = o.audio ?? null;
  const hasAudio = !!audio && audio.sim(at, at) !== null;
  const heard = hasAudio && o.heard && o.heard.agree([], at) !== null ? o.heard : null;
  const mode: ScoreMode = heard ? 'drums' : hasAudio ? 'audio' : 'chart';
  const scorer = o.scorer ?? defaultScorer;
  // 直前の打ってある小節と、聞こえるドラムの合い方（この曲・この辺りで採譜がどれだけ譜面に合うかの目安）
  const sPrev = heard ? (heard.agree(get(at - 1)?.notes ?? [], at - 1) ?? 0) : 0;
  const best = new Map<string, Candidate & { feat: number[] }>();
  let hi = at - 1;
  for (const m of chart.contents.keys()) if (m > hi) hi = m;
  for (let j = 0; j <= hi; j++) {
    if (j === at || !chart.canCopy(j)) continue;
    const period = j < at ? at - j : null;
    const measures: CNote[][] = [];
    const sims: (number | null)[] = [];
    for (let i = 0; i < len; i++) {
      const s = j + i;
      if (Math.abs(chart.barLen(s) - chart.barLen(at + i)) > 1e-9) break;
      let notes: CNote[];
      if (s >= at && s < at + len) {
        // 写す元が予測する範囲に入った：その周期で繰り返す
        if (period === null || i - period < 0) break;
        notes = measures[i - period];
      } else {
        if (!chart.canCopy(s)) break;
        notes = get(s)?.notes ?? [];
      }
      const a = hasAudio ? audio!.sim(at + i, s) : null;
      if (i > 0 && a !== null && o.audioCut !== undefined && a < o.audioCut) break;
      sims.push(a);
      measures.push(notes);
    }
    if (measures.length === 0) continue;
    if (partial) {
      const first = new Set(measures[0].map((n) => noteKey(n.ch, n.f)));
      let ok = true;
      for (const k of partial.keys) if (!first.has(k)) ok = false;
      if (!ok) continue;
    }
    if (measures.every((x) => x.length === 0)) continue;
    // 最後の空の小節は出さない（何も打たない所まで点線を伸ばさない）
    while (measures.length > 1 && measures[measures.length - 1].length === 0) {
      measures.pop();
      sims.pop();
    }
    const c: number[] = [];
    for (let k = 1; k <= CONTEXT; k++) c.push(at - k >= 0 ? contentSim(get(at - k), j - k >= 0 ? get(j - k) : undefined) : 0.5);
    const d = Math.abs(at - j);
    const aPrev = hasAudio ? (audio!.sim(at - 1, j - 1) ?? 0) : 0;
    const s0 = heard ? (heard.agree(measures[0], at) ?? 0) : 0;
    const feat = [
      ...c,
      sims[0] ?? 0,
      sims[1] ?? sims[0] ?? 0,
      aPrev,
      d === 1 ? 1 : 0,
      d === 2 ? 1 : 0,
      d % 4 === 0 ? 1 : 0,
      d % 8 === 0 ? 1 : 0,
      Math.log2(d) / 6,
      s0,
      sPrev,
    ];
    const score = scorer(feat, mode);
    const sig = o.keepAll ? String(j) : measures.map((ns) => contentOf(ns).sig).join('|');
    const prev = best.get(sig);
    // 同じ中身なら点数の高い方、同じ点数なら近い小節を元にする
    if (prev && (prev.score > score + 1e-12 || (Math.abs(prev.score - score) <= 1e-12 && Math.abs(prev.src! - at) <= d))) continue;
    const ctx = (c[0] * 4 + c[1] * 3 + c[2] * 2 + c[3]) / 10;
    // 原曲で同じに聞こえる、離れた小節からなら「曲の構造」（すぐ前の繰り返しは「前回の続き」と呼ぶ）
    const structure = hasAudio && (sims[0] ?? 0) >= STRUCTURE_SIM && (period === null || period > 2);
    best.set(sig, {
      kind: structure ? 'structure' : 'context',
      from: at,
      measures,
      src: j,
      score,
      ctx,
      audio: sims[0] ?? null,
      period,
      feat,
    });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || Math.abs(a.src! - at) - Math.abs(b.src! - at));
}

/** 予測した小節を入力済みとみなした譜面の見方（続けて予測するため） */
function withVirtual(chart: ChartSource, m: number, notes: CNote[]): ChartSource {
  const contents = new Map(chart.contents);
  if (notes.length) contents.set(m, contentOf(notes));
  else contents.delete(m);
  return { contents, barLen: chart.barLen, canCopy: (x) => x !== m && chart.canCopy(x) };
}

/**
 * 1小節ずつ続けて予測する（予測した小節を入力済みとみなして次を予測する）。
 * 原曲が途中で変わる所（サビに入る、フィル）では、写す元を選び直せる。
 * 返す候補は、最初の小節の違うものを点数の高い順に。それぞれの2小節目からは一番よいものを続ける。
 */
export function predictChain(chart: ChartSource, o: PredictOptions & { minNext?: number; alternatives?: number }): Candidate[] {
  const firsts = predictBlock(chart, { ...o, len: 1 });
  const out: Candidate[] = [];
  for (const c0 of firsts.slice(0, o.alternatives ?? 3)) {
    const measures = [c0.measures[0]];
    const scores = [c0.score];
    let view = withVirtual(chart, o.at, c0.measures[0]);
    for (let i = 1; i < o.len; i++) {
      const next = predictBlock(view, { ...o, at: o.at + i, len: 1, partial: null })[0];
      if (!next || next.score < (o.minNext ?? 0)) break;
      measures.push(next.measures[0]);
      scores.push(next.score);
      view = withVirtual(view, o.at + i, next.measures[0]);
    }
    while (measures.length > 1 && measures[measures.length - 1].length === 0) {
      measures.pop();
      scores.pop();
    }
    out.push({ ...c0, measures, scores });
  }
  return out;
}
