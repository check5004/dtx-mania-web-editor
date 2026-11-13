// PC どうしの同期：ホームの帯（同期した・している・ログインが切れた）、「DTXMania の曲」のカードの次の同期と同期で変わった曲、
// 設定の「Google Drive」の PC どうしの同期。
import { useMemo, useState, type CSSProperties } from 'react';
import { pl, tr } from '../../i18n';
import { openNxPage } from '../../nxlib/actions';
import type { LibSong } from '../../nxlib/scan';
import { setNxView, useNxLib } from '../../nxlib/store';
import { openSyncPanel, songKey, stopPcSync, syncNow, usePcSync } from '../../sync/store';
import { confirmDialog } from '../dialogs';
import { Icon } from '../icons';
import { updText } from '../nxlib/parts';
import { agoText, changedHere, chartName, hm, newsText, progressText, recentChanges, runSentence, runSum, runTitle, scopeName, useNow, type RecentChange } from './common';
import { openSetup, syncedFolders } from './parts';

/** 帯を閉じた（その同期より新しい同期まで出さない） */
let hiddenAt = 0;

/** ホーム（PC）の上の帯：開いたときの同期の結果・同期中・ログインが切れた・確かめてほしいこと */
export function PcSyncBanner() {
  const on = usePcSync((s) => s.settings.on);
  const status = usePcSync((s) => s.status);
  const log = usePcSync((s) => s.log);
  const progress = usePcSync((s) => s.progress);
  const at = usePcSync((s) => s.state.at);
  const error = usePcSync((s) => s.error);
  const [hidden, setHidden] = useState(hiddenAt);
  const now = useNow();
  if (!on) return null;
  const hide = (t: number) => {
    hiddenAt = t;
    setHidden(t);
  };
  const latest = log.find((l) => !l.dry);
  const asks = log[0]?.asks.length ?? 0;
  const prev = at ? tr(`前の同期は ${updText(at)}。`, `Last sync: ${updText(at)}. `) : '';

  if (status === 'busy') {
    const pct = progress && progress.total && progress.phase !== 'list' ? (progress.done / progress.total) * 100 : 0;
    return (
      <section className="ps-ban run" role="status">
        <div className="ps-bh">
          <span className="ps-bi">
            <span className="ps-spin">{Icon.refresh(18)}</span>
          </span>
          <span className="ps-bt">
            <b>{tr(`同期しています · ${progressText(progress)}`, `Syncing · ${progressText(progress)}`)}</b>
            <span>
              {progress?.song
                ? `${progress.song}${progress.file ? ` · ${progress.file}` : ''}`
                : tr('Drive の変化とこの PC の曲を比べています', 'Comparing changes on Drive with the songs on this PC')}
            </span>
          </span>
        </div>
        <div className="ps-track">
          <i className="n" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
        </div>
        <div className="ps-howto">
          {tr(
            'DTXMania は開いたままで大丈夫です。取り終えた曲から書き込み、遊んでいる曲は次の同期で合わせます。',
            'DTXMania can stay open. Songs are written as they arrive; the one being played is synced next time.',
          )}
        </div>
      </section>
    );
  }
  if ((status === 'auth' || status === 'perm') && hidden !== -1) {
    const auth = status === 'auth';
    return (
      <section className="ps-ban warn">
        <div className="ps-bh">
          <span className="ps-bi">{Icon.warn(18)}</span>
          <span className="ps-bt">
            <b>
              {auth
                ? tr('Google Drive のログインが切れています · 押すと同期します', 'Your Google Drive sign-in expired · press to sync')
                : tr('DTXMania のフォルダの許可が要ります · 押すと同期します', 'Access to the DTXMania folder is needed · press to sync')}
            </b>
            <span>
              {prev}
              {auth
                ? tr('Google のログインは 1 時間ほどで切れるので、開いたときに 1 回押してください。', 'Google sign-in lasts about an hour, so press once when you open the app.')
                : tr('Chrome が読み書きの許可を 1 回聞きます。', 'Chrome asks once for read and write access.')}
            </span>
          </span>
          <button className="btn ghost" onClick={() => hide(-1)}>
            {tr('あとで', 'Later')}
          </button>
          <button className="btn ps-amber" onClick={syncNow}>
            {auth ? tr('ログインして同期', 'Sign in and sync') : tr('許可して同期', 'Allow and sync')}
          </button>
        </div>
        <div className="ps-howto">
          {tr('Chrome で「毎回許可する」を選ぶと、DTXMania のフォルダの許可は次から聞かれません。', 'Choose "Allow on every visit" in Chrome and the DTXMania folder access won’t be asked again.')}
        </div>
      </section>
    );
  }
  if (status === 'error') {
    return (
      <section className="ps-ban warn">
        <div className="ps-bh">
          <span className="ps-bi">{Icon.warn(18)}</span>
          <span className="ps-bt">
            <b>{tr('同期できませんでした', "Couldn't sync")}</b>
            <span>{error}</span>
          </span>
          <button className="btn" onClick={() => openSyncPanel('log')}>
            {tr('記録を見る', 'See the log')}
          </button>
          <button className="btn ps-amber" onClick={syncNow}>
            {tr('もう一度', 'Try again')}
          </button>
        </div>
      </section>
    );
  }
  if (asks) {
    return (
      <section className="ps-ban warn">
        <div className="ps-bh">
          <span className="ps-bi">{Icon.info(18)}</span>
          <span className="ps-bt">
            <b>{tr(`確かめてほしいことが ${asks} 件あります`, `${asks} ${pl(asks, 'thing')} to check`)}</b>
            <span>{tr('答えるまで、その曲・ファイルは合わせずに待ちます。', 'Those songs and files wait until you answer.')}</span>
          </span>
          <button className="btn ps-amber" onClick={() => openSyncPanel('log')}>
            {tr('記録で答える', 'Answer in the log')}
          </button>
        </div>
      </section>
    );
  }
  if (!latest || latest.at <= hidden || now - latest.at > 12 * 3600_000) return null;
  const sum = runSum(latest);
  if (!sum.any) return null;
  const pills: {
    ic: string;
    icon: React.ReactNode;
    t: string;
    n: number;
    dim?: string;
  }[] = [];
  if (sum.newSongs)
    pills.push({
      ic: '',
      icon: Icon.arrowDown(12),
      t: tr('新しい曲', 'New songs'),
      n: sum.newSongs,
    });
  if (sum.chartSongs)
    pills.push({
      ic: '',
      icon: Icon.arrowDown(12),
      t: tr('譜面が新しくなった曲', 'Songs with newer charts'),
      n: sum.chartSongs,
      dim: tr(`（譜面 ${sum.charts}）`, ` (${sum.charts} ${pl(sum.charts, 'chart')})`),
    });
  if (sum.gotSongs)
    pills.push({
      ic: '',
      icon: Icon.arrowDown(12),
      t: tr('ファイルを取った曲', 'Songs with newer files'),
      n: sum.gotSongs,
    });
  if (sum.scoreSongs)
    pills.push({
      ic: '',
      icon: Icon.trophy(12),
      t: tr('成績を取った曲', 'Songs with records got'),
      n: sum.scoreSongs,
    });
  if (sum.sentScoreSongs)
    pills.push({
      ic: 'up',
      icon: Icon.arrowUp(12),
      t: tr('成績を送った曲', 'Songs with records sent'),
      n: sum.sentScoreSongs,
    });
  if (sum.sentSongs)
    pills.push({
      ic: 'up',
      icon: Icon.arrowUp(12),
      t: tr('送った曲', 'Songs sent'),
      n: sum.sentSongs,
    });
  if (sum.mergedSongs)
    pills.push({
      ic: 'merge',
      icon: Icon.merge(12),
      t: tr('成績をまとめた曲', 'Songs with merged records'),
      n: sum.mergedSongs,
      dim: tr('（両方で遊んでいた）', ' (played on both)'),
    });
  if (sum.newer)
    pills.push({
      ic: 'merge',
      icon: Icon.history(12),
      t: tr('両方で直したファイル', 'Files changed on both'),
      n: sum.newer,
      dim: tr('（新しい方に）', ' (newer kept)'),
    });
  if (sum.later)
    pills.push({
      ic: 'up',
      icon: Icon.clock(12),
      t: tr('あとで', 'Later'),
      n: sum.later,
    });
  return (
    <section className="ps-ban">
      <div className="ps-bh">
        <span className="ps-bi">{Icon.checkCircle(18)}</span>
        <span className="ps-bt">
          <b>{tr(`${runTitle(latest.why)} · ${hm(latest.at)}`, `${runTitle(latest.why)} · ${hm(latest.at)}`)}</b>
          <span>
            {runSentence(latest, sum)}
            {sum.newer > 0 &&
              tr(
                '両方で直したファイルは新しい方にしました（記録で控えの版に戻せます）。',
                ' Files changed on both PCs were set to the newer one (a backup can be restored from the log).',
              )}
          </span>
        </span>
        <button className="btn" onClick={() => openSyncPanel('log')}>
          {tr('記録を見る', 'See the log')}
        </button>
        <button className="btn" onClick={syncNow}>
          {tr('今すぐ同期', 'Sync now')}
        </button>
        <button className="ib" onClick={() => hide(latest.at)} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
          {Icon.close(12)}
        </button>
      </div>
      <div className="ps-sum">
        {pills.map((p) => (
          <span key={p.t} className="ps-sm">
            <span className={`ic ${p.ic}`}>{p.icon}</span>
            {p.t} <b>{p.n}</b>
            {p.dim && <span className="dim">{p.dim}</span>}
          </span>
        ))}
      </div>
      {sum.got && (
        <div className="ps-howto">
          <b>{tr('DTXMania に出すには', 'To see them in DTXMania')}</b>
          <span>{tr('開いているなら', 'If it is open:')}</span>
          <kbd>Config</kbd>
          <span className="arr">→</span>
          <kbd>System</kbd>
          <span className="arr">→</span>
          <kbd>Fast Reload</kbd>
          <span>{tr('これから開くなら、そのまま出ます', 'If you open it later, they are already there')}</span>
        </div>
      )}
    </section>
  );
}

/** ホームのカードの「次の同期 21:51（5 分ごと）」 */
export function SyncNextChip() {
  const on = usePcSync((s) => s.settings.on);
  const status = usePcSync((s) => s.status);
  const next = usePcSync((s) => s.next);
  const now = useNow();
  if (!on) {
    return (
      <button
        className="nx-home-chip ps-start"
        onClick={openSetup}
        title={tr('作る PC と遊ぶ PC の曲と成績を、Google Drive で合わせます', 'Keep songs and records in step between your PCs through Google Drive')}
      >
        {Icon.cloud(12)}
        {tr('PC どうしの同期…', 'PC sync…')}
      </button>
    );
  }
  const text =
    status === 'busy'
      ? tr('同期中', 'Syncing')
      : status === 'auth' || status === 'perm' || status === 'error'
        ? tr('同期は止まっています', 'Sync is stopped')
        : next > now
          ? tr(`次の同期 ${hm(next)}（5 分ごと）`, `Next sync ${hm(next)} (every 5 min)`)
          : tr('同期を待っています', 'Waiting to sync');
  return (
    <button className="nx-home-chip ps-start" onClick={() => openSyncPanel('log')}>
      {Icon.cloud(12)}
      {text}
    </button>
  );
}

/** 「同期で変わった曲」のタイルの印と下の 1 行 */
function tileBadge(c: RecentChange, s: LibSong): { k: string; b: string; w: string } {
  const from = c.from ? tr(`${c.from} で直した`, `changed on ${c.from}`) : '';
  if (c.isNew)
    return {
      k: '',
      b: tr('新しい曲', 'New song'),
      w: [s.path.slice(0, -1).join(' / '), from].filter(Boolean).join(' · '),
    };
  if (c.merged)
    return {
      k: 'merge',
      b: tr('成績をまとめた', 'Merged records'),
      w: tr('両方の PC で遊んだ', 'Played on both PCs'),
    };
  if (c.charts.length)
    return {
      k: '',
      b: tr(`譜面 ${c.charts.length}`, `${c.charts.length} ${pl(c.charts.length, 'chart')}`),
      w: [c.charts.map((x) => chartName(s, x)).join(tr('・', ', ')), from].filter(Boolean).join(' · '),
    };
  if (c.got) return { k: '', b: tr(`取った ${c.got}`, `Got ${c.got}`), w: from };
  if (c.scores) {
    const n = c.news.filter((x) => !x.merged)[0];
    return {
      k: '',
      b: c.plays ? tr(`成績 +${c.plays}`, `Records +${c.plays}`) : tr('成績', 'Records'),
      w: n ? newsText(n, chartName(s, n.chart)) : '',
    };
  }
  if (c.newer)
    return {
      k: 'merge',
      b: tr('新しい方に', 'Kept newer'),
      w: tr('両方で直されていた', 'Changed on both PCs'),
    };
  return { k: 'merge', b: tr('消した', 'Deleted'), w: from };
}

/** 「DTXMania の曲」のカード：同期で変わった曲（24 時間。無ければ出さない） */
export function SyncedTiles({ thumbs }: { thumbs: Record<string, string> }) {
  const on = usePcSync((s) => s.settings.on);
  const log = usePcSync((s) => s.log);
  const songs = useNxLib((s) => s.songs);
  const list = useMemo(() => {
    if (!on) return [];
    const ch = recentChanges(log);
    const seen = new Set<string>();
    const out: { s: LibSong; c: RecentChange }[] = [];
    for (const s of songs) {
      const k = songKey(s);
      const c = ch.get(k);
      if (!c || !changedHere(c) || seen.has(k)) continue;
      seen.add(k);
      out.push({ s, c });
    }
    return out.sort((a, b) => b.c.at - a.c.at);
  }, [on, log, songs]);
  if (!list.length) return null;
  const head = list.slice(0, 6);
  return (
    <>
      <div className="nx-home-sub">
        <span className="lbl">{tr(`同期で変わった曲 · ${list.length}`, `Changed by sync · ${list.length}`)}</span>
        <span className="lbl">{tr('押すと一覧でその曲を出します', 'Press to show it in the list')}</span>
      </div>
      <div className="nx-tiles">
        {head.map(({ s, c }) => {
          const b = tileBadge(c, s);
          return (
            <button
              key={s.id}
              className="nx-tile ps-t"
              title={s.path.join('/')}
              onClick={() => {
                setNxView({ q: '', box: null, filter: 'synced', sel: s.id });
                void openNxPage();
              }}
            >
              {thumbs[s.id] && s.image ? (
                <img src={thumbs[s.id]} alt="" draggable={false} />
              ) : (
                <span
                  className="nx-tile-ph"
                  style={
                    {
                      '--h': [...(s.title || '?')][0].codePointAt(0)! % 360,
                    } as CSSProperties
                  }
                >
                  {[...(s.title || '?')][0]}
                </span>
              )}
              <span className={`ps-badge ${b.k}`}>{b.b}</span>
              <span className="t">{s.title}</span>
              <span className="ps-sub">{b.w || ' '}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** 設定の「Google Drive」：PC どうしの同期 */
export function PcSyncSettingsCard() {
  const set = usePcSync((s) => s.settings);
  const at = usePcSync((s) => s.state.at);
  const supported = useNxLib((s) => s.supported);
  const place = useNxLib((s) => s.place);
  const songs = useNxLib((s) => s.songs);
  const now = useNow();
  const synced = useMemo(() => syncedFolders(songs), [songs]);
  if (!supported) return null;
  const stop = async () => {
    const ok = await confirmDialog({
      title: tr('PC どうしの同期をやめますか？', 'Stop syncing between PCs?'),
      body: tr(
        'Google Drive の曲と、この PC の曲は、どちらもそのまま残ります。また始めると、続きから合わせます。',
        'The songs on Google Drive and on this PC both stay as they are. Start again to pick up where you left off.',
      ),
      ok: tr('同期をやめる', 'Stop syncing'),
    });
    if (ok) stopPcSync();
  };
  return (
    <section className="card">
      <div className="row" style={{ gap: 10 }}>
        <h3>{tr('PC どうしの同期', 'PC sync')}</h3>
        {set.on && <span className="pill ok">● {set.pc || tr('同期しています', 'On')}</span>}
      </div>
      <p className="lbl">
        {tr(
          '作る PC と遊ぶ PC の DTXMania の曲を、Google Drive の「DTX Web Editor / DTXFiles」で合わせます。譜面・音は新しい方に（古い方は控えに 30 日）、成績とゴーストは両方の記録をまとめます。アプリを開いたとき・開いている間は 5 分ごと・保存したときに合わせます。',
          'Keeps the DTXMania songs on the PC you make on and the PC you play on in step through "DTX Web Editor / DTXFiles" on Google Drive. Charts and sounds take the newer one (the older is kept as a backup for 30 days); records and ghosts are merged. It syncs when the app opens, every 5 minutes while open, and when you save.',
        )}
      </p>
      {set.on && (
        <p className="lbl">
          {tr(
            `${scopeName(set)} ${synced.n} 曲 · 前の同期 ${at ? agoText(at, now) : 'まだ'}`,
            `${scopeName(set)}: ${synced.n} ${pl(synced.n, 'song')} · last sync ${at ? agoText(at, now) : 'not yet'}`,
          )}
        </p>
      )}
      <div className="row" style={{ gap: 8 }}>
        {set.on ? (
          <>
            <button className="btn small primary" onClick={() => openSyncPanel('log')}>
              {tr('記録を見る', 'See the log')}
            </button>
            <button className="btn small" onClick={openSetup}>
              {tr('設定を変える…', 'Change settings…')}
            </button>
            <button className="btn small ghost" onClick={() => void stop()}>
              {tr('同期をやめる', 'Stop syncing')}
            </button>
          </>
        ) : place ? (
          <button className="btn small primary" onClick={openSetup}>
            {Icon.cloud(14)}
            {tr('はじめる…', 'Set up…')}
          </button>
        ) : (
          <>
            <span className="lbl">{tr('「DTXMania の曲」で DTXMania のフォルダを選ぶと使えます。', 'Choose your DTXMania folder in "DTXMania songs" to use this.')}</span>
            <button className="btn small" onClick={() => void openNxPage()}>
              {tr('DTXMania の曲を開く', 'Open DTXMania songs')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
