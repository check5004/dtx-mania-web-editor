// 曲の終わり。NX は最後のチップ（どのチャンネルでも）の次の小節線で演奏を終える
// （CDTX.cs「拍子_拍線の挿入」の nEndOfSong。小節長の ch02 もチップに数える）。
// 最後のチップより後まで曲を続けたいときは、終わりの1つ前の小節の頭に「小節線・拍線の表示（C2）」のチップを
// いまの表示のまま（出しているなら 01、消しているなら 02）置いて延ばす。見た目は何も変わらない。
// 読み込むときは、この印を取り除いて曲の終わり（DtxDoc.endMeasure）に戻す。
import { frac } from './fraction';
import { CH, drumChannel, type Chip, type DtxDoc } from './model';

/** NX はフィルインの終わり（ch53 の 02）を 32/384 小節あとに置く。小節をまたげば終わりも延びる */
function nxMeasure(c: Chip): number {
  if (c.ch === CH.FILLIN && c.v === 2 && Math.floor((384 * c.f.n) / c.f.d) + 32 >= 384) return c.m + 1;
  return c.m;
}

/** NX が演奏を終える小節（最後のチップの次の小節の頭）。チップが1つも無ければ 0 */
export function naturalEndMeasure(doc: Pick<DtxDoc, 'chips' | 'barLengths'>): number {
  let last = -1;
  for (const c of doc.chips) last = Math.max(last, nxMeasure(c));
  for (const k of Object.keys(doc.barLengths)) last = Math.max(last, Number(k));
  return last + 1;
}

/**
 * 曲の終わりの小節。決めてあればそれ、無ければ auto（原曲の鳴り終わりなど）、それも無ければ最後のチップの次の小節。
 * どれでも最後のチップより前にはしない（NX ではチップがあればそこまで続くので）
 */
export function endMeasureOf(doc: Pick<DtxDoc, 'chips' | 'barLengths' | 'endMeasure'>, auto: number | null = null): number {
  const natural = naturalEndMeasure(doc);
  return Math.max(natural, doc.endMeasure ?? auto ?? natural);
}

/** 小節線・拍線を出しているか（C2 の 01 で出す・02 で消す。初めは出している）。位置 before より前のチップで決まる */
export function lineDisplayBefore(chips: readonly Chip[], before: number): 1 | 2 {
  let at = -Infinity;
  let v: 1 | 2 = 1;
  for (const c of chips) {
    if (c.ch !== CH.LINE_DISPLAY || (c.v !== 1 && c.v !== 2)) continue;
    const p = c.m + c.f.n / c.f.d;
    if (p < before && p >= at) {
      at = p;
      v = c.v;
    }
  }
  return v;
}

/** 書き出すときに足す印。曲の終わりが最後のチップの次の小節より後のときだけ（それ以外は null） */
export function endMarker(doc: Pick<DtxDoc, 'chips' | 'barLengths' | 'endMeasure'>): Chip | null {
  const end = doc.endMeasure;
  if (end === undefined || end < 1 || end <= naturalEndMeasure(doc)) return null;
  const m = end - 1;
  return { id: -1, ch: CH.LINE_DISPLAY, m, f: frac(0), v: lineDisplayBefore(doc.chips, m) };
}

/**
 * 読み込んだ譜面の終わりを決める（parseDtx の最後に呼ぶ）。
 * - 書き出した印（最後の小節の頭に1つだけある、表示を変えない C2）があれば、取り除いてそこを終わりにする
 * - 無ければ、ドラムのある譜面は NX と同じ終わり（最後のチップの次の小節）に決める（保存しても終わりが変わらないように）
 * - ドラムの無い譜面（作りかけ）は決めない（原曲の鳴り終わりに合わせる）
 */
export function takeEndMarker(doc: DtxDoc): void {
  const natural = naturalEndMeasure(doc);
  if (natural <= 0) return;
  const last = natural - 1;
  const tail = doc.chips.filter((c) => c.m >= last);
  const lenAtEnd = Object.keys(doc.barLengths).some((k) => Number(k) >= last);
  if (tail.length === 1 && !lenAtEnd) {
    const c = tail[0];
    const rest = doc.chips.filter((x) => x !== c);
    if (c.ch === CH.LINE_DISPLAY && c.f.n === 0 && c.v === lineDisplayBefore(rest, last)) {
      doc.chips = rest;
      doc.endMeasure = natural;
      return;
    }
  }
  if (doc.chips.some((c) => drumChannel(c.ch))) doc.endMeasure = natural;
}

const posOf = (c: Chip) => c.m + c.f.n / c.f.d;

/** 小節線・拍線の表示（C2）を除いた、最後のチップ（小節長も入れる）の次の小節。終わりはこれより前にできない */
export function solidEndMeasure(doc: Pick<DtxDoc, 'chips' | 'barLengths'>): number {
  return naturalEndMeasure({ chips: doc.chips.filter((c) => c.ch !== CH.LINE_DISPLAY), barLengths: doc.barLengths });
}

/**
 * 曲の終わりを from 小節から to 小節へ動かす（d を書き換える。endMeasure は呼ぶ側で決める）。
 * - 終わりの飾り（最後の小節で、ほかのどのチップより後にある C2。最後の小節線を消すのによく使われる）は、新しい最後の小節へ一緒に動かす
 * - 新しい終わりより後に残る C2 は消す（曲の外の小節線の表示なので意味が無い）
 * to は solidEndMeasure より前にしないこと
 */
export function moveEndDecorations(d: DtxDoc, from: number, to: number): void {
  if (from === to || from < 1 || to < 1) return;
  let lastSolid = -Infinity;
  for (const c of d.chips) if (c.ch !== CH.LINE_DISPLAY) lastSolid = Math.max(lastSolid, posOf(c));
  for (const k of Object.keys(d.barLengths)) lastSolid = Math.max(lastSolid, Number(k));
  const deco = new Set(d.chips.filter((c) => c.ch === CH.LINE_DISPLAY && c.m === from - 1 && posOf(c) > lastSolid).map((c) => c.id));
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (c.ch === CH.LINE_DISPLAY && !deco.has(c.id) && c.m >= to) d.chips.splice(i, 1);
  }
  const seen = new Set<string>();
  // 同じ位置に重なったら後のものを残す
  for (let i = d.chips.length - 1; i >= 0; i--) {
    const c = d.chips[i];
    if (!deco.has(c.id)) continue;
    const key = `${c.f.n}/${c.f.d}`;
    if (seen.has(key)) {
      d.chips.splice(i, 1);
      continue;
    }
    seen.add(key);
    c.m = to - 1;
  }
}
