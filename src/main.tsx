import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initPwa } from './store/pwa';
import './styles.css';
import './tablet.css';
import './phone.css';
import './nxlib.css';

// ホーム画面に追加できるアプリにする（オフラインで開ける・新しい版の知らせ・インストール）
initPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
