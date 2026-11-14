// 保存・書き出しの前に、譜面に書くファイル名を NX（Shift_JIS）で読める名前にする。試聴（#PREVIEW）は原曲についてくる・空なら入れる。
// 完全な原曲（ステムに分ける前のドラム入りの原曲）を覚えて、分け直す元にする。作業ファイルは新しい自動保存の控えから読む。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../audio/engine';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import { parseDtx } from '../dtx/parse';
import { setField } from '../edit/ops';
import { findFile, folderFromFiles, type FolderFile, type SongFolder } from '../fs/folder';
import type { RecentEntry } from '../fs/recent';

// トーストが消える・光らせるのをやめる時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });

// 自動保存の控え（IndexedDB の代わり）
const recent = vi.hoisted(() => new Map<string, RecentEntry>());
vi.mock('../fs/recent', async (orig) => {
  const real = await orig<typeof import('../fs/recent')>();
  return {
    ...real,
    getRecent: async (id: string) => recent.get(id),
    putRecent: async (e: RecentEntry) => void recent.set(e.id, e),
    draftFor: async (folder: SongFolder, file: FolderFile) => {
      const e = recent.get(real.recentIdFor(folder, file.name));
      if (!e || e.saved) return undefined;
      return e.updatedAt >= (await file.getFile()).lastModified ? e : undefined;
    },
  };
});
vi.mock('../ui/dialogs', () => ({ chooseDialog: async () => null, confirmDialog: async () => true }));
// 画面の大きさを見張る仕組み（node には画面が無い）
vi.mock('./device', () => ({ IS_IOS: false }));
// 分解のワーカー（ここでは分けない）
vi.mock('../separate/client', () => ({
  clearSavedModels: async () => undefined,
  decodeForSeparation: async () => null,
  savedModels: async () => [],
  separate: async () => null,
  SeparateError: class extends Error {},
  webgpuStatus: async () => ({ ok: false }),
}));

const { edit, redo, undo, useEditor } = await import('./editor');
const { fixNxFileNames } = await import('./nxNames');
const { fillPreview, planBgmSwap, fullOriginal } = await import('./fullMix');
const { editBgm, siblingWrites } = await import('./songBgm');
const { loadSidecar, emptySidecar, serializeSidecar, useSidecar } = await import('./sidecar');
const { sidecarUnsaved } = await import('../fs/recent');
const { readSidecarFor, recentSidecarOf } = await import('./sidecarFile');
const { separationSource, separationSources } = await import('./separate');

const chart = (lines: string[]) => [...lines, '#WAV02: hh.wav', '', '#00101: 01', '#00111: 02020202'].join('\r\n');
const sjis = (name: string, text: string) => new File([encodeDtx(text, 'shift_jis').bytes as Uint8Array<ArrayBuffer>], name);
const audio = (name: string, size = 16) => new File([new Uint8Array(size)], name);

/** 曲を開く（current の譜面を開いている。譜面のファイルは Shift_JIS で保存してある＝書けない文字は「?」） */
function openSong(charts: Record<string, string>, files: File[], current = 'mstr.dtx'): SongFolder {
  const folder = folderFromFiles([...Object.entries(charts).map(([n, t]) => sjis(n, t)), ...files], 'song');
  const doc = parseDtx(charts[current]).doc;
  const label: Record<string, string> = { 'mstr.dtx': 'MASTER', 'adv.dtx': 'ADVANCED' };
  useEditor.setState({
    screen: 'editor',
    page: 'chart',
    doc,
    savedDoc: doc,
    savedHistory: 0,
    folder,
    past: [],
    future: [],
    meta: { fileName: current, encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: Object.keys(charts).map((f) => ({ file: f, label: label[f] ?? f })) },
  });
  loadSidecar(null);
  return folder;
}

async function onDisk(folder: SongFolder, name: string) {
  const bytes = new Uint8Array(await (await findFile(folder, name)!.getFile()).arrayBuffer());
  return parseDtx(decodeDtx(bytes).text).doc;
}

beforeEach(() => {
  recent.clear();
  vi.restoreAllMocks();
  vi.spyOn(engine, 'prepare').mockResolvedValue([]);
});

describe('保存の前に、譜面に書くファイル名を NX で読める名前にする', () => {
  const mstr = chart(['#TITLE: テスト', '#BPM: 120', '#PREVIEW: Love♡song.ogg', '#WAV01: Love♡song.ogg']);

  it('曲フォルダのファイルの名前を変え、開いている譜面・ほかの難易度の譜面（「?」になっていた）・作業ファイルを新しい名前にする', async () => {
    const folder = openSong({ 'mstr.dtx': mstr, 'adv.dtx': mstr }, [audio('Love♡song.ogg'), audio('hh.wav')]);
    // 前に保存した ADVANCED は「?」になっている
    expect((await onDisk(folder, 'adv.dtx')).fields.WAV01).toBe('Love?song.ogg');
    loadSidecar({ ...emptySidecar(), fullMix: 'Love♡song.ogg' });

    const rep = await fixNxFileNames({ quiet: true });
    expect(rep).toMatchObject({ renamed: [{ from: 'Love♡song.ogg', to: 'Love_song.ogg' }], failed: [] });
    expect(findFile(folder, 'Love_song.ogg')?.name).toBe('Love_song.ogg');
    expect(folder.files.has('love♡song.ogg')).toBe(false);

    const s = useEditor.getState();
    expect(s.doc.fields).toMatchObject({ WAV01: 'Love_song.ogg', PREVIEW: 'Love_song.ogg' });
    // 名前を変えただけでは未保存にしない
    expect(s.savedDoc).toBe(s.doc);
    expect((await onDisk(folder, 'adv.dtx')).fields).toMatchObject({ WAV01: 'Love_song.ogg', PREVIEW: 'Love_song.ogg' });
    expect((await onDisk(folder, 'mstr.dtx')).fields.WAV01).toBe('Love_song.ogg');
    expect(useSidecar.getState().fullMix).toBe('Love_song.ogg');

    // もう直すものは無い
    expect(await fixNxFileNames({ quiet: true })).toBeNull();
  });

  it('元に戻す・やり直すでも、もう無い名前には戻らない', async () => {
    openSong({ 'mstr.dtx': chart(['#TITLE: テスト', '#BPM: 120', '#WAV01: Love♡song.ogg']) }, [audio('Love♡song.ogg'), audio('hh.wav')]);
    edit('試聴を入れる', (d) => void setField(d, 'PREVIEW', 'Love♡song.ogg'));
    await fixNxFileNames({ quiet: true });
    expect(useEditor.getState().doc.fields.PREVIEW).toBe('Love_song.ogg');
    undo();
    expect(useEditor.getState().doc.fields.PREVIEW).toBeUndefined();
    redo();
    expect(useEditor.getState().doc.fields.PREVIEW).toBe('Love_song.ogg');
  });

  it('同じ名前のファイルがあれば番号を付け、ほかの難易度の作業ファイルの完全な原曲も直す', async () => {
    const side = new File([serializeSidecar({ ...emptySidecar(), fullMix: 'Love♡song.ogg' })], 'adv.dtxe.json');
    const folder = openSong({ 'mstr.dtx': mstr, 'adv.dtx': mstr }, [audio('Love♡song.ogg', 32), audio('Love_song.ogg'), audio('hh.wav'), side]);
    const rep = await fixNxFileNames({ quiet: true });
    expect(rep?.renamed).toEqual([{ from: 'Love♡song.ogg', to: 'Love_song (2).ogg' }]);
    expect(findFile(folder, 'Love_song (2).ogg')?.size).toBe(32);
    expect(findFile(folder, 'Love_song.ogg')?.size).toBe(16);
    const adv = JSON.parse(await (await findFile(folder, 'adv.dtxe.json')!.getFile()).text());
    expect(adv.fullMix).toBe('Love_song (2).ogg');
  });

  it('「〜」は「～」の名前にして、譜面の書き方はそのまま', async () => {
    const folder = openSong({ 'mstr.dtx': chart(['#TITLE: テスト', '#BPM: 120', '#WAV01: A～B.ogg']) }, [audio('A〜B.ogg'), audio('hh.wav')]);
    const rep = await fixNxFileNames({ quiet: true });
    expect(rep?.renamed).toEqual([{ from: 'A〜B.ogg', to: 'A～B.ogg' }]);
    expect(useEditor.getState().doc.fields.WAV01).toBe('A～B.ogg');
    expect(findFile(folder, 'A～B.ogg')?.name).toBe('A～B.ogg');
  });

  it('ほかの曲も入ったフォルダ（DTXFiles など）の中は書き換えない（保存では、この曲だけのフォルダへ移してから直す）', async () => {
    const folder = openSong({ 'mstr.dtx': mstr }, [audio('Love♡song.ogg'), audio('hh.wav')]);
    folder.dir = {} as FileSystemDirectoryHandle;
    folder.files.set('other/x.dtx', { path: 'other/x.dtx', name: 'x.dtx', size: 1, getFile: async () => new File(['#TITLE: x'], 'x.dtx') });
    expect(await fixNxFileNames({ quiet: true })).toBeNull();
    expect(findFile(folder, 'Love♡song.ogg')?.name).toBe('Love♡song.ogg');
    expect(useEditor.getState().doc.fields.WAV01).toBe('Love♡song.ogg');
  });
});

describe('試聴（#PREVIEW）は原曲についてくる', () => {
  const songWith = (preview: string | null) =>
    openSong(
      { 'mstr.dtx': chart(['#TITLE: テスト', '#BPM: 120', ...(preview ? [`#PREVIEW: ${preview}`] : []), '#WAV01: song.ogg']) },
      [audio('song.ogg'), audio('new.ogg'), audio('song_drumless.ogg'), audio('mix.ogg'), audio('pre.ogg'), audio('hh.wav')],
    );

  it('ドラム入りの原曲に替えると、空・前の原曲を指していた試聴は新しい原曲に。選んだ試聴はそのまま', () => {
    songWith(null);
    expect(planBgmSwap('new.ogg')).toEqual({ preview: 'new.ogg', fullMix: undefined });
    songWith('song.ogg');
    expect(planBgmSwap('new.ogg').preview).toBe('new.ogg');
    songWith('pre.ogg');
    expect(planBgmSwap('new.ogg').preview).toBeNull();
  });

  it('ドラム抜きにするときは、前の原曲を完全な原曲として覚え、試聴が空なら完全な原曲を入れる', () => {
    songWith(null);
    expect(planBgmSwap('song_drumless.ogg')).toEqual({ preview: 'song.ogg', fullMix: 'song.ogg' });
    songWith('song.ogg');
    expect(planBgmSwap('song_drumless.ogg')).toEqual({ preview: null, fullMix: 'song.ogg' });
  });

  it('ステムから書き出した BGM は、名前にドラム抜きと書いていなくても、作り方でドラム抜きとみなす（試聴にしない）', () => {
    songWith(null);
    // 前はファイル名だけで見ていたので、mix.ogg（ドラム抜き）を試聴に入れ、完全な原曲として覚えていた
    expect(planBgmSwap('mix.ogg')).toEqual({ preview: 'mix.ogg', fullMix: undefined });
    expect(planBgmSwap('mix.ogg', { drumless: true })).toEqual({ preview: 'song.ogg', fullMix: 'song.ogg' });
    // ステムを全部まとめた音（ドラム入り）は完全な原曲
    expect(planBgmSwap('song_drumless.ogg', { drumless: false })).toEqual({ preview: 'song_drumless.ogg', fullMix: undefined });
  });

  it('DTXMania の曲の BGM の名前（bgm.ogg・bgm_d.ogg）はドラム抜きのことが多いので、完全な原曲として覚えず、試聴にも入れない', () => {
    for (const name of ['bgm.ogg', 'BGM_D.ogg', 'bgm-d.wav']) {
      openSong({ 'mstr.dtx': chart(['#TITLE: テスト', '#BPM: 120', `#WAV01: ${name}`]) }, [audio(name), audio('bgm_drumless.ogg'), audio('hh.wav')]);
      expect(planBgmSwap('bgm_drumless.ogg')).toEqual({ preview: null, fullMix: undefined });
      expect(fullOriginal()).toBeNull();
      expect(fillPreview()).toBeNull();
    }
  });

  it('原曲と一緒に替えた試聴は、同じ原曲・同じ試聴だったほかの難易度にも入れ、Ctrl+Z で一緒に戻す', async () => {
    const t = chart(['#TITLE: テスト', '#BPM: 120', '#PREVIEW: bgm.ogg', '#WAV01: bgm.ogg']);
    const folder = openSong({ 'mstr.dtx': t, 'adv.dtx': t }, [audio('bgm.ogg'), audio('new.ogg'), audio('hh.wav')]);
    const { siblings } = editBgm('原曲を差し替える', (d) => {
      setField(d, 'PREVIEW', 'new.ogg');
      setField(d, 'WAV01', 'new.ogg');
    });
    expect((await siblings!.done).changed).toEqual(['ADVANCED']);
    expect((await onDisk(folder, 'adv.dtx')).fields).toMatchObject({ WAV01: 'new.ogg', PREVIEW: 'new.ogg' });
    undo();
    await siblingWrites();
    expect((await onDisk(folder, 'adv.dtx')).fields).toMatchObject({ WAV01: 'bgm.ogg', PREVIEW: 'bgm.ogg' });
  });

  it('保存の前に試聴が空なら原曲を入れる（空だったほかの難易度にも）。入れたのを空にしたら、もう入れない', async () => {
    const t = chart(['#TITLE: テスト', '#BPM: 120', '#WAV01: song.ogg']);
    const folder = openSong({ 'mstr.dtx': t, 'adv.dtx': t }, [audio('song.ogg'), audio('hh.wav')]);
    expect(fillPreview()).toBe('song.ogg');
    expect(useEditor.getState().doc.fields.PREVIEW).toBe('song.ogg');
    await siblingWrites();
    expect((await onDisk(folder, 'adv.dtx')).fields.PREVIEW).toBe('song.ogg');
    undo();
    await siblingWrites();
    expect(fillPreview()).toBeNull();
  });

  it('原曲がドラム抜きで、完全な原曲を覚えていなければ入れない', () => {
    openSong({ 'mstr.dtx': chart(['#TITLE: テスト', '#BPM: 120', '#WAV01: bgm_drumless.ogg']) }, [audio('bgm_drumless.ogg'), audio('hh.wav')]);
    expect(fullOriginal()).toBeNull();
    expect(fillPreview()).toBeNull();
  });
});

describe('完全な原曲を分け直す元にする', () => {
  it('ドラム抜きを BGM にして、試聴に完全な原曲を入れていても、分ける音は完全な原曲', () => {
    openSong(
      { 'mstr.dtx': chart(['#TITLE: テスト', '#BPM: 120', '#PREVIEW: song.ogg', '#WAV01: song_drumless.ogg']) },
      [audio('song.ogg', 900_000), audio('song_drumless.ogg', 900_000), audio('hh.wav')],
    );
    // 覚えていなくても、曲全体らしい長さの試聴は候補に入る（前は試聴だからと除いていた）
    expect(separationSources().map((x) => x.path)).toContain('song.ogg');
    const src = separationSource();
    expect('error' in src ? src.error : src.path).toBe('song.ogg');
    // 覚えていれば、それを先に
    useSidecar.setState({ fullMix: 'song.ogg' });
    const again = separationSource();
    expect('error' in again ? again.error : [again.path, again.full]).toEqual(['song.ogg', true]);
  });
});

describe('作業ファイルは、保存していない自動保存の控えが新しければそちらを読む', () => {
  const stems = (file: string) => [{ file, name: 'Drums', kind: 'drums' as const, gain: 1, pan: 0, mute: false, solo: false, offsetMs: 0 }];

  it('分けたステムを保存せずにリロード・難易度を切り替えても、控えのステムを読み、保存していない変更にする', async () => {
    const old = serializeSidecar({ ...emptySidecar(), stems: stems('stems/old_drums.ogg') });
    const folder = folderFromFiles([new File([old], 'mstr.dtxe.json', { lastModified: 1000 })], 'song');
    const draft = serializeSidecar({ ...emptySidecar(), stems: stems('stems/new_drums.ogg'), fullMix: 'song.ogg' });
    const entry = { sidecar: draft, saved: true, sidecarSaved: false, updatedAt: 2000 } as RecentEntry;
    const r = await readSidecarFor(folder, 'mstr.dtx', recentSidecarOf(entry));
    expect(r.data?.stems.map((t) => t.file)).toEqual(['stems/new_drums.ogg']);
    expect(r.unsaved.sort()).toEqual(['fullMix', 'stems']);

    // 曲フォルダの作業ファイルの方が新しい（あとで保存した）なら、そちら
    const later = await readSidecarFor(folder, 'mstr.dtx', recentSidecarOf({ ...entry, updatedAt: 500 }));
    expect(later.data?.stems.map((t) => t.file)).toEqual(['stems/old_drums.ogg']);
    expect(later.unsaved).toEqual([]);
    // 保存済みの控えは、曲フォルダの作業ファイルを読む
    const saved = await readSidecarFor(folder, 'mstr.dtx', recentSidecarOf({ ...entry, sidecarSaved: true }));
    expect(saved.data?.stems.map((t) => t.file)).toEqual(['stems/old_drums.ogg']);
    // 曲フォルダに無ければ控え
    const none = await readSidecarFor(folderFromFiles([], 'song'), 'mstr.dtx', draft);
    expect(none.data?.fullMix).toBe('song.ogg');
  });

  it('控えの作業ファイルが保存していないものか（前の版の控えは、譜面が保存済みかで見る）', () => {
    expect(sidecarUnsaved({ sidecar: '{}', saved: true, sidecarSaved: false })).toBe(true);
    expect(sidecarUnsaved({ sidecar: '{}', saved: false, sidecarSaved: true })).toBe(false);
    expect(sidecarUnsaved({ sidecar: '{}', saved: false })).toBe(true);
    expect(sidecarUnsaved({ sidecar: '{}', saved: true })).toBe(false);
    expect(sidecarUnsaved({ saved: false, sidecarSaved: false })).toBe(false);
  });
});
