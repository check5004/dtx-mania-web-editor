// 保存で曲フォルダが替わっても、書き写した同じ中身の音は前の鍵のまま（原曲の解析・採譜をやり直さない）。
import { beforeEach, describe, expect, it } from 'vitest';
import type { FolderFile, SongFolder } from './folder';
import { carrySoundKeys, clearSoundKeys, keepSoundKey, soundKey } from './soundKey';

const file = (path: string, size: number, ver?: number): FolderFile => ({ path, name: path.split('/').pop()!, size, ver, getFile: async () => new File([], path) });
const folder = (name: string, files: FolderFile[]): SongFolder => ({ name, files: new Map(files.map((f) => [f.path.toLowerCase(), f])) });

describe('音の鍵', () => {
  beforeEach(() => clearSoundKeys());

  it('初めて保存して別の曲フォルダに写した音は、前の鍵で読む', () => {
    const mem = folder('新しい曲', [file('bgm.ogg', 1000), file('stems/drums.ogg', 500, 3)]);
    const before = soundKey(mem, mem.files.get('bgm.ogg')!);
    const disk = folder('My Song', [file('bgm.ogg', 1000, 7), file('stems/drums.ogg', 500, 8), file('mstr.dtx', 20, 9)]);
    expect(soundKey(disk, disk.files.get('bgm.ogg')!)).not.toBe(before);
    carrySoundKeys(mem, disk);
    expect(soundKey(disk, disk.files.get('bgm.ogg')!)).toBe(before);
    expect(soundKey(disk, disk.files.get('stems/drums.ogg')!)).toBe(soundKey(mem, mem.files.get('stems/drums.ogg')!));
  });

  it('中身が変われば（大きさ・版）新しい鍵', () => {
    const mem = folder('a', [file('bgm.ogg', 1000)]);
    const disk = folder('b', [file('bgm.ogg', 1200, 2)]);
    carrySoundKeys(mem, disk);
    expect(soundKey(disk, disk.files.get('bgm.ogg')!)).toBe('b|bgm.ogg|1200|2');
    const later = file('bgm.ogg', 1000, 5);
    expect(soundKey(disk, later)).toBe('b|bgm.ogg|1000|5');
  });

  it('二度写しても、いちばん初めの鍵のまま', () => {
    const a = folder('a', [file('bgm.ogg', 10)]);
    const b = folder('b', [file('bgm.ogg', 10, 1)]);
    const c = folder('c', [file('bgm.ogg', 10, 2)]);
    carrySoundKeys(a, b);
    carrySoundKeys(b, c);
    expect(soundKey(c, c.files.get('bgm.ogg')!)).toBe('a|bgm.ogg|10|0');
  });

  it('メモリにだけあった音を同じ曲フォルダに書いたら、前の鍵で読む', () => {
    const f = folder('song', [file('stems/vocals.ogg', 300, 4)]);
    const pending = f.files.get('stems/vocals.ogg')!;
    const before = soundKey(f, pending);
    f.files.set('stems/vocals.ogg', file('stems/vocals.ogg', 300, 11));
    keepSoundKey(f, pending);
    expect(soundKey(f, f.files.get('stems/vocals.ogg')!)).toBe(before);
  });
});
