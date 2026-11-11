// 特殊ノーツ（クラップなど）：見分け・列の一覧・置く・重なり・行き先・このチップを自動で鳴らす・特殊ノーツにする・やめる・キー
import { describe, expect, it, vi } from 'vitest';
import { toBase36x2 } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { kindOfSound, specialWavs } from '../dtx/kinds';
import { CH, isSeChannel } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';

const noop = () => undefined;
vi.mock('../ui/dialogs', () => ({
  chooseDialog: () => Promise.resolve('auto'),
  confirmDialog: () => Promise.resolve(true),
  promptDialog: () => Promise.resolve(null),
}));
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: noop, addEventListener: noop, removeEventListener: noop, innerWidth: 1280, innerHeight: 800 });
vi.stubGlobal('document', { addEventListener: noop, querySelector: () => null, documentElement: { classList: { toggle: noop }, style: { setProperty: noop } } });

const { openDocument, placeChips, undo, useEditor } = await import('./editor');
const sp = await import('./special');
const { chipSpecialKind, specialKinds, specialLayout } = await import('./specialLayout');
const { parseSidecar, setSpecialSide, useSidecar } = await import('./sidecar');
const { setVelOf } = await import('./velocity');
const { useInputSettings } = await import('../input/settings');
const { chipViews } = await import('./derived');

const meta = { fileName: 'sp.dtx', encoding: 'shift_jis' as const, warnings: [], hasRandom: false, siblings: [] };
const HT_LANE = 4;

/** Mela! のように、クラップをハイタム（ch14）に置いた譜面 */
const MELA = ['#WAV0A: clap1.ogg', '#WAV0B: 044_Tom_Hi.ogg', '#WAV0C: 039_Snare.ogg', '#00114: 0A0A0B0A', '#00214: 0A000A00'];

function open(lines: string[]) {
  setSpecialSide(null);
  openDocument(parseDtx(['#BPM: 120', ...lines].join('\n')).doc, meta, null);
}

const doc = () => useEditor.getState().doc;
const chipOf = (id: number) => doc().chips.find((c) => c.id === id);
const at = (m: number, n: number, d: number) => ({ m, f: frac(n, d) });
const kindAt = (m: number, n: number, d: number) =>
  doc()
    .chips.filter((c) => c.m === m && c.f.n * d === n * c.f.d)
    .map((c) => chipSpecialKind(specialLayout(doc()), c) ?? null);

describe('見分け', () => {
  it('ラベルが無ければファイル名、あればラベル。ラベルがクラップでもファイル名がはっきりほかの楽器ならどちらにもしない', () => {
    expect(kindOfSound('se/clap1.ogg', null)).toBe('clap');
    expect(kindOfSound('se01.wav', 'Hand Clap')).toBe('clap');
    expect(kindOfSound('BYB-PHIHAT.ogg', 'SE1 Hand Clap')).toBe(null);
    expect(kindOfSound('tambourine.wav', null)).toBe('tamb');
    expect(kindOfSound('clap_snare.wav', null)).toBe(null);
    expect(kindOfSound('041_cowbell.ogg', null)).toBe('cowbell');
  });

  it('ハイタムに置いたクラップは特殊ノーツ。行き先は置いてあるレーン（ハイタム）で、譜面は変えない', () => {
    open(MELA);
    const kinds = specialKinds(doc());
    expect(kinds.map((k) => [k.id, k.count, k.dest])).toEqual([['clap', 5, CH.HT]]);
    const views = chipViews(doc());
    expect(views.filter((v) => v.sp === 'clap')).toHaveLength(5);
    expect(views.filter((v) => !v.sp && v.c.ch === CH.HT)).toHaveLength(1);
    expect(serializeDtx(doc())).toContain('#00114: 0A0A0B0A');
  });

  it('ハイタムを置くとタムの音（クラップがいちばん多くても、クラップの音にしない）', () => {
    open(MELA);
    const [id] = placeChips([{ lane: HT_LANE, alt: false, pos: at(3, 0, 1), vel: 100 }], { select: false });
    expect(chipOf(id)!.v).toBe(11);
  });

  it('作業ファイルの決め：読めない行き先・SE は捨て、やめた種類（off）は残す', () => {
    const d = parseSidecar(
      JSON.stringify({
        version: 1,
        special: {
          kinds: [
            { id: 'clap', dest: 0x01, se: 0x14, off: true },
            { id: 'sp1', label: 'Scratch', dest: 0x14, se: 0x62 },
          ],
        },
      }),
    );
    expect(d?.special?.kinds).toEqual([
      { id: 'clap', off: true },
      { id: 'sp1', label: 'Scratch', dest: 0x14, se: 0x62 },
    ]);
  });
});

describe('置く・重なり', () => {
  it('行き先のレーンに置く。同じ時刻にもうチップがあれば置かずに知らせ、「自動で鳴らす」なら SE に置ける', () => {
    open(MELA);
    const tomAt = at(1, 2, 4);
    expect(sp.placeSpecial('clap', tomAt)).toBe(null);
    const id = sp.placeSpecial('clap', tomAt, { auto: true });
    expect(id).not.toBe(null);
    expect(isSeChannel(chipOf(id!)!.ch)).toBe(true);
    expect(kindAt(1, 2, 4)).toContain('clap');
    // 空いている所は行き先（ハイタム）に
    const id2 = sp.placeSpecial('clap', at(3, 1, 4));
    expect(chipOf(id2!)!.ch).toBe(CH.HT);
    // もう同じ種類があればそれを返す
    expect(sp.placeSpecial('clap', at(3, 1, 4))).toBe(id2);
  });

  it('クラップの所にハイタムを置くと、クラップは消さずに自動で鳴らすにする（Ctrl+Z で両方戻る）', () => {
    open(MELA);
    const before = doc().chips.length;
    placeChips([{ lane: HT_LANE, alt: false, pos: at(1, 0, 4), vel: 100 }], { select: false });
    expect(doc().chips.length).toBe(before + 1);
    const here = doc().chips.filter((c) => c.m === 1 && c.f.n === 0);
    expect(here.map((c) => (isSeChannel(c.ch) ? 'se' : c.ch)).sort()).toEqual([CH.HT, 'se'].sort());
    expect(kindAt(1, 0, 4)).toContain('clap');
    undo();
    expect(doc().chips.length).toBe(before);
    expect(
      doc()
        .chips.filter((c) => c.m === 1 && c.f.n === 0)
        .map((c) => c.ch),
    ).toEqual([CH.HT]);
  });

  it('このチップを自動で鳴らす・叩くに戻す', () => {
    open(MELA);
    const clap = doc().chips.find((c) => c.m === 2 && c.f.n === 0)!;
    expect(sp.setChipsAuto([clap.id], true)).toBe(1);
    expect(isSeChannel(chipOf(clap.id)!.ch)).toBe(true);
    expect(sp.setChipsAuto([clap.id], false)).toBe(1);
    expect(chipOf(clap.id)!.ch).toBe(CH.HT);
  });
});

describe('行き先を変える', () => {
  it('置いてあるクラップも動く。重なる所は自動で鳴らす。Ctrl+Z で行き先の決めも戻る', () => {
    open([...MELA, '#00112: 000C0000']);
    const r = sp.moveKindDest('clap', CH.SD, 'auto');
    expect(r).toEqual({ moved: 4, auto: 1, dropped: 0 });
    const k = specialKinds(doc()).find((x) => x.id === 'clap')!;
    expect(k.dest).toBe(CH.SD);
    expect(k.autoCount).toBe(1);
    expect(serializeDtx(doc())).not.toMatch(/#00114: 0A/);
    undo();
    expect(specialKinds(doc()).find((x) => x.id === 'clap')!.dest).toBe(CH.HT);
    expect(useSidecar.getState().special?.kinds.find((d) => d.id === 'clap')?.dest).toBeUndefined();
    expect(serializeDtx(doc())).toContain('#00114: 0A0A0B0A');
  });

  it('消すを選ぶと重なる所のクラップを消す', () => {
    open([...MELA, '#00112: 000C0000']);
    const r = sp.moveKindDest('clap', CH.SD, 'drop');
    expect(r).toEqual({ moved: 4, auto: 0, dropped: 1 });
    expect(specialKinds(doc()).find((x) => x.id === 'clap')!.count).toBe(4);
  });
});

describe('特殊ノーツにする・やめる', () => {
  it('ファイル名で分からない音は、ラベルを付けた番号を作ってクラップにする。ベロシティを変えてもクラップのまま', () => {
    open(['#WAV01: se01.wav', '#WAV0B: 044_Tom_Hi.ogg', '#00114: 0101', '#00214: 0B']);
    const ids = doc()
      .chips.filter((c) => c.m === 1)
      .map((c) => c.id);
    expect(sp.makeChipsSpecial(ids, 'clap')).toBe(2);
    const v = chipOf(ids[0])!.v;
    expect(v).not.toBe(1);
    expect(doc().fields['WAV' + toBase36x2(v)]).toBe('se01.wav');
    expect(specialWavs(doc()).get(v)).toBe('clap');
    expect(serializeDtx(doc())).toContain('Hand Clap');
    // ベロシティを変えて戻しても、ラベルの無い se01.wav（01）にはしない
    setVelOf([ids[0]], 50);
    expect(specialWavs(doc()).get(chipOf(ids[0])!.v)).toBe('clap');
    setVelOf([ids[0]], 100);
    expect(chipOf(ids[0])!.v).toBe(v);
  });

  it('ふつうのハイタムに戻すと、音もハイタムの音', () => {
    open(MELA);
    const clap = doc().chips.find((c) => c.m === 2 && c.f.n === 0)!;
    expect(sp.unmakeSpecial([clap.id])).toBe(1);
    expect(chipOf(clap.id)!.v).toBe(11);
    expect(chipSpecialKind(specialLayout(doc()), chipOf(clap.id)!)).toBeUndefined();
  });

  it('特殊ノーツをやめると、譜面はそのままでハイタムのチップとして見える', async () => {
    open(MELA);
    const text = serializeDtx(doc());
    expect(await sp.stopKind('clap')).toBe(true);
    expect(specialKinds(doc())).toEqual([]);
    expect(chipViews(doc()).filter((v) => v.sp)).toHaveLength(0);
    expect(serializeDtx(doc())).toBe(text);
    // ＋足す で戻せる
    sp.addPresetKind('clap');
    expect(specialKinds(doc()).map((k) => k.id)).toEqual(['clap']);
  });
});

describe('キー・MIDI', () => {
  it('Q はクラップ。レーンに割り当てたキーはレーンが先、種類で決めたキーは種類が先', () => {
    open(MELA);
    expect(sp.kindForKey('KeyQ')).toBe('clap');
    expect(sp.kindForKey('KeyW')).toBe('tamb');
    expect(sp.kindForKey('KeyQ', true)).toBe(null);
    sp.updateKind('clap', { key: 'KeyS' });
    expect(sp.kindForKey('KeyS', true)).toBe('clap');
    expect(sp.kindForKey('KeyQ')).toBe(null);
    expect(useInputSettings.getState().keys.KeyS).toBe(1);
  });

  it('GM の 39 はクラップ。レーンに割り当てたノートはレーンが先', () => {
    open(MELA);
    expect(sp.kindForNote(39)).toBe('clap');
    expect(sp.kindForNote(39, true)).toBe(null);
    expect(sp.kindForNote(54)).toBe('tamb');
    expect(sp.kindForNote(38)).toBe(null);
  });

  it('分けるのをやめた曲（お知らせの「元に戻す」）ではキーで置かない', () => {
    open(MELA);
    sp.setSpecialOff(true);
    expect(sp.kindForKey('KeyQ')).toBe(null);
    expect(specialLayout(doc()).on).toBe(false);
    sp.setSpecialOff(false);
    expect(specialLayout(doc()).on).toBe(true);
  });
});
