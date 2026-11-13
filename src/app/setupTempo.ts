// おまかせで準備で決めたテンポを、クリックと一緒に聴いて直す（準備中の画面と、エディタの「準備ができました」の帯）。
// 直した分はすぐ譜面に入れる（テンポ合わせの案を作り直して反映する）。小節番号は、BGM を置けるいちばん小さい番号にそろえる
// （推定と同じ。曲の頭より前の小節は、原曲の頭を置くための空きの小節）。
// 聴くのは押した操作の中で鳴らし始める（playPlan の頭で engine.ensure。Safari の決まり）。
import { evaluatePlan, normalizeAnchors } from '../assist/tempoPlan';
import { toast, useEditor } from '../store/editor';
import { applyTempo, playAudioSec, playPlan, stopPlan, updateBeats, useTempo } from '../store/tempoUi';
import { tr } from '../i18n';
import { refreshTempoStep } from './setup';

/** 案の曲の頭（いちばん前のアンカー）と BPM。曲の頭が 1 つだけのとき（途中でテンポが変わる案は、テンポ合わせで直す） */
export function simpleHead(): { m: number; t: number; bpm: number } | null {
  const s = useTempo.getState();
  const anchors = normalizeAnchors(s.plan.anchors);
  if (anchors.length !== 1) return null;
  return { ...anchors[0], bpm: s.plan.bpm };
}

/** 聴き始める所（曲の頭の 1 小節前。原曲の秒） */
function listenFrom(h: { t: number; bpm: number }): number {
  return Math.max(0, h.t - 240 / h.bpm);
}

/** BPM と曲の頭（原曲の秒）を決めて譜面に入れる。聴いていたら、今の所から聴き直す */
function put(bpm: number, t: number) {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) return;
  const r = evaluatePlan(useEditor.getState().doc, { bpm, anchors: [{ m: 1, t }] });
  const plan = { bpm: Math.round(bpm * 1000) / 1000, anchors: [{ m: 1 + r.shift, t }] };
  const playing = useTempo.getState().playing;
  const at = playing ? playAudioSec() : null;
  useTempo.setState({ plan, touched: true, fromEstimate: false });
  updateBeats();
  if (!applyTempo({ quiet: true })) {
    toast(tr('このテンポでは原曲（BGM）を置けませんでした。テンポ合わせで直してください', "Couldn't place the original (BGM) with this tempo. Fix it in Tempo"), 'warn', 6000);
    return;
  }
  refreshTempoStep();
  if (playing) playPlan(at ?? listenFrom({ t, bpm }));
}

/** BPM を 2 倍・半分にする（曲の頭はそのまま） */
export function scaleTempo(k: 2 | 0.5) {
  const h = simpleHead();
  if (h) put(h.bpm * k, h.t);
}

/** 曲の頭を 1 拍前（-1）・後ろ（1）にずらす */
export function shiftHead(beats: 1 | -1) {
  const h = simpleHead();
  if (h) put(h.bpm, h.t + (beats * 60) / h.bpm);
}

/** クリックと一緒に聴く・止める（曲の頭の 1 小節前から） */
export function toggleListen() {
  if (useTempo.getState().playing) {
    stopPlan();
    return;
  }
  const h = simpleHead() ?? (() => {
    const s = useTempo.getState();
    const a = normalizeAnchors(s.plan.anchors)[0];
    return a ? { ...a, bpm: s.plan.bpm } : null;
  })();
  playPlan(h ? listenFrom(h) : 0);
}
