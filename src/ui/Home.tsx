import { tr, pl, locale, isJa } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { listRecent, newEmptySong, openDroppedFiles, openFolderPicker, openRecent } from '../app/fileActions';
import { supportsDirectWrite } from '../fs/folder';
import { deleteRecent, type RecentEntry } from '../fs/recent';
import { useEditor } from '../store/editor';
import { FolderInput } from './Editor';
import { formatLevel } from './format';
import { Icon } from './icons';
import { LangSwitch } from './LangSwitch';

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

export function Home() {
  const folderInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [over, setOver] = useState(false);
  const hasDoc = useEditor((s) => s.doc.header.length > 0 || s.doc.chips.length > 0);
  const direct = supportsDirectWrite();

  useEffect(() => {
    void listRecent().then(setRecent);
  }, []);

  return (
    <div className="home">
      <header className="topbar">
        <span className="logo">
          <span className="logo-mark">D</span>
          DTX Web Editor
        </span>
        <span className="lbl hide-narrow">{tr('DTXManiaNX 向けのドラム譜面エディタ', 'Drum chart editor for DTXManiaNX')}</span>
        <span className="grow" />
        <LangSwitch small />
        {hasDoc && (
          <button className="btn small" onClick={() => useEditor.setState({ screen: 'editor' })}>
            {tr('編集中の譜面に戻る', 'Back to the open chart')}
          </button>
        )}
      </header>
      <main className="home-main">
        <div>
          <h1>{tr('新しい譜面をつくる・続きを編集する', 'Start a new chart or continue editing')}</h1>
          <p className="lbl" style={{ fontSize: 12.5 }}>
            {tr('データはこのブラウザの中だけで扱います。どこにもアップロードしません。', 'Your data stays in this browser. Nothing is uploaded anywhere.')}
          </p>
        </div>
        {!direct && (
          <div className="notice">
            <span style={{ flex: 'none' }}>{Icon.warn(14)}</span>
            <span>
              {tr(
                'このブラウザは曲フォルダへの直接保存に対応していないため、保存はダウンロードになります。Chrome か Edge なら曲フォルダに直接上書き保存できます。',
                "This browser can't save directly into the song folder, so saving downloads the files instead. In Chrome or Edge, saving overwrites the files in the song folder.",
              )}
            </span>
          </div>
        )}
        <div className="home-cards">
          <div
            className={`home-card drop ${over ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void openDroppedFiles([...e.dataTransfer.files]);
            }}
          >
            <span className="pill" style={{ alignSelf: 'flex-start', background: '#10202b', color: 'var(--accent)' }}>
              {tr('おすすめ', 'Recommended')}
            </span>
            <h3>{tr('原曲の音声ファイルから', 'From the song audio file')}</h3>
            <p>
              {tr(
                '原曲（WAV・OGG・MP3）をここにドロップすると、その曲をBGMにした新しい譜面を作ります。DTXファイルを落とすとそのまま開きます。',
                'Drop the original song (WAV, OGG or MP3) here to start a new chart with it as the BGM. Drop a DTX file to open it as is.',
              )}
            </p>
            <div className="actions">
              <button className="btn primary" onClick={() => audioInput.current?.click()}>
                {tr('ファイルを選ぶ', 'Choose file')}
              </button>
            </div>
            <input
              ref={audioInput}
              type="file"
              accept=".ogg,.wav,.mp3,.m4a,.flac,.opus,.dtx"
              hidden
              onChange={(e) => {
                void openDroppedFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </div>
          <div className="home-card">
            <h3>{tr('曲フォルダを開く', 'Open a song folder')}</h3>
            <p>
              {tr('既存のDTXと音をまとめて読み込みます。', 'Loads an existing DTX together with its sounds. ')}
              {direct ? tr('保存するとそのフォルダに上書きされます。', 'Saving overwrites the files in that folder. ') : tr('保存はダウンロードになります。', 'Saving downloads the files. ')}
              {tr('DTXが無いフォルダなら新しい譜面を作ります。', 'If the folder has no DTX, a new chart is created.')}
            </p>
            <div className="actions">
              <button className="btn" onClick={() => void openFolderPicker(folderInput.current)}>
                {Icon.folder()} {tr('フォルダを選ぶ', 'Choose folder')}
              </button>
            </div>
          </div>
          <div className="home-card">
            <h3>{tr('空の譜面から', 'From an empty chart')}</h3>
            <p>
              {tr(
                '原曲なしで、内蔵キットの音だけで譜面を作ります。原曲はあとから曲フォルダに入れてWAVリストに追加できます。',
                'Make a chart with only the built-in kit sounds, without the original song. You can add the song to the song folder and the WAV list later.',
              )}
            </p>
            <div className="actions">
              <button className="btn" onClick={() => void newEmptySong()}>
                {Icon.file()} {tr('空の譜面を作る', 'Create empty chart')}
              </button>
            </div>
          </div>
        </div>

        <section>
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{tr('最近の曲', 'Recent songs')}</h3>
            <span className="lbl">{tr('ブラウザ内に自動保存されています', 'Autosaved in this browser')}</span>
          </div>
          {recent.length === 0 ? (
            <p className="lbl">{tr('まだありません。譜面を開くか作ると、ここに並びます。', 'Nothing yet. Charts you open or create will appear here.')}</p>
          ) : (
            <div className="recent-list">
              {recent.map((r) => (
                <div key={r.id} style={{ position: 'relative' }}>
                  <button className="recent-item" style={{ width: '100%' }} onClick={() => void openRecent(r)}>
                    <span className="song-art" style={{ width: 40, height: 40 }}>
                      {Icon.file(16)}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                        {r.title || tr('無題', 'Untitled')}
                      </span>
                      <span className="lbl ellipsis" style={{ display: 'block' }}>
                        {[r.artist || tr('アーティスト未設定', 'No artist'), r.bpm && `${r.bpm} BPM`, `Lv ${formatLevel(r.level)}`].filter(Boolean).join(' · ')}
                      </span>
                      <span className="lbl ellipsis" style={{ display: 'block' }}>
                        {r.folderName ? `${r.folderName}/` : ''}
                        {r.fileName} · {ago(r.updatedAt)}
                      </span>
                    </span>
                    {!r.saved && <span className="pill warn">{tr('未保存', 'Unsaved')}</span>}
                  </button>
                  <button
                    className="ib"
                    style={{ position: 'absolute', right: 4, top: 4, width: 24, height: 24 }}
                    title={tr('一覧から消す（曲フォルダのファイルは消えません）', 'Remove from the list (files in the song folder are kept)')}
                    onClick={async () => {
                      await deleteRecent(r.id);
                      setRecent(await listRecent());
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{tr('操作のきほん', 'Basics')}</h3>
          {isJa() ? (
            <div className="flow">
              <div>
                <b>置く・消す</b>レーンをクリックで置く、ダブルクリックで消す。<kbd>Shift</kbd>でHHオープン・左バスドラム。
              </div>
              <div>
                <b>右クリック</b>チップの上ならベロシティ・HHオープン/クローズ・レーン・削除のメニュー。何もない所ならグリッドをボタン1回で切り替え。
              </div>
              <div>
                <b>選ぶ・動かす</b>空いた所をドラッグで範囲選択、チップをドラッグか矢印キーで移動。<kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd>でコピー。
              </div>
              <div>
                <b>聴く</b>
                <kbd>Space</kbd>で再生と停止。止めると青い ▶（再生を始める位置）に戻ります。<kbd>Shift</kbd>+<kbd>Space</kbd>はその場で止めます。<kbd>F5</kbd> 最初から、<kbd>F6</kbd> ▶ から、<kbd>F7</kbd> 停止。
              </div>
              <div>
                <b>保存</b>
                <kbd>Ctrl</kbd>+<kbd>S</kbd>で曲フォルダにShift_JISで保存。NXでそのまま読めます。
              </div>
            </div>
          ) : (
            <div className="flow">
              <div>
                <b>Place / delete</b>Click a lane to place a chip, double-click to delete it. Hold <kbd>Shift</kbd> for HH open and the left bass drum.
              </div>
              <div>
                <b>Right-click</b>On a chip: velocity, HH open/closed, lane and delete. On an empty spot: switch the grid in one click.
              </div>
              <div>
                <b>Select / move</b>Drag on an empty spot to box-select. Move chips by dragging or with the arrow keys. <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> to copy.
              </div>
              <div>
                <b>Listen</b>
                <kbd>Space</kbd> plays and stops. Stopping returns to the blue ▶ (where playback starts). <kbd>Shift</kbd>+<kbd>Space</kbd> stops right there. <kbd>F5</kbd> from the top, <kbd>F6</kbd> from ▶, <kbd>F7</kbd> stop.
              </div>
              <div>
                <b>Save</b>
                <kbd>Ctrl</kbd>+<kbd>S</kbd> saves to the song folder in Shift_JIS, ready for NX.
              </div>
            </div>
          )}
        </section>
      </main>
      <FolderInput inputRef={folderInput} />
    </div>
  );
}
