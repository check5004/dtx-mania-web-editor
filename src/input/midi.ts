// 電子ドラム（Web MIDI）。ノートをレーンに振り分けて drumHit に渡す。
import { tr } from '../i18n';
import { create } from 'zustand';
import { activeProfile, setNote, type LaneTarget } from './settings';

export interface MidiLast {
  note: number;
  velocity: number;
  target: LaneTarget | null;
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
}

export const useMidi = create<MidiState>(() => ({ status: 'off', inputs: [], last: null, pedal: 0, learn: null }));

export type HitHandler = (lane: number, alt: boolean, velocity: number, perfMs: number, source: 'midi' | 'key') => void;

let handler: HitHandler | null = null;

/** 叩いたときの処理を差し込む（エディタが入れる） */
export function setHitHandler(h: HitHandler | null) {
  handler = h;
}

export function emitHit(lane: number, alt: boolean, velocity: number, perfMs: number, source: 'midi' | 'key') {
  handler?.(lane, alt, velocity, perfMs, source);
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
  if (m.learn) {
    setNote(prof.id, note, m.learn);
    useMidi.setState({ learn: null, last: { note, velocity: vel, target: m.learn, at: performance.now() } });
    return;
  }
  let target: LaneTarget | null = prof.notes[note] ?? null;
  if (target && target.lane === 1 && prof.hhMode === 'pedal' && HH_NOTES.has(note)) {
    target = { lane: 1, alt: m.pedal < prof.hhClosedAt };
  }
  useMidi.setState({ last: { note, velocity: vel, target, at: performance.now() } });
  if (!target || vel < prof.minVelocity) return;
  const v = prof.ignoreVelocity ? 1 : vel / 127;
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
  useMidi.setState({ learn: t });
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

