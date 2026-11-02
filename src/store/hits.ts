// 叩いた（キー・電子ドラム）ときの処理。マウス入力では試し打ち、キー入力ではカーソル位置に置く、
// 録音では再生中の位置に置く（グリッドに吸着、ループ毎に重ね録り）。
import { engine } from '../audio/engine';
import { kitByChannel, loadKit } from '../audio/kit';
import { DRUM_LANES } from '../dtx/model';
import { snapToGrid } from '../edit/ops';
import { emitHit, setHitHandler } from '../input/midi';
import { useInputSettings } from '../input/settings';
import { loopSec, useAssist } from './assist';
import { tempoOf } from './derived';
import { chipAt, deleteChips, onPlayback, placeChips, useEditor, wavForLane } from './editor';

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
  const no = wavForLane(lane, alt);
  if (no !== null && engine.has(no)) {
    engine.preview(no, gain);
    return;
  }
  const def = DRUM_LANES[lane];
  const ch = alt && def.alt !== undefined ? def.alt : def.main;
  const kit = kitByChannel.get(ch);
  if (!kit) return;
  void loadKit().then((m) => {
    const buf = m.get(kit.file.toLowerCase());
    if (buf) engine.previewBuffer(buf, gain);
  });
}

function onHit(lane: number, alt: boolean, velocity: number, perfMs: number) {
  const s = useEditor.getState();
  if (s.screen !== 'editor' || s.page !== 'chart') {
    previewLane(lane, alt, velocity);
    return;
  }
  const a = useAssist.getState();
  // 再生中は譜面の音が鳴るので、録音のときも叩いた音はすぐ鳴らす
  previewLane(lane, alt, velocity);
  if (a.inputMode === 'key') {
    const tempo = tempoOf(s.doc);
    const pos = snapToGrid(tempo, s.cursorBeat, s.view.div);
    const id = chipAt(lane, alt, pos);
    if (id !== null) deleteChips([id]);
    else placeChips([{ lane, alt, pos }], { select: false });
    return;
  }
  if (a.inputMode === 'rec' && engine.playing) {
    const tempo = tempoOf(s.doc);
    let sec = engine.songSecAtPerf(perfMs);
    if (sec === null) return;
    sec -= useInputSettings.getState().latencyMs / 1000;
    const loop = loopSec(s.doc, a.loop);
    if (loop) {
      // ループの頭に戻った直後は、補正で前の周回の終わりに入ることがある
      const len = loop.to - loop.from;
      while (sec < loop.from - 1e-6) sec += len;
      while (sec >= loop.to) sec -= len;
    }
    if (sec < 0) return;
    const beat = tempo.secToBeat(sec);
    let pos = snapToGrid(tempo, beat, s.view.div);
    if (loop && a.loop && tempo.beatOf(pos.m, pos.f) >= a.loop.b - 1e-9) {
      // 吸着でループの終わりを越えたら、ループの頭
      pos = snapToGrid(tempo, a.loop.a, s.view.div);
    }
    takeHits++;
    placeChips([{ lane, alt, pos }], { label: `録音で ${takeHits} 打を置く`, group: `rec-${take}`, select: false });
  }
}

setHitHandler((lane, alt, velocity, perfMs) => onHit(lane, alt, velocity, perfMs));

/** キーボードで叩く。割り当てたキーなら true */
export function keyHit(e: KeyboardEvent): boolean {
  const lane = useInputSettings.getState().keys[e.code];
  if (lane === undefined) return false;
  if (e.repeat) return true;
  emitHit(lane, e.shiftKey, 1, e.timeStamp || performance.now(), 'key');
  return true;
}
