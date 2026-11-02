// 標準キットを作る：GeneralUser GS（SoundFont）のドラムセットから、レーンごとに1音ずつ切り出して OGG にする。
// 使い方: node scripts/make-kits.mjs <GeneralUser.sf2>
//   GeneralUser GS は npm の generaluser パッケージ（ISC、元のライセンスは public/kits/LICENSE-GeneralUser-GS.txt）から取れる。
// 出力: public/kits/<キット>/<レーン>.ogg
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import { createEncoder } from 'wasm-media-encoders';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sf2 = process.argv[2];
if (!sf2) {
  console.error('usage: node scripts/make-kits.mjs <GeneralUser.sf2>');
  process.exit(1);
}

const SR = 44100;
// レーン → GM のノート番号と長さ（秒）
const LANES = {
  lc: [49, 3.2],
  hhc: [42, 0.6],
  hho: [46, 1.6],
  lp: [44, 0.6],
  lbd: [36, 0.9],
  sd: [38, 1.0],
  ht: [48, 1.5],
  bd: [36, 0.9],
  lt: [45, 1.6],
  ft: [41, 1.8],
  cy: [57, 3.2],
  rd: [51, 2.6],
};
const KITS = [
  { id: 'std', program: 0, vel: 112 },
  { id: 'rock', program: 16, vel: 116 },
  { id: 'room', program: 8, vel: 112 },
  { id: 'jazz', program: 40, vel: 104 },
  { id: 'elec', program: 25, vel: 112 },
  // メタル: パワーキットに、右シンバルをチャイナ、ロータムを少し高めに
  { id: 'metal', program: 16, vel: 120, notes: { cy: 52, lbd: 35, bd: 35 } },
];

const buf = fs.readFileSync(sf2);
const bank = SoundBankLoader.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const wasm = fs.readFileSync(path.join(root, 'node_modules/wasm-media-encoders/wasm/ogg.wasm'));

function render(program, note, vel, seconds) {
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: false });
  synth.onMissingPreset = () => undefined;
  synth.soundBankManager.addSoundBank(bank, 'gu');
  synth.programChange(9, program);
  synth.noteOn(9, note, vel);
  const len = Math.ceil(SR * seconds);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  for (let i = 0; i < len; i += 128) synth.process(L, R, i, Math.min(128, len - i));
  // モノラルにする（ドラムのチップは真ん中で鳴らす。パンは #PAN で付けられる）
  const m = new Float32Array(len);
  for (let i = 0; i < len; i++) m[i] = (L[i] + R[i]) * 0.5;
  return m;
}

function tidy(x) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak < 1e-6) return null;
  // 頭の無音を削る（鳴り始めの直前まで）
  const th = peak * 0.002;
  let a = 0;
  while (a < x.length && Math.abs(x[a]) < th) a++;
  a = Math.max(0, a - 8);
  // お尻の無音を削る（-60 dB）
  const tail = peak * 0.001;
  let b = x.length - 1;
  while (b > a && Math.abs(x[b]) < tail) b--;
  b = Math.min(x.length, b + Math.round(SR * 0.02));
  const out = x.slice(a, b);
  // ピーク -1 dB にそろえ、最後を 30ms でフェード
  const k = Math.pow(10, -1 / 20) / peak;
  const f = Math.min(out.length, Math.round(SR * 0.03));
  for (let i = 0; i < out.length; i++) out[i] *= k;
  for (let i = 0; i < f; i++) out[out.length - 1 - i] *= i / f;
  return out;
}

async function ogg(samples) {
  const enc = await createEncoder('audio/ogg', wasm);
  enc.configure({ channels: 1, sampleRate: SR, vbrQuality: 6 });
  const parts = [];
  for (let i = 0; i < samples.length; i += 65536) parts.push(enc.encode([samples.subarray(i, Math.min(samples.length, i + 65536))]).slice());
  parts.push(enc.finalize().slice());
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

let total = 0;
for (const kit of KITS) {
  const dir = path.join(root, 'public/kits', kit.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [lane, [defNote, sec]] of Object.entries(LANES)) {
    const note = kit.notes?.[lane] ?? defNote;
    const s = tidy(render(kit.program, note, kit.vel, sec));
    if (!s) {
      console.warn(`無音: ${kit.id} ${lane} (${note})`);
      continue;
    }
    const bytes = await ogg(s);
    fs.writeFileSync(path.join(dir, `${lane}.ogg`), bytes);
    total += bytes.length;
    console.log(`${kit.id}/${lane}.ogg  note ${note}  ${(s.length / SR).toFixed(2)}s  ${(bytes.length / 1024).toFixed(1)} KB`);
  }
}
console.log(`合計 ${(total / 1024 / 1024).toFixed(2)} MB`);
