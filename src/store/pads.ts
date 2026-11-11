// タブレットの入力パッド。押した瞬間に鳴らし、入力のしかた（試し打ち・ステップ・録音）で譜面に置く。
// - 試し打ち：鳴らすだけ
// - ステップ：▶ に置いて 1グリッド進む。同時に押したパッドは同じ位置に置き、指を全部離したら進む
// - 録音：再生しながら叩いた所をグリッドに吸着して置く（パッドの遅れは設定で別に補正）
// 入力のしかたはキーボード・電子ドラムと同じ（試し打ち＝マウス、ステップ＝キー、録音＝録音）
import { tr } from '../i18n';
import { engine } from '../audio/engine';
import { gridStep, snapToGrid } from '../edit/ops';
import type { Pos } from '../edit/ops';
import { setInputMode, useAssist, type InputMode } from './assist';
import { tempoOf, chipViews, viewsInRange } from './derived';
import { useDevice } from './device';
import { chipAt, deleteChips, placeChips, playFrom, setCursorBeat, setView, stop, togglePlay, toast, useEditor } from './editor';
import { keyFlam, useFlam } from './flam';
import { pastFirstLoop, previewKind, previewLane, recordHit, recordKindHit } from './hits';
import { placeSpecial, specialChipAt } from './special';
import { placeVel } from './velocity';

export type PadMode = 'aud' | 'step' | 'rec';

export function padModeOf(m: InputMode): PadMode {
  return m === 'key' ? 'step' : m === 'rec' ? 'rec' : 'aud';
}

export function setPadMode(m: PadMode) {
  setInputMode(m === 'step' ? 'key' : m === 'rec' ? 'rec' : 'mouse');
}

/** 押している指の数（ステップで、同時に押したパッドを同じ位置に置く） */
let held = 0;
let chordPos: Pos | null = null;
let chordGroup = '';

/** 譜面で見えている拍の範囲を返す関数（譜面の部品が渡す。▶ が見えなくなったらスクロールする） */
let visible: (() => { from: number; to: number }) | null = null;
export function setPadViewport(fn: (() => { from: number; to: number }) | null) {
  visible = fn;
}

function keepCursorVisible(beat: number) {
  const vis = visible?.();
  if (!vis) return;
  const span = vis.to - vis.from;
  if (beat > vis.to - span * 0.15 || beat < vis.from + span * 0.05) setView({ scrollBeat: Math.max(-1, beat - span * 0.3), follow: false });
}

/** ▶ を1グリッド動かす（dir: 1 で先へ、-1 で戻る）。from を渡せばその位置から */
export function stepCursor(dir: 1 | -1, from?: Pos) {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const p = from ?? snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
  const step = gridStep(s.view.div);
  const nb = Math.max(0, tempo.beatOf(p.m, p.f) + (dir * step.n) / step.d);
  setCursorBeat(nb);
  keepCursorVisible(nb);
}

/** パッドを押した（指が触れた瞬間）。perfMs: 押した時刻（PointerEvent の timeStamp） */
export function padDown(lane: number, alt: boolean, perfMs: number) {
  const vel = placeVel();
  previewLane(lane, alt, vel / 100);
  const s = useEditor.getState();
  if (s.screen !== 'editor' || s.page !== 'chart') return;
  const mode = useAssist.getState().inputMode;
  if (mode === 'key') {
    const tempo = tempoOf(s.doc);
    const dev = useDevice.getState();
    if (!dev.stepChord) {
      // 同時押しをまとめない：1つずつ ▶ に置いて、すぐ進む
      const p = snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
      if (useFlam.getState().mode) keyFlam(lane, alt, p, vel);
      else if (chipAt(lane, alt, p) === null) placeChips([{ lane, alt, pos: p, vel }], { select: false, preview: false });
      if (dev.stepAdvance) stepCursor(1, p);
      return;
    }
    if (held === 0 || !chordPos) {
      chordPos = snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
      chordGroup = `pad-step-${Date.now()}`;
    }
    held++;
    if (useFlam.getState().mode) {
      keyFlam(lane, alt, chordPos, vel);
      return;
    }
    // もう同じチップがあれば置かない（消すのは ▶ の🗑 か元に戻す）
    if (chipAt(lane, alt, chordPos) === null) placeChips([{ lane, alt, pos: chordPos, vel }], { select: false, group: chordGroup, preview: false });
    return;
  }
  if (mode === 'rec') {
    if (!engine.playing) return;
    // カウントインの間は録らない（頭の拍に少し早く入った分は残す）
    if (perfMs < countInEnd - 120) return;
    if (!useDevice.getState().recOverdub && pastFirstLoop(perfMs)) return;
    recordHit(lane, alt, vel, perfMs, useDevice.getState().padLatencyMs);
  }
}

/**
 * 特殊ノーツ（クラップなど）のパッドを押した。レーンのパッドと同じく、試し打ちは鳴らすだけ、ステップは ▶ に置く（同時に押したパッドと同じ位置）、
 * 録音は叩いた所に置く。もうその種類のチップがあれば置かない。離したら padUp
 */
export function padKindDown(id: string, perfMs: number) {
  const vel = placeVel();
  previewKind(id, vel / 100);
  const s = useEditor.getState();
  if (s.screen !== 'editor' || s.page !== 'chart') return;
  const mode = useAssist.getState().inputMode;
  if (mode === 'key') {
    const tempo = tempoOf(s.doc);
    const dev = useDevice.getState();
    if (!dev.stepChord) {
      const p = snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
      if (specialChipAt(id, p) === null) placeSpecial(id, p, { vel });
      if (dev.stepAdvance) stepCursor(1, p);
      return;
    }
    if (held === 0 || !chordPos) {
      chordPos = snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
      chordGroup = `pad-step-${Date.now()}`;
    }
    held++;
    if (specialChipAt(id, chordPos) === null) placeSpecial(id, chordPos, { vel, group: chordGroup });
    return;
  }
  if (mode === 'rec') {
    if (!engine.playing) return;
    if (perfMs < countInEnd - 120) return;
    if (!useDevice.getState().recOverdub && pastFirstLoop(perfMs)) return;
    recordKindHit(id, vel, perfMs, useDevice.getState().padLatencyMs);
  }
}

/** パッドから指を離した。ステップでは、指を全部離したら1グリッド進む */
export function padUp() {
  if (useAssist.getState().inputMode !== 'key') {
    held = 0;
    return;
  }
  if (held === 0) return;
  held--;
  if (held > 0 || !chordPos) return;
  const p = chordPos;
  chordPos = null;
  if (useDevice.getState().stepAdvance) stepCursor(1, p);
}

/** ステップ：▶ の位置のチップを消す（ドラムのチップ全部と特殊ノーツ） */
export function clearAtCursor() {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const p = snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
  const b = tempo.beatOf(p.m, p.f);
  const ids = viewsInRange(chipViews(s.doc), b - 1e-6, b + 1e-6)
    .filter((v) => v.col >= 0 || v.sp !== undefined)
    .map((v) => v.c.id);
  if (ids.length === 0) {
    toast(tr('▶ の所にチップはありません', 'No chips at ▶'), 'info', 2500);
    return;
  }
  deleteChips(ids);
}

/** カウントインが終わる時刻（performance.now()）。この前に叩いた分は録らない */
let countInEnd = 0;
let countInTimer = 0;

/**
 * 録音を始める（▶ から再生しながら録る）・止める。
 * カウントインがオンなら ▶ の1小節前から、クリックを鳴らしながら再生する（▶ は動かさない。曲の頭・ループの中では前へ戻れないので、最初の1小節にクリックを重ねる）
 */
export function toggleRecording() {
  window.clearTimeout(countInTimer);
  if (useEditor.getState().playing) {
    engine.setForceClick(false);
    countInEnd = 0;
    stop();
    return;
  }
  setPadMode('rec');
  if (!useDevice.getState().countIn) {
    countInEnd = 0;
    togglePlay();
    return;
  }
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  const cur = Math.max(0, s.cursorBeat);
  const m = tempo.locate(cur).m;
  const from = Math.max(0, cur - tempo.measureBeats(Math.max(0, m - 1)));
  const rate = useAssist.getState().speed || 1;
  const ms = ((tempo.beatToSec(cur) - tempo.beatToSec(from)) / rate) * 1000;
  const clickMs = ms > 1 ? ms : ((tempo.beatToSec(tempo.measureStart(m + 1)) - tempo.beatToSec(tempo.measureStart(m))) / rate) * 1000;
  engine.setForceClick(true);
  countInEnd = Infinity;
  void playFrom(from, { keepStart: true }).then(() => {
    // 音の準備を待ってから再生が始まるので、カウントインの終わりはここから数える
    countInEnd = performance.now() + ms;
    countInTimer = window.setTimeout(() => engine.setForceClick(false), clickMs + 60);
  });
}

/** ステップの ↑（休み：置かずに進む） */
export const stepRest = () => stepCursor(1);
/** ステップの ↓（戻る） */
export const stepBack = () => stepCursor(-1);

