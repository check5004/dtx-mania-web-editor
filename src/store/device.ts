// タブレット（指で使う端末）の判定と、タブレット版の画面の状態・設定。
// - 指で使う端末（pointer: coarse、または iPad）ならタブレット版にする。設定で「タブレット・デスクトップ」に固定できる
// - 横（幅 1024 以上）はパネルを右のレールから1枚だけ開き、下にトラックの帯。縦（幅 1024 未満）はパネルを下のシートに
// - 高さは visualViewport で測り直す（Safari のバー・ホーム画面に追加したときの全画面）
// - スマホ：指で使う端末で、画面の短い辺が 600 より狭い（html.phone）。タブレット版の決まり（tablet）の上に、スマホの画面を出す。
//   縦はタブで下のシート（低い 270・高い 520）、横は右から重ねるパネル。どちらも同じタブを開いたまま回せる
import { create } from 'zustand';
import { IS_IOS } from '../platform';
import { setView, useEditor } from './editor';
import { usePreview } from './preview';
import { isOpenSheetSize, type OpenSheetSize, type SheetSize } from './sheetSnap';

export { IS_IOS };
export { iosName } from '../platform';

export type { OpenSheetSize, SheetSize } from './sheetSnap';

export type UiMode = 'auto' | 'tablet' | 'desktop' | 'phone';
/** スマホの下のタブ（縦は下のシート、横は右から重ねるパネル） */
export type PhoneTab = 'pad' | 'trk' | 'snd' | 'src' | 'asst' | 'chk';
/** スマホで置くとき：吹き出しで確かめてから離して置く（既定）・触れたらすぐ置く（タブレットと同じ） */
export type PlaceMode = 'bubble' | 'instant';
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
  /** スマホ：レーンを触ったら吹き出しを出し、離して置く（instant ならタブレットと同じくすぐ置く） */
  placeMode: PlaceMode;
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
  /** タブレット版の画面を出しているか（スマホも true。スマホの画面は phone） */
  tablet: boolean;
  /** スマホの画面を出しているか */
  phone: boolean;
  /** スマホの大きさの画面か（指で使う端末で、短い辺が 600 未満） */
  phoneScreen: boolean;
  /** 縦（タブレットは幅 1024 未満、スマホは縦長）：パネルは下のシート */
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
  /** スマホ：開いている下のタブ（縦はシート、横は重ねるパネル）。無ければ閉じている */
  pTab: PhoneTab | null;
  /** スマホ：縦のシートを高く（520）しているか（低いは 270） */
  pHigh: boolean;
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

/** スマホの大きさか：画面の短い辺が 600 未満（キーボードで見える高さが縮んでも変わらないように、画面の大きさで見る） */
const PHONE_SHORT_SIDE = 600;

function isPhoneScreen(touch: boolean): boolean {
  if (!touch || typeof window === 'undefined' || !window.screen) return false;
  const w = window.screen.width;
  const h = window.screen.height;
  return w > 0 && h > 0 && Math.min(w, h) < PHONE_SHORT_SIDE;
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
  placeMode: 'bubble',
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
    uiMode: p.uiMode === 'tablet' || p.uiMode === 'desktop' || p.uiMode === 'phone' ? p.uiMode : 'auto',
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
    placeMode: p.placeMode === 'instant' ? 'instant' : 'bubble',
  };
}

function viewportSize(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: 1280, vh: 800 };
  const vv = window.visualViewport;
  return { vw: Math.round(vv?.width ?? window.innerWidth), vh: Math.round(vv?.height ?? window.innerHeight) };
}

function effective(mode: UiMode, touch: boolean): boolean {
  return mode === 'tablet' || mode === 'phone' || (mode === 'auto' && touch);
}

function effectivePhone(mode: UiMode, phoneScreen: boolean): boolean {
  return mode === 'phone' || (mode === 'auto' && phoneScreen);
}

/** 縦か：スマホは縦長なら、タブレットは幅 1024 未満なら */
function isPortrait(phone: boolean, vw: number, vh: number): boolean {
  return phone ? vh >= vw : vw < 1024;
}

const prefs = loadPrefs();
const size = viewportSize();
const touch0 = isTouchDevice();
const phoneScreen0 = isPhoneScreen(touch0);
const phone0 = effectivePhone(prefs.uiMode, phoneScreen0);

export const useDevice = create<DeviceState>(() => ({
  ...prefs,
  touchDevice: touch0,
  tablet: effective(prefs.uiMode, touch0),
  phone: phone0,
  phoneScreen: phoneScreen0,
  portrait: isPortrait(phone0, size.vw, size.vh),
  vw: size.vw,
  vh: size.vh,
  pen: false,
  tool: 'place',
  panel: null,
  sheetTab: 'pad',
  sheetSize: 'tabs',
  tracksOpen: false,
  drawer: false,
  pTab: null,
  pHigh: false,
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
    placeMode: s.placeMode,
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
  if (p.uiMode !== undefined) {
    const phone = effectivePhone(p.uiMode, s.phoneScreen);
    Object.assign(next, { tablet: effective(p.uiMode, s.touchDevice), phone, portrait: isPortrait(phone, s.vw, s.vh) });
  }
  useDevice.setState(next);
  savePrefs();
}

export const isTablet = () => useDevice.getState().tablet;
export const isPhone = () => useDevice.getState().phone;

export function setTool(tool: Tool) {
  useDevice.setState({ tool });
}

/** 横のパネルを開く（同じボタンをもう一度押すと閉じる）。縦ならシートのそのタブを開く。スマホは下のタブ（プレビューは全画面） */
export function togglePanelT(id: PanelId) {
  const s = useDevice.getState();
  if (s.phone) {
    if (id === 'prev') usePreview.setState({ mode: 'full' });
    else openPhoneTab(id, true);
    return;
  }
  if (s.portrait) {
    openSheet(id);
    return;
  }
  useDevice.setState({ panel: s.panel === id ? null : id });
}

export function openPanelT(id: PanelId) {
  const s = useDevice.getState();
  if (s.phone) {
    if (id === 'prev') usePreview.setState({ mode: 'full' });
    else openPhoneTab(id);
    return;
  }
  if (s.portrait) openSheet(id);
  else useDevice.setState({ panel: id });
}

/**
 * スマホの下のタブを開く（縦は低いシート 270、横は右から重ねるパネル）。toggle なら、開いているタブをもう一度押すと閉じる。
 * パッドは譜面を見ながら叩くので、いつも低いシート
 */
export function openPhoneTab(tab: PhoneTab, toggle = false) {
  const s = useDevice.getState();
  if (toggle && s.pTab === tab) {
    useDevice.setState({ pTab: null, pHigh: false });
    return;
  }
  useDevice.setState({ pTab: tab, pHigh: tab === 'pad' ? false : s.pTab === tab ? s.pHigh : false });
}

export function closePhoneTab() {
  useDevice.setState({ pTab: null, pHigh: false });
}

/** スマホの縦のシートを高く（520）・低く（270） */
export function setPhoneHigh(high: boolean) {
  useDevice.setState({ pHigh: high });
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
  // スマホのほかの画面（曲情報・ステム・AI難易度生成など）は、横でも1列に並べる（タブレットの縦と同じ）
  root.classList.toggle('tablet-port', s.tablet && (s.portrait || s.phone));
  root.classList.toggle('tablet-land', s.tablet && !s.portrait && !s.phone);
  root.classList.toggle('phone', s.phone);
  root.classList.toggle('phone-port', s.phone && s.portrait);
  root.classList.toggle('phone-land', s.phone && !s.portrait);
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

/** キーボード（iPhone は選ぶ欄の回転も）が出る欄か */
const NO_KEYBOARD = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color', 'image', 'hidden']);
export function opensKeyboard(el: Element | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && !NO_KEYBOARD.has(el.type);
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLSelectElement) return !el.disabled;
  return el.isContentEditable;
}

/**
 * 指の端末で文字を打っている間の画面の高さ（0 は打っていない）。
 * キーボードが出ると見える高さ（visualViewport）が縮むが、画面（--app-h）まで縮めると、横向きのスマホでは上の帯だけで
 * 埋まって入力欄が見えなくなる。打っている間は打ち始めの高さのままにして、入力欄の所まではブラウザにずらしてもらう
 */
let typingVh = 0;

if (typeof window !== 'undefined') {
  const onResize = () => {
    const sz = viewportSize();
    const s = useDevice.getState();
    const touchDevice = isTouchDevice();
    const phoneScreen = isPhoneScreen(touchDevice);
    if (typingVh && s.tablet) {
      // キーボードで縮んだだけ（幅は同じ）なら、高さは打ち始めのまま。打ちながら回したら、キーボードの分を含まない高さ（innerHeight）
      if (sz.vw === s.vw) sz.vh = Math.max(sz.vh, typingVh);
      else typingVh = sz.vh = Math.max(sz.vh, Math.round(window.innerHeight));
    } else if (s.tablet && (window.scrollX || window.scrollY)) {
      // キーボードを閉じたあとにページがずれたまま残ったら戻す（この画面はページ全体をスクロールしない）
      window.scrollTo(0, 0);
    }
    if (sz.vw === s.vw && sz.vh === s.vh && touchDevice === s.touchDevice && phoneScreen === s.phoneScreen) return;
    const phone = effectivePhone(s.uiMode, phoneScreen);
    let portrait = isPortrait(phone, sz.vw, sz.vh);
    // スマホ：入力欄のキーボードで見える高さが縮んでも、横向きにはしない（画面の向きで決める）
    if (phone && s.phone && s.portrait && !portrait && sz.vw === s.vw && window.screen && window.screen.height >= window.screen.width) portrait = true;
    useDevice.setState({ ...sz, portrait, touchDevice, phoneScreen, phone, tablet: effective(s.uiMode, touchDevice) });
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  coarseQuery?.addEventListener?.('change', onResize);
  // 文字を打ち始めた・やめた（欄から欄へ移るあいだはキーボードが出たまま）
  document.addEventListener('focusin', (e) => {
    const s = useDevice.getState();
    if (s.tablet && !typingVh && opensKeyboard(e.target as Element)) typingVh = s.vh;
  });
  document.addEventListener('focusout', () => {
    if (!typingVh) return;
    window.setTimeout(() => {
      if (opensKeyboard(document.activeElement)) return;
      typingVh = 0;
      // キーボードが閉じきったら、見える高さに合わせ直す（閉じるときの visualViewport の resize でも合わせる）
      window.setTimeout(onResize, 350);
    }, 0);
  });
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
