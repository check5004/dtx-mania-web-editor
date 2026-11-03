import { describe, expect, it } from 'vitest';
import { eightBeat, synth } from '../audio/testSignal';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc } from '../dtx/model';
import type { FolderFile, SongFolder } from '../fs/folder';
import { classifyEvents, detectEvents } from './baseline';
import { DRUM_CLASSES, classOfChannel } from './classes';
import { BENCH_METHODS } from './methods';
import { encodeWav, renderMix } from './mix';
import { evaluateCase, poolResults } from './run';
import { matchSorted, scoreEvents, sumScores } from './score';
import { buildCase, loadSong, type TestCase } from './song';
import { chartHits, truthFrom } from './truth';
import { analyzeAudio } from '../audio/analysis';

describe('採点', () => {
  it('許容幅の中で1対1に組にする（同じ推定を2回使わない）', () => {
    expect(matchSorted([1, 2, 3], [1.01, 2.06, 2.98], 0.05)).toEqual([
      [0, 0],
      [2, 2],
    ]);
    // 推定1つに正解2つが近くても、組は1つ
    expect(matchSorted([1, 1.02], [1.01], 0.05)).toHaveLength(1);
    // 先に近い方を取って、後ろの正解の分が無くならない
    expect(matchSorted([1, 1.08], [1.04, 1.1], 0.05)).toHaveLength(2);
  });

  it('種類ごとの適合率・再現率・F値と全体', () => {
    const ref = [
      { t: 1, cls: 'BD' },
      { t: 2, cls: 'BD' },
      { t: 1, cls: 'SD' },
    ];
    const est = [
      { t: 1.01, cls: 'BD' },
      { t: 1.5, cls: 'BD' },
      { t: 1.0, cls: 'HH' },
    ];
    const { score } = scoreEvents(ref, est, DRUM_CLASSES);
    expect(score.classes.BD).toMatchObject({ ref: 2, est: 2, tp: 1, precision: 0.5, recall: 0.5, f: 0.5 });
    expect(score.classes.SD).toMatchObject({ ref: 1, est: 0, tp: 0, precision: null, recall: 0, f: 0 });
    expect(score.classes.HH).toMatchObject({ ref: 0, est: 1, tp: 0, precision: 0, recall: null, f: 0 });
    expect(score.classes.TT.f).toBeNull();
    expect(score.all).toMatchObject({ ref: 3, est: 3, tp: 1 });
    expect(score.all.f).toBeCloseTo(1 / 3);
    const pooled = sumScores([score, score])!;
    expect(pooled.all).toMatchObject({ ref: 6, est: 6, tp: 2 });
  });
});

describe('正解の打点', () => {
  it('レーンを5種にまとめ、同じ種類の同時のチップは1つにする', () => {
    const d = emptyDoc();
    d.fields['BPM'] = '120';
    const put = (ch: number, m: number, f: [number, number]) => d.chips.push({ id: d.nextId++, ch, m, f: frac(f[0], f[1]), v: 1 });
    put(CH.HHC, 1, [0, 1]);
    put(CH.LP, 1, [0, 1]);
    put(CH.BD, 1, [0, 1]);
    put(CH.LBD, 1, [1, 4]);
    put(CH.RD, 1, [1, 2]);
    put(CH.FT, 1, [3, 4]);
    put(CH.BGM, 1, [0, 1]);
    put(CH.HHC + 0x20, 1, [1, 8]); // 見えないチップは正解にしない
    const hits = chartHits(d);
    expect(hits.map((h) => h.cls)).toEqual(['HH', 'BD', 'HH', 'BD', 'CY', 'TT']);
    const truth = truthFrom(hits);
    expect(truth).toHaveLength(5);
    expect(truth.find((h) => h.cls === 'HH')!.chs.sort()).toEqual([CH.HHC, CH.LP].sort());
    // 小節001の頭は 2 秒（120BPM の4拍）
    expect(truth[0].t).toBeCloseTo(2);
    expect(classOfChannel(CH.LC)).toBe('CY');
  });
});

describe('混ぜる', () => {
  it('音量・パン・ハイハットの止め方をエディタの再生に合わせる', () => {
    const sr = 1000;
    const one = [new Float32Array(500).fill(1)];
    const [L, R] = renderMix(
      [
        { sec: 0, sound: one, gain: 0.5, pan: 0, choke: 'HH' },
        { sec: 0.1, sound: one, gain: 1, pan: 1, choke: 'HH' },
      ],
      sr,
      1,
    );
    // パン0のモノラルは左右に同じ音
    expect(L[50]).toBeCloseTo(0.5);
    expect(R[50]).toBeCloseTo(0.5);
    // 次のハイハットで前の音は消える（80ms 後には何も残らない）
    expect(L[300]).toBeCloseTo(0);
    // 右いっぱいの音は右にだけ
    expect(R[300]).toBeCloseTo(1);
    expect(L[700]).toBe(0);
    const wav = encodeWav([L, R], sr);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(wav.length).toBe(44 + 1000 * 2 * 2);
  });
});

describe('v0 方式（外した候補チップ）', () => {
  it('合成のドラムなら BD・SD はほぼ当たる（採点の仕組みの確かめ）', () => {
    const SR = 44100;
    const hits = eightBeat(120, 8, 0.5);
    const audio = synth(hits, SR, 18);
    const data = analyzeAudio([audio], SR);
    const est = classifyEvents(detectEvents(data, 0.5)).map((h) => ({ t: h.t, cls: h.lane as string }));
    const kind: Record<string, string> = { kick: 'BD', snare: 'SD', hat: 'HH', crash: 'CY' };
    const ref = truthFrom(hits.map((h) => ({ t: h.t, cls: kind[h.kind] as never, ch: 0, wav: 0, choke: '' })));
    const { score } = scoreEvents(ref, est, DRUM_CLASSES);
    expect(score.classes.BD.f!).toBeGreaterThan(0.95);
    expect(score.classes.SD.f!).toBeGreaterThan(0.95);
    expect(score.classes.HH.recall!).toBeGreaterThan(0.8);
  });
});

function fakeFolder(files: Record<string, Uint8Array | string>): SongFolder {
  const map = new Map<string, FolderFile>();
  for (const [path, body] of Object.entries(files)) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    map.set(path.toLowerCase(), { path, name: path, size: bytes.length, getFile: async () => new File([bytes as BlobPart], path) });
  }
  return { name: 'テスト曲', files: map };
}

describe('テスト曲を作る', () => {
  const dtx = (chips: string) => `#TITLE: t\n#BPM: 120\n#WAV01: kick.wav\n#WAV02: snare.xa\n#WAV0X: bgm.ogg\n#WAV0Y: drums.ogg\n#00101: 0X\n#00161: 0Y\n${chips}`;
  // 中身の1バイト目で音を作り分ける偽の読み込み
  const decode = async (b: ArrayBuffer) => {
    const k = new Uint8Array(b)[0];
    if (k === 1) return [new Float32Array(100).fill(0.5)];
    if (k === 2) return [new Float32Array(40 * 100).fill(0.1), new Float32Array(40 * 100).fill(0.1)];
    return null;
  };
  const folder = fakeFolder({
    'mstr.dtx': dtx('#00113: 01010101\n#00112: 00020002\n'),
    'bsc.dtx': dtx('#00113: 01000000\n'),
    'kick.wav': new Uint8Array([1]),
    'snare.xa': new Uint8Array([9]),
    'bgm.ogg': new Uint8Array([2]),
    'drums.ogg': new Uint8Array([2]),
  });

  it('いちばんチップの多い譜面を正解にし、混ぜ方ごとに作る（読めない音は外す・足りなければ作らない）', async () => {
    const s = (await loadSong(folder, decode, 100))!;
    expect(s.chart).toBe('mstr.dtx');
    expect(s.stem?.path).toBe('drums.ogg');
    expect(s.stem?.sec).toBeCloseTo(2);
    // スネアの .xa が読めないので、合成は 4/6 しか鳴らせない → 作らない
    const chips = buildCase(s, 'chips');
    expect('skip' in chips && chips.skip).toContain('読めない');
    const stem = buildCase(s, 'stem') as TestCase;
    expect(stem.truth).toHaveLength(6);
    expect(stem.channels[0][250]).toBeCloseTo(0.2);
    expect('skip' in buildCase(s, 'full')).toBe(true);
    expect((buildCase(s, 'full', { fullSong: true }) as TestCase).truth).toHaveLength(6);
    // ドラム無し（対照）は BGM だけ。BGM がドラム入りの曲では作らない
    const none = buildCase(s, 'nodrums') as TestCase;
    expect(none.channels[0][250]).toBeCloseTo(0.1);
    expect('skip' in buildCase(s, 'nodrums', { fullSong: true })).toBe(true);
    expect('skip' in buildCase(s, 'chips', { fullSong: true })).toBe(true);
  });

  it('採点して曲をまたいでまとめる', async () => {
    const s = (await loadSong(folder, decode, 100))!;
    const tc = buildCase(s, 'full', { fullSong: true }) as TestCase;
    const fake = { id: 'x', label: 'x', note: '', run: async () => tc.truth.filter((h) => h.cls === 'BD').map((h) => ({ t: h.t + 0.01, cls: h.cls })) };
    const r = await evaluateCase(tc, [fake]);
    expect(r.methods[0].score.classes.BD.f).toBe(1);
    expect(r.methods[0].lanes.SD).toEqual({ ref: 2, hit: 0 });
    const rows = poolResults([r, r]);
    expect(rows[0].score.all).toMatchObject({ ref: 12, tp: 8 });
    // 段階3の採譜モデル（ADTOF）を先頭に、外した v0 も比べるために残す
    expect(BENCH_METHODS[0].id).toBe('adtof-s50');
    expect(BENCH_METHODS.some((m) => m.id === 'v0-s50')).toBe(true);
  });

  it('録音のドラムだけ（分離の上限）は、ドラムの録音だけを鳴らす', async () => {
    const s = (await loadSong(folder, decode, 100))!;
    const only = buildCase(s, 'stemonly') as TestCase;
    const stem = buildCase(s, 'stem') as TestCase;
    expect(only.truth).toHaveLength(stem.truth.length);
    // BGM（0.1）は入らず、ドラムの録音だけ
    expect(only.channels[0][250]).toBeCloseTo(stem.channels[0][250] - 0.1);
  });
});
