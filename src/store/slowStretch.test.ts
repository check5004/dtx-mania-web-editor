import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engine, type SoundEvent } from '../audio/engine';
import * as wk from '../audio/workerClient';
import { slowNeeds, stretchProvider } from './assist';

// スロー再生で伸ばす音（原曲・SE・ステム）の用意。ワーカー（node には無い）は、渡された所の長さを 1/rate 倍にして返す偽物にする
vi.mock('../audio/workerClient', async (orig) => ({
  ...(await orig<typeof import('../audio/workerClient')>()),
  stretch: vi.fn(async (channels: Float32Array[], sr: number, rate: number, from: number, to: number) => ({
    channels: channels.map(() => new Float32Array(Math.ceil((to - from) / rate))),
    fromSample: from,
    sr,
  })),
}));

const SR = 1000;
/** 長さ duration 秒の音（SR は小さくしてある） */
function sound(key: string, duration: number) {
  const length = Math.round(duration * SR);
  const data = new Float32Array(length);
  const buf = { duration, length, sampleRate: SR, numberOfChannels: 2, getChannelData: () => data } as unknown as AudioBuffer;
  return { key, buf };
}

let sounds: Map<number, { key: string; buf: AudioBuffer }>;
const ev = (sec: number, wav: number, bus: SoundEvent['bus']): SoundEvent => ({ sec, wav, bus, choke: null, lane: bus === 'drum' ? 1 : -1 });

beforeEach(() => {
  sounds = new Map();
  vi.spyOn(engine, 'buffer').mockImplementation((no) => sounds.get(no) ?? null);
  vi.spyOn(engine, 'duration').mockImplementation((no) => sounds.get(no)?.buf.duration ?? 0);
  vi.spyOn(engine, 'workCtx').mockReturnValue({
    createBuffer: (n: number, len: number, sr: number) => ({ numberOfChannels: n, length: len, sampleRate: sr, duration: len / sr, copyToChannel() {} }),
  } as unknown as BaseAudioContext);
  vi.mocked(wk.stretch).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('スロー再生で伸ばす音の用意', () => {
  it('伸ばす区切りの前後を少しだけ足して渡す（音全体をワーカーに置かない）', async () => {
    sounds.set(1, sound('long-a', 200));
    await stretchProvider.request(1, 0.5, 1);
    // 区切り 1 は元の 19.75〜40.25 秒。前後 0.1 秒を足した 19.65〜40.35 秒を渡す
    const [channels, sr, rate, from, to] = vi.mocked(wk.stretch).mock.calls[0];
    expect(channels.map((c) => c.length)).toEqual([20700, 20700]);
    expect([sr, rate, from, to]).toEqual([SR, 0.5, 100, 20600]);
    const got = stretchProvider.get(1, 0.5, 1)!;
    expect(got.fromSec).toBeCloseTo(19.75, 9);
    expect(got.buf.duration).toBeCloseTo(41, 9);
  });

  it('短い SE をいくつ伸ばしても、原曲の伸ばした音は捨てない（持つ量は元の音の長さで数える）', async () => {
    sounds.set(1, sound('long-b', 200));
    await stretchProvider.request(1, 0.5, 0);
    for (let i = 0; i < 40; i++) {
      sounds.set(100 + i, sound(`se-${i}`, 0.5));
      await stretchProvider.request(100 + i, 0.5, 0);
    }
    expect(stretchProvider.get(1, 0.5, 0)).not.toBeNull();
    expect(stretchProvider.get(100, 0.5, 0)).not.toBeNull();
    // 長い区切りは 8 つまで（古いものから捨てる）
    for (let k = 1; k <= 8; k++) await stretchProvider.request(1, 0.5, k);
    expect(stretchProvider.get(1, 0.5, 0)).toBeNull();
    expect(stretchProvider.get(1, 0.5, 8)).not.toBeNull();
  });

  it('始める所で鳴っている曲の音（原曲・SE・ステム）と、すぐ鳴り始める音だけを先に伸ばす', () => {
    sounds.set(1, sound('bgm', 200));
    sounds.set(2, sound('hh', 0.3));
    sounds.set(3, sound('drums', 120));
    sounds.set(4, sound('cue', 0.4));
    sounds.set(5, sound('stem', 200));
    const events = [ev(0, 1, 'bgm'), ev(0, 5, 'stem'), ev(1, 3, 'se'), ev(9.5, 4, 'se'), ev(10.5, 2, 'drum'), ev(10.6, 4, 'se'), ev(12, 4, 'se')];
    // 曲の 10 秒から、1 秒先までに鳴り始める音。鳴り終わった cue（9.5 秒から 0.4 秒）・ドラム・まだ先の音は要らない
    expect([...slowNeeds(events, [10], 1)]).toEqual([
      [1, [10]],
      [5, [10]],
      [3, [9]],
      [4, [0]],
    ]);
    // ループの頭（曲の 0 秒）からも
    expect(slowNeeds(events, [10, 0], 0).get(1)).toEqual([10, 0]);
    // 区切り（20 秒ごと）の終わりのすぐ手前からなら、次の区切りも
    expect(slowNeeds(events, [39.5], 1).get(1)).toEqual([39.5, 40]);
    expect(slowNeeds(events, [38.5], 1).get(1)).toEqual([38.5]);
  });
});
