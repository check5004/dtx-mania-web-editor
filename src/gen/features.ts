// 譜面の特徴：難易度ガイドラインの集計、AIのレベル判定、低難易度の生成で使う。
// どれも「その要素が譜面に出てくるか」と、密度などの数値。拍の位置で見るので BPM が変わっても同じ物差しになる。
import { CH, drumChannel, type DtxDoc } from '../dtx/model';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { estimateLevel } from '../check/level';

export interface Note {
  id: number;
  ch: number;
  lane: number;
  alt: boolean;
  m: number;
  /** 曲頭からの拍 */
  beat: number;
  /** 小節の中の拍（0〜） */
  inBeat: number;
  /** 小節の拍数 */
  mBeats: number;
  sec: number;
}

export const LANE_KEYS = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY', 'RD'] as const;
export const TOM_LANES = new Set([4, 6, 7]);
export const HAND_LANES = new Set([0, 1, 3, 4, 6, 7, 8, 9]);

/** ドラムの通常チップを時間順に並べる */
export function drumNotes(doc: DtxDoc, tempo: TempoMap = buildTempoMap(doc)): Note[] {
  const out: Note[] = [];
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    const beat = tempo.beatOf(c.m, c.f);
    out.push({
      id: c.id,
      ch: c.ch,
      lane: d.lane,
      alt: d.alt,
      m: c.m,
      beat,
      inBeat: beat - tempo.measureStart(c.m),
      mBeats: tempo.measureBeats(c.m),
      sec: tempo.beatToSec(beat),
    });
  }
  out.sort((a, b) => a.beat - b.beat || a.lane - b.lane);
  return out;
}

/** 集計する要素（ガイドラインの表の行） */
export const FEATURE_DEFS = [
  { key: 'hh8', label: '8分のハイハット' },
  { key: 'hh16', label: '16分のハイハット' },
  { key: 'hho', label: 'オープンハイハット' },
  { key: 'kick16', label: '16分のキック' },
  { key: 'twinBass', label: 'ツーバス連打' },
  { key: 'leftPedal', label: '左ペダル' },
  { key: 'tom16', label: '16分のタム回し' },
  { key: 'chord3', label: '同時3打以上' },
  { key: 'synco', label: 'シンコペーション' },
  { key: 'leftCymRide', label: '左シンバル・ライド' },
  { key: 'bpmChange', label: 'BPM変化・変拍子' },
] as const;

export type FeatureKey = (typeof FEATURE_DEFS)[number]['key'];

export interface ChartFeatures {
  has: Record<FeatureKey, boolean>;
  notes: number;
  /** 演奏している時間（秒） */
  duration: number;
  /** 平均の打数（1秒あたり） */
  density: number;
  peakNps: number;
  maxChord: number;
  bpm: number;
  /** 機械的な推定レベル */
  mech: number;
  /** 8分中心か16分中心か（ハイハット・ライドの刻み） */
  feel: '4' | '8' | '16' | 'mixed';
}

const EPS = 1e-6;
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
const onGrid = (x: number, step: number) => Math.abs(x / step - Math.round(x / step)) < EPS * 100;

/** 同じ種類の音の連続（間隔がほぼ step 拍）の長さを数える */
function runs(beats: number[], step: number, minLen: number): number {
  let count = 0;
  let len = 1;
  for (let i = 1; i <= beats.length; i++) {
    if (i < beats.length && near(beats[i] - beats[i - 1], step)) len++;
    else {
      if (len >= minLen) count++;
      len = 1;
    }
  }
  return count;
}

function pairs(beats: number[], step: number): number {
  let n = 0;
  for (let i = 1; i < beats.length; i++) if (near(beats[i] - beats[i - 1], step)) n++;
  return n;
}

export function chartFeatures(doc: DtxDoc, tempo: TempoMap = buildTempoMap(doc)): ChartFeatures {
  const notes = drumNotes(doc, tempo);
  const lv = estimateLevel(doc, tempo);
  const beatsOf = (pred: (n: Note) => boolean) => uniq(notes.filter(pred).map((n) => n.beat));
  const hh = beatsOf((n) => n.lane === 1);
  const ride = beatsOf((n) => n.lane === 9);
  const kick = beatsOf((n) => n.lane === 5 || (n.lane === 2 && n.alt));
  const toms = notes.filter((n) => TOM_LANES.has(n.lane) || n.lane === 3);
  // タム回し：タムとスネアの16分の連続で、タムが2打以上入っているもの
  let tomRuns = 0;
  {
    let len = 1;
    let tomCount = TOM_LANES.has(toms[0]?.lane ?? -1) ? 1 : 0;
    for (let i = 1; i <= toms.length; i++) {
      if (i < toms.length && near(toms[i].beat - toms[i - 1].beat, 0.25)) {
        len++;
        if (TOM_LANES.has(toms[i].lane)) tomCount++;
      } else {
        if (len >= 4 && tomCount >= 2) tomRuns++;
        len = 1;
        tomCount = i < toms.length && TOM_LANES.has(toms[i].lane) ? 1 : 0;
      }
    }
  }
  // 同時打ち
  let chord3 = 0;
  for (let i = 0; i < notes.length; ) {
    let j = i + 1;
    while (j < notes.length && Math.abs(notes[j].beat - notes[i].beat) < EPS) j++;
    if (j - i >= 3) chord3++;
    i = j;
  }
  // シンコペーション：スネア・シンバル・キックが裏（16分の裏、または8分の裏で次の拍に何も無い）
  const beatSet = new Set(notes.map((n) => Math.round(n.beat * 48)));
  let synco = 0;
  for (const n of notes) {
    if (!(n.lane === 3 || n.lane === 0 || n.lane === 8 || n.lane === 5)) continue;
    const fracB = n.inBeat - Math.floor(n.inBeat + EPS);
    if (near(fracB, 0.25) || near(fracB, 0.75)) synco++;
    else if (near(fracB, 0.5) && n.lane !== 5 && !beatSet.has(Math.round((n.beat + 0.5) * 48))) synco++;
  }
  const leftFoot = notes.filter((n) => n.lane === 2).length;
  const bpms = new Set(tempo.events.map((e) => Math.round(e.bpm * 100)));
  const hasBar = Object.values(doc.barLengths).some((x) => Math.abs(x - 1) > EPS);
  const has: Record<FeatureKey, boolean> = {
    hh8: pairs(hh, 0.5) + pairs(ride, 0.5) >= 8,
    hh16: pairs(hh, 0.25) + pairs(ride, 0.25) >= 8,
    hho: notes.filter((n) => n.lane === 1 && n.alt).length >= 4,
    kick16: pairs(kick, 0.25) >= 4,
    twinBass: runs(kick, 0.25, 4) >= 2,
    leftPedal: leftFoot >= 4,
    tom16: tomRuns >= 1,
    chord3: chord3 >= 2,
    synco: synco >= 8,
    leftCymRide: notes.filter((n) => n.lane === 0 || n.lane === 9).length >= 4,
    bpmChange: bpms.size > 1 || hasBar,
  };
  const p16 = pairs(hh, 0.25) + pairs(ride, 0.25);
  const p8 = pairs(hh, 0.5) + pairs(ride, 0.5);
  const p4 = pairs(hh, 1) + pairs(ride, 1);
  const top = Math.max(p16, p8, p4);
  const feel: ChartFeatures['feel'] = top === 0 ? 'mixed' : p16 === top && p16 > 1.5 * p8 ? '16' : p8 === top ? '8' : p4 === top ? '4' : 'mixed';
  return {
    has,
    notes: notes.length,
    duration: lv?.duration ?? 0,
    density: lv?.avgNps ?? 0,
    peakNps: lv?.peakNps ?? 0,
    maxChord: lv?.maxChord ?? (notes.length ? 1 : 0),
    bpm: tempo.initialBpm,
    mech: lv?.level ?? 1,
    feel,
  };
}

function uniq(xs: number[]): number[] {
  const out: number[] = [];
  for (const x of xs) if (out.length === 0 || Math.abs(out[out.length - 1] - x) > EPS) out.push(x);
  return out;
}

/** 近い譜面を探すための数値の並び（0〜1 くらいにそろえる） */
export function featureVector(f: ChartFeatures): number[] {
  return [
    ...FEATURE_DEFS.map((d) => (f.has[d.key] ? 1 : 0)),
    Math.log(1 + f.density) / 2.5,
    Math.log(1 + f.peakNps) / 3,
    f.maxChord / 4,
    f.mech / 10,
  ];
}

export function featureDistance(a: ChartFeatures, b: ChartFeatures): number {
  const x = featureVector(a);
  const y = featureVector(b);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    // 数値の列（後ろ4つ）を重く見る
    const w = i >= FEATURE_DEFS.length ? 3 : 1;
    s += w * (x[i] - y[i]) ** 2;
  }
  return Math.sqrt(s);
}

/** 人に（AIに）渡す1行の要約 */
export function featureSummary(f: ChartFeatures): string {
  const list = FEATURE_DEFS.filter((d) => f.has[d.key]).map((d) => d.label);
  const feel = f.feel === '16' ? '16ビート中心' : f.feel === '8' ? '8ビート中心' : f.feel === '4' ? '4分の刻み中心' : '刻みは混在';
  return `BPM ${Math.round(f.bpm)} · ${f.notes}ノーツ · 平均 ${f.density.toFixed(1)}打/秒 · 最も密な2秒 ${f.peakNps.toFixed(1)}打/秒 · 最大同時 ${f.maxChord} · ${feel} · 要素: ${list.join('、') || 'なし'}`;
}

/** 区間（小節の範囲）ごとの特徴の要約 */
export function sectionSummaries(doc: DtxDoc, sections: { name: string; from: number; to: number }[], tempo: TempoMap = buildTempoMap(doc)): string[] {
  const notes = drumNotes(doc, tempo);
  return sections.map((s) => {
    const ns = notes.filter((n) => n.m >= s.from && n.m <= s.to);
    if (ns.length === 0) return `${s.name}（${s.from}〜${s.to}小節）: ノーツなし`;
    const secs = Math.max(0.5, tempo.beatToSec(tempo.measureStart(s.to + 1)) - tempo.beatToSec(tempo.measureStart(s.from)));
    const per = LANE_KEYS.map((k, i) => [k, ns.filter((n) => n.lane === i).length] as const).filter(([, c]) => c > 0);
    const fine = ns.filter((n) => !onGrid(n.inBeat, 0.5)).length;
    return `${s.name}（${s.from}〜${s.to}小節）: ${ns.length}ノーツ, ${(ns.length / secs).toFixed(1)}打/秒, 8分より細かい音 ${Math.round((fine / ns.length) * 100)}%, レーン別 ${per.map(([k, c]) => `${k}${c}`).join(' ')}`;
  });
}

/** BGM やフィルインの位置など、ドラム以外も含めて「曲の長さ」に使う最後の小節 */
export function lastMeasure(doc: DtxDoc): number {
  let m = 0;
  for (const c of doc.chips) if (c.ch !== CH.BGM && c.m > m) m = c.m;
  return m;
}
