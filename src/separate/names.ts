// 分解で作るファイルの名前と、分ける音の名前の見方（テストしやすいように、画面や状態を持たない）。
import { SEP_MODELS, type SepModelId, type SepStem } from './models';

/** two: ドラムとドラム抜きの2本 / all: 楽器ごと（モデルの種類だけ） */
export type SepOutputs = 'two' | 'all';

/** ファイル名の終わりの「ドラム抜き」の印（bgm_drumless・曲_nodrums・曲（ドラム抜き）） */
const DRUMLESS_TAIL = /[\s_\-.(（[【]*(?:drum[ _-]?less|no[ _-]?drums?|without[ _-]?drums?|minus[ _-]?drums?|ドラム(?:抜き?|ぬき|なし|無し?|レス))[)）\]】]*$/i;

/**
 * 分ける音のファイル名から、できるファイルの名前の頭（ドラム抜きの印は外す）と、
 * 名前からドラム抜きの音らしいか（前に書き出した BGM など）
 */
export function sourceNameInfo(fileName: string): { base: string; drumless: boolean } {
  const stem = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[^.]+$/, '');
  const drumless = DRUMLESS_TAIL.test(stem);
  const base = (drumless ? stem.replace(DRUMLESS_TAIL, '') : stem).replace(/[\\/:*?"<>|]/g, '_').trim() || 'bgm';
  return { base, drumless };
}

/** ファイル名がドラム抜きの音らしいか（bgm_drumless・曲_nodrums・曲（ドラム抜き）。前に書き出した BGM など） */
export function isDrumlessName(fileName: string): boolean {
  return sourceNameInfo(fileName).drumless;
}

/** 画面とトラックに並べる順（ドラムが先、その他が最後） */
const STEM_ORDER: SepStem[] = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'];

/** モデルが分ける種類を、並べる順に */
export function stemsInOrder(model: SepModelId): SepStem[] {
  return [...SEP_MODELS[model].stems].sort((a, b) => STEM_ORDER.indexOf(a) - STEM_ORDER.indexOf(b));
}

/** できるファイルの名前（stems/ の中）と、モデルの出力との対応。'rest' は 原曲 − ほかのステム */
export function plannedFiles(model: SepModelId, outputs: SepOutputs, base: string): { name: string; stem: SepStem | 'rest' }[] {
  if (outputs === 'two')
    return [
      { name: `${base}_drums.ogg`, stem: 'drums' },
      { name: `${base}_nodrums.ogg`, stem: 'rest' },
    ];
  // 楽器ごと：「その他」は 原曲 − ほかのステム にして、全部を足すと原曲にぴったり戻るようにする
  return stemsInOrder(model).map((s) => ({ name: `${base}_${s}.ogg`, stem: s === 'other' ? 'rest' : s }));
}
