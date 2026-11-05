// タブレット版のパネルの中身（横は右のレールから1枚、縦は下のシート）。デスクトップの左右のパネルの部品をそのまま並べ直す
import type { ReactNode } from 'react';
import { tr } from '../../i18n';
import { type PanelId } from '../../store/device';
import { useEditor } from '../../store/editor';
import { Icon } from '../icons';
import { LeftPanel } from '../LeftPanel';
import { NxPreview } from '../NxPreview';
import { ReferenceCard } from '../ReferenceCard';
import { AssistCard, CheckCard, CompleteCard, MeasureCard, NoticeCard, SelectionCard, StatsCard } from '../RightPanel';
import { SourceCard } from '../SourceCard';
import { PadPanel } from './Pads';

export function panelIcon(id: PanelId | 'trk', size = 20): ReactNode {
  switch (id) {
    case 'pad':
      return Icon.grid(size);
    case 'snd':
      return Icon.db(size);
    case 'src':
      return Icon.wave(size);
    case 'asst':
      return Icon.ear(size);
    case 'chk':
      return Icon.checkCircle(size);
    case 'prev':
      return Icon.screen(size);
    case 'trk':
      return Icon.sliders(size);
  }
}

/** パネルの中身。where: 横のパネルか縦のシートか（パッドの並びが変わる） */
export function PanelContent({ id, where }: { id: PanelId; where: 'panel' | 'sheet' }) {
  const hasSel = useEditor((s) => s.selection.length > 0);
  switch (id) {
    case 'pad':
      return <PadPanel where={where} />;
    case 'snd':
      return (
        <div className="t-pane t-pane-snd">
          <LeftPanel />
        </div>
      );
    case 'src':
      return (
        <div className="t-pane t-cards scroll">
          <SourceCard />
          <ReferenceCard />
        </div>
      );
    case 'asst':
      return (
        <div className="t-pane t-cards scroll">
          <AssistCard />
          <CompleteCard />
        </div>
      );
    case 'chk':
      return (
        <div className="t-pane t-cards scroll">
          <CheckCard />
          {hasSel && <SelectionCard />}
          <MeasureCard />
          <StatsCard />
          <NoticeCard />
        </div>
      );
    case 'prev':
      return (
        <div className="t-pane t-pane-prev">
          <NxPreview />
        </div>
      );
  }
}

/** パネルの見出しの説明（空なら出さない） */
export function panelNote(id: PanelId): string {
  switch (id) {
    case 'prev':
      return tr('ゲームと同じ流れ方で、譜面を確かめます', 'Check the chart the way it scrolls in the game');
    default:
      return '';
  }
}
