// 耳コピアシストの状態：原曲の解析、候補チップ、ループ・速度・帯域フィルタ・ミュート、入力方法。
import { create } from 'zustand';
import { pickOnsets, type AnalysisData, type Band, type Onset } from '../audio/analysis';
import { engine, type BgmFilter, type StretchProvider } from '../audio/engine';
import * as wk from '../audio/workerClient';
import { classifyEvents, detectEvents, placeGhosts, GHOST_LANES, type Ghost, type GhostLane, type Hit } from '../assist/ghosts';
import { copyMeasureInto, measureSignatures, sameMeasures } from '../assist/similar';
import type { DtxDoc } from '../dtx/model';
import { bgmSource, tempoOf, wavPath } from './derived';
import { edit, placeChips, useEditor } from './editor';

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
  waveMode: 'wave' | 'spec';
  /** 譜面の右の「原曲の打点」「原曲の波形」の列を出すか */
  audioCols: boolean;
  ghostsOn: boolean;
  sensitivity: number;
  ghostLanes: Record<GhostLane, boolean>;
  dismissed: ReadonlySet<string>;
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
  waveMode: 'wave',
  audioCols: true,
  ghostsOn: true,
  sensitivity: 0.5,
  ghostLanes: { BD: true, SD: true, HH: true, CY: true },
  dismissed: new Set(),
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
    if (aget().status !== 'nosource') aset({ src: null, status: 'nosource', data: null, spectro: null, spectroStatus: 'none' });
    return;
  }
  const stem = analysisProvider?.() ?? null;
  const got = stem ?? engine.buffer(bgm.wav);
  if (!got) {
    if (!s.loading && aget().status !== 'loading') aset({ src: null, status: 'nosource', data: null, spectro: null, spectroStatus: 'none' });
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
  aset({ src: { wav: bgm.wav, key: got.key, name }, status: 'loading', progress: 0, error: null, data: null, spectro: null, spectroStatus: 'none', dismissed: new Set() });
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

export async function loadSpectrogram() {
  const a = aget();
  if (!a.src || a.spectroStatus === 'loading' || a.spectroStatus === 'ready') return;
  const key = a.src.key;
  aset({ spectroStatus: 'loading' });
  try {
    const sp = await wk.spectrogram(key);
    if (aget().src?.key === key) aset({ spectro: sp, spectroStatus: 'ready' });
  } catch {
    if (aget().src?.key === key) aset({ spectroStatus: 'error' });
  }
}

export function setWaveMode(m: 'wave' | 'spec') {
  aset({ waveMode: m });
  if (m === 'spec') void loadSpectrogram();
}

// ---- 候補チップ -------------------------------------------------------------------

let hitsMemo: { data: AnalysisData; sens: number; hits: Hit[] } | null = null;

/** 打点をレーンに振り分けたもの（感度ごとに覚えておく） */
export function analysisHits(): Hit[] {
  const a = aget();
  if (!a.data) return [];
  if (hitsMemo && hitsMemo.data === a.data && hitsMemo.sens === a.sensitivity) return hitsMemo.hits;
  const hits = classifyEvents(detectEvents(a.data, a.sensitivity));
  hitsMemo = { data: a.data, sens: a.sensitivity, hits };
  return hits;
}

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

let ghostMemo: { doc: DtxDoc; div: number; hits: Hit[]; lanes: object; dismissed: object; on: boolean; out: Ghost[] } | null = null;

/** 今の譜面に出す候補チップ */
export function currentGhosts(): Ghost[] {
  const a = aget();
  const s = useEditor.getState();
  if (!a.data || !a.ghostsOn) return [];
  const hits = analysisHits();
  const div = s.view.div;
  if (ghostMemo && ghostMemo.doc === s.doc && ghostMemo.div === div && ghostMemo.hits === hits && ghostMemo.lanes === a.ghostLanes && ghostMemo.dismissed === a.dismissed && ghostMemo.on === a.ghostsOn) {
    return ghostMemo.out;
  }
  const bgm = bgmSource(s.doc);
  const out = bgm ? placeGhosts(hits, s.doc, tempoOf(s.doc), { offsetSec: bgm.sec, div, lanes: a.ghostLanes, dismissed: a.dismissed }) : [];
  ghostMemo = { doc: s.doc, div, hits, lanes: a.ghostLanes, dismissed: a.dismissed, on: a.ghostsOn, out };
  return out;
}

export function ghostsInRange(from: number, to: number): Ghost[] {
  const g = currentGhosts();
  let lo = 0;
  let hi = g.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g[mid].beat < from) lo = mid + 1;
    else hi = mid;
  }
  const out: Ghost[] = [];
  for (let i = lo; i < g.length && g[i].beat <= to; i++) out.push(g[i]);
  return out;
}

export function dismissGhosts(keys: string[]) {
  if (keys.length === 0) return;
  const next = new Set(aget().dismissed);
  for (const k of keys) next.add(k);
  aset({ dismissed: next });
}

/** 候補チップを採用して本物のチップにする */
export function adoptGhosts(list: readonly Ghost[]): number {
  if (list.length === 0) return 0;
  placeChips(
    list.map((g) => ({ lane: g.lane, alt: false, pos: g.pos })),
    { label: list.length === 1 ? '候補を採用' : `候補を ${list.length} 個採用` },
  );
  return list.length;
}

/** 拍の範囲 [from, to) の候補を採用 */
export function adoptGhostsInRange(from: number, to: number): number {
  return adoptGhosts(ghostsInRange(from, to - 1e-9));
}

export function restoreGhosts() {
  aset({ dismissed: new Set() });
}

export function setGhostLane(l: GhostLane, on: boolean) {
  aset({ ghostLanes: { ...aget().ghostLanes, [l]: on } });
}

export { GHOST_LANES };

// ---- ループ・速度・ミックス ----------------------------------------------------------

export function setLoop(loop: LoopBeats | null) {
  aset({ loop });
  applyLoopToEngine();
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
  aset({ loop: null, dismissed: new Set(), similarPin: null });
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
