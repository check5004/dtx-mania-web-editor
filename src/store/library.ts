// 音源ライブラリ：既存曲からの取り込み、楽器の自動判定、重複のまとめ、曲名キット、似た音、バックアップ。
import { tr, pl, isJa } from '../i18n';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { create } from 'zustand';
import { scanCharts } from './guideline';
import { BUILTIN_KITS, KIT_LANES, decodeBytes, loadBuiltin, peekBuiltin, registerVirtual, unregisterVirtual, builtinFile } from '../audio/sounds';
import { decodeDtx } from '../dtx/encoding';
import { SD_RIM } from '../dtx/model';
import { chipVoice, rimWavs } from '../dtx/rim';
import { parseDtx } from '../dtx/parse';
import { downloadBytes, folderFromFileList, folderFromHandle, normPath, type FolderFile, type SongFolder } from '../fs/folder';
import { folderOf, readZip } from '../fs/zip';
import * as db from '../library/db';
import type { Inst, LibraryKit, RefFolder, SampleMeta } from '../library/db';
import { classifyUsage, features, instOfChannel, miniPeaks, monoOf, similarity } from '../library/analyze';
import { toggleAudition, type AuditionSound } from './audition';
import { prepareSounds, toast, useEditor } from './editor';

export type LibSource = 'all' | 'builtin' | 'imported' | 'fav';

/** 一覧に出す音（標準キットの音も同じ形で並べる） */
export interface LibItem extends SampleMeta {
  builtin?: { kit: string; lane: string };
}

export interface LibraryState {
  loaded: boolean;
  samples: SampleMeta[];
  builtins: LibItem[];
  kits: LibraryKit[];
  folders: RefFolder[];
  tab: 'samples' | 'kits';
  inst: Inst | 'all';
  source: LibSource;
  song: string | null;
  tag: string | null;
  q: string;
  selected: string | null;
  importing: { label: string; done: number; total: number } | null;
  lastImport: { songs: string[]; added: number; merged: number; kits: string[] } | null;
  storage: { usage: number; quota: number; persisted: boolean } | null;
  /** 参照モードのフォルダで、読む許可がまだ無いもの */
  needPermission: string[];
}

export const useLibrary = create<LibraryState>(() => ({
  loaded: false,
  samples: [],
  builtins: [],
  kits: [],
  folders: [],
  tab: 'samples',
  inst: 'all',
  source: 'all',
  song: null,
  tag: null,
  q: '',
  selected: null,
  importing: null,
  lastImport: null,
  storage: null,
  needPermission: [],
}));

const lget = useLibrary.getState;
const lset = useLibrary.setState;

// 音色タグはサンプルに日本語のまま保存する（言語を切り替えても同じタグ）。表示だけ tagLabel で訳す i18n-ignore
export const TAG_PRESETS = ['ロック', 'メタル', 'ジャズ', 'エレクトロ', '明るい', 'ドライ', '太い', 'ルーム', 'ゲート'];
const TAG_EN: Record<string, string> = { ロック: 'Rock', メタル: 'Metal', ジャズ: 'Jazz', エレクトロ: 'Electro', 明るい: 'Bright', ドライ: 'Dry', 太い: 'Fat', ルーム: 'Room', ゲート: 'Gated' };
/** 音色タグの表示（自分で付けたタグはそのまま） */
export const tagLabel = (t: string): string => (isJa() ? t : (TAG_EN[t] ?? t));

// ---- 読み込み -------------------------------------------------------------------

let loading: Promise<void> | null = null;

export function loadLibrary(): Promise<void> {
  loading ??= (async () => {
    try {
      const [samples, kits, folders] = await Promise.all([db.allSamples(), db.allKits(), db.allFolders()]);
      for (const s of samples) registerSample(s);
      lset({ samples: samples.sort((a, b) => b.addedAt - a.addedAt), kits, folders, loaded: true });
      // 開いている譜面がライブラリの音を使っていれば、読み込み直す
      if (samples.length && useEditor.getState().screen === 'editor') void prepareSounds();
    } catch {
      lset({ loaded: true });
    }
    void refreshStorage();
  })();
  return loading;
}

async function refreshStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    lset({ storage: { usage: est?.usage ?? 0, quota: est?.quota ?? 0, persisted } });
  } catch {
    // 使えないブラウザ
  }
}

/** 消えないように永続化を頼む（ブラウザが断ることもある） */
export async function requestPersist(): Promise<boolean> {
  try {
    const ok = (await navigator.storage?.persist?.()) ?? false;
    await refreshStorage();
    return ok;
  } catch {
    return false;
  }
}

/** サンプルを、譜面から使える音として登録する（ファイル名で引ける） */
function registerSample(s: SampleMeta) {
  registerVirtual({
    file: s.file,
    origin: s.sources[0] ? `${s.sources[0].song}${s.sources[0].artist ? ` / ${s.sources[0].artist}` : ''}` : tr('ライブラリ', 'Library'),
    sampleId: s.id,
    load: () => sampleBuffer(s.id),
    bytes: async () => {
      const b = await sampleBytes(s.id);
      return b ? new Uint8Array(b) : null;
    },
  });
}

// ---- 音の取り出し -----------------------------------------------------------------

const bufCache = new Map<string, Promise<AudioBuffer | null>>();

export function sampleBuffer(id: string): Promise<AudioBuffer | null> {
  let p = bufCache.get(id);
  if (!p) {
    p = (async () => {
      const b = await sampleBytes(id);
      return b ? decodeBytes(b.slice(0)) : null;
    })();
    bufCache.set(id, p);
    void p.then((r) => {
      if (!r) bufCache.delete(id);
    });
  }
  return p;
}

/** 音声の中身（参照モードなら覚えたフォルダから読む） */
export async function sampleBytes(id: string): Promise<ArrayBuffer | null> {
  const own = await db.getAudio(id);
  if (own) return own;
  const s = lget().samples.find((x) => x.id === id) ?? (await db.getSample(id));
  if (!s?.ref) return null;
  const f = lget().folders.find((x) => x.id === s.ref!.folderId);
  if (!f) return null;
  try {
    const perm = f.handle.queryPermission ? await f.handle.queryPermission({ mode: 'read' }) : 'granted';
    if (perm !== 'granted') {
      if (!lget().needPermission.includes(f.id)) lset({ needPermission: [...lget().needPermission, f.id] });
      return null;
    }
    let dir = f.handle;
    const parts = s.ref.path.split('/').filter(Boolean);
    const name = parts.pop()!;
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
    return await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
  } catch {
    return null;
  }
}

/** 参照モードのフォルダを読む許可をもらう（ボタンを押したときに呼ぶ） */
export async function grantFolders() {
  const left: string[] = [];
  for (const id of lget().needPermission) {
    const f = lget().folders.find((x) => x.id === id);
    if (!f?.handle.requestPermission) continue;
    try {
      if ((await f.handle.requestPermission({ mode: 'read' })) !== 'granted') left.push(id);
    } catch {
      left.push(id);
    }
  }
  bufCache.clear();
  lset({ needPermission: left });
}

/** 試聴するときの音（store/audition の key は auditionKey） */
export async function auditionSound(item: LibItem): Promise<AuditionSound | null> {
  const buf = item.builtin ? await loadBuiltin(item.builtin.kit, item.builtin.lane) : await sampleBuffer(item.id);
  if (buf) return { buf, volume: 90 };
  toast(item.ref ? tr('参照モードの曲フォルダを読む許可が必要です（ライブラリの左下）', 'Permission to read the reference-mode song folder is needed (bottom left of the library)') : tr('音を読めませんでした', "Couldn't read the sound"), 'warn');
  return null;
}

export const auditionKey = (item: LibItem) => `lib:${item.id}`;

/** 試聴（鳴っていれば止める） */
export function auditionItem(item: LibItem) {
  return toggleAudition(auditionKey(item), () => auditionSound(item));
}

// ---- 標準キットの音を一覧に並べる ---------------------------------------------------------

let builtinsLoading: Promise<void> | null = null;

export function loadBuiltinItems(): Promise<void> {
  builtinsLoading ??= (async () => {
    const items: LibItem[] = [];
    for (const kit of BUILTIN_KITS) {
      if (kit.id === 'synth') continue;
      // キットごとに、レーンの音をまとめて読む（覚えずに読む。一覧には形と特徴だけ残す）
      const lanes = KIT_LANES.filter((l) => l.key !== 'lbd');
      const bufs = await Promise.all(lanes.map((l) => peekBuiltin(kit.id, l.key)));
      for (const [i, lane] of lanes.entries()) {
        const buf = bufs[i];
        if (!buf) continue;
        const mono = monoOf(buf);
        items.push({
          id: `builtin:${kit.id}/${lane.key}`,
          name: `${kit.name} ${lane.label}`,
          file: builtinFile(kit.id, lane.ch)!,
          size: 0,
          inst: instOfChannel(lane.ch) ?? 'other',
          instAuto: false,
          conf: 1,
          reason: tr(`標準キット（${kit.name}）の${lane.label}`, `${lane.label} of the built-in kit (${kit.name})`),
          sources: [{ song: tr(`標準キット（${kit.name}）`, `Built-in kit (${kit.name})`), artist: '', file: '', folder: '' }],
          tags: [],
          fav: false,
          dur: buf.duration,
          sr: buf.sampleRate,
          channels: buf.numberOfChannels,
          peaks: miniPeaks(mono, buf.sampleRate),
          feat: features(mono, buf.sampleRate),
          addedAt: 0,
          builtin: { kit: kit.id, lane: lane.key },
        });
      }
    }
    lset({ builtins: items });
  })();
  return builtinsLoading;
}

// ---- 絞り込み -------------------------------------------------------------------

export function allItems(s: LibraryState = lget()): LibItem[] {
  return [...s.samples, ...s.builtins];
}

export function filteredItems(s: LibraryState = lget()): LibItem[] {
  const q = s.q.trim().toLowerCase();
  return allItems(s).filter((it) => {
    if (s.inst !== 'all' && it.inst !== s.inst) return false;
    if (s.source === 'builtin' && !it.builtin) return false;
    if (s.source === 'imported' && it.builtin) return false;
    if (s.source === 'fav' && !it.fav) return false;
    if (s.song && !it.sources.some((x) => x.song === s.song)) return false;
    if (s.tag && !it.tags.includes(s.tag)) return false;
    if (q) {
      const hay = [it.name, it.file, ...it.tags, ...it.tags.map((t) => TAG_EN[t] ?? ''), ...it.sources.map((x) => `${x.song} ${x.artist}`)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function songsInLibrary(s: LibraryState = lget()): string[] {
  const set = new Set<string>();
  for (const it of s.samples) for (const src of it.sources) set.add(src.song);
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

/** この音に似た音 */
export function similarItems(id: string, n = 6): { item: LibItem; sim: number }[] {
  const all = allItems();
  const me = all.find((x) => x.id === id);
  if (!me) return [];
  return all
    .filter((x) => x.id !== id && x.feat.length === me.feat.length)
    .map((item) => ({ item, sim: similarity(me.feat, item.feat) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, n);
}

/** そのサンプルを使っているキットの数 */
export function kitCount(id: string): number {
  return lget().kits.filter((k) => Object.values(k.lanes).includes(id)).length;
}

// ---- 編集 -----------------------------------------------------------------------

async function updateSample(id: string, patch: Partial<SampleMeta>) {
  const s = lget().samples.find((x) => x.id === id);
  if (!s) return;
  const next = { ...s, ...patch };
  await db.putSample(next);
  lset({ samples: lget().samples.map((x) => (x.id === id ? next : x)) });
}

export const setInst = (id: string, inst: Inst) => updateSample(id, { inst, instAuto: false, reason: tr('手で直した', 'Set by hand') });
export const toggleFav = (id: string) => updateSample(id, { fav: !lget().samples.find((x) => x.id === id)?.fav });
export const setTags = (id: string, tags: string[]) => updateSample(id, { tags });

export async function removeSample(id: string) {
  const s = lget().samples.find((x) => x.id === id);
  if (!s) return;
  await db.deleteSample(id);
  unregisterVirtual(s.file);
  bufCache.delete(id);
  lset({ samples: lget().samples.filter((x) => x.id !== id), selected: null });
  void refreshStorage();
}

export async function saveUserKit(name: string, lanes: Record<number, string>) {
  const k: LibraryKit = { id: `user-${Date.now().toString(36)}`, name, origin: 'user', lanes, createdAt: Date.now() };
  await db.putKit(k);
  lset({ kits: [...lget().kits, k] });
  return k;
}

export async function removeKit(id: string) {
  await db.deleteKit(id);
  lset({ kits: lget().kits.filter((k) => k.id !== id) });
}

// ---- 取り込み -------------------------------------------------------------------

/** 長すぎる音（BGM など）は取り込まない */
const MAX_SAMPLE_SEC = 8;
const MAX_SAMPLE_BYTES = 6 * 1024 * 1024;

function uniqueFile(name: string, taken: Set<string>): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '_');
  const dot = clean.lastIndexOf('.');
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '.wav';
  let f = `lib_${base}${ext}`;
  for (let i = 2; taken.has(f.toLowerCase()); i++) f = `lib_${base}_${i}${ext}`;
  taken.add(f.toLowerCase());
  return f;
}

interface SongGroup {
  dir: string;
  dtx: FolderFile[];
}

function groupSongs(folder: SongFolder): SongGroup[] {
  const groups = new Map<string, SongGroup>();
  for (const f of folder.files.values()) {
    if (!/\.dtx$/i.test(f.name)) continue;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    let g = groups.get(dir);
    if (!g) groups.set(dir, (g = { dir, dtx: [] }));
    g.dtx.push(f);
  }
  return [...groups.values()];
}

/** 曲フォルダ（またはその親フォルダ）を選んで取り込む */
export async function pickAndImport(mode: 'copy' | 'ref', fallbackInput?: HTMLInputElement | null) {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'dtx-library', mode: 'read' });
      lset({ importing: { label: tr('フォルダを読んでいます…', 'Reading the folder…'), done: 0, total: 0 } });
      const folder = await folderFromHandle(dir);
      let refId: string | undefined;
      if (mode === 'ref') {
        refId = `ref-${Date.now().toString(36)}`;
        const rf: RefFolder = { id: refId, name: dir.name, handle: dir };
        await db.putFolder(rf);
        lset({ folders: [...lget().folders, rf] });
      }
      await importFolder(folder, refId);
    } catch (e) {
      lset({ importing: null });
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast(tr(`取り込めませんでした: ${(e as Error).message}`, `Couldn't import: ${(e as Error).message}`), 'error');
    }
    return;
  }
  if (mode === 'ref') toast(tr('参照モードは Chrome・Edge で使えます。このブラウザでは音声ごと取り込みます', 'Reference mode works in Chrome and Edge. In this browser the audio is copied'), 'info', 6000);
  fallbackInput?.click();
}

export async function importFromFileList(list: FileList | null) {
  if (!list || list.length === 0) return;
  await importFolder(folderFromFileList(list));
}

/** 曲フォルダの ZIP から取り込む（フォルダを選べない iPad 用。中に曲フォルダがいくつあってもよい） */
export async function importSongZip(file: File) {
  lset({ importing: { label: tr('ZIP を読んでいます…', 'Reading the ZIP…'), done: 0, total: 0 } });
  try {
    const z = await readZip(file);
    await importFolder(folderOf(z, ''));
  } catch (e) {
    lset({ importing: null });
    toast(tr(`ZIP を読めませんでした: ${(e as Error).message}`, `Couldn't read the ZIP: ${(e as Error).message}`), 'error', 7000);
  }
}

export async function importFolder(folder: SongFolder, refFolderId?: string) {
  const groups = groupSongs(folder);
  if (groups.length === 0) {
    lset({ importing: null });
    toast(tr('DTXファイルが見つかりませんでした（曲フォルダか、その親フォルダを選んでください）', 'No DTX files found (choose a song folder or its parent folder)'), 'warn', 6000);
    return;
  }
  const existing = new Map(lget().samples.map((s) => [s.id, s]));
  const taken = new Set(lget().samples.map((s) => s.file.toLowerCase()));
  const kits: LibraryKit[] = [];
  const songs: string[] = [];
  let added = 0;
  let merged = 0;
  let done = 0;
  lset({ importing: { label: tr('曲を読んでいます…', 'Reading songs…'), done: 0, total: groups.length } });
  for (const g of groups) {
    // 同じフォルダの難易度違いはまとめて1曲として数える
    let title = '';
    let artist = '';
    const usage = new Map<string, Map<number, number>>();
    const laneUse = new Map<number, Map<string, number>>();
    for (const f of g.dtx) {
      try {
        const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
        const { doc } = parseDtx(text);
        title ||= doc.fields['TITLE'] ?? '';
        artist ||= doc.fields['ARTIST'] ?? '';
        const pathWav = doc.fields['PATH_WAV'] ?? '';
        const keyOf = (p: string) => {
          const rel = normPath([g.dir, pathWav, p].filter(Boolean).join('/'));
          const fallback = normPath([g.dir, p].filter(Boolean).join('/'));
          return folder.files.has(rel) ? rel : fallback;
        };
        const count = (key: string, voice: number, n: number) => {
          let u = usage.get(key);
          if (!u) usage.set(key, (u = new Map()));
          u.set(voice, (u.get(voice) ?? 0) + n);
          let lu = laneUse.get(voice);
          if (!lu) laneUse.set(voice, (lu = new Map()));
          lu.set(key, (lu.get(key) ?? 0) + n);
        };
        // 音の番号ごとに数える（スネアのリムはスネアと別。キットのリムの音になる）
        const rims = rimWavs(doc);
        for (const c of doc.chips) {
          const voice = chipVoice(doc, c, rims);
          if (voice === null) continue;
          const p = doc.fields['WAV' + c.v.toString(36).toUpperCase().padStart(2, '0')];
          if (!p) continue;
          count(keyOf(p), voice, 1);
        }
        // 譜面で使っていなくても、リムの音（#WAV のラベル「Snare Rim」など）は取り込む（テンプレートに入っていることが多い）
        for (const no of rims) {
          const p = doc.fields['WAV' + no.toString(36).toUpperCase().padStart(2, '0')];
          if (p && !laneUse.get(SD_RIM)?.has(keyOf(p))) count(keyOf(p), SD_RIM, 0.5);
        }
      } catch {
        // 読めない DTX は飛ばす
      }
    }
    title ||= g.dir.split('/').pop() || folder.name;
    const idOfKey = new Map<string, string>();
    for (const [key, u] of usage) {
      const ff = folder.files.get(key);
      if (!ff || ff.size > MAX_SAMPLE_BYTES) continue;
      try {
        const bytes = await (await ff.getFile()).arrayBuffer();
        const id = await db.hashBytes(bytes);
        idOfKey.set(key, id);
        const src = { song: title, artist, file: ff.path, folder: folder.name };
        const old = existing.get(id);
        if (old) {
          if (!old.sources.some((x) => x.song === src.song && x.file === src.file)) {
            const next = { ...old, sources: [...old.sources, src] };
            if (old.instAuto) Object.assign(next, classifyUsage(u, ff.name));
            await db.putSample(next);
            existing.set(id, next);
          }
          merged++;
          continue;
        }
        const buf = await decodeBytes(bytes.slice(0));
        if (!buf || buf.duration > MAX_SAMPLE_SEC) continue;
        const mono = monoOf(buf);
        const cls = classifyUsage(u, ff.name);
        const meta: SampleMeta = {
          id,
          name: ff.name,
          file: uniqueFile(ff.name, taken),
          size: bytes.byteLength,
          inst: cls.inst,
          instAuto: true,
          conf: cls.conf,
          reason: cls.reason,
          sources: [src],
          tags: [],
          fav: false,
          dur: buf.duration,
          sr: buf.sampleRate,
          channels: buf.numberOfChannels,
          peaks: miniPeaks(mono, buf.sampleRate),
          feat: features(mono, buf.sampleRate),
          ref: refFolderId ? { folderId: refFolderId, path: ff.path } : undefined,
          addedAt: Date.now(),
        };
        if (!refFolderId) await db.putAudio(id, bytes);
        await db.putSample(meta);
        existing.set(id, meta);
        registerSample(meta);
        added++;
      } catch {
        // 読めない音は飛ばす
      }
    }
    // 曲名キット：チャンネルごとに一番多く使われた音
    const lanes: Record<number, string> = {};
    for (const [ch, m] of laneUse) {
      let best = '';
      let bn = 0;
      for (const [k, n] of m) if (n > bn && idOfKey.has(k)) (best = k), (bn = n);
      if (best) lanes[ch] = idOfKey.get(best)!;
    }
    if (Object.keys(lanes).length >= 3) {
      const kid = `song-${await db.hashBytes(strToU8(`${title}|${artist}`).buffer as ArrayBuffer)}`;
      const kit: LibraryKit = { id: kid, name: title, origin: 'song', song: title, artist, lanes, createdAt: Date.now() };
      await db.putKit(kit);
      kits.push(kit);
    }
    songs.push(title);
    lset({ importing: { label: tr(`${title} を取り込みました`, `Imported ${title}`), done: ++done, total: groups.length } });
  }
  // 難易度ガイドラインの集計にも加える（音は使わず譜面だけ）
  void scanCharts(folder, { quiet: true }).catch(() => undefined);
  const allKits = [...lget().kits.filter((k) => !kits.some((n) => n.id === k.id)), ...kits];
  lset({
    samples: [...existing.values()].sort((a, b) => b.addedAt - a.addedAt),
    kits: allKits,
    importing: null,
    lastImport: { songs, added, merged, kits: kits.map((k) => k.name) },
    source: 'imported',
  });
  void refreshStorage();
}

// ---- バックアップ ---------------------------------------------------------------

export async function exportZip() {
  const s = lget();
  const files: Record<string, Uint8Array> = {};
  files['library.json'] = strToU8(JSON.stringify({ app: 'DTX Web Editor', kind: 'library', version: 1, samples: s.samples, kits: s.kits }, null, 1));
  let n = 0;
  for (const smp of s.samples) {
    const b = await db.getAudio(smp.id);
    if (b) {
      files[`audio/${smp.id}`] = new Uint8Array(b);
      n++;
    }
  }
  const zip = zipSync(files, { level: 0 });
  downloadBytes(`dtx-library-${new Date().toISOString().slice(0, 10)}.zip`, zip, 'application/zip');
  toast(
    tr(
      `ライブラリを書き出しました（${s.samples.length} 音・音声 ${n} 個・キット ${s.kits.length}）`,
      `Exported the library (${s.samples.length} ${pl(s.samples.length, 'sound')}, ${n} audio ${pl(n, 'file')}, ${s.kits.length} ${pl(s.kits.length, 'kit')})`,
    ),
    'ok',
  );
}

export async function importZip(file: File) {
  try {
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const j = JSON.parse(strFromU8(z['library.json'])) as { samples: SampleMeta[]; kits: LibraryKit[] };
    const have = new Set(lget().samples.map((x) => x.id));
    let added = 0;
    for (const smp of j.samples ?? []) {
      if (!smp?.id || have.has(smp.id)) continue;
      const a = z[`audio/${smp.id}`];
      if (a) await db.putAudio(smp.id, a.slice().buffer);
      await db.putSample(smp);
      added++;
    }
    for (const k of j.kits ?? []) if (k?.id) await db.putKit(k);
    loading = null;
    await loadLibrary();
    toast(tr(`バックアップから ${added} 音を戻しました`, `Restored ${added} ${pl(added, 'sound')} from the backup`), 'ok');
  } catch (e) {
    toast(tr(`バックアップを読めませんでした: ${(e as Error).message}`, `Couldn't read the backup: ${(e as Error).message}`), 'error');
  }
}
