// 特殊ノーツ（クラップ・タンバリンなど）の操作：置く・このチップを自動で鳴らす・特殊ノーツにする・行き先を変える・
// 種類を足す・やめる、開いたときのお知らせ、設定の画面の開け閉め。種類の一覧と見せ方は store/specialLayout。
// 譜面は DTX のまま：チップは行き先のレーンのチャンネル（自動で鳴らすときは SE のチャンネル）に置き、種類は鳴らす音（#WAV のラベル）で決まる。
import { tr, pl, isJa } from '../i18n';
import { create } from 'zustand';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { cmp, type Frac } from '../dtx/fraction';
import { DRUM_LANES, drumChannel, isSeChannel, laneVoice, voiceName, type Chip, type DtxDoc } from '../dtx/model';
import { codeFor, kindLabel, kindName, kindOfSound, labelFor, presetById, SPECIAL_COLORS, SPECIAL_PRESETS } from '../dtx/kinds';
import { addKindWav, findKindWav, kindWavFor } from '../edit/kinds';
import { conflictKey, opPlace, type Pos } from '../edit/ops';
import { quantizeVel, velOfWav, wavVariant } from '../edit/velocity';
import { setKindLearned, setKindRouter } from '../input/midi';
import { keyLabel, useInputSettings } from '../input/settings';
import { chooseDialog, confirmDialog, promptDialog } from '../ui/dialogs';
import { openPanelT, useDevice } from './device';
import { chipViews } from './derived';
import { currentKitFile, edit, prepareSounds, previewWav, setView, toast, useEditor, wavForVoice } from './editor';
import { setSpecialSide, useSidecar, type SpecialDef, type SpecialSide } from './sidecar';
import { destName, SE_CHANNELS, setSpecialColsDefault, specialDef, specialKind, specialKinds, specialLayout, type SpecialKind } from './specialLayout';
import { placeVel } from './velocity';

// ---- 見せ方の初め -------------------------------------------------------------------------

// PC は種類ごとの列、iPad・スマホは行き先のレーンに重ねる（幅が足りないので）
setSpecialColsDefault(() => {
  const d = useDevice.getState();
  return !d.tablet && !d.phone;
});

// ---- 設定の画面 ---------------------------------------------------------------------------

export interface SpecialUi {
  /** 種類の設定（見出し・左のキットの行から開く）。x・y は画面の座標 */
  pop: { id: string; x: number; y: number } | null;
  /** 左のキットの「特殊ノーツ」の所まで動かす合図（お知らせの「設定を開く」） */
  focus: number;
}

export const useSpecialUi = create<SpecialUi>(() => ({ pop: null, focus: 0 }));

/** 種類の設定を開く（x・y は画面の座標。省くと画面の真ん中あたり） */
export function openKindSettings(id: string, x?: number, y?: number) {
  const w = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const h = typeof window === 'undefined' ? 800 : window.innerHeight;
  useSpecialUi.setState({ pop: { id, x: x ?? Math.max(16, w / 2 - 170), y: y ?? Math.max(60, h / 2 - 260) } });
}

export function closeKindSettings() {
  useSpecialUi.setState({ pop: null });
}

/** 左のキットの「特殊ノーツ」を開く（iPad・スマホは音のパネル） */
export function openSpecialSettings() {
  const d = useDevice.getState();
  if (d.tablet || d.phone) openPanelT('snd');
  useEditor.setState({ leftTab: 'kit' });
  useSpecialUi.setState((s) => ({ focus: s.focus + 1 }));
}

// ---- 種類の決め（作業ファイル） ------------------------------------------------------------

function sideNow(): SpecialSide {
  return useSidecar.getState().special ?? { kinds: [] };
}

/** 種類の決めを変える（patch が null なら決めを消す）。決めが空なら作業ファイルから special を外す */
function putDef(id: string, patch: Partial<SpecialDef> | null) {
  const side = sideNow();
  const has = side.kinds.some((d) => d.id === id);
  const kinds = patch === null ? side.kinds.filter((d) => d.id !== id) : has ? side.kinds.map((d) => (d.id === id ? { ...d, ...patch } : d)) : [...side.kinds, { id, ...patch }];
  writeSide({ ...side, kinds });
}

function writeSide(side: SpecialSide) {
  setSpecialSide(side.kinds.length || side.off || side.cuts?.length ? side : null);
}

/** 譜面を変える操作と一緒に、作業ファイルの決めも戻す・やり直す（Ctrl+Z） */
function sideStep(apply: () => void): { undo: () => void; redo: () => void } {
  const before = useSidecar.getState().special;
  apply();
  const after = useSidecar.getState().special;
  return { undo: () => setSpecialSide(before), redo: () => setSpecialSide(after) };
}

/** 決まった種類に決めが無ければ作る（キー・MIDI で初めて置いたときも列が残るように） */
function ensureDef(id: string) {
  if (specialDef(id)) {
    if (specialDef(id)?.off) putDef(id, { off: undefined });
    return;
  }
  if (presetById.has(id)) putDef(id, {});
}

/** 特殊ノーツに分けて見せるのをやめる・分け直す（お知らせの「元に戻す」・表示のメニュー） */
export function setSpecialOff(off: boolean) {
  const side = sideNow();
  writeSide({ ...side, off: off || undefined });
}

export function specialOff(): boolean {
  return !!useSidecar.getState().special?.off;
}

/** 今の譜面の種類（無ければ決まった種類を探す） */
function kindOf(id: string): SpecialKind | undefined {
  return specialKind(useEditor.getState().doc, id);
}

// ---- 位置 ---------------------------------------------------------------------------------

const posKey = (ch: number, m: number, f: Frac) => `${conflictKey(ch)}@${m}:${f.n}/${f.d}`;
const samePos = (c: { m: number; f: Frac }, p: Pos) => c.m === p.m && cmp(c.f, p.f) === 0;

/** 特殊ノーツのチップか（ドラムの通常チップか SE で、種類の音） */
function isSpecialChip(wav: ReadonlyMap<number, string>, c: Chip): boolean {
  return wav.has(c.v) && (isSeChannel(c.ch) || drumChannel(c.ch)?.kind === 'normal');
}

/** pos で空いている SE のチャンネル（prefer から）。taken は posKey の集まり */
function freeSe(taken: ReadonlySet<string>, m: number, f: Frac, prefer: number): number | null {
  for (const ch of [prefer, ...SE_CHANNELS]) if (!taken.has(posKey(ch, m, f))) return ch;
  return null;
}

/** チップの今の名前（重なりの知らせ。特殊ノーツなら種類の名前） */
function chipName(doc: DtxDoc, c: Chip): string {
  const kind = specialLayout(doc).wav.get(c.v);
  if (kind && isSpecialChip(specialLayout(doc).wav, c)) return kindName(kind);
  return drumChannel(c.ch)?.name ?? '';
}

/** 小節の並びを短く（027〜031、066〜071 小節） */
export function measureRanges(ms: readonly number[], max = 3): string {
  const sorted = [...new Set(ms)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const m of sorted) {
    const last = runs[runs.length - 1];
    if (last && m === last[1] + 1) last[1] = m;
    else runs.push([m, m]);
  }
  const txt = runs.slice(0, max).map(([a, b]) => (a === b ? toMeasure(a) : `${toMeasure(a)}〜${toMeasure(b)}`));
  return txt.join(tr('、', ', ')) + (runs.length > max ? tr(' など', ' and more') : '');
}

// ---- 音 -----------------------------------------------------------------------------------

/**
 * 種類の音（置くときの WAV 番号）を用意する。置く音の表（laneWav）にあればそれ、無ければ譜面でその種類の音と分かる番号、
 * それも無ければキットの音（決まった種類だけ）。用意できなければ false
 */
function ensureKindSound(k: SpecialKind): boolean {
  const s = useEditor.getState();
  const no = s.laneWav[k.voice];
  const wav = specialLayout(s.doc).wav;
  if (no !== undefined && wav.get(no) === k.id) return true;
  const own = k.wavs[0] ?? [...wav.entries()].find(([, id]) => id === k.id)?.[0];
  if (own !== undefined) {
    useEditor.setState((st) => ({ laneWav: { ...st.laneWav, [k.voice]: own } }));
    return true;
  }
  return !!currentKitFile(k.voice);
}

/** 種類の音の WAV 番号（試聴・左のキットの表示。譜面は変えない）。キットの音でまだ譜面に無ければ null */
export function kindSoundNo(id: string): number | null {
  const s = useEditor.getState();
  const k = specialKind(s.doc, id);
  if (!k) return null;
  const wav = specialLayout(s.doc).wav;
  const no = s.laneWav[k.voice];
  if (no !== undefined && wav.get(no) === id) return no;
  if (k.wavs[0] !== undefined) return k.wavs[0];
  const file = currentKitFile(k.voice);
  return file ? findKindWav(s.doc, file, id) : null;
}

/** 種類の音を、譜面の WAV 番号 no の音にする（これから置くチップの音。ラベルが無ければ付けた番号を作る）。できなければ false */
export function setKindSound(id: string, no: number | null): boolean {
  const k = kindOf(id);
  if (!k) return false;
  if (no === null) {
    useEditor.setState((s) => {
      const laneWav = { ...s.laneWav };
      delete laneWav[k.voice];
      return { laneWav };
    });
    return true;
  }
  let got: number | null = null;
  edit(tr(`${k.name}の音を変える`, `Change the ${k.name} sound`), (d) => {
    got = kindWavFor(d, no, id);
  });
  if (got === null) {
    const path = useEditor.getState().doc.fields['WAV' + toBase36x2(no)] ?? '';
    toast(tr(`「${path}」はほかの楽器の名前なので、${k.name}の音にできません`, `"${path}" is named after another instrument, so it can't be the ${k.name} sound`), 'warn', 6000);
    return false;
  }
  const picked = got;
  useEditor.setState((s) => ({ laneWav: { ...s.laneWav, [k.voice]: picked } }));
  void prepareSounds();
  return true;
}

/** 種類の音を、今のキットの音（標準の音）にする（譜面にその音の番号を作る）。キットに音が無ければ false */
export function setKindKitSound(id: string): boolean {
  const k = kindOf(id);
  const file = k ? currentKitFile(k.voice) : null;
  if (!k || !file) return false;
  let no: number | null = findKindWav(useEditor.getState().doc, file, id);
  if (no === null) {
    edit(tr(`${k.name}の音を標準の音にする`, `Use the built-in ${k.name} sound`), (d) => {
      no = addKindWav(d, file, id);
    });
  }
  if (no === null) return false;
  const picked = no;
  useEditor.setState((s) => ({ laneWav: { ...s.laneWav, [k.voice]: picked } }));
  void prepareSounds();
  return true;
}

/** 種類の音にできる WAV 番号（その種類の音と、ラベルを付ければその種類と読める音。ほかの楽器の名前の音は除く） */
export function kindSoundChoices(id: string): { no: number; path: string; own: boolean }[] {
  const doc = useEditor.getState().doc;
  const label = kindLabel(id);
  const wav = specialLayout(doc).wav;
  const out: { no: number; path: string; own: boolean }[] = [];
  for (const key of Object.keys(doc.fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(key)) continue;
    const no = parseInt(key.slice(3), 36);
    const path = doc.fields[key];
    const own = wav.get(no) === id;
    if (own || (!wav.has(no) && label && kindOfSound(path, label) === id)) out.push({ no, path, own });
  }
  return out.sort((a, b) => Number(b.own) - Number(a.own) || a.no - b.no);
}

// ---- 置く ---------------------------------------------------------------------------------

export interface PlaceSpecialOpts {
  /** ベロシティ（1〜100）。省くと操作バーで選んでいるベロシティ */
  vel?: number;
  /** 行き先のレーンではなく、自動で鳴らす（SE）に置く */
  auto?: boolean;
  select?: boolean;
  preview?: boolean;
  /** 同じ group の続けての操作は Undo 1回で戻せる（録音） */
  group?: string;
  label?: string;
  /** 置けないときに知らせない（録音） */
  quiet?: boolean;
}

/** pos にある種類 id のチップ（無ければ null） */
export function specialChipAt(id: string, pos: Pos): number | null {
  const doc = useEditor.getState().doc;
  const wav = specialLayout(doc).wav;
  for (const c of doc.chips) if (samePos(c, pos) && wav.get(c.v) === id && isSpecialChip(wav, c)) return c.id;
  return null;
}

/**
 * 特殊ノーツを置く。行き先のレーンの同じ時刻にほかのチップがあれば置かずに知らせる（「自動で鳴らして置く」を出す）。
 * もうその種類のチップがあれば置かずにその id を返す。置けなければ null
 */
export function placeSpecial(id: string, pos: Pos, o: PlaceSpecialOpts = {}): number | null {
  if (specialOff()) setSpecialOff(false);
  if (!kindOf(id) || specialDef(id)?.off) ensureDef(id);
  const k = kindOf(id);
  if (!k) return null;
  if (!ensureKindSound(k)) {
    if (!o.quiet) toast(tr(`${k.name}の音を選んでください`, `Choose a sound for ${k.name}`), 'warn', 5000, { label: tr('設定を開く', 'Open settings'), run: () => openKindSettings(id) });
    return null;
  }
  const s = useEditor.getState();
  const doc = s.doc;
  const there = specialChipAt(id, pos);
  if (there !== null) {
    if (o.select) useEditor.setState({ selection: [there] });
    return there;
  }
  const auto = o.auto || k.dest === 'auto';
  let ch: number;
  if (!auto) {
    const dest = k.dest as number;
    const key = conflictKey(dest);
    const block = doc.chips.find((c) => samePos(c, pos) && conflictKey(c.ch) === key);
    if (block) {
      if (!o.quiet) {
        toast(
          tr(`ここには${chipName(doc, block)}があります（同じレーンの同じ時刻にチップは 1 つだけ）`, `There is already a ${chipName(doc, block)} here (one chip per lane at a time)`),
          'warn',
          5000,
          { label: tr('自動で鳴らして置く', 'Place as auto-play'), run: () => void placeSpecial(id, pos, { ...o, auto: true }) },
        );
      }
      return null;
    }
    ch = dest;
  } else {
    const taken = new Set(doc.chips.filter((c) => samePos(c, pos)).map((c) => posKey(c.ch, c.m, c.f)));
    const free = freeSe(taken, pos.m, pos.f, k.se);
    if (free === null) {
      if (!o.quiet) toast(tr('ここには自動で鳴らすチップをこれ以上置けません', 'No more auto-play chips fit here'), 'warn');
      return null;
    }
    ch = free;
  }
  let newId = -1;
  let v = 0;
  const hadKit = Object.keys(doc.fields).length;
  const step = useInputSettings.getState().velStep;
  edit(
    o.label ?? tr(`${k.name}を置く`, `Place ${k.name}`),
    (d) => {
      const base = wavForVoice(d, k.voice);
      v = wavVariant(d, base, quantizeVel(o.vel ?? placeVel(), step));
      newId = opPlace(d, ch, pos, v);
    },
    { group: o.group },
  );
  if (newId < 0) return null;
  if (o.select) useEditor.setState({ selection: [newId] });
  if (Object.keys(useEditor.getState().doc.fields).length !== hadKit) void prepareSounds();
  if (o.preview && v) previewWav(v);
  return newId;
}

// ---- このチップ ---------------------------------------------------------------------------

/**
 * 特殊ノーツのチップを自動で鳴らす（SE に）・叩く（行き先のレーンに）にする。叩くにするとき、行き先に同じ時刻のチップがあれば
 * 自動のまま（知らせる）。変えた数
 */
export function setChipsAuto(ids: readonly number[], auto: boolean): number {
  const doc = useEditor.getState().doc;
  const lay = specialLayout(doc);
  const want = new Set(ids);
  const targets = doc.chips.filter((c) => want.has(c.id) && isSpecialChip(lay.wav, c) && isSeChannel(c.ch) !== auto);
  if (targets.length === 0) return 0;
  const moving = new Set(targets.map((c) => c.id));
  const taken = new Set(doc.chips.filter((c) => !moving.has(c.id)).map((c) => posKey(c.ch, c.m, c.f)));
  const plan = new Map<number, number>();
  let blocked = 0;
  let noLane = 0;
  for (const c of targets) {
    const k = lay.kinds.find((x) => x.id === lay.wav.get(c.v));
    if (!k) continue;
    if (auto) {
      const ch = freeSe(taken, c.m, c.f, k.se);
      if (ch === null) continue;
      plan.set(c.id, ch);
      taken.add(posKey(ch, c.m, c.f));
    } else {
      if (k.dest === 'auto') {
        noLane++;
        continue;
      }
      if (taken.has(posKey(k.dest, c.m, c.f))) {
        blocked++;
        continue;
      }
      plan.set(c.id, k.dest);
      taken.add(posKey(k.dest, c.m, c.f));
    }
  }
  if (plan.size) {
    const n = plan.size;
    edit(
      auto
        ? tr(`${n === 1 ? 'チップ' : `${n}個のチップ`}を自動で鳴らす`, `Make ${n === 1 ? 'the chip' : `${n} chips`} auto-play`)
        : tr(`${n === 1 ? 'チップ' : `${n}個のチップ`}を叩くにする`, `Make ${n === 1 ? 'the chip' : `${n} chips`} playable`),
      (d) => {
        for (const c of d.chips) {
          const ch = plan.get(c.id);
          if (ch !== undefined) c.ch = ch;
        }
      },
    );
  }
  if (blocked)
    toast(
      tr(`${blocked} か所は行き先のレーンにもうチップがあるので、自動で鳴らすのままです`, `${blocked} ${pl(blocked, 'chip')} stay auto-play because the lane already has a chip there`),
      'warn',
      5000,
    );
  else if (noLane)
    toast(
      tr('行き先が「自動で鳴らす」の種類です。叩くには種類の設定で行き先のレーンを選んでください', 'This kind plays automatically. Choose a lane in its settings to make it playable'),
      'info',
      5000,
    );
  return plan.size;
}

/**
 * チップを特殊ノーツの種類 id にする（同じ時刻のまま、行き先のレーンへ。行き先にほかのチップがあれば自動で鳴らす）。
 * 音：今の音がその種類と読めれば（ラベルを付けて）そのまま、読めなければ種類の音（ベロシティは保つ）。変えた数
 */
export function makeChipsSpecial(ids: readonly number[], id: string): number {
  if (specialOff()) setSpecialOff(false);
  ensureDef(id);
  const doc = useEditor.getState().doc;
  const k = specialKind(doc, id);
  if (!k) return 0;
  const lay = specialLayout(doc);
  const want = new Set(ids);
  const targets = doc.chips.filter((c) => want.has(c.id) && (drumChannel(c.ch)?.kind === 'normal' || isSeChannel(c.ch)) && !(lay.wav.get(c.v) === id && isSpecialChip(lay.wav, c)));
  if (targets.length === 0) return 0;
  if (!ensureKindSound(k)) {
    toast(tr(`${k.name}の音を選んでください`, `Choose a sound for ${k.name}`), 'warn', 5000, { label: tr('設定を開く', 'Open settings'), run: () => openKindSettings(id) });
    return 0;
  }
  const moving = new Set(targets.map((c) => c.id));
  const taken = new Set(doc.chips.filter((c) => !moving.has(c.id)).map((c) => posKey(c.ch, c.m, c.f)));
  // 同じ時刻に同じ種類がもうあれば足さない
  const kindAt = new Set(doc.chips.filter((c) => !moving.has(c.id) && lay.wav.get(c.v) === id && isSpecialChip(lay.wav, c)).map((c) => `${c.m}:${c.f.n}/${c.f.d}`));
  const plan = new Map<number, number>();
  const drop = new Set<number>();
  let autoN = 0;
  for (const c of targets) {
    const at = `${c.m}:${c.f.n}/${c.f.d}`;
    if (kindAt.has(at)) {
      drop.add(c.id);
      continue;
    }
    kindAt.add(at);
    let ch: number | null = null;
    if (!isSeChannel(c.ch) && k.dest !== 'auto' && !taken.has(posKey(k.dest, c.m, c.f))) ch = k.dest;
    if (ch === null) {
      ch = freeSe(taken, c.m, c.f, k.se);
      if (ch === null) continue;
      if (!isSeChannel(c.ch)) autoN++;
    }
    plan.set(c.id, ch);
    taken.add(posKey(ch, c.m, c.f));
  }
  if (plan.size === 0 && drop.size === 0) return 0;
  const hadKit = Object.keys(doc.fields).length;
  const n = plan.size;
  edit(
    tr(`${n === 1 ? 'チップ' : `${n}個のチップ`}を${k.name}にする`, `Make ${n === 1 ? 'the chip' : `${n} chips`} ${k.name}`),
    (d) => {
      const kindNo = new Map<number, number | null>();
      let base: number | null = null;
      for (let i = d.chips.length - 1; i >= 0; i--) {
        const c = d.chips[i];
        if (drop.has(c.id)) {
          d.chips.splice(i, 1);
          continue;
        }
        const ch = plan.get(c.id);
        if (ch === undefined) continue;
        if (!kindNo.has(c.v)) kindNo.set(c.v, kindWavFor(d, c.v, id));
        const own = kindNo.get(c.v) ?? null;
        if (own !== null) c.v = own;
        else {
          base ??= wavForVoice(d, k.voice);
          c.v = wavVariant(d, base, velOfWav(d.fields, c.v));
        }
        c.ch = ch;
      }
    },
    { replace: drop.size > 0 },
  );
  if (Object.keys(useEditor.getState().doc.fields).length !== hadKit) void prepareSounds();
  if (autoN) toast(tr(`${autoN} 個は${destName(k.dest)}と重なるので、自動で鳴らすにしました`, `${autoN} ${pl(autoN, 'chip')} overlapped the ${destName(k.dest)} and became auto-play`), 'info', 5000);
  return n;
}

/** 特殊ノーツのチップを、ふつうのチップ（今のレーン、自動のチップは行き先のレーン）に戻す。音もそのレーンの音にする */
export function unmakeSpecial(ids: readonly number[]): number {
  const doc = useEditor.getState().doc;
  const lay = specialLayout(doc);
  const want = new Set(ids);
  const targets = doc.chips.filter((c) => want.has(c.id) && isSpecialChip(lay.wav, c));
  if (targets.length === 0) return 0;
  const moving = new Set(targets.map((c) => c.id));
  const taken = new Set(doc.chips.filter((c) => !moving.has(c.id)).map((c) => posKey(c.ch, c.m, c.f)));
  const plan = new Map<number, number>();
  let blocked = 0;
  for (const c of targets) {
    let ch: number | null = drumChannel(c.ch) ? c.ch : null;
    if (ch === null) {
      const k = lay.kinds.find((x) => x.id === lay.wav.get(c.v));
      ch = k && k.dest !== 'auto' ? k.dest : null;
    }
    if (ch === null || taken.has(posKey(ch, c.m, c.f))) {
      blocked++;
      continue;
    }
    plan.set(c.id, ch);
    taken.add(posKey(ch, c.m, c.f));
  }
  if (plan.size) {
    const hadKit = Object.keys(doc.fields).length;
    const n = plan.size;
    const first = drumChannel([...plan.values()][0]);
    const name = first ? DRUM_LANES[first.lane].name : '';
    edit(tr(`${n === 1 ? 'チップ' : `${n}個のチップ`}をふつうの${name}にする`, `Make ${n === 1 ? 'the chip' : `${n} chips`} a normal ${name}`), (d) => {
      const lanes = new Map<number, number>();
      for (const c of d.chips) {
        const ch = plan.get(c.id);
        if (ch === undefined) continue;
        const info = drumChannel(ch)!;
        let base = lanes.get(info.base);
        if (base === undefined) lanes.set(info.base, (base = wavForVoice(d, laneVoice(info.lane, info.alt))));
        c.ch = ch;
        c.v = wavVariant(d, base, velOfWav(d.fields, c.v));
      }
    });
    if (Object.keys(useEditor.getState().doc.fields).length !== hadKit) void prepareSounds();
  }
  if (blocked)
    toast(tr(`${blocked} 個は戻すレーンに同じ時刻のチップがあるので、そのままにしました`, `${blocked} ${pl(blocked, 'chip')} stayed because the lane already has a chip there`), 'warn', 5000);
  return plan.size;
}

// ---- 行き先 -------------------------------------------------------------------------------

/** 行き先を dest にしたときに動かすチップと、重なる所（自動のチップは自動のまま） */
export function destPlan(id: string, dest: number | 'auto'): { lane: Chip[]; over: Chip[] } {
  const doc = useEditor.getState().doc;
  const lay = specialLayout(doc);
  const lane = doc.chips.filter((c) => lay.wav.get(c.v) === id && drumChannel(c.ch)?.kind === 'normal' && c.ch !== dest);
  if (dest === 'auto') return { lane, over: [] };
  const moving = new Set(lane.map((c) => c.id));
  const key = conflictKey(dest);
  const occupied = new Set(doc.chips.filter((c) => !moving.has(c.id) && conflictKey(c.ch) === key).map((c) => `${c.m}:${c.f.n}/${c.f.d}`));
  return { lane, over: lane.filter((c) => occupied.has(`${c.m}:${c.f.n}/${c.f.d}`)) };
}

/**
 * 種類の行き先を変える。置いてあるチップ（自動のものを除く）も行き先へ動かす。重なる所は over で決める
 * （auto: 自動で鳴らす、drop: 消す）。Ctrl+Z で作業ファイルの決めも一緒に戻る
 */
export function moveKindDest(id: string, dest: number | 'auto', over: 'auto' | 'drop' = 'auto'): { moved: number; auto: number; dropped: number } {
  const k = kindOf(id);
  const res = { moved: 0, auto: 0, dropped: 0 };
  if (!k) return res;
  const { lane, over: hit } = destPlan(id, dest);
  if (lane.length === 0) {
    putDef(id, { dest });
    return res;
  }
  const doc = useEditor.getState().doc;
  const overIds = new Set(hit.map((c) => c.id));
  const moving = new Set(lane.map((c) => c.id));
  const taken = new Set(doc.chips.filter((c) => !moving.has(c.id)).map((c) => posKey(c.ch, c.m, c.f)));
  const plan = new Map<number, number | null>();
  for (const c of lane) {
    if (dest !== 'auto' && !overIds.has(c.id)) {
      plan.set(c.id, dest);
      taken.add(posKey(dest, c.m, c.f));
      res.moved++;
      continue;
    }
    if (dest !== 'auto' && over === 'drop') {
      plan.set(c.id, null);
      res.dropped++;
      continue;
    }
    const ch = freeSe(taken, c.m, c.f, k.se);
    plan.set(c.id, ch);
    if (ch === null) res.dropped++;
    else {
      taken.add(posKey(ch, c.m, c.f));
      res.auto++;
    }
  }
  const side = sideStep(() => putDef(id, { dest }));
  edit(
    tr(`${k.name}の行き先を${destName(dest)}にする`, `Send ${k.name} to ${destName(dest)}`),
    (d) => {
      for (let i = d.chips.length - 1; i >= 0; i--) {
        const c = d.chips[i];
        if (!plan.has(c.id)) continue;
        const ch = plan.get(c.id)!;
        if (ch === null) d.chips.splice(i, 1);
        else c.ch = ch;
      }
    },
    { side, replace: res.dropped > 0 },
  );
  return res;
}

/** 行き先を変える（重なる所があれば、自動で鳴らすか消すかを聞く）。変えたら true */
export async function changeKindDest(id: string, dest: number | 'auto'): Promise<boolean> {
  const k = kindOf(id);
  if (!k || k.dest === dest) return false;
  const { lane, over } = destPlan(id, dest);
  let mode: 'auto' | 'drop' = 'auto';
  if (over.length && dest !== 'auto') {
    const from = k.dest === 'auto' ? tr('自動で鳴らす', 'auto-play') : destName(k.dest);
    const to = destName(dest);
    const soundNo = kindSoundNo(id);
    const sound = soundNo !== null ? useEditor.getState().doc.fields['WAV' + toBase36x2(soundNo)] : undefined;
    const stay = lane.length - over.length;
    const choice = await chooseDialog<'auto' | 'drop'>({
      title: tr(`${k.name}の行き先を変える`, `Change where ${k.name} goes`),
      body: tr(
        `${k.name} ${lane.length} 個を${from}から${to}に動かします。音は${k.name}のまま${sound ? `（${sound}）` : ''}です。\n${over.length} か所で、もう${to}が置いてあります（${measureRanges(over.map((c) => c.m))} 小節）。DTX では同じレーンの同じ時刻にチップを 2 つ置けません。重なる所をどうするか選んでください。Ctrl+Z で元に戻せます。`,
        `Moves ${lane.length} ${k.name} ${pl(lane.length, 'chip')} from ${from} to ${to}. They keep the ${k.name} sound${sound ? ` (${sound})` : ''}.\n${to} already has chips at ${over.length} of those spots (measures ${measureRanges(over.map((c) => c.m))}). DTX allows only one chip per lane at a time, so choose what to do there. Ctrl+Z undoes it.`,
      ),
      options: [
        {
          label: tr(`重なる所の${k.name}は自動で鳴らす（おすすめ）`, `Auto-play ${k.name} where they overlap (recommended)`),
          sub: tr(
            `${to}はそのまま叩けて、${k.name}の音も鳴ります。${to}へ動くのは ${stay} 個、自動で鳴らすのは ${over.length} 個です。列では自動のチップを白抜きで見せます。`,
            `${to} stays playable and the ${k.name} still sounds. ${stay} move to ${to}, ${over.length} become auto-play (shown hollow in the column).`,
          ),
          value: 'auto',
        },
        {
          label: tr(`重なる所の${k.name}を消す`, `Delete ${k.name} where they overlap`),
          sub: tr(`${k.name}は ${stay} 個になり、消した ${over.length} 個の所では${k.name}が鳴りません。`, `${stay} ${k.name} remain; the ${over.length} deleted spots no longer play ${k.name}.`),
          value: 'drop',
        },
      ],
    });
    if (!choice) return false;
    mode = choice;
  }
  const r = moveKindDest(id, dest, mode);
  if (r.moved + r.auto + r.dropped > 0) {
    const parts = [
      r.moved ? tr(`${r.moved} 個を${destName(dest)}へ`, `${r.moved} to ${destName(dest)}`) : '',
      r.auto ? tr(`${r.auto} 個を自動で鳴らすに`, `${r.auto} to auto-play`) : '',
      r.dropped ? tr(`${r.dropped} 個を消しました`, `${r.dropped} deleted`) : '',
    ].filter(Boolean);
    toast(tr(`${k.name}：${parts.join('、')}${r.dropped ? '' : '動かしました'}（Ctrl+Z で戻せます）`, `${k.name}: ${parts.join(', ')} (Ctrl+Z to undo)`), 'ok', 5000);
  }
  return true;
}

// ---- 種類を足す・変える・やめる --------------------------------------------------------------

/** 次に割り当てるキー（今あいているキーから。Q W E R、続けて U Y X C B N M） */
const KEY_ORDER = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyU', 'KeyY', 'KeyX', 'KeyC', 'KeyB', 'KeyN', 'KeyM'];

function freeKey(): string | null {
  const used = new Set<string>(Object.keys(useInputSettings.getState().keys));
  for (const k of specialKinds(useEditor.getState().doc)) if (k.key) used.add(k.key);
  for (const p of SPECIAL_PRESETS) if (!kindOf(p.id)) used.add(p.key);
  return KEY_ORDER.find((k) => !used.has(k)) ?? null;
}

/** 決まった種類（カウベルなど）を足す。もう列があれば何もしない */
export function addPresetKind(id: string) {
  if (specialOff()) setSpecialOff(false);
  ensureDef(id);
}

/** 自分で作る種類を足す（名前を聞く）。足した種類の id */
export async function addCustomKind(name0?: string): Promise<string | null> {
  const name =
    name0 ??
    (await promptDialog({
      title: tr('特殊ノーツを足す', 'Add a special note'),
      body: tr('名前（効果音・ボイス・スクラッチなど）。#WAV のラベルにもなります。', 'A name (effect, voice, scratch…). It also becomes the #WAV label.'),
      value: '',
      ok: tr('足す', 'Add'),
    }));
  if (!name) return null;
  const label = labelFor(name);
  const side = sideNow();
  const kinds = specialKinds(useEditor.getState().doc);
  // 同じラベルの種類があればそれを使う（ラベルが同じ音は同じ種類）
  const same = side.kinds.find((d) => (d.label ?? '').toLowerCase() === label.toLowerCase() || (presetById.get(d.id)?.label ?? '').toLowerCase() === label.toLowerCase());
  if (same) {
    if (same.off) putDef(same.id, { off: undefined });
    return same.id;
  }
  const used = new Set(side.kinds.map((d) => d.id));
  let n = 1;
  while (used.has(`sp${n}`)) n++;
  const id = `sp${n}`;
  const customCount = side.kinds.filter((d) => !presetById.has(d.id)).length;
  const def: SpecialDef = {
    id,
    name: name.trim().slice(0, 60),
    code: codeFor(name, [...kinds.map((k) => k.code), ...SPECIAL_PRESETS.map((p) => p.code)]),
    color: SPECIAL_COLORS[(4 + customCount) % SPECIAL_COLORS.length],
    label,
    dest: 'auto',
    key: freeKey(),
    midi: null,
  };
  if (specialOff()) setSpecialOff(false);
  writeSide({ ...sideNow(), kinds: [...sideNow().kinds, def] });
  return id;
}

/** 種類の名前・コード・色・キー・MIDI を変える（譜面は変えない） */
export function updateKind(id: string, patch: Pick<SpecialDef, 'name' | 'code' | 'color' | 'key' | 'midi'>) {
  const p: Partial<SpecialDef> = { ...patch };
  if (p.code !== undefined)
    p.code =
      p.code
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 3) || undefined;
  if (p.name !== undefined) p.name = p.name.trim().slice(0, 60) || undefined;
  // キーは 1 つの種類だけに
  if (p.key) for (const d of sideNow().kinds) if (d.id !== id && d.key === p.key) putDef(d.id, { key: null });
  putDef(id, p);
}

/**
 * 種類を特殊ノーツにするのをやめる（確かめてから）。チップは行き先のレーンのふつうのチップとして見え、音はそのまま。
 * 自分で作った種類は決めを消す
 */
export async function stopKind(id: string): Promise<boolean> {
  const k = kindOf(id);
  if (!k) return false;
  const ok = await confirmDialog({
    title: tr(`${k.name}を特殊ノーツにするのをやめますか？`, `Stop treating ${k.name} as special notes?`),
    body: tr(
      `${k.count ? `置いてある ${k.count} 個は、${k.dest === 'auto' ? '自動で鳴らすチップ（BGM・SE の列）' : `${destName(k.dest)}のチップ`}として見えるようになります。` : ''}譜面と音は変わりません。「＋足す」からいつでも戻せます。`,
      `${k.count ? `The ${k.count} placed ${pl(k.count, 'chip')} will show as ${k.dest === 'auto' ? 'auto-play chips (BGM/SE column)' : `${destName(k.dest)} chips`}. ` : ''}The chart and sounds stay the same. You can add it back any time with "+ Add".`,
    ),
    ok: tr('やめる', 'Stop'),
    cancel: tr('キャンセル', 'Cancel'),
  });
  if (!ok) return false;
  closeKindSettings();
  if (k.preset) putDef(id, { off: true, dest: undefined, se: undefined });
  else putDef(id, null);
  return true;
}

/** 種類のチップを全部選ぶ */
export function selectKindChips(id: string): number {
  const doc = useEditor.getState().doc;
  const ids = chipViews(doc)
    .filter((v) => v.sp === id)
    .map((v) => v.c.id);
  useEditor.setState({ selection: ids });
  if (ids.length) {
    const first = chipViews(doc).find((v) => v.sp === id);
    if (first) setView({ scrollBeat: Math.max(0, first.beat - 2) });
  }
  return ids.length;
}

// ---- キー・MIDI ---------------------------------------------------------------------------

/** そのキーを自分で種類に決めたか（決まった種類のキー Q W E R は数えない） */
export function kindKeyChosen(code: string): boolean {
  if (specialOff()) return false;
  return specialKinds(useEditor.getState().doc).some((k) => specialDef(k.id)?.key === code);
}

/**
 * そのキー（KeyboardEvent.code）で置く種類（特殊ノーツに分けていなければ null）。
 * 種類で決めたキーはレーンのキーより先、決まった種類のキー（Q W E R）は mapped（レーンのキー）でないときだけ
 */
export function kindForKey(code: string, mapped = false): string | null {
  if (specialOff()) return null;
  const kinds = specialKinds(useEditor.getState().doc);
  const own = kinds.find((k) => specialDef(k.id)?.key === code);
  if (own) return own.id;
  if (mapped) return null;
  const hit = kinds.find((k) => k.key === code);
  if (hit) return hit.id;
  const p = SPECIAL_PRESETS.find((x) => x.key === code && !kinds.some((k) => k.id === x.id) && !specialDef(x.id));
  return p ? p.id : null;
}

/** その MIDI ノートで置く種類。種類で覚えたノートはレーンより先、決まった種類のノート（GM）は mapped でないときだけ */
export function kindForNote(note: number, mapped = false): string | null {
  if (specialOff()) return null;
  const kinds = specialKinds(useEditor.getState().doc);
  const own = kinds.find((k) => specialDef(k.id)?.midi === note);
  if (own) return own.id;
  if (mapped) return null;
  const hit = kinds.find((k) => k.midi === note);
  if (hit) return hit.id;
  const p = SPECIAL_PRESETS.find((x) => x.midi === note && !kinds.some((k) => k.id === x.id) && !specialDef(x.id));
  return p ? p.id : null;
}

setKindRouter(kindForNote);
setKindLearned((id, note) => {
  if (!kindOf(id)) return;
  updateKind(id, { midi: note });
  toast(tr(`${kindName(id)}を MIDI ノート ${note} にしました`, `${kindName(id)} now uses MIDI note ${note}`), 'ok');
});

/** ほかの操作に使うキー（種類のキーにできない） */
const RESERVED_KEYS = new Set([
  'KeyI',
  'KeyO',
  'KeyP',
  'KeyV',
  'KeyT',
  'Digit1',
  'Digit2',
  'Digit3',
  'Space',
  'Slash',
  'NumpadDivide',
  'BracketLeft',
  'BracketRight',
  'Escape',
  'Delete',
  'Backspace',
  'Enter',
  'Tab',
  'Home',
  'End',
]);

/** 種類のキーにできるか（文字・数字・記号のキー。ほかの操作に使うキーは使えない） */
export function kindKeyOk(code: string): boolean {
  if (RESERVED_KEYS.has(code)) return false;
  return /^(Key[A-Z]|Digit\d|Numpad\d|Semicolon|Quote|Comma|Period|Backslash|Minus|Equal)$/.test(code);
}

/** そのキーを使っているレーンの名前（無ければ null） */
export function laneOfKey(code: string): string | null {
  const lane = useInputSettings.getState().keys[code];
  return lane === undefined ? null : (DRUM_LANES[lane]?.name ?? null);
}

/** 足す種類を選ぶ（まだ無い決まった種類と「自分で作る…」）。足した種類の id（やめたら null） */
export async function pickNewKind(): Promise<string | null> {
  const have = new Set(specialKinds(useEditor.getState().doc).map((k) => k.id));
  const options: { label: string; sub?: string; value: string }[] = SPECIAL_PRESETS.filter((p) => !have.has(p.id)).map((p) => ({
    label: p.name,
    sub: tr(`キー ${keyLabel(p.key)}・MIDI ${p.midi}`, `Key ${keyLabel(p.key)} · MIDI ${p.midi}`),
    value: p.id,
  }));
  options.push({ label: tr('自分で作る…', 'Make your own…'), sub: tr('効果音・ボイス・スクラッチなど。名前を付けます', 'Effects, voices, scratches and so on. You give it a name'), value: '' });
  const v = await chooseDialog<string>({
    title: tr('特殊ノーツを足す', 'Add a special note'),
    body: tr(
      'エディタでは種類ごとに列を分けて見せます。ゲームでは「行き先」のレーンのチップになります（あとで種類の設定で選べます）。',
      'The editor shows each kind in its own column. In the game they become chips on the lane you pick as the destination (choose it later in the kind settings).',
    ),
    options,
  });
  if (v === null) return null;
  if (v === '') return addCustomKind();
  addPresetKind(v);
  return v;
}

// ---- 開いたときのお知らせ --------------------------------------------------------------------

const NOTICE_KEY = 'dtxe.special.notice.v1';

function noticed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NOTICE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function markNoticed(id: string) {
  try {
    const list = noticed().filter((x) => x !== id);
    list.push(id);
    localStorage.setItem(NOTICE_KEY, JSON.stringify(list.slice(-300)));
  } catch {
    // 保存できなくても動く（次も知らせるだけ）
  }
}

/** 種類と数を並べる（クラップ（58 個）とタンバリン（7 個）） */
export function kindCountsText(list: readonly { name: string; n: number }[]): string {
  const items = list.map((x) => tr(`${x.name}（${x.n} 個）`, `${x.name} (${x.n})`));
  if (items.length <= 1) return items.join('');
  if (isJa()) return items.length === 2 ? `${items[0]}と${items[1]}` : items.join('、');
  return items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** 開いた譜面に特殊ノーツがあれば、分けたことを知らせる（譜面ごとに 1 回） */
export function noticeSpecials(): boolean {
  const s = useEditor.getState();
  if (s.screen !== 'editor' || specialOff()) return false;
  const kinds = specialKinds(s.doc).filter((k) => k.count > 0);
  if (kinds.length === 0) return false;
  const chart = s.meta.recentId ?? `${s.folder?.name ?? ''}/${s.meta.fileName}`;
  if (noticed().includes(chart)) return false;
  markNoticed(chart);
  const dests = new Set(kinds.map((k) => k.dest));
  const one = dests.size === 1 ? [...dests][0] : null;
  const where =
    one === null
      ? tr('今のレーンのまま', 'stay on their current lanes')
      : one === 'auto'
        ? tr('自動で鳴るまま', 'keep playing automatically')
        : kinds.length === 1
          ? tr(`${destName(one)}のまま`, `stay on the ${destName(one)}`)
          : tr(`${kinds.length === 2 ? 'どちらも' : 'どれも'}${destName(one)}のまま`, `all stay on the ${destName(one)}`);
  toast(
    tr(
      `${kindCountsText(kinds.map((k) => ({ name: k.name, n: k.count })))}を特殊ノーツに分けました。ゲームでは${where}で、譜面は変わっていません。`,
      `Split ${kindCountsText(kinds.map((k) => ({ name: k.name, n: k.count })))} into special notes. In the game they ${where}; the chart is unchanged.`,
    ),
    'info',
    14000,
    {
      label: tr('元に戻す', 'Undo'),
      run: () => {
        setSpecialOff(true);
        toast(tr('特殊ノーツに分けるのをやめました。表示のメニューからいつでも分け直せます', 'Stopped splitting special notes. Turn it back on from the View menu any time'), 'info', 5000);
      },
    },
    { label: tr('設定を開く', 'Open settings'), run: openSpecialSettings },
  );
  return true;
}

let noticeTimer = 0;
useSidecar.subscribe((cur, prev) => {
  if (cur.loadSeq === prev.loadSeq || typeof window === 'undefined') return;
  window.clearTimeout(noticeTimer);
  // 開いたあと、作業ファイルを読み終わってから（読み込みは 2 回に分かれる）
  noticeTimer = window.setTimeout(() => noticeSpecials(), 900);
});

// ---- 譜面の外から使う小物 ------------------------------------------------------------------

/** 種類の行き先の短い説明（行き先のレーンの名前） */
export function kindDestLabel(k: SpecialKind): string {
  return k.dest === 'auto' ? tr('自動で鳴らす', 'Auto-play') : voiceName(k.dest);
}

/** 譜面の特殊ノーツの数（分けて見せていなければ 0） */
export function specialCount(doc: DtxDoc): number {
  const lay = specialLayout(doc);
  return lay.on ? lay.kinds.reduce((a, k) => a + k.count, 0) : 0;
}
