// おまかせで準備の入口（fileActions から読み込む。setup.ts が fileActions を使うので、ここを通して輪にしない）
import { setupSheet, type SetupAnswer } from '../ui/SetupSheet';
import { runSetup, setupSourceOf, setupSourceOfFolder, type SetupSource } from './setup';

export { setupSourceOf, setupSourceOfFolder };

/**
 * おまかせで準備の画面を出す。「おまかせで準備する」なら準備して null、やめても null。
 * 「自分で入れる」なら、選び直した原曲・ステムの種類を入れた答えを返す（今までの新しい譜面の画面へ）
 */
export async function offerSetup(src: SetupSource): Promise<SetupAnswer | null> {
  const ans = await setupSheet(src);
  if (!ans) return null;
  if (ans.mode === 'manual') return ans;
  await runSetup(ans.src, ans.opts);
  return null;
}
