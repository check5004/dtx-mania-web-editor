// 初めての同期の前の確認（画面 5）：Drive の曲とこの PC の曲を比べた下見（まだ何も書いていない）。
// 取る・送る・まとめる・新しい方にする・確かめてほしいこと（おすすめを選んである）と、曲ごとの表。
import { useMemo, useState } from 'react';
import { pl, tr } from '../../i18n';
import { useNxLib } from '../../nxlib/store';
import { bytesText } from '../../nxlib/view';
import { BACKUP_NAME } from '../../sync/engine';
import { openSyncPanel, startFirst, usePcSync } from '../../sync/store';
import type { Ask, RunReport, SongReport } from '../../sync/types';
import { Icon } from '../icons';
import { updText } from '../nxlib/parts';
import { chartName, libSongOf, progressText } from './common';

/** 聞くことの、おすすめの答え */
export function recommended(a: Ask): string {
  if (a.kind === 'same') return 'join';
  if (a.kind === 'gone') return 'leave';
  // この PC の方が新しい（時計がずれているときも、見えている時刻で新しい方）
  return a.local.time > a.remote.time ? 'mine' : 'theirs';
}

/** 聞くことの答えの選び方 */
export function askChoices(a: Ask, pc: string): { v: string; t: string; d: string }[] {
  const other = a.kind === 'file' ? a.remote.dev || tr('ほかの PC', 'the other PC') : '';
  switch (a.kind) {
    case 'file':
      return [
        {
          v: 'mine',
          t: tr('この PC の版を送る', "Send this PC's version"),
          d: tr(`${other} の版は控えに 30 日、記録から戻せます。`, `${other}'s version is kept as a backup for 30 days and can be restored from the log.`),
        },
        {
          v: 'theirs',
          t: tr('Drive の版を取る', "Take Drive's version"),
          d: tr(`${other} の版にして、この PC の版を控えへ。`, `Use ${other}'s version and keep this PC's as a backup.`),
        },
      ];
    case 'same':
      return [
        {
          v: 'join',
          t: tr('同じ曲にする', 'Same song'),
          d: tr(
            '場所はこの PC のまま。ファイルごとに新しい方にして、古い版は控えへ。成績はまとめます。',
            "Keeps this PC's place. Each file takes the newer one, older ones go to backups. Records are merged.",
          ),
        },
        {
          v: 'separate',
          t: tr('別の曲として取る', 'Get as a separate song'),
          d: tr(`「${a.driveLib}」に取ります。DTXMania に同じ曲が 2 つ並びます。`, `Gets it into "${a.driveLib}". DTXMania shows the song twice.`),
        },
      ];
    case 'gone':
      return [
        {
          v: 'leave',
          t: tr('この PC だけ消したままにする', 'Keep it deleted only here'),
          d: tr('Drive とほかの PC には残します。この PC には取りません。', "Stays on Drive and other PCs. It isn't downloaded here."),
        },
        {
          v: 'trash',
          t: tr('ほかの PC でも消す', 'Delete it on other PCs too'),
          d: tr(
            'Drive のゴミ箱へ（30 日は戻せます）。ほかの PC も、直していなければ消します。',
            'Moves it to the Drive trash (restorable for 30 days). Other PCs delete it too unless they changed it.',
          ),
        },
        {
          v: 'get',
          t: tr('この PC に取り直す', 'Download it here again'),
          d: tr(`Drive から、もう一度この PC（${pc}）に取ります。`, `Downloads it from Drive to this PC (${pc}) again.`),
        },
      ];
  }
}

/** 聞くことの見出しと説明 */
export function askHead(a: Ask, songName: (lib: string, path: string) => string): { title: string; sub: string; tag: string; text: string } {
  switch (a.kind) {
    case 'file':
      return {
        title: tr(`${a.title} の ${songName(a.lib, a.path)}`, `${songName(a.lib, a.path)} of ${a.title}`),
        sub: a.lib,
        tag: a.why === 'clock' ? tr('時計がずれています', 'Clock is off') : tr('この PC の方が新しい', 'Newer on this PC'),
        text:
          a.why === 'clock'
            ? tr('この PC の時計が Drive と 5 分以上ずれているので、どちらが新しいか決められません。', "This PC's clock is more than 5 minutes off from Drive, so it can't tell which is newer.")
            : tr(
                'この PC の方が新しい日付です。初めて合わせるので、どちらの PC で直したか分からないので聞きます。',
                "This PC's copy has a newer date. This is the first sync, so it can't tell which PC changed it.",
              ),
      };
    case 'same':
      return {
        title: a.title,
        sub: a.artist,
        tag: tr('同じ曲ですか？', 'Same song?'),
        text: tr(
          `この PC では「${a.localLib}」、Drive では「${a.driveLib}」にあります。曲名とアーティストが同じです。`,
          `On this PC it is in "${a.localLib}", on Drive in "${a.driveLib}". The title and artist are the same.`,
        ),
      };
    case 'gone':
      return {
        title: a.title,
        sub: a.lib,
        tag: tr('この PC に無い', 'Missing here'),
        text: tr(`この PC で合わせていた「${a.lib}」のフォルダがありません（消した・動かした）。`, `The "${a.lib}" folder synced on this PC is gone (deleted or moved).`),
      };
  }
}

/** 聞くことの 2 つの版（この PC・Drive） */
export function AskVersions({ a, choice }: { a: Ask; choice: string }) {
  if (a.kind === 'file') {
    const localNew = a.local.time > a.remote.time;
    return (
      <div className="ps-vs">
        <div className={`ps-ver ${choice === 'mine' ? 'won' : ''}`}>
          <b>
            {tr('この PC', 'This PC')}
            {localNew && <span className="new">{tr('新しい', 'Newer')}</span>}
          </b>
          <span className="r">
            <span>{updText(a.local.time)}</span>
            <span className="mono">{bytesText(a.local.size)}</span>
          </span>
        </div>
        <div className={`ps-ver ${choice === 'theirs' ? 'won' : ''}`}>
          <b>
            {a.remote.dev ? tr(`Drive（${a.remote.dev}）`, `Drive (${a.remote.dev})`) : 'Drive'}
            {!localNew && <span className="new">{tr('新しい', 'Newer')}</span>}
          </b>
          <span className="r">
            <span>{updText(a.remote.time)}</span>
            <span className="mono">{bytesText(a.remote.size)}</span>
          </span>
        </div>
      </div>
    );
  }
  if (a.kind === 'same') {
    return (
      <div className="ps-vs">
        <div className="ps-ver">
          <span className="w">{tr(`この PC：${a.localLib}`, `This PC: ${a.localLib}`)}</span>
          <span>{tr(`譜面 ${a.local.charts} · ${updText(a.local.time)}`, `${a.local.charts} ${pl(a.local.charts, 'chart')} · ${updText(a.local.time)}`)}</span>
        </div>
        <div className="ps-ver">
          <span className="w">{tr(`Drive：${a.driveLib}`, `Drive: ${a.driveLib}`)}</span>
          <span>{a.remote.dev ? tr(`${updText(a.remote.time)}（${a.remote.dev}）`, `${updText(a.remote.time)} (${a.remote.dev})`) : updText(a.remote.time)}</span>
        </div>
      </div>
    );
  }
  return null;
}

/** 聞くこと 1 つ（初めての同期の画面・記録） */
export function AskCard({ a, value, onChange, pc, songName }: { a: Ask; value: string; onChange: (v: string) => void; pc: string; songName: (lib: string, path: string) => string }) {
  const h = askHead(a, songName);
  const rec = recommended(a);
  return (
    <div className="ps-q">
      <div className="ps-qh">
        <span className="ps-ei ask">{a.kind === 'same' ? Icon.merge(13) : Icon.warn(13)}</span>
        <span className="tx">
          <b>{h.title}</b>
          <span className="lbl">{h.sub}</span>
        </span>
        <span className="tag">{h.tag}</span>
      </div>
      <p>{h.text}</p>
      <AskVersions a={a} choice={value} />
      <div className="ps-ch" role="radiogroup" aria-label={h.title}>
        {askChoices(a, pc).map((c) => (
          <button key={c.v} className={`ps-opt ${value === c.v ? 'on' : ''}`} role="radio" aria-checked={value === c.v} onClick={() => onChange(c.v)}>
            <span className="ps-radio" />
            <span className="ps-ob">
              <span className="t">
                {c.t}
                {c.v === rec && <span className="rec">{tr('おすすめ', 'Recommended')}</span>}
              </span>
              <span className="d">{c.d}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 曲ごとの「何をするか」の印 */
function songActs(s: SongReport, asks: number): { k: string; t: string }[] {
  const out: { k: string; t: string }[] = [];
  if (asks) out.push({ k: 'ask', t: tr(`確かめる ${asks}`, `Check ${asks}`) });
  if (s.where === 'none') out.push({ k: '', t: tr('新しい曲を取る', 'Get new song') });
  else if (s.got.length) out.push({ k: '', t: tr(`取る ${s.got.length}`, `Get ${s.got.length}`) });
  if (s.where === 'new') out.push({ k: 'up', t: tr('新しい曲を送る', 'Send new song') });
  else if (s.sent.length)
    out.push({
      k: 'up',
      t: tr(`送る ${s.sent.length}`, `Send ${s.sent.length}`),
    });
  if (s.newer.length)
    out.push({
      k: 'merge',
      t: tr(`新しい方 ${s.newer.length}`, `Newer ${s.newer.length}`),
    });
  if (s.merged.length)
    out.push({
      k: 'merge',
      t: tr(`成績をまとめる ${s.merged.length}`, `Merge records ${s.merged.length}`),
    });
  if (s.scoresGot.length)
    out.push({
      k: '',
      t: tr(`成績を取る ${s.scoresGot.length}`, `Get records ${s.scoresGot.length}`),
    });
  if (s.scoresSent.length)
    out.push({
      k: 'up',
      t: tr(`成績を送る ${s.scoresSent.length}`, `Send records ${s.scoresSent.length}`),
    });
  if (s.wait.length) out.push({ k: 'dim', t: tr('開いている曲', 'Open in editor') });
  if (s.trashed.length || s.deleted.length)
    out.push({
      k: 'del',
      t: tr(`消す ${s.trashed.length + s.deleted.length}`, `Delete ${s.trashed.length + s.deleted.length}`),
    });
  if (s.error) out.push({ k: 'del', t: tr('合わせられない', "Can't sync") });
  if (!out.length) out.push({ k: 'dim', t: tr('そのまま', 'No change') });
  return out;
}

type Tab = 'all' | 'get' | 'send' | 'newer' | 'score' | 'ask';

/** 下見のまとめ（タイル・ボタンの数） */
export function previewSum(rep: RunReport) {
  let gotBytes = 0;
  let sentBytes = 0;
  let newSongs = 0;
  let gotFiles = 0;
  let sentSongs = 0;
  let sentFiles = 0;
  let scoreSent = 0;
  let merged = 0;
  let newer = 0;
  const newerSongs = new Set<string>();
  for (const s of rep.songs) {
    gotBytes += s.gotBytes;
    sentBytes += s.sentBytes;
    if (s.where === 'none') newSongs++;
    gotFiles += s.got.length;
    if (s.sent.length) sentSongs++;
    sentFiles += s.sent.length;
    scoreSent += s.scoresSent.length;
    merged += s.merged.length;
    newer += s.newer.length;
    if (s.newer.length) newerSongs.add(s.lib);
  }
  return {
    gotBytes,
    sentBytes,
    newSongs,
    gotFiles,
    sentSongs,
    sentFiles,
    scoreSent,
    merged,
    newer,
    newerSongs: newerSongs.size,
    asks: rep.asks.length,
  };
}

export function FirstPanel() {
  const preview = usePcSync((s) => s.preview);
  const previewing = usePcSync((s) => s.previewing);
  const progress = usePcSync((s) => s.progress);
  const error = usePcSync((s) => s.error);
  const pc = usePcSync((s) => s.settings.pc);
  const songs = useNxLib((s) => s.songs);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('all');
  const folders = useMemo(() => new Set(songs.map((s) => `${s.root}:${s.path.join('/')}`)).size, [songs]);

  const close = () => openSyncPanel(null);
  const back = () => openSyncPanel('setup');

  if (previewing || (!preview && !error)) {
    return (
      <div className="ps-modal wide" role="dialog" aria-modal="true" aria-busy="true">
        <div className="ps-wait">
          <span className="ps-spin">{Icon.refresh(22)}</span>
          <b>{tr('Drive の曲とこの PC の曲を比べています…', 'Comparing the songs on Drive with this PC…')}</b>
          <span className="lbl">
            {progressText(progress)}
            {progress?.song ? ` · ${progress.song}` : ''}
          </span>
          <span className="lbl">{tr('まだ何も書き換えません。', 'Nothing is changed yet.')}</span>
          <button className="btn ghost" onClick={close}>
            {tr('やめる', 'Cancel')}
          </button>
        </div>
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="ps-modal" role="dialog" aria-modal="true">
        <div className="ps-mh">
          <span className="ps-mi bad">{Icon.warn(20)}</span>
          <div className="grow">
            <h2>{tr('比べられませんでした', "Couldn't compare")}</h2>
            <p>{error}</p>
          </div>
        </div>
        <div className="ps-foot">
          <span className="lbl" />
          <button className="btn ghost" onClick={close}>
            {tr('やめる', 'Cancel')}
          </button>
          <button className="btn" onClick={back}>
            {tr('設定に戻る', 'Back to settings')}
          </button>
        </div>
      </div>
    );
  }

  const sum = previewSum(preview);
  const value = (a: Ask) => answers[a.id] ?? recommended(a);
  const songName = (lib: string, path: string) => {
    const r = preview.songs.find((x) => x.lib === lib);
    return chartName(r ? libSongOf(songs, r) : undefined, path);
  };
  const asksOf = (s: SongReport) => preview.asks.filter((a) => (a.kind === 'file' ? a.lib === s.lib : !!s.driveId && a.driveId === s.driveId)).length;
  const rows = [...preview.songs]
    .filter((s) => {
      switch (tab) {
        case 'get':
          return s.got.length > 0;
        case 'send':
          return s.sent.length > 0;
        case 'newer':
          return s.newer.length > 0;
        case 'score':
          return s.merged.length + s.scoresGot.length + s.scoresSent.length > 0;
        case 'ask':
          return asksOf(s) > 0;
        default:
          return true;
      }
    })
    .sort((a, b) => asksOf(b) - asksOf(a) || b.gotBytes + b.sentBytes - (a.gotBytes + a.sentBytes));
  const shown = rows.slice(0, 200);
  const tabs: { k: Tab; t: string; n: number }[] = [
    { k: 'all', t: tr('すべて', 'All'), n: preview.songs.length },
    {
      k: 'get',
      t: tr('取る', 'Get'),
      n: preview.songs.filter((s) => s.got.length).length,
    },
    {
      k: 'send',
      t: tr('送る', 'Send'),
      n: preview.songs.filter((s) => s.sent.length).length,
    },
    {
      k: 'newer',
      t: tr('新しい方', 'Newer'),
      n: preview.songs.filter((s) => s.newer.length).length,
    },
    {
      k: 'score',
      t: tr('成績', 'Records'),
      n: preview.songs.filter((s) => s.merged.length + s.scoresGot.length + s.scoresSent.length).length,
    },
    {
      k: 'ask',
      t: tr('確かめる', 'Check'),
      n: preview.songs.filter((s) => asksOf(s)).length,
    },
  ];
  const tiles = [
    {
      cls: '',
      ic: 'down',
      icon: Icon.arrowDown(13),
      h: tr('取る', 'Get'),
      v: bytesText(sum.gotBytes),
      s: tr(
        `新しい曲 ${sum.newSongs}・ファイル ${sum.gotFiles}。この PC に無い曲は、Drive と同じ BOX に入れます`,
        `${sum.newSongs} new ${pl(sum.newSongs, 'song')}, ${sum.gotFiles} ${pl(sum.gotFiles, 'file')}. Songs missing here go into the same BOX as on Drive`,
      ),
    },
    {
      cls: '',
      ic: 'up',
      icon: Icon.arrowUp(13),
      h: tr('送る', 'Send'),
      v: bytesText(sum.sentBytes),
      s: tr(
        `曲 ${sum.sentSongs}・ファイル ${sum.sentFiles}・成績 ${sum.scoreSent} 譜面。Drive に無い分・この PC で新しい分です`,
        `${sum.sentSongs} ${pl(sum.sentSongs, 'song')}, ${sum.sentFiles} ${pl(sum.sentFiles, 'file')}, records for ${sum.scoreSent} ${pl(sum.scoreSent, 'chart')}. What Drive lacks or is newer here`,
      ),
    },
    {
      cls: '',
      ic: 'merge',
      icon: Icon.merge(13),
      h: tr('まとめる', 'Merge'),
      v: String(sum.merged),
      u: tr('譜面', pl(sum.merged, 'chart')),
      s: tr('両方の DTXMania で遊んでいた成績。いい記録を残し、回数は多い方に', 'Records played in DTXMania on both PCs. The better records are kept, the larger play count wins'),
    },
    {
      cls: '',
      ic: 'merge',
      icon: Icon.history(13),
      h: tr('新しい方にする', 'Take newer'),
      v: String(sum.newer),
      u: tr('ファイル', pl(sum.newer, 'file')),
      s: tr(
        `両方にあって中身が違う譜面・音（${sum.newerSongs} 曲）。古い方は控えへ`,
        `Charts and sounds that differ on both sides (${sum.newerSongs} ${pl(sum.newerSongs, 'song')}). Older ones go to backups`,
      ),
    },
    {
      cls: sum.asks ? 'ask' : '',
      ic: 'ask',
      icon: Icon.warn(13),
      h: tr('確かめてほしい', 'Please check'),
      v: String(sum.asks),
      u: tr('件', pl(sum.asks, 'item')),
      s: sum.asks ? tr('おすすめを選んであります。左で変えられます', 'Recommended answers are chosen. Change them on the left') : tr('ありません', 'Nothing'),
    },
  ];
  const start = () => {
    const ans: Record<string, string> = {};
    for (const a of preview.asks) ans[a.id] = value(a);
    void startFirst(ans);
  };
  const what = [
    sum.gotBytes ? tr(`${bytesText(sum.gotBytes)} を取る`, `get ${bytesText(sum.gotBytes)}`) : '',
    sum.sentBytes ? tr(`${bytesText(sum.sentBytes)} を送る`, `send ${bytesText(sum.sentBytes)}`) : '',
  ]
    .filter(Boolean)
    .join(tr('・', ', '));
  return (
    <div className="ps-modal wide" role="dialog" aria-modal="true" aria-label={tr('初めての同期', 'First sync')}>
      <div className="ps-mh">
        <span className="ps-mi">{Icon.cloud(20)}</span>
        <div className="grow">
          <h2>{tr('初めての同期：始める前に、何が起きるかを確かめてください', 'First sync: check what will happen before it starts')}</h2>
          <p>
            {tr(
              `この PC の DTXMania の曲（${folders} 曲）と Google Drive の曲を比べました。まだ何も書き換えていません。`,
              `Compared this PC's DTXMania songs (${folders}) with the songs on Google Drive. Nothing has been changed yet.`,
            )}
          </p>
        </div>
        {pc && <span className="ps-me">{tr(`この PC：${pc}`, `This PC: ${pc}`)}</span>}
      </div>
      <div className="ps-tiles">
        {tiles.map((t) => (
          <div key={t.h} className={`ps-tl ${t.cls}`}>
            <span className="h">
              <span className={`ps-ei ${t.ic}`}>{t.icon}</span>
              {t.h}
            </span>
            <span className="v">
              {t.v}
              {t.u && <small>{t.u}</small>}
            </span>
            <span className="s">{t.s}</span>
          </div>
        ))}
      </div>
      <div className={`ps-cols ${preview.asks.length ? '' : 'one'}`}>
        {preview.asks.length > 0 && (
          <div>
            <div className="ps-colh">
              <b>{tr(`確かめてほしいこと · ${preview.asks.length}`, `Please check · ${preview.asks.length}`)}</b>
              <span className="lbl">{tr('おすすめを選んであります。変えるときだけ押してください', 'Recommended answers are chosen. Press only to change them')}</span>
            </div>
            {preview.asks.map((a) => (
              <AskCard key={a.id} a={a} value={value(a)} onChange={(v) => setAnswers((x) => ({ ...x, [a.id]: v }))} pc={pc} songName={songName} />
            ))}
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="ps-colh">
            <b>{tr('曲ごとに', 'By song')}</b>
            <span className="lbl">{tr(`変わる曲 ${preview.songs.length}`, `${preview.songs.length} ${pl(preview.songs.length, 'song')} change`)}</span>
            <div className="ps-tabs" role="tablist">
              {tabs
                .filter((t) => t.k === 'all' || t.n > 0)
                .map((t) => (
                  <button key={t.k} className={tab === t.k ? 'on' : ''} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}>
                    {t.t} {t.n}
                  </button>
                ))}
            </div>
          </div>
          {preview.songs.length === 0 ? (
            <div className="ps-empty">{tr('取る物も送る物もありません。始めると、これからの変化を合わせます。', 'Nothing to get or send. Once started, changes from now on are synced.')}</div>
          ) : (
            <div className="ps-tbl">
              <div className="ps-tr h">
                <span>{tr('曲', 'Song')}</span>
                <span>{tr('この PC', 'This PC')}</span>
                <span>{tr('何をするか', 'What happens')}</span>
                <span style={{ textAlign: 'right' }}>{tr('大きさ', 'Size')}</span>
              </div>
              {shown.map((s, i) => (
                <div key={`${s.lib}:${i}`} className="ps-tr">
                  <span className="nm">
                    <b>{s.title}</b>
                    <span>{s.lib}</span>
                  </span>
                  <span className={`here ${s.where === 'none' ? 'amber' : ''}`}>
                    {s.where === 'none' ? tr('無い', 'Missing') : s.where === 'new' ? tr('この PC だけ', 'Only here') : tr('ある', 'Here')}
                  </span>
                  <span className="do">
                    {songActs(s, asksOf(s)).map((p, j) => (
                      <span key={j} className={`ps-tp ${p.k}`}>
                        {p.t}
                      </span>
                    ))}
                  </span>
                  <span className="sz">{s.gotBytes + s.sentBytes ? bytesText(s.gotBytes + s.sentBytes) : '—'}</span>
                </div>
              ))}
              {rows.length > shown.length && (
                <div className="ps-more">{tr(`ほか ${rows.length - shown.length} 曲`, `${rows.length - shown.length} more ${pl(rows.length - shown.length, 'song')}`)}</div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="ps-notes">
        <div>
          <span className="ps-ei score">{Icon.info(13)}</span>
          <span>
            <b>{tr('DTXMania は開いたままで大丈夫です。', 'DTXMania can stay open.')}</b>
            {tr(
              '遊んでいる曲のファイルは書けないので、次の同期で合わせます。取った曲は、DTXMania の Config → System の「Fast Reload」か、DTXMania を開き直すと出ます。',
              ' Files of the song being played can’t be written, so they are synced next time. Songs you get show up after "Fast Reload" in DTXMania’s Config → System, or when DTXMania restarts.',
            )}
          </span>
        </div>
        <div>
          <span className="ps-ei merge">{Icon.history(13)}</span>
          <span>
            <b>{tr('残さなかった方は控えに。', 'The one not kept becomes a backup.')}</b>
            {tr(
              'Drive の「DTX Web Editor / 控え」に 30 日残し、同期の記録から戻せます。初めての同期で、この PC から消すファイルはありません。',
              ` It stays in "DTX Web Editor / ${BACKUP_NAME}" on Drive for 30 days and can be restored from the sync log. The first sync deletes nothing on this PC.`,
            )}
          </span>
        </div>
      </div>
      <div className="ps-foot">
        <span className="lbl">
          {tr('このあとは、アプリを開いたときと、開いている間 5 分ごとに合わせます。', 'After this, syncing happens when the app opens and every 5 minutes while it is open.')}
        </span>
        <button className="btn ghost" onClick={close}>
          {tr('やめる', 'Cancel')}
        </button>
        <button className="btn" onClick={back}>
          {tr('設定に戻る', 'Back to settings')}
        </button>
        <button className="btn primary" onClick={start}>
          {what ? tr(`同期を始める（${what}）`, `Start syncing (${what})`) : tr('同期を始める', 'Start syncing')}
        </button>
      </div>
    </div>
  );
}
