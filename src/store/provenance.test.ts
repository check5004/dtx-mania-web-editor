import { beforeEach, describe, expect, it } from 'vitest';
import { CH, emptyDoc, type Chip, type DtxDoc } from '../dtx/model';
import { insertMeasures, deleteMeasures, undo, redo, useEditor } from './editor';
import { autoMeasures, humanMeasure, markAuto, measureSig } from './provenance';
import { emptySidecar, loadSidecar, parseSidecar, sameSongSidecar, serializeSidecar, sidecarData, sidecarIsEmpty, useSidecar } from './sidecar';

let nextId = 1;
const chip = (ch: number, m: number, n: number, d = 16): Chip => ({ id: nextId++, ch, m, f: { n, d }, v: 1 });

function song(): DtxDoc {
  const d = emptyDoc();
  d.fields = { BPM: '120' };
  for (let m = 0; m < 6; m++) for (const s of [0, 8]) d.chips.push(chip(CH.BD, m, s), chip(CH.SD, m, s + 4));
  d.nextId = nextId;
  return d;
}

const withChip = (doc: DtxDoc, c: Chip): DtxDoc => ({ ...doc, chips: [...doc.chips, c] });

beforeEach(() => {
  loadSidecar(null);
});

describe('自動で入れた小節', () => {
  it('入れたときの中身のままなら自動、作者が直すと作者の小節、戻すとまた自動', () => {
    const doc = song();
    markAuto(doc, [2, 3]);
    expect([...autoMeasures(doc)]).toEqual([2, 3]);
    expect(humanMeasure(doc)(2)).toBe(false);
    expect(humanMeasure(doc)(1)).toBe(true);
    // 小節 2 にハイハットを足した（手で直した）
    const edited = withChip(doc, chip(CH.HHC, 2, 2));
    expect([...autoMeasures(edited)]).toEqual([3]);
    // 元に戻す（中身が入れたときに戻る）
    expect([...autoMeasures(doc)]).toEqual([2, 3]);
    // ドラム以外のチップ（BGM）は中身に入れない
    expect(measureSig(withChip(doc, chip(CH.BGM, 3, 0)), 3)).toBe(measureSig(doc, 3));
  });

  it('チップの無い小節は覚えない。覚え直すと印が新しくなる', () => {
    const doc = song();
    markAuto(doc, [9]);
    expect(useSidecar.getState().auto).toEqual([]);
    markAuto(doc, [2]);
    const more = withChip(doc, chip(CH.HHC, 2, 2));
    markAuto(more, [2]);
    expect(useSidecar.getState().auto).toHaveLength(1);
    expect([...autoMeasures(more)]).toEqual([2]);
    expect([...autoMeasures(doc)]).toEqual([]);
  });

  it('作業ファイルに書いて読み戻せる。別の難易度へは持っていかない', () => {
    const doc = song();
    markAuto(doc, [1, 4]);
    expect(sidecarIsEmpty()).toBe(false);
    const back = parseSidecar(serializeSidecar(sidecarData()));
    expect(back?.auto).toEqual(useSidecar.getState().auto);
    expect(parseSidecar(JSON.stringify({ auto: [{ m: 1, sig: 'x' }, { m: 'a', sig: 'y' }, { m: 2 }, { m: 1, sig: 'z' }] }))?.auto).toEqual([{ m: 1, sig: 'x' }]);
    expect(sameSongSidecar(null).auto).toEqual([]);
    expect(sameSongSidecar({ ...emptySidecar(), auto: [{ m: 3, sig: 'q' }] }).auto).toEqual([{ m: 3, sig: 'q' }]);
  });

  it('小節を入れる・消すと印もずれ、元に戻すと印も戻る', () => {
    const doc = song();
    useEditor.setState({ screen: 'editor', doc, savedDoc: doc, past: [], future: [] });
    markAuto(doc, [2, 4]);
    insertMeasures(1, 2);
    const after = useEditor.getState().doc;
    expect(useSidecar.getState().auto.map((a) => a.m)).toEqual([4, 6]);
    expect([...autoMeasures(after)]).toEqual([4, 6]);
    undo();
    expect(useSidecar.getState().auto.map((a) => a.m)).toEqual([2, 4]);
    expect([...autoMeasures(useEditor.getState().doc)]).toEqual([2, 4]);
    redo();
    expect(useSidecar.getState().auto.map((a) => a.m)).toEqual([4, 6]);
    // 印の小節を消すと印も消える
    deleteMeasures(4, 1);
    expect(useSidecar.getState().auto.map((a) => a.m)).toEqual([5]);
    expect([...autoMeasures(useEditor.getState().doc)]).toEqual([5]);
  });
});
