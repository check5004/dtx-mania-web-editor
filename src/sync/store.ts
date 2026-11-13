// PC どうしの同期の、画面の状態といつ動かすか（開いたとき・開いている間は 5 分ごと・保存したとき・「今すぐ同期」）。
// 本体は src/sync/engine.ts。DTXMania の曲の一覧（src/nxlib/store.ts）から、どこを合わせるかを渡す。
// 設定はこのブラウザ（localStorage）、記録（どの曲をどこと合わせたか）と同期の記録は IndexedDB に残す。
import { create } from 'zustand';
import { tr } from '../i18n';
import { DriveError, storageQuota } from '../drive/api';
import { signIn, tokenValid, useDriveAuth } from '../drive/auth';
import { forgetRoot } from '../drive/sync';
import { isDiskFolder, type SongFolder } from '../fs/folder';
import { loadKv, saveKv } from '../nxlib/db';
import type { LibSong } from '../nxlib/scan';
import { dropNxFolder, ensureNxPerm, nxPlaceOf, refreshNxFolder, rootDirOf, useNxLib } from '../nxlib/store';
import { outsideRel, rootSpecs } from '../nxlib/view';
import { toast, useEditor } from '../store/editor';
import { libKey, restoreBackup, resumeSong, runSync, stopSong, type LibAccess, type LibSongRef } from './engine';
import { VIDEO_FILE, kindOf } from './kind';
import { DEFAULT_SETTINGS, emptyState, type RunReport, type SyncProgressInfo, type SyncSettings, type SyncState } from './types';

const SETTINGS_KEY = 'dtxe.pcsync';
const STATE_ID = 'sync:state';
const LOG_ID = 'sync:log';
/** 開いている間に合わせる間 */
export const SYNC_EVERY = 5 * 60_000;
/** 記録を残す日数 */
const LOG_DAYS = 30;

export type PcSyncStatus = 'off' | 'idle' | 'busy' | 'auth' | 'perm' | 'error';

/** 記録の 1 件（1 回の同期）。done は「これでよい」を押した物（newer の path） */
export type LogEntry = RunReport & { done?: string[] };

export interface PcSyncState {
  settings: SyncSettings;
  state: SyncState;
  /** 同期の記録（新しい順） */
  log: LogEntry[];
  /** IndexedDB から読み終えた */
  loaded: boolean;
  status: PcSyncStatus;
  error: string;
  progress: SyncProgressInfo | null;
  /** 次に 5 分ごとの同期をする時刻 */
  next: number;
  /** 初めての同期の下見（画面 5） */
  preview: RunReport | null;
  previewing: boolean;
  /** 開いている画面 */
  panel: null | 'setup' | 'first' | 'log';
}

function readSettings(): SyncSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<SyncSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const usePcSync = create<PcSyncState>(() => ({
  settings: readSettings(),
  state: emptyState(),
  log: [],
  loaded: false,
  status: 'off',
  error: '',
  progress: null,
  next: 0,
  preview: null,
  previewing: false,
  panel: null,
}));

const get = usePcSync.getState;
const set = usePcSync.setState;

export function saveSettings(p: Partial<SyncSettings>) {
  const settings = { ...get().settings, ...p };
  set({ settings });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 覚えられなくても、この画面の間は使える
  }
}

let saving: Promise<void> = Promise.resolve();
function saveState() {
  const st = get().state;
  saving = saving.then(() => saveKv(STATE_ID, st)).catch(() => {});
}
function saveLog() {
  const log = get().log;
  saving = saving.then(() => saveKv(LOG_ID, log)).catch(() => {});
}

/** この PC の印（.sync/<pcId>.json） */
function newPcId(): string {
  return `pc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 同期する（設定で on） */
export function pcSyncOn(): boolean {
  return get().settings.on;
}

// ---- DTXMania の曲の一覧から、どこを合わせるか ------------------------------------------

/** 同期で書いた曲のフォルダ（終わったら一覧を読み直す） */
const touchedSongs = new Map<string, { root: string; path: string[] }>();

async function libAccess(): Promise<LibAccess | null> {
  const nx = useNxLib.getState();
  const place = nx.place;
  if (!place) return null;
  const specs = rootSpecs(place);
  const mainKey = specs[0]?.key ?? '';
  // ゲームのフォルダそのもの（DTXPath が「.\」）なら、DTXFiles の中が Drive の DTXFiles
  const lead = outsideRel(place, nx.songs, nx.boxes);
  const names = new Map<string, string>();
  for (const sp of specs.slice(1)) {
    const d = await rootDirOf(sp.key);
    if (d) names.set(sp.key, d.name);
  }
  const low = (x: string) => x.toLowerCase();
  const songs: LibSongRef[] = nx.songs.map((s) => ({ root: s.root, path: s.path, title: s.title, artist: s.artist, bpm: s.bpm, edited: s.edited, drive: s.drive?.state ?? null, charts: s.charts.length, updated: s.updated }));
  return {
    songs,
    rootDir: (root) => rootDirOf(root),
    libPath: (root, path) => {
      if (root === mainKey) {
        if (lead.length && path.length > lead.length && lead.every((x, i) => low(x) === low(path[i]))) return path.slice(lead.length);
        return [...path];
      }
      const n = names.get(root);
      return n ? [n, ...path] : null;
    },
    placeOf: (lib) => ({ root: mainKey, path: [...lead, ...lib] }),
    isOpen: async (dir) => {
      const f = useEditor.getState().folder;
      if (!f?.dir) return false;
      try {
        return await f.dir.isSameEntry(dir);
      } catch {
        return false;
      }
    },
    touched: (root, path) => touchedSongs.set(`${root}:${path.join('/')}`, { root, path: [...path] }),
  };
}

async function refreshTouched() {
  const list = [...touchedSongs.values()];
  touchedSongs.clear();
  for (const t of list) {
    const root = await rootDirOf(t.root);
    let dir: FileSystemDirectoryHandle | null = root;
    for (const p of t.path) dir = dir ? await dir.getDirectoryHandle(p).catch(() => null) : null;
    if (dir) await refreshNxFolder(t.root, t.path).catch(() => {});
    else await dropNxFolder(t.root, t.path).catch(() => {});
  }
}

/** 曲のフォルダを PC どうしの同期で合わせるか（同期が on で、DTXMania の曲の中）。合わせるなら一覧の場所 */
export async function pcSyncPlace(folder: SongFolder | null | undefined): Promise<{ root: string; path: string[] } | null> {
  if (!get().settings.on || !folder || !isDiskFolder(folder) || folder.local) return null;
  return nxPlaceOf(folder.dir).catch(() => null);
}

// ---- 動かす -------------------------------------------------------------------------

interface RunAsk {
  why: RunReport['why'];
  only?: { root: string; path: string[]; title?: string };
  take?: boolean;
}

/** 同期が終わったら（開いている曲に Drive の新しい譜面があれば知らせる。src/app/driveActions.ts） */
type ReportListener = (rep: RunReport, o: { why: RunReport['why']; take: boolean }) => void;
const listeners = new Set<ReportListener>();
export function onPcSyncReport(fn: ReportListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let queue: Promise<unknown> = Promise.resolve();
let running = false;
let waitingTimer = false;

function canRun(): PcSyncStatus | null {
  const s = get();
  if (!s.settings.on) return 'off';
  const nx = useNxLib.getState();
  if (!nx.ready || !nx.place) return 'perm';
  if (nx.perm !== 'granted') return 'perm';
  const a = useDriveAuth.getState();
  if (!a.connected || !tokenValid()) return 'auth';
  return null;
}

/** 1 回同期する（順番に。同じ時に 2 つは動かさない） */
function enqueue(ask: RunAsk): Promise<RunReport | null> {
  const job = queue.then(() => runOne(ask));
  queue = job.catch(() => null);
  return job;
}

async function runOne(ask: RunAsk): Promise<RunReport | null> {
  await loadStored();
  const block = canRun();
  if (block) {
    set({ status: block === 'off' ? 'off' : block });
    return null;
  }
  // 一覧を読んでいる間は待つ（読み終えていない曲を「無い」と間違えない）
  for (let i = 0; i < 600 && useNxLib.getState().scan; i++) await new Promise((r) => setTimeout(r, 500));
  if (useNxLib.getState().scan) return null;
  const lib = await libAccess();
  if (!lib) return null;
  const s = get();
  const account = useDriveAuth.getState().email;
  // 別の Google アカウントになった：記録を初めから
  if (s.state.account && account && s.state.account !== account) set({ state: emptyState(account) });
  const state = get().state;
  state.account ||= account;
  running = true;
  set({ status: 'busy', error: '', progress: null });
  let rep: RunReport | null = null;
  try {
    rep = await runSync({ settings: s.settings, lib, state, why: ask.why, only: ask.only, take: ask.take, progress: (p) => set({ progress: p }) });
    set({ status: 'idle', state: { ...state }, ...(ask.only ? {} : { next: Date.now() + SYNC_EVERY }) });
    addLog(rep);
    for (const fn of listeners) fn(rep, { why: ask.why, take: !!ask.take });
    return rep;
  } catch (e) {
    const auth = e instanceof DriveError && e.reason === 'auth';
    const msg = auth ? tr('Google Drive のログインが切れました', 'Your Google Drive sign-in expired') : errText(e);
    set({ status: auth ? 'auth' : 'error', error: msg, state: { ...state } });
    if (!auth) addLog({ at: Date.now(), pc: s.settings.pc, why: ask.why, songs: [], asks: [], error: msg });
    return null;
  } finally {
    running = false;
    set({ progress: null });
    saveState();
    await refreshTouched();
  }
}

function errText(e: unknown): string {
  if (e instanceof DriveError && /storageQuotaExceeded|quotaExceeded/i.test(e.reason)) return tr('Google Drive がいっぱいです。空きを作るか、同期する曲を減らしてください', 'Google Drive is full. Free up space or sync fewer songs');
  return (e as Error)?.message || String(e);
}

/** 記録に足す（何かあった同期だけ。古い物は消す） */
function addLog(rep: RunReport) {
  if (!rep.songs.length && !rep.asks.length && !rep.error) {
    // 何も無い同期は、聞いていることが無くなったことだけ前の記録に映す
    const log = get().log;
    if (log[0]?.asks.length && !rep.asks.length && !rep.dry) {
      set({ log: [{ ...log[0], asks: [] }, ...log.slice(1)] });
      saveLog();
    }
    return;
  }
  const limit = Date.now() - LOG_DAYS * 86_400_000;
  // 聞いていることは、いちばん新しい記録にだけ残す
  const prev = get().log.map((l) => (rep.asks.length || l.asks.length ? { ...l, asks: [] } : l));
  set({ log: [rep, ...prev].filter((l) => l.at >= limit).slice(0, 300) });
  saveLog();
}

let loading: Promise<void> | null = null;
function loadStored(): Promise<void> {
  loading ??= (async () => {
    const [state, log] = await Promise.all([loadKv<SyncState>(STATE_ID), loadKv<LogEntry[]>(LOG_ID)]);
    set({ state: state?.v === 1 ? state : emptyState(), log: Array.isArray(log) ? log : [], loaded: true });
  })();
  return loading;
}

/** 開いたときと、開いている間の 5 分ごと（同期が on のとき） */
export function initPcSync(): () => void {
  void loadStored();
  let opened = false;
  const tryOpen = () => {
    if (opened || !get().settings.on) return;
    const block = canRun();
    if (block === 'off') return;
    // 一覧をまだ読み出していない：読み出したらもう一度
    if (block === 'perm' && !useNxLib.getState().ready) return;
    if (block) {
      // フォルダの許可が要る・ログインが切れている：上の帯で知らせ、押すと同期
      set({ status: block });
      opened = true;
      return;
    }
    opened = true;
    void enqueue({ why: 'open' });
  };
  const unsubNx = useNxLib.subscribe((s, p) => {
    if (s.ready !== p.ready || s.perm !== p.perm || s.place !== p.place) tryOpen();
  });
  const unsubAuth = useDriveAuth.subscribe((s, p) => {
    if (s.token !== p.token && s.token) {
      // ログインし直した：止まっていたら続ける
      if (get().status === 'auth') void enqueue({ why: 'manual' });
      else tryOpen();
    }
  });
  tryOpen();
  const tick = window.setInterval(() => {
    const s = get();
    if (!s.settings.on || running || waitingTimer) return;
    if (s.next && Date.now() < s.next) return;
    if (document.visibilityState === 'hidden' && s.next) return;
    const block = canRun();
    if (block) {
      if (block !== 'off' && s.status !== block && s.status !== 'error') set({ status: block });
      return;
    }
    waitingTimer = true;
    void enqueue({ why: s.next ? 'timer' : 'open' }).finally(() => {
      waitingTimer = false;
    });
  }, 20_000);
  return () => {
    unsubNx();
    unsubAuth();
    window.clearInterval(tick);
  };
}

/**
 * 「今すぐ同期」・上の帯を押した（操作の中で呼ぶ）。ログインが切れていれば小窓で取り直し、フォルダの許可が要れば聞いてから
 */
export function syncNow(): void {
  const a = useDriveAuth.getState();
  const nx = useNxLib.getState();
  const login = !tokenValid() ? signIn({ action: 'connect' }) : Promise.resolve(true);
  const perm = nx.place && nx.perm !== 'granted' ? ensureNxPerm() : Promise.resolve(true);
  void Promise.all([login, perm]).then(([ok, granted]) => {
    if (!ok) {
      if (!a.connected) toast(tr('Google Drive につないでから同期します', 'Connect Google Drive first'), 'info', 5000);
      return;
    }
    if (!granted) return;
    void enqueue({ why: 'manual' });
  });
}

/** 曲を保存した：その曲だけすぐ送る */
export function syncSaved(place: { root: string; path: string[]; title?: string }): Promise<RunReport | null> {
  if (!get().settings.on) return Promise.resolve(null);
  return enqueue({ why: 'save', only: place });
}

/** 開いている曲に Drive の新しい内容を取り込む（「取り込む」。保存していない変更は先に聞いてある） */
export function syncTake(place: { root: string; path: string[]; title?: string }): Promise<RunReport | null> {
  return enqueue({ why: 'manual', only: place, take: true });
}

// ---- 始める・やめる ---------------------------------------------------------------------

export function openSyncPanel(panel: PcSyncState['panel']) {
  set({ panel });
}

/** 設定の画面の「次へ」：設定を残して、何が起きるかを下見する（まだ何も書かない） */
export async function previewFirst(p: Partial<SyncSettings>): Promise<void> {
  saveSettings({ ...p, pcId: get().settings.pcId || newPcId() });
  set({ panel: 'first', preview: null, previewing: true, error: '' });
  try {
    await loadStored();
    const lib = await libAccess();
    if (!lib) throw new Error(tr('DTXMania のフォルダを選んでください', 'Choose the DTXMania folder first'));
    const st = get();
    // 下見は記録を書きかえないように写しで
    const state: SyncState = JSON.parse(JSON.stringify(st.state));
    const rep = await runSync({ settings: { ...st.settings, on: true }, lib, state, why: 'first', dry: true, progress: (pr) => set({ progress: pr }) });
    set({ preview: rep });
  } catch (e) {
    set({ error: errText(e) });
  } finally {
    set({ previewing: false, progress: null });
  }
}

/** 初めての同期の画面の「同期を始める」：答え（おすすめのまま・変えた物）を入れて同期する */
export async function startFirst(answers: Record<string, string>): Promise<void> {
  const st = get();
  set({ panel: null, preview: null, state: { ...st.state, answers: { ...st.state.answers, ...answers } } });
  saveSettings({ on: true });
  saveState();
  const rep = await enqueue({ why: 'first' });
  if (rep && !rep.error) toast(tr('PC どうしの同期を始めました。記録は上の帯から見られます', 'PC sync has started. See the log from the bar at the top'), 'ok', 6000);
}

/** 同期をやめる（Drive の物とこの PC の曲はそのまま。また始めれば続きから） */
export function stopPcSync() {
  saveSettings({ on: false });
  set({ status: 'off', next: 0 });
}

/** 聞いたことに答える（次の同期で、そのとおりにする） */
export function answerAsk(id: string, answer: string) {
  const st = get();
  set({ state: { ...st.state, answers: { ...st.state.answers, [id]: answer } } });
  saveState();
}

/** 答えて、すぐ同期する（操作の中で呼ぶ） */
export function answerAndSync(answers: Record<string, string>) {
  for (const [id, a] of Object.entries(answers)) answerAsk(id, a);
  syncNow();
}

/** 記録の「これでよい」 */
export function markDone(at: number, path: string) {
  set({ log: get().log.map((l) => (l.at === at ? { ...l, done: [...(l.done ?? []), path] } : l)) });
  saveLog();
}

/** 控えの版に戻す（その版をもう一度新しい方として送る） */
export async function restoreFromLog(at: number, driveId: string, path: string, backupId: string): Promise<void> {
  const lib = await libAccess();
  if (!lib) return;
  const st = get();
  try {
    await restoreBackup({ lib, state: st.state, settings: st.settings, driveId, path, backupId });
    markDone(at, path);
    saveState();
    await refreshTouched();
    toast(tr(`控えの版に戻しました（${path}）。ほかの PC も次の同期でこの版になります`, `Restored the backup (${path}). Other PCs get this version on their next sync`), 'ok', 6000);
  } catch (e) {
    toast(tr(`戻せませんでした: ${errText(e)}`, `Couldn't restore: ${errText(e)}`), 'error', 8000);
  }
}

/** この曲の同期をやめる（Drive の曲のフォルダはゴミ箱へ。PC の曲は残る） */
export async function stopSyncSong(s: Pick<LibSong, 'root' | 'path' | 'title'>): Promise<void> {
  const lib = await libAccess();
  if (!lib) return;
  const st = get();
  await queue.catch(() => {});
  await stopSong({ lib, state: st.state, root: s.root, path: s.path });
  const lk = libKeyOf(lib, s);
  if (lk) saveSettings({ songs: st.settings.songs.filter((x) => x.toLowerCase() !== lk) });
  saveState();
  await refreshTouched();
}

/** 同期していない曲を同期に足す（「同期しない」の印も消す）。すぐ送る */
export async function addSyncSong(s: Pick<LibSong, 'root' | 'path' | 'title'>): Promise<void> {
  const lib = await libAccess();
  if (!lib) return;
  await resumeSong({ lib, root: s.root, path: s.path });
  const lk = libKeyOf(lib, s);
  const st = get();
  if (lk && !st.settings.songs.some((x) => x.toLowerCase() === lk)) saveSettings({ songs: [...st.settings.songs, lk] });
  await refreshTouched();
  void syncSaved({ root: s.root, path: [...s.path], title: s.title });
}

function libKeyOf(lib: LibAccess, s: Pick<LibSong, 'root' | 'path'>): string | null {
  const l = lib.libPath(s.root, s.path);
  return l ? libKey(l) : null;
}

/** 曲・BOX の場所 → Drive での並び（小文字。設定の boxes・songs と比べる）。DTXMania の曲がまだなら null */
export type LibKeyFn = (root: string, path: readonly string[]) => string | null;
export async function libKeyFn(): Promise<LibKeyFn | null> {
  const lib = await libAccess();
  if (!lib) return null;
  return (root, path) => {
    const l = lib.libPath(root, path);
    return l ? libKey(l) : null;
  };
}

/** 曲の Drive での並び（小文字。設定の boxes・songs と比べる） */
export async function songLibKey(s: Pick<LibSong, 'root' | 'path'>): Promise<string | null> {
  const lib = await libAccess();
  return lib ? libKeyOf(lib, s) : null;
}

/** 曲の Drive での並び（同じ PC の中だけで使う。一覧から同期で変わった曲を探すときなど） */
export function songKey(s: Pick<LibSong, 'root' | 'path'>): string {
  return `${s.root}:${s.path.join('/')}`;
}

/** 同期で変わった曲（記録の新しい方から 24 時間。取った・まとめた・新しい方にした・消した） */
export function syncedSongs(log: readonly LogEntry[], since = Date.now() - 86_400_000): Set<string> {
  const out = new Set<string>();
  for (const l of log) {
    if (l.at < since || l.dry) continue;
    for (const s of l.songs) {
      if (!s.path || s.root === undefined) continue;
      if (s.got.length || s.scoresGot.length || s.merged.length || s.newer.length || s.deleted.length) out.add(`${s.root}:${s.path.join('/')}`);
    }
  }
  return out;
}

/** 合わせる曲か（一覧の印。設定と曲から：直した・送った・足した BOX と曲。全部なら全部） */
export function inScope(s: LibSong, settings: SyncSettings, lib: string | null): 'all' | 'play' | null {
  if (!settings.on || s.drive?.state === 'skip') return null;
  if (settings.scope === 'all' || s.edited || (s.drive?.state === 'linked' && !s.drive.play)) return 'all';
  if (lib && settings.songs.some((x) => x.toLowerCase() === lib)) return 'all';
  if (lib && settings.boxes.some((b) => lib.startsWith(`${b.toLowerCase()}/`))) return 'all';
  return settings.scoresOnly && settings.scores ? 'play' : null;
}

// ---- 大きさ（設定の画面） -----------------------------------------------------------------

export interface SongSize {
  bytes: number;
  video: number;
  score: number;
  files: number;
}

/** 曲のフォルダのファイルの大きさ（中身は読まない）。ほかの曲のフォルダの中は数えない */
export async function measureSongs(songs: readonly Pick<LibSong, 'root' | 'path'>[], onProgress?: (done: number, total: number) => void, stop?: () => boolean): Promise<Map<string, SongSize>> {
  const out = new Map<string, SongSize>();
  const folders = new Map<string, Pick<LibSong, 'root' | 'path'>>();
  for (const s of songs) folders.set(songKey(s), s);
  let done = 0;
  for (const [key, s] of folders) {
    if (stop?.()) break;
    const root = await rootDirOf(s.root);
    let dir: FileSystemDirectoryHandle | null = root;
    for (const p of s.path) dir = dir ? await dir.getDirectoryHandle(p).catch(() => null) : null;
    const size: SongSize = { bytes: 0, video: 0, score: 0, files: 0 };
    if (dir) {
      const walk = async (d: FileSystemDirectoryHandle, depth: number) => {
        for await (const [n, h] of d.entries()) {
          if (h.kind === 'file') {
            const f = await (h as FileSystemFileHandle).getFile().catch(() => null);
            if (!f) continue;
            size.bytes += f.size;
            size.files++;
            if (VIDEO_FILE.test(n)) size.video += f.size;
            if (kindOf(n) === 'play') size.score += f.size;
          } else if (depth < 4 && !/\.dtx$/i.test(n)) await walk(h as FileSystemDirectoryHandle, depth + 1);
        }
      };
      await walk(dir, 0).catch(() => {});
    }
    out.set(key, size);
    onProgress?.(++done, folders.size);
  }
  return out;
}

/** Drive の空き（無料の上限など）。読めなければ null */
export async function driveSpace(): Promise<{ limit: number | null; usage: number } | null> {
  if (!tokenValid()) return null;
  try {
    return await storageQuota();
  } catch {
    return null;
  }
}

/** 同期をやめずにアカウントを切った・別の DTXMania のフォルダにした：記録を初めから（Drive の物はそのまま） */
export function resetPcSyncState() {
  forgetRoot();
  set({ state: emptyState(), log: [] });
  saveState();
  saveLog();
}
