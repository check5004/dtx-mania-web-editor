// ファイルを開く・保存する流れ。
import { zipSync } from 'fflate';
import { encodeWav, kitByFile, loadKit } from '../audio/kit';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import type { DtxDoc } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import {
  audioFiles,
  downloadBytes,
  dtxFiles,
  ensureWritable,
  findFile,
  folderFromFileList,
  folderFromFiles,
  folderFromHandle,
  parseSetDef,
  pickFolder,
  supportsDirectWrite,
  writeFile,
  type FolderFile,
  type SongFolder,
} from '../fs/folder';
import { listRecent, putRecent, trimRecent, type RecentEntry } from '../fs/recent';
import { createDoc, isDirty, openDocument, toast, useEditor, type DocMeta } from '../store/editor';
import { loadSidecar, markSidecarSaved, parseSidecar, serializeSidecar, sidecarData, sidecarIsEmpty, sidecarName, useSidecar } from '../store/sidecar';
import { chooseDialog, confirmDialog, newSongDialog, promptDialog } from '../ui/dialogs';

const get = useEditor.getState;

async function confirmDiscard(): Promise<boolean> {
  const s = get();
  if (s.screen !== 'editor' || !isDirty(s)) return true;
  return confirmDialog({
    title: '保存していない変更があります',
    body: '開き直すと、いまの変更は「最近の曲」の自動保存にだけ残ります。続けますか？',
    ok: '続ける',
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

function siblingsOf(folder: SongFolder, labels: Map<string, string>) {
  return dtxFiles(folder).map((f) => ({ file: f.name, label: labels.get(f.name.toLowerCase()) ?? f.name.replace(/\.dtx$/i, '') }));
}

/** 作業ファイル（.dtxe.json）を読む。フォルダに無ければ自動保存の控えを使う */
async function loadSidecarFor(folder: SongFolder | null, fileName: string, recentSidecar?: string) {
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
  loadSidecar(data);
}

async function openDtxFile(folder: SongFolder, file: FolderFile, labels?: Map<string, string>, recentText?: string, recentSidecar?: string) {
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
  openDocument(parsed.doc, meta, folder, { dirty: useRecent || decoded.encoding === 'utf-8' });
  await loadSidecarFor(folder, file.name, recentSidecar);
  if (useRecent) toast('前回の自動保存から続きを開きました（まだ曲フォルダには保存されていません）', 'warn', 6000);
}

function recentIdFor(folder: SongFolder | null, fileName: string) {
  return `${folder?.name ?? 'new'}/${fileName}`.toLowerCase();
}

/** 曲フォルダを開いた後：DTX を選ぶ、無ければ新規作成 */
export async function openFolder(folder: SongFolder) {
  const list = dtxFiles(folder);
  const labels = await readSetDefLabels(folder);
  if (list.length === 0) {
    const info = await newSongDialog({
      title: `「${folder.name}」に新しい譜面を作る`,
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
      title: 'どの難易度を開きますか？',
      body: `${folder.name} には譜面が ${list.length} 個あります。`,
      options: list.map((f) => ({
        label: labels.get(f.name.toLowerCase()) ?? f.name,
        sub: `${f.name} · ${(f.size / 1024).toFixed(1)} KB`,
        value: f,
      })),
    });
    if (!picked) return;
    file = picked;
  }
  await openDtxFile(folder, file, labels);
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
      toast(`フォルダを開けませんでした: ${(e as Error).message}`, 'error');
    }
    return;
  }
  fallbackInput?.click();
}

/** <input webkitdirectory> から */
export async function openFolderFromInput(list: FileList | null) {
  if (!list || list.length === 0) return;
  await openFolder(folderFromFileList(list));
}

/** 難易度タブの切り替え（同じフォルダの別の DTX） */
export async function switchDifficulty(fileName: string) {
  const s = get();
  if (!s.folder || fileName === s.meta.fileName) return;
  if (!(await confirmDiscard())) return;
  const f = findFile(s.folder, fileName);
  if (f) await openDtxFile(s.folder, f);
}

/** 落としたファイル（DTX・音声）から開く */
export async function openDroppedFiles(files: File[]) {
  if (files.length === 0) return;
  if (!(await confirmDiscard())) return;
  const dtx = files.find((f) => /\.dtx$/i.test(f.name));
  const folder = folderFromFiles(files, dtx ? dtx.name.replace(/\.dtx$/i, '') : files[0].name.replace(/\.[^.]+$/, ''));
  if (dtx) {
    await openDtxFile(folder, folder.files.get(dtx.name.toLowerCase())!);
    if (files.length === 1) toast('DTXだけを開きました。音を鳴らすには曲フォルダごと開いてください', 'info', 6000);
    return;
  }
  const audio = files.filter((f) => /\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(f.name));
  if (audio.length === 0) {
    toast('DTXか音声ファイル（WAV・OGG・MP3）を選んでください', 'warn');
    return;
  }
  const info = await newSongDialog({
    title: '新しい譜面をつくる',
    audioFiles: audio.map((f) => f.name),
    defaults: { title: audio[0].name.replace(/\.[^.]+$/, ''), bgmFile: audio[0].name },
  });
  if (!info) return;
  openDocument(createDoc(info), newMeta('mstr.dtx', null), folder, { dirty: true });
}

export async function newEmptySong() {
  if (!(await confirmDiscard())) return;
  const info = await newSongDialog({ title: '新しい譜面をつくる', audioFiles: [], defaults: {} });
  if (!info) return;
  openDocument(createDoc(info), newMeta('mstr.dtx', null), null, { dirty: true });
}

// ---- 保存 ---------------------------------------------------------------------

/** 内蔵キットの音で、曲フォルダにまだ無いもの */
async function kitFilesNeeded(doc: DtxDoc, folder: SongFolder | null): Promise<{ path: string; bytes: Uint8Array }[]> {
  const out: { path: string; bytes: Uint8Array }[] = [];
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const names = new Set<string>();
  for (const [k, v] of Object.entries(doc.fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k)) continue;
    const kit = kitByFile.get(v.toLowerCase());
    if (!kit || names.has(kit.file)) continue;
    if (findFile(folder, v, pathWav)) continue;
    names.add(kit.file);
  }
  if (names.size === 0) return out;
  const bufs = await loadKit();
  for (const n of names) {
    const b = bufs.get(n.toLowerCase());
    if (b) out.push({ path: pathWav ? `${pathWav.replace(/\\/g, '/').replace(/\/+$/, '')}/${n}` : n, bytes: encodeWav(b) });
  }
  return out;
}

function encodeForSave(doc: DtxDoc) {
  return encodeDtx(serializeDtx(doc), 'shift_jis');
}

/** 作業ファイルの中身（空で、フォルダにも無ければ書かない） */
function sidecarBytes(folder: SongFolder | null, fileName: string): Uint8Array | null {
  const d = sidecarData();
  if (sidecarIsEmpty(d) && !(folder && findFile(folder, sidecarName(fileName)))) return null;
  return new TextEncoder().encode(serializeSidecar(d));
}

function markSaved(doc: DtxDoc, patch: Partial<ReturnType<typeof get>> = {}) {
  useEditor.setState((s) => ({ ...patch, savedDoc: doc, savedAt: Date.now(), meta: { ...s.meta, ...(patch.meta ?? {}), encoding: 'shift_jis', encodingNote: undefined } }));
  void autosaveNow(true);
}

export async function save(opts: { as?: boolean } = {}) {
  const s = get();
  if (s.screen !== 'editor') return;
  const doc = s.doc;
  const { bytes, lost } = encodeForSave(doc);
  if (lost.length > 0) {
    const ok = await confirmDialog({
      title: 'Shift_JISで表せない文字があります',
      body: `${lost.join(' ')}\n\nNXは譜面をShift_JISで読むため、これらの文字は「?」になります。曲情報で別の文字に置き換えるのがおすすめです。このまま保存しますか？`,
      ok: 'このまま保存',
    });
    if (!ok) return;
  }
  let fileName = s.meta.fileName;
  if (opts.as) {
    const name = await promptDialog({ title: '名前を付けて保存', body: '同じ曲フォルダに保存します。', value: fileName, ok: '保存' });
    if (!name) return;
    fileName = /\.dtx$/i.test(name) ? name : `${name}.dtx`;
  }
  let folder = s.folder;
  const kit = await kitFilesNeeded(doc, folder);
  try {
    if (folder?.dir) {
      if (!(await ensureWritable(folder))) {
        toast('フォルダへの書き込みが許可されませんでした', 'error');
        return;
      }
      if (findFile(folder, fileName) && fileName !== s.meta.fileName) {
        const ok = await confirmDialog({ title: `${fileName} を上書きしますか？`, body: '同じ名前の譜面がフォルダにあります。', ok: '上書き', danger: true });
        if (!ok) return;
      }
      for (const k of kit) await writeFile(folder, k.path, k.bytes);
      await writeFile(folder, fileName, bytes);
      const side = sidecarBytes(folder, fileName);
      if (side) await writeFile(folder, sidecarName(fileName), side);
      markSidecarSaved();
      markSaved(doc, { meta: { ...get().meta, fileName, recentId: recentIdFor(folder, fileName) } });
      toast(`保存しました: ${folder.name}/${fileName}${kit.length ? `（内蔵キットの音 ${kit.length} 個も保存）` : ''}`, 'ok');
      return;
    }
    if (supportsDirectWrite()) {
      // まだ保存先のフォルダが無い（新しい曲）。フォルダを選んでもらい、原曲もそこにコピーする
      const ok = await confirmDialog({
        title: '曲フォルダを選んで保存します',
        body: 'NXの曲フォルダ（DTXFiles の中など）に、この曲用の空のフォルダを作って選んでください。譜面・原曲・内蔵キットの音をまとめて保存します。',
        ok: 'フォルダを選ぶ',
      });
      if (!ok) return;
      const dir = await window.showDirectoryPicker!({ id: 'dtx-song', mode: 'readwrite' });
      const target = await folderFromHandle(dir);
      if (findFile(target, fileName)) {
        const over = await confirmDialog({ title: `${fileName} を上書きしますか？`, body: `「${target.name}」に同じ名前の譜面があります。`, ok: '上書き', danger: true });
        if (!over) return;
      }
      if (folder) {
        for (const f of folder.files.values()) {
          if (findFile(target, f.path)) continue;
          await writeFile(target, f.path, new Uint8Array(await (await f.getFile()).arrayBuffer()));
        }
      }
      for (const k of kit) await writeFile(target, k.path, k.bytes);
      await writeFile(target, fileName, bytes);
      const side = sidecarBytes(null, fileName);
      if (side) await writeFile(target, sidecarName(fileName), side);
      markSidecarSaved();
      folder = target;
      const labels = await readSetDefLabels(folder);
      markSaved(doc, { folder, meta: { ...get().meta, fileName, siblings: siblingsOf(folder, labels), recentId: recentIdFor(folder, fileName) } });
      toast(`保存しました: ${folder.name}/${fileName}`, 'ok');
      return;
    }
    // フォルダに直接書けないブラウザ：ダウンロード
    downloadSong(fileName, bytes, kit, folder);
    const side = sidecarBytes(null, fileName);
    if (side && useSidecar.getState().dirty) downloadBytes(sidecarName(fileName), side, 'application/json');
    markSidecarSaved();
    markSaved(doc, { meta: { ...get().meta, fileName } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    toast(`保存できませんでした: ${(e as Error).message}`, 'error', 8000);
  }
}

function downloadSong(fileName: string, bytes: Uint8Array, kit: { path: string; bytes: Uint8Array }[], folder: SongFolder | null) {
  const memoryOnly = folder && !folder.dir && !findFile(folder, fileName) ? [...folder.files.values()].filter((f) => !/\.dtx$/i.test(f.name)) : [];
  if (kit.length === 0 && memoryOnly.length === 0) {
    downloadBytes(fileName, bytes);
    toast(`${fileName} をダウンロードしました。曲フォルダの同じ名前のファイルと置き換えてください`, 'ok', 7000);
    return;
  }
  void (async () => {
    const files: Record<string, Uint8Array> = {};
    for (const f of memoryOnly) files[f.path] = new Uint8Array(await (await f.getFile()).arrayBuffer());
    for (const k of kit) files[k.path] = k.bytes;
    files[fileName] = bytes;
    const zip = zipSync(files, { level: 0 });
    const name = `${(get().doc.fields['TITLE'] || 'song').replace(/[\\/:*?"<>|]/g, '_')}.zip`;
    downloadBytes(name, zip, 'application/zip');
    toast(`${name} をダウンロードしました。展開したファイルを曲フォルダに入れてください`, 'ok', 7000);
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

export async function autosaveNow(saved = false) {
  const s = get();
  if (s.screen !== 'editor') return;
  if (!saved && s.doc === lastAutosaved) return;
  lastAutosaved = s.doc;
  const f = s.doc.fields;
  const entry: RecentEntry = {
    id: s.meta.recentId ?? recentIdFor(s.folder, s.meta.fileName),
    title: f['TITLE'] ?? '無題',
    artist: f['ARTIST'] ?? '',
    bpm: f['BPM'] ?? '',
    level: f['DLEVEL'] ?? '',
    fileName: s.meta.fileName,
    folderName: s.folder?.name ?? '',
    dir: s.folder?.dir,
    text: serializeDtx(s.doc),
    sidecar: sidecarIsEmpty() ? undefined : serializeSidecar(sidecarData()),
    saved: !isDirty(s),
    updatedAt: Date.now(),
  };
  await putRecent(entry);
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
  return () => {
    a();
    b();
  };
}

export { listRecent };

export async function openRecent(e: RecentEntry) {
  if (!(await confirmDiscard())) return;
  if (e.dir) {
    try {
      const perm = e.dir.requestPermission ? await e.dir.requestPermission({ mode: 'readwrite' }) : 'granted';
      if (perm === 'granted') {
        const folder = await folderFromHandle(e.dir);
        const f = findFile(folder, e.fileName);
        if (f) {
          await openDtxFile(folder, f, undefined, e.saved ? undefined : e.text, e.sidecar);
          return;
        }
        const parsed = parseDtx(e.text);
        openDocument(parsed.doc, { ...newMeta(e.fileName, folder), recentId: e.id, warnings: parsed.warnings, hasRandom: parsed.hasRandom }, folder, { dirty: true });
        await loadSidecarFor(folder, e.fileName, e.sidecar);
        return;
      }
    } catch {
      // フォルダが消えた・権限が無い → 本文だけ開く
    }
  }
  const parsed = parseDtx(e.text);
  openDocument(parsed.doc, { ...newMeta(e.fileName, null), recentId: e.id, warnings: parsed.warnings, hasRandom: parsed.hasRandom }, null, { dirty: !e.saved });
  await loadSidecarFor(null, e.fileName, e.sidecar);
  toast('自動保存した譜面だけを開きました。音を鳴らすには曲フォルダを開いてください', 'info', 6000);
}
