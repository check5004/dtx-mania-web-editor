// ステム分解の窓口。音を 44.1kHz のステレオにそろえ、ワーカーで分解する。
// 分解は1曲に数十秒〜数分かかるので、ワーカーはしばらく残してモデルを使い回し、使わなくなったら閉じて GPU のメモリを返す。
import { SEP_CACHE, SEP_MODELS, SEP_SR, type SepModelId, type SepPrecision, type SepStem } from './models';
import type { SepBackend, SepErrorCode, SepMessage, SepRequest, SepStage } from './worker';

export interface SepProgress {
  stage: SepStage;
  done: number;
  total: number;
  /** モデルをブラウザに覚えてあったか */
  cached?: boolean;
}

export interface SeparateOptions {
  model: SepModelId;
  precision?: SepPrecision | 'auto';
  /** 取り出すステム */
  want: SepStem[];
  /** 原曲から取り出したステムを引いた残りも返す（足すと原曲にぴったり戻る） */
  rest?: boolean;
  /** 区切りの重なり（0.25 = Demucs と同じ） */
  overlap?: number;
  allowWasm?: boolean;
  onProgress?: (p: SepProgress) => void;
  signal?: AbortSignal;
}

export interface SeparateResult {
  stems: Partial<Record<SepStem, [Float32Array, Float32Array]>>;
  /** 原曲−取り出したステム（rest を頼んだとき） */
  rest: [Float32Array, Float32Array] | null;
  backend: SepBackend;
  precision: SepPrecision;
  gpu: string;
  wallMs: number;
  modelMs: number;
  segments: number;
}

export class SeparateError extends Error {
  code: SepErrorCode | 'abort';
  constructor(code: SepErrorCode | 'abort', message: string) {
    super(message);
    this.code = code;
  }
}

/** WebGPU が使えそうか（アダプターが取れるか）。fp16 を計算できるかも返す */
export async function webgpuStatus(): Promise<{ ok: boolean; f16: boolean }> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: { powerPreference?: string }): Promise<{ features: { has(f: string): boolean } } | null> } }).gpu;
  if (!gpu) return { ok: false, f16: false };
  try {
    const a = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    return a ? { ok: true, f16: a.features.has('shader-f16') } : { ok: false, f16: false };
  } catch {
    return { ok: false, f16: false };
  }
}

/** ブラウザに覚えてあるモデル（モデルと精度、バイト数） */
export async function savedModels(): Promise<{ model: SepModelId; precision: SepPrecision; bytes: number }[]> {
  if (typeof caches === 'undefined') return [];
  try {
    const keys = await (await caches.open(SEP_CACHE)).keys();
    const out: { model: SepModelId; precision: SepPrecision; bytes: number }[] = [];
    for (const m of Object.values(SEP_MODELS))
      for (const [precision, f] of Object.entries(m.files) as [SepPrecision, (typeof m.files)['fp16']][])
        if (keys.some((k) => k.url === f.url)) out.push({ model: m.id, precision, bytes: f.bytes });
    return out;
  } catch {
    return [];
  }
}

/** 覚えてあるモデルを消す（次に分解するとき、また読み込む） */
export async function clearSavedModels(): Promise<void> {
  if (pending.size === 0) closeWorker();
  if (typeof caches !== 'undefined') await caches.delete(SEP_CACHE).catch(() => false);
}

/** ファイルを 44.1kHz のステレオに読む（モノラルは左右に同じ音） */
export async function decodeForSeparation(bytes: ArrayBuffer): Promise<{ left: Float32Array; right: Float32Array; duration: number }> {
  const ctx = new OfflineAudioContext(2, 1, SEP_SR);
  const buf = await ctx.decodeAudioData(bytes);
  const left = buf.getChannelData(0).slice();
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : left.slice();
  return { left, right, duration: buf.duration };
}

// ---- ワーカー -------------------------------------------------------------------------

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: SeparateResult) => void; reject: (e: Error) => void; progress?: (p: SepProgress) => void }>();

/** 使い終わってからワーカーを閉じるまで（モデルと GPU のメモリを返す） */
const IDLE_MS = 3 * 60_000;

function getWorker(): Worker {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<SepMessage>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if ('stage' in m) {
      p.progress?.({ stage: m.stage, done: m.done, total: m.total, cached: m.cached });
      return;
    }
    pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else {
      p.reject(new SeparateError(m.code, m.error));
      // 失敗したワーカー（GPU のメモリ不足など）は使い回さない
      closeWorker();
    }
    scheduleIdle();
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new SeparateError('run', e.message || '分解の処理が止まりました（メモリが足りない可能性があります）'));
    pending.clear();
    closeWorker();
  };
  return worker;
}

function closeWorker() {
  worker?.terminate();
  worker = null;
}

function scheduleIdle() {
  if (pending.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size > 0) return;
    closeWorker();
  }, IDLE_MS);
}

/** 音（左・右、44.1kHz）を分解する。left・right はワーカーへ渡すので、呼んだ後は使えなくなる */
export function separate(left: Float32Array, right: Float32Array, opts: SeparateOptions): Promise<SeparateResult> {
  if (opts.signal?.aborted) return Promise.reject(new SeparateError('abort', '中止しました'));
  const w = getWorker();
  const id = nextId++;
  return new Promise<SeparateResult>((resolve, reject) => {
    const onAbort = () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // 計算中の GPU を止めるにはワーカーごと閉じるしかない
      closeWorker();
      for (const p of pending.values()) p.reject(new SeparateError('abort', '中止しました'));
      pending.clear();
      reject(new SeparateError('abort', '中止しました'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: (r) => {
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      },
      reject: (e) => {
        opts.signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
      progress: opts.onProgress,
    });
    const msg: SepRequest = {
      id,
      type: 'run',
      model: opts.model,
      precision: opts.precision ?? 'auto',
      allowWasm: opts.allowWasm ?? true,
      left,
      right,
      want: opts.want,
      rest: opts.rest ?? false,
      overlap: opts.overlap ?? 0.25,
    };
    w.postMessage(msg, [left.buffer, right.buffer]);
  });
}
