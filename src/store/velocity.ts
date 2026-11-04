// ベロシティ（ベロシティ）の操作：置くベロシティ（強・中・弱）、選んだチップのベロシティ、ベロシティの編集モードの道具。
import { tr } from '../i18n';
import { create } from 'zustand';
import { sameMeasures } from '../assist/similar';
import { drumChannel, DRUM_LANES, type Chip, type DtxDoc } from '../dtx/model';
import { chipVel, clampVel, opSetVelocity, velOfWav } from '../edit/velocity';
import { useInputSettings } from '../input/settings';
import { useAssist } from './assist';
import { bgmSource, chipViews, tempoOf } from './derived';
import { edit, setPlaceVelProvider, useEditor } from './editor';
import { sectionAt, useSidecar } from './sidecar';

export type VelTool = 'select' | 'pencil' | 'line';
export type VelScope = 'selection' | 'visible' | 'section' | 'song';

export interface VelState {
  /** 置くベロシティ（0=強 1=中 2=弱） */
  preset: 0 | 1 | 2;
  /** ベロシティの編集モード */
  mode: boolean;
  tool: VelTool;
  /** ベロシティのレーンに出す・まとめて変えるレーン（3つまで） */
  lanes: number[];
  scope: VelScope;
  /** 同じパターンの小節にも同じ変更をする */
  alsoSimilar: boolean;
  /** 拍の位置（表・16分の2つ目・裏・16分の4つ目）ごとのベロシティ */
  beatAccent: [number, number, number, number];
  /** 原曲の打点から決めるときのベロシティの幅 */
  audioRange: [number, number];
  /** 点線で見せている候補（チップ id → ベロシティ） */
  proposal: Map<number, number> | null;
}

const DEFAULT_LANES = [1, 3, 5];

export const useVel = create<VelState>(() => ({
  preset: 0,
  mode: false,
  tool: 'select',
  lanes: DEFAULT_LANES,
  scope: 'selection',
  alsoSimilar: false,
  beatAccent: [100, 60, 80, 60],
  audioRange: [30, 100],
  proposal: null,
}));

const vget = useVel.getState;
const vset = useVel.setState;

/** 置くベロシティの3段の名前（表示のたびに今の言語で返す） */
export function velPresetNames(): readonly [string, string, string] {
  return [tr('強', 'Hard'), tr('中', 'Mid'), tr('弱', 'Soft')];
}

/** いま置くベロシティ */
export function placeVel(): number {
  return useInputSettings.getState().velPresets[vget().preset];
}

export function weakVel(): number {
  return useInputSettings.getState().velPresets[2];
}

setPlaceVelProvider(placeVel);

export function setPreset(p: 0 | 1 | 2) {
  vset({ preset: p });
}

export function velStep(): number {
  return useInputSettings.getState().velStep;
}

// ---- まとめて書き換える -------------------------------------------------------------

/** 同じパターンの小節の、同じ位置・同じチャンネルのチップ */
function similarTwins(doc: DtxDoc, chips: Chip[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const byMeasure = new Map<number, Chip[]>();
  for (const c of doc.chips) {
    if (!drumChannel(c.ch)) continue;
    let a = byMeasure.get(c.m);
    if (!a) byMeasure.set(c.m, (a = []));
    a.push(c);
  }
  const sameCache = new Map<number, number[]>();
  for (const c of chips) {
    let ms = sameCache.get(c.m);
    if (!ms) sameCache.set(c.m, (ms = sameMeasures(doc, c.m)));
    const twins: number[] = [];
    for (const m of ms) {
      const t = byMeasure.get(m)?.find((x) => x.ch === c.ch && x.f.n === c.f.n && x.f.d === c.f.d);
      if (t) twins.push(t.id);
    }
    if (twins.length) out.set(c.id, twins);
  }
  return out;
}

/**
 * チップのベロシティを変える。fn は今のベロシティから新しいベロシティを返す。
 * 「同じパターンの小節にも」が付いていれば、その小節の同じ位置のチップも同じベロシティにする。
 */
export function applyVel(label: string, ids: readonly number[], fn: (cur: number, c: Chip) => number | null, opts: { group?: string; similar?: boolean } = {}): number {
  if (ids.length === 0) return 0;
  const s = useEditor.getState();
  const step = velStep();
  const idSet = new Set(ids);
  const chips = s.doc.chips.filter((c) => idSet.has(c.id) && drumChannel(c.ch));
  // 先に新しいベロシティを決めておく（ゆらぎなどで双子のチップも同じ値にするため）
  const next = new Map<number, number>();
  for (const c of chips) {
    const cur = velOfWav(s.doc.fields, c.v);
    const v = fn(cur, c);
    if (v !== null) next.set(c.id, clampVel(v));
  }
  if (opts.similar ?? vget().alsoSimilar) {
    const twins = similarTwins(s.doc, chips);
    for (const [id, list] of twins) {
      const v = next.get(id);
      if (v === undefined) continue;
      for (const t of list) if (!next.has(t)) next.set(t, v);
    }
  }
  let n = 0;
  edit(
    label,
    (d) => {
      n = opSetVelocity(d, new Set(next.keys()), (_cur, c) => next.get(c.id) ?? null, step);
    },
    { group: opts.group },
  );
  return n;
}

export function selectedDrumIds(): number[] {
  const s = useEditor.getState();
  const sel = new Set(s.selection);
  return s.doc.chips.filter((c) => sel.has(c.id) && drumChannel(c.ch)).map((c) => c.id);
}

/** 選んだチップのベロシティを ±delta（Alt+ホイール・Alt+↑↓） */
export function nudgeSelection(delta: number): boolean {
  return nudgeVel(selectedDrumIds(), delta);
}

/** チップのベロシティを ±delta（右クリックのメニューからも）。group が同じなら続けての変更は Undo 1回で戻せる */
export function nudgeVel(ids0: readonly number[], delta: number, group = 'vel-nudge'): boolean {
  const s = useEditor.getState();
  const want = new Set(ids0);
  const ids = s.doc.chips.filter((c) => want.has(c.id) && drumChannel(c.ch)).map((c) => c.id);
  if (ids.length === 0) return false;
  // 1刻みで動かすときは刻みを無視する
  const step = Math.abs(delta) < velStep() ? 1 : velStep();
  const idSet = new Set(ids);
  edit(
    tr(`ベロシティを ${delta > 0 ? '+' : ''}${delta}`, `Velocity ${delta > 0 ? '+' : ''}${delta}`),
    (d) => {
      opSetVelocity(d, idSet, (cur) => cur + delta, step);
    },
    { group },
  );
  return true;
}

export function setSelectionVel(v: number) {
  setVelOf(selectedDrumIds(), v);
}

/** チップのベロシティを v にする（右のパネル・右クリックのメニュー） */
export function setVelOf(ids: readonly number[], v: number, group?: string): number {
  return applyVel(tr(`ベロシティを ${v} にする`, `Set velocity to ${v}`), ids, () => v, { similar: false, group });
}

// ---- ベロシティの編集モード -------------------------------------------------------------

export function toggleVelMode(on?: boolean) {
  const next = on ?? !vget().mode;
  if (next && !vget().mode) {
    // 選んでいるチップのレーンをベロシティのレーンに出す
    const s = useEditor.getState();
    const sel = new Set(s.selection);
    const count = new Map<number, number>();
    for (const c of s.doc.chips) {
      if (!sel.has(c.id)) continue;
      const d = drumChannel(c.ch);
      if (d) count.set(d.lane, (count.get(d.lane) ?? 0) + 1);
    }
    const lanes = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l).sort((a, b) => a - b);
    vset({ mode: true, lanes: lanes.length ? lanes : vget().lanes, proposal: null, scope: s.selection.length ? 'selection' : vget().scope });
    return;
  }
  vset({ mode: next, proposal: null });
}

export function toggleVelLane(lane: number) {
  const cur = vget().lanes;
  if (cur.includes(lane)) {
    if (cur.length > 1) vset({ lanes: cur.filter((l) => l !== lane) });
    return;
  }
  const next = [...cur, lane].sort((a, b) => a - b);
  // 3つまで。超えたら一番古いものを外す
  vset({ lanes: next.length > 3 ? next.filter((l) => l !== cur[0]) : next });
}

/** 対象の範囲の拍（[from, to)） */
export function scopeRange(scope: VelScope, visible: { from: number; to: number }): { from: number; to: number } | null {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  if (scope === 'song') return { from: -Infinity, to: Infinity };
  if (scope === 'visible') return visible;
  if (scope === 'section') {
    const side = useSidecar.getState();
    const m = tempo.locate(Math.max(0, s.cursorBeat)).m;
    const cur = sectionAt(side.sections, m);
    if (!cur) return null;
    const i = side.sections.indexOf(cur);
    const next = side.sections[i + 1];
    return { from: tempo.measureStart(cur.m), to: next ? tempo.measureStart(next.m) : Infinity };
  }
  return null;
}

/** まとめて変える対象のチップ（範囲 × レーン） */
export function targetChips(visible: { from: number; to: number }): Chip[] {
  const s = useEditor.getState();
  const v = vget();
  const lanes = new Set(v.lanes);
  const views = chipViews(s.doc).filter((x) => x.col >= 0 && lanes.has(x.col) && x.kind === 'normal');
  if (v.scope === 'selection') {
    const sel = new Set(s.selection);
    return views.filter((x) => sel.has(x.c.id)).map((x) => x.c);
  }
  const r = scopeRange(v.scope, visible);
  if (!r) return [];
  return views.filter((x) => x.beat >= r.from - 1e-9 && x.beat < r.to - 1e-9).map((x) => x.c);
}

/** ベロシティの分布（10刻みの10段） */
export function velHistogram(doc: DtxDoc, chips: Chip[]): { bins: number[]; avg: number } {
  const bins = new Array(10).fill(0);
  let sum = 0;
  for (const c of chips) {
    const v = chipVel(doc, c) ?? 100;
    bins[Math.min(9, Math.floor((v - 1) / 10))]++;
    sum += v;
  }
  return { bins, avg: chips.length ? sum / chips.length : 0 };
}

/** 拍の位置（1拍を4つ）。16分のどこにも乗らないチップは null */
export function beatSlot(doc: DtxDoc, c: Chip): number | null {
  const tempo = tempoOf(doc);
  const b = tempo.beatOf(c.m, c.f);
  const x = (b - tempo.measureStart(c.m)) * 4;
  const k = Math.round(x);
  if (Math.abs(x - k) > 1e-6) return null;
  return ((k % 4) + 4) % 4;
}

// ---- 原曲の打点から決める ------------------------------------------------------------

/** レーンが聴く帯域（BD・左足→低、スネア・タム→中、シンバル類→高） */
function laneBand(lane: number): 'low' | 'mid' | 'high' {
  const key = DRUM_LANES[lane].key;
  if (key === 'BD' || key === 'LP') return 'low';
  if (key === 'SD' || key === 'HT' || key === 'LT' || key === 'FT') return 'mid';
  return 'high';
}

/**
 * 同じ位置で鳴った原曲の音の強さを、[lo, hi] の強さに割り振る。
 * 近くに打点が無いチップは入れない。戻り値はチップ id → ベロシティ。
 */
export function velFromAudio(chips: Chip[], lo: number, hi: number): Map<number, number> {
  const out = new Map<number, number>();
  const a = useAssist.getState();
  const s = useEditor.getState();
  const bgm = bgmSource(s.doc);
  if (!a.data || !bgm) return out;
  const tempo = tempoOf(s.doc);
  const data = a.data;
  const fr = data.frameRate;
  const raw: { id: number; v: number; band: string }[] = [];
  for (const c of chips) {
    const d = drumChannel(c.ch);
    if (!d) continue;
    const band = laneBand(d.lane);
    const odf = data.odf[band];
    const t = tempo.beatToSec(tempo.beatOf(c.m, c.f)) - bgm.sec;
    const i0 = Math.max(0, Math.floor((t - 0.035) * fr));
    const i1 = Math.min(odf.length - 1, Math.ceil((t + 0.035) * fr));
    let m = 0;
    for (let i = i0; i <= i1; i++) if (odf[i] > m) m = odf[i];
    if (m <= 0) continue;
    raw.push({ id: c.id, v: m, band });
  }
  // 帯域ごとにベロシティの順位で割り振る（帯域ごとに音量の基準が違うため）
  const byBand = new Map<string, { id: number; v: number }[]>();
  for (const r of raw) {
    let arr = byBand.get(r.band);
    if (!arr) byBand.set(r.band, (arr = []));
    arr.push(r);
  }
  for (const arr of byBand.values()) {
    const sorted = [...arr].sort((x, y) => x.v - y.v);
    const max = sorted[sorted.length - 1].v;
    for (const r of arr) {
      // ベロシティの比（対数）でなだらかに割り振る
      const ratio = Math.max(0, Math.min(1, 1 + Math.log10(Math.max(1e-4, r.v / max)) / 1.2));
      out.set(r.id, clampVel(lo + (hi - lo) * ratio));
    }
  }
  return out;
}

export function setProposal(p: Map<number, number> | null) {
  vset({ proposal: p && p.size ? p : null });
}

export function adoptProposal() {
  const p = vget().proposal;
  if (!p) return;
  applyVel(tr(`原曲の打点からベロシティを決める（${p.size}個）`, `Velocity from the original audio (${p.size})`), [...p.keys()], (_cur, c) => p.get(c.id) ?? null, { similar: false });
  vset({ proposal: null });
}

// 譜面が変わったら、候補は捨てる（チップの id が変わっているかもしれない）
useEditor.subscribe((s, prev) => {
  if (s.doc !== prev.doc && vget().proposal) {
    const ids = new Set(s.doc.chips.map((c) => c.id));
    const p = vget().proposal!;
    for (const id of p.keys()) {
      if (!ids.has(id)) {
        vset({ proposal: null });
        return;
      }
    }
  }
  if (s.screen !== prev.screen || s.page !== prev.page) {
    if (s.page !== 'chart' && vget().mode) vset({ mode: false, proposal: null });
  }
});
