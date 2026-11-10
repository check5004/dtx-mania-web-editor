// 小節の生成（AI）：指定の小節（1〜4小節）のドラムを、原曲の分析と作者の譜面から書いてもらう。
// 格子（レーン × 拍ごとの格子。16分・3連・32分を拍ごとに選ぶ）での受け渡しと答えの読み方はフレーズ候補（ai/phrase）と同じ。
//
// AI は曲を聴けないので、耳コピする人が見ているもの（採譜の打点の強さ・ドラム強調のスペクトル）を数字の格子にして渡す（ai/analysisGrid）。
// そのうえで、作者が自分で書いた小節（手本）の「分析と譜面の組」を見せ、作者が分析をどう譜面にしているか（読み方）を
// つかんでから書いてもらう。分析が手本とほぼ同じなら、その手本をそのまま使って違う所だけ直す。
// 自動で入れたまま作者が確かめていない小節（TAB補完・小節の生成・フレーズ候補など）は、手本にも前後の譜面にもしない。
import { aiLangRule, aiTextLimit } from '../i18n';
import { analysisSimilarity, readingGuide, seriesLines, type MeasureAnalysis } from './analysisGrid';
import { beatsLabel } from './beatGrid';
import { decodeCandidates, GRID_HELP, isDrumRows, LANE_HELP, measureGrid, measureLayout, onsetGrid, onsetHelp, ROUNDED_NOTE, STEPS_HELP, GRID_LANES, type OnsetRows, type PhraseCandidate } from './phrase';
import type { DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';

/** 小節の分析の行（採譜・スペクトル。無ければ空） */
export interface MeasureRows {
  act: string[];
  spec: string[];
}

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
    /** 作者が書いた（確かめた）小節か。自動で入れたままの前後の小節は譜面を見せない（生成する小節は見せて、そう書き添える） */
    human: boolean;
    /** 原曲の打点（採譜の分析が無いときの3帯域・5種の打点） */
    onsets: string[] | null;
    /** 原曲の分析（採譜・スペクトル） */
    rows: MeasureRows | null;
    /** 手本にもなる小節か */
    example: boolean;
    section: string | null;
  }[];
  /** 手本（作者が書いた小節のうち、【生成】の小節と分析・形が近いもの）。近い順 */
  examples: {
    m: number;
    /** どの【生成】の小節に近いか（0から） */
    target: number;
    /** 分析の近さ（0〜1、分からなければ null） */
    sim: number | null;
    /** 写す案の見込み（TAB補完の点数。写す案の元でなければ null） */
    score: number | null;
    /** 前後の小節に出している */
    shown: boolean;
    grid: string[];
    rows: MeasureRows | null;
    onsets: string[] | null;
  }[];
  /** 読み方の目安（手本から数えた割合） */
  guide: string[];
  /** 目安を数えた小節の数 */
  guideMeasures: number;
  /** 作者の書き方の要約（assist/draft の styleLines） */
  style: string[];
  onsetKind?: 'drums' | 'bands';
  /** 採譜・スペクトルの分析を渡すか（無ければ打点だけ） */
  analysis: { act: boolean; spec: boolean };
  /** 原曲（BGM）がドラム抜き */
  drumless: boolean;
  rounded: boolean;
  instruction: string;
}

/** 手本の数の上限（生成する小節が1つのとき・2つ以上のとき） */
const MAX_EXAMPLES = [6, 8];
/** 生成する小節1つあたり、分析の近さで選ぶ手本の数 */
const PER_TARGET = 3;
/** 読み方の目安を数える範囲（生成する小節の前後） */
const GUIDE_SPAN = 16;

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
    /** 原曲（BGM）がドラム抜き（打点・分析は送らない） */
    drumless?: boolean;
    instruction?: string;
    /** 前後に見せる小節の数（省くと、分析があれば2、無ければ4） */
    span?: number;
    /** 原曲の分析（採譜・スペクトル）。無ければ打点だけ渡す */
    analysis?: MeasureAnalysis | null;
    /** 作者が書いた（確かめた）小節か。省くとチップのある小節はみな作者のもの */
    human?: (m: number) => boolean;
  },
): MeasureGenContext {
  const analysis = o.drumless ? null : (o.analysis ?? null);
  const hasRows = !!analysis && (!!analysis.act || !!analysis.spec);
  const span = o.span ?? (hasRows ? 2 : 4);
  const human = o.human ?? (() => true);
  const len = o.to - o.from + 1;
  let rounded = false;
  const inRange = (m: number) => m >= o.from && m <= o.to;
  // チップのある、作者の小節
  const hasChips = new Set<number>();
  for (const c of doc.chips) if (c.m >= 0) hasChips.add(c.m);
  const written = (m: number) => hasChips.has(m) && measureGrid(doc, tempo, m).lines.length > 0;
  const isExample = (m: number) => !inRange(m) && written(m) && human(m);
  const rowsOf = (m: number, layout: ReturnType<typeof measureLayout>): MeasureRows | null =>
    analysis && hasRows
      ? {
          act: analysis.act ? seriesLines(analysis.act, tempo, m, analysis.offsetSec, layout) : [],
          spec: analysis.spec ? seriesLines(analysis.spec, tempo, m, analysis.offsetSec, layout) : [],
        }
      : null;
  // 分析の行があるときは、採譜の打点の行は出さない（同じもの）。打点は拍の細かさ（3連・32分）を選ぶのにだけ使う
  const onsetRows = (m: number, layout: ReturnType<typeof measureLayout>) => (o.onsets && !(analysis?.act && hasRows) ? onsetGrid(o.onsets, tempo, m, o.offsetSec, layout) : null);

  // ---- 手本を選ぶ：分析が近い作者の小節・写す案の元・すぐ前の作者の小節 ----
  const sim = analysis && hasRows ? analysisSimilarity(analysis, tempo) : null;
  const picks = new Map<number, { target: number; sim: number | null; score: number | null }>();
  const keep = (m: number, target: number, s: number | null, score: number | null) => {
    const cur = picks.get(m);
    if (!cur) picks.set(m, { target, sim: s, score });
    else {
      if (s !== null && (cur.sim === null || s > cur.sim)) Object.assign(cur, { target, sim: s });
      if (score !== null) cur.score = Math.max(cur.score ?? 0, score);
    }
  };
  let last = 0;
  for (const m of hasChips) last = Math.max(last, m);
  if (sim) {
    for (let t = 0; t < len; t++) {
      const ranked: { m: number; s: number }[] = [];
      for (let m = 0; m <= last; m++) {
        if (!isExample(m)) continue;
        const s = sim(o.from + t, m);
        if (s !== null) ranked.push({ m, s });
      }
      ranked.sort((a, b) => b.s - a.s || Math.abs(a.m - o.from) - Math.abs(b.m - o.from));
      for (const r of ranked.slice(0, PER_TARGET)) keep(r.m, t, r.s, null);
    }
  }
  for (const r of o.refs ?? []) {
    for (let i = 0; i < len; i++) {
      const m = r.src + i;
      if (r.src < 0 || !isExample(m)) continue;
      keep(m, i, sim ? sim(o.from + i, m) : null, r.score);
    }
  }
  // すぐ前の作者の小節（流れ）
  for (let m = o.from - 1; m >= Math.max(0, o.from - 8); m--) {
    if (!isExample(m)) continue;
    keep(m, 0, sim ? sim(o.from, m) : null, null);
    break;
  }
  const near = (m: number) => m >= o.from - span && m <= o.to + span;
  const max = MAX_EXAMPLES[len > 1 ? 1 : 0];
  const chosen = [...picks.entries()]
    .sort((a, b) => (b[1].sim ?? -1) - (a[1].sim ?? -1) || (b[1].score ?? 0) - (a[1].score ?? 0) || Math.abs(a[0] - o.from) - Math.abs(b[0] - o.from))
    .slice(0, max);
  const exampleSet = new Set(chosen.map(([m]) => m));
  const examples: MeasureGenContext['examples'] = chosen.map(([m, p]) => {
    const shown = near(m);
    const layout = measureLayout(doc, tempo, m, { onsets: o.onsets, offsetSec: o.offsetSec });
    const g = shown ? null : measureGrid(doc, tempo, m, layout);
    if (g) rounded ||= g.rounded;
    return {
      m,
      target: p.target,
      sim: p.sim,
      score: p.score,
      shown,
      grid: g?.lines ?? [],
      rows: shown ? null : rowsOf(m, layout),
      onsets: shown ? null : onsetRows(m, layout),
    };
  });

  // ---- 前後の小節と生成する小節 ----
  const measures: MeasureGenContext['measures'] = [];
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
      human: g.lines.length === 0 || human(m),
      onsets: onsetRows(m, layout),
      rows: rowsOf(m, layout),
      example: exampleSet.has(m),
      section: o.sectionOf(m),
    });
  }

  // ---- 読み方の目安：生成する小節の前後の作者の小節と手本で数える ----
  let guide: string[] = [];
  const guideSet = new Set<number>(exampleSet);
  for (let m = Math.max(0, o.from - GUIDE_SPAN); m <= o.to + GUIDE_SPAN; m++) if (isExample(m)) guideSet.add(m);
  if (analysis?.act && hasRows) guide = readingGuide(doc, tempo, analysis.act, analysis.offsetSec, [...guideSet].sort((a, b) => a - b));

  return {
    from: o.from,
    to: o.to,
    bpm: Math.round(tempo.bpmAt(tempo.measureStart(o.from))),
    level: o.level,
    measures,
    examples,
    guide,
    guideMeasures: guide.length ? guideSet.size : 0,
    style: o.style,
    onsetKind: o.onsets && !(analysis?.act && hasRows) ? (isDrumRows(o.onsets) ? 'drums' : 'bands') : undefined,
    analysis: { act: !!analysis?.act && hasRows, spec: !!analysis?.spec && hasRows },
    drumless: !!o.drumless,
    rounded,
    instruction: o.instruction ?? '',
  };
}

/** 小節の生成の答えの形（名前・理由の言語と字数は画面の言語に合わせるので、使うたびに作る） */
export const measureSchema = () => ({
  name: 'measure_candidates',
  schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        // i18n-ignore
        description: '案3つ（1つめが一番ありそうなもの）',
        items: {
          type: 'object',
          properties: {
            // i18n-ignore-start
            name: { type: 'string', description: `短い名前（${aiTextLimit(12)}）` },
            reason: { type: 'string', description: `この形にした理由（${aiTextLimit(40)}）` },
            basis: { type: ['integer', 'null'], description: '土台にした手本の小節番号（手本を使っていなければ null）' },
            // i18n-ignore-end
            measures: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  // i18n-ignore
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
          required: ['name', 'reason', 'basis', 'measures'],
          additionalProperties: false,
        },
      },
    },
    required: ['candidates'],
    additionalProperties: false,
  },
});

// AI へのプロンプト（指示は日本語のまま。答えのユーザーが読む文は aiLangRule で画面の言語にする）
// i18n-ignore-start
/** 分析の行の説明 */
const ANALYSIS_HELP = {
  head: '原曲の分析は、小節ごとに譜面と同じ拍ごとの格子に並べた 0〜9 の数字です（大きいほど強い。マスの前後半マスでいちばん強い所）。',
  act: '「採譜」: ドラムの採譜モデルが原曲から聞き取った BD=バスドラム SD=スネア TT=タム（高さは区別しない） HH=ハイハット CY=シンバル・ライド（区別しない）の確からしさ。音の頭で大きくなります。小さな音（ゴーストノート・ペダルのハイハット）は小さく出るか出ず、まれに関係ない音を拾います。',
  spec: '「スペクトル」: エディタの右の列のドラム強調のスペクトル（伸びる音を引いて、叩いた瞬間を残したもの）の帯の明るさ。キック=〜120Hz（バスドラム）、胴=120〜400Hz（スネア・タムの胴。ベースも重なる）、スネア=1.6〜5kHz（スネアの響き）、金物=5kHz〜（ハイハット・シンバル・ライド）。曲の中のふつうの明るさが 0、とくに明るい所が 9。ほかの楽器の音も入って採譜より粗いので、採譜を確かめる補助に使います（採譜に出ない小さな音、手本と形が同じかどうか）。',
};

function rowsBlock(lines: string[], rows: MeasureRows | null, onsets: string[] | null) {
  if (rows?.act.length) lines.push(`採譜:\n${rows.act.join('\n')}`);
  if (rows?.spec.length) lines.push(`スペクトル:\n${rows.spec.join('\n')}`);
  if (onsets) lines.push(`原曲の打点:\n${onsets.join('\n')}`);
}

export function measurePrompt(ctx: MeasureGenContext): { system: string; user: string } {
  const n = ctx.to - ctx.from + 1;
  const hasRows = ctx.analysis.act || ctx.analysis.spec;
  const hasOnsets = hasRows || !!ctx.onsetKind;
  const system = [
    'あなたはドラム譜面（DTXMania、電子ドラム）の耳コピを手伝います。あなたは曲を聴けないので、原曲を分析した数字を読んで書きます。',
    `【生成】の${n === 1 ? '小節' : `${n}小節`}のドラムを、原曲に合わせて書いてください。性格の違う案を3つ作ります。`,
    ...GRID_HELP,
    ...LANE_HELP,
    hasRows ? ANALYSIS_HELP.head : '',
    ctx.analysis.act ? ANALYSIS_HELP.act : '',
    ctx.analysis.spec ? ANALYSIS_HELP.spec : '',
    !hasRows && ctx.onsetKind ? onsetHelp(ctx.onsetKind) : '',
    !hasOnsets
      ? ctx.drumless
        ? '原曲（BGM）はドラム抜きの音源なので、原曲の分析はありません。手本や前後の小節の流れから、いちばん自然なものを書いてください。'
        : '原曲の分析はありません。手本や前後の小節の流れから、いちばん自然なものを書いてください。'
      : '',
    '「手本」は、作者が自分で書いた（自動で入れたあと確かめた）小節の、原曲の分析と作者の譜面の組です。自動で入れたまま作者が確かめていない小節は、手本にも前後の小節の譜面にも入れていません（分析だけ出します）。',
    hasOnsets
      ? '書き方: (1) まず手本で、作者が分析のどの数字をどのレーンでどう書いているか（読み方）をつかむ。作者は聞こえた音をそのまま全部は書かず、決まった書き方をします（シンバルの8分をライドの4分で書く、聞こえない左足のハイハットを足す、小さな音を省く など）。「読み方の目安」は手本から数えた割合です。 (2) 【生成】の分析が手本のどれかとほぼ同じなら、その手本の譜面をそのまま使い、分析がはっきり違うマスだけ直す（作者の書き方にそろえるのにいちばん確かです）。 (3) 似た手本が無い所（フィル・初めて出てくる形）は、読み方の目安に沿って分析から書く。'
      : '手本の書き方（使うシンバル・ハイハットの開け閉め・タムの使い方）にそろえてください。手本に同じ流れの小節があれば、それを土台にしてください。',
    '案1: いちばんありそうなもの（作者がこの小節に書きそうなもの）。案2: いちばん近い手本の譜面を土台に、分析が違う所だけ変えたもの。案3: 別の聞こえ方（フィル・アクセント・シンバルの選び方の違いなど）。',
    'basis には、その案の土台にした手本の小節番号を入れます（手本を土台にしていなければ null）。',
    '作者がもう置いているチップがあれば、作者が聞き取ったものです。合っていそうなら案に入れてください。',
    hasOnsets && (ctx.analysis.act || ctx.onsetKind === 'drums') ? '【生成】の小節の拍の細かさは、原曲の打点の時刻に合わせて選んであります（3や6の拍は3連、8の拍は32分に聞こえる所）。3連・32分に聞こえる所は、その細かさで書いてください。' : '',
    '守ること: 手は同時に2つまで、足は左右1つずつ。【生成】の小節だけを書く。',
    '答えは指定の JSON だけで返してください。',
    aiLangRule(),
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
  if (ctx.guide.length) {
    lines.push(`読み方の目安（作者の小節 ${ctx.guideMeasures} 個で、採譜の数字のマスに作者が書いたレーン）:`);
    for (const s of ctx.guide) lines.push(`- ${s}`);
  }
  if (ctx.instruction.trim()) lines.push(`作者のひとこと: ${ctx.instruction.trim()}`);
  if (ctx.rounded) lines.push(ROUNDED_NOTE);
  lines.push('');
  if (ctx.examples.length) {
    lines.push('手本（作者が書いた小節。【生成】の小節と近い順）:');
    for (const e of ctx.examples) {
      const to = n === 1 ? '【生成】' : `【生成 index ${e.target}】`;
      const facts = [
        e.sim !== null ? `分析の近さ ${Math.round(e.sim * 100)}%` : '',
        e.score !== null && Number.isFinite(e.score) ? `同じ形の見込み ${Math.round(e.score * 100)}%` : '',
        e.m < ctx.from ? `${ctx.from - e.m}小節前` : `${e.m - ctx.to}小節後`,
      ].filter(Boolean);
      lines.push(`小節 ${e.m} → ${to}と${facts.join('・')}${e.shown ? '。下の前後の小節に出しています' : ''}`);
      if (e.shown) continue;
      lines.push(e.grid.length ? `譜面:\n${e.grid.join('\n')}` : '譜面: 空');
      rowsBlock(lines, e.rows, e.onsets);
      lines.push('');
    }
    if (ctx.examples.some((e) => e.shown)) lines.push('');
  }
  lines.push('前後の小節:');
  let prevSection: string | null = null;
  for (const ms of ctx.measures) {
    const tag = ms.role === 'target' ? `【生成 index ${ms.m - ctx.from}】` : ms.role === 'before' ? '（前）' : '（後）';
    const sec = ms.section && ms.section !== prevSection ? ` ここから「${ms.section}」` : '';
    prevSection = ms.section;
    lines.push(`小節 ${ms.m} ${tag} ${ms.beats}${ms.example ? ' 手本' : ''}${sec}`);
    if (ms.role === 'target' && !ms.human) lines.push(`いま入っているチップ（自動で入れたまま。作者は確かめていません）:\n${ms.grid.join('\n')}`);
    else if (ms.role === 'target') lines.push(ms.grid.length ? `作者がもう置いているチップ:\n${ms.grid.join('\n')}` : '作者がもう置いているチップ: なし');
    else if (!ms.human) lines.push('譜面: 自動で入れたまま作者が確かめていないので省きます');
    else lines.push(ms.grid.length ? `譜面:\n${ms.grid.join('\n')}` : ms.role === 'after' ? '譜面: まだ書いていない' : '譜面: 空');
    rowsBlock(lines, ms.rows, ms.onsets);
    lines.push('');
  }
  return { system, user: lines.join('\n') };
}
// i18n-ignore-end

/** AI の答えを譜面のチップにする（範囲の外や叩けない組み合わせははじく） */
export function decodeMeasureCandidates(raw: unknown, ctx: { from: number; to: number }, tempo: TempoMap): PhraseCandidate[] {
  return decodeCandidates(raw as Parameters<typeof decodeCandidates>[0], ctx, tempo);
}
