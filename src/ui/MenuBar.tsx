// 上のメニュー（ファイル・編集・表示・再生・ツール）。デスクトップのソフトと同じ動きにする。
// - タイトルを押すと開き、開いているタイトルをもう一度押すと閉じる
// - 1つ開いている間は、ほかのタイトルにマウスを乗せるだけでそのメニューに移る
// - タイトルを押したまま項目までなぞって離すと、その項目を実行する
// - メニューの外を押す・Esc・ウィンドウを離れると閉じる（閉じるために譜面を押しても、チップは置かない）
// - キーボード：← → で隣のメニュー、↑ ↓ で項目、Home・End、Enter・Space で実行、Esc で閉じる。
//   Ctrl・Alt 付きのキーと F キーはメニューを閉じてからいつもどおり効かせる（Ctrl+Z など）
// - 幅は中身（いちばん長い項目とショートカット）に合わせて広がり、折り返さない。画面の右や下からはみ出すときは寄せる・スクロールする
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { markDismissPress } from '../store/ctxMenu';

export interface MenuItem {
  label: string;
  /** ショートカットの表示（押したときの動きは Editor のキー操作が受け持つ） */
  key?: string;
  run: () => void;
  disabled?: boolean;
  /** オン・オフを持つ項目。true で左の列に ✓ を出す（undefined はオン・オフの無い項目） */
  checked?: boolean;
}

export type MenuEntry = MenuItem | '-';

export interface MenuDef {
  label: string;
  /** 開くたびに作る（その時の状態で「元に戻す（…）」や ✓ を決める） */
  items: () => MenuEntry[];
}

interface OpenState {
  menu: number;
  /** 光っている項目（entries の添字、-1 は無し） */
  active: number;
  /** キーボードで開いた（Esc・Tab で閉じたらタイトルにフォーカスを戻す） */
  byKey: boolean;
  /** 最後に項目を動かしたのがキーボード（光っている項目にフォーカスを移す） */
  kbd: boolean;
}

const enabled = (e: MenuEntry | undefined): e is MenuItem => !!e && e !== '-' && !e.disabled;

/** from から dir の向きに、押せる項目を探す（端は反対側へ回る） */
function step(entries: MenuEntry[], from: number, dir: 1 | -1): number {
  const n = entries.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (enabled(entries[i])) return i;
  }
  return -1;
}

const firstItem = (entries: MenuEntry[]) => step(entries, -1, 1);
const lastItem = (entries: MenuEntry[]) => step(entries, entries.length, -1);

// 開いているメニューのキー操作。ほかのパネル（フレーズ候補・小節の生成など）も window の capture で
// Enter・Esc を受けるので、どれよりも先に受けられるよう、読み込んだときに1つだけ付けておく
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
if (typeof window !== 'undefined') window.addEventListener('keydown', (e) => keyHandler?.(e), true);

export function MenuBar({ menus, label = 'メニュー' }: { menus: MenuDef[]; label?: string }) {
  const [open, setOpen] = useState<OpenState | null>(null);
  /** Tab で止まるタイトル（矢印で動かす。WAI-ARIA の menubar と同じ） */
  const [tabStop, setTabStop] = useState(0);
  const barRef = useRef<HTMLElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const titleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** 最後に押したのがタイトルなら true（押したままなぞって項目で離したら実行する） */
  const pressedTitle = useRef(false);

  const entries = open ? (menus[open.menu]?.items() ?? []) : [];
  // 開いている間に付ける window のリスナーから、いつも今の中身を読めるように
  const live = useRef({ menus, entries, open });
  live.current = { menus, entries, open };

  const close = (focusTitle = false) => {
    const cur = live.current.open;
    setOpen(null);
    pressedTitle.current = false;
    if (!cur) return;
    if (focusTitle) titleRefs.current[cur.menu]?.focus();
    else {
      // マウスで使ったあとはフォーカスを残さない（Space の再生・矢印などをエディタに戻す）
      const a = document.activeElement as HTMLElement | null;
      if (a && (barRef.current?.contains(a) || popRef.current?.contains(a))) a.blur();
    }
  };

  /** byKey: キーボードで開いた。where: 最初に光らせる項目。kbd: 光らせた項目にフォーカスを移す */
  const openMenu = (menu: number, byKey: boolean, where: 'none' | 'first' | 'last' = 'none', kbd = byKey) => {
    const all = live.current.menus;
    const m = ((menu % all.length) + all.length) % all.length;
    const list = all[m].items();
    const active = where === 'first' ? firstItem(list) : where === 'last' ? lastItem(list) : -1;
    setOpen({ menu: m, active, byKey, kbd });
    setTabStop(m);
  };

  const activate = (it: MenuEntry | undefined) => {
    if (!enabled(it)) return;
    close();
    it.run();
  };

  // キーボードで動かしたときは、光っている項目にフォーカスを移す（読み上げにも伝わる）
  useEffect(() => {
    if (!open || open.active < 0 || !open.kbd) return;
    const el = itemRefs.current[open.active];
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  // 置き場所：タイトルの真下。右が足りなければ左へ寄せ、下が足りなければ高さを抑えてスクロール
  useLayoutEffect(() => {
    const pop = popRef.current;
    const t = open ? titleRefs.current[open.menu] : null;
    if (!pop || !t) return;
    const r = t.getBoundingClientRect();
    const top = Math.round(r.bottom + 4);
    pop.style.top = `${top}px`;
    pop.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
    const w = pop.offsetWidth;
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)))}px`;
    pop.style.visibility = 'visible';
  });

  // 開いている間：外を押したら閉じる、キー操作、ウィンドウを離れたら閉じる
  const isOpen = open !== null;
  useEffect(() => {
    if (!isOpen) return;
    const down = (e: PointerEvent) => {
      pressedTitle.current = false;
      const t = e.target as Node;
      if (barRef.current?.contains(t) || popRef.current?.contains(t)) return;
      // 閉じるための押下は譜面に効かせない（うっかりチップを置かないように。右クリックのメニューと同じ）
      markDismissPress(e.timeStamp);
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const k = e.key;
      if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;
      if (e.ctrlKey || e.metaKey || e.altKey || /^F\d{1,2}$/.test(k)) {
        // ショートカットはメニューを閉じていつもどおり効かせる
        close();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const { open: cur, entries: list } = live.current;
      if (!cur) return;
      const move = (active: number) => setOpen({ ...cur, active, kbd: true });
      switch (k) {
        case 'ArrowDown':
          move(step(list, cur.active, 1));
          break;
        case 'ArrowUp':
          move(cur.active < 0 ? lastItem(list) : step(list, cur.active, -1));
          break;
        case 'Home':
          move(firstItem(list));
          break;
        case 'End':
          move(lastItem(list));
          break;
        case 'ArrowRight':
        case 'ArrowLeft':
          openMenu(cur.menu + (k === 'ArrowRight' ? 1 : -1), cur.byKey, 'first', true);
          break;
        case 'Enter':
        case ' ':
          if (cur.active >= 0) activate(list[cur.active]);
          break;
        case 'Escape':
        case 'Tab':
          close(cur.byKey);
          break;
        // ほかのキー（チップを置く A・S… など）は、メニューを開いている間は効かせない
      }
    };
    const away = () => close();
    keyHandler = key;
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    return () => {
      if (keyHandler === key) keyHandler = null;
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
    };
    // 開け閉めのときだけ付け外しする（中身は live から読む）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const hasChecks = entries.some((e) => e !== '-' && e.checked !== undefined);

  return (
    <nav className="menubar" role="menubar" aria-label={label} ref={barRef}>
      {menus.map((m, i) => {
        const here = open?.menu === i;
        return (
          <button
            key={m.label}
            ref={(el) => {
              titleRefs.current[i] = el;
            }}
            id={`menubar-title-${i}`}
            className={`menu-btn ${here ? 'open' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={here}
            tabIndex={i === tabStop ? 0 : -1}
            // マウスで押してもフォーカスを取らない（閉じたあと Space・矢印をエディタに残す）
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              pressedTitle.current = true;
              if (here) close();
              else openMenu(i, false);
            }}
            onPointerEnter={(e) => {
              // 1つ開いている間は、乗せるだけで隣のメニューへ（タッチは押したときに開くので除く）
              if (e.pointerType === 'mouse' && open && !here) openMenu(i, open.byKey, 'none', false);
            }}
            onClick={(e) => {
              // キーボード・読み上げソフトからのクリックだけ（マウスは押したときに開いている）
              if (e.detail !== 0) return;
              if (here) close(true);
              else openMenu(i, true, 'first');
            }}
            onKeyDown={(e) => {
              const n = menus.length;
              let next: number | null = null;
              if (e.key === 'ArrowRight') next = (i + 1) % n;
              else if (e.key === 'ArrowLeft') next = (i - 1 + n) % n;
              else if (e.key === 'Home') next = 0;
              else if (e.key === 'End') next = n - 1;
              if (next !== null) {
                e.preventDefault();
                e.stopPropagation();
                setTabStop(next);
                titleRefs.current[next]?.focus();
                return;
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                openMenu(i, true, e.key === 'ArrowUp' ? 'last' : 'first');
              }
            }}
          >
            {m.label}
          </button>
        );
      })}
      {open && (
        <div
          ref={popRef}
          className={`menu-pop ${hasChecks ? 'with-checks' : ''}`}
          role="menu"
          aria-labelledby={`menubar-title-${open.menu}`}
          style={{ visibility: 'hidden' }}
          onPointerLeave={() => setOpen((cur) => (cur && cur.active >= 0 ? { ...cur, active: -1 } : cur))}
          onContextMenu={(e) => e.preventDefault()}
        >
          {entries.map((it, i) =>
            it === '-' ? (
              <div key={i} className="menu-sep" role="separator" />
            ) : (
              <button
                key={i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                className={`menu-item ${open.active === i ? 'active' : ''}`}
                role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={it.checked}
                disabled={it.disabled}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => {
                  const want = it.disabled ? -1 : i;
                  if (open.active !== want || open.kbd) setOpen({ ...open, active: want, kbd: false });
                }}
                onPointerUp={(e) => {
                  // タイトルを押したままなぞって、ここで離した
                  if (e.button === 0 && pressedTitle.current) activate(it);
                }}
                onClick={() => activate(it)}
              >
                {hasChecks && (
                  <span className="menu-check" aria-hidden="true">
                    {it.checked ? '✓' : ''}
                  </span>
                )}
                <span className="menu-label">{it.label}</span>
                {it.key && <span className="key">{it.key}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </nav>
  );
}
