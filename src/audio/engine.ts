// 再生エンジン。Web Audio の先読みスケジューラで BGM とチップ音を鳴らす。
// スロー再生（音程そのまま）・区間ループ・再生中の譜面の書き換え・レーンのミュートに対応する。

export interface WavSource {
  no: number;
  /** キャッシュのキー（同じ音を二度読まない） */
  key: string;
  /** 曲フォルダに無いとき、エディタが用意する音（標準キット・ライブラリ） */
  fallback?: () => Promise<AudioBuffer | null>;
  load?: () => Promise<ArrayBuffer>;
  volume: number;
  pan: number;
}

export interface SoundEvent {
  sec: number;
  wav: number;
  /** 'bgm'・'stem' は途中から再生しても鳴らす。ドラムは choke でグループの前の音を止める */
  bus: 'bgm' | 'drum' | 'se' | 'stem';
  choke: string | null;
  /** ドラムのレーン（0〜9）。それ以外は -1 */
  lane: number;
}

export interface Click {
  sec: number;
  accent: boolean;
}

export interface LoopRange {
  from: number;
  to: number;
}

export interface PlayRequest {
  events: SoundEvent[];
  clicks: Click[];
  startSec: number;
  endSec: number;
  /** 曲の速さ（1 = 等倍、0.5 = 半分の速さ） */
  rate?: number;
  loop?: LoopRange | null;
  onEnd?: () => void;
  /** ループで頭に戻ったとき */
  onLoop?: () => void;
}

export interface Mix {
  master: number;
  /** マスター（全部）のミュート */
  masterMute: boolean;
  /** 原曲のトラックの音量 */
  bgm: number;
  /** 譜面の音（チップのドラム）のトラックの音量 */
  drums: number;
  metronome: boolean;
  /** 曲の音（原曲・ステム）をまとめてミュート（Alt+1） */
  bgmMute: boolean;
  /** 譜面の音のミュート（Alt+2） */
  drumMute: boolean;
  /** 原曲のトラックのミュート（ステムがあるときは初め消しておく。ステムの合計が原曲なので） */
  origMute: boolean;
  /** 原曲・譜面の音のトラックのソロ */
  origSolo: boolean;
  drumSolo: boolean;
  /** ステムのどれかがソロ（store/stems が入れる。ソロはトラックをまたいで効く） */
  stemSolo: boolean;
  /** クリックの音量 */
  click: number;
  /** クリックを小節の頭だけ鳴らす */
  clickBarOnly: boolean;
  /** 譜面の音のパン（聴き比べで右に振る） */
  drumPan: number;
  /** 原曲のパン（ステムが無いときの聴き比べで左に振る） */
  bgmPan: number;
}

/** ステムのトラックの鳴らし方 */
export interface StemStrip {
  /** ステムを登録した番号（WAV 番号と重ならない 2000 番台） */
  no: number;
  gain: number;
  pan: number;
  /** ミュート・ソロを反映して鳴らすか */
  audible: boolean;
}

export const STEM_BASE = 2000;

export type BgmFilter = 'all' | 'low' | 'mid' | 'high';

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/** スロー再生のときの BGM。伸ばした音を区切り（チャンク）ごとにつないで鳴らす */
interface Stream {
  wav: number;
  bus: 'bgm' | 'stem';
  nextSrc: number;
  nextCtx: number;
  voices: Voice[];
  dead: boolean;
}

/** 伸ばした BGM を返す（無ければ null で、作り始める） */
export interface StretchProvider {
  chunkSec: number;
  get(wav: number, rate: number, k: number): { buf: AudioBuffer; fromSec: number } | null;
  request(wav: number, rate: number, k: number): Promise<unknown>;
}

const LOOKAHEAD = 0.18;
const TICK_MS = 25;
const XF = 0.012;

function lowerBound<T extends { sec: number }>(arr: T[], sec: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].sec < sec - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Run {
  rate: number;
  /** ctx 時刻 → 曲の時刻の対応。ループで頭に戻るたびに足す */
  segs: { ctx: number; song: number }[];
  loop: LoopRange | null;
  req: PlayRequest;
  idx: number;
  clickIdx: number;
  /** 今の区間で、ここ（曲の秒）までは予約した */
  sched: number;
  timer: number;
  voices: Set<Voice>;
  chokes: Map<string, Voice>;
  /** ループで頭に戻るときに止める BGM・SE */
  longVoices: Set<Voice>;
  streams: Stream[];
}

class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<'bgm' | 'drum' | 'se' | 'click', GainNode>;
  private bgmOut!: GainNode;
  /** ステムのトラックをまとめる（原曲の帯域フィルタは通す） */
  private stemBus!: GainNode;
  private drumPanNode: StereoPannerNode | null = null;
  private bgmPanNode: StereoPannerNode | null = null;
  private strips = new Map<number, { gain: GainNode; pan: StereoPannerNode | null; def: StemStrip }>();
  private filters!: Record<Exclude<BgmFilter, 'all'>, { input: AudioNode; output: AudioNode }>;
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  private table = new Map<number, { buf: AudioBuffer | null; volume: number; pan: number; key: string }>();
  mix: Mix = {
    master: 0.9,
    masterMute: false,
    bgm: 0.8,
    drums: 0.9,
    metronome: false,
    bgmMute: false,
    drumMute: false,
    origMute: false,
    origSolo: false,
    drumSolo: false,
    stemSolo: false,
    click: 0.5,
    clickBarOnly: false,
    drumPan: 0,
    bgmPan: 0,
  };
  bgmFilter: BgmFilter = 'all';
  /** BGM を鳴らさない（YouTube の音で聴くとき） */
  bgmMuted = false;
  /** ドラムのレーンを鳴らすか（ミュート・ソロ） */
  laneGate: (lane: number) => boolean = () => true;
  stretch: StretchProvider | null = null;

  private run: Run | null = null;

  ensure(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      const bus = (to: AudioNode = this.master) => {
        const g = ctx.createGain();
        g.connect(to);
        return g;
      };
      this.bgmOut = ctx.createGain();
      this.bgmOut.connect(this.master);
      let drumOut: AudioNode = this.master;
      if (ctx.createStereoPanner) {
        this.drumPanNode = ctx.createStereoPanner();
        this.drumPanNode.connect(this.master);
        drumOut = this.drumPanNode;
      }
      let bgmIn: AudioNode = this.bgmOut;
      if (ctx.createStereoPanner) {
        this.bgmPanNode = ctx.createStereoPanner();
        this.bgmPanNode.connect(this.bgmOut);
        bgmIn = this.bgmPanNode;
      }
      this.buses = { bgm: bus(bgmIn), drum: bus(drumOut), se: bus(), click: bus() };
      this.stemBus = bus(this.bgmOut);
      const chain = (...nodes: BiquadFilterNode[]) => {
        for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]);
        nodes[nodes.length - 1].connect(this.master);
        return { input: nodes[0], output: nodes[nodes.length - 1] };
      };
      const f = (type: BiquadFilterType, freq: number) => {
        const n = ctx.createBiquadFilter();
        n.type = type;
        n.frequency.value = freq;
        n.Q.value = 0.707;
        return n;
      };
      this.filters = {
        low: chain(f('lowpass', 160), f('lowpass', 160)),
        mid: chain(f('highpass', 200), f('highpass', 200), f('lowpass', 3500)),
        high: chain(f('highpass', 5000), f('highpass', 5000)),
      };
      this.applyMix();
      this.applyFilter();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  setMix(m: Partial<Mix>) {
    this.mix = { ...this.mix, ...m };
    this.applyMix();
  }

  setBgmMuted(v: boolean) {
    this.bgmMuted = v;
    this.applyMix();
  }

  /** 原曲・譜面の音のトラックが鳴るか（ミュート・ソロ。ソロはステムも含めてトラックをまたいで効く） */
  audible(): { orig: boolean; chart: boolean; song: boolean } {
    const m = this.mix;
    const anySolo = m.origSolo || m.drumSolo || m.stemSolo;
    const song = !this.bgmMuted && !m.bgmMute;
    return {
      song,
      orig: song && !m.origMute && (!anySolo || m.origSolo),
      chart: !m.drumMute && (!anySolo || m.drumSolo),
    };
  }

  private applyMix() {
    if (!this.ctx) return;
    const m = this.mix;
    const a = this.audible();
    this.master.gain.value = m.masterMute ? 0 : m.master;
    this.buses.bgm.gain.value = a.orig ? m.bgm : 0;
    this.stemBus.gain.value = a.song ? 1 : 0;
    this.buses.se.gain.value = a.song && !(m.origSolo || m.drumSolo || m.stemSolo) ? 1 : 0;
    this.buses.drum.gain.value = a.chart ? m.drums : 0;
    this.buses.click.gain.value = m.metronome || this.forceClick ? Math.max(0.05, m.click) : 0;
    if (this.drumPanNode) this.drumPanNode.pan.value = Math.max(-1, Math.min(1, m.drumPan));
    if (this.bgmPanNode) this.bgmPanNode.pan.value = Math.max(-1, Math.min(1, m.bgmPan));
    for (const st of this.strips.values()) this.applyStrip(st);
  }

  private applyStrip(st: { gain: GainNode; pan: StereoPannerNode | null; def: StemStrip }) {
    st.gain.gain.value = st.def.audible ? Math.max(0, st.def.gain) : 0;
    if (st.pan) st.pan.pan.value = Math.max(-1, Math.min(1, st.def.pan));
  }

  /** ステムのトラック（音量・パン・ミュート）。無くなったトラックは外す */
  setStemStrips(list: StemStrip[]) {
    const ctx = this.ensure();
    const keep = new Set(list.map((x) => x.no));
    for (const [no, st] of this.strips) {
      if (keep.has(no)) continue;
      st.gain.disconnect();
      this.strips.delete(no);
    }
    for (const def of list) {
      let st = this.strips.get(def.no);
      if (!st) {
        const gain = ctx.createGain();
        let pan: StereoPannerNode | null = null;
        if (ctx.createStereoPanner) {
          pan = ctx.createStereoPanner();
          gain.connect(pan);
          pan.connect(this.stemBus);
        } else {
          gain.connect(this.stemBus);
        }
        st = { gain, pan, def };
        this.strips.set(def.no, st);
      }
      st.def = def;
      this.applyStrip(st);
    }
  }

  /** ステムの音を登録する（WAV の表とは別に持つ） */
  setStemBuffers(list: { no: number; key: string; buf: AudioBuffer }[]) {
    this.stemTable = new Map(list.map((x) => [x.no, { buf: x.buf, volume: 100, pan: 0, key: x.key }]));
  }

  private stemTable = new Map<number, { buf: AudioBuffer | null; volume: number; pan: number; key: string }>();

  private entry(no: number) {
    return no >= STEM_BASE ? this.stemTable.get(no) : this.table.get(no);
  }

  /** テンポ合わせ画面では、ミックスの設定に関係なくクリックを鳴らす */
  forceClick = false;

  setForceClick(v: boolean) {
    this.forceClick = v;
    this.applyMix();
  }

  /** 原曲に帯域フィルタをかける（キック帯・スネア帯・シンバル帯だけを聴く） */
  setBgmFilter(f: BgmFilter) {
    this.bgmFilter = f;
    this.applyFilter();
  }

  private applyFilter() {
    if (!this.ctx) return;
    this.bgmOut.disconnect();
    if (this.bgmFilter === 'all') this.bgmOut.connect(this.master);
    else this.bgmOut.connect(this.filters[this.bgmFilter].input);
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
            if (!src.fallback) return null;
          }
        }
        if (src.fallback) return await src.fallback();
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
    const next = new Map<number, { buf: AudioBuffer | null; volume: number; pan: number; key: string }>();
    await Promise.all(
      sources.map(async (s) => {
        const buf = await this.decode(s);
        if (!buf) failed.push(s.no);
        next.set(s.no, { buf, volume: s.volume, pan: s.pan, key: s.key });
        onProgress?.(++done, sources.length);
      }),
    );
    this.table = next;
    return failed.sort((a, b) => a - b);
  }

  duration(no: number): number {
    return this.entry(no)?.buf?.duration ?? 0;
  }

  /** 読み込んだ音（解析に使う） */
  buffer(no: number): { buf: AudioBuffer; key: string } | null {
    const t = this.entry(no);
    return t?.buf ? { buf: t.buf, key: t.key } : null;
  }

  private connectVoice(buf: AudioBuffer, volume: number, pan: number, bus: SoundEvent['bus'], no = 0): Voice {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume / 100));
    let node: AudioNode = src.connect(gain);
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan / 100));
      node = node.connect(p);
    }
    if (bus === 'stem') {
      const st = this.strips.get(no);
      node.connect(st ? st.gain : this.stemBus);
    } else {
      node.connect(this.buses[bus]);
    }
    return { src, gain };
  }

  private startVoice(no: number, when: number, offset: number, bus: SoundEvent['bus']): Voice | null {
    const t = this.entry(no);
    if (!this.ctx || !t?.buf) return null;
    if (offset >= t.buf.duration) return null;
    const v = this.connectVoice(t.buf, t.volume, t.pan, bus, no);
    if (offset > 0.001) {
      // 途中から鳴らすときは小さくフェードイン（プチッと鳴らさない）
      const g = v.gain.gain.value;
      v.gain.gain.setValueAtTime(0, when);
      v.gain.gain.linearRampToValueAtTime(g, when + 0.006);
    }
    v.src.start(when, Math.max(0, offset));
    return v;
  }

  /** 1音だけ鳴らす（WAVリストの試聴やチップを置いたとき）。gain は叩いた強さ（0〜1） */
  preview(no: number, gain = 1): boolean {
    const ctx = this.ensure();
    const v = this.startVoice(no, ctx.currentTime + 0.005, 0, 'drum');
    if (v && gain !== 1) v.gain.gain.value *= Math.max(0, Math.min(4, gain));
    return v !== null;
  }

  /** 読み込んだ音の表に無い音を鳴らす（内蔵キットの試し打ち） */
  previewBuffer(buf: AudioBuffer, gain = 1) {
    const ctx = this.ensure();
    const v = this.connectVoice(buf, 100 * Math.max(0, Math.min(1, gain)), 0, 'drum');
    v.src.start(ctx.currentTime + 0.005);
  }

  /** WAV 番号の音が読み込めているか */
  has(no: number): boolean {
    return !!this.table.get(no)?.buf;
  }

  get playing() {
    return this.run !== null;
  }

  get rate() {
    return this.run?.rate ?? 1;
  }

  get loop(): LoopRange | null {
    return this.run?.loop ?? null;
  }

  /**
   * ctx 時刻のときの曲の位置。鳴り始める前は始めの位置のまま。
   * ループで頭に戻ったあとは、戻った区間の位置を返す（始めの位置より前でもよい）
   */
  private songAt(run: Run, ctxTime: number): number {
    const first = run.segs[0];
    if (ctxTime <= first.ctx) return first.song;
    let seg = first;
    for (const s of run.segs) if (s.ctx <= ctxTime + 1e-9) seg = s;
    return seg.song + (ctxTime - seg.ctx) * run.rate;
  }

  /** 再生中なら、いま音を作っている曲の位置（秒）。耳に届くのは出力の遅れの分あと（画面には heardSec を使う） */
  currentSec(): number | null {
    if (!this.run || !this.ctx) return null;
    return this.songAt(this.run, this.ctx.currentTime);
  }

  /** 再生中なら、いま耳に届いている曲の位置（秒）。画面の再生位置や「今の位置」に使う */
  heardSec(): number | null {
    return this.songSecAtPerf(performance.now());
  }

  /**
   * performance.now() の時刻に「聞こえていた」曲の位置（秒）。録音で使う。
   * 出力の遅れ（スピーカーに届くまで）は getOutputTimestamp で埋める。
   */
  songSecAtPerf(perfMs: number): number | null {
    const run = this.run;
    const ctx = this.ctx;
    if (!run || !ctx) return null;
    return this.songAt(run, this.heardCtxAt(ctx, perfMs));
  }

  /**
   * いま耳に届いている曲の位置（秒）。鳴り始める前は、始めの位置から前へ延ばした位置を返す
   * （参照映像を、音が鳴り始める時刻にそろえて動かし始めるため）
   */
  heardSecLinear(): number | null {
    const run = this.run;
    const ctx = this.ctx;
    if (!run || !ctx) return null;
    const t = this.heardCtxAt(ctx, performance.now());
    const first = run.segs[0];
    if (t < first.ctx) return first.song + (t - first.ctx) * run.rate;
    return this.songAt(run, t);
  }

  /** performance.now() の時刻に耳に届いていた音の AudioContext の時刻 */
  private heardCtxAt(ctx: AudioContext, perfMs: number): number {
    let ctxTime: number;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0 && ts.contextTime > 0) {
      ctxTime = ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    } else {
      ctxTime = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) + (perfMs - performance.now()) / 1000;
    }
    // 出力の時刻が古いまま（タブが裏にあった直後など）でも、作っている音より先には進めない
    return Math.min(ctxTime, ctx.currentTime + (perfMs - performance.now()) / 1000);
  }

  /** スピーカーに届くまでの遅れ（秒）。分からなければ 0 */
  outputLatency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  }

  play(req: PlayRequest) {
    this.stop();
    const ctx = this.ensure();
    const t0 = ctx.currentTime + 0.08;
    const run: Run = {
      rate: req.rate && req.rate > 0 ? req.rate : 1,
      segs: [{ ctx: t0, song: req.startSec }],
      loop: req.loop && req.loop.to > req.loop.from + 0.05 ? { ...req.loop } : null,
      req,
      idx: 0,
      clickIdx: 0,
      sched: req.startSec,
      timer: 0,
      voices: new Set(),
      chokes: new Map(),
      longVoices: new Set(),
      streams: [],
    };
    this.run = run;
    this.startSegment(run, req.startSec, t0);
    this.pump();
    run.timer = window.setInterval(() => this.pump(), TICK_MS);
  }

  /** 区間の頭：すでに鳴り始めている BGM・SE を途中から鳴らし、予約の位置をそろえる */
  private startSegment(run: Run, song: number, when: number) {
    const { events, clicks } = run.req;
    const i0 = lowerBound(events, song);
    for (let i = 0; i < i0; i++) {
      const e = events[i];
      if (e.bus === 'drum') continue;
      const offset = song - e.sec;
      if (offset >= this.duration(e.wav)) continue;
      this.startLong(run, e, song, when, offset);
    }
    run.idx = i0;
    run.clickIdx = lowerBound(clicks, song);
    run.sched = song;
  }

  private startLong(run: Run, e: SoundEvent, song: number, when: number, offset: number) {
    if ((e.bus === 'bgm' || e.bus === 'stem') && run.rate < 0.999 && this.stretch) {
      run.streams.push({ wav: e.wav, bus: e.bus, nextSrc: offset, nextCtx: when, voices: [], dead: false });
      void song;
      return;
    }
    const v = this.startVoice(e.wav, when, offset, e.bus);
    if (v) {
      this.track(run, v, null);
      run.longVoices.add(v);
    }
  }

  private track(run: Run, v: Voice, choke: string | null) {
    run.voices.add(v);
    v.src.onended = () => {
      run.voices.delete(v);
      run.longVoices.delete(v);
    };
    if (choke) run.chokes.set(choke, v);
  }

  private fadeStop(v: Voice, when: number) {
    try {
      v.gain.gain.cancelScheduledValues(when);
      v.gain.gain.setValueAtTime(v.gain.gain.value, when);
      v.gain.gain.linearRampToValueAtTime(0, when + XF);
      v.src.stop(when + XF + 0.01);
    } catch {
      // もう止まっている
    }
  }

  private pumpStreams(run: Run, horizon: number) {
    const ctx = this.ctx!;
    const sp = this.stretch;
    if (!sp) return;
    for (const st of run.streams) {
      let guard = 0;
      while (!st.dead && st.nextCtx < horizon + 0.5 && guard++ < 3) {
        const dur = this.duration(st.wav);
        if (st.nextSrc >= dur) {
          st.dead = true;
          break;
        }
        const k = Math.floor(st.nextSrc / sp.chunkSec);
        const got = sp.get(st.wav, run.rate, k);
        if (!got) {
          void sp.request(st.wav, run.rate, k);
          // 間に合わなかったら、用意できた時点の位置から鳴らす
          if (st.nextCtx < ctx.currentTime) {
            const late = ctx.currentTime + 0.05 - st.nextCtx;
            st.nextSrc += late * run.rate;
            st.nextCtx += late;
          }
          break;
        }
        const t = this.entry(st.wav);
        const endSrc = Math.min(dur, (k + 1) * sp.chunkSec);
        const when = Math.max(ctx.currentTime, st.nextCtx);
        const lateBy = when - st.nextCtx;
        const offset = (st.nextSrc - got.fromSec) / run.rate + lateBy;
        const v = this.connectVoice(got.buf, t?.volume ?? 100, t?.pan ?? 0, st.bus, st.wav);
        const g = v.gain.gain.value;
        v.gain.gain.setValueAtTime(0, when);
        v.gain.gain.linearRampToValueAtTime(g, when + XF);
        const endCtx = st.nextCtx + (endSrc - st.nextSrc) / run.rate;
        v.gain.gain.setValueAtTime(g, endCtx);
        v.gain.gain.linearRampToValueAtTime(0, endCtx + XF);
        v.src.start(when, Math.max(0, offset));
        v.src.stop(endCtx + XF + 0.01);
        this.track(run, v, null);
        run.longVoices.add(v);
        st.voices.push(v);
        st.nextSrc = endSrc;
        st.nextCtx = endCtx;
        // 次の区切りを先に作っておく
        void sp.request(st.wav, run.rate, k + 1);
      }
    }
    run.streams = run.streams.filter((s) => !s.dead || s.voices.some((v) => run.voices.has(v)));
  }

  private pump() {
    const run = this.run;
    const ctx = this.ctx;
    if (!run || !ctx) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    const { clicks } = run.req;
    for (let guard = 0; guard < 4; guard++) {
      const seg = run.segs[run.segs.length - 1];
      const toCtx = (sec: number) => seg.ctx + (sec - seg.song) / run.rate;
      const songH = seg.song + (horizon - seg.ctx) * run.rate;
      const limit = run.loop ? Math.min(songH, run.loop.to) : songH;
      const events = run.req.events;
      while (run.idx < events.length && events[run.idx].sec < limit) {
        const e = events[run.idx++];
        if (e.sec < seg.song - 1e-6) continue;
        if (e.bus === 'drum' && !this.laneGate(e.lane)) continue;
        const when = Math.max(now, toCtx(e.sec));
        if (e.bus !== 'drum') {
          this.startLong(run, e, e.sec, when, 0);
          continue;
        }
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
      while (run.clickIdx < clicks.length && clicks[run.clickIdx].sec < limit) {
        const c = clicks[run.clickIdx++];
        if (c.sec < seg.song - 1e-6) continue;
        if (this.mix.clickBarOnly && !c.accent && !this.forceClick) continue;
        if (this.mix.metronome || this.forceClick) this.click(Math.max(now, toCtx(c.sec)), c.accent);
      }
      run.sched = Math.max(run.sched, limit);
      this.pumpStreams(run, horizon);
      if (run.loop && songH >= run.loop.to) {
        // ループの終わり：鳴っている BGM を止めて頭から
        const boundary = Math.max(now + 0.01, toCtx(run.loop.to));
        for (const v of run.longVoices) this.fadeStop(v, boundary);
        run.longVoices.clear();
        for (const st of run.streams) st.dead = true;
        run.streams = [];
        run.segs.push({ ctx: boundary, song: run.loop.from });
        // 耳に届くまでの遅れの間は前の区間の位置を出すので、少し残しておく
        if (run.segs.length > 8) run.segs.shift();
        this.startSegment(run, run.loop.from, boundary);
        const cb = run.req.onLoop;
        if (cb) window.setTimeout(cb, Math.max(0, (boundary - now) * 1000));
        continue;
      }
      break;
    }
    if (!run.loop) {
      const seg = run.segs[run.segs.length - 1];
      if (now > seg.ctx + (run.req.endSec - seg.song) / run.rate) {
        const cb = run.req.onEnd;
        this.stop();
        cb?.();
      }
    }
  }

  /** 再生中に譜面が変わったとき、まだ予約していない所から新しいチップで鳴らす */
  replaceEvents(events: SoundEvent[], clicks?: Click[]) {
    const run = this.run;
    if (!run) return;
    run.req = { ...run.req, events, clicks: clicks ?? run.req.clicks };
    run.idx = lowerBound(events, run.sched);
    if (clicks) run.clickIdx = lowerBound(clicks, run.sched);
  }

  /** 再生中に止める位置を変える（曲の終わりを動かしたとき） */
  setEndSec(endSec: number) {
    const run = this.run;
    if (!run || !Number.isFinite(endSec) || run.req.endSec === endSec) return;
    run.req = { ...run.req, endSec };
  }

  /** 再生中にループの範囲を変える（null で解除） */
  setLoop(loop: LoopRange | null) {
    const run = this.run;
    if (!run) return;
    run.loop = loop && loop.to > loop.from + 0.05 ? { ...loop } : null;
    if (run.loop) {
      // いまの位置が範囲の外なら次の予約で頭に戻る
      const cur = this.currentSec() ?? run.loop.from;
      if (cur < run.loop.from - 0.01) run.sched = Math.min(run.sched, run.loop.to);
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

  /** メトロノームの音だけを鳴らす（遅延の測定用） */
  clickAt(when: number, accent = false) {
    this.ensure();
    const prev = this.mix.metronome;
    this.buses.click.gain.value = Math.max(0.3, this.mix.click);
    this.click(when, accent);
    if (!prev) window.setTimeout(() => this.applyMix(), Math.max(0, (when - this.ctx!.currentTime) * 1000) + 120);
  }

  stop() {
    const run = this.run;
    if (!run) return;
    window.clearInterval(run.timer);
    const now = this.ctx?.currentTime ?? 0;
    for (const v of run.voices) {
      try {
        v.gain.gain.cancelScheduledValues(now);
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
