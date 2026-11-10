// 本体（このブラウザの保存領域 = Origin Private File System）の読み書きの下回り。
// 曲は songs/<id>/ に、曲フォルダと同じ並び（DTX・set.def・音・stems/・画像・作業ファイル）で置く。
// - 書き込みは createWritable（Chrome・Edge・Firefox・Safari 26 から）。無いブラウザ（Safari 25 まで）はワーカーの
//   createSyncAccessHandle で書く（opfsWorker.ts）
// - 同じファイルを同時に書くと Safari は断るので、書き込みは1つずつ順に行う
import type { OpfsWriteRequest, OpfsWriteResponse } from './opfsWorker';

export function opfsApi(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

let checked: Promise<boolean> | null = null;
let ready = false;

/** 本体が使えるかを確かめる（プライベートブラウズ・古いブラウザでは使えない）。一度だけ確かめて覚える */
export function checkOpfs(): Promise<boolean> {
  checked ??= (async () => {
    if (!opfsApi()) return false;
    try {
      await songsRoot();
      ready = true;
    } catch {
      ready = false;
    }
    return ready;
  })();
  return checked;
}

/** 本体が使えると確かめられたか（確かめる前は false） */
export function opfsReady(): boolean {
  return ready;
}

export async function songsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('songs', { create: true });
}

export async function songDir(id: string, create = false): Promise<FileSystemDirectoryHandle> {
  return (await songsRoot()).getDirectoryHandle(id, { create });
}

/** パスを OPFS の名前の並びにする（'.'・'..'・空は捨てる） */
export function pathSegs(rel: string): string[] {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
}

// ---- 書き込み -------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

let worker: Worker | null = null;
let workerSeq = 0;
const waits = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

function opfsWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./opfsWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<OpfsWriteResponse>) => {
    const r = e.data;
    const wait = waits.get(r.id);
    if (!wait) return;
    waits.delete(r.id);
    if (r.ok) wait.resolve();
    else wait.reject(Object.assign(new Error(r.message), { name: r.name }));
  };
  w.onerror = (e) => {
    for (const wait of waits.values()) wait.reject(new Error(e.message || 'OPFS worker error'));
    waits.clear();
    worker = null;
  };
  worker = w;
  return w;
}

function writeViaWorker(path: string[], data: Blob | Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = ++workerSeq;
    waits.set(id, { resolve, reject });
    opfsWorker().postMessage({ id, path, data } satisfies OpfsWriteRequest);
  });
}

/** 試験用: localStorage の dtxe.opfs.worker = '1' ならいつもワーカーで書く（古い Safari の書き方を Chrome で確かめる） */
function forceWorker(): boolean {
  try {
    return localStorage.getItem('dtxe.opfs.worker') === '1';
  } catch {
    return false;
  }
}

type Writable = { write(d: Blob | BufferSource): Promise<void>; close(): Promise<void>; abort(): Promise<void> };

async function writeHandle(fh: FileSystemFileHandle, data: Blob | Uint8Array): Promise<boolean> {
  const cw = (fh as FileSystemFileHandle & { createWritable?: () => Promise<Writable> }).createWritable;
  if (typeof cw !== 'function' || forceWorker()) return false;
  let w: Writable;
  try {
    w = await cw.call(fh);
  } catch (e) {
    // 作れない（このブラウザでは使えない）→ ワーカーで書く。容量が足りないのは書き方を変えても同じ
    if ((e as Error)?.name === 'QuotaExceededError') throw e;
    return false;
  }
  try {
    await w.write(data as Blob);
    await w.close();
  } catch (e) {
    try {
      await w.abort();
    } catch {
      // 閉じられなくても元の失敗を返す
    }
    throw e;
  }
  return true;
}

/** 本体の曲 id のフォルダに rel のファイルを書く（中のフォルダは作る）。書いたファイルの handle を返す */
export function writeSongFile(id: string, rel: string, data: Blob | Uint8Array): Promise<FileSystemFileHandle> {
  return serial(async () => {
    const segs = pathSegs(rel);
    const name = segs.pop();
    if (!name) throw new Error(`bad path: ${rel}`);
    let dir = await songDir(id, true);
    for (const p of segs) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    if (!(await writeHandle(fh, data))) await writeViaWorker(['songs', id, ...segs, name], data);
    return fh;
  });
}

/** 本体の曲のファイルを1つ消す（ファイルの名前を変えたあとの、前の名前。無ければ何もしない） */
export function removeSongFile(id: string, rel: string): Promise<void> {
  return serial(async () => {
    const segs = pathSegs(rel);
    const name = segs.pop();
    if (!name) return;
    let dir = await songDir(id);
    for (const p of segs) dir = await dir.getDirectoryHandle(p);
    try {
      await dir.removeEntry(name);
    } catch (e) {
      if ((e as Error)?.name !== 'NotFoundError') throw e;
    }
  });
}

/** 本体の曲のフォルダを中身ごと消す（無ければ何もしない） */
export function removeSongDir(id: string): Promise<void> {
  return serial(async () => {
    try {
      await (await songsRoot()).removeEntry(id, { recursive: true });
    } catch (e) {
      if ((e as Error)?.name !== 'NotFoundError') throw e;
    }
  });
}

/** 本体にある曲のフォルダの名前（id） */
export async function listSongDirs(): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const [name, h] of (await songsRoot()).entries()) if (h.kind === 'directory') out.push(name);
  } catch {
    // 使えない
  }
  return out;
}

/** 容量が足りなくて書けなかったか */
export function isQuotaError(e: unknown): boolean {
  const n = (e as Error)?.name;
  return n === 'QuotaExceededError' || /quota/i.test(String((e as Error)?.message ?? ''));
}
