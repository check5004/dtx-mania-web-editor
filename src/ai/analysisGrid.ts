// AI に渡す原曲の分析。AI は曲を聴けないので、耳コピする人が見ているもの（採譜の打点の強さ・ドラム強調のスペクトル）を、
// 譜面と同じ拍ごとの格子の数字（0〜9）の行にして渡す。
// あわせて、作者が自分で書いた小節（手本）の「分析と譜面の組」から、作者が分析をどう譜面にしているか（読み方の目安）を数える。
// 自動で入れたまま作者が確かめていない小節は、手本にも目安にも使わない（呼ぶ側が human で外す）。
import type { DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { toNum } from '../dtx/fraction';
import { measureGridCells, measureLayout, type MeasureLayout } from './phrase';

/** 時間に沿った分析（採譜の確からしさ・スペクトルの帯の明るさ） */
export interface AnalysisSeries {
  /** 行の名前（プロンプトに出す） */
  rows: readonly string[];
  /** 1秒あたりのフレーム数。フレーム f は f / rate 秒（0 秒は解析した音の頭） */
  rate: number;
  frames: number;
  /** frames × rows.length（0〜1） */
  data: Float32Array;
}

/** 採譜（ADTOF）の行の名前。並びはモデルの出力と同じ */
export const ACT_ROWS = ['BD', 'SD', 'TT', 'HH', 'CY'] as const;

// プロンプトに出す名前（日本語のまま） i18n-ignore-start
/** ドラム強調のスペクトルの帯（エディタの右の列の色の帯と同じ。声・ギターが多い中域は渡さない） */
export const SPEC_BANDS: readonly { row: string; from: number; to: number }[] = [
  { row: 'キック', from: 30, to: 120 },
  { row: '胴', from: 120, to: 400 },
  { row: 'スネア', from: 1600, to: 5000 },
  { row: '金物', from: 5000, to: 20000 },
];
// i18n-ignore-end

/** 拍 i の k 文字目の真ん中（小節の頭からの4分音符の数）と、半分の幅 */
function cellCenter(layout: MeasureLayout, i: number, k: number): { q: number; half: number } {
  const b = layout.beats[i];
  const dur = toNum(b.dur);
  const L = layout.cells[i];
  return { q: toNum(b.start) + (dur * k) / L, half: dur / L / 2 };
}

/**
 * 小節の格子のマスごとの値（行 × 拍 × 文字、0〜1）。マスの真ん中の前後半マスの最大。
 * offsetSec は解析した音の 0 秒が譜面の何秒か。音の外の小節（半分以上が外）は null
 */
export function seriesCells(s: AnalysisSeries, tempo: TempoMap, m: number, offsetSec: number, layout: MeasureLayout): number[][][] | null {
  const k = s.rows.length;
  const start = tempo.measureStart(m);
  const len = tempo.measureBeats(m);
  const a0 = tempo.beatToSec(start) - offsetSec;
  const a1 = tempo.beatToSec(start + len) - offsetSec;
  const dur = s.frames / s.rate;
  const inside = Math.max(0, Math.min(a1, dur) - Math.max(a0, 0));
  if (a1 <= a0 || inside < (a1 - a0) * 0.5) return null;
  const out = s.rows.map(() => layout.cells.map((n) => new Array<number>(n).fill(0)));
  layout.cells.forEach((n, i) => {
    for (let c = 0; c < n; c++) {
      const { q, half } = cellCenter(layout, i, c);
      const lo = Math.max(0, Math.floor((tempo.beatToSec(start + q - half) - offsetSec) * s.rate));
      const hi = Math.min(s.frames - 1, Math.ceil((tempo.beatToSec(start + q + half) - offsetSec) * s.rate));
      for (let r = 0; r < k; r++) {
        let mx = 0;
        for (let f = lo; f <= hi; f++) {
          const v = s.data[f * k + r];
          if (v > mx) mx = v;
        }
        out[r][i][c] = mx;
      }
    }
  });
  return out;
}

/** 0〜1 を 0〜9 の数字に */
export const digit = (v: number) => Math.max(0, Math.min(9, Math.round(v * 9)));

/** 分析を「行: 9000|0300|…」の行にする（音の外なら空） */
export function seriesLines(s: AnalysisSeries, tempo: TempoMap, m: number, offsetSec: number, layout: MeasureLayout): string[] {
  const cells = seriesCells(s, tempo, m, offsetSec, layout);
  if (!cells) return [];
  return s.rows.map((row, r) => `${row}: ${cells[r].map((b) => b.map(digit).join('')).join('|')}`);
}

// ---- 小節どうしの分析の近さ -------------------------------------------------------------

/** 1拍を何マスで比べるか（16分・3連のどちらも乗る） */
const SIM_CELLS = 12;

/** 小節の分析を、比べるための並び（行 × 1拍12マス）にする。採譜は平方根（小さな音も効くように） */
export function measureVector(s: AnalysisSeries, tempo: TempoMap, m: number, offsetSec: number, sqrt: boolean): Float32Array | null {
  const beats = tempo.measureBeats(m);
  const n = Math.max(4, Math.round(beats * SIM_CELLS));
  const layout: MeasureLayout = { beats: [{ start: { n: 0, d: 1 }, dur: { n: Math.round(beats * 1000), d: 1000 } }], total: { n: Math.round(beats * 1000), d: 1000 }, cells: [n], rounded: false };
  const cells = seriesCells(s, tempo, m, offsetSec, layout);
  if (!cells) return null;
  const k = s.rows.length;
  const out = new Float32Array(k * n);
  for (let r = 0; r < k; r++) for (let c = 0; c < n; c++) out[r * n + c] = sqrt ? Math.sqrt(cells[r][0][c]) : cells[r][0][c];
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

/** 原曲の分析（採譜とスペクトル）。どちらかが無くてもよい */
export interface MeasureAnalysis {
  act: AnalysisSeries | null;
  spec: AnalysisSeries | null;
  /** 解析した音の 0 秒が譜面の何秒か */
  offsetSec: number;
}

/** 小節どうしの分析の近さ（0〜1）。小節の長さが違う・分からなければ null */
export function analysisSimilarity(a: MeasureAnalysis, tempo: TempoMap): (x: number, y: number) => number | null {
  const memo = new Map<number, { act: Float32Array | null; spec: Float32Array | null }>();
  const vec = (m: number) => {
    let v = memo.get(m);
    if (!v) memo.set(m, (v = { act: a.act ? measureVector(a.act, tempo, m, a.offsetSec, true) : null, spec: a.spec ? measureVector(a.spec, tempo, m, a.offsetSec, false) : null }));
    return v;
  };
  return (x, y) => {
    if (Math.abs(tempo.barLen(x) - tempo.barLen(y)) > 1e-9) return null;
    const vx = vec(x);
    const vy = vec(y);
    const parts: number[] = [];
    if (vx.act && vy.act) parts.push(cosine(vx.act, vy.act));
    if (vx.spec && vy.spec) parts.push(cosine(vx.spec, vy.spec));
    return parts.length ? parts.reduce((p, q) => p + q, 0) / parts.length : null;
  };
}

// ---- 読み方の目安（作者が分析をどう譜面にしているか） -------------------------------------

/** 採譜の種類ごとに、その音として書かれうるレーン */
const FAMILY: Record<string, readonly string[]> = {
  BD: ['BD', 'LB'],
  SD: ['SD', 'RM', 'HT', 'LT', 'FT'],
  TT: ['HT', 'LT', 'FT', 'SD'],
  HH: ['HH', 'HO', 'LP', 'RD', 'CY', 'LC'],
  CY: ['CY', 'LC', 'RD', 'HO', 'HH'],
};

/** 強い・弱いの境目（AI が見る数字で） */
const STRONG = 5;
const WEAK = 2;

interface ClassTally {
  strong: number;
  strongLanes: Map<string, number>;
  strongNone: number;
  weak: number;
  weakWritten: number;
}

const pct = (a: number, b: number) => `${Math.round((a / Math.max(1, b)) * 100)}%`;

/**
 * 手本の小節（作者が自分で書いた小節）で、採譜の数字と作者の譜面をマスごとに突き合わせ、読み方の目安の行にする。
 * 例「採譜 CY が強い所（5〜9）24マス: RD 58%・CY 25%・書いていない 17%」
 */
export function readingGuide(doc: DtxDoc, tempo: TempoMap, act: AnalysisSeries, offsetSec: number, measures: readonly number[]): string[] {
  const tally = new Map<string, ClassTally>();
  const unheard = new Map<string, { n: number; quiet: number }>();
  let used = 0;
  for (const m of measures) {
    const layout = measureLayout(doc, tempo, m);
    const cells = seriesCells(act, tempo, m, offsetSec, layout);
    if (!cells) continue;
    const { rows } = measureGridCells(doc, tempo, m, layout);
    if (rows.size === 0) continue;
    used++;
    layout.cells.forEach((n, i) => {
      for (let c = 0; c < n; c++) {
        const lanes = [...rows.entries()].filter(([, r]) => r[i][c] === 'x').map(([code]) => code);
        let loudest = 0;
        act.rows.forEach((cls, r) => {
          const d = digit(cells[r][i][c]);
          loudest = Math.max(loudest, d);
          const fam = FAMILY[cls];
          if (!fam) return;
          let t = tally.get(cls);
          if (!t) tally.set(cls, (t = { strong: 0, strongLanes: new Map(), strongNone: 0, weak: 0, weakWritten: 0 }));
          const here = lanes.filter((l) => fam.includes(l));
          if (d >= STRONG) {
            t.strong++;
            if (here.length === 0) t.strongNone++;
            for (const l of here) t.strongLanes.set(l, (t.strongLanes.get(l) ?? 0) + 1);
          } else if (d >= WEAK) {
            t.weak++;
            if (here.length) t.weakWritten++;
          }
        });
        for (const l of lanes) {
          const u = unheard.get(l) ?? { n: 0, quiet: 0 };
          u.n++;
          if (loudest < WEAK) u.quiet++;
          unheard.set(l, u);
        }
      }
    });
  }
  if (used === 0) return [];
  // i18n-ignore-start プロンプトの中身
  const out: string[] = [];
  for (const cls of act.rows) {
    const t = tally.get(cls);
    if (!t || t.strong + t.weak < 3) continue;
    const parts: string[] = [];
    if (t.strong >= 2) {
      const lanes = [...t.strongLanes.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${pct(n, t.strong)}`);
      parts.push(`強い所（${STRONG}〜9）${t.strong}マス: ${[...lanes, `書いていない ${pct(t.strongNone, t.strong)}`].join('・')}`);
    }
    if (t.weak >= 2) parts.push(`弱い所（${WEAK}〜${STRONG - 1}）${t.weak}マス: 書いた ${pct(t.weakWritten, t.weak)}`);
    if (parts.length) out.push(`採譜 ${cls}: ${parts.join(' ／ ')}`);
  }
  const quiet = [...unheard.entries()].filter(([, u]) => u.n >= 3 && u.quiet / u.n >= 0.3).sort((a, b) => b[1].quiet - a[1].quiet);
  if (quiet.length) out.push(`採譜がほぼ 0（0〜${WEAK - 1}）のマスにも書いたレーン: ${quiet.map(([l, u]) => `${l} ${u.quiet}/${u.n}`).join('・')}`);
  // i18n-ignore-end
  return out;
}
