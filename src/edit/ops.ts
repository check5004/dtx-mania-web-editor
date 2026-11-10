// 譜面の編集操作。immer の draft に対して書き換える（呼び出し側で Undo 用のパッチを取る）。
import { tr } from '../i18n';
import type { Draft } from 'immer';
import { toBase36x2 } from '../dtx/base36';
import { add, cmp, frac, sub, ZERO, type Frac } from '../dtx/fraction';
import { CH, DRUM_LANES, channelFor, drumChannel, type Chip, type DtxDoc, type HeaderLine } from '../dtx/model';
import { MAX_MEASURES, type TempoMap } from '../dtx/timing';

/** グリッドの細かさ（全音符をいくつに分けるか）。12・24・48 は3連、20・40 は5連、28 は7連 */
export const GRID_DIVS = [4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64, 96, 192] as const;

export function gridLabel(div: number): string {
  if (div % 7 === 0) return tr(`1/${div}（7連）`, `1/${div} (septuplet)`);
  if (div % 5 === 0) return tr(`1/${div}（5連）`, `1/${div} (quintuplet)`);
  if (div % 3 === 0) return tr(`1/${div}（3連）`, `1/${div} (triplet)`);
  return `1/${div}`;
}

/** [ と ] でグリッドを1段階変える（一覧に無い細かさからは近い段へ） */
export function stepGrid(div: number, dir: 1 | -1): number {
  if (dir > 0) return GRID_DIVS.find((d) => d > div) ?? GRID_DIVS[GRID_DIVS.length - 1];
  return [...GRID_DIVS].reverse().find((d) => d < div) ?? GRID_DIVS[0];
}

/** グリッド1つ分の拍数（4分音符=1拍） */
export const gridStep = (div: number): Frac => frac(4, div);

export interface Pos {
  m: number;
  f: Frac;
}

/** 拍をグリッドに吸着する。グリッドは小節の頭から数える（変拍子でも小節線に合う） */
export function snapToGrid(tempo: TempoMap, beat: number, div: number, mode: 'round' | 'floor' = 'round'): Pos {
  const { m } = tempo.locate(Math.max(0, beat));
  const bl = tempo.barLenFrac(m);
  const steps = (div * bl.n) / bl.d;
  const rel = (beat - tempo.measureStart(m)) / (4 / div);
  let k = mode === 'round' ? Math.round(rel) : Math.floor(rel + 1e-6);
  if (k < 0) k = 0;
  if (k >= steps - 1e-9) {
    if (m + 1 < MAX_MEASURES) return { m: m + 1, f: ZERO };
    k = Math.ceil(steps) - 1;
  }
  return { m, f: frac(k * bl.d, div * bl.n) };
}

/** 小節の中の位置 f（0〜1）が、グリッド div（全音符の分割数）に乗っているか。bl は小節の長さ（4/4 = 1） */
export function onGrid(f: Frac, div: number, bl: Frac): boolean {
  // f = k / (div × bl) となる整数 k があるか
  return (f.n * div * bl.n) % (f.d * bl.d) === 0;
}

/** 位置がすべて乗る一番粗いグリッド（GRID_DIVS から）。位置が無い・どれにも乗らないときは null */
export function fittingGrid(fs: readonly Frac[], bl: Frac): number | null {
  if (fs.length === 0) return null;
  return GRID_DIVS.find((div) => fs.every((f) => onGrid(f, div, bl))) ?? null;
}

export function posToBeatFrac(tempo: TempoMap, p: Pos): Frac {
  return tempo.beatOfFrac(p.m, p.f);
}

/** 同じ場所を取り合うチップか（ドラムはレーンと種類、それ以外はチャンネルが同じなら重なり） */
export function conflictKey(ch: number): string {
  const d = drumChannel(ch);
  return d ? `L${d.lane}:${d.kind}` : `C${ch}`;
}

function removeAt(chips: Draft<Chip>[], index: number) {
  const last = chips.length - 1;
  if (index !== last) chips[index] = chips[last];
  chips.pop();
}

/** チップを消す（並び順は気にしないので、末尾と入れ替えて消す） */
export function opDelete(d: Draft<DtxDoc>, ids: ReadonlySet<number>): number {
  let n = 0;
  for (let i = d.chips.length - 1; i >= 0; i--) {
    if (ids.has(d.chips[i].id)) {
      removeAt(d.chips, i);
      n++;
    }
  }
  return n;
}

/** チップを置く。同じ場所に同じ種類のチップがあれば置き換える */
export function opPlace(d: Draft<DtxDoc>, ch: number, p: Pos, v: number): number {
  const key = conflictKey(ch);
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (c.m === p.m && c.f.n === p.f.n && c.f.d === p.f.d && conflictKey(c.ch) === key) removeAt(d.chips, i);
  }
  const id = d.nextId++;
  d.chips.push({ id, ch, m: p.m, f: { n: p.f.n, d: p.f.d }, v });
  return id;
}

/** レーンを移すときのチャンネル。HHオープンや左バスドラムは、移った先に2種目があればそのまま */
export function channelInLane(ch: number, lane: number): number | null {
  const info = drumChannel(ch);
  if (!info) return null;
  const def = DRUM_LANES[lane];
  if (!def) return null;
  const base = info.alt && def.alt !== undefined ? def.alt : def.main;
  return channelFor(base, info.kind);
}

/**
 * 選んだチップを動かす。拍のずれ（分数）とレーンのずれを受け取る。
 * 曲頭より前や範囲外にはみ出す場合は何もしないで false を返す。
 */
export function opMove(
  d: Draft<DtxDoc>,
  ids: ReadonlySet<number>,
  tempo: TempoMap,
  dBeat: Frac,
  dLane: number,
  shift: (lane: number, d: number) => number | null = (l, n) => l + n,
): boolean {
  const moves: { index: number; ch: number; p: Pos }[] = [];
  for (let i = 0; i < d.chips.length; i++) {
    const c = d.chips[i];
    if (!ids.has(c.id)) continue;
    const beat = add(tempo.beatOfFrac(c.m, c.f), dBeat);
    if (beat.n < 0) return false;
    const p = tempo.locateFrac(beat);
    if (p.m >= MAX_MEASURES) return false;
    let ch: number | null = c.ch;
    if (dLane !== 0) {
      const info = drumChannel(c.ch);
      if (info) {
        const to = shift(info.lane, dLane);
        ch = to === null ? null : channelInLane(c.ch, to);
        if (ch === null) return false;
      }
    }
    moves.push({ index: i, ch, p });
  }
  if (moves.length === 0) return false;
  for (const mv of moves) {
    const c = d.chips[mv.index];
    c.ch = mv.ch;
    c.m = mv.p.m;
    c.f = { n: mv.p.f.n, d: mv.p.f.d };
  }
  // 動かした先にあった（選んでいない）チップは上書きする
  const taken = new Set(moves.map((mv) => `${conflictKey(mv.ch)}@${mv.p.m}:${mv.p.f.n}/${mv.p.f.d}`));
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (ids.has(c.id)) continue;
    if (taken.has(`${conflictKey(c.ch)}@${c.m}:${c.f.n}/${c.f.d}`)) removeAt(d.chips, i);
  }
  return true;
}

export interface ClipItem {
  ch: number;
  /** 先頭のチップからの拍のずれ */
  offset: Frac;
  v: number;
}

export function makeClip(chips: readonly Chip[], tempo: TempoMap): ClipItem[] {
  if (chips.length === 0) return [];
  const beats = chips.map((c) => tempo.beatOfFrac(c.m, c.f));
  let min = beats[0];
  for (const b of beats) if (cmp(b, min) < 0) min = b;
  return chips.map((c, i) => ({ ch: c.ch, offset: sub(beats[i], min), v: c.v }));
}

export function opPaste(d: Draft<DtxDoc>, items: readonly ClipItem[], at: Frac, tempo: TempoMap): number[] {
  const ids: number[] = [];
  for (const it of items) {
    const p = tempo.locateFrac(add(at, it.offset));
    if (p.m >= MAX_MEASURES) continue;
    ids.push(opPlace(d, it.ch, p, it.v));
  }
  return ids;
}

/** チップの種類（通常・不可視・音だけ）を変える */
export function opSetKind(d: Draft<DtxDoc>, ids: ReadonlySet<number>, kind: 'normal' | 'hidden' | 'nochip') {
  for (const c of d.chips) {
    if (!ids.has(c.id)) continue;
    const info = drumChannel(c.ch);
    if (info) c.ch = channelFor(info.base, kind);
  }
}

export function opSetValue(d: Draft<DtxDoc>, ids: ReadonlySet<number>, v: number) {
  for (const c of d.chips) if (ids.has(c.id)) c.v = v;
}

// ---- ヘッダ -------------------------------------------------------------------

/** 曲情報としてまとめて並べるコマンド（この順で新しい行を入れる） */
export const INFO_KEYS = [
  'TITLE', 'ARTIST', 'GENRE', 'COMMENT', 'PANEL', 'BPM', 'BASEBPM', 'DLEVEL', 'GLEVEL', 'BLEVEL',
  'HIDDENLEVEL', 'PREVIEW', 'PREIMAGE', 'PREMOVIE', 'STAGEFILE', 'BACKGROUND', 'RESULTIMAGE', 'PATH_WAV',
];

const GROUP_RE = /^(WAV|VOLUME|WAVVOL|PAN|WAVPAN|BPM|BMP|BMPTEX|AVI|SIZE)[0-9A-Z]{2}$/;

/** 新しい定義の行を入れる所（header の位置）。dtx/patchText もテキストの行に同じ所を選ぶ */
export function insertIndexFor(header: readonly HeaderLine[], key: string): number {
  const g = GROUP_RE.exec(key);
  let last = -1;
  if (g) {
    // 同じ種類の定義（#WAVxx なら最後の #WAVxx）の後ろ
    const re = new RegExp(`^${g[1]}[0-9A-Z]{2}$`);
    header.forEach((h, i) => {
      if (h.kind === 'field' && re.test(h.key)) last = i;
    });
    if (last < 0 && g[1] !== 'WAV') {
      header.forEach((h, i) => {
        if (h.kind === 'field' && /^WAV[0-9A-Z]{2}$/.test(h.key)) last = i;
      });
    }
  } else {
    const order = INFO_KEYS.indexOf(key);
    header.forEach((h, i) => {
      if (h.kind !== 'field') return;
      const o = INFO_KEYS.indexOf(h.key);
      if (o >= 0 && (order < 0 || o <= order)) last = i;
    });
  }
  if (last < 0) {
    // 最後の定義行の後ろ（なければ末尾）
    header.forEach((h, i) => {
      if (h.kind === 'field') last = i;
    });
    if (last < 0) return header.length;
  }
  return last + 1;
}

/** ヘッダの値を設定する。undefined なら行ごと消す */
export function setField(d: Draft<DtxDoc>, key: string, value: string | undefined) {
  const k = key.toUpperCase();
  if (value === undefined) {
    delete d.fields[k];
    for (let i = d.header.length - 1; i >= 0; i--) {
      const h = d.header[i];
      if (h.kind === 'field' && h.key === k) d.header.splice(i, 1);
    }
    return;
  }
  const exists = d.header.some((h) => h.kind === 'field' && h.key === k);
  if (!exists) {
    const idx = insertIndexFor(d.header as HeaderLine[], k);
    d.header.splice(idx, 0, { kind: 'field', key: k, name: k, sep: ': ', comment: null });
  }
  d.fields[k] = value;
}

/** ヘッダの行のコメント（「;」のあと）を変える。WAV のラベルに使う */
export function setFieldComment(d: Draft<DtxDoc>, key: string, comment: string) {
  const k = key.toUpperCase();
  for (const h of d.header) {
    if (h.kind !== 'field' || h.key !== k) continue;
    const next = comment.trim() ? ` ${comment.trim()}` : null;
    if ((h.comment ?? null) === next || (h.comment?.trim() ?? '') === comment.trim()) return;
    h.comment = next;
    delete h.orig;
  }
}

/** 空いている WAV 番号（01〜ZZ）を探す */
export function freeWavNumber(doc: Pick<DtxDoc, 'fields' | 'chips'>, from = 1): number | null {
  const used = new Set<number>();
  for (const c of doc.chips) if (c.ch !== CH.BPM && c.ch !== CH.BPM_EX) used.add(c.v);
  for (let n = from; n < 36 * 36; n++) {
    if (used.has(n)) continue;
    if (doc.fields['WAV' + toBase36x2(n)] !== undefined) continue;
    return n;
  }
  return null;
}

/** チャンネルごとに一番多く使われている WAV 番号 */
export function mostUsedWav(doc: Pick<DtxDoc, 'chips'>): Map<number, number> {
  const count = new Map<number, Map<number, number>>();
  for (const c of doc.chips) {
    const info = drumChannel(c.ch);
    if (!info) continue;
    let m = count.get(info.base);
    if (!m) count.set(info.base, (m = new Map()));
    m.set(c.v, (m.get(c.v) ?? 0) + 1);
  }
  const out = new Map<number, number>();
  for (const [ch, m] of count) {
    let best = -1;
    let bestN = 0;
    for (const [v, n] of m) if (n > bestN) [best, bestN] = [v, n];
    if (best > 0) out.set(ch, best);
  }
  return out;
}

