// 曲に合わせてクリック（または T キー）でBPMと小節の頭を合わせる。
//   ・再生中に叩けば、曲の中の時刻で記録するので「小節の頭」まで合わせられる
//   ・止まっているときは間隔からBPMだけを測る
import { tr, isJa } from '../i18n';
import { create } from 'zustand';
import { engine } from '../audio/engine';
import { evaluatePlan, applyPlan, writeSegments, type TempoPlan } from '../assist/tempoPlan';
import { fitTaps, tapBpm, tapPhase, type TapFit } from '../assist/tapTempo';
import { toMeasure } from '../dtx/base36';
import { buildTempoMap } from '../dtx/timing';
import { useInputSettings } from '../input/settings';
import { bgmSource, tempoOf } from './derived';
import { setField } from '../edit/ops';
import { playFrom, setCursorBeat, setView, stop, toast, useEditor } from './editor';
import { setAnchors, setYoutube, useSidecar } from './sidecar';
import { editSong, toastSongEdit, type SongEdit } from './songSync';
import { useTempo } from './tempoUi';

interface Tap {
  perf: number;
  /** 曲の中の時刻（譜面の秒）。止まっているときは null */
  song: number | null;
}

export interface TapState {
  open: boolean;
  taps: Tap[];
  fit: TapFit | null;
  /** すべて再生中に叩いた（小節の頭まで合わせられる） */
  synced: boolean;
  /** 整数のBPMにそろえる */
  round: boolean;
  /** 最初に叩いたのは何拍目か（1〜4） */
  firstBeat: number;
}

export const useTap = create<TapState>(() => ({
  open: false,
  taps: [],
  fit: null,
  synced: false,
  round: true,
  firstBeat: 1,
}));

const get = useTap.getState;
const set = useTap.setState;

/** これより間が空いたら測り直し（秒） */
const GAP = 2.5;

export function openTap(open = true) {
  set({ open });
}

export function clearTaps() {
  set({ taps: [], fit: null, synced: false });
}

function times(taps: Tap[], synced: boolean): number[] {
  return synced ? taps.map((t) => t.song ?? 0) : taps.map((t) => t.perf / 1000);
}

/** 1回叩く。perfMs はイベントの timeStamp（performance.now() と同じ時計） */
export function tapAt(perfMs: number) {
  const playing = useEditor.getState().playing;
  const at = playing ? engine.songSecAtPerf(perfMs) : null;
  const song = at === null ? null : at - useInputSettings.getState().latencyMs / 1000;
  let taps = get().taps;
  const last = taps[taps.length - 1];
  // 同じ打を二度数えない
  if (last && Math.abs(perfMs - last.perf) < 1) return;
  if (last) {
    const gap = (perfMs - last.perf) / 1000 > GAP;
    const modeChanged = (last.song === null) !== (song === null);
    // 曲の中で戻った・飛んだ（ループ・シーク）
    const jumped = song !== null && last.song !== null && (song <= last.song || song - last.song > GAP);
    if (gap || modeChanged || jumped) taps = [];
  }
  taps = [...taps, { perf: perfMs, song }].slice(-64);
  const synced = taps.every((t) => t.song !== null);
  set({ taps, synced, fit: fitTaps(times(taps, synced)) });
}

/** 譜面に入れるBPM */
export function currentTapBpm(s: TapState = get()): number | null {
  return s.fit ? tapBpm(s.fit, s.round) : null;
}

/** 小節の頭まで合わせられるか（再生中に叩いていて、原曲か映像がある） */
export function canAlign(s: TapState = get()): boolean {
  if (!s.fit || !s.synced) return false;
  const doc = useEditor.getState().doc;
  return bgmSource(doc) !== null || useSidecar.getState().youtube !== null;
}

/** 「聴いている音」の時刻（原曲があれば原曲の秒、無ければ映像の秒） */
function refTime(songSec: number): number {
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  if (bgm) return songSec - bgm.sec;
  return songSec + (useSidecar.getState().youtube?.offset ?? 0);
}

function songTimeOf(ref: number): number {
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  if (bgm) return ref + bgm.sec;
  return ref - (useSidecar.getState().youtube?.offset ?? 0);
}

/** 譜面を変える。再生中なら、聴いている音の同じ所から新しい譜面で再生し直す */
function keepPlaying<T>(change: () => T): T {
  const playing = useEditor.getState().playing;
  const sec = playing ? engine.heardSec() : null;
  const ref = sec === null ? null : refTime(sec);
  if (playing) stop();
  const out = change();
  if (ref !== null) {
    const doc = useEditor.getState().doc;
    void playFrom(Math.max(0, tempoOf(doc).secToBeat(songTimeOf(ref))), { keepStart: true });
  }
  return out;
}

/** 今までのアンカーは使えなくなるので消し、テンポ合わせ画面は作り直す */
function resetTempoPage() {
  useTempo.setState({ initialized: false });
}

/** BPMだけ変える（小節の頭はそのまま） */
export function applyTapBpm() {
  const bpm = currentTapBpm();
  if (bpm === null) return;
  const doc = useEditor.getState().doc;
  const changes = tempoOf(doc).events.length > 1;
  const r = keepPlaying(() => {
    // 途中でBPMが変わる譜面は、最初のBPMだけ変える。テンポは曲のものなので、同じテンポだったほかの難易度にも入れる
    const e = changes
      ? editSong(tr(`最初のBPMを ${bpm} にする（タップ）`, `Set the first BPM to ${bpm} (tap)`), (d) => setField(d, 'BPM', String(bpm)))
      : editSong(tr(`BPMを ${bpm} にする（タップ）`, `Set BPM to ${bpm} (tap)`), (d) => writeSegments(d, [{ m: 0, bpm, src: 'base' }]));
    setAnchors([]);
    resetTempoPage();
    return e;
  });
  const text = changes ? tr(`最初のBPMを ${bpm} にしました（途中のBPM変化はそのまま）`, `Set the first BPM to ${bpm} (later BPM changes are kept)`) : tr(`BPMを ${bpm} にしました`, `Set BPM to ${bpm}`);
  void toastSongEdit(r, text, 'ok', 4000);
}

/** BPMと小節の頭を合わせる（最初に叩いた拍が firstBeat 拍目） */
export function applyTapAlign() {
  const s = get();
  const bpm = currentTapBpm(s);
  if (bpm === null || !s.fit || !canAlign(s)) return;
  const p = 60 / bpm;
  const t0 = tapPhase(times(s.taps, true), s.fit, bpm);
  // 次の1拍目（最初に叩いたのが3拍目なら2拍あと）
  const downSong = t0 + ((5 - s.firstBeat) % 4) * p;
  const ref = refTime(downSong);
  const doc = useEditor.getState().doc;
  const bgm = bgmSource(doc);
  let m = 1;
  let edited: SongEdit;
  if (bgm) {
    if (ref < 0) {
      toast(tr('原曲が始まる前を叩いています。曲が鳴っている所で叩いてください', 'Those taps are before the original starts. Tap while the song is playing'), 'warn');
      return;
    }
    let plan: TempoPlan = { bpm, anchors: [{ m: 1, t: ref }] };
    let r = evaluatePlan(doc, plan);
    if (!r.bgm && r.shift > 0) {
      plan = { bpm, anchors: [{ m: 1 + r.shift, t: ref }] };
      r = evaluatePlan(doc, plan);
    }
    if (!r.bgm) {
      toast(tr('原曲（BGM）を置ける位置が見つかりませんでした', "Couldn't find a place to put the original (BGM)"), 'warn');
      return;
    }
    m = plan.anchors[0].m;
    edited = keepPlaying(() => {
      const e = editSong(tr(`BPM ${bpm}・小節の頭を合わせる（タップ）`, `BPM ${bpm}, line up downbeat (tap)`), (d) => applyPlan(d, r, null));
      setAnchors(plan.anchors);
      resetTempoPage();
      return e;
    });
  } else {
    const yt = useSidecar.getState().youtube;
    if (!yt) return;
    // 映像の ref 秒が小節 m の頭に来るように、BPM を一定にしてから映像のずれを決める
    const segs = [{ m: 0, bpm, src: 'base' as const }];
    const tempo = buildTempoMap({
      chips: [],
      barLengths: doc.barLengths,
      fields: { BPM: String(bpm) },
    });
    while (m < 999 && tempo.beatToSec(tempo.measureStart(m)) < ref - 1e-6) m++;
    const offset = Math.round((ref - tempo.beatToSec(tempo.measureStart(m))) * 1000) / 1000;
    edited = keepPlaying(() => {
      const e = editSong(tr(`BPM ${bpm}・小節の頭を合わせる（タップ）`, `BPM ${bpm}, line up downbeat (tap)`), (d) => writeSegments(d, segs));
      setYoutube({ ...yt, offset });
      resetTempoPage();
      return e;
    });
  }
  if (!useEditor.getState().playing) {
    const tempo = tempoOf(useEditor.getState().doc);
    setCursorBeat(tempo.measureStart(m));
    setView({ scrollBeat: Math.max(-1, tempo.measureStart(m) - 2) });
  }
  clearTaps();
  const text = isJa()
    ? `BPM ${bpm}、${s.firstBeat === 1 ? '最初に叩いた拍' : `${s.firstBeat}拍目から数えた次の1拍目`}を小節 ${toMeasure(m)} の頭にしました`
    : `BPM ${bpm}. ${s.firstBeat === 1 ? 'Your first tap' : `The next beat 1 after your first tap (beat ${s.firstBeat})`} is now the start of measure ${toMeasure(m)}`;
  // テンポは曲のものなので、同じテンポだったほかの難易度にも入れる（入れたら知らせに足す）
  void toastSongEdit(edited, text, 'ok', 6000);
}
