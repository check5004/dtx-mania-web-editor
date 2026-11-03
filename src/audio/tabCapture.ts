// このタブの音を聞き取る（YouTube の埋め込み動画の音を、原曲と比べるため）。
//
// 埋め込みの YouTube は別のサイトなので、音を直接は読めない。ブラウザの「このタブを共有」
// （getDisplayMedia、Chrome・Edge）で、タブから出る音をまるごと受け取る。共有は合わせているあいだだけ。
// 受け取った音は AudioWorklet で 1ch にして、エンジンと同じ AudioContext の時刻つきでためる。
//
// 遅れの補正: タブの音が手元に届くまでには遅れがある。エンジンから小さなクリックを鳴らして、
// 鳴らした時刻と届いた時刻の差（Δ）を測る。届いた音は「Δ だけ前に聞こえていた音」として扱う。

/** このブラウザでタブの音を聞き取れそうか（Chrome・Edge などの Chromium） */
export function canCaptureTab(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  if (brands) return brands.some((b) => /Chrom|Edge|Opera|Brave/i.test(b.brand));
  return /Chrome\/|Edg\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
}

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly code: 'denied' | 'noaudio' | 'unsupported' | 'failed',
  ) {
    super(message);
  }
}

/**
 * 「このタブを共有」をたのむ（ボタンを押した直後に呼ぶこと。ブラウザが確認を出す）。
 * 映像はすぐ止め、音だけ残す。
 */
export async function requestTabAudio(): Promise<MediaStream> {
  if (!canCaptureTab()) throw new CaptureError('このブラウザではタブの音を聞き取れません（Chrome・Edge で使えます）', 'unsupported');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
      // Chrome: 今のタブを先に出す・タブの音を既定でオン
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      systemAudio: 'exclude',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') throw new CaptureError('タブの共有が許可されませんでした', 'denied');
    throw new CaptureError(`タブの音を受け取れませんでした（${(e as Error).message}）`, 'failed');
  }
  for (const t of stream.getVideoTracks()) t.stop();
  if (stream.getAudioTracks().length === 0) {
    stopStream(stream);
    throw new CaptureError('タブの音が届きませんでした。共有の画面で「タブの音声も共有する」をオンにしてください', 'noaudio');
  }
  return stream;
}

export function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
}

const WORKLET = `
class DtxeRec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.start = 0;
    this.on = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; };
  }
  flush() {
    if (this.n > 0) this.port.postMessage({ frame: this.start, data: this.buf.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) { this.flush(); return false; }
    const inp = inputs[0];
    if (!inp || inp.length === 0) { this.flush(); return true; }
    const len = inp[0].length;
    if (this.n > 0 && this.start + this.n !== currentFrame) this.flush();
    if (this.n === 0) this.start = currentFrame;
    const k = 1 / inp.length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < inp.length; c++) s += inp[c][i];
      this.buf[this.n + i] = s * k;
    }
    this.n += len;
    if (this.n + 128 > this.buf.length) this.flush();
    return true;
  }
}
registerProcessor('dtxe-rec', DtxeRec);
`;

const loadedCtx = new WeakSet<BaseAudioContext>();

/** 受け取った音を、AudioContext の時刻（フレーム）つきでためる */
export class PcmRecorder {
  private src: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private chunks: { frame: number; data: Float32Array }[] = [];
  /** ためるのはこの秒数まで（古いものから捨てる） */
  private keepSec = 40;
  constructor(
    readonly ctx: AudioContext,
    private stream: MediaStream,
  ) {}

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  async start() {
    const ctx = this.ctx;
    if (!loadedCtx.has(ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      loadedCtx.add(ctx);
    }
    if (ctx.state === 'suspended') await ctx.resume();
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'dtxe-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) => {
      this.chunks.push(e.data);
      const lim = e.data.frame - this.keepSec * ctx.sampleRate;
      while (this.chunks.length > 2 && this.chunks[0].frame + this.chunks[0].data.length < lim) this.chunks.shift();
    };
    // 出力は鳴らさない（ワークレットを動かすためにだけつなぐ）
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  /** 届いた音のうち、AudioContext の時刻 [t0, t1) の所（届いていない所は 0） */
  take(t0: number, t1: number): Float32Array {
    const sr = this.ctx.sampleRate;
    const f0 = Math.round(t0 * sr);
    const n = Math.max(0, Math.round(t1 * sr) - f0);
    const out = new Float32Array(n);
    for (const c of this.chunks) {
      const a = Math.max(f0, c.frame);
      const b = Math.min(f0 + n, c.frame + c.data.length);
      if (b > a) out.set(c.data.subarray(a - c.frame, b - c.frame), a - f0);
    }
    return out;
  }

  /** ここまで届いた音の終わり（AudioContext の秒） */
  get heardUntil(): number {
    const c = this.chunks[this.chunks.length - 1];
    return c ? (c.frame + c.data.length) / this.ctx.sampleRate : 0;
  }

  stop() {
    try {
      this.node?.port.postMessage('stop');
      this.src?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      // もう外れている
    }
    this.src = null;
    this.node = null;
    this.sink = null;
    this.chunks = [];
  }
}

/** 遅れを測るクリック（4ms の雑音を窓にかけたもの） */
function clickBuffer(ctx: BaseAudioContext): AudioBuffer {
  const n = Math.round(ctx.sampleRate * 0.004);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    d[i] = 0.5 * w * (s / 4294967296 - 0.5) * 2;
  }
  return buf;
}

/** クリックを鳴らす（時刻は AudioContext の秒）。マスターの音量やミュートに関係なく鳴らす */
export function scheduleClicks(ctx: AudioContext, times: number[]): AudioBuffer {
  const buf = clickBuffer(ctx);
  for (const t of times) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    s.start(t);
  }
  return buf;
}

/**
 * 録った音の中から、時刻 t（AudioContext の秒）に鳴らしたクリックが届いた時刻を探し、遅れ（秒）を返す。
 * 見つからなければ null
 */
export function findClickDelay(rec: PcmRecorder, click: AudioBuffer, t: number, maxDelay = 0.6): number | null {
  const sr = rec.sampleRate;
  const tpl = click.getChannelData(0);
  const seg = rec.take(t - 0.01, t + maxDelay + tpl.length / sr);
  if (seg.length < tpl.length * 2) return null;
  let best = 0;
  let at = -1;
  const scores = new Float32Array(seg.length - tpl.length);
  for (let i = 0; i < scores.length; i++) {
    let s = 0;
    for (let j = 0; j < tpl.length; j++) s += seg[i + j] * tpl[j];
    s = Math.abs(s);
    scores[i] = s;
    if (s > best) {
      best = s;
      at = i;
    }
  }
  if (at < 0 || best <= 1e-6) return null;
  // ほかの所より十分に飛び抜けているか
  const sorted = Array.from(scores).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  if (best < Math.max(1e-5, med * 8)) return null;
  return (at - Math.round(0.01 * sr)) / sr;
}

/** 測った遅れのうち、30ms 以内にそろっていちばん多い組（2 つ以上そろわなければ空） */
export function clickCluster(xs: number[]): number[] {
  let best: number[] = [];
  for (const x of xs) {
    const near = xs.filter((y) => Math.abs(y - x) < 0.03);
    if (near.length > best.length) best = near;
  }
  return best.length >= 2 ? best : [];
}
