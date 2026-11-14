import { beforeEach, describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { DEFAULT_KEEP, simplify } from '../gen/simplify';
import { useEditor } from './editor';
import {
  belowSource,
  columnKind,
  compareColumns,
  genShow,
  heardGenDoc,
  knownLevels,
  listenChoices,
  recomputeTargets,
  selectDiff,
  setEnabled,
  setListen,
  sourceFor,
  stepListen,
  useGen,
  type DiffState,
  type ExistingChart,
} from './gen';

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });

function master(): DtxDoc {
  const chips = [];
  let id = 1;
  for (let m = 0; m < 4; m++) {
    for (let k = 0; k < 16; k++) chips.push(chip(id++, CH.HHC, m, k, 16));
    chips.push(chip(id++, CH.BD, m, 0, 4), chip(id++, CH.SD, m, 1, 4), chip(id++, CH.BD, m, 2, 4), chip(id++, CH.SD, m, 3, 4));
  }
  chips.push(chip(id++, CH.BGM, 0, 0, 1));
  return { ...emptyDoc(), fields: { BPM: '120' }, chips, nextId: id };
}

function made(doc: DtxDoc, rung: number): DiffState['result'] {
  const r = simplify({ doc, rung, sections: [{ name: '全体', from: 0, to: 3, shift: 0 }], keep: DEFAULT_KEEP });
  return { ...r, rung, ease: 0, level: 3, tries: [] };
}

describe('並べて聴く：聴く譜面の切り替え', () => {
  let doc: DtxDoc;
  beforeEach(() => {
    doc = master();
    const g = useGen.getState();
    useGen.setState({
      master: doc,
      selected: 'ADVANCED',
      listen: 'MASTER',
      diffs: {
        EXTREME: { ...g.diffs.EXTREME, result: null },
        ADVANCED: { ...g.diffs.ADVANCED, result: made(doc, 6) },
        BASIC: { ...g.diffs.BASIC, result: made(doc, 9) },
      },
    });
    useEditor.setState({ doc, page: 'ai' });
  });

  it('聴けるのは元の譜面と作った難易度だけ（並べた順）', () => {
    expect(listenChoices()).toEqual(['MASTER', 'ADVANCED', 'BASIC']);
    setListen('EXTREME');
    expect(useGen.getState().listen).toBe('MASTER');
  });

  it('←→ で隣の列へ。作った難易度を聴くと右の判定もその難易度になる', () => {
    stepListen(1);
    expect(useGen.getState().listen).toBe('ADVANCED');
    stepListen(1);
    expect(useGen.getState()).toMatchObject({ listen: 'BASIC', selected: 'BASIC' });
    stepListen(1);
    expect(useGen.getState().listen).toBe('BASIC');
    stepListen(-1);
    stepListen(-1);
    // 元の譜面を聴いても、右の判定は直前の難易度のまま
    expect(useGen.getState()).toMatchObject({ listen: 'MASTER', selected: 'ADVANCED' });
  });

  it('まだ作っていない難易度を選んでも、聴く譜面は変えない', () => {
    selectDiff('EXTREME');
    expect(useGen.getState()).toMatchObject({ listen: 'MASTER', selected: 'EXTREME' });
    selectDiff('BASIC');
    expect(useGen.getState()).toMatchObject({ listen: 'BASIC', selected: 'BASIC' });
  });

  it('この画面では聴く難易度の譜面を鳴らす（原曲などのチップは同じ・ドラムは減る）', () => {
    expect(heardGenDoc(doc)).toBe(doc);
    setListen('BASIC');
    const heard = heardGenDoc(doc);
    expect(heard).toBe(useGen.getState().diffs.BASIC.result!.doc);
    const drums = (d: DtxDoc) => d.chips.filter((c) => c.ch !== CH.BGM).length;
    expect(drums(heard)).toBeLessThan(drums(doc));
    expect(heard.chips.filter((c) => c.ch === CH.BGM)).toHaveLength(1);
    // ほかの画面・別の譜面では変えない
    expect(heardGenDoc(master())).not.toBe(heard);
    useEditor.setState({ page: 'chart' });
    expect(heardGenDoc(doc)).toBe(doc);
  });

  it('表示を ▶ の所へ動かす（下から少し上）', () => {
    genShow(16);
    expect(useGen.getState().view.scrollBeat).toBe(14);
    genShow(0);
    expect(useGen.getState().view.scrollBeat).toBe(-0.5);
  });
});

describe('曲に既にある難易度', () => {
  let doc: DtxDoc;
  let ext: DtxDoc;
  const chart = (slot: ExistingChart['slot'], d: DtxDoc, level: number): ExistingChart => ({ slot, label: slot, file: `${slot.toLowerCase()}.dtx`, doc: d, level, registered: true, origin: 'human', calc: level });
  const diff = (d: DiffState['diff'], enabled: boolean): DiffState => ({ ...useGen.getState().diffs[d], enabled, result: null, src: null, manual: null });
  beforeEach(() => {
    doc = master();
    ext = made(doc, 2)!.doc;
    useGen.setState({
      master: doc,
      masterFile: 'mstr.dtx',
      masterLabel: 'MASTER',
      masterLevel: 7,
      masterCalc: 7,
      sourceSlot: 'MASTER',
      spans: [{ name: 'A', from: 0, to: 3 }],
      charts: { EXTREME: chart('EXTREME', ext, 6) },
      diffs: { EXTREME: diff('EXTREME', false), ADVANCED: diff('ADVANCED', true), BASIC: diff('BASIC', true) },
      selected: 'ADVANCED',
      listen: 'MASTER',
    });
    useEditor.setState({ doc, page: 'ai' });
  });

  it('並べて聴ける。下の難易度は既存の EXTREME から作り、目標は MASTER と EXTREME のあいだに', () => {
    const g = useGen.getState();
    expect(compareColumns(g)).toEqual(['MASTER', 'EXTREME', 'ADVANCED', 'BASIC']);
    expect(columnKind(g, 'EXTREME')).toBe('existing');
    expect(listenChoices()).toEqual(['MASTER', 'EXTREME']);
    expect(sourceFor(g, 'ADVANCED')?.slot).toBe('EXTREME');
    expect(sourceFor(g, 'BASIC')?.doc).toBe(ext);
    expect(knownLevels(g)).toEqual({ MASTER: 7, EXTREME: 6 });
    setListen('EXTREME');
    expect(useGen.getState()).toMatchObject({ listen: 'EXTREME', selected: 'EXTREME' });
    expect(heardGenDoc(doc)).toBe(ext);
  });

  it('作り直すことにすると、下の難易度は開いている譜面から作り、目標は MASTER だけから決め直す', () => {
    recomputeTargets();
    const before = useGen.getState().diffs.ADVANCED.target;
    expect(before.max).toBeLessThanOrEqual(5.7 + 1e-9);
    setEnabled('EXTREME', true);
    const g = useGen.getState();
    expect(columnKind(g, 'EXTREME')).toBe('made');
    expect(sourceFor(g, 'ADVANCED')?.slot).toBe('MASTER');
    expect(knownLevels(g)).toEqual({ MASTER: 7 });
    expect(g.diffs.EXTREME.target.max).toBeLessThanOrEqual(6.7 + 1e-9);
    // まだ作っていないので、聴けるのは元の譜面だけ
    expect(listenChoices(g)).toEqual(['MASTER']);
  });

  it('開いている譜面が EXTREME なら、上の MASTER は残して並べ、作るのは下の難易度だけ', () => {
    useGen.setState({ sourceSlot: 'EXTREME', masterLabel: 'EXTREME', masterLevel: 6, charts: { MASTER: chart('MASTER', ext, 7.5) }, diffs: { EXTREME: diff('EXTREME', false), ADVANCED: diff('ADVANCED', true), BASIC: diff('BASIC', true) } });
    const g = useGen.getState();
    expect(belowSource(g)).toEqual(['ADVANCED', 'BASIC']);
    expect(compareColumns(g)).toEqual(['MASTER', 'EXTREME', 'ADVANCED', 'BASIC']);
    expect(columnKind(g, 'MASTER')).toBe('existing');
    expect(columnKind(g, 'EXTREME')).toBe('source');
    expect(sourceFor(g, 'ADVANCED')?.slot).toBe('EXTREME');
    // 上の譜面を聴いても、右の判定は作る難易度のまま
    setListen('MASTER');
    expect(useGen.getState()).toMatchObject({ listen: 'MASTER', selected: 'ADVANCED' });
    // 元の譜面より上の難易度は作れない
    setEnabled('EXTREME', true);
    expect(useGen.getState().diffs.EXTREME.enabled).toBe(false);
  });
});
