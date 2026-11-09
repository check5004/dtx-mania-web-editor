import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type Chip, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { ACT_ROWS, analysisSimilarity, readingGuide, seriesLines, type AnalysisSeries } from './analysisGrid';
import { measureLayout } from './phrase';

// BPM 120・4/4 なら1小節2秒、1拍0.5秒。100フレーム/秒
const RATE = 100;

function series(sec: number, hits: { t: number; row: string; v: number }[]): AnalysisSeries {
  const frames = Math.round(sec * RATE);
  const k = ACT_ROWS.length;
  const data = new Float32Array(frames * k);
  for (const h of hits) data[Math.round(h.t * RATE) * k + ACT_ROWS.indexOf(h.row as (typeof ACT_ROWS)[number])] = h.v;
  return { rows: ACT_ROWS, rate: RATE, frames, data };
}

/** 小節 m（2秒）に8ビート（BD 1・3拍、SD 2・4拍、HH 8分）を入れる */
function eightBeat(m: number, hh = 'HH') {
  const t0 = m * 2;
  const out: { t: number; row: string; v: number }[] = [];
  for (const b of [0, 1]) out.push({ t: t0 + b, row: 'BD', v: 1 });
  for (const b of [0.5, 1.5]) out.push({ t: t0 + b, row: 'SD', v: 0.9 });
  for (let e = 0; e < 8; e++) out.push({ t: t0 + e * 0.25, row: hh, v: 0.6 });
  return out;
}

let nextId = 1;
const chip = (ch: number, m: number, step: number): Chip => ({ id: nextId++, ch, m, f: frac(step, 16), v: 1 });

function doc120(): DtxDoc {
  const d = emptyDoc();
  d.fields = { BPM: '120' };
  return d;
}

describe('seriesLines', () => {
  const doc = doc120();
  const tempo = buildTempoMap(doc);

  it('拍ごとの格子の 0〜9 にする', () => {
    const s = series(4, [{ t: 0, row: 'BD', v: 1 }, { t: 0.5, row: 'SD', v: 0.45 }, ...[0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75].map((t) => ({ t, row: 'HH', v: 0.6 }))]);
    const lines = seriesLines(s, tempo, 0, 0, measureLayout(null, tempo, 0));
    expect(lines).toEqual(['BD: 9000|0000|0000|0000', 'SD: 0000|4000|0000|0000', 'TT: 0000|0000|0000|0000', 'HH: 5050|5050|5050|5050', 'CY: 0000|0000|0000|0000']);
  });

  it('解析した音の頭が譜面の何秒かを合わせ、音の外の小節は空', () => {
    const s = series(2, [{ t: 0, row: 'BD', v: 1 }]);
    // 音の 0 秒が譜面の 2 秒（小節 1 の頭）
    expect(seriesLines(s, tempo, 1, 2, measureLayout(null, tempo, 1))[0]).toBe('BD: 9000|0000|0000|0000');
    expect(seriesLines(s, tempo, 0, 2, measureLayout(null, tempo, 0))).toEqual([]);
    expect(seriesLines(s, tempo, 3, 0, measureLayout(null, tempo, 3))).toEqual([]);
  });
});

describe('analysisSimilarity', () => {
  it('同じ形の小節は近く、違う形は遠く、長さが違えば分からない', () => {
    const doc = doc120();
    doc.barLengths = { 3: 0.75 };
    const tempo = buildTempoMap(doc);
    const s = series(10, [...eightBeat(0), ...eightBeat(1), ...eightBeat(2, 'CY')]);
    const sim = analysisSimilarity({ act: s, spec: null, offsetSec: 0 }, tempo);
    expect(sim(0, 1)).toBeCloseTo(1, 5);
    expect(sim(0, 2)!).toBeLessThan(0.8);
    expect(sim(0, 3)).toBeNull();
  });
});

describe('readingGuide', () => {
  it('採譜の強さのマスに作者が書いたレーンの割合を数える', () => {
    const doc = doc120();
    // 小節 0・1：採譜は CY の8分。作者はライドの4分で書き、左足を足す
    for (const m of [0, 1]) {
      for (const s of [0, 4, 8, 12]) doc.chips.push(chip(CH.RD, m, s), chip(CH.LP, m, s));
      for (const s of [0, 8]) doc.chips.push(chip(CH.BD, m, s));
      for (const s of [4, 12]) doc.chips.push(chip(CH.SD, m, s));
    }
    doc.nextId = nextId;
    const tempo = buildTempoMap(doc);
    const s = series(4, [...eightBeat(0, 'CY'), ...eightBeat(1, 'CY')]);
    const guide = readingGuide(doc, tempo, s, 0, [0, 1]);
    expect(guide).toContain('採譜 BD: 強い所（5〜9）4マス: BD 100%・書いていない 0%');
    expect(guide).toContain('採譜 SD: 強い所（5〜9）4マス: SD 100%・書いていない 0%');
    expect(guide).toContain('採譜 CY: 強い所（5〜9）16マス: RD 50%・書いていない 50%');
    // 左足は採譜が 0 の裏拍には無い（4分なので CY の強い所と重なる）ので出ない
    expect(guide.some((l) => l.includes('LP'))).toBe(false);
  });

  it('手本の小節が音の外なら何も出さない', () => {
    const doc = doc120();
    doc.chips.push(chip(CH.BD, 5, 0));
    const tempo = buildTempoMap(doc);
    expect(readingGuide(doc, tempo, series(2, []), 0, [5])).toEqual([]);
  });
});
