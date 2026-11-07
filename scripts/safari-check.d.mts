// scripts/safari-check.mjs の型（src/safariRules.test.ts から読むため）
export interface SafariFinding {
  file: string;
  line: number;
  rule: string;
  msg: string;
}
export const GESTURE_OK: Record<string, string>;
export const DECODE_OK: Record<string, string>;
export const API_OK: Record<string, string>;
export const MEDIA_OK: Record<string, string>;
export function checkSource(rel: string, src: string, used?: Set<string>): SafariFinding[];
export function checkAll(targets?: string[]): SafariFinding[];
