// 曲フォルダに無くてもエディタが用意できる音（標準キットとライブラリの音）。
// 譜面の #WAV に書かれたファイルが曲フォルダに無いとき、ここから鳴らし、保存するときに曲フォルダへ書き出す。
import { tr, withTr } from '../i18n';
import { CH, SD_RIM, voiceName } from '../dtx/model';
import { SPECIAL_PRESETS } from '../dtx/kinds';
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

/**
 * 特殊ノーツ（クラップ・タンバリン・カウベル・シェイカー）の音。音の番号は種類の番号（dtx/kinds）。
 * キットのレーンとは別（NX にレーンの無い音）。持っているキットは少しだけで、ほかのキットは SPECIAL_FROM のキットの音を使う
 */
export const SPECIAL_KIT_LANES: readonly KitLane[] = SPECIAL_PRESETS.map((p) => withTr({ key: p.id, ch: p.voice } as KitLane, { label: () => p.name }));

const specialKeys = new Set(SPECIAL_KIT_LANES.map((l) => l.key));

export const laneByCh = new Map([...KIT_LANES, ...SPECIAL_KIT_LANES].map((l) => [l.ch, l]));
export const laneByKey = new Map([...KIT_LANES, ...SPECIAL_KIT_LANES].map((l) => [l.key, l]));

/** キットのジャンル（並べる順） */
export type KitGenre = 'basic' | 'rock' | 'pop' | 'jazz' | 'electro' | 'game';

export interface KitGenreInfo {
  id: KitGenre;
  name: string;
}

export const KIT_GENRES: readonly KitGenreInfo[] = [
  withTr({ id: 'basic' } as KitGenreInfo, { name: ['スタンダード', 'Standard'] }),
  withTr({ id: 'rock' } as KitGenreInfo, { name: ['ロック・メタル', 'Rock & metal'] }),
  withTr({ id: 'pop' } as KitGenreInfo, { name: ['ポップ・ファンク', 'Pop & funk'] }),
  withTr({ id: 'jazz' } as KitGenreInfo, { name: ['ジャズ・アコースティック', 'Jazz & acoustic'] }),
  withTr({ id: 'electro' } as KitGenreInfo, { name: ['エレクトロ・ダンス', 'Electronic & dance'] }),
  withTr({ id: 'game' } as KitGenreInfo, { name: ['ゲーム・シンセ', 'Game & synth'] }),
];

/** キットの音の出どころ（どれも曲に入れて配ってよいもの。くわしくは public/kits/CREDITS.txt） */
export interface KitSource {
  id: string;
  name: string;
  /** 作った人 */
  by: string;
  license: string;
  url: string;
}

const source = (id: string, name: string | readonly [string, string], by: string | readonly [string, string], license: string, url: string): KitSource =>
  withTr({ id, license, url } as KitSource, {
    name: typeof name === 'string' ? () => name : name,
    by: typeof by === 'string' ? () => by : by,
  });

const CC0 = 'CC0 1.0';

export const KIT_SOURCES: readonly KitSource[] = [
  source('gu', 'GeneralUser GS', 'S. Christian Collins', 'GeneralUser GS License v2.0', 'https://www.schristiancollins.com/generaluser.php'),
  source('bigrusty', 'Big Rusty Drums', 'Karoryfer Samples', CC0, 'https://github.com/sfzinstruments/karoryfer.big-rusty-drums'),
  source('unruly', 'Unruly Drums', 'Karoryfer Samples', CC0, 'https://github.com/sfzinstruments/karoryfer.unruly-drums'),
  source('virtuosity', 'Virtuosity Drums', 'Versilian Studios · Karoryfer Samples', CC0, 'https://github.com/sfzinstruments/virtuosity_drums'),
  source('swirly', 'Swirly Drums', 'Karoryfer Samples', CC0, 'https://github.com/sfzinstruments/karoryfer.swirly-drums'),
  source('frankensnare', 'Frankensnare', 'Karoryfer Samples', CC0, 'https://github.com/sfzinstruments/karoryfer.frankensnare'),
  source('gogodze', 'Gogodze Phu Vol II', 'Karoryfer Samples', CC0, 'https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii'),
  source('freepats', 'FreePats Synthesizer Percussion', 'Roberto (FreePats)', CC0, 'https://freepats.zenvoid.org/Percussion/synthesizer-percussion.html'),
  source('sonicpi', ['Sonic Pi の音（freesound.org）', 'Sonic Pi samples (freesound.org)'], 'menegass, Rodrigo The Mad, Dolfeus', CC0, 'https://github.com/sonic-pi-net/sonic-pi/tree/dev/etc/samples'),
  source('own', ['このエディタで合成した音', 'Synthesized by this editor'], 'DTX Web Editor', CC0, ''),
];

export const kitSourceById = new Map(KIT_SOURCES.map((s) => [s.id, s]));

export interface BuiltinKit {
  id: string;
  name: string;
  desc: string;
  genre: KitGenre;
  /** 音の出どころ（KIT_SOURCES の id） */
  sources: readonly string[];
}

const kit = (id: string, genre: KitGenre, sources: readonly string[], name: readonly [string, string], desc: readonly [string, string]): BuiltinKit =>
  withTr({ id, genre, sources } as BuiltinKit, { name, desc });

/**
 * 同梱の標準キット（作り方は scripts/make-kits.mjs と scripts/kits/defs.mjs）。ジャンルの順に並べる。
 * synth は以前の版の合成音（ファイルを読まずに作る）
 */
export const BUILTIN_KITS: readonly BuiltinKit[] = [
  kit('std', 'basic', ['gu'], ['スタンダード', 'Standard'], ['GM音源のスタンダードキット。迷ったらこれ', 'The GM standard kit. Pick this if unsure']),
  kit('room', 'basic', ['gu'], ['ルーム', 'Room'], ['部屋鳴りのある自然なキット', 'A natural kit with room ambience']),
  kit('rock', 'rock', ['gu'], ['ロック', 'Rock'], ['太いキックとスネアのパワーキット', 'A power kit with a fat kick and snare']),
  kit('metal', 'rock', ['gu'], ['メタル', 'Metal'], ['パワーキットにチャイナシンバルと低いキック', 'A power kit with a china cymbal and a low kick']),
  kit('vintage', 'rock', ['bigrusty'], ['ビンテージ', 'Vintage'], ['大きな胴の古いロックのキット（生の録音）', 'A big vintage rock kit (real recordings)']),
  kit('heavy', 'rock', ['bigrusty'], ['ヘビー', 'Heavy'], ['強く叩いたリムショットとチャイナ、低いタム', 'Hard-hit rimshots, a china cymbal and deep toms']),
  kit('arena', 'rock', ['bigrusty'], ['アリーナ', 'Arena'], ['広い会場で鳴らしたような残響', 'Big reverb, like a large hall']),
  kit('seventies', 'rock', ['gogodze', 'virtuosity'], ['70年代ロック', "'70s rock"], ['古いマイクで録った温かいキット', 'A warm kit recorded with vintage mics']),
  kit('garage', 'rock', ['unruly'], ['ガレージ', 'Garage'], ['小さめのキットを生々しく', 'A small kit, raw and close']),
  kit('dry', 'pop', ['bigrusty'], ['ドライ', 'Dry'], ['ミュートした近い音。ポップやファンクに', 'Muffled, close sounds for pop and funk']),
  kit('fat', 'pop', ['unruly', 'bigrusty'], ['ファット', 'Fat'], ['太く低いスネアのキット', 'A kit with a deep, fat snare']),
  kit('funk', 'pop', ['unruly', 'frankensnare', 'virtuosity', 'bigrusty'], ['ファンク', 'Funk'], ['高く張ったスチールのスネア', 'A tight, high-tuned steel snare']),
  kit('live', 'pop', ['virtuosity'], ['ライブハウス', 'Live club'], ['部屋の響きを多めにしたキット', 'A kit with plenty of room sound']),
  kit('gated', 'pop', ['bigrusty'], ['80年代ゲート', "'80s gated"], ['スネアとタムにゲートリバーブ', 'Gated reverb on the snare and toms']),
  kit('jazz', 'jazz', ['gu'], ['ジャズ（ブラシ）', 'Jazz (brushes)'], ['ブラシのスネアと軽いシンバル', 'Brushed snare and light cymbals']),
  kit('swing', 'jazz', ['virtuosity'], ['スウィング', 'Swing'], ['ジャズクラブのキットをスティックで（生の録音）', 'A jazz club kit played with sticks (real recordings)']),
  kit('brushes', 'jazz', ['swirly', 'virtuosity'], ['ブラシ（生の録音）', 'Brushes (real recordings)'], ['ブラシで叩いた本物のキット', 'A real kit played with brushes']),
  kit('retro', 'jazz', ['virtuosity'], ['レトロ', 'Retro'], ['古いマイク1本で録った昔の音', 'An old-time sound through one vintage mic']),
  kit('elec', 'electro', ['gu'], ['エレクトロ（808・909風）', 'Electro (808/909 style)'], ['リズムマシンの音', 'Drum machine sounds']),
  kit('dance', 'electro', ['gu'], ['ダンス', 'Dance'], ['909のキックとダンス向けのスネア', 'A 909 kick and a dance snare']),
  kit('eighties', 'electro', ['gu'], ['80年代エレドラ', "'80s electronic"], ['電子ドラムにゲートリバーブ', 'Electronic drums with gated reverb']),
  kit('analog', 'electro', ['freepats', 'own'], ['アナログ', 'Analog'], ['アナログのリズムマシン風', 'Analog drum machine style']),
  kit('house', 'electro', ['sonicpi', 'freepats', 'own'], ['ハウス', 'House'], ['4つ打ちのキックとクラップ', 'A four-on-the-floor kick and a clap']),
  kit('trap', 'electro', ['own'], ['トラップ', 'Trap'], ['長く低い808風のキックと細かいハイハット', 'A long, low 808-style kick and tight hi-hats']),
  kit('lofi', 'electro', ['virtuosity'], ['ローファイ', 'Lo-fi'], ['こもって少し歪んだヒップホップ風', 'Muffled, dusty hip-hop style']),
  kit('chip', 'game', ['own'], ['8ビット', '8-bit'], ['昔のゲーム機のような音', 'Sounds like an old game console']),
  kit('fm', 'game', ['own'], ['FM音源', 'FM synth'], ['昔のパソコンやゲームのFM音源風', 'FM sound chip style, like old computers and games']),
  kit('synth', 'game', ['own'], ['シンセ（軽量）', 'Synth (light)'], ['以前の版の合成音（ファイルを読み込まずに作る）', 'Synthesized sounds from earlier versions (made without loading files)']),
];

export const builtinKitById = new Map(BUILTIN_KITS.map((k) => [k.id, k]));

/**
 * 特殊ノーツの音を持っているキット（GeneralUser GS の6キット）と、その音を借りるキット。
 * 電子音のキットはエレクトロ（808・909 のクラップ・カウベル）、書いていないキットはスタンダードの音
 */
const SPECIAL_FROM: Readonly<Record<string, string>> = {
  std: 'std',
  room: 'room',
  rock: 'rock',
  metal: 'metal',
  jazz: 'jazz',
  elec: 'elec',
  dance: 'elec',
  eighties: 'elec',
  analog: 'elec',
  house: 'elec',
  trap: 'elec',
  chip: 'elec',
  fm: 'elec',
  synth: 'elec',
};

/** 特殊ノーツの音をどのキットから取るか */
export const specialKitOf = (kit: string): string => SPECIAL_FROM[kit] ?? 'std';

/** 特殊ノーツの音を持っているキット（public/kits/<キット>/clap.ogg などがある） */
export const SPECIAL_SOUND_KITS: readonly string[] = [...new Set(Object.values(SPECIAL_FROM))];

/** 標準キットの音を曲フォルダに置くときのファイル名（dtxweb_std_sd.wav など。合成音は以前の名前のまま） */
export function builtinFile(kit: string, ch: number): string | null {
  const lane = laneByCh.get(ch);
  if (!lane || !builtinKitById.has(kit)) return null;
  // 特殊ノーツの音は、持っているキットの音（ファイル名もそのキットの名前）
  if (specialKeys.has(lane.key)) kit = specialKitOf(kit);
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

async function fetchBuiltin(kit: string, laneKey: string): Promise<AudioBuffer | null> {
  // 特殊ノーツの音を持っていないキットの名前で書かれていても、借りるキットの音を鳴らす
  if (specialKeys.has(laneKey)) kit = specialKitOf(kit);
  if (kit === 'synth') return (await loadSynthKit()).get(`dtxweb_kit_${laneKey}.wav`) ?? null;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}kits/${kit}/${laneKey}.ogg`);
    if (!res.ok) return null;
    return await decodeBytes(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** 標準キットの音（一度読んだら覚えておく） */
export function loadBuiltin(kit: string, laneKey: string): Promise<AudioBuffer | null> {
  const k = `${kit}/${laneKey}`;
  let p = builtinCache.get(k);
  if (!p) {
    p = fetchBuiltin(kit, laneKey);
    builtinCache.set(k, p);
  }
  return p;
}

/** 覚えずに読む（ライブラリの一覧を作るとき。キットが多いので、全部の音を持ち続けるとメモリを使いすぎる） */
export function peekBuiltin(kit: string, laneKey: string): Promise<AudioBuffer | null> {
  return builtinCache.get(`${kit}/${laneKey}`) ?? fetchBuiltin(kit, laneKey);
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
