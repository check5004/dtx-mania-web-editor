// おまかせで準備：原曲（音声・動画）か、分けてあるステム（Moises など）から、打ち込みを始められる所までを決まった順に進める。
// 新しい部品はほとんど無く、今ある部品を順に呼ぶ：動画の音の取り出し → 譜面を作る → ステム（ドラム抜きの BGM）→
// 曲情報（並行）→ テンポと 1 小節目 → 試聴（サビ）→ ステム分解 → ドラムの打点 → 保存。
// うまくいかなかった項目は飛ばして先へ進み、終わったら結果を並べる（エディタの「準備ができました」の帯）。
// 準備の間は自動保存と採譜を待たせる（やめたら何も残さない。採譜は分けたドラムで 1 回だけ）。
import { create } from 'zustand';
import { tr } from '../i18n';
import { normalizeAnchors } from '../assist/tempoPlan';
import { planStemFiles } from '../audio/stemNames';
import { extractVideoAudio, isVideoName } from '../audio/videoAudio';
import { AUDIO_EXT, audioFiles, folderFromFiles, isDiskFolder, putFile, removeFile, type SongFolder } from '../fs/folder';
import { nxSafeBase, nxSafeName } from '../fs/nxName';
import { readAudioTags } from '../fs/tags';
import { useAssist } from '../store/assist';
import { makeChorusPreview, useChorus } from '../store/chorus';
import { drumStatusText, holdDrums, setDrumSource, setDrumsEnabled, useDrums } from '../store/drums';
import { createDoc, openDocument, openedDocs, stop, useEditor } from '../store/editor';
import { cancelSeparation, formatSec, registerDrumlessBgm, startSeparation, useSeparate } from '../store/separate';
import type { StemKind } from '../store/sidecar';
import { lookupSong, stopLookup, useSongInfo } from '../store/songinfo';
import { importStems, useStems } from '../store/stems';
import { applyTempo, bpmText, initTempo, refineWithChords, useTempo } from '../store/tempoUi';
import { failText } from '../store/videoExtract';
import { autosaveNow, closeDocument, freePath, holdAutosave, newMeta, nxSafeFiles, saveAfterSetup } from './fileActions';
import { applySongInfo, defaultInfoPick } from './songInfoApply';

// ---- 何から始めるか ---------------------------------------------------------------------

export interface SetupStem {
  file: File;
  kind: StemKind;
  name: string;
  /** 楽器の語から決めた（false：知らない名前なので「その他」にした） */
  known: boolean;
}

export interface SetupSource {
  /** audio：原曲の音 / video：動画（音を取り出す）/ stems：分けてあるステム（原曲は一緒にあれば） */
  kind: 'audio' | 'video' | 'stems';
  /** 原曲（音声か動画）。ステムだけなら null */
  original: File | null;
  /** 背景動画にする動画（動画から始めたとき・音と一緒に動画を入れたとき） */
  movie: File | null;
  /** 使うステム（kind が stems のとき） */
  stems: SetupStem[];
  /** 使わない音（メトロノーム・クリック）。BGM にも試聴にも混ぜない */
  unused: SetupStem[];
  /** 曲名の案 */
  title: string;
  /** DTX の無い曲フォルダを開いたとき：その曲フォルダと、ファイルの曲フォルダの中のパス */
  folder: SongFolder | null;
  paths: Map<File, string>;
}

const baseName = (name: string) => (name.split(/[\\/]/).pop() ?? name).replace(/\.[^.]+$/, '').trim();

/** 音のファイルの並びから決める（音声も動画も無ければ null） */
function sourceOf(files: File[], folder: SongFolder | null, paths: Map<File, string>): SetupSource | null {
  const audio = files.filter((f) => AUDIO_EXT.test(f.name));
  const videos = files.filter((f) => isVideoName(f.name));
  if (audio.length >= 2) {
    const plan = planStemFiles(audio.map((f) => f.name));
    if (plan.isStems) {
      const pick = (i: number): SetupStem => ({ file: audio[i], kind: plan.items[i]!.kind, name: plan.items[i]!.name, known: plan.items[i]!.known });
      const rest = audio.map((_, i) => i).filter((i) => i !== plan.original);
      const original = plan.original !== null ? audio[plan.original] : null;
      return {
        kind: 'stems',
        original,
        movie: videos[0] ?? null,
        stems: rest.filter((i) => !plan.items[i]!.guide).map(pick),
        unused: rest.filter((i) => plan.items[i]!.guide).map(pick),
        title: plan.title || baseName((original ?? audio[0]).name),
        folder,
        paths,
      };
    }
  }
  const original = audio[0] ?? videos[0];
  if (!original) return null;
  return { kind: audio[0] ? 'audio' : 'video', original, movie: videos[0] ?? null, stems: [], unused: [], title: baseName(original.name), folder, paths };
}

/** 落とした・選んだファイルから、何から始めるかを決める（音声も動画も無ければ null） */
export function setupSourceOf(files: File[]): SetupSource | null {
  return sourceOf(files, null, new Map());
}

/** DTX の無い曲フォルダから、何から始めるかを決める（音声も動画も無ければ null） */
export async function setupSourceOfFolder(folder: SongFolder): Promise<SetupSource | null> {
  const list = [...audioFiles(folder), ...[...folder.files.values()].filter((f) => isVideoName(f.name))].sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Map<File, string>();
  const files: File[] = [];
  for (const f of list) {
    const file = await f.getFile();
    paths.set(file, f.path);
    files.push(file);
  }
  const src = sourceOf(files, folder, paths);
  if (src && src.kind !== 'stems') src.title = folder.name;
  return src;
}

// ---- 準備の様子 ---------------------------------------------------------------------

export type SetupStepId = 'video' | 'stems' | 'info' | 'tempo' | 'preview' | 'separate' | 'drums';
export type SetupStepState = 'wait' | 'run' | 'done' | 'skip' | 'fail';

export interface SetupStep {
  id: SetupStepId;
  state: SetupStepState;
  /** 結果・していること・できなかった理由（一行） */
  note: string;
  /** 0〜1（分かるときだけ） */
  progress: number | null;
  /** 始めた時刻（ms） */
  t0: number;
  /** かかった秒 */
  sec: number;
}

/** 最初に作る難易度 */
export type SetupDifficulty = 'BASIC' | 'ADVANCED' | 'EXTREME' | 'MASTER';
export const SETUP_FILES: Record<SetupDifficulty, string> = { BASIC: 'bsc.dtx', ADVANCED: 'adv.dtx', EXTREME: 'ext.dtx', MASTER: 'mstr.dtx' };

export interface SetupOptions {
  /** 曲名・アーティスト・画像（タグと iTunes。ai なら AI の Web 検索も） */
  info: boolean;
  ai: boolean;
  /** テンポと 1 小節目の頭 */
  tempo: boolean;
  /** 試聴（サビ） */
  preview: boolean;
  /** ステム分解（原曲から始めるとき。ドラムとドラム抜き） */
  separate: boolean;
  /** ドラムの打点（採譜） */
  drums: boolean;
  difficulty: SetupDifficulty;
}

export interface SetupState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** 曲名（画面の見出し） */
  title: string;
  steps: SetupStep[];
  /** 続けられなかったとき（動画に音が無いなど。譜面は作っていない） */
  error: string | null;
  /** 終わった：準備した譜面（開いた回数）と、保存できたか */
  ready: { docs: number; saved: boolean } | null;
}

const IDLE: SetupState = { status: 'idle', title: '', steps: [], error: null, ready: null };
export const useSetup = create<SetupState>(() => IDLE);
const get = useSetup.getState;
const set = useSetup.setState;

/** やることの順（選んだ物と、始め方で要る物だけ） */
export function plannedSteps(src: Pick<SetupSource, 'kind'>, o: SetupOptions): SetupStepId[] {
  const out: SetupStepId[] = [];
  if (src.kind === 'video') out.push('video');
  if (src.kind === 'stems') out.push('stems');
  if (o.info) out.push('info');
  if (o.tempo) out.push('tempo');
  if (o.preview) out.push('preview');
  if (o.separate && src.kind !== 'stems') out.push('separate');
  if (o.drums) out.push('drums');
  return out;
}

function upd(id: SetupStepId, patch: Partial<SetupStep>) {
  set((s) => ({ steps: s.steps.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

function begin(id: SetupStepId, note: string) {
  upd(id, { state: 'run', note, progress: null, t0: Date.now() });
}

function finish(id: SetupStepId, state: 'done' | 'fail' | 'skip', note: string) {
  const st = get().steps.find((x) => x.id === id);
  upd(id, { state, note, progress: null, sec: st?.t0 ? (Date.now() - st.t0) / 1000 : 0 });
}

/** 曲の中の時刻（0:01.395） */
export function clock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
}

// ---- やめる ---------------------------------------------------------------------

class Canceled extends Error {}
/** 続けられない（動画に音が無いなど）。message を画面に出す */
class SetupError extends Error {}

/** 1 回の準備で作った物（やめたときに片付ける） */
interface Run {
  id: number;
  /** 開いた譜面（openedDocs の数。開く前は null） */
  docs: number | null;
  /** 準備の前に曲フォルダにあったファイル（PC の曲フォルダに書いた物を消すため） */
  folder: SongFolder | null;
  before: Set<string>;
}

let runId = 0;
let canceled = -1;
let current: Run | null = null;

const alive = (id: number) => id === runId && canceled !== id;

function check(id: number) {
  if (!alive(id)) throw new Canceled();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** cond が true になるまで待つ（'stop' か ms を過ぎたら false。やめたら Canceled）。待つ間 tick を呼ぶ */
async function until(id: number, cond: () => boolean | 'stop', ms: number, tick?: () => void): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    check(id);
    tick?.();
    const c = cond();
    if (c === true) return true;
    if (c === 'stop' || Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

/** 待つ間、様子を写す（止める関数を返す） */
function ticker(fn: () => void): () => void {
  fn();
  const t = window.setInterval(fn, 250);
  return () => window.clearInterval(t);
}

/** 画面を消さない（iPhone・iPad で長いステム分解の間に止まらないように。使えなければ何もしない） */
let wake: WakeLockSentinel | null = null;
async function keepAwake(on: boolean) {
  try {
    if (on && !wake && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen');
    else if (!on && wake) {
      const w = wake;
      wake = null;
      await w.release();
    }
  } catch {
    wake = null;
  }
}

/** 準備をやめる：何も作らずにホームに戻る（PC の曲フォルダに書いたファイルも消す） */
export function cancelSetup() {
  const run = current;
  if (get().status !== 'running' || !run) return;
  canceled = run.id;
  stopLookup();
  cancelSeparation();
  void cleanUp(run);
  set(IDLE);
}

/** 止めていた物を戻す（新しい準備が始まっていなければ） */
function release(id: number) {
  if (id !== runId) return;
  holdDrums(false);
  holdAutosave(false);
  void keepAwake(false);
}

/** やめたあとの片付け（2 回呼んでもよい：遅れて書かれたファイルも消す） */
async function cleanUp(run: Run) {
  if (run.id === runId) {
    stop();
    // 作りかけの曲の採譜はしない
    setDrumSource(null);
    release(run.id);
  }
  if (run.docs !== null && openedDocs === run.docs && useEditor.getState().screen !== 'home') closeDocument();
  if (run.folder && isDiskFolder(run.folder)) {
    for (const [key, f] of [...run.folder.files]) {
      if (run.before.has(key)) continue;
      try {
        await removeFile(run.folder, f.path);
      } catch {
        // 消せなければ残す
      }
    }
  }
}

// ---- 準備 ---------------------------------------------------------------------

/** 1 つの項目を進める（Canceled 以外の失敗は、その項目を「できなかった」にして先へ進む） */
async function guard(id: number, step: SetupStepId, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Canceled || !alive(id)) throw new Canceled();
    finish(step, 'fail', (e as Error)?.message || String(e));
  }
}

/**
 * おまかせで準備する。終わったら true（できなかった項目があっても）。やめた・続けられなかったら false。
 * 呼ぶ前に、開いている譜面を閉じてよいか確かめておく
 */
export async function runSetup(src: SetupSource, o: SetupOptions): Promise<boolean> {
  if (get().status === 'running') return false;
  const id = ++runId;
  const run: Run = { id, docs: null, folder: src.folder, before: new Set(src.folder?.files.keys() ?? []) };
  current = run;
  const steps = plannedSteps(src, o).map((s): SetupStep => ({ id: s, state: 'wait', note: '', progress: null, t0: 0, sec: 0 }));
  set({ status: 'running', title: src.title, steps, error: null, ready: null });
  holdAutosave(true);
  holdDrums(true);
  void keepAwake(true);
  try {
    // 1. 動画の音を取り出す
    let audio = src.kind === 'video' ? null : src.original;
    let movie = src.movie;
    if (src.kind === 'video' && src.original) {
      const video = src.original;
      begin('video', tr(`${video.name} から音を取り出しています…`, `Taking the audio out of ${video.name}…`));
      const r = await extractVideoAudio(video, {
        onProgress: (phase, p) => upd('video', { progress: phase === 'encode' ? p : null }),
        cancelled: () => !alive(id),
      });
      check(id);
      if ('error' in r) {
        if (r.error === 'cancelled') throw new Canceled();
        throw new SetupError(failText(r.error, video.name));
      }
      audio = r.file;
      movie = video;
      finish('video', 'done', tr(`${audio.name}（${formatSec(r.seconds)}）。動画は背景動画にも`, `${audio.name} (${formatSec(r.seconds)}). The video is also the background movie`));
    }

    // 2. 譜面を作って開く（タグがあれば曲名・アーティスト・BPM も）
    const tags = await readAudioTags(audio ?? movie ?? src.stems[0].file).catch(() => null);
    check(id);
    const title = (tags?.title || src.title || tr('新しい曲', 'New song')).trim();
    let folder: SongFolder;
    let bgmFile: string | undefined;
    let movieFile: string | undefined;
    if (src.folder) {
      folder = src.folder;
      movieFile = movie ? src.paths.get(movie) : undefined;
      bgmFile = audio ? src.paths.get(audio) : undefined;
      if (audio && !bgmFile) {
        // 動画から取り出した音：曲フォルダに置く（NX で読める名前で）
        bgmFile = freePath(folder, nxSafeName(audio.name, 'bgm'));
        await putFile(folder, bgmFile, audio);
        check(id);
      }
    } else {
      const named = nxSafeFiles([...(audio ? [audio] : []), ...(movie ? [movie] : [])]);
      folder = folderFromFiles(named, title);
      bgmFile = audio ? named[0].name : undefined;
      movieFile = movie ? named[named.length - 1].name : undefined;
    }
    const doc = createDoc({
      title,
      artist: tags?.artist || tags?.albumArtist || '',
      bpm: tags?.bpm ? Math.round(tags.bpm * 100) / 100 : 120,
      bgmFile,
      movieFile,
    });
    openDocument(doc, newMeta(SETUP_FILES[o.difficulty], src.folder), folder, { dirty: true });
    run.docs = openedDocs;

    // 3. 分けてあるステム：トラックにして、ドラム以外を合わせたドラム抜きをゲームの BGM に
    if (src.kind === 'stems') await guard(id, 'stems', () => stemsStep(id, src, title));

    // 4. 曲情報（ネットで調べるので、ほかと並べて進める）
    const info = o.info ? guard(id, 'info', () => infoStep(id, o.ai)) : Promise.resolve();
    info.catch(() => {});

    // 5. テンポと 1 小節目の頭
    if (o.tempo) await guard(id, 'tempo', () => tempoStep(id));
    // 6. 試聴（サビ）
    if (o.preview) await guard(id, 'preview', () => previewStep(id));
    // 7. ステム分解（ドラムとドラム抜き）
    if (o.separate && src.kind !== 'stems') await guard(id, 'separate', () => separateStep(id));
    // 8. ドラムの打点（分けたドラム・ドラムを合わせた音・原曲で 1 回だけ）
    if (o.drums) await guard(id, 'drums', () => drumsStep(id));
    else holdDrums(false);
    await info;
    check(id);

    // 9. 保存（曲フォルダごと本体に。PC の曲フォルダならそこへ）
    holdAutosave(false);
    const saved = await saveAfterSetup();
    check(id);
    // 最近の曲にも控えを残す（いつもは打ち込みの途中で自動保存が残す）
    void autosaveNow(true);
    set({ status: 'done', ready: { docs: openedDocs, saved } });
    return true;
  } catch (e) {
    if (!(e instanceof Canceled) && alive(id)) {
      // 続けられない（動画に音が無いなど）：作りかけは残さず、理由を出す
      const msg = e instanceof SetupError ? e.message : tr(`準備できませんでした: ${(e as Error)?.message || String(e)}`, `Couldn't set up: ${(e as Error)?.message || String(e)}`);
      canceled = id;
      await cleanUp(run);
      set({ ...IDLE, status: 'error', error: msg, title: src.title });
      return false;
    }
    await cleanUp(run);
    return false;
  } finally {
    if (alive(id)) release(id);
    if (current === run) current = null;
  }
}

/** 準備の結果を閉じる（帯を閉じた・別の曲を開いた） */
export function dismissSetup() {
  if (get().status !== 'running') set(IDLE);
}

// ---- 項目 ---------------------------------------------------------------------

async function stemsStep(id: number, src: SetupSource, title: string) {
  begin('stems', tr(`ステム ${src.stems.length} 本を読み込んでいます…`, `Loading ${src.stems.length} stems…`));
  const stopTick = ticker(() => {
    const busy = useStems.getState().busy;
    if (busy) upd('stems', { note: busy });
  });
  try {
    const kinds = new Map(src.stems.map((s) => [s.file, { kind: s.kind, name: s.name }]));
    const n = await importStems(
      src.stems.map((s) => s.file),
      { kinds, quiet: true },
    );
    check(id);
    if (!n) return finish('stems', 'fail', tr('ステムを読み込めませんでした', "Couldn't load the stems"));
    // 原曲が無ければ、ドラム抜きと分かる名前にする（サビ探しなどが、ドラム抜きの BGM でなくステムを全部合わせた音を使うように）
    const bgm = await registerDrumlessBgm(src.original ? undefined : `${nxSafeBase(title, 'bgm')}_nodrums.ogg`, { quiet: true });
    check(id);
    const drums = src.stems.filter((s) => s.kind === 'drums').length;
    const parts = [
      tr(`${n} 本`, `${n} stems`),
      drums >= 2 ? tr(`ドラム ${drums} 本は合わせて解析に`, `the ${drums} drum stems are analyzed together`) : '',
      bgm ? tr(`ゲームの BGM は ${bgm}（ドラム抜き）`, `the game BGM is ${bgm} (no drums)`) : tr('ドラム以外のステムが無いので、BGM は作っていません', 'no BGM was made because there are no stems other than drums'),
    ].filter(Boolean);
    finish('stems', 'done', parts.join(tr('・', ', ')));
  } finally {
    stopTick();
  }
}

async function infoStep(id: number, ai: boolean) {
  begin('info', tr('タグと iTunes で探しています…', 'Searching tags and iTunes…'));
  const stopTick = ticker(() => {
    const st = useSongInfo.getState().steps;
    const last = st[st.length - 1];
    if (last && useSongInfo.getState().status === 'running') upd('info', { note: last.text });
  });
  try {
    await lookupSong(ai, { quiet: true });
  } finally {
    stopTick();
  }
  check(id);
  const s = useSongInfo.getState();
  if (s.status !== 'done' || !s.result) return finish('info', 'fail', s.error ?? tr('見つかりませんでした', 'Nothing was found'));
  const r = await applySongInfo(s.result, defaultInfoPick());
  check(id);
  const missed = r.failed.length ? tr(`入れられなかった物: ${r.failed.join('、')}`, `couldn't add: ${r.failed.join(', ')}`) : '';
  if (!r.done.length) return finish('info', 'fail', missed || tr('見つかりませんでした（曲名はファイル名のまま）', 'Nothing was found (the title is the file name)'));
  const f = useEditor.getState().doc.fields;
  const art = r.done.some((x) => x.startsWith('#'));
  const yt = r.done.includes(tr('参照映像', 'reference video'));
  const extra = [art ? tr('画像', 'images') : '', yt ? tr('参照映像', 'reference video') : ''].filter(Boolean);
  finish(
    'info',
    'done',
    [[f['TITLE'], f['ARTIST']].filter(Boolean).join(' / '), extra.length ? tr(`${extra.join('・')}も入れました`, `added ${extra.join(' and ')}`) : '', missed].filter(Boolean).join(' · '),
  );
}

async function tempoStep(id: number) {
  begin('tempo', tr('曲を解析しています…', 'Analyzing the song…'));
  // 解析は譜面を開くと始まる（音を読み込んでから）。音が読めないまま 1 分たったらあきらめる
  let noSource = 0;
  const ok = await until(
    id,
    () => {
      const a = useAssist.getState();
      if (a.status === 'ready' && a.data) return true;
      if (a.status === 'error') return 'stop';
      noSource = a.status === 'nosource' && !useEditor.getState().loading ? noSource + 1 : 0;
      return noSource > 240 ? 'stop' : false;
    },
    10 * 60_000,
    () => {
      const a = useAssist.getState();
      upd('tempo', { progress: a.status === 'loading' ? a.progress : null });
    },
  );
  const a = useAssist.getState();
  if (!ok || !a.data?.tempo.length) return finish('tempo', 'fail', a.error ?? tr('曲の音を解析できませんでした', "Couldn't analyze the song audio"));
  useTempo.setState({ initialized: false });
  initTempo();
  if (!useTempo.getState().fromEstimate) return finish('tempo', 'fail', tr('テンポを推定できませんでした', "Couldn't estimate the tempo"));
  upd('tempo', { note: tr('1 拍目を和音の変わり目で確かめています…', 'Checking beat 1 against the chord changes…'), progress: null });
  await refineWithChords();
  check(id);
  if (!applyTempo({ quiet: true })) return finish('tempo', 'fail', tr('1 小節目の頭が原曲の始まりから遠く、BGM を置けませんでした', 'Measure 1 is too far from the start of the original to place the BGM'));
  const plan = useTempo.getState().plan;
  const a0 = normalizeAnchors(plan.anchors)[0];
  finish('tempo', 'done', tr(`${bpmText(plan.bpm)} BPM · 1 小節目は ${clock(a0?.t ?? 0)} から`, `${bpmText(plan.bpm)} BPM · measure 1 starts at ${clock(a0?.t ?? 0)}`));
}

async function previewStep(id: number) {
  begin('preview', tr('サビを探しています…', 'Looking for the chorus…'));
  const stopTick = ticker(() => {
    const c = useChorus.getState();
    if (c.status === 'loading') upd('preview', { progress: c.progress, note: c.step || tr('サビを探しています…', 'Looking for the chorus…') });
    else if (c.making) upd('preview', { progress: null, note: tr('試聴のファイルを作っています…', 'Making the preview file…') });
  });
  let r: Awaited<ReturnType<typeof makeChorusPreview>>;
  try {
    r = await makeChorusPreview(null, { quiet: true });
  } finally {
    stopTick();
  }
  check(id);
  if (!r) return finish('preview', 'fail', useChorus.getState().error ?? tr('試聴を作れませんでした', "Couldn't make the preview"));
  finish('preview', 'done', tr(`${clock(r.start)} からのサビを試聴（${r.file}）に`, `The chorus from ${clock(r.start)} is the preview (${r.file})`));
}

async function separateStep(id: number) {
  begin('separate', tr('ドラムとドラム抜きに分けています…', 'Splitting into drums and no drums…'));
  const stopTick = ticker(() => {
    const s = useSeparate.getState();
    upd('separate', { note: s.detail || tr('ドラムとドラム抜きに分けています…', 'Splitting into drums and no drums…'), progress: s.phase === 'run' || s.phase === 'download' || s.phase === 'encode' ? s.progress : null });
  });
  let ok: boolean;
  try {
    ok = await startSeparation({ outputs: 'two', quiet: true });
  } finally {
    stopTick();
  }
  check(id);
  if (!ok) return finish('separate', 'fail', useSeparate.getState().error ?? tr('分けられませんでした', "Couldn't split the song"));
  upd('separate', { note: tr('ドラム抜きをゲームの BGM にしています…', 'Making the no-drums mix the game BGM…'), progress: null });
  const bgm = await registerDrumlessBgm(undefined, { quiet: true });
  check(id);
  const sec = useSeparate.getState().last?.seconds;
  finish(
    'separate',
    'done',
    tr(`ドラムとドラム抜きに分けました${sec ? `（${formatSec(sec)}）` : ''}`, `Split into drums and no drums${sec ? ` (${formatSec(sec)})` : ''}`) +
      (bgm ? tr(`。ゲームの BGM は ${bgm}`, `. The game BGM is ${bgm}`) : ''),
  );
}

async function drumsStep(id: number) {
  begin('drums', tr('ドラムの打点を拾っています…', 'Picking up the drum hits…'));
  if (!useDrums.getState().enabled) setDrumsEnabled(true);
  holdDrums(false);
  const ok = await until(
    id,
    () => {
      const d = useDrums.getState();
      return d.status === 'ready' ? true : d.status === 'error' ? 'stop' : false;
    },
    20 * 60_000,
    () => {
      const d = useDrums.getState();
      if (d.status === 'loading') upd('drums', { note: drumStatusText(d), progress: d.progress });
    },
  );
  const d = useDrums.getState();
  if (!ok) return finish('drums', 'fail', d.error ?? tr('採譜できませんでした', "Couldn't transcribe the drums"));
  finish('drums', 'done', tr(`${d.name} から拾って「原曲の打点」の列に`, `From ${d.name}, shown in the "original hits" columns`));
}
