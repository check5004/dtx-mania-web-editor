import { describe, expect, it } from 'vitest';
import { parseBase36x2, parseMeasure, parseNxNumber, toBase36x2, toMeasure } from './base36';
import { decodeDtx, encodeDtx } from './encoding';
import { frac, fromNumber } from './fraction';
import { CH, type DtxDoc } from './model';
import { parseDtx, splitCommandLine } from './parse';
import { serializeDtx } from './serialize';
import { buildTempoMap } from './timing';

const SAMPLE = [
  '; Created by DTXCreator',
  '',
  '#TITLE: テスト曲〜サンプル',
  '#ARTIST: someone',
  '#Comment  コメント付き ;ここはコメント',
  '#BPM: 150',
  '#DLEVEL: 825',
  '#PREVIEW: pre.ogg',
  '#WAV01: bgm.ogg',
  '#WAV0A: snare.wav',
  '#wav0b: kick.wav',
  '#VOLUME0A: 80',
  '#BPM01: 75.5',
  '#WAV0A: snare2.wav',
  '',
  '#RANDOM 2',
  '#IF 1',
  '#00112: 0A0A',
  '#ENDIF',
  '',
  '#00101: 01',
  '#00102: 0.75',
  '#00112: 000A000A000A',
  '#00113: 0B00000B00000B000000000B0000000B',
  '#00113: 0B',
  '#00203: 00960000',
  '#00208: 0001',
  '#00211: 0A0A0A_0A0A0A',
  '#00211: 0a00000a0a00',
  '#00218: 000000000B',
  '#00220: 0101',
  '#0021A: ZZ',
  '#00312: 0A0Z0A?',
  '#00332: 0A',
  '#00353: 0100',
  '#A0516: 0A',
].join('\r\n');

/** NX と同じ考え方でチップを「小節×384＋位置」に直す（往復で発声位置が変わらないことの確認用） */
function nxTicks(text: string): string[] {
  const out: string[] = [];
  let ifDepth = 0;
  for (const line of text.split(/\r\n|\n/)) {
    const p = splitCommandLine(line);
    if (!p) continue;
    const cmd = p.command.toUpperCase();
    if (cmd.startsWith('IF')) { ifDepth++; continue; }
    if (cmd.startsWith('ENDIF')) { ifDepth--; continue; }
    if (ifDepth > 0) continue;
    const m = /^([0-9A-Z])([0-9]{2})([0-9A-F]{2})$/.exec(cmd);
    if (!m) continue;
    const ch = parseInt(m[3], 16);
    if (ch === 2) continue;
    const s = p.param.replace(/_/g, '');
    if (!/^[0-9A-Za-z]*$/.test(s)) continue;
    const count = Math.floor(s.length / 2);
    const measure = parseMeasure(m[1] + m[2]);
    for (let i = 0; i < count; i++) {
      const pair = s.slice(i * 2, i * 2 + 2).toUpperCase();
      if (pair === '00') continue;
      const tick = measure * 384 + Math.floor((384 * i) / count);
      out.push(`${ch.toString(16)}@${tick}=${pair}`);
    }
  }
  return out.sort();
}

function summary(doc: DtxDoc) {
  return {
    fields: doc.fields,
    barLengths: doc.barLengths,
    chips: doc.chips
      .map((c) => `${c.ch}:${c.m}:${c.f.n}/${c.f.d}=${c.v}`)
      .sort(),
  };
}

describe('base36 と数値', () => {
  it('36進数2桁を読み書きできる', () => {
    expect(parseBase36x2('0A')).toBe(10);
    expect(parseBase36x2('zz')).toBe(1295);
    expect(parseBase36x2('0?')).toBe(-1);
    expect(toBase36x2(1295)).toBe('ZZ');
  });
  it('小節番号は先頭だけ36進数', () => {
    expect(parseMeasure('A05')).toBe(1005);
    expect(toMeasure(1005)).toBe('A05');
    expect(parseMeasure('0A5')).toBe(-1);
  });
  it('NXと同じく小数点に , も使える', () => {
    expect(parseNxNumber('0,75')).toBe(0.75);
    expect(parseNxNumber('1.5abc')).toBe(1.5);
    expect(parseNxNumber('abc')).toBeNull();
  });
  it('小数を拍子の分数に直せる', () => {
    expect(fromNumber(0.75)).toEqual(frac(3, 4));
    expect(fromNumber(0.875)).toEqual(frac(7, 8));
    expect(fromNumber(1.25)).toEqual(frac(5, 4));
  });
});

describe('DTXの読み込み', () => {
  const { doc, warnings, hasRandom } = parseDtx(SAMPLE);

  it('ヘッダを読める（コマンド名は大文字で引ける）', () => {
    expect(doc.fields.TITLE).toBe('テスト曲〜サンプル');
    expect(doc.fields.BPM).toBe('150');
    expect(doc.fields.WAV0B).toBe('kick.wav');
    expect(doc.fields.COMMENT).toBe('コメント付き');
  });
  it('再定義は後の値が有効で、警告が出る', () => {
    expect(doc.fields.WAV0A).toBe('snare2.wav');
    expect(warnings.some((w) => w.message.includes('WAV0A'))).toBe(true);
  });
  it('#RANDOM/#IF は分岐として残す', () => {
    expect(hasRandom).toBe(true);
    // #IF の中のチップはチップとして読まない
    expect(doc.chips.filter((c) => c.m === 1 && c.ch === CH.SD)).toHaveLength(3);
  });
  it('チップの位置を分数で持つ', () => {
    const sd = doc.chips.filter((c) => c.m === 1 && c.ch === CH.SD).map((c) => c.f);
    expect(sd).toEqual([frac(1, 6), frac(1, 2), frac(5, 6)]);
    const hh = doc.chips.filter((c) => c.m === 2 && c.ch === CH.HHC);
    expect(hh).toHaveLength(9);
  });
  it('不正な行は読まずに警告して原文を残す', () => {
    expect(doc.chips.some((c) => c.m === 3 && c.ch === CH.SD)).toBe(false);
    expect(warnings.some((w) => w.message.includes('チップの並び'))).toBe(true);
  });
  it('ギターなどドラム以外のチャンネルも保持する', () => {
    expect(doc.chips.some((c) => c.ch === 0x20)).toBe(true);
    expect(doc.chips.some((c) => c.ch === CH.FILLIN)).toBe(true);
    expect(doc.chips.some((c) => c.m === 1005 && c.ch === CH.CY)).toBe(true);
  });
});

describe('DTXの書き出し', () => {
  const first = parseDtx(SAMPLE);
  const text1 = serializeDtx(first.doc);
  const second = parseDtx(text1);
  const text2 = serializeDtx(second.doc);

  it('読む→書く→読むで中身が変わらない', () => {
    expect(summary(second.doc)).toEqual(summary(first.doc));
  });
  it('2回目の書き出しは1回目と同じ文字列', () => {
    expect(text2).toBe(text1);
  });
  it('NXが読んだときの発声位置（384分割）が変わらない', () => {
    expect(nxTicks(text1)).toEqual(nxTicks(SAMPLE));
  });
  it('触っていないヘッダ行は原文のまま', () => {
    expect(text1).toContain('#Comment  コメント付き ;ここはコメント');
    expect(text1).toContain('#wav0b: kick.wav');
    expect(text1).toContain('#IF 1\r\n#00112: 0A0A\r\n#ENDIF');
    expect(text1).toContain('; Created by DTXCreator');
  });
  it('小節長は数値のまま、チップは最小の分割数で書く', () => {
    expect(text1).toContain('#00102: 0.75');
    expect(text1).toMatch(/#00112: 000A000A000A\r\n/);
    expect(text1).toMatch(/#00203: 00960000\r\n/);
    expect(text1).toMatch(/#00353: 01\r\n/);
  });
  it('同じ位置に重なるチップは別の行に分ける', () => {
    const lines = text1.split('\r\n').filter((l) => l.startsWith('#00211'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
  it('値を変えたヘッダは書き直す', () => {
    const d = structuredClone(first.doc);
    d.fields.TITLE = '新しい題名';
    delete d.fields.PREVIEW;
    const t = serializeDtx(d);
    expect(t).toContain('#TITLE: 新しい題名');
    expect(t).not.toContain('#PREVIEW');
  });
  it('改行は CRLF', () => {
    expect(text1.endsWith('\r\n')).toBe(true);
    expect(text1.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
});

describe('文字コード', () => {
  it('Shift_JISで書いて読める（〜は～に置き換え）', () => {
    const { bytes, lost } = encodeDtx('#TITLE: テスト曲〜①Ⅱ\r\n');
    expect(lost).toEqual([]);
    const d = decodeDtx(bytes);
    expect(d.encoding).toBe('shift_jis');
    expect(d.text).toBe('#TITLE: テスト曲～①Ⅱ\r\n');
  });
  it('半角カナ・記号・漢字も往復できる', () => {
    const src = '#COMMENT: ｶﾞﾝﾀﾞﾑ 髙橋 ㈱ ∵ ¥100 ~ \\\r\n';
    const { bytes, lost } = encodeDtx(src);
    expect(lost).toEqual(['¥']);
    expect(decodeDtx(bytes).text).toBe(src.replace('¥', '?'));
  });
  it('Shift_JISに無い文字は報告する', () => {
    const { lost } = encodeDtx('#TITLE: 🥁 Café\r\n');
    expect(lost).toContain('🥁');
  });
  it('BOM付きUTF-8とBOMなしUTF-8を見分ける', () => {
    const body = new TextEncoder().encode('#TITLE: ドラム\r\n');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(decodeDtx(bom).encoding).toBe('utf-8-bom');
    const plain = decodeDtx(body);
    expect(plain.encoding).toBe('utf-8');
    // BOM付きUTF-16（DTXCreatorAL が書く形式）
    const le = new Uint8Array(2 + body.length * 2);
    le.set([0xff, 0xfe]);
    const text16 = new TextDecoder().decode(body);
    for (let k = 0; k < text16.length; k++) {
      le[2 + k * 2] = text16.charCodeAt(k) & 0xff;
      le[3 + k * 2] = text16.charCodeAt(k) >> 8;
    }
    const d16 = decodeDtx(le.subarray(0, 2 + text16.length * 2));
    expect(d16.encoding).toBe('utf-16le');
    expect(d16.text).toBe(text16);
    expect(plain.note).toBeTruthy();
    expect(plain.text).toBe('#TITLE: ドラム\r\n');
  });
});

describe('タイミング', () => {
  const { doc } = parseDtx(SAMPLE);
  const tm = buildTempoMap(doc);

  it('小節長は次の変更まで続く', () => {
    expect(tm.barLen(0)).toBe(1);
    expect(tm.barLen(1)).toBe(0.75);
    expect(tm.barLen(5)).toBe(0.75);
    expect(tm.measureStart(2)).toBe(4 + 3);
  });
  it('ch03 と ch08(#BPMzz) でBPMが変わる', () => {
    // 小節2の 1/4 で 150(0x96)、3/4 で #BPM01=75.5
    const b1 = tm.beatOf(2, frac(1, 4));
    const b2 = tm.beatOf(2, frac(3, 4));
    expect(tm.bpmAt(b1 - 0.01)).toBe(150);
    expect(tm.bpmAt(b1)).toBe(150);
    expect(tm.bpmAt(b2)).toBe(75.5);
  });
  it('拍と秒を相互に変換できる', () => {
    const b = tm.beatOf(3, frac(0));
    const sec = tm.beatToSec(b);
    expect(tm.secToBeat(sec)).toBeCloseTo(b, 9);
    // 最初の 7拍は BPM150 → 2.8秒
    expect(tm.beatToSec(7)).toBeCloseTo(2.8, 9);
  });
  it('拍から小節と位置を分数で求められる', () => {
    const at = tm.locateFrac(tm.beatOfFrac(2, frac(2, 3)));
    expect(at.m).toBe(2);
    expect(at.f).toEqual(frac(2, 3));
  });
});
