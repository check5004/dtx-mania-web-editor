// YouTube の参照映像と原曲のずれを自動で合わせる（ボタン一つ、または動画を読み込んだとき）。
//
// 1. 「このタブを共有」でタブの音を受け取る（YouTube の音は直接読めないため。Chrome・Edge）
// 2. エンジンから小さなクリックを 4 回鳴らし、タブの音が届くまでの遅れ（Δ）を測る（2 回以上そろった値）
// 3. 動画の何か所か（nextProbe が決める。ふつう 3 か所、ライブ・編集違いは 5 か所まで）を 8 秒ずつ再生して聞き取る。
//    聞き取った音の頭が動画の何秒かは、聞いているあいだの getCurrentTime と、出力の時刻（getOutputTimestamp）から決める
// 4. ワーカーで原曲の全体と比べ（打点・音色・和音）、decideOffset で結果をまとめてずれ（と所ごとの差）を入れる
// 合わせているあいだは再生との同期を止め、終わったら動画の音・音量・聴く音を元に戻す。
import { create } from 'zustand';
import { decideOffset, nextProbe, PROBE_SEC, type AlignDecision, type ProbeResult } from '../audio/align';
import { engine } from '../audio/engine';
import { canCaptureTab, CaptureError, clickCluster, findClickDelay, PcmRecorder, requestTabAudio, scheduleClicks, stopStream } from '../audio/tabCapture';
import * as wk from '../audio/workerClient';
import { bgmSource } from '../store/derived';
import { stop as stopPlayback, useEditor } from '../store/editor';
import { setYoutube, useSidecar, type YoutubeRef } from '../store/sidecar';
import { holdSync, useYt, ytDuration, ytPlayer, type YTPlayer } from './youtube';

export type AlignPhase = 'idle' | 'asking' | 'prep' | 'calib' | 'listen' | 'think' | 'done' | 'failed';

export interface AlignResult {
  dec: AlignDecision;
  /** 合わせる前の参照映像（元に戻すため） */
  prev: YoutubeRef;
  url: string;
  /** 遅れをクリックで測れたか（測れなければ数十 ms ずれることがある） */
  precise: boolean;
  /** 聞き取った回数 */
  probes: number;
}

export interface AlignUiState {
  phase: AlignPhase;
  /** 何か所目を聞いているか */
  probe: number;
  note: string;
  error: string | null;
  last: AlignResult | null;
  /** 動画を読み込んだら自動で合わせる */
  autoOnLoad: boolean;
}

const AUTO_KEY = 'dtxe.ytauto.v1';
function loadAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== '0';
  } catch {
    return true;
  }
}

export const useYtAlign = create<AlignUiState>(() => ({ phase: 'idle', probe: 0, note: '', error: null, last: null, autoOnLoad: loadAuto() }));
const set = useYtAlign.setState;

export function setAutoOnLoad(v: boolean) {
  set({ autoOnLoad: v });
  try {
    localStorage.setItem(AUTO_KEY, v ? '1' : '0');
  } catch {
    // 覚えられなくても動く
  }
}

/** 自動で合わせられるか（できなければ理由） */
export function alignBlocker(): string | null {
  if (!canCaptureTab()) return '自動で合わせるのは Chrome・Edge で使えます（このタブの音を聞き取るため）';
  const bgm = bgmSource(useEditor.getState().doc);
  if (!bgm || !engine.buffer(bgm.wav)) return '原曲の音声ファイルが読み込めていません';
  return null;
}

export function aligning(): boolean {
  const p = useYtAlign.getState().phase;
  return p !== 'idle' && p !== 'done' && p !== 'failed';
}

class Abort extends Error {}

let abortReason: string | null = null;
let running = false;

/** 合わせるのをやめる */
export function cancelAutoAlign(reason = 'やめました') {
  if (running) abortReason = reason;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function check() {
  if (abortReason !== null) throw new Abort(abortReason);
}

/** いま耳に届いている所の AudioContext の時刻（出力の時刻） */
function heardCtxNow(ctx: AudioContext): number {
  const now = performance.now();
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
  if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0 && ts.contextTime > 0) {
    return ts.contextTime + (now - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

async function waitPlayer(ms: number): Promise<YTPlayer> {
  const t0 = performance.now();
  for (;;) {
    check();
    const p = ytPlayer();
    if (p) return p;
    if (useYt.getState().error) throw new Error(useYt.getState().error!);
    if (performance.now() - t0 > ms) throw new Error('YouTube の動画が読み込めませんでした');
    await sleep(100);
  }
}

/**
 * 動画の v0 秒から再生して PROBE_SEC 秒ぶん聞き取る。
 * 返す v は、聞き取った音の頭が動画の何秒だったか。止まった（読み込み待ち）・飛んだときは null
 */
async function listenAt(player: YTPlayer, rec: PcmRecorder, ctx: AudioContext, v0: number, delta: number): Promise<{ pcm: Float32Array; v: number } | null> {
  player.seekTo(Math.max(0, v0), true);
  player.playVideo();
  const t0 = performance.now();
  let steady = 0;
  for (;;) {
    check();
    await sleep(40);
    if (player.getPlayerState() === 1) {
      if (!steady) steady = performance.now();
      if (performance.now() - steady > 300) break;
    } else steady = 0;
    if (performance.now() - t0 > 15000) return null;
  }
  // これから耳に届く所（0.05 秒先）を頭にして聞き取る。届くのは Δ 遅れ
  const hs = heardCtxNow(ctx) + 0.05;
  const cStart = hs + delta;
  const cEnd = cStart + PROBE_SEC;
  const polls: { h: number; g: number; st: number }[] = [];
  while (rec.heardUntil < cEnd + 0.02) {
    check();
    await sleep(25);
    polls.push({ h: heardCtxNow(ctx), g: player.getCurrentTime(), st: player.getPlayerState() });
    if (performance.now() - t0 > 40000) return null;
  }
  player.pauseVideo();
  const he = hs + PROBE_SEC;
  const inWin = polls.filter((p) => p.h >= hs - 0.05 && p.h <= he + 0.05);
  if (inWin.length < 10 || inWin.some((p) => p.st !== 1)) return null;
  const ds = inWin.map((p) => p.g - p.h).sort((a, b) => a - b);
  // 途中で飛んだ・止まった（読み込み待ち）なら、動画の時刻と合わない
  if (ds[Math.floor(ds.length * 0.9)] - ds[Math.floor(ds.length * 0.1)] > 0.12) return null;
  return { pcm: rec.take(cStart, cEnd), v: hs + median(ds) };
}

/**
 * 自動で合わせる。ボタンを押したとき（または URL を入れたとき）にそのまま呼ぶこと
 * （ブラウザの共有の確認は、押した直後でないと出せない）
 */
export async function startAutoAlign(): Promise<void> {
  if (running) return;
  const yt0 = useSidecar.getState().youtube;
  if (!yt0) return;
  const block = alignBlocker();
  if (block) {
    set({ phase: 'failed', error: block, note: '' });
    return;
  }
  const bgm = bgmSource(useEditor.getState().doc)!;
  const ref = engine.buffer(bgm.wav)!;
  const ctx = engine.ensure();
  running = true;
  abortReason = null;
  set({ phase: 'asking', probe: 0, note: '共有の確認で、このタブを選んで「共有」を押してください', error: null });
  // ここまで await なし（共有の確認はボタンを押した直後に出す）
  const streamP = requestTabAudio();
  let stream: MediaStream | null = null;
  let rec: PcmRecorder | null = null;
  let player: YTPlayer | null = null;
  let saved: { muted: boolean; volume: number } | null = null;
  try {
    stream = await streamP;
    stream.getAudioTracks()[0]?.addEventListener('ended', () => cancelAutoAlign('共有が止められました'));
    check();
    stopPlayback();
    holdSync(true);
    useYt.setState({ hidden: false });
    set({ phase: 'prep', note: '準備しています…' });
    await wk.loadAudio(ref.key, ref.buf);
    const refP = wk.alignRef(ref.key);
    player = await waitPlayer(20000);
    saved = { muted: player.isMuted(), volume: player.getVolume() };
    player.pauseVideo();
    rec = new PcmRecorder(ctx, stream);
    await rec.start();

    // 遅れを測る（クリック 4 回）
    set({ phase: 'calib', note: '音が届くまでの遅れを測っています…' });
    await sleep(400);
    const c0 = ctx.currentTime + 0.15;
    const times = [c0, c0 + 0.3, c0 + 0.6, c0 + 0.9];
    const click = scheduleClicks(ctx, times);
    const lastClick = times[times.length - 1];
    while (rec.heardUntil < lastClick + 0.75) {
      check();
      await sleep(50);
      if (ctx.currentTime > lastClick + 3) break;
    }
    const r0 = rec;
    const found = times.map((t) => findClickDelay(r0, click, t)).filter((x): x is number => x !== null);
    // 2 回以上そろった値を使う（共有を始めた直後は 1 回目が届かず、次のクリックを拾うことがある）
    const agree = clickCluster(found);
    const precise = agree.length >= 2;
    // 測れなければ、出力の遅れ＋少しで見込む
    const delta = precise ? median(agree) : (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + 0.02;
    await refP;
    check();

    player.unMute();
    if (saved.volume < 30) player.setVolume(80);
    const done: ProbeResult[] = [];
    const vdur = ytDuration();
    const adur = ref.buf.duration;
    const hint = yt0.auto ? yt0.offset : null;
    for (;;) {
      check();
      const v0 = nextProbe({ vdur, adur, len: PROBE_SEC, done, hint });
      if (v0 === null) break;
      set({ phase: 'listen', probe: done.length + 1, note: `YouTube の音を聞き取っています（${done.length + 1} か所目）…` });
      const got = await listenAt(player, rec, ctx, v0, delta);
      if (!got) {
        done.push({ v: v0, len: PROBE_SEC, cands: [], active: 0 });
        continue;
      }
      set({ phase: 'think', note: '原曲と照らし合わせています…' });
      const r = await wk.alignProbe(ref.key, got.pcm, ctx.sampleRate);
      done.push({ v: got.v, len: PROBE_SEC, cands: r.cands, active: r.active });
    }
    const dec = decideOffset(done);
    // 調べるとき用（うまく合わないときに、コンソールのこの行を見れば様子が分かる）
    console.info(
      '[ytAlign]',
      JSON.stringify({
        delta: Math.round(delta * 1000),
        clicks: found.map((x) => Math.round(x * 1000)),
        probes: done.map((p) => ({ v: Math.round(p.v * 100) / 100, top: p.cands.slice(0, 2).map((c) => [Math.round((p.v - c.sec) * 1000) / 1000, Math.round(c.z * 10) / 10]) })),
        dec: dec && { offset: Math.round(dec.offset * 1000) / 1000, kind: dec.kind, conf: Math.round(dec.conf * 100) / 100, anchors: dec.anchors.map((x) => [Math.round(x.a * 10) / 10, Math.round(x.d * 1000) / 1000]) },
      }),
    );
    if (!dec || dec.conf < 0.3) throw new Error('動画の中に原曲と同じ曲の所が見つかりませんでした。別の動画か、手で合わせてください');
    const cur = useSidecar.getState().youtube;
    if (!cur || cur.url !== yt0.url) throw new Abort('動画が替わったのでやめました');
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    setYoutube({
      url: cur.url,
      offset: r3(dec.offset),
      ...(dec.anchors.length ? { anchors: dec.anchors.map((x) => ({ a: r3(x.a), d: r3(x.d) })) } : {}),
      auto: { kind: dec.kind, conf: Math.round(dec.conf * 100) / 100, at: Date.now() },
    });
    set({ phase: 'done', note: '', last: { dec, prev: cur, url: cur.url, precise, probes: done.length } });
  } catch (e) {
    const msg = e instanceof CaptureError || e instanceof Abort || e instanceof Error ? e.message : String(e);
    set({ phase: e instanceof Abort && msg === 'やめました' ? 'idle' : 'failed', error: msg, note: '' });
  } finally {
    rec?.stop();
    stopStream(stream);
    if (player && saved) {
      try {
        player.pauseVideo();
        if (saved.muted) player.mute();
        player.setVolume(saved.volume);
      } catch {
        // 消えている
      }
    }
    holdSync(false);
    running = false;
    abortReason = null;
  }
}

/** 自動で合わせる前のずれに戻す */
export function undoAutoAlign() {
  const last = useYtAlign.getState().last;
  const cur = useSidecar.getState().youtube;
  if (!last || !cur || cur.url !== last.url) return;
  setYoutube(last.prev);
  set({ last: null, phase: 'idle' });
}

// 動画を替えたら、前の動画の結果の表示は消す
useSidecar.subscribe((s, prev) => {
  if (s.youtube?.url === prev.youtube?.url) return;
  if (aligning()) cancelAutoAlign('動画が替わったのでやめました');
  const st = useYtAlign.getState();
  if (st.phase === 'done' || st.phase === 'failed') set({ phase: 'idle', error: null, last: null });
});
