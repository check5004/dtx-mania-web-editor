import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { audibleEnd } from '../audio/dsp';
import { opDeleteMeasures, opInsertMeasures } from '../edit/measures';
import { endMarker, endMeasureOf, moveEndDecorations, naturalEndMeasure, solidEndMeasure, takeEndMarker } from './end';
import { CH, emptyDoc, type Chip, type DtxDoc } from './model';
import { parseDtx } from './parse';
import { serializeDtx } from './serialize';

const chip = (id: number, ch: number, m: number, n = 0, d = 1, v = 1): Chip => ({ id, ch, m, f: { n, d }, v });

function doc(chips: Chip[], extra: Partial<DtxDoc> = {}): DtxDoc {
  return { ...emptyDoc(), header: [{ kind: 'raw', text: '#BPM: 120' }], fields: {}, chips, nextId: chips.length + 1, ...extra };
}

/** 書き出して読み直す */
function roundTrip(d: DtxDoc): DtxDoc {
  return parseDtx(serializeDtx(d)).doc;
}

describe('曲の終わり（NX と同じ決め方）', () => {
  it('最後のチップ（どのチャンネルでも）の次の小節で終わる', () => {
    expect(naturalEndMeasure(doc([]))).toBe(0);
    expect(naturalEndMeasure(doc([chip(1, CH.SD, 0), chip(2, CH.BD, 3, 3, 4)]))).toBe(4);
    // BGM や SE のチップも数える
    expect(naturalEndMeasure(doc([chip(1, CH.SD, 0), chip(2, 0x61, 7)]))).toBe(8);
  });
  it('小節長（ch02）も数える', () => {
    expect(naturalEndMeasure(doc([chip(1, CH.SD, 0)], { barLengths: { 5: 0.75 } }))).toBe(6);
  });
  it('フィルインの終わり（ch53 の 02）は 32/384 小節あとに置かれるので、小節をまたぐと終わりも延びる', () => {
    expect(naturalEndMeasure(doc([chip(1, CH.FILLIN, 4, 1, 2, 2)]))).toBe(5);
    expect(naturalEndMeasure(doc([chip(1, CH.FILLIN, 4, 15, 16, 2)]))).toBe(6);
    // 始まり（01）はずらさない
    expect(naturalEndMeasure(doc([chip(1, CH.FILLIN, 4, 15, 16, 1)]))).toBe(5);
  });
  it('決めた終わり・自動の終わりは、最後のチップより前にはならない', () => {
    const d = doc([chip(1, CH.SD, 9)]);
    expect(endMeasureOf(d)).toBe(10);
    expect(endMeasureOf(d, 30)).toBe(30);
    expect(endMeasureOf(d, 4)).toBe(10);
    expect(endMeasureOf({ ...d, endMeasure: 20 }, 30)).toBe(20);
    expect(endMeasureOf({ ...d, endMeasure: 5 }, 30)).toBe(10);
  });
});

describe('曲の終わりの書き出しと読み込み', () => {
  it('最後のチップより後まで続けるときは、終わりの1つ前の小節の頭に表示を変えない C2 を書く', () => {
    const d = doc([chip(1, CH.BGM, 0), chip(2, CH.SD, 3)], { endMeasure: 10 });
    expect(endMarker(d)).toMatchObject({ ch: CH.LINE_DISPLAY, m: 9, f: { n: 0, d: 1 }, v: 1 });
    expect(serializeDtx(d)).toContain('#009C2: 01\r\n');
    // 線を消している所なら 02（見た目は変えない）
    const hidden = doc([chip(1, CH.SD, 3), chip(2, CH.LINE_DISPLAY, 2, 0, 1, 2)], { endMeasure: 10 });
    expect(endMarker(hidden)?.v).toBe(2);
  });
  it('終わりが最後のチップの次の小節なら印は書かない', () => {
    expect(endMarker(doc([chip(1, CH.SD, 3)], { endMeasure: 4 }))).toBeNull();
    expect(endMarker(doc([chip(1, CH.SD, 3)]))).toBeNull();
  });
  it('書いた印は読み込むと取り除いて、曲の終わりに戻す', () => {
    const d = doc([chip(1, CH.BGM, 0), chip(2, CH.SD, 3, 1, 4)], { endMeasure: 12 });
    const back = roundTrip(d);
    expect(back.endMeasure).toBe(12);
    expect(back.chips.map((c) => [c.ch, c.m])).toEqual([
      [CH.BGM, 0],
      [CH.SD, 3],
    ]);
    // もう一度書いても同じ
    expect(serializeDtx(back)).toBe(serializeDtx(d));
  });
  it('線を消している譜面でも往復できる', () => {
    const d = doc([chip(1, CH.SD, 3), chip(2, CH.LINE_DISPLAY, 1, 0, 1, 2)], { endMeasure: 8 });
    const back = roundTrip(d);
    expect(back.endMeasure).toBe(8);
    expect(back.chips.filter((c) => c.ch === CH.LINE_DISPLAY)).toHaveLength(1);
  });
  it('印の無いドラム譜面は、NX と同じ終わりに決める（保存しても終わりも中身も変わらない）', () => {
    const text = ['#BPM: 120', '', '#00101: 01', '#00312: 0101', '#00513: 01', ''].join('\r\n');
    const { doc: d } = parseDtx(text);
    expect(d.endMeasure).toBe(6);
    expect(serializeDtx(d)).toBe(text);
  });
  it('他のエディタが終わりを延ばすのに置いた C2（小節の途中・表示を変えるもの）は残す', () => {
    const text = ['#BPM: 120', '', '#00512: 01', '#010C2: 0002', ''].join('\r\n');
    const { doc: d } = parseDtx(text);
    expect(d.endMeasure).toBe(11);
    expect(d.chips.some((c) => c.ch === CH.LINE_DISPLAY)).toBe(true);
    expect(serializeDtx(d)).toBe(text);
  });
  it('ドラムの無い作りかけの譜面は終わりを決めない（原曲の鳴り終わりに合わせる）', () => {
    const { doc: d } = parseDtx(['#BPM: 120', '#00101: 01', ''].join('\r\n'));
    expect(d.endMeasure).toBeUndefined();
  });
  it('takeEndMarker は表示を変える C2 を印とみなさない', () => {
    const d = doc([chip(1, CH.SD, 3), chip(2, CH.LINE_DISPLAY, 9, 0, 1, 2)]);
    takeEndMarker(d);
    expect(d.chips).toHaveLength(2);
    expect(d.endMeasure).toBe(10);
  });
});

describe('曲の終わりを動かす', () => {
  // 変換した譜面によくある形：ドラムは 59 小節で終わり、73 小節の少し後の C2:02 で最後の小節線を消して終わりを延ばす
  const mephisto = () => doc([chip(1, CH.BGM, 1), chip(2, CH.SD, 59, 7, 8), chip(3, CH.LINE_DISPLAY, 73, 1, 32, 2)]);

  it('C2 を除いた最後のチップの次の小節より前にはできない', () => {
    expect(naturalEndMeasure(mephisto())).toBe(74);
    expect(solidEndMeasure(mephisto())).toBe(60);
  });
  it('終わりの飾り（最後の小節の C2）は新しい最後の小節へ一緒に動く', () => {
    const d = produce(mephisto(), (x) => {
      moveEndDecorations(x as DtxDoc, 74, 65);
      x.endMeasure = 65;
    });
    const c2 = d.chips.find((c) => c.ch === CH.LINE_DISPLAY)!;
    expect([c2.m, c2.f.n, c2.f.d, c2.v]).toEqual([64, 1, 32, 2]);
    expect(naturalEndMeasure(d)).toBe(65);
    // 延ばすときも一緒
    const e = produce(mephisto(), (x) => {
      moveEndDecorations(x as DtxDoc, 74, 80);
      x.endMeasure = 80;
    });
    expect(e.chips.find((c) => c.ch === CH.LINE_DISPLAY)!.m).toBe(79);
    expect(serializeDtx(e)).not.toContain('C2: 01');
  });
  it('新しい終わりより後に残る C2 は消す', () => {
    const base = doc([chip(1, CH.SD, 5), chip(2, CH.LINE_DISPLAY, 20, 0, 1, 2), chip(3, CH.LINE_DISPLAY, 30, 1, 2, 1), chip(4, CH.LINE_DISPLAY, 40, 1, 32, 2)]);
    const d = produce(base, (x) => {
      moveEndDecorations(x as DtxDoc, 41, 25);
      x.endMeasure = 25;
    });
    expect(d.chips.filter((c) => c.ch === CH.LINE_DISPLAY).map((c) => [c.m, c.v])).toEqual([
      [20, 2],
      [24, 2],
    ]);
  });
  it('小節の挿入・削除で終わりもずれる', () => {
    const base = doc([chip(1, CH.SD, 3)], { endMeasure: 10 });
    expect(produce(base, (x) => void opInsertMeasures(x, 2, 3)).endMeasure).toBe(13);
    expect(produce(base, (x) => void opInsertMeasures(x, 10, 1)).endMeasure).toBe(11);
    expect(produce(base, (x) => void opInsertMeasures(x, 11, 1)).endMeasure).toBe(10);
    expect(produce(base, (x) => void opDeleteMeasures(x, 5, 2)).endMeasure).toBe(8);
    // 終わりを含む範囲を消したら、消したところ
    expect(produce(base, (x) => void opDeleteMeasures(x, 8, 4)).endMeasure).toBe(8);
  });
});

describe('音の鳴り終わり', () => {
  const buf = (data: Float32Array[], sampleRate = 1000) => ({
    numberOfChannels: data.length,
    sampleRate,
    duration: data[0].length / sampleRate,
    getChannelData: (c: number) => data[c],
  });
  it('末尾のほぼ無音（フェードの残り・詰め物）は数えない', () => {
    const a = new Float32Array(3000);
    for (let i = 0; i < 1500; i++) a[i] = Math.sin(i) * 0.5;
    for (let i = 1500; i < 3000; i++) a[i] = 0.001 * Math.sin(i);
    expect(audibleEnd(buf([a]))).toBeCloseTo(1.5, 2);
  });
  it('どれかのチャンネルが鳴っていれば鳴っている', () => {
    const l = new Float32Array(2000);
    const r = new Float32Array(2000);
    l[500] = 0.4;
    r[1700] = 0.4;
    expect(audibleEnd(buf([l, r]))).toBeCloseTo(1.701, 3);
  });
  it('全部が小さい音なら長さそのまま', () => {
    expect(audibleEnd(buf([new Float32Array(800)]))).toBeCloseTo(0.8);
  });
});
