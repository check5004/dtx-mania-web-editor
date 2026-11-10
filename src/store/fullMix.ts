// 完全な原曲（ステムに分ける前の、ドラムも入った原曲）と、選曲画面の試聴（#PREVIEW）。
// - 完全な原曲は作業ファイル（.dtxe.json）の fullMix に覚える（曲フォルダの中のパス）。BGM をドラム抜きにしても、
//   分け直す元・試聴・曲を直すときのために曲フォルダに残す（書き出しで上書きしない）。覚えていなければ、ドラム抜きらしくない今の原曲
// - 試聴は原曲についてくる：空、または前の原曲・前の完全な原曲を指していたら、原曲を替えたときに新しい原曲（ドラム入り）にする。
//   わざと別の音を選んだ試聴はそのまま。NX は #PREVIEW が無いと選曲画面で何も鳴らさないので、空のまま保存・書き出しするときも入れる
import { tr } from '../i18n';
import { toBase36x2 } from '../dtx/base36';
import type { DtxDoc } from '../dtx/model';
import { setField } from '../edit/ops';
import { findFile, normPath, type FolderFile, type SongFolder } from '../fs/folder';
import { isDrumlessName } from '../separate/names';
import { bgmSource } from './derived';
import { useEditor } from './editor';
import { setFullMix, useSidecar } from './sidecar';
import { editSong, toastSongEdit } from './songSync';

/** NX が試聴に鳴らせる音 */
export const PREVIEW_EXT = /\.(ogg|wav|mp3)$/i;

/** 作業ファイルが覚えている完全な原曲（曲フォルダに無ければ null） */
export function fullMixFile(folder: SongFolder | null = useEditor.getState().folder): FolderFile | null {
  const p = useSidecar.getState().fullMix;
  return p ? (findFile(folder, p) ?? null) : null;
}

/** 譜面の原曲（最初の BGM チップの音）のファイル。曲フォルダに無ければ null */
export function bgmFileOf(doc: DtxDoc, folder: SongFolder | null): FolderFile | null {
  const b = bgmSource(doc);
  const p = b ? doc.fields['WAV' + toBase36x2(b.wav)] : undefined;
  return p ? (findFile(folder, p, doc.fields['PATH_WAV'] ?? '') ?? null) : null;
}

/** 完全な原曲（ドラム入り）：覚えているもの。無ければ、ドラム抜きらしくない今の原曲 */
export function fullOriginal(doc: DtxDoc = useEditor.getState().doc, folder: SongFolder | null = useEditor.getState().folder): FolderFile | null {
  const fm = fullMixFile(folder);
  if (fm) return fm;
  const b = bgmFileOf(doc, folder);
  return b && !isDrumlessName(b.name) ? b : null;
}

const same = (a: FolderFile | null | undefined, b: FolderFile | null | undefined) => !!a && !!b && normPath(a.path) === normPath(b.path);

/**
 * 原曲を替えるときに、試聴（#PREVIEW）も替えるか：空、または前の原曲・前の完全な原曲と同じファイルを指している
 * （わざと別の音を選んだ試聴はそのまま）
 */
export function previewFollows(doc: DtxDoc, folder: SongFolder | null, olds: (FolderFile | null | undefined)[]): boolean {
  const v = (doc.fields['PREVIEW'] ?? '').trim();
  if (!v) return true;
  const f = findFile(folder, v);
  return !!f && olds.some((o) => same(o, f));
}

/**
 * 原曲を替える前に、完全な原曲と試聴をどうするか決める（開いている譜面を替える前に呼ぶ）。
 * file は新しい原曲（曲フォルダの中のパス）。preview は試聴に入れる値（替えなければ null）
 */
export function planBgmSwap(file: string): { preview: string | null; fullMix: string | null | undefined } {
  const s = useEditor.getState();
  const folder = s.folder;
  const oldBgm = bgmFileOf(s.doc, folder);
  const oldFull = fullMixFile(folder);
  const drumless = isDrumlessName(file);
  // 新しい原曲がドラム入りなら、それが完全な原曲。ドラム抜きなら、前の原曲（ドラム入り）を完全な原曲として覚えておく
  let fullMix: string | null | undefined;
  let full: string | null;
  if (!drumless) {
    // 覚えていた完全な原曲は、新しい原曲に替える（覚えていなければ、今の原曲がそれなので書かない）
    const remembered = useSidecar.getState().fullMix;
    fullMix = remembered && normPath(remembered) !== normPath(file) ? file : undefined;
    full = file;
  } else {
    const prevFull = oldFull ?? (oldBgm && !isDrumlessName(oldBgm.name) ? oldBgm : null);
    fullMix = !oldFull && prevFull && normPath(prevFull.path) !== normPath(file) ? prevFull.path : undefined;
    full = prevFull && normPath(prevFull.path) !== normPath(file) ? prevFull.path : null;
  }
  const cur = (s.doc.fields['PREVIEW'] ?? '').trim();
  let preview: string | null = null;
  if (full && PREVIEW_EXT.test(full) && normPath(cur) !== normPath(full)) {
    // ドラム抜きにするとき：試聴は前の原曲のまま（空のときだけ完全な原曲を入れる）
    if (drumless ? !cur : previewFollows(s.doc, folder, [oldBgm, oldFull])) preview = full;
  }
  return { preview, fullMix };
}

/** planBgmSwap で決めた完全な原曲を作業ファイルに覚える */
export function rememberFullMix(fullMix: string | null | undefined) {
  if (fullMix !== undefined) setFullMix(fullMix);
}

/** 分けた音（ステムの元）を、完全な原曲として覚える（ドラム抜きらしい音は覚えない） */
export function rememberSeparationSource(path: string) {
  if (isDrumlessName(path)) return;
  const b = bgmFileOf(useEditor.getState().doc, useEditor.getState().folder);
  // 今の原曲と同じで、まだ何も覚えていなければ書かない（原曲がそれなので。作業ファイルを増やさない）
  if (!useSidecar.getState().fullMix && b && normPath(b.path) === normPath(path)) return;
  setFullMix(path);
}

/** 書き出しで上書きしてはいけないファイル（完全な原曲）か */
export function isFullMixPath(path: string): boolean {
  const f = fullMixFile();
  return !!f && normPath(f.path) === normPath(path.replace(/\\/g, '/').replace(/^\/+/, ''));
}

// 自動で試聴を入れた譜面（あとで空にしたら、もう入れない。わざと外したので）
let filledFor: { folder: SongFolder | null; fileName: string } | null = null;

/**
 * 試聴（#PREVIEW）が空なら、完全な原曲（ドラム入り）を入れる（NX は試聴が無いと選曲画面で何も鳴らさない）。
 * 同じく空だったほかの難易度にも入れて知らせる。入れたらそのパス
 */
export function fillPreview(): string | null {
  const s = useEditor.getState();
  if (s.screen !== 'editor' || (s.doc.fields['PREVIEW'] ?? '').trim()) return null;
  // 一度入れたのを空にしたなら、そのまま
  if (filledFor && filledFor.folder === s.folder && filledFor.fileName === s.meta.fileName) return null;
  const f = fullOriginal(s.doc, s.folder);
  if (!f || !PREVIEW_EXT.test(f.name)) return null;
  const r = editSong(tr('試聴（#PREVIEW）に原曲を入れる', 'Use the original as the preview (#PREVIEW)'), (d) => setField(d, 'PREVIEW', f.path));
  if (!r.ok) return null;
  filledFor = { folder: s.folder, fileName: s.meta.fileName };
  void toastSongEdit(
    r,
    tr(
      `選曲画面の試聴（#PREVIEW）が空だったので、原曲「${f.path}」を入れました（NX は試聴が無いと何も鳴らしません）。曲情報で変えられます`,
      `The song select preview (#PREVIEW) was empty, so it now uses the original "${f.path}" (NX plays nothing without one). You can change it in Song info`,
    ),
    'info',
    9000,
    undefined,
    tr('試聴', 'preview'),
  );
  return f.path;
}
