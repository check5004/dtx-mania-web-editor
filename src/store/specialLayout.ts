// 特殊ノーツ（クラップ・タンバリンなど）の種類の一覧と、譜面での見せ方（種類ごとの列に分けるか、行き先のレーンに重ねるか）。
// 表示用のチップ一覧（store/derived）から使うので、ここではエディタの状態（store/editor）を読まない（循環を避ける）。
// 置く・行き先を変えるなどの操作は store/special。
import { create } from 'zustand';
import { tr } from '../i18n';
import { CH, drumChannel, isSeChannel, voiceName, type DtxDoc } from '../dtx/model';
import { kindVoice, presetById, setCustomKinds, specialWavs, SPECIAL_PRESETS, SPECIAL_COLORS, type CustomKind } from '../dtx/kinds';
import { useSidecar, type SpecialDef, type SpecialSide } from './sidecar';

/** SE（自動で鳴らす）のチャンネル（若い順） */
export const SE_CHANNELS: readonly number[] = [
  ...Array.from({ length: 9 }, (_, i) => 0x61 + i),
  ...Array.from({ length: 10 }, (_, i) => 0x70 + i),
  ...Array.from({ length: 10 }, (_, i) => 0x80 + i),
  0x90,
  0x91,
  0x92,
];

/** 選べる行き先（12 のレーン。HHオープン・左バスドラムも）。並びはレーンの並び */
export const SPECIAL_DESTS: readonly { ch: number; code: string }[] = [
  { ch: CH.LC, code: 'LC' },
  { ch: CH.HHC, code: 'HH' },
  { ch: CH.HHO, code: 'HHO' },
  { ch: CH.LP, code: 'LP' },
  { ch: CH.LBD, code: 'LBD' },
  { ch: CH.SD, code: 'SD' },
  { ch: CH.HT, code: 'HT' },
  { ch: CH.BD, code: 'BD' },
  { ch: CH.LT, code: 'LT' },
  { ch: CH.FT, code: 'FT' },
  { ch: CH.CY, code: 'CY' },
  { ch: CH.RD, code: 'RD' },
];

const destByCh = new Map(SPECIAL_DESTS.map((x) => [x.ch, x]));

/** 行き先の短い名前（見出しの →HT。自動で鳴らすは「自動」） */
export function destCode(dest: number | 'auto'): string {
  if (dest === 'auto') return tr('自動', 'Auto');
  return destByCh.get(dest)?.code ?? '?';
}

/** 行き先の名前（ハイタム・自動で鳴らす） */
export function destName(dest: number | 'auto'): string {
  return dest === 'auto' ? tr('自動で鳴らす', 'Play automatically') : voiceName(dest);
}

export interface SpecialKind {
  id: string;
  name: string;
  /** 列の見出しの 3 文字 */
  code: string;
  color: string;
  /** #WAV に付けるラベル */
  label: string;
  /** 音の番号（キット・置く音の表のキー） */
  voice: number;
  /** 決まった種類（クラップなど）か */
  preset: boolean;
  /** 行き先（ドラムのチャンネル）か「自動で鳴らす」。置いてあるチップがあればその一番多いレーン */
  dest: number | 'auto';
  /** 自動で鳴らすときの SE のチャンネル */
  se: number;
  /** 置くキー（KeyboardEvent.code） */
  key: string | null;
  /** 電子ドラムのノート */
  midi: number | null;
  /** チップの数（ドラムの通常チップと SE） */
  count: number;
  /** 自動で鳴らすチップ（SE）の数 */
  autoCount: number;
  /** 行き先と違うレーンのチップの数 */
  elsewhere: number;
  /** 使っている WAV 番号（多い順） */
  wavs: number[];
  /** チップのある小節の最初と最後（無ければ -1） */
  firstM: number;
  lastM: number;
}

// ---- 見せ方 -------------------------------------------------------------------------------

const VIEW_KEY = 'dtxe.special.cols.v1';

function loadCols(): boolean | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** 種類ごとの列に分けて見せるか（null は画面に合わせる：PC・スマホは列、iPad は行き先のレーンに重ねる） */
export const useSpecialView = create<{ cols: boolean | null }>(() => ({ cols: loadCols() }));

let colsDefault: () => boolean = () => true;

/** 列に分けるかの初め（画面の種類から。store/special が入れる） */
export function setSpecialColsDefault(fn: () => boolean) {
  colsDefault = fn;
}

/** 今、種類ごとの列に分けて見せるか */
export function specialColsMode(): boolean {
  return useSpecialView.getState().cols ?? colsDefault();
}

export function setSpecialCols(on: boolean) {
  try {
    localStorage.setItem(VIEW_KEY, on ? '1' : '0');
  } catch {
    // 保存できなくても動く
  }
  useSpecialView.setState({ cols: on });
}

// ---- 作業ファイルの決め --------------------------------------------------------------------

let sideVer = 0;
let lastSide: SpecialSide | null | undefined;

function customsOf(side: SpecialSide | null): CustomKind[] {
  return (side?.kinds ?? [])
    .filter((d) => !presetById.has(d.id) && d.label)
    .map((d, i) => ({ id: d.id, name: d.name ?? d.label!, code: d.code ?? 'SP' + (i + 1), color: d.color ?? SPECIAL_COLORS[(4 + i) % SPECIAL_COLORS.length], label: d.label! }));
}

function syncSide(side: SpecialSide | null) {
  if (side === lastSide) return;
  lastSide = side;
  sideVer++;
  setCustomKinds(customsOf(side));
}

syncSide(useSidecar.getState().special);
useSidecar.subscribe((s) => syncSide(s.special));

/** 種類の決め（作業ファイル。無ければ undefined） */
export function specialDef(id: string): SpecialDef | undefined {
  return useSidecar.getState().special?.kinds.find((d) => d.id === id);
}

// ---- 種類の一覧 ---------------------------------------------------------------------------

interface Tally {
  n: number;
  auto: number;
  byCh: Map<number, number>;
  bySe: Map<number, number>;
  wavUse: Map<number, number>;
  firstM: number;
  lastM: number;
}

const argmax = (m: ReadonlyMap<number, number>): number | null => {
  let best: number | null = null;
  let bn = 0;
  for (const [k, n] of m) if (n > bn || (n === bn && best !== null && k < best)) [best, bn] = [k, n];
  return best;
};

const kindsCache = new WeakMap<DtxDoc, { key: string; list: SpecialKind[] }>();

/**
 * 譜面の特殊ノーツの種類（チップのある種類と、作業ファイルで決めた種類）。並びは決まった種類（クラップ・タンバリン・カウベル・シェイカー）、
 * そのあと自分で作った種類
 */
export function specialKinds(doc: DtxDoc): SpecialKind[] {
  const side = useSidecar.getState().special;
  syncSide(side);
  const key = String(sideVer);
  const hit = kindsCache.get(doc);
  if (hit && hit.key === key) return hit.list;
  const sp = specialWavs(doc);
  const tally = new Map<string, Tally>();
  const usedSe = new Map<number, Set<string>>();
  for (const c of doc.chips) {
    const se = isSeChannel(c.ch);
    const kind = sp.get(c.v);
    if (se) {
      let u = usedSe.get(c.ch);
      if (!u) usedSe.set(c.ch, (u = new Set()));
      u.add(kind ?? '');
    }
    if (!kind) continue;
    const d = drumChannel(c.ch);
    if (!(d && d.kind === 'normal') && !se) continue;
    let t = tally.get(kind);
    if (!t) tally.set(kind, (t = { n: 0, auto: 0, byCh: new Map(), bySe: new Map(), wavUse: new Map(), firstM: c.m, lastM: c.m }));
    t.n++;
    if (se) {
      t.auto++;
      t.bySe.set(c.ch, (t.bySe.get(c.ch) ?? 0) + 1);
    } else t.byCh.set(c.ch, (t.byCh.get(c.ch) ?? 0) + 1);
    t.wavUse.set(c.v, (t.wavUse.get(c.v) ?? 0) + 1);
    if (c.m < t.firstM) t.firstM = c.m;
    if (c.m > t.lastM) t.lastM = c.m;
  }
  const defs = side?.kinds ?? [];
  // 「特殊ノーツをやめる」にした決まった種類は出さない（チップはふつうのチップとして見える）
  const offIds = new Set(defs.filter((d) => d.off).map((d) => d.id));
  const ids = [
    ...SPECIAL_PRESETS.map((p) => p.id).filter((id) => !offIds.has(id) && (tally.has(id) || defs.some((d) => d.id === id))),
    ...defs.filter((d) => !presetById.has(d.id) && d.label && !d.off).map((d) => d.id),
  ];
  const takenSe = new Set<number>();
  const customs = customsOf(side);
  const list: SpecialKind[] = [];
  for (const id of ids) {
    const p = presetById.get(id);
    const own = customs.find((k) => k.id === id);
    const voice = kindVoice(id);
    if ((!p && !own) || voice === null) continue;
    const def = defs.find((d) => d.id === id);
    const t = tally.get(id);
    const destCh = t ? argmax(t.byCh) : null;
    const dest: number | 'auto' = destCh ?? def?.dest ?? 'auto';
    // 自動で鳴らす SE：決め、この種類のチップの一番多い SE、ほかのチップが無い SE の順
    let se = def?.se ?? (t ? argmax(t.bySe) : null);
    if (se === null || se === undefined) {
      se = SE_CHANNELS.find((ch) => !takenSe.has(ch) && ![...(usedSe.get(ch) ?? [])].some((k) => k !== id)) ?? SE_CHANNELS[0];
    }
    takenSe.add(se);
    const wavs = t ? [...t.wavUse.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([no]) => no) : [];
    list.push({
      id,
      name: p ? p.name : own!.name,
      code: p ? p.code : own!.code,
      color: def?.color ?? (p ? p.color : own!.color),
      label: p ? p.label : own!.label,
      voice,
      preset: !!p,
      dest,
      se,
      key: def?.key !== undefined ? def.key : (p?.key ?? null),
      midi: def?.midi !== undefined ? def.midi : (p?.midi ?? null),
      count: t?.n ?? 0,
      autoCount: t?.auto ?? 0,
      elsewhere: t && destCh !== null ? [...t.byCh.entries()].filter(([ch]) => ch !== destCh).reduce((a, [, n]) => a + n, 0) : 0,
      wavs,
      firstM: t?.firstM ?? -1,
      lastM: t?.lastM ?? -1,
    });
  }
  kindsCache.set(doc, { key, list });
  return list;
}

/** 種類（id から） */
export function specialKind(doc: DtxDoc, id: string): SpecialKind | undefined {
  return specialKinds(doc).find((k) => k.id === id);
}

// ---- 譜面での見せ方 -------------------------------------------------------------------------

export interface SpecialLayout {
  /** 特殊ノーツに分けて見せるか（お知らせの「元に戻す」で分けない曲は false） */
  on: boolean;
  /** 種類ごとの列に分けるか（false は行き先のレーンに重ねる） */
  cols: boolean;
  /** 特殊ノーツの音の WAV 番号 → 種類の id */
  wav: ReadonlyMap<number, string>;
  kinds: SpecialKind[];
  /** 種類の id → 列の番号（左から） */
  col: ReadonlyMap<string, number>;
  /** 見せ方が変わったら変わる（表示用のチップ一覧を作り直す合図） */
  key: string;
}

const layoutCache = new WeakMap<DtxDoc, { ver: number; cols: boolean; lay: SpecialLayout }>();

export function specialLayout(doc: DtxDoc): SpecialLayout {
  const side = useSidecar.getState().special;
  syncSide(side);
  const cols = specialColsMode();
  const hit = layoutCache.get(doc);
  if (hit && hit.ver === sideVer && hit.cols === cols) return hit.lay;
  const kinds = specialKinds(doc);
  const on = !side?.off && kinds.length > 0;
  const lay: SpecialLayout = { on, cols, wav: specialWavs(doc), kinds, col: new Map(kinds.map((k, i) => [k.id, i])), key: `${sideVer}|${on}|${cols}` };
  layoutCache.set(doc, { ver: sideVer, cols, lay });
  return lay;
}

/** チップが特殊ノーツとして見えるなら種類の id（ドラムの通常チップか自動で鳴らす SE で、種類の音） */
export function chipSpecialKind(lay: SpecialLayout, c: { ch: number; v: number }): string | undefined {
  if (!lay.on) return undefined;
  const kind = lay.wav.get(c.v);
  if (kind === undefined || !lay.col.has(kind)) return undefined;
  return isSeChannel(c.ch) || drumChannel(c.ch)?.kind === 'normal' ? kind : undefined;
}

/** 列に分けて見せる種類（分けないとき・重ねるときは空） */
export function specialColumns(doc: DtxDoc): SpecialKind[] {
  const lay = specialLayout(doc);
  return lay.on && lay.cols ? lay.kinds : [];
}
