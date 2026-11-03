// ドラムの採譜モデル。原曲（ドラム入りの混ざった音）から、5種のドラムの「鳴っていそうな度合い」を 1/100 秒ごとに出す。
//
// ADTOF Frame_RNN（Zehren, Alunno, Bientinesi）を ONNX にしたもの（thebluescreen/adtof-drums-onnx、2.2MB）。
// 音ゲーの譜面（人の耳コピ）と原曲の組 359 時間で学習してあり、DTX の譜面づくりとねらいが同じ。
// ライセンスは CC BY-NC-SA 4.0（非商用・表示・継承）。このエディタは無料の非商用ツールなので使える。
// モデルのファイルはリポジトリに入れず、Hugging Face から読む（版を固定し、SHA-256 を確かめる）。
import type { DrumClass } from '../bench/classes';

export const ADTOF = {
  id: 'adtof-frame-rnn-v1',
  name: 'ADTOF Frame_RNN',
  url: 'https://huggingface.co/thebluescreen/adtof-drums-onnx/resolve/d0e809bb1c1b6fe8a4a00c576852117a0636ab5a/adtof_frame_rnn.onnx',
  sha256: '189ca3c2bc7339a5f0fdc0bb11069d4bcc4fafabd142e945228c368c379b6227',
  bytes: 2171762,
  /** 入力の音（モノラル） */
  sr: 44100,
  /** 出力の 1 秒あたりのフレーム数（441 サンプルごと） */
  fps: 100,
  hop: 441,
  /** 出力の並び */
  classes: ['BD', 'SD', 'TT', 'HH', 'CY'] as readonly DrumClass[],
  /** 作者が決めた種類ごとの打点の閾値（この並び） */
  thresholds: [0.22, 0.24, 0.32, 0.22, 0.3] as readonly number[],
  /**
   * 「この種類の打点が無い＝原曲で鳴っていない」と言える種類（精度テスト docs/bench.md の「原曲との照合」）。
   * ハイハット・シンバルは、打点が無くても譜面にあることが多い（細かい刻みや余韻を拾いきれない）ので外す。
   */
  reliable: ['BD', 'SD', 'TT'] as readonly DrumClass[],
  license: 'CC BY-NC-SA 4.0',
  credit: 'ADTOF（M. Zehren, M. Alunno, P. Bientinesi）',
  page: 'https://github.com/MZehren/ADTOF',
} as const;

/** 1曲ぶんの採譜の結果（モデルの出力そのもの） */
export interface DrumActivations {
  model: string;
  fps: number;
  /** フレームの数 */
  frames: number;
  /** frames × 5（ADTOF.classes の並び）。0〜1 */
  act: Float32Array;
}
