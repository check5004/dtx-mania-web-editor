// PC どうしの同期をはじめる・設定を変える画面（PC の名前・合わせる曲・一緒に合わせるもの・Drive の空き・いつ合わせるか）と、
// 「全部の曲」を選んだときの容量の警告。大きさは曲のフォルダのファイルの大きさを数える（中身は読まない）。
import { useEffect, useMemo, useState } from 'react';
import { pl, tr } from '../../i18n';
import { signIn, tokenValid, useDriveAuth } from '../../drive/auth';
import type { LibSong } from '../../nxlib/scan';
import { ensureNxPerm, pickNxPlace, useNxLib } from '../../nxlib/store';
import { boxRel, boxRootKey, bytesText } from '../../nxlib/view';
import { driveSpace, inScope, libKeyFn, measureSongs, openSyncPanel, previewFirst, saveSettings, songKey, stopPcSync, syncNow, usePcSync, type LibKeyFn, type SongSize } from '../../sync/store';
import { DEFAULT_SETTINGS, type SyncSettings } from '../../sync/types';
import { confirmDialog } from '../dialogs';
import { Icon } from '../icons';

type Draft = Pick<SyncSettings, 'pc' | 'scope' | 'boxes' | 'songs' | 'video' | 'scores' | 'scoresOnly'>;

/** 無料の Google Drive（15 GB） */
const FREE_LIMIT = 16 * (1 << 30);
/** はじめの送信のめやす（上り 10 Mbps） */
const UP_BPS = 10_000_000;

/** 送るのにかかる時間のめやす */
function upTime(bytes: number): string {
  const s = (bytes * 8) / UP_BPS;
  if (s < 3600) {
    const m = Math.max(1, Math.round(s / 60));
    return tr(`約 ${m} 分`, `about ${m} ${pl(m, 'minute')}`);
  }
  const h = Math.round(s / 3600);
  return tr(`約 ${h} 時間`, `about ${h} ${pl(h, 'hour')}`);
}

function planName(limit: number): string {
  return limit <= FREE_LIMIT ? tr('無料 15 GB', 'free 15 GB') : bytesText(limit);
}

/** 曲・BOX の場所 → Drive での並び（DTXMania の曲を読み直したら作り直す） */
function useLibKeyFn(): LibKeyFn | null {
  const place = useNxLib((s) => s.place);
  const songs = useNxLib((s) => s.songs);
  const boxes = useNxLib((s) => s.boxes);
  const [fn, setFn] = useState<LibKeyFn | null>(null);
  useEffect(() => {
    let live = true;
    void libKeyFn().then((f) => live && setFn(() => f));
    return () => {
      live = false;
    };
  }, [place, songs, boxes]);
  return fn;
}

/** 曲のフォルダの大きさを数える（合わせる曲から先に。数えた所から出す） */
function useSongSizes(folders: readonly LibSong[], first: (s: LibSong) => boolean, granted: boolean): Map<string, SongSize> {
  const [sizes, setSizes] = useState<Map<string, SongSize>>(() => new Map());
  useEffect(() => {
    if (!granted) return;
    let stop = false;
    void (async () => {
      const order = [...folders].sort((a, b) => Number(first(b)) - Number(first(a)));
      const acc = new Map<string, SongSize>();
      for (let i = 0; i < order.length && !stop; i += 12) {
        const part = await measureSongs(order.slice(i, i + 12), undefined, () => stop);
        for (const [k, v] of part) acc.set(k, v);
        if (!stop) setSizes(new Map(acc));
      }
    })();
    return () => {
      stop = true;
    };
    // first は並べ方だけ（変わっても数え直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, granted]);
  return sizes;
}

type Space = { limit: number | null; usage: number } | null | undefined;

function useDriveSpace(): Space {
  const token = useDriveAuth((a) => a.token);
  const [space, setSpace] = useState<Space>(undefined);
  useEffect(() => {
    let live = true;
    if (!token || !tokenValid()) {
      setSpace(null);
      return;
    }
    setSpace(undefined);
    void driveSpace().then((s) => live && setSpace(s));
    return () => {
      live = false;
    };
  }, [token]);
  return space;
}

/** 合わせる曲の数と大きさ */
interface Total {
  n: number;
  /** 大きさを数え終えた曲 */
  known: number;
  bytes: number;
  video: number;
  score: number;
  /** もう Drive にある分（前に送った曲） */
  onDrive: number;
  charts: number;
}

const emptyTotal = (): Total => ({
  n: 0,
  known: 0,
  bytes: 0,
  video: 0,
  score: 0,
  onDrive: 0,
  charts: 0,
});

function addTo(t: Total, s: LibSong, sz: SongSize | undefined) {
  t.n++;
  t.charts += s.charts.length;
  if (!sz) return;
  t.known++;
  t.bytes += sz.bytes;
  t.video += sz.video;
  t.score += sz.score;
  if (s.drive?.state === 'linked' && !s.drive.play) t.onDrive += Math.min(sz.bytes, s.drive.bytes);
}

/** 送る大きさ（動画・成績を除くか。もう Drive にある分は引く） */
function sendBytes(t: Total, video: boolean, scores: boolean): number {
  return Math.max(0, t.bytes - (video ? 0 : t.video) - (scores ? 0 : t.score) - t.onDrive);
}

function sizeText(t: Total): string {
  if (!t.n) return '0';
  if (!t.known) return '…';
  return `${bytesText(t.bytes)}${t.known < t.n ? '+' : ''}`;
}

export function SetupPanel() {
  const settings = usePcSync((s) => s.settings);
  const songs = useNxLib((s) => s.songs);
  const boxes = useNxLib((s) => s.boxes);
  const place = useNxLib((s) => s.place);
  const perm = useNxLib((s) => s.perm);
  const token = useDriveAuth((a) => a.token);
  const [d, setD] = useState<Draft>(() => ({
    pc: settings.pc || tr('作るPC', 'Making PC'),
    scope: settings.scope,
    boxes: settings.boxes,
    songs: settings.songs,
    video: settings.video,
    scores: settings.scores,
    scoresOnly: settings.scoresOnly,
  }));
  const [view, setView] = useState<'setup' | 'warn'>('setup');
  const [pick, setPick] = useState(false);
  const [q, setQ] = useState('');
  const keyFn = useLibKeyFn();
  const space = useDriveSpace();
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  // 曲のフォルダごとに 1 つ（set.def の曲は 1 フォルダに何曲もある）と、Drive での並び
  const folders = useMemo(() => {
    const seen = new Set<string>();
    return songs.filter((s) => {
      const k = songKey(s);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [songs]);
  const keys = useMemo(() => new Map(folders.map((s) => [songKey(s), keyFn?.(s.root, s.path) ?? null])), [folders, keyFn]);
  const madeOf = (s: LibSong) => inScope(s, { ...DEFAULT_SETTINGS, ...d, scope: 'made', on: true }, keys.get(songKey(s)) ?? null) === 'all';
  const sizes = useSongSizes(folders, madeOf, perm === 'granted');

  const totals = useMemo(() => {
    const made = emptyTotal();
    const all = emptyTotal();
    const rest = emptyTotal();
    for (const s of folders) {
      const lk = keys.get(songKey(s));
      if (lk === null || lk === undefined) continue;
      const sz = sizes.get(songKey(s));
      addTo(all, s, sz);
      if (inScope(s, { ...DEFAULT_SETTINGS, ...d, scope: 'made', on: true }, lk) === 'all') addTo(made, s, sz);
      else if (s.drive?.state !== 'skip') addTo(rest, s, sz);
    }
    return { made, all, rest };
  }, [folders, keys, sizes, d]);
  const cur = d.scope === 'all' ? totals.all : totals.made;
  const need = sendBytes(cur, d.video, d.scores);

  // BOX と、探した曲（足す・外す）
  const boxList = useMemo(
    () =>
      boxes
        .map((b) => {
          const lk = keyFn?.(boxRootKey(b), boxRel(b)) ?? null;
          return {
            key: b.key,
            title: b.title,
            depth: b.depth,
            lk,
            n: lk ? folders.filter((s) => keys.get(songKey(s))?.startsWith(`${lk}/`)).length : 0,
          };
        })
        .filter((b): b is typeof b & { lk: string } => !!b.lk),
    [boxes, keyFn, folders, keys],
  );
  const found = useMemo(() => {
    const w = q.trim().toLowerCase();
    if (!w) return [];
    return folders.filter((s) => keys.get(songKey(s)) && `${s.title}\u0000${s.artist}\u0000${s.path.join('/')}`.toLowerCase().includes(w)).slice(0, 40);
  }, [q, folders, keys]);
  const boxTitle = (lk: string) => boxList.find((b) => b.lk === lk)?.title ?? lk.split('/').pop() ?? lk;
  const songTitle = (lk: string) => folders.find((s) => keys.get(songKey(s)) === lk)?.title ?? lk.split('/').pop() ?? lk;
  const toggleIn = (list: string[], lk: string) => (list.includes(lk) ? list.filter((x) => x !== lk) : [...list, lk]);

  const close = () => openSyncPanel(null);
  const signedIn = !!token && tokenValid();
  const name = d.pc.trim();

  const next = () => {
    const p = { ...d, pc: name };
    if (!signedIn) {
      // 小窓は操作の中で開く
      void signIn({ action: 'connect' }).then((ok) => ok && void previewFirst(p));
      return;
    }
    void previewFirst(p);
  };
  const saveAndSync = () => {
    saveSettings({ ...d, pc: name });
    openSyncPanel(null);
    syncNow();
  };
  const stop = async () => {
    const ok = await confirmDialog({
      title: tr('PC どうしの同期をやめますか？', 'Stop syncing between PCs?'),
      body: tr(
        'Google Drive の曲と、この PC の曲は、どちらもそのまま残ります。また始めると、続きから合わせます。',
        'The songs on Google Drive and on this PC both stay as they are. Start again to pick up where you left off.',
      ),
      ok: tr('同期をやめる', 'Stop syncing'),
    });
    if (!ok) return;
    stopPcSync();
    openSyncPanel(null);
  };

  if (view === 'warn') {
    return (
      <WarnView
        all={totals.all}
        made={totals.made}
        space={space}
        onBack={() => setView('setup')}
        onMade={(addBox) => {
          set({ scope: 'made' });
          if (addBox) setPick(true);
          setView('setup');
        }}
        onAll={(noVideo) => {
          set({ scope: 'all', ...(noVideo ? { video: false } : {}) });
          setView('setup');
        }}
      />
    );
  }

  const free = space && space.limit !== null ? space.limit - space.usage : null;
  return (
    <div className="ps-modal" role="dialog" aria-modal="true" aria-label={tr('PC どうしの同期', 'PC sync')}>
      <div className="ps-mh">
        <span className="ps-mi">{Icon.cloud(20)}</span>
        <div className="grow">
          <h2>{settings.on ? tr('PC どうしの同期の設定', 'PC sync settings') : tr('Google Drive で PC どうしを同期する', 'Sync your PCs through Google Drive')}</h2>
          <p>
            {tr(
              '作る PC で直した曲は遊ぶ PC の DTXMania へ、遊ぶ PC の成績は作る PC へ。同じ Google アカウントの Drive を通して、ファイルごとに比べて合わせます。',
              'Songs fixed on the PC you make on go to DTXMania on the PC you play on, and records go the other way. Files are compared one by one through the Drive of the same Google account.',
            )}
          </p>
        </div>
        <button className="ib" onClick={close} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
          {Icon.close(14)}
        </button>
      </div>
      <div className="ps-flow">
        <span className="pcb">{tr('作るPC：譜面・音・画像', 'Making PC: charts, sounds, images')}</span>
        <span className="arr">⇄</span>
        <span className="pcb drive">
          {Icon.cloud(12)}
          Google Drive
        </span>
        <span className="arr">⇄</span>
        <span className="pcb">{tr('遊ぶPC：成績・ゴースト', 'Playing PC: records, ghosts')}</span>
        <span className="lbl">{tr('どちら向きにも流れます', 'Both ways')}</span>
      </div>

      {!place ? (
        <div className="nx-notice info">
          {Icon.info(14)}
          <div>
            <span>
              {tr(
                '先に DTXMania のフォルダを選んでください。そのフォルダの曲を Drive の「DTX Web Editor / DTXFiles」と合わせます。',
                'Choose your DTXMania folder first. Its songs are synced with "DTX Web Editor / DTXFiles" on Drive.',
              )}
            </span>
            <div className="nx-notice-acts">
              <button className="btn small primary" onClick={() => void pickNxPlace()}>
                {Icon.folder(13)}
                {tr('DTXMania のフォルダを選ぶ…', 'Choose the DTXMania folder…')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="ps-st">
            <span className="ps-num">1</span>
            <div className="ps-sb">
              <span className="h">{tr('この PC の名前', 'Name of this PC')}</span>
              <div className="ps-row">
                <input className="ps-field" value={d.pc} maxLength={20} onChange={(e) => set({ pc: e.target.value })} aria-label={tr('この PC の名前', 'Name of this PC')} />
                {[tr('作るPC', 'Making PC'), tr('遊ぶPC', 'Playing PC'), tr('ノートPC', 'Laptop')].map((n) => (
                  <button key={n} className={`ps-c ${d.pc === n ? 'on' : ''}`} onClick={() => set({ pc: n })}>
                    {n}
                  </button>
                ))}
              </div>
              <span className="lbl">
                {tr(
                  'どちらの PC でも作れて遊べます。名前は「どの PC で変わったか」として記録と知らせに出すだけです。',
                  'Either PC can make and play. The name only shows in the log and notices as "which PC changed it".',
                )}
              </span>
            </div>
          </div>

          <div className="ps-st">
            <span className="ps-num">2</span>
            <div className="ps-sb">
              <span className="h">
                {tr('合わせる曲', 'Songs to sync')}
                {perm !== 'granted' && (
                  <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => void ensureNxPerm()}>
                    {tr('許可して大きさを数える', 'Allow access to count sizes')}
                  </button>
                )}
              </span>
              <div
                className={`ps-opt ${d.scope === 'made' ? 'on' : ''}`}
                role="radio"
                aria-checked={d.scope === 'made'}
                tabIndex={0}
                onClick={() => set({ scope: 'made' })}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && set({ scope: 'made' })}
              >
                <span className="ps-radio" />
                <div className="ps-ob">
                  <span className="t">
                    {tr('作った曲', 'Songs you made')}
                    <span className="rec">{tr('おすすめ', 'Recommended')}</span>
                    <span className="sz">{sizeText(totals.made)}</span>
                  </span>
                  <span className="d">
                    {tr(
                      `このアプリで直した・保存した曲と、足した曲・BOX（${totals.made.n} 曲）。これから作る曲も、保存すると入ります。`,
                      `Songs fixed or saved in this app, plus songs and BOXes you add (${totals.made.n} ${pl(totals.made.n, 'song')}). Songs you make from now on join when you save them.`,
                    )}
                  </span>
                  <div className="ps-row" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                    {d.boxes.map((b) => (
                      <span key={`b:${b}`} className="ps-c box static">
                        {Icon.box(12)}
                        {tr(`${boxTitle(b)}（BOX ごと）`, `${boxTitle(b)} (whole BOX)`)}
                        <button className="ib x" onClick={() => set({ boxes: d.boxes.filter((x) => x !== b) })} aria-label={tr('外す', 'Remove')}>
                          {Icon.close(10)}
                        </button>
                      </span>
                    ))}
                    {d.songs.map((s) => (
                      <span key={`s:${s}`} className="ps-c box static">
                        {songTitle(s)}
                        <button className="ib x" onClick={() => set({ songs: d.songs.filter((x) => x !== s) })} aria-label={tr('外す', 'Remove')}>
                          {Icon.close(10)}
                        </button>
                      </span>
                    ))}
                    <button className="ps-c add" onClick={() => setPick((p) => !p)} aria-expanded={pick}>
                      {Icon.plus(12)}
                      {tr('曲・BOX を足す…', 'Add songs or BOXes…')}
                    </button>
                  </div>
                  {pick && (
                    <div className="ps-pick" onClick={(e) => e.stopPropagation()}>
                      <input
                        className="ps-field"
                        style={{ width: '100%' }}
                        value={q}
                        placeholder={tr('曲名・アーティスト・フォルダで探す', 'Search by title, artist or folder')}
                        onChange={(e) => setQ(e.target.value)}
                      />
                      {found.length > 0 && <div className="sh">{tr('曲', 'Songs')}</div>}
                      {found.map((s) => {
                        const lk = keys.get(songKey(s))!;
                        const already =
                          inScope(
                            s,
                            {
                              ...DEFAULT_SETTINGS,
                              ...d,
                              songs: [],
                              scope: 'made',
                              on: true,
                            },
                            lk,
                          ) === 'all';
                        return (
                          <label key={songKey(s)}>
                            <input type="checkbox" checked={already || d.songs.includes(lk)} disabled={already} onChange={() => set({ songs: toggleIn(d.songs, lk) })} />
                            <span className="ellipsis">
                              {s.title || s.path[s.path.length - 1]}
                              {s.artist && <span className="lbl"> · {s.artist}</span>}
                            </span>
                            <span className="n">{already ? tr('入っています', 'Included') : s.path.join('/')}</span>
                          </label>
                        );
                      })}
                      <div className="sh">BOX</div>
                      {boxList.map((b) => (
                        <label key={b.key} style={{ paddingLeft: 7 + b.depth * 12 }}>
                          <input type="checkbox" checked={d.boxes.includes(b.lk)} onChange={() => set({ boxes: toggleIn(d.boxes, b.lk) })} />
                          {Icon.box(12)}
                          <span className="ellipsis">{b.title}</span>
                          <span className="n">{tr(`${b.n} 曲`, `${b.n} ${pl(b.n, 'song')}`)}</span>
                        </label>
                      ))}
                      {boxList.length === 0 && <span className="lbl">{tr('BOX がありません', 'No BOXes')}</span>}
                    </div>
                  )}
                </div>
              </div>
              <div
                className={`ps-opt ${d.scope === 'all' ? 'on' : ''}`}
                role="radio"
                aria-checked={d.scope === 'all'}
                tabIndex={0}
                onClick={() => d.scope !== 'all' && setView('warn')}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && d.scope !== 'all' && setView('warn')}
              >
                <span className="ps-radio" />
                <div className="ps-ob">
                  <span className="t">
                    {tr('全部の曲', 'All songs')}
                    <span className="sz">{sizeText(totals.all)}</span>
                  </span>
                  <span className="d">
                    {tr(
                      `DTXMania の曲に入っている全部の曲（${totals.all.n} 曲）。選ぶと、大きさと Drive の空きを確かめる画面が出ます。`,
                      `Every song in your DTXMania songs (${totals.all.n}). Choosing it shows a screen to check the size against your free Drive space.`,
                    )}
                  </span>
                  {free !== null && totals.all.known > 0 && sendBytes(totals.all, d.video, d.scores) > free && (
                    <span className="d bad">
                      {Icon.warn(12)}
                      {space && space.limit !== null && space.limit <= FREE_LIMIT && sendBytes(totals.all, d.video, d.scores) > space.limit
                        ? tr('無料の Google Drive（15 GB）には入りません', "Won't fit in free Google Drive (15 GB)")
                        : tr('Drive の空きに入りません', "Won't fit in your free Drive space")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="ps-st">
            <span className="ps-num">3</span>
            <div className="ps-sb">
              <span className="h">{tr('一緒に合わせるもの', 'Also sync')}</span>
              <label className="ps-check">
                <input
                  type="checkbox"
                  checked={d.scores}
                  onChange={(e) =>
                    set({
                      scores: e.target.checked,
                      ...(e.target.checked ? {} : { scoresOnly: false }),
                    })
                  }
                />
                <span className="tx">
                  {tr('成績とゴースト（DTXMania が書く *.score.ini・*.ghost）', 'Records and ghosts (*.score.ini, *.ghost written by DTXMania)')}
                  <small>
                    {tr(
                      '合わせる曲の分。小さいファイルです。両方の PC で遊んでも、いい記録を残して回数は足します',
                      'For the synced songs. Small files. Even if you play on both PCs, the better records are kept and play counts are added up',
                    )}
                  </small>
                </span>
                <span className="sz">{bytesText(cur.score)}</span>
              </label>
              <label className="ps-check">
                <input type="checkbox" checked={d.video} onChange={(e) => set({ video: e.target.checked })} />
                <span className="tx">
                  {tr('動画（BGA）も送る', 'Send videos (BGA) too')}
                  <small>{tr('外すと動画はこの PC にだけ残り、ほかの PC では動画なしで遊びます', 'If off, videos stay only on this PC and other PCs play without them')}</small>
                </span>
                <span className="sz">{bytesText(cur.video)}</span>
              </label>
              <label className="ps-check" style={d.scores ? undefined : { opacity: 0.5 }}>
                <input type="checkbox" checked={d.scoresOnly && d.scores} disabled={!d.scores || d.scope === 'all'} onChange={(e) => set({ scoresOnly: e.target.checked })} />
                <span className="tx">
                  {tr('同期しない曲も、成績だけ合わせる', 'Sync records for the other songs too')}
                  <small>
                    {d.scope === 'all'
                      ? tr('全部の曲を合わせるので、成績も全部合わせます', 'All songs are synced, so all records are too')
                      : tr(
                          `両方の PC にある曲の成績をそろえます。${totals.rest.charts.toLocaleString()} 譜面ぶん。はじめは時間がかかります`,
                          `Keeps records in step for songs on both PCs. ${totals.rest.charts.toLocaleString()} ${pl(totals.rest.charts, 'chart')}. The first time takes a while`,
                        )}
                  </small>
                </span>
                <span className="sz">{d.scope === 'all' ? '' : tr(`約 ${bytesText(totals.rest.score)}`, `about ${bytesText(totals.rest.score)}`)}</span>
              </label>
            </div>
          </div>

          <div className="ps-st">
            <span className="ps-num">4</span>
            <div className="ps-sb">
              <span className="h">
                {tr('Google Drive の空き', 'Free space on Google Drive')}
                {space && space.limit !== null && (
                  <span className="lbl">{tr(`${planName(space.limit)}（Gmail・Google フォトと共有）`, `${planName(space.limit)} (shared with Gmail and Google Photos)`)}</span>
                )}
              </span>
              <SpaceBar space={space} need={need} newLabel={tr('この同期', 'This sync')} onSignIn={() => void signIn({ action: 'connect' })} />
            </div>
          </div>

          <div className="ps-st">
            <span className="ps-num">5</span>
            <div className="ps-sb">
              <span className="h">{tr('いつ合わせるか', 'When to sync')}</span>
              <div className="ps-row">
                {[
                  tr('アプリを開いたとき', 'When the app opens'),
                  tr('開いている間は 5 分ごと', 'Every 5 minutes while open'),
                  tr('曲を保存したとき（その曲）', 'When you save a song (that song)'),
                  tr('「今すぐ同期」を押したとき', 'When you press "Sync now"'),
                ].map((t) => (
                  <span key={t} className="ps-c static">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="ps-foot">
        {settings.on ? (
          <>
            <button className="btn ghost" onClick={() => void stop()}>
              {tr('同期をやめる…', 'Stop syncing…')}
            </button>
            <span className="lbl">{tr('変えた設定は、次の同期から使います。', 'Changed settings apply from the next sync.')}</span>
            <button className="btn ghost" onClick={close}>
              {tr('閉じる', 'Close')}
            </button>
            <button className="btn primary" disabled={!place || !name} onClick={saveAndSync}>
              {tr('保存して同期', 'Save and sync')}
            </button>
          </>
        ) : (
          <>
            <span className="lbl">
              {tr(
                '2 台目の PC でも、ここから始めます。Drive にある曲とこの PC の曲を比べて、始める前に何が起きるかを見せます。',
                'Start here on your second PC too. The songs on Drive and on this PC are compared, and you see what will happen before anything starts.',
              )}
            </span>
            <button className="btn ghost" onClick={close}>
              {tr('やめる', 'Cancel')}
            </button>
            <button className="btn primary" disabled={!place || !name} onClick={next}>
              {signedIn ? tr('次へ：何が起きるか見る', 'Next: see what will happen') : tr('Google Drive にログインして次へ', 'Sign in to Google Drive and continue')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Drive の空きの帯（使っている・この同期・空き。入らなければ赤） */
function SpaceBar({ space, need, newLabel, onSignIn, big }: { space: Space; need: number; newLabel: string; onSignIn: () => void; big?: boolean }) {
  if (space === undefined) return <span className="lbl">{tr('Drive の空きを読んでいます…', 'Reading your free Drive space…')}</span>;
  if (space === null)
    return (
      <span className="lbl">
        {tr('Google Drive にログインすると、空きを出します。', 'Sign in to Google Drive to see the free space.')}{' '}
        <button className="btn small ghost" onClick={onSignIn}>
          {tr('ログイン', 'Sign in')}
        </button>
      </span>
    );
  if (space.limit === null) return <span className="lbl">{tr(`上限のない Drive です（使っている ${bytesText(space.usage)}）。`, `Your Drive has no limit (${bytesText(space.usage)} used).`)}</span>;
  const free = Math.max(0, space.limit - space.usage);
  const over = Math.max(0, need - free);
  const whole = Math.max(space.limit, space.usage + need);
  const w = (n: number) => `${(Math.max(0, n) / whole) * 100}%`;
  return (
    <div className="ps-space">
      <div className={`ps-track ${big ? 'big' : ''}`}>
        <i className="o" style={{ width: w(space.usage) }} />
        <i className="n" style={{ width: w(Math.min(need, free)) }} />
        {over > 0 && <i className="x" style={{ width: w(over) }} />}
      </div>
      <div className="ps-legend">
        <span>
          <i style={{ background: '#3a4452' }} />
          {tr(`使っている ${bytesText(space.usage)}（Gmail・フォト・ほかのファイル）`, `Used ${bytesText(space.usage)} (Gmail, Photos, other files)`)}
        </span>
        <span>
          <i style={{ background: 'var(--ok)' }} />
          {over > 0 ? tr(`${newLabel}のうち入る ${bytesText(free)}`, `${newLabel}: ${bytesText(free)} fits`) : `${newLabel} ${bytesText(need)}`}
        </span>
        {over > 0 ? (
          <span style={{ color: '#ff9a9a' }}>
            <i style={{ background: '#b43a3a' }} />
            {tr(`入らない ${bytesText(over)}`, `${bytesText(over)} won't fit`)}
          </span>
        ) : (
          <span>
            <i
              style={{
                background: '#1c222b',
                border: '1px solid var(--line3)',
              }}
            />
            {tr(`同期のあとの空き ${bytesText(free - need)}`, `${bytesText(free - need)} free after syncing`)}
          </span>
        )}
      </div>
    </div>
  );
}

/** 「全部の曲」を選んだ：大きさと空きを比べて、入らなければ止める */
function WarnView({ all, made, space, onBack, onMade, onAll }: { all: Total; made: Total; space: Space; onBack: () => void; onMade: (addBox: boolean) => void; onAll: (noVideo: boolean) => void }) {
  const [ack, setAck] = useState(false);
  const need = sendBytes(all, true, true);
  const needNoVideo = sendBytes(all, false, true);
  const known = !!space && space.limit !== null;
  const free = known ? Math.max(0, space!.limit! - space!.usage) : null;
  const over = free !== null && need > free;
  const noVideoFits = free === null || needNoVideo <= free;
  const counting = all.known < all.n;
  const warns: {
    c: 'r' | 'a' | 'b';
    icon: React.ReactNode;
    h: string;
    t: string;
  }[] = [];
  if (over) {
    warns.push({
      c: 'r',
      icon: Icon.warn(13),
      h: tr('入りません。', "It won't fit."),
      t: tr(`あと ${bytesText(need - free!)} 足りません。入る所まで送って、そこで止まります。`, `${bytesText(need - free!)} more is needed. Sending stops when Drive is full.`),
    });
    warns.push({
      c: 'r',
      icon: Icon.warn(13),
      h: tr('Drive がいっぱいになると、Gmail でメールの送り受けができなくなります。', 'When Drive is full, Gmail stops sending and receiving mail.'),
      t: tr('Google フォトにも写真を保存できなくなります（容量は Gmail・フォトと共有です）。', "Google Photos can't save photos either (the space is shared with Gmail and Photos)."),
    });
  } else if (free !== null && need > free / 2) {
    warns.push({
      c: 'a',
      icon: Icon.warn(13),
      h: tr('入りますが、空きの半分より多くを使います。', 'It fits, but uses more than half of the free space.'),
      t: tr(
        `送ったあとの空きは ${bytesText(free - need)} です。いっぱいになると Gmail・Google フォトも止まるので、ときどき見てください。`,
        `${bytesText(free - need)} will be left. When it is full, Gmail and Google Photos stop too, so check it now and then.`,
      ),
    });
  }
  warns.push({
    c: 'a',
    icon: Icon.clock(13),
    h: tr('はじめの送信に時間がかかります。', 'The first upload takes a while.'),
    t: tr(
      `${bytesText(need)} は、上り 10 Mbps で${upTime(need)}。その間アプリを開いたままにします。止めても、送った所から続けます。`,
      `${bytesText(need)} takes ${upTime(need)} at 10 Mbps up. Keep the app open meanwhile. If it stops, it continues from where it got to.`,
    ),
  });
  warns.push({
    c: 'b',
    icon: Icon.pc(13),
    h: tr('ほかの PC にも取ります。', 'Other PCs get them too.'),
    t: tr('その PC に無い曲は全部取るので、その PC の空きも確かめてください。', 'Songs missing on those PCs are all downloaded, so check their free space too.'),
  });
  const canAll = !counting && !over && (ack || false);
  return (
    <div className="ps-modal" role="dialog" aria-modal="true" aria-label={tr('全部の曲を Google Drive に送りますか？', 'Send all songs to Google Drive?')}>
      <div className="ps-mh">
        <span className={`ps-mi ${over ? 'bad' : 'amber'}`}>{Icon.warn(20)}</span>
        <div className="grow">
          <h2>{tr('全部の曲を Google Drive に送りますか？', 'Send all songs to Google Drive?')}</h2>
          <p>
            {tr(
              `DTXMania の曲 ${all.n} 曲を、すべて Drive に置いて PC どうしで合わせます。曲の音と動画が大きいので、送る前に大きさと空きを確かめてください。`,
              `All ${all.n} DTXMania songs go to Drive and are synced between PCs. Audio and videos are large, so check the size and free space before sending.`,
            )}
          </p>
        </div>
      </div>
      <div className="ps-nums">
        <div className="ps-nb">
          <span className="k">{tr('全部の曲', 'All songs')}</span>
          <span className="v">{sizeText(all)}</span>
          <span className="s">
            {counting
              ? tr(`数えています… ${all.known}/${all.n}`, `Counting… ${all.known}/${all.n}`)
              : tr(`動画を除くと ${bytesText(all.bytes - all.video)} · ${all.n} 曲`, `${bytesText(all.bytes - all.video)} without videos · ${all.n} ${pl(all.n, 'song')}`)}
          </span>
        </div>
        <div className="ps-nb">
          <span className="k">{known ? tr(`Drive の空き（${planName(space!.limit!)}）`, `Free on Drive (${planName(space!.limit!)})`) : tr('Drive の空き', 'Free on Drive')}</span>
          <span className="v">{free !== null ? bytesText(free) : '—'}</span>
          <span className="s">
            {known
              ? tr(`${bytesText(space!.limit!)} のうち ${bytesText(space!.usage)} 使用`, `${bytesText(space!.usage)} of ${bytesText(space!.limit!)} used`)
              : space === null
                ? tr('ログインすると出します', 'Sign in to see it')
                : space === undefined
                  ? tr('読んでいます…', 'Reading…')
                  : tr('上限なし', 'No limit')}
          </span>
        </div>
        <div className={`ps-nb ${free === null ? '' : over ? 'bad' : 'good'}`}>
          <span className="k">{over ? tr('足りない', 'Short by') : tr('送ったあとの空き', 'Free after sending')}</span>
          <span className="v">{free === null ? '—' : over ? bytesText(need - free) : bytesText(free - need)}</span>
          <span className="s">
            {free === null
              ? ''
              : over
                ? noVideoFits
                  ? tr('動画を除くと入ります', 'Fits without videos')
                  : tr(`動画を除いても ${bytesText(needNoVideo - free)} 足りない`, `Still ${bytesText(needNoVideo - free)} short without videos`)
                : tr('入ります', 'It fits')}
          </span>
        </div>
      </div>
      {known && <SpaceBar space={space} need={need} newLabel={tr('全部の曲', 'All songs')} onSignIn={() => {}} big />}
      <div className="ps-wl">
        {warns.map((w, i) => (
          <div key={i} className="ps-w">
            <span className={`ps-wi ${w.c === 'r' ? 'r' : w.c === 'b' ? 'b' : ''}`}>{w.icon}</span>
            <span>
              <b>{w.h}</b>
              {w.t}
            </span>
          </div>
        ))}
      </div>
      <div className="ps-wl">
        <button className={`ps-opt ${over ? 'on' : ''}`} onClick={() => onMade(false)}>
          <span className="ps-ob">
            <span className="t">
              {tr('作った曲だけにする', 'Only songs you made')}
              {over && <span className="rec">{tr('おすすめ', 'Recommended')}</span>}
              <span className="sz">{tr(`${sizeText(made)} · ${made.n} 曲`, `${sizeText(made)} · ${made.n} ${pl(made.n, 'song')}`)}</span>
            </span>
            <span className="d">
              {tr('このアプリで直した・保存した曲と、足した曲・BOX。あとから BOX ごと足せます。', 'Songs fixed or saved in this app, plus songs and BOXes you add. You can add whole BOXes later.')}
            </span>
          </span>
        </button>
        <button className="ps-opt" onClick={() => onMade(true)}>
          <span className="ps-ob">
            <span className="t">
              {tr('BOX を選んで足す…', 'Choose BOXes to add…')}
              <span className="sz">{tr('選んだ分', 'What you choose')}</span>
            </span>
            <span className="d">{tr('空きに入る大きさまで、BOX や曲を選べます。', 'Choose BOXes or songs up to what fits in your free space.')}</span>
          </span>
        </button>
        <button className="ps-opt" disabled={!noVideoFits || counting} onClick={() => onAll(true)}>
          <span className="ps-ob">
            <span className="t">
              {tr('動画を除いて全部', 'Everything except videos')}
              <span className="sz">{bytesText(needNoVideo)}</span>
            </span>
            <span className="d">
              {noVideoFits
                ? tr('動画は各 PC に残し、ほかの PC では動画なしで遊びます。', 'Videos stay on each PC; other PCs play without them.')
                : tr(`${bytesText(needNoVideo)}。これも空きに入りません。`, `${bytesText(needNoVideo)}. This doesn't fit either.`)}
            </span>
          </span>
        </button>
        {!over && !counting && (
          <label className="ps-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {tr(`${bytesText(need)} を送ること、はじめの送信に${upTime(need)}かかることを確かめました`, `I understand ${bytesText(need)} will be sent and the first upload takes ${upTime(need)}`)}
          </label>
        )}
      </div>
      <div className="ps-foot">
        <a href="https://one.google.com/storage" target="_blank" rel="noreferrer" className="lbl">
          {tr('Google One で容量を増やす', 'Get more space with Google One')}
        </a>
        <button className="btn ghost" onClick={onBack}>
          {tr('戻る', 'Back')}
        </button>
        <button className="btn ps-danger" disabled={!canAll} title={over ? tr('空きが足りるときだけ選べます', 'Only when there is enough free space') : undefined} onClick={() => onAll(false)}>
          {over
            ? tr('それでも全部にする（空きが足りません）', 'All songs anyway (not enough space)')
            : counting
              ? tr('大きさを数えています…', 'Counting sizes…')
              : tr(`全部の曲にする（${bytesText(need)}）`, `Sync all songs (${bytesText(need)})`)}
        </button>
      </div>
    </div>
  );
}
