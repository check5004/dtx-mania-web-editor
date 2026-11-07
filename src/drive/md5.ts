// MD5。Google Drive はファイルごとに md5Checksum を持つので、手元のファイルと比べて、変わった物だけ送る・取る。
// 大きい音声も少しずつ読み、間で画面に処理を返す（固まらないように）。

const S = new Uint8Array([7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]);
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

export class Md5 {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Int32Array(16);

  update(data: Uint8Array): this {
    const n = data.length;
    let i = 0;
    this.total += n;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= n; i += 64) this.block(data, i);
    if (i < n) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = n - i;
    }
    return this;
  }

  private block(d: Uint8Array, o: number) {
    const w = this.w;
    for (let j = 0; j < 16; j++) {
      const p = o + j * 4;
      w[j] = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24);
    }
    const h = this.h;
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let e = h[3];
    for (let j = 0; j < 64; j++) {
      let f: number;
      let g: number;
      if (j < 16) {
        f = (b & c) | (~b & e);
        g = j;
      } else if (j < 32) {
        f = (e & b) | (~e & c);
        g = (5 * j + 1) & 15;
      } else if (j < 48) {
        f = b ^ c ^ e;
        g = (3 * j + 5) & 15;
      } else {
        f = c ^ (b | ~e);
        g = (7 * j) & 15;
      }
      const t = e;
      e = c;
      c = b;
      const x = (a + f + K[j] + w[g]) | 0;
      const s = S[((j >> 4) << 2) | (j & 3)];
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      a = t;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + e) | 0;
  }

  /** 16 進の小文字（Drive の md5Checksum と同じ形） */
  hex(): string {
    const bits = this.total * 8;
    const lo = bits % 4294967296;
    const hi = Math.floor(bits / 4294967296);
    const padLen = (this.bufLen < 56 ? 56 : 120) - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    for (let i = 0; i < 4; i++) {
      tail[padLen + i] = (lo >>> (8 * i)) & 0xff;
      tail[padLen + 4 + i] = (hi >>> (8 * i)) & 0xff;
    }
    const total = this.total;
    this.update(tail);
    this.total = total;
    let out = '';
    for (let i = 0; i < 4; i++) {
      const v = this.h[i];
      for (let j = 0; j < 4; j++) out += ((v >>> (8 * j)) & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  }
}

export function md5Bytes(data: Uint8Array): string {
  return new Md5().update(data).hex();
}

const CHUNK = 4 << 20;

/** Blob（ファイル）の MD5。4 MB ずつ読み、間で画面に処理を返す */
export async function md5Blob(blob: Blob, onBytes?: (n: number) => void): Promise<string> {
  const m = new Md5();
  for (let at = 0; at < blob.size; at += CHUNK) {
    const part = new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer());
    m.update(part);
    onBytes?.(part.length);
    if (blob.size > CHUNK) await new Promise((r) => setTimeout(r, 0));
  }
  return m.hex();
}
