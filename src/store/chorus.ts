// サビから選曲画面の試聴（#PREVIEW）を作る。曲情報の「サビから作る」と、ほかの機能（原曲からワンボタンで作り始めるなど）から呼ぶ。
// - 曲の音：作業ファイルが覚えている完全な原曲（ドラム入り）。無ければゲームで鳴るとおりの BGM と長い SE（SE で鳴らすドラムのステムなど）。
//   原曲がドラム抜きで、読み込んだステムがあれば全部足した音（ステムだけの曲）。どれでもなければ原曲（BGM）
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
import { applyFadeAndPeak, applyFades, encodeAudio, renderPlaced, type PlacedTrack } from '../audio/stems';
import * as wk from '../audio/workerClient';
import type { DtxDoc } from '../dtx/model';
import { findFile, normPath, putFile, type FolderFile, type SongFolder } from '../fs/folder';
import { tr } from '../i18n';
import { bgmSource, soundEvents, tempoOf, wavPan, wavPath, wavVolume } from './derived';
import { toast, useEditor } from './editor';
import { isDrumlessName } from '../separate/names';
import { bgmFileOf, fullMixFile, isFullMixPath } from './fullMix';
import { onlyThisAction, songSiblingNote } from './songSync';
import { audioReflected, readyStems, registerExport, stemBuffer, undoAudioReflect } from './stems';

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

/** サビを探した曲の音 */
export interface SongAudio {
  /** ワーカーでの名前（同じ音なら同じ） */
  key: string;
  /** full: 完全な原曲 / chart: 譜面の BGM と長い SE / stems: ステムを全部足した音 / bgm: ドラム抜きの原曲だけ */
  kind: 'full' | 'chart' | 'stems' | 'bgm';
  /** 画面に出す名前（ファイル名など） */
  label: string;
  /** 曲の音の 0 秒が、譜面の何秒か */
  offset: number;
  duration: number;
  /** at は曲の音の秒 */
  tracks: PlacedTrack[];
}

/** 開いている曲のサビ（時刻は曲の音の秒。譜面の秒は + audio.offset） */
export interface SongChorus extends ChorusFound {
  audio: Omit<SongAudio, 'tracks'>;
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

// ---- 曲の音 ---------------------------------------------------------------------

const fileKey = (folder: SongFolder | null, f: FolderFile) => `${folder?.name}|${f.path}|${f.size}|${f.ver ?? 0}`;

/** 曲の音の材料（読み込む前に決められる名前つき） */
interface AudioPlan {
  sig: string;
  kind: SongAudio['kind'];
  label: string;
  offset: number;
  load: () => Promise<PlacedTrack[] | null>;
}

async function decodeFile(f: FolderFile): Promise<AudioBuffer | null> {
  try {
    return await engine.decodeAudio(await (await f.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

function planAudio(doc: DtxDoc, folder: SongFolder | null): AudioPlan | null {
  const bgm = bgmSource(doc);
  const at0 = bgm?.sec ?? 0;
  const bf = bgmFileOf(doc, folder);
  /** 1 本のファイルの音（原曲（BGM）そのものなら、読み込んだ音を使う） */
  const single = (f: FolderFile, kind: SongAudio['kind']): AudioPlan => {
    const isBgm = !!bgm && !!bf && normPath(bf.path) === normPath(f.path);
    const got = isBgm ? engine.buffer(bgm.wav) : null;
    return {
      sig: got?.key ?? fileKey(folder, f),
      kind,
      label: f.path,
      offset: at0,
      load: async () => {
        const buf = got?.buf ?? (await decodeFile(f));
        return buf ? [{ buf, at: 0, gain: 1, pan: 0 }] : null;
      },
    };
  };
  // 1. 作業ファイルが覚えている完全な原曲（ドラム入り。BGM をドラム抜きにした曲）
  const fm = fullMixFile(folder);
  if (fm) return single(fm, 'full');
  // 2. BGM と長い SE（ドラム・ボーカルのステムを SE のチップで鳴らす曲）：ゲームで鳴るとおりに、置いた所に足す
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
  if (parts.some((p) => p.no !== bgm?.wav)) {
    const base = bgm && parts.some((p) => p.no === bgm.wav) ? at0 : Math.min(...parts.map((p) => p.sec));
    const names = [...new Set(parts.map((p) => (wavPath(doc, p.no) ?? '').split(/[\\/]/).pop() || `#${p.no}`))];
    return {
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
  // 3. ステムだけの曲（原曲がドラム抜き・無い）：読み込んだステムを全部足す（ステムは BGM の頭から鳴る。聴くための音量・ミュートは使わない）
  const stems = readyStems().filter((t) => stemBuffer(t.file));
  if (stems.length >= 2 && (!bf || isDrumlessName(bf.name))) {
    return {
      sig: 'stems:' + stems.map((t) => `${t.file}@${t.offsetMs}`).join('+') + `@${at0.toFixed(4)}`,
      kind: 'stems',
      label: stems.map((t) => t.name).join(' + '),
      offset: at0,
      load: async () => stems.map((t) => ({ buf: stemBuffer(t.file)!, at: 0, gain: 1, pan: 0 })),
    };
  }
  // 4. 原曲（BGM）
  return bf ? single(bf, isDrumlessName(bf.name) ? 'bgm' : 'full') : null;
}

let audioCache: SongAudio | null = null;

/** 開いている曲の音（サビを探す音・試聴を切り出す音）。無ければ null */
export async function songAudio(): Promise<SongAudio | null> {
  const s = useEditor.getState();
  const plan = planAudio(s.doc, s.folder);
  if (!plan) return null;
  if (audioCache?.key === plan.sig && audioCache.offset === plan.offset) return audioCache;
  const tracks = await plan.load();
  if (!tracks?.length) return null;
  const duration = Math.max(...tracks.map((t) => t.at + t.buf.duration));
  audioCache = { key: plan.sig, kind: plan.kind, label: plan.label, offset: plan.offset, duration, tracks };
  return audioCache;
}

/** サビを探すための音（モノラルの 22.05 kHz。ワーカーに渡す量を減らす） */
function analysisMix(tracks: PlacedTrack[], duration: number): Promise<AudioBuffer> {
  return renderPlaced(tracks, 0, duration, { sampleRate: 22050, channels: 1 });
}

/** ワーカーに曲の音を渡す（原曲がもう渡してあればそれを使う）。ワーカーでの名前を返す */
async function loadForAnalysis(a: SongAudio): Promise<string> {
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

let inflight: { sig: string; tok: object; p: Promise<SongChorus | null> } | null = null;

/**
 * 開いている曲のサビを探す（同じ曲の音・同じ小節線なら、前の答えを使う）。曲の音が無ければ null。
 * 進み具合・答えは useChorus にも入る
 */
export function findSongChorus(opts: { force?: boolean } = {}): Promise<SongChorus | null> {
  const s = useEditor.getState();
  const plan = planAudio(s.doc, s.folder);
  if (!plan) {
    cset({ ...IDLE, status: 'error', error: tr('曲の音（原曲・BGM）がありません。原曲を入れてから使ってください', "There's no song audio (original or BGM). Add the original first") });
    return Promise.resolve(null);
  }
  const pre = `${plan.sig}@${plan.offset.toFixed(4)}`;
  const cur = useChorus.getState().found;
  if (!opts.force && cur && cur.sig.startsWith(pre + '#')) {
    // 小節線（テンポ）も同じなら前の答え
    if (cur.sig === `${pre}#${gridSig(chartGrid(s.doc, cur.audio.offset, cur.audio.duration))}`) {
      if (useChorus.getState().status !== 'ready') cset({ status: 'ready', error: null });
      return Promise.resolve(cur);
    }
  }
  if (inflight && inflight.sig === pre && !opts.force) return inflight.p;
  const tok = {};
  const mine = () => inflight?.tok === tok;
  const run = async (): Promise<SongChorus | null> => {
    cset({ status: 'loading', progress: 0, step: tr('曲の音を読み込んでいます', 'Loading the song audio'), error: null });
    try {
      const a = await songAudio();
      if (!a) throw new Error(tr('曲の音を読み込めませんでした', "Couldn't load the song audio"));
      if (mine()) cset({ progress: 0.05, step: tr('曲の音を用意しています', 'Preparing the song audio') });
      const key = await loadForAnalysis(a);
      const grid = chartGrid(useEditor.getState().doc, a.offset, a.duration);
      if (mine()) cset({ progress: 0.1, step: tr('曲を部分に分けて、サビを探しています', 'Splitting the song into sections and finding the chorus') });
      const r = await wk.chorus(key, grid, (q) => {
        if (mine()) cset({ progress: 0.1 + 0.9 * q });
      });
      const { tracks: _tracks, ...audio } = a;
      const found: SongChorus = { ...r, audio, sig: `${pre}#${gridSig(grid)}` };
      if (mine()) cset({ status: 'ready', progress: 1, step: '', found });
      return found;
    } catch (e) {
      if (mine()) cset({ status: 'error', error: (e as Error).message, step: '' });
      return null;
    } finally {
      if (mine()) inflight = null;
    }
  };
  inflight = { sig: pre, tok, p: run() };
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

/** 試聴の音（曲の音の start〜end 秒。頭に少しの余裕とフェード、終わりに余韻とフェードアウト） */
export async function renderChorusClip(range: ChorusRange, audio?: SongAudio | null): Promise<AudioBuffer> {
  const a = audio ?? (await songAudio());
  if (!a) throw new Error(tr('曲の音がありません', "There's no song audio"));
  const from = Math.max(0, range.start - PRE);
  const to = Math.min(a.duration, Math.max(range.end, range.start + 1) + TAIL);
  const sr = Math.min(48000, Math.max(22050, a.tracks[0]?.buf.sampleRate ?? 44100));
  const buf = await renderPlaced(a.tracks, from, to, { sampleRate: sr, channels: 2 });
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
 * 同じ試聴だったほかの難易度にも入れる（知らせの「元に戻す」で前に戻せる）。作ったファイルの名前と所を返す（できなければ null）。
 * quiet なら知らせを出さない
 */
export async function makeChorusPreview(range?: ChorusRange | null, opts: { quiet?: boolean } = {}): Promise<{ file: string; start: number; end: number } | null> {
  const folder = useEditor.getState().folder;
  if (!folder) {
    if (!opts.quiet) toast(tr('先に曲フォルダを開いてください', 'Open a song folder first'), 'warn');
    return null;
  }
  if (useChorus.getState().making) return null;
  cset({ making: true });
  try {
    let r = range ?? null;
    if (!r) {
      const found = await findSongChorus();
      if (!found) {
        if (!opts.quiet) toast(useChorus.getState().error ?? tr('曲の音がありません', "There's no song audio"), 'warn', 7000);
        return null;
      }
      r = defaultRange(found);
    }
    const buf = await renderChorusClip(r);
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
    if (!opts.quiet) toast(tr(`試聴を作れませんでした: ${(e as Error).message}`, `Couldn't make the preview: ${(e as Error).message}`), 'error', 8000);
    return null;
  } finally {
    cset({ making: false });
  }
}

// 別の曲を開いたら、探した答えと曲の音を捨てる（同じ曲の難易度の切り替えでは、同じ音・同じ小節線なら前の答えを使う）
useEditor.subscribe((s, prev) => {
  if (s.folder === prev.folder) return;
  audioCache = null;
  inflight = null;
  if (useChorus.getState() !== IDLE) cset(IDLE);
});
