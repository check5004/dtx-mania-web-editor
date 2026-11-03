// 原曲のドラムの採譜（ADTOF）の状態。解析元の音（BGM か、解析元に選んだステム）が決まったら、別スレッドで採譜する。
// 結果は「原曲の打点」の列（5種）、TAB補完の「原曲と照合」、AI のフレーズ候補に渡す原曲の打点に使う。
// 一度採譜した音はブラウザに覚えておき（transcribe/client）、次に開いたときはすぐ出す。
import { create } from 'zustand';
import type { DrumClass } from '../bench/classes';
import { transcribe, type TranscribeStage } from '../transcribe/client';
import { ADTOF, type DrumActivations } from '../transcribe/model';
import { drumHits, type DrumHit } from '../transcribe/peaks';

export interface DrumState {
  /** 採譜モデルを使う（設定。ブラウザに覚える） */
  enabled: boolean;
  /** 採譜している・した音 */
  key: string | null;
  name: string;
  status: 'none' | 'loading' | 'ready' | 'error';
  stage: TranscribeStage | null;
  progress: number;
  error: string | null;
  data: DrumActivations | null;
}

const KEY = 'dtxe.drums.v1';

function loadEnabled(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(KEY) || '{}') as { enabled?: boolean }).enabled !== false;
  } catch {
    return true;
  }
}

export const useDrums = create<DrumState>(() => ({
  enabled: loadEnabled(),
  key: null,
  name: '',
  status: 'none',
  stage: null,
  progress: 0,
  error: null,
  data: null,
}));

const get = useDrums.getState;
const set = useDrums.setState;

interface Source {
  key: string;
  buf: AudioBuffer;
  name: string;
}

/** いまの解析元の音（assist が渡す） */
let source: Source | null = null;
let running = '';

/** 解析元の音が決まった・変わった（null で無し） */
export function setDrumSource(src: Source | null) {
  source = src;
  if (!src) {
    running = '';
    if (get().key !== null) set({ key: null, name: '', status: 'none', stage: null, progress: 0, error: null, data: null });
    return;
  }
  requestDrums();
}

/** 解析元の音を採譜する（同じ音はやり直さない） */
export function requestDrums() {
  const src = source;
  if (!src || !get().enabled) return;
  const cur = get();
  if (cur.key === src.key && (cur.status === 'ready' || cur.status === 'loading')) return;
  if (running === src.key) return;
  running = src.key;
  set({ key: src.key, name: src.name, status: 'loading', stage: 'prepare', progress: 0, error: null, data: null });
  const channels = Array.from({ length: Math.min(2, src.buf.numberOfChannels) }, (_, i) => src.buf.getChannelData(i));
  transcribe(channels, src.buf.sampleRate, {
    key: `${src.key}|${src.buf.sampleRate}|${src.buf.length}`,
    onProgress: (stage, p) => {
      if (running === src.key) set({ stage, progress: p });
    },
  })
    .then((data) => {
      if (get().key !== src.key) return;
      set({ status: 'ready', data, stage: null, progress: 1 });
    })
    .catch((e: unknown) => {
      if (get().key === src.key) set({ status: 'error', error: (e as Error)?.message || String(e), stage: null });
    })
    .finally(() => {
      if (running === src.key) running = '';
    });
}

export function setDrumsEnabled(on: boolean) {
  set({ enabled: on });
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled: on }));
  } catch {
    // 覚えられなくても、この画面の間は効く
  }
  if (on) requestDrums();
  else {
    running = '';
    set({ key: null, status: 'none', stage: null, progress: 0, error: null, data: null });
  }
}

/** 採譜の結果が使えるか（使える結果を返す） */
export function readyDrums(): DrumActivations | null {
  const d = get();
  return d.enabled && d.status === 'ready' && d.data && d.key !== null && d.key === source?.key ? d.data : null;
}

/**
 * 原曲にドラムが聞こえるとみなす、採譜したバスドラム・スネアの1分あたりの数。
 * 2026-11-03 の手元の曲で、ドラム入りの原曲は 300 前後、ドラム抜きの BGM（bgm_d.ogg）は 2 だった
 */
const AUDIBLE_PER_MIN = 20;
let audibleMemo: { data: DrumActivations; v: boolean } | null = null;

/** 原曲にドラムが聞こえるか（ドラム抜きの BGM なら false）。採譜がまだなら null */
export function drumsAudible(): boolean | null {
  const data = readyDrums();
  if (!data) return null;
  if (audibleMemo?.data === data) return audibleMemo.v;
  const dur = data.frames / data.fps;
  let n = 0;
  for (const h of drumHits(data, 0.5)) if (h.cls === 'BD' || h.cls === 'SD') n++;
  const v = dur > 0 && (n / dur) * 60 >= AUDIBLE_PER_MIN;
  audibleMemo = { data, v };
  return v;
}

export type DrumHitsByClass = Record<DrumClass, DrumHit[]>;

let hitsMemo: { data: DrumActivations; sens: number; out: DrumHitsByClass } | null = null;

/** 種類ごとの打点（時刻は音の頭が 0 秒）。sensitivity は「打点の感度」（0.5 が作者の閾値） */
export function drumHitsByClass(sensitivity: number): DrumHitsByClass | null {
  const data = readyDrums();
  if (!data) return null;
  if (hitsMemo && hitsMemo.data === data && hitsMemo.sens === sensitivity) return hitsMemo.out;
  const out = Object.fromEntries(ADTOF.classes.map((c) => [c, [] as DrumHit[]])) as DrumHitsByClass;
  for (const h of drumHits(data, sensitivity)) out[h.cls].push(h);
  hitsMemo = { data, sens: sensitivity, out };
  return out;
}

/** 進み具合の表示 */
export function drumStatusText(d: DrumState): string {
  if (d.status === 'loading') {
    if (d.stage === 'model') return `採譜モデルを読み込み中… ${Math.round(d.progress * 100)}%`;
    if (d.stage === 'run') return `ドラムを採譜中… ${Math.round(d.progress * 100)}%`;
    return 'ドラムの採譜を準備中…';
  }
  if (d.status === 'error') return `採譜できませんでした: ${d.error ?? ''}`;
  return '';
}
