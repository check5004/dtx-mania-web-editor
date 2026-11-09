import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type Chip, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { ACT_ROWS, type AnalysisSeries } from './analysisGrid';
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

/** BPM 120 の採譜（100フレーム/秒）。小節 5 と 10 だけシンバル、ほかはハイハットの8ビート */
function act(): AnalysisSeries {
  const rate = 100;
  const frames = 21 * 2 * rate;
  const k = ACT_ROWS.length;
  const data = new Float32Array(frames * k);
  const put = (t: number, row: string, v: number) => (data[Math.round(t * rate) * k + ACT_ROWS.indexOf(row as (typeof ACT_ROWS)[number])] = v);
  for (let m = 0; m <= 20; m++) {
    const t0 = m * 2;
    for (const b of [0, 0.5, 1, 1.5]) put(t0 + b, 'BD', 1);
    for (const b of [0.5, 1.5]) put(t0 + b, 'SD', 0.9);
    for (let e = 0; e < 8; e++) put(t0 + e * 0.25, m === 5 || m === 10 ? 'CY' : 'HH', 0.6);
  }
  return { rows: ACT_ROWS, rate, frames, data };
}

const base = { onsets: null, offsetSec: 0, level: null, style: [], sectionOf: () => null };

describe('buildMeasureContext', () => {
  const doc = song();
  const tempo = buildTempoMap(doc);

  it('手本：写す案の元とすぐ前の作者の小節。前後に見えていれば譜面は前後の小節で、範囲と重なれば入れない', () => {
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
    expect(ctx.examples.map((e) => [e.m, e.shown, e.grid.length > 0])).toEqual([
      [2, false, true],
      [8, true, false],
      [9, true, false],
    ]);
    expect(ctx.measures.map((m) => m.role)).toEqual(['before', 'before', 'before', 'before', 'target', 'after', 'after', 'after', 'after']);
  });

  it('自動で入れたまま確かめていない小節は、手本にせず譜面も見せない', () => {
    const ctx = buildMeasureContext(doc, tempo, { ...base, from: 10, to: 10, refs: [{ src: 2, score: 0.7 }], human: (m) => m !== 2 && m !== 9 });
    expect(ctx.examples.map((e) => e.m)).toEqual([8]);
    const p = measurePrompt(ctx);
    expect(p.user).toContain('小節 9 （前） 4拍\n譜面: 自動で入れたまま作者が確かめていないので省きます');
    expect(p.user).not.toContain('小節 2 →');
    // 生成する小節に自動で入れたチップがあれば、作者のものとは言わない
    const own = measurePrompt(buildMeasureContext(doc, tempo, { ...base, from: 9, to: 9, human: (m) => m !== 9 }));
    expect(own.user).toContain('いま入っているチップ（自動で入れたまま。作者は確かめていません）:\nSD: ');
    expect(measurePrompt(buildMeasureContext(doc, tempo, { ...base, from: 9, to: 9 })).user).toContain('作者がもう置いているチップ:\nSD: ');
  });

  it('分析があれば、分析の近い作者の小節を手本にし、読み方の目安を数える', () => {
    const ctx = buildMeasureContext(doc, tempo, { ...base, from: 10, to: 10, analysis: { act: act(), spec: null, offsetSec: 0 } });
    expect(ctx.examples.map((e) => [e.m, e.shown])).toEqual([
      [5, false],
      [9, true],
      [11, true],
    ]);
    expect(ctx.examples[0].sim).toBeCloseTo(1, 5);
    expect(ctx.examples[0].rows?.act[0]).toBe('BD: 9000|9000|9000|9000');
    // 分析があれば前後は2小節
    expect(ctx.measures.map((m) => m.m)).toEqual([8, 9, 10, 11, 12]);
    expect(ctx.guide[0]).toMatch(/^採譜 BD: 強い所（5〜9）\d+マス: BD 100%・書いていない 0%$/);
    const p = measurePrompt(ctx);
    expect(p.system).toContain('原曲の分析は、小節ごとに');
    expect(p.system).toContain('「採譜」');
    expect(p.user).toContain('小節 5 → 【生成】と分析の近さ 100%・5小節前\n譜面:\nSD: ');
    expect(p.user).toContain('読み方の目安（作者の小節');
    expect(p.user).toContain('小節 9 （前） 4拍 手本');
    expect(p.user).toContain('採譜:\nBD: 9000|9000|9000|9000');
  });

  it('ドラム抜きなら分析を渡さない', () => {
    const ctx = buildMeasureContext(doc, tempo, { ...base, from: 10, to: 10, analysis: { act: act(), spec: null, offsetSec: 0 }, drumless: true });
    expect(ctx.analysis).toEqual({ act: false, spec: false });
    expect(ctx.guide).toEqual([]);
    const p = measurePrompt(ctx);
    expect(p.system).toContain('ドラム抜き');
    expect(p.user).not.toContain('採譜:');
  });

  it('頼み方に、生成する小節・手本・前後の小節・ひとことが入る', () => {
    const ctx = buildMeasureContext(doc, tempo, { ...base, from: 10, to: 10, refs: [{ src: 2, score: 0.7 }, { src: 8, score: 0.5 }], instruction: 'フィルにして' });
    const p = measurePrompt(ctx);
    expect(p.system).toContain('「手本」は');
    expect(p.user).toContain('【生成 index 0】');
    expect(p.user).toContain('小節 2 → 【生成】と同じ形の見込み 70%・8小節前\n譜面:');
    expect(p.user).toContain('小節 8 → 【生成】と同じ形の見込み 50%・2小節前。下の前後の小節に出しています');
    expect(p.user).toContain('作者がもう置いているチップ: なし');
    expect(p.user).toContain('作者のひとこと: フィルにして');
    expect(p.user).toContain('小節 11 （後） 4拍\n譜面:\nSD: ');
  });
});

describe('decodeMeasureCandidates', () => {
  it('格子をチップにし、範囲の外の小節は捨てる。土台にした手本の小節を読む', () => {
    const doc = song();
    const tempo = buildTempoMap(doc);
    const raw = {
      candidates: [
        {
          name: '刻み',
          reason: '前と同じ',
          basis: 9,
          measures: [
            { index: 0, lanes: [{ lane: 'BD', steps: 'x---x---x---x---' }, { lane: 'HO', steps: '--x-------------' }] },
            { index: 1, lanes: [{ lane: 'SD', steps: 'x---------------' }] },
          ],
        },
        { name: '別', reason: '', basis: null, measures: [{ index: 0, lanes: [{ lane: 'SD', steps: 'x---------------' }] }] },
      ],
    };
    const cands = decodeMeasureCandidates(raw, { from: 10, to: 10 }, tempo);
    expect(cands).toHaveLength(2);
    expect(cands[0].notes.every((n) => n.m === 10)).toBe(true);
    expect(cands[0].notes.filter((n) => n.ch === CH.BD)).toHaveLength(4);
    expect(cands[0].notes.filter((n) => n.ch === CH.HHO).map((n) => n.f.n / n.f.d)).toEqual([2 / 16]);
    expect(cands.map((c) => c.basis)).toEqual([9, null]);
  });
});
