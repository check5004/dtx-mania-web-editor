// 解析ワーカーへの窓口。要求ごとに Promise を返す。
import type { AnalysisData } from './analysis';
import type { SpecMode, SpectroData } from './spectro';

export type { SpectroData };

export interface StretchChunk {
  channels: Float32Array[];
  /** 出力の 0 サンプル目が元の何秒目か */
  fromSec: number;
  sr: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (p: number) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const loaded = new Set<string>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; result?: unknown; error?: string; progress?: number }>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.progress !== undefined && m.ok === undefined) {
      p.progress?.(m.progress);
      return;
    }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || '解析に失敗しました'));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || '解析の処理が止まりました'));
    pending.clear();
    loaded.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], progress?: (p: number) => void): Promise<T> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
    w.postMessage({ ...msg, id }, transfer);
  });
}

/** 音声をワーカーに渡す（同じキーは一度だけ） */
export async function loadAudio(key: string, buf: AudioBuffer): Promise<void> {
  if (loaded.has(key)) return;
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
  await call({ type: 'load', key, channels, sr: buf.sampleRate }, channels.map((c) => c.buffer));
  loaded.add(key);
  // ワーカーは7曲まで持つ（ステムをスロー再生するとき全部を伸ばすため）
  while (loaded.size > 7) loaded.delete(loaded.values().next().value!);
}

export function analyze(key: string, progress?: (p: number) => void): Promise<AnalysisData> {
  return call<AnalysisData>({ type: 'analyze', key }, [], progress);
}

/** ドラムの耳コピ向けのスペクトル（同じ音で見せ方だけ変えるときは速い） */
export function spectrogram(key: string, mode: SpecMode, progress?: (p: number) => void): Promise<SpectroData> {
  return call<SpectroData>({ type: 'spectro', key, mode }, [], progress);
}

export function stretch(key: string, rate: number, from: number, to: number): Promise<StretchChunk> {
  return call<StretchChunk>({ type: 'stretch', key, rate, from, to });
}

export function isLoaded(key: string) {
  return loaded.has(key);
}
