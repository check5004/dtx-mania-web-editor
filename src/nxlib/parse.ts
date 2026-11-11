// DTXMania の曲（ゲームのフォルダ）を一覧にするための、小さいファイルの読み方。読み方は DTXManiaNX（limyz/DTXmaniaNX）に合わせる。
// - 譜面は頭の行（#TITLE・#ARTIST・#BPM・#DLEVEL・#PREIMAGE・#PREVIEW など）だけ読む
// - レベルは #DLEVEL が 100 以上なら 3 桁（825 → 8.25）、2 桁なら #DLVDEC を小数の 2 桁目に（82 と 5 → 8.25）
// - 成績は譜面の横の「譜面の名前.score.ini」（NX が書く）。読むだけで書き換えない
// - Config.ini（UTF-16）の DTXPath は「;」で区切って複数。既定は「.\」（ゲームのフォルダ全体）
import { decodeDtx } from '../dtx/encoding';
import { normPath } from '../fs/folder';

/** 譜面の頭 */
export interface ChartHead {
  title: string;
  artist: string;
  bpm: string;
  /** レベル（8.25 など）。書いていなければ null */
  level: number | null;
  preimage: string;
  stagefile: string;
  preview: string;
  /** このアプリの AI難易度生成で作った印（#DTXE_ORIGIN AI） */
  ai: boolean;
}

/** 行の頭の「#キー 値」（「#キー: 値」も）。値の「;」から後は注釈 */
const LINE = /^[ \t]*#[ \t]*([A-Za-z0-9_]+)[ \t]*:?[ \t]*(.*?)[ \t]*$/;

function cutComment(v: string): string {
  const i = v.indexOf(';');
  return (i >= 0 ? v.slice(0, i) : v).trim();
}

/** 譜面の頭を読む（ファイルの最初のほうだけ渡してよい） */
export function readChartHead(text: string): ChartHead {
  const f: Record<string, string> = {};
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (!HEAD_KEYS.has(key) || key in f) continue;
    f[key] = key === 'DTXE_ORIGIN' ? m[2] : cutComment(m[2]);
  }
  return {
    title: f.TITLE ?? '',
    artist: f.ARTIST ?? '',
    bpm: f.BPM ?? '',
    level: levelOf(f.DLEVEL, f.DLVDEC),
    preimage: f.PREIMAGE ?? '',
    stagefile: f.STAGEFILE ?? '',
    preview: f.PREVIEW ?? '',
    ai: /^\s*AI\b/i.test(f.DTXE_ORIGIN ?? ''),
  };
}

const HEAD_KEYS = new Set(['TITLE', 'ARTIST', 'BPM', 'DLEVEL', 'DLVDEC', 'PREIMAGE', 'STAGEFILE', 'PREVIEW', 'DTXE_ORIGIN']);

/** 頭の読み残し（書いていない）があるか。あればファイルを全部読み直す */
export function headIncomplete(h: ChartHead): boolean {
  return !h.title || h.level === null;
}

/**
 * NX のレベル。#DLEVEL が 100 以上なら上の 2 桁が整数と小数 1 桁、下の 1 桁が小数 2 桁目（825 → 8.25）。
 * 100 より小さければ #DLVDEC（0〜9）を小数 2 桁目に（82・5 → 8.25）。書いていなければ null
 */
export function levelOf(dlevel: string | undefined, dlvdec?: string): number | null {
  const n = parseInt((dlevel ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  let lv: number;
  let dec: number;
  if (n >= 100) {
    lv = Math.floor(n / 10);
    dec = n % 10;
  } else {
    lv = n;
    const d = parseInt((dlvdec ?? '').trim(), 10);
    dec = Number.isFinite(d) ? Math.max(0, Math.min(9, d)) : 0;
  }
  return Math.round(lv * 10 + dec) / 100;
}

/** ファイルの最初のほうを文字にする（途中で切れた最後の行は捨てる。UTF-8 の文字の途中で切れて Shift_JIS と見誤らないように） */
export function decodeHead(bytes: Uint8Array, whole: boolean): string {
  let end = bytes.length;
  if (!whole) {
    const nl = bytes.lastIndexOf(0x0a);
    if (nl > 0) end = nl + 1;
  }
  return decodeDtx(end === bytes.length ? bytes : bytes.subarray(0, end)).text;
}

// ---- 成績（*.score.ini） ---------------------------------------------------------

export type Rank = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D' | 'E';

export interface ScoreRec {
  /** ドラムで遊んだ回数 */
  plays: number;
  /** いちばん良いランク（まだ無ければ null） */
  rank: Rank | null;
  /** いちばん良い達成率（%）。まだ無ければ null */
  skill: number | null;
}

const RANKS: Rank[] = ['SS', 'S', 'A', 'B', 'C', 'D', 'E'];

/** NX の成績を読む（[File] の PlayCountDrums・BestRankDrums と、[HiSkill.Drums] の PlaySkill） */
export function parseScoreIni(text: string): ScoreRec {
  let section = '';
  let plays = 0;
  let rank: Rank | null = null;
  let skill: number | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    const kv = /^([^=;]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === 'playcountdrums') plays = Math.max(0, parseInt(val, 10) || 0);
    else if (key === 'bestrankdrums') {
      const n = parseInt(val, 10);
      rank = n >= 0 && n < RANKS.length ? RANKS[n] : null;
    } else if (key === 'playskill' && section === 'hiskill.drums') {
      const v = parseFloat(val);
      skill = Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : null;
    }
  }
  if (plays === 0) return { plays, rank: null, skill: null };
  return { plays, rank, skill };
}

// ---- box.def・Config.ini -----------------------------------------------------------

/** box.def の BOX の名前（#TITLE）。無ければ '' */
export function boxTitleOf(text: string): string {
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = LINE.exec(raw);
    if (m && m[1].toUpperCase() === 'TITLE') return cutComment(m[2]);
  }
  return '';
}

/** 名前が「DTXFiles.」で始まるフォルダは BOX（名前はその後ろ）。BOX でなければ null */
export function dotBoxName(dirName: string): string | null {
  return /^dtxfiles\./i.test(dirName) ? dirName.slice(9) : null;
}

/** Config.ini の DTXPath（「;」で区切った曲の場所）。書いていなければ NX の既定の「.\」 */
export function dtxPathsOf(configText: string): string[] {
  for (const raw of configText.split(/\r\n|\r|\n/)) {
    const m = /^\s*DTXPath\s*=\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const list = m[1]
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length ? list : ['.\\'];
  }
  return ['.\\'];
}

/**
 * DTXPath の 1 つを、ゲームのフォルダからのフォルダの並びにする（「.\」は []、「.\DTXFiles\」は ['DTXFiles']）。
 * ほかのドライブ・ゲームのフォルダの外（「D:\DTX\」「..\曲」など）は null
 */
export function relDtxPath(p: string): string[] | null {
  const s = p.trim().replace(/\//g, '\\');
  if (!s || /^[A-Za-z]:/.test(s) || s.startsWith('\\')) return null;
  const parts = s.split('\\').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) return null;
  return parts;
}

// ---- 譜面の全体（点検） --------------------------------------------------------------

/** ドラムのチャンネル（11〜1C：HH・SD・BD・HT・LT・CY・FT・HHO・RD・LC・LP・LBD） */
const DRUM_LINE = /^[ \t]*#[0-9A-Za-z]{3}(1[1-9A-Ca-c])[ \t]*:[ \t]*([0-9A-Za-z_ \t]*)/gm;

/** ドラムのチップがあるか（ギター・ベースだけの譜面は false） */
export function hasDrumChips(text: string): boolean {
  DRUM_LINE.lastIndex = 0;
  for (let m = DRUM_LINE.exec(text); m; m = DRUM_LINE.exec(text)) {
    if (/[1-9A-Za-z]/.test(m[2].replace(/[ \t_]/g, ''))) return true;
  }
  return false;
}

/** 値がファイル名の命令（#WAVxx・#BMPxx・#AVIxx・#PREVIEW・#PREIMAGE・#STAGEFILE・#BACKGROUND・#RESULTIMAGE など） */
const REF_KEY =
  /^(?:(?:WAV|BMP|BMPTEX|AVI|VIDEO)[0-9A-Z]{2}|PREVIEW|PREIMAGE|PREMOVIE|STAGEFILE|BACKGROUND(?:_GR)?|BACKBMP|BANNER|WALL|MIDIFILE|SOUND_[A-Z]+|RESULT(?:IMAGE|MOVIE|SOUND)(?:_[A-Z]+)?)$/;

/** 譜面が使うファイル 1 つ。name は書いてある綴り（'/' 区切り）、keys は正規化したパス（小文字）の候補 */
export interface RefGroup {
  name: string;
  keys: string[];
}

/**
 * 譜面が使うファイル（#PATH_WAV があれば、そのフォルダの中と、そのままの両方を候補にする。どちらかあれば見つかったとする）。
 * 曲のフォルダの外（「..\」・ドライブ）を指すものは確かめられないので入れない
 */
export function chartRefGroups(text: string): RefGroup[] {
  let pathWav = '';
  const vals: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const v = cutComment(m[2]);
    if (key === 'PATH_WAV') {
      pathWav = v;
      continue;
    }
    if (REF_KEY.test(key) && /\.[A-Za-z0-9]{2,4}$/.test(v)) vals.push(v);
  }
  const outside = (k: string) => /^[a-z]:/.test(k) || k === '..' || k.startsWith('../') || k.includes('/../');
  const seen = new Set<string>();
  const out: RefGroup[] = [];
  for (const v of vals) {
    const key = normPath(v);
    if (seen.has(key) || outside(key)) continue;
    seen.add(key);
    const keys = [key];
    if (pathWav) {
      const joined = normPath(`${pathWav.replace(/\\/g, '/').replace(/\/+$/, '')}/${v}`);
      if (joined !== key && !outside(joined)) keys.push(joined);
    }
    out.push({ name: v.replace(/\\/g, '/'), keys });
  }
  return out;
}
