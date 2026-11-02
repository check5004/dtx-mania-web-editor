import { useEffect, useRef } from 'react';
import { openDroppedFiles, openFolderFromInput, openFolderPicker, save } from '../app/fileActions';
import { frac } from '../dtx/fraction';
import { gridStep, snapToGrid, stepGrid } from '../edit/ops';
import { autoEnableMidi } from '../input/midi';
import { adoptGhostsInRange, useAssist } from '../store/assist';
import { tempoOf } from '../store/derived';
import { keyHit } from '../store/hits';
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicatePrevMeasure,
  moveSelection,
  paste,
  playFrom,
  redo,
  selectAll,
  setCursorBeat,
  setView,
  stop,
  togglePlay,
  undo,
  useEditor,
  zoom,
} from '../store/editor';
import { ChartCanvas } from './ChartCanvas';
import { Footer } from './Footer';
import { LeftPanel } from './LeftPanel';
import { RightPanel } from './RightPanel';
import { SettingsPage } from './SettingsPage';
import { tapKey } from './TapTempoPanel';
import { VelocityPanel } from './VelocityPanel';
import { nudgeSelection, setPreset, toggleVelMode, useVel } from '../store/velocity';
import { TempoPage } from './TempoPage';
import { StemsPage } from './StemsPage';
import { LibraryPage } from './LibraryPage';
import { SongInfoPage } from './SongInfoPage';
import { GuidelinePage } from './GuidelinePage';
import { AiGenPage } from './AiGenPage';
import { PhrasePanel } from './PhrasePanel';
import { usePhrase } from '../store/phrase';
import { FindPanel } from './FindPanel';
import { NxPreview } from './NxPreview';
import { togglePreview, usePreview } from '../store/preview';
import { gotoResult, openFind, useFind } from '../store/find';
import { toggleBgmMute, toggleDrumMute } from '../store/stems';
import { TopBar } from './TopBar';
import { Transport } from './Transport';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

function onKey(e: KeyboardEvent, folderInput: HTMLInputElement | null) {
  if (document.querySelector('.modal-back')) return;
  const s = useEditor.getState();
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  // 入力欄の中でも効くもの
  if (mod && k.toLowerCase() === 's') {
    e.preventDefault();
    void save({ as: e.shiftKey });
    return;
  }
  if (k === 'F5' || k === 'F6' || k === 'F7') {
    e.preventDefault();
    if (k === 'F5') void playFrom(0);
    else if (k === 'F6') void playFrom(s.cursorBeat);
    else stop();
    return;
  }
  if (isTyping(e)) return;
  // 原曲・譜面の音のミュート（ステム画面でも効く）
  if (e.altKey && !mod && (e.code === 'Digit1' || e.code === 'Digit2')) {
    e.preventDefault();
    if (e.code === 'Digit1') toggleBgmMute();
    else toggleDrumMute();
    return;
  }
  if (s.page === 'stems' && k === ' ') {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (s.page !== 'chart') return;
  if (k === 'F3') {
    e.preventDefault();
    if (!useFind.getState().open) openFind();
    else gotoResult(useFind.getState().index + (e.shiftKey ? -1 : 1));
    return;
  }
  if (mod) {
    switch (k.toLowerCase()) {
      case 'f':
      case 'h':
        e.preventDefault();
        openFind();
        return;
      case 'd': {
        e.preventDefault();
        const { m } = tempoOf(s.doc).locate(Math.max(0, s.cursorBeat));
        duplicatePrevMeasure(m);
        return;
      }
      case 'z':
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      case 'y':
        e.preventDefault();
        redo();
        return;
      case 'c':
        e.preventDefault();
        copySelection();
        return;
      case 'x':
        e.preventDefault();
        cutSelection();
        return;
      case 'v':
        e.preventDefault();
        paste();
        return;
      case 'a':
        e.preventDefault();
        selectAll();
        return;
      case 'o':
        e.preventDefault();
        void openFolderPicker(folderInput);
        return;
      case '=':
      case '+':
      case ';':
        e.preventDefault();
        zoom(1.25);
        return;
      case '-':
        e.preventDefault();
        zoom(0.8);
        return;
    }
    return;
  }
  // 強さ：Alt+↑↓ で選んだチップの強さ（Shift で1ずつ）
  if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
    e.preventDefault();
    nudgeSelection((k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1 : 5));
    return;
  }
  // ドラムのキー（試し打ち・キー入力・録音）
  if (!e.altKey && keyHit(e)) {
    e.preventDefault();
    return;
  }
  // 1・2・3：置く強さ（強・中・弱）
  if (!e.altKey && !e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) {
    e.preventDefault();
    setPreset((Number(e.code.slice(5)) - 1) as 0 | 1 | 2);
    return;
  }
  // P：NX風プレビュー（Shift+P で全画面）
  if (!e.altKey && e.code === 'KeyP') {
    e.preventDefault();
    togglePreview(e.shiftKey ? 'full' : 'side');
    return;
  }
  // V：強さの編集モード
  if (!e.altKey && e.code === 'KeyV') {
    e.preventDefault();
    toggleVelMode();
    return;
  }
  // T: 曲に合わせて叩いてBPMを測る
  if (tapKey(e)) {
    e.preventDefault();
    return;
  }
  const keyMode = useAssist.getState().inputMode === 'key';
  switch (k) {
    case ' ':
      e.preventDefault();
      togglePlay();
      return;
    case 'Enter': {
      // カーソルの小節の候補をまとめて採用
      e.preventDefault();
      const tempo = tempoOf(s.doc);
      const { m } = tempo.locate(Math.max(0, s.cursorBeat));
      adoptGhostsInRange(tempo.measureStart(m), tempo.measureStart(m + 1));
      return;
    }
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      deleteSelection();
      return;
    case 'Escape':
      if (usePreview.getState().mode === 'full') {
        usePreview.setState({ mode: 'side' });
        return;
      }
      if (useVel.getState().mode) {
        toggleVelMode(false);
        return;
      }
      useEditor.setState({ selection: [] });
      return;
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault();
      const sign = k === 'ArrowUp' ? 1 : -1;
      const step = e.shiftKey ? frac(4) : gridStep(s.view.div);
      if (s.selection.length > 0 && !keyMode) {
        moveSelection(frac(sign * step.n, step.d), 0);
      } else {
        const tempo = tempoOf(s.doc);
        const p = snapToGrid(tempo, Math.max(0, s.cursorBeat), s.view.div);
        const nb = Math.max(0, tempo.beatOf(p.m, p.f) + (sign * step.n) / step.d);
        setCursorBeat(nb);
        const viewBeats = 6;
        if (nb > s.view.scrollBeat + viewBeats * 2 || nb < s.view.scrollBeat) setView({ scrollBeat: nb - 2 });
      }
      return;
    }
    case 'ArrowLeft':
    case 'ArrowRight':
      if (s.selection.length > 0) {
        e.preventDefault();
        moveSelection(frac(0), k === 'ArrowLeft' ? -1 : 1);
      }
      return;
    case '[':
    case ']': {
      setView({ div: stepGrid(s.view.div, k === ']' ? 1 : -1) });
      return;
    }
    case 'Home':
      setCursorBeat(0);
      setView({ scrollBeat: -0.5 });
      return;
  }
}

export function Editor() {
  const folderInput = useRef<HTMLInputElement>(null);
  const page = useEditor((s) => s.page);
  const velMode = useVel((s) => s.mode);
  const findOpen = useFind((s) => s.open);
  const previewMode = usePreview((s) => s.mode);
  const phraseOpen = usePhrase((s) => s.open);
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e, folderInput.current);
    window.addEventListener('keydown', h);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState();
      if (s.doc !== s.savedDoc) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    void autoEnableMidi();
    return () => {
      window.removeEventListener('keydown', h);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void openDroppedFiles([...e.dataTransfer.files]);
      }}
    >
      {page === 'tempo' ? (
        <TempoPage />
      ) : page === 'settings' ? (
        <SettingsPage />
      ) : page === 'stems' ? (
        <StemsPage />
      ) : page === 'library' ? (
        <LibraryPage />
      ) : page === 'songinfo' ? (
        <SongInfoPage />
      ) : page === 'guideline' ? (
        <GuidelinePage />
      ) : page === 'ai' ? (
        <AiGenPage />
      ) : (
        <>
          <TopBar folderInput={folderInput} />
          <Transport />
          <div className={`main ${velMode ? 'vel-mode' : ''}`}>
            {!velMode && <LeftPanel />}
            <section className="chart-area">
              <ChartCanvas />
              {findOpen && <FindPanel />}
              {phraseOpen && !findOpen && <PhrasePanel />}
            </section>
            {velMode ? <VelocityPanel /> : previewMode === 'side' ? <NxPreview /> : <RightPanel />}
          </div>
          <Footer />
          {previewMode === 'full' && (
            <div className="nx-overlay">
              <NxPreview full />
            </div>
          )}
        </>
      )}
      <FolderInput inputRef={folderInput} />
    </div>
  );
}

/** フォルダ選択の代わり（File System Access API が無いブラウザ用） */
export function FolderInput({
  inputRef,
  onFiles,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFiles?: (list: FileList | null) => void;
}) {
  return (
    <input
      ref={(el) => {
        inputRef.current = el;
        el?.setAttribute('webkitdirectory', '');
      }}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        if (onFiles) onFiles(e.target.files);
        else void openFolderFromInput(e.target.files);
        e.target.value = '';
      }}
    />
  );
}
