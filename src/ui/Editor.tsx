import { tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { dropAudioInEditor, openDroppedFiles, openFolderFromInput, openFolderPicker, save } from '../app/fileActions';
import { frac } from '../dtx/fraction';
import { gridStep, snapToGrid, stepGrid } from '../edit/ops';
import { autoEnableMidi } from '../input/midi';
import { setLoopPoint, toggleLoop, useAssist } from '../store/assist';
import { stopAudition } from '../store/audition';
import { tempoOf } from '../store/derived';
import { keyHit } from '../store/hits';
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicatePrevMeasure,
  goToStart,
  moveSelection,
  paste,
  playFrom,
  redo,
  selectAll,
  setCursorBeat,
  setView,
  stop,
  togglePause,
  togglePlay,
  undo,
  useEditor,
  zoom,
} from '../store/editor';
import { ChartCanvas } from './ChartCanvas';
import { ContextMenuHost } from './ContextMenu';
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
import { acceptGhost, dismissGhost, stepGhost, useComplete } from '../store/complete';
import { openMeasureGenAtCursor } from '../store/measureGen';
import { toggleFlamSelection } from '../store/flam';
import { TopBar } from './TopBar';
import { effectiveColumns, useLayout } from '../store/layout';
import { PanelRail, VSplitter } from './Splitter';
import { Transport } from './Transport';
import { useDevice } from '../store/device';
import { TabletEditor } from './tablet/TabletEditor';
import { PhoneEditor } from './phone/PhoneEditor';
import { LandscapeOnly } from './phone/LandscapeOnly';
import { tabletSave } from './tablet/shared';
import { hasUnsaved } from '../store/unsaved';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

/** Alt+] ・Alt+[ の向き（Mac の Option では文字が変わるので、キーの位置でも見る） */
function bracketDir(e: KeyboardEvent): 1 | -1 | 0 {
  const k = e.key;
  if (k === ']' || k === '‘' || k === '’' || k === '」') return 1;
  if (k === '[' || k === '“' || k === '”' || k === '「') return -1;
  if (e.code === 'BracketRight') return 1;
  if (e.code === 'BracketLeft') return -1;
  return 0;
}

function onKey(e: KeyboardEvent, folderInput: HTMLInputElement | null) {
  if (document.querySelector('.modal-back')) return;
  const s = useEditor.getState();
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  // 入力欄の中でも効くもの
  if (mod && k.toLowerCase() === 's') {
    e.preventDefault();
    // タブレット版：曲フォルダに書けなければ「保存と書き出し」
    if (useDevice.getState().tablet && !e.shiftKey) tabletSave();
    else void save({ as: e.shiftKey });
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
    if (e.shiftKey) togglePause();
    else togglePlay();
    return;
  }
  if (s.page !== 'chart') return;
  if (k === 'F3') {
    e.preventDefault();
    if (!useFind.getState().open) openFind();
    else gotoResult(useFind.getState().index + (e.shiftKey ? -1 : 1));
    return;
  }
  // TAB補完：Tab で点線をまとめて入れる（Shift+Tab は1小節だけ）。
  // TAB補完を使うときは、点線が無くても Tab でボタンへ移らない（続けて押したときに操作が効かなくならないように）
  if (k === 'Tab' && !mod && !e.altKey) {
    if (acceptGhost(e.shiftKey ? 1 : undefined) || useComplete.getState().enabled) e.preventDefault();
    return;
  }
  // Alt+G：▶ の小節を AI で生成（小節線の ✨ と同じ）
  if (e.altKey && !mod && e.code === 'KeyG') {
    e.preventDefault();
    openMeasureGenAtCursor();
    return;
  }
  // Alt+F：選んだチップをフラムにする（もうフラムなら1打に戻す）
  if (e.altKey && !mod && e.code === 'KeyF') {
    e.preventDefault();
    toggleFlamSelection();
    return;
  }
  // Alt+] ・Alt+[：次・前の候補（点線が無ければ、カーソルの小節に呼び出す）
  if (e.altKey && !mod) {
    const dir = bracketDir(e);
    if (dir !== 0) {
      e.preventDefault();
      stepGhost(dir);
      return;
    }
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
  // ベロシティ：Alt+↑↓ で選んだチップのベロシティ（Shift で1ずつ）
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
  // I・O：今の位置をループの A・B に。/：ループのオン・オフ
  if (!e.altKey && !e.shiftKey && (e.code === 'KeyI' || e.code === 'KeyO')) {
    e.preventDefault();
    setLoopPoint(e.code === 'KeyI' ? 'a' : 'b');
    return;
  }
  if (!e.altKey && (k === '/' || e.code === 'Slash' || e.code === 'NumpadDivide')) {
    e.preventDefault();
    toggleLoop();
    return;
  }
  // 1・2・3：置くベロシティ（強・中・弱）
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
  // V：ベロシティの編集モード
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
      // Space：再生・停止（止めると ▶ に戻る）。Shift+Space：ここで止める（▶ を止めた所へ）
      e.preventDefault();
      if (e.shiftKey) togglePause();
      else togglePlay();
      return;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      deleteSelection();
      return;
    case 'Escape':
      // 試聴（WAV・キットのタブの ▶）を止める
      if (stopAudition()) return;
      if (usePreview.getState().mode === 'full') {
        usePreview.setState({ mode: 'side' });
        return;
      }
      if (dismissGhost()) return;
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
        moveSelection(frac(0), k === 'ArrowLeft' ? -1 : 1, { hear: true });
      }
      return;
    case '[':
    case ']': {
      setView({ div: stepGrid(s.view.div, k === ']' ? 1 : -1) });
      return;
    }
    case 'Home':
      goToStart();
      return;
  }
}

export function Editor() {
  const folderInput = useRef<HTMLInputElement>(null);
  const page = useEditor((s) => s.page);
  const tablet = useDevice((s) => s.tablet);
  const phone = useDevice((s) => s.phone);
  const portrait = useDevice((s) => s.portrait);
  const velMode = useVel((s) => s.mode);
  const findOpen = useFind((s) => s.open);
  const previewMode = usePreview((s) => s.mode);
  const phraseOpen = usePhrase((s) => s.open);
  const layout = useLayout();
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const hasLeft = !velMode;
  const cols = effectiveColumns(layout, width, hasLeft);
  const rightLabel = velMode ? tr('ベロシティの道具', 'Velocity tools') : previewMode === 'side' ? tr('NX風プレビュー', 'NX-style preview') : tr('原曲・耳コピアシスト・確かめる', 'Original, transcription assist, checks');
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e, folderInput.current);
    window.addEventListener('keydown', h);
    // 保存の ● と同じく、作業ファイルだけの変更も数える
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsaved()) e.preventDefault();
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
        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;
        // DTX なら開く。音声だけなら、今の譜面の原曲・ステムにするか新しい譜面にするかを選ぶ
        if (files.some((f) => /\.dtx$/i.test(f.name))) void openDroppedFiles(files);
        else void dropAudioInEditor(files);
      }}
    >
      {page === 'tempo' && phone && portrait ? (
        <LandscapeOnly title={tr('テンポと開始位置', 'Tempo and start')} why={tr('波形と譜面を横に並べて合わせるので、横向きで使います。', 'It lines up the waveform and the chart side by side, so it is used in landscape.')} />
      ) : page === 'guideline' && phone && portrait ? (
        <LandscapeOnly title={tr('難易度ガイドライン', 'Difficulty guidelines')} why={tr('難易度ごとの表を横に並べるので、横向きで使います。', 'It shows the tables for each difficulty side by side, so it is used in landscape.')} />
      ) : page === 'tempo' ? (
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
      ) : phone ? (
        <PhoneEditor folderInput={folderInput} />
      ) : tablet ? (
        <TabletEditor folderInput={folderInput} />
      ) : (
        <>
          <TopBar folderInput={folderInput} />
          <Transport />
          <div
            className={`main ${velMode ? 'vel-mode' : ''}`}
            style={{
              gridTemplateColumns: hasLeft
                ? `${cols.left}px 0px minmax(0, 1fr) 0px ${cols.right}px`
                : `minmax(0, 1fr) 0px ${cols.right}px`,
            }}
          >
            {hasLeft && (cols.leftOpen ? <LeftPanel /> : <PanelRail side="left" label={tr('キット・WAV・曲情報', 'Kit, WAV, song info')} />)}
            {hasLeft && <VSplitter side="left" open={cols.leftOpen} />}
            <section className="chart-area">
              <ChartCanvas />
              {findOpen && <FindPanel />}
              {phraseOpen && !findOpen && <PhrasePanel />}
            </section>
            <VSplitter side="right" open={cols.rightOpen} />
            {!cols.rightOpen ? (
              <PanelRail side="right" label={rightLabel} />
            ) : velMode ? (
              <VelocityPanel />
            ) : previewMode === 'side' ? (
              <NxPreview />
            ) : (
              <RightPanel />
            )}
          </div>
          <Footer />
          <ContextMenuHost />
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
