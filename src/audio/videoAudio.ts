// 動画（MP4 など）から音だけを取り出す。取り出した音は OGG（Vorbis・品質6、DTX の原曲と同じ形式）にして、
// 原曲（BGM）にする。原曲になれば、ステム分解・スペクトル・耳コピ・波形もふつうの原曲と同じように使える。
// 読むのはブラウザ（engine.decodeAudio = decodeAudioData）。Chrome・Edge は MP4（AAC・MP3・Opus）・MOV・WebM を読める。
// AVI・WMV・MPEG は読めないことが多い。Safari は確かめていないので、読めなければ知らせて別の道を案内する（docs/safari.md）
import { engine } from './engine';
import { encodeAudio } from './stems';
import { nxSafeName } from '../fs/nxName';

/** 音を取り出す動画（読めるかはブラウザしだい） */
export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|flv|3gp)$/i;

/**
 * NX の曲データで BGA の動画（#AVI）に使われている形式（手持ちの曲は mp4・avi）。
 * ほかの形式（WebM・MOV など）は NX で流れるか確かめていないので、背景動画にする既定をオフにする
 */
export const NX_MOVIE_EXT = /\.(mp4|m4v|avi|wmv|mpe?g)$/i;

/** ファイルを選ぶ画面に足す拡張子（Chrome が音を読める動画） */
export const VIDEO_ACCEPT = '.mp4,.m4v,.mov,.webm,.mkv';

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.test(name);
}

/**
 * 取り出した音のファイル名：動画の名前のまま、拡張子だけ .ogg に（フォルダは外す）。
 * NX（Shift_JIS）で読めない文字は、見た目の近い文字か「_」にする（src/fs/nxName.ts）
 */
export function audioNameFor(video: string): string {
  const name = video.replace(/\\/g, '/').split('/').pop() ?? '';
  const base = name.replace(/\.[^.]*$/, '').trim();
  return nxSafeName(`${base || 'bgm'}.ogg`, 'bgm');
}

/** 無音か（音を消した動画・音の入れ物だけある動画）。floor は -80 dB */
export function isSilent(channels: readonly Float32Array[], floor = 1e-4): boolean {
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (ch[i] > floor || ch[i] < -floor) return false;
  return true;
}

/** 取り出せなかったわけ。unreadable: 読めない（音が無い・このブラウザで読めない形式）、silent: 音が無音、cancelled: やめた */
export type ExtractFailure = 'unreadable' | 'silent' | 'cancelled';

export interface ExtractOptions {
  /** 進み具合（read: 動画を読んでいる、encode: OGG にしている 0〜1） */
  onProgress?: (phase: 'read' | 'encode', progress: number) => void;
  /** やめたか（OGG にしている間、少しずつ見る） */
  cancelled?: () => boolean;
}

class Cancelled extends Error {}

/** 動画から音を取り出して OGG のファイルにする */
export async function extractVideoAudio(video: File, opts: ExtractOptions = {}): Promise<{ file: File; seconds: number } | { error: ExtractFailure }> {
  opts.onProgress?.('read', 0);
  let buf: AudioBuffer;
  try {
    buf = await engine.decodeAudio(await video.arrayBuffer());
  } catch {
    return { error: 'unreadable' };
  }
  if (opts.cancelled?.()) return { error: 'cancelled' };
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  if (buf.length === 0 || isSilent(channels)) return { error: 'silent' };
  opts.onProgress?.('encode', 0);
  let bytes: Uint8Array;
  try {
    // 1ブロック（約1.4秒の音）ごとに休んで進み具合を出す（画面が固まらないように）
    bytes = await encodeAudio(
      buf,
      'ogg',
      (p) => {
        if (opts.cancelled?.()) throw new Cancelled();
        opts.onProgress?.('encode', p);
      },
      1,
    );
  } catch (e) {
    if (e instanceof Cancelled) return { error: 'cancelled' };
    throw e;
  }
  if (opts.cancelled?.()) return { error: 'cancelled' };
  opts.onProgress?.('encode', 1);
  return { file: new File([bytes as Uint8Array<ArrayBuffer>], audioNameFor(video.name), { type: 'audio/ogg' }), seconds: buf.duration };
}
