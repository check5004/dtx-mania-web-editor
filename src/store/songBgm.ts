// 原曲（BGM）は曲のもの。けれど DTX では難易度（同じ曲フォルダの譜面）ごとに #WAV と BGM のチップ（ch01）を持つので、
// 開いている難易度だけを書き換えると、難易度によって鳴る原曲が分かれてしまう（NX でも難易度で BGM が変わり、
// エディタでは難易度を切り替えるたびに原曲・ステム・解析を読み直す）。
// - 原曲を替える操作（原曲の差し替え・ドラム抜きを BGM に・書き出して BGM に反映）は editBgm を通し、
//   同じ原曲を使っていたほかの難易度の譜面ファイル（と保存していない続き）も同じ原曲にする。Ctrl+Z・元に戻すで一緒に戻す
// - 既に分かれた曲は、原曲のカードに出し（useBgmSplit）、選んだ原曲にそろえる（alignBgm）
import type { Draft } from 'immer';
import { create } from 'zustand';
import { tr, isJa, locale } from '../i18n';
import { toBase36x2 } from '../dtx/base36';
import { cmp, type Frac } from '../dtx/fraction';
import { CH, type Chip, type DtxDoc } from '../dtx/model';
import { freeWavNumber, setField } from '../edit/ops';
import { findFile, joinPath, normPath, type SongFolder } from '../fs/folder';
import { chooseDialog } from '../ui/dialogs';
import { edit, lastHistory, prepareSounds, recordSide, toast, undoIfLast, useEditor, type HistoryEntry } from './editor';
import { glowReflected } from './glow';
import { editBack, emptyReport, otherCharts, readChart, siblingWrites, startSiblingChange, useSiblingWrites, type SiblingChange, type SiblingReport } from './siblings';

// 書き換えの仕組みは store/siblings（曲情報・テンポと共通）。前からの呼び出し元のために、ここからも出す
export { setAfterSiblingWrite, siblingWrites, type SiblingChange, type SiblingReport } from './siblings';

// ---- 譜面の原曲 -------------------------------------------------------------------

/** 原曲：最初の BGM チップ（ch01）の WAV 番号・その #WAV に書いてあるパス・チップの位置 */
export interface BgmOf {
  wav: number;
  /** #WAV に書いてあるパス（書いていなければ ''） */
  path: string;
  m: number;
  f: Frac;
}

/**
 * 譜面の原曲（最初の BGM チップ。同じ所にあれば先に書いたもの）。derived の bgmSource と同じ決め方だが、
 * ほかの難易度の譜面は読んでから書き換えるので、覚えておかない
 */
export function firstBgm(doc: Pick<DtxDoc, 'chips' | 'fields'>): BgmOf | null {
  let best: Chip | null = null;
  for (const c of doc.chips) {
    if (c.ch !== CH.BGM) continue;
    if (!best || c.m < best.m || (c.m === best.m && cmp(c.f, best.f) < 0)) best = c;
  }
  if (!best) return null;
  return { wav: best.v, path: doc.fields['WAV' + toBase36x2(best.v)] ?? '', m: best.m, f: best.f };
}

/** #PATH_WAV（比べるため、区切りと大文字・小文字をそろえる） */
export function pathWavOf(doc: Pick<DtxDoc, 'fields'>): string {
  return normPath(doc.fields['PATH_WAV'] ?? '').replace(/\/+$/, '');
}

/** 原曲のファイルの鍵：曲フォルダの中の場所（無ければ書いてあるパス）。NX と同じく大文字・小文字は見ない */
export function bgmKey(folder: SongFolder | null, doc: Pick<DtxDoc, 'fields'>, path: string): string {
  if (!path) return '';
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const f = findFile(folder, path, pathWav);
  return normPath(f ? f.path : joinPath(pathWav, path));
}

/** 原曲にするファイル。path は #PATH_WAV が pathWav の譜面に書くパス、file は曲フォルダの中の場所（分かれば） */
export interface BgmTarget {
  path: string;
  pathWav: string;
  file: string | null;
  /** 原曲のチップが無い譜面に置く位置 */
  m: number;
  f: Frac;
}

/** 譜面の今の原曲を、ほかの難易度に入れる先にする */
function targetOf(folder: SongFolder | null, doc: DtxDoc, b: BgmOf): BgmTarget {
  const f = findFile(folder, b.path, doc.fields['PATH_WAV'] ?? '');
  return { path: b.path, pathWav: pathWavOf(doc), file: f ? f.path : null, m: b.m, f: b.f };
}

/** その譜面（#PATH_WAV）に書くパス。書けない（#PATH_WAV が違って、同じファイルを指せない）なら null */
export function pathFor(to: BgmTarget, doc: Pick<DtxDoc, 'fields'>): string | null {
  const pw = pathWavOf(doc);
  if (pw === to.pathWav) return to.path;
  if (!to.file) return null;
  if (!pw) return to.file;
  return normPath(to.file).startsWith(`${pw}/`) ? to.file.slice(pw.length + 1) : null;
}

/** 前の原曲（元に戻すため）。file: 原曲の #WAV を差し替えた（前の値。無ければ undefined）、added: 原曲のチップと #WAV を足した */
export type BgmUndo = { kind: 'file'; wav: number; prev: string | undefined } | { kind: 'added'; wav: number; bgmWav: boolean };

/**
 * 譜面の原曲を path にする。原曲のチップがあればその WAV 番号のファイルを差し替え（鳴らし始める位置・音量はそのまま）、
 * 無ければ at の位置に原曲のチップと #WAV を足す。何も変えなければ null
 */
export function setBgmIn(d: Draft<DtxDoc> | DtxDoc, path: string, at: { m: number; f: Frac }): BgmUndo | null {
  const doc = d as Draft<DtxDoc>;
  const cur = firstBgm(doc);
  if (cur) {
    const key = 'WAV' + toBase36x2(cur.wav);
    const prev = doc.fields[key];
    if (prev === path) return null;
    setField(doc, key, path);
    return { kind: 'file', wav: cur.wav, prev };
  }
  const wav = freeWavNumber(doc) ?? 1;
  setField(doc, 'WAV' + toBase36x2(wav), path);
  const bgmWav = doc.fields['BGMWAV'] === undefined;
  if (bgmWav) setField(doc, 'BGMWAV', toBase36x2(wav));
  doc.chips.push({ id: doc.nextId++, ch: CH.BGM, m: at.m, f: at.f, v: wav });
  return { kind: 'added', wav, bgmWav };
}

/** setBgmIn の逆。原曲が今も path のとき（あとで別の原曲にしていない）だけ戻す */
export function restoreBgmIn(d: Draft<DtxDoc> | DtxDoc, u: BgmUndo, path: string): boolean {
  const doc = d as Draft<DtxDoc>;
  const cur = firstBgm(doc);
  if (!cur || cur.wav !== u.wav || normPath(cur.path) !== normPath(path)) return false;
  const key = 'WAV' + toBase36x2(u.wav);
  if (u.kind === 'file') {
    setField(doc, key, u.prev);
    return true;
  }
  for (let i = doc.chips.length - 1; i >= 0; i--) if (doc.chips[i].ch === CH.BGM && doc.chips[i].v === u.wav) doc.chips.splice(i, 1);
  if (!doc.chips.some((c) => c.v === u.wav)) setField(doc, key, undefined);
  if (u.bgmWav && doc.fields['BGMWAV'] === toBase36x2(u.wav)) setField(doc, 'BGMWAV', undefined);
  return true;
}

/** 戻したあとにもう一度（やり直す）：戻したときのままなら、また原曲を path にする */
export function redoBgmIn(d: Draft<DtxDoc> | DtxDoc, u: BgmUndo, path: string, at: { m: number; f: Frac }): BgmUndo | null {
  const cur = firstBgm(d);
  if (u.kind === 'file' ? !cur || cur.wav !== u.wav || d.fields['WAV' + toBase36x2(u.wav)] !== u.prev : cur) return null;
  return setBgmIn(d, path, at);
}

// ---- ほかの難易度 -----------------------------------------------------------------

/** 原曲と一緒に替えた試聴（#PREVIEW）：開いている譜面の前の値 → 新しい値 */
export interface PreviewMove {
  pre: string | undefined;
  post: string | undefined;
}

const pv = (v: string | undefined) => (v ?? '').trim();

/** 試聴を pre から post にする（今が pre のときだけ）。変えたら true */
function movePreview(d: DtxDoc, from: string | undefined, to: string | undefined): boolean {
  if (pv(d.fields['PREVIEW']) !== pv(from) || pv(from) === pv(to)) return false;
  setField(d as Draft<DtxDoc>, 'PREVIEW', to);
  return true;
}

/**
 * ほかの難易度の原曲を to にする（書き換えの仕組みは store/siblings）。match は、その難易度の今の原曲
 * （鍵。原曲が無ければ null）を書き換えるか。preview があれば、原曲を書き換えた難易度の試聴（#PREVIEW）も、
 * 開いている譜面と同じだったら同じに替える（試聴は原曲についてくる。src/store/fullMix.ts）
 */
function startBgmChange(folder: SongFolder, current: string, to: BgmTarget, match: (key: string | null) => boolean, preview?: PreviewMove): SiblingChange {
  return startSiblingChange<{ u: BgmUndo | null; path: string; preview: boolean }>(folder, current, {
    apply: (d) => {
      const b = firstBgm(d);
      if (!match(b ? bgmKey(folder, d, b.path) : null)) return 'kept';
      const path = pathFor(to, d);
      if (path === null) return 'failed';
      const u = setBgmIn(d, path, to);
      const moved = !!preview && movePreview(d, preview.pre, preview.post);
      return u || moved ? { undo: { u, path, preview: moved } } : 'same';
    },
    revert: (d, x) => {
      const a = !!x.u && restoreBgmIn(d, x.u, x.path);
      const b = x.preview && !!preview && movePreview(d, preview.post, preview.pre);
      return a || b;
    },
    reapply: (d, x) => {
      const u = x.u ? redoBgmIn(d, x.u, x.path, to) : null;
      const moved = x.preview && !!preview && movePreview(d, preview.pre, preview.post);
      return u || moved ? { u, path: x.path, preview: moved } : null;
    },
  });
}

// ほかの難易度を書き換えたら（原曲・曲情報・テンポ）、反映済みの印を描き直し、原曲を読み直す
useSiblingWrites.subscribe(() => {
  useSongBgm.setState((s) => ({ version: s.version + 1 }));
  scheduleScan();
});

// ---- 原曲を替える編集 ---------------------------------------------------------------

export interface BgmEdit {
  /** 開いている譜面を変えた */
  ok: boolean;
  /** 積んだ履歴（知らせの「元に戻す」に使う） */
  entry?: HistoryEntry;
  /** ほかの難易度の書き換え（原曲が同じままなら null） */
  siblings: SiblingChange | null;
}

/**
 * 原曲（BGM）を替える編集。開いている譜面は edit で変え（Ctrl+Z で戻せる）、ほかの難易度の譜面も同じ原曲にする
 * （Ctrl+Z・やり直すで一緒に戻す・また入れる）。
 * same: 替える前に同じ原曲を使っていた難易度だけ（原曲の差し替えなど）、all: 違う原曲の難易度すべて（そろえる）
 */
export function editBgm(label: string, recipe: (d: Draft<DtxDoc>) => void, scope: 'same' | 'all' = 'same'): BgmEdit {
  const s = useEditor.getState();
  const folder = s.folder;
  const before = firstBgm(s.doc);
  const fromKey = before ? bgmKey(folder, s.doc, before.path) : null;
  const previewBefore = s.doc.fields['PREVIEW'];
  let change: SiblingChange | null = null;
  const side = folder ? { undo: () => void change?.revert(), redo: () => void change?.reapply() } : undefined;
  const ok = edit(label, recipe, side ? { side } : {});
  if (!ok) return { ok, siblings: null };
  const entry = lastHistory();
  const doc = useEditor.getState().doc;
  const after = firstBgm(doc);
  if (!folder || !after) return { ok, entry, siblings: null };
  const toKey = bgmKey(folder, doc, after.path);
  if (scope === 'same' && toKey === fromKey) return { ok, entry, siblings: null };
  // 一緒に替えた試聴（#PREVIEW）も、原曲を替える難易度で同じだったら替える
  const preview = pv(previewBefore) !== pv(doc.fields['PREVIEW']) ? { pre: previewBefore, post: doc.fields['PREVIEW'] } : undefined;
  change = startBgmChange(folder, s.meta.fileName, targetOf(folder, doc, after), scope === 'same' ? (k) => k === fromKey : (k) => k !== toKey, preview);
  return { ok, entry, siblings: change };
}

/**
 * editBgm で替えた原曲を、替える前に戻す編集（反映の「元に戻す」）。ほかの難易度も、そのとき書き換えたものを戻す
 * （この編集を Ctrl+Z で戻すと、ほかの難易度もまた入れる）
 */
export function editBgmBack(label: string, recipe: (d: Draft<DtxDoc>) => void, change: SiblingChange | null | undefined): boolean {
  return editBack(label, recipe, change);
}

/** 知らせに足す、ほかの難易度のこと（何も無ければ ''） */
export function siblingNote(rep: SiblingReport | null | undefined): string {
  if (!rep) return '';
  const sep = tr('・', ', ');
  const out: string[] = [];
  if (rep.changed.length) out.push(tr(`ほかの難易度（${rep.changed.join(sep)}）も同じ原曲にしました`, `The other difficulties (${rep.changed.join(sep)}) now use it too`));
  if (rep.kept.length)
    out.push(
      tr(
        `${rep.kept.join(sep)} は前から別の原曲なので、そのままにしました（原曲のカードでそろえられます）`,
        `${rep.kept.join(sep)} already used a different original, so ${rep.kept.length === 1 ? 'it was' : 'they were'} left as is (you can align them on the Original card)`,
      ),
    );
  if (rep.failed.length) out.push(tr(`${rep.failed.join(sep)} の譜面は書き換えられませんでした`, `Couldn't update the chart of ${rep.failed.join(sep)}`));
  return out.length ? (isJa() ? `。${out.join('。')}` : `. ${out.join('. ')}`) : '';
}

// ---- 分かれた原曲を見つける・そろえる --------------------------------------------------------

/** ほかの難易度の原曲（読んだ譜面のもの。保存していない続きがあればそちら） */
export interface ChartBgm {
  file: string;
  label: string;
  /** 原曲のファイルの鍵（原曲が無ければ null） */
  key: string | null;
  /** 原曲をそろえる先にするとき */
  target: BgmTarget | null;
}

interface SongBgmState {
  /** 読んだときに開いていた曲と難易度 */
  folder: SongFolder | null;
  fileName: string;
  others: ChartBgm[];
  /** ほかの難易度を書き換えるたびに増える（反映済みの印の描き直し） */
  version: number;
}

export const useSongBgm = create<SongBgmState>(() => ({ folder: null, fileName: '', others: [], version: 0 }));

let scanSeq = 0;
/** 分かれていると知らせた曲（曲ごとに1回） */
const told = new WeakSet<SongFolder>();

/** ほかの難易度の原曲を読み直す（曲・難易度を開いた・難易度が増えた・ほかの難易度を書き換えた） */
export async function refreshSongBgms(): Promise<void> {
  const seq = ++scanSeq;
  const s = useEditor.getState();
  const folder = s.folder;
  const fileName = s.meta.fileName;
  if (!folder || s.screen !== 'editor') {
    if (useSongBgm.getState().folder) useSongBgm.setState({ folder: null, fileName: '', others: [] });
    return;
  }
  await siblingWrites();
  const others: ChartBgm[] = [];
  for (const t of await otherCharts(folder, fileName)) {
    // 読めない譜面は数えない
    const doc = await readChart(folder, t.file);
    if (!doc) continue;
    const b = firstBgm(doc);
    others.push({ file: t.file.name, label: t.label, key: b ? bgmKey(folder, doc, b.path) : null, target: b ? targetOf(folder, doc, b) : null });
  }
  const now = useEditor.getState();
  if (seq !== scanSeq || now.folder !== folder || now.meta.fileName !== fileName) return;
  const prev = useSongBgm.getState();
  useSongBgm.setState({ folder, fileName, others });
  // 同じ曲の別の難易度へ切り替えて、原曲が違ったら一度だけ知らせる（切り替えるたびに原曲を読み直すわけを伝える）
  const switched = prev.folder === folder && prev.fileName !== fileName;
  if (switched && !told.has(folder) && bgmGroups()) {
    told.add(folder);
    toast(
      tr(
        '難易度によって原曲（BGM）のファイルが違うため、切り替えるたびに原曲を読み直しています。NX でも難易度で鳴る BGM が変わります。',
        'The original (BGM) file differs between difficulties, so it is reloaded each time you switch. NX also plays a different BGM per difficulty.',
      ),
      'warn',
      12000,
      { label: tr('そろえる…', 'Align…'), run: () => void alignBgm() },
    );
  }
}

let scanTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void refreshSongBgms(), 30);
}

// 曲・難易度を開いた・難易度のタブが変わった（保存・AI難易度生成の反映）ら読み直す
useEditor.subscribe((s, prev) => {
  if (s.folder !== prev.folder || s.meta.fileName !== prev.meta.fileName || s.meta.siblings !== prev.meta.siblings || (s.screen === 'editor') !== (prev.screen === 'editor')) scheduleScan();
});

/** 同じ原曲を使う難易度のまとまり。current: 開いている難易度の原曲 */
export interface BgmGroup {
  key: string | null;
  /** ファイル名（原曲が無ければ ''） */
  name: string;
  labels: string[];
  current: boolean;
  target: BgmTarget | null;
}

/** 難易度ごとの原曲を、同じファイルどうしにまとめる（開いている難易度の原曲が先頭）。全部同じなら null */
export function groupBgms(cur: { label: string; key: string | null; target: BgmTarget | null }, others: readonly ChartBgm[]): BgmGroup[] | null {
  const groups: BgmGroup[] = [{ key: cur.key, name: cur.target ? (cur.target.path.split(/[\\/]/).pop() ?? '') : '', labels: [cur.label], current: true, target: cur.target }];
  for (const o of others) {
    const g = groups.find((x) => x.key === o.key);
    if (g) g.labels.push(o.label);
    else groups.push({ key: o.key, name: o.target ? (o.target.path.split(/[\\/]/).pop() ?? '') : '', labels: [o.label], current: false, target: o.target });
  }
  return groups.length > 1 ? groups : null;
}

/** 開いている難易度の原曲と、読んであるほかの難易度の原曲をまとめる（分かれていなければ・まだ読んでいなければ null） */
export function bgmGroups(st = useSongBgm.getState()): BgmGroup[] | null {
  const s = useEditor.getState();
  if (!s.folder || st.folder !== s.folder || st.fileName !== s.meta.fileName || !st.others.length) return null;
  const b = firstBgm(s.doc);
  const label = s.meta.siblings.find((x) => x.file.toLowerCase() === s.meta.fileName.toLowerCase())?.label ?? s.meta.fileName.replace(/\.dtx$/i, '');
  return groupBgms({ label, key: b ? bgmKey(s.folder, s.doc, b.path) : null, target: b ? targetOf(s.folder, s.doc, b) : null }, st.others);
}

/** 原曲が分かれているか（画面用。開いている譜面が変われば計算し直す） */
export function useBgmSplit(): BgmGroup[] | null {
  useEditor((s) => s.doc);
  useEditor((s) => s.folder);
  useEditor((s) => s.meta);
  const st = useSongBgm();
  return bgmGroups(st);
}

/** 原曲のファイルの更新日時（選ぶときの手がかり） */
async function fileDate(folder: SongFolder, path: string | null): Promise<string> {
  const f = path ? findFile(folder, path) : undefined;
  if (!f) return '';
  try {
    return new Date((await f.getFile()).lastModified).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * 分かれた原曲をそろえる：どのファイルにするかを選んでもらい、違う原曲の難易度をすべてそのファイルにする
 * （開いている難易度も。鳴らし始める位置と音量は難易度ごとのまま）。Ctrl+Z・知らせの「元に戻す」で戻せる
 */
export async function alignBgm(): Promise<boolean> {
  const s = useEditor.getState();
  const folder = s.folder;
  const groups = bgmGroups();
  if (!folder || !groups) return false;
  const choices = groups.filter((g) => g.key !== null && g.target);
  if (!choices.length) return false;
  const sep = tr('・', ', ');
  const dates = await Promise.all(choices.map((g) => fileDate(folder, g.target!.file)));
  const none = groups.find((g) => g.key === null);
  const pick = await chooseDialog({
    title: tr('どの原曲にそろえますか？', 'Which original should every difficulty use?'),
    body: tr(
      `難易度によって原曲（BGM）のファイルが違います。選んだファイルを、すべての難易度の BGM にします（鳴らし始める位置と音量は難易度ごとのまま）。${none ? `${none.labels.join(sep)} には原曲がないので、ほかの難易度と同じ所に置きます。` : ''}`,
      `The original (BGM) file differs between difficulties. The file you choose becomes the BGM of every difficulty (each keeps its own start position and volume).${none ? ` ${none.labels.join(sep)} ${none.labels.length === 1 ? 'has' : 'have'} no original, so it is placed where the other difficulties start it.` : ''}`,
    ),
    options: choices.map((g, i) => ({
      label: g.name || g.target!.path,
      sub: [
        g.current
          ? tr(`${g.labels.join(sep)} が使っています（開いている難易度）`, `Used by ${g.labels.join(sep)} (the open difficulty)`)
          : tr(`${g.labels.join(sep)} が使っています`, `Used by ${g.labels.join(sep)}`),
        dates[i] ? tr(`ファイルの日時 ${dates[i]}`, `File date ${dates[i]}`) : '',
      ]
        .filter(Boolean)
        .join(' · '),
      value: g,
    })),
  });
  const now = useEditor.getState();
  if (!pick || !pick.target || now.folder !== folder || now.meta.fileName !== s.meta.fileName) return false;
  const name = pick.name || pick.target.path;
  const label = tr(`原曲を ${name} にそろえる`, `Use ${name} as the original for every difficulty`);
  const curBgm = firstBgm(now.doc);
  // 原曲のチップが無い難易度に置く位置：開いている難易度の原曲の所（無ければ選んだ原曲の難易度の所）
  const to: BgmTarget = curBgm ? { ...pick.target, m: curBgm.m, f: curBgm.f } : pick.target;
  let entry: HistoryEntry | undefined;
  let change: SiblingChange | null = null;
  let failedHere = false;
  if (pick.current) {
    change = startBgmChange(folder, now.meta.fileName, to, (k) => k !== pick.key);
    const c = change;
    entry = recordSide(label, { undo: () => void c.revert(), redo: () => void c.reapply() });
  } else {
    const path = pathFor(to, now.doc);
    if (path === null) failedHere = true;
    else {
      const r = editBgm(label, (d) => void setBgmIn(d, path, to), 'all');
      entry = r.entry;
      change = r.siblings;
      void prepareSounds();
      glowReflected({ bgm: true });
    }
  }
  const rep = change ? await change.done : emptyReport();
  if (rep.files.length) glowReflected({ diffs: rep.files });
  const here = s.meta.siblings.find((x) => x.file.toLowerCase() === s.meta.fileName.toLowerCase())?.label ?? s.meta.fileName;
  const changed = [...(!pick.current && !failedHere ? [here] : []), ...rep.changed];
  const failed = [...(failedHere ? [here] : []), ...rep.failed];
  if (!changed.length) {
    toast(failed.length ? tr(`${failed.join(sep)} の譜面は書き換えられませんでした`, `Couldn't update the chart of ${failed.join(sep)}`) : tr('原曲はもうそろっています', 'The originals already match'), failed.length ? 'warn' : 'info', 7000);
    return false;
  }
  toast(
    tr(`${changed.join(sep)} の原曲を ${name} にしました`, `${changed.join(sep)} now ${changed.length === 1 ? 'uses' : 'use'} ${name} as the original`) +
      (failed.length ? tr(`。${failed.join(sep)} の譜面は書き換えられませんでした`, `. Couldn't update the chart of ${failed.join(sep)}`) : ''),
    'ok',
    9000,
    entry ? { label: tr('元に戻す', 'Undo'), run: () => void undoIfLast(entry) } : undefined,
  );
  return true;
}
