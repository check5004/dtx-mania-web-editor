// 開いている曲と Google Drive をつなぐ：保存したら Drive にも送る・自動保存（まだ保存していない続き）も送る・Drive から開く・
// ほかの端末で保存した新しい内容を取り込む・ページを切り替えるログインから戻ったら続ける。
// Drive の読み書きそのものは src/drive/、ログインは src/drive/auth.ts。
import { create } from 'zustand';
import { pl, tr, locale } from '../i18n';
import { IS_IOS, IS_IPHONE } from '../platform';
import { DriveAuthError, DriveError } from '../drive/api';
import { ensureToken, loadGis, setBeforeRedirect, signIn, takeRedirectResult, tokenValid, useDriveAuth, type Resume } from '../drive/auth';
import {
  describeFiles,
  extrasOf,
  listDriveSongs,
  listTree,
  newLink,
  NotSongFolderError,
  pullSong,
  pushSize,
  pushSong,
  readAutosaves,
  readDriveSkip,
  readLink,
  remoteChanges,
  songsInside,
  trashJunk,
  writeDriveSkip,
  type DriveLink,
  type DriveSong,
  type DriveTree,
  type JunkDir,
  type SyncProgress,
} from '../drive/sync';
import { folderFromHandle, isDiskFolder, normPath, type SongFolder } from '../fs/folder';
import { dirLabel, otherSongsIn } from '../fs/songDir';
import { checkLocal, createLocalSong, deleteLocalSong, finishLocalSong, freeLocalName, listLocalSongs, openLocalSong, updateLocalSong } from '../fs/local';
import { songDir } from '../fs/opfs';
import { getRecent, listRecent } from '../fs/recent';
import { dismissToast, isDirty, toast, useEditor } from '../store/editor';
import { bumpLocal, initLocalSongs, refreshLocalSongs } from '../store/localSongs';
import { chooseDialog, confirmDialog } from '../ui/dialogs';
import { askDriveFirst } from '../ui/DriveFirstDialog';
import { noteSavedNxFolder, useNxLib } from '../nxlib/store';
import { kindOf } from '../sync/kind';
import { addSyncSong, onPcSyncReport, pcSyncPlace, syncSaved, syncTake, usePcSync } from '../sync/store';
import type { RunReport } from '../sync/types';
import { formatLevel } from '../ui/format';
import { autosaveNow, autosaveSnapshot, confirmDiscard, moveToOwnSongFolder, openFolder, openRecent, recentIdFor, reopenFromFolder, save, setBeforeSave } from './fileActions';
import { fewText } from './songPlace';

export type DriveStatus = 'none' | 'busy' | 'ok' | 'auth' | 'error' | 'conflict' | 'newer';

interface DriveSyncState {
  /** 開いている曲が Drive とつながっている */
  linked: boolean;
  status: DriveStatus;
  progress: SyncProgress | null;
  /** 何をしているか（送る・取る） */
  doing: 'up' | 'down' | null;
  /** 最後に Drive と合わせた時刻 */
  at: number;
  error: string;
  conflicts: string[];
  newer: string[];
  /** Drive のこの曲のフォルダに入っている、ほかの曲のフォルダ（送りも取りもしない。ゴミ箱に移せる） */
  junk: JunkDir[];
  /** 開いている曲は「Drive に送らない」にしてある（保存しても送らない。押して送ると送る） */
  skip: boolean;
}

export const useDriveSync = create<DriveSyncState>(() => ({ linked: false, status: 'none', progress: null, doing: null, at: 0, error: '', conflicts: [], newer: [], junk: [], skip: false }));

const ed = useEditor.getState;
const set = useDriveSync.setState;

function device(): string {
  return IS_IPHONE ? 'iPhone' : IS_IOS ? 'iPad' : 'PC';
}

export function timeText(t: number): string {
  return new Date(t).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- 聞くこと --------------------------------------------------------------------

function askConflict(dir: 'push' | 'pull') {
  return async (paths: string[]) =>
    chooseDialog<'mine' | 'theirs'>({
      title: tr('Drive とこの端末の両方で変わったファイルがあります', 'Some files changed both on Drive and on this device'),
      body: tr(
        `${describeFiles(paths)}\n\nほかの端末でも保存したようです。どちらを残しますか？`,
        `${describeFiles(paths)}\n\nIt looks like they were saved on another device too. Which do you want to keep?`,
      ),
      options:
        dir === 'push'
          ? [
              { label: tr('この端末の方を送る', "Send this device's version"), sub: tr('Drive の方を上書きします', 'Overwrites the version on Drive'), value: 'mine' },
              { label: tr('Drive の方を残す', "Keep Drive's version"), sub: tr('このファイルは送りません。あとで「Drive から取り込む」で取れます', 'These files are not sent. You can take them later with "Get from Drive"'), value: 'theirs' },
            ]
          : [
              { label: tr('Drive の方を使う', "Use Drive's version"), sub: tr('この端末のファイルを書き換えます', 'Replaces the files on this device'), value: 'theirs' },
              { label: tr('この端末の方を残す', "Keep this device's version"), sub: tr('次に保存したとき Drive に送ります', 'It goes to Drive the next time you save'), value: 'mine' },
            ],
    });
}

async function askSameName(name: string) {
  return chooseDialog<'join' | 'new'>({
    title: tr(`Google Drive に「${name}」があります`, `"${name}" is already on Google Drive`),
    body: tr('ほかの端末から送った同じ曲なら、合わせると同じファイルは送らずに済みます。', 'If it is the same song sent from another device, joining it skips the files that are already there.'),
    options: [
      { label: tr('その曲に合わせる', 'Join that song'), sub: tr('違うファイルだけ送ります（両方で違うファイルは聞きます）', 'Sends only the files that differ (asks about files that differ on both)'), value: 'join' },
      { label: tr('別の曲として送る', 'Send as a separate song'), sub: tr(`「${name} (2)」のように名前を変えて送ります`, `Sends it under a new name like "${name} (2)"`), value: 'new' },
    ],
  });
}

// ---- 送る ----------------------------------------------------------------------

type PushKind = 'save' | 'autosave' | 'manual';

let queue: Promise<unknown> = Promise.resolve();
/** この画面で Drive と合わせた時刻（Drive の曲フォルダの id → 時刻）。合わせたばかりの曲は開いたときに見直さない */
const synced = new Map<string, number>();
let autosaveQueued = false;
/** 保存の操作の中で開いたログインの小窓（送る前に待つ） */
let pendingSignIn: Promise<boolean> | null = null;

function enqueue<T>(job: () => Promise<T>): Promise<T | undefined> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run.catch(() => undefined);
}

function currentInfo(folder: SongFolder) {
  const s = ed();
  if (s.folder !== folder) return undefined;
  const f = s.doc.fields;
  return { t: f['TITLE'] ?? '', a: f['ARTIST'] ?? '', b: f['BPM'] ?? '', l: f['DLEVEL'] ?? '' };
}

/** 初めて送る曲がこれより大きいときは、送る前に聞く（無料の Drive を動画の大きい曲で使い切らないように） */
const BIG_FIRST = 100 * 1024 * 1024;

/** 「Drive に送らない」にした、つないでいない曲か（保存では送らない。押して送ったときは送る） */
async function skipped(folder: SongFolder): Promise<boolean> {
  if (folder.drive || !(await readDriveSkip(folder))) return false;
  if (ed().folder === folder) set({ skip: true });
  return true;
}

/** つないでいない曲を初めて送る前：大きい曲（100 MB をこえる）は聞く。送るなら { noVideo }、送らないなら null */
async function firstPush(folder: SongFolder, kind: PushKind): Promise<{ noVideo: boolean } | null> {
  // ほかの曲も入ったフォルダは pushSong が送らない（大きさを聞かない）
  if (songsInside(folder).length) return { noVideo: false };
  const size = pushSize(folder);
  if (size.total <= BIG_FIRST) return { noVideo: false };
  const how = await askDriveFirst({
    title: currentInfo(folder)?.t.trim() || folder.name,
    ...size,
    saved: kind === 'save',
    library: !!useNxLib.getState().place,
  });
  if (!how) return null;
  if (how === 'skip') {
    await writeDriveSkip(folder);
    if (ed().folder === folder) set({ skip: true });
    toast(tr('この曲は Google Drive に送りません。送るときは「ファイル › Google Drive にも保存する」から', "This song won't be sent to Google Drive. To send it, use File › Also save to Google Drive"), 'info', 6000);
    return null;
  }
  return { noVideo: how === 'novideo' };
}

/** 開いている曲を Drive に送る（つないでいなければ、保存のときだけ Drive に作ってつなぐ） */
async function push(kind: PushKind): Promise<void> {
  const folder = ed().folder;
  const auth = useDriveAuth.getState();
  if (!folder?.dir || !auth.connected) return;
  // PC どうしの同期で合わせる曲（DTXMania の曲の中）：保存したら同期で送る。自動保存は控えだけ
  const pcPlace = kind === 'autosave' ? null : await pcSyncPlace(folder);
  if (pcPlace) {
    await pcPush(folder, pcPlace, kind);
    return;
  }
  if (kind === 'save' && !auth.onSave) return;
  if (kind === 'autosave' && (!auth.autosave || !folder.drive)) return;
  if (kind === 'save' && (await skipped(folder))) return;
  const waiting = pendingSignIn;
  pendingSignIn = null;
  if (waiting) await waiting;
  if (!tokenValid()) {
    // ログインが切れている：つないだ曲なら知らせる（押すとログインして送る）
    if (folder.drive || kind !== 'autosave') set({ status: 'auth' });
    return;
  }
  const snap = kind === 'save' ? null : autosaveSnapshot();
  if (kind === 'autosave' && !snap) return;
  const wasLinked = !!folder.drive;
  let noVideo = false;
  if (!wasLinked && kind !== 'autosave') {
    const go = await firstPush(folder, kind);
    if (!go) return;
    noVideo = go.noVideo;
  }
  set({ status: 'busy', doing: 'up', error: '' });
  try {
    const r = await pushSong(folder, {
      create: kind !== 'autosave',
      noVideo,
      quick: kind === 'autosave',
      quickOnly: kind === 'autosave' && (await pcSyncPlace(folder)) !== null,
      resolve: kind === 'autosave' ? undefined : askConflict('push'),
      sameName: kind === 'autosave' ? undefined : askSameName,
      autosave: snap && ed().folder === folder ? { ...snap, savedAt: Date.now() } : null,
      info: currentInfo(folder),
      device: device(),
      progress: (p) => set({ progress: p }),
    });
    if (r.notSong) {
      // ほかの曲も入ったフォルダ（DTXFiles など）は送らない
      set({ status: 'error', error: notSongText(folder, r.notSong), doing: null, progress: null });
      if (kind !== 'autosave' || !toldNotSong.has(folder)) tellNotSong(folder, r.notSong);
      return;
    }
    if (r.skipped || !r.link) {
      set({ status: folder.drive ? 'ok' : 'none', doing: null });
      return;
    }
    folder.drive = r.link.folderId;
    noteJunk(folder, r.junk);
    synced.set(folder.drive, Date.now());
    if (folder.local && !wasLinked) {
      await updateLocalSong(folder.local, { drive: folder.drive });
      bumpLocal();
    } else if (!wasLinked && isDiskFolder(folder)) {
      // DTXMania の曲なら、一覧の印（Drive とつないだ）も直す。古い印のままだと、あとで同期を始めたときに Drive に同じ曲をもう 1 つ作っていた
      void noteSavedNxFolder(folder.dir).catch(() => {});
    }
    const status: DriveStatus = r.conflicts.length ? 'conflict' : r.newer.length ? 'newer' : 'ok';
    if (ed().folder === folder) set({ linked: true, status, at: Date.now(), conflicts: r.conflicts, newer: r.newer, doing: null, skip: false });
    if (kind !== 'autosave') {
      if (!wasLinked) {
        const what = r.link.noVideo ? tr('この曲だけ・動画は除いて', 'this song only, without the video') : tr('この曲だけ', 'this song only');
        toast(
          tr(
            `Google Drive にも送りました（${what} · ${sizeText(r.bytes)}）\n次からは、保存するたびに変わったファイルだけ送ります（DTX Web Editor/${r.link.name}）`,
            `Also sent to Google Drive (${what} · ${sizeText(r.bytes)})\nFrom now on, each save sends only the files that changed (DTX Web Editor/${r.link.name})`,
          ),
          'ok',
          7000,
        );
      } else if (r.sent > 0 && kind === 'manual') toast(tr(`Google Drive に送りました（${r.sent} 個）`, `Sent to Google Drive (${r.sent} ${pl(r.sent, 'file')})`), 'ok', 4000);
      if (r.newer.length) newerToast(r.newer);
    }
  } catch (e) {
    if (e instanceof DriveAuthError) {
      set({ status: 'auth', doing: null, progress: null });
      return;
    }
    set({ status: 'error', error: errorText(e), doing: null, progress: null });
    if (kind !== 'autosave') {
      toast(tr(`Google Drive に送れませんでした: ${errorText(e)}`, `Couldn't send to Google Drive: ${errorText(e)}`), 'error', 8000, {
        label: tr('もう一度', 'Try again'),
        run: () => pushNow(),
      });
    }
  }
}

// ---- PC どうしの同期で合わせる曲 -------------------------------------------------------

/** 同期で書いた .dtxe-drive.json を、開いている曲のファイルの一覧に入れ直す（Drive の曲の id を読む） */
async function relink(folder: SongFolder): Promise<DriveLink | null> {
  if (!folder.dir) return null;
  try {
    const fh = await folder.dir.getFileHandle('.dtxe-drive.json');
    const f = await fh.getFile();
    folder.files.set('.dtxe-drive.json', { path: '.dtxe-drive.json', name: '.dtxe-drive.json', size: f.size, getFile: () => fh.getFile() });
  } catch {
    folder.files.delete('.dtxe-drive.json');
  }
  const link = await readLink(folder);
  folder.drive = link?.folderId;
  return link;
}

/** 保存した・「Google Drive にも保存する」：その曲だけ同期する */
async function pcPush(folder: SongFolder, place: { root: string; path: string[] }, kind: PushKind) {
  const waiting = pendingSignIn;
  pendingSignIn = null;
  if (waiting) await waiting;
  if (!tokenValid()) {
    set({ status: 'auth' });
    return;
  }
  const title = currentInfo(folder)?.t.trim() || folder.name;
  set({ status: 'busy', doing: 'up', error: '' });
  let rep: RunReport | null;
  if (kind === 'manual' && (await readDriveSkip(folder))) {
    // 「同期しない」にしてあった曲を押して送る：同期に足す
    await addSyncSong({ root: place.root, path: place.path, title });
    rep = await syncSaved({ root: place.root, path: place.path, title });
  } else rep = await syncSaved({ root: place.root, path: place.path, title });
  await notePcReport(folder, rep, kind === 'manual');
}

/** 開いている曲の同期の結果を、エディタの Drive の印に映す（Drive の方が新しい譜面は「取り込む」を勧める） */
async function notePcReport(folder: SongFolder, rep: RunReport | null, tell: boolean) {
  if (ed().folder !== folder) return;
  if (!rep) {
    const st = usePcSync.getState();
    set({ status: st.status === 'auth' ? 'auth' : 'error', error: st.error, doing: null });
    return;
  }
  const link = await relink(folder);
  const s = rep.songs[0];
  const newer = (s?.wait ?? []).filter((p) => kindOf(p) === 'make');
  set({ linked: !!link, status: s?.error ? 'error' : newer.length ? 'newer' : link ? 'ok' : 'none', error: s?.error ?? '', at: Date.now(), conflicts: [], newer, doing: null, skip: !link && (await readDriveSkip(folder)) });
  if (newer.length) newerToast(newer);
  if (tell && s && !s.error) toast(s.sent.length ? tr(`同期しました（${s.sent.length} 個送りました）`, `Synced (${s.sent.length} ${pl(s.sent.length, 'file')} sent)`) : tr('同期しました（Drive と同じでした）', 'Synced (already the same as Drive)'), 'ok', 4000);
}

/** 5 分ごとなどの同期で、開いている曲に Drive の新しい譜面があった：「取り込む」を勧める */
export function notePcWaiting(paths: string[]) {
  const make = paths.filter((p) => kindOf(p) === 'make');
  if (!make.length) return;
  const st = useDriveSync.getState();
  if (st.status === 'newer' && st.newer.join('\n') === make.join('\n')) return;
  set({ status: 'newer', newer: make });
  newerToast(make);
}

// ---- 曲フォルダでない・ほかの曲が入っている -------------------------------------------

const toldNotSong = new WeakSet<SongFolder>();
/** その知らせ（曲のフォルダに移したら閉じる） */
let notSongToast = 0;

function notSongText(folder: SongFolder, songs: string[]): string {
  const names = fewText(songs.map((d) => dirLabel(folder, d)));
  return tr(
    `「${folder.name}」にはほかの曲（${names}）も入っているので、Google Drive には送りません。この曲だけのフォルダに移すと送れます`,
    `"${folder.name}" also holds other songs (${names}), so it isn't sent to Google Drive. Move the song to a folder of its own to send it`,
  );
}

function tellNotSong(folder: SongFolder, songs: string[]) {
  toldNotSong.add(folder);
  notSongToast = toast(notSongText(folder, songs), 'warn', 12000, { label: tr('この曲のフォルダに移す…', 'Move to its own folder…'), run: () => void moveToOwnSongFolder().then((f) => f && save()) });
}

function sizeText(bytes: number): string {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Drive の曲フォルダに入っている物の数と大きさ（「フォルダ 3 個・ファイル 40 個以上・1.2 GB」） */
function junkSummary(items: readonly JunkDir[]): string {
  const files = items.reduce((a, j) => a + j.files, 0);
  const bytes = items.reduce((a, j) => a + j.bytes, 0);
  const songs = items.filter((j) => j.kind === 'song').length;
  const dirs = items.filter((j) => j.kind === 'dir').length;
  const parts = [
    songs ? tr(`曲のフォルダ ${songs} 個`, `${songs} song ${pl(songs, 'folder')}`) : '',
    dirs ? tr(`フォルダ ${dirs} 個`, `${dirs} ${pl(dirs, 'folder')}`) : '',
    files ? (songs ? tr(`ファイル ${files} 個以上`, `${files}+ ${pl(files, 'file')}`) : tr(`ファイル ${files} 個`, `${files} ${pl(files, 'file')}`)) : '',
    bytes ? (songs ? tr(`${sizeText(bytes)} 以上`, `${sizeText(bytes)}+`) : sizeText(bytes)) : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** 知らせた Drive の曲フォルダ（この画面で1回だけ） */
const toldJunk = new Set<string>();
/** その知らせ（片付けたら閉じる） */
let junkToast = 0;

/** Drive のこの曲のフォルダに、ほかの曲のフォルダが入っていたら知らせる（片付けられる） */
function noteJunk(folder: SongFolder, junk: JunkDir[]) {
  if (ed().folder !== folder) return;
  set({ junk });
  const id = folder.drive;
  if (!junk.length || !id || toldJunk.has(id)) return;
  toldJunk.add(id);
  junkToast = toast(
    tr(
      `Google Drive のこの曲のフォルダに、ほかの曲のフォルダが ${junk.length} 個入っています（${fewText(junk.map((j) => j.path))}）。この曲の物ではないので、送りも取り込みもしません。ゴミ箱に移して片付けられます`,
      `This song's folder on Google Drive has ${junk.length} other song ${pl(junk.length, 'folder')} in it (${fewText(junk.map((j) => j.path))}). They aren't part of this song, so they are neither sent nor taken. You can move them to the trash`,
    ),
    'warn',
    15000,
    { label: tr('片付ける…', 'Clean up…'), run: () => cleanDriveJunk() },
  );
}

function newerToast(paths: string[]) {
  toast(tr(`Google Drive に、ほかの端末で保存した新しいファイルがあります（${describeFiles(paths, 3)}）`, `Google Drive has newer files saved on another device (${describeFiles(paths, 3)})`), 'info', 10000, {
    label: tr('取り込む', 'Get them'),
    run: () => pullNow(),
  });
}

/** 保存の操作の中（最初の await の前）：ログインが切れていたら小窓で取り直す */
function beforeSave(opts: { toFolder?: boolean }) {
  const a = useDriveAuth.getState();
  if (!a.connected || !a.onSave || tokenValid() || a.redirect || !a.gisReady) return;
  // 「Drive に送らない」にした曲は、保存しても送らないのでログインし直さない
  if (useDriveSync.getState().skip && !ed().folder?.drive) return;
  // 曲フォルダを選ぶ保存は、ログインの小窓を開くとフォルダ選択が開けなくなる（小窓が操作を使い切る）。
  // そのときは保存のあとでフッターの「Drive につなぎ直す」から送る
  if (opts.toFolder) return;
  pendingSignIn = signIn({ action: 'push', recentId: ed().meta.recentId });
}

/** 押して送る（ログインが切れていれば取り直す）。操作の中で呼ぶ */
export function pushNow() {
  const ok = ensureToken({ action: 'push', recentId: ed().meta.recentId }, true);
  void ok.then((y) => {
    if (y) void enqueue(() => push('manual'));
  });
}

// ---- 自動保存も送る -------------------------------------------------------------

let autoTimer = 0;
let firstPending = 0;
const AUTO_WAIT = 20_000;
const AUTO_MAX = 60_000;

function scheduleAutosave() {
  const folder = ed().folder;
  const a = useDriveAuth.getState();
  if (!folder?.drive || !a.connected || !a.autosave) return;
  if (!tokenValid()) {
    set({ status: 'auth' });
    return;
  }
  const now = Date.now();
  firstPending ||= now;
  window.clearTimeout(autoTimer);
  const wait = Math.max(0, Math.min(AUTO_WAIT, firstPending + AUTO_MAX - now));
  autoTimer = window.setTimeout(flushAutosave, wait);
}

function flushAutosave() {
  window.clearTimeout(autoTimer);
  if (!firstPending) return;
  firstPending = 0;
  if (autosaveQueued) return;
  autosaveQueued = true;
  void enqueue(async () => {
    autosaveQueued = false;
    await push('autosave');
  });
}

// ---- 取り込む・開く --------------------------------------------------------------

/** 開いている曲に、Drive の新しい内容を取り込んで開き直す。操作の中で呼ぶ */
export function pullNow() {
  const ok = ensureToken({ action: 'push', recentId: ed().meta.recentId }, true);
  void ok.then((y) => {
    if (y) void enqueue(pullCurrent);
  });
}

async function pullCurrent() {
  const folder = ed().folder;
  if (!folder?.dir) return;
  const pcPlace = await pcSyncPlace(folder);
  if (pcPlace) {
    // PC どうしの同期で合わせる曲：同期で取り込む（成績はまとめ、両方で直した譜面は新しい方＋控え）
    if (!(await confirmDiscard())) return;
    const fileName = ed().meta.fileName;
    set({ status: 'busy', doing: 'down', error: '' });
    const rep = await syncTake({ ...pcPlace, title: currentInfo(folder)?.t.trim() || folder.name });
    await notePcReport(folder, rep, false);
    const s = rep?.songs[0];
    const got = (s?.got.length ?? 0) + (s?.scoresGot.length ?? 0);
    if (rep) toast(got ? tr(`同期で ${got} 個取り込みました`, `Got ${got} ${pl(got, 'file')} by syncing`) : tr('Google Drive と同じでした', 'Already the same as Google Drive'), 'ok', 4000);
    if (s?.got.length && ed().folder === folder) await reopenFromFolder(folder, fileName);
    return;
  }
  const link = await readLink(folder);
  if (!link) return;
  if (!(await confirmDiscard())) return;
  const fileName = ed().meta.fileName;
  set({ status: 'busy', doing: 'down', error: '' });
  try {
    const r = await pullSong(folder, link, { resolve: askConflict('pull'), progress: (p) => set({ progress: p }) });
    synced.set(link.folderId, Date.now());
    if (folder.local) await finishLocalSong(folder.local, folder);
    set({ status: r.conflicts.length ? 'conflict' : 'ok', at: Date.now(), conflicts: r.conflicts, newer: [], doing: null });
    noteJunk(folder, r.junk);
    toast(r.got ? tr(`Google Drive から ${r.got} 個取り込みました`, `Got ${r.got} ${pl(r.got, 'file')} from Google Drive`) : tr('Google Drive と同じでした', 'Already the same as Google Drive'), 'ok', 4000);
    if (r.got && ed().folder === folder) await reopenFromFolder(folder, fileName);
  } catch (e) {
    set({ status: e instanceof DriveAuthError ? 'auth' : 'error', error: errorText(e), doing: null, progress: null });
    if (e instanceof NotSongFolderError) tellNotSong(folder, e.songs);
    else if (!(e instanceof DriveAuthError)) toast(tr(`Google Drive から取り込めませんでした: ${errorText(e)}`, `Couldn't get files from Google Drive: ${errorText(e)}`), 'error', 8000);
  }
}

/** Drive の曲の一覧から選んで開く。操作の中で呼ぶ */
export function openFromDrive() {
  const ok = ensureToken({ action: 'open' }, true);
  void ok.then((y) => {
    if (y) void chooseAndOpen();
  });
}

async function chooseAndOpen() {
  let songs: DriveSong[];
  useEditor.setState({ loading: tr('Google Drive の曲を読んでいます…', 'Reading songs on Google Drive…') });
  try {
    songs = await listDriveSongs();
  } catch (e) {
    toast(tr(`Google Drive の曲を読めませんでした: ${errorText(e)}`, `Couldn't read songs on Google Drive: ${errorText(e)}`), 'error', 8000);
    return;
  } finally {
    useEditor.setState({ loading: null });
  }
  if (!songs.length) {
    toast(tr('Google Drive にはまだ曲がありません。曲を開いて保存すると、Drive にも送ります', 'No songs on Google Drive yet. Open a song and save it to send it to Drive'), 'info', 7000);
    return;
  }
  const here = new Set((await listLocalSongs()).map((l) => l.drive).filter(Boolean));
  for (const e of await listRecent()) if (e.drive && e.dir) here.add(e.drive);
  const picked = await chooseDialog<DriveSong>({
    title: tr('Google Drive から開く', 'Open from Google Drive'),
    body: tr('この端末に無い曲は、音ごと取ってきてから開きます。この端末にある曲は、変わったファイルだけ取ります。', 'Songs not on this device are downloaded with their audio first. Songs already here only get the files that changed.'),
    options: songs.map((s) => {
      const i = s.info;
      const when = i.u ?? Date.parse(s.modifiedTime);
      const sub = [
        i.t && i.t !== s.name ? s.name : '',
        i.a ?? '',
        i.l ? `Lv ${formatLevel(i.l)}` : '',
        when ? new Date(when).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
        i.s ? sizeText(i.s) : '',
        here.has(s.id) ? tr('この端末にもあります', 'Also on this device') : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return { label: i.t || s.name, sub, value: s };
    }),
  });
  if (picked) await openDriveSong(picked);
}

/** Drive の曲を開く：この端末にあれば変わったファイルだけ取り、無ければ本体に音ごと取ってくる */
export async function openDriveSong(song: DriveSong) {
  // PC は曲フォルダの許可を聞くことがある（操作の中で）
  if (!(await confirmDiscard({ gesture: true }))) return;
  let folder: SongFolder | null = null;
  let link: DriveLink | null = null;
  const mine = (await listLocalSongs()).find((l) => l.drive === song.id);
  if (mine) folder = await openLocalSong(mine.id);
  if (!folder) {
    // PC：Drive とつないだ曲フォルダ（最近の曲から）
    const e = (await listRecent()).find((r) => r.drive === song.id && r.dir);
    if (e?.dir) {
      try {
        const perm = e.dir.requestPermission ? await e.dir.requestPermission({ mode: 'readwrite' }) : 'granted';
        if (perm === 'granted') folder = await folderFromHandle(e.dir);
      } catch {
        // フォルダが消えた：本体に取ってくる
      }
      // ほかの曲も入ったフォルダ（間違って DTXFiles を曲フォルダにしていた）には取らない：本体に取ってくる
      if (folder && otherSongsIn(folder).length) folder = null;
    }
  }
  if (folder) link = await readLink(folder);
  let created: string | null = null;
  if (!folder) {
    if (!(await checkLocal())) {
      toast(tr('このブラウザには曲を保存できないため、Drive から開けません（プライベートブラウズでは使えません）', "This browser can't keep songs, so it can't open them from Drive (not available in Private Browsing)"), 'error', 8000);
      return;
    }
    const rec = await createLocalSong(await freeLocalName(song.name));
    created = rec.id;
    folder = { name: rec.name, dir: await songDir(rec.id, true), local: rec.id, files: new Map() };
  }
  if (!link || link.folderId !== song.id) link = newLink(song.id, song.name);
  set({ status: 'busy', doing: 'down', error: '' });
  try {
    const r = await pullSong(folder, link, { resolve: askConflict('pull'), progress: (p) => set({ progress: p }) });
    folder.drive = song.id;
    synced.set(song.id, Date.now());
    if (folder.local) {
      await finishLocalSong(folder.local, folder);
      await updateLocalSong(folder.local, { drive: song.id });
      created = null;
      bumpLocal();
      void refreshLocalSongs();
    }
    // まだ保存していない続き：Drive の自動保存と、この端末の自動保存の新しい方
    const restore = new Map<string, { text: string; sidecar?: string }>();
    const autos = await readAutosaves(r.tree);
    const seen = new Set<string>();
    for (const [k, a] of autos) {
      seen.add(k);
      const mineAuto = await getRecent(recentIdFor(folder, a.fileName));
      if (mineAuto && !mineAuto.saved && mineAuto.updatedAt > a.savedAt) restore.set(k, { text: mineAuto.text, sidecar: mineAuto.sidecar });
      else if ((r.link.files[normPath(a.fileName)]?.md5 ?? '') === a.base) restore.set(k, { text: a.text, sidecar: a.sidecar });
    }
    for (const e of await listRecent()) {
      if (e.saved || !e.fileName || seen.has(e.fileName.toLowerCase())) continue;
      if (e.id === recentIdFor(folder, e.fileName)) restore.set(e.fileName.toLowerCase(), { text: e.text, sidecar: e.sidecar });
    }
    set({ linked: true, status: r.conflicts.length ? 'conflict' : 'ok', at: Date.now(), conflicts: r.conflicts, newer: [], doing: null });
    const junk = r.junk;
    if (r.got) toast(tr(`Google Drive から取ってきました（${r.got} 個・${sizeText(r.bytes)}）`, `Downloaded from Google Drive (${r.got} ${pl(r.got, 'file')}, ${sizeText(r.bytes)})`), 'ok', 4000);
    await openFolder(folder, restore);
    noteJunk(folder, junk);
  } catch (e) {
    if (created) await deleteLocalSong(created).catch(() => undefined);
    set({ status: e instanceof DriveAuthError ? 'auth' : 'error', error: errorText(e), doing: null, progress: null });
    toast(tr(`Google Drive から開けませんでした: ${errorText(e)}`, `Couldn't open from Google Drive: ${errorText(e)}`), 'error', 8000);
  }
}

// ---- 片付ける ------------------------------------------------------------------------

/**
 * Drive のこの曲のフォルダから、この曲の物ではない物（ほかの曲のフォルダ。選べば、この端末に無い物も）をゴミ箱に移す。
 * 操作の中で呼ぶ（ログインが切れていれば取り直す）
 */
export function cleanDriveJunk() {
  const ok = ensureToken({ action: 'push', recentId: ed().meta.recentId }, true);
  void ok.then((y) => {
    if (y) void enqueue(cleanCurrent);
  });
}

async function cleanCurrent() {
  const folder = ed().folder;
  if (!folder?.dir) return;
  const others = songsInside(folder);
  if (others.length) {
    tellNotSong(folder, others);
    return;
  }
  const link = await readLink(folder);
  if (!link) {
    toast(tr('この曲は Google Drive とつないでいません', "This song isn't linked to Google Drive"), 'info', 5000);
    return;
  }
  let tree: DriveTree;
  useEditor.setState({ loading: tr('Google Drive のこの曲のフォルダを調べています…', "Checking this song's folder on Google Drive…") });
  try {
    tree = await listTree(link.folderId);
  } catch (e) {
    if (e instanceof DriveAuthError) set({ status: 'auth' });
    else toast(tr(`Google Drive を調べられませんでした: ${errorText(e)}`, `Couldn't check Google Drive: ${errorText(e)}`), 'error', 8000);
    return;
  } finally {
    useEditor.setState({ loading: null });
  }
  const junk = tree.junk;
  const extras = extrasOf(folder, tree);
  if (!junk.length && !extras.length) {
    set({ junk: [] });
    toast(tr(`Google Drive の「${link.name}」には、この曲の物しかありません。片付ける物はありません`, `"${link.name}" on Google Drive only has this song's files. Nothing to clean up`), 'ok', 6000);
    return;
  }
  const lines = [
    junk.length ? tr(`・ほかの曲のフォルダ: ${fewText(junk.map((j) => j.path), 4)}（${junkSummary(junk)}）`, `• Other songs' folders: ${fewText(junk.map((j) => j.path), 4)} (${junkSummary(junk)})`) : '',
    extras.length ? tr(`・この端末の曲フォルダに無いもの: ${fewText(extras.map((j) => j.path), 4)}（${junkSummary(extras)}）`, `• Not in the song folder on this device: ${fewText(extras.map((j) => j.path), 4)} (${junkSummary(extras)})`) : '',
  ].filter(Boolean);
  const choice = await chooseDialog<'junk' | 'all'>({
    title: tr(`Google Drive の「${link.name}」を片付けます`, `Clean up "${link.name}" on Google Drive`),
    body: tr(
      `Drive のこの曲のフォルダ（DTX Web Editor/${link.name}）に、この曲の物ではないものがあります。\n${lines.join('\n')}\n\nゴミ箱に移したものは、Google Drive のゴミ箱から 30 日間は戻せます。この端末のファイルは変わりません。`,
      `This song's folder on Drive (DTX Web Editor/${link.name}) has things that aren't part of this song.\n${lines.join('\n')}\n\nAnything moved to the trash can be restored from the Google Drive trash for 30 days. Files on this device don't change.`,
    ),
    options: [
      ...(junk.length
        ? [
            {
              label: tr(`ほかの曲のフォルダ ${junk.length} 個をゴミ箱へ（おすすめ）`, `Move the ${junk.length} other song ${pl(junk.length, 'folder')} to the trash (recommended)`),
              sub: tr('この曲の譜面・原曲・ステムには触りません', "This song's charts, original audio and stems are not touched"),
              value: 'junk' as const,
            },
          ]
        : []),
      ...(extras.length
        ? [
            {
              label: junk.length ? tr('この端末に無いものも、まとめてゴミ箱へ', 'Also move everything not on this device to the trash') : tr('この端末に無いものをゴミ箱へ', 'Move what isn’t on this device to the trash'),
              sub: tr('ほかの端末で足して、まだ取り込んでいないファイルも入ります', "This includes files added on another device that you haven't taken yet"),
              value: 'all' as const,
            },
          ]
        : []),
    ],
  });
  if (!choice) return;
  const items = choice === 'all' ? [...junk, ...extras] : junk;
  set({ status: 'busy', doing: 'up', error: '' });
  try {
    const n = await trashJunk(items, {
      folder,
      link,
      progress: (done, total) => useEditor.setState({ loading: tr(`Google Drive のゴミ箱に移しています… ${done}/${total}`, `Moving to the Google Drive trash… ${done}/${total}`) }),
    });
    set({ junk: [], status: 'ok', doing: null, newer: [], at: Date.now() });
    if (junkToast) dismissToast(junkToast);
    toast(tr(`Google Drive のゴミ箱に ${n} 個移しました（30 日間は Drive のゴミ箱から戻せます）`, `Moved ${n} ${pl(n, 'item')} to the Google Drive trash (restorable from the Drive trash for 30 days)`), 'ok', 8000);
  } catch (e) {
    set({ status: e instanceof DriveAuthError ? 'auth' : 'error', error: errorText(e), doing: null });
    if (!(e instanceof DriveAuthError)) toast(tr(`ゴミ箱に移せませんでした: ${errorText(e)}`, `Couldn't move to the trash: ${errorText(e)}`), 'error', 8000);
    return;
  } finally {
    useEditor.setState({ loading: null });
  }
  // 一覧に出す曲の情報（ファイルの数・大きさ）を直す
  await push('manual');
}

/** Drive の曲をすべて点検し、ほかの曲のフォルダが入っていればゴミ箱に移す（設定から）。操作の中で呼ぶ */
export function checkDriveSongs() {
  const ok = ensureToken({ action: 'connect' }, true);
  void ok.then((y) => {
    if (y) void enqueue(checkAll);
  });
}

async function checkAll() {
  const found: { song: DriveSong; junk: JunkDir[] }[] = [];
  let songs: DriveSong[] = [];
  try {
    useEditor.setState({ loading: tr('Google Drive の曲を調べています…', 'Checking songs on Google Drive…') });
    songs = await listDriveSongs();
    for (const [i, song] of songs.entries()) {
      useEditor.setState({ loading: tr(`Google Drive の曲を調べています… ${i + 1}/${songs.length}`, `Checking songs on Google Drive… ${i + 1}/${songs.length}`) });
      const tree = await listTree(song.id);
      if (tree.junk.length) found.push({ song, junk: tree.junk });
    }
  } catch (e) {
    toast(tr(`Google Drive を調べられませんでした: ${errorText(e)}`, `Couldn't check Google Drive: ${errorText(e)}`), 'error', 8000);
    return;
  } finally {
    useEditor.setState({ loading: null });
  }
  if (!found.length) {
    toast(tr(`Google Drive の曲 ${songs.length} 個を調べました。ほかの曲が入った曲はありません`, `Checked ${songs.length} ${pl(songs.length, 'song')} on Google Drive. None has other songs in it`), 'ok', 6000);
    return;
  }
  const total = found.reduce((a, f) => a + f.junk.length, 0);
  const ok = await confirmDialog({
    title: tr(`ほかの曲が入った曲が ${found.length} 個あります`, `${found.length} ${pl(found.length, 'song')} on Drive ${found.length === 1 ? 'has' : 'have'} other songs in ${found.length === 1 ? 'it' : 'them'}`),
    body: tr(
      `${found.map((f) => `・${f.song.name}: ${fewText(f.junk.map((j) => j.path), 3)}（${junkSummary(f.junk)}）`).join('\n')}\n\nこれらのほかの曲のフォルダ ${total} 個を、Google Drive のゴミ箱に移します（30 日間は戻せます）。それぞれの曲の譜面・原曲などには触りません。`,
      `${found.map((f) => `• ${f.song.name}: ${fewText(f.junk.map((j) => j.path), 3)} (${junkSummary(f.junk)})`).join('\n')}\n\nThese ${total} other song ${pl(total, 'folder')} are moved to the Google Drive trash (restorable for 30 days). Each song's own charts and audio are not touched.`,
    ),
    ok: tr('ゴミ箱に移す', 'Move to trash'),
    danger: true,
  });
  if (!ok) return;
  let n = 0;
  try {
    const folder = ed().folder;
    const link = folder?.dir ? await readLink(folder) : null;
    for (const f of found) {
      const mine = folder && link?.folderId === f.song.id ? { folder, link } : {};
      n += await trashJunk(f.junk, {
        ...mine,
        progress: (done) => useEditor.setState({ loading: tr(`Google Drive のゴミ箱に移しています… ${n + done}/${total}`, `Moving to the Google Drive trash… ${n + done}/${total}`) }),
      });
      if ('folder' in mine) {
        set({ junk: [] });
        if (junkToast) dismissToast(junkToast);
      }
    }
  } catch (e) {
    toast(tr(`ゴミ箱に移せませんでした: ${errorText(e)}`, `Couldn't move to the trash: ${errorText(e)}`), 'error', 8000);
    return;
  } finally {
    useEditor.setState({ loading: null });
  }
  toast(tr(`Google Drive のゴミ箱に ${n} 個移しました（30 日間は Drive のゴミ箱から戻せます）`, `Moved ${n} ${pl(n, 'item')} to the Google Drive trash (restorable from the Drive trash for 30 days)`), 'ok', 8000);
}

// ---- 曲を開いたとき ---------------------------------------------------------------

/** 曲フォルダが変わったら、Drive とつながっているかを読む。つながっていてログイン中なら、ほかの端末の新しい内容が無いか見る */
async function onFolder(folder: SongFolder | null) {
  window.clearTimeout(autoTimer);
  firstPending = 0;
  // 「ほかの曲も入ったフォルダなので送らない」の知らせは、曲フォルダが変わったら閉じる
  if (notSongToast) dismissToast(notSongToast);
  notSongToast = 0;
  if (!folder?.dir) {
    set({ linked: false, status: 'none', conflicts: [], newer: [], junk: [], error: '', skip: false });
    return;
  }
  // ほかの曲も入ったフォルダ（DTXFiles など）は Drive と合わせない（保存のときに、この曲だけのフォルダへ移す）
  if (songsInside(folder).length) {
    folder.drive = undefined;
    set({ linked: false, status: 'none', conflicts: [], newer: [], junk: [], error: '', skip: false });
    return;
  }
  const link = await readLink(folder);
  if (ed().folder !== folder) return;
  if (!link) {
    folder.drive = undefined;
    const skip = await readDriveSkip(folder);
    if (ed().folder !== folder) return;
    set({ linked: false, status: 'none', conflicts: [], newer: [], junk: [], error: '', skip });
    return;
  }
  folder.drive = link.folderId;
  const busy = useDriveSync.getState().status === 'busy';
  set({ linked: true, status: busy ? 'busy' : 'ok', at: link.syncedAt, conflicts: [], newer: [], junk: [], error: '', skip: false });
  if (!useDriveAuth.getState().connected || !tokenValid() || busy || Date.now() - (synced.get(link.folderId) ?? 0) < 30_000) return;
  try {
    const r = await remoteChanges(folder, link);
    const { junk } = r;
    // PC どうしの同期で合わせる曲は、成績（score.ini・ghost）は同期が合わせるので、譜面・音だけ知らせる
    const newer = (await pcSyncPlace(folder)) ? r.newer.filter((p) => kindOf(p) === 'make') : r.newer;
    if (ed().folder !== folder) return;
    noteJunk(folder, junk);
    if (!newer.length) return;
    set({ status: 'newer', newer });
    newerToast(newer);
  } catch {
    // 見られなくても開ける
  }
}

// ---- はじめに ---------------------------------------------------------------------

let started = false;

/** 開いたとき：ログインから戻ったなら続ける、保存・自動保存を見張る */
export function initDrive(): () => void {
  if (started) return () => {};
  started = true;
  setBeforeSave(beforeSave);
  setBeforeRedirect(async () => {
    await autosaveNow(true);
  });
  const resume = takeRedirectResult();
  if (useDriveAuth.getState().connected) void loadGis();
  if (resume) void continueAfterRedirect(resume);
  // 保存した → 送る
  const a = useEditor.subscribe((s, prev) => {
    if (s.savedAt && s.savedAt !== prev.savedAt) void enqueue(() => push('save'));
    if (s.folder !== prev.folder) void onFolder(s.folder);
    if (s.doc !== prev.doc && s.screen === 'editor' && isDirty(s)) scheduleAutosave();
  });
  // 画面を離れる（iPad で裏に回る・タブを閉じる）前に、待っている自動保存を送る
  const onHide = () => {
    if (document.visibilityState === 'hidden') flushAutosave();
  };
  document.addEventListener('visibilitychange', onHide);
  // PC どうしの同期（開いたとき・5 分ごと）で、開いている曲に Drive の新しい譜面があった：「取り込む」を勧める
  const b = onPcSyncReport((rep, o) => {
    if (o.why === 'save' || o.take || !rep.songs.length) return;
    void notePcRun(rep);
  });
  return () => {
    a();
    b();
    document.removeEventListener('visibilitychange', onHide);
    setBeforeSave(null);
    started = false;
  };
}

/** 同期の結果のうち、開いている曲の分をエディタの Drive の印に映す */
async function notePcRun(rep: RunReport) {
  const folder = ed().folder;
  const place = await pcSyncPlace(folder);
  if (!folder || !place) return;
  const same = (p?: string[]) => !!p && p.length === place.path.length && p.every((x, i) => x.toLowerCase() === place.path[i].toLowerCase());
  const s = rep.songs.find((x) => x.root === place.root && same(x.path));
  if (!s) return;
  const wait = s.wait.filter((p) => kindOf(p) === 'make');
  if (wait.length) notePcWaiting(wait);
  else if (s.got.length || s.scoresGot.length || s.sent.length) await notePcReport(folder, { ...rep, songs: [s] }, false);
}

async function continueAfterRedirect(r: Resume) {
  await initLocalSongs();
  if (r.action === 'open') {
    await chooseAndOpen();
    return;
  }
  if (r.action === 'push' && r.recentId) {
    const e = await getRecent(r.recentId);
    if (e) {
      await openRecent(e);
      void enqueue(() => push('manual'));
      return;
    }
  }
  toast(tr('Google Drive につなぎました', 'Connected to Google Drive'), 'ok', 4000);
}

/** つなぐ（ログイン）。操作の中で呼ぶ */
export function connectDrive() {
  void signIn({ action: 'connect' }).then((ok) => {
    if (!ok) return;
    const a = useDriveAuth.getState();
    toast(
      tr(`Google Drive につなぎました（${a.email || 'Google'}）。保存すると Drive にも送ります`, `Connected to Google Drive (${a.email || 'Google'}). Saving now sends to Drive too`),
      'ok',
      6000,
    );
    // 開いている曲がつながっていれば、ほかの端末の新しい内容を見る
    void onFolder(ed().folder);
  });
}

export { DriveError };
