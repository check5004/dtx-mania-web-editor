import { describe, expect, it } from 'vitest';
import { sortByDifficulty } from './diffTabs';

const names = (xs: { file: string }[]) => xs.map((x) => x.file);

describe('難易度タブの並び', () => {
  it('ファイル名の順ではなく、易しい順（BASIC → MASTER）に並べる', () => {
    const list = [
      { file: 'adv.dtx', label: 'ADVANCED' },
      { file: 'bsc.dtx', label: 'BASIC' },
      { file: 'ext.dtx', label: 'EXTREME' },
      { file: 'mstr.dtx', label: 'MASTER' },
    ];
    expect(names(sortByDifficulty(list))).toEqual(['bsc.dtx', 'adv.dtx', 'ext.dtx', 'mstr.dtx']);
  });

  it('set.def が無くても、ファイル名から難易度が分かれば並べる', () => {
    const list = [
      { file: 'song-mas.dtx', label: 'song-mas' },
      { file: 'song-adv.dtx', label: 'song-adv' },
      { file: 'song-bas.dtx', label: 'song-bas' },
    ];
    expect(names(sortByDifficulty(list))).toEqual(['song-bas.dtx', 'song-adv.dtx', 'song-mas.dtx']);
  });

  it('難易度の名前でない譜面は後ろに、set.def の順で並べる', () => {
    const list = [
      { file: 'zz.dtx', label: 'DTXMANIA' },
      { file: 'mstr.dtx', label: 'MASTER' },
      { file: 'a.dtx', label: 'RAW' },
      { file: 'bsc.dtx', label: 'BASIC' },
    ];
    // set.def では zz（L5 より前に書いた）→ a の順
    expect(names(sortByDifficulty(list, ['bsc.dtx', 'mstr.dtx', 'zz.dtx', 'a.dtx']))).toEqual(['bsc.dtx', 'mstr.dtx', 'zz.dtx', 'a.dtx']);
    // set.def に無ければファイル名の順
    expect(names(sortByDifficulty(list))).toEqual(['bsc.dtx', 'mstr.dtx', 'a.dtx', 'zz.dtx']);
  });

  it('同じ難易度が2つあれば set.def の順（AI で作った別名の譜面など）', () => {
    const list = [
      { file: 'adv_ai.dtx', label: 'adv_ai' },
      { file: 'adv.dtx', label: 'ADVANCED' },
    ];
    // adv_ai は名前から難易度が分からない（_ai で終わる）ので後ろ
    expect(names(sortByDifficulty(list, ['adv.dtx']))).toEqual(['adv.dtx', 'adv_ai.dtx']);
  });
});
