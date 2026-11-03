// ステム分解を別スレッドで動かす。ONNX Runtime Web でモデルを動かし（WebGPU、無ければ WASM）、
// 前後の STFT・逆 STFT と区切りの重ね合わせ（dsp.ts）もここでやる。画面は止まらない。
import { tr, setLang, type Lang } from '../i18n';
import * as ort from 'onnxruntime-web';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import { OverlapAdd, SegmentStft, inverseWeightSum, planSegments, readWindow, splitWeight } from './dsp';
import { SEP_CACHE, SEP_MODELS, geometryOf, type SepModelId, type SepPrecision, type SepStem } from './models';

export type SepBackend = 'webgpu' | 'wasm';

export interface SepRequest {
  id: number;
  type: 'run';
  model: SepModelId;
  /** 'auto' は GPU が fp16 を計算できれば fp16（ファイルが半分）、だめなら fp32 */
  precision: SepPrecision | 'auto';
  /** WebGPU が無いとき WASM（CPU）で動かしてよいか（webgpuOnly のモデルは不可） */
  allowWasm: boolean;
  left: Float32Array;
  right: Float32Array;
  /** 取り出すステム（モデルの出力のうち） */
  want: SepStem[];
  /** 原曲から取り出したステムを引いた残り（rest）も返す。ステムと rest を足すと原曲にぴったり戻る */
  rest: boolean;
  overlap: number;
  /** エラーの文の言語（ワーカーは画面の言語を知らないので渡す） */
  lang: Lang;
}

export type SepStage = 'check' | 'download' | 'compile' | 'run';

export type SepErrorCode = 'no-webgpu' | 'download' | 'compile' | 'run';

export type SepMessage =
  | { id: number; stage: SepStage; done: number; total: number; cached?: boolean }
  | {
      id: number;
      ok: true;
      stems: Partial<Record<SepStem, [Float32Array, Float32Array]>>;
      rest: [Float32Array, Float32Array] | null;
      backend: SepBackend;
      precision: SepPrecision;
      gpu: string;
      wallMs: number;
      modelMs: number;
      segments: number;
    }
  | { id: number; ok: false; error: string; code: SepErrorCode };

ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
ort.env.logLevel = 'error';

const post = (msg: SepMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

class SepError extends Error {
  code: SepErrorCode;
  constructor(code: SepErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---- GPU -------------------------------------------------------------------------

/** WebGPU の型（@webgpu/types を入れずに、使う所だけ） */
interface GpuAdapterLike {
  features: { has(f: string): boolean };
  info?: { vendor?: string; architecture?: string; description?: string };
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
}

interface GpuInfo {
  adapter: GpuAdapterLike;
  f16: boolean;
  name: string;
  /** 1つのバッファの上限（MB） */
  maxBufferMb: number;
}

async function findGpu(): Promise<GpuInfo | null> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: { powerPreference?: string }): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const info = adapter.info;
    const name = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'GPU';
    const maxBufferMb = Math.round(Math.min(adapter.limits.maxBufferSize, adapter.limits.maxStorageBufferBindingSize) / 2 ** 20);
    return { adapter, f16: adapter.features.has('shader-f16'), name, maxBufferMb };
  } catch {
    return null;
  }
}

// ---- モデルのファイル ----------------------------------------------------------------


function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** モデルを読む（一度読んだらブラウザに覚えておく） */
async function modelBytes(file: { url: string; bytes: number; sha256: string }, progress: (done: number, total: number, cached: boolean) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = 'caches' in self ? await caches.open(SEP_CACHE) : null;
  } catch {
    cache = null;
  }
  const hit = cache ? await cache.match(file.url).catch(() => undefined) : undefined;
  if (hit) {
    progress(0, file.bytes, true);
    const buf = await hit.arrayBuffer().catch(() => null);
    if (buf && buf.byteLength === file.bytes) {
      progress(file.bytes, file.bytes, true);
      return new Uint8Array(buf);
    }
    await cache?.delete(file.url).catch(() => false);
  }
  let res: Response;
  try {
    res = await fetch(file.url, { mode: 'cors' });
  } catch {
    throw new SepError('download', tr('モデルを読み込めませんでした（インターネットにつながっているか確かめてください）', "Couldn't download the model (check your internet connection)"));
  }
  if (!res.ok || !res.body) throw new SepError('download', tr(`モデルを読み込めませんでした（${res.status}）`, `Couldn't download the model (${res.status})`));
  // 大きいので、先に入れ物を用意して流し込む（部品を集めてから繋ぐと2倍のメモリを使う）
  const buf = new Uint8Array(file.bytes);
  const reader = res.body.getReader();
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) throw new SepError('download', tr('モデルの大きさが想定と違います（読み込み直してください）', 'The model has an unexpected size (try downloading it again)'));
    buf.set(value, got);
    got += value.length;
    if (got - last > 1 << 20) {
      last = got;
      progress(got, file.bytes, false);
    }
  }
  if (got !== file.bytes) throw new SepError('download', tr(`モデルを最後まで読み込めませんでした（${got} / ${file.bytes} バイト）`, `The model download stopped early (${got} / ${file.bytes} bytes)`));
  progress(got, file.bytes, false);
  if (crypto?.subtle) {
    const h = hex(await crypto.subtle.digest('SHA-256', buf));
    if (h !== file.sha256) throw new SepError('download', tr('モデルの中身が想定と違います（読み込み直してください）', "The model's contents don't match (try downloading it again)"));
  }
  try {
    await cache?.put(file.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) } }));
  } catch {
    // 覚えられなくても（容量が足りないなど）、今回は使える
  }
  return buf;
}

// ---- セッション -----------------------------------------------------------------------

let current: { key: string; session: ort.InferenceSession; backend: SepBackend; precision: SepPrecision; gpu: string } | null = null;
let gpuChosen = false;

async function getSession(req: SepRequest, progress: (stage: SepStage, done: number, total: number, cached?: boolean) => void) {
  const model = SEP_MODELS[req.model];
  progress('check', 0, 1);
  const gpu = await findGpu();
  let backend: SepBackend;
  if (gpu) backend = 'webgpu';
  else if (req.allowWasm && !model.webgpuOnly) backend = 'wasm';
  else throw new SepError('no-webgpu', tr('このブラウザでは WebGPU（GPU で計算する仕組み）が使えません', "WebGPU (computing on the GPU) isn't available in this browser"));
  const precision: SepPrecision = req.precision !== 'auto' ? req.precision : backend === 'webgpu' && gpu?.f16 ? 'fp16' : 'fp32';
  const key = `${model.id}|${precision}|${backend}`;
  if (current?.key === key) return current;
  if (current) {
    await current.session.release().catch(() => undefined);
    current = null;
  }
  const file = model.files[precision];
  const bytes = await modelBytes(file, (d, t, c) => progress('download', d, t, c));
  progress('compile', 0, 1);
  // GPU は最初のセッションを作るときに決まる（同じワーカーでは同じ GPU を使う）
  if (backend === 'webgpu' && gpu && !gpuChosen) {
    ort.env.webgpu.adapter = gpu.adapter as typeof ort.env.webgpu.adapter;
    gpuChosen = true;
  }
  let session: ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: 'all' });
  } catch (e) {
    throw new SepError('compile', tr(`モデルを準備できませんでした（${(e as Error)?.message || e}）`, `Couldn't prepare the model (${(e as Error)?.message || e})`));
  }
  const gpuText = (g: NonNullable<typeof gpu>) =>
    tr(`${g.name}（1バッファ ${g.maxBufferMb}MB まで${g.f16 ? '・fp16 可' : ''}）`, `${g.name} (buffers up to ${g.maxBufferMb} MB${g.f16 ? ', fp16 OK' : ''})`);
  current = { key, session, backend, precision, gpu: backend === 'webgpu' && gpu ? gpuText(gpu) : 'CPU' };
  return current;
}

// ---- 分解 -------------------------------------------------------------------------

async function run(req: SepRequest) {
  const t0 = performance.now();
  const progress = (stage: SepStage, done: number, total: number, cached?: boolean) => post({ id: req.id, stage, done, total, cached });
  const s = await getSession(req, progress);
  const model = SEP_MODELS[req.model];
  const g = geometryOf(model);
  const st = new SegmentStft(g);
  const { left: L, right: R } = req;
  const n = L.length;
  const segs = planSegments(n, g.chunk, req.overlap);
  const weight = splitWeight(g.chunk);
  const want = model.stems.map((name, k) => ({ name, k })).filter((x) => req.want.includes(x.name));
  const acc = want.map(() => new OverlapAdd(n, weight));
  const inL = new Float32Array(st.length);
  const inR = new Float32Array(st.length);
  const outL = new Float32Array(st.length);
  const outR = new Float32Array(st.length);
  const shape = [1, 2, st.bins, st.frames];
  let modelMs = 0;
  progress('run', 0, segs.length);
  for (const [i, seg] of segs.entries()) {
    readWindow(L, seg.from, g.chunk, inL);
    readWindow(R, seg.from, g.chunk, inR);
    const re = new Float32Array(st.specSize);
    const im = new Float32Array(st.specSize);
    st.forward(inL, inR, re, im);
    const feeds = { spec_real: new ort.Tensor('float32', re, shape), spec_imag: new ort.Tensor('float32', im, shape) };
    const t = performance.now();
    let out: ort.InferenceSession.OnnxValueMapType;
    try {
      out = await s.session.run(feeds);
    } catch (e) {
      throw new SepError('run', tr(`分解の計算に失敗しました（${(e as Error)?.message || e}）`, `The separation failed (${(e as Error)?.message || e})`));
    }
    modelMs += performance.now() - t;
    const oRe = out.out_spec_real.data as Float32Array;
    const oIm = out.out_spec_imag.data as Float32Array;
    want.forEach((w, j) => {
      st.inverse(oRe, oIm, w.k * st.specSize, outL, outR);
      acc[j].add(seg, outL, outR);
    });
    for (const v of Object.values(out)) v.dispose?.();
    progress('run', i + 1, segs.length);
  }
  const inv = inverseWeightSum(n, segs, weight);
  const stems: Partial<Record<SepStem, [Float32Array, Float32Array]>> = {};
  want.forEach((w, j) => {
    acc[j].finish(inv);
    stems[w.name] = [acc[j].left, acc[j].right];
  });
  // 残り＝原曲−取り出したステム（原曲の入れ物をそのまま使う）
  let rest: [Float32Array, Float32Array] | null = null;
  if (req.rest) {
    for (const a of acc) {
      const sl = a.left;
      const sr = a.right;
      for (let i = 0; i < n; i++) {
        L[i] -= sl[i];
        R[i] -= sr[i];
      }
    }
    rest = [L, R];
  }
  return { stems, rest, backend: s.backend, precision: s.precision, gpu: s.gpu, wallMs: performance.now() - t0, modelMs, segments: segs.length };
}

self.onmessage = (e: MessageEvent<SepRequest>) => {
  const req = e.data;
  if (req.type !== 'run') return;
  setLang(req.lang, false);
  run(req).then(
    (r) => {
      const transfer = [...Object.values(r.stems), r.rest].flatMap((p) => (p ? [p[0].buffer, p[1].buffer] : []));
      post({ id: req.id, ok: true, ...r }, transfer);
    },
    (err: unknown) => post({ id: req.id, ok: false, error: (err as Error)?.message || String(err), code: err instanceof SepError ? err.code : 'run' }),
  );
};
