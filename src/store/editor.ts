// エディタの状態。譜面の変更は immer のパッチで Undo/Redo できるようにする。
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { create } from 'zustand';
import { engine, type Mix } from '../audio/engine';
import { builtinFile, virtualSound } from '../audio/sounds';
import { toBase36x2, toMeasure } from '../dtx/base36';
import type { DtxEncoding } from '../dtx/encoding';
import { cmp, frac, type Frac } from '../dtx/fraction';
import { CH, DRUM_LANES, drumChannel, emptyDoc, type DtxDoc, type HeaderLine, type ParseWarning } from '../dtx/model';
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
import { quantizeVel, velOfWav, wavVariant } from '../edit/velocity';
import { findFile, type SongFolder } from '../fs/folder';
import { shiftLane, useInputSettings } from '../input/settings';
import { applyLoopToEngine, loopSec, prepareStretch, resetAssistForDoc, syncAnalysis, trackSimilar, useAssist } from './assist';
import { bgmSource, chipViews, clickTimes, playbackEvents, tempoOf, wavSources, wavVolume } from './derived';
import { loadSidecar, useSidecar, type SectionMark, type TempoAnchor } from './sidecar';
import { opDeleteMeasures, opInsertMeasures, shiftMeasure, type DeleteResult } from '../edit/measures';

enablePatches();

export type LeftTab = 'kit' | 'wav' | 'bga' | 'info' | 'header';

export interface DocMeta {
  fileName: string;
  encoding: DtxEncoding;
  encodingNote?: string;
  warnings: ParseWarning[];
  hasRandom: boolean;
  /** 同じフォルダの難易度（set.def のラベル付き） */
  siblings: { label: string; file: string }[];
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

// ---- 通知 ---------------------------------------------------------------------

let toastId = 0;
export function toast(text: string, level: Toast['level'] = 'info', ms = 4000) {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, text, level }] }));
  window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

// ---- 読み込み -----------------------------------------------------------------

export function openDocument(doc: DtxDoc, meta: DocMeta, folder: SongFolder | null, opts: { dirty?: boolean } = {}) {
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
  const labels: string[] = [];
  while (past.length > n) {
    const h = past.pop()!;
    doc = applyPatches(doc, h.undo);
    h.side?.undo();
    future.push(h);
    labels.push(h.label);
  }
  while (past.length < n && future.length) {
    const h = future.pop()!;
    doc = applyPatches(doc, h.redo);
    h.side?.redo();
    past.push(h);
    labels.push(h.label);
  }
  set({ doc, past, future, selection: keepSelection(doc, s.selection) });
  if (labels.some((l) => /WAV|キット|音/.test(l))) void prepareSounds();
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
  afterSoundChange(h.label);
}

export function redo() {
  const s = get();
  const h = s.future[s.future.length - 1];
  if (!h) return;
  const doc = applyPatches(s.doc, h.redo);
  h.side?.redo();
  set({ doc, future: s.future.slice(0, -1), past: [...s.past, h], selection: keepSelection(doc, s.selection) });
  afterSoundChange(h.label);
}

function afterSoundChange(label: string) {
  if (/WAV|キット|音/.test(label)) void prepareSounds();
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
  const label = opts.label ?? (items.length === 1 ? `${one.alt && def.altName ? def.altName : def.mainName}を置く` : `${items.length}個のチップを置く`);
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
  edit(`小節 ${toMeasure(m - 1)} を ${toMeasure(m)} に複製`, (d) => {
    const src = d.chips.filter((c) => c.m === m - 1 && drumChannel(c.ch)).map((c) => ({ ch: c.ch, f: { ...c.f }, v: c.v }));
    for (let i = d.chips.length - 1; i >= 0; i--) if (d.chips[i].m === m && drumChannel(d.chips[i].ch)) d.chips.splice(i, 1);
    for (const c of src) d.chips.push({ id: d.nextId++, ch: c.ch, m, f: c.f, v: c.v });
  });
}

/** m 小節目の前に n 小節の空の小節を入れる（セクションとテンポのアンカーもずらす） */
export function insertMeasures(m: number, n = 1): boolean {
  const before = useSidecar.getState();
  const sections = before.sections.map((x) => ({ ...x, m: shiftMeasure(x.m, m, n, 'insert')! }));
  const anchors = before.anchors.map((x) => ({ ...x, m: shiftMeasure(x.m, m, n, 'insert')! }));
  let ok = false;
  const side = sideForMeasures(before.sections, before.anchors, sections, anchors);
  edit(`小節 ${toMeasure(m)} の前に ${n} 小節を挿入`, (d) => {
    ok = opInsertMeasures(d, m, n);
  }, { side });
  if (ok) side.redo();
  else toast('これ以上小節を増やせません（Z99 まで）', 'error');
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
  let res: DeleteResult = { removed: 0, kept: 0 };
  const side = sideForMeasures(before.sections, before.anchors, sections, anchors);
  const changed = edit(`小節 ${toMeasure(m)}${n > 1 ? `〜${toMeasure(m + n - 1)}` : ''} を削除`, (d) => {
    res = opDeleteMeasures(d, m, n);
  }, { side });
  if (changed) side.redo();
  return res;
}

function sideForMeasures(s0: SectionMark[], a0: TempoAnchor[], s1: SectionMark[], a1: TempoAnchor[]): NonNullable<HistoryEntry['side']> {
  const same = JSON.stringify([s0, a0]) === JSON.stringify([s1, a1]);
  return {
    undo: () => {
      if (!same) useSidecar.setState({ sections: s0, anchors: a0, dirty: true });
    },
    redo: () => {
      if (!same) useSidecar.setState({ sections: s1, anchors: a1, dirty: true });
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
  edit(`${ids.length}個のチップを消す`, (d) => {
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
  edit('チップを動かす', (d) => {
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

export function paste() {
  const s = get();
  if (s.clipboard.length === 0) return;
  const tempo = tempoOf(s.doc);
  const at = snapToGrid(tempo, s.cursorBeat, s.view.div);
  const atBeat = tempo.beatOfFrac(at.m, at.f);
  let ids: number[] = [];
  edit(`${s.clipboard.length}個のチップを貼り付け`, (d) => {
    ids = opPaste(d, s.clipboard, atBeat, tempo);
  });
  set({ selection: ids });
}

export function selectAll() {
  set((s) => ({ selection: chipViews(s.doc).filter((v) => v.col >= 0).map((v) => v.c.id) }));
}

export function setKind(kind: 'normal' | 'hidden' | 'nochip') {
  const ids = new Set(get().selection);
  edit(kind === 'normal' ? '通常チップにする' : kind === 'hidden' ? '不可視チップにする' : '音だけのチップにする', (d) =>
    opSetKind(d, ids, kind),
  );
}

export function setSelectionWav(v: number) {
  const ids = new Set(get().selection);
  edit('チップの音（WAV）を変える', (d) => {
    for (const c of d.chips) if (ids.has(c.id) && drumChannel(c.ch)) c.v = v;
  });
}

export function setFieldValue(key: string, value: string | undefined, label = `#${key} を変更`) {
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
export function setInitialBpm(bpm: number, label = 'BPMを変更') {
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
  edit(`小節${toMeasure(m)}の拍子を変更`, (d) => {
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

/** BPM変化を置く（ch08 と #BPMzz を使う） */
export function placeBpmChange(pos: Pos, bpm: number) {
  edit(`BPM ${bpm} を置く`, (d) => {
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
  });
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

export async function prepareSounds(): Promise<void> {
  const s = get();
  const sources = wavSources(s.doc, s.folder);
  const sig = sources.map((x) => `${x.no}:${x.key}:${x.volume}:${x.pan}`).join('|');
  if (sig === preparedSig && preparing) return preparing;
  preparedSig = sig;
  const p = (async () => {
    if (sources.length > 8) set({ loading: '音を読み込んでいます…' });
    try {
      const failed = await engine.prepare(sources, (done, total) => {
        if (total > 8 && done % 8 === 0) set({ loading: `音を読み込んでいます… ${done}/${total}` });
      });
      if (preparedSig === sig) set({ missingWavs: failed });
    } finally {
      set((st) => ({ loading: null, soundsVersion: st.soundsVersion + 1 }));
      syncAnalysis();
    }
  })();
  preparing = p;
  return p;
}

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

/** ファイル（曲フォルダの音・標準キット・ライブラリの音）を1回鳴らす。譜面は変えない */
export async function previewFile(path: string, gain = 1): Promise<boolean> {
  const ctx = engine.ensure();
  const s = get();
  const f = findFile(s.folder, path, s.doc.fields['PATH_WAV'] ?? '');
  const vs = f ? null : virtualSound(path);
  if (!f && !vs) return false;
  const key = f ? `${s.folder?.name}|${f.path}|${f.size}|${f.ver ?? 0}` : `virtual:${vs!.sampleId ?? vs!.file.toLowerCase()}`;
  let p = previewCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        if (f) return await ctx.decodeAudioData(await (await f.getFile()).arrayBuffer());
        return await vs!.load();
      } catch {
        return null;
      }
    })();
    previewCache.set(key, p);
  }
  const buf = await p;
  if (!buf) {
    previewCache.delete(key);
    return false;
  }
  engine.previewBuffer(buf, gain);
  return true;
}

/**
 * 曲の終わり（秒）。チップ・原曲（BGM）・参照映像のうち一番遅いもの。
 * 譜面が空でも、原曲や映像の長さぶんは曲があるものとして扱う。
 */
export function songEndSec(doc: DtxDoc): number {
  const ev = playbackEvents(doc);
  let end = 0;
  for (const e of ev) end = Math.max(end, e.sec + (e.bus === 'bgm' || e.bus === 'stem' ? engine.duration(e.wav) : 0.5));
  const t = tempoOf(doc);
  const views = chipViews(doc);
  if (views.length) end = Math.max(end, t.beatToSec(views[views.length - 1].beat) + 1);
  const bgm = bgmSource(doc);
  // 音を読み込む前でも、解析が済んでいれば原曲の長さが分かる
  const a = useAssist.getState();
  if (bgm && a.data && a.src?.wav === bgm.wav) end = Math.max(end, bgm.sec + a.data.duration);
  const video = get().refVideoSec;
  if (video > 0) end = Math.max(end, (bgm?.sec ?? 0) + video - (useSidecar.getState().youtube?.offset ?? 0));
  return end;
}

/** 曲の長さが何も分からない（チップも原曲も映像も無い）ときに流し続ける長さ */
export const OPEN_END_SEC = 600;

/** 再生を止める位置。何も無い譜面でも、止めるまで流し続ける（BPM合わせや曲の頭を探すため） */
export function playEndSec(doc: DtxDoc, startSec: number): number {
  const end = songEndSec(doc);
  if (end <= 0) return startSec + OPEN_END_SEC;
  return Math.max(end, startSec + 1);
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

let playToken = 0;
/** 再生を始める途中（音の読み込み・スロー再生の準備中）の数 */
let starting = 0;

/** 再生を始める途中なら true。止めたのではなく、位置や速さを変えて再生し直している */
export function playStarting(): boolean {
  return starting > 0;
}

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
  const token = ++playToken;
  const startBeat = loopedStart(Math.max(0, beat));
  if (!opts.keepStart) set({ cursorBeat: startBeat });
  starting++;
  try {
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
    const rate = a.speed;
    const events = playbackEvents(doc);
    const longs = new Map<number, number>();
    for (const e of events) if ((e.bus === 'bgm' || e.bus === 'stem') && !longs.has(e.wav)) longs.set(e.wav, e.sec);
    if (rate < 0.999 && longs.size > 0) {
      set({ loading: 'スロー再生の準備中…' });
      try {
        await Promise.all([...longs].map(([wav, sec]) => prepareStretch(wav, rate, [startSec - sec, ...(loop ? [loop.from - sec] : [])])));
      } catch (e) {
        toast(`スロー再生の準備ができませんでした: ${(e as Error).message}`, 'error');
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
  } finally {
    starting--;
  }
}

// 再生中に譜面が変わったら、まだ鳴らしていない所から新しい譜面で鳴らす
useEditor.subscribe((s, prev) => {
  if (s.doc === prev.doc) return;
  trackSimilar(s.doc, prev.doc, s.meta !== prev.meta);
  if (!engine.playing) return;
  const end = Math.max(songEndSec(s.doc), engine.currentSec() ?? 0);
  engine.replaceEvents(playbackEvents(s.doc), clickTimes(s.doc, 0, end + OPEN_END_SEC));
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
  add('TITLE', info.title || '無題');
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
