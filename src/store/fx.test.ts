// エフェクト（store/fx）：カーブを引くとチップの音が替わる・置いた／動かしたチップもすぐ替わる・Ctrl+Z 1 回で一緒に戻る・
// テンプレート・切って聴く・WAV の表のまとめ・ほかの難易度の譜面を合わせる（保存のとき）
import { describe, expect, it, vi } from 'vitest';
import { toBase36x2 } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { parseDtx } from '../dtx/parse';
import { patchDtxText } from '../dtx/patchText';
import { serializeDtx } from '../dtx/serialize';

const noop = () => undefined;
vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => Promise.resolve(null),
  confirmDialog: () => Promise.resolve(true),
  promptDialog: () => Promise.resolve(null),
}));
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: noop, addEventListener: noop, removeEventListener: noop, innerWidth: 1280, innerHeight: 800 });
vi.stubGlobal('document', { addEventListener: noop, querySelector: () => null, documentElement: { classList: { toggle: noop }, style: { setProperty: noop } } });

const { openDocument, placeChips, undo, redo, useEditor, moveSelection } = await import('./editor');
const fx = await import('./fx');
const { setFxSide, useSidecar } = await import('./sidecar');
const { canonFx } = await import('../app/fxSave');

const meta = { fileName: 'fx.dtx', encoding: 'shift_jis' as const, warnings: [], hasRandom: false, siblings: [] };
const SD = 3;

/** HH（ch11）を 3 小節、8 分で。スネア（ch12）は 2 拍目と 4 拍目 */
const SONG = ['#WAV01: hh.ogg', '#WAV02: sd.ogg', '#00111: 0101010101010101', '#00211: 0101010101010101', '#00311: 0101010101010101', '#00212: 00020002'];

function open(lines: string[] = SONG) {
  setFxSide(null);
  openDocument(parseDtx(['#BPM: 120', ...lines].join('\n')).doc, meta, null);
  setFxSide(null);
}

const doc = () => useEditor.getState().doc;
const at = (m: number, n: number, d: number) => ({ m, f: frac(n, d) });
const pathOf = (v: number) => doc().fields['WAV' + toBase36x2(v)];
/** その小節の HH のチップの音のパス */
const hhPaths = (m: number) =>
  doc()
    .chips.filter((c) => c.ch === 0x11 && c.m === m)
    .sort((a, b) => a.f.n / a.f.d - b.f.n / b.f.d)
    .map((c) => pathOf(c.v));

/** 2 小節目の頭から 3 小節目の頭まで、800 Hz のハイカット */
function cutMeasure2() {
  const id = fx.addCurve('hicut');
  fx.addPoint(id, at(2, 0, 1), 800);
  fx.addPoint(id, at(3, 0, 1), 800);
  return id;
}

describe('カーブとチップの音', () => {
  it('かかる所のチップだけ、かけた音（fx/）に替わる。「;fx」の行で元の音とかけ方を書く', () => {
    open();
    cutMeasure2();
    expect(hhPaths(1).every((p) => p === 'hh.ogg')).toBe(true);
    expect(new Set(hhPaths(2))).toEqual(new Set(['fx/hh_hc800.ogg']));
    // 最後の点の所（3 小節目の頭）まではかかる。そのあとはかけない
    expect(hhPaths(3)[0]).toBe('fx/hh_hc800.ogg');
    expect(hhPaths(3).slice(1).every((p) => p === 'hh.ogg')).toBe(true);
    const text = serializeDtx(doc());
    expect(text).toContain(';fx hh.ogg hicut 800');
    // スネアもかかる（初めは全部のレーン）
    const sd = doc().chips.filter((c) => c.ch === 0x12 && c.m === 2);
    expect(sd.map((c) => pathOf(c.v))).toEqual(['fx/sd_hc800.ogg', 'fx/sd_hc800.ogg']);
  });

  it('かけるレーンを HH だけにすると、スネアは元の音に戻る', () => {
    open();
    const id = cutMeasure2();
    fx.setCurveLanes(id, ['HH']);
    const sd = doc().chips.filter((c) => c.ch === 0x12 && c.m === 2);
    expect(sd.map((c) => pathOf(c.v))).toEqual(['sd.ogg', 'sd.ogg']);
    expect(new Set(hhPaths(2))).toEqual(new Set(['fx/hh_hc800.ogg']));
  });

  it('かけている所に置いたチップはすぐかけた音、外へ動かすと元の音', () => {
    open();
    cutMeasure2();
    const [id] = placeChips([{ lane: SD, alt: false, pos: at(2, 1, 8), vel: 100 }], { select: true });
    const chip = () => doc().chips.find((c) => c.id === id)!;
    expect(pathOf(chip().v)).toBe('fx/sd_hc800.ogg');
    // 1 小節前へ（4 拍）
    moveSelection(frac(-4), 0);
    expect(chip().m).toBe(1);
    expect(pathOf(chip().v)).toBe('sd.ogg');
  });

  it('Ctrl+Z 1 回で、カーブの点とチップの音が一緒に戻る。やり直すでまた替わる', () => {
    open();
    const id = fx.addCurve('hicut');
    fx.addPoint(id, at(2, 0, 1), 800);
    fx.addPoint(id, at(3, 0, 1), 800);
    expect(new Set(hhPaths(2))).toEqual(new Set(['fx/hh_hc800.ogg']));
    undo();
    // 点が 1 つだけ：その点の所のチップだけ
    expect(useSidecar.getState().fx?.curves[0].points).toHaveLength(1);
    expect(hhPaths(2)[0]).toBe('fx/hh_hc800.ogg');
    expect(hhPaths(2).slice(1).every((p) => p === 'hh.ogg')).toBe(true);
    redo();
    expect(new Set(hhPaths(2))).toEqual(new Set(['fx/hh_hc800.ogg']));
  });

  it('14 kHz 以上のハイカットはかけない（元の音のまま）', () => {
    open();
    const id = fx.addCurve('hicut');
    fx.addPoint(id, at(2, 0, 1), 15000);
    fx.addPoint(id, at(3, 0, 1), 15000);
    expect(hhPaths(2).every((p) => p === 'hh.ogg')).toBe(true);
  });

  it('点を消すと、かけた音の WAV も消える', () => {
    open();
    const id = cutMeasure2();
    const before = Object.keys(doc().fields).filter((k) => k.startsWith('WAV')).length;
    expect(before).toBe(4);
    fx.deletePoint(id, 1);
    fx.deletePoint(id, 0);
    expect(hhPaths(2).every((p) => p === 'hh.ogg')).toBe(true);
    expect(Object.keys(doc().fields).filter((k) => k.startsWith('WAV'))).toEqual(['WAV01', 'WAV02']);
    expect(serializeDtx(doc())).not.toContain(';fx');
  });
});

describe('テンプレート', () => {
  it('ずっとこもる：選んだチップの時間に引き、最後のチップの次のグリッドで戻す。Ctrl+Z 1 回で消える', () => {
    open();
    useEditor.setState({ view: { ...useEditor.getState().view, div: 8 } });
    const ids = doc()
      .chips.filter((c) => c.ch === 0x11 && c.m === 2)
      .map((c) => c.id);
    expect(fx.applyTemplate('hold', ids)).toBe(true);
    expect(new Set(hhPaths(2))).toEqual(new Set(['fx/hh_hc800.ogg']));
    // 知らせ：1 小節だけなら「002 小節」（「002〜002」としない）
    expect(useEditor.getState().toasts.at(-1)?.text).toContain('（002 小節）');
    // 3 小節目の頭は戻した所（かけない）
    expect(hhPaths(3)[0]).toBe('hh.ogg');
    undo();
    expect(useSidecar.getState().fx?.curves ?? []).toHaveLength(0);
    expect(hhPaths(2).every((p) => p === 'hh.ogg')).toBe(true);
  });

  it('だんだんこもる：ゆっくり下げて、深いほど違う音になる', () => {
    open();
    useEditor.setState({ view: { ...useEditor.getState().view, div: 8 } });
    const ids = doc()
      .chips.filter((c) => c.ch === 0x11 && c.m === 2)
      .map((c) => c.id);
    fx.applyTemplate('close', ids);
    const ps = hhPaths(2);
    // 初めの方は浅い（かけないか高い所）、最後は 800 Hz
    expect(ps[ps.length - 1]).toBe('fx/hh_hc800.ogg');
    expect(new Set(ps).size).toBeGreaterThan(3);
  });
});

describe('切って聴く・WAV の表', () => {
  it('切って聴くと、かけた音の番号を元の音で鳴らす（譜面は変えない）', () => {
    open();
    cutMeasure2();
    const d = fx.bypassDoc(doc());
    const paths = d.chips.filter((c) => c.ch === 0x11).map((c) => d.fields['WAV' + toBase36x2(c.v)]);
    expect(paths.every((p) => p === 'hh.ogg')).toBe(true);
    expect(hhPaths(2)[0]).toBe('fx/hh_hc800.ogg');
  });

  it('かけた音は元の音ごとにまとめる（種類と値の幅）', () => {
    open();
    cutMeasure2();
    const g = fx.fxWavGroups(doc());
    expect([...g.keys()].sort()).toEqual(['hh.ogg', 'sd.ogg']);
    expect(g.get('hh.ogg')!.text).toBe('ハイカット 800 Hz');
    expect(g.get('hh.ogg')!.files).toBe(1);
  });
});

describe('ほかの難易度（保存のとき）', () => {
  it('同じカーブを入れると、その譜面のチップもかけた音になり、null で元に戻る', () => {
    open();
    cutMeasure2();
    const side = useSidecar.getState().fx;
    const other = parseDtx(['#BPM: 120', '#WAV05: hh.ogg', '#00211: 05050505'].join('\n')).doc;
    const got = fx.reconcileOther(other, side)!;
    expect(got).not.toBeNull();
    const paths = got.chips.map((c) => got.fields['WAV' + toBase36x2(c.v)]);
    expect(paths).toEqual(['fx/hh_hc800.ogg', 'fx/hh_hc800.ogg', 'fx/hh_hc800.ogg', 'fx/hh_hc800.ogg']);
    const back = fx.reconcileOther(got, null)!;
    expect(back.chips.map((c) => back.fields['WAV' + toBase36x2(c.v)])).toEqual(['hh.ogg', 'hh.ogg', 'hh.ogg', 'hh.ogg']);
    expect(serializeDtx(back)).not.toContain(';fx');
  });

  it('ほかの難易度の譜面は変わった行だけ書き換え、元に戻すと元のテキストにもどる', () => {
    open();
    cutMeasure2();
    const side = useSidecar.getState().fx;
    const text = ['#TITLE: Other', '#BPM: 120', '#WAV05: hh.ogg\t;HH', '', '#000C2: 01', '#00111: 05050505', '#00211: 05050505', '#00311: 05050505', ''].join('\r\n');
    const out = patchDtxText(text, parseDtx(text).doc, fx.reconcileOther(parseDtx(text).doc, side)!);
    const lines = out.split('\r\n');
    const no = /^#WAV(\w\w): fx\/hh_hc800\.ogg/.exec(lines.find((l) => l.startsWith('#WAV') && l.includes('fx/'))!)![1];
    expect(lines).toEqual(['#TITLE: Other', '#BPM: 120', '#WAV05: hh.ogg\t;HH', ';fx hh.ogg hicut 800', `#WAV${no}: fx/hh_hc800.ogg ; HH`, '', '#000C2: 01', '#00111: 05050505', `#00211: ${no.repeat(4)}`, `#00311: ${no}050505`, '']);
    const back = patchDtxText(out, parseDtx(out).doc, fx.reconcileOther(parseDtx(out).doc, null)!);
    expect(back).toBe(text);
  });

  it('カーブの比べ方はキーの順によらない。点が無ければエフェクトなし（null）と同じ', () => {
    const c = (points: { m: number; n: number; d: number; v: number }[]) => ({ id: 'c1', type: 'hicut' as const, points, lanes: null, q: 0 as const });
    const one = [{ m: 2, n: 0, d: 1, v: 800 }];
    expect(canonFx({ curves: [c(one)], res: 6, tails: true })).toBe(canonFx({ tails: true, res: 6, curves: [c(one)] } as never));
    expect(canonFx({ curves: [c(one)], res: 6, tails: true })).not.toBe('null');
    expect(canonFx(null)).toBe('null');
    expect(canonFx({ curves: [], res: 6, tails: true })).toBe('null');
    expect(canonFx({ curves: [c([])], res: 12, tails: false })).toBe('null');
  });
});

describe('E のキー', () => {
  it('自分で E を種類に決めていなければ、E はエフェクトの編集に使える', async () => {
    const { kindKeyChosen } = await import('./special');
    open();
    expect(kindKeyChosen('KeyE')).toBe(false);
  });
});
