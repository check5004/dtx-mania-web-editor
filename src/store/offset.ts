// 「原曲の打点」（ドラムの採譜）と譜面のチップのずれ（assist/offsetCheck）を、今の譜面と採譜の結果で測る。
// 原曲の打点の見出しに出し、ⓘ の説明から1クリックで直す（開始位置＝BGM の位置、または BPM）。
// 打点をステムから取っているときは、ステムと原曲のずれ（audio/lag）も測る（分離ソフトが頭に無音を足すことがあるため）。
import { create } from 'zustand';
import { analyzeOffset, chipTimes, constantBpm, localOffset, shiftBgm, type OffsetReport } from '../assist/offsetCheck';
import { applyPlan, evaluatePlan, normalizeAnchors, type TempoAnchor } from '../assist/tempoPlan';
import { measureLag } from '../audio/lag';
import type { DtxDoc } from '../dtx/model';
import { useAssist } from './assist';
import { bgmSource, tempoOf } from './derived';
import { drumHitsByClass, readyDrums, type DrumHitsByClass } from './drums';
import { edit, toast, useEditor } from './editor';
import { setAnchors, useSidecar } from './sidecar';
import { effectiveAnalysisStem, trackAudio, updateStem } from './stems';
import { useTempo } from './tempoUi';

export interface StemLag {
  /** 原曲とステム（頭のずれ込み）の組 */
  key: string;
  file: string;
  name: string;
  status: 'running' | 'done';
  /** ステムが原曲より何秒遅れているか（測れなければ null） */
  lag: number | null;
}

export interface OffsetState {
  /** 測り直すたびに増える（画面の描き直し用） */
  rev: number;
  stemLag: StemLag | null;
}

export const useOffset = create<OffsetState>(() => ({ rev: 0, stemLag: null }));

/** ステムがこれ以上ずれていたら直すよう出す（秒）。測る精度は 1ms ほど */
export const STEM_LAG_LIMIT = 0.005;

// ---- 譜面と採譜の打点 -----------------------------------------------------------------

let memo: { doc: DtxDoc; hits: DrumHitsByClass; r: OffsetReport } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function inputs() {
  const doc = useEditor.getState().doc;
  const data = readyDrums();
  const hits = data ? drumHitsByClass(useAssist.getState().sensitivity) : null;
  const bgm = bgmSource(doc);
  if (!data || !hits || !bgm) return null;
  return { doc, hits, dur: data.frames / data.fps, bgmSec: bgm.sec };
}

function compute(inp: NonNullable<ReturnType<typeof inputs>>): OffsetReport {
  const tempo = tempoOf(inp.doc);
  const r = analyzeOffset(chipTimes(inp.doc, tempo, inp.bgmSec, inp.dur), inp.hits, constantBpm(tempo));
  memo = { doc: inp.doc, hits: inp.hits, r };
  return r;
}

/** 今すぐ測った結果（直すボタンはこれを使う。続けて押しても二重に直さない） */
function freshReport(): OffsetReport | null {
  const inp = inputs();
  if (!inp) return null;
  if (memo && memo.doc === inp.doc && memo.hits === inp.hits) return memo.r;
  return compute(inp);
}

/**
 * 今の譜面のチップと採譜の打点のずれ。採譜が済んでいない・原曲が無いときは null。
 * 譜面を直している間は何度も測らないように、少し前の結果を返し、手が止まってから測り直す。
 */
export function offsetReport(): OffsetReport | null {
  const inp = inputs();
  if (!inp) return null;
  if (memo && memo.doc === inp.doc && memo.hits === inp.hits) return memo.r;
  // 初めて・採譜が変わった → すぐ
  if (!memo || memo.hits !== inp.hits) return compute(inp);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      const now = inputs();
      if (!now) return;
      compute(now);
      useOffset.setState((s) => ({ rev: s.rev + 1 }));
    }, 300);
  }
  return memo.r;
}

/** ずれの表示（+24ms・−8ms） */
export function fmtMs(sec: number): string {
  const ms = Math.round(sec * 1000);
  return `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${Math.abs(ms)}ms`;
}

/** ステムのずれが大きくて、譜面のずれはステムを直してから測るべきか */
export function stemLagWarn(): StemLag | null {
  const s = stemLag();
  return s && s.status === 'done' && s.lag !== null && Math.abs(s.lag) >= STEM_LAG_LIMIT ? s : null;
}

/**
 * 見出しに出すずれ（直した方がよいときだけ）。ステムのずれがあればそれを先に出す。
 * 開始位置のずれは曲全体の値、BPM・テンポの揺れは見えている所（原曲の from〜to 秒）の値。
 */
export function offsetBadge(from: number, to: number): string | null {
  const sl = stemLagWarn();
  if (sl) return `ステム ${fmtMs(sl.lag!)}`;
  const r = offsetReport();
  if (!r || r.verdict === 'ok' || r.verdict === 'few') return null;
  const v = r.verdict === 'start' ? r.offset : (localOffset(r, from, to) ?? r.offset);
  return `ずれ ${fmtMs(v)}`;
}

// ---- 直す ----------------------------------------------------------------------------

/** テンポ合わせの画面の案は、直した譜面から作り直す */
function resetTempoUi() {
  useTempo.setState({ initialized: false });
}

/** 作業ファイルのアンカー（テンポ合わせで決めた小節の頭）も、譜面と一緒に変える・戻す */
function anchorSide(before: TempoAnchor[], after: TempoAnchor[]) {
  const put = (a: TempoAnchor[]) => {
    if (before.length || after.length) setAnchors(a);
    resetTempoUi();
  };
  return { undo: () => put(before), redo: () => put(after) };
}

/**
 * 開始位置を直す: 原曲（BGM のチップ。ステムも一緒に鳴る）を前へ動かし、譜面のグリッドを原曲に対して
 * うしろへずらす（テンポ合わせの「開始位置」を +ずれ するのと同じ）。ずれは今測り直した値（曲全体の中央値）。
 */
export function fixStart(): boolean {
  const r = freshReport();
  if (!r || r.verdict === 'few' || Math.abs(r.offset) < 0.001) return false;
  const d = r.offset;
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const before = useSidecar.getState().anchors;
  const after = before.map((a) => ({ ...a, t: a.t + d }));
  const res = { err: null as number | null };
  const side = anchorSide(before, after);
  const ok = edit(
    `開始位置を ${fmtMs(d)} 直す`,
    (dr) => {
      res.err = shiftBgm(dr, tempo, d);
    },
    { side },
  );
  if (!ok) {
    toast(
      res.err === null
        ? '原曲の始まりが譜面の頭に近いため、これ以上前へ動かせません。テンポ合わせで小節番号をうしろにしてください。'
        : 'ずれが小さく、BGM の位置（1小節を384に分けた位置）では動かせませんでした。',
      'warn',
      6000,
    );
    return false;
  }
  side.redo();
  toast(`開始位置を ${fmtMs(d)} 直しました（原曲の BGM のチップを動かしました）。Ctrl+Z で戻せます`, 'ok');
  return true;
}

/** BPM を直す: 合う BPM にして、原曲の位置（BGM のチップ）も合わせる（テンポ合わせで反映するのと同じ） */
export function fixBpm(): boolean {
  const fit = freshReport()?.bpmFit;
  if (!fit) return false;
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const before = useSidecar.getState().anchors;
  const m = normalizeAnchors(before)[0]?.m ?? 1;
  const anchor: TempoAnchor = { m, t: fit.t0 + tempo.measureStart(m) * (60 / fit.bpm) };
  const r = evaluatePlan(doc, { bpm: fit.bpm, anchors: [anchor] });
  if (!r.bgm) {
    toast('原曲の始まりが譜面の頭より前になるため、BGM を置けません。テンポ合わせで小節番号をうしろにしてください。', 'warn', 6000);
    return false;
  }
  const side = anchorSide(before, [anchor]);
  const ok = edit(`BPM を ${fit.bpm} に直す`, (d) => applyPlan(d, r, null), { side });
  if (!ok) return false;
  side.redo();
  toast(`BPM を ${fit.from} から ${fit.bpm} に直し、原曲の位置も合わせました。Ctrl+Z で戻せます`, 'ok');
  return true;
}

// ---- ステムと原曲 -------------------------------------------------------------------

let lagRunning = '';

/**
 * 打点をステムから取っているとき、そのステムが原曲より何秒遅れているか。
 * 測っている途中は status: 'running'。ステムを使っていない・原曲が無いときは null。
 */
export function stemLag(): StemLag | null {
  const eff = effectiveAnalysisStem();
  if (!eff) return null;
  const st = trackAudio(eff.file);
  const og = trackAudio('orig');
  if (!st || !og) return null;
  const key = `${og.key}|${st.key}`;
  const cur = useOffset.getState().stemLag;
  if (cur?.key === key) return cur;
  const running: StemLag = { key, file: eff.file, name: st.name, status: 'running', lag: null };
  if (lagRunning !== key) {
    lagRunning = key;
    // 描いている途中・画面を作っている途中に状態を変えないように、次の番で始める
    setTimeout(() => {
      useOffset.setState({ stemLag: running });
      const ch = (b: AudioBuffer) => Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));
      void measureLag(ch(og.buf), ch(st.buf), og.buf.sampleRate, () => lagRunning !== key)
        .catch(() => null)
        .then((r) => {
          if (lagRunning !== key) return;
          lagRunning = '';
          useOffset.setState((s) => ({ rev: s.rev + 1, stemLag: { ...running, status: 'done', lag: r ? r.lag : null } }));
        });
    }, 0);
  }
  return running;
}

/** ステムの「頭のずれ」を直して原曲に合わせる（ステムを lag 秒だけ前へ） */
export function fixStemLag(): boolean {
  const s = stemLagWarn();
  if (!s || s.lag === null) return false;
  const t = useSidecar.getState().stems.find((x) => x.file === s.file);
  if (!t) return false;
  const next = Math.round(t.offsetMs - s.lag * 1000);
  updateStem(s.file, { offsetMs: next });
  toast(`ステム（${t.name}）の頭のずれを ${t.offsetMs} → ${next}ms にしました。打点は採譜し直してから出ます`, 'ok', 6000);
  return true;
}
