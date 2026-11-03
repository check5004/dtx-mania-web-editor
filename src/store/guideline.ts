// 難易度ガイドライン：手元の曲の譜面を解析してレベル帯ごとに集計し、基準文（AI の下書き → 作者が確定）を持つ。
// 集計した譜面と基準文はブラウザ内（IndexedDB）に保存する。基準文は JSON で書き出し・読み込みできる。
import { create } from 'zustand';
import { decodeDtx } from '../dtx/encoding';
import { parseDtx } from '../dtx/parse';
import { buildTempoMap } from '../dtx/timing';
import { LEVEL_VERSION, migrateLevel } from '../check/level';
import { defaultLabel, folderFromFileList, folderFromHandle, parseSetDef, type SongFolder } from '../fs/folder';
import { chartFeatures, FEATURE_DEFS, featureDistance, featureSummary, type ChartFeatures, type FeatureKey } from '../gen/features';
import { toast } from './editor';
import { runAi } from './ai';
import { GUIDE_SCHEMA, guidelinePrompt } from '../ai/judge';

export interface ChartEntry {
  /** 曲フォルダ＋ファイル名 */
  id: string;
  song: string;
  artist: string;
  /** 難易度の名前（set.def のラベル、なければファイル名） */
  label: string;
  file: string;
  folder: string;
  /** #DLEVEL（1.00〜9.99）。書いていなければ null */
  level: number | null;
  feat: ChartFeatures;
  /** 基準から外した */
  excluded: boolean;
  addedAt: number;
}

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

export const BANDS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const emptyGuideline = (): Guideline => ({ version: 0, updatedAt: 0, bands: Object.fromEntries(BANDS.map((b) => [b, { status: 'none', rows: [] }])) });

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

// ---- 状態 -----------------------------------------------------------------------------

export interface GuidelineState {
  loaded: boolean;
  charts: ChartEntry[];
  guide: Guideline;
  band: number;
  scanning: { done: number; total: number; label: string } | null;
}

export const useGuideline = create<GuidelineState>(() => ({ loaded: false, charts: [], guide: emptyGuideline(), band: 5, scanning: null }));
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
      set({ loaded: true, charts, guide: { ...emptyGuideline(), ...guide, bands: { ...emptyGuideline().bands, ...guide.bands } } });
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
    toast('ガイドラインを保存できませんでした（ブラウザの保存領域）', 'error');
  }
}

export function levelOfField(raw: string | undefined): number | null {
  if (!raw) return null;
  // NX: 3桁は 1/100、2桁以下は 1/10（825 → 8.25、82 → 8.20）
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const lv = n >= 100 ? n / 100 : n / 10;
  return lv > 0 ? Math.min(9.99, lv) : null;
}

export const bandOf = (lv: number) => Math.max(1, Math.min(9, Math.floor(lv)));

// ---- 取り込み ---------------------------------------------------------------------------

/** 曲フォルダ（またはその親）の譜面を解析して集計に加える */
export async function scanCharts(folder: SongFolder, opts: { quiet?: boolean } = {}): Promise<number> {
  await loadGuideline();
  const dtx = [...folder.files.values()].filter((f) => /\.dtx$/i.test(f.name));
  if (dtx.length === 0) {
    if (!opts.quiet) toast('DTXファイルが見つかりませんでした', 'warn');
    return 0;
  }
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
  set({ scanning: { done: 0, total: dtx.length, label: '譜面を解析しています…' } });
  for (const f of dtx) {
    try {
      const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
      const { doc } = parseDtx(text);
      const feat = chartFeatures(doc, buildTempoMap(doc));
      if (feat.notes < 16) continue;
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const id = `${folder.name}/${f.path}`.toLowerCase();
      const e: ChartEntry = {
        id,
        song: doc.fields['TITLE'] || dir.split('/').pop() || f.name,
        artist: doc.fields['ARTIST'] ?? '',
        label: labels.get(f.path.toLowerCase()) ?? f.name.replace(/\.dtx$/i, ''),
        file: f.path,
        folder: folder.name,
        level: levelOfField(doc.fields['DLEVEL']),
        feat,
        excluded: prev.get(id)?.excluded ?? false,
        addedAt: Date.now(),
      };
      added.push(e);
    } catch {
      // 読めない譜面は飛ばす
    }
    done++;
    if (done % 5 === 0) set({ scanning: { done, total: dtx.length, label: '譜面を解析しています…' } });
  }
  try {
    const store = await os('charts', 'readwrite');
    for (const e of added) store.put(e);
  } catch {
    // 保存できなくても今回の集計には使う
  }
  const map = new Map(get().charts.map((c) => [c.id, c]));
  for (const e of added) map.set(e.id, e);
  set({ charts: [...map.values()], scanning: null });
  if (!opts.quiet) toast(`${added.length} 譜面を集計しました（全 ${map.size} 譜面）`, 'ok');
  return added.length;
}

export async function pickAndScan(fallbackInput?: HTMLInputElement | null) {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'dtx-guideline', mode: 'read' });
      set({ scanning: { done: 0, total: 0, label: 'フォルダを読んでいます…' } });
      await scanCharts(await folderFromHandle(dir));
    } catch (e) {
      set({ scanning: null });
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast(`読めませんでした: ${(e as Error).message}`, 'error');
    }
    return;
  }
  fallbackInput?.click();
}

export async function scanFromFileList(list: FileList | null) {
  if (!list || list.length === 0) return;
  await scanCharts(folderFromFileList(list));
}

export async function setExcluded(id: string, excluded: boolean) {
  const charts = get().charts.map((c) => (c.id === id ? { ...c, excluded } : c));
  set({ charts });
  const c = charts.find((x) => x.id === id);
  if (c) {
    try {
      await wrap((await os('charts', 'readwrite')).put(c));
    } catch {
      // 覚えられなくても表示は変わる
    }
  }
}

export async function clearCharts() {
  set({ charts: [] });
  try {
    await wrap((await os('charts', 'readwrite')).clear());
  } catch {
    // 無視
  }
}

// ---- 集計 -------------------------------------------------------------------------------

export interface BandStats {
  band: number;
  count: number;
  rates: Record<FeatureKey, number>;
  density: number;
  maxChord: number;
  bpm: number;
  notes: number;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function usableCharts(charts: ChartEntry[]): ChartEntry[] {
  return charts.filter((c) => !c.excluded && c.level !== null);
}

export function bandStats(charts: ChartEntry[]): BandStats[] {
  const use = usableCharts(charts);
  return BANDS.map((b) => {
    const cs = use.filter((c) => bandOf(c.level!) === b);
    const rates = Object.fromEntries(FEATURE_DEFS.map((d) => [d.key, cs.length ? cs.filter((c) => c.feat.has[d.key]).length / cs.length : 0])) as Record<FeatureKey, number>;
    return {
      band: b,
      count: cs.length,
      rates,
      density: median(cs.map((c) => c.feat.density)),
      maxChord: median(cs.map((c) => c.feat.maxChord)),
      bpm: median(cs.map((c) => c.feat.bpm)),
      notes: median(cs.map((c) => c.feat.notes)),
    };
  });
}

/** 特徴の近い、レベルの分かっている譜面（自分の曲は除く） */
export function nearestCharts(feat: ChartFeatures, charts: ChartEntry[], n = 5, exceptSong?: string): { c: ChartEntry; d: number }[] {
  return usableCharts(charts)
    .filter((c) => !exceptSong || c.song !== exceptSong)
    .map((c) => ({ c, d: featureDistance(feat, c.feat) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
}

/** 近い譜面のレベルから見積もる（距離で重み付け） */
export function predictLevel(feat: ChartFeatures, charts: ChartEntry[], exceptSong?: string): number | null {
  const near = nearestCharts(feat, charts, 5, exceptSong);
  if (near.length < 3) return null;
  let w = 0;
  let s = 0;
  for (const { c, d } of near) {
    const k = 1 / (0.05 + d);
    w += k;
    s += k * c.level!;
  }
  return Math.round((s / w) * 100) / 100;
}

export interface Outlier {
  c: ChartEntry;
  predicted: number;
}

/** 登録されたレベルが基準（近い譜面）から大きく外れている譜面 */
export function findOutliers(charts: ChartEntry[], threshold = 1.2): Outlier[] {
  const out: Outlier[] = [];
  for (const c of charts) {
    if (c.level === null) continue;
    const p = predictLevel(c.feat, charts, c.song);
    if (p === null) continue;
    if (Math.abs(p - c.level) >= threshold) out.push({ c, predicted: p });
  }
  return out.sort((a, b) => Math.abs(b.predicted - b.c.level!) - Math.abs(a.predicted - a.c.level!));
}

/** レベル帯の代表：特徴の中央に近い譜面 */
export function representatives(charts: ChartEntry[], band: number, n = 3): ChartEntry[] {
  const cs = usableCharts(charts).filter((c) => bandOf(c.level!) === band);
  if (cs.length <= n) return cs.sort((a, b) => a.level! - b.level!);
  const med = { density: median(cs.map((c) => c.feat.density)), mech: median(cs.map((c) => c.feat.mech)) };
  return cs
    .map((c) => ({ c, d: Math.abs(Math.log(1 + c.feat.density) - Math.log(1 + med.density)) + Math.abs(c.feat.mech - med.mech) / 3 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.c)
    .sort((a, b) => a.level! - b.level!);
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
  return JSON.stringify({ app: 'DTX Web Editor', kind: 'guideline', version: 1, guide: s.guide, stats: bandStats(s.charts).map((b) => ({ band: b.band, count: b.count, rates: b.rates })) }, null, 1);
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

/** AI やレベル判定に渡す、確定・下書き済みの基準文 */
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

export function chartLine(c: ChartEntry): string {
  return `${c.song} ${c.label}（登録 Lv${c.level?.toFixed(2) ?? '?'}）: ${featureSummary(c.feat)}`;
}

// ---- AI の下書き ---------------------------------------------------------------------------

export async function draftWithAi(bands: number[]): Promise<boolean> {
  const s = get();
  const stats = bandStats(s.charts);
  const target = bands.filter((b) => stats[b - 1].count > 0);
  if (target.length === 0) {
    toast('このレベル帯の譜面がまだありません。「曲を取り込んで再集計」で手元の曲を読み込んでください', 'warn', 6000);
    return false;
  }
  const reps: Record<number, ChartEntry[]> = {};
  for (const b of target) reps[b] = representatives(s.charts, b, 2);
  const confirmed = guidelineText(
    s.guide,
    BANDS.filter((b) => s.guide.bands[b]?.status === 'confirmed' && !target.includes(b)),
  );
  const r = await runAi<{ bands?: { band?: number; rows?: { text?: string; basis?: string }[] }[] }>('guideline', {
    ...guidelinePrompt({ stats, reps, bands: target, confirmed }),
    schema: GUIDE_SCHEMA,
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
    next.bands[b] = { status: 'ai', rows };
    n++;
  }
  await saveGuide(next);
  toast(n ? `${n} 個のレベル帯の基準を下書きしました（$${r.costUsed.toFixed(3)}）。読んで直してから「確定」してください` : 'AIの答えに使える基準文がありませんでした', n ? 'ok' : 'warn', 7000);
  return n > 0;
}
