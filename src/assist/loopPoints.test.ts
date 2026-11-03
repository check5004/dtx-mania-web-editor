import { describe, expect, it } from 'vitest';
import { grabLoop, placeLoopPoint, type LoopPoints } from './loopPoints';

const none: LoopPoints = { loop: null, mark: null };

describe('placeLoopPoint', () => {
  it('sets only A until B is set', () => {
    expect(placeLoopPoint(none, 'a', 16)).toEqual({ loop: null, mark: { side: 'a', beat: 16 } });
  });

  it('sets only B until A is set', () => {
    expect(placeLoopPoint(none, 'b', 24)).toEqual({ loop: null, mark: { side: 'b', beat: 24 } });
  });

  it('makes the loop when the other side is set', () => {
    const a = placeLoopPoint(none, 'a', 16);
    expect(placeLoopPoint(a, 'b', 24)).toEqual({ loop: { on: true, a: 16, b: 24 }, mark: null });
    const b = placeLoopPoint(none, 'b', 24);
    expect(placeLoopPoint(b, 'a', 16)).toEqual({ loop: { on: true, a: 16, b: 24 }, mark: null });
  });

  it('moves the same side again', () => {
    const a = placeLoopPoint(none, 'a', 16);
    expect(placeLoopPoint(a, 'a', 20)).toEqual({ loop: null, mark: { side: 'a', beat: 20 } });
  });

  it('keeps only the new point when it cannot make a range', () => {
    const a = placeLoopPoint(none, 'a', 16);
    // B が A と同じか前：A は消して B だけ
    expect(placeLoopPoint(a, 'b', 16)).toEqual({ loop: null, mark: { side: 'b', beat: 16 } });
    expect(placeLoopPoint(a, 'b', 8)).toEqual({ loop: null, mark: { side: 'b', beat: 8 } });
    const b = placeLoopPoint(none, 'b', 16);
    expect(placeLoopPoint(b, 'a', 20)).toEqual({ loop: null, mark: { side: 'a', beat: 20 } });
  });

  it('moves one end of a loop and keeps the other', () => {
    const cur: LoopPoints = { loop: { on: false, a: 16, b: 32 }, mark: null };
    expect(placeLoopPoint(cur, 'a', 20)).toEqual({ loop: { on: true, a: 20, b: 32 }, mark: null });
    expect(placeLoopPoint(cur, 'a', 4)).toEqual({ loop: { on: true, a: 4, b: 32 }, mark: null });
    expect(placeLoopPoint(cur, 'b', 24)).toEqual({ loop: { on: true, a: 16, b: 24 }, mark: null });
  });

  it('does not add the other end of a loop by itself', () => {
    const cur: LoopPoints = { loop: { on: true, a: 16, b: 32 }, mark: null };
    // A を B 以降に置いたら、B は消して A だけ（以前は B を1小節後ろに作っていた）
    expect(placeLoopPoint(cur, 'a', 40)).toEqual({ loop: null, mark: { side: 'a', beat: 40 } });
    expect(placeLoopPoint(cur, 'a', 32)).toEqual({ loop: null, mark: { side: 'a', beat: 32 } });
    expect(placeLoopPoint(cur, 'b', 8)).toEqual({ loop: null, mark: { side: 'b', beat: 8 } });
  });

  it('does not go before the song', () => {
    expect(placeLoopPoint(none, 'a', -2)).toEqual({ loop: null, mark: { side: 'a', beat: 0 } });
  });
});

describe('grabLoop', () => {
  const loop: LoopPoints = { loop: { on: true, a: 16, b: 32 }, mark: null };

  it('finds the ends, the inside and the outside', () => {
    expect(grabLoop(loop, 16.2, 0.5)).toBe('a');
    expect(grabLoop(loop, 31.7, 0.5)).toBe('b');
    expect(grabLoop(loop, 24, 0.5)).toBe('move');
    expect(grabLoop(loop, 40, 0.5)).toBe('new');
    expect(grabLoop(none, 16, 0.5)).toBe('new');
  });

  it('grabs the tab outside the line (A before, B after)', () => {
    expect(grabLoop(loop, 15, 0.5, 1.5)).toBe('a');
    expect(grabLoop(loop, 33, 0.5, 1.5)).toBe('b');
    // 線の内側は tol まで
    expect(grabLoop(loop, 17, 0.5, 1.5)).toBe('move');
    expect(grabLoop(loop, 13, 0.5, 1.5)).toBe('new');
  });

  it('grabs the single mark', () => {
    const a: LoopPoints = { loop: null, mark: { side: 'a', beat: 16 } };
    expect(grabLoop(a, 16.3, 0.5)).toBe('mark');
    expect(grabLoop(a, 15, 0.5, 1.5)).toBe('mark');
    expect(grabLoop(a, 17, 0.5, 1.5)).toBe('new');
    const b: LoopPoints = { loop: null, mark: { side: 'b', beat: 16 } };
    expect(grabLoop(b, 17, 0.5, 1.5)).toBe('mark');
    expect(grabLoop(b, 15, 0.5, 1.5)).toBe('new');
  });
});
