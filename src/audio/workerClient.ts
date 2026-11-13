// 解析ワーカーへの窓口。要求ごとに Promise を返す。
import { tr, getLang, subscribeLang } from '../i18n';
import type { AlignSearch, LocalSim } from './align';
import type { AnalysisData, TempoCandidate } from './analysis';
import type { ChorusFound, ChorusGrid } from './chorus';
import type { FrameFeatures } from './features';
import type { SpecMode, SpectroData, SpectroZones } from './spectro';

export type { SpectroData };

export interface StretchChunk {
  channels: Float32Array[];
  /** 出力の 0 サンプル目が、渡した音の何サンプル目か */
  fromSample: number;
  sr: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (p: number) => void };

let worker: Worker | null = null;
let nextId = 1;
// 言語を切り替えたら、ワーカーのエラーの文もその言語にする
subscribeLang(() => worker?.postMessage({ id: 0, type: 'lang', lang: getLang() }));
const pending = new Map<number, Pending>();
const loaded = new Set<string>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ id: 0, type: 'lang', lang: getLang() });
  worker.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; result?: unknown; error?: string; progress?: number }>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.progress !== undefined && m.ok === undefined) {
      p.progress?.(m.progress);
      return;
    }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || tr('解析に失敗しました', 'The analysis failed')));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || tr('解析の処理が止まりました', 'The analysis stopped')));
    pending.clear();
    loaded.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], progress?: (p: number) => void): Promise<T> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
    w.postMessage({ ...msg, id }, transfer);
  });
}

/** 音声をワーカーに渡す（同じキーは一度だけ） */
export async function loadAudio(key: string, buf: AudioBuffer): Promise<void> {
  if (loaded.has(key)) return;
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
  await call({ type: 'load', key, channels, sr: buf.sampleRate }, channels.map((c) => c.buffer));
  loaded.add(key);
  // ワーカーは7曲まで持つ（原曲とステムの解析）
  while (loaded.size > 7) loaded.delete(loaded.values().next().value!);
}

/** BPM の候補（いちばん合うもの・半分・倍）。新しい譜面を作る前に原曲から推定する（音は 1 本にまとめて渡し、ワーカーに残さない） */
export function tempoCandidates(buf: AudioBuffer): Promise<TempoCandidate[]> {
  const n = Math.min(2, buf.numberOfChannels);
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < n; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < x.length; i++) mono[i] += x[i] / n;
  }
  return call<TempoCandidate[]>({ type: 'tempo', channels: [mono], sr: buf.sampleRate }, [mono.buffer]);
}

export function analyze(key: string, progress?: (p: number) => void): Promise<AnalysisData> {
  return call<AnalysisData>({ type: 'analyze', key }, [], progress);
}

/** ドラムの耳コピ向けのスペクトル（同じ音で見せ方だけ変えるときは速い） */
export function spectrogram(key: string, mode: SpecMode, progress?: (p: number) => void): Promise<SpectroData> {
  return call<SpectroData>({ type: 'spectro', key, mode }, [], progress);
}

/** ドラム強調のスペクトルの帯ごとの明るさ（AI に渡す。スペクトルを作ってあれば速い） */
export function spectroZones(key: string, zones: readonly { from: number; to: number }[], progress?: (p: number) => void): Promise<SpectroZones> {
  return call<SpectroZones>({ type: 'zones', key, zones: zones.map(({ from, to }) => ({ from, to })) }, [], progress);
}

/** 小節どうしの聞こえ方を比べるための特徴（TAB補完の「曲の構造」） */
export function features(key: string, progress?: (p: number) => void): Promise<{ frames: FrameFeatures; duration: number }> {
  return call<{ frames: FrameFeatures; duration: number }>({ type: 'features', key }, [], progress);
}

/** サビを探す（曲情報の「サビから作る」）。grid は譜面の小節の頭と拍（曲の音の秒）。音に合っていなければ音から推定する */
export function chorus(key: string, grid: ChorusGrid | null, progress?: (p: number) => void): Promise<ChorusFound> {
  return call<ChorusFound>({ type: 'chorus', key, grid: grid ? { bars: [...grid.bars], beats: [...grid.beats] } : null }, [], progress);
}

/**
 * スロー再生用に、channels の from〜to サンプル目を rate 倍の速さにする（音程はそのまま）。
 * channels はワーカーへ渡してしまう（呼んだ側では使えなくなる）。ワーカーに音を残さないので、いくつ伸ばしても前の音を追い出さない
 */
export function stretch(channels: Float32Array[], sr: number, rate: number, from: number, to: number): Promise<StretchChunk> {
  return call<StretchChunk>({ type: 'stretch', channels, sr, rate, from, to }, channels.map((c) => c.buffer as ArrayBuffer));
}

/** YouTube との自動合わせ: 原曲の特徴を作っておく（同じ曲は一度だけ） */
export function alignRef(key: string, progress?: (p: number) => void): Promise<void> {
  return call<void>({ type: 'alignRef', key }, [], progress);
}

/** YouTube から聞き取った音（モノラル）を原曲と比べる。probe は、あとで所ごとに比べ直すときの番号 */
export function alignProbe(key: string, pcm: Float32Array, sr: number): Promise<AlignSearch & { probe: number }> {
  return call<AlignSearch & { probe: number }>({ type: 'alignProbe', key, pcm, sr }, [pcm.buffer as ArrayBuffer]);
}

/** 聞き取った音（頭が動画の v 秒）を、ずれ os ごとに所ごとに比べる（編集違いの切れ目を細かく決める） */
export function alignLocal(key: string, probe: number, v: number, os: number[]): Promise<{ local: LocalSim[]; floor: number }> {
  return call<{ local: LocalSim[]; floor: number }>({ type: 'alignLocal', key, probe, v, os });
}

/** 聞き取った音を、ずれ os ごとに短い窓で比べる（決まった切れ目を詰める） */
export async function alignFine(key: string, probe: number, v: number, os: number[]): Promise<LocalSim[]> {
  return (await call<{ local: LocalSim[]; floor: number }>({ type: 'alignLocal', key, probe, v, os, fine: true })).local;
}

export function isLoaded(key: string) {
  return loaded.has(key);
}
