// 採譜の下書き：ドラムの採譜モデル（ADTOF）が原曲から聞き取った打点を、そのまま小節のチップにする。
//
// 採譜は5種（BD・SD・TT・HH・CY）しか出さないので、どのレーンで書くかは前後の小節の作者の書き方にそろえる:
//  - シンバル（CY）: 小節に4つ以上なら「刻み」（作者が刻みに使うレーン。ライドなど）、少なければ「単発」（クラッシュなど）。
//  - ハイハット（HH）: 16分の位置ごとに、作者がそこをクローズ・オープン・左ペダルのどれで書いているか。
//  - タム（TT）: 刻みで使うタムがあればそれ。フィルは時間の順に高い方から（ハイ→ロー→フロア）。
// 位置は拍ごとに、打点の時刻にいちばん合う細かさ（16分・8分3連・16分3連・32分）に吸着する。
import { classOfChannel, DRUM_CLASSES, type DrumClass } from '../bench/classes';
import { enforcePlayable, type PhraseNote } from '../ai/phrase';
import { beatsOfMeasure, cellPos, fitMeasureCells, locateInBeats } from '../ai/beatGrid';
import { toNum, ZERO } from '../dtx/fraction';
import { CH, drumChannel, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';

/** 原曲の打点（時刻は譜面の秒） */
export interface DraftHit {
  t: number;
  cls: DrumClass;
  s: number;
}

type Votes = Map<number, number>;

/** 前後の小節から読み取った、作者の書き方 */
export interface Style {
  /** 種類ごと：1小節に4つ以上使うチャンネル（刻み）の数 */
  pattern: Record<DrumClass, Votes>;
  /** 種類ごと：1小節に3つまでのチャンネル（単発）の数 */
  accent: Record<DrumClass, Votes>;
  /** ハイハットの種類：16分の位置 → チャンネル → 数 */
  hhAt: Map<number, Votes>;
  /** 見た小節の数（チップのある小節） */
  measures: number;
}

const DEFAULT_CH: Record<DrumClass, number> = { BD: CH.BD, SD: CH.SD, TT: CH.HT, HH: CH.HHC, CY: CH.CY };
const TOMS = [CH.HT, CH.LT, CH.FT];

function bump(v: Votes, ch: number, n = 1) {
  v.set(ch, (v.get(ch) ?? 0) + n);
}

function top(v: Votes | undefined): number | null {
  if (!v || v.size === 0) return null;
  let best: number | null = null;
  let bn = -1;
  for (const [ch, n] of v) if (n > bn) [best, bn] = [ch, n];
  return best;
}

/** 16分の位置（小節の頭から） */
function step16(tempo: TempoMap, m: number, f: { n: number; d: number }): number {
  return Math.round((f.n / f.d) * tempo.barLen(m) * 16);
}

/** 小節 from〜to の前後 span 小節の譜面から、作者の書き方を数える（範囲の中と、use が false の小節は見ない） */
export function learnStyle(doc: DtxDoc, tempo: TempoMap, from: number, to: number, span = 8, use: (m: number) => boolean = () => true): Style {
  const pattern = Object.fromEntries(DRUM_CLASSES.map((c) => [c, new Map()])) as Record<DrumClass, Votes>;
  const accent = Object.fromEntries(DRUM_CLASSES.map((c) => [c, new Map()])) as Record<DrumClass, Votes>;
  const hhAt = new Map<number, Votes>();
  // 小節 → チャンネル → 数
  const per = new Map<number, Map<number, number>>();
  for (const c of doc.chips) {
    if (c.m >= from && c.m <= to) continue;
    if (c.m < from - span || c.m > to + span || !use(c.m)) continue;
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    let mm = per.get(c.m);
    if (!mm) per.set(c.m, (mm = new Map()));
    mm.set(c.ch, (mm.get(c.ch) ?? 0) + 1);
    const cls = classOfChannel(c.ch);
    if (cls === 'HH') {
      const p = step16(tempo, c.m, c.f);
      let v = hhAt.get(p);
      if (!v) hhAt.set(p, (v = new Map()));
      bump(v, c.ch);
    }
  }
  for (const mm of per.values()) {
    for (const [ch, n] of mm) {
      const cls = classOfChannel(ch);
      if (!cls) continue;
      bump(n >= 4 ? pattern[cls] : accent[cls], ch, n);
    }
  }
  return { pattern, accent, hhAt, measures: per.size };
}

/** 種類と、その小節でのその種類の打点の数から、書くチャンネルを決める（タム・ハイハット以外） */
function channelFor(style: Style, cls: DrumClass, countInMeasure: number): number {
  if (cls === 'BD' || cls === 'SD') return DEFAULT_CH[cls];
  const pat = top(style.pattern[cls]);
  const acc = top(style.accent[cls]);
  if (countInMeasure >= 4) return pat ?? acc ?? DEFAULT_CH[cls];
  return acc ?? pat ?? DEFAULT_CH[cls];
}

/**
 * ハイハットの打点：その16分の位置で作者が手で叩くハイハット（クローズかオープンの多い方）。
 * そこを手で叩いていなくて左ペダルだけなら左ペダル。前後に無い位置は、刻みで多い方。
 */
function hhChannel(style: Style, pos: number): number {
  const v = style.hhAt.get(pos);
  if (v) {
    const c = v.get(CH.HHC) ?? 0;
    const o = v.get(CH.HHO) ?? 0;
    if (c + o > 0) return o > c ? CH.HHO : CH.HHC;
    if ((v.get(CH.LP) ?? 0) > 0) return CH.LP;
  }
  const p = style.pattern.HH;
  return (p.get(CH.HHO) ?? 0) > (p.get(CH.HHC) ?? 0) ? CH.HHO : CH.HHC;
}

/**
 * 原曲の打点から小節 from〜to のチップを作る。同時に叩けない組み合わせは直す（enforcePlayable）。
 * 位置は拍ごとに、打点の時刻にいちばん合う細かさ（16分・8分3連・16分3連・32分。ai/beatGrid の fitMeasureCells）に吸着する。
 * hits は時刻（譜面の秒）の順でなくてもよい。
 */
export function draftFromHits(hits: readonly DraftHit[], tempo: TempoMap, from: number, to: number, style: Style): PhraseNote[] {
  const notes: PhraseNote[] = [];
  // 前の小節の最後の拍で、次の小節の頭に寄った打点（範囲の1つ前の小節からも受け取る）
  let carry: DraftHit[] = [];
  for (let m = Math.max(0, from - 1); m <= to; m++) {
    const { beats, total } = beatsOfMeasure(tempo, m);
    const start = tempo.measureStart(m);
    const len = tempo.measureBeats(m);
    const spq = 60 / Math.max(1, tempo.bpmAt(start));
    // 拍ごとの打点（拍の頭からの位置、4分音符の数）
    const perBeat = beats.map(() => [] as { h: DraftHit; p: number }[]);
    for (const h of hits) {
      const q = tempo.secToBeat(h.t) - start;
      if (q < -0.5 || q >= len) continue;
      const at = locateInBeats(beats, q);
      if (at) perBeat[at.i].push({ h, p: at.p });
    }
    // 拍ごとに細かさを選んで吸着。種類ごと・位置ごとに1つ
    const by = new Map<DrumClass, { f: PhraseNote['f']; t: number }[]>();
    const seen = new Set<string>();
    const put = (h: DraftHit, f: PhraseNote['f']) => {
      const key = `${h.cls}|${f.n}/${f.d}`;
      if (seen.has(key)) return;
      seen.add(key);
      let arr = by.get(h.cls);
      if (!arr) by.set(h.cls, (arr = []));
      arr.push({ f, t: h.t });
    };
    for (const h of carry) put(h, ZERO);
    carry = [];
    const cells = fitMeasureCells(
      beats,
      perBeat.map((arr) => arr.map((x) => ({ p: x.p, s: x.h.s }))),
      spq,
    );
    perBeat.forEach((arr, i) => {
      if (arr.length === 0) return;
      const L = cells[i];
      const cell = toNum(beats[i].dur) / L;
      for (const { h, p } of arr) {
        let k = Math.max(0, Math.round(p / cell));
        let bi = i;
        let n = L;
        if (k >= L) {
          // 拍の終わりに寄った打点は次の拍の頭（小節の最後の拍なら次の小節の頭）
          if (i + 1 >= beats.length) {
            carry.push(h);
            continue;
          }
          bi = i + 1;
          k = 0;
          n = 1;
        }
        put(h, cellPos(beats, total, bi, k, n));
      }
    });
    if (m < from) continue;
    for (const [cls, arr] of by) {
      arr.sort((a, b) => a.t - b.t);
      if (cls === 'HH') {
        for (const x of arr) notes.push({ ch: hhChannel(style, step16(tempo, m, x.f)), m, f: x.f });
      } else if (cls === 'TT') {
        const pat = top(style.pattern.TT);
        const acc = top(style.accent.TT);
        arr.forEach((x, i) => {
          let ch: number;
          if (arr.length >= 4 && pat !== null) ch = pat;
          else if (arr.length >= 3) ch = TOMS[Math.min(2, Math.floor((i * 3) / arr.length))];
          else if (arr.length === 1 && acc !== null) ch = acc;
          else ch = TOMS[Math.min(2, i)];
          notes.push({ ch, m, f: x.f });
        });
      } else {
        const ch = channelFor(style, cls, arr.length);
        for (const x of arr) notes.push({ ch, m, f: x.f });
      }
    }
  }
  return enforcePlayable(notes);
}

// i18n-ignore-start AI に渡す文（プロンプトの中身。答えの言語は aiLangRule で決める）
const CH_LABEL: Record<number, string> = {
  [CH.LC]: 'LC（左シンバル）',
  [CH.HHC]: 'HH（クローズ）',
  [CH.HHO]: 'HO（オープン）',
  [CH.LP]: 'LP（左ペダル）',
  [CH.LBD]: 'LB（左バスドラム）',
  [CH.SD]: 'SD',
  [CH.HT]: 'HT（ハイタム）',
  [CH.BD]: 'BD',
  [CH.LT]: 'LT（ロータム）',
  [CH.FT]: 'FT（フロアタム）',
  [CH.CY]: 'CY（右シンバル）',
  [CH.RD]: 'RD（ライド）',
};

function share(v: Votes): string {
  const total = [...v.values()].reduce((a, b) => a + b, 0);
  return [...v]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ch, n]) => `${CH_LABEL[ch] ?? ch} ${Math.round((n / total) * 100)}%`)
    .join('・');
}

/** AI に渡す「作者の書き方」の要約（前後の小節から数えたもの） */
export function styleLines(style: Style): string[] {
  if (style.measures === 0) return [];
  const out: string[] = [];
  const both = (cls: DrumClass, label: string) => {
    const p = style.pattern[cls];
    const a = style.accent[cls];
    if (p.size) out.push(`${label}の刻み（1小節に4つ以上）: ${share(p)}`);
    if (a.size) out.push(`${label}の単発: ${share(a)}`);
  };
  both('CY', 'シンバル類');
  both('HH', 'ハイハット類');
  both('TT', 'タム');
  return out;
}
// i18n-ignore-end
