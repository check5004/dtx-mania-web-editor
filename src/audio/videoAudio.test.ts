// 動画から音を取り出す：動画の見分け・取り出した音の名前・無音の見分け・取り出しの流れ（読めない・無音・やめた・できた）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  decode: null as null | ((b: ArrayBuffer) => Promise<unknown>),
  encodes: [] as { every: number | undefined }[],
}));
vi.mock('./engine', () => ({ engine: { decodeAudio: (b: ArrayBuffer) => fake.decode!(b) } }));
vi.mock('./stems', () => ({
  encodeAudio: async (_buf: unknown, _format: string, onProgress?: (p: number) => void, every?: number) => {
    fake.encodes.push({ every });
    for (let i = 0; i < 4; i++) {
      onProgress?.(i / 4);
      await Promise.resolve();
    }
    return new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
  },
}));

const { audioNameFor, extractVideoAudio, isSilent, isVideoName, NX_MOVIE_EXT } = await import('./videoAudio');

/** AudioBuffer の代わり */
function buffer(channels: Float32Array[], sampleRate = 48000) {
  const length = channels[0]?.length ?? 0;
  return { numberOfChannels: channels.length, length, sampleRate, duration: length / sampleRate, getChannelData: (i: number) => channels[i] };
}

const video = (name: string) => new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], name, { type: 'video/mp4' });

describe('動画の見分けと名前', () => {
  it('動画の拡張子（大文字も）。音声ファイルは動画ではない', () => {
    for (const n of ['MV.mp4', 'a.MOV', 'b.m4v', 'c.webm', 'd.mkv', 'bg.avi', 'e.wmv', 'f.mpg']) expect(isVideoName(n), n).toBe(true);
    for (const n of ['song.ogg', 'x.m4a', 'y.mp3', 'z.wav', 'mp4', 'mp4.dtx']) expect(isVideoName(n), n).toBe(false);
  });

  it('背景動画にする既定は、NX の曲データにある形式（mp4・avi など）だけ', () => {
    for (const n of ['bg.mp4', 'MV.M4V', 'bg.avi', 'x.wmv', 'y.mpg', 'z.mpeg']) expect(NX_MOVIE_EXT.test(n), n).toBe(true);
    for (const n of ['a.webm', 'b.mov', 'c.mkv', 'd.flv']) expect(NX_MOVIE_EXT.test(n), n).toBe(false);
  });

  it('取り出した音は、動画の名前のまま拡張子だけ .ogg（フォルダは外す）', () => {
    expect(audioNameFor('WADATAKEAKI feat. Hatsune Miku - Bless your breath.mp4')).toBe('WADATAKEAKI feat. Hatsune Miku - Bless your breath.ogg');
    expect(audioNameFor('movie/bg.MP4')).toBe('bg.ogg');
    expect(audioNameFor('C:\\曲\\メフィスト.webm')).toBe('メフィスト.ogg');
    expect(audioNameFor('.mp4')).toBe('bgm.ogg');
    // NX（Shift_JIS）で読めない文字は読める文字に
    expect(audioNameFor('Café.mp4')).toBe('Cafe.ogg');
  });

  it('無音の見分け（-80 dB より小さければ無音）', () => {
    expect(isSilent([new Float32Array(1000)])).toBe(true);
    expect(isSilent([new Float32Array(1000).fill(5e-5), new Float32Array(1000).fill(-5e-5)])).toBe(true);
    const loud = new Float32Array(1000);
    loud[700] = -0.01;
    expect(isSilent([new Float32Array(1000), loud])).toBe(false);
  });
});

describe('取り出し', () => {
  beforeEach(() => {
    fake.encodes.length = 0;
    fake.decode = null;
  });

  it('読めない動画（音が無い・形式が読めない）は unreadable で、OGG にしない', async () => {
    fake.decode = async () => {
      throw new DOMException('Unable to decode audio data', 'EncodingError');
    };
    expect(await extractVideoAudio(video('noaudio.mp4'))).toEqual({ error: 'unreadable' });
    expect(fake.encodes).toHaveLength(0);
  });

  it('音が無音なら silent（曲データの bg.mp4 など）', async () => {
    fake.decode = async () => buffer([new Float32Array(48000)]);
    expect(await extractVideoAudio(video('bg.mp4'))).toEqual({ error: 'silent' });
    expect(fake.encodes).toHaveLength(0);
  });

  it('音があれば OGG のファイルにする。1ブロックごとに進み具合を出す', async () => {
    const ch = new Float32Array(96000).map((_, i) => Math.sin(i / 10) * 0.5);
    fake.decode = async () => buffer([ch, ch]);
    const seen: string[] = [];
    const r = await extractVideoAudio(video('MV.mp4'), { onProgress: (phase, p) => seen.push(`${phase}:${p}`) });
    if (!('file' in r)) throw new Error('取り出せていない');
    expect(r.file.name).toBe('MV.ogg');
    expect(r.file.type).toBe('audio/ogg');
    expect(r.seconds).toBe(2);
    expect(new Uint8Array(await r.file.arrayBuffer())).toEqual(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    expect(fake.encodes).toEqual([{ every: 1 }]);
    expect(seen[0]).toBe('read:0');
    expect(seen).toContain('encode:0.5');
    expect(seen.at(-1)).toBe('encode:1');
  });

  it('やめたら、OGG にしている途中でも cancelled', async () => {
    const ch = new Float32Array(48000).fill(0.2);
    fake.decode = async () => buffer([ch]);
    let stop = false;
    const r = await extractVideoAudio(video('MV.mp4'), {
      onProgress: (phase, p) => {
        if (phase === 'encode' && p >= 0.25) stop = true;
      },
      cancelled: () => stop,
    });
    expect(r).toEqual({ error: 'cancelled' });
  });

  it('読んでいる間にやめたら、OGG にしない', async () => {
    fake.decode = async () => buffer([new Float32Array(48000).fill(0.2)]);
    expect(await extractVideoAudio(video('MV.mp4'), { cancelled: () => true })).toEqual({ error: 'cancelled' });
    expect(fake.encodes).toHaveLength(0);
  });
});
