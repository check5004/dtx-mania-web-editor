// 検索と置換。条件に合うチップを譜面でハイライトし、まとめて移す・番号を替える・消す。
import { tr, pl } from '../i18n';
import { create } from 'zustand';
import { parseBase36x2, parseMeasure, toBase36x2 } from '../dtx/base36';
import { DRUM_LANES, drumChannel, laneVoice, SD_RIM, type ChipKind, type DtxDoc } from '../dtx/model';
import { chipAlt, chipVoice, rimWavs, rimWavsOf } from '../dtx/rim';
import { specialWavsOf } from '../dtx/kinds';
import { opSetKind } from '../edit/ops';
import { opMapLanes, opRelane, opReplaceWav, opSwapLanes, type AltMode } from '../edit/transform';
import { velOfWav, wavVariant } from '../edit/velocity';
import { laneAt, slotOf } from '../input/settings';
import { chipViews, tempoOf } from './derived';
import { edit, prepareSounds, setCursorBeat, setView, toast, useEditor, wavForVoice } from './editor';

export interface FindQuery {
  /** 探すレーン（空ならすべて） */
  lanes: number[];
  alt: 'any' | 'main' | 'alt';
  kinds: ChipKind[];
  /** WAV 番号（「0A 0B」のように空白・カンマ区切り。空なら問わない） */
  wavs: string;
  /** 小節の範囲（「000」「012」または 10 進の数。空なら端まで） */
  from: string;
  to: string;
}

export const emptyQuery = (): FindQuery => ({ lanes: [], alt: 'any', kinds: ['normal', 'hidden', 'nochip'], wavs: '', from: '', to: '' });

interface FindState {
  open: boolean;
  q: FindQuery;
  results: number[];
  index: number;
  /** 書き間違いの知らせ */
  error: string | null;
}

export const useFind = create<FindState>(() => ({ open: false, q: emptyQuery(), results: [], index: -1, error: null }));

/** 「012」「12」「A05」を小節番号にする */
export function parseMeasureInput(s: string): number | null {
  const t = s.trim().toUpperCase();
  if (!t) return null;
  if (/^[0-9A-Z][0-9]{2}$/.test(t)) return parseMeasure(t);
  if (/^\d+$/.test(t)) return Number(t);
  return NaN;
}

export function parseWavList(s: string): number[] | null {
  const parts = s
    .toUpperCase()
    .split(/[\s,、]+/)
    .filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9A-Z]{1,2}$/.test(p)) return null;
    const n = parseBase36x2(p.padStart(2, '0'));
    if (n <= 0) return null;
    out.push(n);
  }
  return out;
}

/** 条件に合うチップ（拍の順） */
export function findChips(doc: DtxDoc, q: FindQuery): { ids: number[]; error: string | null } {
  const wavs = parseWavList(q.wavs);
  if (wavs === null) return { ids: [], error: tr('WAV番号は 01〜ZZ を空白かカンマで区切って書いてください', 'Write WAV numbers 01–ZZ separated by spaces or commas') };
  const from = parseMeasureInput(q.from);
  const to = parseMeasureInput(q.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return { ids: [], error: tr('小節は 000〜Z99 か数で書いてください', 'Write measures as 000–Z99 or a plain number') };
  const lanes = new Set(q.lanes);
  const wavSet = new Set(wavs);
  const kinds = new Set(q.kinds);
  const ids: number[] = [];
  for (const v of chipViews(doc)) {
    const info = drumChannel(v.c.ch);
    if (!info) continue;
    if (lanes.size && !lanes.has(info.lane)) continue;
    // 2種目（HHオープン・左バスドラム・スネアのリム。リムは音で見分けた chipViews の alt）
    if (q.alt === 'main' && v.alt) continue;
    if (q.alt === 'alt' && !v.alt) continue;
    if (!kinds.has(info.kind)) continue;
    if (wavSet.size && !wavSet.has(v.c.v)) continue;
    if (from !== null && v.c.m < from) continue;
    if (to !== null && v.c.m > to) continue;
    ids.push(v.c.id);
  }
  return { ids, error: null };
}

function run() {
  const s = useFind.getState();
  if (!s.open) return;
  const { ids, error } = findChips(useEditor.getState().doc, s.q);
  useFind.setState({ results: ids, error, index: Math.min(s.index, ids.length - 1) });
}

let lastDoc: unknown = null;
useEditor.subscribe((s) => {
  if (s.doc === lastDoc) return;
  lastDoc = s.doc;
  run();
});

export function openFind() {
  useFind.setState({ open: true });
  run();
}

export function closeFind() {
  useFind.setState({ open: false, results: [], index: -1 });
}

export function setQuery(p: Partial<FindQuery>) {
  useFind.setState((s) => ({ q: { ...s.q, ...p }, index: -1 }));
  run();
}

/** 範囲を選んだチップの小節にする */
export function rangeFromSelection() {
  const s = useEditor.getState();
  const ids = new Set(s.selection);
  const ms = s.doc.chips.filter((c) => ids.has(c.id)).map((c) => c.m);
  if (!ms.length) return;
  const fm = (n: number) => String(n).padStart(3, '0');
  setQuery({ from: fm(Math.min(...ms)), to: fm(Math.max(...ms)) });
}

/** i 番目の結果へ移る（譜面をそこまで動かす） */
export function gotoResult(i: number) {
  const s = useFind.getState();
  if (!s.results.length) return;
  const n = ((i % s.results.length) + s.results.length) % s.results.length;
  const id = s.results[n];
  const doc = useEditor.getState().doc;
  const c = doc.chips.find((x) => x.id === id);
  if (!c) return;
  const beat = tempoOf(doc).beatOf(c.m, c.f);
  const px = useEditor.getState().view.pxPerBeat;
  setView({ scrollBeat: Math.max(-2, beat - 200 / px), follow: false });
  setCursorBeat(beat);
  useFind.setState({ index: n });
}

export function selectResults() {
  useEditor.setState({ selection: [...useFind.getState().results] });
}

function targets(): Set<number> {
  return new Set(useFind.getState().results);
}

const laneName = (l: number) => DRUM_LANES[l]?.name ?? '';

/**
 * 見つかったチップを lane に移す。resound なら音もそのレーンの音にする（ベロシティは保つ）。
 * スネアのリム⇔スネアは音で決まるので、resound でなくても音を替える
 */
export function relaneResults(lane: number, alt: AltMode, resound: boolean) {
  const ids = targets();
  if (!ids.size) return;
  let n = 0;
  const doc0 = useEditor.getState().doc;
  const rims0 = rimWavs(doc0);
  const wasAlt = new Map(doc0.chips.filter((c) => ids.has(c.id)).map((c) => [c.id, chipAlt(doc0, c, rims0)]));
  edit(tr(`${ids.size}個のチップを${laneName(lane)}へ移す`, `Move ${ids.size} ${pl(ids.size, 'chip')} to ${laneName(lane)}`), (d) => {
    n = opRelane(d, ids, lane, alt);
    const rims = rimWavsOf(d);
    const sp = specialWavsOf(d);
    for (const c of d.chips) {
      if (!ids.has(c.id)) continue;
      const info = drumChannel(c.ch);
      if (!info) continue;
      const voice = laneVoice(info.lane, alt === 'keep' ? (wasAlt.get(c.id) ?? false) : alt === 'alt');
      const now = chipVoice(d, c, rims, sp);
      if (!resound && (voice === now || (voice !== SD_RIM && now !== SD_RIM))) continue;
      const vel = velOfWav(d.fields, c.v);
      c.v = wavVariant(d, wavForVoice(d, voice), vel);
    }
  });
  if (resound || Object.keys(useEditor.getState().doc.fields).length !== Object.keys(doc0.fields).length) void prepareSounds();
  toast(tr(`${n}個のチップを${laneName(lane)}へ移しました`, `Moved ${n} ${pl(n, 'chip')} to ${laneName(lane)}`), 'ok');
}

export function replaceWavResults(no: number) {
  const ids = targets();
  if (!ids.size) return;
  let n = 0;
  edit(tr(`${ids.size}個のチップの音を WAV${toBase36x2(no)} にする`, `Set ${ids.size} ${pl(ids.size, 'chip')} to WAV${toBase36x2(no)}`), (d) => {
    n = opReplaceWav(d, ids, no);
  });
  void prepareSounds();
  toast(tr(`${n}個のチップの音を WAV${toBase36x2(no)} にしました`, `Set ${n} ${pl(n, 'chip')} to WAV${toBase36x2(no)}`), 'ok');
}

export function setKindResults(kind: ChipKind) {
  const ids = targets();
  if (!ids.size) return;
  const label =
    kind === 'normal'
      ? tr('見つかったチップを通常チップにする', 'Make found chips normal')
      : kind === 'hidden'
        ? tr('見つかったチップを不可視にする', 'Make found chips invisible')
        : tr('見つかったチップを音だけにする', 'Make found chips sound only');
  edit(label, (d) => opSetKind(d, ids, kind));
}

export function deleteResults() {
  const ids = targets();
  if (!ids.size) return;
  edit(
    tr(`見つかった${ids.size}個のチップを消す`, `Delete ${ids.size} found ${pl(ids.size, 'chip')}`),
    (d) => {
      for (let i = d.chips.length - 1; i >= 0; i--) if (ids.has(d.chips[i].id)) d.chips.splice(i, 1);
    },
    { replace: true },
  );
}

/** 小節の範囲（検索の範囲）で2つのレーンを入れ替える */
export function swapLanesInRange(a: number, b: number) {
  const q = useFind.getState().q;
  const from = parseMeasureInput(q.from) ?? 0;
  const to = parseMeasureInput(q.to) ?? 3599;
  if (Number.isNaN(from) || Number.isNaN(to)) return;
  let n = 0;
  edit(tr(`${laneName(a)}と${laneName(b)}を入れ替え`, `Swap ${laneName(a)} and ${laneName(b)}`), (d) => {
    n = opSwapLanes(d, a, b, from, to);
  });
  toast(tr(`${laneName(a)}と${laneName(b)}を入れ替えました（${n}個）`, `Swapped ${laneName(a)} and ${laneName(b)} (${n} ${pl(n, 'chip')})`), 'ok');
}

/** 選んだチップを左右反転（画面の並びで左右を逆にする） */
export function mirrorSelection() {
  const s = useEditor.getState();
  const ids = new Set(s.selection.length ? s.selection : useFind.getState().results);
  if (!ids.size) {
    toast(tr('左右反転するチップを選んでください', 'Select the chips to mirror'), 'info');
    return;
  }
  let n = 0;
  edit(tr('左右反転', 'Mirror'), (d) => {
    n = opMapLanes(d, ids, (l) => laneAt(9 - slotOf(l)) ?? null);
  });
  toast(
    tr(
      `${n}個のチップを左右反転しました（HHオープン・左バスドラムは、反転先に2種目が無ければ通常のチップになります）`,
      `Mirrored ${n} ${pl(n, 'chip')} (HH open and left bass drum chips become normal chips if the other lane has no second type)`,
    ),
    'ok',
    6000,
  );
}
