// 難易度ガイドライン：手元の曲の譜面を解析してレベル帯ごとに集計し、基準文（AI の下書き → 作者が直す）を持つ。
// - DTXMania の曲を覚えていれば、裏で譜面を読んで物差しを作る（初めは全部、次からは変わった譜面だけ）。始める操作は要らない
//   （楯さん 2026-11-14「入口が分からず一度も使っていない。ライブラリを使ったら？」）
// - どの譜面を物差しに入れるかは guide/ruler.ts（AI で作った譜面・このエディタで直している譜面などは入れない）
// - 曲のフォルダ・ZIP・音源ライブラリから取り込んだ譜面も足せる（DTXMania の曲を使えないブラウザ・iPad 用）
// - 解析した譜面・基準文・設定はこのブラウザ（IndexedDB）に残す。基準文は JSON で書き出し・読み込みできる
import { tr, pl } from '../i18n';
import { create } from 'zustand';
import { decodeDtx } from '../dtx/encoding';
import { readOrigin } from '../dtx/origin';
import { parseDtx } from '../dtx/parse';
import { buildTempoMap } from '../dtx/timing';
import { LEVEL_VERSION, migrateLevel } from '../check/level';
import { defaultLabel, folderFromFileList, folderFromHandle, parseSetDef, type SongFolder } from '../fs/folder';
import { folderOf, readZip } from '../fs/zip';
import { chartFeatures } from '../gen/features';
import {
  bandLine,
  BANDS,
  bandStats,
  buildRuler,
  chartLabel,
  chartSig,
  estimatePlayLevel,
  isDtxFile,
  nxChartId,
  playPoints,
  representatives,
  type ChartEntry,
  type PlayEstimate,
  type PlayPoint,
  type Ruler,
} from '../guide/ruler';
import { fileAt } from '../nxlib/check';
import { levelOf, parseScoreIni, type ScoreRec } from '../nxlib/parse';
import type { LibSong } from '../nxlib/scan';
import { songDirOf, useNxLib } from '../nxlib/store';
import { toast } from './editor';
import { runAi } from './ai';
import { guideSchema, guidelinePrompt } from '../ai/judge';

export {
  BANDS,
  bandOf,
  bandStats,
  chartLine,
  findOutliers,
  nearestCharts,
  predictLevel,
  representatives,
  usableCharts,
  type BandStats,
  type ChartEntry,
  type Outlier,
  type Ruler,
  type SkipWhy,
} from '../guide/ruler';

export interface GuideRow {
  text: string;
  basis: string;
  origin: 'ai' | 'edited' | 'manual';
}

export interface GuideBand {
  status: 'none' | 'ai' | 'confirmed';
  rows: GuideRow[];
}

export interface Guideline {
  version: number;
  updatedAt: number;
  bands: Record<number, GuideBand>;
}

export const emptyGuideline = (): Guideline => ({ version: 0, updatedAt: 0, bands: Object.fromEntries(BANDS.map((b) => [b, { status: 'none', rows: [] }])) });

export interface GuideSettings {
  /** 物差しに入れない BOX の鍵（DTXMania の曲。練習用・ネタ曲の BOX など） */
  boxesOff: string[];
}

const defaultSettings = (): GuideSettings => ({ boxesOff: [] });

// ---- 保存先 ---------------------------------------------------------------------------

const DB = 'dtx-web-editor-guideline';
let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('charts', { keyPath: 'id' });
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function os(name: 'charts' | 'kv', mode: IDBTransactionMode = 'readonly') {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

async function putCharts(list: readonly ChartEntry[], drop: readonly string[] = []) {
  if (!list.length && !drop.length) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('charts', 'readwrite');
      const st = t.objectStore('charts');
      for (const e of list) st.put(e);
      for (const id of drop) st.delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch {
    // 覚えられなくても今回の物差しには使う（次に開いたら読み直す）
  }
}

// ---- 状態 -----------------------------------------------------------------------------

export interface GuidelineState {
  loaded: boolean;
  /** 解析した譜面（DTXMania の曲と、取り込んだ曲） */
  charts: ChartEntry[];
  guide: Guideline;
  band: number;
  /** 曲のフォルダ・ZIP の取り込み */
  scanning: { done: number; total: number; label: string } | null;
  /** DTXMania の曲の譜面を裏で解析している */
  analyzing: { done: number; total: number } | null;
  settings: GuideSettings;
}

export const useGuideline = create<GuidelineState>(() => ({
  loaded: false,
  charts: [],
  guide: emptyGuideline(),
  band: 5,
  scanning: null,
  analyzing: null,
  settings: defaultSettings(),
}));
const get = useGuideline.getState;
const set = useGuideline.setState;

let loading: Promise<void> | null = null;

/** 前の版の推定レベルで保存した譜面は、今の式の値に直して使う */
function upgradeEntry(c: ChartEntry): ChartEntry {
  if (!c.feat || (c.feat.mechVer ?? 1) >= LEVEL_VERSION) return c;
  return { ...c, feat: { ...c.feat, mech: migrateLevel(c.feat.mech, c.feat.density, c.feat.peakNps), mechVer: LEVEL_VERSION } };
}

export function loadGuideline(): Promise<void> {
  loading ??= (async () => {
    try {
      const charts = ((await wrap((await os('charts')).getAll() as IDBRequest<ChartEntry[]>)) ?? []).map(upgradeEntry);
      const guide = ((await wrap((await os('kv')).get('guideline') as IDBRequest<Guideline | undefined>)) as Guideline | undefined) ?? emptyGuideline();
      const settings = ((await wrap((await os('kv')).get('settings') as IDBRequest<GuideSettings | undefined>)) as GuideSettings | undefined) ?? defaultSettings();
      set({ loaded: true, charts, guide: { ...emptyGuideline(), ...guide, bands: { ...emptyGuideline().bands, ...guide.bands } }, settings: { ...defaultSettings(), ...settings } });
    } catch {
      set({ loaded: true });
    }
  })();
  return loading;
}

async function saveGuide(g: Guideline) {
  set({ guide: g });
  try {
    await wrap((await os('kv', 'readwrite')).put(g, 'guideline'));
  } catch {
    toast(tr('ガイドラインを保存できませんでした（ブラウザの保存領域）', "Couldn't save the guidelines (browser storage)"), 'error');
  }
}

async function saveSettings(s: GuideSettings) {
  set({ settings: s });
  try {
    await wrap((await os('kv', 'readwrite')).put(s, 'settings'));
  } catch {
    // 覚えられなくても今は効く
  }
}

/**
 * 譜面のレベル（#DLEVEL と #DLVDEC）。DTXMania と同じく、#DLEVEL が 100 以上なら 3 桁（825 → 8.25）、
 * 2 桁以下なら 1/10 に #DLVDEC を小数 2 桁目に（82・5 → 8.25）。書いていない・0 なら null
 */
export function levelOfField(raw: string | undefined, dec?: string): number | null {
  const lv = levelOf(raw, dec);
  return lv === null || !(lv > 0) ? null : Math.min(9.99, lv);
}

// ---- 物差し ---------------------------------------------------------------------------

let memo: { charts: ChartEntry[]; songs: readonly LibSong[] | undefined; settings: GuideSettings; ruler: Ruler } | null = null;

/** DTXMania の曲（覚えていない・まだ読んでいなければ undefined） */
function nxSongs(): readonly LibSong[] | undefined {
  const nx = useNxLib.getState();
  return nx.ready && nx.place ? nx.songs : undefined;
}

/** 今の物差し（使う譜面・入れない譜面とわけ）。同じ入力なら作り直さない */
export function currentRuler(): Ruler {
  const { charts, settings } = get();
  const songs = nxSongs();
  if (memo && memo.charts === charts && memo.songs === songs && memo.settings === settings) return memo.ruler;
  const ruler = buildRuler({ entries: charts, songs, boxesOff: new Set(settings.boxesOff) });
  memo = { charts, songs, settings, ruler };
  return ruler;
}

/** 画面用：物差し（譜面・DTXMania の曲・設定が変わったら作り直す） */
export function useRuler(): Ruler {
  useGuideline((s) => s.charts);
  useGuideline((s) => s.settings);
  useNxLib((s) => s.songs);
  useNxLib((s) => s.place);
  useNxLib((s) => s.ready);
  return currentRuler();
}

/** 物差しに使う譜面（AI のレベル判定・難易度生成の「似た譜面」はここから探す） */
export function rulerCharts(): ChartEntry[] {
  return currentRuler().use;
}

/** 遊んだ譜面の成績（物差しと同じ決まりで外す） */
export function currentPlays(): PlayPoint[] {
  const { charts, settings } = get();
  return playPoints({ entries: charts, songs: nxSongs(), boxesOff: new Set(settings.boxesOff) });
}

let playMemo: { charts: ChartEntry[]; songs: readonly LibSong[] | undefined; settings: GuideSettings; est: PlayEstimate; points: PlayPoint[] } | null = null;

/** 成績からの遊ぶレベルのめやす */
export function currentPlayEstimate(): { est: PlayEstimate; points: PlayPoint[] } {
  const { charts, settings } = get();
  const songs = nxSongs();
  if (playMemo && playMemo.charts === charts && playMemo.songs === songs && playMemo.settings === settings) return playMemo;
  const points = currentPlays();
  playMemo = { charts, songs, settings, points, est: estimatePlayLevel(points) };
  return playMemo;
}

/** 画面用：成績からの遊ぶレベルのめやす（成績・設定が変わったら作り直す） */
export function usePlayEstimate(): { est: PlayEstimate; points: PlayPoint[] } {
  useGuideline((s) => s.charts);
  useGuideline((s) => s.settings);
  useNxLib((s) => s.songs);
  useNxLib((s) => s.place);
  useNxLib((s) => s.ready);
  return currentPlayEstimate();
}

// ---- 物差しの手直し -------------------------------------------------------------------------

function patchEntry(id: string, p: Partial<ChartEntry>) {
  let hit: ChartEntry | undefined;
  const charts = get().charts.map((c) => (c.id === id ? (hit = { ...c, ...p }) : c));
  if (!hit) return;
  set({ charts });
  void putCharts([hit]);
}

/** 手で物差しから外す・戻す */
export async function setExcluded(id: string, excluded: boolean) {
  patchEntry(id, { excluded });
}

/** このエディタで直した譜面を、物差しに入れる・入れないに戻す */
export async function setIncluded(id: string, include: boolean) {
  patchEntry(id, { include });
}

/** BOX を物差しに入れる・入れない */
export function setBoxOff(key: string, off: boolean) {
  const s = get().settings;
  const boxesOff = off ? [...new Set([...s.boxesOff, key])] : s.boxesOff.filter((k) => k !== key);
  void saveSettings({ ...s, boxesOff });
}

/** 取り込んだ譜面を忘れる（DTXMania の曲から作った分は残る） */
export async function clearImported() {
  const drop = get().charts.filter((c) => c.src !== 'nx').map((c) => c.id);
  set({ charts: get().charts.filter((c) => c.src === 'nx') });
  await putCharts([], drop);
}

// ---- DTXMania の曲から作る ---------------------------------------------------------------

let syncing = false;
let syncAgain = false;
let syncRun = 0;

const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

/** 物差しに入るかもしれない譜面（AI で作った・ドラムの無い・レベルの無い譜面は読まない） */
function wanted(s: LibSong, c: LibSong['charts'][number]): boolean {
  return isDtxFile(c.file) && !c.head.ai && s.drums !== false && c.head.level !== null && c.head.level > 0;
}

/**
 * DTXMania の曲の譜面を裏で解析して物差しに入れる（まだの譜面・変わった譜面だけ）。読み書きの許可が無ければ何もしない。
 * 一覧から消えた譜面の解析は忘れる
 */
export async function syncGuideFromNx(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return;
  }
  const nx = useNxLib.getState();
  if (!nx.place || nx.perm !== 'granted' || nx.scan || !nx.songs.length) return;
  syncing = true;
  try {
    await loadGuideline();
    do {
      syncAgain = false;
      await syncOnce(++syncRun);
    } while (syncAgain);
  } finally {
    syncing = false;
    set({ analyzing: null });
  }
}

/** 裏の解析をやめる（読んだ所までは残す） */
export function stopGuideSync() {
  syncRun++;
}

async function syncOnce(run: number) {
  const nx = useNxLib.getState();
  const place = nx.place;
  const songs = nx.songs;
  const prev = new Map(get().charts.filter((c) => c.src === 'nx').map((c) => [c.id, c]));
  const alive = new Set<string>();
  const todo: { s: LibSong; c: LibSong['charts'][number]; id: string }[] = [];
  for (const s of songs) {
    for (const c of s.charts) {
      if (!wanted(s, c)) continue;
      const id = nxChartId(s.id, c.file);
      alive.add(id);
      const e = prev.get(id);
      if (e && e.sig === chartSig(c)) continue;
      todo.push({ s, c, id });
    }
  }
  // 一覧の読み込みが済んでいれば、消えた譜面の解析を忘れる
  const gone = useNxLib.getState().scan ? [] : [...prev.keys()].filter((id) => !alive.has(id));
  if (gone.length) {
    const g = new Set(gone);
    set({ charts: get().charts.filter((c) => !g.has(c.id)) });
    await putCharts([], gone);
  }
  if (!todo.length) return;
  const stopped = () => run !== syncRun || useNxLib.getState().place !== place || useNxLib.getState().perm !== 'granted';
  let done = 0;
  let batch: ChartEntry[] = [];
  let shown = Date.now();
  const flush = async () => {
    if (!batch.length) return;
    const add = new Map(batch.map((e) => [e.id, e]));
    batch = [];
    const charts = get().charts.filter((c) => !add.has(c.id));
    set({ charts: [...charts, ...add.values()] });
    await putCharts([...add.values()]);
  };
  set({ analyzing: { done: 0, total: todo.length } });
  const dirs = new Map<string, FileSystemDirectoryHandle | null>();
  for (const t of todo) {
    if (stopped()) break;
    try {
      let dir = dirs.get(t.s.id);
      if (dir === undefined) {
        dir = await songDirOf(t.s);
        dirs.clear();
        dirs.set(t.s.id, dir);
      }
      const h = dir && (await fileAt(dir, t.c.file));
      if (h) {
        const { text } = decodeDtx(new Uint8Array(await (await h.getFile()).arrayBuffer()));
        const { doc } = parseDtx(text);
        const feat = chartFeatures(doc, buildTempoMap(doc));
        const was = prev.get(t.id);
        batch.push({
          id: t.id,
          src: 'nx',
          song: t.s.title || doc.fields['TITLE'] || '',
          artist: t.s.artist,
          label: chartLabel(t.c),
          file: t.c.file,
          folder: t.s.path.join('/'),
          level: t.c.head.level,
          feat,
          excluded: was?.excluded ?? false,
          include: was?.include,
          addedAt: Date.now(),
          songId: t.s.id,
          slot: t.c.slot,
          sig: chartSig(t.c),
          ai: t.c.head.ai || readOrigin(doc) !== null,
          work: t.c.work,
        });
      }
    } catch {
      // 読めない譜面は飛ばす（次の読み込みでもう一度）
    }
    done++;
    if (batch.length >= 40 || Date.now() - shown > 700) {
      shown = Date.now();
      await flush();
      set({ analyzing: { done, total: todo.length } });
    }
    await breathe();
  }
  await flush();
}

let inited = false;

/**
 * アプリを開いたとき：残しておいた物差しを読み、DTXMania の曲の一覧が読み終わるたびに（許可があれば）裏で変わった譜面だけ解析する
 */
export function initGuideline() {
  if (inited) return;
  inited = true;
  void loadGuideline();
  let last: readonly LibSong[] | null = null;
  let timer = 0;
  const kick = (s: ReturnType<typeof useNxLib.getState>) => {
    if (!s.ready || !s.place || s.perm !== 'granted' || s.scan || s.checking || !s.songs.length || s.songs === last) return;
    last = s.songs;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void syncGuideFromNx(), 1200);
  };
  useNxLib.subscribe((s, p) => {
    if (s.place !== p.place) stopGuideSync();
    kick(s);
  });
  kick(useNxLib.getState());
}

// ---- 取り込み ---------------------------------------------------------------------------

/** 曲フォルダ（またはその親）の譜面を解析して物差しに加える */
export async function scanCharts(folder: SongFolder, opts: { quiet?: boolean } = {}): Promise<number> {
  await loadGuideline();
  const dtx = [...folder.files.values()].filter((f) => /\.dtx$/i.test(f.name));
  if (dtx.length === 0) {
    if (!opts.quiet) toast(tr('DTXファイルが見つかりませんでした', 'No DTX files found'), 'warn');
    return 0;
  }
  const byPath = new Map([...folder.files.values()].map((f) => [f.path.toLowerCase(), f]));
  // set.def のラベル
  const labels = new Map<string, string>();
  for (const f of folder.files.values()) {
    if (f.name.toLowerCase() !== 'set.def') continue;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    try {
      const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
      for (const e of parseSetDef(text)) e.levels.forEach((l, i) => labels.set((dir + l.file).toLowerCase(), l.label || defaultLabel(i + 1)));
    } catch {
      // 読めない set.def は無視
    }
  }
  const prev = new Map(get().charts.map((c) => [c.id, c]));
  const added: ChartEntry[] = [];
  let done = 0;
  set({ scanning: { done: 0, total: dtx.length, label: tr('譜面を解析しています…', 'Analyzing charts…') } });
  for (const f of dtx) {
    try {
      const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
      const { doc } = parseDtx(text);
      const feat = chartFeatures(doc, buildTempoMap(doc));
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const id = `${folder.name}/${f.path}`.toLowerCase();
      const base = f.path.replace(/\.dtx$/i, '').toLowerCase();
      // 成績（DTXMania が譜面の横に書く「譜面の名前.score.ini」）。曲のフォルダごと取り込んだときだけある
      let score: ScoreRec | null = null;
      const sf = byPath.get(`${f.path.toLowerCase()}.score.ini`);
      if (sf) {
        try {
          score = parseScoreIni(decodeDtx(new Uint8Array(await (await sf.getFile()).arrayBuffer())).text);
        } catch {
          score = null;
        }
      }
      const was = prev.get(id);
      const e: ChartEntry = {
        id,
        song: doc.fields['TITLE'] || dir.split('/').pop() || f.name,
        artist: doc.fields['ARTIST'] ?? '',
        label: labels.get(f.path.toLowerCase()) ?? f.name.replace(/\.dtx$/i, ''),
        file: f.path,
        folder: folder.name,
        level: levelOfField(doc.fields['DLEVEL'], doc.fields['DLVDEC']),
        feat,
        excluded: was?.excluded ?? false,
        include: was?.include,
        addedAt: Date.now(),
        ai: readOrigin(doc) !== null,
        work: byPath.has(`${base}.dtxe.json`),
        score,
      };
      added.push(e);
    } catch {
      // 読めない譜面は飛ばす
    }
    done++;
    if (done % 5 === 0) set({ scanning: { done, total: dtx.length, label: tr('譜面を解析しています…', 'Analyzing charts…') } });
  }
  await putCharts(added);
  const map = new Map(get().charts.map((c) => [c.id, c]));
  for (const e of added) map.set(e.id, e);
  set({ charts: [...map.values()], scanning: null });
  if (!opts.quiet) {
    const r = currentRuler();
    const skipped = added.filter((e) => r.skipped.some((x) => x.key === e.id)).length;
    toast(
      skipped
        ? tr(`${added.length} 譜面を読みました（${skipped} 譜面は物差しに入れません。わけは「入れていない譜面」に）`, `Read ${added.length} ${pl(added.length, 'chart')} (${skipped} left out of the ruler; see “Not counted”)`)
        : tr(`${added.length} 譜面を物差しに足しました`, `Added ${added.length} ${pl(added.length, 'chart')} to the ruler`),
      'ok',
      6000,
    );
  }
  return added.length;
}

export async function pickAndScan(fallbackInput?: HTMLInputElement | null) {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'dtx-guideline', mode: 'read' });
      set({ scanning: { done: 0, total: 0, label: tr('フォルダを読んでいます…', 'Reading the folder…') } });
      await scanCharts(await folderFromHandle(dir));
    } catch (e) {
      set({ scanning: null });
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast(tr(`読めませんでした: ${(e as Error).message}`, `Couldn't read it: ${(e as Error).message}`), 'error');
    }
    return;
  }
  fallbackInput?.click();
}

export async function scanFromFileList(list: FileList | null) {
  if (!list || list.length === 0) return;
  await scanCharts(folderFromFileList(list));
}

/** 曲フォルダの ZIP から集計する（フォルダを選べない iPad 用） */
export async function scanFromZip(file: File) {
  set({ scanning: { done: 0, total: 0, label: tr('ZIP を読んでいます…', 'Reading the ZIP…') } });
  try {
    await scanCharts(folderOf(await readZip(file), ''));
  } catch (e) {
    set({ scanning: null });
    toast(tr(`読めませんでした: ${(e as Error).message}`, `Couldn't read it: ${(e as Error).message}`), 'error');
  }
}

// ---- 基準文の編集 ---------------------------------------------------------------------------

function touchBand(b: number, fn: (band: GuideBand) => GuideBand) {
  const g = get().guide;
  void saveGuide({ ...g, updatedAt: Date.now(), bands: { ...g.bands, [b]: fn(g.bands[b] ?? { status: 'none', rows: [] }) } });
}

export function setRow(b: number, i: number, text: string) {
  touchBand(b, (band) => ({ ...band, status: band.status === 'confirmed' ? 'ai' : band.status, rows: band.rows.map((r, j) => (j === i ? { ...r, text, origin: r.origin === 'manual' ? 'manual' : 'edited' } : r)) }));
}

export function addRow(b: number) {
  touchBand(b, (band) => ({ ...band, status: band.status === 'none' ? 'ai' : band.status === 'confirmed' ? 'ai' : band.status, rows: [...band.rows, { text: '', basis: '', origin: 'manual' }] }));
}

export function removeRow(b: number, i: number) {
  touchBand(b, (band) => ({ ...band, rows: band.rows.filter((_, j) => j !== i) }));
}

export function confirmBand(b: number) {
  const g = get().guide;
  void saveGuide({ ...g, version: g.version + 1, updatedAt: Date.now(), bands: { ...g.bands, [b]: { ...g.bands[b], status: 'confirmed', rows: g.bands[b].rows.filter((r) => r.text.trim()) } } });
}

export function setBandRows(b: number, rows: GuideRow[]) {
  touchBand(b, () => ({ status: 'ai', rows }));
}

export function exportGuideline(): string {
  const s = get();
  return JSON.stringify({ app: 'DTX Web Editor', kind: 'guideline', version: 1, guide: s.guide, stats: bandStats(currentRuler().use).map((b) => ({ band: b.band, count: b.count, rates: b.rates })) }, null, 1);
}

export async function importGuideline(text: string): Promise<boolean> {
  try {
    const j = JSON.parse(text) as { kind?: string; guide?: Guideline };
    if (j.kind !== 'guideline' || !j.guide?.bands) return false;
    await saveGuide({ ...emptyGuideline(), ...j.guide, bands: { ...emptyGuideline().bands, ...j.guide.bands } });
    return true;
  } catch {
    return false;
  }
}

// AI へ渡す文なので日本語のまま i18n-ignore-start
/** 確定・下書き済みの基準文 */
export function guidelineText(g: Guideline = get().guide, bands: readonly number[] = BANDS): string {
  const lines: string[] = [];
  for (const b of bands) {
    const band = g.bands[b];
    if (!band || band.rows.length === 0) continue;
    lines.push(`Lv${b}台${band.status === 'confirmed' ? '' : '（下書き）'}:`);
    for (const r of band.rows) if (r.text.trim()) lines.push(`- ${r.text.trim()}`);
  }
  return lines.join('\n');
}

/**
 * AI のレベル判定・難易度生成に渡す難易度ガイドライン：基準文（あれば）と、手元の曲の集計（基準文が無くても数字は渡す）
 */
export function guideContext(bands: readonly number[]): string {
  const text = guidelineText(get().guide, bands);
  const stats = bandStats(currentRuler().use);
  const nums = bands.map((b) => (b >= 1 && b <= 9 ? bandLine(stats[b - 1]) : '')).filter(Boolean);
  const out: string[] = [];
  if (text) out.push(text);
  if (nums.length) out.push('手元の曲の集計（その要素が出てくる譜面の割合）:', ...nums.map((l) => `- ${l}`));
  return out.join('\n');
}
// i18n-ignore-end

// ---- AI の下書き ---------------------------------------------------------------------------

export async function draftWithAi(bands: number[]): Promise<boolean> {
  const s = get();
  const use = currentRuler().use;
  const stats = bandStats(use);
  const target = bands.filter((b) => stats[b - 1].count > 0);
  if (target.length === 0) {
    toast(tr('このレベル帯の譜面がまだありません', 'No charts in this level range yet'), 'warn', 6000);
    return false;
  }
  const reps: Record<number, ChartEntry[]> = {};
  for (const b of target) reps[b] = representatives(use, b, 2);
  const confirmed = guidelineText(
    s.guide,
    BANDS.filter((b) => s.guide.bands[b]?.status === 'confirmed' && !target.includes(b)),
  );
  const r = await runAi<{ bands?: { band?: number; rows?: { text?: string; basis?: string }[] }[] }>('guideline', {
    ...guidelinePrompt({ stats, reps, bands: target, confirmed }),
    schema: guideSchema(),
    maxTokens: 8000,
  });
  if (!r) return false;
  const g = get().guide;
  const next = { ...g, updatedAt: Date.now(), bands: { ...g.bands } };
  let n = 0;
  for (const band of r.data.bands ?? []) {
    const b = Math.trunc(Number(band.band));
    if (!target.includes(b)) continue;
    const rows = (band.rows ?? []).filter((x) => x.text?.trim()).map((x) => ({ text: String(x.text).trim(), basis: String(x.basis ?? '').trim(), origin: 'ai' as const }));
    if (rows.length === 0) continue;
    // 確定した帯は上書きしない（まとめて下書きでも）
    if (g.bands[b]?.status === 'confirmed' && bands.length > 1) continue;
    next.bands[b] = { status: 'ai', rows };
    n++;
  }
  await saveGuide(next);
  toast(
    n
      ? tr(
          `${n} 個のレベル帯の基準を下書きしました（$${r.costUsed.toFixed(3)}）。読んで直してから「確定」してください`,
          `Drafted guidelines for ${n} level ${pl(n, 'range')} ($${r.costUsed.toFixed(3)}). Read and edit them, then press “Confirm”`,
        )
      : tr('AIの答えに使える基準文がありませんでした', "The AI's answer had no usable guideline text"),
    n ? 'ok' : 'warn',
    7000,
  );
  return n > 0;
}
