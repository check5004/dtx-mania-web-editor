import { useEffect } from 'react';
import { tr } from './i18n';
import { useLang } from './i18n/useLang';
import { startAutosave } from './app/fileActions';
import { dismissToast, useEditor } from './store/editor';
import { useDevice } from './store/device';
import './store/stems';
import './store/kit';
import './store/fx';
import { loadLibrary } from './store/library';
import { initLocalSongs } from './store/localSongs';
import { LocalCopyChip } from './ui/LocalStorage';
import { initDrive } from './app/driveActions';
import { DriveProgressChip } from './ui/DriveUi';
import { DialogHost } from './ui/dialogs';
import { Editor } from './ui/Editor';
import { Home } from './ui/Home';
import { initNxLib } from './nxlib/store';
import { SongsPage } from './ui/nxlib/SongsPage';
import { UpdateNotice } from './ui/pwa/UpdateNotice';
import { VideoExtractHost } from './ui/VideoExtract';

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      <UpdateNotice />
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level} ${t.action || t.action2 ? 'has-action' : ''} ${t.action && t.action2 ? 'two-actions' : ''}`}>
          {/* 2 行目からは小さく（「保存しました」と、そのあとにすること） */}
          <span>
            {t.text.split('\n')[0]}
            {t.text.includes('\n') && <span className="toast-sub">{t.text.slice(t.text.indexOf('\n') + 1)}</span>}
          </span>
          {[t.action, t.action2].map(
            (a, i) =>
              a && (
                <button
                  key={i}
                  className="toast-action"
                  onClick={() => {
                    dismissToast(t.id);
                    a.run();
                  }}
                >
                  {a.label}
                </button>
              ),
          )}
          {/* ボタンのある知らせは長めに出すので、× で閉じられるように */}
          {(t.action || t.action2) && (
            <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const screen = useEditor((s) => s.screen);
  const phone = useDevice((s) => s.phone);
  // 言語が変わったら全体を描き直す（memo を使っていないので、ここで描き直せば下の画面もすべて描き直る）
  useLang();
  useEffect(() => startAutosave(), []);
  useEffect(() => void loadLibrary(), []);
  useEffect(() => void initLocalSongs(), []);
  useEffect(() => initDrive(), []);
  useEffect(() => void initNxLib(), []);
  return (
    <>
      {screen === 'home' ? <Home /> : screen === 'songs' ? <SongsPage /> : <Editor />}
      {/* スマホの縦：画面の上端に上のバーと同じ色の帯（iOS の Safari が上端にかけるぼかしを消す。phone.css の .p-edge-top） */}
      {phone && <div className="p-edge-top" aria-hidden="true" />}
      <DialogHost />
      <VideoExtractHost />
      <Toasts />
      <LocalCopyChip />
      <DriveProgressChip />
    </>
  );
}
