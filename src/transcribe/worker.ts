// ドラムの採譜（ADTOF）を別スレッドで動かす。ONNX Runtime Web（WASM）でモデルを動かし、1/100 秒ごとの出力を返す。
// GitHub Pages では SharedArrayBuffer が使えないので 1 スレッドで動く（4分の曲で十数秒）。
import { tr, setLang, type Lang } from '../i18n';
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { ADTOF } from './model';

/** lang: エラーの文の言語（ワーカーは画面の言語を知らないので渡す） */
export type TranscribeRequest = { id: number; type: 'run'; audio: Float32Array; lang: Lang };

export type TranscribeMessage =
  | { id: number; stage: 'model' | 'prepare' | 'run'; progress: number }
  | { id: number; ok: true; result: { act: Float32Array; frames: number; backend: string } }
  | { id: number; ok: false; error: string };

ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
ort.env.logLevel = 'error';

const post = (msg: TranscribeMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

const CACHE = 'dtxe-models-v1';

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** モデルを読む（一度読んだらブラウザに覚えておく） */
async function modelBytes(progress: (p: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = 'caches' in self ? await caches.open(CACHE) : null;
  } catch {
    cache = null;
  }
  const hit = cache ? await cache.match(ADTOF.url).catch(() => undefined) : undefined;
  if (hit) {
    const buf = await hit.arrayBuffer();
    if (buf.byteLength === ADTOF.bytes) return buf;
  }
  let res: Response;
  try {
    res = await fetch(ADTOF.url, { mode: 'cors' });
  } catch {
    throw new Error(tr('採譜のモデルを読み込めませんでした（インターネットにつながっているか確かめてください）', "Couldn't download the drum detection model (check your internet connection)"));
  }
  if (!res.ok || !res.body) throw new Error(tr(`採譜のモデルを読み込めませんでした（${res.status}）`, `Couldn't download the drum detection model (${res.status})`));
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    progress(Math.min(1, got / ADTOF.bytes));
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  if (crypto?.subtle) {
    const h = hex(await crypto.subtle.digest('SHA-256', buf));
    if (h !== ADTOF.sha256) throw new Error(tr('採譜のモデルの中身が想定と違います（読み込み直してください）', "The drum detection model's contents don't match (try downloading it again)"));
  }
  try {
    await cache?.put(ADTOF.url, new Response(buf.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    // 覚えられなくても、今回は使える
  }
  return buf.buffer;
}

let session: Promise<ort.InferenceSession> | null = null;

function getSession(progress: (stage: 'model' | 'prepare', p: number) => void): Promise<ort.InferenceSession> {
  if (!session) {
    session = (async () => {
      const bytes = await modelBytes((p) => progress('model', p));
      // 初回はここで ONNX Runtime の本体（約4MB）も読み込む
      progress('prepare', 0);
      return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    session.catch(() => {
      session = null;
    });
  }
  return session;
}

/** 一度に流すフレーム数と、前後に足す文脈（双方向 GRU が前後 10 秒以上を見るため。区切らずに流したときとの差は 0.01 程度） */
const CHUNK = 4000;
const CONTEXT = 1500;

async function run(id: number, audio: Float32Array) {
  const s = await getSession((stage, p) => post({ id, stage, progress: p }));
  const hop = ADTOF.hop;
  const nCls = ADTOF.classes.length;
  const frames = Math.ceil(audio.length / hop);
  const act = new Float32Array(frames * nCls);
  for (let a = 0; a < frames; a += CHUNK) {
    const b = Math.min(frames, a + CHUNK);
    const s0 = Math.max(0, a - CONTEXT);
    const s1 = Math.min(frames, b + CONTEXT);
    const seg = audio.slice(s0 * hop, Math.min(audio.length, s1 * hop));
    const out = await s.run({ waveform: new ort.Tensor('float32', seg, [1, seg.length]) });
    const y = out.activations.data as Float32Array;
    const off = a - s0;
    act.set(y.subarray(off * nCls, (off + (b - a)) * nCls), a * nCls);
    for (const t of Object.values(out)) t.dispose?.();
    post({ id, stage: 'run', progress: b / frames });
  }
  return { act, frames };
}

self.onmessage = (e: MessageEvent<TranscribeRequest>) => {
  const req = e.data;
  if (req.type !== 'run') return;
  setLang(req.lang, false);
  run(req.id, req.audio).then(
    (r) => post({ id: req.id, ok: true, result: { ...r, backend: `wasm×${ort.env.wasm.numThreads}` } }, [r.act.buffer]),
    (err: unknown) => post({ id: req.id, ok: false, error: (err as Error)?.message || String(err) }),
  );
};
