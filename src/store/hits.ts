// 叩いた（キー・電子ドラム）ときの処理。マウス入力では試し打ち、キー入力ではカーソル位置に置く、
// 録音では再生中の位置に置く（グリッドに吸着、ループ毎に重ね録り）。
import { tr, pl } from '../i18n';
import { engine } from '../audio/engine';
import { virtualSound } from '../audio/sounds';
import { laneVoice } from '../dtx/model';
import { kindVoice } from '../dtx/kinds';
import { snapToGrid, type Pos } from '../edit/ops';
import { emitHit, emitKindHit, setHitHandler, setKindHitHandler } from '../input/midi';
import { midiToVel } from '../edit/velocity';
import { useInputSettings } from '../input/settings';
import { loopSec, useAssist } from './assist';
import { tempoOf } from './derived';
import { chipAt, currentKitFile, deleteChips, onPlayback, placeChips, useEditor, wavForLane } from './editor';
import { placeVel } from './velocity';
import { keyFlam, recFlam, recNoted, useFlam } from './flam';
import { kindForKey, kindSoundNo, placeSpecial, specialChipAt } from './special';

let take = 0;
let takeHits = 0;

onPlayback((e) => {
  if (e.type === 'play') {
    take++;
    takeHits = 0;
  }
});

/** その レーンの音を鳴らす（譜面で使っている音、無ければ内蔵キット） */
export function previewLane(lane: number, alt: boolean, gain = 1) {
  previewVoice(laneVoice(lane, alt), wavForLane(lane, alt), gain);
}

/** 特殊ノーツの種類の音を鳴らす（譜面で使っている音、無ければ内蔵キット） */
export function previewKind(id: string, gain = 1) {
  const voice = kindVoice(id);
  if (voice !== null) previewVoice(voice, kindSoundNo(id), gain);
}

/** 音の番号 voice の音を鳴らす。no は譜面の WAV 番号（読み込んであればそれ、無ければ内蔵キット） */
function previewVoice(voice: number, no: number | null, gain: number) {
  // 出力は叩いた操作の中で用意する（内蔵キットの音は読み込みを待つので、その前に。Safari。docs/safari.md）
  engine.ensure();
  if (no !== null && engine.has(no)) {
    engine.preview(no, gain);
    return;
  }
  // キットの音（リムはリムの音、クラップはクラップの音）
  const file = currentKitFile(voice);
  const v = file ? virtualSound(file) : null;
  if (!v) return;
  void v.load().then((buf) => {
    if (buf) engine.previewBuffer(buf, gain);
  });
}

function onHit(lane: number, alt: boolean, velocity: number, perfMs: number, source: 'midi' | 'key') {
  const s = useEditor.getState();
  // キーボードは操作バーで選んだベロシティ、電子ドラムは叩いたベロシティ（変換カーブ）
  const vel = source === 'midi' ? midiToVel(velocity, useInputSettings.getState().velCurve) : placeVel();
  if (s.screen !== 'editor' || s.page !== 'chart') {
    previewLane(lane, alt, vel / 100);
    return;
  }
  const a = useAssist.getState();
  // 再生中は譜面の音が鳴るので、録音のときも叩いた音はすぐ鳴らす
  previewLane(lane, alt, vel / 100);
  if (a.inputMode === 'key') {
    const tempo = tempoOf(s.doc);
    const pos = snapToGrid(tempo, s.cursorBeat, s.view.div);
    // 操作バーの「フラム」がオンなら、フラムで置く（もうあれば消す）
    if (useFlam.getState().mode) {
      keyFlam(lane, alt, pos, vel);
      return;
    }
    const id = chipAt(lane, alt, pos);
    if (id !== null) deleteChips([id]);
    else placeChips([{ lane, alt, pos, vel }], { select: false });
    return;
  }
  if (a.inputMode === 'rec' && engine.playing) recordHit(lane, alt, vel, perfMs, useInputSettings.getState().latencyMs, source === 'midi' && velocity < 1);
}

/** 再生を始めた時刻（performance.now）と、その時の曲の位置（秒）。ループの何周目かを知るため */
let playPerf = 0;
let playSec = 0;
onPlayback((e) => {
  if (e.type !== 'play') return;
  playPerf = performance.now();
  playSec = engine.songSecAtPerf(playPerf) ?? 0;
});

/**
 * ループで再生しているとき、叩いた時刻が最初の1周を越えているか（「ループ中は重ねて録る」をオフにしたとき、2周目からは置かない）
 */
export function pastFirstLoop(perfMs: number): boolean {
  const s = useEditor.getState();
  const loop = loopSec(s.doc, useAssist.getState().loop);
  if (!loop) return false;
  const elapsed = ((perfMs - playPerf) / 1000) * useAssist.getState().speed;
  return playSec + elapsed > loop.to + 0.05;
}

/**
 * 録音で置く所：叩いた時刻（perfMs）から latencyMs を引いた所を、グリッドに吸着する（ループの中に戻す）。sec は曲の秒。置けなければ null
 */
function recPos(perfMs: number, latencyMs: number): { pos: Pos; sec: number } | null {
  const s = useEditor.getState();
  const a = useAssist.getState();
  if (!engine.playing) return null;
  const tempo = tempoOf(s.doc);
  let sec = engine.songSecAtPerf(perfMs);
  if (sec === null) return null;
  sec -= latencyMs / 1000;
  const loop = loopSec(s.doc, a.loop);
  if (loop) {
    // ループの頭に戻った直後は、補正で前の周回の終わりに入ることがある
    const len = loop.to - loop.from;
    while (sec < loop.from - 1e-6) sec += len;
    while (sec >= loop.to) sec -= len;
  }
  if (sec < 0) return null;
  const beat = tempo.secToBeat(sec);
  let pos = snapToGrid(tempo, beat, s.view.div);
  if (loop && a.loop && tempo.beatOf(pos.m, pos.f) >= a.loop.b - 1e-9) {
    // 吸着でループの終わりを越えたら、ループの頭
    pos = snapToGrid(tempo, a.loop.a, s.view.div);
  }
  return { pos, sec };
}

/**
 * 録音：叩いた時刻（perfMs）から latencyMs を引いた所を、グリッドに吸着して置く（ループ毎に重ね録り）。
 * soft: 電子ドラムで叩いたベロシティ（フラムの1打目をその強さのままにする）
 */
export function recordHit(lane: number, alt: boolean, vel: number, perfMs: number, latencyMs: number, soft = false) {
  const at = recPos(perfMs, latencyMs);
  if (!at) return;
  const { pos, sec } = at;
  takeHits++;
  const label = tr(`録音で ${takeHits} 打を置く`, `Record ${takeHits} ${pl(takeHits, 'hit')}`);
  // 同じレーンをすばやく2回（グリッドでは分けられない間）叩いたら、フラムにする
  if (recFlam(lane, alt, sec, pos, vel, take, `rec-${take}`, label)) return;
  const [id] = placeChips([{ lane, alt, pos, vel }], { label, group: `rec-${take}`, select: false });
  // 電子ドラムの強さで叩いたベロシティなら、フラムの1打目はその強さのまま（キーボードは設定の割合）
  if (id !== undefined) recNoted(lane, alt, sec, id, pos, vel, take, soft);
}

/** 録音：特殊ノーツ（クラップなど）を叩いた所に置く（行き先のレーンにもうチップがあれば置かない） */
export function recordKindHit(id: string, vel: number, perfMs: number, latencyMs: number) {
  const at = recPos(perfMs, latencyMs);
  if (!at) return;
  takeHits++;
  const label = tr(`録音で ${takeHits} 打を置く`, `Record ${takeHits} ${pl(takeHits, 'hit')}`);
  placeSpecial(id, at.pos, { vel, group: `rec-${take}`, label, quiet: true });
}

/** 特殊ノーツの種類を叩いた（キー・電子ドラム）。試し打ちでは鳴らすだけ、キー入力ではカーソルに置く（もうあれば消す）、録音では叩いた所に置く */
function onKindHit(id: string, velocity: number, perfMs: number, source: 'midi' | 'key') {
  const s = useEditor.getState();
  const vel = source === 'midi' ? midiToVel(velocity, useInputSettings.getState().velCurve) : placeVel();
  previewKind(id, vel / 100);
  if (s.screen !== 'editor' || s.page !== 'chart') return;
  const a = useAssist.getState();
  if (a.inputMode === 'key') {
    const pos = snapToGrid(tempoOf(s.doc), s.cursorBeat, s.view.div);
    const there = specialChipAt(id, pos);
    if (there !== null) deleteChips([there]);
    else placeSpecial(id, pos, { vel });
    return;
  }
  if (a.inputMode === 'rec' && engine.playing) recordKindHit(id, vel, perfMs, useInputSettings.getState().latencyMs);
}

setHitHandler((lane, alt, velocity, perfMs, source) => onHit(lane, alt, velocity, perfMs, source));
setKindHitHandler((id, velocity, perfMs, source) => onKindHit(id, velocity, perfMs, source));

/** キーボードで叩く。割り当てたキー（レーン・特殊ノーツの種類）なら true */
export function keyHit(e: KeyboardEvent): boolean {
  const lane = useInputSettings.getState().keys[e.code];
  // 特殊ノーツ（クラップは Q など）。種類で決めたキーはレーンのキーより先
  const kind = kindForKey(e.code, lane !== undefined);
  if (kind) {
    if (!e.repeat) emitKindHit(kind, 1, e.timeStamp || performance.now(), 'key');
    return true;
  }
  if (lane === undefined) return false;
  if (e.repeat) return true;
  emitHit(lane, e.shiftKey, 1, e.timeStamp || performance.now(), 'key');
  return true;
}
