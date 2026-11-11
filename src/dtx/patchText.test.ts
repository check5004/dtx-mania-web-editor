import { describe, expect, it } from 'vitest';
import { setField } from '../edit/ops';
import { frac } from './fraction';
import { CH, type DtxDoc } from './model';
import { parseDtx } from './parse';
import { patchDtxText, sameContent } from './patchText';
import { serializeDtx } from './serialize';

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

/** text を読んで fn で変え、行だけ書き換える */
function change(text: string, fn: (d: DtxDoc) => void): { out: string; after: DtxDoc } {
  const after = parseDtx(text).doc;
  fn(after);
  return { out: patchDtxText(text, parseDtx(text).doc, after), after };
}

const removeChip = (d: DtxDoc, ch: number, v: number) => {
  const i = d.chips.findIndex((c) => c.ch === ch && c.v === v);
  expect(i).toBeGreaterThanOrEqual(0);
  d.chips.splice(i, 1);
};

const SONG = crlf([
  '; Created by DTXCreator',
  '',
  '#TITLE: Song',
  '#BPM: 120',
  '#DLEVEL: 50',
  '',
  '#WAV01: bgm.ogg\t;BGM',
  '#VOLUME01: 80',
  '#WAV02: snare.wav',
  '',
  '#00002: 0.75',
  '#00001: 01',
  '#00016: 0T ;ride default',
  '#00112: 0202_0202',
  '#00211: 02020202',
]);

describe('譜面のテキストを行だけ書き換える', () => {
  it('原曲のファイルを替えると、その行の値だけが変わる（タブ・コメント・チップの行のコメントもそのまま）', () => {
    const { out, after } = change(SONG, (d) => setField(d, 'WAV01', 'bgm_drumless.ogg'));
    expect(out).toBe(SONG.replace('#WAV01: bgm.ogg\t;BGM', '#WAV01: bgm_drumless.ogg\t;BGM'));
    expect(sameContent(parseDtx(out).doc, after)).toBe(true);
  });

  it('改行が LF・最後に改行が無いテキストもそのまま', () => {
    const lf = SONG.replace(/\r\n/g, '\n').trimEnd();
    const { out } = change(lf, (d) => setField(d, 'WAV01', 'x.ogg'));
    expect(out).toBe(lf.replace('bgm.ogg', 'x.ogg'));
  });

  it('何も変えなければ、テキストはそのまま', () => {
    expect(change(SONG, () => undefined).out).toBe(SONG);
  });

  it('原曲のチップと #WAV を足し、戻すと元のテキストにもどる', () => {
    const noBgm = crlf(['#TITLE: Song', '#BPM: 120', '', '#WAV02: snare.wav', '#WAV03: kick.wav', '', '#00112: 02020202', '#00211: 03030303']);
    const { out, after } = change(noBgm, (d) => {
      setField(d, 'WAV04', 'bgm.ogg');
      setField(d, 'BGMWAV', '04');
      d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 1, f: frac(0), v: 4 });
    });
    // #WAV は最後の #WAV の後ろ、#BGMWAV は曲情報の後ろ、チップの行は小節・チャンネルの順の所
    expect(out).toBe(
      crlf(['#TITLE: Song', '#BPM: 120', '#BGMWAV: 04', '', '#WAV02: snare.wav', '#WAV03: kick.wav', '#WAV04: bgm.ogg', '', '#00101: 04', '#00112: 02020202', '#00211: 03030303']),
    );
    expect(sameContent(parseDtx(out).doc, after)).toBe(true);
    const back = change(out, (d) => {
      removeChip(d, CH.BGM, 4);
      setField(d, 'WAV04', undefined);
      setField(d, 'BGMWAV', undefined);
    });
    expect(back.out).toBe(noBgm);
  });

  it('同じ所に足すチップは1行にまとめ、チップの行が無ければヘッダのあとに空行を置いて足す', () => {
    const empty = crlf(['#TITLE: Empty', '#WAV01: a.wav']);
    const { out } = change(empty, (d) => {
      d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 2, f: frac(0), v: 1 }, { id: d.nextId++, ch: CH.BGM, m: 2, f: frac(1, 2), v: 1 });
    });
    expect(out).toBe(crlf(['#TITLE: Empty', '#WAV01: a.wav', '', '#00201: 0101']));
  });

  it('区切りの無い定義の行に値を書くと「: 」を入れる', () => {
    const t = crlf(['#WAV01', '#WAV02;memo', '#00101: 0102']);
    const { out } = change(t, (d) => {
      setField(d, 'WAV01', 'a.ogg');
      setField(d, 'WAV02', 'b.ogg');
    });
    expect(out).toBe(crlf(['#WAV01: a.ogg', '#WAV02: b.ogg ;memo', '#00101: 0102']));
  });

  it('同じ定義が2回あれば、効いている後の行だけを変える', () => {
    const t = crlf(['#WAV01: old.ogg', '#WAV01: bgm.ogg', '#00101: 01']);
    expect(change(t, (d) => setField(d, 'WAV01', 'new.ogg')).out).toBe(crlf(['#WAV01: old.ogg', '#WAV01: new.ogg', '#00101: 01']));
  });

  it('#IF の中の行には触らない', () => {
    const t = crlf(['#WAV01: bgm.ogg', '#RANDOM 2', '#IF 1', '#WAV01: other.ogg', '#00101: 01', '#ENDIF', '#00101: 01']);
    const { out } = change(t, (d) => {
      setField(d, 'WAV01', 'new.ogg');
      removeChip(d, CH.BGM, 1);
    });
    expect(out).toBe(crlf(['#WAV01: new.ogg', '#RANDOM 2', '#IF 1', '#WAV01: other.ogg', '#00101: 01', '#ENDIF']));
  });

  it('チップを消すと、その2文字だけ 00 にする（_ と小文字はそのまま。コメントのある行は 00 のまま残す）', () => {
    const t = crlf(['#WAV0A: a.wav', '#WAV0B: b.wav', '#00111: 0a_0b', '#00101: 0b ;bgm']);
    const { out } = change(t, (d) => {
      removeChip(d, CH.HHC, 11);
      removeChip(d, CH.BGM, 11);
    });
    expect(out).toBe(crlf(['#WAV0A: a.wav', '#WAV0B: b.wav', '#00111: 0a_00', '#00101: 00 ;bgm']));
  });

  it('同じ所で音だけ替えたチップは、その2文字だけを書き換える（行を足さない）', () => {
    const t = crlf(['#WAV01: hh.ogg', '#WAV02: hh2.ogg', '', '#00111: 01_01 ;hh', '#00112: 0001']);
    const { out, after } = change(t, (d) => {
      d.chips.find((c) => c.ch === CH.HHC && c.f.n === 1)!.v = 2;
    });
    expect(out).toBe(crlf(['#WAV01: hh.ogg', '#WAV02: hh2.ogg', '', '#00111: 01_02 ;hh', '#00112: 0001']));
    expect(sameContent(parseDtx(out).doc, after)).toBe(true);
  });

  it('エフェクトのコメント「;fx」は付く #WAV と一緒に足し・消し、戻すと元のテキストにもどる（ほかの行は動かさない）', () => {
    const t = crlf(['#TITLE: Song', '#WAV01: hh.ogg', '#WAV02: sd.ogg', '', '#000C2: 01', '#00111: 01010101', '#00112: 0002']);
    const fxWav = (d: DtxDoc, key: string, path: string, line: string) => {
      setField(d, key, path);
      const i = d.header.findIndex((h) => h.kind === 'field' && h.key === key);
      d.header.splice(i, 0, { kind: 'raw', text: line });
    };
    const { out, after } = change(t, (d) => {
      fxWav(d, 'WAV03', 'fx/hh_hc800.ogg', ';fx hh.ogg hicut 800');
      for (const c of d.chips) if (c.ch === CH.HHC && c.f.n * 2 >= c.f.d) c.v = 3;
    });
    expect(out).toBe(crlf(['#TITLE: Song', '#WAV01: hh.ogg', '#WAV02: sd.ogg', ';fx hh.ogg hicut 800', '#WAV03: fx/hh_hc800.ogg', '', '#000C2: 01', '#00111: 01010303', '#00112: 0002']));
    expect(sameContent(parseDtx(out).doc, after)).toBe(true);
    // かけ方を変える（同じ番号で別のかけた音に）：コメントの行も一緒に
    const re = change(out, (d) => {
      d.header.splice(
        d.header.findIndex((h) => h.kind === 'raw' && h.text.startsWith(';fx')),
        1,
      );
      fxWav(d, 'WAV03', 'fx/hh_hc500.ogg', ';fx hh.ogg hicut 500');
    });
    expect(re.out).toBe(out.replace(';fx hh.ogg hicut 800', ';fx hh.ogg hicut 500').replace('fx/hh_hc800.ogg', 'fx/hh_hc500.ogg'));
    const back = change(out, (d) => {
      d.header.splice(
        d.header.findIndex((h) => h.kind === 'raw' && h.text.startsWith(';fx')),
        1,
      );
      setField(d, 'WAV03', undefined);
      for (const c of d.chips) if (c.v === 3) c.v = 1;
    });
    expect(back.out).toBe(t);
  });

  it('先頭の BOM の文字は残す', () => {
    const t = '﻿' + crlf(['#WAV01: a.ogg', '#00101: 01']);
    expect(change(t, (d) => setField(d, 'WAV01', 'b.ogg')).out).toBe('﻿' + crlf(['#WAV01: b.ogg', '#00101: 01']));
  });

  it('行で書き換えられない変更（小節長など）は、全体を書き出す', () => {
    const { out, after } = change(SONG, (d) => {
      d.barLengths[1] = 0.5;
      setField(d, 'WAV01', 'x.ogg');
    });
    expect(out).toBe(serializeDtx(after));
  });
});
