// 有理数。小節内の位置や拍の位置を誤差なく扱うために使う（3連・5連もずれない）。
import { tr } from '../i18n';

export interface Frac {
  readonly n: number;
  readonly d: number;
}

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1;
}

export function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

export function frac(n: number, d = 1): Frac {
  if (d === 0) throw new RangeError(tr('分母が0', 'Zero denominator'));
  if (!Number.isInteger(n) || !Number.isInteger(d)) throw new RangeError(tr(`整数でない分数: ${n}/${d}`, `Fraction with non-integer parts: ${n}/${d}`));
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const ZERO: Frac = { n: 0, d: 1 };
export const ONE: Frac = { n: 1, d: 1 };

export const add = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Frac, b: Frac): Frac => frac(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d);
export const div = (a: Frac, b: Frac): Frac => frac(a.n * b.d, a.d * b.n);
export const cmp = (a: Frac, b: Frac): number => a.n * b.d - b.n * a.d;
export const eq = (a: Frac, b: Frac): boolean => a.n === b.n && a.d === b.d;
export const toNum = (a: Frac): number => a.n / a.d;
export const floor = (a: Frac): number => Math.floor(a.n / a.d);

/**
 * 小数を有理数に近似する（連分数展開）。
 * 小節長 0.75 → 3/4、0.875 → 7/8 のように、DTXに書かれた小数を拍子として扱うために使う。
 */
export function fromNumber(x: number, maxDen = 3840): Frac {
  if (!Number.isFinite(x)) throw new RangeError(tr(`有限でない値: ${x}`, `Not a finite value: ${x}`));
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1;
  let b = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    const r = b - a;
    if (Math.abs(x - h1 / k1) < 1e-12 || r < 1e-12) break;
    b = 1 / r;
  }
  if (k1 === 0) return frac(sign * Math.round(x), 1);
  return frac(sign * h1, k1);
}

export function fracToString(f: Frac): string {
  return f.d === 1 ? String(f.n) : `${f.n}/${f.d}`;
}
