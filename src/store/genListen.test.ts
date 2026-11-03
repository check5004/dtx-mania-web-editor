import { beforeEach, describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { DEFAULT_KEEP, simplify } from '../gen/simplify';
import { useEditor } from './editor';
import { genShow, heardGenDoc, listenChoices, selectDiff, setListen, stepListen, useGen, type DiffState } from './gen';

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
