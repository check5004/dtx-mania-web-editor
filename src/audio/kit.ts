// 内蔵の合成ドラムキット。曲フォルダに音が無いレーンに置いたチップは、この音を WAV にして曲フォルダへ書き出す。
import { CH } from '../dtx/model';

export interface KitSound {
  ch: number;
  file: string;
  label: string;
}

export const KIT_SOUNDS: readonly KitSound[] = [
  { ch: CH.LC, file: 'dtxweb_kit_lc.wav', label: '左シンバル' },
  { ch: CH.HHC, file: 'dtxweb_kit_hhc.wav', label: 'HHクローズ' },
  { ch: CH.HHO, file: 'dtxweb_kit_hho.wav', label: 'HHオープン' },
  { ch: CH.LP, file: 'dtxweb_kit_lp.wav', label: '左ペダル' },
  { ch: CH.LBD, file: 'dtxweb_kit_lbd.wav', label: '左バスドラム' },
  { ch: CH.SD, file: 'dtxweb_kit_sd.wav', label: 'スネア' },
  { ch: CH.HT, file: 'dtxweb_kit_ht.wav', label: 'ハイタム' },
  { ch: CH.BD, file: 'dtxweb_kit_bd.wav', label: 'バスドラム' },
  { ch: CH.LT, file: 'dtxweb_kit_lt.wav', label: 'ロータム' },
  { ch: CH.FT, file: 'dtxweb_kit_ft.wav', label: 'フロアタム' },
  { ch: CH.CY, file: 'dtxweb_kit_cy.wav', label: '右シンバル' },
  { ch: CH.RD, file: 'dtxweb_kit_rd.wav', label: 'ライド' },
];

export const kitByChannel = new Map(KIT_SOUNDS.map((k) => [k.ch, k]));
export const kitByFile = new Map(KIT_SOUNDS.map((k) => [k.file.toLowerCase(), k]));

const SR = 44100;

type Ctx = OfflineAudioContext;

function noise(ctx: Ctx, seconds: number): AudioBufferSourceNode {
  const len = Math.ceil(seconds * ctx.sampleRate);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = b.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x3fffffff) - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = b;
  return src;
}

function env(ctx: Ctx, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(peak, attack);
  g.gain.exponentialRampToValueAtTime(0.0008, attack + decay);
  return g;
}

function filter(ctx: Ctx, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function tone(ctx: Ctx, out: AudioNode, type: OscillatorType, f0: number, f1: number, sweep: number, peak: number, decay: number) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, 0);
  o.frequency.exponentialRampToValueAtTime(f1, sweep);
  const g = env(ctx, peak, 0.002, decay);
  o.connect(g).connect(out);
  o.start(0);
}

function hiss(ctx: Ctx, out: AudioNode, len: number, filters: BiquadFilterNode[], peak: number, decay: number) {
  const n = noise(ctx, len);
  let node: AudioNode = n;
  for (const f of filters) node = node.connect(f);
  const g = env(ctx, peak, 0.001, decay);
  node.connect(g).connect(out);
  n.start(0);
}

/** 金属っぽい音（ハイハット・シンバル用）: 非整数倍の矩形波を重ねる */
function metal(ctx: Ctx, out: AudioNode, base: number, peak: number, decay: number, hp: number) {
  const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
  const mix = ctx.createGain();
  mix.gain.value = 1 / ratios.length;
  for (const r of ratios) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = base * r;
    o.connect(mix);
    o.start(0);
  }
  const g = env(ctx, peak, 0.001, decay);
  mix.connect(filter(ctx, 'bandpass', 10000, 0.6)).connect(filter(ctx, 'highpass', hp)).connect(g).connect(out);
}

const RECIPES: Record<number, { len: number; build: (ctx: Ctx, out: AudioNode) => void }> = {
  [CH.BD]: {
    len: 0.5,
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 160, 42, 0.09, 1.0, 0.42);
      hiss(ctx, out, 0.05, [filter(ctx, 'lowpass', 3000)], 0.25, 0.012);
    },
  },
  [CH.LBD]: {
    len: 0.45,
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 150, 45, 0.08, 0.95, 0.38);
      hiss(ctx, out, 0.05, [filter(ctx, 'lowpass', 2500)], 0.2, 0.012);
    },
  },
  [CH.SD]: {
    len: 0.4,
    build: (ctx, out) => {
      tone(ctx, out, 'triangle', 240, 175, 0.05, 0.55, 0.12);
      hiss(ctx, out, 0.4, [filter(ctx, 'highpass', 1200), filter(ctx, 'peaking', 3500, 1)], 0.75, 0.22);
    },
  },
  [CH.HHC]: {
    len: 0.15,
    build: (ctx, out) => {
      metal(ctx, out, 40, 0.7, 0.06, 7000);
      hiss(ctx, out, 0.12, [filter(ctx, 'highpass', 8000)], 0.25, 0.05);
    },
  },
  [CH.HHO]: {
    len: 0.7,
    build: (ctx, out) => {
      metal(ctx, out, 40, 0.6, 0.55, 6500);
      hiss(ctx, out, 0.7, [filter(ctx, 'highpass', 7000)], 0.25, 0.5);
    },
  },
  [CH.LP]: {
    len: 0.12,
    build: (ctx, out) => {
      metal(ctx, out, 38, 0.5, 0.04, 5000);
      hiss(ctx, out, 0.1, [filter(ctx, 'bandpass', 6000, 1.2)], 0.2, 0.035);
    },
  },
  [CH.HT]: {
    len: 0.55,
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 260, 190, 0.2, 0.9, 0.42);
      hiss(ctx, out, 0.08, [filter(ctx, 'bandpass', 2500, 0.8)], 0.15, 0.03);
    },
  },
  [CH.LT]: {
    len: 0.6,
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 190, 135, 0.22, 0.9, 0.48);
      hiss(ctx, out, 0.08, [filter(ctx, 'bandpass', 2000, 0.8)], 0.15, 0.03);
    },
  },
  [CH.FT]: {
    len: 0.7,
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 135, 92, 0.25, 0.95, 0.58);
      hiss(ctx, out, 0.08, [filter(ctx, 'bandpass', 1600, 0.8)], 0.15, 0.03);
    },
  },
  [CH.CY]: {
    len: 1.8,
    build: (ctx, out) => {
      metal(ctx, out, 52, 0.45, 1.6, 4000);
      hiss(ctx, out, 1.8, [filter(ctx, 'highpass', 4500)], 0.45, 1.5);
    },
  },
  [CH.LC]: {
    len: 1.6,
    build: (ctx, out) => {
      metal(ctx, out, 61, 0.45, 1.3, 3500);
      hiss(ctx, out, 1.6, [filter(ctx, 'highpass', 3800), filter(ctx, 'peaking', 6000, 1.5)], 0.45, 1.25);
    },
  },
  [CH.RD]: {
    len: 1.3,
    build: (ctx, out) => {
      metal(ctx, out, 47, 0.3, 1.1, 5000);
      tone(ctx, out, 'sine', 3800, 3700, 0.5, 0.18, 0.9);
      hiss(ctx, out, 1.2, [filter(ctx, 'bandpass', 8000, 0.8)], 0.15, 0.8);
    },
  },
};

async function renderOne(ch: number): Promise<AudioBuffer> {
  const r = RECIPES[ch];
  const ctx = new OfflineAudioContext(1, Math.ceil(r.len * SR), SR);
  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(ctx.destination);
  r.build(ctx, out);
  return ctx.startRendering();
}

let kitPromise: Promise<Map<string, AudioBuffer>> | null = null;

/** 内蔵キットの音（ファイル名の小文字 → AudioBuffer） */
export function loadKit(): Promise<Map<string, AudioBuffer>> {
  if (!kitPromise) {
    kitPromise = Promise.all(KIT_SOUNDS.map(async (k) => [k.file.toLowerCase(), await renderOne(k.ch)] as const)).then(
      (list) => new Map(list),
    );
  }
  return kitPromise;
}

/** AudioBuffer を 16bit PCM の WAV にする */
export function encodeWav(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const bytes = new Uint8Array(44 + len * ch * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + len * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return bytes;
}
