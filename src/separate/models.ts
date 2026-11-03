// ステム分解のモデル。どれも原曲（ステレオ 44.1kHz）の複素スペクトログラムを受け取り、楽器ごとのスペクトログラムを返す ONNX。
// ブラウザ用に書き出したものを unblend（Ryan Fahey、https://github.com/Ryan5453/unblend）が Hugging Face に置いているので、
// 版を固定して読み、SHA-256 を確かめる。モデルのファイルはリポジトリに入れない。
// このファイルは何も import しない（Node の精度テスト scripts/separate-bench.mjs からもそのまま読めるように）。

export type SepStem = 'drums' | 'bass' | 'vocals' | 'guitar' | 'piano' | 'other';
export type SepModelId = 'bs_roformer_sw' | 'scnet_xl_wide_v5' | 'scnet_small';
export type SepPrecision = 'fp16' | 'fp32';

export interface SepFile {
  url: string;
  bytes: number;
  sha256: string;
}

export interface SepModel {
  id: SepModelId;
  /** 画面に出す名前 */
  name: string;
  /** 一言で（summaryEn は英語） */
  summary: string;
  summaryEn: string;
  /** 出力の並び（モデルの出力の順） */
  stems: readonly SepStem[];
  nfft: number;
  hop: number;
  /** 1回に流す長さ（サンプル、44.1kHz） */
  chunk: number;
  /** モデルの入力の長さ（chunk の後ろを 0 で埋める） */
  input?: number;
  window: 'hann' | 'rect';
  normalized: boolean;
  /** WASM（CPU）では動かない（メモリが足りない） */
  webgpuOnly: boolean;
  files: Record<SepPrecision, SepFile>;
  /**
   * ドラムの分離の良さ：正解付きの MUSDB18（テスト用の曲の7秒の抜粋、30曲）で測った
   * ドラムの SDR の中央値（dB、scripts/separate-bench.mjs、docs/bench.md）
   */
  drumsSdr: number;
  credit: string;
  creditEn: string;
  license: string;
  licenseEn: string;
  page: string;
}

export const SEP_SR = 44100;

/** モデルを覚えておくブラウザのキャッシュ（Cache Storage）の名前 */
export const SEP_CACHE = 'dtxe-models-v1';

const HF = 'https://huggingface.co/Ryan5453/unblend/resolve/30b749fd691312b1e4b3f8fe79df0b51cde836cd/';

export const SEP_MODELS: Record<SepModelId, SepModel> = {
  bs_roformer_sw: {
    id: 'bs_roformer_sw',
    name: 'BS-RoFormer SW',
    // 英語は summaryEn i18n-ignore
    summary: '高精度（6種：ドラム・ベース・ボーカル・ギター・ピアノ・その他）',
    summaryEn: 'Most accurate (6 stems: drums, bass, vocals, guitar, piano, other)',
    stems: ['bass', 'drums', 'other', 'vocals', 'guitar', 'piano'],
    nfft: 2048,
    hop: 512,
    chunk: 588800,
    window: 'hann',
    normalized: false,
    webgpuOnly: true,
    files: {
      fp16: { url: HF + 'bs_roformer_sw_fp16.onnx', bytes: 351215164, sha256: '560ef7646b40c0ed4ae958caacba4fcdc17f08649f8fd56034e5895a7e26ecae' },
      fp32: { url: HF + 'bs_roformer_sw_fp32.onnx', bytes: 700419210, sha256: '09585bc2a70dec895ff8a2dd316314850cce4e620304eb46d6926a4e62d12461' },
    },
    drumsSdr: 12.1,
    // 英語は creditEn・licenseEn i18n-ignore-start
    credit: 'BS-RoFormer SW（jarredou ほか。BS-RoFormer は W.-T. Lu ほか）',
    license: '重みの利用条件の明示なし（非商用の個人利用として使う）',
    // i18n-ignore-end
    creditEn: 'BS-RoFormer SW (jarredou et al.; BS-RoFormer by W.-T. Lu et al.)',
    licenseEn: 'no license stated for the weights (used for non-commercial personal use)',
    page: 'https://huggingface.co/Ryan5453/unblend',
  },
  scnet_xl_wide_v5: {
    id: 'scnet_xl_wide_v5',
    name: 'SCNet XL',
    // i18n-ignore
    summary: '中くらい（4種：ドラム・ベース・ボーカル・その他）',
    summaryEn: 'Medium (4 stems: drums, bass, vocals, other)',
    stems: ['drums', 'bass', 'other', 'vocals'],
    nfft: 4096,
    hop: 1024,
    chunk: 485100,
    input: 486400,
    window: 'rect',
    normalized: true,
    webgpuOnly: true,
    files: {
      fp16: { url: HF + 'scnet_xl_wide_v5_fp16.onnx', bytes: 114857118, sha256: 'd97f0e7d945bfa46a32dca5b3dcd231003ff7f14fc9ab676637e4adab77b91c7' },
      fp32: { url: HF + 'scnet_xl_wide_v5_fp32.onnx', bytes: 221482626, sha256: '6e2e46b669fa368247afbe867aaa61317425f3f0568309fd6e0c79671c39f0b6' },
    },
    drumsSdr: 11.2,
    // i18n-ignore-start
    credit: 'SCNet（W. Tong ほか）XL',
    license: '重みの利用条件の明示なし（非商用の個人利用として使う）',
    // i18n-ignore-end
    creditEn: 'SCNet (W. Tong et al.) XL',
    licenseEn: 'no license stated for the weights (used for non-commercial personal use)',
    page: 'https://huggingface.co/Ryan5453/unblend',
  },
  scnet_small: {
    id: 'scnet_small',
    name: 'SCNet small',
    // i18n-ignore
    summary: '軽い（4種：ドラム・ベース・ボーカル・その他）',
    summaryEn: 'Light (4 stems: drums, bass, vocals, other)',
    stems: ['drums', 'bass', 'other', 'vocals'],
    nfft: 4096,
    hop: 1024,
    chunk: 485100,
    input: 486400,
    window: 'hann',
    normalized: true,
    webgpuOnly: false,
    files: {
      fp16: { url: HF + 'scnet_small_fp16.onnx', bytes: 27057704, sha256: '2fbb85960a8899f81e1363ccff69cc7299f2059ecad11477c2321eb5e168813d' },
      fp32: { url: HF + 'scnet_small_fp32.onnx', bytes: 48101059, sha256: 'eee1bf82b7c9d756a388e00fc142ba1c427444b53a07d626cfa903a450f83281' },
    },
    drumsSdr: 10.0,
    // i18n-ignore-start
    credit: 'SCNet（W. Tong ほか）small',
    license: '重みの利用条件の明示なし（非商用の個人利用として使う）',
    // i18n-ignore-end
    creditEn: 'SCNet (W. Tong et al.) small',
    licenseEn: 'no license stated for the weights (used for non-commercial personal use)',
    page: 'https://huggingface.co/Ryan5453/unblend',
  },
};

/** モデルの前後の信号処理の形（dsp.ts の Geometry） */
export function geometryOf(m: SepModel) {
  return { nfft: m.nfft, hop: m.hop, chunk: m.chunk, input: m.input, window: m.window, normalized: m.normalized };
}
