import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engine, type SoundEvent } from './engine';

// node には AudioContext が無いので、鳴らした音（start・stop・音量の変化）を記録するだけの偽物で確かめる

class FakeParam {
  events: string[] = [];
  constructor(public value = 1) {}
  setValueAtTime(v: number, t: number) {
    this.events.push(`set ${round(v)}@${round(t)}`);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(`ramp ${round(v)}@${round(t)}`);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    return this.linearRampToValueAtTime(v, t);
  }
  setTargetAtTime(v: number, t: number) {
    this.events.push(`target ${round(v)}@${round(t)}`);
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events.push(`cancel@${round(t)}`);
    return this;
  }
}

class FakeNode {
  connect<T>(n: T): T {
    return n;
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeSource extends FakeNode {
  buffer: { duration: number; name: string } | null = null;
  gainNode: FakeGain | null = null;
  started: { when: number; offset: number } | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  connect<T>(n: T): T {
    if (n instanceof FakeGain) this.gainNode = n;
    return n;
  }
  start(when = 0, offset = 0) {
    this.started = { when: round(when), offset: round(offset) };
    sources.push(this);
  }
  stop(when = 0) {
    this.stoppedAt = round(when);
  }
}

class FakeCtx {
  currentTime = 0;
  state = 'running';
  destination = new FakeNode();
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    return new FakeSource();
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
  resume() {
    return Promise.resolve();
  }
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
let sources: FakeSource[] = [];

const buf = (name: string, duration = 200) => ({ name, duration }) as unknown as AudioBuffer;
const long = (sec: number, wav: number, bus: SoundEvent['bus'] = 'bgm'): SoundEvent => ({ sec, wav, bus, choke: null, lane: -1 });

/** 鳴らす音の表（WAV 番号 → 音）。難易度を切り替えると prepare で替わる */
function setTable(t: Record<number, { name: string; volume?: number; pan?: number; duration?: number }>) {
  const m = new Map<number, { buf: AudioBuffer | null; volume: number; pan: number; key: string }>();
  for (const [no, x] of Object.entries(t)) m.set(Number(no), { buf: buf(x.name, x.duration), volume: x.volume ?? 100, pan: x.pan ?? 0, key: x.name });
  (engine as unknown as { table: typeof m }).table = m;
}

let ctx: FakeCtx;

function playAt(events: SoundEvent[], startSec: number) {
  engine.play({ events, clicks: [], startSec, endSec: 300, rate: 1, loop: null });
}

/** 時刻を進めて、予約（pump）を1回まわす */
function tick(to: number) {
  ctx.currentTime = to;
  vi.advanceTimersByTime(25);
}

const named = (name: string) => sources.filter((s) => s.buffer?.name === name);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('AudioContext', FakeCtx);
  sources = [];
  engine.ctx = null;
  engine.ensure();
  ctx = engine.ctx as unknown as FakeCtx;
});

afterEach(() => {
  engine.stop();
  engine.ctx = null;
  engine.stretch = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('難易度を切り替えたときの原曲・SE のつなぎ替え（spliceLong）', () => {
  it('同じ音はそのまま鳴らし続ける（止めない・鳴らし直さない）', () => {
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50 } });
    const events = [long(0, 1), long(0, 3, 'se')];
    playAt(events, 10);
    tick(1);
    expect(sources).toHaveLength(2);
    engine.replaceEvents(events.slice());
    engine.spliceLong();
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.stoppedAt === null)).toBe(true);
  });

  it('SE の音量だけが違えば、SE は鳴らし直さずに音量だけを変える。原曲はそのまま', () => {
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50 } });
    const events = [long(0, 1), long(0, 3, 'se')];
    playAt(events, 10);
    tick(1);
    // 切り替え先の難易度では SE の音量が 40
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 40 } });
    engine.replaceEvents(events.slice());
    engine.spliceLong();
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.stoppedAt === null)).toBe(true);
    // 30ms 先から 12ms で 50% → 40%
    const [se] = named('se');
    expect(se.gainNode!.gain.events.slice(-3)).toEqual(['cancel@1.03', 'set 0.5@1.03', 'ramp 0.4@1.042']);
    // もう一度合わせても、もう同じ音なので何もしない
    tick(1.1);
    const n = se.gainNode!.gain.events.length;
    engine.spliceLong();
    expect(se.gainNode!.gain.events).toHaveLength(n);
    expect(sources).toHaveLength(2);
  });

  it('パンが違う SE は、同じ位置からクロスフェードで替える', () => {
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50 } });
    const events = [long(0, 1), long(0, 3, 'se')];
    playAt(events, 10);
    tick(1);
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50, pan: -30 } });
    engine.replaceEvents(events.slice());
    engine.spliceLong();
    expect(named('bgm')[0].stoppedAt).toBeNull();
    const [oldSe, newSe] = named('se');
    // 30ms 先で、前の SE は 12ms で消え、新しい SE は同じ位置（曲の 10.95 秒）から 12ms で出てくる
    expect(oldSe.gainNode!.gain.events.slice(-2)).toEqual(['set 0.5@1.03', 'ramp 0@1.042']);
    expect(oldSe.stoppedAt).toBe(1.052);
    expect(newSe.started).toEqual({ when: 1.03, offset: 10.95 });
    expect(newSe.gainNode!.gain.events).toEqual(['set 0@1.03', 'ramp 0.5@1.042']);
    expect(newSe.stoppedAt).toBeNull();
  });

  it('原曲の位置が違えば、原曲を今の位置からつなぎ替える', () => {
    setTable({ 1: { name: 'bgm' } });
    playAt([long(0, 1)], 10);
    tick(1);
    engine.replaceEvents([long(0.5, 1)]);
    engine.spliceLong();
    const [oldBgm, newBgm] = named('bgm');
    expect(oldBgm.stoppedAt).toBe(1.052);
    expect(newBgm.started).toEqual({ when: 1.03, offset: 10.45 });
  });

  it('もう予約した（これから鳴る）音は、新しい譜面の音をその時刻に鳴らす', () => {
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50 } });
    // SE は曲の 10.95 秒（ctx の 1.03 秒）から。0.9 秒の予約で先に入っている
    const events = [long(0, 1), long(10.95, 3, 'se')];
    playAt(events, 10);
    tick(0.9);
    const [oldSe] = named('se');
    expect(oldSe.started).toEqual({ when: 1.03, offset: 0 });
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 40 } });
    engine.replaceEvents(events.slice());
    engine.spliceLong();
    // 前の SE は鳴り始める前に止まる（stop が start より前）
    expect(oldSe.stoppedAt!).toBeLessThan(1.03);
    const newSe = named('se')[1];
    expect(newSe.started).toEqual({ when: 1.03, offset: 0 });
    // 次の予約で同じ SE を二重に鳴らさない
    tick(1.2);
    expect(named('se')).toHaveLength(2);
    expect(named('bgm')).toHaveLength(1);
  });

  it('ループで頭に戻る直前でも、戻った所の音を二重に鳴らさない', () => {
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50 } });
    const events = [long(0, 1), long(0, 3, 'se')];
    engine.play({ events, clicks: [], startSec: 10, endSec: 300, rate: 1, loop: { from: 10, to: 11 } });
    // 0.95 秒の予約で、1.08 秒（曲の 11 秒）に 10 秒へ戻る音まで入っている
    tick(0.95);
    expect(named('bgm').map((s) => s.started)).toEqual([
      { when: 0.08, offset: 10 },
      { when: 1.08, offset: 10 },
    ]);
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 40 } });
    engine.replaceEvents(events.slice());
    engine.spliceLong();
    // 原曲はそのまま、SE は戻った所（1.08 秒）で新しい音量のものに替える
    expect(named('bgm')).toHaveLength(2);
    const se = named('se');
    expect(se).toHaveLength(3);
    expect(se[2].started).toEqual({ when: 1.08, offset: 10 });
    expect(se[1].stoppedAt).toBe(1.102);
  });

  it('スロー再生でも、同じ原曲は伸ばした音のまま鳴らし続け、SE は音量だけを変える（位置を飛ばさない）', () => {
    // 伸ばした原曲（20 秒ごとの区切り）はいつでもある、とする
    engine.stretch = { chunkSec: 20, get: () => ({ buf: buf('bgm-slow', 41), fromSec: 0 }), request: async () => undefined };
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50 } });
    const events = [long(0, 1), long(0, 3, 'se')];
    engine.play({ events, clicks: [], startSec: 10, endSec: 300, rate: 0.5, loop: null });
    tick(1);
    const [slow] = named('bgm-slow');
    const end = slow.stoppedAt;
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 40 } });
    engine.replaceEvents(events.slice());
    engine.spliceLong();
    expect(named('bgm-slow')).toHaveLength(1);
    expect(slow.stoppedAt).toBe(end);
    expect(named('se')).toHaveLength(1);
    expect(named('se')[0].gainNode!.gain.events.slice(-1)).toEqual(['ramp 0.4@1.042']);
    // 原曲の位置が違う譜面なら、伸ばした原曲を今の位置（曲の 10.475 秒）からつなぎ替える
    engine.replaceEvents([long(0.5, 1), long(0, 3, 'se')]);
    engine.spliceLong();
    expect(slow.stoppedAt).toBe(1.052);
    const next = named('bgm-slow')[1];
    expect(next.started).toEqual({ when: 1.03, offset: (10.475 - 0.5) / 0.5 });
    expect(next.gainNode!.gain.events.slice(0, 2)).toEqual(['set 0@1.03', 'ramp 1@1.042']);
  });

  it('鳴り終わった音は鳴らし直さない', () => {
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 50, duration: 2 } });
    const events = [long(0, 1), long(0, 3, 'se')];
    playAt(events, 10);
    tick(1);
    expect(named('se')).toHaveLength(0);
    setTable({ 1: { name: 'bgm' }, 3: { name: 'se', volume: 40, duration: 2 } });
    engine.replaceEvents(events.slice());
    engine.spliceLong();
    expect(named('se')).toHaveLength(0);
    expect(named('bgm')[0].stoppedAt).toBeNull();
  });
});
