import { useEffect } from 'react';
import { useLang } from './i18n/useLang';
import { startAutosave } from './app/fileActions';
import { useEditor } from './store/editor';
import './store/stems';
import './store/kit';
import { loadLibrary } from './store/library';
import { DialogHost } from './ui/dialogs';
import { Editor } from './ui/Editor';
import { Home } from './ui/Home';

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const screen = useEditor((s) => s.screen);
  // 言語が変わったら全体を描き直す（memo を使っていないので、ここで描き直せば下の画面もすべて描き直る）
  useLang();
  useEffect(() => startAutosave(), []);
  useEffect(() => void loadLibrary(), []);
  return (
    <>
      {screen === 'home' ? <Home /> : <Editor />}
      <DialogHost />
      <Toasts />
    </>
  );
}
