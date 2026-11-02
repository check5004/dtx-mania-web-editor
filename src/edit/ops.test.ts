import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { frac } from '../dtx/fraction';
import { CH } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import { buildTempoMap } from '../dtx/timing';
import { makeClip, opMove, opPaste, opPlace, setField, snapToGrid } from './ops';

const BASE = ['#TITLE: t', '#BPM: 120', '#WAV01: a.wav', '', '#00102: 0.75', '#00112: 01000100', '#00211: 01010101'].join('\r\n');

describe('編集操作', () => {
  const { doc } = parseDtx(BASE);
  const tempo = buildTempoMap(doc);

  it('3/4 の小節でもグリッドは小節の頭から数える', () => {
    // 小節1は拍4〜7（3拍）。拍6.9 を 1/16 で丸めると 7 → 次の小節の頭
    expect(snapToGrid(tempo, 6.9, 16)).toEqual({ m: 2, f: frac(0) });
    expect(snapToGrid(tempo, 5.26, 16)).toEqual({ m: 1, f: frac(5, 12) });
  });

  it('同じ場所に同じレーンのチップを置くと置き換える（HHクローズ→オープン）', () => {
    const d = produce(doc, (dd) => {
      opPlace(dd, CH.HHO, { m: 2, f: frac(1, 4) }, 1);
    });
    const at = d.chips.filter((c) => c.m === 2 && c.f.n === 1 && c.f.d === 4);
    expect(at.map((c) => c.ch)).toEqual([CH.HHO]);
  });

  it('小節をまたいで動かしても拍のずれは正確', () => {
    const ids = new Set(doc.chips.filter((c) => c.ch === CH.SD).map((c) => c.id));
    const d = produce(doc, (dd) => {
      expect(opMove(dd, ids, tempo, frac(3, 2), 0)).toBe(true);
    });
    const sd = d.chips.filter((c) => c.ch === CH.SD).map((c) => [c.m, c.f.n, c.f.d]);
    // 小節1の 0 と 1/2（拍4と5.5）→ 拍5.5 と 7 → 小節1の1/2 と 小節2の頭
    expect(sd).toEqual([
      [1, 1, 2],
      [2, 0, 1],
    ]);
  });

  it('レーンを移すとき、はみ出すなら動かさない', () => {
    const ids = new Set(doc.chips.filter((c) => c.ch === CH.SD).map((c) => c.id));
    const d = produce(doc, (dd) => {
      expect(opMove(dd, ids, tempo, frac(0), -10)).toBe(false);
    });
    expect(d).toBe(doc);
  });

  it('コピーして貼り付けると相対位置を保つ', () => {
    const clip = makeClip(doc.chips.filter((c) => c.m === 2), tempo);
    const d = produce(doc, (dd) => {
      opPaste(dd, clip, frac(20), tempo);
    });
    const pasted = d.chips.filter((c) => c.m >= 4).map((c) => `${c.m}:${c.f.n}/${c.f.d}`);
    // 小節長 0.75 は次の変更まで続くので、小節6は拍19〜22。拍20 はその 1/3
    expect(pasted).toEqual(['6:1/3', '6:7/12', '6:5/6', '7:1/12']);
  });

  it('新しい #WAV はほかの #WAV の後ろに入る', () => {
    const d = produce(doc, (dd) => {
      setField(dd, 'WAV02', 'b.wav');
      setField(dd, 'GENRE', 'Rock');
    });
    const text = serializeDtx(d);
    expect(text.indexOf('#WAV02: b.wav')).toBeGreaterThan(text.indexOf('#WAV01'));
    expect(text.indexOf('#GENRE: Rock')).toBeLessThan(text.indexOf('#BPM'));
  });
});
