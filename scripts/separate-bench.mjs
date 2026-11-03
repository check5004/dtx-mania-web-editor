// ステム分解の精度テスト（Node・CPU）。エディタと同じ信号処理（src/separate/dsp.ts）でモデルを動かし、
// 「本物のドラムの録音（drums）」と「ドラム抜きの BGM（bgm）」を足した音を分解して、元の2本とどれだけ合うかを測る。
//
// 使い方:
//   npm i --no-save onnxruntime-node
//   node scripts/separate-bench.mjs --models <モデルのフォルダ> --model bs_roformer_sw --precision fp32 \
//     --song <名前>=<bgm.f32>,<drums.f32> [--song …] [--seconds 60] [--overlap 0.25] [--adtof <adtof.onnx>] [--save <出力フォルダ>]
//
// - .f32 は 44.1kHz・ステレオ・float32 のサンプルを左右交互に並べたもの（ffmpeg -f f32le -ar 44100 -ac 2 で作れる）。
// - モデルは src/separate/models.ts の URL から落としたファイル（<id>_<fp16|fp32>.onnx）。
// - SDR は MVSEP と同じ 10·log10(Σ正解² / Σ(正解−推定)²)（曲全体・左右まとめて）。
// - --adtof を付けると、ドラム抜きの推定に残ったドラムの打点を採譜モデル（ADTOF）で数える（作者の閾値）。
// - 正解付きの公開データ（MUSDB18 の .stem.mp4 など）も、ドラムと「ドラム以外を足した音」を .f32 にすれば同じように測れる
//   （ffmpeg -i x.stem.mp4 -map 0:1 -f f32le -ar 44100 -ac 2 drums.f32 -filter_complex "[0:2][0:3][0:4]amix=inputs=3:normalize=0[a]" -map "[a]" -f f32le -ar 44100 -ac 2 bgm.f32）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { SegmentStft, planSegments, splitWeight, readWindow, inverseWeightSum, OverlapAdd } from '../src/separate/dsp.ts';
import { SEP_MODELS, geometryOf } from '../src/separate/models.ts';

function args() {
  const a = process.argv.slice(2);
  const o = { songs: [], overlap: 0.25, precision: 'fp32', seconds: 0, threads: os.cpus().length };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = a[i + 1];
    if (k === '--song') {
      const [name, files] = v.split('=');
      const [bgm, drums] = files.split(',');
      o.songs.push({ name, bgm, drums });
      i++;
    } else if (k.startsWith('--')) {
      o[k.slice(2)] = v;
      i++;
    }
  }
  o.overlap = Number(o.overlap);
  o.seconds = Number(o.seconds);
  o.threads = Number(o.threads);
  return o;
}

const opt = args();
const require = createRequire(import.meta.url);
const ort = opt.ort ? require(opt.ort) : require('onnxruntime-node');

function readStereo(file, maxSamples) {
  const b = fs.readFileSync(file);
  const all = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const n = Math.min(all.length / 2, maxSamples || Infinity);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = all[2 * i];
    R[i] = all[2 * i + 1];
  }
  return [L, R];
}

function sdr(refs, ests) {
  let num = 0;
  let den = 0;
  for (let c = 0; c < refs.length; c++) {
    const r = refs[c];
    const e = ests[c];
    for (let i = 0; i < r.length; i++) {
      num += r[i] * r[i];
      const d = r[i] - e[i];
      den += d * d;
    }
  }
  return 10 * Math.log10((num + 1e-8) / (den + 1e-8));
}

/** 分解する。返り値は stems[名前] = [左, 右] */
async function separate(session, model, L, R, overlap, onSeg) {
  const g = geometryOf(model);
  const st = new SegmentStft(g);
  const n = L.length;
  const segs = planSegments(n, g.chunk, overlap);
  const weight = splitWeight(g.chunk);
  const inv = inverseWeightSum(n, segs, weight);
  const acc = model.stems.map(() => new OverlapAdd(n, weight));
  const inL = new Float32Array(st.length);
  const inR = new Float32Array(st.length);
  const re = new Float32Array(st.specSize);
  const im = new Float32Array(st.specSize);
  const outL = new Float32Array(st.length);
  const outR = new Float32Array(st.length);
  const shape = [1, 2, st.bins, st.frames];
  let tModel = 0;
  let tDsp = 0;
  for (const [i, seg] of segs.entries()) {
    let t0 = performance.now();
    readWindow(L, seg.from, g.chunk, inL);
    readWindow(R, seg.from, g.chunk, inR);
    st.forward(inL, inR, re, im);
    let t1 = performance.now();
    tDsp += t1 - t0;
    const out = await session.run({ spec_real: new ort.Tensor('float32', re, shape), spec_imag: new ort.Tensor('float32', im, shape) });
    const t2 = performance.now();
    tModel += t2 - t1;
    const oRe = out.out_spec_real.data;
    const oIm = out.out_spec_imag.data;
    for (let s = 0; s < model.stems.length; s++) {
      st.inverse(oRe, oIm, s * st.specSize, outL, outR);
      acc[s].add(seg, outL, outR);
    }
    tDsp += performance.now() - t2;
    onSeg?.(i + 1, segs.length);
  }
  const stems = {};
  model.stems.forEach((name, s) => {
    acc[s].finish(inv);
    stems[name] = [acc[s].left, acc[s].right];
  });
  return { stems, tModel, tDsp, segments: segs.length };
}

// ---- 採譜モデルで残ったドラムを数える ----------------------------------------------
const ADTOF_THR = [0.22, 0.24, 0.32, 0.22, 0.3];
const ADTOF_CLS = ['BD', 'SD', 'TT', 'HH', 'CY'];

function pickPeaks(act, nCls, c, fps, threshold) {
  const n = Math.floor(act.length / nCls);
  const preAvg = Math.round(0.1 * fps);
  const postAvg = Math.round(0.01 * fps);
  const preMax = Math.round(0.02 * fps);
  const postMax = Math.round(0.01 * fps);
  const avgLen = preAvg + postAvg + 1;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + act[i * nCls + c];
  const det = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - preAvg);
    const hi = Math.min(n - 1, i + postAvg);
    const avg = (cum[hi + 1] - cum[lo]) / avgLen;
    const v = act[i * nCls + c];
    det[i] = v >= avg + threshold ? v : 0;
  }
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = det[i];
    if (!(v > 0)) continue;
    let mx = 0;
    for (let k = Math.max(0, i - preMax); k <= Math.min(n - 1, i + postMax); k++) if (det[k] > mx) mx = det[k];
    if (v !== mx) continue;
    const t = i / fps;
    if (out.length && t - last <= 0.02 + 1e-12) continue;
    out.push(t);
    last = t;
  }
  return out;
}

async function drumHits(adtof, L, R) {
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2;
  const hop = 441;
  const frames = Math.ceil(mono.length / hop);
  const act = new Float32Array(frames * 5);
  const CHUNK = 4000;
  const CONTEXT = 1500;
  for (let a = 0; a < frames; a += CHUNK) {
    const b = Math.min(frames, a + CHUNK);
    const s0 = Math.max(0, a - CONTEXT);
    const s1 = Math.min(frames, b + CONTEXT);
    const seg = mono.slice(s0 * hop, Math.min(mono.length, s1 * hop));
    const out = await adtof.run({ waveform: new ort.Tensor('float32', seg, [1, seg.length]) });
    const y = out.activations.data;
    const off = a - s0;
    act.set(y.subarray(off * 5, (off + (b - a)) * 5), a * 5);
  }
  const counts = {};
  let total = 0;
  ADTOF_CLS.forEach((cls, c) => {
    counts[cls] = pickPeaks(act, 5, c, 100, ADTOF_THR[c]).length;
    total += counts[cls];
  });
  return { total, ...counts };
}

// ---- 本体 ---------------------------------------------------------------------------
const model = SEP_MODELS[opt.model];
if (!model) throw new Error(`モデル ${opt.model} がありません（${Object.keys(SEP_MODELS).join(', ')}）`);
const file = path.join(opt.models, `${model.id}_${opt.precision}.onnx`);
let t = performance.now();
const session = await ort.InferenceSession.create(file, { intraOpNumThreads: opt.threads, graphOptimizationLevel: 'all' });
console.error(`${model.id} ${opt.precision}: 読み込み ${((performance.now() - t) / 1000).toFixed(1)}s`);
const adtof = opt.adtof ? await ort.InferenceSession.create(opt.adtof, { intraOpNumThreads: opt.threads }) : null;

const rows = [];
for (const song of opt.songs) {
  const max = opt.seconds > 0 ? Math.round(opt.seconds * 44100) : 0;
  const [bL, bR] = readStereo(song.bgm, max);
  const [dL, dR] = readStereo(song.drums, max);
  const n = Math.min(bL.length, dL.length);
  const mL = new Float32Array(n);
  const mR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mL[i] = bL[i] + dL[i];
    mR[i] = bR[i] + dR[i];
  }
  t = performance.now();
  const r = await separate(session, model, mL, mR, opt.overlap, (i, all) => process.stderr.write(`\r${song.name} ${i}/${all}`));
  const wall = performance.now() - t;
  process.stderr.write('\n');
  const [eL, eR] = r.stems.drums;
  // ドラム抜き: (1) ドラム以外のステムの和 (2) 原曲 − ドラム
  const oL = new Float32Array(n);
  const oR = new Float32Array(n);
  for (const name of model.stems) {
    if (name === 'drums') continue;
    const [a, b] = r.stems[name];
    for (let i = 0; i < n; i++) {
      oL[i] += a[i];
      oR[i] += b[i];
    }
  }
  const xL = new Float32Array(n);
  const xR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xL[i] = mL[i] - eL[i];
    xR[i] = mR[i] - eR[i];
  }
  // 全部のステムの和と原曲の合い方（処理が正しければ高い）
  const aL = new Float32Array(n);
  const aR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    aL[i] = oL[i] + eL[i];
    aR[i] = oR[i] + eR[i];
  }
  // 5秒ごとのドラムの SDR（中央値と、悪い所）
  const win = 5 * 44100;
  const local = [];
  for (let a = 0; a + win <= n; a += win) {
    const ref = [dL.subarray(a, a + win), dR.subarray(a, a + win)];
    let e = 0;
    for (const r of ref) for (let i = 0; i < r.length; i++) e += r[i] * r[i];
    if (e < 1e-3) continue;
    local.push(sdr(ref, [eL.subarray(a, a + win), eR.subarray(a, a + win)]));
  }
  local.sort((x, y) => x - y);
  const row = {
    song: song.name,
    recon: +sdr([mL, mR], [aL, aR]).toFixed(2),
    drumsMedian5s: local.length ? +local[Math.floor(local.length / 2)].toFixed(2) : null,
    drumsWorst5s: local.length ? +local[0].toFixed(2) : null,
    sec: +(n / 44100).toFixed(1),
    drums: +sdr([dL.subarray(0, n), dR.subarray(0, n)], [eL, eR]).toFixed(2),
    bgmSum: +sdr([bL.subarray(0, n), bR.subarray(0, n)], [oL, oR]).toFixed(2),
    bgmMinus: +sdr([bL.subarray(0, n), bR.subarray(0, n)], [xL, xR]).toFixed(2),
    wallSec: +(wall / 1000).toFixed(1),
    modelSec: +(r.tModel / 1000).toFixed(1),
    dspSec: +(r.tDsp / 1000).toFixed(1),
    segments: r.segments,
  };
  if (adtof) {
    if (opt.reference) {
      row.hitsMix = await drumHits(adtof, mL, mR);
      row.hitsTrue = await drumHits(adtof, bL.subarray(0, n), bR.subarray(0, n));
    }
    row.hitsSum = await drumHits(adtof, oL, oR);
    row.hitsMinus = await drumHits(adtof, xL, xR);
  }
  if (opt.save) {
    fs.mkdirSync(opt.save, { recursive: true });
    const inter = (L, R) => {
      const o = new Float32Array(L.length * 2);
      for (let i = 0; i < L.length; i++) {
        o[2 * i] = L[i];
        o[2 * i + 1] = R[i];
      }
      return Buffer.from(o.buffer);
    };
    fs.writeFileSync(path.join(opt.save, `${song.name}_${model.id}_drums.f32`), inter(eL, eR));
    fs.writeFileSync(path.join(opt.save, `${song.name}_${model.id}_nodrums_sum.f32`), inter(oL, oR));
    fs.writeFileSync(path.join(opt.save, `${song.name}_${model.id}_nodrums_minus.f32`), inter(xL, xR));
  }
  rows.push(row);
  console.log(JSON.stringify({ model: model.id, precision: opt.precision, overlap: opt.overlap, ...row }));
}
