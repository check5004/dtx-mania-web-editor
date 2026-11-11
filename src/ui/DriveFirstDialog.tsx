// 大きい曲（100 MB をこえる）を初めて Google Drive に送る前に聞く：動画を除いて送る・全部送る・この曲は送らない・あとで。
// 無料の Drive（15 GB）を、動画の大きい曲で使い切らないように。空きとこのアプリで送った曲の大きさも見せる。
import { pl, tr } from '../i18n';
import { useEffect, useState } from 'react';
import { storageQuota } from '../drive/api';
import { listDriveSongs } from '../drive/sync';
import { IS_IOS, IS_IPHONE } from '../platform';
import { customDialog } from './dialogs';

export type DriveFirstChoice = 'novideo' | 'all' | 'skip';

export interface DriveFirstAsk {
  title: string;
  /** 送るファイルの合計と、そのうちの動画 */
  total: number;
  video: number;
  videos: string[];
  /** 保存したすぐあと（「保存しました。」から始める） */
  saved: boolean;
  /** DTXMania の曲を覚えている（一覧の詳しい所で変えられる） */
  library: boolean;
}

/** 初めて送る曲が 100 MB をこえるときに聞く。あとで（閉じた）なら null */
export function askDriveFirst(o: DriveFirstAsk): Promise<DriveFirstChoice | null> {
  return customDialog<DriveFirstChoice>((done) => <DriveFirstBody o={o} done={done} />, { className: 'drive-first' });
}

function size(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 全部の大きさ（15 GB のようにちょうどなら小数を付けない） */
function limitText(n: number): string {
  const gb = n / (1 << 30);
  return Number.isInteger(gb) ? `${gb} GB` : size(n);
}

interface Quota {
  limit: number | null;
  usage: number;
  /** このアプリで送った曲の数と大きさ */
  songs: number;
  songBytes: number;
}

function DriveFirstBody({ o, done }: { o: DriveFirstAsk; done: (v: DriveFirstChoice | null) => void }) {
  const [q, setQ] = useState<Quota | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [quota, songs] = await Promise.all([storageQuota(), listDriveSongs().catch(() => [])]);
        if (live) setQ({ ...quota, songs: songs.length, songBytes: songs.reduce((a, s) => a + (s.info.s ?? 0), 0) });
      } catch {
        // 空きが分からなくても選べる
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const free = q?.limit != null ? Math.max(0, q.limit - q.usage) : null;
  const small = o.total - o.video;
  const here = IS_IPHONE ? 'iPhone' : IS_IOS ? 'iPad' : 'PC';
  const pct = (n: number) => (q?.limit ? `${Math.min(100, (n / q.limit) * 100)}%` : '0%');
  const other = q ? Math.max(0, q.usage - q.songBytes) : 0;
  const fits = (n: number) => free === null || n <= free;
  const videoName = o.videos.length === 1 ? o.videos[0].split('/').pop()! : tr(`${o.videos.length} 個`, `${o.videos.length} ${pl(o.videos.length, 'file')}`);
  return (
    <>
      <h2>{tr(`「${o.title}」を Google Drive に送りますか？`, `Send "${o.title}" to Google Drive?`)}</h2>
      <p>
        {o.saved && tr('保存しました。', 'Saved. ')}
        {tr('この曲を Drive に送るのは初めてです。', 'This is the first time this song goes to Drive. ')}
        {o.video > 0
          ? tr(`曲のフォルダは ${size(o.total)} あり、そのうち動画（${videoName}）が ${size(o.video)} です。`, `The song folder is ${size(o.total)}, and the video (${videoName}) is ${size(o.video)} of it.`)
          : tr(`曲のフォルダは ${size(o.total)} あります。`, `The song folder is ${size(o.total)}.`)}
      </p>
      {q && q.limit !== null && (
        <div className="df-quota">
          <div className="df-quota-h">
            <span>{tr(`Google Drive（${limitText(q.limit)}）`, `Google Drive (${limitText(q.limit)})`)}</span>
            <span className="mono">{tr(`空き ${size(free ?? 0)}`, `${size(free ?? 0)} free`)}</span>
          </div>
          <div className="df-meter" aria-hidden="true">
            <i className="o" style={{ width: pct(other) }} />
            <i className="u" style={{ width: pct(q.songBytes) }} />
          </div>
          <div className="df-legend">
            <span>
              <i className="o" />
              {tr(`ほかのファイル ${size(other)}`, `Other files ${size(other)}`)}
            </span>
            <span>
              <i className="u" />
              {q.songs > 0 ? tr(`このアプリで送った曲 ${q.songs}（${size(q.songBytes)}）`, `Songs sent from this app: ${q.songs} (${size(q.songBytes)})`) : tr('このアプリで送った曲 0', 'Songs sent from this app: 0')}
            </span>
          </div>
        </div>
      )}
      {o.video > 0 && (
        <button className="choice rec" disabled={!fits(small)} onClick={() => done('novideo')} autoFocus>
          <span className="grow">
            <b className="df-b">{tr('動画を除いて送る（おすすめ）', 'Send without the video (recommended)')}</b>
            <span className="lbl">
              {fits(small)
                ? tr(`動画は ${here} の曲のフォルダに残ります。ほかの機器では動画なしで開きます。`, `The video stays in the song folder on this ${here}. Other devices open the song without it.`)
                : tr('Drive の空きが足りません。', "There isn't enough free space on Drive.")}
            </span>
          </span>
          <span className="df-size mono">{size(small)}</span>
        </button>
      )}
      <button className={`choice ${o.video > 0 ? '' : 'rec'}`} disabled={!fits(o.total)} onClick={() => done('all')} autoFocus={o.video === 0}>
        <span className="grow">
          <b className="df-b">{tr('全部送る', 'Send everything')}</b>
          <span className="lbl">
            {!fits(o.total)
              ? tr('Drive の空きが足りません。', "There isn't enough free space on Drive.")
              : free !== null
                ? tr(`送ったあとの空きは ${size(free - o.total)} です。`, `${size(free - o.total)} stays free after sending.`)
                : tr('動画も送ります。', 'The video is sent too.')}
          </span>
        </span>
        <span className="df-size mono">{size(o.total)}</span>
      </button>
      <button className="choice" onClick={() => done('skip')}>
        <span className="grow">
          <b className="df-b">{tr('この曲は Drive に送らない', "Don't send this song to Drive")}</b>
          <span className="lbl">
            {tr('次からも聞きません。', "You won't be asked again. ")}
            {o.library
              ? tr('曲の一覧の詳しい所で変えられます。', 'You can change it in the song details of the song list.')
              : tr('送るときは「ファイル › Google Drive にも保存する」から。', 'To send it later, use File › Also save to Google Drive.')}
          </span>
        </span>
      </button>
      <div className="modal-actions df-acts">
        <span className="lbl">{tr('初めて送る曲が 100 MB をこえるときだけ聞きます', 'Asked only when a song sent for the first time is over 100 MB')}</span>
        <button className="btn ghost" onClick={() => done(null)}>
          {tr('あとで', 'Later')}
        </button>
      </div>
    </>
  );
}
