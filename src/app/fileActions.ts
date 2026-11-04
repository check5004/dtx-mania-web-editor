// ファイルを開く・保存する流れ。
import { tr, pl, isJa } from '../i18n';
import { zipSync } from 'fflate';
import { readAudioTags } from '../fs/tags';
import { virtualSound } from '../audio/sounds';
import { detectStemKind } from '../audio/stems';
import { importStems } from '../store/stems';
import { decodeDtx, encodeDtx } from '../dtx/encoding';
import type { DtxDoc } from '../dtx/model';
import { hasOriginLine, originOf, type ChartOrigin } from '../dtx/origin';
import { parseDtx } from '../dtx/parse';
import { serializeDtx } from '../dtx/serialize';
import {
  audioFiles,
  downloadBytes,
  dtxFiles,
  ensureWritable,
  findFile,
  folderFromFileList,
  folderFromFiles,
  folderFromHandle,
  parseSetDef,
  pendingFiles,
  pickFolder,
  putFile,
  supportsDirectWrite,
  writeFile,
  type FolderFile,
  type SongFolder,
} from '../fs/folder';
import { listRecent, putRecent, trimRecent, type RecentEntry } from '../fs/recent';
import { createDoc, edit, isDirty, openDocument, prepareSounds, switchDocument, toast, useEditor, withSongEnd, type DocMeta } from '../store/editor';
import { bgmSource } from '../store/derived';
import { freeWavNumber, setField } from '../edit/ops';
import { toBase36x2 } from '../dtx/base36';
import { CH } from '../dtx/model';
import { frac } from '../dtx/fraction';
import { loadSidecar, markSidecarSaved, parseSidecar, serializeSidecar, sidecarData, sidecarIsEmpty, sidecarName, useSidecar, type SidecarData } from '../store/sidecar';
import { chooseDialog, confirmDialog, newSongDialog, promptDialog } from '../ui/dialogs';

const get = useEditor.getState;

async function confirmDiscard(): Promise<boolean> {
  const s = get();
  if (s.screen !== 'editor' || !isDirty(s)) return true;
  return confirmDialog({
    title: tr('保存していない変更があります', 'You have unsaved changes'),
    body: tr(
      '開き直すと、いまの変更は「最近の曲」の自動保存にだけ残ります。続けますか？',
      'If you open something else, your current changes are kept only in the "Recent songs" autosave. Continue?',
    ),
    ok: tr('続ける', 'Continue'),
  });
}

async function readSetDefLabels(folder: SongFolder): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const f = findFile(folder, 'set.def');
  if (!f) return labels;
  try {
    const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
    for (const e of parseSetDef(text)) for (const l of e.levels) labels.set(l.file.toLowerCase(), l.label);
  } catch {
    // 読めない set.def は無視
  }
  return labels;
}

function siblingsOf(folder: SongFolder, labels: Map<string, string>) {
  return dtxFiles(folder).map((f) => ({ file: f.name, label: labels.get(f.name.toLowerCase()) ?? f.name.replace(/\.dtx$/i, '') }));
}

/**
 * 難易度タブの印（AI難易度生成で作った譜面か）を、曲フォルダの譜面から読む。開いたあと・保存したあとに裏で。
 * 印の行（#DTXE_ORIGIN）がある譜面だけを読み解き、手直しの有無も見る
 */
async function scanSiblingOrigins(folder: SongFolder) {
  const origins = new Map<string, ChartOrigin>();
  for (const sb of get().meta.siblings) {
    const f = findFile(folder, sb.file);
    if (!f) continue;
    try {
      const { text } = decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer()));
      origins.set(sb.file.toLowerCase(), hasOriginLine(text) ? originOf(parseDtx(text).doc) : 'human');
    } catch {
      // 読めない譜面には印を付けない
    }
  }
  if (get().folder !== folder || origins.size === 0) return;
  useEditor.setState((st) => ({ meta: { ...st.meta, siblings: st.meta.siblings.map((x) => ({ ...x, origin: origins.get(x.file.toLowerCase()) ?? x.origin })) } }));
}

/** 作業ファイル（.dtxe.json）の中身。フォルダに無ければ自動保存の控えを使う */
async function readSidecarFor(folder: SongFolder | null, fileName: string, recentSidecar?: string): Promise<SidecarData | null> {
  const f = folder ? findFile(folder, sidecarName(fileName)) : undefined;
  let data = null;
  if (f) {
    try {
      data = parseSidecar(await (await f.getFile()).text());
    } catch {
      data = null;
    }
  }
  if (!data && recentSidecar) data = parseSidecar(recentSidecar);
  return data;
}

/** 作業ファイル（.dtxe.json）を読む。フォルダに無ければ自動保存の控えを使う */
async function loadSidecarFor(folder: SongFolder | null, fileName: string, recentSidecar?: string) {
  loadSidecar(await readSidecarFor(folder, fileName, recentSidecar));
}

/**
 * DTX を開く。switching を渡すと同じ曲の別の難易度への切り替え：再生を止めず、▶・表示の位置・ループ・聴く設定はそのまま。
 * switching.stale() が true になったら（もっと新しい切り替えが始まった）途中でやめる
 */
async function openDtxFile(
  folder: SongFolder,
  file: FolderFile,
  labels?: Map<string, string>,
  recentText?: string,
  recentSidecar?: string,
  switching?: { stale: () => boolean },
) {
  const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
  const decoded = decodeDtx(bytes);
  let parsed = parseDtx(decoded.text);
  const useRecent = recentText !== undefined && recentText !== serializeDtx(parsed.doc);
  if (useRecent) parsed = parseDtx(recentText);
  labels ??= await readSetDefLabels(folder);
  const meta: DocMeta = {
    fileName: file.name,
    encoding: decoded.encoding,
    encodingNote: decoded.note,
    warnings: parsed.warnings,
    hasRandom: parsed.hasRandom,
    siblings: siblingsOf(folder, labels),
    recentId: recentIdFor(folder, file.name),
  };
  const dirty = useRecent || decoded.encoding === 'utf-8';
  if (switching) {
    if (switching.stale()) return;
    const side = await readSidecarFor(folder, file.name, recentSidecar);
    // 難易度タブの印（AI で作った譜面か）は読み直すまで今のものを出しておく（ちらつかせない）
    const known = new Map(get().meta.siblings.map((x) => [x.file.toLowerCase(), x.origin]));
    meta.siblings = meta.siblings.map((x) => ({ ...x, origin: known.get(x.file.toLowerCase()) ?? x.origin }));
    if (switching.stale() || !(await switchDocument(parsed.doc, meta, side, { dirty, stale: switching.stale }))) return;
    void scanSiblingOrigins(folder);
  } else {
    openDocument(parsed.doc, meta, folder, { dirty });
    void scanSiblingOrigins(folder);
    await loadSidecarFor(folder, file.name, recentSidecar);
  }
  if (useRecent) toast(tr('前回の自動保存から続きを開きました（まだ曲フォルダには保存されていません）', "Opened from your last autosave (not saved to the song folder yet)"), 'warn', 6000);
}

function recentIdFor(folder: SongFolder | null, fileName: string) {
  return `${folder?.name ?? 'new'}/${fileName}`.toLowerCase();
}

/** 曲フォルダを開いた後：DTX を選ぶ、無ければ新規作成 */
export async function openFolder(folder: SongFolder) {
  const list = dtxFiles(folder);
  const labels = await readSetDefLabels(folder);
  if (list.length === 0) {
    const info = await newSongDialog({
      title: tr(`「${folder.name}」に新しい譜面を作る`, `Create a new chart in "${folder.name}"`),
      audioFiles: audioFiles(folder).map((f) => f.path),
      defaults: { title: folder.name },
    });
    if (!info) return;
    const doc = createDoc(info);
    const meta = newMeta('mstr.dtx', folder);
    openDocument(doc, meta, folder, { dirty: true });
    return;
  }
  let file = list[0];
  if (list.length > 1) {
    const picked = await chooseDialog({
      title: tr('どの難易度を開きますか？', 'Which difficulty do you want to open?'),
      body: tr(`${folder.name} には譜面が ${list.length} 個あります。`, `${folder.name} has ${list.length} charts.`),
      options: list.map((f) => ({
        label: labels.get(f.name.toLowerCase()) ?? f.name,
        sub: `${f.name} · ${(f.size / 1024).toFixed(1)} KB`,
        value: f,
      })),
    });
    if (!picked) return;
    file = picked;
  }
  await openDtxFile(folder, file, labels);
}

function newMeta(fileName: string, folder: SongFolder | null): DocMeta {
  return {
    fileName,
    encoding: 'shift_jis',
    warnings: [],
    hasRandom: false,
    siblings: folder ? siblingsOf(folder, new Map()) : [],
    recentId: `${recentIdFor(folder, fileName)}#${Date.now()}`,
  };
}

/** フォルダ選択ダイアログ（Chrome/Edge）。無ければ webkitdirectory の input を使う */
export async function openFolderPicker(fallbackInput?: HTMLInputElement | null) {
  if (!(await confirmDiscard())) return;
  if (supportsDirectWrite()) {
    try {
      const folder = await pickFolder();
      if (folder) await openFolder(folder);
    } catch (e) {
      toast(tr(`フォルダを開けませんでした: ${(e as Error).message}`, `Couldn't open the folder: ${(e as Error).message}`), 'error');
    }
    return;
  }
  fallbackInput?.click();
}

/** <input webkitdirectory> から */
export async function openFolderFromInput(list: FileList | null) {
  if (!list || list.length === 0) return;
  await openFolder(folderFromFileList(list));
}

let switchSeq = 0;

/**
 * 難易度タブの切り替え（同じフォルダの別の DTX）。再生中でも止めずに、今の位置から新しい譜面を鳴らす。
 * ▶・表示の位置・ループ・聴く設定（ミックス）はそのまま
 */
export async function switchDifficulty(fileName: string) {
  const s = get();
  const folder = s.folder;
  if (!folder) return;
  if (fileName === s.meta.fileName) {
    // 今の難易度をもう一度押したら、読み込み中の切り替えはやめる（気が変わって戻したとき）
    switchSeq++;
    return;
  }
  if (!(await confirmDiscard())) return;
  const f = findFile(folder, fileName);
  if (!f) return;
  const seq = ++switchSeq;
  // 保存していない変更は、いまの内容を「最近の曲」の自動保存に残してから切り替える（確認で伝えたとおりに）
  if (isDirty(get())) await autosaveNow();
  await openDtxFile(folder, f, undefined, undefined, undefined, { stale: () => seq !== switchSeq || get().folder !== folder });
}

/** 落としたファイル（DTX・音声）から開く */
export async function openDroppedFiles(files: File[]) {
  if (files.length === 0) return;
  if (!(await confirmDiscard())) return;
  const dtx = files.find((f) => /\.dtx$/i.test(f.name));
  const folder = folderFromFiles(files, dtx ? dtx.name.replace(/\.dtx$/i, '') : files[0].name.replace(/\.[^.]+$/, ''));
  if (dtx) {
    await openDtxFile(folder, folder.files.get(dtx.name.toLowerCase())!);
    if (files.length === 1) toast(tr('DTXだけを開きました。音を鳴らすには曲フォルダごと開いてください', 'Opened only the DTX file. Open the whole song folder to hear the sounds'), 'info', 6000);
    return;
  }
  const audio = files.filter((f) => /\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(f.name));
  if (audio.length === 0) {
    toast(tr('DTXか音声ファイル（WAV・OGG・MP3）を選んでください', 'Choose a DTX or an audio file (WAV, OGG, MP3)'), 'warn');
    return;
  }
  // ステム分離ソフトで分けたファイル（drums・bass…）をまとめて落としたら、ステムとして読み込む
  const kinds = new Set(audio.map((f) => detectStemKind(f.name)));
  if (audio.length >= 2 && kinds.size >= 2) {
    const asStems = await chooseDialog({
      title: tr(`音声ファイルが ${audio.length} 個あります`, `${audio.length} audio files`),
      body: tr(
        'ステム（楽器ごとに分けた音）として読み込むと、楽器ごとに鳴らし分け、ドラム抜きのBGMを書き出せます。',
        'Loading them as stems (one file per instrument) lets you play instruments separately and export a no-drums BGM.',
      ),
      options: [
        { label: tr('ステムとして読み込む（おすすめ）', 'Load as stems (recommended)'), sub: audio.map((f) => f.name).join(tr('、', ', ')), value: true },
        { label: tr('1つを原曲にする', 'Use one as the original'), sub: tr('ほかのファイルは曲フォルダに置くだけにします', 'The other files are just put in the song folder'), value: false },
      ],
    });
    if (asStems === null || asStems === undefined) return;
    if (asStems) {
      const info = await newSongDialog({
        title: tr('新しい譜面をつくる（ステムから）', 'Create a new chart (from stems)'),
        audioFiles: [],
        defaults: { title: audio[0].name.replace(/\s*[([].*$/, '').replace(/\.[^.]+$/, '') },
      });
      if (!info) return;
      openDocument(createDoc(info), newMeta('mstr.dtx', null), folderFromFiles([], info.title || tr('新しい曲', 'New song')), { dirty: true });
      await importStems(audio);
      return;
    }
  }
  // 音声ファイルのタグ（曲名・アーティスト・BPM）があれば最初から入れておく
  const tags = await readAudioTags(audio[0]);
  const info = await newSongDialog({
    title: tr('新しい譜面をつくる', 'Create a new chart'),
    audioFiles: audio.map((f) => f.name),
    defaults: {
      title: tags?.title || audio[0].name.replace(/\.[^.]+$/, ''),
      artist: tags?.artist || tags?.albumArtist || undefined,
      bpm: tags?.bpm ? Math.round(tags.bpm * 100) / 100 : undefined,
      bgmFile: audio[0].name,
    },
  });
  if (!info) return;
  openDocument(createDoc(info), newMeta('mstr.dtx', null), folder, { dirty: true });
}

/** 原曲の音声ファイルを選ぶダイアログ（読み込むと原曲にする） */
export function pickBgmFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.ogg,.wav,.mp3,.m4a,.flac,.opus';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void importBgmFile(f);
  };
  input.click();
}

/** 同じ名前の別のファイルがあれば、名前の後ろに番号を付ける */
function freePath(folder: SongFolder, name: string): string {
  if (!findFile(folder, name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 100; i++) {
    const p = `${base} (${i})${ext}`;
    if (!findFile(folder, p)) return p;
  }
  return `${base}_${Date.now()}${ext}`;
}

/**
 * 今の譜面に原曲（BGM）を読み込む。曲フォルダにコピーして #WAV に登録し、
 * BGMチップ（ch01）が無ければ 001 小節の頭に置く。あれば、その音を差し替える。
 */
export async function importBgmFile(file: File) {
  if (!/\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(file.name)) {
    toast(tr('原曲は音声ファイル（WAV・OGG・MP3）を選んでください', 'For the original, choose an audio file (WAV, OGG, MP3)'), 'warn');
    return;
  }
  const s = get();
  let folder = s.folder;
  if (!folder) {
    folder = folderFromFiles([], s.doc.fields['TITLE'] || tr('新しい曲', 'New song'));
    useEditor.setState({ folder });
  }
  const same = findFile(folder, file.name);
  let path = file.name;
  let memory = false;
  if (!(same && same.size === file.size)) {
    path = freePath(folder, file.name);
    memory = (await putFile(folder, path, file)) === 'memory';
  } else {
    path = same.path;
  }
  const bgm = bgmSource(get().doc);
  edit(bgm ? tr('原曲を差し替える', 'Replace the original') : tr('原曲を読み込む', 'Load the original'), (d) => {
    if (bgm) {
      setField(d, 'WAV' + toBase36x2(bgm.wav), path);
      return;
    }
    const no = freeWavNumber(d) ?? 1;
    setField(d, 'WAV' + toBase36x2(no), path);
    if (d.fields['BGMWAV'] === undefined) setField(d, 'BGMWAV', toBase36x2(no));
    d.chips.push({ id: d.nextId++, ch: CH.BGM, m: 1, f: frac(0), v: no });
  });
  await prepareSounds();
  toast(
    isJa()
      ? `原曲「${path}」を${bgm ? '差し替えました' : '読み込みました（001小節の頭から鳴らします。ずれていたら「テンポ合わせ」で合わせられます）'}${memory ? '。曲フォルダへは保存するときに書き出します' : ''}`
      : `${bgm ? 'Replaced' : 'Loaded'} the original "${path}"${bgm ? '' : ' (it plays from the start of measure 001; if it is off, line it up in "Tempo")'}${memory ? '. It is written to the song folder when you save' : ''}`,
    'ok',
    7000,
  );
}

/** 編集中に音声ファイルを落としたとき：原曲にするか、ステムにするか、新しい譜面にするかを選ぶ */
export async function dropAudioInEditor(files: File[]) {
  const audio = files.filter((f) => /\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(f.name));
  if (!audio.length) return openDroppedFiles(files);
  const choice = await chooseDialog({
    title: audio.length === 1 ? tr(`「${audio[0].name}」をどうしますか？`, `What do you want to do with "${audio[0].name}"?`) : tr(`音声ファイルが ${audio.length} 個あります`, `${audio.length} audio files`),
    body: tr('いま編集中の譜面に使うか、新しい譜面を作るかを選んでください。', 'Use it in the chart you are editing, or create a new chart.'),
    options: [
      ...(audio.length === 1
        ? [
            {
              label: bgmSource(get().doc) ? tr('原曲を差し替える', 'Replace the original') : tr('原曲にする（おすすめ）', 'Use as the original (recommended)'),
              sub: tr(
                '曲フォルダにコピーしてBGM（#WAV・ch01）に登録します。波形と原曲の打点はこの音から作ります',
                'Copies it into the song folder and sets it as the BGM (#WAV, ch01). The waveform and detected hits come from it',
              ),
              value: 'bgm' as const,
            },
          ]
        : []),
      {
        label: tr('ステムとして読み込む', 'Load as stems'),
        sub: tr('楽器ごとに分けた音（ドラム・ベースなど）。DAWのように鳴らし分けられます', 'One file per instrument (drums, bass…). Play them separately, like in a DAW'),
        value: 'stems' as const,
      },
      { label: tr('新しい譜面を作る', 'Create a new chart'), sub: tr('いまの譜面を閉じて、この音から新しい譜面を作ります', 'Closes the current chart and starts a new one from this audio'), value: 'new' as const },
    ],
  });
  if (choice === 'bgm') await importBgmFile(audio[0]);
  else if (choice === 'stems') await importStems(audio);
  else if (choice === 'new') await openDroppedFiles(files);
}

export async function newEmptySong() {
  if (!(await confirmDiscard())) return;
  const info = await newSongDialog({ title: tr('新しい譜面をつくる', 'Create a new chart'), audioFiles: [], defaults: {} });
  if (!info) return;
  openDocument(createDoc(info), newMeta('mstr.dtx', null), null, { dirty: true });
}

// ---- 保存 ---------------------------------------------------------------------

/** 曲フォルダにまだ無い、エディタが用意した音（標準キット・ライブラリ）。出典も返す */
async function kitFilesNeeded(doc: DtxDoc, folder: SongFolder | null): Promise<{ path: string; bytes: Uint8Array; origin: string; library: boolean }[]> {
  const out: { path: string; bytes: Uint8Array; origin: string; library: boolean }[] = [];
  const pathWav = doc.fields['PATH_WAV'] ?? '';
  const names = new Set<string>();
  const used = new Set(doc.chips.map((c) => c.v));
  for (const [k, v] of Object.entries(doc.fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k)) continue;
    if (!used.has(parseInt(k.slice(3), 36))) continue;
    if (names.has(v.toLowerCase()) || findFile(folder, v, pathWav)) continue;
    const vs = virtualSound(v);
    if (!vs) continue;
    names.add(v.toLowerCase());
    const bytes = await vs.bytes();
    if (!bytes) continue;
    const name = v.replace(/\\/g, '/').split('/').pop()!;
    out.push({ path: pathWav ? `${pathWav.replace(/\\/g, '/').replace(/\/+$/, '')}/${name}` : name, bytes, origin: vs.origin, library: !!vs.sampleId });
  }
  return out;
}

/** 他の曲から取り込んだ音を使っているときは、出典を知らせる */
function creditNote(kit: { path: string; origin: string; library: boolean }[]): string {
  const lib = kit.filter((k) => k.library);
  if (!lib.length) return '';
  const songs = [...new Set(lib.map((k) => k.origin))];
  return isJa()
    ? `。他の曲から取り込んだ音を使っています（出典: ${songs.slice(0, 3).join('、')}${songs.length > 3 ? ' ほか' : ''}）。個人の曲づくりの範囲で使ってください`
    : `. It uses sounds taken from other songs (from: ${songs.slice(0, 3).join(', ')}${songs.length > 3 ? ' and more' : ''}). Keep it to personal charting`;
}

/** 保存する DTX。曲の終わりを決めていなければ、いま見えている終わり（原曲の鳴り終わり）を書き込む */
function encodeForSave(doc: DtxDoc) {
  return encodeDtx(serializeDtx(withSongEnd(doc)), 'shift_jis');
}

/** 作業ファイルの中身（空で、フォルダにも無ければ書かない） */
function sidecarBytes(folder: SongFolder | null, fileName: string): Uint8Array | null {
  const d = sidecarData();
  if (sidecarIsEmpty(d) && !(folder && findFile(folder, sidecarName(fileName)))) return null;
  return new TextEncoder().encode(serializeSidecar(d));
}

function markSaved(doc: DtxDoc, patch: Partial<ReturnType<typeof get>> = {}) {
  useEditor.setState((s) => ({ ...patch, savedDoc: doc, savedAt: Date.now(), meta: { ...s.meta, ...(patch.meta ?? {}), encoding: 'shift_jis', encodingNote: undefined } }));
  void autosaveNow(true);
}

export async function save(opts: { as?: boolean } = {}) {
  const s = get();
  if (s.screen !== 'editor') return;
  const doc = s.doc;
  const { bytes, lost } = encodeForSave(doc);
  if (lost.length > 0) {
    const ok = await confirmDialog({
      title: tr('Shift_JISで表せない文字があります', "Some characters can't be written in Shift_JIS"),
      body: tr(
        `${lost.join(' ')}\n\nNXは譜面をShift_JISで読むため、これらの文字は「?」になります。曲情報で別の文字に置き換えるのがおすすめです。このまま保存しますか？`,
        `${lost.join(' ')}\n\nNX reads charts as Shift_JIS, so these characters become "?". It is best to replace them in Song info. Save anyway?`,
      ),
      ok: tr('このまま保存', 'Save anyway'),
    });
    if (!ok) return;
  }
  let fileName = s.meta.fileName;
  if (opts.as) {
    const name = await promptDialog({ title: tr('名前を付けて保存', 'Save as'), body: tr('同じ曲フォルダに保存します。', 'Saves into the same song folder.'), value: fileName, ok: tr('保存', 'Save') });
    if (!name) return;
    fileName = /\.dtx$/i.test(name) ? name : `${name}.dtx`;
  }
  let folder = s.folder;
  const kit = await kitFilesNeeded(doc, folder);
  try {
    if (folder?.dir) {
      if (!(await ensureWritable(folder))) {
        toast(tr('フォルダへの書き込みが許可されませんでした', 'Writing to the folder was not allowed'), 'error');
        return;
      }
      if (findFile(folder, fileName) && fileName !== s.meta.fileName) {
        const ok = await confirmDialog({
          title: tr(`${fileName} を上書きしますか？`, `Overwrite ${fileName}?`),
          body: tr('同じ名前の譜面がフォルダにあります。', 'A chart with the same name is already in the folder.'),
          ok: tr('上書き', 'Overwrite'),
          danger: true,
        });
        if (!ok) return;
      }
      for (const k of kit) await writeFile(folder, k.path, k.bytes);
      // ステムや書き出した音で、まだフォルダに書けていなかったもの
      for (const f of pendingFiles(folder)) await writeFile(folder, f.path, new Uint8Array(await (await f.getFile()).arrayBuffer()));
      await writeFile(folder, fileName, bytes);
      const side = sidecarBytes(folder, fileName);
      if (side) await writeFile(folder, sidecarName(fileName), side);
      markSidecarSaved();
      markSaved(doc, { meta: { ...get().meta, fileName, recentId: recentIdFor(folder, fileName) } });
      const kitNote = kit.length ? tr(`（キットの音 ${kit.length} 個も保存）`, ` (also saved ${kit.length} kit ${pl(kit.length, 'sound')})`) : '';
      toast(`${tr('保存しました: ', 'Saved: ')}${folder.name}/${fileName}${kitNote}${creditNote(kit)}`, 'ok', kit.some((k) => k.library) ? 9000 : 4000);
      return;
    }
    if (supportsDirectWrite()) {
      // まだ保存先のフォルダが無い（新しい曲）。フォルダを選んでもらい、原曲もそこにコピーする
      const ok = await confirmDialog({
        title: tr('曲フォルダを選んで保存します', 'Choose a song folder to save to'),
        body: tr(
          'NXの曲フォルダ（DTXFiles の中など）に、この曲用の空のフォルダを作って選んでください。譜面・原曲・内蔵キットの音をまとめて保存します。',
          "Create an empty folder for this song in NX's song folder (inside DTXFiles, for example) and choose it. The chart, the original, and the built-in kit sounds are saved together.",
        ),
        ok: tr('フォルダを選ぶ', 'Choose folder'),
      });
      if (!ok) return;
      const dir = await window.showDirectoryPicker!({ id: 'dtx-song', mode: 'readwrite' });
      const target = await folderFromHandle(dir);
      if (findFile(target, fileName)) {
        const over = await confirmDialog({
          title: tr(`${fileName} を上書きしますか？`, `Overwrite ${fileName}?`),
          body: tr(`「${target.name}」に同じ名前の譜面があります。`, `"${target.name}" already has a chart with the same name.`),
          ok: tr('上書き', 'Overwrite'),
          danger: true,
        });
        if (!over) return;
      }
      if (folder) {
        for (const f of folder.files.values()) {
          if (findFile(target, f.path)) continue;
          await writeFile(target, f.path, new Uint8Array(await (await f.getFile()).arrayBuffer()));
        }
      }
      for (const k of kit) await writeFile(target, k.path, k.bytes);
      await writeFile(target, fileName, bytes);
      const side = sidecarBytes(null, fileName);
      if (side) await writeFile(target, sidecarName(fileName), side);
      markSidecarSaved();
      folder = target;
      const labels = await readSetDefLabels(folder);
      markSaved(doc, { folder, meta: { ...get().meta, fileName, siblings: siblingsOf(folder, labels), recentId: recentIdFor(folder, fileName) } });
      void scanSiblingOrigins(folder);
      toast(`${tr('保存しました: ', 'Saved: ')}${folder.name}/${fileName}${creditNote(kit)}`, 'ok', kit.some((k) => k.library) ? 9000 : 4000);
      return;
    }
    // フォルダに直接書けないブラウザ：ダウンロード
    const side = sidecarBytes(null, fileName);
    downloadSong(fileName, bytes, kit, folder, side);
    if (side && useSidecar.getState().dirty && pendingFiles(folder).length === 0 && kit.length === 0) downloadBytes(sidecarName(fileName), side, 'application/json');
    markSidecarSaved();
    markSaved(doc, { meta: { ...get().meta, fileName } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    toast(tr(`保存できませんでした: ${(e as Error).message}`, `Couldn't save: ${(e as Error).message}`), 'error', 8000);
  }
}

function downloadSong(fileName: string, bytes: Uint8Array, kit: { path: string; bytes: Uint8Array; origin: string; library: boolean }[], folder: SongFolder | null, side: Uint8Array | null = null) {
  const memoryOnly = folder && !folder.dir && !findFile(folder, fileName) ? [...folder.files.values()].filter((f) => !/\.dtx$/i.test(f.name)) : [];
  // ステムや書き出した音（メモリにだけあるもの）も一緒に入れる
  for (const f of pendingFiles(folder)) if (!memoryOnly.includes(f)) memoryOnly.push(f);
  if (kit.length === 0 && memoryOnly.length === 0) {
    downloadBytes(fileName, bytes);
    toast(tr(`${fileName} をダウンロードしました。曲フォルダの同じ名前のファイルと置き換えてください`, `Downloaded ${fileName}. Replace the file with the same name in the song folder`), 'ok', 7000);
    return;
  }
  void (async () => {
    const files: Record<string, Uint8Array> = {};
    for (const f of memoryOnly) files[f.path] = new Uint8Array(await (await f.getFile()).arrayBuffer());
    for (const k of kit) files[k.path] = k.bytes;
    files[fileName] = bytes;
    if (side) files[sidecarName(fileName)] = side;
    const zip = zipSync(files, { level: 0 });
    const name = `${(get().doc.fields['TITLE'] || 'song').replace(/[\\/:*?"<>|]/g, '_')}.zip`;
    downloadBytes(name, zip, 'application/zip');
    toast(tr(`${name} をダウンロードしました。展開したファイルを曲フォルダに入れてください`, `Downloaded ${name}. Unzip it and put the files in the song folder`) + creditNote(kit), 'ok', kit.some((k) => k.library) ? 10000 : 7000);
  })();
}

/** 譜面ファイルだけをダウンロード（どのブラウザでも使える控え） */
export function downloadDtx() {
  const s = get();
  const { bytes } = encodeForSave(s.doc);
  downloadBytes(s.meta.fileName, bytes);
}

// ---- 自動保存 -------------------------------------------------------------------

let autosaveTimer = 0;
let lastAutosaved: DtxDoc | null = null;

export async function autosaveNow(saved = false) {
  const s = get();
  if (s.screen !== 'editor') return;
  if (!saved && s.doc === lastAutosaved) return;
  lastAutosaved = s.doc;
  const f = s.doc.fields;
  const entry: RecentEntry = {
    id: s.meta.recentId ?? recentIdFor(s.folder, s.meta.fileName),
    title: f['TITLE'] ?? tr('無題', 'Untitled'),
    artist: f['ARTIST'] ?? '',
    bpm: f['BPM'] ?? '',
    level: f['DLEVEL'] ?? '',
    fileName: s.meta.fileName,
    folderName: s.folder?.name ?? '',
    dir: s.folder?.dir,
    text: serializeDtx(withSongEnd(s.doc)),
    sidecar: sidecarIsEmpty() ? undefined : serializeSidecar(sidecarData()),
    saved: !isDirty(s),
    updatedAt: Date.now(),
  };
  await putRecent(entry);
  await trimRecent();
}

export function startAutosave() {
  const later = () => {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => void autosaveNow(true), 1500);
  };
  const a = useEditor.subscribe((s, prev) => {
    if (s.doc === prev.doc || s.screen !== 'editor') return;
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => void autosaveNow(), 1500);
  });
  // セクションやアンカーだけを変えたときも控えを残す
  const b = useSidecar.subscribe((s, prev) => {
    if (s.dirty && s !== prev && useEditor.getState().screen === 'editor') later();
  });
  return () => {
    a();
    b();
  };
}

export { listRecent };

export async function openRecent(e: RecentEntry) {
  if (!(await confirmDiscard())) return;
  if (e.dir) {
    try {
      const perm = e.dir.requestPermission ? await e.dir.requestPermission({ mode: 'readwrite' }) : 'granted';
      if (perm === 'granted') {
        const folder = await folderFromHandle(e.dir);
        const f = findFile(folder, e.fileName);
        if (f) {
          await openDtxFile(folder, f, undefined, e.saved ? undefined : e.text, e.sidecar);
          return;
        }
        const parsed = parseDtx(e.text);
        openDocument(parsed.doc, { ...newMeta(e.fileName, folder), recentId: e.id, warnings: parsed.warnings, hasRandom: parsed.hasRandom }, folder, { dirty: true });
        await loadSidecarFor(folder, e.fileName, e.sidecar);
        return;
      }
    } catch {
      // フォルダが消えた・権限が無い → 本文だけ開く
    }
  }
  const parsed = parseDtx(e.text);
  openDocument(parsed.doc, { ...newMeta(e.fileName, null), recentId: e.id, warnings: parsed.warnings, hasRandom: parsed.hasRandom }, null, { dirty: !e.saved });
  await loadSidecarFor(null, e.fileName, e.sidecar);
  toast(tr('自動保存した譜面だけを開きました。音を鳴らすには曲フォルダを開いてください', 'Opened only the autosaved chart. Open the song folder to hear the sounds'), 'info', 6000);
}
