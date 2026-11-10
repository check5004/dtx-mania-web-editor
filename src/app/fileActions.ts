// ファイルを開く・保存する流れ。
import { tr, pl, isJa } from '../i18n';
import { zipSync } from 'fflate';
import { readAudioTags } from '../fs/tags';
import { virtualSound } from '../audio/sounds';
import { detectStemKind } from '../audio/stems';
import { importStems } from '../store/stems';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { hasOriginLine, originOf, readOrigin, type ChartOrigin } from '../dtx/origin';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import {
  AUDIO_EXT,
  audioFiles,
  downloadBytes,
  dtxFiles,
  ensureWritable,
  findFile,
  folderFromFileList,
  folderFromFiles,
  folderFromHandle,
  isDiskFolder,
  isLocalFolder,
  isQuotaError,
  normPath,
  parseSetDef,
  pendingFiles,
  putFile,
  setWriteErrorHandler,
  supportsDirectWrite,
  writeFile,
  type FolderFile,
  type SongFolder,
} from '../fs/folder';
import {
  checkLocal,
  createLocalSong,
  deleteLocalSong,
  findLocalByName,
  finishLocalSong,
  freeLocalName,
  getLocalSong,
  localReady,
  openLocalSong,
  requestPersist,
  updateLocalSong,
  type LocalSong,
} from '../fs/local';
import { songDir, writeSongFile } from '../fs/opfs';
import { deleteRecent, draftFor, getRecent, listRecent, listRecentSongs, putRecent, recentIdFor, trimRecent, type RecentEntry, type RecentSong } from '../fs/recent';
import { bumpLocal, localPlace, refreshLocalSongs, setCopying, useLocalSongs } from '../store/localSongs';
import { useDevice } from '../store/device';
import { createDoc, dismissToast, isDirty, openDocument, prepareSounds, switchDocument, toast, undoIfLast, useEditor, withSongEnd, type DocMeta, type EditorState } from '../store/editor';
import { glowReflected } from '../store/glow';
import { prepareForNx } from '../store/nxNames';
import { planBgmSwap, rememberFullMix } from '../store/fullMix';
import { isNxSafeName, nxSafeName } from '../fs/nxName';
import { editBgm, setAfterSiblingWrite, siblingNote, siblingWrites } from '../store/songBgm';
import { hasUnsaved } from '../store/unsaved';
import { bgmSource } from '../store/derived';
import { freeWavNumber, setField } from '../edit/ops';
import { toBase36x2 } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { loadSidecar, markSidecarSaved, markSidecarUnsaved, serializeSidecar, sidecarData, sidecarIsEmpty, sidecarName, useSidecar, type SidecarData } from '../store/sidecar';
import { readSidecarFor, recentSidecarOf, type RecentSidecar } from '../store/sidecarFile';
import { chooseDialog, confirmDialog, newSongDialog, promptDialog } from '../ui/dialogs';
import { readZip, songFoldersOf } from '../fs/zip';
import { sortByDifficulty } from '../gen/diffTabs';
import { LINK_FILE, syncedPath } from '../drive/sync';
import { chartRefs, dirLabel, isLibraryLook, lookAtFolder, otherSongsIn, songFilesOf, songFolderName, subFolder } from '../fs/songDir';
import { chooseSongDir, fewText, makeSongDir, pickDir, pickSongPlace, type SongPlace } from './songPlace';

const get = useEditor.getState;

export async function confirmDiscard(): Promise<boolean> {
  const s = get();
  // 作業ファイル（セクション・ステムの音量など）だけを変えたときも聞く
  if (s.screen !== 'editor' || !hasUnsaved(s)) return true;
  return confirmDialog({
    title: tr('保存していない変更があります', 'You have unsaved changes'),
    body: tr(
      '開き直すと、いまの変更は「最近の曲」の自動保存にだけ残ります。続けますか？',
      'If you open something else, your current changes are kept only in the "Recent songs" autosave. Continue?',
    ),
    ok: tr('続ける', 'Continue'),
  });
}

async function readSetDefLabels(folder: SongFolder): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const f = findFile(folder, 'set.def');
  if (!f) return labels;
  try {
    const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
    for (const e of parseSetDef(text)) for (const l of e.levels) labels.set(l.file.toLowerCase(), l.label);
  } catch {
    // 読めない set.def は無視
  }
  return labels;
}

/** 難易度タブの一覧（易しい順。labels は set.def の L1〜L5 の順に入っている） */
function siblingsOf(folder: SongFolder, labels: Map<string, string>) {
  return sortByDifficulty(
    dtxFiles(folder).map((f) => ({ file: f.name, label: labels.get(f.name.toLowerCase()) ?? f.name.replace(/\.dtx$/i, '') })),
    [...labels.keys()],
  );
}

/**
 * 難易度タブの印（AI難易度生成で作った譜面か）を、曲フォルダの譜面から読む。開いたあと・保存したあとに裏で。
 * 印の行（#DTXE_ORIGIN）がある譜面だけを読み解き、手直しの有無も見る
 */
async function scanSiblingOrigins(folder: SongFolder) {
  const origins = new Map<string, ChartOrigin>();
  for (const sb of get().meta.siblings) {
    const f = findFile(folder, sb.file);
    if (!f) continue;
    try {
      const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
      origins.set(sb.file.toLowerCase(), hasOriginLine(text) ? originOf(parseDtx(text).doc) : 'human');
    } catch {
      // 読めない譜面には印を付けない
    }
  }
  if (get().folder !== folder || origins.size === 0) return;
  useEditor.setState((st) => ({ meta: { ...st.meta, siblings: st.meta.siblings.map((x) => ({ ...x, origin: origins.get(x.file.toLowerCase()) ?? x.origin })) } }));
}

/** 作業ファイル（.dtxe.json）を読む（readSidecarFor。控えから読んだ変更は保存していない変更にする） */
async function loadSidecarFor(folder: SongFolder | null, fileName: string, recent?: string | RecentSidecar) {
  const r = await readSidecarFor(folder, fileName, recent);
  loadSidecar(r.data);
  markSidecarUnsaved(r.unsaved);
}

/**
 * AI難易度生成で作った譜面は作業ファイルを持たない（書き出すのは DTX だけ）。作った元の譜面（#DTXE_ORIGIN の from）の
 * 作業ファイルを使う：同じ曲の音なので、ステム・解析に使うステム・参照映像・セクションは元の譜面と同じ
 */
async function sourceSidecarFor(folder: SongFolder, doc: DtxDoc): Promise<SidecarData | null> {
  const from = readOrigin(doc)?.from;
  return from ? (await readSidecarFor(folder, from)).data : null;
}

/**
 * DTX を開く。switching を渡すと同じ曲の別の難易度への切り替え：再生を止めず、▶・表示の位置・ループ・聴く設定はそのまま。
 * switching.stale() が true になったら（もっと新しい切り替えが始まった）途中でやめる
 */
async function openDtxFile(
  folder: SongFolder,
  file: FolderFile,
  labels?: Map<string, string>,
  recentText?: string,
  recentSidecar?: string | RecentSidecar,
  switching?: { stale: () => boolean },
) {
  const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
  const decoded = decodeDtx(bytes);
  let parsed = parseDtx(decoded.text);
  const useRecent = recentText !== undefined && recentText !== serializeDtx(parsed.doc);
  if (useRecent) parsed = parseDtx(recentText);
  labels ??= await readSetDefLabels(folder);
  const meta: DocMeta = {
    fileName: file.name,
    encoding: decoded.encoding,
    encodingNote: decoded.note,
    warnings: parsed.warnings,
    hasRandom: parsed.hasRandom,
    siblings: siblingsOf(folder, labels),
    recentId: recentIdFor(folder, file.name),
  };
  const dirty = useRecent || decoded.encoding === 'utf-8';
  if (switching) {
    if (switching.stale()) return;
    const side = await readSidecarFor(folder, file.name, recentSidecar);
    // 難易度タブの印（AI で作った譜面か）は読み直すまで今のものを出しておく（ちらつかせない）
    const known = new Map(get().meta.siblings.map((x) => [x.file.toLowerCase(), x.origin]));
    meta.siblings = meta.siblings.map((x) => ({ ...x, origin: known.get(x.file.toLowerCase()) ?? x.origin }));
    if (switching.stale() || !(await switchDocument(parsed.doc, meta, side.data, { dirty, stale: switching.stale }))) return;
    markSidecarUnsaved(side.unsaved);
    void scanSiblingOrigins(folder);
  } else {
    openDocument(parsed.doc, meta, folder, { dirty });
    void scanSiblingOrigins(folder);
    const side = await readSidecarFor(folder, file.name, recentSidecar);
    loadSidecar(side.data ?? (await sourceSidecarFor(folder, parsed.doc)));
    markSidecarUnsaved(side.unsaved);
    warnLibraryFolder(folder);
  }
  if (useRecent) toast(tr('前回の自動保存から続きを開きました（まだ曲フォルダには保存されていません）', "Opened from your last autosave (not saved to the song folder yet)"), 'warn', 6000);
}

export { recentIdFor };

// ---- 本体（このブラウザの保存領域）に曲を置く ----------------------------------------------

const promotions = new WeakMap<SongFolder, Promise<boolean>>();
/** 入れ終わったら消す、同じ名前の古い本体の曲（「この中身で入れ直す」を選んだとき） */
const replaceAfter = new WeakMap<SongFolder, string>();

const FIRST_LOCAL_KEY = 'dtxe.local.told';

function mbText(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${mb.toFixed(mb >= 100 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * メモリにだけある曲フォルダ（ZIP・落としたファイル・新しい曲・フォルダに書けないブラウザで開いたフォルダ）を、
 * 本体に曲フォルダごと入れる。入れ終わったら、そのフォルダは本体のフォルダとして直接読み書きする
 * （PC で曲フォルダを選んだときと同じ。ステム・ドラム抜き・保存もそこへ書く）。同じフォルダを2回入れない
 */
export function promoteToLocal(folder: SongFolder): Promise<boolean> {
  if (folder.local) return Promise.resolve(true);
  if (folder.dir || !localReady()) return Promise.resolve(false);
  let p = promotions.get(folder);
  if (!p) {
    p = doPromote(folder).finally(() => promotions.delete(folder));
    promotions.set(folder, p);
  }
  return p;
}

async function doPromote(folder: SongFolder): Promise<boolean> {
  const snapshot = [...folder.files.values()];
  const totalBytes = snapshot.reduce((a, f) => a + f.size, 0);
  const progress = { name: folder.name, done: 0, total: snapshot.length, bytes: 0, totalBytes };
  setCopying(progress);
  let rec: LocalSong | null = null;
  try {
    rec = await createLocalSong(folder.name);
    const id = rec.id;
    const written = new Map<FolderFile, FileSystemFileHandle>();
    for (const [i, f] of snapshot.entries()) {
      written.set(f, await writeSongFile(id, f.path, await f.getFile()));
      progress.done = i + 1;
      progress.bytes += f.size;
      setCopying({ ...progress });
      // 入れている途中の印を新しくしておく（10分動かない途中の曲は、次に開いたときに片付ける）
      if (i % 8 === 7) await updateLocalSong(id, { updatedAt: Date.now() });
    }
    // 入れている間に置かれたファイル（原曲・ステムなど）も書く
    for (let round = 0; round < 5; round++) {
      const extra = [...folder.files.values()].filter((f) => !written.has(f));
      if (!extra.length) break;
      for (const f of extra) written.set(f, await writeSongFile(id, f.path, await f.getFile()));
    }
    const dir = await songDir(id);
    await finishLocalSong(id, folder);
    // ここから本体のフォルダ（読み込み済みの音を読み直さないように、版の番号はそのまま）
    folder.dir = dir;
    folder.local = id;
    for (const [key, f] of [...folder.files]) {
      const fh = written.get(f);
      if (fh) folder.files.set(key, { path: f.path, name: f.name, size: f.size, ver: f.ver, getFile: () => fh.getFile() });
      else folder.files.set(key, { ...f, pending: true });
    }
    // 最後の await の間に置かれた物は、そのまま書く
    for (const f of pendingFiles(folder)) await putFile(folder, f.path, await f.getFile());
    await afterPromote(folder, id);
    return true;
  } catch (e) {
    folder.dir = undefined;
    folder.local = undefined;
    if (rec) {
      try {
        await deleteLocalSong(rec.id);
      } catch {
        // 片付けは次に開いたとき
      }
    }
    toast(
      isQuotaError(e)
        ? tr(
            `${localPlace()}の空きが足りないため、曲を本体に保存できませんでした。曲を消して空けるか、保存のときに書き出してください`,
            `There isn't enough space in ${localPlace()} to keep the song. Free some space by removing songs, or export it when you save`,
          )
        : tr(`曲を${localPlace()}に保存できませんでした: ${(e as Error).message}`, `Couldn't keep the song in ${localPlace()}: ${(e as Error).message}`),
      'warn',
      9000,
    );
    return false;
  } finally {
    setCopying(null);
  }
}

/** 本体に入れ終わったあと：自動保存をこの曲に付け替え、消えないように頼み、初めてなら知らせる */
async function afterPromote(folder: SongFolder, id: string) {
  const old = replaceAfter.get(folder);
  if (old) {
    replaceAfter.delete(folder);
    await deleteLocalSong(old);
  }
  const s = get();
  if (s.folder === folder) {
    const newId = recentIdFor(folder, s.meta.fileName);
    const oldId = s.meta.recentId;
    useEditor.setState({ meta: { ...s.meta, recentId: newId } });
    if (oldId && oldId !== newId) await deleteRecent(oldId);
    await putRecent(autosaveEntry(get()));
    await trimRecent();
  } else {
    // もう別の曲を開いた：「最近の曲」から開けるように控えを作る
    const first = dtxFiles(folder)[0];
    await putRecent({
      id: recentIdFor(folder, first?.name ?? 'mstr.dtx'),
      title: folder.name,
      artist: '',
      bpm: '',
      level: '',
      fileName: first?.name ?? 'mstr.dtx',
      folderName: folder.name,
      local: id,
      text: '',
      saved: true,
      updatedAt: Date.now(),
    });
  }
  bumpLocal();
  void refreshLocalSongs();
  const persisted = await requestPersist();
  let told = false;
  try {
    told = localStorage.getItem(FIRST_LOCAL_KEY) === '1';
    localStorage.setItem(FIRST_LOCAL_KEY, '1');
  } catch {
    // 覚えられなくても続ける
  }
  if (!told)
    toast(
      tr(
        `曲を音ごと${localPlace()}に保存しました。リロードしても「最近の曲」から続きを開けます${persisted ? '' : '（ブラウザの空きが少なくなると消されることがあるので、ときどき書き出しておくと安心です）'}`,
        `The song and its audio are now kept in ${localPlace()}. After a reload, continue from "Recent songs"${persisted ? '' : ' (the browser may clear it when space runs low, so export it now and then)'}`,
      ),
      'ok',
      9000,
    );
}

/** 本体に同じ名前の曲があるか見て、どうするかを聞く。'opened' は本体の曲を開いた、null はやめた */
async function checkLocalDuplicate(folder: SongFolder): Promise<'opened' | 'go' | null> {
  if (!localReady()) return 'go';
  const same = await findLocalByName(folder.name);
  if (!same) return 'go';
  const when = new Date(same.updatedAt).toLocaleString(isJa() ? 'ja-JP' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const choice = await chooseDialog<'open' | 'replace' | 'new'>({
    title: tr(`${localPlace()}に「${same.name}」があります`, `"${same.name}" is already in ${localPlace()}`),
    body: tr('前に開いた同じ名前の曲が、音ごと保存されています。', 'A song with the same name was opened before and is kept with its audio.'),
    options: [
      { label: tr(`${localPlace()}の曲を開く（前回の続き）`, `Open the one in ${localPlace()} (continue)`), sub: tr(`最後の保存 ${when} · ${mbText(same.bytes)}`, `Last saved ${when} · ${mbText(same.bytes)}`), value: 'open' },
      {
        label: tr('この中身で入れ直す', 'Replace it with this one'),
        sub: tr(`${localPlace()}の曲を消して置き換えます。保存していない変更も消えます`, `Removes the song in ${localPlace()}, including unsaved changes`),
        value: 'replace',
      },
      { label: tr('別の曲として入れる', 'Keep both'), sub: tr('名前の後ろに番号を付けて、もう1つ入れます', 'Adds this one with a number after the name'), value: 'new' },
    ],
  });
  if (!choice) return null;
  if (choice === 'open') {
    await openLocalById(same.id);
    return 'opened';
  }
  if (choice === 'replace') replaceAfter.set(folder, same.id);
  else folder.name = await freeLocalName(folder.name);
  return 'go';
}

/** 本体の曲を開く（最後に自動保存した難易度から。無ければ曲フォルダとして） */
async function openLocalById(id: string) {
  const entries = (await listRecent()).filter((e) => e.local === id);
  if (entries.length) {
    await openRecentEntry(entries[0]);
    await tellOtherDrafts();
    return;
  }
  const folder = await openLocalSong(id);
  if (!folder) {
    toast(tr(`${localPlace()}にこの曲が見つかりませんでした`, `Couldn't find this song in ${localPlace()}`), 'error', 6000);
    return;
  }
  await openFolder(folder);
}

/** 本体の曲が消えていたとき（Safari が使っていないサイトのデータを消した・容量が足りなくて消された） */
function toastLocalMissing() {
  toast(
    tr(
      `${localPlace()}に保存した曲のファイルが見つかりませんでした（ブラウザがデータを消した可能性があります）。自動保存した譜面だけを開きます`,
      `The song files kept in ${localPlace()} are gone (the browser may have cleared them). Opening only the autosaved chart`,
    ),
    'warn',
    9000,
  );
}

/**
 * 「最近の曲」の ✕（曲ごと。難易度ごとの控えもまとめて消す）。本体の曲は本体のファイルも消す（確かめてから）
 */
export async function removeRecentSong(song: RecentSong): Promise<boolean> {
  const e = song.latest;
  if (!e.local) {
    for (const x of song.entries) await deleteRecent(x.id);
    return true;
  }
  const rec = await getLocalSong(e.local);
  const ok = await confirmDialog({
    title: tr(`「${rec?.name ?? e.title}」を${localPlace()}から消しますか？`, `Remove "${rec?.name ?? e.title}" from ${localPlace()}?`),
    body: tr(
      `${localPlace()}に保存した曲のファイル（譜面・原曲・ステムなど${rec ? ` ${rec.files} 個・${mbText(rec.bytes)}` : ''}）をすべて消します。元に戻せません。PC の曲フォルダや書き出した ZIP は消えません。`,
      `All song files kept in ${localPlace()} (charts, original audio, stems${rec ? `: ${rec.files} files, ${mbText(rec.bytes)}` : ''}) are removed. This can't be undone. Song folders on your PC and exported ZIPs are not affected.`,
    ),
    ok: tr('消す', 'Remove'),
    danger: true,
  });
  if (!ok) return false;
  if (get().folder?.local === e.local) closeDocument();
  await deleteLocalSong(e.local);
  bumpLocal();
  void refreshLocalSongs();
  return true;
}

/** 開いている譜面を閉じる（本体から消した曲を開いていたとき） */
function closeDocument() {
  const doc = emptyDoc();
  useEditor.setState({ screen: 'home', page: 'chart', doc, savedDoc: doc, savedHistory: 0, folder: null, past: [], future: [], selection: [], meta: { fileName: 'new.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] } });
}

setWriteErrorHandler((e) => {
  if (!isQuotaError(e)) return;
  toast(
    tr(
      `${localPlace()}の空きが足りず、ファイルを本体に書けませんでした。いったんメモリに持ち、保存・書き出しのときに一緒に書き出します`,
      `Not enough space in ${localPlace()} to write the file. It is kept in memory and written out when you save or export`,
    ),
    'warn',
    9000,
  );
});

/**
 * 曲フォルダを開いた後：DTX を選ぶ、無ければ新規作成。
 * restore があれば、その譜面は控えの本文（まだ保存していない続き。Drive の自動保存など）から開く（キーは譜面の名前の小文字）
 */
export async function openFolder(folder: SongFolder, restore?: Map<string, { text: string; sidecar?: string }>) {
  const list = dtxFiles(folder);
  if (list.length === 0 && otherSongsIn(folder).length) {
    // 曲を集めたフォルダ（DTXFiles など）：そこに新しい譜面を作らず、中の曲を選んでもらう
    const sub = await chooseSongIn(folder);
    if (sub) await openFolder(sub, restore);
    return;
  }
  const labels = await readSetDefLabels(folder);
  if (list.length === 0) {
    const info = await newSongDialog({
      title: tr(`「${folder.name}」に新しい譜面を作る`, `Create a new chart in "${folder.name}"`),
      audioFiles: audioFiles(folder).map((f) => f.path),
      defaults: { title: folder.name },
    });
    if (!info) return;
    const doc = createDoc(info);
    const meta = newMeta('mstr.dtx', folder);
    openDocument(doc, meta, folder, { dirty: true });
    return;
  }
  let file = list[0];
  if (list.length > 1) {
    const picked = await chooseDialog({
      title: tr('どの難易度を開きますか？', 'Which difficulty do you want to open?'),
      body: tr(`${folder.name} には譜面が ${list.length} 個あります。`, `${folder.name} has ${list.length} charts.`),
      options: list.map((f) => ({
        label: labels.get(f.name.toLowerCase()) ?? f.name,
        sub: `${f.name} · ${(f.size / 1024).toFixed(1)} KB`,
        value: f,
      })),
    });
    if (!picked) return;
    file = picked;
  }
  const r = restore?.get(file.name.toLowerCase());
  await openDtxFile(folder, file, labels, r?.text, r?.sidecar);
}

/** 曲フォルダの中身が変わったとき（Drive から取り込んだなど）：同じ譜面を開き直す。無ければ選び直す */
export async function reopenFromFolder(folder: SongFolder, fileName: string, restore?: { text: string; sidecar?: string }) {
  const f = findFile(folder, fileName);
  if (f) await openDtxFile(folder, f, undefined, restore?.text, restore?.sidecar);
  else await openFolder(folder);
}

function newMeta(fileName: string, folder: SongFolder | null): DocMeta {
  return {
    fileName,
    encoding: 'shift_jis',
    warnings: [],
    hasRandom: false,
    siblings: folder ? siblingsOf(folder, new Map()) : [],
    recentId: `${recentIdFor(folder, fileName)}#${Date.now()}`,
  };
}

/**
 * フォルダ選択ダイアログ（Chrome/Edge）。無ければ webkitdirectory の input を使う。
 * 曲を集めたフォルダ（DTXFiles など）を選んだら、中を全部は読まずに、開く曲を選んでもらう
 */
export async function openFolderPicker(fallbackInput?: HTMLInputElement | null) {
  if (!(await confirmDiscard())) return;
  if (supportsDirectWrite()) {
    try {
      let dir = await pickDir();
      for (let depth = 0; dir && depth < 4; depth++) {
        const look = await lookAtFolder(dir);
        if (look.charts.length || look.setDef || !isLibraryLook(look)) break;
        dir = await chooseSongDir(dir);
      }
      if (dir) await openFolder(await folderFromHandle(dir));
    } catch (e) {
      toast(tr(`フォルダを開けませんでした: ${(e as Error).message}`, `Couldn't open the folder: ${(e as Error).message}`), 'error');
    }
    return;
  }
  fallbackInput?.click();
}

/** 曲を集めたフォルダ（読み込み済み）の中の曲を選んでもらう。やめたら null */
async function chooseSongIn(folder: SongFolder): Promise<SongFolder | null> {
  const songs = otherSongsIn(folder);
  const picked = await chooseDialog<string>({
    title: tr(`「${folder.name}」には曲のフォルダが ${songs.length} 個あります`, `"${folder.name}" has ${songs.length} song folders`),
    body: tr(
      '開く曲を選んでください。曲を集めたフォルダ（DTXFiles など）は、そのまま曲フォルダとしては開きません（保存したときに、ほかの曲と混ざらないように）。',
      "Choose the song to open. A folder that holds many songs (such as DTXFiles) isn't opened as a song folder itself, so saving doesn't mix it with other songs.",
    ),
    options: songs.map((d) => ({ label: dirLabel(folder, d), value: d })),
  });
  if (!picked) return null;
  if (isDiskFolder(folder)) {
    let h = folder.dir;
    for (const part of dirLabel(folder, picked).split('/')) h = await h.getDirectoryHandle(part);
    return folderFromHandle(h);
  }
  return subFolder(folder, picked);
}

/** <input webkitdirectory> から（フォルダに書けないブラウザ。開いたら曲フォルダごと本体に入れる） */
export async function openFolderFromInput(list: FileList | null) {
  if (!list || list.length === 0) return;
  let folder: SongFolder | null = folderFromFileList(list);
  // 曲を集めたフォルダ（DTXFiles など）なら、中の曲を選んでもらう（全部を本体に入れない）
  if (dtxFiles(folder).length === 0 && otherSongsIn(folder).length) folder = await chooseSongIn(folder);
  if (!folder) return;
  if ((await checkLocalDuplicate(folder)) !== 'go') return;
  await openFolder(folder);
}

let switchSeq = 0;

/**
 * 難易度タブの切り替え（同じフォルダの別の DTX）。再生中でも止めずに、今の位置から新しい譜面を鳴らす。
 * ▶・表示の位置・ループ・聴く設定（ミックス）はそのまま
 */
export async function switchDifficulty(fileName: string) {
  const s = get();
  const folder = s.folder;
  if (!folder) return;
  if (fileName === s.meta.fileName) {
    // 今の難易度をもう一度押したら、読み込み中の切り替えはやめる（気が変わって戻したとき）
    switchSeq++;
    return;
  }
  if (!(await confirmDiscard())) return;
  // 原曲を替えたときに書き換えているほかの難易度は、書き終わってから読む
  await siblingWrites();
  const f = findFile(folder, fileName);
  if (!f) return;
  const seq = ++switchSeq;
  // 保存していない変更は、いまの内容を「最近の曲」の自動保存に残してから切り替える（確認で伝えたとおりに。作業ファイルだけの変更も）
  if (hasUnsaved(get())) await autosaveNow(true);
  // 切り替える難易度に保存していない続き（自動保存）があれば、そこから開く（「最近の曲」は曲ごとに1つなので、ほかの難易度の続きはここで開く）。
  // 作業ファイルだけの変更（分けたステムなど）も、曲フォルダの作業ファイルより新しければ控えから
  const resume = await draftFor(folder, f);
  const side = recentSidecarOf(resume ?? (await getRecent(recentIdFor(folder, f.name))));
  await openDtxFile(folder, f, undefined, resume?.text, side, { stale: () => seq !== switchSeq || get().folder !== folder });
}

/**
 * 新しい曲に置く音声ファイルを、NX（Shift_JIS）で読める名前にする（譜面に書く名前が「?」になって、NX が原曲・試聴を
 * 読めなくならないように）。同じ名前になったら番号を付ける
 */
function nxSafeFiles(files: File[]): File[] {
  const audio = (f: File) => AUDIO_EXT.test(f.name);
  // もう読める名前のファイルは、そのままの名前で先に取っておく
  const taken = new Set(files.filter((f) => !audio(f) || isNxSafeName(f.name)).map((f) => f.name.toLowerCase()));
  return files.map((f) => {
    if (!audio(f) || isNxSafeName(f.name)) return f;
    const safe = nxSafeName(f.name, 'bgm');
    const dot = safe.lastIndexOf('.');
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    let name = safe;
    for (let i = 2; taken.has(name.toLowerCase()) && i < 100; i++) name = `${base} (${i})${ext}`;
    taken.add(name.toLowerCase());
    return new File([f], name, { type: f.type, lastModified: f.lastModified });
  });
}

/** 落としたファイル（DTX・音声）から開く */
export async function openDroppedFiles(files: File[]) {
  if (files.length === 0) return;
  if (!(await confirmDiscard())) return;
  const dtx = files.find((f) => /\.dtx$/i.test(f.name));
  if (dtx) {
    const folder = folderFromFiles(files, dtx.name.replace(/\.dtx$/i, ''));
    await openDtxFile(folder, folder.files.get(dtx.name.toLowerCase())!);
    if (files.length === 1) toast(tr('DTXだけを開きました。音を鳴らすには曲フォルダごと開いてください', 'Opened only the DTX file. Open the whole song folder to hear the sounds'), 'info', 6000);
    return;
  }
  const audio = files.filter((f) => /\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(f.name));
  if (audio.length === 0) {
    toast(tr('DTXか音声ファイル（WAV・OGG・MP3）を選んでください', 'Choose a DTX or an audio file (WAV, OGG, MP3)'), 'warn');
    return;
  }
  // ステム分離ソフトで分けたファイル（drums・bass…）をまとめて落としたら、ステムとして読み込む
  const kinds = new Set(audio.map((f) => detectStemKind(f.name)));
  if (audio.length >= 2 && kinds.size >= 2) {
    const asStems = await chooseDialog({
      title: tr(`音声ファイルが ${audio.length} 個あります`, `${audio.length} audio files`),
      body: tr(
        'ステム（楽器ごとに分けた音）として読み込むと、楽器ごとに鳴らし分け、ドラム抜きのBGMを書き出せます。',
        'Loading them as stems (one file per instrument) lets you play instruments separately and export a no-drums BGM.',
      ),
      options: [
        { label: tr('ステムとして読み込む（おすすめ）', 'Load as stems (recommended)'), sub: audio.map((f) => f.name).join(tr('、', ', ')), value: true },
        { label: tr('1つを原曲にする', 'Use one as the original'), sub: tr('ほかのファイルは曲フォルダに置くだけにします', 'The other files are just put in the song folder'), value: false },
      ],
    });
    if (asStems === null || asStems === undefined) return;
    if (asStems) {
      const info = await newSongDialog({
        title: tr('新しい譜面をつくる（ステムから）', 'Create a new chart (from stems)'),
        audioFiles: [],
        defaults: { title: audio[0].name.replace(/\s*[([].*$/, '').replace(/\.[^.]+$/, '') },
      });
      if (!info) return;
      openDocument(createDoc(info), newMeta('mstr.dtx', null), folderFromFiles([], info.title || tr('新しい曲', 'New song')), { dirty: true });
      await importStems(audio);
      return;
    }
  }
  // 音声ファイルのタグ（曲名・アーティスト・BPM）があれば最初から入れておく
  const tags = await readAudioTags(audio[0]);
  // 曲フォルダには NX で読める名前で置く
  const named = nxSafeFiles(files);
  const pairs = files.map((f, i) => ({ from: f, to: named[i] })).filter((x) => audio.includes(x.from));
  const namedAudio = pairs.map((x) => x.to);
  const info = await newSongDialog({
    title: tr('新しい譜面をつくる', 'Create a new chart'),
    audioFiles: namedAudio.map((f) => f.name),
    defaults: {
      title: tags?.title || audio[0].name.replace(/\.[^.]+$/, ''),
      artist: tags?.artist || tags?.albumArtist || undefined,
      bpm: tags?.bpm ? Math.round(tags.bpm * 100) / 100 : undefined,
      bgmFile: namedAudio[0]?.name,
    },
  });
  if (!info) return;
  const folder = folderFromFiles(named, files[0].name.replace(/\.[^.]+$/, ''));
  openDocument(createDoc(info), newMeta('mstr.dtx', null), folder, { dirty: true });
  const renamed = pairs.filter((x) => x.to.name !== x.from.name).map((x) => `${x.from.name} → ${x.to.name}`);
  if (renamed.length)
    toast(
      tr(
        `NX（Shift_JIS）で読めない文字があったので、名前を変えて曲フォルダに置きました：${renamed.slice(0, 3).join('、')}`,
        `Renamed in the song folder because NX (Shift_JIS) can't read some characters: ${renamed.slice(0, 3).join(', ')}`,
      ),
      'info',
      8000,
    );
}

/** 原曲の音声ファイルを選ぶダイアログ（読み込むと原曲にする） */
export function pickBgmFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.ogg,.wav,.mp3,.m4a,.flac,.opus';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void importBgmFile(f);
  };
  input.click();
}

/** 同じ名前の別のファイルがあれば、名前の後ろに番号を付ける */
function freePath(folder: SongFolder, name: string): string {
  if (!findFile(folder, name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 100; i++) {
    const p = `${base} (${i})${ext}`;
    if (!findFile(folder, p)) return p;
  }
  return `${base}_${Date.now()}${ext}`;
}

/**
 * 今の譜面に原曲（BGM）を読み込む。曲フォルダにコピーして #WAV に登録し、
 * BGMチップ（ch01）が無ければ 001 小節の頭に置く。あれば、その音を差し替える。
 */
export async function importBgmFile(file: File) {
  if (!/\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(file.name)) {
    toast(tr('原曲は音声ファイル（WAV・OGG・MP3）を選んでください', 'For the original, choose an audio file (WAV, OGG, MP3)'), 'warn');
    return;
  }
  const s = get();
  let folder = s.folder;
  if (!folder) {
    folder = folderFromFiles([], s.doc.fields['TITLE'] || tr('新しい曲', 'New song'));
    useEditor.setState({ folder });
  }
  // NX（Shift_JIS）で読める名前で置く（同じファイルがもうあれば、それを使う）
  const safe = nxSafeName(file.name, 'bgm');
  const same = [findFile(folder, file.name), findFile(folder, safe)].find((f) => f && f.size === file.size);
  let path: string;
  let memory = false;
  if (same) {
    path = same.path;
  } else {
    path = freePath(folder, safe);
    memory = (await putFile(folder, path, file)) === 'memory';
  }
  const renamed = !same && safe !== file.name;
  const bgm = bgmSource(get().doc);
  // 試聴（#PREVIEW）は原曲についてくる・ドラム入りの原曲は完全な原曲として覚える（src/store/fullMix.ts）
  const swap = planBgmSwap(path);
  // 同じ原曲を使っていたほかの難易度も、この原曲にする（難易度で原曲が分かれないように。src/store/songBgm.ts）
  const { ok, entry, siblings } = editBgm(bgm ? tr('原曲を差し替える', 'Replace the original') : tr('原曲を読み込む', 'Load the original'), (d) => {
    if (swap.preview) setField(d, 'PREVIEW', swap.preview);
    if (bgm) {
      setField(d, 'WAV' + toBase36x2(bgm.wav), path);
      return;
    }
    const no = freeWavNumber(d) ?? 1;
    setField(d, 'WAV' + toBase36x2(no), path);
    if (d.fields['BGMWAV'] === undefined) setField(d, 'BGMWAV', toBase36x2(no));
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 1, f: frac(0), v: no });
  });
  if (ok) rememberFullMix(swap.fullMix);
  await prepareSounds();
  const rep = siblings ? await siblings.done : null;
  if (rep?.files.length) glowReflected({ diffs: rep.files });
  const notes = [
    renamed ? tr('NX（Shift_JIS）で読めない文字があったので、名前を変えて置きました', "Its name had characters NX (Shift_JIS) can't read, so it was saved under a new name") : '',
    ok && swap.preview ? tr('選曲画面の試聴（#PREVIEW）もこの原曲にしました', 'The song select preview (#PREVIEW) uses it too') : '',
  ]
    .filter(Boolean)
    .map((t) => (isJa() ? `。${t}` : `. ${t}`))
    .join('');
  toast(
    (isJa()
      ? `原曲「${path}」を${bgm ? '差し替えました' : '読み込みました（001小節の頭から鳴らします。ずれていたら「テンポ合わせ」で合わせられます）'}${memory ? '。曲フォルダへは保存するときに書き出します' : ''}`
      : `${bgm ? 'Replaced' : 'Loaded'} the original "${path}"${bgm ? '' : ' (it plays from the start of measure 001; if it is off, line it up in "Tempo")'}${memory ? '. It is written to the song folder when you save' : ''}`) +
      notes +
      siblingNote(rep),
    'ok',
    rep?.changed.length || rep?.kept.length || notes ? 10000 : 7000,
    ok ? { label: tr('元に戻す', 'Undo'), run: () => void undoIfLast(entry) } : undefined,
  );
}

/** 編集中に音声ファイルを落としたとき：原曲にするか、ステムにするか、新しい譜面にするかを選ぶ */
export async function dropAudioInEditor(files: File[]) {
  const audio = files.filter((f) => /\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(f.name));
  if (!audio.length) return openDroppedFiles(files);
  const choice = await chooseDialog({
    title: audio.length === 1 ? tr(`「${audio[0].name}」をどうしますか？`, `What do you want to do with "${audio[0].name}"?`) : tr(`音声ファイルが ${audio.length} 個あります`, `${audio.length} audio files`),
    body: tr('いま編集中の譜面に使うか、新しい譜面を作るかを選んでください。', 'Use it in the chart you are editing, or create a new chart.'),
    options: [
      ...(audio.length === 1
        ? [
            {
              label: bgmSource(get().doc) ? tr('原曲を差し替える', 'Replace the original') : tr('原曲にする（おすすめ）', 'Use as the original (recommended)'),
              sub: tr(
                '曲フォルダにコピーして、譜面の BGM（#WAV・ch01）に反映します。波形と原曲の打点はこの音から作ります',
                'Copies it into the song folder and sets it as the chart’s BGM (#WAV, ch01). The waveform and detected hits come from it',
              ),
              value: 'bgm' as const,
            },
          ]
        : []),
      {
        label: tr('ステムとして読み込む', 'Load as stems'),
        sub: tr('楽器ごとに分けた音（ドラム・ベースなど）。DAWのように鳴らし分けられます', 'One file per instrument (drums, bass…). Play them separately, like in a DAW'),
        value: 'stems' as const,
      },
      { label: tr('新しい譜面を作る', 'Create a new chart'), sub: tr('いまの譜面を閉じて、この音から新しい譜面を作ります', 'Closes the current chart and starts a new one from this audio'), value: 'new' as const },
    ],
  });
  if (choice === 'bgm') await importBgmFile(audio[0]);
  else if (choice === 'stems') await importStems(audio);
  else if (choice === 'new') await openDroppedFiles(files);
}

export async function newEmptySong() {
  if (!(await confirmDiscard())) return;
  const info = await newSongDialog({ title: tr('新しい譜面をつくる', 'Create a new chart'), audioFiles: [], defaults: {} });
  if (!info) return;
  openDocument(createDoc(info), newMeta('mstr.dtx', null), null, { dirty: true });
}

// ---- 保存 ---------------------------------------------------------------------

/** 曲フォルダにまだ無い、エディタが用意した音（標準キット・ライブラリ）。出典も返す */
async function kitFilesNeeded(doc: DtxDoc, folder: SongFolder | null): Promise<{ path: string; bytes: Uint8Array; origin: string; library: boolean }[]> {
  const out: { path: string; bytes: Uint8Array; origin: string; library: boolean }[] = [];
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const names = new Set<string>();
  const used = new Set(doc.chips.map((c) => c.v));
  for (const [k, v] of Object.entries(doc.fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k)) continue;
    if (!used.has(parseInt(k.slice(3), 36))) continue;
    if (names.has(v.toLowerCase()) || findFile(folder, v, pathWav)) continue;
    const vs = virtualSound(v);
    if (!vs) continue;
    names.add(v.toLowerCase());
    const bytes = await vs.bytes();
    if (!bytes) continue;
    const name = v.replace(/\\/g, '/').split('/').pop()!;
    out.push({ path: pathWav ? `${pathWav.replace(/\\/g, '/').replace(/\/+$/, '')}/${name}` : name, bytes, origin: vs.origin, library: !!vs.sampleId });
  }
  return out;
}

/** 他の曲から取り込んだ音を使っているときは、出典を知らせる */
function creditNote(kit: { path: string; origin: string; library: boolean }[]): string {
  const lib = kit.filter((k) => k.library);
  if (!lib.length) return '';
  const songs = [...new Set(lib.map((k) => k.origin))];
  return isJa()
    ? `。他の曲から取り込んだ音を使っています（出典: ${songs.slice(0, 3).join('、')}${songs.length > 3 ? ' ほか' : ''}）。個人の曲づくりの範囲で使ってください`
    : `. It uses sounds taken from other songs (from: ${songs.slice(0, 3).join(', ')}${songs.length > 3 ? ' and more' : ''}). Keep it to personal charting`;
}

/** 保存する DTX。曲の終わりを決めていなければ、いま見えている終わり（原曲の鳴り終わり）を書き込む */
function encodeForSave(doc: DtxDoc) {
  return encodeDtx(serializeDtx(withSongEnd(doc)), 'shift_jis');
}

/** 作業ファイルの中身（空で、フォルダにも無ければ書かない） */
function sidecarBytes(folder: SongFolder | null, fileName: string): Uint8Array | null {
  const d = sidecarData();
  if (sidecarIsEmpty(d) && !(folder && findFile(folder, sidecarName(fileName)))) return null;
  return new TextEncoder().encode(serializeSidecar(d));
}

function markSaved(doc: DtxDoc, patch: Partial<EditorState> = {}) {
  const oldId = get().meta.recentId;
  useEditor.setState((s) => ({ ...patch, savedDoc: doc, savedHistory: s.past.length, savedAt: Date.now(), meta: { ...s.meta, ...(patch.meta ?? {}), encoding: 'shift_jis', encodingNote: undefined } }));
  const newId = get().meta.recentId;
  // 保存先が決まって自動保存の名前が変わったら、前の名前の控えは消す（同じ曲が2つ並ばないように）
  if (oldId && newId && oldId !== newId) void deleteRecent(oldId).then(() => autosaveNow(true));
  else void autosaveNow(true);
}

type KitFile = { path: string; bytes: Uint8Array; origin: string; library: boolean };

/** 本体の曲フォルダにする（メモリの曲フォルダは本体に入れ、曲フォルダが無ければ作る）。できなければ null */
async function ensureLocalFolder(folder: SongFolder | null): Promise<SongFolder | null> {
  if (folder?.local) return folder;
  if (folder?.dir || !(await checkLocal())) return null;
  let f = folder;
  if (!f) {
    f = folderFromFiles([], get().doc.fields['TITLE'] || tr('新しい曲', 'New song'));
    useEditor.setState({ folder: f });
  }
  return (await promoteToLocal(f)) ? f : null;
}

/** 難易度タブの一覧を作り直す（AI の印は分かっている物を引き継ぎ、新しい譜面があれば読み直す） */
async function refreshSiblings(folder: SongFolder) {
  const labels = await readSetDefLabels(folder);
  const known = new Map(get().meta.siblings.map((x) => [x.file.toLowerCase(), x.origin]));
  const siblings = siblingsOf(folder, labels).map((x) => ({ ...x, origin: known.get(x.file.toLowerCase()) }));
  return { siblings, fresh: siblings.some((x) => !known.has(x.file.toLowerCase())) };
}

/** 本体の曲フォルダに保存する（キットの音・まだ書けていない音・譜面・作業ファイル） */
async function saveIntoLocal(folder: SongFolder, fileName: string, bytes: Uint8Array, kit: KitFile[], doc: DtxDoc, quiet = false): Promise<boolean> {
  const local = folder.local!;
  if (findFile(folder, fileName) && fileName.toLowerCase() !== get().meta.fileName.toLowerCase()) {
    const ok = await confirmDialog({
      title: tr(`${fileName} を上書きしますか？`, `Overwrite ${fileName}?`),
      body: tr('同じ名前の譜面が曲フォルダにあります。', 'A chart with the same name is already in the song folder.'),
      ok: tr('上書き', 'Overwrite'),
      danger: true,
    });
    if (!ok) return false;
  }
  for (const k of kit) await writeFile(folder, k.path, k.bytes);
  for (const f of pendingFiles(folder)) await writeFile(folder, f.path, await f.getFile());
  await writeFile(folder, fileName, bytes);
  const side = sidecarBytes(folder, fileName);
  if (side) await writeFile(folder, sidecarName(fileName), side);
  markSidecarSaved();
  const { siblings, fresh } = await refreshSiblings(folder);
  markSaved(doc, { meta: { ...get().meta, fileName, siblings, recentId: recentIdFor(folder, fileName) } });
  if (fresh) void scanSiblingOrigins(folder);
  await finishLocalSong(local, folder);
  useLocalSongs.setState({ savedAt: Date.now() });
  void refreshLocalSongs();
  if (!quiet) {
    const tablet = useDevice.getState().tablet;
    const action = tablet
      ? { label: tr('書き出す…', 'Export…'), run: () => void import('../ui/tablet/shared').then((m) => m.openSaveSheet()) }
      : supportsDirectWrite()
        ? { label: tr('曲フォルダへ…', 'To a folder…'), run: () => void save({ toFolder: true }) }
        : { label: tr('ZIP で保存', 'Save as ZIP'), run: () => void exportSongZip() };
    const kitNote = kit.length ? tr(`（キットの音 ${kit.length} 個も保存）`, ` (also saved ${kit.length} kit ${pl(kit.length, 'sound')})`) : '';
    toast(tr(`${localPlace()}に保存しました: `, `Saved in ${localPlace()}: `) + `${folder.name}/${fileName}${kitNote}${creditNote(kit)}`, 'ok', kit.some((k) => k.library) ? 9000 : 5000, action);
  }
  return true;
}

/**
 * 本体の曲を曲フォルダ（PC で選んだフォルダ）へ移したあと：自動保存の控えをそのフォルダに付け替え、本体のファイルを消す
 */
async function moveLocalToFolder(localId: string, target: SongFolder) {
  for (const e of await listRecent()) {
    if (e.local !== localId) continue;
    await deleteRecent(e.id);
    await putRecent({ ...e, id: recentIdFor(target, e.fileName), local: undefined, dir: target.dir, folderName: target.name });
  }
  await deleteLocalSong(localId);
  bumpLocal();
  void refreshLocalSongs();
}

// ---- 曲フォルダを移す（ほかの曲も入ったフォルダから・保存先を変える） ------------------------------------

/** 曲を集めたフォルダ（DTXFiles など）で曲を開いたとき、1回だけ知らせる（保存のときに、この曲だけのフォルダへ移す） */
const warnedLibrary = new WeakSet<SongFolder>();
/** その知らせ（移したら閉じる） */
let libraryToast = 0;
function warnLibraryFolder(folder: SongFolder) {
  if (!isDiskFolder(folder) || warnedLibrary.has(folder)) return;
  const others = otherSongsIn(folder);
  if (!others.length) return;
  warnedLibrary.add(folder);
  libraryToast = toast(
    tr(
      `「${folder.name}」はほかの曲（${fewText(others.map((d) => dirLabel(folder, d)))}）も入ったフォルダです。ここには直接保存せず、保存するときにこの曲だけのフォルダを作って移します`,
      `"${folder.name}" also holds other songs (${fewText(others.map((d) => dirLabel(folder, d)))}). Nothing is saved straight into it; when you save, a folder just for this song is made and the song moves there`,
    ),
    'warn',
    12000,
    { label: tr('今すぐ移す…', 'Move now…'), run: () => void moveToOwnSongFolder().then((f) => f && save()) },
  );
}

/** 譜面が使うファイル（曲フォルダの中のパス。正規化）。直下の譜面と、開いている譜面・ステムから */
async function songRefs(folder: SongFolder): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const f of dtxFiles(folder)) {
    try {
      const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
      for (const r of chartRefs(text)) refs.add(r);
    } catch {
      // 読めない譜面は見ない
    }
  }
  for (const r of chartRefs(serializeDtx(get().doc))) refs.add(r);
  for (const t of sidecarData().stems) refs.add(normPath(t.file));
  return refs;
}

/**
 * ほかの曲も入ったフォルダ（DTXFiles など）の中の、この曲の分：直下のファイル・stems/・譜面が使うサブフォルダのファイル・まだ書けていないファイル。
 * 中を全部は読まない（開いたときの読み込みは数に上限があり、直下のファイルまで届いていないことがあるので、ここで直下を読み直す）
 */
async function libraryView(from: SongFolder & { dir: FileSystemDirectoryHandle }): Promise<SongFolder> {
  const files = new Map<string, FolderFile>();
  let stems: FileSystemDirectoryHandle | null = null;
  for await (const [name, h] of from.dir.entries()) {
    if (h.kind === 'file') {
      const fh = h as FileSystemFileHandle;
      const size = (await fh.getFile().catch(() => null))?.size ?? 0;
      files.set(normPath(name), { path: name, name, size, getFile: () => fh.getFile() });
    } else if (name.toLowerCase() === 'stems') stems = h as FileSystemDirectoryHandle;
  }
  if (stems) {
    for (const f of (await folderFromHandle(stems)).files.values()) {
      const path = `${stems.name}/${f.path}`;
      files.set(normPath(path), { ...f, path });
    }
  }
  const view: SongFolder = { name: from.name, dir: from.dir, files };
  for (const ref of await songRefs(view)) {
    if (!ref.includes('/') || files.has(ref)) continue;
    const f = from.files.get(ref) ?? (await fileAt(from.dir, ref));
    if (f) files.set(ref, f);
  }
  for (const f of pendingFiles(from)) files.set(normPath(f.path), f);
  return view;
}

/** フォルダの中のファイル（パスは正規化した形。大文字・小文字は見ない）。無ければ undefined */
async function fileAt(dir: FileSystemDirectoryHandle, key: string): Promise<FolderFile | undefined> {
  const parts = key.split('/');
  const names: string[] = [];
  let d = dir;
  for (const [i, part] of parts.entries()) {
    let found: FileSystemHandle | null = null;
    for await (const [name, h] of d.entries()) {
      if (name.toLowerCase() !== part) continue;
      found = h;
      names.push(name);
      break;
    }
    if (!found) return undefined;
    if (i < parts.length - 1) {
      if (found.kind !== 'directory') return undefined;
      d = found as FileSystemDirectoryHandle;
    } else {
      if (found.kind !== 'file') return undefined;
      const fh = found as FileSystemFileHandle;
      const file = await fh.getFile();
      return { path: names.join('/'), name: file.name, size: file.size, getFile: () => fh.getFile() };
    }
  }
  return undefined;
}

/** フォルダの中のファイルを消す（無ければそのまま） */
async function removeAt(dir: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.pop()!;
  let d = dir;
  try {
    for (const p of parts) d = await d.getDirectoryHandle(p);
    await d.removeEntry(name);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
  }
}

/**
 * 開いている曲を、別の曲フォルダへ移す：この曲のファイルを写し、開いている曲・最近の曲・Google Drive とのつなぎを新しいフォルダに付け替える。
 * 元のフォルダのファイルは消さない（ほかの曲も入ったフォルダからなら、写したファイルを消すか聞く）。移したら新しいフォルダ
 */
async function relocate(from: SongFolder & { dir: FileSystemDirectoryHandle }, place: SongPlace, library: boolean): Promise<SongFolder | null> {
  if (await place.dir.isSameEntry(from.dir)) {
    toast(tr('いまと同じフォルダです', "That's the folder the song is already in"), 'info', 5000);
    return null;
  }
  // 曲フォルダの中へは移さない（ほかの曲も入ったフォルダからは、その中に作るのが正しい）
  if (!library && (await from.dir.resolve(place.dir).catch(() => null))) {
    toast(tr(`いまの曲フォルダ「${from.name}」の中には移せません`, `Can't move it inside its current folder "${from.name}"`), 'warn', 6000);
    return null;
  }
  const view = library ? await libraryView(from) : from;
  const refs = await songRefs(view);
  const files = songFilesOf(view, refs, library ? 'library' : 'song');
  const target: SongFolder = place.created ? { name: place.dir.name, dir: place.dir, files: new Map() } : await folderFromHandle(place.dir);
  try {
    for (const [i, f] of files.entries()) {
      if (i % 4 === 0 && files.length > 8) useEditor.setState({ loading: tr(`曲のファイルを写しています… ${i}/${files.length}`, `Copying the song files… ${i}/${files.length}`) });
      await writeFile(target, f.path, await f.getFile());
    }
  } catch (e) {
    toast(tr(`曲のファイルを写せませんでした: ${(e as Error).message}`, `Couldn't copy the song files: ${(e as Error).message}`), 'error', 8000);
    return null;
  } finally {
    useEditor.setState({ loading: null });
  }
  // Google Drive とのつなぎは新しいフォルダへ（元のフォルダに残すと、2つのフォルダが同じ Drive の曲を書き換えあう）
  if (findFile(view, LINK_FILE)) {
    await removeAt(from.dir, LINK_FILE).catch(() => undefined);
    from.files.delete(LINK_FILE);
  }
  const s = get();
  const labels = await readSetDefLabels(target);
  const known = new Map(s.meta.siblings.map((x) => [x.file.toLowerCase(), x.origin]));
  useEditor.setState({
    folder: target,
    meta: { ...s.meta, siblings: siblingsOf(target, labels).map((x) => ({ ...x, origin: known.get(x.file.toLowerCase()) })), recentId: recentIdFor(target, s.meta.fileName) },
  });
  await moveRecentToFolder(from, target);
  if (libraryToast) dismissToast(libraryToast);
  libraryToast = 0;
  const where = `${place.parent ? `${place.parent}/` : ''}${target.name}`;
  if (library) await offerLeftoverCleanup(from, view, target, refs, where);
  else toast(tr(`「${where}」に移しました（元のフォルダ「${from.name}」のファイルはそのまま残しています）`, `Moved to "${where}" (the files in the old folder "${from.name}" are left as they are)`), 'ok', 7000);
  return target;
}

/** 最近の曲の控えのうち、元のフォルダの物を新しいフォルダに付け替える */
async function moveRecentToFolder(from: SongFolder & { dir: FileSystemDirectoryHandle }, target: SongFolder) {
  for (const e of await listRecent()) {
    if (e.local || e.folderName.toLowerCase() !== from.name.toLowerCase()) continue;
    if (e.dir && !(await e.dir.isSameEntry(from.dir).catch(() => false))) continue;
    await deleteRecent(e.id);
    await putRecent({ ...e, id: recentIdFor(target, e.fileName), dir: target.dir, folderName: target.name, updatedAt: Math.max(e.updatedAt, Date.now() - 1) });
  }
}

/** ほかの曲も入ったフォルダから移したあと：そこに残った、この曲のファイルを消すか聞く（NX に同じ曲が2つ出ないように） */
async function offerLeftoverCleanup(from: SongFolder & { dir: FileSystemDirectoryHandle }, view: SongFolder, target: SongFolder, refs: Set<string>, where: string) {
  // 直下と stems/ の、写せた（同じ大きさで新しいフォルダにある）物だけ。ほかの曲のフォルダの中には触らない
  const left = songFilesOf(view, refs, 'strict').filter((f) => !f.pending && f.path.toLowerCase() !== LINK_FILE && findFile(target, f.path)?.size === f.size);
  if (!left.length) {
    toast(tr(`「${where}」に移しました`, `Moved to "${where}"`), 'ok', 6000);
    return;
  }
  const c = await chooseDialog<'remove' | 'keep'>({
    title: tr(`「${where}」に移しました`, `Moved to "${where}"`),
    body: tr(
      `元の「${from.name}」の直下に、この曲のファイルが ${left.length} 個残っています（${fewText(left.map((f) => f.path), 4)}）。残すと、NX に同じ曲が2つ出ます。`,
      `${left.length} of this song's files are still directly in "${from.name}" (${fewText(left.map((f) => f.path), 4)}). If you keep them, NX shows the song twice.`,
    ),
    options: [
      { label: tr(`「${from.name}」から消す（おすすめ）`, `Remove them from "${from.name}" (recommended)`), sub: tr(`新しいフォルダに写した ${left.length} 個だけを消します。ほかの曲のファイルには触りません`, `Removes only the ${left.length} files copied to the new folder. Other songs' files are not touched`), value: 'remove' },
      { label: tr('残す', 'Keep them'), sub: tr('あとで自分で片付けます', "I'll tidy them up myself"), value: 'keep' },
    ],
  });
  if (c !== 'remove') return;
  let removed = 0;
  for (const f of left) {
    try {
      await removeAt(from.dir, f.path);
      removed++;
    } catch {
      // 消せなかった物は残す
    }
  }
  // 空になった stems フォルダも消す
  await from.dir.removeEntry('stems').catch(() => undefined);
  toast(tr(`「${from.name}」から、この曲のファイルを ${removed} 個消しました`, `Removed ${removed} of this song's ${pl(removed, 'file')} from "${from.name}"`), 'ok', 6000);
}

/**
 * ほかの曲も入ったフォルダ（DTXFiles など）で開いている曲を、この曲だけのフォルダに移す。操作の中で呼ぶ。
 * 移した・もともと曲フォルダならそのフォルダ、やめたら null
 */
export async function moveToOwnSongFolder(): Promise<SongFolder | null> {
  const s = get();
  const folder = s.folder;
  if (!isDiskFolder(folder)) return null;
  const others = otherSongsIn(folder);
  if (!others.length) return folder;
  const name = songFolderName({ title: s.doc.fields['TITLE'], library: true });
  const c = await chooseDialog<'inside' | 'pick'>({
    title: tr(`「${folder.name}」はほかの曲も入ったフォルダです`, `"${folder.name}" also holds other songs`),
    body: tr(
      `曲のフォルダ（${fewText(others.map((d) => dirLabel(folder, d)))}）が入っているので、ここには直接保存しません（NX でほかの曲と混ざり、Google Drive にもほかの曲まで送ってしまうため）。この曲だけのフォルダを作り、この曲のファイルを写してから保存します。`,
      `It has song folders in it (${fewText(others.map((d) => dirLabel(folder, d)))}), so nothing is saved straight into it (it would mix with other songs in NX and send other songs to Google Drive too). A folder just for this song is made, the song's files are copied there, and then it is saved.`,
    ),
    options: [
      {
        label: tr(`「${folder.name}」の中に「${name}」フォルダを作る（おすすめ）`, `Make a "${name}" folder in "${folder.name}" (recommended)`),
        sub: tr('NX の DTXFiles なら、そのまま NX で遊べます', 'If this is DTXFiles in NX, you can play it in NX right away'),
        value: 'inside',
      },
      { label: tr('別の場所を選ぶ…', 'Choose another place…'), sub: tr(`選んだフォルダの中に「${name}」フォルダを作ります`, `A "${name}" folder is made in the folder you choose`), value: 'pick' },
    ],
  });
  if (!c) return null;
  try {
    if (!(await ensureWritable(folder))) {
      toast(tr('フォルダへの書き込みが許可されませんでした', 'Writing to the folder was not allowed'), 'error');
      return null;
    }
    const place = c === 'inside' ? await makeSongDir(folder.dir, name) : await pickSongPlace(name);
    if (!place) return null;
    return await relocate(folder, place, true);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    toast(tr(`この曲のフォルダを作れませんでした: ${(e as Error).message}`, `Couldn't make the song folder: ${(e as Error).message}`), 'error', 8000);
    return null;
  }
}

/** 保存先のフォルダを変える（PC の曲フォルダ）。この曲のファイルを新しい曲フォルダに写し、次からそこに保存する。操作の中で呼ぶ */
export async function changeSongFolder() {
  const s = get();
  const folder = s.folder;
  if (!isDiskFolder(folder) || !supportsDirectWrite()) return;
  if (otherSongsIn(folder).length) {
    if (await moveToOwnSongFolder()) await save();
    return;
  }
  const name = songFolderName({ folder: folder.name, title: s.doc.fields['TITLE'] });
  const count = songFilesOf(folder, new Set()).length;
  const ok = await confirmDialog({
    title: tr('保存先のフォルダを変えます', 'Change the save folder'),
    body: tr(
      `移す先（NX の DTXFiles など）を選ぶと、その中に「${name}」フォルダを作り、この曲のファイル（譜面・原曲・ステムなど ${count} 個）を写して、次からはそこに保存します。いまのフォルダ「${folder.name}」のファイルは消さずに残します。Google Drive とのつなぎは新しいフォルダに移します。`,
      `Choose where to move it (such as DTXFiles in NX). A "${name}" folder is made inside it, this song's ${count} ${pl(count, 'file')} (charts, original audio, stems…) are copied there, and later saves go there. The files in the current folder "${folder.name}" are kept. The Google Drive link moves to the new folder.`,
    ),
    ok: tr('移す先を選ぶ', 'Choose where to move'),
  });
  if (!ok) return;
  try {
    const place = await pickSongPlace(name);
    if (!place) return;
    if (await relocate(folder, place, false)) await save();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    toast(tr(`保存先を変えられませんでした: ${(e as Error).message}`, `Couldn't change the save folder: ${(e as Error).message}`), 'error', 8000);
  }
}

/** 保存を始めるとき（操作の中、最初の await の前）に呼ぶ。Drive のログインの小窓を開くため（src/app/driveActions.ts） */
let beforeSave: ((opts: { toFolder?: boolean }) => void) | null = null;
export function setBeforeSave(fn: ((opts: { toFolder?: boolean }) => void) | null) {
  beforeSave = fn;
}

export async function save(opts: { as?: boolean; toFolder?: boolean } = {}) {
  if (get().screen !== 'editor') return;
  beforeSave?.(opts);
  // ほかの曲も入ったフォルダ（DTXFiles など）には直接書かない：この曲だけのフォルダを作って移してから保存する
  // （ファイル名を NX で読める名前に変えるのも、移した先で）
  const from = get().folder;
  if (isDiskFolder(from) && otherSongsIn(from).length && !(await moveToOwnSongFolder())) return;
  // 試聴（#PREVIEW）が空なら原曲を入れ、譜面に書くファイル名を NX で読める名前にしてから
  // （Shift_JIS で「?」になって、試聴・原曲を NX が読めなくならないように）
  await prepareForNx();
  const s = get();
  if (s.screen !== 'editor') return;
  const doc = s.doc;
  const { bytes, lost } = encodeForSave(doc);
  if (lost.length > 0) {
    const ok = await confirmDialog({
      title: tr('Shift_JISで表せない文字があります', "Some characters can't be written in Shift_JIS"),
      body: tr(
        `${lost.join(' ')}\n\nNXは譜面をShift_JISで読むため、これらの文字は「?」になります。曲情報で別の文字に置き換えるのがおすすめです。このまま保存しますか？`,
        `${lost.join(' ')}\n\nNX reads charts as Shift_JIS, so these characters become "?". It is best to replace them in Song info. Save anyway?`,
      ),
      ok: tr('このまま保存', 'Save anyway'),
    });
    if (!ok) return;
  }
  let fileName = s.meta.fileName;
  if (opts.as) {
    const name = await promptDialog({ title: tr('名前を付けて保存', 'Save as'), body: tr('同じ曲フォルダに保存します。', 'Saves into the same song folder.'), value: fileName, ok: tr('保存', 'Save') });
    if (!name) return;
    // set.def（Shift_JIS）に書いても NX が読める名前にする
    fileName = nxSafeName(/\.dtx$/i.test(name.trim()) ? name.trim() : `${name.trim()}.dtx`, 'chart');
  }
  let folder = s.folder;
  // 本体に入れている途中なら、入れ終わってから保存する
  if (folder && !folder.dir) await promotions.get(folder);
  const kit = await kitFilesNeeded(doc, folder);
  try {
    // ほかの曲も入ったフォルダ（DTXFiles など）からは、最初にこの曲だけのフォルダへ移している
    if (isDiskFolder(folder) && otherSongsIn(folder).length) return;
    if (isDiskFolder(folder)) {
      if (!(await ensureWritable(folder))) {
        toast(tr('フォルダへの書き込みが許可されませんでした', 'Writing to the folder was not allowed'), 'error');
        return;
      }
      if (findFile(folder, fileName) && fileName !== s.meta.fileName) {
        const ok = await confirmDialog({
          title: tr(`${fileName} を上書きしますか？`, `Overwrite ${fileName}?`),
          body: tr('同じ名前の譜面がフォルダにあります。', 'A chart with the same name is already in the folder.'),
          ok: tr('上書き', 'Overwrite'),
          danger: true,
        });
        if (!ok) return;
      }
      for (const k of kit) await writeFile(folder, k.path, k.bytes);
      // ステムや書き出した音で、まだフォルダに書けていなかったもの
      for (const f of pendingFiles(folder)) await writeFile(folder, f.path, await f.getFile());
      await writeFile(folder, fileName, bytes);
      const side = sidecarBytes(folder, fileName);
      if (side) await writeFile(folder, sidecarName(fileName), side);
      markSidecarSaved();
      markSaved(doc, { meta: { ...get().meta, fileName, recentId: recentIdFor(folder, fileName) } });
      const kitNote = kit.length ? tr(`（キットの音 ${kit.length} 個も保存）`, ` (also saved ${kit.length} kit ${pl(kit.length, 'sound')})`) : '';
      toast(`${tr('保存しました: ', 'Saved: ')}${folder.name}/${fileName}${kitNote}${creditNote(kit)}`, 'ok', kit.some((k) => k.library) ? 9000 : 4000);
      return;
    }
    if (supportsDirectWrite()) {
      // PC（フォルダに直接保存できるブラウザ）。まだ曲フォルダが無い・本体に置いた曲は、保存する場所を選んでもらい、
      // その中に曲のフォルダを作って保存する（選んだフォルダの直下には広げない。src/app/songPlace.ts）。
      // 本体に置いたまま保存することもできる（選んだら、その曲は次から聞かずに本体へ）
      const songName = songFolderName({ folder: folder?.name, title: doc.fields['TITLE'] });
      const makeNote = tr(
        `保存する場所（NX の DTXFiles など）を選ぶと、その中に「${songName}」フォルダを作って、譜面・原曲・ステム・キットの音をまとめて書きます。次からはそのフォルダに上書きします`,
        `Choose where to save it (such as DTXFiles in NX). A "${songName}" folder is made inside it and the chart, original audio, stems and kit sounds are written there together. Later saves overwrite that folder`,
      );
      let where: 'folder' | 'local' = 'folder';
      if (!opts.toFolder) {
        const keep = folder?.local ? (await getLocalSong(folder.local))?.keepInBrowser : false;
        if (keep) where = 'local';
        else if (await checkLocal()) {
          const c = await chooseDialog<'folder' | 'local'>({
            title: tr('どこに保存しますか？', 'Where do you want to save?'),
            body: tr('NX で遊ぶには、NX の曲フォルダ（DTXFiles の中）に保存します。', 'To play it in NX, save it as a song folder inside DTXFiles in NX.'),
            options: [
              { label: tr('曲のフォルダを作って保存（おすすめ）', 'Make a song folder and save (recommended)'), sub: makeNote, value: 'folder' },
              {
                label: tr('このブラウザの中に保存', 'Save inside this browser'),
                sub: tr(
                  '音も一緒にブラウザの中に残し、リロードしても続きを開けます。NX の曲フォルダへは、あとで「ファイル › 曲フォルダに書き出す」で移せます',
                  'Keeps the audio too, so you can continue after a reload. Move it to an NX song folder later with File › Export to a song folder',
                ),
                value: 'local',
              },
            ],
          });
          if (!c) return;
          where = c;
        } else {
          const ok = await confirmDialog({
            title: tr('曲のフォルダを作って保存します', 'Make a song folder and save'),
            body: `${makeNote}${tr('。', '.')}`,
            ok: tr('保存する場所を選ぶ', 'Choose where to save'),
          });
          if (!ok) return;
        }
      } else {
        const ok = await confirmDialog({
          title: tr('曲フォルダに書き出します', 'Export to a song folder'),
          body: `${makeNote}${tr('。このブラウザの中の曲は、そのフォルダへ移します。', '. The song kept in this browser moves to that folder.')}`,
          ok: tr('書き出す場所を選ぶ', 'Choose where to export'),
        });
        if (!ok) return;
      }
      if (where === 'local') {
        const lf = await ensureLocalFolder(folder);
        if (lf?.local) {
          await updateLocalSong(lf.local, { keepInBrowser: true });
          await saveIntoLocal(lf, fileName, bytes, kit, doc);
          return;
        }
        toast(tr(`${localPlace()}に保存できないので、曲フォルダを選んでください`, `Can't save in ${localPlace()}, so choose a song folder`), 'warn', 6000);
      }
      const place = await pickSongPlace(songName);
      if (!place) return;
      const target: SongFolder = place.created ? { name: place.dir.name, dir: place.dir, files: new Map() } : await folderFromHandle(place.dir);
      if (findFile(target, fileName)) {
        const over = await confirmDialog({
          title: tr(`${fileName} を上書きしますか？`, `Overwrite ${fileName}?`),
          body: tr(`「${target.name}」に同じ名前の譜面があります。`, `"${target.name}" already has a chart with the same name.`),
          ok: tr('上書き', 'Overwrite'),
          danger: true,
        });
        if (!over) return;
      }
      if (folder) {
        for (const f of folder.files.values()) {
          if (findFile(target, f.path)) continue;
          await writeFile(target, f.path, await f.getFile());
        }
      }
      for (const k of kit) await writeFile(target, k.path, k.bytes);
      await writeFile(target, fileName, bytes);
      const side = sidecarBytes(null, fileName);
      if (side) await writeFile(target, sidecarName(fileName), side);
      markSidecarSaved();
      const moved = folder?.local;
      folder = target;
      const labels = await readSetDefLabels(folder);
      markSaved(doc, { folder, meta: { ...get().meta, fileName, siblings: siblingsOf(folder, labels), recentId: recentIdFor(folder, fileName) } });
      void scanSiblingOrigins(folder);
      // 本体に置いていた曲は、曲フォルダへ移ったので本体からは消す（自動保存の控えはフォルダに付け替える）
      if (moved) await moveLocalToFolder(moved, folder);
      const made = place.created ? tr(`（「${place.parent}」の中に「${folder.name}」フォルダを作りました）`, ` (made a "${folder.name}" folder in "${place.parent}")`) : '';
      toast(`${tr('保存しました: ', 'Saved: ')}${place.parent ? `${place.parent}/` : ''}${folder.name}/${fileName}${made}${creditNote(kit)}`, 'ok', kit.some((k) => k.library) ? 9000 : 6000);
      return;
    }
    // フォルダに直接書けないブラウザ（iPad・Safari・Firefox）：本体（このブラウザの保存領域）に保存する
    const lf = await ensureLocalFolder(folder);
    if (lf?.local) {
      await saveIntoLocal(lf, fileName, bytes, kit, doc);
      return;
    }
    // 本体も使えない（プライベートブラウズなど）：ダウンロード
    const side = sidecarBytes(null, fileName);
    downloadSong(fileName, bytes, kit, folder, side);
    if (side && useSidecar.getState().dirty && pendingFiles(folder).length === 0 && kit.length === 0) downloadBytes(sidecarName(fileName), side, 'application/json');
    markSidecarSaved();
    markSaved(doc, { meta: { ...get().meta, fileName } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    toast(
      isQuotaError(e) && folder?.local
        ? tr(`${localPlace()}の空きが足りず保存できませんでした。ほかの曲を消して空けるか、書き出してください`, `Not enough space in ${localPlace()} to save. Remove other songs to free space, or export the song`)
        : tr(`保存できませんでした: ${(e as Error).message}`, `Couldn't save: ${(e as Error).message}`),
      'error',
      8000,
    );
  }
}

/** 本体の曲を、確かめずに本体へ保存する（書き出したとき。Shift_JIS で） */
async function saveLocalQuiet(): Promise<boolean> {
  const s = get();
  const folder = s.folder;
  if (!isLocalFolder(folder) || s.screen !== 'editor') return false;
  try {
    const { bytes } = encodeForSave(s.doc);
    return await saveIntoLocal(folder, s.meta.fileName, bytes, await kitFilesNeeded(s.doc, folder), s.doc, true);
  } catch {
    return false;
  }
}

/** 曲フォルダを ZIP でダウンロード（PC で本体に置いた曲を NX へ渡すとき） */
export async function exportSongZip() {
  const r = await buildExport('folder');
  if (r) await deliverExport(r.file, 'download');
}

function downloadSong(fileName: string, bytes: Uint8Array, kit: { path: string; bytes: Uint8Array; origin: string; library: boolean }[], folder: SongFolder | null, side: Uint8Array | null = null) {
  const memoryOnly = folder && !folder.dir && !findFile(folder, fileName) ? [...folder.files.values()].filter((f) => !/\.dtx$/i.test(f.name)) : [];
  // ステムや書き出した音（メモリにだけあるもの）も一緒に入れる
  for (const f of pendingFiles(folder)) if (!memoryOnly.includes(f)) memoryOnly.push(f);
  if (kit.length === 0 && memoryOnly.length === 0) {
    downloadBytes(fileName, bytes);
    toast(tr(`${fileName} をダウンロードしました。曲フォルダの同じ名前のファイルと置き換えてください`, `Downloaded ${fileName}. Replace the file with the same name in the song folder`), 'ok', 7000);
    return;
  }
  void (async () => {
    const files: Record<string, Uint8Array> = {};
    for (const f of memoryOnly) files[f.path] = new Uint8Array(await (await f.getFile()).arrayBuffer());
    for (const k of kit) files[k.path] = k.bytes;
    files[fileName] = bytes;
    if (side) files[sidecarName(fileName)] = side;
    const zip = zipSync(files, { level: 0 });
    const name = `${(get().doc.fields['TITLE'] || 'song').replace(/[\\/:*?"<>|]/g, '_')}.zip`;
    downloadBytes(name, zip, 'application/zip');
    toast(tr(`${name} をダウンロードしました。展開したファイルを曲フォルダに入れてください`, `Downloaded ${name}. Unzip it and put the files in the song folder`) + creditNote(kit), 'ok', kit.some((k) => k.library) ? 10000 : 7000);
  })();
}

/** 譜面ファイルだけをダウンロード（どのブラウザでも使える控え） */
export async function downloadDtx() {
  await prepareForNx({ dtxOnly: true });
  const s = get();
  const { bytes } = encodeForSave(s.doc);
  downloadBytes(s.meta.fileName, bytes);
}

// ---- 自動保存 -------------------------------------------------------------------

let autosaveTimer = 0;
let lastAutosaved: DtxDoc | null = null;

/** 最後にこのブラウザへ自動保存した時刻（タブレットの「保存と書き出し」に出す） */
export let lastAutosaveAt = 0;

/** 自動保存の控え（最近の曲）。PC の曲フォルダは handle、本体の曲は id を持つ */
function autosaveEntry(s: EditorState): RecentEntry {
  const f = s.doc.fields;
  return {
    id: s.meta.recentId ?? recentIdFor(s.folder, s.meta.fileName),
    title: f['TITLE'] ?? tr('無題', 'Untitled'),
    artist: f['ARTIST'] ?? '',
    bpm: f['BPM'] ?? '',
    level: f['DLEVEL'] ?? '',
    fileName: s.meta.fileName,
    folderName: s.folder?.name ?? '',
    dir: isDiskFolder(s.folder) ? s.folder.dir : undefined,
    local: s.folder?.local,
    drive: s.folder?.drive,
    text: serializeDtx(withSongEnd(s.doc)),
    sidecar: sidecarIsEmpty() ? undefined : serializeSidecar(sidecarData()),
    saved: !isDirty(s),
    sidecarSaved: !useSidecar.getState().dirty,
    updatedAt: Date.now(),
  };
}

/** いまの譜面の控え（Drive の自動保存に送る）。保存済みなら null */
export function autosaveSnapshot(): { fileName: string; text: string; sidecar?: string } | null {
  const s = get();
  if (s.screen !== 'editor' || !isDirty(s)) return null;
  return { fileName: s.meta.fileName, text: serializeDtx(withSongEnd(s.doc)), sidecar: sidecarIsEmpty() ? undefined : serializeSidecar(sidecarData()) };
}

export async function autosaveNow(saved = false) {
  const s = get();
  if (s.screen !== 'editor') return;
  if (!saved && s.doc === lastAutosaved) return;
  lastAutosaved = s.doc;
  lastAutosaveAt = Date.now();
  await putRecent(autosaveEntry(s));
  await trimRecent();
}

export function startAutosave() {
  // ほかの難易度の譜面を書き換えたら（原曲をそろえた）、開いている難易度の控えを「最近の曲」でいちばん新しくしておく
  setAfterSiblingWrite(() => void autosaveNow(true));
  const later = () => {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => void autosaveNow(true), 1500);
  };
  const a = useEditor.subscribe((s, prev) => {
    if (s.doc === prev.doc || s.screen !== 'editor') return;
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => void autosaveNow(), 1500);
  });
  // セクションやアンカーだけを変えたときも控えを残す
  const b = useSidecar.subscribe((s, prev) => {
    if (s.dirty && s !== prev && useEditor.getState().screen === 'editor') later();
  });
  // メモリにだけある曲フォルダ（ZIP・落としたファイル・新しい曲）を開いたら、音ごと本体に入れる
  const c = useEditor.subscribe((s, prev) => {
    const folder = s.folder;
    if (!folder || folder === prev.folder || folder.dir) return;
    void checkLocal().then((ok) => {
      if (ok && get().folder === folder) void promoteToLocal(folder);
    });
  });
  return () => {
    a();
    b();
    c();
    setAfterSiblingWrite(null);
  };
}

export { listRecent, listRecentSongs };

export async function openRecent(e: RecentEntry) {
  if (!(await confirmDiscard())) return;
  await openRecentEntry(e);
  await tellOtherDrafts();
}

/**
 * 「最近の曲」は曲ごとに1つ（最後の難易度）なので、ほかの難易度に保存していない続きがあれば、
 * 難易度を切り替えるとそこから開けることを知らせる
 */
async function tellOtherDrafts() {
  const s = get();
  const folder = s.folder;
  if (s.screen !== 'editor' || !folder) return;
  const labels: string[] = [];
  for (const sb of s.meta.siblings) {
    if (sb.file.toLowerCase() === s.meta.fileName.toLowerCase()) continue;
    const f = findFile(folder, sb.file);
    if (f && (await draftFor(folder, f))) labels.push(sb.label);
  }
  if (!labels.length || get().folder !== folder) return;
  const names = labels.join(tr('・', ', '));
  toast(
    tr(
      `${names} に保存していない変更があります。上のバーで難易度を切り替えると、その続きから開きます`,
      `${names} ${labels.length === 1 ? 'has' : 'have'} unsaved changes. Switch difficulty in the top bar to continue from there`,
    ),
    'info',
    8000,
  );
}

/** 曲フォルダの中で、自動保存した譜面を開く（DTX がまだフォルダに無い新しい曲は、控えの本文から） */
async function openEntryInFolder(folder: SongFolder, e: RecentEntry) {
  const f = findFile(folder, e.fileName);
  if (f) {
    await openDtxFile(folder, f, undefined, e.saved ? undefined : e.text, recentSidecarOf(e));
    return;
  }
  const parsed = parseDtx(e.text);
  openDocument(parsed.doc, { ...newMeta(e.fileName, folder), recentId: e.id, warnings: parsed.warnings, hasRandom: parsed.hasRandom }, folder, { dirty: true });
  await loadSidecarFor(folder, e.fileName, recentSidecarOf(e));
}

async function openRecentEntry(e: RecentEntry) {
  if (e.local) {
    await checkLocal();
    const folder = await openLocalSong(e.local);
    if (folder) {
      await openEntryInFolder(folder, e);
      return;
    }
  } else if (e.dir) {
    try {
      const perm = e.dir.requestPermission ? await e.dir.requestPermission({ mode: 'readwrite' }) : 'granted';
      if (perm === 'granted') {
        await openEntryInFolder(await folderFromHandle(e.dir), e);
        return;
      }
    } catch {
      // フォルダが消えた・権限が無い → 本文だけ開く
    }
  }
  const parsed = parseDtx(e.text);
  // 本体の曲が消えていたら、控えは別の名前で取り直す（本体が一時的に読めないだけなら、元の控えを残すため）
  openDocument(parsed.doc, { ...newMeta(e.fileName, null), ...(e.local ? {} : { recentId: e.id }), warnings: parsed.warnings, hasRandom: parsed.hasRandom }, null, { dirty: !e.saved || !!e.local });
  await loadSidecarFor(null, e.fileName, e.sidecar);
  if (e.local) toastLocalMissing();
  else toast(tr('自動保存した譜面だけを開きました。音を鳴らすには曲フォルダを開いてください', 'Opened only the autosaved chart. Open the song folder to hear the sounds'), 'info', 6000);
}

// ---- ZIP（iPad：フォルダを選べない・書けない） ------------------------------------------

/**
 * ZIP にまとめた曲フォルダを開く（ファイル App の「圧縮」や PC で作った ZIP）。
 * 開いたら曲フォルダごと本体に入れる（本体が使えなければメモリに持つ）。本体に同じ名前の曲があれば、どうするか聞く
 */
export async function openZipFile(file: File) {
  useEditor.setState({ loading: tr('ZIP を開いています…', 'Opening the ZIP…') });
  let z: Awaited<ReturnType<typeof readZip>>;
  try {
    z = await readZip(file);
  } catch (e) {
    toast(tr(`ZIP を開けませんでした: ${(e as Error).message}`, `Couldn't open the ZIP: ${(e as Error).message}`), 'error', 7000);
    return;
  } finally {
    useEditor.setState({ loading: null });
  }
  const folders = songFoldersOf(z);
  if (folders.length === 0) {
    // DTX が無い：音声があれば、それで新しい譜面を作る
    const audio = [...z.files].filter(([p]) => AUDIO_EXT.test(p)).map(([p, d]) => new File([d as Uint8Array<ArrayBuffer>], p.split('/').pop()!));
    if (audio.length) {
      await openDroppedFiles(audio);
      return;
    }
    toast(tr('ZIP の中に DTX も音声ファイルもありませんでした', 'The ZIP has no DTX or audio files'), 'warn', 6000);
    return;
  }
  if (!(await confirmDiscard())) return;
  let folder = folders[0];
  if (folders.length > 1) {
    const picked = await chooseDialog({
      title: tr('どの曲を開きますか？', 'Which song do you want to open?'),
      body: tr(`${file.name} には曲が ${folders.length} 個あります。`, `${file.name} has ${folders.length} songs.`),
      options: folders.map((f) => ({ label: f.name, sub: tr(`譜面 ${dtxFiles(f).length} 個`, `${dtxFiles(f).length} ${pl(dtxFiles(f).length, 'chart')}`), value: f })),
    });
    if (!picked) return;
    folder = picked;
  }
  const dup = await checkLocalDuplicate(folder);
  if (dup !== 'go') return;
  await openFolder(folder);
}

/** 選んだファイルを開く：ZIP なら曲フォルダとして、DTX・音声ならそれから */
export async function openPickedFiles(files: File[]) {
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (zip) {
    await openZipFile(zip);
    return;
  }
  await openDroppedFiles(files);
}

export type ExportWhat = 'folder' | 'dtx' | 'diffs';

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
  type: string;
}

/**
 * 書き出すファイルを作る（タブレットの「保存と書き出し」）。
 * folder: 曲フォルダの ZIP（DTX・音・画像・キットの音・作業ファイル）、dtx: 開いている難易度の DTX だけ、
 * diffs: 選んだ難易度の DTX（開いている難易度は今の中身、ほかはフォルダの中身）を ZIP に
 */
export async function buildExport(
  what: ExportWhat,
  opts: { encoding?: 'shift_jis' | 'utf-8-bom'; diffs?: string[]; ask?: boolean } = {},
): Promise<{ file: ExportFile; lost: string[] } | null> {
  const enc = opts.encoding ?? 'shift_jis';
  // 試聴（#PREVIEW）が空なら原曲を入れ、Shift_JIS で書き出すときは譜面に書くファイル名を NX で読める名前にしてから
  await prepareForNx({ rename: enc === 'shift_jis', dtxOnly: what !== 'folder' });
  const s = get();
  const doc = s.doc;
  const { bytes, lost } = encodeDtx(serializeDtx(withSongEnd(doc)), enc);
  // ask: false なら確かめずに作り、表せない文字は返す（「保存と書き出し」は前もって作っておき、画面に出す）
  if (lost.length > 0 && opts.ask !== false) {
    const ok = await confirmDialog({
      title: tr('Shift_JISで表せない文字があります', "Some characters can't be written in Shift_JIS"),
      body: tr(
        `${lost.join(' ')}\n\nNXは譜面をShift_JISで読むため、これらの文字は「?」になります。曲情報で別の文字に置き換えるか、UTF-8 で書き出してください。このまま書き出しますか？`,
        `${lost.join(' ')}\n\nNX reads charts as Shift_JIS, so these characters become "?". Replace them in Song info or export as UTF-8. Export anyway?`,
      ),
      ok: tr('このまま書き出す', 'Export anyway'),
    });
    if (!ok) return null;
  }
  const fileName = s.meta.fileName;
  const folder = s.folder;
  // 開いている譜面は、メモリの曲フォルダにも置いておく（難易度を切り替えて戻ったとき・次の ZIP に入れる）
  if (folder && !folder.dir) await putFile(folder, fileName, bytes);
  if (what === 'dtx') return { file: { name: fileName, bytes, type: 'application/octet-stream' }, lost };
  const files: Record<string, Uint8Array> = {};
  const title = (doc.fields['TITLE'] || folder?.name || 'song').replace(/[\\/:*?"<>|]/g, '_');
  if (what === 'diffs') {
    const want = new Set((opts.diffs ?? [fileName]).map((f) => f.toLowerCase()));
    if (folder) {
      for (const f of dtxFiles(folder)) {
        if (!want.has(f.name.toLowerCase()) || f.name.toLowerCase() === fileName.toLowerCase()) continue;
        files[f.path] = new Uint8Array(await (await f.getFile()).arrayBuffer());
      }
    }
    files[fileName] = bytes;
    return { file: { name: `${title}-dtx.zip`, bytes: zipSync(files, { level: 0 }), type: 'application/zip' }, lost };
  }
  if (folder) {
    for (const f of folder.files.values()) if (syncedPath(f.path)) files[f.path] = new Uint8Array(await (await f.getFile()).arrayBuffer());
  }
  for (const k of await kitFilesNeeded(doc, folder)) files[k.path] = k.bytes;
  files[fileName] = bytes;
  const side = sidecarBytes(folder, fileName);
  if (side) files[sidecarName(fileName)] = side;
  return { file: { name: `${title}.zip`, bytes: zipSync(files, { level: 0 }), type: 'application/zip' }, lost };
}

/** 書き出したファイルを渡す：共有（AirDrop・ファイル App・ほかのアプリ）か、ダウンロード（ファイルに保存） */
export async function deliverExport(f: ExportFile, how: 'share' | 'download'): Promise<boolean> {
  if (how === 'share') {
    const file = new File([f.bytes as Uint8Array<ArrayBuffer>], f.name, { type: f.type });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) {
      try {
        await nav.share({ files: [file], title: f.name });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return false;
        toast(tr(`共有できませんでした: ${(e as Error).message}`, `Couldn't share: ${(e as Error).message}`), 'error', 7000);
        return false;
      }
    } else {
      downloadBytes(f.name, f.bytes, f.type);
      toast(tr('このブラウザは共有できないので、ダウンロードしました', "This browser can't share files, so it was downloaded"), 'info', 6000);
    }
  } else {
    downloadBytes(f.name, f.bytes, f.type);
  }
  // 本体の曲は、書き出した中身を本体にも保存しておく（「保存済み」と出すので）
  if (!(await saveLocalQuiet())) {
    markSidecarSaved();
    markSaved(get().doc);
  }
  toast(tr(`${f.name} を書き出しました`, `Exported ${f.name}`), 'ok');
  return true;
}
