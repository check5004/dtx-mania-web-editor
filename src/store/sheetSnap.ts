// 下から出すパネルの「止まる高さ」と、その高さでの中身の並べ方（React に依らない）。
// タブレット版の縦のシート・横のトラックの帯：指を離したら近い高さで止め、はじいたらその向きの次の高さへ、強くはじいたら動きを先へ延ばした所へ（iOS のシートと同じ考え方）。
// PC の下のトラック：境目のドラッグ中に止まる高さへ吸い付く（Alt で自由な高さ）

/** 縦のシートの高さ：タブだけ・細い・低い・半分・大 */
export type SheetSize = 'tabs' | 'slim' | 'low' | 'half' | 'full';
/** 開いているときの高さ（タブだけを除く） */
export type OpenSheetSize = Exclude<SheetSize, 'tabs'>;

export const SHEET_SIZES: readonly SheetSize[] = ['tabs', 'slim', 'low', 'half', 'full'];
export const OPEN_SHEET_SIZES: readonly OpenSheetSize[] = ['slim', 'low', 'half', 'full'];

/** つまみ 16＋タブ 64 */
export const SHEET_GRIP = 16;
export const SHEET_TABS = 64;

/**
 * シート全体の高さ。中身の高さは「高さ − 80」。
 * 細い 196：パッドを横 1 列（12 個）／低い 304：キット 4×3 を詰めて／半分 420・大 600 は前からの高さ
 */
export const SHEET_H: Record<SheetSize, number> = {
  tabs: SHEET_GRIP + SHEET_TABS,
  slim: 196,
  low: 304,
  half: 420,
  full: 600,
};

export function isOpenSheetSize(v: unknown): v is OpenSheetSize {
  return v === 'slim' || v === 'low' || v === 'half' || v === 'full';
}

/** これより速く動かして離したら「はじいた」（px/ms） */
export const FLICK_V = 0.3;
/** これより速くはじいたら、動きを先へ延ばして何段も進める（px/ms） */
export const FLING_V = 2.4;
/** 強くはじいたとき、動きを先へ延ばす時間（ミリ秒） */
export const FLICK_PROJECT_MS = 160;

/**
 * 止まる高さのうち、指を離したときに止めるもの（vy: 離す直前の速さ、+ で高くする向き）。
 * ゆっくりならいちばん近い高さ、はじいたらその向きの次の高さ、強くはじいたら動きを先へ延ばした所にいちばん近い高さ
 */
export function snapHeight(h: number, vy: number, stops: readonly number[]): number {
  if (stops.length === 0) return h;
  const v = Number.isFinite(vy) ? Math.max(-4, Math.min(4, vy)) : 0;
  const nearest = (goal: number) => stops.reduce((a, b) => (Math.abs(b - goal) < Math.abs(a - goal) ? b : a));
  if (Math.abs(v) < FLICK_V) return nearest(h);
  if (Math.abs(v) >= FLING_V) return nearest(h + v * FLICK_PROJECT_MS);
  const sorted = [...stops].sort((a, b) => a - b);
  if (v > 0) return sorted.find((s) => s > h + 4) ?? sorted[sorted.length - 1];
  return [...sorted].reverse().find((s) => s < h - 4) ?? sorted[0];
}

/** 縦のシート：画面に入る高さ（maxH）で切った止まる高さから、いちばん近いもの。上限で同じ高さになるときは小さい方の名前 */
export function snapSheet(h: number, vy: number, maxH: number): SheetSize {
  const heights = SHEET_SIZES.map((s) => Math.min(maxH, SHEET_H[s]));
  const best = snapHeight(h, vy, heights);
  return SHEET_SIZES[heights.indexOf(best)];
}

/** 矢印キー・つまみのタップで 1 段ずつ動かす（dir: +1 で高く） */
export function stepSheet(size: SheetSize, dir: 1 | -1, maxH: number): SheetSize {
  const heights = SHEET_SIZES.map((s) => Math.min(maxH, SHEET_H[s]));
  let i = SHEET_SIZES.indexOf(size);
  const h0 = heights[i];
  // 上限で同じ高さになっている段は飛ばす
  do i += dir;
  while (i > 0 && i < SHEET_SIZES.length && heights[i] === h0);
  return SHEET_SIZES[Math.max(0, Math.min(SHEET_SIZES.length - 1, i))];
}

/**
 * 横のトラックの帯の止まる高さ：閉じた帯（closed）、上の帯＋トラック 1 本ずつ（row の高さ）、全部をゆったり（roomy の高さ）。
 * maxH を超える段は入れない（いちばん上は maxH）
 */
export function trackStops(n: number, opts: { closed: number; ruler: number; row: number; roomy: number; maxH: number }): number[] {
  const { closed, ruler, row, roomy, maxH } = opts;
  const out = [closed];
  for (let k = 1; k <= Math.max(1, n); k++) {
    const h = ruler + 1 + k * row;
    if (h > maxH) break;
    out.push(h);
  }
  const all = ruler + 1 + Math.max(1, n) * roomy;
  if (all <= maxH && all > out[out.length - 1] + 8) out.push(all);
  if (out[out.length - 1] < maxH && out.length === 1) out.push(maxH);
  return out;
}

/**
 * トラックの 1 本の高さ。全部入れば min〜max の間で均等に、入らなければ半端に切れないように「入る本数」で割る
 */
export function fitRowHeight(bodyH: number, rows: number, min: number, max: number): number {
  const n = Math.max(1, rows);
  const even = Math.floor(bodyH / n);
  if (even >= min) return Math.min(max, even);
  const k = Math.max(1, Math.floor(bodyH / min));
  return Math.max(min, Math.min(max, Math.floor(bodyH / k)));
}

/**
 * 縦のシートでのパッドの並べ方（シートの中の高さ・幅で決める）。
 * roomy：キット 4×3 と右に入れ方の説明（半分・大）／compact：4×3 を詰める（低い）／row：横 1 列に 12 個（細い）。
 * レーンの並びは roomy（HH・LP を上下に割る）か row（割らずに、Shift の音を空いた所へ）
 */
export type PadDensity = 'roomy' | 'compact' | 'row';

/** 見出しの行（44）・すき間（8）・上下の余白（2＋10）を除いた、パッドに使える高さ */
const SHEET_PAD_CHROME = 44 + 8 + 12;

export function padDensity(layout: 'kit' | 'lane', w: number, h: number): PadDensity {
  const area = h - SHEET_PAD_CHROME;
  // レーン：HH・LP を上下に割っても 1 つ 40 以上取れれば今の並び
  if (layout === 'lane') return area >= 2 * 40 + 4 ? 'roomy' : 'row';
  if (area >= 3 * 72 + 2 * 8 && w >= 640) return 'roomy';
  if (area >= 3 * 44 + 2 * 6) return 'compact';
  return 'row';
}

// ---- PC の下のトラック ----------------------------------------------------------------

/**
 * PC の下のトラックの止まる高さ：閉じる（上の帯だけ）・1本・細く（全部を1行で）・標準（名前の下にファイル名）・ゆったり（波形を大きく）。
 * 1本より上は「トラックの数×1本の高さ」なので、ステムを足すとそれに合わせて伸びる
 */
export type DeskTrackStop = 'closed' | 'one' | 'slim' | 'std' | 'roomy';
/** 開いているときの止まる高さ（閉じるを除く） */
export type OpenDeskTrackStop = Exclude<DeskTrackStop, 'closed'>;

export const DESK_TRACK_STOPS: readonly DeskTrackStop[] = ['closed', 'one', 'slim', 'std', 'roomy'];

/** PC のトラック 1 本の高さ：細く 24（いちばん低い）・標準 42（ファイル名の行が出る）・ゆったり 64（いちばん高い） */
export const DESK_TRACK_ROW = { min: 24, std: 42, max: 64 } as const;

/** ドラッグ中に止まる高さへ吸い付く距離（px） */
export const DESK_SNAP_PX = 10;

export function isOpenDeskTrackStop(v: unknown): v is OpenDeskTrackStop {
  return v === 'one' || v === 'slim' || v === 'std' || v === 'roomy';
}

/** 止まる高さの px（ruler: 上の帯の高さ。帯の下の線 1px を足す） */
export function deskStopHeight(stop: DeskTrackStop, rows: number, ruler: number): number {
  const n = Math.max(1, rows);
  if (stop === 'closed') return ruler;
  const row = stop === 'one' || stop === 'slim' ? DESK_TRACK_ROW.min : stop === 'std' ? DESK_TRACK_ROW.std : DESK_TRACK_ROW.max;
  return ruler + 1 + (stop === 'one' ? 1 : n) * row;
}

/** 画面に入る（maxH 以下の）止まる高さ。同じ高さになるものは小さい方の名前だけ（閉じるは必ず入れる） */
export function deskTrackStops(rows: number, ruler: number, maxH: number): { stop: DeskTrackStop; h: number }[] {
  const out: { stop: DeskTrackStop; h: number }[] = [];
  for (const stop of DESK_TRACK_STOPS) {
    const h = deskStopHeight(stop, rows, ruler);
    if (stop !== 'closed' && h > maxH) continue;
    if (out.some((s) => s.h === h)) continue;
    out.push({ stop, h });
  }
  return out;
}

/** ドラッグ中の高さを、近い（radius 以内の）止まる高さに吸い付ける。遠ければそのまま（stop なし） */
export function magnetHeight(h: number, stops: readonly { stop: DeskTrackStop; h: number }[], radius = DESK_SNAP_PX): { h: number; stop?: DeskTrackStop } {
  let best: { stop: DeskTrackStop; h: number } | null = null;
  for (const s of stops) if (Math.abs(s.h - h) <= radius && (!best || Math.abs(s.h - h) < Math.abs(best.h - h))) best = s;
  return best ? { h: best.h, stop: best.stop } : { h };
}

/** 矢印キーで 1 段ずつ（今の高さ h から dir の向きの次の止まる高さ。端ならそのまま） */
export function stepDeskStop(h: number, dir: 1 | -1, stops: readonly { stop: DeskTrackStop; h: number }[]): { stop: DeskTrackStop; h: number } | null {
  const sorted = [...stops].sort((a, b) => a.h - b.h);
  if (dir > 0) return sorted.find((s) => s.h > h + 1) ?? null;
  return [...sorted].reverse().find((s) => s.h < h - 1) ?? null;
}
