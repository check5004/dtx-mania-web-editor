import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { fixZipName, folderOf, readZip, songFoldersOf } from './zip';

/** バイト列を fflate が UTF-8 の印なしで読んだときの名前（1バイト=1文字） */
const asLatin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

describe('fixZipName', () => {
  it('ASCII はそのまま', () => {
    expect(fixZipName('song/bgm.ogg')).toBe('song/bgm.ogg');
  });

  it('UTF-8 のバイトを1バイト=1文字で読んだ名前を直す', () => {
    const name = 'メフィスト/ドラム.wav';
    expect(fixZipName(asLatin1(new TextEncoder().encode(name)))).toBe(name);
  });

  it('Shift_JIS（Windows の日本語名）を直す', () => {
    // 「曲」= 0x8B 0xC8
    expect(fixZipName(asLatin1(new Uint8Array([0x8b, 0xc8, 0x2e, 0x64, 0x74, 0x78])))).toBe('曲.dtx');
  });

  it('もう正しく読めている日本語名は触らない', () => {
    expect(fixZipName('曲/ドラム.wav')).toBe('曲/ドラム.wav');
  });
});

describe('ZIP の曲フォルダ', () => {
  const zip = zipSync({
    'Song A/mstr.dtx': strToU8('#TITLE A'),
    'Song A/WAV/kick.wav': new Uint8Array([1, 2, 3]),
    'Song A/bgm.ogg': new Uint8Array(10),
    'Pack/Song B/ext.dtx': strToU8('#TITLE B'),
    '__MACOSX/Song A/._mstr.dtx': new Uint8Array(4),
    'Song A/.DS_Store': new Uint8Array(4),
  });
  const file = new File([zip], 'songs.zip');

  it('Mac のゴミを除いて、浅い所から曲フォルダを並べる', async () => {
    const z = await readZip(file);
    expect(z.name).toBe('songs');
    expect([...z.files.keys()].some((p) => p.includes('__MACOSX') || p.endsWith('.DS_Store'))).toBe(false);
    const songs = songFoldersOf(z);
    expect(songs.map((s) => s.name)).toEqual(['Song A', 'Song B']);
  });

  it('曲フォルダからのパスにして、中のフォルダ（WAV/）もそのまま', async () => {
    const z = await readZip(file);
    const a = folderOf(z, 'Song A');
    const paths = [...a.files.values()].map((f) => f.path).sort();
    expect(paths).toEqual(['WAV/kick.wav', 'bgm.ogg', 'mstr.dtx']);
    const kick = [...a.files.values()].find((f) => f.name === 'kick.wav')!;
    expect(kick.size).toBe(3);
    const f = await kick.getFile();
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('一番上に DTX がある ZIP は ZIP の名前の曲になる', async () => {
    const top = new File([zipSync({ 'bsc.dtx': strToU8('#TITLE C'), 'bgm.ogg': new Uint8Array(2) })], 'My Song.zip');
    const z = await readZip(top);
    const songs = songFoldersOf(z);
    expect(songs).toHaveLength(1);
    expect(songs[0].name).toBe('My Song');
    expect(songs[0].files.size).toBe(2);
  });
});
