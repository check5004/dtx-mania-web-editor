// AI難易度生成の「並べて比べる」表示の計算。描画・当たり判定・聴く譜面の切り替えで共通に使う（React に依存しない）。

/** 小節番号の列の幅（左端はループの帯） */
export const GUTTER_W = 48;
/** ループの帯の幅（小節番号の列の左端） */
export const LOOP_BAND_W = 6;
/** 列のあいだ */
export const COL_GAP = 10;
/** 列の幅の上限（列が少ないときに横へ間延びしないように） */
export const MAX_COL_W = 360;
/** 列の幅の下限（狭い画面では横にはみ出させずに詰める） */
export const MIN_COL_W = 120;
/** 譜面の下の余白（0 拍目の線を下端に貼りつかせない） */
export const PAD_BOTTOM = 10;
/** 再生位置を追いかけるとき、再生位置の線を置く高さ（下からの割合。エディタと同じ） */
export const FOLLOW_AT = 0.22;

export interface ColumnBox {
  x: number;
  w: number;
  /** 1レーンの幅 */
  laneW: number;
}

export interface CompareLayout {
  /** 小節番号の列（左端から） */
  gutter: number;
  cols: ColumnBox[];
  /** 使う幅（列が少ないときは全体の幅より狭い） */
  width: number;
}

/** 列の並べ方：小節番号の列のあとに、同じ幅の列を並べる。広すぎるときは MAX_COL_W まで */
export function layoutColumns(width: number, n: number): CompareLayout {
  const count = Math.max(1, n);
  const room = Math.max(0, width - GUTTER_W - COL_GAP * (count - 1));
  const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.floor(room / count)));
  const cols: ColumnBox[] = [];
  for (let i = 0; i < count; i++) cols.push({ x: GUTTER_W + i * (w + COL_GAP), w, laneW: w / 10 });
  return { gutter: GUTTER_W, cols, width: GUTTER_W + count * w + COL_GAP * (count - 1) };
}

/** x がどの列か（-1 は小節番号の列、null は列のあいだ・外） */
export function columnAt(lay: CompareLayout, x: number): number | null {
  if (x < lay.gutter) return -1;
  for (let i = 0; i < lay.cols.length; i++) {
    const c = lay.cols[i];
    if (x >= c.x && x < c.x + c.w) return i;
  }
  return null;
}

/** 拍と高さの変換（下から上へ流れる。エディタの譜面と同じ向き） */
export interface CompareGeom {
  beatToY: (beat: number) => number;
  yToBeat: (y: number) => number;
  minBeat: number;
  maxBeat: number;
}

export function compareGeom(h: number, scrollBeat: number, px: number): CompareGeom {
  const bottom = h - PAD_BOTTOM;
  return {
    beatToY: (b) => bottom - (b - scrollBeat) * px,
    yToBeat: (y) => scrollBeat + (bottom - y) / px,
    minBeat: scrollBeat - PAD_BOTTOM / px,
    maxBeat: scrollBeat + bottom / px,
  };
}

/** 隣の選択肢（端で止まる。今のものが無ければ先頭から数える） */
export function stepIn<T>(list: readonly T[], cur: T, dir: 1 | -1): T | null {
  if (list.length === 0) return null;
  const i = list.indexOf(cur);
  if (i < 0) return list[0];
  return list[Math.max(0, Math.min(list.length - 1, i + dir))];
}

/** 小節番号を何小節おきに書くか（文字が重ならないように） */
export function labelEvery(pxPerMeasure: number): number {
  for (const k of [1, 2, 4, 8, 16, 32, 64]) if (pxPerMeasure * k >= 16) return k;
  return 128;
}

/** 見える範囲の最初の要素（beat の昇順の配列で、beat ≧ from の最初の位置） */
export function firstAtOrAfter(list: readonly { beat: number }[], from: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].beat < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** n 小節ぶんが高さ h に収まる 1拍の高さ（拍子が混ざっても、拍の数で合わせる） */
export function pxToFit(h: number, beats: number): number {
  return Math.max(0.5, (h - PAD_BOTTOM - 8) / Math.max(1, beats));
}

/** チップの高さ（詰まった所でも重ならないように、拍の高さに合わせて縮める） */
export function chipHeight(px: number): number {
  return Math.max(2, Math.min(7, px * 0.22));
}
