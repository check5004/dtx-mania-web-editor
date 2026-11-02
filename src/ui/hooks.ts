import { useEffect, useState } from 'react';
import type { DtxDoc } from '../dtx/model';
import { useAssist } from '../store/assist';
import { currentBeat, songEndSec, useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';

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

const lengthCache = new WeakMap<DtxDoc, { v: number; key: unknown[] }>();

function lengthKey(): unknown[] {
  return [useEditor.getState().soundsVersion, useEditor.getState().refVideoSec, useSidecar.getState().youtube?.offset, useAssist.getState().data];
}

/** 曲の長さ（秒）。BGM の長さは音の読み込み後・解析後に、映像の長さは読み込み後に分かるので、そのたびに計算し直す */
export function songLength(doc: DtxDoc): number {
  const key = lengthKey();
  const c = lengthCache.get(doc);
  if (c && c.key.every((v, i) => v === key[i])) return c.v;
  const v = songEndSec(doc);
  lengthCache.set(doc, { v, key });
  return v;
}

/** 曲の長さ（秒）。長さが変わったら再描画する */
export function useSongLength(doc: DtxDoc): number {
  useEditor((s) => s.soundsVersion);
  useEditor((s) => s.refVideoSec);
  useSidecar((s) => s.youtube?.offset);
  useAssist((s) => s.data);
  return songLength(doc);
}

/** 音の読み込みが終わったら再描画するためのフック */
export function useSoundsVersion() {
  return useEditor((s) => s.soundsVersion);
}
