import { describe, expect, it } from 'vitest';
import { deskTracksHeight } from './layout';
import {
  deskStopHeight,
  deskTrackStops,
  fitRowHeight,
  magnetHeight,
  padDensity,
  SHEET_GRIP,
  SHEET_H,
  SHEET_TABS,
  snapHeight,
  snapSheet,
  stepDeskStop,
  stepSheet,
  trackStops,
} from './sheetSnap';

describe('縦のシートの止まる高さ', () => {
  const maxH = 800;

  it('ゆっくり離したら、いちばん近い高さ', () => {
    expect(snapSheet(90, 0, maxH)).toBe('tabs');
    expect(snapSheet(180, 0, maxH)).toBe('slim');
    expect(snapSheet(260, 0, maxH)).toBe('low');
    expect(snapSheet(380, 0, maxH)).toBe('half');
    expect(snapSheet(560, 0, maxH)).toBe('full');
  });

  it('はじいたら、その向きの先の高さ（上は＋、下は−）', () => {
    // 半分から少しだけ上へはじく → 大
    expect(snapSheet(440, 1.2, maxH)).toBe('full');
    // 半分から少しだけ下へはじく → 低い
    expect(snapSheet(400, -1, maxH)).toBe('low');
    // 細いから強く下へ → タブだけ
    expect(snapSheet(190, -2, maxH)).toBe('tabs');
    // とても強くはじいても、行き過ぎは端の高さ
    expect(snapSheet(300, 40, maxH)).toBe('full');
  });

  it('画面が低くて上の段が入らないときは、入る高さで止める（同じ高さなら小さい方）', () => {
    expect(snapSheet(500, 0, 380)).toBe('half');
    expect(Math.min(380, SHEET_H.half)).toBe(380);
  });

  it('矢印キーで1段ずつ（上限で同じ高さの段は飛ばす）', () => {
    expect(stepSheet('tabs', 1, maxH)).toBe('slim');
    expect(stepSheet('slim', 1, maxH)).toBe('low');
    expect(stepSheet('full', 1, maxH)).toBe('full');
    expect(stepSheet('slim', -1, maxH)).toBe('tabs');
    expect(stepSheet('tabs', -1, maxH)).toBe('tabs');
    expect(stepSheet('full', -1, 350)).toBe('low');
  });

  it('止まる高さが無ければそのまま', () => {
    expect(snapHeight(123, 0, [])).toBe(123);
  });
});

describe('横のトラックの帯の止まる高さ', () => {
  it('閉じた帯、1本ずつ、全部をゆったり', () => {
    expect(trackStops(3, { closed: 52, ruler: 52, row: 56, roomy: 72, maxH: 600 })).toEqual([52, 109, 165, 221, 269]);
  });

  it('画面に入らない段は入れない', () => {
    expect(trackStops(6, { closed: 52, ruler: 52, row: 56, roomy: 72, maxH: 250 })).toEqual([52, 109, 165, 221]);
  });
});

describe('トラックの 1 本の高さ', () => {
  it('全部入るなら均等（上限まで）', () => {
    expect(fitRowHeight(200, 3, 48, 72)).toBe(66);
    expect(fitRowHeight(400, 3, 48, 72)).toBe(72);
  });

  it('入らないなら、半端に切れないように入る本数で割る', () => {
    // 115px に 48px 以上で入るのは 2 本 → 57
    expect(fitRowHeight(115, 5, 48, 72)).toBe(57);
    // 1 本も入らないほど低いときは最小
    expect(fitRowHeight(30, 3, 48, 72)).toBe(48);
  });
});

describe('シートの高さごとのパッドの並べ方', () => {
  const body = (size: keyof typeof SHEET_H) => SHEET_H[size] - SHEET_GRIP - SHEET_TABS;
  it('キット：細い＝横1列、低い＝4×3を詰める、半分・大＝説明つき', () => {
    expect(padDensity('kit', 796, body('slim'))).toBe('row');
    expect(padDensity('kit', 796, body('low'))).toBe('compact');
    expect(padDensity('kit', 796, body('half'))).toBe('roomy');
    expect(padDensity('kit', 796, body('full'))).toBe('roomy');
  });
  it('キット：幅が狭ければ高くても説明の箱は出さない', () => {
    expect(padDensity('kit', 520, body('full'))).toBe('compact');
  });
  it('レーン：細いときだけ上下に割らない', () => {
    expect(padDensity('lane', 796, body('slim'))).toBe('row');
    expect(padDensity('lane', 796, body('low'))).toBe('roomy');
  });
});

describe('PC の下のトラックの止まる高さ', () => {
  // 上の帯 28＋線 1＋トラック
  it('閉じる・1本・細く（24）・標準（42）・ゆったり（64）', () => {
    expect(deskTrackStops(3, 28, 560)).toEqual([
      { stop: 'closed', h: 28 },
      { stop: 'one', h: 53 },
      { stop: 'slim', h: 101 },
      { stop: 'std', h: 155 },
      { stop: 'roomy', h: 221 },
    ]);
  });

  it('画面に入らない段は入れない。1本しかなければ「1本」と「細く」は同じなので1つ', () => {
    expect(deskTrackStops(8, 28, 400).map((s) => s.stop)).toEqual(['closed', 'one', 'slim', 'std']);
    expect(deskTrackStops(1, 28, 560).map((s) => s.stop)).toEqual(['closed', 'one', 'std', 'roomy']);
  });

  it('ドラッグ中は 10px 以内なら止まる高さに吸い付き、離れていればそのまま', () => {
    const stops = deskTrackStops(3, 28, 560);
    expect(magnetHeight(108, stops)).toEqual({ h: 101, stop: 'slim' });
    expect(magnetHeight(150, stops)).toEqual({ h: 155, stop: 'std' });
    expect(magnetHeight(128, stops)).toEqual({ h: 128 });
  });

  it('矢印キーで 1 段ずつ（止まる高さの間からは、その向きの次へ）', () => {
    const stops = deskTrackStops(3, 28, 560);
    expect(stepDeskStop(28, 1, stops)?.stop).toBe('one');
    expect(stepDeskStop(128, 1, stops)?.stop).toBe('std');
    expect(stepDeskStop(128, -1, stops)?.stop).toBe('slim');
    expect(stepDeskStop(221, 1, stops)).toBeNull();
    expect(stepDeskStop(28, -1, stops)).toBeNull();
  });

  it('止まる高さはトラックの数に合わせて伸びる', () => {
    expect(deskStopHeight('std', 3, 28)).toBe(155);
    expect(deskStopHeight('std', 5, 28)).toBe(239);
    expect(deskStopHeight('one', 5, 28)).toBe(53);
  });

  it('今の高さ：名前で止めていればトラックの数で決め、px でもゆったり並べた高さ・画面の上限より高くしない', () => {
    expect(deskTracksHeight({ seekOpen: true, tracksH: 101, tracksStop: 'slim' }, 5, 560)).toBe(149);
    expect(deskTracksHeight({ seekOpen: true, tracksH: 400 }, 3, 560)).toBe(221);
    expect(deskTracksHeight({ seekOpen: true, tracksH: 400, tracksStop: 'roomy' }, 8, 300)).toBe(300);
    expect(deskTracksHeight({ seekOpen: false, tracksH: 400 }, 3, 560)).toBe(28);
  });

  it('PC のトラック 1 本の高さも半端に切れない（細く 24〜ゆったり 64）', () => {
    // 53px の帯：1本だけ（24）
    expect(fitRowHeight(24, 5, 24, 64)).toBe(24);
    // 標準の高さなら 42 ずつ
    expect(fitRowHeight(155 - 29, 3, 24, 64)).toBe(42);
  });
});
