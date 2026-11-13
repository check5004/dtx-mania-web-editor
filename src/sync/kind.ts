// PC どうしの同期で、曲のフォルダのファイルを「作るファイル」と「遊ぶファイル」に分ける。
// - 遊ぶファイル（play）：DTXMania が譜面の隣に書く成績 <譜面>.score.ini と、ゴースト <譜面>.<hiscore|hiskill|lastplay>.<dr|gt|bs>.ghost。
//   両方の PC で遊んだら中身をまとめる（src/sync/scoreIni.ts）。自動では消さない。
// - 作るファイル（make）：そのほか（譜面・set.def・音・画像・動画・作業ファイル）。両方で直したら新しい方＋控え。
// どれも DTXManiaNX のソース（CStageResult.cs・CScoreIni.cs）で確かめた名前。

export type FileKind = 'make' | 'play';

const SCORE = /\.score\.ini$/i;
const GHOST = /\.(hiscore|hiskill|lastplay)\.(dr|gt|bs)\.ghost$/i;

export function kindOf(path: string): FileKind {
  return SCORE.test(path) || GHOST.test(path) ? 'play' : 'make';
}

export function isScoreIni(path: string): boolean {
  return SCORE.test(path);
}

/** 成績のまとまり（譜面のパスの小文字。「mstr.dtx.score.ini」も「mstr.dtx.hiscore.dr.ghost」も「mstr.dtx」）。遊ぶファイルでなければ null */
export function scoreGroupOf(path: string): string | null {
  const low = path.toLowerCase();
  const s = SCORE.exec(low);
  if (s) return low.slice(0, s.index);
  const g = GHOST.exec(low);
  if (g) return low.slice(0, g.index);
  return null;
}

/** ゴーストが score.ini のどの節と組か（「HiScore.Drums」など）。ゴーストでなければ null */
export function ghostSection(path: string): string | null {
  const g = GHOST.exec(path);
  if (!g) return null;
  const kind = ({ hiscore: 'HiScore', hiskill: 'HiSkill', lastplay: 'LastPlay' } as const)[g[1].toLowerCase() as 'hiscore' | 'hiskill' | 'lastplay'];
  const inst = ({ dr: 'Drums', gt: 'Guitar', bs: 'Bass' } as const)[g[2].toLowerCase() as 'dr' | 'gt' | 'bs'];
  return `${kind}.${inst}`;
}

/** 動画（大きいので、送るかを選べる） */
export const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|flv|3gp)$/i;
