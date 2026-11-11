// 低難易度の生成で「どの音を、どの順番で省くか」。音の役割と拍の強さで決め、曲全体で同じに当てる。
// 楯さんの指摘（2026-11-11）: 難易度AIの低難易度が曲を通して一貫しない。目立つ大事なバスドラムまで削ったかと思えば、
// 別の所ではバスドラムが完全に残って濃くなり、今度はハイハットが削られる。
// 原因は、区間ごとの方針（AI の shift ±2）・4小節のうち何小節かだけ次の段・拍の格子だけで決める間引き・
// 同時打ちの上限でハイハットを抜くこと、が重なって、場所ごとに別の楽器が削られていたこと。
//
// 考え方（音楽の決まりごと。作者の譜面 5曲 × EXT・ADV・BSC が MASTER のどの音を残しているかの集計で確かめた）:
// - 拍の強さ（拍節）: 小節の頭 > 小節の真ん中の拍（3拍目）> ほかの拍（2・4拍）> 8分の裏 > 16分の裏。弱い所から省く
// - 楽器の役割:
//   刻み（ハイハット・ライド・クラッシュの刻み）は細かさを 16分 → 8分 → 4分 → 1・3拍 と曲全体でそろえて粗くする。
//   バスドラムはベースと合う骨組み。拍の頭（1拍目）は残し、16分 → 8分の裏（次の拍へのつなぎ → シンコペーション）
//   → 2・4拍 → 3拍目の順に省く。スネアは2・4拍（バックビート）が骨組み。ゴースト（16分の装飾）から省き、
//   8分のシンコペーション（「4拍目の裏」など、次の拍に続かない裏の一打）は最後まで残す（作者の BASIC でも 84%）
// - アクセント（キメ）: クラッシュと同時のバスドラムは目立つ音。小節の頭と食いのクラッシュと一緒のバスドラムは
//   どの段でも残す（作者の BASIC で 81〜99%）。それ以外のキメも、クラッシュを残す間はバスドラム・スネアも残す
// - フィルは 16分 → 8分 → 4分 → 最後の拍だけ、と曲の中のフィルを全部同じに粗くする。着地のクラッシュとバスドラムは残す
// - 同時打ちは2つまで。作者の譜面では、3つ同時（左ペダルとのものを除く）は EXTREME では残し、ADVANCED から減らすので、
//   16分を省いたあとに当てる。まず刻み（クローズのハイハット・ライド）を抜く（4つ打ちの「バスドラム＋スネア＋ハイハット」なら
//   ハイハット。4つ打ちのバスドラムは曲の顔）。それでも多ければ、いちばん先に省く順番の音（フィルの3つ同時なら、作者の譜面と同じく
//   2・4拍のバスドラム）。キメ（クラッシュとそれに合わせた音）は3つのまま残す
// - 速い曲（BPM 130 以上）は、刻みの8分の裏をバスドラムの8分より先に省く（右手の8分は速いと続かない。バスドラムの形は
//   曲の顔なので残す。作者の譜面: 184BPM の曲の EXTREME は刻み 4分・バスドラム全部）。遅い曲は8分の刻みがノリの元なので、
//   バスドラムの8分の裏を先に省く
// 1つの段で省くのは1つの種類だけで、それを曲全体に当てる。同じ役割の音は、どこにあっても同じ扱いになる。
// セクションごとに変えるのは、作者が指示したとき（「サビは元に近く」など）だけ。そのときも、段のあいだの細かい調整（ease）で
// 静かなセクションから次の段を1段だけ先に当てるだけで、どのセクションも曲全体と1段しか違わない。
import { tr, withTr } from '../i18n';
import { HAND_LANES, type Note } from './features';

export type Voice = 'BD' | 'LP' | 'SD' | 'HH' | 'RD' | 'CY' | 'TOM';

/** 楽器（左バスドラムはバスドラム、オープンとクローズのハイハットは同じ。リムはスネア） */
export function voiceOf(n: Pick<Note, 'lane' | 'alt'>): Voice {
  switch (n.lane) {
    case 0:
    case 8:
      return 'CY';
    case 1:
      return 'HH';
    case 2:
      return n.alt ? 'BD' : 'LP';
    case 3:
      return 'SD';
    case 5:
      return 'BD';
    case 9:
      return 'RD';
    default:
      return 'TOM';
  }
}

const EPS = 1e-4;
const isInt = (x: number) => Math.abs(x - Math.round(x)) < EPS;

/**
 * 拍の強さ。4: 小節の頭、3: 小節の真ん中の拍（4拍子の3拍目）、2: ほかの拍、1: 8分の裏（3連符の裏も）、
 * 0: 16分の裏（6連符の裏も）、-1: もっと細かい位置
 */
export function metricOf(n: Pick<Note, 'inBeat' | 'mBeats'>): number {
  const x = n.inBeat;
  if (x < EPS) return 4;
  if (isInt(x)) {
    const b = Math.round(n.mBeats);
    return isInt(n.mBeats) && b >= 4 && b % 2 === 0 && Math.abs(x - b / 2) < EPS ? 3 : 2;
  }
  if (isInt(x * 2) || isInt(x * 3)) return 1;
  if (isInt(x * 4) || isInt(x * 6)) return 0;
  return -1;
}

/** 省く順番の種類（説明は「この段で省くもの」） */
export const STEP_KEYS = [
  'lp',
  'ghost',
  'time16',
  'kick16',
  'snare16',
  'fill16',
  'leftFoot',
  'chord',
  'time8',
  'kick8p',
  'kick8s',
  'snare8p',
  'fill8',
  'kick24',
  'kick3',
  'fillEarly',
  'time24',
  'snareBeat',
  'kime',
  'snare8s',
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

const step = (label: readonly [string, string]) => withTr({} as { readonly label: string }, { label });

/** 各段で省くもの（画面と AI に出す） */
export const STEP_INFO: Record<StepKey, { readonly label: string }> = {
  lp: step(['左ペダル（ハイハットを踏む音）', 'Left pedal (hi-hat foot)']),
  chord: step(['3つ以上の同時打ち（2つまでに）', 'Notes beyond two at once']),
  ghost: step(['スネアの16分の装飾（ゴースト）', 'Snare ghost notes (16ths)']),
  time16: step(['刻みの16分（8分に）', 'Hi-hat / ride 16ths (down to 8ths)']),
  kick16: step(['バスドラムの16分', 'Kick 16ths']),
  snare16: step(['スネアの16分の裏', 'Snare 16th offbeats']),
  fill16: step(['フィルの16分（8分に）', 'Fill 16ths (down to 8ths)']),
  leftFoot: step(['左バスドラム（右へまとめる）', 'Left kick (moved to the right)']),
  time8: step(['刻みの8分の裏（4分に）', 'Hi-hat / ride 8th offbeats (down to quarters)']),
  kick8p: step(['バスドラムの8分の裏（拍へのつなぎ・拍の後の重ね）', 'Kick 8th offbeats next to a kick on the beat']),
  kick8s: step(['バスドラムの8分のシンコペーション', 'Syncopated kick 8ths']),
  snare8p: step(['スネアの8分の裏（拍へのつなぎ・拍の後の重ね）', 'Snare 8th offbeats next to a snare on the beat']),
  fill8: step(['フィルの8分の裏（4分に）', 'Fill 8th offbeats (down to quarters)']),
  kick24: step(['2・4拍のバスドラム', 'Kick on beats 2 and 4']),
  kick3: step(['3拍目のバスドラム', 'Kick on beat 3']),
  fillEarly: step(['フィルの最後の拍より前', 'Fill notes before the last beat']),
  time24: step(['刻みの2・4拍（1・3拍だけに）', 'Hi-hat / ride on beats 2 and 4']),
  snareBeat: step(['バックビートでない拍のスネア', 'Snare on beats other than the backbeat']),
  kime: step(['頭と食い以外のキメ（クラッシュとそれに合わせた音）', 'Accents other than downbeats and pushes (crash and the notes with it)']),
  snare8s: step(['スネアの8分のシンコペーション', 'Syncopated snare 8ths']),
};

/** これより遅い曲は、刻みの8分の裏をバスドラムの8分より後に省く */
export const SLOW_BPM = 130;

/** 省く順番（速い曲・遅い曲で刻みの8分の位置だけ違う） */
export function stepOrder(slow: boolean): StepKey[] {
  const order: StepKey[] = STEP_KEYS.filter((k) => k !== 'time8');
  order.splice(order.indexOf(slow ? 'snare8p' : 'kick8p'), 0, 'time8');
  return order;
}

/** 段の数（0 はそのまま、MAX_STEPS はすべて省いた段） */
export const MAX_STEPS = STEP_KEYS.length;

/** その種類を省く段（この段から先は省いてある） */
export function rungOf(k: StepKey, slow = false): number {
  return stepOrder(slow).indexOf(k) + 1;
}

// 同時打ちで残す楽器の重み（省く順番が同じときに、大きいほど残す）
// キメ（クラッシュとバスドラム・スネア）が手で叩けないときは、作者の譜面と同じくバスドラムをスネアより残す
const PRIORITY: Record<Voice, number> = { CY: 9, BD: 8, SD: 7, TOM: 6, HH: 5, RD: 5, LP: 2 };

export interface Role {
  voice: Voice;
  metric: number;
  fill: boolean;
  /** この段（1〜）で省く。Infinity は省かない */
  step: number;
  key: StepKey | null;
  /** 必ず残す（同時打ちの上限でも省かない。手が3本になるときだけは別） */
  protect: boolean;
}

export interface RoleInput {
  notes: readonly Note[];
  fills: ReadonlyMap<number, number>;
  backbeat: ReadonlySet<number>;
  /** 小節の頭と食いのクラッシュ */
  starts: ReadonlySet<number>;
  sectionHeads: ReadonlySet<number>;
  keep: { backbeat: boolean; kick1: boolean; sectionCrash: boolean; fillLanding: boolean; openHH: boolean };
  /** 曲のおもな BPM */
  bpm: number;
}

export interface Roles {
  order: StepKey[];
  /** 段の番号（1〜） */
  at: (k: StepKey) => number;
  byId: Map<number, Role>;
}

const timeKey = (beat: number) => Math.round(beat * 960);

/** 音ごとの役割と、省く段 */
export function assignRoles(input: RoleInput): Roles {
  const { notes, fills, backbeat, starts, keep } = input;
  const order = stepOrder(input.bpm < SLOW_BPM);
  const at = (k: StepKey) => order.indexOf(k) + 1;
  const byT = new Map<number, Note[]>();
  for (const n of notes) {
    const k = timeKey(n.beat);
    let a = byT.get(k);
    if (!a) byT.set(k, (a = []));
    a.push(n);
  }
  const has = (beat: number, v: Voice) => (byT.get(timeKey(beat)) ?? []).some((x) => voiceOf(x) === v);
  const inFill = (n: Note) => {
    const f = fills.get(n.m);
    return f !== undefined && n.inBeat >= f - EPS;
  };
  // クラッシュの刻み：フィルの外で3つ以上クラッシュがある小節の、頭と食いでないクラッシュ
  const crashes = new Map<number, number>();
  for (const n of notes) if (voiceOf(n) === 'CY' && !inFill(n)) crashes.set(n.m, (crashes.get(n.m) ?? 0) + 1);
  const timeCrash = (n: Note) => voiceOf(n) === 'CY' && !starts.has(n.id) && !inFill(n) && (crashes.get(n.m) ?? 0) >= 3;
  // 裏の音のつながり：すぐ後ろの強い位置に同じ楽器があれば「つなぎ」、すぐ前の強い位置にあれば「重ね」、どちらも無ければシンコペーション
  const offbeatKind = (n: Note, v: Voice, met: number): 'link' | 'synco' => {
    const unit = met === 0 ? 0.5 : 1;
    const next = Math.ceil(n.beat / unit - EPS) * unit;
    const prev = Math.floor(n.beat / unit + EPS) * unit;
    return has(next, v) || has(prev, v) ? 'link' : 'synco';
  };

  const byId = new Map<number, Role>();
  for (const n of notes) {
    const voice = voiceOf(n);
    const metric = metricOf(n);
    const fill = inFill(n);
    const same = byT.get(timeKey(n.beat))!;
    const accents = same.filter((x) => x !== n && voiceOf(x) === 'CY' && !timeCrash(x));
    const headAccent = accents.some((x) => starts.has(x.id));
    let protect = false;
    if (keep.kick1 && voice === 'BD' && metric === 4) protect = true;
    if (keep.backbeat && voice === 'SD' && !fill && backbeat.has(n.id)) protect = true;
    if (voice === 'CY' && starts.has(n.id)) protect = true;
    if (keep.sectionCrash && voice === 'CY' && metric === 4 && input.sectionHeads.has(n.m)) protect = true;
    if (keep.fillLanding && metric === 4 && fills.has(n.m - 1) && (voice === 'CY' || voice === 'BD')) protect = true;
    // 目立つバスドラム：小節の頭・食いのクラッシュと一緒のもの
    if (voice === 'BD' && headAccent) protect = true;

    let key: StepKey | null = null;
    const kickKey = (): StepKey | null =>
      metric <= 0 ? 'kick16' : metric === 1 ? (offbeatKind(n, 'BD', metric) === 'link' ? 'kick8p' : 'kick8s') : metric === 2 ? 'kick24' : metric === 3 ? 'kick3' : keep.kick1 ? null : 'kick3';
    const timeStep = (): StepKey | null =>
      metric <= 0 ? 'time16' : metric === 1 ? (keep.openHH && voice === 'HH' && n.alt ? 'time24' : 'time8') : metric === 2 ? 'time24' : null;
    if (protect) key = null;
    else if (voice === 'LP') key = 'lp';
    else if (voice === 'CY' && !timeCrash(n)) key = 'kime';
    else if (accents.length && (voice === 'BD' || voice === 'SD' || voice === 'TOM')) key = 'kime';
    else if (fill) {
      const lastBeat = Math.max(fills.get(n.m)!, Math.ceil(n.mBeats - 1 - EPS));
      const f: StepKey | null = metric <= 0 ? 'fill16' : metric === 1 ? 'fill8' : n.inBeat < lastBeat - EPS ? 'fillEarly' : null;
      const own = voice === 'BD' ? kickKey() : voice === 'HH' || voice === 'RD' || voice === 'CY' ? timeStep() : null;
      key = f === null ? own : own === null ? f : at(own) < at(f) ? own : f;
    } else if (voice === 'BD') key = kickKey();
    else if (voice === 'SD') {
      if (metric <= 0) key = offbeatKind(n, 'SD', metric) === 'link' ? 'ghost' : 'snare16';
      else if (metric === 1) key = offbeatKind(n, 'SD', metric) === 'link' ? 'snare8p' : 'snare8s';
      else key = 'snareBeat';
    } else key = timeStep(); // 刻み（ハイハット・ライド・クラッシュの刻み）とフィルの外のタム
    byId.set(n.id, { voice, metric, fill, step: key ? at(key) : Infinity, key, protect });
  }

  // 左バスドラムと同じ時刻の右バスドラム：右へまとめる段で1つになる
  const lf = at('leftFoot');
  for (const g of byT.values()) {
    if (!g.some((x) => x.lane === 5)) continue;
    for (const x of g) {
      const r = byId.get(x.id)!;
      if (x.lane === 2 && x.alt && !r.protect && r.step > lf) (r.step = lf), (r.key = 'leftFoot');
    }
  }

  // 同時打ちは2つまで・手は2本まで：その時刻で、まず刻み（クローズのハイハット・ライド）、次に省く順番がいちばん先の音
  // （同じなら軽い楽器）を省く。キメ（クラッシュと、それに合わせた音）と必ず残す音は省かない
  // （3つ同時のまま残す。手が3本になるときだけは別）
  const ch = at('chord');
  const accent = (r: Role) => r.protect || r.key === 'kime';
  const timeKeep = (x: Note, r: Role) => (r.voice === 'HH' && !x.alt) || r.voice === 'RD';
  for (const g of byT.values()) {
    const alive = g.filter((x) => byId.get(x.id)!.step >= ch);
    if (alive.length <= 2) continue;
    const weight = (x: Note) => {
      const r = byId.get(x.id)!;
      return (r.protect ? 1e6 : 0) + (accent(r) ? 1e5 : 0) + (timeKeep(x, r) ? 0 : 1e4) + Math.min(r.step, 99) * 10 + PRIORITY[r.voice];
    };
    alive.sort((a, b) => weight(a) - weight(b));
    while (alive.length > 2) {
      const hands = alive.filter((x) => HAND_LANES.has(x.lane));
      const tooManyHands = hands.length > 2;
      const victim = tooManyHands ? hands[0] : alive[0];
      const v = byId.get(victim.id)!;
      if (!tooManyHands && accent(v)) break;
      if (v.step > ch) (v.step = ch), (v.key = 'chord');
      v.protect = false;
      alive.splice(alive.indexOf(victim), 1);
    }
  }
  return { order, at, byId };
}

/** 左バスドラムを右へまとめる段か */
export function mergesLeftFoot(roles: Roles, rung: number): boolean {
  return rung >= roles.at('leftFoot');
}

/** 段 rung まで省いた状態を、楽器ごとのことばにする */
export function describeRung(rung: number, slow = false): string {
  const order = stepOrder(slow);
  const done = new Set(order.slice(0, Math.max(0, Math.min(order.length, rung))));
  const pick = (pairs: [StepKey, string][], none: string) => {
    let out = none;
    for (const [k, s] of pairs) if (done.has(k)) out = s;
    return out;
  };
  const asIs = tr('そのまま', 'as is');
  const parts = [
    tr('刻み ', 'Hi-hat/ride ') +
      pick(
        [
          ['time16', tr('8分', '8ths')],
          ['time8', tr('4分', 'quarters')],
          ['time24', tr('1・3拍', 'beats 1 & 3')],
        ],
        asIs,
      ),
    tr('キック ', 'Kick ') +
      pick(
        [
          ['kick16', tr('8分まで', 'up to 8ths')],
          ['kick8p', tr('拍とシンコペーション', 'beats and syncopations')],
          ['kick8s', tr('拍だけ', 'beats only')],
          ['kick24', tr('1・3拍', 'beats 1 & 3')],
          ['kick3', tr('1拍目', 'beat 1')],
        ],
        asIs,
      ),
    tr('スネア ', 'Snare ') +
      pick(
        [
          ['ghost', tr('ゴーストなし', 'no ghost notes')],
          ['snare16', tr('8分まで', 'up to 8ths')],
          ['snare8p', tr('拍とシンコペーション', 'beats and syncopations')],
          ['snareBeat', tr('2・4拍とシンコペーション', 'beats 2 & 4 and syncopations')],
          ['snare8s', tr('2・4拍', 'beats 2 & 4')],
        ],
        asIs,
      ),
    tr('フィル ', 'Fills ') +
      pick(
        [
          ['fill16', tr('8分', '8ths')],
          ['fill8', tr('4分', 'quarters')],
          ['fillEarly', tr('最後の拍だけ', 'last beat only')],
        ],
        asIs,
      ),
  ];
  if (done.has('kime')) parts.push(tr('キメは頭と食いだけ', 'accents only on downbeats and pushes'));
  if (done.has('leftFoot')) parts.push(tr('左バスは右へ', 'left kick moved to the right'));
  else if (done.has('lp')) parts.push(tr('左ペダルなし', 'no left pedal'));
  if (done.has('chord')) parts.push(tr('同時 2 まで', 'up to 2 at once'));
  return parts.join(tr('・', ' · '));
}

/**
 * セクションの役割（0: 静か、1: ふつう、2: 山場）。段のあいだの調整（ease）は、静かなセクションから次の段を先に当てる。
 * 役割は方針（作者の指示を受けた AI）の shift の向きだけで決める。役割が無ければ、どのセクションも同じ（曲全体で同じ扱い）
 */
export function sectionRoles(sections: readonly { from: number; to: number; shift: number }[]): { group: (m: number) => 0 | 1 | 2; hasRoles: boolean } {
  const hasRoles = sections.some((s) => s.shift !== 0);
  if (!hasRoles) return { group: () => 1, hasRoles };
  return {
    hasRoles,
    group: (m) => {
      const s = sections.find((x) => m >= x.from && m <= x.to);
      return !s || s.shift === 0 ? 1 : s.shift > 0 ? 0 : 2;
    },
  };
}

/** 段のあいだの調整の最大（静か・ふつうの2つ。3つめまで当てると次の段と同じ） */
export const MAX_EASE = 2;

