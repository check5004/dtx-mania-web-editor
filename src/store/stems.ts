// ステム音源：読み込み・DTM風の再生（ミュート・ソロ・音量・パン）・聞こえ方のプリセット・書き出しとエディタ（譜面）への反映。
// ステムは BGM チップ（ch01）の位置から鳴らす。ステムがあるときは、その BGM の代わりにステムを鳴らす（ステムの合計＝原曲）。
import { tr, withTr, pl } from '../i18n';
import { create } from 'zustand';
import { engine, STEM_BASE, type StemStrip } from '../audio/engine';
import { computePeaks, encodeAudio, guessStems, isKindLabel, renderMix, shiftBuffer, stemFilePath, stemKindInfo, uniqueStemName, type StemGuess } from '../audio/stems';
import { toBase36x2 } from '../dtx/base36';
import { CH } from '../dtx/model';
import { frac } from '../dtx/fraction';
import { freeWavNumber, setField } from '../edit/ops';
import { AUDIO_EXT, findFile, folderFromFiles, putFile, type SongFolder } from '../fs/folder';
import { setAnalysisProvider, syncAnalysis, useAssist, type AnalysisSource } from './assist';
import { bgmSource, setPlaybackTransform, tempoOf, wavPath } from './derived';
import { edit, openedDocs, prepareSounds, restartIfPlaying, setMix, toast, useEditor } from './editor';
import { rememberMix, setAnalysisStem, setStems, useSidecar, type ListenPreset, type SavedMix, type StemKind, type StemTrack } from './sidecar';
import { glowReflected } from './glow';

interface Loaded {
  key: string;
  raw: AudioBuffer;
  /** 頭のずれを入れた音（再生・解析・書き出しに使う） */
  buf: AudioBuffer;
  offsetMs: number;
  peaks: Float32Array;
}

export type StemStatus = 'loading' | 'ready' | 'missing' | 'error';

/** 書き出してエディタに反映した音（BGM・試聴の #PREVIEW）。元に戻すときに使う */
export interface AudioReflect {
  /** 反映したファイル */
  file: string;
  /** 反映する前のファイル（無かったら null） */
  prev: string | null;
  /** BGM の #WAV の番号 */
  wav?: number;
  /** BGM のチップが無かったので置いたチップ（元に戻すときに消す） */
  chipId?: number;
}

export interface StemsState {
  status: Record<string, StemStatus>;
  /** 読み込みが変わるたびに増える（波形の描き直し用） */
  version: number;
  listen: ListenPreset;
  busy: string | null;
  /** この曲で書き出してエディタに反映したもの（別の曲を開くと消える） */
  reflected: { bgm: AudioReflect | null; preview: AudioReflect | null };
}

export const useStems = create<StemsState>(() => ({ status: {}, version: 0, listen: 'all', busy: null, reflected: { bgm: null, preview: null } }));

const sget = useStems.getState;
const sset = useStems.setState;
const tracks = () => useSidecar.getState().stems;

const loaded = new Map<string, Loaded>();
const decoding = new Map<string, Promise<AudioBuffer | null>>();
const numbers = new Map<string, number>();
let nextNo = STEM_BASE;

export const PEAK_RATE = 100;

function stemNo(file: string): number {
  let n = numbers.get(file);
  if (n === undefined) numbers.set(file, (n = nextNo++));
  return n;
}

export function stemBuffer(file: string): AudioBuffer | null {
  return loaded.get(file)?.buf ?? null;
}

export function stemPeaks(file: string): Float32Array | null {
  return loaded.get(file)?.peaks ?? null;
}

/** 読み込めているステム */
export function readyStems(): StemTrack[] {
  return tracks().filter((t) => loaded.has(t.file));
}

/** ステムを鳴らしているか（このとき BGM の代わりにステムを鳴らす） */
export function stemsActive(): boolean {
  return readyStems().length > 0;
}

/** ステムのうち一番長いもの（秒） */
export function stemsDuration(): number {
  let d = 0;
  for (const t of readyStems()) d = Math.max(d, loaded.get(t.file)!.buf.duration);
  return d;
}

// ---- 読み込み -------------------------------------------------------------------

let syncToken = 0;

/** 作業ファイルのステムと、読み込んだ音をそろえる */
export async function syncStems() {
  const token = ++syncToken;
  const list = tracks();
  const folder = useEditor.getState().folder;
  for (const f of [...loaded.keys()]) if (!list.some((t) => t.file === f)) loaded.delete(f);
  for (const f of [...numbers.keys()]) if (!list.some((t) => t.file === f)) numbers.delete(f);
  const status: Record<string, StemStatus> = {};
  const jobs: Promise<void>[] = [];
  for (const t of list) {
    const ff = findFile(folder, t.file);
    if (!ff) {
      status[t.file] = 'missing';
      loaded.delete(t.file);
      continue;
    }
    const key = `${folder?.name}|${ff.path}|${ff.size}|${ff.ver ?? 0}`;
    const cur = loaded.get(t.file);
    if (cur && cur.key === key) {
      if (cur.offsetMs !== t.offsetMs) {
        const buf = shiftBuffer(engine.workCtx(), cur.raw, t.offsetMs);
        loaded.set(t.file, { ...cur, buf, offsetMs: t.offsetMs, peaks: computePeaks(buf, PEAK_RATE) });
      }
      status[t.file] = 'ready';
      continue;
    }
    status[t.file] = 'loading';
    let p = decoding.get(key);
    if (!p) {
      p = (async () => {
        try {
          const bytes = await (await ff.getFile()).arrayBuffer();
          return await engine.decodeAudio(bytes);
        } catch {
          return null;
        }
      })();
      decoding.set(key, p);
    }
    jobs.push(
      p.then((raw) => {
        decoding.delete(key);
        if (token !== syncToken) return;
        if (!raw) {
          status[t.file] = 'error';
          return;
        }
        const buf = shiftBuffer(engine.workCtx(), raw, t.offsetMs);
        loaded.set(t.file, { key, raw, buf, offsetMs: t.offsetMs, peaks: computePeaks(buf, PEAK_RATE) });
        status[t.file] = 'ready';
      }),
    );
  }
  sset({ status: { ...status } });
  if (jobs.length) sset({ busy: tr('ステムを読み込んでいます…', 'Loading stems…') });
  await Promise.all(jobs);
  if (token !== syncToken) return;
  sset({ status, busy: null });
  applyStems();
}

/** 読み込んだステムをエンジンと再生に反映する */
function applyStems() {
  const ready = readyStems();
  if (ready.length) {
    engine.setStemBuffers(ready.map((t) => ({ no: stemNo(t.file), key: `stem:${loaded.get(t.file)!.key}:${t.offsetMs}`, buf: loaded.get(t.file)!.buf })));
  } else if (engine.ctx) {
    engine.setStemBuffers([]);
  }
  applyStrips();
  applyTransform();
  sset((s) => ({ version: s.version + 1 }));
  useEditor.setState((s) => ({ soundsVersion: s.soundsVersion + 1 }));
  syncAnalysis();
  restartIfStemsChanged();
}

/** 再生に原曲（BGM）を入れているか。ステムがあるときは、原曲のトラックが鳴る設定のときだけ入れる */
let origInPlayback = true;

/** 最後に再生へ反映したステム（音と頭のずれ）と、原曲を一緒に鳴らすか */
let playedStems = '';

/**
 * 鳴らすステムか、原曲を一緒に鳴らすかが変わったときだけ、再生中なら今の位置から鳴らし直す。
 * 同じなら鳴っている音をそのまま使う（難易度を切り替えて同じステムを読み直したときに途切れさせない）
 */
function restartIfStemsChanged() {
  const ready = readyStems();
  // ステムが無いときは、原曲を消しても音量で消すだけ（鳴らす音は変わらない）
  const sig = ready.length ? `${origInPlayback}|${ready.map((t) => `${stemNo(t.file)}=${loaded.get(t.file)!.key}:${t.offsetMs}`).join('|')}` : '';
  if (sig === playedStems) return;
  playedStems = sig;
  restartIfPlaying();
}

/** 再生で鳴らす音にステムを足す */
function applyTransform() {
  const nos = readyStems().map((t) => stemNo(t.file));
  // ステムの合計が原曲なので、原曲のトラックを消しているときは同じ所から鳴る BGM は鳴らさない（スロー再生で伸ばす手間も省く）
  const withOrig = engine.audible().orig;
  origInPlayback = withOrig;
  setPlaybackTransform(
    nos.length
      ? (doc, ev) => {
          const bgm = bgmSource(doc);
          const at = bgm?.sec ?? 0;
          const out = bgm && !withOrig ? ev.filter((e) => !(e.bus === 'bgm' && e.wav === bgm.wav)) : ev.slice();
          for (const no of nos) out.push({ sec: at, wav: no, bus: 'stem', choke: null, lane: -1 });
          return out;
        }
      : null,
  );
}

/** 原曲のトラックを鳴らすかが変わったら、再生する音を作り直す */
function syncOrigPlayback() {
  if (!stemsActive()) return;
  if (engine.audible().orig === origInPlayback) return;
  applyTransform();
  restartIfStemsChanged();
}

/** ソロがどれかのトラックに付いているか（ソロはトラックをまたいで効く） */
export function anySolo(): boolean {
  const m = engine.mix;
  return m.origSolo || m.drumSolo || m.seSolo || tracks().some((t) => t.solo && loaded.has(t.file));
}

/** ステムのトラックが鳴るか（ミュート・ソロ。曲の音をまとめて消しているときは別） */
export function stemAudible(t: StemTrack): boolean {
  return !t.mute && (!anySolo() || t.solo);
}

/** トラックの鳴らし方（ミュート・ソロ・音量・パン、聴き比べならドラムを左へ） */
function applyStrips() {
  const list = tracks();
  const stemSolo = list.some((t) => t.solo && loaded.has(t.file));
  if (engine.mix.stemSolo !== stemSolo) setMix({ stemSolo });
  if (!list.length && !engine.ctx) return;
  const listen = sget().listen;
  const hasDrumStem = list.some((t) => t.kind === 'drums');
  const strips: StemStrip[] = list
    .filter((t) => loaded.has(t.file))
    .map((t) => ({
      no: stemNo(t.file),
      gain: t.gain,
      // 聴き比べ：ドラムのステム（無ければ曲の音ぜんぶ）を左、譜面の音を右
      pan: listen === 'compare' && (!hasDrumStem || t.kind === 'drums') ? -1 : t.pan,
      audible: stemAudible(t),
    }));
  engine.setStemStrips(strips);
}

/**
 * 解析（波形・原曲の打点・BPM推定）に使うステム。選んだものが無く、原曲のファイルも
 * 鳴らせないときは、ドラム、無ければ最初のステムを使う（ステムだけ読み込んでも波形が出るように）。
 */
export function effectiveAnalysisStem(): { file: string; auto: boolean } | null {
  const chosen = useSidecar.getState().analysisStem;
  if (chosen && loaded.has(chosen) && tracks().some((t) => t.file === chosen)) return { file: chosen, auto: false };
  const bgm = bgmSource(useEditor.getState().doc);
  if (bgm && engine.buffer(bgm.wav)) return null;
  const ready = readyStems();
  const t = ready.find((x) => x.kind === 'drums') ?? ready[0];
  return t ? { file: t.file, auto: true } : null;
}

setAnalysisProvider(() => {
  const eff = effectiveAnalysisStem();
  if (!eff) return null;
  const l = loaded.get(eff.file);
  const t = tracks().find((x) => x.file === eff.file);
  if (!l || !t) return null;
  return { key: `stem:${l.key}:${t.offsetMs}`, buf: l.buf, name: tr(`${t.name}（${t.file.split('/').pop()}）`, `${t.name} (${t.file.split('/').pop()})`) };
});

/** トラックの音（スペクトルに出すとき）。'orig' は原曲、それ以外はステムのファイル */
export function trackAudio(id: string): AnalysisSource | null {
  if (id === 'orig') {
    const bgm = bgmSource(useEditor.getState().doc);
    const got = bgm ? engine.buffer(bgm.wav) : null;
    return got ? { key: got.key, buf: got.buf, name: tr('原曲', 'Original') } : null;
  }
  const l = loaded.get(id);
  const t = tracks().find((x) => x.file === id);
  if (!l || !t) return null;
  return { key: `stem:${l.key}:${t.offsetMs}`, buf: l.buf, name: t.name };
}

// ---- 追加・変更 -----------------------------------------------------------------

/** ステムのファイルを読み込む（曲フォルダの stems/ にコピーし、作業ファイルに記録する） */
export async function importStems(files: File[]): Promise<number> {
  const audio = files.filter((f) => AUDIO_EXT.test(f.name));
  if (audio.length === 0) {
    toast(tr('音声ファイル（WAV・OGG・MP3・FLAC）を選んでください', 'Choose audio files (WAV, OGG, MP3, FLAC)'), 'warn');
    return 0;
  }
  const firstStems = tracks().length === 0;
  let folder: SongFolder | null = useEditor.getState().folder;
  if (!folder) {
    folder = folderFromFiles([], useEditor.getState().doc.fields['TITLE'] || tr('新しい曲', 'New song'));
    useEditor.setState({ folder });
  }
  const list = [...tracks()];
  const added: StemTrack[] = [];
  let memory = 0;
  let reused = 0;
  // 種類と名前はファイル名から（一緒に読み込むファイル・もうあるステムと共通の部分は名前から除く）
  const guesses = guessStems(
    audio.map((f) => f.name),
    { existing: list.map((t) => t.file), taken: list.map((t) => t.name), hints: songHints() },
  );
  sset({ busy: tr('ステムをコピーしています…', 'Copying stems…') });
  try {
    for (const [i, f] of audio.entries()) {
      // 曲フォルダの stems/ にもう同じファイルがあれば、コピーせずにそれを使う
      const same = findFile(folder, `stems/${f.name}`);
      let path: string;
      if (same && same.size === f.size && !list.some((t) => t.file.toLowerCase() === same.path.toLowerCase())) {
        path = same.path;
        reused++;
      } else {
        path = stemFilePath(f.name, [...list.map((t) => t.file), ...[...folder.files.values()].map((x) => x.path)]);
        if ((await putFile(folder, path, f)) === 'memory') memory++;
      }
      const { kind, name } = guesses[i];
      const t: StemTrack = { file: path, name, kind, gain: 1, pan: 0, mute: false, solo: false, offsetMs: 0 };
      list.push(t);
      added.push(t);
    }
  } finally {
    sset({ busy: null });
  }
  setStems(list);
  // ステムの合計が原曲なので、初めてステムを入れたら原曲のトラックは消しておく（下のトラックで鳴らせる）
  if (firstStems && added.length) setMix({ origMute: true, origSolo: false });
  if (!useSidecar.getState().analysisStem) {
    const drums = list.find((t) => t.kind === 'drums');
    if (drums) setAnalysisStem(drums.file);
  }
  ensureBgmAnchor();
  await syncStems();
  checkLengths();
  toast(
    tr(
      `ステムを ${added.length} 本読み込みました：${added.map((t) => t.name).join('・')}${memory ? '（曲フォルダへは保存するときに書き出します）' : reused === added.length ? '（曲フォルダの stems/ にあるファイルを使います）' : '（曲フォルダの stems/ にコピー）'}。名前と種類はトラックの ✎ で変えられます`,
      `Loaded ${added.length} ${pl(added.length, 'stem')}: ${added.map((t) => t.name).join(', ')}${memory ? ' (written to the song folder when you save)' : reused === added.length ? ' (using the files already in stems/ in the song folder)' : ' (copied to stems/ in the song folder)'}. Change names and types with ✎ on each track`,
    ),
    'ok',
    7000,
  );
  return added.length;
}

/** ステムの基準になる BGM チップ（ch01）が無ければ作る（書き出す予定の bgm.ogg） */
function ensureBgmAnchor() {
  const doc = useEditor.getState().doc;
  if (bgmSource(doc)) return;
  edit(tr('ステム用に BGM の位置を用意', 'Add a BGM position for stems'), (d) => {
    const no = freeWavNumber(d) ?? 1;
    setField(d, 'WAV' + toBase36x2(no), 'bgm.ogg');
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 1, f: frac(0), v: no });
  });
}

/** 長さとサンプリングレートの違いを知らせる */
function checkLengths() {
  const ready = readyStems();
  if (ready.length < 2) return;
  const lens = ready.map((t) => loaded.get(t.file)!.raw.duration);
  const max = Math.max(...lens);
  const short = ready.filter((_, i) => max - lens[i] > 0.05);
  if (short.length)
    toast(
      tr(`${short.map((t) => t.name).join('・')} が他より短いので、末尾は無音として扱います`, `${short.map((t) => t.name).join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter than the others, so the end is treated as silence`),
      'info',
      6000,
    );
}

/** トラックの差 */
export interface StemInfo {
  duration: number;
  sampleRate: number;
  /** 一番長いステムより短い秒数 */
  shortBy: number;
}

export function stemInfo(file: string): StemInfo | null {
  const l = loaded.get(file);
  if (!l) return null;
  let max = 0;
  for (const x of loaded.values()) max = Math.max(max, x.raw.duration);
  return { duration: l.raw.duration, sampleRate: l.raw.sampleRate, shortBy: Math.max(0, max - l.raw.duration) };
}

const SAVED_FIELDS: (keyof StemTrack)[] = ['gain', 'pan', 'offsetMs', 'kind', 'name'];

export function updateStem(file: string, patch: Partial<StemTrack>) {
  const quiet = Object.keys(patch).every((k) => !SAVED_FIELDS.includes(k as keyof StemTrack));
  setStems(
    tracks().map((t) => (t.file === file ? { ...t, ...patch } : t)),
    { quiet },
  );
  if ('mute' in patch || 'solo' in patch) leaveListenPreset();
  if ('offsetMs' in patch) void syncStems();
  else applyStrips();
}

export function removeStem(file: string) {
  setStems(tracks().filter((t) => t.file !== file));
  if (tracks().length === 0) setMix({ origMute: false });
  if (useSidecar.getState().analysisStem === file) setAnalysisStem(tracks().find((t) => t.kind === 'drums')?.file ?? null);
  void syncStems();
}

/** トラックの名前を変える（空なら変えない。ほかのトラックと同じなら番号を付ける）。付けた名前を返す */
export function renameStem(file: string, name: string): string | null {
  const t = tracks().find((x) => x.file === file);
  const v = name.replace(/\s+/g, ' ').trim();
  if (!t || !v) return null;
  if (v === t.name) return v;
  const next = uniqueStemName(
    v,
    tracks()
      .filter((x) => x.file !== file)
      .map((x) => x.name),
  );
  updateStem(file, { name: next });
  // 解析元の表示（波形・打点: ドラム）も新しい名前に
  syncAnalysis();
  return next;
}

/**
 * 種類を変える（色・「ゲームと同じ」などの聞こえ方・BGM用の書き出しに効く）。
 * 名前が種類のまま（その他2 など）なら、名前も新しい種類にする。自分で付けた名前は残す
 */
export function setStemKind(file: string, kind: StemKind) {
  const t = tracks().find((x) => x.file === file);
  if (!t || t.kind === kind) return;
  const patch: Partial<StemTrack> = { kind };
  if (isKindLabel(t.name)) {
    patch.name = uniqueStemName(
      stemKindInfo(kind).label,
      tracks()
        .filter((x) => x.file !== file)
        .map((x) => x.name),
    );
  }
  updateStem(file, patch);
  // 種類で決まること（聞こえ方のプリセットのミュート・解析元の自動の選び方）をやり直す
  const listen = sget().listen;
  if (listen === 'drums' && !tracks().some((x) => x.kind === 'drums')) setListen('all');
  else if (listen !== 'custom') setListen(listen);
  syncAnalysis();
}

/** 曲名・アーティスト名（ステムの名前から除く） */
function songHints(): string[] {
  const f = useEditor.getState().doc.fields;
  return [f['TITLE'] ?? '', f['ARTIST'] ?? ''].filter(Boolean);
}

/** ファイル名から決めた種類と名前（「ファイル名から付け直す」用。ほかのトラックと共通の部分は除く） */
export function stemGuessFromFile(file: string): StemGuess | null {
  const others = tracks().filter((x) => x.file !== file);
  if (others.length === tracks().length) return null;
  return guessStems([file], { existing: others.map((x) => x.file), taken: others.map((x) => x.name), hints: songHints() })[0];
}

export function chooseAnalysisStem(file: string | null) {
  setAnalysisStem(file);
  syncAnalysis();
}

/** 原曲のトラック（音量・ミュート・ソロ） */
export function setOrigTrack(p: { gain?: number; mute?: boolean; solo?: boolean }) {
  setMix({ ...(p.gain !== undefined ? { bgm: p.gain } : {}), ...(p.mute !== undefined ? { origMute: p.mute } : {}), ...(p.solo !== undefined ? { origSolo: p.solo } : {}) });
  if (p.mute !== undefined || p.solo !== undefined) leaveListenPreset();
}

/** 譜面の音のトラック（音量・ミュート・ソロ） */
export function setChartTrack(p: { gain?: number; mute?: boolean; solo?: boolean }) {
  setMix({ ...(p.gain !== undefined ? { drums: p.gain } : {}), ...(p.mute !== undefined ? { drumMute: p.mute } : {}), ...(p.solo !== undefined ? { drumSolo: p.solo } : {}) });
  if (p.mute !== undefined || p.solo !== undefined) leaveListenPreset();
}

/** SE のトラック（音量・ミュート・ソロ） */
export function setSeTrack(p: { gain?: number; mute?: boolean; solo?: boolean }) {
  setMix({ ...(p.gain !== undefined ? { se: p.gain } : {}), ...(p.mute !== undefined ? { seMute: p.mute } : {}), ...(p.solo !== undefined ? { seSolo: p.solo } : {}) });
  if (p.mute !== undefined || p.solo !== undefined) leaveListenPreset();
}

/** このトラックだけをソロにする（Alt+S）。もう一度でソロを全部外す。id は 'orig'・'chart'・'se'・ステムのファイル */
export function soloOnly(id: string) {
  const m = engine.mix;
  const list = tracks();
  const only = (id === 'orig' ? m.origSolo : id === 'chart' ? m.drumSolo : id === 'se' ? m.seSolo : !!list.find((t) => t.file === id)?.solo) &&
    [m.origSolo && id !== 'orig', m.drumSolo && id !== 'chart', m.seSolo && id !== 'se', ...list.map((t) => t.solo && t.file !== id)].every((x) => !x);
  setStems(
    list.map((t) => ({ ...t, solo: !only && t.file === id })),
    { quiet: true },
  );
  setMix({ origSolo: !only && id === 'orig', drumSolo: !only && id === 'chart', seSolo: !only && id === 'se' });
  leaveListenPreset();
  applyStrips();
}

// ---- 聞こえ方 -------------------------------------------------------------------

type ListenPresetDef = { id: Exclude<ListenPreset, 'custom'>; label: string; hint: string; hintNoStems: string };

export const LISTEN_PRESETS: ListenPresetDef[] = [
  withTr({ id: 'all' } as ListenPresetDef, {
    label: ['全部', 'All'],
    hint: ['すべてのステムと譜面の音を鳴らします（原曲のトラックはステムと重なるので消します）。', 'Plays all stems and the chart sounds (the original track is muted because it overlaps the stems).'],
    hintNoStems: ['原曲と譜面の音を鳴らします。', 'Plays the original and the chart sounds.'],
  }),
  withTr({ id: 'game' } as ListenPresetDef, {
    label: ['ゲームと同じ', 'Like the game'],
    hint: [
      'ドラム以外のステムと譜面の音を鳴らします。NXで遊ぶときと同じ聞こえ方で、譜面だけでドラムが成り立っているか確かめます。',
      'Plays the non-drum stems and the chart sounds, just like playing in NX, so you can check that the chart alone carries the drums.',
    ],
    hintNoStems: [
      'ステムが無いので原曲にドラムが入ったままです（「全部」と同じ）。ドラムのステムを読み込むと、ドラム抜きで聴けます。',
      'Without stems the original still contains the drums (same as "All"). Load a drum stem to listen without the drums.',
    ],
  }),
  withTr({ id: 'drums' } as ListenPresetDef, {
    label: ['ドラムだけ', 'Drums only'],
    hint: ['ドラムのステムだけを鳴らし、譜面の音は止めます。', 'Plays only the drum stem and mutes the chart sounds.'],
    hintNoStems: ['ドラムのステムを読み込むと使えます。', 'Available after loading a drum stem.'],
  }),
  withTr({ id: 'compare' } as ListenPresetDef, {
    label: ['聴き比べ', 'Compare'],
    hint: [
      'ドラムのステムを左、譜面の音を右に振って同時に鳴らします。ずれや抜けを聞き分けられます。',
      'Plays the drum stem panned left and the chart sounds panned right at the same time, so you can hear offsets and missing notes.',
    ],
    hintNoStems: [
      '原曲を左、譜面の音を右に振って同時に鳴らします。ずれや抜けを聞き分けられます。',
      'Plays the original panned left and the chart sounds panned right at the same time, so you can hear offsets and missing notes.',
    ],
  }),
];

export function setListen(p: Exclude<ListenPreset, 'custom'>) {
  const list = tracks();
  const has = list.length > 0;
  const drumsOnly = (t: StemTrack) => t.kind === 'drums';
  const hasDrumStem = list.some(drumsOnly);
  // プリセットはソロを使わずミュートで作る（ソロはトラックをまたいで効くので）。ステムがあれば原曲のトラックは重なるので消す
  const base = { bgmMute: false, origMute: has, origSolo: false, drumSolo: false, drumMute: false, drumPan: 0, bgmPan: 0, seMute: false, seSolo: false };
  let next = list;
  switch (p) {
    case 'all':
      next = list.map((t) => ({ ...t, mute: false, solo: false }));
      setMix(base);
      break;
    case 'game':
      next = list.map((t) => ({ ...t, mute: drumsOnly(t), solo: false }));
      setMix(base);
      break;
    case 'drums':
      if (!hasDrumStem) return;
      next = list.map((t) => ({ ...t, mute: !drumsOnly(t), solo: false }));
      setMix({ ...base, drumMute: true });
      break;
    case 'compare':
      next = list.map((t) => ({ ...t, mute: hasDrumStem && !drumsOnly(t), solo: false }));
      setMix({ ...base, drumPan: 1, bgmPan: has ? 0 : -1 });
      break;
  }
  setStems(next, { quiet: true });
  sset({ listen: p });
  applyStrips();
  saveMix();
}

/** M・S を個別に変えたら、プリセットから外れる（聴き比べの左右も戻す） */
export function leaveListenPreset() {
  if (sget().listen === 'custom') return;
  if (sget().listen === 'compare') setMix({ drumPan: 0, bgmPan: 0 });
  sset({ listen: 'custom' });
  applyStrips();
  saveMix();
}

/** 曲の音（原曲・SE・ステム）をまとめてミュート（Alt+1）。トラックごとのミュートはそのまま */
export function toggleBgmMute() {
  setMix({ bgmMute: !engine.mix.bgmMute });
  leaveListenPreset();
}

/** 譜面の音のミュート（Alt+2） */
export function toggleDrumMute() {
  setMix({ drumMute: !engine.mix.drumMute });
  leaveListenPreset();
}

function saveMix() {
  const m = engine.mix;
  const saved: SavedMix = {
    bgm: m.bgm,
    drums: m.drums,
    bgmMute: m.bgmMute,
    drumMute: m.drumMute,
    metronome: m.metronome,
    click: m.click,
    clickBarOnly: m.clickBarOnly,
    listen: sget().listen,
    origMute: m.origMute,
    origSolo: m.origSolo,
    drumSolo: m.drumSolo,
    se: m.se,
    seMute: m.seMute,
    seSolo: m.seSolo,
  };
  rememberMix(saved);
}

// マスターの音量は曲ごとではなく、このブラウザに覚える
const MASTER_KEY = 'dtxe.master.v1';
try {
  const j = JSON.parse(localStorage.getItem(MASTER_KEY) || 'null') as { master?: number; masterMute?: boolean } | null;
  if (j && typeof j.master === 'number' && Number.isFinite(j.master)) setMix({ master: Math.max(0, Math.min(1, j.master)), masterMute: !!j.masterMute });
} catch {
  // 覚えていなくても動く
}

// ミックスを変えたら作業ファイルに覚えておく
useEditor.subscribe((s, prev) => {
  if (s.mix !== prev.mix) {
    saveMix();
    if (s.mix.origSolo !== prev.mix.origSolo || s.mix.drumSolo !== prev.mix.drumSolo || s.mix.seSolo !== prev.mix.seSolo) applyStrips();
    syncOrigPlayback();
    if (s.mix.master !== prev.mix.master || s.mix.masterMute !== prev.mix.masterMute) {
      try {
        localStorage.setItem(MASTER_KEY, JSON.stringify({ master: s.mix.master, masterMute: s.mix.masterMute }));
      } catch {
        // 覚えられなくても動く
      }
    }
  }
  if (s.folder !== prev.folder && tracks().length) void syncStems();
});

// 曲を開き直したら、その曲のミックスとステムを当てる
useSidecar.subscribe((s, prev) => {
  if (s.loadSeq !== prev.loadSeq) {
    const m = s.mix;
    const hasStems = s.stems.length > 0;
    sset({ listen: m?.listen ?? 'all' });
    const tracksMix = {
      origMute: m?.origMute ?? hasStems,
      origSolo: m?.origSolo ?? false,
      drumSolo: m?.drumSolo ?? false,
      se: m?.se ?? 1,
      seMute: m?.seMute ?? false,
      seSolo: m?.seSolo ?? false,
    };
    setMix(
      m
        ? { bgm: m.bgm, drums: m.drums, bgmMute: m.bgmMute, drumMute: m.drumMute, metronome: m.metronome, click: m.click, clickBarOnly: m.clickBarOnly, drumPan: 0, bgmPan: 0, ...tracksMix }
        : { bgmMute: false, drumMute: false, drumPan: 0, bgmPan: 0, ...tracksMix },
    );
    if (m?.listen === 'compare') setMix({ drumPan: 1, bgmPan: hasStems ? 0 : -1 });
    void syncStems();
    return;
  }
  if (s.stems !== prev.stems && s.stems.length !== prev.stems.length) void syncStems();
});

// ---- 書き出し -------------------------------------------------------------------

export type ExportMode = 'bgm' | 'all' | 'selected' | 'each';
export type ExportRange = 'song' | 'loop' | 'selection';

export interface ExportOptions {
  mode: ExportMode;
  include: string[];
  useTrackSettings: boolean;
  normalize: boolean;
  range: ExportRange;
  format: 'ogg' | 'wav';
  fileName: string;
  /** 書き出したあとエディタ（譜面）に反映するか：BGM（#WAV と ch01）・試聴（#PREVIEW）・しない（ファイルだけ） */
  register: 'bgm' | 'preview' | 'none';
}

/** 範囲（ステムの頭からの秒） */
export function exportRangeSec(range: ExportRange): { from: number; to: number } | null {
  const s = useEditor.getState();
  const doc = s.doc;
  const tempo = tempoOf(doc);
  const at = bgmSource(doc)?.sec ?? 0;
  const total = stemsDuration();
  if (range === 'song') return { from: 0, to: total };
  if (range === 'loop') {
    const loop = useAssist.getState().loop;
    if (!loop || loop.b <= loop.a) return null;
    return { from: tempo.beatToSec(loop.a) - at, to: tempo.beatToSec(loop.b) - at };
  }
  const sel = new Set(s.selection);
  const chips = doc.chips.filter((c) => sel.has(c.id));
  if (!chips.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of chips) {
    lo = Math.min(lo, c.m);
    hi = Math.max(hi, c.m);
  }
  return { from: tempo.beatToSec(tempo.measureStart(lo)) - at, to: tempo.beatToSec(tempo.measureStart(hi + 1)) - at };
}

function cleanName(n: string) {
  return n.replace(/[\\/:*?"<>|]/g, '_').trim();
}

export async function exportStems(o: ExportOptions): Promise<string[]> {
  const doc0 = useEditor.getState().doc;
  const folder = useEditor.getState().folder;
  if (!folder) {
    toast(tr('先に曲フォルダを開いてください', 'Open a song folder first'), 'warn');
    return [];
  }
  const list = readyStems().filter((t) => o.include.includes(t.file));
  if (!list.length) {
    toast(tr('書き出すステムを選んでください', 'Choose the stems to export'), 'warn');
    return [];
  }
  const range = exportRangeSec(o.mode === 'bgm' ? 'song' : o.range);
  if (!range || range.to - range.from < 0.1) {
    toast(o.range === 'loop' ? tr('ループ範囲がありません', 'There is no loop range') : tr('選択範囲がありません（チップを選んでください）', 'Nothing is selected (select some chips)'), 'warn');
    return [];
  }
  const fade = o.mode !== 'bgm' && o.range !== 'song' ? 1 : 0;
  const ext = o.format === 'ogg' ? '.ogg' : '.wav';
  const jobs: { name: string; tracks: StemTrack[] }[] =
    o.mode === 'each'
      ? list.map((t) => ({ name: `${cleanName(o.fileName.replace(/\{(名前|name)\}/g, t.name)) || `stems_${t.name}`}${ext}`, tracks: [t] }))
      : [{ name: `${cleanName(o.fileName.replace(/\.(ogg|wav)$/i, '')) || 'bgm'}${ext}`, tracks: list }];
  const written: string[] = [];
  let memory = 0;
  try {
    for (const [i, j] of jobs.entries()) {
      sset({ busy: tr(`書き出し中 ${i + 1}/${jobs.length}: ${j.name}（ミックス）`, `Exporting ${i + 1}/${jobs.length}: ${j.name} (mixing)`) });
      const buf = await renderMix(
        j.tracks.map((t) => ({ buf: loaded.get(t.file)!.buf, gain: o.useTrackSettings ? t.gain : 1, pan: o.useTrackSettings ? t.pan : 0 })),
        { from: range.from, to: range.to, fade, peakDb: o.normalize ? -1 : null },
      );
      const bytes = await encodeAudio(buf, o.format, (p) =>
        sset({ busy: tr(`書き出し中 ${i + 1}/${jobs.length}: ${j.name}（${o.format.toUpperCase()} ${Math.round(p * 100)}%）`, `Exporting ${i + 1}/${jobs.length}: ${j.name} (${o.format.toUpperCase()} ${Math.round(p * 100)}%)`) }),
      );
      if ((await putFile(folder, j.name, bytes)) === 'memory') memory++;
      written.push(j.name);
    }
  } catch (e) {
    toast(tr(`書き出せませんでした: ${(e as Error).message}`, `Couldn't export: ${(e as Error).message}`), 'error', 8000);
    return written;
  } finally {
    sset({ busy: null });
  }
  const reflect = o.mode !== 'each' ? o.register : 'none';
  const prev = reflect !== 'none' ? registerExport(written[0], reflect, doc0) : undefined;
  if (reflect === 'none') void prepareSounds();
  const later = memory ? tr('。曲フォルダへは保存するときに書き出します', '. It is written to the song folder when you save') : '';
  const was = prev && prev !== written[0] ? (reflect === 'bgm' ? tr(`（前は ${prev}。元のファイルは残しています）`, ` (was ${prev}; the old file is kept)`) : tr(`（前は ${prev}）`, ` (was ${prev})`)) : '';
  toast(
    reflect === 'bgm'
      ? tr(`${written[0]} を書き出して、エディタの BGM に反映しました${was}${later}`, `Exported ${written[0]} and set it as the BGM in the editor${was}${later}`)
      : reflect === 'preview'
        ? tr(`${written[0]} を書き出して、選曲画面の試聴（#PREVIEW）に反映しました${was}${later}`, `Exported ${written[0]} and set it as the song select preview (#PREVIEW)${was}${later}`)
        : tr(`${written.join('、')} を書き出しました（エディタには反映していません）${later}`, `Exported ${written.join(', ')} (not added to the editor)${later}`),
    'ok',
    7000,
  );
  return written;
}

/** 書き出した音をエディタ（譜面）に反映する。前のファイル名を返す（無ければ null） */
export function registerExport(file: string, how: 'bgm' | 'preview', doc0 = useEditor.getState().doc): string | null {
  const before = sget().reflected[how];
  if (how === 'preview') {
    const cur = useEditor.getState().doc.fields['PREVIEW'] ?? null;
    edit(tr('書き出した音を試聴（#PREVIEW）に反映', 'Set the exported audio as the preview (#PREVIEW)'), (d) => setField(d, 'PREVIEW', file));
    // 同じファイルに書き出し直したときは、最初の「前」を覚えておく
    const prev = before && before.file === file && cur === file ? before.prev : cur;
    sset((st) => ({ reflected: { ...st.reflected, preview: { file, prev } } }));
    return prev;
  }
  const bgm = bgmSource(doc0);
  const cur = bgm ? (doc0.fields['WAV' + toBase36x2(bgm.wav)] ?? null) : null;
  let wav = bgm?.wav ?? 1;
  let chipId: number | undefined;
  edit(tr('書き出した音を BGM に反映', 'Set the exported audio as the BGM'), (d) => {
    if (bgm) {
      setField(d, 'WAV' + toBase36x2(bgm.wav), file);
      return;
    }
    wav = freeWavNumber(d) ?? 1;
    setField(d, 'WAV' + toBase36x2(wav), file);
    chipId = d.nextId;
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 1, f: frac(0), v: wav });
  });
  const again = before && before.file === file && cur === file;
  const r: AudioReflect = again ? before : { file, prev: cur, wav, chipId };
  sset((st) => ({ reflected: { ...st.reflected, bgm: r } }));
  void prepareSounds();
  // エディタに戻ったら、差し替えた原曲（BGM）の行を光らせる
  glowReflected({ bgm: true });
  return r.prev;
}

/** 反映した BGM・試聴が、今もエディタの譜面に入っているか（元に戻す・Ctrl+Z で外れたら null） */
export function audioReflected(how: 'bgm' | 'preview', doc = useEditor.getState().doc): AudioReflect | null {
  const r = sget().reflected[how];
  if (!r) return null;
  if (how === 'preview') return doc.fields['PREVIEW'] === r.file ? r : null;
  const bgm = bgmSource(doc);
  return bgm && doc.fields['WAV' + toBase36x2(bgm.wav)] === r.file ? r : null;
}

/** 反映した BGM・試聴を、反映する前に戻す（書き出したファイルは消さない） */
export function undoAudioReflect(how: 'bgm' | 'preview') {
  const r = audioReflected(how);
  if (!r) return;
  if (how === 'preview') {
    edit(tr('試聴（#PREVIEW）を元に戻す', 'Revert the preview (#PREVIEW)'), (d) => setField(d, 'PREVIEW', r.prev ?? undefined));
  } else {
    edit(tr('BGM を元に戻す', 'Revert the BGM'), (d) => {
      if (r.chipId !== undefined) {
        const i = d.chips.findIndex((c) => c.id === r.chipId);
        if (i >= 0) d.chips.splice(i, 1);
      }
      setField(d, 'WAV' + toBase36x2(r.wav ?? 1), r.chipId !== undefined ? undefined : (r.prev ?? undefined));
    });
    void prepareSounds();
  }
  sset((st) => ({ reflected: { ...st.reflected, [how]: null } }));
  const what = how === 'bgm' ? 'BGM' : tr('試聴（#PREVIEW）', 'the preview (#PREVIEW)');
  toast(
    r.prev
      ? tr(`${what} を元の ${r.prev} に戻しました（書き出した ${r.file} は曲フォルダに残っています）`, `Set ${what} back to ${r.prev} (the exported ${r.file} stays in the song folder)`)
      : tr(`${what} を反映する前に戻しました（書き出した ${r.file} は曲フォルダに残っています）`, `Reverted ${what} (the exported ${r.file} stays in the song folder)`),
    'ok',
    6000,
  );
}

// 別の曲を開いたら、反映した記録は捨てる（保存では捨てない）
let seenDocs = openedDocs;
useEditor.subscribe(() => {
  if (openedDocs === seenDocs) return;
  seenDocs = openedDocs;
  if (sget().reflected.bgm || sget().reflected.preview) sset({ reflected: { bgm: null, preview: null } });
});

/**
 * 書き出しのファイル名の初期値。BGM用は今の BGM のファイル名だが、
 * それが曲フォルダにある元の原曲（ドラム入り）なら上書きしないよう別の名前にする。
 */
export function defaultExportName(mode: ExportMode, format: 'ogg' | 'wav'): string {
  const ext = format === 'ogg' ? '.ogg' : '.wav';
  if (mode === 'each') return tr('stems_{名前}', 'stems_{name}');
  if (mode === 'all') return `preview${ext}`;
  if (mode === 'selected') return `mix${ext}`;
  const s = useEditor.getState();
  const bgm = bgmSource(s.doc);
  const p = bgm ? wavPath(s.doc, bgm.wav) : null;
  if (!p) return `bgm${ext}`;
  const name = p.split(/[\\/]/).pop() ?? `bgm${ext}`;
  const base = name.replace(/\.[^.]+$/, '');
  if (!findFile(s.folder, p, s.doc.fields['PATH_WAV'] ?? '') || /drumless|nodrum|ドラム抜き/i.test(base)) return base + ext;
  return `${base}_drumless${ext}`;
}

/** 曲フォルダにもうあるファイルか（上書きの確認用） */
export function fileExists(name: string): boolean {
  return !!findFile(useEditor.getState().folder, name);
}
