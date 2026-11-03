// 精度テストで採点する楽器の分け方。ドラム採譜の研究でふつうに使う5種（ADTOF などのモデルの出力と同じ）にそろえる。
import { CH } from '../dtx/model';

export type DrumClass = 'BD' | 'SD' | 'TT' | 'HH' | 'CY';

export const DRUM_CLASSES: readonly DrumClass[] = ['BD', 'SD', 'TT', 'HH', 'CY'];

export const CLASS_LABEL: Record<DrumClass, string> = {
  BD: 'バスドラム',
  SD: 'スネア',
  TT: 'タム',
  HH: 'ハイハット',
  CY: 'シンバル・ライド',
};

/**
 * DTX のチャンネル → 採点の種類。
 * 左バスドラム（LBD）はバスドラム、左ペダル（LP）とHHオープンはハイハット、左右シンバルとライドはシンバルにまとめる。
 */
const BY_CHANNEL = new Map<number, DrumClass>([
  [CH.BD, 'BD'],
  [CH.LBD, 'BD'],
  [CH.SD, 'SD'],
  [CH.HT, 'TT'],
  [CH.LT, 'TT'],
  [CH.FT, 'TT'],
  [CH.HHC, 'HH'],
  [CH.HHO, 'HH'],
  [CH.LP, 'HH'],
  [CH.LC, 'CY'],
  [CH.CY, 'CY'],
  [CH.RD, 'CY'],
]);

/** 通常チップ（見えるチップ）のチャンネルなら種類を返す */
export function classOfChannel(ch: number): DrumClass | null {
  return BY_CHANNEL.get(ch) ?? null;
}
