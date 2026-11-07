// テンポ合わせ画面の状態（エディタに反映するまでは「案」として持つ）。
// 案が譜面とちがうか（未反映・反映済み）を見せ、反映しないまま戻ろうとしたら聞く（leaveTempo）。
import { tr, pl } from '../i18n';
import { produce } from 'immer';
import { create } from 'zustand';
import { combinedOdf, downbeatPhase, trackBeats } from '../audio/analysis';
import { engine } from '../audio/engine';
import { fitTaps } from '../assist/tapTempo';
import { anchorsFromDoc, applyPlan, evaluatePlan, normalizeAnchors, type PlanResult, type TempoAnchor, type TempoPlan } from '../assist/tempoPlan';
import { CH, drumChannel, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { chooseDialog } from '../ui/dialogs';
import { useAssist } from './assist';
import { bgmSource, clickTimes, playbackEvents, tempoOf } from './derived';
import { backToChart, contentEndSec, edit, OPEN_END_SEC, stop as stopChart, toast, useEditor } from './editor';
import { setAnchors, useSidecar } from './sidecar';

export interface TempoUiState {
  initialized: boolean;
  /** 推定から作った案のまま（触っていない） */
  fromEstimate: boolean;
  touched: boolean;
  /** この画面でエディタに反映した（案を作り直すまで） */
  applied: boolean;
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
  applied: false,
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
  // 曲頭の BPM（000小節の頭の BPM チップは #BPM より先に効く）
  let bpm = tempo.events[0]?.bpm ?? tempo.initialBpm;
  if (saved.length) {
    anchors = normalizeAnchors(saved);
  } else if (bgm) {
    anchors = anchorsFromDoc(tempo, bgm.sec, contentEndSec(doc));
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
    applied: false,
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
    toast(tr('原曲の解析が終わっていないため推定できません', "Can't estimate until the original audio is analyzed"), 'warn');
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
  // テンポ合わせは原曲に合わせるので、曲の終わり（END）ではなく原曲の鳴り終わりまで流す
  const content = contentEndSec(doc);
  const end = content > startSec + 1 ? content : startSec + OPEN_END_SEC;
  const events = playbackEvents(doc).filter((e) => e.bus === 'bgm' || e.bus === 'stem');
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
  const sec = engine.heardSec();
  if (sec === null || !get().playing) return null;
  return sec - planBgmSec();
}

// ---- 反映 ------------------------------------------------------------------------
// 案は「エディタに反映」を押すまで譜面に入らない。譜面とどこがちがうか（未反映）を見せ、
// 反映しないまま戻ろうとしたら聞く。ちがいは書き方ではなく中身（BPM の流れと原曲の開始位置）で比べる
// （反映は BPM のチップを置き直すので、同じ案でも書き方は変わることがある）。

/** BPM の表示（0.001 まで。整数ならそのまま） */
export function bpmText(bpm: number): string {
  return String(Math.round(bpm * 1000) / 1000);
}

/** 案とエディタの譜面のちがい。cur はエディタの譜面、next は案 */
export interface TempoDiff {
  /** 曲頭の BPM */
  bpm: { cur: number; next: number; changed: boolean };
  /** 途中で BPM が変わる所の数。changed: 数・位置・値のどれかが変わる */
  changes: { cur: number; next: number; changed: boolean };
  /** 原曲（BGM チップ）を鳴らし始める譜面の秒。BGM チップが無ければ null。案で置けなければ next は null */
  bgm: { cur: number; next: number | null; changed: boolean } | null;
  /** どこかが変わる（反映すると譜面が変わる） */
  any: boolean;
}

/** BPM の流れ（同じ BPM が続く所はまとめる） */
function bpmSteps(t: TempoMap): { beat: number; bpm: number }[] {
  const out: { beat: number; bpm: number }[] = [];
  for (const e of t.events) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.bpm - e.bpm) < 0.0005) continue;
    out.push({ beat: e.beat, bpm: e.bpm });
  }
  return out;
}

let diffMemo: { doc: DtxDoc; r: PlanResult; d: TempoDiff } | null = null;

export function tempoDiff(doc: DtxDoc = useEditor.getState().doc, r: PlanResult = planResult()): TempoDiff {
  if (diffMemo && diffMemo.doc === doc && diffMemo.r === r) return diffMemo.d;
  const cur = bpmSteps(tempoOf(doc));
  const next = bpmSteps(r.tempo);
  const bpm = { cur: cur[0].bpm, next: next[0].bpm, changed: Math.abs(cur[0].bpm - next[0].bpm) >= 0.0005 };
  const moved = cur.length !== next.length || cur.some((e, i) => i > 0 && (Math.abs(e.beat - next[i].beat) > 1e-6 || Math.abs(e.bpm - next[i].bpm) >= 0.0005));
  const changes = { cur: cur.length - 1, next: next.length - 1, changed: moved };
  const src = bgmSource(doc);
  const bgm = src ? { cur: src.sec, next: r.bgm?.sec ?? null, changed: !!r.bgm && Math.abs(src.sec - r.bgm.sec) > 0.0005 } : null;
  const d = { bpm, changes, bgm, any: bpm.changed || moved || !!bgm?.changed };
  diffMemo = { doc, r, d };
  return d;
}

/** 反映できる（原曲があり、小節の頭を1つ以上決めている） */
export function canApplyTempo(): boolean {
  const doc = useEditor.getState().doc;
  return !!bgmSource(doc) && normalizeAnchors(get().plan.anchors).length > 0;
}

/**
 * 案がエディタ（譜面）に入っているか。
 * pending: この画面で作った案（触った・推定から作った・反映のあとに変えた）が譜面とちがう、
 * applied: この画面で反映して、案が譜面と同じ、same: それ以外（開いたときの譜面から作った案のまま・譜面と同じ）
 */
export type TempoReflect = 'same' | 'pending' | 'applied';

export function tempoReflect(): TempoReflect {
  const s = get();
  if (!s.initialized || !canApplyTempo()) return 'same';
  if (tempoDiff().any) return s.touched || s.fromEstimate || s.applied ? 'pending' : 'same';
  return s.applied ? 'applied' : 'same';
}

/** 変わる所の短い説明（トースト・離れるときの確認） */
function diffParts(d: TempoDiff): string[] {
  const out: string[] = [];
  if (d.bpm.changed) out.push(`BPM ${bpmText(d.bpm.cur)} → ${bpmText(d.bpm.next)}`);
  if (d.changes.changed)
    out.push(
      d.changes.next > 0
        ? tr(`BPM の変化 ${d.changes.next} か所`, `${d.changes.next} BPM ${pl(d.changes.next, 'change')}`)
        : tr('BPM の変化をなくす', 'remove the BPM changes'),
    );
  if (d.bgm?.changed) out.push(tr('原曲の開始位置', 'start of the original'));
  return out;
}

/** 案をエディタ（譜面）に反映する。反映できなければ false（譜面がもう案のとおりなら何も変えずに true） */
export function applyTempo(): boolean {
  const s = get();
  const doc = useEditor.getState().doc;
  const r = planResult();
  const anchors = normalizeAnchors(s.plan.anchors);
  if (anchors.length && !r.bgm) {
    toast(
      tr(
        `1小節目の頭が原曲の始まりから遠いため、BGMを置けません。小節番号を ${r.shift} 個うしろにしてください。`,
        `Measure 1 starts too far from the start of the original audio to place the BGM. Shift the measure numbers back by ${r.shift}.`,
      ),
      'warn',
      6000,
    );
    return false;
  }
  const d = tempoDiff(doc, r);
  const ok = d.any && edit(tr('テンポ合わせを反映', 'Apply tempo map'), (dd) => applyPlan(dd, r, null));
  setAnchors(anchors);
  set({ touched: false, fromEstimate: false, applied: true });
  toast(
    ok
      ? tr(`エディタに反映しました（${diffParts(d).join('・')}）`, `Applied to the editor (${diffParts(d).join(', ')})`)
      : tr('エディタの譜面は、もうこの案のとおりです', 'The editor’s chart already matches this plan'),
    'ok',
  );
  return true;
}

/**
 * テンポの画面を離れる（エディタに戻る・Esc）。案をまだ反映していなければ、反映するか聞く
 * （黙って戻ると、合わせた BPM と開始位置が譜面に入っていないことに気づきにくい）
 */
export async function leaveTempo(): Promise<boolean> {
  if (tempoReflect() === 'pending') {
    const parts = diffParts(tempoDiff());
    const choice = await chooseDialog<'apply' | 'leave'>({
      title: tr('テンポの変更をエディタに反映しますか？', 'Apply the tempo changes to the editor?'),
      body: tr(`まだ譜面に入っていない変更: ${parts.join('・')}`, `Not in the chart yet: ${parts.join(', ')}`),
      options: [
        {
          label: tr('反映して戻る', 'Apply and go back'),
          sub: tr('BPM と原曲（BGM）の開始位置が譜面に入ります（元に戻すで戻せます）', 'The BPM and the start of the original (BGM) go into the chart (you can undo it)'),
          value: 'apply',
        },
        {
          label: tr('反映せずに戻る', 'Go back without applying'),
          sub: tr('案はこの画面に残ります（別の曲を開くか、ほかの方法でテンポを直すと消えます）', 'The plan stays on this page (it is cleared if you open another song or fix the tempo another way)'),
          value: 'leave',
        },
      ],
    });
    if (choice === null) return false;
    if (choice === 'apply' && !applyTempo()) return false;
  }
  backToChart();
  return true;
}

/** 原曲（BGMチップ）が無い譜面に、WAV を原曲として置く */
export function chooseBgm(no: number) {
  edit(tr('原曲（BGM）を置く', 'Place the original audio (BGM)'), (d) => {
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 0, f: { n: 0, d: 1 }, v: no });
  });
  set({ initialized: false });
}
