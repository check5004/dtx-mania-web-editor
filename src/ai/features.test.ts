import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../i18n';
import { aiFeature, aiFeatures, costText, keyFreeFeatures } from './features';
import { TASKS } from './tasks';
import { closeAiGuide, closeKeyGate, GUIDE_STEPS, openAiGuide, openKeyGate, stepGuide, useAiGuide, useKeyGate } from '../store/aiGuide';

afterEach(() => setLang('ja', false));

describe('AI を使う機能の一覧', () => {
  it('AI に頼む処理（TASKS）はどれも、一覧のどれかの機能が使っている', () => {
    // AI に頼む処理を足したら、features.ts の一覧にも足す（キーが無いときの説明と案内に出すため）
    const used = new Set(aiFeatures().map((f) => f.task));
    for (const t of TASKS) expect(used, `TASKS の ${t.id} が一覧に無い`).toContain(t.id);
  });

  it('機能の id は重ならず、aiFeature で引ける', () => {
    const ids = aiFeatures().map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(aiFeature(id).id).toBe(id);
  });

  it('どの言語でも、名前・どこから・キーで増えること・鍵を付けるボタンが書いてある', () => {
    for (const lang of ['ja', 'en'] as const) {
      setLang(lang, false);
      for (const f of aiFeatures()) {
        for (const k of ['name', 'where', 'withKey', 'withoutKey', 'locked'] as const) expect(f[k].trim(), `${lang} ${f.id}.${k}`).not.toBe('');
      }
      expect(keyFreeFeatures().length).toBeGreaterThan(3);
    }
  });

  it('英語の文に日本語が混ざっていない', () => {
    setLang('en', false);
    const jp = /[぀-ヿ一-龯]/;
    for (const f of aiFeatures()) for (const v of [f.name, f.where, f.withKey, f.withoutKey, f.locked]) expect(v).not.toMatch(jp);
    for (const v of keyFreeFeatures()) expect(v).not.toMatch(jp);
  });
});

describe('1 回の目安', () => {
  it('日本語はドルと円（1 ドル 150 円）、英語はドルだけ', () => {
    setLang('ja', false);
    expect(costText(0.02)).toBe('約 $0.02（3 円ほど）');
    expect(costText(0.0011)).toBe('約 $0.0011（0.2 円ほど）');
    expect(costText(0.117)).toBe('約 $0.117（18 円ほど）');
    expect(costText(null)).toBe('—');
    setLang('en', false);
    expect(costText(0.02)).toBe('about $0.02');
  });
});

describe('AI を使う準備の案内と「キーが要ります」', () => {
  it('案内は 6 つの手順で、前後に動いても端で止まる', () => {
    expect(GUIDE_STEPS).toEqual(['about', 'account', 'credits', 'key', 'paste', 'care']);
    openAiGuide();
    expect(useAiGuide.getState()).toMatchObject({ open: true, step: 'about', from: null });
    stepGuide(-1);
    expect(useAiGuide.getState().step).toBe('about');
    for (let i = 0; i < 10; i++) stepGuide(1);
    expect(useAiGuide.getState().step).toBe('care');
    closeAiGuide();
    expect(useAiGuide.getState().open).toBe(false);
  });

  it('説明の吹き出しから案内を開くと、吹き出しは閉じて、どの機能から来たかを覚える', () => {
    openKeyGate('level');
    expect(useKeyGate.getState().feature).toBe('level');
    openAiGuide('paste', 'level');
    expect(useKeyGate.getState().feature).toBe(null);
    expect(useAiGuide.getState()).toMatchObject({ open: true, step: 'paste', from: 'level' });
    closeAiGuide();
    closeKeyGate();
  });

  it('開くたびに動きを頭から流し直す', () => {
    const p = useAiGuide.getState().play;
    openAiGuide('credits');
    expect(useAiGuide.getState().play).toBe(p + 1);
    closeAiGuide();
  });
});
