import { beforeEach, describe, expect, it, vi } from 'vitest';

// 本体（OPFS）への書き込みは模擬にする（node には OPFS が無い）
const writes: { id: string; rel: string; size: number }[] = [];
let fail: Error | null = null;
vi.mock('./opfs', async (orig) => {
  const real = await orig<typeof import('./opfs')>();
  return {
    ...real,
    writeSongFile: async (id: string, rel: string, data: Blob | Uint8Array) => {
      if (fail) throw fail;
      writes.push({ id, rel, size: data instanceof Blob ? data.size : data.length });
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      return { getFile: async () => new File([bytes as Uint8Array<ArrayBuffer>], rel.split('/').pop()!) } as unknown as FileSystemFileHandle;
    },
  };
});

const { pathSegs } = await import('./opfs');
const { folderFromFiles, isDiskFolder, isLocalFolder, putFile, setWriteErrorHandler, writeFile } = await import('./folder');

function localFolder() {
  const f = folderFromFiles([new File([new Uint8Array(3)], 'BGM.ogg')], 'song');
  f.dir = {} as FileSystemDirectoryHandle;
  f.local = 'abc';
  return f;
}

describe('本体（OPFS）の曲フォルダ', () => {
  beforeEach(() => {
    writes.length = 0;
    fail = null;
    setWriteErrorHandler(null);
  });

  it('パスを OPFS の名前の並びにする（. と .. と空は捨てる）', () => {
    expect(pathSegs('stems/drums.ogg')).toEqual(['stems', 'drums.ogg']);
    expect(pathSegs('.\\WAV\\\\kick.wav')).toEqual(['WAV', 'kick.wav']);
    expect(pathSegs('../../x/./y.ogg')).toEqual(['x', 'y.ogg']);
  });

  it('本体の曲と PC の曲フォルダを見分ける', () => {
    const l = localFolder();
    expect(isLocalFolder(l)).toBe(true);
    expect(isDiskFolder(l)).toBe(false);
    const d = folderFromFiles([], 'disk');
    d.dir = {} as FileSystemDirectoryHandle;
    expect(isDiskFolder(d)).toBe(true);
    expect(isLocalFolder(d)).toBe(false);
    expect(isLocalFolder(folderFromFiles([], 'mem'))).toBe(false);
  });

  it('本体の曲は直接書き、大文字・小文字だけ違う同じファイルはその綴りに書く', async () => {
    const f = localFolder();
    await writeFile(f, 'bgm.OGG', new Uint8Array(10));
    expect(writes).toEqual([{ id: 'abc', rel: 'BGM.ogg', size: 10 }]);
    const e = f.files.get('bgm.ogg')!;
    expect(e.path).toBe('BGM.ogg');
    expect(e.size).toBe(10);
    expect(e.pending).toBeUndefined();
    expect((await e.getFile()).size).toBe(10);
  });

  it('putFile は本体に書き、File もそのまま渡す', async () => {
    const f = localFolder();
    expect(await putFile(f, 'stems/drums.ogg', new File([new Uint8Array(7)], 'drums.ogg'))).toBe('written');
    expect(writes).toEqual([{ id: 'abc', rel: 'stems/drums.ogg', size: 7 }]);
  });

  it('本体に書けないとき（容量不足）はメモリに持ち、知らせる', async () => {
    const f = localFolder();
    const seen: string[] = [];
    setWriteErrorHandler((e, _f, path) => seen.push(`${(e as Error).name}:${path}`));
    fail = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    expect(await putFile(f, 'stems/bass.ogg', new Uint8Array(5))).toBe('memory');
    expect(f.files.get('stems/bass.ogg')?.pending).toBe(true);
    expect(seen).toEqual(['QuotaExceededError:stems/bass.ogg']);
  });

  it('メモリの曲フォルダ（本体に入れる前）はメモリに持つ', async () => {
    const f = folderFromFiles([], 'mem');
    expect(await putFile(f, 'a.ogg', new Uint8Array(4))).toBe('memory');
    expect(writes).toEqual([]);
    expect(f.files.get('a.ogg')?.pending).toBe(true);
  });

  it('同じファイルが別の綴りであれば、その綴りのまま置き換える（SET.def に set.def を足さない）', async () => {
    const mem = folderFromFiles([new File([new Uint8Array(2)], 'SET.def')], 'mem');
    expect(await putFile(mem, 'set.def', new Uint8Array(6))).toBe('memory');
    expect(mem.files.get('set.def')?.path).toBe('SET.def');
    const f = localFolder();
    expect(await putFile(f, 'bgm.OGG', new Uint8Array(9))).toBe('written');
    expect(writes).toEqual([{ id: 'abc', rel: 'BGM.ogg', size: 9 }]);
  });
});
