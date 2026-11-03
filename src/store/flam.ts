// フラム（両手でほんの少しずらして叩く2打）の設定と操作。グリッドを変えずに置く・選んだチップをフラムにする・1打に戻す。
// 設定（置き方・間隔・1打目のベロシティ）はブラウザに保存する。中身の計算は edit/flam.ts。
import { tr, isJa } from '../i18n';
import { create } from 'zustand';
import { engine } from '../audio/engine';
import { DRUM_LANES, type DtxDoc } from '../dtx/model';
import {
  DEFAULT_FLAM,
  FLAM_DIVS,
  FLAM_MAX_SEC,
  findFlamPairs,
  flamDiv,
  flamMs,
  flamSpot,
  flamState,
  graceVel,
  opFlam,
  opUnflam,
  type FlamOptions,
  type FlamSide,
} from '../edit/flam';
import { opDelete, type Pos } from '../edit/ops';
import { useInputSettings } from '../input/settings';
import { addChipMenuItems, addLaneMenuItems, type CtxItem } from './ctxMenu';
import { tempoOf } from './derived';
import { chipAt, deleteChips, edit, placeChips, prepareSounds, previewWav, toast, useEditor } from './editor';
import { placeVel } from './velocity';

export interface FlamSettings extends FlamOptions {
  /** クリック・キー入力で置くチップをフラムにする */
  mode: boolean;
  /** 録音で、グリッドでは分けられないすばやい2打をフラムにする */
  rec: boolean;
}

const KEY = 'dtxe.flam.v1';

function load(): FlamSettings {
  const base: FlamSettings = { ...DEFAULT_FLAM, mode: false, rec: true };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<FlamSettings>;
      if (j.gap === 'auto' || (FLAM_DIVS as readonly number[]).includes(j.gap as number)) base.gap = j.gap!;
      if (j.side === 'after' || j.side === 'before') base.side = j.side;
      if (Number.isFinite(j.grace)) base.grace = Math.max(10, Math.min(100, Math.round(Number(j.grace))));
      if (typeof j.mode === 'boolean') base.mode = j.mode;
      if (typeof j.rec === 'boolean') base.rec = j.rec;
    }
  } catch {
    // 読めなければ初期値
  }
  return base;
}

export const useFlam = create<FlamSettings>(() => load());

useFlam.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ gap: s.gap, side: s.side, grace: s.grace, mode: s.mode, rec: s.rec }));
  } catch {
    // 保存できなくても使える
  }
});

export function flamOptions(): FlamOptions {
  const s = useFlam.getState();
  return { gap: s.gap, side: s.side, grace: s.grace };
}

export function setFlam(p: Partial<FlamSettings>) {
  useFlam.setState(p);
}

/** クリックでフラムを置くかどうか（操作バーの「フラム」） */
export function toggleFlamMode(on?: boolean) {
  useFlam.setState((s) => ({ mode: on ?? !s.mode }));
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 1回だけフラムで置く（またはフラムをやめて置く）ときに押すキー。Mac の Ctrl+クリックは右クリックになるので ⌘ */
export const FLAM_MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/** そのキーを押しているか */
export function flamModHeld(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** クリックで置くのがフラムになるか。Ctrl（Mac は ⌘）を押しているときは、操作バーの切り替えの逆 */
export function wantFlam(mod: boolean): boolean {
  return useFlam.getState().mode !== mod;
}

export const sideLabel = (k: FlamSide): string => (k === 'after' ? tr('1打目を拍の上に', 'Grace note on the beat') : tr('2打目を拍の上に', 'Main note on the beat'));

/** 間隔の説明（例：「1/48・約36ms」） */
export function gapText(div: number, bpm: number): string {
  return tr(`1/${div}・約${Math.round(flamMs(div, bpm))}ms`, `1/${div}, about ${Math.round(flamMs(div, bpm))} ms`);
}

/** 拍 beat の所で使う間隔（全音符の分割数）と、その所の BPM */
export function gapAt(beat: number): { div: number; bpm: number } {
  const t = tempoOf(useEditor.getState().doc);
  const bpm = t.bpmAt(Math.max(0, beat));
  return { div: flamDiv(bpm, useFlam.getState().gap), bpm };
}

/** フラムの音を試しに鳴らす（1打目を弱く、少し遅れて2打目） */
function previewFlam(graceNo: number, mainNo: number, ratio: number, gapSec: number) {
  engine.ensure();
  if (engine.has(mainNo)) {
    engine.preview(mainNo, ratio);
    engine.preview(mainNo, 1, gapSec);
    return;
  }
  // 置いたばかりの音はまだ読み込まれていないので、その場で鳴らす
  previewWav(graceNo);
  window.setTimeout(() => previewWav(mainNo), gapSec * 1000);
}

/**
 * フラムで置く。at は拍の上の位置（グリッドに吸着した位置）。設定の置き方で、もう1打をほんの少し前か後ろに置く。
 * vel は2打目のベロシティ（省くと操作バーのベロシティ）、1打目はその設定の割合。graceVel を渡せばその値
 */
export function placeFlam(
  lane: number,
  alt: boolean,
  at: Pos,
  o: { vel?: number; graceVel?: number; select?: boolean; preview?: boolean; group?: string; label?: string } = {},
): number[] {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const opts = flamOptions();
  const spot = flamSpot(tempo, at, opts);
  if (!spot) return [];
  const step = useInputSettings.getState().velStep;
  const main = o.vel ?? placeVel();
  const grace = o.graceVel ?? graceVel(main, opts, step);
  const def = DRUM_LANES[lane];
  const name = alt && def.altName ? def.altName : def.mainName;
  const ids = placeChips(
    [
      { lane, alt, pos: spot.grace, vel: grace },
      { lane, alt, pos: spot.main, vel: main },
    ],
    { label: o.label ?? tr(`${name}をフラムで置く`, `Place a flam on ${name}`), group: o.group, select: o.select ?? true, preview: false },
  );
  if (ids.length === 2 && (o.preview ?? useEditor.getState().previewOnPlace)) {
    const chips = useEditor.getState().doc.chips;
    const g = chips.find((c) => c.id === ids[0]);
    const m = chips.find((c) => c.id === ids[1]);
    const bpm = tempo.bpmAt(tempo.beatOf(spot.main.m, spot.main.f));
    if (g && m) previewFlam(g.v, m.v, Math.max(0.05, grace / Math.max(1, main)), flamMs(spot.div, bpm) / 1000);
  }
  return ids;
}

const roleCache = new WeakMap<DtxDoc, { gap: FlamOptions['gap']; roles: Map<number, 'grace' | 'main'> }>();

/** 譜面のフラムの2打（チップ id → 1打目・2打目）。譜面の表示で1打目を細く描くのに使う */
export function flamRoles(doc: DtxDoc): Map<number, 'grace' | 'main'> {
  const gap = useFlam.getState().gap;
  const hit = roleCache.get(doc);
  if (hit && hit.gap === gap) return hit.roles;
  const roles = new Map<number, 'grace' | 'main'>();
  for (const p of findFlamPairs(doc, tempoOf(doc), gap)) {
    roles.set(p.a, 'grace');
    roles.set(p.b, 'main');
  }
  roleCache.set(doc, { gap, roles });
  return roles;
}

/** 選んだチップ（右クリックしたチップ）のフラムの状態 */
export function flamStateOf(ids: readonly number[]) {
  const doc = useEditor.getState().doc;
  return flamState(doc, tempoOf(doc), ids, useFlam.getState().gap);
}

/** チップをフラムにする（もうフラムのチップはそのまま）。変えた組の数を返す */
export function flamChips(ids: readonly number[], opts: { quiet?: boolean } = {}): number {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const o = flamOptions();
  const step = useInputSettings.getState().velStep;
  const st = flamState(s.doc, tempo, ids, o.gap);
  if (st.single.length === 0) {
    if (!opts.quiet)
      toast(
        st.pairs.length
          ? tr('もうフラムになっています（Alt+F で1打に戻せます）', "It's already a flam (Alt+F turns it back into one note)")
          : tr('フラムにするドラムのチップを選んでください', 'Select the drum chips to turn into flams'),
      );
    return 0;
  }
  const fields = Object.keys(s.doc.fields).length;
  let res = { ids: [] as number[], made: 0, crowded: 0, div: 0 };
  edit(st.single.length === 1 ? tr('フラムにする', 'Make flam') : tr(`${st.single.length}個のチップをフラムにする`, `Make ${st.single.length} chips into flams`), (d) => {
    res = opFlam(d, new Set(st.single), tempo, o, step);
  });
  if (res.made > 0) {
    // 2打とも選ぶ（もう一度 Alt+F で1打に戻せる）
    const keep = s.selection.filter((id) => !ids.includes(id));
    useEditor.setState({ selection: [...new Set([...keep, ...res.ids])] });
    // ベロシティ違いの音を足したときは読み込んでおく
    if (Object.keys(useEditor.getState().doc.fields).length !== fields) void prepareSounds();
  }
  if (!opts.quiet) {
    const first = s.doc.chips.find((c) => c.id === st.single[0]);
    const bpm = first ? tempo.bpmAt(tempo.beatOf(first.m, first.f)) : tempo.initialBpm;
    const ms = Math.round(flamMs(res.div, bpm));
    const how = o.side === 'after' ? tr(`2打目は 1/${res.div} 後ろ`, `main note 1/${res.div} later`) : tr(`1打目は 1/${res.div} 前`, `grace note 1/${res.div} earlier`);
    const head =
      res.made > 0
        ? isJa()
          ? `フラムにしました（${res.made > 1 ? `${res.made}か所。` : ''}${how}・約${ms}ms）`
          : `Made ${res.made > 1 ? `${res.made} flams` : 'a flam'} (${how}, about ${ms} ms)`
        : tr('フラムにできませんでした', "Couldn't make a flam");
    const tail =
      res.crowded > 0
        ? tr(`。${res.crowded}か所はすぐ近くに同じレーンのチップがあるので変えていません`, `. Left ${res.crowded} unchanged because another chip on the same lane is too close`)
        : '';
    toast(head + tail, res.made > 0 ? 'ok' : 'warn');
  }
  return res.made;
}

/** フラムを1打に戻す。戻した組の数を返す */
export function unflamChips(ids: readonly number[], opts: { quiet?: boolean } = {}): number {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const o = flamOptions();
  let res = { ids: [] as number[], count: 0 };
  edit(tr('フラムを1打に戻す', 'Turn flam back into one note'), (d) => {
    res = opUnflam(d, new Set(ids), tempo, o);
  });
  if (res.count === 0) {
    if (!opts.quiet) toast(tr('選んだチップにフラム（同じレーンのすばやい2打）がありません', 'The selection has no flams (two quick notes on the same lane)'));
    return 0;
  }
  const alive = new Set(useEditor.getState().doc.chips.map((c) => c.id));
  const keep = s.selection.filter((id) => alive.has(id));
  useEditor.setState({ selection: [...new Set([...keep, ...res.ids])] });
  if (!opts.quiet)
    toast(
      res.count > 1 ? tr(`${res.count}か所のフラムを1打に戻しました`, `Turned ${res.count} flams back into single notes`) : tr('フラムを1打に戻しました', 'Turned the flam back into one note'),
      'ok',
    );
  return res.count;
}

/** Alt+F：選んだチップをフラムにする。選んだのがもう全部フラムなら1打に戻す */
export function toggleFlamSelection() {
  const ids = useEditor.getState().selection;
  if (ids.length === 0) {
    toast(tr('フラムにするチップを選んでから Alt+F を押してください（クリックで置くときは操作バーの「フラム」）', 'Select chips, then press Alt+F (to place flams by clicking, use "Flam" in the toolbar)'));
    return;
  }
  const st = flamStateOf(ids);
  if (st.single.length > 0) flamChips(ids);
  else if (st.pairs.length > 0) unflamChips(ids);
  else toast(tr('フラムにできるのはドラムの（見える）チップです', 'Only visible drum chips can be flams'));
}

// ---- キー入力・録音 ----------------------------------------------------------------

/** キー入力：▶ の所にフラムを置く。もうチップがあれば（フラムなら2打とも）消す */
export function keyFlam(lane: number, alt: boolean, pos: Pos, vel: number) {
  const id = chipAt(lane, alt, pos);
  if (id !== null) {
    const st = flamStateOf([id]);
    deleteChips([...new Set([id, ...st.pairs.flatMap((p) => [p.a, p.b])])]);
    return;
  }
  placeFlam(lane, alt, pos, { vel, select: false, preview: false });
}

interface RecHit {
  take: number;
  sec: number;
  id: number;
  pos: Pos;
  vel: number;
  alt: boolean;
  /** 叩いた強さのベロシティ（電子ドラム）。キーボードや「ベロシティを無視」のときは false で、1打目は設定の割合にする */
  real: boolean;
}

const recLast = new Map<number, RecHit>();

/**
 * 録音：同じレーンをすばやく2回叩いた（グリッドでは分けられない間）ら、フラムにする。
 * フラムにしたら true（呼び出し側は置かない）。そうでなければ false で、置いたあとに recNoted を呼ぶ
 */
export function recFlam(lane: number, alt: boolean, sec: number, pos: Pos, vel: number, take: number, group: string, label: string): boolean {
  const f = useFlam.getState();
  const prev = recLast.get(lane);
  if (!f.rec || !prev || prev.take !== take || prev.alt !== alt) return false;
  const dt = sec - prev.sec;
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const beat = tempo.secToBeat(sec);
  const stepSec = (4 / s.view.div) * (60 / Math.max(1, tempo.bpmAt(beat)));
  // ダブルトリガー（8ms 未満）はフラムにしない。グリッドで分けられる間なら、ふつうに置く
  if (dt < 0.008 || dt > Math.min(FLAM_MAX_SEC, stepSec / 2)) return false;
  recLast.delete(lane);
  const anchor = f.side === 'after' ? prev.pos : pos;
  edit(
    tr('録音でフラムを聞き取る', 'Detect a flam while recording'),
    (d) => {
      opDelete(d, new Set([prev.id]));
    },
    { group },
  );
  placeFlam(lane, alt, anchor, { vel, graceVel: prev.real ? prev.vel : undefined, select: false, preview: false, group, label });
  return true;
}

/** 録音で置いた1打を覚える（次の1打がすばやければフラムにする） */
export function recNoted(lane: number, alt: boolean, sec: number, id: number, pos: Pos, vel: number, take: number, real: boolean) {
  recLast.set(lane, { take, sec, id, pos, vel, alt, real });
}

// ---- 右クリックのメニュー ------------------------------------------------------------

// チップ：フラムにする／1打に戻す（選んでいるチップを右クリックしたら選んでいるもの全部）
addChipMenuItems((ids) => {
  const st = flamStateOf(ids);
  const items: CtxItem[] = [];
  if (st.single.length > 0) {
    items.push({ label: st.single.length > 1 ? tr(`フラムにする（${st.single.length} 個）`, `Make flams (${st.single.length})`) : tr('フラムにする', 'Make flam'), hint: 'Alt+F', run: () => flamChips(ids) });
  }
  if (st.pairs.length > 0) {
    items.push({
      label: st.pairs.length > 1 ? tr(`フラムを1打に戻す（${st.pairs.length} か所）`, `Back to single notes (${st.pairs.length})`) : tr('フラムを1打に戻す', 'Back to one note'),
      hint: 'Alt+F',
      run: () => unflamChips(ids),
    });
  }
  return items;
});

// レーンの何もない所：ここにフラムを置く
addLaneMenuItems((at) => [
  {
    label: tr('ここにフラムを置く', 'Place a flam here'),
    hint: useFlam.getState().mode ? tr('クリック', 'Click') : `${FLAM_MOD_LABEL}+${tr('クリック', 'Click')}`,
    run: () => {
      placeFlam(at.lane, at.alt, at.pos);
    },
  },
]);
