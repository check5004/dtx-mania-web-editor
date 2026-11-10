// 曲フォルダに無くてもエディタが用意できる音（標準キットとライブラリの音）。
// 譜面の #WAV に書かれたファイルが曲フォルダに無いとき、ここから鳴らし、保存するときに曲フォルダへ書き出す。
import { tr, withTr } from '../i18n';
import { CH, SD_RIM, voiceName } from '../dtx/model';
import { encodeWav, loadKit as loadSynthKit } from './kit';

export interface KitLane {
  key: string;
  /** 音の番号（通常チャンネル。スネアのリムは SD_RIM） */
  ch: number;
  label: string;
}

/** キットのレーン（音の番号ごとに1音。スネアのリムはスネアと別の音） */
/** 名前はレーンの名前（表示のたびに今の言語で） */
const kitLane = (key: string, ch: number): KitLane => withTr({ key, ch } as KitLane, { label: () => voiceName(ch) });

export const KIT_LANES: readonly KitLane[] = [
  kitLane('lc', CH.LC),
  kitLane('hhc', CH.HHC),
  kitLane('hho', CH.HHO),
  kitLane('lp', CH.LP),
  kitLane('lbd', CH.LBD),
  kitLane('sd', CH.SD),
  kitLane('rim', SD_RIM),
  kitLane('ht', CH.HT),
  kitLane('bd', CH.BD),
  kitLane('lt', CH.LT),
  kitLane('ft', CH.FT),
  kitLane('cy', CH.CY),
  kitLane('rd', CH.RD),
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
  withTr({ id: 'std' } as BuiltinKit, { name: ['スタンダード', 'Standard'], desc: ['GM音源のスタンダードキット。迷ったらこれ', 'The GM standard kit. Pick this if unsure'] }),
  withTr({ id: 'rock' } as BuiltinKit, { name: ['ロック', 'Rock'], desc: ['太いキックとスネアのパワーキット', 'A power kit with a fat kick and snare'] }),
  withTr({ id: 'room' } as BuiltinKit, { name: ['ルーム', 'Room'], desc: ['部屋鳴りのある自然なキット', 'A natural kit with room ambience'] }),
  withTr({ id: 'jazz' } as BuiltinKit, { name: ['ジャズ（ブラシ）', 'Jazz (brushes)'], desc: ['ブラシのスネアと軽いシンバル', 'Brushed snare and light cymbals'] }),
  withTr({ id: 'elec' } as BuiltinKit, { name: ['エレクトロ（808・909風）', 'Electro (808/909 style)'], desc: ['リズムマシンの音', 'Drum machine sounds'] }),
  withTr({ id: 'metal' } as BuiltinKit, { name: ['メタル', 'Metal'], desc: ['パワーキットにチャイナシンバルと低いキック', 'A power kit with a china cymbal and a low kick'] }),
  withTr({ id: 'synth' } as BuiltinKit, { name: ['シンセ（軽量）', 'Synth (light)'], desc: ['以前の版の合成音（ファイルを読み込まずに作る）', 'Synthesized sounds from earlier versions (made without loading files)'] }),
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
      origin: tr(`標準キット（${kit.name}）`, `Built-in kit (${kit.name})`),
      load: () => loadBuiltin(b.kit, b.lane.key),
      bytes: async () => {
        const buf = await loadBuiltin(b.kit, b.lane.key);
        return buf ? encodeWav(buf) : null;
      },
    };
  }
  return extra.get(baseName(path)) ?? null;
}
