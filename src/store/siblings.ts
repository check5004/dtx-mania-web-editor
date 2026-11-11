// ほかの難易度（同じ曲フォルダの別の譜面）を書き換える仕組み。原曲（songBgm）・曲情報とテンポ（songSync）が使う。
// DTX では曲のもの（原曲・曲名・テンポなど）も難易度ごとの譜面に書くので、開いている難易度だけを書き換えると、
// 難易度によって分かれてしまう。
// - 書き換えるのは曲フォルダの譜面ファイルと、保存していない続き（自動保存の控え）。開いたときの文字コードのまま、
//   変わった行だけを書き換える（dtx/patchText。ほかの行・コメント・並びはそのまま）
// - 書き換えは1つずつ順に（元に戻す・やり直すを続けて押しても混ざらないように）。難易度を切り替える前に siblingWrites() で待つ
import { create } from 'zustand';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import type { DtxDoc } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { patchDtxText } from '../dtx/patchText';
import { dtxFiles, findFile, parseSetDef, putFile, type FolderFile, type SongFolder } from '../fs/folder';
import { draftFor, putRecent } from '../fs/recent';
import type { Draft } from 'immer';
import { edit, useEditor } from './editor';

const base = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

/** set.def に曲が2つ以上あるとき、開いている譜面とは別の曲の譜面（小文字のファイル名） */
async function otherSongFiles(folder: SongFolder, current: string): Promise<Set<string>> {
  const out = new Set<string>();
  const sd = findFile(folder, 'set.def');
  if (!sd) return out;
  try {
    const blocks = parseSetDef(decodeDtx(new Uint8Array(await (await sd.getFile()).arrayBuffer())).text);
    const mine = blocks.find((b) => b.levels.some((l) => base(l.file) === current.toLowerCase()));
    if (!mine) return out;
    const keep = new Set(mine.levels.map((l) => base(l.file)));
    for (const b of blocks) for (const l of b.levels) if (!keep.has(base(l.file))) out.add(base(l.file));
  } catch {
    // 読めない set.def は見ない
  }
  return out;
}

/**
 * 同じ曲のほかの難易度の譜面（曲フォルダの DTX。開いている譜面と、set.def で別の曲になっている譜面は除く）。
 * 並びは難易度のタブの順（BASIC → MASTER。タブに無い譜面はうしろ）
 */
export async function otherCharts(folder: SongFolder, current: string): Promise<{ file: FolderFile; label: string }[]> {
  const sibs = useEditor.getState().meta.siblings;
  const labels = new Map(sibs.map((x) => [x.file.toLowerCase(), x.label]));
  const order = new Map(sibs.map((x, i) => [x.file.toLowerCase(), i]));
  const rank = (f: FolderFile) => order.get(f.name.toLowerCase()) ?? sibs.length;
  const exclude = await otherSongFiles(folder, current);
  return dtxFiles(folder)
    .filter((f) => f.name.toLowerCase() !== current.toLowerCase() && !exclude.has(f.name.toLowerCase()))
    .sort((a, b) => rank(a) - rank(b))
    .map((f) => ({ file: f, label: labels.get(f.name.toLowerCase()) ?? f.name.replace(/\.dtx$/i, '') }));
}

/** ほかの難易度の譜面の今の中身（保存していない続きがあればそちら）。読めなければ null */
export async function readChart(folder: SongFolder, file: FolderFile): Promise<DtxDoc | null> {
  try {
    const draft = await draftFor(folder, file);
    return parseDtx(draft ? draft.text : decodeDtx(new Uint8Array(await (await file.getFile()).arrayBuffer())).text).doc;
  } catch {
    return null;
  }
}

/** 書き換えた結果（難易度のラベル） */
export interface SiblingReport {
  /** 書き換えた難易度 */
  changed: string[];
  /** 書き換えられなかった難易度（読めない・書けない・Shift_JIS で書けない・#PATH_WAV が違う） */
  failed: string[];
  /** 前から違うので、そのままにした難易度 */
  kept: string[];
  /** 書き換えた譜面のファイル名 */
  files: string[];
}

export const emptyReport = (): SiblingReport => ({ changed: [], failed: [], kept: [], files: [] });

export type ChartKind = 'file' | 'draft';

/** 1つの譜面への答え：変えた・変えない（もう同じ）・前から違う（そのまま）・書けない */
export type Verdict = 'changed' | 'same' | 'kept' | 'failed';

/**
 * ほかの難易度の譜面を1つ書き換える。保存していない続き（自動保存の控え）があればそちらが今の中身なので、
 * 続きで決め（続きを変えないなら、ファイルにも触らない）、続きとファイルの両方に fn を当てる。
 * ファイルは開いたときの文字コードのまま、変わった行だけを書き換える（ほかの行・コメント・並びはそのまま。
 * Shift_JIS で書けない文字が出たら書かない）
 */
export async function patchChart(folder: SongFolder, file: FolderFile, fn: (d: DtxDoc, kind: ChartKind) => Verdict): Promise<Verdict> {
  // 続きはファイルを書く前に見つける（書いたあとはファイルのほうが新しくなるため）
  const draft = await draftFor(folder, file);
  let draftDoc: DtxDoc | null = null;
  let verdict: Verdict = 'same';
  if (draft) {
    try {
      draftDoc = parseDtx(draft.text).doc;
    } catch {
      return 'failed';
    }
    verdict = fn(draftDoc, 'draft');
    if (verdict !== 'changed') return verdict;
  }
  let wrote = false;
  try {
    const dec = decodeDtx(new Uint8Array(await (await file.getFile()).arrayBuffer()));
    const doc = parseDtx(dec.text).doc;
    const v = fn(doc, 'file');
    if (v === 'changed') {
      const enc = encodeDtx(patchDtxText(dec.text, parseDtx(dec.text).doc, doc), dec.encoding);
      if (enc.lost.length) return 'failed';
      await putFile(folder, file.path, enc.bytes);
      wrote = true;
    }
    if (!draft) verdict = v;
  } catch {
    return 'failed';
  }
  if (draft && draftDoc) {
    // ファイルを書き直したら、続きをそれより新しくしておく（切り替えたときに続きから開くように）
    await putRecent({ ...draft, text: patchDtxText(draft.text, parseDtx(draft.text).doc, draftDoc), updatedAt: wrote ? Date.now() : draft.updatedAt });
  }
  return verdict;
}

// ほかの難易度の書き換えは1つずつ順に（元に戻す・やり直すを続けて押しても混ざらないように）
let chain: Promise<unknown> = Promise.resolve();
function queue<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job, job);
  chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** ほかの難易度の書き換えが終わるまで待つ（難易度を切り替えて読む前に） */
export function siblingWrites(): Promise<void> {
  return chain.then(() => undefined);
}

let afterWrite: (() => void) | null = null;
/**
 * ほかの難易度を書き換えたあとに呼ぶ（app/fileActions が、開いている難易度の自動保存を新しくする。
 * 書き換えた難易度の続きが「最近の曲」でいちばん新しくなり、曲を開き直すとそちらが開いてしまうのを防ぐ）
 */
export function setAfterSiblingWrite(fn: (() => void) | null) {
  afterWrite = fn;
}

/** ほかの難易度を書き換えるたびに増える（読み直し・反映済みの印の描き直し） */
export const useSiblingWrites = create<{ version: number }>(() => ({ version: 0 }));

/**
 * ほかの難易度の譜面を順に fn で書き換える（only: そのファイル名（小文字）だけ。関数なら、前の書き換えが終わって始めるときに決める）。
 * fn の id は「ファイル名（小文字）|file か draft」
 */
export function runSiblings(
  folder: SongFolder,
  current: string,
  fn: (d: DtxDoc, id: string) => Verdict,
  only?: ReadonlySet<string> | (() => ReadonlySet<string>),
): Promise<SiblingReport> {
  return queue(async () => {
    const rep = emptyReport();
    const pick = typeof only === 'function' ? only() : only;
    for (const t of await otherCharts(folder, current)) {
      const name = t.file.name.toLowerCase();
      if (pick && !pick.has(name)) continue;
      const v = await patchChart(folder, t.file, (d, kind) => fn(d, `${name}|${kind}`));
      if (v === 'changed') {
        rep.changed.push(t.label);
        rep.files.push(t.file.name);
      } else if (v === 'failed') rep.failed.push(t.label);
      else if (v === 'kept') rep.kept.push(t.label);
    }
    if (rep.changed.length) {
      afterWrite?.();
      useSiblingWrites.setState((s) => ({ version: s.version + 1 }));
    }
    return rep;
  });
}

/** ほかの難易度に入れた変更。done は最初の書き換え、revert・reapply は元に戻す・やり直す */
export interface SiblingChange {
  readonly done: Promise<SiblingReport>;
  /** 書き換えた難易度のラベル（done のあとに入る。元に戻したら空） */
  readonly labels: string[];
  revert(): Promise<SiblingReport>;
  reapply(): Promise<SiblingReport>;
  /**
   * ほかの難易度だけを元に戻し、これからは元に戻す・やり直すでも触らない（知らせの「この難易度だけにする」）。
   * 開いている難易度の変更はそのまま
   */
  detach(): Promise<SiblingReport>;
  /** detach した */
  readonly detached: boolean;
}

/**
 * ほかの難易度の譜面1つへの変更の仕方。apply は書き換えて元に戻すための控え（undo）を返す（変えなければ答えだけ）。
 * revert・reapply は、その譜面が今も書き換えたとき（戻したとき）のままなら戻す（やり直す）
 */
export interface SiblingSteps<U> {
  /** name はその譜面のファイル名（小文字） */
  apply(d: DtxDoc, name: string): { undo: U } | Exclude<Verdict, 'changed'>;
  revert(d: DtxDoc, u: U): boolean;
  /** やり直したら新しい控え。やり直せなければ null */
  reapply(d: DtxDoc, u: U): U | null;
}

/** ほかの難易度の譜面を steps で書き換え始める（元に戻す・やり直す・この難易度だけにする、を持つ） */
export function startSiblingChange<U>(folder: SongFolder, current: string, steps: SiblingSteps<U>): SiblingChange {
  const undos = new Map<string, U>();
  const labels: string[] = [];
  let detached = false;
  // 書き換えた譜面は、戻す・やり直すの番が来たときに見る（書き換えは順に進むので、最初の書き換えが終わる前に
  // Ctrl+Z を押しても、書き換え終わってから戻す）
  const touched = () => new Set([...undos.keys()].map((k) => k.split('|')[0]));
  const done = runSiblings(folder, current, (d, id) => {
    const r = steps.apply(d, id.split('|')[0]);
    if (typeof r === 'string') return r;
    undos.set(id, r.undo);
    return 'changed';
  }).then((rep) => {
    labels.splice(0, labels.length, ...rep.changed);
    return rep;
  });
  const revert = () =>
    runSiblings(
      folder,
      current,
      (d, id) => {
        const u = undos.get(id);
        return u !== undefined && steps.revert(d, u) ? 'changed' : 'same';
      },
      touched,
    ).then((rep) => {
      labels.length = 0;
      return rep;
    });
  const reapply = () =>
    runSiblings(
      folder,
      current,
      (d, id) => {
        const u = undos.get(id);
        const next = u === undefined ? null : steps.reapply(d, u);
        if (next === null) return 'same';
        undos.set(id, next);
        return 'changed';
      },
      touched,
    ).then((rep) => {
      labels.splice(0, labels.length, ...rep.changed);
      return rep;
    });
  return {
    done,
    labels,
    revert: () => (detached ? Promise.resolve(emptyReport()) : revert()),
    reapply: () => (detached ? Promise.resolve(emptyReport()) : reapply()),
    detach: () => {
      if (detached) return Promise.resolve(emptyReport());
      detached = true;
      return revert();
    },
    get detached() {
      return detached;
    },
  };
}

/**
 * ほかの難易度にも入れた変更を、入れる前に戻す編集（反映の「元に戻す」）。ほかの難易度も、そのとき書き換えたものを戻す
 * （この編集を Ctrl+Z で戻すと、ほかの難易度にもまた入れる）
 */
export function editBack(label: string, recipe: (d: Draft<DtxDoc>) => void, change: SiblingChange | null | undefined): boolean {
  const ok = edit(label, recipe, change ? { side: { undo: () => void change.reapply(), redo: () => void change.revert() } } : {});
  if (ok && change) void change.revert();
  return ok;
}
