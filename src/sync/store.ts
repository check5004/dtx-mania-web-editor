// PC どうしの同期の、画面の状態といつ動かすか（開いたとき・開いている間は 5 分ごと・保存したとき・「今すぐ同期」）。
// 本体は src/sync/engine.ts。DTXMania の曲の一覧（src/nxlib/store.ts）から、どこを合わせるかを渡す。
// 設定はこのブラウザ（localStorage）、記録（どの曲をどこと合わせたか）と同期の記録は IndexedDB に残す。
// 同じブラウザで窓・タブを 2 つ開いても（ホーム画面のアプリとタブなど）、記録を書くことは 1 つずつ（src/sync/lock.ts）で、
// 書く前に毎回 IndexedDB と localStorage から読み直す。書いたら、ほかの窓に知らせて読み直してもらう（PING_KEY）。
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
import { holdLock, lockHeld, withSyncLock } from './lock';
import { addRun, type LogEntry } from './runlog';
import { DEFAULT_SETTINGS, emptyState, type RunReport, type SyncProgressInfo, type SyncSettings, type SyncState } from './types';

export type { LogEntry };

const SETTINGS_KEY = 'dtxe.pcsync';
/** 記録を書いた・同期した（ほかの窓・タブに知らせる。localStorage の storage は、書いた窓のほかにだけ届く） */
const PING_KEY = 'dtxe.pcsync.ping';
const STATE_ID = 'sync:state';
const LOG_ID = 'sync:log';
/** 開いている間に合わせる間 */
export const SYNC_EVERY = 5 * 60_000;
/** 開いたときの同期を、ほかの窓・タブがこれより前に同期していたらしない（2 つ同時に開いたとき） */
const OPEN_AFTER = 60_000;
export type PcSyncStatus = 'off' | 'idle' | 'busy' | 'auth' | 'perm' | 'error';

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

/** localStorage の設定（まだ無い・読めないときは null） */
function storedSettings(): SyncSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw === null ? null : { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<SyncSettings>) };
  } catch {
    return null;
  }
}

function readSettings(): SyncSettings {
  return storedSettings() ?? { ...DEFAULT_SETTINGS };
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
  // ほかの窓・タブで変えた設定（足した曲など）を消さないよう、localStorage の今の設定に足す
  const settings = { ...(storedSettings() ?? get().settings), ...p };
  set({ settings });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 覚えられなくても、この画面の間は使える
  }
}

/** ほかの窓・タブで変えた設定を映す（同期をやめた・始めた・曲を足した） */
function settingsFromStorage() {
  const s = storedSettings();
  const cur = get().settings;
  if (!s || JSON.stringify(s) === JSON.stringify(cur)) return;
  set({ settings: s, ...(cur.on && !s.on ? { status: 'off' as const, next: 0 } : {}) });
}

let saving: Promise<void> = Promise.resolve();
/** 書き終えたら返る（順番を取っている間に書き終え、ほかの窓が次に読む） */
function saveState(): Promise<void> {
  const st = get().state;
  saving = saving.then(() => saveKv(STATE_ID, st)).catch(() => {});
  return saving;
}
function saveLog(): Promise<void> {
  const log = get().log;
  saving = saving.then(() => saveKv(LOG_ID, log)).catch(() => {});
  return saving;
}

/** IndexedDB の記録を読み直す（ほかの窓・タブが同期した・答えたかもしれない）。読めなければ今のまま */
async function reload(): Promise<void> {
  await saving;
  const [state, log] = await Promise.all([loadKv<SyncState>(STATE_ID), loadKv<LogEntry[]>(LOG_ID)]);
  set({ ...(state?.v === 1 ? { state } : {}), ...(Array.isArray(log) ? { log } : {}), loaded: true });
}

/** 窓・タブをまたいで 1 つずつ（この窓の中は来た順） */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> {
  const job = queue.then(() => withSyncLock(fn, onWait));
  queue = job.catch(() => null);
  return job;
}

interface Ping {
  /** 毎回変える（同じ値では storage が届かない） */
  n: string;
  /** その同期の記録（log の at。記録に残る同期だけ） */
  rep?: number;
  why?: RunReport['why'];
  /** 同期で書いた曲のフォルダ（一覧のその曲を読み直す） */
  touched?: { root: string; path: string[] }[];
}
let pings = 0;
function ping(p: Omit<Ping, 'n'> = {}) {
  try {
    localStorage.setItem(PING_KEY, JSON.stringify({ ...p, n: `${Date.now()}.${++pings}` }));
  } catch {
    // 知らせられない：ほかの窓は次に書くときに読み直す
  }
}

/** ほかの窓・タブが記録を書いた：読み直す（続けて来たら 1 回に） */
const heardReps: { at: number; why: RunReport['why'] }[] = [];
let heardQueued = false;
function heard(raw: string | null) {
  let p: Ping;
  try {
    p = JSON.parse(raw ?? '') as Ping;
  } catch {
    return;
  }
  if (!p || typeof p !== 'object') return;
  for (const t of Array.isArray(p.touched) ? p.touched : []) if (t && typeof t.root === 'string' && Array.isArray(t.path)) touchedSongs.set(`${t.root}:${t.path.join('/')}`, { root: t.root, path: [...t.path] });
  if (typeof p.rep === 'number') heardReps.push({ at: p.rep, why: p.why ?? 'timer' });
  if (heardQueued) return;
  heardQueued = true;
  let before = 0;
  void exclusive(async () => {
    heardQueued = false;
    before = get().state.full ?? 0;
    await reload();
  })
    .then(async () => {
      const s = get();
      // 次の 5 分ごとは、ほかの窓が同期したときから（ほかの窓で同期できたなら、この窓の「できませんでした」も消す）
      if (s.settings.on && s.state.full && s.status !== 'busy') set({ next: s.state.full + SYNC_EVERY, ...(s.state.full > before && s.status === 'error' ? { status: 'idle' as const, error: '' } : {}) });
      // ほかの窓の同期の結果を、この窓のエディタで開いている曲にも映す（Drive に新しい譜面があれば「取り込む」）
      for (const r of heardReps.splice(0)) {
        const rep = get().log.find((l) => l.at === r.at);
        if (rep) for (const fn of listeners) fn(rep, { why: r.why, take: false });
      }
      await refreshTouched();
    })
    .catch(() => {});
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
    isOpen: async (dir, at) => {
      const f = useEditor.getState().folder;
      try {
        if (f?.dir && (await f.dir.isSameEntry(dir))) return true;
      } catch {
        // 比べられない：下で
      }
      // ほかの窓・タブのエディタで開いている（holdOpenSong）
      return lockHeld(openLockName(at));
    },
    touched: (root, path) => touchedSongs.set(`${root}:${path.join('/')}`, { root, path: [...path] }),
  };
}

// ---- エディタで開いている曲（ほかの窓・タブの同期に知らせる） -----------------------------------------

/** 曲のフォルダの印の名前（一覧の場所の鍵と並び。大文字・小文字は見ない） */
function openLockName(at: { root: string; path: readonly string[] }): string {
  return `dtxe-open:${at.root}:${at.path.map((x) => x.normalize('NFC').toLowerCase()).join('/')}`;
}

/** エディタで開いている DTXMania の曲の印を持つ。ほかの窓・タブの同期は、その曲の譜面を書きかえずに「取り込む」を待つ */
let openMark: { name: string; release: () => void } | null = null;
let openSeq = 0;
async function holdOpenSong() {
  const seq = ++openSeq;
  const f = useEditor.getState().folder;
  const at = f && isDiskFolder(f) && !f.local ? await nxPlaceOf(f.dir).catch(() => null) : null;
  if (seq !== openSeq) return;
  const name = at ? openLockName(at) : '';
  if ((openMark?.name ?? '') === name) return;
  openMark?.release();
  openMark = name ? { name, release: holdLock(name) } : null;
}
function releaseOpenSong() {
  openSeq++;
  openMark?.release();
  openMark = null;
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
  /** 同期の前に入れる答え（初めての同期の画面） */
  answers?: Record<string, string>;
}

/** 同期が終わったら（開いている曲に Drive の新しい譜面があれば知らせる。src/app/driveActions.ts） */
type ReportListener = (rep: RunReport, o: { why: RunReport['why']; take: boolean }) => void;
const listeners = new Set<ReportListener>();
export function onPcSyncReport(fn: ReportListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

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

/** 一覧を読んでいる間は待つ（読み終えていない曲を「無い」と間違えない）。読み終えたら true */
async function scanDone(): Promise<boolean> {
  for (let i = 0; i < 600 && useNxLib.getState().scan; i++) await new Promise((r) => setTimeout(r, 500));
  return !useNxLib.getState().scan;
}

const SCANNING = Symbol('scanning');

/**
 * 1 回同期する（順番に。この窓の中でも、ほかの窓・タブとも、同じ時に 2 つは動かさない）。
 * 一覧を読んでいる間は、順番を取る前に待つ（ほかの窓を待たせない）
 */
async function enqueue(ask: RunAsk): Promise<RunReport | null> {
  // 押した・保存した同期は、ほかの窓・タブの同期を待っていると出す（開いたとき・5 分ごとは黙って待つ）
  const onWait = ask.why === 'timer' || ask.why === 'open' ? undefined : () => set({ status: 'busy', error: '', progress: { phase: 'wait', done: 0, total: 0, bytes: 0 } });
  for (let i = 0; i < 3; i++) {
    if (!(await scanDone())) return null;
    const rep = await exclusive(() => runOne(ask), onWait);
    if (rep === SCANNING) continue;
    await refreshTouched();
    return rep;
  }
  return null;
}

async function runOne(ask: RunAsk): Promise<RunReport | null | typeof SCANNING> {
  try {
    return await runLocked(ask);
  } finally {
    // 待っていると出したまま、同期しなかった
    const s = get();
    if (s.progress?.phase === 'wait') set({ progress: null, ...(s.status === 'busy' ? { status: 'idle' as const } : {}) });
  }
}

/** 順番を取ってから：ほかの窓・タブが書いた記録と設定を読み直して同期する */
async function runLocked(ask: RunAsk): Promise<RunReport | null | typeof SCANNING> {
  settingsFromStorage();
  await reload();
  if (ask.answers) {
    applyAnswers(ask.answers);
    await saveState();
  }
  const block = canRun();
  if (block) {
    set({ status: block === 'off' ? 'off' : block, progress: null });
    return null;
  }
  // ほかの窓・タブが少し前に全部の曲を同期した：5 分ごと・開いたときの同期はしない（次はそこから 5 分）
  const full = get().state.full ?? 0;
  const ago = Date.now() - full;
  if (full && ago >= 0 && ((ask.why === 'timer' && ago < SYNC_EVERY) || (ask.why === 'open' && ago < OPEN_AFTER))) {
    set({ next: full + SYNC_EVERY, status: 'idle', error: '', progress: null });
    return null;
  }
  if (useNxLib.getState().scan) return SCANNING;
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
  let logged = false;
  try {
    rep = await runSync({ settings: s.settings, lib, state, why: ask.why, only: ask.only, take: ask.take, progress: (p) => set({ progress: p }) });
    set({ status: 'idle', state: { ...state }, ...(ask.only ? {} : { next: (state.full ?? Date.now()) + SYNC_EVERY }) });
    logged = addLog(rep, !!ask.only);
    for (const fn of listeners) fn(rep, { why: ask.why, take: !!ask.take });
    return rep;
  } catch (e) {
    const auth = e instanceof DriveError && e.reason === 'auth';
    const msg = auth ? tr('Google Drive のログインが切れました', 'Your Google Drive sign-in expired') : errText(e);
    set({ status: auth ? 'auth' : 'error', error: msg, state: { ...state } });
    if (!auth) logged = addLog({ at: Date.now(), pc: s.settings.pc, why: ask.why, songs: [], asks: [], error: msg });
    return null;
  } finally {
    running = false;
    set({ progress: null });
    // 順番を離す前に書き終え、ほかの窓・タブに知らせる
    await saveState();
    if (logged) await saveLog();
    ping({ ...(rep && logged ? { rep: rep.at } : {}), why: ask.why, touched: [...touchedSongs.values()] });
  }
}

function errText(e: unknown): string {
  if (e instanceof DriveError && /storageQuotaExceeded|quotaExceeded/i.test(e.reason)) return tr('Google Drive がいっぱいです。空きを作るか、同期する曲を減らしてください', 'Google Drive is full. Free up space or sync fewer songs');
  return (e as Error)?.message || String(e);
}

/** 記録に足す（変えたら true。書くのは呼んだ所）。決まりは src/sync/runlog.ts */
function addLog(rep: RunReport, only = false): boolean {
  const log = addRun(get().log, rep, { only });
  if (log) set({ log });
  return !!log;
}

/** 開いたときと、開いている間の 5 分ごと（同期が on のとき） */
export function initPcSync(): () => void {
  void reload();
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
    if (s.ready !== p.ready || s.perm !== p.perm || s.place !== p.place) {
      tryOpen();
      void holdOpenSong();
    }
  });
  const unsubAuth = useDriveAuth.subscribe((s, p) => {
    if ((s.token !== p.token || s.exp !== p.exp) && s.token) {
      // ログインし直した（ほかの窓・タブでログインし直したトークンも）：止まっていたら続ける
      if (get().status === 'auth') void enqueue({ why: 'manual' });
      else tryOpen();
    }
  });
  // エディタで開いている曲を、ほかの窓・タブの同期に知らせる
  const unsubEd = useEditor.subscribe((s, p) => {
    if (s.folder !== p.folder) void holdOpenSong();
  });
  void holdOpenSong();
  // ほかの窓・タブで設定を変えた・同期した
  const onStorage = (e: StorageEvent) => {
    if (e.key === SETTINGS_KEY) settingsFromStorage();
    else if (e.key === PING_KEY) heard(e.newValue);
  };
  window.addEventListener('storage', onStorage);
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
    unsubEd();
    releaseOpenSong();
    window.removeEventListener('storage', onStorage);
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
  saveSettings({ ...p, pcId: (storedSettings() ?? get().settings).pcId || newPcId() });
  set({ panel: 'first', preview: null, previewing: true, error: '' });
  try {
    await reload();
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
  set({ panel: null, preview: null });
  saveSettings({ on: true });
  // 答えは、順番を取って記録を読み直してから入れる
  const rep = await enqueue({ why: 'first', answers });
  if (rep && !rep.error) toast(tr('PC どうしの同期を始めました。記録は上の帯から見られます', 'PC sync has started. See the log from the bar at the top'), 'ok', 6000);
}

/** 同期をやめる（Drive の物とこの PC の曲はそのまま。また始めれば続きから） */
export function stopPcSync() {
  saveSettings({ on: false });
  set({ status: 'off', next: 0 });
}

function applyAnswers(answers: Record<string, string>) {
  const st = get().state;
  set({ state: { ...st, answers: { ...st.answers, ...answers } } });
}

/** 答えを残す（画面にはすぐ映し、順番を取って記録を読み直してから書く） */
function saveAnswers(answers: Record<string, string>): Promise<void> {
  applyAnswers(answers);
  return exclusive(async () => {
    await reload();
    applyAnswers(answers);
    await saveState();
    ping();
  });
}

/** 聞いたことに答える（次の同期で、そのとおりにする） */
export function answerAsk(id: string, answer: string): Promise<void> {
  return saveAnswers({ [id]: answer });
}

/** 答えて、すぐ同期する（操作の中で呼ぶ。答えを書いてから同期する） */
export function answerAndSync(answers: Record<string, string>) {
  void saveAnswers(answers).catch(() => {});
  syncNow();
}

/** 記録の「これでよい」 */
export function markDone(at: number, path: string): Promise<void> {
  const apply = () => set({ log: get().log.map((l) => (l.at === at && !(l.done ?? []).includes(path) ? { ...l, done: [...(l.done ?? []), path] } : l)) });
  apply();
  return exclusive(async () => {
    await reload();
    apply();
    await saveLog();
    ping();
  });
}

/** 控えの版に戻す（その版をもう一度新しい方として送る） */
export async function restoreFromLog(at: number, driveId: string, path: string, backupId: string): Promise<void> {
  const lib = await libAccess();
  if (!lib) return;
  try {
    await exclusive(async () => {
      await reload();
      const st = get();
      try {
        await restoreBackup({ lib, state: st.state, settings: st.settings, driveId, path, backupId });
      } finally {
        set({ state: { ...st.state } });
        await saveState();
      }
      set({ log: get().log.map((l) => (l.at === at && !(l.done ?? []).includes(path) ? { ...l, done: [...(l.done ?? []), path] } : l)) });
      await saveLog();
      ping({ touched: [...touchedSongs.values()] });
    });
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
  await exclusive(async () => {
    await reload();
    const st = get();
    try {
      await stopSong({ lib, state: st.state, root: s.root, path: s.path });
    } finally {
      set({ state: { ...st.state } });
      await saveState();
    }
    ping({ touched: [...touchedSongs.values()] });
  });
  const lk = libKeyOf(lib, s);
  if (lk) saveSettings({ songs: (storedSettings() ?? get().settings).songs.filter((x) => x.toLowerCase() !== lk) });
  await refreshTouched();
}

/** 同期していない曲を同期に足す（「同期しない」の印も消す）。すぐ送る */
export async function addSyncSong(s: Pick<LibSong, 'root' | 'path' | 'title'>): Promise<void> {
  const lib = await libAccess();
  if (!lib) return;
  await resumeSong({ lib, root: s.root, path: s.path });
  const lk = libKeyOf(lib, s);
  const songs = (storedSettings() ?? get().settings).songs;
  if (lk && !songs.some((x) => x.toLowerCase() === lk)) saveSettings({ songs: [...songs, lk] });
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
export function resetPcSyncState(): Promise<void> {
  forgetRoot();
  set({ state: emptyState(), log: [] });
  return exclusive(async () => {
    set({ state: emptyState(), log: [] });
    await Promise.all([saveState(), saveLog()]);
    ping();
  });
}
