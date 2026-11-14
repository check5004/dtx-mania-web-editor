// 「DTXMania の曲」の BGM にドラムが入っているか（ステム分解してドラム抜きにしていないか）の決まり。ファイルを触らない部分。
// 音を読んで調べるのは bgmListen.ts、覚えて画面に渡すのは store.ts。
// - BGM は、いちばん上の譜面（「開く」で開く譜面）の最初の BGM チップ（ch01）の音。エディタの原曲と同じ決め方
// - BGM の 3 か所（25%・50%・75% の所から 12 秒ずつ）をドラムの採譜（ADTOF）にかけ、バスドラム・スネアの打点が
//   1 分に 20 回以上ならドラム入り（エディタの「原曲にドラムが聞こえるか」drumsAudible と同じ数）。
//   2026-11-14 のテスト曲で、ドラム抜きの BGM（bgm_d.ogg）は 0〜3 回、ドラム入りの BGM は 190〜330 回。
//   ドラム抜きにドラムを足して作った音では、ドラムを 12 dB 下げても 130 回以上、20 dB 下げると 2〜53 回（ほぼ消えた残り）
// - 名前がドラム抜きらしい BGM（_nodrums・_drumless・（ドラム抜き）など）は、音を読まずにドラム抜きとする
import type { DrumClass } from '../bench/classes';
import { AUDIBLE_PER_MIN } from '../transcribe/peaks';
import type { LibChart } from './scan';

/**
 * 調べた結果。drums：ドラム入り / clean：音を聞いてドラム抜き / named：名前からドラム抜き /
 * none：BGM のチップが無い / missing：BGM のファイルが無い / error：読めなかった
 */
export type BgmState = 'drums' | 'clean' | 'named' | 'none' | 'missing' | 'error';

export interface BgmCheck {
  /** 調べた譜面（曲のフォルダからのパス）と、その大きさ・更新時刻 */
  chart: string;
  chartSig: string;
  /** BGM のファイル（曲のフォルダからの正規化したパス。BGM のチップが無ければ ''） */
  path: string;
  /** BGM のファイル名（譜面に書いてある綴り。画面に出す） */
  name: string;
  /** BGM のファイルの大きさ・更新時刻（見つからなければ ''） */
  sig: string;
  state: BgmState;
  /** 採譜したバスドラム・スネアの 1 分あたりの数（音を聞いたときだけ） */
  perMin?: number;
}

/** 聞く長さ（1 か所） */
export const LISTEN_SEC = 12;
/** 聞く所の頭と終わりのこれだけは数えない（切った所の立ち上がりを打点と間違えないように） */
const EDGE_SEC = 0.25;

/** 譜面の印（大きさ・更新時刻。変わったら BGM を決め直す） */
export function chartSigOf(c: Pick<LibChart, 'size' | 'mtime'>): string {
  return `${c.size}:${c.mtime}`;
}

/** 聞く所（秒）：25%・50%・75% の所を真ん中に 12 秒ずつ。40 秒より短い BGM は全部 */
export function listenWindows(duration: number): { from: number; to: number }[] {
  if (!(duration > 0)) return [];
  if (duration < LISTEN_SEC * 3 + 4) return [{ from: 0, to: duration }];
  return [0.25, 0.5, 0.75].map((p) => {
    const from = Math.max(0, Math.min(duration - LISTEN_SEC, duration * p - LISTEN_SEC / 2));
    return { from, to: from + LISTEN_SEC };
  });
}

/** 1 か所の打点のうち、数えるバスドラム・スネアの数（頭と終わりの EDGE_SEC は数えない）。len はその所の長さ（秒） */
export function countBdSd(hits: readonly { t: number; cls: DrumClass }[], len: number): number {
  let n = 0;
  for (const h of hits) if ((h.cls === 'BD' || h.cls === 'SD') && h.t >= EDGE_SEC && h.t <= len - EDGE_SEC) n++;
  return n;
}

/** 数えた数から 1 分あたりの数（数えた長さは、各所から頭と終わりを除いた長さ） */
export function perMinute(count: number, windows: readonly { from: number; to: number }[]): number {
  const sec = windows.reduce((a, w) => a + Math.max(0, w.to - w.from - 2 * EDGE_SEC), 0);
  return sec > 0 ? (count / sec) * 60 : 0;
}

/** 1 分あたりの数から、ドラム入りか */
export function drumsByCount(perMin: number): boolean {
  return perMin >= AUDIBLE_PER_MIN;
}

/** 結果が、いまの譜面（同じファイル・大きさ・更新時刻）のものか */
export function checkFits(c: BgmCheck | undefined, chart: Pick<LibChart, 'file' | 'size' | 'mtime'> | undefined): c is BgmCheck {
  return !!c && !!chart && c.chart.toLowerCase() === chart.file.toLowerCase() && c.chartSig === chartSigOf(chart);
}

/** 前の結果を、音を聞き直さずに使えるか（同じ BGM のファイルで、聞けた・名前で決めた結果） */
export function checkReusable(c: BgmCheck | undefined, path: string, sig: string): c is BgmCheck {
  return !!c && c.path === path && c.sig === sig && (c.state === 'drums' || c.state === 'clean' || c.state === 'named');
}
