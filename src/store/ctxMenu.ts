// 右クリックのメニュー（譜面・下の帯）。何を右クリックしたかだけを持ち、中身は ui/ContextMenu が描く。
import { create } from 'zustand';
import type { Pos } from '../edit/ops';

/** 何もない所の列 */
export type SpaceCol = 'lane' | 'bgm' | 'bpm' | 'bga' | 'audio';

export type CtxTarget =
  /** チップ（選んでいるチップを右クリックしたら選んでいるもの全部）。anchor は右クリックしたチップ */
  | { kind: 'chips'; ids: number[]; anchor: number }
  /**
   * 何もない所（レーン・BGM・BPM・BGA・原曲の列）。pos はグリッドに吸着した位置、beat はその拍。
   * レーンなら lane（DRUM_LANES の番号）と alt（Shift を押していた＝HHオープン・左バスドラム）
   */
  | { kind: 'space'; pos: Pos; beat: number; col: SpaceCol; lane?: number; alt?: boolean }
  /** 小節番号・✨ の列 */
  | { kind: 'measure'; m: number }
  /** ループの帯（譜面の左端・全体図・下の帯） */
  | { kind: 'loop'; beat: number }
  /** 曲の終わり（END） */
  | { kind: 'end' };

export type CtxMenu = CtxTarget & {
  /** 画面の座標（出す位置） */
  x: number;
  y: number;
  /** 開いた回数（中身の状態を作り直す・Undo をまとめる名前に使う） */
  seq: number;
};

interface CtxState {
  menu: CtxMenu | null;
}

export const useCtxMenu = create<CtxState>(() => ({ menu: null }));

let seq = 0;

export function openCtxMenu(t: CtxTarget, x: number, y: number) {
  useCtxMenu.setState({ menu: { ...t, x, y, seq: ++seq } });
}

/** 閉じる。開いていたら true */
export function closeCtxMenu(): boolean {
  if (!useCtxMenu.getState().menu) return false;
  useCtxMenu.setState({ menu: null });
  return true;
}

let dismissStamp = -1;

/** メニューの外を押して閉じる（その押下の timeStamp を覚えておく） */
export function dismissCtxMenu(stamp: number) {
  if (closeCtxMenu()) dismissStamp = stamp;
}

/** この押下でメニューを閉じたか。閉じるための押下は譜面に効かせない（うっかりチップを置かないように） */
export function dismissedBy(stamp: number): boolean {
  return stamp === dismissStamp;
}

// ---- ほかの機能からノーツのメニューに項目を足す口 ---------------------------------------

/** ノーツのメニューに足す項目 */
export interface CtxItem {
  label: string;
  /** 右に小さく出す説明（キーなど） */
  hint?: string;
  run: () => void;
  disabled?: boolean;
  /** 押してもメニューを閉じない */
  keepOpen?: boolean;
}

/** ids: 対象のチップ（右クリックしたチップ、選んでいるチップを右クリックしたら選択全体） */
export type ChipItemsProvider = (ids: readonly number[]) => CtxItem[];

const chipProviders: ChipItemsProvider[] = [];

/**
 * ノーツのメニューに項目を足す（読み込み時に1回呼ぶ）。
 * 足した項目は「ベロシティ・レーンなど」の下、「コピー・切り取り・削除」の上に並ぶ。
 */
export function addChipMenuItems(p: ChipItemsProvider) {
  if (!chipProviders.includes(p)) chipProviders.push(p);
}

export function chipMenuExtras(ids: readonly number[]): CtxItem[] {
  return chipProviders.flatMap((p) => p(ids));
}

/** レーンの何もない所。pos はグリッドに吸着した位置、alt は Shift を押していた（HHオープン・左バスドラム） */
export interface LaneSpot {
  lane: number;
  alt: boolean;
  pos: Pos;
}

export type LaneItemsProvider = (at: LaneSpot) => CtxItem[];

const laneProviders: LaneItemsProvider[] = [];

/** レーンの何もない所のメニューに項目を足す（読み込み時に1回呼ぶ）。グリッドのすぐ下に並ぶ */
export function addLaneMenuItems(p: LaneItemsProvider) {
  if (!laneProviders.includes(p)) laneProviders.push(p);
}

export function laneMenuExtras(at: LaneSpot): CtxItem[] {
  return laneProviders.flatMap((p) => p(at));
}
