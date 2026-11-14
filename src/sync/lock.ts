// PC どうしの同期を、窓・タブをまたいで 1 つずつにする（同じブラウザでアプリを 2 つ開いても、記録を上書きし合わない）。
// - navigator.locks（Chrome・Edge・Firefox・Safari 15.4〜）：同じ origin なら、タブもホーム画面のアプリも同じ鍵
// - 無いブラウザは localStorage の札（だれが・いつまで）で順番を取る。窓が落ちても、期限で外れる
// エディタで開いている曲の印（holdLock）も navigator.locks で、ほかの窓から見える（lockHeld）。無ければ、この窓の中だけで見る

/** 同期の順番の鍵 */
export const SYNC_LOCK = 'dtxe-pcsync';
const LEASE_KEY = 'dtxe.pcsync.lock';

interface Lease {
  id: string;
  until: number;
}

/** localStorage の札の時間（ttl：持っている間に何度も延ばす。窓が落ちたら、この時間で外れる） */
export interface LeaseTiming {
  ttl: number;
  renew: number;
  /** 札を書いてから、ほかの窓が同じ時に書いていないか見るまで */
  settle: number;
  /** ほかの窓が持っている間、見に行く間 */
  poll: number;
}
// 隠れたタブのタイマーは 1 分に 1 回まで遅れることがあるので、期限はそれより長く
const TIMING: LeaseTiming = { ttl: 3 * 60_000, renew: 20_000, settle: 200, poll: 1000 };

function lockManager(): LockManager | null {
  try {
    const lm = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    return lm && typeof lm.request === 'function' ? lm : null;
  } catch {
    return null;
  }
}

/**
 * 順番を取って fn をする（ほかの窓・タブがしている間は待つ。待つことになったら、待つ前に onWait）。
 * 同じ窓の中でも順番になる（navigator.locks は入れ子にできないので、fn の中でもう一度呼ばない）
 */
export async function withSyncLock<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> {
  const lm = lockManager();
  if (!lm) return withLease(fn, onWait);
  let got = false;
  const r = await lm.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return undefined;
    got = true;
    return fn();
  });
  if (got) return r as T;
  onWait?.();
  return lm.request(SYNC_LOCK, () => fn());
}

/** undefined：localStorage が使えない */
function readLease(): Lease | null | undefined {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEASE_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return null;
  try {
    const l = JSON.parse(raw) as Partial<Lease> | null;
    return l && typeof l.id === 'string' && typeof l.until === 'number' ? { id: l.id, until: l.until } : null;
  } catch {
    return null;
  }
}

function writeLease(l: Lease | null): boolean {
  try {
    if (l) localStorage.setItem(LEASE_KEY, JSON.stringify(l));
    else localStorage.removeItem(LEASE_KEY);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** navigator.locks の無いブラウザ：localStorage の札で順番を取る（試験のため export） */
export async function withLease<T>(fn: () => Promise<T>, onWait?: () => void, t: LeaseTiming = TIMING): Promise<T> {
  const me = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let waited = false;
  for (;;) {
    const cur = readLease();
    // localStorage が使えない：窓をまたいだ順番は取れない（この窓の中の順番だけ）
    if (cur === undefined) return fn();
    if (!cur || cur.until < Date.now()) {
      if (!writeLease({ id: me, until: Date.now() + t.ttl })) return fn();
      // 同じ時に札を書いたほかの窓に、上書きされていないか
      await sleep(t.settle);
      if (readLease()?.id === me) break;
    }
    if (!waited) {
      waited = true;
      onWait?.();
    }
    await sleep(t.poll * (0.75 + Math.random() * 0.5));
  }
  const mine = () => readLease()?.id === me;
  const renew = setInterval(() => {
    if (mine()) writeLease({ id: me, until: Date.now() + t.ttl });
  }, t.renew);
  // 窓を閉じた：すぐ外す（落ちたときは期限で外れる）
  const drop = () => {
    if (mine()) writeLease(null);
  };
  const win = typeof window !== 'undefined' ? window : null;
  win?.addEventListener('pagehide', drop);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    win?.removeEventListener('pagehide', drop);
    drop();
  }
}

/** 名前の印を持つ（ほかの窓から lockHeld で見える。返す関数で離す）。navigator.locks が無ければ何もしない */
export function holdLock(name: string): () => void {
  const lm = lockManager();
  if (!lm) return () => {};
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  lm.request(name, { mode: 'shared' }, () => held).catch(() => {});
  return release;
}

/** その印を、どこかの窓・タブ（この窓も）が持っているか。分からなければ false */
export async function lockHeld(name: string): Promise<boolean> {
  const lm = lockManager();
  if (!lm || typeof lm.query !== 'function') return false;
  try {
    const q = await lm.query();
    return !!q.held?.some((l) => l.name === name);
  } catch {
    return false;
  }
}
