// スネアのリム（クロススティックの「カッ」）の見分け方。
// NX はリムを見分けない（スネアのチップ ch12 で、鳴る音が違うだけ）。エディタは「スネアのレーンのチップで、音がリムの音」を
// リムのチップとして別に扱う（色・置き方・右クリック・MIDI・キットの音）。譜面は DTX のまま（チャンネルは変えない）。
//
// リムの音か: #WAV のラベル（「;」の後ろ。DTXCreator のラベル）があればラベルで、無ければファイル名で決める。
// 楯さんのテンプレートは「#WAV0W: 038_Snare_rimclick.ogg ;Snare Rim」。エディタがリムの音を登録するときも
// ラベル「Snare Rim」を付ける（ファイル名にリムと無い音でも、読み直したときにリムと分かるように）。
import { CH, drumChannel, SD_RIM, voiceName, type Chip, type DtxDoc } from './model';
import { tr } from '../i18n';
import { toBase36x2 } from './base36';

/** エディタがリムの音に付けるラベル */
export const RIM_LABEL = 'Snare Rim';

/**
 * リムの音らしい名前か（ラベルかファイル名）。rim（Rimshot・Snare_rimclick・SnareRim・sdrim）、side stick、cross stick、
 * x-stick、リム・サイドスティック・クロススティック。trim・prime などの中の rim は数えない
 */
export function looksLikeRim(text: string): boolean {
  return /(?:^|[^a-z]|sd|snare)rim|side[\s_-]*stick|cross[\s_-]*stick|(?:^|[^a-z])x[\s_-]*stick|リム|サイドスティック|クロススティック/.test(norm(text));
}

/** 名前を比べやすくする（camelCase を区切って小文字に） */
function norm(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * スネア以外の楽器をはっきり指す名前か（キック・ハイハット・シンバル・タム・クラップなど）。
 * テンプレートのラベルが残ったまま別の音を入れた譜面がある（Bless your breath の「BYB-PHIHAT.ogg ;SE1 Hand Clap」）
 */
function looksLikeOtherDrum(text: string): boolean {
  return /kick|bass[\s_-]*drum|(?:^|[^a-z])bd(?:[^a-z]|$)|hi[\s_-]*hat|hat(?:[^a-z]|$)|(?:^|[^a-z])hh(?:[^a-z]|$)|cymbal|crash|(?:^|[^a-z])ride|china|splash|(?:^|[^a-z])toms?(?:[^a-z]|$)|clap|tambourine|cowbell|shaker|キック|バスドラ|ハイハット|シンバル|クラッシュ|ライド|タム|クラップ/.test(norm(text));
}

/** パスの最後の名前 */
function baseName(path: string): string {
  return path.trim().replace(/\\/g, '/').split('/').pop() ?? '';
}

/**
 * #WAV の定義がリムの音か。ラベルがあればラベル、無ければファイル名で決める。
 * ただしラベルがリムでも、ファイル名がはっきりほかの楽器（キック・ハイハットなど）ならリムにしない（ラベルが古いまま）
 */
export function isRimSound(path: string | undefined, label: string | null | undefined): boolean {
  if (path === undefined) return false;
  const l = label?.trim() ?? '';
  const name = baseName(path);
  if (l) return looksLikeRim(l) && (looksLikeRim(name) || !looksLikeOtherDrum(name));
  return looksLikeRim(name);
}

/** WAV のラベル（#WAVzz の行の「;」の後ろ） */
export function wavLabel(doc: Pick<DtxDoc, 'header'>, no: number): string | null {
  const key = 'WAV' + toBase36x2(no);
  for (const h of doc.header) if (h.kind === 'field' && h.key === key) return h.comment?.trim() || null;
  return null;
}

/** リムの音の WAV 番号（その時の譜面から数える。編集中の下書きにも使える） */
export function rimWavsOf(doc: Pick<DtxDoc, 'header' | 'fields'>): Set<number> {
  const out = new Set<number>();
  for (const h of doc.header) {
    if (h.kind !== 'field' || !/^WAV[0-9A-Z]{2}$/.test(h.key)) continue;
    if (isRimSound(doc.fields[h.key], h.comment)) out.add(parseInt(h.key.slice(3), 36));
  }
  return out;
}

const cache = new WeakMap<object, { fields: object; set: ReadonlySet<number> }>();

/** リムの音の WAV 番号（譜面ごとに覚える。編集中の下書きには rimWavsOf） */
export function rimWavs(doc: Pick<DtxDoc, 'header' | 'fields'>): ReadonlySet<number> {
  const hit = cache.get(doc.header);
  if (hit && hit.fields === doc.fields) return hit.set;
  const set = rimWavsOf(doc);
  cache.set(doc.header, { fields: doc.fields, set });
  return set;
}

/** その WAV 番号がリムの音か */
export function isRimWav(doc: Pick<DtxDoc, 'header' | 'fields'>, no: number): boolean {
  return rimWavs(doc).has(no);
}

/** リムのチップか（スネアのレーンのチップで、音がリムの音） */
export function isRimChip(doc: Pick<DtxDoc, 'header' | 'fields'>, c: Pick<Chip, 'ch' | 'v'>, rims: ReadonlySet<number> = rimWavs(doc)): boolean {
  return drumChannel(c.ch)?.base === CH.SD && rims.has(c.v);
}

/** 2種目のチップか（HHオープン・左バスドラム・スネアのリム） */
export function chipAlt(doc: Pick<DtxDoc, 'header' | 'fields'>, c: Pick<Chip, 'ch' | 'v'>, rims: ReadonlySet<number> = rimWavs(doc)): boolean {
  const d = drumChannel(c.ch);
  if (!d) return false;
  return d.alt || (d.base === CH.SD && rims.has(c.v));
}

/** チップの音の番号（キット・置く音の表のキー。リムは SD_RIM、ほかは通常チップのチャンネル）。ドラムでなければ null */
export function chipVoice(doc: Pick<DtxDoc, 'header' | 'fields'>, c: Pick<Chip, 'ch' | 'v'>, rims: ReadonlySet<number> = rimWavs(doc)): number | null {
  const d = drumChannel(c.ch);
  if (!d) return null;
  return d.base === CH.SD && rims.has(c.v) ? SD_RIM : d.base;
}

/** チップの名前（リムは「リム」。不可視・音だけはそう付ける）。ドラムでなければ null */
export function rimChipName(doc: Pick<DtxDoc, 'header' | 'fields'>, c: Pick<Chip, 'ch' | 'v'>): string | null {
  const d = drumChannel(c.ch);
  if (!d || d.base !== CH.SD || !isRimWav(doc, c.v)) return null;
  const name = voiceName(SD_RIM);
  return d.kind === 'hidden' ? `${name}${tr('（不可視）', ' (invisible)')}` : d.kind === 'nochip' ? `${name}${tr('（チップ無し時の音）', ' (no-chip sound)')}` : name;
}
