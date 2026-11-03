import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type Chip, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { buildMeasureContext, decodeMeasureCandidates, measurePrompt } from './measureGen';

let nextId = 1;
const chip = (ch: number, m: number, step: number): Chip => ({ id: nextId++, ch, m, f: frac(step, 16), v: 1 });

function song(): DtxDoc {
  const d = emptyDoc();
  d.fields = { BPM: '120' };
  for (let m = 0; m <= 20; m++) {
    if (m === 10) continue;
    for (const s of [0, 4, 8, 12]) d.chips.push(chip(CH.BD, m, s));
    for (const s of [4, 12]) d.chips.push(chip(CH.SD, m, s));
  }
  d.nextId = nextId;
  return d;
}

const base = { onsets: null, offsetSec: 0, level: null, style: [], sectionOf: () => null };

describe('buildMeasureContext', () => {
  const doc = song();
  const tempo = buildTempoMap(doc);

  it('似ている小節：離れていれば譜面ごと、前後に見えていればどれかだけ、範囲と重なれば入れない', () => {
    const ctx = buildMeasureContext(doc, tempo, {
      ...base,
      from: 10,
      to: 10,
      refs: [
        { src: 2, score: 0.7 },
        { src: 8, score: 0.5 },
        { src: 10, score: 0.9 },
      ],
    });
    expect(ctx.refs.map((r) => [r.src, r.shown, r.measures.length])).toEqual([
      [2, false, 1],
      [8, true, 0],
    ]);
    expect(ctx.measures.map((m) => m.role)).toEqual(['before', 'before', 'before', 'before', 'target', 'after', 'after', 'after', 'after']);
  });

  it('頼み方に、生成する小節・似ている小節・前後の小節が入る', () => {
    const ctx = buildMeasureContext(doc, tempo, { ...base, from: 10, to: 10, refs: [{ src: 2, score: 0.7 }, { src: 8, score: 0.5 }], instruction: 'フィルにして' });
    const p = measurePrompt(ctx);
    expect(p.system).toContain('似ている小節');
    expect(p.user).toContain('【生成 index 0】');
    expect(p.user).toContain('小節 2 → 【生成 index 0】に対応（同じ形の見込み 70%）');
    expect(p.user).toContain('小節 8 → 【生成 index 0】に対応（同じ形の見込み 50%）。下の前後の小節に出しています');
    expect(p.user).toContain('作者がもう置いているチップ: なし');
    expect(p.user).toContain('作者のひとこと: フィルにして');
    const none = measurePrompt(buildMeasureContext(doc, tempo, { ...base, from: 10, to: 10 }));
    expect(none.system).not.toContain('似ている小節」は');
    expect(none.user).not.toContain('似ている小節');
  });
});

describe('decodeMeasureCandidates', () => {
  it('格子をチップにし、範囲の外の小節は捨てる', () => {
    const doc = song();
    const tempo = buildTempoMap(doc);
    const raw = {
      candidates: [
        {
          name: '刻み',
          reason: '前と同じ',
          measures: [
            { index: 0, lanes: [{ lane: 'BD', steps: 'x---x---x---x---' }, { lane: 'HO', steps: '--x-------------' }] },
            { index: 1, lanes: [{ lane: 'SD', steps: 'x---------------' }] },
          ],
        },
      ],
    };
    const cands = decodeMeasureCandidates(raw, { from: 10, to: 10 }, tempo);
    expect(cands).toHaveLength(1);
    expect(cands[0].notes.every((n) => n.m === 10)).toBe(true);
    expect(cands[0].notes.filter((n) => n.ch === CH.BD)).toHaveLength(4);
    expect(cands[0].notes.filter((n) => n.ch === CH.HHO).map((n) => n.f.n / n.f.d)).toEqual([2 / 16]);
  });
});
