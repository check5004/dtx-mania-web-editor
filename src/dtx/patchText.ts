// 読んだ DTX のテキストを、変わった所の行だけ書き換える（開いていない難易度の譜面を直すときに使う）。
// serializeDtx で全部を書き直すと、チップの行の並び・チップの行のコメント・タブなどまで変わってしまうので、
// 値の変わった定義の行・消した定義の行・足したチップ・消したチップの行だけを触り、ほかの行は1文字も変えない。
// 書き換えたテキストを読み直して after と同じにならなければ（#IF の中・小節長が変わった など）、serializeDtx(after) にする。
import { insertIndexFor } from '../edit/ops';
import { parseNxNumber, toBase36x2, toHex2, toMeasure } from './base36';
import { CH, type Chip, type DtxDoc } from './model';
import { chipLineTarget, parseDtx, splitChipData, splitCommandLine } from './parse';
import { headerLineText, lineData, packChipLines, serializeDtx } from './serialize';

interface Line {
  text: string;
  /** 行の終わりの改行（最後の行が改行で終わっていなければ ''） */
  eol: string;
}

/** 行の種類（parseDtx と同じ決め方。#IF〜#ENDIF の中・#RANDOM・読めない行は raw） */
type Info =
  | { kind: 'raw' }
  | { kind: 'field'; key: string }
  | { kind: 'chip'; m: number; ch: number; values: number[]; was: readonly number[] }
  | { kind: 'bar'; m: number };

const RAW: Info = { kind: 'raw' };
const startsWithCI = (s: string, prefix: string) => s.toUpperCase().startsWith(prefix);

function splitLines(text: string): Line[] {
  const parts = text.split(/(\r\n|\r|\n)/);
  const lines: Line[] = [];
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i], eol: parts[i + 1] ?? '' });
  const last = lines[lines.length - 1];
  if (last && last.text === '' && last.eol === '') lines.pop();
  return lines;
}

function classify(lines: readonly Line[]): Info[] {
  let ifDepth = 0;
  return lines.map(({ text }) => {
    const p = splitCommandLine(text);
    if (!p || p.command === '') return RAW;
    const cmd = p.command;
    if (startsWithCI(cmd, 'IF')) {
      ifDepth++;
      return RAW;
    }
    if (startsWithCI(cmd, 'ENDIF')) {
      if (ifDepth > 0) ifDepth--;
      return RAW;
    }
    if (ifDepth > 0 || startsWithCI(cmd, 'RANDOM')) return RAW;
    const t = chipLineTarget(cmd);
    if (t) {
      if (t.ch === CH.BAR_LENGTH) {
        const v = parseNxNumber(p.param);
        return v === null || v <= 0 ? RAW : { kind: 'bar', m: t.m };
      }
      const data = splitChipData(t.ch, p.param);
      return data ? { kind: 'chip', m: t.m, ch: t.ch, values: [...data.values], was: data.values } : RAW;
    }
    return { kind: 'field', key: cmd.toUpperCase() };
  });
}

/** '#' で始まる行の値（パラメータ）だけを value にする。前の空白・区切り・後ろの空白とコメントはそのまま */
function withValue(text: string, value: string): string {
  // splitCommandLine と同じ順に読む（タブは空白1文字と同じ扱いなので、位置はそのまま元の行に使える）
  const t = text.replace(/\t/g, ' ');
  const lead = t.length - t.replace(/^ +/, '').length;
  const s = t.slice(lead);
  let i = 1;
  while (i < s.length && s[i] === ' ') i++;
  while (i < s.length && s[i] !== ':' && s[i] !== ' ' && s[i] !== ';') i++;
  const cmdEnd = i;
  if (s[i] === ':') i++;
  while (i < s.length && s[i] === ' ') i++;
  const start = i;
  while (i < s.length && s[i] !== ';') i++;
  const raw = s.slice(start, i);
  const from = raw.trim() ? start + raw.length - raw.trimStart().length : start;
  const to = raw.trim() ? start + raw.trimEnd().length : start;
  // 区切りが無い行（#WAV01 だけ）に値を書くときは「: 」を入れる（無いとコマンドの続きになる）
  const needSep = start === cmdEnd && value !== '';
  let tail = text.slice(lead + to);
  if (needSep && tail.startsWith(';')) tail = ` ${tail}`;
  return text.slice(0, lead + from) + (needSep ? ': ' : '') + value + tail;
}

/** チップの行の、値の変わった2文字だけを書き換える（'_' や小文字はそのまま） */
function withChipValues(text: string, ch: number, values: readonly number[], was: readonly number[]): string | null {
  const p = splitCommandLine(text);
  if (!p) return null;
  const chars = [...p.param];
  const at: number[] = [];
  chars.forEach((c, i) => {
    if (c !== '_') at.push(i);
  });
  values.forEach((v, k) => {
    if (v === was[k]) return;
    const s = ch === CH.BPM ? toHex2(v) : toBase36x2(v);
    chars[at[2 * k]] = s[0];
    chars[at[2 * k + 1]] = s[1];
  });
  return withValue(text, chars.join(''));
}

const chipKey = (c: Pick<Chip, 'm' | 'ch' | 'f' | 'v'>) => `${c.m}|${c.ch}|${c.f.n}/${c.f.d}|${c.v}`;

function sameBars(a: Pick<DtxDoc, 'barLengths'>, b: Pick<DtxDoc, 'barLengths'>): boolean {
  const ka = Object.keys(a.barLengths);
  return ka.length === Object.keys(b.barLengths).length && ka.every((k) => a.barLengths[Number(k)] === b.barLengths[Number(k)]);
}

/** 定義の値・チップ・小節長・曲の終わりが同じか（行の並びやコメントは見ない） */
export function sameContent(a: DtxDoc, b: DtxDoc): boolean {
  const ka = Object.keys(a.fields);
  if (ka.length !== Object.keys(b.fields).length || ka.some((k) => a.fields[k] !== b.fields[k])) return false;
  if (!sameBars(a, b) || a.endMeasure !== b.endMeasure || a.chips.length !== b.chips.length) return false;
  const n = new Map<string, number>();
  for (const c of a.chips) n.set(chipKey(c), (n.get(chipKey(c)) ?? 0) + 1);
  for (const c of b.chips) {
    const x = n.get(chipKey(c));
    if (!x) return false;
    n.set(chipKey(c), x - 1);
  }
  return true;
}

/**
 * 行で書き換えられる変更か：ヘッダのそのまま残す行（コメント・空行など）が同じで、前からある定義の行の書き方
 * （コメントなど）を変えておらず、小節長・曲の終わりも同じ
 */
function patchable(before: DtxDoc, after: DtxDoc): boolean {
  const raw = (d: DtxDoc) => d.header.flatMap((h) => (h.kind === 'raw' ? [h.text] : []));
  const ra = raw(before);
  const rb = raw(after);
  if (ra.length !== rb.length || ra.some((t, i) => t !== rb[i])) return false;
  if (!sameBars(before, after) || before.endMeasure !== after.endMeasure) return false;
  return after.header.every((h) => h.kind !== 'field' || h.orig !== undefined || before.fields[h.key] === undefined);
}

function patchLines(lines: readonly Line[], eol: string, before: DtxDoc, after: DtxDoc): Line[] | null {
  if (!patchable(before, after)) return null;
  const info = classify(lines);
  // before.header の i 番目 → テキストの行
  const headerAt: number[] = [];
  info.forEach((x, i) => {
    if (x.kind === 'raw' || x.kind === 'field') headerAt.push(i);
  });
  if (headerAt.length !== before.header.length) return null;
  const text: (string | null)[] = lines.map((l) => l.text);
  const inserts = new Map<number, string[]>();
  const insertAfter = (i: number, t: string) => {
    const list = inserts.get(i);
    if (list) list.push(t);
    else inserts.set(i, [t]);
  };
  const atEnd: string[] = [];

  // 定義（#WAVxx など）
  for (const k of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    const a = before.fields[k];
    const b = after.fields[k];
    if (a === b) continue;
    if (b === undefined) {
      // 消した定義：その定義の行をすべて消す（前の行が残ると、読み直したときにそちらが効く）
      info.forEach((x, i) => {
        if (x.kind === 'field' && x.key === k) text[i] = null;
      });
      continue;
    }
    if (a !== undefined) {
      // 値を変えた：効いている行（同じ定義が何度もあれば最後の行）の値だけ
      let last = -1;
      info.forEach((x, i) => {
        if (x.kind === 'field' && x.key === k) last = i;
      });
      if (last < 0 || text[last] === null) return null;
      text[last] = withValue(text[last]!, b);
      continue;
    }
    // 足した定義：エディタで足すときと同じ所（#WAVxx なら最後の #WAVxx の後ろ）
    const h = after.header.find((x) => x.kind === 'field' && x.key === k);
    const idx = insertIndexFor(before.header, k);
    insertAfter(idx > 0 ? headerAt[idx - 1] : -1, (h && headerLineText(h, after.fields)) ?? `#${k}: ${b}`);
  }

  // チップ：消したチップはその行の2文字を 00 に、足したチップは小節の順になる所へ行を足す
  const diff = new Map<string, number>();
  const sample = new Map<string, Chip>();
  for (const c of before.chips) {
    diff.set(chipKey(c), (diff.get(chipKey(c)) ?? 0) + 1);
    sample.set(chipKey(c), c);
  }
  for (const c of after.chips) {
    diff.set(chipKey(c), (diff.get(chipKey(c)) ?? 0) - 1);
    sample.set(chipKey(c), c);
  }
  const touched = new Set<number>();
  const added: Chip[] = [];
  for (const [k, n] of diff) {
    const c = sample.get(k)!;
    for (let j = 0; j < -n; j++) added.push(c);
    for (let j = 0; j < n; j++) {
      let found = false;
      for (let i = info.length - 1; i >= 0 && !found; i--) {
        const x = info[i];
        if (x.kind !== 'chip' || x.m !== c.m || x.ch !== c.ch || x.values.length % c.f.d !== 0) continue;
        const slot = (c.f.n * x.values.length) / c.f.d;
        if (x.values[slot] !== c.v) continue;
        x.values[slot] = 0;
        touched.add(i);
        found = true;
      }
      if (!found) return null;
    }
  }
  for (const i of touched) {
    const x = info[i];
    if (x.kind !== 'chip') continue;
    // すべて 00 になった行は消す（コメントがあれば 00 のまま残す）
    if (x.values.every((v) => v === 0) && splitCommandLine(text[i]!)?.comment == null) text[i] = null;
    else {
      const t = withChipValues(text[i]!, x.ch, x.values, x.was);
      if (t === null) return null;
      text[i] = t;
    }
  }
  const groups = new Map<string, Chip[]>();
  for (const c of added) {
    const g = `${c.m}|${c.ch}`;
    const list = groups.get(g);
    if (list) list.push(c);
    else groups.set(g, [c]);
  }
  const order = [...groups.values()].sort((p, q) => p[0].m - q[0].m || p[0].ch - q[0].ch);
  for (const list of order) {
    const { m, ch } = list[0];
    let prev = -1;
    let first = -1;
    info.forEach((x, i) => {
      if (x.kind !== 'chip' && x.kind !== 'bar') return;
      if (first < 0) first = i;
      const xc = x.kind === 'bar' ? CH.BAR_LENGTH : x.ch;
      if (x.m < m || (x.m === m && xc <= ch)) prev = i;
    });
    for (const bucket of packChipLines(list)) {
      const line = `#${toMeasure(m)}${toHex2(ch)}: ${lineData(ch, bucket)}`;
      if (prev >= 0) insertAfter(prev, line);
      else if (first >= 0) insertAfter(first - 1, line);
      else {
        // チップの行が1つも無い：ヘッダのあとに空行を1つ置いて足す（serializeDtx と同じ形）
        if (!atEnd.length && lines.length && lines[lines.length - 1].text.trim() !== '') atEnd.push('');
        atEnd.push(line);
      }
    }
  }

  const out: Line[] = [];
  for (const t of inserts.get(-1) ?? []) out.push({ text: t, eol });
  lines.forEach((l, i) => {
    if (text[i] !== null) out.push({ text: text[i]!, eol: l.eol });
    for (const t of inserts.get(i) ?? []) out.push({ text: t, eol });
  });
  for (const t of atEnd) out.push({ text: t, eol });
  // 最後の行のほかは改行で終える。最後の行は元のまま（元が改行で終わっていなければ終えない）
  const endEol = lines.length ? lines[lines.length - 1].eol : eol;
  out.forEach((l, i) => {
    if (i < out.length - 1) l.eol ||= eol;
    else l.eol = endEol;
  });
  return out;
}

/**
 * text（before はこれを読んだもの）を、after と同じ中身になるように行だけ書き換える。
 * 変えた定義・チップの行のほかは元のまま（行の並び・改行・タブ・コメント）。行で書き換えられなければ serializeDtx(after)
 */
export function patchDtxText(text: string, before: DtxDoc, after: DtxDoc): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const lines = splitLines(bom ? text.slice(1) : text);
  const eol = lines.find((l) => l.eol)?.eol ?? '\r\n';
  const out = patchLines(lines, eol, before, after);
  if (!out) return serializeDtx(after);
  const next = bom + out.map((l) => l.text + l.eol).join('');
  return sameContent(parseDtx(next).doc, after) ? next : serializeDtx(after);
}
