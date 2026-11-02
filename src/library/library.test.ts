import { describe, expect, it } from 'vitest';
import { builtinFile, parseBuiltinFile } from '../audio/sounds';
import { CH } from '../dtx/model';
import { classifyUsage, features, instFromName, miniPeaks, similarity } from './analyze';

describe('classifyUsage', () => {
  it('一番多く使われたレーンの楽器にする', () => {
    const r = classifyUsage(new Map([[CH.SD, 94], [CH.HT, 6]]), 'x.wav');
    expect(r.inst).toBe('snare');
    expect(r.conf).toBeCloseTo(0.94);
    expect(r.reason).toContain('SD');
  });
  it('迷うときはファイル名を見る', () => {
    const r = classifyUsage(new Map([[CH.HT, 5], [CH.SD, 5]]), 'crash_01.wav');
    expect(r.inst).toBe('crash');
  });
  it('使われていなければファイル名、それも無ければその他', () => {
    expect(classifyUsage(new Map(), 'kick.wav').inst).toBe('kick');
    expect(classifyUsage(new Map(), 'zzz.wav').inst).toBe('other');
  });
  it('HHO と左ペダルはハイハット、左バスドラはキック', () => {
    expect(classifyUsage(new Map([[CH.HHO, 3], [CH.LP, 3]]), '').inst).toBe('hihat');
    expect(classifyUsage(new Map([[CH.LBD, 3]]), '').inst).toBe('kick');
  });
});

describe('instFromName', () => {
  it('よくある名前', () => {
    expect(instFromName('BD_01.wav')).toBe('kick');
    expect(instFromName('snare-rim.ogg')).toBe('snare');
    expect(instFromName('ride bell.wav')).toBe('ride');
    expect(instFromName('china.wav')).toBe('crash');
  });
});

describe('標準キットのファイル名', () => {
  it('作ったファイル名を読み戻せる', () => {
    for (const kit of ['std', 'rock', 'synth']) {
      const f = builtinFile(kit, CH.SD)!;
      const p = parseBuiltinFile(`snd/${f}`)!;
      expect(p.kit).toBe(kit);
      expect(p.lane.ch).toBe(CH.SD);
    }
  });
  it('知らないキットやレーンは null', () => {
    expect(parseBuiltinFile('dtxweb_nope_sd.wav')).toBeNull();
    expect(parseBuiltinFile('dtxweb_std_xx.wav')).toBeNull();
    expect(parseBuiltinFile('lib_sd.wav')).toBeNull();
  });
});

describe('特徴量', () => {
  const sr = 44100;
  const tone = (f: number, decay: number) => {
    const x = new Float32Array(sr / 2);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (sr * decay));
    return x;
  };
  it('同じ音どうしは 1、違う音は低い', () => {
    const a = features(tone(60, 0.05), sr);
    const b = features(tone(60, 0.05), sr);
    const c = features(tone(6000, 0.3), sr);
    expect(similarity(a, b)).toBeCloseTo(1);
    expect(similarity(a, c)).toBeLessThan(similarity(a, b));
  });
  it('一覧の波形は 48 個で 0〜255', () => {
    const p = miniPeaks(tone(200, 0.1), sr);
    expect(p).toHaveLength(48);
    expect(Math.max(...p)).toBe(255);
    expect(Math.min(...p)).toBeGreaterThanOrEqual(0);
  });
});
