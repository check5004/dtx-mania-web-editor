// あいだに作る（AI難易度生成）：曲にある譜面を下の難易度へ移して、空いた難易度に上下のあいだの譜面を作る。
// 移すのは set.def の段と名前だけで、譜面のファイルと DTXMania の成績（<譜面>.score.ini）はそのまま。新しい譜面は別の名前。
// 楯さんの依頼（2026-11-14）: ADVANCED 5.10・EXTREME 7.50・MASTER 8.40 で 6.5 が欲しい。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDtx } from '../dtx/encoding';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { serializeDtx } from '../dtx/serialize';
import { setField } from '../edit/ops';
import { folderFromFiles, findFile, parseSetDef, type SongFolder } from '../fs/folder';
import { insertPlan } from '../gen/insert';
import { DEFAULT_KEEP, simplify } from '../gen/simplify';

const dialogs = vi.hoisted(() => ({
  choose: vi.fn<() => Promise<unknown>>(),
  confirm: vi.fn<(o: { title: string; body: string; ok: string; danger?: boolean }) => Promise<boolean>>(),
}));
vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => dialogs.choose(),
  confirmDialog: (o: { title: string; body: string; ok: string; danger?: boolean }) => dialogs.confirm(o),
}));
// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0 });

const { useEditor } = await import('./editor');
const { applyInsertPlan, generate, initGen, insertedSlots, moveDown, offeredMove, undoableMove, undoMove, useGen, writeOut } = await import('./gen');

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });

function withFields(doc: DtxDoc, f: Record<string, string>): DtxDoc {
  const d = structuredClone(doc);
  for (const [k, v] of Object.entries(f)) setField(d, k, v);
  return d;
}

/** 16ビート 8小節（レベルは #DLEVEL で決める） */
function song(dlevel: string): DtxDoc {
  const chips = [];
  let id = 1;
  for (let m = 0; m < 8; m++) {
    for (let k = 0; k < 16; k++) chips.push(chip(id++, CH.HHC, m, k, 16));
    for (const k of [0, 6, 8, 10]) chips.push(chip(id++, CH.BD, m, k, 16));
    for (const k of [4, 12, 15]) chips.push(chip(id++, CH.SD, m, k, 16));
    if (m % 4 === 0) chips.push(chip(id++, CH.CY, m, 0, 1));
  }
  return withFields({ ...emptyDoc(), chips, nextId: id }, { TITLE: 'テスト', BPM: '150', DLEVEL: dlevel });
}

/** 下の譜面（上の譜面を間引いた形） */
function thinned(doc: DtxDoc, rung: number, dlevel: string): DtxDoc {
  const r = simplify({ doc, rung, sections: [{ name: '全体', from: 0, to: 7, shift: 0 }], keep: DEFAULT_KEEP });
  return withFields(r.doc, { DLEVEL: dlevel });
}

const file = (name: string, text: string) => new File([new TextEncoder().encode(text)], name);
const SCORE = '[File]\r\nPlayCountDrums=12\r\nBestRankDrums=2\r\n[HiSkill.Drums]\r\nPlaySkill=71.30\r\n';

async function textOf(folder: SongFolder, name: string) {
  return decodeDtx(new Uint8Array(await (await findFile(folder, name)!.getFile()).arrayBuffer())).text;
}

/** 曲を開いて AI難易度生成を開いた所（open: 開く譜面のファイル名） */
async function openSong(charts: { file: string; label: string; doc: DtxDoc }[], open: string): Promise<SongFolder> {
  const setDef = ['#TITLE テスト', ...charts.flatMap((c, i) => [`#L${['BASIC', 'ADVANCED', 'EXTREME', 'MASTER'].indexOf(c.label) + 1 || i + 1}LABEL ${c.label}`, `#L${['BASIC', 'ADVANCED', 'EXTREME', 'MASTER'].indexOf(c.label) + 1 || i + 1}FILE ${c.file}`])].join('\r\n') + '\r\n';
  const folder = folderFromFiles([...charts.map((c) => file(c.file, serializeDtx(c.doc))), file('set.def', setDef), file('adv.dtx.score.ini', SCORE)], 'テスト');
  const doc = charts.find((c) => c.file === open)!.doc;
  useEditor.setState({
    doc,
    folder,
    page: 'ai',
    returnPage: undefined,
    meta: { fileName: open, encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: charts.map((c) => ({ file: c.file, label: c.label })) },
  });
  useGen.setState({ master: null });
  await initGen();
  return folder;
}

describe('あいだに作る：譜面を下の難易度へ移す', () => {
  let folder: SongFolder;
  beforeEach(async () => {
    dialogs.choose.mockReset();
    dialogs.confirm.mockReset();
    const mas = song('840');
    const ext = thinned(mas, 4, '750');
    const adv = thinned(mas, 10, '510');
    folder = await openSong(
      [
        { file: 'adv.dtx', label: 'ADVANCED', doc: adv },
        { file: 'ext.dtx', label: 'EXTREME', doc: ext },
        { file: 'mstr.dtx', label: 'MASTER', doc: mas },
      ],
      'ext.dtx',
    );
  });

  it('EXTREME を開くと、ADVANCED を BASIC へ移せる。移すと ADVANCED が空いて、目標は BASIC と EXTREME のあいだ（難しい曲の引き上げはしない）', () => {
    const g = useGen.getState();
    expect(g.sourceSlot).toBe('EXTREME');
    expect(g.charts.ADVANCED?.file).toBe('adv.dtx');
    expect(offeredMove(g, 'ADVANCED')).toBe('BASIC');
    // 開いている譜面・MASTER は移さない
    expect(offeredMove(g, 'EXTREME')).toBeNull();
    expect(offeredMove(g, 'MASTER')).toBeNull();

    expect(moveDown('ADVANCED')).toBe(true);
    const s = useGen.getState();
    expect(s.charts.ADVANCED).toBeUndefined();
    expect(s.charts.BASIC).toMatchObject({ file: 'adv.dtx', label: 'BASIC', movedFrom: 'ADVANCED', fromLabel: 'ADVANCED', level: 5.1 });
    expect(insertedSlots(s)).toEqual(['ADVANCED']);
    expect(s.diffs.ADVANCED.enabled).toBe(true);
    expect(s.diffs.BASIC.enabled).toBe(false);
    expect(s.selected).toBe('ADVANCED');
    const t = s.diffs.ADVANCED.target;
    expect(t.min).toBeGreaterThanOrEqual(5.4 - 1e-9);
    expect(t.max).toBeLessThanOrEqual(7.2 + 1e-9);
    expect(t.pulled ?? 0).toBe(0);
    // 移した先は空いた難易度なので、続けて EXTREME→ADVANCED の案は出さない
    expect(offeredMove(s, 'BASIC')).toBeNull();
    expect(undoableMove(s)?.file).toBe('adv.dtx');
  });

  it('戻すと元の通り（空けた難易度で作った結果は消えるので聞く）', async () => {
    const before = useGen.getState();
    moveDown('ADVANCED');
    expect(await undoMove()).toBe(true);
    expect(dialogs.confirm).not.toHaveBeenCalled();
    const s = useGen.getState();
    expect(s.charts.ADVANCED).toBe(before.charts.ADVANCED);
    expect(s.charts.BASIC).toBeUndefined();
    expect(s.moves).toEqual([]);
    expect(s.diffs.ADVANCED).toEqual(before.diffs.ADVANCED);
    expect(s.diffs.BASIC).toEqual(before.diffs.BASIC);

    moveDown('ADVANCED');
    await generate('ADVANCED', { useAi: false });
    expect(useGen.getState().diffs.ADVANCED.result).toBeTruthy();
    dialogs.confirm.mockResolvedValue(false);
    expect(await undoMove()).toBe(false);
    expect(useGen.getState().charts.BASIC?.file).toBe('adv.dtx');
    dialogs.confirm.mockResolvedValue(true);
    expect(await undoMove()).toBe(true);
    expect(useGen.getState().charts.ADVANCED?.file).toBe('adv.dtx');
  });

  it('反映すると、set.def の段だけ移して（ファイルと成績はそのまま）、新しい ADVANCED は別の名前で書く', async () => {
    const advBefore = await textOf(folder, 'adv.dtx');
    moveDown('ADVANCED', { aim: 6.5 });
    expect(useGen.getState().diffs.ADVANCED.target.center).toBeCloseTo(6.5);
    await generate('ADVANCED', { useAi: false });
    dialogs.confirm.mockResolvedValue(true);
    expect(await writeOut()).toBe(true);
    // 移すことを、ファイルの名前と一緒に聞く（上書きではないので赤くしない）
    expect(dialogs.confirm).toHaveBeenCalledTimes(1);
    const o = dialogs.confirm.mock.calls[0][0];
    expect(o.title).toBe('set.def の難易度を移します');
    expect(o.body).toContain('adv.dtx（ADVANCED Lv 5.10）を BASIC に移します');
    expect(o.body).toContain('新しい ADVANCED は adv_ai.dtx に書きます');
    expect(o.danger).toBe(false);

    const sd = parseSetDef(await textOf(folder, 'set.def'))[0];
    expect(sd.levels.map((l) => `${l.index}:${l.label}:${l.file}`)).toEqual(['1:BASIC:adv.dtx', '2:ADVANCED:adv_ai.dtx', '3:EXTREME:ext.dtx', '4:MASTER:mstr.dtx']);
    expect(await textOf(folder, 'adv.dtx')).toBe(advBefore);
    expect(await textOf(folder, 'adv.dtx.score.ini')).toBe(SCORE);
    expect(findFile(folder, 'adv_ai.dtx')).toBeTruthy();
    // 書いたら、もう戻さない
    const s = useGen.getState();
    expect(s.moves.every((m) => m.written)).toBe(true);
    expect(undoableMove(s)).toBeNull();
    expect(useEditor.getState().meta.siblings.map((x) => `${x.label}:${x.file}`)).toEqual(['BASIC:adv.dtx', 'ADVANCED:adv_ai.dtx', 'EXTREME:ext.dtx', 'MASTER:mstr.dtx']);
  });

  it('反映をやめたら何も書かない（まだ戻せる）', async () => {
    moveDown('ADVANCED');
    await generate('ADVANCED', { useAi: false });
    dialogs.confirm.mockResolvedValue(false);
    expect(await writeOut()).toBe(false);
    expect(findFile(folder, 'adv_ai.dtx')).toBeUndefined();
    expect(parseSetDef(await textOf(folder, 'set.def'))[0].levels.map((l) => l.file)).toEqual(['adv.dtx', 'ext.dtx', 'mstr.dtx']);
    expect(undoableMove(useGen.getState())?.file).toBe('adv.dtx');
  });

  it('DTXMania の曲から決めたレベル 6.5 の案を当てる：ADVANCED を移して、ADVANCED のめやすを 6.5 に', async () => {
    const plan = insertPlan({ ADVANCED: 5.1, EXTREME: 7.5, MASTER: 8.4 }, 6.5);
    if (!plan.ok) throw new Error('plan');
    expect(await applyInsertPlan(plan, 6.5)).toBe(true);
    const s = useGen.getState();
    expect(s.charts.BASIC?.file).toBe('adv.dtx');
    expect(s.selected).toBe('ADVANCED');
    expect(s.diffs.ADVANCED.manual).toBe(6.5);
    expect(s.diffs.ADVANCED.target.center).toBeCloseTo(6.5);
  });
});

describe('あいだに作る：2 つ続けて移す', () => {
  it('ADVANCED 5.10・EXTREME 7.50・MASTER 9.50 で 8.5：MASTER を開いて、ADVANCED を BASIC、EXTREME を ADVANCED に移し、EXTREME に作る', async () => {
    dialogs.confirm.mockReset();
    const mas = song('950');
    const folder = await openSong(
      [
        { file: 'adv.dtx', label: 'ADVANCED', doc: thinned(mas, 10, '510') },
        { file: 'ext.dtx', label: 'EXTREME', doc: thinned(mas, 4, '750') },
        { file: 'mstr.dtx', label: 'MASTER', doc: mas },
      ],
      'mstr.dtx',
    );
    const plan = insertPlan({ ADVANCED: 5.1, EXTREME: 7.5, MASTER: 9.5 }, 8.5);
    if (!plan.ok) throw new Error('plan');
    expect(plan.source).toBe('MASTER');
    expect(await applyInsertPlan(plan, 8.5)).toBe(true);
    const s = useGen.getState();
    expect(s.charts.BASIC?.file).toBe('adv.dtx');
    expect(s.charts.ADVANCED).toMatchObject({ file: 'ext.dtx', label: 'ADVANCED', movedFrom: 'EXTREME' });
    expect(s.charts.EXTREME).toBeUndefined();
    expect(s.selected).toBe('EXTREME');
    expect(s.diffs.EXTREME.manual).toBe(8.5);

    await generate('EXTREME', { useAi: false });
    dialogs.confirm.mockResolvedValue(true);
    expect(await writeOut()).toBe(true);
    const sd = parseSetDef(await textOf(folder, 'set.def'))[0];
    expect(sd.levels.map((l) => `${l.index}:${l.label}:${l.file}`)).toEqual(['1:BASIC:adv.dtx', '2:ADVANCED:ext.dtx', '3:EXTREME:ext_ai.dtx', '4:MASTER:mstr.dtx']);
  });
});
