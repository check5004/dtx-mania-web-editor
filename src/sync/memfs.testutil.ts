// 試験用の、メモリの中のフォルダ（File System Access API のうち、このアプリが使う所だけ）。
// 2 台の PC の DTXMania のフォルダを作って、PC どうしの同期を通しで確かめる。アプリからは読み込まない。

let clock = Date.parse('2026-11-13T09:00:00Z');

/** 時計を進める（ファイルの更新時刻） */
export function tick(ms = 60_000): number {
  clock += ms;
  return clock;
}

export function now(): number {
  return clock;
}

interface Node {
  data: Uint8Array;
  mtime: number;
}

function bytesOf(d: unknown): Promise<Uint8Array> | Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (d instanceof Blob) return d.arrayBuffer().then((b) => new Uint8Array(b));
  if (typeof d === 'string') return new TextEncoder().encode(d);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  throw new Error('memfs: unknown data');
}

const err = (name: string, msg = name) => Object.assign(new Error(msg), { name });

export class MemFileHandle {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    readonly parent: MemDirHandle,
  ) {}

  async getFile(): Promise<File> {
    const n = this.parent.files.get(this.name);
    if (!n) throw err('NotFoundError');
    return new File([n.data as Uint8Array<ArrayBuffer>], this.name, { lastModified: n.mtime });
  }

  async createWritable() {
    const parts: Uint8Array[] = [];
    return {
      write: async (d: unknown) => {
        parts.push(await bytesOf(d));
      },
      close: async () => {
        if (this.parent.locked.has(this.name.toLowerCase())) throw err('NoModificationAllowedError', 'locked by another program');
        const len = parts.reduce((a, p) => a + p.length, 0);
        const all = new Uint8Array(len);
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.length;
        }
        this.parent.files.set(this.name, { data: all, mtime: tick(1000) });
      },
    };
  }

  async isSameEntry(o: unknown): Promise<boolean> {
    return o instanceof MemFileHandle && o.parent === this.parent && o.name === this.name;
  }
}

export class MemDirHandle {
  readonly kind = 'directory' as const;
  files = new Map<string, Node>();
  dirs = new Map<string, MemDirHandle>();
  /** DTXMania が開いていて書けないファイル（小文字の名前） */
  locked = new Set<string>();

  constructor(readonly name: string) {}

  async *entries(): AsyncGenerator<[string, MemFileHandle | MemDirHandle]> {
    for (const name of [...this.files.keys()]) yield [name, new MemFileHandle(name, this)];
    for (const [name, d] of [...this.dirs]) yield [name, d];
  }

  async getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<MemDirHandle> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!o.create) throw err('NotFoundError');
      d = new MemDirHandle(name);
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, o: { create?: boolean } = {}): Promise<MemFileHandle> {
    if (!this.files.has(name)) {
      if (!o.create) throw err('NotFoundError');
      this.files.set(name, { data: new Uint8Array(0), mtime: tick(1000) });
    }
    return new MemFileHandle(name, this);
  }

  async removeEntry(name: string, o: { recursive?: boolean } = {}): Promise<void> {
    if (this.files.has(name)) {
      if (this.locked.has(name.toLowerCase())) throw err('NoModificationAllowedError');
      this.files.delete(name);
      return;
    }
    const d = this.dirs.get(name);
    if (!d) throw err('NotFoundError');
    if ((d.files.size || d.dirs.size) && !o.recursive) throw err('InvalidModificationError');
    this.dirs.delete(name);
  }

  async isSameEntry(o: unknown): Promise<boolean> {
    return o === this;
  }

  async resolve(child: MemDirHandle | MemFileHandle): Promise<string[] | null> {
    const walk = (d: MemDirHandle, path: string[]): string[] | null => {
      if (child instanceof MemDirHandle && d === child) return path;
      if (child instanceof MemFileHandle && child.parent === d) return [...path, child.name];
      for (const [n, s] of d.dirs) {
        const r = walk(s, [...path, n]);
        if (r) return r;
      }
      return null;
    };
    return walk(this, []);
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }

  // ---- 試験から使う ----

  /** パスのフォルダ（作る） */
  dirAt(path: string): MemDirHandle {
    let d: MemDirHandle = this;
    for (const p of path.split('/').filter(Boolean)) {
      let n = d.dirs.get(p);
      if (!n) {
        n = new MemDirHandle(p);
        d.dirs.set(p, n);
      }
      d = n;
    }
    return d;
  }

  /** ファイルを置く（時計を進める） */
  put(path: string, text: string | Uint8Array, mtime = tick(1000)): void {
    const parts = path.split('/');
    const name = parts.pop()!;
    this.dirAt(parts.join('/')).files.set(name, { data: typeof text === 'string' ? new TextEncoder().encode(text) : text, mtime });
  }

  read(path: string): string | undefined {
    const parts = path.split('/');
    const name = parts.pop()!;
    let d: MemDirHandle | undefined = this;
    for (const p of parts) d = d?.dirs.get(p);
    const n = d?.files.get(name);
    return n ? new TextDecoder().decode(n.data) : undefined;
  }

  has(path: string): boolean {
    return this.read(path) !== undefined;
  }

  remove(path: string): void {
    const parts = path.split('/');
    const name = parts.pop()!;
    let d: MemDirHandle | undefined = this;
    for (const p of parts) d = d?.dirs.get(p);
    d?.files.delete(name);
    d?.dirs.delete(name);
  }

  /** 中のファイルのパス（並べて） */
  list(prefix = ''): string[] {
    const out: string[] = [];
    const walk = (d: MemDirHandle, p: string) => {
      for (const n of d.files.keys()) out.push(p ? `${p}/${n}` : n);
      for (const [n, s] of d.dirs) walk(s, p ? `${p}/${n}` : n);
    };
    walk(prefix ? this.dirAt(prefix) : this, '');
    return out.sort();
  }
}
