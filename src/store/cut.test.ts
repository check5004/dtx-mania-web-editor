// 音の切り出し（store/cut）：候補の重なり・名前・使い道（種類の音・レーンの音・WAV に足すだけ）・元に戻す・作業ファイルの印
import { describe, expect, it, vi } from 'vitest';
import { toBase36x2 } from '../dtx/base36';
import { kindVoice, specialWavs } from '../dtx/kinds';
import { CH, SD_RIM, type DtxDoc } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import { produce } from 'immer';
import type { Pcm } from '../audio/cut';

const noop = () => undefined;
vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => Promise.resolve('auto'),
  confirmDialog: () => Promise.resolve(true),
  promptDialog: () => Promise.resolve(null),
}));
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: noop, addEventListener: noop, removeEventListener: noop, innerWidth: 1280, innerHeight: 800 });
vi.stubGlobal('document', { addEventListener: noop, querySelector: () => null, documentElement: { classList: { toggle: noop }, style: { setProperty: noop } } });

const { openDocument, redo, undo, useEditor } = await import('./editor');
const cut = await import('./cut');
const { parseSidecar, setSpecialSide, useSidecar } = await import('./sidecar');
const { isCutFile } = await import('./kit');
const { pruneUnusedCreated } = await import('../edit/velocity');

const meta = { fileName: 'cut.dtx', encoding: 'shift_jis' as const, warnings: [], hasRandom: false, siblings: [] };

/**
 * Mela! のように、クラップ（ファイル名で分かる）をハイタムに置いた譜面。小節 1 は 2〜4 秒（BPM 120）。
 * 2.0 秒：クラップ＋バスドラム、2.5 秒：クラップ（強さ 60）＋スネア、3.0 秒：タム＋バスドラム＋リム、3.5 秒：クラップ＋スネア
 */
const SONG = [
  '#TITLE: Mela!',
  '#BPM: 120',
  '#WAV0A: clap1.ogg',
  '#WAV0D: clap1.ogg',
  '#VOLUME0D: 60',
  '#WAV0B: 044_Tom_Hi.ogg',
  '#WAV0C: 039_Snare.ogg',
  '#WAV0E: 035_Kick.ogg',
  '#WAV0F: 037_Rim.ogg',
  '#00114: 0A0D0B0A',
  '#00112: 000C0F0C',
  '#00113: 0E000E00',
];

function open(lines: string[] = SONG) {
  setSpecialSide(null);
  openDocument(parseDtx(lines.join('\n')).doc, meta, null);
}

const doc = () => useEditor.getState().doc;
const wavNoOf = (d: DtxDoc, path: string) =>
  Object.entries(d.fields)
    .filter(([k, v]) => /^WAV[0-9A-Z]{2}$/.test(k) && v === path)
    .map(([k]) => parseInt(k.slice(3), 36));
const chipsAt = (ch: number) => doc().chips.filter((c) => c.ch === ch && c.m === 1).sort((a, b) => a.f.n / a.f.d - b.f.n / b.f.d);

/** 切り出した音（中身は何でもよい） */
const PCM: Pcm = { sr: 44100, ch: [new Float32Array(4410).fill(0.1)] };

describe('候補', () => {
  it('同時に鳴る音で重なり方を分ける（バスドラムだけ・ハイハットまで・スネアなどと同時）', () => {
    expect(cut.overlapClass([])).toBe(0);
    expect(cut.overlapClass([CH.BD])).toBe(1);
    expect(cut.overlapClass([CH.BD, CH.HHC])).toBe(2);
    expect(cut.overlapClass([CH.SD])).toBe(3);
  });

  it('クラップの所を譜面の順に。重なりと次の音を見て、きれいさ（点）を付ける', () => {
    open();
    const list = cut.cutCandidates(doc(), { type: 'kind', id: 'clap' });
    expect(list.map((c) => c.sec)).toEqual([2, 2.5, 3.5]);
    expect(list.map((c) => c.cls)).toEqual([1, 3, 3]);
    expect(list[0].over).toEqual([CH.BD]);
    expect(list[1].over).toEqual([CH.SD]);
    // 1 つ目の次の音は 2.5 秒（クラップとスネア）。最後は次が無い
    expect(list[0].next?.sec).toBe(2.5);
    expect(list[2].next).toBe(null);
    expect(list.map((c) => c.dots)).toEqual([4, 2, 2]);
    expect(list[0].pos).toBe('001 · 0');
  });

  it('スネアの所はスネアのチップだけ（リムは別の音）', () => {
    open();
    const sd = cut.cutCandidates(doc(), { type: 'voice', voice: CH.SD });
    expect(sd.map((c) => c.sec)).toEqual([2.5, 3.5]);
    const rim = cut.cutCandidates(doc(), { type: 'voice', voice: SD_RIM });
    expect(rim.map((c) => c.sec)).toEqual([3]);
  });

  it('チップの右クリックからは、その種類・レーンの音', () => {
    open();
    const [clap] = chipsAt(CH.HT);
    const [, rim] = chipsAt(CH.SD);
    expect(cut.chipTarget(doc(), clap)).toEqual({ type: 'kind', id: 'clap' });
    expect(cut.chipTarget(doc(), rim)).toEqual({ type: 'voice', voice: SD_RIM });
    expect(cut.chipTarget(doc(), chipsAt(CH.HT)[2])).toEqual({ type: 'voice', voice: CH.HT });
  });

  it('波形の右クリック：近くのチップを選ぶ（同じ時刻ならバスドラムより先にクラップ）。遠ければ時刻だけ', () => {
    open();
    const s = cut.cutSpotAt(2.01, 0.06);
    expect(s.chip).toBe(chipsAt(CH.HT)[0].id);
    expect(cut.cutSpotAt(5.2, 0.06).chip).toBe(null);
  });
});

describe('名前', () => {
  it('種類・レーンの名前と曲名から。ほかの楽器と読まれる名前は使わない', () => {
    open();
    const clap = { type: 'kind', id: 'clap' } as const;
    expect(cut.defaultCutName(clap, clap)).toBe('clap_mela.wav');
    expect(cut.defaultCutName({ type: 'voice', voice: SD_RIM }, { type: 'voice', voice: SD_RIM })).toBe('rim_mela.wav');
    expect(cut.nameFits('snare_x.wav', clap, clap)).toBe(false);
    expect(cut.nameFits('clap_x.wav', clap, clap)).toBe(true);
    // スネアの音がクラップやリムと読まれると、チップが別の列・別の音になってしまう
    expect(cut.nameFits('clap_x.wav', { type: 'voice', voice: CH.SD }, clap)).toBe(false);
    expect(cut.nameFits('rim_x.wav', { type: 'voice', voice: CH.SD }, clap)).toBe(false);
    expect(cut.nameFits('rim_x.wav', { type: 'voice', voice: SD_RIM }, clap)).toBe(true);
  });

  it('拡張子は .wav、使っている名前なら _2', () => {
    open();
    expect(cut.wavName('clap.ogg')).toBe('clap.wav');
    expect(cut.wavName('  ')).toBe('cut.wav');
    expect(cut.freeName(null, doc(), 'clap1.ogg')).toBe('clap1_2.ogg');
    expect(cut.freeName(null, doc(), 'clap_new.wav')).toBe('clap_new.wav');
  });
});

describe('使う', () => {
  it('クラップの音にする：クラップのチップだけ新しい音に。強さ 60 の違いは #VOLUME で写す。Ctrl+Z でまとめて戻る', async () => {
    open();
    const before = serializeDtx(doc());
    const n = await cut.applyCut({ pcm: PCM, name: 'clap_mela.wav', use: { type: 'kind', id: 'clap' }, target: { type: 'kind', id: 'clap' }, library: false, tags: [], from: 'drums' });
    expect(n).toBe(3);
    const nos = wavNoOf(doc(), 'clap_mela.wav');
    expect(nos).toHaveLength(2);
    const base = nos.find((no) => doc().fields['VOLUME' + toBase36x2(no)] === undefined)!;
    const v60 = nos.find((no) => no !== base)!;
    expect(doc().fields['VOLUME' + toBase36x2(v60)]).toBe('60');
    expect(chipsAt(CH.HT).map((c) => c.v)).toEqual([base, v60, 0x0b, base]);
    // 新しい音もクラップと分かる（特殊ノーツのまま）
    expect(specialWavs(doc()).get(base)).toBe('clap');
    expect(specialWavs(doc()).get(v60)).toBe('clap');
    // ほかのレーンは変えない
    expect(chipsAt(CH.SD).map((c) => c.v)).toEqual([0x0c, 0x0f, 0x0c]);
    // これから置くクラップの音・作業ファイルの印・曲フォルダのファイル
    expect(useEditor.getState().laneWav[kindVoice('clap')!]).toBe(base);
    expect(useSidecar.getState().special?.cuts).toEqual(['clap_mela.wav']);
    expect(isCutFile('Clap_Mela.wav')).toBe(true);
    expect(useEditor.getState().folder?.files.get('clap_mela.wav')?.pending).toBe(true);

    undo();
    expect(serializeDtx(doc())).toBe(before);
    expect(useSidecar.getState().special).toBe(null);
    expect(isCutFile('clap_mela.wav')).toBe(false);
    redo();
    expect(chipsAt(CH.HT).map((c) => c.v)).toEqual([base, v60, 0x0b, base]);
    expect(useSidecar.getState().special?.cuts).toEqual(['clap_mela.wav']);
    expect(useEditor.getState().laneWav[kindVoice('clap')!]).toBe(base);
  });

  it('スネアの音にする：スネアのチップだけ（リムはそのまま）', async () => {
    open();
    const n = await cut.applyCut({ pcm: PCM, name: 'snare_mela.wav', use: { type: 'voice', voice: CH.SD }, target: { type: 'voice', voice: CH.SD }, library: false, tags: [], from: 'drums' });
    expect(n).toBe(2);
    const [no] = wavNoOf(doc(), 'snare_mela.wav');
    expect(chipsAt(CH.SD).map((c) => c.v)).toEqual([no, 0x0f, no]);
    expect(useEditor.getState().laneWav[CH.SD]).toBe(no);
  });

  it('使い道に合わない名前（クラップに「snare」）は、その種類と分かる名前に変える', async () => {
    open();
    await cut.applyCut({ pcm: PCM, name: 'snare.wav', use: { type: 'kind', id: 'clap' }, target: { type: 'kind', id: 'clap' }, library: false, tags: [], from: 'drums' });
    expect(wavNoOf(doc(), 'snare.wav')).toHaveLength(0);
    expect(wavNoOf(doc(), 'clap_mela.wav').length).toBeGreaterThan(0);
  });

  it('WAV に足すだけ：チップは変えず、クラップと分かるラベルを付ける。キットを替えても消さない', async () => {
    open();
    const chips = doc().chips.map((c) => c.v);
    const n = await cut.applyCut({ pcm: PCM, name: 'clap_take2.wav', use: { type: 'wav' }, target: { type: 'kind', id: 'clap' }, library: false, tags: [], from: 'drums' });
    expect(n).toBe(0);
    expect(doc().chips.map((c) => c.v)).toEqual(chips);
    const [no] = wavNoOf(doc(), 'clap_take2.wav');
    expect(serializeDtx(doc())).toMatch(new RegExp(`#WAV${toBase36x2(no)}[:\\s]+clap_take2\\.wav\\s*;\\s*Hand Clap`, 'i'));
    // 使っていない WAV を消すとき（キットを替えたときなど）、切り出した音は残す
    const kept = produce(doc(), (d) => void pruneUnusedCreated(d, isCutFile));
    expect(wavNoOf(kept, 'clap_take2.wav')).toEqual([no]);
    const gone = produce(doc(), (d) => void pruneUnusedCreated(d));
    expect(wavNoOf(gone, 'clap_take2.wav')).toEqual([]);
  });
});

describe('作業ファイル', () => {
  it('切り出した音の一覧（special.cuts）だけでも残す', () => {
    const d = parseSidecar(JSON.stringify({ version: 1, special: { kinds: [], cuts: ['clap_mela.wav', 3, ''] } }));
    expect(d?.special).toEqual({ kinds: [], cuts: ['clap_mela.wav'] });
    const none = parseSidecar(JSON.stringify({ version: 1, special: { kinds: [], cuts: [] } }));
    expect(none?.special ?? null).toBe(null);
  });
});

describe('切り出した音を直す', () => {
  const clap = { type: 'kind', id: 'clap' } as const;
  const recipe = { src: 'orig', target: clap, sec: 2.5, align: true, startMs: 4, lenMs: null, fadeMs: 40, lowCut: true, normalize: true, mono: false };
  const bytesOf = async (path: string) => {
    const f = useEditor.getState().folder!.files.get(path)!;
    return { ver: f.ver ?? 0, bytes: new Uint8Array(await (await f.getFile()).arrayBuffer()) };
  };

  it('作り方を作業ファイルに覚え、チップから直す画面を開ける（同じ所・同じ切り方から）', async () => {
    open();
    await cut.applyCut({ pcm: PCM, name: 'clap_mela.wav', use: clap, target: clap, library: false, tags: [], from: 'drums', recipe });
    expect(useSidecar.getState().special?.recipes).toEqual([{ file: 'clap_mela.wav', ...recipe }]);
    expect(cut.cutRecipe('Clap_Mela.wav')?.startMs).toBe(4);
    expect(cut.canRecut('clap_mela.wav')).toBe(true);
    expect(cut.canRecut('clap1.ogg')).toBe(false);
    // 切り出した音のチップ（強さ 60 の番号も）から分かる。ほかの音のチップは違う
    const [c1, c2] = chipsAt(CH.HT);
    expect(cut.cutFileOfChip(doc(), c1)).toBe('clap_mela.wav');
    expect(cut.cutFileOfChip(doc(), c2)).toBe('clap_mela.wav');
    expect(cut.cutFileOfChip(doc(), chipsAt(CH.SD)[0])).toBe(null);
    expect(cut.chipsOfFile(doc(), 'clap_mela.wav')).toHaveLength(3);
    cut.openRecut('clap_mela.wav');
    const o = cut.useCut.getState().open!;
    expect(o.redo).toEqual({ file: 'clap_mela.wav', recipe: { file: 'clap_mela.wav', ...recipe } });
    expect(o.target).toEqual(clap);
    // 前に切り出した 2.5 秒のクラップから
    expect(o.chip).toBe(c2.id);
    cut.closeCut();
  });

  it('チップが動いていたら、前に切り出した時刻の所から', async () => {
    open();
    await cut.applyCut({ pcm: PCM, name: 'clap_mela.wav', use: clap, target: clap, library: false, tags: [], from: 'drums', recipe: { ...recipe, sec: 2.7 } });
    cut.openRecut('clap_mela.wav');
    const o = cut.useCut.getState().open!;
    expect(o.target).toEqual({ type: 'free' });
    expect(o.sec).toBe(2.7);
    expect(o.chip).toBe(null);
    cut.closeCut();
  });

  it('作り方が残っていない音は、使っている種類・レーンの初めの切り方から', async () => {
    open();
    await cut.applyCut({ pcm: PCM, name: 'snare_mela.wav', use: { type: 'voice', voice: CH.SD }, target: { type: 'voice', voice: CH.SD }, library: false, tags: [], from: 'drums' });
    expect(useSidecar.getState().special?.recipes).toBeUndefined();
    cut.openRecut('snare_mela.wav');
    const o = cut.useCut.getState().open!;
    expect(o.redo).toEqual({ file: 'snare_mela.wav', recipe: null });
    expect(o.target).toEqual({ type: 'voice', voice: CH.SD });
    cut.closeCut();
  });

  it('作り直す：同じファイルに書き、譜面は変えない。元に戻すと前の音、やり直すと新しい音', async () => {
    open();
    await cut.applyCut({ pcm: PCM, name: 'clap_mela.wav', use: clap, target: clap, library: false, tags: [], from: 'drums', recipe });
    const chart = serializeDtx(doc());
    const before = await bytesOf('clap_mela.wav');
    const PCM2: Pcm = { sr: 44100, ch: [new Float32Array(2205).fill(0.2)] };
    expect(await cut.applyRecut({ pcm: PCM2, file: 'clap_mela.wav', recipe: { ...recipe, startMs: -2 } })).toBe(true);
    expect(serializeDtx(doc())).toBe(chart);
    const after = await bytesOf('clap_mela.wav');
    expect(after.ver).toBeGreaterThan(before.ver);
    expect(after.bytes.length).not.toBe(before.bytes.length);
    expect(useSidecar.getState().special?.recipes).toEqual([{ file: 'clap_mela.wav', ...recipe, startMs: -2 }]);
    expect(useSidecar.getState().special?.cuts).toEqual(['clap_mela.wav']);

    undo();
    expect(serializeDtx(doc())).toBe(chart);
    expect((await bytesOf('clap_mela.wav')).bytes).toEqual(before.bytes);
    expect(cut.cutRecipe('clap_mela.wav')?.startMs).toBe(4);
    redo();
    expect((await bytesOf('clap_mela.wav')).bytes).toEqual(after.bytes);
    expect(cut.cutRecipe('clap_mela.wav')?.startMs).toBe(-2);
  });
});

describe('作業ファイルの作り方', () => {
  it('読めない作り方は捨て、ずらしは ±100 ms まで。同じファイルは 1 つ', () => {
    const good = { file: 'clap_mela.wav', src: 'drums.ogg', target: { type: 'kind', id: 'clap' }, sec: 2.5, align: true, startMs: 4, lenMs: null, fadeMs: 40, lowCut: true, normalize: true, mono: false };
    const d = parseSidecar(
      JSON.stringify({
        version: 1,
        special: {
          kinds: [],
          cuts: ['clap_mela.wav'],
          recipes: [good, { ...good, file: 'CLAP_MELA.wav', startMs: 9 }, { ...good, file: 'x.wav', target: { type: 'nope' } }, { ...good, file: 'y.wav', startMs: 500, stack: [1, 2, 'a'] }, 'bad'],
        },
      }),
    );
    const r = d?.special?.recipes ?? [];
    expect(r.map((x) => x.file)).toEqual(['clap_mela.wav', 'y.wav']);
    expect(r[0]).toEqual(good);
    expect(r[1].startMs).toBe(0);
    expect(r[1].stack).toEqual([1, 2]);
  });
});
