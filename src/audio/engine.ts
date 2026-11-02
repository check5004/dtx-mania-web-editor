// 再生エンジン。Web Audio の先読みスケジューラで BGM とチップ音を鳴らす。
import { loadKit } from './kit';

export interface WavSource {
  no: number;
  /** キャッシュのキー（同じ音を二度読まない） */
  key: string;
  /** 内蔵キットのファイル名（小文字）。曲フォルダに無いとき使う */
  kitFile?: string;
  load?: () => Promise<ArrayBuffer>;
  volume: number;
  pan: number;
}

export interface SoundEvent {
  sec: number;
  wav: number;
  /** 'bgm' は途中から再生しても鳴らす。ドラムは choke でグループの前の音を止める */
  bus: 'bgm' | 'drum' | 'se';
  choke: string | null;
}

export interface PlayRequest {
  events: SoundEvent[];
  clicks: { sec: number; accent: boolean }[];
  startSec: number;
  endSec: number;
  onEnd?: () => void;
}

export interface Mix {
  master: number;
  bgm: number;
  drums: number;
  metronome: boolean;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

const LOOKAHEAD = 0.18;
const TICK_MS = 25;

class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<'bgm' | 'drum' | 'se' | 'click', GainNode>;
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  private table = new Map<number, { buf: AudioBuffer | null; volume: number; pan: number }>();
  mix: Mix = { master: 0.9, bgm: 0.8, drums: 0.9, metronome: false };

  private run: {
    t0: number;
    startSec: number;
    req: PlayRequest;
    idx: number;
    clickIdx: number;
    timer: number;
    voices: Set<Voice>;
    chokes: Map<string, Voice>;
  } | null = null;

  ensure(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      const bus = () => {
        const g = ctx.createGain();
        g.connect(this.master);
        return g;
      };
      this.buses = { bgm: bus(), drum: bus(), se: bus(), click: bus() };
      this.applyMix();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  setMix(m: Partial<Mix>) {
    this.mix = { ...this.mix, ...m };
    this.applyMix();
  }

  private applyMix() {
    if (!this.ctx) return;
    this.master.gain.value = this.mix.master;
    this.buses.bgm.gain.value = this.mix.bgm;
    this.buses.se.gain.value = this.mix.bgm;
    this.buses.drum.gain.value = this.mix.drums;
    this.buses.click.gain.value = this.mix.metronome ? 0.5 : 0;
  }

  clearCache() {
    this.cache.clear();
    this.table.clear();
  }

  private decode(src: WavSource): Promise<AudioBuffer | null> {
    let p = this.cache.get(src.key);
    if (!p) {
      const ctx = this.ensure();
      p = (async () => {
        if (src.load) {
          try {
            return await ctx.decodeAudioData(await src.load());
          } catch {
            if (!src.kitFile) return null;
          }
        }
        if (src.kitFile) return (await loadKit()).get(src.kitFile) ?? null;
        return null;
      })();
      this.cache.set(src.key, p);
    }
    return p;
  }

  /** 使う音をすべて読み込む。読めなかった WAV 番号を返す */
  async prepare(sources: WavSource[], onProgress?: (done: number, total: number) => void): Promise<number[]> {
    const failed: number[] = [];
    let done = 0;
    const next = new Map<number, { buf: AudioBuffer | null; volume: number; pan: number }>();
    await Promise.all(
      sources.map(async (s) => {
        const buf = await this.decode(s);
        if (!buf) failed.push(s.no);
        next.set(s.no, { buf, volume: s.volume, pan: s.pan });
        onProgress?.(++done, sources.length);
      }),
    );
    this.table = next;
    return failed.sort((a, b) => a - b);
  }

  duration(no: number): number {
    return this.table.get(no)?.buf?.duration ?? 0;
  }

  private startVoice(no: number, when: number, offset: number, bus: 'bgm' | 'drum' | 'se'): Voice | null {
    const ctx = this.ctx;
    const t = this.table.get(no);
    if (!ctx || !t?.buf) return null;
    if (offset >= t.buf.duration) return null;
    const src = ctx.createBufferSource();
    src.buffer = t.buf;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, t.volume / 100));
    let node: AudioNode = src.connect(gain);
    if (t.pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, t.pan / 100));
      node = node.connect(p);
    }
    node.connect(this.buses[bus]);
    src.start(when, offset);
    return { src, gain };
  }

  /** 1音だけ鳴らす（WAVリストの試聴やチップを置いたとき） */
  preview(no: number) {
    const ctx = this.ensure();
    this.startVoice(no, ctx.currentTime + 0.005, 0, 'drum');
  }

  get playing() {
    return this.run !== null;
  }

  /** 再生中なら今の曲の位置（秒） */
  currentSec(): number | null {
    if (!this.run || !this.ctx) return null;
    return this.run.startSec + Math.max(0, this.ctx.currentTime - this.run.t0);
  }

  play(req: PlayRequest) {
    this.stop();
    const ctx = this.ensure();
    const t0 = ctx.currentTime + 0.08;
    const voices = new Set<Voice>();
    const run = {
      t0,
      startSec: req.startSec,
      req,
      idx: 0,
      clickIdx: 0,
      timer: 0,
      voices,
      chokes: new Map<string, Voice>(),
    };
    // 途中から再生するとき、すでに鳴り始めている BGM・SE は途中から鳴らす
    let i = 0;
    while (i < req.events.length && req.events[i].sec < req.startSec) {
      const e = req.events[i];
      if (e.bus !== 'drum') {
        const v = this.startVoice(e.wav, t0, req.startSec - e.sec, e.bus);
        if (v) this.track(run, v, null);
      }
      i++;
    }
    run.idx = i;
    while (run.clickIdx < req.clicks.length && req.clicks[run.clickIdx].sec < req.startSec - 1e-6) run.clickIdx++;
    this.run = run;
    this.pump();
    run.timer = window.setInterval(() => this.pump(), TICK_MS);
  }

  private track(run: NonNullable<AudioEngine['run']>, v: Voice, choke: string | null) {
    run.voices.add(v);
    v.src.onended = () => run.voices.delete(v);
    if (choke) run.chokes.set(choke, v);
  }

  private pump() {
    const run = this.run;
    const ctx = this.ctx;
    if (!run || !ctx) return;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const toCtx = (sec: number) => run.t0 + (sec - run.startSec);
    const { events, clicks } = run.req;
    while (run.idx < events.length && toCtx(events[run.idx].sec) < horizon) {
      const e = events[run.idx++];
      const when = Math.max(ctx.currentTime, toCtx(e.sec));
      if (e.choke) {
        const prev = run.chokes.get(e.choke);
        if (prev) {
          prev.gain.gain.setTargetAtTime(0, when, 0.012);
          try {
            prev.src.stop(when + 0.08);
          } catch {
            // もう止まっている
          }
        }
      }
      const v = this.startVoice(e.wav, when, 0, e.bus);
      if (v) this.track(run, v, e.choke);
    }
    while (run.clickIdx < clicks.length && toCtx(clicks[run.clickIdx].sec) < horizon) {
      const c = clicks[run.clickIdx++];
      if (this.mix.metronome) this.click(Math.max(ctx.currentTime, toCtx(c.sec)), c.accent);
    }
    if (ctx.currentTime > toCtx(run.req.endSec)) {
      const cb = run.req.onEnd;
      this.stop();
      cb?.();
    }
  }

  private click(when: number, accent: boolean) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = accent ? 1760 : 1175;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.6, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(this.buses.click);
    o.start(when);
    o.stop(when + 0.06);
  }

  stop() {
    const run = this.run;
    if (!run) return;
    window.clearInterval(run.timer);
    const now = this.ctx?.currentTime ?? 0;
    for (const v of run.voices) {
      try {
        v.gain.gain.setTargetAtTime(0, now, 0.01);
        v.src.stop(now + 0.05);
      } catch {
        // もう止まっている
      }
    }
    this.run = null;
  }
}

export const engine = new AudioEngine();
