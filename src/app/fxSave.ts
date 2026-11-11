// 保存のときのエフェクト（store/fx のカーブでチップごとに作った「かけた音」）。
// - 開いている譜面のかけた音は、fileActions の kitFilesNeeded が曲フォルダの fx/ に書き出す
// - 前から同じカーブだったほかの難易度にも、同じカーブを入れる（作業ファイルのカーブと、チップの音。音はその譜面で作る）。
//   知らせの「この難易度だけにする」で、ほかの難易度だけ元に戻す
// - どの譜面も使わなくなった、エディタが作ったかけた音（fx/ の決まった名前のファイル）は消す
import { tr } from '../i18n';
import { virtualSound } from '../audio/sounds';
import { toBase36x2 } from '../dtx/base36';
import { CH, type DtxDoc } from '../dtx/model';
import { FX_NAME_RE, type FxSide } from '../fx/model';
import { dtxFiles, findFile, joinPath, normPath, removeFile, writeFile, type FolderFile, type SongFolder } from '../fs/folder';
import { draftFor, putRecent } from '../fs/recent';
import { toast } from '../store/editor';
import { reconcileOther, warmLengthsOf } from '../store/fx';
import { glowReflected } from '../store/glow';
import { emptySidecar, parseSidecar, serializeSidecar, sidecarName } from '../store/sidecar';
import { readSidecarFor, recentSidecarOf } from '../store/sidecarFile';
import { otherCharts, readChart, startSiblingChange, type SiblingChange, type SiblingReport } from '../store/siblings';
import { joinSentences, onlyThisAction, songNoteParts } from '../store/songSync';

/** 比べるための形（キーの順をそろえる。点の無いカーブは数えず、点が 1 つも無ければ null と同じ＝エフェクトなし） */
export function canonFx(v: FxSide | null | undefined): string {
  const curves = v?.curves.filter((c) => c.points.length) ?? [];
  return JSON.stringify(v && curves.length ? { ...v, curves } : null, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

/** 曲フォルダにある、その譜面の作業ファイルのカーブ（無ければ null） */
async function folderFx(folder: SongFolder, fileName: string): Promise<FxSide | null> {
  const f = findFile(folder, sidecarName(fileName));
  if (!f) return null;
  try {
    return parseSidecar(await (await f.getFile()).text())?.fx ?? null;
  } catch {
    return null;
  }
}

/** 保存する前の、曲フォルダの作業ファイルのカーブ（ほかの難易度と同じだったかを比べる元）。曲フォルダが無ければ null */
export async function fxBeforeSave(folder: SongFolder | null, fileName: string): Promise<FxSide | null> {
  return folder?.dir ? folderFx(folder, fileName) : null;
}

const pathWavOf = (doc: Pick<DtxDoc, 'fields'>) => (doc.fields['PATH_WAV'] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/** 譜面のチップが使うかけた音で、曲フォルダにまだ無いもの（作って書き出す） */
export async function fxFilesFor(doc: DtxDoc, folder: SongFolder | null, onEach?: (i: number, n: number) => void): Promise<{ path: string; bytes: Uint8Array }[]> {
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const used = new Set(doc.chips.filter((c) => c.ch !== CH.BPM && c.ch !== CH.BPM_EX).map((c) => c.v));
  const want: string[] = [];
  const seen = new Set<string>();
  for (const no of used) {
    const p = doc.fields['WAV' + toBase36x2(no)];
    if (!p) continue;
    const rel = p.trim().replace(/\\/g, '/');
    if (!FX_NAME_RE.test(rel) || seen.has(rel.toLowerCase())) continue;
    seen.add(rel.toLowerCase());
    if (findFile(folder, rel, pathWav)) continue;
    want.push(rel);
  }
  const out: { path: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < want.length; i++) {
    onEach?.(i, want.length);
    const bytes = await virtualSound(want[i])?.bytes();
    if (bytes) out.push({ path: pathWavOf(doc) ? `${pathWavOf(doc)}/${want[i]}` : want[i], bytes });
  }
  return out;
}

/** 作業ファイルのカーブを書き換える（曲フォルダの作業ファイルと、保存していない続きの控え） */
async function writeSideFx(folder: SongFolder, file: FolderFile, fx: FxSide | null): Promise<void> {
  const name = sidecarName(file.name);
  const f = findFile(folder, name);
  let data = emptySidecar();
  if (f) {
    try {
      data = parseSidecar(await (await f.getFile()).text()) ?? data;
    } catch {
      // 読めなければ新しく作る
    }
  }
  if (f || fx) await writeFile(folder, f?.path ?? name, new TextEncoder().encode(serializeSidecar({ ...data, fx })));
  const draft = await draftFor(folder, file);
  if (draft?.sidecar) {
    const d = parseSidecar(draft.sidecar);
    if (d) await putRecent({ ...draft, sidecar: serializeSidecar({ ...d, fx }) });
  }
}

/** ほかの難易度のかけた音を作って書き出す（書き換えた譜面の分） */
async function writeSiblingFx(folder: SongFolder, names: readonly string[]): Promise<number> {
  let n = 0;
  for (const name of names) {
    const file = findFile(folder, name);
    if (!file) continue;
    const doc = await readChart(folder, file);
    if (!doc) continue;
    for (const f of await fxFilesFor(doc, folder)) {
      await writeFile(folder, f.path, f.bytes);
      n++;
    }
  }
  return n;
}

/** どの譜面も使わなくなった、エディタが作ったかけた音を消す（消した数） */
async function removeUnusedFx(folder: SongFolder, current: DtxDoc, currentName: string): Promise<number> {
  const refs = new Set<string>();
  const addRefs = (doc: DtxDoc) => {
    const base = doc.fields['PATH_WAV'] ?? '';
    for (const [k, v] of Object.entries(doc.fields)) if (/^WAV[0-9A-Z]{2}$/.test(k) && v) refs.add(normPath(joinPath(base, v.trim())));
  };
  addRefs(current);
  for (const f of dtxFiles(folder)) {
    if (f.name.toLowerCase() === currentName.toLowerCase()) continue;
    const doc = await readChart(folder, f);
    // 読めない譜面があれば、使っているかが分からないので消さない
    if (!doc) return 0;
    addRefs(doc);
  }
  let n = 0;
  for (const f of [...folder.files.values()]) {
    const key = normPath(f.path);
    const at = key.lastIndexOf('fx/');
    if (at < 0 || (at > 0 && key[at - 1] !== '/')) continue;
    if (!FX_NAME_RE.test(f.path.slice(at)) || refs.has(key)) continue;
    if (await removeFile(folder, f.path)) n++;
  }
  return n;
}

/** ほかの難易度へのカーブの入れ方（元に戻す・この難易度だけにする） */
interface FxUndo {
  name: string;
}

/**
 * 保存したあと（開いている譜面と作業ファイルを書いたあと）：前から同じカーブだったほかの難易度にも同じカーブを入れ、
 * 使わなくなったかけた音を消して知らせる。before は保存する前の曲フォルダのカーブ、after は保存したカーブ
 */
export async function afterSaveFx(folder: SongFolder | null, fileName: string, doc: DtxDoc, before: FxSide | null, after: FxSide | null): Promise<void> {
  if (!folder?.dir) return;
  try {
    let change: SiblingChange | null = null;
    let rep: SiblingReport | null = null;
    let written = 0;
    if (canonFx(before) !== canonFx(after)) {
      const sibs = await otherCharts(folder, fileName);
      // 前から同じカーブだった難易度（保存していない続きの作業ファイルも見る）
      const same = new Set<string>();
      const kept: string[] = [];
      for (const t of sibs) {
        const draft = await draftFor(folder, t.file);
        const { data } = await readSidecarFor(folder, t.file.name, recentSidecarOf(draft));
        if (canonFx(data?.fx ?? null) === canonFx(before)) {
          const d = await readChart(folder, t.file);
          if (d) await warmLengthsOf(d);
          same.add(t.file.name.toLowerCase());
        } else if (canonFx(data?.fx ?? null) !== canonFx(after)) kept.push(t.label);
      }
      if (same.size) {
        const pw = pathWavOf(doc).toLowerCase();
        change = startSiblingChange<FxUndo>(folder, fileName, {
          apply: (d, name) => {
            if (!same.has(name)) return 'same';
            if (pathWavOf(d).toLowerCase() !== pw) return 'failed';
            const next = reconcileOther(d, after);
            if (next) Object.assign(d, next);
            return { undo: { name } };
          },
          revert: (d) => {
            const next = reconcileOther(d, before);
            if (next) Object.assign(d, next);
            return true;
          },
          reapply: (d, u) => {
            const next = reconcileOther(d, after);
            if (next) Object.assign(d, next);
            return u;
          },
        });
        rep = await change.done;
        rep.kept.push(...kept);
        for (const name of rep.files) {
          const file = findFile(folder, name);
          if (file) await writeSideFx(folder, file, after);
        }
        written = await writeSiblingFx(folder, rep.files);
        if (rep.files.length) glowReflected({ diffs: rep.files });
      } else if (kept.length) {
        rep = { changed: [], failed: [], kept, files: [] };
      }
    }
    const removed = await removeUnusedFx(folder, doc, fileName);
    const parts = [...songNoteParts(rep, tr('エフェクトのカーブ', 'effect curves'))];
    if (rep?.changed.length && written) parts.push(tr(`その難易度のかけた音 ${written} 個も fx/ に書き出しました`, `Also wrote ${written} processed sounds for them to fx/`));
    if (removed) parts.push(tr(`どの譜面も使わなくなったかけた音 ${removed} 個を fx/ から消しました`, `Removed ${removed} processed sounds no chart uses any more from fx/`));
    if (!parts.length) return;
    const c = change;
    const only =
      c && rep?.changed.length
        ? onlyThisAction({
            done: c.done,
            get labels() {
              return c.labels;
            },
            revert: c.revert,
            reapply: c.reapply,
            detach: async () => {
              const r = await c.detach();
              for (const name of r.files) {
                const file = findFile(folder, name);
                if (file) await writeSideFx(folder, file, before);
              }
              return r;
            },
            get detached() {
              return c.detached;
            },
          })
        : undefined;
    toast(joinSentences(parts), rep?.failed.length ? 'warn' : 'ok', only ? 10000 : 6000, only);
  } catch (e) {
    toast(tr(`エフェクトの後片付けができませんでした: ${(e as Error).message}`, `Couldn't finish the effect clean-up: ${(e as Error).message}`), 'warn', 7000);
  }
}
