// Google のログイン（Google Identity Services のトークン。スコープは drive.file だけ）。
// - 小窓（ポップアップ）で取る。小窓はタップ・クリック・キーの操作の中で開く必要があるので、signIn() は操作の中で最初の await より前に呼ぶ。
// - ホーム画面のアプリなどで小窓が使えないときは、ページを切り替えて Google へ行き、戻ってくる（redirect）。戻ったら takeRedirectResult()。
// - トークンは約1時間。切れたら、次の保存などの操作のときに取り直す（取り直しの小窓は、許可済みならすぐ閉じる）。
import { create } from 'zustand';
import { tr } from '../i18n';
import { IS_IOS } from '../platform';
import { STANDALONE_AT_START } from '../pwa/display';
import { toast } from '../store/editor';
import { about, DriveAuthError, setDriveAuth } from './api';

/** Google Cloud の OAuth クライアント ID（公開して良い値。生成元 https://check5004.github.io） */
export const CLIENT_ID = '918924939494-oirrr67hcpk8nps7ul494g6m720at5jv.apps.googleusercontent.com';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const PREFS_KEY = 'dtxe.drive';
const TOKEN_KEY = 'dtxe.drive.token';
const RESUME_KEY = 'dtxe.drive.resume';

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string; login_hint?: string }): void;
}
interface GisOauth2 {
  initTokenClient(c: {
    client_id: string;
    scope: string;
    include_granted_scopes?: boolean;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type?: string; message?: string }) => void;
  }): TokenClient;
  hasGrantedAllScopes(r: TokenResponse, scope: string): boolean;
  revoke(token: string, done?: () => void): void;
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GisOauth2 } };
  }
}

export interface DrivePrefs {
  /** つないだ（ログインしたことがある。切るまで覚える） */
  connected: boolean;
  email: string;
  name: string;
  /** ページを切り替えてログインする（小窓が使えないとき） */
  redirect: boolean;
  /** 保存した曲を Drive にも送る */
  onSave: boolean;
  /** 自動保存（まだ保存していない続き）も送る */
  autosave: boolean;
}

export interface DriveAuthState extends DrivePrefs {
  token: string | null;
  exp: number;
  signingIn: boolean;
  /** ログインの部品（Google のスクリプト）を読み終えた */
  gisReady: boolean;
}

const DEFAULT_PREFS: DrivePrefs = { connected: false, email: '', name: '', redirect: false, onSave: true, autosave: true };

/** localStorage の設定（まだ無い・読めないときは null） */
function storedPrefs(): DrivePrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw === null ? null : { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<DrivePrefs>) };
  } catch {
    return null;
  }
}

function readPrefs(): DrivePrefs {
  return storedPrefs() ?? { ...DEFAULT_PREFS };
}

function readToken(): { token: string | null; exp: number } {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as { token?: string; exp?: number } | null;
    if (t?.token && (t.exp ?? 0) > Date.now() + 60_000) return { token: t.token, exp: t.exp! };
  } catch {
    // 読めなければ無い
  }
  return { token: null, exp: 0 };
}

export const useDriveAuth = create<DriveAuthState>(() => ({ ...readPrefs(), ...readToken(), signingIn: false, gisReady: false }));

const get = useDriveAuth.getState;

export function setPrefs(p: Partial<DrivePrefs>) {
  const s = get();
  // ほかの窓・タブで変えた物を消さないよう、localStorage の今の値に足す
  const prefs: DrivePrefs = { ...(storedPrefs() ?? { connected: s.connected, email: s.email, name: s.name, redirect: s.redirect, onSave: s.onSave, autosave: s.autosave }), ...p };
  useDriveAuth.setState(prefs);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 覚えられなくても続ける
  }
}

/** トークンが使える（1分以上残っている） */
export function tokenValid(): boolean {
  const s = get();
  return !!s.token && s.exp > Date.now() + 60_000;
}

function setToken(token: string | null, expiresIn = 0) {
  const exp = token ? Date.now() + Math.max(60, expiresIn) * 1000 : 0;
  useDriveAuth.setState({ token, exp });
  try {
    if (token) localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp }));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 覚えられなくても、この画面の間は使える
  }
}

// ほかの窓・タブ（ホーム画面のアプリとタブなど）でログインし直した・切れた・設定を変えた：この窓も同じにする
// （1 つの窓でログインし直せば、ほかの窓もそのトークンで同期できる）
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY) {
      const t = readToken();
      if (t.token !== get().token || t.exp !== get().exp) useDriveAuth.setState(t);
    } else if (e.key === PREFS_KEY) {
      const p = storedPrefs();
      if (p) useDriveAuth.setState(p);
    }
  });
}

// API にトークンの取り方を渡す（操作の外では取り直さない。切れていたら DriveAuthError）
setDriveAuth(
  async () => {
    if (tokenValid()) return get().token!;
    throw new DriveAuthError();
  },
  () => setToken(null),
);

// ---- Google のスクリプト --------------------------------------------------------

let gisLoading: Promise<boolean> | null = null;
let client: TokenClient | null = null;
let waiters: ((ok: boolean) => void)[] = [];

function finish(ok: boolean) {
  const w = waiters;
  waiters = [];
  useDriveAuth.setState({ signingIn: false });
  for (const f of w) f(ok);
}

/** ログインの部品を読み込む（つないでいる人は開いたときに。ボタンを押してから読むと小窓が止められるため） */
export function loadGis(): Promise<boolean> {
  gisLoading ??= new Promise<boolean>((resolve) => {
    if (typeof document === 'undefined') return resolve(false);
    const done = () => {
      const o = window.google?.accounts?.oauth2;
      if (!o) return resolve(false);
      client = o.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        include_granted_scopes: true,
        callback: (r) => void onToken(r),
        error_callback: (e) => onPopupError(e.type ?? 'unknown'),
      });
      useDriveAuth.setState({ gisReady: true });
      resolve(true);
    };
    if (window.google?.accounts?.oauth2) return done();
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = done;
    s.onerror = () => {
      gisLoading = null;
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

async function onToken(r: TokenResponse) {
  if (r.error || !r.access_token) {
    if (r.error && r.error !== 'access_denied') toast(tr(`Google にログインできませんでした: ${r.error_description ?? r.error}`, `Couldn't sign in to Google: ${r.error_description ?? r.error}`), 'error', 7000);
    finish(false);
    return;
  }
  const o = window.google?.accounts?.oauth2;
  if (o && !o.hasGrantedAllScopes(r, SCOPE)) {
    noDrivePermission();
    finish(false);
    return;
  }
  setToken(r.access_token, Number(r.expires_in ?? 3600));
  await afterToken();
  finish(true);
}

function noDrivePermission() {
  toast(
    tr(
      'Google Drive の許可が付いていません。もう一度つなぎ、「Google ドライブのファイルの表示、編集、作成、削除（このアプリで使用するファイルのみ）」にチェックを入れてください',
      'Google Drive access was not granted. Connect again and tick "See, edit, create and delete only the specific Google Drive files you use with this app"',
    ),
    'warn',
    10000,
  );
}

/** 初めてつないだとき：アカウントの名前を覚える */
async function afterToken() {
  const s = get();
  if (s.connected && s.email) return;
  try {
    const u = await about();
    setPrefs({ connected: true, email: u.email, name: u.name });
  } catch {
    setPrefs({ connected: true });
  }
}

/** ホーム画面のアプリ（iPad）では小窓が使えないことがある */
const STANDALONE_IOS = IS_IOS && STANDALONE_AT_START;

function onPopupError(type: string) {
  finish(false);
  if (type === 'popup_closed' && !STANDALONE_IOS) return; // 自分で閉じた
  if (!canRedirect()) {
    toast(tr('Google のログイン画面を開けませんでした。ポップアップを許可してください', "Couldn't open the Google sign-in window. Allow pop-ups for this site"), 'warn', 8000);
    return;
  }
  toast(
    type === 'popup_closed'
      ? tr('ログインできませんでしたか？ ページを切り替えてログインすることもできます', "Didn't sign in? You can also sign in on a full page")
      : tr('Google のログイン画面（小窓）を開けませんでした', "Couldn't open the Google sign-in window"),
    'warn',
    12000,
    {
      label: tr('ページを切り替えてログイン', 'Sign in on a full page'),
      run: () => {
        setPrefs({ redirect: true });
        void redirectSignIn(lastResume ?? { action: 'connect' });
      },
    },
  );
}

// ---- ログイン ------------------------------------------------------------------

/** ページを切り替えてログインしたあと、戻ってきてから続ける事 */
export interface Resume {
  action: 'connect' | 'open' | 'push';
  /** 開いていた曲（最近の曲の id）。戻ってきたら開き直す */
  recentId?: string;
}

let lastResume: Resume | null = null;
let beforeRedirect: (() => Promise<void>) | null = null;

/** ページを切り替える前にすること（自動保存を書き切る）。画面の側で決める */
export function setBeforeRedirect(fn: () => Promise<void>) {
  beforeRedirect = fn;
}

function redirectUri(): string {
  return `${location.origin}${import.meta.env.BASE_URL}`;
}

/** ページを切り替えるログインが使えるか（Google に登録した戻り先は公開しているページだけ） */
export function canRedirect(): boolean {
  return typeof location !== 'undefined' && redirectUri() === 'https://check5004.github.io/dtx-mania-web-editor/';
}

/**
 * Google にログインしてトークンを取る。タップ・クリック・キーの操作の中で、最初の await より前に呼ぶ（小窓を開くため）。
 * ページを切り替えるログインのときは戻ってこない（戻ったら resume を続ける）
 */
export function signIn(resume: Resume = { action: 'connect' }): Promise<boolean> {
  lastResume = resume;
  const s = get();
  if (s.redirect && canRedirect()) {
    void redirectSignIn(resume);
    return new Promise(() => {});
  }
  if (!client) {
    // 部品がまだ：読み終えたら知らせる（ここで小窓を開いても止められる）
    void loadGis().then((ok) =>
      toast(
        ok ? tr('Google のログインの準備ができました。もう一度押してください', 'Google sign-in is ready. Press it again') : tr('Google のログインの部品を読み込めませんでした。ネットにつながっているか確かめてください', "Couldn't load Google sign-in. Check your internet connection"),
        ok ? 'info' : 'error',
        6000,
      ),
    );
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    waiters.push(resolve);
    if (waiters.length > 1) return; // もう小窓を開いている
    useDriveAuth.setState({ signingIn: true });
    client!.requestAccessToken({ prompt: s.connected ? '' : 'select_account', ...(s.email ? { login_hint: s.email } : {}) });
  });
}

/** トークンがあればそのまま、無ければ操作の中で取る（操作の外なら false） */
export function ensureToken(resume: Resume, inGesture: boolean): Promise<boolean> {
  if (tokenValid()) return Promise.resolve(true);
  if (!inGesture) return Promise.resolve(false);
  return signIn(resume);
}

export async function redirectSignIn(resume: Resume) {
  await beforeRedirect?.().catch(() => undefined);
  const s = get();
  const state = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({ ...resume, state, at: Date.now() }));
  } catch {
    // 覚えられなくてもログインはできる
  }
  const p = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state });
  if (s.email) p.set('login_hint', s.email);
  else p.set('prompt', 'select_account');
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
}

/** ページを切り替えるログインから戻ったとき：トークンを受け取り、続ける事を返す（アドレスの # は消す） */
export function takeRedirectResult(): Resume | null {
  if (typeof location === 'undefined') return null;
  const h = location.hash;
  if (!/(^#|&)(access_token|error)=/.test(h)) return null;
  const p = new URLSearchParams(h.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  let saved: (Resume & { state: string; at: number }) | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(RESUME_KEY) ?? 'null');
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // 無い
  }
  if (!saved || p.get('state') !== saved.state || Date.now() - saved.at > 30 * 60_000) return null;
  const err = p.get('error');
  if (err) {
    if (err !== 'access_denied') toast(tr(`Google にログインできませんでした: ${err}`, `Couldn't sign in to Google: ${err}`), 'error', 7000);
    return null;
  }
  if (!(p.get('scope') ?? '').split(' ').includes(SCOPE)) {
    noDrivePermission();
    return null;
  }
  setToken(p.get('access_token'), Number(p.get('expires_in') ?? 3600));
  void afterToken();
  return { action: saved.action, recentId: saved.recentId };
}

/** Drive を切る（トークンを返し、覚えたアカウントを忘れる） */
export function signOut() {
  const t = get().token;
  if (t) window.google?.accounts?.oauth2?.revoke(t);
  setToken(null);
  setPrefs({ connected: false, email: '', name: '', redirect: false });
}

/** 試験用：トークンを入れる */
export function _setTokenForTest(token: string | null, expiresIn = 3600) {
  setToken(token, expiresIn);
}
