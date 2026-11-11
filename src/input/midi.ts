// 電子ドラム（Web MIDI）。ノートをレーンに振り分けて drumHit に渡す。
import { tr } from '../i18n';
import { create } from 'zustand';
import { activeProfile, setNote, type LaneTarget } from './settings';

export interface MidiLast {
  note: number;
  velocity: number;
  target: LaneTarget | null;
  /** 特殊ノーツの種類に行ったノートなら種類の id */
  kind?: string;
  at: number;
}

export interface MidiState {
  status: 'off' | 'unsupported' | 'denied' | 'none' | 'on';
  inputs: { id: string; name: string }[];
  /** 最後に来たノート */
  last: MidiLast | null;
  /** ペダル（CC4）の今の値 */
  pedal: number;
  /** 次に叩いたパッドをこのレーンに割り当てる */
  learn: LaneTarget | null;
  /** 次に叩いたパッドをこの特殊ノーツの種類に割り当てる（種類の id） */
  learnKind: string | null;
}

export const useMidi = create<MidiState>(() => ({ status: 'off', inputs: [], last: null, pedal: 0, learn: null, learnKind: null }));

export type HitHandler = (lane: number, alt: boolean, velocity: number, perfMs: number, source: 'midi' | 'key') => void;

let handler: HitHandler | null = null;

/** 叩いたときの処理を差し込む（エディタが入れる） */
export function setHitHandler(h: HitHandler | null) {
  handler = h;
}

export function emitHit(lane: number, alt: boolean, velocity: number, perfMs: number, source: 'midi' | 'key') {
  handler?.(lane, alt, velocity, perfMs, source);
}

// ---- 特殊ノーツ（クラップなど。store/special・store/hits が入れる） ----------------------------

/** ノートが行く特殊ノーツの種類（無ければ null）。mapped: そのノートをレーンに割り当ててあるか */
export type KindRouter = (note: number, mapped: boolean) => string | null;
export type KindHitHandler = (id: string, velocity: number, perfMs: number, source: 'midi' | 'key') => void;

let kindRouter: KindRouter | null = null;
let kindHandler: KindHitHandler | null = null;
let kindLearned: ((id: string, note: number) => void) | null = null;

export function setKindRouter(r: KindRouter | null) {
  kindRouter = r;
}

export function setKindHitHandler(h: KindHitHandler | null) {
  kindHandler = h;
}

/** 種類にパッドを覚えたときの処理（種類の決めにノートを書く） */
export function setKindLearned(fn: ((id: string, note: number) => void) | null) {
  kindLearned = fn;
}

export function emitKindHit(id: string, velocity: number, perfMs: number, source: 'midi' | 'key') {
  kindHandler?.(id, velocity, perfMs, source);
}

/** 次に叩いたパッドを特殊ノーツの種類 id に割り当てる（null でやめる） */
export function startLearnKind(id: string | null) {
  useMidi.setState({ learnKind: id, learn: null });
  if (id) void enableMidi();
}

let access: MIDIAccess | null = null;

function refreshInputs() {
  if (!access) return;
  const inputs: { id: string; name: string }[] = [];
  access.inputs.forEach((inp) => {
    inputs.push({ id: inp.id, name: inp.name || inp.manufacturer || tr('MIDI機器', 'MIDI device') });
    inp.onmidimessage = onMessage;
  });
  useMidi.setState({ inputs, status: inputs.length ? 'on' : 'none' });
}

const HH_NOTES = new Set([42, 46, 22, 26]);

function onMessage(e: MIDIMessageEvent) {
  const d = e.data;
  if (!d || d.length < 2) return;
  const type = d[0] & 0xf0;
  if (type === 0xb0 && d[1] === 4) {
    useMidi.setState({ pedal: d[2] ?? 0 });
    return;
  }
  // ポリフォニックキープレッシャー（一部の機器はHHペダルの位置をここで送る）は使わない
  if (type !== 0x90) return;
  const note = d[1];
  const vel = d[2] ?? 0;
  if (vel === 0) return; // ノートオフ
  const m = useMidi.getState();
  const prof = activeProfile();
  if (m.learnKind) {
    const id = m.learnKind;
    useMidi.setState({ learnKind: null, last: { note, velocity: vel, target: null, kind: id, at: performance.now() } });
    kindLearned?.(id, note);
    return;
  }
  if (m.learn) {
    setNote(prof.id, note, m.learn);
    useMidi.setState({ learn: null, last: { note, velocity: vel, target: m.learn, at: performance.now() } });
    return;
  }
  const v = prof.ignoreVelocity ? 1 : vel / 127;
  // 特殊ノーツ（クラップなど）：種類で覚えたノートはレーンより先、決まった種類のノート（GM の 39 など）はレーンに無いときだけ
  const kind = kindRouter?.(note, prof.notes[note] !== undefined) ?? null;
  if (kind) {
    useMidi.setState({ last: { note, velocity: vel, target: null, kind, at: performance.now() } });
    if (vel >= prof.minVelocity) emitKindHit(kind, v, e.timeStamp || performance.now(), 'midi');
    return;
  }
  let target: LaneTarget | null = prof.notes[note] ?? null;
  if (target && target.lane === 1 && prof.hhMode === 'pedal' && HH_NOTES.has(note)) {
    target = { lane: 1, alt: m.pedal < prof.hhClosedAt };
  }
  useMidi.setState({ last: { note, velocity: vel, target, at: performance.now() } });
  if (!target || vel < prof.minVelocity) return;
  emitHit(target.lane, target.alt, v, e.timeStamp || performance.now(), 'midi');
}

/** 電子ドラムをつなぐ（ブラウザが許可を聞く） */
export async function enableMidi(): Promise<void> {
  if (access) {
    refreshInputs();
    return;
  }
  if (!('requestMIDIAccess' in navigator)) {
    useMidi.setState({ status: 'unsupported' });
    return;
  }
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    access.onstatechange = () => refreshInputs();
    refreshInputs();
  } catch {
    useMidi.setState({ status: 'denied' });
  }
}

export function startLearn(t: LaneTarget | null) {
  useMidi.setState({ learn: t, learnKind: null });
  if (t) void enableMidi();
}

/** 前に許可していれば、聞かずにつなぐ */
export async function autoEnableMidi() {
  try {
    if (!('requestMIDIAccess' in navigator) || !navigator.permissions) return;
    const st = await navigator.permissions.query({ name: 'midi' as PermissionName });
    if (st.state === 'granted') await enableMidi();
  } catch {
    // 調べられないブラウザでは何もしない
  }
}

