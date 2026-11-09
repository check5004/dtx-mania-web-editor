// AI に渡す原曲の分析（ai/analysisGrid）を用意する：ドラムの採譜の確からしさと、ドラム強調のスペクトルの帯の明るさ。
// どちらも解析元の音（原曲か、解析元に選んだステム）から。スペクトルの帯は初めて使うときにワーカーで作って覚えておく。
import { ACT_ROWS, SPEC_BANDS, type AnalysisSeries, type MeasureAnalysis } from '../ai/analysisGrid';
import * as wk from '../audio/workerClient';
import type { DtxDoc } from '../dtx/model';
import { useAssist } from './assist';
import { bgmSource } from './derived';
import { drumsAudible, readyDrums } from './drums';

let specMemo: { key: string; series: AnalysisSeries } | null = null;
let specInflight: { key: string; p: Promise<AnalysisSeries | null> } | null = null;

/** 解析元の音のスペクトルの帯（作れなければ null） */
function specSeries(key: string): Promise<AnalysisSeries | null> {
  if (specMemo?.key === key) return Promise.resolve(specMemo.series);
  if (specInflight?.key === key) return specInflight.p;
  const p = wk
    .spectroZones(key, SPEC_BANDS)
    .then((z): AnalysisSeries => {
      const data = new Float32Array(z.data.length);
      for (let i = 0; i < data.length; i++) data[i] = z.data[i] / 255;
      const series = { rows: SPEC_BANDS.map((b) => b.row), rate: z.rate, frames: z.frames, data };
      specMemo = { key, series };
      return series;
    })
    .catch(() => null)
    .finally(() => {
      if (specInflight?.key === key) specInflight = null;
    });
  specInflight = { key, p };
  return p;
}

let actMemo: { data: object; series: AnalysisSeries } | null = null;

/**
 * AI に渡す原曲の分析。原曲がドラム抜き・解析がまだなら null。
 * スペクトルの帯は waitMs まで待つ（初めてで間に合わなければ採譜だけ渡し、次から使う）
 */
export async function aiAnalysis(doc: DtxDoc, waitMs = 8000): Promise<MeasureAnalysis | null> {
  const bgm = bgmSource(doc);
  const a = useAssist.getState();
  if (!bgm || !a.src || a.status !== 'ready') return null;
  if (drumsAudible() === false) return null;
  const d = readyDrums();
  let act: AnalysisSeries | null = null;
  if (d) {
    if (actMemo?.data !== d) actMemo = { data: d, series: { rows: ACT_ROWS, rate: d.fps, frames: d.frames, data: d.act } };
    act = actMemo.series;
  }
  const key = a.src.key;
  let spec: AnalysisSeries | null = null;
  if (wk.isLoaded(key)) {
    let timer = 0;
    spec = await Promise.race([specSeries(key), new Promise<null>((r) => (timer = window.setTimeout(() => r(null), waitMs)))]);
    window.clearTimeout(timer);
  }
  // 待っている間に解析元が変わったら使わない
  if (useAssist.getState().src?.key !== key) return null;
  if (!act && !spec) return null;
  return { act, spec, offsetSec: bgm.sec };
}
