// PC どうしの同期の画面で使う小さな部品と言葉（時刻・合わせる曲の名前・曲ごとの同期の様子・記録のまとめ）。
import { useEffect, useState } from 'react';
import { locale, pl, tr } from '../../i18n';
import type { LibSong } from '../../nxlib/scan';
import { SLOT_LABEL } from '../../nxlib/view';
import { songKey, type LogEntry } from '../../sync/store';
import type { RunReport, ScoreNews, SongReport, SyncProgressInfo, SyncSettings } from '../../sync/types';
import { updText } from '../nxlib/parts';

/** 時刻の言葉（「2 分前」）を、時間がたったら書き直す */
export function useNow(every = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [every]);
  return now;
}

/** 21:45 */
export function hm(t: number): string {
  return new Date(t).toLocaleTimeString(locale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** たった今・2 分前・3 時間前・昨日 23:12 */
export function agoText(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return tr('たった今', 'just now');
  if (s < 3600) {
    const n = Math.floor(s / 60);
    return tr(`${n} 分前`, `${n} ${pl(n, 'minute')} ago`);
  }
  if (s < 6 * 3600) {
    const n = Math.floor(s / 3600);
    return tr(`${n} 時間前`, `${n} ${pl(n, 'hour')} ago`);
  }
  return updText(t);
}

/** 合わせる曲の名前（設定） */
export function scopeName(s: Pick<SyncSettings, 'scope'>): string {
  return s.scope === 'all' ? tr('全部の曲', 'All songs') : tr('作った曲', 'Songs you made');
}

/** 1 回の同期の見出し */
export function runTitle(why: RunReport['why']): string {
  switch (why) {
    case 'open':
      return tr('開いたときに同期しました', 'Synced when the app opened');
    case 'timer':
      return tr('5 分ごとの同期', 'Synced (every 5 minutes)');
    case 'save':
      return tr('保存したときに同期しました', 'Synced when you saved');
    case 'manual':
      return tr('今すぐ同期しました', 'Synced now');
    case 'first':
      return tr('初めての同期', 'First sync');
  }
}

/** 進み具合の言葉（上の帯・記録） */
export function progressText(p: SyncProgressInfo | null): string {
  if (p?.phase === 'wait') return tr('ほかの窓・タブの同期を待っています…', 'Waiting for the sync in another window or tab…');
  if (!p || p.phase === 'list') return tr('Drive と比べています…', 'Comparing with Drive…');
  if (p.phase === 'check') return p.total ? tr(`比べています ${p.done}/${p.total}`, `Comparing ${p.done}/${p.total}`) : tr('比べています…', 'Comparing…');
  return p.total ? tr(`同期中 ${p.done}/${p.total}`, `Syncing ${p.done}/${p.total}`) : tr('同期中…', 'Syncing…');
}

/** 2 つのフォルダの並びが同じか（大文字・小文字は見ない） */
export function samePath(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());
}

/** 記録の曲が、一覧のどの曲か（同じフォルダのいちばん目） */
export function libSongOf(songs: readonly LibSong[], r: Pick<SongReport, 'root' | 'path'>): LibSong | undefined {
  if (r.root === undefined || !r.path) return undefined;
  return songs.find((s) => s.root === r.root && samePath(s.path, r.path!));
}

/** 譜面のファイル名 → 難易度の名前（MASTER など。わからなければファイル名） */
export function chartName(song: LibSong | undefined, file: string): string {
  const name = file.split('/').pop() ?? file;
  const c = song?.charts.find((x) => x.file.toLowerCase() === name.toLowerCase() || x.file.toLowerCase().endsWith(`/${name.toLowerCase()}`));
  if (c?.slot) return SLOT_LABEL[c.slot];
  if (c?.label) return c.label;
  return name;
}

/** 成績の知らせ（MASTER +3 回 · 自己ベスト S 93.6%） */
export function newsText(n: ScoreNews, chart: string): string {
  const parts = [n.plays > 0 ? tr(`${chart} +${n.plays} 回`, `${chart} +${n.plays} ${pl(n.plays, 'play')}`) : chart];
  const rec = [n.rank ?? '', n.skill !== null ? `${n.skill.toFixed(1)}%` : ''].filter(Boolean).join(' ');
  if (n.best) parts.push(rec ? tr(`自己ベスト ${rec}`, `personal best ${rec}`) : tr('自己ベスト', 'personal best'));
  else if (rec) parts.push(rec);
  return parts.join(' · ');
}

/** 譜面のファイルか（.dtx など） */
export function isChartFile(p: string): boolean {
  return /\.(dtx|gda|g2d|bms|bme|bml)$/i.test(p);
}

/** ファイルの名前を並べる（多ければ「ほか N」） */
export function fileList(paths: readonly string[], max = 3): string {
  const names = paths.map((p) => p.split('/').pop() ?? p);
  const head = names.slice(0, max).join(tr('・', ', '));
  return names.length > max ? tr(`${head} ほか ${names.length - max}`, `${head} and ${names.length - max} more`) : head;
}

// ---- 曲ごとの同期の様子 -------------------------------------------------------------------

/** 一覧・ホームの印にする、最近（24 時間）同期で変わったこと */
export interface RecentChange {
  at: number;
  /** この PC に無かった曲を取った */
  isNew: boolean;
  /** 取った作るファイルと、そのうちの譜面 */
  got: number;
  charts: string[];
  /** 取った成績（増えた回数の合計）と、まとめた譜面 */
  plays: number;
  scores: number;
  merged: number;
  newer: number;
  sent: number;
  scoresSent: number;
  deleted: number;
  from?: string;
  news: ScoreNews[];
}

/** 同期で変わった曲（曲のフォルダの鍵 → まとめ）。下見は数えない */
export function recentChanges(log: readonly LogEntry[], since = Date.now() - 86_400_000): Map<string, RecentChange> {
  const out = new Map<string, RecentChange>();
  for (const l of log) {
    if (l.at < since || l.dry) continue;
    for (const s of l.songs) {
      if (s.root === undefined || !s.path) continue;
      const k = songKey({ root: s.root, path: s.path });
      const c = out.get(k) ?? {
        at: l.at,
        isNew: false,
        got: 0,
        charts: [],
        plays: 0,
        scores: 0,
        merged: 0,
        newer: 0,
        sent: 0,
        scoresSent: 0,
        deleted: 0,
        news: [],
      };
      c.at = Math.max(c.at, l.at);
      if (s.where === 'none' && s.got.length) c.isNew = true;
      c.got += s.got.length;
      for (const p of s.got) if (isChartFile(p) && !c.charts.includes(p)) c.charts.push(p);
      c.scores += s.scoresGot.length;
      c.merged += s.merged.length;
      c.newer += s.newer.length;
      c.sent += s.sent.length;
      c.scoresSent += s.scoresSent.length;
      c.deleted += s.deleted.length;
      for (const n of s.news ?? []) {
        c.plays += n.plays;
        c.news.push(n);
      }
      c.from ??= s.from;
      out.set(k, c);
    }
  }
  return out;
}

/** 一覧の印にするか（取った・まとめた・新しい方にした・消した。送っただけは出さない） */
export function changedHere(c: RecentChange | undefined): boolean {
  return !!c && (c.got > 0 || c.scores > 0 || c.merged > 0 || c.newer > 0 || c.deleted > 0);
}

/** 一覧の行の印（同期で変わったこと。無ければ「同期」） */
export function changePill(c: RecentChange | undefined): { k: 'got' | 'merged'; label: string; title: string; icon?: 'down' } | null {
  if (!c || !changedHere(c)) return null;
  const from = c.from ? tr(`（${c.from} から）`, ` (from ${c.from})`) : '';
  if (c.merged)
    return {
      k: 'merged',
      label: tr('まとめた', 'Merged'),
      title: tr('両方の PC で遊んでいた成績をまとめました', 'Records played on both PCs were merged'),
    };
  if (c.isNew)
    return {
      k: 'got',
      label: tr('新しい曲', 'New song'),
      title: tr(`ほかの PC で作った曲を取りました${from}`, `Got a song made on another PC${from}`),
      icon: 'down',
    };
  if (c.charts.length)
    return {
      k: 'got',
      label: tr(`譜面 ${c.charts.length}`, `${c.charts.length} ${pl(c.charts.length, 'chart')}`),
      title: tr(`新しい譜面を取りました${from}`, `Got newer charts${from}`),
      icon: 'down',
    };
  if (c.got)
    return {
      k: 'got',
      label: tr(`取った ${c.got}`, `Got ${c.got}`),
      title: tr(`新しいファイルを取りました${from}`, `Got newer files${from}`),
      icon: 'down',
    };
  if (c.scores)
    return {
      k: 'got',
      label: c.plays ? tr(`成績 +${c.plays}`, `Records +${c.plays}`) : tr('成績', 'Records'),
      title: tr(`ほかの PC で遊んだ成績を取りました${from}`, `Got records played on another PC${from}`),
      icon: 'down',
    };
  if (c.newer)
    return {
      k: 'merged',
      label: tr('新しい方に', 'Kept newer'),
      title: tr('両方で直されていたファイルを、新しい方にしました（記録から戻せます）', 'Files changed on both PCs were set to the newer one (restorable from the log)'),
    };
  return {
    k: 'merged',
    label: tr('消した', 'Deleted'),
    title: tr('ほかの PC で消したファイルを、この PC でも消しました', 'Files deleted on another PC were deleted here too'),
  };
}

/** 右の「同期」に出す、この曲のいちばん新しいこと */
export interface SongSyncView {
  make?: {
    kind: 'sent' | 'got' | 'newer';
    at: number;
    n: number;
    from?: string;
  };
  play?: {
    kind: 'got' | 'merged' | 'sent';
    at: number;
    n: number;
    from?: string;
    news: ScoreNews[];
  };
  error?: { at: number; text: string };
  later?: { at: number; n: number };
  wait?: { at: number; n: number };
}

export function songSyncView(log: readonly LogEntry[], root: string, path: readonly string[]): SongSyncView {
  const out: SongSyncView = {};
  let first = true;
  for (const l of log) {
    if (l.dry) continue;
    for (const s of l.songs) {
      if (s.root !== root || !samePath(s.path, path)) continue;
      if (first) {
        first = false;
        if (s.error) out.error = { at: l.at, text: s.error };
        if (s.later.length) out.later = { at: l.at, n: s.later.length };
        if (s.wait.length) out.wait = { at: l.at, n: s.wait.length };
      }
      if (!out.make) {
        if (s.newer.length)
          out.make = {
            kind: 'newer',
            at: l.at,
            n: s.newer.length,
            from: s.newer[0].dev,
          };
        else if (s.got.length) out.make = { kind: 'got', at: l.at, n: s.got.length, from: s.from };
        else if (s.sent.length) out.make = { kind: 'sent', at: l.at, n: s.sent.length };
      }
      if (!out.play) {
        if (s.merged.length)
          out.play = {
            kind: 'merged',
            at: l.at,
            n: s.merged.length,
            news: s.news ?? [],
          };
        else if (s.scoresGot.length)
          out.play = {
            kind: 'got',
            at: l.at,
            n: s.scoresGot.length,
            from: s.from,
            news: s.news ?? [],
          };
        else if (s.scoresSent.length)
          out.play = {
            kind: 'sent',
            at: l.at,
            n: s.scoresSent.length,
            news: [],
          };
      }
    }
  }
  return out;
}

/** 1 回の同期のまとめ（ホームの帯・記録の頭） */
export interface RunSum {
  newSongs: number;
  chartSongs: number;
  charts: number;
  gotSongs: number;
  scoreSongs: number;
  sentScoreSongs: number;
  mergedSongs: number;
  sentSongs: number;
  newer: number;
  later: number;
  any: boolean;
  got: boolean;
}

export function runSum(rep: RunReport): RunSum {
  const s: RunSum = {
    newSongs: 0,
    chartSongs: 0,
    charts: 0,
    gotSongs: 0,
    scoreSongs: 0,
    sentScoreSongs: 0,
    mergedSongs: 0,
    sentSongs: 0,
    newer: 0,
    later: 0,
    any: false,
    got: false,
  };
  for (const x of rep.songs) {
    const charts = x.got.filter(isChartFile).length;
    if (x.where === 'none' && x.got.length) s.newSongs++;
    else if (charts) {
      s.chartSongs++;
      s.charts += charts;
    } else if (x.got.length) s.gotSongs++;
    if (x.scoresGot.length) s.scoreSongs++;
    if (x.scoresSent.length) s.sentScoreSongs++;
    if (x.merged.length) s.mergedSongs++;
    if (x.sent.length) s.sentSongs++;
    s.newer += x.newer.length;
    s.later += x.later.length;
  }
  s.got = s.newSongs + s.chartSongs + s.gotSongs + s.scoreSongs + s.mergedSongs > 0;
  s.any = s.got || s.sentScoreSongs + s.sentSongs + s.newer + s.later > 0;
  return s;
}

/** 1 回の同期を一文で（ホームの帯）：「作るPC で直した曲を取り、この PC で遊んだ成績を送りました。」 */
export function runSentence(rep: RunReport, sum: RunSum): string {
  const froms = [...new Set(rep.songs.map((s) => s.from).filter((x): x is string => !!x))];
  const from = froms.length === 1 ? froms[0] : '';
  const parts: string[] = [];
  const gotMake = sum.newSongs + sum.chartSongs + sum.gotSongs > 0;
  if (gotMake && sum.scoreSongs)
    parts.push(from ? tr(`${from} で直した曲と遊んだ成績を取り`, `got songs changed and records played on ${from}`) : tr('ほかの PC で直した曲と遊んだ成績を取り', 'got songs changed and records played on the other PCs'));
  else if (gotMake) parts.push(from ? tr(`${from} で直した曲を取り`, `got songs changed on ${from}`) : tr('ほかの PC で直した曲を取り', 'got songs changed on the other PC'));
  else if (sum.scoreSongs) parts.push(from ? tr(`${from} で遊んだ成績を取り`, `got records played on ${from}`) : tr('ほかの PC で遊んだ成績を取り', 'got records played on the other PC'));
  if (sum.sentSongs && sum.sentScoreSongs) parts.push(tr('この PC で直した曲と遊んだ成績を送り', 'sent songs changed and records played here'));
  else if (sum.sentSongs) parts.push(tr('この PC で直した曲を送り', 'sent songs changed here'));
  else if (sum.sentScoreSongs) parts.push(tr('この PC で遊んだ成績を送り', 'sent records played here'));
  if (sum.mergedSongs) parts.push(tr('両方で遊んだ成績をまとめ', 'merged records played on both'));
  if (!parts.length) return tr('取った物・送った物は、記録で確かめられます。', 'See what was got and sent in the log.');
  const en = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return tr(`${parts.join('、')}ました。`, `${en.charAt(0).toUpperCase()}${en.slice(1)}.`);
}
