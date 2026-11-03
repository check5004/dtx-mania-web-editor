// 拍ごとの格子：AI とのやりとりで、拍（4分音符）ごとに細かさを変えて譜面を書く形。
//
// 「SD: x-x-|x-x-|xxx|xxxxxx」のように | で拍を区切り、1拍の文字数でその拍の細かさを表す
// （4=16分、3=8分3連、6=16分3連、8=32分、12=16分と8分3連が混ざる拍、24=32分と3連が混ざる拍）。
// 拍子が半端な小節（7/8 など）は最後の拍が短く、文字はその短い拍を等分する。
// 16分に固定した格子では3連や32分を書けず、近い16分に丸めてしまっていた（2026-11 まで）。
//
// 原曲の打点だけがある拍（生成する小節）は、打点の時刻にいちばん合う細かさを選ぶ（3連を聞き分ける）。
import { add, cmp, div, frac, mul, ONE, sub, toNum, ZERO, type Frac } from '../dtx/fraction';
import type { TempoMap } from '../dtx/timing';

/** 小節の中の1拍（位置と長さは4分音符の数） */
export interface BeatSlot {
  start: Frac;
  dur: Frac;
}

/** 小節の拍の並び（4分音符ごと。半端な小節は最後の拍が短い）と、小節の長さ（4分音符の数） */
export function beatsOfMeasure(tempo: TempoMap, m: number): { beats: BeatSlot[]; total: Frac } {
  const total = mul(tempo.barLenFrac(m), frac(4));
  const beats: BeatSlot[] = [];
  let s: Frac = ZERO;
  while (cmp(s, total) < 0 && beats.length < 64) {
    const rest = sub(total, s);
    const dur = cmp(rest, ONE) < 0 ? rest : ONE;
    beats.push({ start: s, dur });
    s = add(s, dur);
  }
  return { beats, total };
}

/** 1文字の長さ（4分音符の数）の候補。粗い順（チップがちょうど乗る、いちばん粗いものを使う） */
const CELLS: readonly Frac[] = [frac(1, 4), frac(1, 3), frac(1, 6), frac(1, 8), frac(1, 12), frac(1, 24)];
/** 原曲の打点から選ぶ細かさ（16分・8分3連・16分3連・32分）と、細かくするときの割り増し（秒） */
const FIT_CELLS: readonly { cell: Frac; penalty: number }[] = [
  { cell: frac(1, 4), penalty: 0 },
  { cell: frac(1, 3), penalty: 0.004 },
  { cell: frac(1, 6), penalty: 0.007 },
  { cell: frac(1, 8), penalty: 0.009 },
];

/** 拍を cell で割った文字数（割り切れなければ null） */
function lengthFor(dur: Frac, cell: Frac): number | null {
  const L = div(dur, cell);
  return L.d === 1 && L.n >= 1 ? L.n : null;
}

/** 何も無い拍の文字数（16分。短い拍で16分に割れなければ1文字） */
export function baseCells(dur: Frac): number {
  return lengthFor(dur, frac(1, 4)) ?? 1;
}

/**
 * 拍の中の位置（拍の頭からの4分音符の数）がどれもちょうど乗る、いちばん粗い文字数。
 * 乗るものが無ければ null（5連など）
 */
export function exactCells(dur: Frac, pos: readonly Frac[]): number | null {
  for (const c of CELLS) {
    const L = lengthFor(dur, c);
    if (L === null) continue;
    if (pos.every((p) => div(p, c).d === 1)) return L;
  }
  return null;
}

/**
 * 原曲の打点（拍の頭からの位置 p は4分音符の数、s は強さ 0〜1）にいちばん合う文字数。
 * 打点のずれ（秒）の二乗平均に、細かい格子ほど少し割り増しを足して比べる（16分 → 8分3連 → 16分3連 → 32分）
 */
export function fitCells(dur: Frac, hits: readonly { p: number; s: number }[], secPerQuarter: number): number {
  const base = baseCells(dur);
  if (hits.length === 0) return base;
  let best = base;
  let bestScore = Infinity;
  for (const { cell, penalty } of FIT_CELLS) {
    const L = lengthFor(dur, cell);
    if (L === null) continue;
    const c = toNum(cell);
    let se = 0;
    let sw = 0;
    for (const h of hits) {
      const e = Math.abs(h.p - Math.round(h.p / c) * c) * secPerQuarter;
      const w = Math.max(0.05, h.s);
      se += w * e * e;
      sw += w;
    }
    const score = Math.sqrt(se / sw) + penalty;
    if (score < bestScore - 1e-9) {
      best = L;
      bestScore = score;
    }
  }
  return best;
}

/** 16分から外れているとみなすずれ（秒）。採譜の打点の時刻のぶれ（10ms 前後）より大きく、16分と3連の差（BPM 200 でも 25ms）より小さい */
const OFF_GRID_SEC = 0.018;
/** 16分から外れた打点として数える強さの下限（弱い打点は時刻のぶれが大きい） */
const OFF_GRID_MIN_S = 0.4;

/**
 * 小節の拍ごとに、原曲の打点にいちばん合う文字数を選ぶ（fitCells）。ただし16分より細かい・3連にするのは、
 * その拍に16分から外れた打点が2つ以上あるか、外れた打点が1つでも同じ小節のほかの拍も同じ種類（3連・32分）に外れているときだけ
 * （打点1つの時刻のぶれで3連にしないため。シャッフルのように拍ごとに1つずつ外れるものは小節でまとめて見る）
 */
export function fitMeasureCells(beats: readonly BeatSlot[], perBeat: readonly (readonly { p: number; s: number }[])[], secPerQuarter: number): number[] {
  const raw = beats.map((b, i) => fitCells(b.dur, perBeat[i] ?? [], secPerQuarter));
  const off = beats.map((_, i) =>
    (perBeat[i] ?? []).filter((h) => h.s >= OFF_GRID_MIN_S && Math.abs(h.p - Math.round(h.p * 4) / 4) * secPerQuarter > OFF_GRID_SEC).length,
  );
  const kind = (i: number) => {
    const cell = div(beats[i].dur, frac(raw[i]));
    return cell.d % 3 === 0 ? 'triplet' : 'fine';
  };
  return raw.map((L, i) => {
    const base = baseCells(beats[i].dur);
    if (L === base) return L;
    if (off[i] >= 2) return L;
    if (off[i] === 1 && raw.some((L2, j) => j !== i && L2 !== baseCells(beats[j].dur) && off[j] >= 1 && kind(j) === kind(i))) return L;
    return base;
  });
}

/** a と b の両方の位置を書ける文字数（どちらかの倍数で、いちばん小さいもの）。細かすぎれば a */
export function combineCells(dur: Frac, a: number, b: number): number {
  if (a % b === 0) return a;
  if (b % a === 0) return b;
  const both = (a * b) / gcdInt(a, b);
  // 1文字が 1/24 拍より細かくなるものは使わない
  return toNum(div(dur, frac(both))) >= 1 / 24 - 1e-9 ? both : a;
}

function gcdInt(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 打点を拍に振り分けるときの、拍の頭より前を含める幅（4分音符の数。32分の半分） */
export const LEAD = 1 / 16;

/**
 * 小節の頭からの位置 q（4分音符の数）を、拍と拍の中の位置にする。拍の頭の少し前（LEAD）はその拍の頭の側。
 * 小節の外なら null
 */
export function locateInBeats(beats: readonly BeatSlot[], q: number): { i: number; p: number } | null {
  for (let i = beats.length - 1; i >= 0; i--) {
    const s = toNum(beats[i].start);
    const e = s + toNum(beats[i].dur);
    if (q >= s - LEAD && q < e - LEAD) return { i, p: q - s };
    if (i === beats.length - 1 && q >= e - LEAD) return null;
  }
  return null;
}

/** 拍 i の k 文字目（全部で L 文字）の、小節の中の位置（0〜1） */
export function cellPos(beats: readonly BeatSlot[], total: Frac, i: number, k: number, L: number): Frac {
  const b = beats[i];
  return div(add(b.start, mul(b.dur, frac(k, L))), total);
}

/** 打つ文字 */
const HIT = /[xXoO●]/;
/** 1拍に書ける文字数の上限 */
const MAX_CELLS = 48;

/**
 * 「x-x-|xxx|…」の行を、小節の中の位置（0〜1）の並びにする。
 * | の数が拍の数と合えば拍ごとに読む。合わない・| が無いときは、行全体を小節の等分として読む（16分の格子の書き方もそのまま読める）
 */
export function parseSteps(steps: string, beats: readonly BeatSlot[], total: Frac): Frac[] {
  const s = steps.replace(/\s/g, '');
  const out: Frac[] = [];
  if (s.includes('|')) {
    const groups = s.split('|');
    while (groups.length > beats.length && groups[groups.length - 1] === '') groups.pop();
    while (groups.length > beats.length && groups[0] === '') groups.shift();
    if (groups.length === beats.length) {
      groups.forEach((g, i) => {
        const L = g.length;
        if (L === 0 || L > MAX_CELLS) return;
        for (let k = 0; k < L; k++) if (HIT.test(g[k])) out.push(cellPos(beats, total, i, k, L));
      });
      return out;
    }
  }
  const flat = s.replace(/\|/g, '');
  const n = flat.length;
  if (n === 0 || n > MAX_CELLS * beats.length) return out;
  for (let k = 0; k < n; k++) if (HIT.test(flat[k])) out.push(frac(k, n));
  return out;
}

/** 小節の長さの書き方（見出し用。「4拍」「3拍と半分」など） */
export function beatsLabel(beats: readonly BeatSlot[]): string {
  const last = beats[beats.length - 1];
  if (!last || cmp(last.dur, ONE) === 0) return `${beats.length}拍`;
  return `${beats.length - 1}拍と${last.dur.n}/${last.dur.d}拍（最後の拍が短い）`;
}

