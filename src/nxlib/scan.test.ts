import { describe, expect, it } from 'vitest';
import { deepCheck, dirAt, fileAt, listSongFiles, unreadableName } from './check';
import { assignSlots, boxKeyOf, chartsSig, markDuplicates, scanLibrary, songIdOf, type LibChart, type LibSong } from './scan';

// ---- 偽のフォルダ（File System Access の読むところだけ） ----------------------------------

class F {
  constructor(
    readonly data: string | Uint8Array,
    readonly t = 1000,
  ) {}
}
type Tree = { [name: string]: Tree | string | F };

const reads = { n: 0 };

function fakeFile(name: string, f: F): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    async getFile() {
      reads.n++;
      return new File([f.data as BlobPart], name, { lastModified: f.t });
    },
  } as unknown as FileSystemFileHandle;
}

function fakeDir(name: string, tree: Tree): FileSystemDirectoryHandle {
  const kids = new Map<string, FileSystemHandle>();
  for (const [n, v] of Object.entries(tree)) {
    if (typeof v === 'string') kids.set(n, fakeFile(n, new F(v)));
    else if (v instanceof F) kids.set(n, fakeFile(n, v));
    else kids.set(n, fakeDir(n, v));
  }
  const get = (n: string, kind: string) => {
    const h = kids.get(n);
    if (!h || h.kind !== kind) throw new DOMException(`${n} not found`, 'NotFoundError');
    return h;
  };
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const e of kids) yield e;
    },
    async getFileHandle(n: string) {
      return get(n, 'file');
    },
    async getDirectoryHandle(n: string) {
      return get(n, 'directory');
    },
  } as unknown as FileSystemDirectoryHandle;
}

const dtx = (lines: string[]) => lines.join('\r\n');

function library(): FileSystemDirectoryHandle {
  return fakeDir('DTXFiles', {
    'DTXFiles.EDM': {
      'Neon Rain': {
        'set.def': dtx(['#TITLE Neon Rain', '#L1LABEL BASIC', '#L1FILE bsc.dtx', '#L2LABEL ADVANCED', '#L2FILE ADV.DTX', '#L3LABEL EXTREME', '#L3FILE ext.dtx', '#L4LABEL MASTER', '#L4FILE mstr.dtx']),
        'bsc.dtx': new F(dtx(['#TITLE Neon Rain', '#ARTIST Kiri', '#BPM 128', '#DLEVEL 35', '#PREIMAGE jacket.png', '#PREVIEW pre.ogg']), 2000),
        'adv.dtx': dtx(['#TITLE Neon Rain', '#DLEVEL 52']),
        'mstr.dtx': new F(dtx(['#TITLE Neon Rain', '#DLEVEL 825', '#PREIMAGE Jacket.PNG']), 3000),
        'mstr.dtx.score.ini': dtx(['[File]', 'PlayCountDrums=4', 'BestRankDrums=2', '[HiSkill.Drums]', 'PlaySkill=88.04']),
        'jacket.png': new F('png', 1500),
        'pre.ogg': 'ogg',
        'mstr.dtx.dtxe.json': '{}',
        '.dtxe-drive.json': JSON.stringify({ v: 1, folderId: 'f1', name: 'Neon Rain', files: { a: { size: 100 }, b: { size: 23 } } }),
      },
    },
    Rock: {
      'box.def': '#TITLE ロック',
      'Glass Bridge': {
        'Glass Bridge': {
          'mstr.dtx': dtx(['#TITLE Glass Bridge', '#ARTIST Mori', '#DLEVEL 76', '#STAGEFILE stage.jpg']),
          'ext.dtx': dtx(['#TITLE Glass Bridge', '#DLEVEL 61']),
          'stage.jpg': 'jpg',
        },
      },
    },
    Loose: {
      'Paper Moon': {
        'a.dtx': dtx(['#TITLE Paper Moon', '#ARTIST Sora', '#DLEVEL 30']),
        'b.dtx': dtx(['#TITLE Paper Moon', '#DLEVEL 60']),
        'c.dtx': dtx(['#TITLE Paper Moon', '#DLEVEL 80']),
      },
    },
    System: { 'skin.png': 'x', Graphics: { 'a.png': 'x' } },
  });
}

describe('DTXMania の曲を探す（NX と同じ探し方）', () => {
  it('BOX（「DTXFiles.」・box.def）・ほかのフォルダは素通り・曲名のフォルダが二重でも読む', async () => {
    const images: string[] = [];
    const r = await scanLibrary([{ dir: library(), key: '' }], { onImage: (id, h, sig) => images.push(`${id} ${h.name} ${sig}`) });
    expect(r.stopped).toBe(false);
    expect(r.boxes.map((b) => [b.key, b.title, b.dot, b.parent])).toEqual([
      [':dtxfiles.edm', 'EDM', true, null],
      [':rock', 'ロック', false, null],
    ]);
    // BOX のフォルダの並び（元の綴り。保存の画面で「書く所」に出す）
    expect(r.boxes.map((b) => b.path)).toEqual([['DTXFiles.EDM'], ['Rock']]);
    expect(r.songs.map((s) => s.id)).toEqual([':dtxfiles.edm/neon rain#0', ':loose/paper moon#0', ':rock/glass bridge/glass bridge#0']);

    const neon = r.songs[0];
    expect(neon).toMatchObject({ title: 'Neon Rain', artist: 'Kiri', bpm: '128', box: [':dtxfiles.edm'], setDef: true, image: 'jacket.png', preview: 'pre.ogg', edited: true, doubled: false });
    expect(neon.drive).toEqual({ state: 'linked', bytes: 123 });
    // set.def に書いてある ext.dtx が無い：その難易度は出さず、点検に出す
    expect(neon.charts.map((c) => [c.slot, c.file, c.head.level])).toEqual([
      ['BSC', 'bsc.dtx', 3.5],
      ['ADV', 'adv.dtx', 5.2],
      ['MAS', 'mstr.dtx', 8.25],
    ]);
    expect(neon.checks).toEqual([{ kind: 'setdef-missing', n: 1, files: ['ext.dtx'] }]);
    expect(neon.charts[2].score).toEqual({ plays: 4, rank: 'A', skill: 88 });
    expect(neon.charts[0].score).toBeNull();
    expect(neon.updated).toBe(3000);
    // 画像は上の難易度から（mstr の Jacket.PNG を大文字・小文字を見ずに）
    expect(images.sort()).toEqual([':dtxfiles.edm/neon rain#0 jacket.png 3:1500', ':rock/glass bridge/glass bridge#0 stage.jpg 3:1000']);

    const glass = r.songs[2];
    expect(glass).toMatchObject({ title: 'Glass Bridge', artist: 'Mori', path: ['Rock', 'Glass Bridge', 'Glass Bridge'], box: [':rock'], doubled: true, image: 'stage.jpg', setDef: false });
    expect(glass.charts.map((c) => [c.slot, c.file])).toEqual([
      ['EXT', 'ext.dtx'],
      ['MAS', 'mstr.dtx'],
    ]);
    // 譜面が 2 つ以上で set.def が無い・試聴が書いていない
    expect(glass.checks).toEqual([{ kind: 'nosetdef', n: 2 }, { kind: 'nopreview' }]);

    const paper = r.songs[1];
    expect(paper.box).toEqual([]);
    expect(paper.doubled).toBe(false);
    // 名前で分からない譜面はレベルの高い順に上の枠から
    expect(paper.charts.map((c) => [c.slot, c.file])).toEqual([
      ['ADV', 'a.dtx'],
      ['EXT', 'b.dtx'],
      ['MAS', 'c.dtx'],
    ]);
    expect(paper.checks.map((c) => c.kind)).toEqual(['nosetdef', 'nopreview', 'noimage']);
  });

  it('set.def の #TITLE ごとに 1 曲。譜面が 1 つも無い #TITLE は出さない。サブフォルダの譜面も', async () => {
    const dir = fakeDir('DTXFiles', {
      Pack: {
        'set.def': dtx(['#TITLE Song A', '#L1FILE a_bsc.dtx', '#L4FILE charts\\a_mas.dtx', '', '#TITLE Song B', '#L1FILE b.dtx', '', '#TITLE Song C', '#L1FILE nothing.dtx']),
        'a_bsc.dtx': '#TITLE A\n#DLEVEL 20',
        charts: { 'A_MAS.dtx': '#TITLE A\n#DLEVEL 70' },
        'b.dtx': '#TITLE B\n#DLEVEL 40',
      },
    });
    const r = await scanLibrary([{ dir, key: '' }]);
    // サブフォルダの中も NX と同じく探すので、charts の譜面も 1 曲になる（NX の選曲画面にも出る）
    expect(r.songs.map((s) => [s.id, s.title, s.charts.map((c) => `${c.slot}:${c.file}`).join(' ')])).toEqual([
      [':pack#0', 'Song A', 'BSC:a_bsc.dtx MAS:charts/A_MAS.dtx'],
      [':pack#1', 'Song B', 'BSC:b.dtx'],
      [':pack/charts#0', 'A', 'MAS:A_MAS.dtx'],
    ]);
  });

  it('前の一覧と大きさ・更新時刻が同じ譜面は読み直さない。点検の結果も譜面が同じなら残す', async () => {
    const dir = fakeDir('DTXFiles', { Song: { 'mstr.dtx': new F('#TITLE New\n#DLEVEL 50', 10) } });
    const first = await scanLibrary([{ dir, key: '' }]);
    const prev = first.songs[0];
    const kept: LibSong = { ...prev, charts: prev.charts.map((c) => ({ ...c, head: { ...c.head, title: 'Old' } })), checkedSig: chartsSig(prev.charts), refs: [], drums: true };
    const again = await scanLibrary([{ dir, key: '' }], { prev: new Map([[prev.id, kept]]) });
    expect(again.songs[0].title).toBe('Old');
    expect(again.songs[0]).toMatchObject({ checkedSig: kept.checkedSig, refs: [], drums: true });
    // 譜面が変わったら読み直す
    const changed = fakeDir('DTXFiles', { Song: { 'mstr.dtx': new F('#TITLE New\n#DLEVEL 50', 20) } });
    const third = await scanLibrary([{ dir: changed, key: '' }], { prev: new Map([[prev.id, kept]]) });
    expect(third.songs[0].title).toBe('New');
    expect(third.songs[0].checkedSig).toBeUndefined();
  });

  it('いくつかの場所（外のフォルダ）は鍵で分ける。途中でやめられる', async () => {
    const a = fakeDir('DTXFiles', { S1: { 'mstr.dtx': '#TITLE One\n#DLEVEL 50' } });
    const b = fakeDir('DTX', { S1: { 'mstr.dtx': '#TITLE Two\n#DLEVEL 50' } });
    const r = await scanLibrary([
      { dir: a, key: '' },
      { dir: b, key: 'x0' },
    ]);
    expect(r.songs.map((s) => [s.id, s.root, s.title])).toEqual([
      [':s1#0', '', 'One'],
      ['x0:s1#0', 'x0', 'Two'],
    ]);
    const stop = await scanLibrary([{ dir: a, key: '' }], { stopped: () => true });
    expect(stop).toMatchObject({ songs: [], stopped: true });
  });

  it('選んだのが曲のフォルダそのものでも 1 曲', async () => {
    const r = await scanLibrary([{ dir: fakeDir('My Song', { 'mstr.dtx': '#DLEVEL 50' }), key: '' }]);
    expect(r.songs.map((s) => [s.id, s.title, s.path])).toEqual([[':#0', 'My Song', []]]);
  });

  it('同じ曲（曲名とアーティストが同じ）が 2 つ以上', () => {
    const s = (id: string, title: string, artist: string) => ({ id, title, artist, checks: [] }) as unknown as LibSong;
    const list = [s('1', 'Neon Rain', 'Kiri'), s('2', 'ＮＥＯＮ ＲＡＩＮ', 'kiri'), s('3', 'Neon Rain', 'Other'), s('4', '', '')];
    markDuplicates(list);
    expect(list.map((x) => x.checks)).toEqual([[{ kind: 'dup', n: 1 }], [{ kind: 'dup', n: 1 }], [], []]);
  });

  it('枠：難易度名・ファイル名・L の番号・レベルの順。入らない譜面は null', () => {
    const c = (file: string, label: string, index: number, level: number | null) => ({ file, label, index, slot: null, head: { level } }) as Pick<LibChart, 'file' | 'label' | 'index' | 'slot'> & { head: { level: number | null } };
    const list = [c('x1.dtx', 'NOVICE', 1, 2), c('x2.dtx', 'MASTER', 2, 9), c('x3.dtx', 'DTXMANIA', 5, 9.5), c('ext.dtx', '', 0, 7), c('x4.dtx', 'HARD', 3, 6)];
    assignSlots(list);
    expect(list.map((x) => x.slot)).toEqual(['BSC', 'MAS', null, 'EXT', 'ADV']);
  });

  it('id と BOX の鍵は小文字・\'/\' 区切り', () => {
    expect(songIdOf('', ['DTXFiles.EDM', 'Neon Rain'], 1)).toBe(':dtxfiles.edm/neon rain#1');
    expect(boxKeyOf('x1', ['Rock'])).toBe('x1:rock');
  });
});

describe('点検（譜面を全部読む）', () => {
  const song = (dir: FileSystemDirectoryHandle) => scanLibrary([{ dir, key: '' }]).then((r) => r.songs[0]);

  it('使うファイルが無い・読めない名前・ドラムの譜面が無い', async () => {
    const dir = fakeDir('Song', {
      'mstr.dtx': dtx(['#TITLE x', '#DLEVEL 50', '#PATH_WAV sounds', '#WAV01 Kick.wav', '#WAV02 snare.wav', '#WAV03 hat.wav', '#BMP01 ..\\shared\\bg.png', '#00120: 01']),
      'kick.wav': 'x',
      sounds: { 'hat.wav': 'x' },
      'ã‚¹ãƒã‚¢.wav': 'x',
      Other: { 'mstr.dtx': '#TITLE other', 'snare.wav': 'x' },
    });
    const s = await song(dir);
    const r = await deepCheck(dir, s);
    expect(r.checks.filter((c) => c.kind === 'missing' || c.kind === 'badname' || c.kind === 'nodrums')).toEqual([
      { kind: 'missing', n: 1, files: ['snare.wav'] },
      { kind: 'badname', n: 1, files: ['ã‚¹ãƒã‚¢.wav'] },
      { kind: 'nodrums' },
    ]);
    expect(r.drums).toBe(false);
    expect(r.checkedSig).toBe(chartsSig(s.charts));
  });

  it('譜面が前の点検と同じなら譜面を読み直さず、フォルダの中だけ見直す', async () => {
    const tree: Tree = { 'mstr.dtx': '#TITLE x\n#DLEVEL 50\n#WAV01 kick.wav\n#00112: 01' };
    const s = await song(fakeDir('Song', tree));
    const first = await deepCheck(fakeDir('Song', tree), s);
    expect(first.checks.map((c) => c.kind)).toEqual(['nopreview', 'noimage', 'missing']);
    const done = { ...s, checks: first.checks, checkedSig: first.checkedSig, refs: first.refs, drums: first.drums };
    reads.n = 0;
    const second = await deepCheck(fakeDir('Song', { ...tree, 'kick.wav': 'x' }), done);
    expect(reads.n).toBe(0);
    expect(second.checks.map((c) => c.kind)).toEqual(['nopreview', 'noimage']);
  });

  it('曲のフォルダのファイル（ほかの曲のフォルダの中は除く）', async () => {
    const files = await listSongFiles(fakeDir('Song', { 'A.dtx': 'x', Sounds: { 'Kick.WAV': 'x' }, Other: { 'set.def': 'x', 'b.wav': 'x' } }));
    expect([...files.entries()]).toEqual([
      ['a.dtx', 'A.dtx'],
      ['sounds/kick.wav', 'Kick.WAV'],
    ]);
  });

  it('大文字・小文字を見ずにたどる', async () => {
    const dir = fakeDir('Root', { DTXFiles: { Rock: { 'Song.dtx': 'x' } } });
    expect((await dirAt(dir, ['dtxfiles', 'ROCK']))?.name).toBe('Rock');
    expect(await dirAt(dir, ['nothing'])).toBeNull();
    expect((await fileAt(dir, 'DTXFILES\\rock\\song.DTX'))?.name).toBe('Song.dtx');
    expect(await fileAt(dir, 'DTXFiles/none.dtx')).toBeNull();
  });

  it('Shift_JIS で書けない字がある名前', () => {
    expect(unreadableName('キック.wav')).toBe(false);
    expect(unreadableName('ã‚­.wav')).toBe(true);
  });
});
