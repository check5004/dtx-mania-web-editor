// 小節・拍・秒の変換。NX の発声時刻の計算（CDTX.cs「発声時刻の計算」）と同じ考え方:
// 1小節 = 4拍 × 小節長、BPM は ch03（BASEBPM＋16進値）と ch08（BASEBPM＋#BPMzz）で変わる。
import { toBase36x2, parseNxNumber } from './base36';
import { add, cmp, div, floor, frac, fromNumber, mul, sub, toNum, type Frac } from './fraction';
import { CH, type Chip, type DtxDoc } from './model';

export const MAX_MEASURES = 3600;
const FOUR: Frac = { n: 4, d: 1 };

export interface BpmEvent {
  beat: number;
  bpm: number;
  /** この位置までの秒 */
  sec: number;
}

export interface TempoMap {
  barLen(m: number): number;
  barLenFrac(m: number): Frac;
  /** 小節の先頭の拍（曲頭=0） */
  measureStart(m: number): number;
  measureStartFrac(m: number): Frac;
  /** 小節の拍数（4×小節長） */
  measureBeats(m: number): number;
  beatOf(m: number, f: Frac): number;
  beatOfFrac(m: number, f: Frac): Frac;
  /** 拍 → 小節と小節内の位置（0以上1未満）。浮動小数で使う */
  locate(beat: number): { m: number; pos: number };
  /** 拍（分数）→ 小節と小節内の分数位置 */
  locateFrac(beat: Frac): { m: number; f: Frac };
  beatToSec(beat: number): number;
  secToBeat(sec: number): number;
  bpmAt(beat: number): number;
  events: BpmEvent[];
  initialBpm: number;
}

export function readInitialBpm(fields: Record<string, string>): number {
  const raw = fields['BPM'] ?? fields['BPM00'];
  const v = raw !== undefined ? parseNxNumber(raw) : null;
  return v !== null && v > 0 ? v : 120;
}

export function readBaseBpm(fields: Record<string, string>): number {
  const raw = fields['BASEBPM'];
  const v = raw !== undefined ? parseNxNumber(raw) : null;
  return v !== null && v > 0 ? v : 0;
}

/** BPM変更チップが表すBPM。読めなければ null */
export function chipBpm(chip: Chip, fields: Record<string, string>, base = readBaseBpm(fields)): number | null {
  if (chip.ch === CH.BPM) return base + chip.v;
  if (chip.ch === CH.BPM_EX) {
    const raw = fields['BPM' + toBase36x2(chip.v)];
    const v = raw !== undefined ? parseNxNumber(raw) : null;
    return v !== null ? base + v : null;
  }
  return null;
}

export function buildTempoMap(doc: Pick<DtxDoc, 'chips' | 'barLengths' | 'fields'>): TempoMap {
  // 小節長（変更は次の変更まで続く）
  const lenNum = new Float64Array(MAX_MEASURES);
  const lenFrac: Frac[] = new Array(MAX_MEASURES);
  const startNum = new Float64Array(MAX_MEASURES + 1);
  const startFrac: Frac[] = new Array(MAX_MEASURES + 1);
  let cur = 1;
  let curFrac: Frac = { n: 1, d: 1 };
  startFrac[0] = { n: 0, d: 1 };
  for (let m = 0; m < MAX_MEASURES; m++) {
    const bl = doc.barLengths[m];
    if (bl !== undefined && bl > 0) {
      cur = bl;
      curFrac = fromNumber(bl);
    }
    lenNum[m] = cur;
    lenFrac[m] = curFrac;
    startNum[m + 1] = startNum[m] + 4 * cur;
    startFrac[m + 1] = add(startFrac[m], mul(FOUR, curFrac));
  }
  const clampM = (m: number) => Math.max(0, Math.min(MAX_MEASURES - 1, m));

  const beatOf = (m: number, f: Frac) => startNum[m] + (f.n / f.d) * 4 * lenNum[m];
  const beatOfFrac = (m: number, f: Frac) => add(startFrac[m], mul(mul(f, FOUR), lenFrac[m]));

  const findMeasure = (beat: number) => {
    if (beat <= 0) return 0;
    let lo = 0;
    let hi = MAX_MEASURES - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (startNum[mid] <= beat + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // BPM の変化
  const initialBpm = readInitialBpm(doc.fields);
  const base = readBaseBpm(doc.fields);
  const raw: { beat: number; bpm: number; order: number }[] = [];
  doc.chips.forEach((c, i) => {
    const bpm = chipBpm(c, doc.fields, base);
    if (bpm !== null && bpm > 0) raw.push({ beat: beatOf(c.m, c.f), bpm, order: i });
  });
  raw.sort((a, b) => a.beat - b.beat || a.order - b.order);
  const events: BpmEvent[] = [{ beat: 0, bpm: initialBpm, sec: 0 }];
  for (const r of raw) {
    const last = events[events.length - 1];
    if (Math.abs(r.beat - last.beat) < 1e-9) {
      last.bpm = r.bpm;
      continue;
    }
    const sec = last.sec + ((r.beat - last.beat) * 60) / last.bpm;
    events.push({ beat: r.beat, bpm: r.bpm, sec });
  }

  const eventAtBeat = (beat: number) => {
    let lo = 0;
    let hi = events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (events[mid].beat <= beat) lo = mid;
      else hi = mid - 1;
    }
    return events[lo];
  };
  const eventAtSec = (sec: number) => {
    let lo = 0;
    let hi = events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (events[mid].sec <= sec) lo = mid;
      else hi = mid - 1;
    }
    return events[lo];
  };

  return {
    barLen: (m) => lenNum[clampM(m)],
    barLenFrac: (m) => lenFrac[clampM(m)],
    measureStart: (m) => startNum[Math.max(0, Math.min(MAX_MEASURES, m))],
    measureStartFrac: (m) => startFrac[Math.max(0, Math.min(MAX_MEASURES, m))],
    measureBeats: (m) => 4 * lenNum[clampM(m)],
    beatOf,
    beatOfFrac,
    locate(beat) {
      const m = findMeasure(beat);
      const pos = (beat - startNum[m]) / (4 * lenNum[m]);
      return { m, pos: Math.max(0, Math.min(pos, 1 - 1e-12)) };
    },
    locateFrac(beat) {
      let m = findMeasure(toNum(beat));
      // 浮動小数の誤差を分数で補正する
      while (m > 0 && cmp(beat, startFrac[m]) < 0) m--;
      while (m < MAX_MEASURES - 1 && cmp(beat, startFrac[m + 1]) >= 0) m++;
      let f = div(sub(beat, startFrac[m]), mul(FOUR, lenFrac[m]));
      if (f.n < 0) f = { n: 0, d: 1 };
      if (floor(f) >= 1) f = frac(f.d - 1, f.d);
      return { m, f };
    },
    beatToSec(beat) {
      const e = eventAtBeat(beat);
      return e.sec + ((beat - e.beat) * 60) / e.bpm;
    },
    secToBeat(sec) {
      const e = eventAtSec(sec);
      return e.beat + ((sec - e.sec) * e.bpm) / 60;
    },
    bpmAt: (beat) => eventAtBeat(beat).bpm,
    events,
    initialBpm,
  };
}
