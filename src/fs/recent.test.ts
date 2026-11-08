import { describe, expect, it } from 'vitest';
import { groupRecent, songKeyOf, staleRecent, type RecentEntry } from './recent';

function entry(id: string, updatedAt: number, patch: Partial<RecentEntry> = {}): RecentEntry {
  const fileName = id.split('/').pop()!.replace(/#.*/, '');
  return { id, title: 'Calc.', artist: '', bpm: '173', level: '76', fileName, folderName: 'Calc', text: '', saved: true, updatedAt, ...patch };
}

describe('最近の曲（曲ごとに1つ）', () => {
  it('同じ曲フォルダの難易度は1つにまとめ、いちばん新しい難易度を出す', () => {
    const songs = groupRecent([entry('calc/mstr.dtx', 1), entry('calc/bsc.dtx', 3), entry('calc/ext.dtx', 2)]);
    expect(songs).toHaveLength(1);
    expect(songs[0].latest.fileName).toBe('bsc.dtx');
    expect(songs[0].entries.map((e) => e.fileName)).toEqual(['bsc.dtx', 'ext.dtx', 'mstr.dtx']);
  });

  it('本体の曲は曲の id で、フォルダの曲はフォルダの名前（大文字・小文字は見ない）でまとめる', () => {
    expect(songKeyOf(entry('local:abc/mstr.dtx', 1, { local: 'abc' }))).toBe(songKeyOf(entry('local:abc/ext.dtx', 2, { local: 'abc', folderName: 'Calc (2)' })));
    expect(songKeyOf(entry('local:abc/mstr.dtx', 1, { local: 'abc' }))).not.toBe(songKeyOf(entry('local:xyz/mstr.dtx', 1, { local: 'xyz' })));
    expect(songKeyOf(entry('calc/mstr.dtx', 1))).toBe(songKeyOf(entry('calc/adv.dtx', 1, { folderName: 'CALC' })));
    // 同じ名前でも、本体の曲と PC の曲フォルダは別の曲
    expect(songKeyOf(entry('local:abc/mstr.dtx', 1, { local: 'abc' }))).not.toBe(songKeyOf(entry('calc/mstr.dtx', 1)));
  });

  it('フォルダの無い新しい曲は、控えごとに別の曲', () => {
    const songs = groupRecent([entry('new/mstr.dtx#1', 1, { folderName: '' }), entry('new/mstr.dtx#2', 2, { folderName: '' })]);
    expect(songs).toHaveLength(2);
  });

  it('曲は新しい順。ほかの曲の難易度を開いても、まとめた曲の位置はその曲のいちばん新しい控えで決まる', () => {
    const songs = groupRecent([
      entry('calc/mstr.dtx', 1),
      entry('mephisto/mstr.dtx', 2, { folderName: 'Mephisto', title: 'メフィスト' }),
      entry('calc/ext.dtx', 3),
      entry('mephisto/bsc.dtx', 4, { folderName: 'Mephisto', title: 'メフィスト' }),
    ]);
    expect(songs.map((s) => `${s.latest.folderName}/${s.latest.fileName}`)).toEqual(['Mephisto/bsc.dtx', 'Calc/ext.dtx']);
  });

  it('古い控えを消すときは曲ごとに数え、その曲の難易度をまとめて消す。本体の曲は数えない・消さない', () => {
    const all = [
      entry('a/mstr.dtx', 10, { folderName: 'A' }),
      entry('a/ext.dtx', 9, { folderName: 'A' }),
      entry('a/bsc.dtx', 8, { folderName: 'A' }),
      entry('local:l/mstr.dtx', 7, { local: 'l', folderName: 'L' }),
      entry('b/mstr.dtx', 6, { folderName: 'B' }),
      entry('c/mstr.dtx', 5, { folderName: 'C' }),
      entry('c/adv.dtx', 4, { folderName: 'C' }),
    ];
    // 難易度を数えると 6 つだが、曲は A・B・C の 3 曲
    expect(staleRecent(all, 3)).toEqual([]);
    expect(staleRecent(all, 2).map((e) => e.id)).toEqual(['c/mstr.dtx', 'c/adv.dtx']);
  });
});
