// AI のレベル判定・ガイドラインの下書き・難易度生成の方針。どれも譜面の特徴量と基準文だけを渡す。
import { tr, aiLangRule, aiLangName } from '../i18n';
import type { DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures, FEATURE_DEFS, featureSummary, sectionSummaries, spanName, type ChartFeatures } from '../gen/features';
import { mainBpm, type Difficulty, type MustKeep, type SectionPlan } from '../gen/simplify';
import { SLOW_BPM, STEP_INFO, stepOrder } from '../gen/reduce';
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

// AI への説明とプロンプトは日本語のまま。ユーザーが読む答え（根拠・難所・方針・基準文）は aiLangName・aiLangRule で画面の言語にする。
// 答えの形は書く言語を含むので、使うたびに作る。

// i18n-ignore-start
export const levelSchema = () => ({
  name: 'level_judgement',
  schema: {
    type: 'object',
    properties: {
      level: { type: 'number', description: 'DTXMania のドラムのレベル（1.00〜9.99、小数2桁）' },
      reasons: { type: 'array', items: { type: 'string' }, description: `根拠を3つ前後（どの基準に当たったか、どこが難所か。${aiLangName()}で短く）` },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      hardest: { type: 'string', description: `いちばんの難所（小節の範囲と内容。${aiLangName()}で）` },
      gap: { type: 'string', description: `機械的な推定と0.5以上違うときはその理由（${aiLangName()}で）。近ければ空` },
    },
    required: ['level', 'reasons', 'confidence', 'hardest', 'gap'],
    additionalProperties: false,
  },
});
// i18n-ignore-end

export interface SectionSpan {
  name: string;
  from: number;
  to: number;
}

/**
 * 難易度の名前（BASIC など）は渡さない。難しい曲は BASIC でもレベルが高いので、名前に引っ張られて低く判定しないように
 * （エディタの「確かめる」でも AI難易度生成でも同じ頼み方にする）
 */
export function levelPrompt(o: { doc: DtxDoc; title: string; sections: SectionSpan[]; guide: string; near: { c: ChartEntry; d: number }[]; mech: number; feat?: ChartFeatures }): { system: string; user: string } {
  const tempo = buildTempoMap(o.doc);
  const feat = o.feat ?? chartFeatures(o.doc, tempo);
  // i18n-ignore-start
  const system = [
    'あなたは DTXMania（ドラム）の譜面のレベルを判定する専門家です。',
    'レベルは 1.00〜9.99。作者の手元の曲から作った「難易度ガイドライン」と、特徴の近い既知レベルの譜面を物差しにしてください。',
    '機械的な推定は打数の密度と同時打数からの目安です。シンコペーションの読みにくさ、手順の組みにくさ、譜面の見た目の分かりにくさなど、機械的な推定が拾えない点を考えてください。',
    `答えは指定の JSON だけで返してください。根拠は${aiLangName()}で短く。`,
    aiLangRule(),
  ].join('\n');
  const lines: string[] = [];
  lines.push(`曲: ${o.title}`);
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
  // i18n-ignore-end
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
    for (let m = 0; m <= last; m += 8) out.push({ name: spanName(m, Math.min(last, m + 7)), from: m, to: Math.min(last, m + 7) });
    // 最後の4小節未満の端は前に含める（終わりの1小節だけの区間を作らない）
    if (out.length >= 2 && out[out.length - 1].to - out[out.length - 1].from < 3) {
      out.pop();
      const p = out[out.length - 1];
      out[out.length - 1] = { name: spanName(p.from, last), from: p.from, to: last };
    }
    return out;
  }
  const out: SectionSpan[] = [];
  if (sorted[0].m > 0) out.push({ name: tr('前奏', 'Intro'), from: 0, to: sorted[0].m - 1 });
  sorted.forEach((s, i) => out.push({ name: s.name, from: s.m, to: i + 1 < sorted.length ? sorted[i + 1].m - 1 : last }));
  return out;
}

// ---- ガイドラインの下書き ---------------------------------------------------------------

// i18n-ignore-start
export const guideSchema = () => ({
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
                  text: { type: 'string', description: `基準文（${aiLangName()}で1文。譜面の作者がそのまま使える言い方）` },
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
});

export function guidelinePrompt(o: { stats: BandStats[]; reps: Record<number, ChartEntry[]>; bands: number[]; confirmed: string }): { system: string; user: string } {
  const system = [
    'あなたは DTXMania（ドラム）の譜面作者のために、レベル帯ごとの「難易度の基準文」を下書きします。',
    '作者の手元の曲を集計した出現率と代表譜面だけを根拠にしてください。一般論で埋めないでください。',
    '1つのレベル帯に3〜5行。各行は「何が出てくるか・どこまでか」を具体的に（例: 「8分のハイハットが土台で、サビの一部で16分の刻みが入る」）。',
    '下の帯と上の帯との違いが分かるように書いてください。答えは指定の JSON だけで。',
    aiLangRule(),
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
// i18n-ignore-end

// ---- 難易度生成の方針 ---------------------------------------------------------------------

export interface DifficultyPlan {
  summary: string;
  sections: SectionPlan[];
}

// i18n-ignore-start
export const planSchema = () => ({
  name: 'difficulty_plan',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: `全体の方針（${aiLangName()}で2文まで）` },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            from: { type: 'integer' },
            to: { type: 'integer' },
            shift: {
              type: 'integer',
              description: 'セクションの役割（-1〜1）。作者の指示でセクションごとの違いを求められたときだけ +1（先に易しく）・-1（最後まで元に近く）。指示が無ければ 0',
            },
            comment: { type: 'string', description: `このセクションがどんな所か・なぜその役割か（${aiLangName()}で1文）` },
          },
          required: ['name', 'from', 'to', 'shift', 'comment'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'sections'],
    additionalProperties: false,
  },
});

// AI に伝える「必ず残すもの」の名前
const KEEP_LABELS: Record<keyof MustKeep, string> = {
  backbeat: '2・4拍のスネア（バックビート）',
  kick1: '1拍目のキック',
  sectionCrash: 'セクション頭のクラッシュ',
  fillLanding: 'フィルの着地',
  openHH: 'オープンHHのアクセント',
};
// i18n-ignore-end

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
  target: { min: number; max: number; center?: number };
  /** 作る元の譜面の難易度（ふつうは MASTER。既存の EXTREME から ADVANCED を作るなど） */
  sourceLabel?: string;
  /** 作る元の譜面のレベル（計算。目標の幅と同じ物差し） */
  masterLevel: number;
  /** 作る元の譜面の登録レベル（#DLEVEL。計算と違えば添える） */
  listedLevel?: number;
  /** 曲にあるほかの難易度（「EXTREME（既存・作者の譜面）Lv6.20」など） */
  others?: string[];
  /**
   * ほかの難易度の作り方（gen/stairs profileLine）：区間ごとに元の譜面の音をどれだけ残しているか、フィルの前後の扱い、
   * このアプリで作った譜面なら方針。上の難易度・下の難易度の考え方に合わせるのに使う
   */
  neighbors?: { above: string[]; below: string[] };
  sections: SectionSpan[];
  guide: string;
  keep: MustKeep;
  instruction: string;
}): { system: string; user: string } {
  const tempo = buildTempoMap(o.doc);
  const feat = chartFeatures(o.doc, tempo);
  const notesEnd = tempo.measureStart(Math.max(0, ...o.doc.chips.map((c) => c.m)) + 1);
  const order = stepOrder(mainBpm(tempo, notesEnd) < SLOW_BPM);
  // i18n-ignore-start
  const system = [
    'あなたは DTXMania（ドラム）の譜面作者です。完成した上の難易度の譜面（ふつうは MASTER）から低い難易度を作るときに、セクションごとの役割だけを決めます。',
    'ノーツの配置はルールエンジンが行います。ルールエンジンは、音楽の決まりごと（拍の強さと楽器の役割）で決めた1本の「省く順番」を、曲全体に同じに当てます。同じ役割の音は、曲のどこにあっても同じ扱いになります（あるセクションではバスドラムを削り、別のセクションではバスドラムを残してハイハットを削る、といったばらつきは起きません）。',
    `省く順番（上から順に、目標のレベルに届くまで省きます）: ${order.map((k, i) => `${i + 1}. ${STEP_INFO[k].label}`).join(' / ')}`,
    'いつも残すもの: 1拍目のバスドラム、2・4拍のスネア（バックビート）、小節の頭と食いのクラッシュとそれに合わせたバスドラム、フィルの着地。楽器や奏法を別のものに置き換えることはしません（ライドはライド、オープンHHはオープン、左右のシンバルもそのまま）。',
    '目標のレベルは決まっていて、ルールエンジンが目標に届く段で止めます。難しい曲は、下の難易度も難しくてよい方針です（低い難易度に合わせて削りすぎると、曲として崩れるため）。説明の文も、難易度の名前ではなく目標のレベルに合わせてください。',
    'レベルはどれも、このアプリの計算（ノーツの密度・同時打ち・速い連打から出す推定）でそろえています。作った譜面にもこの値を書きます。作者の登録レベルが違う譜面は、それも添えます。',
    'あなたが決めるのは、全体の方針の説明（summary）と、セクションごとの説明（comment: どんな所か）と役割（shift）です。',
    '役割（shift）は、作者の指示でセクションごとに違う扱いを求められたときだけ使います（例:「サビは元の譜面に近く」ならサビを -1、「Aメロはもっと簡単に」なら Aメロを +1）。+1 = 先に易しくする、-1 = 最後まで元の譜面に近く残す。指示が無ければ、すべて 0 にしてください（曲全体で同じ扱いにするため。セクションごとにばらばらにすると、一貫しない譜面になります）。',
    '役割を使うときも、省く順番の境目の1段をどこから先に当てるかにだけ使い、どのセクションも曲全体と1段しか違いません。同じ形のセクション（1番と2番のサビなど）は同じ値にしてください。',
    '上の難易度の方針が渡されたときは、その役割に合わせます（上の難易度が +1 にしたセクションは、こちらも +1 にします。ルールエンジンもそうします）。',
    '答えは指定の JSON だけで返してください。sections は与えたセクションと同じ範囲で、すべて返してください。',
    aiLangRule(),
  ].join('\n');
  const lines: string[] = [];
  lines.push(`曲: ${o.title}${o.genre ? `（${o.genre}）` : ''}`);
  const listed = o.listedLevel !== undefined && Math.abs(o.listedLevel - o.masterLevel) >= 0.05 ? `（登録は Lv${o.listedLevel.toFixed(2)}）` : '';
  lines.push(`元の譜面（${o.sourceLabel ?? 'MASTER'}）: Lv${o.masterLevel.toFixed(2)}${listed} / ${featureSummary(feat)}`);
  lines.push(
    `作る難易度: ${o.diff}（目標 Lv${o.target.min.toFixed(2)}〜${o.target.max.toFixed(2)}${o.target.center !== undefined ? `、めやす Lv${o.target.center.toFixed(2)}` : ''}）`,
  );
  if (o.others?.length) lines.push(`曲にある難易度: ${o.others.join('、')}`);
  if (o.neighbors && (o.neighbors.above.length || o.neighbors.below.length)) {
    lines.push('');
    lines.push('ほかの難易度の作り方（区間ごとに、元の譜面の同じ区間の音を何%残しているか。（）は方針の役割 +1 静か・-1 山場）:');
    for (const l of o.neighbors.above) lines.push(`- 上: ${l}`);
    for (const l of o.neighbors.below) lines.push(`- 下: ${l}`);
    lines.push('上の難易度と同じ向きの役割にしてください（静かな所・山場の考え方をそろえる）。');
  }
  lines.push(`必ず残すもの: ${keepList(o.keep) || '指定なし'}`);
  if (o.instruction.trim()) lines.push(`作者の指示: ${o.instruction.trim()}`);
  lines.push('');
  lines.push('セクション:');
  for (const s of sectionSummaries(o.doc, o.sections, tempo)) lines.push(`- ${s}`);
  lines.push('');
  lines.push('難易度ガイドライン（目標のレベル帯）:');
  lines.push(o.guide.trim() || '（まだありません）');
  // i18n-ignore-end
  return { system, user: lines.join('\n') };
}

/** AI の方針を整える（役割は -1〜1。古い答えの ±2 も符号だけ見る） */
export function cleanPlan(raw: Partial<DifficultyPlan> | null, spans: SectionSpan[]): DifficultyPlan {
  const got = Array.isArray(raw?.sections) ? raw!.sections : [];
  const sections: SectionPlan[] = spans.map((s) => {
    const r = got.find((x) => x && Number(x.from) === s.from) ?? got.find((x) => x && x.name === s.name);
    return {
      name: s.name,
      from: s.from,
      to: s.to,
      shift: Math.sign(Math.round(Number(r?.shift) || 0)),
      comment: r?.comment ? String(r.comment) : undefined,
    };
  });
  return { summary: String(raw?.summary ?? ''), sections };
}
