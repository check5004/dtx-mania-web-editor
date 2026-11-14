// 譜面に書くファイル名を、NX で読める名前にする（Shift_JIS で保存・書き出しする前に）。
// NX は譜面を Shift_JIS で読むので、ファイル名に Shift_JIS で書けない文字があると「?」になり、その音・画像を読めない
// （選んだ試聴が鳴らない・ドラム抜きの BGM が鳴らない）。書ける名前（src/fs/nxName.ts）にファイルの名前を変え、
// どの難易度の譜面・作業ファイルも新しい名前を指すようにする。前に保存して「?」になってしまった名前も、
// 曲フォルダのファイルを見つけて（fs/folder の findFile）同じように直す。
// - 名前を変えるのは、譜面から指しているファイルだけ（ステムの stems/ の中は作業ファイルだけが指すので、そのまま）
// - 開いている譜面は履歴の中まで新しい名前にする（元に戻しても、もう無い名前に戻らない。名前の変更は履歴に積まない）
// - ほかの難易度と開いている難易度の譜面ファイルは、その行だけ書き換える（store/siblings の patchChart）
import { tr } from '../i18n';
import type { DtxDoc } from '../dtx/model';
import { setField } from '../edit/ops';
import { dtxFiles, findFile, isDiskFolder, normPath, putFile, removeFile, type FolderFile, type SongFolder } from '../fs/folder';
import { isNxSafeName, isNxSafePath, nxSafeName } from '../fs/nxName';
import { otherSongsIn } from '../fs/songDir';
import { readChart, patchChart, siblingWrites } from './siblings';
import { rewriteFieldValues, toast, useEditor } from './editor';
import { parseSidecar, serializeSidecar, sidecarData, sidecarName, updateSidecar, type SidecarData } from './sidecar';
import { fillPreview, previewFillable } from './fullMix';
import { checkedFullOriginal, fillPreviewFromChorus } from './chorus';

/** 譜面のうち、ファイル名を書く項目 */
const FILE_KEY =
  /^(?:(?:WAV|BMP|BMPTEX|AVI|VIDEO)[0-9A-Z]{2}|PREVIEW|PREIMAGE|PREMOVIE|STAGEFILE|BACKGROUND(?:_GR)?|WALL|RESULTIMAGE(?:_[A-Z]+)?|RESULTMOVIE(?:_[A-Z]+)?|RESULTSOUND(?:_[A-Z]+)?|SOUND_[A-Z]+|MIDIFILE)$/;

export const isFileField = (key: string) => FILE_KEY.test(key.toUpperCase());

/** その項目のファイルの場所の基準（#WAV は #PATH_WAV のフォルダから、ほかは曲フォルダから） */
const baseOf = (doc: Pick<DtxDoc, 'fields'>, key: string) => (/^WAV[0-9A-Z]{2}$/i.test(key) ? (doc.fields['PATH_WAV'] ?? '') : '');

/** 名前が無くなったときの名前（項目で決める） */
function fallbackOf(key: string): string {
  const k = key.toUpperCase();
  if (k === 'PREVIEW') return 'preview';
  if (/^WAV/.test(k)) return 'sound';
  if (/MOVIE|AVI|VIDEO/.test(k)) return 'movie';
  if (/SOUND|MIDI/.test(k)) return 'sound';
  return 'image';
}

const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i + 1) : '';
};
const nameOf = (p: string) => p.slice(dirOf(p).length);

/** 名前を変えるファイル（from の場所 → to の場所。同じなら、譜面の書き方だけ直す） */
export interface NxRename {
  from: string;
  to: string;
}

export interface NxNamesReport {
  renamed: NxRename[];
  /** 書き方だけ直した（ファイルはもう読める名前だった） */
  rewritten: number;
  /** 曲フォルダに見つからない、書けない名前（直せない） */
  missing: string[];
  /** 書き換えられなかった譜面（前の名前のファイルも残す） */
  failed: string[];
}

/** 名前を変える予定（曲フォルダの中のパスの小文字 → 新しいパス） */
type Plan = Map<string, { file: FolderFile; to: string }>;

/** 曲フォルダの中で空いている名前（同じ名前の別のファイルがあれば番号を付ける） */
function freeName(folder: SongFolder, dir: string, name: string, self: FolderFile, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const free = (n: string) => {
    const key = normPath(dir + n);
    if (taken.has(key)) return false;
    const f = folder.files.get(key);
    return !f || f === self;
  };
  if (free(name)) return name;
  for (let i = 2; i < 100; i++) if (free(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  return `${base}_${Date.now()}${ext}`;
}

/** 譜面のファイル名の項目（項目・値・場所の基準） */
function refsOf(doc: DtxDoc): { key: string; value: string; base: string }[] {
  const out: { key: string; value: string; base: string }[] = [];
  for (const [key, value] of Object.entries(doc.fields)) {
    if (!value || !isFileField(key)) continue;
    out.push({ key, value, base: baseOf(doc, key) });
  }
  return out;
}

/**
 * 譜面（開いている譜面と、曲フォルダのすべての譜面）から指しているファイルのうち、NX で読めない名前のものを、
 * どう変えるかを決める。書き方だけ違う（「?」になっている・前後に空白がある）ものも直す
 */
function planOf(folder: SongFolder, docs: DtxDoc[]): { plan: Plan; missing: string[] } {
  const plan: Plan = new Map();
  const missing = new Set<string>();
  const taken = new Set<string>();
  for (const doc of docs) {
    for (const r of refsOf(doc)) {
      const f = findFile(folder, r.value, r.base);
      if (!f) {
        if (!isNxSafePath(r.value)) missing.add(r.value);
        continue;
      }
      const key = normPath(f.path);
      if (plan.has(key)) continue;
      // フォルダの名前が読めない名前なら、ファイルの名前だけでは直せない
      const dir = dirOf(f.path);
      if (dir && !isNxSafePath(dir)) {
        missing.add(r.value);
        continue;
      }
      if (isNxSafeName(f.name)) {
        // ファイルは読める名前：書き方が違うだけなら、譜面の書き方を直す
        if (!isNxSafePath(r.value)) plan.set(key, { file: f, to: f.path });
        continue;
      }
      const name = freeName(folder, dir, nxSafeName(f.name, fallbackOf(r.key)), f, taken);
      taken.add(normPath(dir + name));
      plan.set(key, { file: f, to: dir + name });
    }
  }
  return { plan, missing: [...missing] };
}

/** 譜面に書いてあったパス value（その譜面での場所の基準 base）を、名前を変えたあとの書き方にする。変えなければ null */
function newRef(folder: SongFolder, plan: Plan, value: string, base: string): string | null {
  const f = findFile(folder, value, base);
  const p = f ? plan.get(normPath(f.path)) : undefined;
  if (!p) return null;
  const next = dirOf(value) + nameOf(p.to);
  return next === value ? null : next;
}

/**
 * NX で遊ぶ譜面を保存・書き出しする前の用意。試聴（#PREVIEW）が空なら原曲を入れ（src/store/fullMix.ts）、
 * 完全な原曲のファイルが無ければ、ステムや譜面のドラムも足した曲の音のサビから作る（src/store/chorus.ts。DTX だけを書き出すときは作らない）。
 * Shift_JIS で書くなら（rename）譜面のファイル名を NX で読める名前にする
 */
export async function prepareForNx(opts: NxFixOptions & { rename?: boolean } = {}): Promise<void> {
  // 名前を先に直す（試聴には直した名前を入れ、知らせにも直した名前を出す）
  if (opts.rename !== false) await fixNxFileNames(opts);
  // ほかの難易度に入れ終わってから書き出す
  // 試聴が空のときだけ。完全な原曲は、ステムがあれば音でも確かめる（前の版で原曲の名前のまま書き出したドラム抜きを試聴にしない）
  if (!previewFillable()) return;
  if (fillPreview(await checkedFullOriginal()) || (!opts.dtxOnly && (await fillPreviewFromChorus()))) await siblingWrites();
}

let running: Promise<NxNamesReport | null> | null = null;

export interface NxFixOptions {
  /** 知らせない */
  quiet?: boolean;
  /** DTX だけを書き出す（名前を変えたファイルも NX の曲フォルダに入れるよう知らせる） */
  dtxOnly?: boolean;
}

/**
 * Shift_JIS で保存・書き出しする前に、譜面のファイル名を NX で読める名前にする（曲フォルダのファイルの名前を変え、
 * 開いている譜面・ほかの難易度の譜面・作業ファイルを新しい名前にする）。直すものが無ければ null。
 * 直したら知らせる（quiet なら知らせない）
 */
export function fixNxFileNames(opts: NxFixOptions = {}): Promise<NxNamesReport | null> {
  // 続けて呼ばれたら（書き出しの用意を何度もし直すなど）、前のが終わってから見直す
  const p = (running ?? Promise.resolve(null)).then(
    () => doFix(opts),
    () => doFix(opts),
  );
  running = p.finally(() => {
    if (running === p) running = null;
  });
  return p;
}

async function doFix(opts: NxFixOptions): Promise<NxNamesReport | null> {
  const folder = useEditor.getState().folder;
  if (!folder) return null;
  // ほかの曲も入ったフォルダ（DTXFiles など）の中は書き換えない（保存では、この曲だけのフォルダへ移してから直す）
  if (isDiskFolder(folder) && otherSongsIn(folder).length) return null;
  // ほかの難易度の書き換え（原曲・曲情報をそろえる）が終わってから
  await siblingWrites();
  const s = useEditor.getState();
  if (s.folder !== folder) return null;
  // 曲フォルダの譜面（保存していない続きがあればそちら）。開いている譜面は今の中身も見る
  const charts: { file: FolderFile; doc: DtxDoc }[] = [];
  for (const f of dtxFiles(folder)) {
    const doc = await readChart(folder, f);
    if (doc) charts.push({ file: f, doc });
  }
  const { plan, missing } = planOf(folder, [s.doc, ...charts.map((c) => c.doc)]);
  if (plan.size === 0) return null;

  // 1. 新しい名前のファイルを置く（前の名前のファイルは、譜面を書き換えてから消す）
  const renamed: NxRename[] = [];
  let rewritten = 0;
  for (const p of plan.values()) {
    if (p.to === p.file.path) {
      rewritten++;
      continue;
    }
    await putFile(folder, p.to, await p.file.getFile());
    renamed.push({ from: p.file.path, to: p.to });
  }

  // 2. 曲フォルダの譜面ファイル（と保存していない続き）を、その行だけ書き換える。開いている譜面のファイルも
  const failed: string[] = [];
  for (const c of charts) {
    const v = await patchChart(folder, c.file, (d) => {
      let changed = false;
      for (const r of refsOf(d)) {
        const next = newRef(folder, plan, r.value, r.base);
        if (next === null) continue;
        setField(d as Parameters<typeof setField>[0], r.key, next);
        changed = true;
      }
      return changed ? 'changed' : 'same';
    });
    if (v === 'failed') failed.push(c.file.name);
  }

  // 3. 開いている譜面（履歴の中も）
  if (useEditor.getState().folder === folder) {
    const doc = useEditor.getState().doc;
    rewriteFieldValues((key, value) => (isFileField(key) ? newRef(folder, plan, value, baseOf(doc, key)) : null));
  }

  // 4. 作業ファイル（ステム・完全な原曲）が指していれば、それも新しい名前に（開いている難易度は今の中身、ほかはファイル）
  const moved = new Map(renamed.map((r) => [normPath(r.from), r.to]));
  const mv = (p: string | null | undefined) => (p ? (moved.get(normPath(p)) ?? null) : null);
  const movedIn = (d: SidecarData): Partial<SidecarData> | null => {
    const patch: Partial<SidecarData> = {};
    if (d.stems.some((t) => mv(t.file))) patch.stems = d.stems.map((t) => ({ ...t, file: mv(t.file) ?? t.file }));
    if (mv(d.analysisStem)) patch.analysisStem = mv(d.analysisStem);
    if (mv(d.fullMix)) patch.fullMix = mv(d.fullMix);
    return Object.keys(patch).length ? patch : null;
  };
  if (moved.size) {
    const mine = movedIn(sidecarData());
    if (mine && useEditor.getState().folder === folder) updateSidecar(mine);
    for (const c of charts) {
      if (c.file.name.toLowerCase() === useEditor.getState().meta.fileName.toLowerCase()) continue;
      const sf = findFile(folder, sidecarName(c.file.name));
      if (!sf) continue;
      try {
        const d = parseSidecar(await (await sf.getFile()).text());
        const p = d && movedIn(d);
        if (d && p) await putFile(folder, sf.path, new TextEncoder().encode(serializeSidecar({ ...d, ...p })));
      } catch {
        // 読めない作業ファイルはそのまま
      }
    }
  }

  // 5. 前の名前のファイルを消す（書き換えられなかった譜面があれば、その譜面のために残す。ステムはほかの難易度の作業ファイルが指すので残す）。
  // 開いている間は前の名前からも見つける（元に戻すで、ほかの難易度に前の名前が書かれても鳴る。次の保存で直る）
  folder.renamed ??= new Map();
  for (const r of renamed) folder.renamed.set(normPath(r.from), r.to);
  if (!failed.length) {
    for (const r of renamed) if (!/^stems\//i.test(r.from)) await removeFile(folder, r.from);
  }

  const report: NxNamesReport = { renamed, rewritten, missing, failed };
  if (!opts.quiet) toastNxNames(report, opts.dtxOnly);
  return report;
}

/** 直したことを知らせる（dtxOnly: DTX だけを書き出すとき） */
export function toastNxNames(r: NxNamesReport, dtxOnly = false) {
  if (!r.renamed.length && !r.rewritten) return;
  const sep = tr('、', ', ');
  const list = r.renamed
    .slice(0, 3)
    .map((x) => `${nameOf(x.from)} → ${nameOf(x.to)}`)
    .join(sep);
  const more = r.renamed.length > 3 ? tr(` ほか${r.renamed.length - 3}件`, ` and ${r.renamed.length - 3} more`) : '';
  const head = r.renamed.length
    ? tr(
        `DTXMania（Shift_JIS）で読めない文字があったので、ファイルの名前を変えました：${list}${more}。どの難易度の譜面も新しい名前にしています`,
        `Renamed files whose names DTXMania (Shift_JIS) can't read: ${list}${more}. Every difficulty now uses the new names`,
      )
    : tr('「?」になっていたファイル名を、曲フォルダのファイルの名前に直しました', 'Fixed file names that had turned into "?" to match the files in the song folder');
  const fail = r.failed.length ? tr(`。${r.failed.join(sep)} は書き換えられなかったので、前の名前のファイルも残しています`, `. Couldn't update ${r.failed.join(sep)}, so the old files are kept too`) : '';
  const only =
    dtxOnly && r.renamed.length
      ? tr('。DTX だけを渡すときは、名前を変えたファイルも DTXMania の曲フォルダに入れてください', '. If you hand over only the DTX, put the renamed files in the DTXMania song folder too')
      : '';
  toast(head + fail + only, r.failed.length ? 'warn' : 'ok', 10000);
}
