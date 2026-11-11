// ベロシティ（ベロシティ）。DTXには音ごとのベロシティが無く、音量は WAV 番号ごと（#VOLUMEzz）にしか持てない。
// そこで「チップのベロシティ = そのチップの WAV の #VOLUME」とし、ベロシティを変えるときは
// 同じファイルで #VOLUME だけ違う WAV 番号（ベロシティ違い）に付け替える。譜面はいつでもそのまま NX で遊べる。
import type { Draft } from 'immer';
import { parseNxNumber, toBase36x2 } from '../dtx/base36';
import { CH, drumChannel, isSeChannel, type Chip, type DtxDoc, type HeaderLine } from '../dtx/model';
import { specialWavsOf } from '../dtx/kinds';
import { rimWavsOf } from '../dtx/rim';
import { freeWavNumber, setField } from './ops';
import { copyWavLabel } from './rim';

export const VEL_MIN = 1;
export const VEL_MAX = 100;

type Fields = Record<string, string>;

function num(fields: Fields, keys: string[], def: number): number {
  for (const k of keys) {
    const raw = fields[k];
    if (raw === undefined) continue;
    const t = raw.trim();
    const neg = t.startsWith('-');
    const v = parseNxNumber(t.replace(/^[-+]/, ''));
    if (v !== null) return neg ? -v : v;
  }
  return def;
}

/** WAV の音量（#VOLUMEzz、無ければ 100） */
export function wavVolumeOf(fields: Fields, no: number): number {
  const z = toBase36x2(no);
  return num(fields, ['VOLUME' + z, 'WAVVOL' + z], 100);
}

export function wavPanOf(fields: Fields, no: number): number {
  const z = toBase36x2(no);
  return num(fields, ['PAN' + z, 'WAVPAN' + z], 0);
}

function normFile(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * 「同じ音」の見分け方：ファイルとパンが同じなら、#VOLUME だけ違っても同じ音のベロシティ違い。
 * ただしリムの音（rims。ラベルで決まる）とそうでない音は、同じファイルでも別の音（ベロシティを変えてもリムがスネアにならない）。
 * 特殊ノーツの種類（kinds。クラップなど、ラベルで決まる）も同じ（ベロシティを変えてもクラップがハイタムにならない）
 */
export function soundKeyOf(fields: Fields, no: number, rims?: ReadonlySet<number>, kinds?: ReadonlyMap<number, string>): string | null {
  const path = fields['WAV' + toBase36x2(no)];
  if (path === undefined) return null;
  const kind = kinds?.get(no);
  return `${normFile(path)}|${Math.round(wavPanOf(fields, no))}${rims?.has(no) ? '|rim' : ''}${kind ? `|k:${kind}` : ''}`;
}

export function clampVel(v: number): number {
  return Math.max(VEL_MIN, Math.min(VEL_MAX, Math.round(v)));
}

/** ベロシティを刻みにまとめる（5刻みなら 5,10,…,100。1 ならまとめない） */
export function quantizeVel(v: number, step: number): number {
  if (step <= 1) return clampVel(v);
  const q = Math.round(v / step) * step;
  return Math.max(step, Math.min(VEL_MAX, q));
}

/** WAV 番号のベロシティ（1〜100） */
export function velOfWav(fields: Fields, no: number): number {
  return clampVel(wavVolumeOf(fields, no));
}

/** ベロシティを変えられるチップのチャンネルか（ドラムと、自動で鳴らす SE。特殊ノーツの自動のチップのため） */
export function velChannel(ch: number): boolean {
  return !!drumChannel(ch) || isSeChannel(ch);
}

/** ドラムのチップのベロシティ。ドラム以外は null */
export function chipVel(doc: Pick<DtxDoc, 'fields'>, c: Pick<Chip, 'ch' | 'v'>): number | null {
  if (!drumChannel(c.ch)) return null;
  return velOfWav(doc.fields, c.v);
}

/** 譜面にある WAV 番号の一覧 */
function wavNumbers(fields: Fields): number[] {
  const out: number[] = [];
  for (const k of Object.keys(fields)) if (/^WAV[0-9A-Z]{2}$/.test(k)) out.push(parseInt(k.slice(3), 36));
  return out.sort((a, b) => a - b);
}

/** 同じ音のベロシティ違い（ベロシティ → WAV 番号）。同じベロシティが複数あれば小さい番号。rims はリムの音の番号 */
export function variantsOf(fields: Fields, no: number, rims?: ReadonlySet<number>, kinds?: ReadonlyMap<number, string>): Map<number, number> {
  const key = soundKeyOf(fields, no, rims, kinds);
  const out = new Map<number, number>();
  if (key === null) return out;
  for (const n of wavNumbers(fields)) {
    if (soundKeyOf(fields, n, rims, kinds) !== key) continue;
    const v = velOfWav(fields, n);
    if (!out.has(v)) out.set(v, n);
  }
  return out;
}

/**
 * 同じ音でベロシティ vel の WAV 番号を返す。無ければ新しい番号を登録する（#WAV と #VOLUME、パンとラベルもそろえる）。
 * 番号が足りないときは元の番号のまま。
 */
export function wavVariant(d: Draft<DtxDoc>, base: number, vel: number): number {
  const fields = d.fields as Fields;
  const z = toBase36x2(base);
  const path = fields['WAV' + z];
  if (path === undefined) return base;
  const want = clampVel(vel);
  if (velOfWav(fields, base) === want) return base;
  const hit = variantsOf(fields, base, rimWavsOf(d as DtxDoc), specialWavsOf(d as DtxDoc)).get(want);
  if (hit !== undefined) return hit;
  const no = freeWavNumber(d as DtxDoc);
  if (no === null) return base;
  const nz = toBase36x2(no);
  setField(d, 'WAV' + nz, path);
  if (want !== 100) setField(d, 'VOLUME' + nz, String(want));
  const pan = Math.round(wavPanOf(fields, base));
  if (pan !== 0) setField(d, 'PAN' + nz, String(pan));
  // ラベルも写す（リムの音はラベルで決まることがあるので、落とすとベロシティを変えたリムがスネアになる）
  copyWavLabel(d, base, no);
  return no;
}

/** チップが使っている WAV 番号（ヘッダの生の行に書かれたチップ＝#IF の中なども含める） */
export function usedWavs(d: Pick<DtxDoc, 'chips' | 'header'>): Set<number> {
  const used = new Set<number>();
  for (const c of d.chips) if (c.ch !== CH.BPM && c.ch !== CH.BPM_EX) used.add(c.v);
  for (const h of d.header as readonly HeaderLine[]) {
    if (h.kind !== 'raw') continue;
    const m = /^#[0-9A-Z]{3}[0-9A-Fa-f]{2}\s*:?\s*([0-9A-Za-z]+)/.exec(h.text.trim());
    if (!m) continue;
    const data = m[1];
    for (let i = 0; i + 1 < data.length; i += 2) {
      const n = parseInt(data.slice(i, i + 2), 36);
      if (n > 0) used.add(n);
    }
  }
  return used;
}

/**
 * ベロシティを変えたあと、使われなくなったベロシティ違いの WAV を消す。
 * 消すのはエディタが作った定義（読み込んだファイルに無かった行）で、同じ音の別の番号が残っているものだけ。
 */
export function pruneVariants(d: Draft<DtxDoc>): number {
  const fields = d.fields as Fields;
  const used = usedWavs(d as DtxDoc);
  const rims = rimWavsOf(d as DtxDoc);
  const kinds = specialWavsOf(d as DtxDoc);
  const created = new Set<string>();
  for (const h of d.header as HeaderLine[]) if (h.kind === 'field' && !h.orig && /^WAV[0-9A-Z]{2}$/.test(h.key)) created.add(h.key);
  let n = 0;
  for (const no of wavNumbers(fields)) {
    const z = toBase36x2(no);
    if (used.has(no) || !created.has('WAV' + z)) continue;
    const key = soundKeyOf(fields, no, rims, kinds);
    const others = wavNumbers(fields).some((o) => o !== no && soundKeyOf(fields, o, rims, kinds) === key);
    if (!others) continue;
    for (const k of ['WAV', 'VOLUME', 'WAVVOL', 'PAN', 'WAVPAN']) if (fields[k + z] !== undefined) setField(d, k + z, undefined);
    n++;
  }
  return n;
}

/** エディタが足した WAV 定義（読み込んだファイルに無かった行）で、どのチップも使っていないものを消す */
export function pruneUnusedCreated(d: Draft<DtxDoc>): number {
  const fields = d.fields as Fields;
  const used = usedWavs(d as DtxDoc);
  let n = 0;
  for (const h of [...(d.header as HeaderLine[])]) {
    if (h.kind !== 'field' || h.orig || !/^WAV[0-9A-Z]{2}$/.test(h.key)) continue;
    const z = h.key.slice(3);
    if (used.has(parseInt(z, 36))) continue;
    for (const k of ['WAV', 'VOLUME', 'WAVVOL', 'PAN', 'WAVPAN']) if (fields[k + z] !== undefined) setField(d, k + z, undefined);
    n++;
  }
  return n;
}

/**
 * チップのベロシティを変える。fn は今のベロシティから新しいベロシティを返す（null なら変えない）。
 * 変わったチップの数を返す。
 */
export function opSetVelocity(
  d: Draft<DtxDoc>,
  ids: ReadonlySet<number>,
  fn: (cur: number, c: Chip) => number | null,
  step: number,
): number {
  let n = 0;
  for (const c of d.chips) {
    if (!ids.has(c.id) || !velChannel(c.ch)) continue;
    const cur = velOfWav(d.fields as Fields, c.v);
    const raw = fn(cur, c as Chip);
    if (raw === null) continue;
    const nv = quantizeVel(raw, step);
    if (nv === cur) continue;
    const no = wavVariant(d, c.v, nv);
    if (no !== c.v) {
      c.v = no;
      n++;
    }
  }
  if (n) pruneVariants(d);
  return n;
}

/** ベロシティ違いをまとめた「音」の一覧（WAVリストの表示用） */
export interface SoundGroup {
  key: string;
  path: string;
  /** ベロシティの高い順 */
  variants: { no: number; vel: number }[];
}

export function soundGroups(fields: Fields, rims?: ReadonlySet<number>, kinds?: ReadonlyMap<number, string>): SoundGroup[] {
  const map = new Map<string, SoundGroup>();
  for (const no of wavNumbers(fields)) {
    const key = soundKeyOf(fields, no, rims, kinds)!;
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, path: fields['WAV' + toBase36x2(no)], variants: [] }));
    g.variants.push({ no, vel: velOfWav(fields, no) });
  }
  for (const g of map.values()) g.variants.sort((a, b) => b.vel - a.vel || a.no - b.no);
  return [...map.values()];
}

/** 電子ドラムのベロシティ（0〜1）を 1〜100 にする */
export function midiToVel(x: number, curve: 'soft' | 'normal' | 'hard'): number {
  const k = curve === 'soft' ? 0.6 : curve === 'hard' ? 1.6 : 1;
  return clampVel(100 * Math.pow(Math.max(0, Math.min(1, x)), k));
}
