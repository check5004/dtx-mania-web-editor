// 原曲をブラウザの中でステムに分解する（ドラムと、ドラム抜き。または楽器ごと）。
// 分解した音は OGG にして曲フォルダの stems/ に置き、ステムのトラックとして読み込む。
// そのあと「ドラム抜きを BGM にする」（細かく決めるならステムとミックスの書き出しの BGM用）で DTX の BGM にできる。
import { create } from 'zustand';
import { encodeAudio } from '../audio/stems';
import { AUDIO_EXT, findFile, putFile, type FolderFile } from '../fs/folder';
import { clearSavedModels, decodeForSeparation, savedModels, separate, SeparateError, webgpuStatus, type SepProgress } from '../separate/client';
import { SEP_MODELS, SEP_SR, type SepModelId, type SepPrecision } from '../separate/models';
import { plannedFiles, sourceNameInfo, type SepOutputs } from '../separate/names';
import { bgmSource, wavPath } from './derived';
import { openPage, openedDocs, toast, useEditor } from './editor';
import { useSidecar } from './sidecar';
import { chooseAnalysisStem, defaultExportName, exportStems, importStems, removeStem } from './stems';

export type { SepOutputs };
export { plannedFiles };

export type SepPhase = 'idle' | 'read' | 'check' | 'download' | 'compile' | 'run' | 'encode' | 'import' | 'done' | 'error';

export interface SepSummary {
  model: SepModelId;
  outputs: SepOutputs;
  backend: string;
  precision: string;
  gpu: string;
  /** かかった時間（秒）と曲の長さ（秒） */
  seconds: number;
  songSec: number;
  files: string[];
}

export interface SeparateState {
  model: SepModelId;
  outputs: SepOutputs;
  /** 今あるステムを外して置き換える */
  replace: boolean;
  phase: SepPhase;
  /** 今の段階の進み（0〜1） */
  progress: number;
  detail: string;
  /** 分解（モデルの計算）を始めた時刻（残り時間の見積もり用） */
  runStart: number;
  error: string | null;
  last: SepSummary | null;
  /** WebGPU が使えるか（調べる前は null） */
  gpu: { ok: boolean; f16: boolean } | null;
  /** ステムとミックスの画面に分解のカードを出す */
  panelOpen: boolean;
  /** 分ける音（曲フォルダのパス）。null なら BGM（ドラム抜きなら元の原曲を探す） */
  source: string | null;
  /** ドラム抜きを BGM に登録したファイル */
  bgmSet: string | null;
  /** ブラウザに覚えてあるモデル（調べる前は null） */
  saved: { model: SepModelId; precision: SepPrecision; bytes: number }[] | null;
}

const PREF_KEY = 'dtxe.separate.v1';

function loadPrefs(): Pick<SeparateState, 'model' | 'outputs'> {
  try {
    const j = JSON.parse(localStorage.getItem(PREF_KEY) || 'null') as { model?: string; outputs?: string } | null;
    const model = j?.model && j.model in SEP_MODELS ? (j.model as SepModelId) : 'bs_roformer_sw';
    const outputs = j?.outputs === 'all' ? 'all' : 'two';
    return { model, outputs };
  } catch {
    return { model: 'bs_roformer_sw', outputs: 'two' };
  }
}

export const useSeparate = create<SeparateState>(() => ({
  ...loadPrefs(),
  replace: true,
  phase: 'idle',
  progress: 0,
  detail: '',
  runStart: 0,
  error: null,
  last: null,
  gpu: null,
  panelOpen: false,
  source: null,
  bgmSet: null,
  saved: null,
}));

const get = useSeparate.getState;
const set = useSeparate.setState;

// 別の譜面を開いたら、前の曲の分解は止めて、カードを初めの状態に戻す
let seenDocs = openedDocs;
useEditor.subscribe(() => {
  if (openedDocs === seenDocs) return;
  seenDocs = openedDocs;
  if (separating()) cancelSeparation();
  set({ phase: 'idle', progress: 0, detail: '', error: null, last: null, bgmSet: null, source: null, panelOpen: false });
});

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ model: get().model, outputs: get().outputs }));
  } catch {
    // 覚えられなくても動く
  }
}

export function setSeparateModel(model: SepModelId) {
  set({ model });
  savePrefs();
}

export function setSeparateOutputs(outputs: SepOutputs) {
  set({ outputs });
  savePrefs();
}

export function setSeparateReplace(replace: boolean) {
  set({ replace });
}

/** ステムとミックスの画面を開き、分解のカードを出す */
export function openSeparation() {
  set({ panelOpen: true });
  openPage('stems');
}

/** 分解のカードを閉じる（分解中は閉じない） */
export function closeSeparationPanel() {
  if (separating()) return;
  set({ panelOpen: false, phase: 'idle', error: null });
}

/** WebGPU が使えるかを調べておく（画面を開いたとき） */
export async function checkGpu() {
  if (get().gpu) return;
  const gpu = await webgpuStatus();
  set({ gpu });
  // GPU が使えなければ、CPU でも動くモデルにしておく（覚えた選び方はそのまま）
  if (!gpu.ok && SEP_MODELS[get().model].webgpuOnly && !separating()) set({ model: 'scnet_small' });
}

/** ブラウザに覚えてあるモデルを調べ直す */
export async function refreshSavedModels() {
  set({ saved: await savedModels() });
}

/** 覚えてあるモデルを消す（分解中は消さない） */
export async function clearModels() {
  if (separating()) return;
  await clearSavedModels();
  await refreshSavedModels();
  toast('ブラウザに保存した分解のモデルを消しました', 'info');
}

export function separating(): boolean {
  const p = get().phase;
  return p !== 'idle' && p !== 'done' && p !== 'error';
}

/** 分ける音の候補 */
export interface SepSource {
  path: string;
  name: string;
  /** できるファイルの名前の頭（ドラム抜きの印は外す） */
  base: string;
  size: number;
  /** 今の BGM */
  bgm: boolean;
  /** 名前からドラム抜きの音らしい（前に書き出した BGM など） */
  drumless: boolean;
}

function toSource(f: FolderFile, bgm: boolean): SepSource {
  const name = f.path.split('/').pop() ?? f.path;
  return { path: f.path, name, size: f.size, bgm, ...sourceNameInfo(name) };
}

/**
 * 分ける音の候補：曲フォルダの音声ファイルのうち、BGM と、どこにも使っていない長めの音。
 * 譜面の音（#WAV に書いた BGM 以外の音）・#PREVIEW・stems/ の中は除く。
 */
export function separationSources(): SepSource[] {
  const s = useEditor.getState();
  const folder = s.folder;
  if (!folder) return [];
  const pathWav = s.doc.fields['PATH_WAV'] ?? '';
  const bgm = bgmSource(s.doc);
  const bgmPath = bgm ? findFile(folder, wavPath(s.doc, bgm.wav) ?? '', pathWav)?.path : undefined;
  const used = new Set<string>();
  for (const [k, v] of Object.entries(s.doc.fields)) {
    if (!/^(WAV[0-9A-Z]{2}|PREVIEW)$/i.test(k) || !v) continue;
    const f = findFile(folder, v, k === 'PREVIEW' ? '' : pathWav);
    if (f) used.add(f.path);
  }
  const out: SepSource[] = [];
  for (const f of folder.files.values()) {
    if (!AUDIO_EXT.test(f.name)) continue;
    const isBgm = f.path === bgmPath;
    if (!isBgm && (used.has(f.path) || /^stems\//i.test(f.path) || f.size < 500_000)) continue;
    out.push(toSource(f, isBgm));
  }
  return out.sort((a, b) => Number(b.bgm) - Number(a.bgm) || Number(a.drumless) - Number(b.drumless) || a.path.localeCompare(b.path));
}

/** 分ける音。選んでいなければ BGM。BGM がドラム抜きなら、同じ名前の元の原曲（ドラム入り）があればそれ */
export function separationSource(): SepSource | { error: string } {
  const list = separationSources();
  const chosen = get().source;
  const pick = chosen ? list.find((x) => x.path === chosen) : undefined;
  if (pick) return pick;
  const bgm = list.find((x) => x.bgm);
  if (!bgm) {
    const s = useEditor.getState();
    const b = bgmSource(s.doc);
    if (!b) return { error: '原曲（BGM）がありません。右のパネルの「原曲」から音声ファイルを読み込んでください' };
    return { error: `原曲のファイル「${wavPath(s.doc, b.wav) || '（なし）'}」が曲フォルダに見つかりません` };
  }
  if (!bgm.drumless) return bgm;
  return list.find((x) => !x.drumless && x.base.toLowerCase() === bgm.base.toLowerCase()) ?? bgm;
}

export function setSeparationSource(path: string | null) {
  set({ source: path });
}

let abort: AbortController | null = null;

export function cancelSeparation() {
  abort?.abort();
}

const STAGE_TEXT: Record<SepProgress['stage'], string> = {
  check: 'GPU を調べています…',
  download: 'モデルを読み込んでいます…',
  compile: 'モデルを準備しています…',
  run: '分解しています…',
};

/** 原曲を分解して、ステムのトラックにする */
export async function startSeparation(): Promise<boolean> {
  if (separating()) return false;
  const src = separationSource();
  if ('error' in src) {
    set({ phase: 'error', error: src.error });
    return false;
  }
  const { model: modelId, outputs, replace } = get();
  const model = SEP_MODELS[modelId];
  const plan = plannedFiles(modelId, outputs, src.base);
  const t0 = performance.now();
  abort = new AbortController();
  const signal = abort.signal;
  set({ phase: 'read', progress: 0, detail: `${src.name} を読み込んでいます…`, error: null, runStart: 0, bgmSet: null });
  const opened = openedDocs;
  try {
    const folder0 = useEditor.getState().folder;
    const ff = findFile(folder0, src.path);
    if (!ff) throw new SeparateError('run', '原曲のファイルが見つかりません');
    const audio = await decodeForSeparation(await (await ff.getFile()).arrayBuffer());
    if (signal.aborted) throw new SeparateError('abort', '中止しました');
    const songSec = audio.duration;
    const want = plan.flatMap((p) => (p.stem === 'rest' ? [] : [p.stem]));
    const r = await separate(audio.left, audio.right, {
      model: modelId,
      want,
      rest: true,
      signal,
      onProgress: (p) => {
        const s = get();
        const runStart = p.stage === 'run' && !s.runStart ? performance.now() : s.runStart;
        let detail = STAGE_TEXT[p.stage];
        if (p.stage === 'download') detail = p.cached ? 'ブラウザに保存したモデルを読み込んでいます…' : `モデルをダウンロードしています… ${Math.round(p.done / 2 ** 20)} / ${Math.round(p.total / 2 ** 20)} MB（初回だけ）`;
        if (p.stage === 'run' && p.total) {
          detail = `分解しています… ${p.done} / ${p.total} 区切り`;
          if (p.done > 0) {
            const left = ((performance.now() - runStart) / p.done) * (p.total - p.done);
            detail += `（残り 約${formatSec(left / 1000)}）`;
          }
        }
        set({ phase: p.stage, progress: p.total ? p.done / p.total : 0, detail, runStart });
      },
    });
    // 分解している間に別の譜面を開いたら、その譜面には入れない
    const moved = () => openedDocs !== opened;
    if (moved()) throw new SeparateError('run', '分解している間に別の譜面を開いたので、分けた音は読み込みませんでした');
    // OGG にする
    const files: File[] = [];
    for (const [i, p] of plan.entries()) {
      const ch = p.stem === 'rest' ? r.rest : r.stems[p.stem];
      if (!ch) continue;
      set({ phase: 'encode', progress: i / plan.length, detail: `${p.name} を書き出しています…` });
      const buf = new AudioBuffer({ numberOfChannels: 2, length: ch[0].length, sampleRate: SEP_SR });
      buf.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(ch[1] as Float32Array<ArrayBuffer>, 1);
      const bytes = await encodeAudio(buf, 'ogg', (q) => set({ progress: (i + q) / plan.length }));
      if (signal.aborted) throw new SeparateError('abort', '中止しました');
      files.push(new File([bytes as Uint8Array<ArrayBuffer>], p.name, { type: 'audio/ogg' }));
    }
    if (moved()) throw new SeparateError('run', '分解している間に別の譜面を開いたので、分けた音は読み込みませんでした');
    // 曲フォルダの stems/ に置いて、トラックにする
    set({ phase: 'import', progress: 0, detail: 'ステムのトラックにしています…' });
    const targets = new Set(files.map((f) => `stems/${f.name}`.toLowerCase()));
    for (const t of [...useSidecar.getState().stems]) {
      // 前に分解した同じ名前のトラックは置き換える。ほかのステムは「置き換える」のときだけ外す（ファイルは消さない）
      if (replace || targets.has(t.file.toLowerCase())) removeStem(t.file);
    }
    const folder = useEditor.getState().folder;
    if (folder) for (const f of files) await putFile(folder, `stems/${f.name}`, f);
    const n = await importStems(files);
    const drums = useSidecar.getState().stems.find((t) => t.file.toLowerCase() === `stems/${plan[0].name}`.toLowerCase() && t.kind === 'drums');
    if (drums) chooseAnalysisStem(drums.file);
    const seconds = (performance.now() - t0) / 1000;
    set({
      phase: 'done',
      progress: 1,
      detail: '',
      last: { model: modelId, outputs, backend: r.backend, precision: r.precision, gpu: r.gpu, seconds, songSec, files: files.map((f) => f.name) },
    });
    toast(`${model.name} で ${n} 本に分けました（${formatSec(seconds)}）`, 'ok', 6000);
    void refreshSavedModels();
    return true;
  } catch (e) {
    const err = e as SeparateError;
    if (err?.code === 'abort') {
      set({ phase: 'idle', progress: 0, detail: '', error: null });
      toast('分解を中止しました', 'info');
      return false;
    }
    let msg = err?.message || String(e);
    if (err?.code === 'no-webgpu') msg += '。Chrome か Edge の新しい版で開くか、SCNet small（CPU でも動く）を選んでください';
    // GPU のメモリが足りないなど：軽いモデルを勧める
    else if ((err?.code === 'compile' || err?.code === 'run') && modelId !== 'scnet_small')
      msg += `${/メモリ/.test(msg) ? '' : '。GPU のメモリが足りない可能性があります'}。ほかのタブを閉じるか、軽いモデル（SCNet XL・SCNet small）で試してください`;
    set({ phase: 'error', error: msg, detail: '' });
    return false;
  } finally {
    abort = null;
    void refreshSavedModels();
  }
}

/** ドラム抜きの BGM のファイル名（曲フォルダの直下。原曲は上書きしない名前） */
export function drumlessBgmName(): string {
  return defaultExportName('bgm', 'ogg');
}

/**
 * 分けたステムのうちドラム以外を1本にまとめて書き出し、DTX の BGM（#WAV）に登録する。
 * 音量は原曲のまま（揃えない）。元の原曲のファイルは消さない。書いたファイル名を返す
 */
export async function registerDrumlessBgm(fileName = drumlessBgmName()): Promise<string | null> {
  const stems = useSidecar.getState().stems;
  const mine = new Set((get().last?.files ?? []).map((f) => `stems/${f}`.toLowerCase()));
  const pool = mine.size ? stems.filter((t) => mine.has(t.file.toLowerCase())) : stems;
  const include = pool.filter((t) => t.kind !== 'drums').map((t) => t.file);
  if (!include.length) {
    toast('ドラム以外のステムがありません', 'warn');
    return null;
  }
  const written = await exportStems({ mode: 'bgm', include, useTrackSettings: false, normalize: false, range: 'song', format: 'ogg', fileName, register: 'bgm' });
  if (!written.length) return null;
  set({ bgmSet: written[0] });
  return written[0];
}

export function formatSec(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.max(1, Math.round(s))}秒`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m}分${r}秒` : `${m}分`;
}
