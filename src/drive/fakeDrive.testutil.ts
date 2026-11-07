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

  private now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private meta(f: FakeFile) {
    const out: Record<string, unknown> = { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, trashed: !!f.trashed };
    if (f.appProperties) out.appProperties = f.appProperties;
    if (f.description !== undefined) out.description = f.description;
    if (f.content) {
      out.size = String(f.content.length);
      out.md5Checksum = createHash('md5').update(f.content).digest('hex');
    }
    return out;
  }

  /** 別の端末が Drive のファイルを書き換えたことにする */
  setContent(id: string, content: Uint8Array) {
    const f = this.files.get(id)!;
    f.content = content;
    f.modifiedTime = this.now();
  }

  add(f: Partial<FakeFile> & { name: string; parents: string[] }): FakeFile {
    const file: FakeFile = { id: `f${++this.seq}`, mimeType: f.content ? 'application/octet-stream' : FOLDER, modifiedTime: this.now(), ...f };
    this.files.set(file.id, file);
    return file;
  }

  /** パス（親の名前をたどる）→ ファイル */
  byPath(path: string): FakeFile | undefined {
    for (const f of this.files.values()) if (!f.trashed && this.pathOf(f) === path) return f;
    return undefined;
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
    const all = [...this.files.values()];
    let m = /^'([^']+)' in parents and trashed = false$/.exec(q);
    if (m) return all.filter((f) => f.parents.includes(m![1]) && !f.trashed);
    m = /^appProperties has \{ key='(\w+)' and value='(\w+)' \} and mimeType = '([^']+)' and trashed = false$/.exec(q);
    if (m) return all.filter((f) => f.appProperties?.[m![1]] === m![2] && f.mimeType === m![3] && !f.trashed);
    throw new Error(`fake Drive: unknown query: ${q}`);
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
    if (id) {
      const f = this.files.get(id);
      if (!f || f.trashed) throw new Error('404');
      f.content = content;
      f.modifiedTime = this.now();
      if (meta.appProperties) f.appProperties = meta.appProperties as Record<string, string>;
      return f;
    }
    return this.add({ name: String(meta.name), parents: (meta.parents as string[]) ?? [], content, mimeType: 'application/octet-stream', appProperties: meta.appProperties as Record<string, string> | undefined });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push(`${method} ${url.pathname}${url.searchParams.get('uploadType') ? `?${url.searchParams.get('uploadType')}` : ''}${url.searchParams.get('alt') ? '?media' : ''}`);
    // 再開できる送り方の送り先（upload_id 付き）は、ログインの印なしで送れる（Google と同じ）
    if (!url.searchParams.get('upload_id') && headers.Authorization !== `Bearer ${this.token}`) return this.json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
    const path = url.pathname;
    if (path === '/drive/v3/about') return this.json({ user: { emailAddress: 'tate@example.com', displayName: 'Tate' } });
    if (path === '/drive/v3/files' && method === 'GET') {
      const list = this.query(url.searchParams.get('q') ?? '');
      return this.json({ files: list.map((f) => this.meta(f)) });
    }
    if (path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(String(init.body)) as Record<string, unknown>;
      const f = this.add({ name: String(meta.name), parents: (meta.parents as string[]) ?? ['root'], mimeType: String(meta.mimeType), appProperties: meta.appProperties as Record<string, string> | undefined, description: meta.description as string | undefined });
      return this.json(this.meta(f));
    }
    let m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return this.notFound();
      if (method === 'GET' && url.searchParams.get('alt') === 'media') return new Response(f.content as Uint8Array<ArrayBuffer>, { status: 200 });
      if (method === 'GET') return this.json(this.meta(f));
      if (method === 'PATCH') {
        const meta = JSON.parse(String(init.body)) as Partial<FakeFile>;
        Object.assign(f, meta);
        f.modifiedTime = this.now();
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
