// 開いている曲と Google Drive をつなぐ：保存したら Drive にも送る・自動保存（まだ保存していない続き）も送る・Drive から開く・
// ほかの端末で保存した新しい内容を取り込む・ページを切り替えるログインから戻ったら続ける。
// Drive の読み書きそのものは src/drive/、ログインは src/drive/auth.ts。
import { create } from 'zustand';
import { pl, tr, locale } from '../i18n';
import { IS_IOS, IS_IPHONE } from '../platform';
import { DriveAuthError, DriveError } from '../drive/api';
import { ensureToken, loadGis, setBeforeRedirect, signIn, takeRedirectResult, tokenValid, useDriveAuth, type Resume } from '../drive/auth';
import { describeFiles, listDriveSongs, newLink, pullSong, pushSong, readAutosaves, readLink, remoteChanges, type DriveLink, type DriveSong, type SyncProgress } from '../drive/sync';
import { folderFromHandle, normPath, type SongFolder } from '../fs/folder';
import { checkLocal, createLocalSong, deleteLocalSong, finishLocalSong, freeLocalName, listLocalSongs, openLocalSong, updateLocalSong } from '../fs/local';
import { songDir } from '../fs/opfs';
import { getRecent, listRecent } from '../fs/recent';
import { isDirty, toast, useEditor } from '../store/editor';
import { bumpLocal, initLocalSongs, refreshLocalSongs } from '../store/localSongs';
import { chooseDialog } from '../ui/dialogs';
import { formatLevel } from '../ui/format';
import { autosaveNow, autosaveSnapshot, confirmDiscard, openFolder, openRecent, recentIdFor, reopenFromFolder, setBeforeSave } from './fileActions';

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
}

export const useDriveSync = create<DriveSyncState>(() => ({ linked: false, status: 'none', progress: null, doing: null, at: 0, error: '', conflicts: [], newer: [] }));

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

/** 開いている曲を Drive に送る（つないでいなければ、保存のときだけ Drive に作ってつなぐ） */
async function push(kind: PushKind): Promise<void> {
  const folder = ed().folder;
  const auth = useDriveAuth.getState();
  if (!folder?.dir || !auth.connected) return;
  if (kind === 'save' && !auth.onSave) return;
  if (kind === 'autosave' && (!auth.autosave || !folder.drive)) return;
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
  set({ status: 'busy', doing: 'up', error: '' });
  try {
    const r = await pushSong(folder, {
      create: kind !== 'autosave',
      quick: kind === 'autosave',
      resolve: kind === 'autosave' ? undefined : askConflict('push'),
      sameName: kind === 'autosave' ? undefined : askSameName,
      autosave: snap && ed().folder === folder ? { ...snap, savedAt: Date.now() } : null,
      info: currentInfo(folder),
      device: device(),
      progress: (p) => set({ progress: p }),
    });
    if (r.skipped || !r.link) {
      set({ status: folder.drive ? 'ok' : 'none', doing: null });
      return;
    }
    folder.drive = r.link.folderId;
    synced.set(folder.drive, Date.now());
    if (folder.local && !wasLinked) {
      await updateLocalSong(folder.local, { drive: folder.drive });
      bumpLocal();
    }
    const status: DriveStatus = r.conflicts.length ? 'conflict' : r.newer.length ? 'newer' : 'ok';
    if (ed().folder === folder) set({ linked: true, status, at: Date.now(), conflicts: r.conflicts, newer: r.newer, doing: null });
    if (kind !== 'autosave') {
      if (!wasLinked) {
        toast(
          tr(`Google Drive にも保存しました（DTX Web Editor/${r.link.name}）。次からは保存するたびに変わったファイルだけ送ります`, `Also saved to Google Drive (DTX Web Editor/${r.link.name}). From now on, each save sends only the files that changed`),
          'ok',
          6000,
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
    toast(r.got ? tr(`Google Drive から ${r.got} 個取り込みました`, `Got ${r.got} ${pl(r.got, 'file')} from Google Drive`) : tr('Google Drive と同じでした', 'Already the same as Google Drive'), 'ok', 4000);
    if (r.got && ed().folder === folder) await reopenFromFolder(folder, fileName);
  } catch (e) {
    set({ status: e instanceof DriveAuthError ? 'auth' : 'error', error: errorText(e), doing: null, progress: null });
    if (!(e instanceof DriveAuthError)) toast(tr(`Google Drive から取り込めませんでした: ${errorText(e)}`, `Couldn't get files from Google Drive: ${errorText(e)}`), 'error', 8000);
  }
}

/** Drive の曲の一覧から選んで開く。操作の中で呼ぶ */
export function openFromDrive() {
  const ok = ensureToken({ action: 'open' }, true);
  void ok.then((y) => {
    if (y) void chooseAndOpen();
  });
}

function sizeText(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
  if (!(await confirmDiscard())) return;
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
    if (r.got) toast(tr(`Google Drive から取ってきました（${r.got} 個・${sizeText(r.bytes)}）`, `Downloaded from Google Drive (${r.got} ${pl(r.got, 'file')}, ${sizeText(r.bytes)})`), 'ok', 4000);
    await openFolder(folder, restore);
  } catch (e) {
    if (created) await deleteLocalSong(created).catch(() => undefined);
    set({ status: e instanceof DriveAuthError ? 'auth' : 'error', error: errorText(e), doing: null, progress: null });
    toast(tr(`Google Drive から開けませんでした: ${errorText(e)}`, `Couldn't open from Google Drive: ${errorText(e)}`), 'error', 8000);
  }
}

// ---- 曲を開いたとき ---------------------------------------------------------------

/** 曲フォルダが変わったら、Drive とつながっているかを読む。つながっていてログイン中なら、ほかの端末の新しい内容が無いか見る */
async function onFolder(folder: SongFolder | null) {
  window.clearTimeout(autoTimer);
  firstPending = 0;
  if (!folder?.dir) {
    set({ linked: false, status: 'none', conflicts: [], newer: [], error: '' });
    return;
  }
  const link = await readLink(folder);
  if (ed().folder !== folder) return;
  if (!link) {
    folder.drive = undefined;
    set({ linked: false, status: 'none', conflicts: [], newer: [], error: '' });
    return;
  }
  folder.drive = link.folderId;
  const busy = useDriveSync.getState().status === 'busy';
  set({ linked: true, status: busy ? 'busy' : 'ok', at: link.syncedAt, conflicts: [], newer: [], error: '' });
  if (!useDriveAuth.getState().connected || !tokenValid() || busy || Date.now() - (synced.get(link.folderId) ?? 0) < 30_000) return;
  try {
    const newer = await remoteChanges(folder, link);
    if (ed().folder !== folder || !newer.length) return;
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
  return () => {
    a();
    document.removeEventListener('visibilitychange', onHide);
    setBeforeSave(null);
    started = false;
  };
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
