// タブレット（指で使う端末）の判定と、タブレット版の画面の状態・設定。
// - 指で使う端末（pointer: coarse、または iPad）ならタブレット版にする。設定で「タブレット・デスクトップ」に固定できる
// - 横（幅 1024 以上）はパネルを右のレールから1枚だけ開き、下にトラックの帯。縦（幅 1024 未満）はパネルを下のシートに
// - 高さは visualViewport で測り直す（Safari のバー・ホーム画面に追加したときの全画面）
import { create } from 'zustand';
import { IS_IOS } from '../platform';
import { setView, useEditor } from './editor';
import { isOpenSheetSize, type OpenSheetSize, type SheetSize } from './sheetSnap';

export { IS_IOS };

export type { OpenSheetSize, SheetSize } from './sheetSnap';

export type UiMode = 'auto' | 'tablet' | 'desktop';
/** 横の右のレールから開くパネル（縦は下のシートのタブ） */
export type PanelId = 'pad' | 'snd' | 'src' | 'asst' | 'chk' | 'prev';
/** 縦のシートのタブ（パネル＋トラック） */
export type SheetTab = PanelId | 'trk';
/** 譜面の道具：置く・選ぶ */
export type Tool = 'place' | 'select';
/** 入力パッドの並び：キット（4×3）・レーン（譜面の下にレーンと同じ幅） */
export type PadLayout = 'kit' | 'lane';
/** 「置く」のとき、1本指でなぞったら：スクロール（既定）・範囲選択。2本指ならいつでもスクロール */
export type OneFinger = 'scroll' | 'select';
/** 文字とボタンの大きさ */
export type UiScale = 'normal' | 'large';
/** パネルとレールの位置（左手で操作するなら左） */
export type PanelSide = 'right' | 'left';

export interface TouchPrefs {
  uiMode: UiMode;
  uiScale: UiScale;
  panelSide: PanelSide;
  oneFinger: OneFinger;
  /** 長押しでメニューを出すまでの時間（ミリ秒） */
  longPressMs: number;
  /** 2本指タップで元に戻す・3本指タップでやり直す */
  tapUndo: boolean;
  /** チップをダブルタップで消す */
  dblTapDelete: boolean;
  /** Apple Pencil を使ったら「ペンで書く」にする（ペンで置く・選ぶ、指はスクロールとピンチだけ） */
  penAuto: boolean;
  /** パッドの遅れの補正（ミリ秒）。録音でパッドを叩いた位置からこの分を引く（キーボード・電子ドラムとは別） */
  padLatencyMs: number;
  padLayout: PadLayout;
  /** キットの並び（12 個。"レーン:0|1"、1 は Shift で置く物）。設定でタップして入れ替える */
  kitOrder: string[];
  /** パッドを最初に開いたときの入れ方（試し打ち・ステップ・録音） */
  padStart: 'aud' | 'step' | 'rec';
  /** ステップ：置いたら ▶ を1グリッド進める */
  stepAdvance: boolean;
  /** ステップ：同時に押したパッドは同じ位置に置き、指を全部離したら進む */
  stepChord: boolean;
  /** 録音の前に1小節クリック（カウントイン） */
  countIn: boolean;
  /** 録音：ループ中は周ごとに重ねて録る（オフなら1周だけ録る） */
  recOverdub: boolean;
  /** 横のトラックを開いたときの高さ */
  tracksH: number;
  /** 縦のシート：タブごとに、最後に開いていた高さ（無ければ「半分」） */
  sheetSizes: Partial<Record<SheetTab, OpenSheetSize>>;
}

/** キットの並びの初め：上段シンバル、中段は手、下段は足とフロアタム */
export const KIT_DEFAULT: readonly string[] = ['0:0', '1:1', '8:0', '9:0', '1:0', '3:0', '4:0', '6:0', '2:0', '2:1', '5:0', '7:0'];

function validKit(v: unknown): string[] {
  if (!Array.isArray(v) || v.length !== KIT_DEFAULT.length) return [...KIT_DEFAULT];
  const a = v.map(String);
  const want = new Set(KIT_DEFAULT);
  return a.every((x) => want.has(x)) && new Set(a).size === a.length ? a : [...KIT_DEFAULT];
}

export interface DeviceState extends TouchPrefs {
  /** 指で使う端末か（pointer: coarse・iPad） */
  touchDevice: boolean;
  /** タブレット版の画面を出しているか */
  tablet: boolean;
  /** 縦（幅 1024 未満）：パネルは下のシート */
  portrait: boolean;
  vw: number;
  vh: number;
  /** ペンで書く（Apple Pencil を使った） */
  pen: boolean;
  tool: Tool;
  /** 横：開いているパネル（1枚だけ） */
  panel: PanelId | null;
  /** 縦：シートのタブと高さ */
  sheetTab: SheetTab;
  sheetSize: SheetSize;
  /** 横：下のトラックを開いているか */
  tracksOpen: boolean;
  /** ☰ のメニュー */
  drawer: boolean;
}

const KEY = 'dtxe.touch.v1';

/** 曲フォルダを選べない（iPad の Safari はフォルダを選べず、フォルダへ直接書き込めない） */
export const NO_FOLDER_PICK = IS_IOS;
/** 電子ドラム（Web MIDI）が使えない */
export const NO_MIDI = typeof navigator !== 'undefined' && !('requestMIDIAccess' in navigator);
/** タブの音を取り込めない（YouTube の自動同期） */
export const NO_TAB_AUDIO = typeof navigator !== 'undefined' && (IS_IOS || !navigator.mediaDevices || !('getDisplayMedia' in navigator.mediaDevices));

const coarseQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;

function isTouchDevice(): boolean {
  return !!coarseQuery?.matches || IS_IOS;
}

const PREF_DEFAULT: TouchPrefs = {
  uiMode: 'auto',
  uiScale: 'normal',
  panelSide: 'right',
  oneFinger: 'scroll',
  longPressMs: 350,
  tapUndo: true,
  dblTapDelete: true,
  penAuto: true,
  padLatencyMs: 24,
  padLayout: 'kit',
  kitOrder: [...KIT_DEFAULT],
  padStart: 'aud',
  stepAdvance: true,
  stepChord: true,
  countIn: true,
  recOverdub: true,
  tracksH: 274,
  sheetSizes: {},
};

const SHEET_TABS: readonly SheetTab[] = ['pad', 'trk', 'snd', 'src', 'asst', 'chk', 'prev'];

function validSheetSizes(v: unknown): Partial<Record<SheetTab, OpenSheetSize>> {
  const out: Partial<Record<SheetTab, OpenSheetSize>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const t of SHEET_TABS) {
    const x = (v as Record<string, unknown>)[t];
    if (isOpenSheetSize(x)) out[t] = x;
  }
  return out;
}

function loadPrefs(): TouchPrefs {
  let saved: Partial<TouchPrefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<TouchPrefs>;
  } catch {
    saved = {};
  }
  const p = { ...PREF_DEFAULT, ...saved };
  return {
    uiMode: p.uiMode === 'tablet' || p.uiMode === 'desktop' ? p.uiMode : 'auto',
    uiScale: p.uiScale === 'large' ? 'large' : 'normal',
    panelSide: p.panelSide === 'left' ? 'left' : 'right',
    oneFinger: p.oneFinger === 'select' ? 'select' : 'scroll',
    longPressMs: Number.isFinite(Number(p.longPressMs)) ? Math.max(200, Math.min(800, Math.round(Number(p.longPressMs)))) : PREF_DEFAULT.longPressMs,
    tapUndo: p.tapUndo !== false,
    dblTapDelete: p.dblTapDelete !== false,
    penAuto: p.penAuto !== false,
    padLatencyMs: Number.isFinite(Number(p.padLatencyMs)) ? Math.max(0, Math.min(300, Math.round(Number(p.padLatencyMs)))) : PREF_DEFAULT.padLatencyMs,
    padLayout: p.padLayout === 'lane' ? 'lane' : 'kit',
    kitOrder: validKit(p.kitOrder),
    padStart: p.padStart === 'step' || p.padStart === 'rec' ? p.padStart : 'aud',
    stepAdvance: p.stepAdvance !== false,
    stepChord: p.stepChord !== false,
    countIn: p.countIn !== false,
    recOverdub: p.recOverdub !== false,
    tracksH: Math.max(80, Math.min(600, Number(p.tracksH) || PREF_DEFAULT.tracksH)),
    sheetSizes: validSheetSizes(p.sheetSizes),
  };
}

function viewportSize(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: 1280, vh: 800 };
  const vv = window.visualViewport;
  return { vw: Math.round(vv?.width ?? window.innerWidth), vh: Math.round(vv?.height ?? window.innerHeight) };
}

function effective(mode: UiMode, touch: boolean): boolean {
  return mode === 'tablet' || (mode === 'auto' && touch);
}

const prefs = loadPrefs();
const size = viewportSize();
const touch0 = isTouchDevice();

export const useDevice = create<DeviceState>(() => ({
  ...prefs,
  touchDevice: touch0,
  tablet: effective(prefs.uiMode, touch0),
  portrait: size.vw < 1024,
  vw: size.vw,
  vh: size.vh,
  pen: false,
  tool: 'place',
  panel: null,
  sheetTab: 'pad',
  sheetSize: 'tabs',
  tracksOpen: false,
  drawer: false,
}));

function savePrefs() {
  const s = useDevice.getState();
  const p: TouchPrefs = {
    uiMode: s.uiMode,
    uiScale: s.uiScale,
    panelSide: s.panelSide,
    oneFinger: s.oneFinger,
    longPressMs: s.longPressMs,
    tapUndo: s.tapUndo,
    dblTapDelete: s.dblTapDelete,
    penAuto: s.penAuto,
    padLatencyMs: s.padLatencyMs,
    padLayout: s.padLayout,
    kitOrder: s.kitOrder,
    padStart: s.padStart,
    stepAdvance: s.stepAdvance,
    stepChord: s.stepChord,
    countIn: s.countIn,
    recOverdub: s.recOverdub,
    tracksH: s.tracksH,
    sheetSizes: s.sheetSizes,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 覚えられなくても動く
  }
}

export function setTouchPrefs(p: Partial<TouchPrefs>) {
  const s = useDevice.getState();
  const next = { ...p };
  if (p.uiMode !== undefined) Object.assign(next, { tablet: effective(p.uiMode, s.touchDevice) });
  useDevice.setState(next);
  savePrefs();
}

export const isTablet = () => useDevice.getState().tablet;

export function setTool(tool: Tool) {
  useDevice.setState({ tool });
}

/** 横のパネルを開く（同じボタンをもう一度押すと閉じる）。縦ならシートのそのタブを開く */
export function togglePanelT(id: PanelId) {
  const s = useDevice.getState();
  if (s.portrait) {
    openSheet(id);
    return;
  }
  useDevice.setState({ panel: s.panel === id ? null : id });
}

export function openPanelT(id: PanelId) {
  const s = useDevice.getState();
  if (s.portrait) openSheet(id);
  else useDevice.setState({ panel: id });
}

/** タブを開くときの高さ：そのタブで最後に開いていた高さ（初めては「半分」） */
export function sheetSizeOf(tab: SheetTab): OpenSheetSize {
  return useDevice.getState().sheetSizes[tab] ?? 'half';
}

/**
 * 縦のシートのタブを開く（そのタブで最後に開いていた高さで。開いているタブをもう一度押すとタブだけに）
 */
export function openSheet(tab: SheetTab, toggle = false) {
  const s = useDevice.getState();
  if (toggle && s.sheetTab === tab && s.sheetSize !== 'tabs') {
    useDevice.setState({ sheetSize: 'tabs' });
    return;
  }
  useDevice.setState({ sheetTab: tab, sheetSize: sheetSizeOf(tab) });
}

/** シートの高さを変える。開いた高さは今のタブの高さとして覚える（次にそのタブを開くとこの高さ） */
export function setSheetSize(sheetSize: SheetSize) {
  const s = useDevice.getState();
  if (sheetSize === 'tabs' || s.sheetSizes[s.sheetTab] === sheetSize) {
    useDevice.setState({ sheetSize });
    return;
  }
  useDevice.setState({ sheetSize, sheetSizes: { ...s.sheetSizes, [s.sheetTab]: sheetSize } });
  savePrefs();
}

export function setTracksOpen(open: boolean) {
  useDevice.setState({ tracksOpen: open });
}

export function setTracksH(h: number) {
  useDevice.setState({ tracksH: Math.max(80, Math.min(600, Math.round(h))) });
  savePrefs();
}

export function setDrawer(open: boolean) {
  useDevice.setState({ drawer: open });
}

/** Apple Pencil を使った：「ペンで書く」にする（設定でオフなら何もしない）。初めてなら true */
export function penUsed(): boolean {
  const s = useDevice.getState();
  if (s.pen || !s.penAuto) return false;
  useDevice.setState({ pen: true });
  return true;
}

export function setPenMode(pen: boolean) {
  useDevice.setState({ pen });
}

// ---- 画面の大きさ・html の印 -----------------------------------------------------------

/** タブレット版の既定の拡大（1拍 88px。細かいグリッドでも 16分の間が 22px 取れる） */
export const TABLET_PX_PER_BEAT = 88;
const DESKTOP_PX_PER_BEAT = 48;

function applyHtml() {
  if (typeof document === 'undefined') return;
  const s = useDevice.getState();
  const root = document.documentElement;
  root.classList.toggle('tablet', s.tablet);
  root.classList.toggle('tablet-port', s.tablet && s.portrait);
  root.classList.toggle('tablet-land', s.tablet && !s.portrait);
  root.classList.toggle('pen-mode', s.tablet && s.pen);
  root.classList.toggle('t-large', s.tablet && s.uiScale === 'large');
  root.classList.toggle('t-left', s.tablet && s.panelSide === 'left');
  root.style.setProperty('--app-h', `${s.vh}px`);
}

let lastTablet: boolean | null = null;
function onTabletChange() {
  const s = useDevice.getState();
  if (lastTablet === s.tablet) return;
  const first = lastTablet === null;
  lastTablet = s.tablet;
  const px = useEditor.getState().view.pxPerBeat;
  // タブレット版は指で置けるように広げる（デスクトップに戻したら、広げたままなら戻す）
  if (s.tablet && px < TABLET_PX_PER_BEAT) setView({ pxPerBeat: TABLET_PX_PER_BEAT });
  else if (!s.tablet && !first && px === TABLET_PX_PER_BEAT) setView({ pxPerBeat: DESKTOP_PX_PER_BEAT });
}

if (typeof window !== 'undefined') {
  const onResize = () => {
    const sz = viewportSize();
    const s = useDevice.getState();
    const touchDevice = isTouchDevice();
    if (sz.vw === s.vw && sz.vh === s.vh && touchDevice === s.touchDevice) return;
    useDevice.setState({ ...sz, portrait: sz.vw < 1024, touchDevice, tablet: effective(s.uiMode, touchDevice) });
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  coarseQuery?.addEventListener?.('change', onResize);
  useDevice.subscribe(() => {
    applyHtml();
    onTabletChange();
  });
  applyHtml();
  onTabletChange();
  // iPad の Safari：譜面の外のピンチでページが拡大されないように（譜面のピンチは自前で受ける）
  document.addEventListener(
    'gesturestart',
    (e) => {
      if (useDevice.getState().tablet) e.preventDefault();
    },
    { passive: false },
  );
}
