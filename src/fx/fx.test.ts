import { applyPatches, enablePatches, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { CH, DRUM_LANES } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import { buildTempoMap } from '../dtx/timing';
import { renderFx } from './dsp';
import {
  curveBeats,
  FX_NAME_RE,
  fxPath,
  fxStem,
  nominalFreq,
  parseFxLine,
  specTag,
  specText,
  stepValue,
  valueAt,
  valsAt,
  type FxCurve,
  type FxSide,
} from './model';
import { chipSpec } from './plan';
import { fxInfosOf, reconcileFx, type ReconcileEnv } from './reconcile';

enablePatches();

const laneIndex = (key: string) => DRUM_LANES.findIndex((l) => l.key === key);

describe('周波数の丸め（呼び名）', () => {
  it('1/6 オクターブに丸めて R20 の呼び名にする（デザインの表と同じ）', () => {
    expect(nominalFreq(13800, 6)).toBe(14000);
    expect(nominalFreq(13200, 6)).toBe(12500);
    expect(nominalFreq(12530, 6)).toBe(12500);
    expect(nominalFreq(11800, 6)).toBe(11200);
    expect(nominalFreq(1630, 6)).toBe(1600);
    expect(nominalFreq(1500, 6)).toBe(1600);
    expect(nominalFreq(800, 6)).toBe(800);
    expect(nominalFreq(630, 6)).toBe(630);
    expect(nominalFreq(90, 6)).toBe(90);
  });

  it('粗い（1/3）・細かい（1/12）', () => {
    expect(nominalFreq(1100, 3)).toBe(1000);
    expect(nominalFreq(1300, 3)).toBe(1250);
    expect(nominalFreq(1060, 12)).toBe(1060);
  });

  it('‹ › で 1 段ずつ', () => {
    expect(stepValue('hicut', 630, 6, 1)).toBe(710);
    expect(stepValue('hicut', 630, 6, -1)).toBe(560);
    expect(stepValue('pitch', 3, 6, 1)).toBe(4);
    expect(stepValue('pitch', 3, 12, -1)).toBe(2.5);
    expect(stepValue('pitch', 12, 6, 1)).toBe(12);
  });
});

const tempo = buildTempoMap(parseDtx('#BPM: 120\n').doc);

function curve(type: FxCurve['type'], pts: [number, number, FxCurve['points'][number]['s']?][], lanes: string[] | null = null): FxCurve {
  // 点は [小節, 値, 形]（小節の頭）
  return { id: type, type, points: pts.map(([m, v, s]) => ({ m, n: 0, d: 1, v, ...(s ? { s } : {}) })), lanes, q: 0 };
}

describe('カーブの値', () => {
  it('最初の点より前と最後の点より後はかけない。あいだは周波数の比でつなぐ', () => {
    const c = curveBeats(curve('hicut', [[2, 16000], [4, 1000]]), tempo, laneIndex);
    expect(valueAt(c, 7.9)).toBeNull();
    expect(valueAt(c, 8)).toBe(16000);
    expect(valueAt(c, 16)).toBe(1000);
    expect(valueAt(c, 16.01)).toBeNull();
    expect(valueAt(c, 12)).toBeCloseTo(4000, 5);
  });

  it('形（ゆっくり・急に・そのまま）', () => {
    const slow = curveBeats(curve('pitch', [[0, 0, 'slow'], [1, 12]]), tempo, laneIndex);
    expect(valueAt(slow, 2)).toBeCloseTo(3, 5);
    const fast = curveBeats(curve('pitch', [[0, 0, 'fast'], [1, 12]]), tempo, laneIndex);
    expect(valueAt(fast, 2)).toBeCloseTo(9, 5);
    const hold = curveBeats(curve('pitch', [[0, 5, 'hold'], [1, 12]]), tempo, laneIndex);
    expect(valueAt(hold, 3.9)).toBe(5);
    expect(valueAt(hold, 4)).toBe(12);
  });

  it('重なるときはハイカットはいちばん低い方、ピッチは足す。かけるレーンだけ', () => {
    const cs = [curve('hicut', [[0, 2000], [1, 2000]]), curve('hicut', [[0, 800], [1, 800]], ['SD']), curve('pitch', [[0, 2], [1, 2]]), curve('pitch', [[0, 3], [1, 3]])].map((c) =>
      curveBeats(c, tempo, laneIndex),
    );
    const sd = valsAt(cs, laneIndex('SD'), 1);
    expect(sd.hicut).toBe(800);
    expect(sd.pitch).toBe(5);
    expect(valsAt(cs, laneIndex('BD'), 1).hicut).toBe(2000);
  });
});

describe('かけ方の書き方とファイル名', () => {
  it('ファイル名（デザインと同じ）', () => {
    expect(fxPath('kick.ogg', { hc: [{ t: 0, v: 12500 }] })).toBe('fx/kick_hc12500.ogg');
    expect(fxPath('hh_close.ogg', { hc: [{ t: 0, v: 6300 }] })).toBe('fx/hh_close_hc6300.ogg');
    expect(fxPath('clap.wav', { hc: [{ t: 0, v: 2000 }], lc: [{ t: 0, v: 90 }] })).toBe('fx/clap_hc2000_lc90.wav');
    expect(specTag({ pt: [{ t: 0, v: 5 }] })).toBe('up5');
    expect(specTag({ pt: [{ t: 0, v: -3 }] })).toBe('down3');
    expect(specTag({ pt: [{ t: 0, v: 5.5 }] })).toBe('up5h');
    expect(specTag({ hc: [{ t: 0, v: 2000 }], hq: 2 })).toBe('hc2000r2');
    expect(specTag({ hc: [{ t: 0, v: 12500 }, { t: 0.5, v: 6300 }] })).toMatch(/^sw\d{6}$/);
  });

  it('フォルダの中の音・英数字でない名前・mp3 は数を足して分ける', () => {
    expect(fxStem('kick.ogg')).toBe('kick');
    expect(fxStem('036_kick__.ogg')).toBe('036_kick__');
    expect(fxStem('kick_.ogg')).not.toBe(fxStem('kick.ogg'));
    expect(fxStem('drums/kick.ogg')).toMatch(/^kick_\d{6}$/);
    expect(fxStem('drums/kick.ogg')).not.toBe(fxStem('other/kick.ogg'));
    expect(fxStem('スネア.ogg')).toMatch(/^sound_\d{6}$/);
    expect(fxPath('kick.mp3', { hc: [{ t: 0, v: 2000 }] })).toMatch(/^fx\/kick_\d{6}_hc2000\.ogg$/);
  });

  it('エディタが作った名前だけを見分ける', () => {
    for (const p of ['fx/kick_hc12500.ogg', 'fx/clap_hc2000_lc90.wav', 'fx/clap_up5.ogg', 'fx/crash_sw123456.ogg', 'fx/kick_123456_hc31p5r2.ogg', 'fx/sd_down0h.wav']) expect(FX_NAME_RE.test(p)).toBe(true);
    for (const p of ['fx/explosion.ogg', 'kick_hc12500.ogg', 'fx/sub/kick_hc12500.ogg', 'fx/kick_hc12500.mp3']) expect(FX_NAME_RE.test(p)).toBe(false);
  });

  it('「;fx」の行を読む（パスに空白があってもよい）', () => {
    expect(parseFxLine(';fx kick.ogg hicut 12500')).toEqual({ orig: 'kick.ogg', spec: { hc: [{ t: 0, v: 12500 }] } });
    const s = { hc: [{ t: 0, v: 2000 }, { t: 0.25, v: 1600 }], hq: 1 as const, lc: [{ t: 0, v: 90 }], pt: [{ t: 0, v: -2.5 }] };
    expect(parseFxLine(`;fx my drums/clap 1.wav ${specText(s)}`)).toEqual({ orig: 'my drums/clap 1.wav', spec: s });
    expect(specText({ pt: [{ t: 0, v: 5 }] })).toBe('pitch +5');
    expect(parseFxLine('; just a comment')).toBeNull();
    expect(parseFxLine(';fx kick.ogg')).toBeNull();
  });
});

describe('長く鳴る音', () => {
  const side: FxSide = { curves: [curve('hicut', [[1, 16000], [2, 1000]])], res: 6, tails: true };
  const env = { tempo, side, curves: side.curves.map((c) => curveBeats(c, tempo, laneIndex)) };

  it('余韻のあいだにカーブが動けば、余韻の中でも動かす', () => {
    // 120 BPM：1 小節 2 秒。小節 1 の 3 拍目のシンバル（2.5 秒鳴る）
    const s = chipSpec(env, laneIndex('CY'), 6, 2.5)!;
    expect(s.hc!.length).toBeGreaterThan(2);
    expect(s.hc![0].v).toBe(nominalFreq(valueAt(env.curves[0], 6)!, 6));
    // 小節 2 の頭（カーブの終わり）を過ぎたらかけない（0）
    expect(s.hc![s.hc!.length - 1].v).toBe(0);
  });

  it('短い音・余韻をオフにしたときは鳴り始めの値だけ', () => {
    expect(chipSpec(env, laneIndex('CY'), 6, 0.2)!.hc).toHaveLength(1);
    expect(chipSpec({ ...env, side: { ...side, tails: false } }, laneIndex('CY'), 6, 2.5)!.hc).toHaveLength(1);
  });
});

describe('かけた音を作る', () => {
  const sr = 48000;
  const sine = (f: number, sec = 0.5) => {
    const x = new Float32Array(Math.round(sr * sec));
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
    return x;
  };
  const rms = (x: Float32Array) => Math.sqrt(x.slice(x.length >> 2).reduce((a, v) => a + v * v, 0) / (x.length - (x.length >> 2)));

  it('ハイカットは高い音を、ローカットは低い音を削る（24 dB/oct）', () => {
    const hi = sine(8000);
    expect(rms(renderFx([hi], sr, { hc: [{ t: 0, v: 1000 }] })[0]) / rms(hi)).toBeLessThan(0.001);
    expect(rms(renderFx([sine(200)], sr, { hc: [{ t: 0, v: 1000 }] })[0]) / rms(sine(200))).toBeGreaterThan(0.95);
    expect(rms(renderFx([sine(100)], sr, { lc: [{ t: 0, v: 800 }] })[0]) / rms(sine(100))).toBeLessThan(0.001);
  });

  it('境目の強調で境目が持ち上がる', () => {
    const at = sine(1000);
    const plain = rms(renderFx([at], sr, { hc: [{ t: 0, v: 1000 }] })[0]);
    const strong = rms(renderFx([at], sr, { hc: [{ t: 0, v: 1000 }], hq: 2 })[0]);
    expect(strong / plain).toBeGreaterThan(2.5);
  });

  it('ピッチ +12 で半分の長さ・高さは倍、-12 で倍の長さ', () => {
    const x = sine(440, 1);
    const up = renderFx([x], sr, { pt: [{ t: 0, v: 12 }] })[0];
    expect(up.length).toBeCloseTo(x.length / 2, -1);
    // 0 をまたぐ回数で高さを見る
    const cross = (y: Float32Array) => y.reduce((n, v, i) => n + (i && Math.sign(v) !== Math.sign(y[i - 1]) ? 1 : 0), 0) / (y.length / sr);
    expect(cross(up) / cross(x)).toBeCloseTo(2, 1);
    expect(renderFx([x], sr, { pt: [{ t: 0, v: -12 }] })[0].length).toBeCloseTo(x.length * 2, -1);
  });

  it('余韻の中で動くハイカット', () => {
    const x = sine(4000, 1);
    const y = renderFx([x], sr, { hc: [{ t: 0, v: 16000 }, { t: 0.5, v: 500 }] })[0];
    const head = rms(y.slice(0, sr / 10));
    const tail = rms(y.slice(Math.round(sr * 0.8)));
    expect(head).toBeGreaterThan(0.3);
    expect(tail).toBeLessThan(0.01);
  });
});

const SONG = [
  '#TITLE: t',
  '#BPM: 120',
  '#WAV01: bgm.ogg',
  '#WAV02: kick.ogg',
  '#WAV03: hh_close.ogg',
  '#WAV04: hh_close.ogg',
  '#VOLUME04: 70',
  '#WAV05: snare.wav ;Snare Rim',
  '',
  '#00101: 01',
  '#00113: 0202020202020202',
  '#00213: 0202020202020202',
  '#00311: 03040304',
  '#00412: 05',
  '#00113: 02',
].join('\r\n');

function envOf(side: FxSide): ReconcileEnv {
  return { side, tempo: buildTempoMap(parseDtx(SONG).doc), laneIndex, soundSec: () => 0 };
}

describe('チップの音をそろえる', () => {
  const base = parseDtx(SONG).doc;
  // 小節 2〜3 の頭までハイカット 1 kHz（そのまま）。小節 3 の頭の点の所まで
  const side: FxSide = { curves: [{ id: 'a', type: 'hicut', points: [{ m: 2, n: 0, d: 1, v: 1000, s: 'hold' }, { m: 3, n: 0, d: 1, v: 1000 }], lanes: null, q: 0 }], res: 6, tails: true };

  it('かかる所のチップをかけた音にし、#WAV の前に「;fx」の行を書く。強さ違いは番号を分ける', () => {
    const r = reconcileFx(base, envOf(side))!;
    expect(r).not.toBeNull();
    const doc = r.doc;
    const text = serializeDtx(doc);
    expect(text).toMatch(/;fx kick\.ogg hicut 1000\r?\n#WAV[0-9A-Z]{2}: fx\/kick_hc1000\.ogg/);
    expect(text).toMatch(/;fx hh_close\.ogg hicut 1000\r?\n#WAV[0-9A-Z]{2}: fx\/hh_close_hc1000\.ogg/);
    // 小節 1 のキックはそのまま、小節 2 のキックはかけた音
    const kicks = doc.chips.filter((c) => c.ch === CH.BD);
    expect(kicks.filter((c) => c.m === 1).every((c) => c.v === 2)).toBe(true);
    const fxKick = kicks.find((c) => c.m === 2)!.v;
    expect(doc.fields['WAV' + fxKick.toString(36).toUpperCase().padStart(2, '0')]).toBe('fx/kick_hc1000.ogg');
    // HH の強さ違い（70）は別の番号で #VOLUME 70
    const hh = doc.chips.filter((c) => c.ch === CH.HHC && c.m === 3);
    expect(hh).toHaveLength(4);
    // 小節 3 の頭（最後の点）にあるチップだけかかる
    const hhFx = new Set(hh.filter((c) => doc.fields['WAV' + c.v.toString(36).toUpperCase().padStart(2, '0')].startsWith('fx/')).map((c) => c.v));
    expect(hhFx.size).toBe(1);
    // リムのラベルはかけた音にも写す
    expect(r.changed).toBeGreaterThan(8);
    expect(fxInfosOf(doc).size).toBe(2);
    // BGM は加工しない
    expect(doc.chips.find((c) => c.ch === CH.BGM)!.v).toBe(1);
    // パッチで戻せる
    expect(applyPatches(doc, r.undo)).toEqual(base);
  });

  it('外へ動かすと元の音に戻り、使わなくなったかけた音と「;fx」の行は消す', () => {
    const r = reconcileFx(base, envOf(side))!;
    const moved = produce(r.doc, (d) => {
      for (const c of d.chips) if (c.ch === CH.BD && c.m === 2) c.m = 5;
    });
    const r2 = reconcileFx(moved, envOf(side))!;
    expect(r2.doc.chips.filter((c) => c.ch === CH.BD).every((c) => c.v === 2)).toBe(true);
    const text = serializeDtx(r2.doc);
    expect(text).not.toMatch(/kick_hc1000/);
    expect(text).toMatch(/;fx hh_close\.ogg hicut 1000/);
  });

  it('カーブを消すと全部元に戻る。エフェクトを扱わない譜面（作業ファイルなし）は触らない', () => {
    const r = reconcileFx(base, envOf(side))!;
    const r2 = reconcileFx(r.doc, envOf({ ...side, curves: [] }))!;
    expect(serializeDtx(r2.doc)).toBe(serializeDtx(base));
    expect(reconcileFx(base, envOf({ ...side, curves: [] }))).toBeNull();
  });

  it('同じ譜面にもう一度かけても何も変えない', () => {
    const r = reconcileFx(base, envOf(side))!;
    expect(reconcileFx(r.doc, envOf(side))).toBeNull();
    // 読み直しても同じ
    expect(reconcileFx(parseDtx(serializeDtx(r.doc)).doc, envOf(side))).toBeNull();
  });

  it('スネアのリムのラベルを写す', () => {
    const s2: FxSide = { ...side, curves: [{ ...side.curves[0], points: [{ m: 4, n: 0, d: 1, v: 2000 }, { m: 5, n: 0, d: 1, v: 2000 }] }] };
    const r = reconcileFx(base, envOf(s2))!;
    expect(serializeDtx(r.doc)).toMatch(/#WAV[0-9A-Z]{2}: fx\/snare_hc2000\.wav ; ?Snare Rim/);
  });
});
