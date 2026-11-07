import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// iPad の Safari として動かす（判定の値だけ差し替える）。決まりは docs/safari.md
vi.mock('../platform', () => ({ IS_IOS: true, IS_WEBKIT: true, IS_SAFARI: true }));

import { engine, type StallInfo } from './engine';

// node には AudioContext が無いので、Safari の決まりをまねる偽物で確かめる：
// - 作った直後は suspended。操作（タップ・キー）の中で resume するか音を鳴らすと running になる
// - 操作の外の resume は何もしない（Safari は promise が返らないまま待つ）
// - stuck にすると、何をしても動かない（起こしても起きない出力）

let gesture = false;
const created: FakeCtx[] = [];
let offlineMade = 0;

class FakeParam {
  constructor(public value = 1) {}
  setValueAtTime() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
  setTargetAtTime() {
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  connect<T>(n: T): T {
    return n;
  }
  disconnect() {}
}

class FakeCtx {
  currentTime = 0;
  state = 'suspended';
  sampleRate = 48000;
  stuck = false;
  resumes = 0;
  /** 鳴らした 1 サンプルの無音 */
  silences = 0;
  closed = false;
  destination = new FakeNode();
  constructor() {
    created.push(this);
  }
  private start() {
    if (gesture && !this.stuck && this.state !== 'closed') this.state = 'running';
  }
  resume() {
    this.resumes++;
    this.start();
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam(1) });
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(), { pan: new FakeParam(0) });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(350), Q: new FakeParam(1) });
  }
  createOscillator() {
    return Object.assign(new FakeNode(), { frequency: new FakeParam(440), start() {}, stop() {} });
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 2, length: 96000, numberOfChannels: 2, sampleRate: 48000 } as unknown as AudioBuffer);
  }
  createBuffer(ch: number, len: number) {
    return { numberOfChannels: ch, length: len, duration: len / 48000 };
  }
  createBufferSource() {
    const ctx = this;
    return Object.assign(new FakeNode(), {
      buffer: null as { length: number } | null,
      playbackRate: new FakeParam(1),
      detune: new FakeParam(0),
      onended: null as (() => void) | null,
      start() {
        if (this.buffer?.length === 1) ctx.silences++;
        // Safari：操作の中で音を鳴らすと、出力が動き出す
        ctx.start();
      },
      stop() {},
    });
  }
}

class FakeOffline {
  constructor() {
    offlineMade++;
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 1, length: 48000, numberOfChannels: 2, sampleRate: 48000 } as unknown as AudioBuffer);
  }
}

// 画面の出来事（タップ・画面の切り替え）
const winListeners = new Map<string, (() => void)[]>();
const docListeners = new Map<string, (() => void)[]>();
const fakeDoc = {
  hidden: false,
  visibilityState: 'visible',
  addEventListener(t: string, f: () => void) {
    docListeners.set(t, [...(docListeners.get(t) ?? []), f]);
  },
};
const fakeWin = {
  addEventListener(t: string, f: () => void) {
    winListeners.set(t, [...(winListeners.get(t) ?? []), f]);
  },
  setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms),
  clearTimeout: (id: number) => globalThis.clearTimeout(id),
  setInterval: (f: () => void, ms: number) => globalThis.setInterval(f, ms),
  clearInterval: (id: number) => globalThis.clearInterval(id),
};
const fakeNav = { userAgent: 'test', maxTouchPoints: 5, userActivation: { isActive: false }, audioSession: { type: 'auto' } };

/** タップ（指を離したとき）。Safari はここで出力を起こせる */
function tap(type = 'pointerup', run?: () => void) {
  gesture = true;
  fakeNav.userActivation.isActive = true;
  try {
    for (const f of winListeners.get(type) ?? []) f();
    run?.();
  } finally {
    gesture = false;
    fakeNav.userActivation.isActive = false;
  }
}

function setVisible(v: boolean) {
  fakeDoc.hidden = !v;
  fakeDoc.visibilityState = v ? 'visible' : 'hidden';
  for (const f of docListeners.get('visibilitychange') ?? []) f();
}

const cur = () => engine.ctx as unknown as FakeCtx;

function play(onEnd = () => {}) {
  engine.play({ events: [], clicks: [], startSec: 0, endSec: 300, rate: 1, loop: null, onEnd });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', fakeWin);
  vi.stubGlobal('document', fakeDoc);
  vi.stubGlobal('navigator', fakeNav);
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.stubGlobal('OfflineAudioContext', FakeOffline);
  gesture = false;
  fakeNav.audioSession.type = 'auto';
  fakeDoc.hidden = false;
  fakeDoc.visibilityState = 'visible';
  created.length = 0;
  engine.onStall = null;
});

afterEach(() => {
  engine.stop();
  engine.ctx = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Safari・iPad の音の出力（docs/safari.md）', () => {
  it('タップの外では再生用の出力を作らない。音の読み込みとステムのトラックは出力が無くても済む', async () => {
    engine.setStemStrips([{ no: 2000, gain: 80, pan: 0, audible: true }]);
    const buf = await engine.decodeAudio(new ArrayBuffer(8));
    expect(buf.duration).toBe(1);
    expect(created).toHaveLength(0);
    expect(engine.ctx).toBeNull();
    expect(offlineMade).toBe(1);
    // 出力を作ったら、覚えておいたステムのトラックを入れる
    tap('pointerup', () => engine.ensure());
    const strips = (engine as unknown as { strips: Map<number, unknown> }).strips;
    expect(strips.has(2000)).toBe(true);
    // 出力ができたら、読み込みも同じ出力で行う（オフラインは作り足さない）
    expect((await engine.decodeAudio(new ArrayBuffer(8))).duration).toBe(2);
    expect(offlineMade).toBe(1);
  });

  it('タップの中で作った出力は「再生」の音にして（消音で黙らない）、起こして無音を 1 回鳴らす', () => {
    tap('pointerup', () => engine.ensure());
    expect(fakeNav.audioSession.type).toBe('playback');
    expect(cur().state).toBe('running');
    expect(cur().resumes).toBe(1);
    expect(cur().silences).toBe(1);
    // 動いている出力には、次の操作で何もしない
    tap('pointerup');
    expect(cur().resumes).toBe(1);
    expect(cur().silences).toBe(1);
    expect(engine.status()).toMatchObject({ created: true, state: 'running', session: 'playback', stalls: 0 });
  });

  it('止まった出力（suspended・Safari の interrupted）は、次のタップ（pointerup・touchend でも）で起こす', () => {
    tap('pointerup', () => engine.ensure());
    for (const [state, ev] of [
      ['suspended', 'pointerup'],
      ['interrupted', 'touchend'],
      ['suspended', 'keydown'],
    ]) {
      cur().state = state;
      tap(ev);
      expect(cur().state).toBe('running');
    }
  });

  it('再生しても時刻が進まなければ、止めて知らせる。次の ▶（タップの中）で出力を作り直す', () => {
    tap('pointerup', () => engine.ensure());
    const first = cur();
    first.state = 'suspended';
    first.stuck = true;
    const stalls: StallInfo[] = [];
    engine.onStall = (i) => stalls.push(i);
    const onEnd = vi.fn();
    play(onEnd);
    vi.advanceTimersByTime(2100);
    expect(stalls).toEqual([{ state: 'suspended', frozen: false }]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(engine.status().stalls).toBe(1);
    // 次の ▶：古い出力を閉じ、新しく作って鳴らす
    tap('click', () => engine.ensure());
    expect(created).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(cur()).not.toBe(first);
    expect(cur().state).toBe('running');
  });

  it('running なのに時刻が止まったまま（Safari の不具合）でも知らせる', () => {
    tap('pointerup', () => engine.ensure());
    const stalls: StallInfo[] = [];
    engine.onStall = (i) => stalls.push(i);
    play();
    vi.advanceTimersByTime(2100);
    expect(stalls).toEqual([{ state: 'running', frozen: true }]);
  });

  it('時刻が進んでいれば何もしない（止めない・知らせない）', () => {
    tap('pointerup', () => engine.ensure());
    const onStall = vi.fn();
    engine.onStall = onStall;
    const onEnd = vi.fn();
    play(onEnd);
    cur().currentTime = 1.5;
    vi.advanceTimersByTime(2100);
    expect(onStall).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(engine.playing).toBe(true);
  });

  it('裏にいる間は確かめない（戻ってから確かめる）', () => {
    tap('pointerup', () => engine.ensure());
    const onStall = vi.fn();
    engine.onStall = onStall;
    play();
    fakeDoc.hidden = true;
    vi.advanceTimersByTime(2100);
    expect(onStall).not.toHaveBeenCalled();
    fakeDoc.hidden = false;
    vi.advanceTimersByTime(2100);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('iPad で画面を離れたら再生を止める。戻ったあとの最初のタップで無音を鳴らして出力を開く', () => {
    tap('pointerup', () => engine.ensure());
    const onEnd = vi.fn();
    play(onEnd);
    setVisible(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(engine.playing).toBe(false);
    const before = cur().silences;
    setVisible(true);
    // 操作の外：無音は鳴らすが、操作の中でないので次のタップでもう一度
    tap('pointerup');
    expect(cur().silences).toBeGreaterThan(before);
    const after = cur().silences;
    tap('pointerup');
    expect(cur().silences).toBe(after);
  });

  it('「音の出力を作り直す」：今の出力を閉じて新しく作る（回数は 0 に戻す）', () => {
    tap('pointerup', () => engine.ensure());
    const first = cur();
    tap('click', () => engine.resetOutput());
    expect(first.closed).toBe(true);
    expect(cur()).not.toBe(first);
    expect(cur().state).toBe('running');
    expect(engine.status().stalls).toBe(0);
  });
});
