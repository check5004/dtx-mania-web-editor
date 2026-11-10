// 動画から音を取り出している間の様子（画面の真ん中に出し、やめられる）と、取り出せなかったときの知らせ。
// 取り出す中身は src/audio/videoAudio.ts
import { create } from 'zustand';
import { tr } from '../i18n';
import { IS_WEBKIT } from '../platform';
import { extractVideoAudio, type ExtractFailure } from '../audio/videoAudio';
import { toast } from './editor';

export interface ExtractJob {
  /** 動画のファイル名 */
  name: string;
  phase: 'read' | 'encode';
  /** OGG にしている進み具合（0〜1） */
  progress: number;
  cancel: () => void;
}

export const useVideoExtract = create<{ job: ExtractJob | null }>(() => ({ job: null }));

export function failText(why: Exclude<ExtractFailure, 'cancelled'>, name: string): string {
  if (why === 'silent')
    return tr(
      `「${name}」の音は無音でした（音の入っていない動画のようです）。原曲にする音声ファイルを別に読み込んでください`,
      `The audio in "${name}" is silent (the video seems to have no sound). Load the original audio file separately`,
    );
  // iPad・iPhone はどのブラウザも中身が Safari（WebKit）なので、読めないときは PC を案内する
  return IS_WEBKIT
    ? tr(
        `「${name}」から音を取り出せませんでした。音の入っていない動画か、このブラウザでは読めない形式です。PC の Chrome か Edge で開くか、音声ファイル（MP3・M4A・WAV）にしてから読み込んでください`,
        `Couldn't take the audio out of "${name}". The video has no sound, or this browser can't read its format. Open it in Chrome or Edge on a computer, or convert it to an audio file (MP3, M4A, WAV) first`,
      )
    : tr(
        `「${name}」から音を取り出せませんでした。音の入っていない動画か、読めない形式です（読めるのは MP4・MOV・WebM の動画）。MP4 か音声ファイル（MP3・M4A・WAV）にしてから読み込んでください`,
        `Couldn't take the audio out of "${name}". The video has no sound, or its format can't be read (MP4, MOV and WebM videos work). Convert it to MP4 or an audio file (MP3, M4A, WAV) first`,
      );
}

/**
 * 動画から音を取り出して OGG のファイルにする（その間、様子を出す）。
 * 取り出せなければ知らせて null。やめたときも null（知らせない）
 */
export async function extractWithProgress(video: File): Promise<File | null> {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    useVideoExtract.setState({ job: null });
  };
  const show = (phase: ExtractJob['phase'], progress: number) => {
    if (!cancelled) useVideoExtract.setState({ job: { name: video.name, phase, progress, cancel } });
  };
  try {
    const r = await extractVideoAudio(video, { onProgress: show, cancelled: () => cancelled });
    if ('error' in r) {
      if (r.error !== 'cancelled') toast(failText(r.error, video.name), 'warn', 12000);
      return null;
    }
    return r.file;
  } catch (e) {
    toast(tr(`動画から音を取り出せませんでした: ${(e as Error).message}`, `Couldn't take the audio out of the video: ${(e as Error).message}`), 'error', 9000);
    return null;
  } finally {
    useVideoExtract.setState({ job: null });
  }
}
