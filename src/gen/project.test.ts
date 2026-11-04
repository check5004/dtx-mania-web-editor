import { describe, expect, it } from 'vitest';
import { CH } from '../dtx/model';
import { ORIGIN_KEY } from '../dtx/origin';
import { parseDtx } from '../dtx/parse';
import { buildTempoMap } from '../dtx/timing';
import { projectCharts } from './project';

const load = (lines: string[]) => parseDtx(lines.join('\r\n') + '\r\n').doc;

// 開いている譜面（MASTER）：BGM は 0 小節の頭、音は WAV01（スネア 100）・WAV02（キック）
const BASE = load(['#TITLE: Song', '#BPM: 120', '#DLEVEL: 75', '#WAV01: snare.wav', '#WAV02: bd.wav', '#WAVZZ: song.ogg', '#00001: ZZ', '#00012: 01010101', '#00013: 02020202']);

describe('ほかの難易度の譜面を、開いている譜面の上に写す', () => {
  it('同じ時間の所に置き、音は同じファイル・音量の番号に付け替える（無ければ空いている番号に足す）', () => {
    const ext = load([
      '#TITLE: Song',
      '#BPM: 120',
      '#DLEVEL: 62',
      '#DTXE_ORIGIN: AI 0123abcd from mstr.dtx',
      '#WAV05: Snare.wav',
      '#WAV06: snare.wav',
      '#VOLUME06: 50',
      '#WAVZZ: song.ogg',
      '#00001: ZZ',
      '#00012: 05000600',
    ]);
    const [out] = projectCharts(BASE, [ext]);
    const drums = out.chips.filter((c) => c.ch === CH.SD);
    expect(drums.map((c) => [c.m, c.f.n / c.f.d])).toEqual([
      [0, 0],
      [0, 0.5],
    ]);
    // 開いている譜面のキックは消える（写すのはドラムのチップだけで、BGM は開いている譜面のもの）
    expect(out.chips.some((c) => c.ch === CH.BD)).toBe(false);
    expect(out.chips.filter((c) => c.ch === CH.BGM)).toHaveLength(1);
    // 大文字小文字だけ違う同じ音は WAV01、音量違いは新しい番号に VOLUME 付きで
    expect(drums[0].v).toBe(1);
    const no = drums[1].v;
    expect(no).not.toBe(1);
    const z = no.toString(36).toUpperCase().padStart(2, '0');
    expect(out.fields['WAV' + z]).toBe('snare.wav');
    expect(out.fields['VOLUME' + z]).toBe('50');
    // レベルは写した譜面の、印は持ち越さない
    expect(out.fields['DLEVEL']).toBe('62');
    expect(out.fields[ORIGIN_KEY]).toBeUndefined();
    // 元の譜面は変えない
    expect(BASE.chips.some((c) => c.ch === CH.BD)).toBe(true);
  });

  it('原曲の頭（最初の BGM チップ）をそろえる：BGM が1小節あとから始まる譜面は、1小節前にずらして写す', () => {
    const late = load(['#BPM: 120', '#WAV01: snare.wav', '#WAVZZ: song.ogg', '#00101: ZZ', '#00212: 01000000']);
    const [out] = projectCharts(BASE, [late]);
    const sd = out.chips.filter((c) => c.ch === CH.SD);
    expect(sd).toHaveLength(1);
    expect(sd[0].m).toBe(1);
    expect(sd[0].f.n).toBe(0);
  });

  it('BPM の書き方が違っても、秒でそろえて開いている譜面の小節・位置に置く', () => {
    // 倍の BPM で、1小節が開いている譜面の半小節
    const fast = load(['#BPM: 240', '#WAV01: snare.wav', '#WAVZZ: song.ogg', '#00001: ZZ', '#00112: 01000000']);
    const [out] = projectCharts(BASE, [fast]);
    const sd = out.chips.filter((c) => c.ch === CH.SD);
    expect(sd).toHaveLength(1);
    const t = buildTempoMap(out);
    expect(t.beatOf(sd[0].m, sd[0].f)).toBeCloseTo(2, 6);
  });

  it('写す譜面どうしで同じ番号の表を使う（足した番号がぶつからない）', () => {
    const a = load(['#BPM: 120', '#WAV01: tom.wav', '#WAVZZ: song.ogg', '#00001: ZZ', '#00014: 01000000']);
    const b = load(['#BPM: 120', '#WAV01: crash.wav', '#WAVZZ: song.ogg', '#00001: ZZ', '#00016: 01000000']);
    const [pa, pb] = projectCharts(BASE, [a, b]);
    const va = pa.chips.find((c) => c.ch === 0x14)!.v;
    const vb = pb.chips.find((c) => c.ch === 0x16)!.v;
    expect(va).not.toBe(vb);
    expect([1, 2, 35 * 36 + 35]).not.toContain(va);
    expect([1, 2, 35 * 36 + 35]).not.toContain(vb);
    // 使う譜面にだけ定義を書く
    const z = (n: number) => n.toString(36).toUpperCase().padStart(2, '0');
    expect(pa.fields['WAV' + z(va)]).toBe('tom.wav');
    expect(pa.fields['WAV' + z(vb)]).toBeUndefined();
    expect(pb.fields['WAV' + z(vb)]).toBe('crash.wav');
  });
});
