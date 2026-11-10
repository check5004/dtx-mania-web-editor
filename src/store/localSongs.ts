// 本体（このブラウザの保存領域）の状態：使えるか、置いた曲の一覧、使っている量、曲を入れている途中の進み具合。
import { create } from 'zustand';
import { tr } from '../i18n';
import { checkLocal, cleanupLocal, listLocalSongs, storageInfo, type LocalSong, type StorageInfo } from '../fs/local';
import { IS_IOS, iosName } from './device';

export interface CopyProgress {
  name: string;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
}

interface LocalSongsState {
  /** 本体が使える（確かめ終わった） */
  ready: boolean;
  checked: boolean;
  songs: LocalSong[];
  storage: StorageInfo | null;
  /** 曲を本体に入れている途中 */
  copying: CopyProgress | null;
  /** 開いている曲を本体に保存した時刻 */
  savedAt: number;
  /** 曲の置き場所が変わった（メモリ → 本体、本体 → 曲フォルダ）。場所を出す所を描き直す */
  ver: number;
}

export const useLocalSongs = create<LocalSongsState>(() => ({ ready: false, checked: false, songs: [], storage: null, copying: null, savedAt: 0, ver: 0 }));

/** 本体の呼び名（iPad は「iPad 本体」、iPhone は「iPhone 本体」、ほかは「このブラウザ」） */
export function localPlace(): string {
  return IS_IOS ? iosName(tr('iPad 本体', 'this iPad')) : tr('このブラウザ', 'this browser');
}

/** 一覧の印（短く） */
export function localBadge(): string {
  return IS_IOS ? iosName(tr('iPad 本体', 'On iPad')) : tr('ブラウザ内', 'In browser');
}

export async function refreshLocalSongs(): Promise<void> {
  const [songs, storage] = await Promise.all([listLocalSongs(), storageInfo()]);
  useLocalSongs.setState({ songs, storage });
}

export function setCopying(p: CopyProgress | null) {
  useLocalSongs.setState({ copying: p });
}

export function bumpLocal(patch: Partial<LocalSongsState> = {}) {
  useLocalSongs.setState((s) => ({ ...patch, ver: s.ver + 1 }));
}

let started: Promise<void> | null = null;

/** 開いたとき：本体が使えるかを確かめ、入れている途中で閉じた曲を片付け、一覧を読む */
export function initLocalSongs(): Promise<void> {
  started ??= (async () => {
    const ok = await checkLocal();
    useLocalSongs.setState({ ready: ok, checked: true });
    if (!ok) return;
    try {
      await cleanupLocal();
    } catch {
      // 片付けられなくても使える
    }
    await refreshLocalSongs();
  })();
  return started;
}

// 曲を入れている途中に閉じようとしたら止める（途中までの曲は次に開いたときに片付ける）
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (useLocalSongs.getState().copying) e.preventDefault();
  });
}
