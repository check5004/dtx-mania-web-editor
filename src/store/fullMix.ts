// 完全な原曲（ステムに分ける前の、ドラムも入った原曲）と、選曲画面の試聴（#PREVIEW）。
// - 完全な原曲は作業ファイル（.dtxe.json）の fullMix に覚える（曲フォルダの中のパス）。BGM をドラム抜きにしても、
//   分け直す元・試聴・曲を直すときのために曲フォルダに残す（書き出しで上書きしない）。覚えていなければ、ドラム抜きらしくない今の原曲、
//   それも無ければドラム抜きの BGM と同じ名前の元の原曲（曲_drumless.ogg に対する 曲.mp3）
// - 試聴は原曲についてくる：空、または前の原曲・前の完全な原曲を指していたら、原曲を替えたときに新しい原曲（ドラム入り）にする。
//   わざと別の音を選んだ試聴はそのまま。NX は #PREVIEW が無いと選曲画面で何も鳴らさないので、空のまま保存・書き出しするときも入れる。
//   ドラム抜きの音（ステムから作った BGM など）は試聴にしない（選曲画面でドラムが鳴らない）
import { tr } from '../i18n';
import { toBase36x2 } from '../dtx/base36';
import type { DtxDoc } from '../dtx/model';
import { setField } from '../edit/ops';
import { AUDIO_EXT, findFile, normPath, type FolderFile, type SongFolder } from '../fs/folder';
import { nxSafeBase } from '../fs/nxName';
import { isDrumlessName, isGameBgmName, sourceNameInfo } from '../separate/names';
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

/**
 * 完全な原曲（ドラム入り）：覚えているもの。無ければ、ドラム抜きらしくない今の原曲（DTXMania の曲の BGM の名前 bgm.ogg・bgm_d.ogg は
 * ドラム抜きのことが多いので除く）。それも無ければ、ドラム抜きの原曲と同じ名前の元の原曲
 */
export function fullOriginal(doc: DtxDoc = useEditor.getState().doc, folder: SongFolder | null = useEditor.getState().folder): FolderFile | null {
  const fm = fullMixFile(folder);
  if (fm) return fm;
  const b = bgmFileOf(doc, folder);
  if (b && !isDrumlessName(b.name) && !isGameBgmName(b.name)) return b;
  return namedOriginal(doc, folder);
}

/**
 * 原曲（BGM）がドラム抜きの名前（曲_drumless.ogg・曲_nodrums.ogg）なら、曲フォルダにある同じ名前の元の原曲（曲.mp3 など。ドラム入り）。
 * 覚えていなくても（ほかの難易度で分けた・作業ファイルが無い）、分けた元はたいていこの名前で残っている。無ければ null
 */
export function namedOriginal(doc: DtxDoc = useEditor.getState().doc, folder: SongFolder | null = useEditor.getState().folder): FolderFile | null {
  const b = bgmFileOf(doc, folder);
  if (!folder || !b) return null;
  const info = sourceNameInfo(b.name);
  if (!info.drumless) return null;
  // ファイル名は NX で読める名前にして置くので（♡ → _ など）、比べるときも同じにする
  const want = nxSafeBase(info.base, 'bgm').toLowerCase();
  for (const f of folder.files.values()) {
    if (same(f, b) || !AUDIO_EXT.test(f.name) || /^stems\//i.test(f.path)) continue;
    const fi = sourceNameInfo(f.name);
    // 短い音（同じ名前の SE など）は原曲ではない
    if (fi.drumless || f.size < b.size * 0.3 || nxSafeBase(fi.base, 'bgm').toLowerCase() !== want) continue;
    return f;
  }
  return null;
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
 * file は新しい原曲（曲フォルダの中のパス）。preview は試聴に入れる値（替えなければ null）。
 * drumless：新しい原曲がドラム抜きか（ステムのドラム以外を書き出した音など、作り方で分かるとき。無ければファイル名で見る）
 */
export function planBgmSwap(file: string, o: { drumless?: boolean } = {}): { preview: string | null; fullMix: string | null | undefined } {
  const s = useEditor.getState();
  const folder = s.folder;
  const oldBgm = bgmFileOf(s.doc, folder);
  const oldFull = fullMixFile(folder);
  const drumless = o.drumless ?? isDrumlessName(file);
  // 新しい原曲がドラム入りなら、それが完全な原曲。ドラム抜きなら、前の原曲（ドラム入り）を完全な原曲として覚えておく
  let fullMix: string | null | undefined;
  let full: string | null;
  if (!drumless) {
    // 覚えていた完全な原曲は、新しい原曲に替える（覚えていなければ、今の原曲がそれなので書かない）
    const remembered = useSidecar.getState().fullMix;
    fullMix = remembered && normPath(remembered) !== normPath(file) ? file : undefined;
    full = file;
  } else {
    // 前の原曲が DTXMania の曲の BGM の名前（bgm.ogg・bgm_d.ogg）なら、それもドラム抜きなので覚えない
    const prevFull = oldFull ?? (oldBgm && !isDrumlessName(oldBgm.name) && !isGameBgmName(oldBgm.name) ? oldBgm : null);
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

/** 分けた音（ステムの元）を、完全な原曲として覚える（ドラム抜きらしい音・DTXMania の曲の BGM の名前の音は覚えない） */
export function rememberSeparationSource(path: string) {
  if (isDrumlessName(path) || isGameBgmName(path)) return;
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

/** 開いている譜面の試聴（#PREVIEW）が空で、自動で入れてよいか（一度入れたのを空にしたなら入れない） */
export function previewFillable(): boolean {
  const s = useEditor.getState();
  if (s.screen !== 'editor' || (s.doc.fields['PREVIEW'] ?? '').trim()) return false;
  return !(filledFor && filledFor.folder === s.folder && filledFor.fileName === s.meta.fileName);
}

/** 開いている譜面に試聴を自動で入れたと覚える（あとで空にしたら、もう入れない） */
export function markPreviewFilled() {
  const s = useEditor.getState();
  filledFor = { folder: s.folder, fileName: s.meta.fileName };
}

/**
 * 試聴（#PREVIEW）が空なら、完全な原曲（ドラム入り）を入れる（NX は試聴が無いと選曲画面で何も鳴らさない）。
 * 同じく空だったほかの難易度にも入れて知らせる。入れたらそのパス。
 * 完全な原曲のファイルが無ければ入れない（ドラム抜きの音は試聴にしない。ステムや譜面のドラムから作るのは src/store/chorus.ts の fillPreviewFromChorus）
 */
export function fillPreview(full?: FolderFile | null): string | null {
  const s = useEditor.getState();
  if (!previewFillable()) return null;
  // full：音でも確かめた完全な原曲（src/store/chorus.ts の checkedFullOriginal。null ならドラム抜きと分かったので入れない）
  const f = full === undefined ? fullOriginal(s.doc, s.folder) : full;
  if (!f || !PREVIEW_EXT.test(f.name)) return null;
  const r = editSong(tr('試聴（#PREVIEW）に原曲を入れる', 'Use the original as the preview (#PREVIEW)'), (d) => setField(d, 'PREVIEW', f.path));
  if (!r.ok) return null;
  markPreviewFilled();
  void toastSongEdit(
    r,
    tr(
      `選曲画面の試聴（#PREVIEW）が空だったので、原曲「${f.path}」を入れました（DTXMania は試聴が無いと何も鳴らしません）。曲情報で変えられます`,
      `The song select preview (#PREVIEW) was empty, so it now uses the original "${f.path}" (DTXMania plays nothing without one). You can change it in Song info`,
    ),
    'info',
    9000,
    undefined,
    tr('試聴', 'preview'),
  );
  return f.path;
}
