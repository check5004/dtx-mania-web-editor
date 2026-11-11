// チップのエフェクト（ハイカット・ローカット・ピッチ）。DTX には音にエフェクトをかける仕組みが無いので、
// 曲全体に引いたカーブ（DAW のオートメーションと同じ）の値をチップが鳴る時刻で読み、その値をかけた音を作って
// チップの音（WAV）を差し替える。NX ではふつうの音として鳴る。
// - カーブは作業ファイル（.dtxe.json）に置く（点・形・かけるレーン・境目の強調）。譜面には「かけた音」の #WAV と、
//   その前の行のコメント「;fx 元の音 かけ方」だけを書く（開き直すと、どの音をどうかけた音かが分かる）
// - 値は 1/6 オクターブ（なめらかさで 1/3・1/12）に丸め、呼び名（R10・R20・R40 の数）をファイル名にも使う
// - ハイカットの 14 kHz 以上・ローカットの 40 Hz 以下は「かけない」（耳ではほぼ分からず、音の数だけ増える）
// - ピッチは半音ごと（細かいでは 1/2 半音）。サンプラーと同じく、高くすると短く・低くすると長くなる
import type { TempoMap } from '../dtx/timing';

export type FxType = 'hicut' | 'locut' | 'pitch';
/** 次の点までの形：なめらか（まっすぐ）・ゆっくり・急に・S字・そのまま（次の点で替わる） */
export type FxShape = 'smooth' | 'slow' | 'fast' | 'scurve' | 'hold';
/** 境目の強調（なし・少し・強め）。ハイカット・ローカットだけ */
export type FxEmphasis = 0 | 1 | 2;
/** なめらかさ（1 オクターブをいくつに分けるか）：粗い 3・ふつう 6・細かい 12 */
export type FxRes = 3 | 6 | 12;

/** カーブの点。時刻は小節と小節内の分数（チップと同じ。拍子やテンポを変えてもチップと一緒に動く）、v は Hz か半音 */
export interface FxPoint {
  m: number;
  n: number;
  d: number;
  v: number;
  /** 次の点までの形（無ければなめらか） */
  s?: FxShape;
}

export interface FxCurve {
  id: string;
  type: FxType;
  /** 時刻の順 */
  points: FxPoint[];
  /** かけるレーン（DRUM_LANES の key。null は全部のレーン） */
  lanes: string[] | null;
  /** 境目の強調 */
  q: FxEmphasis;
}

/** 譜面のエフェクト（作業ファイルの fx）。null の譜面はエフェクトを扱わない（かけた音があっても触らない） */
export interface FxSide {
  curves: FxCurve[];
  res: FxRes;
  /** 長く鳴る音（シンバルなど）は余韻もカーブどおり */
  tails: boolean;
}

export const emptyFxSide = (): FxSide => ({ curves: [], res: 6, tails: true });

/** エフェクトの列の周波数の範囲（Hz） */
export const FX_LO = 30;
export const FX_HI = 16000;
/** ハイカットはこれ以上なら「かけない」（呼び名で比べる） */
export const HICUT_OFF = 14000;
/** ローカットはこれ以下なら「かけない」 */
export const LOCUT_OFF = 40;
/** ピッチの列の範囲（半音） */
export const PITCH_RANGE = 12;
/** ピッチの合計の上限（カーブを重ねたとき） */
export const PITCH_MAX = 24;

export const FX_COLORS: Record<FxType, string> = { hicut: '#FFB547', locut: '#A98BFF', pitch: '#5BD69A' };

export const isFilter = (t: FxType) => t !== 'pitch';

// ---- 形 ---------------------------------------------------------------------------------------

/** 0〜1 の進み p を形に合わせる */
export function shapeAt(s: FxShape | undefined, p: number): number {
  switch (s) {
    case 'slow':
      return p * p;
    case 'fast':
      return 1 - (1 - p) * (1 - p);
    case 'scurve':
      return p * p * (3 - 2 * p);
    case 'hold':
      return 0;
    default:
      return p;
  }
}

/** 2 つの値のあいだ（フィルターは周波数の比で、ピッチは半音で） */
export function lerpValue(type: FxType, a: number, b: number, p: number): number {
  if (p <= 0 || a === b) return a;
  if (p >= 1) return b;
  if (type === 'pitch') return a + (b - a) * p;
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * p);
}

// ---- カーブの値 ----------------------------------------------------------------------------------

/** 拍で並べたカーブ（読むたびに拍を数えないように） */
export interface CurveBeats {
  curve: FxCurve;
  beats: number[];
  vals: number[];
  shapes: (FxShape | undefined)[];
  /** かけるレーン（レーンの番号。null は全部） */
  lanes: Set<number> | null;
}

export const pointBeat = (tempo: TempoMap, p: Pick<FxPoint, 'm' | 'n' | 'd'>) => tempo.beatOf(p.m, { n: p.n, d: p.d });

/** 点を時刻の順に（同じ時刻は後に置いた方を後ろに） */
export function sortPoints(points: readonly FxPoint[]): FxPoint[] {
  return points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.m - b.p.m || a.p.n * b.p.d - b.p.n * a.p.d || a.i - b.i)
    .map((x) => x.p);
}

export function curveBeats(curve: FxCurve, tempo: TempoMap, laneIndex: (key: string) => number): CurveBeats {
  const pts = sortPoints(curve.points);
  return {
    curve,
    beats: pts.map((p) => pointBeat(tempo, p)),
    vals: pts.map((p) => p.v),
    shapes: pts.map((p) => p.s),
    lanes: curve.lanes ? new Set(curve.lanes.map(laneIndex).filter((i) => i >= 0)) : null,
  };
}

const EPS = 1e-9;

/** 拍 beat でのカーブの値。最初の点より前と最後の点より後は null（かけない） */
export function valueAt(c: Pick<CurveBeats, 'beats' | 'vals' | 'shapes' | 'curve'>, beat: number): number | null {
  const b = c.beats;
  const n = b.length;
  if (n === 0 || beat < b[0] - EPS || beat > b[n - 1] + EPS) return null;
  // beat 以下で最後の点
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (b[mid] <= beat + EPS) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= n - 1) return c.vals[n - 1];
  const span = b[lo + 1] - b[lo];
  if (span <= EPS) return c.vals[lo + 1];
  const p = Math.max(0, Math.min(1, (beat - b[lo]) / span));
  return lerpValue(c.curve.type, c.vals[lo], c.vals[lo + 1], shapeAt(c.shapes[lo], p));
}

/** 時刻 beat・レーン lane のチップにかかる値（ハイカットはいちばん低い・ローカットはいちばん高いカーブ、ピッチは足す） */
export interface FxVals {
  hicut: number | null;
  locut: number | null;
  pitch: number | null;
  hq: FxEmphasis;
  lq: FxEmphasis;
}

export function valsAt(curves: readonly CurveBeats[], lane: number, beat: number): FxVals {
  const out: FxVals = { hicut: null, locut: null, pitch: null, hq: 0, lq: 0 };
  for (const c of curves) {
    if (c.lanes && !c.lanes.has(lane)) continue;
    const v = valueAt(c, beat);
    if (v === null) continue;
    const t = c.curve.type;
    if (t === 'hicut') {
      if (out.hicut === null || v < out.hicut) {
        out.hicut = v;
        out.hq = c.curve.q;
      }
    } else if (t === 'locut') {
      if (out.locut === null || v > out.locut) {
        out.locut = v;
        out.lq = c.curve.q;
      }
    } else out.pitch = (out.pitch ?? 0) + v;
  }
  return out;
}

// ---- 丸め ------------------------------------------------------------------------------------------

/** 呼び名の数（1〜10 の 1 けた分）。1/3 オクターブは R10、1/6 は R20、1/12 は R40 */
const R10 = [1, 1.25, 1.6, 2, 2.5, 3.15, 4, 5, 6.3, 8, 10];
const R20 = [1, 1.12, 1.25, 1.4, 1.6, 1.8, 2, 2.24, 2.5, 2.8, 3.15, 3.55, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10];
const R40 = [
  1, 1.06, 1.12, 1.18, 1.25, 1.32, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.12, 2.24, 2.36, 2.5, 2.65, 2.8, 3, 3.15, 3.35, 3.55, 3.75, 4, 4.25, 4.5, 4.75, 5,
  5.3, 5.6, 6, 6.3, 6.7, 7.1, 7.5, 8, 8.5, 9, 9.5, 10,
];
const SERIES: Record<FxRes, number[]> = { 3: R10, 6: R20, 12: R40 };

/** 周波数を 1/res オクターブに丸めた呼び名（Hz） */
export function nominalFreq(f: number, res: FxRes): number {
  const x = Math.max(1, f);
  const q = 1000 * Math.pow(2, Math.round(res * Math.log2(x / 1000)) / res);
  const e = Math.floor(Math.log10(q) + 1e-9);
  const m = q / Math.pow(10, e);
  let best = 1;
  let bd = Infinity;
  for (const r of SERIES[res]) {
    const d = Math.abs(Math.log(m / r));
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return Math.round(best * Math.pow(10, e) * 100) / 100;
}

/** 周波数を 1 段（1/res オクターブ）上げ下げした呼び名 */
export function stepFreq(f: number, res: FxRes, dir: 1 | -1): number {
  const k = Math.round(res * Math.log2(Math.max(1, f) / 1000)) + dir;
  return nominalFreq(1000 * Math.pow(2, k / res), res);
}

/** ピッチの刻み（半音）。細かいでは 1/2 半音 */
export const pitchStep = (res: FxRes) => (res === 12 ? 0.5 : 1);

export function roundPitch(v: number, res: FxRes): number {
  const st = pitchStep(res);
  const r = Math.round(v / st) * st;
  return Math.max(-PITCH_MAX, Math.min(PITCH_MAX, r === 0 ? 0 : r));
}

/** 値を 1 段上げ下げ（右のパネルの ‹ ›） */
export function stepValue(type: FxType, v: number, res: FxRes, dir: 1 | -1): number {
  if (type === 'pitch') return Math.max(-PITCH_RANGE, Math.min(PITCH_RANGE, roundPitch(v, res) + dir * pitchStep(res)));
  return Math.max(FX_LO, Math.min(FX_HI, stepFreq(v, res, dir)));
}

/** 値をかけるか（ハイカットの 14 kHz 以上・ローカットの 40 Hz 以下・ピッチの 0 はかけない）。丸めた値で見る */
export function applies(type: FxType, rounded: number): boolean {
  if (type === 'hicut') return rounded < HICUT_OFF;
  if (type === 'locut') return rounded > LOCUT_OFF;
  return rounded !== 0;
}

export function roundValue(type: FxType, v: number, res: FxRes): number {
  return type === 'pitch' ? roundPitch(v, res) : nominalFreq(v, res);
}

// ---- かけ方 ------------------------------------------------------------------------------------------

/** 余韻の中で値が動く所（t は鳴り始めからの秒、v は値。かけない所は 0） */
export interface FxKey {
  t: number;
  v: number;
}

/**
 * 1 つの音へのかけ方。キーが 1 つなら同じ値のまま、2 つ以上なら余韻の中で動く（キーのあいだは周波数の比・半音で
 * なめらかにつなぐ）。かけないものは持たない
 */
export interface FxSpec {
  hc?: FxKey[];
  lc?: FxKey[];
  pt?: FxKey[];
  /** 境目の強調（ハイカット・ローカット） */
  hq?: FxEmphasis;
  lq?: FxEmphasis;
}

export const specEmpty = (s: FxSpec) => !s.hc && !s.lc && !s.pt;
export const isSweep = (s: FxSpec) => [s.hc, s.lc, s.pt].some((k) => !!k && k.length > 1);

const num = (v: number) => String(Math.round(v * 10000) / 10000);
const keysText = (keys: FxKey[], pitch: boolean) =>
  keys.map((k, i) => (i === 0 ? '' : `${num(k.t)}:`) + (pitch && k.v > 0 ? `+${num(k.v)}` : num(k.v))).join(',');

/** かけ方の文（譜面のコメント「;fx 元の音 …」の後ろ。同じかけ方なら同じ文） */
export function specText(s: FxSpec): string {
  const parts: string[] = [];
  if (s.hc) parts.push(`hicut ${keysText(s.hc, false)}`);
  if (s.hc && s.hq) parts.push(`hq ${s.hq}`);
  if (s.lc) parts.push(`locut ${keysText(s.lc, false)}`);
  if (s.lc && s.lq) parts.push(`lq ${s.lq}`);
  if (s.pt) parts.push(`pitch ${keysText(s.pt, true)}`);
  return parts.join(' ');
}

function parseKeys(text: string): FxKey[] | null {
  const out: FxKey[] = [];
  for (const [i, part] of text.split(',').entries()) {
    const m = i === 0 ? /^([+-]?\d+(?:\.\d+)?)$/.exec(part) : /^(\d+(?:\.\d+)?):([+-]?\d+(?:\.\d+)?)$/.exec(part);
    if (!m) return null;
    const t = i === 0 ? 0 : Number(m[1]);
    const v = Number(i === 0 ? m[1] : m[2]);
    if (!Number.isFinite(t) || !Number.isFinite(v) || (out.length && t <= out[out.length - 1].t)) return null;
    out.push({ t, v });
  }
  return out.length ? out : null;
}

const SPEC_KEYS = new Set(['hicut', 'locut', 'pitch', 'hq', 'lq']);

/** 「;fx 元の音 かけ方」の行。元の音のパスには空白があってもよい（かけ方を後ろから読む） */
export function parseFxLine(text: string): { orig: string; spec: FxSpec } | null {
  const m = /^\s*;\s*fx\s+(.+?)\s*$/i.exec(text);
  if (!m) return null;
  const tok = m[1].split(/\s+/);
  const spec: FxSpec = {};
  let j = tok.length;
  while (j >= 3 && SPEC_KEYS.has(tok[j - 2].toLowerCase())) {
    const key = tok[j - 2].toLowerCase();
    const val = tok[j - 1];
    if (key === 'hq' || key === 'lq') {
      const q = Number(val);
      if (q !== 1 && q !== 2) return null;
      spec[key] = q;
    } else {
      const keys = parseKeys(val);
      if (!keys) return null;
      spec[key === 'hicut' ? 'hc' : key === 'locut' ? 'lc' : 'pt'] = keys;
    }
    j -= 2;
  }
  if (j < 1 || specEmpty(spec)) return null;
  if (!spec.hc) delete spec.hq;
  if (!spec.lc) delete spec.lq;
  return { orig: tok.slice(0, j).join(' '), spec };
}

export const fxLineText = (orig: string, spec: FxSpec) => `;fx ${orig} ${specText(spec)}`;

// ---- ファイル名 ---------------------------------------------------------------------------------------

/** 文字列の 6 けたの数（ファイル名を分ける。英字を使わない：ファイル名から楽器を読むとき bd・sd などに見えないように） */
export function digits6(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return String(h % 1000000).padStart(6, '0');
}

const freqTag = (v: number) => (Number.isInteger(v) ? String(v) : String(v).replace('.', 'p'));
const pitchTag = (v: number) => `${v > 0 ? 'up' : 'down'}${Math.floor(Math.abs(v))}${Math.abs(v) % 1 ? 'h' : ''}`;

/** ファイル名に付ける印（hc12500・lc90・up5・down3、強調は r1・r2、余韻の中で動くものは sw と 6 けた） */
export function specTag(s: FxSpec): string {
  if (isSweep(s)) return `sw${digits6(specText(s))}`;
  const parts: string[] = [];
  if (s.hc) parts.push(`hc${freqTag(s.hc[0].v)}${s.hq ? `r${s.hq}` : ''}`);
  if (s.lc) parts.push(`lc${freqTag(s.lc[0].v)}${s.lq ? `r${s.lq}` : ''}`);
  if (s.pt) parts.push(pitchTag(s.pt[0].v));
  return parts.join('_');
}

/** かけた音を置くフォルダ（#PATH_WAV からの相対） */
export const FX_DIR = 'fx';

/** かけた音のファイル名か（エディタが作った名前。消してよいかを見る） */
export const FX_NAME_RE = /^fx\/[^/]+_(?:(?:hc|lc)\d+(?:p\d+)?(?:r[12])?|up\d+h?|down\d+h?|sw\d{6})(?:_(?:(?:hc|lc)\d+(?:p\d+)?(?:r[12])?|up\d+h?|down\d+h?))*\.(?:ogg|wav)$/i;

/**
 * 元の音のファイル名から作る、かけた音の名前の頭（英数字と _ - だけ）。フォルダの中の音・英数字でない名前・ogg と wav
 * でない音は、ほかの音と同じ名前にならないよう 6 けたの数を足す
 */
export function fxStem(orig: string): string {
  const p = orig.trim().replace(/\\/g, '/');
  const file = p.split('/').pop() ?? p;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
  // 元の名前の _ はそのまま（kick_.ogg と kick.ogg が同じ名前にならないように）
  const clean = base.replace(/[^A-Za-z0-9_-]+/g, '_');
  const lossy = clean !== base || p.includes('/') || (ext !== 'ogg' && ext !== 'wav') || !clean;
  // 置き換えた所の _ は端から外す（全部置き換えたら sound）。数を足すので同じ名前にはならない
  const head = ((clean !== base ? clean.replace(/^_+|_+$/g, '') : clean) || 'sound').slice(0, 40);
  return lossy ? `${head}_${digits6(p.toLowerCase())}` : head;
}

/** かけた音のファイルの形式（元の音が wav なら wav、それ以外は ogg） */
export const fxExt = (orig: string) => (/\.wav$/i.test(orig.trim()) ? 'wav' : 'ogg');

/** かけた音のパス（#WAV に書く。#PATH_WAV からの相対） */
export function fxPath(orig: string, spec: FxSpec): string {
  return `${FX_DIR}/${fxStem(orig)}_${specTag(spec)}.${fxExt(orig)}`;
}

/** 呼び名の表示（12.5k・630・31.5） */
export function freqLabel(v: number): string {
  if (v >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : Math.round(k * 100) / 100}k`;
  }
  return String(Math.round(v * 10) / 10);
}

/** 値の表示（Hz か半音） */
export function valueLabel(type: FxType, v: number): string {
  if (type === 'pitch') return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)}`;
  return freqLabel(v);
}

// ---- 列の目盛り --------------------------------------------------------------------------------------

/** 周波数 → 列の中の位置（0〜1、左が低い） */
export function freqX(f: number): number {
  const x = Math.log(Math.max(FX_LO, Math.min(FX_HI, f)) / FX_LO) / Math.log(FX_HI / FX_LO);
  return Math.max(0, Math.min(1, x));
}

export function xFreq(x: number): number {
  return FX_LO * Math.pow(FX_HI / FX_LO, Math.max(0, Math.min(1, x)));
}

/** 半音 → 列の中の位置（真ん中が元の高さ） */
export const pitchX = (v: number) => Math.max(0, Math.min(1, 0.5 + v / (2 * PITCH_RANGE)));
export const xPitch = (x: number) => (Math.max(0, Math.min(1, x)) - 0.5) * 2 * PITCH_RANGE;

export const valueX = (type: FxType, v: number) => (type === 'pitch' ? pitchX(v) : freqX(v));
export const xValue = (type: FxType, x: number) => (type === 'pitch' ? xPitch(x) : xFreq(x));

/** 「かけない」端の値（ハイカットは右端の 16 kHz・ローカットは左端の 30 Hz・ピッチは真ん中の 0） */
export const openValue = (type: FxType) => (type === 'hicut' ? FX_HI : type === 'locut' ? FX_LO : 0);

// ---- 作業ファイル --------------------------------------------------------------------------------------

const SHAPES: readonly FxShape[] = ['smooth', 'slow', 'fast', 'scurve', 'hold'];
const TYPES: readonly FxType[] = ['hicut', 'locut', 'pitch'];
const LANE_KEYS = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY', 'RD'];

/** 作業ファイルの fx を読む（読めない点・カーブは捨てる） */
export function parseFxSide(j: unknown): FxSide | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Partial<FxSide>;
  const res: FxRes = o.res === 3 || o.res === 12 ? o.res : 6;
  const curves: FxCurve[] = [];
  const ids = new Set<string>();
  if (Array.isArray(o.curves)) {
    for (const c of o.curves as Partial<FxCurve>[]) {
      if (!c || !TYPES.includes(c.type as FxType) || curves.length >= 64) continue;
      const type = c.type as FxType;
      let id = typeof c.id === 'string' && c.id && c.id.length <= 40 ? c.id : `c${curves.length + 1}`;
      while (ids.has(id)) id += '_';
      ids.add(id);
      const points: FxPoint[] = [];
      if (Array.isArray(c.points)) {
        for (const p of c.points as Partial<FxPoint>[]) {
          if (!p || !Number.isInteger(p.m) || !Number.isInteger(p.n) || !Number.isInteger(p.d) || !Number.isFinite(p.v)) continue;
          const m = p.m!;
          const n = p.n!;
          const d = p.d!;
          if (m < 0 || m >= 3600 || d <= 0 || n < 0 || n >= d || points.length >= 2000) continue;
          const v = type === 'pitch' ? Math.max(-PITCH_RANGE, Math.min(PITCH_RANGE, p.v!)) : Math.max(FX_LO, Math.min(FX_HI, p.v!));
          points.push({ m, n, d, v, ...(p.s && SHAPES.includes(p.s) && p.s !== 'smooth' ? { s: p.s } : {}) });
        }
      }
      const lanes = Array.isArray(c.lanes) ? [...new Set(c.lanes.filter((k): k is string => typeof k === 'string' && LANE_KEYS.includes(k)))] : null;
      const q: FxEmphasis = c.q === 1 || c.q === 2 ? c.q : 0;
      curves.push({ id, type, points: sortPoints(points), lanes, q });
    }
  }
  return { curves, res, tails: o.tails !== false };
}

/** 小節を入れた・消したときに、カーブの点もチップと一緒に動かす（消した小節の中の点は消す） */
export function shiftFxSide(side: FxSide, m: number, n: number, mode: 'insert' | 'delete'): FxSide {
  const shift = (x: number): number | null => (mode === 'insert' ? (x >= m ? x + n : x) : x >= m + n ? x - n : x >= m ? null : x);
  return {
    ...side,
    curves: side.curves.map((c) => ({
      ...c,
      points: c.points.flatMap((p) => {
        const to = shift(p.m);
        return to === null || to >= 3600 ? [] : [{ ...p, m: to }];
      }),
    })),
  };
}
