import { describe, expect, it } from 'vitest';
import { boxTitleOf, chartRefGroups, decodeHead, dotBoxName, dtxPathsOf, hasDrumChips, headIncomplete, levelOf, parseScoreIni, readChartHead, relDtxPath } from './parse';

describe('レベル（NX と同じ読み方）', () => {
  it('#DLEVEL が 100 以上なら 3 桁（825 → 8.25）', () => {
    expect(levelOf('825')).toBe(8.25);
    expect(levelOf('990')).toBe(9.9);
    expect(levelOf('100')).toBe(1);
  });
  it('2 桁なら #DLVDEC を小数の 2 桁目に（82・5 → 8.25）。#DLVDEC が無ければ 0', () => {
    expect(levelOf('82', '5')).toBe(8.25);
    expect(levelOf('82')).toBe(8.2);
    expect(levelOf('76', '')).toBe(7.6);
    expect(levelOf('8')).toBe(0.8);
  });
  it('書いていない・数でなければ null', () => {
    expect(levelOf(undefined)).toBeNull();
    expect(levelOf('')).toBeNull();
    expect(levelOf('abc')).toBeNull();
    expect(levelOf('-1')).toBeNull();
  });
});

describe('譜面の頭', () => {
  it('曲名・アーティスト・BPM・レベル・画像・試聴を読む。「;」から後は注釈。同じキーは最初の行', () => {
    const h = readChartHead(
      [
        '; 作った人のメモ',
        '#TITLE: Neon Rain',
        '#ARTIST Kiri ; 仮の名前',
        '#BPM 128.00',
        '#DLEVEL 82',
        '#DLVDEC 5',
        '#PREIMAGE jacket.png',
        '#PREVIEW pre.ogg',
        '#TITLE ちがう曲名',
        '#00111: 01',
      ].join('\r\n'),
    );
    expect(h).toEqual({ title: 'Neon Rain', artist: 'Kiri', bpm: '128.00', level: 8.25, preimage: 'jacket.png', stagefile: '', preview: 'pre.ogg', ai: false });
    expect(headIncomplete(h)).toBe(false);
  });
  it('AI難易度生成で作った譜面の印', () => {
    expect(readChartHead('#DTXE_ORIGIN AI 2026-11-11 from MASTER\n#TITLE x\n#DLEVEL 40').ai).toBe(true);
    expect(readChartHead('#DTXE_ORIGIN MANUAL\n#TITLE x').ai).toBe(false);
  });
  it('曲名かレベルが無ければ読み残し', () => {
    expect(headIncomplete(readChartHead('#TITLE x'))).toBe(true);
    expect(headIncomplete(readChartHead('#DLEVEL 50'))).toBe(true);
  });
  it('途中で切れた最後の行は捨てる（UTF-8 の字の途中で切れても Shift_JIS と見誤らない）', () => {
    const bytes = new TextEncoder().encode('#TITLE 雨の音\n#ARTIST 霧');
    // 「霧」の途中で切る
    const cut = bytes.subarray(0, bytes.length - 1);
    expect(decodeHead(cut, false)).toBe('#TITLE 雨の音\n');
    expect(decodeHead(bytes, true)).toBe('#TITLE 雨の音\n#ARTIST 霧');
  });
});

describe('成績（*.score.ini）', () => {
  it('ドラムの回数・いちばん良いランク・達成率', () => {
    const r = parseScoreIni(
      [
        '[File]',
        'Title=Neon Rain',
        'PlayCountDrums=12',
        'PlayCountGuitars=3',
        'BestRankDrums=1',
        '',
        '[HiSkill.Drums]',
        'PlaySkill=93.4512',
        '[HiSkill.Guitar]',
        'PlaySkill=50',
      ].join('\r\n'),
    );
    expect(r).toEqual({ plays: 12, rank: 'S', skill: 93.5 });
  });
  it('まだ遊んでいなければランクも達成率も無し。99（分からない）も無し', () => {
    expect(parseScoreIni('[File]\nPlayCountDrums=0\nBestRankDrums=0\n[HiSkill.Drums]\nPlaySkill=80')).toEqual({ plays: 0, rank: null, skill: null });
    expect(parseScoreIni('[File]\nPlayCountDrums=2\nBestRankDrums=99')).toEqual({ plays: 2, rank: null, skill: null });
  });
});

describe('BOX と Config.ini', () => {
  it('「DTXFiles.」で始まるフォルダは BOX（名前はその後ろ）', () => {
    expect(dotBoxName('DTXFiles.EDM')).toBe('EDM');
    expect(dotBoxName('dtxfiles.アニメ')).toBe('アニメ');
    expect(dotBoxName('DTXFiles')).toBeNull();
    expect(dotBoxName('My DTXFiles.old')).toBeNull();
  });
  it('box.def の #TITLE', () => {
    expect(boxTitleOf('#TITLE ロック ; 注釈\n#FONTCOLOR #FFFFFF')).toBe('ロック');
    expect(boxTitleOf('#FONTCOLOR #FFFFFF')).toBe('');
  });
  it('DTXPath は「;」で区切って複数。書いていなければ「.\\」', () => {
    expect(dtxPathsOf('[System]\r\nDTXPath=.\\DTXFiles\\;D:\\DTX\\\r\nVSyncWait=1')).toEqual(['.\\DTXFiles\\', 'D:\\DTX\\']);
    expect(dtxPathsOf('[System]\nDTXPath=\n')).toEqual(['.\\']);
    expect(dtxPathsOf('[System]\nFullScreen=0')).toEqual(['.\\']);
  });
  it('ゲームのフォルダの中ならフォルダの並び、外（ほかのドライブ・..\\）なら null', () => {
    expect(relDtxPath('.\\')).toEqual([]);
    expect(relDtxPath('.\\DTXFiles\\')).toEqual(['DTXFiles']);
    expect(relDtxPath('Songs/Pack')).toEqual(['Songs', 'Pack']);
    expect(relDtxPath('D:\\DTX\\')).toBeNull();
    expect(relDtxPath('\\\\server\\dtx')).toBeNull();
    expect(relDtxPath('..\\曲')).toBeNull();
  });
});

describe('譜面の全体（点検）', () => {
  it('ドラムのチップがあるか（ギター・ベースだけ・全部 00 なら無い）', () => {
    expect(hasDrumChips('#TITLE x\n#00112: 0001')).toBe(true);
    expect(hasDrumChips('#0011C: 00000100')).toBe(true);
    expect(hasDrumChips('#00111: 0000\n#00120: 01')).toBe(false);
    expect(hasDrumChips('#00101: 01\n#00108: 0A')).toBe(false);
    // 2 回目も同じ（正規表現の位置が残らない）
    expect(hasDrumChips('#00113: 01')).toBe(true);
    expect(hasDrumChips('#00113: 01')).toBe(true);
  });
  it('使うファイルは値がファイル名の命令だけ。#PATH_WAV は中とそのままの両方。曲のフォルダの外は見ない', () => {
    const g = chartRefGroups(
      [
        '#TITLE Mr.Big.wav',
        '#COMMENT see readme.txt',
        '#BPM 128.00',
        '#PATH_WAV Sounds\\',
        '#WAV01 Kick.WAV',
        '#WAV02 kick.wav ; 同じファイル',
        '#WAV03 sub\\snare 01.wav',
        '#BMP01 ..\\shared\\bg.png',
        '#AVI01 C:\\movie.avi',
        '#PREVIEW pre.ogg',
        '#STAGEFILE stage.jpg',
        '#00111: 01',
      ].join('\n'),
    );
    expect(g).toEqual([
      { name: 'Kick.WAV', keys: ['kick.wav', 'sounds/kick.wav'] },
      { name: 'sub/snare 01.wav', keys: ['sub/snare 01.wav', 'sounds/sub/snare 01.wav'] },
      { name: 'pre.ogg', keys: ['pre.ogg', 'sounds/pre.ogg'] },
      { name: 'stage.jpg', keys: ['stage.jpg', 'sounds/stage.jpg'] },
    ]);
  });
});
