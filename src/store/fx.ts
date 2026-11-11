// チップのエフェクト（ハイカット・ローカット・ピッチ）の操作と状態。仕組みは src/fx（カーブ・丸め・音の加工・チップの音のそろえ方）。
// - カーブは作業ファイル（useSidecar の fx）。変えると、そのたびにチップの音をそろえる（store/editor の docFixer。
//   チップを置く・動かす・貼り付ける・録音・MIDI でも同じ）。カーブの変更とチップの音の差し替えは Ctrl+Z 1 回で一緒に戻る
// - かけた音はブラウザの中で作る（元の音を読み、src/fx/dsp で加工する）。再生では「エディタが用意できる音」（audio/sounds の
//   addVirtualResolver）として鳴り、保存のときに曲フォルダの fx/ に書き出す（app/fileActions）
// - 「切って聴く」：再生のあいだだけ、かけた音を元の音に戻して鳴らす
import { produce } from 'immer';
import { create } from 'zustand';
import { pl, tr } from '../i18n';
import { engine } from '../audio/engine';
import { audibleEnd } from '../audio/dsp';
import { addVirtualResolver, virtualKey, virtualSound, type VirtualSound } from '../audio/sounds';
import { encodeAudio } from '../audio/stems';
import { toBase36x2 } from '../dtx/base36';
import { CH, DRUM_LANES, drumChannel, type Chip, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { freeWavNumber, setField, setFieldComment, snapToGrid, type Pos } from '../edit/ops';
import { wavPanOf, wavVolumeOf } from '../edit/velocity';
import { findFile } from '../fs/folder';
import { renderFx } from '../fx/dsp';
import {
  applies,
  curveBeats,
  emptyFxSide,
  FX_HI,
  FX_LO,
  fxExt,
  isFilter,
  openValue,
  PITCH_RANGE,
  pointBeat,
  roundValue,
  sortPoints,
  specText,
  stepValue,
  valsAt,
  valueLabel,
  type CurveBeats,
  type FxCurve,
  type FxEmphasis,
  type FxPoint,
  type FxRes,
  type FxShape,
  type FxSide,
  type FxSpec,
  type FxType,
} from '../fx/model';
import { fxInfosOf, fxWavNumbers, reconcileFx, type FxInfo } from '../fx/reconcile';
import { readCuts, thinKeys, type ReadKind, type ReadRegion } from '../fx/read';
import { templateById, templatePoints, TEMPLATE_HICUT, TEMPLATE_LOCUT, TEMPLATE_PITCH, type FxTemplateId } from '../fx/templates';
import { formatPosition } from '../ui/format';
import { useAssist, setWaveMode } from './assist';
import * as wk from '../audio/workerClient';
import { bgmSource, tempoOf } from './derived';
import { addDocFixer, addPlayDocTransform, addSoundDocs, edit, fileBuffer, lastHistory, prepareSounds, recordSide, refreshPlayback, toast, undoIfLast, useEditor } from './editor';
import { setFxSide, useSidecar } from './sidecar';
import { toggleVelMode, useVel } from './velocity';

// ---- 状態 -------------------------------------------------------------------------

export type FxReadScope = 'view' | 'loop' | 'song';
export type FxReadWhat = 'hicut' | 'locut' | 'both';

/** 原曲から読み取った案（点線） */
export interface FxProposal {
  type: ReadKind;
  points: FxPoint[];
  /** 見つかった所（拍）と、その説明 */
  regions: { from: number; to: number; text: string }[];
  /** 間引く前の点（拍・Hz） */
  raw: { beat: number; v: number }[][];
  /** 間引いた回数 */
  thin: number;
}

export interface FxUi {
  /** エフェクトの編集を開いている */
  open: boolean;
  /** 選んでいるカーブ */
  curveId: string | null;
  /** 選んでいる点（選んでいるカーブの、時刻の順の番号） */
  point: number | null;
  /** 切って聴く（再生でかけた音を元の音に戻す） */
  bypass: boolean;
  /** 作っている音の数 */
  rendering: number;
  /** 原曲から読み取る（パネルを開いている） */
  read: { scope: FxReadScope; what: FxReadWhat; busy: boolean; note: string | null } | null;
  proposals: FxProposal[] | null;
  /** ドラッグ中のカーブ（作業ファイルにはまだ入れていない。離したときにまとめて入れる） */
  live: FxSide | null;
}

export const useFx = create<FxUi>(() => ({ open: false, curveId: null, point: null, bypass: false, rendering: 0, read: null, proposals: null, live: null }));
const fset = useFx.setState;
const fget = useFx.getState;

/** いまのカーブ（ドラッグ中ならその形）。エフェクトを扱っていない譜面は null */
export function fxSide(): FxSide | null {
  return fget().live ?? useSidecar.getState().fx;
}

const LANE_INDEX = new Map(DRUM_LANES.map((l, i) => [l.key, i]));
export const laneIndex = (key: string) => LANE_INDEX.get(key) ?? -1;

const lower = (p: string) => p.trim().replace(/\\/g, '/').toLowerCase();

// ---- かけた音の覚え ---------------------------------------------------------------------

/** 作った・読んだ、かけた音（パス小文字 → 元の音とかけ方）。「;fx」の行の無い強さ違いも、ここで分かる */
const known = new Map<string, FxInfo>();

const infoCache = new WeakMap<DtxDoc, Map<string, FxInfo>>();
/** 譜面のかけた音（「;fx」の行と、覚えているもの） */
export function fxInfos(doc: DtxDoc): Map<string, FxInfo> {
  let m = infoCache.get(doc);
  if (!m) {
    m = fxInfosOf(doc);
    for (const [k, v] of m) if (!known.has(k)) known.set(k, v);
    for (const [k, v] of known) if (!m.has(k)) m.set(k, v);
    infoCache.set(doc, m);
  }
  return m;
}

const wavInfoCache = new WeakMap<DtxDoc, Map<number, FxInfo>>();
/** WAV 番号 → かけた音（かけた音の番号だけ） */
export function fxWavs(doc: DtxDoc): Map<number, FxInfo> {
  let m = wavInfoCache.get(doc);
  if (!m) {
    m = fxWavNumbers(doc, fxInfos(doc));
    wavInfoCache.set(doc, m);
  }
  return m;
}

/** チップの音のかけ方（かけていなければ null） */
export function chipFx(doc: DtxDoc, c: Chip): FxInfo | null {
  return fxWavs(doc).get(c.v) ?? null;
}

/** かけ方の色の順（ハイカット・ローカット・ピッチ） */
export function specTypes(s: FxSpec): FxType[] {
  const out: FxType[] = [];
  if (s.hc) out.push('hicut');
  if (s.lc) out.push('locut');
  if (s.pt) out.push('pitch');
  return out;
}

// ---- 元の音の長さ（長く鳴る音は余韻の中の動きも入れる） ------------------------------------------

const lenCache = new Map<string, number>();

/**
 * 元の音の鳴っている長さ（秒）。読んでいなければ、再生用に読み込んだ音から（再生用の音は開いている譜面の番号なので、
 * 開いている譜面で同じパスの番号を探す）。分からなければ 0
 */
function soundSec(orig: string): number {
  const k = lower(orig);
  const have = lenCache.get(k);
  if (have !== undefined) return have;
  for (const [key, v] of Object.entries(useEditor.getState().doc.fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(key) || lower(v) !== k) continue;
    const got = engine.buffer(parseInt(key.slice(3), 36));
    if (!got?.buf) continue;
    const sec = audibleEnd(got.buf);
    lenCache.set(k, sec);
    return sec;
  }
  return 0;
}

let warmTimer = 0;
let warming = false;

/** カーブのある譜面で、まだ長さを知らない元の音を読む（読み終えた音は、次の編集から余韻の中の動きが入る） */
function scheduleWarm() {
  if (typeof window === 'undefined') return;
  window.clearTimeout(warmTimer);
  warmTimer = window.setTimeout(() => void warmLengths(), 250);
}

async function warmLengths() {
  if (warming) return;
  const side = useSidecar.getState().fx;
  if (!side?.tails || !side.curves.some((c) => c.points.length)) return;
  warming = true;
  try {
    await warmLengthsOf(useEditor.getState().doc);
  } finally {
    warming = false;
  }
}

/** 譜面のドラムのチップの元の音の長さを読んでおく（ほかの難易度の譜面を合わせる前にも） */
export async function warmLengthsOf(doc: DtxDoc): Promise<void> {
  const infos = fxWavs(doc);
  const paths = new Set<string>();
  for (const c of doc.chips) {
    if (!drumChannel(c.ch)) continue;
    const info = infos.get(c.v);
    const p = info ? info.orig : doc.fields['WAV' + toBase36x2(c.v)];
    if (p !== undefined && !lenCache.has(lower(p))) paths.add(p);
  }
  for (const p of paths) {
    if (lenCache.has(lower(p))) continue;
    const buf = await fileBuffer(p);
    lenCache.set(lower(p), buf ? audibleEnd(buf) : 0);
  }
}

// ---- かけた音を作る -------------------------------------------------------------------------

const renders = new Map<string, Promise<AudioBuffer | null>>();
let chain: Promise<unknown> = Promise.resolve();

/** 加工は 1 つずつ順に（画面が固まらないように、あいだで休む） */
function queued<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job, job);
  chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** 元の音を覚えておく名前（中身が変われば変わる） */
function origKey(orig: string): string | null {
  const s = useEditor.getState();
  const f = findFile(s.folder, orig, s.doc.fields['PATH_WAV'] ?? '');
  if (f) return `${s.folder?.name}|${f.path}|${f.size}|${f.ver ?? 0}`;
  const vs = virtualSound(orig);
  return vs ? virtualKey(vs) : null;
}

/** かけた音（AudioBuffer）。同じ元の音・同じかけ方は 1 回だけ作る */
function rendered(info: FxInfo, key: string): Promise<AudioBuffer | null> {
  let p = renders.get(key);
  if (!p) {
    p = (async () => {
      const src = await fileBuffer(info.orig);
      if (!src) return null;
      return queued(async () => {
        fset((s) => ({ rendering: s.rendering + 1 }));
        try {
          await new Promise((r) => setTimeout(r, 0));
          const chans = Array.from({ length: src.numberOfChannels }, (_, i) => src.getChannelData(i));
          const out = renderFx(chans, src.sampleRate, info.spec);
          const len = Math.max(1, out[0]?.length ?? 1);
          const b = engine.workCtx().createBuffer(Math.max(1, out.length), len, src.sampleRate);
          out.forEach((x, i) => b.getChannelData(i).set(x.subarray(0, len)));
          return b;
        } catch {
          return null;
        } finally {
          fset((s) => ({ rendering: Math.max(0, s.rendering - 1) }));
        }
      });
    })();
    renders.set(key, p);
    void p.then((b) => {
      if (!b) renders.delete(key);
    });
  }
  return p;
}

/** かけた音のパスから、元の音とかけ方 */
function infoOfPath(path: string): FxInfo | null {
  const k = lower(path);
  return known.get(k) ?? fxInfos(useEditor.getState().doc).get(k) ?? null;
}

/** エディタが用意する音として、かけた音を出す（曲フォルダに無いとき。保存すると fx/ に書き出す） */
export function fxVirtual(path: string): VirtualSound | null {
  if (!/^\s*fx[\\/]/i.test(path)) return null;
  const info = infoOfPath(path);
  if (!info) return null;
  const ok = origKey(info.orig);
  if (!ok) return null;
  const key = `fx:${ok}|${specText(info.spec)}`;
  return {
    file: path.trim().replace(/\\/g, '/'),
    origin: tr(`エフェクト（${info.orig}）`, `Effect (${info.orig})`),
    key,
    load: () => rendered(info, key),
    bytes: async () => {
      const b = await rendered(info, key);
      return b ? encodeAudio(b, fxExt(info.orig)) : null;
    },
  };
}

addVirtualResolver(fxVirtual);

// ---- チップの音をそろえる（どの編集のあとにも） ---------------------------------------------------

let fullWarned = 0;
let lowWarned = 0;
/** WAV 番号の残りがこれを切ったら知らせる */
export const WAV_LOW = 100;

function freeCount(doc: DtxDoc): number {
  const used = new Set<number>();
  for (const c of doc.chips) if (c.ch !== CH.BPM && c.ch !== CH.BPM_EX) used.add(c.v);
  let n = 0;
  for (let i = 1; i < 36 * 36; i++) if (!used.has(i) && doc.fields['WAV' + toBase36x2(i)] === undefined) n++;
  return n;
}

function envFor(doc: DtxDoc, side: FxSide) {
  return { side, tempo: tempoOf(doc), laneIndex, soundSec, known };
}

/**
 * ほかの難易度の譜面のチップの音を、カーブ side に合わせた譜面（保存のときに同じカーブを入れる・この難易度だけにする）。
 * side が null（カーブを使っていない）なら、かけた音を元の音に戻す。直すものが無ければ null。先に warmLengthsOf で長さを読んでおく
 */
export function reconcileOther(doc: DtxDoc, side: FxSide | null): DtxDoc | null {
  const r = reconcileFx(doc, envFor(doc, side ?? emptyFxSide()));
  if (!r) return null;
  for (const [k, v] of r.made) known.set(k, v);
  return r.doc;
}

addDocFixer((_prev, next) => {
  const side = useSidecar.getState().fx;
  if (!side) return null;
  const r = reconcileFx(next, envFor(next, side));
  if (!r) return null;
  for (const [k, v] of r.made) known.set(k, v);
  if (r.full && Date.now() - fullWarned > 5000) {
    fullWarned = Date.now();
    queueMicrotask(() =>
      toast(
        tr(
          `WAV 番号（01〜ZZ）が足りないため、${r.full} 個のチップはかけた音にできませんでした。右のパネルのなめらかさを「粗い」にするか、カーブを減らしてください`,
          `Ran out of WAV numbers (01–ZZ), so ${r.full} ${pl(r.full, 'chip')} couldn't get the effect. Set the smoothness to "Coarse" in the right panel or use fewer curves`,
        ),
        'error',
        9000,
      ),
    );
  } else if (r.made.size && Date.now() - lowWarned > 60000) {
    const free = freeCount(r.doc);
    if (free < WAV_LOW) {
      lowWarned = Date.now();
      queueMicrotask(() =>
        toast(
          tr(
            `WAV 番号の残りが ${free} です（01〜ZZ の 1,295 まで）。なめらかさを「粗い」にすると、作る音の数が減ります`,
            `Only ${free} WAV numbers are left (up to 1,295: 01–ZZ). Setting the smoothness to "Coarse" makes fewer sounds`,
          ),
          'warn',
          8000,
        ),
      );
    }
  }
  return { doc: r.doc, redo: r.redo, undo: r.undo, sounds: true };
});

// 長さを知らない音を読む（譜面を開いた・カーブを変えた）
useEditor.subscribe((s, prev) => {
  if (s.doc !== prev.doc && useSidecar.getState().fx) scheduleWarm();
});
useSidecar.subscribe((s, prev) => {
  if (s.fx !== prev.fx) {
    scheduleWarm();
    // 開き直した・難易度を切り替えたら、選んでいたカーブは外す
    const id = fget().curveId;
    if (id && !s.fx?.curves.some((c) => c.id === id)) fset({ curveId: null, point: null });
  }
});

// ---- 開く・閉じる ---------------------------------------------------------------------------

let restore: { audioCols: boolean; waveMode: 'wave' | 'spec' } | null = null;

/** エフェクトの編集を開く・閉じる（E）。原曲のスペクトルを出し、閉じたら前の表示に戻す */
export function openFx(on = !fget().open) {
  if (on === fget().open) return;
  if (on) {
    if (useVel.getState().mode) toggleVelMode(false);
    const a = useAssist.getState();
    restore = { audioCols: a.audioCols, waveMode: a.waveMode };
    if (!a.audioCols) useAssist.setState({ audioCols: true });
    if (a.waveMode !== 'spec') setWaveMode('spec');
    const side = useSidecar.getState().fx;
    const first = side?.curves[0];
    fset({ open: true, curveId: fget().curveId ?? first?.id ?? null, point: null });
    void warmLengths();
    return;
  }
  fset({ open: false, point: null, live: null, proposals: null, read: null });
  if (restore) {
    if (useAssist.getState().waveMode !== restore.waveMode) setWaveMode(restore.waveMode);
    if (useAssist.getState().audioCols !== restore.audioCols) useAssist.setState({ audioCols: restore.audioCols });
    restore = null;
  }
}

// ベロシティの編集を開いたら閉じる
useVel.subscribe((s, prev) => {
  if (s.mode && !prev.mode && fget().open) openFx(false);
});

// ---- カーブを変える ---------------------------------------------------------------------------

/**
 * カーブを変えて、チップの音をそろえる（Ctrl+Z で一緒に戻る）。before は変える前（ドラッグなら押したとき）
 */
export function commitFx(next: FxSide, label: string, before: FxSide | null = useSidecar.getState().fx): boolean {
  fset({ live: null });
  if (JSON.stringify(before) === JSON.stringify(next)) {
    if (useSidecar.getState().fx !== before) setFxSide(before);
    return false;
  }
  const hist = { undo: () => setFxSide(before), redo: () => setFxSide(next) };
  setFxSide(next);
  if (!edit(label, () => {}, { side: hist })) recordSide(label, hist);
  void refreshAfterChange();
  return true;
}

/** カーブを変えたあと：再生中なら鳴らし直す */
async function refreshAfterChange() {
  await prepareSounds();
  refreshPlayback();
}

const cur = (): FxSide => fxSide() ?? emptyFxSide();

function newId(s: FxSide): string {
  let n = 1;
  while (s.curves.some((c) => c.id === `c${n}`)) n++;
  return `c${n}`;
}

const putCurve = (s: FxSide, c: FxCurve): FxSide => ({ ...s, curves: s.curves.map((x) => (x.id === c.id ? c : x)) });

export function typeName(t: FxType): string {
  return t === 'hicut' ? tr('ハイカット', 'High cut') : t === 'locut' ? tr('ローカット', 'Low cut') : tr('ピッチ', 'Pitch');
}

/** かけるレーンの説明（全部・HH・SD） */
export function lanesText(lanes: readonly string[] | null): string {
  if (!lanes || lanes.length === DRUM_LANES.length) return tr('全部のレーン', 'All lanes');
  if (!lanes.length) return tr('レーンなし', 'No lanes');
  return lanes.join(tr('・', ', '));
}

/** カーブのかかる所の数（かけない値をはさんで分かれる） */
export function curveRegions(c: FxCurve): number {
  const pts = sortPoints(c.points);
  let n = 0;
  let inside = false;
  for (let i = 0; i < pts.length; i++) {
    const on = applies(c.type, roundValue(c.type, pts[i].v, 6)) || (i + 1 < pts.length && applies(c.type, roundValue(c.type, pts[i + 1].v, 6)) && pts[i].s !== 'hold');
    if (on && !inside) n++;
    inside = on;
  }
  return n;
}

export function selectCurve(id: string | null) {
  fset({ curveId: id, point: null });
}

export function selectPoint(curveId: string, index: number | null) {
  fset({ curveId, point: index });
}

/** カーブを足す（初めは全部のレーン）。足したカーブの id */
export function addCurve(type: FxType, lanes: string[] | null = null): string {
  const s = cur();
  const id = newId(s);
  commitFx({ ...s, curves: [...s.curves, { id, type, points: [], lanes, q: 0 }] }, tr(`${typeName(type)}のカーブを足す`, `Add a ${typeName(type).toLowerCase()} curve`));
  fset({ curveId: id, point: null });
  return id;
}

export function removeCurve(id: string) {
  const s = cur();
  const c = s.curves.find((x) => x.id === id);
  if (!c) return;
  commitFx({ ...s, curves: s.curves.filter((x) => x.id !== id) }, tr(`${typeName(c.type)}のカーブを消す`, `Delete the ${typeName(c.type).toLowerCase()} curve`));
  if (fget().curveId === id) fset({ curveId: useSidecar.getState().fx?.curves[0]?.id ?? null, point: null });
}

export function setCurveType(id: string, type: FxType) {
  const s = cur();
  const c = s.curves.find((x) => x.id === id);
  if (!c || c.type === type) return;
  // 値は同じ高さの所へ（周波数 ⇄ 半音）
  const conv = (v: number) => {
    const x = isFilter(c.type) ? Math.log(v / FX_LO) / Math.log(FX_HI / FX_LO) : 0.5 + v / (2 * PITCH_RANGE);
    return isFilter(type) ? FX_LO * Math.pow(FX_HI / FX_LO, x) : (x - 0.5) * 2 * PITCH_RANGE;
  };
  const points = c.points.map((p) => ({ ...p, v: roundValue(type, conv(p.v), s.res) }));
  commitFx(putCurve(s, { ...c, type, points }), tr(`カーブを${typeName(type)}にする`, `Make the curve ${typeName(type).toLowerCase()}`));
}

export function setCurveLanes(id: string, lanes: string[] | null) {
  const s = cur();
  const c = s.curves.find((x) => x.id === id);
  if (!c) return;
  const norm = lanes && lanes.length === DRUM_LANES.length ? null : lanes ? DRUM_LANES.map((l) => l.key).filter((k) => lanes.includes(k)) : null;
  commitFx(putCurve(s, { ...c, lanes: norm }), tr('エフェクトをかけるレーンを変える', 'Change the lanes for the effect'));
}

/** レーンを足す・外す（全部のときに押したら、そのレーンだけにする） */
export function toggleCurveLane(id: string, key: string) {
  const c = cur().curves.find((x) => x.id === id);
  if (!c) return;
  const all = DRUM_LANES.map((l) => l.key);
  const now = c.lanes ?? all;
  let next = now.includes(key) ? now.filter((k) => k !== key) : [...now, key];
  if (!c.lanes) next = [key];
  setCurveLanes(id, next.length ? next : null);
}

export function setCurveQ(id: string, q: FxEmphasis) {
  const s = cur();
  const c = s.curves.find((x) => x.id === id);
  if (!c || c.q === q) return;
  commitFx(putCurve(s, { ...c, q }), tr('境目の強調を変える', 'Change the emphasis'));
}

export function setFxRes(res: FxRes) {
  const s = cur();
  if (s.res === res) return;
  commitFx({ ...s, res }, tr('エフェクトのなめらかさを変える', 'Change the effect smoothness'));
}

export function setFxTails(tails: boolean) {
  const s = cur();
  if (s.tails === tails) return;
  commitFx({ ...s, tails }, tails ? tr('長く鳴る音の余韻もカーブどおりにする', 'Let long sounds follow the curve') : tr('長く鳴る音は鳴り始めの値だけにする', 'Use only the start value for long sounds'));
}

/** 値を列の範囲に収め、なめらかさの段に丸める */
export function clampValue(type: FxType, v: number, res: FxRes = cur().res): number {
  if (type === 'pitch') return Math.max(-PITCH_RANGE, Math.min(PITCH_RANGE, roundValue(type, v, res)));
  return Math.max(FX_LO, Math.min(FX_HI, roundValue(type, Math.max(FX_LO, Math.min(FX_HI, v)), res)));
}

const posPoint = (pos: Pos, v: number, s?: FxShape): FxPoint => ({ m: pos.m, n: pos.f.n, d: pos.f.d, v, ...(s && s !== 'smooth' ? { s } : {}) });
const samePos = (a: FxPoint, b: Pick<FxPoint, 'm' | 'n' | 'd'>) => a.m === b.m && a.n * b.d === b.n * a.d;

/** 点を置いた形（同じ時刻の点があれば値を替える）。点の番号も返す */
function withPoint(c: FxCurve, p: FxPoint): { curve: FxCurve; index: number } {
  const same = c.points.find((q) => samePos(q, p));
  const pts = same ? c.points.map((q) => (q === same ? { ...q, v: p.v } : q)) : [...c.points, p];
  const sorted = sortPoints(pts);
  const at = sorted.findIndex((q) => samePos(q, p));
  return { curve: { ...c, points: sorted }, index: at };
}

/** 点を足す（カーブを選んでいなければハイカットのカーブを作る）。選んだ点にする */
export function addPoint(curveId: string | null, pos: Pos, v: number): { curveId: string; index: number } | null {
  let s = cur();
  let id = curveId;
  if (!id || !s.curves.some((c) => c.id === id)) {
    id = newId(s);
    s = { ...s, curves: [...s.curves, { id, type: 'hicut', points: [], lanes: null, q: 0 }] };
  }
  const c = s.curves.find((x) => x.id === id)!;
  const { curve, index } = withPoint(c, posPoint(pos, clampValue(c.type, v, s.res)));
  commitFx(putCurve(s, curve), tr('エフェクトの点を足す', 'Add an effect point'));
  fset({ curveId: id, point: index });
  return { curveId: id, index };
}

/** ドラッグ中：点を動かした形を見せる（作業ファイルにはまだ入れない）。動かした点の新しい番号 */
export function movePointLive(base: FxSide, curveId: string, index: number, pos: Pos, v: number): number {
  const c = base.curves.find((x) => x.id === curveId);
  if (!c) return index;
  const sorted = sortPoints(c.points);
  const p = sorted[index];
  if (!p) return index;
  const moved: FxPoint = { ...p, m: pos.m, n: pos.f.n, d: pos.f.d, v: clampValue(c.type, v, base.res) };
  // 同じ時刻にほかの点があれば、そこへは動かさない（時刻はそのまま）
  const clash = sorted.some((q, i) => i !== index && samePos(q, moved));
  const to = clash ? { ...moved, m: p.m, n: p.n, d: p.d } : moved;
  const pts = sortPoints(sorted.map((q, i) => (i === index ? to : q)));
  const at = pts.indexOf(to);
  fset({ live: putCurve(base, { ...c, points: pts }), point: at });
  return at;
}

/** ドラッグを終えた（動かしていればまとめて入れる） */
export function finishLive(before: FxSide | null, label = tr('エフェクトの点を動かす', 'Move an effect point')) {
  const live = fget().live;
  if (!live) return;
  commitFx(live, label, before);
}

export function cancelLive() {
  fset({ live: null });
}

export function deletePoint(curveId: string, index: number) {
  const s = cur();
  const c = s.curves.find((x) => x.id === curveId);
  if (!c) return;
  const sorted = sortPoints(c.points);
  if (!sorted[index]) return;
  commitFx(putCurve(s, { ...c, points: sorted.filter((_, i) => i !== index) }), tr('エフェクトの点を消す', 'Delete an effect point'));
  fset({ point: null });
}

/** 選んだ点を消す（Delete）。消したら true */
export function deleteSelectedPoint(): boolean {
  const { open, curveId, point } = fget();
  if (!open || !curveId || point === null) return false;
  deletePoint(curveId, point);
  return true;
}

export function setPointValue(curveId: string, index: number, v: number) {
  const s = cur();
  const c = s.curves.find((x) => x.id === curveId);
  const p = c ? sortPoints(c.points)[index] : undefined;
  if (!c || !p) return;
  const nv = clampValue(c.type, v, s.res);
  if (nv === p.v) return;
  commitFx(putCurve(s, { ...c, points: sortPoints(c.points).map((q, i) => (i === index ? { ...q, v: nv } : q)) }), tr(`エフェクトの点を ${valueLabel(c.type, nv)} にする`, `Set an effect point to ${valueLabel(c.type, nv)}`));
}

/** 選んだ点の値を 1 段上げ下げ（‹ ›・← →）。動かしたら true */
export function stepSelectedPoint(dir: 1 | -1): boolean {
  const { open, curveId, point } = fget();
  const s = cur();
  const c = s.curves.find((x) => x.id === curveId);
  const p = c && point !== null ? sortPoints(c.points)[point] : undefined;
  if (!open || !c || !p || point === null) return false;
  setPointValue(c.id, point, stepValue(c.type, p.v, s.res, dir));
  return true;
}

export function setPointShape(curveId: string, index: number, shape: FxShape) {
  const s = cur();
  const c = s.curves.find((x) => x.id === curveId);
  const p = c ? sortPoints(c.points)[index] : undefined;
  if (!c || !p || (p.s ?? 'smooth') === shape) return;
  commitFx(
    putCurve(s, { ...c, points: sortPoints(c.points).map((q, i) => (i === index ? posPoint({ m: q.m, f: { n: q.n, d: q.d } }, q.v, shape) : q)) }),
    tr('エフェクトの点の形を変える', 'Change the shape of an effect point'),
  );
}

export function shapeName(s: FxShape | undefined): string {
  switch (s) {
    case 'slow':
      return tr('ゆっくり', 'Slow');
    case 'fast':
      return tr('急に', 'Fast');
    case 'scurve':
      return tr('S字', 'S-curve');
    case 'hold':
      return tr('そのまま', 'Hold');
    default:
      return tr('なめらか', 'Linear');
  }
}

export const FX_SHAPES: readonly FxShape[] = ['smooth', 'slow', 'fast', 'scurve', 'hold'];

// ---- 譜面に描くもの ----------------------------------------------------------------------

const beatsCache = new WeakMap<FxSide, { tempo: TempoMap; curves: CurveBeats[] }>();
/** 拍で並べたカーブ（描くたびに数えない） */
export function sideBeats(side: FxSide, tempo: TempoMap): CurveBeats[] {
  const hit = beatsCache.get(side);
  if (hit && hit.tempo === tempo) return hit.curves;
  const curves = side.curves.filter((c) => c.points.length > 0).map((c) => curveBeats(c, tempo, laneIndex));
  beatsCache.set(side, { tempo, curves });
  return curves;
}

/** そのレーン・その拍のチップにかかる値（丸めたもの）。かけなければ null。表示用 */
export function chipValueAt(curves: readonly CurveBeats[], lane: number, beat: number, res: FxRes): { type: FxType; text: string } | null {
  const v = valsAt(curves, lane, beat);
  const parts: { type: FxType; text: string }[] = [];
  if (v.hicut !== null) {
    const r = roundValue('hicut', v.hicut, res);
    if (applies('hicut', r)) parts.push({ type: 'hicut', text: valueLabel('hicut', r) });
  }
  if (v.locut !== null) {
    const r = roundValue('locut', v.locut, res);
    if (applies('locut', r)) parts.push({ type: 'locut', text: valueLabel('locut', r) });
  }
  if (v.pitch !== null) {
    const r = roundValue('pitch', v.pitch, res);
    if (applies('pitch', r)) parts.push({ type: 'pitch', text: valueLabel('pitch', r) });
  }
  if (!parts.length) return null;
  return { type: parts[0].type, text: parts.map((p) => p.text).join('·') };
}

/** 点の位置（拍） */
export const pointBeatOf = (tempo: TempoMap, p: FxPoint) => pointBeat(tempo, p);

// ---- 数（右のパネル・知らせ） -----------------------------------------------------------------

export interface FxStats {
  /** かけた音にしたチップ */
  chips: number;
  /** かけた音のファイルの数 */
  files: number;
  /** ファイルの大きさの目安（バイト） */
  bytes: number;
  /** かけた音の WAV 番号の数 */
  wavs: number;
  /** あいている WAV 番号 */
  free: number;
}

const statsCache = new WeakMap<DtxDoc, FxStats>();
export function fxStats(doc: DtxDoc): FxStats {
  const hit = statsCache.get(doc);
  if (hit) return hit;
  const infos = fxWavs(doc);
  let chips = 0;
  const files = new Map<string, FxInfo>();
  for (const c of doc.chips) {
    const info = infos.get(c.v);
    if (!info) continue;
    chips++;
    files.set(lower(doc.fields['WAV' + toBase36x2(c.v)] ?? ''), info);
  }
  let bytes = 0;
  for (const info of files.values()) {
    const sec = Math.max(0.2, lenCache.get(lower(info.orig)) ?? 0.5);
    const rate = info.spec.pt ? Math.pow(2, (info.spec.pt[0]?.v ?? 0) / 12) : 1;
    bytes += (sec / rate) * (fxExt(info.orig) === 'wav' ? 176400 : 24000);
  }
  const out = { chips, files: files.size, bytes, wavs: infos.size, free: freeCount(doc) };
  statsCache.set(doc, out);
  return out;
}

// ---- 切って聴く --------------------------------------------------------------------------------

let bypassMemo: { doc: DtxDoc; out: DtxDoc } | null = null;

/** かけた音のチップを元の音に戻した譜面（再生だけで使う。足りない元の音は空いている番号に足す） */
export function bypassDoc(doc: DtxDoc): DtxDoc {
  if (bypassMemo?.doc === doc) return bypassMemo.out;
  const fx = fxWavs(doc);
  if (!fx.size) return doc;
  const labels = new Map<number, string>();
  for (const h of doc.header) if (h.kind === 'field' && /^WAV[0-9A-Z]{2}$/.test(h.key) && h.comment?.trim()) labels.set(parseInt(h.key.slice(3), 36), h.comment.trim().toLowerCase());
  const keyOf = (path: string, vol: number, pan: number, label: string) => `${lower(path)}|${vol}|${pan}|${label}`;
  const index = new Map<string, number>();
  for (const [k, v] of Object.entries(doc.fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k)) continue;
    const no = parseInt(k.slice(3), 36);
    if (fx.has(no)) continue;
    const id = keyOf(v, Math.round(wavVolumeOf(doc.fields, no)), Math.round(wavPanOf(doc.fields, no)), labels.get(no) ?? '');
    if (!index.has(id)) index.set(id, no);
  }
  const out = produce(doc, (d) => {
    const map = new Map<number, number>();
    for (const [no, info] of fx) {
      const vol = Math.round(wavVolumeOf(doc.fields, no));
      const pan = Math.round(wavPanOf(doc.fields, no));
      const id = keyOf(info.orig, vol, pan, labels.get(no) ?? '');
      let to = index.get(id);
      if (to === undefined) {
        const n = freeWavNumber(d as DtxDoc);
        if (n === null) continue;
        const z = toBase36x2(n);
        setField(d, 'WAV' + z, info.orig);
        if (vol !== 100) setField(d, 'VOLUME' + z, String(vol));
        if (pan !== 0) setField(d, 'PAN' + z, String(pan));
        const label = labels.get(no);
        if (label) setFieldComment(d, 'WAV' + z, label);
        index.set(id, n);
        to = n;
      }
      map.set(no, to);
    }
    for (const c of d.chips) {
      const to = map.get(c.v);
      if (to !== undefined && drumChannel(c.ch)) c.v = to;
    }
  });
  bypassMemo = { doc, out };
  return out;
}

addPlayDocTransform((doc) => (fget().bypass ? bypassDoc(doc) : doc));
addSoundDocs(() => (fget().bypass ? [bypassDoc(useEditor.getState().doc)] : []));

export function setBypass(on: boolean) {
  if (fget().bypass === on) return;
  fset({ bypass: on });
  void refreshAfterChange();
}

// ---- テンプレート（チップを選んで右クリック） --------------------------------------------------------

interface TemplateRange {
  a: number;
  b: number;
  end: number;
  mid: number;
  lanes: string[] | null;
  tempo: TempoMap;
}

function templateRange(id: FxTemplateId, ids: readonly number[]): TemplateRange | null {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const want = new Set(ids);
  const beats: number[] = [];
  const laneSet = new Set<string>();
  for (const c of s.doc.chips) {
    if (!want.has(c.id)) continue;
    const d = drumChannel(c.ch);
    if (!d) continue;
    beats.push(tempo.beatOf(c.m, c.f));
    laneSet.add(DRUM_LANES[d.lane].key);
  }
  if (!beats.length) return null;
  const a = Math.min(...beats);
  const b = Math.max(...beats);
  const step = 4 / s.view.div;
  const endPos = snapToGrid(tempo, b + step, s.view.div);
  const end = tempo.beatOf(endPos.m, endPos.f);
  const midPos = snapToGrid(tempo, (a + b) / 2, s.view.div);
  const mid = tempo.beatOf(midPos.m, midPos.f);
  // ピッチは選んだチップのレーンだけ（キックやシンバルまで高くしない）。フィルターは全部のレーン
  const lanes = templateById.get(id)?.type === 'pitch' ? DRUM_LANES.map((l) => l.key).filter((k) => laneSet.has(k)) : null;
  return { a, b, end: Math.max(end, b + 1e-6), mid, lanes, tempo };
}

const pos = (tempo: TempoMap, beat: number) => formatPosition(tempo, beat);

/** テンプレートの説明（右クリックのメニューの下に出す） */
export function templateNote(id: FxTemplateId, ids: readonly number[]): string {
  const r = templateRange(id, ids);
  if (!r) return '';
  const A = pos(r.tempo, r.a);
  const B = pos(r.tempo, r.b);
  const E = pos(r.tempo, r.end);
  const M = pos(r.tempo, r.mid);
  const where = r.lanes ? tr(`${r.lanes.join('・')} のレーン`, `the ${r.lanes.join('/')} ${pl(r.lanes.length, 'lane')}`) : tr('全部のレーン', 'all lanes');
  const head = tr(
    `選んだチップで決まるのは時間だけ。${A}〜${E} の${where}にかかり、あとから置くチップにもかかります。`,
    `The selection only sets the time. It applies to ${where} from ${A} to ${E}, including chips you place later. `,
  );
  const hz = (v: number) => `${valueLabel('hicut', v)} Hz`;
  switch (id) {
    case 'close':
      return head + tr(`${B} までに ${hz(TEMPLATE_HICUT)} まで下げ、${E} で元に戻します`, `It goes down to ${hz(TEMPLATE_HICUT)} by ${B} and back at ${E}`);
    case 'open':
      return head + tr(`${hz(TEMPLATE_HICUT)} から、${B} までに開いていきます`, `It opens up from ${hz(TEMPLATE_HICUT)} by ${B}`);
    case 'dip':
      return head + tr(`${M} で ${hz(TEMPLATE_HICUT)} まで下げ、${B} までに戻します`, `It goes down to ${hz(TEMPLATE_HICUT)} at ${M} and back by ${B}`);
    case 'hold':
      return head + tr(`${E} の手前まで ${hz(TEMPLATE_HICUT)} でかけ、${E} で元に戻します`, `It stays at ${hz(TEMPLATE_HICUT)} until ${E}, then goes back`);
    case 'locut':
      return head + tr(`${B} までに ${TEMPLATE_LOCUT} Hz より低い音を削り、${E} で元に戻します`, `It cuts the sound below ${TEMPLATE_LOCUT} Hz by ${B} and goes back at ${E}`);
    case 'pitch':
      return head + tr(`${B} までに半音ずつ +${TEMPLATE_PITCH}（1 オクターブ）まで上げ、${E} で元に戻します`, `It rises a semitone at a time up to +${TEMPLATE_PITCH} (an octave) by ${B} and goes back at ${E}`);
  }
}

/**
 * テンプレートでカーブを引く。同じ種類・同じレーンのカーブがあって範囲が重ならなければ、そのカーブに点を足す
 * （1 本のカーブに何か所も）。重なればカーブを足す
 */
export function applyTemplate(id: FxTemplateId, ids: readonly number[]): boolean {
  const def = templateById.get(id);
  const r = templateRange(id, ids);
  if (!def || !r) return false;
  const s0 = cur();
  const pts = templatePoints(id, r.a, r.b, r.end, r.mid).map((p) => {
    const at = snapToGrid(r.tempo, p.beat, 192);
    return posPoint(at, clampValue(def.type, p.v, s0.res), p.s);
  });
  const lanesKey = (l: string[] | null) => (l ? l.join(',') : '*');
  const first = pts[0];
  const last = pts[pts.length - 1];
  const fb = pointBeat(r.tempo, first);
  const lb = pointBeat(r.tempo, last);
  const on = (type: FxType, v: number) => applies(type, roundValue(type, v, s0.res));
  const into = s0.curves.find((c) => {
    if (c.type !== def.type || lanesKey(c.lanes) !== lanesKey(r.lanes)) return false;
    const sorted = sortPoints(c.points);
    if (sorted.some((p) => pointBeat(r.tempo, p) >= fb - 1e-6 && pointBeat(r.tempo, p) <= lb + 1e-6)) return false;
    // 前の点からかけない値のまま来て（入れる点へ向かって動き出さない）、あとの点もかけない値なら、あいだに入れてよい
    const before = sorted.filter((p) => pointBeat(r.tempo, p) < fb).pop();
    const after = sorted.find((p) => pointBeat(r.tempo, p) > lb);
    if (before && (on(c.type, before.v) || (before.s !== 'hold' && on(c.type, first.v)))) return false;
    if (after && on(c.type, after.v)) return false;
    return true;
  });
  let next: FxSide;
  let curveId: string;
  if (into) {
    curveId = into.id;
    next = putCurve(s0, { ...into, points: sortPoints([...into.points, ...pts]) });
  } else {
    curveId = newId(s0);
    next = { ...s0, curves: [...s0.curves, { id: curveId, type: def.type, points: pts, lanes: r.lanes, q: 0 }] };
  }
  if (!commitFx(next, tr(`エフェクト「${def.name}」をかける`, `Apply the "${def.name}" effect`))) return false;
  const entry = lastHistory();
  fset({ curveId, point: null });
  // 知らせ：選んだチップのうちかけた音にしたもの
  const doc = useEditor.getState().doc;
  const fx = fxWavs(doc);
  const want = new Set(ids);
  let n = 0;
  let total = 0;
  const made = new Set<string>();
  for (const c of doc.chips) {
    if (!want.has(c.id) || !drumChannel(c.ch)) continue;
    total++;
    if (fx.has(c.v)) {
      n++;
      made.add(lower(doc.fields['WAV' + toBase36x2(c.v)] ?? ''));
    }
  }
  const { m: m0 } = r.tempo.locate(r.a);
  const { m: m1 } = r.tempo.locate(r.b);
  const mm = (m: number) => String(m).padStart(3, '0');
  const range = m0 === m1 ? mm(m0) : `${mm(m0)}〜${mm(m1)}`;
  const shallow = total - n;
  toast(
    tr(
      `${def.name} をかけました（${range} 小節）。選んだ ${total} 個のうち ${n} 個を、かけた音（${made.size} 個）に替えました。${shallow ? `かかりがごく浅い ${shallow} 個は元の音のまま。` : ''}音は保存するときに曲フォルダの fx/ に書き出します`,
      `Applied ${def.name} (${m0 === m1 ? 'measure' : 'measures'} ${range}). ${n} of the ${total} selected ${pl(total, 'chip')} now use effect sounds (${made.size}).${shallow ? ` ${shallow} with a very light effect keep the original sound.` : ''} The sounds are written to fx/ in the song folder when you save`,
    ),
    'ok',
    9000,
    { label: tr('元に戻す', 'Undo'), run: () => void undoIfLast(entry) },
    { label: tr('カーブを開く E', 'Open curves (E)'), run: () => openFx(true) },
  );
  return true;
}

// ---- 原曲から読み取る ---------------------------------------------------------------------------

export function openRead(on = !fget().read) {
  fset({ read: on ? (fget().read ?? { scope: useAssist.getState().loop ? 'loop' : 'view', what: 'hicut', busy: false, note: null }) : null, proposals: on ? fget().proposals : null });
}

export function setReadOpts(p: Partial<Pick<NonNullable<FxUi['read']>, 'scope' | 'what'>>) {
  const r = fget().read;
  if (r) fset({ read: { ...r, ...p } });
}

/** 秒の点を、拍の点（グリッドに吸着、同じ所は 1 つ）に */
function toPoints(tempo: TempoMap, off: number, keys: readonly { sec: number; v: number }[], type: ReadKind, res: FxRes, div: number): FxPoint[] {
  const out: FxPoint[] = [];
  for (const k of keys) {
    const at = snapToGrid(tempo, Math.max(0, tempo.secToBeat(k.sec + off)), div);
    const p = posPoint(at, clampValue(type, k.v, res));
    const last = out[out.length - 1];
    if (last && samePos(last, p)) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

const EPS_OCT = [0.35, 0.7, 1.2, 2];

function buildProposal(tempo: TempoMap, off: number, regions: ReadRegion[], type: ReadKind, thin: number): FxProposal {
  const s = cur();
  const div = useEditor.getState().view.div;
  const eps = EPS_OCT[Math.min(EPS_OCT.length - 1, thin)];
  const points: FxPoint[] = [];
  const out: FxProposal['regions'] = [];
  for (const g of regions) {
    const pts = toPoints(tempo, off, thinKeys(g.raw, eps), type, s.res, div);
    points.push(...pts);
    const deep = g.raw.reduce((a, k) => (type === 'hicut' ? Math.min(a, k.v) : Math.max(a, k.v)), type === 'hicut' ? FX_HI : FX_LO);
    const from = tempo.secToBeat(g.from + off);
    const to = tempo.secToBeat(g.to + off);
    out.push({
      from,
      to,
      text: tr(
        `${pos(tempo, from)}〜${pos(tempo, to)}：開放 → ${valueLabel(type, roundValue(type, deep, s.res))} Hz → 開放`,
        `${pos(tempo, from)}–${pos(tempo, to)}: open → ${valueLabel(type, roundValue(type, deep, s.res))} Hz → open`,
      ),
    });
  }
  return { type, points: sortPoints(points), regions: out, raw: regions.map((g) => g.raw.map((k) => ({ beat: tempo.secToBeat(k.sec + off), v: k.v }))), thin };
}

let lastRead: { regions: ReadRegion[]; off: number; type: ReadKind }[] = [];

/** 原曲のスペクトルで、高い帯域（低い帯域）だけ暗い所を探して、点線の案を出す */
export async function readFromOriginal(range: { from: number; to: number }): Promise<void> {
  const r = fget().read;
  if (!r || r.busy) return;
  const a = useAssist.getState();
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  const key = a.src?.key;
  if (!key || !bgm) {
    fset({ read: { ...r, note: tr('原曲の解析が済んでいません（原曲を読み込むと使えます）', 'The original has not been analyzed yet (load the original audio first)') } });
    return;
  }
  fset({ read: { ...r, busy: true, note: null } });
  try {
    const sp = await wk.spectrogram(key, 'raw');
    const tempo = tempoOf(doc);
    const off = bgm.sec;
    const sec = (beat: number) => tempo.beatToSec(beat) - off;
    const scope = r.scope === 'loop' && a.loop ? { from: a.loop.a, to: a.loop.b } : r.scope === 'song' ? { from: 0, to: Infinity } : range;
    const from = Math.max(0, sec(scope.from));
    const to = Number.isFinite(scope.to) ? sec(scope.to) : sp.frames / sp.rate;
    const kinds: ReadKind[] = r.what === 'both' ? ['hicut', 'locut'] : [r.what];
    lastRead = kinds.map((type) => ({ type, off, regions: readCuts(sp, type, from, to) }));
    const proposals = lastRead.filter((x) => x.regions.length).map((x) => buildProposal(tempo, off, x.regions, x.type, 0));
    const now = fget().read;
    fset({
      proposals: proposals.length ? proposals : null,
      read: now ? { ...now, busy: false, note: proposals.length ? null : tr('この範囲には、それらしい所が見つかりませんでした', 'Nothing like that was found in this range') } : null,
    });
  } catch {
    const now = fget().read;
    fset({ read: now ? { ...now, busy: false, note: tr('原曲のスペクトルを作れませんでした', "Couldn't make the spectrum of the original") } : null });
  }
}

/** 案の点を減らす */
export function thinProposals() {
  const ps = fget().proposals;
  if (!ps) return;
  const tempo = tempoOf(useEditor.getState().doc);
  fset({
    proposals: ps.map((p) => {
      const src = lastRead.find((x) => x.type === p.type);
      return src ? buildProposal(tempo, src.off, src.regions, p.type, Math.min(EPS_OCT.length - 1, p.thin + 1)) : p;
    }),
  });
}

export function dropProposals() {
  fset({ proposals: null });
}

/** 案を採用する（種類ごとにカーブを 1 本足す） */
export function adoptProposals() {
  const ps = fget().proposals;
  if (!ps?.length) return;
  let s = cur();
  let firstId: string | null = null;
  for (const p of ps) {
    const id = newId(s);
    firstId ??= id;
    s = { ...s, curves: [...s.curves, { id, type: p.type, points: p.points, lanes: null, q: 0 }] };
  }
  commitFx(s, tr('原曲から読み取ったカーブを入れる', 'Add curves read from the original'));
  fset({ proposals: null, read: null, curveId: firstId, point: null });
}

// ---- そのほか ----------------------------------------------------------------------------------

/** 値の列の中の位置（0〜1）の説明（ドラッグ中の吹き出し） */
export function valueText(type: FxType, v: number): string {
  if (type === 'pitch') return tr(`${valueLabel(type, v)} 半音`, `${valueLabel(type, v)} st`);
  const open = type === 'hicut' ? !applies('hicut', v) : !applies('locut', v);
  return open ? tr(`${valueLabel(type, v)} Hz（かけない）`, `${valueLabel(type, v)} Hz (off)`) : `${valueLabel(type, v)} Hz`;
}

/** 「かけない」端の値 */
export const openOf = (type: FxType) => openValue(type);

// ---- WAV の表 ----------------------------------------------------------------------------------

export interface FxWavGroup {
  /** 元の音のパス（#WAV に書くもの） */
  orig: string;
  /** かけた音の WAV 番号（番号の順） */
  nos: number[];
  /** かけた音のファイルの数（強さ違いは同じファイル） */
  files: number;
  /** 種類と値の幅（ハイカット 0.9〜12.5 kHz） */
  text: string;
  types: FxType[];
}

const groupCache = new WeakMap<DtxDoc, Map<string, FxWavGroup>>();
/** かけた音を元の音（パス小文字）ごとにまとめる（WAV の表） */
export function fxWavGroups(doc: DtxDoc): Map<string, FxWavGroup> {
  const hit = groupCache.get(doc);
  if (hit) return hit;
  const out = new Map<string, FxWavGroup>();
  const files = new Map<string, Set<string>>();
  const vals = new Map<string, Map<FxType, number[]>>();
  for (const [no, info] of [...fxWavs(doc)].sort((a, b) => a[0] - b[0])) {
    const k = lower(info.orig);
    let g = out.get(k);
    if (!g) {
      g = { orig: info.orig, nos: [], files: 0, text: '', types: [] };
      out.set(k, g);
      files.set(k, new Set());
      vals.set(k, new Map());
    }
    g.nos.push(no);
    files.get(k)!.add(lower(String(doc.fields[`WAV${toBase36x2(no)}`] ?? '')));
    const vm = vals.get(k)!;
    const add = (t: FxType, keys: readonly { v: number }[] | undefined) => {
      if (!keys) return;
      const list = vm.get(t) ?? [];
      for (const key of keys) list.push(key.v);
      vm.set(t, list);
    };
    add('hicut', info.spec.hc);
    add('locut', info.spec.lc);
    add('pitch', info.spec.pt);
  }
  for (const [k, g] of out) {
    g.files = files.get(k)!.size;
    const vm = vals.get(k)!;
    g.types = (['hicut', 'locut', 'pitch'] as const).filter((t) => vm.has(t));
    g.text = g.types
      .map((t) => {
        const vs = vm.get(t)!.filter((v) => v !== 0);
        if (!vs.length) return typeName(t);
        const lo = Math.min(...vs);
        const hi = Math.max(...vs);
        const unit = t === 'pitch' ? '' : ' Hz';
        const range = lo === hi ? valueLabel(t, lo) : `${valueLabel(t, lo)}〜${valueLabel(t, hi)}`;
        return `${typeName(t)} ${range}${unit}`;
      })
      .join(' · ');
  }
  groupCache.set(doc, out);
  return out;
}
