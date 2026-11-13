// 新しい譜面のテンポの案：1 拍目を和音の変わり目でも確かめる（refineWithChords）。
// 測っている最中にもう一度呼ばれたら、同じ答えを待つ（おまかせで準備は、確かめてから案を反映する）。
import { describe, expect, it, vi } from 'vitest';
import type { AnalysisData } from '../audio/analysis';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';

// トーストが消える時計（テストでは使わない）
vi.stubGlobal('window', { setTimeout: () => 0 });

// 和音の変わり目はワーカーで曲の音から測る。テストが答えを返すまで待たせる
const wk = vi.hoisted(() => ({ calls: 0, answer: null as null | ((v: number[]) => void) }));
vi.mock('../audio/workerClient', async (orig) => ({
  ...(await orig<typeof import('../audio/workerClient')>()),
  chordChange: () => {
    wk.calls++;
    return new Promise<number[]>((r) => (wk.answer = r));
  },
}));
vi.mock('./chorus', async (orig) => ({
  ...(await orig<typeof import('./chorus')>()),
  songAudioKey: async () => ({ key: 'song', offset: 0 }),
}));

const { useEditor } = await import('./editor');
const { useAssist } = await import('./assist');
const { useSidecar } = await import('./sidecar');
const { applyTempo, initTempo, refineWithChords, useTempo } = await import('./tempoUi');

/** BPM 120、拍は 0.25 秒から。ドラムの形だけだと 3 拍目（1.25 秒）を 1 拍目にする */
function analysis(): AnalysisData {
  const z = () => new Float32Array(3000);
  return {
    duration: 30,
    peakRate: 100,
    peaks: new Float32Array(3000),
    frameRate: 100,
    odf: { low: z(), mid: z(), high: z() },
    env: { low: z(), mid: z(), high: z() },
    tempo: [{ bpm: 120, score: 1, kind: 'best', phase: 0.25 }],
    bars: [{ bpm: 120, beat: 0.25, fit: [10, 2, 10.5, 2], k: 2, score: 10 }],
    start: 0.2,
  };
}

/** 原曲（BGM）だけの新しい譜面 */
function newSong(): DtxDoc {
  return { ...emptyDoc(), fields: { TITLE: 'テスト', BPM: '120', WAV01: 'song.ogg' }, chips: [{ id: 1, ch: CH.BGM, m: 0, f: { n: 0, d: 1 }, v: 1 }], nextId: 2 };
}

describe('1 拍目を和音の変わり目で確かめる', () => {
  it('測っている最中にもう一度呼ぶと同じ答えを待ち、確かめた案を反映できる', async () => {
    useSidecar.setState({ anchors: [] });
    useTempo.setState({ initialized: false });
    useAssist.setState({ data: analysis(), status: 'ready' });
    useEditor.setState({
      doc: newSong(),
      page: 'tempo',
      past: [],
      future: [],
      meta: { fileName: 'song.dtx', encoding: 'shift_jis', warnings: [], hasRandom: false, siblings: [] },
    });
    // 画面を開くと推定の案（ドラムの形だけ）を作り、和音の変わり目を測り始める
    initTempo();
    expect(useTempo.getState().fromEstimate).toBe(true);
    expect(useTempo.getState().plan.anchors[0].t).toBeCloseTo(1.25, 6);
    // おまかせで準備は、ここでもう一度呼んで待つ（前は null がすぐ返り、形だけの案を反映していた）
    const again = refineWithChords();
    await vi.waitFor(() => expect(wk.answer).not.toBeNull());
    wk.answer!([5, 1, 1, 1]);
    expect(await again).toEqual([5, 1, 1, 1]);
    expect(wk.calls).toBe(1);
    // 和音は拍の位置から 0 拍目で変わる：1 小節目の頭は 0.25 秒
    expect(useTempo.getState().plan.anchors[0].t).toBeCloseTo(0.25, 6);
    expect(applyTempo({ quiet: true })).toBe(true);
    expect(useSidecar.getState().anchors[0].t).toBeCloseTo(0.25, 6);
    // わかった答えは測り直さない
    expect(await refineWithChords()).toEqual([5, 1, 1, 1]);
    expect(wk.calls).toBe(1);
  });
});
