import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Md5, md5Blob, md5Bytes } from './md5';

const enc = (s: string) => new TextEncoder().encode(s);

describe('MD5（Drive の md5Checksum と比べる）', () => {
  it('決まった値と同じ', () => {
    expect(md5Bytes(enc(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Bytes(enc('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Bytes(enc('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5Bytes(enc('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('区切りの長さ（55・56・63・64・65 バイト）と、少しずつ足しても同じ', () => {
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const d = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      const want = createHash('md5').update(d).digest('hex');
      expect(md5Bytes(d)).toBe(want);
      const m = new Md5();
      for (let i = 0; i < n; i += 13) m.update(d.subarray(i, i + 13));
      expect(m.hex()).toBe(want);
    }
  });

  it('大きいファイル（4 MB を超える）も読みながら計算する', async () => {
    const d = new Uint8Array(9 * 1024 * 1024 + 123).map((_, i) => (i * 131) & 0xff);
    let seen = 0;
    expect(await md5Blob(new Blob([d]), (n) => (seen += n))).toBe(createHash('md5').update(d).digest('hex'));
    expect(seen).toBe(d.length);
  });
});
