// 選曲画面の試聴（#PREVIEW）を切り出す曲の音の選び方。ドラム抜きの BGM だけからは作らない：
// 完全な原曲（ほかの難易度が覚えているもの・同じ名前の元の原曲も）→ ドラム入りらしい BGM → ステムを全部足した音 →
// 打ち込み終わった譜面なら BGM に譜面のドラムを足した音。どれも無くドラム抜きの BGM だけなら作らない。
// 名前では分からないドラム抜き（前の版で原曲の名前のまま書き出した音など）は、ステムと音で比べて見分ける。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../audio/engine';
import { addSignals, drumsSignal, monoBuffer, othersSignal } from '../audio/testSignals';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { folderFromFiles, type SongFolder } from '../fs/folder';
import type { StemTrack } from './sidecar';

// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined });

// 自動保存の控え（IndexedDB の代わり。控えは無い）
vi.mock('../fs/recent', async (orig) => ({ ...(await orig<typeof import('../fs/recent')>()), getRecent: async () => undefined, draftFor: async () => undefined }));

// 読み込んだステム（音はテストで決める）
const st = vi.hoisted(() => ({ ready: [] as StemTrack[], bufs: new Map<string, AudioBuffer>(), heard: new Map<string, boolean>() }));
vi.mock('./stems', async (orig) => ({
  ...(await orig<typeof import('./stems')>()),
  readyStems: () => st.ready,
  stemBuffer: (file: string) => st.bufs.get(file) ?? fakeBuf(200),
  stemsSettled: async () => undefined,
}));

// エディタの採譜で聞いた、音（engine.buffer の key）のドラム（無ければ採譜がまだ）
vi.mock('./drums', async (orig) => ({ ...(await orig<typeof import('./drums')>()), drumsAudibleFor: (key: string | null | undefined) => (key ? (st.heard.get(key) ?? null) : null) }));

// 読み込んだ音（WAV の番号 → 長さ。音で比べるテストでは中身のある音）
const sounds = new Map<number, number>();
const soundBufs = new Map<number, AudioBuffer>();
function fakeBuf(duration: number): AudioBuffer {
  return { duration, sampleRate: 44100, length: Math.round(duration * 44100), numberOfChannels: 2, getChannelData: () => new Float32Array(0) } as unknown as AudioBuffer;
}
vi.spyOn(engine, 'buffer').mockImplementation((no: number) => {
  const buf = soundBufs.get(no) ?? (sounds.has(no) ? fakeBuf(sounds.get(no)!) : null);
  return buf ? { buf, key: `wav${no}` } : null;
});
// 曲フォルダのファイルを読んだ音：中身の頭に書いた名前の音（無ければ読めない）
const decoded = new Map<string, AudioBuffer>();
vi.spyOn(engine, 'decodeAudio').mockImplementation(async (bytes: ArrayBuffer) => {
  const b = decoded.get(new TextDecoder().decode(bytes).replace(/\0[\s\S]*$/, ''));
  if (!b) throw new Error('not audio');
  return b;
});
vi.spyOn(engine, 'sound').mockImplementation((no: number) => (sounds.has(no) ? { buf: fakeBuf(sounds.get(no)!), volume: 100, pan: 0 } : null));
vi.spyOn(engine, 'prepare').mockResolvedValue([]);

const { useEditor } = await import('./editor');
const { loadSidecar, useSidecar, emptySidecar, serializeSidecar } = await import('./sidecar');
const { planAudio, checkedFullOriginal, fileHasDrums } = await import('./chorus');
const { defaultExportName } = await import('./stems');

const stem = (file: string, kind: StemTrack['kind'], name: string = kind): StemTrack => ({ file, name, kind, gain: 1, pan: 0, mute: false, solo: false, offsetMs: 0 });
const audio = (name: string, size = 1000) => new File([new Uint8Array(size)], name);

/**
 * 曲を開く。BGM（#WAV01）は 0 小節の頭から 20 秒（BPM 120 で 10 小節）。drums：ドラムのチップを置く小節の数（HH は 02、
 * 0 小節にだけ HH オープン 03 も置く）。longSe：長い SE（#WAV09、BGM と同じ所から鳴らす）
 */
function openSong(o: { bgm?: string | null; files?: File[]; drums?: number; longSe?: string; charts?: Record<string, string> }): SongFolder {
  const fields: Record<string, string> = { TITLE: 'テスト', BPM: '120', WAV02: 'hhc.wav', WAV03: 'hho.wav' };
  const chips: DtxDoc['chips'] = [];
  let id = 1;
  sounds.clear();
  soundBufs.clear();
  sounds.set(2, 0.3);
  sounds.set(3, 1.5);
  if (o.bgm) {
    fields.WAV01 = o.bgm;
    chips.push({ id: id++, ch: CH.BGM, m: 0, f: { n: 0, d: 1 }, v: 1 });
    sounds.set(1, 20);
  }
  if (o.longSe) {
    fields.WAV09 = o.longSe;
    chips.push({ id: id++, ch: 0x61, m: 0, f: { n: 0, d: 1 }, v: 9 });
    sounds.set(9, 20);
  }
  for (let m = 0; m < (o.drums ?? 0); m++) {
    if (m === 0) chips.push({ id: id++, ch: CH.HHO, m, f: { n: 0, d: 4 }, v: 3 });
    for (let k = m === 0 ? 1 : 0; k < 4; k++) chips.push({ id: id++, ch: CH.HHC, m, f: { n: k, d: 4 }, v: 2 });
  }
  const doc: DtxDoc = { ...emptyDoc(), fields, chips, nextId: id };
  const charts = Object.entries(o.charts ?? {}).map(([n, t]) => new File([t], n));
  const folder = folderFromFiles([new File(['#TITLE: テスト'], 'mstr.dtx'), ...charts, ...(o.bgm ? [audio(o.bgm, 900_000)] : []), ...(o.files ?? [])], 'song');
  useEditor.setState({
    screen: 'editor',
    doc,
    folder,
    meta: { fileName: 'mstr.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [{ file: 'mstr.dtx', label: 'MASTER' }, ...Object.keys(o.charts ?? {}).filter((n) => n.endsWith('.dtx')).map((file) => ({ file, label: 'ADVANCED' }))] },
  });
  loadSidecar(null);
  return folder;
}

const plan = () => {
  const s = useEditor.getState();
  return planAudio(s.doc, s.folder, s.meta.fileName);
};

beforeEach(() => {
  st.ready = [];
  st.bufs.clear();
  st.heard.clear();
  decoded.clear();
});

describe('試聴を切り出す曲の音', () => {
  it('作業ファイルが覚えている完全な原曲を先に使う', async () => {
    openSong({ bgm: 'song_nodrums.ogg', files: [audio('song.mp3', 900_000)] });
    useSidecar.setState({ fullMix: 'song.mp3' });
    expect(await plan()).toMatchObject({ kind: 'full', label: 'song.mp3' });
  });

  it('作業ファイルの無い難易度では、ほかの難易度の作業ファイルが覚えている完全な原曲を使う', async () => {
    const side = serializeSidecar({ ...emptySidecar(), fullMix: 'full mix.ogg' });
    openSong({ bgm: 'bgm.ogg', drums: 10, files: [audio('full mix.ogg', 900_000)], charts: { 'adv.dtx': '#TITLE: テスト', 'adv.dtxe.json': side } });
    expect(await plan()).toMatchObject({ kind: 'full', label: 'full mix.ogg' });
  });

  it('ドラム抜きの BGM（曲_drumless.ogg）と同じ名前の元の原曲（曲.mp3）があれば、それを使う', async () => {
    openSong({ bgm: 'song_drumless.ogg', files: [audio('song.mp3', 900_000)] });
    expect(await plan()).toMatchObject({ kind: 'full', label: 'song.mp3' });
  });

  it('ドラム入りらしい BGM はそのまま使う（ステムがあっても）', async () => {
    openSong({ bgm: 'song.ogg' });
    st.ready = [stem('stems/song_drums.ogg', 'drums'), stem('stems/song_nodrums.ogg', 'other')];
    expect(await plan()).toMatchObject({ kind: 'full', label: 'song.ogg' });
  });

  it('BGM がドラム抜きなら、ステムを全部足す（メトロノームは足さない）。原曲が無くてもステムを足す', async () => {
    openSong({ bgm: 'song_nodrums.ogg' });
    st.ready = [stem('stems/drums.ogg', 'drums', 'ドラム'), stem('stems/bass.ogg', 'bass', 'ベース'), stem('stems/other.ogg', 'other', 'その他'), stem('stems/click.ogg', 'other', 'メトロノーム')];
    const p = await plan();
    expect(p).toMatchObject({ kind: 'stems', label: 'ドラム + ベース + その他' });
    expect(await p!.load()).toHaveLength(3);

    openSong({ bgm: null });
    st.ready = [stem('stems/vocals.ogg', 'vocals'), stem('stems/inst.ogg', 'other')];
    expect(await plan()).toMatchObject({ kind: 'stems' });
  });

  it('BGM がドラム抜きでドラムのステムだけなら、BGM とドラムのステムを足す', async () => {
    openSong({ bgm: 'bgm_drumless.ogg' });
    st.ready = [stem('stems/drums.ogg', 'drums', 'ドラム')];
    const p = await plan();
    expect(p).toMatchObject({ kind: 'bgmStems', label: 'bgm_drumless.ogg + ドラム' });
    expect(await p!.load()).toHaveLength(2);
  });

  it('開いている難易度にステムが無ければ、ほかの難易度の作業ファイルのステムを使う', async () => {
    const side = serializeSidecar({ ...emptySidecar(), stems: [stem('stems/a_drums.ogg', 'drums', 'ドラム'), stem('stems/a_nodrums.ogg', 'other', 'ドラム抜き')] });
    openSong({ bgm: 'a_nodrums.ogg', files: [audio('stems/a_drums.ogg'), audio('stems/a_nodrums.ogg')], charts: { 'adv.dtx': '#TITLE: テスト', 'adv.dtxe.json': side } });
    const p = await plan();
    expect(p?.kind).toBe('stems');
    expect(p?.label).toContain('ADVANCED');
  });

  it('長い SE がドラムのステム（DTXMania の曲）なら、BGM と足す', async () => {
    openSong({ bgm: 'bgm_d.ogg', longSe: 'drums.ogg' });
    expect(await plan()).toMatchObject({ kind: 'chart', label: 'bgm_d.ogg + drums.ogg' });
  });

  it('打ち込み終わった譜面なら、BGM に譜面のドラムの音を足して切り出す（サビを探すのは BGM。同じグループの次の音で前の音を止める）', async () => {
    openSong({ bgm: 'bgm.ogg', drums: 10 });
    const p = (await plan())!;
    expect(p.kind).toBe('game');
    const tracks = (await p.load())!;
    expect(tracks).toHaveLength(1);
    const clip = p.clip!(tracks);
    // BGM と 40 個のハイハット
    expect(clip).toHaveLength(41);
    // 0 小節の頭の HH オープンは、次の HH クローズ（0.5 秒）で止める
    expect(clip[1]).toMatchObject({ at: 0, until: 0.5 });
    expect(clip[clip.length - 1].until).toBeUndefined();
  });

  it('打ち込み途中（ドラムのある小節が少ない）なら、ドラムは足さない', async () => {
    openSong({ bgm: 'bgm.ogg', drums: 3 });
    // DTXMania の曲の BGM の名前：ドラム抜きのことが多いが、ほかに曲の音が無いので使う（画面で知らせる）
    expect(await plan()).toMatchObject({ kind: 'full', maybeDrumless: true });
    openSong({ bgm: 'song_drumless.ogg', drums: 3 });
    // ドラム抜きと書いてある BGM だけなら、試聴は作らない
    expect(await plan()).toMatchObject({ kind: 'bgm' });
  });

  it('曲の音が無ければ null', async () => {
    openSong({ bgm: null });
    expect(await plan()).toBeNull();
  });
});

describe('名前では分からないドラム抜きを、ステムと音で比べて見分ける', () => {
  const SR = 8000;
  const SEC = 40;
  const D = drumsSignal(SEC, SR);
  const N = othersSignal(SEC, SR);
  const asBuf = (x: Float32Array) => monoBuffer(x, SR) as unknown as AudioBuffer;
  const full = asBuf(addSignals(D, N));
  const drumless = asBuf(N);
  const cut = (x: Float32Array, from: number, len: number) => asBuf(x.slice(Math.round(from * SR), Math.round((from + len) * SR)));
  /** 曲フォルダに置く音のファイル（読むと name の音） */
  const sound = (file: string, name: string, buf: AudioBuffer, size = 900_000) => {
    decoded.set(name, buf);
    return new File([name, new Uint8Array(size)], file);
  };
  const withStems = () => {
    st.ready = [stem('stems/drums.ogg', 'drums', 'ドラム'), stem('stems/other.ogg', 'other', 'その他')];
    st.bufs.set('stems/drums.ogg', asBuf(D));
    st.bufs.set('stems/other.ogg', asBuf(N));
  };

  it('原曲の名前のドラム抜き（前の版で書き出して、完全な原曲としても覚えた）は使わず、ステムを全部足す', async () => {
    openSong({ bgm: 'Neon Skyline.ogg' });
    soundBufs.set(1, drumless);
    useSidecar.setState({ fullMix: 'Neon Skyline.ogg' });
    withStems();
    expect(await plan()).toMatchObject({ kind: 'stems', label: 'ドラム + その他' });
    // 保存の前に空の試聴へ入れる完全な原曲にもしない
    expect(await checkedFullOriginal()).toBeNull();
  });

  it('音にドラムが入っていれば、名前のとおり原曲を使う', async () => {
    openSong({ bgm: 'Neon Skyline.ogg' });
    soundBufs.set(1, full);
    withStems();
    expect(await plan()).toMatchObject({ kind: 'full', label: 'Neon Skyline.ogg' });
    expect((await checkedFullOriginal())?.path).toBe('Neon Skyline.ogg');
  });

  it('覚えている完全な原曲がドラム抜きでも、ドラム抜きの BGM と同じ名前の元の原曲がドラム入りなら、それを使う', async () => {
    openSong({ bgm: 'song_drumless.ogg', files: [sound('song.mp3', 'full', full), sound('song.ogg', 'drumless', drumless)] });
    soundBufs.set(1, drumless);
    useSidecar.setState({ fullMix: 'song.ogg' });
    withStems();
    expect(await plan()).toMatchObject({ kind: 'full', label: 'song.mp3' });
  });

  it('今の試聴（切り出した音も）がドラム抜きかを見分ける。ステムが無ければわからない', async () => {
    const files = [sound('preview_chorus.ogg', 'cut-drumless', cut(N, 17.3, 12), 200_000), sound('preview_full.ogg', 'cut-full', cut(addSignals(D, N), 9.1, 12), 200_000)];
    openSong({ bgm: 'song.ogg', files });
    withStems();
    expect(await fileHasDrums('preview_chorus.ogg')).toBe(false);
    expect(await fileHasDrums('preview_full.ogg')).toBe(true);
    openSong({ bgm: 'song.ogg', files });
    st.ready = [];
    expect(await fileHasDrums('preview_chorus.ogg')).toBeNull();
  });
});

describe('ステムが無ければ、エディタの採譜（原曲にドラムが聞こえるか）で見分ける', () => {
  it('採譜でドラムが聞こえない原曲は、ドラム入りの名前でも使わない（打ち込み終わった譜面ならドラムを足す・途中なら作らない）', async () => {
    openSong({ bgm: 'song.ogg', drums: 10 });
    st.heard.set('wav1', false);
    expect(await plan()).toMatchObject({ kind: 'game', label: 'song.ogg' });
    expect(await checkedFullOriginal()).toBeNull();
    expect(await fileHasDrums('song.ogg')).toBe(false);

    openSong({ bgm: 'song.ogg', drums: 3 });
    st.heard.set('wav1', false);
    expect(await plan()).toMatchObject({ kind: 'bgm' });
  });

  it('DTXMania の曲の bgm.ogg でも、採譜でドラムが聞こえれば完全な原曲（譜面のドラムは足さない）', async () => {
    openSong({ bgm: 'bgm.ogg', drums: 10 });
    st.heard.set('wav1', true);
    const p = await plan();
    expect(p).toMatchObject({ kind: 'full', label: 'bgm.ogg' });
    expect(p?.maybeDrumless).toBeUndefined();
    // 名前がドラム抜きの BGM は、採譜で聞こえても（分けた残りなど）名前のとおり
    openSong({ bgm: 'song_drumless.ogg', drums: 3 });
    st.heard.set('wav1', true);
    expect(await plan()).toMatchObject({ kind: 'bgm' });
  });
});

describe('ステムの画面の「BGM用（ドラム抜き）」の名前', () => {
  it('今の BGM の名前に _drumless を付ける（元の原曲を上書きせず、名前でもドラム抜きと分かるように）', () => {
    openSong({ bgm: 'song.ogg' });
    expect(defaultExportName('bgm', 'ogg')).toBe('song_drumless.ogg');
    openSong({ bgm: 'song_drumless.ogg' });
    expect(defaultExportName('bgm', 'wav')).toBe('song_drumless.wav');
    // BGM が無い（ステムだけの曲）ときも、前は bgm.ogg で、ドラム抜きの音を完全な曲として試聴にしていた
    openSong({ bgm: null });
    expect(defaultExportName('bgm', 'ogg')).toBe('bgm_drumless.ogg');
  });
});
