// 表示用の書式。
import { tr } from '../i18n';
import { toMeasure } from '../dtx/base36';
import { bgaChannel, CH, drumChannel } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';

/** チャンネルの名前（スネア・HHオープン・BGM・BPM変化など） */
export function channelName(ch: number): string {
  const d = drumChannel(ch);
  if (d) return d.name;
  if (ch === CH.BGM) return 'BGM';
  if (ch === CH.BPM || ch === CH.BPM_EX) return tr('BPM変化', 'BPM change');
  if (ch === CH.FILLIN) return tr('フィルイン区間', 'Fill-in section');
  if (ch === CH.FILLIN_SOUND) return tr('フィルインの音', 'Fill-in sound');
  const b = bgaChannel(ch);
  if (b) return b.name;
  return tr(`SE（ch ${ch.toString(16).toUpperCase()}）`, `SE (ch ${ch.toString(16).toUpperCase()})`);
}

export function chipBpmLabel(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : String(Math.round(bpm * 100) / 100);
}

export function formatTime(sec: number, ms = true): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const ss = Math.floor(r);
  const mmm = Math.floor((r - ss) * 1000);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}${ms ? `.${String(mmm).padStart(3, '0')}` : ''}`;
}

/** 小節.拍.16分 の表示（例 053.2.1） */
export function formatPosition(tempo: TempoMap, beat: number): string {
  const { m } = tempo.locate(Math.max(0, beat));
  const rel = Math.max(0, beat - tempo.measureStart(m));
  const b = Math.floor(rel + 1e-6);
  const sixteenth = Math.floor((rel - b) * 4 + 1e-6);
  return `${toMeasure(m)}.${b + 1}.${sixteenth + 1}`;
}

/** DLEVEL などの表示（NX: 825 → 8.25、82 → 8.20） */
export function formatLevel(raw: string | undefined): string {
  if (!raw) return '—';
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return raw;
  if (n >= 100) return (n / 100).toFixed(2);
  return (n / 10).toFixed(2);
}

/** 「7/8」「3/4」や「0.875」を小節長（4/4 = 1）にする */
export function parseMeter(text: string): number | null {
  const t = text.trim().replace(/[／]/g, '/');
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  const v = m ? Number(m[1]) / Number(m[2]) : Number(t);
  if (!Number.isFinite(v) || v <= 0 || v > 64) return null;
  return Math.round(v * 1e6) / 1e6;
}

/** 小節長を拍子として表示（0.75 → 3/4） */
export function meterLabel(len: number): string {
  const q = len * 4;
  if (Math.abs(q - Math.round(q)) < 1e-9) return `${Math.round(q)}/4`;
  const e = len * 8;
  if (Math.abs(e - Math.round(e)) < 1e-9) return `${Math.round(e)}/8`;
  const s = len * 16;
  if (Math.abs(s - Math.round(s)) < 1e-9) return `${Math.round(s)}/16`;
  return `×${len}`;
}
