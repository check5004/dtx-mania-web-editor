// タブレット版のホーム（承認されたデザインのホーム（縦）のとおり）。
// iPad の Safari は曲フォルダを選べないので、曲は ZIP か「DTX と音のファイルをまとめて選ぶ」で開く。最初に iPad での使い方を出す（閉じたら出さない）
import { useEffect, useRef, useState } from 'react';
import { tr, pl, locale } from '../../i18n';
import { listRecent, newEmptySong, openFolderPicker, openPickedFiles, openRecent, removeRecentEntry } from '../../app/fileActions';
import type { RecentEntry } from '../../fs/recent';
import { IS_IOS, NO_FOLDER_PICK } from '../../store/device';
import { useEditor } from '../../store/editor';
import { localBadge, localPlace, useLocalSongs } from '../../store/localSongs';
import { LocalStorageCard } from '../LocalStorage';
import { DriveHomeCard, PrivacyLine } from '../DriveUi';
import { FolderInput } from '../Editor';
import { formatLevel } from '../format';
import { Icon } from '../icons';
import { LangSwitch } from '../LangSwitch';
import { SafariNotice } from '../SafariNotice';
import { openFilesPicker } from './shared';
import { InstallCard, useInstallHint } from '../pwa/InstallCard';
import { usePwa } from '../../store/pwa';

const TIPS_KEY = 'dtxe.ipadTips.closed';

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return tr('たった今', 'just now');
  if (s < 3600) {
    const n = Math.floor(s / 60);
    return tr(`${n}分前`, `${n} ${pl(n, 'minute')} ago`);
  }
  if (s < 86400) {
    const n = Math.floor(s / 3600);
    return tr(`${n}時間前`, `${n} ${pl(n, 'hour')} ago`);
  }
  if (s < 86400 * 2) return tr('昨日', 'yesterday');
  if (s < 86400 * 7) {
    const n = Math.floor(s / 86400);
    return tr(`${n}日前`, `${n} days ago`);
  }
  return new Date(t).toLocaleDateString(locale());
}

function tipsClosed(): boolean {
  try {
    return localStorage.getItem(TIPS_KEY) === '1';
  } catch {
    return false;
  }
}

/** 曲名から決める、最近の曲のカードの色（同じ曲はいつも同じ色） */
function artColor(title: string): string {
  const cols = ['#23415A', '#5A2A2E', '#3A3456', '#2B4A36', '#4A3A22', '#22424A'];
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return cols[h % cols.length];
}

export function HomeTablet() {
  const folderInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [tips, setTips] = useState(() => IS_IOS && !tipsClosed());
  const hasDoc = useEditor((s) => s.doc.header.length > 0 || s.doc.chips.length > 0);
  const standalone = usePwa((s) => s.standalone);
  // 上に「ホーム画面に追加」の案内を出している間は、使い方の欄から同じ話を外す
  const installHint = useInstallHint();
  const local = useLocalSongs((s) => s.ready);
  // 本体の曲が増えた・消えたら一覧を読み直す
  const localVer = useLocalSongs((s) => s.ver);

  useEffect(() => {
    void listRecent().then(setRecent);
  }, [localVer]);

  const closeTips = () => {
    setTips(false);
    try {
      localStorage.setItem(TIPS_KEY, '1');
    } catch {
      // 覚えられなくても閉じる
    }
  };

  return (
    <div className="home th-home">
      <header className="th-top">
        <span className="logo">
          <span className="logo-mark">D</span>
          DTX Web Editor
        </span>
        <span className="grow" />
        <LangSwitch />
        {hasDoc && (
          <button className="t-btn" onClick={() => useEditor.setState({ screen: 'editor' })}>
            {tr('編集中の譜面に戻る', 'Back to the open chart')}
          </button>
        )}
      </header>
      <main className="th-main">
        <SafariNotice />
        <div>
          <h1>{tr('新しい譜面をつくる・続きを編集する', 'Start a new chart or continue editing')}</h1>
          <p className="lbl">
            <PrivacyLine />
          </p>
        </div>

        <InstallCard />

        {tips && (
          <section className="th-tips">
            <div className="th-tips-head">
              <span className="th-tips-i">{Icon.info(20)}</span>
              <b>{tr('iPad で使うとき', 'Using it on iPad')}</b>
              <span className="grow" />
              <button className="t-ib" onClick={closeTips} aria-label={tr('閉じる', 'Close')}>
                {Icon.close(20)}
              </button>
            </div>
            <div className={`th-tips-cols ${installHint ? 'two' : ''}`}>
              {!installHint && (
                <div>
                  <b>
                    {Icon.share(16)}
                    {standalone ? tr('ホーム画面のアプリ', 'Home Screen app') : tr('ホーム画面に追加', 'Add to Home Screen')}
                  </b>
                  <span className="lbl">
                    {standalone
                      ? tr('Safari のバーが無いぶん譜面が広く、ネットにつながっていなくても開けます。', 'Without the Safari bars the chart has more room, and it opens without an internet connection.')
                      : tr('共有 › ホーム画面に追加 で開くと、Safari のバーが消えて譜面が広くなり、オフラインでも開けます。', 'Share › Add to Home Screen hides the Safari bars, gives the chart more room and lets it open offline.')}
                  </span>
                </div>
              )}
              <div>
                <b>
                  {Icon.zip(16)}
                  {tr('曲はZIPでやりとり', 'Move songs as ZIP')}
                </b>
                <span className="lbl">
                  {local
                    ? tr(
                        'PC の曲フォルダをZIPにして AirDrop・iCloud Drive で送り、ここで開きます。開いた曲は音ごと iPad 本体に保存され、PC へはZIPで書き出します。',
                        'Zip the song folder on your PC, send it with AirDrop or iCloud Drive, and open it here. Opened songs are kept on the iPad with their audio; export a ZIP to send them back.',
                      )
                    : tr('PC の曲フォルダをZIPにして AirDrop・iCloud Drive で送り、ここで開きます。保存もZIPで書き出します。', 'Zip the song folder on your PC, send it with AirDrop or iCloud Drive, and open it here. Saving exports a ZIP too.')}
                </span>
              </div>
              <div>
                <b>
                  {Icon.grid(16)}
                  {tr('入力は画面のパッドで', 'Enter notes with pads')}
                </b>
                <span className="lbl">{tr('iPad のブラウザは電子ドラム（USB MIDI）をつなげません。パッドかキーボードで叩きます。', 'iPad browsers cannot connect e-drums (USB MIDI). Use the on-screen pads or a keyboard.')}</span>
              </div>
            </div>
          </section>
        )}

        <div className="th-start">
          <section className="th-card primary">
            <div className="th-card-head">
              <span className="th-card-icon blue">{Icon.wave(22)}</span>
              <b>{tr('原曲の音声ファイルから', 'From an audio file')}</b>
              <span className="pill th-pill">{tr('おすすめ', 'Recommended')}</span>
            </div>
            <p className="lbl">
              {tr('WAV・OGG・MP3 を選ぶと、その曲を BGM にした新しい譜面を作ります。DTX を選ぶとそのまま開きます。', 'Pick a WAV, OGG or MP3 to start a new chart with it as the BGM. Pick a DTX to open it as is.')}
            </p>
            <div className="th-actions">
              <button className="t-btn primary" onClick={() => audioInput.current?.click()}>
                {tr('ファイルを選ぶ', 'Choose file')}
              </button>
            </div>
            <input
              ref={audioInput}
              type="file"
              accept={IS_IOS ? undefined : '.ogg,.wav,.mp3,.m4a,.flac,.opus,.dtx'}
              hidden
              onChange={(e) => {
                void openPickedFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </section>
          <section className="th-card">
            <div className="th-card-head">
              <span className="th-card-icon violet">{Icon.zip(22)}</span>
              <b>{tr('曲を開く', 'Open a song')}</b>
            </div>
            <p className="lbl">
              {NO_FOLDER_PICK
                ? tr('曲フォルダのZIP、または DTX と音のファイルをまとめて選びます。', 'Choose a ZIP of the song folder, or select the DTX and sound files together.')
                : tr('曲フォルダか、曲フォルダのZIP、または DTX と音のファイルをまとめて選びます。', 'Choose a song folder, a ZIP of it, or select the DTX and sound files together.')}
            </p>
            <div className="th-actions">
              {!NO_FOLDER_PICK && (
                <button className="t-btn" onClick={() => void openFolderPicker(folderInput.current)}>
                  {Icon.folder(18)}
                  <span>{tr('フォルダを選ぶ', 'Choose folder')}</span>
                </button>
              )}
              <button className="t-btn" onClick={() => openFilesPicker('zip')}>
                {Icon.zip(18)}
                <span>{tr('ZIPを開く', 'Open ZIP')}</span>
              </button>
              <button className="t-btn" onClick={() => openFilesPicker('any')}>
                {Icon.file(18)}
                <span>{tr('ファイルを選ぶ', 'Choose files')}</span>
              </button>
            </div>
          </section>
        </div>

        <section className="th-card row">
          <span className="th-plus">{Icon.plus(20)}</span>
          <span className="th-card-text">
            <b>{tr('空の譜面から', 'Start from an empty chart')}</b>
            <span className="lbl">{tr('原曲なしで、内蔵キットの音だけで作ります', 'No original audio, only the built-in kit')}</span>
          </span>
          <button className="t-btn" onClick={() => void newEmptySong()}>
            {tr('空の譜面を作る', 'Create empty chart')}
          </button>
        </section>

        <section className="th-section">
          <div className="th-section-head">
            <h2>{tr('最近の曲', 'Recent songs')}</h2>
            <span className="lbl">{tr('ブラウザ内に自動保存されています', 'Autosaved in this browser')}</span>
          </div>
          {recent.length === 0 ? (
            <p className="lbl">{tr('まだありません。譜面を開くか作ると、ここに並びます。', 'Nothing yet. Charts you open or create will appear here.')}</p>
          ) : (
            <div className="th-recent">
              {recent.map((r) => (
                <div key={r.id} className="th-recent-item">
                  <button className="th-recent-open" onClick={() => void openRecent(r)}>
                    <span className="th-recent-art" style={{ background: artColor(r.title || r.fileName) }}>
                      {Icon.drum(18)}
                    </span>
                    <span className="th-recent-text">
                      <span className="th-recent-row">
                        <b className="ellipsis">{r.title || tr('無題', 'Untitled')}</b>
                        <span className="lbl th-recent-ago">{ago(r.updatedAt)}</span>
                      </span>
                      <span className="lbl ellipsis">{[r.artist || tr('アーティスト未設定', 'No artist'), r.bpm && `${r.bpm} BPM`].filter(Boolean).join(' · ')}</span>
                      <span className="th-recent-pills">
                        <span className="pill mono">
                          {r.fileName.replace(/\.dtx$/i, '').toUpperCase()} {formatLevel(r.level)}
                        </span>
                        {r.local && <span className="pill local">{localBadge()}</span>}
                        {r.drive && <span className="pill drive">Drive</span>}
                        {!r.saved && <span className="pill warn">{tr('未保存', 'Unsaved')}</span>}
                      </span>
                    </span>
                  </button>
                  <button
                    className="t-ib th-recent-del"
                    title={
                      r.local
                        ? tr(`一覧から消す（この曲の最後の1つなら、${localPlace()}に保存した音も消します）`, `Remove from the list (for the last one of this song, the audio kept in ${localPlace()} is removed too)`)
                        : tr('一覧から消す（曲フォルダのファイルは消えません）', 'Remove from the list (files in the song folder are kept)')
                    }
                    aria-label={tr('一覧から消す', 'Remove from the list')}
                    onClick={async () => {
                      if (await removeRecentEntry(r)) setRecent(await listRecent());
                    }}
                  >
                    {Icon.close(16)}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <LocalStorageCard tablet />
        <DriveHomeCard tablet />

        <section className="th-section">
          <div className="th-section-head">
            <h2>{tr('タッチの操作のきほん', 'Touch basics')}</h2>
          </div>
          <div className="th-basics">
            <div>
              <span className="th-basics-i">{Icon.pencil(20)}</span>
              <span>
                <b>{tr('置く・消す', 'Place and delete')}</b>
                <span className="lbl">{tr('レーンをタップで置く、ダブルタップで消す。強さは左の 強・中・弱。', 'Tap a lane to place, double-tap to delete. Set strength with Hard, Mid, Soft on the left.')}</span>
              </span>
            </div>
            <div>
              <span className="th-basics-i">{Icon.hand(20)}</span>
              <span>
                <b>{tr('長押し＝メニュー', 'Long-press for menus')}</b>
                <span className="lbl">{tr('チップ・空き・小節番号を長押しすると、ベロシティやグリッドのメニュー。', 'Long-press a chip, an empty spot, or a bar number for velocity, grid, and bar menus.')}</span>
              </span>
            </div>
            <div>
              <span className="th-basics-i">{Icon.selectBox(20)}</span>
              <span>
                <b>{tr('選ぶ・動かす', 'Select and move')}</b>
                <span className="lbl">{tr('左の「選ぶ」でなぞって範囲選択。長押しして持ち上げるとドラッグで動かせます。', 'Use Select on the left and drag to select. Long-press to lift chips, then drag to move.')}</span>
              </span>
            </div>
            <div>
              <span className="th-basics-i">{Icon.move(20)}</span>
              <span>
                <b>{tr('スクロール・拡大', 'Scroll and zoom')}</b>
                <span className="lbl">{tr('指でなぞってスクロール、2本指でも。ピンチで拡大・縮小。2本指タップで元に戻す。', 'Drag to scroll, or use two fingers. Pinch to zoom. Two-finger tap to undo.')}</span>
              </span>
            </div>
          </div>
        </section>
      </main>
      <FolderInput inputRef={folderInput} />
    </div>
  );
}
