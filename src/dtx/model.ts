// エディタ内部の譜面データ。DTXと同じ「小節・チャンネル・チップ」の形で持つ。
import type { Frac } from './fraction';

/** 1つのチップ。位置は小節番号と小節内の分数（0以上1未満）。 */
export interface Chip {
  id: number;
  /** チャンネル番号（0x01〜0xFF）。小節長(0x02)はチップにせず barLengths で持つ */
  ch: number;
  /** 小節番号 0〜3599 */
  m: number;
  /** 小節内の位置 0 ≦ f < 1 */
  f: Frac;
  /** 値。ch03 は 1〜255（16進）、それ以外は 1〜1295（36進） */
  v: number;
}

/**
 * ヘッダ部の1行。
 * - raw: コメント、空行、#RANDOM/#IF ブロック、解釈できない行など。書き出し時にそのまま出す
 * - field: `#KEY 値` の行。値は DtxDoc.fields[key] を参照する（編集すると反映される）
 */
export type HeaderLine =
  | { kind: 'raw'; text: string }
  | {
      kind: 'field';
      key: string;
      /** 元の綴り（#Title なら Title） */
      name: string;
      sep: string;
      comment: string | null;
      /** 読み込んだときの原文と値。値が変わっていなければ原文のまま書き出す */
      orig?: { text: string; value: string };
    };

export interface DtxDoc {
  header: HeaderLine[];
  /** 大文字のコマンド名 → 値。例: TITLE, BPM, WAV0A, VOLUME0A, BPM01 */
  fields: Record<string, string>;
  chips: Chip[];
  /** 小節長の変更（ch02）。小節番号 → 倍率。NXでは次の変更まで続く */
  barLengths: Record<number, number>;
  nextId: number;
}

export interface ParseWarning {
  line: number;
  message: string;
}

export function emptyDoc(): DtxDoc {
  return { header: [], fields: {}, chips: [], barLengths: {}, nextId: 1 };
}

// ---- チャンネル -------------------------------------------------------------

export const CH = {
  BGM: 0x01,
  BAR_LENGTH: 0x02,
  BPM: 0x03,
  BPM_EX: 0x08,
  HHC: 0x11,
  SD: 0x12,
  BD: 0x13,
  HT: 0x14,
  LT: 0x15,
  CY: 0x16,
  FT: 0x17,
  HHO: 0x18,
  RD: 0x19,
  LC: 0x1a,
  LP: 0x1b,
  LBD: 0x1c,
  FILLIN_SOUND: 0x1f,
  FILLIN: 0x53,
} as const;

export type ChipKind = 'normal' | 'hidden' | 'nochip';

export interface LaneDef {
  key: string;
  name: string;
  color: string;
  /** 通常チップのチャンネル */
  main: number;
  mainName: string;
  /** 修飾キーで置く2種目のチップ（HHオープン、左バスドラム） */
  alt?: number;
  altName?: string;
  altColor?: string;
}

/** ドラムの10レーン。並びは NX の標準（LC・HH・LP・SD・HT・BD・LT・FT・CY・RD） */
export const DRUM_LANES: readonly LaneDef[] = [
  { key: 'LC', name: '左シンバル', color: '#FF5C8A', main: CH.LC, mainName: '左シンバル' },
  { key: 'HH', name: 'ハイハット', color: '#4FC3F7', main: CH.HHC, mainName: 'HHクローズ', alt: CH.HHO, altName: 'HHオープン', altColor: '#4FC3F7' },
  { key: 'LP', name: '左ペダル', color: '#F48FB1', main: CH.LP, mainName: '左ペダル', alt: CH.LBD, altName: '左バスドラム', altColor: '#CE93D8' },
  { key: 'SD', name: 'スネア', color: '#FFD54F', main: CH.SD, mainName: 'スネア' },
  { key: 'HT', name: 'ハイタム', color: '#66BB6A', main: CH.HT, mainName: 'ハイタム' },
  { key: 'BD', name: 'バスドラム', color: '#9C84E0', main: CH.BD, mainName: 'バスドラム' },
  { key: 'LT', name: 'ロータム', color: '#EF5350', main: CH.LT, mainName: 'ロータム' },
  { key: 'FT', name: 'フロアタム', color: '#FF9800', main: CH.FT, mainName: 'フロアタム' },
  { key: 'CY', name: '右シンバル', color: '#42A5F5', main: CH.CY, mainName: '右シンバル' },
  { key: 'RD', name: 'ライド', color: '#80DEEA', main: CH.RD, mainName: 'ライド' },
];

export interface DrumChannelInfo {
  lane: number;
  kind: ChipKind;
  /** 2種目（HHオープン・左バスドラム）か */
  alt: boolean;
  /** 通常チップに直したときのチャンネル */
  base: number;
  name: string;
}

const drumInfo = new Map<number, DrumChannelInfo>();
DRUM_LANES.forEach((l, i) => {
  const reg = (base: number, alt: boolean, name: string) => {
    drumInfo.set(base, { lane: i, kind: 'normal', alt, base, name });
    drumInfo.set(base + 0x20, { lane: i, kind: 'hidden', alt, base, name: `${name}（不可視）` });
    drumInfo.set(base + 0xa0, { lane: i, kind: 'nochip', alt, base, name: `${name}（チップ無し時の音）` });
  };
  reg(l.main, false, l.mainName);
  if (l.alt !== undefined && l.altName) reg(l.alt, true, l.altName);
});

/** ドラムのチャンネルなら、レーンと種類を返す */
export function drumChannel(ch: number): DrumChannelInfo | undefined {
  return drumInfo.get(ch);
}

export function channelFor(base: number, kind: ChipKind): number {
  return kind === 'normal' ? base : kind === 'hidden' ? base + 0x20 : base + 0xa0;
}

/** 自動再生SE（61〜69, 70〜79, 80〜89, 90〜92） */
export function isSeChannel(ch: number): boolean {
  return (ch >= 0x61 && ch <= 0x69) || (ch >= 0x70 && ch <= 0x79) || (ch >= 0x80 && ch <= 0x89) || (ch >= 0x90 && ch <= 0x92);
}

/** WAV を鳴らすチャンネルか（再生で使う） */
export function isSoundChannel(ch: number): boolean {
  if (ch === CH.BGM || ch === CH.FILLIN_SOUND) return true;
  const d = drumInfo.get(ch);
  if (d) return d.kind === 'normal';
  return isSeChannel(ch);
}

export function chipKey(c: { ch: number; m: number; f: Frac }): string {
  return `${c.ch}:${c.m}:${c.f.n}/${c.f.d}`;
}

// ---- BGA・動画 -------------------------------------------------------------------

export interface BgaChannelDef {
  ch: number;
  name: string;
  /** 動画（#AVI を指す）か。そうでなければ画像（#BMP・#BMPTEX・#BGA を指す） */
  movie: boolean;
  /** 差し替え（レイヤーの画像を置き換える） */
  swap: boolean;
}

/** BGA のレイヤー 1〜8 と差し替え、動画のチャンネル */
export const BGA_CHANNELS: readonly BgaChannelDef[] = [
  { ch: 0x04, name: 'BGA レイヤー1', movie: false, swap: false },
  { ch: 0x07, name: 'BGA レイヤー2', movie: false, swap: false },
  { ch: 0x55, name: 'BGA レイヤー3', movie: false, swap: false },
  { ch: 0x56, name: 'BGA レイヤー4', movie: false, swap: false },
  { ch: 0x57, name: 'BGA レイヤー5', movie: false, swap: false },
  { ch: 0x58, name: 'BGA レイヤー6', movie: false, swap: false },
  { ch: 0x59, name: 'BGA レイヤー7', movie: false, swap: false },
  { ch: 0x60, name: 'BGA レイヤー8', movie: false, swap: false },
  { ch: 0xc4, name: 'レイヤー1の差し替え', movie: false, swap: true },
  { ch: 0xc7, name: 'レイヤー2の差し替え', movie: false, swap: true },
  { ch: 0xd5, name: 'レイヤー3の差し替え', movie: false, swap: true },
  { ch: 0xd6, name: 'レイヤー4の差し替え', movie: false, swap: true },
  { ch: 0xd7, name: 'レイヤー5の差し替え', movie: false, swap: true },
  { ch: 0xd8, name: 'レイヤー6の差し替え', movie: false, swap: true },
  { ch: 0xd9, name: 'レイヤー7の差し替え', movie: false, swap: true },
  { ch: 0xe0, name: 'レイヤー8の差し替え', movie: false, swap: true },
  { ch: 0x54, name: '動画', movie: true, swap: false },
  { ch: 0x5a, name: '動画（全画面）', movie: true, swap: false },
];

const bgaInfo = new Map(BGA_CHANNELS.map((b) => [b.ch, b]));

export function bgaChannel(ch: number): BgaChannelDef | undefined {
  return bgaInfo.get(ch);
}
