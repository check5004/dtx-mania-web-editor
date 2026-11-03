// YouTube の参照映像。譜面の再生に合わせて動かす（音は原曲ファイルを鳴らし、YouTube は消音が基本）。
//
// 動画の秒 = 原曲の秒 + offset（自動で合わせて所ごとの差 anchors があれば、その所の差を足す）。
// 再生中は「いま耳に届いている曲の位置」と動画の位置（getCurrentTime）を比べ、ずれが大きくなったら動画を飛ばす。
// 飛ばしてから動き出すまでの遅れは、飛ばしたあとの着地のずれから少しずつ覚える（先回りの量）。
import { create } from 'zustand';
import { anchorDelta } from '../audio/align';
import { engine } from '../audio/engine';
import { bgmSource, tempoOf } from '../store/derived';
import { onPlayback, useEditor } from '../store/editor';
import { useSidecar, type YoutubeRef } from '../store/sidecar';

export interface YTPlayer {
  seekTo(sec: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getVolume(): number;
  setVolume(v: number): void;
  setPlaybackRate(r: number): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  getDuration(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, number | string>;
      events?: { onReady?: () => void; onError?: (e: { data: number }) => void };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YtState {
  ready: boolean;
  error: string | null;
  /** 聴く音: 原曲ファイル / YouTube */
  listen: 'file' | 'youtube';
  hidden: boolean;
}

export const useYt = create<YtState>(() => ({ ready: false, error: null, listen: 'file', hidden: false }));

/** URL や ID から動画 ID を取り出す */
export { youtubeId } from '../ai/songInfo';

let apiPromise: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        if (window.YT) resolve(window.YT);
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => {
        apiPromise = null;
        reject(new Error('YouTube を読み込めませんでした'));
      };
      document.head.appendChild(tag);
    });
  }
  return apiPromise;
}

let player: YTPlayer | null = null;
let syncTimer = 0;
/** 自動で合わせているあいだは、再生との同期を止める（合わせる側が動画を動かす） */
let held = false;

/** 原曲（音声ファイル）の秒 → 動画の秒 */
export function videoTimeOfAudio(a: number, yt: YoutubeRef | null = useSidecar.getState().youtube): number {
  if (!yt) return a;
  return a + yt.offset + anchorDelta(yt.anchors ?? [], a);
}

/** 譜面の秒 → 動画の秒 */
function videoTimeAt(songSec: number): number {
  const bgm = bgmSource(useEditor.getState().doc);
  return videoTimeOfAudio(songSec - (bgm?.sec ?? 0));
}

export async function mountPlayer(el: HTMLElement, videoId: string): Promise<void> {
  destroyPlayer();
  useYt.setState({ ready: false, error: null });
  try {
    const YT = await loadApi();
    const host = document.createElement('div');
    el.replaceChildren(host);
    player = new YT.Player(host, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { controls: 1, rel: 0, playsinline: 1, modestbranding: 1, disablekb: 1 },
      events: {
        onReady: () => {
          if (!player) return;
          applyListen();
          useYt.setState({ ready: true });
          noteDuration();
          cueToCursor();
        },
        onError: (e) => {
          useYt.setState({ error: e.data === 101 || e.data === 150 ? 'この動画は埋め込みが許可されていません' : '動画を再生できません' });
        },
      },
    });
  } catch (e) {
    useYt.setState({ error: (e as Error).message });
  }
}

export function destroyPlayer() {
  window.clearInterval(syncTimer);
  syncTimer = 0;
  try {
    player?.destroy();
  } catch {
    // 消えていても良い
  }
  player = null;
  useYt.setState({ ready: false });
  engine.setBgmMuted(false);
}

/** 自動で合わせる処理が動画を動かすための入口（準備ができていなければ null） */
export function ytPlayer(): YTPlayer | null {
  return player && useYt.getState().ready ? player : null;
}

/** 動画の長さ（秒）。分からなければ 0 */
export function ytDuration(): number {
  try {
    return player?.getDuration() ?? 0;
  } catch {
    return 0;
  }
}

/** 自動で合わせるあいだ、再生との同期を止める／戻す */
export function holdSync(on: boolean) {
  held = on;
  if (on) {
    window.clearInterval(syncTimer);
    syncTimer = 0;
  } else {
    applyListen();
    cueToCursor();
  }
}

/** 映像の長さを曲の長さに入れる（譜面が空でも映像の終わりまで再生できるように） */
function noteDuration() {
  let dur = 0;
  try {
    dur = player?.getDuration() ?? 0;
  } catch {
    // 準備中
  }
  if (dur > 0 && Math.abs(dur - useEditor.getState().refVideoSec) > 0.01) useEditor.setState({ refVideoSec: dur });
}

/** 聴く音を切り替える（YouTube のときは原曲ファイルを消す） */
export function setListen(listen: 'file' | 'youtube') {
  useYt.setState({ listen });
  applyListen();
}

/** 原曲ファイルが無い譜面では YouTube の音を聴く */
export function listensYoutube(): boolean {
  return useYt.getState().listen === 'youtube' || !bgmSource(useEditor.getState().doc);
}

function applyListen() {
  if (held) return;
  const yt = listensYoutube() && player !== null;
  engine.setBgmMuted(yt);
  if (!player) return;
  if (yt) player.unMute();
  else player.mute();
}

/** 止まっているとき、カーソル位置の映像を出しておく */
export function cueToCursor() {
  if (!player || engine.playing || held) return;
  const s = useEditor.getState();
  const t = videoTimeAt(tempoOf(s.doc).beatToSec(Math.max(0, s.cursorBeat)));
  try {
    player.seekTo(Math.max(0, t), true);
    player.pauseVideo();
  } catch {
    // 準備中
  }
}

/** このずれ（秒）を超えたら動画を飛ばす */
const TOL = 0.08;
/**
 * 飛ばしてから動き出すまでの遅れを見込んだ先回り（秒）。着地のずれから覚える。
 * 止まっている所から動かすとき（cold）と、動いたまま飛ばすとき（hot）では遅れが違うので別に覚える
 */
const lead = { cold: 0.05, hot: 0.05 };

/** いま耳に届いている曲の位置（鳴り始める前は、始めの位置より前へ延ばす。無ければ音を作っている位置） */
function heardNow(): number | null {
  return engine.heardSecLinear() ?? engine.currentSec();
}

/**
 * テンポが少しずつ違う動画（ライブ版など）では、同じ速さで流すと映像が一方へずれていく（細かい速さは YouTube で選べない）。
 * 飛ばすときに逆向きへ少し寄せておき、ずれが 0 のまわりを行き来するようにする（寄せる量・秒）
 */
function driftBias(sec: number): number {
  // 曲 1 秒あたりに動画が進むべき秒。1 より小さければ、動画は先へ行きすぎる
  const slope = (videoTimeAt(sec + 1) - videoTimeAt(sec - 1)) / 2;
  const k = 1 - slope;
  // 編集で飛ぶ所（傾きが大きく外れる）は寄せない
  if (Math.abs(k) < 0.003 || Math.abs(k) > 0.1) return 0;
  return -Math.sign(k) * TOL * 0.7;
}

function startSync(rate: number) {
  if (!player || held) return;
  window.clearInterval(syncTimer);
  try {
    player.setPlaybackRate(rate);
  } catch {
    // 対応していない速さ
  }
  /** 最後に飛ばした時刻（performance.now）。動き出して落ち着くまでは測らない */
  let seekAt = 0;
  let landed = true;
  let seekKind: keyof typeof lead = 'cold';
  /** 飛ばしたときにわざと寄せた量 */
  let seekBias = 0;
  const seek = (sec: number, want: number, kind: keyof typeof lead) => {
    if (!player) return;
    seekBias = driftBias(sec);
    player.seekTo(want + seekBias + lead[kind] * rate, true);
    seekAt = performance.now();
    seekKind = kind;
    landed = false;
  };
  const check = () => {
    if (!player || held) return;
    const sec = heardNow();
    if (sec === null) return;
    const want = videoTimeAt(sec);
    const state = player.getPlayerState();
    if (want < 0) {
      if (state === 1) player.pauseVideo();
      return;
    }
    const dur = player.getDuration();
    noteDuration();
    if (dur > 0 && want > dur) return;
    if (state !== 1 && state !== 3) {
      // 動かしたばかりなら、動き出すのを待つ（動画の状態が届くまで少しかかる）
      if (seekKind === 'cold' && performance.now() - seekAt < 1000) return;
      seek(sec, want, 'cold');
      player.playVideo();
      return;
    }
    if (state === 3 || performance.now() - seekAt < 350) return;
    const err = player.getCurrentTime() - want;
    if (!landed) {
      // 飛ばしたあとの着地のずれ（わざと寄せた分は除く）で、先回りの量を直す（半分ずつ）
      landed = true;
      const miss = err - seekBias;
      if (Math.abs(miss) < 0.5) lead[seekKind] = Math.max(0, Math.min(0.4, lead[seekKind] - miss * 0.5));
    }
    if (Math.abs(err) > TOL) seek(sec, want, 'hot');
  };
  const sec = heardNow() ?? 0;
  const want = videoTimeAt(sec);
  if (want >= 0) {
    seek(sec, want, 'cold');
    player.playVideo();
  }
  syncTimer = window.setInterval(check, 250);
}

onPlayback((e) => {
  if (!player || !useYt.getState().ready || held) return;
  if (e.type === 'play') startSync(e.rate);
  else if (e.type === 'loop') {
    player.seekTo(Math.max(0, videoTimeAt(e.startSec)), true);
  } else {
    window.clearInterval(syncTimer);
    syncTimer = 0;
    try {
      player.pauseVideo();
    } catch {
      // 消えている
    }
    window.setTimeout(cueToCursor, 50);
  }
});

let cueTimer = 0;
useEditor.subscribe((s, prev) => {
  if (s.cursorBeat === prev.cursorBeat || !player || engine.playing) return;
  window.clearTimeout(cueTimer);
  cueTimer = window.setTimeout(cueToCursor, 120);
});

useSidecar.subscribe((s, prev) => {
  if (s.youtube?.offset !== prev.youtube?.offset || s.youtube?.anchors !== prev.youtube?.anchors) cueToCursor();
  // 映像を外した・替えたら長さは分からなくなる（隠しただけなら覚えておく）
  if (s.youtube?.url !== prev.youtube?.url && useEditor.getState().refVideoSec !== 0) useEditor.setState({ refVideoSec: 0 });
});

// 原曲（BGM）を置いた・外したら、聴く音を切り替え直す
useEditor.subscribe((s, prev) => {
  if (s.doc !== prev.doc && !bgmSource(s.doc) !== !bgmSource(prev.doc)) applyListen();
});
