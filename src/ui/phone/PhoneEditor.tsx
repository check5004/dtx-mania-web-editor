// スマホ版のエディタ（承認されたデザイン「スマホ」）。
// 縦：上のバー 44・見出し 22＋譜面・道具の帯 44（シートを開くと隠す）・再生の帯 52・シート（低い 270・高い 520）・下のタブ 50
// 横：左に道具 52｜譜面｜右に再生 80。パネルは右から 320 で譜面に重ねる（譜面は縮めない）
// 回しても ▶・選んでいるチップ・開いているタブはそのまま（タブは縦のシートと横のパネルで同じ）
import { useEffect, useLayoutEffect, useState } from 'react';
import { tr } from '../../i18n';
import { frac, mul } from '../../dtx/fraction';
import { gridStep } from '../../edit/ops';
import { setLoopPoint, toggleLoop, useAssist } from '../../store/assist';
import { hasBga, useBga } from '../../store/bga';
import { openCtxMenu } from '../../store/ctxMenu';
import { closePhoneTab, openPhoneTab, setDrawer, setPhoneHigh, setTool, useDevice, type PhoneTab } from '../../store/device';
import { copySelection, deleteChips, goToStart, moveSelection, openPage, redo, setView, toast, togglePause, togglePlay, undo, useEditor } from '../../store/editor';
import { toggleFlamMode, useFlam } from '../../store/flam';
import { useFind } from '../../store/find';
import { usePreview } from '../../store/preview';
import { unsavedText, useUnsaved } from '../../store/unsaved';
import { toggleVelMode, useVel } from '../../store/velocity';
import { ChartCanvas } from '../ChartCanvas';
import { ContextMenuHost } from '../ContextMenu';
import { SpecialPopoverHost } from '../SpecialUi';
import { FindPanel } from '../FindPanel';
import { formatTime } from '../format';
import { useSongLength, useSoundsVersion } from '../hooks';
import { Icon } from '../icons';
import { NxPreview } from '../NxPreview';
import { usePreimage } from '../TopBar';
import { PanelContent, panelIcon } from '../tablet/Panels';
import { SaveSheet } from '../tablet/SaveSheet';
import { tabletSave } from '../tablet/shared';
import { Drawer } from '../tablet/TabletEditor';
import { PhoneGenDock, PhonePhraseDock, PhoneTabBar, usePhoneDock } from './PhoneCands';
import { DiffMenu, GridPick, MetronomeButton, PosBox, SpeedPick, StrengthPick, VolumeButton } from './PhoneParts';
import { KIND_ROW_H, kindRows, PhonePads, PhoneTracks, PhoneVelocity, usePadKinds } from './PhoneSheets';

/** 下のタブ（デザインの並び） */
function phoneTabs(): { id: PhoneTab; label: string }[] {
  return [
    { id: 'pad', label: tr('パッド', 'Pads') },
    { id: 'trk', label: tr('トラック', 'Tracks') },
    { id: 'snd', label: tr('音', 'Sounds') },
    { id: 'src', label: tr('原曲', 'Original') },
    { id: 'asst', label: tr('耳コピ', 'Assist') },
    { id: 'chk', label: tr('確かめる', 'Check') },
  ];
}

/** シートの高さ：低い・高い（画面が低い端末では、譜面が 60 は見えるところまで） */
export const PHONE_SHEET = { low: 270, high: 520 };
/** 縦の帯の高さ（上のバー・道具の帯・再生の帯・下のタブ・譜面の見出し） */
const PORT = { top: 44, tools: 44, transport: 52, tabs: 50, head: 22, minChart: 60 };

/**
 * 原曲の列（打点・波形）を出すかは縦と横で別に覚える：縦は打点だけで、出すとレーンが 36 → 32 になるので初めは出さない。
 * 横はレーン 48 のまま打点と波形が入るので初めから出す
 */
const audioColsMem = { port: false, land: true };

function useAudioColsByOrientation(portrait: boolean) {
  const key = portrait ? 'port' : 'land';
  useLayoutEffect(() => {
    useAssist.setState({ audioCols: audioColsMem[key] });
    return useAssist.subscribe((s, prev) => {
      if (s.audioCols !== prev.audioCols) audioColsMem[key] = s.audioCols;
    });
  }, [key]);
}

// ---- 縦：上のバー -------------------------------------------------------------------------

function PTop() {
  const doc = useEditor((s) => s.doc);
  const unsaved = useUnsaved();
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const art = usePreimage();
  useSoundsVersion();
  const length = useSongLength(doc);
  const f = doc.fields;
  return (
    <header className="p-top">
      <button className="p-ib" onClick={() => setDrawer(true)} aria-label={tr('メニュー', 'Menu')} title={tr('メニュー（ファイル・編集・表示・再生・ツール）', 'Menu (File, Edit, View, Playback, Tools)')}>
        {Icon.menu(22)}
      </button>
      <button className="p-song" onClick={() => openPage('songinfo')} aria-label={tr('曲情報', 'Song info')}>
        <span className="p-art">{art ? <img src={art} alt="" /> : '♪'}</span>
        <span className="p-song-text">
          <span className="p-song-title ellipsis">
            {f['TITLE'] || tr('無題', 'Untitled')}
            {unsaved && <i className="p-dirty" title={tr(`保存していない変更があります：${unsavedText(unsaved)}`, `Unsaved changes: ${unsavedText(unsaved)}`)} />}
          </span>
          <span className="p-song-sub ellipsis">{`${f['BPM'] ?? '120'} BPM · ${formatTime(length, false)}`}</span>
        </span>
      </button>
      <DiffMenu dir="down" />
      <button className="p-ib" onClick={undo} disabled={!canUndo} aria-label={undoLabel ? tr(`元に戻す: ${undoLabel}`, `Undo: ${undoLabel}`) : tr('元に戻す', 'Undo')}>
        {Icon.undo(20)}
      </button>
      <button className="p-ib" onClick={redo} disabled={!canRedo} aria-label={tr('やり直す', 'Redo')}>
        {Icon.redo(20)}
      </button>
      <button className="p-btn primary p-save" onClick={tabletSave} aria-label={tr('保存', 'Save')} title={tr('保存', 'Save')}>
        {Icon.save(18)}
      </button>
    </header>
  );
}

// ---- 縦：道具の帯 -------------------------------------------------------------------------

function PTools() {
  const tool = useDevice((s) => s.tool);
  const flam = useFlam((s) => s.mode);
  const follow = useEditor((s) => s.view.follow);
  const audioCols = useAssist((s) => s.audioCols);
  return (
    <nav className="p-tools" aria-label={tr('編集の道具', 'Edit tools')}>
      <div className="p-seg" role="radiogroup" aria-label={tr('道具', 'Tool')}>
        <button role="radio" aria-checked={tool === 'place'} className={tool === 'place' ? 'on' : ''} onClick={() => setTool('place')} title={tr('置く：触れて吹き出しで確かめ、離して置く・ダブルタップで消す', 'Place: touch, check the bubble, release to place; double-tap to delete')}>
          {Icon.pencil(15)}
          <span>{tr('置く', 'Place')}</span>
        </button>
        <button role="radio" aria-checked={tool === 'select'} className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title={tr('選ぶ：なぞって範囲・タップで足す／外す', 'Select: drag for a range, tap to add or remove')}>
          {Icon.selectBox(15)}
          <span>{tr('選ぶ', 'Select')}</span>
        </button>
      </div>
      <span className="p-vsep" />
      <GridPick look="tool" dir="up" />
      <button className={`p-pt ${flam ? 'on' : ''}`} onClick={() => toggleFlamMode()} aria-pressed={flam} title={tr('フラムで置く（同じレーンに2打をほんの少しずらして置く）', 'Place flams (two notes on the same lane, slightly apart)')}>
        {Icon.flam(18)}
        <span>{tr('フラム', 'Flam')}</span>
      </button>
      <StrengthPick look="tool" dir="up" />
      <button className={`p-pt ${audioCols ? 'on' : ''}`} onClick={() => useAssist.setState({ audioCols: !audioCols })} aria-pressed={audioCols} title={tr('原曲の打点の列を出す（レーンは少し細くなります）', 'Show the original hits column (lanes get a little narrower)')}>
        {Icon.wave(18)}
        <span>{tr('打点', 'Hits')}</span>
      </button>
      <span className="grow" />
      <button className={`p-pt ${follow ? 'on' : ''}`} onClick={() => setView({ follow: !follow })} aria-pressed={follow} title={tr('再生位置を追いかける', 'Follow playback')}>
        {Icon.follow(18)}
        <span>{tr('追う', 'Follow')}</span>
      </button>
    </nav>
  );
}

// ---- 再生の帯（縦） -------------------------------------------------------------------------

function ABButtons({ boxed = false }: { boxed?: boolean }) {
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const half = loop ? null : loopMark;
  return (
    <>
      <button className={`p-ab ${boxed ? 'sq' : ''} ${loop || half?.side === 'a' ? 'set' : ''}`} onClick={() => setLoopPoint('a')} aria-label={tr('ループの始まり（A）を ▶ に', 'Set loop start (A) at ▶')} title={tr('▶ の位置を A（ループの始まり）にする', 'Set A (loop start) at ▶')}>
        A
      </button>
      <button className={`p-ab ${boxed ? 'sq' : ''} ${loop || half?.side === 'b' ? 'set' : ''}`} onClick={() => setLoopPoint('b')} aria-label={tr('ループの終わり（B）を ▶ に', 'Set loop end (B) at ▶')} title={tr('▶ の位置を B（ループの終わり）にする', 'Set B (loop end) at ▶')}>
        B
      </button>
    </>
  );
}

export function LoopButton({ boxed = false }: { boxed?: boolean }) {
  const loop = useAssist((s) => s.loop);
  return (
    <button className={`p-ib p-loop ${boxed ? 'boxed sq' : ''} ${loop?.on ? 'on' : ''}`} onClick={toggleLoop} aria-pressed={!!loop?.on} aria-label={tr('ループ再生', 'Loop playback')} title={loop ? tr('ループ再生（A–B）', 'Loop playback (A–B)') : tr('ループ再生（A と B を決めると繰り返します）', 'Loop playback (set A and B to repeat)')}>
      {Icon.loop(boxed ? 18 : 19)}
    </button>
  );
}

/** ⏮（再生中は ⏸ ここで止める）と ▶/■ */
export function PlayButtons({ small = false }: { small?: boolean }) {
  const playing = useEditor((s) => s.playing);
  return (
    <>
      {playing ? (
        <button className={`p-ib ${small ? 'narrow' : ''}`} onClick={togglePause} aria-label={tr('ここで止める', 'Stop here')} title={tr('ここで止める（止めた所に ▶ を移す）', 'Stop here (moves ▶ to where you stopped)')}>
          {Icon.pause(small ? 18 : 20)}
        </button>
      ) : (
        <button className={`p-ib ${small ? 'narrow' : ''}`} onClick={goToStart} aria-label={tr('曲の頭へ', 'To start')} title={tr('曲の頭へ（▶ を曲の頭に置きます）', 'Go to start (moves ▶ to the start of the song)')}>
          {Icon.toStart(small ? 18 : 20)}
        </button>
      )}
      <button className={`p-play ${small ? 'land' : ''}`} onClick={togglePlay} aria-label={playing ? tr('停止（▶ に戻る）', 'Stop (back to ▶)') : tr('▶ から再生', 'Play from ▶')}>
        {playing ? Icon.stop(20) : Icon.play(22)}
      </button>
    </>
  );
}

function PTransport() {
  return (
    <div className="p-transport">
      <PlayButtons />
      <PosBox />
      <ABButtons />
      <LoopButton />
      <SpeedPick />
      <span className="grow" />
      <MetronomeButton />
      <VolumeButton dir="up-end" />
    </div>
  );
}

// ---- 縦：下のシートとタブ -------------------------------------------------------------------

/** シートの中身 */
function SheetBody({ tab, land }: { tab: PhoneTab; land: boolean }) {
  if (tab === 'pad') return <PhonePads land={land} />;
  if (tab === 'trk') return <PhoneTracks />;
  return <PanelContent id={tab} where="sheet" />;
}

/** 縦のシートの高さの上限（譜面が少しは見えるように） */
function sheetMax(vh: number): number {
  return Math.max(PHONE_SHEET.low, vh - PORT.top - PORT.transport - PORT.tabs - PORT.head - PORT.minChart);
}

function PSheet() {
  const tab = useDevice((s) => s.pTab);
  const high = useDevice((s) => s.pHigh);
  const vh = useDevice((s) => s.vh);
  const velMode = useVel((s) => s.mode);
  const kinds = usePadKinds().length;
  const [drag, setDrag] = useState<number | null>(null);
  if (!tab && !velMode) return null;
  const maxH = Math.min(PHONE_SHEET.high, sheetMax(vh));
  // パッドは譜面を見ながら叩くので、いつも低いまま（特殊ノーツの種類があれば、その段の分だけ高く）
  const canHigh = tab !== 'pad' || velMode;
  const lowH = tab === 'pad' && !velMode && kinds ? PHONE_SHEET.low + kindRows(kinds) * (KIND_ROW_H + 6) : PHONE_SHEET.low;
  const target = high && canHigh ? maxH : Math.min(lowH, maxH);
  const height = drag ?? target;
  const grip = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const id = e.pointerId;
    const y0 = e.clientY;
    const t0 = e.timeStamp;
    let moved = false;
    let last = target;
    const samples: { t: number; h: number }[] = [];
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const h = Math.max(0, Math.min(maxH, target + (y0 - ev.clientY)));
      if (!moved && Math.abs(h - target) < 6) return;
      moved = true;
      last = h;
      samples.push({ t: ev.timeStamp, h });
      if (samples.length > 12) samples.shift();
      setDrag(h);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(null);
      if (!moved) {
        // タップ：低い ⇄ 高い（パッドは閉じる）
        if (ev.type === 'pointerup' && ev.timeStamp - t0 < 500) {
          if (canHigh) setPhoneHigh(!high);
          else closePhoneTab();
        }
        return;
      }
      const recent = samples.filter((p) => ev.timeStamp - p.t <= 100);
      const v = recent.length >= 2 ? (recent[recent.length - 1].h - recent[0].h) / Math.max(16, ev.timeStamp - recent[0].t) : 0;
      const low = Math.min(lowH, maxH);
      // はじいたらその向きへ（高いから下へはじいたら低い、低いから下へなら閉じる）。止めて離したら近い所
      let to: 'close' | 'low' | 'high';
      if (v > 0.5) to = canHigh ? 'high' : 'low';
      else if (v < -0.5) to = high && canHigh && last > low + 8 ? 'low' : 'close';
      else if (last < low * 0.55) to = 'close';
      else if (canHigh && last > (low + maxH) / 2) to = 'high';
      else to = 'low';
      if (to === 'close') {
        if (velMode) toggleVelMode(false);
        closePhoneTab();
      } else setPhoneHigh(to === 'high');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div className={`p-sheet ${drag !== null ? 'dragging' : ''}`} style={{ height }}>
      <div
        className="p-sheet-grip"
        onPointerDown={grip}
        role="separator"
        aria-orientation="horizontal"
        aria-label={tr('シートの高さ（タップで低い・高い、下へはじくと閉じる）', 'Sheet height (tap for low/high, flick down to close)')}
      >
        <i />
      </div>
      <div className="p-sheet-body scroll">{velMode ? <PhoneVelocity /> : tab ? <SheetBody tab={tab} land={false} /> : null}</div>
    </div>
  );
}

function PTabs() {
  const tab = useDevice((s) => s.pTab);
  return (
    <nav className="p-tabs" aria-label={tr('パネル', 'Panels')}>
      {phoneTabs().map((t) => (
        <button key={t.id} className={`p-tab ${tab === t.id ? 'on' : ''}`} onClick={() => openPhoneTab(t.id, true)} aria-pressed={tab === t.id}>
          {panelIcon(t.id, 20)}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

// ---- 選んでいるとき（譜面の上端に浮かせる） ------------------------------------------------------

function nudge(dBeat: -1 | 0 | 1, dLane: -1 | 0 | 1) {
  const s = useEditor.getState();
  const ok = moveSelection(dBeat ? mul(gridStep(s.view.div), frac(dBeat)) : frac(0), dLane, { hear: true });
  if (!ok) toast(dLane ? tr('これ以上レーンを動かせません', "Can't move the lanes any further") : tr('これ以上動かせません', "Can't move any further"), 'info', 1800);
}

function PSelBar() {
  const sel = useEditor((s) => s.selection);
  if (sel.length === 0) return null;
  const n = sel.length;
  const btn = (icon: React.ReactNode, label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, cls = '') => (
    <button className={`p-ib ${cls}`} onClick={onClick} aria-label={label} title={label}>
      {icon}
    </button>
  );
  return (
    <div className="p-selbar-wrap">
      <div className="p-selbar" role="toolbar" aria-label={tr('選んだチップ', 'Selected chips')} onPointerDown={(e) => e.stopPropagation()}>
        <span className="p-selbar-count">
          <b className="mono">{n}</b>
          <span>{tr('個', n > 1 ? 'chips' : 'chip')}</span>
        </span>
        <i className="p-vsep" />
        {btn(Icon.arrowUp(19), tr('後へ（グリッド1つ）', 'Later by one grid step'), () => nudge(1, 0))}
        {btn(Icon.arrowDown(19), tr('前へ（グリッド1つ）', 'Earlier by one grid step'), () => nudge(-1, 0))}
        {btn(Icon.arrowLeft(19), tr('左のレーンへ', 'Lane to the left'), () => nudge(0, -1))}
        {btn(Icon.arrowRight(19), tr('右のレーンへ', 'Lane to the right'), () => nudge(0, 1))}
        <i className="p-vsep" />
        {btn(Icon.copy(19), tr('コピー', 'Copy'), () => toast(tr(`${copySelection()}個をコピーしました（貼り付けは長押しのメニュー）`, `Copied ${n} (paste from the long-press menu)`), 'ok', 2500))}
        {btn(
          Icon.trash(19),
          tr('削除', 'Delete'),
          () => {
            deleteChips([...sel]);
            toast(tr(`${n}個のチップを消しました`, `Deleted ${n} chip${n > 1 ? 's' : ''}`), 'info', 3500, { label: tr('元に戻す', 'Undo'), run: undo });
          },
          'danger',
        )}
        {btn(Icon.dots(19), tr('その他（強さ・フラム・切り取り・レーン・種類）', 'More (velocity, flam, cut, lane, type)'), (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openCtxMenu({ kind: 'chips', ids: [...sel], anchor: sel[0] }, r.left, r.bottom, true);
        })}
        {btn(Icon.close(19), tr('選ぶのをやめる', 'Clear the selection'), () => useEditor.setState({ selection: [] }))}
      </div>
    </div>
  );
}

// ---- 横：左の道具・右の再生・重ねるパネル ------------------------------------------------------

/** 横のパネルを閉じたとき、次に「パネル」で開くタブ */
let lastLandTab: PhoneTab = 'pad';

function LTool({ on, icon, label, onClick, title }: { on?: boolean; icon: React.ReactNode; label: string; onClick: () => void; title?: string }) {
  return (
    <button className={`p-pt rail ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} title={title ?? label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function LLeft() {
  const tool = useDevice((s) => s.tool);
  const flam = useFlam((s) => s.mode);
  const tab = useDevice((s) => s.pTab);
  return (
    <nav className="p-left" aria-label={tr('編集の道具', 'Edit tools')}>
      <LTool icon={Icon.menu(20)} label={tr('メニュー', 'Menu')} onClick={() => setDrawer(true)} />
      <LTool on={tool === 'place'} icon={Icon.pencil(19)} label={tr('置く', 'Place')} onClick={() => setTool('place')} />
      <LTool on={tool === 'select'} icon={Icon.selectBox(19)} label={tr('選ぶ', 'Select')} onClick={() => setTool('select')} />
      <GridPick look="rail" dir="right" />
      <StrengthPick look="rail" dir="right" />
      <LTool on={flam} icon={Icon.flam(19)} label={tr('フラム', 'Flam')} onClick={() => toggleFlamMode()} />
      <LTool
        on={!!tab}
        icon={Icon.layers(19)}
        label={tr('パネル', 'Panel')}
        onClick={() => (tab ? closePhoneTab() : openPhoneTab(lastLandTab))}
        title={tr('パネル（譜面に重ねて出す。もう一度押すと閉じる）', 'Panel (overlays the chart; tap again to close)')}
      />
    </nav>
  );
}

function LRight() {
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  return (
    <div className="p-right">
      <DiffMenu dir="left" />
      <div className="p-right-play">
        <PlayButtons small />
      </div>
      <PosBox center />
      <div className="p-right-row">
        <ABButtons boxed />
      </div>
      <div className="p-right-row">
        <LoopButton boxed />
        <SpeedPick compact />
      </div>
      <div className="p-right-row">
        <button className="p-ib boxed sq" onClick={undo} disabled={!canUndo} aria-label={tr('元に戻す', 'Undo')}>
          {Icon.undo(18)}
        </button>
        <button className="p-ib boxed sq" onClick={redo} disabled={!canRedo} aria-label={tr('やり直す', 'Redo')}>
          {Icon.redo(18)}
        </button>
      </div>
      {/* 音量の小窓は上へ開くので、音量は下の方に（保存のすぐ上） */}
      <div className="p-right-row">
        <MetronomeButton boxed />
        <VolumeButton dir="left" boxed />
      </div>
      <button className="p-btn primary p-save p-save-wide" onClick={tabletSave} aria-label={tr('保存', 'Save')} title={tr('保存', 'Save')}>
        {Icon.save(17)}
      </button>
    </div>
  );
}

function LPanel() {
  const tab = useDevice((s) => s.pTab);
  const velMode = useVel((s) => s.mode);
  if (!tab && !velMode) return null;
  if (tab) lastLandTab = tab;
  return (
    <aside className="p-panel" aria-label={tr('パネル', 'Panel')}>
      <div className="p-panel-tabs">
        {phoneTabs().map((t) => (
          <button key={t.id} className={`p-ib ${tab === t.id && !velMode ? 'on' : ''}`} onClick={() => openPhoneTab(t.id)} aria-label={t.label} title={t.label}>
            {panelIcon(t.id, 19)}
          </button>
        ))}
        <span className="grow" />
        <button className="p-ib" onClick={closePhoneTab} aria-label={tr('パネルを閉じる', 'Close panel')}>
          {Icon.close(18)}
        </button>
      </div>
      <div className="p-panel-body scroll">{velMode ? <PhoneVelocity /> : tab ? <SheetBody tab={tab} land /> : null}</div>
    </aside>
  );
}

// ---- 全体 -------------------------------------------------------------------------------

export function PhoneEditor({ folderInput }: { folderInput: React.RefObject<HTMLInputElement | null> }) {
  const portrait = useDevice((s) => s.portrait);
  const tab = useDevice((s) => s.pTab);
  const velMode = useVel((s) => s.mode);
  const findOpen = useFind((s) => s.open);
  const dock = usePhoneDock();
  const previewMode = usePreview((s) => s.mode);
  // レーンの幅を変えるもの（原曲の列・強さの列・BGA の列）が変わったら決め直す
  useAssist((s) => s.audioCols);
  useVel((s) => s.lanes.length);
  useBga((s) => `${s.show}|${s.wide}`);
  useEditor((s) => hasBga(s.doc));
  useAudioColsByOrientation(portrait);
  // スマホのプレビューは全画面だけ（右のパネルのプレビューは使わない）
  useEffect(() => {
    if (usePreview.getState().mode === 'side') usePreview.setState({ mode: 'off' });
  }, []);
  // TAB補完は譜面の下の端に重ねる帯、小節の生成・フレーズ候補は譜面の下に並べるパネル（点線の候補を隠さない）
  const chart = (
    <section className="chart-area p-chart">
      <ChartCanvas />
      <PSelBar />
      <PhoneTabBar />
      {findOpen && <FindPanel />}
    </section>
  );
  const docks = (
    <>
      <PhoneGenDock />
      {!findOpen && <PhonePhraseDock />}
    </>
  );
  return (
    <div className={`p-editor ${portrait ? 'port' : 'land'}`}>
      {portrait ? (
        <>
          <PTop />
          {chart}
          {docks}
          {!tab && !velMode && !dock && <PTools />}
          <PTransport />
          <PSheet />
          <PTabs />
        </>
      ) : (
        <div className="p-land">
          <LLeft />
          <div className="p-land-chart">
            {chart}
            {docks}
            <LPanel />
          </div>
          <LRight />
        </div>
      )}
      <Drawer folderInput={folderInput} />
      <ContextMenuHost />
      <SpecialPopoverHost />
      <SaveSheet />
      {previewMode === 'full' && (
        <div className="nx-overlay">
          <NxPreview full />
        </div>
      )}
    </div>
  );
}
