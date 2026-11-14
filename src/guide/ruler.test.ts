import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { chartFeatures, type ChartFeatures } from '../gen/features';
import type { LibChart, LibSong, SlotKey } from '../nxlib/scan';
import { canAddLevel } from '../nxlib/view';
import { buildRuler, chartSig, duplicateSongs, estimatePlayLevel, nxChartId, playPoints, skipOf, type ChartEntry, type ChartFacts, type PlayPoint } from './ruler';

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });
const doc = (chips: ReturnType<typeof chip>[], bpm = 120): DtxDoc => ({ ...emptyDoc(), fields: { BPM: String(bpm) }, chips, nextId: 999 });

function beat8(measures: number): ReturnType<typeof chip>[] {
  const out = [];
  let id = 0;
  for (let m = 0; m < measures; m++)
    for (let k = 0; k < 8; k++) {
      out.push(chip(id++, CH.HHC, m, k, 8));
      if (k % 4 === 0) out.push(chip(id++, CH.BD, m, k, 8));
      if (k % 4 === 2) out.push(chip(id++, CH.SD, m, k, 8));
    }
  return out;
}

const FEAT: ChartFeatures = chartFeatures(doc(beat8(8)));
const feat = (notes = FEAT.notes): ChartFeatures => ({ ...FEAT, notes });

function chart(file: string, slot: SlotKey | null, level: number | null, o: Partial<LibChart> = {}): LibChart {
  return {
    file,
    label: '',
    index: 0,
    slot,
    head: { title: '', artist: '', bpm: '', level, preimage: '', stagefile: '', preview: '', ai: false },
    score: null,
    size: 100,
    mtime: 1,
    work: false,
    ...o,
  };
}

function song(id: string, charts: LibChart[], o: Partial<LibSong> = {}): LibSong {
  return {
    id,
    root: 'r',
    path: [id],
    block: 0,
    title: id,
    artist: 'A',
    bpm: '120',
    box: [],
    charts,
    setDef: true,
    image: '',
    imageSig: '',
    preview: '',
    updated: 0,
    edited: false,
    drive: null,
    doubled: false,
    checks: [],
    drums: true,
    ...o,
  };
}

/** DTXMania の曲の譜面を解析した印（sig が同じなら使う） */
function analyzed(s: LibSong, c: LibChart, o: Partial<ChartEntry> = {}): ChartEntry {
  return { id: nxChartId(s.id, c.file), src: 'nx', song: s.title, artist: s.artist, label: '', file: c.file, folder: s.id, level: c.head.level, feat: feat(), excluded: false, addedAt: 0, songId: s.id, slot: c.slot, sig: chartSig(c), ...o };
}

const facts = (o: Partial<ChartFacts> = {}): ChartFacts => ({ ai: false, drums: true, level: 5, notes: 300, work: false, include: false, excluded: false, dup: false, boxOff: false, ...o });

describe('物差しに入れる譜面', () => {
  it('入れないわけ：AI・ドラムでない・レベル無し・同じ曲・外した BOX・エディタ・手で外した', () => {
    expect(skipOf(facts())).toBeNull();
    expect(skipOf(facts({ ai: true }))).toBe('ai');
    expect(skipOf(facts({ drums: false }))).toBe('nodrums');
    expect(skipOf(facts({ notes: 10 }))).toBe('nodrums');
    expect(skipOf(facts({ level: null }))).toBe('nolevel');
    expect(skipOf(facts({ level: 0 }))).toBe('nolevel');
    expect(skipOf(facts({ dup: true }))).toBe('dup');
    expect(skipOf(facts({ boxOff: true }))).toBe('box');
    expect(skipOf(facts({ work: true }))).toBe('work');
    // 作業ファイルがあっても、手で入れたら入れる
    expect(skipOf(facts({ work: true, include: true }))).toBeNull();
    expect(skipOf(facts({ excluded: true }))).toBe('manual');
    // AI で作った譜面は、手で入れても入れない
    expect(skipOf(facts({ ai: true, work: true, include: true }))).toBe('ai');
  });

  it('同じ曲（曲名とアーティストが同じ）は 1 つだけ。外した BOX に無い方を残す', () => {
    const a = song('a', [], { title: 'Song', box: ['off'] });
    const b = song('b', [], { title: ' song ' });
    const c = song('c', [], { title: 'Other' });
    expect([...duplicateSongs([a, b, c], (s) => s.box.includes('off'))]).toEqual(['a']);
    expect([...duplicateSongs([a, b, c], () => false)]).toEqual(['b']);
  });

  it('DTXMania の曲から：解析した譜面だけ使い、変わった譜面は読み直しを待つ', () => {
    const m = chart('m.dtx', 'MAS', 6.5);
    const e = chart('e.dtx', 'EXT', 5.2);
    const ai = chart('a.dtx', 'ADV', 4.0, { head: { ...chart('', null, 4).head, ai: true } });
    const gda = chart('g.gda', null, 5.0);
    const nolv = chart('n.dtx', 'BSC', null);
    const s1 = song('s1', [nolv, ai, e, m]);
    const w = chart('w.dtx', 'MAS', 7.0, { work: true });
    const s2 = song('s2', [w, gda]);
    const s3 = song('s3', [chart('x.dtx', 'MAS', 8.0)], { box: ['bx'] });
    const entries = [analyzed(s1, m), analyzed(s1, e, { sig: 'old' }), analyzed(s2, w), analyzed(s3, s3.charts[0])];
    const r = buildRuler({ entries, songs: [s1, s2, s3], boxesOff: new Set(['bx']) });
    expect(r.use.map((c) => c.file)).toEqual(['m.dtx']);
    expect(r.pending).toBe(1);
    const why = Object.fromEntries(r.skipped.map((x) => [x.key.split('|')[1], x.why]));
    expect(why).toEqual({ 'n.dtx': 'nolevel', 'a.dtx': 'ai', 'w.dtx': 'work', 'g.gda': 'nodrums', 'x.dtx': 'box' });
    // 一覧のレベル・名前を使う（解析のあとに変わっても）
    expect(r.use[0].songId).toBe('s1');
    // 作業ファイルのある譜面を手で入れる
    const r2 = buildRuler({ entries: entries.map((x) => (x.file === 'w.dtx' ? { ...x, include: true } : x)), songs: [s1, s2, s3], boxesOff: new Set() });
    expect(r2.use.map((c) => c.file).sort()).toEqual(['m.dtx', 'w.dtx', 'x.dtx']);
    expect(r2.songs).toBe(3);
  });

  it('ドラムの少ない譜面・点検でドラムが無いと分かった曲は入れない', () => {
    const c = chart('m.dtx', 'MAS', 6.0);
    const s = song('s', [c]);
    expect(buildRuler({ entries: [analyzed(s, c, { feat: feat(8) })], songs: [s] }).skipped[0]?.why).toBe('nodrums');
    const quiet = song('q', [c], { drums: false });
    expect(buildRuler({ entries: [], songs: [quiet] }).skipped[0]?.why).toBe('nodrums');
  });

  it('前の版の一覧（譜面ごとの印が無い）は、曲に作業ファイルがあればエディタの譜面とみなす', () => {
    const c = chart('m.dtx', 'MAS', 6.0, { work: undefined });
    const s = song('s', [c], { edited: true });
    expect(buildRuler({ entries: [analyzed(s, c)], songs: [s] }).skipped[0]?.why).toBe('work');
  });

  it('取り込んだ譜面：DTXMania の曲と同じ譜面は二重に数えない', () => {
    const c = chart('m.dtx', 'MAS', 6.5);
    const s = song('Song', [c]);
    const imp: ChartEntry = { id: 'f/m.dtx', song: 'Song', artist: 'A', label: 'MASTER', file: 'm.dtx', folder: 'f', level: 6.5, feat: feat(), excluded: false, addedAt: 0 };
    const other: ChartEntry = { ...imp, id: 'f/o.dtx', song: 'Other', file: 'o.dtx' };
    const r = buildRuler({ entries: [analyzed(s, c), imp, other], songs: [s] });
    expect(r.use.map((x) => x.id)).toEqual([nxChartId('Song', 'm.dtx'), 'f/o.dtx']);
    expect(r.skipped.map((x) => x.why)).toEqual(['dup']);
    // DTXMania の曲を使わないときは、取り込んだ譜面だけ
    expect(buildRuler({ entries: [analyzed(s, c), imp] }).use.map((x) => x.id)).toEqual(['f/m.dtx']);
  });
});

describe('成績からの遊ぶレベル', () => {
  const pt = (level: number, skill: number, i: number): PlayPoint => ({ key: `k${i}`, level, skill, plays: 3, rank: null, song: `s${i}`, label: 'MASTER' });

  it('ならした達成率が S（80%）に届くいちばん上のレベル', () => {
    // レベル 4.0〜8.0 で、1 上がるごとに 10% 下がる：6.0 で 80%
    const pts = Array.from({ length: 17 }, (_, i) => pt(4 + i * 0.25, 100 - i * 2.5, i));
    const e = estimatePlayLevel(pts);
    expect(e.level).not.toBeNull();
    expect(Math.abs(e.level! - 6.0)).toBeLessThanOrEqual(0.2);
    expect(e.n).toBe(17);
    expect(e.atTop).toBe(false);
  });

  it('成績が 3 つより少なければ出さない・S に届かなければ出さない', () => {
    expect(estimatePlayLevel([pt(5, 90, 0), pt(6, 85, 1)]).level).toBeNull();
    expect(estimatePlayLevel([pt(5, 60, 0), pt(5.5, 55, 1), pt(6, 50, 2)]).level).toBeNull();
  });

  it('遊んだ譜面：AI で作った・エディタの譜面は入れない', () => {
    const score = { plays: 4, rank: 'S' as const, skill: 85.2 };
    const m = chart('m.dtx', 'MAS', 6.5, { score });
    const a = chart('a.dtx', 'EXT', 5.5, { score, head: { ...chart('', null, 5.5).head, ai: true } });
    const w = chart('w.dtx', 'ADV', 4.5, { score, work: true });
    const n = chart('n.dtx', 'BSC', 3.0, { score: { plays: 0, rank: null, skill: null } });
    const s = song('s', [n, w, a, m]);
    const p = playPoints({ entries: [], songs: [s] });
    expect(p.map((x) => x.level)).toEqual([6.5]);
    expect(p[0].skill).toBe(85.2);
  });
});

describe('遊ぶレベルを足せる曲（曲の一覧のしぼりこみ）', () => {
  it('あいだに作れる曲だけ', () => {
    const s = song('s', [chart('a.dtx', 'ADV', 5.1), chart('e.dtx', 'EXT', 7.5), chart('m.dtx', 'MAS', 8.4)]);
    expect(canAddLevel(s, 6.5)).toBe(true);
    // 同じくらいのレベルの譜面がもうある
    expect(canAddLevel(s, 7.4)).toBe(false);
    // いちばん上より上は作れない
    expect(canAddLevel(s, 8.5)).toBe(false);
    expect(canAddLevel(s, null)).toBe(false);
    // 空いた枠が無い曲
    const full = song('f', [chart('b.dtx', 'BSC', 3), chart('a.dtx', 'ADV', 5.1), chart('e.dtx', 'EXT', 7.5), chart('m.dtx', 'MAS', 8.4)]);
    expect(canAddLevel(full, 6.5)).toBe(false);
  });
});
