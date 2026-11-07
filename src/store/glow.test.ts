// 反映したら、エディタ（譜面の画面）で入った所を数秒光らせる。ほかの画面で反映したときは戻ったときに。
// テンポの反映の知らせの「元に戻す」は、その変更がまだいちばん上のときだけ戻す。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';

vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => Promise.resolve(null),
  confirmDialog: () => Promise.resolve(true),
}));
// 光らせ終わる時計は手で進める
const timers: (() => void)[] = [];
vi.stubGlobal('window', {
  setTimeout: (f: () => void) => timers.push(f),
  clearTimeout: () => {},
});

const { edit, useEditor } = await import('./editor');
const { glowReflected, useGlow } = await import('./glow');
const { registerExport, useStems } = await import('./stems');
const { applyTempo, initTempo, setPlanBpm, useTempo } = await import('./tempoUi');
const { useSidecar } = await import('./sidecar');

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });

function song(): DtxDoc {
  const chips = [chip(1, CH.BGM, 0)];
  let id = 2;
  for (let m = 1; m <= 4; m++) chips.push(chip(id++, CH.BD, m), chip(id++, CH.SD, m, 1, 2));
  return { ...emptyDoc(), fields: { TITLE: 'テスト', BPM: '120', WAV01: 'bgm.ogg' }, chips, nextId: id };
}

const folder = { name: 'song', files: new Map() } as never;

function open(page: 'chart' | 'tempo' | 'ai' | 'stems') {
  timers.length = 0;
  useGlow.setState({ pending: {}, on: {} });
  useStems.setState({ reflected: { bgm: null, preview: null } });
  useSidecar.setState({ anchors: [] });
  useTempo.setState({ initialized: false });
  useEditor.setState({
    screen: 'editor',
    page,
    doc: song(),
    past: [],
    future: [],
    toasts: [],
    folder,
    meta: { fileName: 'mstr.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] },
  });
}

const on = () => useGlow.getState().on;
const pending = () => useGlow.getState().pending;

describe('反映した所を光らせる', () => {
  beforeEach(() => open('ai'));

  it('ほかの画面で反映したら、譜面の画面に戻ったときに光らせ、少しして消す', () => {
    glowReflected({ diffs: ['adv.dtx', 'bsc.dtx'] });
    expect(on()).toEqual({});
    expect(pending().diffs).toEqual(['adv.dtx', 'bsc.dtx']);

    useEditor.setState({ page: 'chart' });
    expect(on().diffs).toEqual(['adv.dtx', 'bsc.dtx']);
    expect(pending()).toEqual({});

    timers.at(-1)!();
    expect(on()).toEqual({});
  });

  it('譜面の画面にいるときは、すぐ光らせる', () => {
    useEditor.setState({ page: 'chart' });
    glowReflected({ bgm: true });
    expect(on()).toEqual({ bgm: true });
  });

  it('同じ曲の別の難易度へ切り替えたら難易度のタブだけ光らせ続け、別の曲なら全部捨てる', async () => {
    const { switchDocument } = await import('./editor');
    useEditor.setState({ page: 'chart' });
    glowReflected({ diffs: ['adv.dtx'], bpm: true });
    await switchDocument(song(), { fileName: 'adv.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] }, null);
    expect(on()).toEqual({ diffs: ['adv.dtx'] });

    useEditor.setState({ page: 'tempo' });
    glowReflected({ bpm: true });
    // 別の曲（フォルダが変わる）
    const { openDocument } = await import('./editor');
    openDocument(song(), { fileName: 'other.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] }, null);
    expect(on()).toEqual({});
    expect(pending()).toEqual({});
  });
});

describe('テンポを反映したら', () => {
  beforeEach(() => {
    open('tempo');
    initTempo();
  });

  it('戻ったときに BPM と、動かした原曲の行を光らせる', () => {
    setPlanBpm(100);
    expect(applyTempo()).toBe(true);
    expect(pending()).toEqual({ bpm: true, bgm: true });
    useEditor.setState({ page: 'chart' });
    expect(on()).toEqual({ bpm: true, bgm: true });
  });

  it('知らせの「元に戻す」は、その変更がまだいちばん上なら戻す。あとで別の変更をしていたら戻さない', () => {
    setPlanBpm(100);
    applyTempo();
    const t = useEditor.getState().toasts.at(-1)!;
    expect(t.action?.label).toBe('元に戻す');
    t.action!.run();
    expect(useEditor.getState().doc.fields.BPM).toBe('120');

    setPlanBpm(90);
    applyTempo();
    const t2 = useEditor.getState().toasts.at(-1)!;
    edit('ほかの変更', (d) => void (d.fields.ARTIST = 'a'));
    t2.action!.run();
    expect(useEditor.getState().doc.fields.BPM).toBe('90');
    expect(useEditor.getState().toasts.at(-1)!.level).toBe('warn');
  });
});

describe('書き出した音を BGM に反映したら', () => {
  beforeEach(() => open('stems'));

  it('戻ったときに原曲の行を光らせる（試聴では光らせない）', () => {
    registerExport('preview.ogg', 'preview');
    expect(pending()).toEqual({});
    registerExport('bgm_drumless.ogg', 'bgm');
    expect(pending()).toEqual({ bgm: true });
  });
});
