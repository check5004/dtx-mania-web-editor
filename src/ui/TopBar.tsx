import { useEffect, useRef, useState } from 'react';
import { downloadDtx, newEmptySong, openFolderPicker, pickBgmFile, save, switchDifficulty } from '../app/fileActions';
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
  isDirty,
  openPage,
  openSettings,
  openTempo,
  paste,
  playFrom,
  redo,
  selectAll,
  setView,
  stop,
  togglePause,
  undo,
  useEditor,
  zoom,
} from '../store/editor';
import { bgmSource, tempoOf } from '../store/derived';
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
import { summon } from '../store/complete';
import { toMeasure } from '../dtx/base36';
import { togglePanel, useLayout } from '../store/layout';
import { MasterMixer } from './MixPanel';

interface MenuItem {
  label: string;
  key?: string;
  run: () => void;
  disabled?: boolean;
}

type MenuEntry = MenuItem | '-';

function Menu({ label, items }: { label: string; items: () => MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className={`menu-btn ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu-pop" style={{ top: 34, left: 0 }}>
          {items().map((it, i) =>
            it === '-' ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                className="menu-item"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                {it.label}
                {it.key && <span className="key">{it.key}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

const cursorM = () => {
  const s = useEditor.getState();
  return tempoOf(s.doc).locate(Math.max(0, s.cursorBeat)).m;
};

function deleteCursorMeasure() {
  const m = cursorM();
  const r = deleteMeasures(m, 1);
  toast(`小節 ${toMeasure(m)} を削除しました（チップ ${r.removed} 個${r.kept ? `、BPM変化・BGMの開始 ${r.kept} 個は次の小節の頭へ移動` : ''}）。Ctrl+Z で戻せます`, 'ok', 6000);
}

async function bulkMeasures() {
  const m = cursorM();
  const v = await promptDialog({
    title: `小節 ${toMeasure(m)} から挿入・削除`,
    body: '増やすなら正の数（カーソルの小節の前に空の小節を入れる）、減らすなら負の数（カーソルの小節から消して詰める）を入れてください。',
    value: '1',
    ok: '実行',
  });
  const n = Math.trunc(Number(v));
  if (!v || !Number.isFinite(n) || n === 0) return;
  if (n > 0) {
    if (insertMeasures(m, n)) toast(`${n} 小節を挿入しました`, 'ok');
  } else {
    const r = deleteMeasures(m, -n);
    toast(`${-n} 小節を削除しました（チップ ${r.removed} 個）`, 'ok');
  }
}

export function TopBar({ folderInput }: { folderInput: React.RefObject<HTMLInputElement | null> }) {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const dirty = useEditor(isDirty);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useEditor((s) => s.future[s.future.length - 1]?.label);
  const art = usePreimage();
  const previewMode = usePreview((st) => st.mode);
  useSoundsVersion();

  const f = doc.fields;
  const length = useSongLength(doc);
  const s = () => useEditor.getState();

  return (
    <header className="topbar">
      <button className="logo" onClick={goHome} title="ホームに戻る（編集中の譜面は自動保存されています）">
        <span className="logo-mark">D</span>
        <span className="hide-narrow logo-text">DTX Web Editor</span>
      </button>
      <nav className="menus">
        <Menu
          label="ファイル"
          items={() => [
            { label: '曲フォルダを開く…', key: 'Ctrl+O', run: () => void openFolderPicker(folderInput.current) },
            { label: '新しい譜面…', run: () => void newEmptySong() },
            { label: bgmSource(s().doc) ? '原曲を差し替える…' : '原曲（音声ファイル）を読み込む…', run: pickBgmFile },
            '-',
            { label: '保存', key: 'Ctrl+S', run: () => void save() },
            { label: '名前を付けて保存…', key: 'Ctrl+Shift+S', run: () => void save({ as: true }) },
            { label: 'DTXファイルだけダウンロード', run: downloadDtx },
            '-',
            { label: 'ホームに戻る', run: goHome },
          ]}
        />
        <Menu
          label="編集"
          items={() => [
            { label: undoLabel ? `元に戻す（${undoLabel}）` : '元に戻す', key: 'Ctrl+Z', run: undo, disabled: !canUndo },
            { label: redoLabel ? `やり直す（${redoLabel}）` : 'やり直す', key: 'Ctrl+Y', run: redo, disabled: !canRedo },
            '-',
            { label: '切り取り', key: 'Ctrl+X', run: cutSelection, disabled: s().selection.length === 0 },
            { label: 'コピー', key: 'Ctrl+C', run: () => void copySelection(), disabled: s().selection.length === 0 },
            { label: 'カーソル位置に貼り付け', key: 'Ctrl+V', run: paste, disabled: s().clipboard.length === 0 },
            { label: '削除', key: 'Delete', run: deleteSelection, disabled: s().selection.length === 0 },
            '-',
            { label: 'ドラムのチップをすべて選択', key: 'Ctrl+A', run: selectAll },
            { label: '選択を解除', key: 'Esc', run: () => useEditor.setState({ selection: [] }) },
            '-',
            { label: '検索と置換・レーンの入れ替え…', key: 'Ctrl+F', run: openFind },
            { label: '選んだチップを左右反転', run: mirrorSelection, disabled: s().selection.length === 0 },
            '-',
            { label: 'カーソルの小節の前に小節を挿入', run: () => insertMeasures(cursorM()) },
            { label: 'カーソルの小節を削除して詰める', run: () => deleteCursorMeasure() },
            { label: '小節をまとめて挿入・削除…', run: () => void bulkMeasures() },
          ]}
        />
        <Menu
          label="表示"
          items={() => [
            { label: `左のパネル（キット・WAV・曲情報）${useLayout.getState().leftOpen ? '  ✓' : ''}`, run: () => togglePanel('left') },
            { label: `右のパネル（原曲・耳コピアシスト・確かめる）${useLayout.getState().rightOpen ? '  ✓' : ''}`, run: () => togglePanel('right') },
            { label: `下のトラック（原曲・ステム・譜面の音）${useLayout.getState().seekOpen ? '  ✓' : ''}`, run: () => togglePanel('seek') },
            '-',
            { label: '拡大', key: 'Ctrl+ホイール', run: () => zoom(1.25) },
            { label: '縮小', run: () => zoom(0.8) },
            '-',
            ...GRID_DIVS.map((d) => ({ label: `グリッド ${gridLabel(d)}${s().view.div === d ? '  ✓' : ''}`, run: () => setView({ div: d }) })),
            '-',
            { label: `BGA・動画の列を出す${bgaVisible() ? '  ✓' : ''}`, run: () => useBga.setState({ show: !useBga.getState().show }), disabled: hasBga(s().doc) },
            { label: `BGA の列を広げてサムネイルを出す${useBga.getState().wide ? '  ✓' : ''}`, run: () => useBga.setState({ wide: !useBga.getState().wide, show: true }) },
            '-',
            { label: `NX風プレビュー（右のパネル）${usePreview.getState().mode === 'side' ? '  ✓' : ''}`, key: 'P', run: () => togglePreview('side') },
            { label: 'NX風プレビュー（全画面）', key: 'Shift+P', run: () => togglePreview('full') },
          ]}
        />
        <Menu
          label="再生"
          items={() => [
            { label: '最初から再生', key: 'F5', run: () => void playFrom(0) },
            { label: '▶ の位置から再生', key: 'F6', run: () => void playFrom(s().cursorBeat) },
            { label: '停止（▶ に戻る）', key: 'F7', run: stop, disabled: !s().playing },
            { label: 'ここで止める', key: 'Shift+Space', run: togglePause, disabled: !s().playing },
            '-',
            { label: `再生位置を追いかける${s().view.follow ? '  ✓' : ''}`, run: () => setView({ follow: !s().view.follow }) },
          ]}
        />
        <Menu
          label="ツール"
          items={() => [
            { label: '曲に合わせてクリックでBPMを測る', key: 'T', run: () => openTap(true) },
            { label: 'テンポと開始位置を合わせる…', run: openTempo },
            { label: 'ステムとミックス…', run: () => openPage('stems') },
            { label: '音源ライブラリ…', run: () => openPage('library') },
            { label: '前の小節をカーソルの小節に複製', key: 'Ctrl+D', run: () => duplicatePrevMeasure(tempoOf(s().doc).locate(Math.max(0, s().cursorBeat)).m) },
            { label: 'TAB補完：カーソルの所に続きを出す', key: 'Alt+]', run: summon },
            '-',
            { label: '曲情報（AI取得・サムネイル）…', run: () => openPage('songinfo') },
            { label: 'フレーズ候補（フィル・リズム）…', run: openPhrase },
            { label: 'AI難易度生成（BASIC〜EXTREME）…', run: () => openPage('ai') },
            { label: '難易度ガイドライン…', run: () => openPage('guideline') },
            '-',
            { label: '設定（電子ドラム・キー・遅延補正）…', run: () => openSettings() },
            { label: 'AIの設定（OpenRouter）…', run: () => openSettings('ai') },
          ]}
        />
      </nav>
      <div className="song-head grow">
        <div className="song-art">{art ? <img src={art} alt="" /> : '♪'}</div>
        <div className="song-text">
          <div className="song-title ellipsis">
            {f['TITLE'] || '無題'}
            {dirty && <span style={{ color: 'var(--amber)', marginLeft: 6 }} title="保存していない変更があります">●</span>}
          </div>
          <div className="song-sub ellipsis">
            {[f['ARTIST'] || 'アーティスト未設定', `${f['BPM'] ?? '120'} BPM`, formatTime(length, false), `Lv ${formatLevel(f['DLEVEL'])}`].join(' · ')}
          </div>
        </div>
        {meta.siblings.length > 1 && folder && (
          <div className="seg diff-tabs hide-narrow" style={{ marginLeft: 6 }}>
            {meta.siblings.map((sb) => (
              <button key={sb.file} className={sb.file.toLowerCase() === meta.fileName.toLowerCase() ? 'on' : ''} onClick={() => void switchDifficulty(sb.file)} title={sb.file}>
                <span className="diff-full">{sb.label}</span>
                <span className="diff-abbr">{abbrDiff(sb.label)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <MasterMixer />
      <div className="vsep" />
      <button className="ib" onClick={undo} disabled={!canUndo} title={undoLabel ? `元に戻す: ${undoLabel}（Ctrl+Z）` : '元に戻す（Ctrl+Z）'}>
        {Icon.undo()}
      </button>
      <button className="ib" onClick={redo} disabled={!canRedo} title={redoLabel ? `やり直す: ${redoLabel}（Ctrl+Y）` : 'やり直す（Ctrl+Y）'}>
        {Icon.redo()}
      </button>
      <button className={`ib ${previewMode !== 'off' ? 'on' : ''}`} onClick={() => togglePreview('side')} title="NX風プレビュー（P、Shift+P で全画面）">
        {Icon.screen()}
      </button>
      <HistoryButton />
      <button className="ib" onClick={() => openSettings()} title="設定（電子ドラム・キーボード・遅延補正）">
        {Icon.gear()}
      </button>
      <button className="btn primary" onClick={() => void save()} title={folder?.dir ? `${folder.name}/${meta.fileName} に保存（Ctrl+S）` : '保存（Ctrl+S）'}>
        {Icon.save(15)}
        保存
      </button>
    </header>
  );
}

/** 狭い画面での難易度の短い名前 */
function abbrDiff(label: string): string {
  const m: Record<string, string> = { NOVICE: 'NOV', REGULAR: 'REG', BASIC: 'BSC', ADVANCED: 'ADV', EXPERT: 'EXP', EXTREME: 'EXT', MASTER: 'MAS', ULTIMATE: 'ULT' };
  return m[label.toUpperCase()] ?? (label.length > 5 ? label.slice(0, 4) : label);
}

/** 曲フォルダの PREIMAGE を表示用の URL にする */
function usePreimage(): string | null {
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
