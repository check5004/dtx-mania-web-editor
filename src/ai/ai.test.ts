import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures } from '../gen/features';
import { bandStats, levelOfField, predictLevel, type ChartEntry } from '../store/guideline';
import { buildSetDef, chooseOutFiles, outFileName, relaxPlan, replacedInSetDef } from '../store/gen';
import { folderFromFiles } from '../fs/folder';
import { chartHash } from '../dtx/origin';
import { cleanJudgement, cleanPlan, sectionSpans } from './judge';
import { buildChatBody, isChatModel, missingKeys, parseJsonLoose, parseModels, repairPrompt } from './openrouter';
import { cleanSongInfo, songInfoSchema } from './songInfo';
import { buildContext, decodeCandidates, enforcePlayable, measureGrid, phrasePrompt, ruleCandidates } from './phrase';
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
  it('小節を拍ごとの格子にする（16分なら1拍4文字）', () => {
    const d = doc(beat8(1));
    const g = measureGrid(d, buildTempoMap(d), 0);
    expect(g.lines).toContain('HH: x-x-|x-x-|x-x-|x-x-');
    expect(g.lines).toContain('BD: x---|----|x---|----');
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
  it('自動で入れたまま確かめていない前後の小節は、譜面を見せない', () => {
    const d = doc(beat8(6));
    const ctx = buildContext(d, buildTempoMap(d), { kind: 'fill', from: 4, to: 4, instruction: '', targetLevel: null, onsets: null, offsetSec: 0, human: (m) => m !== 3 });
    expect(ctx.measures.find((m) => m.m === 3)).toMatchObject({ grid: [], auto: true });
    expect(ctx.measures.find((m) => m.m === 2)?.grid.length).toBeGreaterThan(0);
    // 範囲の中は自動で入れた小節でも見せる（置き換える中身）
    expect(buildContext(d, buildTempoMap(d), { kind: 'fill', from: 3, to: 3, instruction: '', targetLevel: null, onsets: null, offsetSec: 0, human: (m) => m !== 3 }).measures.find((m) => m.m === 3)?.grid.length).toBeGreaterThan(0);
    expect(phrasePrompt(ctx).user).toContain('小節 3 （前） 4拍\n（自動で入れたまま作者が確かめていないので、譜面は省きます）');
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
    // 前の形の答え（ライド・オープンHHを残す指定）が来ても読めて、その指定は使わない（ライドもオープンHHも置き換えないので要らない）
    const p = cleanPlan(JSON.parse('{"summary":"s","sections":[{"name":"サビ","from":8,"to":15,"shift":5,"fill":"thin","keepRide":true,"keepOpenHH":true,"comment":"c"}]}'), spans);
    expect(p.sections).toHaveLength(2);
    expect(p.sections[1]).toMatchObject({ shift: 2, fill: 'thin', comment: 'c' });
    expect(p.sections[1]).not.toHaveProperty('keepRide');
    expect(p.sections[1]).not.toHaveProperty('keepOpenHH');
    expect(p.sections[0].shift).toBe(0);
    expect(cleanJudgement({ level: 12, reasons: ['a'] }).level).toBe(9.99);
  });
  it('低い難易度では細かいフィルの指定を上限までにする（BASIC に16分のフィルを残さない）', () => {
    const spans = sectionSpans([{ m: 0, name: 'A' }, { m: 8, name: 'サビ' }], 15);
    const raw = { summary: 's', sections: [{ name: 'A', from: 0, to: 7, shift: 0, fill: 'keep' as const, comment: '' }, { name: 'サビ', from: 8, to: 15, shift: -1, fill: 'last' as const, comment: '' }] };
    expect(cleanPlan(raw, spans, 'BASIC').sections.map((x) => x.fill)).toEqual(['short', 'last']);
    expect(cleanPlan(raw, spans, 'ADVANCED').sections.map((x) => x.fill)).toEqual(['thin', 'last']);
    expect(cleanPlan(raw, spans, 'EXTREME').sections.map((x) => x.fill)).toEqual(['keep', 'last']);
  });
  it('方針が強すぎて目標に届かないときは、元に近く・フィルの指定を外せる', () => {
    const plan = { summary: 'x', sections: [{ name: 'A', from: 0, to: 7, shift: -1, fill: 'thin' as const, comment: 'サビ' }, { name: 'B', from: 8, to: 15, shift: 1, fill: 'last' as const }] };
    const r = relaxPlan(plan)!;
    expect(r.sections[0]).toMatchObject({ shift: 0, fill: undefined, comment: 'サビ' });
    expect(r.sections[1]).toMatchObject({ shift: 1, fill: 'last' });
    expect(r.summary).toContain('指定を外して');
    expect(relaxPlan({ summary: '', sections: [{ name: 'B', from: 0, to: 7, shift: 1, fill: 'short' }] })).toBeNull();
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
  it('難易度のファイル名（元の譜面の名前が難易度で終わるなら、そこだけを変える）', () => {
    expect(outFileName('song.dtx', 'BASIC')).toBe('song_bsc.dtx');
    expect(outFileName('song_mstr.dtx', 'EXTREME')).toBe('song_ext.dtx');
    expect(outFileName('master.dtx', 'ADVANCED')).toBe('adv.dtx');
    expect(outFileName('mstr.dtx', 'BASIC')).toBe('bsc.dtx');
    expect(outFileName('ext.dtx', 'ADVANCED')).toBe('adv.dtx');
    // DTXCreatorAL の「曲名-mas.dtx」は「-bas」「-adv」「-ext」
    expect(outFileName('248 - Song-mas.dtx', 'BASIC')).toBe('248 - Song-bas.dtx');
    expect(outFileName('248 - Song-mas.dtx', 'ADVANCED')).toBe('248 - Song-adv.dtx');
    // 難易度の名前でない語の終わり（christmas など）は変えない
    expect(outFileName('christmas.dtx', 'BASIC')).toBe('christmas_bsc.dtx');
  });
  it('作者の譜面・手で直した譜面は上書きしない（別の名前にする）。手を入れていない AI の譜面だけ上書きする', async () => {
    const dtx = (body: string) => new TextEncoder().encode(`#TITLE: x\r\n#BPM: 120\r\n${body}`);
    const file = (name: string, body: string) => new File([dtx(body)], name);
    // adv.dtx は作者の譜面、bsc.dtx はこのアプリで作ったまま（ハッシュはチップが無いときの値）、ext.dtx は手直しした AI の譜面
    const empty = chartHash({ chips: [] });
    const folder = folderFromFiles([
      file('mstr.dtx', '#00012: 01\r\n'),
      file('adv.dtx', '#00012: 01\r\n'),
      file('bsc.dtx', `#DTXE_ORIGIN: AI ${empty} from mstr.dtx\r\n`),
      file('ext.dtx', `#DTXE_ORIGIN: AI ${empty} from mstr.dtx\r\n#00012: 01\r\n`),
    ]);
    const out = await chooseOutFiles(folder, 'mstr.dtx', ['EXTREME', 'ADVANCED', 'BASIC'], []);
    expect(out).toEqual([
      { diff: 'EXTREME', file: 'ext_ai.dtx', overwrite: false },
      { diff: 'ADVANCED', file: 'adv_ai.dtx', overwrite: false },
      { diff: 'BASIC', file: 'bsc.dtx', overwrite: true },
    ]);
    // 残す既存の譜面の名前は、AI の譜面でも使わない
    const kept = await chooseOutFiles(folder, 'mstr.dtx', ['BASIC'], ['bsc.dtx']);
    expect(kept).toEqual([{ diff: 'BASIC', file: 'bsc_ai.dtx', overwrite: false }]);
    // 作り直す AI の譜面は、名前が違ってもそのファイルに上書きする（手直しした譜面なら決まった名前に）
    const own = await chooseOutFiles(folder, 'mstr.dtx', ['ADVANCED', 'EXTREME'], [], undefined, { ADVANCED: 'bsc.dtx', EXTREME: 'ext.dtx' });
    expect(own).toEqual([
      { diff: 'ADVANCED', file: 'bsc.dtx', overwrite: true },
      { diff: 'EXTREME', file: 'ext_ai.dtx', overwrite: false },
    ]);
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
  it('set.def：EXTREME から下を作るとき、元の譜面は EXTREME の段に、上の MASTER はそのまま残す', () => {
    const before = '#TITLE Song\r\n#L3LABEL EXTREME\r\n#L3FILE ext.dtx\r\n#L4LABEL MASTER\r\n#L4FILE mstr.dtx\r\n';
    const out = buildSetDef(
      before,
      'Song',
      'ext.dtx',
      'EXTREME',
      [
        { diff: 'ADVANCED', file: 'adv.dtx' },
        { diff: 'BASIC', file: 'bsc.dtx' },
      ],
      { sourceSlot: 'EXTREME' },
    );
    expect(out).toBe('#TITLE Song\r\n#L1LABEL BASIC\r\n#L1FILE bsc.dtx\r\n#L2LABEL ADVANCED\r\n#L2FILE adv.dtx\r\n#L3LABEL EXTREME\r\n#L3FILE ext.dtx\r\n#L4LABEL MASTER\r\n#L4FILE mstr.dtx\r\n');
  });
  it('set.def が無い曲：ファイル名から見つけて残す既存の譜面も載せる', () => {
    const out = buildSetDef(null, 'Song', 'mstr.dtx', 'MASTER', [{ diff: 'BASIC', file: 'bsc.dtx' }], {
      kept: [
        { slot: 'EXTREME', label: 'EXTREME', file: 'ext.dtx' },
        { slot: 'ADVANCED', label: 'ADVANCED', file: 'adv.dtx' },
      ],
    });
    expect(out).toBe(
      '#TITLE Song\r\n#L1LABEL BASIC\r\n#L1FILE bsc.dtx\r\n#L2LABEL ADVANCED\r\n#L2FILE adv.dtx\r\n#L3LABEL EXTREME\r\n#L3FILE ext.dtx\r\n#L4LABEL MASTER\r\n#L4FILE mstr.dtx\r\n',
    );
  });
  it('set.def で置き換わる難易度を知らせる（DTXCreatorAL の「#L1LABEL: Basic」形式）', () => {
    const setdef = '#TITLE: 曲\r\n#L1LABEL: Basic\r\n#L1FILE: s-bas.dtx\r\n#L2LABEL: Advanced\r\n#L2FILE: s-adv.dtx\r\n#L4LABEL: Master\r\n#L4FILE: s-mas.dtx\r\n';
    const made = [{ diff: 'BASIC' as const, file: 's_bsc.dtx' }];
    expect(replacedInSetDef(setdef, 's-mas.dtx', made)).toEqual([{ label: 'Basic', file: 's-bas.dtx' }]);
    expect(replacedInSetDef(null, 's-mas.dtx', made)).toEqual([]);
  });
});

describe('AIの答えの形', () => {
  it(':batch のモデルは一覧に出さない（chat/completions では呼べない）', () => {
    expect(isChatModel('anthropic/claude-haiku-5.5')).toBe(true);
    expect(isChatModel('anthropic/claude-haiku-5.5:batch')).toBe(false);
    const ms = parseModels({ data: [{ id: 'a/x' }, { id: 'a/x:batch' }] });
    expect(ms.map((m) => m.id)).toEqual(['a/x']);
  });
  it('Web検索のときに勝手なキー名で返ってきたら、足りないキーを見つける', () => {
    // 実際に Claude Haiku 5.5 + openrouter:web_search で返ってきた形
    const got = parseJsonLoose('```json\n{"title":"ブレス・ユア・ブレス","artist":"和田たけあき feat. 初音ミク","genre":"ロック","release_year":"2019","song_comment_select_screen":"…","notes":"…"}\n```');
    expect(missingKeys(songInfoSchema().schema, got)).toEqual(['year', 'comment', 'panel', 'confidence']);
    expect(missingKeys(songInfoSchema().schema, { title: '', artist: '', genre: '', year: '', comment: '', panel: '', confidence: 'low', notes: '' })).toEqual([]);
    expect(missingKeys({ required: ['candidates'], properties: { candidates: { type: 'array' } } }, { candidates: 'x' })).toEqual(['candidates']);
    expect(missingKeys({ required: ['a'] }, null)).toEqual(['a']);
  });
  it('直す頼み方にはスキーマと元の答えが入る', () => {
    const p = repairPrompt(songInfoSchema(), '{"release_year":"2019"}');
    expect(p.system).toContain('title, artist, genre, year');
    expect(p.user).toContain('release_year');
  });
  it('曲情報の答えをそろえる（年は4桁、リンクは外す、自信度の既定は低）', () => {
    const a = cleanSongInfo({ title: ' X ', year: '2019年', comment: '「マジカルミライ 2019」テーマソング。[piapro.net](https://blog.piapro.net/2019/05/q190531-1.html)', panel: '曲 (https://example.com/a) 終', confidence: 'maybe', notes: 'n' });
    expect(a).toMatchObject({ title: 'X', year: '2019', comment: '「マジカルミライ 2019」テーマソング。piapro.net', panel: '曲 終', confidence: 'low' });
    expect(cleanSongInfo({ year: 2020 as unknown as string }).year).toBe('2020');
  });
});
