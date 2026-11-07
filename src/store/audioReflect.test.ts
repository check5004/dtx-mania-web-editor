// ステムの画面で書き出した音を、エディタ（譜面）の BGM・試聴（#PREVIEW）に反映する・元に戻す。
// 反映したかは譜面の中身で見る（元に戻す・Ctrl+Z で外れたら ✓ を出さない）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';

// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0 });

const { undo, useEditor } = await import('./editor');
const { audioReflected, registerExport, undoAudioReflect, useStems } = await import('./stems');

const chip = (id: number, ch: number, m: number, v = 1) => ({ id, ch, m, f: { n: 0, d: 1 }, v });

function song(withBgm: boolean): DtxDoc {
  const chips = [chip(1, CH.BD, 1), chip(2, CH.SD, 1)];
  if (withBgm) chips.push(chip(3, CH.BGM, 0, 1));
  return { ...emptyDoc(), fields: withBgm ? { TITLE: 'テスト', WAV01: 'bgm.ogg' } : { TITLE: 'テスト' }, chips, nextId: 4 };
}

function open(doc: DtxDoc) {
  useStems.setState({ reflected: { bgm: null, preview: null } });
  useEditor.setState({ doc, past: [], future: [] });
}

const doc = () => useEditor.getState().doc;

describe('書き出した音をエディタの BGM に反映する', () => {
  beforeEach(() => open(song(true)));

  it('BGM の #WAV を差し替え、元に戻すと前のファイルに戻る', () => {
    expect(registerExport('bgm_drumless.ogg', 'bgm')).toBe('bgm.ogg');
    expect(doc().fields.WAV01).toBe('bgm_drumless.ogg');
    expect(audioReflected('bgm')).toMatchObject({ file: 'bgm_drumless.ogg', prev: 'bgm.ogg', wav: 1 });

    undoAudioReflect('bgm');
    expect(doc().fields.WAV01).toBe('bgm.ogg');
    expect(audioReflected('bgm')).toBeNull();
    expect(doc().chips.filter((c) => c.ch === CH.BGM)).toHaveLength(1);
  });

  it('Ctrl+Z で譜面が戻ったら、反映済みとは出さない', () => {
    registerExport('bgm_drumless.ogg', 'bgm');
    undo();
    expect(doc().fields.WAV01).toBe('bgm.ogg');
    expect(audioReflected('bgm')).toBeNull();
  });

  it('同じファイルに書き出し直しても、元に戻す先は最初の BGM のまま', () => {
    registerExport('bgm_drumless.ogg', 'bgm');
    expect(registerExport('bgm_drumless.ogg', 'bgm')).toBe('bgm.ogg');
    undoAudioReflect('bgm');
    expect(doc().fields.WAV01).toBe('bgm.ogg');
  });

  it('BGM が無い譜面では、空いている #WAV と 001小節の BGM チップを置き、元に戻すと両方消す', () => {
    open(song(false));
    expect(registerExport('bgm_drumless.ogg', 'bgm')).toBeNull();
    const bgm = doc().chips.find((c) => c.ch === CH.BGM)!;
    expect(bgm.m).toBe(1);
    expect(doc().fields['WAV' + String(bgm.v).padStart(2, '0')]).toBe('bgm_drumless.ogg');
    undoAudioReflect('bgm');
    expect(doc().chips.some((c) => c.ch === CH.BGM)).toBe(false);
    expect(Object.keys(doc().fields).filter((k) => k.startsWith('WAV'))).toEqual([]);
  });
});

describe('書き出した音を選曲画面の試聴（#PREVIEW）に反映する', () => {
  beforeEach(() => open(song(true)));

  it('無かった #PREVIEW を置き、元に戻すと消す', () => {
    expect(registerExport('preview.ogg', 'preview')).toBeNull();
    expect(doc().fields.PREVIEW).toBe('preview.ogg');
    expect(audioReflected('preview')).toMatchObject({ file: 'preview.ogg', prev: null });
    undoAudioReflect('preview');
    expect(doc().fields.PREVIEW).toBeUndefined();
    expect(audioReflected('preview')).toBeNull();
  });

  it('前の #PREVIEW があれば、元に戻すとそれに戻る', () => {
    useEditor.setState({ doc: { ...doc(), fields: { ...doc().fields, PREVIEW: 'old.ogg' } } });
    registerExport('preview.ogg', 'preview');
    undoAudioReflect('preview');
    expect(doc().fields.PREVIEW).toBe('old.ogg');
  });
});
