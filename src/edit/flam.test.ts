import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { findIssues } from '../check/playability';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { buildTempoMap } from '../dtx/timing';
import { DEFAULT_FLAM, findFlamPairs, flamDiv, flamMs, flamPairStarts, flamSpot, flamState, opFlam, opUnflam } from './flam';
import { velOfWav } from './velocity';

const dtx = (bpm: number, lines: string[]) => parseDtx(['#TITLE: t', `#BPM: ${bpm}`, '#WAV01: sd.wav', '#WAV02: bd.wav', '', ...lines].join('\r\n')).doc;
const pos = (d: DtxDoc, ch: number = CH.SD) =>
  d.chips
    .filter((c) => c.ch === ch)
    .sort((a, b) => a.m + a.f.n / a.f.d - (b.m + b.f.n / b.f.d))
    .map((c) => ({ at: `${c.m}:${c.f.n}/${c.f.d}`, vel: velOfWav(d.fields, c.v) }));

describe('フラムの間隔', () => {
  it('自動は約40msにいちばん近い細かさ（手元の譜面と同じ選び方）', () => {
    // 忘れてやらない（184BPM）は 1/32、Mela!（138BPM）は 1/48 で書いてあった
    expect(flamDiv(184, 'auto')).toBe(32);
    expect(flamDiv(138, 'auto')).toBe(48);
    expect(flamDiv(120, 'auto')).toBe(48);
    expect(flamDiv(90, 'auto')).toBe(64);
    expect(flamDiv(250, 'auto')).toBe(24);
    expect(flamDiv(184, 64)).toBe(64);
    expect(flamMs(32, 184)).toBeCloseTo(40.8, 1);
  });

  it('1打目を拍の上に置くと、2打目は少し後ろ（小節をまたいでもよい）', () => {
    const d = dtx(120, ['#00112: 01']);
    const t = buildTempoMap(d);
    const s = flamSpot(t, { m: 1, f: frac(1, 2) }, DEFAULT_FLAM)!;
    expect(s.grace).toEqual({ m: 1, f: frac(1, 2) });
    expect(s.main).toEqual({ m: 1, f: frac(25, 48) });
    const last = flamSpot(t, { m: 1, f: frac(47, 48) }, DEFAULT_FLAM)!;
    expect(last.main).toEqual({ m: 2, f: frac(0) });
  });

  it('2打目を拍の上にすると1打目は前。曲の頭では前に置けないので後ろ', () => {
    const d = dtx(120, ['#00112: 01']);
    const t = buildTempoMap(d);
    const s = flamSpot(t, { m: 1, f: frac(0) }, { ...DEFAULT_FLAM, side: 'before' })!;
    expect(s.grace).toEqual({ m: 0, f: frac(47, 48) });
    expect(s.main).toEqual({ m: 1, f: frac(0) });
    const head = flamSpot(t, { m: 0, f: frac(0) }, { ...DEFAULT_FLAM, side: 'before' })!;
    expect(head.side).toBe('after');
    expect(head.grace).toEqual({ m: 0, f: frac(0) });
  });
});

describe('フラムにする・1打に戻す', () => {
  it('元のチップを1打目（弱く）にして、2打目を足す。戻すと元どおり', () => {
    const d0 = dtx(120, ['#00112: 00000100', '#00113: 01000000']);
    const t = buildTempoMap(d0);
    const sd = d0.chips.find((c) => c.ch === CH.SD)!;
    let made = 0;
    const d1 = produce(d0, (d) => {
      const r = opFlam(d, new Set([sd.id]), t, DEFAULT_FLAM, 5);
      made = r.made;
      expect(r.ids).toHaveLength(2);
      expect(r.div).toBe(48);
    });
    expect(made).toBe(1);
    expect(pos(d1)).toEqual([
      { at: '1:1/2', vel: 70 },
      { at: '1:25/48', vel: 100 },
    ]);
    // バスドラムはそのまま
    expect(pos(d1, CH.BD)).toEqual([{ at: '1:0/1', vel: 100 }]);
    const pair = findFlamPairs(d1, t);
    expect(pair).toHaveLength(1);
    const d2 = produce(d1, (d) => {
      const r = opUnflam(d, new Set([pair[0].b]), t, DEFAULT_FLAM);
      expect(r.count).toBe(1);
      expect(r.ids).toEqual([sd.id]);
    });
    expect(pos(d2)).toEqual([{ at: '1:1/2', vel: 100 }]);
    // 足したベロシティ違いの WAV も消える
    expect(Object.keys(d2.fields).filter((k) => k.startsWith('WAV'))).toEqual(['WAV01', 'WAV02']);
  });

  it('2打目を拍の上にする置き方では、弱い1打目を前に足す', () => {
    const d0 = dtx(184, ['#00112: 0001']);
    const t = buildTempoMap(d0);
    const d1 = produce(d0, (d) => {
      opFlam(d, new Set(d.chips.map((c) => c.id)), t, { ...DEFAULT_FLAM, side: 'before' }, 5);
    });
    expect(pos(d1)).toEqual([
      { at: '1:15/32', vel: 70 },
      { at: '1:1/2', vel: 100 },
    ]);
    // 戻すと拍の上（1/2）の方が残る
    const d2 = produce(d1, (d) => {
      opUnflam(d, new Set(d.chips.map((c) => c.id)), t, { ...DEFAULT_FLAM, side: 'before' });
    });
    expect(pos(d2)).toEqual([{ at: '1:1/2', vel: 100 }]);
  });

  it('もうフラムのチップは変えない。足す所の近くにチップがあれば変えない', () => {
    // 64分の3連打（120BPM で 31ms 間隔）：等間隔なのでフラムではない。真ん中に近すぎて足せない
    const d0 = dtx(120, ['#00112: ' + '01010100'.padEnd(128, '0')]);
    const t = buildTempoMap(d0);
    expect(findFlamPairs(d0, t)).toEqual([]);
    const first = d0.chips.find((c) => c.f.n === 0)!;
    let crowded = 0;
    produce(d0, (d) => {
      crowded = opFlam(d, new Set([first.id]), t, DEFAULT_FLAM, 5).crowded;
    });
    expect(crowded).toBe(1);
  });

  it('選んだチップの状態（メニューの出し分け）', () => {
    // 96分割の 0 と、48・49（1/96 = 21ms の2打）
    const slots = Array.from({ length: 96 }, (_, i) => (i === 0 || i === 48 || i === 49 ? '01' : '00')).join('');
    const d0 = dtx(120, ['#00112: ' + slots]);
    const t = buildTempoMap(d0);
    const ids = d0.chips.map((c) => c.id);
    const st = flamState(d0, t, ids);
    expect(st.pairs).toHaveLength(1);
    expect(st.single).toHaveLength(1);
  });
});

describe('フラムの見つけ方', () => {
  it('前後から離れたすばやい2打だけ。等間隔の連打は組にしない', () => {
    expect(flamPairStarts([0, 0.04, 0.5], 0.06)).toEqual([0]);
    expect(flamPairStarts([0, 0.04, 0.08, 0.12], 0.06)).toEqual([]);
    expect(flamPairStarts([0, 0.04, 0.09], 0.06)).toEqual([]);
    expect(flamPairStarts([0, 0.04, 0.5, 0.53], 0.06)).toEqual([0, 2]);
    // 間が広い2打（16分）はフラムではない
    expect(flamPairStarts([0, 0.1], 0.06)).toEqual([]);
  });

  it('手元の譜面の6連（152BPM・1/24・66ms）はフラムではない', () => {
    // 小節の 1/2 から 1/24 ずつ4打
    const d = dtx(152, ['#00112: ' + '000000000000000000000000010101010000000000000000']);
    expect(findFlamPairs(d, buildTempoMap(d))).toEqual([]);
  });
});

describe('無理な配置とフラム', () => {
  const chip = (id: number, ch: number, m: number, n = 0, dd = 1) => ({ id, ch, m, f: { n, d: dd }, v: 1 });
  const doc = (chips: ReturnType<typeof chip>[], bpm = 120): DtxDoc => ({ ...emptyDoc(), fields: { BPM: String(bpm) }, chips, nextId: 999 });

  it('スネアのフラム（31ms）は連打の警告にしない', () => {
    // 120BPM の 1/64 = 31ms
    const d = doc([chip(1, CH.SD, 0, 32, 64), chip(2, CH.SD, 0, 33, 64), chip(3, CH.BD, 0, 0, 4)]);
    expect(findIssues(d, buildTempoMap(d))).toEqual([]);
  });

  it('3打続く速い連打は今までどおり警告', () => {
    const d = doc([chip(1, CH.SD, 0, 32, 64), chip(2, CH.SD, 0, 33, 64), chip(3, CH.SD, 0, 34, 64)]);
    const is = findIssues(d, buildTempoMap(d));
    expect(is.map((i) => i.kind)).toEqual(['fast']);
  });

  it('足のすばやい2打はフラムではない（警告のまま）', () => {
    const d = doc([chip(1, CH.BD, 0, 32, 64), chip(2, CH.BD, 0, 33, 64)]);
    expect(findIssues(d, buildTempoMap(d)).map((i) => i.kind)).toEqual(['fast']);
  });
});
