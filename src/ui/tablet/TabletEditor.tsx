// タブレット版のエディタ（譜面の画面）。承認されたデザイン（タッチ操作の決まり・部品の実寸）に合わせる。
// 横（幅 1024 以上）：上のバー 56・操作のバー 60・左に道具 68・譜面・パネル 360（1枚だけ）・右にレール 76・下にトラックの帯 52（開くと 274、トラック1本ずつの高さで止まる）
// 縦（幅 1024 未満）：パネルは下のシート（タブだけ 80・細い 196・低い 304・半分 420・大 600、タブごとに高さを覚える）。上のバーは難易度を ▼ にまとめる
// 押せる所は 44×44 以上。ホバー・右クリックの代わりに、文字付きのボタンと長押し
import { useEffect, useMemo, useRef, useState } from 'react';
import { tr } from '../../i18n';
import { useLang } from '../../i18n/useLang';
import { switchDifficulty } from '../../app/fileActions';
import { ORIGIN_KEY, originOf } from '../../dtx/origin';
import { GRID_DIVS, gridLabel } from '../../edit/ops';
import { setLoopPoint, setSpeed, toggleLoop, useAssist } from '../../store/assist';
import { hasBga, useBga } from '../../store/bga';
import { tempoOf } from '../../store/derived';
import {
  setDrawer,
  setSheetSize,
  setTool,
  setTracksH,
  setTracksOpen,
  togglePanelT,
  useDevice,
  openSheet,
  type PanelId,
  type SheetTab,
} from '../../store/device';
import { SHEET_GRIP, SHEET_H, SHEET_TABS, snapHeight, snapSheet, stepSheet, trackStops } from '../../store/sheetSnap';
import { currentBeat, openPage, openTempo, playFrom, redo, setView, undo, useEditor } from '../../store/editor';
import { unsavedText, useUnsaved } from '../../store/unsaved';
import { glowsDiff, useGlowDiffs, useGlowing } from '../../store/glow';
import { toggleFlamMode, useFlam } from '../../store/flam';
import { useFind } from '../../store/find';
import { usePhrase } from '../../store/phrase';
import { usePreview } from '../../store/preview';
import { setPreset, toggleVelMode, useVel, velPresetNames } from '../../store/velocity';
import { useInputSettings } from '../../input/settings';
import { ChartCanvas, tabletLaneW, zoomChart } from '../ChartCanvas';
import { ContextMenuHost } from '../ContextMenu';
import { SpecialPopoverHost } from '../SpecialUi';
import { promptDialog } from '../dialogs';
import { FindPanel } from '../FindPanel';
import { chipBpmLabel, formatLevel, formatTime, meterLabel } from '../format';
import { useFold, useSongLength, useSongSpan, useSoundsVersion, usePlayBeat } from '../hooks';
import { Icon } from '../icons';
import { MasterMixer } from '../MixPanel';
import { NxPreview } from '../NxPreview';
import { OriginBadge, originTitle } from '../OriginBadge';
import { PhrasePanel } from '../PhrasePanel';
import { abbrDiff, useEditorMenus, usePreimage } from '../TopBar';
import { TABLET_TRACK_ROW, TrackPanel, useTrackCount } from '../Tracks';
import { PlayControls } from '../Transport';
import { VelocityPanel } from '../VelocityPanel';
import { FxPanel } from '../FxPanel';
import { openFx, useFx } from '../../store/fx';
import { PanelContent, panelIcon } from './Panels';
import { SaveSheet } from './SaveSheet';
import { SelectionBar } from './SelectionBar';
import { tabletPanels, tabletSave } from './shared';

const TOP_H = 56;
const TRANSPORT_H = 60;
/** 横のトラックの帯（閉じたとき） */
const STRIP_H = 52;

/** 外を押したら閉じる小窓 */
export function useOutside(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [open, ref, close]);
}

// ---- 上のバー ---------------------------------------------------------------------------

function DiffTabs({ asMenu }: { asMenu: boolean }) {
  const meta = useEditor((s) => s.meta);
  const doc = useEditor((s) => s.doc);
  const mark = doc.fields[ORIGIN_KEY];
  const chips = doc.chips;
  const ownOrigin = useMemo(() => (mark === undefined ? 'human' : originOf({ chips, fields: { [ORIGIN_KEY]: mark } })), [mark, chips]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(open, ref, () => setOpen(false));
  const cur = meta.siblings.find((sb) => sb.file.toLowerCase() === meta.fileName.toLowerCase());
  // AI難易度生成で反映した難易度は、戻ったときに数秒光らせる（▼ にまとめているときは ▼ を）
  const glowDiffs = useGlowDiffs();
  if (!asMenu) {
    return (
      <div className="seg t-seg t-diff">
        {meta.siblings.map((sb) => {
          const on = sb.file.toLowerCase() === meta.fileName.toLowerCase();
          const origin = on ? ownOrigin : (sb.origin ?? 'human');
          return (
            <button key={sb.file} className={`${on ? 'on' : ''} ${glowsDiff(glowDiffs, sb.file) ? 'glow' : ''}`} onClick={() => void switchDifficulty(sb.file)} title={origin === 'human' ? `${sb.label} · ${sb.file}` : `${sb.label} · ${originTitle(origin)}`}>
              {abbrDiff(sb.label)}
              <OriginBadge origin={origin} tab />
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="t-diff-menu" ref={ref}>
      <button className={`t-btn ${glowDiffs?.length ? 'glow' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={tr('難易度を切り替える', 'Switch difficulty')}>
        <span className="mono">{cur ? abbrDiff(cur.label) : '—'}</span>
        {Icon.chevronDown(14)}
      </button>
      {open && (
        <div className="t-pop t-diff-pop" role="menu">
          {meta.siblings.map((sb) => {
            const on = sb.file.toLowerCase() === meta.fileName.toLowerCase();
            const origin = on ? ownOrigin : (sb.origin ?? 'human');
            return (
              <button
                key={sb.file}
                role="menuitemradio"
                aria-checked={on}
                className={`t-pop-item ${on ? 'on' : ''}`}
                onClick={() => {
                  setOpen(false);
                  void switchDifficulty(sb.file);
                }}
              >
                <span className="t-ck">{on ? Icon.check(16) : null}</span>
                <span className="grow">{sb.label}</span>
                <OriginBadge origin={origin} tab />
                <span className="t-pop-sub mono">{sb.file}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TopBarT() {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  const unsaved = useUnsaved();
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const portrait = useDevice((s) => s.portrait);
  const panel = useDevice((s) => s.panel);
  const art = usePreimage();
  const lang = useLang();
  useSoundsVersion();
  const length = useSongLength(doc);
  const bar = useRef<HTMLElement>(null);
  const hasDiffs = meta.siblings.length > 1 && !!folder;
  // 畳む段：1 AI難易度生成を ✦ だけに、2 難易度を ▼ に、3 保存をアイコンだけに
  const fold = useFold(bar, 3, `${lang}|${portrait}|${meta.fileName}|${meta.siblings.length}`);
  const f = doc.fields;
  const aiIcon = portrait || fold >= 1;
  const diffMenu = portrait || fold >= 2;
  return (
    <header className="t-top" ref={bar} style={{ height: TOP_H }}>
      <button className="t-ib" onClick={() => setDrawer(true)} aria-label={tr('メニュー', 'Menu')} title={tr('メニュー（ファイル・編集・表示・再生・ツール）', 'Menu (File, Edit, View, Playback, Tools)')}>
        {Icon.menu(22)}
      </button>
      <button className="t-song" onClick={() => openPage('songinfo')} title={tr('曲情報', 'Song info')}>
        <span className="t-art">{art ? <img src={art} alt="" /> : '♪'}</span>
        <span className="t-song-text">
          <span className="t-song-title ellipsis">
            {f['TITLE'] || tr('無題', 'Untitled')}
            {unsaved && <i className="t-dirty" title={tr(`保存していない変更があります：${unsavedText(unsaved)}`, `Unsaved changes: ${unsavedText(unsaved)}`)} />}
          </span>
          <span className="t-song-sub ellipsis">{[f['ARTIST'] || tr('アーティスト未設定', 'No artist'), `${f['BPM'] ?? '120'} BPM`, formatTime(length, false), `Lv ${formatLevel(f['DLEVEL'])}`].join(' · ')}</span>
        </span>
      </button>
      {hasDiffs && <DiffTabs asMenu={diffMenu} />}
      <button
        className={`t-btn t-ai ${aiIcon ? 'icon' : ''}`}
        onClick={() => openPage('ai')}
        aria-label={tr('AI難易度生成', 'AI difficulty generator')}
        title={tr('AI難易度生成：いま開いている譜面から下の難易度を作り、聴き比べる', 'AI difficulty generator: make easier difficulties from the open chart and compare them')}
      >
        {Icon.sparkle(16)}
        {!aiIcon && <span>{tr('AI難易度生成', 'AI difficulties')}</span>}
      </button>
      <span className="grow" />
      <button className="t-ib" onClick={undo} disabled={!canUndo} aria-label={tr('元に戻す', 'Undo')} title={undoLabel ? tr(`元に戻す: ${undoLabel}`, `Undo: ${undoLabel}`) : tr('元に戻す', 'Undo')}>
        {Icon.undo(20)}
      </button>
      <button className="t-ib" onClick={redo} disabled={!canRedo} aria-label={tr('やり直す', 'Redo')} title={tr('やり直す', 'Redo')}>
        {Icon.redo(20)}
      </button>
      {!portrait && (
        <button className={`t-ib ${panel === 'prev' ? 'on' : ''}`} onClick={() => togglePanelT('prev')} aria-label={tr('NX風プレビュー', 'NX-style preview')} title={tr('NX風プレビュー', 'NX-style preview')}>
          {Icon.screen(20)}
        </button>
      )}
      <button className={`t-btn primary t-save ${fold >= 3 ? 'icon' : ''}`} onClick={tabletSave} aria-label={tr('保存', 'Save')}>
        {Icon.save(18)}
        {fold < 3 && <span>{tr('保存', 'Save')}</span>}
      </button>
    </header>
  );
}

// ---- 操作のバー ---------------------------------------------------------------------------

function SpeedSelect() {
  const speed = useAssist((s) => s.speed);
  const stretching = useAssist((s) => s.stretching);
  return (
    <label className={`t-select ${speed < 1 ? 'slow' : ''}`} title={tr('再生の速さ。原曲は音程を変えずに遅くします', 'Playback speed. The original slows down without changing pitch')}>
      <select
        value={speed}
        onChange={(e) => {
          setSpeed(Number(e.target.value));
          if (useEditor.getState().playing) void playFrom(currentBeat(), { keepStart: true });
        }}
        aria-label={tr('再生の速さ', 'Playback speed')}
      >
        {[1, 0.75, 0.5, 0.25].map((v) => (
          <option key={v} value={v}>
            {v * 100}%
          </option>
        ))}
      </select>
      <span className="mono">{stretching ? '…' : `${speed * 100}%`}</span>
      {Icon.chevronDown(14)}
    </label>
  );
}

function TransportT() {
  const portrait = useDevice((s) => s.portrait);
  // テンポを反映して戻ったら数秒光らせる
  const bpmGlow = useGlowing('bpm');
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const follow = useEditor((s) => s.view.follow);
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const { m } = tempo.locate(Math.max(0, beat));
  const half = loop ? null : loopMark;
  return (
    <div className="t-transport" style={{ height: TRANSPORT_H }}>
      <PlayControls where={tr('譜面の小節番号の左の帯・下のトラックの帯', 'the strip left of the measure numbers or the tracks strip below')} />
      <span className="t-vsep" />
      <button className={`t-ab ${loop || half?.side === 'a' ? 'set' : ''}`} onClick={() => setLoopPoint('a')} title={tr('▶ の位置を A（ループの始まり）にする', 'Set A (loop start) at ▶')}>
        A
      </button>
      <button className={`t-ab ${loop || half?.side === 'b' ? 'set' : ''}`} onClick={() => setLoopPoint('b')} title={tr('▶ の位置を B（ループの終わり）にする', 'Set B (loop end) at ▶')}>
        B
      </button>
      <button className={`t-btn t-loop ${loop?.on ? 'on' : ''} ${portrait ? 'icon' : ''}`} onClick={toggleLoop} aria-pressed={!!loop?.on} aria-label={tr('ループ再生', 'Loop playback')}>
        {Icon.loop(18)}
        {!portrait && <span>{tr('ループ', 'Loop')}</span>}
      </button>
      <span className="t-vsep" />
      <SpeedSelect />
      <button className={`t-ib boxed ${follow ? 'on' : ''}`} onClick={() => setView({ follow: !follow })} aria-pressed={follow} aria-label={tr('再生位置を追いかける', 'Follow playback')} title={tr('再生位置を追いかける', 'Follow playback')}>
        {Icon.follow(20)}
      </button>
      {!portrait && (
        <button className={`t-btn t-tempo ${bpmGlow ? 'glow' : ''}`} onClick={openTempo} title={tr('テンポと開始位置を合わせる', 'Match tempo and start position')}>
          {Icon.metronome(16)}
          <span className="mono">
            {chipBpmLabel(tempo.bpmAt(Math.max(0, beat)))} <span className="dim">{meterLabel(tempo.barLen(m))}</span>
          </span>
        </button>
      )}
      <span className="grow" />
      <MasterMixer />
    </div>
  );
}

// ---- 左の道具 ---------------------------------------------------------------------------

function ToolBtn({ on, icon, label, onClick, title }: { on?: boolean; icon: React.ReactNode; label: string; onClick: () => void; title?: string }) {
  return (
    <button className={`t-tool ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} title={title ?? label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function GridButton() {
  const div = useEditor((s) => s.view.div);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(open, ref, () => setOpen(false));
  const custom = async () => {
    setOpen(false);
    const v = await promptDialog({
      title: tr('グリッドの細かさ', 'Grid resolution'),
      body: tr('全音符をいくつに分けるか（1〜192）。5連の16分なら 20、7連なら 28、6連なら 24。', 'How many parts to divide a whole note into (1–192). 16th quintuplets: 20, septuplets: 28, sextuplets: 24.'),
      value: String(div),
      ok: tr('決定', 'OK'),
    });
    const n = Math.round(Number(v));
    if (v && n >= 1 && n <= 192) setView({ div: n });
  };
  return (
    <div className="t-tool-wrap" ref={ref}>
      <button className={`t-tool t-grid ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} title={tr('置く位置の細かさ（グリッド）', 'How finely chips snap (grid)')}>
        <b className="mono">{gridLabel(div)}</b>
        <span>{tr('グリッド', 'Grid')}</span>
      </button>
      {open && (
        <div className="t-pop t-grid-pop">
          <div className="t-pop-title">
            {tr('グリッド', 'Grid')} <span className="mono">{gridLabel(div)}</span>
          </div>
          <div className="t-grid-opts">
            {GRID_DIVS.filter((d) => [4, 8, 12, 16, 24, 32, 48].includes(d)).map((d) => (
              <button
                key={d}
                className={`t-chipbtn mono ${div === d ? 'on' : ''}`}
                onClick={() => {
                  setView({ div: d });
                  setOpen(false);
                }}
              >
                {gridLabel(d)}
              </button>
            ))}
            <button className="t-chipbtn" onClick={() => void custom()}>
              {tr('任意…', 'Custom…')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 強さ（置くベロシティ）。高さが足りなければ1つのボタンにまとめる */
function Strength({ compact }: { compact: boolean }) {
  const preset = useVel((s) => s.preset);
  const vals = useInputSettings((s) => s.velPresets);
  const names = velPresetNames();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(open, ref, () => setOpen(false));
  if (!compact) {
    return (
      <>
        {names.map((n, i) => (
          <button key={n} className={`t-tool t-vel ${preset === i ? 'on' : ''}`} onClick={() => setPreset(i as 0 | 1 | 2)} aria-pressed={preset === i} title={tr(`置く強さ: ${n}（${vals[i]}）`, `Velocity for new chips: ${n} (${vals[i]})`)}>
            <b>{n}</b>
          </button>
        ))}
      </>
    );
  }
  return (
    <div className="t-tool-wrap" ref={ref}>
      <button className="t-tool t-vel on" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={tr('置く強さ', 'Velocity for new chips')}>
        <b>{names[preset]}</b>
        <span>
          {tr('強さ', 'Velocity')} {Icon.chevronDown(10)}
        </span>
      </button>
      {open && (
        <div className="t-pop t-strength-pop">
          {names.map((n, i) => (
            <button
              key={n}
              className={`t-pop-item ${preset === i ? 'on' : ''}`}
              onClick={() => {
                setPreset(i as 0 | 1 | 2);
                setOpen(false);
              }}
            >
              <b>{n}</b>
              <span className="grow" />
              <span className="mono t-pop-sub">{vals[i]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Palette() {
  const tool = useDevice((s) => s.tool);
  const pen = useDevice((s) => s.pen);
  const flam = useFlam((s) => s.mode);
  const velMode = useVel((s) => s.mode);
  const fxOpen = useFx((s) => s.open);
  const ref = useRef<HTMLElement>(null);
  const [h, setH] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = h < 620;
  const zoomBtns = h >= 520;
  return (
    <nav className={`t-palette ${pen ? 'pen' : ''}`} ref={ref} aria-label={tr('道具', 'Tools')}>
      <ToolBtn
        on={tool === 'place'}
        icon={Icon.pencil(20)}
        label={tr('置く', 'Place')}
        onClick={() => setTool('place')}
        title={pen ? tr('置く（ペンで置く・指はスクロール）', 'Place (place with the pen; fingers scroll)') : tr('置く：タップで置く・ダブルタップで消す', 'Place: tap to place, double-tap to delete')}
      />
      <ToolBtn on={tool === 'select'} icon={Icon.selectBox(20)} label={tr('選ぶ', 'Select')} onClick={() => setTool('select')} title={tr('選ぶ：なぞって範囲・タップで足す／外す', 'Select: drag for a range, tap to add or remove')} />
      <hr />
      <GridButton />
      <ToolBtn on={flam} icon={Icon.flam(20)} label={tr('フラム', 'Flam')} onClick={() => toggleFlamMode()} title={tr('フラムで置く（同じレーンに2打をほんの少しずらして置く）', 'Place flams (two notes on the same lane, slightly apart)')} />
      <hr />
      <Strength compact={compact} />
      <ToolBtn on={velMode} icon={Icon.bars(20)} label={tr('ベロシティ', 'Velocity')} onClick={() => toggleVelMode()} title={tr('ベロシティの編集', 'Edit velocity')} />
      <ToolBtn on={fxOpen} icon={Icon.fx(20)} label={tr('エフェクト', 'Effects')} onClick={() => openFx()} title={tr('エフェクトの編集（スペクトルの列をタップで点を足す・ドラッグで動かす・長押しで消す）', 'Effect editing (tap the spectrum column to add a point, drag to move it, long-press to delete)')} />
      {zoomBtns && (
        <>
          <hr />
          <ToolBtn icon={Icon.zoomIn(20)} label={tr('拡大', 'Zoom in')} onClick={() => zoomChart(1.25)} />
          <ToolBtn icon={Icon.zoomOut(20)} label={tr('縮小', 'Zoom out')} onClick={() => zoomChart(0.8)} />
        </>
      )}
    </nav>
  );
}

// ---- 右のレールとパネル ------------------------------------------------------------------

function Rail() {
  const panel = useDevice((s) => s.panel);
  const velMode = useVel((s) => s.mode);
  const fxOpen = useFx((s) => s.open);
  const busy = velMode || fxOpen;
  return (
    <nav className="t-rail" aria-label={tr('パネル', 'Panels')}>
      {tabletPanels().map((p) => (
        <button
          key={p.id}
          className={`t-rail-btn ${panel === p.id && !busy ? 'on' : ''}`}
          onClick={() => (busy ? (toggleVelMode(false), openFx(false), useDevice.setState({ panel: p.id })) : togglePanelT(p.id))}
          aria-pressed={panel === p.id}
        >
          {panelIcon(p.id, 22)}
          <span>{p.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** 横のパネル（360）。レーンが 40 を切るほど狭いなら、譜面に重ねて出す */
function PanelHost({ overlay }: { overlay: boolean }) {
  const panel = useDevice((s) => s.panel);
  const velMode = useVel((s) => s.mode);
  const fxOpen = useFx((s) => s.open);
  if (fxOpen) {
    return (
      <aside className={`t-panel vel fx ${overlay ? 'overlay' : ''}`}>
        <div className="t-panel-head">
          <b>{tr('エフェクトの編集', 'Effect editing')}</b>
          <span className="grow" />
          <button className="t-btn" onClick={() => openFx(false)}>
            {tr('終わる', 'Done')}
          </button>
        </div>
        <div className="t-panel-body scroll">
          <FxPanel />
        </div>
      </aside>
    );
  }
  if (velMode) {
    return (
      <aside className={`t-panel vel ${overlay ? 'overlay' : ''}`}>
        <div className="t-panel-head">
          <b>{tr('ベロシティの道具', 'Velocity tools')}</b>
          <span className="grow" />
          <button className="t-btn" onClick={() => toggleVelMode(false)}>
            {tr('終わる', 'Done')}
          </button>
        </div>
        <div className="t-panel-body scroll">
          <VelocityPanel />
        </div>
      </aside>
    );
  }
  if (!panel) return null;
  const def = tabletPanels().find((p) => p.id === panel)!;
  return (
    <aside className={`t-panel p-${panel} ${overlay ? 'overlay' : ''}`} aria-label={def.title}>
      <div className="t-panel-head">
        <b>{def.title}</b>
        <span className="grow" />
        <button className="t-ib" onClick={() => togglePanelT(panel)} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
          {Icon.close(20)}
        </button>
      </div>
      <div className="t-panel-body">
        <PanelContent id={panel} where="panel" />
      </div>
    </aside>
  );
}

// ---- 下のトラック（横） -----------------------------------------------------------------

/**
 * つまみのドラッグ：指に付いて高さを変え（set）、離したら onEnd(高さ, 離す直前の速さ px/ms。+ で高くする向き)。
 * ほとんど動かさずに短く離したら onTap（開け閉め）
 */
export function useDragHeight(get: () => number, set: (h: number) => void, onEnd: (h: number, v: number) => void, onTap?: () => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const id = e.pointerId;
    const y0 = e.clientY;
    const t0 = e.timeStamp;
    const h0 = get();
    let last = h0;
    let moved = false;
    const samples: { t: number; h: number }[] = [];
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const h = h0 + (y0 - ev.clientY);
      if (!moved && Math.abs(h - h0) < 6) return;
      moved = true;
      last = h;
      samples.push({ t: ev.timeStamp, h });
      if (samples.length > 12) samples.shift();
      set(h);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      // 触ったあとに矢印キー・Space が譜面に効くように、つまみにフォーカスを残さない
      if (document.activeElement === el) el.blur();
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      // 動かさずに離した：短ければタップ（開け閉め）、長押しだけなら何もしない
      if (!moved) {
        if (ev.type === 'pointerup' && ev.timeStamp - t0 < 500) onTap?.();
        return;
      }
      // 離す直前 0.1 秒の速さ（止めてから離したら 0 に近い）
      const recent = samples.filter((p) => ev.timeStamp - p.t <= 100);
      const v = recent.length >= 2 ? (recent[recent.length - 1].h - recent[0].h) / Math.max(16, ev.timeStamp - recent[0].t) : 0;
      onEnd(last, v);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
}

/** トラックの帯の止まる高さ：閉じた帯・上の帯＋1本ずつ・全部をゆったり */
function useTrackStops(maxH: number): number[] {
  const n = useTrackCount();
  return trackStops(n, { closed: STRIP_H, ruler: TABLET_TRACK_ROW.ruler, row: TABLET_TRACK_ROW.stop, roomy: TABLET_TRACK_ROW.max, maxH });
}

function TracksT() {
  const doc = useEditor((s) => s.doc);
  const open = useDevice((s) => s.tracksOpen);
  const tracksH = useDevice((s) => s.tracksH);
  const vh = useDevice((s) => s.vh);
  const length = useSongLength(doc);
  const span = useSongSpan(doc);
  const [drag, setDrag] = useState<number | null>(null);
  const maxH = Math.max(160, vh - TOP_H - TRANSPORT_H - 220);
  const stops = useTrackStops(maxH);
  const target = open ? Math.max(stops[1] ?? STRIP_H, Math.min(tracksH, maxH)) : STRIP_H;
  const height = drag ?? target;
  const grip = useDragHeight(
    () => target,
    (h) => setDrag(Math.max(STRIP_H, Math.min(maxH, h))),
    (h, v) => {
      setDrag(null);
      // 1本ずつの高さで止める（いちばん下まで下げたら閉じる）
      const to = snapHeight(h, v, stops);
      if (to <= STRIP_H) setTracksOpen(false);
      else {
        setTracksH(to);
        setTracksOpen(true);
      }
    },
    () => setTracksOpen(!open),
  );
  // 開いた帯が譜面の高さを取る（はじいた後はなめらかに止まる）
  return (
    <div className={`t-tracks ${open || drag !== null ? 'open' : ''} ${drag !== null ? 'dragging' : ''}`} style={{ height }}>
      <div className="t-grip" onPointerDown={grip} role="separator" aria-orientation="horizontal" aria-label={tr('トラックの高さ（はじくと 1 本ずつ止まります）', 'Tracks height (flick to stop one track at a time)')} />
      <TrackPanel length={length} span={span} tablet={{ open: open || (drag !== null && drag > STRIP_H + 4), height, onToggle: () => setTracksOpen(!open) }} />
    </div>
  );
}

// ---- 下のシート（縦） ---------------------------------------------------------------------

function SheetT() {
  const tab = useDevice((s) => s.sheetTab);
  const size = useDevice((s) => s.sheetSize);
  const vh = useDevice((s) => s.vh);
  const velMode = useVel((s) => s.mode);
  const fxOpen = useFx((s) => s.open);
  const doc = useEditor((s) => s.doc);
  const length = useSongLength(doc);
  const span = useSongSpan(doc);
  const [drag, setDrag] = useState<number | null>(null);
  const maxH = Math.max(SHEET_H.tabs, vh - TOP_H - TRANSPORT_H - 160);
  const target = Math.min(maxH, SHEET_H[size]);
  const height = drag ?? target;
  const toggle = () => (size === 'tabs' ? openSheet(tab) : setSheetSize('tabs'));
  const grip = useDragHeight(
    () => target,
    (h) => setDrag(Math.max(SHEET_H.tabs, Math.min(maxH, h))),
    (h, v) => {
      setDrag(null);
      // 止まる高さ（タブだけ・細い・低い・半分・大）のいちばん近い所。はじいたらその向きの次の高さ
      setSheetSize(snapSheet(h, v, maxH));
    },
    toggle,
  );
  const tabs: { id: SheetTab; label: string }[] = [
    { id: 'pad', label: tr('パッド', 'Pads') },
    { id: 'trk', label: tr('トラック', 'Tracks') },
    ...tabletPanels()
      .filter((p) => p.id !== 'pad')
      .map((p) => ({ id: p.id as SheetTab, label: p.label })),
  ];
  const bodyH = height - SHEET_GRIP - SHEET_TABS;
  const showBody = bodyH > 40;
  return (
    <div className={`t-sheet ${drag !== null ? 'dragging' : ''}`} style={{ height }}>
      <div
        className="t-sheet-grip"
        onPointerDown={grip}
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-valuemin={SHEET_H.tabs}
        aria-valuemax={maxH}
        aria-valuenow={Math.round(height)}
        aria-label={tr('シートの高さ（ドラッグ・はじく・タップで開け閉め）', 'Sheet height (drag, flick, or tap to open and close)')}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setSheetSize(stepSheet(size, e.key === 'ArrowUp' ? 1 : -1, maxH));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <i />
      </div>
      {showBody && (
        <div className="t-sheet-body" style={{ height: bodyH }}>
          {fxOpen ? (
            <div className="t-pane t-cards scroll">
              <div className="t-panel-head inline">
                <b>{tr('エフェクトの編集', 'Effect editing')}</b>
                <span className="grow" />
                <button className="t-btn" onClick={() => openFx(false)}>
                  {tr('終わる', 'Done')}
                </button>
              </div>
              <FxPanel />
            </div>
          ) : velMode ? (
            <div className="t-pane t-cards scroll">
              <div className="t-panel-head inline">
                <b>{tr('ベロシティの道具', 'Velocity tools')}</b>
                <span className="grow" />
                <button className="t-btn" onClick={() => toggleVelMode(false)}>
                  {tr('終わる', 'Done')}
                </button>
              </div>
              <VelocityPanel />
            </div>
          ) : tab === 'trk' ? (
            <div className="t-pane t-pane-trk">
              <TrackPanel length={length} span={span} tablet={{ open: true, height: bodyH, inSheet: true }} />
            </div>
          ) : (
            <PanelContent id={tab as PanelId} where="sheet" />
          )}
        </div>
      )}
      <nav className="t-sheet-tabs" aria-label={tr('パネル', 'Panels')}>
        {tabs.map((t) => (
          <button key={t.id} className={`t-sheet-tab ${tab === t.id && size !== 'tabs' ? 'on' : ''}`} onClick={() => openSheet(t.id, true)} aria-pressed={tab === t.id && size !== 'tabs'}>
            {panelIcon(t.id, 20)}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---- ☰ のメニュー -----------------------------------------------------------------------

export function Drawer({ folderInput }: { folderInput: React.RefObject<HTMLInputElement | null> }) {
  const open = useDevice((s) => s.drawer);
  const menus = useEditorMenus(folderInput, true);
  const [tab, setTab] = useState(0);
  // 開くたびに項目の ✓ や「元に戻す（…）」を今の状態で作り直す
  useEditor((s) => s.selection.length);
  useDevice((s) => s.panel);
  if (!open) return null;
  const close = () => setDrawer(false);
  const items = menus[Math.min(tab, menus.length - 1)].items();
  return (
    <div className="t-drawer-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="t-drawer" role="dialog" aria-label={tr('メニュー', 'Menu')}>
        <div className="t-drawer-head">
          <span className="logo-mark">D</span>
          <b>DTX Web Editor</b>
          <span className="grow" />
          <button className="t-ib" onClick={close} aria-label={tr('閉じる', 'Close')}>
            {Icon.close(20)}
          </button>
        </div>
        <div className="seg t-seg t-drawer-tabs" role="tablist">
          {menus.map((m, i) => (
            <button key={m.label} role="tab" aria-selected={i === tab} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="t-drawer-list scroll">
          {items.map((it, i) =>
            it === '-' ? (
              <hr key={`sep-${i}`} />
            ) : (
              <button
                key={`${it.label}-${i}`}
                className="t-menu-item"
                disabled={it.disabled}
                onClick={() => {
                  close();
                  it.run();
                }}
              >
                <span className="t-ck">{it.checked ? Icon.check(16) : null}</span>
                <span className="t-menu-label">{it.label}</span>
                {it.key && <span className="t-menu-key mono">{it.key}</span>}
              </button>
            ),
          )}
        </div>
        <div className="t-drawer-foot">{tr('右の文字はキーボード（Magic Keyboard など）のショートカット', 'The text on the right is the keyboard shortcut (Magic Keyboard, etc.)')}</div>
      </aside>
    </div>
  );
}

// ---- 全体 -------------------------------------------------------------------------------

/** 横でパネルを開いたら、譜面のレーンが 40 を切るか（切るならパネルを譜面に重ねる） */
/** パネルを横に並べるとレーンが 40 を切るなら、パネルを譜面に重ねて出す（デザインの決まり） */
function panelOverlays(vw: number): boolean {
  return tabletLaneW(vw - 68 - 360 - 76) < 40;
}

export function TabletEditor({ folderInput }: { folderInput: React.RefObject<HTMLInputElement | null> }) {
  const portrait = useDevice((s) => s.portrait);
  const vw = useDevice((s) => s.vw);
  const panel = useDevice((s) => s.panel);
  const velMode = useVel((s) => s.mode);
  const fxOpen = useFx((s) => s.open);
  const findOpen = useFind((s) => s.open);
  const phraseOpen = usePhrase((s) => s.open);
  const previewMode = usePreview((s) => s.mode);
  // レーンの幅を変えるもの（音声の列・強さの列・BGA の列）が変わったら決め直す
  useAssist((s) => s.audioCols);
  useVel((s) => s.lanes.length);
  useBga((s) => `${s.show}|${s.wide}`);
  useEditor((s) => hasBga(s.doc));
  // エフェクトの編集はパネルを重ねない（重ねるとカーブの列が隠れる。レーンを細くして、列とパネルを並べる）
  const overlay = !portrait && !fxOpen && (panel !== null || velMode) && panelOverlays(vw);
  // タブレットのプレビューはパネル（横）・シート（縦）に出すので、デスクトップの右のパネルのプレビューは使わない
  useEffect(() => {
    if (usePreview.getState().mode === 'side') usePreview.setState({ mode: 'off' });
  }, []);
  return (
    <div className={`t-editor ${portrait ? 'port' : 'land'}`}>
      <TopBarT />
      <TransportT />
      <div className="t-main">
        <Palette />
        <section className="chart-area t-chart">
          <ChartCanvas />
          <SelectionBar />
          {findOpen && <FindPanel />}
          {phraseOpen && !findOpen && <PhrasePanel />}
        </section>
        {!portrait && <PanelHost overlay={overlay} />}
        {!portrait && <Rail />}
      </div>
      {!portrait && <TracksT />}
      {portrait && <SheetT />}
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
