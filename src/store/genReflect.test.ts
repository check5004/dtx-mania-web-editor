// AI難易度生成で作った難易度を、エディタに反映する（曲フォルダに書いて set.def に載せ、難易度タブに加える）。
// 反映したか・反映のあとに変えたかを持ち、反映しないまま戻ろうとしたら聞く。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDtx } from '../dtx/encoding';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { folderFromFiles, findFile, parseSetDef, type SongFolder } from '../fs/folder';
import { DEFAULT_KEEP, simplify } from '../gen/simplify';

const dialogs = vi.hoisted(() => ({
  choose: vi.fn<() => Promise<unknown>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));
vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => dialogs.choose(),
  confirmDialog: () => dialogs.confirm(),
}));
// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0 });

const { useEditor } = await import('./editor');
const { leaveGen, reflectState, shiftRung, unreflected, useGen, writeOut } = await import('./gen');
type DiffState = import('./gen').DiffState;

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });

function master(): DtxDoc {
  const chips = [];
  let id = 1;
  for (let m = 0; m < 4; m++) {
    for (let k = 0; k < 16; k++) chips.push(chip(id++, CH.HHC, m, k, 16));
    chips.push(chip(id++, CH.BD, m, 0, 4), chip(id++, CH.SD, m, 1, 4), chip(id++, CH.BD, m, 2, 4), chip(id++, CH.SD, m, 3, 4));
  }
  chips.push(chip(id++, CH.BGM, 0, 0, 1));
  return { ...emptyDoc(), fields: { TITLE: 'テスト', BPM: '120' }, chips, nextId: id };
}

const SECTIONS = [{ name: '全体', from: 0, to: 3, shift: 0 }];

function made(doc: DtxDoc, rung: number): DiffState['result'] {
  const r = simplify({ doc, rung, sections: SECTIONS, keep: DEFAULT_KEEP });
  return { ...r, rung, ease: 0, level: 3, tries: [] };
}

async function textOf(folder: SongFolder, name: string) {
  return decodeDtx(new Uint8Array(await (await findFile(folder, name)!.getFile()).arrayBuffer())).text;
}

describe('作った難易度をエディタに反映する', () => {
  let doc: DtxDoc;
  let folder: SongFolder;
  beforeEach(() => {
    dialogs.choose.mockReset();
    dialogs.confirm.mockReset();
    doc = master();
    folder = folderFromFiles([new File(['#TITLE テスト\r\n'], 'mstr.dtx')], 'テスト');
    const g = useGen.getState();
    const src = { slot: 'MASTER' as const, file: 'mstr.dtx', doc, calib: 1, level: 7 };
    const plan = { summary: '', sections: SECTIONS };
    useGen.setState({
      master: doc,
      masterFile: 'mstr.dtx',
      masterLabel: 'MASTER',
      sourceSlot: 'MASTER',
      charts: {},
      selected: 'ADVANCED',
      listen: 'MASTER',
      diffs: {
        EXTREME: { ...g.diffs.EXTREME, enabled: false, result: null, applied: null },
        ADVANCED: { ...g.diffs.ADVANCED, enabled: true, result: made(doc, 6), plan, src, status: 'done', applied: null },
        BASIC: { ...g.diffs.BASIC, enabled: true, result: made(doc, 9), plan, src, status: 'done', applied: null },
      },
    });
    useEditor.setState({
      doc,
      folder,
      page: 'ai',
      returnPage: undefined,
      meta: { fileName: 'mstr.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [{ file: 'mstr.dtx', label: 'mstr' }] },
    });
  });

  it('作っただけでは未反映。反映すると曲フォルダに譜面と set.def が入り、難易度タブに易しい順で加わる', async () => {
    expect(unreflected()).toEqual(['ADVANCED', 'BASIC']);
    expect(reflectState(useGen.getState().diffs.ADVANCED)).toBe('pending');
    expect(reflectState(useGen.getState().diffs.EXTREME)).toBe('none');

    expect(await writeOut()).toBe(true);
    // 新しく書くファイルだけなので、上書きの確認は出ない
    expect(dialogs.confirm).not.toHaveBeenCalled();
    expect(findFile(folder, 'adv.dtx')).toBeTruthy();
    expect(findFile(folder, 'bsc.dtx')).toBeTruthy();
    const sd = parseSetDef(await textOf(folder, 'set.def'))[0];
    expect(sd.levels.map((l) => `${l.index}:${l.label}:${l.file}`)).toEqual(['1:BASIC:bsc.dtx', '2:ADVANCED:adv.dtx', '4:MASTER:mstr.dtx']);
    expect(useEditor.getState().meta.siblings.map((x) => x.label)).toEqual(['BASIC', 'ADVANCED', 'MASTER']);
    expect(unreflected()).toEqual([]);
    expect(reflectState(useGen.getState().diffs.ADVANCED)).toBe('applied');
    expect(useGen.getState().diffs.ADVANCED.applied?.file).toBe('adv.dtx');
  });

  it('反映のあとに手直しすると「反映後に変更」。もう一度反映すると、その難易度だけを確認なしで書き直す', async () => {
    await writeOut();
    const bsc = await textOf(folder, 'bsc.dtx');
    shiftRung('ADVANCED', 1);
    expect(reflectState(useGen.getState().diffs.ADVANCED)).toBe('changed');
    expect(unreflected()).toEqual(['ADVANCED']);

    expect(await writeOut()).toBe(true);
    // この画面で反映したファイルなので、上書きを聞かない
    expect(dialogs.confirm).not.toHaveBeenCalled();
    expect(reflectState(useGen.getState().diffs.ADVANCED)).toBe('applied');
    // 変えていない BASIC は書き直さない・set.def からも消えない
    expect(await textOf(folder, 'bsc.dtx')).toBe(bsc);
    const sd = parseSetDef(await textOf(folder, 'set.def'))[0];
    expect(sd.levels.map((l) => l.file)).toEqual(['bsc.dtx', 'adv.dtx', 'mstr.dtx']);
    // 全部反映したあとは、もう書かない
    expect(await writeOut()).toBe(false);
  });

  it('反映しないまま戻ろうとすると聞く：反映して戻る', async () => {
    dialogs.choose.mockResolvedValue('apply');
    expect(await leaveGen()).toBe(true);
    expect(dialogs.choose).toHaveBeenCalledTimes(1);
    expect(useEditor.getState().page).toBe('chart');
    expect(useEditor.getState().meta.siblings.map((x) => x.file)).toEqual(['bsc.dtx', 'adv.dtx', 'mstr.dtx']);
  });

  it('反映せずに戻る・やめる', async () => {
    dialogs.choose.mockResolvedValue(null);
    expect(await leaveGen()).toBe(false);
    expect(useEditor.getState().page).toBe('ai');

    dialogs.choose.mockResolvedValue('leave');
    expect(await leaveGen()).toBe(true);
    expect(useEditor.getState().page).toBe('chart');
    expect(findFile(folder, 'adv.dtx')).toBeUndefined();
    expect(unreflected()).toEqual(['ADVANCED', 'BASIC']);
  });

  it('全部反映してあれば聞かずに戻る', async () => {
    await writeOut();
    expect(await leaveGen()).toBe(true);
    expect(dialogs.choose).not.toHaveBeenCalled();
    expect(useEditor.getState().page).toBe('chart');
  });
});
