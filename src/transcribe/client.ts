// ドラムの採譜の窓口。音をモデルの入力（44.1kHz・モノラル）にそろえ、ワーカーで動かし、結果を覚えておく。
// 同じ音（key）は二度解析しない：この画面の間はメモリに、次に開いたときのためにブラウザ（IndexedDB）に置く。
import { tr, getLang } from '../i18n';
import { ADTOF, type DrumActivations } from './model';
import type { TranscribeMessage, TranscribeRequest } from './worker';

export type TranscribeStage = 'prepare' | 'model' | 'run';

export interface TranscribeOptions {
  /** 同じ音を覚えておくためのキー（省くと覚えない） */
  key?: string;
  onProgress?: (stage: TranscribeStage, p: number) => void;
}

// ---- 入力をそろえる ---------------------------------------------------------------------

/** ステレオなら左右の平均（モデルの学習と同じ）、44.1kHz でなければ作り直す */
export async function toModelInput(channels: readonly Float32Array[], sr: number): Promise<Float32Array> {
  const n = channels[0]?.length ?? 0;
  if (sr === ADTOF.sr) {
    if (channels.length === 1) return channels[0].slice();
    const out = new Float32Array(n);
    const k = 1 / channels.length;
    for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
    return out;
  }
  // ブラウザの変換（質がよく速い）でモノラル 44.1kHz にする
  const len = Math.max(1, Math.ceil((n * ADTOF.sr) / sr));
  const ctx = new OfflineAudioContext(1, len, ADTOF.sr);
  const buf = ctx.createBuffer(channels.length, Math.max(1, n), sr);
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const r = await ctx.startRendering();
  return r.getChannelData(0).slice();
}

// ---- ワーカー -------------------------------------------------------------------------

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: { act: Float32Array; frames: number; backend: string }) => void; reject: (e: Error) => void; progress?: (stage: TranscribeStage, p: number) => void }>();

function getWorker(): Worker {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<TranscribeMessage>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if ('stage' in m) {
      p.progress?.(m.stage, m.progress);
      return;
    }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
    scheduleIdle();
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || tr('採譜の処理が止まりました', 'Drum detection stopped')));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** 使い終わったらしばらくしてワーカーを閉じる（モデルの計算に使ったメモリを返す） */
function scheduleIdle() {
  if (pending.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size > 0) return;
    worker?.terminate();
    worker = null;
  }, 30_000);
}

function runWorker(audio: Float32Array, progress?: (stage: TranscribeStage, p: number) => void) {
  const w = getWorker();
  const id = nextId++;
  return new Promise<{ act: Float32Array; frames: number; backend: string }>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress });
    const msg: TranscribeRequest = { id, type: 'run', audio, lang: getLang() };
    w.postMessage(msg, [audio.buffer]);
  });
}

// ---- 覚えておく ----------------------------------------------------------------------

const memory = new Map<string, DrumActivations>();
const MEMORY_MAX = 4;

const DB = 'dtxe-transcribe';
const STORE = 'acts';
const DB_MAX = 40;

interface Row {
  key: string;
  model: string;
  fps: number;
  frames: number;
  act: ArrayBuffer;
  at: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const rowKey = (key: string) => `${ADTOF.id}|${key}`;

async function dbGet(key: string): Promise<DrumActivations | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const row = await new Promise<Row | undefined>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(rowKey(key));
      req.onsuccess = () => resolve(req.result as Row | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!row || row.model !== ADTOF.id) return null;
    return { model: row.model, fps: row.fps, frames: row.frames, act: new Float32Array(row.act) };
  } finally {
    db.close();
  }
}

async function dbPut(key: string, d: DrumActivations) {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const row: Row = { key: rowKey(key), model: d.model, fps: d.fps, frames: d.frames, act: d.act.slice().buffer, at: Date.now() };
      st.put(row);
      // 古いものから捨てる
      const all = st.getAll();
      all.onsuccess = () => {
        const rows = (all.result as Row[]).sort((a, b) => b.at - a.at);
        for (const r of rows.slice(DB_MAX)) st.delete(r.key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

function remember(key: string, d: DrumActivations) {
  memory.delete(key);
  memory.set(key, d);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
}

/** 覚えている結果（無ければ null）。IndexedDB も見る */
export async function cachedTranscript(key: string): Promise<DrumActivations | null> {
  const m = memory.get(key);
  if (m) return m;
  const d = await dbGet(key).catch(() => null);
  if (d) remember(key, d);
  return d;
}

const running = new Map<string, Promise<DrumActivations>>();

/** 音（[左, 右] かモノラル）をドラムの採譜にかける */
export async function transcribe(channels: readonly Float32Array[], sr: number, opts: TranscribeOptions = {}): Promise<DrumActivations> {
  const key = opts.key;
  if (key) {
    const hit = await cachedTranscript(key);
    if (hit) return hit;
    const r = running.get(key);
    if (r) return r;
  }
  const job = (async () => {
    opts.onProgress?.('prepare', 0);
    const audio = await toModelInput(channels, sr);
    const r = await runWorker(audio, opts.onProgress);
    const d: DrumActivations = { model: ADTOF.id, fps: ADTOF.fps, frames: r.frames, act: r.act };
    if (key) {
      remember(key, d);
      void dbPut(key, d).catch(() => undefined);
    }
    return d;
  })();
  if (key) {
    running.set(key, job);
    job.finally(() => running.delete(key)).catch(() => undefined);
  }
  return job;
}
