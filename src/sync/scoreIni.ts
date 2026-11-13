// DTXMania が譜面の隣に書く成績（<譜面>.score.ini）を、2 台の PC の分からまとめる。
// 書き方は DTXManiaNX の CScoreIni.tExport と同じ（Shift_JIS・CRLF、[File] と 9 つの節）。知らない行・節もそのまま残す。
// - [HiScore.*]：Score が大きい方の節を丸ごと。[HiSkill.*]：PlaySkill が大きい方。[LastPlay.*]：DateTime が新しい方
//   （ゴースト *.hiscore.dr.ghost などは、節を取った方から取る。pick で返す）
// - PlayCount*・ClearCount*・HistoryCount：前に合わせたときから両方で増えた分を足す（前が無ければ多い方）
// - BestRank*：いい方（小さい方。99 はまだ）。History0〜4：両方の行を日付の順に並べて新しい 5 件、回数の番号はふり直す
// - Title・Name・Hash・BGMAdjust など、そのほか：新しく書かれた方
// NX は score.ini の Hash と譜面を比べず、節の Hash も確かめない（CScoreIni.bCheckConsistency は常に true）。
import { decodeDtx, encodeDtx, type DtxEncoding } from '../dtx/encoding';

export interface IniSection {
  /** 節の名前（最初の節より前の行は ''） */
  name: string;
  lines: string[];
}

export interface Ini {
  sections: IniSection[];
  eol: string;
}

export function parseIni(text: string): Ini {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const sections: IniSection[] = [{ name: '', lines: [] }];
  for (const raw of lines) {
    const m = /^\s*\[(.+?)\]\s*$/.exec(raw);
    if (m) sections.push({ name: m[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(raw);
  }
  if (!sections[0].lines.length) sections.shift();
  return { sections, eol };
}

export function iniText(ini: Ini): string {
  const out: string[] = [];
  for (const s of ini.sections) {
    if (s.name) out.push(`[${s.name}]`);
    out.push(...s.lines);
  }
  return out.join(ini.eol) + ini.eol;
}

const KV = /^\s*([^=;\s][^=]*?)\s*=(.*)$/;

export function sectionOf(ini: Ini | null, name: string): IniSection | undefined {
  const low = name.toLowerCase();
  return ini?.sections.find((s) => s.name.toLowerCase() === low);
}

export function valueOf(s: IniSection | undefined, key: string): string | undefined {
  if (!s) return undefined;
  const low = key.toLowerCase();
  for (const l of s.lines) {
    const m = KV.exec(l);
    if (m && m[1].toLowerCase() === low) return m[2].trim();
  }
  return undefined;
}

function setValue(s: IniSection, key: string, value: string) {
  const low = key.toLowerCase();
  const i = s.lines.findIndex((l) => KV.exec(l)?.[1].toLowerCase() === low);
  const line = `${key}=${value}`;
  if (i >= 0) {
    // 元の綴りの鍵のまま
    s.lines[i] = `${KV.exec(s.lines[i])![1]}=${value}`;
    return;
  }
  // 節の終わりの空行の前に足す
  let at = s.lines.length;
  while (at > 0 && !s.lines[at - 1].trim()) at--;
  s.lines.splice(at, 0, line);
}

function int(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * NX の DateTime（DateTime.Now.ToString()。Windows の地域で書き方が変わる：「2026/11/13 21:40:12」「11/13/2026 9:40:12 PM」）を
 * 比べられる数にする。読めなければ null
 */
export function nxDateValue(v: string | undefined): number | null {
  if (!v) return null;
  let m = /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|午前|午後)?/i.exec(v); // i18n-ignore
  let y: number, mo: number, d: number;
  if (m) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else {
    m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|午前|午後)?/i.exec(v); // i18n-ignore
    if (!m) return null;
    const a = +m[1];
    const b = +m[2];
    y = +m[3];
    // 月/日（US）が多い。先が 12 をこえれば日/月
    [mo, d] = a > 12 ? [b, a] : [a, b];
  }
  let h = +m[4];
  const ampm = (m[7] ?? '').toUpperCase();
  if ((ampm === 'PM' || ampm === '午後') && h < 12) h += 12; // i18n-ignore
  if ((ampm === 'AM' || ampm === '午前') && h === 12) h = 0; // i18n-ignore
  return ((((y * 13 + mo) * 32 + d) * 24 + h) * 60 + +m[5]) * 60 + +(m[6] ?? 0);
}

const COUNTS = ['PlayCountDrums', 'PlayCountGuitars', 'PlayCountBass', 'ClearCountDrums', 'ClearCountGuitars', 'ClearCountBass'];
const RANKS = ['BestRankDrums', 'BestRankGuitar', 'BestRankBass'];
const INSTS = ['Drums', 'Guitar', 'Bass'];
const KINDS = ['HiScore', 'HiSkill', 'LastPlay'];
/** score.ini の 9 つの節（ゴーストと組になる） */
export const SCORE_SECTIONS = KINDS.flatMap((k) => INSTS.map((i) => `${k}.${i}`));

/** 両方で増えた分を足す（前が無い・減った方があるなら多い方） */
function addUp(b: number | null, l: number | null, r: number | null): number | null {
  if (l === null) return r;
  if (r === null) return l;
  if (b !== null && l >= b && r >= b) return l + r - b;
  return Math.max(l, r);
}

interface Hist {
  n: number;
  date: number;
  line: string;
}

function histOf(s: IniSection | undefined): (Hist | string)[] {
  const out: (Hist | string)[] = [];
  for (let i = 0; i < 5; i++) {
    const v = valueOf(s, `History${i}`);
    if (!v) continue;
    const m = /^(\d+)\.(\d{1,2})\/(\d{1,2})\/(\d{1,2})(.*)$/.exec(v);
    out.push(m ? { n: +m[1], date: (+m[2] * 13 + +m[3]) * 32 + +m[4], line: v } : v);
  }
  return out;
}

/** History0〜4 をまとめる（両方の行を日付の順に新しい 5 件。番号は HistoryCount から数え直す） */
function mergeHistory(l: IniSection | undefined, r: IniSection | undefined, count: number): string[] {
  const seen = new Set<string>();
  const parsed: Hist[] = [];
  const loose: string[] = [];
  for (const h of [...histOf(l), ...histOf(r)]) {
    const line = typeof h === 'string' ? h : h.line;
    if (seen.has(line)) continue;
    seen.add(line);
    if (typeof h === 'string') loose.push(h);
    else parsed.push(h);
  }
  parsed.sort((a, b) => b.date - a.date || b.n - a.n);
  const out = parsed.slice(0, 5).map((h, i) => h.line.replace(/^\d+/, String(Math.max(1, count - i))));
  for (const x of loose) if (out.length < 5) out.push(x);
  return out;
}

export interface ScoreSide {
  text: string;
  /** ファイルの更新時刻（ミリ秒。どちらが新しく書かれたか） */
  time: number;
}

export type Side = 'local' | 'remote';

export interface ScoreMerge {
  text: string;
  /** 節の名前（小文字）→ どちらの節を取ったか（ゴーストもその方から取る） */
  pick: Record<string, Side>;
}

/** 2 台の PC の score.ini をまとめる。base は前に合わせたときの中身（無ければ初めての同期） */
export function mergeScoreIni(base: string | null, local: ScoreSide, remote: ScoreSide): ScoreMerge {
  const L = parseIni(local.text);
  const R = parseIni(remote.text);
  const B = base !== null ? parseIni(base) : null;
  const newer: Side = local.time > remote.time ? 'local' : 'remote';
  const N = newer === 'local' ? L : R;
  const O = newer === 'local' ? R : L;
  const pick: Record<string, Side> = {};
  const out: Ini = { sections: [], eol: N.eol };
  const names: string[] = [];
  for (const s of [...N.sections, ...O.sections]) if (!names.some((n) => n.toLowerCase() === s.name.toLowerCase())) names.push(s.name);
  for (const name of names) {
    const low = name.toLowerCase();
    const ls = sectionOf(L, name);
    const rs = sectionOf(R, name);
    if (low === 'file') {
      const f: IniSection = { name: (sectionOf(N, name) ?? sectionOf(O, name))!.name, lines: [...(sectionOf(N, name) ?? sectionOf(O, name))!.lines] };
      const bs = sectionOf(B, name);
      for (const k of COUNTS) {
        const v = addUp(int(valueOf(bs, k)), int(valueOf(ls, k)), int(valueOf(rs, k)));
        if (v !== null) setValue(f, k, String(v));
      }
      for (const k of RANKS) {
        const a = int(valueOf(ls, k));
        const b = int(valueOf(rs, k));
        if (a === null && b === null) continue;
        setValue(f, k, String(Math.min(a ?? 99, b ?? 99)));
      }
      const hc = addUp(int(valueOf(bs, 'HistoryCount')), int(valueOf(ls, 'HistoryCount')), int(valueOf(rs, 'HistoryCount')));
      if (hc !== null) {
        setValue(f, 'HistoryCount', String(hc));
        const hist = mergeHistory(ls, rs, hc);
        for (let i = 0; i < 5; i++) if (hist[i] !== undefined || valueOf(f, `History${i}`) !== undefined) setValue(f, `History${i}`, hist[i] ?? '');
      }
      out.sections.push(f);
      continue;
    }
    const kind = KINDS.find((k) => low.startsWith(`${k.toLowerCase()}.`));
    let side: Side;
    if (!ls || !rs) side = ls ? 'local' : 'remote';
    else if (kind === 'HiScore') side = cmp(int(valueOf(ls, 'Score')), int(valueOf(rs, 'Score')), newer);
    else if (kind === 'HiSkill') side = cmp(num(valueOf(ls, 'PlaySkill')), num(valueOf(rs, 'PlaySkill')), newer);
    else if (kind === 'LastPlay') side = cmp(nxDateValue(valueOf(ls, 'DateTime')), nxDateValue(valueOf(rs, 'DateTime')), newer);
    else side = newer;
    if (kind) pick[low] = side;
    const s = (side === 'local' ? ls : rs)!;
    out.sections.push({ name: s.name, lines: [...s.lines] });
  }
  return { text: iniText(out), pick };
}

/** 大きい方。同じ・比べられないなら新しく書かれた方 */
function cmp(l: number | null, r: number | null, newer: Side): Side {
  if (l !== null && r !== null && l !== r) return l > r ? 'local' : 'remote';
  if (l !== null && r === null) return 'local';
  if (r !== null && l === null) return 'remote';
  return newer;
}

/** score.ini を読む（NX は Shift_JIS で書く） */
export function decodeScore(bytes: Uint8Array): { text: string; encoding: DtxEncoding } {
  const d = decodeDtx(bytes);
  return { text: d.text, encoding: d.encoding };
}

export function encodeScore(text: string, encoding: DtxEncoding): Uint8Array {
  return encodeDtx(text, encoding).bytes;
}

/** 記録に出す、ドラムの遊んだ回数といい記録（まとめたときに「MASTER +3 回」と出す） */
export function drumSummary(text: string): { plays: number; rank: number | null; skill: number | null } {
  const ini = parseIni(text);
  const f = sectionOf(ini, 'File');
  const rank = int(valueOf(f, 'BestRankDrums'));
  return { plays: int(valueOf(f, 'PlayCountDrums')) ?? 0, rank: rank !== null && rank < 99 ? rank : null, skill: num(valueOf(sectionOf(ini, 'HiSkill.Drums'), 'PlaySkill')) };
}
