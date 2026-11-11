// README のスクリーンショット用のデモ曲「Neon Skyline」を作る（この README のために作った架空の曲。実在の曲ではない）。
// 使い方: node scripts/readme/demo-song.mjs [出力先]（既定 .readme-demo/Neon Skyline）
// - ドラムは内蔵キット（public/kits/rock）の音を譜面どおりに並べ、ベース・コード・メロディは簡単な合成で作る
// - 原曲 bgm.ogg（全部入り）、ステム stems/{drums,bass,vocals,other}.ogg、試聴 preview.ogg、ジャケット jacket.png（Playwright で描く）
// - 譜面は MASTER（mstr.dtx）から EXTREME・ADVANCED・BASIC を間引いて作る。set.def と作業ファイル（セクション・ステム）も
// ffmpeg と Playwright が要る。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] ?? path.join(root, '.readme-demo', 'Neon Skyline'));
mkdirSync(path.join(out, 'stems'), { recursive: true });

const SR = 44100;
const BPM = 172;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const BARS = 41; // 小節 0（カウント）〜 40。END は 41 の頭
const LEN = Math.ceil((BARS * BAR + 3) * SR);

// ---- 乱数（毎回同じ曲になるように） ----
let seed = 20261111;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ---- 曲の形 ----
const SECTIONS = [
  { m: 1, name: 'イントロ' },
  { m: 5, name: 'Aメロ' },
  { m: 13, name: 'Bメロ' },
  { m: 17, name: 'サビ' },
  { m: 25, name: '間奏' },
  { m: 29, name: 'ラスサビ' },
  { m: 37, name: 'アウトロ' },
];
const sectionOf = (m) => [...SECTIONS].reverse().find((s) => s.m <= m)?.name ?? 'count';

// コード（小節ごと）。E マイナー（G メジャー）。サビは王道進行
const CH = { Em: [40, [0, 3, 7, 10]], C: [36, [0, 4, 7, 11]], D: [38, [0, 4, 7, 10]], B: [47, [0, 4, 7, 10]], Bm: [47, [0, 3, 7, 10]], Am: [45, [0, 3, 7, 10]], G: [43, [0, 4, 7, 11]] };
const PROG = {
  イントロ: ['Em', 'C', 'D', 'B'],
  Aメロ: ['Em', 'Em', 'C', 'C', 'Am', 'Am', 'B', 'B'],
  Bメロ: ['C', 'D', 'Bm', 'Em'],
  サビ: ['C', 'D', 'Bm', 'Em', 'C', 'D', 'B', 'B'],
  間奏: ['Em', 'C', 'D', 'B'],
  ラスサビ: ['C', 'D', 'Bm', 'Em', 'C', 'D', 'B', 'Em'],
  アウトロ: ['C', 'D', 'Em', 'Em'],
};
const chordOf = (m) => {
  if (m < 1) return null;
  const s = [...SECTIONS].reverse().find((x) => x.m <= m);
  const p = PROG[s.name];
  return CH[p[(m - s.m) % p.length]];
};

// ---- ドラムの譜面（16 分 = 6、1 小節 = 96） ----
// lane: LC HH HHO LP SD HT BD LT FT CY RD。v: 1 ふつう、0.7 弱め（HH の裏）、0.35 ゴースト
const notes = []; // { m, p, lane, v }
const put = (m, p16, lane, v = 1) => notes.push({ m, p: Math.round(p16 * 6), lane, v });
const each = (list, f) => list.forEach(f);

function groove(m) {
  const sec = sectionOf(m);
  const i = m - (SECTIONS.find((s) => s.name === sec)?.m ?? 0);
  const last = (len) => i === len - 1;
  if (sec === 'count') {
    each([0, 4, 8, 12], (p) => put(m, p, 'LP'));
    return;
  }
  if (sec === 'イントロ') {
    if (last(4)) {
      // フィル: スネアの 16 分 → タム
      each([0, 1, 2, 3, 4, 5, 6, 7], (p) => put(m, p, 'SD', p % 2 ? 0.7 : 1));
      each([8, 9], (p) => put(m, p, 'HT'));
      each([10, 11], (p) => put(m, p, 'LT'));
      each([12, 13, 14, 15], (p) => put(m, p, 'FT'));
      each([0, 8], (p) => put(m, p, 'BD'));
      return;
    }
    put(m, 0, i % 2 ? 'LC' : 'CY');
    each([2, 4, 6, 8, 10, 12, 14], (p) => put(m, p, 'HH', p % 4 ? 0.7 : 1));
    each([0, 3, 8, 10], (p) => put(m, p, 'BD'));
    each([4, 12], (p) => put(m, p, 'SD'));
    return;
  }
  if (sec === 'Aメロ') {
    if (last(8)) {
      each([0, 2, 4, 6], (p) => put(m, p, 'HH', p % 4 ? 0.7 : 1));
      each([0, 3], (p) => put(m, p, 'BD'));
      put(m, 4, 'SD');
      each([8, 9, 10, 11], (p) => put(m, p, 'SD', p % 2 ? 0.7 : 1));
      each([12, 13], (p) => put(m, p, 'HT'));
      put(m, 14, 'LT');
      put(m, 15, 'FT');
      return;
    }
    if (i === 0) put(m, 0, 'LC');
    else put(m, 0, 'HH');
    each([2, 4, 6, 8, 10, 12], (p) => put(m, p, 'HH', p % 4 ? 0.7 : 1));
    put(m, 14, i % 2 ? 'HHO' : 'HH', 0.7);
    each(i % 2 ? [0, 6, 8] : [0, 3, 8, 11], (p) => put(m, p, 'BD'));
    each([4, 12], (p) => put(m, p, 'SD'));
    if (i % 2 === 0) put(m, 7, 'SD', 0.35);
    if (i === 3 || i === 5) put(m, 15, 'SD', 0.35);
    return;
  }
  if (sec === 'Bメロ') {
    if (last(4)) {
      // だんだん細かく: 8 分 → 16 分
      each([0, 2, 4, 6], (p) => put(m, p, 'SD', 0.7 + p * 0.03));
      each([8, 9, 10, 11, 12, 13, 14, 15], (p) => put(m, p, 'SD', 0.8 + (p - 8) * 0.025));
      each([0, 4, 8, 12], (p) => put(m, p, 'BD'));
      return;
    }
    each([0, 2, 4, 6, 8, 10, 12, 14], (p) => put(m, p, 'RD', p % 4 ? 0.7 : 1));
    each([0, 8, 10], (p) => put(m, p, 'BD'));
    each([4, 12], (p) => put(m, p, 'SD'));
    each([4, 12], (p) => put(m, p, 'LP'));
    return;
  }
  if (sec === 'サビ' || sec === 'ラスサビ') {
    const len = 8;
    if (last(len)) {
      if (sec === 'サビ') {
        each([0, 2, 4, 6], (p) => put(m, p, 'HH', p % 4 ? 0.7 : 1));
        each([0, 2], (p) => put(m, p, 'BD'));
        put(m, 4, 'SD');
        each([8, 9], (p) => put(m, p, 'HT'));
        each([10, 11], (p) => put(m, p, 'LT'));
        each([12, 13], (p) => put(m, p, 'FT'));
        each([14, 15], (p) => put(m, p, 'SD'));
        each([8, 12], (p) => put(m, p, 'BD'));
      }
      return; // ラスサビの最後はアウトロへ（下で）
    }
    put(m, 0, i % 4 === 0 ? 'CY' : i % 4 === 2 ? 'LC' : 'HH');
    each([2, 6, 10, 14], (p) => put(m, p, 'HHO', 0.8));
    each([4, 8, 12], (p) => put(m, p, 'HH'));
    each(i % 2 ? [0, 2, 8, 10, 14] : [0, 2, 8, 10], (p) => put(m, p, 'BD'));
    each([4, 12], (p) => put(m, p, 'SD'));
    if (sec === 'ラスサビ' && i === 3) put(m, 0, 'LC');
    return;
  }
  if (sec === '間奏') {
    if (last(4)) {
      each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], (p) => put(m, p, 'SD', 0.55 + p * 0.03));
      each([0, 4, 8, 12], (p) => put(m, p, 'BD'));
      return;
    }
    each([0, 2, 4, 6, 8, 10, 12, 14], (p) => put(m, p, 'FT', p % 4 ? 0.7 : 1));
    each([0, 6, 8, 14], (p) => put(m, p, 'BD'));
    each([4, 12], (p) => put(m, p, 'SD'));
    put(m, 10, 'HT', 0.8);
    if (i === 0) put(m, 0, 'CY');
    return;
  }
  if (sec === 'アウトロ') {
    if (last(4)) {
      put(m, 0, 'CY');
      put(m, 0, 'LC');
      put(m, 0, 'BD');
      return;
    }
    if (i === 0) put(m, 0, 'CY');
    each(i === 0 ? [4, 8, 12] : [0, 4, 8, 12], (p) => put(m, p, 'RD'));
    each([0, 6], (p) => put(m, p, 'BD'));
    put(m, 8, 'SD');
    each([4, 12], (p) => put(m, p, 'LP'));
  }
}
for (let m = 0; m < BARS; m++) groove(m);
// ラスサビの最後の小節（36）: 3 連のフィル（16 分 3 連 = 4/96）
{
  const m = 36;
  each([0, 2], (p) => put(m, p, 'HH'));
  put(m, 0, 'BD');
  put(m, 4, 'SD');
  const tri = ['SD', 'SD', 'SD', 'HT', 'HT', 'HT', 'LT', 'LT', 'LT', 'FT', 'FT', 'FT'];
  tri.forEach((lane, k) => notes.push({ m, p: 48 + k * 4, lane, v: 0.75 + (k / tri.length) * 0.25 }));
  each([8, 12], (p) => put(m, p, 'BD'));
}
notes.sort((a, b) => a.m - b.m || a.p - b.p);

// ---- 音を並べる ----
const decode = (file) => {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const KIT = path.join(root, 'public/kits/rock');
const SAMPLE = { LC: 'lc', HH: 'hhc', HHO: 'hho', LP: 'lp', SD: 'sd', HT: 'ht', BD: 'bd', LT: 'lt', FT: 'ft', CY: 'cy', RD: 'rd' };
const samples = Object.fromEntries(Object.entries(SAMPLE).map(([k, f]) => [k, decode(path.join(KIT, `${f}.ogg`))]));
const PAN = { LC: -0.45, HH: 0.3, HHO: 0.3, LP: 0.3, SD: 0, HT: -0.2, BD: 0, LT: 0.15, FT: 0.35, CY: 0.45, RD: 0.4 };

const stereo = () => [new Float32Array(LEN), new Float32Array(LEN)];
const drums = stereo();
const bass = stereo();
const other = stereo();
const vocals = stereo();
const timeOf = (m, p) => (m + p / 96) * BAR;

// HH を閉じたら、鳴っているオープンを止める
const hhoStarts = [];
for (const n of notes) {
  const s = samples[n.lane];
  const t0 = Math.round(timeOf(n.m, n.p) * SR);
  let end = s.length;
  if (n.lane === 'HHO') {
    const next = notes.find((x) => (x.lane === 'HH' || x.lane === 'LP' || x.lane === 'HHO') && timeOf(x.m, x.p) > timeOf(n.m, n.p) + 1e-6);
    if (next) end = Math.min(end, Math.round((timeOf(next.m, next.p) - timeOf(n.m, n.p)) * SR) + Math.round(0.03 * SR));
    hhoStarts.push(t0);
  }
  const g = 0.9 * n.v * (n.lane === 'BD' ? 1.1 : 1);
  const pan = PAN[n.lane];
  const gl = g * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = g * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const fadeStart = end - Math.round(0.03 * SR);
  for (let i = 0; i < end && t0 + i < LEN; i++) {
    const f = i > fadeStart ? Math.max(0, (end - i) / (end - fadeStart)) : 1;
    drums[0][t0 + i] += s[i] * gl * f;
    drums[1][t0 + i] += s[i] * gr * f;
  }
}

// ---- 合成の部品 ----
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
function lowpass(x, cutoff) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    x[i] = y;
  }
  return x;
}
function addNote(dst, { t, dur, freq, gain, pan = 0, wave = 'saw', detune = 0, attack = 0.005, decay = 0.1, sustain = 0.7, release = 0.05, cutoff = 2000, vibrato = 0 }) {
  const n = Math.round((dur + release) * SR);
  const tmp = new Float32Array(n);
  const freqs = detune ? [freq * Math.pow(2, -detune / 1200), freq, freq * Math.pow(2, detune / 1200)] : [freq];
  freqs.forEach((f0, k) => {
    let ph = rnd();
    for (let i = 0; i < n; i++) {
      const tt = i / SR;
      const vib = vibrato && tt > 0.15 ? 1 + vibrato * Math.sin(2 * Math.PI * 5.5 * tt) : 1;
      ph += (f0 * vib) / SR;
      ph -= Math.floor(ph);
      let v;
      if (wave === 'saw') v = 2 * ph - 1;
      else if (wave === 'square') v = ph < 0.5 ? 1 : -1;
      else if (wave === 'tri') v = 4 * Math.abs(ph - 0.5) - 1;
      else v = Math.sin(2 * Math.PI * ph);
      tmp[i] += v / freqs.length;
    }
    void k;
  });
  lowpass(tmp, cutoff);
  lowpass(tmp, cutoff * 1.5);
  const t0 = Math.round(t * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  for (let i = 0; i < n && t0 + i < LEN; i++) {
    const tt = i / SR;
    let env;
    if (tt < attack) env = tt / attack;
    else if (tt < attack + decay) env = 1 - (1 - sustain) * ((tt - attack) / decay);
    else if (tt < dur) env = sustain;
    else env = sustain * Math.max(0, 1 - (tt - dur) / release);
    dst[0][t0 + i] += tmp[i] * env * gl;
    dst[1][t0 + i] += tmp[i] * env * gr;
  }
}

// ---- ベース（8 分でルート、サビは 5 度も） ----
for (let m = 1; m < BARS - 1; m++) {
  const c = chordOf(m);
  if (!c) continue;
  const sec = sectionOf(m);
  if (sec === 'アウトロ' && m === 40) continue;
  for (let k = 0; k < 8; k++) {
    if (sec === 'アウトロ' && k % 2) continue;
    const note = (sec === 'サビ' || sec === 'ラスサビ') && k === 6 ? c[0] + 7 : sec === '間奏' && k % 4 === 3 ? c[0] + 12 : c[0];
    addNote(bass, { t: m * BAR + k * (BEAT / 2), dur: (sec === 'アウトロ' ? BEAT : BEAT / 2) * 0.9, freq: mtof(note), gain: 0.42, wave: 'saw', detune: 6, cutoff: 700, decay: 0.12, sustain: 0.6 });
  }
}
{
  // 最後の音
  addNote(bass, { t: 40 * BAR, dur: BAR * 1.2, freq: mtof(40), gain: 0.42, wave: 'saw', detune: 6, cutoff: 600, decay: 0.4, sustain: 0.5, release: 0.6 });
}

// ---- コード（パッド）とサビのアルペジオ ----
for (let m = 1; m < BARS; m++) {
  const c = chordOf(m);
  if (!c) continue;
  const sec = sectionOf(m);
  const base = c[0] + 24 - (c[0] >= 43 ? 12 : 0);
  const end = m === 40 ? BAR * 1.6 : BAR * 0.98;
  c[1].forEach((iv, k) => addNote(other, { t: m * BAR, dur: end, freq: mtof(base + iv), gain: sec === 'Aメロ' || sec === 'アウトロ' ? 0.07 : 0.09, pan: [-0.6, -0.2, 0.2, 0.6][k], wave: 'saw', detune: 9, attack: 0.08, decay: 0.3, sustain: 0.8, release: 0.25, cutoff: 1500 }));
  if (sec === 'サビ' || sec === 'ラスサビ' || sec === 'イントロ') {
    for (let k = 0; k < 16; k++) {
      const iv = c[1][[0, 1, 2, 3, 2, 1][k % 6]];
      addNote(other, { t: m * BAR + k * (BEAT / 4), dur: BEAT / 5, freq: mtof(base + 12 + iv), gain: 0.05, pan: k % 2 ? 0.5 : -0.5, wave: 'square', decay: 0.08, sustain: 0.15, release: 0.04, cutoff: 3200 });
    }
  }
}

// ---- メロディ（「歌」のステム。三角波にビブラート） ----
const SCALE = [52, 54, 55, 57, 59, 60, 62, 64, 66, 67, 69, 71, 72, 74, 76]; // E マイナー
const RHYTHMS = {
  Aメロ: [[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 4]],
  Bメロ: [[0, 3], [3, 3], [6, 2], [8, 4], [12, 4]],
  サビ: [[0, 6], [6, 2], [8, 4], [12, 4]],
  ラスサビ: [[0, 6], [6, 2], [8, 4], [12, 4]],
};
let melodyIdx = 9;
for (let m = 5; m < 37; m++) {
  const sec = sectionOf(m);
  const r = RHYTHMS[sec];
  if (!r) continue;
  const c = chordOf(m);
  const tones = c[1].map((iv) => ((c[0] + iv) % 12));
  r.forEach(([p, len], k) => {
    if ((m - 5) % 8 === 7 && k === r.length - 1) return; // 区切りで息つぎ
    // 和音の音に近い所へ、なるべく順に動く
    const target = SCALE.map((n, idx) => ({ idx, d: Math.abs(idx - melodyIdx) + (tones.includes(n % 12) ? 0 : 1.6) + rnd() * 0.8 })).sort((a, b) => a.d - b.d)[0].idx;
    melodyIdx = Math.max(sec === 'サビ' || sec === 'ラスサビ' ? 6 : 3, Math.min(14, target + (rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : 0)));
    addNote(vocals, { t: m * BAR + p * (BEAT / 4), dur: len * (BEAT / 4) * 0.92, freq: mtof(SCALE[melodyIdx]), gain: 0.32, wave: 'tri', attack: 0.02, decay: 0.15, sustain: 0.8, release: 0.08, cutoff: 2600, vibrato: 0.006 });
  });
}

// ---- まとめて書き出す ----
function writeWav(file, [l, r], from = 0, to = LEN, peak = 1) {
  const n = to - from;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  const fade = Math.round(0.02 * SR);
  for (let i = 0; i < n; i++) {
    const f = Math.min(1, i / fade, (n - 1 - i) / fade);
    // 波形が細くならないよう、軽くつぶして（tanh）音を大きくする
    const c = (v) => Math.max(-32768, Math.min(32767, Math.round((Math.tanh((2.4 * v) / peak) / Math.tanh(2.4)) * 0.89 * 32767 * f)));
    b.writeInt16LE(c(l[from + i]), 44 + i * 4);
    b.writeInt16LE(c(r[from + i]), 46 + i * 4);
  }
  writeFileSync(file, b);
}
const toOgg = (wav, ogg) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', '-q:a', '5', ogg]);
const GAINS = { drums: 1, bass: 0.85, other: 0.8, vocals: 0.75 };
const stems = { drums, bass, other, vocals };
for (const [k, s] of Object.entries(stems)) for (const ch of s) for (let i = 0; i < LEN; i++) ch[i] *= GAINS[k];
const mix = stereo();
for (const s of Object.values(stems)) for (let c = 0; c < 2; c++) for (let i = 0; i < LEN; i++) mix[c][i] += s[c][i];
let peak = 0;
for (const ch of mix) for (const v of ch) peak = Math.max(peak, Math.abs(v));
const tmpWav = path.join(out, '_tmp.wav');
const enc = (data, file, from, to) => {
  writeWav(tmpWav, data, from, to, peak);
  toOgg(tmpWav, path.join(out, file));
};
enc(mix, 'bgm.ogg');
for (const k of Object.keys(stems)) enc(stems[k], `stems/${k}.ogg`);
enc(mix, 'preview.ogg', Math.round(17 * BAR * SR), Math.round(25 * BAR * SR));
execFileSync('rm', ['-f', tmpWav]);

// ---- 譜面 ----
const LANE_CH = { HH: '11', SD: '12', BD: '13', HT: '14', LT: '15', CY: '16', FT: '17', HHO: '18', RD: '19', LC: '1A', LP: '1B' };
const WAVS = [
  ['01', 'bgm.ogg', 100, 'BGM'],
  ['02', 'hhc.ogg', 100, 'HH Close'],
  ['03', 'sd.ogg', 100, 'Snare'],
  ['04', 'bd.ogg', 100, 'Bass Drum'],
  ['05', 'ht.ogg', 100, 'High Tom'],
  ['06', 'lt.ogg', 100, 'Low Tom'],
  ['07', 'cy.ogg', 100, 'Right Cymbal'],
  ['08', 'ft.ogg', 100, 'Floor Tom'],
  ['09', 'hho.ogg', 100, 'HH Open'],
  ['0A', 'rd.ogg', 100, 'Ride'],
  ['0B', 'lc.ogg', 100, 'Left Cymbal'],
  ['0C', 'lp.ogg', 100, 'Left Pedal'],
  ['0D', 'sd.ogg', 35, 'Snare (ghost)'],
  ['0E', 'hhc.ogg', 70, 'HH Close (soft)'],
  ['0F', 'sd.ogg', 70, 'Snare (soft)'],
  ['0G', 'ft.ogg', 70, 'Floor Tom (soft)'],
  ['0H', 'rd.ogg', 70, 'Ride (soft)'],
  ['0I', 'hho.ogg', 80, 'HH Open (soft)'],
];
const wavOf = (n) => {
  if (n.lane === 'SD') return n.v < 0.5 ? '0D' : n.v < 0.85 ? '0F' : '03';
  if (n.lane === 'HH') return n.v < 0.85 ? '0E' : '02';
  if (n.lane === 'FT') return n.v < 0.85 ? '0G' : '08';
  if (n.lane === 'RD') return n.v < 0.85 ? '0H' : '0A';
  if (n.lane === 'HHO') return n.v < 0.9 ? '0I' : '09';
  return { LC: '0B', LP: '0C', BD: '04', HT: '05', LT: '06', CY: '07' }[n.lane];
};
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function chartText(list, { level, label }) {
  const lines = [
    '; Neon Skyline - DTX Web Editor の README 用のデモ曲（自作）',
    '#TITLE: Neon Skyline',
    '#ARTIST: DTX Web Editor (demo)',
    '#GENRE: Rock',
    '#COMMENT: A demo song made for the README',
    `#BPM: ${BPM}`,
    `#DLEVEL: ${level}`,
    '#PREVIEW: preview.ogg',
    '#PREIMAGE: jacket.png',
    '',
    ...WAVS.flatMap(([id, f, vol, lab]) => [`#WAV${id}: ${f} ;${lab}`, ...(vol !== 100 ? [`#VOLUME${id}: ${vol}`] : [])]),
    '',
    '#00001: 01',
  ];
  const byLine = new Map();
  for (const n of list) {
    const key = `${String(n.m).padStart(3, '0')}${LANE_CH[n.lane]}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(n);
  }
  for (const key of [...byLine.keys()].sort()) {
    const ns = byLine.get(key);
    const g = ns.reduce((a, n) => gcd(a, n.p), 96);
    const slots = Array(96 / g).fill('00');
    for (const n of ns) slots[n.p / g] = wavOf(n);
    lines.push(`#${key}: ${slots.join('')}`);
  }
  void label;
  return lines.join('\r\n') + '\r\n';
}
// 間引き: EXTREME はゴースト・弱い HH の 16 分を外す、ADVANCED は HH を 4 分に・3 連を 8 分に、BASIC は骨組みだけ
const isFill = (m) => [4, 12, 16, 24, 28, 36].includes(m);
const ext = notes.filter((n) => !(n.lane === 'SD' && n.v < 0.5) && !(n.lane === 'LP' && sectionOf(n.m) !== 'count' && n.m < 37) && !(n.lane === 'BD' && n.p % 12 !== 0));
const adv = ext.filter((n) => {
  if (['HH', 'HHO', 'RD', 'FT'].includes(n.lane) && !isFill(n.m) && n.p % 24 !== 0) return false;
  if (isFill(n.m) && n.p % 12 !== 0) return false;
  if (n.lane === 'BD' && n.p % 24 !== 0 && n.p % 48 !== 36) return false;
  if (n.lane === 'LP') return false;
  return true;
});
const bsc = adv.filter((n) => {
  if (['HH', 'HHO', 'RD', 'FT'].includes(n.lane) && n.p % 24 !== 0) return false;
  if (['HT', 'LT'].includes(n.lane)) return false;
  if (n.lane === 'BD' && n.p % 48 !== 0) return false;
  if (n.lane === 'SD' && isFill(n.m) && n.p % 24 !== 0) return false;
  if (n.lane === 'LC') return false;
  return true;
});
const charts = [
  ['bsc.dtx', bsc, 240, 'BASIC'],
  ['adv.dtx', adv, 430, 'ADVANCED'],
  ['ext.dtx', ext, 610, 'EXTREME'],
  ['mstr.dtx', notes, 745, 'MASTER'],
];
for (const [file, list, level, label] of charts) writeFileSync(path.join(out, file), chartText(list, { level, label }));
writeFileSync(
  path.join(out, 'set.def'),
  ['#TITLE Neon Skyline', ...charts.flatMap(([file, , , label], i) => [`#L${i + 1}LABEL ${label}`, `#L${i + 1}FILE ${file}`]), ''].join('\r\n'),
);
// 作業ファイル（セクションとステム）。MASTER だけ
const stem = (file, name, kind) => ({ file, name, kind, gain: 1, pan: 0, mute: false, solo: false, offsetMs: 0 });
writeFileSync(
  path.join(out, 'mstr.dtxe.json'),
  JSON.stringify(
    {
      sections: SECTIONS.map((s) => ({ m: s.m, name: s.name })),
      stems: [stem('stems/drums.ogg', 'ドラム', 'drums'), stem('stems/bass.ogg', 'ベース', 'bass'), stem('stems/vocals.ogg', 'ボーカル', 'vocals'), stem('stems/other.ogg', 'その他', 'other')],
      fullMix: 'bgm.ogg',
    },
    null,
    2,
  ),
);

// キットの音（譜面が使う物だけ）
for (const [, f] of WAVS) if (f !== 'bgm.ogg') execFileSync('cp', [path.join(KIT, f), path.join(out, f)]);

// ---- ジャケット（Playwright で描く） ----
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launch = { args: ['--force-color-profile=srgb'] };
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY };
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const towers = Array.from({ length: 16 }, (_, i) => {
  const w = 22 + ((i * 37) % 30);
  const h = 70 + ((i * 53) % 150);
  const x = i * 33 - 10;
  const win = Array.from({ length: Math.floor(h / 18) }, (_, k) => `<rect x="${x + 5}" y="${400 - h + 8 + k * 18}" width="${w - 10}" height="3" fill="${k % 3 ? '#FF5C8A' : '#4FC3F7'}" opacity="${0.25 + ((i + k) % 4) * 0.12}"/>`).join('');
  return `<rect x="${x}" y="${400 - h}" width="${w}" height="${h}" fill="#140f2c"/>${win}`;
}).join('');
await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@700&display=block">
<style>html,body{margin:0;background:#000}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0B0630"/><stop offset="0.55" stop-color="#3A1460"/><stop offset="0.78" stop-color="#C2306E"/><stop offset="1" stop-color="#FF9E5E"/></linearGradient>
<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE27A"/><stop offset="1" stop-color="#FF4F8B"/></linearGradient>
<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A0B3A"/><stop offset="1" stop-color="#05020F"/></linearGradient>
<clipPath id="sunclip"><rect x="0" y="0" width="512" height="300"/><rect x="0" y="306" width="512" height="10"/><rect x="0" y="322" width="512" height="8"/><rect x="0" y="336" width="512" height="6"/><rect x="0" y="348" width="512" height="5"/><rect x="0" y="359" width="512" height="4"/></clipPath>
</defs>
<rect width="512" height="400" fill="url(#sky)"/>
${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 97) % 512}" cy="${(i * 53) % 220}" r="${i % 5 ? 1 : 1.6}" fill="#fff" opacity="${0.3 + (i % 4) * 0.15}"/>`).join('')}
<circle cx="256" cy="300" r="120" fill="url(#sun)" clip-path="url(#sunclip)"/>
${towers}
<rect y="400" width="512" height="112" fill="url(#floor)"/>
${Array.from({ length: 13 }, (_, i) => `<line x1="${256 + (i - 6) * 26}" y1="400" x2="${256 + (i - 6) * 140}" y2="512" stroke="#FF4FD8" stroke-opacity="0.55" stroke-width="1.5"/>`).join('')}
${[404, 410, 419, 432, 450, 474, 505].map((y) => `<line x1="0" y1="${y}" x2="512" y2="${y}" stroke="#FF4FD8" stroke-opacity="0.5" stroke-width="1.5"/>`).join('')}
<text x="256" y="96" text-anchor="middle" font-family="IBM Plex Sans JP, sans-serif" font-weight="700" font-size="58" letter-spacing="6" fill="#fff" style="filter:drop-shadow(0 0 10px #4CC2FF) drop-shadow(0 0 22px #FF4FD8)">NEON</text>
<text x="256" y="152" text-anchor="middle" font-family="IBM Plex Sans JP, sans-serif" font-weight="700" font-size="44" letter-spacing="10" fill="#9FE6FF" style="filter:drop-shadow(0 0 8px #4CC2FF)">SKYLINE</text>
</svg></body></html>`);
await page.evaluate(() => document.fonts.ready);
writeFileSync(path.join(out, 'jacket.png'), await page.locator('svg').screenshot());
await browser.close();

console.log(`wrote ${out}`);
console.log(`notes: MASTER ${notes.length} / EXT ${ext.length} / ADV ${adv.length} / BSC ${bsc.length}, length ${(LEN / SR).toFixed(1)}s`);
