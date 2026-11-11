// SFZ の音源（Karoryfer などの CC0 のドラム）から、1つの打撃を1つの音に混ぜて書き出すための、小さな SFZ の読み手。
// 打撃1回ぶん（鍵盤・強さ・CC を決めたとき）に鳴るリージョンを選び、マイクごとの音量（作者が決めた CC の初期値）で足し合わせる。
// 使う所だけ: #define・#include・ヘッダーの引き継ぎ・key/vel/CC の条件・音量（volume・amplitude・CC・カーブ・ベロシティカーブ・クロスフェード）
// ・パン（モノラルに混ぜるときの左右の重み）・音程（transpose・tune・CC）・開始位置・遅れ・エンベロープ・フィルター・EQ。
// エフェクト（<effect>）・ラウンドロビンの2つ目以降・リリースで鳴る音は使わない（1回目の打撃の音だけ）。
import fs from 'fs';
import path from 'path';
import { biquad, resample } from './dsp.mjs';
import { decodeFile, SR } from './audio-io.mjs';

const NOTE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** 音名（c4・f#3 など）か数字を MIDI の番号に */
export function noteNumber(v) {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = /^([a-g])([#b]?)(-?\d+)$/.exec(s);
  if (!m) return undefined;
  return NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

/** 標準のカーブ（0〜6）。7 以降は <curve> で決める */
function builtinCurve(i, x) {
  switch (i) {
    case 1:
      return x * 2 - 1;
    case 2:
      return 1 - x;
    case 3:
      return 1 - x * 2;
    case 4:
      return x * x;
    case 5:
      return Math.sqrt(x);
    case 6:
      return Math.sqrt(1 - x);
    default:
      return x;
  }
}

/** <curve> の vNNN を 0〜127 の表にする（決めていない所は前後を直線でつなぐ） */
function curveTable(points) {
  const keys = [...points.keys()].sort((a, b) => a - b);
  if (!keys.length) return null;
  if (!points.has(0)) {
    points.set(0, 0);
    keys.unshift(0);
  }
  if (!points.has(127)) {
    points.set(127, 1);
    keys.push(127);
  }
  const t = new Float64Array(128);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    for (let x = a; x <= b; x++) t[x] = points.get(a) + ((points.get(b) - points.get(a)) * (x - a)) / Math.max(1, b - a);
  }
  return t;
}

/**
 * SFZ を読む。root は .sfz のファイル。#include のパスは最初のファイルの場所から、sample は default_path を足して最初のファイルの場所から
 * @returns {{ file: string, dir: string, regions: Record<string,string>[], curves: Map<number, Float64Array>, setCc: Map<number, number>, defines: Map<string,string> }}
 */
export function loadSfz(root, extraDefines = {}) {
  const dir = path.dirname(root);
  const defines = new Map(Object.entries(extraDefines));
  const setCc = new Map();
  const curves = new Map();
  const regions = [];
  let header = null;
  let control = {};
  let global = {};
  let master = {};
  let group = {};
  let cur = {};
  let curvePoints = null;
  let curveIndex = null;

  const flush = () => {
    if (header === 'region') regions.push({ ...control, ...global, ...master, ...group, ...cur, __defaultPath: control.default_path ?? '' });
    else if (header === 'global') global = cur;
    else if (header === 'master') master = cur;
    else if (header === 'group') group = cur;
    else if (header === 'control') control = { ...control, ...cur };
    else if (header === 'curve' && curveIndex !== null && curvePoints) {
      const t = curveTable(curvePoints);
      if (t) curves.set(curveIndex, t);
    }
    cur = {};
  };
  const open = (h) => {
    flush();
    header = h;
    if (h === 'global') {
      master = {};
      group = {};
    } else if (h === 'master') group = {};
    else if (h === 'control') control = {};
    else if (h === 'curve') {
      curvePoints = new Map();
      curveIndex = null;
    }
  };
  const setOpcode = (k, v) => {
    if (header === 'curve') {
      if (k === 'curve_index') curveIndex = Number(v);
      else if (/^v\d+$/.test(k)) curvePoints.set(Number(k.slice(1)), Number(v));
      return;
    }
    if (header === 'control' || header === null) {
      const m = /^set_cc(\d+)$/i.exec(k);
      if (m) {
        setCc.set(Number(m[1]), Number(v));
        return;
      }
      if (/^set_hdcc(\d+)$/i.test(k)) {
        setCc.set(Number(/\d+/.exec(k)[0]), Number(v) * 127);
        return;
      }
    }
    const key = k.toLowerCase();
    // key は lokey・hikey・pitch_keycenter をまとめて決める（あとに書いた lokey などが勝つ）
    if (key === 'key') {
      cur.lokey = v;
      cur.hikey = v;
      cur.pitch_keycenter = v;
      return;
    }
    cur[key] = v;
  };
  const expand = (line) => {
    if (!line.includes('$')) return line;
    // 長い名前から置きかえる（$snare と $snare_top のように頭が同じ名前があるので）
    const names = [...defines.keys()].sort((a, b) => b.length - a.length);
    let out = line;
    for (const n of names) if (out.includes(n)) out = out.split(n).join(defines.get(n));
    return out;
  };
  const processFile = (file, depth = 0) => {
    if (depth > 20) throw new Error(`#include が深すぎます: ${file}`);
    let text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    text = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.replace(/\/\/.*$/, '');
      if (!line.trim()) continue;
      const def = /^\s*#define\s+(\$\w+)\s+(.*?)\s*$/.exec(line);
      if (def) {
        defines.set(def[1], expand(def[2]));
        continue;
      }
      const inc = /^\s*#include\s+"([^"]+)"/.exec(line);
      if (inc) {
        processFile(path.join(dir, expand(inc[1])), depth + 1);
        continue;
      }
      line = expand(line);
      // ヘッダーと opcode に分ける。値は次の opcode か ヘッダーの前まで（sample のパスに空白があってもよい）
      const re = /<(\w+)>|([A-Za-z_][\w]*)=/g;
      const toks = [];
      let m;
      while ((m = re.exec(line))) toks.push({ i: m.index, end: re.lastIndex, header: m[1], key: m[2] });
      for (let t = 0; t < toks.length; t++) {
        const tk = toks[t];
        if (tk.header) {
          open(tk.header.toLowerCase());
          continue;
        }
        const next = t + 1 < toks.length ? toks[t + 1].i : line.length;
        setOpcode(tk.key, line.slice(tk.end, next).trim());
      }
    }
  };
  processFile(root);
  flush();
  return { file: root, dir, regions, curves, setCc, defines };
}

const num = (r, k, d) => {
  const v = r[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** カーブの値（x は 0〜1） */
function curveAt(prog, index, x) {
  const t = index !== undefined ? prog.curves.get(index) : undefined;
  if (t) {
    const p = Math.max(0, Math.min(127, x * 127));
    const a = Math.floor(p);
    const b = Math.min(127, a + 1);
    return t[a] + (t[b] - t[a]) * (p - a);
  }
  return builtinCurve(index ?? 0, x);
}

/** opcode の CC での動き（xxx_onccN・xxx_ccN と xxx_curveccN）をすべて足した値 */
function ccMod(prog, r, base, cc) {
  let sum = 0;
  for (const [k, v] of Object.entries(r)) {
    const m = new RegExp(`^${base}_(?:on)?cc(\\d+)$`).exec(k);
    if (!m) continue;
    const n = Number(m[1]);
    const x = (cc.get(n) ?? 0) / 127;
    const ci = r[`${base}_curvecc${n}`];
    sum += Number(v) * curveAt(prog, ci !== undefined ? Number(ci) : undefined, x);
  }
  return sum;
}

/** amplitude_ccN は掛け算（CC ごとに 値% × カーブ） */
function ampCcFactor(prog, r, cc) {
  let f = 1;
  for (const [k, v] of Object.entries(r)) {
    const m = /^amplitude_(?:on)?cc(\d+)$/.exec(k);
    if (!m) continue;
    const n = Number(m[1]);
    const x = (cc.get(n) ?? 0) / 127;
    const ci = r[`amplitude_curvecc${n}`];
    f *= (Number(v) / 100) * curveAt(prog, ci !== undefined ? Number(ci) : undefined, x);
  }
  return f;
}

/** ベロシティから音量（amp_velcurve_N が無ければ amp_veltrack） */
function velGain(r, vel) {
  const pts = new Map();
  for (const [k, v] of Object.entries(r)) {
    const m = /^amp_velcurve_(\d+)$/.exec(k);
    if (m) pts.set(Number(m[1]), Number(v));
  }
  if (pts.size) {
    if (!pts.has(0)) pts.set(0, 0);
    if (!pts.has(127)) pts.set(127, 1);
    const ks = [...pts.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ks.length - 1; i++) {
      if (vel >= ks[i] && vel <= ks[i + 1]) {
        const a = pts.get(ks[i]);
        const b = pts.get(ks[i + 1]);
        return a + ((b - a) * (vel - ks[i])) / Math.max(1, ks[i + 1] - ks[i]);
      }
    }
    return 1;
  }
  const track = num(r, 'amp_veltrack', 100) / 100;
  const g = (vel / 127) ** 2;
  return 1 - track + track * g;
}

/** クロスフェード（xfin_loXX/xfin_hiXX・xfout_loXX/xfout_hiXX）。power は等パワー */
function xfade(r, kind, value) {
  let g = 1;
  const inLo = r[`xfin_lo${kind}`];
  const inHi = r[`xfin_hi${kind}`];
  if (inLo !== undefined || inHi !== undefined) {
    const lo = Number(inLo ?? 0);
    const hi = Number(inHi ?? 0);
    if (value <= lo) g *= hi > lo ? 0 : 1;
    else if (value < hi) g *= Math.sqrt((value - lo) / (hi - lo));
  }
  const outLo = r[`xfout_lo${kind}`];
  const outHi = r[`xfout_hi${kind}`];
  if (outLo !== undefined || outHi !== undefined) {
    const lo = Number(outLo ?? 127);
    const hi = Number(outHi ?? 127);
    if (value >= hi) g *= hi > lo ? 0 : 1;
    else if (value > lo) g *= Math.sqrt((hi - value) / (hi - lo));
  }
  return g;
}

/**
 * 打撃1回で鳴るリージョン（とその音量など）を選ぶ
 * @param {object} opt key（MIDI の番号）・vel・cc（CC の番号→値。SFZ の set_cc より優先）・seq（ラウンドロビンの何番目）・rand（0〜1）
 */
export function pickRegions(prog, { key, vel = 112, cc = {}, seq = 1, rand = 0.01 }) {
  const ccs = new Map(prog.setCc);
  for (const [k, v] of Object.entries(cc)) ccs.set(Number(k), v);
  const out = [];
  for (const r of prog.regions) {
    const sample = r.sample;
    if (!sample) continue;
    const trig = (r.trigger ?? 'attack').toLowerCase();
    if (trig !== 'attack' && trig !== 'first') continue;
    // CC だけで鳴るリージョン（on_loccN）は使わない
    if (Object.keys(r).some((k) => /^on_(lo|hi)cc\d+$/.test(k) || /^start_(lo|hi)cc\d+$/.test(k))) continue;
    const k1 = noteNumber(r.lokey ?? 0);
    const k2 = noteNumber(r.hikey ?? 127);
    if (key < k1 || key > k2) continue;
    if (vel < num(r, 'lovel', 1) || vel > num(r, 'hivel', 127)) continue;
    if (num(r, 'seq_position', 1) !== seq) continue;
    if (rand < num(r, 'lorand', 0) || rand >= num(r, 'hirand', 1.0000001)) continue;
    let ok = true;
    for (const [k, v] of Object.entries(r)) {
      const m = /^(lo|hi)cc(\d+)$/.exec(k);
      if (!m) continue;
      const val = ccs.get(Number(m[2])) ?? 0;
      if (m[1] === 'lo' ? val < Number(v) : val > Number(v)) ok = false;
    }
    if (!ok) continue;
    // 鳴らない音（*silence）
    if (sample.startsWith('*')) continue;
    let gain = 10 ** ((num(r, 'volume', 0) + ccMod(prog, r, 'volume', ccs) + ccMod(prog, r, 'gain', ccs)) / 20);
    gain *= num(r, 'amplitude', 100) / 100;
    gain *= ampCcFactor(prog, r, ccs);
    gain *= velGain(r, vel);
    gain *= xfade(r, 'vel', vel);
    gain *= xfade(r, 'key', key);
    for (const k of Object.keys(r)) {
      const m = /^xf(?:in|out)_locc(\d+)$/.exec(k);
      if (m) gain *= xfade(r, `cc${m[1]}`, ccs.get(Number(m[1])) ?? 0);
    }
    if (!(gain > 0)) continue;
    const keycenter = noteNumber(r.pitch_keycenter) ?? 60;
    const cents = (key - keycenter) * num(r, 'pitch_keytrack', 100) + num(r, 'transpose', 0) * 100 + num(r, 'tune', 0) + ccMod(prog, r, 'tune', ccs) + ccMod(prog, r, 'pitch', ccs);
    const pan = Math.max(-100, Math.min(100, num(r, 'pan', 0) + ccMod(prog, r, 'pan', ccs)));
    const offset = Math.max(0, num(r, 'offset', 0) + ccMod(prog, r, 'offset', ccs));
    const delay = Math.max(0, num(r, 'delay', 0) + ccMod(prog, r, 'delay', ccs));
    const env = {
      attack: Math.max(0, num(r, 'ampeg_attack', 0) + ccMod(prog, r, 'ampeg_attack', ccs)),
      hold: Math.max(0, num(r, 'ampeg_hold', 0) + ccMod(prog, r, 'ampeg_hold', ccs)),
      decay: Math.max(0, num(r, 'ampeg_decay', 0) + ccMod(prog, r, 'ampeg_decay', ccs)),
      sustain: Math.max(0, Math.min(100, num(r, 'ampeg_sustain', 100) + ccMod(prog, r, 'ampeg_sustain', ccs))) / 100,
    };
    const filters = [];
    for (const [t, c, q] of [
      ['fil_type', 'cutoff', 'resonance'],
      ['fil2_type', 'cutoff2', 'resonance2'],
    ]) {
      if (r[c] === undefined) continue;
      const hz = Number(r[c]) * 2 ** (ccMod(prog, r, c, ccs) / 1200);
      filters.push({ type: (r[t] ?? 'lpf_2p').toLowerCase(), hz, q: num(r, q, 0) });
    }
    for (const n of [1, 2, 3]) {
      const g = num(r, `eq${n}_gain`, 0) + ccMod(prog, r, `eq${n}_gain`, ccs);
      if (Math.abs(g) < 0.01) continue;
      filters.push({ type: 'peq', hz: num(r, `eq${n}_freq`, [50, 500, 5000][n - 1]), bw: num(r, `eq${n}_bw`, 1), gain: g });
    }
    const file = path.normalize(path.join(prog.dir, (r.__defaultPath ?? '').replace(/\\/g, '/'), sample.replace(/\\/g, '/')));
    out.push({ file, gain, cents, pan, offset, delay, env, filters, region: r });
  }
  return out;
}

/** エンベロープ（アタックは直線、ディケイはサステインへ指数で近づく） */
function applyEnv(x, env, sr) {
  if (env.attack <= 0 && env.sustain >= 0.999) return;
  const a = Math.round(env.attack * sr);
  const h = Math.round(env.hold * sr);
  const d = Math.max(1, env.decay * sr);
  for (let i = 0; i < x.length; i++) {
    let g;
    if (i < a) g = i / a;
    else if (i < a + h) g = 1;
    else {
      const t = (i - a - h) / d;
      // ディケイの時間でおよそ -60 dB ぶん近づく
      g = env.sustain + (1 - env.sustain) * Math.exp(-6.9 * t);
    }
    x[i] *= g;
  }
}

/** 選んだリージョンを足して、モノラルの1音にする（左右は等パワーのパンで分け、最後に (L+R)/2） */
export function renderHit(picks, { seconds = 3 } = {}) {
  const len = Math.ceil(SR * seconds);
  const L = new Float64Array(len);
  const R = new Float64Array(len);
  for (const p of picks) {
    const s = decodeFile(p.file);
    const ratio = (s.sampleRate / SR) * 2 ** (p.cents / 1200);
    const chans = s.channels.map((c) => {
      let y = resample(c.subarray(Math.min(c.length, Math.round(p.offset))), ratio, len);
      for (const f of p.filters) y = biquad(y, f, SR);
      applyEnv(y, p.env, SR);
      return y;
    });
    const d = Math.round(p.delay * SR);
    // モノラルの音は等パワーのパン、ステレオの音はバランス
    const th = ((p.pan + 100) / 200) * (Math.PI / 2);
    let gl;
    let gr;
    if (chans.length === 1) {
      gl = Math.cos(th);
      gr = Math.sin(th);
    } else {
      gl = p.pan > 0 ? 1 - p.pan / 100 : 1;
      gr = p.pan < 0 ? 1 + p.pan / 100 : 1;
    }
    const cl = chans[0];
    const cr = chans[chans.length - 1];
    for (let i = 0; i + d < len && i < cl.length; i++) {
      L[i + d] += cl[i] * p.gain * gl;
      R[i + d] += cr[i] * p.gain * gr;
    }
  }
  const m = new Float32Array(len);
  for (let i = 0; i < len; i++) m[i] = (L[i] + R[i]) * 0.5;
  return m;
}

/** 調べる用: 選んだリージョンの一覧 */
export function describe(picks) {
  return picks.map((p) => `${path.basename(path.dirname(p.file))}/${path.basename(p.file)} gain=${p.gain.toFixed(3)} cents=${p.cents.toFixed(0)} pan=${p.pan} delay=${p.delay.toFixed(4)} off=${p.offset} env=${JSON.stringify(p.env)} fil=${JSON.stringify(p.filters)}`).join('\n');
}
