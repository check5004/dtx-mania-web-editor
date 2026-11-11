// 特殊ノーツ（クラップ・タンバリンなど、NX にレーンの無い音）の見分け方。
// NX ではどれも「行き先」のレーンのチップ（Mela! のクラップはハイタムのチップ ch14）か、自動で鳴らす SE のチップで、鳴る音（WAV）だけが違う。
// エディタは「その種類の音を鳴らすチップ」を特殊ノーツとして、種類ごとの列に分けて見せる（譜面は DTX のまま。チャンネルは変えない）。
//
// 種類か: #WAV のラベル（「;」の後ろ）があればラベルで、無ければファイル名で決める（スネアのリムと同じ決まり。dtx/rim）。
// ただしラベルがクラップでも、ファイル名がはっきりほかの楽器ならどの種類にもしない（テンプレートのラベルが残ったまま。
// Bless your breath の「BYB-PHIHAT.ogg ;SE1 Hand Clap」）。自分で作った種類は、ラベルが同じ音だけ。
import { tr, withTr } from '../i18n';
import type { DtxDoc } from './model';

/** 決まった種類（クラップ・タンバリン・カウベル・シェイカー） */
export interface SpecialPreset {
  id: string;
  name: string;
  /** 列の見出しに出す 3 文字 */
  code: string;
  /** エディタの中だけの色 */
  color: string;
  /** エディタが #WAV に付けるラベル */
  label: string;
  /** 音の番号（キット・置く音の表のキー。スネアのリムの SD_RIM と同じ仕組み） */
  voice: number;
  /** 置くキー（KeyboardEvent.code） */
  key: string;
  /** 電子ドラムのノート（General MIDI） */
  midi: number;
  /** 名前（ラベル・ファイル名）がこの種類か */
  re: RegExp;
}

const preset = (p: Omit<SpecialPreset, 'name'>, name: readonly [string, string]): SpecialPreset => withTr(p as SpecialPreset, { name });

/** 特殊ノーツの音の番号の始まり（スネアのリム 0x112 より後ろ。自分で作った種類は SP_CUSTOM_VOICE から） */
export const SP_VOICE = 0x140;
export const SP_CUSTOM_VOICE = 0x150;

export const SPECIAL_PRESETS: readonly SpecialPreset[] = [
  preset({ id: 'clap', code: 'CLP', color: '#FFB38A', label: 'Hand Clap', voice: SP_VOICE, key: 'KeyQ', midi: 39, re: /clap|クラップ|手拍子/ }, ['クラップ', 'Clap']),
  preset({ id: 'tamb', code: 'TMB', color: '#9EE6C9', label: 'Tambourine', voice: SP_VOICE + 1, key: 'KeyW', midi: 54, re: /tambo?u?rine|(?:^|[^a-z])tamb(?:[^a-z]|$)|タンバリン/ }, [
    'タンバリン',
    'Tambourine',
  ]),
  preset({ id: 'cowbell', code: 'CBL', color: '#E6D58A', label: 'Cowbell', voice: SP_VOICE + 2, key: 'KeyE', midi: 56, re: /cow[\s_-]*bell|カウベル/ }, ['カウベル', 'Cowbell']),
  preset({ id: 'shaker', code: 'SHK', color: '#B9C3FF', label: 'Shaker', voice: SP_VOICE + 3, key: 'KeyR', midi: 70, re: /shaker|maraca|cabasa|シェイカー|シェーカー|マラカス|カバサ/ }, [
    'シェイカー',
    'Shaker',
  ]),
];

export const presetById = new Map(SPECIAL_PRESETS.map((p) => [p.id, p]));

/** 自分で作った種類で選べる色（決まった種類の色のあと） */
export const SPECIAL_COLORS = ['#FFB38A', '#9EE6C9', '#E6D58A', '#B9C3FF', '#F2B8F0', '#D7DCE3'];

/** 自分で作った種類（作業ファイルの決め）。見分けるのはラベルが同じ音だけ */
export interface CustomKind {
  id: string;
  name: string;
  code: string;
  color: string;
  label: string;
}

let customs: readonly CustomKind[] = [];
let customVer = 0;

/** 自分で作った種類を入れ替える（作業ファイルを読んだ・変えたとき。store/special） */
export function setCustomKinds(list: readonly CustomKind[]) {
  if (JSON.stringify(list) === JSON.stringify(customs)) return;
  customs = list.map((k) => ({ ...k }));
  customVer++;
}

export function customKinds(): readonly CustomKind[] {
  return customs;
}

/** 種類の id → 音の番号（自分で作った種類は並び順） */
export function kindVoice(id: string): number | null {
  const p = presetById.get(id);
  if (p) return p.voice;
  const i = customs.findIndex((k) => k.id === id);
  return i < 0 ? null : SP_CUSTOM_VOICE + i;
}

/** 音の番号 → 種類の id（特殊ノーツの音の番号でなければ null） */
export function voiceKind(voice: number): string | null {
  const p = SPECIAL_PRESETS.find((x) => x.voice === voice);
  if (p) return p.id;
  const i = voice - SP_CUSTOM_VOICE;
  return i >= 0 && i < customs.length ? customs[i].id : null;
}

/** 種類の名前（自分で作った種類も） */
export function kindName(id: string): string {
  return presetById.get(id)?.name ?? customs.find((k) => k.id === id)?.name ?? id;
}

/** 名前を比べやすくする（camelCase を区切って小文字に） */
function norm(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** パスの最後の名前 */
function baseName(path: string): string {
  return path.trim().replace(/\\/g, '/').split('/').pop() ?? '';
}

/** ドラムの楽器（キック・スネア・ハイハット・シンバル・タム・リム）をはっきり指す名前か */
const DRUM_NAME =
  /kick|bass[\s_-]*drum|(?:^|[^a-z])bd(?:[^a-z]|$)|snare|(?:^|[^a-z])sd(?:[^a-z]|$)|hi[\s_-]*hat|hat(?:[^a-z]|$)|(?:^|[^a-z])hh(?:[^a-z]|$)|cymbal|crash|(?:^|[^a-z])ride|china|splash|(?:^|[^a-z])toms?(?:[^a-z]|$)|(?:^|[^a-z])rim|side[\s_-]*stick|キック|バスドラ|スネア|ハイハット|シンバル|クラッシュ|ライド|(?:^|[^ン])タム|リム/;

/** その名前（ラベル・ファイル名）が指す決まった種類。ほかの楽器もはっきり指すなら null（どちらか分からない） */
function presetOfName(text: string): SpecialPreset | null {
  const n = norm(text);
  const hits = SPECIAL_PRESETS.filter((p) => p.re.test(n));
  if (hits.length !== 1) return null;
  return DRUM_NAME.test(n) ? null : hits[0];
}

/** ほかの楽器（ドラム・ほかの種類）をはっきり指す名前か（kind の名前でなければ） */
function namesOther(text: string, kind: SpecialPreset | null): boolean {
  const n = norm(text);
  if (DRUM_NAME.test(n)) return true;
  return SPECIAL_PRESETS.some((p) => p !== kind && p.re.test(n) && !(kind && kind.re.test(n)));
}

/**
 * #WAV の定義が特殊ノーツのどの種類の音か（種類の id）。ラベルがあればラベル、無ければファイル名で決める。
 * 自分で作った種類はラベルが同じ音だけ。ラベルが決まった種類でも、ファイル名がはっきりほかの楽器ならどの種類にもしない
 */
export function kindOfSound(path: string | undefined, label: string | null | undefined, list: readonly CustomKind[] = customs): string | null {
  if (path === undefined) return null;
  const l = label?.trim() ?? '';
  const name = baseName(path);
  if (l) {
    const own = list.find((k) => k.label.trim().toLowerCase() === l.toLowerCase());
    if (own) return own.id;
    const p = presetOfName(l);
    if (!p) return null;
    return namesOther(name, p) ? null : p.id;
  }
  return presetOfName(name)?.id ?? null;
}

/** 特殊ノーツの音の WAV 番号 → 種類の id（その時の譜面から数える。編集中の下書きにも使える） */
export function specialWavsOf(doc: Pick<DtxDoc, 'header' | 'fields'>): Map<number, string> {
  const out = new Map<number, string>();
  for (const h of doc.header) {
    if (h.kind !== 'field' || !/^WAV[0-9A-Z]{2}$/.test(h.key)) continue;
    const id = kindOfSound(doc.fields[h.key], h.comment);
    if (id) out.set(parseInt(h.key.slice(3), 36), id);
  }
  return out;
}

const cache = new WeakMap<object, { fields: object; ver: number; map: ReadonlyMap<number, string> }>();

/** 特殊ノーツの音の WAV 番号 → 種類の id（譜面ごとに覚える。編集中の下書きには specialWavsOf） */
export function specialWavs(doc: Pick<DtxDoc, 'header' | 'fields'>): ReadonlyMap<number, string> {
  const hit = cache.get(doc.header);
  if (hit && hit.fields === doc.fields && hit.ver === customVer) return hit.map;
  const map = specialWavsOf(doc);
  cache.set(doc.header, { fields: doc.fields, ver: customVer, map });
  return map;
}

/** 種類のラベル（エディタが #WAV に付ける） */
export function kindLabel(id: string): string | null {
  return presetById.get(id)?.label ?? customs.find((k) => k.id === id)?.label ?? null;
}

/** 種類の 3 文字（列の見出し） */
export function kindCode(id: string): string {
  return presetById.get(id)?.code ?? customs.find((k) => k.id === id)?.code ?? '???';
}

/** 種類の色 */
export function kindColor(id: string): string {
  return presetById.get(id)?.color ?? customs.find((k) => k.id === id)?.color ?? '#D7DCE3';
}

/** 自分で作る種類の 3 文字（名前の英字から。無ければ SP1・SP2…） */
export function codeFor(name: string, taken: readonly string[]): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cands = letters.length >= 3 ? [letters.slice(0, 3), letters[0] + letters.slice(-2)] : [];
  for (const c of cands) if (!taken.includes(c)) return c;
  for (let i = 1; i < 100; i++) if (!taken.includes(`SP${i}`)) return `SP${i}`;
  return 'SPX';
}

/** 自分で作る種類のラベル（名前。;や改行は使えない） */
export function labelFor(name: string): string {
  return name.replace(/[;\r\n]/g, ' ').trim() || tr('特殊ノーツ', 'Special');
}
