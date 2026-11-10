// 曲のもの（曲情報・テンポ）は、どの難易度でも同じにする。DTX では難易度ごとの譜面に書くので、開いている難易度だけを
// 書き換えると分かれてしまう（選曲画面で難易度を替えると曲名や試聴が変わる・難易度でテンポや原曲の位置がずれる）。
// - editSong で変えると、変える前に同じだった、ほかの難易度の譜面（と保存していない続き）にも入れる（store/siblings）。
//   前から違う難易度はそのまま（わざと変えてある譜面を壊さない。原曲の songBgm と同じ決め方）。
//   Ctrl+Z・やり直す・知らせの「元に戻す」で一緒に戻り、知らせの「この難易度だけにする」でほかの難易度だけ戻せる
// - 曲情報（#TITLE・#ARTIST・#PREVIEW・#PREIMAGE など）は欄ごとに、テンポ（小節の長さ・BPM の流れ・原曲の位置）はまとめて比べる
// - 前から分かれている曲は、曲情報の画面・テンポの画面に出し、開いている難易度にそろえる（alignSongFields・alignTempo）
import type { Draft } from 'immer';
import { create } from 'zustand';
import { isJa, tr } from '../i18n';
import type { Frac } from '../dtx/fraction';
import { CH, type DtxDoc } from '../dtx/model';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { setField, type Pos } from '../edit/ops';
import type { SongFolder } from '../fs/folder';
import { confirmDialog } from '../ui/dialogs';
import { tempoOf } from './derived';
import { bpmChangeLabel, bpmChangeRecipe, edit, lastHistory, prepareSounds, recordSide, toast, undoIfLast, updateToast, useEditor, type HistoryEntry, type Toast } from './editor';
import { glowReflected } from './glow';
import { otherCharts, readChart, siblingWrites, startSiblingChange, useSiblingWrites, type SiblingChange, type SiblingReport, type Verdict } from './siblings';

// ---- 曲情報 -----------------------------------------------------------------------

/** 曲のもの（どの難易度でも同じにする）曲情報の欄。レベル（#DLEVEL・#HIDDENLEVEL）と #PATH_WAV は譜面ごと、#BPM はテンポで扱う */
export const SONG_FIELDS = ['TITLE', 'ARTIST', 'GENRE', 'COMMENT', 'PANEL', 'PREVIEW', 'PREIMAGE', 'PREMOVIE', 'STAGEFILE', 'BACKGROUND', 'RESULTIMAGE'] as const;

export const isSongField = (key: string) => (SONG_FIELDS as readonly string[]).includes(key.toUpperCase());

/** 比べるときの値（無い・空・前後の空白は同じ） */
const norm = (v: string | undefined) => (v ?? '').trim();

/** 知らせに出す欄の名前 */
export function songFieldLabel(key: string): string {
  switch (key) {
    case 'TITLE':
      return tr('曲名', 'title');
    case 'ARTIST':
      return tr('アーティスト', 'artist');
    case 'GENRE':
      return tr('ジャンル', 'genre');
    case 'COMMENT':
      return tr('コメント', 'comment');
    case 'PANEL':
      return tr('パネル', 'panel text');
    case 'PREVIEW':
      return tr('試聴（#PREVIEW）', 'preview (#PREVIEW)');
    case 'PREIMAGE':
      return tr('選曲画面の画像（#PREIMAGE）', 'song select image (#PREIMAGE)');
    case 'PREMOVIE':
      return tr('選曲画面の動画（#PREMOVIE）', 'song select movie (#PREMOVIE)');
    case 'STAGEFILE':
      return tr('読み込み中の画像（#STAGEFILE）', 'loading image (#STAGEFILE)');
    case 'BACKGROUND':
      return tr('演奏中の背景（#BACKGROUND）', 'background (#BACKGROUND)');
    case 'RESULTIMAGE':
      return tr('結果画面の画像（#RESULTIMAGE）', 'result screen image (#RESULTIMAGE)');
    default:
      return `#${key}`;
  }
}

const sep = () => tr('・', ', ');

/** 変えたもの（知らせの「〇〇も同じにしました」の〇〇） */
function whatOf(fields: readonly string[], tempo: boolean): string {
  const parts = fields.length > 3 ? [tr('曲情報', 'song info')] : fields.map(songFieldLabel);
  if (tempo) parts.push(tempoWhat());
  return parts.join(sep());
}

const tempoWhat = () => tr('テンポ', 'tempo');

// ---- テンポ -----------------------------------------------------------------------

/** テンポの中身（比べる用）：小節の長さ・BPM の流れ・原曲（BGM チップ）の位置 */
export interface TempoSig {
  /** 小節の長さが変わる所（「小節:長さ」。同じ長さを書き直しただけの所は数えない） */
  bars: string;
  /** BPM の流れ（同じ BPM が続く所はまとめる） */
  steps: { beat: number; bpm: number }[];
  /** 原曲のチップの位置（「小節|分数」を並べたもの） */
  bgm: string[];
}

/** 譜面のテンポの中身（書き換える譜面にも使うので、覚えておかない） */
export function tempoSig(doc: DtxDoc, tempo: TempoMap = buildTempoMap(doc)): TempoSig {
  const t = tempo;
  const keys = Object.keys(doc.barLengths)
    .map(Number)
    .sort((a, b) => a - b);
  const bars: string[] = [];
  let cur = 1;
  for (const m of keys) {
    const bl = doc.barLengths[m];
    if (!(bl > 0) || bl === cur) continue;
    cur = bl;
    bars.push(`${m}:${bl}`);
  }
  const steps: { beat: number; bpm: number }[] = [];
  for (const e of t.events) {
    const last = steps[steps.length - 1];
    if (last && Math.abs(last.bpm - e.bpm) < 0.0005) continue;
    steps.push({ beat: e.beat, bpm: e.bpm });
  }
  const bgm = doc.chips
    .filter((c) => c.ch === CH.BGM)
    .map((c) => `${c.m}|${c.f.n}/${c.f.d}`)
    .sort();
  return { bars: bars.join(','), steps, bgm };
}

const sigMemo = new WeakMap<DtxDoc, TempoSig>();

/** 開いている譜面（書き換えない譜面）のテンポの中身。覚えておく */
function docSig(doc: DtxDoc): TempoSig {
  let sig = sigMemo.get(doc);
  if (!sig) sigMemo.set(doc, (sig = tempoSig(doc, tempoOf(doc))));
  return sig;
}

/** テンポの中身が同じか（BPM は 0.0005 まで同じとみなす） */
export function sameTempo(a: TempoSig, b: TempoSig): boolean {
  if (a.bars !== b.bars || a.steps.length !== b.steps.length || a.bgm.length !== b.bgm.length) return false;
  if (a.bgm.some((x, i) => x !== b.bgm[i])) return false;
  return a.steps.every((s, i) => Math.abs(s.beat - b.steps[i].beat) < 1e-6 && Math.abs(s.bpm - b.steps[i].bpm) < 0.0005);
}

/** BPM を書く定義（#BPM・#BASEBPM・#BPMxx） */
const TEMPO_FIELD = /^(BPM|BASEBPM|BPM[0-9A-Z]{2})$/;
const isBpmChip = (ch: number) => ch === CH.BPM || ch === CH.BPM_EX;

interface RepChip {
  m: number;
  ch: number;
  f: Frac;
  v: number;
}

/** テンポの書き方（そのまま写す・戻す用）：BPM の定義、BPM のチップ（ch03・ch08）、原曲のチップ（ch01） */
export interface TempoRep {
  fields: Record<string, string>;
  chips: RepChip[];
}

const chipKey = (c: RepChip) => `${c.m}|${c.ch}|${c.f.n}/${c.f.d}|${c.v}`;

function tempoRep(doc: DtxDoc): TempoRep {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.fields)) if (TEMPO_FIELD.test(k)) fields[k] = v;
  const chips = doc.chips.filter((c) => isBpmChip(c.ch) || c.ch === CH.BGM).map((c) => ({ m: c.m, ch: c.ch, f: c.f, v: c.v }));
  return { fields, chips };
}

function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function sameChips(a: readonly RepChip[], b: readonly RepChip[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map(chipKey).sort();
  const y = b.map(chipKey).sort();
  return x.every((k, i) => k === y[i]);
}

function sameRep(a: TempoRep, b: TempoRep): boolean {
  return sameFields(a.fields, b.fields) && sameChips(a.chips, b.chips);
}

/** BPM の定義と BPM のチップを fields・chips のものにする（原曲のチップには触らない） */
function putBpm(d: DtxDoc, fields: Record<string, string>, chips: readonly RepChip[]) {
  for (const k of new Set([...Object.keys(d.fields).filter((k) => TEMPO_FIELD.test(k)), ...Object.keys(fields)])) {
    if (d.fields[k] !== fields[k]) setField(d as Draft<DtxDoc>, k, fields[k]);
  }
  d.chips = d.chips.filter((c) => !isBpmChip(c.ch));
  for (const c of chips) if (isBpmChip(c.ch)) d.chips.push({ id: d.nextId++, m: c.m, ch: c.ch, f: c.f, v: c.v });
}

/** テンポの書き方を rep にする（元に戻す・やり直す） */
function putRep(d: DtxDoc, rep: TempoRep) {
  putBpm(d, rep.fields, rep.chips);
  d.chips = d.chips.filter((c) => c.ch !== CH.BGM);
  for (const c of rep.chips) if (c.ch === CH.BGM) d.chips.push({ id: d.nextId++, m: c.m, ch: c.ch, f: c.f, v: c.v });
}

const byPos = (a: { m: number; f: Frac }, b: { m: number; f: Frac }) => a.m - b.m || a.f.n * b.f.d - b.f.n * a.f.d;

/**
 * 開いている譜面のテンポの変更（before → after）を、テンポが before と同じだった譜面 d にも入れる。
 * BPM の書き方が変わっていれば after の BPM の定義とチップを写し、原曲のチップが動いていれば同じ所へ動かす
 * （d の原曲のチップの WAV 番号はそのまま）。入れられなければ false
 */
function copyTempo(d: DtxDoc, before: DtxDoc, after: DtxDoc): boolean {
  const rb = tempoRep(before);
  const ra = tempoRep(after);
  const bpmOnly = (r: TempoRep) => r.chips.filter((c) => isBpmChip(c.ch));
  if (!sameFields(rb.fields, ra.fields) || !sameChips(bpmOnly(rb), bpmOnly(ra))) putBpm(d, ra.fields, ra.chips);
  // 原曲のチップ：開いている譜面で同じチップ（id）がどこへ動いたかを、並びの同じ d のチップに当てる
  const from = before.chips.filter((c) => c.ch === CH.BGM).sort((a, b) => byPos(a, b) || a.id - b.id);
  const to = new Map(after.chips.filter((c) => c.ch === CH.BGM).map((c) => [c.id, c]));
  if (from.length !== to.size) return false;
  if (from.every((c) => to.get(c.id)?.m === c.m && byPos(c, to.get(c.id)!) === 0)) return true;
  const mine = d.chips.filter((c) => c.ch === CH.BGM).sort(byPos);
  if (mine.length !== from.length) return false;
  for (let i = 0; i < mine.length; i++) {
    const moved = to.get(from[i].id);
    if (!moved) return false;
    mine[i].m = moved.m;
    mine[i].f = moved.f;
  }
  return true;
}

// ---- ほかの難易度に入れる ------------------------------------------------------------

/** 曲情報の欄ごとの、書き換える前と後（元に戻す用） */
type FieldUndo = Record<string, { pre: string | undefined; post: string | undefined }>;

interface SongUndo {
  fields?: FieldUndo;
  tempo?: { pre: TempoRep; post: TempoRep };
}

/** 答えをまとめる（書けない > 変えた > 前から違う > 同じ） */
function worst(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { same: 0, kept: 1, changed: 2, failed: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/** 曲情報の欄 keys を to の値にする。before があれば、今の値が before の値の欄だけ（違えば前から違う） */
function applyFields(d: DtxDoc, keys: readonly string[], to: Record<string, string>, before: Record<string, string> | null): { verdict: Verdict; undo: FieldUndo } {
  const undo: FieldUndo = {};
  let verdict: Verdict = 'same';
  for (const k of keys) {
    const cur = norm(d.fields[k]);
    if (cur === norm(to[k])) continue;
    if (before && cur !== norm(before[k])) {
      verdict = worst(verdict, 'kept');
      continue;
    }
    undo[k] = { pre: d.fields[k], post: to[k] };
    setField(d as Draft<DtxDoc>, k, to[k]);
    verdict = 'changed';
  }
  return { verdict, undo };
}

function revertSong(d: DtxDoc, u: SongUndo): boolean {
  let changed = false;
  for (const [k, x] of Object.entries(u.fields ?? {})) {
    if (norm(d.fields[k]) !== norm(x.post)) continue;
    setField(d as Draft<DtxDoc>, k, x.pre);
    changed = true;
  }
  if (u.tempo && sameRep(tempoRep(d), u.tempo.post)) {
    putRep(d, u.tempo.pre);
    changed = true;
  }
  return changed;
}

function reapplySong(d: DtxDoc, u: SongUndo): SongUndo | null {
  let changed = false;
  for (const [k, x] of Object.entries(u.fields ?? {})) {
    if (norm(d.fields[k]) !== norm(x.pre)) continue;
    setField(d as Draft<DtxDoc>, k, x.post);
    changed = true;
  }
  if (u.tempo && sameRep(tempoRep(d), u.tempo.pre)) {
    putRep(d, u.tempo.post);
    changed = true;
  }
  return changed ? u : null;
}

/** 開いている譜面の変更（before → after）の、曲情報の欄 fields とテンポを、ほかの難易度にも入れ始める */
function startSongChange(folder: SongFolder, current: string, before: DtxDoc, after: DtxDoc, fields: readonly string[], tempo: boolean): SiblingChange {
  const beforeSig = docSig(before);
  const afterSig = docSig(after);
  return startSiblingChange<SongUndo>(folder, current, {
    apply: (d) => {
      const undo: SongUndo = {};
      let verdict: Verdict = 'same';
      if (fields.length) {
        const r = applyFields(d, fields, after.fields, before.fields);
        verdict = worst(verdict, r.verdict);
        if (r.verdict === 'changed') undo.fields = r.undo;
      }
      if (tempo) {
        const sig = tempoSig(d);
        if (!sameTempo(sig, afterSig)) {
          if (!sameTempo(sig, beforeSig)) verdict = worst(verdict, 'kept');
          else {
            const pre = tempoRep(d);
            // 入れたあとのテンポが開いている譜面と同じにならなければ、この譜面には書かない
            if (!copyTempo(d, before, after) || !sameTempo(tempoSig(d), afterSig)) return 'failed';
            undo.tempo = { pre, post: tempoRep(d) };
            verdict = 'changed';
          }
        }
      }
      return verdict === 'changed' ? { undo } : verdict;
    },
    revert: revertSong,
    reapply: reapplySong,
  });
}

export interface SongEdit {
  /** 開いている譜面を変えた */
  ok: boolean;
  /** 積んだ履歴（知らせの「元に戻す」に使う） */
  entry?: HistoryEntry;
  /** ほかの難易度の書き換え（曲のものを変えていなければ null） */
  siblings: SiblingChange | null;
  /** 変えた曲情報の欄 */
  fields: string[];
  /** テンポ（小節の長さ・BPM の流れ・原曲の位置）を変えた */
  tempo: boolean;
}

/**
 * 開いている譜面を変える（edit と同じ。Ctrl+Z で戻せる）。曲のもの（曲情報の欄・テンポ）が変わったら、
 * 変える前に同じだったほかの難易度の譜面にも入れる（Ctrl+Z・やり直すで一緒に戻す・また入れる）。
 * side は譜面の外（作業ファイルのアンカーなど）を一緒に戻すためのもの
 */
export function editSong(label: string, recipe: (d: Draft<DtxDoc>) => void, opts: { side?: HistoryEntry['side'] } = {}): SongEdit {
  const s = useEditor.getState();
  const folder = s.folder;
  const before = s.doc;
  let change: SiblingChange | null = null;
  const own = opts.side;
  const side =
    folder || own
      ? {
          undo: () => {
            own?.undo();
            void change?.revert();
          },
          redo: () => {
            own?.redo();
            void change?.reapply();
          },
        }
      : undefined;
  const ok = edit(label, recipe, side ? { side } : {});
  if (!ok) return { ok, siblings: null, fields: [], tempo: false };
  const entry = lastHistory();
  const after = useEditor.getState().doc;
  const fields = SONG_FIELDS.filter((k) => norm(before.fields[k]) !== norm(after.fields[k]));
  const tempo = !sameTempo(docSig(before), docSig(after));
  if (!folder || (!fields.length && !tempo)) return { ok, entry, siblings: null, fields, tempo };
  change = startSongChange(folder, s.meta.fileName, before, after, fields, tempo);
  return { ok, entry, siblings: change, fields, tempo };
}

/** 知らせに足す、ほかの難易度のこと（what: 「曲名」など。無ければ「入れました」）。何も無ければ [] */
export function songNoteParts(rep: SiblingReport | null | undefined, what?: string): string[] {
  if (!rep) return [];
  const out: string[] = [];
  const s = sep();
  if (rep.changed.length)
    out.push(
      what
        ? tr(`ほかの難易度（${rep.changed.join(s)}）の${what}も同じにしました`, `The other difficulties (${rep.changed.join(s)}) got the same ${what}`)
        : tr(`ほかの難易度（${rep.changed.join(s)}）にも入れました`, `Also applied to the other difficulties (${rep.changed.join(s)})`),
    );
  if (rep.kept.length) {
    const they = rep.kept.length === 1 ? 'it was' : 'they were';
    out.push(
      what
        ? tr(`${rep.kept.join(s)} は前から${what}が違うので、そのままにしました`, `${rep.kept.join(s)} already had a different ${what}, so ${they} left as is`)
        : tr(`${rep.kept.join(s)} は前から違うので、そのままにしました`, `${rep.kept.join(s)} already differed, so ${they} left as is`),
    );
  }
  if (rep.failed.length) out.push(tr(`${rep.failed.join(s)} の譜面は書き換えられませんでした`, `Couldn't update the chart of ${rep.failed.join(s)}`));
  return out;
}

/** 文をつなぐ（日本語は「。」、英語は「. 」） */
export function joinSentences(parts: readonly string[]): string {
  return parts.filter(Boolean).join(isJa() ? '。' : '. ');
}

/** 知らせの文のうしろに足す、ほかの難易度のこと（「。」から始まる。何も無ければ ''） */
export function songSiblingNote(rep: SiblingReport | null | undefined, what?: string): string {
  const parts = songNoteParts(rep, what);
  return parts.length ? (isJa() ? '。' : '. ') + joinSentences(parts) : '';
}

/** 知らせのボタン「この難易度だけにする」：ほかの難易度だけ元に戻す */
export function onlyThisAction(change: SiblingChange): NonNullable<Toast['action']> {
  return {
    label: tr('この難易度だけにする', 'Only this difficulty'),
    run: () =>
      void change.detach().then((rep) => {
        toast(
          rep.changed.length
            ? tr(`ほかの難易度（${rep.changed.join(sep())}）は元に戻しました。変えたのはこの難易度だけです`, `Put the other difficulties (${rep.changed.join(sep())}) back. Only this difficulty is changed`)
            : tr('ほかの難易度は、そのあと変わっていたので戻していません', 'The other difficulties changed after that, so they were not put back'),
          rep.changed.length ? 'ok' : 'warn',
          6000,
        );
      }),
  };
}

/**
 * editSong のあとの知らせ。text はすぐ出し、ほかの難易度に入れ終わったら、そのこと（「曲名も同じにしました」・前から違うのでそのまま・
 * 書けない。what は「曲名」など。無ければ変えた欄・テンポから決める）を足す（text が無ければ、そのことだけを出す）。ほかの難易度に入れたら「この難易度だけにする」も出し、難易度のタブを光らせる。
 * 入れ終わる前に知らせを閉じた（「元に戻す」を押した）ときは、足さない
 */
export async function toastSongEdit(r: SongEdit, text: string | null, level: Toast['level'] = 'ok', ms = 6000, action?: Toast['action'], what?: string): Promise<void> {
  const id = text ? toast(text, level, ms, action) : null;
  if (!r.siblings) return;
  const change = r.siblings;
  const rep = await change.done;
  if (rep.files.length) glowReflected({ diffs: rep.files });
  const notes = songNoteParts(rep, what ?? whatOf(r.fields, r.tempo));
  if (!notes.length) return;
  const patch = {
    text: joinSentences([text ?? '', ...notes]),
    level: rep.failed.length ? ('warn' as const) : level,
    action2: rep.changed.length && !change.detached ? onlyThisAction(change) : undefined,
  };
  if (id === null) toast(patch.text, patch.level, Math.max(ms, 9000), action, patch.action2);
  else updateToast(id, patch, Math.max(ms, 9000));
}

/**
 * ヘッダの欄を変える（setFieldValue と同じ）。曲のもの（曲名・試聴・画像・BPM など）なら、同じだったほかの難易度にも入れて知らせる
 */
export function setSongField(key: string, value: string | undefined, label = tr(`#${key} を変更`, `Change #${key}`)): boolean {
  const r = editSong(label, (d) => setField(d, key, value));
  if (/^(WAV|VOLUME|PAN|WAVVOL|WAVPAN)[0-9A-Z]{2}$|^PATH_WAV$/i.test(key)) void prepareSounds();
  if (r.siblings) void toastSongEdit(r, null);
  return r.ok;
}

/** BPM 変化を置く・値を変える。テンポは曲のものなので、同じテンポだったほかの難易度にも入れて知らせる */
export function placeSongBpm(pos: Pos, bpm: number): boolean {
  const r = editSong(bpmChangeLabel(bpm), bpmChangeRecipe(pos, bpm));
  if (r.siblings) void toastSongEdit(r, null);
  return r.ok;
}

// ---- 分かれた曲を見つける・そろえる ------------------------------------------------------

/** ほかの難易度の曲のもの（読んだ譜面のもの。保存していない続きがあればそちら） */
export interface ChartSong {
  file: string;
  label: string;
  /** 曲情報の欄の値（比べる値） */
  fields: Record<string, string>;
  tempo: TempoSig;
  /** 曲頭の BPM・途中の BPM の変化の数・原曲を鳴らし始める秒（無ければ null） */
  bpm: number;
  changes: number;
  bgmSec: number | null;
}

interface SongSyncState {
  /** 読んだときに開いていた曲と難易度 */
  folder: SongFolder | null;
  fileName: string;
  others: ChartSong[];
}

export const useSongSync = create<SongSyncState>(() => ({ folder: null, fileName: '', others: [] }));

/** 譜面の曲のもの（比べる・見せる用） */
function chartSong(doc: DtxDoc, file: string, label: string, tempo = buildTempoMap(doc)): ChartSong {
  const fields: Record<string, string> = {};
  for (const k of SONG_FIELDS) fields[k] = norm(doc.fields[k]);
  const sig = tempoSig(doc, tempo);
  const bgm = doc.chips.filter((c) => c.ch === CH.BGM).sort(byPos)[0];
  return { file, label, fields, tempo: sig, bpm: sig.steps[0]?.bpm ?? tempo.initialBpm, changes: Math.max(0, sig.steps.length - 1), bgmSec: bgm ? tempo.beatToSec(tempo.beatOf(bgm.m, bgm.f)) : null };
}

let scanSeq = 0;

/** ほかの難易度の曲情報・テンポを読み直す（曲・難易度を開いた・難易度が増えた・ほかの難易度を書き換えた） */
export async function refreshSongSync(): Promise<void> {
  const seq = ++scanSeq;
  const s = useEditor.getState();
  const folder = s.folder;
  const fileName = s.meta.fileName;
  if (!folder || s.screen !== 'editor') {
    if (useSongSync.getState().folder) useSongSync.setState({ folder: null, fileName: '', others: [] });
    return;
  }
  await siblingWrites();
  const others: ChartSong[] = [];
  for (const t of await otherCharts(folder, fileName)) {
    // 読めない譜面は数えない
    const doc = await readChart(folder, t.file);
    if (doc) others.push(chartSong(doc, t.file.name, t.label));
  }
  const now = useEditor.getState();
  if (seq !== scanSeq || now.folder !== folder || now.meta.fileName !== fileName) return;
  useSongSync.setState({ folder, fileName, others });
}

let scanTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void refreshSongSync(), 30);
}

// 曲・難易度を開いた・難易度のタブが変わった（保存・AI難易度生成の反映）・ほかの難易度を書き換えたら読み直す
useEditor.subscribe((s, prev) => {
  if (s.folder !== prev.folder || s.meta.fileName !== prev.meta.fileName || s.meta.siblings !== prev.meta.siblings || (s.screen === 'editor') !== (prev.screen === 'editor')) scheduleScan();
});
useSiblingWrites.subscribe(() => scheduleScan());

/** 読んであるほかの難易度（今の曲・難易度のものだけ。まだ読んでいなければ []） */
function currentOthers(st = useSongSync.getState()): ChartSong[] {
  const s = useEditor.getState();
  if (!s.folder || st.folder !== s.folder || st.fileName !== s.meta.fileName) return [];
  return st.others;
}

/** 画面用：読んであるほかの難易度（今の曲・難易度のもの） */
export function useOtherDiffs(): ChartSong[] {
  useEditor((s) => s.folder);
  useEditor((s) => s.meta);
  return currentOthers(useSongSync());
}

/** 難易度によって値が違う曲情報の欄 */
export interface FieldSplit {
  key: string;
  /** 開いている難易度の値 */
  here: string;
  /** 違う値の難易度 */
  others: { label: string; value: string }[];
}

export function songFieldSplits(st = useSongSync.getState()): FieldSplit[] {
  const others = currentOthers(st);
  if (!others.length) return [];
  const doc = useEditor.getState().doc;
  const out: FieldSplit[] = [];
  for (const k of SONG_FIELDS) {
    const here = norm(doc.fields[k]);
    const diff = others.filter((o) => o.fields[k] !== here).map((o) => ({ label: o.label, value: o.fields[k] }));
    if (diff.length) out.push({ key: k, here, others: diff });
  }
  return out;
}

/** 画面用（開いている譜面が変われば計算し直す） */
export function useSongFieldSplits(): FieldSplit[] {
  useEditor((s) => s.doc);
  useEditor((s) => s.folder);
  useEditor((s) => s.meta);
  return songFieldSplits(useSongSync());
}

/** テンポ（小節の長さ・BPM の流れ・原曲の位置）が開いている難易度と違う難易度。bars: 小節の長さ（拍子）から違う */
export interface TempoSplit extends ChartSong {
  bars: boolean;
}

export function tempoSplits(st = useSongSync.getState()): TempoSplit[] {
  const others = currentOthers(st);
  if (!others.length) return [];
  const doc = useEditor.getState().doc;
  const here = docSig(doc);
  return others.filter((o) => !sameTempo(o.tempo, here)).map((o) => ({ ...o, bars: o.tempo.bars !== here.bars }));
}

export function useTempoSplits(): TempoSplit[] {
  useEditor((s) => s.doc);
  useEditor((s) => s.folder);
  useEditor((s) => s.meta);
  return tempoSplits(useSongSync());
}

/** 開いている難易度のラベル */
function hereLabel(): string {
  const s = useEditor.getState();
  return s.meta.siblings.find((x) => x.file.toLowerCase() === s.meta.fileName.toLowerCase())?.label ?? s.meta.fileName.replace(/\.dtx$/i, '');
}

/** ほかの難易度だけを書き換えた変更を履歴に積み、知らせる（開いている譜面は変えない） */
async function finishAlign(change: SiblingChange, label: string, what: string): Promise<boolean> {
  const entry = recordSide(label, { undo: () => void change.revert(), redo: () => void change.reapply() });
  const rep = await change.done;
  if (rep.files.length) glowReflected({ diffs: rep.files });
  if (!rep.changed.length) {
    // 何も変えなかった履歴は残さない（Ctrl+Z を押しても何も起きないので）
    if (lastHistory() === entry) useEditor.setState((s) => ({ past: s.past.filter((h) => h !== entry) }));
    toast(rep.failed.length ? tr(`${rep.failed.join(sep())} の譜面は書き換えられませんでした`, `Couldn't update the chart of ${rep.failed.join(sep())}`) : tr(`${what}はもうそろっています`, `The ${what} already match`), rep.failed.length ? 'warn' : 'info', 7000);
    return false;
  }
  toast(
    joinSentences([
      tr(`${rep.changed.join(sep())} の${what}を ${hereLabel()} と同じにしました`, `${rep.changed.join(sep())} now ${rep.changed.length === 1 ? 'has' : 'have'} the same ${what} as ${hereLabel()}`),
      rep.failed.length ? tr(`${rep.failed.join(sep())} の譜面は書き換えられませんでした`, `Couldn't update the chart of ${rep.failed.join(sep())}`) : '',
    ]),
    rep.failed.length ? 'warn' : 'ok',
    9000,
    { label: tr('元に戻す', 'Undo'), run: () => void undoIfLast(entry) },
  );
  return true;
}

/** 難易度によって違う曲情報の欄を、開いている難易度の値にそろえる（ほかの難易度の譜面だけ書き換える。Ctrl+Z で戻せる） */
export async function alignSongFields(): Promise<boolean> {
  const s = useEditor.getState();
  const folder = s.folder;
  const splits = songFieldSplits();
  if (!folder || !splits.length) return false;
  const keys = splits.map((x) => x.key);
  const here = { ...s.doc.fields };
  const change = startSiblingChange<SongUndo>(folder, s.meta.fileName, {
    apply: (d) => {
      const r = applyFields(d, keys, here, null);
      return r.verdict === 'changed' ? { undo: { fields: r.undo } } : r.verdict;
    },
    revert: revertSong,
    reapply: reapplySong,
  });
  return finishAlign(change, tr('曲情報をほかの難易度とそろえる', 'Match song info across difficulties'), tr('曲情報', 'song info'));
}

/**
 * テンポを、開いている難易度にそろえる：BPM の定義とチップを写し、原曲のチップを同じ所へ動かす（原曲のファイル・音量はそのまま）。
 * 小節の長さ（拍子）が違う難易度はそろえない。チップは小節の中の位置のままなので、わざとテンポを変えてある譜面ではずれる。先に確かめる
 */
export async function alignTempo(): Promise<boolean> {
  const s = useEditor.getState();
  const folder = s.folder;
  const splits = tempoSplits();
  if (!folder || !splits.length) return false;
  const ok = splits.filter((x) => !x.bars);
  const bars = splits.filter((x) => x.bars);
  const yes = await confirmDialog({
    title: tr('ほかの難易度のテンポを、この難易度にそろえますか？', 'Match the other difficulties’ tempo to this one?'),
    body: joinSentences([
      ok.length
        ? tr(
            `${ok.map((x) => x.label).join(sep())} の BPM と原曲（BGM）を鳴らし始める位置を、${hereLabel()} と同じにします。チップは小節の中の位置のままなので、わざとテンポを変えてある譜面（倍・半分の BPM で書いた譜面など）ではずれます。Ctrl+Z で戻せます`,
            `The BPM and where the original (BGM) starts in ${ok.map((x) => x.label).join(', ')} become the same as in ${hereLabel()}. Chips keep their place in each measure, so a chart written at a different tempo on purpose (double or half BPM, etc.) goes out of time. Ctrl+Z undoes it`,
          )
        : '',
      bars.length
        ? tr(`${bars.map((x) => x.label).join(sep())} は小節の長さ（拍子）が違うので、そろえません`, `${bars.map((x) => x.label).join(', ')} ${bars.length === 1 ? 'has' : 'have'} different measure lengths (meter), so ${bars.length === 1 ? 'it is' : 'they are'} not changed`)
        : '',
    ]),
    ok: tr('そろえる', 'Match'),
  });
  const now = useEditor.getState();
  if (!yes || !ok.length || now.folder !== folder || now.meta.fileName !== s.meta.fileName) return false;
  const doc = now.doc;
  const here = tempoRep(doc);
  const hereSig = docSig(doc);
  const hereBgm = doc.chips.filter((c) => c.ch === CH.BGM).sort(byPos);
  const change = startSiblingChange<SongUndo>(folder, s.meta.fileName, {
    apply: (d) => {
      const sig = tempoSig(d);
      if (sameTempo(sig, hereSig)) return 'same';
      if (sig.bars !== hereSig.bars) return 'kept';
      const pre = tempoRep(d);
      putBpm(d, here.fields, here.chips);
      // 原曲のチップ：数が同じなら並びの順に同じ所へ、違えば最初のチップだけ（原曲の無い譜面には置かない）
      const mine = d.chips.filter((c) => c.ch === CH.BGM).sort(byPos);
      if (mine.length && hereBgm.length) {
        const n = mine.length === hereBgm.length ? mine.length : 1;
        for (let i = 0; i < n; i++) {
          mine[i].m = hereBgm[i].m;
          mine[i].f = hereBgm[i].f;
        }
      }
      const got = tempoSig(d);
      const bpmSame = got.steps.length === hereSig.steps.length && got.steps.every((x, i) => Math.abs(x.beat - hereSig.steps[i].beat) < 1e-6 && Math.abs(x.bpm - hereSig.steps[i].bpm) < 0.0005);
      if (!bpmSame) return 'failed';
      return { undo: { tempo: { pre, post: tempoRep(d) } } };
    },
    revert: revertSong,
    reapply: reapplySong,
  });
  return finishAlign(change, tr('テンポをほかの難易度とそろえる', 'Match tempo across difficulties'), tr('テンポ', 'tempo'));
}

