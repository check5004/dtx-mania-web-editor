// フラム（両手でほんの少しずらして叩く2打）。DTX には装飾音が無いので、同じレーンにチップを2つ、ほんの少しずらして置く。
// 手元の6曲（作者5人）の譜面では、1打目を拍の上に置き、2打目を 1/32（184BPM・41ms）や 1/48（138BPM・36ms）の
// 後ろに置いていた。どちらも約40ミリ秒なので、間隔は「約40msにいちばん近い細かさ」をその所の BPM から選ぶのを基本にする。
import type { Draft } from 'immer';
import { add, cmp, frac, mul, sub, toNum, type Frac } from '../dtx/fraction';
import { drumChannel, type Chip, type DtxDoc } from '../dtx/model';
import { MAX_MEASURES, type TempoMap } from '../dtx/timing';
import { opPlace, type Pos } from './ops';
import { pruneVariants, quantizeVel, velOfWav, wavVariant } from './velocity';

/** 間隔。'auto' は約40ミリ秒にいちばん近い細かさ。数値は全音符の分割数（48 = 1/48 音符） */
export type FlamGap = 'auto' | number;

/** after: 1打目を拍の上、2打目を少し後ろ（よく見る書き方） / before: 2打目を拍の上、1打目を少し前（叩くタイミングどおり） */
export type FlamSide = 'after' | 'before';

export interface FlamOptions {
  gap: FlamGap;
  side: FlamSide;
  /** 1打目（装飾音・先に鳴る方）のベロシティ。2打目に対する割合（%） */
  grace: number;
}

export const DEFAULT_FLAM: FlamOptions = { gap: 'auto', side: 'after', grace: 70 };

/** 間隔の目安（ミリ秒） */
export const FLAM_TARGET_MS = 40;

/** 選べる間隔（全音符の分割数）。自動もこの中から選ぶ */
export const FLAM_DIVS = [24, 32, 48, 64, 96, 192] as const;

/** これより間が空いた2打はフラムとみなさない（秒）。間隔を広めに決めたときは、その 1.25 倍まで */
export const FLAM_MAX_SEC = 0.06;

/** フラムの2打は、前後のチップからこの倍以上離れている（等間隔の連打はフラムではない） */
const ISOLATION = 1.5;

/** 間隔の長さ（ミリ秒） */
export function flamMs(div: number, bpm: number): number {
  return 240000 / (div * Math.max(1, bpm));
}

/** その BPM での間隔（全音符の分割数） */
export function flamDiv(bpm: number, gap: FlamGap): number {
  if (gap !== 'auto') return gap;
  let best: number = FLAM_DIVS[0];
  let bestErr = Infinity;
  for (const d of FLAM_DIVS) {
    const err = Math.abs(flamMs(d, bpm) - FLAM_TARGET_MS);
    if (err < bestErr - 1e-9) {
      best = d;
      bestErr = err;
    }
  }
  return best;
}

/** フラムとみなす2打の間（秒） */
export function flamWindowSec(bpm: number, gap: FlamGap): number {
  const set = flamMs(flamDiv(bpm, gap), bpm) / 1000;
  return Math.min(0.1, Math.max(FLAM_MAX_SEC, set * 1.25));
}

export interface FlamSpot {
  /** 1打目（先に鳴る方） */
  grace: Pos;
  /** 2打目 */
  main: Pos;
  div: number;
  /** 実際の置き方（曲の頭で前に置けないときは後ろ） */
  side: FlamSide;
}

/** 拍の上の位置 at（グリッドに吸着した位置・元のチップの位置）に置くフラムの2打の位置。置けなければ null */
export function flamSpot(tempo: TempoMap, at: Pos, opts: Pick<FlamOptions, 'gap' | 'side'>): FlamSpot | null {
  const b = tempo.beatOfFrac(at.m, at.f);
  const div = flamDiv(tempo.bpmAt(toNum(b)), opts.gap);
  const g = frac(4, div);
  const side: FlamSide = opts.side === 'before' && cmp(b, g) < 0 ? 'after' : opts.side;
  const first = side === 'after' ? b : sub(b, g);
  const second = side === 'after' ? add(b, g) : b;
  const grace = tempo.locateFrac(first);
  const main = tempo.locateFrac(second);
  if (main.m >= MAX_MEASURES) return null;
  return { grace, main, div, side };
}

/** 1打目のベロシティ */
export function graceVel(mainVel: number, opts: Pick<FlamOptions, 'grace'>, step = 1): number {
  return quantizeVel((mainVel * opts.grace) / 100, step);
}

/**
 * 同じレーンの時刻順の打点（秒）から、フラムの組を探す。返すのは組の1打目の添字。
 * フラム = 間が limit 以下のすばやい2打で、その前後のチップからは間の 1.5 倍以上離れているもの
 * （32分の連打のような等間隔の連打は組にしない）
 */
export function flamPairStarts(secs: readonly number[], limit: number | ((i: number) => number)): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < secs.length; i++) {
    const dt = secs[i + 1] - secs[i];
    const lim = typeof limit === 'number' ? limit : limit(i);
    if (dt <= 1e-6 || dt > lim) continue;
    const before = i > 0 ? secs[i] - secs[i - 1] : Infinity;
    const after = i + 2 < secs.length ? secs[i + 2] - secs[i + 1] : Infinity;
    if (before < ISOLATION * dt - 1e-9 || after < ISOLATION * dt - 1e-9) continue;
    out.push(i);
    i++;
  }
  return out;
}

interface LaneNote {
  id: number;
  lane: number;
  beat: Frac;
  sec: number;
}

/** ドラムの通常チップをレーンごとに時刻順に */
function laneNotes(chips: readonly Chip[], tempo: TempoMap): Map<number, LaneNote[]> {
  const out = new Map<number, LaneNote[]>();
  for (const c of chips) {
    const info = drumChannel(c.ch);
    if (!info || info.kind !== 'normal') continue;
    const beat = tempo.beatOfFrac(c.m, c.f);
    let a = out.get(info.lane);
    if (!a) out.set(info.lane, (a = []));
    a.push({ id: c.id, lane: info.lane, beat, sec: tempo.beatToSec(toNum(beat)) });
  }
  for (const a of out.values()) a.sort((x, y) => x.sec - y.sec || x.id - y.id);
  return out;
}

export interface FlamPair {
  /** 1打目・2打目のチップ */
  a: number;
  b: number;
  lane: number;
  /** 間（秒） */
  dt: number;
}

/** 譜面にあるフラム（同じレーンのすばやい2打）の組 */
export function findFlamPairs(doc: Pick<DtxDoc, 'chips'>, tempo: TempoMap, gap: FlamGap = 'auto'): FlamPair[] {
  const out: FlamPair[] = [];
  for (const [lane, notes] of laneNotes(doc.chips, tempo)) {
    const secs = notes.map((n) => n.sec);
    const starts = flamPairStarts(secs, (i) => flamWindowSec(tempo.bpmAt(toNum(notes[i].beat)), gap));
    for (const i of starts) out.push({ a: notes[i].id, b: notes[i + 1].id, lane, dt: secs[i + 1] - secs[i] });
  }
  return out;
}

export interface FlamState {
  /** フラムにできるチップ（まだフラムの組になっていないドラムの通常チップ） */
  single: number[];
  /** 選んだチップがかかわるフラムの組 */
  pairs: FlamPair[];
}

/** 選んだチップのフラムの状態（メニューの出し分けに使う） */
export function flamState(doc: Pick<DtxDoc, 'chips'>, tempo: TempoMap, ids: readonly number[], gap: FlamGap = 'auto'): FlamState {
  const want = new Set(ids);
  const pairs = findFlamPairs(doc, tempo, gap).filter((p) => want.has(p.a) || want.has(p.b));
  const inPair = new Set(pairs.flatMap((p) => [p.a, p.b]));
  const single: number[] = [];
  for (const c of doc.chips) {
    if (!want.has(c.id) || inPair.has(c.id)) continue;
    const info = drumChannel(c.ch);
    if (info && info.kind === 'normal') single.push(c.id);
  }
  return { single, pairs };
}

export interface FlamResult {
  /** 変えたあとのチップ（2打とも。選び直すのに使う） */
  ids: number[];
  /** フラムにした数 */
  made: number;
  /** 近くに同じレーンのチップがあって変えなかった数 */
  crowded: number;
  /** 使った間隔（全音符の分割数。混ざっていれば最初のもの） */
  div: number;
}

/**
 * 選んだチップをフラムにする。元のチップを拍の上の1打として、設定の側にもう1打を足す。
 * 2打目は元のチップのベロシティ、1打目（先に鳴る方）はその grace%。もうフラムになっているチップはそのまま。
 */
export function opFlam(d: Draft<DtxDoc>, ids: ReadonlySet<number>, tempo: TempoMap, opts: FlamOptions, step: number): FlamResult {
  const res: FlamResult = { ids: [], made: 0, crowded: 0, div: 0 };
  const doc = d as DtxDoc;
  const inPair = new Set(findFlamPairs(doc, tempo, opts.gap).flatMap((p) => [p.a, p.b]));
  const lanes = laneNotes(doc.chips, tempo);
  const targets = doc.chips
    .filter((c) => ids.has(c.id) && !inPair.has(c.id) && drumChannel(c.ch)?.kind === 'normal')
    .map((c) => ({ id: c.id, beat: tempo.beatOfFrac(c.m, c.f) }))
    .sort((a, b) => cmp(a.beat, b.beat));
  let touchedVel = false;
  for (const t of targets) {
    const c = d.chips.find((x) => x.id === t.id);
    if (!c) continue;
    const info = drumChannel(c.ch)!;
    const spot = flamSpot(tempo, { m: c.m, f: c.f }, opts);
    if (!spot) {
      res.crowded++;
      continue;
    }
    const add = spot.side === 'after' ? spot.main : spot.grace;
    const addBeat = tempo.beatOfFrac(add.m, add.f);
    const half = toNum(frac(2, spot.div));
    const list = lanes.get(info.lane) ?? [];
    if (list.some((n) => n.id !== c.id && Math.abs(toNum(sub(n.beat, addBeat))) < half - 1e-9)) {
      res.crowded++;
      continue;
    }
    const mainVel = velOfWav(doc.fields, c.v);
    const gv = graceVel(mainVel, opts, step);
    const base = c.v;
    let newV = base;
    if (spot.side === 'after') {
      // 元のチップが1打目（弱く）、足すチップが2打目（元のベロシティ）
      if (gv !== mainVel) {
        c.v = wavVariant(d, base, gv);
        touchedVel = touchedVel || c.v !== base;
      }
    } else if (gv !== mainVel) {
      newV = wavVariant(d, base, gv);
    }
    const id = opPlace(d, c.ch, add, newV);
    list.push({ id, lane: info.lane, beat: addBeat, sec: tempo.beatToSec(toNum(addBeat)) });
    lanes.set(info.lane, list);
    res.ids.push(c.id, id);
    res.made++;
    if (!res.div) res.div = spot.div;
  }
  if (touchedVel) pruneVariants(d);
  return res;
}

/** 小節の中の位置の細かさ（拍で数えたときの分母。小さいほど粗いグリッドの上） */
function gridDen(tempo: TempoMap, c: Pick<Chip, 'm' | 'f'>): number {
  const bl = tempo.barLenFrac(c.m);
  return mul(c.f, mul(bl, frac(4))).d;
}

export interface UnflamResult {
  /** 残したチップ */
  ids: number[];
  /** 1打に戻した組の数 */
  count: number;
}

/**
 * フラムを1打に戻す。選んだチップがかかわる組ごとに、粗いグリッドの上にある方（同じなら設定の側で拍の上になる方）を残し、
 * ベロシティは2打の強い方にする。もう1打は消す
 */
export function opUnflam(d: Draft<DtxDoc>, ids: ReadonlySet<number>, tempo: TempoMap, opts: Pick<FlamOptions, 'gap' | 'side'>): UnflamResult {
  const doc = d as DtxDoc;
  const pairs = findFlamPairs(doc, tempo, opts.gap).filter((p) => ids.has(p.a) || ids.has(p.b));
  const res: UnflamResult = { ids: [], count: 0 };
  if (pairs.length === 0) return res;
  const drop = new Set<number>();
  let touchedVel = false;
  for (const p of pairs) {
    const a = d.chips.find((x) => x.id === p.a);
    const b = d.chips.find((x) => x.id === p.b);
    if (!a || !b) continue;
    const da = gridDen(tempo, a);
    const db = gridDen(tempo, b);
    const keep = da < db ? a : db < da ? b : opts.side === 'after' ? a : b;
    const other = keep === a ? b : a;
    const vel = Math.max(velOfWav(doc.fields, a.v), velOfWav(doc.fields, b.v));
    if (velOfWav(doc.fields, keep.v) !== vel) {
      const no = wavVariant(d, keep.v, vel);
      if (no !== keep.v) {
        keep.v = no;
        touchedVel = true;
      }
    }
    drop.add(other.id);
    res.ids.push(keep.id);
    res.count++;
  }
  for (let i = d.chips.length - 1; i >= 0; i--) if (drop.has(d.chips[i].id)) d.chips.splice(i, 1);
  if (touchedVel || drop.size) pruneVariants(d);
  return res;
}
