// 曲をどのフォルダに保存するかを決める（PC で曲フォルダを選ぶとき）。
// 選んだのが DTXFiles のような曲を集めたフォルダや、ほかの物が入ったフォルダなら、その中に曲のフォルダを作る（直下に広げない）。
// ほかの曲のフォルダ（譜面がある）を選んだら、混ぜないように聞く。見分け方は src/fs/songDir.ts。
import { tr } from '../i18n';
import { decidePlace, fewNames, lookAtFolder } from '../fs/songDir';
import { chooseDialog } from '../ui/dialogs';
import { useEditor } from '../store/editor';

export interface SongPlace {
  dir: FileSystemDirectoryHandle;
  /** 新しく作った（空の）フォルダ */
  created: boolean;
  /** 選んだフォルダの中に作った・使ったときの、選んだフォルダの名前 */
  parent?: string;
}

/** 名前の短い一覧（「a、b、c ほか 4 個」） */
export function fewText(list: readonly string[], max = 3): string {
  return fewNames(list, max, tr('、', ', '), (n) => tr(` ほか ${n} 個`, ` and ${n} more`));
}

/** フォルダを選ぶ（書き込み可）。やめたら null。操作の中で呼ぶ */
export async function pickDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker!({ id: 'dtx-song', mode: 'readwrite' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/**
 * 保存する場所を選んでもらい、曲のフォルダを決める。操作（タップ・クリック）の中で呼ぶ（フォルダ選択はその中でしか開けない）。
 * やめたら null
 */
export async function pickSongPlace(songName: string): Promise<SongPlace | null> {
  for (;;) {
    const dir = await pickDir();
    if (!dir) return null;
    const look = await lookAtFolder(dir);
    const how = decidePlace(look, songName);
    if (how === 'here') return { dir, created: false };
    if (how === 'inside') return makeSongDir(dir, songName);
    const c = await chooseDialog<'again' | 'here'>({
      title: tr(`「${dir.name}」はほかの曲のフォルダです`, `"${dir.name}" is another song's folder`),
      body: tr(
        `譜面（${fewText(look.charts)}）が入っています。ここに保存すると、2つの曲のファイルが混ざります。`,
        `It has charts (${fewText(look.charts)}). Saving here would mix the files of two songs.`,
      ),
      options: [
        {
          label: tr('別の場所を選び直す（おすすめ）', 'Choose another place (recommended)'),
          sub: tr('DTXMania の DTXFiles などを選ぶと、その中にこの曲のフォルダを作ります', 'Choose DTXFiles in DTXMania, for example, and a folder for this song is made inside it'),
          value: 'again',
        },
        { label: tr('同じ曲なので、ここに保存する', "It's the same song, so save here"), sub: tr('同じ名前のファイルは上書きします', 'Files with the same name are overwritten'), value: 'here' },
      ],
    });
    if (c === 'here') return { dir, created: false };
    if (c !== 'again') return null;
  }
}

function freeName(name: string, taken: Set<string>): string {
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** フォルダの中に曲のフォルダを作る。同じ名前のフォルダがあれば、空ならそれを使い、中身があれば聞く。やめたら null */
export async function makeSongDir(parent: FileSystemDirectoryHandle, name: string): Promise<SongPlace | null> {
  const taken = new Set<string>();
  for await (const [n] of parent.entries()) taken.add(n.toLowerCase());
  if (!taken.has(name.toLowerCase())) return { dir: await parent.getDirectoryHandle(name, { create: true }), created: true, parent: parent.name };
  let existing: FileSystemDirectoryHandle | null = null;
  try {
    existing = await parent.getDirectoryHandle(name);
  } catch {
    // 同じ名前のファイルがある
    existing = null;
  }
  const free = freeName(name, taken);
  if (existing) {
    const look = await lookAtFolder(existing);
    if (look.entries === 0) return { dir: existing, created: false, parent: parent.name };
    const c = await chooseDialog<'new' | 'same'>({
      title: tr(`「${parent.name}」に「${name}」フォルダがもうあります`, `"${parent.name}" already has a "${name}" folder`),
      body: look.charts.length ? tr(`譜面（${fewText(look.charts)}）が入っています。`, `It has charts (${fewText(look.charts)}).`) : tr('ファイルが入っています。', 'It has files in it.'),
      options: [
        { label: tr(`「${free}」を作って保存する`, `Make "${free}" and save there`), sub: tr(`「${name}」はそのまま残します`, `"${name}" is left as it is`), value: 'new' },
        { label: tr(`「${name}」に保存する（同じ曲なら）`, `Save into "${name}" (if it's the same song)`), sub: tr('同じ名前のファイルは上書きします', 'Files with the same name are overwritten'), value: 'same' },
      ],
    });
    if (!c) return null;
    if (c === 'same') return { dir: existing, created: false, parent: parent.name };
  }
  return { dir: await parent.getDirectoryHandle(free, { create: true }), created: true, parent: parent.name };
}

/**
 * 曲を集めたフォルダ（DTXFiles・box など）を開いたとき：中の曲のフォルダを選んでもらう。やめた・曲が無ければ null。
 * 曲を集めたフォルダを曲フォルダとして開くと、そこに曲のファイルを広げてしまうため
 */
export async function chooseSongDir(dir: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  useEditor.setState({ loading: tr(`「${dir.name}」の曲を探しています…`, `Looking for songs in "${dir.name}"…`) });
  let songs: string[];
  try {
    songs = (await lookAtFolder(dir, 500)).songs;
  } finally {
    useEditor.setState({ loading: null });
  }
  if (!songs.length) return null;
  const picked = await chooseDialog<string>({
    title: tr(`「${dir.name}」には曲のフォルダが ${songs.length} 個あります`, `"${dir.name}" has ${songs.length} song folders`),
    body: tr(
      '開く曲を選んでください。曲を集めたフォルダ（DTXFiles など）は、そのまま曲フォルダとしては開きません（保存したときに、ほかの曲と混ざらないように）。',
      "Choose the song to open. A folder that holds many songs (such as DTXFiles) isn't opened as a song folder itself, so saving doesn't mix it with other songs.",
    ),
    options: songs.map((p) => ({ label: p, value: p })),
  });
  if (!picked) return null;
  let h = dir;
  for (const part of picked.split('/')) h = await h.getDirectoryHandle(part);
  return h;
}
