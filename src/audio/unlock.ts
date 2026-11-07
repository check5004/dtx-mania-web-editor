// 音の出力を起こす（Safari・iPad 対策）。決まりは docs/safari.md
// - iPad・iPhone の Safari は Web Audio を「消音（ベル）で黙る音」として鳴らす。音楽の再生として鳴らすよう頼む
//   （navigator.audioSession、iPadOS 17 から）
// - Safari はタップ・キーの操作の中でないと、止まった出力（suspended、Safari だけの interrupted）を起こせない。
//   操作のたびに起こす
// - 古い iOS は、操作の中で実際に音を鳴らすまで出力が開かない。1 サンプルの無音を鳴らす
import { IS_IOS } from '../platform';

type SessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
interface AudioSessionLike {
  type: SessionType;
}

function session(): AudioSessionLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession ?? null;
}

/**
 * iPad・iPhone では、消音でも黙らない「再生」の音として鳴らすよう頼む（Safari の既定は消音で黙る ambient）。
 * 出力を作る前に呼ぶ。今の種類を返す（API が無いブラウザは null）
 */
export function preferPlaybackSession(): string | null {
  const s = session();
  if (!s) return null;
  if (IS_IOS && s.type !== 'playback') {
    try {
      s.type = 'playback';
    } catch {
      // 変えられない版もある
    }
  }
  return s.type;
}

/** 今の音の種類（navigator.audioSession.type）。API が無ければ null */
export function audioSessionType(): string | null {
  return session()?.type ?? null;
}

/** 1 サンプルの無音を鳴らす（古い iOS は、操作の中で実際に音を鳴らすまで出力が開かない） */
export function playSilence(ctx: AudioContext) {
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.onended = () => src.disconnect();
    src.start(0);
  } catch {
    // 閉じた出力など
  }
}

/** 止まっている出力か（suspended と、Safari だけの interrupted） */
export function isAsleep(ctx: BaseAudioContext): boolean {
  const s = ctx.state as string;
  return s === 'suspended' || s === 'interrupted';
}

/** いまユーザーの操作の中か（分からないブラウザは true とみなす） */
export function inUserGesture(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return ua ? ua.isActive : true;
}

// HTML の決まりで「ユーザーの操作」になるのは、キー・マウスのボタンを押したときと、指を離したとき（pointerup・touchend）。
// 指で pointerdown しただけでは Safari は出力を起こさないので、離したときにも起こす
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown', 'click'] as const;
let installed = false;

/** 操作のたびに wake を呼ぶ（止まった出力を起こす）。画面に戻ったら onVisible、離れたら onHidden */
export function watchGestures(handlers: { wake: () => void; onVisible?: () => void; onHidden?: () => void }) {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  const wake = () => handlers.wake();
  for (const t of GESTURES) window.addEventListener(t, wake, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handlers.onVisible?.();
    else handlers.onHidden?.();
  });
}
