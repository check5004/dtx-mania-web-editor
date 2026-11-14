// AI（OpenRouter）を使う機能の一覧。キーが無いときに何ができて、キーで何が増えるかをまとめる。
// 「キーが要ります」の説明（src/ui/aiGuide/KeyGate.tsx）、AI を使う準備の案内、設定 › AI の一覧が同じものを使う。
// AI に頼む処理を足したら、ここにも足す（src/ai/features.test.ts が TASKS と見比べる）。
import { tr } from '../i18n';
import type { AiTask } from './tasks';

export type AiFeatureId = 'songinfo' | 'measure' | 'tabAsk' | 'phrase' | 'level' | 'difficulty' | 'guideline';

export interface AiFeature {
  id: AiFeatureId;
  /** 1回の目安の料金に使う処理（設定 › AI のモデル） */
  task: AiTask;
  /** 機能の名前 */
  name: string;
  /** どこから使うか */
  where: string;
  /** キーがあると増えること */
  withKey: string;
  /** キーが無くてもできること（全部 AI のときは空） */
  withoutKey: string;
  /** キーが無いと押せないボタン（鍵の印を付ける物） */
  locked: string;
}

/** AI を使う機能（表示のたびに今の言語で作る） */
export function aiFeatures(): AiFeature[] {
  return [
    {
      id: 'measure',
      task: 'measure',
      name: tr('小節の生成', 'Measure generation'),
      where: tr('小節線の左の ✨・Alt+G・右パネルの「小節」・右クリック', 'The ✨ left of bar lines, Alt+G, the Measure section of the right panel, right-click'),
      withKey: tr('原曲の打点と前後の小節から、AI が案を作る（ひとことを添えて作り直しも）', "The AI makes ideas from the original's hits and the measures around it (and remakes them with your note)"),
      withoutKey: tr('「写す」（この曲の似た小節）と「採譜」（原曲の打点から）の案', '"Copy" (a similar measure in this song) and "Detected" (from the original\'s hits) ideas'),
      locked: tr('AIで作る・ひとこと', 'Make with AI, Note'),
    },
    {
      id: 'tabAsk',
      task: 'phrase',
      name: tr('TAB補完の「AIに聞く」', 'Tab completion: Ask AI'),
      where: tr('TAB補完の札（Alt+]・チップを置いたあと）', 'The Tab completion tag (Alt+] or after placing chips)'),
      withKey: tr('この先の続きを AI に 3 つ作ってもらう', 'The AI makes 3 ways to continue from here'),
      withoutKey: tr('この曲でもう打った小節を写す候補', 'Ideas copied from measures already charted in this song'),
      locked: tr('AIに聞く', 'Ask AI'),
    },
    {
      id: 'phrase',
      task: 'phrase',
      name: tr('フレーズ候補', 'Phrase ideas'),
      where: tr('ツール › フレーズ候補・右パネルの「フィルの候補」「リズムの候補」', 'Tools › Phrase suggestions, and Fill / Groove ideas in the right panel'),
      withKey: tr('フィル・リズムの AI の案を 3 つ（ひとことで頼める）', '3 fill or groove ideas from the AI (you can add a note)'),
      withoutKey: tr('似た小節からコピー・直前の小節の複製', 'Copy from a similar measure, repeat the previous measure'),
      locked: tr('ひとこと', 'Note'),
    },
    {
      id: 'level',
      task: 'level',
      name: tr('AI のレベル判定', 'AI level rating'),
      where: tr('右パネルの「確かめる」・AI難易度生成', 'Check in the right panel, and the AI difficulty generator'),
      withKey: tr('ガイドラインと手元の似た譜面を物差しに、理由と難所つきでレベルを出す', 'Rates the level against the guidelines and your similar charts, with reasons and the hardest part'),
      withoutKey: tr('打数・密度などからの機械的な推定', 'A computed estimate from note counts, density and so on'),
      locked: tr('AIで判定', 'Rate with AI'),
    },
    {
      id: 'difficulty',
      task: 'difficulty',
      name: tr('AI難易度生成の方針', 'AI difficulty plan'),
      where: tr('上のバーの「AI難易度生成」', 'AI difficulties in the top bar'),
      withKey: tr('AI が方針を説明し、「AIへの追加の指示」を聞く。AI の判定で外れたら作り直す', 'The AI explains the plan and follows your extra instructions, and remakes a difficulty if its level check misses'),
      withoutKey: tr('ルールで作る（標準の方針で、機械的な推定が目標に入るまで）', 'Made by the rules (the standard plan, until the computed estimate reaches the target)'),
      locked: tr('AIへの追加の指示', 'Extra instructions for the AI'),
    },
    {
      id: 'songinfo',
      task: 'songinfo',
      name: tr('曲情報を調べる', 'Song info lookup'),
      where: tr('曲情報の「曲情報を調べる」・おまかせで準備', 'Look up song info in Song info, and Set up for me'),
      withKey: tr('Web 検索で正式な表記・年・ジャンル・公式の YouTube・背景の画像も探す', 'Also searches the web for the official spelling, year, genre, official YouTube video and background image'),
      withoutKey: tr('タグと iTunes で、曲名・アーティスト・ジャケット', 'Title, artist and jacket from the tags and iTunes'),
      locked: tr('AIで調べる（Web検索）', 'Look up with AI (web search)'),
    },
    {
      id: 'guideline',
      task: 'guideline',
      name: tr('難易度ガイドラインの下書き', 'Guideline draft'),
      where: tr('難易度ガイドライン', 'Difficulty guidelines'),
      withKey: tr('レベル帯ごとの基準文を AI が下書きする', 'The AI drafts the guideline text for each level band'),
      withoutKey: tr('手元の譜面の集計と、基準文を手で書く', 'Stats from your charts, and writing the guidelines by hand'),
      locked: tr('AIで下書き', 'Draft with AI'),
    },
  ];
}

export function aiFeature(id: AiFeatureId): AiFeature {
  return aiFeatures().find((f) => f.id === id)!;
}

/** AI を使わない（キーが要らない）けれど、AI と間違えやすい機能。案内の「キーが無くても使えます」に出す */
export function keyFreeFeatures(): string[] {
  return [
    tr('原曲の打点（ブラウザの中の採譜）', "Original hits (detection inside your browser)"),
    tr('ステム分解', 'Stem separation'),
    tr('テンポと曲の頭の推定', 'Tempo and song-start detection'),
    tr('試聴をサビから作る', 'Preview from the chorus'),
    tr('YouTube との自動合わせ', 'Auto-sync with YouTube'),
    tr('レベルの機械的な推定', 'Computed level estimate'),
  ];
}
