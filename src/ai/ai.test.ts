import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures } from '../gen/features';
import { bandStats, levelOfField, predictLevel, type ChartEntry } from '../store/guideline';
import { buildSetDef, outFileName } from '../store/gen';
import { cleanJudgement, cleanPlan, sectionSpans } from './judge';
import { buildChatBody, parseJsonLoose, parseModels } from './openrouter';
import { decodeCandidates, enforcePlayable, measureGrid, ruleCandidates } from './phrase';
import { estimateCost, meetsNeeds, modelInfo, taskDef } from './tasks';
import { frac } from '../dtx/fraction';

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });
const doc = (chips: ReturnType<typeof chip>[], bpm = 120): DtxDoc => ({ ...emptyDoc(), fields: { BPM: String(bpm) }, chips, nextId: 999 });

function beat8(measures: number, start = 0): ReturnType<typeof chip>[] {
  const out = [];
  let id = start;
  for (let m = 0; m < measures; m++)
    for (let k = 0; k < 8; k++) {
      out.push(chip(id++, CH.HHC, m, k, 8));
      if (k % 4 === 0) out.push(chip(id++, CH.BD, m, k, 8));
      if (k % 4 === 2) out.push(chip(id++, CH.SD, m, k, 8));
    }
  return out;
}

describe('OpenRouter', () => {
  it('予備のモデルは models で渡し、推論・JSON・Web検索を付ける', () => {
    const b = buildChatBody({
      model: 'a/x',
      fallback: 'b/y',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'medium',
      reasoning: true,
      schema: { name: 's', schema: { type: 'object' } },
      structured: true,
      web: true,
    });
    expect(b.models).toEqual(['a/x', 'b/y']);
    expect(b.model).toBeUndefined();
    expect(b.reasoning).toEqual({ effort: 'medium' });
    expect((b.response_format as { type: string }).type).toBe('json_schema');
    expect(b.tools).toEqual([{ type: 'openrouter:web_search', parameters: { max_results: 5 } }]);
  });
  it('JSON Schema に対応しないモデルは json_object、推論しないモデルには送らない', () => {
    const b = buildChatBody({ model: 'a/x', messages: [], effort: 'high', reasoning: false, schema: { name: 's', schema: {} }, structured: false });
    expect(b.model).toBe('a/x');
    expect(b.reasoning).toBeUndefined();
    expect(b.response_format).toEqual({ type: 'json_object' });
  });
  it('答えの JSON を前後の文やコードブロックから取り出す', () => {
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```').a).toBe(1);
    expect(parseJsonLoose<{ a: number }>('はい。{"a":2} 以上です').a).toBe(2);
    expect(() => parseJsonLoose('だめ')).toThrow();
  });
  it('モデル一覧を読む', () => {
    const ms = parseModels({
      data: [
        { id: 'a/x', name: 'A: X', created: 10, pricing: { prompt: '0.000001', completion: '0.000005', web_search: '0.01' }, supported_parameters: ['response_format', 'structured_outputs', 'reasoning', 'tools'] },
        { id: 'img/y', architecture: { output_modalities: ['image'] } },
      ],
    });
    expect(ms).toHaveLength(1);
    expect(ms[0].name).toBe('X');
    expect(ms[0].json && ms[0].reasoning && ms[0].web && ms[0].structured).toBe(true);
    const t = taskDef('level');
    expect(meetsNeeds(ms[0], t)).toBe(true);
    // 1回の目安：4000×1e-6 + 1500×2×5e-6 = 0.019
    expect(estimateCost(ms[0], t.est, 'medium', false)).toBeCloseTo(0.019, 5);
  });
  it('一覧が無くても初期のモデルは料金が分かる', () => {
    const m = modelInfo('anthropic/claude-haiku-5.5', []);
    expect(m?.name).toBe('Claude Haiku 5.5');
    expect(m!.pricePrompt).toBeCloseTo(0.1e-6);
  });
});

describe('フレーズ候補', () => {
  it('小節を16分の格子にする', () => {
    const d = doc(beat8(1));
    const g = measureGrid(d, buildTempoMap(d), 0);
    expect(g.lines).toContain('HH: x-x-x-x-x-x-x-x-');
    expect(g.lines).toContain('BD: x-------x-------');
    expect(g.rounded).toBe(false);
  });
  it('AIの答えを範囲の中のチップにし、叩けない組み合わせをはじく', () => {
    const d = doc([]);
    const t = buildTempoMap(d);
    const c = decodeCandidates(
      {
        candidates: [
          {
            name: 'タム回し',
            reason: '高い順',
            measures: [
              { index: 0, lanes: [{ lane: 'SD', steps: 'x---------------' }, { lane: 'HT', steps: 'x---' }, { lane: 'CY', steps: 'x' }, { lane: 'BD', steps: 'x' }] },
              { index: 5, lanes: [{ lane: 'SD', steps: 'xxxx' }] },
            ],
          },
        ],
      },
      { from: 3, to: 3 },
      t,
    );
    expect(c).toHaveLength(1);
    // 手は2つまで（CY と SD を残し HT をはじく）、範囲外（index 5）は捨てる
    expect(c[0].notes.map((n) => n.ch).sort()).toEqual([CH.SD, CH.BD, CH.CY].sort());
    expect(c[0].notes.every((n) => n.m === 3)).toBe(true);
  });
  it('左足は1つ、HHの開閉は同時に置かない', () => {
    const r = enforcePlayable([
      { ch: CH.LP, m: 0, f: frac(0) },
      { ch: CH.LBD, m: 0, f: frac(0) },
      { ch: CH.HHC, m: 0, f: frac(0) },
      { ch: CH.HHO, m: 0, f: frac(0) },
    ]);
    expect(r.map((n) => n.ch).sort()).toEqual([CH.HHO, CH.LBD].sort());
  });
  it('キーが無いときは直前の小節の複製を出す', () => {
    const d = doc(beat8(2));
    const c = ruleCandidates(d, buildTempoMap(d), { from: 2, to: 2, onsets: null, offsetSec: 0, lastMeasure: 2 });
    expect(c.some((x) => x.source === 'prev' && x.notes.length === 12 && x.notes.every((n) => n.m === 2))).toBe(true);
  });
});

describe('レベル判定と方針', () => {
  it('セクションのマーカーから区間を作る（無ければ8小節ごと）', () => {
    expect(sectionSpans([{ m: 4, name: 'Aメロ' }, { m: 12, name: 'サビ' }], 20)).toEqual([
      { name: '前奏', from: 0, to: 3 },
      { name: 'Aメロ', from: 4, to: 11 },
      { name: 'サビ', from: 12, to: 20 },
    ]);
    expect(sectionSpans([], 12).map((s) => [s.from, s.to])).toEqual([
      [0, 7],
      [8, 12],
    ]);
    // 端の短い区間は前に含める
    expect(sectionSpans([], 16).map((s) => [s.from, s.to])).toEqual([
      [0, 7],
      [8, 16],
    ]);
  });
  it('AIの方針は与えた区間にそろえ、範囲外の値は丸める', () => {
    const spans = sectionSpans([{ m: 0, name: 'A' }, { m: 8, name: 'サビ' }], 15);
    const p = cleanPlan({ summary: 's', sections: [{ name: 'サビ', from: 8, to: 15, shift: 5, fill: 'thin', keepRide: true, keepOpenHH: false, comment: 'c' }] }, spans);
    expect(p.sections).toHaveLength(2);
    expect(p.sections[1]).toMatchObject({ shift: 2, fill: 'thin', keepRide: true });
    expect(p.sections[0].shift).toBe(0);
    expect(cleanJudgement({ level: 12, reasons: ['a'] }).level).toBe(9.99);
  });
});

describe('ガイドライン', () => {
  it('#DLEVEL を NX と同じに読む', () => {
    expect(levelOfField('825')).toBe(8.25);
    expect(levelOfField('82')).toBe(8.2);
    expect(levelOfField('')).toBeNull();
  });
  it('レベル帯ごとの出現率と、近い譜面からの見積もり', () => {
    const mk = (id: string, lv: number, bpm: number, measures: number): ChartEntry => {
      const d = doc(beat8(measures), bpm);
      return { id, song: id, artist: '', label: 'MASTER', file: id, folder: 'f', level: lv, feat: chartFeatures(d), excluded: false, addedAt: 0 };
    };
    const charts = [mk('a', 3.1, 120, 8), mk('b', 3.4, 125, 8), mk('c', 3.3, 118, 8), mk('d', 7.5, 220, 8)];
    const st = bandStats(charts);
    expect(st[2].count).toBe(3);
    expect(st[2].rates.hh8).toBe(1);
    const p = predictLevel(chartFeatures(doc(beat8(8), 122)), charts);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(3);
    expect(p!).toBeLessThan(5);
  });
});

describe('書き出し', () => {
  it('難易度のファイル名', () => {
    expect(outFileName('song.dtx', 'BASIC')).toBe('song_bsc.dtx');
    expect(outFileName('song_mstr.dtx', 'EXTREME')).toBe('song_ext.dtx');
    expect(outFileName('master.dtx', 'ADVANCED')).toBe('master_adv.dtx');
  });
  it('set.def はほかの難易度を残して書き直す', () => {
    const before = '#TITLE Song\r\n#L1LABEL NOVICE\r\n#L1FILE nov.dtx\r\n#L2LABEL MASTER\r\n#L2FILE song.dtx\r\n';
    const out = buildSetDef(before, 'Song', 'song.dtx', 'MASTER', [
      { diff: 'BASIC', file: 'song_bsc.dtx' },
      { diff: 'ADVANCED', file: 'song_adv.dtx' },
    ]);
    expect(out).toContain('#L1LABEL BASIC\r\n#L1FILE song_bsc.dtx');
    expect(out).toContain('#L2LABEL ADVANCED');
    expect(out).toContain('#L4LABEL MASTER\r\n#L4FILE song.dtx');
    expect(out).toContain('#L3LABEL NOVICE\r\n#L3FILE nov.dtx');
  });
});
