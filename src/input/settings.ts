// 入力の設定（キーボードの割り当て、電子ドラムの割り当て、遅延補正）。ブラウザに保存する。
import { create } from 'zustand';

export interface LaneTarget {
  lane: number;
  /** HHオープン・左バスドラム */
  alt: boolean;
}

export interface MidiProfile {
  id: string;
  name: string;
  /** ノート番号 → レーン（1つのレーンに複数のノートを割り当てられる） */
  notes: Record<number, LaneTarget>;
  /** ハイハットの開閉: ノート番号で決める / 叩いた瞬間のペダル（CC4）で決める */
  hhMode: 'note' | 'pedal';
  /** CC4 がこの値以上ならクローズ */
  hhClosedAt: number;
  /** ベロシティを無視して、すべて最大で入力する */
  ignoreVelocity: boolean;
  /** これより弱い入力は無視する（クロストーク対策） */
  minVelocity: number;
}

export interface InputSettings {
  /** KeyboardEvent.code → レーン（Shift で2種目） */
  keys: Record<string, number>;
  profiles: MidiProfile[];
  profileId: string;
  /** 叩いてから届くまでの遅れ（ミリ秒）。録音した位置からこの分を引く */
  latencyMs: number;
  /** 置くベロシティ「強・中・弱」の値 */
  velPresets: [number, number, number];
  /** 書き出しでベロシティをまとめる刻み（1 = まとめない） */
  velStep: number;
  /** 電子ドラムのベロシティの変換カーブ */
  velCurve: 'soft' | 'normal' | 'hard';
  /** 譜面のレーンの並び（左から、DRUM_LANES の番号） */
  laneOrder: number[];
}

export const DEFAULT_LANE_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const isLaneOrder = (a: unknown): a is number[] =>
  Array.isArray(a) && a.length === 10 && [...a].sort((x, y) => x - y).every((v, i) => v === i);

/** レーン順（LC HH LP SD HT BD LT FT CY RD）のキー */
export const DEFAULT_KEYS: Record<string, number> = {
  KeyA: 0,
  KeyS: 1,
  KeyZ: 2,
  KeyD: 3,
  KeyG: 4,
  KeyF: 5,
  KeyH: 6,
  KeyJ: 7,
  KeyK: 8,
  KeyL: 9,
};

const t = (lane: number, alt = false): LaneTarget => ({ lane, alt });

/** General MIDI と、よくある電子ドラム（ボウ・エッジ・リム）の割り当て */
export function gmNotes(): Record<number, LaneTarget> {
  return {
    35: t(5),
    36: t(5),
    37: t(3),
    38: t(3),
    40: t(3),
    42: t(1),
    22: t(1),
    46: t(1, true),
    26: t(1, true),
    44: t(2),
    48: t(4),
    50: t(4),
    45: t(6),
    47: t(6),
    41: t(7),
    43: t(7),
    58: t(7),
    49: t(0),
    55: t(0),
    57: t(8),
    52: t(8),
    51: t(9),
    59: t(9),
    53: t(9),
  };
}

export function newProfile(name: string): MidiProfile {
  return { id: Math.random().toString(36).slice(2, 10), name, notes: gmNotes(), hhMode: 'note', hhClosedAt: 90, ignoreVelocity: true, minVelocity: 8 };
}

const KEY = 'dtxe.input.v1';

function load(): InputSettings {
  const base: InputSettings = { keys: { ...DEFAULT_KEYS }, profiles: [], profileId: '', latencyMs: 0, velPresets: [100, 70, 35], velStep: 5, velCurve: 'normal', laneOrder: [...DEFAULT_LANE_ORDER] };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<InputSettings>;
      if (j.keys && typeof j.keys === 'object') base.keys = j.keys;
      if (Array.isArray(j.profiles)) base.profiles = j.profiles.filter((p) => p && typeof p.id === 'string' && p.notes);
      if (typeof j.profileId === 'string') base.profileId = j.profileId;
      if (Number.isFinite(j.latencyMs)) base.latencyMs = Number(j.latencyMs);
      if (Array.isArray(j.velPresets) && j.velPresets.length === 3 && j.velPresets.every((v) => Number.isFinite(v))) base.velPresets = j.velPresets as [number, number, number];
      if (j.velStep === 1 || j.velStep === 5 || j.velStep === 10) base.velStep = j.velStep;
      if (j.velCurve === 'soft' || j.velCurve === 'normal' || j.velCurve === 'hard') base.velCurve = j.velCurve;
      if (isLaneOrder(j.laneOrder)) base.laneOrder = j.laneOrder;
    }
  } catch {
    // 読めなければ初期値
  }
  if (base.profiles.length === 0) base.profiles = [newProfile('標準（General MIDI）')];
  if (!base.profiles.some((p) => p.id === base.profileId)) base.profileId = base.profiles[0].id;
  return base;
}

export const useInputSettings = create<InputSettings>(() => load());

useInputSettings.subscribe((s) => {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ keys: s.keys, profiles: s.profiles, profileId: s.profileId, latencyMs: s.latencyMs, velPresets: s.velPresets, velStep: s.velStep, velCurve: s.velCurve, laneOrder: s.laneOrder }),
    );
  } catch {
    // 保存できなくても使える
  }
});

export function activeProfile(): MidiProfile {
  const s = useInputSettings.getState();
  return s.profiles.find((p) => p.id === s.profileId) ?? s.profiles[0];
}

export function updateProfile(id: string, p: Partial<MidiProfile>) {
  useInputSettings.setState((s) => ({ profiles: s.profiles.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
}

export function setNote(id: string, note: number, target: LaneTarget | null) {
  useInputSettings.setState((s) => ({
    profiles: s.profiles.map((x) => {
      if (x.id !== id) return x;
      const notes = { ...x.notes };
      if (target) notes[note] = target;
      else delete notes[note];
      return { ...x, notes };
    }),
  }));
}

export function addProfile(copyFrom?: MidiProfile): MidiProfile {
  const p = copyFrom ? { ...copyFrom, notes: { ...copyFrom.notes }, id: newProfile('').id, name: `${copyFrom.name} のコピー` } : newProfile('新しいプロファイル');
  useInputSettings.setState((s) => ({ profiles: [...s.profiles, p], profileId: p.id }));
  return p;
}

export function removeProfile(id: string) {
  useInputSettings.setState((s) => {
    const profiles = s.profiles.filter((p) => p.id !== id);
    if (profiles.length === 0) profiles.push(newProfile('標準（General MIDI）'));
    return { profiles, profileId: profiles.some((p) => p.id === s.profileId) ? s.profileId : profiles[0].id };
  });
}

export function setKey(code: string, lane: number | null) {
  useInputSettings.setState((s) => {
    const keys = { ...s.keys };
    for (const [k, v] of Object.entries(keys)) if (v === lane) delete keys[k];
    if (lane !== null) keys[code] = lane;
    return { keys };
  });
}

/** KeyboardEvent.code を画面に出す文字にする */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'テンキー' + code.slice(6);
  const map: Record<string, string> = { Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=' };
  return map[code] ?? code;
}

/** ノート番号を音名にする（60 = C4） */
export function noteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}

// ---- レーンの並び -----------------------------------------------------------------

/** レーン（DRUM_LANES の番号）が左から何番目に出るか */
export function slotOf(lane: number): number {
  const i = useInputSettings.getState().laneOrder.indexOf(lane);
  return i < 0 ? lane : i;
}

/** 左から slot 番目のレーン */
export function laneAt(slot: number): number | undefined {
  return useInputSettings.getState().laneOrder[slot];
}

/** 画面の並びで d 個となりのレーン（はみ出たら null） */
export function shiftLane(lane: number, d: number): number | null {
  return laneAt(slotOf(lane) + d) ?? null;
}

export function setLaneOrder(order: number[]) {
  if (isLaneOrder(order)) useInputSettings.setState({ laneOrder: [...order] });
}
