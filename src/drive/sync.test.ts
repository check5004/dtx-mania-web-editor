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
const { LINK_FILE, listDriveSongs, newLink, planSync, pullSong, pushSong, readAutosaves, readLink, remoteChanges, forgetRoot } = await import('./sync');
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
    expect((await remoteChanges(f, link)).sort()).toEqual(['bass.ogg', 'ext.dtx']);
    const r = await pushSong(f, { create: false });
    expect(r.newer.sort()).toEqual(['bass.ogg', 'ext.dtx']);
    expect(drive.files.get(dtx.id)!.content).toEqual(enc('from PC'));
    const p = await pullSong(f, (await readLink(f))!);
    expect(p.got).toBe(2);
    expect(await text(f, 'ext.dtx')).toBe('from PC');
    expect(await text(f, 'bass.ogg')).toBe('BASS');
    expect(await remoteChanges(f, (await readLink(f))!)).toEqual([]);
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

  it('ログインが切れていたら DriveAuthError', async () => {
    const f = song({ 'ext.dtx': 'v1' });
    let lost = 0;
    setDriveAuth(async () => 'expired', () => lost++);
    await expect(pushSong(f, { create: true })).rejects.toMatchObject({ name: 'DriveAuthError' });
    expect(lost).toBe(1);
  });
});
