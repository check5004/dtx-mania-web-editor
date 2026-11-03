// ステム（原曲を楽器ごとに分けた音）の下ごしらえと書き出し。
import type { StemKind } from '../store/sidecar';
import { encodeWav } from './kit';

export const STEM_KINDS: { kind: StemKind; label: string; color: string }[] = [
  { kind: 'drums', label: 'ドラム', color: '#F0965A' },
  { kind: 'bass', label: 'ベース', color: '#A08CF0' },
  { kind: 'vocals', label: 'ボーカル', color: '#5BD69A' },
  { kind: 'guitar', label: 'ギター', color: '#4FA3E0' },
  { kind: 'piano', label: 'ピアノ', color: '#E57BC4' },
  { kind: 'other', label: 'その他', color: '#D6C85A' },
];

export function stemKindInfo(kind: StemKind) {
  return STEM_KINDS.find((k) => k.kind === kind) ?? STEM_KINDS[STEM_KINDS.length - 1];
}

const KIND_WORDS: [StemKind, RegExp][] = [
  ['drums', /(drum|drums|ドラム|perc|kit)/i],
  ['bass', /(bass|ベース)/i],
  ['vocals', /(vocal|vocals|voice|vox|ボーカル|歌)/i],
  ['guitar', /(guitar|gtr|ギター)/i],
  ['piano', /(piano|keys|keyboard|ピアノ|キーボード)/i],
  ['other', /(other|inst|instrumental|accompaniment|その他)/i],
];

/** ファイル名から種類を決める（drums.wav、song (Drums).wav、song_drums.flac、曲_ドラム_mixed.mp3 など） */
export function detectStemKind(fileName: string): StemKind {
  // Mac や Google ドライブの zip から来た名前は濁点が分かれている（ド＝ト＋゛）ので、合わせてから見る
  const base = fileName.normalize('NFC').replace(/\.[^.]+$/, '');
  // UVR などの「(Drums)」「[Drums]」「_drums」を先に見る
  const tagged = /[([_\-. ]([A-Za-z]+)[)\]]?\s*$/.exec(base)?.[1] ?? '';
  for (const [k, re] of KIND_WORDS) if (tagged && re.test(tagged)) return k;
  for (const [k, re] of KIND_WORDS) if (re.test(base)) return k;
  return 'other';
}

/** 表示名（種類のラベル。同じ種類が2本目以降なら番号を付ける） */
export function stemDisplayName(kind: StemKind, existing: string[]): string {
  const label = stemKindInfo(kind).label;
  if (!existing.includes(label)) return label;
  for (let i = 2; ; i++) if (!existing.includes(`${label}${i}`)) return `${label}${i}`;
}

/** stems/ の中のファイル名（安全な名前にして、重なれば番号を付ける） */
export function stemFilePath(fileName: string, existing: string[]): string {
  const clean = fileName.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'stem.wav';
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  const lower = new Set(existing.map((e) => e.toLowerCase()));
  let path = `stems/${clean}`;
  for (let i = 2; lower.has(path.toLowerCase()); i++) path = `stems/${stem}_${i}${ext}`;
  return path;
}

/** 頭のずれを入れた音（正なら頭に無音を足し、負なら頭を削る） */
export function shiftBuffer(ctx: BaseAudioContext, buf: AudioBuffer, offsetMs: number): AudioBuffer {
  const n = Math.round((offsetMs / 1000) * buf.sampleRate);
  if (n === 0) return buf;
  const len = Math.max(1, buf.length + n);
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    if (n > 0) dst.set(src, n);
    else dst.set(src.subarray(-n));
  }
  return out;
}

/** 波形の表示用（1秒あたり rate 個の最大値、0〜1） */
export function computePeaks(buf: AudioBuffer, rate = 100): Float32Array {
  const step = Math.max(1, Math.floor(buf.sampleRate / rate));
  const n = Math.ceil(buf.length / step);
  const out = new Float32Array(n);
  const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i));
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = i * step;
    const b = Math.min(buf.length, a + step);
    for (const ch of chans) {
      for (let j = a; j < b; j += 4) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
    }
    out[i] = Math.min(1, m);
  }
  return out;
}

export interface RenderTrack {
  buf: AudioBuffer;
  gain: number;
  pan: number;
}

export interface RenderOptions {
  /** ステムの時刻（秒、曲の頭からではなくステムの頭から）。null なら全部 */
  from: number;
  to: number;
  /** 前後のフェード（秒） */
  fade: number;
  /** ピークがこれを超えたら全体を下げる（dB）。null なら下げない */
  peakDb: number | null;
  sampleRate?: number;
}

/** ステムを1本にまとめる（ブラウザ内で OfflineAudioContext を使う） */
export async function renderMix(tracks: RenderTrack[], opts: RenderOptions): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? 44100;
  const dur = Math.max(0.05, opts.to - opts.from);
  const len = Math.ceil(dur * sr);
  const off = new OfflineAudioContext(2, len, sr);
  for (const t of tracks) {
    const src = off.createBufferSource();
    src.buffer = t.buf;
    const g = off.createGain();
    g.gain.value = Math.max(0, t.gain);
    let node: AudioNode = src.connect(g);
    if (t.pan !== 0) {
      const p = off.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, t.pan));
      node = node.connect(p);
    }
    node.connect(off.destination);
    if (opts.from >= 0) src.start(0, opts.from);
    else src.start(-opts.from, 0);
  }
  const out = await off.startRendering();
  applyFadeAndPeak(out, opts.fade, opts.peakDb);
  return out;
}

export function applyFadeAndPeak(buf: AudioBuffer, fade: number, peakDb: number | null) {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  if (peakDb !== null) {
    let peak = 0;
    for (const ch of chans) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    const target = Math.pow(10, peakDb / 20);
    if (peak > target) {
      const k = target / peak;
      for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= k;
    }
  }
  if (fade > 0) {
    const n = Math.min(Math.floor(fade * buf.sampleRate), Math.floor(buf.length / 2));
    for (const ch of chans) {
      for (let i = 0; i < n; i++) {
        const k = i / n;
        ch[i] *= k;
        ch[ch.length - 1 - i] *= k;
      }
    }
  }
}

let oggEncoderUrl: Promise<string> | null = null;

/** OGG Vorbis（品質6・約192 kbps）か WAV 16bit にする */
export async function encodeAudio(buf: AudioBuffer, format: 'ogg' | 'wav', onProgress?: (p: number) => void): Promise<Uint8Array> {
  if (format === 'wav') return encodeWav(buf);
  oggEncoderUrl ??= import('wasm-media-encoders/wasm/ogg.wasm?url').then((m) => m.default as string);
  const { createEncoder } = await import('wasm-media-encoders');
  const enc = await createEncoder('audio/ogg', await oggEncoderUrl);
  const channels = Math.min(2, buf.numberOfChannels) as 1 | 2;
  enc.configure({ channels, sampleRate: buf.sampleRate, vbrQuality: 6 });
  const parts: Uint8Array[] = [];
  const data = Array.from({ length: channels }, (_, i) => buf.getChannelData(i));
  const block = 1 << 16;
  for (let i = 0; i < buf.length; i += block) {
    const chunk = data.map((d) => d.subarray(i, Math.min(buf.length, i + block)));
    parts.push(enc.encode(chunk).slice());
    if (onProgress && (i / block) % 8 === 0) {
      onProgress(i / buf.length);
      // 画面が固まらないように少し休む
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  parts.push(enc.finalize().slice());
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
