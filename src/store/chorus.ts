// サビから選曲画面の試聴（#PREVIEW）を作る。曲情報の「サビから作る」と、ほかの機能（原曲からワンボタンで作り始めるなど）から呼ぶ。
// - 曲の音は、ドラムも入った完全な曲（ドラム抜きの BGM だけからは作らない。選曲画面でドラムが鳴らない試聴になるので）：
//   1. 作業ファイルが覚えている完全な原曲（無ければほかの難易度の作業ファイルが覚えているもの・ドラム抜きの BGM と同じ名前の元の原曲）
//   2. ドラム入りらしい原曲（BGM。長い SE があればゲームと同じに足す）
//   3. 原曲がドラム抜き（曲_drumless.ogg・DTXMania の曲の bgm.ogg など）か無いとき：ステムを全部足した音（ほかの難易度のステムも見る。
//      メトロノーム・クリックは足さない）。ドラムのステムだけなら BGM と足す。長い SE がドラム（ドラムのステムを SE で鳴らす譜面）ならそれを足す
//   4. 打ち込み終わった譜面なら、BGM に譜面のドラムの音をゲームと同じに足した音（サビを探すのは BGM で、切り出すのはドラムも足した音）
//   5. どれも無く、BGM がドラム抜きと書いてある名前なら、サビを探して聴けるが、試聴は作らない（完全な原曲かステムを読み込むよう知らせる）
// - サビを探すのはワーカー（src/audio/chorus.ts）。小節は譜面の小節線（音に合っていなければ音から推定）
// - DTXMania は試聴のファイルを頭から繰り返し鳴らすだけ（どこから鳴らすかを書けない）なので、サビの所を切り出したファイル
//   （preview_chorus.ogg）を作って #PREVIEW に入れる。同じ試聴だったほかの難易度にも入れ、元に戻せる（src/store/stems.ts の registerExport）
//
// 画面を通さずに使うとき：
//   findChorusIn(buf か曲フォルダのパス)  → その音の秒でのサビ（best.start〜best.end）
//   findSongChorus()                     → 開いている曲のサビ（曲の音の秒。譜面の秒は + audio.offset）
//   makeChorusPreview()                  → サビを探して試聴のファイルを作り #PREVIEW に入れる。作ったファイルの名前を返す
import { create } from 'zustand';
import type { ChorusFound, ChorusGrid, ChorusPick } from '../audio/chorus';
import { engine } from '../audio/engine';
import { ENV_HOP, envelope, judgeDrums } from '../audio/drumCheck';
import { applyFadeAndPeak, applyFades, encodeAudio, renderPlaced, shiftBuffer, type PlacedTrack } from '../audio/stems';
import * as wk from '../audio/workerClient';
import type { DtxDoc } from '../dtx/model';
import { findFile, normPath, putFile, type FolderFile, type SongFolder } from '../fs/folder';
import { getRecent, recentIdFor } from '../fs/recent';
import { soundKey } from '../fs/soundKey';
import { tr } from '../i18n';
import { bgmSource, soundBus, soundEvents, tempoOf, wavPan, wavPath, wavVolume } from './derived';
import { dismissToast, prepareSounds, toast, useEditor } from './editor';
import { isDrumlessName, isGameBgmName } from '../separate/names';
import { bgmFileOf, fullMixFile, fullOriginal, isFullMixPath, markPreviewFilled, namedOriginal, previewFillable } from './fullMix';
import { useSidecar, type SidecarData, type StemTrack } from './sidecar';
import { readSidecarFor, recentSidecarOf } from './sidecarFile';
import { otherCharts } from './siblings';
import { onlyThisAction, songSiblingNote } from './songSync';
import { audioReflected, isGuideStem, readyStems, registerExport, stemBuffer, stemsSettled, undoAudioReflect } from './stems';

/** 作る試聴のファイル名 */
export const CHORUS_PREVIEW_FILE = 'preview_chorus.ogg';
/** 切り出し：小節の頭の少し前から（叩いた音の頭を削らない）・頭のフェード・終わりに足す余韻とフェード（秒） */
const PRE = 0.05;
const FADE_IN = 0.03;
const TAIL = 1.5;
const FADE_OUT = 2;
/** 試聴の長さのめやす（秒）。4 小節単位でこれに近くする */
export const PREVIEW_TARGET_SEC = 15;
/** これより長い SE は曲の一部（ドラムのステムなど）として足す（秒） */
const LONG_SE_SEC = 10;
/** 譜面のドラムの音を足して試聴にするのに要る、ドラムのチップがある小節の割合（BGM の長さのうち）。打ち込み途中の譜面では足さない */
const GAME_COVERAGE = 0.6;

/**
 * サビを探した曲の音の種類。full: 完全な原曲 / chart: 譜面の BGM と長い SE / stems: ステムを全部足した音 /
 * bgmStems: ドラム抜きの BGM とドラムのステム / game: BGM に譜面のドラムの音をゲームと同じに足した音 /
 * bgm: ドラム抜きの原曲だけ（試聴は作らない）
 */
export type SongAudioKind = 'full' | 'chart' | 'stems' | 'bgmStems' | 'game' | 'bgm';

/** サビを探した曲の音 */
export interface SongAudio {
  /** ワーカーでの名前（同じ音なら同じ） */
  key: string;
  kind: SongAudioKind;
  /** 画面に出す名前（ファイル名など） */
  label: string;
  /** ドラム抜きかもしれない（DTXMania の曲の BGM の名前 bgm.ogg だけ。ほかに完全な曲の音が無い） */
  maybeDrumless?: boolean;
  /** 曲の音の 0 秒が、譜面の何秒か */
  offset: number;
  duration: number;
  /** サビを探す音（at は曲の音の秒） */
  tracks: PlacedTrack[];
  /** 試聴を切り出す音（ふつうは tracks と同じ。game は譜面のドラムなどの音も足す） */
  clip: PlacedTrack[];
}

/** 開いている曲のサビ（時刻は曲の音の秒。譜面の秒は + audio.offset） */
export interface SongChorus extends ChorusFound {
  audio: Omit<SongAudio, 'tracks' | 'clip'>;
  /** 探したときの曲の音と小節線（変わったら探し直す） */
  sig: string;
}

/** 試聴にする所（曲の音の秒） */
export interface ChorusRange {
  start: number;
  end: number;
}

export interface ChorusState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** 0〜1 */
  progress: number;
  /** していること */
  step: string;
  error: string | null;
  found: SongChorus | null;
  /** 試聴のファイルを作っている */
  making: boolean;
}

const IDLE: ChorusState = { status: 'idle', progress: 0, step: '', error: null, found: null, making: false };
export const useChorus = create<ChorusState>(() => IDLE);
const cset = useChorus.setState;

/** ドラム抜きの音しか無いときの知らせ */
export const drumlessOnlyText = () =>
  tr(
    '曲の音がドラム抜きの BGM しか無いので、試聴は作りません（選曲画面でドラムが鳴らない試聴になるため）。完全な原曲（ドラム入り）かステムを読み込むか、ドラムを打ち込んでから作ってください',
    "The only song audio is the BGM without drums, so no preview is made (it would play without drums on the song select screen). Load the full original (with drums) or the stems, or chart the drums first",
  );

const noAudioText = () => tr('曲の音（原曲・BGM）がありません。原曲を入れてから使ってください', "There's no song audio (original or BGM). Add the original first");

// ---- 曲の音 ---------------------------------------------------------------------

const fileKey = (folder: SongFolder | null, f: FolderFile) => `${folder?.name}|${f.path}|${f.size}|${f.ver ?? 0}`;

/** 曲の音の材料（読み込む前に決められる名前つき） */
export interface AudioPlan {
  /** サビを探す音（同じなら同じ） */
  sig: string;
  kind: SongAudioKind;
  label: string;
  maybeDrumless?: boolean;
  offset: number;
  /** サビを探す音 */
  load: () => Promise<PlacedTrack[] | null>;
  /** 試聴を切り出す音（サビを探す音から作る。無ければ同じ音） */
  clip?: (tracks: PlacedTrack[]) => PlacedTrack[];
}

async function decodeFile(f: FolderFile): Promise<AudioBuffer | null> {
  try {
    return await engine.decodeAudio(await (await f.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

/** 最後に読んだファイルの音（ドラムが入っているかを確かめた原曲を、サビを探すときにもう一度読まない） */
let lastDecoded: { key: string; p: Promise<AudioBuffer | null> } | null = null;
function decodeOnce(folder: SongFolder | null, f: FolderFile): Promise<AudioBuffer | null> {
  const key = fileKey(folder, f);
  if (lastDecoded?.key !== key) lastDecoded = { key, p: decodeFile(f) };
  return lastDecoded.p;
}

/** ドラム抜きらしい名前（曲_drumless.ogg など）か、DTXMania の曲の BGM の名前（bgm.ogg・bgm_d.ogg。ドラム抜きのことが多い） */
const drumlessish = (name: string) => isDrumlessName(name) || isGameBgmName(name);

/** ステムの材料：ステムと、その音の読み方 */
interface StemSet {
  tracks: StemTrack[];
  /** ほかの難易度の作業ファイルのステムなら、その難易度 */
  from: string | null;
  key: (t: StemTrack) => string;
  get: (t: StemTrack) => Promise<AudioBuffer | null>;
}

let sibCache: { folder: SongFolder; fileName: string; at: number; p: Promise<{ label: string; data: SidecarData }[]> } | null = null;

/** ほかの難易度の作業ファイル（保存していない控えがあればそちら。難易度のタブの順）。読めないものは除く */
function siblingSidecars(folder: SongFolder, fileName: string): Promise<{ label: string; data: SidecarData }[]> {
  // 曲情報を打っている間などに何度も読まないよう、少しの間は前に読んだものを使う
  if (sibCache && sibCache.folder === folder && sibCache.fileName === fileName && Date.now() - sibCache.at < 3000) return sibCache.p;
  const p = (async () => {
    const out: { label: string; data: SidecarData }[] = [];
    let list: { file: FolderFile; label: string }[] = [];
    try {
      list = await otherCharts(folder, fileName);
    } catch {
      return out;
    }
    for (const x of list) {
      try {
        const e = await getRecent(recentIdFor(folder, x.file.name)).catch(() => undefined);
        const r = await readSidecarFor(folder, x.file.name, recentSidecarOf(e));
        if (r.data) out.push({ label: x.label, data: r.data });
      } catch {
        // 読めない作業ファイルは見ない
      }
    }
    return out;
  })();
  sibCache = { folder, fileName, at: Date.now(), p };
  return p;
}

/** 使うステム：開いている譜面の読み込めたステム。無ければ、ステムのあるほかの難易度のもの（曲フォルダから読む） */
function stemSet(folder: SongFolder | null, sibs: { label: string; data: SidecarData }[]): StemSet | null {
  const own = readyStems().filter((t) => !isGuideStem(t));
  const keyOf = (t: StemTrack) => {
    const f = findFile(folder, t.file);
    return `${f ? soundKey(folder, f) : t.file}@${t.offsetMs}`;
  };
  if (own.length) return { tracks: own, from: null, key: keyOf, get: async (t) => stemBuffer(t.file) };
  if (!folder) return null;
  for (const s of sibs) {
    const list = s.data.stems.filter((t) => findFile(folder, t.file) && !isGuideStem(t));
    if (!list.length) continue;
    return {
      tracks: list,
      from: s.label,
      key: keyOf,
      get: async (t) => {
        const f = findFile(folder, t.file);
        const raw = f ? await decodeFile(f) : null;
        return raw && t.offsetMs ? shiftBuffer(engine.workCtx(), raw, t.offsetMs) : raw;
      },
    };
  }
  return null;
}

/** ドラムとほかの楽器のステムがそろっているか（曲の音にドラムが入っているかを、音で比べられる） */
const canCompare = (set: StemSet | null): set is StemSet => !!set && set.tracks.some((t) => t.kind === 'drums') && set.tracks.some((t) => t.kind !== 'drums');

interface StemEnvelopes {
  key: string;
  /** ドラムの強さの並び */
  d: Float32Array;
  /** ほかの楽器の強さの並び */
  n: Float32Array;
  duration: number;
}
/** ステムの強さの並び（同じステムなら作り直さない。同時に呼ばれても一度だけ作る） */
let stemEnv: { key: string; p: Promise<StemEnvelopes | null> } | null = null;
/** 確かめた答え（ファイル・ステム・位置ごと） */
const verdicts = new Map<string, boolean | null>();

/** ステムの強さの並びの名前（同じステムなら同じ） */
const stemSetKey = (set: StemSet) => set.tracks.map(set.key).join('+');

function stemEnvelopes(set: StemSet): Promise<StemEnvelopes | null> {
  const key = stemSetKey(set);
  if (stemEnv?.key === key) return stemEnv.p;
  const p = (async () => {
    const load = async (list: StemTrack[]) => (await Promise.all(list.map((t) => set.get(t)))).filter((b): b is AudioBuffer => !!b).map((buf) => ({ buf, at: 0 }));
    const d = await load(set.tracks.filter((t) => t.kind === 'drums'));
    const n = await load(set.tracks.filter((t) => t.kind !== 'drums'));
    if (!d.length || !n.length) return null;
    const duration = Math.max(...[...d, ...n].map((x) => x.buf.duration));
    return { key, d: envelope(d, duration), n: envelope(n, duration), duration };
  })().catch(() => null);
  stemEnv = { key, p };
  return p;
}

/**
 * 音にドラムが入っているか（ステムのドラムとほかの楽器の強さと比べる。src/audio/drumCheck.ts）。名前では分からないドラム抜き
 * （前の版で原曲の名前のまま書き出したドラム抜き・それを完全な原曲として覚えたもの・ドラム抜きから作った試聴）を見分ける。
 * cacheKey：その音の名前（一度確かめた音は読み直さない）。at：その音の頭が、ステムの頭（BGM の位置）から何秒か。
 * 分からなければ曲全体から探す。比べられなければ null
 */
async function soundHasDrums(cacheKey: string, getBuf: () => Promise<AudioBuffer | null>, set: StemSet | null, at?: number): Promise<boolean | null> {
  if (!canCompare(set)) return null;
  const key = `${cacheKey}|${stemSetKey(set)}|${at ?? '*'}`;
  const hit = verdicts.get(key);
  if (hit !== undefined) return hit;
  const se = await stemEnvelopes(set);
  const buf = se ? await getBuf() : null;
  if (!se || !buf) return null;
  const c = envelope([{ buf, at: 0 }], buf.duration);
  let v = at !== undefined ? judgeDrums(c, se.d, se.n, { lag: Math.round(at / ENV_HOP), span: 30 }) : null;
  // 頭の位置が合わなければ（作者の試聴など）、曲全体から探す
  if (!v) v = judgeDrums(c, se.d, se.n);
  const out = v ? v.drums : null;
  verdicts.set(key, out);
  return out;
}

/**
 * 曲フォルダの音のファイル（パス）にドラムが入っているか。ドラムとほかの楽器のステム（開いている難易度か、ほかの難易度の作業ファイル）と
 * 音で比べる。比べられなければ null（今の試聴がドラム抜きかを知らせるのに使う）
 */
export async function fileHasDrums(path: string): Promise<boolean | null> {
  const s = useEditor.getState();
  const folder = s.folder;
  const f = findFile(folder, path, s.doc.fields['PATH_WAV'] ?? '');
  if (!folder || !f) return null;
  await stemsSettled();
  const set = stemSet(folder, await siblingSidecars(folder, s.meta.fileName));
  return soundHasDrums(fileKey(folder, f), () => decodeOnce(folder, f), set, 0);
}

/**
 * 完全な原曲（src/store/fullMix.ts の fullOriginal）を、ステムと音で比べて確かめたもの。ドラム抜きと分かれば null
 * （前の版でドラム抜きを原曲の名前のまま書き出し、完全な原曲として覚えた曲。保存の前に試聴を入れるときに使う）
 */
export async function checkedFullOriginal(): Promise<FolderFile | null> {
  const s = useEditor.getState();
  const folder = s.folder;
  const f = fullOriginal(s.doc, folder);
  if (!f || !folder) return f;
  await stemsSettled();
  const set = stemSet(folder, await siblingSidecars(folder, s.meta.fileName));
  return (await soundHasDrums(fileKey(folder, f), () => decodeOnce(folder, f), set, 0)) === false ? null : f;
}

/** BGM の長さ（秒）のうち、音のあるドラムのチップがある小節の割合 */
function drumCoverage(doc: DtxDoc, at0: number, duration: number): number {
  const t = tempoOf(doc);
  const m0 = t.locate(t.secToBeat(Math.max(0, at0))).m;
  const m1 = t.locate(t.secToBeat(at0 + duration)).m;
  if (!(duration > 0) || m1 < m0) return 0;
  const hit = new Set<number>();
  for (const c of doc.chips) if (c.m >= m0 && c.m <= m1 && soundBus(c.ch) === 'drum' && engine.buffer(c.v)) hit.add(c.m);
  return hit.size / (m1 - m0 + 1);
}

/** 譜面のドラムの音を読み込み終えるのを待つ（開いてすぐ・音を足した直後） */
async function drumSoundsReady(doc: DtxDoc) {
  if (!doc.chips.some((c) => soundBus(c.ch) === 'drum' && !engine.buffer(c.v))) return;
  try {
    await prepareSounds();
  } catch {
    // 読めない音は足さない
  }
}

/**
 * ゲームで鳴るとおりに足す譜面の音（ドラムと短い SE。BGM と長い SE はサビを探す音に入っている）。
 * ドラムは同じグループの次の音で前の音を止める（再生と同じ。src/audio/engine.ts）
 */
function chartSounds(doc: DtxDoc, base: number): PlacedTrack[] {
  const out: PlacedTrack[] = [];
  const last = new Map<string, PlacedTrack>();
  for (const e of soundEvents(doc)) {
    if (e.bus !== 'drum' && e.bus !== 'se') continue;
    const snd = engine.sound(e.wav);
    if (!snd || (e.bus === 'se' && snd.buf.duration >= LONG_SE_SEC)) continue;
    const at = e.sec - base;
    if (e.choke) {
      const prev = last.get(e.choke);
      if (prev) prev.until = at;
    }
    const t: PlacedTrack = { buf: snd.buf, at, gain: Math.max(0, Math.min(1, snd.volume / 100)), pan: Math.max(-1, Math.min(1, snd.pan / 100)) };
    if (e.choke) last.set(e.choke, t);
    out.push(t);
  }
  return out;
}

/** 開いている曲の、サビを探して試聴を切り出す音を決める（音はまだ読まない）。曲の音が無ければ null */
export async function planAudio(doc: DtxDoc, folder: SongFolder | null, fileName: string): Promise<AudioPlan | null> {
  const bgm = bgmSource(doc);
  const at0 = bgm?.sec ?? 0;
  const bf = bgmFileOf(doc, folder);
  /** 1 本のファイルの音（原曲（BGM）そのものなら、読み込んだ音を使う） */
  const single = (f: FolderFile, kind: SongAudioKind): AudioPlan => {
    const isBgm = !!bgm && !!bf && normPath(bf.path) === normPath(f.path);
    const got = isBgm ? engine.buffer(bgm.wav) : null;
    return {
      sig: got?.key ?? fileKey(folder, f),
      kind,
      label: f.path,
      offset: at0,
      load: async () => {
        const buf = got?.buf ?? (await decodeOnce(folder, f));
        return buf ? [{ buf, at: 0, gain: 1, pan: 0 }] : null;
      },
    };
  };
  // ステム（読み込み中なら待つ）。ほかの難易度の作業ファイルのものも
  const sibs = folder ? await siblingSidecars(folder, fileName) : [];
  await stemsSettled();
  const stems = stemSet(folder, sibs);
  /**
   * 完全な原曲として使ってよいか：ドラムとほかの楽器のステムがあれば、ドラムが入っているかを音で確かめる
   * （前の版では、ドラム抜きを原曲の名前のまま書き出すと、それを原曲・完全な原曲として覚えていた）。ステムが無ければ名前のとおり
   */
  const complete = async (f: FolderFile) => {
    const isBgm = !!bgm && !!bf && normPath(bf.path) === normPath(f.path);
    const got = isBgm ? engine.buffer(bgm.wav) : null;
    return (await soundHasDrums(fileKey(folder, f), async () => got?.buf ?? (await decodeOnce(folder, f)), stems, 0)) !== false;
  };
  // 1. 作業ファイルが覚えている完全な原曲（ドラム入り。BGM をドラム抜きにした曲）
  const fm = fullMixFile(folder);
  if (fm && (await complete(fm))) return single(fm, 'full');
  // ほかの難易度の作業ファイルが覚えている完全な原曲（作業ファイルの無い難易度で開いたとき）
  for (const x of sibs) {
    const f = x.data.fullMix ? findFile(folder, x.data.fullMix) : undefined;
    if (f && (await complete(f))) return single(f, 'full');
  }
  // ドラム抜きの BGM（曲_drumless.ogg）と同じ名前の元の原曲（曲.mp3）
  const named = namedOriginal(doc, folder);
  if (named && (await complete(named))) return single(named, 'full');

  // BGM と長い SE（ドラム・ボーカルのステムを SE のチップで鳴らす曲）：ゲームで鳴るとおりに、置いた所に足す
  const parts: { sec: number; no: number; key: string; get: () => Promise<AudioBuffer | null> }[] = [];
  for (const e of soundEvents(doc)) {
    if (e.bus !== 'bgm' && e.bus !== 'se') continue;
    const got = engine.buffer(e.wav);
    if (got) {
      if (e.bus === 'se' && got.buf.duration < LONG_SE_SEC) continue;
      parts.push({ sec: e.sec, no: e.wav, key: got.key, get: async () => got.buf });
    } else if (bgm && e.wav === bgm.wav && bf) {
      // 原曲がまだ読み込めていなければ、ファイルから読む
      parts.push({ sec: e.sec, no: e.wav, key: fileKey(folder, bf), get: () => decodeFile(bf) });
    }
  }
  const longSe = parts.filter((p) => p.no !== bgm?.wav);
  let chart: AudioPlan | null = null;
  if (longSe.length) {
    const base = bgm && parts.some((p) => p.no === bgm.wav) ? at0 : Math.min(...parts.map((p) => p.sec));
    const names = [...new Set(parts.map((p) => (wavPath(doc, p.no) ?? '').split(/[\\/]/).pop() || `#${p.no}`))];
    chart = {
      sig: 'chart:' + parts.map((p) => `${p.key}@${(p.sec - base).toFixed(4)}:${wavVolume(doc, p.no)}:${wavPan(doc, p.no)}`).join('+'),
      kind: 'chart',
      label: names.join(' + '),
      offset: base,
      load: async () => {
        const out: PlacedTrack[] = [];
        for (const p of parts) {
          const buf = await p.get();
          if (buf) out.push({ buf, at: p.sec - base, gain: wavVolume(doc, p.no) / 100, pan: wavPan(doc, p.no) / 100 });
        }
        return out;
      },
    };
  }
  // 2. ドラム入りらしい原曲（BGM。名前がドラム抜きらしくなく、ステムと比べてもドラムが入っている）
  if (bf && !drumlessish(bf.name) && (await complete(bf))) return chart ?? single(bf, 'full');

  // ここからは、原曲がドラム抜き（らしい）か無い
  // 3. ステム：ドラムとほかの楽器がそろえば全部を足す。ドラムだけなら BGM と足す
  const stemsPlan = (set: StemSet, withBgm: boolean): AudioPlan => {
    const b = withBgm && bf ? single(bf, 'bgmStems') : null;
    const names = set.tracks.map((t) => t.name).join(' + ');
    const from = set.from ? tr(`（${set.from} のステム）`, ` (stems of ${set.from})`) : '';
    return {
      sig: (b ? `bgm-stems:${b.sig}+` : 'stems:') + set.tracks.map(set.key).join('+') + `@${at0.toFixed(4)}`,
      kind: b ? 'bgmStems' : 'stems',
      label: (b ? `${bf!.path} + ${names}` : names) + from,
      offset: at0,
      // ステムは BGM の頭から鳴る。聴くための音量・ミュートは使わない
      load: async () => {
        const out: PlacedTrack[] = [];
        for (const t of b ? ((await b.load()) ?? []) : []) out.push(t);
        for (const t of set.tracks) {
          const buf = await set.get(t);
          if (buf) out.push({ buf, at: 0, gain: 1, pan: 0 });
        }
        return out;
      },
    };
  };
  const hasDrums = !!stems?.tracks.some((t) => t.kind === 'drums');
  const hasOthers = !!stems?.tracks.some((t) => t.kind !== 'drums');
  if (stems && hasDrums && hasOthers) return stemsPlan(stems, false);
  if (stems && hasDrums && bf) return stemsPlan(stems, true);
  // 4. 長い SE がドラム（ドラムのステムを SE で鳴らす譜面）なら、BGM と足すと完全な曲
  if (chart && longSe.some((p) => /drum|ドラム/i.test(wavPath(doc, p.no) ?? '') && !isDrumlessName(wavPath(doc, p.no) ?? ''))) return chart;
  // 5. 打ち込み終わった譜面：BGM に譜面のドラムの音をゲームと同じに足す（サビを探すのは BGM で）
  if (bf && bgm) {
    await drumSoundsReady(doc);
    const dur = engine.buffer(bgm.wav)?.buf.duration ?? 0;
    if (drumCoverage(doc, at0, dur) >= GAME_COVERAGE) {
      const p = chart ?? single(bf, 'game');
      return { ...p, kind: 'game', clip: (tracks) => [...tracks, ...chartSounds(doc, p.offset)] };
    }
  }
  // 6. ほかのステム（種類のわからないステム・原曲が無い曲のステム）は全部を足す
  if (stems && (stems.tracks.length >= 2 || !bf)) return stemsPlan(stems, false);
  if (!bf) return chart;
  // 7. DTXMania の曲の BGM の名前（bgm.ogg）だけ：ドラム抜きのことが多いが、わからないので使う（画面で知らせる）
  if (!isDrumlessName(bf.name)) return { ...(chart ?? single(bf, 'full')), maybeDrumless: true };
  // 8. ドラム抜きの原曲だけ：サビを探して聴けるが、試聴は作らない
  return { ...(chart ?? single(bf, 'bgm')), kind: 'bgm' };
}

let audioCache: { key: string; offset: number; duration: number; tracks: PlacedTrack[] } | null = null;

/** 開いている譜面の、曲の音の材料 */
function planOpen(): Promise<AudioPlan | null> {
  const s = useEditor.getState();
  return planAudio(s.doc, s.folder, s.meta.fileName);
}

/** 開いている曲の音（サビを探す音・試聴を切り出す音）。無ければ null。plan を渡せば、それを読む */
export async function songAudio(plan?: AudioPlan | null): Promise<SongAudio | null> {
  const p = plan === undefined ? await planOpen() : plan;
  if (!p) return null;
  let a = audioCache?.key === p.sig && audioCache.offset === p.offset ? audioCache : null;
  if (!a) {
    const tracks = await p.load();
    if (!tracks?.length) return null;
    const duration = Math.max(...tracks.map((t) => t.at + t.buf.duration));
    a = audioCache = { key: p.sig, offset: p.offset, duration, tracks };
  }
  return { ...a, kind: p.kind, label: p.label, ...(p.maybeDrumless ? { maybeDrumless: true } : {}), clip: p.clip ? p.clip(a.tracks) : a.tracks };
}

/** サビを探すための音（モノラルの 22.05 kHz。ワーカーに渡す量を減らす） */
function analysisMix(tracks: PlacedTrack[], duration: number): Promise<AudioBuffer> {
  return renderPlaced(tracks, 0, duration, { sampleRate: 22050, channels: 1 });
}

/** ワーカーに曲の音を渡す（原曲がもう渡してあればそれを使う）。ワーカーでの名前を返す */
async function loadForAnalysis(a: Pick<SongAudio, 'key' | 'tracks' | 'duration'>): Promise<string> {
  if (wk.isLoaded(a.key)) return a.key;
  const key = `chorus|${a.key}`;
  if (!wk.isLoaded(key)) await wk.loadAudio(key, await analysisMix(a.tracks, a.duration));
  return key;
}

/**
 * 開いている曲の音（和音の入った音）をワーカーに渡し、ワーカーでの名前と、その音の 0 秒が譜面の何秒かを返す。無ければ null。
 * サビ探しと同じ音なので、ワーカーで測った特徴を使い回せる（テンポの推定で 1 拍目を決める和音の手がかりなど）
 */
export async function songAudioKey(): Promise<{ key: string; offset: number } | null> {
  const a = await songAudio();
  return a ? { key: await loadForAnalysis(a), offset: a.offset } : null;
}

// ---- 小節線 ---------------------------------------------------------------------

/** 譜面の小節の頭と拍を、曲の音の秒で（offset は曲の音の 0 秒が譜面の何秒か） */
export function chartGrid(doc: DtxDoc, offset: number, duration: number): ChorusGrid {
  const t = tempoOf(doc);
  const bars: number[] = [];
  const beats: number[] = [];
  for (let m = 0; m < 3600; m++) {
    const b0 = t.measureStart(m);
    const s0 = t.beatToSec(b0) - offset;
    if (s0 > duration + 0.5) break;
    bars.push(s0);
    const nb = t.measureBeats(m);
    for (let k = 0; k < nb - 1e-9; k++) beats.push(t.beatToSec(b0 + k) - offset);
  }
  return { bars, beats };
}

const gridSig = (g: ChorusGrid) => `${g.bars.length}|${g.bars.slice(0, 3).map((v) => v.toFixed(4)).join(',')}|${(g.bars[g.bars.length - 1] ?? 0).toFixed(4)}|${g.beats.length}`;

// ---- サビを探す ---------------------------------------------------------------------

/**
 * 音（AudioBuffer、または開いている曲フォルダの中のパス）のサビを探す。時刻はその音の秒。
 * grid は小節の頭と拍（その音の秒）。渡さなければ音から拍を追って小節を推定する
 */
export async function findChorusIn(src: AudioBuffer | string, opts: { grid?: ChorusGrid | null; progress?: (p: number) => void } = {}): Promise<ChorusFound> {
  let key: string;
  if (typeof src === 'string') {
    const s = useEditor.getState();
    const f = findFile(s.folder, src, s.doc.fields['PATH_WAV'] ?? '');
    if (!f) throw new Error(tr(`曲フォルダに ${src} が見つかりません`, `${src} isn't in the song folder`));
    key = `chorus|${fileKey(s.folder, f)}`;
    if (!wk.isLoaded(key)) {
      const buf = await decodeFile(f);
      if (!buf) throw new Error(tr(`${src} を読み込めませんでした`, `Couldn't read ${src}`));
      await wk.loadAudio(key, await analysisMix([{ buf, at: 0, gain: 1, pan: 0 }], buf.duration));
    }
  } else {
    let id = bufferIds.get(src);
    if (id === undefined) bufferIds.set(src, (id = ++bufferSeq));
    key = `chorus-buf|${id}`;
    if (!wk.isLoaded(key)) await wk.loadAudio(key, await analysisMix([{ buf: src, at: 0, gain: 1, pan: 0 }], src.duration));
  }
  return wk.chorus(key, opts.grid ?? null, opts.progress);
}

const bufferIds = new WeakMap<AudioBuffer, number>();
let bufferSeq = 0;

/** 探している曲の音（同じ曲の音・同じ小節線なら、探し終わるのを待って同じ答えを使う） */
let detecting: { pre: string; p: Promise<SongChorus | null> } | null = null;
/** 同じ譜面・同じ作業ファイルで続けて呼ばれたとき（開いてすぐ・押してすぐ）は、同じ答えを待つ */
let inflight: { doc: DtxDoc; folder: SongFolder | null; stems: readonly StemTrack[]; fullMix: string | null; tok: object; p: Promise<SongChorus | null> } | null = null;

const metaSig = (a: Pick<SongAudio, 'kind' | 'label' | 'maybeDrumless'>) => `${a.kind}|${a.label}|${a.maybeDrumless ? 1 : 0}`;

/** 曲の音を読み込んでサビを探す（進み具合と答えは、いちばん新しく探し始めたものだけ useChorus に入れる） */
function detect(plan: AudioPlan, pre: string): { pre: string; p: Promise<SongChorus | null> } {
  const d: { pre: string; p: Promise<SongChorus | null> } = { pre, p: Promise.resolve(null) };
  const live = () => detecting === d;
  detecting = d;
  d.p = (async () => {
    cset({ status: 'loading', progress: 0, step: tr('曲の音を読み込んでいます', 'Loading the song audio'), error: null });
    try {
      const a = await songAudio(plan);
      if (!a) throw new Error(tr('曲の音を読み込めませんでした', "Couldn't load the song audio"));
      if (live()) cset({ progress: 0.05, step: tr('曲の音を用意しています', 'Preparing the song audio') });
      const key = await loadForAnalysis(a);
      const grid = chartGrid(useEditor.getState().doc, a.offset, a.duration);
      if (live()) cset({ progress: 0.1, step: tr('曲を部分に分けて、サビを探しています', 'Splitting the song into sections and finding the chorus') });
      const r = await wk.chorus(key, grid, (q) => {
        if (live()) cset({ progress: 0.1 + 0.9 * q });
      });
      const { tracks: _tracks, clip: _clip, ...audio } = a;
      const found: SongChorus = { ...r, audio, sig: `${pre}#${gridSig(grid)}` };
      if (live()) cset({ status: 'ready', progress: 1, step: '', error: null, found });
      return found;
    } catch (e) {
      if (live()) cset({ status: 'error', error: (e as Error).message, step: '' });
      return null;
    } finally {
      if (live()) detecting = null;
    }
  })();
  return d;
}

/**
 * 開いている曲のサビを探す（同じ曲の音・同じ小節線なら、前の答えを使う）。曲の音が無ければ null。
 * 進み具合・答えは useChorus にも入る
 */
export function findSongChorus(opts: { force?: boolean } = {}): Promise<SongChorus | null> {
  const s = useEditor.getState();
  const side = useSidecar.getState();
  if (!opts.force && inflight && inflight.doc === s.doc && inflight.folder === s.folder && inflight.stems === side.stems && inflight.fullMix === side.fullMix) return inflight.p;
  const tok = {};
  const mine = () => inflight?.tok === tok;
  const run = async (): Promise<SongChorus | null> => {
    try {
      const plan = await planAudio(s.doc, s.folder, s.meta.fileName);
      if (!plan) {
        if (mine()) cset({ ...IDLE, status: 'error', error: noAudioText() });
        return null;
      }
      const pre = `${plan.sig}@${plan.offset.toFixed(4)}`;
      const meta = { kind: plan.kind, label: plan.label, maybeDrumless: plan.maybeDrumless };
      /** 探した答えに、今の試聴を切り出す音の種類・名前を付ける（サビを探す音が同じなら、BGM に足す音が変わっても探し直さない） */
      const withMeta = (f: SongChorus | null) => (f && metaSig(f.audio) !== metaSig(meta) ? { ...f, audio: { ...f.audio, ...meta } } : f);
      const cur = useChorus.getState().found;
      // 小節線（テンポ）も同じなら前の答え
      if (!opts.force && cur && cur.sig === `${pre}#${gridSig(chartGrid(useEditor.getState().doc, cur.audio.offset, cur.audio.duration))}`) {
        const next = withMeta(cur)!;
        if (mine() && (next !== cur || useChorus.getState().status !== 'ready')) cset({ status: 'ready', error: null, found: next });
        return next;
      }
      const d = !opts.force && detecting?.pre === pre ? detecting : detect(plan, pre);
      const found = withMeta(await d.p);
      if (found && found !== useChorus.getState().found && mine() && !detecting) cset({ status: 'ready', error: null, found });
      return found;
    } catch (e) {
      if (mine()) cset({ status: 'error', error: (e as Error).message, step: '' });
      return null;
    } finally {
      if (mine()) inflight = null;
    }
  };
  inflight = { doc: s.doc, folder: s.folder, stems: side.stems, fullMix: side.fullMix, tok, p: run() };
  return inflight.p;
}

/** 小節 i から n 小節の範囲（曲の音の秒）。小節線が足りなければ平均の長さで延ばす */
export function barRange(found: Pick<ChorusFound, 'bars' | 'duration'>, i: number, n: number): ChorusRange {
  const b = found.bars;
  const start = b[i] ?? 0;
  const len = barLength(found, i);
  const end = i + n < b.length ? b[i + n] : start + n * len;
  return { start: Math.max(0, start), end: Math.min(found.duration, Math.max(start + 0.5, end)) };
}

/** 小節 i あたりの 1 小節の長さ（秒） */
export function barLength(found: Pick<ChorusFound, 'bars'>, i: number): number {
  const b = found.bars;
  const a = Math.max(0, Math.min(b.length - 2, i));
  const z = Math.min(b.length - 1, a + 4);
  return z > a ? (b[z] - b[a]) / (z - a) : 2;
}

/** 試聴の小節の数（4 小節単位で、PREVIEW_TARGET_SEC 秒に近い数） */
export function defaultBarCount(found: Pick<ChorusFound, 'bars'>, i: number): number {
  const len = barLength(found, i);
  return Math.max(4, Math.min(16, Math.round(PREVIEW_TARGET_SEC / len / 4) * 4));
}

/** サビが見つからないときの所：前奏の後（20 秒か曲の 3 割）にいちばん近い小節 */
export function fallbackBar(found: Pick<ChorusFound, 'bars' | 'duration'>): number {
  const want = Math.max(20, found.duration * 0.3);
  let best = 0;
  found.bars.forEach((t, i) => {
    if (t >= 0 && Math.abs(t - want) < Math.abs(found.bars[best] - want)) best = i;
  });
  return best;
}

/** 試聴にする所（サビの頭から 4 小節単位で約 15 秒）。見つからなければ前奏の後 */
export function defaultRange(found: ChorusFound, pick: ChorusPick | null = found.best): ChorusRange {
  if (!found.bars.length) {
    const start = pick?.start ?? Math.min(Math.max(20, found.duration * 0.3), Math.max(0, found.duration - PREVIEW_TARGET_SEC));
    return { start, end: Math.min(found.duration, start + PREVIEW_TARGET_SEC) };
  }
  const i = pick ? pick.bar : fallbackBar(found);
  return barRange(found, i, defaultBarCount(found, i));
}

// ---- 試聴のファイル ---------------------------------------------------------------------

/**
 * 試聴の音（曲の音の start〜end 秒。頭に少しの余裕とフェード、終わりに余韻とフェードアウト）。
 * ドラム抜きの音しか無ければ作らない（listen なら試し聴きの音として作る）
 */
export async function renderChorusClip(range: ChorusRange, audio?: SongAudio | null, opts: { listen?: boolean } = {}): Promise<AudioBuffer> {
  const a = audio ?? (await songAudio());
  if (!a) throw new Error(tr('曲の音がありません', "There's no song audio"));
  if (a.kind === 'bgm' && !opts.listen) throw new Error(drumlessOnlyText());
  const from = Math.max(0, range.start - PRE);
  const to = Math.min(a.duration, Math.max(range.end, range.start + 1) + TAIL);
  const sr = Math.min(48000, Math.max(22050, a.clip[0]?.buf.sampleRate ?? 44100));
  const buf = await renderPlaced(a.clip, from, to, { sampleRate: sr, channels: 2 });
  // 足した音が割れるときだけ下げる
  applyFadeAndPeak(buf, 0, -1);
  applyFades(buf, FADE_IN, Math.min(FADE_OUT, (to - from) / 3));
  return buf;
}

/** 作る試聴のファイル名（完全な原曲・譜面で使っている音と同じ名前なら番号を付ける） */
export function chorusPreviewName(doc: DtxDoc = useEditor.getState().doc, folder: SongFolder | null = useEditor.getState().folder): string {
  const used = new Set<string>();
  for (const [k, v] of Object.entries(doc.fields)) if (/^(WAV|BMP|AVI)[0-9A-Z]{2}$/.test(k) || k === 'BGMWAV') used.add(normPath(v));
  const taken = (name: string) => used.has(normPath(name)) || isFullMixPath(name);
  if (!taken(CHORUS_PREVIEW_FILE)) return CHORUS_PREVIEW_FILE;
  for (let i = 2; ; i++) {
    const name = CHORUS_PREVIEW_FILE.replace(/\.ogg$/, `_${i}.ogg`);
    if (!taken(name) && (!findFile(folder, name) || i > 20)) return name;
  }
}

const fmt = (sec: number) => {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * 試聴のファイル（preview_chorus.ogg）を曲の音の range（無ければサビを探して約 15 秒）から作り、#PREVIEW に入れる。
 * 同じ試聴だったほかの難易度にも入れる（知らせの「元に戻す」で前に戻せる）。作ったファイルの名前と所を返す（できなければ null。
 * わけは useChorus の error に入る）。quiet なら知らせを出さない
 */
export async function makeChorusPreview(range?: ChorusRange | null, opts: { quiet?: boolean } = {}): Promise<{ file: string; start: number; end: number } | null> {
  const folder = useEditor.getState().folder;
  const fail = (msg: string, level: 'warn' | 'error' = 'warn') => {
    cset({ error: msg });
    if (!opts.quiet) toast(msg, level, level === 'error' ? 8000 : 9000);
    return null;
  };
  if (!folder) return fail(tr('先に曲フォルダを開いてください', 'Open a song folder first'));
  if (useChorus.getState().making) return null;
  cset({ making: true });
  try {
    let r = range ?? null;
    if (!r) {
      const found = await findSongChorus();
      if (!found) return fail(useChorus.getState().error ?? tr('曲の音がありません', "There's no song audio"));
      r = defaultRange(found);
    }
    const a = await songAudio();
    if (!a) return fail(tr('曲の音がありません', "There's no song audio"));
    // ドラム抜きの音だけからは作らない（選曲画面でドラムが鳴らない）
    if (a.kind === 'bgm') return fail(drumlessOnlyText());
    const buf = await renderChorusClip(r, a);
    const bytes = await encodeAudio(buf, 'ogg');
    // 書いている間に別の曲を開いたら入れない
    if (useEditor.getState().folder !== folder) return null;
    const file = chorusPreviewName();
    const memory = (await putFile(folder, file, bytes)) === 'memory';
    const before = useEditor.getState().doc.fields['PREVIEW'] ?? '';
    const prev = registerExport(file, 'preview');
    const rec = audioReflected('preview');
    if (!opts.quiet) {
      const later = memory ? tr('。曲フォルダへは保存するときに書き出します', '. It is written to the song folder when you save') : '';
      const was = prev && prev !== file ? tr(`（前は ${prev}）`, ` (was ${prev})`) : before === file ? tr('（作り直しました）', ' (remade)') : '';
      const sib = rec?.siblings ? await rec.siblings.done : null;
      toast(
        tr(
          `曲の ${fmt(r.start)}〜${fmt(r.end)} を切り出した ${file} を、選曲画面の試聴（#PREVIEW）にしました${was}${later}`,
          `Cut ${fmt(r.start)}–${fmt(r.end)} of the song into ${file} and set it as the song select preview (#PREVIEW)${was}${later}`,
        ) + songSiblingNote(sib, tr('試聴', 'preview')),
        'ok',
        sib?.changed.length || sib?.kept.length ? 10000 : 7000,
        prev !== file && audioReflected('preview') ? { label: tr('元に戻す', 'Undo'), run: () => undoAudioReflect('preview') } : undefined,
        sib?.changed.length && rec?.siblings ? onlyThisAction(rec.siblings) : undefined,
      );
    }
    return { file, start: r.start, end: r.end };
  } catch (e) {
    return fail(tr(`試聴を作れませんでした: ${(e as Error).message}`, `Couldn't make the preview: ${(e as Error).message}`), 'error');
  } finally {
    cset({ making: false });
  }
}

/**
 * 保存・書き出しの前に、試聴（#PREVIEW）が空で完全な原曲のファイルも無いとき（src/store/fullMix.ts の fillPreview で入れられないとき）、
 * 完全な曲の音（ステムを全部足した音・BGM に譜面のドラムを足した音など）のサビから試聴を作って入れる（DTXMania は試聴が無いと選曲画面で何も鳴らさない）。
 * ドラム抜きかもしれない音だけなら作らない。一度入れたのを空にしたなら、そのまま。作ったらそのファイル名
 */
export async function fillPreviewFromChorus(): Promise<string | null> {
  const s = useEditor.getState();
  if (!s.folder || !previewFillable()) return null;
  const plan = await planAudio(s.doc, s.folder, s.meta.fileName).catch(() => null);
  if (!plan || plan.kind === 'bgm' || plan.maybeDrumless) return null;
  const wait = toast(tr('選曲画面の試聴（#PREVIEW）が空なので、曲のサビから作っています…', 'The song select preview (#PREVIEW) is empty, so one is being made from the chorus…'), 'info', 60000);
  const r = await makeChorusPreview(null, { quiet: true });
  dismissToast(wait);
  if (!r || useEditor.getState().folder !== s.folder) return null;
  markPreviewFilled();
  toast(
    tr(
      `選曲画面の試聴（#PREVIEW）が空だったので、曲の ${fmt(r.start)}〜${fmt(r.end)}（サビ）を切り出した ${r.file} を入れました（DTXMania は試聴が無いと何も鳴らしません）。曲情報で変えられます`,
      `The song select preview (#PREVIEW) was empty, so ${r.file} (the chorus, ${fmt(r.start)}–${fmt(r.end)}) was made and set (DTXMania plays nothing without one). You can change it in Song info`,
    ),
    'info',
    9000,
  );
  return r.file;
}

// 別の曲を開いたら、探した答えと曲の音を捨てる（同じ曲の難易度の切り替えでは、同じ音・同じ小節線なら前の答えを使う）
useEditor.subscribe((s, prev) => {
  if (s.folder === prev.folder) return;
  audioCache = null;
  inflight = null;
  detecting = null;
  sibCache = null;
  lastDecoded = null;
  stemEnv = null;
  verdicts.clear();
  if (useChorus.getState() !== IDLE) cset(IDLE);
});
