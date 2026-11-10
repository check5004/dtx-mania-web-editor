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
  parseSetDef,
  pendingFiles,
  pickFolder,
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
import { deleteRecent, getRecent, listRecent, listRecentSongs, putRecent, trimRecent, type RecentEntry, type RecentSong } from '../fs/recent';
import { bumpLocal, localPlace, refreshLocalSongs, setCopying, useLocalSongs } from '../store/localSongs';
import { useDevice } from '../store/device';
import { createDoc, edit, isDirty, openDocument, prepareSounds, switchDocument, toast, useEditor, withSongEnd, type DocMeta, type EditorState } from '../store/editor';
import { hasUnsaved } from '../store/unsaved';
import { bgmSource } from '../store/derived';
import { freeWavNumber, setField } from '../edit/ops';
import { toBase36x2 } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { loadSidecar, markSidecarSaved, parseSidecar, serializeSidecar, sidecarData, sidecarIsEmpty, sidecarName, useSidecar, type SidecarData } from '../store/sidecar';
import { chooseDialog, confirmDialog, newSongDialog, promptDialog } from '../ui/dialogs';
import { readZip, songFoldersOf } from '../fs/zip';
import { sortByDifficulty } from '../gen/diffTabs';
import { syncedPath } from '../drive/sync';

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

/** 作業ファイル（.dtxe.json）の中身。フォルダに無ければ自動保存の控えを使う */
async function readSidecarFor(folder: SongFolder | null, fileName: string, recentSidecar?: string): Promise<SidecarData | null> {
  const f = folder ? findFile(folder, sidecarName(fileName)) : undefined;
  let data = null;
  if (f) {
    try {
      data = parseSidecar(await (await f.getFile()).text());
    } catch {
      data = null;
    }
  }
  if (!data && recentSidecar) data = parseSidecar(recentSidecar);
  return data;
}

/** 作業ファイル（.dtxe.json）を読む。フォルダに無ければ自動保存の控えを使う */
async function loadSidecarFor(folder: SongFolder | null, fileName: string, recentSidecar?: string) {
  loadSidecar(await readSidecarFor(folder, fileName, recentSidecar));
}

/**
 * AI難易度生成で作った譜面は作業ファイルを持たない（書き出すのは DTX だけ）。作った元の譜面（#DTXE_ORIGIN の from）の
 * 作業ファイルを使う：同じ曲の音なので、ステム・解析に使うステム・参照映像・セクションは元の譜面と同じ
 */
async function sourceSidecarFor(folder: SongFolder, doc: DtxDoc): Promise<SidecarData | null> {
  const from = readOrigin(doc)?.from;
  return from ? readSidecarFor(folder, from) : null;
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
  recentSidecar?: string,
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
    if (switching.stale() || !(await switchDocument(parsed.doc, meta, side, { dirty, stale: switching.stale }))) return;
    void scanSiblingOrigins(folder);
  } else {
    openDocument(parsed.doc, meta, folder, { dirty });
    void scanSiblingOrigins(folder);
    loadSidecar((await readSidecarFor(folder, file.name, recentSidecar)) ?? (await sourceSidecarFor(folder, parsed.doc)));
  }
  if (useRecent) toast(tr('前回の自動保存から続きを開きました（まだ曲フォルダには保存されていません）', "Opened from your last autosave (not saved to the song folder yet)"), 'warn', 6000);
}

export function recentIdFor(folder: SongFolder | null, fileName: string) {
  if (folder?.local) return `local:${folder.local}/${fileName}`.toLowerCase();
  return `${folder?.name ?? 'new'}/${fileName}`.toLowerCase();
}

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

/** フォルダ選択ダイアログ（Chrome/Edge）。無ければ webkitdirectory の input を使う */
export async function openFolderPicker(fallbackInput?: HTMLInputElement | null) {
  if (!(await confirmDiscard())) return;
  if (supportsDirectWrite()) {
    try {
      const folder = await pickFolder();
      if (folder) await openFolder(folder);
    } catch (e) {
      toast(tr(`フォルダを開けませんでした: ${(e as Error).message}`, `Couldn't open the folder: ${(e as Error).message}`), 'error');
    }
    return;
  }
  fallbackInput?.click();
}

/** <input webkitdirectory> から（フォルダに書けないブラウザ。開いたら曲フォルダごと本体に入れる） */
export async function openFolderFromInput(list: FileList | null) {
  if (!list || list.length === 0) return;
  const folder = folderFromFileList(list);
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
  const f = findFile(folder, fileName);
  if (!f) return;
  const seq = ++switchSeq;
  // 保存していない変更は、いまの内容を「最近の曲」の自動保存に残してから切り替える（確認で伝えたとおりに。作業ファイルだけの変更も）
  if (hasUnsaved(get())) await autosaveNow(true);
  // 切り替える難易度に保存していない続き（自動保存）があれば、そこから開く（「最近の曲」は曲ごとに1つなので、ほかの難易度の続きはここで開く）
  const resume = await draftFor(folder, f);
  await openDtxFile(folder, f, undefined, resume?.text, resume?.sidecar, { stale: () => seq !== switchSeq || get().folder !== folder });
}

/** 落としたファイル（DTX・音声）から開く */
export async function openDroppedFiles(files: File[]) {
  if (files.length === 0) return;
  if (!(await confirmDiscard())) return;
  const dtx = files.find((f) => /\.dtx$/i.test(f.name));
  const folder = folderFromFiles(files, dtx ? dtx.name.replace(/\.dtx$/i, '') : files[0].name.replace(/\.[^.]+$/, ''));
  if (dtx) {
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
  const info = await newSongDialog({
    title: tr('新しい譜面をつくる', 'Create a new chart'),
    audioFiles: audio.map((f) => f.name),
    defaults: {
      title: tags?.title || audio[0].name.replace(/\.[^.]+$/, ''),
      artist: tags?.artist || tags?.albumArtist || undefined,
      bpm: tags?.bpm ? Math.round(tags.bpm * 100) / 100 : undefined,
      bgmFile: audio[0].name,
    },
  });
  if (!info) return;
  openDocument(createDoc(info), newMeta('mstr.dtx', null), folder, { dirty: true });
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
  const same = findFile(folder, file.name);
  let path = file.name;
  let memory = false;
  if (!(same && same.size === file.size)) {
    path = freePath(folder, file.name);
    memory = (await putFile(folder, path, file)) === 'memory';
  } else {
    path = same.path;
  }
  const bgm = bgmSource(get().doc);
  edit(bgm ? tr('原曲を差し替える', 'Replace the original') : tr('原曲を読み込む', 'Load the original'), (d) => {
    if (bgm) {
      setField(d, 'WAV' + toBase36x2(bgm.wav), path);
      return;
    }
    const no = freeWavNumber(d) ?? 1;
    setField(d, 'WAV' + toBase36x2(no), path);
    if (d.fields['BGMWAV'] === undefined) setField(d, 'BGMWAV', toBase36x2(no));
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 1, f: frac(0), v: no });
  });
  await prepareSounds();
  toast(
    isJa()
      ? `原曲「${path}」を${bgm ? '差し替えました' : '読み込みました（001小節の頭から鳴らします。ずれていたら「テンポ合わせ」で合わせられます）'}${memory ? '。曲フォルダへは保存するときに書き出します' : ''}`
      : `${bgm ? 'Replaced' : 'Loaded'} the original "${path}"${bgm ? '' : ' (it plays from the start of measure 001; if it is off, line it up in "Tempo")'}${memory ? '. It is written to the song folder when you save' : ''}`,
    'ok',
    7000,
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

/** 保存を始めるとき（操作の中、最初の await の前）に呼ぶ。Drive のログインの小窓を開くため（src/app/driveActions.ts） */
let beforeSave: ((opts: { toFolder?: boolean }) => void) | null = null;
export function setBeforeSave(fn: ((opts: { toFolder?: boolean }) => void) | null) {
  beforeSave = fn;
}

export async function save(opts: { as?: boolean; toFolder?: boolean } = {}) {
  const s = get();
  if (s.screen !== 'editor') return;
  beforeSave?.(opts);
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
    fileName = /\.dtx$/i.test(name) ? name : `${name}.dtx`;
  }
  let folder = s.folder;
  // 本体に入れている途中なら、入れ終わってから保存する
  if (folder && !folder.dir) await promotions.get(folder);
  const kit = await kitFilesNeeded(doc, folder);
  try {
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
      // PC（フォルダに直接保存できるブラウザ）。まだ曲フォルダが無い・本体に置いた曲は、NX の曲フォルダを選んで保存する。
      // 本体に置いたまま保存することもできる（選んだら、その曲は次から聞かずに本体へ）
      let where: 'folder' | 'local' = 'folder';
      if (!opts.toFolder) {
        const keep = folder?.local ? (await getLocalSong(folder.local))?.keepInBrowser : false;
        if (keep) where = 'local';
        else if (await checkLocal()) {
          const c = await chooseDialog<'folder' | 'local'>({
            title: tr('どこに保存しますか？', 'Where do you want to save?'),
            body: tr('NX で遊ぶには、NX の曲フォルダ（DTXFiles の中など）に保存します。', 'To play it in NX, save it into an NX song folder (inside DTXFiles, for example).'),
            options: [
              {
                label: tr('曲フォルダを選んで保存（おすすめ）', 'Choose a song folder (recommended)'),
                sub: tr(
                  'この曲用の空のフォルダを作って選んでください。譜面・原曲・ステム・キットの音をまとめて書き、次からはそのフォルダに上書きします',
                  'Create an empty folder for this song and choose it. The chart, original audio, stems and kit sounds are written together, and later saves overwrite that folder',
                ),
                value: 'folder',
              },
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
            title: tr('曲フォルダを選んで保存します', 'Choose a song folder to save to'),
            body: tr(
              'NXの曲フォルダ（DTXFiles の中など）に、この曲用の空のフォルダを作って選んでください。譜面・原曲・内蔵キットの音をまとめて保存します。',
              "Create an empty folder for this song in NX's song folder (inside DTXFiles, for example) and choose it. The chart, the original, and the built-in kit sounds are saved together.",
            ),
            ok: tr('フォルダを選ぶ', 'Choose folder'),
          });
          if (!ok) return;
        }
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
      const dir = await window.showDirectoryPicker!({ id: 'dtx-song', mode: 'readwrite' });
      const target = await folderFromHandle(dir);
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
      toast(`${tr('保存しました: ', 'Saved: ')}${folder.name}/${fileName}${creditNote(kit)}`, 'ok', kit.some((k) => k.library) ? 9000 : 4000);
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
export function downloadDtx() {
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
  };
}

export { listRecent, listRecentSongs };

export async function openRecent(e: RecentEntry) {
  if (!(await confirmDiscard())) return;
  await openRecentEntry(e);
  await tellOtherDrafts();
}

/**
 * 難易度の保存していない続き（自動保存の控え）。譜面のファイルのほうが新しい（AI難易度生成で反映し直した・ほかで書き換えた）
 * ときは、古い続きなので使わない
 */
async function draftFor(folder: SongFolder, file: FolderFile): Promise<RecentEntry | undefined> {
  const e = await getRecent(recentIdFor(folder, file.name));
  if (!e || e.saved) return undefined;
  try {
    return e.updatedAt >= (await file.getFile()).lastModified ? e : undefined;
  } catch {
    return undefined;
  }
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
    await openDtxFile(folder, f, undefined, e.saved ? undefined : e.text, e.sidecar);
    return;
  }
  const parsed = parseDtx(e.text);
  openDocument(parsed.doc, { ...newMeta(e.fileName, folder), recentId: e.id, warnings: parsed.warnings, hasRandom: parsed.hasRandom }, folder, { dirty: true });
  await loadSidecarFor(folder, e.fileName, e.sidecar);
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
  const s = get();
  const doc = s.doc;
  const enc = opts.encoding ?? 'shift_jis';
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
