// DTXテキストの読み込み。行の解釈は NX の CDTX.cs（tRead_FromString とその下の行解析）に合わせる。
import { parseBase36x2, parseHex2, parseMeasure, parseNxNumber } from './base36';
import { frac } from './fraction';
import { takeEndMarker } from './end';
import { CH, type Chip, type DtxDoc, type HeaderLine, type ParseWarning } from './model';

export interface ParsedLine {
  /** '#' の後のコマンド（元の綴り） */
  command: string;
  /** コマンドとパラメータの区切り（': ' や ' ' など、元の文字列） */
  sep: string;
  param: string;
  comment: string | null;
}

/** '#' で始まる1行を NX と同じ規則で分解する。'#' で始まらなければ null */
export function splitCommandLine(line: string): ParsedLine | null {
  const s = line.replace(/\t/g, ' ').replace(/^ +/, '');
  if (!s.startsWith('#')) return null;
  let i = 1;
  while (i < s.length && s[i] === ' ') i++;
  const cmdStart = i;
  while (i < s.length && s[i] !== ':' && s[i] !== ' ' && s[i] !== ';') i++;
  const command = s.slice(cmdStart, i);
  const sepStart = i;
  if (s[i] === ':') i++;
  while (i < s.length && s[i] === ' ') i++;
  const sep = s.slice(sepStart, i);
  const paramStart = i;
  while (i < s.length && s[i] !== ';') i++;
  const param = s.slice(paramStart, i).trim();
  const comment = i < s.length ? s.slice(i + 1) : null;
  return { command, sep, param, comment };
}

/** コマンドがチップ配置行（#mmmcc）なら小節とチャンネルを返す */
export function chipLineTarget(command: string): { m: number; ch: number } | null {
  if (command.length !== 5) return null;
  const m = parseMeasure(command.slice(0, 3));
  if (m < 0) return null;
  const ch = parseHex2(command.slice(3, 5));
  if (ch < 0) return null;
  return { m, ch };
}

/**
 * チップ配置行のパラメータを分解する。NX と同じく '_' は無視し、36進数以外の文字があれば行ごと無効。
 * 戻り値は [位置インデックス, 総数, 値] の配列。無効なら null。
 */
export function splitChipData(ch: number, param: string): { count: number; values: number[] } | null {
  const s = param.replace(/_/g, '');
  if (!/^[0-9A-Za-z]*$/.test(s)) return null;
  const count = Math.floor(s.length / 2);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const pair = s.slice(i * 2, i * 2 + 2);
    const v = ch === CH.BPM ? parseHex2(pair) : parseBase36x2(pair);
    if (v < 0) return null;
    values.push(v);
  }
  return { count, values };
}

export interface ParseResult {
  doc: DtxDoc;
  warnings: ParseWarning[];
  /** #RANDOM/#IF の分岐がある（中身は編集できず、そのまま保存する） */
  hasRandom: boolean;
}

const startsWithCI = (s: string, prefix: string) => s.toUpperCase().startsWith(prefix);

export function parseDtx(text: string): ParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  // 末尾の改行で生まれる空要素は捨てる
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const header: HeaderLine[] = [];
  const fields: Record<string, string> = {};
  const fieldIndex = new Map<string, number>();
  const chips: Chip[] = [];
  const barLengths: Record<number, number> = {};
  const warnings: ParseWarning[] = [];
  let ifDepth = 0;
  let hasRandom = false;
  let nextId = 1;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const p = splitCommandLine(line);
    if (!p || p.command === '') {
      header.push({ kind: 'raw', text: line });
      return;
    }
    const cmd = p.command;
    // NX は #IF/#ENDIF を他のどのコマンドより先に判定する（前方一致）
    if (startsWithCI(cmd, 'IF')) {
      ifDepth++;
      hasRandom = true;
      header.push({ kind: 'raw', text: line });
      return;
    }
    if (startsWithCI(cmd, 'ENDIF')) {
      if (ifDepth > 0) ifDepth--;
      header.push({ kind: 'raw', text: line });
      return;
    }
    if (ifDepth > 0 || startsWithCI(cmd, 'RANDOM')) {
      if (startsWithCI(cmd, 'RANDOM')) hasRandom = true;
      header.push({ kind: 'raw', text: line });
      return;
    }

    const target = chipLineTarget(cmd);
    if (target) {
      if (target.ch === CH.BAR_LENGTH) {
        const v = parseNxNumber(p.param);
        if (v === null || v <= 0) {
          warnings.push({ line: lineNo, message: `小節長の値を読めません: ${p.param}` });
          header.push({ kind: 'raw', text: line });
          return;
        }
        barLengths[target.m] = v;
        return;
      }
      const data = splitChipData(target.ch, p.param);
      if (!data) {
        warnings.push({ line: lineNo, message: `チップの並びを読めません（NXでも無視される行です）: ${line.trim()}` });
        header.push({ kind: 'raw', text: line });
        return;
      }
      data.values.forEach((v, i) => {
        if (v === 0) return;
        chips.push({ id: nextId++, ch: target.ch, m: target.m, f: frac(i, data.count), v });
      });
      return;
    }

    const key = cmd.toUpperCase();
    const prev = fieldIndex.get(key);
    if (prev !== undefined) {
      // 同じコマンドが2回以上ある。NX では後のものが有効なので、前の行はそのまま残すだけにする
      const old = header[prev];
      header[prev] = { kind: 'raw', text: old.kind === 'field' ? (old.orig?.text ?? '') : '' };
      if (/^(WAV|BPM|VOLUME|PAN|SIZE|BMP|AVI)[0-9A-Z]{2}$/.test(key)) {
        warnings.push({ line: lineNo, message: `#${cmd} が再定義されています。保存すると後の定義だけが使われます` });
      }
    }
    fieldIndex.set(key, header.length);
    fields[key] = p.param;
    header.push({ kind: 'field', key, name: cmd, sep: p.sep, comment: p.comment, orig: { text: line, value: p.param } });
  });

  const doc: DtxDoc = { header, fields, chips, barLengths, nextId };
  // 曲の終わり（書き出した印を戻す。無ければ NX と同じ終わりに決める）
  takeEndMarker(doc);
  if (ifDepth > 0) warnings.push({ line: lines.length, message: '#IF に対応する #ENDIF がありません' });
  return { doc, warnings, hasRandom };
}

