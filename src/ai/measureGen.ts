// 小節の生成（AI）：指定の小節（1〜4小節）のドラムを、原曲の打点と前後の譜面から書いてもらう。
// 格子（レーン × 拍ごとの格子。16分・3連・32分を拍ごとに選ぶ）での受け渡しと答えの読み方はフレーズ候補（ai/phrase）と同じ。
// フレーズ候補との違い：原曲の打点に合わせて「耳コピ」すること、前後の小節で作者が原曲の打点をどう書いているか
// （シンバルの打点をライドで書く、など）を読み取ってそろえること、作者がもう置いたチップを手がかりにすること。
import { beatsLabel } from './beatGrid';
import { decodeCandidates, GRID_HELP, isDrumRows, measureGrid, measureLayout, onsetGrid, onsetHelp, ROUNDED_NOTE, STEPS_HELP, GRID_LANES, type OnsetRows, type PhraseCandidate } from './phrase';
import type { DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';

export interface MeasureGenContext {
  from: number;
  to: number;
  bpm: number;
  level: number | null;
  /** 前後の小節と生成する小節 */
  measures: {
    m: number;
    role: 'before' | 'target' | 'after';
    /** 小節の長さ（「4拍」など） */
    beats: string;
    grid: string[];
    onsets: string[] | null;
    section: string | null;
  }[];
  /** 似ている小節（この曲でもう書いてある所。写す案の元）。小節は生成する範囲と同じ数だけ並ぶ */
  refs: { src: number; score: number | null; len: number; shown: boolean; measures: { m: number; grid: string[]; onsets: string[] | null }[] }[];
  /** 作者の書き方の要約（assist/draft の styleLines） */
  style: string[];
  onsetKind?: 'drums' | 'bands';
  /** 原曲（BGM）がドラム抜き */
  drumless: boolean;
  rounded: boolean;
  instruction: string;
}

export function buildMeasureContext(
  doc: DtxDoc,
  tempo: TempoMap,
  o: {
    from: number;
    to: number;
    onsets: OnsetRows | null;
    offsetSec: number;
    level: number | null;
    style: string[];
    sectionOf: (m: number) => string | null;
    /** 似ている小節の頭（写す案の元）と、同じ形の見込み（0〜1） */
    refs?: { src: number; score: number | null }[];
    /** 原曲（BGM）がドラム抜き（打点は送らない） */
    drumless?: boolean;
    instruction?: string;
    span?: number;
  },
): MeasureGenContext {
  const span = o.span ?? 4;
  const measures: MeasureGenContext['measures'] = [];
  let rounded = false;
  const len = o.to - o.from + 1;
  const near = (m: number) => m >= o.from - span && m <= o.to + span;
  const refs: MeasureGenContext['refs'] = [];
  for (const r of o.refs ?? []) {
    if (r.src < 0) continue;
    let n = 0;
    while (n < len && !(r.src + n >= o.from && r.src + n <= o.to)) n++;
    if (n === 0) continue;
    // 前後の小節としてもう見せているものは、どれに当たるかだけ伝える
    const shown = near(r.src) && near(r.src + n - 1);
    const ms: MeasureGenContext['refs'][number]['measures'] = [];
    if (!shown) {
      for (let i = 0; i < n; i++) {
        const m = r.src + i;
        const layout = measureLayout(doc, tempo, m, { onsets: o.onsets, offsetSec: o.offsetSec });
        const g = measureGrid(doc, tempo, m, layout);
        rounded ||= g.rounded;
        ms.push({ m, grid: g.lines, onsets: o.onsets ? onsetGrid(o.onsets, tempo, m, o.offsetSec, layout) : null });
      }
      if (!ms.some((x) => x.grid.length)) continue;
    }
    refs.push({ src: r.src, score: r.score, len: n, shown, measures: ms });
  }
  for (let m = Math.max(0, o.from - span); m <= o.to + span; m++) {
    const role = m < o.from ? 'before' : m > o.to ? 'after' : 'target';
    // 生成する小節は、原曲の打点の時刻から拍ごとの細かさ（3連・32分）を選ぶ
    const layout = measureLayout(doc, tempo, m, { onsets: o.onsets, offsetSec: o.offsetSec, fit: role === 'target' });
    const g = measureGrid(doc, tempo, m, layout);
    rounded ||= g.rounded;
    measures.push({
      m,
      role,
      beats: beatsLabel(layout.beats),
      grid: g.lines,
      onsets: o.onsets ? onsetGrid(o.onsets, tempo, m, o.offsetSec, layout) : null,
      section: o.sectionOf(m),
    });
  }
  return {
    from: o.from,
    to: o.to,
    bpm: Math.round(tempo.bpmAt(tempo.measureStart(o.from))),
    level: o.level,
    measures,
    refs,
    style: o.style,
    onsetKind: o.onsets ? (isDrumRows(o.onsets) ? 'drums' : 'bands') : undefined,
    drumless: !!o.drumless,
    rounded,
    instruction: o.instruction ?? '',
  };
}

export const MEASURE_SCHEMA = {
  name: 'measure_candidates',
  schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        description: '案3つ（1つめが一番ありそうなもの）',
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
                  index: { type: 'integer', description: '生成する範囲の何小節目か（0から）' },
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
};

export function measurePrompt(ctx: MeasureGenContext): { system: string; user: string } {
  const n = ctx.to - ctx.from + 1;
  const hasOnsets = !!ctx.onsetKind;
  const system = [
    'あなたはドラム譜面（DTXMania、電子ドラム）の耳コピを手伝います。',
    `【生成】の${n === 1 ? '小節' : `${n}小節`}のドラムを、原曲に合わせて書いてください。性格の違う案を3つ作ります。`,
    ...GRID_HELP,
    'レーン: LC=左シンバル HH=ハイハット(閉) HO=ハイハット(開) LP=左ペダル LB=左バスドラム SD=スネア HT=ハイタム BD=バスドラム LT=ロータム FT=フロアタム CY=右シンバル RD=ライド',
    ctx.onsetKind
      ? onsetHelp(ctx.onsetKind)
      : ctx.drumless
        ? '原曲（BGM）はドラム抜きの音源なので、原曲の打点はありません。前後の小節や似ている小節の流れから、いちばん自然なものを書いてください。'
        : '原曲の打点はありません。前後の小節の流れから、いちばん自然なものを書いてください。',
    hasOnsets
      ? '前後の小節には、作者が書いた譜面と、同じ小節の原曲の打点を並べています。作者は聞こえた音をそのまま全部は書かず、決まった書き方をします（シンバルの8分をライドの4分で書く、聞こえない左足のハイハットを足す、小さな音を省く など）。前後の小節で原曲の打点と作者の譜面の対応を確かめ、【生成】の小節も同じ書き方にしてください。'
      : '前後の小節の書き方（使うシンバル・ハイハットの開け閉め・タムの使い方）にそろえてください。',
    ctx.refs.length
      ? '「似ている小節」は、この曲で作者がもう書いた小節のうち【生成】の小節と形が近いものです。原曲の打点を【生成】の小節と見比べて、同じ所は作者の譜面をそのまま使い、違う所だけ直してください（作者の書き方にそろえるのにいちばん確かです）。'
      : '',
    '案1: いちばんありそうなもの（作者がこの小節に書きそうなもの。原曲の打点を、前後や似ている小節と同じ書き方で書く）。案2: 似ている小節や前後の小節の形をそのまま土台にして、原曲の打点が違う所だけ変えたもの。案3: 別の聞こえ方（フィル・アクセント・シンバルの選び方の違いなど）。',
    '作者がもう置いているチップがあれば、作者が聞き取ったものです。合っていそうなら案に入れてください。',
    ctx.onsetKind === 'drums' ? '【生成】の小節の拍の細かさは、原曲の打点の時刻に合わせて選んであります（3や6の拍は3連、8の拍は32分に聞こえる所）。3連・32分に聞こえる所は、その細かさで書いてください。' : '',
    '守ること: 手は同時に2つまで、足は左右1つずつ。【生成】の小節だけを書く。',
    '答えは指定の JSON だけで返してください。',
  ]
    .filter(Boolean)
    .join('\n');
  const lines: string[] = [];
  lines.push(`BPM ${ctx.bpm}${ctx.level ? ` / この譜面のレベル ${ctx.level.toFixed(2)}` : ''}`);
  lines.push(`【生成】${n} 小節（index 0〜${n - 1}）`);
  if (ctx.style.length) {
    lines.push('作者の書き方（前後の小節で使っているレーンの割合）:');
    for (const s of ctx.style) lines.push(`- ${s}`);
  }
  if (ctx.instruction.trim()) lines.push(`作者のひとこと: ${ctx.instruction.trim()}`);
  if (ctx.rounded) lines.push(ROUNDED_NOTE);
  lines.push('');
  if (ctx.refs.length) {
    lines.push('似ている小節（この曲で作者がもう書いた所）:');
    for (const r of ctx.refs) {
      const span = r.len === 1 ? `小節 ${r.src}` : `小節 ${r.src}〜${r.src + r.len - 1}`;
      const idx = r.len === 1 ? '【生成 index 0】' : `【生成 index 0〜${r.len - 1}】`;
      const pct = r.score !== null && Number.isFinite(r.score) ? `（同じ形の見込み ${Math.round(r.score * 100)}%）` : '';
      lines.push(`${span} → ${idx}に対応${pct}${r.shown ? '。下の前後の小節に出しています' : ''}`);
      for (const ms of r.measures) {
        if (r.measures.length > 1) lines.push(`小節 ${ms.m}`);
        lines.push(ms.grid.length ? `譜面:\n${ms.grid.join('\n')}` : '譜面: 空');
        if (ms.onsets) lines.push(`原曲の打点:\n${ms.onsets.join('\n')}`);
      }
      if (!r.shown) lines.push('');
    }
    if (ctx.refs.some((r) => r.shown)) lines.push('');
    lines.push('前後の小節:');
  }
  let prevSection: string | null = null;
  for (const ms of ctx.measures) {
    const tag = ms.role === 'target' ? `【生成 index ${ms.m - ctx.from}】` : ms.role === 'before' ? '（前）' : '（後）';
    const sec = ms.section && ms.section !== prevSection ? ` ここから「${ms.section}」` : '';
    prevSection = ms.section;
    lines.push(`小節 ${ms.m} ${tag} ${ms.beats}${sec}`);
    if (ms.role === 'target') lines.push(ms.grid.length ? `作者がもう置いているチップ:\n${ms.grid.join('\n')}` : '作者がもう置いているチップ: なし');
    else lines.push(ms.grid.length ? `譜面:\n${ms.grid.join('\n')}` : '譜面: 空');
    if (ms.onsets) lines.push(`原曲の打点:\n${ms.onsets.join('\n')}`);
    lines.push('');
  }
  return { system, user: lines.join('\n') };
}

/** AI の答えを譜面のチップにする（範囲の外や叩けない組み合わせははじく） */
export function decodeMeasureCandidates(raw: unknown, ctx: { from: number; to: number }, tempo: TempoMap): PhraseCandidate[] {
  return decodeCandidates(raw as Parameters<typeof decodeCandidates>[0], ctx, tempo);
}
