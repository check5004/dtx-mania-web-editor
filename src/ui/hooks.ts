import { useEffect, useRef, useState } from 'react';
import type { DtxDoc } from '../dtx/model';
import { useAssist } from '../store/assist';
import { contentEndSec, currentBeat, songEndMeasure, songEndSec, useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';
import { useStems } from '../store/stems';

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

const lengthCache = new WeakMap<DtxDoc, { v: number; span: number; m: number; key: unknown[] }>();

function lengthKey(): unknown[] {
  return [useEditor.getState().soundsVersion, useEditor.getState().refVideoSec, useSidecar.getState().youtube?.offset, useAssist.getState().data, useStems.getState().version];
}

function lengths(doc: DtxDoc): { v: number; span: number; m: number } {
  const key = lengthKey();
  const c = lengthCache.get(doc);
  if (c && c.key.every((v, i) => v === key[i])) return c;
  const out = { v: songEndSec(doc), span: contentEndSec(doc), m: songEndMeasure(doc), key };
  lengthCache.set(doc, out);
  return out;
}

/**
 * 曲の長さ（秒）＝曲の終わり（END の線）。原曲の長さは音の読み込み後・解析後に分かるので、そのたびに計算し直す。
 * 参照映像の長さは、原曲ファイルが無いときだけ使う
 */
export function songLength(doc: DtxDoc): number {
  return lengths(doc).v;
}

/** 全体を見渡す幅（秒）。曲の終わりと原曲の鳴り終わりの遅い方（終わりより後の原曲も見えるように） */
export function songSpan(doc: DtxDoc): number {
  return lengths(doc).span;
}

/** 曲の終わり（END の線）の小節。何も分からなければ 0 */
export function songEndM(doc: DtxDoc): number {
  return lengths(doc).m;
}

/** 長さが変わったら再描画する */
function useLengthDeps() {
  useEditor((s) => s.soundsVersion);
  useEditor((s) => s.refVideoSec);
  useSidecar((s) => s.youtube?.offset);
  useAssist((s) => s.data);
  useStems((s) => s.version);
}

/** 曲の長さ（秒）。長さが変わったら再描画する */
export function useSongLength(doc: DtxDoc): number {
  useLengthDeps();
  return songLength(doc);
}

/** 全体を見渡す幅（秒）。変わったら再描画する */
export function useSongSpan(doc: DtxDoc): number {
  useLengthDeps();
  return songSpan(doc);
}

/** 音の読み込みが終わったら再描画するためのフック */
export function useSoundsVersion() {
  return useEditor((s) => s.soundsVersion);
}

/** canvas に描く（大きさが変わったら描き直す。animate なら毎フレーム） */
export function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[], animate = false) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const c = ref.current!;
    let raf = 0;
    const paint = () => {
      const rect = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
        c.width = Math.floor(w * dpr);
        c.height = Math.floor(h * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current(ctx, w, h);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    if (animate) {
      const loop = () => {
        raf = requestAnimationFrame(loop);
        paint();
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
