// 画面の言語を React で購読する（言語が変わると、呼んだコンポーネントを描き直す）
import { useSyncExternalStore } from 'react';
import { getLang, subscribeLang, type Lang } from './index';

export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}
