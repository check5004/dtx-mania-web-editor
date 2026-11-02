import { useEffect, useState } from 'react';
import type { DtxDoc } from '../dtx/model';
import { currentBeat, songEndSec, useEditor } from '../store/editor';

/** 再生中は再生位置、止まっていればカーソル位置（拍）。再生中は画面の更新に合わせて変わる */
export function usePlayBeat(): number {
  const playing = useEditor((s) => s.playing);
  const cursor = useEditor((s) => s.cursorBeat);
  const [beat, setBeat] = useState(cursor);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 33) return;
      last = t;
      setBeat(currentBeat());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return playing ? beat : cursor;
}

const lengthCache = new WeakMap<DtxDoc, { v: number; ver: number }>();

/** 曲の長さ（秒）。BGM の長さは音の読み込み後に分かるので、読み込みが終わるたびに計算し直す */
export function songLength(doc: DtxDoc): number {
  const ver = useEditor.getState().soundsVersion;
  const c = lengthCache.get(doc);
  if (c && c.ver === ver) return c.v;
  const v = songEndSec(doc);
  lengthCache.set(doc, { v, ver });
  return v;
}

/** 音の読み込みが終わったら再描画するためのフック */
export function useSoundsVersion() {
  return useEditor((s) => s.soundsVersion);
}
