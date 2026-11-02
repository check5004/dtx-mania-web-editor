// YouTube の参照映像。譜面の再生に合わせて動かす（音は原曲ファイルを鳴らし、YouTube は消音が基本）。
import { create } from 'zustand';
import { engine } from '../audio/engine';
import { bgmSource, tempoOf } from '../store/derived';
import { onPlayback, useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';

interface YTPlayer {
  seekTo(sec: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
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
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    // URL でなければ下で null
  }
  return null;
}

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

/** 譜面の秒 → 動画の秒 */
function videoTimeAt(songSec: number): number {
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  const offset = useSidecar.getState().youtube?.offset ?? 0;
  return songSec - (bgm?.sec ?? 0) + offset;
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
  const yt = listensYoutube() && player !== null;
  engine.setBgmMuted(yt);
  if (!player) return;
  if (yt) player.unMute();
  else player.mute();
}

/** 止まっているとき、カーソル位置の映像を出しておく */
export function cueToCursor() {
  if (!player || engine.playing) return;
  const s = useEditor.getState();
  const t = videoTimeAt(tempoOf(s.doc).beatToSec(Math.max(0, s.cursorBeat)));
  try {
    player.seekTo(Math.max(0, t), true);
    player.pauseVideo();
  } catch {
    // 準備中
  }
}

function startSync(rate: number) {
  if (!player) return;
  window.clearInterval(syncTimer);
  try {
    player.setPlaybackRate(rate);
  } catch {
    // 対応していない速さ
  }
  const check = () => {
    if (!player) return;
    const sec = engine.currentSec();
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
    const have = player.getCurrentTime();
    if (state !== 1 && state !== 3) {
      player.seekTo(want, true);
      player.playVideo();
      return;
    }
    if (Math.abs(have - want) > 0.15) player.seekTo(want + 0.05, true);
  };
  const sec = engine.currentSec() ?? 0;
  const want = videoTimeAt(sec);
  if (want >= 0) {
    player.seekTo(want, true);
    player.playVideo();
  }
  syncTimer = window.setInterval(check, 400);
}

onPlayback((e) => {
  if (!player || !useYt.getState().ready) return;
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
  if (s.youtube?.offset !== prev.youtube?.offset) cueToCursor();
  // 映像を外した・替えたら長さは分からなくなる（隠しただけなら覚えておく）
  if (s.youtube?.url !== prev.youtube?.url && useEditor.getState().refVideoSec !== 0) useEditor.setState({ refVideoSec: 0 });
});

// 原曲（BGM）を置いた・外したら、聴く音を切り替え直す
useEditor.subscribe((s, prev) => {
  if (s.doc !== prev.doc && !bgmSource(s.doc) !== !bgmSource(prev.doc)) applyListen();
});
