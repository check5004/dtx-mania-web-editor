// フレーズ候補：選んだ範囲に入れるフィルやリズムの候補を3つ作る。
// AI には小節ごとの「レーン × 拍ごとの格子」の文字で渡し、同じ形で返してもらう（拍がずれない）。
// 格子は拍ごとに細かさを変えられる（16分・3連・32分。ai/beatGrid）。小節の生成（ai/measureGen）も同じ形を使う。
// キーが無いときは、原曲の打点が似た小節・直前の小節から候補を作る。
import { tr, aiLangRule, aiTextLimit } from '../i18n';
import { beatsLabel, beatsOfMeasure, baseCells, combineCells, exactCells, fitMeasureCells, locateInBeats, parseSteps, type BeatSlot } from './beatGrid';
import { cmp, div, frac, mul, sub, toNum, type Frac } from '../dtx/fraction';
import { CH, drumChannel, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';

/** 格子で使うレーンの名前とチャンネル */
export const GRID_LANES: { code: string; ch: number; hand: boolean; foot?: 'L' | 'R' }[] = [
  { code: 'LC', ch: CH.LC, hand: true },
  { code: 'HH', ch: CH.HHC, hand: true },
  { code: 'HO', ch: CH.HHO, hand: true },
  { code: 'LP', ch: CH.LP, hand: false, foot: 'L' },
  { code: 'LB', ch: CH.LBD, hand: false, foot: 'L' },
  { code: 'SD', ch: CH.SD, hand: true },
  { code: 'HT', ch: CH.HT, hand: true },
  { code: 'BD', ch: CH.BD, hand: false, foot: 'R' },
  { code: 'LT', ch: CH.LT, hand: true },
  { code: 'FT', ch: CH.FT, hand: true },
  { code: 'CY', ch: CH.CY, hand: true },
  { code: 'RD', ch: CH.RD, hand: true },
];

const CODE_OF = new Map(GRID_LANES.map((l) => [l.ch, l.code]));
const LANE_OF = new Map(GRID_LANES.map((l) => [l.code, l]));

export interface PhraseNote {
  ch: number;
  m: number;
  f: Frac;
}

export interface PhraseCandidate {
  name: string;
  reason: string;
  source: 'ai' | 'similar' | 'prev';
  notes: PhraseNote[];
}

/** 小節の16分の数（4/4 なら16、3/4 なら12） */
export function stepsOf(tempo: TempoMap, m: number): number {
  return Math.max(4, Math.round(tempo.barLen(m) * 16));
}

/**
 * 原曲の打点。3帯域（low・mid・high、原曲の解析）か、ドラムの採譜モデルの5種（BD・SD・TT・HH・CY）。
 * どちらも、時刻（秒、原曲の頭が 0）の順に強さ・確からしさ（0〜1）を持つ。
 */
export type OnsetRows = Readonly<Record<string, readonly { t: number; s: number }[]>>;

// AI に渡す格子の行の名前（プロンプトの一部なので日本語のまま） i18n-ignore
const ONSET_LABEL: Record<string, string> = { low: '低', mid: '中', high: '高' };

/** 採譜モデルの5種か（でなければ3帯域） */
export function isDrumRows(onsets: OnsetRows): boolean {
  return 'BD' in onsets;
}

/** 小節の拍ごとの格子の形：拍の並びと、拍ごとの文字数 */
export interface MeasureLayout {
  beats: BeatSlot[];
  /** 小節の長さ（4分音符の数） */
  total: Frac;
  /** 拍ごとの文字数（4=16分、3=8分3連、6=16分3連、8=32分 …） */
  cells: number[];
  /** 格子に乗らないチップ（5連など）を近い所に丸めたか */
  rounded: boolean;
}

/** 小節の譜面のドラムのチップ（格子で書くもの） */
function gridChips(doc: DtxDoc | null, m: number): { code: string; f: Frac }[] {
  const out: { code: string; f: Frac }[] = [];
  for (const c of doc?.chips ?? []) {
    if (c.m !== m) continue;
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    const code = CODE_OF.get(c.ch);
    if (code) out.push({ code, f: c.f });
  }
  return out;
}

/** チップの位置（小節の中 0〜1）を、拍と拍の頭からの位置（4分音符の数）にする */
function chipBeat(beats: readonly BeatSlot[], total: Frac, f: Frac): { i: number; p: Frac } {
  const q = mul(f, total);
  let i = 0;
  while (i + 1 < beats.length && cmp(beats[i + 1].start, q) <= 0) i++;
  return { i, p: sub(q, beats[i].start) };
}

/** 4分音符1つの秒数（小節の頭のBPM） */
function secPerQuarter(tempo: TempoMap, m: number): number {
  return 60 / Math.max(1, tempo.bpmAt(tempo.measureStart(m)));
}

/** 打点を小節の拍に振り分ける（拍ごとに、拍の頭からの位置と強さ） */
function onsetsByBeat(onsets: OnsetRows, tempo: TempoMap, m: number, offsetSec: number, beats: readonly BeatSlot[]): { row: string; p: number; s: number }[][] {
  const start = tempo.measureStart(m);
  const len = tempo.measureBeats(m);
  const out = beats.map(() => [] as { row: string; p: number; s: number }[]);
  for (const row of Object.keys(onsets)) {
    for (const o of onsets[row]) {
      const q = tempo.secToBeat(o.t + offsetSec) - start;
      if (q < -0.5 || q >= len) continue;
      const at = locateInBeats(beats, q);
      if (at) out[at.i].push({ row, p: at.p, s: o.s });
    }
  }
  return out;
}

/**
 * 小節の拍ごとの格子の形を決める。チップのある拍は、チップがちょうど乗るいちばん粗い細かさ。
 * fit（生成する小節）か、チップの無い拍は、原曲の打点（採譜モデルの5種のとき）にいちばん合う細かさも合わせる（3連を聞き分ける）
 */
export function measureLayout(doc: DtxDoc | null, tempo: TempoMap, m: number, o: { onsets?: OnsetRows | null; offsetSec?: number; fit?: boolean } = {}): MeasureLayout {
  const { beats, total } = beatsOfMeasure(tempo, m);
  const chips = gridChips(doc, m);
  const at = chips.map((c) => chipBeat(beats, total, c.f));
  const heard = o.onsets && isDrumRows(o.onsets) ? onsetsByBeat(o.onsets, tempo, m, o.offsetSec ?? 0, beats) : null;
  const spq = secPerQuarter(tempo, m);
  const fitted = heard ? fitMeasureCells(beats, heard, spq) : null;
  let rounded = false;
  const cells = beats.map((b, i) => {
    const pos = at.filter((a) => a.i === i).map((a) => a.p);
    let chipCells: number | null = null;
    if (pos.length) {
      chipCells = exactCells(b.dur, pos);
      if (chipCells === null) {
        rounded = true;
        chipCells = Math.max(1, Math.round(toNum(b.dur) * 24));
      }
    }
    const fit = fitted && (o.fit || chipCells === null) ? fitted[i] : null;
    if (chipCells === null) return fit ?? baseCells(b.dur);
    return fit === null ? chipCells : combineCells(b.dur, chipCells, fit);
  });
  return { beats, total, cells, rounded };
}

/** 拍 i の中の位置 p（4分音符の数）を、その拍の何文字目かにする（四捨五入。拍の終わりに寄ったら次の拍の頭） */
function cellOf(layout: MeasureLayout, i: number, p: number): { i: number; k: number } | null {
  const L = layout.cells[i];
  const k = Math.round((p / toNum(layout.beats[i].dur)) * L);
  if (k < L) return { i, k: Math.max(0, k) };
  return i + 1 < layout.beats.length ? { i: i + 1, k: 0 } : null;
}

/** 行を「x-x-|xxx|…」の文字にする */
function joinRow(cells: (string | number)[][]): string {
  return cells.map((c) => c.join('')).join('|');
}

/** 小節のドラムを「レーン: x-x-|x-x-|…」の行にする（拍ごとの格子。layout を省くとチップから決める） */
export function measureGrid(doc: DtxDoc, tempo: TempoMap, m: number, layout: MeasureLayout = measureLayout(doc, tempo, m)): { lines: string[]; rounded: boolean } {
  const rows = new Map<string, string[][]>();
  let rounded = layout.rounded;
  for (const c of gridChips(doc, m)) {
    const { i, p } = chipBeat(layout.beats, layout.total, c.f);
    const L = layout.cells[i];
    const x = toNum(div(mul(p, frac(L)), layout.beats[i].dur));
    if (Math.abs(x - Math.round(x)) > 1e-9) rounded = true;
    const at = cellOf(layout, i, toNum(p));
    if (!at) continue;
    let r = rows.get(c.code);
    if (!r) rows.set(c.code, (r = layout.cells.map((n) => Array(n).fill('-'))));
    r[at.i][at.k] = 'x';
  }
  const lines = GRID_LANES.filter((l) => rows.has(l.code)).map((l) => `${l.code}: ${joinRow(rows.get(l.code)!)}`);
  return { lines, rounded };
}

/** 原曲の打点を、拍ごとの格子の強さ（0〜9）の文字列にする（layout を省くと打点から決める） */
export function onsetGrid(onsets: OnsetRows, tempo: TempoMap, m: number, offsetSec: number, layout?: MeasureLayout): string[] {
  const lay = layout ?? measureLayout(null, tempo, m, { onsets, offsetSec, fit: true });
  const byBeat = onsetsByBeat(onsets, tempo, m, offsetSec, lay.beats);
  const out: string[] = [];
  for (const row of Object.keys(onsets)) {
    const cells = lay.cells.map((n) => Array(n).fill(0) as number[]);
    byBeat.forEach((arr, i) => {
      for (const o of arr) {
        if (o.row !== row) continue;
        const at = cellOf(lay, i, o.p);
        if (!at) continue;
        cells[at.i][at.k] = Math.max(cells[at.i][at.k], Math.min(9, Math.round(o.s * 9)));
      }
    });
    out.push(`${ONSET_LABEL[row] ?? row}: ${joinRow(cells)}`);
  }
  return out;
}

// ---- AI へのプロンプト（指示は日本語のまま。答えのユーザーが読む文は aiLangRule で画面の言語にする） i18n-ignore-start

/** AI に格子の読み書きを説明する文（フレーズ候補・小節の生成で共通） */
export const GRID_HELP = [
  '譜面は小節ごとに「レーン: 格子」で表します。格子は | で拍（4分音符）を区切り、1拍の文字数でその拍の細かさを表します（4=16分、2=8分、3=8分3連、6=16分3連、8=32分、12=16分と8分3連が混ざる拍）。x は打つ、- は休み。',
  '答えも同じ形で、拍ごとに | で区切って書いてください。拍ごとに細かさを変えてかまいません（3連の所は3か6、細かい連打は8）。',
];

/** 原曲の打点の説明（採譜モデルの5種・3帯域） */
export function onsetHelp(kind: 'drums' | 'bands'): string {
  return kind === 'drums'
    ? '原曲の打点は、ドラムの採譜モデルが原曲から聞き取った BD=バスドラム SD=スネア TT=タム（高さは区別しない） HH=ハイハット CY=シンバル・ライド（区別しない） ごとの確からしさ（0〜9）で、譜面と同じ拍ごとの格子に並んでいます。拍の細かさは、譜面のチップと原曲の打点の時刻に合うもの（3連・32分を含む）にしてあります。0 でない所はその音が鳴っている見込みが高い所です。小さな音（ゴーストノート・ペダルのハイハット）は取りこぼすことがあり、まれに関係ない音を拾います。'
    : '原曲の打点は「低・中・高」の帯域ごとの強さ（0〜9）で、譜面と同じ拍ごとの格子に並んでいます。低はキック、中はスネアやタム、高はシンバルやハイハットの目安です（ほかの楽器の音も混ざります）。';
}

/** 格子に乗らないチップを丸めたときの注意 */
export const ROUNDED_NOTE = '（5連など、格子に乗らないチップは近い所に丸めて表しています）';

/** 格子の行の説明（JSON の steps） */
export const STEPS_HELP = 'x=打つ, -=休み。拍（4分音符）ごとに | で区切り、1拍の文字数で細かさを決める（4=16分、3=8分3連、6=16分3連、8=32分）。例: x-x-|x-x-|xxx|xxxxxx';

// i18n-ignore-end

export interface PhraseContext {
  kind: 'fill' | 'rhythm';
  from: number;
  to: number;
  bpm: number;
  targetLevel: number | null;
  instruction: string;
  /** 範囲と前後4小節の格子（beats は小節の長さの書き方「4拍」など） */
  measures: { m: number; inRange: boolean; beats: string; grid: string[]; onsets: string[] | null }[];
  rounded: boolean;
  /** 原曲の打点の種類（採譜モデルの5種か、3帯域か） */
  onsetKind?: 'drums' | 'bands';
}

export function buildContext(doc: DtxDoc, tempo: TempoMap, o: { kind: 'fill' | 'rhythm'; from: number; to: number; instruction: string; targetLevel: number | null; onsets: OnsetRows | null; offsetSec: number }): PhraseContext {
  const measures: PhraseContext['measures'] = [];
  let rounded = false;
  for (let m = Math.max(0, o.from - 4); m <= o.to + 4; m++) {
    const inRange = m >= o.from && m <= o.to;
    const layout = measureLayout(doc, tempo, m, { onsets: o.onsets, offsetSec: o.offsetSec, fit: inRange });
    const g = measureGrid(doc, tempo, m, layout);
    rounded ||= g.rounded;
    measures.push({ m, inRange, beats: beatsLabel(layout.beats), grid: g.lines, onsets: o.onsets ? onsetGrid(o.onsets, tempo, m, o.offsetSec, layout) : null });
  }
  return {
    kind: o.kind,
    from: o.from,
    to: o.to,
    bpm: Math.round(tempo.bpmAt(tempo.measureStart(o.from))),
    targetLevel: o.targetLevel,
    instruction: o.instruction,
    measures,
    rounded,
    onsetKind: o.onsets ? (isDrumRows(o.onsets) ? 'drums' : 'bands') : undefined,
  };
}

/** フレーズ候補の答えの形（名前・理由の言語と字数は画面の言語に合わせるので、使うたびに作る） */
export const phraseSchema = () => ({
  name: 'phrase_candidates',
  schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        // i18n-ignore
        description: '候補3つ',
        items: {
          type: 'object',
          properties: {
            // i18n-ignore-start
            name: { type: 'string', description: `短い名前（${aiTextLimit(12)}）` },
            reason: { type: 'string', description: `この形にした理由（${aiTextLimit(40)}）` },
            // i18n-ignore-end
            measures: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  // i18n-ignore
                  index: { type: 'integer', description: '範囲の何小節目か（0から）' },
                  lanes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        lane: { type: 'string', enum: GRID_LANES.map((l) => l.code) },
                        steps: { type: 'string', description: STEPS_HELP },
                      },
                      required: ['lane', 'steps'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['index', 'lanes'],
                additionalProperties: false,
              },
            },
          },
          required: ['name', 'reason', 'measures'],
          additionalProperties: false,
        },
      },
    },
    required: ['candidates'],
    additionalProperties: false,
  },
});

export function phrasePrompt(ctx: PhraseContext): { system: string; user: string } {
  // i18n-ignore-start
  const system = [
    'あなたはドラム譜面（DTXMania、電子ドラム）の作者を手伝います。',
    '指定の範囲に入れる' + (ctx.kind === 'fill' ? 'フィルイン' : 'リズムパターン') + 'の候補を、性格の違う3つ作ってください。',
    ...GRID_HELP,
    'レーン: LC=左シンバル HH=ハイハット(閉) HO=ハイハット(開) LP=左ペダル LB=左バスドラム SD=スネア HT=ハイタム BD=バスドラム LT=ロータム FT=フロアタム CY=右シンバル RD=ライド',
    ctx.onsetKind ? onsetHelp(ctx.onsetKind) : '',
    '守ること: 手は同時に2つまで、足は左右1つずつ。前後の小節とのつながりを自然に。範囲の外は書かない。',
    '答えは指定の JSON だけで返してください。',
    aiLangRule(),
  ]
    .filter(Boolean)
    .join('\n');
  const lines: string[] = [];
  lines.push(`BPM ${ctx.bpm}${ctx.targetLevel ? ` / 目標のレベル ${ctx.targetLevel.toFixed(1)} 前後` : ''}`);
  lines.push(`範囲: ${ctx.to - ctx.from + 1} 小節（index 0〜${ctx.to - ctx.from}）`);
  if (ctx.instruction.trim()) lines.push(`作者のひとこと: ${ctx.instruction.trim()}`);
  if (ctx.rounded) lines.push(ROUNDED_NOTE);
  lines.push('');
  for (const ms of ctx.measures) {
    const tag = ms.inRange ? `【範囲 index ${ms.m - ctx.from}】` : ms.m < ctx.from ? '（前）' : '（後）';
    lines.push(`小節 ${ms.m} ${tag} ${ms.beats}`);
    if (ms.inRange) lines.push(ms.grid.length ? `いまの譜面（置き換えます）:\n${ms.grid.join('\n')}` : 'いまの譜面: 空');
    else lines.push(ms.grid.length ? ms.grid.join('\n') : '空');
    if (ms.onsets) lines.push(`原曲の打点:\n${ms.onsets.join('\n')}`);
    lines.push('');
  }
  // i18n-ignore-end
  return { system, user: lines.join('\n') };
}

interface RawCandidate {
  name?: string;
  reason?: string;
  measures?: { index?: number; lanes?: { lane?: string; steps?: string }[] }[];
}

/** AI の答えを譜面のチップにし、範囲外や叩けない組み合わせをはじく */
export function decodeCandidates(raw: { candidates?: RawCandidate[] }, ctx: { from: number; to: number }, tempo: TempoMap): PhraseCandidate[] {
  const out: PhraseCandidate[] = [];
  for (const c of raw.candidates ?? []) {
    const notes: PhraseNote[] = [];
    for (const ms of c.measures ?? []) {
      const idx = Math.trunc(ms.index ?? -1);
      const m = ctx.from + idx;
      if (idx < 0 || m > ctx.to) continue;
      const { beats, total } = beatsOfMeasure(tempo, m);
      for (const ln of ms.lanes ?? []) {
        const def = LANE_OF.get(String(ln.lane ?? '').toUpperCase());
        if (!def) continue;
        for (const f of parseSteps(String(ln.steps ?? ''), beats, total)) notes.push({ ch: def.ch, m, f });
      }
    }
    const clean = enforcePlayable(notes);
    if (clean.length === 0) continue;
    // 英語の名前・理由は長くなるので、切る長さは広めに
    out.push({ name: String(c.name ?? tr('候補', 'Idea')).slice(0, 48), reason: String(c.reason ?? '').slice(0, 160), source: 'ai', notes: clean });
  }
  return out.slice(0, 3);
}

/** 手は2つ、左足・右足は1つずつまで。同じチャンネルの重なりは1つに */
export function enforcePlayable(notes: PhraseNote[]): PhraseNote[] {
  const byPos = new Map<string, PhraseNote[]>();
  for (const n of notes) {
    const k = `${n.m}:${n.f.n}/${n.f.d}`;
    let a = byPos.get(k);
    if (!a) byPos.set(k, (a = []));
    if (!a.some((x) => x.ch === n.ch)) a.push(n);
  }
  const keepOrder: number[] = [CH.CY, CH.LC, CH.SD, CH.BD, CH.HT, CH.LT, CH.FT, CH.HHO, CH.HHC, CH.RD, CH.LBD, CH.LP];
  const out: PhraseNote[] = [];
  for (const a of byPos.values()) {
    a.sort((x, y) => keepOrder.indexOf(x.ch) - keepOrder.indexOf(y.ch));
    let hands = 0;
    let left = 0;
    let right = 0;
    let hh = false;
    for (const n of a) {
      const def = GRID_LANES.find((l) => l.ch === n.ch)!;
      if (def.hand) {
        // 閉じたHHと開いたHHは同時に叩けない
        if (n.ch === CH.HHC || n.ch === CH.HHO) {
          if (hh) continue;
          hh = true;
        }
        if (hands >= 2) continue;
        hands++;
      } else if (def.foot === 'L') {
        if (left >= 1) continue;
        left++;
      } else {
        if (right >= 1) continue;
        right++;
      }
      out.push(n);
    }
  }
  return out;
}

// ---- キーが無いときの候補 -----------------------------------------------------------

function drumNotesIn(doc: DtxDoc, m: number): { ch: number; f: Frac }[] {
  return doc.chips.filter((c) => c.m === m && drumChannel(c.ch)?.kind === 'normal').map((c) => ({ ch: c.ch, f: c.f }));
}

function cosine(a: number[], b: number[]): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

function onsetVector(onsets: OnsetRows, tempo: TempoMap, m: number, offsetSec: number): number[] {
  const steps = 16;
  const start = tempo.measureStart(m);
  const beats = tempo.measureBeats(m);
  const keys = Object.keys(onsets);
  const v = Array(steps * keys.length).fill(0);
  keys.forEach((b, bi) => {
    for (const o of onsets[b]) {
      const beat = tempo.secToBeat(o.t + offsetSec);
      if (beat < start - 0.1 || beat >= start + beats - 0.1) continue;
      const i = Math.round(((beat - start) / beats) * steps);
      if (i >= 0 && i < steps) v[bi * steps + i] = Math.max(v[bi * steps + i], o.s);
    }
  });
  return v;
}

function noteKey(n: { ch: number; f: Frac }) {
  return `${n.ch}@${n.f.n}/${n.f.d}`;
}

/** キーが無いときの候補：原曲の打点が似た小節（譜面のある小節）からのコピーと、直前の小節の複製 */
export function ruleCandidates(doc: DtxDoc, tempo: TempoMap, o: { from: number; to: number; onsets: OnsetRows | null; offsetSec: number; lastMeasure: number }): PhraseCandidate[] {
  const len = o.to - o.from + 1;
  const out: PhraseCandidate[] = [];
  const has = (m: number) => drumNotesIn(doc, m).length >= 3;
  const contentKey = (from: number) =>
    Array.from({ length: len }, (_, i) => drumNotesIn(doc, from + i).map(noteKey).sort().join(',')).join('|');
  const current = contentKey(o.from);
  const seen = new Set<string>([current]);
  // 直前の小節（同じ中身の「似た小節」は出さない）
  const p = o.from - len;
  let prevCand: PhraseCandidate | null = null;
  if (p >= 0) {
    const key = contentKey(p);
    if (!seen.has(key) && Array.from({ length: len }, (_, i) => has(p + i)).some(Boolean)) {
      seen.add(key);
      const notes: PhraseNote[] = [];
      for (let i = 0; i < len; i++) for (const n of drumNotesIn(doc, p + i)) notes.push({ ch: n.ch, m: o.from + i, f: n.f });
      prevCand = {
        name: len === 1 ? tr('直前の小節を複製', 'Repeat the previous measure') : tr(`直前の${len}小節を複製`, `Repeat the previous ${len} measures`),
        reason: tr('前と同じ形を続けます', 'Keeps the same pattern going'),
        source: 'prev',
        notes,
      };
    }
  }
  // 似た小節
  const scored: { m: number; score: number; why: string }[] = [];
  for (let m = 0; m + len - 1 <= o.lastMeasure; m++) {
    if (m + len - 1 >= o.from && m <= o.to) continue;
    let ok = true;
    for (let i = 0; i < len; i++) if (!has(m + i) || Math.abs(tempo.barLen(m + i) - tempo.barLen(o.from + i)) > 1e-6) ok = false;
    if (!ok) continue;
    let score = 0;
    let why = '';
    if (o.onsets) {
      for (let i = 0; i < len; i++) score += cosine(onsetVector(o.onsets, tempo, o.from + i, o.offsetSec), onsetVector(o.onsets, tempo, m + i, o.offsetSec));
      score /= len;
      why = tr(`原曲の打点が ${Math.round(score * 100)}% 似ています`, `The original's hits are ${Math.round(score * 100)}% similar`);
    } else {
      // 原曲の解析が無いときは、直前の小節が似ている所の続き
      const prevA = new Set(drumNotesIn(doc, o.from - 1).map(noteKey));
      const prevB = drumNotesIn(doc, m - 1).map(noteKey);
      if (prevA.size === 0 || prevB.length === 0) continue;
      const inter = prevB.filter((k) => prevA.has(k)).length;
      score = inter / (prevA.size + prevB.length - inter);
      why = tr(`直前の小節が ${Math.round(score * 100)}% 同じ所の続き`, `What follows a place whose previous measure is ${Math.round(score * 100)}% the same`);
    }
    if (score > 0.3) scored.push({ m, score, why });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    const key = contentKey(s.m);
    if (seen.has(key)) continue;
    seen.add(key);
    const notes: PhraseNote[] = [];
    for (let i = 0; i < len; i++) for (const n of drumNotesIn(doc, s.m + i)) notes.push({ ch: n.ch, m: o.from + i, f: n.f });
    out.push({ name: tr(`小節 ${s.m} からコピー`, `Copy from measure ${s.m}`), reason: s.why, source: 'similar', notes });
    if (out.length >= 2) break;
  }
  if (prevCand) out.push(prevCand);
  return out.slice(0, 3);
}
