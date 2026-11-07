import { describe, expect, it } from 'vitest';
import { detectIos, detectSafari, detectWebkit, parseSafariVersion } from './platform';

// 実機の UA（iPad の Safari は既定で Mac と名乗る。指で触れるか＝maxTouchPoints で見分ける）
const UA = {
  ipadSafariDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  ipadSafariMobile: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  ipadChrome: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.89 Mobile/15E148 Safari/604.1',
  iphoneSafari26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

describe('ブラウザの判定（Safari 向けの分岐に使う）', () => {
  it('iPad の Safari は Mac と名乗っても、指で触れれば iPad・WebKit・Safari', () => {
    expect(detectIos(UA.ipadSafariDesktop, 5)).toBe(true);
    expect(detectWebkit(UA.ipadSafariDesktop, 5)).toBe(true);
    expect(detectSafari(UA.ipadSafariDesktop, 5)).toBe(true);
    expect(detectSafari(UA.ipadSafariMobile, 5)).toBe(true);
  });

  it('iPad の Chrome は WebKit だが Safari ではない（Chrome の印があれば Mac の UA でも）', () => {
    expect(detectWebkit(UA.ipadChrome, 5)).toBe(true);
    expect(detectSafari(UA.ipadChrome, 5)).toBe(false);
    expect(detectSafari(UA.ipadSafariDesktop, 5, true)).toBe(false);
    expect(detectSafari(UA.iphoneFirefox, 5)).toBe(false);
  });

  it('Mac の Safari は WebKit・Safari で、iPad ではない', () => {
    expect(detectIos(UA.macSafari, 0)).toBe(false);
    expect(detectWebkit(UA.macSafari, 0)).toBe(true);
    expect(detectSafari(UA.macSafari, 0)).toBe(true);
  });

  it('PC・Android の Chrome・Edge・Firefox は WebKit ではない（PC の動きは変えない）', () => {
    for (const ua of [UA.macChrome, UA.winChrome, UA.winEdge, UA.macFirefox, UA.android]) {
      expect(detectIos(ua, 0)).toBe(false);
      expect(detectWebkit(ua, 0)).toBe(false);
      expect(detectSafari(ua, 0)).toBe(false);
    }
    // タッチのある Windows の PC も iPad とは見ない
    expect(detectIos(UA.winChrome, 10)).toBe(false);
  });

  it('Safari の版を読む（Version が無い iPad のブラウザは OS の版）', () => {
    expect(parseSafariVersion(UA.ipadSafariDesktop)).toEqual([18, 4]);
    expect(parseSafariVersion(UA.iphoneSafari26)).toEqual([26, 0]);
    expect(parseSafariVersion(UA.ipadChrome)).toEqual([17, 4]);
    expect(parseSafariVersion(UA.winChrome)).toBeNull();
  });
});
