// エディタの状態。譜面の変更は immer のパッチで Undo/Redo できるようにする。
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import { create } from 'zustand';
import { engine, type Mix } from '../audio/engine';
import { kitByChannel } from '../audio/kit';
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
import type { SongFolder } from '../fs/folder';
import { chipViews, clickTimes, soundEvents, tempoOf, wavSources } from './derived';

enablePatches();

export type LeftTab = 'kit' | 'wav' | 'info' | 'header';

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

interface HistoryEntry {
  label: string;
  redo: Patch[];
  undo: Patch[];
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

export interface EditorState {
  screen: 'home' | 'editor';
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
}

const initialMeta: DocMeta = { fileName: 'new.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] };

export const useEditor = create<EditorState>(() => ({
  screen: 'home',
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
  void prepareSounds();
}

export function goHome() {
  engine.stop();
  set({ screen: 'home', playing: false });
}

// ---- 編集と Undo ---------------------------------------------------------------

const MAX_HISTORY = 300;

/** 譜面を書き換える。変化が無ければ履歴に積まない */
export function edit(label: string, recipe: (d: Draft<DtxDoc>) => void): boolean {
  const s = get();
  const [next, redo, undo] = produceWithPatches(s.doc, recipe);
  if (redo.length === 0) return false;
  const past = [...s.past, { label, redo, undo }];
  if (past.length > MAX_HISTORY) past.shift();
  set({ doc: next, past, future: [] });
  return true;
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
  set({ doc, past: s.past.slice(0, -1), future: [...s.future, h], selection: keepSelection(doc, s.selection) });
  afterSoundChange(h.label);
}

export function redo() {
  const s = get();
  const h = s.future[s.future.length - 1];
  if (!h) return;
  const doc = applyPatches(s.doc, h.redo);
  set({ doc, future: s.future.slice(0, -1), past: [...s.past, h], selection: keepSelection(doc, s.selection) });
  afterSoundChange(h.label);
}

function afterSoundChange(label: string) {
  if (/WAV|キット|音/.test(label)) void prepareSounds();
}

// ---- チップの配置 ---------------------------------------------------------------

/** 置くチップの WAV 番号。レーンで使っている音、無ければ内蔵キットを登録する */
function wavForChannel(d: Draft<DtxDoc>, ch: number): number {
  const info = drumChannel(ch);
  const base = info ? info.base : ch;
  const assigned = get().laneWav[base];
  if (assigned !== undefined && d.fields['WAV' + toBase36x2(assigned)] !== undefined) return assigned;
  const kit = kitByChannel.get(base);
  if (!kit) return assigned ?? 1;
  // 同じキットの音がもう登録されていれば使う
  for (const [k, v] of Object.entries(d.fields)) {
    if (/^WAV[0-9A-Z]{2}$/.test(k) && v.toLowerCase() === kit.file.toLowerCase()) {
      const no = parseInt(k.slice(3), 36);
      set((s) => ({ laneWav: { ...s.laneWav, [base]: no } }));
      return no;
    }
  }
  const no = freeWavNumber(d as DtxDoc) ?? 1;
  setField(d, 'WAV' + toBase36x2(no), kit.file);
  set((s) => ({ laneWav: { ...s.laneWav, [base]: no } }));
  return no;
}

export function placeChip(lane: number, alt: boolean, pos: Pos) {
  const def = DRUM_LANES[lane];
  const ch = alt && def.alt !== undefined ? def.alt : def.main;
  let id = 0;
  let v = 0;
  const hadKit = Object.keys(get().doc.fields).length;
  edit(`${alt && def.altName ? def.altName : def.mainName}を置く`, (d) => {
    v = wavForChannel(d, ch);
    id = opPlace(d, ch, pos, v);
  });
  if (id) set({ selection: [id] });
  if (Object.keys(get().doc.fields).length !== hadKit) void prepareSounds();
  if (get().previewOnPlace && v) previewWav(v);
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
    ok = opMove(d, new Set(s.selection), tempo, dBeat, dLane);
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

export function setLaneWav(base: number, no: number) {
  set((s) => ({ laneWav: { ...s.laneWav, [base]: no } }));
}

/** BPM を変える（#BPM ヘッダ。曲頭に ch08/ch03 のBPMチップがあればそれも合わせる） */
export function setInitialBpm(bpm: number) {
  edit('BPMを変更', (d) => {
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
    }
  })();
  preparing = p;
  return p;
}

export function previewWav(no: number) {
  engine.ensure();
  engine.preview(no);
}

export function songEndSec(doc: DtxDoc): number {
  const ev = soundEvents(doc);
  let end = 0;
  for (const e of ev) end = Math.max(end, e.sec + (e.bus === 'bgm' ? engine.duration(e.wav) : 0.5));
  const t = tempoOf(doc);
  const views = chipViews(doc);
  if (views.length) end = Math.max(end, t.beatToSec(views[views.length - 1].beat) + 1);
  return end;
}

export async function playFrom(beat: number) {
  const s = get();
  engine.ensure();
  stop();
  await prepareSounds();
  const doc = get().doc;
  const tempo = tempoOf(doc);
  const startSec = tempo.beatToSec(Math.max(0, beat));
  const endSec = Math.max(songEndSec(doc), startSec + 1);
  engine.play({
    events: soundEvents(doc),
    clicks: clickTimes(doc, startSec, endSec),
    startSec,
    endSec,
    onEnd: () => set({ playing: false }),
  });
  set({ playing: true, view: { ...s.view, follow: true } });
}

export function stop() {
  engine.stop();
  set({ playing: false });
}

export function togglePlay() {
  if (get().playing) stop();
  else void playFrom(get().cursorBeat);
}

/** 今の再生位置（拍）。止まっていればカーソル位置 */
export function currentBeat(): number {
  const s = get();
  const sec = engine.currentSec();
  if (sec === null) return s.cursorBeat;
  return tempoOf(s.doc).secToBeat(sec);
}

export function setMix(m: Partial<Mix>) {
  engine.setMix(m);
  set({ mix: engine.mix });
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
