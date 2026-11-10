// スネアのリム：置く（Shift・パッド）・スネア⇔リムの切り替え・音を替える。譜面のチャンネルはスネア（12）のまま
import { describe, expect, it, vi } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH, SD_LANE, SD_RIM } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { isRimChip, rimWavs } from '../dtx/rim';
import { serializeDtx } from '../dtx/serialize';

vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => Promise.resolve(null),
  confirmDialog: () => Promise.resolve(true),
}));
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });

const { openDocument, placeChips, relaneChips, setLaneWav, useEditor } = await import('./editor');

const meta = { fileName: 'rim.dtx', encoding: 'shift_jis' as const, warnings: [], hasRandom: false, siblings: [] };

function open(lines: string[]) {
  openDocument(parseDtx(['#BPM: 120', ...lines].join('\n')).doc, meta, null);
}

const doc = () => useEditor.getState().doc;
const chipOf = (id: number) => doc().chips.find((c) => c.id === id)!;

describe('リムを置く', () => {
  it('スネアのレーンの2種目はリム：チャンネルはスネアのまま、音はリム（内蔵キットのリムの音）', () => {
    open(['#WAV02: 039_Snare.ogg', '#00112: 02']);
    const [rim] = placeChips([{ lane: SD_LANE, alt: true, pos: { m: 1, f: frac(1, 2) }, vel: 100 }], { select: false });
    const [sd] = placeChips([{ lane: SD_LANE, alt: false, pos: { m: 1, f: frac(1, 4) }, vel: 100 }], { select: false });
    expect(chipOf(rim).ch).toBe(CH.SD);
    expect(isRimChip(doc(), chipOf(rim))).toBe(true);
    expect(doc().fields['WAV' + chipOf(rim).v.toString(36).toUpperCase().padStart(2, '0')]).toMatch(/rim\.wav$/);
    // スネアはスネアの音（いちばん使っている 02）
    expect(chipOf(sd).v).toBe(2);
    expect(isRimChip(doc(), chipOf(sd))).toBe(false);
    // 書き出しでもスネアのチャンネル（12）
    expect(serializeDtx(doc())).toMatch(/#00112: /);
    expect(serializeDtx(doc())).not.toMatch(/#001(?!12|13)[0-9A-Z]{2}: /);
  });

  it('リムの音にスネアの音を選んだら、同じファイルでラベル「Snare Rim」の番号を作って使う', () => {
    open(['#WAV02: 039_Snare.ogg', '#00112: 02']);
    setLaneWav(SD_RIM, 2);
    const [rim] = placeChips([{ lane: SD_LANE, alt: true, pos: { m: 1, f: frac(1, 2) }, vel: 100 }], { select: false });
    const v = chipOf(rim).v;
    expect(v).not.toBe(2);
    expect(doc().fields['WAV' + v.toString(36).toUpperCase().padStart(2, '0')]).toBe('039_Snare.ogg');
    expect(rimWavs(doc()).has(v)).toBe(true);
    expect(serializeDtx(doc())).toContain('Snare Rim');
    // 次からはその番号
    expect(useEditor.getState().laneWav[SD_RIM]).toBe(v);
    const [again] = placeChips([{ lane: SD_LANE, alt: true, pos: { m: 1, f: frac(3, 4) }, vel: 100 }], { select: false });
    expect(chipOf(again).v).toBe(v);
  });
});

describe('スネア⇔リムの切り替え', () => {
  it('同じレーンの2種目にすると音がリムに替わる（ベロシティは保つ）。戻すとスネアの音', () => {
    open(['#WAV02: 039_Snare.ogg', '#WAV0W: 038_Snare_rimclick.ogg\t;Snare Rim', '#00112: 0202', '#00212: 0W']);
    const ids = doc()
      .chips.filter((c) => c.m === 1)
      .map((c) => c.id);
    expect(relaneChips(ids, SD_LANE, 'alt')).toBe(2);
    expect(ids.map((id) => chipOf(id).v)).toEqual([32, 32]);
    expect(ids.map((id) => chipOf(id).ch)).toEqual([CH.SD, CH.SD]);
    expect(relaneChips([ids[0]], SD_LANE, 'main')).toBe(1);
    expect(chipOf(ids[0]).v).toBe(2);
  });
});
