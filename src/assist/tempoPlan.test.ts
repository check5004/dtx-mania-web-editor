import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { anchorsFromDoc, applyPlan, BGM_DIV, evaluatePlan, normalizeAnchors, planSegments } from './tempoPlan';

function docWithBgm(bpm: number): DtxDoc {
  const d = emptyDoc();
  d.fields = { BPM: String(bpm), WAV01: 'song.ogg' };
  d.chips = [{ id: 1, ch: CH.BGM, m: 0, f: frac(0), v: 1 }];
  d.nextId = 2;
  return d;
}

describe('テンポ合わせ', () => {
  it('アンカー1つ: BGMチップで1小節目の頭を合わせる', () => {
    const doc = docWithBgm(120);
    // 120BPM の1小節は2秒。原曲の0.5秒が1小節目の頭 → BGMは譜面の1.5秒（000小節の3/4）
    const r = evaluatePlan(doc, { bpm: 120, anchors: [{ m: 1, t: 0.5 }] });
    expect(r.segs).toEqual([{ m: 0, bpm: 120, src: 'base' }]);
    expect(r.bgm).not.toBeNull();
    expect(r.bgm!.m).toBe(0);
    expect(r.bgm!.n).toBe(288);
    expect(Math.abs(r.bgm!.errMs)).toBeLessThan(0.01);
    const next = produce(doc, (d) => applyPlan(d, r, null));
    const bgm = next.chips.find((c) => c.ch === CH.BGM)!;
    expect(bgm.f).toEqual(frac(3, 4));
    const t = buildTempoMap(next);
    expect(t.beatToSec(t.beatOf(bgm.m, bgm.f))).toBeCloseTo(1.5, 6);
  });

  it('BGMを置けないときはずらす小節数を返す', () => {
    const doc = docWithBgm(120);
    const r = evaluatePlan(doc, { bpm: 120, anchors: [{ m: 1, t: 5 }] });
    expect(r.bgm).toBeNull();
    expect(r.shift).toBe(2);
  });

  it('アンカーの間からBPMを計算し、小節の頭で変える', () => {
    const doc = docWithBgm(120);
    // 1→5小節（16拍）が 8秒 = 120、5→9小節（16拍）が 7.5秒 = 128
    const segs = planSegments(doc, { bpm: 100, anchors: [{ m: 1, t: 1 }, { m: 5, t: 9 }, { m: 9, t: 16.5 }] });
    expect(segs).toEqual([
      { m: 0, bpm: 120, src: 'anchor' },
      { m: 5, bpm: 128, src: 'anchor' },
    ]);
    const r = evaluatePlan(doc, { bpm: 100, anchors: [{ m: 1, t: 1 }, { m: 5, t: 9 }, { m: 9, t: 16.5 }] });
    const next = produce(doc, (d) => applyPlan(d, r, null));
    expect(next.fields.BPM).toBe('120');
    const bpmChips = next.chips.filter((c) => c.ch === CH.BPM_EX);
    expect(bpmChips).toHaveLength(1);
    expect(bpmChips[0].m).toBe(5);
    const t = buildTempoMap(next);
    const bgm = next.chips.find((c) => c.ch === CH.BGM)!;
    const off = t.beatToSec(t.beatOf(bgm.m, bgm.f));
    // どのアンカーも原曲の時刻に合う
    for (const a of [{ m: 1, t: 1 }, { m: 5, t: 9 }, { m: 9, t: 16.5 }]) {
      expect(t.beatToSec(t.measureStart(a.m)) - off).toBeCloseTo(a.t, 2);
    }
    void BGM_DIV;
  });

  it('時刻が逆のアンカーは前の方を捨てる', () => {
    expect(normalizeAnchors([{ m: 1, t: 2 }, { m: 3, t: 1 }, { m: 5, t: 6 }])).toEqual([
      { m: 3, t: 1 },
      { m: 5, t: 6 },
    ]);
  });

  it('今の譜面からアンカーを作ると、そのまま反映しても変わらない', () => {
    let doc = docWithBgm(150);
    doc = produce(doc, (d) => {
      d.fields.BPM01 = '100';
      d.chips.push({ id: 9, ch: CH.BPM_EX, m: 8, f: frac(0), v: 1 });
      d.chips[0].f = frac(1, 4);
    });
    const t = buildTempoMap(doc);
    const bgmSec = t.beatToSec(1);
    const anchors = anchorsFromDoc(t, bgmSec, 60);
    const r = evaluatePlan(doc, { bpm: 150, anchors });
    const next = produce(doc, (d) => applyPlan(d, r, null));
    const t2 = buildTempoMap(next);
    for (let m = 1; m < 20; m++) expect(t2.beatToSec(t2.measureStart(m))).toBeCloseTo(t.beatToSec(t.measureStart(m)), 3);
  });
});
