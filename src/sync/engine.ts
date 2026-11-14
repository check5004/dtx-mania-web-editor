// PC どうしの同期の本体：DTXMania の曲のフォルダと、Google Drive の「DTX Web Editor/DTXFiles/<BOX>/<曲>」を合わせる。
// 1. Drive の曲の一覧（印 dtxe=song の付いたフォルダ。BOX のフォルダは dtxe=dir）と、この PC の曲（DTXMania の曲の一覧）を比べて組にする
//    （前に合わせた曲は .dtxe-drive.json の id で、初めてなら DTXFiles からの並びで。並びが違って曲名とアーティストが同じなら聞く）
// 2. 曲ごとに、ファイルを 3 つ（前に合わせたとき・この PC・Drive）で比べて決め（src/sync/plan.ts）、送る・取る・まとめる
// 3. 前から変わった物だけ見る：Drive は changes で変わった曲だけ中を読み直し、この PC は大きさと更新時刻で見る（MD5 は要るときだけ）
// 書くのは曲のフォルダの中と、Drive の「DTX Web Editor」の中だけ。消すのは前のままのファイルだけ（Drive はゴミ箱へ）。
// 画面・いつ動かすかは src/sync/store.ts、決まりは docs/drive.md。
import { tr } from '../i18n';
import { copyFile, createFolder, download, DriveError, FOLDER_MIME, getFile, listChanges, listChildren, listFiles, moveFile, q, startPageToken, trashFile, updateMeta, upload, type DriveFile } from '../drive/api';
import { md5Blob } from '../drive/md5';
import { appRoot, LINK_FILE, listTree, newLink, parseLink, syncedPath, SONG_QUERY, type DriveLink, type DriveTree, type SongInfo } from '../drive/sync';
import { normPath, removeFile, writeFile, type FolderFile, type SongFolder } from '../fs/folder';
import { inDirs, otherSongDirs } from '../fs/songDir';
import { ghostSection, isScoreIni, kindOf, scoreGroupOf, VIDEO_FILE } from './kind';
import { needsMd5, planSong, statSame, type Act, type BaseRec, type LocalStat, type RemoteStat } from './plan';
import { parseScoreIni } from '../nxlib/parse';
import { decodeScore, drumSummary, encodeScore, mergeScoreIni, type Side } from './scoreIni';
import { emptyReport, type RunReport, type ScoreNews, type SongReport, type SyncProgressInfo, type SyncSettings, type SyncState } from './types';

export const LIB_NAME = 'DTXFiles';
export const BACKUP_NAME = '控え'; // i18n-ignore Drive のフォルダの名前（言語で変えない）
export const SYNC_NAME = '.sync';
/** 控えを残す日数 */
export const BACKUP_DAYS = 30;
/** PC の時計と Drive の時計がこれ以上ずれていたら、両方で直したファイルの新しい方を決めない */
export const CLOCK_LIMIT = 5 * 60_000;

/** DTXMania の曲の一覧の 1 曲（set.def の #TITLE ごとではなく、曲のフォルダごと） */
export interface LibSongRef {
  root: string;
  path: string[];
  title: string;
  artist: string;
  bpm: string;
  /** このアプリで直した（作業ファイルがある） */
  edited: boolean;
  drive: 'linked' | 'skip' | null;
  charts: number;
  updated: number;
}

/** DTXMania の曲の一覧と、フォルダの読み書き（src/sync/store.ts が nxlib から作る。試験ではメモリのフォルダ） */
export interface LibAccess {
  songs: readonly LibSongRef[];
  rootDir(root: string): Promise<FileSystemDirectoryHandle | null>;
  /** 曲のフォルダの、Drive での並び（DTXFiles からの BOX と曲のフォルダ）。合わせられない場所なら null */
  libPath(root: string, path: readonly string[]): string[] | null;
  /** Drive の並びの曲を、この PC のどこに置くか */
  placeOf(lib: readonly string[]): { root: string; path: string[] } | null;
  /** エディタで開いている曲のフォルダか（作るファイルを書きかえない） */
  isOpen?(dir: FileSystemDirectoryHandle): Promise<boolean>;
  /** 曲のフォルダを書きかえた（一覧のその曲を読み直す） */
  touched?(root: string, path: readonly string[]): void;
}

export interface RunOptions {
  settings: SyncSettings;
  lib: LibAccess;
  /** この PC の記録（書きかえる。終わったら残す） */
  state: SyncState;
  why: RunReport['why'];
  /** この曲のフォルダだけ（保存したとき） */
  only?: { root: string; path: string[]; title?: string };
  /** 下見：何も書かずに、何が起きるかだけ（初めての同期の画面） */
  dry?: boolean;
  /** 開いている曲にも書く（「取り込む」を押した。保存していない変更は先に聞いてある） */
  take?: boolean;
  progress?: (p: SyncProgressInfo | null) => void;
  now?: () => number;
}

/** Drive の曲のフォルダ */
interface DriveSongRef {
  id: string;
  name: string;
  parent: string;
  /** DTXFiles からの並び（元の綴り）。「DTX Web Editor」の直下（iPad で作った曲・前の版の曲）なら null */
  lib: string[] | null;
  info: SongInfo;
  time: number;
  /** 成績だけの曲（ほかの PC が「成績だけ合わせる」で作った） */
  play: boolean;
  dev?: string;
}

/** この PC の曲のフォルダ */
interface LocalSong {
  key: string;
  root: string;
  path: string[];
  lib: string[] | null;
  title: string;
  artist: string;
  bpm: string;
  edited: boolean;
  drive: 'linked' | 'skip' | null;
  charts: number;
  updated: number;
}

interface Job {
  local?: LocalSong;
  drive?: DriveSongRef;
  lib: string[];
  mode: 'all' | 'play';
  title: string;
  artist: string;
  /** drive は、この PC の曲のフォルダのつなぎの記録（.dtxe-drive.json）にある曲 */
  linked?: boolean;
}

/** Drive に同じ曲が 2 つあって、この PC は keep の方と合わせている（d は使っていない） */
interface DupSong {
  d: DriveSongRef;
  keep: Job;
}

const low = (s: string) => s.normalize('NFC').toLowerCase();
export const libKey = (lib: readonly string[]) => low(lib.join('/'));
const folderKey = (root: string, path: readonly string[]) => `${root}:${normPath(path.join('/')).normalize('NFC')}`;
const titleKey = (s: string) => s.normalize('NFKC').trim().toLowerCase();
const nameKey = (title: string, artist: string) => `${titleKey(title)}\u0000${titleKey(artist)}`;
const iso = (ms: number) => new Date(ms).toISOString();

/** MD5 の控え（下見と本番で 2 回計算しない） */
const md5Cache = new Map<string, string>();

/** この PC の曲のフォルダのファイル（ほかの曲のフォルダの中・合わせないファイルは除く）。読めないフォルダがあれば throw（消したと間違えない） */
async function readLocal(dir: FileSystemDirectoryHandle, name: string): Promise<{ folder: SongFolder; stats: Map<string, LocalStat>; blobs: Map<string, File> }> {
  const files = new Map<string, FolderFile>();
  const stats = new Map<string, LocalStat>();
  const blobs = new Map<string, File>();
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    for await (const [n, h] of d.entries()) {
      const path = prefix ? `${prefix}/${n}` : n;
      if (h.kind === 'file') {
        const fh = h as FileSystemFileHandle;
        const f = await fh.getFile();
        const key = normPath(path);
        files.set(key, { path, name: n, size: f.size, getFile: () => fh.getFile() });
        stats.set(key, { path, size: f.size, mtime: f.lastModified });
        blobs.set(key, f);
        if (files.size > 20000) throw new Error(tr('曲のフォルダのファイルが多すぎます', 'The song folder has too many files'));
      } else if (depth < 4) await walk(h as FileSystemDirectoryHandle, path, depth + 1); // Drive の listTree と同じ深さまで
    }
  };
  await walk(dir, '', 0);
  const others = otherSongDirs([...files.values()].map((f) => f.path));
  for (const key of [...stats.keys()]) {
    if (!syncedPath(stats.get(key)!.path) || inDirs(key, others)) {
      stats.delete(key);
      blobs.delete(key);
    }
  }
  return { folder: { name, dir, files }, stats, blobs };
}

async function readLinkOf(folder: SongFolder): Promise<{ link: DriveLink | null; skip: boolean }> {
  const f = folder.files.get(LINK_FILE);
  if (!f) return { link: null, skip: false };
  try {
    const text = await (await f.getFile()).text();
    const link = parseLink(text);
    if (link) return { link, skip: false };
    const j = JSON.parse(text) as { skip?: unknown };
    return { link: null, skip: j?.skip === true };
  } catch {
    return { link: null, skip: false };
  }
}

/** 小さい物（譜面・成績）を先に、大きい音・動画を後に */
function bySize<T extends { size: number }>(a: T, b: T) {
  return a.size - b.size;
}

function dayText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class SyncRun {
  readonly report: RunReport;
  private readonly st: SyncState;
  private readonly set: SyncSettings;
  private readonly lib: LibAccess;
  private readonly dry: boolean;
  private readonly now: () => number;
  private readonly progress: (p: SyncProgressInfo | null) => void;
  private rootId: string | null = null;
  private libId: string | null = null;
  /** Drive の BOX のフォルダ（並びの小文字 → id） */
  private dirIds = new Map<string, string>();
  private backupIds = new Map<string, string>();
  private dirty: Set<string> | 'all' = 'all';
  private newToken: string | undefined;
  private mine: Record<string, string> = {};
  private clockOff = false;
  /** Drive にある曲のフォルダの id（今回の一覧） */
  private alive = new Set<string>();
  /** Drive に同じ曲が 2 つ：合わせ終えたら、使っていない方を片付ける */
  private dups: DupSong[] = [];
  private done = 0;
  private total = 0;
  private bytes = 0;

  constructor(private readonly o: RunOptions) {
    this.st = o.state;
    this.set = o.settings;
    this.lib = o.lib;
    this.dry = !!o.dry;
    this.now = o.now ?? Date.now;
    this.progress = o.progress ?? (() => {});
    this.report = { at: this.now(), pc: o.settings.pc, why: o.why, songs: [], asks: [], ...(o.dry ? { dry: true } : {}) };
  }

  async run(): Promise<RunReport> {
    try {
      await this.go();
    } finally {
      this.progress(null);
    }
    return this.report;
  }

  private tell(p: Partial<SyncProgressInfo> & Pick<SyncProgressInfo, 'phase'>) {
    this.progress({ done: this.done, total: this.total, bytes: this.bytes, ...p });
  }

  private async go() {
    this.tell({ phase: 'list' });
    this.rootId = await appRoot(!this.dry);
    this.libId = this.rootId ? await this.childDir(this.rootId, 'lib', LIB_NAME, !this.dry) : null;
    // 保存したとき（1 曲だけ）は Drive の変化を聞かない（ほかの曲の変化を次の同期まで残す）。その曲は中を読み直す
    if (!this.dry && !this.o.only) await this.readChanges();
    const sig = settingsSig(this.set);
    if (this.st.sig !== sig) this.dirty = 'all';
    const recent = this.st.skew !== undefined && this.now() - (this.st.clockAt ?? 0) < 30 * 60_000;
    if (!this.dry && !((this.o.why === 'timer' || this.o.why === 'save') && recent)) await this.checkClock();
    else if (this.st.skew !== undefined) this.clockOff = Math.abs(this.st.skew) > CLOCK_LIMIT;
    let ok = false;
    try {
      const drive = this.rootId ? await this.listDriveSongs() : [];
      const jobs = await this.makeJobs(drive);
      this.total = jobs.length;
      const failed = new Set<Job>();
      for (const job of jobs) {
        let rep: SongReport | null;
        try {
          rep = await this.syncSong(job);
        } catch (e) {
          // ログインが切れた・Drive がいっぱい：ここでやめる
          if (e instanceof DriveError && (e.reason === 'auth' || /storageQuotaExceeded|quotaExceeded/i.test(e.reason))) throw e;
          failed.add(job);
          rep = emptyReport(job.title, job.lib.join('/'), job.drive?.id ?? '', job.local ? (job.drive ? 'here' : 'new') : 'none');
          rep.error = (e as Error).message || String(e);
          if (job.local) {
            rep.root = job.local.root;
            rep.path = [...job.local.path];
          }
          // 途中で止まった曲は、次の同期で Drive の中を読み直す
          const known = job.drive && this.st.songs[job.drive.id];
          if (known && !this.dry) known.recheck = true;
        }
        this.done++;
        if (rep && (this.dry || hasNews(rep) || rep.error)) this.report.songs.push(rep);
      }
      for (const x of this.dups) await this.dropDup(x, failed);
      ok = true;
    } finally {
      if (!this.dry) {
        // 変化を聞く印を進めるのは、全部の曲を見終わったときだけ（途中でやめたら、次の同期でもう一度同じ変化を見る）
        if (ok && this.newToken) {
          this.st.token = this.newToken;
          this.st.mine = this.mine;
        } else Object.assign(this.st.mine, this.mine);
      }
    }
    if (this.dry) return;
    this.st.at = this.now();
    if (!this.o.only) this.st.sig = sig;
    await this.cleanBackups().catch(() => {});
  }

  // ---- Drive の置き場所 ---------------------------------------------------------------

  /** 印の付いた子フォルダ（無ければ作る） */
  private async childDir(parent: string, tag: string, name: string, create: boolean): Promise<string | null> {
    const kids = await listFiles(`'${q(parent)}' in parents and appProperties has { key='dtxe' and value='${tag}' } and mimeType = '${FOLDER_MIME}' and trashed = false`);
    if (kids[0]) return kids[0].id;
    if (!create) return null;
    const f = await createFolder(name, parent, { appProperties: { dtxe: tag } });
    this.mine[f.id] = 'dir';
    return f.id;
  }

  /** Drive の曲（印 dtxe=song）と、その並び（BOX のフォルダ dtxe=dir をたどる） */
  private async listDriveSongs(): Promise<DriveSongRef[]> {
    const [songs, dirs] = await Promise.all([listFiles(SONG_QUERY), this.libId ? listFiles(`appProperties has { key='dtxe' and value='dir' } and mimeType = '${FOLDER_MIME}' and trashed = false`) : Promise.resolve([] as DriveFile[])]);
    const meta = new Map(dirs.map((d) => [d.id, { name: d.name, parent: d.parents?.[0] ?? '' }]));
    const pathOf = (id: string): string[] | null => {
      const segs: string[] = [];
      let p: string | undefined = id;
      for (let n = 0; p && n < 16; n++) {
        if (p === this.libId) return segs;
        const m = meta.get(p);
        if (!m) return null;
        segs.unshift(m.name);
        p = m.parent;
      }
      return null;
    };
    for (const d of dirs) {
      const p = pathOf(d.id);
      if (p) this.dirIds.set(libKey(p), d.id);
    }
    const out: DriveSongRef[] = [];
    for (const f of songs) {
      const parent = f.parents?.[0] ?? '';
      const up = parent === this.libId ? [] : pathOf(parent);
      // 「DTX Web Editor」の直下（iPad・前の版）は null。どこでもない所（ほかの「DTX Web Editor」など）も直下と同じにする
      const lib = up ? [...up, f.name] : null;
      let info: SongInfo = {};
      try {
        info = f.description ? (JSON.parse(f.description) as SongInfo) : {};
      } catch {
        // 説明が JSON でない
      }
      out.push({ id: f.id, name: f.name, parent, lib, info, time: Date.parse(f.modifiedTime ?? '') || 0, play: f.appProperties?.play === '1', dev: f.appProperties?.dev });
    }
    return out;
  }

  /** Drive の BOX のフォルダを作る（DTXFiles/<BOX>/…）。local は、この PC の BOX のフォルダ（box.def を送る） */
  private async ensureLibDirs(segs: readonly string[], localDirs?: (i: number) => Promise<FileSystemDirectoryHandle | null>): Promise<string> {
    let parent = this.libId!;
    for (let i = 0; i < segs.length; i++) {
      const key = libKey(segs.slice(0, i + 1));
      let id = this.dirIds.get(key);
      if (!id) {
        const f = await createFolder(segs[i], parent, { appProperties: { dtxe: 'dir' } });
        id = f.id;
        this.mine[id] = 'dir';
        this.dirIds.set(key, id);
        // この PC の BOX の box.def も送る（ほかの PC で BOX になる）
        const ld = await localDirs?.(i);
        const def = ld ? await fileIn(ld, 'box.def') : null;
        if (def) {
          const file = await def.getFile();
          const res = await upload({ name: def.name, parent: id, data: file, modifiedTime: iso(file.lastModified), appProperties: { dev: this.set.pc } });
          this.mine[res.id] = res.md5Checksum ?? '';
        }
      }
      parent = id;
    }
    return parent;
  }

  /** この PC に曲のフォルダを作る（無い BOX のフォルダも。Drive の BOX に box.def があれば取る） */
  private async makeLocalDir(root: string, path: readonly string[], lib: readonly string[]): Promise<FileSystemDirectoryHandle | null> {
    let d = await this.lib.rootDir(root);
    if (!d) return null;
    const boxFrom = path.length - lib.length;
    for (let i = 0; i < path.length; i++) {
      let have: FileSystemDirectoryHandle | null = null;
      try {
        have = await d.getDirectoryHandle(path[i]);
      } catch {
        have = null;
      }
      if (!have) {
        have = await d.getDirectoryHandle(path[i], { create: true });
        const bi = i - boxFrom;
        const boxId = bi >= 0 && bi < lib.length - 1 ? this.dirIds.get(libKey(lib.slice(0, bi + 1))) : undefined;
        if (boxId) {
          const def = (await listChildren(boxId)).find((f) => f.name.toLowerCase() === 'box.def' && f.mimeType !== FOLDER_MIME);
          if (def) await writeIn(have, def.name, await download(def.id));
        }
      }
      d = have;
    }
    return d;
  }

  private async songDir(root: string, path: readonly string[]): Promise<FileSystemDirectoryHandle | null> {
    let d = await this.lib.rootDir(root);
    for (const p of path) {
      if (!d) return null;
      try {
        d = await d.getDirectoryHandle(p);
      } catch {
        return null;
      }
    }
    return d;
  }

  /** 控えのフォルダ（DTX Web Editor/控え/<日付>/<曲>/<サブフォルダ>） */
  private async backupDir(song: string, path: string): Promise<string> {
    const segs = [dayText(this.now()), song, ...path.split('/').slice(0, -1)];
    let parent = await this.childDir(this.rootId!, 'backup', BACKUP_NAME, true);
    let key = '';
    for (const s of segs) {
      key = `${key}/${low(s)}`;
      let id = this.backupIds.get(key);
      if (!id) {
        id = (await listFiles(`'${q(parent!)}' in parents and name = '${q(s)}' and mimeType = '${FOLDER_MIME}' and trashed = false`))[0]?.id ?? (await createFolder(s, parent!)).id;
        this.mine[id] = 'dir';
        this.backupIds.set(key, id);
      }
      parent = id;
    }
    return parent!;
  }

  /** 30 日をこえた控えをゴミ箱へ（1 日に 1 回） */
  private async cleanBackups() {
    if (!this.rootId || this.now() - (this.st.cleaned ?? 0) < 86_400_000) return;
    this.st.cleaned = this.now();
    const dir = await this.childDir(this.rootId, 'backup', BACKUP_NAME, false);
    if (!dir) return;
    const limit = dayText(this.now() - BACKUP_DAYS * 86_400_000);
    for (const d of await listChildren(dir)) if (d.mimeType === FOLDER_MIME && /^\d{4}-\d{2}-\d{2}$/.test(d.name) && d.name < limit) await trashFile(d.id);
  }

  // ---- 変わった物 ------------------------------------------------------------------

  /** 前の同期のあと Drive で変わった曲（自分で書いた物は見ない）。分からなければ全部 */
  private async readChanges() {
    if (!this.st.token) {
      this.newToken = await startPageToken();
      this.dirty = 'all';
      return;
    }
    let res: Awaited<ReturnType<typeof listChanges>>;
    try {
      res = await listChanges(this.st.token);
    } catch (e) {
      if (e instanceof DriveError && e.reason === 'auth') throw e;
      this.newToken = await startPageToken();
      this.dirty = 'all';
      return;
    }
    this.newToken = res.next;
    // フォルダの id → 曲のフォルダの id（この PC が合わせている曲と、変化の中の曲のフォルダ）
    const owner = new Map<string, string | null>();
    for (const [id, s] of Object.entries(this.st.songs)) {
      owner.set(id, id);
      for (const d of Object.values(s.dirs)) owner.set(d, id);
    }
    const changes = res.changes.filter((c) => {
      const f = c.file;
      const was = this.st.mine[c.fileId];
      // この PC が書いたまま（ほかの PC が書きかえていない）
      if (f && was !== undefined && !f.trashed && (f.mimeType === FOLDER_MIME ? was === 'dir' : was === (f.md5Checksum ?? ''))) return false;
      // 控え・PC の名前は曲ではない
      return f?.appProperties?.dtxe !== 'bak' && f?.appProperties?.dtxe !== 'pc';
    });
    for (const c of changes) if (c.file?.appProperties?.dtxe === 'song' && !owner.has(c.fileId)) owner.set(c.fileId, c.fileId);
    const dirty = new Set<string>();
    for (const c of changes) {
      const f = c.file;
      const self = owner.get(c.fileId);
      if (self) dirty.add(self);
      const parent = f?.parents?.[0];
      if (!f || !parent || self) continue;
      let song = owner.get(parent);
      // 知らないサブフォルダ（ほかの PC が作った）：上をたどって曲を探す
      if (song === undefined && f.mimeType !== FOLDER_MIME) {
        song = await this.songOfFolder(parent, owner);
        owner.set(parent, song);
      }
      if (song) dirty.add(song);
    }
    this.dirty = dirty;
  }

  private async songOfFolder(id: string, owner: Map<string, string | null>): Promise<string | null> {
    let cur: string | undefined = id;
    for (let n = 0; cur && n < 6; n++) {
      const have = owner.get(cur);
      if (have !== undefined) return have;
      const f = await getFile(cur);
      if (!f) return null;
      if (f.appProperties?.dtxe === 'song') return f.id;
      if (f.appProperties?.dtxe) return null;
      cur = f.parents?.[0];
    }
    return null;
  }

  /** この PC の名前を .sync に書き、PC の時計と Drive の時計の差を見る */
  private async checkClock() {
    if (!this.rootId) return;
    const dir = await this.childDir(this.rootId, 'sync', SYNC_NAME, true);
    const body = new Blob([JSON.stringify({ v: 1, pc: this.set.pc, at: this.now() })], { type: 'application/json' });
    const t0 = this.now();
    let res: DriveFile;
    try {
      res = await upload({ id: this.st.pcFile, name: `${this.set.pcId}.json`, parent: this.st.pcFile ? undefined : dir!, data: body, appProperties: { dtxe: 'pc', pc: this.set.pc } });
    } catch (e) {
      if (!(e instanceof DriveError) || e.status !== 404) throw e;
      res = await upload({ name: `${this.set.pcId}.json`, parent: dir!, data: body, appProperties: { dtxe: 'pc', pc: this.set.pc } });
    }
    const t1 = this.now();
    this.st.pcFile = res.id;
    this.st.clockAt = this.now();
    this.mine[res.id] = res.md5Checksum ?? '';
    const server = Date.parse(res.modifiedTime ?? '');
    if (Number.isFinite(server)) {
      this.st.skew = server - (t0 + t1) / 2;
      this.clockOff = Math.abs(this.st.skew) > CLOCK_LIMIT;
    }
  }

  // ---- 組にする ---------------------------------------------------------------------

  private localSongs(): LocalSong[] {
    const m = new Map<string, LocalSong>();
    for (const s of this.lib.songs) {
      const key = folderKey(s.root, s.path);
      const have = m.get(key);
      if (have) {
        have.charts += s.charts;
        have.updated = Math.max(have.updated, s.updated);
        have.edited ||= s.edited;
        continue;
      }
      m.set(key, { key, root: s.root, path: [...s.path], lib: s.path.length ? this.lib.libPath(s.root, s.path) : null, title: s.title, artist: s.artist, bpm: s.bpm, edited: s.edited, drive: s.drive, charts: s.charts, updated: s.updated });
    }
    return [...m.values()];
  }

  /** 同期する曲か（made：直した・送った・足した BOX と曲。all：全部）。成績だけなら 'play'。playLink は成績だけ合わせてきた曲 */
  private scopeOf(s: LocalSong, playLink = false): 'all' | 'play' | null {
    if (s.drive === 'skip' || !s.lib) return null;
    const k = libKey(s.lib);
    if (this.set.scope === 'all' || s.edited || (s.drive === 'linked' && !playLink)) return 'all';
    if (this.set.songs.some((x) => low(x) === k)) return 'all';
    if (this.set.boxes.some((b) => k.startsWith(`${low(b)}/`))) return 'all';
    return this.set.scoresOnly && this.set.scores ? 'play' : null;
  }

  /** Drive の曲の、DTXFiles からの並び（「DTX Web Editor」の直下の曲は、取り込む BOX の中） */
  private libOfDrive(d: DriveSongRef): string[] {
    return d.lib ?? (this.set.importBox ? [...this.set.importBox.split('/').filter(Boolean), d.name] : [d.name]);
  }

  private async makeJobs(drive: DriveSongRef[]): Promise<Job[]> {
    const ans = this.st.answers;
    const index = this.st.songs;
    const locals = this.localSongs();
    const byId = new Map(drive.map((d) => [d.id, d]));
    this.alive = new Set(byId.keys());
    // 並び（小文字）→ Drive の曲。「DTX Web Editor」の直下の曲（iPad・前の版の「Drive にも保存」）も、取り込む BOX での並びで探す
    // （DTXFiles の同じ所にある曲と同じ曲。別の曲として Drive にもう 1 つ作らない）
    const byLib = new Map<string, DriveSongRef[]>();
    for (const d of drive) {
      const k = libKey(this.libOfDrive(d));
      byLib.set(k, [...(byLib.get(k) ?? []), d]);
    }
    /** この PC の曲のフォルダ at と、前に合わせていた曲か */
    const wasAt = (d: DriveSongRef, at: string) => !!index[d.id] && folderKey(index[d.id].root, index[d.id].path) === at;
    /** 同じ所に Drive の曲が 2 つ以上あるとき、いい方から：この PC がそのフォルダと合わせていた曲 → DTXFiles の中の曲 → 新しく送った曲 */
    const better = (at: string | null) => (a: DriveSongRef, b: DriveSongRef) => {
      const r = (d: DriveSongRef) => [at && wasAt(d, at) ? 0 : 1, d.lib ? 0 : 1, -(d.info.u ?? d.time)];
      const ra = r(a);
      const rb = r(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    const used = new Set<string>();
    const jobs: Job[] = [];
    /** この PC の曲のフォルダ → それを合わせる仕事（null は合わせないがほかの曲を入れない）。1 つのフォルダに Drive の曲を 2 つ合わせない */
    const claimed = new Map<string, Job | null>();
    /** Drive の曲と組になった、この PC の曲のフォルダ */
    const paired = new Set<string>();
    const add = (job: Job, at: string) => {
      jobs.push(job);
      claimed.set(at, job);
      if (job.drive) {
        used.add(job.drive.id);
        paired.add(at);
      }
    };
    const join = (job: Job, d: DriveSongRef, at: string) => {
      job.drive = d;
      used.add(d.id);
      paired.add(at);
    };
    const only = this.o.only ? folderKey(this.o.only.root, this.o.only.path) : null;
    if (only && !locals.some((s) => s.key === only)) {
      // まだ一覧に無い（新しく保存した）曲
      const o = this.o.only!;
      const lib = this.lib.libPath(o.root, o.path);
      if (lib) locals.push({ key: only, root: o.root, path: [...o.path], lib, title: o.title ?? o.path[o.path.length - 1] ?? '', artist: '', bpm: '', edited: true, drive: null, charts: 1, updated: this.now() });
    }
    // 前に合わせた曲（.dtxe-drive.json の id。成績だけの曲か）。一覧の印は古いことがある（一覧を読んだあとで Drive につないだ）ので、
    // 合わせる曲と、Drive の同じ並びに曲がある曲は、ファイルを読む
    const linked = new Map<string, { id: string; play: boolean }>();
    for (const s of locals) {
      if ((only && s.key !== only) || s.drive === 'skip') continue;
      if (s.drive !== 'linked' && !this.scopeOf(s) && !(s.lib && byLib.has(libKey(s.lib)))) continue;
      const dir = await this.songDir(s.root, s.path);
      const link = dir ? await linkAt(dir) : null;
      if (link) linked.set(s.key, { id: link.folderId, play: !!link.play });
    }
    for (const s of locals) {
      if (only && s.key !== only) continue;
      const ln = linked.get(s.key);
      let mode = only === s.key && s.drive !== 'skip' && s.lib ? 'all' : this.scopeOf(ln ? { ...s, drive: 'linked' } : s, ln?.play);
      if (ln) {
        let d = byId.get(ln.id);
        if (!d) {
          // Drive で消された（ほかの PC で消した・同期から外した）か、印の無い古いフォルダ
          const f = await getFile(ln.id);
          // 同じ曲が Drive に 2 つあって、使っていない方として片付けた（ほかの PC で）：残した方とつなぎ直す
          const to = f?.trashed ? byId.get(f.appProperties?.dup ?? '') : undefined;
          if (to && !used.has(to.id)) {
            if (!this.dry) delete index[ln.id];
            d = to;
          } else if (!f || f.trashed) {
            if (!this.dry) await this.dropLinked(s, f?.appProperties?.gone === '1');
            continue;
          } else d = { id: f.id, name: f.name, parent: f.parents?.[0] ?? '', lib: null, info: {}, time: Date.parse(f.modifiedTime ?? '') || 0, play: f.appProperties?.play === '1' };
        }
        // 成績だけ合わせていた曲を、ほかの PC が曲ごと合わせはじめた：この PC も曲ごと
        if (ln.play && !d.play && mode !== null) mode = 'all';
        if (mode && s.lib) add({ local: s, drive: d, lib: s.lib, mode, title: s.title, artist: s.artist, linked: d.id === ln.id }, s.key);
        else {
          // 合わせない（成績だけの曲で、成績も合わせない設定）が、このフォルダは Drive のこの曲のもの
          used.add(d.id);
          claimed.set(s.key, null);
          paired.add(s.key);
        }
        continue;
      }
      if (!s.lib) continue;
      // 同じ並び：同じ曲（同期する曲でなくても、ほかの PC が作った曲なら合わせる）
      const d = (byLib.get(libKey(s.lib)) ?? []).filter((x) => !used.has(x.id) && (mode !== null || !x.play)).sort(better(s.key))[0];
      if (d) add({ local: s, drive: d, lib: s.lib, mode: mode ?? 'all', title: s.title, artist: s.artist }, s.key);
      else if (mode) add({ local: s, lib: s.lib, mode, title: s.title, artist: s.artist }, s.key);
    }
    if (only) return jobs;
    // Drive にだけある曲
    const named = new Map<string, LocalSong[]>();
    for (const s of locals) {
      if (!s.title.trim()) continue;
      const k = nameKey(s.title, s.artist);
      named.set(k, [...(named.get(k) ?? []), s]);
    }
    // この PC で合わせていた曲を先に。同じ所の曲は、いい方から
    const rest = drive.filter((d) => !used.has(d.id) && !d.play).sort((a, b) => Number(!index[a.id]) - Number(!index[b.id]) || better(null)(a, b));
    // 1) この PC で合わせていた曲で、一覧には出ていないが、フォルダはあってこの曲とつながっている：そのまま合わせる（一覧も読み直す）
    for (const d of rest) {
      const known = index[d.id];
      if (!known) continue;
      const at = folderKey(known.root, known.path);
      if (claimed.has(at)) continue;
      const dir = await this.songDir(known.root, known.path);
      const link = dir ? await linkAt(dir) : null;
      const lib = this.lib.libPath(known.root, known.path);
      if (link?.folderId !== d.id || !lib) continue;
      const title = known.title || d.info.t || d.name;
      const s: LocalSong = { key: at, root: known.root, path: [...known.path], lib, title, artist: d.info.a ?? '', bpm: d.info.b ?? '', edited: false, drive: 'linked', charts: 0, updated: 0 };
      const mode = this.scopeOf(s, !!link.play);
      if (mode) add({ local: s, drive: d, lib, mode, title, artist: s.artist, linked: true }, at);
      else {
        used.add(d.id);
        claimed.set(at, null);
        paired.add(at);
      }
      if (!this.dry) this.lib.touched?.(known.root, known.path);
    }
    // 2) 残りの曲
    for (const d of rest) {
      if (used.has(d.id)) continue;
      const lib = this.libOfDrive(d);
      const title = d.info.t || d.name;
      const artist = d.info.a ?? '';
      const known = index[d.id];
      if (known) {
        const at = folderKey(known.root, known.path);
        const holder = claimed.get(at);
        if (holder && !holder.drive) {
          // 前に合わせていたフォルダ（つなぎの記録が無くなった）：つなぎ直す
          join(holder, d, at);
          continue;
        }
        if (holder?.drive && holder.linked) {
          // そのフォルダは、つなぎの記録で Drive の別の曲と合わせている。曲名が同じなら同じ曲（違えば、前の曲を消して別の曲を置いた）
          if (titleKey(known.title || title) === titleKey(holder.title) || titleKey(title) === titleKey(holder.title)) {
            // 同じ曲が Drive に 2 つある（前の版の初めての同期で、この PC が同じフォルダに 2 つ合わせた）。
            // 消した・動かしたのではないので聞かない。合わせ終えたら、使っていないこちらを片付ける
            if (!this.dry) this.dups.push({ d, keep: holder });
            continue;
          }
          // 別の曲を置いた（前の曲は消した・動かした）：下で聞く
        } else if (holder !== undefined || (await this.songDir(known.root, known.path))) {
          // フォルダがある（一覧に出ていない・合わせはじめたばかり）：消した・動かしたのではないので聞かない。一覧は読み直す
          if (holder === undefined && !this.dry) this.lib.touched?.(known.root, known.path);
          continue;
        }
        // この PC で合わせていた曲のフォルダが無い（消した・動かした）：聞く
        const a = ans[`g:${d.id}`];
        if (a === 'leave') continue;
        if (a === 'trash') {
          if (!this.dry) {
            // ほかの PC でも消す（印を付けてからゴミ箱へ。ほかの PC は、前のままなら消す）
            await updateMeta(d.id, { appProperties: { gone: '1' } }).catch(() => {});
            await trashFile(d.id).catch(() => {});
            delete index[d.id];
            delete ans[`g:${d.id}`];
          }
          continue;
        }
        if (a !== 'get') {
          this.report.asks.push({ id: `g:${d.id}`, kind: 'gone', title, driveId: d.id, lib: known.lib });
          continue;
        }
      }
      // 置く所のフォルダを、もうほかの曲が使っている
      const place = this.lib.placeOf(lib);
      const at = place ? folderKey(place.root, place.path) : `drive:${d.id}`;
      const holder = claimed.get(at);
      if (holder !== undefined) {
        // この PC の同じ所の曲（新しく送るはずだった）：同じ曲。Drive の別の曲と合わせているなら、同じ曲が Drive に 2 つあるので、この PC は今のまま
        if (holder && !holder.drive) join(holder, d, at);
        continue;
      }
      // 並びは違うが、曲名とアーティストが同じ曲：同じ曲か聞く
      const same = (named.get(nameKey(title, artist)) ?? []).find((s) => s.lib && !paired.has(s.key) && libKey(s.lib) !== libKey(lib));
      const sa = ans[`s:${d.id}`];
      if (same && sa !== 'separate') {
        const lj = claimed.get(same.key);
        if (sa === 'join') {
          if (lj) join(lj, d, same.key);
          else add({ local: same, drive: d, lib: same.lib!, mode: 'all', title: same.title, artist: same.artist }, same.key);
          continue;
        }
        this.report.asks.push({
          id: `s:${d.id}`,
          kind: 'same',
          title,
          artist,
          driveId: d.id,
          driveLib: lib.join('/'),
          localLib: same.lib!.join('/'),
          local: { time: same.updated, charts: same.charts },
          remote: { time: d.info.u ?? d.time, dev: d.dev },
        });
        // 答えるまで、この PC の曲も新しく送らない（ほかの曲もそのフォルダに入れない）
        const i = lj ? jobs.indexOf(lj) : -1;
        if (i >= 0) jobs.splice(i, 1);
        claimed.set(same.key, null);
        continue;
      }
      add({ drive: d, lib, mode: 'all', title, artist }, at);
    }
    return jobs;
  }

  /**
   * Drive に同じ曲が 2 つあり（前の版の初めての同期で作った）、この PC はもう一方と合わせている：使っていない方をゴミ箱へ（30 日は戻せる）。
   * 残した方を合わせ終えたときだけ。ほかの PC がこちらとつないでいたら、印（dup）を見て残した方につなぎ直す
   */
  private async dropDup(x: DupSong, failed: ReadonlySet<Job>) {
    const keep = x.keep.drive;
    if (!keep || failed.has(x.keep) || !this.st.songs[keep.id]) return;
    try {
      await updateMeta(x.d.id, { appProperties: { dup: keep.id } });
      await trashFile(x.d.id);
    } catch (e) {
      if (e instanceof DriveError && e.reason === 'auth') throw e;
      return; // 次の同期で
    }
    delete this.st.songs[x.d.id];
    for (const k of Object.keys(this.st.answers)) if (k.startsWith(`f:${x.d.id}:`) || k === `s:${x.d.id}` || k === `g:${x.d.id}`) delete this.st.answers[k];
    const rep = emptyReport(x.keep.title, x.keep.lib.join('/'), x.d.id, 'here');
    rep.dup = true;
    if (x.keep.local) {
      rep.root = x.keep.local.root;
      rep.path = [...x.keep.local.path];
    }
    this.report.songs.push(rep);
  }

  /**
   * Drive の曲のフォルダがゴミ箱にある曲。gone（ほかの PC で曲ごと消して「ほかの PC でも消す」）なら、この PC でも前のままなら消す。
   * そうでなければ（ほかの PC で同期をやめた・この PC で直していた）、この PC の曲は残し、同期から外す
   */
  private async dropLinked(s: LocalSong, gone: boolean) {
    const dir = await this.songDir(s.root, s.path);
    if (!dir) return;
    for (const [id, x] of Object.entries(this.st.songs)) if (x.root === s.root && normPath(x.path.join('/')) === normPath(s.path.join('/'))) delete this.st.songs[id];
    const rep = emptyReport(s.title, s.lib?.join('/') ?? s.path.join('/'), '', 'here');
    rep.root = s.root;
    rep.path = [...s.path];
    if (gone && (await this.removeSong(s, dir))) {
      rep.removed = true;
    } else {
      await writeIn(dir, LINK_FILE, new Blob([JSON.stringify({ v: 1, skip: true })]));
      rep.error = gone
        ? tr('ほかの PC で消した曲ですが、この PC で直したファイルがあるので残しました。同期からは外しました', 'Another PC deleted this song, but it was changed on this PC, so it was kept here and is no longer synced')
        : tr('ほかの PC で同期をやめた曲です（Drive のゴミ箱にあります）。この PC の曲はそのまま残し、同期からも外しました', 'Another PC stopped syncing this song (it is in the Drive trash). The song stays on this PC and is no longer synced');
    }
    this.report.songs.push(rep);
    this.lib.touched?.(s.root, s.path);
  }

  /** ほかの PC で消した曲を、この PC でも消す（前に合わせたままのときだけ。ほかの曲のフォルダ・自動保存があれば消さない） */
  private async removeSong(s: LocalSong, dir: FileSystemDirectoryHandle): Promise<boolean> {
    const name = s.path[s.path.length - 1] ?? '';
    const loc = await readLocal(dir, name);
    const { link } = await readLinkOf(loc.folder);
    if (!link) return false;
    // ほかの曲のフォルダ・自動保存・書きかけのファイルがある：消さない
    const all = [...loc.folder.files.keys()];
    if (all.some((k) => (!loc.stats.has(k) && k !== LINK_FILE && syncedPath(k)) || k.startsWith('.dtxe-autosave/') || k.endsWith('.crswap'))) return false;
    for (const [k, st] of loc.stats) {
      if (kindOf(k) === 'play') continue;
      const rec = link.files[k];
      if (!rec) return false;
      if (statSame(st, rec)) continue;
      if (st.size !== rec.size || (await md5Blob(loc.blobs.get(k)!)) !== rec.md5) return false;
    }
    for (const f of [...loc.folder.files.values()]) if (!(await removeFile(loc.folder, f.path))) return false;
    // 空になったフォルダ（深い方から）と、曲のフォルダ
    const subs = new Set<string>();
    for (const f of loc.stats.values()) {
      const parts = f.path.split('/').slice(0, -1);
      for (let i = parts.length; i > 0; i--) subs.add(parts.slice(0, i).join('/'));
    }
    for (const sub of [...subs].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const parts = sub.split('/');
      let d = dir;
      try {
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
        await d.removeEntry(parts[parts.length - 1]);
      } catch {
        // 空でない
      }
    }
    const parent = await this.songDir(s.root, s.path.slice(0, -1));
    await parent?.removeEntry(name).catch(() => {});
    return true;
  }

  // ---- 1 曲を合わせる ----------------------------------------------------------------

  private async syncSong(job: Job): Promise<SongReport | null> {
    const rep = emptyReport(job.title, job.lib.join('/'), job.drive?.id ?? '', job.local ? (job.drive ? 'here' : 'new') : 'none');
    if (job.mode === 'play') rep.play = true;
    this.tell({ phase: 'check', song: job.title });
    // この PC の曲のフォルダ
    const place = job.local ? { root: job.local.root, path: job.local.path } : this.lib.placeOf(job.lib);
    if (!place) throw new Error(tr('この PC のどこに置くか決められません', "Can't decide where to put it on this PC"));
    rep.root = place.root;
    rep.path = [...place.path];
    let dir = await this.songDir(place.root, place.path);
    if (job.local && !dir) throw new Error(tr('曲のフォルダを開けません', "Can't open the song folder"));
    const loc = dir ? await readLocal(dir, place.path[place.path.length - 1] ?? '') : { folder: null as SongFolder | null, stats: new Map<string, LocalStat>(), blobs: new Map<string, File>() };
    const { link: oldLink } = loc.folder ? await readLinkOf(loc.folder) : { link: null };
    // Drive にだけある曲を置く所のフォルダが、Drive の別の曲と合わせている（同じ曲が Drive に 2 つ）：そのフォルダは書きかえない
    if (!job.local && job.drive && oldLink && oldLink.folderId !== job.drive.id && this.alive.has(oldLink.folderId)) return null;
    const before = oldLink ? linkSig(oldLink) : '';
    const first = !oldLink || !job.drive || oldLink.folderId !== job.drive.id;
    const asked = new Set(!first ? (oldLink?.ask ?? []) : []);
    const link: DriveLink = !first && oldLink ? oldLink : newLink(job.drive?.id ?? '', job.drive?.name ?? place.path[place.path.length - 1] ?? '');
    if (job.mode === 'play') link.play = true;
    else delete link.play;
    const recs = first ? {} : { ...link.files };
    const open = !this.o.take && !!(dir && this.lib.isOpen && (await this.lib.isOpen(dir)));
    // Drive
    let tree: DriveTree | null = null;
    const remote = new Map<string, RemoteStat>();
    if (job.drive) {
      const known = this.st.songs[job.drive.id];
      if (first || !known || known.recheck || this.dirty === 'all' || this.dirty.has(job.drive.id)) {
        tree = await listTree(job.drive.id);
        for (const [k, r] of tree.files) remote.set(k, { id: r.id, path: r.path, md5: r.md5, size: r.size, time: Date.parse(r.modifiedTime) || 0, ...(r.dev ? { dev: r.dev } : {}) });
      } else for (const [k, r] of Object.entries(recs)) remote.set(k, { id: r.id, path: r.path, md5: r.md5, size: r.size, time: 0 });
    }
    // 合わせるファイルだけ
    const noVideo = !this.set.video || !!link.noVideo;
    const keep = (path: string) => {
      const play = kindOf(path) === 'play';
      if (play) return this.set.scores;
      return job.mode === 'all' && !(noVideo && VIDEO_FILE.test(path));
    };
    for (const m of [loc.stats, remote] as Map<string, { path: string }>[]) for (const [k, v] of m) if (!keep(v.path)) m.delete(k);
    for (const k of Object.keys(recs)) if (!keep(recs[k].path)) delete recs[k];
    // MD5（要るときだけ）
    for (const [k, l] of loc.stats) {
      const rec = recs[k];
      if (rec && statSame(l, rec)) l.md5 = rec.md5;
      else if (needsMd5(l, remote.get(k), rec)) {
        const ck = `${folderKey(place.root, place.path)}|${k}|${l.size}|${l.mtime}`;
        let h = md5Cache.get(ck);
        if (!h) {
          this.tell({ phase: 'check', song: job.title, file: l.path.split('/').pop() });
          h = await md5Blob(loc.blobs.get(k)!);
          md5Cache.set(ck, h);
        }
        l.md5 = h;
      }
    }
    // 決める
    const songKey = job.drive?.id ?? '';
    const answers = new Map<string, 'mine' | 'theirs'>();
    for (const k of new Set([...loc.stats.keys(), ...remote.keys()])) {
      const a = this.st.answers[`f:${songKey}:${k}`];
      if (a === 'mine' || a === 'theirs') answers.set(k, a);
    }
    let acts = planSong(loc.stats, remote, recs, { first, open, clockOff: this.clockOff, answers, asked });
    const guarded = guardMass(acts, loc.stats, remote);
    acts = guarded.acts;
    if (guarded.kept) rep.kept = guarded.kept;
    const asking = acts.filter((a) => a.op === 'ask').map((a) => a.key);
    if (asking.length) link.ask = asking;
    else delete link.ask;
    for (const a of acts) {
      if (a.op !== 'ask') continue;
      const l = loc.stats.get(a.key)!;
      this.report.asks.push({ id: `f:${songKey}:${a.key}`, kind: 'file', why: a.why, title: job.title, lib: job.lib.join('/'), path: a.path, local: { time: l.mtime, size: l.size }, remote: { time: a.remote.time, size: a.remote.size, dev: a.remote.dev } });
    }
    if (this.dry) {
      summarize(rep, acts, loc.stats, remote);
      return rep;
    }
    // ---- ここから書く ----
    // Drive に無い曲で、送る物が無い（成績だけの曲で、まだ遊んでいない）：Drive にフォルダを作らない
    if (!job.drive && !acts.some((a) => a.op === 'up')) return rep;
    if (!dir) {
      dir = await this.makeLocalDir(place.root, place.path, job.lib);
      if (!dir) throw new Error(tr('この PC に曲のフォルダを作れません', "Can't create the song folder on this PC"));
    }
    const folder: SongFolder = loc.folder ?? { name: place.path[place.path.length - 1] ?? '', dir, files: new Map() };
    // Drive の曲のフォルダ
    let driveId = job.drive?.id ?? '';
    if (!driveId) {
      if (!this.libId) this.libId = await this.childDir(this.rootId!, 'lib', LIB_NAME, true);
      const local = job.local!;
      const boxFrom = local.path.length - job.lib.length;
      const parent = await this.ensureLibDirs(job.lib.slice(0, -1), (i) => this.songDir(local.root, local.path.slice(0, boxFrom + i + 1)));
      const f = await createFolder(job.lib[job.lib.length - 1], parent, { appProperties: { dtxe: 'song', ...(job.mode === 'play' ? { play: '1' } : {}), dev: this.set.pc }, description: JSON.stringify(this.infoOf(job, loc.stats)) });
      this.mine[f.id] = 'dir';
      driveId = f.id;
      rep.driveId = driveId;
      link.folderId = driveId;
      link.name = f.name;
    } else if (job.drive && !job.drive.lib) {
      // 「DTX Web Editor」の直下の曲（iPad・前の版）：DTXFiles/<BOX>/ へ動かす
      if (!this.libId) this.libId = await this.childDir(this.rootId!, 'lib', LIB_NAME, true);
      const local = job.local;
      const boxFrom = local ? local.path.length - job.lib.length : 0;
      const parent = await this.ensureLibDirs(job.lib.slice(0, -1), local ? (i) => this.songDir(local.root, local.path.slice(0, boxFrom + i + 1)) : undefined);
      const name = job.lib[job.lib.length - 1];
      const clash = (await listFiles(`'${q(parent)}' in parents and name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`)).length > 0;
      const moved = await moveFile(driveId, parent, [job.drive.parent], clash ? undefined : name);
      this.mine[moved.id] = 'dir';
      link.name = moved.name;
    }
    if (job.drive?.play && job.mode === 'all') {
      await updateMeta(driveId, { appProperties: { play: '0' } });
      this.mine[driveId] = 'dir';
    }
    const dirs: Record<string, string> = tree ? Object.fromEntries(tree.dirs) : { ...(this.st.songs[driveId]?.dirs ?? {}), '': driveId };
    dirs[''] = driveId;
    const ex = new Exec(this, rep, folder, link, dirs, driveId, job, loc.blobs, loc.stats);
    let linkChanged = false;
    try {
      await ex.run(acts);
    } finally {
      // 途中で止まっても、合わせた所までは記録に残す（変わらなければ書かない）
      if (linkSig(link) !== before) {
        link.syncedAt = this.now();
        await writeIn(dir, LINK_FILE, new Blob([JSON.stringify(link)]));
        linkChanged = true;
      }
    }
    // 聞いている・書けなかった・待っているファイルがあれば、次の同期で Drive の中を読み直す
    const recheck = asking.length > 0 || rep.later.length > 0 || rep.wait.length > 0;
    this.st.songs[driveId] = { root: place.root, path: [...place.path], lib: libKey(job.lib), dirs: ex.dirs, title: job.title, ...(recheck ? { recheck: true } : {}) };
    for (const k of Object.keys(this.st.answers)) if (k.startsWith(`f:${driveId}:`) || k === `s:${driveId}` || k === `g:${driveId}`) delete this.st.answers[k];
    // 一覧を読み直す（取ったファイルのほか、送っただけでも「同期する曲」の印が変わる）
    if (ex.wroteLocal || linkChanged || !job.local) this.lib.touched?.(place.root, place.path);
    if (ex.sentAny && job.mode === 'all') await updateMeta(driveId, { description: JSON.stringify(this.infoOf(job, loc.stats)) }).then((f) => (this.mine[f.id] = 'dir')).catch(() => {});
    return rep;
  }

  private infoOf(job: Job, stats: Map<string, LocalStat>): SongInfo {
    const files = [...stats.values()];
    return { t: job.title, a: job.artist, b: job.local?.bpm ?? '', u: this.now(), n: files.length, s: files.reduce((a, f) => a + f.size, 0) };
  }

  // Exec から使う
  get pc() {
    return this.set.pc;
  }
  noteMine(id: string, md5: string) {
    this.mine[id] = md5;
  }
  addBytes(n: number) {
    this.bytes += n;
  }
  step(phase: 'up' | 'down', song: string, file: string) {
    this.tell({ phase, song, file });
  }
  backupFolder(song: string, path: string) {
    return this.backupDir(song, path);
  }
}

/** 計画を実行する（1 曲） */
class Exec {
  wroteLocal = false;
  sentAny = false;
  private n = 0;
  private picks = new Map<string, Record<string, Side>>();

  constructor(
    private readonly r: SyncRun,
    private readonly rep: SongReport,
    private readonly folder: SongFolder,
    private readonly link: DriveLink,
    readonly dirs: Record<string, string>,
    private readonly driveId: string,
    private readonly job: Job,
    private readonly blobs: Map<string, File>,
    private readonly stats: Map<string, LocalStat>,
  ) {}

  async run(acts: Act[]) {
    const size = (a: Act) => ('remote' in a && a.remote ? a.remote.size : (this.stats.get(a.key)?.size ?? 0));
    // 成績をまとめてから（どちらのゴーストにするかが決まる）、小さい物から
    const rank = (a: Act) => (a.op === 'merge' ? 0 : 1);
    const order = [...acts].sort((a, b) => rank(a) - rank(b) || bySize({ size: size(a) }, { size: size(b) }));
    for (const a of order) {
      try {
        await this.one(a);
      } catch (e) {
        if (e instanceof DriveError) throw e;
        // この PC に書けない（DTXMania が開いている）：次の同期で
        this.rep.later.push(a.op === 'drop' ? a.key : a.path);
      }
      if (a.op !== 'same' && a.op !== 'ask' && a.op !== 'drop' && ++this.n % 8 === 0) await writeIn(this.folder.dir!, LINK_FILE, new Blob([JSON.stringify(this.link)])).catch(() => {});
    }
  }

  private rec(key: string, f: { id: string; md5: string; size: number; mtime: number; path: string }) {
    this.link.files[key] = f;
  }

  private chart(key: string) {
    return (scoreGroupOf(key) ?? key).split('/').pop()!;
  }

  private noteGot(a: { key: string; path: string }, bytes: number, dev?: string) {
    if (kindOf(a.path) === 'play') {
      const c = this.chart(a.key);
      if (!this.rep.scoresGot.includes(c)) this.rep.scoresGot.push(c);
    } else this.rep.got.push(a.path);
    this.rep.gotBytes += bytes;
    if (dev && dev !== this.r.pc) this.rep.from = dev;
  }

  private noteSent(a: { key: string; path: string }, bytes: number) {
    if (kindOf(a.path) === 'play') {
      const c = this.chart(a.key);
      if (!this.rep.scoresSent.includes(c)) this.rep.scoresSent.push(c);
    } else this.rep.sent.push(a.path);
    this.rep.sentBytes += bytes;
    this.sentAny = true;
  }

  /** Drive から取って、この PC に書く（書く直前に、この PC のファイルが比べたあとで変わっていないか見る） */
  private async get(key: string, path: string, remote: RemoteStat): Promise<File> {
    this.r.step('down', this.job.title, path.split('/').pop()!);
    const blob = await download(remote.id);
    const at = this.folder.files.get(key)?.path ?? path;
    const was = this.stats.get(key);
    const cur = await statNow(this.folder.dir!, at);
    if (was ? !cur || cur.size !== was.size || cur.mtime !== was.mtime : !!cur) throw new Error('changed while syncing');
    const before = isScoreIni(key) && was ? decodeScore(new Uint8Array(await this.file(key).arrayBuffer())).text : null;
    await writeFile(this.folder, at, blob);
    this.wroteLocal = true;
    const file = await this.folder.files.get(normPath(at))!.getFile();
    this.rec(key, { id: remote.id, md5: remote.md5, size: file.size, mtime: file.lastModified, path: at });
    this.r.addBytes(remote.size);
    if (isScoreIni(key)) {
      const text = decodeScore(new Uint8Array(await file.arrayBuffer())).text;
      this.setBase(key, text, remote.md5);
      this.addNews(key, before, text, false);
    }
    return file;
  }

  /** この PC のファイルを Drive に送る（id があれば上書き） */
  private async put(key: string, path: string, id: string | undefined, file: File): Promise<void> {
    this.r.step('up', this.job.title, path.split('/').pop()!);
    const parent = id ? undefined : await this.ensureDir(path);
    const res = await upload({ id, name: path.split('/').pop()!, parent, data: file, modifiedTime: iso(file.lastModified), appProperties: { dev: this.r.pc } });
    this.r.noteMine(res.id, res.md5Checksum ?? '');
    this.rec(key, { id: res.id, md5: res.md5Checksum ?? '', size: file.size, mtime: file.lastModified, path });
    this.r.addBytes(file.size);
    if (isScoreIni(key)) this.setBase(key, decodeScore(new Uint8Array(await file.arrayBuffer())).text, res.md5Checksum ?? '');
  }

  /** 前に合わせたときの成績（両方で遊んだら、ここから増えた分を足す） */
  private setBase(key: string, text: string, md5: string) {
    const g = scoreGroupOf(key)!;
    this.link.scores = { ...this.link.scores, [g]: text };
    this.link.scoresMd5 = { ...this.link.scoresMd5, [g]: md5 };
  }

  /** 取った・まとめた成績（増えた回数・自己ベスト） */
  private addNews(key: string, before: string | null, after: string, merged: boolean) {
    const a = parseScoreIni(after);
    const b = before ? parseScoreIni(before) : null;
    const n: ScoreNews = { chart: this.chart(key), plays: Math.max(0, a.plays - (b?.plays ?? 0)), best: (a.skill ?? 0) > (b?.skill ?? 0), rank: a.rank, skill: a.skill, ...(merged ? { merged: true } : {}) };
    if (!n.plays && !n.best) return;
    (this.rep.news ??= []).push(n);
  }

  /** Drive の曲のフォルダの中のサブフォルダ（無ければ作る） */
  private async ensureDir(path: string): Promise<string> {
    const parts = path.split('/').slice(0, -1);
    let key = '';
    let id = this.driveId;
    for (const p of parts) {
      key = key ? `${key}/${p.toLowerCase()}` : p.toLowerCase();
      const have = this.dirs[key];
      if (have) {
        id = have;
        continue;
      }
      const f = await createFolder(p, id);
      this.r.noteMine(f.id, 'dir');
      id = f.id;
      this.dirs[key] = id;
    }
    return id;
  }

  private file(key: string): File {
    const f = this.blobs.get(key);
    if (!f) throw new Error(`no local file: ${key}`);
    return f;
  }

  private async one(a: Act) {
    switch (a.op) {
      case 'same': {
        const l = this.stats.get(a.key)!;
        this.rec(a.key, { id: a.remote.id, md5: a.remote.md5, size: l.size, mtime: l.mtime, path: l.path });
        // 前の成績が無い・ほかの取り込み（「取り込む」など）で変わった：今の中身にする（両方同じ中身）
        const g = scoreGroupOf(a.key);
        if (isScoreIni(a.key) && g && (!this.link.scores?.[g] || this.link.scoresMd5?.[g] !== a.remote.md5)) this.setBase(a.key, decodeScore(new Uint8Array(await this.file(a.key).arrayBuffer())).text, a.remote.md5);
        return;
      }
      case 'drop':
        delete this.link.files[a.key];
        return;
      case 'up':
        await this.put(a.key, a.path, a.id, this.file(a.key));
        this.noteSent(a, this.file(a.key).size);
        return;
      case 'down':
        await this.get(a.key, a.path, a.remote);
        this.noteGot(a, a.remote.size, a.remote.dev);
        return;
      case 'trash':
        await trashFile(a.remote.id).catch((e) => {
          if (!(e instanceof DriveError && e.status === 404)) throw e;
        });
        delete this.link.files[a.key];
        this.rep.trashed.push(a.path);
        return;
      case 'delete':
        if (!(await removeFile(this.folder, a.path))) {
          this.rep.later.push(a.path);
          return;
        }
        delete this.link.files[a.key];
        this.wroteLocal = true;
        this.rep.deleted.push(a.path);
        return;
      case 'keepLocal': {
        // Drive の版を控えへ写してから、この PC の版を送る
        const dir = await this.r.backupFolder(this.link.name || this.job.lib[this.job.lib.length - 1], a.path);
        const bak = await copyFile(a.remote.id, { name: a.path.split('/').pop()!, parents: [dir], appProperties: { dtxe: 'bak', dev: a.remote.dev ?? '' } });
        this.r.noteMine(bak.id, bak.md5Checksum ?? '');
        const l = this.stats.get(a.key)!;
        await this.put(a.key, a.path, a.remote.id, this.file(a.key));
        this.noteSent(a, l.size);
        this.rep.newer.push({ path: a.path, kept: 'local', backup: bak.id, dev: a.remote.dev, localTime: l.mtime, remoteTime: a.remote.time });
        return;
      }
      case 'keepRemote': {
        // この PC の版を控えへ送ってから、Drive の版を取る
        const dir = await this.r.backupFolder(this.link.name || this.job.lib[this.job.lib.length - 1], a.path);
        const l = this.stats.get(a.key)!;
        const f = this.file(a.key);
        const bak = await upload({ name: a.path.split('/').pop()!, parent: dir, data: f, modifiedTime: iso(l.mtime), appProperties: { dtxe: 'bak', dev: this.r.pc } });
        this.r.noteMine(bak.id, bak.md5Checksum ?? '');
        await this.get(a.key, a.path, a.remote);
        this.noteGot(a, a.remote.size, a.remote.dev);
        this.rep.newer.push({ path: a.path, kept: 'remote', backup: bak.id, dev: a.remote.dev, localTime: l.mtime, remoteTime: a.remote.time });
        return;
      }
      case 'merge': {
        const l = this.stats.get(a.key)!;
        const mine = decodeScore(new Uint8Array(await this.file(a.key).arrayBuffer()));
        const theirs = decodeScore(new Uint8Array(await (await download(a.remote.id)).arrayBuffer()));
        const base = this.link.scores?.[a.group] ?? null;
        const m = mergeScoreIni(base, { text: mine.text, time: l.mtime }, { text: theirs.text, time: a.remote.time });
        this.picks.set(a.group, m.pick);
        const bytes = encodeScore(m.text, mine.encoding === 'utf-8' ? 'shift_jis' : mine.encoding);
        await writeFile(this.folder, l.path, bytes);
        this.wroteLocal = true;
        const file = await this.folder.files.get(a.key)!.getFile();
        const res = await upload({ id: a.remote.id, name: l.path.split('/').pop()!, data: file, modifiedTime: iso(file.lastModified), appProperties: { dev: this.r.pc } });
        this.r.noteMine(res.id, res.md5Checksum ?? '');
        this.rec(a.key, { id: res.id, md5: res.md5Checksum ?? '', size: file.size, mtime: file.lastModified, path: l.path });
        this.setBase(a.key, m.text, res.md5Checksum ?? '');
        // 前にまとめた成績が無い（初めて）：同じ回数を 2 回数えないよう、回数は多い方
        this.rep.merged.push({ chart: this.chart(a.key), plays: drumSummary(m.text).plays - drumSummary(mine.text).plays, ...(base === null ? { max: true } : {}) });
        this.addNews(a.key, mine.text, m.text, true);
        if (a.remote.dev && a.remote.dev !== this.r.pc) this.rep.from = a.remote.dev;
        return;
      }
      case 'ghost': {
        const l = this.stats.get(a.key)!;
        const sec = ghostSection(a.path)?.toLowerCase() ?? '';
        const side = this.picks.get(a.group)?.[sec] ?? (l.mtime > a.remote.time ? 'local' : 'remote');
        if (side === 'remote') await this.get(a.key, a.path, a.remote);
        else await this.put(a.key, a.path, a.remote.id, this.file(a.key));
        return;
      }
      case 'ask':
        return;
      case 'wait':
        this.rep.wait.push(a.path);
        return;
    }
  }
}

/** 計画から、何が起きるか（下見） */
function summarize(rep: SongReport, acts: readonly Act[], local: Map<string, LocalStat>, remote: Map<string, RemoteStat>) {
  const chart = (key: string) => (scoreGroupOf(key) ?? key).split('/').pop()!;
  const add = (list: string[], c: string) => {
    if (!list.includes(c)) list.push(c);
  };
  for (const a of acts) {
    const play = kindOf(a.op === 'drop' ? a.key : a.path) === 'play';
    switch (a.op) {
      case 'up':
      case 'keepLocal': {
        const size = local.get(a.key)?.size ?? 0;
        if (play) add(rep.scoresSent, chart(a.key));
        else rep.sent.push(a.path);
        rep.sentBytes += size;
        if (a.op === 'keepLocal') rep.newer.push({ path: a.path, kept: 'local', dev: a.remote.dev, localTime: local.get(a.key)!.mtime, remoteTime: a.remote.time });
        break;
      }
      case 'down':
      case 'keepRemote':
        if (play) add(rep.scoresGot, chart(a.key));
        else rep.got.push(a.path);
        rep.gotBytes += a.remote.size;
        if (a.remote.dev) rep.from = a.remote.dev;
        if (a.op === 'keepRemote') rep.newer.push({ path: a.path, kept: 'remote', dev: a.remote.dev, localTime: local.get(a.key)!.mtime, remoteTime: a.remote.time });
        break;
      case 'merge':
        rep.merged.push({ chart: chart(a.key), plays: 0 });
        break;
      case 'trash':
        rep.trashed.push(a.path);
        break;
      case 'delete':
        rep.deleted.push(a.path);
        break;
      case 'wait':
        rep.wait.push(a.path);
        break;
      default:
        break;
    }
  }
  void remote;
}

/**
 * 曲のファイルの多くが片方で一度に消えていたら（フォルダを空にした・Drive のファイルを間違って消した）、消さずに戻す。
 * 作るファイルの 8 割以上・3 個以上を消す計画は、消す代わりに送り直す・取り直す
 */
function guardMass(acts: Act[], local: Map<string, LocalStat>, remote: Map<string, RemoteStat>): { acts: Act[]; kept: number } {
  const makeLocal = [...local.keys()].filter((k) => kindOf(k) === 'make').length;
  const makeRemote = [...remote.keys()].filter((k) => kindOf(k) === 'make').length;
  const dels = acts.filter((a) => a.op === 'delete').length;
  const trs = acts.filter((a) => a.op === 'trash').length;
  const undoDel = dels >= 3 && dels >= makeLocal * 0.8;
  const undoTrash = trs >= 3 && trs >= makeRemote * 0.8;
  if (!undoDel && !undoTrash) return { acts, kept: 0 };
  let kept = 0;
  const out = acts.map((a): Act => {
    if (undoDel && a.op === 'delete') {
      kept++;
      return { op: 'up', key: a.key, path: a.path, why: 'restore' };
    }
    if (undoTrash && a.op === 'trash') {
      kept++;
      return { op: 'down', key: a.key, path: a.path, remote: a.remote, why: 'restore' };
    }
    return a;
  });
  return { acts: out, kept };
}

/** つなぎの記録の中身（合わせた時刻は除く。変わったときだけ書く） */
function linkSig(l: DriveLink): string {
  return JSON.stringify({ ...l, syncedAt: 0 });
}

/** 同期の設定（変わったら、Drive の曲の中を全部読み直す） */
function settingsSig(s: SyncSettings): string {
  return JSON.stringify([s.scope, [...s.boxes].sort(), [...s.songs].sort(), s.video, s.scores, s.scoresOnly, s.importBox]);
}

function hasNews(r: SongReport): boolean {
  return !!(r.sent.length || r.got.length || r.merged.length || r.scoresGot.length || r.scoresSent.length || r.newer.length || r.trashed.length || r.deleted.length || r.later.length || r.wait.length || r.kept);
}

/** 曲のフォルダの中のファイルの、今の大きさと更新時刻（無ければ null） */
async function statNow(dir: FileSystemDirectoryHandle, path: string): Promise<{ size: number; mtime: number } | null> {
  const parts = path.split('/');
  try {
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const f = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    return { size: f.size, mtime: f.lastModified };
  } catch {
    return null;
  }
}

/** 曲のフォルダのつなぎの記録（無い・読めないなら null） */
async function linkAt(dir: FileSystemDirectoryHandle): Promise<DriveLink | null> {
  try {
    const f = await fileIn(dir, LINK_FILE);
    return f ? parseLink(await (await f.getFile()).text()) : null;
  } catch {
    return null;
  }
}

async function fileIn(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  const want = name.toLowerCase();
  for await (const [n, h] of dir.entries()) if (h.kind === 'file' && n.toLowerCase() === want) return h as FileSystemFileHandle;
  return null;
}

async function writeIn(dir: FileSystemDirectoryHandle, name: string, data: Blob) {
  const have = await fileIn(dir, name);
  const fh = have ?? (await dir.getFileHandle(name, { create: true }));
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/** 1 回同期する */
export function runSync(o: RunOptions): Promise<RunReport> {
  return new SyncRun(o).run();
}

async function songDirAt(lib: LibAccess, root: string, path: readonly string[]): Promise<FileSystemDirectoryHandle | null> {
  let dir = await lib.rootDir(root);
  for (const p of path) dir = dir ? await dir.getDirectoryHandle(p).catch(() => null) : null;
  return dir;
}

/**
 * この曲の同期をやめる：Drive の曲のフォルダをゴミ箱へ（30 日は戻せる。ほかの PC は曲を残して同期から外す）。
 * この PC の曲はそのまま残し、「同期しない」の印を付ける
 */
export async function stopSong(o: { lib: LibAccess; state: SyncState; root: string; path: string[] }): Promise<void> {
  const dir = await songDirAt(o.lib, o.root, o.path);
  if (!dir) throw new Error(tr('曲のフォルダを開けません', "Can't open the song folder"));
  const f = await fileIn(dir, LINK_FILE);
  const link = f ? parseLink(await (await f.getFile()).text()) : null;
  if (link) {
    await trashFile(link.folderId).catch((e) => {
      if (!(e instanceof DriveError && e.status === 404)) throw e;
    });
    delete o.state.songs[link.folderId];
  }
  await writeIn(dir, LINK_FILE, new Blob([JSON.stringify({ v: 1, skip: true })]));
  o.lib.touched?.(o.root, o.path);
}

/** 「同期しない」にした曲を、また同期する（印を消す。次の同期で送る） */
export async function resumeSong(o: { lib: LibAccess; root: string; path: string[] }): Promise<void> {
  const dir = await songDirAt(o.lib, o.root, o.path);
  if (!dir) throw new Error(tr('曲のフォルダを開けません', "Can't open the song folder"));
  const f = await fileIn(dir, LINK_FILE);
  if (f && !parseLink(await (await f.getFile()).text())) await dir.removeEntry(f.name);
  o.lib.touched?.(o.root, o.path);
}

/** 控えの版に戻す（その版をもう一度新しい方として送る。どちらの PC もその版になる） */
export async function restoreBackup(o: { lib: LibAccess; state: SyncState; settings: SyncSettings; driveId: string; path: string; backupId: string }): Promise<void> {
  const s = o.state.songs[o.driveId];
  if (!s) throw new Error(tr('この曲はもう同期していません', 'This song is no longer synced'));
  let dir = await o.lib.rootDir(s.root);
  for (const p of s.path) dir = dir ? await dir.getDirectoryHandle(p).catch(() => null) : null;
  if (!dir) throw new Error(tr('曲のフォルダを開けません', "Can't open the song folder"));
  const loc = await readLocal(dir, s.path[s.path.length - 1] ?? '');
  const { link } = await readLinkOf(loc.folder);
  if (!link) throw new Error(tr('この曲はもう同期していません', 'This song is no longer synced'));
  const key = normPath(o.path);
  const blob = await download(o.backupId);
  const at = loc.folder.files.get(key)?.path ?? o.path;
  await writeFile(loc.folder, at, blob);
  const file = await loc.folder.files.get(normPath(at))!.getFile();
  const rec = link.files[key] as (typeof link.files)[string] | undefined;
  let id: string | undefined = rec?.id;
  let parent: string | undefined;
  if (!id) {
    parent = o.driveId;
    for (const seg of at.split('/').slice(0, -1)) {
      const kids = await listChildren(parent);
      parent = kids.find((k) => k.mimeType === FOLDER_MIME && k.name.toLowerCase() === seg.toLowerCase())?.id ?? (await createFolder(seg, parent)).id;
    }
  }
  let res: DriveFile;
  try {
    res = await upload({ id, name: at.split('/').pop()!, parent, data: file, modifiedTime: iso(file.lastModified), appProperties: { dev: o.settings.pc } });
  } catch (e) {
    if (!(e instanceof DriveError && e.status === 404)) throw e;
    id = undefined;
    res = await upload({ name: at.split('/').pop()!, parent: o.driveId, data: file, modifiedTime: iso(file.lastModified), appProperties: { dev: o.settings.pc } });
  }
  o.state.mine[res.id] = res.md5Checksum ?? '';
  link.files[key] = { id: res.id, md5: res.md5Checksum ?? '', size: file.size, mtime: file.lastModified, path: at };
  await writeIn(dir, LINK_FILE, new Blob([JSON.stringify(link)]));
  o.lib.touched?.(s.root, s.path);
}

export type { BaseRec };
