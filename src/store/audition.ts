// 試聴（WAV・キット・ライブラリの ▶）。同時に鳴らすのは1つだけ。
// 鳴っている ▶ は ■ になり、もう一度押すと止まる。別の音を試聴する・曲を再生する・Esc・その一覧を閉じても止まる。
// 原曲のような長い音も試聴できるので、必ず止められるようにする。
// チップを置いた・叩いたときの音（previewWav・previewLane）はここを通さない（重ねて鳴らす。フラムの2打目で1打目を切らない）。
import { useEffect } from 'react';
import { create } from 'zustand';
import { engine } from '../audio/engine';
import { onPlayback, useEditor } from './editor';

export interface AuditionSound {
  buf: AudioBuffer;
  /** #VOLUME と同じ（0〜100）。省くと 100 */
  volume?: number;
  /** #PAN と同じ（-100〜100）。省くと 0 */
  pan?: number;
  /** volume に掛ける倍率（ベロシティ違いの比など） */
  gain?: number;
}

export interface AuditionState {
  /** 試聴している音（読み込み中も）。'wav:<番号>'・'kit:<ch>'・'lib:<id>' など。無ければ null */
  key: string | null;
  /** 鳴り始めた時刻（performance.now()）。読み込み中は 0 */
  since: number;
  /** 長さ（秒） */
  duration: number;
}

const IDLE: AuditionState = { key: null, since: 0, duration: 0 };

export const useAudition = create<AuditionState>(() => IDLE);

/** 試聴のたびに増える。読み込みを待つ間に止めた・別の試聴を始めたかを見分ける */
let seq = 0;

/** 試聴を止める。試聴していたら（読み込み中も）true */
export function stopAudition(): boolean {
  const had = useAudition.getState().key !== null;
  seq++;
  engine.stopAudition();
  if (had) useAudition.setState(IDLE);
  return had;
}

/**
 * key の音を試聴する（前の試聴は止める）。load は鳴らす音を返す（読めなければ null）。
 * 押したボタンの中で呼ぶ（AudioContext をクリックの中で起こすため）。鳴らせたら true
 */
export async function playAudition(key: string, load: () => AuditionSound | null | Promise<AuditionSound | null>): Promise<boolean> {
  engine.ensure();
  stopAudition();
  const id = seq;
  useAudition.setState({ key, since: 0, duration: 0 });
  let snd: AuditionSound | null = null;
  try {
    snd = await load();
  } catch {
    snd = null;
  }
  if (id !== seq) return false;
  if (!snd) {
    useAudition.setState(IDLE);
    return false;
  }
  const duration = engine.audition(snd.buf, snd.volume ?? 100, snd.pan ?? 0, snd.gain ?? 1, () => {
    // 鳴り終わった・曲の再生で止まった
    if (id !== seq) return;
    seq++;
    useAudition.setState(IDLE);
  });
  useAudition.setState({ key, since: performance.now(), duration });
  return true;
}

/** ▶・■ のボタン：key を試聴していれば止め、していなければ試聴する */
export function toggleAudition(key: string, load: () => AuditionSound | null | Promise<AuditionSound | null>): Promise<boolean> {
  if (useAudition.getState().key === key) {
    stopAudition();
    return Promise.resolve(false);
  }
  return playAudition(key, load);
}

/** 試聴の一覧（WAV・キットのタブ、ライブラリ）を閉じたら、そこで始めた試聴を止める（■ が見えなくなるので） */
export function useStopAuditionOnClose(prefix: string) {
  useEffect(
    () => () => {
      if (useAudition.getState().key?.startsWith(prefix)) stopAudition();
    },
    [prefix],
  );
}

// 曲の再生を始めたら止める（engine も止めるが、読み込み中の試聴は鳴らさないようここでも止める）
onPlayback((e) => {
  if (e.type === 'play') stopAudition();
});

// 別の曲を開いたら止める（WAV 番号の指す音が変わる）
useEditor.subscribe((s, prev) => {
  if (s.folder !== prev.folder || s.screen !== prev.screen) stopAudition();
});
