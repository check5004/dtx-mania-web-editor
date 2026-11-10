// エディタの状態。譜面の変更は immer のパッチで Undo/Redo できるようにする。
import { tr, pl, isJa } from '../i18n';
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { create } from 'zustand';
import { engine, type Mix, type SoundEvent, type WavSource } from '../audio/engine';
import { builtinFile, virtualSound } from '../audio/sounds';
import { IS_IOS, iosName, oggUnsupported } from '../platform';
import { toBase36x2, toMeasure } from '../dtx/base36';
import type { DtxEncoding } from '../dtx/encoding';
import { cmp, frac, type Frac } from '../dtx/fraction';
import { endMeasureOf, moveEndDecorations, naturalEndMeasure, solidEndMeasure } from '../dtx/end';
import { CH, DRUM_LANES, drumChannel, emptyDoc, type DtxDoc, type HeaderLine, type ParseWarning } from '../dtx/model';
import type { ChartOrigin } from '../dtx/origin';
import { MAX_MEASURES, type TempoMap } from '../dtx/timing';
import { audibleEnd } from '../audio/dsp';
import {
  freeWavNumber,
  makeClip,
  mostUsedWav,
  opDelete,
  opMove,
  opPaste,
  opPlace,
  opSetKind,
  setField,
  snapToGrid,
  type ClipItem,
  type Pos,
} from '../edit/ops';
import { opRelane, type AltMode } from '../edit/transform';
import { quantizeVel, velOfWav, wavVariant } from '../edit/velocity';
import { findFile, type SongFolder } from '../fs/folder';
import { shiftLane, useInputSettings } from '../input/settings';
import { applyLoopToEngine, carryAssistToDoc, loopSec, prepareStretch, resetAssistForDoc, slowNeeds, stretchReady, syncAnalysis, trackSimilar, useAssist } from './assist';
import { bgmSource, chipViews, clickTimes, playbackEvents, tempoOf, wavPan, wavSources, wavVolume } from './derived';
import { loadSidecar, sameSongSidecar, sameStemFiles, updateSidecar, useSidecar, withListening, type SidecarData } from './sidecar';
import { opDeleteMeasures, opInsertMeasures, shiftMeasure, type DeleteResult } from '../edit/measures';

enablePatches();

export type LeftTab = 'kit' | 'wav' | 'bga' | 'info' | 'header';

export interface DocMeta {
  fileName: string;
  encoding: DtxEncoding;
  encodingNote?: string;
  warnings: ParseWarning[];
  hasRandom: boolean;
  /** 同じフォルダの難易度（set.def のラベル付き）。origin は AI難易度生成で作った譜面か（dtx/origin） */
  siblings: { label: string; file: string; origin?: ChartOrigin }[];
  /** 最近の曲（自動保存）のキー */
  recentId?: string;
}

export interface HistoryEntry {
  label: string;
  redo: Patch[];
  undo: Patch[];
  /** 譜面の外（作業ファイルのセクションなど）も一緒に戻す・やり直す */
  side?: { undo: () => void; redo: () => void };
  /** 履歴に積んだ時刻 */
  at?: number;
  /** 同じ group の続けての編集は1つにまとめる（録音など） */
  group?: string;
}

export interface Toast {
  id: number;
  text: string;
  level: 'info' | 'ok' | 'warn' | 'error';
  /** 押せるボタン（「元に戻す」など）。押したら消える */
  action?: { label: string; run: () => void };
  /** 2つ目のボタン（「この難易度だけにする」など） */
  action2?: { label: string; run: () => void };
}

export interface ViewState {
  /** 1拍の高さ（px） */
  pxPerBeat: number;
  /** グリッド（全音符の分割数） */
  div: number;
  /** 画面の一番下に見えている拍 */
  scrollBeat: number;
  /** 再生中に画面を追いかける */
  follow: boolean;
}

/** エディタの中の画面 */
export type EditorPage = 'chart' | 'tempo' | 'settings' | 'stems' | 'library' | 'songinfo' | 'ai' | 'guideline';

export interface EditorState {
  screen: 'home' | 'editor';
  /** エディタの中の画面（譜面・テンポ合わせ・設定） */
  page: EditorPage;
  doc: DtxDoc;
  meta: DocMeta;
  folder: SongFolder | null;
  savedDoc: DtxDoc | null;
  /** 保存したときの履歴の数（保存のあとの変更を数える） */
  savedHistory: number;
  savedAt: number | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selection: number[];
  cursorBeat: number;
  view: ViewState;
  leftTab: LeftTab;
  /** 通常チャンネル → 置くときの WAV 番号 */
  laneWav: Record<number, number>;
  clipboard: ClipItem[];
  playing: boolean;
  loading: string | null;
  missingWavs: number[];
  toasts: Toast[];
  mix: Mix;
  previewOnPlace: boolean;
  /** 音の読み込みが終わるたびに増える（曲の長さの再計算用） */
  soundsVersion: number;
  /** 参照映像（YouTube）の長さ（秒）。分からなければ 0 */
  refVideoSec: number;
  /** 設定画面を開いたときに出す項目 */
  settingsSection?: string;
  /** 画面を閉じたときに戻る先（ガイドライン → AI難易度生成 など） */
  returnPage?: EditorPage;
}

const initialMeta: DocMeta = { fileName: 'new.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] };

export const useEditor = create<EditorState>(() => ({
  screen: 'home',
  page: 'chart',
  doc: emptyDoc(),
  meta: initialMeta,
  folder: null,
  savedDoc: null,
  savedHistory: 0,
  savedAt: null,
  past: [],
  future: [],
  selection: [],
  cursorBeat: 0,
  view: { pxPerBeat: 48, div: 16, scrollBeat: 0, follow: true },
  leftTab: 'kit',
  laneWav: {},
  clipboard: [],
  playing: false,
  loading: null,
  missingWavs: [],
  toasts: [],
  mix: engine.mix,
  previewOnPlace: true,
  soundsVersion: 0,
  refVideoSec: 0,
}));

const get = useEditor.getState;
const set = useEditor.setState;

export const isDirty = (s: EditorState) => s.doc !== s.savedDoc;

/**
 * 保存していない譜面の変更（新しい順の履歴の名前）。保存したあとに元に戻して、保存した所より前に戻ったときは undone に数を入れる。
 * 保存していなければ null
 */
export function unsavedChart(s: Pick<EditorState, 'doc' | 'savedDoc' | 'past' | 'savedHistory'> = get()): { labels: string[]; undone: number } | null {
  if (s.doc === s.savedDoc) return null;
  const n = s.past.length - s.savedHistory;
  if (n > 0) return { labels: s.past.slice(-n).map((h) => h.label).reverse(), undone: 0 };
  return { labels: [], undone: s.savedDoc ? Math.max(1, -n) : 0 };
}

// ---- 通知 ---------------------------------------------------------------------

let toastId = 0;
const toastTimers = new Map<number, number>();

export function toast(text: string, level: Toast['level'] = 'info', ms = 4000, action?: Toast['action'], action2?: Toast['action2']): number {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, text, level, action, action2 }] }));
  toastTimers.set(id, window.setTimeout(() => dismissToast(id), ms));
  return id;
}

export function dismissToast(id: number) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** 出ている知らせを書き換える（ms があれば、今から ms で消す）。もう消えていれば何もしないで false */
export function updateToast(id: number, patch: Partial<Omit<Toast, 'id'>>, ms?: number): boolean {
  if (!get().toasts.some((t) => t.id === id)) return false;
  set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  if (ms !== undefined) {
    clearTimeout(toastTimers.get(id));
    toastTimers.set(id, window.setTimeout(() => dismissToast(id), ms));
  }
  return true;
}

// ---- 読み込み -----------------------------------------------------------------

/** 譜面を開き直した回数（時間のかかる処理が、終わったときに同じ譜面のままか確かめる） */
export let openedDocs = 0;

export function openDocument(doc: DtxDoc, meta: DocMeta, folder: SongFolder | null, opts: { dirty?: boolean } = {}) {
  openedDocs++;
  engine.stop();
  const used = mostUsedWav(doc);
  const laneWav: Record<number, number> = {};
  for (const [ch, v] of used) laneWav[ch] = v;
  const views = chipViews(doc);
  // 最初のドラムチップが見えるあたりから表示する
  const firstDrum = views.find((v) => v.col >= 0);
  const startBeat = firstDrum ? Math.max(0, Math.floor(firstDrum.beat) - 4) : 0;
  set({
    screen: 'editor',
    page: 'chart',
    doc,
    meta,
    folder,
    savedDoc: opts.dirty ? null : doc,
    savedHistory: 0,
    savedAt: null,
    past: [],
    future: [],
    selection: [],
    cursorBeat: 0,
    view: { ...get().view, scrollBeat: startBeat },
    laneWav,
    playing: false,
    missingWavs: [],
  });
  resetAssistForDoc();
  loadSidecar(null);
  void prepareSounds();
}

/** テンポ from の拍 beat と同じ秒になる、テンポ to での拍（テンポが同じならそのまま） */
export function sameTimeBeat(from: TempoMap, to: TempoMap, beat: number): number {
  if (from === to) return beat;
  const b = to.secToBeat(from.beatToSec(beat));
  return Math.abs(b - beat) < 1e-6 ? beat : b;
}

/**
 * 途中から鳴らし続ける音（原曲・SE・ステム）：いつ・どの音を・どこへ（base）と音量。
 * スロー再生では伸ばした音を WAV 番号で引くので、番号も base に入れる
 */
function longSounds(doc: DtxDoc, folder: SongFolder | null): { e: SoundEvent; base: string; volume: number }[] {
  const src = new Map(wavSources(doc, folder).map((x) => [x.no, x]));
  const slow = engine.playing && engine.rate < 0.999;
  const out: { e: SoundEvent; base: string; volume: number }[] = [];
  for (const e of playbackEvents(heardDoc(doc))) {
    if (e.bus === 'drum') continue;
    const x = src.get(e.wav);
    out.push({ e, base: `${e.bus}|${e.sec.toFixed(4)}|${x ? `${x.key}|${x.pan}` : `#${e.wav}`}${slow ? `|${e.wav}` : ''}`, volume: x?.volume ?? -1 });
  }
  return out;
}

/**
 * 途中から鳴らし続ける音（原曲・SE・ステム）の置き方。同じなら、いま鳴っている音をそのまま使い続けられる
 * （違えば engine.spliceLong で違う音だけつなぎ替える）
 */
export function longSoundLayout(doc: DtxDoc, folder: SongFolder | null): string {
  // 同じ時刻の音は、譜面に書いた順で並ぶ（難易度で順が違うことがある）ので、並びは比べない
  return longSounds(doc, folder)
    .map((x) => `${x.base}|${x.volume}`)
    .sort()
    .join('\n');
}

/**
 * スロー再生のとき、今の位置（とループの頭）から鳴らす曲の音（原曲・SE・ステム）の伸ばした音がもうあるか。
 * 無い（難易度で原曲のファイルが違う）ときにつなぎ替えると、伸ばし終わるまで音が途切れる。
 * いま鳴らしている音（playing：置き方が同じもの。音量だけが違う SE も）は伸ばした音を鳴らし続けるので、見ない
 */
function stretchedNow(doc: DtxDoc, folder: SongFolder | null, playing: Set<string>): boolean {
  const rate = engine.rate;
  if (rate >= 0.999) return true;
  const at = [engine.currentSec() ?? 0, ...(engine.loop ? [engine.loop.from] : [])];
  const fresh = longSounds(doc, folder)
    .filter((x) => !playing.has(x.base))
    .map((x) => x.e);
  return [...slowNeeds(fresh, at, 0)].every(([wav, secs]) => secs.every((sec) => stretchReady(wav, rate, sec)));
}

/** 原曲（最初の BGM チップの音）のファイル。難易度を切り替えるとき、同じ曲の音かを比べる */
function originalKey(doc: DtxDoc, folder: SongFolder | null): string | null {
  const bgm = bgmSource(doc);
  if (!bgm) return null;
  return wavSources(doc, folder).find((x) => x.no === bgm.wav)?.key ?? null;
}

let switchSeq = 0;

/**
 * 同じ曲の別の難易度（同じフォルダの別の DTX）に切り替える。譜面を開き直す openDocument と違い、再生は止めない。
 * ▶・表示の位置・ループはそのまま（テンポが違えば同じ秒の所）。鳴らす譜面は、まだ鳴らしていない所から新しい譜面になる。
 * 聴く設定（ミックス）も引き継ぐ。原曲・SE の置き方や音量が違うときは、違う音だけを今の位置からクロスフェードでつなぎ替える。
 * sidecar は切り替え先の作業ファイル（無ければ null）。原曲が同じなら、ステム・参照映像などは今のものを使い続ける
 * （作業ファイルの無い譜面へは今の中身ごと。sameSongSidecar）。
 * もっと新しい切り替えが始まった（stale が true）ときはやめて false を返す
 */
export async function switchDocument(
  doc: DtxDoc,
  meta: DocMeta,
  sidecar: SidecarData | null,
  opts: { dirty?: boolean; stale?: () => boolean } = {},
): Promise<boolean> {
  const seq = ++switchSeq;
  const stale = () => seq !== switchSeq || !!opts.stale?.();
  if (engine.playing) {
    // 新しい譜面の音を先に読み込んでおく（切り替えた瞬間から、新しい譜面のチップが正しい音で鳴るように。
    // prepareSounds が読むものと同じだけ読んでおけば、譜面を替えたあとの音の表はすぐにできる）
    const sources = allWavSources(doc, get().folder);
    const wait = engine.uncached(sources) > 0;
    if (wait) set({ loading: tr('切り替える難易度の音を読み込んでいます…', 'Loading the sounds of the other difficulty…') });
    try {
      await engine.preload(sources);
    } finally {
      if (wait) set({ loading: null });
    }
    if (stale()) return false;
  }
  const s = get();
  const from = tempoOf(s.doc);
  const to = tempoOf(doc);
  const at = (b: number) => sameTimeBeat(from, to, b);
  const sameLong = longSoundLayout(s.doc, s.folder) === longSoundLayout(doc, s.folder);
  const playingLong = new Set(longSounds(s.doc, s.folder).map((x) => x.base));
  // 同じ原曲なら、ステム・解析に使うステム・参照映像を外さない（AI難易度生成で作った譜面は作業ファイルを持たない）
  const side = originalKey(s.doc, s.folder) === originalKey(doc, s.folder) ? sameSongSidecar(sidecar) : sidecar;
  const curStems = useSidecar.getState().stems;
  const nextStems = side?.stems ?? [];
  const sameStems = sameStemFiles(curStems, nextStems);
  // スペクトルに選んだ音：原曲などの譜面の音なら切り替え先にも同じ音があるか、ステムなら同じステムを同じずれで読むか
  const oldKeys = new Set(wavSources(s.doc, s.folder).map((x) => x.key));
  const newKeys = new Set(wavSources(doc, s.folder).map((x) => x.key));
  const sameStemAudio = sameStems && curStems.every((t) => nextStems.some((n) => n.file === t.file && n.offsetMs === t.offsetMs));
  const keepSpec = (key: string) => (oldKeys.has(key) ? newKeys.has(key) : sameStemAudio);
  const used = mostUsedWav(doc);
  const laneWav: Record<number, number> = {};
  for (const [ch, v] of used) laneWav[ch] = v;
  openedDocs++;
  // ループは譜面を替える前に新しい譜面の拍へ直す（譜面が替わるとエンジンのループを当て直すので）
  carryAssistToDoc(at, keepSpec);
  set({
    doc,
    meta,
    savedDoc: opts.dirty ? null : doc,
    savedHistory: 0,
    savedAt: null,
    past: [],
    future: [],
    selection: [],
    cursorBeat: Math.max(0, at(s.cursorBeat)),
    view: { ...s.view, scrollBeat: at(s.view.scrollBeat) },
    laneWav,
    missingWavs: [],
  });
  loadSidecar(sameStems ? withListening(side) : side);
  await prepareSounds();
  if (stale() || !engine.playing) return true;
  if (sameLong || stretchedNow(get().doc, get().folder, playingLong)) {
    // 原曲・SE の置き方や音量が違う（難易度ごとに SE の音量が違う譜面は多い）ときは、違う音だけを今の位置からつなぎ替える。
    // 新しい譜面の音の表（prepareSounds）ができた直後、次の予約より前に替える
    if (!sameLong) engine.spliceLong();
    // 曲の終わり（原曲の鳴り終わり）は新しい譜面の音を読み込んでから決まるので、止める所を合わせ直す
    engine.setEndSec(playEndSec(get().doc, playStartSec));
  } else {
    // スロー再生で、切り替え先の原曲を伸ばした音がまだ無い：伸ばしてから今の位置で鳴らし直す（準備中と出る）
    restartIfPlaying();
  }
  return true;
}

export function goHome() {
  engine.stop();
  set({ screen: 'home', page: 'chart', playing: false });
}

// ---- 編集と Undo ---------------------------------------------------------------

/**
 * 譜面を書き換える。変化が無ければ履歴に積まない。group が同じなら直前の履歴にまとめる。
 * 履歴は無制限（差分だけを持つので軽い）。side は譜面の外の変更を一緒に戻すためのもの。
 */
export function edit(
  label: string,
  recipe: (d: Draft<DtxDoc>) => void,
  opts: { group?: string; side?: HistoryEntry['side'] } = {},
): boolean {
  const s = get();
  const [next, redo, undo] = produceWithPatches(s.doc, recipe);
  if (redo.length === 0) return false;
  const last = s.past[s.past.length - 1];
  let past: HistoryEntry[];
  const at = Date.now();
  if (opts.group && last?.group === opts.group && s.future.length === 0 && !opts.side && !last.side) {
    past = [...s.past.slice(0, -1), { label, group: opts.group, redo: [...last.redo, ...redo], undo: [...undo, ...last.undo], at }];
  } else {
    past = [...s.past, { label, redo, undo, group: opts.group, side: opts.side, at }];
  }
  set({ doc: next, past, future: [] });
  return true;
}

/** 履歴の好きな時点へ戻る・進む（n = その時点までに残す履歴の数） */
export function jumpHistory(n: number) {
  const s = get();
  if (n < 0 || n > s.past.length + s.future.length || n === s.past.length) return;
  let doc = s.doc;
  const past = [...s.past];
  const future = [...s.future];
  const moved: HistoryEntry[] = [];
  while (past.length > n) {
    const h = past.pop()!;
    doc = applyPatches(doc, h.undo);
    h.side?.undo();
    future.push(h);
    moved.push(h);
  }
  while (past.length < n && future.length) {
    const h = future.pop()!;
    doc = applyPatches(doc, h.redo);
    h.side?.redo();
    past.push(h);
    moved.push(h);
  }
  set({ doc, past, future, selection: keepSelection(doc, s.selection) });
  if (moved.some(changesSounds)) void prepareSounds();
}

function keepSelection(doc: DtxDoc, sel: number[]): number[] {
  if (sel.length === 0) return sel;
  const ids = new Set(doc.chips.map((c) => c.id));
  return sel.filter((id) => ids.has(id));
}

export function undo() {
  const s = get();
  const h = s.past[s.past.length - 1];
  if (!h) return;
  const doc = applyPatches(s.doc, h.undo);
  h.side?.undo();
  set({ doc, past: s.past.slice(0, -1), future: [...s.future, h], selection: keepSelection(doc, s.selection) });
  if (changesSounds(h)) void prepareSounds();
}

/** いま積んだ履歴（反映など）。知らせの「元に戻す」で、その変更だけを戻すのに使う */
export function lastHistory(): HistoryEntry | undefined {
  return get().past[get().past.length - 1];
}

/** その変更がまだ履歴のいちばん上なら元に戻す。あとで別の変更をしていたら戻さずに知らせる */
export function undoIfLast(entry: HistoryEntry | undefined): boolean {
  if (!entry || lastHistory() !== entry) {
    toast(tr('あとで別の変更をしたので、ここからは戻せません（Ctrl+Z で順に戻せます）', 'Other changes were made after it, so it can’t be undone from here (step back with Ctrl+Z)'), 'warn', 6000);
    return false;
  }
  undo();
  return true;
}

export function redo() {
  const s = get();
  const h = s.future[s.future.length - 1];
  if (!h) return;
  const doc = applyPatches(s.doc, h.redo);
  h.side?.redo();
  set({ doc, future: s.future.slice(0, -1), past: [...s.past, h], selection: keepSelection(doc, s.selection) });
  if (changesSounds(h)) void prepareSounds();
}

/** 音の定義（#WAV・音量・パン・PATH_WAV）を変える履歴か。戻す・やり直すと、鳴らす音を読み直す（原曲の差し替えなど） */
const SOUND_FIELD = /^((WAV|VOLUME|WAVVOL|PAN|WAVPAN)[0-9A-Z]{2}|PATH_WAV)$/;
function changesSounds(h: HistoryEntry): boolean {
  if (/WAV|キット|音/.test(h.label)) return true;
  return [...h.undo, ...h.redo].some((p) => p.path[0] === 'fields' && (p.path.length === 1 || SOUND_FIELD.test(String(p.path[1]))));
}

/**
 * 譜面の外だけを変える操作（ほかの難易度の譜面ファイルなど）を履歴に積む。開いている譜面は変えないが、
 * Ctrl+Z・やり直す・知らせの「元に戻す」で一緒に戻せるようにする
 */
export function recordSide(label: string, side: NonNullable<HistoryEntry['side']>): HistoryEntry {
  const h: HistoryEntry = { label, redo: [], undo: [], side, at: Date.now() };
  set((s) => ({ past: [...s.past, h], future: [] }));
  return h;
}

// ---- チップの配置 ---------------------------------------------------------------

/** 今のキットのそのチャンネルの音（ファイル名）。キットの選択は store/kit が受け持つ（循環を避けるため関数で受け取る） */
let kitFileProvider: (ch: number) => string | null = (ch) => builtinFile('std', ch);
/** 今のキットのそのチャンネルの音（試し打ち用） */
export function currentKitFile(ch: number): string | null {
  return kitFileProvider(ch);
}

export function setKitFileProvider(fn: (ch: number) => string | null) {
  kitFileProvider = fn;
}

function findWavByPath(fields: Record<string, string>, file: string): number | null {
  let hit: number | null = null;
  for (const [k, v] of Object.entries(fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k) || v.toLowerCase() !== file.toLowerCase()) continue;
    const no = parseInt(k.slice(3), 36);
    // ベロシティ違い（#VOLUME 付き）より、そのままの音を選ぶ
    if (hit === null || (fields['VOLUME' + k.slice(3)] === undefined && fields['VOLUME' + toBase36x2(hit)] !== undefined)) hit = no;
  }
  return hit;
}

/** 置くチップの WAV 番号。レーンで使っている音、無ければ今のキットの音を登録する */
export function wavForChannel(d: Draft<DtxDoc>, ch: number): number {
  const info = drumChannel(ch);
  const base = info ? info.base : ch;
  const assigned = get().laneWav[base];
  if (assigned !== undefined && d.fields['WAV' + toBase36x2(assigned)] !== undefined) return assigned;
  const file = kitFileProvider(base);
  if (!file) return assigned ?? 1;
  // 同じキットの音がもう登録されていれば使う
  const had = findWavByPath(d.fields, file);
  if (had !== null) {
    set((s) => ({ laneWav: { ...s.laneWav, [base]: had } }));
    return had;
  }
  const no = freeWavNumber(d as DtxDoc) ?? 1;
  setField(d, 'WAV' + toBase36x2(no), file);
  set((s) => ({ laneWav: { ...s.laneWav, [base]: no } }));
  return no;
}

/** 置くベロシティ（ベロシティの操作は store/velocity が受け持つ。循環を避けるため関数で受け取る） */
let placeVelProvider: () => number = () => 100;
export function setPlaceVelProvider(fn: () => number) {
  placeVelProvider = fn;
}

export function placeChip(lane: number, alt: boolean, pos: Pos, vel?: number) {
  placeChips([{ lane, alt, pos, vel }], { select: true, preview: get().previewOnPlace });
}

export interface PlaceItem {
  lane: number;
  alt: boolean;
  pos: Pos;
  /** ベロシティ（1〜100）。省くと操作バーで選んでいるベロシティ */
  vel?: number;
}

/**
 * まとめてチップを置く（候補の採用・録音・キー入力）。
 * group を渡すと、同じ group の続けての操作は Undo 1回で戻せる。
 */
export function placeChips(items: readonly PlaceItem[], opts: { label?: string; group?: string; select?: boolean; preview?: boolean } = {}): number[] {
  if (items.length === 0) return [];
  const ids: number[] = [];
  let firstV = 0;
  const hadKit = Object.keys(get().doc.fields).length;
  const one = items[0];
  const def = DRUM_LANES[one.lane];
  const oneName = one.alt && def.altName ? def.altName : def.mainName;
  const label = opts.label ?? (items.length === 1 ? tr(`${oneName}を置く`, `Place ${oneName}`) : tr(`${items.length}個のチップを置く`, `Place ${items.length} chips`));
  const step = useInputSettings.getState().velStep;
  const defVel = placeVelProvider();
  edit(
    label,
    (d) => {
      for (const it of items) {
        const lane = DRUM_LANES[it.lane];
        const ch = it.alt && lane.alt !== undefined ? lane.alt : lane.main;
        const base = wavForChannel(d, ch);
        const v = wavVariant(d, base, quantizeVel(it.vel ?? defVel, step));
        if (!firstV) firstV = v;
        ids.push(opPlace(d, ch, it.pos, v));
      }
    },
    { group: opts.group },
  );
  if (opts.select && ids.length) set({ selection: ids });
  if (Object.keys(get().doc.fields).length !== hadKit) void prepareSounds();
  if (opts.preview && firstV) previewWav(firstV);
  return ids;
}

/** レーンのチップに使う WAV 番号（試し打ち用。譜面は変えない） */
export function wavForLane(lane: number, alt: boolean): number | null {
  const s = get();
  const def = DRUM_LANES[lane];
  const ch = alt && def.alt !== undefined ? def.alt : def.main;
  const assigned = s.laneWav[ch];
  if (assigned !== undefined && s.doc.fields['WAV' + toBase36x2(assigned)] !== undefined) return assigned;
  const file = kitFileProvider(ch);
  return file ? findWavByPath(s.doc.fields, file) : null;
}

/** 前の小節のドラムをこの小節に写す（Ctrl+D） */
export function duplicatePrevMeasure(m: number) {
  if (m <= 0) return;
  edit(tr(`小節 ${toMeasure(m - 1)} を ${toMeasure(m)} に複製`, `Copy measure ${toMeasure(m - 1)} to ${toMeasure(m)}`), (d) => {
    const src = d.chips.filter((c) => c.m === m - 1 && drumChannel(c.ch)).map((c) => ({ ch: c.ch, f: { ...c.f }, v: c.v }));
    for (let i = d.chips.length - 1; i >= 0; i--) if (d.chips[i].m === m && drumChannel(d.chips[i].ch)) d.chips.splice(i, 1);
    for (const c of src) d.chips.push({ id: d.nextId++, ch: c.ch, m, f: c.f, v: c.v });
  });
}

/** m 小節目の前に n 小節の空の小節を入れる（セクション・テンポのアンカー・自動で入れた小節の印もずらす） */
export function insertMeasures(m: number, n = 1): boolean {
  const before = useSidecar.getState();
  const sections = before.sections.map((x) => ({ ...x, m: shiftMeasure(x.m, m, n, 'insert')! }));
  const anchors = before.anchors.map((x) => ({ ...x, m: shiftMeasure(x.m, m, n, 'insert')! }));
  const auto = before.auto.map((x) => ({ ...x, m: shiftMeasure(x.m, m, n, 'insert')! }));
  let ok = false;
  const side = sideForMeasures(before, { sections, anchors, auto });
  edit(tr(`小節 ${toMeasure(m)} の前に ${n} 小節を挿入`, `Insert ${n} ${pl(n, 'measure')} before measure ${toMeasure(m)}`), (d) => {
    ok = opInsertMeasures(d, m, n);
  }, { side });
  if (ok) side.redo();
  else toast(tr('これ以上小節を増やせません（Z99 まで）', "Can't add more measures (the limit is Z99)"), 'error');
  return ok;
}

/** m 小節目から n 小節を消して詰める */
export function deleteMeasures(m: number, n = 1): DeleteResult {
  const before = useSidecar.getState();
  const sections = before.sections.flatMap((x) => {
    const to = shiftMeasure(x.m, m, n, 'delete');
    return to === null ? [] : [{ ...x, m: to }];
  });
  const anchors = before.anchors.flatMap((x) => {
    const to = shiftMeasure(x.m, m, n, 'delete');
    return to === null ? [] : [{ ...x, m: to }];
  });
  const auto = before.auto.flatMap((x) => {
    const to = shiftMeasure(x.m, m, n, 'delete');
    return to === null ? [] : [{ ...x, m: to }];
  });
  let res: DeleteResult = { removed: 0, kept: 0 };
  const side = sideForMeasures(before, { sections, anchors, auto });
  const changed = edit(tr(`小節 ${toMeasure(m)}${n > 1 ? `〜${toMeasure(m + n - 1)}` : ''} を削除`, `Delete measure${n > 1 ? 's' : ''} ${toMeasure(m)}${n > 1 ? `–${toMeasure(m + n - 1)}` : ''}`), (d) => {
    res = opDeleteMeasures(d, m, n);
  }, { side });
  if (changed) side.redo();
  return res;
}

type MeasureMarks = Pick<SidecarData, 'sections' | 'anchors' | 'auto'>;

function sideForMeasures(before: MeasureMarks, after: MeasureMarks): NonNullable<HistoryEntry['side']> {
  const b: MeasureMarks = { sections: before.sections, anchors: before.anchors, auto: before.auto };
  const same = JSON.stringify(b) === JSON.stringify(after);
  return {
    undo: () => {
      if (!same) updateSidecar({ ...b });
    },
    redo: () => {
      if (!same) updateSidecar({ ...after });
    },
  };
}

/** 指定位置・レーンのチップ（通常チップ）を探す */
export function chipAt(lane: number, alt: boolean, pos: Pos): number | null {
  const def = DRUM_LANES[lane];
  const ch = alt && def.alt !== undefined ? def.alt : def.main;
  for (const c of get().doc.chips) {
    if (c.ch === ch && c.m === pos.m && cmp(c.f, pos.f) === 0) return c.id;
  }
  return null;
}

export function openTempo() {
  stop();
  set({ page: 'tempo' });
}

export function openSettings(section?: string) {
  set({ page: 'settings', settingsSection: typeof section === 'string' ? section : undefined, returnPage: get().page === 'settings' ? get().returnPage : get().page });
}

export function backToChart() {
  const from = get().page;
  // ステム画面は再生を共有するので止めない
  if (from !== 'stems') stop();
  set({ page: 'chart' });
}

/** 譜面以外の画面を開く（ステム・ライブラリ・曲情報・AI など）。戻るボタンは開いた元の画面へ戻る */
export function openPage(page: EditorPage) {
  if (page === 'tempo') return openTempo();
  if (page !== 'stems' && page !== 'chart') stop();
  const from = get().page;
  set({ page, returnPage: from === 'chart' || from === page ? undefined : from });
}

/** 開いた元の画面へ戻る（譜面から開いたなら譜面へ） */
export function goBack() {
  const r = get().returnPage;
  if (r && r !== get().page && r !== 'chart') {
    set({ page: r, returnPage: undefined });
    return;
  }
  backToChart();
}

export function deleteChips(ids: readonly number[]) {
  if (ids.length === 0) return;
  const set_ = new Set(ids);
  edit(tr(`${ids.length}個のチップを消す`, `Delete ${ids.length} ${pl(ids.length, 'chip')}`), (d) => {
    opDelete(d, set_);
  });
  set((s) => ({ selection: s.selection.filter((id) => !set_.has(id)) }));
}

export function deleteSelection() {
  deleteChips(get().selection);
}

export function moveSelection(dBeat: Frac, dLane: number): boolean {
  const s = get();
  if (s.selection.length === 0) return false;
  const tempo = tempoOf(s.doc);
  let ok = false;
  edit(tr('チップを動かす', 'Move chips'), (d) => {
    ok = opMove(d, new Set(s.selection), tempo, dBeat, dLane, shiftLane);
  });
  return ok;
}

export function copySelection(): number {
  const s = get();
  const ids = new Set(s.selection);
  const chips = s.doc.chips.filter((c) => ids.has(c.id));
  if (chips.length === 0) return 0;
  set({ clipboard: makeClip(chips, tempoOf(s.doc)) });
  return chips.length;
}

export function cutSelection() {
  if (copySelection() > 0) deleteSelection();
}

/** 貼り付ける。atBeat を省くとカーソル（▶）の位置（右クリックのメニューからは右クリックした所） */
export function paste(atBeat0?: number) {
  const s = get();
  if (s.clipboard.length === 0) return;
  const tempo = tempoOf(s.doc);
  const at = snapToGrid(tempo, typeof atBeat0 === 'number' ? atBeat0 : s.cursorBeat, s.view.div);
  const atBeat = tempo.beatOfFrac(at.m, at.f);
  let ids: number[] = [];
  edit(tr(`${s.clipboard.length}個のチップを貼り付け`, `Paste ${s.clipboard.length} ${pl(s.clipboard.length, 'chip')}`), (d) => {
    ids = opPaste(d, s.clipboard, atBeat, tempo);
  });
  set({ selection: ids });
}

export function selectAll() {
  set((s) => ({ selection: chipViews(s.doc).filter((v) => v.col >= 0).map((v) => v.c.id) }));
}

export function setKind(kind: 'normal' | 'hidden' | 'nochip', ids0: readonly number[] = get().selection) {
  const ids = new Set(ids0);
  const label =
    kind === 'normal' ? tr('通常チップにする', 'Make normal chips') : kind === 'hidden' ? tr('不可視チップにする', 'Make invisible chips') : tr('音だけのチップにする', 'Make sound-only chips');
  edit(label, (d) =>
    opSetKind(d, ids, kind),
  );
}

/**
 * チップを lane へ移す（同じ時刻のまま）。alt: HHオープン・左バスドラムにするか（keep は今のまま）。
 * レーンや種類が変わったチップは、音もそのレーンの音にする（ベロシティは保つ）。移した先にあったチップは上書き
 */
export function relaneChips(ids0: readonly number[], lane: number, alt: AltMode = 'keep'): number {
  const ids = new Set(ids0);
  const def = DRUM_LANES[lane];
  if (!def || ids.size === 0) return 0;
  const before = new Map(get().doc.chips.filter((c) => ids.has(c.id)).map((c) => [c.id, c.ch]));
  const hadKit = Object.keys(get().doc.fields).length;
  const name = alt === 'alt' && def.altName ? def.altName : alt === 'main' && def.alt !== undefined ? def.mainName : def.name;
  let n = 0;
  edit(tr(`${ids.size === 1 ? 'チップ' : `${ids.size}個のチップ`}を${name}にする`, `Change ${ids.size === 1 ? 'chip' : `${ids.size} chips`} to ${name}`), (d) => {
    n = opRelane(d, ids, lane, alt);
    for (const c of d.chips) {
      if (!ids.has(c.id) || before.get(c.id) === c.ch) continue;
      const info = drumChannel(c.ch);
      if (!info) continue;
      c.v = wavVariant(d, wavForChannel(d, info.base), velOfWav(d.fields, c.v));
    }
  });
  if (Object.keys(get().doc.fields).length !== hadKit) void prepareSounds();
  return n;
}

export function setSelectionWav(v: number) {
  const ids = new Set(get().selection);
  edit(tr('チップの音（WAV）を変える', 'Change chip sound (WAV)'), (d) => {
    for (const c of d.chips) if (ids.has(c.id) && drumChannel(c.ch)) c.v = v;
  });
}

export function setFieldValue(key: string, value: string | undefined, label = tr(`#${key} を変更`, `Change #${key}`)) {
  edit(label, (d) => setField(d, key, value));
  if (/^(WAV|VOLUME|PAN|WAVVOL|WAVPAN)[0-9A-Z]{2}$|^PATH_WAV$/i.test(key)) void prepareSounds();
}

export function setLaneWav(base: number, no: number | null) {
  set((s) => {
    const laneWav = { ...s.laneWav };
    if (no === null) delete laneWav[base];
    else laneWav[base] = no;
    return { laneWav };
  });
}

/** BPM を変える（#BPM ヘッダ。曲頭に ch08/ch03 のBPMチップがあればそれも合わせる） */
export function setInitialBpm(bpm: number, label = tr('BPMを変更', 'Change BPM')) {
  edit(label, (d) => {
    setField(d, 'BPM', String(bpm));
  });
}

/**
 * 小節長（拍子）を変える。NX では小節長が次の変更まで続くので、
 * 次の小節は今までの長さのままにして「この小節だけ」変わるようにする。
 */
export function setMeasureLength(m: number, len: number) {
  const doc = get().doc;
  const tempo = tempoOf(doc);
  const cur = tempo.barLen(m);
  if (cur === len) return;
  const prev = m > 0 ? tempo.barLen(m - 1) : 1;
  const nextOwn = doc.barLengths[m + 1];
  edit(tr(`小節${toMeasure(m)}の拍子を変更`, `Change the meter of measure ${toMeasure(m)}`), (d) => {
    if (len === prev) delete d.barLengths[m];
    else d.barLengths[m] = len;
    if (nextOwn === undefined && m + 1 < 3600) {
      if (cur === len) delete d.barLengths[m + 1];
      else d.barLengths[m + 1] = cur;
    } else if (nextOwn === len) {
      delete d.barLengths[m + 1];
    }
  });
}

/** BPM変化を置く（ch08 と #BPMzz を使う）。テンポは曲のものなので、画面からは store/songSync の placeSongBpm で置く */
export function placeBpmChange(pos: Pos, bpm: number) {
  edit(bpmChangeLabel(bpm), bpmChangeRecipe(pos, bpm));
}

export const bpmChangeLabel = (bpm: number) => tr(`BPM ${bpm} を置く`, `Place BPM ${bpm}`);

/** BPM変化を置く書き換え（同じ位置の BPM のチップは置き換える） */
export function bpmChangeRecipe(pos: Pos, bpm: number) {
  return (d: Draft<DtxDoc>) => {
    let no = -1;
    for (const [k, v] of Object.entries(d.fields)) {
      if (/^BPM[0-9A-Z]{2}$/.test(k) && Number(v) === bpm) no = parseInt(k.slice(3), 36);
    }
    if (no < 0) {
      for (let n = 1; n < 1296; n++) {
        if (d.fields['BPM' + toBase36x2(n)] === undefined) {
          no = n;
          break;
        }
      }
      setField(d, 'BPM' + toBase36x2(no), String(bpm));
    }
    for (let i = d.chips.length - 1; i >= 0; i--) {
      const c = d.chips[i];
      if ((c.ch === CH.BPM || c.ch === CH.BPM_EX) && c.m === pos.m && cmp(c.f, pos.f) === 0) d.chips.splice(i, 1);
    }
    d.chips.push({ id: d.nextId++, ch: CH.BPM_EX, m: pos.m, f: { n: pos.f.n, d: pos.f.d }, v: no });
  };
}

// ---- 表示 ---------------------------------------------------------------------

export function setView(v: Partial<ViewState>) {
  set((s) => ({ view: { ...s.view, ...v } }));
}

export function zoom(factor: number, anchorBeat?: number, anchorFromBottomPx?: number) {
  const s = get();
  const px = Math.max(10, Math.min(480, s.view.pxPerBeat * factor));
  if (anchorBeat !== undefined && anchorFromBottomPx !== undefined) {
    setView({ pxPerBeat: px, scrollBeat: Math.max(-1, anchorBeat - anchorFromBottomPx / px) });
  } else {
    setView({ pxPerBeat: px });
  }
}

export function setCursorBeat(beat: number) {
  set({ cursorBeat: Math.max(0, beat) });
}

// ---- 再生 ---------------------------------------------------------------------

let preparedSig = '';
let preparing: Promise<void> | null = null;

/**
 * 再生で鳴らすかもしれないほかの譜面（AI難易度生成で並べる、曲に既にある難易度）。開いている譜面と同じ WAV 番号の上に
 * 写してあり、足りない音だけ空いている番号に足してある。その音も一緒に読み込む
 */
const soundDocSources: (() => DtxDoc[])[] = [];
export function addSoundDocs(fn: () => DtxDoc[]): () => void {
  soundDocSources.push(fn);
  return () => {
    const i = soundDocSources.indexOf(fn);
    if (i >= 0) soundDocSources.splice(i, 1);
  };
}

function allWavSources(doc: DtxDoc, folder: SongFolder | null): WavSource[] {
  const out = wavSources(doc, folder);
  const seen = new Set(out.map((x) => x.no));
  for (const fn of soundDocSources) {
    for (const d of fn()) {
      for (const x of wavSources(d, folder)) {
        if (seen.has(x.no)) continue;
        seen.add(x.no);
        out.push(x);
      }
    }
  }
  return out.sort((a, b) => a.no - b.no);
}

export async function prepareSounds(): Promise<void> {
  const s = get();
  const sources = allWavSources(s.doc, s.folder);
  const own = new Set(wavSources(s.doc, s.folder).map((x) => x.no));
  const sig = sources.map((x) => `${x.no}:${x.key}:${x.volume}:${x.pan}`).join('|');
  if (sig === preparedSig && preparing) return preparing;
  preparedSig = sig;
  const p = (async () => {
    if (sources.length > 8) set({ loading: tr('音を読み込んでいます…', 'Loading sounds…') });
    try {
      const failed = await engine.prepare(sources, (done, total) => {
        if (total > 8 && done % 8 === 0) set({ loading: tr(`音を読み込んでいます… ${done}/${total}`, `Loading sounds… ${done}/${total}`) });
      });
      // 読めない音の知らせは、開いている譜面の音だけ
      if (preparedSig === sig) set({ missingWavs: failed.filter((no) => own.has(no)) });
      if (preparedSig === sig) warnOldSafariOgg(failed.filter((no) => own.has(no)).map((no) => s.doc.fields['WAV' + toBase36x2(no)] ?? ''));
    } finally {
      set((st) => ({ loading: null, soundsVersion: st.soundsVersion + 1 }));
      syncAnalysis();
    }
  })();
  preparing = p;
  return p;
}

let warnedOgg = false;

/** 18.4 より前の Safari（iPad・iPhone・Mac）は OGG を読めない。DTX の音はほとんど OGG なので、1 回だけ知らせる */
function warnOldSafariOgg(failedPaths: string[]) {
  if (warnedOgg || !oggUnsupported() || !failedPaths.some((p) => /\.ogg$/i.test(p))) return;
  warnedOgg = true;
  toast(
    IS_IOS
      ? iosName(
          tr(
            'この iPad の Safari は OGG の音を読めないため、曲の音が鳴りません（iPadOS 18.4 以降で読めます）。iPadOS を新しくするか、PC の Chrome をお使いください。',
            "This iPad's Safari can't read OGG audio, so the song's sounds won't play (iPadOS 18.4 or later can). Update iPadOS or use Chrome on a PC.",
          ),
        )
      : tr(
          'この Safari は OGG の音を読めないため、曲の音が鳴りません（Safari 18.4 以降で読めます）。Safari を新しくするか、Chrome をお使いください。',
          "This version of Safari can't read OGG audio, so the song's sounds won't play (Safari 18.4 or later can). Update Safari or use Chrome.",
        ),
    'error',
    15000,
  );
}

// Safari：再生を始めても音が出なかった（ブラウザが出力を止めている）。次に ▶ を押すと出力を作り直して鳴らす
engine.onStall = () => {
  toast(
    tr(
      '音を出せませんでした（ブラウザが音の出力を止めています）。もう一度 ▶ を押してください。続くときはページを開き直すか、Chrome をお使いください。',
      "Couldn't start the sound (the browser has paused audio output). Press ▶ again. If it keeps happening, reload the page or use Chrome.",
    ),
    'warn',
    9000,
  );
};

export function previewWav(no: number) {
  engine.ensure();
  if (engine.preview(no)) return;
  // 作ったばかりのベロシティ違いはまだ読み込まれていない：同じファイルの音をベロシティの比で鳴らす
  const fields = get().doc.fields;
  const path = fields['WAV' + toBase36x2(no)];
  if (path === undefined) return;
  for (const [k, v] of Object.entries(fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k) || v.toLowerCase() !== path.toLowerCase()) continue;
    const other = parseInt(k.slice(3), 36);
    if (other === no || !engine.has(other)) continue;
    engine.preview(other, velOfWav(fields, no) / Math.max(1, velOfWav(fields, other)));
    return;
  }
  // 譜面でまだ使っていない音は再生用に読み込んでいないので、その場で読み込んで鳴らす
  void previewFile(path, wavVolume(get().doc, no) / 100);
}

const previewCache = new Map<string, Promise<AudioBuffer | null>>();

/** ファイル（曲フォルダの音・標準キット・ライブラリの音）を読み込む。読めなければ null */
export async function fileBuffer(path: string): Promise<AudioBuffer | null> {
  const s = get();
  const f = findFile(s.folder, path, s.doc.fields['PATH_WAV'] ?? '');
  const vs = f ? null : virtualSound(path);
  if (!f && !vs) return null;
  const key = f ? `${s.folder?.name}|${f.path}|${f.size}|${f.ver ?? 0}` : `virtual:${vs!.sampleId ?? vs!.file.toLowerCase()}`;
  let p = previewCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        if (f) return await engine.decodeAudio(await (await f.getFile()).arrayBuffer());
        return await vs!.load();
      } catch {
        return null;
      }
    })();
    previewCache.set(key, p);
  }
  const buf = await p;
  if (!buf) previewCache.delete(key);
  return buf;
}

/** ファイル（曲フォルダの音・標準キット・ライブラリの音）を1回鳴らす。譜面は変えない */
export async function previewFile(path: string, gain = 1): Promise<boolean> {
  // 出力は押した操作の中（読み込みを待つ前）で用意する（Safari。docs/safari.md）
  engine.ensure();
  const buf = await fileBuffer(path);
  if (!buf) return false;
  engine.previewBuffer(buf, gain);
  return true;
}

/**
 * WAV 番号の音を試聴するときの音（store/audition に渡す）。#VOLUME・#PAN も譜面で鳴るのと同じにする。
 * 読み込んでいなければ、同じファイルのベロシティ違い（ベロシティの比で鳴らす）、それも無ければその場で読み込む
 */
export async function wavAuditionSound(no: number): Promise<{ buf: AudioBuffer; volume: number; pan: number; gain?: number } | null> {
  const loaded = engine.sound(no);
  if (loaded) return loaded;
  const doc = get().doc;
  const fields = doc.fields;
  const path = fields['WAV' + toBase36x2(no)];
  if (path === undefined) return null;
  for (const [k, v] of Object.entries(fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k) || v.toLowerCase() !== path.toLowerCase()) continue;
    const other = parseInt(k.slice(3), 36);
    const snd = other === no ? null : engine.sound(other);
    if (snd) return { ...snd, gain: velOfWav(fields, no) / Math.max(1, velOfWav(fields, other)) };
  }
  const buf = await fileBuffer(path);
  return buf ? { buf, volume: wavVolume(doc, no), pan: wavPan(doc, no) } : null;
}

// ---- 曲の終わり -------------------------------------------------------------------
// END の線。NX はここ（最後のチップの次の小節線）で演奏を終える。決めていなければ原曲の鳴り終わり（dtx/end.ts）。

const audibleCache = new Map<string, number>();

/** 読み込んだ音の鳴り終わり（秒。末尾のほぼ無音は数えない）。読み込んでいなければ 0 */
function audibleSec(no: number): number {
  const got = engine.buffer(no);
  if (!got) return 0;
  let v = audibleCache.get(got.key);
  if (v === undefined) {
    v = audibleEnd(got.buf);
    if (audibleCache.size > 64) audibleCache.clear();
    audibleCache.set(got.key, v);
  }
  return v;
}

/**
 * 原曲（BGM・ステム）が鳴り終わる、譜面の秒。分からなければ 0。
 * 参照映像（YouTube）は入れない（MV やライブは前後が長く、ずれも所ごとに違うので、曲の長さには使えない）
 */
export function audioEndSec(doc: DtxDoc): number {
  let end = 0;
  for (const e of playbackEvents(doc)) if (e.bus === 'bgm' || e.bus === 'stem') end = Math.max(end, e.sec + audibleSec(e.wav));
  if (end > 0) return end;
  // 音を読み込む前でも、解析が済んでいれば原曲の長さが分かる
  const bgm = bgmSource(doc);
  const a = useAssist.getState();
  if (bgm && a.data && a.src?.wav === bgm.wav) end = bgm.sec + a.data.duration;
  return end;
}

/** 拍 beat がある小節の次の小節（その小節の頭からほんの少し（1/50 小節）しか出ていなければ、その小節） */
function measureAfter(t: TempoMap, beat: number): number {
  const { m, pos } = t.locate(beat);
  return Math.max(1, pos <= 0.02 ? m : m + 1);
}

/** 曲の終わりを決めていないときの終わり（小節）。原曲が鳴り終わる小節。原曲の無い譜面は参照映像の終わり。分からなければ null */
export function autoEndMeasure(doc: DtxDoc): number | null {
  let sec = audioEndSec(doc);
  if (sec <= 0 && !bgmSource(doc)) {
    // 原曲ファイルが無く YouTube だけを聴いて作っているときは、映像の終わりまで（動画の秒 = 譜面の秒 + ずれ）
    const video = get().refVideoSec;
    if (video > 0) sec = video - (useSidecar.getState().youtube?.offset ?? 0);
  }
  if (sec <= 0) return null;
  const t = tempoOf(doc);
  return Math.min(MAX_MEASURES - 1, measureAfter(t, t.secToBeat(sec)));
}

/** 曲の終わり（END の線）の小節。最後のチップより前にはならない。何も分からなければ 0 */
export function songEndMeasure(doc: DtxDoc): number {
  return endMeasureOf(doc, doc.endMeasure === undefined ? autoEndMeasure(doc) : null);
}

/**
 * 曲の終わりがどう決まっているか。
 * set: 決めた位置（読み込んだ譜面の終わりも） / audio: 原曲の鳴り終わり / video: 参照映像の終わり / chips: 最後のチップのすぐ後
 */
export function songEndReason(doc: DtxDoc): 'set' | 'audio' | 'video' | 'chips' {
  const natural = naturalEndMeasure(doc);
  if (doc.endMeasure !== undefined) return doc.endMeasure >= natural ? 'set' : 'chips';
  const auto = autoEndMeasure(doc);
  if (auto === null || auto < natural) return 'chips';
  return audioEndSec(doc) > 0 ? 'audio' : 'video';
}

/** 曲の終わり（秒）。END の線（NX が演奏を終える所）。何も分からなければ 0 */
export function songEndSec(doc: DtxDoc): number {
  const m = songEndMeasure(doc);
  if (m <= 0) return 0;
  const t = tempoOf(doc);
  return t.beatToSec(t.measureStart(m));
}

/** 曲の終わりと原曲の鳴り終わりの遅い方（秒）。全体図・下のトラックの幅、END より後から再生したときに止める所 */
export function contentEndSec(doc: DtxDoc): number {
  return Math.max(songEndSec(doc), audioEndSec(doc));
}

/** 書き出す譜面。曲の終わりを決めていなければ、いま見えている終わり（原曲の鳴り終わり）を書き込む（NX でも同じ所で終わるように） */
export function withSongEnd(doc: DtxDoc): DtxDoc {
  if (doc.endMeasure !== undefined) return doc;
  const m = songEndMeasure(doc);
  return m > naturalEndMeasure(doc) ? { ...doc, endMeasure: m } : doc;
}

/** 曲の終わりにできる一番前の小節（最後のチップの次の小節。小節線の表示を切り替える C2 は一緒に動かすので数えない） */
export function minSongEnd(doc: DtxDoc): number {
  return Math.max(1, solidEndMeasure(doc));
}

/**
 * 曲の終わりを m 小節の頭にする。null なら原曲の鳴り終わりに合わせる（自動。原曲を差し替えても付いていく）。
 * 最後のチップより前にはできない（C2 の小節線の飾りは一緒に動かす）。動かした先の小節を返す。
 * group: ドラッグで続けて動かすときは Undo 1回で戻せるようにまとめる
 */
export function setSongEnd(m: number | null, opts: { group?: string } = {}): number {
  const doc = get().doc;
  const from = songEndMeasure(doc);
  const auto = m === null;
  const want = auto ? (autoEndMeasure(doc) ?? naturalEndMeasure(doc)) : Math.round(m);
  const to = Math.max(minSongEnd(doc), Math.min(MAX_MEASURES - 1, want));
  if (to === from && (auto ? doc.endMeasure === undefined : doc.endMeasure === to)) return to;
  const label = auto ? tr('曲の終わりを原曲に合わせる', 'Match the song end to the original') : tr(`曲の終わりを小節 ${toMeasure(to)} の頭にする`, `Set the song end to the start of measure ${toMeasure(to)}`);
  edit(
    label,
    (d) => {
      if (from > 0) moveEndDecorations(d as DtxDoc, from, to);
      if (auto) delete d.endMeasure;
      else d.endMeasure = to;
    },
    { group: opts.group },
  );
  return to;
}

/** 拍 beat にいちばん近い小節の頭（曲の終わりにできる範囲で） */
export function endMeasureNear(doc: DtxDoc, beat: number): number {
  const { m, pos } = tempoOf(doc).locate(Math.max(0, beat));
  return Math.max(minSongEnd(doc), Math.min(MAX_MEASURES - 1, pos >= 0.5 ? m + 1 : m));
}

/** END の線のドラッグ：拍 beat に近い小節の頭へ。原曲の鳴り終わりの所に来たら自動（原曲に合わせる）にする */
export function dragSongEnd(beat: number, group: string): number {
  const doc = get().doc;
  const m = endMeasureNear(doc, beat);
  return setSongEnd(m === autoEndMeasure(doc) ? null : m, { group });
}

const endWhat = (k: 'audio' | 'video' | 'chips' | 'set'): string =>
  ({
    audio: tr('原曲の鳴り終わり', 'where the original ends'),
    video: tr('参照映像の終わり', 'the end of the reference video'),
    chips: tr('最後のチップのすぐ後', 'right after the last chip'),
    set: '',
  })[k];

/** 決めた曲の終わりをやめて、自動（原曲の鳴り終わり。原曲が無ければ最後のチップのすぐ後）に戻す */
export function resetSongEnd() {
  const doc = get().doc;
  if (doc.endMeasure === undefined) {
    const what = endWhat(songEndReason(doc)) || endWhat('audio');
    toast(tr(`曲の終わりはいま自動（${what}）です。END の札をドラッグすると動かせます`, `The song end is automatic now (${what}). Drag the END tag to move it`));
    return;
  }
  const m = setSongEnd(null);
  const what = endWhat(songEndReason(get().doc));
  toast(
    isJa()
      ? `曲の終わりを${what || '自動'}（小節 ${toMeasure(m)} の頭）に合わせました`
      : `Set the song end to ${what || 'automatic'} (start of measure ${toMeasure(m)})`,
  );
}

/** 曲の終わりを ▶ の所にする（▶ のある小節の次の小節の頭。▶ が小節の頭ならそこ） */
export function songEndAtCursor() {
  const s = get();
  const want = measureAfter(tempoOf(s.doc), Math.max(0, s.cursorBeat));
  const m = setSongEnd(want);
  toast(
    m > want
      ? tr(`最後のチップより前にはできないので、小節 ${toMeasure(m)} の頭を曲の終わりにしました`, `It can't be before the last chip, so the song now ends at the start of measure ${toMeasure(m)}`)
      : tr(`曲の終わりを小節 ${toMeasure(m)} の頭にしました`, `The song now ends at the start of measure ${toMeasure(m)}`),
  );
}

/** 曲の終わりを最後のチップのすぐ後（その次の小節の頭）にする。原曲の後ろの余白を切るとき */
export function songEndAtLastChip() {
  const m = setSongEnd(minSongEnd(get().doc));
  toast(tr(`曲の終わりを最後のチップのすぐ後（小節 ${toMeasure(m)} の頭）にしました`, `The song now ends right after the last chip (start of measure ${toMeasure(m)})`));
}

/** 曲の長さが何も分からない（チップも原曲も映像も無い）ときに流し続ける長さ */
export const OPEN_END_SEC = 600;

/**
 * 再生を止める位置。曲の終わり（END）で止める。END より後から始めたときは原曲の鳴り終わりまで。
 * 何も無い譜面でも、止めるまで流し続ける（BPM合わせや曲の頭を探すため）
 */
export function playEndSec(doc: DtxDoc, startSec: number): number {
  const end = songEndSec(doc);
  if (end <= 0) return startSec + OPEN_END_SEC;
  if (startSec < end - 0.01) return end;
  return Math.max(contentEndSec(doc), startSec + 1);
}

type PlaybackEvent = { type: 'play'; startSec: number; rate: number } | { type: 'stop' } | { type: 'loop'; startSec: number };
const playbackListeners = new Set<(e: PlaybackEvent) => void>();

/** 再生の開始・停止・ループを知らせる（YouTube の同期に使う） */
export function onPlayback(cb: (e: PlaybackEvent) => void): () => void {
  playbackListeners.add(cb);
  return () => playbackListeners.delete(cb);
}

function emit(e: PlaybackEvent) {
  for (const cb of playbackListeners) cb(e);
}

/**
 * 鳴らす譜面を変えるもの（小節の生成の案を聴くときは案を入れた譜面、AI難易度生成では聴く難易度の譜面）。
 * 循環を避けるため関数で受け取る。足した順にかける。戻り値で外せる
 */
const playDocTransforms: ((doc: DtxDoc) => DtxDoc)[] = [];
export function addPlayDocTransform(fn: (doc: DtxDoc) => DtxDoc): () => void {
  playDocTransforms.push(fn);
  return () => {
    const i = playDocTransforms.indexOf(fn);
    if (i >= 0) playDocTransforms.splice(i, 1);
  };
}
function heardDoc(doc: DtxDoc): DtxDoc {
  let d = doc;
  for (const fn of playDocTransforms) d = fn(d);
  return d;
}

/** 鳴らす譜面が変わった（案を切り替えた・閉じた）。再生中なら、まだ鳴らしていない所から鳴らし直す */
export function refreshPlayback() {
  if (!engine.playing) return;
  const doc = get().doc;
  const end = Math.max(songEndSec(doc), engine.currentSec() ?? 0);
  engine.replaceEvents(playbackEvents(heardDoc(doc)), clickTimes(doc, 0, end + OPEN_END_SEC));
}

let playToken = 0;
/** スロー再生を始める前に、何秒先（聞こえる秒）までに鳴り始める曲の音を伸ばしておくか */
const SLOW_PREP_SEC = 2;
/** いまの再生を始めた位置（秒）。曲の終わりが動いたら止める所を直すため */
let playStartSec = 0;

/** ループがオンなら範囲の外からは再生しない（A から始める）。範囲の終わり B ちょうども外 */
function loopedStart(beat: number): number {
  const l = useAssist.getState().loop;
  if (!l || !l.on || l.b <= l.a) return beat;
  return beat < l.a - 1e-6 || beat > l.b - 1e-6 ? l.a : beat;
}

/**
 * beat から再生する。始めた位置を ▶（再生を始める位置）にするので、止めるとそこへ戻る。
 * keepStart: 速さ・ステム・テンポを変えたときの鳴らし直し。▶ は動かさない
 */
export async function playFrom(beat: number, opts: { keepStart?: boolean } = {}) {
  engine.ensure();
  halt();
  // 試聴は押したらすぐ止める（曲の準備を待たない）
  engine.stopAudition();
  const token = ++playToken;
  const startBeat = loopedStart(Math.max(0, beat));
  if (!opts.keepStart) set({ cursorBeat: startBeat });
  await prepareSounds();
  if (token !== playToken) return;
  const doc = get().doc;
  const tempo = tempoOf(doc);
  const a = useAssist.getState();
  const loop = loopSec(doc, a.loop);
  let startSec = tempo.beatToSec(startBeat);
  // ループ中は範囲の外から始めない（準備の間にループが変わったときのため秒でも確かめる）
  if (loop && (startSec < loop.from - 1e-6 || startSec >= loop.to)) startSec = loop.from;
  const endSec = playEndSec(doc, startSec);
  playStartSec = startSec;
  const rate = a.speed;
  const events = playbackEvents(heardDoc(doc));
  // スロー再生：始める所（とループの頭）で鳴っている曲の音（原曲・SE・ステム）と、すぐ鳴り始める音を先に伸ばしておく
  // （その先の音は、鳴らしながらエンジンが先に伸ばしておく）
  const needs = rate < 0.999 ? slowNeeds(events, [startSec, ...(loop ? [loop.from] : [])], SLOW_PREP_SEC * rate) : new Map<number, number[]>();
  if (needs.size > 0) {
    set({ loading: tr('スロー再生の準備中…', 'Preparing slow playback…') });
    try {
      await Promise.all([...needs].map(([wav, secs]) => prepareStretch(wav, rate, secs)));
    } catch (e) {
      toast(tr(`スロー再生の準備ができませんでした: ${(e as Error).message}`, `Couldn't prepare slow playback: ${(e as Error).message}`), 'error');
    } finally {
      set({ loading: null });
    }
    if (token !== playToken) return;
  }
  engine.play({
    events,
    clicks: clickTimes(doc, 0, endSec + 2),
    startSec,
    endSec,
    rate,
    loop,
    onEnd: () => {
      set({ playing: false });
      emit({ type: 'stop' });
    },
    onLoop: () => emit({ type: 'loop', startSec: loop?.from ?? 0 }),
  });
  set({ playing: true, view: { ...get().view, follow: true } });
  emit({ type: 'play', startSec, rate });
}

// 再生中に譜面が変わったら、まだ鳴らしていない所から新しい譜面で鳴らす
useEditor.subscribe((s, prev) => {
  if (s.doc === prev.doc) return;
  trackSimilar(s.doc, prev.doc, s.meta !== prev.meta);
  if (!engine.playing) return;
  const end = Math.max(songEndSec(s.doc), engine.currentSec() ?? 0);
  engine.replaceEvents(playbackEvents(heardDoc(s.doc)), clickTimes(s.doc, 0, end + OPEN_END_SEC));
  // 曲の終わりを動かした・終わりより後にチップを置いたときは、止める所も合わせる
  engine.setEndSec(playEndSec(s.doc, playStartSec));
  if (s.doc.barLengths !== prev.doc.barLengths || s.doc.fields !== prev.doc.fields) applyLoopToEngine();
});

/** 鳴っている音を止める。▶ は動かさない。鳴っていたら true */
function halt(): boolean {
  playToken++;
  const was = engine.playing;
  engine.stop();
  set({ playing: false });
  if (was) emit({ type: 'stop' });
  return was;
}

/**
 * 停止（Space・■・F7）。再生位置は ▶（再生を始めた位置）に戻る。DAW の「停止時に開始位置に戻る」と同じ。
 * ループ中に ▶ が範囲の外にあるとき（聴きながらループを作ったときなど）は、次の再生が始まる A に ▶ を移す
 */
export function stop() {
  if (!halt()) return;
  const c = get().cursorBeat;
  const to = loopedStart(c);
  if (to !== c) set({ cursorBeat: to });
}

/** 再生・停止（Space）。止めると ▶ の位置に戻る */
export function togglePlay() {
  if (get().playing) stop();
  else void playFrom(get().cursorBeat);
}

/** ここで止める（Shift+Space）。止めた位置を ▶ にするので、次はそこから続けて再生する。止まっていれば ▶ から再生 */
export function togglePause() {
  if (!get().playing) {
    void playFrom(get().cursorBeat);
    return;
  }
  const beat = Math.max(0, currentBeat());
  halt();
  set({ cursorBeat: beat });
}

/** 曲の頭へ（⏮・Home）。▶ を曲の頭に置き、再生中ならそこから再生し直す */
export function goToStart() {
  setCursorBeat(0);
  setView({ scrollBeat: -0.5 });
  if (get().playing) void playFrom(0);
}

/** 今の再生位置（拍）。止まっていればカーソル位置 */
export function currentBeat(): number {
  const s = get();
  const sec = engine.heardSec();
  if (sec === null) return s.cursorBeat;
  return tempoOf(s.doc).secToBeat(sec);
}

export function setMix(m: Partial<Mix>) {
  engine.setMix(m);
  set({ mix: engine.mix });
}

/** 鳴らす音（ステムなど）が変わったとき、再生中なら今の位置から鳴らし直す（▶ は動かさない） */
export function restartIfPlaying() {
  if (!get().playing) return;
  void playFrom(currentBeat(), { keepStart: true });
}

// ---- 新規 ---------------------------------------------------------------------

export interface NewSongInfo {
  title: string;
  artist: string;
  bpm: number;
  bgmFile?: string;
  level?: number;
}

export function createDoc(info: NewSongInfo): DtxDoc {
  const header: HeaderLine[] = [{ kind: 'raw', text: '; Created by DTX Web Editor' }, { kind: 'raw', text: '' }];
  const fields: Record<string, string> = {};
  const add = (key: string, value: string) => {
    header.push({ kind: 'field', key, name: key, sep: ': ', comment: null });
    fields[key] = value;
  };
  add('TITLE', info.title || tr('無題', 'Untitled'));
  add('ARTIST', info.artist);
  add('BPM', String(info.bpm));
  add('DLEVEL', String(info.level ?? 50));
  const doc: DtxDoc = { header, fields, chips: [], barLengths: {}, nextId: 1 };
  if (info.bgmFile) {
    header.push({ kind: 'raw', text: '' });
    add('WAV01', info.bgmFile);
    add('BGMWAV', '01');
    doc.chips.push({ id: doc.nextId++, ch: CH.BGM, m: 1, f: frac(0), v: 1 });
  }
  return doc;
}
