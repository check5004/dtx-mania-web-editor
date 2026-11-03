// テスト曲を作る。曲フォルダの譜面（正解）と音（BGM・ドラムの音）から、混ぜ方ごとの音と正解の打点を用意する。
import { CH, type DtxDoc } from '../dtx/model';
import { decodeDtx } from '../dtx/encoding';
import type { Frac } from '../dtx/fraction';
import { parseDtx } from '../dtx/parse';
import { audioFiles, dtxFiles, findFile, normPath, type SongFolder } from '../fs/folder';
import { tempoOf, wavPan, wavPath, wavVolume } from '../store/derived';
import { renderMix, type MixEvent } from './mix';
import { chartHits, truthFrom, type ChartHit, type TruthHit } from './truth';

/** 混ぜ方 */
export type MixKind = 'drums' | 'chips' | 'stem' | 'full' | 'nodrums';
export const MIX_KINDS: readonly MixKind[] = ['drums', 'chips', 'stem', 'full', 'nodrums'];

export const MIX_LABEL: Record<MixKind, string> = {
  drums: 'ドラムだけ',
  chips: '合成',
  stem: '実録音',
  full: '原曲',
  nodrums: 'ドラム無し（対照）',
};

export const MIX_NOTE: Record<MixKind, string> = {
  drums: '譜面のドラムの音だけ（BGM なし）。BGM に邪魔されないときの上限の目安',
  chips: 'BGM＋譜面のドラムの音。正解が完全に分かっているテスト曲',
  stem: 'BGM（ドラム抜き）＋曲に付いている本物のドラムの録音。原曲に近い。正解は譜面（人の耳コピ）',
  full: 'BGM がドラム入りの原曲そのものの曲。正解は譜面（人の耳コピ）',
  nodrums: 'ドラム抜きの BGM だけ（ドラムは鳴っていない）。ここで当たった分は偶然で、方式の「当てずっぽうの水準」が分かる',
};

/** 音声ファイルを [左, 右]（かモノラル）にする。読めなければ null */
export type Decoder = (bytes: ArrayBuffer) => Promise<Float32Array[] | null>;

interface Placed {
  sec: number;
  path: string;
  gain: number;
  pan: number;
}

export interface LoadedSong {
  name: string;
  /** 正解に使った譜面のファイル名 */
  chart: string;
  doc: DtxDoc;
  hits: ChartHit[];
  bgm: Placed[];
  /** 曲に付いているドラムの録音（ファイル名に drum を含む長い音） */
  stem: Placed | null;
  sr: number;
  /** パス（正規化）→ 音。読めなかったものは null */
  sounds: Map<string, Float32Array[] | null>;
  notes: string[];
}

/** フォルダの譜面のうち、ドラムのチップがいちばん多いもの（ふつうは MASTER） */
export async function pickChart(folder: SongFolder): Promise<{ name: string; doc: DtxDoc; hits: ChartHit[] } | null> {
  let best: { name: string; doc: DtxDoc; hits: ChartHit[] } | null = null;
  for (const f of dtxFiles(folder)) {
    const bytes = new Uint8Array(await (await f.getFile()).arrayBuffer());
    const { doc } = parseDtx(decodeDtx(bytes).text);
    const hits = chartHits(doc);
    if (!best || hits.length > best.hits.length) best = { name: f.name, doc, hits };
  }
  return best;
}

const STEM_NAME = /drum/i;
const STEM_MIN_SEC = 30;

export async function loadSong(folder: SongFolder, decode: Decoder, sr: number, onStep?: (msg: string) => void): Promise<LoadedSong | null> {
  const chart = await pickChart(folder);
  if (!chart) return null;
  const { doc, hits } = chart;
  const notes: string[] = [];
  const sounds = new Map<string, Float32Array[] | null>();
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const t = tempoTimes(doc);

  const load = async (path: string): Promise<Float32Array[] | null> => {
    const key = normPath(path);
    if (sounds.has(key)) return sounds.get(key)!;
    const f = findFile(folder, path, pathWav);
    let got: Float32Array[] | null = null;
    if (f) {
      try {
        got = await decode(await (await f.getFile()).arrayBuffer());
      } catch {
        got = null;
      }
    }
    sounds.set(key, got);
    return got;
  };

  // BGM（ch01）
  const bgm: Placed[] = [];
  for (const c of doc.chips) {
    if (c.ch !== CH.BGM) continue;
    const path = wavPath(doc, c.v);
    if (!path) continue;
    bgm.push({ sec: t(c.m, c.f), path, gain: wavVolume(doc, c.v) / 100, pan: wavPan(doc, c.v) / 100 });
  }
  bgm.sort((a, b) => a.sec - b.sec);
  onStep?.('BGM を読み込み中');
  for (const b of bgm) if (!(await load(b.path))) notes.push(`BGM が読めない: ${b.path}`);
  if (bgm.length === 0) notes.push('BGM（ch01）が無い');

  // ドラムの音
  onStep?.('ドラムの音を読み込み中');
  const drumWavs = new Set(hits.map((h) => h.wav));
  for (const no of drumWavs) {
    const path = wavPath(doc, no);
    if (path) await load(path);
  }

  // 曲に付いているドラムの録音
  let stem: Placed | null = null;
  const drumPaths = new Set([...drumWavs].map((no) => normPath(wavPath(doc, no) ?? '')));
  for (const f of audioFiles(folder)) {
    if (!STEM_NAME.test(f.name) || drumPaths.has(normPath(f.path))) continue;
    onStep?.('ドラムの録音を読み込み中');
    const got = await load(f.path);
    if (!got || got[0].length < STEM_MIN_SEC * sr) continue;
    // 譜面のどこかで鳴らしていればその時刻、無ければ BGM と同時に始める
    let sec = bgm[0]?.sec ?? 0;
    let gain = 1;
    let pan = 0;
    for (const c of doc.chips) {
      const p = wavPath(doc, c.v);
      if (!p || normPath(p) !== normPath(f.path)) continue;
      if (c.ch === CH.BGM || (c.ch >= 0x61 && c.ch <= 0x92)) {
        sec = t(c.m, c.f);
        gain = wavVolume(doc, c.v) / 100;
        pan = wavPan(doc, c.v) / 100;
        break;
      }
    }
    stem = { sec, path: f.path, gain, pan };
    break;
  }
  return { name: folder.name, chart: chart.name, doc, hits, bgm, stem, sr, sounds, notes };
}

function tempoTimes(doc: DtxDoc) {
  const tm = tempoOf(doc);
  return (m: number, f: Frac) => tm.beatToSec(tm.beatOf(m, f));
}

export interface TestCase {
  song: string;
  chart: string;
  mix: MixKind;
  channels: [Float32Array, Float32Array];
  sr: number;
  duration: number;
  truth: TruthHit[];
  /** 音が読めず、正解から外したチップの数 */
  dropped: number;
  notes: string[];
}

/**
 * 混ぜ方ごとのテスト曲を作る。作れない混ぜ方は理由を返す。
 * fullSong: BGM がドラム入りの原曲そのもの（指定が無ければ、DTX でふつうのドラム抜きの BGM とみなす）
 */
export function buildCase(s: LoadedSong, mix: MixKind, opts: { fullSong?: boolean } = {}): TestCase | { skip: string } {
  const snd = (path: string) => s.sounds.get(normPath(path)) ?? null;
  const events: MixEvent[] = [];
  const addPlaced = (p: Placed) => {
    const sound = snd(p.path);
    if (sound) events.push({ sec: p.sec, sound, gain: p.gain, pan: p.pan, choke: null });
  };
  let truthHits: ChartHit[] = s.hits;
  let dropped = 0;
  const notes = [...s.notes];
  if (mix === 'drums' || mix === 'chips') {
    const audible: ChartHit[] = [];
    for (const h of s.hits) {
      const path = wavPath(s.doc, h.wav);
      const sound = path ? snd(path) : null;
      if (!sound) {
        dropped++;
        continue;
      }
      audible.push(h);
      events.push({ sec: h.t, sound, gain: wavVolume(s.doc, h.wav) / 100, pan: wavPan(s.doc, h.wav) / 100, choke: h.choke });
    }
    if (audible.length < s.hits.length * 0.9) return { skip: `ドラムの音の ${dropped}/${s.hits.length} 個が読めない（.xa など）` };
    truthHits = audible;
    if (mix === 'chips') {
      if (opts.fullSong) return { skip: 'BGM がドラム入りなので、譜面の音を重ねるとドラムが二重になる' };
      if (!s.bgm.some((b) => snd(b.path))) return { skip: 'BGM が無いか読めない' };
      s.bgm.forEach(addPlaced);
    }
  } else if (mix === 'stem') {
    if (!s.stem) return { skip: 'ドラムの録音（名前に drum を含む音）が無い' };
    s.bgm.forEach(addPlaced);
    addPlaced(s.stem);
  } else {
    if (mix === 'full' && !opts.fullSong) return { skip: 'BGM がドラム入りの原曲と指定されていない' };
    if (mix === 'nodrums' && opts.fullSong) return { skip: 'BGM がドラム入り' };
    if (!s.bgm.some((b) => snd(b.path))) return { skip: 'BGM が無いか読めない' };
    s.bgm.forEach(addPlaced);
  }
  if (dropped > 0) notes.push(`音が読めないチップ ${dropped} 個を正解から外した`);
  let end = truthHits.length ? truthHits[truthHits.length - 1].t + 3 : 0;
  for (const e of events) end = Math.max(end, e.sec + e.sound[0].length / s.sr);
  const channels = renderMix(events, s.sr, end);
  return { song: s.name, chart: s.chart, mix, channels, sr: s.sr, duration: end, truth: truthFrom(truthHits), dropped, notes };
}
