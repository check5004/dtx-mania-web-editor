// 本体（このブラウザの保存領域）の表示：ホームの「本体に保存している曲」の欄と、曲を本体に入れている途中の進み具合。
import { useEffect } from 'react';
import { tr } from '../i18n';
import { supportsDirectWrite } from '../fs/folder';
import { requestPersist } from '../fs/local';
import { STANDALONE_AT_START } from '../pwa/display';
import { IS_IOS } from '../store/device';
import { toast } from '../store/editor';
import { localPlace, refreshLocalSongs, useLocalSongs } from '../store/localSongs';
import { Icon } from './icons';

export function sizeText(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function askPersist() {
  const ok = await requestPersist();
  await refreshLocalSongs();
  toast(
    ok
      ? tr('ブラウザが勝手に消さない設定になりました', 'The browser will now keep this data')
      : IS_IOS && !STANDALONE_AT_START
        ? tr('Safari が許可しませんでした。ホーム画面に追加して開くと許可されやすくなります', "Safari didn't allow it. It is more likely to be allowed when opened from the Home Screen")
        : tr('ブラウザが許可しませんでした。ときどき書き出しておくと安心です', "The browser didn't allow it. Exporting now and then keeps you safe"),
    ok ? 'ok' : 'info',
    7000,
  );
}

/**
 * ホームの「本体に保存している曲」：曲の数と大きさ、ブラウザに消されないか、iPad の Safari のタブで使うときの注意。
 * PC で曲フォルダだけを使っている（本体に曲が無い）ときは出さない
 */
export function LocalStorageCard({ tablet = false }: { tablet?: boolean }) {
  const ready = useLocalSongs((s) => s.ready);
  const checked = useLocalSongs((s) => s.checked);
  const songs = useLocalSongs((s) => s.songs);
  const storage = useLocalSongs((s) => s.storage);
  useEffect(() => {
    void refreshLocalSongs();
  }, []);
  const direct = supportsDirectWrite();
  if (!checked) return null;
  const safariTab = IS_IOS && !STANDALONE_AT_START;
  if (!ready) {
    if (direct) return null;
    return (
      <div className={`notice ${tablet ? 't-notice' : ''}`}>
        <span style={{ flex: 'none' }}>{Icon.warn(tablet ? 18 : 14)}</span>
        <span>
          {tr(
            'このブラウザでは曲を本体に保存できません（プライベートブラウズなど）。リロードすると音声は消えるので、保存のときに書き出してください。',
            "This browser can't keep songs on this device (Private Browsing, for example). Audio is lost on reload, so export when you save.",
          )}
        </span>
      </div>
    );
  }
  if (direct && songs.length === 0) return null;
  const used = songs.reduce((a, x) => a + x.bytes, 0);
  const free = storage?.quota ? Math.max(0, storage.quota - storage.usage) : 0;
  return (
    <section className={`local-card ${tablet ? 't' : ''}`} aria-label={tr('本体に保存している曲', 'Songs kept on this device')}>
      <div className="local-head">
        <span className="local-i">{Icon.storage(tablet ? 22 : 18)}</span>
        <span className="local-title">
          <b>{tr(`${localPlace()}に保存している曲`, `Songs kept in ${localPlace()}`)}</b>
          <span className="lbl">
            {tr(`${songs.length} 曲 · ${sizeText(used)}`, `${songs.length} ${songs.length === 1 ? 'song' : 'songs'} · ${sizeText(used)}`)}
            {free ? tr(` · 空き ${sizeText(free)}`, ` · ${sizeText(free)} free`) : ''}
          </span>
        </span>
      </div>
      <p className="lbl local-body">
        {tr(
          'ZIP や音声ファイルから開いた曲は、原曲・ステム・ドラム抜きも含めて曲フォルダごとここに保存します。リロードしても「最近の曲」から音ごと続きを開けます。',
          'Songs opened from a ZIP or audio files are kept here as a whole song folder, including the original audio, stems and no-drums tracks. After a reload, continue from "Recent songs" with all the audio.',
        )}
      </p>
      <div className="local-row">
        {storage?.persisted ? (
          <span className="local-ok">
            {Icon.checkCircle(tablet ? 18 : 14)}
            {tr('ブラウザが勝手に消さないように守られています', 'Protected from being cleared by the browser')}
          </span>
        ) : (
          <>
            <span className="lbl grow">{tr('空きが少なくなると、ブラウザが古いデータを消すことがあります。', 'When space runs low, the browser may clear old data.')}</span>
            <button className={tablet ? 't-btn' : 'btn small'} onClick={() => void askPersist()}>
              {tr('消さないように頼む', 'Ask to keep it')}
            </button>
          </>
        )}
      </div>
      {safariTab && (
        <div className="local-warn">
          <span style={{ flex: 'none' }}>{Icon.warn(tablet ? 18 : 14)}</span>
          <span>
            {tr(
              'Safari のタブで使っています。Safari を7日使う間にこのページを一度も開かないと、保存した曲は消えます。共有 › ホーム画面に追加 から開くと、この決まりの対象外になります（ホーム画面のアプリは Safari と保存が別なので、曲はそちらで開き直してください）。',
              "You're using a Safari tab. If you don't open this page during 7 days of using Safari, the kept songs are cleared. Opening it from Share › Add to Home Screen avoids this (the Home Screen app has its own storage, so open your songs there again).",
            )}
          </span>
        </div>
      )}
    </section>
  );
}

/** 曲を本体に入れている途中の進み具合（画面の下の左に小さく） */
export function LocalCopyChip() {
  const c = useLocalSongs((s) => s.copying);
  if (!c || (c.total <= 1 && c.totalBytes < 4 << 20)) return null;
  const pct = c.totalBytes ? Math.round((c.bytes / c.totalBytes) * 100) : c.total ? Math.round((c.done / c.total) * 100) : 0;
  return (
    <div className="local-chip" role="status" aria-live="polite">
      {Icon.storage(14)}
      <span className="ellipsis">{tr(`${localPlace()}に保存しています… ${c.done}/${c.total}`, `Keeping in ${localPlace()}… ${c.done}/${c.total}`)}</span>
      <span className="mono">{pct}%</span>
      <span className="local-chip-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}
