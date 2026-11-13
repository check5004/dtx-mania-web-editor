// PC どうしの同期：上の帯（SyncChip）・左のカード（SyncSideCard）・一覧の印（withSyncPills）・右の「同期」（SyncSongSection）。
import { useEffect, useMemo, useState } from 'react';
import { pl, tr } from '../../i18n';
import { signIn, tokenValid } from '../../drive/auth';
import { openNxPage } from '../../nxlib/actions';
import type { LibSong } from '../../nxlib/scan';
import { ensureNxPerm, useNxLib } from '../../nxlib/store';
import { bytesText } from '../../nxlib/view';
import { toast } from '../../store/editor';
import { addSyncSong, inScope, openSyncPanel, songKey, songLibKey, stopSyncSong, syncNow, usePcSync } from '../../sync/store';
import { confirmDialog } from '../dialogs';
import { Icon } from '../icons';
import { updText, type Pill } from '../nxlib/parts';
import { agoText, changePill, chartName, hm, newsText, progressText, scopeName, songSyncView, useNow, type RecentChange } from './common';

/** 設定の画面を開く（操作の中で。DTXMania のフォルダの許可が要れば一緒に聞く） */
export function openSetup() {
  const nx = useNxLib.getState();
  if (nx.place && nx.perm !== 'granted') void ensureNxPerm();
  openSyncPanel('setup');
}

/** 同期している曲のフォルダの数と、Drive に送った大きさ（成績だけの曲は数えない） */
export function syncedFolders(songs: readonly LibSong[]): {
  n: number;
  bytes: number;
} {
  const seen = new Set<string>();
  let bytes = 0;
  for (const s of songs) {
    if (s.drive?.state !== 'linked' || s.drive.play) continue;
    const k = songKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    bytes += s.drive.bytes;
  }
  return { n: seen.size, bytes };
}

/** 一覧の行の印：「Drive」の代わりに「同期」、最近の同期で変わった曲はその中身（成績 +3・まとめた・譜面 2） */
export function withSyncPills(pills: Pill[], s: LibSong, change?: RecentChange): Pill[] {
  const at = pills.findIndex((p) => p.k === 'drive');
  const rest = pills.filter((p) => p.k !== 'drive');
  const cp = changePill(change);
  const mark: Pill | null =
    cp ??
    (s.drive?.state === 'linked' && !s.drive.play
      ? {
          k: 'sync',
          label: tr('同期', 'Sync'),
          title: tr('PC どうしで同期しています', 'Synced between PCs'),
          icon: 'cloud',
        }
      : null);
  if (!mark) return rest;
  const i = at >= 0 ? at : rest.filter((p) => p.k === 'edit' || p.k === 'ai').length;
  return [...rest.slice(0, i), mark, ...rest.slice(i)];
}

// ---- 上の帯 ----------------------------------------------------------------------------

/** 上の帯の同期の様子。押すと記録（ログインが切れた・許可が要るときは同期） */
export function SyncChip() {
  const on = usePcSync((s) => s.settings.on);
  const status = usePcSync((s) => s.status);
  const pc = usePcSync((s) => s.settings.pc);
  const at = usePcSync((s) => s.state.at);
  const p = usePcSync((s) => s.progress);
  const asks = usePcSync((s) => s.log[0]?.asks.length ?? 0);
  const error = usePcSync((s) => s.error);
  const place = useNxLib((s) => !!s.place);
  const now = useNow();
  if (!on) return null;
  const log = () => openSyncPanel('log');
  let cls = '';
  let icon = Icon.cloud(13);
  let text: string;
  let title = tr('押すと同期の記録を開きます', 'Press to open the sync log');
  let run = log;
  let bar: number | null = null;
  if (status === 'busy') {
    cls = 'run';
    icon = <span className="ps-spin">{Icon.refresh(13)}</span>;
    text = progressText(p);
    if (p && p.total && p.phase !== 'list') bar = Math.min(100, (p.done / p.total) * 100);
    title = p?.song ? `${p.song}${p.file ? ` · ${p.file}` : ''}` : title;
  } else if (status === 'auth') {
    cls = 'warn';
    icon = Icon.warn(13);
    text = tr('Drive のログインが切れました · 押すと同期', 'Drive sign-in expired · press to sync');
    title = tr('Google のログインは 1 時間ほどで切れます。押すとログインして同期します', 'Google sign-in lasts about an hour. Press to sign in and sync');
    run = syncNow;
  } else if (status === 'perm') {
    cls = 'warn';
    icon = Icon.warn(13);
    text = place ? tr('DTXMania のフォルダの許可 · 押すと同期', 'DTXMania folder access · press to sync') : tr('DTXMania のフォルダを選んでください', 'Choose the DTXMania folder');
    title = place ? tr('Chrome が読み書きの許可を聞きます。「毎回許可する」を選ぶと、次からは聞かれません', 'Chrome asks for read and write access. "Allow on every visit" stops it asking') : title;
    run = place ? syncNow : () => void openNxPage();
  } else if (status === 'error') {
    cls = 'err';
    icon = Icon.warn(13);
    text = tr('同期できませんでした · 記録を見る', "Couldn't sync · see the log");
    title = error || title;
  } else if (asks) {
    cls = 'warn';
    icon = Icon.info(13);
    text = tr(`確かめてほしいこと ${asks} · 押して答える`, `${asks} ${pl(asks, 'question')} · press to answer`);
  } else {
    icon = Icon.checkCircle(13);
    text = at ? tr(`同期しました · ${agoText(at, now)}`, `Synced · ${agoText(at, now)}`) : tr('同期を待っています', 'Waiting to sync');
  }
  return (
    <button className={`ps-chip ${cls}`} onClick={run} title={title}>
      {icon}
      <span className="ellipsis">{text}</span>
      {bar !== null && (
        <span className="bar">
          <i style={{ width: `${bar}%` }} />
        </span>
      )}
      {pc && <span className="pc">{pc}</span>}
    </button>
  );
}

// ---- 左のカード ---------------------------------------------------------------------------

/** 「DTXMania の曲」の左下：この PC・合わせる曲・前の同期・次。まだなら「はじめる…」 */
export function SyncSideCard() {
  const set = usePcSync((s) => s.settings);
  const status = usePcSync((s) => s.status);
  const at = usePcSync((s) => s.state.at);
  const next = usePcSync((s) => s.next);
  const songs = useNxLib((s) => s.songs);
  const now = useNow();
  const synced = useMemo(() => syncedFolders(songs), [songs]);
  if (!set.on) {
    return (
      <div className="ps-card">
        <div className="h">
          {Icon.cloud(13)}
          {tr('PC どうしの同期', 'PC sync')}
        </div>
        <p>{tr('作る PC と遊ぶ PC の曲と成績を、Google Drive で合わせます。', 'Keeps songs and records in step between the PC you make on and the PC you play on, through Google Drive.')}</p>
        <div>
          <button className="btn small" onClick={openSetup}>
            {tr('はじめる…', 'Set up…')}
          </button>
        </div>
      </div>
    );
  }
  const stopped = status === 'auth' || status === 'perm' || status === 'error';
  const nextText =
    status === 'busy'
      ? tr('同期しています…', 'Syncing…')
      : status === 'auth'
        ? tr('止まっています（ログイン）', 'Stopped (sign-in)')
        : status === 'perm'
          ? tr('止まっています（許可）', 'Stopped (access)')
          : status === 'error'
            ? tr('できませんでした', 'Failed')
            : next > now
              ? tr(`${hm(next)}（5 分ごと）`, `${hm(next)} (every 5 min)`)
              : '—';
  return (
    <div className="ps-card">
      <div className="h">
        <span style={{ color: 'var(--ok)', display: 'inline-flex' }}>{Icon.cloud(13)}</span>
        {tr('PC どうしの同期', 'PC sync')}
        <button className="link" onClick={openSetup}>
          {tr('設定', 'Settings')}
        </button>
      </div>
      <div className="k">
        <span>{tr('この PC', 'This PC')}</span>
        <b>{set.pc || '—'}</b>
      </div>
      <div className="k">
        <span>{tr('曲', 'Songs')}</span>
        <b>{tr(`${scopeName(set)} ${synced.n}（${bytesText(synced.bytes)}）`, `${scopeName(set)}: ${synced.n} (${bytesText(synced.bytes)})`)}</b>
      </div>
      <div className="k">
        <span>{tr('前の同期', 'Last sync')}</span>
        <b>{at ? agoText(at, now) : tr('まだ', 'Not yet')}</b>
      </div>
      <div className="k">
        <span>{tr('次', 'Next')}</span>
        <b className={stopped ? 'warn' : ''}>{nextText}</b>
      </div>
    </div>
  );
}

// ---- 右：この曲の同期 ------------------------------------------------------------------------

/** 選んだ曲を合わせるか（入り・切り）と、譜面・音と成績のいちばん新しい同期 */
export function SyncSongSection({ s }: { s: LibSong }) {
  const settings = usePcSync((st) => st.settings);
  const log = usePcSync((st) => st.log);
  const [lk, setLk] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const pathKey = s.path.join('/');
  useEffect(() => {
    let live = true;
    setLk(undefined);
    void songLibKey(s).then((k) => live && setLk(k));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, pathKey]);
  const view = useMemo(() => songSyncView(log, s.root, s.path), [log, s.root, s.path]);
  const scope = lk === undefined || lk === null ? null : inScope(s, settings, lk);
  const on = scope === 'all';
  const linked = s.drive?.state === 'linked' && !s.drive.play;
  const title = s.title || s.path[s.path.length - 1] || '';

  let tag: string;
  if (lk === null) tag = tr('合わせられない場所', "Can't be synced here");
  else if (s.drive?.state === 'skip') tag = tr('同期しない', 'Not synced');
  else if (!on) tag = scope === 'play' ? tr('成績だけ', 'Records only') : tr('合わせない', 'Not synced');
  else if (settings.scope === 'all') tag = tr('全部の曲', 'All songs');
  else if (s.edited) tag = tr('作った曲', 'Made here');
  else if (lk && settings.songs.some((x) => x.toLowerCase() === lk)) tag = tr('足した曲', 'Added');
  else if (lk && settings.boxes.some((b) => lk.startsWith(`${b.toLowerCase()}/`))) tag = tr('BOX ごと', 'Whole BOX');
  else tag = tr('送った曲', 'Sent before');

  const toggle = async () => {
    if (busy || lk === undefined || lk === null) return;
    if (on) {
      // Drive の曲のフォルダをゴミ箱へ移すので、ログインが切れていれば先に（小窓は操作の中で開く）
      if (linked && !tokenValid() && !(await signIn({ action: 'connect' }))) return;
      const ok = await confirmDialog({
        title: tr('この曲の同期をやめますか？', 'Stop syncing this song?'),
        body: linked
          ? tr(
              `Google Drive の「${title}」のフォルダをゴミ箱に移します（30 日は戻せます）。この PC の曲はそのまま残ります。ほかの PC の曲も消えずに残り、同期から外れます。`,
              `The "${title}" folder on Google Drive goes to the trash (restorable for 30 days). The song on this PC stays as it is. The song on other PCs stays too and stops syncing.`,
            )
          : tr('この曲は Google Drive に送りません（保存しても送りません）。あとでまた合わせられます。', "This song won't be sent to Google Drive (not even when saved). You can sync it again later."),
        ok: tr('同期をやめる', 'Stop syncing'),
        danger: linked,
      });
      if (!ok) return;
      setBusy(true);
      try {
        await stopSyncSong(s);
        toast(tr(`「${title}」の同期をやめました`, `Stopped syncing "${title}"`), 'ok', 4000);
      } catch (e) {
        toast(tr(`同期をやめられませんでした: ${(e as Error).message}`, `Couldn't stop syncing: ${(e as Error).message}`), 'error', 8000);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      await addSyncSong(s);
    } finally {
      setBusy(false);
    }
  };

  const when = (t: number) => updText(t);
  let make: React.ReactNode;
  if (view.make?.kind === 'sent') make = <span className="to up">{tr(`→ Drive に送りました ${when(view.make.at)}`, `→ Sent to Drive ${when(view.make.at)}`)}</span>;
  else if (view.make?.kind === 'got')
    make = (
      <span className="to">
        {view.make.from
          ? tr(`← ${view.make.from} の版を取りました ${when(view.make.at)}`, `← Got the version from ${view.make.from} ${when(view.make.at)}`)
          : tr(`← Drive から取りました ${when(view.make.at)}`, `← Got from Drive ${when(view.make.at)}`)}
      </span>
    );
  else if (view.make?.kind === 'newer')
    make = (
      <span className="to">
        {tr(`両方で直されていたので、新しい方にしました ${when(view.make.at)}（記録から戻せます）`, `Changed on both PCs, so the newer one was kept ${when(view.make.at)} (restorable from the log)`)}
      </span>
    );
  else make = on ? (linked ? tr('Drive と同じです', 'Same as Drive') : tr('次の同期で Drive に送ります', 'Sent to Drive on the next sync')) : tr('合わせていません', 'Not synced');

  let play: React.ReactNode;
  if (!settings.scores) play = tr('合わせません（設定で切っています）', 'Not synced (turned off in the settings)');
  else if (view.play?.kind === 'got') {
    const n = view.play.news.filter((x) => !x.merged).slice(0, 2);
    play = (
      <span className="to">
        {tr(`← 取り込みました ${when(view.play.at)}`, `← Got ${when(view.play.at)}`)}
        {n.length > 0 && tr(`（${n.map((x) => newsText(x, chartName(s, x.chart))).join('・')}）`, ` (${n.map((x) => newsText(x, chartName(s, x.chart))).join(', ')})`)}
      </span>
    );
  } else if (view.play?.kind === 'merged')
    play = <span className="to">{tr(`両方の PC で遊んでいたので、まとめました ${when(view.play.at)}`, `Played on both PCs, so the records were merged ${when(view.play.at)}`)}</span>;
  else if (view.play?.kind === 'sent') play = <span className="to up">{tr(`→ Drive に送りました ${when(view.play.at)}`, `→ Sent to Drive ${when(view.play.at)}`)}</span>;
  else play = on || scope === 'play' ? tr('まだ変わっていません', 'No changes yet') : tr('合わせていません', 'Not synced');

  return (
    <div className="nx-sec">
      <div className="nx-sec-t">
        <span>{tr('同期', 'Sync')}</span>
        {linked && <span className="nx-sec-sub">{tr(`Drive に ${bytesText(s.drive!.bytes)}`, `${bytesText(s.drive!.bytes)} on Drive`)}</span>}
      </div>
      <div className="ps-song">
        <div className="ps-toggle">
          <button
            className={`sw ${on ? 'on' : ''}`}
            role="switch"
            aria-checked={on}
            aria-label={tr('この曲を PC どうしで合わせる', 'Sync this song between PCs')}
            disabled={busy || !lk}
            onClick={() => void toggle()}
          />
          <span>{tr('この曲を PC どうしで合わせる', 'Sync this song between PCs')}</span>
          <span className="tag">{tag}</span>
        </div>
        <div className="ps-kind">
          <span className="ic">{Icon.pencil(13)}</span>
          <span>
            <b>
              {tr('譜面・音', 'Charts and sounds')}
              <small>{tr('（作るファイル）', ' (files you make)')}</small>
            </b>
            <br />
            {make}
          </span>
        </div>
        <div className="ps-kind">
          <span className="ic play">{Icon.trophy(13)}</span>
          <span>
            <b>
              {tr('成績・ゴースト', 'Records and ghosts')}
              <small>{tr('（遊ぶファイル）', ' (files from playing)')}</small>
            </b>
            <br />
            {play}
          </span>
        </div>
        {view.error && <p className="ps-note err">{tr(`前の同期で合わせられませんでした: ${view.error.text}`, `Couldn't sync last time: ${view.error.text}`)}</p>}
        {view.later && (
          <p className="ps-note warn">
            {tr(
              `DTXMania が使っていて書けなかったファイルが ${view.later.n} 個あります。次の同期で合わせます。`,
              `${view.later.n} ${pl(view.later.n, 'file')} couldn't be written because DTXMania was using ${view.later.n === 1 ? 'it' : 'them'}. The next sync tries again.`,
            )}
          </p>
        )}
        <p className="ps-note">
          {tr(
            '成績（*.score.ini・*.ghost）は DTXMania が書くファイルで、譜面とは別です。両方で変わっても、ファイルごとに合わせるので聞かずにまとまります。',
            'Records (*.score.ini, *.ghost) are written by DTXMania and are separate from the charts. Even if both PCs change them, they are merged file by file without asking.',
          )}
        </p>
      </div>
    </div>
  );
}
