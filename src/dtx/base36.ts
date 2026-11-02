// DTXで使う数値表記の変換。NX（FDK/CConversion.cs）と同じ解釈にそろえる。

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 1文字の36進数（小文字も可）。範囲外は -1 */
export function base36Digit(c: string): number {
  const i = B36.indexOf(c.toUpperCase());
  return i;
}

/** 2文字の36進数（00〜ZZ）。不正なら -1 */
export function parseBase36x2(s: string): number {
  if (s.length < 2) return -1;
  const a = base36Digit(s[0]);
  const b = base36Digit(s[1]);
  if (a < 0 || b < 0) return -1;
  return a * 36 + b;
}

export function toBase36x2(n: number): string {
  if (n < 0 || n >= 36 * 36) throw new RangeError(`36進数2桁にできない値: ${n}`);
  return B36[Math.floor(n / 36)] + B36[n % 36];
}

/** 2文字の16進数。不正なら -1 */
export function parseHex2(s: string): number {
  if (!/^[0-9A-Fa-f]{2}/.test(s)) return -1;
  return parseInt(s.slice(0, 2), 16);
}

export function toHex2(n: number): string {
  if (n < 0 || n > 255) throw new RangeError(`16進数2桁にできない値: ${n}`);
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/** 小節番号（3文字。先頭だけ36進数、残り2桁は10進数。000〜Z99）。不正なら -1 */
export function parseMeasure(s: string): number {
  if (s.length < 3) return -1;
  const a = base36Digit(s[0]);
  if (a < 0) return -1;
  if (!/^[0-9]{2}$/.test(s.slice(1, 3))) return -1;
  return a * 100 + parseInt(s.slice(1, 3), 10);
}

export function toMeasure(n: number): string {
  if (n < 0 || n >= 3600) throw new RangeError(`小節番号にできない値: ${n}`);
  return B36[Math.floor(n / 100)] + String(n % 100).padStart(2, '0');
}

/** 小節番号の表示用（000〜Z99） */
export const formatMeasure = toMeasure;

/**
 * NXの数値解釈（CDTX.TryParse）。小数点に '.' と ',' の両方を許し、
 * 最後に現れたものを小数点として扱う。先頭の数値部分だけを読む。
 */
export function parseNxNumber(s: string): number | null {
  const str = s.trim();
  let decimalPos = str.length;
  let end = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c >= '0' && c <= '9') { end = i + 1; continue; }
    if (c === '.' || c === ',') { decimalPos = i; end = i + 1; continue; }
    if (c === "'" || c === ' ') { end = i + 1; continue; }
    break;
  }
  let out = '';
  for (let i = 0; i < end; i++) {
    const c = str[i];
    if (c >= '0' && c <= '9') out += c;
    else if ((c === '.' || c === ',') && i === decimalPos) out += '.';
  }
  if (!/[0-9]/.test(out)) return null;
  const v = Number(out);
  return Number.isFinite(v) ? v : null;
}
