// 「DTXMania の曲」の見せ方（並べ替え・BOX・しぼりこみ・選んだ曲）を覚えておく形。曲の一覧とホームのカードで同じものを使い、
// アプリを閉じても次に開いたときに続きから見られるように、このブラウザ（localStorage）に残す。探す言葉は残さない（開いている間だけ）。
import { NX_FILTERS, type NxFilter, type NxSort } from './view';

export const NX_VIEW_KEY = 'dtxe.nxview.v1';

export interface NxViewPrefs {
  sort: NxSort;
  box: string | null;
  filter: NxFilter | null;
  sel: string | null;
}

const SORTS: readonly NxSort[] = ['updated', 'title', 'artist', 'bpm', 'level', 'checks'];

/** 残しておいた文字から、使える所だけ取り出す（壊れていれば空） */
export function parseNxView(text: string | null | undefined): Partial<NxViewPrefs> {
  if (!text) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return {};
  }
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const out: Partial<NxViewPrefs> = {};
  if (typeof o.sort === 'string' && (SORTS as readonly string[]).includes(o.sort)) out.sort = o.sort as NxSort;
  if (o.box === null || typeof o.box === 'string') out.box = o.box;
  if (o.filter === null || (typeof o.filter === 'string' && (NX_FILTERS as readonly string[]).includes(o.filter))) out.filter = o.filter as NxFilter | null;
  if (o.sel === null || typeof o.sel === 'string') out.sel = o.sel;
  return out;
}

export function nxViewText(v: NxViewPrefs): string {
  return JSON.stringify({ sort: v.sort, box: v.box, filter: v.filter, sel: v.sel });
}

export function loadNxView(): Partial<NxViewPrefs> {
  try {
    return parseNxView(localStorage.getItem(NX_VIEW_KEY));
  } catch {
    return {};
  }
}

export function saveNxView(v: NxViewPrefs): void {
  try {
    localStorage.setItem(NX_VIEW_KEY, nxViewText(v));
  } catch {
    // 残せなくても、開いている間は覚えている
  }
}

// ---- ホームのカードの横の並び（棚） ---------------------------------------------------------------

/** 1 画面に並べる曲の数（タイルの幅は minTile より狭くしない。3〜8） */
export function shelfPerPage(width: number, gap: number, minTile = 150): number {
  if (!(width > 0)) return 6;
  return Math.max(3, Math.min(8, Math.floor((width + gap) / (minTile + gap))));
}

/**
 * 戻ってきたときに見せる先頭の曲の番号。前に見ていた所（first）に選んでいた曲（selIndex）が見えていればそのまま、
 * 見えていなければその曲のある頁に。前の所が曲の数をこえていたら最後の頁に
 */
export function shelfStart(count: number, per: number, first: number, selIndex: number): number {
  const last = Math.max(0, count - per);
  const f = Math.max(0, Math.min(last, Math.round(first)));
  if (selIndex < 0 || selIndex >= count) return f;
  if (selIndex >= f && selIndex < f + per) return f;
  return Math.min(last, Math.floor(selIndex / per) * per);
}
