// 「DTXMania の曲」の一覧からすること：一覧を開く・曲を開く・AI難易度生成／曲情報を開く・set.def を作る／直す・試聴。
// 書くのは set.def を作る・直すときだけ（押して、中身を見せてから）。Google Drive には何も送らない。
import { tr } from '../i18n';
import { engine } from '../audio/engine';
import { autosaveNow, openSongDir } from '../app/fileActions';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import { parseSetDef } from '../fs/folder';
import { isSkipText, parseLink } from '../drive/sync';
import type { Difficulty } from '../gen/simplify';
import type { AuditionSound } from '../store/audition';
import { openPage, toast, useEditor } from '../store/editor';
import { initGen, selectDiff } from '../store/gen';
import { confirmDialog } from '../ui/dialogs';
import { fileAt } from './check';
import { LINK_NAME, type LibChart, type LibSong, type SlotKey } from './scan';
import { ensureNxPerm, refreshNxFolder, songDirOf } from './store';
import { canOpen, fixSetDef, setDefFor, SLOT_LABEL, sourceFor, topChart } from './view';

/** 一覧を開く（エディタからは、いまの譜面を自動保存の控えに残してから） */
export async function openNxPage(): Promise<void> {
  const s = useEditor.getState();
  if (s.screen === 'editor') {
    engine.stop();
    await autosaveNow();
  }
  useEditor.setState({ screen: 'songs', playing: false });
}

function folderName(s: LibSong): string {
  return s.path[s.path.length - 1] ?? s.title;
}

/** 許可を取って曲のフォルダを探す（押した操作の中で呼ぶ）。無ければ知らせて null */
async function dirFor(s: LibSong): Promise<FileSystemDirectoryHandle | null> {
  if (!(await ensureNxPerm())) {
    toast(tr('フォルダの読み書きが許可されませんでした', 'Reading and writing the folder was not allowed'), 'warn');
    return null;
  }
  const dir = await songDirOf(s);
  if (!dir) toast(tr(`「${folderName(s)}」フォルダが見つかりません。「読み直す」で一覧を新しくしてください`, `The "${folderName(s)}" folder wasn't found. Use "Reload" to refresh the list`), 'warn', 7000);
  return dir;
}

/** 曲を開く（いつもの「曲フォルダを開く」と同じ）。chart を渡すとその難易度。押した操作の中で呼ぶ */
export async function openNxSong(s: LibSong, chart?: LibChart): Promise<boolean> {
  const dir = await dirFor(s);
  if (!dir) return false;
  const c = chart ?? topChart(s);
  return openSongDir(dir, c && canOpen(c) ? c.file : undefined);
}

/**
 * 空いた難易度を AI難易度生成で作る：すぐ上の譜面を開いて、AI難易度生成でその難易度を選んだ状態にする。
 * k が null ならいちばん上の譜面から
 */
export async function openNxGen(s: LibSong, k: SlotKey | null): Promise<void> {
  const src = k ? sourceFor(s, k) : topChart(s);
  if (!src || !(await openNxSong(s, src))) return;
  openPage('ai');
  initGen();
  if (k && k !== 'MAS') selectDiff(SLOT_LABEL[k] as Difficulty);
}

/** 曲情報を開く（試聴・画像を入れる） */
export async function openNxSongInfo(s: LibSong): Promise<void> {
  if (await openNxSong(s)) openPage('songinfo');
}

async function writeIn(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes as Uint8Array<ArrayBuffer>);
  await w.close();
}

/** set.def の無い曲に set.def を作る（中身を見せてから。NX で難易度が 1 曲にまとまる） */
export async function makeNxSetDef(s: LibSong): Promise<void> {
  const text = setDefFor(s.title, s.charts);
  const { lost } = encodeDtx(text, 'shift_jis');
  const ok = await confirmDialog({
    title: tr('set.def を作ります', 'Create set.def'),
    body:
      tr(
        `「${folderName(s)}」フォルダに、この中身の set.def を書きます。NX で、難易度が 1 つの曲にまとまります。ほかのファイルは変えません。`,
        `A set.def with the content below is written in the "${folderName(s)}" folder. NX then shows the difficulties as one song. No other file is changed.`,
      ) +
      (lost.length ? tr(`\n\nShift_JIS で書けない字（${lost.join(' ')}）は「?」になります。`, `\n\nCharacters that Shift_JIS can't write (${lost.join(' ')}) become "?".`) : '') +
      `\n\n${text.trim()}`,
    ok: tr('作る', 'Create'),
  });
  if (!ok) return;
  const dir = await dirFor(s);
  if (!dir) return;
  try {
    if (await fileAt(dir, 'set.def')) {
      toast(tr('set.def はもうあります。一覧を読み直します', 'set.def is already there. Reloading the list'), 'info');
    } else {
      await writeIn(dir, 'set.def', encodeDtx(text, 'shift_jis').bytes);
      toast(tr(`set.def を作りました（${folderName(s)}）。NX を開いたままなら、NX の「Reload Songs」で出ます`, `Created set.def (${folderName(s)}). If NX is open, use "Reload Songs" in NX to see it`), 'ok', 7000);
    }
    await refreshNxFolder(s.root, s.path);
  } catch (e) {
    toast(tr(`set.def を書けませんでした: ${(e as Error).message}`, `Couldn't write set.def: ${(e as Error).message}`), 'error', 8000);
  }
}

/** set.def から、無い譜面の行を外す（どの行を外すか見せてから。文字コードは元のまま） */
export async function fixNxSetDef(s: LibSong): Promise<void> {
  const dir = await dirFor(s);
  if (!dir) return;
  try {
    const fh = await fileAt(dir, 'set.def');
    if (!fh) {
      await refreshNxFolder(s.root, s.path);
      return;
    }
    const dec = decodeDtx(new Uint8Array(await (await fh.getFile()).arrayBuffer()));
    const missing: string[] = [];
    for (const b of parseSetDef(dec.text)) for (const l of b.levels) if (!(await fileAt(dir, l.file))) missing.push(l.file);
    if (!missing.length) {
      toast(tr('set.def に書いた譜面はみんなあります', 'All the charts in set.def are there'), 'ok');
      await refreshNxFolder(s.root, s.path);
      return;
    }
    const ok = await confirmDialog({
      title: tr('set.def を直します', 'Fix set.def'),
      body: tr(
        `書いてあるのにフォルダに無い譜面の行を外します（ほかの行・ファイルは変えません）。\n\n${missing.join('\n')}`,
        `Removes the lines for charts that are listed but not in the folder (other lines and files stay as they are).\n\n${missing.join('\n')}`,
      ),
      ok: tr('直す', 'Fix'),
    });
    if (!ok) return;
    await writeIn(dir, fh.name, encodeDtx(fixSetDef(dec.text, missing), dec.encoding).bytes);
    toast(tr(`set.def を直しました（${folderName(s)}）`, `Fixed set.def (${folderName(s)})`), 'ok');
    await refreshNxFolder(s.root, s.path);
  } catch (e) {
    toast(tr(`set.def を直せませんでした: ${(e as Error).message}`, `Couldn't fix set.def: ${(e as Error).message}`), 'error', 8000);
  }
}

/**
 * この曲を Google Drive に送らない（保存しても送らない）・送るようにする。曲のフォルダのつなぎの記録（.dtxe-drive.json）に
 * 印を書く・消す。Drive とつないだ曲には使わない（つないだ曲は Drive の画面で消す）
 */
export async function setDriveSkip(s: LibSong, skip: boolean): Promise<void> {
  if (s.drive?.state === 'linked') return;
  const dir = await dirFor(s);
  if (!dir) return;
  try {
    // 一覧を読んだあとに Drive とつないだ（保存して送った）曲の記録は、上書きも消しもしない
    const fh = await fileAt(dir, LINK_NAME);
    const text = fh ? await (await fh.getFile()).text() : '';
    if (parseLink(text)) {
      await refreshNxFolder(s.root, s.path);
      return;
    }
    if (skip) await writeIn(dir, LINK_NAME, new TextEncoder().encode(JSON.stringify({ v: 1, skip: true })));
    else if (fh && isSkipText(text)) await dir.removeEntry(fh.name);
    toast(
      skip ? tr(`「${s.title}」は Google Drive に送りません`, `"${s.title}" won't be sent to Google Drive`) : tr(`「${s.title}」は、保存したときに Google Drive に送ります`, `"${s.title}" is sent to Google Drive when you save`),
      'ok',
    );
    await refreshNxFolder(s.root, s.path);
  } catch (e) {
    toast(tr(`変えられませんでした: ${(e as Error).message}`, `Couldn't change it: ${(e as Error).message}`), 'error');
  }
}

/** 試聴の音（#PREVIEW）。押したときだけ読む（試聴のボタンの中で。store/audition が先に出力を起こす） */
export function nxPreviewLoader(s: LibSong): () => Promise<AuditionSound | null> {
  return async () => {
    if (!s.preview) return null;
    const dir = await dirFor(s);
    const fh = dir && (await fileAt(dir, s.preview));
    if (!fh) return null;
    return { buf: await engine.decodeAudio(await (await fh.getFile()).arrayBuffer()) };
  };
}

/** 詳しい所の大きい画像（許可があるときだけ。無ければ小さい画像のまま） */
export async function nxImageUrl(s: LibSong): Promise<string | null> {
  if (!s.image) return null;
  try {
    const dir = await songDirOf(s);
    const fh = dir && (await fileAt(dir, s.image));
    if (!fh) return null;
    const f = await fh.getFile();
    // ブラウザが出せない形（TGA など）は小さい画像（作れていれば）のまま
    if (!/\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name) || f.size > 16 * 1024 * 1024) return null;
    return URL.createObjectURL(f);
  } catch {
    return null;
  }
}
