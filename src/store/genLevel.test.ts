// AI難易度生成で作った譜面のレベル：エディタの「確かめる」の推定レベルと同じ計算で測り、そのまま #DLEVEL に書く。
// 楯さんの指摘（2026-11-14）:「作ったあとの難易度計算が微妙すぎる。エディタで再計算するとかなりの確率でずれている」。
// 前は元の譜面の登録レベル ÷ 推定 の倍率をかけ、AI の判定があればそれを書いていたので、開くと 0.1〜0.7 ずれていた。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDtx } from '../dtx/encoding';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import { setField } from '../edit/ops';
import { folderFromFiles, findFile, type SongFolder } from '../fs/folder';
import { levelOfDoc } from '../gen/simplify';

const AI = vi.hoisted(() => ({ on: false, bias: 0.8, mechs: [] as number[] }));
// AI の方針はどの区間もふつう（役割なし）
vi.mock('./ai', async (orig) => ({
  ...((await orig()) as object),
  hasAiKey: () => AI.on,
  runAi: async (_task: string, o: { user: string }) => {
    const spans = [...o.user.matchAll(/(\d+)〜(\d+)/g)].slice(0, 1).map((m) => ({ name: '全体', from: Number(m[1]), to: Number(m[2]) }));
    return { data: { summary: '', sections: spans.map((s) => ({ ...s, shift: 0, comment: '' })) }, costUsed: 0, model: 'mock', text: '', citations: [], webSearches: 0 };
  },
}));
// AI の判定は計算より bias だけ高く出す。渡された計算（機械的な推定）を覚えておく
vi.mock('./aiLevel', async (orig) => ({
  ...((await orig()) as object),
  judgeDoc: async (_doc: unknown, o: { mech: number }) => {
    AI.mechs.push(o.mech);
    return { level: Math.round((o.mech + AI.bias) * 100) / 100, reasons: [], confidence: 'medium', hardest: '', gap: '', cost: 0, model: 'mock', nearCount: 0 };
  },
}));
vi.mock('../ui/dialogs', () => ({ chooseDialog: async () => null, confirmDialog: async () => true }));
// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0 });

const { useEditor } = await import('./editor');
const { calcLevel, generateAll, initGen, useGen, writeOut } = await import('./gen');
const { levelOf } = await import('./check');
const { levelOfField } = await import('./guideline');

const DIFFS = ['EXTREME', 'ADVANCED', 'BASIC'] as const;
const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });

/**
 * 120BPM 16小節。前半は8分・後半は16分のハイハット、4小節ごとにフィルとクラッシュ（左右のシンバルの同時打ち）。
 * 計算（エディタの推定）は 7.6 くらい。登録レベルは #DLEVEL で決める
 */
function song(dlevel: string): DtxDoc {
  const chips = [];
  let id = 1;
  for (let m = 0; m < 16; m++) {
    const fill = m % 4 === 3;
    for (let k = 0; k < 16; k++) {
      if (fill && k >= 8) {
        if (k % 2 === 0 || m % 8 === 7) chips.push(chip(id++, k < 12 ? CH.SD : k < 14 ? CH.HT : CH.FT, m, k, 16));
        continue;
      }
      if (m >= 8 || k % 2 === 0) chips.push(chip(id++, k % 4 === 2 ? CH.HHO : CH.HHC, m, k, 16));
      if ([0, 6, 8, 10].includes(k)) chips.push(chip(id++, CH.BD, m, k, 16));
      if ([4, 12].includes(k) || (k === 15 && m % 2 === 1)) chips.push(chip(id++, CH.SD, m, k, 16));
    }
    if (m % 4 === 0) chips.push(chip(id++, CH.CY, m, 0, 1), chip(id++, CH.LC, m, 0, 1));
  }
  const doc: DtxDoc = { ...emptyDoc(), chips, nextId: id };
  for (const [k, v] of Object.entries({ TITLE: 'テスト', BPM: '120', DLEVEL: dlevel })) setField(doc, k, v);
  return doc;
}

async function textOf(folder: SongFolder, name: string) {
  return decodeDtx(new Uint8Array(await (await findFile(folder, name)!.getFile()).arrayBuffer())).text;
}

/** MASTER だけの曲を開いて AI難易度生成でまとめて作り、エディタに反映する。書いた譜面を開き直したもの */
async function makeAll(dlevel: string): Promise<{ folder: SongFolder; written: Record<(typeof DIFFS)[number], DtxDoc> }> {
  const doc = song(dlevel);
  const folder = folderFromFiles([new File([new TextEncoder().encode(serializeDtx(doc))], 'mstr.dtx')], 'テスト');
  useEditor.setState({
    doc,
    folder,
    page: 'ai',
    returnPage: undefined,
    meta: { fileName: 'mstr.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [{ file: 'mstr.dtx', label: 'MASTER' }] },
  });
  useGen.setState({ master: null });
  await initGen();
  await generateAll();
  expect(await writeOut()).toBe(true);
  const written = {} as Record<(typeof DIFFS)[number], DtxDoc>;
  for (const d of DIFFS) written[d] = parseDtx(await textOf(folder, useGen.getState().diffs[d].applied!.file)).doc;
  return { folder, written };
}

describe('作った譜面のレベル（エディタの推定と同じ）', () => {
  beforeEach(() => {
    AI.on = false;
    AI.mechs = [];
  });

  // 作者のつけ方で、登録が計算より高い譜面（9.00）も低い譜面（6.40）もある
  for (const dlevel of ['900', '640']) {
    it(`MASTER の登録 Lv ${(Number(dlevel) / 100).toFixed(2)} が計算と違っても、作った譜面の Lv は開き直したエディタの推定と同じ`, async () => {
      const { written } = await makeAll(dlevel);
      const g = useGen.getState();
      expect(Math.abs(g.masterLevel - g.masterCalc)).toBeGreaterThan(1);
      for (const d of DIFFS) {
        const ds = g.diffs[d];
        const editor = levelOf(written[d])!.level;
        expect(levelOfField(written[d].fields['DLEVEL']), d).toBeCloseTo(editor, 6);
        expect(calcLevel(ds), d).toBeCloseTo(editor, 6);
        // 作った譜面は元の譜面の写しではなく、上の譜面より計算で 0.3 以上易しい
        expect(editor, d).toBeLessThanOrEqual(g.masterCalc - 0.3 + 1e-9);
        expect(ds.result!.notesAfter, d).toBeLessThan(ds.result!.notesBefore);
      }
      expect(calcLevel(g.diffs.EXTREME)).toBeGreaterThan(calcLevel(g.diffs.ADVANCED));
      expect(calcLevel(g.diffs.ADVANCED)).toBeGreaterThan(calcLevel(g.diffs.BASIC));
    });
  }

  it('AI の判定があっても、Lv は計算のまま（判定は参考）。AI に渡す計算もエディタの推定', async () => {
    // AI なしで作ったときの、目標の幅からの外れ（段の間が広いと少し外れることがある）
    await makeAll('760');
    const gapOf = (lv: number, t: { min: number; max: number }) => Math.max(0, t.min - lv, lv - t.max);
    const base = Object.fromEntries(DIFFS.map((d) => [d, gapOf(calcLevel(useGen.getState().diffs[d]), useGen.getState().diffs[d].target)]));
    AI.on = true;
    const { written } = await makeAll('760');
    const g = useGen.getState();
    for (const d of DIFFS) {
      const ds = g.diffs[d];
      expect(ds.judge, d).toBeTruthy();
      expect(ds.judge!.level, d).not.toBeCloseTo(calcLevel(ds), 1);
      expect(levelOfField(written[d].fields['DLEVEL']), d).toBeCloseTo(levelOf(written[d])!.level, 6);
      expect(levelOfField(written[d].fields['DLEVEL']), d).toBeCloseTo(calcLevel(ds), 6);
      // AI が幅より高いと見て作り直しても、反映するレベル（計算）は目標の幅から遠ざけない
      expect(gapOf(calcLevel(ds), ds.target), d).toBeLessThanOrEqual(base[d] + 1e-9);
    }
    // AI に渡した「機械的な推定」は、作った譜面のエディタの推定（倍率をかけない）
    expect(AI.mechs.length).toBeGreaterThanOrEqual(3);
    const made = DIFFS.map((d) => levelOfDoc(g.diffs[d].result!.doc));
    for (const d of DIFFS) expect(AI.mechs).toContain(calcLevel(g.diffs[d]));
    for (const m of AI.mechs) expect(m).toBeLessThanOrEqual(Math.max(...made) + 1);
  });
});
