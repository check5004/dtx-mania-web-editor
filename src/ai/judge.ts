// AI のレベル判定・ガイドラインの下書き・難易度生成の方針。どれも譜面の特徴量と基準文だけを渡す。
import type { DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures, FEATURE_DEFS, featureSummary, sectionSummaries, type ChartFeatures } from '../gen/features';
import { describePolicy, FILL_STYLES, LADDER, type Difficulty, type MustKeep, type SectionPlan } from '../gen/simplify';
import type { BandStats, ChartEntry } from '../store/guideline';

// ---- レベル判定 ---------------------------------------------------------------------

export interface LevelJudgement {
  level: number;
  reasons: string[];
  confidence: 'high' | 'medium' | 'low';
  hardest: string;
  /** 機械的な推定と大きく違うときの理由 */
  gap: string;
}

export const LEVEL_SCHEMA = {
  name: 'level_judgement',
  schema: {
    type: 'object',
    properties: {
      level: { type: 'number', description: 'DTXMania のドラムのレベル（1.00〜9.99、小数2桁）' },
      reasons: { type: 'array', items: { type: 'string' }, description: '根拠を3つ前後（どの基準に当たったか、どこが難所か。日本語で短く）' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      hardest: { type: 'string', description: 'いちばんの難所（小節の範囲と内容）' },
      gap: { type: 'string', description: '機械的な推定と0.5以上違うときはその理由。近ければ空' },
    },
    required: ['level', 'reasons', 'confidence', 'hardest', 'gap'],
    additionalProperties: false,
  },
};

export interface SectionSpan {
  name: string;
  from: number;
  to: number;
}

export function levelPrompt(o: { doc: DtxDoc; title: string; label?: string; sections: SectionSpan[]; guide: string; near: { c: ChartEntry; d: number }[]; mech: number; feat?: ChartFeatures }): { system: string; user: string } {
  const tempo = buildTempoMap(o.doc);
  const feat = o.feat ?? chartFeatures(o.doc, tempo);
  const system = [
    'あなたは DTXMania（ドラム）の譜面のレベルを判定する専門家です。',
    'レベルは 1.00〜9.99。作者の手元の曲から作った「難易度ガイドライン」と、特徴の近い既知レベルの譜面を物差しにしてください。',
    '機械的な推定は打数の密度と同時打数からの目安です。シンコペーションの読みにくさ、手順の組みにくさ、譜面の見た目の分かりにくさなど、機械的な推定が拾えない点を考えてください。',
    '答えは指定の JSON だけで返してください。根拠は日本語で短く。',
  ].join('\n');
  const lines: string[] = [];
  lines.push(`曲: ${o.title}${o.label ? `（${o.label}）` : ''}`);
  lines.push(`全体: ${featureSummary(feat)}`);
  lines.push(`機械的な推定: ${o.mech.toFixed(2)}`);
  lines.push('');
  lines.push('セクションごと:');
  for (const s of sectionSummaries(o.doc, o.sections, tempo)) lines.push(`- ${s}`);
  lines.push('');
  lines.push('難易度ガイドライン:');
  lines.push(o.guide.trim() || '（まだありません。一般的な DTXMania の感覚で判断してください）');
  lines.push('');
  lines.push('特徴の近い既知レベルの譜面:');
  if (o.near.length === 0) lines.push('（ライブラリに譜面がありません）');
  for (const { c } of o.near) lines.push(`- ${c.song} ${c.label}: 登録 Lv${c.level?.toFixed(2)} / ${featureSummary(c.feat)}`);
  return { system, user: lines.join('\n') };
}

export function cleanJudgement(j: Partial<LevelJudgement>): LevelJudgement {
  const lv = Math.max(1, Math.min(9.99, Math.round((Number(j.level) || 1) * 100) / 100));
  return {
    level: lv,
    reasons: Array.isArray(j.reasons) ? j.reasons.map(String).filter(Boolean).slice(0, 5) : [],
    confidence: j.confidence === 'high' || j.confidence === 'low' ? j.confidence : 'medium',
    hardest: String(j.hardest ?? ''),
    gap: String(j.gap ?? ''),
  };
}

/** セクション（メモ）から区間を作る。無ければ8小節ごと */
export function sectionSpans(sections: { m: number; name: string }[], last: number): SectionSpan[] {
  const sorted = [...sections].sort((a, b) => a.m - b.m).filter((s) => s.m <= last);
  if (sorted.length === 0) {
    const out: SectionSpan[] = [];
    for (let m = 0; m <= last; m += 8) out.push({ name: `${m}〜${Math.min(last, m + 7)}小節`, from: m, to: Math.min(last, m + 7) });
    // 最後の4小節未満の端は前に含める（終わりの1小節だけの区間を作らない）
    if (out.length >= 2 && out[out.length - 1].to - out[out.length - 1].from < 3) {
      out.pop();
      const p = out[out.length - 1];
      out[out.length - 1] = { name: `${p.from}〜${last}小節`, from: p.from, to: last };
    }
    return out;
  }
  const out: SectionSpan[] = [];
  if (sorted[0].m > 0) out.push({ name: '前奏', from: 0, to: sorted[0].m - 1 });
  sorted.forEach((s, i) => out.push({ name: s.name, from: s.m, to: i + 1 < sorted.length ? sorted[i + 1].m - 1 : last }));
  return out;
}

// ---- ガイドラインの下書き ---------------------------------------------------------------

export const GUIDE_SCHEMA = {
  name: 'difficulty_guideline',
  schema: {
    type: 'object',
    properties: {
      bands: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            band: { type: 'integer', description: 'レベル帯（1〜9。Lv5台なら5）' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: '基準文（日本語で1文。譜面の作者がそのまま使える言い方）' },
                  basis: { type: 'string', description: '根拠になった出現率など（例: 16分のハイハット 45%）' },
                },
                required: ['text', 'basis'],
                additionalProperties: false,
              },
            },
          },
          required: ['band', 'rows'],
          additionalProperties: false,
        },
      },
    },
    required: ['bands'],
    additionalProperties: false,
  },
};

export function guidelinePrompt(o: { stats: BandStats[]; reps: Record<number, ChartEntry[]>; bands: number[]; confirmed: string }): { system: string; user: string } {
  const system = [
    'あなたは DTXMania（ドラム）の譜面作者のために、レベル帯ごとの「難易度の基準文」を下書きします。',
    '作者の手元の曲を集計した出現率と代表譜面だけを根拠にしてください。一般論で埋めないでください。',
    '1つのレベル帯に3〜5行。各行は「何が出てくるか・どこまでか」を具体的に（例: 「8分のハイハットが土台で、サビの一部で16分の刻みが入る」）。',
    '下の帯と上の帯との違いが分かるように書いてください。答えは指定の JSON だけで。',
  ].join('\n');
  const lines: string[] = [];
  lines.push('レベル帯ごとの要素の出現率（その要素が出てくる譜面の割合）:');
  lines.push(['帯', '譜面数', ...FEATURE_DEFS.map((d) => d.label), '密度の中央値(打/秒)', '最大同時打数', 'BPMの中央値', 'ノーツ数の中央値'].join(' | '));
  for (const b of o.stats) {
    if (b.count === 0) continue;
    lines.push([`Lv${b.band}`, b.count, ...FEATURE_DEFS.map((d) => `${Math.round(b.rates[d.key] * 100)}%`), b.density.toFixed(1), b.maxChord, Math.round(b.bpm), Math.round(b.notes)].join(' | '));
  }
  lines.push('');
  lines.push('代表譜面:');
  for (const b of o.bands) for (const c of o.reps[b] ?? []) lines.push(`- Lv${b}台: ${c.song} ${c.label}（Lv${c.level?.toFixed(2)}）${featureSummary(c.feat)}`);
  if (o.confirmed.trim()) {
    lines.push('');
    lines.push('作者が確定済みの基準（書きぶりと線引きを合わせてください）:');
    lines.push(o.confirmed);
  }
  lines.push('');
  lines.push(`下書きするレベル帯: ${o.bands.map((b) => `Lv${b}台`).join('、')}`);
  return { system, user: lines.join('\n') };
}

// ---- 難易度生成の方針 ---------------------------------------------------------------------

export interface DifficultyPlan {
  summary: string;
  sections: SectionPlan[];
}

export const PLAN_SCHEMA = {
  name: 'difficulty_plan',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '全体の方針（日本語で2文まで）' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            from: { type: 'integer' },
            to: { type: 'integer' },
            shift: { type: 'integer', description: '全体の簡略化の段からの増減（-2〜2。+ でより簡単に、- で元の譜面に近く）' },
            fill: { type: 'string', enum: ['keep', 'thin', 'short', 'last'], description: 'フィルの扱い' },
            keepRide: { type: 'boolean', description: 'ライドを残す' },
            keepOpenHH: { type: 'boolean', description: 'オープンハイハットのアクセントを残す' },
            comment: { type: 'string', description: 'このセクションで何を残し何を削るか（日本語で1〜2文）' },
          },
          required: ['name', 'from', 'to', 'shift', 'fill', 'keepRide', 'keepOpenHH', 'comment'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'sections'],
    additionalProperties: false,
  },
};

const KEEP_LABELS: Record<keyof MustKeep, string> = {
  backbeat: '2・4拍のスネア（バックビート）',
  kick1: '1拍目のキック',
  sectionCrash: 'セクション頭のクラッシュ',
  fillLanding: 'フィルの着地',
  openHH: 'オープンHHのアクセント',
};

export function keepList(k: MustKeep): string {
  return (Object.keys(KEEP_LABELS) as (keyof MustKeep)[])
    .filter((x) => k[x])
    .map((x) => KEEP_LABELS[x])
    .join('、');
}

export function planPrompt(o: {
  doc: DtxDoc;
  title: string;
  genre: string;
  diff: Difficulty;
  target: { min: number; max: number };
  masterLevel: number;
  rung: number;
  sections: SectionSpan[];
  guide: string;
  keep: MustKeep;
  instruction: string;
}): { system: string; user: string } {
  const tempo = buildTempoMap(o.doc);
  const feat = chartFeatures(o.doc, tempo);
  const system = [
    'あなたは DTXMania（ドラム）の譜面作者です。完成した MASTER 譜面から低い難易度を作るときの「どこをどう簡略化するか」だけを決めます。',
    'ノーツの配置はルールエンジンが行います。あなたはセクションごとに、全体の簡略化の段からの増減（shift）とフィルの扱いなどを選んでください。',
    '音楽性を壊さないこと: 曲の山場（サビ）らしさ、キメ、ノリは残し、静かな所はより簡単にしてよい。同じ形のセクションには同じ方針を。',
    `フィルの扱い: ${Object.entries(FILL_STYLES)
      .map(([k, v]) => `${k}=${v.label}`)
      .join('、')}`,
    '答えは指定の JSON だけで返してください。sections は与えたセクションと同じ範囲で、すべて返してください。',
  ].join('\n');
  const lines: string[] = [];
  lines.push(`曲: ${o.title}${o.genre ? `（${o.genre}）` : ''}`);
  lines.push(`MASTER: Lv${o.masterLevel.toFixed(2)} / ${featureSummary(feat)}`);
  lines.push(`作る難易度: ${o.diff}（目標 Lv${o.target.min.toFixed(2)}〜${o.target.max.toFixed(2)}）`);
  lines.push(`全体の簡略化の段: ${o.rung}（0〜8。${describePolicy(LADDER[o.rung])}）`);
  lines.push(`必ず残すもの: ${keepList(o.keep) || '指定なし'}`);
  if (o.instruction.trim()) lines.push(`作者の指示: ${o.instruction.trim()}`);
  lines.push('');
  lines.push('セクション:');
  for (const s of sectionSummaries(o.doc, o.sections, tempo)) lines.push(`- ${s}`);
  lines.push('');
  lines.push('難易度ガイドライン（目標のレベル帯）:');
  lines.push(o.guide.trim() || '（まだありません）');
  return { system, user: lines.join('\n') };
}

export function cleanPlan(raw: Partial<DifficultyPlan> | null, spans: SectionSpan[]): DifficultyPlan {
  const got = Array.isArray(raw?.sections) ? raw!.sections : [];
  const sections: SectionPlan[] = spans.map((s) => {
    const r = got.find((x) => x && Number(x.from) === s.from) ?? got.find((x) => x && x.name === s.name);
    const fill = r?.fill && r.fill in FILL_STYLES ? r.fill : undefined;
    return {
      name: s.name,
      from: s.from,
      to: s.to,
      shift: Math.max(-2, Math.min(2, Math.round(Number(r?.shift) || 0))),
      fill,
      keepRide: !!r?.keepRide,
      keepOpenHH: !!r?.keepOpenHH,
      comment: r?.comment ? String(r.comment) : undefined,
    };
  });
  return { summary: String(raw?.summary ?? ''), sections };
}
