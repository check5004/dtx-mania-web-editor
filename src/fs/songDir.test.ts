import { describe, expect, it } from 'vitest';
import { folderFromFiles, type SongFolder } from './folder';
import { chartRefs, decidePlace, inDirs, lookAtFolder, otherSongDirs, safeFolderName, songFilesOf, songFolderName, subFolder } from './songDir';

function folderOf(paths: string[], name = 'DTXFiles'): SongFolder {
  const f = folderFromFiles([], name);
  for (const p of paths) {
    const file = new File(['x'], p.split('/').pop()!);
    f.files.set(p.toLowerCase(), { path: p, name: file.name, size: file.size, getFile: async () => file });
  }
  return f;
}

/** 名前だけの偽のフォルダ（File System Access の entries だけ） */
type Tree = { [name: string]: Tree | string };
function fakeDir(name: string, tree: Tree): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [n, v] of Object.entries(tree)) yield [n, typeof v === 'string' ? ({ kind: 'file', name: n } as FileSystemFileHandle) : fakeDir(n, v)] as [string, FileSystemHandle];
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe('ほかの曲のフォルダを見分ける', () => {
  it('譜面・set.def・box.def・成績のあるサブフォルダだけ。いちばん浅い所にまとめる', () => {
    const dirs = otherSongDirs([
      'mstr.dtx',
      'bgm.ogg',
      'stems/drums.ogg',
      'Mela/mstr.dtx',
      'Mela/sounds/kick.wav',
      'Box/box.def',
      'Box/Song1/ext.dtx',
      'J-POP/Calc/set.def',
      'J-POP/readme.txt',
      'Played/bsc.dtx.score.ini',
    ]);
    expect(dirs).toEqual(['box', 'j-pop/calc', 'mela', 'played']);
    expect(inDirs('Mela/sounds/kick.wav', dirs)).toBe(true);
    expect(inDirs('J-POP/readme.txt', dirs)).toBe(false);
    expect(inDirs('stems/drums.ogg', dirs)).toBe(false);
    // 曲フォルダ（直下の譜面とステムだけ）にはほかの曲が無い
    expect(otherSongDirs(['mstr.dtx', 'set.def', 'stems/drums.ogg', '.dtxe-autosave/mstr.dtx.json'])).toEqual([]);
  });

  it('ほかの曲も入ったフォルダから移すとき：曲の物（譜面が使うファイル・ステム・直下の譜面や音）だけ。消してよいのは直下と stems/ の物だけ', () => {
    const f = folderOf([
      'mstr.dtx',
      'mstr.dtx.dtxe.json',
      'mstr.dtx.score.ini',
      'set.def',
      '.dtxe-drive.json',
      'bgm.ogg',
      'mix_nodrums.ogg',
      'memo.txt',
      'Song pack.zip',
      'Thumbs.db',
      'stems/drums.ogg',
      'Movie/bga.avi',
      'Mela/mstr.dtx',
      'Mela/bgm.ogg',
      'Extra/unused.wav',
    ]);
    const refs = new Set(['bgm.ogg', 'movie/bga.avi', 'mela/bgm.ogg']);
    expect(songFilesOf(f, refs).map((x) => x.path).sort()).toEqual([
      '.dtxe-drive.json',
      'Movie/bga.avi',
      'bgm.ogg',
      'mix_nodrums.ogg',
      'mstr.dtx',
      'mstr.dtx.dtxe.json',
      'mstr.dtx.score.ini',
      'set.def',
      'stems/drums.ogg',
    ]);
    expect(songFilesOf(f, refs, 'strict').map((x) => x.path).sort()).toEqual(['.dtxe-drive.json', 'bgm.ogg', 'mstr.dtx', 'mstr.dtx.dtxe.json', 'set.def', 'stems/drums.ogg']);
    // 直下だけを読んだフォルダ（ほかの曲のフォルダが見えない）でも、library なら曲の物だけ
    const top = folderOf(['mstr.dtx', 'bgm.ogg', 'Song pack.zip', 'readme.txt', 'stems/drums.ogg']);
    expect(songFilesOf(top, new Set(['bgm.ogg']), 'library').map((x) => x.path).sort()).toEqual(['bgm.ogg', 'mstr.dtx', 'stems/drums.ogg']);
    expect(songFilesOf(top, new Set())).toHaveLength(5);
    // 曲フォルダなら全部
    const song = folderOf(['mstr.dtx', 'bgm.ogg', 'Extra/unused.wav'], 'Mela');
    expect(songFilesOf(song, new Set())).toHaveLength(3);
  });

  it('曲を集めたフォルダの中の1曲を、読み込み済みのファイルから取り出す', () => {
    const f = folderOf(['Mela/mstr.dtx', 'Mela/Sounds/Kick.wav', 'Calc/ext.dtx']);
    const sub = subFolder(f, 'mela');
    expect(sub.name).toBe('Mela');
    expect([...sub.files.keys()].sort()).toEqual(['mstr.dtx', 'sounds/kick.wav']);
    expect(sub.files.get('sounds/kick.wav')!.path).toBe('Sounds/Kick.wav');
  });
});

describe('保存する場所を決める', () => {
  const look = (o: Partial<Parameters<typeof decidePlace>[0]>) => ({ name: 'x', entries: 0, charts: [], setDef: false, box: false, songs: [], ...o });
  it('DTXFiles のように曲を集めたフォルダ・ほかの物があるフォルダなら、中に曲のフォルダを作る', () => {
    expect(decidePlace(look({ name: 'DTXFiles', entries: 300, songs: ['Mela', 'Calc', 'Box'] }), 'Mephisto')).toBe('inside');
    expect(decidePlace(look({ name: 'Box', entries: 3, box: true }), 'Mephisto')).toBe('inside');
    expect(decidePlace(look({ name: 'Downloads', entries: 12 }), 'Mephisto')).toBe('inside');
    // 空の DTXFiles（NX を入れたばかり）にも直接は広げない
    expect(decidePlace(look({ name: 'DTXFiles', entries: 0 }), 'Mephisto')).toBe('inside');
  });
  it('空のフォルダ・同じ名前の曲フォルダならそこに。ほかの曲のフォルダなら聞く', () => {
    expect(decidePlace(look({ name: '新しいフォルダ', entries: 0 }), 'Mephisto')).toBe('here');
    expect(decidePlace(look({ name: 'mephisto', entries: 4, charts: ['mstr.dtx'], setDef: true }), 'Mephisto')).toBe('here');
    expect(decidePlace(look({ name: 'Calc', entries: 4, charts: ['mstr.dtx'] }), 'Mephisto')).toBe('other-song');
  });

  it('選んだフォルダを名前だけ見る（曲のフォルダは深さ3まで）', async () => {
    const dir = fakeDir('DTXFiles', {
      'readme.txt': '',
      Mela: { 'mstr.dtx': '', 'bgm.ogg': '' },
      Pack: { Calc: { 'set.def': '', 'ext.dtx': '' } },
      Empty: {},
    });
    const l = await lookAtFolder(dir, 10);
    expect(l).toMatchObject({ name: 'DTXFiles', entries: 4, charts: [], setDef: false, box: false });
    expect(l.songs).toEqual(['Mela', 'Pack/Calc']);
    expect(decidePlace(l, 'Mephisto')).toBe('inside');
    const song = await lookAtFolder(fakeDir('Mephisto', { 'mstr.dtx': '', 'set.def': '', stems: { 'drums.ogg': '' } }));
    expect(song).toMatchObject({ charts: ['mstr.dtx'], setDef: true, songs: [] });
  });

  it('フォルダの名前：使えない文字を除き、仮の名前や DTXFiles なら曲名にする', () => {
    expect(safeFolderName('AC/DC: Back in Black?')).toBe('AC_DC_ Back in Black_');
    expect(safeFolderName('  end. ')).toBe('end');
    expect(safeFolderName('CON')).toBe('_CON');
    expect(songFolderName({ folder: 'Mela (Full Version)', title: 'Mela!' })).toBe('Mela (Full Version)');
    expect(songFolderName({ folder: '新しい曲', title: 'メフィスト' })).toBe('メフィスト');
    expect(songFolderName({ folder: 'New song (2)', title: 'Calc.' })).toBe('Calc');
    expect(songFolderName({ folder: 'DTXFiles', title: 'Wasureteyaranai', library: true })).toBe('Wasureteyaranai');
    expect(songFolderName({ title: '' })).toBe('song');
  });
});

describe('譜面が使うファイル', () => {
  it('#WAV・#BMP・#AVI・#PREVIEW などの値（#PATH_WAV も見る）。コメントと数字だけの行は見ない', () => {
    const refs = chartRefs(
      ['#TITLE: Mr.Children', '#PATH_WAV: Sounds', '#WAV01: kick.wav ; キック', '#WAV02 bgm.ogg', '#BMP01: Movie\\bga.avi', '#PREVIEW: pre.ogg', '#00111: 01020304', '#BPM: 120.5'].join('\r\n'),
    );
    expect(refs.sort()).toEqual(['bgm.ogg', 'kick.wav', 'movie/bga.avi', 'pre.ogg', 'sounds/bgm.ogg', 'sounds/kick.wav', 'sounds/movie/bga.avi', 'sounds/pre.ogg']);
  });
});
