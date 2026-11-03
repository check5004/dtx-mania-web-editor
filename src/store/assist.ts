// 耳コピアシストの状態：原曲の解析、ループ・速度・帯域フィルタ・ミュート、入力方法。
import { create } from 'zustand';
import { pickOnsets, type AnalysisData, type Band, type Onset } from '../audio/analysis';
import { engine, type BgmFilter, type StretchProvider } from '../audio/engine';
import * as wk from '../audio/workerClient';
import { copyMeasureInto, measureSignatures, sameMeasures } from '../assist/similar';
import type { DtxDoc } from '../dtx/model';
import { bgmSource, tempoOf, wavPath } from './derived';
import { snapToGrid } from '../edit/ops';
import { edit, useEditor } from './editor';

export type InputMode = 'mouse' | 'key' | 'rec';

export interface LoopBeats {
  on: boolean;
  /** 拍（曲頭=0） */
  a: number;
  b: number;
}

export interface AssistState {
  /** 解析している原曲 */
  src: { wav: number; key: string; name: string } | null;
  status: 'none' | 'nosource' | 'loading' | 'ready' | 'error';
  progress: number;
  error: string | null;
  data: AnalysisData | null;
  spectro: wk.SpectroData | null;
  spectroStatus: 'none' | 'loading' | 'ready' | 'error';
  /** スペクトルに出している音（setSpecSource で選んだ音の key）。null なら解析元の音 */
  specSource: string | null;
  waveMode: 'wave' | 'spec';
  /** 譜面の右の「原曲の打点」「原曲の波形」の列を出すか */
  audioCols: boolean;
  /** 「原曲の打点」の列に出す打点の感度（0〜1） */
  sensitivity: number;
  loop: LoopBeats | null;
  speed: number;
  bandFilter: BgmFilter;
  mute: readonly number[];
  solo: readonly number[];
  inputMode: InputMode;
  stretching: boolean;
  /** 直したばかりの小節と、直す前に同じパターンだった小節（まとめて反映する先） */
  similarPin: { base: number; targets: number[] } | null;
}

export const useAssist = create<AssistState>(() => ({
  src: null,
  status: 'none',
  progress: 0,
  error: null,
  data: null,
  spectro: null,
  spectroStatus: 'none',
  specSource: null,
  waveMode: 'wave',
  audioCols: true,
  sensitivity: 0.5,
  loop: null,
  speed: 1,
  bandFilter: 'all',
  mute: [],
  solo: [],
  inputMode: 'mouse',
  stretching: false,
  similarPin: null,
}));

const aget = useAssist.getState;
const aset = useAssist.setState;

// ---- 原曲の解析 -----------------------------------------------------------------

let running = '';

/** 解析に使う音（ステムを解析元にしたとき）。無ければ原曲（BGM）を使う */
export interface AnalysisSource {
  key: string;
  buf: AudioBuffer;
  name: string;
}
let analysisProvider: (() => AnalysisSource | null) | null = null;

export function setAnalysisProvider(fn: (() => AnalysisSource | null) | null) {
  analysisProvider = fn;
}

/** 譜面の BGM が読み込めたら解析する（同じ音はやり直さない） */
export function syncAnalysis() {
  const s = useEditor.getState();
  if (s.screen === 'home') return;
  const bgm = bgmSource(s.doc);
  if (!bgm) {
    if (aget().status !== 'nosource') aset({ src: null, status: 'nosource', data: null, ...specReset() });
    return;
  }
  const stem = analysisProvider?.() ?? null;
  const got = stem ?? engine.buffer(bgm.wav);
  if (!got) {
    if (!s.loading && aget().status !== 'loading') aset({ src: null, status: 'nosource', data: null, ...specReset() });
    return;
  }
  const cur = aget();
  if (cur.src?.key === got.key && (cur.status === 'ready' || cur.status === 'loading')) {
    if (cur.src.wav !== bgm.wav) aset({ src: { ...cur.src, wav: bgm.wav } });
    return;
  }
  if (running === got.key) return;
  running = got.key;
  const name = stem ? stem.name : ((wavPath(s.doc, bgm.wav) ?? '').split(/[\\/]/).pop() ?? '');
  aset({ src: { wav: bgm.wav, key: got.key, name }, status: 'loading', progress: 0, error: null, data: null, ...specReset() });
  void (async () => {
    try {
      await wk.loadAudio(got.key, got.buf);
      const data = await wk.analyze(got.key, (p) => {
        if (running === got.key) aset({ progress: p });
      });
      if (running !== got.key) return;
      aset({ data, status: 'ready', progress: 1 });
      if (aget().waveMode === 'spec') void loadSpectrogram();
    } catch (e) {
      if (running === got.key) aset({ status: 'error', error: (e as Error).message });
    } finally {
      if (running === got.key) running = '';
    }
  })();
}

/** 解析元が変わったとき：別に選んだ音のスペクトルは残す */
function specReset(): Partial<AssistState> {
  return specSrc ? {} : { spectro: null, spectroStatus: 'none' };
}

/** スペクトルに出す音（setSpecSource で選んだもの。無ければ解析元） */
let specSrc: AnalysisSource | null = null;

export async function loadSpectrogram() {
  const a = aget();
  const own = specSrc;
  const key = own ? own.key : a.src?.key;
  if (!key || a.spectroStatus === 'loading' || a.spectroStatus === 'ready') return;
  aset({ spectroStatus: 'loading' });
  const current = () => (specSrc ? specSrc.key : aget().src?.key) === key;
  try {
    if (own) await wk.loadAudio(own.key, own.buf);
    const sp = await wk.spectrogram(key);
    if (current()) aset({ spectro: sp, spectroStatus: 'ready' });
  } catch {
    if (current()) aset({ spectroStatus: 'error' });
  }
}

/**
 * 譜面の右の列にスペクトルを出す音を選ぶ（下のトラックの「スペクトル」のチェック）。
 * null なら解析元の音に戻す。音を選ぶとスペクトル表示に切り替える。
 */
export function setSpecSource(src: AnalysisSource | null) {
  const prev = specSrc?.key ?? null;
  specSrc = src;
  const next = src?.key ?? null;
  if (prev !== next) aset({ specSource: next, spectro: null, spectroStatus: 'none' });
  if (src) aset({ waveMode: 'spec' });
  if (aget().waveMode === 'spec') void loadSpectrogram();
}

export function setWaveMode(m: 'wave' | 'spec') {
  aset({ waveMode: m });
  if (m === 'spec') void loadSpectrogram();
}

// ---- 原曲の打点 -------------------------------------------------------------------

let bandMemo: { data: AnalysisData; sens: number; out: Record<Band, Onset[]> } | null = null;

/** 帯域ごとの打点（「原曲の打点」の列に出す） */
export function bandOnsets(): Record<Band, Onset[]> | null {
  const a = aget();
  if (!a.data) return null;
  if (bandMemo && bandMemo.data === a.data && bandMemo.sens === a.sensitivity) return bandMemo.out;
  const out = {
    low: pickOnsets(a.data.odf.low, a.data.frameRate, a.sensitivity),
    mid: pickOnsets(a.data.odf.mid, a.data.frameRate, a.sensitivity),
    high: pickOnsets(a.data.odf.high, a.data.frameRate, a.sensitivity),
  };
  bandMemo = { data: a.data, sens: a.sensitivity, out };
  return out;
}

// ---- ループ・速度・ミックス ----------------------------------------------------------

export function setLoop(loop: LoopBeats | null, opts: { engine?: boolean } = {}) {
  aset({ loop });
  if (opts.engine !== false) applyLoopToEngine();
}

/** 吸着させた拍（div: 全音符の分割数） */
export function snapBeat(beat: number, div: number): number {
  const t = tempoOf(useEditor.getState().doc);
  const p = snapToGrid(t, Math.max(0, beat), div);
  return t.beatOf(p.m, p.f);
}

/** その拍の小節（ループの初期値に使う） */
function measureRange(beat: number): { a: number; b: number } {
  const t = tempoOf(useEditor.getState().doc);
  const { m } = t.locate(Math.max(0, beat));
  return { a: t.measureStart(m), b: t.measureStart(m + 1) };
}

/** 今の位置（再生中なら再生位置、止まっていれば再生を始める位置） */
function hereBeat(): number {
  const sec = engine.heardSec();
  const s = useEditor.getState();
  return sec === null ? s.cursorBeat : tempoOf(s.doc).secToBeat(sec);
}

/** ループのオン・オフ。範囲が無ければ、選んだチップの小節か今の位置の小節で作る */
export function toggleLoop() {
  const loop = aget().loop;
  if (loop) {
    setLoop({ ...loop, on: !loop.on });
    return;
  }
  const s = useEditor.getState();
  const t = tempoOf(s.doc);
  if (s.selection.length) {
    const ids = new Set(s.selection);
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of s.doc.chips) {
      if (!ids.has(c.id)) continue;
      lo = Math.min(lo, c.m);
      hi = Math.max(hi, c.m);
    }
    if (lo <= hi) {
      setLoop({ on: true, a: t.measureStart(lo), b: t.measureStart(hi + 1) });
      return;
    }
  }
  setLoop({ on: true, ...measureRange(hereBeat()) });
}

/**
 * 今の位置を A（ループの始まり）か B（終わり）にする。範囲が無ければ1小節ぶんで作る。
 * A が B を越えたら B を、B が A より前なら A を1小節ずらす。
 */
export function setLoopPoint(which: 'a' | 'b', beat = hereBeat()) {
  // ループの端は拍に吸着する（聴きながら押すと少し遅れるので、近い拍へ）
  const b0 = snapBeat(beat, LOOP_DIV);
  const t = tempoOf(useEditor.getState().doc);
  const cur = aget().loop;
  const barAt = (x: number) => t.measureBeats(t.locate(Math.max(0, x)).m);
  if (which === 'a') {
    const b = cur && cur.b > b0 + 1e-6 ? cur.b : b0 + barAt(b0);
    setLoop({ on: true, a: b0, b });
  } else {
    let a = cur && cur.a < b0 - 1e-6 ? cur.a : Math.max(0, b0 - barAt(Math.max(0, b0 - 1e-6)));
    if (b0 - a < 1e-6) a = 0;
    if (b0 <= 1e-6) return;
    setLoop({ on: true, a, b: b0 });
  }
}

/** ループの端を吸着させる細かさ（4 = 拍） */
export const LOOP_DIV = 4;

/** ループの範囲をドラッグで変える（譜面・下の波形・全体図で共通） */
export type LoopDragMode = 'new' | 'a' | 'b' | 'move';
export interface LoopDrag {
  mode: LoopDragMode;
  /** 押したところの拍 */
  origin: number;
  a0: number;
  b0: number;
  moved: boolean;
}

/** どこを掴んだか（A・B の印の近く・範囲の中・空いた所） */
export function loopGrab(beat: number, tol: number): LoopDragMode {
  const l = aget().loop;
  if (!l || l.b <= l.a) return 'new';
  if (Math.abs(beat - l.a) <= tol && Math.abs(beat - l.a) <= Math.abs(beat - l.b)) return 'a';
  if (Math.abs(beat - l.b) <= tol) return 'b';
  if (beat > l.a && beat < l.b) return 'move';
  return 'new';
}

export function beginLoopDrag(beat: number, tol: number): LoopDrag {
  const l = aget().loop;
  return { mode: loopGrab(beat, tol), origin: beat, a0: l?.a ?? beat, b0: l?.b ?? beat, moved: false };
}

/** ドラッグ中：ループを書き換える（エンジンへは離したときに渡す） */
export function dragLoop(d: LoopDrag, beat: number, div: number, movedPx: boolean) {
  if (!d.moved && !movedPx) return;
  d.moved = true;
  const snap = (x: number) => snapBeat(x, div);
  const step = 4 / div;
  const on = true;
  if (d.mode === 'new') {
    const a = snap(Math.min(d.origin, beat));
    const b = snap(Math.max(d.origin, beat));
    setLoop({ on, a, b: Math.max(b, a + step) }, { engine: false });
  } else if (d.mode === 'a') {
    setLoop({ on, a: Math.min(snap(beat), d.b0 - step), b: d.b0 }, { engine: false });
  } else if (d.mode === 'b') {
    setLoop({ on, a: d.a0, b: Math.max(snap(beat), d.a0 + step) }, { engine: false });
  } else {
    let a = snap(d.a0 + (beat - d.origin));
    if (a < 0) a = 0;
    setLoop({ on, a, b: a + (d.b0 - d.a0) }, { engine: false });
  }
}

/** ドラッグを終える。動かさずにクリックだけなら、範囲の中はオン・オフ、空いた所はその小節をループ */
export function endLoopDrag(d: LoopDrag) {
  if (d.moved) {
    applyLoopToEngine();
    return;
  }
  const l = aget().loop;
  if (d.mode === 'move' && l) setLoop({ ...l, on: !l.on });
  else if (d.mode === 'new') setLoop({ on: true, ...measureRange(d.origin) });
}

/** 拍のループを秒にする（譜面の BPM が変わっても拍で覚えておく） */
export function loopSec(doc: DtxDoc, loop: LoopBeats | null): { from: number; to: number } | null {
  if (!loop || !loop.on || loop.b <= loop.a) return null;
  const t = tempoOf(doc);
  return { from: t.beatToSec(loop.a), to: t.beatToSec(loop.b) };
}

export function applyLoopToEngine() {
  if (!engine.playing) return;
  engine.setLoop(loopSec(useEditor.getState().doc, aget().loop));
}

export function setSpeed(speed: number) {
  aset({ speed });
}

export function setBandFilter(f: BgmFilter) {
  aset({ bandFilter: f });
  engine.ensure();
  engine.setBgmFilter(f);
}

function updateGate() {
  const { mute, solo } = aget();
  const ms = new Set(mute);
  const ss = new Set(solo);
  engine.laneGate = (lane) => (lane < 0 ? true : ss.size > 0 ? ss.has(lane) : !ms.has(lane));
}

export function toggleMute(lane: number) {
  const m = new Set(aget().mute);
  if (m.has(lane)) m.delete(lane);
  else m.add(lane);
  aset({ mute: [...m] });
  updateGate();
}

export function toggleSolo(lane: number) {
  const m = new Set(aget().solo);
  if (m.has(lane)) m.delete(lane);
  else m.add(lane);
  aset({ solo: [...m] });
  updateGate();
}

export function clearMuteSolo() {
  aset({ mute: [], solo: [] });
  updateGate();
}

export function setInputMode(m: InputMode) {
  aset({ inputMode: m });
}

// ---- 似た小節 -------------------------------------------------------------------

let applyingSimilar = false;

/**
 * 譜面が変わるたびに呼ぶ。1つの小節だけが変わったら、その小節と「直す前に同じだった小節」を覚えておき、
 * 右のパネルから まとめて反映 できるようにする。
 */
export function trackSimilar(next: DtxDoc, prev: DtxDoc, newDoc: boolean) {
  if (newDoc) {
    if (aget().similarPin) aset({ similarPin: null });
    return;
  }
  if (applyingSimilar || next === prev) return;
  const a = measureSignatures(prev);
  const b = measureSignatures(next);
  const diff = new Set<number>();
  for (const [m, v] of a) if (b.get(m) !== v) diff.add(m);
  for (const [m, v] of b) if (a.get(m) !== v) diff.add(m);
  if (diff.size !== 1) return;
  const changed = [...diff][0];
  const pin = aget().similarPin;
  if (pin && pin.base === changed) return;
  const before = a.get(changed);
  const targets = before ? sameMeasures(prev, changed, before) : [];
  aset({ similarPin: targets.length ? { base: changed, targets } : null });
}

/** 覚えている小節に、直した小節の中身を写す */
export function applySimilar(targets?: number[]): number {
  const pin = aget().similarPin;
  if (!pin) return 0;
  const to = targets ?? pin.targets;
  let n = 0;
  applyingSimilar = true;
  try {
    edit(`似た小節 ${to.length} 個にまとめて反映`, (d) => {
      n = copyMeasureInto(d, pin.base, to);
    });
  } finally {
    applyingSimilar = false;
  }
  aset({ similarPin: null });
  return n;
}

export function clearSimilarPin() {
  aset({ similarPin: null });
}

/** 新しい譜面を開いたときに、譜面ごとの状態を戻す */
export function resetAssistForDoc() {
  if (specSrc) {
    specSrc = null;
    aset({ specSource: null, spectro: null, spectroStatus: 'none' });
  }
  aset({ loop: null, similarPin: null });
}

// ---- スロー再生の BGM（伸ばした音をワーカーで作る） --------------------------------------

const CHUNK = 20;
const PAD = 0.25;
const chunkCache = new Map<string, { buf: AudioBuffer; fromSec: number }>();
const chunkJobs = new Map<string, Promise<unknown>>();

function chunkKey(wav: number, rate: number, k: number) {
  const got = engine.buffer(wav);
  return `${got?.key ?? wav}|${rate}|${k}`;
}

export const stretchProvider: StretchProvider = {
  chunkSec: CHUNK,
  get(wav, rate, k) {
    const key = chunkKey(wav, rate, k);
    const hit = chunkCache.get(key);
    if (hit) {
      // 使ったものを後ろへ（古いものから捨てる）
      chunkCache.delete(key);
      chunkCache.set(key, hit);
    }
    return hit ?? null;
  },
  request(wav, rate, k) {
    const key = chunkKey(wav, rate, k);
    if (chunkCache.has(key)) return Promise.resolve();
    const running = chunkJobs.get(key);
    if (running) return running;
    const got = engine.buffer(wav);
    if (!got || k * CHUNK >= got.buf.duration) return Promise.resolve();
    const job = (async () => {
      try {
        await wk.loadAudio(got.key, got.buf);
        const r = await wk.stretch(got.key, rate, Math.max(0, k * CHUNK - PAD), (k + 1) * CHUNK + PAD);
        const ctx = engine.ensure();
        const len = r.channels[0].length;
        const buf = ctx.createBuffer(r.channels.length, Math.max(1, len), r.sr);
        r.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
        chunkCache.set(key, { buf, fromSec: r.fromSec });
        while (chunkCache.size > 8) chunkCache.delete(chunkCache.keys().next().value!);
      } finally {
        chunkJobs.delete(key);
      }
    })();
    chunkJobs.set(key, job);
    return job;
  },
};
engine.stretch = stretchProvider;

/** スロー再生を始める前に、最初に鳴らす区切りを用意する */
export async function prepareStretch(wav: number, rate: number, srcSecs: number[]) {
  if (rate >= 0.999) return;
  const ks = [...new Set(srcSecs.filter((s) => s >= 0).map((s) => Math.floor(s / CHUNK)))];
  if (ks.every((k) => stretchProvider.get(wav, rate, k))) return;
  aset({ stretching: true });
  try {
    await Promise.all(ks.map((k) => stretchProvider.request(wav, rate, k)));
  } finally {
    aset({ stretching: false });
  }
}
