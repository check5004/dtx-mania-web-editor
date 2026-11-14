// 難易度ガイドラインの物差し（画面と保存は store/guideline.ts。ここはファイルも画面も触らない関数だけ。試験から呼ぶ）。
// - どの譜面を物差しに入れるか。エディタなので、このアプリで作った譜面・直している途中の譜面は入れない（楯さん 2026-11-14
//   「無視すべき曲・難易度データに注意（エディタなのでね）」）。入れないわけは画面に出し、手で戻せるものは戻せる
// - レベル帯ごとの要素の出現率・似た譜面からのレベル・登録レベルが外れていそうな譜面・代表譜面
// - DTXMania の成績（*.score.ini の達成率）からの、遊ぶレベルのめやす
import { FEATURE_DEFS, featureSummary, featureVector, type ChartFeatures, type FeatureKey } from '../gen/features';
import type { Rank, ScoreRec } from '../nxlib/parse';
import type { LibChart, LibSong, SlotKey } from '../nxlib/scan';

export interface ChartEntry {
  /** DTXMania の曲は「nx:曲の id|譜面」、取り込んだ曲は「フォルダ/譜面」（小文字） */
  id: string;
  /** nx = DTXMania の曲から（無ければ、曲のフォルダ・ZIP・音源ライブラリから取り込んだ譜面） */
  src?: 'nx';
  song: string;
  artist: string;
  /** 難易度の名前（set.def のラベル、なければファイル名） */
  label: string;
  file: string;
  folder: string;
  /** #DLEVEL（1.00〜9.99）。書いていなければ null */
  level: number | null;
  feat: ChartFeatures;
  /** 手で物差しから外した */
  excluded: boolean;
  addedAt: number;
  /** DTXMania の曲の id（一覧のその曲へ飛ぶ・成績を見る） */
  songId?: string;
  /** 一覧の枠（DTXMania の曲） */
  slot?: SlotKey | null;
  /** 譜面のファイルの大きさと更新時刻（DTXMania の曲。同じなら読み直さない） */
  sig?: string;
  /** AI難易度生成で作った譜面（#DTXE_ORIGIN） */
  ai?: boolean;
  /** このエディタで作った・直した譜面（作業ファイル「譜面の名前.dtxe.json」がある） */
  work?: boolean;
  /** 作業ファイルがあっても物差しに入れる（手で入れた） */
  include?: boolean;
  /** 取り込んだ曲の成績（DTXMania の曲は一覧の成績を見る） */
  score?: ScoreRec | null;
}

/** ノーツがこれより少ない譜面は数えない（ドラムがほとんど無い譜面） */
export const MIN_NOTES = 16;

/**
 * 物差しに入れないわけ。ai：AI難易度生成で作った・work：このエディタで作った／直した（作業ファイルがある）・
 * nolevel：レベルが書いていない・nodrums：ドラムの譜面でない（ノーツが少ない・.dtx でない）・dup：同じ曲がほかにもある・
 * box：外した BOX の曲・manual：手で外した
 */
export type SkipWhy = 'ai' | 'work' | 'nolevel' | 'nodrums' | 'dup' | 'box' | 'manual';
export const SKIP_WHYS: readonly SkipWhy[] = ['work', 'ai', 'nolevel', 'nodrums', 'dup', 'box', 'manual'];

export interface ChartFacts {
  ai: boolean;
  /** .dtx でドラムがある（点検でドラムが無いと分かった曲・.gda などは false） */
  drums: boolean;
  level: number | null;
  /** ノーツの数（まだ解析していなければ undefined） */
  notes?: number;
  work: boolean;
  include: boolean;
  excluded: boolean;
  dup: boolean;
  boxOff: boolean;
}

/** 物差しに入れないわけ（入れるなら null）。先に当たったわけを 1 つ */
export function skipOf(f: ChartFacts): SkipWhy | null {
  if (f.ai) return 'ai';
  if (!f.drums || (f.notes !== undefined && f.notes < MIN_NOTES)) return 'nodrums';
  if (f.level === null || !(f.level > 0)) return 'nolevel';
  if (f.dup) return 'dup';
  if (f.boxOff) return 'box';
  if (f.work && !f.include) return 'work';
  if (f.excluded) return 'manual';
  return null;
}

/** 解析した譜面だけで分かるわけ（DTXMania の曲の BOX・同じ曲は見ない） */
export function entrySkip(e: ChartEntry): SkipWhy | null {
  return skipOf({ ai: !!e.ai, drums: true, level: e.level, notes: e.feat?.notes ?? 0, work: !!e.work, include: !!e.include, excluded: e.excluded, dup: false, boxOff: false });
}

/** 物差しに使える譜面（譜面だけで分かるわけで外す） */
export function usableCharts(charts: readonly ChartEntry[]): ChartEntry[] {
  return charts.filter((c) => entrySkip(c) === null);
}

export const BANDS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const bandOf = (lv: number) => Math.max(1, Math.min(9, Math.floor(lv)));

const SLOT_NAME: Record<SlotKey, string> = { BSC: 'BASIC', ADV: 'ADVANCED', EXT: 'EXTREME', MAS: 'MASTER' };

/** 譜面の難易度の名前（set.def のラベル・一覧の枠・ファイル名の順） */
export function chartLabel(c: Pick<LibChart, 'label' | 'slot' | 'file'>): string {
  return c.label.trim() || (c.slot ? SLOT_NAME[c.slot] : '') || (c.file.split('/').pop() ?? c.file).replace(/\.[^.]+$/, '');
}

export function nxChartId(songId: string, file: string): string {
  return `nx:${songId}|${file.toLowerCase()}`;
}

export function chartSig(c: Pick<LibChart, 'size' | 'mtime'>): string {
  return `${c.size}:${c.mtime}`;
}

export function isDtxFile(file: string): boolean {
  return /\.dtx$/i.test(file);
}

const norm = (t: string) => t.normalize('NFKC').trim().toLowerCase();

/** 同じ曲（曲名とアーティストが同じ）の 2 つ目からの曲の id。残すのは、外した BOX に無い曲のうち id のいちばん小さい曲 */
export function duplicateSongs(songs: readonly LibSong[], boxOff: (s: LibSong) => boolean): Set<string> {
  const groups = new Map<string, LibSong[]>();
  for (const s of songs) {
    if (!s.title.trim()) continue;
    const k = `${norm(s.title)}\u0000${norm(s.artist)}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const out = new Set<string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const keep = sorted.find((s) => !boxOff(s)) ?? sorted[0];
    for (const s of sorted) if (s !== keep) out.add(s.id);
  }
  return out;
}

export interface Skipped {
  /** 解析した譜面の id か、DTXMania の曲の譜面の id */
  key: string;
  why: SkipWhy;
  song: string;
  label: string;
  level: number | null;
  songId?: string;
  slot?: SlotKey | null;
  /** 解析した譜面（入れる・外すを覚える所） */
  entry?: ChartEntry;
}

export interface Ruler {
  /** 物差しに使う譜面 */
  use: ChartEntry[];
  /** 物差しに入れていない譜面とわけ */
  skipped: Skipped[];
  /** DTXMania の曲で、まだ解析していない譜面の数 */
  pending: number;
  /** 物差しに使う曲の数 */
  songs: number;
  /** DTXMania の曲から作っている（覚えた一覧がある） */
  nx: boolean;
}

export interface RulerInput {
  entries: readonly ChartEntry[];
  /** DTXMania の曲（覚えていなければ undefined。そのときは取り込んだ譜面だけ） */
  songs?: readonly LibSong[];
  /** 外した BOX の鍵 */
  boxesOff?: ReadonlySet<string>;
}

/** DTXMania の曲の譜面の、解析の前から分かることと、解析した譜面の印 */
function nxFacts(s: LibSong, c: LibChart, e: ChartEntry | undefined, dup: boolean, boxOff: boolean): ChartFacts {
  return {
    ai: c.head.ai,
    drums: isDtxFile(c.file) && s.drums !== false,
    level: c.head.level,
    notes: e?.feat?.notes,
    // 前の版の一覧（譜面ごとの印が無い）は、曲に作業ファイルがあれば入れない
    work: c.work ?? (s.edited || !!e?.work),
    include: !!e?.include,
    excluded: !!e?.excluded,
    dup,
    boxOff,
  };
}

const dupKey = (e: ChartEntry) => `${norm(e.song)}|${e.level?.toFixed(2) ?? '?'}|${e.feat?.notes ?? 0}`;

/** 物差しを作る：使う譜面・入れない譜面とわけ・解析を待っている譜面の数 */
export function buildRuler(inp: RulerInput): Ruler {
  const use: ChartEntry[] = [];
  const skipped: Skipped[] = [];
  let pending = 0;
  const byId = new Map(inp.entries.map((e) => [e.id, e]));
  const boxesOff = inp.boxesOff ?? new Set<string>();
  const seen = new Set<string>();
  if (inp.songs) {
    const off = (s: LibSong) => s.box.some((b) => boxesOff.has(b));
    const dups = duplicateSongs(inp.songs, off);
    for (const s of inp.songs) {
      const boxOff = off(s);
      const dup = dups.has(s.id);
      for (const c of s.charts) {
        const id = nxChartId(s.id, c.file);
        const got = byId.get(id);
        // 譜面が変わっていたら、前の解析は使わない（手で入れた・外した印は使う）
        const e = got && got.sig === chartSig(c) ? got : undefined;
        const why = skipOf(nxFacts(s, c, e ?? got, dup, boxOff));
        const label = chartLabel(c);
        if (why) {
          skipped.push({ key: id, why, song: s.title, label, level: c.head.level, songId: s.id, slot: c.slot, entry: got });
          continue;
        }
        if (!e) {
          pending++;
          continue;
        }
        if (e.feat.notes < MIN_NOTES) {
          skipped.push({ key: id, why: 'nodrums', song: s.title, label, level: c.head.level, songId: s.id, slot: c.slot, entry: e });
          continue;
        }
        const u: ChartEntry = { ...e, song: s.title || e.song, artist: s.artist, label, level: c.head.level, slot: c.slot, songId: s.id };
        use.push(u);
        seen.add(dupKey(u));
      }
    }
    // 一覧から消えた譜面の解析は数えない（次の解析で消す）
    for (const e of inp.entries) if (e.src === 'nx') seen.add(dupKey(e));
  }
  for (const e of inp.entries) {
    if (e.src === 'nx') continue;
    const dup = seen.has(dupKey(e));
    const why = skipOf({ ai: !!e.ai, drums: true, level: e.level, notes: e.feat?.notes ?? 0, work: !!e.work, include: !!e.include, excluded: e.excluded, dup, boxOff: false });
    if (why) {
      skipped.push({ key: e.id, why, song: e.song, label: e.label, level: e.level, entry: e });
      continue;
    }
    seen.add(dupKey(e));
    use.push(e);
  }
  const songs = new Set(use.map((c) => c.songId ?? `${c.folder}/${c.song}`)).size;
  return { use, skipped, pending, songs, nx: !!inp.songs };
}

// ---- レベル帯ごとの集計 ------------------------------------------------------------------

export interface BandStats {
  band: number;
  count: number;
  rates: Record<FeatureKey, number>;
  density: number;
  maxChord: number;
  bpm: number;
  notes: number;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function bandStats(charts: readonly ChartEntry[]): BandStats[] {
  const use = usableCharts(charts);
  return BANDS.map((b) => {
    const cs = use.filter((c) => bandOf(c.level!) === b);
    const rates = Object.fromEntries(FEATURE_DEFS.map((d) => [d.key, cs.length ? cs.filter((c) => c.feat.has[d.key]).length / cs.length : 0])) as Record<FeatureKey, number>;
    return {
      band: b,
      count: cs.length,
      rates,
      density: median(cs.map((c) => c.feat.density)),
      maxChord: median(cs.map((c) => c.feat.maxChord)),
      bpm: median(cs.map((c) => c.feat.bpm)),
      notes: median(cs.map((c) => c.feat.notes)),
    };
  });
}

// ---- 似た譜面 ------------------------------------------------------------------------

const vecs = new WeakMap<ChartFeatures, Float64Array>();
function vecOf(f: ChartFeatures): Float64Array {
  let v = vecs.get(f);
  if (!v) {
    v = Float64Array.from(featureVector(f));
    vecs.set(f, v);
  }
  return v;
}

const NB = FEATURE_DEFS.length;
/** gen/features の featureDistance と同じ（数値の列を重く見る）。並びを作り直さない分だけ速い */
function dist(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += (i >= NB ? 3 : 1) * d * d;
  }
  return Math.sqrt(s);
}

/** 特徴の近い、レベルの分かっている譜面（自分の曲は除く） */
export function nearestCharts(feat: ChartFeatures, charts: readonly ChartEntry[], n = 5, exceptSong?: string): { c: ChartEntry; d: number }[] {
  const q = vecOf(feat);
  const out: { c: ChartEntry; d: number }[] = [];
  for (const c of usableCharts(charts)) {
    if (exceptSong && c.song === exceptSong) continue;
    const d = dist(q, vecOf(c.feat));
    if (out.length < n || d < out[out.length - 1].d) {
      out.push({ c, d });
      out.sort((a, b) => a.d - b.d);
      if (out.length > n) out.pop();
    }
  }
  return out;
}

function weighted(near: { c: ChartEntry; d: number }[]): number {
  let w = 0;
  let s = 0;
  for (const { c, d } of near) {
    const k = 1 / (0.05 + d);
    w += k;
    s += k * c.level!;
  }
  return Math.round((s / w) * 100) / 100;
}

/** 近い譜面のレベルから見積もる（距離で重み付け）。近い譜面が 3 つ無ければ null */
export function predictLevel(feat: ChartFeatures, charts: readonly ChartEntry[], exceptSong?: string): number | null {
  const near = nearestCharts(feat, charts, 5, exceptSong);
  if (near.length < 3) return null;
  return weighted(near);
}

export interface Outlier {
  c: ChartEntry;
  predicted: number;
}

/**
 * 登録されたレベルが、特徴の近い譜面（ほかの曲）から大きく外れている譜面。譜面が多くても重くならないよう、
 * 近い譜面は機械的な推定の近い譜面（±1.5）から探す（そこに 5 つ無ければ全部から）
 */
export function findOutliers(charts: readonly ChartEntry[], threshold = 1.2): Outlier[] {
  const use = usableCharts(charts);
  if (use.length < 6) return [];
  const sorted = [...use].sort((a, b) => a.feat.mech - b.feat.mech);
  const mechs = sorted.map((c) => c.feat.mech);
  const lower = (x: number) => {
    let lo = 0;
    let hi = mechs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (mechs[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const out: Outlier[] = [];
  for (const c of use) {
    const q = vecOf(c.feat);
    const pick = (from: number, to: number) => {
      const near: { c: ChartEntry; d: number }[] = [];
      for (let i = from; i < to; i++) {
        const x = sorted[i];
        if (x.song === c.song) continue;
        const d = dist(q, vecOf(x.feat));
        if (near.length < 5 || d < near[near.length - 1].d) {
          near.push({ c: x, d });
          near.sort((a, b) => a.d - b.d);
          if (near.length > 5) near.pop();
        }
      }
      return near;
    };
    let near = pick(lower(c.feat.mech - 1.5), lower(c.feat.mech + 1.5 + 1e-9));
    if (near.length < 5) near = pick(0, sorted.length);
    if (near.length < 3) continue;
    const p = weighted(near);
    if (Math.abs(p - c.level!) >= threshold) out.push({ c, predicted: p });
  }
  return out.sort((a, b) => Math.abs(b.predicted - b.c.level!) - Math.abs(a.predicted - a.c.level!));
}

/** レベル帯の代表：特徴の中央に近い譜面 */
export function representatives(charts: readonly ChartEntry[], band: number, n = 3): ChartEntry[] {
  const cs = usableCharts(charts).filter((c) => bandOf(c.level!) === band);
  if (cs.length <= n) return cs.sort((a, b) => a.level! - b.level!);
  const med = { density: median(cs.map((c) => c.feat.density)), mech: median(cs.map((c) => c.feat.mech)) };
  return cs
    .map((c) => ({ c, d: Math.abs(Math.log(1 + c.feat.density) - Math.log(1 + med.density)) + Math.abs(c.feat.mech - med.mech) / 3 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.c)
    .sort((a, b) => a.level! - b.level!);
}

// ---- 成績からの遊ぶレベル -----------------------------------------------------------------

/** DTXMania の S ランクの達成率（CScoreIni.tCalculateRank：SS 95・S 80・A 73・B 63・C 53・D 45） */
export const S_LINE = 80;

export interface PlayPoint {
  key: string;
  level: number;
  /** いちばん良い達成率（%） */
  skill: number;
  plays: number;
  rank: Rank | null;
  song: string;
  label: string;
  songId?: string;
  slot?: SlotKey | null;
}

/** 遊んだ譜面（物差しと同じ決まりで、AI で作った譜面・エディタで作った譜面などは入れない） */
export function playPoints(inp: RulerInput): PlayPoint[] {
  const out: PlayPoint[] = [];
  const byId = new Map(inp.entries.map((e) => [e.id, e]));
  const boxesOff = inp.boxesOff ?? new Set<string>();
  if (inp.songs) {
    const off = (s: LibSong) => s.box.some((b) => boxesOff.has(b));
    const dups = duplicateSongs(inp.songs, off);
    for (const s of inp.songs) {
      for (const c of s.charts) {
        const sc = c.score;
        if (!sc || sc.plays <= 0 || !sc.skill || c.head.level === null) continue;
        const id = nxChartId(s.id, c.file);
        const e = byId.get(id);
        if (skipOf(nxFacts(s, c, e, dups.has(s.id), off(s)))) continue;
        out.push({ key: id, level: c.head.level, skill: sc.skill, plays: sc.plays, rank: sc.rank, song: s.title, label: chartLabel(c), songId: s.id, slot: c.slot });
      }
    }
  }
  for (const e of inp.entries) {
    if (e.src === 'nx' || !e.score || e.score.plays <= 0 || !e.score.skill || entrySkip(e)) continue;
    out.push({ key: e.id, level: e.level!, skill: e.score.skill, plays: e.score.plays, rank: e.score.rank, song: e.song, label: e.label });
  }
  return out.sort((a, b) => a.level - b.level);
}

export interface PlayEstimate {
  /** 達成率が S（80%）に届くいちばん上のレベル（0.1 きざみ）。成績が少なければ null */
  level: number | null;
  /** 使った譜面の数 */
  n: number;
  /** ならした達成率（レベル → %）。近くに譜面の無い所は出さない */
  curve: { x: number; y: number }[];
  /** 遊んだ譜面のいちばん上のレベルが、めやすの近く（もっと上を遊ぶと変わる） */
  atTop: boolean;
}

const SIGMA = 0.45;

/**
 * 成績から遊ぶレベルのめやすを出す。レベルごとに近い譜面の達成率をならし（ガウスの重み、幅 0.45）、
 * ならした達成率が S（80%）以上で、近くに譜面が 1.5 つ分以上あるいちばん上のレベル
 */
export function estimatePlayLevel(points: readonly PlayPoint[], line = S_LINE): PlayEstimate {
  const curve: { x: number; y: number }[] = [];
  if (points.length < 3) return { level: null, n: points.length, curve, atTop: false };
  let best: number | null = null;
  for (let i = 100; i <= 999; i += 5) {
    const x = i / 100;
    let w = 0;
    let s = 0;
    for (const p of points) {
      const k = Math.exp(-0.5 * ((p.level - x) / SIGMA) ** 2);
      w += k;
      s += k * p.skill;
    }
    if (w < 0.6) continue;
    const y = s / w;
    curve.push({ x, y });
    if (y >= line && w >= 1.5) best = x;
  }
  const level = best === null ? null : Math.round(best * 10) / 10;
  const top = Math.max(...points.map((p) => p.level));
  return { level, n: points.length, curve, atTop: level !== null && top - level < 0.4 };
}

// ---- AI に渡す文（AI へのことばなので日本語のまま） i18n-ignore-start ------------------------

/** レベル帯の集計の 1 行（基準文が無くても、物差しの数字は AI に渡す） */
export function bandLine(b: BandStats): string {
  if (b.count === 0) return '';
  const rates = FEATURE_DEFS.map((d) => `${d.label} ${Math.round(b.rates[d.key] * 100)}%`).join('・');
  return `Lv${b.band}台（手元の ${b.count} 譜面）: ${rates} / 密度の中央値 ${b.density.toFixed(1)}打/秒・最大同時 ${Math.round(b.maxChord)}・BPM ${Math.round(b.bpm)}`;
}

export function chartLine(c: ChartEntry): string {
  return `${c.song} ${c.label}（登録 Lv${c.level?.toFixed(2) ?? '?'}）: ${featureSummary(c.feat)}`;
}
// i18n-ignore-end
