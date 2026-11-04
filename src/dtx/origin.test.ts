import { describe, expect, it } from 'vitest';
import { chartHash, hasOriginLine, markOrigin, ORIGIN_KEY, originOf, originValue, readOrigin } from './origin';
import { parseDtx } from './parse';
import { serializeDtx } from './serialize';
import { CH } from './model';

const SRC = [
  '#TITLE: Song',
  '#BPM: 150',
  '#DLEVEL: 45',
  '#WAV01: snare.wav',
  '#WAV02: snare.wav',
  '#VOLUME02: 60',
  '#WAV03: bd.wav',
  '#00012: 01010101',
  '#00013: 03000300',
  '#00101: 00000000000000000000000000000000',
  '',
].join('\r\n');

const load = (text: string) => parseDtx(text).doc;

describe('AI で作った譜面の印（#DTXE_ORIGIN）', () => {
  it('書き出して読み直しても残り、手を入れていなければ AI の譜面', () => {
    const doc = load(SRC);
    expect(originOf(doc)).toBe('human');
    markOrigin(doc, 'mstr.dtx');
    const text = serializeDtx(doc);
    expect(text).toMatch(/^#DTXE_ORIGIN: AI [0-9a-f]{8} from mstr\.dtx$/m);
    expect(hasOriginLine(text)).toBe(true);
    const back = load(text);
    expect(readOrigin(back)).toEqual({ edited: false, from: 'mstr.dtx', hash: chartHash(doc) });
    expect(originOf(back)).toBe('ai');
    // ほかのヘッダとチップはそのまま
    expect(back.fields['TITLE']).toBe('Song');
    expect(back.chips.length).toBe(doc.chips.length);
  });

  it('ドラムのチップを動かす・足すと「手直しあり」。音（WAV 番号）の付け替えでは変わらない', () => {
    const doc = load(SRC);
    markOrigin(doc, 'mstr.dtx');
    const sd = doc.chips.find((c) => c.ch === CH.SD)!;
    const moved = { ...doc, chips: doc.chips.map((c) => (c === sd ? { ...c, f: { n: 3, d: 8 } } : c)) };
    expect(originOf(moved)).toBe('ai-edited');
    const added = { ...doc, chips: [...doc.chips, { id: 99, ch: CH.HHC, m: 0, f: { n: 0, d: 1 }, v: 1 }] };
    expect(originOf(added)).toBe('ai-edited');
    const resound = { ...doc, chips: doc.chips.map((c) => (c === sd ? { ...c, v: 2 } : c)) };
    expect(originOf(resound)).toBe('ai');
    // 位置の書き方（2/8 と 1/4）では変わらない
    const same = { ...doc, chips: doc.chips.map((c) => (c === sd ? { ...c, f: { n: c.f.n * 2, d: c.f.d * 2 } } : c)) };
    expect(originOf(same)).toBe('ai');
  });

  it('ハッシュの無い印・前の版の印も AI の譜面として扱う（手直しは分からないので上書きしない）', () => {
    const doc = load(SRC);
    doc.fields[ORIGIN_KEY] = 'AI';
    expect(originOf(doc)).toBe('ai-edited');
    doc.fields[ORIGIN_KEY] = 'something else';
    expect(originOf(doc)).toBe('human');
  });

  it('NX で読み飛ばされる形（コマンド名が5文字でない・値に「;」を入れない）', () => {
    expect(ORIGIN_KEY.length).not.toBe(5);
    const doc = load(SRC);
    const v = originValue(doc, 'a;b\r\n.dtx');
    expect(v).not.toMatch(/[;\r\n]/);
    expect(v).toMatch(/from a_b__\.dtx$/);
    // 作者の譜面の文字には印が無い
    expect(hasOriginLine(SRC)).toBe(false);
  });
});
