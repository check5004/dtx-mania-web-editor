// 保存していない変更：譜面（履歴の名前）と作業ファイル（変えたもの）を合わせて見せる。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';

vi.stubGlobal('window', { setTimeout: () => 0 });

const { edit, undo, useEditor } = await import('./editor');
const { loadSidecar, markSidecarSaved, setSection, useSidecar } = await import('./sidecar');
const { hasUnsaved, unsavedOf, unsavedText } = await import('./unsaved');

const now = () => unsavedOf(useEditor.getState(), useSidecar.getState());

function song(): DtxDoc {
  return { ...emptyDoc(), fields: { TITLE: 'テスト', BPM: '120' }, chips: [{ id: 1, ch: CH.BD, m: 1, f: { n: 0, d: 1 }, v: 1 }], nextId: 2 };
}

/** 保存したことにする（fileActions の markSaved と同じ） */
function save() {
  useEditor.setState((s) => ({ savedDoc: s.doc, savedHistory: s.past.length }));
  markSidecarSaved();
}

describe('保存していない変更', () => {
  beforeEach(() => {
    const doc = song();
    useEditor.setState({ doc, savedDoc: doc, savedHistory: 0, past: [], future: [] });
    loadSidecar(null);
  });

  it('開いたばかりは無し', () => {
    expect(now()).toBeNull();
    expect(hasUnsaved()).toBe(false);
  });

  it('譜面の変更は履歴の名前を新しい順に。保存すると消え、保存のあとの変更だけを数える', () => {
    edit('A', (d) => void (d.fields.ARTIST = 'a'));
    edit('B', (d) => void (d.fields.ARTIST = 'b'));
    expect(now()).toEqual({ chart: { labels: ['B', 'A'], undone: 0 }, work: null });
    expect(unsavedText(now()!)).toBe('譜面（B ほか1件）');
    save();
    expect(now()).toBeNull();
    edit('C', (d) => void (d.fields.ARTIST = 'c'));
    expect(now()?.chart?.labels).toEqual(['C']);
  });

  it('保存したあとに元に戻すと「元に戻した変更」', () => {
    edit('A', (d) => void (d.fields.ARTIST = 'a'));
    save();
    undo();
    expect(now()).toEqual({ chart: { labels: [], undone: 1 }, work: null });
    expect(unsavedText(now()!)).toBe('譜面（元に戻した変更）');
  });

  it('作業ファイルだけの変更も数え、何を変えたかを出す（聴く音量は数えない）', () => {
    useSidecar.setState({ mix: { bgm: 0.5 } as never });
    expect(hasUnsaved()).toBe(false);
    setSection(4, 'サビ');
    expect(hasUnsaved()).toBe(true);
    expect(now()).toEqual({ chart: null, work: ['セクション'] });
    edit('A', (d) => void (d.fields.ARTIST = 'a'));
    expect(unsavedText(now()!)).toBe('譜面（A） · 作業ファイル（セクション）');
    save();
    expect(now()).toBeNull();
  });
});
