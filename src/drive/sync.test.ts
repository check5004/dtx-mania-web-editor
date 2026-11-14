import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDrive } from './fakeDrive.testutil';

// 本体（OPFS）への書き込みは模擬にする（node には OPFS が無い）
vi.mock('../fs/opfs', async (orig) => {
  const real = await orig<typeof import('../fs/opfs')>();
  return {
    ...real,
    writeSongFile: async (_id: string, rel: string, data: Blob | Uint8Array) => {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      const file = new File([bytes as Uint8Array<ArrayBuffer>], rel.split('/').pop()!, { lastModified: Date.now() + Math.random() });
      return { getFile: async () => file } as unknown as FileSystemFileHandle;
    },
  };
});

const { setDriveAuth } = await import('./api');
const { LINK_FILE, extrasOf, isSkipText, listDriveSongs, listTree, newLink, parseLink, planSync, pullSong, pushSize, pushSong, readAutosaves, readDriveSkip, readLink, remoteChanges, forgetRoot, trashJunk, writeDriveSkip } = await import('./sync');
const { folderFromFiles, writeFile } = await import('../fs/folder');
type SongFolder = import('../fs/folder').SongFolder;

const enc = (s: string) => new TextEncoder().encode(s);
const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');

let drive: FakeDrive;

function song(files: Record<string, string>, name = 'Mephisto'): SongFolder {
  const f = folderFromFiles([], name);
  f.dir = {} as FileSystemDirectoryHandle;
  f.local = 'L1';
  for (const [p, text] of Object.entries(files)) {
    const file = new File([enc(text)], p.split('/').pop()!, { lastModified: 1000 });
    f.files.set(p.toLowerCase(), { path: p, name: file.name, size: file.size, getFile: async () => file });
  }
  return f;
}

async function text(folder: SongFolder, path: string) {
  return (await folder.files.get(path.toLowerCase())!.getFile()).text();
}

beforeEach(() => {
  drive = new FakeDrive();
  vi.stubGlobal('fetch', drive.fetch);
  setDriveAuth(async () => drive.token, () => {});
  forgetRoot();
});

describe('どうするかを決める（planSync）', () => {
  const rec = (md5: string) => ({ id: 'x', md5, size: 1, mtime: 1, path: 'a' });
  const r = (md5: string) => ({ id: 'r', path: 'a', md5, size: 1, modifiedTime: '' });
  it('送るとき：変わった方だけ・両方で変わったら聞く', () => {
    const steps = planSync(
      new Map([
        ['same', { path: 'same', md5: 'A' }],
        ['mine', { path: 'mine', md5: 'B2' }],
        ['theirs', { path: 'theirs', md5: 'C' }],
        ['both', { path: 'both', md5: 'D2' }],
        ['new', { path: 'new' }],
      ]),
      new Map([
        ['same', r('A')],
        ['mine', r('B')],
        ['theirs', r('C2')],
        ['both', r('D3')],
        ['remoteonly', r('E')],
        ['deleted', r('F')],
      ]),
      { mine: rec('B'), theirs: rec('C'), both: rec('D'), deleted: rec('F') },
      'push',
    );
    expect(Object.fromEntries(steps.map((s) => [s.key, s.op]))).toEqual({ same: 'same', mine: 'up', theirs: 'newer', both: 'conflict', new: 'up', remoteonly: 'newer' });
  });
  it('取るとき：Drive で変わった物と Drive にだけある物を取る', () => {
    const steps = planSync(
      new Map([
        ['mine', { path: 'mine', md5: 'B2' }],
        ['theirs', { path: 'theirs', md5: 'C' }],
        ['localonly', { path: 'localonly', md5: 'Z' }],
      ]),
      new Map([
        ['mine', r('B')],
        ['theirs', r('C2')],
        ['remoteonly', r('E')],
      ]),
      { mine: rec('B'), theirs: rec('C') },
      'pull',
    );
    expect(steps.map((s) => `${s.key}:${s.op}`).sort()).toEqual(['remoteonly:down', 'theirs:down']);
  });
});

describe('Drive と曲フォルダを合わせる（偽の Drive で）', () => {
  it('初めて送る：DTX Web Editor の中に曲フォルダと同じ並びで作り、つなぎの記録を書く', async () => {
    const f = song({ 'ext.dtx': '#TITLE Mephisto', 'stems/drums.ogg': 'OGGDATA', 'bgm.ogg': 'BGM' });
    const r = await pushSong(f, { create: true, info: { t: 'メフィスト', a: '女王蜂' } });
    expect(r.sent).toBe(3);
    expect(drive.byPath('DTX Web Editor/Mephisto/stems/drums.ogg')?.content).toEqual(enc('OGGDATA'));
    expect(drive.byPath('DTX Web Editor/Mephisto/ext.dtx')).toBeTruthy();
    // つなぎの記録は Drive に送らない
    expect(drive.byPath(`DTX Web Editor/Mephisto/${LINK_FILE}`)).toBeUndefined();
    const link = (await readLink(f))!;
    expect(link.files['stems/drums.ogg'].md5).toBe(md5(enc('OGGDATA')));
    expect(f.drive ?? link.folderId).toBeTruthy();
    const songs = await listDriveSongs();
    expect(songs.map((s) => [s.name, s.info.t, s.info.n])).toEqual([['Mephisto', 'メフィスト', 3]]);
  });

  it('動画を除いて送る：つなぎの記録に残り、次からも動画は送らない', async () => {
    const f = song({ 'ext.dtx': '#TITLE X', 'bgm.ogg': 'BGM', 'movie/bga.mp4': 'VIDEO-DATA' });
    expect(pushSize(f)).toEqual({ total: 8 + 3 + 10, video: 10, videos: ['movie/bga.mp4'] });
    const r = await pushSong(f, { create: true, noVideo: true });
    expect(r.sent).toBe(2);
    expect(drive.byPath('DTX Web Editor/Mephisto/movie/bga.mp4')).toBeUndefined();
    const link = (await readLink(f))!;
    expect(link.noVideo).toBe(true);
    expect(parseLink(JSON.stringify(link))?.noVideo).toBe(true);
    await writeFile(f, 'movie/bga.mp4', enc('VIDEO-2'));
    expect((await pushSong(f, { create: false })).sent).toBe(0);
    expect(drive.byPath('DTX Web Editor/Mephisto/movie/bga.mp4')).toBeUndefined();
  });

  it('送らない印：読めて、つなぎの記録ではない', async () => {
    const f = song({ 'ext.dtx': 'v1' });
    expect(await readDriveSkip(f)).toBe(false);
    await writeDriveSkip(f);
    expect(await readDriveSkip(f)).toBe(true);
    expect(await readLink(f)).toBeNull();
    expect(isSkipText('{"v":1,"skip":true,"folderId":"abc"}')).toBe(false);
    expect(isSkipText('not json')).toBe(false);
    // 押して送ると、つなぎの記録で上書きされて印は消える
    await pushSong(f, { create: true });
    expect(await readDriveSkip(f)).toBe(false);
    expect((await readLink(f))?.folderId).toBeTruthy();
  });

  it('変わっていなければ何も送らず、変えたファイルだけ上書きする', async () => {
    const f = song({ 'ext.dtx': 'v1', 'bgm.ogg': 'BGM' });
    await pushSong(f, { create: true });
    const id = drive.byPath('DTX Web Editor/Mephisto/ext.dtx')!.id;
    drive.calls = [];
    expect((await pushSong(f, { create: false })).sent).toBe(0);
    expect(drive.calls.filter((c) => c.includes('upload'))).toEqual([]);
    await writeFile(f, 'ext.dtx', enc('v2'));
    const r = await pushSong(f, { create: false });
    expect(r.sent).toBe(1);
    expect(drive.byPath('DTX Web Editor/Mephisto/ext.dtx')!.id).toBe(id);
    expect(drive.files.get(id)!.content).toEqual(enc('v2'));
  });

  it('ほかの端末で保存した物は、送るときに知らせ、取り込むと入る', async () => {
    const f = song({ 'ext.dtx': 'v1', 'bgm.ogg': 'BGM' });
    await pushSong(f, { create: true });
    const dtx = drive.byPath('DTX Web Editor/Mephisto/ext.dtx')!;
    drive.setContent(dtx.id, enc('from PC'));
    drive.add({ name: 'bass.ogg', parents: [drive.byPath('DTX Web Editor/Mephisto')!.id], content: enc('BASS') });
    const link = (await readLink(f))!;
    expect((await remoteChanges(f, link)).newer.sort()).toEqual(['bass.ogg', 'ext.dtx']);
    const r = await pushSong(f, { create: false });
    expect(r.newer.sort()).toEqual(['bass.ogg', 'ext.dtx']);
    expect(drive.files.get(dtx.id)!.content).toEqual(enc('from PC'));
    const p = await pullSong(f, (await readLink(f))!);
    expect(p.got).toBe(2);
    expect(await text(f, 'ext.dtx')).toBe('from PC');
    expect(await text(f, 'bass.ogg')).toBe('BASS');
    expect((await remoteChanges(f, (await readLink(f))!)).newer).toEqual([]);
  });

  it('両方で変わったファイルは聞く：この端末の方を送る／送らない', async () => {
    const f = song({ 'ext.dtx': 'v1' });
    await pushSong(f, { create: true });
    const dtx = drive.byPath('DTX Web Editor/Mephisto/ext.dtx')!;
    drive.setContent(dtx.id, enc('PC'));
    await writeFile(f, 'ext.dtx', enc('iPad'));
    const asked: string[][] = [];
    const skip = await pushSong(f, { create: false, resolve: async (p) => (asked.push(p), null) });
    expect(asked).toEqual([['ext.dtx']]);
    expect(skip.conflicts).toEqual(['ext.dtx']);
    expect(drive.files.get(dtx.id)!.content).toEqual(enc('PC'));
    const mine = await pushSong(f, { create: false, resolve: async () => 'mine' });
    expect(mine.sent).toBe(1);
    expect(drive.files.get(dtx.id)!.content).toEqual(enc('iPad'));
  });

  it('自動保存：ファイルが変わっていなければ控えだけ送り、どの版への続きかを書く', async () => {
    const f = song({ 'ext.dtx': 'v1', 'bgm.ogg': 'BGM' });
    await pushSong(f, { create: true });
    drive.calls = [];
    await pushSong(f, { create: false, quick: true, autosave: { fileName: 'ext.dtx', text: '#TITLE edited', savedAt: 5 } });
    expect(drive.calls.some((c) => c.startsWith('GET /drive/v3/files/') && !c.endsWith('media'))).toBe(false);
    const a = drive.byPath('DTX Web Editor/Mephisto/.dtxe-autosave/ext.dtx.json')!;
    const body = JSON.parse(new TextDecoder().decode(a.content));
    expect(body).toMatchObject({ v: 1, fileName: 'ext.dtx', text: '#TITLE edited', base: md5(enc('v1')) });
    // 2回目は同じファイルを上書き
    await pushSong(f, { create: false, quick: true, autosave: { fileName: 'ext.dtx', text: '#TITLE edited 2', savedAt: 6 } });
    expect([...drive.files.values()].filter((x) => x.name === 'ext.dtx.json')).toHaveLength(1);
  });

  it('ほかの端末：空の曲フォルダに全部取ってきて、自動保存も読める', async () => {
    const pc = song({ 'ext.dtx': 'v1', 'stems/drums.ogg': 'D' });
    await pushSong(pc, { create: true, autosave: { fileName: 'ext.dtx', text: 'unsaved', savedAt: 9 } });
    const songId = (await listDriveSongs())[0].id;
    const ipad = song({}, 'Mephisto');
    ipad.local = 'L2';
    const r = await pullSong(ipad, newLink(songId, 'Mephisto'));
    expect(r.got).toBe(2);
    expect(await text(ipad, 'stems/drums.ogg')).toBe('D');
    const autos = await readAutosaves(r.tree);
    expect(autos.get('ext.dtx')).toMatchObject({ text: 'unsaved', base: md5(enc('v1')) });
    expect(r.link.files['ext.dtx'].md5).toBe(md5(enc('v1')));
    // 取ってきた後は、送る物も取る物も無い
    expect((await pushSong(ipad, { create: false })).sent).toBe(0);
  });

  it('Drive に同じ名前の曲があれば聞く：合わせると同じファイルは送らない', async () => {
    await pushSong(song({ 'ext.dtx': 'v1', 'bgm.ogg': 'BGM' }), { create: true });
    const other = song({ 'ext.dtx': 'v1', 'bgm.ogg': 'BGM', 'new.ogg': 'N' });
    const r = await pushSong(other, { create: true, sameName: async () => 'join' });
    expect(r.sent).toBe(1);
    expect((await listDriveSongs()).length).toBe(1);
    const sep = await pushSong(song({ 'ext.dtx': 'x' }), { create: true, sameName: async () => 'new' });
    expect(sep.link!.name).toBe('Mephisto (2)');
  });

  it('Drive で曲フォルダを消したら：自動保存ではつながず、保存のときに作り直す', async () => {
    const f = song({ 'ext.dtx': 'v1' });
    await pushSong(f, { create: true });
    const folderId = (await readLink(f))!.folderId;
    drive.files.get(folderId)!.trashed = true;
    expect((await pushSong(f, { create: false })).skipped).toBe(true);
    const r = await pushSong(f, { create: true });
    expect(r.sent).toBe(1);
    expect(r.link!.folderId).not.toBe(folderId);
  });

  it('PC どうしの同期が片付けた曲（同じ曲が Drive に 2 つ）：保存のときに残した方へつなぎ直し、違うファイルは聞く', async () => {
    const f = song({ 'ext.dtx': 'v1', 'bgm.ogg': 'BGM' });
    await pushSong(f, { create: true });
    const old = (await readLink(f))!.folderId;
    // 残した方（DTXFiles の中。譜面はほかの PC で直した）
    const lib = drive.add({ name: 'DTXFiles', parents: [drive.files.get(old)!.parents[0]], appProperties: { dtxe: 'lib' } });
    const keep = drive.add({ name: 'Mephisto', parents: [lib.id], appProperties: { dtxe: 'song' } });
    drive.add({ name: 'ext.dtx', parents: [keep.id], content: enc('v2') });
    drive.add({ name: 'bgm.ogg', parents: [keep.id], content: enc('BGM') });
    drive.files.get(old)!.appProperties = { ...drive.files.get(old)!.appProperties, dup: keep.id };
    drive.trash(old);
    // 自動保存ではつながない
    expect((await pushSong(f, { create: false })).skipped).toBe(true);
    const asked: string[][] = [];
    const r = await pushSong(f, { create: true, resolve: async (paths) => (asked.push(paths), null) });
    expect(r.link!.folderId).toBe(keep.id);
    expect((await readLink(f))!.folderId).toBe(keep.id);
    expect(asked).toEqual([['ext.dtx']]);
    expect(r.sent).toBe(0);
    expect((await listDriveSongs()).map((s) => s.id)).toEqual([keep.id]);
  });

  it('ログインが切れていたら DriveAuthError', async () => {
    const f = song({ 'ext.dtx': 'v1' });
    let lost = 0;
    setDriveAuth(async () => 'expired', () => lost++);
    await expect(pushSong(f, { create: true })).rejects.toMatchObject({ name: 'DriveAuthError' });
    expect(lost).toBe(1);
  });
});

describe('曲のファイルだけを合わせる（DTXFiles を曲フォルダとして選んでしまったとき）', () => {
  it('ほかの曲も入ったフォルダは送らない（Drive に何も作らない）', async () => {
    const lib = song({ 'mstr.dtx': 'mine', 'bgm.ogg': 'BGM', 'Mela/mstr.dtx': 'other', 'Mela/bgm.ogg': 'OTHER' }, 'DTXFiles');
    const r = await pushSong(lib, { create: true });
    expect(r.skipped).toBe(true);
    expect(r.notSong).toEqual(['mela']);
    expect(drive.files.size).toBe(0);
    expect(drive.calls).toEqual([]);
  });

  it('ほかの曲も入ったフォルダへは取らない', async () => {
    const lib = song({ 'mstr.dtx': 'v1', 'Mela/mstr.dtx': 'x' }, 'DTXFiles');
    await expect(pullSong(lib, newLink('f1', 'Mephisto'))).rejects.toMatchObject({ name: 'NotSongFolderError' });
  });

  it('Drive の曲フォルダに入ったほかの曲は、新しい内容として知らせず・取らず、ゴミ箱に移せる', async () => {
    const f = song({ 'mstr.dtx': 'v1', 'bgm.ogg': 'BGM', 'stems/drums.ogg': 'D' });
    await pushSong(f, { create: true });
    const songDir = drive.byPath('DTX Web Editor/Mephisto')!;
    // 間違って DTXFiles ごと送られたほかの曲（譜面より先に、小さい成績だけが届いた曲も）
    const mela = drive.add({ name: 'Mela', parents: [songDir.id] });
    drive.add({ name: 'mstr.dtx', parents: [mela.id], content: enc('other chart') });
    drive.add({ name: 'bgm.ogg', parents: [mela.id], content: enc('OTHER BGM') });
    const sounds = drive.add({ name: 'sounds', parents: [mela.id] });
    drive.add({ name: 'kick.wav', parents: [sounds.id], content: enc('K') });
    const calc = drive.add({ name: 'Calc', parents: [songDir.id] });
    drive.add({ name: 'ext.dtx.score.ini', parents: [calc.id], content: enc('score') });
    // つなぎの記録にも、ほかの曲の記録が入っている（送っている途中でファイルを移した）
    const link = (await readLink(f))!;
    link.files['mela/mstr.dtx'] = { id: 'x', md5: 'y', size: 1, mtime: 1, path: 'Mela/mstr.dtx' };
    const rc = await remoteChanges(f, link);
    expect(rc.newer).toEqual([]);
    expect(rc.junk.map((j) => [j.kind, j.path, j.files])).toEqual([
      ['song', 'Calc', 1],
      ['song', 'Mela', 2],
    ]);
    // 送っても・取っても、ほかの曲には触らない（記録からも外す）
    const pushed = await pushSong(f, { create: false });
    expect([pushed.sent, pushed.newer, pushed.junk.length]).toEqual([0, [], 2]);
    expect((await readLink(f))!.files['mela/mstr.dtx']).toBeUndefined();
    const pulled = await pullSong(f, (await readLink(f))!);
    expect(pulled.got).toBe(0);
    expect([...f.files.keys()].some((k) => k.startsWith('mela/') || k.startsWith('calc/'))).toBe(false);
    // ゴミ箱へ（この曲のファイルはそのまま）
    expect(await trashJunk(pushed.junk, { folder: f, link: (await readLink(f))! })).toBe(2);
    expect(drive.files.get(mela.id)!.trashed).toBe(true);
    expect(drive.files.get(calc.id)!.trashed).toBe(true);
    expect((await listTree(songDir.id)).junk).toEqual([]);
    expect(drive.byPath('DTX Web Editor/Mephisto/stems/drums.ogg')).toBeTruthy();
    expect(drive.byPath('DTX Web Editor/Mephisto/bgm.ogg')).toBeTruthy();
  });

  it('この端末に無いもの：丸ごと無いフォルダはフォルダで、ほかはファイルで', async () => {
    const f = song({ 'mstr.dtx': 'v1', 'stems/drums.ogg': 'D' });
    await pushSong(f, { create: true });
    const songDir = drive.byPath('DTX Web Editor/Mephisto')!;
    drive.add({ name: 'bass.ogg', parents: [drive.byPath('DTX Web Editor/Mephisto/stems')!.id], content: enc('B') });
    const extra = drive.add({ name: 'Extra', parents: [songDir.id] });
    drive.add({ name: 'a.wav', parents: [extra.id], content: enc('AA') });
    drive.add({ name: 'b.wav', parents: [extra.id], content: enc('BBB') });
    drive.add({ name: 'memo.txt', parents: [songDir.id], content: enc('m') });
    const tree = await listTree(songDir.id);
    expect(extrasOf(f, tree).map((j) => [j.kind, j.path, j.files, j.bytes])).toEqual([
      ['dir', 'Extra', 2, 5],
      ['file', 'memo.txt', 1, 1],
      ['file', 'stems/bass.ogg', 1, 1],
    ]);
    await trashJunk(extrasOf(f, tree), { folder: f, link: (await readLink(f))! });
    expect(extrasOf(f, await listTree(songDir.id))).toEqual([]);
    expect(drive.byPath('DTX Web Editor/Mephisto/stems/drums.ogg')).toBeTruthy();
  });
});
