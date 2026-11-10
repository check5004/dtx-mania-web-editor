// チップを別のレーンへ動かしたら、音もそのレーンの音にする（ベロシティは保つ）。
// 動かしたときは、動かした先で鳴る音を鳴らす（間違えて動かしても気づける）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../audio/engine';
import { toBase36x2 } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { velOfWav } from '../edit/velocity';

// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });

const { moveSelection, previewChipMove, relaneChips, undo, useEditor } = await import('./editor');

// 鳴らした音（WAV 番号と強さの倍率）。読み込んである音だけ鳴る
let heard: { no: number; gain: number }[] = [];
const loaded = new Set([1, 2, 3]);

beforeEach(() => {
  heard = [];
  vi.spyOn(engine, 'ensure').mockReturnValue({} as AudioContext);
  vi.spyOn(engine, 'has').mockImplementation((no) => loaded.has(no));
  vi.spyOn(engine, 'preview').mockImplementation((no, gain = 1) => {
    if (!loaded.has(no)) return false;
    heard.push({ no, gain });
    return true;
  });
  vi.spyOn(engine, 'prepare').mockResolvedValue([]);
  open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SD = 1;
const HH = 2;
const HH_SOFT = 3;

/** スネア（WAV01）とハイハット（WAV02、ベロシティ 60 の WAV03）の譜面。スネアとハイハット（60）を1つずつ */
function song(): DtxDoc {
  return {
    ...emptyDoc(),
    fields: { BPM: '120', WAV01: 'sd.wav', WAV02: 'hh.wav', WAV03: 'hh.wav', VOLUME03: '60' },
    chips: [
      { id: 1, ch: CH.SD, m: 1, f: frac(0), v: SD },
      { id: 2, ch: CH.HHC, m: 1, f: frac(1, 2), v: HH_SOFT },
    ],
    nextId: 3,
  };
}

function open() {
  useEditor.setState({
    screen: 'editor',
    page: 'chart',
    doc: song(),
    past: [],
    future: [],
    toasts: [],
    selection: [],
    previewOnPlace: true,
    laneWav: { [CH.SD]: SD, [CH.HHC]: HH },
  });
}

const chip = (id: number) => useEditor.getState().doc.chips.find((c) => c.id === id)!;
const fields = () => useEditor.getState().doc.fields;
const pathOf = (no: number) => fields()['WAV' + toBase36x2(no)];

// レーン（左から）: 左シンバル・HH・左ペダル・スネア・ハイタム…（並びは既定のまま）
describe('チップを別のレーンへ動かす（ドラッグ・矢印キー・選択バー）', () => {
  it('動かした先のレーンの音になる。ベロシティは保つ（無ければベロシティ違いを足す）', () => {
    useEditor.setState({ selection: [2] });
    expect(moveSelection(frac(0), 2)).toBe(true);
    const c = chip(2);
    expect(c.ch).toBe(CH.SD);
    expect(pathOf(c.v)).toBe('sd.wav');
    expect(velOfWav(fields(), c.v)).toBe(60);
  });

  it('ベロシティが同じならそのレーンの音の番号そのもの', () => {
    useEditor.setState({ selection: [1] });
    moveSelection(frac(0), -2);
    expect(chip(1)).toMatchObject({ ch: CH.HHC, v: HH });
  });

  it('時刻だけ動かしたときは音を変えない', () => {
    useEditor.setState({ selection: [2] });
    moveSelection(frac(1), 0);
    expect(chip(2)).toMatchObject({ ch: CH.HHC, v: HH_SOFT, m: 1, f: { n: 3, d: 4 } });
  });

  it('いくつも選んで動かすと、それぞれ移った先の音になる', () => {
    useEditor.setState({ selection: [1, 2] });
    moveSelection(frac(0), -1);
    // スネア → 左ペダル（譜面に音が無いので今のキットの音を登録）、HH → 左シンバル（同じく）
    const sd = chip(1);
    const hh = chip(2);
    expect(sd.ch).toBe(CH.LP);
    expect(hh.ch).toBe(CH.LC);
    expect(pathOf(sd.v)).not.toBe('sd.wav');
    expect(pathOf(hh.v)).not.toMatch(/^(sd|hh)\.wav$/);
    expect(pathOf(sd.v)).not.toBe(pathOf(hh.v));
    expect(velOfWav(fields(), hh.v)).toBe(60);
  });

  it('元に戻すと、レーンも音も足した WAV も戻る', () => {
    useEditor.setState({ selection: [2] });
    moveSelection(frac(0), 2);
    undo();
    expect(chip(2)).toMatchObject({ ch: CH.HHC, v: HH_SOFT });
    expect(fields()).toEqual(song().fields);
  });

  it('右クリックの「レーンを変える」も同じく音を変える', () => {
    relaneChips([2], 3);
    expect(pathOf(chip(2).v)).toBe('sd.wav');
    expect(velOfWav(fields(), chip(2).v)).toBe(60);
  });
});

describe('動かした先の音を鳴らす', () => {
  it('別のレーンなら、そのレーンの音をチップのベロシティで鳴らす（譜面は変えない）', () => {
    previewChipMove(2, 2);
    expect(heard).toEqual([{ no: SD, gain: 0.6 }]);
    expect(chip(2)).toMatchObject({ ch: CH.HHC, v: HH_SOFT });
  });

  it('同じレーン（時刻だけ・元のレーンに戻した）なら、そのチップの音', () => {
    previewChipMove(2, 0);
    expect(heard).toEqual([{ no: HH_SOFT, gain: 1 }]);
  });

  it('レーンの外へは鳴らさない', () => {
    previewChipMove(2, -5);
    expect(heard).toEqual([]);
  });

  it('「チップを置いた・動かしたときに音を鳴らす」を切っていれば鳴らさない', () => {
    useEditor.setState({ previewOnPlace: false });
    previewChipMove(2, 2);
    useEditor.setState({ selection: [2] });
    moveSelection(frac(0), 2, { hear: true });
    expect(heard).toEqual([]);
  });

  it('矢印キー・選択バーで別のレーンへ動かしたら、動かしたあとの音を1つ鳴らす', () => {
    useEditor.setState({ selection: [2, 1] });
    moveSelection(frac(0), 2, { hear: true });
    // 選んだ最初のチップ（HH → スネアの音）。足したばかりのベロシティ違いはまだ読み込んでいないので、同じ音を強さの比で
    expect(chip(2).v).not.toBe(SD);
    expect(heard).toEqual([{ no: SD, gain: 0.6 }]);
  });

  it('時刻だけ動かしたとき・動かせなかったときは鳴らさない', () => {
    useEditor.setState({ selection: [2] });
    moveSelection(frac(1), 0, { hear: true });
    expect(moveSelection(frac(0), -5, { hear: true })).toBe(false);
    expect(heard).toEqual([]);
  });
});
