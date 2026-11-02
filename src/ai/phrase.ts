// フレーズ候補：選んだ範囲に入れるフィルやリズムの候補を3つ作る。
// AI には小節ごとの「レーン × 16分」の文字の格子で渡し、同じ形で返してもらう（拍がずれない）。
// キーが無いときは、原曲の打点が似た小節・直前の小節から候補を作る。
import type { Onset } from '../audio/analysis';
import { frac, type Frac } from '../dtx/fraction';
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

/** 小節のドラムを「レーン: x-x-…」の行にする。16分に乗らない音は近い16分に丸め、丸めたことを返す */
export function measureGrid(doc: DtxDoc, tempo: TempoMap, m: number): { lines: string[]; rounded: boolean } {
  const steps = stepsOf(tempo, m);
  const rows = new Map<string, string[]>();
  let rounded = false;
  for (const c of doc.chips) {
    if (c.m !== m) continue;
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    const code = CODE_OF.get(c.ch);
    if (!code) continue;
    const x = (c.f.n / c.f.d) * steps;
    const i = Math.min(steps - 1, Math.round(x));
    if (Math.abs(x - i) > 1e-6) rounded = true;
    let r = rows.get(code);
    if (!r) rows.set(code, (r = Array(steps).fill('-')));
    r[i] = 'x';
  }
  const lines = GRID_LANES.filter((l) => rows.has(l.code)).map((l) => `${l.code}: ${rows.get(l.code)!.join('')}`);
  return { lines, rounded };
}

/** 原曲の打点を、小節の16分ごとの強さ（0〜9）の文字列にする */
export function onsetGrid(onsets: Record<'low' | 'mid' | 'high', Onset[]>, tempo: TempoMap, m: number, offsetSec: number): string[] {
  const steps = stepsOf(tempo, m);
  const start = tempo.measureStart(m);
  const beats = tempo.measureBeats(m);
  const out: string[] = [];
  for (const b of ['low', 'mid', 'high'] as const) {
    const cells = Array(steps).fill(0);
    for (const o of onsets[b]) {
      const beat = tempo.secToBeat(o.t + offsetSec);
      if (beat < start - 0.1 || beat >= start + beats - 0.1) continue;
      const i = Math.round(((beat - start) / beats) * steps);
      if (i < 0 || i >= steps) continue;
      cells[i] = Math.max(cells[i], Math.min(9, Math.round(o.s * 9)));
    }
    out.push(`${b === 'low' ? '低' : b === 'mid' ? '中' : '高'}: ${cells.join('')}`);
  }
  return out;
}

export interface PhraseContext {
  kind: 'fill' | 'rhythm';
  from: number;
  to: number;
  bpm: number;
  targetLevel: number | null;
  instruction: string;
  /** 範囲と前後4小節の格子 */
  measures: { m: number; inRange: boolean; steps: number; grid: string[]; onsets: string[] | null }[];
  rounded: boolean;
}

export function buildContext(doc: DtxDoc, tempo: TempoMap, o: { kind: 'fill' | 'rhythm'; from: number; to: number; instruction: string; targetLevel: number | null; onsets: Record<'low' | 'mid' | 'high', Onset[]> | null; offsetSec: number }): PhraseContext {
  const measures: PhraseContext['measures'] = [];
  let rounded = false;
  for (let m = Math.max(0, o.from - 4); m <= o.to + 4; m++) {
    const g = measureGrid(doc, tempo, m);
    rounded ||= g.rounded;
    measures.push({ m, inRange: m >= o.from && m <= o.to, steps: stepsOf(tempo, m), grid: g.lines, onsets: o.onsets ? onsetGrid(o.onsets, tempo, m, o.offsetSec) : null });
  }
  return { kind: o.kind, from: o.from, to: o.to, bpm: Math.round(tempo.bpmAt(tempo.measureStart(o.from))), targetLevel: o.targetLevel, instruction: o.instruction, measures, rounded };
}

export const PHRASE_SCHEMA = {
  name: 'phrase_candidates',
  schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        description: '候補3つ',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '短い名前（日本語で12字以内）' },
            reason: { type: 'string', description: 'この形にした理由（日本語で40字以内）' },
            measures: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer', description: '範囲の何小節目か（0から）' },
                  lanes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        lane: { type: 'string', enum: GRID_LANES.map((l) => l.code) },
                        steps: { type: 'string', description: 'x=打つ, -=休み。小節の16分の数と同じ長さ' },
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
};

export function phrasePrompt(ctx: PhraseContext): { system: string; user: string } {
  const system = [
    'あなたはドラム譜面（DTXMania、電子ドラム）の作者を手伝います。',
    '指定の範囲に入れる' + (ctx.kind === 'fill' ? 'フィルイン' : 'リズムパターン') + 'の候補を、性格の違う3つ作ってください。',
    '譜面は小節ごとに「レーン: 格子」で表します。格子の1文字は16分音符1つ、x は打つ、- は休み。',
    'レーン: LC=左シンバル HH=ハイハット(閉) HO=ハイハット(開) LP=左ペダル LB=左バスドラム SD=スネア HT=ハイタム BD=バスドラム LT=ロータム FT=フロアタム CY=右シンバル RD=ライド',
    '原曲の打点は「低・中・高」の帯域ごとの強さ（0〜9）で、同じ16分の位置に並んでいます。低はキック、中はスネアやタム、高はシンバルやハイハットの目安です。',
    '守ること: 手は同時に2つまで、足は左右1つずつ。前後の小節とのつながりを自然に。範囲の外は書かない。',
    '答えは指定の JSON だけで返してください。',
  ].join('\n');
  const lines: string[] = [];
  lines.push(`BPM ${ctx.bpm}${ctx.targetLevel ? ` / 目標のレベル ${ctx.targetLevel.toFixed(1)} 前後` : ''}`);
  lines.push(`範囲: ${ctx.to - ctx.from + 1} 小節（index 0〜${ctx.to - ctx.from}）`);
  if (ctx.instruction.trim()) lines.push(`作者のひとこと: ${ctx.instruction.trim()}`);
  if (ctx.rounded) lines.push('（3連などは近い16分に丸めて表しています）');
  lines.push('');
  for (const ms of ctx.measures) {
    const tag = ms.inRange ? `【範囲 index ${ms.m - ctx.from}】` : ms.m < ctx.from ? '（前）' : '（後）';
    lines.push(`小節 ${ms.m} ${tag} 16分×${ms.steps}`);
    if (ms.inRange) lines.push(ms.grid.length ? `いまの譜面（置き換えます）:\n${ms.grid.join('\n')}` : 'いまの譜面: 空');
    else lines.push(ms.grid.length ? ms.grid.join('\n') : '空');
    if (ms.onsets) lines.push(`原曲の打点:\n${ms.onsets.join('\n')}`);
    lines.push('');
  }
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
      const steps = stepsOf(tempo, m);
      for (const ln of ms.lanes ?? []) {
        const def = LANE_OF.get(String(ln.lane ?? '').toUpperCase());
        if (!def) continue;
        const s = String(ln.steps ?? '').replace(/\s|\|/g, '');
        for (let i = 0; i < Math.min(steps, s.length); i++) {
          if (!/[xXoO●]/.test(s[i])) continue;
          notes.push({ ch: def.ch, m, f: frac(i, steps) });
        }
      }
    }
    const clean = enforcePlayable(notes);
    if (clean.length === 0) continue;
    out.push({ name: String(c.name ?? '候補').slice(0, 24), reason: String(c.reason ?? '').slice(0, 80), source: 'ai', notes: clean });
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

function onsetVector(onsets: Record<'low' | 'mid' | 'high', Onset[]>, tempo: TempoMap, m: number, offsetSec: number): number[] {
  const steps = 16;
  const start = tempo.measureStart(m);
  const beats = tempo.measureBeats(m);
  const v = Array(steps * 3).fill(0);
  (['low', 'mid', 'high'] as const).forEach((b, bi) => {
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
export function ruleCandidates(doc: DtxDoc, tempo: TempoMap, o: { from: number; to: number; onsets: Record<'low' | 'mid' | 'high', Onset[]> | null; offsetSec: number; lastMeasure: number }): PhraseCandidate[] {
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
      prevCand = { name: len === 1 ? '直前の小節を複製' : `直前の${len}小節を複製`, reason: '前と同じ形を続けます', source: 'prev', notes };
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
      why = `原曲の打点が ${Math.round(score * 100)}% 似ています`;
    } else {
      // 原曲の解析が無いときは、直前の小節が似ている所の続き
      const prevA = new Set(drumNotesIn(doc, o.from - 1).map(noteKey));
      const prevB = drumNotesIn(doc, m - 1).map(noteKey);
      if (prevA.size === 0 || prevB.length === 0) continue;
      const inter = prevB.filter((k) => prevA.has(k)).length;
      score = inter / (prevA.size + prevB.length - inter);
      why = `直前の小節が ${Math.round(score * 100)}% 同じ所の続き`;
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
    out.push({ name: `小節 ${s.m} からコピー`, reason: s.why, source: 'similar', notes });
    if (out.length >= 2) break;
  }
  if (prevCand) out.push(prevCand);
  return out.slice(0, 3);
}
