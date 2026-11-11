// 難易度の段階：下の難易度は、曲全体だけでなく小節ごとにも、上の難易度より濃くしない（楯さんの依頼、2026-11-07）。
// 区間ごとの方針（どこを薄くし、どこを残すか）を難易度ごとに別々に決めると、上の難易度がフィルの手前を薄くし、
// 下の難易度はフィルを薄くして手前を残す、のように考え方が食い違い、その所だけ難しさが逆転する（Calc の EXTREME と ADVANCED）。
// - 同じ元の譜面から作った難易度どうしは、チップの id で比べる。下の難易度は上の難易度に残した音だけを使い、
//   上の難易度は下の難易度に残した音を残す（gen/simplify の within・atLeast）
// - 曲に既にある譜面（作者の譜面など）は、同じ時刻・同じ楽器の音を探して合わせる
// - 上の難易度が「ここは静か（先にやさしく）」とした区間（方針の shift が +）は、下の難易度でも静かにする
// - AI には、ほかの難易度が区間ごと・フィルの前後でどれだけ残しているかを渡して、考え方を合わせてもらう
import { tr } from '../i18n';
import type { DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { drumNotes, type Note } from './features';
import { detectFills, type ChipFate, type SectionPlan } from './simplify';
import { KNOWN_GAP } from './targets';

/** 残した（移したものも含む）チップの id */
export function keptIds(fate: ReadonlyMap<number, ChipFate>): Set<number> {
  const out = new Set<number>();
  for (const [id, f] of fate) if (f.kind !== 'removed') out.add(id);
  return out;
}

/** 楽器：左バスドラムはバスドラムと同じ（同じ音を片足で踏むだけ）。オープンとクローズのハイハットは同じレーン */
function voiceOf(n: Note): number {
  return n.lane === 2 && n.alt ? 5 : n.lane;
}

const timeKey = (beat: number) => Math.round(beat * 960);

/**
 * 既存の譜面（開いている譜面の時間の並びに写したもの）の音を、作る元の譜面のチップに合わせる。
 * 同じ時刻（1/960 拍に丸める）・同じ楽器のチップの id。元の譜面に無い音（作者が書き換えた音）は合わせない
 */
export function matchIds(root: DtxDoc, chart: DtxDoc): Set<number> {
  const at = new Map<string, number[]>();
  for (const n of drumNotes(root)) {
    const k = `${voiceOf(n)}@${timeKey(n.beat)}`;
    let a = at.get(k);
    if (!a) at.set(k, (a = []));
    a.push(n.id);
  }
  const out = new Set<number>();
  for (const n of drumNotes(chart)) for (const id of at.get(`${voiceOf(n)}@${timeKey(n.beat)}`) ?? []) out.add(id);
  return out;
}

/** 小節ごとのノーツ数 */
export function measureCounts(doc: DtxDoc): Map<number, number> {
  const out = new Map<number, number>();
  for (const n of drumNotes(doc)) out.set(n.m, (out.get(n.m) ?? 0) + 1);
  return out;
}

export interface StairCheck {
  /** 上の譜面よりノーツの多い小節 */
  denser: number[];
  /** 下の譜面よりノーツの少ない小節 */
  thinner: number[];
}

const countCache = new WeakMap<DtxDoc, Map<number, number>>();
function countsOf(doc: DtxDoc): Map<number, number> {
  let c = countCache.get(doc);
  if (!c) countCache.set(doc, (c = measureCounts(doc)));
  return c;
}

/** 譜面を上・下の譜面と小節ごとに比べる（同じ時間の並びに写してある譜面どうし） */
export function stairCheck(doc: DtxDoc, upper?: DtxDoc | null, lower?: DtxDoc | null): StairCheck {
  const me = countsOf(doc);
  const denser: number[] = [];
  const thinner: number[] = [];
  if (upper) {
    const u = countsOf(upper);
    for (const [m, c] of me) if (c > (u.get(m) ?? 0)) denser.push(m);
  }
  if (lower) {
    const l = countsOf(lower);
    for (const [m, c] of l) if (c > (me.get(m) ?? 0)) thinner.push(m);
  }
  return { denser: denser.sort((a, b) => a - b), thinner: thinner.sort((a, b) => a - b) };
}

/**
 * 上の難易度の方針に合わせる：上の難易度が全体より薄くした区間（shift が +）は、こちらも同じだけ（以上）薄くする。
 * 上の難易度が濃く残した区間（shift が −）は、こちらの判断のまま（濃く残すかどうかは目標のレベルとの釣り合いで決める）。
 * フィルは合わせなくてよい（下の難易度は上の難易度に残した音しか使わないので、上より細かいフィルにはならない）
 */
export function alignPlan(sections: readonly SectionPlan[], upper: readonly SectionPlan[], from: string): SectionPlan[] {
  return sections.map((s) => {
    const u = upper.find((x) => x.from === s.from && x.to === s.to) ?? upper.find((x) => x.from <= s.from && x.to >= s.from);
    if (!u || u.shift <= 0 || u.shift <= s.shift) return s;
    return { ...s, shift: u.shift, alignedTo: from, ownShift: s.ownShift ?? s.shift };
  });
}

/** 隣の難易度とのあいだに空けるレベル */
export const STEP_GAP = KNOWN_GAP;

/**
 * 隣の難易度のレベルから、作る難易度が入るべき範囲（上より STEP_GAP 下、下より STEP_GAP 上）。
 * 隣どうしが近すぎて入らないときは、真ん中の1点
 */
export function stepRange(upper: number | null, lower: number | null, gap = STEP_GAP): { min: number; max: number } {
  const max = upper === null ? 9.99 : upper - gap;
  const min = lower === null ? 1 : lower + gap;
  if (min <= max) return { min, max };
  const mid = upper !== null && lower !== null ? (upper + lower) / 2 : upper !== null ? max : min;
  return { min: mid, max: mid };
}

/** 範囲を、隣の難易度との範囲に収める（重ならなければ、隣との範囲の近い端） */
export function clampRange(r: { min: number; max: number }, step: { min: number; max: number }): { min: number; max: number } {
  const min = Math.max(r.min, step.min);
  const max = Math.min(r.max, step.max);
  if (min <= max) return { min, max };
  const x = r.max < step.min ? step.min : step.max;
  return { min: x, max: x };
}

// ---- AI に渡す：ほかの難易度の作り方 ------------------------------------------------------------

export interface ChartProfile {
  /** 区間ごとの、元の譜面に対するノーツの割合（元の譜面に音が無い区間は null） */
  sections: { name: string; from: number; to: number; ratio: number | null }[];
  /** フィルの中・フィルの前の小節・そのほかで残している割合（元の譜面にフィルが無ければ null） */
  fill: number | null;
  preFill: number | null;
  groove: number | null;
}

type Region = 'fill' | 'pre' | 'groove';

function regionOf(n: { m: number; inBeat: number }, fills: ReadonlyMap<number, number>): Region {
  const f = fills.get(n.m);
  if (f !== undefined && n.inBeat >= f - 1e-6) return 'fill';
  if (f === undefined && fills.has(n.m + 1)) return 'pre';
  return 'groove';
}

/**
 * 譜面の作り方の要約：区間ごと・フィルの前後で、元の譜面（同じ時間の並び）の音をどれだけ残しているか。
 * 同じ考え方の難易度なら、薄い区間・濃い区間の並びが似る
 */
export function chartProfile(root: DtxDoc, chart: DtxDoc, spans: readonly { name: string; from: number; to: number }[]): ChartProfile {
  const rn = drumNotes(root, buildTempoMap(root));
  const cn = drumNotes(chart, buildTempoMap(chart));
  const fills = detectFills(rn);
  const count = (ns: Note[], pick: (n: Note) => boolean) => ns.reduce((k, n) => k + (pick(n) ? 1 : 0), 0);
  const ratio = (pick: (n: Note) => boolean) => {
    const base = count(rn, pick);
    return base === 0 ? null : count(cn, pick) / base;
  };
  return {
    sections: spans.map((s) => ({ name: s.name, from: s.from, to: s.to, ratio: ratio((n) => n.m >= s.from && n.m <= s.to) })),
    fill: fills.size ? ratio((n) => regionOf(n, fills) === 'fill') : null,
    preFill: fills.size ? ratio((n) => regionOf(n, fills) === 'pre') : null,
    groove: fills.size ? ratio((n) => regionOf(n, fills) === 'groove') : null,
  };
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

// i18n-ignore-start（AI へのプロンプト。AI へのことばは日本語のまま）

/** フィルの前後の扱いを、ことばにする（差が 12 ポイント以上あるときだけ。ビートはフィルの前の小節か、そのほかの多いほう） */
export function fillHabit(p: ChartProfile): string {
  if (p.fill === null || p.preFill === null || p.groove === null) return '';
  if (p.fill - p.preFill >= 0.12) return 'フィルを残して、その手前の小節を薄くしている';
  if (Math.max(p.groove, p.preFill) - p.fill >= 0.12) return 'フィルを薄くして、ビートを残している';
  return 'フィルもビートも同じくらいに間引いている';
}

/** AI に渡す1行：ほかの難易度の区間ごとの濃さ（と、このアプリで作った譜面なら方針） */
export function profileLine(o: { label: string; who: string; level: number; profile: ChartProfile; plan?: readonly SectionPlan[] | null; rung?: number }): string {
  const parts = o.profile.sections.map((s) => {
    const p = o.plan?.find((x) => x.from === s.from);
    const how = p && p.shift ? `（${p.shift > 0 ? '+1 静か' : '-1 山場'}）` : '';
    return `${s.from}〜${s.to} ${pct(s.ratio)}${how}`;
  });
  const fill =
    o.profile.fill === null
      ? ''
      : ` ／ フィルの中 ${pct(o.profile.fill)}・フィルの前の小節 ${pct(o.profile.preFill)}・そのほか ${pct(o.profile.groove)}${fillHabit(o.profile) ? `（${fillHabit(o.profile)}）` : ''}`;
  const rung = o.rung !== undefined ? `・全体の段 ${o.rung}` : '';
  return `${o.label}（${o.who}・Lv${o.level.toFixed(2)}${rung}）: ${parts.join('、')}${fill}`;
}

// i18n-ignore-end

/** 画面に出す：小節の並びを短く（3つまで） */
export function measureList(ms: readonly number[], fmt: (m: number) => string): string {
  const head = ms.slice(0, 3).map(fmt).join(tr('・', ', '));
  return ms.length > 3 ? tr(`${head} ほか${ms.length - 3}`, `${head} and ${ms.length - 3} more`) : head;
}
