// テンポ合わせ: 「この小節の頭は原曲の何秒」というアンカーから、BPMと原曲（BGMチップ）の位置を決める。
//   ・アンカーが1つ: 選んだBPMで一定。BGMチップの位置だけ決まる
//   ・アンカーが2つ以上: アンカーの間の拍数と秒からBPMを計算し、アンカーの小節の頭でBPMを変える
//     （最初のアンカーより前は最初の区間のBPM、最後のアンカーより後は最後の区間のBPM）
import { produce, type Draft } from 'immer';
import { toBase36x2 } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { CH, type DtxDoc } from '../dtx/model';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { setField } from '../edit/ops';

export interface TempoAnchor {
  /** 小節番号（この小節の頭） */
  m: number;
  /** 原曲の中の時刻（秒） */
  t: number;
}

export interface TempoPlan {
  /** アンカーが1つのときのBPM */
  bpm: number;
  anchors: TempoAnchor[];
}

export interface PlanSegment {
  /** この小節の頭から */
  m: number;
  bpm: number;
  src: 'base' | 'anchor';
}

/** NX は1小節を384に分けて読む */
export const BGM_DIV = 384;

export function normalizeAnchors(anchors: readonly TempoAnchor[]): TempoAnchor[] {
  const byM = new Map<number, TempoAnchor>();
  for (const a of anchors) if (Number.isFinite(a.t) && a.m >= 0) byM.set(a.m, { m: a.m, t: a.t });
  const out = [...byM.values()].sort((a, b) => a.m - b.m);
  // 時刻が逆になっているものは捨てる（後ろの方を残す）
  const ok: TempoAnchor[] = [];
  for (const a of out) {
    while (ok.length && ok[ok.length - 1].t >= a.t - 0.05) ok.pop();
    ok.push(a);
  }
  return ok;
}

export function roundBpm(bpm: number): number {
  return Math.round(bpm * 1000) / 1000;
}

/** 小節 a から b の手前までの拍数（小節長を見る） */
function beatsBetween(tempo: TempoMap, a: number, b: number): number {
  return tempo.measureStart(b) - tempo.measureStart(a);
}

/** BPMの区切り（小節の頭ごと） */
export function planSegments(doc: DtxDoc, plan: TempoPlan): PlanSegment[] {
  const anchors = normalizeAnchors(plan.anchors);
  if (anchors.length < 2) return [{ m: 0, bpm: roundBpm(plan.bpm), src: 'base' }];
  const tempo = buildTempoMap({ chips: [], barLengths: doc.barLengths, fields: {} });
  const segs: PlanSegment[] = [];
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const bpm = roundBpm((beatsBetween(tempo, a.m, b.m) * 60) / (b.t - a.t));
    const m = i === 0 ? 0 : a.m;
    if (segs.length && Math.abs(segs[segs.length - 1].bpm - bpm) < 0.0005) continue;
    segs.push({ m, bpm, src: 'anchor' });
  }
  return segs;
}

function bpmNumber(d: Draft<DtxDoc>, bpm: number): number {
  const s = String(bpm);
  for (const [k, v] of Object.entries(d.fields)) {
    if (/^BPM[0-9A-Z]{2}$/.test(k) && k !== 'BPM00' && Number(v) === bpm) return parseInt(k.slice(3), 36);
  }
  for (let n = 1; n < 1296; n++) {
    if (d.fields['BPM' + toBase36x2(n)] === undefined) {
      setField(d, 'BPM' + toBase36x2(n), s);
      return n;
    }
  }
  return 1;
}

/** BPMだけを書き換える（BGMチップは動かさない） */
export function writeSegments(d: Draft<DtxDoc>, segs: readonly PlanSegment[]) {
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (c.ch === CH.BPM || c.ch === CH.BPM_EX) d.chips.splice(i, 1);
  }
  // BASEBPM があると ch08 の値が足し算になるので外す（BPMのチップは全部置き直す）
  if (d.fields['BASEBPM'] !== undefined) setField(d, 'BASEBPM', undefined);
  setField(d, 'BPM', String(segs[0].bpm));
  if (d.fields['BPM00'] !== undefined) setField(d, 'BPM00', undefined);
  for (const s of segs.slice(1)) {
    const no = bpmNumber(d, s.bpm);
    d.chips.push({ id: d.nextId++, ch: CH.BPM_EX, m: s.m, f: frac(0), v: no });
  }
}

export interface BgmPlacement {
  m: number;
  /** 小節の中の位置（n / 384） */
  n: number;
  /** 譜面の秒（384分割に丸めたあと） */
  sec: number;
  /** 丸めでずれた量（ミリ秒、正なら遅い） */
  errMs: number;
}

/** 最初のアンカーに原曲が合うように、BGMチップの位置を決める。足りなければ null */
export function bgmPlacement(tempo: TempoMap, first: TempoAnchor): BgmPlacement | null {
  const target = tempo.beatToSec(tempo.measureStart(first.m)) - first.t;
  if (target < -1e-6) return null;
  const beat = tempo.secToBeat(Math.max(0, target));
  let { m } = tempo.locate(beat);
  const within = beat - tempo.measureStart(m);
  let n = Math.round((within / tempo.measureBeats(m)) * BGM_DIV);
  if (n >= BGM_DIV) {
    m += 1;
    n = 0;
  }
  const sec = tempo.beatToSec(tempo.measureStart(m) + (n / BGM_DIV) * tempo.measureBeats(m));
  return { m, n, sec, errMs: (sec - target) * 1000 };
}

/** 最初のアンカーを何小節うしろにずらせば BGM を置けるか */
export function shiftNeeded(tempo: TempoMap, first: TempoAnchor): number {
  for (let k = 0; k < 64; k++) {
    if (tempo.beatToSec(tempo.measureStart(first.m + k)) - first.t >= 0) return k;
  }
  return 64;
}

/** BPMを書き換えたあとの譜面（BGMチップはまだ動かさない） */
export function withSegments(doc: DtxDoc, segs: readonly PlanSegment[]): DtxDoc {
  return produce(doc, (d) => writeSegments(d, segs));
}

export interface PlanResult {
  segs: PlanSegment[];
  tempo: TempoMap;
  bgm: BgmPlacement | null;
  /** BGMを置くのに足りない小節数 */
  shift: number;
}

export function evaluatePlan(doc: DtxDoc, plan: TempoPlan): PlanResult {
  const segs = planSegments(doc, plan);
  const next = withSegments(doc, segs);
  const tempo = buildTempoMap(next);
  const anchors = normalizeAnchors(plan.anchors);
  if (anchors.length === 0) return { segs, tempo, bgm: null, shift: 0 };
  const bgm = bgmPlacement(tempo, anchors[0]);
  return { segs, tempo, bgm, shift: bgm ? 0 : shiftNeeded(tempo, anchors[0]) };
}

/** 計画を譜面に書く。bgmWav は BGM チップが無いときに置く WAV 番号 */
export function applyPlan(d: Draft<DtxDoc>, r: PlanResult, bgmWav: number | null) {
  writeSegments(d, r.segs);
  if (!r.bgm) return;
  const f = frac(r.bgm.n, BGM_DIV);
  // 一番先に鳴る BGM チップを動かす（無ければ置く）
  const tempo = r.tempo;
  let first = -1;
  let firstBeat = Infinity;
  d.chips.forEach((c, i) => {
    if (c.ch !== CH.BGM) return;
    const b = tempo.beatOf(c.m, c.f);
    if (b < firstBeat) {
      firstBeat = b;
      first = i;
    }
  });
  if (first >= 0) {
    d.chips[first].m = r.bgm.m;
    d.chips[first].f = f;
  } else if (bgmWav !== null) {
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: r.bgm.m, f, v: bgmWav });
  }
}

/** 今の譜面からアンカーを作る（1小節目の頭と、BPMが変わる小節の頭と、最後） */
export function anchorsFromDoc(tempo: TempoMap, bgmSec: number, lastSec: number): TempoAnchor[] {
  const out: TempoAnchor[] = [];
  const at = (m: number) => ({ m, t: tempo.beatToSec(tempo.measureStart(m)) - bgmSec });
  const first = Math.max(1, tempo.locate(tempo.secToBeat(bgmSec)).m + (tempo.locate(tempo.secToBeat(bgmSec)).pos > 1e-9 ? 1 : 0));
  out.push(at(first));
  const changes = tempo.events.slice(1);
  if (changes.length === 0) return out.filter((a) => a.t >= 0);
  for (const ev of changes) {
    const { m, pos } = tempo.locate(ev.beat);
    const mm = pos > 1e-9 ? m + 1 : m;
    if (mm > first) out.push(at(mm));
  }
  const endM = tempo.locate(tempo.secToBeat(lastSec)).m;
  if (endM > out[out.length - 1].m) out.push(at(endM));
  return normalizeAnchors(out.filter((a) => a.t >= 0));
}
