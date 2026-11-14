// 試験用の偽の Google Drive（REST v3 のうち、このアプリが使う所だけ）。fetch の代わりに使う。
// アプリからは読み込まない（src/drive/*.test.ts だけ）。
import { createHash } from 'node:crypto';

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties?: Record<string, string>;
  description?: string;
  trashed?: boolean;
  content?: Uint8Array;
  modifiedTime: string;
}

const FOLDER = 'application/vnd.google-apps.folder';

export class FakeDrive {
  files = new Map<string, FakeFile>();
  token = 'good';
  calls: string[] = [];
  private seq = 0;
  private clock = Date.parse('2026-11-07T00:00:00Z');
  private sessions = new Map<string, { id?: string; meta: Record<string, unknown>; size: number }>();
  /** 変わったファイルの id（changes の印は、この並びの長さ） */
  changeLog: string[] = [];

  /** clock を渡すと、その時計で時刻を付ける（PC の時計と合わせる試験） */
  constructor(private readonly clockFn?: () => number) {}

  private now() {
    if (this.clockFn) return new Date(this.clockFn()).toISOString();
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private touch(id: string) {
    this.changeLog.push(id);
  }

  /** 自分か、上のフォルダのどれかがゴミ箱にある */
  inTrash(f: FakeFile): boolean {
    for (let x: FakeFile | undefined = f, n = 0; x && n < 64; n++) {
      if (x.trashed) return true;
      x = x.parents[0] ? this.files.get(x.parents[0]) : undefined;
    }
    return false;
  }

  private meta(f: FakeFile) {
    const out: Record<string, unknown> = { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, trashed: this.inTrash(f), parents: [...f.parents] };
    if (f.appProperties) out.appProperties = f.appProperties;
    if (f.description !== undefined) out.description = f.description;
    if (f.content) {
      out.size = String(f.content.length);
      out.md5Checksum = createHash('md5').update(f.content).digest('hex');
    }
    return out;
  }

  /** 別の端末が Drive のファイルを書き換えたことにする */
  setContent(id: string, content: Uint8Array, modifiedTime?: string) {
    const f = this.files.get(id)!;
    f.content = content;
    f.modifiedTime = modifiedTime ?? this.now();
    this.touch(id);
  }

  add(f: Partial<FakeFile> & { name: string; parents: string[] }): FakeFile {
    const file: FakeFile = { id: `f${++this.seq}`, mimeType: f.content ? 'application/octet-stream' : FOLDER, ...f, modifiedTime: f.modifiedTime ?? this.now() };
    this.files.set(file.id, file);
    this.touch(file.id);
    return file;
  }

  /** ゴミ箱に移す（別の PC が消したことにする） */
  trash(id: string) {
    this.files.get(id)!.trashed = true;
    this.touch(id);
  }

  /** パス（親の名前をたどる）→ ファイル */
  byPath(path: string): FakeFile | undefined {
    for (const f of this.files.values()) if (!this.inTrash(f) && this.pathOf(f) === path) return f;
    return undefined;
  }

  /** フォルダの中のファイルのパス（ゴミ箱の物は除く。試験で中身を見る） */
  tree(prefix: string): string[] {
    const out: string[] = [];
    for (const f of this.files.values()) {
      if (f.mimeType === FOLDER || this.inTrash(f)) continue;
      const p = this.pathOf(f);
      if (p.startsWith(`${prefix}/`)) out.push(p.slice(prefix.length + 1));
    }
    return out.sort();
  }

  text(path: string): string | undefined {
    const f = this.byPath(path);
    return f?.content ? new TextDecoder().decode(f.content) : undefined;
  }

  pathOf(f: FakeFile): string {
    const parts = [f.name];
    let p = f.parents[0] ? this.files.get(f.parents[0]) : undefined;
    while (p) {
      parts.unshift(p.name);
      p = p.parents[0] ? this.files.get(p.parents[0]) : undefined;
    }
    return parts.join('/');
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  private notFound() {
    return this.json({ error: { code: 404, message: 'File not found' } }, 404);
  }

  private query(q: string): FakeFile[] {
    let rest = q;
    const tests: ((f: FakeFile) => boolean)[] = [];
    const take = (re: RegExp, fn: (m: RegExpExecArray) => (f: FakeFile) => boolean) => {
      for (;;) {
        const m = re.exec(rest);
        if (!m) return;
        tests.push(fn(m));
        rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
      }
    };
    take(/'([^']+)' in parents/, (m) => (f) => f.parents.includes(m[1]));
    take(/appProperties has \{ key='(\w+)' and value='(\w+)' \}/, (m) => (f) => f.appProperties?.[m[1]] === m[2]);
    take(/mimeType = '([^']+)'/, (m) => (f) => f.mimeType === m[1]);
    take(/name = '([^']+)'/, (m) => (f) => f.name === m[1]);
    take(/trashed = false/, () => (f) => !this.inTrash(f));
    if (rest.replace(/\s|and/g, '')) throw new Error(`fake Drive: unknown query: ${q}`);
    return [...this.files.values()].filter((f) => tests.every((t) => t(f)));
  }

  private async bytes(body: unknown): Promise<Uint8Array> {
    if (body == null) return new Uint8Array(0);
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof Uint8Array) return body;
    throw new Error('fake Drive: unknown body type');
  }

  private multipart(raw: Uint8Array, contentType: string): { meta: Record<string, unknown>; content: Uint8Array } {
    const boundary = /boundary=(.+)$/.exec(contentType)![1];
    const text = new TextDecoder('latin1').decode(raw);
    const first = text.indexOf(`--${boundary}`);
    const metaStart = text.indexOf('\r\n\r\n', first) + 4;
    const metaEnd = text.indexOf(`\r\n--${boundary}`, metaStart);
    const meta = JSON.parse(new TextDecoder().decode(raw.slice(metaStart, metaEnd))) as Record<string, unknown>;
    const partHead = metaEnd + 2;
    const dataStart = text.indexOf('\r\n\r\n', partHead) + 4;
    const dataEnd = text.lastIndexOf(`\r\n--${boundary}--`);
    return { meta, content: raw.slice(dataStart, dataEnd) };
  }

  private write(id: string | undefined, meta: Record<string, unknown>, content: Uint8Array): FakeFile {
    const mt = typeof meta.modifiedTime === 'string' ? meta.modifiedTime : undefined;
    if (id) {
      const f = this.files.get(id);
      if (!f || f.trashed) throw new Error('404');
      f.content = content;
      f.modifiedTime = mt ?? this.now();
      if (meta.appProperties) f.appProperties = { ...f.appProperties, ...(meta.appProperties as Record<string, string>) };
      this.touch(f.id);
      return f;
    }
    return this.add({ name: String(meta.name), parents: (meta.parents as string[]) ?? [], content, mimeType: 'application/octet-stream', appProperties: meta.appProperties as Record<string, string> | undefined, modifiedTime: mt });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push(`${method} ${url.pathname}${url.searchParams.get('uploadType') ? `?${url.searchParams.get('uploadType')}` : ''}${url.searchParams.get('alt') ? '?media' : ''}`);
    // 再開できる送り方の送り先（upload_id 付き）は、ログインの印なしで送れる（Google と同じ）
    if (!url.searchParams.get('upload_id') && headers.Authorization !== `Bearer ${this.token}`) return this.json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
    const path = url.pathname;
    if (path === '/drive/v3/about') return this.json({ user: { emailAddress: 'tate@example.com', displayName: 'Tate' }, storageQuota: { limit: String(15 * 2 ** 30), usage: String(2 ** 30) } });
    if (path === '/drive/v3/changes/startPageToken') return this.json({ startPageToken: String(this.changeLog.length) });
    if (path === '/drive/v3/changes') {
      const from = Number(url.searchParams.get('pageToken'));
      const ids = [...new Set(this.changeLog.slice(from))];
      return this.json({ changes: ids.map((id) => ({ fileId: id, removed: !this.files.has(id), file: this.files.has(id) ? this.meta(this.files.get(id)!) : undefined })), newStartPageToken: String(this.changeLog.length) });
    }
    if (path === '/drive/v3/files' && method === 'GET') {
      const list = this.query(url.searchParams.get('q') ?? '');
      return this.json({ files: list.map((f) => this.meta(f)) });
    }
    if (path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(String(init.body)) as Record<string, unknown>;
      const f = this.add({ name: String(meta.name), parents: (meta.parents as string[]) ?? ['root'], mimeType: String(meta.mimeType), appProperties: meta.appProperties as Record<string, string> | undefined, description: meta.description as string | undefined });
      return this.json(this.meta(f));
    }
    let m = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(path);
    if (m && method === 'POST') {
      const src = this.files.get(decodeURIComponent(m[1]));
      if (!src) return this.notFound();
      const meta = JSON.parse(String(init.body)) as Record<string, unknown>;
      const f = this.add({ name: String(meta.name ?? src.name), parents: (meta.parents as string[]) ?? src.parents, mimeType: src.mimeType, content: src.content, appProperties: (meta.appProperties as Record<string, string> | undefined) ?? src.appProperties });
      return this.json(this.meta(f));
    }
    m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return this.notFound();
      if (method === 'GET' && url.searchParams.get('alt') === 'media') return new Response(f.content as Uint8Array<ArrayBuffer>, { status: 200 });
      if (method === 'GET') return this.json(this.meta(f));
      if (method === 'PATCH') {
        const meta = JSON.parse(String(init.body)) as Partial<FakeFile>;
        const add = url.searchParams.get('addParents');
        const rm = url.searchParams.get('removeParents');
        if (add || rm) f.parents = [...f.parents.filter((p) => !(rm ?? '').split(',').includes(p)), ...(add && !f.parents.includes(add) ? [add] : [])];
        const mt = meta.modifiedTime;
        // appProperties は Drive と同じく、キーごとに足す（null のキーは消す）
        if (meta.appProperties) meta.appProperties = Object.fromEntries(Object.entries({ ...f.appProperties, ...meta.appProperties }).filter(([, v]) => v !== null));
        Object.assign(f, meta);
        f.modifiedTime = mt ?? this.now();
        this.touch(f.id);
        return this.json(this.meta(f));
      }
    }
    m = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
    if (m) {
      const id = m[1] ? decodeURIComponent(m[1]) : undefined;
      const type = url.searchParams.get('uploadType');
      if (id && !this.files.get(id)) return this.notFound();
      if (type === 'multipart') {
        const { meta, content } = this.multipart(await this.bytes(init.body), headers['Content-Type']);
        return this.json(this.meta(this.write(id, meta, content)));
      }
      if (type === 'resumable' && url.searchParams.get('upload_id')) {
        const s = this.sessions.get(url.searchParams.get('upload_id')!);
        if (!s) return this.notFound();
        const content = await this.bytes(init.body);
        return this.json(this.meta(this.write(s.id, s.meta, content)));
      }
      if (type === 'resumable') {
        const sid = `u${++this.seq}`;
        this.sessions.set(sid, { id, meta: JSON.parse(String(init.body)) as Record<string, unknown>, size: Number(headers['X-Upload-Content-Length']) });
        return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } });
      }
    }
    throw new Error(`fake Drive: unknown call: ${method} ${url}`);
  };
}
