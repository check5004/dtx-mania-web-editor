// DTXファイルの文字コード。NX は Shift_JIS（CP932）として読む。BOM付きUTF-8は .NET が自動判定して読める見込み。
import { tr } from '../i18n';

export type DtxEncoding = 'shift_jis' | 'utf-8-bom' | 'utf-8' | 'utf-16le' | 'utf-16be';

export interface DecodedText {
  text: string;
  encoding: DtxEncoding;
  /** 利用者に伝えるべき注意 */
  note?: string;
}

const utf16Note = () =>
  tr('このファイルはBOM付きUTF-16です。保存するとShift_JISで書き出します（NXはどちらも読めます）。', 'This file is UTF-16 with a BOM. Saving writes it as Shift_JIS (NX reads both).');

export function decodeDtx(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  }
  // BOM付きUTF-16（DTXCreatorAL などが書く）。.NET の StreamReader は BOM で判定するので NX も読める
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', note: utf16Note() };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', note: utf16Note() };
  }
  let ascii = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (!ascii) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return {
        text,
        encoding: 'utf-8',
        note: tr(
          'このファイルはBOMなしのUTF-8です。NXはShift_JISとして読むため、日本語が文字化けします。保存するとShift_JISに直ります。',
          'This file is UTF-8 without a BOM. NX reads it as Shift_JIS, so Japanese text would be garbled. Saving fixes it to Shift_JIS.',
        ),
      };
    } catch {
      // UTF-8 として不正 → Shift_JIS
    }
  }
  return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
}

/** Shift_JIS に無い文字のうち、見た目が同じ文字に置き換えられるもの */
// i18n-ignore-start 文字の置き換え表（画面の文ではない）
const SJIS_FRIENDLY: Record<string, string> = {
  '〜': '～', // 〜 → ～
  '—': '―', // — → ―
  '‖': '∥', // ‖ → ∥
  '−': '－', // − → －
  '¢': '￠', // ¢ → ￠
  '£': '￡', // £ → ￡
  '¬': '￢', // ¬ → ￢
  '\u00a0': ' ',
};
// i18n-ignore-end

export interface EncodedText {
  bytes: Uint8Array;
  /** Shift_JIS で表せず '?' になった文字 */
  lost: string[];
}

let sjisTable: Map<string, number> | null = null;

/**
 * Unicode → Shift_JIS（CP932）の表。ブラウザの TextDecoder('shift_jis') で全2バイト文字を一度だけ
 * 読んで逆引きを作る（変換表のライブラリを持たずに済む）。同じ文字が複数ある場合は先に出てくる方を使う。
 */
function getSjisTable(): Map<string, number> {
  if (sjisTable) return sjisTable;
  const leads: number[] = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  const pairs: number[] = [];
  const bytes: number[] = [];
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      pairs.push((lead << 8) | trail);
      bytes.push(lead, trail, 0x0a);
    }
  }
  const decoded = new TextDecoder('shift_jis').decode(Uint8Array.from(bytes)).split('\n');
  const table = new Map<string, number>();
  pairs.forEach((code, i) => {
    const ch = decoded[i];
    if (ch && ch.length === 1 && ch !== '\ufffd' && !table.has(ch)) table.set(ch, code);
  });
  // 半角カナ
  for (let b = 0xa1; b <= 0xdf; b++) table.set(String.fromCharCode(0xff61 + (b - 0xa1)), b);
  sjisTable = table;
  return table;
}

export function encodeDtx(text: string, encoding: DtxEncoding = 'shift_jis'): EncodedText {
  if (encoding !== 'shift_jis') {
    const body = new TextEncoder().encode(text);
    if (encoding === 'utf-8') return { bytes: body, lost: [] };
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return { bytes: out, lost: [] };
  }
  const normalized = text.replace(/[〜—‖−¢£¬\u00a0]/g, (c) => SJIS_FRIENDLY[c] ?? c);
  const table = getSjisTable();
  const lost = new Set<string>();
  const out: number[] = [];
  for (const ch of normalized) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const code = table.get(ch);
    if (code === undefined) {
      lost.add(ch);
      out.push(0x3f);
    } else if (code > 0xff) {
      out.push(code >> 8, code & 0xff);
    } else {
      out.push(code);
    }
  }
  return { bytes: Uint8Array.from(out), lost: [...lost] };
}
