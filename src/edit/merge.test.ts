import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type Chip } from '../dtx/model';
import { applyMerge, drumChipsIn, lanesWithChanges, noteId, planMerge, type MergeOptions, type ProposedNote } from './merge';

const chip = (id: number, ch: number, m: number, n: number, d = 16): Chip => ({ id, ch, m, f: frac(n, d), v: 1 });
const note = (ch: number, m: number, n: number, d = 16): ProposedNote => ({ ch, m, f: frac(n, d) });
const opts = (o: Partial<MergeOptions> = {}): MergeOptions => ({ mode: 'add', offLanes: new Set(), rejected: new Set(), kept: new Set(), ...o });

describe('planMerge', () => {
  const existing = [chip(1, CH.BD, 5, 0), chip(2, CH.SD, 5, 4), chip(3, CH.BD, 5, 8)];
  const proposal = [note(CH.BD, 5, 0), note(CH.HHC, 5, 0), note(CH.SD, 5, 4), note(CH.HHC, 5, 2), note(CH.BD, 5, 10)];

  it('足す: いまのチップは残し、無いものだけ足す', () => {
    const p = planMerge(existing, proposal, opts());
    expect(p.same.sort()).toEqual([1, 2]);
    expect(p.keep).toEqual([3]);
    expect(p.remove).toEqual([]);
    expect(p.add.map(noteId).sort()).toEqual([note(CH.HHC, 5, 0), note(CH.HHC, 5, 2), note(CH.BD, 5, 10)].map(noteId).sort());
  });

  it('置き換え: 案に無いチップは消す。残す印のチップは残す', () => {
    expect(planMerge(existing, proposal, opts({ mode: 'replace' })).remove).toEqual([3]);
    const p = planMerge(existing, proposal, opts({ mode: 'replace', kept: new Set([3]) }));
    expect(p.remove).toEqual([]);
    expect(p.keep).toEqual([3]);
  });

  it('使わないレーンは、足しも消しもしない', () => {
    const bdLane = 5;
    const p = planMerge(existing, proposal, opts({ mode: 'replace', offLanes: new Set([bdLane]) }));
    expect(p.remove).toEqual([]);
    expect(p.add.some((n) => n.ch === CH.BD)).toBe(false);
    expect(p.skipped.filter((s) => s.why === 'lane').map((s) => noteId(s.note))).toEqual([noteId(note(CH.BD, 5, 10))]);
  });

  it('外した案のチップは入れない', () => {
    const p = planMerge(existing, proposal, opts({ rejected: new Set([noteId(note(CH.HHC, 5, 2))]) }));
    expect(p.add.map(noteId)).not.toContain(noteId(note(CH.HHC, 5, 2)));
    expect(p.skipped.map((s) => s.why)).toEqual(['rejected']);
  });

  it('同じ場所の HHクローズ⇔オープンは、足すでは作者のまま、置き換えでは入れ替える', () => {
    const ex = [chip(1, CH.HHC, 2, 0)];
    const pr = [note(CH.HHO, 2, 0)];
    const a = planMerge(ex, pr, opts());
    expect(a.add).toEqual([]);
    expect(a.keep).toEqual([1]);
    expect(a.skipped[0].why).toBe('conflict');
    const r = planMerge(ex, pr, opts({ mode: 'replace' }));
    expect(r.remove).toEqual([1]);
    expect(r.add.map((n) => n.ch)).toEqual([CH.HHO]);
  });

  it('手が3本になるときは、足すチップの方を落とす', () => {
    const ex = [chip(1, CH.SD, 1, 0), chip(2, CH.HHC, 1, 0)];
    const pr = [note(CH.CY, 1, 0), note(CH.BD, 1, 0)];
    const p = planMerge(ex, pr, opts());
    expect(p.add.map((n) => n.ch)).toEqual([CH.BD]);
    expect(p.skipped).toEqual([{ note: pr[0], why: 'playable' }]);
    expect(p.keep.sort()).toEqual([1, 2]);
  });

  it('左足は1つまで（左ペダルと左バスドラム）', () => {
    const ex = [chip(1, CH.LP, 1, 0)];
    const p = planMerge(ex, [note(CH.LBD, 1, 0)], opts());
    // 同じレーン・同じ場所なので取り合いになる
    expect(p.add).toEqual([]);
    const q = planMerge([], [note(CH.LP, 1, 0), note(CH.LBD, 1, 4), note(CH.BD, 1, 4)], opts());
    expect(q.add.length).toBe(3);
  });
});

describe('applyMerge', () => {
  it('消して足す。写した元の音があればその WAV、無ければレーンの音', () => {
    const doc = emptyDoc();
    doc.fields['WAV0A'] = 'kick.wav';
    doc.chips = [chip(1, CH.BD, 3, 0), chip(2, CH.SD, 3, 4)];
    doc.nextId = 3;
    const plan = planMerge(drumChipsIn(doc, 3, 3), [{ ch: CH.BD, m: 3, f: frac(1, 2), v: 10 }, { ch: CH.HHC, m: 3, f: frac(0), v: 99 }], opts({ mode: 'replace' }));
    const next = produce(doc, (d) => applyMerge(d, plan, () => 7));
    const got = next.chips.map((c) => `${c.ch}@${c.f.n}/${c.f.d}:${c.v}`).sort();
    expect(got).toEqual([`${CH.BD}@1/2:10`, `${CH.HHC}@0/1:7`].sort());
  });
});

describe('lanesWithChanges', () => {
  it('違いのあるレーンだけ', () => {
    const ex = [chip(1, CH.BD, 0, 0), chip(2, CH.SD, 0, 4)];
    const pr = [note(CH.BD, 0, 0), note(CH.SD, 0, 6), note(CH.HHC, 0, 0)];
    // HH=1, SD=3
    expect(lanesWithChanges(ex, pr)).toEqual([1, 3]);
  });
});
