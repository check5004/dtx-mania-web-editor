// スマホ版のホーム（承認されたデザインのホームのとおり）。
// ホーム画面のアプリ：題・最近の曲・新しく始める・Drive・使い方。Safari のタブ：Safari の案内・ホーム画面に追加・題・新しく始める・最近の曲。
// 曲フォルダは選べないので、曲は ZIP か「DTX と音のファイルをまとめて選ぶ」で開く（タブレットと同じ）
import { useEffect, useRef, useState } from 'react';
import { tr } from '../../i18n';
import { listRecentSongs, newEmptySong, openPickedFiles, openRecent, removeRecentSong } from '../../app/fileActions';
import type { RecentSong } from '../../fs/recent';
import { iosName, IS_IOS } from '../../store/device';
import { useEditor } from '../../store/editor';
import { localBadge, localPlace, useLocalSongs } from '../../store/localSongs';
import { usePwa } from '../../store/pwa';
import { DriveHomeCard, PrivacyLine } from '../DriveUi';
import { AiHomeCard } from '../aiGuide/AiHomeCard';
import { formatLevel } from '../format';
import { Icon } from '../icons';
import { LangSwitch } from '../LangSwitch';
import { LocalStorageCard } from '../LocalStorage';
import { InstallCard } from '../pwa/InstallCard';
import { ago, artColor } from '../tablet/HomeTablet';
import { openFilesPicker } from '../tablet/shared';
import { LogoMark } from '../LogoMark';
import { HomeLinks } from '../HomeLinks';

const TIPS_KEY = 'dtxe.phoneTips.closed';
/** 最近の曲を、すべてを開くまでに出す数 */
const RECENT_FIRST = 3;

function tipsClosed(): boolean {
  try {
    return localStorage.getItem(TIPS_KEY) === '1';
  } catch {
    return false;
  }
}

function StartRow({ icon, tone, title, sub, tag, onClick }: { icon: React.ReactNode; tone: string; title: string; sub: string; tag?: string; onClick: () => void }) {
  return (
    <button className="ph-row" onClick={onClick}>
      <span className={`ph-row-i ${tone}`}>{icon}</span>
      <span className="ph-row-text">
        <span className="ph-row-title">
          <b>{title}</b>
          {tag && <span className="pill th-pill">{tag}</span>}
        </span>
        <span className="lbl">{sub}</span>
      </span>
      <span className="ph-chev">{Icon.chevronRight(18)}</span>
    </button>
  );
}

export function HomePhone() {
  const audioInput = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<RecentSong[]>([]);
  const [all, setAll] = useState(false);
  const [tips, setTips] = useState(() => !tipsClosed());
  const hasDoc = useEditor((s) => s.doc.header.length > 0 || s.doc.chips.length > 0);
  const openTitle = useEditor((s) => s.doc.fields['TITLE'] ?? '');
  const standalone = usePwa((s) => s.standalone);
  const local = useLocalSongs((s) => s.ready);
  // 本体の曲が増えた・消えたら一覧を読み直す
  const localVer = useLocalSongs((s) => s.ver);

  useEffect(() => {
    void listRecentSongs().then(setRecent);
  }, [localVer]);

  const closeTips = () => {
    setTips(false);
    try {
      localStorage.setItem(TIPS_KEY, '1');
    } catch {
      // 覚えられなくても閉じる
    }
  };

  const shown = all ? recent : recent.slice(0, RECENT_FIRST);

  const title = (
    <div className="ph-title">
      <h1>{tr('新しい譜面をつくる・続きを編集する', 'Start a new chart or continue editing')}</h1>
      <p className="lbl">
        <PrivacyLine />
      </p>
    </div>
  );

  const recents = (
    <section className="ph-sec">
      <div className="ph-h2">
        <h2>{tr('最近の曲', 'Recent songs')}</h2>
        <span className="lbl ellipsis">{local ? tr(`${localPlace()}に自動保存`, `Autosaved on ${localPlace()}`) : tr('ブラウザ内に自動保存', 'Autosaved in this browser')}</span>
      </div>
      {recent.length === 0 ? (
        <p className="lbl">{tr('まだありません。譜面を開くか作ると、ここに並びます。', 'Nothing yet. Charts you open or create will appear here.')}</p>
      ) : (
        <div className="ph-group">
          {shown.map((song) => {
            // 曲ごとに1つ（いちばん新しい難易度を出す。未保存はどれかの難易度に保存していない変更があるとき）
            const r = song.latest;
            const unsaved = song.entries.filter((x) => !x.saved).map((x) => x.fileName);
            return (
              <div key={song.key} className="ph-recent">
                <button className="ph-recent-open" onClick={() => void openRecent(r)}>
                  <span className="th-recent-art ph-art" style={{ background: artColor(r.title || r.fileName) }}>
                    {Icon.drum(14)}
                  </span>
                  <span className="ph-recent-text">
                    <span className="ph-recent-row">
                      <b className="ellipsis">{r.title || tr('無題', 'Untitled')}</b>
                      <span className="lbl">{ago(r.updatedAt)}</span>
                    </span>
                    <span className="ph-pills">
                      <span className="pill mono">
                        {r.fileName.replace(/\.dtx$/i, '').toUpperCase()} {formatLevel(r.level)}
                      </span>
                      {r.local && <span className="pill local">{localBadge()}</span>}
                      {r.drive && <span className="pill drive">Drive</span>}
                      {unsaved.length > 0 && <span className="pill warn">{tr('未保存', 'Unsaved')}</span>}
                    </span>
                    <span className="lbl ellipsis">{[r.artist || tr('アーティスト未設定', 'No artist'), r.bpm && `${r.bpm} BPM`].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
                <button
                  className="t-ib ph-recent-del"
                  title={
                    r.local
                      ? tr(`一覧から消す（${localPlace()}に保存した音も消します）`, `Remove from the list (the audio kept in ${localPlace()} is removed too)`)
                      : tr('一覧から消す（曲フォルダのファイルは消えません）', 'Remove from the list (files in the song folder are kept)')
                  }
                  aria-label={tr('一覧から消す', 'Remove from the list')}
                  onClick={async () => {
                    if (await removeRecentSong(song)) setRecent(await listRecentSongs());
                  }}
                >
                  {Icon.close(16)}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {recent.length > RECENT_FIRST && (
        <button className="ph-more" onClick={() => setAll(!all)}>
          {all ? tr('少なく出す', 'Show fewer') : tr(`すべての曲（${recent.length}）`, `All songs (${recent.length})`)}
          {Icon.chevronRight(16)}
        </button>
      )}
    </section>
  );

  const starts = (
    <section className="ph-sec">
      <div className="ph-h2">
        <h2>{tr('新しく始める・開く', 'Start or open')}</h2>
      </div>
      <div className="ph-group">
        <StartRow
          icon={Icon.wave(20)}
          tone="blue"
          title={tr('原曲の音声ファイルから', 'From an audio file')}
          sub={tr('WAV・OGG・MP3・動画（MP4）か、Moises のステムをまとめて選ぶと、おまかせで準備。DTX ならそのまま開きます', 'Pick a WAV, OGG, MP3, a video (MP4) or Moises stems together to set it up for you. A DTX opens as is')}
          tag={tr('おすすめ', 'Recommended')}
          onClick={() => audioInput.current?.click()}
        />
        <StartRow
          icon={Icon.zip(20)}
          tone="violet"
          title={tr('曲を開く', 'Open a song')}
          sub={tr('曲フォルダの ZIP、または DTX と音のファイルをまとめて選ぶ', 'A ZIP of the song folder, or the DTX and sound files together')}
          onClick={() => openFilesPicker('any')}
        />
        <StartRow icon={Icon.plus(20)} tone="gray" title={tr('空の譜面から', 'Start from an empty chart')} sub={tr('原曲なしで、内蔵キットの音だけ', 'No original audio, only the built-in kit')} onClick={() => void newEmptySong()} />
      </div>
      <input
        ref={audioInput}
        type="file"
        accept={IS_IOS ? undefined : '.ogg,.wav,.mp3,.m4a,.flac,.opus,.mp4,.m4v,.mov,.webm,.mkv,.dtx'}
        multiple
        hidden
        onChange={(e) => {
          void openPickedFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </section>
  );

  const tipsCard = tips && (
    <section className="ph-tips">
      <div className="ph-tips-head">
        <b>{IS_IOS ? iosName(tr('iPad で使うとき', 'Using it on iPad')) : tr('スマホで使うとき', 'Using it on a phone')}</b>
        <button className="t-ib" onClick={closeTips} aria-label={tr('閉じる', 'Close')}>
          {Icon.close(18)}
        </button>
      </div>
      <div className="ph-tip">
        <span className="ph-tip-i">{Icon.grid(18)}</span>
        <span>
          <b>{tr('入れるのはパッド、直すのは譜面', 'Enter with pads, fix on the chart')}</b>
          <span className="lbl">
            {tr('下の「パッド」でステップ入力。譜面は触れている間に吹き出しで位置を見て、離して置きます。', 'Step-enter with Pads. On the chart, a bubble shows where the chip goes; it is placed when you lift.')}
          </span>
        </span>
      </div>
      <div className="ph-tip">
        <span className="ph-tip-i">{Icon.screen(18)}</span>
        <span>
          <b>{tr('横にすると原曲の列と聴き比べ', 'Turn sideways for more')}</b>
          <span className="lbl">
            {tr('原曲の打点と波形の列・AI 難易度の聴き比べ・テンポ合わせは横向きで。', 'Hits and waveform columns, AI comparison and tempo matching use landscape.')}
          </span>
        </span>
      </div>
      <div className="ph-tip">
        <span className="ph-tip-i">{Icon.layers(18)}</span>
        <span>
          <b>{tr('ステムの分解・電子ドラムは PC・iPad で', 'Stems and e-drums on PC or iPad')}</b>
          <span className="lbl">{tr('分けたステムは曲の ZIP ごと持ってきて使えます。', 'Bring separated stems over inside the song ZIP.')}</span>
        </span>
      </div>
    </section>
  );

  return (
    <div className="home th-home ph-home">
      <header className="th-top ph-top">
        <span className="logo">
          <LogoMark />
          DTX Web Editor
        </span>
        <span className="grow" />
        <LangSwitch />
      </header>
      <main className="ph-main">
        {hasDoc && (
          <button className="ph-back" onClick={() => useEditor.setState({ screen: 'editor' })}>
            {Icon.back(16)}
            <span className="ellipsis">
              {tr('編集中の譜面に戻る', 'Back to the open chart')}
              {openTitle && <span className="lbl"> · {openTitle}</span>}
            </span>
          </button>
        )}
        {standalone ? (
          <>
            {title}
            {recents}
            {starts}
            <DriveHomeCard tablet />
            <LocalStorageCard tablet />
            <AiHomeCard tablet />
            {tipsCard}
          </>
        ) : (
          <>
            {/* 「Safari ではまだ確かめていません」の案内は出さない（iPhone の Safari で音が鳴るのは 2026-11-10 に実機で確かめた。PC・iPad のホームは出す） */}
            <InstallCard />
            {title}
            {starts}
            {recents}
            <DriveHomeCard tablet />
            <LocalStorageCard tablet />
            <AiHomeCard tablet />
            {tipsCard}
          </>
        )}
        <HomeLinks />
      </main>
    </div>
  );
}
