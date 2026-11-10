// NX（Windows）で読めるファイル名。
// NX は譜面を Shift_JIS（CP932）で読むので、譜面に書いたファイル名に Shift_JIS で書けない文字（♡・é・絵文字・一部の漢字など）が
// あると「?」になり、その音や画像を読めない（試聴が鳴らない・BGM が鳴らない）。「〜」のように見た目の近い文字へ置き換えて書く文字も、
// 曲フォルダのファイルの名前とは別の文字になるので読めない。「;」はそこからうしろがコメントになり、前後の空白は落とされる。
// ここでは、そういう文字の無い名前（書ける名前）かを見て、書ける名前を作る（画面や状態は持たない）。
import { sjisCanWrite, sjisFriendly } from '../dtx/encoding';

/** Windows のファイル名に使えない文字と、譜面の中でコメントの始まりになる「;」・制御文字 */
const FORBIDDEN = /[\\/:*?"<>|;\u0000-\u001f\u007f]/;

/** Windows で使えない名前（拡張子の前がこれだと開けない） */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 書けない文字の、見た目が近い書ける文字（Unicode の分解でも作れないもの） */
// i18n-ignore-start 文字の置き換え表（画面の文ではない）
const SIMILAR: Record<string, string> = {
  '–': '-',
  '‐': '-',
  '‑': '-',
  '•': '・',
  '·': '・',
  ß: 'ss',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ł: 'l',
  Ł: 'L',
};
// i18n-ignore-end

/** 1文字が、そのままファイル名として譜面に書けて NX でも同じ文字に戻るか */
function charOk(ch: string): boolean {
  return !FORBIDDEN.test(ch) && sjisCanWrite(ch);
}

const allOk = (s: string) => s.length > 0 && [...s].every(charOk);

/** 書けない1文字の代わり（見た目の近い書ける文字）。無ければ null */
function substitute(ch: string): string | null {
  if (FORBIDDEN.test(ch)) return null;
  const friendly = sjisFriendly(ch);
  if (friendly && allOk(friendly)) return friendly;
  const similar = SIMILAR[ch];
  if (similar) return similar;
  // 互換文字（全角・半角の違い・丸数字の一部・合字など）
  const k = ch.normalize('NFKC');
  if (k !== ch && allOk(k)) return k;
  // アクセント付きの文字（é → e）
  const d = ch.normalize('NFD').replace(/\p{M}/gu, '');
  if (d && d !== ch && allOk(d)) return d;
  return null;
}

/** ファイル名（パスの最後の部分、またはフォルダの名前1つ）が、譜面に書いて NX で読める名前か */
export function isNxSafeName(name: string): boolean {
  if (!name || name !== name.trim() || /\.$/.test(name)) return false;
  for (const ch of name) if (!charOk(ch)) return false;
  return true;
}

/** 曲フォルダの中のパス（'/' か '\' 区切り）が、どの部分も NX で読める名前か */
export function isNxSafePath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 && parts.every(isNxSafeName);
}

/** 書けない文字を、見た目の近い文字か「_」にする（続けて書けない文字が並んだら「_」は1つ） */
function fixChars(s: string): string {
  let out = '';
  // 直前に「_」を足したか（書けない文字の代わり）
  let filler = false;
  for (const ch of s) {
    if (charOk(ch)) {
      // 代わりの「_」のすぐあとの「_」は重ねない
      if (!(ch === '_' && filler)) out += ch;
      filler = false;
      continue;
    }
    const sub = substitute(ch);
    if (sub !== null) {
      out += sub;
      filler = false;
    } else if (!filler && !out.endsWith('_')) {
      out += '_';
      filler = true;
    }
  }
  return out;
}

/**
 * NX で読めるファイル名にする（パスの最後の部分）。書けない文字は見た目の近い文字か「_」に、前後の空白と点は落とす。
 * 名前が何も残らなければ fallback にする（拡張子はそのまま）。もう読める名前なら、そのまま返す
 */
export function nxSafeName(name: string, fallback = 'audio'): string {
  if (isNxSafeName(name) && !RESERVED.test(name.replace(/\.[^.]*$/, ''))) return name;
  const dot = name.lastIndexOf('.');
  const rawExt = dot > 0 ? name.slice(dot) : '';
  let base = fixChars(dot > 0 ? name.slice(0, dot) : name)
    .replace(/^[\s.]+/u, '')
    .replace(/[\s.]+$/u, '');
  const ext = rawExt ? '.' + fixChars(rawExt.slice(1)).replace(/[\s.]/gu, '') : '';
  if (!base.replace(/[_\s]/gu, '')) base = fallback;
  if (RESERVED.test(base)) base += '_';
  return base + (ext === '.' ? '' : ext);
}

/**
 * 拡張子の無い名前の頭（分けたステムの「<頭>_drums.ogg」など）を、NX で読める文字にする。
 * 書けない文字が最後にあったときの「_」は付けない。何も残らなければ fallback
 */
export function nxSafeBase(s: string, fallback: string): string {
  let out = fixChars(s);
  if (!s.endsWith('_')) out = out.replace(/_+$/u, '');
  out = out.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '');
  return out.replace(/[_\s]/gu, '') ? out : fallback;
}

/** 曲フォルダの中のパスを、どの部分も NX で読める名前にする */
export function nxSafePath(path: string, fallback = 'audio'): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.map((p, i) => nxSafeName(p, i === parts.length - 1 ? fallback : 'folder')).join('/');
}
