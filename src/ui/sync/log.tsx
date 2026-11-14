// 同期の記録（画面 2。上の帯を押すと右から出る）：今の様子と「今すぐ同期」、確かめてほしいこと、1 回ごとの同期で取った・送った・まとめた・
// 新しい方にした（控えから戻す）・消した・あとで にしたこと。
import { useMemo, useState, type ReactNode } from 'react';
import { isJa, pl, tr } from '../../i18n';
import { confirmDiscard, reopenFromFolder } from '../../app/fileActions';
import type { LibSong } from '../../nxlib/scan';
import { useNxLib } from '../../nxlib/store';
import { bytesText } from '../../nxlib/view';
import { useEditor } from '../../store/editor';
import { answerAndSync, markDone, openSyncPanel, pcSyncPlace, restoreFromLog, syncNow, usePcSync, type LogEntry } from '../../sync/store';
import { BACKUP_NAME } from '../../sync/engine';
import type { Ask, SongReport } from '../../sync/types';
import { Icon } from '../icons';
import { updText } from '../nxlib/parts';
import { agoText, chartName, fileList, hm, isChartFile, libSongOf, newsText, progressText, runTitle, samePath, scopeName, useNow } from './common';
import { AskCard, recommended } from './first';

/** 控えを Drive の画面で開く */
const driveFileUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

export function LogDrawer() {
  const set = usePcSync((s) => s.settings);
  const status = usePcSync((s) => s.status);
  const at = usePcSync((s) => s.state.at);
  const next = usePcSync((s) => s.next);
  const log = usePcSync((s) => s.log);
  const progress = usePcSync((s) => s.progress);
  const error = usePcSync((s) => s.error);
  const songs = useNxLib((s) => s.songs);
  const now = useNow();
  const asks = log[0]?.asks ?? [];
  const runs = log.filter((l) => !l.dry);
  const close = () => openSyncPanel(null);

  let state: ReactNode;
  if (status === 'busy') {
    state = (
      <div className="ps-state run" role="status">
        <span className="ps-spin">{Icon.refresh(14)}</span>
        <span className="grow">
          {progressText(progress)}
          {progress?.song ? ` · ${progress.song}` : ''}
          {progress?.bytes ? ` · ${bytesText(progress.bytes)}` : ''}
        </span>
      </div>
    );
  } else if (status === 'auth' || status === 'perm') {
    state = (
      <div className="ps-state warn">
        {Icon.warn(14)}
        <span className="grow">
          {status === 'auth'
            ? tr('Google Drive のログインが切れました。押すとログインして同期します', 'Your Google Drive sign-in expired. Press to sign in and sync')
            : tr('DTXMania のフォルダの許可が要ります。押すと許可を聞いて同期します', 'Access to the DTXMania folder is needed. Press to allow and sync')}
        </span>
        <button className="btn small ps-amber" onClick={syncNow}>
          {status === 'auth' ? tr('ログインして同期', 'Sign in and sync') : tr('許可して同期', 'Allow and sync')}
        </button>
      </div>
    );
  } else if (status === 'error') {
    state = (
      <div className="ps-state err">
        {Icon.warn(14)}
        <span className="grow">{tr(`同期できませんでした：${error}`, `Couldn't sync: ${error}`)}</span>
        <button className="btn small" onClick={syncNow}>
          {tr('もう一度', 'Try again')}
        </button>
      </div>
    );
  } else {
    state = (
      <div className="ps-state">
        {Icon.checkCircle(14)}
        <span className="grow">
          {at ? tr(`${hm(at)} に同期しました（${agoText(at, now)}）`, `Synced at ${hm(at)} (${agoText(at, now)})`) : tr('まだ同期していません', 'Not synced yet')}
          {next > now && tr(` · 次は ${hm(next)}`, ` · next at ${hm(next)}`)}
          {` · ${scopeName(set)}`}
        </span>
        <button className="btn small" onClick={syncNow}>
          {tr('今すぐ同期', 'Sync now')}
        </button>
      </div>
    );
  }

  return (
    <aside className="ps-drawer" role="dialog" aria-modal="true" aria-label={tr('同期の記録', 'Sync log')}>
      <div className="ps-dhd">
        <div className="t">
          <span className="tx">
            <b>{tr('同期の記録', 'Sync log')}</b>
            <span className="lbl">{tr(`この PC：${set.pc || '—'} · Drive の「DTX Web Editor / DTXFiles」`, `This PC: ${set.pc || '—'} · "DTX Web Editor / DTXFiles" on Drive`)}</span>
          </span>
          <button className="btn small" onClick={() => openSyncPanel('setup')}>
            {tr('設定', 'Settings')}
          </button>
          <button className="ib" onClick={close} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
            {Icon.close(14)}
          </button>
        </div>
        {state}
      </div>
      <div className="ps-body">
        {asks.length > 0 && <Asks asks={asks} songs={songs} log={log} pc={set.pc} busy={status === 'busy'} />}
        {runs.length === 0 && asks.length === 0 ? (
          <div className="ps-empty">{tr('まだ記録がありません。同期すると、ここに取った物・送った物が出ます。', 'No log yet. After syncing, what was got and sent shows here.')}</div>
        ) : (
          runs.map((l) => <Run key={l.at} l={l} songs={songs} me={set.pc} />)
        )}
      </div>
      <div className="ps-dfoot">
        {Icon.info(12)}
        <span>
          {tr('記録はこの PC に 30 日残します。消したファイルと控えは Drive に 30 日残ります。', 'The log is kept on this PC for 30 days. Deleted files and backups stay on Drive for 30 days.')}
        </span>
      </div>
    </aside>
  );
}

/** 確かめてほしいこと（答えて同期する） */
function Asks({ asks, songs, log, pc, busy }: { asks: readonly Ask[]; songs: readonly LibSong[]; log: readonly LogEntry[]; pc: string; busy: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const value = (a: Ask) => answers[a.id] ?? recommended(a);
  const songName = (lib: string, path: string) => {
    for (const l of log) {
      const r = l.songs.find((x) => x.lib === lib);
      if (r) return chartName(libSongOf(songs, r), path);
    }
    return path.split('/').pop() ?? path;
  };
  return (
    <div className="ps-run">
      <div className="ps-rh">
        <span className="ps-ei ask">{Icon.warn(12)}</span>
        {tr(`確かめてほしいこと · ${asks.length}`, `Please check · ${asks.length}`)}
        <span className="lbl">{tr('答えるまで、その曲・ファイルは合わせずに待ちます', 'Those songs and files wait until you answer')}</span>
      </div>
      {asks.map((a) => (
        <AskCard key={a.id} a={a} value={value(a)} onChange={(v) => setAnswers((x) => ({ ...x, [a.id]: v }))} pc={pc} songName={songName} />
      ))}
      <div className="ps-acts">
        <span className="grow" />
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            const ans: Record<string, string> = {};
            for (const a of asks) ans[a.id] = value(a);
            answerAndSync(ans);
          }}
        >
          {tr('答えて同期する', 'Answer and sync')}
        </button>
      </div>
    </div>
  );
}

/** 1 回の同期 */
function Run({ l, songs, me }: { l: LogEntry; songs: readonly LibSong[]; me: string }) {
  const evs: ReactNode[] = [];
  const name = (s: SongReport) => s.title || s.lib.split('/').pop() || s.lib;
  const song = (s: SongReport) => libSongOf(songs, s);
  const from = useMemo(() => [...new Set(l.songs.map((s) => s.from).filter((x): x is string => !!x))], [l.songs]);
  const boxes = useNxLib((st) => st.boxes);
  // BOX の名前（box.def の #TITLE。無ければ「DTXFiles.」を除いたフォルダ名。DTXMania と同じ）
  const boxName = (dir: string) => boxes.find((b) => b.dirName.toLowerCase() === dir.toLowerCase())?.title ?? dir.replace(/^dtxfiles\./i, '');

  // 成績（取った）
  const scoreSongs = l.songs.filter((s) => (s.news ?? []).some((n) => !n.merged) || (s.scoresGot.length && !s.merged.length));
  if (scoreSongs.length) {
    evs.push(
      <Ev key="score" ic="score" icon={Icon.trophy(13)} title={tr(`成績を取り込みました · ${scoreSongs.length} 曲`, `Got records · ${scoreSongs.length} ${pl(scoreSongs.length, 'song')}`)}>
        {scoreSongs.slice(0, 8).map((s, i) => {
          const news = (s.news ?? []).filter((n) => !n.merged);
          return (
            <Ln key={i} nm={name(s)}>
              {news.length
                ? news.map((n) => newsText(n, chartName(song(s), n.chart))).join(tr('・', ', '))
                : tr(`${s.scoresGot.map((c) => chartName(song(s), c)).join('・')}（ゴーストも）`, `${s.scoresGot.map((c) => chartName(song(s), c)).join(', ')} (with ghosts)`)}
            </Ln>
          );
        })}
        {scoreSongs.length > 8 && <span>{tr(`ほか ${scoreSongs.length - 8} 曲`, `${scoreSongs.length - 8} more`)}</span>}
      </Ev>,
    );
  }
  // 成績（まとめた）
  for (const s of l.songs.filter((x) => x.merged.length)) {
    const news = (s.news ?? []).filter((n) => n.merged);
    const max = s.merged.every((m) => m.max);
    evs.push(
      <Ev key={`merged:${s.lib}`} ic="merge" icon={Icon.merge(13)} title={tr(`成績をまとめました · ${name(s)}`, `Merged records · ${name(s)}`)}>
        <span>
          {max
            ? tr(
                '両方の DTXMania に成績がありました。いい方の記録を残し、回数は多い方にしました（初めて合わせたので、同じ回を 2 回数えないように）。',
                'Both PCs had records in DTXMania. The better records were kept and the larger play count was used (first time, so the same plays are not counted twice).',
              )
            : tr(
                '両方の DTXMania で遊んでいました。いい方の記録を残し、回数は両方で増えた分を足しました。',
                'It was played in DTXMania on both PCs. The better records were kept and the play counts from both were added up.',
              )}
          {news.length > 0 && ` ${news.map((n) => newsText(n, chartName(song(s), n.chart))).join(tr('・', ', '))}`}
        </span>
      </Ev>,
    );
  }
  // 新しい曲・取ったファイル
  const newSongs = l.songs.filter((s) => s.where === 'none' && s.got.length);
  for (const s of newSongs) {
    const box = s.lib.split('/').slice(0, -1).map(boxName).join(' / ');
    evs.push(
      <Ev key={`new:${s.lib}`} ic="down" icon={Icon.arrowDown(13)} title={tr(`新しい曲を取り込みました · ${name(s)}`, `Got a new song · ${name(s)}`)}>
        <span>
          {box ? tr(`BOX「${box}」に入れました`, `Put into the BOX "${box}"`) : tr('BOX の外に入れました', 'Put outside any BOX')}
          {s.from ? tr(`（${s.from} から）`, ` (from ${s.from})`) : ''}
          {tr('。DTXMania の Fast Reload で出ます。', '. It shows up after Fast Reload in DTXMania.')}
        </span>
      </Ev>,
    );
  }
  const gotSongs = l.songs.filter((s) => s.where !== 'none' && s.got.length);
  if (gotSongs.length) {
    const bytes = gotSongs.reduce((a, s) => a + s.gotBytes, 0);
    evs.push(
      <Ev
        key="got"
        ic="down"
        icon={Icon.arrowDown(13)}
        title={tr(`新しいファイルを取り込みました · ${gotSongs.length} 曲 · ${bytesText(bytes)}`, `Got newer files · ${gotSongs.length} ${pl(gotSongs.length, 'song')} · ${bytesText(bytes)}`)}
      >
        {gotSongs.slice(0, 8).map((s, i) => {
          const charts = s.got.filter(isChartFile);
          return (
            <Ln key={i} nm={name(s)}>
              {charts.length
                ? tr(
                    `譜面 ${charts.length}（${charts.map((c) => chartName(song(s), c)).join('・')}）`,
                    `${charts.length} ${pl(charts.length, 'chart')} (${charts.map((c) => chartName(song(s), c)).join(', ')})`,
                  )
                : ''}
              {charts.length && charts.length < s.got.length ? tr(' · ', ' · ') : ''}
              {charts.length < s.got.length ? fileList(s.got.filter((p) => !isChartFile(p))) : ''}
              {s.from ? tr(`（${s.from}）`, ` (${s.from})`) : ''}
            </Ln>
          );
        })}
        {gotSongs.length > 8 && <span>{tr(`ほか ${gotSongs.length - 8} 曲`, `${gotSongs.length - 8} more`)}</span>}
      </Ev>,
    );
  }
  // 両方で直していたファイル（新しい方＋控え）
  for (const s of l.songs) {
    for (const n of s.newer) {
      const key = `newer:${s.lib}:${n.path}`;
      evs.push(<Newer key={key} l={l} s={s} n={n} song={song(s)} me={me} />);
    }
  }
  // 送った
  const sentSongs = l.songs.filter((s) => s.sent.length);
  if (sentSongs.length) {
    const bytes = sentSongs.reduce((a, s) => a + s.sentBytes, 0);
    evs.push(
      <Ev
        key="sent"
        ic="up"
        icon={Icon.arrowUp(13)}
        title={tr(`送りました · ${sentSongs.length} 曲 · ${bytesText(bytes)}`, `Sent · ${sentSongs.length} ${pl(sentSongs.length, 'song')} · ${bytesText(bytes)}`)}
      >
        {sentSongs.slice(0, 8).map((s, i) => {
          const charts = s.sent.filter(isChartFile);
          return (
            <Ln key={i} nm={name(s)}>
              {s.where === 'new' ? tr('新しい曲 · ', 'New song · ') : ''}
              {charts.length
                ? tr(
                    `譜面 ${charts.length}（${charts.map((c) => chartName(song(s), c)).join('・')}）`,
                    `${charts.length} ${pl(charts.length, 'chart')} (${charts.map((c) => chartName(song(s), c)).join(', ')})`,
                  )
                : ''}
              {charts.length && charts.length < s.sent.length ? ' · ' : ''}
              {charts.length < s.sent.length ? fileList(s.sent.filter((p) => !isChartFile(p))) : ''}
            </Ln>
          );
        })}
        {sentSongs.length > 8 && <span>{tr(`ほか ${sentSongs.length - 8} 曲`, `${sentSongs.length - 8} more`)}</span>}
      </Ev>,
    );
  }
  const scoreSent = l.songs.filter((s) => s.scoresSent.length);
  if (scoreSent.length) {
    evs.push(
      <Ev key="scoreSent" ic="up" icon={Icon.trophy(13)} title={tr(`成績を送りました · ${scoreSent.length} 曲`, `Sent records · ${scoreSent.length} ${pl(scoreSent.length, 'song')}`)}>
        <span>
          {scoreSent
            .slice(0, 6)
            .map((s) => tr(`${name(s)}（${s.scoresSent.map((c) => chartName(song(s), c)).join('・')}）`, `${name(s)} (${s.scoresSent.map((c) => chartName(song(s), c)).join(', ')})`))
            .join(tr('、', ', '))}
          {scoreSent.length > 6 && tr(` ほか ${scoreSent.length - 6} 曲`, ` and ${scoreSent.length - 6} more`)}
        </span>
      </Ev>,
    );
  }
  // 消した
  for (const s of l.songs.filter((x) => x.trashed.length)) {
    evs.push(
      <Ev key={`trash:${s.lib}`} ic="del" icon={Icon.trash(13)} title={tr(`この PC で消したファイル · ${s.trashed.length}`, `Deleted on this PC · ${s.trashed.length}`)}>
        <span>
          {tr(
            `${name(s)} の ${fileList(s.trashed)} を Drive のゴミ箱に移しました（30 日は戻せます）。ほかの PC でも、前に合わせたままなら消します。`,
            `Moved ${fileList(s.trashed)} of ${name(s)} to the Drive trash (restorable for 30 days). Other PCs delete them too if unchanged since the last sync.`,
          )}
        </span>
      </Ev>,
    );
  }
  for (const s of l.songs.filter((x) => x.deleted.length)) {
    evs.push(
      <Ev key={`del:${s.lib}`} ic="del" icon={Icon.trash(13)} title={tr(`ほかの PC で消したファイル · ${s.deleted.length}`, `Deleted on another PC · ${s.deleted.length}`)}>
        <span>
          {tr(
            `${name(s)} の ${fileList(s.deleted)} を、この PC でも消しました。Drive のゴミ箱から 30 日は戻せます。`,
            `Deleted ${fileList(s.deleted)} of ${name(s)} on this PC too. It can be restored from the Drive trash for 30 days.`,
          )}
        </span>
      </Ev>,
    );
  }
  for (const s of l.songs.filter((x) => x.removed)) {
    evs.push(
      <Ev key={`rm:${s.lib}`} ic="del" icon={Icon.trash(13)} title={tr(`ほかの PC で消した曲 · ${name(s)}`, `Song deleted on another PC · ${name(s)}`)}>
        <span>
          {tr(
            'この PC でも消しました（この PC で直したファイルは無かったので）。Drive のゴミ箱から 30 日は戻せます。',
            'Deleted on this PC too (nothing had been changed here). It can be restored from the Drive trash for 30 days.',
          )}
        </span>
      </Ev>,
    );
  }
  // Drive に同じ曲が 2 つあった（前の版の初めての同期で作った）：この PC が使っていない方を片付けた
  const dups = l.songs.filter((x) => x.dup);
  if (dups.length) {
    evs.push(
      <Ev key="dup" ic="del" icon={Icon.trash(13)} title={tr(`Drive に 2 つあった曲を 1 つにしました · ${dups.length} 曲`, `Removed duplicate songs on Drive · ${dups.length} ${pl(dups.length, 'song')}`)}>
        <span>
          {tr(
            `${dups.map(name).join('、')}：同じ曲が Drive に 2 つあったので、この PC で使っていない方を Drive のゴミ箱に移しました（30 日は戻せます）。この PC の曲はそのままです。`,
            `${dups.map(name).join(', ')}: the same song was on Drive twice, so the copy this PC doesn't use was moved to the Drive trash (restorable for 30 days). The song on this PC is unchanged.`,
          )}
        </span>
      </Ev>,
    );
  }
  for (const s of l.songs.filter((x) => x.kept)) {
    evs.push(
      <Ev key={`kept:${s.lib}`} ic="ask" icon={Icon.shield(13)} title={tr(`消さずに残しました · ${name(s)}`, `Kept instead of deleting · ${name(s)}`)}>
        <span>
          {tr(
            `ファイルのほとんど（${s.kept} 個）が片方から消えていたので、消さずにもう一度合わせました。曲ごと消したいときは、曲のフォルダを消してください。`,
            `Most files (${s.kept}) were gone on one side, so they were synced back instead of deleted. To delete the song, delete its whole folder.`,
          )}
        </span>
      </Ev>,
    );
  }
  // あとで・開いている曲
  const later = l.songs.filter((x) => x.later.length);
  if (later.length) {
    evs.push(
      <Ev
        key="later"
        ic="skip"
        icon={Icon.clock(13)}
        title={tr(
          `あとで · ${later.reduce((a, s) => a + s.later.length, 0)} ファイル`,
          `Later · ${later.reduce((a, s) => a + s.later.length, 0)} ${pl(
            later.reduce((a, s) => a + s.later.length, 0),
            'file',
          )}`,
        )}
      >
        <span>
          {tr(
            `${later.map((s) => `${name(s)} の ${fileList(s.later, 2)}`).join('、')} は DTXMania が開いていて書けませんでした。次の同期でもう一度。`,
            `${later.map((s) => `${fileList(s.later, 2)} of ${name(s)}`).join(', ')} couldn't be written because DTXMania had them open. The next sync tries again.`,
          )}
        </span>
      </Ev>,
    );
  }
  for (const s of l.songs.filter((x) => x.wait.length)) {
    evs.push(
      <Ev key={`wait:${s.lib}`} ic="skip" icon={Icon.pencil(13)} title={tr(`エディタで開いている曲 · ${name(s)}`, `Open in the editor · ${name(s)}`)}>
        <span>
          {tr(
            `${fileList(s.wait)} は新しい版が Drive にありますが、開いているので取り込んでいません。エディタの「取り込む」で入ります。`,
            `${fileList(s.wait)} ${s.wait.length === 1 ? 'has a newer version' : 'have newer versions'} on Drive but ${s.wait.length === 1 ? 'is' : 'are'} open, so not taken. Use "Get" in the editor.`,
          )}
        </span>
      </Ev>,
    );
  }
  for (const s of l.songs.filter((x) => x.error)) {
    evs.push(
      <Ev key={`err:${s.lib}`} ic="del" icon={Icon.warn(13)} title={tr(`合わせられませんでした · ${name(s)}`, `Couldn't sync · ${name(s)}`)} err>
        <span>{s.error}</span>
      </Ev>,
    );
  }
  if (l.error) {
    evs.push(
      <Ev key="error" ic="del" icon={Icon.warn(13)} title={tr('同期できませんでした', "Couldn't sync")} err>
        <span>{l.error}</span>
      </Ev>,
    );
  }
  if (!evs.length) return null;
  const chips = from.map((f) => (
    <span key={f} className="pc">
      {f}
    </span>
  ));
  return (
    <div className="ps-run">
      <div className="ps-rh">
        <span className="t">{updText(l.at)}</span>
        {from.length ? (
          isJa() ? (
            <>{chips}の変更を取り込みました</>
          ) : (
            <>Got changes from {chips}</>
          )
        ) : (
          <>
            <span className="pc me">{l.pc || tr('この PC', 'This PC')}</span>
            {runTitle(l.why)}
          </>
        )}
      </div>
      {evs}
    </div>
  );
}

function Ev({ ic, icon, title, children, err }: { ic: string; icon: ReactNode; title: string; children?: ReactNode; err?: boolean }) {
  return (
    <div className={`ps-ev ${err ? 'err' : ''}`}>
      <span className={`ps-ei ${ic}`}>{icon}</span>
      <div className="ps-eb">
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

function Ln({ nm, children }: { nm: string; children: ReactNode }) {
  return (
    <div className="ln">
      <span className="nm">{nm}</span>
      <span className="v">{children}</span>
    </div>
  );
}

/** 両方で直されていたファイル：どちらを残したか・控えに戻す・これでよい */
function Newer({ l, s, n, song, me }: { l: LogEntry; s: SongReport; n: SongReport['newer'][number]; song: LibSong | undefined; me: string }) {
  const [busy, setBusy] = useState(false);
  const done = !!l.done?.includes(n.path);
  const other = n.dev || tr('ほかの PC', 'the other PC');
  const here = me ? tr(`${me}（この PC）`, `${me} (this PC)`) : tr('この PC', 'This PC');
  const name = s.title || s.lib;
  const file = n.path.split('/').pop() ?? n.path;
  const what = isChartFile(n.path) ? tr(`${name} の ${chartName(song, n.path)}（${file}）`, `${chartName(song, n.path)} of ${name} (${file})`) : tr(`${name} の ${file}`, `${file} of ${name}`);
  const keptLocal = n.kept === 'local';
  const loser = keptLocal ? other : here;
  // 同じ分に直していたら秒まで
  const sameMin = Math.floor(n.localTime / 60_000) === Math.floor(n.remoteTime / 60_000);
  const when = (t: number) => (sameMin ? `${updText(t)}:${String(new Date(t).getSeconds()).padStart(2, '0')}` : updText(t));
  const restore = async () => {
    if (!n.backup || !s.driveId) return;
    // 開いている曲なら、保存していない変更を先に聞いて、戻したあとで開き直す
    const ed = useEditor.getState();
    const place = await pcSyncPlace(ed.folder);
    const open = !!place && place.root === s.root && samePath(s.path, place.path);
    if (open && !(await confirmDiscard())) return;
    setBusy(true);
    try {
      await restoreFromLog(l.at, s.driveId, n.path, n.backup);
      const now = useEditor.getState();
      if (open && now.folder) await reopenFromFolder(now.folder, now.meta.fileName);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`ps-ev big ${done ? 'done' : ''}`}>
      <div className="hd">
        <span className="ps-ei merge">{Icon.merge(13)}</span>
        <div className="ps-eb">
          <b>{tr(`両方で直されていたファイル · ${what}`, `Changed on both PCs · ${what}`)}</b>
          <span>
            {l.why === 'first'
              ? tr(
                  `この PC と ${other} で ${file} の中身が違っていました。新しく直した方を残し、もう一方は控えにしました。`,
                  `${file} differed between this PC and ${other}. The more recently changed one was kept and the other became a backup.`,
                )
              : tr(
                  `前の同期のあと、この PC と ${other} の両方で ${file} が変わっていました。新しい方を残し、もう一方は控えにしました。`,
                  `Since the last sync, ${file} changed on both this PC and ${other}. The newer one was kept and the other became a backup.`,
                )}
          </span>
        </div>
      </div>
      <div className="ps-vs">
        <div className={`ps-ver ${keptLocal ? 'won' : ''}`}>
          <b>
            {here}
            <span className={keptLocal ? 'new' : 'old'}>{keptLocal ? tr('残した · 新しい', 'Kept · newer') : tr('控え', 'Backup')}</span>
          </b>
          <span className="r">
            <span>{tr('直した時刻', 'Changed')}</span>
            <span className="mono">{when(n.localTime)}</span>
          </span>
        </div>
        <div className={`ps-ver ${keptLocal ? '' : 'won'}`}>
          <b>
            {other}
            <span className={keptLocal ? 'old' : 'new'}>{keptLocal ? tr('控え', 'Backup') : tr('残した · 新しい', 'Kept · newer')}</span>
          </b>
          <span className="r">
            <span>{tr('直した時刻', 'Changed')}</span>
            <span className="mono">{when(n.remoteTime)}</span>
          </span>
        </div>
      </div>
      {done ? (
        <span className="lbl">{tr('確かめました。', 'Checked.')}</span>
      ) : (
        <div className="ps-acts">
          {n.backup && s.driveId && (
            <button className="btn small ps-amber" disabled={busy} onClick={() => void restore()}>
              {tr(`${loser} の版に戻す`, `Restore ${loser}'s version`)}
            </button>
          )}
          {n.backup && (
            <a className="btn small" href={driveFileUrl(n.backup)} target="_blank" rel="noreferrer">
              {tr('控えを Drive で開く', 'Open the backup in Drive')}
            </a>
          )}
          <span className="grow" />
          <button className="btn small ghost" onClick={() => markDone(l.at, n.path)}>
            {tr('これでよい', 'Looks good')}
          </button>
        </div>
      )}
      <span className="lbl">
        {tr(
          '控えは Drive の「DTX Web Editor / 控え」に 30 日残します（ほかの PC には取りません）。戻すと、どちらの PC も控えの版になります。',
          `Backups stay in "DTX Web Editor / ${BACKUP_NAME}" on Drive for 30 days (not downloaded to other PCs). Restoring puts the backup version on both PCs.`,
        )}
      </span>
    </div>
  );
}
