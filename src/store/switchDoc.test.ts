import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engine, type SoundEvent } from '../audio/engine';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { useAssist } from './assist';
import { tempoOf } from './derived';
import { longSoundLayout, sameTimeBeat, switchDocument, useEditor, type DocMeta } from './editor';
import { emptySidecar, loadSidecar, sameStemFiles, useSidecar, withListening, type SavedMix, type StemTrack } from './sidecar';

const chip = (id: number, ch: number, m: number, n: number, d: number, v: number) => ({ id, ch, m, f: { n, d }, v });

/** 原曲（WAV01）を bgmAt 小節の頭から鳴らし、ハイハットを hhPerBar 個ずつ刻む譜面 */
function song(opts: { bpm?: number; bgmAt?: number; hhPerBar?: number; bgm?: string } = {}): DtxDoc {
  const { bpm = 120, bgmAt = 1, hhPerBar = 8, bgm = 'bgm.ogg' } = opts;
  const chips = [chip(1, CH.BGM, bgmAt, 0, 1, 1)];
  let id = 2;
  for (let m = 1; m < 9; m++) for (let k = 0; k < hhPerBar; k++) chips.push(chip(id++, CH.HHC, m, k, hhPerBar, 2));
  return { ...emptyDoc(), fields: { BPM: String(bpm), WAV01: bgm, WAV02: 'hh.wav' }, chips, nextId: id };
}

const meta = (fileName: string): DocMeta => ({ fileName, encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] });

const drumCount = (ev: SoundEvent[]) => ev.filter((e) => e.bus === 'drum').length;

/** 鳴らし直し（playFrom）は待たずに進むので、終わるまで待つ */
const flush = () => new Promise((r) => setTimeout(r, 0));

let order: string[];
let replaced: SoundEvent[] | null;

beforeEach(() => {
  order = [];
  replaced = null;
  // node には AudioContext が無いので、再生中の engine を置き換える
  vi.spyOn(engine, 'playing', 'get').mockReturnValue(true);
  vi.spyOn(engine, 'rate', 'get').mockReturnValue(1);
  vi.spyOn(engine, 'ensure').mockReturnValue({} as AudioContext);
  vi.spyOn(engine, 'uncached').mockReturnValue(0);
  vi.spyOn(engine, 'preload').mockImplementation(async () => {
    order.push(`preload:${useEditor.getState().meta.fileName}`);
  });
  vi.spyOn(engine, 'prepare').mockResolvedValue([]);
  vi.spyOn(engine, 'stop').mockImplementation(() => order.push('stop'));
  vi.spyOn(engine, 'play').mockImplementation(() => order.push('play'));
  vi.spyOn(engine, 'stopAudition').mockReturnValue(false);
  vi.spyOn(engine, 'replaceEvents').mockImplementation((ev) => {
    replaced = ev;
  });
  vi.spyOn(engine, 'spliceLong').mockImplementation(() => order.push('splice'));
  vi.spyOn(engine, 'setEndSec').mockImplementation(() => {});
  vi.spyOn(engine, 'setLoop').mockImplementation(() => {});
  vi.spyOn(engine, 'currentSec').mockReturnValue(10);
  vi.spyOn(engine, 'heardSec').mockReturnValue(10);
  vi.spyOn(engine, 'buffer').mockReturnValue(null);
  const doc = song();
  useEditor.setState({
    screen: 'editor',
    page: 'chart',
    doc,
    savedDoc: doc,
    meta: meta('mstr.dtx'),
    folder: null,
    past: [{ label: '前の編集', redo: [], undo: [] }],
    future: [],
    selection: [5, 6],
    cursorBeat: 12,
    view: { pxPerBeat: 60, div: 16, scrollBeat: 18, follow: true },
    playing: true,
  });
  useAssist.setState({ loop: { on: true, a: 16, b: 24 }, loopMark: null });
  loadSidecar(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  useEditor.setState({ playing: false });
});

describe('難易度の切り替え（再生を止めない）', () => {
  it('再生は止めず、まだ鳴らしていない所から新しい譜面のチップを鳴らす', async () => {
    const ext = song({ hhPerBar: 4 });
    expect(await switchDocument(ext, meta('ext.dtx'), null)).toBe(true);
    expect(order).not.toContain('stop');
    expect(order).not.toContain('play');
    const s = useEditor.getState();
    expect(s.doc).toBe(ext);
    expect(s.meta.fileName).toBe('ext.dtx');
    expect(s.playing).toBe(true);
    expect(replaced && drumCount(replaced)).toBe(8 * 4);
  });

  it('新しい譜面の音は、譜面を替える前に読み込んでおく', async () => {
    await switchDocument(song({ hhPerBar: 4 }), meta('ext.dtx'), null);
    expect(order[0]).toBe('preload:mstr.dtx');
  });

  it('▶・表示の位置・拡大・ループはそのまま。履歴と選択は新しい譜面のものにする', async () => {
    await switchDocument(song({ hhPerBar: 4 }), meta('ext.dtx'), null);
    const s = useEditor.getState();
    expect(s.cursorBeat).toBe(12);
    expect(s.view).toMatchObject({ scrollBeat: 18, pxPerBeat: 60, follow: true });
    expect(useAssist.getState().loop).toEqual({ on: true, a: 16, b: 24 });
    expect(s.past).toEqual([]);
    expect(s.selection).toEqual([]);
    expect(s.savedDoc).toBe(s.doc);
  });

  it('テンポが違う譜面では、同じ秒の所に ▶・表示・ループを置く', async () => {
    // 120 BPM の 12 拍目 = 6 秒 = 150 BPM の 15 拍目
    await switchDocument(song({ bpm: 150, hhPerBar: 4 }), meta('ext.dtx'), null);
    const s = useEditor.getState();
    expect(s.cursorBeat).toBeCloseTo(15, 6);
    expect(s.view.scrollBeat).toBeCloseTo(22.5, 6);
    const loop = useAssist.getState().loop!;
    expect(loop.a).toBeCloseTo(20, 6);
    expect(loop.b).toBeCloseTo(30, 6);
  });

  it('原曲の置き方が同じなら、鳴っている原曲をそのまま使う（鳴らし直さない・つなぎ替えない）', async () => {
    await switchDocument(song({ hhPerBar: 2 }), meta('bsc.dtx'), null);
    await flush();
    expect(order).not.toContain('stop');
    expect(order).not.toContain('play');
    expect(order).not.toContain('splice');
  });

  it('同じ時刻の原曲と SE が譜面に書いた順で違っても、鳴らし直さない', async () => {
    const withSe = (d: DtxDoc, seFirst: boolean): DtxDoc => {
      const se = chip(999, 0x61, 1, 0, 1, 3);
      return { ...d, fields: { ...d.fields, WAV03: 'drums.ogg' }, chips: seFirst ? [se, ...d.chips] : [...d.chips, se] };
    };
    const cur = withSe(song(), false);
    useEditor.setState({ doc: cur, savedDoc: cur });
    const before = longSoundLayout(cur, null);
    const next = withSe(song({ hhPerBar: 4 }), true);
    expect(longSoundLayout(next, null)).toBe(before);
    await switchDocument(next, meta('adv.dtx'), null);
    await flush();
    expect(order).not.toContain('play');
    expect(order).not.toContain('splice');
  });

  it('原曲の位置や音が違えば、止めずに今の位置からつなぎ替える（▶ は動かさない）', async () => {
    await switchDocument(song({ bgmAt: 2 }), meta('ext.dtx'), null);
    await flush();
    expect(order).toEqual(['preload:mstr.dtx', 'splice']);
    expect(useEditor.getState().cursorBeat).toBe(12);
    order = [];
    await switchDocument(song({ bgmAt: 2, bgm: 'other.ogg' }), meta('adv.dtx'), null);
    await flush();
    expect(order).toEqual(['preload:ext.dtx', 'splice']);
  });

  it('SE の音量だけが難易度で違っても、止めずにつなぎ替える', async () => {
    const withSe = (d: DtxDoc, volume: number): DtxDoc => ({
      ...d,
      fields: { ...d.fields, WAV03: 'drums.ogg', VOLUME03: String(volume) },
      chips: [...d.chips, chip(999, 0x61, 1, 0, 1, 3)],
    });
    // 音量は曲フォルダにあるファイルの音にだけ効く
    const file = (name: string) => [name, { path: name, name, size: 1, getFile: async () => new File([], name) }] as const;
    const folder = { name: 'song', files: new Map([file('bgm.ogg'), file('hh.wav'), file('drums.ogg')]) };
    const cur = withSe(song(), 25);
    useEditor.setState({ doc: cur, savedDoc: cur, folder });
    await switchDocument(withSe(song({ hhPerBar: 4 }), 40), meta('ext.dtx'), null);
    await flush();
    expect(order).toContain('splice');
    expect(order).not.toContain('stop');
    expect(order).not.toContain('play');
  });

  it('スロー再生で切り替え先の原曲を伸ばした音がまだ無いときは、伸ばしてから今の位置で鳴らし直す', async () => {
    vi.spyOn(engine, 'rate', 'get').mockReturnValue(0.5);
    vi.spyOn(engine, 'duration').mockReturnValue(300);
    useAssist.setState({ speed: 0.5 });
    try {
      await switchDocument(song({ bgm: 'other.ogg' }), meta('ext.dtx'), null);
      await flush();
      expect(order).not.toContain('splice');
      expect(order.slice(-2)).toEqual(['stop', 'play']);
      expect(useEditor.getState().cursorBeat).toBe(12);
    } finally {
      useAssist.setState({ speed: 1 });
    }
  });

  it('続けて切り替えたら、最後に選んだ難易度だけを開く', async () => {
    const adv = song({ hhPerBar: 4 });
    const bsc = song({ hhPerBar: 2 });
    const a = switchDocument(adv, meta('adv.dtx'), null);
    const b = switchDocument(bsc, meta('bsc.dtx'), null);
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(useEditor.getState().doc).toBe(bsc);
  });

  it('止まっているときも ▶・表示の位置はそのまま（音を先に読む必要はない）', async () => {
    vi.spyOn(engine, 'playing', 'get').mockReturnValue(false);
    useEditor.setState({ playing: false });
    await switchDocument(song({ hhPerBar: 4 }), meta('ext.dtx'), null);
    expect(order).not.toContain('preload:mstr.dtx');
    expect(useEditor.getState()).toMatchObject({ cursorBeat: 12, playing: false });
    expect(useEditor.getState().view.scrollBeat).toBe(18);
  });
});

describe('聴く設定（ミックス）の引き継ぎ', () => {
  const stem = (file: string, p: Partial<StemTrack> = {}): StemTrack => ({ file, name: file, kind: 'other', gain: 1, pan: 0, mute: false, solo: false, offsetMs: 0, ...p });
  const mix = (p: Partial<SavedMix> = {}): SavedMix => ({ bgm: 0.8, drums: 0.9, bgmMute: false, drumMute: false, metronome: false, click: 0.5, clickBarOnly: false, listen: 'all', ...p });

  it('ステムのファイルが同じか（並びは問わない）', () => {
    expect(sameStemFiles([stem('stems/a.wav'), stem('stems/b.wav')], [stem('stems/b.wav'), stem('stems/a.wav')])).toBe(true);
    expect(sameStemFiles([], [])).toBe(true);
    expect(sameStemFiles([stem('stems/a.wav')], [])).toBe(false);
    expect(sameStemFiles([stem('stems/a.wav')], [stem('stems/c.wav')])).toBe(false);
  });

  it('今のミックスとステムのミュート・ソロを引き継ぎ、ほかは切り替え先の作業ファイルのまま', () => {
    loadSidecar({ ...emptySidecar(), stems: [stem('stems/a.wav', { mute: true }), stem('stems/b.wav', { solo: true })], mix: mix({ drumMute: true, listen: 'custom' }) });
    const next = { ...emptySidecar(), sections: [{ m: 3, name: 'サビ' }], stems: [stem('stems/a.wav', { gain: 0.5 }), stem('stems/b.wav')], mix: mix() };
    const got = withListening(next);
    expect(got.mix).toMatchObject({ drumMute: true, listen: 'custom' });
    expect(got.stems).toEqual([stem('stems/a.wav', { gain: 0.5, mute: true }), stem('stems/b.wav', { solo: true })]);
    expect(got.sections).toEqual([{ m: 3, name: 'サビ' }]);
  });

  it('切り替え先に作業ファイルが無くても、今のミックスで聴き続ける', () => {
    loadSidecar({ ...emptySidecar(), mix: mix({ bgmMute: true }) });
    expect(withListening(null).mix).toMatchObject({ bgmMute: true });
  });

  it('切り替えたあとも同じミックス（譜面の音を消していたら消したまま）', async () => {
    loadSidecar({ ...emptySidecar(), mix: mix({ drumMute: true }) });
    await switchDocument(song({ hhPerBar: 4 }), meta('ext.dtx'), null);
    expect(useSidecar.getState().mix).toMatchObject({ drumMute: true });
  });
});

describe('同じ秒の拍', () => {
  it('テンポが同じならそのまま、違えば秒で合わせる', () => {
    const a = tempoOf(song());
    const b = tempoOf(song({ bpm: 60 }));
    expect(sameTimeBeat(a, a, 7.25)).toBe(7.25);
    expect(sameTimeBeat(a, tempoOf(song({ hhPerBar: 2 })), 7.25)).toBe(7.25);
    expect(sameTimeBeat(a, b, 8)).toBeCloseTo(4, 9);
  });
});
