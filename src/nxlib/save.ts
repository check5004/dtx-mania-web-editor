// 新しい曲を「DTXMania の曲」（覚えている DTXManiaNX）の中に保存する所を作る。
// 書くのは、選んだ BOX（または BOX の外）の中に作るこの曲のフォルダの中だけ。DTXFiles や BOX の直下には書かない
// （新しい BOX を作るときだけ、その BOX のフォルダと box.def を作る）。
import { tr } from '../i18n';
import { makeSongDir, type SongPlace } from '../app/songPlace';
import { encodeDtx } from '../dtx/encoding';
import { safeFolderName } from '../fs/songDir';
import { toast } from '../store/editor';
import { dirAt, fileAt } from './check';
import { boxKeyOf, type LibBox } from './scan';
import { addNxBox, ensureNxPerm, rootDirOf, useNxLib } from './store';
import { boxRel, boxRootKey, outsideRel } from './view';

export interface NxSaveSpot {
  /** BOX の鍵（'' は BOX の外） */
  box: string;
  /** BOX の外に新しく作る BOX の名前 */
  newBox?: string;
  /** この曲のフォルダの名前 */
  name: string;
}

export interface NxSongPlace extends SongPlace {
  /** 知らせに出す、入れた所（BOX の名前か、外のフォルダの名前） */
  label: string;
}

const LAST_KEY = 'dtxe.nxSaveBox';

/** 前に保存した BOX（無ければ ''） */
export function lastNxBox(): string {
  try {
    return localStorage.getItem(LAST_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberBox(key: string) {
  try {
    localStorage.setItem(LAST_KEY, key);
  } catch {
    // 覚えられなくても保存はできる
  }
}

/** 名前の同じフォルダ（大文字・小文字は見ない）。無ければ作る */
async function dirNamed(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  return (await dirAt(parent, [name])) ?? parent.getDirectoryHandle(name, { create: true });
}

/**
 * 保存する曲のフォルダを用意する（許可を聞く・BOX を作る・曲のフォルダを作る）。押した操作の中で呼ぶ。
 * 同じ名前のフォルダがあれば聞く（makeSongDir）。やめた・できなければ知らせて null
 */
export async function nxSongPlace(spot: NxSaveSpot): Promise<NxSongPlace | null> {
  if (!(await ensureNxPerm())) {
    toast(tr('DTXMania のフォルダの読み書きが許可されませんでした', "Reading and writing the DTXMania folder wasn't allowed"), 'warn', 6000);
    return null;
  }
  const st = useNxLib.getState();
  const place = st.place;
  if (!place) return null;
  const box = spot.box ? st.boxes.find((b) => b.key === spot.box) : undefined;
  const rootKey = box ? boxRootKey(box) : '';
  const root = await rootDirOf(rootKey);
  if (!root) {
    toast(tr('DTXMania の曲の場所が見つかりません。「DTXMania の曲」の画面で場所を選び直してください', "The DTXMania song folder wasn't found. Choose it again on the DTXMania songs screen"), 'warn', 8000);
    return null;
  }
  let parent: FileSystemDirectoryHandle;
  let label: string;
  if (box) {
    const d = await dirAt(root, boxRel(box));
    if (!d) {
      toast(tr(`BOX「${box.title}」のフォルダが見つかりません。一覧を読み直してください`, `The folder of the "${box.title}" BOX wasn't found. Reload the list`), 'warn', 8000);
      return null;
    }
    parent = d;
    label = box.title;
  } else {
    // BOX の外：いちばん目の場所（ゲームのフォルダそのものなら、その中の DTXFiles。無ければ作る）
    const rel = outsideRel(place, st.songs, st.boxes);
    parent = root;
    for (const n of rel) parent = await dirNamed(parent, n);
    label = parent.name;
    const name = spot.newBox ? safeFolderName(spot.newBox) : '';
    if (name) {
      const d = await dirNamed(parent, name);
      const dot = /^dtxfiles\./i.test(d.name);
      if (!dot && !(await fileAt(d, 'box.def'))) {
        const w = await (await d.getFileHandle('box.def', { create: true })).createWritable();
        await w.write(encodeDtx(`#TITLE ${spot.newBox!.trim()}\r\n`, 'shift_jis').bytes as Uint8Array<ArrayBuffer>);
        await w.close();
      }
      const path = [...rel, d.name];
      const b: LibBox = { key: boxKeyOf(rootKey, path), title: spot.newBox!.trim(), dirName: d.name, dot, parent: null, depth: 0, root: rootKey, path };
      addNxBox(b);
      parent = d;
      label = b.title;
      spot = { ...spot, box: b.key };
    }
  }
  const made = await makeSongDir(parent, spot.name);
  if (!made) return null;
  rememberBox(spot.box);
  return { ...made, label };
}
