// 窓・タブをまたいだ同期の順番（navigator.locks の無いブラウザの、localStorage の札）。
// navigator.locks の方は、Chrome で窓を 2 つ開いて確かめる（同じ鍵を、どのタブ・ホーム画面のアプリも使う）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdLock, lockHeld, withLease, withSyncLock, type LeaseTiming } from './lock';

const FAST: LeaseTiming = { ttl: 400, renew: 50, settle: 10, poll: 15 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

let ls: MemStorage;
beforeEach(() => {
  ls = new MemStorage();
  vi.stubGlobal('localStorage', ls);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('localStorage の札（navigator.locks が無い）', () => {
  it('同じ時に 2 つ頼んでも、1 つずつする（終わったら札を外す）', async () => {
    const order: string[] = [];
    const job = (n: string) => async () => {
      order.push(`${n}+`);
      await sleep(40);
      order.push(`${n}-`);
      return n;
    };
    const waits: string[] = [];
    const r = await Promise.all([withLease(job('a'), () => waits.push('a'), FAST), withLease(job('b'), () => waits.push('b'), FAST)]);
    expect(r).toEqual(['a', 'b']);
    // 入れ子にならない
    expect(order.join(' ')).toMatch(/^(a\+ a- b\+ b-|b\+ b- a\+ a-)$/);
    // 待った方だけ知らせる
    expect(waits).toHaveLength(1);
    expect(ls.getItem('dtxe.pcsync.lock')).toBeNull();
  });

  it('札を書いたあと、同じ時にほかの窓が上書きしていたら待つ', async () => {
    let ran = false;
    const p = withLease(
      async () => {
        ran = true;
      },
      undefined,
      FAST,
    );
    // 札を書いた直後（settle の間）に、ほかの窓が自分の札にした
    await sleep(2);
    ls.setItem('dtxe.pcsync.lock', JSON.stringify({ id: 'other', until: Date.now() + 100 }));
    await sleep(40);
    expect(ran).toBe(false);
    // ほかの窓が終わった
    ls.removeItem('dtxe.pcsync.lock');
    await p;
    expect(ran).toBe(true);
  });

  it('期限の切れた札（落ちた窓）は取ってよい', async () => {
    ls.setItem('dtxe.pcsync.lock', JSON.stringify({ id: 'dead', until: Date.now() - 1 }));
    const waits: number[] = [];
    expect(await withLease(async () => 1, () => waits.push(1), FAST)).toBe(1);
    expect(waits).toHaveLength(0);
  });

  it('持っている間は期限を延ばす', async () => {
    let seen = 0;
    await withLease(
      async () => {
        const first = JSON.parse(ls.getItem('dtxe.pcsync.lock')!).until as number;
        await sleep(120);
        seen = (JSON.parse(ls.getItem('dtxe.pcsync.lock')!).until as number) - first;
      },
      undefined,
      FAST,
    );
    expect(seen).toBeGreaterThan(0);
  });

  it('失敗しても札を外す', async () => {
    await expect(
      withLease(
        async () => {
          throw new Error('x');
        },
        undefined,
        FAST,
      ),
    ).rejects.toThrow('x');
    expect(ls.getItem('dtxe.pcsync.lock')).toBeNull();
  });

  it('localStorage が使えない：順番を取らずにする', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(await withSyncLock(async () => 'ok')).toBe('ok');
  });
});

/** 試験用の navigator.locks（exclusive は来た順・shared は何個でも・ifAvailable・query だけ） */
class FakeLocks {
  private held: { name: string; mode: string }[] = [];
  private waiting: { name: string; mode: string; go: () => void }[] = [];
  private free(name: string, mode: string) {
    const h = this.held.filter((x) => x.name === name);
    return mode === 'shared' ? h.every((x) => x.mode === 'shared') : h.length === 0;
  }
  async request<T>(name: string, a: unknown, b?: unknown): Promise<T> {
    const opt = (typeof a === 'function' ? {} : a) as { mode?: string; ifAvailable?: boolean };
    const cb = (typeof a === 'function' ? a : b) as (lock: unknown) => T | Promise<T>;
    const mode = opt.mode ?? 'exclusive';
    if (!this.free(name, mode) || this.waiting.some((w) => w.name === name)) {
      if (opt.ifAvailable) return cb(null);
      await new Promise<void>((go) => this.waiting.push({ name, mode, go }));
    }
    const rec = { name, mode };
    this.held.push(rec);
    try {
      return await cb({ name, mode });
    } finally {
      this.held.splice(this.held.indexOf(rec), 1);
      const next = this.waiting.find((w) => w.name === name && this.free(name, w.mode));
      if (next) {
        this.waiting.splice(this.waiting.indexOf(next), 1);
        next.go();
      }
    }
  }
  async query() {
    return { held: this.held.map((h) => ({ ...h })), pending: [] };
  }
}

describe('navigator.locks', () => {
  it('ほかが持っているときだけ「待つ」と知らせ、順番にする', async () => {
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const order: string[] = [];
    const waits: string[] = [];
    const job = (n: string) => async () => {
      order.push(`${n}+`);
      await sleep(20);
      order.push(`${n}-`);
      return n;
    };
    expect(await withSyncLock(job('solo'), () => waits.push('solo'))).toBe('solo');
    expect(waits).toEqual([]);
    const r = await Promise.all([withSyncLock(job('a'), () => waits.push('a')), withSyncLock(job('b'), () => waits.push('b'))]);
    expect(r).toEqual(['a', 'b']);
    expect(order.slice(2).join(' ')).toBe('a+ a- b+ b-');
    expect(waits).toEqual(['b']);
  });

  it('開いている曲の印は、離すまでほかの窓から見える', async () => {
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    expect(await lockHeld('dtxe-open:main:dtxfiles/song')).toBe(false);
    const release = holdLock('dtxe-open:main:dtxfiles/song');
    await sleep(0);
    expect(await lockHeld('dtxe-open:main:dtxfiles/song')).toBe(true);
    expect(await lockHeld('dtxe-open:main:dtxfiles/other')).toBe(false);
    release();
    await sleep(0);
    expect(await lockHeld('dtxe-open:main:dtxfiles/song')).toBe(false);
  });
});
