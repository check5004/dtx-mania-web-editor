// PC どうしの同期の画面を出す所（設定・初めての確認・記録）。App に 1 つ置く（ダイアログより下に描く）。
import { useEffect } from 'react';
import { openSyncPanel, usePcSync } from '../../sync/store';
import { FirstPanel } from './first';
import { LogDrawer } from './log';
import { SetupPanel } from './setup';

export function PcSyncHost() {
  const panel = usePcSync((s) => s.panel);
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      // 確認のダイアログが上に出ているときは、そちらが閉じる
      if (e.key !== 'Escape' || document.querySelector('.modal-back:not(.ps-back)')) return;
      e.stopPropagation();
      openSyncPanel(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panel]);
  if (panel === 'log')
    return (
      <>
        <div className="ps-drawer-back" onClick={() => openSyncPanel(null)} />
        <LogDrawer />
      </>
    );
  if (panel === 'setup' || panel === 'first')
    return (
      <div className="modal-back ps-back" onMouseDown={(e) => e.target === e.currentTarget && panel === 'setup' && openSyncPanel(null)}>
        {panel === 'setup' ? <SetupPanel /> : <FirstPanel />}
      </div>
    );
  return null;
}
