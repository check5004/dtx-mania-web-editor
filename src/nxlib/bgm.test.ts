import { describe, expect, it } from 'vitest';
import { checkFits, checkReusable, countBdSd, drumsByCount, listenWindows, LISTEN_SEC, perMinute, type BgmCheck } from './bgm';

describe('BGM の聞く所', () => {
  it('25%・50%・75% の所を真ん中に 12 秒ずつ', () => {
    expect(listenWindows(200)).toEqual([
      { from: 44, to: 56 },
      { from: 94, to: 106 },
      { from: 144, to: 156 },
    ]);
  });

  it('40 秒より短い BGM は全部。長さが分からなければ聞かない', () => {
    expect(listenWindows(30)).toEqual([{ from: 0, to: 30 }]);
    expect(listenWindows(LISTEN_SEC * 3 + 3.9)).toEqual([{ from: 0, to: LISTEN_SEC * 3 + 3.9 }]);
    expect(listenWindows(0)).toEqual([]);
    expect(listenWindows(NaN)).toEqual([]);
  });

  it('聞く所は曲の中に収める', () => {
    for (const w of listenWindows(41)) {
      expect(w.from).toBeGreaterThanOrEqual(0);
      expect(w.to).toBeLessThanOrEqual(41);
      expect(w.to - w.from).toBe(LISTEN_SEC);
    }
  });
});

describe('バスドラム・スネアの数', () => {
  it('BD と SD だけ、頭と終わりの 0.25 秒を除いて数える', () => {
    const hits = [
      { t: 0.1, cls: 'BD' as const },
      { t: 1, cls: 'BD' as const },
      { t: 2, cls: 'SD' as const },
      { t: 3, cls: 'HH' as const },
      { t: 11.9, cls: 'SD' as const },
    ];
    expect(countBdSd(hits, 12)).toBe(2);
  });

  it('1 分あたりの数は、数えた長さ（各所から頭と終わりを除く）で割る', () => {
    const w = listenWindows(200);
    // 3 か所 × 11.5 秒 = 34.5 秒で 69 回 → 1 分に 120 回
    expect(perMinute(69, w)).toBeCloseTo(120, 5);
    expect(perMinute(5, [])).toBe(0);
  });

  it('1 分に 20 回からドラム入り（エディタの「原曲にドラムが聞こえるか」と同じ）', () => {
    expect(drumsByCount(19.9)).toBe(false);
    expect(drumsByCount(20)).toBe(true);
    expect(drumsByCount(257)).toBe(true);
  });
});

describe('前の結果を使うか', () => {
  const prev: BgmCheck = { chart: 'Song/mas.dtx', chartSig: '100:5', path: 'song/bgm.ogg', name: 'bgm.ogg', sig: '9000:7', state: 'drums', perMin: 250 };

  it('同じ譜面（名前は大文字小文字を見ない・大きさ・更新時刻）なら、BGM のファイルは決め直さない', () => {
    expect(checkFits(prev, { file: 'song/MAS.dtx', size: 100, mtime: 5 })).toBe(true);
    expect(checkFits(prev, { file: 'song/mas.dtx', size: 101, mtime: 5 })).toBe(false);
    expect(checkFits(prev, { file: 'song/ext.dtx', size: 100, mtime: 5 })).toBe(false);
    expect(checkFits(undefined, { file: 'song/mas.dtx', size: 100, mtime: 5 })).toBe(false);
  });

  it('同じ BGM のファイル（大きさ・更新時刻）で、聞けた・名前で決めた結果だけ聞き直さない', () => {
    expect(checkReusable(prev, 'song/bgm.ogg', '9000:7')).toBe(true);
    expect(checkReusable(prev, 'song/bgm.ogg', '9001:7')).toBe(false);
    expect(checkReusable(prev, 'song/bgm_drumless.ogg', '9000:7')).toBe(false);
    expect(checkReusable({ ...prev, state: 'clean' }, 'song/bgm.ogg', '9000:7')).toBe(true);
    expect(checkReusable({ ...prev, state: 'named' }, 'song/bgm.ogg', '9000:7')).toBe(true);
    // 読めなかった・見つからなかったときは、もう一度
    expect(checkReusable({ ...prev, state: 'error' }, 'song/bgm.ogg', '9000:7')).toBe(false);
    expect(checkReusable({ ...prev, state: 'missing' }, 'song/bgm.ogg', '9000:7')).toBe(false);
  });
});
