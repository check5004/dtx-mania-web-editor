// テンポと開始位置の案を、エディタ（譜面）に反映する。案が譜面とちがうか（未反映・反映済み）を中身で比べ、
// 反映しないまま戻ろうとしたら聞く。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';

const dialogs = vi.hoisted(() => ({ choose: vi.fn<() => Promise<unknown>>() }));
vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => dialogs.choose(),
  confirmDialog: () => Promise.resolve(true),
}));
// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0 });

const { useEditor } = await import('./editor');
const { useSidecar } = await import('./sidecar');
const { applyTempo, initTempo, leaveTempo, setPlanBpm, tempoDiff, tempoReflect, useTempo } = await import('./tempoUi');

const chip = (id: number, ch: number, m: number, n = 0, d = 1, v = 1) => ({ id, ch, m, f: { n, d }, v });

/** BPM 120、原曲（BGM）は 000小節の頭から。001〜004小節にドラム */
function song(extra: Partial<DtxDoc> = {}): DtxDoc {
  const chips = [chip(1, CH.BGM, 0)];
  let id = 2;
  for (let m = 1; m <= 4; m++) chips.push(chip(id++, CH.BD, m, 0, 4), chip(id++, CH.SD, m, 1, 4));
  return { ...emptyDoc(), fields: { TITLE: 'テスト', BPM: '120', WAV01: 'bgm.ogg' }, chips, nextId: id, ...extra };
}

function open(doc: DtxDoc) {
  dialogs.choose.mockReset();
  useSidecar.setState({ anchors: [] });
  // 曲が変わると案を作り直す
  useTempo.setState({ initialized: false });
  useEditor.setState({
    doc,
    page: 'tempo',
    past: [],
    future: [],
    meta: { fileName: 'song.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] },
  });
  initTempo();
}

const bgmChip = () => useEditor.getState().doc.chips.find((c) => c.ch === CH.BGM)!;

describe('テンポの案をエディタに反映する', () => {
  beforeEach(() => open(song()));

  it('開いたばかり（譜面から作った案のまま）は未反映ではない', () => {
    expect(useTempo.getState().plan.anchors).toEqual([{ m: 1, t: 2 }]);
    expect(tempoDiff().any).toBe(false);
    expect(tempoReflect()).toBe('same');
  });

  it('BPM を変えると未反映。反映すると譜面の BPM と BGM の位置が変わり「反映済み」（画面はそのまま）', () => {
    setPlanBpm(100);
    expect(tempoReflect()).toBe('pending');
    const d = tempoDiff();
    expect(d.bpm).toEqual({ cur: 120, next: 100, changed: true });
    expect(d.changes.changed).toBe(false);
    // 001小節の頭（原曲の 2 秒）を合わせたまま BPM を 100 にすると、原曲は譜面の 0.4 秒から鳴る
    expect(d.bgm?.changed).toBe(true);
    expect(d.bgm?.cur).toBeCloseTo(0, 6);
    expect(d.bgm?.next).toBeCloseTo(0.4, 6);

    expect(applyTempo()).toBe(true);
    expect(useEditor.getState().doc.fields.BPM).toBe('100');
    expect(bgmChip().m).toBe(0);
    expect(bgmChip().f).toEqual({ n: 1, d: 6 });
    expect(tempoReflect()).toBe('applied');
    expect(tempoDiff().any).toBe(false);
    expect(useEditor.getState().page).toBe('tempo');
    expect(useSidecar.getState().anchors).toEqual([{ m: 1, t: 2 }]);
  });

  it('反映のあとに変えるとまた未反映、元の値に戻すと反映済み。元に戻す（Ctrl+Z）で譜面を戻しても未反映', () => {
    setPlanBpm(100);
    applyTempo();
    setPlanBpm(110);
    expect(tempoReflect()).toBe('pending');
    setPlanBpm(100);
    expect(tempoReflect()).toBe('applied');

    const prev = useEditor.getState().past.at(-1)!;
    expect(prev).toBeTruthy();
    useEditor.setState({ doc: song() });
    expect(tempoReflect()).toBe('pending');
  });

  it('保存しても案は消えない（別の曲を開いたときだけ作り直す）', () => {
    setPlanBpm(100);
    // 保存すると meta は新しくなる
    useEditor.setState((s) => ({ meta: { ...s.meta }, savedDoc: s.doc }));
    initTempo();
    expect(useTempo.getState().plan.bpm).toBe(100);
    expect(tempoReflect()).toBe('pending');
  });

  it('同じ BPM を選び直しただけなら、反映済みとは出さない（反映を押していない）', () => {
    setPlanBpm(120);
    expect(tempoDiff().any).toBe(false);
    expect(tempoReflect()).toBe('same');
  });

  it('書き方がちがっても中身が同じなら、反映しても譜面を変えない', () => {
    // 000小節の頭の BPM チップ（#BPM01 120）で BPM を決めている譜面
    const doc = song();
    doc.fields = { ...doc.fields, BPM: '90', BPM01: '120' };
    doc.chips = [...doc.chips, chip(doc.nextId, CH.BPM_EX, 0, 0, 1, 1)];
    doc.nextId += 1;
    open(doc);
    // 曲頭の BPM は #BPM ではなく、000小節の頭のチップの 120
    expect(useTempo.getState().plan.bpm).toBe(120);
    expect(tempoDiff().any).toBe(false);
    setPlanBpm(130);
    setPlanBpm(120);
    expect(applyTempo()).toBe(true);
    expect(useEditor.getState().doc).toBe(doc);
    expect(useEditor.getState().past).toHaveLength(0);
    expect(tempoReflect()).toBe('applied');
  });
});

describe('反映しないまま戻ろうとしたら聞く', () => {
  beforeEach(() => open(song()));

  it('未反映が無ければ聞かずに戻る', async () => {
    expect(await leaveTempo()).toBe(true);
    expect(dialogs.choose).not.toHaveBeenCalled();
    expect(useEditor.getState().page).toBe('chart');
  });

  it('やめる・反映せずに戻る（案は画面に残る）', async () => {
    setPlanBpm(100);
    dialogs.choose.mockResolvedValue(null);
    expect(await leaveTempo()).toBe(false);
    expect(useEditor.getState().page).toBe('tempo');

    dialogs.choose.mockResolvedValue('leave');
    expect(await leaveTempo()).toBe(true);
    expect(useEditor.getState().page).toBe('chart');
    expect(useEditor.getState().doc.fields.BPM).toBe('120');
    expect(useTempo.getState().plan.bpm).toBe(100);
    expect(tempoReflect()).toBe('pending');
  });

  it('反映して戻る', async () => {
    setPlanBpm(100);
    dialogs.choose.mockResolvedValue('apply');
    expect(await leaveTempo()).toBe(true);
    expect(dialogs.choose).toHaveBeenCalledTimes(1);
    expect(useEditor.getState().page).toBe('chart');
    expect(useEditor.getState().doc.fields.BPM).toBe('100');
  });

  it('BGM を置けない案は反映できないので、画面に残る', async () => {
    // 001小節の頭を原曲の 2 秒に合わせたまま BPM 150 にすると、原曲が譜面の始まりより前から鳴ることになる
    setPlanBpm(150);
    dialogs.choose.mockResolvedValue('apply');
    expect(await leaveTempo()).toBe(false);
    expect(useEditor.getState().page).toBe('tempo');
    expect(useEditor.getState().doc.fields.BPM).toBe('120');
  });
});
