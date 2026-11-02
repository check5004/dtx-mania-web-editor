// テンポ合わせ画面の状態（譜面に反映するまでは「案」として持つ）。
import { produce } from 'immer';
import { create } from 'zustand';
import { combinedOdf, downbeatPhase, trackBeats } from '../audio/analysis';
import { engine } from '../audio/engine';
import { fitTaps } from '../assist/tapTempo';
import { anchorsFromDoc, applyPlan, evaluatePlan, normalizeAnchors, type PlanResult, type TempoAnchor, type TempoPlan } from '../assist/tempoPlan';
import { CH, drumChannel, type DtxDoc } from '../dtx/model';
import { useAssist } from './assist';
import { bgmSource, clickTimes, soundEvents, tempoOf } from './derived';
import { edit, playEndSec, songEndSec, stop as stopChart, toast, useEditor } from './editor';
import { setAnchors, useSidecar } from './sidecar';

export interface TempoUiState {
  initialized: boolean;
  /** 推定から作った案のまま（触っていない） */
  fromEstimate: boolean;
  touched: boolean;
  plan: TempoPlan;
  /** 拡大表示の範囲（原曲の秒） */
  view: { from: number; to: number };
  ghostGrid: boolean;
  pickStart: boolean;
  taps: number[];
  tapBpm: number | null;
  /** 拍の推定（原曲の秒） */
  beats: number[];
  downbeats: number[];
  beatsFor: number;
  playing: boolean;
}

export const useTempo = create<TempoUiState>(() => ({
  initialized: false,
  fromEstimate: false,
  touched: false,
  plan: { bpm: 120, anchors: [] },
  view: { from: 0, to: 10 },
  ghostGrid: true,
  pickStart: false,
  taps: [],
  tapBpm: null,
  beats: [],
  downbeats: [],
  beatsFor: 0,
  playing: false,
}));

const get = useTempo.getState;
const set = useTempo.setState;

// 別の譜面を開いたら作り直す
useEditor.subscribe((s, prev) => {
  if (s.meta !== prev.meta) set({ initialized: false, beats: [], downbeats: [], beatsFor: 0, taps: [], tapBpm: null });
});

let resultMemo: { doc: DtxDoc; plan: TempoPlan; r: PlanResult } | null = null;

export function planResult(): PlanResult {
  const doc = useEditor.getState().doc;
  const plan = get().plan;
  if (resultMemo && resultMemo.doc === doc && resultMemo.plan === plan) return resultMemo.r;
  const r = evaluatePlan(doc, plan);
  resultMemo = { doc, plan, r };
  return r;
}

/** 案での「原曲の0秒」が譜面の何秒か */
export function planBgmSec(r: PlanResult = planResult()): number {
  if (r.bgm) return r.bgm.sec;
  const bgm = bgmSource(useEditor.getState().doc);
  return bgm?.sec ?? 0;
}

/** 案での小節の頭（原曲の秒） */
export function measureTime(m: number, r: PlanResult = planResult()): number {
  return r.tempo.beatToSec(r.tempo.measureStart(m)) - planBgmSec(r);
}

function hasDrums(doc: DtxDoc): boolean {
  return doc.chips.some((c) => drumChannel(c.ch));
}

function viewAround(t: number, bpm: number) {
  const bar = 240 / Math.max(30, bpm);
  return { from: Math.max(-0.5, t - bar * 0.6), to: t + bar * 4.4 };
}

/** 画面を開いたときに案を作る */
export function initTempo() {
  const s = get();
  const doc = useEditor.getState().doc;
  const a = useAssist.getState();
  const tempo = tempoOf(doc);
  const bgm = bgmSource(doc);
  if (s.initialized) return;
  const saved = useSidecar.getState().anchors;
  let anchors: TempoAnchor[];
  let fromEstimate = false;
  let bpm = tempo.initialBpm;
  if (saved.length) {
    anchors = normalizeAnchors(saved);
  } else if (bgm) {
    anchors = anchorsFromDoc(tempo, bgm.sec, songEndSec(doc));
    // 新しい譜面（ドラムが無く、BPMも変わらない）なら推定から案を作る
    if (!hasDrums(doc) && tempo.events.length <= 1 && a.data?.tempo.length) {
      const est = estimatePlan();
      if (est) {
        anchors = est.anchors;
        bpm = est.bpm;
        fromEstimate = true;
      }
    }
  } else {
    anchors = [];
  }
  const first = anchors[0];
  set({
    initialized: true,
    fromEstimate,
    touched: false,
    plan: { bpm, anchors },
    view: viewAround(first ? first.t : 0, bpm),
  });
  updateBeats();
}

/** 解析の結果から案を作る（いちばん合うBPM、最初の強拍を1小節目） */
function estimatePlan(): TempoPlan | null {
  const a = useAssist.getState();
  if (!a.data || a.data.tempo.length === 0) return null;
  const bpm = Math.round(a.data.tempo[0].bpm * 100) / 100;
  const { downbeats } = computeBeats(bpm);
  if (downbeats.length === 0) return { bpm, anchors: [{ m: 1, t: a.data.tempo[0].phase }] };
  const first = firstMusicalDownbeat(downbeats);
  const r = evaluatePlan(useEditor.getState().doc, { bpm, anchors: [{ m: 1, t: first }] });
  const m = 1 + r.shift;
  return { bpm, anchors: [{ m, t: first }] };
}

/** 音が鳴り始めてからの最初の強拍 */
function firstMusicalDownbeat(downbeats: number[]): number {
  const a = useAssist.getState();
  if (!a.data) return downbeats[0];
  const odf = a.data.odf.low;
  const fr = a.data.frameRate;
  let start = 0;
  let max = 0;
  for (let i = 0; i < odf.length; i++) max = Math.max(max, odf[i]);
  for (let i = 0; i < odf.length; i++) {
    if (odf[i] > max * 0.3) {
      start = i / fr;
      break;
    }
  }
  return downbeats.find((d) => d >= start - 0.08) ?? downbeats[0];
}

function computeBeats(bpm: number): { beats: number[]; downbeats: number[] } {
  const a = useAssist.getState();
  if (!a.data) return { beats: [], downbeats: [] };
  const fr = a.data.frameRate;
  const odf = combinedOdf(a.data.odf);
  const frames = trackBeats(odf, fr, bpm);
  const beats = frames.map((f) => f);
  const phase = downbeatPhase(beats, a.data.odf, fr, 4);
  const downbeats: number[] = [];
  for (let k = phase; k < beats.length; k += 4) downbeats.push(beats[k]);
  return { beats, downbeats };
}

/** 拍の推定を今のBPMでやり直す */
export function updateBeats(force = false) {
  const s = get();
  const bpm = s.plan.bpm;
  if (!force && s.beatsFor === bpm && s.beats.length) return;
  const { beats, downbeats } = computeBeats(bpm);
  set({ beats, downbeats, beatsFor: beats.length ? bpm : 0 });
}

/** 解析が終わったら（推定の案のまま触っていなければ）作り直す */
useAssist.subscribe((a, prev) => {
  if (a.data === prev.data || !a.data) return;
  const s = get();
  if (!s.initialized) return;
  if (!s.touched && useEditor.getState().page === 'tempo') {
    set({ initialized: false });
    initTempo();
  } else {
    updateBeats(true);
  }
});

function touch(plan: TempoPlan) {
  set({ plan, touched: true, fromEstimate: false });
}

export function setPlanBpm(bpm: number) {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) return;
  touch({ ...get().plan, bpm: Math.round(bpm * 1000) / 1000 });
  updateBeats();
}

/** アンカーを置く（同じ小節は置き換え、時刻が逆になるものは外す） */
export function putAnchor(m: number, t: number) {
  const others = get().plan.anchors.filter((a) => a.m !== m && (a.m < m ? a.t < t - 0.05 : a.t > t + 0.05));
  touch({ ...get().plan, anchors: normalizeAnchors([...others, { m, t }]) });
}

export function removeAnchor(m: number) {
  const anchors = get().plan.anchors.filter((a) => a.m !== m);
  if (anchors.length === 0) return;
  touch({ ...get().plan, anchors });
}

export function nudgeFirst(dSec: number) {
  const anchors = normalizeAnchors(get().plan.anchors);
  if (!anchors.length) return;
  const [first, ...rest] = anchors;
  touch({ ...get().plan, anchors: normalizeAnchors([{ m: first.m, t: Math.max(0, first.t + dSec) }, ...rest]) });
}

/** 1小節目の頭を原曲の t 秒にする（ほかのアンカーはそのまま） */
export function setStart(t: number) {
  const anchors = normalizeAnchors(get().plan.anchors);
  const m = anchors[0]?.m ?? 1;
  const rest = anchors.slice(1).filter((a) => a.t > t + 0.05);
  const plan = { ...get().plan, anchors: [{ m, t }, ...rest] };
  // BGM を置けなければ小節番号をうしろへ
  const r = evaluatePlan(useEditor.getState().doc, plan);
  if (!r.bgm && r.shift > 0 && rest.length === 0) plan.anchors = [{ m: m + r.shift, t }];
  touch(plan);
  set({ pickStart: false });
}

/** アンカーの小節番号をまとめてずらす */
export function shiftAnchors(k: number) {
  touch({ ...get().plan, anchors: get().plan.anchors.map((a) => ({ ...a, m: a.m + k })) });
}

export function resetToEstimate() {
  const est = estimatePlan();
  if (!est) {
    toast('原曲の解析が終わっていないため推定できません', 'warn');
    return;
  }
  set({ plan: est, touched: true, fromEstimate: true, view: viewAround(est.anchors[0]?.t ?? 0, est.bpm) });
  updateBeats(true);
}

export function setView(v: { from: number; to: number }) {
  const len = Math.max(0.5, Math.min(120, v.to - v.from));
  set({ view: { from: v.from, to: v.from + len } });
}

// ---- タップ ----------------------------------------------------------------------

export function tap() {
  const now = performance.now();
  let taps = get().taps;
  if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
  taps = [...taps, now].slice(-32);
  const fit = fitTaps(taps.map((t) => t / 1000));
  set({ taps, tapBpm: fit ? Math.round(fit.bpm * 10) / 10 : null });
}

// ---- 再生 ------------------------------------------------------------------------

/** 案を反映した譜面（再生の確認用） */
function planDoc(): DtxDoc {
  const doc = useEditor.getState().doc;
  const r = planResult();
  return produce(doc, (d) => applyPlan(d, r, null));
}

export function playPlan(fromAudioSec: number) {
  stopChart();
  engine.ensure();
  const doc = planDoc();
  const bgm = bgmSource(doc);
  const off = bgm?.sec ?? 0;
  const startSec = Math.max(0, fromAudioSec + off);
  const end = playEndSec(doc, startSec);
  const events = soundEvents(doc).filter((e) => e.bus === 'bgm');
  engine.setForceClick(true);
  engine.play({
    events,
    clicks: clickTimes(doc, 0, end + 2),
    startSec,
    endSec: end,
    onEnd: () => {
      engine.setForceClick(false);
      set({ playing: false });
    },
  });
  set({ playing: true });
}

export function stopPlan() {
  engine.stop();
  engine.setForceClick(false);
  set({ playing: false });
}

/** 再生中の位置（原曲の秒） */
export function playAudioSec(): number | null {
  const sec = engine.currentSec();
  if (sec === null || !get().playing) return null;
  return sec - planBgmSec();
}

// ---- 反映 ------------------------------------------------------------------------

export function applyTempo(): boolean {
  const s = get();
  const doc = useEditor.getState().doc;
  const r = planResult();
  const anchors = normalizeAnchors(s.plan.anchors);
  if (anchors.length && !r.bgm) {
    toast(`1小節目の頭が原曲の始まりから遠いため、BGMを置けません。小節番号を ${r.shift} 個うしろにしてください。`, 'warn', 6000);
    return false;
  }
  const hadBgm = doc.chips.some((c) => c.ch === CH.BGM);
  const ok = edit('テンポ合わせを反映', (d) => applyPlan(d, r, null));
  setAnchors(anchors);
  set({ touched: false, fromEstimate: false });
  toast(ok ? `譜面に反映しました（${r.segs.length > 1 ? `BPM変化 ${r.segs.length - 1} か所` : `BPM ${r.segs[0].bpm}`}${hadBgm ? '・BGMの位置' : ''}）` : '譜面は今のままで合っています', 'ok');
  return ok;
}

/** 原曲（BGMチップ）が無い譜面に、WAV を原曲として置く */
export function chooseBgm(no: number) {
  edit('原曲（BGM）を置く', (d) => {
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 0, f: { n: 0, d: 1 }, v: no });
  });
  set({ initialized: false });
}
