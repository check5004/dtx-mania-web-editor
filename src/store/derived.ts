// 譜面から計算する値（テンポ表、表示用のチップ一覧、再生イベント）。doc ごとにキャッシュする。
import type { SoundEvent, WavSource } from '../audio/engine';
import { virtualSound } from '../audio/sounds';
import { parseNxNumber, toBase36x2 } from '../dtx/base36';
import { CH, drumChannel, isSeChannel, type Chip, type ChipKind, type DtxDoc } from '../dtx/model';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { findFile, type SongFolder } from '../fs/folder';

let lastTempo: { barLengths: object; fields: object; sig: string; map: TempoMap } | null = null;
const tempoCache = new WeakMap<DtxDoc, TempoMap>();

function bpmSignature(doc: DtxDoc): string {
  let s = '';
  for (const c of doc.chips) if (c.ch === CH.BPM || c.ch === CH.BPM_EX) s += `${c.ch}:${c.m}:${c.f.n}/${c.f.d}=${c.v};`;
  return s;
}

export function tempoOf(doc: DtxDoc): TempoMap {
  let t = tempoCache.get(doc);
  if (t) return t;
  const sig = bpmSignature(doc);
  if (lastTempo && lastTempo.barLengths === doc.barLengths && lastTempo.fields === doc.fields && lastTempo.sig === sig) {
    t = lastTempo.map;
  } else {
    t = buildTempoMap(doc);
    lastTempo = { barLengths: doc.barLengths, fields: doc.fields, sig, map: t };
  }
  tempoCache.set(doc, t);
  return t;
}

/** 譜面上の列。0〜9 はドラムのレーン */
export const COL_BPM = -1;
export const COL_BGM = -2;

export interface ChipView {
  c: Chip;
  beat: number;
  col: number;
  kind: ChipKind;
  alt: boolean;
}

const viewCache = new WeakMap<DtxDoc, ChipView[]>();

export function chipViews(doc: DtxDoc): ChipView[] {
  let v = viewCache.get(doc);
  if (v) return v;
  const t = tempoOf(doc);
  v = [];
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    let col: number;
    if (d) col = d.lane;
    else if (c.ch === CH.BPM || c.ch === CH.BPM_EX) col = COL_BPM;
    else if (c.ch === CH.BGM || isSeChannel(c.ch)) col = COL_BGM;
    else continue;
    v.push({ c, beat: t.beatOf(c.m, c.f), col, kind: d?.kind ?? 'normal', alt: d?.alt ?? false });
  }
  v.sort((a, b) => a.beat - b.beat);
  viewCache.set(doc, v);
  return v;
}

/** 表示中の範囲のチップを二分探索で取り出す */
export function viewsInRange(views: ChipView[], from: number, to: number): ChipView[] {
  let lo = 0;
  let hi = views.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (views[mid].beat < from) lo = mid + 1;
    else hi = mid;
  }
  const out: ChipView[] = [];
  for (let i = lo; i < views.length && views[i].beat <= to; i++) out.push(views[i]);
  return out;
}

export interface DocStats {
  notes: number;
  perLane: number[];
  lastBeat: number;
  measures: number;
  wavCount: number;
}

const statsCache = new WeakMap<DtxDoc, DocStats>();

export function docStats(doc: DtxDoc): DocStats {
  let s = statsCache.get(doc);
  if (s) return s;
  const perLane = new Array(10).fill(0);
  let notes = 0;
  let lastM = 0;
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (d && d.kind === 'normal') {
      perLane[d.lane]++;
      notes++;
    }
    if (c.m > lastM) lastM = c.m;
  }
  const views = chipViews(doc);
  const wavCount = Object.keys(doc.fields).filter((k) => /^WAV[0-9A-Z]{2}$/.test(k)).length;
  s = { notes, perLane, lastBeat: views.length ? views[views.length - 1].beat : 0, measures: lastM + 1, wavCount };
  statsCache.set(doc, s);
  return s;
}

// ---- 再生 ---------------------------------------------------------------------

export function wavPath(doc: DtxDoc, no: number): string | undefined {
  return doc.fields['WAV' + toBase36x2(no)];
}

function numField(fields: Record<string, string>, keys: string[], def: number): number {
  for (const k of keys) {
    const raw = fields[k];
    if (raw === undefined) continue;
    const neg = raw.trim().startsWith('-');
    const v = parseNxNumber(raw.trim().replace(/^[-+]/, ''));
    if (v !== null) return neg ? -v : v;
  }
  return def;
}

export function wavVolume(doc: DtxDoc, no: number): number {
  const z = toBase36x2(no);
  return numField(doc.fields, ['VOLUME' + z, 'WAVVOL' + z], 100);
}

export function wavPan(doc: DtxDoc, no: number): number {
  const z = toBase36x2(no);
  return numField(doc.fields, ['PAN' + z, 'WAVPAN' + z], 0);
}

/** 再生で鳴らす WAV の一覧と、その読み込み方 */
export function wavSources(doc: DtxDoc, folder: SongFolder | null): WavSource[] {
  const used = new Set<number>();
  for (const c of doc.chips) if (soundBus(c.ch)) used.add(c.v);
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const out: WavSource[] = [];
  for (const no of used) {
    const path = wavPath(doc, no);
    if (!path) continue;
    const f = findFile(folder, path, pathWav);
    const vs = f ? null : virtualSound(path);
    if (!f && !vs) {
      out.push({ no, key: `missing:${path}`, volume: 100, pan: 0 });
      continue;
    }
    out.push({
      no,
      key: f ? `${folder?.name}|${f.path}|${f.size}|${f.ver ?? 0}` : `virtual:${vs!.sampleId ?? vs!.file.toLowerCase()}`,
      load: f ? async () => (await f.getFile()).arrayBuffer() : undefined,
      fallback: vs ? () => vs.load() : undefined,
      volume: wavVolume(doc, no),
      pan: wavPan(doc, no),
    });
  }
  return out.sort((a, b) => a.no - b.no);
}

export function soundBus(ch: number): SoundEvent['bus'] | null {
  if (ch === CH.BGM) return 'bgm';
  if (isSeChannel(ch)) return 'se';
  const d = drumChannel(ch);
  if (d && d.kind === 'normal') return 'drum';
  return null;
}

/** ハイハット・左ペダルは同じグループで前の音を止める（NXのHHグループの既定に近い） */
function chokeGroup(ch: number): string | null {
  const d = drumChannel(ch);
  if (!d) return null;
  if (ch === CH.HHC || ch === CH.HHO || ch === CH.LP) return 'HH';
  return `L${d.lane}:${ch}`;
}

const eventCache = new WeakMap<DtxDoc, SoundEvent[]>();

export function soundEvents(doc: DtxDoc): SoundEvent[] {
  let ev = eventCache.get(doc);
  if (ev) return ev;
  const t = tempoOf(doc);
  ev = [];
  for (const c of doc.chips) {
    const bus = soundBus(c.ch);
    if (!bus) continue;
    ev.push({ sec: t.beatToSec(t.beatOf(c.m, c.f)), wav: c.v, bus, choke: bus === 'drum' ? chokeGroup(c.ch) : null, lane: drumChannel(c.ch)?.lane ?? -1 });
  }
  ev.sort((a, b) => a.sec - b.sec);
  eventCache.set(doc, ev);
  return ev;
}

/**
 * 再生で鳴らす音。譜面のチップに、ステム（原曲を楽器ごとに分けた音）などを足したもの。
 * 足すものは store/stems が登録する（循環を避けるため関数で受け取る）。
 */
let playbackTransform: { ver: number; fn: (doc: DtxDoc, ev: SoundEvent[]) => SoundEvent[] } | null = null;
const playbackCache = new WeakMap<DtxDoc, { ver: number; ev: SoundEvent[] }>();

export function setPlaybackTransform(fn: ((doc: DtxDoc, ev: SoundEvent[]) => SoundEvent[]) | null) {
  playbackTransform = fn ? { ver: (playbackTransform?.ver ?? 0) + 1, fn } : null;
}

export function playbackEvents(doc: DtxDoc): SoundEvent[] {
  const base = soundEvents(doc);
  const tr = playbackTransform;
  if (!tr) return base;
  const hit = playbackCache.get(doc);
  if (hit && hit.ver === tr.ver) return hit.ev;
  const ev = tr.fn(doc, base).slice().sort((a, b) => a.sec - b.sec);
  playbackCache.set(doc, { ver: tr.ver, ev });
  return ev;
}

/** BGM（ch01）で一番先に鳴るチップ。原曲の 0 秒が譜面の何秒かを決める */
export interface BgmSource {
  wav: number;
  chipId: number;
  beat: number;
  sec: number;
}

const bgmCache = new WeakMap<DtxDoc, BgmSource | null>();

export function bgmSource(doc: DtxDoc): BgmSource | null {
  const hit = bgmCache.get(doc);
  if (hit !== undefined) return hit;
  let best: Chip | null = null;
  let bestBeat = Infinity;
  const t = tempoOf(doc);
  for (const c of doc.chips) {
    if (c.ch !== CH.BGM) continue;
    const b = t.beatOf(c.m, c.f);
    if (b < bestBeat) {
      bestBeat = b;
      best = c;
    }
  }
  const r = best ? { wav: best.v, chipId: best.id, beat: bestBeat, sec: t.beatToSec(bestBeat) } : null;
  bgmCache.set(doc, r);
  return r;
}

/** メトロノームの拍（小節の頭は強く） */
export function clickTimes(doc: DtxDoc, fromSec: number, toSec: number): { sec: number; accent: boolean }[] {
  const t = tempoOf(doc);
  const out: { sec: number; accent: boolean }[] = [];
  const startBeat = Math.max(0, Math.floor(t.secToBeat(fromSec)) - 1);
  const endBeat = t.secToBeat(toSec) + 1;
  let { m } = t.locate(startBeat);
  for (; m < 3600; m++) {
    const s = t.measureStart(m);
    if (s > endBeat) break;
    const beats = t.measureBeats(m);
    for (let b = 0; b < beats - 1e-9; b++) {
      const beat = s + b;
      if (beat < startBeat) continue;
      out.push({ sec: t.beatToSec(beat), accent: b === 0 });
    }
  }
  return out;
}

// ---- 強さ -----------------------------------------------------------------------

const velCache = new WeakMap<Record<string, string>, Map<number, number>>();

/** WAV 番号の強さ（#VOLUME、1〜100）。ヘッダが変わるまで覚えておく */
export function wavVel(doc: DtxDoc, no: number): number {
  let m = velCache.get(doc.fields);
  if (!m) velCache.set(doc.fields, (m = new Map()));
  let v = m.get(no);
  if (v === undefined) {
    v = Math.max(1, Math.min(100, Math.round(wavVolume(doc, no))));
    m.set(no, v);
  }
  return v;
}
