import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../audio/engine';
import { playAudition, stopAudition, toggleAudition, useAudition, type AuditionSound } from './audition';

// node には AudioContext が無いので、engine の試聴を置き換える（鳴っている音を1つだけ持つ）
let playing: { name: string; onEnd?: () => void } | null = null;

const snd = (name: string): AuditionSound => ({ buf: { name } as unknown as AudioBuffer });

beforeEach(() => {
  playing = null;
  vi.spyOn(engine, 'ensure').mockReturnValue({} as AudioContext);
  vi.spyOn(engine, 'stopAudition').mockImplementation(() => {
    const p = playing;
    if (!p) return false;
    playing = null;
    p.onEnd?.();
    return true;
  });
  vi.spyOn(engine, 'audition').mockImplementation((buf, _volume, _pan, _gain, onEnd) => {
    engine.stopAudition();
    playing = { name: (buf as unknown as { name: string }).name, onEnd };
    return 120;
  });
  stopAudition();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('試聴の ▶／■（WAV・キット・ライブラリ）', () => {
  it('▶ で鳴らし、鳴っている間は ■。もう一度押すと止まる', async () => {
    expect(await toggleAudition('wav:33', () => snd('bgm'))).toBe(true);
    expect(useAudition.getState()).toMatchObject({ key: 'wav:33', duration: 120 });
    expect(playing?.name).toBe('bgm');
    expect(await toggleAudition('wav:33', () => snd('bgm'))).toBe(false);
    expect(useAudition.getState().key).toBeNull();
    expect(playing).toBeNull();
  });

  it('別の ▶ を押すと前の試聴（原曲など）を止めて、押した音だけ鳴らす', async () => {
    await toggleAudition('wav:33', () => snd('bgm'));
    await toggleAudition('wav:1', () => snd('kick'));
    expect(useAudition.getState().key).toBe('wav:1');
    expect(playing?.name).toBe('kick');
  });

  it('鳴り終わると ▶ に戻る', async () => {
    await playAudition('kit:17', () => snd('hh'));
    const end = playing!.onEnd!;
    playing = null;
    end();
    expect(useAudition.getState().key).toBeNull();
  });

  it('曲の再生などで engine が試聴を止めても ▶ に戻る', async () => {
    await playAudition('wav:33', () => snd('bgm'));
    engine.stopAudition();
    expect(useAudition.getState().key).toBeNull();
  });

  it('読み込みを待つ間も ■。その間に止めたら、読み込めても鳴らさない', async () => {
    let done!: (v: AuditionSound) => void;
    const p = playAudition('wav:33', () => new Promise<AuditionSound>((r) => (done = r)));
    expect(useAudition.getState()).toMatchObject({ key: 'wav:33', since: 0 });
    expect(stopAudition()).toBe(true);
    done(snd('bgm'));
    expect(await p).toBe(false);
    expect(playing).toBeNull();
    expect(useAudition.getState().key).toBeNull();
  });

  it('読み込みを待つ間に別の ▶ を押したら、あとから押した音だけ鳴らす', async () => {
    let done!: (v: AuditionSound) => void;
    const first = playAudition('wav:33', () => new Promise<AuditionSound>((r) => (done = r)));
    await playAudition('wav:1', () => snd('kick'));
    done(snd('bgm'));
    expect(await first).toBe(false);
    expect(playing?.name).toBe('kick');
    expect(useAudition.getState().key).toBe('wav:1');
  });

  it('読めない音は ▶ のまま', async () => {
    expect(await playAudition('wav:2', () => null)).toBe(false);
    expect(useAudition.getState().key).toBeNull();
  });

  it('止める物が無いときの Esc は何もしない（ほかの Esc の働きに回す）', () => {
    expect(stopAudition()).toBe(false);
  });
});
