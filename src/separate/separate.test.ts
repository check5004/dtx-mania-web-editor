import { describe, expect, it } from 'vitest';
import { Fft, OverlapAdd, SegmentStft, inverseWeightSum, planSegments, readWindow, splitWeight, type Geometry } from './dsp';
import { SEP_MODELS, geometryOf } from './models';
import { plannedFiles, sourceNameInfo } from './names';

function noise(n: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 2 ** 32 - 0.5) * 0.8 + 0.3 * Math.sin(i * 0.013 * (1 + seed));
  }
  return out;
}

const small: Geometry[] = [
  { nfft: 256, hop: 64, chunk: 4096, window: 'hann', normalized: false },
  { nfft: 512, hop: 128, chunk: 4000, input: 4096, window: 'rect', normalized: true },
  { nfft: 512, hop: 128, chunk: 4000, input: 4096, window: 'hann', normalized: true },
];

describe('FFT', () => {
  it('素朴な DFT と同じ', () => {
    const n = 64;
    const fft = new Fft(n);
    const x = noise(n, 1);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft.transform(re, im, false);
    for (const k of [0, 1, 7, 31, 32, 50]) {
      let sr = 0;
      let si = 0;
      for (let i = 0; i < n; i++) {
        sr += x[i] * Math.cos((-2 * Math.PI * k * i) / n);
        si += x[i] * Math.sin((-2 * Math.PI * k * i) / n);
      }
      expect(re[k]).toBeCloseTo(sr, 4);
      expect(im[k]).toBeCloseTo(si, 4);
    }
    // 逆変換（1/n はしない）で戻る
    fft.transform(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i] / n).toBeCloseTo(x[i], 5);
  });
});

describe('STFT（torch.stft / istft と同じ）', () => {
  it.each(small)('左右とも素朴な DFT と同じ値になる %#', (g) => {
    const st = new SegmentStft(g);
    const L = noise(st.length, 2);
    const R = noise(st.length, 3);
    const re = new Float32Array(st.specSize);
    const im = new Float32Array(st.specSize);
    st.forward(L, R, re, im);
    const n = g.nfft;
    const w = (i: number) => (g.window === 'rect' ? 1 : 0.5 * (1 - Math.cos((2 * Math.PI * i) / n)));
    const scale = g.normalized ? 1 / Math.sqrt(n) : 1;
    for (const [ch, x] of [L, R].entries()) {
      for (const [f, k] of [
        [0, 0],
        [3, 5],
        [st.frames - 1, n / 2],
        [10, n / 2 - 1],
      ]) {
        let sr = 0;
        let si = 0;
        for (let i = 0; i < n; i++) {
          let idx = f * g.hop - n / 2 + i;
          if (idx < 0) idx = -idx;
          else if (idx >= st.length) idx = 2 * (st.length - 1) - idx;
          sr += x[idx] * w(i) * Math.cos((-2 * Math.PI * k * i) / n);
          si += x[idx] * w(i) * Math.sin((-2 * Math.PI * k * i) / n);
        }
        const o = ch * st.bins * st.frames + k * st.frames + f;
        expect(re[o]).toBeCloseTo(sr * scale, 3);
        expect(im[o]).toBeCloseTo(si * scale, 3);
      }
    }
  });

  it.each(small)('逆 STFT で元の音に戻る %#', (g) => {
    const st = new SegmentStft(g);
    const L = noise(st.length, 4);
    const R = noise(st.length, 5);
    const re = new Float32Array(st.specSize * 2);
    const im = new Float32Array(st.specSize * 2);
    // 2本目（offset）に入れて戻す
    const re2 = new Float32Array(st.specSize);
    const im2 = new Float32Array(st.specSize);
    st.forward(L, R, re2, im2);
    re.set(re2, st.specSize);
    im.set(im2, st.specSize);
    const oL = new Float32Array(st.length);
    const oR = new Float32Array(st.length);
    st.inverse(re, im, st.specSize, oL, oR);
    let e = 0;
    for (let i = 0; i < st.length; i++) e = Math.max(e, Math.abs(oL[i] - L[i]), Math.abs(oR[i] - R[i]));
    expect(e).toBeLessThan(1e-5);
  });

  it('実際のモデルの形（フレーム数・周波数の数）', () => {
    const bs = new SegmentStft(geometryOf(SEP_MODELS.bs_roformer_sw));
    expect([bs.bins, bs.frames]).toEqual([1025, 1151]);
    const sc = new SegmentStft(geometryOf(SEP_MODELS.scnet_small));
    expect([sc.bins, sc.frames, sc.length]).toEqual([2049, 476, 486400]);
  });
});

describe('区切りと重ね合わせ', () => {
  it('Demucs と同じ区切り方（25% 重ね、最後は前の音を足して中央に置く）', () => {
    const segs = planSegments(1000, 400, 0.25);
    expect(segs.map((s) => s.start)).toEqual([0, 300, 600, 900]);
    expect(segs[3]).toEqual({ start: 900, len: 100, from: 750, trim: 150 });
    expect(splitWeight(4)).toEqual(Float32Array.from([0.5, 1, 1, 0.5]));
  });

  it('モデルが音をそのまま返すなら、重ねた結果も元の音になる', () => {
    const n = 2345;
    const chunk = 500;
    const L = noise(n, 6);
    const R = noise(n, 7);
    const segs = planSegments(n, chunk, 0.25);
    const w = splitWeight(chunk);
    const acc = new OverlapAdd(n, w);
    const inL = new Float32Array(chunk);
    const inR = new Float32Array(chunk);
    for (const s of segs) {
      readWindow(L, s.from, chunk, inL);
      readWindow(R, s.from, chunk, inR);
      acc.add(s, inL, inR);
    }
    acc.finish(inverseWeightSum(n, segs, w));
    for (let i = 0; i < n; i++) {
      expect(acc.left[i]).toBeCloseTo(L[i], 5);
      expect(acc.right[i]).toBeCloseTo(R[i], 5);
    }
  });

  it('曲の外は 0 で埋める', () => {
    const src = Float32Array.from([1, 2, 3, 4]);
    const dst = new Float32Array(6).fill(9);
    readWindow(src, -2, 5, dst);
    expect([...dst]).toEqual([0, 0, 1, 2, 3, 0]);
    readWindow(src, 2, 5, dst);
    expect([...dst]).toEqual([3, 4, 0, 0, 0, 0]);
  });
});

describe('ファイルの名前', () => {
  it('ドラム抜きの印を見つけて、元の名前を頭にする', () => {
    expect(sourceNameInfo('bgm.ogg')).toEqual({ base: 'bgm', drumless: false });
    expect(sourceNameInfo('bgm_drumless.ogg')).toEqual({ base: 'bgm', drumless: true });
    expect(sourceNameInfo('Song (No Drums).wav')).toEqual({ base: 'Song', drumless: true });
    expect(sourceNameInfo('曲_ドラム抜き.mp3')).toEqual({ base: '曲', drumless: true });
    expect(sourceNameInfo('mix_nodrums.ogg')).toEqual({ base: 'mix', drumless: true });
    expect(sourceNameInfo('sub/drums.ogg')).toEqual({ base: 'drums', drumless: false });
    expect(sourceNameInfo('drumless.ogg')).toEqual({ base: 'bgm', drumless: true });
  });

  it('作るファイル：2本ならドラムとドラム抜き、楽器ごとなら「その他」が残り', () => {
    expect(plannedFiles('bs_roformer_sw', 'two', 'bgm')).toEqual([
      { name: 'bgm_drums.ogg', stem: 'drums' },
      { name: 'bgm_nodrums.ogg', stem: 'rest' },
    ]);
    const all = plannedFiles('scnet_small', 'all', 'x');
    expect(all.map((f) => f.name)).toEqual(['x_drums.ogg', 'x_bass.ogg', 'x_vocals.ogg', 'x_other.ogg']);
    expect(plannedFiles('bs_roformer_sw', 'all', 'x').map((f) => f.stem)).toEqual(['drums', 'bass', 'vocals', 'guitar', 'piano', 'rest']);
    expect(all.filter((f) => f.stem === 'rest').map((f) => f.name)).toEqual(['x_other.ogg']);
  });
});
