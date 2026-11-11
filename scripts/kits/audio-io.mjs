// キットを作るときの音の読み書き。読むのは ffmpeg（FLAC・WAV・OGG など何でも）、書くのは wasm-media-encoders の OGG（アプリと同じ）。
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEncoder } from 'wasm-media-encoders';

export const SR = 44100;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const cache = new Map();

/** 音声ファイルを読む（元のサンプリング周波数・チャンネルのまま） */
export function decodeFile(file) {
  let v = cache.get(file);
  if (v) return v;
  if (!fs.existsSync(file)) throw new Error(`音のファイルがありません: ${file}`);
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'wav', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 1 << 30 });
  if (res.status !== 0) throw new Error(`ffmpeg で読めません: ${file}\n${res.stderr}`);
  v = parseWav(res.stdout);
  cache.set(file, v);
  return v;
}

/** 読んだ音を忘れる（キットを1つ作り終えるごとに。録音の音源は大きいので） */
export function clearDecodeCache() {
  cache.clear();
}

/** float32 の WAV（ffmpeg が書いたもの）を読む */
function parseWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 12;
  let ch = 1;
  let sr = SR;
  let bits = 32;
  let fmt = 3;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    let size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      fmt = dv.getUint16(p + 8, true);
      ch = dv.getUint16(p + 10, true);
      sr = dv.getUint32(p + 12, true);
      bits = dv.getUint16(p + 22, true);
      if (fmt === 0xfffe) fmt = dv.getUint16(p + 32, true);
    } else if (id === 'data') {
      // ffmpeg がパイプに書くと data の大きさが 0xFFFFFFFF のことがある
      if (size === 0xffffffff || p + 8 + size > buf.length) size = buf.length - p - 8;
      if (fmt !== 3 || bits !== 32) throw new Error('float32 の WAV ではありません');
      const n = Math.floor(size / 4 / ch);
      const channels = Array.from({ length: ch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) channels[c][i] = dv.getFloat32(p + 8 + (i * ch + c) * 4, true);
      return { sampleRate: sr, channels };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('WAV の data がありません');
}

let wasm = null;

/** モノラルの音を OGG（Vorbis）にする。品質はアプリの標準キットと同じ */
export async function encodeOgg(samples, quality = 6) {
  wasm ??= fs.readFileSync(path.join(root, 'node_modules/wasm-media-encoders/wasm/ogg.wasm'));
  const enc = await createEncoder('audio/ogg', wasm);
  enc.configure({ channels: 1, sampleRate: SR, vbrQuality: quality });
  const parts = [];
  const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  for (let i = 0; i < f32.length; i += 65536) parts.push(Buffer.from(enc.encode([f32.subarray(i, Math.min(f32.length, i + 65536))]).slice()));
  parts.push(Buffer.from(enc.finalize().slice()));
  return Buffer.concat(parts);
}

/** 確かめる用: モノラルの 16bit WAV */
export function encodeWav16(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}
