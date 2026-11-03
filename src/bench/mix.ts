// テスト曲を混ぜる。エディタの再生（audio/engine）と同じ決まりで、音を足し合わせてステレオにする。
// - 音量は #VOLUME / 100、パンは #PAN / 100（Web Audio の StereoPanner と同じ等パワーの式）
// - 同じグループ（ハイハットの開閉・同じチャンネル）の次の音が鳴ったら、前の音を 12ms で消して 80ms 後に止める

export interface MixEvent {
  sec: number;
  /** 1ch（モノラル）か 2ch。サンプリング周波数は renderMix の sr と同じであること */
  sound: readonly Float32Array[];
  /** 0〜1 */
  gain: number;
  /** -1（左）〜1（右） */
  pan: number;
  choke: string | null;
}

const CHOKE_TAU = 0.012;
const CHOKE_STOP = 0.08;

/** events を混ぜて、長さ durationSec のステレオ（[左, 右]）を返す */
export function renderMix(events: readonly MixEvent[], sr: number, durationSec: number): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.ceil(durationSec * sr));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.sec - b.e.sec || a.i - b.i);
  // 次に同じグループの音が鳴る時刻（そこで前の音を消す）
  const cut = new Float64Array(sorted.length).fill(Infinity);
  const lastOf = new Map<string, number>();
  sorted.forEach(({ e }, k) => {
    if (!e.choke) return;
    const prev = lastOf.get(e.choke);
    if (prev !== undefined) cut[prev] = e.sec;
    lastOf.set(e.choke, k);
  });
  sorted.forEach(({ e }, k) => {
    const src = e.sound;
    if (src.length === 0 || e.gain <= 0) return;
    const len = src[0].length;
    const start = Math.round(e.sec * sr);
    const cutAt = Number.isFinite(cut[k]) ? Math.round(cut[k] * sr) - start : Infinity;
    const stopAt = Number.isFinite(cut[k]) ? cutAt + Math.round(CHOKE_STOP * sr) : Infinity;
    const end = Math.min(len, stopAt, n - start);
    const [gl, gr, cross] = panGains(src.length, Math.max(-1, Math.min(1, e.pan)));
    const g = Math.max(0, Math.min(1, e.gain));
    const a = src[0];
    const b = src.length > 1 ? src[1] : src[0];
    const decay = Math.exp(-1 / (CHOKE_TAU * sr));
    let fade = 1;
    for (let i = Math.max(0, -start); i < end; i++) {
      if (i >= cutAt) fade *= decay;
      const x = a[i] * g * fade;
      const y = b[i] * g * fade;
      const o = start + i;
      if (src.length === 1) {
        L[o] += x * gl;
        R[o] += x * gr;
      } else if (cross === 0) {
        L[o] += x * gl;
        R[o] += y * gr;
      } else if (cross < 0) {
        // 左へ振る：右の音の一部を左へ
        L[o] += x + y * gl;
        R[o] += y * gr;
      } else {
        L[o] += x * gl;
        R[o] += y + x * gr;
      }
    }
  });
  return [L, R];
}

/**
 * パンの係数 [左, 右, 向き]。
 * パン 0 はそのまま（モノラルは左右に同じ音、ステレオは素通し）。エディタの再生がパン 0 で StereoPanner を通さないのに合わせる。
 * 向き: 0 は係数をそのまま掛ける、-1/1 はステレオの音を左/右へ寄せる（StereoPanner のステレオ入力の式）。
 */
function panGains(channels: number, pan: number): [number, number, number] {
  if (pan === 0) return [1, 1, 0];
  if (channels === 1) {
    const x = ((pan + 1) / 2) * (Math.PI / 2);
    return [Math.cos(x), Math.sin(x), 0];
  }
  if (pan < 0) {
    const x = (pan + 1) * (Math.PI / 2);
    return [Math.cos(x), Math.sin(x), -1];
  }
  const x = pan * (Math.PI / 2);
  return [Math.cos(x), Math.sin(x), 1];
}

/** 左右を足して半分にする（解析に渡すモノラル） */
export function toMono(ch: readonly Float32Array[]): Float32Array {
  if (ch.length === 1) return ch[0];
  const out = new Float32Array(ch[0].length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (ch[0][i] + ch[1][i]);
  return out;
}

/** 16bit の WAV にする（聴いて確かめる用）。大きすぎるときは全体を下げる */
export function encodeWav(ch: readonly Float32Array[], sr: number): Uint8Array {
  const n = ch[0].length;
  const nc = ch.length;
  let peak = 0;
  for (const c of ch) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]));
  const k = peak > 0.98 ? 0.98 / peak : 1;
  const buf = new ArrayBuffer(44 + n * nc * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * nc * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nc, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * 2, true);
  v.setUint16(32, nc * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, ch[c][i] * k));
      v.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
