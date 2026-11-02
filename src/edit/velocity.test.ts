import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { CH } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import { chipVel, midiToVel, opSetVelocity, quantizeVel, soundGroups, variantsOf } from './velocity';

const SRC = [
  '#TITLE: t',
  '#BPM: 120',
  '#WAV01: bgm.ogg',
  '#WAV02: snare.wav',
  '#WAV03: snare.wav',
  '#VOLUME03: 40',
  '#WAV04: ghost.wav',
  '#VOLUME04: 40',
  '#WAV05: hh.wav',
  '#PAN05: -20',
  '',
  '#00101: 01',
  '#00112: 02020303',
  '#00111: 05050505',
].join('\r\n');

describe('強さ（ベロシティ）', () => {
  const { doc } = parseDtx(SRC);
  const sd = doc.chips.filter((c) => c.ch === CH.SD);

  it('強さはそのチップの WAV の #VOLUME', () => {
    expect(sd.map((c) => chipVel(doc, c))).toEqual([100, 100, 40, 40]);
    expect(chipVel(doc, doc.chips.find((c) => c.ch === CH.BGM)!)).toBeNull();
  });

  it('同じファイルで #VOLUME だけ違う WAV を強さ違いとしてまとめる（中身の違う音は別）', () => {
    const groups = soundGroups(doc.fields);
    const snare = groups.find((g) => g.path === 'snare.wav')!;
    expect(snare.variants).toEqual([
      { no: 2, vel: 100 },
      { no: 3, vel: 40 },
    ]);
    expect(groups.find((g) => g.path === 'ghost.wav')!.variants).toEqual([{ no: 4, vel: 40 }]);
  });

  it('強さを変えると、ある強さ違いに付け替え、無ければ #WAV と #VOLUME を足す', () => {
    const ids = new Set([sd[0].id]);
    const d1 = produce(doc, (d) => {
      expect(opSetVelocity(d, ids, () => 40, 5)).toBe(1);
    });
    expect(d1.chips.find((c) => c.id === sd[0].id)!.v).toBe(3);

    const d2 = produce(doc, (d) => {
      opSetVelocity(d, ids, () => 72, 5);
    });
    const c = d2.chips.find((x) => x.id === sd[0].id)!;
    expect(chipVel(d2, c)).toBe(70);
    expect(d2.fields['WAV' + c.v.toString(36).toUpperCase().padStart(2, '0')]).toBe('snare.wav');
    const text = serializeDtx(d2);
    expect(text).toMatch(/#WAV06: snare\.wav/);
    expect(text).toMatch(/#VOLUME06: 70/);
  });

  it('パンの付いた音の強さ違いはパンもそろえる', () => {
    const hh = doc.chips.filter((c) => c.ch === CH.HHC);
    const d = produce(doc, (dd) => {
      opSetVelocity(dd, new Set([hh[1].id]), () => 50, 5);
    });
    const v = d.chips.find((c) => c.id === hh[1].id)!.v;
    expect(variantsOf(d.fields, 5).get(50)).toBe(v);
    expect(serializeDtx(d)).toMatch(/#PAN06: -20/);
  });

  it('使われなくなった強さ違いはエディタが作ったものだけ消す', () => {
    const ids = new Set([sd[0].id]);
    const d1 = produce(doc, (d) => {
      opSetVelocity(d, ids, () => 60, 5);
    });
    expect(d1.fields['WAV06']).toBe('snare.wav');
    const d2 = produce(d1, (d) => {
      opSetVelocity(d, ids, () => 100, 5);
    });
    // 60 の強さ違いは消え、もとからあった #WAV03（強さ40、使用中）は残る
    expect(d2.fields['WAV06']).toBeUndefined();
    expect(d2.fields['VOLUME06']).toBeUndefined();
    expect(d2.fields['WAV03']).toBe('snare.wav');
    // 読み込んだ定義は、使われなくなっても消さない
    const d3 = produce(doc, (d) => {
      opSetVelocity(d, new Set(sd.slice(2).map((c) => c.id)), () => 100, 5);
    });
    expect(d3.fields['WAV03']).toBe('snare.wav');
  });

  it('刻みと電子ドラムの変換', () => {
    expect(quantizeVel(72, 5)).toBe(70);
    expect(quantizeVel(2, 5)).toBe(5);
    expect(quantizeVel(73, 10)).toBe(70);
    expect(quantizeVel(73, 1)).toBe(73);
    expect(midiToVel(1, 'normal')).toBe(100);
    expect(midiToVel(0.5, 'soft')).toBeGreaterThan(midiToVel(0.5, 'normal'));
    expect(midiToVel(0.5, 'hard')).toBeLessThan(midiToVel(0.5, 'normal'));
  });
});
