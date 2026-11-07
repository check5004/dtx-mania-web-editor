// 難易度タブの並び。BASIC → ADVANCED → EXTREME → MASTER（NX の選曲と同じ、易しい順）。
// 難易度の名前でない譜面（DTXMANIA・作者独自の名前）はその後に、set.def の順・ファイル名の順で。
import { slotOf, slotRank } from './targets';

/**
 * 難易度の順に並べる。setDefOrder は set.def に載っている譜面のファイル名（小文字、L1〜L5 の順）。
 * ファイル名か set.def の名前から難易度が分かる譜面は難易度の順、分からない譜面はその後
 */
export function sortByDifficulty<T extends { file: string; label: string }>(list: readonly T[], setDefOrder: readonly string[] = []): T[] {
  const pos = new Map(setDefOrder.map((f, i) => [f.toLowerCase(), i]));
  const key = (x: T) => {
    const slot = slotOf(x.label, x.file);
    // slotRank は MASTER が 0。易しい順にするので逆にする（分からない名前は MASTER の後）
    return slot ? 3 - slotRank(slot) : 4;
  };
  return list
    .map((x, i) => ({ x, i, k: key(x), p: pos.get(x.file.toLowerCase()) ?? Infinity }))
    .sort((a, b) => a.k - b.k || a.p - b.p || a.x.file.localeCompare(b.x.file) || a.i - b.i)
    .map((e) => e.x);
}
