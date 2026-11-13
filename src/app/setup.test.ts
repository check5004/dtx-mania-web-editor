// おまかせで準備：何から始めるかの決め方（原曲・動画・分けてあるステム）と、やめたとき・続けられないときの片付け。
// 各項目の中身（テンポの推定・サビ探し・ステム分解・採譜）はそれぞれのテストで。通しは Chrome で確かめる
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupOptions } from './setup';

const noop = () => undefined;
vi.stubGlobal('window', {
  setTimeout: () => 0,
  clearTimeout: noop,
  setInterval: (f: () => void, t: number) => setInterval(f, t),
  clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
  addEventListener: noop,
  removeEventListener: noop,
  innerWidth: 1280,
  innerHeight: 800,
});
vi.stubGlobal('document', { addEventListener: noop, documentElement: { classList: { toggle: noop }, style: { setProperty: noop } } });

// 試聴（サビ探し）は、テストが終わらせるまで待たせる
const pv = vi.hoisted(() => ({ calls: 0, resolve: null as null | ((v: { file: string; start: number; end: number } | null) => void) }));
vi.mock('../store/chorus', async (orig) => ({
  ...(await orig<typeof import('../store/chorus')>()),
  makeChorusPreview: () => {
    pv.calls++;
    return new Promise((r) => (pv.resolve = r));
  },
}));

// 動画から音を取り出す（取り出したことにする・無音にする）
const vx = vi.hoisted(() => ({ result: 'ok' as 'ok' | 'silent' }));
vi.mock('../audio/videoAudio', async (orig) => ({
  ...(await orig<typeof import('../audio/videoAudio')>()),
  extractVideoAudio: async (f: File) =>
    vx.result === 'ok' ? { file: new File([new Uint8Array(4)], f.name.replace(/\.[^.]+$/, '.ogg'), { type: 'audio/ogg' }), seconds: 60 } : { error: 'silent' as const },
}));

// 保存は本体（OPFS）を使うので、呼んだかだけ見る
const fa = vi.hoisted(() => ({ saved: 0, holds: [] as boolean[] }));
vi.mock('./fileActions', async (orig) => {
  const m = await orig<typeof import('./fileActions')>();
  return {
    ...m,
    saveAfterSetup: async () => {
      fa.saved++;
      return true;
    },
    autosaveNow: async () => undefined,
    holdAutosave: (on: boolean) => {
      fa.holds.push(on);
      m.holdAutosave(on);
    },
  };
});

const { engine } = await import('../audio/engine');
vi.spyOn(engine, 'prepare').mockResolvedValue([]);
vi.spyOn(engine, 'stop').mockImplementation(() => undefined);
const { cancelSetup, clock, plannedSteps, runSetup, setupSourceOf, useSetup } = await import('./setup');
const { useEditor } = await import('../store/editor');

const file = (name: string, size = 16) => new File([new Uint8Array(size)], name);
const moises = (title: string, parts: string[]) => parts.map((p) => file(`${title}.m4a_${p}_mixed.mp3`));
const ONLY_PREVIEW: SetupOptions = { info: false, ai: false, tempo: false, preview: true, separate: false, drums: false, difficulty: 'MASTER' };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('何から始めるか', () => {
  it('原曲 1 つ・動画・音と動画', () => {
    expect(setupSourceOf([file('Neon Skyline.ogg')])).toMatchObject({ kind: 'audio', title: 'Neon Skyline', movie: null, stems: [] });
    const v = setupSourceOf([file('Neon Skyline (MV).mp4')])!;
    expect(v).toMatchObject({ kind: 'video', title: 'Neon Skyline (MV)' });
    expect(v.original?.name).toBe('Neon Skyline (MV).mp4');
    const both = setupSourceOf([file('MV.mp4'), file('song.mp3')])!;
    expect(both.kind).toBe('audio');
    expect(both.original?.name).toBe('song.mp3');
    expect(both.movie?.name).toBe('MV.mp4');
    expect(setupSourceOf([file('notes.txt')])).toBeNull();
  });

  it('Moises のステム：原曲は一緒にあれば使い、メトロノームは使わない', () => {
    const parts = ['キック', 'スネア', 'ハイハット', 'ベース', 'ボーカル1', 'テルミン', 'メトロノーム'];
    const s = setupSourceOf([file('Neon Skyline.m4a'), ...moises('Neon Skyline', parts)])!;
    expect(s.kind).toBe('stems');
    expect(s.original?.name).toBe('Neon Skyline.m4a');
    expect(s.title).toBe('Neon Skyline');
    expect(s.stems.map((x) => `${x.kind}:${x.name}${x.known ? '' : '?'}`)).toEqual(['drums:キック', 'drums:スネア', 'drums:ハイハット', 'bass:ベース', 'vocals:ボーカル1', 'other:テルミン?']);
    expect(s.unused.map((x) => x.name)).toEqual(['メトロノーム']);
    // 原曲が無くても、曲名はステムの名前から
    const alone = setupSourceOf(moises('Neon Skyline', parts))!;
    expect(alone).toMatchObject({ kind: 'stems', original: null, title: 'Neon Skyline' });
  });

  it('やることの順：ステムから始めるならステム分解はしない', () => {
    const all: SetupOptions = { info: true, ai: true, tempo: true, preview: true, separate: true, drums: true, difficulty: 'MASTER' };
    expect(plannedSteps({ kind: 'video' }, all)).toEqual(['video', 'info', 'tempo', 'preview', 'separate', 'drums']);
    expect(plannedSteps({ kind: 'stems' }, all)).toEqual(['stems', 'info', 'tempo', 'preview', 'drums']);
    expect(plannedSteps({ kind: 'audio' }, { ...all, info: false, separate: false })).toEqual(['tempo', 'preview', 'drums']);
  });

  it('時刻の書き方', () => {
    expect(clock(1.395)).toBe('0:01.395');
    expect(clock(83.7)).toBe('1:23.700');
  });
});

describe('準備の流れ', () => {
  beforeEach(() => {
    useEditor.setState({ screen: 'home', folder: null });
    useSetup.setState({ status: 'idle', steps: [], error: null, ready: null });
    pv.calls = 0;
    pv.resolve = null;
    vx.result = 'ok';
    fa.saved = 0;
    fa.holds = [];
  });

  it('終わると譜面を開いたまま保存し、結果を並べる', async () => {
    const run = runSetup(setupSourceOf([file('Neon Skyline.ogg')])!, ONLY_PREVIEW);
    for (let i = 0; i < 20 && !pv.resolve; i++) await tick();
    expect(useSetup.getState().status).toBe('running');
    expect(useEditor.getState().screen).toBe('editor');
    expect(useEditor.getState().meta.fileName).toBe('mstr.dtx');
    expect(useEditor.getState().doc.fields['WAV01']).toBe('Neon Skyline.ogg');
    pv.resolve!({ file: 'preview_chorus.ogg', start: 61.5, end: 76.5 });
    expect(await run).toBe(true);
    const s = useSetup.getState();
    expect(s.status).toBe('done');
    expect(s.steps).toEqual([expect.objectContaining({ id: 'preview', state: 'done', note: expect.stringContaining('1:01.500') })]);
    expect(fa.saved).toBe(1);
    // 準備の間は自動保存を止め、終わったら戻す
    expect(fa.holds[0]).toBe(true);
    expect(fa.holds[fa.holds.length - 1]).toBe(false);
  });

  it('やめると、何も保存せずにホームに戻る', async () => {
    const run = runSetup(setupSourceOf([file('Neon Skyline.ogg')])!, ONLY_PREVIEW);
    for (let i = 0; i < 20 && !pv.resolve; i++) await tick();
    expect(useEditor.getState().screen).toBe('editor');
    cancelSetup();
    expect(useSetup.getState().status).toBe('idle');
    expect(useEditor.getState().screen).toBe('home');
    expect(useEditor.getState().folder).toBeNull();
    // 遅れて終わった項目は、ホームの譜面に何も入れない
    pv.resolve!({ file: 'preview_chorus.ogg', start: 1, end: 16 });
    expect(await run).toBe(false);
    expect(fa.saved).toBe(0);
    expect(fa.holds[fa.holds.length - 1]).toBe(false);
    expect(useEditor.getState().screen).toBe('home');
  });

  it('動画に音が無ければ、譜面を作らずに理由を出す', async () => {
    vx.result = 'silent';
    expect(await runSetup(setupSourceOf([file('MV.mp4')])!, ONLY_PREVIEW)).toBe(false);
    const s = useSetup.getState();
    expect(s.status).toBe('error');
    expect(s.error).toContain('MV.mp4');
    expect(useEditor.getState().screen).toBe('home');
    expect(pv.calls).toBe(0);
    expect(fa.saved).toBe(0);
  });
});
