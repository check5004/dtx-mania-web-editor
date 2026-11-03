// 正解の打点。譜面の通常チップ（見えるチップ）を、譜面の時刻（秒）と採点の種類にする。
import { CH, type DtxDoc } from '../dtx/model';
import { tempoOf } from '../store/derived';
import { classOfChannel, type DrumClass } from './classes';

export interface ChartHit {
  /** 譜面の時刻（秒） */
  t: number;
  cls: DrumClass;
  ch: number;
  /** 鳴らす WAV の番号 */
  wav: number;
  /** 同じグループの前の音を止める（ハイハットの開閉・同じチャンネルの連打） */
  choke: string;
}

/** 譜面のドラムの通常チップを時刻順に並べる */
export function chartHits(doc: DtxDoc): ChartHit[] {
  const t = tempoOf(doc);
  const out: ChartHit[] = [];
  for (const c of doc.chips) {
    const cls = classOfChannel(c.ch);
    if (!cls) continue;
    const choke = c.ch === CH.HHC || c.ch === CH.HHO || c.ch === CH.LP ? 'HH' : `ch${c.ch}`;
    out.push({ t: t.beatToSec(t.beatOf(c.m, c.f)), cls, ch: c.ch, wav: c.v, choke });
  }
  return out.sort((a, b) => a.t - b.t || a.ch - b.ch);
}

export interface TruthHit {
  t: number;
  cls: DrumClass;
  /** まとめたチップのチャンネル（HHクローズと左ペダルが同時、など） */
  chs: number[];
}

/**
 * 採点に使う正解。同じ種類でほぼ同時（既定 10ms 以内）のチップは、聞こえ方も推定の出し方も1打なので1つにまとめる。
 */
export function truthFrom(hits: readonly ChartHit[], mergeSec = 0.01): TruthHit[] {
  const last = new Map<DrumClass, TruthHit>();
  const out: TruthHit[] = [];
  for (const h of hits) {
    const prev = last.get(h.cls);
    if (prev && h.t - prev.t <= mergeSec) {
      if (!prev.chs.includes(h.ch)) prev.chs.push(h.ch);
      continue;
    }
    const x: TruthHit = { t: h.t, cls: h.cls, chs: [h.ch] };
    last.set(h.cls, x);
    out.push(x);
  }
  return out;
}
