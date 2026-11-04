import { afterEach, describe, expect, it } from 'vitest';
import { emptyDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { guidelinePrompt, guideSchema, levelSchema, planSchema } from '../ai/judge';
import { buildMeasureContext, measurePrompt, measureSchema } from '../ai/measureGen';
import { phraseSchema } from '../ai/phrase';
import { agentSystemPrompt } from '../ai/songAgent';
import { songInfoSchema } from '../ai/songInfo';
import { aiLangRule, aiTextLimit, getLang, pl, setLang, tr, withTr } from './index';

// テストは日本語で動かしている（src/test-setup.ts）。ここで英語にしたら必ず戻す
afterEach(() => setLang('ja', false));

describe('言語の切り替え', () => {
  it('tr・pl・withTr は今の言語の文を返す', () => {
    const o = withTr({ id: 'x', label: '' }, { label: ['全部', 'All'] });
    expect(tr('はい', 'Yes')).toBe('はい');
    expect(o.label).toBe('全部');
    setLang('en', false);
    expect(getLang()).toBe('en');
    expect(tr('はい', 'Yes')).toBe('Yes');
    expect(o.label).toBe('All');
    expect(`3 ${pl(3, 'note')}`).toBe('3 notes');
    expect(`1 ${pl(1, 'note')}`).toBe('1 note');
  });
});

describe('AI の答えの言語', () => {
  const doc = { ...emptyDoc(), fields: { BPM: '120' } };
  const measure = () => measurePrompt(buildMeasureContext(doc, buildTempoMap(doc), { from: 0, to: 0, onsets: null, offsetSec: 0, level: null, style: [], sectionOf: () => null }));
  const guide = () => guidelinePrompt({ stats: [], reps: {}, bands: [], confirmed: '' });
  const schemas = () => [phraseSchema(), measureSchema(), songInfoSchema(), levelSchema(), guideSchema(), planSchema()].map((s) => JSON.stringify(s.schema));

  it('日本語のときは、ユーザーが読む文を日本語で書かせる', () => {
    expect(measure().system).toContain(aiLangRule());
    expect(aiLangRule()).toContain('日本語');
    expect(aiTextLimit(12)).toBe('日本語で12字以内');
    for (const s of schemas()) expect(s).not.toContain('US English');
  });

  it('英語のときは、どの頼み方にも英語で書く指示が入り、字数の上限も英語向けに広げる', () => {
    setLang('en', false);
    for (const p of [measure().system, guide().system, agentSystemPrompt()]) expect(p).toContain('[Output language]');
    expect(aiTextLimit(12)).toBe('US English で30文字以内');
    for (const s of schemas()) expect(s).toContain('US English');
  });
});
