// PC どうしの同期（同じ Google アカウントの Drive で、何台の PC でも合わせる）の形。
// どの PC も作れて遊べる（PC に役割は無い）。Drive がまん中で、それぞれの PC は Drive と合わせる。
// 決まりは docs/drive.md の「PC どうしの同期」。

/** この PC の設定（このブラウザに残す） */
export interface SyncSettings {
  /** 同期する */
  on: boolean;
  /** この PC の名前（「デスクトップ」「ノートPC」など。記録と知らせに出すだけ） */
  pc: string;
  /** この PC の印（.sync/<pcId>.json。Drive に送ったファイルの devId。名前が同じ PC・名前を変えた PC も見分ける） */
  pcId: string;
  /** made：作った曲（このアプリで直した・Drive に送った曲と、足した BOX・曲）。all：全部の曲 */
  scope: 'made' | 'all';
  /** 足した BOX（Drive での並びの小文字。「オリジナル」「j-pop/2024」） */
  boxes: string[];
  /** 足した曲（Drive での並びの小文字） */
  songs: string[];
  /** 動画も送る */
  video: boolean;
  /** 成績とゴーストも合わせる */
  scores: boolean;
  /** 同期しない曲も、成績だけ合わせる */
  scoresOnly: boolean;
  /** Drive の BOX の外にある曲（iPad で作った曲など）を入れる BOX（Drive での並びの小文字。'' は BOX の外） */
  importBox: string;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  on: false,
  pc: '',
  pcId: '',
  scope: 'made',
  boxes: [],
  songs: [],
  video: true,
  scores: true,
  scoresOnly: false,
  importBox: '',
};

/** この PC が合わせている曲（Drive の曲のフォルダの id ごと） */
export interface IndexSong {
  /** この PC の場所（場所の鍵と、場所からのフォルダの並び） */
  root: string;
  path: string[];
  /** Drive での並び（小文字） */
  lib: string;
  /** 曲のフォルダとサブフォルダの id（サブフォルダのパスの小文字 → id。曲のフォルダは ''。Drive の変化がどの曲かを見る） */
  dirs: Record<string, string>;
  title: string;
  /** 次の同期で Drive の中を読み直す（聞いている・書けなかった・待っているファイルがある） */
  recheck?: boolean;
}

/** 同期している PC（Drive の「DTX Web Editor/.sync/<pcId>.json」。この PC も入る） */
export interface PcInfo {
  /** PC の印（設定の pcId） */
  id: string;
  name: string;
  /** その PC が前に .sync を書いた時刻（開いたとき・押したとき・30 分ごとの同期） */
  at: number;
  /** .sync/<pcId>.json の Drive の id（一覧から外すとき） */
  file: string;
}

/** この PC の同期の記録（このブラウザに残す。PC ごと・Google アカウントごと） */
export interface SyncState {
  v: 1;
  /** どの Google アカウントの記録か */
  account: string;
  /** Drive の変化を聞く印（changes） */
  token?: string;
  songs: Record<string, IndexSong>;
  /** この PC が書いた物（次に変化を聞いたとき見ない）：id → MD5（フォルダは 'dir'） */
  mine: Record<string, string>;
  /** .sync/<pcId>.json の id */
  pcFile?: string;
  /** 前の同期 */
  at: number;
  /** 前の全部の曲の同期（保存したときの 1 曲だけの同期は入れない）。ほかの窓・タブも、ここから 5 分は 5 分ごとの同期をしない */
  full?: number;
  /** PC の時計と Drive の時計の差（ミリ秒。Drive − PC）と、測った時刻 */
  skew?: number;
  clockAt?: number;
  /** 古い控えを片付けた日 */
  cleaned?: number;
  /** 聞いたことの答え（ask の id → 答え） */
  answers: Record<string, string>;
  /** 前の同期の設定（変わったら Drive の曲の中を全部読み直す） */
  sig?: string;
  /** 同期している PC（.sync から。読んだとき） */
  pcs?: PcInfo[];
}

export function emptyState(account = ''): SyncState {
  return { v: 1, account, songs: {}, mine: {}, at: 0, answers: {} };
}

/** 聞くこと（初めての同期の画面・記録に出す。答えるまでその曲・ファイルは待つ） */
export type Ask =
  /** この PC と Drive で中身が違う作るファイルで、この PC の版が新しい（初めて合わせる曲）・PC の時計がずれている。dev は Drive の版を送った PC の名前 */
  | { id: string; kind: 'file'; why: 'first' | 'clock'; title: string; lib: string; path: string; local: { time: number; size: number }; remote: { time: number; size: number; dev?: string } }
  /** 場所は違うが曲名とアーティストが同じ曲（同じ曲か） */
  | { id: string; kind: 'same'; title: string; artist: string; driveId: string; driveLib: string; localLib: string; local: { time: number; charts: number }; remote: { time: number; dev?: string } }
  /** この PC で合わせていた曲のフォルダが無い（消した・動かした） */
  | { id: string; kind: 'gone'; title: string; driveId: string; lib: string };

export type FileAnswer = 'mine' | 'theirs';
export type SameAnswer = 'join' | 'separate';
export type GoneAnswer = 'get' | 'trash' | 'leave';

/** 成績が変わった譜面（ほかの PC から取った・まとめた） */
export interface ScoreNews {
  /** 譜面のファイル名 */
  chart: string;
  /** この PC で増えた回数 */
  plays: number;
  /** いちばんいい達成率が良くなった */
  best: boolean;
  /** 今のいちばんいいランク（SS・S・A…）と達成率 */
  rank: string | null;
  skill: number | null;
  /** この PC でもほかの PC でも遊んでいたので、まとめた */
  merged?: boolean;
}

/** 曲ごとにしたこと（記録・初めての同期の画面） */
export interface SongReport {
  title: string;
  /** Drive での並び（元の綴り。「オリジナル/Neon Skyline」） */
  lib: string;
  /** Drive の曲のフォルダの id（まだ無ければ ''） */
  driveId: string;
  /** この PC の曲のフォルダ（場所の鍵と並び。まだ無い曲は置く所） */
  root?: string;
  path?: string[];
  /** この PC に：here ある・none 無い（取る）・new Drive に無い（送る） */
  where: 'here' | 'none' | 'new';
  /** 成績だけ合わせる曲 */
  play?: boolean;
  sent: string[];
  got: string[];
  sentBytes: number;
  gotBytes: number;
  /** 成績をまとめた譜面（譜面のファイル名と、この PC で増えた回数） */
  /** max：前にまとめた成績が無いので、回数は多い方にした（初めての同期） */
  merged: { chart: string; plays: number; max?: boolean }[];
  /** 成績を取った・送った譜面 */
  scoresGot: string[];
  /** 取った・まとめた成績の中身（増えた回数・自己ベスト） */
  news?: ScoreNews[];
  scoresSent: string[];
  /** この PC とほかの PC（dev。Drive の版を送った PC の名前）の両方で直した作るファイル：新しい方を残した。backup は控え（Drive のファイルの id） */
  newer: { path: string; kept: 'local' | 'remote'; backup?: string; dev?: string; localTime: number; remoteTime: number }[];
  /** Drive ではゴミ箱へ（この PC で消した）・この PC でも消した（ほかの PC で消した） */
  trashed: string[];
  deleted: string[];
  /** 書けなかった（DTXMania が開いている）。次の同期で */
  later: string[];
  /** 開いている曲で、保存したとき・「取り込む」まで待つ */
  wait: string[];
  /** 消さずに送り直した・取り直した（たくさん消えていた） */
  kept?: number;
  /** ほかの PC で消した曲を、この PC でも消した */
  removed?: boolean;
  /** Drive に同じ曲が 2 つあったので、この PC が使っていない方（driveId）をゴミ箱に移した */
  dup?: boolean;
  /**
   * 取った譜面・音などを送った、ほかの PC の名前（何台からでも）。v0.60 までの記録は 1 つの文字（その曲で最後に取った物の PC）。
   * 読むときは fromNames()
   */
  from?: string | string[];
  /** 取った・まとめた成績を送った（遊んだ）、ほかの PC の名前 */
  scoresFrom?: string[];
  error?: string;
}

/** 記録の PC の名前の並び（前の版の 1 つの文字も） */
export function fromNames(x: string | readonly string[] | undefined): string[] {
  if (!x) return [];
  return typeof x === 'string' ? [x] : [...x];
}

/** 名前を足す（同じ名前は 1 つ） */
export function addName(list: string | readonly string[] | undefined, name: string): string[] {
  const out = fromNames(list);
  if (name && !out.includes(name)) out.push(name);
  return out;
}

export function emptyReport(title: string, lib: string, driveId: string, where: SongReport['where']): SongReport {
  return { title, lib, driveId, where, sent: [], got: [], sentBytes: 0, gotBytes: 0, merged: [], scoresGot: [], scoresSent: [], newer: [], trashed: [], deleted: [], later: [], wait: [] };
}

/** 1 回の同期 */
export interface RunReport {
  at: number;
  pc: string;
  /** 何で動いたか */
  why: 'open' | 'timer' | 'save' | 'manual' | 'first';
  songs: SongReport[];
  asks: Ask[];
  /** Drive の空きが足りない・ログインが切れたなど */
  error?: string;
  /** 下見（初めての同期の画面。何も書いていない） */
  dry?: boolean;
}

/** 進み具合 */
export interface SyncProgressInfo {
  /** wait：ほかの窓・タブの同期が終わるのを待っている */
  phase: 'wait' | 'list' | 'check' | 'up' | 'down';
  song?: string;
  file?: string;
  /** 曲の数 */
  done: number;
  total: number;
  bytes: number;
}
