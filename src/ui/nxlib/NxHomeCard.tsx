// ホーム（PC）の「DTXMania の曲」のカード。まだなら場所を選ぶ入口（一覧のイメージつき）、覚えていれば曲の棚（横に送って全部の曲を見る）。
// 棚は曲の一覧と同じ見せ方（探す言葉・しぼりこみ・BOX・並べ替え・選んだ曲。src/nxlib/viewPrefs.ts）なので、一覧で決めたしぼりこみのまま、
// エディタから戻ってもすぐ続きの曲が出る。しぼりこみに合わせて、タイルからそのまま作る（AI難易度生成・あいだに作る・ステム分解）。
// PC どうしの同期は Google Drive のカード（src/ui/sync/home.tsx の PcSyncHomeRow）に出す。
import { tr, pl, locale } from '../../i18n';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { openNxGen, openNxInsert, openNxPage, openNxSeparate, openNxSong } from '../../nxlib/actions';
import { SLOT_KEYS, type LibSong, type SlotKey } from '../../nxlib/scan';
import { ensureNxPerm, rescanNx, setNxView, useNxLib } from '../../nxlib/store';
import { addableSlots, bgmCheckedCount, canAddLevel, canSeparate, chartCount, chartIn, filterCounts, levelText, SLOT_LABEL, viewSongs, warnCount, type NxFilter, type NxSort } from '../../nxlib/view';
import { shelfPerPage, shelfStart } from '../../nxlib/viewPrefs';
import { usePlayLevel } from '../../store/playLevel';
import { Icon } from '../icons';
import { FILTER_COLOR, NxPickButton, NxPromises, SORTS, filterName, sortName, useSyncedSet } from './SongsPage';
import { SLOT_CLASS } from './parts';

export function NxHomeCard() {
  const supported = useNxLib((s) => s.supported);
  const ready = useNxLib((s) => s.ready);
  const place = useNxLib((s) => s.place);
  if (!ready || !supported) return null;
  return place ? <NxHomeReady /> : <NxHomeFirst />;
}

/** 頭のアイコン（フォルダと音符） */
function LibIcon() {
  return (
    <span className="nx-home-ic" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M14 16.5V11l4-1v5" />
        <circle cx="12.6" cy="16.5" r="1.4" />
        <circle cx="16.6" cy="15" r="1.4" />
      </svg>
    </span>
  );
}

/** レベル（8.25 は「8.25」、3.50 は「3.5」、7.00 は「7.0」） */
function shortLevel(n: number | null): string {
  if (n === null) return '?';
  return Math.abs(Math.round(n * 10) - n * 10) < 1e-6 ? n.toFixed(1) : n.toFixed(2);
}

/** 一覧のイメージ（初めてのカードの右。架空の曲・色の四角） */
const sample = (): { t: string; bg: string; lv: (string | null)[] }[] => [
  { t: tr('夏の終わりのリフレイン', 'End of Summer Refrain'), bg: 'linear-gradient(180deg,#ffb36b 0%,#ff7d6b 45%,#2f88c9 55%,#1f5f99 100%)', lv: ['2.4', '4.0', '5.8', '7.0'] },
  { t: tr('群青ハイウェイ', 'Ultramarine Highway'), bg: 'linear-gradient(160deg,#0d1b4d 0%,#1b3f9a 60%,#5b8cff 100%)', lv: [null, null, null, '7.6'] },
  { t: 'Crimson Gate', bg: 'radial-gradient(circle at 50% 60%,#ff3b4f 0 18%,#4a0d1c 19% 45%,#1a0710 46%)', lv: ['5.2', '6.9', '8.3', '9.5'] },
  { t: tr('トワイライト・ラン', 'Twilight Run'), bg: 'linear-gradient(180deg,#3b2a7a 0%,#8a4fa8 55%,#f08a5d 100%)', lv: ['2.7', '4.4', '6.1', '7.4'] },
];

function NxHomeFirst() {
  return (
    <section className="nx-home first">
      <div className="nx-home-main">
        <div className="nx-home-h">
          <LibIcon />
          <div className="nx-home-ttl">
            <span className="row-l">
              <h3>{tr('DTXMania の曲をまとめて扱う', 'Work with all your DTXMania songs')}</h3>
              <span className="nx-new">{tr('新しく', 'New')}</span>
            </span>
            <span className="lbl">{tr('PC の Chrome・Edge で使えます', 'Works in Chrome or Edge on a PC')}</span>
          </div>
        </div>
        <p>
          {tr(
            'DTXMania のフォルダを覚えると、ゲームに入っている曲を、画像・難易度・レベルの一覧から開いて直せます。新しい曲も、その中に保存できます。',
            'Remember your DTXMania folder to open and fix the songs in the game from a list with images, difficulties and levels. New songs can be saved into it too.',
          )}
        </p>
        <NxPickButton after={() => void openNxPage()} />
        <NxPromises />
      </div>
      <div className="nx-home-sample" aria-hidden="true">
        <span className="lbl">{tr('一覧のイメージ', 'What the list looks like')}</span>
        {sample().map((m) => (
          <div key={m.t} className="r">
            <span className="img" style={{ background: m.bg }} />
            <span className="tx">
              <b>{m.t}</b>
              <span className="nx-lv4">
                {m.lv.map((v, i) => (
                  <span key={i} className={v ? SLOT_CLASS[SLOT_KEYS[i]] : 'x'}>
                    {v ?? '+'}
                  </span>
                ))}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** ホームのカードに出すしぼりこみ（作る・直すのに使うもの）。Drive・同期・直した印のしぼりこみは曲の一覧だけ */
const HOME_FILTERS: readonly NxFilter[] = ['missing', 'mylevel', 'bgmdrums', 'draft', 'checks'];

function NxHomeReady() {
  const place = useNxLib((s) => s.place)!;
  const songs = useNxLib((s) => s.songs);
  const boxes = useNxLib((s) => s.boxes);
  const at = useNxLib((s) => s.at);
  const perm = useNxLib((s) => s.perm);
  const scan = useNxLib((s) => s.scan);
  const drafts = useNxLib((s) => s.drafts);
  const bgm = useNxLib((s) => s.bgm);
  const q = useNxLib((s) => s.q);
  const sort = useNxLib((s) => s.sort);
  const box = useNxLib((s) => s.box);
  const filter = useNxLib((s) => s.filter);
  const synced = useSyncedSet();
  const play = usePlayLevel((s) => s.v);
  const list = useMemo(() => viewSongs(songs, { q, sort, box, filter, drafts, synced, bgm, play }), [songs, q, sort, box, filter, drafts, synced, bgm, play]);
  const counts = useMemo(() => filterCounts(songs, { drafts, synced, bgm, play }), [songs, drafts, synced, bgm, play]);
  const charts = useMemo(() => chartCount(songs), [songs]);
  const time = at ? new Date(at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  // 遊ぶレベルを決めていなければ「〜を足せる」は出さない。続き・点検は 1 曲でもあるときだけ
  const tabs = HOME_FILTERS.filter((f) => f === filter || (f === 'mylevel' ? play !== null : f === 'draft' || f === 'checks' ? counts[f] > 0 : true));
  // 曲の一覧で選んだ、カードに無いしぼりこみ（Drive・直した印など）
  const other = filter && !tabs.includes(filter) ? filter : null;
  const boxName = box === null ? null : box === '' ? tr('BOX の外', 'Outside any BOX') : (boxes.find((b) => b.key === box)?.title ?? box);
  const pickFilter = (f: NxFilter | null) => setNxView(f === null || f === filter ? { filter: null } : { filter: f, ...(f === 'checks' ? { sort: 'checks' as NxSort } : {}) });
  return (
    <section className="nx-home" aria-label={tr('DTXMania の曲', 'DTXMania songs')}>
      <div className="nx-home-h">
        <LibIcon />
        <div className="nx-home-ttl">
          <h3>{tr('DTXMania の曲', 'DTXMania songs')}</h3>
          <span className="lbl">{tr(`${songs.length.toLocaleString()} 曲 · 譜面 ${charts.toLocaleString()}`, `${songs.length.toLocaleString()} ${pl(songs.length, 'song')} · ${charts.toLocaleString()} ${pl(charts, 'chart')}`)}</span>
        </div>
        <div className="nx-home-hchips">
          <span className="nx-home-chip" title={place.name}>
            {Icon.folder(12)}
            <span className="ellipsis">
              {place.name}
              {place.kind === 'game' ? tr('（ゲームのフォルダ）', ' (game folder)') : ''}
            </span>
          </span>
          {time && (
            <span className="nx-home-chip">
              {Icon.history(12)}
              {tr(`${time} に読み込み`, `Read ${time}`)}
            </span>
          )}
          <button
            className="nx-home-chip nx-home-guide"
            onClick={() => {
              setNxView({ guide: true });
              void openNxPage();
            }}
            title={tr('DTXMania の曲から作った、レベルの物差しと、あなたの遊ぶレベル', 'The level ruler built from your DTXMania songs, and your playing level')}
          >
            {Icon.chart(12)}
            {tr('難易度ガイドライン', 'Difficulty guidelines')}
            {play !== null && <b className="mono">{tr(`あなた ${play.toFixed(1)}`, `You ${play.toFixed(1)}`)}</b>}
          </button>
        </div>
      </div>
      {perm !== 'granted' && (
        <div className="nx-home-perm">
          {Icon.info(14)}
          <span className="grow">
            {tr(
              '前回の一覧を出しています。曲を開く・読み直すときに、Chrome が読み書きの許可を 1 回聞きます（「毎回許可する」を選ぶと、次からは聞かれません）。',
              'Showing the list from last time. Chrome asks once for permission to read and write when you open a song or reload ("Allow on every visit" stops it asking).',
            )}
          </span>
          <button
            className="btn small"
            onClick={async () => {
              if (await ensureNxPerm()) void rescanNx();
            }}
          >
            {tr('続ける', 'Continue')}
          </button>
        </div>
      )}
      <div className="nx-home-row">
        <form
          className="nx-search"
          onSubmit={(e) => {
            e.preventDefault();
            void openNxPage();
          }}
        >
          {Icon.search(14)}
          <input
            value={q}
            onChange={(e) => setNxView({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) {
                e.preventDefault();
                setNxView({ q: '' });
              }
            }}
            placeholder={tr('曲名・アーティスト・フォルダで探す', 'Search by title, artist or folder')}
            aria-label={tr('曲を探す', 'Search songs')}
          />
          {q && (
            <button type="button" className="ib nx-x" onClick={() => setNxView({ q: '' })} aria-label={tr('消す', 'Clear')}>
              {Icon.close(11)}
            </button>
          )}
        </form>
        <label className="nx-sel nx-home-sort">
          <span className="lbl">{tr('並べ替え', 'Sort')}</span>
          <select value={sort} onChange={(e) => setNxView({ sort: e.target.value as NxSort })}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {sortName(s)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" onClick={() => void openNxPage()} title={tr('いまのしぼりこみのまま、曲の一覧を開きます', 'Opens the song list with the same filters')}>
          {tr('一覧を開く', 'Open the list')}
        </button>
        <button
          className="btn"
          disabled={!!scan}
          onClick={async () => {
            if (perm === 'granted' || (await ensureNxPerm())) void rescanNx();
          }}
        >
          {Icon.refresh(14)}
          {scan ? tr(`読み込み中… ${scan.songs}`, `Reading… ${scan.songs}`) : tr('読み直す', 'Reload')}
        </button>
      </div>
      <div className="nx-home-tabs" role="toolbar" aria-label={tr('しぼりこみ', 'Filters')}>
        <button className={`nx-htab ${filter === null ? 'on' : ''}`} aria-pressed={filter === null} onClick={() => pickFilter(null)}>
          {tr('すべて', 'All')}
          <b className="mono">{songs.length.toLocaleString()}</b>
        </button>
        {tabs.map((f) => (
          <button key={f} className={`nx-htab ${filter === f ? 'on' : ''}`} style={{ '--c': FILTER_COLOR[f] } as CSSProperties} aria-pressed={filter === f} onClick={() => pickFilter(f)}>
            <i className="dot" />
            {filterName(f)}
            <b className="mono">{scan?.first ? '—' : counts[f]}</b>
          </button>
        ))}
        {other && (
          <span className="nx-fchip" style={{ '--c': FILTER_COLOR[other] } as CSSProperties}>
            <i className="dot" />
            {filterName(other)} {counts[other]}
            <button className="ib" onClick={() => setNxView({ filter: null })} aria-label={tr('しぼりこみを外す', 'Clear the filter')}>
              {Icon.close(10)}
            </button>
          </span>
        )}
        {boxName !== null && (
          <span className="nx-fchip nx-home-box" style={{ '--c': '#8fa3ba' } as CSSProperties}>
            {Icon.box(12)}
            {boxName}
            <button className="ib" onClick={() => setNxView({ box: null })} aria-label={tr('BOX を外す', 'Show all BOXes')}>
              {Icon.close(10)}
            </button>
          </span>
        )}
      </div>
      {filter === 'bgmdrums' && <BgmHint />}
      {list.length > 0 ? (
        <NxShelf list={list} viewKey={`${place.at}|${q}|${sort}|${box}|${filter}`} filter={filter} play={play} />
      ) : scan ? (
        <ShelfSkeleton />
      ) : (
        <div className="nx-shelf-empty">
          {songs.length === 0 ? (
            <span className="lbl">{tr('まだ曲がありません。「読み直す」で探します', 'No songs yet. Use "Reload" to search')}</span>
          ) : (
            <>
              <b>{filter ? tr(`「${filterName(filter)}」の曲はありません`, `No songs in “${filterName(filter)}”`) : tr('条件に合う曲がありません', 'No songs match')}</b>
              <button className="btn small" onClick={() => setNxView({ q: '', filter: null, box: null })}>
                {tr('しぼりこみを外す', 'Clear filters')}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** 「BGM にドラム入り」：BGM は曲を選んだときに聞いて調べるので、まだの曲があれば知らせる（まとめて調べるのは曲の一覧で） */
function BgmHint() {
  const songs = useNxLib((s) => s.songs);
  const bgm = useNxLib((s) => s.bgm);
  const { can, checked } = useMemo(() => bgmCheckedCount(songs, bgm), [songs, bgm]);
  if (checked >= can) return null;
  return (
    <div className="nx-home-hint">
      {Icon.info(13)}
      <span className="grow">
        {tr(`BGM を調べた曲だけ出ています（調べた曲 ${checked} / ${can}）。`, `Only songs whose BGM was checked are shown (${checked} of ${can} checked).`)}
      </span>
      <button className="btn small" onClick={() => void openNxPage()}>
        {tr('一覧でまとめて調べる', 'Check them in the list')}
      </button>
    </div>
  );
}

// ---- 曲の棚（横に送る） ------------------------------------------------------------------

const GAP = 12;
/** 前に見ていた棚の所（ホームを離れても覚えておく。見せ方が変わったら頭から） */
let shelfMemo = { key: '', first: 0 };

function NxShelf({ list, viewKey, filter, play }: { list: LibSong[]; viewKey: string; filter: NxFilter | null; play: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [x, setX] = useState(0);
  const sel = useNxLib((s) => s.sel);
  const thumbs = useNxLib((s) => s.thumbs);
  const drafts = useNxLib((s) => s.drafts);
  const n = list.length;
  const per = shelfPerPage(w, GAP);
  const tileW = w > 0 ? (w - GAP * (per - 1)) / per : 160;
  const step = tileW + GAP;
  const max = Math.max(0, n * step - GAP - w);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // 開いたとき（ホームに戻ってきたとき）は前に見ていた所へ。選んでいた曲が見えていなければ、その曲のある頁へ。
  // ホームにいる間にしぼりこみ・並べ替えを変えたら頭から
  const applied = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !w || applied.current === viewKey) return;
    const idx = sel ? list.findIndex((s) => s.id === sel) : -1;
    const first = applied.current === null ? shelfStart(n, per, shelfMemo.key === viewKey ? shelfMemo.first : 0, idx) : 0;
    applied.current = viewKey;
    shelfMemo = { key: viewKey, first };
    el.scrollLeft = first * step;
    setX(el.scrollLeft);
  }, [viewKey, w, n, per, step, sel, list]);
  const first = Math.min(Math.max(0, n - 1), Math.round(x / step));
  // 描くのは見えている所と前後 2 頁だけ（曲が何千あっても軽く）
  const start = Math.max(0, first - per * 2);
  const end = Math.min(n, first + per * 3);
  const go = (d: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, Math.min(max, (first + d * per) * step)), behavior: 'smooth' });
  };
  const shown = Math.min(per, n);
  return (
    <div className="nx-shelf-wrap">
      <div className="nx-shelf">
        <div
          className="nx-shelf-scroll"
          ref={ref}
          tabIndex={0}
          role="list"
          aria-label={tr('曲の棚（← → で送る）', 'Song shelf (← → to scroll)')}
          onScroll={(e) => {
            const left = e.currentTarget.scrollLeft;
            setX(left);
            shelfMemo = { key: viewKey, first: Math.round(left / step) };
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
            e.preventDefault();
            go(e.key === 'ArrowLeft' ? -1 : 1);
          }}
        >
          <div className="nx-shelf-row" style={{ width: Math.max(0, n * step - GAP) }}>
            {start > 0 && <span className="nx-shelf-pad" style={{ width: start * step - GAP }} aria-hidden="true" />}
            {list.slice(start, end).map((s) => (
              <ShelfTile key={s.id} s={s} w={tileW} on={s.id === sel} thumb={thumbs[s.id]} draft={drafts[s.id]} filter={filter} play={play} />
            ))}
          </div>
        </div>
        {x > 2 && (
          <button className="nx-shelf-nav l" style={{ top: tileW / 2 }} onClick={() => go(-1)} aria-label={tr('前の曲', 'Previous songs')} title={tr('前の曲', 'Previous songs')}>
            {Icon.chevronLeft(16)}
          </button>
        )}
        {x < max - 2 && (
          <button className="nx-shelf-nav r" style={{ top: tileW / 2 }} onClick={() => go(1)} aria-label={tr('次の曲', 'Next songs')} title={tr('次の曲', 'Next songs')}>
            {Icon.chevronRight(16)}
          </button>
        )}
      </div>
      <div className="nx-shelf-foot">
        <span className="lbl">{shelfHint(filter)}</span>
        <span className="grow" />
        {n > shown && (
          <span className="nx-shelf-bar" aria-hidden="true">
            <i style={{ left: `${(first / n) * 100}%`, width: `${(shown / n) * 100}%` }} />
          </span>
        )}
        <span className="lbl mono">{n > shown ? `${first + 1}–${Math.min(n, first + shown)} / ${n.toLocaleString()}` : tr(`${n} 曲`, `${n} ${pl(n, 'song')}`)}</span>
      </div>
    </div>
  );
}

function shelfHint(filter: NxFilter | null): string {
  switch (filter) {
    case 'missing':
      return tr('＋ の枠でその難易度を AI で作ります。作り終えた曲はここから外れます', 'A + box makes that difficulty with AI. Songs leave this row once they are complete');
    case 'mylevel':
      return tr('あいだに作ると、その曲はここから外れます', 'Songs leave this row once the chart is made');
    case 'bgmdrums':
      return tr('ドラム抜きの BGM にすると、その曲はここから外れます', 'Songs leave this row once the BGM has no drums');
    default:
      return tr('ジャケットで開く · レベルの枠でその難易度を開く', 'Press a cover to open · a level box opens that difficulty');
  }
}

function ShelfSkeleton() {
  return (
    <div className="nx-shelf-row skel" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="nx-stile skel">
          <span className="art" />
          <i className="sk" style={{ width: 70 + ((i * 37) % 60), height: 11 }} />
        </span>
      ))}
    </div>
  );
}

/** タイルの下のボタン（しぼりこみに合わせて、その曲でいちばんしたいこと） */
function tileTask(s: LibSong, filter: NxFilter | null, play: number | null, draft: readonly string[] | undefined): { k: string; icon: ReactNode; label: string; title?: string; run: () => void } | null {
  switch (filter) {
    case 'missing': {
      const add = addableSlots(s);
      if (!add.length) return null;
      // いちばん上に近い空いた難易度（AI難易度生成では、ほかの空いた難易度も一緒に作れる）
      const k = add[add.length - 1];
      return {
        k: 'ai',
        icon: Icon.sparkle(11),
        // タイルの幅に入るよう、難易度は BSC・ADV・EXT と短く（一覧の枠と同じ）
        label: add.length > 1 ? tr(`${add.length} つを AI で作る`, `Make ${add.length} with AI`) : tr(`${k} を AI で作る`, `Make ${k} with AI`),
        title: tr(`AI難易度生成で ${add.map((x) => SLOT_LABEL[x]).join('・')} を作ります`, `Makes ${add.map((x) => SLOT_LABEL[x]).join(', ')} with the AI generator`),
        run: () => void openNxGen(s, k),
      };
    }
    case 'mylevel':
      if (play === null || !canAddLevel(s, play)) return null;
      return { k: 'ai', icon: Icon.sparkle(11), label: tr(`${play.toFixed(1)} をあいだに作る`, `Make a ${play.toFixed(1)} in between`), run: () => void openNxInsert(s, play) };
    case 'bgmdrums':
      if (!canSeparate(s)) return null;
      return {
        k: 'stem',
        icon: Icon.layers(11),
        label: tr('ステム分解する', 'Split the stems'),
        title: tr('ドラムとドラム抜きに分けて、ドラム抜きを BGM にします', 'Splits drums from the rest and makes the no-drums mix the BGM'),
        run: () => void openNxSeparate(s),
      };
    case 'draft': {
      const f = draft?.[0]?.toLowerCase();
      const c = f ? s.charts.find((x) => x.file.toLowerCase() === f) : undefined;
      return { k: 'draft', icon: Icon.pencil(11), label: tr('続きを開く', 'Open unsaved work'), run: () => void openNxSong(s, c) };
    }
    case 'checks': {
      const w = warnCount(s);
      return { k: 'warn', icon: Icon.warn(11), label: w ? tr(`点検 ${w} を一覧で見る`, `See ${w} ${pl(w, 'issue')} in the list`) : tr('点検を一覧で見る', 'See the checks in the list'), run: () => void openNxPage() };
    }
    default:
      return null;
  }
}

function ShelfTile({ s, w, on, thumb, draft, filter, play }: { s: LibSong; w: number; on: boolean; thumb?: string; draft?: readonly string[]; filter: NxFilter | null; play: number | null }) {
  const task = tileTask(s, filter, play, draft);
  const pick = () => setNxView({ sel: s.id });
  const ch = [...(s.title || '?')][0];
  return (
    <div className={`nx-stile ${on ? 'on' : ''}`} style={{ width: w }} role="listitem">
      <button
        className="nx-stile-open"
        onClick={() => {
          pick();
          void openNxSong(s);
        }}
        title={`${s.title}${s.artist ? ` / ${s.artist}` : ''}\n${s.path.join('/')}`}
      >
        <span className="art">
          {thumb && s.image ? (
            <img src={thumb} alt="" draggable={false} loading="lazy" />
          ) : (
            <span className="nx-tile-ph" style={{ '--h': ch.codePointAt(0)! % 360 } as CSSProperties}>
              {ch}
            </span>
          )}
          {(draft?.length ?? 0) > 0 && <i className="nx-stile-draft" title={tr('保存していない続きがあります', 'Has unsaved changes')} />}
        </span>
        <span className="t">{s.title || tr('曲名なし', 'Untitled')}</span>
      </button>
      <button
        className="nx-stile-look"
        onClick={() => {
          pick();
          void openNxPage();
        }}
        title={tr('一覧でこの曲を見る（成績・点検・あいだに作る）', 'See this song in the list (records, checks, make one in between)')}
        aria-label={tr(`「${s.title}」を一覧で見る`, `See “${s.title}” in the list`)}
      >
        {Icon.menu(12)}
      </button>
      <TileLevels
        s={s}
        hot={filter === 'missing'}
        onOpen={(k) => {
          pick();
          void openNxSong(s, chartIn(s, k));
        }}
        onAdd={(k) => {
          pick();
          void openNxGen(s, k);
        }}
      />
      {task && (
        <button
          className={`nx-stile-act ${task.k}`}
          title={task.title}
          onClick={() => {
            pick();
            task.run();
          }}
        >
          {task.icon}
          <span className="ellipsis">{task.label}</span>
        </button>
      )}
    </div>
  );
}

/** 4 つの難易度のレベル。押すとその難易度を開く。空いた枠の ＋（いちばん上の譜面より下だけ）は AI難易度生成 */
function TileLevels({ s, hot, onOpen, onAdd }: { s: LibSong; hot: boolean; onOpen: (k: SlotKey) => void; onAdd: (k: SlotKey) => void }) {
  const add = new Set(addableSlots(s));
  return (
    <span className={`nx-lv4 nx-stile-lv ${hot ? 'hot' : ''}`}>
      {SLOT_KEYS.map((k) => {
        const c = chartIn(s, k);
        if (c) {
          const t = tr(`${SLOT_LABEL[k]} ${levelText(c.head.level)} を開く`, `Open ${SLOT_LABEL[k]} ${levelText(c.head.level)}`);
          return (
            <button key={k} type="button" className={SLOT_CLASS[k]} onClick={() => onOpen(k)} title={t} aria-label={t}>
              {shortLevel(c.head.level)}
            </button>
          );
        }
        if (add.has(k)) {
          const t = tr(`${SLOT_LABEL[k]} を AI難易度生成で作る`, `Make ${SLOT_LABEL[k]} with the AI generator`);
          return (
            <button key={k} type="button" className="x" onClick={() => onAdd(k)} title={t} aria-label={t}>
              +
            </button>
          );
        }
        return <span key={k} className="none" />;
      })}
    </span>
  );
}
