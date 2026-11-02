// 曲フォルダに無くてもエディタが用意できる音（標準キットとライブラリの音）。
// 譜面の #WAV に書かれたファイルが曲フォルダに無いとき、ここから鳴らし、保存するときに曲フォルダへ書き出す。
import { CH } from '../dtx/model';
import { encodeWav, loadKit as loadSynthKit } from './kit';

export interface KitLane {
  key: string;
  ch: number;
  label: string;
}

/** キットのレーン（チャンネルごとに1音） */
export const KIT_LANES: readonly KitLane[] = [
  { key: 'lc', ch: CH.LC, label: '左シンバル' },
  { key: 'hhc', ch: CH.HHC, label: 'HHクローズ' },
  { key: 'hho', ch: CH.HHO, label: 'HHオープン' },
  { key: 'lp', ch: CH.LP, label: '左ペダル' },
  { key: 'lbd', ch: CH.LBD, label: '左バスドラム' },
  { key: 'sd', ch: CH.SD, label: 'スネア' },
  { key: 'ht', ch: CH.HT, label: 'ハイタム' },
  { key: 'bd', ch: CH.BD, label: 'バスドラム' },
  { key: 'lt', ch: CH.LT, label: 'ロータム' },
  { key: 'ft', ch: CH.FT, label: 'フロアタム' },
  { key: 'cy', ch: CH.CY, label: '右シンバル' },
  { key: 'rd', ch: CH.RD, label: 'ライド' },
];

export const laneByCh = new Map(KIT_LANES.map((l) => [l.ch, l]));
export const laneByKey = new Map(KIT_LANES.map((l) => [l.key, l]));

export interface BuiltinKit {
  id: string;
  name: string;
  desc: string;
}

/** 同梱の標準キット（GeneralUser GS のドラムセットから切り出したもの。synth は以前の版の合成音） */
export const BUILTIN_KITS: readonly BuiltinKit[] = [
  { id: 'std', name: 'スタンダード', desc: 'GM音源のスタンダードキット。迷ったらこれ' },
  { id: 'rock', name: 'ロック', desc: '太いキックとスネアのパワーキット' },
  { id: 'room', name: 'ルーム', desc: '部屋鳴りのある自然なキット' },
  { id: 'jazz', name: 'ジャズ（ブラシ）', desc: 'ブラシのスネアと軽いシンバル' },
  { id: 'elec', name: 'エレクトロ（808・909風）', desc: 'リズムマシンの音' },
  { id: 'metal', name: 'メタル', desc: 'パワーキットにチャイナシンバルと低いキック' },
  { id: 'synth', name: 'シンセ（軽量）', desc: '以前の版の合成音（ファイルを読み込まずに作る）' },
];

export const builtinKitById = new Map(BUILTIN_KITS.map((k) => [k.id, k]));

/** 標準キットの音を曲フォルダに置くときのファイル名（dtxweb_std_sd.wav など。合成音は以前の名前のまま） */
export function builtinFile(kit: string, ch: number): string | null {
  const lane = laneByCh.get(ch);
  if (!lane || !builtinKitById.has(kit)) return null;
  return kit === 'synth' ? `dtxweb_kit_${lane.key}.wav` : `dtxweb_${kit}_${lane.key}.wav`;
}

/** 標準キットのファイル名か（パスの最後の名前で見る） */
export function parseBuiltinFile(path: string): { kit: string; lane: KitLane } | null {
  const m = /(?:^|[\\/])dtxweb_([a-z]+)_([a-z]+)\.wav$/i.exec(path.trim());
  if (!m) return null;
  const kit = m[1].toLowerCase() === 'kit' ? 'synth' : m[1].toLowerCase();
  const lane = laneByKey.get(m[2].toLowerCase());
  if (!lane || !builtinKitById.has(kit)) return null;
  return { kit, lane };
}

let decodeCtx: OfflineAudioContext | null = null;

/** 音声ファイルの中身を AudioBuffer にする（再生用の AudioContext を作らずに済むように） */
export async function decodeBytes(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
  decodeCtx ??= new OfflineAudioContext(1, 1, 44100);
  try {
    return await decodeCtx.decodeAudioData(bytes);
  } catch {
    return null;
  }
}

const builtinCache = new Map<string, Promise<AudioBuffer | null>>();

export function loadBuiltin(kit: string, laneKey: string): Promise<AudioBuffer | null> {
  const k = `${kit}/${laneKey}`;
  let p = builtinCache.get(k);
  if (!p) {
    p = (async () => {
      if (kit === 'synth') return (await loadSynthKit()).get(`dtxweb_kit_${laneKey}.wav`) ?? null;
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}kits/${kit}/${laneKey}.ogg`);
        if (!res.ok) return null;
        return await decodeBytes(await res.arrayBuffer());
      } catch {
        return null;
      }
    })();
    builtinCache.set(k, p);
  }
  return p;
}

/** エディタが用意できる音 */
export interface VirtualSound {
  /** 曲フォルダに置くときのファイル名 */
  file: string;
  /** どこの音か（標準キット・取り込んだ曲名） */
  origin: string;
  /** ライブラリの音ならサンプルの id */
  sampleId?: string;
  load(): Promise<AudioBuffer | null>;
  /** 曲フォルダに書き出す中身 */
  bytes(): Promise<Uint8Array | null>;
}

const extra = new Map<string, VirtualSound>();

const baseName = (p: string) => p.trim().replace(/\\/g, '/').split('/').pop()!.toLowerCase();

/** ライブラリの音などを登録する（ファイル名で引く） */
export function registerVirtual(v: VirtualSound) {
  extra.set(baseName(v.file), v);
}

export function unregisterVirtual(file: string) {
  extra.delete(baseName(file));
}

/** 譜面に書かれたパスの音をエディタが用意できるなら返す */
export function virtualSound(path: string): VirtualSound | null {
  const b = parseBuiltinFile(path);
  if (b) {
    const kit = builtinKitById.get(b.kit)!;
    return {
      file: builtinFile(b.kit, b.lane.ch)!,
      origin: `標準キット（${kit.name}）`,
      load: () => loadBuiltin(b.kit, b.lane.key),
      bytes: async () => {
        const buf = await loadBuiltin(b.kit, b.lane.key);
        return buf ? encodeWav(buf) : null;
      },
    };
  }
  return extra.get(baseName(path)) ?? null;
}
