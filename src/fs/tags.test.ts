import { describe, expect, it } from 'vitest';
import { decodeLegacy, genreName, parseId3v1, parseId3v2, parseOgg, parseVorbisComment, readAudioTags } from './tags';

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function utf16(s: string): number[] {
  const out = [0xff, 0xfe];
  for (const c of s) {
    const x = c.charCodeAt(0);
    out.push(x & 255, x >> 8);
  }
  return out;
}

function frame23(id: string, data: number[]): number[] {
  return [...ascii(id), ...be32(data.length), 0, 0, ...data];
}

function id3v23(frames: number[][]): Uint8Array {
  const body = frames.flat().concat(new Array(32).fill(0));
  return new Uint8Array([...ascii('ID3'), 3, 0, 0, ...syncsafe(body.length), ...body]);
}

// 「残酷な天使のテーゼ」の Shift_JIS
const SJIS_TITLE = [0x8e, 0x63, 0x8d, 0x93, 0x82, 0xc8, 0x93, 0x56, 0x8e, 0x67, 0x82, 0xcc, 0x83, 0x65, 0x81, 0x5b, 0x83, 0x5b];

describe('音声ファイルのタグ', () => {
  it('ID3v2.3 の UTF-16 と、Shift_JIS のままの文字列を読む', () => {
    const b = id3v23([
      frame23('TIT2', [1, ...utf16('ブレス・ユア・ブレス'), 0, 0]),
      frame23('TPE1', [0, ...SJIS_TITLE.slice(0, 6)]),
      frame23('TYER', [0, ...ascii('2019')]),
      frame23('TCON', [0, ...ascii('(17)')]),
      frame23('TBPM', [0, ...ascii('175')]),
      frame23('APIC', [0, ...ascii('image/jpeg'), 0, 3, 0, 0xff, 0xd8, ...new Array(80).fill(1)]),
    ]);
    const t = parseId3v2(b)!;
    expect(t.title).toBe('ブレス・ユア・ブレス');
    expect(t.artist).toBe('残酷な');
    expect(t.year).toBe('2019');
    expect(t.genre).toBe('Rock');
    expect(t.bpm).toBe(175);
    expect(t.picture?.mime).toBe('image/jpeg');
    expect(t.picture?.data.length).toBe(82);
  });
  it('文字コードの見分け：日本語の Shift_JIS、英字、ラテン文字', () => {
    expect(decodeLegacy(new Uint8Array(SJIS_TITLE))).toBe('残酷な天使のテーゼ');
    expect(decodeLegacy(new Uint8Array(ascii('Mela!')))).toBe('Mela!');
    expect(decodeLegacy(new Uint8Array([0x42, 0x65, 0x79, 0x6f, 0x6e, 0x63, 0xe9]))).toBe('Beyoncé');
  });
  it('ID3v1（末尾128バイト）', () => {
    const b = new Uint8Array(128);
    b.set(ascii('TAG'), 0);
    b.set(SJIS_TITLE, 3);
    b.set(ascii('Artist'), 33);
    b.set(ascii('1995'), 93);
    b[127] = 13;
    expect(parseId3v1(b)).toMatchObject({ format: 'id3v1', title: '残酷な天使のテーゼ', artist: 'Artist', year: '1995', genre: 'Pop' });
  });
  it('ジャンル番号を名前にする', () => {
    expect(genreName('(9)')).toBe('Metal');
    expect(genreName('(17)Rock')).toBe('Rock');
    expect(genreName('J-Rock')).toBe('J-Rock');
  });
  it('Vorbis コメント（OGG の2つめのパケット）', () => {
    const enc = new TextEncoder();
    const comments = ['TITLE=メフィスト', 'ARTIST=女王蜂', 'DATE=2023-04-12'].map((c) => [...enc.encode(c)]);
    const body = [...le32(3), ...ascii('abc'), ...le32(comments.length), ...comments.flatMap((c) => [...le32(c.length), ...c])];
    expect(parseVorbisComment(new Uint8Array(body), 'vorbis')).toMatchObject({ title: 'メフィスト', artist: '女王蜂', year: '2023-04-12' });
    // OGG のページに包む（1ページ目：識別ヘッダ、2ページ目：コメント）
    const page = (seq: number, packet: number[]) => {
      const segs: number[] = [];
      let n = packet.length;
      while (n >= 255) {
        segs.push(255);
        n -= 255;
      }
      segs.push(n);
      return [...ascii('OggS'), 0, 0, ...new Array(8).fill(0), ...le32(7), ...le32(seq), 0, 0, 0, 0, segs.length, ...segs, ...packet];
    };
    const ident = [1, ...ascii('vorbis'), ...new Array(23).fill(0)];
    const comment = [3, ...ascii('vorbis'), ...body, 1];
    const ogg = new Uint8Array([...page(0, ident), ...page(1, comment)]);
    expect(parseOgg(ogg)).toMatchObject({ format: 'vorbis', title: 'メフィスト', artist: '女王蜂', year: '2023' });
  });
  it('タグの無いファイルは null か空', async () => {
    const t = await readAudioTags(new Blob([new Uint8Array(1000)]));
    expect(t?.title).toBeUndefined();
  });
});
