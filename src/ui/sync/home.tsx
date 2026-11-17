// PC どうしの同期：ホームの帯（同期した・している・ログインが切れた）、ホームの「Google Drive」のカードの同期の 1 行、
// 設定の「Google Drive」の PC どうしの同期。
import { useMemo, useState } from 'react';
import { pl, tr } from '../../i18n';
import { openNxPage } from '../../nxlib/actions';
import { useNxLib } from '../../nxlib/store';
import { openSyncPanel, pcsOf, stopPcSync, syncNow, usePcSync } from '../../sync/store';
import { confirmDialog } from '../dialogs';
import { Icon } from '../icons';
import { updText } from '../nxlib/parts';
import { agoText, hm, otherPcs, pcNames, progressText, runSentence, runSum, runTitle, scopeName, useNow } from './common';
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
            <b>{progress?.phase === 'wait' ? progressText(progress) : tr(`同期しています · ${progressText(progress)}`, `Syncing · ${progressText(progress)}`)}</b>
            <span>
              {progress?.song
                ? `${progress.song}${progress.file ? ` · ${progress.file}` : ''}`
                : progress?.phase === 'wait'
                  ? tr('同じ PC で開いているほかの窓・タブ（ホーム画面のアプリなど）が同期しています。終わったら続けます', 'Another window or tab on this PC (such as the home screen app) is syncing. This continues when it finishes')
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
      dim: tr('（ほかの PC でも遊んでいた）', ' (also played on another PC)'),
    });
  if (sum.newer)
    pills.push({
      ic: 'merge',
      icon: Icon.history(12),
      t: tr('ほかの PC でも直されていたファイル', 'Files also changed on another PC'),
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
                'ほかの PC でも直されていたファイルは、新しい方にしました（記録で控えの版に戻せます）。',
                ' Files also changed on another PC were set to the newer one (a backup can be restored from the log).',
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

/**
 * ホームの「Google Drive」のカードの 1 行：PC どうしの同期の様子（同期した・次・止まっている・確かめてほしいこと）と記録。
 * まだなら「はじめる…」（DTXMania の曲を使っているときだけ）。同期で何が変わったかは、上の帯（同期したあと）と記録で見る
 */
export function PcSyncHomeRow() {
  const supported = useNxLib((s) => s.supported);
  const place = useNxLib((s) => !!s.place);
  const songs = useNxLib((s) => s.songs);
  const on = usePcSync((s) => s.settings.on);
  const pc = usePcSync((s) => s.settings.pc);
  const pcId = usePcSync((s) => s.settings.pcId);
  const pcs = usePcSync(pcsOf);
  const scope = usePcSync((s) => s.settings.scope);
  const status = usePcSync((s) => s.status);
  const next = usePcSync((s) => s.next);
  const at = usePcSync((s) => s.state.at);
  const progress = usePcSync((s) => s.progress);
  const asks = usePcSync((s) => s.log[0]?.asks.length ?? 0);
  const n = useMemo(() => (on ? syncedFolders(songs).n : 0), [on, songs]);
  const now = useNow();
  if (!supported) return null;
  if (!on) {
    if (!place) return null;
    return (
      <div className="ps-home-row">
        <span className="ps-hr-i">{Icon.pc(15)}</span>
        <span className="ps-hr-t">
          <b>{tr('PC どうしの同期', 'PC sync')}</b>
          <span className="lbl">{tr('DTXMania の曲と成績を、ほかの PC と Google Drive で合わせます（PC は何台でも）', 'Keeps DTXMania songs and records in step with your other PCs through Google Drive (any number of PCs)')}</span>
        </span>
        <button className="btn small" onClick={openSetup}>
          {Icon.cloud(13)}
          {tr('はじめる…', 'Set up…')}
        </button>
      </div>
    );
  }
  /** 同期している PC の数（この PC も） */
  const nPc = otherPcs(pcs, { pc, pcId }).length + 1;
  let cls = '';
  let icon: React.ReactNode = Icon.checkCircle(15);
  let text: string;
  let act: { label: string; run: () => void } | null = null;
  if (status === 'busy') {
    cls = 'run';
    icon = <span className="ps-spin">{Icon.refresh(15)}</span>;
    text = progressText(progress);
  } else if (status === 'auth') {
    cls = 'warn';
    icon = Icon.warn(15);
    text = tr('Google Drive のログインが切れています', 'Your Google Drive sign-in expired');
    act = { label: tr('ログインして同期', 'Sign in and sync'), run: syncNow };
  } else if (status === 'perm') {
    cls = 'warn';
    icon = Icon.warn(15);
    text = tr('DTXMania のフォルダの許可が要ります', 'Access to the DTXMania folder is needed');
    act = { label: tr('許可して同期', 'Allow and sync'), run: syncNow };
  } else if (status === 'error') {
    cls = 'warn';
    icon = Icon.warn(15);
    text = tr('同期できませんでした', "Couldn't sync");
    act = { label: tr('もう一度', 'Try again'), run: syncNow };
  } else if (asks) {
    cls = 'warn';
    icon = Icon.info(15);
    text = tr(`確かめてほしいことが ${asks} 件あります`, `${asks} ${pl(asks, 'thing')} to check`);
  } else {
    text = at ? tr(`同期しました · ${agoText(at, now)}`, `Synced · ${agoText(at, now)}`) : tr('同期を待っています', 'Waiting to sync');
    if (next > now) text += tr(` · 次は ${hm(next)}`, ` · next at ${hm(next)}`);
  }
  return (
    <div className={`ps-home-row ${cls}`}>
      <span className="ps-hr-i">{icon}</span>
      <span className="ps-hr-t">
        <b>
          {tr('PC どうしの同期', 'PC sync')}
          {pc && <span className="pc">{pc}</span>}
        </b>
        <span className="lbl">
          {text}
          {tr(` · ${scopeName({ scope })} ${n} 曲`, ` · ${scopeName({ scope })}: ${n}`)}
          {nPc > 1 && tr(` · PC ${nPc} 台`, ` · ${nPc} PCs`)}
        </span>
      </span>
      {act && (
        <button className="btn small ps-amber" onClick={act.run}>
          {act.label}
        </button>
      )}
      <button className="btn small" onClick={() => openSyncPanel('log')}>
        {asks && !act ? tr('記録で答える', 'Answer in the log') : tr('記録を見る', 'See the log')}
      </button>
    </div>
  );
}

/** 設定の「Google Drive」：PC どうしの同期 */
export function PcSyncSettingsCard() {
  const set = usePcSync((s) => s.settings);
  const at = usePcSync((s) => s.state.at);
  const pcs = usePcSync(pcsOf);
  const others = otherPcs(pcs, set).map((p) => p.name);
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
          'DTXMania の曲を、Google Drive の「DTX Web Editor / DTXFiles」を通して、ほかの PC と合わせます。PC は何台でもよく、どの PC でも作れて遊べます。譜面・音は新しい方に（古い方は控えに 30 日）、成績とゴーストはどの PC の記録もまとめます。アプリを開いたとき・開いている間は 5 分ごと・保存したときに合わせます。',
          'Keeps your DTXMania songs in step with your other PCs through "DTX Web Editor / DTXFiles" on Google Drive. Any number of PCs, and each one can both make and play. Charts and sounds take the newer one (the older is kept as a backup for 30 days); records and ghosts from every PC are merged. It syncs when the app opens, every 5 minutes while open, and when you save.',
        )}
      </p>
      {set.on && (
        <p className="lbl">
          {tr(
            `${scopeName(set)} ${synced.n} 曲 · 前の同期 ${at ? agoText(at, now) : 'まだ'}`,
            `${scopeName(set)}: ${synced.n} ${pl(synced.n, 'song')} · last sync ${at ? agoText(at, now) : 'not yet'}`,
          )}
          {others.length > 0 &&
            tr(` · ほかの PC ${others.length} 台（${pcNames(others)}）`, ` · ${others.length} other ${pl(others.length, 'PC')} (${pcNames(others)})`)}
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
