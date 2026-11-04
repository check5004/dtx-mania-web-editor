// このアプリの AI難易度生成で作った譜面の印。曲に既にある譜面（作者の譜面）と見分けるために、DTX のヘッダに書く。
//   #DTXE_ORIGIN: AI 1a2b3c4d from mstr.dtx
// - NX の表示・演奏は変わらない。NX はヘッダのコマンドを前方一致で調べ、知らないコマンドのうち5文字でないもの
//   （チップの行 #mmmcc にならないもの）は読み飛ばす（CDTX.cs の t入力_行解析・tInput_LineAnalysis_ChipLocation）。
//   DTXCreator の #DTXC_… と同じ扱い。値に「;」（NX ではコメントの始まり）は入れない
// - 8桁の16進数は、書き出したときのドラムのチップ（チャンネル・小節・位置）のハッシュ。読み込んだ譜面と違えば、
//   AI で作ったあとに手で直した譜面（作り直すときに上書きしない）
import type { Draft } from 'immer';
import { setField } from '../edit/ops';
import { frac } from './fraction';
import { drumChannel, type DtxDoc } from './model';

export const ORIGIN_KEY = 'DTXE_ORIGIN';

export type ChartOrigin = 'human' | 'ai' | 'ai-edited';

export interface OriginMark {
  edited: boolean;
  /** 作った元の譜面のファイル名 */
  from: string;
  hash: string;
}

/** ドラムのチップの並びのハッシュ（音量違いの WAV の付け替えでは変わらない） */
export function chartHash(doc: Pick<DtxDoc, 'chips'>): string {
  const keys = new Set<string>();
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    const f = frac(c.f.n, c.f.d);
    keys.add(`${c.ch.toString(16)}:${c.m}:${f.n}/${f.d}`);
  }
  // FNV-1a（32bit）
  let h = 0x811c9dc5;
  for (const k of [...keys].sort()) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 印の値（NX のコメントの「;」と改行は入れない） */
export function originValue(doc: Pick<DtxDoc, 'chips'>, from: string): string {
  const src = from.replace(/[;\r\n]/g, '_').trim();
  return `AI ${chartHash(doc)}${src ? ` from ${src}` : ''}`;
}

/** 書き出す譜面に印を付ける（ドラムのチップを決めたあとに呼ぶ） */
export function markOrigin(doc: Draft<DtxDoc> | DtxDoc, from: string): void {
  setField(doc as Draft<DtxDoc>, ORIGIN_KEY, originValue(doc, from));
}

/** 印を読む。無ければ null（作者の譜面・このアプリの前の版で作った譜面） */
export function readOrigin(doc: Pick<DtxDoc, 'chips' | 'fields'>): OriginMark | null {
  const raw = doc.fields[ORIGIN_KEY];
  if (raw === undefined) return null;
  const m = /^\s*AI\b\s*([0-9a-f]{8})?(?:\s+from\s+(.*))?$/i.exec(raw);
  if (!m) return null;
  const hash = (m[1] ?? '').toLowerCase();
  return { hash, from: (m[2] ?? '').trim(), edited: !hash || hash !== chartHash(doc) };
}

export function originOf(doc: Pick<DtxDoc, 'chips' | 'fields'>): ChartOrigin {
  const o = readOrigin(doc);
  return !o ? 'human' : o.edited ? 'ai-edited' : 'ai';
}

/** 印の文字だけで AI で作った譜面か（ファイルを全部読まずに見分ける。手直しは分からない） */
export function hasOriginLine(text: string): boolean {
  return /^\s*#\s*DTXE_ORIGIN\s*:?\s*AI\b/im.test(text);
}
