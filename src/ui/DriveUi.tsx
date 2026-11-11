// Google Drive の画面：ホームの「Google Drive」欄、設定の「Google Drive」、下の帯の状態、送る・取るの進み具合。
import { useEffect } from 'react';
import { pl, tr } from '../i18n';
import { checkDriveSongs, cleanDriveJunk, connectDrive, openFromDrive, pullNow, pushNow, timeText, useDriveSync } from '../app/driveActions';
import { canRedirect, loadGis, setPrefs, signOut, useDriveAuth } from '../drive/auth';
import { confirmDialog } from './dialogs';
import { Icon } from './icons';
import { sizeText } from './LocalStorage';

/** ホームの「データはどこに置くか」の一行（Drive につないでいれば、そう書く） */
export function PrivacyLine() {
  const connected = useDriveAuth((s) => s.connected);
  return (
    <>
      {connected
        ? tr('データはこのブラウザの中と、つないだ Google Drive（このアプリが作ったフォルダ）だけで扱います。', 'Your data stays in this browser and the Google Drive you connected (only the folder this app created).')
        : tr('データはこのブラウザの中だけで扱います。どこにもアップロードしません。', 'Your data stays in this browser. Nothing is uploaded anywhere.')}
    </>
  );
}

/** ホームの「Google Drive」：つなぐ・Drive から開く */
export function DriveHomeCard({ tablet = false }: { tablet?: boolean }) {
  const connected = useDriveAuth((s) => s.connected);
  const email = useDriveAuth((s) => s.email);
  const signingIn = useDriveAuth((s) => s.signingIn);
  // 押したときにすぐ小窓を開けるよう、ログインの部品を先に読む
  useEffect(() => {
    void loadGis();
  }, []);
  const btn = tablet ? 't-btn' : 'btn small';
  return (
    <section className={`local-card drive-card ${tablet ? 't' : ''}`} aria-label="Google Drive">
      <div className="local-head">
        <span className="local-i drive-i">{Icon.cloud(tablet ? 22 : 18)}</span>
        <span className="local-title">
          <b>Google Drive</b>
          <span className="lbl ellipsis">{connected ? email || tr('つないでいます', 'Connected') : tr('つないでいません', 'Not connected')}</span>
        </span>
        {connected && (
          <button className={`${btn} primary`} onClick={() => openFromDrive()}>
            {tr('Drive から開く', 'Open from Drive')}
          </button>
        )}
      </div>
      <p className="lbl local-body">
        {connected
          ? tr(
              '保存すると、曲を音ごと Drive にも送ります（まだ保存していない続きも1分ごとに）。ほかの iPad・PC では「Drive から開く」で続きを開けます。',
              'Saving also sends the song with its audio to Drive (and unsaved work every minute). On another iPad or PC, continue with "Open from Drive".',
            )
          : tr(
              'つなぐと、保存した曲を音ごと Google Drive にも送り、ほかの iPad・PC から続きを開けます。Drive には「DTX Web Editor」フォルダを作り、このアプリが作った物だけを読み書きします。',
              'Connect to also send saved songs with their audio to Google Drive and continue on another iPad or PC. It creates a "DTX Web Editor" folder and only reads and writes what this app created.',
            )}
      </p>
      {!connected && (
        <div className="local-row">
          <span className="grow" />
          <button className={`${btn} primary`} disabled={signingIn} onClick={() => connectDrive()}>
            {Icon.cloud(tablet ? 18 : 14)}
            {tr('Google Drive につなぐ', 'Connect Google Drive')}
          </button>
        </div>
      )}
    </section>
  );
}

/** 設定の「Google Drive」 */
export function DriveSettings() {
  const a = useDriveAuth();
  useEffect(() => {
    void loadGis();
  }, []);
  const disconnect = async () => {
    const ok = await confirmDialog({
      title: tr('Google Drive を切りますか？', 'Disconnect Google Drive?'),
      body: tr('Drive にある曲は消えません。もう一度つなげば続きから使えます。', 'Songs on Drive are not deleted. Connect again to pick up where you left off.'),
      ok: tr('切る', 'Disconnect'),
    });
    if (ok) signOut();
  };
  return (
    <div className="settings-col drive-set">
      <h2>Google Drive</h2>
      <section className="card">
        <div className="row" style={{ gap: 10 }}>
          <h3>{tr('つなぎ', 'Connection')}</h3>
          {a.connected && <span className="pill ok">● {a.email || tr('つないでいます', 'Connected')}</span>}
        </div>
        <p className="lbl">
          {tr(
            'マイドライブに「DTX Web Editor」フォルダを作り、曲フォルダと同じ並び（譜面・原曲・ステム・作業ファイル）で保存します。Drive の画面からフォルダごと落とせば、そのまま NX で使えます。このアプリが作ったファイルしか見えない許可（drive.file）なので、ほかのファイルは読みません。',
            'Creates a "DTX Web Editor" folder in My Drive and saves each song like its song folder (charts, original audio, stems, work files). Download the folder from Drive and it works in NX as is. The permission (drive.file) only covers files this app created, so nothing else is read.',
          )}
        </p>
        <div className="row" style={{ gap: 8 }}>
          {a.connected ? (
            <>
              <button className="btn small primary" onClick={() => openFromDrive()}>
                {tr('Drive から開く', 'Open from Drive')}
              </button>
              <button className="btn small" onClick={() => void disconnect()}>
                {tr('切る', 'Disconnect')}
              </button>
            </>
          ) : (
            <button className="btn small primary" disabled={a.signingIn} onClick={() => connectDrive()}>
              {Icon.cloud(14)}
              {tr('Google Drive につなぐ', 'Connect Google Drive')}
            </button>
          )}
        </div>
      </section>
      <section className="card">
        <h3>{tr('送るもの', 'What to send')}</h3>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={a.onSave} onChange={(e) => setPrefs({ onSave: e.target.checked })} />
          <span>{tr('保存した曲を Drive にも送る（変わったファイルだけ）', 'Also send saved songs to Drive (only the files that changed)')}</span>
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={a.autosave} onChange={(e) => setPrefs({ autosave: e.target.checked })} />
          <span>{tr('まだ保存していない続き（自動保存）も、1分ごとに送る', 'Also send unsaved work (autosave) every minute')}</span>
        </label>
        <p className="lbl">
          {tr(
            '自動保存は Drive の曲フォルダの .dtxe-autosave に入れ、譜面そのものは書き換えません。ほかの端末で「Drive から開く」と、その続きから開きます。初めて Drive に送るのは、曲を保存したときです。',
            'Autosaves go to .dtxe-autosave in the song folder on Drive and never change the chart itself. "Open from Drive" on another device continues from there. A song is first sent to Drive when you save it.',
          )}
        </p>
        <p className="lbl">
          {tr(
            '送るのは曲のフォルダの中身だけです。ほかの曲も入ったフォルダ（NX の DTXFiles など）は送りません。',
            "Only the contents of a song's folder are sent. A folder that holds other songs too (such as DTXFiles in NX) is never sent.",
          )}
        </p>
      </section>
      {a.connected && (
        <section className="card">
          <h3>{tr('Drive の曲を点検する', 'Check the songs on Drive')}</h3>
          <p className="lbl">
            {tr(
              'Drive の曲のフォルダに、ほかの曲のフォルダが入っていないかを調べ、入っていればゴミ箱に移します（間違って曲を集めたフォルダを保存先にして、ほかの曲まで送ってしまったとき）。Drive のゴミ箱から 30 日間は戻せます。',
              "Checks whether any song folder on Drive has other songs' folders in it and moves them to the trash (for when a folder holding many songs was used by mistake and other songs got sent too). They can be restored from the Drive trash for 30 days.",
            )}
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" onClick={() => checkDriveSongs()}>
              {tr('点検して片付ける…', 'Check and clean up…')}
            </button>
          </div>
        </section>
      )}
      <section className="card">
        <h3>{tr('ログインのしかた', 'How to sign in')}</h3>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={a.redirect} disabled={!canRedirect()} onChange={(e) => setPrefs({ redirect: e.target.checked })} />
          <span>{tr('ページを切り替えてログインする', 'Sign in on a full page')}</span>
        </label>
        <p className="lbl">
          {tr(
            'ホーム画面のアプリなどで、Google のログインの小窓が開かない・戻ってこないときに使います。ログインのあいだ一度このページを離れ、戻ったら続けます。ログインは約1時間で切れ、次に保存するときなどに取り直します。',
            "Use this when the Google sign-in window doesn't open or doesn't come back, such as in the Home Screen app. You leave this page while signing in and continue when you return. Sign-in lasts about an hour and is renewed the next time you save, for example.",
          )}
        </p>
      </section>
    </div>
  );
}

/** 下の帯：開いている曲と Drive の様子（押すと送る・取り込む・つなぎ直す） */
export function DriveFooterChip() {
  const connected = useDriveAuth((s) => s.connected);
  const junk = useDriveSync((s) => s.junk.length);
  if (!connected) return null;
  return (
    <>
      <DriveStatusChip />
      {junk > 0 && (
        <button
          className="pill drive-pill warn"
          title={tr('Google Drive のこの曲のフォルダに、ほかの曲のフォルダが入っています。押すとゴミ箱に移して片付けられます', "This song's folder on Google Drive has other songs' folders in it. Press to move them to the trash")}
          onClick={() => cleanDriveJunk()}
        >
          {Icon.cloud(12)}
          {tr(`Drive にほかの曲 ${junk}`, `${junk} other ${pl(junk, 'song')} on Drive`)}
        </button>
      )}
    </>
  );
}

function DriveStatusChip() {
  const st = useDriveSync();
  if (st.status === 'none' || (!st.linked && st.status === 'ok')) return null;
  const p = st.progress;
  if (st.status === 'busy') {
    const n = p && p.phase !== 'check' && p.total ? ` ${p.done}/${p.total}` : '';
    return (
      <span className="pill drive-pill busy" role="status">
        {Icon.cloud(12)}
        {st.doing === 'down' ? tr(`Drive から取っています…${n}`, `Getting from Drive…${n}`) : tr(`Drive に送っています…${n}`, `Sending to Drive…${n}`)}
      </span>
    );
  }
  if (st.status === 'ok') {
    return (
      <span className="pill drive-pill ok" title={tr('この曲は Google Drive にも保存しています', 'This song is also saved on Google Drive')}>
        {Icon.cloud(12)}
        {st.at ? `Drive ${timeText(st.at)}` : 'Drive'}
      </span>
    );
  }
  const btn = (label: string, title: string, run: () => void, cls: string) => (
    <button className={`pill drive-pill ${cls}`} title={title} onClick={run}>
      {Icon.cloud(12)}
      {label}
    </button>
  );
  if (st.status === 'auth') return btn(tr('Drive につなぎ直す', 'Reconnect Drive'), tr('Google のログインが切れました。押すとログインして送ります', 'Google sign-in expired. Press to sign in and send'), pushNow, 'warn');
  if (st.status === 'newer') return btn(tr('Drive に新しい内容', 'Newer on Drive'), tr('ほかの端末で保存した新しいファイルがあります。押すと取り込みます', 'There are newer files saved on another device. Press to get them'), pullNow, 'info');
  if (st.status === 'conflict') return btn(tr('Drive と食い違い', 'Drive conflict'), tr('Drive とこの端末の両方で変わったファイルがあります。押すと選べます', 'Some files changed both on Drive and here. Press to choose'), pushNow, 'warn');
  return btn(tr('Drive に送れませんでした', "Couldn't send to Drive"), `${st.error}\n${tr('押すともう一度送ります', 'Press to try again')}`, pushNow, 'warn');
}

/** 送る・取るの進み具合（画面の下の左に小さく） */
export function DriveProgressChip() {
  const p = useDriveSync((s) => s.progress);
  if (!p) return null;
  if (p.phase === 'check' ? p.totalBytes < 8 << 20 : p.totalBytes < 1 << 20) return null;
  const pct = p.totalBytes ? Math.min(100, Math.round((p.bytes / p.totalBytes) * 100)) : 0;
  const label =
    p.phase === 'check'
      ? tr(`変わったファイルを調べています… ${p.done}/${p.total}`, `Checking for changes… ${p.done}/${p.total}`)
      : p.phase === 'up'
        ? tr(`Google Drive に送っています… ${p.done}/${p.total}`, `Sending to Google Drive… ${p.done}/${p.total}`)
        : tr(`Google Drive から取っています… ${p.done}/${p.total}`, `Getting from Google Drive… ${p.done}/${p.total}`);
  return (
    <div className="local-chip drive-chip" role="status" aria-live="polite" title={p.file}>
      {Icon.cloud(14)}
      <span className="ellipsis">{label}</span>
      <span className="mono">{p.phase === 'check' ? `${pct}%` : `${sizeText(p.bytes)} / ${sizeText(p.totalBytes)}`}</span>
      <span className="local-chip-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/** タブレットの「書き出し・共有」：この曲と Drive（つなぐ・今すぐ送る・取り込む） */
export function DriveSaveRow() {
  const connected = useDriveAuth((s) => s.connected);
  const signingIn = useDriveAuth((s) => s.signingIn);
  const st = useDriveSync();
  useEffect(() => {
    void loadGis();
  }, []);
  let text: string;
  let action: { label: string; run: () => void } | null;
  if (!connected) {
    text = tr('つなぐと、保存した曲を音ごと Google Drive にも送り、ほかの iPad・PC で続きを開けます', 'Connect to also send saved songs with their audio to Google Drive and continue on another iPad or PC');
    action = { label: tr('つなぐ', 'Connect'), run: () => connectDrive() };
  } else if (st.status === 'busy') {
    text = st.doing === 'down' ? tr('Drive から取っています…', 'Getting from Drive…') : tr('Drive に送っています…', 'Sending to Drive…');
    action = null;
  } else if (st.status === 'auth') {
    text = tr('ログインが切れました。つなぎ直すと送ります', 'Sign-in expired. Reconnect to send');
    action = { label: tr('つなぎ直す', 'Reconnect'), run: () => pushNow() };
  } else if (st.status === 'newer') {
    text = tr('ほかの端末で保存した新しいファイルがあります', 'There are newer files saved on another device');
    action = { label: tr('取り込む', 'Get them'), run: () => pullNow() };
  } else if (st.status === 'error') {
    text = tr(`送れませんでした: ${st.error}`, `Couldn't send: ${st.error}`);
    action = { label: tr('もう一度', 'Try again'), run: () => pushNow() };
  } else if (st.junk.length) {
    text = tr(`Drive のこの曲のフォルダに、ほかの曲のフォルダが ${st.junk.length} 個入っています`, `This song's folder on Drive has ${st.junk.length} other song ${pl(st.junk.length, 'folder')} in it`);
    action = { label: tr('片付ける', 'Clean up'), run: () => cleanDriveJunk() };
  } else if (st.linked) {
    text = st.at ? tr(`Drive にも保存 · ${timeText(st.at)}`, `Also saved on Drive at ${timeText(st.at)}`) : tr('Drive とつないでいます', 'Linked to Drive');
    action = { label: tr('今すぐ送る', 'Send now'), run: () => pushNow() };
  } else if (st.skip) {
    text = tr('この曲は Drive に送らないことにしています（保存しても送りません）', "This song is set not to go to Drive (saving doesn't send it)");
    action = { label: tr('Drive にも保存', 'Save to Drive'), run: () => pushNow() };
  } else {
    text = tr('保存すると Drive にも送ります', 'Saving also sends it to Drive');
    action = { label: tr('Drive にも保存', 'Save to Drive'), run: () => pushNow() };
  }
  return (
    <div className="t-save-drive">
      {Icon.cloud(18)}
      <span className="grow">
        <b>Google Drive</b>
        <span className="lbl">{text}</span>
      </span>
      {action && (
        <button className="t-btn" disabled={signingIn} onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
