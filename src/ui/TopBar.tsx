import { tr, pl, getLang, setLang, LANG_NAMES } from '../i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { changeSongFolder, downloadDtx, exportSongZip, newEmptySong, openFolderPicker, pickBgmFile, save, switchDifficulty } from '../app/fileActions';
import { isDiskFolder, isLocalFolder, supportsDirectWrite } from '../fs/folder';
import { localPlace, useLocalSongs } from '../store/localSongs';
import { cleanDriveJunk, connectDrive, openFromDrive, pushNow } from '../app/driveActions';
import { openNxPage } from '../nxlib/actions';
import { useDriveAuth } from '../drive/auth';
import { GRID_DIVS, gridLabel } from '../edit/ops';
import { findFile } from '../fs/folder';
import {
  copySelection,
  cutSelection,
  deleteMeasures,
  insertMeasures,
  toast,
  deleteSelection,
  duplicatePrevMeasure,
  goHome,
  openPage,
  openSettings,
  openTempo,
  paste,
  playFrom,
  redo,
  resetSongEnd,
  selectAll,
  setMix,
  setView,
  songEndAtCursor,
  songEndAtLastChip,
  stop,
  togglePause,
  undo,
  useEditor,
  zoom,
} from '../store/editor';
import { unsavedText, useUnsaved } from '../store/unsaved';
import { glowsDiff, useGlowDiffs } from '../store/glow';
import { bgmSource, tempoOf } from '../store/derived';
import { openSpecialSettings, setSpecialOff, specialOff } from '../store/special';
import { setSpecialCols, specialColsMode } from '../store/specialLayout';
import { useSongLength, useSoundsVersion } from './hooks';
import { Icon } from './icons';
import { formatLevel, formatTime } from './format';
import { openTap } from '../store/tapTempo';
import { mirrorSelection, openFind } from '../store/find';
import { HistoryButton } from './HistoryButton';
import { togglePreview, usePreview } from '../store/preview';
import { bgaVisible, hasBga, useBga } from '../store/bga';
import { promptDialog } from './dialogs';
import { openPhrase } from '../store/phrase';
import { openMeasureGenAtCursor } from '../store/measureGen';
import { toggleFlamSelection } from '../store/flam';
import { openFx, useFx } from '../store/fx';
import { summon } from '../store/complete';
import { toMeasure } from '../dtx/base36';
import { togglePanel, useLayout } from '../store/layout';
import { MasterMixer } from './MixPanel';
import { MenuBar, type MenuDef, type MenuEntry } from './MenuBar';
import { NO_FOLDER_PICK, openPhoneTab, openSheet, setTracksOpen, togglePanelT, useDevice, type PanelId, type PhoneTab } from '../store/device';
import { useAssist } from '../store/assist';
import { openFilesPicker, openSaveSheet, tabletPanels } from './tablet/shared';
import { useLang } from '../i18n/useLang';
import { ORIGIN_KEY, originOf } from '../dtx/origin';
import { OriginBadge, originTitle } from './OriginBadge';
import { LogoMark } from './LogoMark';

const cursorM = () => {
  const s = useEditor.getState();
  return tempoOf(s.doc).locate(Math.max(0, s.cursorBeat)).m;
};

function deleteCursorMeasure() {
  const m = cursorM();
  const r = deleteMeasures(m, 1);
  toast(
    tr(
      `小節 ${toMeasure(m)} を削除しました（チップ ${r.removed} 個${r.kept ? `、BPM変化・BGMの開始 ${r.kept} 個は次の小節の頭へ移動` : ''}）。Ctrl+Z で戻せます`,
      `Deleted measure ${toMeasure(m)} (${r.removed} ${pl(r.removed, 'chip')}${r.kept ? `; moved ${r.kept} BPM-change/BGM-start ${pl(r.kept, 'chip')} to the start of the next measure` : ''}). Ctrl+Z to undo.`,
    ),
    'ok',
    6000,
  );
}

async function bulkMeasures() {
  const m = cursorM();
  const v = await promptDialog({
    title: tr(`小節 ${toMeasure(m)} から挿入・削除`, `Insert or delete measures at ${toMeasure(m)}`),
    body: tr(
      '増やすなら正の数（カーソルの小節の前に空の小節を入れる）、減らすなら負の数（カーソルの小節から消して詰める）を入れてください。',
      'Enter a positive number to insert that many empty measures before the cursor measure, or a negative number to delete measures from the cursor measure and close the gap.',
    ),
    value: '1',
    ok: tr('実行', 'Apply'),
  });
  const n = Math.trunc(Number(v));
  if (!v || !Number.isFinite(n) || n === 0) return;
  if (n > 0) {
    if (insertMeasures(m, n)) toast(tr(`${n} 小節を挿入しました`, `Inserted ${n} ${pl(n, 'measure')}`), 'ok');
  } else {
    const r = deleteMeasures(m, -n);
    toast(tr(`${-n} 小節を削除しました（チップ ${r.removed} 個）`, `Deleted ${-n} ${pl(-n, 'measure')} (${r.removed} ${pl(r.removed, 'chip')})`), 'ok');
  }
}

/**
 * 上のメニュー（ファイル・編集・表示・再生・ツール）の中身。デスクトップの上のバーとタブレットの ☰ のメニューで共通。
 * tablet: タブレット版（表示のパネルの項目をタブレットのパネルに、フォルダを選べない iPad では ZIP・ファイルを開く）
 */
export function useEditorMenus(folderInput: React.RefObject<HTMLInputElement | null>, tablet = false): MenuDef[] {
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useEditor((s) => s.future[s.future.length - 1]?.label);
  const s = () => useEditor.getState();
  const menus: MenuDef[] = [
    {
      label: tr('ファイル', 'File'),
      items: () => [
        NO_FOLDER_PICK || useDevice.getState().phone
          ? { label: tr('曲の ZIP・ファイルを開く…', 'Open song ZIP or files…'), run: () => openFilesPicker() }
          : { label: tr('曲フォルダを開く…', 'Open song folder…'), key: 'Ctrl+O', run: () => void openFolderPicker(folderInput.current) },
        // DTXMania の曲（PC の Chrome・Edge。src/ui/nxlib）
        ...(!tablet && supportsDirectWrite() ? [{ label: tr('DTXMania の曲…', 'DTXMania songs…'), run: () => void openNxPage() }] : []),
        { label: tr('新しい譜面…', 'New chart…'), run: () => void newEmptySong() },
        { label: bgmSource(s().doc) ? tr('原曲を差し替える…', 'Replace original audio…') : tr('原曲（音声ファイル）を読み込む…', 'Load original audio file…'), run: pickBgmFile },
        '-',
        ...(tablet
          ? useLocalSongs.getState().ready || isDiskFolder(s().folder)
            ? [
                { label: isDiskFolder(s().folder) ? tr('保存', 'Save') : tr(`保存（${localPlace()}に）`, `Save (in ${localPlace()})`), key: 'Ctrl+S', run: () => void save() },
                { label: tr('書き出し・共有…', 'Export and share…'), run: () => openSaveSheet() },
              ]
            : [{ label: tr('保存と書き出し…', 'Save and export…'), key: 'Ctrl+S', run: () => openSaveSheet() }]
          : [
              { label: tr('保存', 'Save'), key: 'Ctrl+S', run: () => void save() },
              { label: tr('名前を付けて保存…', 'Save as…'), key: 'Ctrl+Shift+S', run: () => void save({ as: true }) },
              // 本体に置いた曲：NX の曲フォルダへ移す・ZIP にする
              ...(isLocalFolder(s().folder) && supportsDirectWrite() ? [{ label: tr('曲フォルダに書き出す…', 'Export to a song folder…'), run: () => void save({ toFolder: true }) }] : []),
              ...(s().folder && !isDiskFolder(s().folder) ? [{ label: tr('曲フォルダを ZIP でダウンロード', 'Download song folder as ZIP'), run: () => void exportSongZip() }] : []),
            ]),
        // PC の曲フォルダ：保存先を変える（間違ったフォルダを選んだときも、ここで選び直せる）
        ...(isDiskFolder(s().folder) && supportsDirectWrite()
          ? [{ label: tr(`保存先のフォルダを変える…（いま「${s().folder?.name}」）`, `Change the save folder… (now "${s().folder?.name}")`), run: () => void changeSongFolder() }]
          : []),
        { label: tr('DTXファイルだけダウンロード', 'Download DTX file only'), run: () => void downloadDtx() },
        '-',
        // Google Drive（操作の中でログインの小窓を開くので、run の中で直に呼ぶ）
        ...(useDriveAuth.getState().connected
          ? [
              { label: tr('Google Drive から開く…', 'Open from Google Drive…'), run: () => openFromDrive() },
              ...(s().folder?.dir
                ? [{ label: s().folder?.drive ? tr('Google Drive に今すぐ送る', 'Send to Google Drive now') : tr('Google Drive にも保存する', 'Also save to Google Drive'), run: () => pushNow() }]
                : []),
              ...(s().folder?.drive ? [{ label: tr('Google Drive のこの曲のフォルダを片付ける…', "Clean up this song's folder on Google Drive…"), run: () => cleanDriveJunk() }] : []),
            ]
          : [{ label: tr('Google Drive につなぐ…', 'Connect Google Drive…'), run: () => connectDrive() }]),
        '-',
        { label: tr('ホームに戻る', 'Back to home'), run: goHome },
      ],
    },
    {
      label: tr('編集', 'Edit'),
      items: () => [
        { label: undoLabel ? tr(`元に戻す（${undoLabel}）`, `Undo (${undoLabel})`) : tr('元に戻す', 'Undo'), key: 'Ctrl+Z', run: undo, disabled: !canUndo },
        { label: redoLabel ? tr(`やり直す（${redoLabel}）`, `Redo (${redoLabel})`) : tr('やり直す', 'Redo'), key: 'Ctrl+Y', run: redo, disabled: !canRedo },
        '-',
        { label: tr('切り取り', 'Cut'), key: 'Ctrl+X', run: cutSelection, disabled: s().selection.length === 0 },
        { label: tr('コピー', 'Copy'), key: 'Ctrl+C', run: () => void copySelection(), disabled: s().selection.length === 0 },
        { label: tr('カーソル位置に貼り付け', 'Paste at cursor'), key: 'Ctrl+V', run: paste, disabled: s().clipboard.length === 0 },
        { label: tr('削除', 'Delete'), key: 'Delete', run: deleteSelection, disabled: s().selection.length === 0 },
        '-',
        { label: tr('ドラムのチップをすべて選択', 'Select all drum chips'), key: 'Ctrl+A', run: selectAll },
        { label: tr('選択を解除', 'Deselect'), key: 'Esc', run: () => useEditor.setState({ selection: [] }) },
        '-',
        { label: tr('検索と置換・レーンの入れ替え…', 'Find & replace / swap lanes…'), key: 'Ctrl+F', run: openFind },
        { label: tr('選んだチップを左右反転', 'Mirror selected chips'), run: mirrorSelection, disabled: s().selection.length === 0 },
        { label: tr('選んだチップをフラムにする／1打に戻す', 'Make selected chips a flam / back to one hit'), key: 'Alt+F', run: toggleFlamSelection, disabled: s().selection.length === 0 },
        // スマホは見る・聴くだけ
        ...(useDevice.getState().phone ? [] : [{ label: tr('エフェクトの編集（ハイカット・ローカット・ピッチ）', 'Effect editing (high cut, low cut, pitch)'), key: 'E', checked: useFx.getState().open, run: () => openFx() }]),
        '-',
        { label: tr('カーソルの小節の前に小節を挿入', 'Insert measure before cursor measure'), run: () => insertMeasures(cursorM()) },
        { label: tr('カーソルの小節を削除して詰める', 'Delete cursor measure and close gap'), run: () => deleteCursorMeasure() },
        { label: tr('小節をまとめて挿入・削除…', 'Insert or delete several measures…'), run: () => void bulkMeasures() },
        '-',
        { label: tr('曲の終わり（END）を ▶ の所にする', 'Set song end (END) at ▶'), run: songEndAtCursor },
        { label: tr('END を最後のチップのすぐ後にする', 'Set END right after the last chip'), run: songEndAtLastChip },
        { label: tr('END を原曲の鳴り終わりに合わせる', 'Set END where the original audio ends'), run: resetSongEnd, disabled: s().doc.endMeasure === undefined },
      ],
    },
    {
      label: tr('表示', 'View'),
      items: () => [
        ...(tablet
          ? tabletPanelItems()
          : [
              { label: tr('左のパネル（キット・WAV・曲情報）', 'Left panel (kit, WAV, song info)'), checked: useLayout.getState().leftOpen, run: () => togglePanel('left') },
              { label: tr('右のパネル（原曲・耳コピアシスト・確かめる）', 'Right panel (original, transcription assist, checks)'), checked: useLayout.getState().rightOpen, run: () => togglePanel('right') },
              { label: tr('下のトラック（原曲・ステム・譜面の音）', 'Bottom tracks (original, stems, chart sounds)'), checked: useLayout.getState().seekOpen, run: () => togglePanel('seek') },
            ]),
        '-',
        { label: tr('拡大', 'Zoom in'), key: tr('Ctrl+ホイール', 'Ctrl+Wheel'), run: () => zoom(1.25) },
        { label: tr('縮小', 'Zoom out'), run: () => zoom(0.8) },
        '-',
        ...GRID_DIVS.map((d) => ({ label: tr(`グリッド ${gridLabel(d)}`, `Grid ${gridLabel(d)}`), checked: s().view.div === d, run: () => setView({ div: d }) })),
        '-',
        { label: tr('BGA・動画の列を出す', 'Show BGA and movie columns'), checked: bgaVisible(), run: () => useBga.setState({ show: !useBga.getState().show }), disabled: hasBga(s().doc) && !useDevice.getState().phone },
        { label: tr('BGA の列を広げてサムネイルを出す', 'Widen BGA columns to show thumbnails'), checked: useBga.getState().wide, run: () => useBga.setState({ wide: !useBga.getState().wide, show: true }) },
        '-',
        // 特殊ノーツ（クラップなど）：分けて見せるか、種類ごとの列にするか（重ねるときは行き先のレーンに描く）
        { label: tr('特殊ノーツ（クラップなど）を分けて見せる', 'Show special notes (claps etc.) separately'), checked: !specialOff(), run: () => setSpecialOff(!specialOff()) },
        { label: tr('特殊ノーツを種類ごとの列に分ける（切ると行き先のレーンに重ねる）', 'Give special notes their own columns (off: draw them on their lanes)'), checked: specialColsMode(), disabled: specialOff(), run: () => setSpecialCols(!specialColsMode()) },
        { label: tr('特殊ノーツの設定…', 'Special note settings…'), run: openSpecialSettings },
        '-',
        // スマホのプレビューは全画面だけ
        ...(useDevice.getState().phone
          ? []
          : [
              tablet
                ? { label: tr('DTXMania風プレビュー（パネル）', 'DTXMania-style preview (panel)'), checked: useDevice.getState().panel === 'prev', key: 'P', run: () => togglePanelT('prev') }
                : { label: tr('DTXMania風プレビュー（右のパネル）', 'DTXMania-style preview (right panel)'), checked: usePreview.getState().mode === 'side', key: 'P', run: () => togglePreview('side') },
            ]),
        { label: tr('DTXMania風プレビュー（全画面）', 'DTXMania-style preview (full screen)'), key: 'Shift+P', run: () => togglePreview('full') },
        '-',
        // 画面の言語。名前はその言語自身で書く（どちらの言語の画面でも見つけられるように）
        ...(['en', 'ja'] as const).map((l) => ({ label: LANG_NAMES[l], checked: getLang() === l, run: () => setLang(l) })),
      ],
    },
    {
      label: tr('再生', 'Playback'),
      items: () => [
        { label: tr('最初から再生', 'Play from start'), key: 'F5', run: () => void playFrom(0) },
        { label: tr('▶ の位置から再生', 'Play from ▶'), key: 'F6', run: () => void playFrom(s().cursorBeat) },
        { label: tr('停止（▶ に戻る）', 'Stop (back to ▶)'), key: 'F7', run: stop, disabled: !s().playing },
        { label: tr('ここで止める', 'Stop here'), key: 'Shift+Space', run: togglePause, disabled: !s().playing },
        '-',
        { label: tr('再生位置を追いかける', 'Follow playback'), checked: s().view.follow, run: () => setView({ follow: !s().view.follow }) },
        { label: tr('メトロノーム（クリック）', 'Metronome (click)'), checked: s().mix.metronome, run: () => setMix({ metronome: !s().mix.metronome }) },
      ],
    },
    {
      label: tr('ツール', 'Tools'),
      items: () => [
        { label: tr('曲に合わせてクリックでBPMを測る', 'Tap along to measure the BPM'), key: 'T', run: () => openTap(true) },
        { label: tr(`テンポと開始位置を合わせる…${landOnly()}`, `Match tempo and start position…${landOnly()}`), run: openTempo },
        { label: tr('ステムとミックス…', 'Stems and mix…'), run: () => openPage('stems') },
        { label: tr('音源ライブラリ…', 'Sound library…'), run: () => openPage('library') },
        { label: tr('前の小節をカーソルの小節に複製', 'Duplicate previous measure into cursor measure'), key: 'Ctrl+D', run: () => duplicatePrevMeasure(tempoOf(s().doc).locate(Math.max(0, s().cursorBeat)).m) },
        { label: tr('TAB補完：カーソルの所に続きを出す', 'Tab completion: suggest what comes next at the cursor'), key: 'Alt+]', run: summon },
        '-',
        { label: tr('曲情報（AI取得・サムネイル）…', 'Song info (AI lookup, thumbnails)…'), run: () => openPage('songinfo') },
        { label: tr('▶ の小節をAIで生成（小節線の ✨ と同じ）', 'Generate the ▶ measure with AI (same as ✨ on bar lines)'), key: 'Alt+G', run: openMeasureGenAtCursor },
        { label: tr('フレーズ候補（フィル・リズム）…', 'Phrase suggestions (fills, grooves)…'), run: openPhrase },
        { label: tr('AI難易度生成（BASIC〜EXTREME）…', 'AI difficulty generator (BASIC–EXTREME)…'), run: () => openPage('ai') },
        { label: tr(`難易度ガイドライン…${landOnly()}`, `Difficulty guidelines…${landOnly()}`), run: () => openPage('guideline') },
        '-',
        { label: tr('設定（電子ドラム・キー・遅延補正）…', 'Settings (e-drums, keys, latency)…'), run: () => openSettings() },
        { label: tr('AIの設定（OpenRouter）…', 'AI settings (OpenRouter)…'), run: () => openSettings('ai') },
        { label: tr('アプリとして使う（追加・オフライン・更新）…', 'Use as an app (install, offline, updates)…'), run: () => openSettings('app') },
      ],
    },
  ];
  return menus;
}

/** スマホの縦で、横向きでだけ開く画面の印 */
function landOnly(): string {
  const d = useDevice.getState();
  return d.phone && d.portrait ? tr('（横向きで開く）', ' (landscape)') : '';
}

/** タブレット：表示メニューのパネルの項目（横はレールのパネル、縦は下のシート）。スマホは下のタブと原曲の打点の列 */
function tabletPanelItems(): MenuEntry[] {
  const d = useDevice.getState();
  if (d.phone) {
    const tabs: [PhoneTab, string][] = [
      ['pad', tr('パッド', 'Pads')],
      ['trk', tr('トラック', 'Tracks')],
      ['snd', tr('音', 'Sounds')],
      ['src', tr('原曲', 'Original')],
      ['asst', tr('耳コピ', 'Assist')],
      ['chk', tr('確かめる', 'Check')],
    ];
    const cols = useAssist.getState().audioCols;
    return [
      ...tabs.map(([id, label]) => ({ label: tr(`パネル：${label}`, `Panel: ${label}`), checked: d.pTab === id, run: () => openPhoneTab(id, true) })),
      '-',
      { label: tr('原曲の打点の列', 'Original hits column'), checked: cols, run: () => useAssist.setState({ audioCols: !cols }) },
    ];
  }
  const isOn = (id: PanelId) => (d.portrait ? d.sheetSize !== 'tabs' && d.sheetTab === id : d.panel === id);
  return [
    ...tabletPanels().map((p) => ({ label: tr(`パネル：${p.label}`, `Panel: ${p.label}`), checked: isOn(p.id), run: () => togglePanelT(p.id) })),
    {
      label: tr('下のトラック（原曲・ステム・譜面の音）', 'Bottom tracks (original, stems, chart sounds)'),
      checked: d.portrait ? d.sheetSize !== 'tabs' && d.sheetTab === 'trk' : d.tracksOpen,
      run: () => (d.portrait ? openSheet('trk', true) : setTracksOpen(!d.tracksOpen)),
    },
  ];
}

export function TopBar({ folderInput }: { folderInput: React.RefObject<HTMLInputElement | null> }) {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const unsaved = useUnsaved();
  // AI難易度生成で反映した難易度は、戻ったときに数秒光らせる
  const glowDiffs = useGlowDiffs();
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useEditor((s) => s.future[s.future.length - 1]?.label);
  const art = usePreimage();
  const previewMode = usePreview((st) => st.mode);
  useSoundsVersion();
  const barRef = useRef<HTMLElement>(null);
  // 言語が変わると文字の幅が変わるので、畳む段を測り直す
  const lang = useLang();
  // 開いている譜面の出どころ（AI で作った譜面か。手で直すと「手直し」になる）。印の無い譜面は数えない
  const mark = doc.fields[ORIGIN_KEY];
  const chips = doc.chips;
  const ownOrigin = useMemo(() => (mark === undefined ? 'human' : originOf({ chips, fields: { [ORIGIN_KEY]: mark } })), [mark, chips]);
  const originsKey = meta.siblings.map((x) => x.origin ?? '').join('') + ownOrigin;
  const fit = useTopbarFit(barRef, `${lang}|${meta.fileName}|${meta.siblings.length}|${originsKey}|${f0(doc.fields['TITLE'])}`);

  const f = doc.fields;
  const length = useSongLength(doc);

  const menus = useEditorMenus(folderInput);

  return (
    <header ref={barRef} className={`topbar ${fit >= 1 ? 'fit-logo' : ''} ${fit >= 2 ? 'fit-diff' : ''} ${fit >= 3 ? 'fit-ai' : ''} ${fit >= 4 ? 'fit-art' : ''} ${fit >= 5 ? 'fit-title' : ''} ${fit >= 6 ? 'fit-song' : ''} ${fit >= 7 ? 'fit-tools' : ''}`}>
      <button className="logo" onClick={goHome} title={tr('ホームに戻る（編集中の譜面は自動保存されています）', 'Back to home (the open chart is autosaved)')}>
        <LogoMark />
        <span className="hide-narrow logo-text">DTX Web Editor</span>
      </button>
      <MenuBar menus={menus} />
      <div className="song-head">
        <div className="song-art">{art ? <img src={art} alt="" /> : '♪'}</div>
        <div className="song-text">
          <div className="song-title ellipsis">
            {f['TITLE'] || tr('無題', 'Untitled')}
            {unsaved && (
              <span style={{ color: 'var(--amber)', marginLeft: 6 }} title={tr(`保存していない変更があります：${unsavedText(unsaved)}`, `Unsaved changes: ${unsavedText(unsaved)}`)}>
                ●
              </span>
            )}
          </div>
          <div className="song-sub ellipsis">
            {[f['ARTIST'] || tr('アーティスト未設定', 'No artist'), `${f['BPM'] ?? '120'} BPM`, formatTime(length, false), `Lv ${formatLevel(f['DLEVEL'])}`].join(' · ')}
          </div>
        </div>
        {meta.siblings.length > 1 && folder && (
          <div className="seg diff-tabs hide-narrow" style={{ marginLeft: 6 }}>
            {meta.siblings.map((sb) => {
              const cur = sb.file.toLowerCase() === meta.fileName.toLowerCase();
              const origin = cur ? ownOrigin : (sb.origin ?? 'human');
              return (
                <button key={sb.file} className={`${cur ? 'on' : ''} ${glowsDiff(glowDiffs, sb.file) ? 'glow' : ''}`} onClick={() => void switchDifficulty(sb.file)} title={origin === 'human' ? sb.file : `${sb.file} · ${originTitle(origin)}`}>
                  <span className="diff-full">{sb.label}</span>
                  <span className="diff-abbr">{abbrDiff(sb.label)}</span>
                  <OriginBadge origin={origin} tab />
                </button>
              );
            })}
          </div>
        )}
      </div>
      {/* AI難易度生成：メインの次くらいに使う機能なので、メニューの奥ではなく上のバーに置く（難易度の切り替えの隣） */}
      <button
        className="btn ai-gen"
        onClick={() => openPage('ai')}
        title={tr(
          'AI難易度生成：いま開いている譜面から、それより下の難易度（EXTREME・ADVANCED・BASIC）を作り、曲に既にある難易度と並べて聴き比べる',
          'AI difficulty generator: make the easier difficulties (EXTREME, ADVANCED, BASIC) from the open chart and compare them side by side with the ones already in the song',
        )}
        aria-label={tr('AI難易度生成', 'AI difficulty generator')}
      >
        {Icon.sparkle(14)}
        <span className="ai-gen-label">{tr('AI難易度生成', 'AI difficulties')}</span>
      </button>
      <div className="topbar-spacer" />
      <MasterMixer />
      <div className="vsep" />
      <button className="ib" onClick={undo} disabled={!canUndo} title={undoLabel ? tr(`元に戻す: ${undoLabel}（Ctrl+Z）`, `Undo: ${undoLabel} (Ctrl+Z)`) : tr('元に戻す（Ctrl+Z）', 'Undo (Ctrl+Z)')}>
        {Icon.undo()}
      </button>
      <button className="ib" onClick={redo} disabled={!canRedo} title={redoLabel ? tr(`やり直す: ${redoLabel}（Ctrl+Y）`, `Redo: ${redoLabel} (Ctrl+Y)`) : tr('やり直す（Ctrl+Y）', 'Redo (Ctrl+Y)')}>
        {Icon.redo()}
      </button>
      <button className={`ib tb-preview ${previewMode !== 'off' ? 'on' : ''}`} onClick={() => togglePreview('side')} title={tr('DTXMania風プレビュー（P、Shift+P で全画面）', 'DTXMania-style preview (P; Shift+P for full screen)')}>
        {Icon.screen()}
      </button>
      <HistoryButton />
      <button className="ib" onClick={() => openSettings()} title={tr('設定（電子ドラム・キーボード・遅延補正）', 'Settings (e-drums, keyboard, latency)')}>
        {Icon.gear()}
      </button>
      <button
        className="btn primary"
        onClick={() => void save()}
        title={
          isDiskFolder(folder)
            ? tr(`${folder.name}/${meta.fileName} に保存（Ctrl+S）`, `Save to ${folder.name}/${meta.fileName} (Ctrl+S)`)
            : isLocalFolder(folder)
              ? tr(`${localPlace()}の ${folder.name}/${meta.fileName} に保存（Ctrl+S）`, `Save to ${folder.name}/${meta.fileName} in ${localPlace()} (Ctrl+S)`)
              : tr('保存（Ctrl+S）', 'Save (Ctrl+S)')
        }
      >
        {Icon.save(15)}
        {tr('保存', 'Save')}
      </button>
    </header>
  );
}

const f0 = (v: string | undefined) => v ?? '';

/**
 * 上のバーが狭いときに畳む段：1 ロゴの文字、2 難易度名を短く、3 AI難易度生成をアイコンだけに、
 * 4 曲の画像を隠す、5 曲名を隠す（難易度の切り替えは残す）、6 曲の欄を隠す、
 * 7 DTXMania風プレビューのボタンを隠す（表示メニューと P キーに残る）。
 * FIT_NEED[i] は段 i のときに曲名の欄に残したい幅（px。曲名がこれより短ければその長さ）で、切ったら次の段へ畳む
 */
const FIT_NEED = [120, 120, 120, 64, 64, 0, 0];
const FIT_MAX = FIT_NEED.length;

/**
 * 上のバーが狭いときに畳む段を決める。曲名の欄が FIT_NEED を切る（曲の欄が切れる・バーからはみ出す）なら1段ずつ畳み、
 * 戻しても FIT_NEED を保てる幅になったら戻す。決まった画面幅ではなく実際の幅を測るので、
 * 言語やフォントで文字の幅が変わっても崩れない。
 */
function useTopbarFit(bar: React.RefObject<HTMLElement | null>, contentKey: string): number {
  const [level, setLevel] = useState(0);
  /** 段 i から i+1 に畳んで、曲名の欄が広がった幅 */
  const gain = useRef<number[]>([]);
  const stepped = useRef<{ from: number; room: number } | null>(null);
  /** 曲名の本来の幅（隠している間も、最後に測った値を使う） */
  const natural = useRef(0);
  const lastKey = useRef(contentKey);
  const [checkAgain, setCheckAgain] = useState(0);
  useLayoutEffect(() => {
    // 曲や難易度が変わったら、畳まない所から測り直す
    if (lastKey.current !== contentKey) {
      lastKey.current = contentKey;
      gain.current = [];
      stepped.current = null;
      natural.current = 0;
      if (level !== 0) {
        setLevel(0);
        return;
      }
    }
    const el = bar.current;
    if (!el) return;
    const need = (lv: number) => (lv >= FIT_NEED.length ? 0 : Math.min(FIT_NEED[lv], natural.current || FIT_NEED[lv]));
    const check = () => {
      const head = el.querySelector<HTMLElement>('.song-head');
      const text = el.querySelector<HTMLElement>('.song-text');
      const spacer = el.querySelector<HTMLElement>('.topbar-spacer');
      const headShown = !!head && head.offsetParent !== null;
      const textShown = headShown && !!text && text.offsetParent !== null;
      if (textShown) natural.current = Math.max(...[...text.children].map((c) => c.scrollWidth), 0);
      // 曲名が使える幅 = 曲名の今の幅 ＋ 空き − 曲の欄で切れている分 − バーからはみ出している分
      const room =
        (textShown ? text.clientWidth : 0) +
        (spacer?.clientWidth ?? 0) -
        (headShown ? Math.max(0, head.scrollWidth - head.clientWidth) : 0) -
        Math.max(0, el.scrollWidth - el.clientWidth);
      const st = stepped.current;
      stepped.current = null;
      if (st && st.from === level - 1) gain.current[st.from] = Math.max(0, room - st.room);
      if (level < FIT_MAX && room < need(level)) {
        stepped.current = { from: level, room };
        setLevel(level + 1);
      } else if (level > 0 && room - (gain.current[level - 1] ?? Infinity) >= need(level - 1) + 8) {
        setLevel(level - 1);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bar, level, contentKey, checkAgain]);
  // Web フォントを読み終えると文字の幅が変わるので測り直す
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => alive && setCheckAgain((n) => n + 1));
    return () => {
      alive = false;
    };
  }, []);
  return level;
}

/** 狭い画面での難易度の短い名前 */
export function abbrDiff(label: string): string {
  const m: Record<string, string> = { NOVICE: 'NOV', REGULAR: 'REG', BASIC: 'BSC', ADVANCED: 'ADV', EXPERT: 'EXP', EXTREME: 'EXT', MASTER: 'MAS', ULTIMATE: 'ULT' };
  return m[label.toUpperCase()] ?? (label.length > 5 ? label.slice(0, 4) : label);
}

/** 曲フォルダの PREIMAGE を表示用の URL にする */
export function usePreimage(): string | null {
  const folder = useEditor((s) => s.folder);
  const name = useEditor((s) => s.doc.fields['PREIMAGE']);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    const f = name ? findFile(folder, name) : undefined;
    if (f) {
      void f.getFile().then((file) => {
        if (!alive) return;
        made = URL.createObjectURL(file);
        setUrl(made);
      });
    }
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [folder, name]);
  return url;
}
