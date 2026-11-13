// PC どうしの同期を通しで確かめる：偽の Drive（fakeDrive）と、2 台の PC の DTXFiles（メモリのフォルダ）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDrive } from '../drive/fakeDrive.testutil';
import { MemDirHandle, now, tick } from './memfs.testutil';

const { setDriveAuth } = await import('../drive/api');
const { forgetRoot, parseLink } = await import('../drive/sync');
const { runSync, restoreBackup, stopSong } = await import('./engine');
const { DEFAULT_SETTINGS, emptyState } = await import('./types');
type LibAccess = import('./engine').LibAccess;
type LibSongRef = import('./engine').LibSongRef;
type SyncState = import('./types').SyncState;
type SyncSettings = import('./types').SyncSettings;
type RunReport = import('./types').RunReport;

let drive: FakeDrive;

beforeEach(() => {
  drive = new FakeDrive(() => tick(1000));
  vi.stubGlobal('fetch', drive.fetch);
  setDriveAuth(async () => drive.token, () => {});
  forgetRoot();
});

/** NX のように曲のフォルダを探す（譜面か set.def があるフォルダ。box.def のフォルダは BOX） */
async function scan(root: MemDirHandle): Promise<LibSongRef[]> {
  const out: LibSongRef[] = [];
  const walk = async (d: MemDirHandle, path: string[]) => {
    const names = [...d.files.keys()];
    const charts = names.filter((n) => /\.dtx$/i.test(n));
    if (charts.length || names.some((n) => n.toLowerCase() === 'set.def')) {
      const link = d.files.get('.dtxe-drive.json');
      const text = link ? new TextDecoder().decode(link.data) : '';
      const drive = parseLink(text) ? 'linked' : text.includes('"skip":true') ? 'skip' : null;
      out.push({ root: '', path, title: path[path.length - 1], artist: 'Demo', bpm: '150', edited: names.some((n) => n.endsWith('.dtxe.json')), drive, charts: charts.length, updated: 0 });
    }
    for (const [n, s] of d.dirs) await walk(s, [...path, n]);
  };
  await walk(root, []);
  return out;
}

interface Pc {
  name: string;
  root: MemDirHandle;
  state: SyncState;
  settings: SyncSettings;
  open?: MemDirHandle;
  /** 一覧を読み直すように知らせた曲のフォルダ */
  touched: string[];
}

function pc(name: string, o: Partial<SyncSettings> = {}): Pc {
  return { name, root: new MemDirHandle('DTXFiles'), state: emptyState(), touched: [], settings: { ...DEFAULT_SETTINGS, on: true, pc: name, pcId: name.toLowerCase(), ...o } };
}

async function libOf(p: Pc): Promise<LibAccess> {
  return {
    songs: await scan(p.root),
    rootDir: async () => p.root as unknown as FileSystemDirectoryHandle,
    libPath: (_r, path) => [...path],
    placeOf: (lib) => ({ root: '', path: [...lib] }),
    isOpen: async (dir) => !!p.open && (dir as unknown) === p.open,
    touched: (_root, path) => p.touched.push(path.join('/')),
  };
}

async function sync(p: Pc, o: { dry?: boolean; why?: RunReport['why']; only?: string } = {}): Promise<RunReport> {
  return runSync({ settings: p.settings, lib: await libOf(p), state: p.state, why: o.why ?? 'manual', dry: o.dry, now, ...(o.only ? { only: { root: '', path: o.only.split('/') } } : {}) });
}

/** NX が書く score.ini（ドラムだけ） */
function score(plays: number, hi: number, last: string, hist: string[] = []) {
  return [
    '[File]',
    'Title=Neon Skyline',
    `PlayCountDrums=${plays}`,
    `ClearCountDrums=${plays}`,
    'BestRankDrums=2',
    `HistoryCount=${plays}`,
    ...[0, 1, 2, 3, 4].map((i) => `History${i}=${hist[i] ?? ''}`),
    'BGMAdjust=0',
    '',
    '[HiScore.Drums]',
    `Score=${hi}`,
    'PlaySkill=80',
    '[HiSkill.Drums]',
    `Score=${hi}`,
    'PlaySkill=80',
    '[LastPlay.Drums]',
    `Score=${hi}`,
    `DateTime=${last}`,
    '',
  ].join('\r\n');
}

const SONG = 'オリジナル/Neon Skyline';
const LIB = 'DTX Web Editor/DTXFiles';

function makeSong(p: Pc) {
  p.root.put('オリジナル/box.def', '#TITLE オリジナル\r\n');
  p.root.put(`${SONG}/set.def`, '#TITLE Neon Skyline\r\n#L4LABEL MASTER\r\n#L4FILE mstr.dtx\r\n');
  p.root.put(`${SONG}/mstr.dtx`, '#TITLE Neon Skyline\r\n#BPM 150\r\n');
  p.root.put(`${SONG}/adv.dtx`, '#TITLE Neon Skyline\r\n#DLEVEL 50\r\n');
  p.root.put(`${SONG}/bgm.ogg`, 'OGG-DATA');
  p.root.put(`${SONG}/mstr.dtxe.json`, '{"v":1}');
}

describe('PC どうしの同期（作るPC と 遊ぶPC）', () => {
  it('作るPC の曲を Drive の DTXFiles/<BOX>/<曲> に送り、遊ぶPC に同じ BOX で取る（box.def も）', async () => {
    const make = pc('作るPC');
    makeSong(make);
    // 直していない曲は送らない（作った曲だけ）
    make.root.put('J-POP/Other/other.dtx', '#TITLE Other');
    const r1 = await sync(make);
    expect(r1.songs.map((s) => [s.lib, s.where, s.sent.length])).toEqual([[SONG, 'new', 5]]);
    expect(drive.tree(LIB)).toEqual(['オリジナル/Neon Skyline/adv.dtx', 'オリジナル/Neon Skyline/bgm.ogg', 'オリジナル/Neon Skyline/mstr.dtx', 'オリジナル/Neon Skyline/mstr.dtxe.json', 'オリジナル/Neon Skyline/set.def', 'オリジナル/box.def']);
    // 曲のフォルダに印（iPad の「Drive から開く」でも見つかる）
    expect(drive.byPath(`${LIB}/${SONG}`)?.appProperties?.dtxe).toBe('song');
    // 送っただけでも、一覧を読み直す（「同期する曲」の印が付く）
    expect(make.touched).toEqual([SONG]);

    const play = pc('遊ぶPC');
    // 下見：何も書かずに、取る曲を出す
    const dry = await sync(play, { dry: true, why: 'first' });
    expect(dry.songs.map((s) => [s.lib, s.where, s.got.length])).toEqual([[SONG, 'none', 5]]);
    expect(play.root.list()).toEqual([]);
    await sync(play, { why: 'first' });
    expect(play.root.list()).toEqual(['オリジナル/Neon Skyline/.dtxe-drive.json', 'オリジナル/Neon Skyline/adv.dtx', 'オリジナル/Neon Skyline/bgm.ogg', 'オリジナル/Neon Skyline/mstr.dtx', 'オリジナル/Neon Skyline/mstr.dtxe.json', 'オリジナル/Neon Skyline/set.def', 'オリジナル/box.def']);
    expect(play.root.read('オリジナル/box.def')).toBe('#TITLE オリジナル\r\n');
  });

  it('同期しないまま作る・遊ぶが進んでも、譜面は作るPC から、成績は遊ぶPC から届く（聞かない）', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    // 同時に進む：作るPC は MASTER を直し、遊ぶPC は遊んだ（成績とゴーストを NX が書く）
    make.root.put(`${SONG}/mstr.dtx`, '#TITLE Neon Skyline\r\n#BPM 150\r\n#00111: 01\r\n');
    play.root.put(`${SONG}/mstr.dtx.score.ini`, score(1, 845100, '2026/11/13 21:40:00', ['1.26/11/13 Cleared (S)']));
    play.root.put(`${SONG}/mstr.dtx.hiscore.dr.ghost`, 'GHOST-PLAY');
    const r1 = await sync(play);
    expect(r1.songs[0].scoresSent).toEqual(['mstr.dtx']);
    const r2 = await sync(make);
    expect(r2.songs[0].sent).toEqual(['mstr.dtx']);
    expect(r2.songs[0].scoresGot).toEqual(['mstr.dtx']);
    expect(r2.asks).toEqual([]);
    const r3 = await sync(play);
    expect(r3.songs[0].got).toEqual(['mstr.dtx']);
    expect(play.root.read(`${SONG}/mstr.dtx`)).toContain('#00111: 01');
    expect(make.root.read(`${SONG}/mstr.dtx.score.ini`)).toContain('PlayCountDrums=1');
    expect(make.root.read(`${SONG}/mstr.dtx.hiscore.dr.ghost`)).toBe('GHOST-PLAY');
  });

  it('両方の PC で遊んだら、成績をまとめる（回数は足し、いい記録は良い方。ゴーストはその方から）', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    make.root.put(`${SONG}/mstr.dtx.score.ini`, score(5, 700000, '2026/11/10 20:00:00', ['5.26/11/10 Cleared']));
    make.root.put(`${SONG}/mstr.dtx.hiscore.dr.ghost`, 'GHOST-OLD');
    await sync(make);
    await sync(play);
    // 作るPC で 2 回（点は低い）、遊ぶPC で 4 回（いい点）
    make.root.put(`${SONG}/mstr.dtx.score.ini`, score(7, 650000, '2026/11/12 23:05:00', ['7.26/11/12 Failed', '6.26/11/12 Failed', '5.26/11/10 Cleared']));
    make.root.put(`${SONG}/mstr.dtx.lastplay.dr.ghost`, 'LAST-MAKE');
    play.root.put(`${SONG}/mstr.dtx.score.ini`, score(9, 845100, '2026/11/13 21:40:00', ['9.26/11/13 Cleared (S)', '8.26/11/13 Cleared', '7.26/11/11 Cleared', '6.26/11/11 Cleared', '5.26/11/10 Cleared']));
    play.root.put(`${SONG}/mstr.dtx.hiscore.dr.ghost`, 'GHOST-PLAY');
    play.root.put(`${SONG}/mstr.dtx.lastplay.dr.ghost`, 'LAST-PLAY');
    await sync(make);
    const r = await sync(play);
    expect(r.songs[0].merged).toEqual([{ chart: 'mstr.dtx', plays: 2 }]);
    await sync(make);
    for (const p of [make, play]) {
      const t = p.root.read(`${SONG}/mstr.dtx.score.ini`)!;
      expect(t).toContain('PlayCountDrums=11');
      expect(t).toContain('Score=845100');
      expect(t).toContain('DateTime=2026/11/13 21:40:00');
      expect(t).toContain('History0=11.26/11/13 Cleared (S)');
      expect(p.root.read(`${SONG}/mstr.dtx.hiscore.dr.ghost`)).toBe('GHOST-PLAY');
      expect(p.root.read(`${SONG}/mstr.dtx.lastplay.dr.ghost`)).toBe('LAST-PLAY');
    }
  });

  it('初めての同期で両方に成績があったら、回数は多い方に（同じ回数を 2 回数えない）。いい記録は良い方', async () => {
    const make = pc('作るPC');
    makeSong(make);
    make.root.put(`${SONG}/mstr.dtx.score.ini`, score(2, 500000, '2026/11/10 20:00:00', ['2.26/11/10 Cleared', '1.26/11/10 Cleared']));
    await sync(make, { why: 'first' });
    // 前に USB で写した曲（写したあとに 3 回遊んだ）
    const play = pc('遊ぶPC');
    makeSong(play);
    play.root.put(`${SONG}/mstr.dtx.score.ini`, score(5, 600000, '2026/11/12 21:00:00', ['5.26/11/12 Cleared', '4.26/11/12 Cleared', '3.26/11/11 Cleared']));
    const r = await sync(play, { why: 'first' });
    expect(r.songs[0].merged).toEqual([{ chart: 'mstr.dtx', plays: 0, max: true }]);
    const ini = play.root.read(`${SONG}/mstr.dtx.score.ini`);
    expect(ini).toContain('PlayCountDrums=5');
    expect(ini).toContain('Score=600000');
  });

  it('両方で同じ譜面を直したら新しい方を残し、もう一方は控えへ（控えから戻せる）', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    make.root.put(`${SONG}/adv.dtx`, 'ADV-BY-MAKE');
    play.root.put(`${SONG}/adv.dtx`, 'ADV-BY-PLAY'); // あとで直した
    await sync(make);
    const r = await sync(play);
    expect(r.songs[0].newer.map((n) => [n.path, n.kept, n.dev])).toEqual([['adv.dtx', 'local', '作るPC']]);
    await sync(make);
    expect(make.root.read(`${SONG}/adv.dtx`)).toBe('ADV-BY-PLAY');
    // 作るPC の版は Drive の控えに
    const bak = drive.tree('DTX Web Editor/控え');
    expect(bak).toHaveLength(1);
    expect(bak[0]).toMatch(/^\d{4}-\d{2}-\d{2}\/Neon Skyline\/adv\.dtx$/);
    expect(drive.text(`DTX Web Editor/控え/${bak[0]}`)).toBe('ADV-BY-MAKE');
    // 戻す：控えの版を新しい方として送る。どちらの PC もその版になる
    const driveId = r.songs[0].driveId;
    await restoreBackup({ lib: await libOf(play), state: play.state, settings: play.settings, driveId, path: 'adv.dtx', backupId: r.songs[0].newer[0].backup! });
    expect(play.root.read(`${SONG}/adv.dtx`)).toBe('ADV-BY-MAKE');
    await sync(make);
    expect(make.root.read(`${SONG}/adv.dtx`)).toBe('ADV-BY-MAKE');
  });

  it('両方で直して、あとで同期した PC の版が古いとき：Drive の版を取って控えへ。先に送った PC は送り直さない', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    play.root.put(`${SONG}/adv.dtx`, 'ADV-BY-PLAY'); // 先に直した
    make.root.put(`${SONG}/adv.dtx`, 'ADV-BY-MAKE'); // あとで直した
    const r1 = await sync(make);
    expect(r1.songs[0].sent).toEqual(['adv.dtx']);
    const r2 = await sync(play);
    expect(r2.songs[0].newer.map((n) => [n.path, n.kept, n.dev])).toEqual([['adv.dtx', 'remote', '作るPC']]);
    expect(play.root.read(`${SONG}/adv.dtx`)).toBe('ADV-BY-MAKE');
    // 作るPC：何も変わっていない
    const r3 = await sync(make);
    expect(r3.songs).toEqual([]);
    const r4 = await sync(play);
    expect(r4.songs).toEqual([]);
  });

  it('この PC で消したファイルは Drive でゴミ箱へ、ほかの PC でも消える（成績は消さない）', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    make.root.put(`${SONG}/old.wav`, 'WAV');
    make.root.put(`${SONG}/mstr.dtx.score.ini`, score(1, 1, ''));
    await sync(make);
    await sync(play);
    make.root.remove(`${SONG}/old.wav`);
    make.root.remove(`${SONG}/mstr.dtx.score.ini`);
    const r1 = await sync(make);
    expect(r1.songs[0].trashed).toEqual(['old.wav']);
    // 成績は消さずに取り直す
    expect(make.root.has(`${SONG}/mstr.dtx.score.ini`)).toBe(true);
    const r2 = await sync(play);
    expect(r2.songs[0].deleted).toEqual(['old.wav']);
    expect(play.root.has(`${SONG}/old.wav`)).toBe(false);
  });

  it('一度にたくさん消えていたら、消さずに戻す', async () => {
    const make = pc('作るPC');
    makeSong(make);
    await sync(make);
    // 譜面を 1 つ残す（曲のフォルダのまま）
    for (const f of ['adv.dtx', 'bgm.ogg', 'set.def', 'mstr.dtxe.json']) make.root.remove(`${SONG}/${f}`);
    const r = await sync(make);
    expect(r.songs[0].trashed).toEqual([]);
    expect(r.songs[0].kept).toBe(4);
    expect(make.root.has(`${SONG}/bgm.ogg`)).toBe(true);
  });

  it('DTXMania が開いていて書けないファイルは、次の同期で', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    make.root.put(`${SONG}/bgm.ogg`, 'OGG-NEW');
    await sync(make);
    play.root.dirAt(SONG).locked.add('bgm.ogg');
    const r = await sync(play);
    expect(r.songs[0].later).toEqual(['bgm.ogg']);
    expect(play.root.read(`${SONG}/bgm.ogg`)).toBe('OGG-DATA');
    play.root.dirAt(SONG).locked.clear();
    // Drive では変わっていないが、この PC の記録が前のままなので取り直す
    const r2 = await sync(play);
    expect(r2.songs[0].got).toEqual(['bgm.ogg']);
    expect(play.root.read(`${SONG}/bgm.ogg`)).toBe('OGG-NEW');
  });

  it('変わっていなければ、Drive の曲の中を読み直さない（changes で見る）', async () => {
    const make = pc('作るPC');
    makeSong(make);
    await sync(make);
    await sync(make);
    drive.calls = [];
    const r = await sync(make, { why: 'timer' });
    expect(r.songs).toEqual([]);
    // 変化を聞く・曲の一覧を読むだけ（曲のフォルダの中は読まない）
    const lists = drive.calls.filter((c) => c === 'GET /drive/v3/files');
    expect(lists.length).toBeLessThanOrEqual(4);
    expect(drive.calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH'))).toBe(false);
  });

  it('初めての同期で、この PC の版がほかの PC の譜面を置きかえるときは聞く', async () => {
    const make = pc('作るPC');
    makeSong(make);
    await sync(make);
    // USB で前に写した曲（譜面を少し直して新しい）
    const play = pc('遊ぶPC');
    makeSong(play);
    play.root.put(`${SONG}/adv.dtx`, 'ADV-LOCAL-NEWER');
    play.root.put(`${SONG}/mstr.dtx`, '#TITLE Neon Skyline\r\n#BPM 150\r\n'); // 同じ中身
    const dry = await sync(play, { dry: true, why: 'first' });
    expect(dry.asks.map((a) => [a.kind, a.kind === 'file' ? a.path : ''])).toEqual([['file', 'adv.dtx']]);
    // 答えるまでは、そのファイルは何もしない
    await sync(play, { why: 'first' });
    expect(drive.text(`${LIB}/${SONG}/adv.dtx`)).toContain('#DLEVEL 50');
    play.state.answers[dry.asks[0].id] = 'mine';
    const r = await sync(play);
    expect(r.songs[0].newer.map((n) => n.kept)).toEqual(['local']);
    expect(drive.text(`${LIB}/${SONG}/adv.dtx`)).toBe('ADV-LOCAL-NEWER');
  });

  it('iPad で作った曲（Drive の直下）は、選んだ BOX に取り、Drive でもその BOX へ動かす', async () => {
    const root = drive.add({ name: 'DTX Web Editor', parents: ['root'], appProperties: { dtxe: 'root' } });
    const song = drive.add({ name: 'Paper Moon', parents: [root.id], appProperties: { dtxe: 'song' }, description: JSON.stringify({ t: 'Paper Moon', a: 'iPad' }) });
    drive.add({ name: 'paper.dtx', parents: [song.id], content: new TextEncoder().encode('#TITLE Paper Moon') });
    const play = pc('遊ぶPC', { importBox: 'オリジナル' });
    await sync(play);
    expect(play.root.read('オリジナル/Paper Moon/paper.dtx')).toBe('#TITLE Paper Moon');
    expect(drive.byPath(`${LIB}/オリジナル/Paper Moon/paper.dtx`)).toBeTruthy();
  });

  it('開いている曲は、この PC の譜面を書きかえない（成績は合わせる）', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    make.root.put(`${SONG}/mstr.dtx`, 'MSTR-NEW');
    make.root.put(`${SONG}/mstr.dtx.score.ini`, score(3, 1, ''));
    await sync(make);
    play.open = play.root.dirAt(SONG);
    const r = await sync(play);
    expect(r.songs[0].wait).toEqual(['mstr.dtx']);
    expect(r.songs[0].scoresGot).toEqual(['mstr.dtx']);
    expect(play.root.read(`${SONG}/mstr.dtx`)).not.toBe('MSTR-NEW');
    play.open = undefined;
    await sync(play);
    expect(play.root.read(`${SONG}/mstr.dtx`)).toBe('MSTR-NEW');
  });

  it('場所が違って曲名とアーティストが同じなら、同じ曲か聞く（答えるまで送りも取りもしない）', async () => {
    const make = pc('作るPC');
    makeSong(make);
    await sync(make);
    const play = pc('遊ぶPC');
    play.root.put('Neon Skyline/mstr.dtx', '#TITLE Neon Skyline');
    play.root.put('Neon Skyline/mstr.dtxe.json', '{}');
    const dry = await sync(play, { dry: true, why: 'first' });
    expect(dry.asks.map((a) => a.kind)).toEqual(['same']);
    play.state.answers[dry.asks[0].id] = 'join';
    await sync(play);
    // 同じ曲：この PC の場所のまま合わせる（BOX の外に、Drive の曲のファイルが届く）
    expect(play.root.has('Neon Skyline/bgm.ogg')).toBe(true);
    expect(play.root.has('オリジナル/Neon Skyline/mstr.dtx')).toBe(false);
  });

  it('ほかの PC で同期から外した曲（Drive のゴミ箱）：この PC の曲は残し、同期からも外す', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    const r = await sync(make);
    await sync(play);
    drive.trash(r.songs[0].driveId);
    await sync(play);
    expect(play.root.has(`${SONG}/mstr.dtx`)).toBe(true);
    expect(play.root.read(`${SONG}/.dtxe-drive.json`)).toContain('"skip":true');
  });

  it('曲のフォルダごと消して「ほかの PC でも消す」：ほかの PC でも、前のままなら消す（直していたら残す）', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    const note = pc('ノートPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    await sync(note);
    // ノートPC では直していた
    note.root.put(`${SONG}/adv.dtx`, 'ADV-NOTE');
    make.root.remove(SONG);
    const r = await sync(make);
    expect(r.asks.map((a) => a.kind)).toEqual(['gone']);
    make.state.answers[r.asks[0].id] = 'trash';
    await sync(make);
    const r2 = await sync(play);
    expect(r2.songs[0].removed).toBe(true);
    expect(play.root.list()).toEqual(['オリジナル/box.def']);
    const r3 = await sync(note);
    expect(r3.songs[0].removed).toBeUndefined();
    expect(note.root.read(`${SONG}/adv.dtx`)).toBe('ADV-NOTE');
    expect(note.root.read(`${SONG}/.dtxe-drive.json`)).toContain('"skip":true');
  });

  it('曲のフォルダが無いとき「Drive から取り直す」：取り直す', async () => {
    const make = pc('作るPC');
    makeSong(make);
    await sync(make);
    make.root.remove(SONG);
    const r = await sync(make);
    make.state.answers[r.asks[0].id] = 'get';
    await sync(make);
    expect(make.root.read(`${SONG}/adv.dtx`)).toContain('#DLEVEL 50');
  });

  it('同期をやめた曲：Drive ではゴミ箱へ、ほかの PC は曲を残して同期から外す', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    await stopSong({ lib: await libOf(make), state: make.state, root: '', path: SONG.split('/') });
    expect(drive.tree(LIB)).toEqual(['オリジナル/box.def']);
    await sync(play);
    expect(play.root.read(`${SONG}/mstr.dtx`)).toContain('#BPM 150');
    expect(play.root.read(`${SONG}/.dtxe-drive.json`)).toContain('"skip":true');
    // 作るPC で直しても、もう送らない
    make.root.put(`${SONG}/mstr.dtx`, 'CHANGED');
    const r = await sync(make);
    expect(r.songs).toEqual([]);
  });

  it('同期しない曲も成績だけ合わせる：両方の PC にある曲の成績をまとめ、無い PC には取らない', async () => {
    const make = pc('作るPC', { scoresOnly: true });
    const play = pc('遊ぶPC', { scoresOnly: true });
    const note = pc('ノートPC', { scoresOnly: true });
    for (const p of [make, play]) {
      p.root.put('J-POP/Sunny/sunny.dtx', '#TITLE Sunny');
      p.root.put('J-POP/Sunny/sunny.wav', 'WAV');
    }
    make.root.put('J-POP/Sunny/sunny.dtx.score.ini', score(2, 500000, '2026/11/12 20:00:00', ['2.26/11/12 Cleared']));
    const r1 = await sync(make);
    expect(r1.songs.map((s) => [s.lib, s.play, s.scoresSent])).toEqual([['J-POP/Sunny', true, ['sunny.dtx']]]);
    // 譜面・音は送らない
    expect(drive.tree(LIB)).toEqual(['J-POP/Sunny/sunny.dtx.score.ini']);
    // 遊ぶPC にも成績が届く
    await sync(play);
    expect(play.root.read('J-POP/Sunny/sunny.dtx.score.ini')).toContain('PlayCountDrums=2');
    // 両方で遊ぶ（作るPC で 2 回、遊ぶPC で 3 回）
    make.root.put('J-POP/Sunny/sunny.dtx.score.ini', score(4, 500000, '2026/11/13 19:00:00', ['4.26/11/13 Cleared', '3.26/11/13 Cleared', '2.26/11/12 Cleared']));
    play.root.put('J-POP/Sunny/sunny.dtx.score.ini', score(5, 600000, '2026/11/13 20:00:00', ['5.26/11/13 Cleared', '4.26/11/13 Cleared', '3.26/11/13 Cleared', '2.26/11/12 Cleared']));
    await sync(make);
    const r2 = await sync(play);
    expect(r2.songs[0].news).toEqual([{ chart: 'sunny.dtx', plays: 2, best: false, rank: 'A', skill: 80, merged: true }]);
    await sync(make);
    expect(make.root.read('J-POP/Sunny/sunny.dtx.score.ini')).toContain('PlayCountDrums=7');
    // 曲の無い PC には成績だけの曲を取らない
    await sync(note);
    expect(note.root.list()).toEqual([]);
  });

  it('曲の無い成績だけの曲は Drive に作らない（まだ遊んでいない）', async () => {
    const make = pc('作るPC', { scoresOnly: true });
    make.root.put('J-POP/Sunny/sunny.dtx', '#TITLE Sunny');
    await sync(make);
    expect(drive.tree(LIB)).toEqual([]);
    expect(make.root.has('J-POP/Sunny/.dtxe-drive.json')).toBe(false);
  });

  it('設定を変えたら（動画も送る）、Drive の曲の中を読み直して足りない物を取る', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC', { video: false });
    makeSong(make);
    make.root.put(`${SONG}/movie.mp4`, 'MP4');
    await sync(make);
    await sync(play);
    expect(play.root.has(`${SONG}/movie.mp4`)).toBe(false);
    await sync(play, { why: 'timer' });
    play.settings = { ...play.settings, video: true };
    const r = await sync(play, { why: 'timer' });
    expect(r.songs[0].got).toEqual(['movie.mp4']);
    // 同じ名前のファイルを Drive にもう 1 つ作らない
    expect(drive.tree(LIB).filter((f) => f.endsWith('movie.mp4'))).toHaveLength(1);
  });

  it('PC の時計がずれていたら、両方で直した譜面の新しい方を決めずに聞く', async () => {
    drive = new FakeDrive(() => tick(1000) + 10 * 60_000);
    vi.stubGlobal('fetch', drive.fetch);
    setDriveAuth(async () => drive.token, () => {});
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    await sync(make);
    await sync(play);
    make.root.put(`${SONG}/adv.dtx`, 'ADV-BY-MAKE');
    play.root.put(`${SONG}/adv.dtx`, 'ADV-BY-PLAY');
    await sync(make);
    const r = await sync(play);
    expect(r.asks.map((a) => (a.kind === 'file' ? [a.why, a.path] : a.kind))).toEqual([['clock', 'adv.dtx']]);
    expect(play.root.read(`${SONG}/adv.dtx`)).toBe('ADV-BY-PLAY');
    expect(drive.text(`${LIB}/${SONG}/adv.dtx`)).toBe('ADV-BY-MAKE');
    play.state.answers[r.asks[0].id] = 'theirs';
    await sync(play);
    expect(play.root.read(`${SONG}/adv.dtx`)).toBe('ADV-BY-MAKE');
  });

  it('保存したとき（1 曲だけ）は、ほかの曲の Drive の変化を次の同期に残す', async () => {
    const make = pc('作るPC');
    const play = pc('遊ぶPC');
    makeSong(make);
    make.root.put('オリジナル/Second/second.dtx', '#TITLE Second');
    make.root.put('オリジナル/Second/second.dtxe.json', '{}');
    await sync(make);
    await sync(play);
    make.root.put('オリジナル/Second/second.dtx', '#TITLE Second\r\n#BPM 99');
    await sync(make);
    play.root.put(`${SONG}/mstr.dtx`, 'SAVED-ON-PLAY');
    const r1 = await sync(play, { why: 'save', only: SONG });
    expect(r1.songs.map((s) => [s.lib, s.sent])).toEqual([[SONG, ['mstr.dtx']]]);
    const r2 = await sync(play, { why: 'timer' });
    expect(r2.songs.map((s) => [s.lib, s.got])).toEqual([['オリジナル/Second', ['second.dtx']]]);
  });

  it('答えていない「確かめてほしい」は、次の同期でも聞き続ける（勝手に決めない・Drive に同じファイルを作らない）', async () => {
    const make = pc('作るPC');
    makeSong(make);
    await sync(make);
    const play = pc('遊ぶPC');
    makeSong(play);
    play.root.put(`${SONG}/adv.dtx`, 'ADV-LOCAL-NEWER');
    await sync(play, { why: 'first' });
    for (let i = 0; i < 2; i++) {
      const r = await sync(play, { why: 'timer' });
      expect(r.asks.map((a) => (a.kind === 'file' ? a.path : a.kind))).toEqual(['adv.dtx']);
    }
    expect(drive.text(`${LIB}/${SONG}/adv.dtx`)).toContain('#DLEVEL 50');
    expect(drive.tree(LIB).filter((f) => f.endsWith('adv.dtx'))).toHaveLength(1);
  });
});
