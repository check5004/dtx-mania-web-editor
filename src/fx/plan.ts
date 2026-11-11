// チップごとのかけ方を決める（カーブの値を鳴る時刻で読み、丸める。長く鳴る音は余韻の中の動きも入れる）。
import type { TempoMap } from '../dtx/timing';
import { applies, roundValue, valsAt, type CurveBeats, type FxEmphasis, type FxKey, type FxRes, type FxSide, type FxSpec, type FxType, type FxVals } from './model';

/** 余韻もカーブどおりにする音の長さ（秒）。これより短い音は鳴り始めの値だけ */
export const LONG_SOUND_SEC = 0.4;
/** 余韻を見る長さの上限（秒） */
export const TAIL_MAX_SEC = 4;
/** 余韻の中の値を読む間隔（秒）。キーのあいだはなめらかにつなぐ */
export const TAIL_STEP_SEC = 0.125;

export interface PlanEnv {
  tempo: TempoMap;
  side: FxSide;
  curves: readonly CurveBeats[];
}

/** 丸めた値（かけないなら 0） */
function rounded(type: FxType, v: number | null, res: FxRes): number {
  if (v === null) return 0;
  const r = roundValue(type, v, res);
  return applies(type, r) ? r : 0;
}

interface Rounded {
  hc: number;
  lc: number;
  pt: number;
  hq: FxEmphasis;
  lq: FxEmphasis;
}

function roundVals(v: FxVals, res: FxRes): Rounded {
  return { hc: rounded('hicut', v.hicut, res), lc: rounded('locut', v.locut, res), pt: rounded('pitch', v.pitch, res), hq: v.hq, lq: v.lq };
}

function staticSpec(r: Rounded): FxSpec | null {
  const s: FxSpec = {};
  if (r.hc) {
    s.hc = [{ t: 0, v: r.hc }];
    if (r.hq) s.hq = r.hq;
  }
  if (r.lc) {
    s.lc = [{ t: 0, v: r.lc }];
    if (r.lq) s.lq = r.lq;
  }
  if (r.pt) s.pt = [{ t: 0, v: r.pt }];
  return s.hc || s.lc || s.pt ? s : null;
}

/** 値の並び（同じ間隔で読んだもの）を、値が替わる所のキーにする。替わる前の値も置いて、替わり目だけを短くつなぐ */
function keysOf(vals: readonly number[], step: number): FxKey[] {
  const out: FxKey[] = [{ t: 0, v: vals[0] }];
  for (let k = 1; k < vals.length; k++) {
    if (vals[k] === vals[k - 1]) continue;
    const prevT = (k - 1) * step;
    if (out[out.length - 1].t < prevT - 1e-9) out.push({ t: prevT, v: vals[k - 1] });
    out.push({ t: k * step, v: vals[k] });
  }
  return out;
}

/**
 * 時刻 beat・レーン lane のチップのかけ方（かけなければ null）。soundSec はその音の鳴っている長さ（秒。分からなければ 0）。
 * 余韻もカーブどおりにする（side.tails）ときは、鳴っているあいだの値も読み、動くなら余韻の中でも動かす
 */
export function chipSpec(env: PlanEnv, lane: number, beat: number, soundSec: number): FxSpec | null {
  const { tempo, side, curves } = env;
  const res = side.res;
  const r0 = roundVals(valsAt(curves, lane, beat), res);
  const s0 = staticSpec(r0);
  if (!side.tails || soundSec < LONG_SOUND_SEC) return s0;
  // ピッチを上げると短く、下げると長く鳴る（鳴り始めの高さで見る）
  const heard = Math.min(TAIL_MAX_SEC, soundSec / Math.pow(2, r0.pt / 12));
  if (heard < LONG_SOUND_SEC) return s0;
  const at = tempo.beatToSec(beat);
  // 鳴っているあいだにかかるカーブが無ければ、鳴り始めの値だけ
  const endBeat = tempo.secToBeat(at + heard);
  if (!curves.some((c) => c.beats.length > 0 && c.beats[0] <= endBeat + 1e-9 && c.beats[c.beats.length - 1] >= beat - 1e-9)) return s0;
  const n = Math.floor(heard / TAIL_STEP_SEC + 1e-9);
  const hc = [r0.hc];
  const lc = [r0.lc];
  const pt = [r0.pt];
  let hq = r0.hq;
  let lq = r0.lq;
  let moves = false;
  for (let k = 1; k <= n; k++) {
    const r = roundVals(valsAt(curves, lane, tempo.secToBeat(at + k * TAIL_STEP_SEC)), res);
    hc.push(r.hc);
    lc.push(r.lc);
    pt.push(r.pt);
    if (!hq && r.hc) hq = r.hq;
    if (!lq && r.lc) lq = r.lq;
    if (r.hc !== r0.hc || r.lc !== r0.lc || r.pt !== r0.pt) moves = true;
  }
  if (!moves) return s0;
  const s: FxSpec = {};
  const put = (key: 'hc' | 'lc' | 'pt', vals: number[]) => {
    if (vals.every((v) => v === 0)) return;
    s[key] = vals.every((v) => v === vals[0]) ? [{ t: 0, v: vals[0] }] : keysOf(vals, TAIL_STEP_SEC);
  };
  put('hc', hc);
  put('lc', lc);
  put('pt', pt);
  if (s.hc && hq) s.hq = hq;
  if (s.lc && lq) s.lq = lq;
  return s.hc || s.lc || s.pt ? s : null;
}
