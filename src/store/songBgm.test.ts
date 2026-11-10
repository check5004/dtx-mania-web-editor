// 原曲（BGM）を替えたら、同じ原曲を使っていたほかの難易度の譜面も同じ原曲にする。元に戻す・Ctrl+Z で一緒に戻す。
// 既に分かれた曲は、選んだ原曲にそろえる。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../audio/engine';
import { decodeDtx, encodeDtx, type DtxEncoding } from '../dtx/encoding';
import { frac } from '../dtx/fraction';
import { CH, type DtxDoc } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
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

// そろえるときに選ぶ原曲（テストごとに決める）
const pickIndex = vi.hoisted(() => ({ i: 0 }));
vi.mock('../ui/dialogs', () => ({
  chooseDialog: async (o: { options: { value: unknown }[] }) => o.options[pickIndex.i]?.value ?? null,
  confirmDialog: async () => true,
}));

const { redo, undo, useEditor } = await import('./editor');
const { alignBgm, bgmGroups, editBgm, firstBgm, groupBgms, pathFor, redoBgmIn, refreshSongBgms, restoreBgmIn, setBgmIn, siblingWrites } = await import('./songBgm');
const { registerExport, undoAudioReflect, useStems } = await import('./stems');

/** 原曲（WAV01）とハイハット（WAV02）の譜面。bgm が null なら原曲なし */
function chartText(bgm: string | null, opts: { pathWav?: string; hh?: string; title?: string } = {}): string {
  return [
    `#TITLE: ${opts.title ?? 'テスト'}`,
    '#BPM: 120',
    ...(opts.pathWav ? [`#PATH_WAV: ${opts.pathWav}`] : []),
    ...(bgm !== null ? [`#WAV01: ${bgm}`] : []),
    '#WAV02: hh.wav',
    '',
    ...(bgm !== null ? ['#00101: 01'] : []),
    `#00111: ${opts.hh ?? '02020202'}`,
  ].join('\r\n');
}

const file = (name: string, text: string, enc: DtxEncoding = 'shift_jis') => new File([encodeDtx(text, enc).bytes as Uint8Array<ArrayBuffer>], name);
const audio = (name: string) => new File([new Uint8Array(16)], name);

function openSong(charts: Record<string, string | File>, extra: File[] = [], current = 'mstr.dtx'): SongFolder {
  const files = Object.entries(charts).map(([name, t]) => (typeof t === 'string' ? file(name, t) : t));
  const folder = folderFromFiles([...files, audio('bgm.ogg'), audio('bgm_drumless.ogg'), audio('other.ogg'), audio('hh.wav'), ...extra], 'song');
  const text = charts[current];
  const doc = parseDtx(typeof text === 'string' ? text : '').doc;
  const label: Record<string, string> = { 'mstr.dtx': 'MASTER', 'ext.dtx': 'EXTREME', 'adv.dtx': 'ADVANCED', 'bsc.dtx': 'BASIC' };
  useStems.setState({ reflected: { bgm: null, preview: null } });
  useEditor.setState({
    screen: 'editor',
    page: 'chart',
    doc,
    savedDoc: doc,
    folder,
    past: [],
    future: [],
    meta: { fileName: current, encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: Object.keys(charts).map((f) => ({ file: f, label: label[f] ?? f })) },
  });
  return folder;
}

async function readChart(folder: SongFolder, name: string): Promise<{ doc: DtxDoc; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await (await findFile(folder, name)!.getFile()).arrayBuffer());
  return { doc: parseDtx(decodeDtx(bytes).text).doc, bytes };
}

const bgmOf = async (folder: SongFolder, name: string) => firstBgm((await readChart(folder, name)).doc)?.path ?? null;

beforeEach(() => {
  recent.clear();
  pickIndex.i = 0;
  vi.restoreAllMocks();
  vi.spyOn(engine, 'prepare').mockResolvedValue([]);
});

describe('譜面の原曲を書き換える', () => {
  const doc = (bgm: string | null) => parseDtx(chartText(bgm)).doc;

  it('原曲のチップがあれば、その #WAV のファイルだけを差し替え、戻すと前のファイルに戻る', () => {
    const d = doc('bgm.ogg');
    const u = setBgmIn(d, 'bgm_drumless.ogg', { m: 1, f: frac(0) });
    expect(u).toEqual({ kind: 'file', wav: 1, prev: 'bgm.ogg' });
    expect(d.fields.WAV01).toBe('bgm_drumless.ogg');
    expect(d.chips.filter((c) => c.ch === CH.BGM)).toHaveLength(1);
    expect(restoreBgmIn(d, u!, 'bgm_drumless.ogg')).toBe(true);
    expect(d.fields.WAV01).toBe('bgm.ogg');
    // 同じファイルなら何もしない
    expect(setBgmIn(d, 'bgm.ogg', { m: 1, f: frac(0) })).toBeNull();
  });

  it('原曲が無ければ、空いている #WAV・#BGMWAV・原曲のチップを足し、戻すとすべて消す', () => {
    const d = doc(null);
    const u = setBgmIn(d, 'bgm.ogg', { m: 1, f: frac(1, 4) })!;
    expect(u.kind).toBe('added');
    const b = firstBgm(d)!;
    expect(b).toMatchObject({ path: 'bgm.ogg', m: 1, f: { n: 1, d: 4 } });
    expect(d.fields.BGMWAV).toBeDefined();
    expect(restoreBgmIn(d, u, 'bgm.ogg')).toBe(true);
    expect(firstBgm(d)).toBeNull();
    expect(d.fields.BGMWAV).toBeUndefined();
    expect(Object.keys(d.fields).filter((k) => /^WAV/.test(k))).toEqual(['WAV02']);
  });

  it('あとで別の原曲にしていたら戻さない。やり直すは戻したときのままのときだけ', () => {
    const d = doc('bgm.ogg');
    const u = setBgmIn(d, 'bgm_drumless.ogg', { m: 1, f: frac(0) })!;
    setField(d, 'WAV01', 'other.ogg');
    expect(restoreBgmIn(d, u, 'bgm_drumless.ogg')).toBe(false);
    expect(d.fields.WAV01).toBe('other.ogg');
    expect(redoBgmIn(d, u, 'bgm_drumless.ogg', { m: 1, f: frac(0) })).toBeNull();
    setField(d, 'WAV01', 'bgm.ogg');
    expect(redoBgmIn(d, u, 'bgm_drumless.ogg', { m: 1, f: frac(0) })).toEqual(u);
    expect(d.fields.WAV01).toBe('bgm_drumless.ogg');
  });

  it('#PATH_WAV が違う譜面には、同じファイルを指すパスを書く（指せなければ書かない）', () => {
    const to = { path: 'bgm.ogg', pathWav: 'snd', file: 'snd/bgm.ogg', m: 1, f: frac(0) };
    expect(pathFor(to, { fields: { PATH_WAV: 'SND\\' } })).toBe('bgm.ogg');
    expect(pathFor(to, { fields: {} })).toBe('snd/bgm.ogg');
    expect(pathFor(to, { fields: { PATH_WAV: 'other' } })).toBeNull();
  });
});

describe('原曲を替えたら、同じ原曲を使っていたほかの難易度も同じ原曲にする', () => {
  it('ほかの難易度の譜面ファイルの #WAV を書き換え、Ctrl+Z で戻し、やり直すとまた入れる', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'adv.dtx': chartText('bgm.ogg', { hh: '0202' }), 'bsc.dtx': chartText('BGM.OGG', { hh: '02' }) });
    const before = (await readChart(folder, 'adv.dtx')).doc;
    const { ok, siblings } = editBgm('原曲を差し替える', (d) => void setField(d, 'WAV01', 'bgm_drumless.ogg'));
    expect(ok).toBe(true);
    const rep = await siblings!.done;
    expect(rep.changed).toEqual(['ADVANCED', 'BASIC']);
    expect(rep.files).toEqual(['adv.dtx', 'bsc.dtx']);
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm_drumless.ogg');
    expect(await bgmOf(folder, 'bsc.dtx')).toBe('bgm_drumless.ogg');
    // ほかは変えない（チップ・ほかの #WAV）
    const after = (await readChart(folder, 'adv.dtx')).doc;
    expect(serializeDtx({ ...after, fields: { ...after.fields, WAV01: 'bgm.ogg' } }).replace(/#WAV01: \S+/, '')).toBe(serializeDtx(before).replace(/#WAV01: \S+/, ''));

    undo();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.WAV01).toBe('bgm.ogg');
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm.ogg');
    expect(await bgmOf(folder, 'bsc.dtx')).toBe('BGM.OGG');
    // 鳴らす音も前の原曲に読み直す（履歴の名前に「音」が無くても、#WAV を変えた履歴なら）
    expect(engine.prepare).toHaveBeenCalled();

    redo();
    await siblingWrites();
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm_drumless.ogg');
    expect(await bgmOf(folder, 'bsc.dtx')).toBe('bgm_drumless.ogg');
  });

  it('前から別の原曲の難易度は、そのままにして知らせる', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'adv.dtx': chartText('bgm.ogg'), 'bsc.dtx': chartText('other.ogg') });
    const rep = await editBgm('原曲を差し替える', (d) => void setField(d, 'WAV01', 'bgm_drumless.ogg')).siblings!.done;
    expect(rep).toMatchObject({ changed: ['ADVANCED'], kept: ['BASIC'], failed: [] });
    expect(await bgmOf(folder, 'bsc.dtx')).toBe('other.ogg');
  });

  it('原曲の無い曲に原曲を読み込んだら、原曲の無いほかの難易度にも同じ所に置き、戻すと消す', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(null), 'adv.dtx': chartText(null) });
    const { siblings } = editBgm('原曲を読み込む', (d) => void setBgmIn(d, 'bgm.ogg', { m: 1, f: frac(0) }));
    expect((await siblings!.done).changed).toEqual(['ADVANCED']);
    const adv = (await readChart(folder, 'adv.dtx')).doc;
    expect(firstBgm(adv)).toMatchObject({ path: 'bgm.ogg', m: 1 });
    undo();
    await siblingWrites();
    const back = (await readChart(folder, 'adv.dtx')).doc;
    expect(firstBgm(back)).toBeNull();
    expect(back.fields.BGMWAV).toBeUndefined();
  });

  it('ほかの難易度の譜面は、開いたときの文字コードのまま書き直す（UTF-16 の譜面は UTF-16 のまま）', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'adv.dtx': file('adv.dtx', chartText('bgm.ogg', { title: 'Bless ♡ your breath' }), 'utf-16le') });
    await editBgm('原曲を差し替える', (d) => void setField(d, 'WAV01', 'bgm_drumless.ogg')).siblings!.done;
    const { doc, bytes } = await readChart(folder, 'adv.dtx');
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(doc.fields.TITLE).toBe('Bless ♡ your breath');
    expect(doc.fields.WAV01).toBe('bgm_drumless.ogg');
  });

  it('set.def で別の曲になっている譜面には触らない', async () => {
    const setDef = new File([encodeDtx(['#TITLE: A', '#L1LABEL: BASIC', '#L1FILE: bsc.dtx', '#L4LABEL: MASTER', '#L4FILE: mstr.dtx', '', '#TITLE: B', '#L4LABEL: MASTER', '#L4FILE: b.dtx'].join('\r\n')).bytes as Uint8Array<ArrayBuffer>], 'set.def');
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'bsc.dtx': chartText('bgm.ogg'), 'b.dtx': chartText('bgm.ogg') }, [setDef]);
    const rep = await editBgm('原曲を差し替える', (d) => void setField(d, 'WAV01', 'bgm_drumless.ogg')).siblings!.done;
    expect(rep.files).toEqual(['bsc.dtx']);
    expect(await bgmOf(folder, 'b.dtx')).toBe('bgm.ogg');
  });
});

describe('保存していない続きのある難易度', () => {
  const draft = (folder: SongFolder, name: string, text: string): RecentEntry => {
    const e: RecentEntry = { id: `song/${name}`, title: 'テスト', artist: '', bpm: '120', level: '', fileName: name, folderName: folder.name, text, saved: false, updatedAt: Date.now() + 60_000 };
    recent.set(e.id, e);
    return e;
  };

  it('続きとファイルの両方を同じ原曲にし、続きはファイルより新しいままにする（切り替えると続きから開く）', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'adv.dtx': chartText('bgm.ogg') });
    draft(folder, 'adv.dtx', chartText('bgm.ogg', { hh: '02020202020202' }));
    await editBgm('原曲を差し替える', (d) => void setField(d, 'WAV01', 'bgm_drumless.ogg')).siblings!.done;
    const e = recent.get('song/adv.dtx')!;
    const d = parseDtx(e.text).doc;
    expect(d.fields.WAV01).toBe('bgm_drumless.ogg');
    // 続きの編集（ハイハット）は残っている
    expect(d.chips.filter((c) => c.ch === CH.HHC)).toHaveLength(7);
    expect(e.updatedAt).toBeGreaterThanOrEqual((await findFile(folder, 'adv.dtx')!.getFile()).lastModified);
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm_drumless.ogg');
  });

  it('続きの原曲が違えば（その難易度で差し替えて保存していない）、続きもファイルもそのまま', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'adv.dtx': chartText('bgm.ogg') });
    const e = draft(folder, 'adv.dtx', chartText('other.ogg'));
    const rep = await editBgm('原曲を差し替える', (d) => void setField(d, 'WAV01', 'bgm_drumless.ogg')).siblings!.done;
    expect(rep.kept).toEqual(['ADVANCED']);
    expect(recent.get('song/adv.dtx')).toBe(e);
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm.ogg');
  });
});

describe('書き出した音を BGM に反映する（ステム・ドラム抜き）', () => {
  it('ほかの難易度にも入れ、反映の「元に戻す」で一緒に戻し、それを Ctrl+Z するとまた入れる', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'adv.dtx': chartText('bgm.ogg') });
    expect(registerExport('bgm_drumless.ogg', 'bgm')).toBe('bgm.ogg');
    const r = useStems.getState().reflected.bgm!;
    expect((await r.siblings!.done).changed).toEqual(['ADVANCED']);
    expect(r.siblings!.labels).toEqual(['ADVANCED']);
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm_drumless.ogg');

    undoAudioReflect('bgm');
    await siblingWrites();
    expect(useEditor.getState().doc.fields.WAV01).toBe('bgm.ogg');
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm.ogg');

    undo();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.WAV01).toBe('bgm_drumless.ogg');
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm_drumless.ogg');
  });
});

describe('分かれた原曲をそろえる', () => {
  it('難易度ごとの原曲を同じファイルどうしにまとめ、開いている難易度の原曲を先頭にする', () => {
    const t = (path: string) => ({ path, pathWav: '', file: path, m: 1, f: frac(0) });
    const g = groupBgms({ label: 'MASTER', key: 'bgm_drumless.ogg', target: t('bgm_drumless.ogg') }, [
      { file: 'ext.dtx', label: 'EXTREME', key: 'bgm.ogg', target: t('bgm.ogg') },
      { file: 'adv.dtx', label: 'ADVANCED', key: 'bgm.ogg', target: t('BGM.ogg') },
      { file: 'bsc.dtx', label: 'BASIC', key: null, target: null },
    ])!;
    expect(g.map((x) => [x.name, x.labels, x.current])).toEqual([
      ['bgm_drumless.ogg', ['MASTER'], true],
      ['bgm.ogg', ['EXTREME', 'ADVANCED'], false],
      ['', ['BASIC'], false],
    ]);
    expect(groupBgms({ label: 'MASTER', key: 'bgm.ogg', target: t('bgm.ogg') }, [{ file: 'adv.dtx', label: 'ADVANCED', key: 'bgm.ogg', target: t('bgm.ogg') }])).toBeNull();
  });

  it('開いている難易度の原曲にそろえる：ほかの難易度だけ書き換え、Ctrl+Z で戻す', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm_drumless.ogg'), 'adv.dtx': chartText('bgm.ogg'), 'bsc.dtx': chartText(null) });
    await refreshSongBgms();
    expect(bgmGroups()!.map((g) => g.name)).toEqual(['bgm_drumless.ogg', 'bgm.ogg', '']);
    pickIndex.i = 0;
    expect(await alignBgm()).toBe(true);
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm_drumless.ogg');
    expect(await bgmOf(folder, 'bsc.dtx')).toBe('bgm_drumless.ogg');
    // 開いている譜面は変わらない（保存していない変更にもならない）
    const s = useEditor.getState();
    expect(s.doc).toBe(s.savedDoc);
    expect(s.past).toHaveLength(1);

    undo();
    await siblingWrites();
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm.ogg');
    expect(await bgmOf(folder, 'bsc.dtx')).toBeNull();
  });

  it('ほかの難易度の原曲にそろえる：開いている譜面も書き換える（Ctrl+Z で全部戻る）', async () => {
    const folder = openSong({ 'mstr.dtx': chartText('bgm.ogg'), 'ext.dtx': chartText('bgm_drumless.ogg'), 'adv.dtx': chartText('bgm.ogg') });
    await refreshSongBgms();
    pickIndex.i = 1;
    expect(await alignBgm()).toBe(true);
    expect(useEditor.getState().doc.fields.WAV01).toBe('bgm_drumless.ogg');
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm_drumless.ogg');
    expect(await bgmOf(folder, 'ext.dtx')).toBe('bgm_drumless.ogg');
    undo();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.WAV01).toBe('bgm.ogg');
    expect(await bgmOf(folder, 'adv.dtx')).toBe('bgm.ogg');
    expect(await bgmOf(folder, 'ext.dtx')).toBe('bgm_drumless.ogg');
  });
});
