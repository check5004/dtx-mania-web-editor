// 本体（OPFS）への書き込みの予備。createWritable が無いブラウザ（iPadOS・Safari 25 まで）は、
// ワーカーの createSyncAccessHandle でしか書けないので、ここで書く。
// Safari 16.3 までは同期のはずのメソッドが Promise を返すので、どれも await する。

interface SyncHandle {
  truncate(size: number): number | Promise<number> | void;
  write(buf: Uint8Array, opts: { at: number }): number | Promise<number>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface OpfsWriteRequest {
  id: number;
  /** OPFS の一番上からのパス（最後がファイル名） */
  path: string[];
  data: Blob | Uint8Array;
}

export type OpfsWriteResponse = { id: number; ok: true } | { id: number; ok: false; name: string; message: string };

const CHUNK = 8 << 20;

async function writeOne(path: string[], data: Blob | Uint8Array) {
  let dir = await navigator.storage.getDirectory();
  for (const p of path.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(path[path.length - 1], { create: true });
  const h = (await (fh as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()) as SyncHandle;
  try {
    await h.truncate(0);
    const size = data instanceof Blob ? data.size : data.byteLength;
    for (let at = 0; at < size; at += CHUNK) {
      const chunk = data instanceof Blob ? new Uint8Array(await data.slice(at, at + CHUNK).arrayBuffer()) : data.subarray(at, at + CHUNK);
      let off = 0;
      while (off < chunk.length) {
        const n = await h.write(chunk.subarray(off), { at: at + off });
        off += typeof n === 'number' && n > 0 ? n : chunk.length - off;
      }
    }
    await h.flush();
  } finally {
    await h.close();
  }
}

self.onmessage = async (e: MessageEvent<OpfsWriteRequest>) => {
  const { id, path, data } = e.data;
  try {
    await writeOne(path, data);
    (self as unknown as Worker).postMessage({ id, ok: true } satisfies OpfsWriteResponse);
  } catch (err) {
    const x = err as Error;
    (self as unknown as Worker).postMessage({ id, ok: false, name: x?.name ?? 'Error', message: String(x?.message ?? err) } satisfies OpfsWriteResponse);
  }
};
