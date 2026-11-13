// 「DTXMania の曲」：ゲームのフォルダ（DTXManiaNX.exe のある所）か DTXFiles を覚えて、入っている曲を一覧にする。
// PC の Chrome・Edge だけ（フォルダを覚えて読み書きできるブラウザ。supportsDirectWrite）。
// - 読むのは名前と小さいファイルだけ（src/nxlib/scan.ts）。一覧を出したあとに裏で譜面を全部読んで点検する（check.ts）
// - 一覧・小さい画像・選んだフォルダはこのブラウザ（IndexedDB）に残す。次に開いたらすぐ出し、裏で変わった譜面だけ読み直す
// - 書くのは「set.def を作る・直す」（nxlib/actions.ts）と、保存したとき（app/fileActions.ts）だけ
// - Google Drive には何も送らない（送るのは保存した曲だけ。app/driveActions.ts）
import { create } from 'zustand';
import { tr } from '../i18n';
import { decodeDtx } from '../dtx/encoding';
import { isDiskFolder, supportsDirectWrite } from '../fs/folder';
import { listRecent } from '../fs/recent';
import { toast, useEditor } from '../store/editor';
import { deepCheck, dirAt } from './check';
import { clearNxLib, loadList, loadPlace, loadThumbs, pruneThumbs, saveList, savePlace, saveThumb, type NxExtra, type NxPlace } from './db';
import { dtxPathsOf, relDtxPath } from './parse';
import { boxKeyOf, chartsSig, markDuplicates, scanLibrary, songIdOf, type LibBox, type LibSong, type ScanRoot } from './scan';
import { rootSpecs, type NxFilter, type NxSort } from './view';

export type NxPerm = 'granted' | 'prompt' | 'denied';

export interface NxScan {
  /** 初めての読み込み（前の一覧が無い） */
  first: boolean;
  folders: number;
  songs: number;
}

export interface NxState {
  /** このブラウザで使えるか（PC の Chrome・Edge） */
  supported: boolean;
  /** 残しておいた一覧を読み終えた */
  ready: boolean;
  place: NxPlace | null;
  /** 選んだフォルダを読み書きする許可（Chrome が「毎回許可」を覚えていれば、開いたときから granted） */
  perm: NxPerm;
  songs: LibSong[];
  boxes: LibBox[];
  /** 一覧を読み込んだ時刻 */
  at: number;
  folders: number;
  /** 前の読み込みで読み直した（変わった・増えた）曲の数 */
  changed: number;
  scan: NxScan | null;
  /** 裏の点検（譜面を全部読む）の進み具合 */
  checking: { done: number; total: number } | null;
  /** 曲の id → 小さい画像の URL */
  thumbs: Record<string, string>;
  /** 曲の id → 保存していない続き（自動保存の控え）のある譜面 */
  drafts: Record<string, string[]>;
  /** DTXPath にある外のフォルダの知らせを「あとで」にした */
  outsideLater: boolean;
  // 画面の状態
  q: string;
  sort: NxSort;
  box: string | null;
  filter: NxFilter | null;
  sel: string | null;
}

export const useNxLib = create<NxState>(() => ({
  supported: false,
  ready: false,
  place: null,
  perm: 'prompt',
  songs: [],
  boxes: [],
  at: 0,
  folders: 0,
  changed: 0,
  scan: null,
  checking: null,
  thumbs: {},
  drafts: {},
  outsideLater: false,
  q: '',
  sort: 'updated',
  box: null,
  filter: null,
  sel: null,
}));

const get = useNxLib.getState;
const set = useNxLib.setState;

// ---- 許可 ---------------------------------------------------------------------------

async function isGranted(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    return !dir.queryPermission || (await dir.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

async function askGrant(dir: FileSystemDirectoryHandle): Promise<boolean> {
  if (await isGranted(dir)) return true;
  try {
    return !!dir.requestPermission && (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** 読み書きの許可を聞く（Chrome が 1 回聞く）。押した操作の中で呼ぶ。許可があれば true */
export async function ensureNxPerm(): Promise<boolean> {
  const p = get().place;
  if (!p) return false;
  const ok = await askGrant(p.root);
  // 外のフォルダ（DTXPath の別のドライブ）も一緒に
  if (ok) for (const x of p.extra) if (x.dir) await askGrant(x.dir);
  set({ perm: ok ? 'granted' : 'denied' });
  return ok;
}

// ---- はじめに -------------------------------------------------------------------------

let initing: Promise<void> | null = null;

/** 残しておいた場所・一覧・小さい画像を読む（アプリを開いたとき。フォルダは読まない） */
export function initNxLib(): Promise<void> {
  initing ??= (async () => {
    if (!supportsDirectWrite()) {
      set({ ready: true, supported: false });
      return;
    }
    watchSaves();
    const place = await loadPlace();
    if (!place) {
      set({ ready: true, supported: true });
      return;
    }
    const [list, thumbs, perm] = await Promise.all([loadList(), loadThumbs(), isGranted(place.root)]);
    const urls: Record<string, string> = {};
    for (const [id, t] of thumbs) {
      urls[id] = URL.createObjectURL(t.blob);
      thumbSig.set(id, t.sig);
    }
    set({
      ready: true,
      supported: true,
      place,
      perm: perm ? 'granted' : 'prompt',
      songs: list?.songs ?? [],
      boxes: list?.boxes ?? [],
      at: list?.at ?? 0,
      folders: list?.folders ?? 0,
      thumbs: urls,
    });
    void refreshDrafts();
  })();
  return initing;
}

let watching = false;

/** 曲のフォルダに保存したら、一覧のその曲を読み直す（DTXMania の曲の中のフォルダなら。外なら何もしない） */
function watchSaves() {
  if (watching) return;
  watching = true;
  useEditor.subscribe((s, prev) => {
    if (!s.savedAt || s.savedAt === prev.savedAt || !get().place || !isDiskFolder(s.folder)) return;
    void noteSavedNxFolder(s.folder.dir).catch(() => {});
  });
}

/** 保存の画面で作った BOX を一覧に足す（中の曲は noteSavedNxFolder で入る） */
export function addNxBox(b: LibBox) {
  const boxes = get().boxes;
  if (boxes.some((x) => x.key === b.key)) return;
  set({ boxes: [...boxes, b].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)) });
}

// ---- 場所を選ぶ -----------------------------------------------------------------------

/** 選んだフォルダが何か：ゲームのフォルダ（Config.ini か .exe がある）なら Config.ini の DTXPath を読む */
async function lookAtPlace(dir: FileSystemDirectoryHandle): Promise<{ kind: NxPlace['kind']; dtxPath: string[] }> {
  let config: FileSystemFileHandle | null = null;
  let exe = false;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file') continue;
    if (name.toLowerCase() === 'config.ini') config = h as FileSystemFileHandle;
    else if (/\.exe$/i.test(name)) exe = true;
  }
  if (!config && !exe) return { kind: 'dtxfiles', dtxPath: ['.\\'] };
  let dtxPath = ['.\\'];
  if (config) {
    try {
      dtxPath = dtxPathsOf(decodeDtx(new Uint8Array(await (await config.getFile()).arrayBuffer())).text);
    } catch {
      // 読めなければ NX の既定
    }
  }
  return { kind: 'game', dtxPath };
}

function revokeThumbs() {
  for (const u of Object.values(get().thumbs)) URL.revokeObjectURL(u);
  thumbSig.clear();
}

/**
 * DTXMania のフォルダを選ぶ（ゲームのフォルダか DTXFiles）。押した操作の中で呼ぶ。選んだら読み込みを始める。
 * 前と同じフォルダなら一覧はそのまま（変わった曲だけ読み直す）
 */
export async function pickNxPlace(): Promise<boolean> {
  if (!window.showDirectoryPicker) return false;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker!({ id: 'dtx-nx', mode: 'readwrite' });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) toast(tr(`フォルダを選べませんでした: ${(e as Error).message}`, `Couldn't choose the folder: ${(e as Error).message}`), 'error');
    return false;
  }
  stopNxScan();
  const prev = get().place;
  let same = false;
  try {
    same = !!prev && (await prev.root.isSameEntry(dir));
  } catch {
    same = false;
  }
  const look = await lookAtPlace(dir);
  const extra: NxExtra[] = look.dtxPath
    .filter((p) => !relDtxPath(p))
    .map((path) => ({ path, ...(same ? { dir: prev?.extra.find((x) => x.path.toLowerCase() === path.toLowerCase())?.dir } : {}) }));
  const place: NxPlace = { root: dir, kind: look.kind, name: dir.name, dtxPath: look.dtxPath, extra, at: Date.now() };
  if (!same) {
    revokeThumbs();
    await clearNxLib(false);
    rootDirs.clear();
    set({ songs: [], boxes: [], at: 0, folders: 0, changed: 0, thumbs: {}, drafts: {}, sel: null, box: null, filter: null, checking: null });
  }
  await savePlace(place);
  set({ place, perm: 'granted', outsideLater: false });
  void rescanNx();
  return true;
}

/** DTXPath にある、選んだフォルダの外のフォルダを選ぶ（ブラウザは自分では開けないので）。押した操作の中で呼ぶ */
export async function pickNxExtra(i: number): Promise<boolean> {
  const p = get().place;
  const x = p?.extra[i];
  if (!p || !x || !window.showDirectoryPicker) return false;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker!({ id: 'dtx-nx-extra', mode: 'readwrite' });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) toast(tr(`フォルダを選べませんでした: ${(e as Error).message}`, `Couldn't choose the folder: ${(e as Error).message}`), 'error');
    return false;
  }
  const place: NxPlace = { ...p, extra: p.extra.map((e, j) => (j === i ? { ...e, dir } : e)) };
  await savePlace(place);
  set({ place });
  stopNxScan();
  void rescanNx();
  return true;
}

/** 外のフォルダの知らせを閉じる（この画面の間） */
export function laterNxExtra() {
  set({ outsideLater: true });
}

/** 覚えたフォルダと一覧を忘れる（フォルダのファイルは何も変えない） */
export async function forgetNxPlace(): Promise<void> {
  stopNxScan();
  revokeThumbs();
  rootDirs.clear();
  await clearNxLib(false);
  set({ place: null, perm: 'prompt', songs: [], boxes: [], at: 0, folders: 0, changed: 0, thumbs: {}, drafts: {}, sel: null, box: null, filter: null, checking: null, scan: null });
}

// ---- 探す場所のフォルダ -----------------------------------------------------------------

/** 場所の鍵 → フォルダ（読み込みのたびに作り直す） */
const rootDirs = new Map<string, FileSystemDirectoryHandle>();

/** 探す場所のフォルダを決める。見つからない・許可の無い場所は missing に */
async function resolveRoots(place: NxPlace): Promise<{ roots: ScanRoot[]; missing: string[] }> {
  rootDirs.clear();
  const roots: ScanRoot[] = [];
  const missing: string[] = [];
  for (const r of rootSpecs(place)) {
    let dir: FileSystemDirectoryHandle | null = null;
    if (r.rel) dir = await dirAt(place.root, r.rel).catch(() => null);
    else if (r.extra !== undefined) {
      const x = place.extra[r.extra];
      if (x?.dir && (await isGranted(x.dir))) dir = x.dir;
    }
    if (dir) {
      roots.push({ dir, key: r.key });
      rootDirs.set(r.key, dir);
    } else missing.push(r.key);
  }
  return { roots, missing };
}

/** 場所の鍵のフォルダ */
export async function rootDirOf(key: string): Promise<FileSystemDirectoryHandle | null> {
  const p = get().place;
  if (!p) return null;
  if (!rootDirs.has(key)) await resolveRoots(p);
  return rootDirs.get(key) ?? null;
}

/** 曲のフォルダ（許可が無い・消えたなら null） */
export async function songDirOf(s: Pick<LibSong, 'root' | 'path'>): Promise<FileSystemDirectoryHandle | null> {
  const root = await rootDirOf(s.root);
  if (!root) return null;
  return s.path.length ? dirAt(root, s.path).catch(() => null) : root;
}

// ---- 読み込み -------------------------------------------------------------------------

let scanRun = 0;
let scanning = false;
/** 読み込みが終わったら解ける（読み込み中に別の読み込みを頼まれたら、前のをやめて待つ） */
let scanDone: Promise<void> = Promise.resolve();

/** 読み込み・点検をやめる（読んだ所までは残す） */
export function stopNxScan() {
  scanRun++;
}

export function isNxScanning(): boolean {
  return scanning;
}

/**
 * 曲を探して一覧にする。前の一覧があれば、大きさと更新時刻の同じ譜面は読み直さない（full なら全部読み直す。
 * NX の「Reload Songs」と同じ）。読み終えたら裏で点検する。許可が無ければ何もしない（ensureNxPerm を先に）
 */
export async function rescanNx(o: { full?: boolean } = {}): Promise<void> {
  if (scanning) {
    stopNxScan();
    await scanDone;
    if (scanning) return;
  }
  const st = get();
  const place = st.place;
  if (!place) return;
  if (!(await isGranted(place.root))) {
    set({ perm: 'prompt' });
    return;
  }
  if (scanning) return;
  scanning = true;
  let finish = () => {};
  scanDone = new Promise<void>((res) => (finish = res));
  const run = ++scanRun;
  const stopped = () => run !== scanRun;
  const first = st.songs.length === 0;
  const prevSongs = st.songs;
  const prev = new Map(prevSongs.map((s) => [s.id, s]));
  set({ perm: 'granted', scan: { first, folders: 0, songs: 0 }, checking: null });
  try {
    const { roots, missing } = await resolveRoots(place);
    const found: LibSong[] = [];
    let changed = 0;
    let timer = 0;
    let progress = { folders: 0, songs: 0 };
    const flush = () => {
      timer = 0;
      if (stopped()) return;
      // 初めての読み込みは、見つけた曲から一覧に並べる
      set(first ? { scan: { first, ...progress }, songs: [...found] } : { scan: { first, ...progress } });
    };
    const soon = () => {
      if (!timer) timer = window.setTimeout(flush, 150);
    };
    const r = await scanLibrary(roots, {
      prev,
      reread: o.full,
      stopped,
      onProgress: (p) => {
        progress = p;
        soon();
      },
      onSong: (s) => {
        found.push(s);
        const was = prev.get(s.id);
        if (!was || chartsSig(was.charts) !== chartsSig(s.charts)) changed++;
        soon();
      },
      onImage: (id, fh, sig) => {
        if (thumbSig.get(id) !== sig) queueThumb(id, fh, sig);
      },
    });
    window.clearTimeout(timer);
    // 読み込み中に別のフォルダを選んだ
    if (get().place !== place) return;
    let songs = r.songs;
    let boxes = r.boxes;
    // 許可の無い外のフォルダの曲・やめたときにまだ読んでいない曲は、前の一覧のまま残す
    const keepRoots = new Set(missing);
    const seen = new Set(songs.map((s) => s.id));
    const keep = prevSongs.filter((s) => !seen.has(s.id) && (r.stopped || keepRoots.has(s.root)));
    if (keep.length) {
      songs = [...songs, ...keep].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const bk = new Set(boxes.map((b) => b.key));
      boxes = [...boxes, ...st.boxes.filter((b) => !bk.has(b.key) && (r.stopped || keepRoots.has(b.key.slice(0, b.key.indexOf(':')))))];
      markDuplicates(songs);
    }
    const at = Date.now();
    set({ songs, boxes, at, folders: r.folders, changed, scan: null, sel: get().sel && songs.some((s) => s.id === get().sel) ? get().sel : null });
    await saveList({ at, songs, boxes, folders: r.folders });
    if (!r.stopped) void pruneThumbs(new Set(songs.map((s) => s.id)));
    void refreshDrafts();
    if (!r.stopped && songs.length === 0 && roots.length) {
      toast(tr('曲が見つかりませんでした。DTXMania のフォルダ（.exe のある所）か DTXFiles を選んでください', 'No songs were found. Choose the DTXMania folder (where its .exe is) or DTXFiles'), 'warn', 8000);
    }
  } catch (e) {
    set({ scan: null });
    toast(tr(`曲を読めませんでした: ${(e as Error).message}`, `Couldn't read the songs: ${(e as Error).message}`), 'error', 8000);
  } finally {
    scanning = false;
    finish();
  }
  if (run === scanRun && get().place === place) void runChecks(run);
}

/** 点検（譜面を全部読む）を、まだの曲・譜面が変わった曲だけ裏で */
async function runChecks(run: number) {
  const todo = get().songs.filter((s) => s.checkedSig !== chartsSig(s.charts));
  if (!todo.length) return;
  let done = 0;
  const updated = new Map<string, LibSong>();
  const flush = () => {
    if (run !== scanRun) return;
    const m = new Map(updated);
    updated.clear();
    set((st) => ({ songs: m.size ? st.songs.map((s) => m.get(s.id) ?? s) : st.songs, checking: { done, total: todo.length } }));
  };
  set({ checking: { done: 0, total: todo.length } });
  const timer = window.setInterval(flush, 500);
  try {
    let i = 0;
    const worker = async () => {
      while (i < todo.length && run === scanRun) {
        const s = todo[i++];
        try {
          const dir = await songDirOf(s);
          if (dir) {
            const r = await deepCheck(dir, s);
            updated.set(s.id, { ...s, checks: r.checks, checkedSig: r.checkedSig, refs: r.refs, drums: r.drums });
          }
        } catch {
          // 読めない曲は点検しない（次の読み込みでもう一度）
        }
        done++;
      }
    };
    await Promise.all([worker(), worker()]);
  } finally {
    window.clearInterval(timer);
    flush();
    if (run === scanRun) {
      set({ checking: null });
      const st = get();
      await saveList({ at: st.at, songs: st.songs, boxes: st.boxes, folders: st.folders });
    }
  }
}

/**
 * 1 曲のフォルダだけ読み直す（保存した・set.def を作った）。rel は場所からのフォルダの並び。
 * 一覧に無ければ足す（新しく保存した曲）
 */
export async function refreshNxFolder(rootKey: string, rel: readonly string[]): Promise<void> {
  const place = get().place;
  if (!place) return;
  const root = await rootDirOf(rootKey);
  const dir = root && (rel.length ? await dirAt(root, rel).catch(() => null) : root);
  if (!dir) return;
  const path = [...rel];
  const prefix = songIdOf(rootKey, path, 0).replace(/#0$/, '#');
  const st = get();
  const prev = new Map(st.songs.filter((s) => s.id.startsWith(prefix)).map((s) => [s.id.replace(prefix, `${rootKey}:#`), s]));
  const r = await scanLibrary([{ dir, key: rootKey }], {
    maxDepth: 0,
    prev,
    onImage: (id, fh, sig) => {
      const real = id.replace(`${rootKey}:#`, prefix);
      if (thumbSig.get(real) !== sig) queueThumb(real, fh, sig);
    },
  });
  // この曲のフォルダが入っている BOX（外から順に）
  const boxKeys = new Set(st.boxes.map((b) => b.key));
  const box: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const k = boxKeyOf(rootKey, path.slice(0, i));
    if (boxKeys.has(k)) box.push(k);
  }
  const old = st.songs.find((s) => s.id.startsWith(prefix));
  const fresh = r.songs.map((s) => ({ ...s, id: songIdOf(rootKey, path, s.block), path, box, doubled: old?.doubled ?? false }));
  const songs = [...st.songs.filter((s) => !s.id.startsWith(prefix)), ...fresh].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  markDuplicates(songs);
  set({ songs });
  await saveList({ at: st.at || Date.now(), songs, boxes: st.boxes, folders: st.folders });
  void refreshDrafts();
  // 変わった曲だけ点検し直す
  const run = scanRun;
  if (!scanning) void runChecks(run);
}

/** 1 曲のフォルダを一覧から外す（PC どうしの同期で、ほかの PC で消した曲を消した） */
export async function dropNxFolder(rootKey: string, rel: readonly string[]): Promise<void> {
  const prefix = songIdOf(rootKey, [...rel], 0).replace(/#0$/, '#');
  const st = get();
  if (!st.songs.some((s) => s.id.startsWith(prefix))) return;
  const songs = st.songs.filter((s) => !s.id.startsWith(prefix));
  set({ songs, ...(st.sel?.startsWith(prefix) ? { sel: null } : {}) });
  await saveList({ at: st.at || Date.now(), songs, boxes: st.boxes, folders: st.folders });
}

/** 曲のフォルダの、一覧の場所の鍵と場所からの並び（一覧の場所の外なら null） */
export async function nxPlaceOf(dir: FileSystemDirectoryHandle): Promise<{ root: string; path: string[] } | null> {
  const place = get().place;
  if (!place || !(await isGranted(place.root))) return null;
  if (!rootDirs.size) await resolveRoots(place);
  for (const [key, root] of rootDirs) {
    try {
      const rel = await root.resolve(dir);
      if (rel) return { root: key, path: rel };
    } catch {
      // 見られない
    }
  }
  return null;
}

/** 保存したフォルダが一覧の場所の中なら、その曲を読み直す（一覧に無ければ足す） */
export async function noteSavedNxFolder(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const place = get().place;
  if (!place || !(await isGranted(place.root))) return false;
  if (!rootDirs.size) await resolveRoots(place);
  for (const [key, root] of rootDirs) {
    let rel: string[] | null = null;
    try {
      rel = await root.resolve(dir);
    } catch {
      rel = null;
    }
    if (rel) {
      await refreshNxFolder(key, rel);
      return true;
    }
  }
  return false;
}

// ---- 小さい画像 -----------------------------------------------------------------------

/** 曲の id → 画像の印（大きさと更新時刻）。同じなら作り直さない */
const thumbSig = new Map<string, string>();
const thumbQueue: { id: string; fh: FileSystemFileHandle; sig: string }[] = [];
let thumbActive = 0;
let thumbTimer = 0;
const newThumbs: Record<string, string> = {};

/** 短い辺を THUMB_PX にした JPEG（一覧は 46px、詳しい所は 128px で、cover で切り抜いて出す） */
const THUMB_PX = 192;

async function makeThumb(fh: FileSystemFileHandle): Promise<Blob | null> {
  const file = await fh.getFile();
  if (file.size > 32 * 1024 * 1024) return null;
  const bmp = await createImageBitmap(file);
  try {
    const k = Math.min(1, THUMB_PX / Math.max(1, Math.min(bmp.width, bmp.height)));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
      return await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    return await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.86));
  } finally {
    bmp.close();
  }
}

function queueThumb(id: string, fh: FileSystemFileHandle, sig: string) {
  thumbQueue.push({ id, fh, sig });
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbActive < 2 && thumbQueue.length) {
    const t = thumbQueue.shift()!;
    thumbActive++;
    void (async () => {
      try {
        const blob = await makeThumb(t.fh);
        if (!blob) return;
        thumbSig.set(t.id, t.sig);
        await saveThumb(t.id, t.sig, blob);
        newThumbs[t.id] = URL.createObjectURL(blob);
        if (!thumbTimer) thumbTimer = window.setTimeout(flushThumbs, 200);
      } catch {
        // 読めない画像（TGA など）は画像なしで出す
      }
    })().finally(() => {
      thumbActive--;
      pumpThumbs();
    });
  }
}

function flushThumbs() {
  thumbTimer = 0;
  const add = { ...newThumbs };
  for (const k of Object.keys(newThumbs)) delete newThumbs[k];
  set((st) => {
    for (const k of Object.keys(add)) if (st.thumbs[k]) URL.revokeObjectURL(st.thumbs[k]);
    return { thumbs: { ...st.thumbs, ...add } };
  });
}

// ---- 保存していない続き ----------------------------------------------------------------

/** 最近の曲の控えのうち、保存していない続きのある譜面（曲のフォルダの名前と譜面の名前で見る） */
export async function refreshDrafts(): Promise<void> {
  let all;
  try {
    all = await listRecent();
  } catch {
    return;
  }
  const by = new Map<string, number>();
  for (const e of all) if (!e.saved && e.dir && !e.local) by.set(e.id, e.updatedAt);
  const drafts: Record<string, string[]> = {};
  if (by.size) {
    const placeName = get().place?.name ?? '';
    for (const s of get().songs) {
      const folder = s.path[s.path.length - 1] ?? rootDirs.get(s.root)?.name ?? placeName;
      for (const c of s.charts) {
        const name = c.file.split('/').pop() ?? c.file;
        const t = by.get(`${folder}/${name}`.toLowerCase());
        if (t !== undefined && t >= c.mtime) (drafts[s.id] ??= []).push(c.file);
      }
    }
  }
  set({ drafts });
}

// ---- 画面の状態 -----------------------------------------------------------------------

export function setNxView(p: Partial<Pick<NxState, 'q' | 'sort' | 'box' | 'filter' | 'sel'>>) {
  set(p);
}
