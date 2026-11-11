// 音の切り出し（ステム・原曲から、チップを置いた所の音を WAV にして、特殊ノーツやレーンの音にする）の操作。
// 画面は ui/CutDialog、鳴り始め・切り方・重ね方は audio/cut。決まり（承認済みのデザインの「音の切り出し」）:
// - 元はドラムのステム（あれば）、ほかのステム、原曲。ステムと原曲は BGM のチップ（ch01）の時刻から鳴るので、
//   譜面の秒 t の所はサンプル (t − BGM の秒) × サンプリング周波数。
// - 候補はその種類（レーン）のチップを置いた所。ほかのチップと重ならない所が上、バスドラムとだけ重なる所が次、
//   スネア・シンバルと同時の所は下。「きれいさ」を点 5 つで見せる。
// - 使い道は特殊ノーツの音・レーンの音・WAV に足すだけ。替えるのは音だけで、置いた所と強さの違い（#VOLUME）は写す。元の WAV は消さない。
// - 作った WAV は曲フォルダに置き（NX で読める名前）、作業ファイル（special.cuts）に覚えて、WAV の一覧に「切り出し」の印を付ける。
import { create } from 'zustand';
import { tr, isJa, pl } from '../i18n';
import { engine } from '../audio/engine';
import { downmix } from '../audio/dsp';
import { KIT_LANES, laneByCh } from '../audio/sounds';
import { autoRange, cutPcm, findOnset, fingerprint, minMax, msToSamples, pcmLength, pcmOf, preDb, recommend, shapePcm, shiftSamples, similarity, slicePcm, stackPcm, wavBytes, type CutRange, type Onset, type Pcm, type Shape } from '../audio/cut';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { fracToString } from '../dtx/fraction';
import { kindCode, kindLabel, kindName, kindOfSound, kindVoice, presetById, specialWavs, specialWavsOf } from '../dtx/kinds';
import { CH, drumChannel, isSeChannel, SD_RIM, voiceName, type Chip, type DtxDoc } from '../dtx/model';
import { chipVoice, isRimSound, RIM_LABEL, rimWavs, rimWavsOf } from '../dtx/rim';
import { addKindWav } from '../edit/kinds';
import { freeWavNumber, setField, setFieldComment } from '../edit/ops';
import { addWav } from '../edit/rim';
import { usedWavs, velOfWav, wavVariant } from '../edit/velocity';
import { findFile, folderFromFiles, joinPath, normPath, putFile, type SongFolder } from '../fs/folder';
import { nxSafeName } from '../fs/nxName';
import type { Inst } from '../library/db';
import { instOfChannel } from '../library/analyze';
import { formatPosition } from '../ui/format';
import { stopAudition, type AuditionSound } from './audition';
import { useDevice } from './device';
import { bgmSource, soundBus, tempoOf, wavPath } from './derived';
import { edit, lastHistory, openPage, prepareSounds, previewWav, pushSideHistory, toast, undoIfLast, useEditor } from './editor';
import { isCutFile } from './kit';
import { addSampleBytes } from './library';
import { openSeparation, useSeparate } from './separate';
import { setSpecialSide, useSidecar, type CutRecipe } from './sidecar';
import { kindSoundNo, pickNewKind } from './special';
import { specialKinds } from './specialLayout';
import { readyStems, trackAudio, useStems } from './stems';

// ---- 開く・閉じる ---------------------------------------------------------------------------

/** 何の音を切り出すか：特殊ノーツの種類・レーンの音（音の番号。リムは SD_RIM）・時刻だけ */
export type CutTarget = { type: 'kind'; id: string } | { type: 'voice'; voice: number } | { type: 'free' };

/** 切り出した音の使い道 */
export type CutUse = { type: 'kind'; id: string } | { type: 'newKind' } | { type: 'voice'; voice: number } | { type: 'wav' };

export interface CutOpen {
  target: CutTarget;
  /** 初めに選ぶ所（チップ）。省くと候補の 1 つ目 */
  chip?: number | null;
  /** 時刻から開いたとき（譜面の秒）。近くにチップが無い所 */
  sec?: number | null;
  /** 時刻から開いたときの、鳴り始めを探す幅（ms） */
  searchMs?: number;
  /** 元（ステムのファイルか 'orig'）。省くとドラムのステム→ほかのステム→原曲 */
  src?: string | null;
  /**
   * 切り出した音を直す（同じファイルを作り直す）。recipe はそのときの作り方（前の版で作った音には無い。初めの切り方から）
   */
  redo?: { file: string; recipe: CutRecipe | null } | null;
  /** 開いた回数（画面の状態を作り直す） */
  seq: number;
}

export const useCut = create<{ open: CutOpen | null }>(() => ({ open: null }));

let seq = 0;

export function openCut(o: Omit<CutOpen, 'seq'>) {
  stopAudition();
  afterSplit = null;
  useCut.setState({ open: { ...o, seq: ++seq } });
}

/** 閉じる。開いていたら true */
export function closeCut(): boolean {
  if (!useCut.getState().open) return false;
  stopAudition();
  useCut.setState({ open: null });
  return true;
}

/** 種類の音を切り出す（特殊ノーツの設定・左のキット） */
export function openCutForKind(id: string) {
  openCut({ target: { type: 'kind', id } });
}

/** チップの所の音を切り出す（チップの右クリック）。特殊ノーツならその種類、ドラムならそのレーンの音 */
export function openCutAtChip(id: number) {
  const doc = useEditor.getState().doc;
  const c = doc.chips.find((x) => x.id === id);
  const t = c ? chipTarget(doc, c) : null;
  if (!c || !t) return;
  openCut({ target: t, chip: id });
}

/** チップから何の音か（特殊ノーツの種類か、ドラムの音の番号）。どちらでもなければ null */
export function chipTarget(doc: DtxDoc, c: Chip): CutTarget | null {
  const sp = specialWavs(doc);
  const kind = sp.get(c.v);
  if (kind !== undefined && kindVoice(kind) !== null && (isSeChannel(c.ch) || drumChannel(c.ch)?.kind === 'normal')) return { type: 'kind', id: kind };
  if (drumChannel(c.ch)?.kind !== 'normal') return null;
  const v = chipVoice(doc, c, rimWavs(doc), sp);
  return v === null ? null : { type: 'voice', voice: v };
}

/** 切り出せるチップか（ドラムの通常チップ・特殊ノーツ） */
export const canCutChip = (doc: DtxDoc, c: Chip) => chipTarget(doc, c) !== null;

/** 波形の右クリックで切り出す所：時刻 sec にいちばん近いチップ（tol 秒まで）。無ければその時刻 */
export interface CutSpot {
  chip: number | null;
  sec: number;
  /** 「026 · 1/2」のような位置 */
  pos: string;
}

export function cutSpotAt(sec: number, tol: number): CutSpot {
  const doc = useEditor.getState().doc;
  const list = soundingChips(doc);
  let best: Sounding | null = null;
  for (const s of list) {
    const d = Math.abs(s.sec - sec);
    if (d > tol) continue;
    if (!best || d < Math.abs(best.sec - sec) - 0.025 || (Math.abs(d - Math.abs(best.sec - sec)) <= 0.025 && pickRank(s) < pickRank(best))) best = s;
  }
  if (best) return { chip: best.c.id, sec: best.sec, pos: chipPos(best.c) };
  return { chip: null, sec, pos: formatPosition(tempoOf(doc), tempoOf(doc).secToBeat(sec)) };
}

/** 同じ時刻に何個かあるときに選ぶ順（特殊ノーツ、スネア・タム・シンバル…、バスドラムは最後） */
function pickRank(s: Sounding): number {
  if (s.kind) return 0;
  if (BD_VOICES.has(s.voice)) return 3;
  if (HH_VOICES.has(s.voice)) return 2;
  return 1;
}

/** 下のトラックの波形から開く。src はそのトラック（'orig' かステムのファイル。null は初めの決まり：ドラムのステム→ほかのステム→原曲） */
export function openCutAtSpot(src: string | null, spot: CutSpot, tol: number) {
  const doc = useEditor.getState().doc;
  const c = spot.chip !== null ? doc.chips.find((x) => x.id === spot.chip) : undefined;
  const t = c ? chipTarget(doc, c) : null;
  if (c && t) openCut({ target: t, chip: c.id, src });
  else openCut({ target: { type: 'free' }, sec: spot.sec, src, searchMs: Math.max(30, Math.min(250, tol * 1000)) });
}

// ---- 切り出した音を直す ------------------------------------------------------------------------

const slashLow = (p: string) => p.trim().replace(/\\/g, '/').toLowerCase();

/** ファイルの音の WAV 番号（強さ違いの番号も） */
function wavNosOfFile(doc: DtxDoc, file: string): Set<number> {
  const k = slashLow(file);
  return new Set(
    Object.entries(doc.fields)
      .filter(([key, v]) => /^WAV[0-9A-Z]{2}$/.test(key) && slashLow(v) === k)
      .map(([key]) => parseInt(key.slice(3), 36)),
  );
}

/** ファイルの音で鳴るチップ（id） */
export function chipsOfFile(doc: DtxDoc, file: string): number[] {
  const nos = wavNosOfFile(doc, file);
  return doc.chips.filter((c) => nos.has(c.v)).map((c) => c.id);
}

/** 切り出した音の作り方（作業ファイル。無ければ null） */
export function cutRecipe(file: string): CutRecipe | null {
  const k = slashLow(file);
  return useSidecar.getState().special?.recipes?.find((r) => slashLow(r.file) === k) ?? null;
}

/** そのファイルの音を使っているもの（特殊ノーツの種類・レーンの音）。どれも使っていなければ null */
function usedAs(doc: DtxDoc, file: string): CutTarget | null {
  const nos = wavNosOfFile(doc, file);
  if (!nos.size) return null;
  const sp = specialWavs(doc);
  for (const no of nos) {
    const kind = sp.get(no);
    if (kind !== undefined && kindVoice(kind) !== null) return { type: 'kind', id: kind };
  }
  const rims = rimWavs(doc);
  for (const c of doc.chips) {
    if (!nos.has(c.v) || drumChannel(c.ch)?.kind !== 'normal') continue;
    const v = chipVoice(doc, c, rims, sp);
    if (v !== null) return { type: 'voice', voice: v };
  }
  // チップが無くても、これから置く音にしていればそのレーン
  const lw = useEditor.getState().laneWav;
  for (const [v, no] of Object.entries(lw)) if (no !== undefined && nos.has(no)) return { type: 'voice', voice: Number(v) };
  return null;
}

/**
 * 切り出した音を直す画面を開く（同じ所・同じ切り方から。使うと同じファイルを作り直すので、その音のチップはみな新しい音になる）。
 * 作り方が残っていない音（前の版で作った音）は、その音を使っている種類・レーンの初めの切り方から
 */
export function openRecut(file: string) {
  const recipe = cutRecipe(file);
  const doc = useEditor.getState().doc;
  const target: CutTarget = recipe?.target ?? usedAs(doc, file) ?? { type: 'free' };
  if (recipe) {
    const src = cutSources().some((x) => x.id === recipe.src) ? recipe.src : null;
    const near = target.type === 'free' ? undefined : cutCandidates(doc, target).find((c) => Math.abs(c.sec - recipe.sec) < 0.03);
    // チップが動いた・消えたときは、前に切り出した時刻の所から
    const t: CutTarget = target.type === 'free' || near ? target : { type: 'free' };
    openCut({ target: t, chip: near?.chip ?? null, sec: near ? null : recipe.sec, searchMs: recipe.searchMs ?? (near ? undefined : 80), src, redo: { file, recipe } });
    return;
  }
  // 使っている所も分からない音は、▶ の所から
  if (target.type === 'free') {
    const s = useEditor.getState();
    const sec = tempoOf(s.doc).beatToSec(Math.max(0, s.cursorBeat));
    openCut({ target, sec, searchMs: 80, src: null, redo: { file, recipe: null } });
    return;
  }
  openCut({ target, src: null, redo: { file, recipe: null } });
}

/** チップの音が切り出した音なら、そのファイル（直す画面を開ける）。違えば null */
export function cutFileOfChip(doc: DtxDoc, c: Chip): string | null {
  const f = doc.fields['WAV' + toBase36x2(c.v)];
  return f && canRecut(f) ? f : null;
}

/** ファイルが切り出した音なら、直す画面を開ける（作業ファイルの special.cuts にある） */
export function canRecut(file: string | undefined): boolean {
  if (!file) return false;
  const k = slashLow(file);
  return !!useSidecar.getState().special?.cuts?.some((c) => slashLow(c) === k);
}

// ---- ステムに分けてから戻る -------------------------------------------------------------------

let afterSplit: Omit<CutOpen, 'seq'> | null = null;

/** ステムに分解する画面へ行き、分け終わったらこの画面に戻る（ドラムのステムを元にして） */
export function splitThenReturn() {
  const o = useCut.getState().open;
  if (!o) return;
  closeCut();
  afterSplit = { target: o.target, chip: o.chip, sec: o.sec, searchMs: o.searchMs, src: null };
  openSeparation();
}

useSeparate.subscribe((s, prev) => {
  if (!afterSplit || s.phase === prev.phase) return;
  if (s.phase === 'done') {
    const o = afterSplit;
    afterSplit = null;
    if (useEditor.getState().screen !== 'editor') return;
    openPage('chart');
    openCut(o);
  } else if (s.phase === 'error' || (s.phase === 'idle' && prev.phase !== 'idle')) {
    afterSplit = null;
  }
});

// 別の曲を開いたら閉じる（チップの番号・音が変わる）
useEditor.subscribe((s, prev) => {
  if (s.folder !== prev.folder || s.screen !== prev.screen) {
    afterSplit = null;
    closeCut();
  }
});

// ---- 元（ステム・原曲） ------------------------------------------------------------------------

export interface CutSource {
  /** ステムのファイルか 'orig' */
  id: string;
  name: string;
  file: string;
  drums: boolean;
}

/** 切り出せる元。ドラムのステム、ほかのステム、原曲の順 */
export function cutSources(): CutSource[] {
  const ready = readyStems();
  const stems = [...ready.filter((t) => t.kind === 'drums'), ...ready.filter((t) => t.kind !== 'drums')];
  const out: CutSource[] = stems.map((t) => ({ id: t.file, name: t.name, file: t.file, drums: t.kind === 'drums' }));
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  if (bgm && engine.buffer(bgm.wav)) out.push({ id: 'orig', name: tr('原曲', 'Original'), file: wavPath(doc, bgm.wav) ?? '', drums: false });
  return out;
}

/** 元の音（チャンネルごと。コピーしない） */
export function sourcePcm(id: string): Pcm | null {
  const a = trackAudio(id);
  return a ? pcmOf(a.buf) : null;
}

/** 元の音が読み込まれるたびに変わる（画面の描き直し） */
export const useSourcesVersion = () => useStems((s) => s.version);

/** 譜面の秒 → 元の音のサンプル（ステムも原曲も BGM のチップの時刻から鳴る） */
export function sampleAt(doc: DtxDoc, sr: number, sec: number): number {
  return Math.round((sec - (bgmSource(doc)?.sec ?? 0)) * sr);
}

/** 元の音のサンプル → 譜面の秒 */
export function secAt(doc: DtxDoc, sr: number, sample: number): number {
  return sample / sr + (bgmSource(doc)?.sec ?? 0);
}

// ---- 候補 ---------------------------------------------------------------------------------------

const BD_VOICES = new Set<number>([CH.BD, CH.LBD]);
const HH_VOICES = new Set<number>([CH.HHC, CH.LP]);

/** 同時とみなす時刻の違い（秒） */
const SAME_SEC = 0.025;

interface Sounding {
  c: Chip;
  sec: number;
  voice: number;
  /** 特殊ノーツの種類 */
  kind?: string;
}

const soundingCache = new WeakMap<DtxDoc, Sounding[]>();

/** 鳴るチップ（ドラムの通常チップと、自動で鳴らす特殊ノーツ）を時刻の順に */
function soundingChips(doc: DtxDoc): Sounding[] {
  let out = soundingCache.get(doc);
  if (out) return out;
  const tempo = tempoOf(doc);
  const rims = rimWavs(doc);
  const sp = specialWavs(doc);
  out = [];
  for (const c of doc.chips) {
    const kind = sp.get(c.v);
    const drum = drumChannel(c.ch)?.kind === 'normal';
    if (!drum && !(isSeChannel(c.ch) && kind !== undefined)) continue;
    const voice = chipVoice(doc, c, rims, sp);
    if (voice === null) continue;
    out.push({ c, sec: tempo.beatToSec(tempo.beatOf(c.m, c.f)), voice, kind: kind !== undefined && kindVoice(kind) === voice ? kind : undefined });
  }
  out.sort((a, b) => a.sec - b.sec);
  soundingCache.set(doc, out);
  return out;
}

/** 音の番号の短い名前（BD・SD・CLP など） */
export function voiceCode(voice: number): string {
  const lane = laneByCh.get(voice);
  const sp = [...presetById.values()].find((p) => p.voice === voice);
  if (sp) return sp.code;
  if (lane && KIT_LANES.includes(lane)) return lane.key.toUpperCase();
  for (const k of specialKinds(useEditor.getState().doc)) if (k.voice === voice) return k.code;
  return '?';
}

/** 音の番号の名前（スネア・クラップなど） */
export function voiceLabel(voice: number): string {
  for (const k of specialKinds(useEditor.getState().doc)) if (k.voice === voice) return k.name;
  const p = [...presetById.values()].find((x) => x.voice === voice);
  return p ? p.name : voiceName(voice);
}

const chipPos = (c: Pick<Chip, 'm' | 'f'>) => `${toMeasure(c.m)} · ${fracToString(c.f)}`;

export interface CutCand {
  key: string;
  chip: number | null;
  /** 譜面の秒 */
  sec: number;
  m: number;
  /** 「026 · 1/2」 */
  pos: string;
  /** 同時に鳴るほかのチップの音の番号 */
  over: number[];
  /** 重なり方。0 重ならない、1 バスドラムとだけ、2 ハイハットまで、3 スネア・シンバルなどと同時 */
  cls: number;
  /** 次の音（チップ）。無ければ null */
  next: { sec: number; voices: number[] } | null;
  /** 譜面から見たきれいさ（1〜5） */
  dots: number;
}

/** target の音のチップか */
function isTarget(s: Sounding, t: CutTarget): boolean {
  if (t.type === 'kind') return s.kind === t.id;
  if (t.type === 'voice') return !s.kind && s.voice === t.voice && !isSeChannel(s.c.ch);
  return false;
}

/** 重なり方（同時に鳴るほかの音の番号から） */
export function overlapClass(over: readonly number[]): number {
  if (!over.length) return 0;
  if (over.every((v) => BD_VOICES.has(v))) return 1;
  if (over.every((v) => BD_VOICES.has(v) || HH_VOICES.has(v))) return 2;
  return 3;
}

function candOf(list: readonly Sounding[], i: number, sec: number, chip: Chip | null, voice: number | null, tempoPos: string): CutCand {
  const over: number[] = [];
  let next: CutCand['next'] = null;
  for (let j = 0; j < list.length; j++) {
    const s = list[j];
    if (chip && s.c.id === chip.id) continue;
    const d = s.sec - sec;
    if (Math.abs(d) <= SAME_SEC) {
      if (s.voice !== voice && !over.includes(s.voice)) over.push(s.voice);
    } else if (d > SAME_SEC) {
      if (!next) next = { sec: s.sec, voices: [s.voice] };
      else if (s.sec - next.sec <= SAME_SEC) {
        if (!next.voices.includes(s.voice)) next.voices.push(s.voice);
      } else break;
    }
  }
  void i;
  const cls = overlapClass(over);
  let dots = [5, 4, 3, 2][cls];
  if (cls === 3 && over.filter((v) => !BD_VOICES.has(v)).length >= 2) dots = 1;
  if (next && next.sec - sec < 0.08) dots--;
  return {
    key: chip ? `c${chip.id}` : `t${Math.round(sec * 1000)}`,
    chip: chip ? chip.id : null,
    sec,
    m: chip ? chip.m : 0,
    pos: chip ? chipPos(chip) : tempoPos,
    over,
    cls,
    next,
    dots: Math.max(1, Math.min(5, dots)),
  };
}

/** 切り出す所の候補（譜面の順。並べ替えは音を見てから sortCands で） */
export function cutCandidates(doc: DtxDoc, t: CutTarget, sec: number | null = null): CutCand[] {
  const list = soundingChips(doc);
  if (t.type === 'free') {
    const s = sec ?? 0;
    const tempo = tempoOf(doc);
    // 前後のチップを見るために、近くから探す
    const from = Math.max(0, lowerBound(list, s - 1));
    const sub = list.slice(from, from + 64);
    const cand = candOf(sub, 0, s, null, null, formatPosition(tempo, tempo.secToBeat(s)));
    cand.m = tempo.locate(Math.max(0, tempo.secToBeat(s))).m;
    return [cand];
  }
  const out: CutCand[] = [];
  list.forEach((s, i) => {
    if (!isTarget(s, t)) return;
    // 近くだけを見る（前後 64 個）
    const from = Math.max(0, i - 32);
    out.push(candOf(list.slice(from, i + 32), i, s.sec, s.c, s.voice, ''));
  });
  return out;
}

function lowerBound(list: readonly Sounding[], sec: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].sec < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 元の音を見た候補の様子 */
export interface CandSound {
  /** チップの時刻（元の音のサンプル） */
  at: number;
  onset: Onset;
  /** 鳴り始めの前の大きさ（dB） */
  pre: number;
  /** きれいさ（1〜5。譜面と音から） */
  dots: number;
  /** 小さい波形（64×28 の SVG の path） */
  wave: string;
  /** 次の音の時刻（元の音のサンプル） */
  nextAt: number | null;
}

/** 候補の音を見る（鳴り始め・前の静かさ・小さい波形） */
export function candSound(doc: DtxDoc, p: Pcm, c: CutCand, searchMs?: number): CandSound {
  const at = sampleAt(doc, p.sr, c.sec);
  const onset = findOnset(p, at, searchMs);
  const pre = onset.found ? preDb(p, onset) : 0;
  let dots = c.dots;
  if (!onset.found) dots = 1;
  else if (pre > -12) dots--;
  const head = onset.found ? onset.at : at;
  return { at, onset, pre, dots: Math.max(1, Math.min(5, dots)), wave: miniWave(p, head - msToSamples(p.sr, 20), head + msToSamples(p.sr, 492), 64, 28), nextAt: c.next ? sampleAt(doc, p.sr, c.next.sec) : null };
}

/** 小さい波形（左右を混ぜた形の上下）。w×h の SVG の path */
export function miniWave(p: Pcm, from: number, to: number, w: number, h: number): string {
  const x = downmix(slicePcm(p, from, to).ch);
  const { lo, hi } = minMax(x, 0, x.length, w);
  let peak = 1e-6;
  for (let i = 0; i < w; i++) peak = Math.max(peak, hi[i], -lo[i]);
  const half = h / 2 - 1;
  const k = half / peak;
  let d = `M0,${h / 2}`;
  for (let i = 0; i < w; i++) d += ` L${i},${(h / 2 - Math.max(0.5, hi[i] * k)).toFixed(1)}`;
  for (let i = w - 1; i >= 0; i--) d += ` L${i},${(h / 2 + Math.max(0.5, -lo[i] * k)).toFixed(1)}`;
  return d + ' Z';
}

/** 候補を並べる：きれいな所（点の多い所）、次の音まで長い所、譜面の前の方 */
export function sortCands(cands: readonly CutCand[], sounds: ReadonlyMap<string, CandSound>): CutCand[] {
  const gap = (c: CutCand) => Math.min(0.5, c.next ? c.next.sec - c.sec : 0.5);
  return [...cands].sort((a, b) => (sounds.get(b.key)?.dots ?? b.dots) - (sounds.get(a.key)?.dots ?? a.dots) || gap(b) - gap(a) || a.sec - b.sec);
}

// ---- 切る --------------------------------------------------------------------------------------

export interface CutSettings {
  /** 鳴り始めにそろえる（2 ms 前から）。外すとチップの時刻から */
  align: boolean;
  /** 切り始めを手でずらす（ms。＋で後ろ、−で前。0 は自動のまま） */
  startMs?: number;
  /** 長さを手で決める（ms）。null は自動（次の音の 16 ms 手前まで） */
  lenMs: number | null;
  shape: Shape;
}

/** 1 か所の切り方 */
export function rangeOf(p: Pcm, s: CandSound, set: CutSettings): CutRange {
  const r = autoRange(p, s.at, s.nextAt, { align: set.align, lenMs: set.lenMs, startMs: set.startMs });
  // 鳴り始めはもう探してある（時刻から開いたときは広く探した）
  if (s.onset.found && set.align && (r.onset.at !== s.onset.at || !r.onset.found)) {
    const start = s.onset.at - msToSamples(p.sr, 2) + shiftSamples(p.sr, set.startMs);
    const len = r.end - r.start;
    return { ...r, onset: s.onset, start, end: set.lenMs ? start + msToSamples(p.sr, set.lenMs) : Math.max(start + msToSamples(p.sr, 40), Math.min(start + len, r.next !== null ? r.next - msToSamples(p.sr, 16) : start + len)) };
  }
  return r;
}

/** 重ねた音の結果 */
export interface StackResult {
  pcm: Pcm;
  /** 重ねる前の 1 か所（そろえたもの）。波形に重ねて描く */
  parts: Pcm[];
  shifts: number[];
  single: number;
  stacked: number;
  /** 1 つ目と似ている度合いの平均（0〜1） */
  sim: number;
}

/** 何か所かを鳴り始めでそろえて平均する（list の 1 つ目に合わせる）。整える前の音 */
export function stackCut(p: Pcm, list: readonly { s: CandSound }[], set: CutSettings): StackResult | null {
  if (list.length < 2) return null;
  const pre: Shape = { lowCut: set.shape.lowCut, normalize: false, mono: false, fadeMs: 0 };
  const parts = list.map(({ s }) => {
    const r = rangeOf(p, s, set);
    return cutPcm(p, r.start, r.end, pre);
  });
  const st = stackPcm(parts);
  const fps = parts.map(fingerprint);
  let sim = 0;
  for (let i = 1; i < fps.length; i++) sim += similarity(fps[0], fps[i], p.sr);
  sim /= Math.max(1, fps.length - 1);
  return { pcm: st.out, parts, shifts: st.shifts, single: st.single, stacked: st.stacked, sim };
}

/** 重ねる所のおすすめ：重ならない所・バスドラムとだけ重なる所から、鳴り方の似たもの（first を 1 つ目に） */
export function recommendStack(p: Pcm, order: readonly CutCand[], sounds: ReadonlyMap<string, CandSound>, set: CutSettings, first: string | null): string[] {
  const pool = order.filter((c) => c.cls <= 1 && sounds.get(c.key)?.onset.found).slice(0, 16);
  if (pool.length < 2) return first ? [first] : pool.slice(0, 1).map((c) => c.key);
  const pre: Shape = { lowCut: true, normalize: false, mono: false, fadeMs: 0 };
  const fps = pool.map((c) => {
    const s = sounds.get(c.key)!;
    const r = rangeOf(p, s, { ...set, lenMs: 60 });
    return fingerprint(cutPcm(p, r.start, r.end, pre));
  });
  const pick = recommend(
    fps,
    pool.map((_, i) => i),
    p.sr,
  ).map((i) => pool[i].key);
  if (first && pick.includes(first)) return [first, ...pick.filter((k) => k !== first)];
  return pick;
}

/** 整えた音（使う音） */
export function finishPcm(raw: Pcm, shape: Shape, alreadyLowCut: boolean): Pcm {
  return shapePcm(raw, { ...shape, lowCut: shape.lowCut && !alreadyLowCut });
}

// ---- 使い道 ------------------------------------------------------------------------------------

export interface UseOption {
  key: string;
  use: CutUse;
  label: string;
  group: 'kind' | 'new' | 'voice' | 'wav';
  /** 音が替わるチップの数 */
  count: number;
  /** いまの音のファイル（特殊ノーツ） */
  now?: string;
}

export const useKey = (u: CutUse): string => (u.type === 'kind' ? `kind:${u.id}` : u.type === 'voice' ? `voice:${u.voice}` : u.type);

/** 音の番号ごとのチップの数（特殊ノーツは種類の番号） */
function voiceCounts(doc: DtxDoc): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of soundingChips(doc)) {
    // レーンの音にするとき替えるのはレーンのチップだけ（自動で鳴らす特殊ノーツは種類で数える）
    if (!s.kind && isSeChannel(s.c.ch)) continue;
    out.set(s.voice, (out.get(s.voice) ?? 0) + 1);
  }
  return out;
}

export function cutUseOptions(doc: DtxDoc): UseOption[] {
  const counts = voiceCounts(doc);
  const out: UseOption[] = [];
  for (const k of specialKinds(doc)) {
    const no = kindSoundNo(k.id);
    const n = counts.get(k.voice) ?? 0;
    out.push({
      key: `kind:${k.id}`,
      use: { type: 'kind', id: k.id },
      label: tr(`${k.name}の音にする（${n} 個）`, `Use as the ${k.name} sound (${n})`),
      group: 'kind',
      count: n,
      now: no !== null ? doc.fields['WAV' + toBase36x2(no)] : undefined,
    });
  }
  out.push({ key: 'newKind', use: { type: 'newKind' }, label: tr('新しい特殊ノーツにする…', 'Make it a new special note…'), group: 'new', count: 0 });
  for (const l of KIT_LANES) {
    const n = counts.get(l.ch) ?? 0;
    out.push({ key: `voice:${l.ch}`, use: { type: 'voice', voice: l.ch }, label: tr(`${l.label}の音にする（${n} 個）`, `Use as the ${l.label} sound (${n})`), group: 'voice', count: n });
  }
  out.push({ key: 'wav', use: { type: 'wav' }, label: tr('WAV に足すだけ（チップの音は変えない）', 'Only add it to the WAV list (chips keep their sound)'), group: 'wav', count: 0 });
  return out;
}

/** 初めの使い道（その種類・レーンの音にする。時刻だけなら WAV に足すだけ） */
export function defaultUse(t: CutTarget): CutUse {
  return t.type === 'kind' ? { type: 'kind', id: t.id } : t.type === 'voice' ? { type: 'voice', voice: t.voice } : { type: 'wav' };
}

// ---- 名前 --------------------------------------------------------------------------------------

/** レーンの音のファイル名の頭（楽器の名前。リムはリム、ほかの楽器の名前にならないように） */
const LANE_BASE: Record<string, string> = {
  lc: 'cymbal_left',
  hhc: 'hihat',
  hho: 'hihat_open',
  lp: 'pedal',
  lbd: 'kick_left',
  sd: 'snare',
  rim: 'rim',
  ht: 'tom_high',
  bd: 'kick',
  lt: 'tom_low',
  ft: 'tom_floor',
  cy: 'cymbal',
  rd: 'ride',
};

const KIND_BASE: Record<string, string> = { clap: 'clap', tamb: 'tambourine', cowbell: 'cowbell', shaker: 'shaker' };

function baseFor(t: CutTarget | CutUse): string {
  if (t.type === 'kind') return KIND_BASE[t.id] ?? (kindCode(t.id).toLowerCase().replace(/[^a-z0-9]/g, '') || 'sound');
  if (t.type === 'voice') return LANE_BASE[laneByCh.get(t.voice)?.key ?? ''] ?? 'drum';
  return 'cut';
}

/** 曲名の頭の英数字（ファイル名の後ろ。無ければ cut） */
function titleSlug(title: string): string {
  const word = title
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((w) => w.length > 0);
  return word ? word.slice(0, 12) : 'cut';
}

/** ラベルを付けたときに、その使い道の音と読めるか（リム・特殊ノーツの見分けを狂わせない名前か） */
export function nameFits(name: string, use: CutUse, target: CutTarget): boolean {
  const u: CutUse | CutTarget = use.type === 'wav' || use.type === 'newKind' ? target : use;
  if (u.type === 'kind') return kindOfSound(name, kindLabel(u.id)) === u.id;
  if (u.type === 'voice') {
    // レーンの音が特殊ノーツ（クラップなど）と読まれると、チップが特殊ノーツの列へ動いてしまう
    if (kindOfSound(name, null) !== null) return false;
    if (u.voice === SD_RIM) return isRimSound(name, RIM_LABEL);
    if (u.voice === CH.SD) return !isRimSound(name, null);
    return true;
  }
  return true;
}

/** 名前を WAV の名前にそろえる（拡張子は .wav、NX で読める文字） */
export function wavName(name: string): string {
  const n = name.trim().replace(/[\\/]/g, '_');
  const base = n.replace(/\.[^.]*$/, '') || 'cut';
  return nxSafeName(`${base}.wav`, 'cut');
}

/** 曲フォルダと譜面でまだ使っていない名前（name_2.wav のように） */
export function freeName(folder: SongFolder | null, doc: DtxDoc, name: string): string {
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const inDoc = new Set(
    Object.entries(doc.fields)
      .filter(([k]) => /^WAV[0-9A-Z]{2}$/.test(k))
      .map(([, v]) => normPath(v)),
  );
  const taken = (n: string) => inDoc.has(normPath(n)) || (!!folder && (folder.files.has(normPath(joinPath(pathWav, n))) || folder.files.has(normPath(n))));
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '.wav';
  for (let i = 2; i < 1000; i++) if (!taken(`${base}_${i}${ext}`)) return `${base}_${i}${ext}`;
  return `${base}_${Date.now()}${ext}`;
}

/** 初めのファイル名（clap_mela.wav のように。読み違えられる名前なら clap_cut.wav） */
export function defaultCutName(use: CutUse, target: CutTarget): string {
  const s = useEditor.getState();
  const u = use.type === 'wav' || use.type === 'newKind' ? target : use;
  const base = baseFor(u);
  for (const n of [`${base}_${titleSlug(s.doc.fields['TITLE'] ?? '')}.wav`, `${base}_cut.wav`, `${base}.wav`]) {
    const w = wavName(n);
    if (nameFits(w, use, target)) return freeName(s.folder, s.doc, w);
  }
  return freeName(s.folder, s.doc, wavName(`${base}_cut.wav`));
}

// ---- 使う --------------------------------------------------------------------------------------

export interface CutApply {
  /** 整えた音 */
  pcm: Pcm;
  name: string;
  use: CutUse;
  target: CutTarget;
  /** ライブラリにも入れる（タグ付き） */
  library: boolean;
  tags: string[];
  /** どこから切り出したか（ライブラリの理由に出す） */
  from: string;
  /** 作り方（あとで直すため。作業ファイルに残す） */
  recipe?: Omit<CutRecipe, 'file'>;
}

/** 楽器（ライブラリの分類） */
function instOf(u: CutUse | CutTarget): Inst {
  if (u.type === 'voice') return instOfChannel(u.voice) ?? 'other';
  return 'other';
}

/** 使い道の名前（タグ・知らせ） */
export function useName(u: CutUse | CutTarget): string {
  if (u.type === 'kind') return kindName(u.id);
  if (u.type === 'voice') return voiceLabel(u.voice);
  return '';
}

/** 切り出した音に付けるライブラリのタグ（タグは日本語のまま持ち、表示だけ store/library の tagLabel で訳す） */
export const CUT_TAG = '切り出し'; // i18n-ignore

// i18n-ignore-start（タグは日本語のまま持つ。表示は tagLabel で訳す）
/** ライブラリのタグにする日本語の名前（タグは日本語のまま持つ。store/library の TAG_EN で訳す） */
export function tagName(u: CutUse | CutTarget): string | null {
  if (u.type === 'kind') {
    const p = presetById.get(u.id);
    if (p) return { clap: 'クラップ', tamb: 'タンバリン', cowbell: 'カウベル', shaker: 'シェイカー' }[p.id] ?? null;
    return kindName(u.id);
  }
  if (u.type === 'voice') {
    const v = u.voice;
    if (v === SD_RIM) return 'リム';
    if (v === CH.SD) return 'スネア';
    if (v === CH.HHC || v === CH.HHO || v === CH.LP) return 'ハイハット';
    if (v === CH.BD || v === CH.LBD) return 'バスドラム';
    if (v === CH.HT || v === CH.LT || v === CH.FT) return 'タム';
    if (v === CH.CY || v === CH.LC) return 'シンバル';
    if (v === CH.RD) return 'ライド';
  }
  return null;
}
// i18n-ignore-end

/** ステム・原曲から切り出した音のファイルの一覧に足す（作業ファイル）。作り方があれば一緒に覚える（同じファイルの前の作り方は替える） */
function rememberCut(path: string, recipe?: Omit<CutRecipe, 'file'>) {
  const side = useSidecar.getState().special ?? { kinds: [] };
  const has = side.cuts?.some((c) => c.toLowerCase() === path.toLowerCase());
  if (has && !recipe) return;
  const cuts = has ? side.cuts : [...(side.cuts ?? []), path];
  const recipes = recipe ? [...(side.recipes ?? []).filter((r) => r.file.toLowerCase() !== path.toLowerCase()), { file: path, ...recipe }] : side.recipes;
  setSpecialSide({ ...side, cuts, ...(recipes?.length ? { recipes } : {}) });
}

/**
 * 切り出した音を曲フォルダに置き、使い道に使う。替えたチップの数を返す（やめた・できなかったら null）。
 * 元に戻すと、譜面・置く音・作業ファイルの印がまとめて戻る（曲フォルダのファイルは残る。保存しなければ使われない）
 */
export async function applyCut(a: CutApply): Promise<number | null> {
  let use = a.use;
  if (use.type === 'newKind') {
    const id = await pickNewKind();
    if (!id) return null;
    use = { type: 'kind', id };
  }
  const s0 = useEditor.getState();
  let folder = s0.folder;
  if (!folder) {
    folder = folderFromFiles([], s0.doc.fields['TITLE'] || tr('新しい曲', 'New song'));
    useEditor.setState({ folder });
  }
  let name = wavName(a.name);
  if (!nameFits(name, use, a.target)) name = defaultCutName(use, a.target);
  name = freeName(folder, s0.doc, name);
  const bytes = wavBytes(a.pcm);
  const pathWav = s0.doc.fields['PATH_WAV'] ?? '';
  const where = await putFile(folder, joinPath(pathWav, name), bytes);

  const laneBefore = s0.laneWav;
  const sideBefore = useSidecar.getState().special;
  let laneAfter = laneBefore;
  let sideAfter = sideBefore;
  const side = {
    undo: () => {
      useEditor.setState({ laneWav: laneBefore });
      setSpecialSide(sideBefore);
    },
    redo: () => {
      useEditor.setState({ laneWav: laneAfter });
      setSpecialSide(sideAfter);
    },
  };
  const u = use;
  let base: number | null = null;
  let changed = 0;
  const what = useName(u.type === 'wav' ? a.target : u);
  const label =
    u.type === 'wav'
      ? tr(`切り出した音（${name}）を WAV に足す`, `Add the extracted sound (${name}) to the WAV list`)
      : tr(`切り出した音を${what}の音にする`, `Use the extracted sound as the ${what} sound`);
  edit(
    label,
    (d) => {
      if (u.type === 'kind') {
        base = addKindWav(d, name, u.id);
        if (base === null) return;
        changed = swapSounds(d, base, (c, sp) => sp.get(c.v) === u.id && (isSeChannel(c.ch) || drumChannel(c.ch)?.kind === 'normal'));
      } else if (u.type === 'voice') {
        base = addWav(d, name, u.voice === SD_RIM);
        if (base === null) return;
        const voice = u.voice;
        changed = swapSounds(d, base, (c, sp, rims) => !!drumChannel(c.ch) && chipVoice(d as DtxDoc, c, rims, sp) === voice);
      } else {
        // WAV に足すだけ：その種類（リム）の音と分かるラベルを付けておく（あとで「音」に選べる）
        base = freeWavNumber(d as DtxDoc);
        if (base === null) return;
        const z = toBase36x2(base);
        setField(d, 'WAV' + z, name);
        const t = a.target;
        const lbl = t.type === 'kind' ? kindLabel(t.id) : t.type === 'voice' && t.voice === SD_RIM ? RIM_LABEL : null;
        if (lbl) setFieldComment(d, 'WAV' + z, lbl);
      }
    },
    { side },
  );
  if (base === null) {
    toast(tr('WAV の番号が足りないので、音を足せませんでした（使っていない WAV を消してください）', 'No free WAV numbers left, so the sound could not be added (remove unused WAVs first)'), 'error', 7000);
    return null;
  }
  const no: number = base;
  const entry = lastHistory();
  rememberCut(name, a.recipe);
  if (u.type === 'kind') {
    const v = kindVoice(u.id);
    if (v !== null) useEditor.setState((s) => ({ laneWav: { ...s.laneWav, [v]: no } }));
  } else if (u.type === 'voice') {
    const v = u.voice;
    useEditor.setState((s) => ({ laneWav: { ...s.laneWav, [v]: no } }));
  }
  laneAfter = useEditor.getState().laneWav;
  sideAfter = useSidecar.getState().special;
  await prepareSounds();

  let libNote = '';
  if (a.library) {
    try {
      const mono = downmix(a.pcm.ch);
      const t = tagName(u.type === 'wav' ? a.target : u);
      const title = s0.doc.fields['TITLE'] ?? '';
      await addSampleBytes(bytes, {
        name,
        inst: instOf(u.type === 'wav' ? a.target : u),
        tags: a.tags.length ? a.tags : [t, title, CUT_TAG].filter((x): x is string => !!x),
        source: { song: title, artist: s0.doc.fields['ARTIST'] ?? '', file: joinPath(pathWav, name), folder: folder.name },
        mono: mono === a.pcm.ch[0] ? mono.slice() : mono,
        sr: a.pcm.sr,
        channels: a.pcm.ch.length,
        reason: tr(`${a.from}から切り出した`, `Extracted from ${a.from}`),
      });
      libNote = tr('ライブラリにも入れました', 'Also added to the library');
    } catch {
      libNote = tr('ライブラリには入れられませんでした', "Couldn't add it to the library");
    }
  }
  const notes = [where === 'memory' ? tr('曲フォルダへは保存するときに書き出します', 'It is written to the song folder when you save') : '', libNote].filter(Boolean);
  const head =
    u.type === 'wav'
      ? tr(`${name} を作って、WAV の一覧に足しました（チップの音は変えていません）`, `Made ${name} and added it to the WAV list (chips keep their sound)`)
      : changed > 0
        ? tr(`${name} を作って、${what} ${changed} 個の音にしました。強さの違いはそのままです`, `Made ${name} and gave it to ${changed} ${what} ${pl(changed, 'chip')}. Their velocities are kept`)
        : tr(`${name} を作って、${what}の音にしました（これから置くチップの音）`, `Made ${name} and set it as the ${what} sound (for chips you place from now on)`);
  toast(
    head + notes.map((t) => (isJa() ? `。${t}` : `. ${t}`)).join('') + (isJa() ? '' : '.'),
    'ok',
    9000,
    { label: tr('聴いてみる', 'Listen'), run: () => previewWav(no) },
    entry ? { label: tr('元に戻す', 'Undo'), run: () => void undoIfLast(entry) } : undefined,
  );
  return changed;
}

/** 切り出した音を直す（同じファイルを作り直す） */
export interface CutRedo {
  pcm: Pcm;
  /** 作り直すファイル（#WAV に書いたパス） */
  file: string;
  recipe: Omit<CutRecipe, 'file'>;
}

/**
 * 切り出した音を作り直す：同じファイルに新しい音を書き、作り方を覚え直す。譜面（WAV の番号・チップ）は変えないので、
 * そのファイルを使うチップはみな新しい音で鳴る。元に戻すと前の音に戻す。できたら true
 */
export async function applyRecut(a: CutRedo): Promise<boolean> {
  const s0 = useEditor.getState();
  let folder = s0.folder;
  if (!folder) {
    folder = folderFromFiles([], s0.doc.fields['TITLE'] || tr('新しい曲', 'New song'));
    useEditor.setState({ folder });
  }
  const pathWav = s0.doc.fields['PATH_WAV'] ?? '';
  const f = findFile(folder, a.file, pathWav);
  const rel = f?.path ?? joinPath(pathWav, a.file);
  let old: Uint8Array | null = null;
  try {
    old = f ? new Uint8Array(await (await f.getFile()).arrayBuffer()) : null;
  } catch {
    old = null;
  }
  const bytes = wavBytes(a.pcm);
  const fd = folder;
  const where = await putFile(fd, rel, bytes);
  const sideBefore = useSidecar.getState().special;
  rememberCut(a.file, a.recipe);
  const sideAfter = useSidecar.getState().special;
  const write = (b: Uint8Array | null, side: typeof sideBefore) => {
    setSpecialSide(side);
    if (b) void putFile(fd, rel, b).then(() => prepareSounds());
  };
  const label = tr(`切り出した音（${a.file}）を作り直す`, `Remake the extracted sound (${a.file})`);
  pushSideHistory(label, { undo: () => write(old, sideBefore), redo: () => write(bytes, sideAfter) });
  const entry = lastHistory();
  await prepareSounds();
  const doc = useEditor.getState().doc;
  const nos = wavNosOfFile(doc, a.file);
  const n = chipsOfFile(doc, a.file).length;
  const first = [...nos].sort((x, y) => x - y)[0];
  const head =
    n > 0
      ? tr(`${a.file} を作り直しました。この音のチップ ${n} 個が新しい音で鳴ります`, `Remade ${a.file}. ${n} ${pl(n, 'chip')} now play the new sound`)
      : tr(`${a.file} を作り直しました`, `Remade ${a.file}`);
  const note = where === 'memory' ? tr('曲フォルダへは保存するときに書き出します', 'It is written to the song folder when you save') : '';
  toast(
    head + (note ? (isJa() ? `。${note}` : `. ${note}`) : '') + (isJa() ? '' : '.'),
    'ok',
    9000,
    first !== undefined ? { label: tr('聴いてみる', 'Listen'), run: () => previewWav(first) } : undefined,
    entry ? { label: tr('元に戻す', 'Undo'), run: () => void undoIfLast(entry) } : undefined,
  );
  return true;
}

/**
 * pick に当たるチップの音を、WAV 番号 base の音にする（強さの違いは #VOLUME の違いで写す）。
 * 使われなくなった強さ違いの番号（エディタが作ったもの）は消す。読み込んだ定義と、同じファイルの番号が残らないものは残す
 */
function swapSounds(d: import('immer').Draft<DtxDoc>, base: number, pick: (c: Chip, sp: ReadonlyMap<number, string>, rims: ReadonlySet<number>) => boolean): number {
  const sp = specialWavsOf(d as DtxDoc);
  const rims = rimWavsOf(d as DtxDoc);
  const old = new Set<number>();
  let n = 0;
  for (const c of d.chips) {
    if (!pick(c as Chip, sp, rims)) continue;
    const vel = velOfWav(d.fields, c.v);
    const no = wavVariant(d, base, vel);
    if (no === c.v) continue;
    old.add(c.v);
    c.v = no;
    n++;
  }
  const used = usedWavs(d as DtxDoc);
  const created = new Set<string>();
  for (const h of d.header) if (h.kind === 'field' && !h.orig && /^WAV[0-9A-Z]{2}$/.test(h.key)) created.add(h.key);
  for (const no of old) {
    const z = toBase36x2(no);
    const path = d.fields['WAV' + z];
    if (used.has(no) || !created.has('WAV' + z) || path === undefined || isCutFile(path)) continue;
    const same = Object.entries(d.fields).some(([k, v]) => k !== 'WAV' + z && /^WAV[0-9A-Z]{2}$/.test(k) && v.toLowerCase() === path.toLowerCase());
    if (!same) continue;
    for (const k of ['WAV', 'VOLUME', 'WAVVOL', 'PAN', 'WAVPAN']) if (d.fields[k + z] !== undefined) setField(d, k + z, undefined);
  }
  return n;
}

// ---- 試聴 --------------------------------------------------------------------------------------

/** Pcm を鳴らせる AudioBuffer に */
export function pcmBuffer(p: Pcm): AudioBuffer {
  const ctx = engine.workCtx();
  const b = ctx.createBuffer(p.ch.length, Math.max(1, pcmLength(p)), p.sr);
  p.ch.forEach((x, i) => b.getChannelData(i).set(x));
  return b;
}

/** 鳴らす音（試聴の ▶ の load）。重い計算は呼ぶ前に済ませておく */
export const auditionOf = (p: Pcm | null): AuditionSound | null => (p && pcmLength(p) > 0 ? { buf: pcmBuffer(p) } : null);

/** 2 つの音を続けて（聴き比べ。間に 0.35 秒） */
export function joinPcm(a: Pcm, b: Pcm): Pcm {
  const gap = msToSamples(a.sr, 350);
  const n = Math.max(a.ch.length, b.ch.length);
  const len = pcmLength(a) + gap + pcmLength(b);
  const ch = Array.from({ length: n }, (_, i) => {
    const out = new Float32Array(len);
    out.set(a.ch[Math.min(i, a.ch.length - 1)], 0);
    out.set(b.ch[Math.min(i, b.ch.length - 1)], pcmLength(a) + gap);
    return out;
  });
  return { sr: a.sr, ch };
}

/**
 * 切り出した音で、小節 m から 2 小節を鳴らした音（譜面のチップと、ドラム以外のステムか原曲）。
 * chips のチップは切り出した音（強さの違いは #VOLUME の比）で鳴らす
 */
export async function renderWithCut(doc: DtxDoc, cut: Pcm, chips: ReadonlySet<number>, m: number): Promise<AudioBuffer | null> {
  const tempo = tempoOf(doc);
  const from = tempo.beatToSec(tempo.measureStart(m));
  const to = tempo.beatToSec(tempo.measureStart(m + 2));
  const sr = 44100;
  const tail = 0.4;
  const len = Math.ceil((to - from + tail) * sr);
  if (len <= 0) return null;
  const off = new OfflineAudioContext(2, len, sr);
  const cutBuf = off.createBuffer(cut.ch.length, Math.max(1, pcmLength(cut)), cut.sr);
  cut.ch.forEach((x, i) => cutBuf.getChannelData(i).set(x));
  const play = (buf: AudioBuffer, at: number, gain: number, pan: number) => {
    if (at + buf.duration < from || at >= to) return;
    const src = off.createBufferSource();
    src.buffer = buf;
    const g = off.createGain();
    g.gain.value = Math.max(0, gain);
    let node: AudioNode = src.connect(g);
    if (pan !== 0 && off.createStereoPanner) {
      const pn = off.createStereoPanner();
      pn.pan.value = Math.max(-1, Math.min(1, pan / 100));
      node = node.connect(pn);
    }
    node.connect(off.destination);
    src.start(Math.max(0, at - from), Math.max(0, from - at));
  };
  // ドラム以外の音：ドラム以外のステムがあればそれ（原曲からドラムを抜いた音）、無ければ原曲（譜面の BGM）
  const bgm = bgmSource(doc);
  const others = readyStems().filter((t) => t.kind !== 'drums');
  if (bgm) {
    if (others.length) {
      for (const t of others) {
        const a = trackAudio(t.file);
        if (a) play(a.buf, bgm.sec, 0.7 * t.gain, 0);
      }
    } else {
      const snd = engine.sound(bgm.wav);
      if (snd) play(snd.buf, bgm.sec, (0.7 * snd.volume) / 100, snd.pan);
    }
  }
  for (const s of soundingChips(doc)) {
    if (s.sec < from - 2 || s.sec >= to) continue;
    if (chips.has(s.c.id)) {
      play(cutBuf, s.sec, velOfWav(doc.fields, s.c.v) / 100, 0);
      continue;
    }
    if (!soundBus(s.c.ch)) continue;
    const snd = engine.sound(s.c.v);
    if (snd) play(snd.buf, s.sec, snd.volume / 100, snd.pan);
  }
  const out = await off.startRendering();
  // 大きすぎれば下げ、終わりは閉じる
  let peak = 0;
  const chans = [out.getChannelData(0), out.getChannelData(1)];
  for (const x of chans) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const k = peak > 0.95 ? 0.95 / peak : 1;
  const f = Math.floor(tail * sr);
  for (const x of chans) {
    for (let i = 0; i < x.length; i++) x[i] *= k;
    for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  }
  return out;
}

/** 試聴の名前（▶ の key） */
export const cutKey = (what: string) => `cut:${what}`;

/** 画面が使う：スマホか（ステムに分解はスマホでは出さない） */
export const isPhone = () => useDevice.getState().phone;
