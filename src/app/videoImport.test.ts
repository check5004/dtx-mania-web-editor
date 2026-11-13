// 動画（MP4）を開く・原曲にする流れ：音を取り出した OGG を原曲（#WAV・ch01）にし、新しい譜面では動画を BGA の動画（#AVI01・ch54）にもする。
// 動画から音を取り出す中身（decodeAudioData と OGG）は src/audio/videoAudio.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CH, type DtxDoc } from '../dtx/model';
import { serializeDtx } from '../dtx/serialize';
import { findFile, folderFromFiles } from '../fs/folder';
import type { NewSongInfo } from '../store/editor';

// 画面の大きさ・向きを見る所（store/device）が読むもの。時計は使わない
const noop = () => undefined;
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: noop, addEventListener: noop, removeEventListener: noop, innerWidth: 1280, innerHeight: 800 });
vi.stubGlobal('document', { addEventListener: noop, documentElement: { classList: { toggle: noop }, style: { setProperty: noop } } });

const dlg = vi.hoisted(() => ({
  /** 新しい譜面のダイアログに聞かれたこと */
  asked: null as null | { audioFiles: string[]; movies?: string[]; defaults: Partial<NewSongInfo> },
  /** 新しい譜面のダイアログの答え（聞かれたことから作る） */
  answer: null as null | ((o: { audioFiles: string[]; movies?: string[]; defaults: Partial<NewSongInfo> }) => NewSongInfo | null),
  /** 選ぶダイアログで選ぶもの（value） */
  choose: null as unknown,
  chooseAsked: null as null | { options: { label: string; value: unknown }[] },
}));
vi.mock('../ui/dialogs', () => ({
  newSongDialog: async (o: { audioFiles: string[]; movies?: string[]; defaults: Partial<NewSongInfo> }) => {
    dlg.asked = o;
    return dlg.answer ? dlg.answer(o) : null;
  },
  chooseDialog: async (o: { options: { label: string; value: unknown }[] }) => {
    dlg.chooseAsked = o;
    return dlg.choose;
  },
  confirmDialog: async () => true,
  promptDialog: async () => null,
}));

// おまかせで準備の画面：ふだんは「自分で入れる」を選んだことにする（今までの新しい譜面のダイアログへ進む）
const setupMock = vi.hoisted(() => ({ srcs: [] as unknown[], answer: 'manual' as 'manual' | 'cancel' }));
vi.mock('./setupEntry', async (importOriginal) => {
  const real = await importOriginal<typeof import('./setupEntry')>();
  return {
    ...real,
    offerSetup: async (src: import('./setup').SetupSource) => {
      setupMock.srcs.push(src);
      return setupMock.answer === 'manual' ? { mode: 'manual' as const, src, opts: {} as never } : null;
    },
  };
});

// 動画から音を取り出す（取り出したことにする）
const ex = vi.hoisted(() => ({ calls: [] as string[], ok: true }));
vi.mock('../store/videoExtract', () => ({
  extractWithProgress: async (f: File) => {
    ex.calls.push(f.name);
    return ex.ok ? new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], f.name.replace(/\.[^.]+$/, '') + '.ogg', { type: 'audio/ogg' }) : null;
  },
}));

const { engine } = await import('../audio/engine');
vi.spyOn(engine, 'prepare').mockResolvedValue([]);
vi.spyOn(engine, 'stop').mockImplementation(() => undefined);
const { dropAudioInEditor, importBgmFile, openDroppedFiles, openFolder } = await import('./fileActions');
const { createDoc, openDocument, useEditor } = await import('../store/editor');

const file = (name: string, size = 16) => new File([new Uint8Array(size)], name);
const doc = () => useEditor.getState().doc;
const folderNames = () => [...(useEditor.getState().folder?.files.values() ?? [])].map((f) => f.path).sort();
const chipsOf = (d: DtxDoc, ch: number) => d.chips.filter((c) => c.ch === ch).map((c) => ({ m: c.m, f: c.f, v: c.v }));

describe('動画から新しい譜面を作る', () => {
  beforeEach(() => {
    useEditor.setState({ screen: 'home', folder: null });
    dlg.asked = null;
    dlg.answer = (o) => ({ title: 'MV', artist: '', bpm: 120, bgmFile: o.defaults.bgmFile, movieFile: o.movies?.[0] });
    ex.calls = [];
    ex.ok = true;
    setupMock.srcs = [];
    setupMock.answer = 'manual';
  });

  it('開くと、まずおまかせで準備の画面を出す（閉じたら新しい譜面のダイアログも出さず、何も作らない）', async () => {
    setupMock.answer = 'cancel';
    await openDroppedFiles([file('MV.mp4')]);
    expect(setupMock.srcs).toHaveLength(1);
    expect(setupMock.srcs[0]).toMatchObject({ kind: 'video', title: 'MV' });
    expect(dlg.asked).toBeNull();
    expect(ex.calls).toEqual([]);
    expect(useEditor.getState().screen).toBe('home');
  });

  it('MP4 だけを開くと、音を取り出した OGG を原曲に、動画を BGA の動画（#AVI01・ch54・原曲と同じ所）にする', async () => {
    await openDroppedFiles([file('MV.mp4')]);
    expect(dlg.asked?.audioFiles).toEqual(['MV.mp4']);
    expect(dlg.asked?.movies).toEqual(['MV.mp4']);
    expect(dlg.asked?.defaults.bgmFile).toBe('MV.mp4');
    expect(ex.calls).toEqual(['MV.mp4']);
    const d = doc();
    expect(useEditor.getState().screen).toBe('editor');
    expect(d.fields['WAV01']).toBe('MV.ogg');
    expect(d.fields['BGMWAV']).toBe('01');
    expect(d.fields['AVI01']).toBe('MV.mp4');
    // 選曲画面の試聴も取り出した音（動画ではなく）
    expect(d.fields['PREVIEW']).toBe('MV.ogg');
    expect(chipsOf(d, CH.BGM)).toEqual([{ m: 1, f: { n: 0, d: 1 }, v: 1 }]);
    expect(chipsOf(d, 0x54)).toEqual([{ m: 1, f: { n: 0, d: 1 }, v: 1 }]);
    // 曲フォルダには取り出した OGG と動画（本体へはこの2つを写す）
    expect(folderNames()).toEqual(['MV.mp4', 'MV.ogg']);
    const text = serializeDtx(d);
    expect(text).toContain('#WAV01: MV.ogg');
    expect(text).toContain('#AVI01: MV.mp4');
    expect(text).toMatch(/#00154: 01/);
  });

  it('背景動画にしないなら、動画は曲フォルダに入れない（#AVI も書かない）', async () => {
    dlg.answer = (o) => ({ title: 'MV', artist: '', bpm: 120, bgmFile: o.defaults.bgmFile });
    await openDroppedFiles([file('MV.mp4')]);
    expect(doc().fields['WAV01']).toBe('MV.ogg');
    expect(doc().fields['AVI01']).toBeUndefined();
    expect(chipsOf(doc(), 0x54)).toEqual([]);
    expect(folderNames()).toEqual(['MV.ogg']);
  });

  it('取り出せなかった（やめた・読めない）ら、譜面を作らない', async () => {
    ex.ok = false;
    await openDroppedFiles([file('MV.mp4')]);
    expect(useEditor.getState().screen).toBe('home');
  });

  it('音声ファイルと動画を一緒に開くと、原曲は音声ファイル（取り出さない）、動画は BGA の動画に', async () => {
    await openDroppedFiles([file('MV.mp4'), file('song.ogg')]);
    expect(dlg.asked?.audioFiles).toEqual(['song.ogg', 'MV.mp4']);
    expect(dlg.asked?.defaults.bgmFile).toBe('song.ogg');
    expect(ex.calls).toEqual([]);
    expect(doc().fields['WAV01']).toBe('song.ogg');
    expect(doc().fields['AVI01']).toBe('MV.mp4');
  });

  it('同じ名前の音声ファイルがあれば、取り出した音は別の名前にする', async () => {
    dlg.answer = (o) => ({ title: 'MV', artist: '', bpm: 120, bgmFile: 'MV.mp4', movieFile: o.movies?.[0] });
    await openDroppedFiles([file('MV.mp4'), file('MV.ogg', 99)]);
    expect(doc().fields['WAV01']).toBe('MV (2).ogg');
    expect(folderNames()).toEqual(['MV (2).ogg', 'MV.mp4', 'MV.ogg']);
  });

  it('NX（Shift_JIS）で読めない名前の動画は、読める名前にして置く（取り出した音の名前も）', async () => {
    await openDroppedFiles([file('Café.mp4')]);
    expect(dlg.asked?.audioFiles).toEqual(['Cafe.mp4']);
    expect(ex.calls).toEqual(['Cafe.mp4']);
    expect(doc().fields['WAV01']).toBe('Cafe.ogg');
    expect(doc().fields['AVI01']).toBe('Cafe.mp4');
    expect(folderNames()).toEqual(['Cafe.mp4', 'Cafe.ogg']);
  });

  it('DTX の無い曲フォルダに動画だけ：音を取り出して原曲に（フォルダの動画は消さない）', async () => {
    const folder = folderFromFiles([file('bg.mp4'), file('jacket.png')], '新しい曲');
    dlg.answer = (o) => ({ title: 'x', artist: '', bpm: 150, bgmFile: o.audioFiles[0], movieFile: undefined });
    await openFolder(folder);
    expect(dlg.asked?.audioFiles).toEqual(['bg.mp4']);
    expect(doc().fields['WAV01']).toBe('bg.ogg');
    expect(findFile(folder, 'bg.ogg')).toBeTruthy();
    expect(findFile(folder, 'bg.mp4')).toBeTruthy();
  });
});

describe('編集中の譜面の原曲を動画から', () => {
  beforeEach(() => {
    const d = createDoc({ title: 'テスト', artist: '', bpm: 120 });
    openDocument(d, { fileName: 'mstr.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] }, folderFromFiles([], 'テスト'));
    ex.calls = [];
    ex.ok = true;
  });

  it('原曲の読み込み・差し替えに動画を選ぶと、取り出した OGG を原曲にする（BGA は変えない）', async () => {
    await importBgmFile(file('MV.mp4'));
    expect(ex.calls).toEqual(['MV.mp4']);
    expect(doc().fields['WAV01']).toBe('MV.ogg');
    expect(chipsOf(doc(), CH.BGM)).toHaveLength(1);
    expect(doc().fields['AVI01']).toBeUndefined();
    expect(folderNames()).toEqual(['MV.ogg']);
  });

  it('取り出せなければ、原曲は変えない', async () => {
    ex.ok = false;
    await importBgmFile(file('MV.mp4'));
    expect(doc().fields['WAV01']).toBeUndefined();
  });

  it('編集中に動画を落とすと、原曲にするか新しい譜面にするかを聞く', async () => {
    dlg.choose = 'bgm';
    await dropAudioInEditor([file('MV.mp4')]);
    expect(dlg.chooseAsked?.options.map((o) => o.value)).toEqual(['bgm', 'new']);
    expect(dlg.chooseAsked?.options[0].label).toBe('音を取り出して原曲にする（おすすめ）');
    expect(doc().fields['WAV01']).toBe('MV.ogg');
  });
});
