// 標準キットを作る: キットごと・レーンごとに1音ずつ作って OGG にする（作り方は scripts/kits/defs.mjs）。
// 使い方: node scripts/make-kits.mjs --src <音源のフォルダ> [--only キット,…] [--lanes レーン,…] [--wav <確かめ用のフォルダ>]
//   音源のフォルダの中身と取り方は scripts/kits/SOURCES.md（どれも再配布してよいもの）。
//   --only を書かないと全部のキットを作り直す。前の版の6キット（std など）は GeneralUser GS だけで作れる
//   --lanes を書くと、その音だけ作る（ほかの音のファイルは変えない）。特殊ノーツの音（clap・tamb・cowbell・shaker）は、defs.mjs で special を書いたキットだけ
//   --wav を書くと、同じ音を 16bit の WAV でも書く（耳や道具で確かめる用。リポジトリには入れない）
// 出力: public/kits/<キット>/<レーン>.ogg（モノラル・44.1kHz・Vorbis q6。ピークを -1 dB にそろえる）
// 読むのに ffmpeg を使う（FLAC・WAV など）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { clearDecodeCache, decodeFile, encodeOgg, encodeWav16, SR } from './kits/audio-io.mjs';
import { KITS, LANE_LEN, LANES, SP_LANES, SP_LEN } from './kits/defs.mjs';
import { biquad, compress, crush, decay, gate, limit, loudness, mix, peak, resample, reverb, saturate, scale, transient } from './kits/dsp.mjs';
import { loadSfz, pickRegions, renderHit } from './kits/sfz.mjs';
import { SYNTH } from './kits/synth.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const srcDir = arg('--src');
if (!srcDir) {
  console.error('usage: node scripts/make-kits.mjs --src <dir> [--only kit,...] [--lanes lane,...] [--wav <dir>]');
  process.exit(1);
}
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const onlyLanes = arg('--lanes') ? new Set(arg('--lanes').split(',')) : null;
const wavDir = arg('--wav');
for (const id of only ?? []) if (!KITS.some((k) => k.id === id)) throw new Error(`キットがありません: ${id}`);

// ---- 音を作る ----

const sfzCache = new Map();
function program(file) {
  let p = sfzCache.get(file);
  if (!p) {
    p = loadSfz(path.join(srcDir, file));
    sfzCache.set(file, p);
  }
  return p;
}

let bank = null;
/** GeneralUser GS のドラムセットを鳴らす（左右を足してモノラルに） */
function renderSf2(file, prog, note, vel, seconds) {
  if (!bank) {
    const buf = fs.readFileSync(path.join(srcDir, file));
    bank = SoundBankLoader.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: false });
  synth.onMissingPreset = () => undefined;
  synth.soundBankManager.addSoundBank(bank, 'gu');
  synth.programChange(9, prog);
  synth.noteOn(9, note, vel);
  const len = Math.ceil(SR * seconds);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  for (let i = 0; i < len; i += 128) synth.process(L, R, i, Math.min(128, len - i));
  const m = new Float64Array(len);
  for (let i = 0; i < len; i++) m[i] = (L[i] + R[i]) * 0.5;
  return m;
}

/** 音声ファイルを1つ読む（左右を足してモノラルに、44.1kHz に） */
function renderFile(file) {
  const s = decodeFile(path.join(srcDir, file));
  const m = new Float64Array(s.channels[0].length);
  for (const c of s.channels) for (let i = 0; i < m.length; i++) m[i] += c[i] / s.channels.length;
  return s.sampleRate === SR ? m : resample(m, s.sampleRate / SR);
}

function applyFx(x, list) {
  let y = x;
  for (const [op, a, b, c] of list) {
    if (op === 'hpf') y = biquad(y, { type: 'hpf_2p', hz: a, Q: b ?? 0.7071 }, SR);
    else if (op === 'lpf') y = biquad(y, { type: 'lpf_2p', hz: a, Q: b ?? 0.7071 }, SR);
    else if (op === 'peq') y = biquad(y, { type: 'peq', hz: a, gain: b, bw: c ?? 1 }, SR);
    else if (op === 'low') y = biquad(y, { type: 'lowshelf', hz: a, gain: b }, SR);
    else if (op === 'high') y = biquad(y, { type: 'highshelf', hz: a, gain: b }, SR);
    else if (op === 'comp') y = compress(y, a, SR);
    else if (op === 'sat') y = saturate(y, a, b ?? 1);
    else if (op === 'crush') y = crush(y, a, b ?? 1);
    else if (op === 'verb') y = reverb(y, a, SR);
    else if (op === 'gate') y = gate(y, a, b, SR);
    else if (op === 'punch') y = transient(y, a, SR);
    else if (op === 'decay') y = decay(y, a, SR);
    else if (op === 'gain') y = scale(y, 10 ** (a / 20));
    else throw new Error(`知らない加工: ${op}`);
  }
  return y;
}

/** 1つの音を作る（lane は合成の音を選ぶのと、長さの目安） */
function render(src, lane, seconds) {
  let y;
  if (src.mix) {
    y = mix(...src.mix.map((p) => [render(p, lane, seconds), 10 ** ((p.gain ?? 0) / 20), Math.round((p.at ?? 0) * SR)]));
  } else if (src.sfz) {
    const prog = program(src.sfz);
    const picks = pickRegions(prog, { key: src.key, vel: src.vel ?? 112, cc: src.cc ?? {} });
    if (!picks.length) throw new Error(`鳴る音がありません: ${src.sfz} key ${src.key}`);
    y = Float64Array.from(renderHit(picks, { seconds: seconds + 1 }));
  } else if (src.sf2) {
    y = renderSf2(src.sf2, src.program, src.note, src.vel ?? 112, seconds);
  } else if (src.file) {
    y = renderFile(src.file);
  } else if (src.synth) {
    const f = SYNTH[src.synth]?.[src.lane ?? lane];
    if (!f) throw new Error(`合成の音がありません: ${src.synth} ${src.lane ?? lane}`);
    y = Float64Array.from(f());
  } else throw new Error(`音の書き方がわかりません: ${JSON.stringify(src)}`);
  if (src.pitch) y = resample(y, 2 ** (src.pitch / 12));
  if (src.fx) y = applyFx(y, src.fx);
  return y;
}

/**
 * 頭の無音を削り、長さの上限で切り、ピークを -1 dB にそろえる。head は頭を削る大きさ（ピークからの dB）。
 * 上限でまだ鳴っている音（シンバルなど）は、終わりの 3 割をなめらかに下げる（ぶつっと切れないように）
 */
function tidy(x, maxSec, head = -54) {
  const pk = peak(x);
  if (pk < 1e-6) return null;
  const th = pk * 10 ** (head / 20);
  let a = 0;
  while (a < x.length && Math.abs(x[a]) < th) a++;
  // 削った所は 0.5 ms でなめらかに始める（ハイハットのペダルの「踏む前の音」を削ったときに、ぷつっと鳴らないように）
  const fadeIn = head > -40 ? Math.round(SR * 0.0005) : 0;
  a = Math.max(0, a - (fadeIn || 8));
  const limit = Math.min(x.length, a + Math.round(maxSec * SR));
  const tail = pk * 0.001;
  let b = limit - 1;
  while (b > a && Math.abs(x[b]) < tail) b--;
  const cut = b >= limit - Math.round(0.05 * SR);
  b = Math.min(limit, b + Math.round(SR * 0.02));
  const out = new Float32Array(b - a);
  const k = 10 ** (-1 / 20) / pk;
  for (let i = 0; i < out.length; i++) out[i] = x[a + i] * k;
  const f = cut ? Math.round(out.length * 0.3) : Math.min(out.length, Math.round(SR * 0.03));
  for (let i = 0; i < f; i++) {
    const t = i / f;
    out[out.length - 1 - i] *= cut ? Math.sin((t * Math.PI) / 2) ** 2 : t;
  }
  for (let i = 0; i < fadeIn && i < out.length; i++) out[i] *= i / fadeIn;
  return out;
}

/**
 * 聞こえる大きさ（dsp.mjs の loudness）の目安。前の版の GeneralUser GS のキットに合わせた値で、
 * キットを替えても同じ譜面がだいたい同じ大きさで鳴るように、ほかのキットをここへ寄せる
 */
const TARGET = { bd: -16, lbd: -16, sd: -16, rim: -21, hhc: -21, hho: -15, lp: -20, ht: -15, lt: -15, ft: -15, lc: -13, cy: -13, rd: -17 };
const LOW = new Set(['bd', 'lbd', 'ht', 'lt', 'ft']);

const normalize = (y) => scale(y, 10 ** (-1 / 20) / peak(y));

/**
 * 大きすぎる音は下げ、小さすぎる音は叩いた瞬間のピークを抑えて（6 dB まで）から上げる。
 * 目安から 1.5 dB 以内なら何もしない
 */
function level(s, lane) {
  const target = TARGET[lane];
  if (target === undefined) return s;
  const L = loudness(s, SR);
  if (L > target + 1.5) return scale(s, 10 ** ((target - L) / 20));
  if (L >= target - 1.5) return s;
  let red = Math.min(6, target - L);
  let y = s;
  for (let it = 0; it < 4; it++) {
    y = normalize(limit(s, red, SR, { release: LOW.has(lane) ? 0.08 : 0.04 }));
    const L2 = loudness(y, SR);
    if (L2 > target + 1.5) return scale(y, 10 ** ((target - L2) / 20));
    if (L2 >= target - 1 || red >= 6) break;
    red = Math.min(6, red + (target - L2));
  }
  return y;
}

// ---- 書き出す ----

let total = 0;
for (const kit of KITS) {
  if (only ? !only.has(kit.id) : false) continue;
  const dir = path.join(root, 'public/kits', kit.id);
  fs.mkdirSync(dir, { recursive: true });
  if (wavDir) fs.mkdirSync(path.join(wavDir, kit.id), { recursive: true });
  let kitBytes = 0;
  // 特殊ノーツ（クラップなど）は special を書いたキットだけ
  for (const lane of [...LANES, ...SP_LANES.filter((l) => kit.special?.[l])]) {
    if (onlyLanes && !onlyLanes.has(lane)) continue;
    const src = kit.lanes[lane] ?? kit.special?.[lane] ?? (lane === 'lbd' ? kit.lanes.bd : undefined);
    if (!src) throw new Error(`${kit.id} に ${lane} の音がありません`);
    const len = kit.len?.[lane] ?? (lane === 'lbd' ? kit.len?.bd : undefined) ?? LANE_LEN[lane] ?? SP_LEN[lane];
    // lbd を書かないキットは bd と同じ音（合成の音も bd の作り方で）
    let y = render(src, kit.lanes[lane] || kit.special?.[lane] ? lane : 'bd', len + 0.5);
    const fx = [...(kit.fx?.['*'] ?? []), ...(kit.fx?.[lane] ?? [])];
    if (fx.length) y = applyFx(y, fx);
    // 前の版のキット（keepLevel）は前と同じ作り方。ほかは、ペダルのハイハットの踏む前の音を削り、音量をそろえる
    const t = tidy(y, len, kit.keepLevel ? -54 : (kit.head?.[lane] ?? (lane === 'lp' ? -18 : -54)));
    if (!t) throw new Error(`無音: ${kit.id} ${lane}`);
    const s = kit.keepLevel ? t : level(t, lane);
    const bytes = await encodeOgg(s);
    fs.writeFileSync(path.join(dir, `${lane}.ogg`), bytes);
    if (wavDir) fs.writeFileSync(path.join(wavDir, kit.id, `${lane}.wav`), encodeWav16(s));
    kitBytes += bytes.length;
    console.log(`${kit.id}/${lane}.ogg  ${(s.length / SR).toFixed(2)}s  ${(bytes.length / 1024).toFixed(1)} KB`);
  }
  total += kitBytes;
  console.log(`== ${kit.id}  ${(kitBytes / 1024).toFixed(0)} KB`);
  clearDecodeCache();
}
console.log(`合計 ${(total / 1024 / 1024).toFixed(2)} MB`);
