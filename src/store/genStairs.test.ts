// AI難易度生成：まとめて作ったときも、1つだけ作り直したときも、手直ししたときも、
// 下の難易度は小節ごとに上の難易度より濃くしない（上の難易度に残した音だけを使い、下の難易度に残した音は残す）。
// AI の方針が難易度ごとに食い違っても（上はフィルの手前を薄く、下はフィルを薄く）逆転しないことを確かめる。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { DEFAULT_KEEP, simplify } from '../gen/simplify';
import { keptIds, matchIds, stairCheck } from '../gen/stairs';

const H = vi.hoisted(() => ({
  spans: [] as { name: string; from: number; to: number }[],
  fillSpans: new Set<number>(),
  prompts: [] as { diff: string; user: string }[],
}));

// AI の方針：EXTREME はフィルのある区間を静か（+1）に、ADVANCED は逆にその区間を山場（-1）に
vi.mock('./ai', async (orig) => ({
  ...((await orig()) as object),
  hasAiKey: () => true,
  runAi: async (_task: string, o: { user: string }) => {
    const diff = /作る難易度: (EXTREME|ADVANCED|BASIC)/.exec(o.user)![1];
    H.prompts.push({ diff, user: o.user });
    const sections = H.spans.map((s) => {
      const f = H.fillSpans.has(s.from);
      const p = { name: s.name, from: s.from, to: s.to, comment: '' };
      if (diff === 'EXTREME') return { ...p, shift: f ? 1 : 0 };
      if (diff === 'ADVANCED') return { ...p, shift: f ? -1 : 0 };
      return { ...p, shift: 0 };
    });
    return { data: { summary: '', sections }, costUsed: 0, model: 'mock', text: '', citations: [], webSearches: 0 };
  },
}));
// AI の判定は計算と同じ
vi.mock('./aiLevel', async (orig) => ({
  ...((await orig()) as object),
  judgeDoc: async (_doc: unknown, o: { mech: number }) => ({ level: o.mech, reasons: [], confidence: 'medium', hardest: '', gap: '', cost: 0, model: 'mock', nearCount: 0 }),
}));
// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0 });

const { useEditor } = await import('./editor');
const { calcLevel, generate, generateAll, initGen, stairCount, stairIssues, toggleChip, useGen } = await import('./gen');

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });

/** 16ビート 24小節。フィルは 7・23 小節だけ（8〜15 小節の区間には無い） */
function master(): DtxDoc {
  const chips = [];
  let id = 1;
  for (let m = 0; m < 24; m++) {
    const fill = m === 7 || m === 23;
    for (let k = 0; k < 16; k++) {
      if (fill && k >= 8) {
        chips.push(chip(id++, k < 10 ? CH.SD : k < 12 ? CH.HT : k < 14 ? CH.LT : CH.FT, m, k, 16));
        if (k % 4 === 0) chips.push(chip(id++, CH.BD, m, k, 16));
        continue;
      }
      if (!(k === 0 && m % 8 === 0)) chips.push(chip(id++, CH.HHC, m, k, 16));
      if (k === 0 || k === 8 || k === 10 || k === 11) chips.push(chip(id++, CH.BD, m, k, 16));
      if (k === 4 || k === 12) chips.push(chip(id++, CH.SD, m, k, 16));
      if (k === 7 || k === 14) chips.push(chip(id++, CH.SD, m, k, 16));
    }
    if (m % 8 === 0) chips.push(chip(id++, CH.CY, m, 0, 1));
  }
  return { ...emptyDoc(), fields: { TITLE: 'テスト', BPM: '150', DLEVEL: '80' }, chips, nextId: id };
}

const DIFFS = ['EXTREME', 'ADVANCED', 'BASIC'] as const;
const result = (d: (typeof DIFFS)[number]) => useGen.getState().diffs[d].result!;

/** 上の難易度に残した音だけを使い、どの小節も上より濃くない */
function expectStairs() {
  const g = useGen.getState();
  for (let i = 1; i < DIFFS.length; i++) {
    const up = result(DIFFS[i - 1]);
    const me = result(DIFFS[i]);
    const upIds = keptIds(up.fate);
    for (const id of keptIds(me.fate)) expect(upIds.has(id), `${DIFFS[i]} の音 ${id} が ${DIFFS[i - 1]} に無い`).toBe(true);
    expect(stairCheck(me.doc, up.doc).denser).toEqual([]);
  }
  for (const d of DIFFS) {
    expect(stairIssues(g, d)).toMatchObject({ denser: [], thinner: [] });
    expect(stairCount(g, d)).toBe(0);
  }
}

describe('難易度の段階', () => {
  beforeEach(async () => {
    H.prompts = [];
    const doc = master();
    useEditor.setState({ doc, page: 'ai', folder: null, meta: { ...useEditor.getState().meta, fileName: 'mstr.dtx', siblings: [] } });
    useGen.setState({ master: null });
    initGen();
    // セクションの役割は、作者の指示があるときだけ使う
    useGen.setState({ instruction: 'フィルのある所は先に易しく' });
    H.spans = useGen.getState().spans;
    H.fillSpans = new Set(H.spans.filter((s) => s.from <= 7 && s.to >= 7).map((s) => s.from));
    for (const s of H.spans) if (s.from <= 23 && s.to >= 23) H.fillSpans.add(s.from);
    await generateAll();
  });

  it('まとめて作ると、上から順に作り、下の難易度は上の難易度に残した音だけで作る', () => {
    expect(H.prompts.map((p) => p.diff)).toEqual(['EXTREME', 'ADVANCED', 'BASIC']);
    expectStairs();
    // 隣の難易度とのレベルの段もある
    const g = useGen.getState();
    expect(g.diffs.EXTREME.result!.level).toBeGreaterThan(g.diffs.ADVANCED.result!.level);
    expect(g.diffs.ADVANCED.result!.level).toBeGreaterThan(g.diffs.BASIC.result!.level);
  });

  it('難しい曲（MASTER Lv8.0）は、下の難易度も上に引っ張られて高く、作った譜面も削りすぎない', () => {
    const g = useGen.getState();
    expect(g.masterLevel).toBe(8);
    // めやすは MASTER から EXTREME 1.3・ADVANCED 1.8・BASIC 2.2 まで（比だけなら 6.8・4.8・2.96）
    expect(g.diffs.EXTREME.target.center).toBeCloseTo(6.8, 2);
    expect(g.diffs.ADVANCED.target.center).toBeCloseTo(6.2, 2);
    expect(g.diffs.BASIC.target.center).toBeCloseTo(5.8, 2);
    expect(g.diffs.BASIC.target).toMatchObject({ pulledFrom: 'MASTER' });
    // 作った譜面のレベルは幅の中（7.02・6.01・5.57 前後）。BASIC でも元の音の4割より多く残す（比だけのときは2割ほど）
    for (const d of DIFFS) {
      const t = g.diffs[d].target;
      expect(calcLevel(g.diffs[d]), d).toBeGreaterThanOrEqual(t.min - 1e-9);
      expect(calcLevel(g.diffs[d]), d).toBeLessThanOrEqual(t.max + 1e-9);
    }
    expect(result('BASIC').notesAfter / result('BASIC').notesBefore).toBeGreaterThan(0.4);
  });

  it('上の難易度が薄くした区間は、下の難易度も同じだけ薄くする（AI が逆の方針を出しても）', () => {
    const g = useGen.getState();
    const adv = g.diffs.ADVANCED.plan!.sections;
    const bsc = g.diffs.BASIC.plan!.sections;
    for (const s of adv) {
      if (H.fillSpans.has(s.from)) expect(s).toMatchObject({ shift: 1, alignedTo: 'EXTREME' });
      else expect(s.alignedTo).toBeUndefined();
    }
    for (const s of bsc) if (H.fillSpans.has(s.from)) expect(s).toMatchObject({ shift: 1, alignedTo: 'ADVANCED' });
  });

  it('AI には、作りたての上の難易度の作り方（区間ごと・フィルの前後）を渡す', () => {
    const ext = H.prompts.find((p) => p.diff === 'EXTREME')!.user;
    const adv = H.prompts.find((p) => p.diff === 'ADVANCED')!.user;
    const bsc = H.prompts.find((p) => p.diff === 'BASIC')!.user;
    // EXTREME を作るときは、まだ下の難易度を作り直していないので渡さない
    expect(ext).not.toContain('ほかの難易度の作り方');
    expect(adv).toContain('ほかの難易度の作り方');
    expect(adv).toMatch(/- 上: EXTREME（作りたて・AI の方針・Lv\d\.\d\d・全体の段 \d+）: 0〜7 \d+%（\+1 静か）/);
    expect(adv).toContain('フィルの前の小節');
    expect(bsc).toMatch(/- 上: ADVANCED（作りたて・AI の方針/);
    expect(bsc).toMatch(/- 上: EXTREME（作りたて・AI の方針/);
  });

  it('作者の指示が無ければ、AI がセクションごとに役割を付けても使わない（曲全体で同じ扱い）', async () => {
    useGen.setState({ instruction: '' });
    await generateAll();
    for (const d of DIFFS) {
      const g = useGen.getState().diffs[d];
      expect(g.plan!.sections.every((s) => s.shift === 0), d).toBe(true);
      expect(g.result!.ease, d).toBe(0);
    }
    expectStairs();
  });

  it('1つだけ作り直しても、できている上・下の難易度のあいだに収める', async () => {
    const bscBefore = keptIds(result('BASIC').fate);
    await generate('ADVANCED');
    const adv = keptIds(result('ADVANCED').fate);
    for (const id of bscBefore) expect(adv.has(id)).toBe(true);
    expectStairs();
    // EXTREME だけ作り直しても、下の難易度に残した音は残す
    await generate('EXTREME');
    expectStairs();
  });

  it('手直しで削った音は下の難易度からも削り、足した音は上の難易度にも足す。押し直すと元に戻る', () => {
    // ADVANCED と BASIC にある音を ADVANCED で削る → BASIC からも消える、EXTREME には残る
    const both = [...keptIds(result('BASIC').fate)].find((id) => keptIds(result('ADVANCED').fate).has(id))!;
    toggleChip('ADVANCED', both);
    expect(keptIds(result('ADVANCED').fate).has(both)).toBe(false);
    expect(keptIds(result('BASIC').fate).has(both)).toBe(false);
    expect(keptIds(result('EXTREME').fate).has(both)).toBe(true);
    expectStairs();
    toggleChip('ADVANCED', both);
    expect(keptIds(result('ADVANCED').fate).has(both)).toBe(true);
    expect(keptIds(result('BASIC').fate).has(both)).toBe(true);
    expectStairs();

    // どの難易度にも無い音を BASIC で足す → ADVANCED・EXTREME にも入る。押し直すとどれからも消える
    const none = [...result('BASIC').fate.keys()].find((id) => !keptIds(result('EXTREME').fate).has(id))!;
    toggleChip('BASIC', none);
    for (const d of DIFFS) expect(keptIds(result(d).fate).has(none), d).toBe(true);
    expectStairs();
    toggleChip('BASIC', none);
    for (const d of DIFFS) expect(keptIds(result(d).fate).has(none), d).toBe(false);
    expectStairs();
  });
});

describe('曲に既にある譜面を残して、あいだの難易度だけ作る', () => {
  it('作る元（既存の EXTREME）より上の譜面は AI に渡さず、残す既存の BASIC の音は残す', async () => {
    H.prompts = [];
    const doc = master();
    useEditor.setState({ doc, page: 'ai', folder: null, meta: { ...useEditor.getState().meta, fileName: 'mstr.dtx', siblings: [] } });
    useGen.setState({ master: null });
    initGen();
    H.spans = useGen.getState().spans;
    const sections = H.spans.map((x) => ({ ...x, shift: 0 }));
    // 既存の譜面は別のファイル（チップの id は別）。開いている譜面の時間の並びに写したもの
    const other = (rung: number, base: number): DtxDoc => {
      const r = simplify({ doc, rung, sections, keep: DEFAULT_KEEP }).doc;
      return { ...r, chips: r.chips.map((c) => ({ ...c, id: c.id + base })) };
    };
    const ext = other(2, 100000);
    const bsc = other(8, 200000);
    const g = useGen.getState();
    useGen.setState({
      charts: {
        EXTREME: { slot: 'EXTREME', label: 'EXTREME', file: 'ext.dtx', doc: ext, level: 6, registered: true, origin: 'human', calib: 1 },
        BASIC: { slot: 'BASIC', label: 'BASIC', file: 'bsc.dtx', doc: bsc, level: 2.6, registered: true, origin: 'human', calib: 1 },
      },
      diffs: { ...g.diffs, EXTREME: { ...g.diffs.EXTREME, enabled: false }, ADVANCED: { ...g.diffs.ADVANCED, enabled: true }, BASIC: { ...g.diffs.BASIC, enabled: false } },
    });
    await generate('ADVANCED');
    const adv = useGen.getState().diffs.ADVANCED;
    expect(adv.src?.slot).toBe('EXTREME');
    const user = H.prompts.find((p) => p.diff === 'ADVANCED')!.user;
    expect(user).toContain('- 下: BASIC（既存・作者の譜面・Lv2.60）');
    expect(user).not.toContain('- 上:');
    // 残す BASIC と同じ時刻・同じ楽器の音は、ADVANCED にも残す。どの小節も EXTREME より濃くない
    const kept = keptIds(adv.result!.fate);
    for (const id of matchIds(ext, bsc)) expect(kept.has(id)).toBe(true);
    const st = stairIssues(useGen.getState(), 'ADVANCED');
    expect(st).toMatchObject({ upper: 'EXTREME', lower: 'BASIC', denser: [] });
  });
});
