import { useEffect, useRef, useState } from 'react';
import { downloadDtx, newEmptySong, openFolderPicker, save, switchDifficulty } from '../app/fileActions';
import { GRID_DIVS, gridLabel } from '../edit/ops';
import { findFile } from '../fs/folder';
import {
  copySelection,
  cutSelection,
  deleteSelection,
  goHome,
  isDirty,
  paste,
  playFrom,
  redo,
  selectAll,
  setView,
  stop,
  undo,
  useEditor,
  zoom,
} from '../store/editor';
import { songLength, useSoundsVersion } from './hooks';
import { Icon } from './icons';
import { formatLevel, formatTime } from './format';

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
  useSoundsVersion();

  const f = doc.fields;
  const length = songLength(doc);
  const s = () => useEditor.getState();

  return (
    <header className="topbar">
      <button className="logo" onClick={goHome} title="ホームに戻る（編集中の譜面は自動保存されています）">
        <span className="logo-mark">D</span>
        <span className="hide-narrow">DTX Web Editor</span>
      </button>
      <nav className="menus">
        <Menu
          label="ファイル"
          items={() => [
            { label: '曲フォルダを開く…', key: 'Ctrl+O', run: () => void openFolderPicker(folderInput.current) },
            { label: '新しい譜面…', run: () => void newEmptySong() },
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
          ]}
        />
        <Menu
          label="表示"
          items={() => [
            { label: '拡大', key: 'Ctrl+ホイール', run: () => zoom(1.25) },
            { label: '縮小', run: () => zoom(0.8) },
            '-',
            ...GRID_DIVS.map((d) => ({ label: `グリッド ${gridLabel(d)}${s().view.div === d ? '  ✓' : ''}`, run: () => setView({ div: d }) })),
          ]}
        />
        <Menu
          label="再生"
          items={() => [
            { label: '最初から再生', key: 'F5', run: () => void playFrom(0) },
            { label: 'カーソル位置から再生', key: 'F6', run: () => void playFrom(s().cursorBeat) },
            { label: '停止', key: 'F7', run: stop },
            '-',
            { label: `再生位置を追いかける${s().view.follow ? '  ✓' : ''}`, run: () => setView({ follow: !s().view.follow }) },
          ]}
        />
      </nav>
      <div className="song-head grow">
        <div className="song-art">{art ? <img src={art} alt="" /> : '♪'}</div>
        <div style={{ minWidth: 0 }}>
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
                {sb.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="ib" onClick={undo} disabled={!canUndo} title={undoLabel ? `元に戻す: ${undoLabel}（Ctrl+Z）` : '元に戻す（Ctrl+Z）'}>
        {Icon.undo()}
      </button>
      <button className="ib" onClick={redo} disabled={!canRedo} title={redoLabel ? `やり直す: ${redoLabel}（Ctrl+Y）` : 'やり直す（Ctrl+Y）'}>
        {Icon.redo()}
      </button>
      <button className="btn primary" onClick={() => void save()} title={folder?.dir ? `${folder.name}/${meta.fileName} に保存（Ctrl+S）` : '保存（Ctrl+S）'}>
        {Icon.save(15)}
        保存
      </button>
    </header>
  );
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
