// 精度テストで比べる「打点の推定のしかた」。v0（外した候補チップ）と、段階3のドラムの採譜モデル（ADTOF）。
import { analyzeAudio, type AnalysisData } from '../audio/analysis';
import { transcribe } from '../transcribe/client';
import type { DrumActivations } from '../transcribe/model';
import { drumHits } from '../transcribe/peaks';
import { classifyEvents, detectEvents } from './baseline';
import type { DrumClass } from './classes';

export interface EstHit {
  /** 曲の時刻（秒） */
  t: number;
  cls: DrumClass;
  /** 強さ（0〜1、分かれば） */
  s?: number;
}

export interface BenchInput {
  /** ステレオ（[左, 右]）かモノラル */
  channels: readonly Float32Array[];
  sr: number;
  /** 同じ曲で方式どうしが使い回す計算（解析の結果など） */
  cache: Map<string, unknown>;
}

export interface BenchMethod {
  id: string;
  label: string;
  /** どんな方式か（一覧に出す） */
  note: string;
  run(input: BenchInput): Promise<EstHit[]>;
}

function analysisOf(input: BenchInput): AnalysisData {
  let a = input.cache.get('analysis') as AnalysisData | undefined;
  if (!a) {
    a = analyzeAudio([...input.channels], input.sr);
    input.cache.set('analysis', a);
  }
  return a;
}

function baseline(sensitivity: number): BenchMethod {
  const pct = Math.round(sensitivity * 100);
  return {
    id: `v0-s${pct}`,
    label: `v0（外した候補チップ・感度${pct}）`,
    note: '混ざった音を3帯域（〜120Hz・180〜3000Hz・6kHz〜）に分けて打点を拾い、BD・SD・HH・CY に振り分ける。タムは出せない',
    async run(input) {
      const hits = classifyEvents(detectEvents(analysisOf(input), sensitivity));
      return hits.map((h) => ({ t: h.t, cls: h.lane, s: h.s }));
    },
  };
}

/** 採譜モデルの出力（同じテスト曲では1回だけ計算する） */
function activationsOf(input: BenchInput): Promise<DrumActivations> {
  let p = input.cache.get('adtof') as Promise<DrumActivations> | undefined;
  if (!p) {
    p = transcribe(input.channels, input.sr);
    input.cache.set('adtof', p);
  }
  return p;
}

function adtof(sensitivity: number): BenchMethod {
  const pct = Math.round(sensitivity * 100);
  return {
    id: `adtof-s${pct}`,
    label: `ADTOF（ブラウザ内・感度${pct}）`,
    note:
      'ドラムの採譜モデル ADTOF Frame_RNN（音ゲーの譜面と原曲 359 時間で学習、2.2MB）をブラウザの中で動かし、5種の打点を拾う。' +
      (pct === 50 ? '閾値は作者のもの' : `閾値を作者のものの ${(2 ** ((0.5 - sensitivity) * 2)).toFixed(2)} 倍にしたもの`),
    async run(input) {
      const d = await activationsOf(input);
      return drumHits(d, sensitivity).map((h) => ({ t: h.t, cls: h.cls, s: h.s }));
    },
  };
}

/** 既定で比べる方式。v0 の感度50がエディタで出していた候補チップと同じ */
export const BENCH_METHODS: readonly BenchMethod[] = [adtof(0.5), adtof(0.3), adtof(0.7), baseline(0.5)];
