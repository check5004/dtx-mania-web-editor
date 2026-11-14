// ホーム（PC）の「DTXMania の曲」のカード。まだなら場所を選ぶ入口（一覧のイメージつき）、覚えていれば一覧への入口と最近変わった曲。
import { tr, pl, locale } from '../../i18n';
import { useMemo, useState, type CSSProperties } from 'react';
import { openNxPage, openNxSong } from '../../nxlib/actions';
import { SLOT_KEYS, type LibSong } from '../../nxlib/scan';
import { ensureNxPerm, rescanNx, setNxView, useNxLib } from '../../nxlib/store';
import { addableSlots, chartCount, chartIn, filterCounts, type NxFilter } from '../../nxlib/view';
import { usePlayLevel } from '../../store/playLevel';
import { Icon } from '../icons';
import { FILTER_COLOR, NxPickButton, NxPromises, filterName, useSyncedSet } from './SongsPage';
import { SLOT_CLASS } from './parts';
import { songKey, usePcSync } from '../../sync/store';
import { SyncedTiles, SyncNextChip } from '../sync/home';

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

/** レベル（8.25 は「8.25」、3.50 は「3.5」） */
function shortLevel(n: number | null): string {
  return n === null ? '?' : String(Number(n.toFixed(2)));
}

/** 4 つの難易度のレベル（小さい帯）。空いた枠は、作れるなら「＋」 */
function LevelStrip({ s }: { s: LibSong }) {
  const add = new Set(addableSlots(s));
  return (
    <span className="nx-lv4">
      {SLOT_KEYS.map((k) => {
        const c = chartIn(s, k);
        if (c) return <span key={k} className={SLOT_CLASS[k]}>{shortLevel(c.head.level)}</span>;
        return (
          <span key={k} className={add.has(k) ? 'x' : 'none'}>
            {add.has(k) ? '+' : ''}
          </span>
        );
      })}
    </span>
  );
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

function NxHomeReady() {
  const place = useNxLib((s) => s.place)!;
  const songs = useNxLib((s) => s.songs);
  const at = useNxLib((s) => s.at);
  const perm = useNxLib((s) => s.perm);
  const scan = useNxLib((s) => s.scan);
  const thumbs = useNxLib((s) => s.thumbs);
  const drafts = useNxLib((s) => s.drafts);
  const [q, setQ] = useState('');
  const syncOn = usePcSync((s) => s.settings.on);
  const synced = useSyncedSet();
  const play = usePlayLevel((s) => s.v);
  const counts = useMemo(() => filterCounts(songs, drafts, synced, play), [songs, drafts, synced, play]);
  // 同期で変わった曲があれば、最近変わった曲の代わりに出す
  const showSynced = useMemo(() => !!synced && songs.some((s) => synced.has(songKey(s))), [songs, synced]);
  const recent = useMemo(() => [...songs].sort((a, b) => b.updated - a.updated).slice(0, 6), [songs]);
  const charts = useMemo(() => chartCount(songs), [songs]);
  const open = (p: Parameters<typeof setNxView>[0] = {}) => {
    setNxView({ q: '', box: null, filter: null, ...p });
    void openNxPage();
  };
  const quick: NxFilter[] = syncOn ? ['synced', 'drive', 'checks'] : ['missing', 'checks', 'draft'];
  const time = at ? new Date(at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <section className="nx-home">
      <div className="nx-home-h">
        <LibIcon />
        <div className="nx-home-ttl">
          <h3>{tr('DTXMania の曲', 'DTXMania songs')}</h3>
          <span className="lbl">{tr(`${songs.length.toLocaleString()} 曲 · 譜面 ${charts.toLocaleString()}`, `${songs.length.toLocaleString()} ${pl(songs.length, 'song')} · ${charts.toLocaleString()} ${pl(charts, 'chart')}`)}</span>
        </div>
        <span className="grow" />
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
        <SyncNextChip />
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
            open({ q: q.trim() });
          }}
        >
          {Icon.search(14)}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('曲名・アーティスト・フォルダで探す', 'Search by title, artist or folder')} aria-label={tr('曲を探す', 'Search songs')} />
        </form>
        <button className="btn primary" onClick={() => open()}>
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
      {showSynced && <SyncedTiles thumbs={thumbs} />}
      {!showSynced && (
        <div className="nx-home-sub">
          <span className="lbl">{tr('最近変わった曲', 'Recently changed')}</span>
          <span className="lbl">{tr('押すと開きます', 'Press to open')}</span>
        </div>
      )}
      {showSynced ? null : recent.length > 0 ? (
        <div className="nx-tiles">
          {recent.map((s) => (
            <button key={s.id} className="nx-tile" onClick={() => void openNxSong(s)} title={s.path.join('/')}>
              {thumbs[s.id] && s.image ? (
                <img src={thumbs[s.id]} alt="" draggable={false} />
              ) : (
                <span className="nx-tile-ph" style={{ '--h': [...(s.title || '?')][0].codePointAt(0)! % 360 } as CSSProperties}>
                  {[...(s.title || '?')][0]}
                </span>
              )}
              <span className="t">{s.title}</span>
              <LevelStrip s={s} />
            </button>
          ))}
        </div>
      ) : (
        <span className="lbl">{scan ? tr('読み込んでいます…', 'Reading…') : tr('まだ曲がありません', 'No songs yet')}</span>
      )}
      <div className="nx-home-quick">
        <button onClick={() => open({ guide: true })} title={tr('DTXMania の曲から作った、レベルの物差しと、あなたの遊ぶレベル', 'The level ruler built from your DTXMania songs, and your playing level')}>
          {Icon.chart(12)}
          {tr('難易度ガイドライン', 'Difficulty guidelines')}
          {play !== null && <b className="mono">{tr(`あなた ${play.toFixed(1)}`, `You ${play.toFixed(1)}`)}</b>}
        </button>
        {quick.map((f) => (
          <button key={f} onClick={() => open({ filter: f, ...(f === 'checks' ? { sort: 'checks' as const } : {}) })}>
            <i className="dot" style={{ background: FILTER_COLOR[f] }} />
            {filterName(f)}
            <b className="mono">{counts[f]}</b>
            {tr('曲', pl(counts[f], 'song'))}
          </button>
        ))}
      </div>
    </section>
  );
}
