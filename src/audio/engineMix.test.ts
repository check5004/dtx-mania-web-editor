import { afterEach, describe, expect, it } from 'vitest';
import { engine } from './engine';

const reset = { bgmMute: false, origMute: false, drumMute: false, seMute: false, origSolo: false, drumSolo: false, stemSolo: false, seSolo: false };

describe('SE のトラック（原曲のドラムなどを SE で鳴らす譜面）', () => {
  afterEach(() => engine.setMix(reset));

  it('SE だけを消せる。原曲・譜面の音はそのまま', () => {
    engine.setMix(reset);
    expect(engine.audible()).toMatchObject({ orig: true, chart: true, se: true });
    engine.setMix({ seMute: true });
    expect(engine.audible()).toMatchObject({ orig: true, chart: true, se: false });
  });

  it('SE は曲の音：曲の音をまとめて消すと消える', () => {
    engine.setMix({ ...reset, bgmMute: true });
    expect(engine.audible()).toMatchObject({ orig: false, chart: true, se: false });
  });

  it('ソロはトラックをまたいで効く（譜面の音のソロで SE も止まる・SE のソロで ほかが止まる）', () => {
    engine.setMix({ ...reset, drumSolo: true });
    expect(engine.audible()).toMatchObject({ orig: false, chart: true, se: false });
    engine.setMix({ ...reset, seSolo: true });
    expect(engine.audible()).toMatchObject({ orig: false, chart: false, se: true });
  });
});
