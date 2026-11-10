// 生成した小節（AI・採譜の下書き・写した小節の案）を、いまの譜面にどう入れるか（マージ）を決める。
//
// - 足す（add）: いまのチップはすべて残し、案にあって譜面に無いチップだけを足す。
// - 置き換え（replace）: 案にないチップは消し、案のチップを入れる。
// どちらも「案を使うレーン」だけが対象で、使わないレーンはいまのまま。チップごとに、案のチップを外す（rejected）・
// 置き換えでも残す（kept）を選べる。最後に、同時に叩けない組み合わせ（手が3本・左足が2つ）になる所では、
// 足すチップの方を落とす（作者が置いたチップを優先する）。
import type { Draft } from 'immer';
import { toBase36x2 } from '../dtx/base36';
import type { Frac } from '../dtx/fraction';
import { CH, drumChannel, SD_RIM, type Chip, type DtxDoc } from '../dtx/model';

export type MergeMode = 'add' | 'replace';

/** 案のチップ（v は写した元の WAV 番号。無ければレーンの音を使う。rim はスネアのリム（チャンネルはスネア）） */
export interface ProposedNote {
  ch: number;
  m: number;
  f: Frac;
  v?: number;
  rim?: boolean;
}

export interface MergeOptions {
  mode: MergeMode;
  /** 案を使わないレーン（いまのまま残す） */
  offLanes: ReadonlySet<number>;
  /** 外した案のチップ（noteId） */
  rejected: ReadonlySet<string>;
  /** 置き換えでも残すチップ（id） */
  kept: ReadonlySet<number>;
  /** 譜面のリムの音の WAV 番号（スネアのチップとリムのチップを見分ける。省くと見分けない） */
  rims?: ReadonlySet<number>;
}

const NO_RIMS: ReadonlySet<number> = new Set();

/** 譜面のチップがスネアのリムか */
const chipRim = (c: Chip, rims: ReadonlySet<number>) => drumChannel(c.ch)?.base === CH.SD && rims.has(c.v);

/** 案のチップがスネアのリムか（rim の印か、写した元の音がリム） */
export const noteRim = (n: ProposedNote, rims: ReadonlySet<number> = NO_RIMS) =>
  drumChannel(n.ch)?.base === CH.SD && (n.rim === true || (n.v !== undefined && rims.has(n.v)));

export type SkipReason = 'rejected' | 'lane' | 'conflict' | 'playable';

export interface MergePlan {
  /** 足すチップ */
  add: ProposedNote[];
  /** 消すチップ（id） */
  remove: number[];
  /** 案と同じで、そのまま残るチップ（id） */
  same: number[];
  /** 案に無いが残るチップ（id） */
  keep: number[];
  /** 入らない案のチップ */
  skipped: { note: ProposedNote; why: SkipReason }[];
}

/** 案のチップを見分ける名前（外す・戻すのに使う） */
export const noteId = (n: { ch: number; m: number; f: Frac }) => `${n.m}|${n.ch}|${n.f.n}/${n.f.d}`;

/** 同じ場所を取り合うか（同じレーン・同じ種類・同じ位置。HHクローズとオープンは同じ場所） */
function slotOf(ch: number, m: number, f: Frac): string | null {
  const d = drumChannel(ch);
  if (!d) return null;
  return `${m}|${d.lane}|${d.kind}|${f.n}/${f.d}`;
}

/** 手・左足・右足のどれで叩くか */
export function limbOf(ch: number): 'hand' | 'left' | 'right' | null {
  const d = drumChannel(ch);
  if (!d) return null;
  if (d.base === CH.BD) return 'right';
  if (d.base === CH.LP || d.base === CH.LBD) return 'left';
  return 'hand';
}

/** 叩けない組み合わせのとき、先に落とすチップ（後ろほど先に落とす） */
const KEEP_ORDER: number[] = [CH.CY, CH.LC, CH.SD, CH.BD, CH.HT, CH.LT, CH.FT, CH.HHO, CH.HHC, CH.RD, CH.LBD, CH.LP];
const keepRank = (ch: number) => {
  const i = KEEP_ORDER.indexOf(drumChannel(ch)?.base ?? ch);
  return i < 0 ? KEEP_ORDER.length : i;
};

/** 小節の範囲（from〜to）の、ドラムの通常チップ */
export function drumChipsIn(doc: DtxDoc, from: number, to: number): Chip[] {
  return doc.chips.filter((c) => c.m >= from && c.m <= to && drumChannel(c.ch)?.kind === 'normal');
}

/**
 * マージの計画を立てる。existing は範囲のドラムの通常チップ（drumChipsIn）、proposal は案のチップ。
 * 不可視・音だけのチップは対象にしない（いつも残す）。
 */
export function planMerge(existing: readonly Chip[], proposal: readonly ProposedNote[], o: MergeOptions): MergePlan {
  const rims = o.rims ?? NO_RIMS;
  const bySlot = new Map<string, Chip>();
  for (const c of existing) {
    const k = slotOf(c.ch, c.m, c.f);
    if (k) bySlot.set(k, c);
  }
  const add: ProposedNote[] = [];
  const remove = new Set<number>();
  const same = new Set<number>();
  const skipped: MergePlan['skipped'] = [];
  const taken = new Set<string>();
  for (const n of proposal) {
    const d = drumChannel(n.ch);
    if (!d || d.kind !== 'normal') continue;
    const k = slotOf(n.ch, n.m, n.f)!;
    // 案の中の重なり（HHクローズとオープンが同じ位置など）は最初の1つ
    if (taken.has(k)) continue;
    taken.add(k);
    const ex = bySlot.get(k);
    if (ex && ex.ch === n.ch && chipRim(ex, rims) === noteRim(n, rims)) {
      same.add(ex.id);
      continue;
    }
    if (o.offLanes.has(d.lane)) {
      skipped.push({ note: n, why: 'lane' });
      continue;
    }
    if (o.rejected.has(noteId(n))) {
      skipped.push({ note: n, why: 'rejected' });
      continue;
    }
    if (ex) {
      // 同じ場所に違う音（HHクローズ⇔オープン、左ペダル⇔左バスドラム、スネア⇔リム）
      if (o.mode === 'add' || o.kept.has(ex.id)) {
        skipped.push({ note: n, why: 'conflict' });
        continue;
      }
      remove.add(ex.id);
    }
    add.push(n);
  }
  const keep: number[] = [];
  for (const c of existing) {
    if (same.has(c.id) || remove.has(c.id)) continue;
    const lane = drumChannel(c.ch)!.lane;
    if (o.mode === 'replace' && !o.offLanes.has(lane) && !o.kept.has(c.id)) remove.add(c.id);
    else keep.push(c.id);
  }
  // 叩けない組み合わせになる所では、足すチップを落とす
  const byPos = new Map<string, { ch: number; added: ProposedNote | null }[]>();
  const at = (m: number, f: Frac) => {
    const k = `${m}|${f.n}/${f.d}`;
    let a = byPos.get(k);
    if (!a) byPos.set(k, (a = []));
    return a;
  };
  for (const c of existing) if (!remove.has(c.id)) at(c.m, c.f).push({ ch: c.ch, added: null });
  for (const n of add) at(n.m, n.f).push({ ch: n.ch, added: n });
  const drop = new Set<ProposedNote>();
  for (const items of byPos.values()) {
    if (!items.some((x) => x.added)) continue;
    const count = (limb: string) => items.filter((x) => !drop.has(x.added!) && limbOf(x.ch) === limb).length;
    const limit: Record<string, number> = { hand: 2, left: 1, right: 1 };
    for (const limb of ['hand', 'left', 'right'] as const) {
      // 足したチップを、落とす順に
      const cand = items.filter((x) => x.added && limbOf(x.ch) === limb).sort((a, b) => keepRank(b.ch) - keepRank(a.ch));
      for (const x of cand) {
        if (count(limb) <= limit[limb]) break;
        drop.add(x.added!);
      }
    }
  }
  const kept = add.filter((n) => !drop.has(n));
  for (const n of add) if (drop.has(n)) skipped.push({ note: n, why: 'playable' });
  return { add: kept, remove: [...remove], same: [...same], keep, skipped };
}

/** 計画どおりに譜面を書き換える。wavFor は案に音が無いときの音（voice はチャンネル、リムは SD_RIM） */
export function applyMerge(d: Draft<DtxDoc>, plan: MergePlan, wavFor: (d: Draft<DtxDoc>, voice: number) => number) {
  if (plan.remove.length) {
    const rm = new Set(plan.remove);
    for (let i = d.chips.length - 1; i >= 0; i--) if (rm.has(d.chips[i].id)) d.chips.splice(i, 1);
  }
  for (const n of plan.add) {
    const voice = noteRim(n) ? SD_RIM : (drumChannel(n.ch)?.base ?? n.ch);
    const v = n.v !== undefined && n.v > 0 && d.fields['WAV' + toBase36x2(n.v)] !== undefined ? n.v : wavFor(d, voice);
    d.chips.push({ id: d.nextId++, ch: n.ch, m: n.m, f: { n: n.f.n, d: n.f.d }, v });
  }
}

/** 計画の数（札に出す） */
export function planCounts(plan: MergePlan): { add: number; remove: number; same: number; keep: number; dropped: number } {
  return {
    add: plan.add.length,
    remove: plan.remove.length,
    same: plan.same.length,
    keep: plan.keep.length,
    dropped: plan.skipped.filter((s) => s.why === 'playable' || s.why === 'conflict').length,
  };
}

/** 案と譜面でチップが違うレーン（レーンごとの切り替えに出す。スネアとリムは違うチップ） */
export function lanesWithChanges(existing: readonly Chip[], proposal: readonly ProposedNote[], rims: ReadonlySet<number> = NO_RIMS): number[] {
  const lanes = new Set<number>();
  const key = (m: number, ch: number, f: Frac, rim: boolean) => `${m}|${ch}${rim ? 'r' : ''}|${f.n}/${f.d}`;
  const ex = new Set(existing.map((c) => key(c.m, c.ch, c.f, chipRim(c, rims))));
  const pr = new Set<string>();
  for (const n of proposal) {
    const d = drumChannel(n.ch);
    if (!d || d.kind !== 'normal') continue;
    const k = key(n.m, n.ch, n.f, noteRim(n, rims));
    pr.add(k);
    if (!ex.has(k)) lanes.add(d.lane);
  }
  for (const c of existing) if (!pr.has(key(c.m, c.ch, c.f, chipRim(c, rims)))) lanes.add(drumChannel(c.ch)!.lane);
  return [...lanes].sort((a, b) => a - b);
}
