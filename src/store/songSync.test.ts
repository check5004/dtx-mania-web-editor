// 曲のもの（曲情報・テンポ）を変えたら、変える前に同じだったほかの難易度の譜面にも入れる。前から違う難易度はそのまま。
// Ctrl+Z・やり直すで一緒に戻し、知らせの「この難易度だけにする」でほかの難易度だけ戻す。分かれた曲はそろえられる。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../audio/engine';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import { frac } from '../dtx/fraction';
import { CH, type DtxDoc } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { buildTempoMap } from '../dtx/timing';
import { setField } from '../edit/ops';
import { findFile, folderFromFiles, type FolderFile, type SongFolder } from '../fs/folder';
import type { RecentEntry } from '../fs/recent';

// トーストが消える時計（テストでは進めない）
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

// テンポをそろえる前の確かめ（テストごとに決める）
const answer = vi.hoisted(() => ({ yes: true }));
vi.mock('../ui/dialogs', () => ({
  chooseDialog: async () => null,
  confirmDialog: async () => answer.yes,
}));

const { redo, undo, useEditor } = await import('./editor');
const { siblingWrites } = await import('./siblings');
const sync = await import('./songSync');
const { alignSongFields, alignTempo, editSong, placeSongBpm, refreshSongSync, sameTempo, setSongField, songFieldSplits, tempoSig, tempoSplits, toastSongEdit } = sync;
const { applyTempo, initTempo, setPlanBpm, tempoDiff, useTempo, planResult } = await import('./tempoUi');
const { useSidecar } = await import('./sidecar');

interface ChartOpts {
  title?: string;
  artist?: string;
  bpm?: string;
  level?: string;
  /** ほかのヘッダ（#BPM01 など） */
  head?: string[];
  /** ほかのチップの行（#00008 など） */
  body?: string[];
  hh?: string;
  /** 原曲のチップの行（#00101 の中身）。null なら原曲のチップなし */
  bgm?: string | null;
}

/** 原曲（WAV01）とハイハット（WAV02）の譜面 */
function chartText(o: ChartOpts = {}): string {
  return [
    `#TITLE: ${o.title ?? 'テスト'}`,
    `#ARTIST: ${o.artist ?? 'だれか'}`,
    `#BPM: ${o.bpm ?? '120'}`,
    `#DLEVEL: ${o.level ?? '50'}`,
    '#WAV01: bgm.ogg',
    '#WAV02: hh.wav',
    ...(o.head ?? []),
    '',
    ...(o.bgm === null ? [] : [`#00101: ${o.bgm ?? '01'}`]),
    `#00111: ${o.hh ?? '02020202'}`,
    `#00211: ${o.hh ?? '02020202'}`,
    ...(o.body ?? []),
  ].join('\r\n');
}

const file = (name: string, text: string) => new File([encodeDtx(text, 'shift_jis').bytes as Uint8Array<ArrayBuffer>], name);
const audio = (name: string) => new File([new Uint8Array(16)], name);
const LABEL: Record<string, string> = { 'mstr.dtx': 'MASTER', 'ext.dtx': 'EXTREME', 'adv.dtx': 'ADVANCED', 'bsc.dtx': 'BASIC' };

function openSong(charts: Record<string, string>, current = 'mstr.dtx'): SongFolder {
  const folder = folderFromFiles([...Object.entries(charts).map(([n, t]) => file(n, t)), audio('bgm.ogg'), audio('hh.wav'), audio('pre.ogg')], 'song');
  const doc = parseDtx(charts[current]).doc;
  useSidecar.setState({ anchors: [] });
  useTempo.setState({ initialized: false });
  useEditor.setState({
    screen: 'editor',
    page: 'chart',
    doc,
    savedDoc: doc,
    folder,
    past: [],
    future: [],
    toasts: [],
    meta: { fileName: current, encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: Object.keys(charts).map((f) => ({ file: f, label: LABEL[f] ?? f })) },
  });
  return folder;
}

async function textOf(folder: SongFolder, name: string): Promise<string> {
  return decodeDtx(new Uint8Array(await (await findFile(folder, name)!.getFile()).arrayBuffer())).text;
}
const docOf = async (folder: SongFolder, name: string): Promise<DtxDoc> => parseDtx(await textOf(folder, name)).doc;

/** 書き換わった行（前と後で違う行） */
function changedLines(a: string, b: string): string[] {
  const x = new Set(a.split(/\r?\n/));
  const y = new Set(b.split(/\r?\n/));
  return [...[...x].filter((l) => !y.has(l)).map((l) => `- ${l}`), ...[...y].filter((l) => !x.has(l)).map((l) => `+ ${l}`)];
}

/** 中身（id を除いたチップと定義）が同じか */
function sameContent(a: DtxDoc, b: DtxDoc): boolean {
  const chips = (d: DtxDoc) =>
    d.chips
      .map((c) => `${c.m}|${c.ch}|${c.f.n}/${c.f.d}|${c.v}`)
      .sort()
      .join(',');
  const fields = (d: DtxDoc) => JSON.stringify(Object.entries(d.fields).sort(([p], [q]) => (p < q ? -1 : 1)));
  return chips(a) === chips(b) && fields(a) === fields(b) && JSON.stringify(a.barLengths) === JSON.stringify(b.barLengths);
}

const lastToast = () => useEditor.getState().toasts.at(-1)!;

beforeEach(() => {
  recent.clear();
  answer.yes = true;
  vi.restoreAllMocks();
  vi.spyOn(engine, 'prepare').mockResolvedValue([]);
});

describe('曲情報を変えたら、同じだったほかの難易度にも入れる', () => {
  it('ほかの難易度の譜面はその行だけ書き換え、Ctrl+Z で元の文に戻し、やり直すとまた入れる', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText({ level: '30', hh: '0202' }), 'bsc.dtx': chartText({ level: '10', hh: '02' }) });
    const before = await textOf(folder, 'adv.dtx');
    expect(setSongField('TITLE', '新しい曲名')).toBe(true);
    await siblingWrites();
    expect(useEditor.getState().doc.fields.TITLE).toBe('新しい曲名');
    expect((await docOf(folder, 'adv.dtx')).fields.TITLE).toBe('新しい曲名');
    expect((await docOf(folder, 'bsc.dtx')).fields.TITLE).toBe('新しい曲名');
    expect(changedLines(before, await textOf(folder, 'adv.dtx'))).toEqual(['- #TITLE: テスト', '+ #TITLE: 新しい曲名']);

    undo();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.TITLE).toBe('テスト');
    expect(await textOf(folder, 'adv.dtx')).toBe(before);

    redo();
    await siblingWrites();
    expect((await docOf(folder, 'adv.dtx')).fields.TITLE).toBe('新しい曲名');
    expect((await docOf(folder, 'bsc.dtx')).fields.TITLE).toBe('新しい曲名');
  });

  it('ほかの難易度に入れ終わる前に Ctrl+Z を押しても、入れ終わってから一緒に戻す', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    const before = await textOf(folder, 'adv.dtx');
    setSongField('TITLE', '新しい曲名');
    undo();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.TITLE).toBe('テスト');
    expect(await textOf(folder, 'adv.dtx')).toBe(before);
  });

  it('前から違う難易度はそのままにし、知らせに入れた難易度とそのままにした難易度を書く', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText({ title: 'テスト (Short ver.)' }), 'bsc.dtx': chartText() });
    setSongField('TITLE', '新しい曲名');
    await siblingWrites();
    await Promise.resolve();
    expect((await docOf(folder, 'adv.dtx')).fields.TITLE).toBe('テスト (Short ver.)');
    expect((await docOf(folder, 'bsc.dtx')).fields.TITLE).toBe('新しい曲名');
    expect(lastToast().text).toBe('ほかの難易度（BASIC）の曲名も同じにしました。ADVANCED は前から曲名が違うので、そのままにしました');
    expect(lastToast().action2?.label).toBe('この難易度だけにする');
  });

  it('レベルや #PATH_WAV は難易度ごとのものなので、ほかの難易度には入れない', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    const r = editSong('レベルを変える', (d) => setField(d, 'DLEVEL', '99'));
    expect(r.ok).toBe(true);
    expect(r.siblings).toBeNull();
    expect((await docOf(folder, 'adv.dtx')).fields.DLEVEL).toBe('50');
  });

  it('知らせはすぐ出し、ほかの難易度に入れ終わったら、そのことと「この難易度だけにする」を足す', async () => {
    openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    const r = editSong('アーティストを変える', (d) => setField(d, 'ARTIST', 'べつのひと'));
    const p = toastSongEdit(r, 'アーティストを変えました', 'ok', 4000, { label: '元に戻す', run: () => undefined });
    expect(lastToast().text).toBe('アーティストを変えました');
    expect(lastToast().action?.label).toBe('元に戻す');
    await p;
    expect(lastToast().text).toBe('アーティストを変えました。ほかの難易度（ADVANCED）のアーティストも同じにしました');
    expect(lastToast().action?.label).toBe('元に戻す');
    expect(lastToast().action2?.label).toBe('この難易度だけにする');
    expect(useEditor.getState().toasts).toHaveLength(1);
  });

  it('「この難易度だけにする」はほかの難易度だけ戻し、そのあとの Ctrl+Z・やり直すはほかの難易度に触らない', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    const before = await textOf(folder, 'adv.dtx');
    setSongField('TITLE', '新しい曲名');
    await siblingWrites();
    await Promise.resolve();
    lastToast().action2!.run();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.TITLE).toBe('新しい曲名');
    expect(await textOf(folder, 'adv.dtx')).toBe(before);

    undo();
    redo();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.TITLE).toBe('新しい曲名');
    expect(await textOf(folder, 'adv.dtx')).toBe(before);
  });

  it('保存していない続きのある難易度は、続きとファイルの両方に入れる（続きの編集は残す）', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    const e: RecentEntry = { id: 'song/adv.dtx', title: 'テスト', artist: '', bpm: '120', level: '', fileName: 'adv.dtx', folderName: folder.name, text: chartText({ hh: '0202020202020202' }), saved: false, updatedAt: Date.now() + 60_000 };
    recent.set(e.id, e);
    setSongField('PREVIEW', 'pre.ogg');
    await siblingWrites();
    const d = parseDtx(recent.get('song/adv.dtx')!.text).doc;
    expect(d.fields.PREVIEW).toBe('pre.ogg');
    expect(d.chips.filter((c) => c.ch === CH.HHC)).toHaveLength(16);
    expect((await docOf(folder, 'adv.dtx')).fields.PREVIEW).toBe('pre.ogg');
  });
});

describe('テンポを変えたら、同じテンポだったほかの難易度にも入れる', () => {
  it('テンポ合わせの反映：BPM を入れ、Ctrl+Z で元の文に戻す。ドラムのチップは動かさない', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText({ hh: '0202' }) });
    const before = await textOf(folder, 'adv.dtx');
    useEditor.setState({ page: 'tempo' });
    initTempo();
    setPlanBpm(100);
    expect(applyTempo()).toBe(true);
    await siblingWrites();
    const adv = await docOf(folder, 'adv.dtx');
    expect(sameTempo(tempoSig(adv), tempoSig(useEditor.getState().doc))).toBe(true);
    expect(buildTempoMap(adv).initialBpm).toBe(100);
    expect(changedLines(before, await textOf(folder, 'adv.dtx'))).toEqual(['- #BPM: 120', '+ #BPM: 100']);

    undo();
    await siblingWrites();
    expect(useEditor.getState().doc.fields.BPM).toBe('120');
    expect(await textOf(folder, 'adv.dtx')).toBe(before);
  });

  it('原曲（BGM）のチップを動かしたら、ほかの難易度の原曲のチップも同じ所へ動かす', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    const r = editSong('開始位置を直す', (d) => {
      const c = d.chips.find((x) => x.ch === CH.BGM)!;
      c.m = 1;
      c.f = frac(5, 384);
    });
    expect(r.tempo).toBe(true);
    expect((await r.siblings!.done).changed).toEqual(['ADVANCED']);
    const bgm = (await docOf(folder, 'adv.dtx')).chips.filter((c) => c.ch === CH.BGM);
    expect(bgm).toHaveLength(1);
    expect(bgm[0]).toMatchObject({ m: 1, f: { n: 5, d: 384 }, v: 1 });
  });

  it('BPM 変化を置いたら、ほかの難易度にも同じ所に置く', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    expect(placeSongBpm({ m: 2, f: frac(0) }, 150)).toBe(true);
    await siblingWrites();
    const adv = await docOf(folder, 'adv.dtx');
    const t = buildTempoMap(adv);
    expect(t.bpmAt(t.measureStart(2))).toBe(150);
    expect(t.bpmAt(t.measureStart(1))).toBe(120);
  });

  it('書き方が違っても中身が同じテンポ（同じ BPM のチップが重ねてある）なら同じとみなして入れ、戻すと元の中身に戻す', async () => {
    const redundant = chartText({ head: ['#BPM01: 120'], body: ['#00008: 01'] });
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': redundant });
    const before = await docOf(folder, 'adv.dtx');
    useEditor.setState({ page: 'tempo' });
    initTempo();
    setPlanBpm(100);
    applyTempo();
    await siblingWrites();
    const adv = await docOf(folder, 'adv.dtx');
    expect(buildTempoMap(adv).bpmAt(0)).toBe(100);
    undo();
    await siblingWrites();
    expect(sameContent(await docOf(folder, 'adv.dtx'), before)).toBe(true);
  });

  it('前からテンポが違う難易度（倍の BPM・拍子が違う）はそのままにする', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText({ bpm: '240' }), 'bsc.dtx': chartText({ head: ['#00102: 0.75'] }) });
    const r = editSong('BPM を変える', (d) => setField(d, 'BPM', '100'));
    const rep = await r.siblings!.done;
    expect(rep).toMatchObject({ changed: [], kept: ['ADVANCED', 'BASIC'], failed: [] });
    expect((await docOf(folder, 'adv.dtx')).fields.BPM).toBe('240');
    expect((await docOf(folder, 'bsc.dtx')).fields.BPM).toBe('120');
  });

  it('BPM の欄（曲情報）を変えても入れる', async () => {
    const folder = openSong({ 'mstr.dtx': chartText(), 'adv.dtx': chartText() });
    setSongField('BPM', '130');
    await siblingWrites();
    expect((await docOf(folder, 'adv.dtx')).fields.BPM).toBe('130');
  });
});

describe('難易度によって分かれた曲をそろえる', () => {
  it('違う曲情報の欄を見つけ、開いている難易度の値にそろえる（Ctrl+Z で戻す）', async () => {
    const folder = openSong({ 'mstr.dtx': chartText({ artist: 'A' }), 'adv.dtx': chartText({ artist: 'B', title: 'べつ' }), 'bsc.dtx': chartText({ artist: 'A' }) });
    await refreshSongSync();
    expect(songFieldSplits().map((x) => [x.key, x.others])).toEqual([
      ['TITLE', [{ label: 'ADVANCED', value: 'べつ' }]],
      ['ARTIST', [{ label: 'ADVANCED', value: 'B' }]],
    ]);
    expect(await alignSongFields()).toBe(true);
    const adv = await docOf(folder, 'adv.dtx');
    expect([adv.fields.TITLE, adv.fields.ARTIST]).toEqual(['テスト', 'A']);
    // 開いている譜面は変えない（保存していない変更にもならない）
    const s = useEditor.getState();
    expect(s.doc).toBe(s.savedDoc);
    await refreshSongSync();
    expect(songFieldSplits()).toEqual([]);

    undo();
    await siblingWrites();
    expect((await docOf(folder, 'adv.dtx')).fields.TITLE).toBe('べつ');
  });

  it('テンポが違う難易度を見つけ、確かめてからそろえる。拍子が違う難易度はそろえない', async () => {
    const folder = openSong({ 'mstr.dtx': chartText({ bpm: '150' }), 'adv.dtx': chartText({ bgm: '0001' }), 'bsc.dtx': chartText({ bpm: '150', head: ['#00102: 0.75'] }), 'ext.dtx': chartText({ bpm: '150' }) });
    await refreshSongSync();
    expect(tempoSplits().map((x) => [x.label, x.bars, x.bpm])).toEqual([
      ['ADVANCED', false, 120],
      ['BASIC', true, 150],
    ]);
    answer.yes = false;
    expect(await alignTempo()).toBe(false);
    expect((await docOf(folder, 'adv.dtx')).fields.BPM).toBe('120');

    answer.yes = true;
    expect(await alignTempo()).toBe(true);
    const adv = await docOf(folder, 'adv.dtx');
    expect(sameTempo(tempoSig(adv), tempoSig(useEditor.getState().doc))).toBe(true);
    expect((await docOf(folder, 'bsc.dtx')).barLengths[1]).toBe(0.75);

    undo();
    await siblingWrites();
    const back = await docOf(folder, 'adv.dtx');
    expect(back.fields.BPM).toBe('120');
    expect(back.chips.find((c) => c.ch === CH.BGM)).toMatchObject({ m: 1, f: { n: 1, d: 2 } });
  });
});

describe('テンポ合わせの画面を開いたとき', () => {
  it('作業ファイルのアンカーが今の譜面のテンポと合わなければ（ほかの難易度で直したテンポが入った）、譜面から作り直す', () => {
    openSong({ 'mstr.dtx': chartText({ bpm: '100' }) });
    // BPM 120 のときに反映したアンカー（1小節目の頭が原曲の 0 秒、5小節目の頭が 8 秒）
    useSidecar.setState({ anchors: [{ m: 1, t: 0 }, { m: 5, t: 8 }] });
    initTempo();
    expect(tempoDiff(useEditor.getState().doc, planResult()).any).toBe(false);
  });

  it('合っていれば、作業ファイルのアンカーをそのまま使う', () => {
    openSong({ 'mstr.dtx': chartText({ bpm: '120' }) });
    useSidecar.setState({ anchors: [{ m: 1, t: 0 }, { m: 5, t: 8 }] });
    initTempo();
    expect(useTempo.getState().plan.anchors).toEqual([{ m: 1, t: 0 }, { m: 5, t: 8 }]);
  });
});
