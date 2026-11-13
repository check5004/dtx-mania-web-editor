import { describe, expect, it } from 'vitest';
import { ghostSection, kindOf, scoreGroupOf } from './kind';
import { decodeScore, drumSummary, encodeScore, mergeScoreIni, nxDateValue, parseIni, sectionOf, valueOf } from './scoreIni';

/** NX の CScoreIni.tExport と同じ形（必要な所だけ） */
function ini(o: { plays: number; clears?: number; rank?: number; hc: number; hist: string[]; hi?: number; skill?: number; last?: string; title?: string; bgm?: number }) {
  const lines = [
    '[File]',
    `Title=${o.title ?? 'Iron Pulse'}`,
    'Name=',
    'Hash=abc',
    `PlayCountDrums=${o.plays}`,
    'PlayCountGuitars=0',
    'PlayCountBass=0',
    `ClearCountDrums=${o.clears ?? o.plays}`,
    'ClearCountGuitars=0',
    'ClearCountBass=0',
    `BestRankDrums=${o.rank ?? 99}`,
    'BestRankGuitar=99',
    'BestRankBass=99',
    `HistoryCount=${o.hc}`,
    ...[0, 1, 2, 3, 4].map((i) => `History${i}=${o.hist[i] ?? ''}`),
    `BGMAdjust=${o.bgm ?? 0}`,
    '',
    '[HiScore.Drums]',
    `Score=${o.hi ?? 0}`,
    `PlaySkill=${o.skill ?? 0}`,
    'DateTime=',
    'Hash=h1',
    '[HiSkill.Drums]',
    `Score=${o.hi ?? 0}`,
    `PlaySkill=${o.skill ?? 0}`,
    'DateTime=',
    'Hash=h2',
    '[LastPlay.Drums]',
    `Score=${o.hi ?? 0}`,
    `PlaySkill=${o.skill ?? 0}`,
    `DateTime=${o.last ?? ''}`,
    'Hash=h3',
    '[HiScore.Guitar]',
    'Score=0',
    'Hash=g',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

describe('作るファイルと遊ぶファイル', () => {
  it('成績とゴーストは遊ぶファイル、ほかは作るファイル', () => {
    expect(kindOf('mstr.dtx.score.ini')).toBe('play');
    expect(kindOf('MSTR.DTX.HiScore.dr.ghost')).toBe('play');
    expect(kindOf('mstr.dtx.lastplay.bs.ghost')).toBe('play');
    expect(kindOf('mstr.dtx')).toBe('make');
    expect(kindOf('set.def')).toBe('make');
    expect(kindOf('bgm.ogg')).toBe('make');
    expect(kindOf('mstr.dtxe.json')).toBe('make');
    expect(scoreGroupOf('Mstr.dtx.score.ini')).toBe('mstr.dtx');
    expect(scoreGroupOf('sub/ext.dtx.hiskill.dr.ghost')).toBe('sub/ext.dtx');
    expect(scoreGroupOf('mstr.dtx')).toBeNull();
    expect(ghostSection('mstr.dtx.hiskill.dr.ghost')).toBe('HiSkill.Drums');
    expect(ghostSection('mstr.dtx.lastplay.gt.ghost')).toBe('LastPlay.Guitar');
  });
});

describe('score.ini を読む・書く', () => {
  it('知らない行も残して書き戻せる', () => {
    const text = ini({ plays: 3, hc: 3, hist: ['3.26/11/13 Cleared (S)'] }).replace('Hash=abc', 'Hash=abc\r\nUnknownKey=1');
    const p = parseIni(text);
    expect(valueOf(sectionOf(p, 'File'), 'unknownkey')).toBe('1');
    expect(p.eol).toBe('\r\n');
  });
  it('Shift_JIS のまま読み書きする', () => {
    const text = ini({ plays: 1, hc: 1, hist: [], title: '群青ハイウェイ' });
    const bytes = encodeScore(text, 'shift_jis');
    const back = decodeScore(bytes);
    expect(back.encoding).toBe('shift_jis');
    expect(back.text).toBe(text);
  });
  it('DTXMania の DateTime を比べられる（日本・US の書き方）', () => {
    expect(nxDateValue('2026/11/13 21:40:12')!).toBeGreaterThan(nxDateValue('2026/11/12 23:05:00')!);
    expect(nxDateValue('11/13/2026 9:40:12 PM')).toBe(nxDateValue('2026/11/13 21:40:12'));
    expect(nxDateValue('')).toBeNull();
  });
});

describe('成績をまとめる', () => {
  const base = ini({ plays: 5, rank: 2, hc: 5, hist: ['5.26/11/10 Cleared (A)', '4.26/11/9 Cleared (B)', '3.26/11/8 Cleared (B)', '2.26/11/7 Failed', '1.26/11/6 Failed'], hi: 700000, skill: 80.5, last: '2026/11/10 20:00:00' });
  it('回数は両方で増えた分を足す・いい記録の節は良い方・最後に遊んだのは新しい方', () => {
    // 作るPC で 2 回、遊ぶPC で 4 回遊んだ
    const make = ini({ plays: 7, rank: 2, hc: 7, hist: ['7.26/11/12 Cleared (A)', '6.26/11/12 Failed', '5.26/11/10 Cleared (A)', '4.26/11/9 Cleared (B)', '3.26/11/8 Cleared (B)'], hi: 812400, skill: 89.2, last: '2026/11/12 23:05:00' });
    const play = ini({
      plays: 9,
      rank: 1,
      hc: 9,
      hist: ['9.26/11/13 Cleared (S)', '8.26/11/13 Cleared (S)', '7.26/11/11 Cleared (A)', '6.26/11/11 Cleared (B)', '5.26/11/10 Cleared (A)'],
      hi: 845100,
      skill: 93.6,
      last: '2026/11/13 21:40:00',
      bgm: 3,
    });
    const r = mergeScoreIni(base, { text: make, time: 1000 }, { text: play, time: 2000 });
    const m = parseIni(r.text);
    const f = sectionOf(m, 'File');
    expect(valueOf(f, 'PlayCountDrums')).toBe('11'); // 5 + 2 + 4
    expect(valueOf(f, 'ClearCountDrums')).toBe('11');
    expect(valueOf(f, 'BestRankDrums')).toBe('1');
    expect(valueOf(f, 'HistoryCount')).toBe('11');
    // 新しい 5 件を日付の順に、番号はふり直す
    expect([0, 1, 2, 3, 4].map((i) => valueOf(f, `History${i}`))).toEqual(['11.26/11/13 Cleared (S)', '10.26/11/13 Cleared (S)', '9.26/11/12 Cleared (A)', '8.26/11/12 Failed', '7.26/11/11 Cleared (A)']);
    // BGM のずれは新しく書かれた方（遊ぶPC）
    expect(valueOf(f, 'BGMAdjust')).toBe('3');
    expect(valueOf(sectionOf(m, 'HiScore.Drums'), 'Score')).toBe('845100');
    expect(valueOf(sectionOf(m, 'HiSkill.Drums'), 'PlaySkill')).toBe('93.6');
    expect(valueOf(sectionOf(m, 'LastPlay.Drums'), 'DateTime')).toBe('2026/11/13 21:40:00');
    expect(r.pick['hiscore.drums']).toBe('remote');
    expect(r.pick['lastplay.drums']).toBe('remote');
    expect(r.text.endsWith('\r\n')).toBe(true);
    expect(r.text.includes('\n') && !/[^\r]\n/.test(r.text)).toBe(true);
  });
  it('いい点の節は点の高い方（新しくても低ければ取らない）', () => {
    const a = ini({ plays: 6, hc: 6, hist: [], hi: 900000, skill: 95, last: '2026/11/11 10:00:00' });
    const b = ini({ plays: 6, hc: 6, hist: [], hi: 500000, skill: 70, last: '2026/11/12 10:00:00' });
    const r = mergeScoreIni(base, { text: a, time: 1 }, { text: b, time: 9 });
    expect(r.pick['hiscore.drums']).toBe('local');
    expect(r.pick['hiskill.drums']).toBe('local');
    expect(r.pick['lastplay.drums']).toBe('remote');
    expect(drumSummary(r.text)).toEqual({ plays: 7, rank: null, skill: 95 });
  });
  it('初めての同期（前が無い）は多い方', () => {
    const a = ini({ plays: 12, hc: 12, hist: ['12.26/11/2 Cleared'] });
    const b = ini({ plays: 4, hc: 4, hist: ['4.26/11/13 Cleared'] });
    const r = mergeScoreIni(null, { text: a, time: 1 }, { text: b, time: 2 });
    const f = sectionOf(parseIni(r.text), 'File');
    expect(valueOf(f, 'PlayCountDrums')).toBe('12');
    expect(valueOf(f, 'History0')).toBe('12.26/11/13 Cleared');
    expect(valueOf(f, 'History1')).toBe('11.26/11/2 Cleared');
  });
  it('片方にしかない節も残す（ギター・ベースの節も消さない）', () => {
    const a = ini({ plays: 1, hc: 1, hist: [] });
    const b = ini({ plays: 1, hc: 1, hist: [] }).replace(/\[HiScore\.Guitar\][\s\S]*$/, '');
    const r = mergeScoreIni(null, { text: b, time: 5 }, { text: a, time: 1 });
    expect(valueOf(sectionOf(parseIni(r.text), 'HiScore.Guitar'), 'Hash')).toBe('g');
  });
});
