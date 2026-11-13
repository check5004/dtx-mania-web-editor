// Google Drive の読み書き（REST v3 を直に呼ぶ。ライブラリは使わない）。
// スコープは drive.file：このアプリが作ったフォルダ・ファイルだけが見える。
// 小さいファイル（5 MB まで）は1回で送り、大きい音声は再開できる送り方（resumable）で送る。
import { tr } from '../i18n';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,appProperties,description,trashed,parents';
const SMALL = 5 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
  description?: string;
  trashed?: boolean;
  parents?: string[];
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason = '',
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

/** ログインが切れた（取り直しが要る） */
export class DriveAuthError extends DriveError {
  constructor(message = tr('Google Drive のログインが切れました', 'Your Google Drive sign-in expired')) {
    super(message, 401, 'auth');
    this.name = 'DriveAuthError';
  }
}

let tokenOf: () => Promise<string> = async () => {
  throw new DriveAuthError();
};
let onAuthLost: () => void = () => {};

/** トークンの取り方と、切れたと分かったときの知らせ先（src/drive/auth.ts が決める） */
export function setDriveAuth(get: () => Promise<string>, lost: () => void) {
  tokenOf = get;
  onAuthLost = lost;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function errorOf(res: Response): Promise<DriveError> {
  let msg = `${res.status}`;
  let reason = '';
  try {
    const j = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    msg = j.error?.message ?? msg;
    reason = j.error?.errors?.[0]?.reason ?? '';
  } catch {
    // 本文が JSON でない
  }
  if (res.status === 401) {
    onAuthLost();
    return new DriveAuthError();
  }
  return new DriveError(msg, res.status, reason);
}

function retryable(status: number, reason: string) {
  return status === 429 || status >= 500 || (status === 403 && /rateLimit/i.test(reason));
}

/** Drive を呼ぶ。混んでいる・一時的な失敗は少し待ってやり直す */
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await tokenOf();
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (attempt < 3) {
        await wait(1000 * 2 ** attempt);
        continue;
      }
      throw new DriveError(tr(`Google Drive につながりません（${(e as Error).message}）`, `Can't reach Google Drive (${(e as Error).message})`), 0, 'network');
    }
    if (res.ok) return res;
    const err = await errorOf(res);
    if (attempt < 4 && retryable(err.status, err.reason)) {
      await wait(1000 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    throw err;
  }
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  return (await (await call(url, init)).json()) as T;
}

/** 検索の文字列の中の ' と \ を逃がす */
export function q(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function about(): Promise<{ email: string; name: string }> {
  const j = await json<{ user?: { emailAddress?: string; displayName?: string } }>(`${API}/about?fields=user(displayName,emailAddress)`);
  return { email: j.user?.emailAddress ?? '', name: j.user?.displayName ?? '' };
}

/** Drive の容量（limit が無ければ無制限）と使っている大きさ（バイト） */
export async function storageQuota(): Promise<{ limit: number | null; usage: number }> {
  const j = await json<{ storageQuota?: { limit?: string; usage?: string } }>(`${API}/about?fields=storageQuota(limit,usage)`);
  const limit = Number(j.storageQuota?.limit);
  return { limit: Number.isFinite(limit) && limit > 0 ? limit : null, usage: Number(j.storageQuota?.usage) || 0 };
}

/** 条件に合うファイル・フォルダを全部（ページをめくって） */
export async function listFiles(query: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let page = '';
  do {
    const p = new URLSearchParams({ q: query, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000', spaces: 'drive' });
    if (page) p.set('pageToken', page);
    const j = await json<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${p}`);
    out.push(...(j.files ?? []));
    page = j.nextPageToken ?? '';
  } while (page);
  return out;
}

export function listChildren(parentId: string): Promise<DriveFile[]> {
  return listFiles(`'${q(parentId)}' in parents and trashed = false`);
}

/** 1つのファイル・フォルダ。消えていれば null */
export async function getFile(id: string): Promise<DriveFile | null> {
  try {
    return await json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return null;
    throw e;
  }
}

export async function createFolder(name: string, parent: string | null, extra: { appProperties?: Record<string, string>; description?: string } = {}): Promise<DriveFile> {
  return json<DriveFile>(`${API}/files?fields=${FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}), ...extra }),
  });
}

export async function updateMeta(id: string, meta: Partial<Pick<DriveFile, 'name' | 'description' | 'appProperties' | 'modifiedTime'>>): Promise<DriveFile> {
  return json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(meta),
  });
}

export async function trashFile(id: string): Promise<void> {
  await call(`${API}/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ trashed: true }),
  });
}

/** Drive の中で写す（落とさずに。控えを作るとき） */
export async function copyFile(id: string, meta: { name: string; parents: string[]; appProperties?: Record<string, string> }): Promise<DriveFile> {
  return json<DriveFile>(`${API}/files/${encodeURIComponent(id)}/copy?fields=${FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(meta),
  });
}

/** 別のフォルダへ動かす（名前も変えられる） */
export async function moveFile(id: string, to: string, from: readonly string[], name?: string): Promise<DriveFile> {
  const p = new URLSearchParams({ addParents: to, fields: FIELDS });
  const rm = from.filter((x) => x !== to);
  if (rm.length) p.set('removeParents', rm.join(','));
  return json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?${p}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(name ? { name } : {}),
  });
}

// ---- 変わった物だけを聞く（changes） ----------------------------------------------------

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

/** 今からの変化を聞くための印 */
export async function startPageToken(): Promise<string> {
  const j = await json<{ startPageToken?: string }>(`${API}/changes/startPageToken`);
  if (!j.startPageToken) throw new DriveError('no startPageToken', 0);
  return j.startPageToken;
}

/** 印のあとに変わったファイル（このアプリが見られる物だけ）と、次の印 */
export async function listChanges(token: string): Promise<{ changes: DriveChange[]; next: string }> {
  const changes: DriveChange[] = [];
  let page = token;
  for (;;) {
    const p = new URLSearchParams({ pageToken: page, pageSize: '1000', spaces: 'drive', includeRemoved: 'true', fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))` });
    const j = await json<{ changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(`${API}/changes?${p}`);
    changes.push(...(j.changes ?? []));
    if (j.newStartPageToken) return { changes, next: j.newStartPageToken };
    if (!j.nextPageToken) return { changes, next: page };
    page = j.nextPageToken;
  }
}

export function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const t: Record<string, string> = {
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    opus: 'audio/ogg',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    bmp: 'image/bmp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    avi: 'video/x-msvideo',
    json: 'application/json',
    txt: 'text/plain',
  };
  return t[ext] ?? 'application/octet-stream';
}

export interface UploadOpts {
  /** 上書きするファイル（無ければ新しく作る） */
  id?: string;
  name: string;
  /** 新しく作るときの置き場所 */
  parent?: string;
  data: Blob;
  appProperties?: Record<string, string>;
  /** Drive に書く更新時刻（この PC でファイルを直した時刻。PC どうしでどちらが新しいかを比べる） */
  modifiedTime?: string;
  /** 送ったバイト数（このファイルの中で） */
  onProgress?: (sent: number) => void;
}

/** ファイルを送る（新しく作る・上書きする）。送った後の md5Checksum などを返す */
export async function upload(o: UploadOpts): Promise<DriveFile> {
  const meta: Record<string, unknown> = o.id ? {} : { name: o.name, ...(o.parent ? { parents: [o.parent] } : {}) };
  if (o.appProperties) meta.appProperties = o.appProperties;
  if (o.modifiedTime) meta.modifiedTime = o.modifiedTime;
  const mime = mimeOf(o.name);
  if (o.data.size <= SMALL) {
    const boundary = `dtxe${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      o.data,
      `\r\n--${boundary}--`,
    ]);
    const url = o.id ? `${UPLOAD}/files/${encodeURIComponent(o.id)}?uploadType=multipart&fields=${FIELDS}` : `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`;
    const f = await json<DriveFile>(url, { method: o.id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    o.onProgress?.(o.data.size);
    return f;
  }
  return uploadResumable(o, meta, mime);
}

interface XhrResult {
  status: number;
  text: string;
  header: (name: string) => string | null;
}

/** 送った量が分かるように XMLHttpRequest で送る */
function xhr(method: string, url: string, body: Blob | null, headers: Record<string, string>, onProgress?: (sent: number) => void): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onProgress) x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => resolve({ status: x.status, text: x.responseText, header: (n) => x.getResponseHeader(n) });
    x.onerror = () => reject(new DriveError(tr('Google Drive への送信が途中で切れました', 'The upload to Google Drive was cut off'), 0, 'network'));
    x.onabort = () => reject(new DriveError(tr('送信をやめました', 'Upload stopped'), 0, 'abort'));
    x.send(body);
  });
}

/** 送り終えた位置（308 の Range: bytes=0-N から N+1） */
function rangeEnd(r: XhrResult): number {
  const m = /bytes=0-(\d+)/.exec(r.header('Range') ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

async function uploadResumable(o: UploadOpts, meta: Record<string, unknown>, mime: string): Promise<DriveFile> {
  const size = o.data.size;
  const start = async () => {
    const url = o.id ? `${UPLOAD}/files/${encodeURIComponent(o.id)}?uploadType=resumable&fields=${FIELDS}` : `${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`;
    const res = await call(url, {
      method: o.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify(meta),
    });
    const loc = res.headers.get('Location');
    if (!loc) throw new DriveError(tr('Google Drive が送り先を返しませんでした', 'Google Drive did not return an upload address'), res.status);
    return loc;
  };
  let session = await start();
  let offset = 0;
  let restarts = 0;
  for (let attempt = 0; ; attempt++) {
    let r: XhrResult | null = null;
    try {
      const headers: Record<string, string> = {};
      if (offset > 0) headers['Content-Range'] = `bytes ${offset}-${size - 1}/${size}`;
      const base = offset;
      r = await xhr('PUT', session, o.data.slice(offset), headers, (n) => o.onProgress?.(base + n));
    } catch (e) {
      if ((e as DriveError).reason === 'abort' || attempt >= 6) throw e;
    }
    if (r && (r.status === 200 || r.status === 201)) {
      o.onProgress?.(size);
      return JSON.parse(r.text) as DriveFile;
    }
    if (r && (r.status === 404 || r.status === 410)) {
      // 送り先が切れた：最初から
      if (restarts++ >= 2) throw new DriveError(tr('Google Drive への送信をやり直せませんでした', "Couldn't restart the upload to Google Drive"), r.status);
      session = await start();
      offset = 0;
      continue;
    }
    if (r && r.status === 401) {
      onAuthLost();
      throw new DriveAuthError();
    }
    if (r && r.status !== 308 && !(r.status >= 500 || r.status === 429)) {
      let msg = String(r.status);
      try {
        msg = (JSON.parse(r.text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        // 本文が JSON でない
      }
      throw new DriveError(msg, r.status);
    }
    if (attempt >= 6) throw new DriveError(tr('Google Drive への送信が終わりませんでした', "The upload to Google Drive didn't finish"), r?.status ?? 0);
    await wait(1000 * 2 ** Math.min(attempt, 4));
    // どこまで届いたかを聞いて、続きから送る
    try {
      const st = await xhr('PUT', session, null, { 'Content-Range': `bytes */${size}` });
      if (st.status === 200 || st.status === 201) return JSON.parse(st.text) as DriveFile;
      if (st.status === 308) offset = rangeEnd(st);
      else if (st.status === 404 || st.status === 410) {
        session = await start();
        offset = 0;
      }
    } catch {
      // まだつながらない：もう一度待つ
    }
  }
}

/** ファイルの中身を取る（送られてきた量を知らせる） */
export async function download(id: string, onProgress?: (got: number) => void): Promise<Blob> {
  const res = await call(`${API}/files/${encodeURIComponent(id)}?alt=media`);
  if (!onProgress || !res.body) return res.blob();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got);
  }
  return new Blob(parts as Uint8Array<ArrayBuffer>[]);
}

export async function downloadText(id: string): Promise<string> {
  return (await call(`${API}/files/${encodeURIComponent(id)}?alt=media`)).text();
}
