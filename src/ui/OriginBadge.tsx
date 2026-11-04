// 譜面の出どころの印：曲に既にある作者の譜面か、このアプリの AI難易度生成で作った譜面か（dtx/origin）
import { tr } from '../i18n';
import type { ChartOrigin } from '../dtx/origin';

export function originLabel(o: ChartOrigin): string {
  if (o === 'ai') return 'AI';
  if (o === 'ai-edited') return tr('AI・手直し', 'AI, edited');
  return tr('既存', 'Existing');
}

export function originTitle(o: ChartOrigin): string {
  if (o === 'ai') return tr('このアプリの AI難易度生成で作った譜面', 'Made with AI Difficulty Generation in this app');
  if (o === 'ai-edited') return tr('このアプリの AI難易度生成で作り、そのあと手で直した譜面', 'Made with AI Difficulty Generation in this app, then edited by hand');
  return tr('曲に既にある譜面（作者の譜面）', 'Already in the song (made by the chart author)');
}

/** 小さな印。tab はタブの中に入れる短い形（作者の譜面には付けない） */
export function OriginBadge({ origin, tab }: { origin: ChartOrigin; tab?: boolean }) {
  if (tab && origin === 'human') return null;
  return (
    <span className={`origin-badge ${origin}${tab ? ' tab' : ''}`} title={originTitle(origin)}>
      {tab ? (origin === 'ai' ? 'AI' : 'AI✎') : originLabel(origin)}
    </span>
  );
}
