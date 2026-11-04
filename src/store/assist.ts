// 耳コピアシストの状態：原曲の解析、ループ・速度・帯域フィルタ・ミュート、入力方法。
import { tr, pl } from '../i18n';
import { create } from 'zustand';
import { pickOnsets, type AnalysisData, type Band, type Onset } from '../audio/analysis';
import { engine, type BgmFilter, type StretchProvider } from '../audio/engine';
import * as wk from '../audio/workerClient';
import type { SpecMode } from '../audio/spectro';
import { grabLoop, placeLoopPoint, type LoopBeats, type LoopGrab, type LoopMark } from '../assist/loopPoints';
import { copyMeasureInto, measureSignatures, sameMeasures } from '../assist/similar';
import type { DtxDoc } from '../dtx/model';
import { bgmSource, tempoOf, wavPath } from './derived';
import { drumHitsByClass, setDrumSource } from './drums';
import type { OnsetRows } from '../ai/phrase';
import { snapToGrid } from '../edit/ops';
import { edit, toast, useEditor } from './editor';

export type { LoopBeats, LoopMark } from '../assist/loopPoints';

export type InputMode = 'mouse' | 'key' | 'rec';

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
  /** スペクトルの見せ方（ドラム強調・アタック・そのまま） */
  specMode: SpecMode;
  /** スペクトルの明るさ（1 が標準） */
  specGain: number;
  /** スペクトルを作っている進み具合（0〜1） */
  specProgress: number;
  waveMode: 'wave' | 'spec';
  /** 譜面の右の「原曲の打点」「原曲の波形」の列を出すか */
  audioCols: boolean;
  /** 「原曲の打点」の列に出す打点の感度（0〜1） */
  sensitivity: number;
  /** ループの範囲（A と B の両方が決まったとき） */
  loop: LoopBeats | null;
  /** A だけ・B だけ決めたときの印（もう片方を決めると loop になる。loop と同時には持たない） */
  loopMark: LoopMark | null;
  speed: number;
  bandFilter: BgmFilter;
  mute: readonly number[];
  solo: readonly number[];
  inputMode: InputMode;
  stretching: boolean;
  /** 直したばかりの小節と、直す前に同じパターンだった小節（まとめて反映する先） */
  similarPin: { base: number; targets: number[] } | null;
}

// ---- スペクトルの見せ方（ブラウザに覚える） ----------------------------------------------

const SPEC_KEY = 'dtxe.spec.v1';
type SpecPrefs = Pick<AssistState, 'specMode' | 'specGain' | 'waveMode'>;

function loadSpecPrefs(): SpecPrefs {
  const def: SpecPrefs = { specMode: 'drum', specGain: 1, waveMode: 'wave' };
  try {
    const v = JSON.parse(localStorage.getItem(SPEC_KEY) || '{}') as Partial<SpecPrefs>;
    return {
      specMode: v.specMode === 'attack' || v.specMode === 'raw' || v.specMode === 'drum' ? v.specMode : def.specMode,
      specGain: typeof v.specGain === 'number' && v.specGain >= 0.4 && v.specGain <= 3 ? v.specGain : def.specGain,
      waveMode: v.waveMode === 'spec' ? 'spec' : 'wave',
    };
  } catch {
    return def;
  }
}

const SPEC_PREFS = loadSpecPrefs();

function saveSpecPrefs() {
  const { specMode, specGain, waveMode } = aget();
  try {
    localStorage.setItem(SPEC_KEY, JSON.stringify({ specMode, specGain, waveMode }));
  } catch {
    // 覚えられなくても動く
  }
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
  specMode: SPEC_PREFS.specMode,
  specGain: SPEC_PREFS.specGain,
  specProgress: 0,
  waveMode: SPEC_PREFS.waveMode,
  audioCols: true,
  sensitivity: 0.5,
  loop: null,
  loopMark: null,
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
    setDrumSource(null);
    return;
  }
  const stem = analysisProvider?.() ?? null;
  const got = stem ?? engine.buffer(bgm.wav);
  if (!got) {
    if (!s.loading && aget().status !== 'loading') {
      aset({ src: null, status: 'nosource', data: null, ...specReset() });
      setDrumSource(null);
    }
    return;
  }
  const name = stem ? stem.name : ((wavPath(s.doc, bgm.wav) ?? '').split(/[\\/]/).pop() ?? '');
  // ドラムの採譜も同じ音で（別スレッド。同じ音はやり直さない）
  setDrumSource({ key: got.key, buf: got.buf, name });
  const cur = aget();
  if (cur.src?.key === got.key && (cur.status === 'ready' || cur.status === 'loading')) {
    // 同じ音のまま名前だけ変わったとき（ステムの名前を変えた）も表示を合わせる
    if (cur.src.wav !== bgm.wav || cur.src.name !== name) aset({ src: { ...cur.src, wav: bgm.wav, name } });
    return;
  }
  if (running === got.key) return;
  running = got.key;
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

/** 作っている最中のスペクトル（音の key と見せ方） */
let specInflight = '';
/** いま出しているスペクトル（音の key と見せ方） */
let specShown = '';

function specWant(): string | null {
  const key = specSrc ? specSrc.key : aget().src?.key;
  return key ? `${key}|${aget().specMode}` : null;
}

/** スペクトルを作る（同じ音で見せ方だけ変えたときは、測り直さずに速く作る） */
export async function loadSpectrogram() {
  const a = aget();
  const own = specSrc;
  const key = own ? own.key : a.src?.key;
  const want = specWant();
  if (!key || !want || specInflight === want) return;
  if (a.spectroStatus === 'ready' && a.spectro && specShown === want) return;
  specInflight = want;
  // 見せ方を変えるあいだは前のスペクトルを出しておく（ちらつかせない）
  aset({ spectroStatus: 'loading', specProgress: 0 });
  const mode = a.specMode;
  try {
    if (own) await wk.loadAudio(own.key, own.buf);
    const sp = await wk.spectrogram(key, mode, (p) => {
      if (specWant() === want) aset({ specProgress: p });
    });
    if (specWant() === want) {
      specShown = want;
      aset({ spectro: sp, spectroStatus: 'ready', specProgress: 1 });
    }
  } catch {
    if (specWant() === want) aset({ spectroStatus: 'error' });
  } finally {
    if (specInflight === want) specInflight = '';
    // 作っている間に見せ方や音が変わっていたら、続けて作る
    const now = specWant();
    if (now && now !== want && aget().waveMode === 'spec' && specInflight !== now) void loadSpectrogram();
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
  if (src) setWaveMode('spec');
  else if (aget().waveMode === 'spec') void loadSpectrogram();
}

export function setWaveMode(m: 'wave' | 'spec') {
  aset({ waveMode: m });
  saveSpecPrefs();
  if (m === 'spec') void loadSpectrogram();
}

/** スペクトルの見せ方を変える（ドラム強調・アタック・そのまま） */
export function setSpecMode(m: SpecMode) {
  if (aget().specMode === m) return;
  aset({ specMode: m });
  saveSpecPrefs();
  if (aget().waveMode === 'spec') void loadSpectrogram();
}

export function setSpecGain(g: number) {
  aset({ specGain: Math.max(0.4, Math.min(3, g)) });
  saveSpecPrefs();
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

/** AI のフレーズ候補に渡す原曲の打点：ドラムの採譜ができていればその5種、無ければ3帯域 */
export function aiOnsets(): OnsetRows | null {
  return drumHitsByClass(aget().sensitivity) ?? bandOnsets();
}

// ---- ループ・速度・ミックス ----------------------------------------------------------

/** ループの範囲を決める（null で消す）。A だけ・B だけの印も消える */
export function setLoop(loop: LoopBeats | null, opts: { engine?: boolean } = {}) {
  aset({ loop, loopMark: null });
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

/**
 * ループのオン・オフ。範囲が無ければ、選んだチップの小節か今の位置の小節で作る。
 * A だけ・B だけ決めているときは、もう片方を勝手に作らずに知らせる。
 */
export function toggleLoop() {
  const { loop, loopMark } = aget();
  if (loop) {
    setLoop({ ...loop, on: !loop.on });
    return;
  }
  if (loopMark) {
    toast(
      loopMark.side === 'a'
        ? tr('ループの終わり（B）がまだ決まっていません。B ボタンか O キーで決めるとループします', "The loop end (B) isn't set yet. Set it with the B button or the O key to loop")
        : tr('ループの始まり（A）がまだ決まっていません。A ボタンか I キーで決めるとループします', "The loop start (A) isn't set yet. Set it with the A button or the I key to loop"),
    );
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
 * 今の位置を A（ループの始まり）か B（終わり）にする。もう片方も決まっていれば、その範囲でループする。
 * もう片方がまだなら、押した方だけを決めておく（B を押すまでは A だけ）。
 * A を B 以降に、B を A 以前に置いたときは、もう片方を消して押した方だけにする。
 */
export function setLoopPoint(which: 'a' | 'b', beat = hereBeat()) {
  // ループの端は拍に吸着する（聴きながら押すと少し遅れるので、近い拍へ）
  const at = snapBeat(beat, LOOP_DIV);
  const { loop, loopMark } = aget();
  const next = placeLoopPoint({ loop, mark: loopMark }, which, at);
  aset({ loop: next.loop, loopMark: next.mark });
  applyLoopToEngine();
}

/** ループの端を吸着させる細かさ（4 = 拍） */
export const LOOP_DIV = 4;

/** ループの範囲をドラッグで変える（譜面・下の波形・全体図で共通）。mark は A だけ・B だけの印 */
export type LoopDragMode = LoopGrab;
export interface LoopDrag {
  mode: LoopDragMode;
  /** 押したところの拍 */
  origin: number;
  a0: number;
  b0: number;
  moved: boolean;
}

/**
 * どこを掴んだか（A・B の印の近く・範囲の中・空いた所）。
 * tab: 線の外側に出ている印の長さ（拍。A の印は線の前、B の印は後ろ）。印の上を押しても端を掴む
 */
export function loopGrab(beat: number, tol: number, tab = tol): LoopDragMode {
  const { loop, loopMark } = aget();
  return grabLoop({ loop, mark: loopMark }, beat, tol, tab);
}

export function beginLoopDrag(beat: number, tol: number, tab = tol): LoopDrag {
  const l = aget().loop;
  return { mode: loopGrab(beat, tol, tab), origin: beat, a0: l?.a ?? beat, b0: l?.b ?? beat, moved: false };
}

/** ドラッグ中：ループを書き換える（エンジンへは離したときに渡す） */
export function dragLoop(d: LoopDrag, beat: number, div: number, movedPx: boolean) {
  if (!d.moved && !movedPx) return;
  d.moved = true;
  const snap = (x: number) => snapBeat(x, div);
  const step = 4 / div;
  const on = true;
  if (d.mode === 'mark') {
    // A だけ・B だけの印を動かす（範囲が無いのでエンジンは変わらない）
    const mk = aget().loopMark;
    if (mk) aset({ loopMark: { side: mk.side, beat: snap(beat) } });
    return;
  }
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
    edit(tr(`似た小節 ${to.length} 個にまとめて反映`, `Apply to ${to.length} similar ${pl(to.length, 'measure')}`), (d) => {
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
  aset({ loop: null, loopMark: null, similarPin: null });
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
