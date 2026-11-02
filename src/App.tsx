import { useEffect } from 'react';
import { startAutosave } from './app/fileActions';
import { useEditor } from './store/editor';
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
  useEffect(() => startAutosave(), []);
  return (
    <>
      {screen === 'home' ? <Home /> : <Editor />}
      <DialogHost />
      <Toasts />
    </>
  );
}
