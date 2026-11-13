import { describe, expect, it } from 'vitest';
import type { LibBox, LibChart, LibSong, SlotKey } from './scan';
import { addableSlots, bpmText, boxCounts, bytesText, filterCounts, fixSetDef, levelText, matchQuery, outsideRel, rootSpecs, saveBoxLabel, saveWhere, setDefFor, sourceFor, topChart, viewSongs, warnCount } from './view';

function chart(file: string, slot: SlotKey | null, level: number | null, ai = false): LibChart {
  return {
    file,
    label: '',
    index: 0,
    slot,
    head: { title: '', artist: '', bpm: '', level, preimage: '', stagefile: '', preview: '', ai },
    score: null,
    size: 1,
    mtime: 1,
  };
}

function song(id: string, o: Partial<LibSong> = {}): LibSong {
  return {
    id,
    root: '',
    path: [id],
    block: 0,
    title: id,
    artist: '',
    bpm: '120',
    box: [],
    charts: [],
    setDef: true,
    image: '',
    imageSig: '',
    preview: '',
    updated: 0,
    edited: false,
    drive: null,
    doubled: false,
    checks: [],
    ...o,
  };
}

describe('空いた難易度の枠', () => {
  it('いちばん上の譜面より下の空いた枠だけ作れる', () => {
    const s = song('a', { charts: [chart('bsc.dtx', 'BSC', 2.5), chart('ext.dtx', 'EXT', 7.1)] });
    expect(topChart(s)?.file).toBe('ext.dtx');
    expect(addableSlots(s)).toEqual(['ADV']);
    // 作る元はすぐ上の譜面
    expect(sourceFor(s, 'ADV')?.file).toBe('ext.dtx');
  });

  it('いちばん上が .dtx でない・ドラムが無いと作れない', () => {
    expect(addableSlots(song('g', { charts: [chart('mas.gda', 'MAS', 8)] }))).toEqual([]);
    expect(addableSlots(song('d', { charts: [chart('mas.dtx', 'MAS', 8)], drums: false }))).toEqual([]);
    expect(addableSlots(song('m', { charts: [chart('mas.dtx', 'MAS', 8)] }))).toEqual(['BSC', 'ADV', 'EXT']);
  });

  it('枠に入らない譜面だけの曲は作れない', () => {
    const s = song('x', { charts: [chart('x.dtx', null, 5)] });
    expect(topChart(s)?.file).toBe('x.dtx');
    expect(addableSlots(s)).toEqual([]);
  });
});

describe('しぼりこみ・並べ替え', () => {
  const songs = [
    song('a', { title: 'Ｎｅｏｎ Rain', artist: 'Kiri', updated: 3, box: ['b1'], charts: [chart('m.dtx', 'MAS', 8.25)], edited: true }),
    song('b', { title: 'Apple', artist: 'Zed', bpm: '180', updated: 1, charts: [chart('b.dtx', 'BSC', 2), chart('e.dtx', 'EXT', 6, true)] }),
    song('c', { title: 'cloud', artist: 'Ann', bpm: '90.5', updated: 2, box: ['b1', 'b1/b2'], checks: [{ kind: 'missing', n: 2 }, { kind: 'noimage' }], drive: { state: 'linked', bytes: 5 } }),
  ];
  const q = { q: '', sort: 'updated' as const, box: null, filter: null, drafts: {} };

  it('曲名・アーティスト・フォルダで探す（全角も同じ）', () => {
    expect(matchQuery(songs[0], 'neon')).toBe(true);
    expect(matchQuery(songs[0], 'neon kiri')).toBe(true);
    expect(matchQuery(songs[0], 'neon zed')).toBe(false);
    expect(viewSongs(songs, { ...q, q: 'ann' }).map((s) => s.id)).toEqual(['c']);
  });

  it('BOX（中の BOX も含む）と BOX の外', () => {
    expect(viewSongs(songs, { ...q, box: 'b1' }).map((s) => s.id)).toEqual(['a', 'c']);
    expect(viewSongs(songs, { ...q, box: 'b1/b2' }).map((s) => s.id)).toEqual(['c']);
    expect(viewSongs(songs, { ...q, box: '' }).map((s) => s.id)).toEqual(['b']);
    expect(Object.fromEntries(boxCounts(songs))).toEqual({ '': 1, b1: 2, 'b1/b2': 1 });
  });

  it('並べ替え', () => {
    expect(viewSongs(songs, q).map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(viewSongs(songs, { ...q, sort: 'title' }).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(viewSongs(songs, { ...q, sort: 'artist' }).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(viewSongs(songs, { ...q, sort: 'bpm' }).map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(viewSongs(songs, { ...q, sort: 'level' }).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(viewSongs(songs, { ...q, sort: 'checks' }).map((s) => s.id)[0]).toBe('c');
  });

  it('しぼりこみの数', () => {
    expect(warnCount(songs[2])).toBe(1);
    expect(filterCounts(songs, { b: ['e.dtx'] })).toEqual({ missing: 2, edited: 1, ai: 1, drive: 1, synced: 0, draft: 1, checks: 1 });
    expect(viewSongs(songs, { ...q, filter: 'ai' }).map((s) => s.id)).toEqual(['b']);
    // 同期で変わった曲（場所の鍵:曲のフォルダの並び）
    const synced = new Set([`${songs[0].root}:${songs[0].path.join('/')}`]);
    expect(filterCounts(songs, {}, synced).synced).toBe(1);
    expect(viewSongs(songs, { ...q, filter: 'synced', synced }).map((s) => s.id)).toEqual([songs[0].id]);
  });
});

describe('set.def', () => {
  it('作る：枠の譜面は L1〜L4、枠に入らない譜面は L5', () => {
    const t = setDefFor('Neon Rain', [chart('a/bsc.dtx', 'BSC', 3), chart('mas.dtx', 'MAS', 8), chart('extra.dtx', null, 9)]);
    expect(t).toBe(['#TITLE Neon Rain', '#L1LABEL BASIC', '#L1FILE a\\bsc.dtx', '#L4LABEL MASTER', '#L4FILE mas.dtx', '#L5LABEL DTXMANIA', '#L5FILE extra.dtx', ''].join('\r\n'));
  });

  it('直す：無い譜面の行だけ外す（ブロックごと・改行はそのまま）', () => {
    const text = ['#TITLE A', '#L1LABEL BASIC', '#L1FILE bsc.dtx', '#L2LABEL ADVANCED', '#L2FILE sub\\adv.dtx', '', '#TITLE B', '#L2LABEL ADV', '#L2FILE b-adv.dtx', ''].join('\r\n');
    const out = fixSetDef(text, ['sub/adv.dtx']);
    expect(out).toBe(['#TITLE A', '#L1LABEL BASIC', '#L1FILE bsc.dtx', '', '#TITLE B', '#L2LABEL ADV', '#L2FILE b-adv.dtx', ''].join('\r\n'));
    // 大文字・小文字の違いも同じファイル
    expect(fixSetDef('#TITLE A\n#L1LABEL X\n#L1FILE BSC.DTX\n', ['bsc.dtx'])).toBe('#TITLE A\n');
  });
});

describe('探す場所', () => {
  it('DTXFiles を選んだらその中だけ', () => {
    expect(rootSpecs({ kind: 'dtxfiles', dtxPath: ['D:\\x\\'], extra: [] })).toEqual([{ key: '', label: '.\\', rel: [] }]);
  });

  it('ゲームのフォルダなら DTXPath（重なる場所は外側だけ・外のドライブは別）', () => {
    const specs = rootSpecs({ kind: 'game', dtxPath: ['.\\DTXFiles\\', '.\\', 'Songs\\', 'D:\\DTX\\'], extra: [{ path: 'D:\\DTX\\' }] });
    expect(specs).toEqual([
      { key: '', label: '.\\', rel: [] },
      { key: 'x0', label: 'D:\\DTX\\', rel: null, extra: 0 },
    ]);
    const two = rootSpecs({ kind: 'game', dtxPath: ['DTXFiles\\', 'Songs\\', 'songs\\'], extra: [] });
    expect(two.map((s) => [s.key, s.rel])).toEqual([
      ['', ['DTXFiles']],
      ['p1', ['Songs']],
    ]);
  });
});

describe('表示の文字', () => {
  it('BPM・レベル・大きさ', () => {
    expect(bpmText('128.00')).toBe('128');
    expect(bpmText('92.345')).toBe('92.35');
    expect(bpmText('')).toBe('');
    expect(levelText(8.25)).toBe('8.25');
    expect(levelText(null)).toBe('?');
    expect(bytesText(500)).toBe('1 KB');
    expect(bytesText(0)).toBe('0 KB');
    expect(bytesText(24 * 1024 * 1024)).toBe('24 MB');
    expect(bytesText(6.6 * 1024 * 1024)).toBe('6.6 MB');
    expect(bytesText(1.3 * 1024 * 1024 * 1024)).toBe('1.3 GB');
  });
});

describe('新しい曲を保存する所', () => {
  const boxes: LibBox[] = [
    { key: ':dtxfiles/original', title: 'オリジナル', dirName: 'Original', dot: false, parent: null, depth: 0, root: '', path: ['DTXFiles', 'Original'] },
    { key: ':dtxfiles/original/practice', title: '練習', dirName: 'DTXFiles.練習', dot: true, parent: ':dtxfiles/original', depth: 1 },
  ];
  const game = { kind: 'game' as const, name: 'DTXManiaNX', dtxPath: ['.\\'], extra: [] };

  it('BOX の札は外から', () => {
    expect(saveBoxLabel(boxes[1], boxes)).toBe('オリジナル › 練習');
  });

  it('ゲームのフォルダ（.\\）なら BOX の外は DTXFiles の中（綴りは一覧から）', () => {
    expect(outsideRel(game, [{ root: '', path: ['dtxFiles', 'Song'] }], [])).toEqual(['dtxFiles']);
    expect(outsideRel(game, [], [])).toEqual(['DTXFiles']);
    expect(outsideRel({ ...game, dtxPath: ['.\\Songs\\'] }, [], [])).toEqual([]);
    expect(outsideRel({ ...game, kind: 'dtxfiles', name: 'DTXFiles' }, [], [])).toEqual([]);
  });

  it('書く所の並び', () => {
    expect(saveWhere(game, [], boxes, ':dtxfiles/original')).toEqual(['DTXManiaNX', 'DTXFiles', 'Original']);
    // 前の版の一覧（元の綴りが無い）は鍵の並び
    expect(saveWhere(game, [], boxes, ':dtxfiles/original/practice')).toEqual(['DTXManiaNX', 'dtxfiles', 'original', 'practice']);
    expect(saveWhere(game, [], boxes, '', '新しい BOX')).toEqual(['DTXManiaNX', 'DTXFiles', '新しい BOX']);
    expect(saveWhere({ kind: 'dtxfiles', name: 'DTXFiles', dtxPath: [], extra: [] }, [], [], '')).toEqual(['DTXFiles']);
  });
});
