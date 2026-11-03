import { useEffect, useRef, useState } from 'react';
import { listRecent, newEmptySong, openDroppedFiles, openFolderPicker, openRecent } from '../app/fileActions';
import { supportsDirectWrite } from '../fs/folder';
import { deleteRecent, type RecentEntry } from '../fs/recent';
import { useEditor } from '../store/editor';
import { FolderInput } from './Editor';
import { formatLevel } from './format';
import { Icon } from './icons';

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  if (s < 86400 * 2) return '昨日';
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}日前`;
  return new Date(t).toLocaleDateString('ja-JP');
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
        <span className="lbl">DTXManiaNX 向けのドラム譜面エディタ</span>
        <span className="grow" />
        {hasDoc && (
          <button className="btn small" onClick={() => useEditor.setState({ screen: 'editor' })}>
            編集中の譜面に戻る
          </button>
        )}
      </header>
      <main className="home-main">
        <div>
          <h1>新しい譜面をつくる・続きを編集する</h1>
          <p className="lbl" style={{ fontSize: 12.5 }}>
            データはこのブラウザの中だけで扱います。どこにもアップロードしません。
          </p>
        </div>
        {!direct && (
          <div className="notice">
            <span style={{ flex: 'none' }}>{Icon.warn(14)}</span>
            <span>このブラウザは曲フォルダへの直接保存に対応していないため、保存はダウンロードになります。Chrome か Edge なら曲フォルダに直接上書き保存できます。</span>
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
              おすすめ
            </span>
            <h3>原曲の音声ファイルから</h3>
            <p>原曲（WAV・OGG・MP3）をここにドロップすると、その曲をBGMにした新しい譜面を作ります。DTXファイルを落とすとそのまま開きます。</p>
            <div className="actions">
              <button className="btn primary" onClick={() => audioInput.current?.click()}>
                ファイルを選ぶ
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
            <h3>曲フォルダを開く</h3>
            <p>既存のDTXと音をまとめて読み込みます。{direct ? '保存するとそのフォルダに上書きされます。' : '保存はダウンロードになります。'}DTXが無いフォルダなら新しい譜面を作ります。</p>
            <div className="actions">
              <button className="btn" onClick={() => void openFolderPicker(folderInput.current)}>
                {Icon.folder()} フォルダを選ぶ
              </button>
            </div>
          </div>
          <div className="home-card">
            <h3>空の譜面から</h3>
            <p>原曲なしで、内蔵キットの音だけで譜面を作ります。原曲はあとから曲フォルダに入れてWAVリストに追加できます。</p>
            <div className="actions">
              <button className="btn" onClick={() => void newEmptySong()}>
                {Icon.file()} 空の譜面を作る
              </button>
            </div>
          </div>
        </div>

        <section>
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>最近の曲</h3>
            <span className="lbl">ブラウザ内に自動保存されています</span>
          </div>
          {recent.length === 0 ? (
            <p className="lbl">まだありません。譜面を開くか作ると、ここに並びます。</p>
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
                        {r.title || '無題'}
                      </span>
                      <span className="lbl ellipsis" style={{ display: 'block' }}>
                        {[r.artist || 'アーティスト未設定', r.bpm && `${r.bpm} BPM`, `Lv ${formatLevel(r.level)}`].filter(Boolean).join(' · ')}
                      </span>
                      <span className="lbl ellipsis" style={{ display: 'block' }}>
                        {r.folderName ? `${r.folderName}/` : ''}
                        {r.fileName} · {ago(r.updatedAt)}
                      </span>
                    </span>
                    {!r.saved && <span className="pill warn">未保存</span>}
                  </button>
                  <button
                    className="ib"
                    style={{ position: 'absolute', right: 4, top: 4, width: 24, height: 24 }}
                    title="一覧から消す（曲フォルダのファイルは消えません）"
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
          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>操作のきほん</h3>
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
        </section>
      </main>
      <FolderInput inputRef={folderInput} />
    </div>
  );
}
