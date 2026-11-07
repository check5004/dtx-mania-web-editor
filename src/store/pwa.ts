// アプリ（PWA）として使うための状態：Service Worker（オフラインで開ける・新しい版の知らせ）、インストール、ホーム画面で開いているか。
// - Service Worker は本番のビルドだけ（開発サーバーでは入れない）。中身は src/pwa/sw.ts、決めごとは src/pwa/swCore.ts
// - 画面はネット優先で読むので、つながっていれば開くたびに最新の版になる。開いたままのときは 30 分ごと・画面に戻ったとき・
//   ネットにつながったときに新しい版を確かめ、あれば知らせる（UpdateNotice）。読み込み直すかは使う人が決める
// - インストール：Chrome・Edge は beforeinstallprompt を受け取ってボタンから出す。iPad・iPhone は「共有 › ホーム画面に追加」の案内だけ
import { create } from 'zustand';
import { tr } from '../i18n';
import { isStandalone, onDisplayModeChange } from '../pwa/display';
import { isNewerBuild } from '../pwa/swCore';
import { isDirty, toast, useEditor } from './editor';
import { confirmDialog } from '../ui/dialogs';
import { autosaveNow } from '../app/fileActions';

/** package.json の版（ビルドで埋め込む） */
export const APP_VERSION: string = typeof __DTXE_VERSION__ !== 'undefined' ? __DTXE_VERSION__ : 'dev';
/** ビルドした時刻（ミリ秒）。sw.js と同じ値で、どちらが新しいかを比べる */
export const BUILD_TIME: number = typeof __DTXE_BUILD_TIME__ !== 'undefined' ? __DTXE_BUILD_TIME__ : 0;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Service Worker の様子 */
export type SwStatus = 'unsupported' | 'dev' | 'installing' | 'ready' | 'error';
export type CheckResult = 'latest' | 'updated' | 'offline' | 'unsupported';

export interface PwaState {
  sw: SwStatus;
  /** オフライン用にこの端末へ入れた大きさ（バイト） */
  offlineBytes: number;
  /** ホーム画面・アプリの窓で開いている */
  standalone: boolean;
  /** インストールを申し出られる（Chrome・Edge が beforeinstallprompt をくれた） */
  canInstall: boolean;
  /** 読み込み直すと使える新しい版 */
  update: { version: string; build: number } | null;
  /** 新しい版の知らせを閉じた（設定の「アプリとして使う」には出し続ける） */
  updateDismissed: boolean;
  checking: boolean;
  lastCheck: number;
  checkResult: CheckResult | null;
  /** ホームの「アプリとして使う」案内を閉じた（閉じたら出さない） */
  hintClosed: boolean;
}

const HINT_CLOSED_KEY = 'dtxe.pwa.installHint.closed';

function readHintClosed(): boolean {
  try {
    return localStorage.getItem(HINT_CLOSED_KEY) === '1';
  } catch {
    return false;
  }
}

export const usePwa = create<PwaState>(() => ({
  sw: 'unsupported',
  offlineBytes: 0,
  standalone: false,
  canInstall: false,
  update: null,
  updateDismissed: false,
  checking: false,
  lastCheck: 0,
  checkResult: null,
  hintClosed: typeof window !== 'undefined' && readHintClosed(),
}));

const get = usePwa.getState;
const set = usePwa.setState;

/** 開いたままのときに新しい版を確かめる間隔 */
const CHECK_EVERY_MS = 30 * 60_000;
/** 画面に戻ったときは、前に確かめてからこれだけ経っていたら確かめる */
const CHECK_ON_SHOW_MS = 10 * 60_000;
const OFFLINE_READY_KEY = 'dtxe.pwa.offlineReady';

let reg: ServiceWorkerRegistration | null = null;
let deferred: BeforeInstallPromptEvent | null = null;
let started = false;

interface BuildInfo {
  version: string;
  build: number;
  bytes?: number;
}

function isBuildInfo(v: unknown): v is BuildInfo & { type: string } {
  const d = v as Partial<BuildInfo & { type: string }> | null;
  return !!d && typeof d.type === 'string' && d.type.startsWith('dtxe-sw-') && typeof d.version === 'string' && typeof d.build === 'number';
}

/** Service Worker が知らせてきた版を見て、新しければ知らせを出す */
function takeBuild(d: BuildInfo) {
  const patch: Partial<PwaState> = { sw: 'ready' };
  if (typeof d.bytes === 'number') patch.offlineBytes = d.bytes;
  if (isNewerBuild(d.build, BUILD_TIME)) {
    const prev = get().update;
    if (!prev || prev.build < d.build) {
      patch.update = { version: d.version, build: d.build };
      patch.updateDismissed = false;
    }
  }
  set(patch);
}

/** いま受け持っている Service Worker に版を聞く（返事が無ければ null） */
function askBuild(timeoutMs = 3000): Promise<BuildInfo | null> {
  const ctrl = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!ctrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = window.setTimeout(() => {
      ch.port1.close();
      resolve(null);
    }, timeoutMs);
    ch.port1.onmessage = (e) => {
      window.clearTimeout(timer);
      ch.port1.close();
      if (isBuildInfo(e.data)) {
        takeBuild(e.data);
        resolve(e.data);
      } else resolve(null);
    };
    ctrl.postMessage({ type: 'dtxe-sw-build' }, [ch.port2]);
  });
}

function offlineReadyOnce() {
  try {
    if (localStorage.getItem(OFFLINE_READY_KEY) === '1') return;
    localStorage.setItem(OFFLINE_READY_KEY, '1');
  } catch {
    return;
  }
  toast(
    tr(
      'オフラインでも開けるようになりました（AI・曲情報の検索・YouTube はネットが要ります）',
      'The editor now opens offline too (AI, song info lookup and YouTube still need the internet)',
    ),
    'ok',
    6000,
  );
}

function untilSettled(w: ServiceWorker, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timer);
      w.removeEventListener('statechange', onChange);
      resolve();
    }
    function onChange() {
      if (w.state === 'activated' || w.state === 'redundant') done();
    }
    w.addEventListener('statechange', onChange);
    onChange();
  });
}

/** 新しい版があるか確かめる。あれば入れて（すぐ使えるようにして）、知らせを出す */
export async function checkForUpdate(): Promise<CheckResult> {
  if (!reg) {
    set({ checkResult: 'unsupported' });
    return 'unsupported';
  }
  set({ checking: true, lastCheck: Date.now() });
  let result: CheckResult;
  try {
    await reg.update();
    const w = reg.installing ?? reg.waiting;
    if (w) await untilSettled(w);
    await askBuild();
    result = get().update ? 'updated' : 'latest';
  } catch {
    result = 'offline';
  }
  set({ checking: false, checkResult: result });
  return result;
}

async function register() {
  const base = import.meta.env.BASE_URL;
  try {
    reg = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base, updateViaCache: 'none' });
  } catch {
    set({ sw: 'error' });
    return;
  }
  if (navigator.serviceWorker.controller) {
    set({ sw: 'ready' });
    void askBuild();
  } else set({ sw: 'installing' });
  set({ lastCheck: Date.now() });
  window.setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - get().lastCheck > CHECK_ON_SHOW_MS) void checkForUpdate();
  });
  window.addEventListener('online', () => void checkForUpdate());
}

/** 起動時に1回呼ぶ（main.tsx） */
export function initPwa() {
  if (started || typeof window === 'undefined') return;
  started = true;
  set({ standalone: isStandalone() });
  onDisplayModeChange((standalone) => set({ standalone }));
  window.addEventListener('beforeinstallprompt', (e) => {
    // ブラウザの自動の案内は出さず、ホームと設定のボタンから出す（Chrome はアドレスバーのボタンもそのまま出る）
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canInstall: false });
    toast(
      tr(
        'アプリとしてインストールしました。次からはアプリの一覧やデスクトップのアイコンから開けます',
        'Installed as an app. Next time, open it from your apps or the desktop icon',
      ),
      'ok',
      7000,
    );
  });

  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) {
    set({ sw: 'dev' });
    return;
  }
  const sc = navigator.serviceWorker;
  const hadController = !!sc.controller;
  sc.addEventListener('message', (e) => {
    if (isBuildInfo(e.data)) takeBuild(e.data);
  });
  sc.startMessages();
  sc.addEventListener('controllerchange', () => {
    // 初めて入れたとき：この画面を受け持った＝オフラインでも開ける
    if (!hadController) offlineReadyOnce();
    void askBuild();
  });
  // 最初の読み込みの邪魔をしないように、読み終わってから入れる
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

/** インストールの案内を出す（Chrome・Edge） */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  set({ canInstall: false });
  try {
    await e.prompt();
    return (await e.userChoice).outcome === 'accepted';
  } catch {
    return false;
  }
}

export function dismissUpdate() {
  set({ updateDismissed: true });
}

/** ホームの「アプリとして使う」案内を閉じる（設定の「アプリとして使う」にはいつもある） */
export function closeInstallHint() {
  set({ hintClosed: true });
  try {
    localStorage.setItem(HINT_CLOSED_KEY, '1');
  } catch {
    // 覚えられなくても閉じる
  }
}

/** 読み込み直して新しい版にする。曲を開いているときは確かめ、変更を自動保存に残してから */
export async function applyUpdate() {
  const s = useEditor.getState();
  const songOpen = s.doc.header.length > 0 || s.doc.chips.length > 0;
  if (songOpen) {
    const direct = !!s.folder?.dir;
    const ok = await confirmDialog({
      title: tr('読み込み直して新しい版にしますか？', 'Reload to use the new version?'),
      body: [
        isDirty(s)
          ? tr(
              '開いている曲はいったん閉じます。保存していない変更も自動保存に残すので、ホームの「最近の曲」から続きを開けます。',
              'The open song will be closed. Unsaved changes are kept in the autosave, so you can continue from Recent songs on the home screen.',
            )
          : tr('開いている曲はいったん閉じます。ホームの「最近の曲」から開き直せます。', 'The open song will be closed. You can reopen it from Recent songs on the home screen.'),
        direct ? '' : tr('ZIP・ファイルから開いた曲は、音を鳴らすには曲を開き直してください。', 'For songs opened from a ZIP or files, open the song again to hear its sounds.'),
        tr('進めている処理（ステム分解・採譜・AI など）は止まります。', 'Anything still running (stem separation, transcription, AI) will stop.'),
      ]
        .filter(Boolean)
        .join('\n'),
      ok: tr('読み込み直す', 'Reload'),
    });
    if (!ok) return;
    try {
      await autosaveNow();
    } catch {
      // 自動保存に失敗しても、確かめたうえで読み込み直す
    }
  }
  window.location.reload();
}
