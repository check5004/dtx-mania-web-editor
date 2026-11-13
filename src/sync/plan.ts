// PC どうしの同期で、1 曲のファイルをどうするか決める（ファイルを触らない関数だけ。試験しやすく）。
// ファイルごとに「前に合わせたとき（記録）」「この PC」「Drive（ほかの PC）」の 3 つを比べる：
// - 片方だけ変わった・足した → そちらに合わせる（送る・取る）
// - 両方で同じ中身 → 記録だけ直す
// - 両方で変わった：遊ぶファイル（成績）はまとめる、作るファイル（譜面・音）は新しい方を残して、もう一方は控えへ
// - この PC で消した作るファイル → Drive ではゴミ箱へ（Drive が前のままなら）。ほかの PC で消した → この PC でも消す（前のままなら）
// - 成績は自動では消さない（消えていたら取り直す・送り直す）
// - 初めて合わせる曲で、この PC の版がほかの PC の作るファイルを置きかえるときは聞く（ask）
import { isScoreIni, kindOf, scoreGroupOf } from './kind';

export interface LocalStat {
  path: string;
  size: number;
  /** ファイルの更新時刻（ミリ秒） */
  mtime: number;
  /** 分かっていれば（記録と同じ・計算した） */
  md5?: string;
}

export interface RemoteStat {
  id: string;
  path: string;
  md5: string;
  size: number;
  /** Drive の更新時刻（ミリ秒。送るときにこの PC で直した時刻を書く） */
  time: number;
  /** 送った PC の名前 */
  dev?: string;
}

/** 前に合わせたとき（.dtxe-drive.json の files と同じ形） */
export interface BaseRec {
  id: string;
  md5: string;
  size: number;
  mtime: number;
  path: string;
}

export type Act =
  /** 同じ（記録だけ直す） */
  | { op: 'same'; key: string; path: string; remote: RemoteStat }
  /** 送る（id があれば上書き） */
  | { op: 'up'; key: string; path: string; id?: string; why: 'new' | 'changed' | 'restore' }
  /** 取る */
  | { op: 'down'; key: string; path: string; remote: RemoteStat; why: 'new' | 'changed' | 'restore' }
  /** この PC で消した：Drive ではゴミ箱へ */
  | { op: 'trash'; key: string; path: string; remote: RemoteStat }
  /** ほかの PC で消した：この PC でも消す */
  | { op: 'delete'; key: string; path: string }
  /** どちらにも無い：記録から外す */
  | { op: 'drop'; key: string }
  /** 両方で直した・この PC が新しい：Drive の版を控えに写してから送る */
  | { op: 'keepLocal'; key: string; path: string; remote: RemoteStat }
  /** 両方で直した・Drive が新しい：この PC の版を控えに送ってから取る */
  | { op: 'keepRemote'; key: string; path: string; remote: RemoteStat }
  /** 両方で遊んだ：score.ini をまとめる（ゴーストは節を取った方から） */
  | { op: 'merge'; key: string; path: string; remote: RemoteStat; group: string }
  | { op: 'ghost'; key: string; path: string; remote: RemoteStat; group: string }
  /** どちらにするか聞く（初めて合わせる曲で、この PC の版が新しい・PC の時計がずれている） */
  | { op: 'ask'; key: string; path: string; remote: RemoteStat; why: 'first' | 'clock' }
  /** 待つ（開いている曲のこの PC への書き込み） */
  | { op: 'wait'; key: string; path: string; remote?: RemoteStat };

export interface PlanOptions {
  /** この曲を合わせるのが初めて（つなぎの記録が無い） */
  first: boolean;
  /** 開いている曲：この PC の作るファイルは書きかえない・消さない（保存したときと「取り込む」で） */
  open?: boolean;
  /** PC の時計が Drive とずれている：両方で直したファイルの新しい方を決めない */
  clockOff?: boolean;
  /** 聞いたことの答え（ファイルの鍵 → この PC の版・Drive の版） */
  answers?: ReadonlyMap<string, 'mine' | 'theirs'>;
  /** 前に聞いて、まだ答えていないファイル（初めて合わせるときと同じに、もう一度聞く） */
  asked?: ReadonlySet<string>;
}

/** 記録と同じ（大きさと更新時刻が同じ。中身を読まずに同じとみる） */
export function statSame(l: Pick<LocalStat, 'size' | 'mtime'>, rec: BaseRec | undefined): boolean {
  return !!rec && !!rec.md5 && rec.size === l.size && rec.mtime === l.mtime;
}

/** この PC のファイルの MD5 を計算しないと決められないか（大きさだけでは分からない） */
export function needsMd5(l: LocalStat | undefined, r: RemoteStat | undefined, rec: BaseRec | undefined): boolean {
  if (!l || l.md5) return false;
  if (statSame(l, rec)) return false;
  if (r && l.size === r.size) return true;
  if (rec && l.size === rec.size) return true;
  return false;
}

function changedSince(l: LocalStat, rec: BaseRec): boolean {
  if (statSame(l, rec)) return false;
  if (l.md5) return l.md5 !== rec.md5;
  return true;
}

function sameContent(l: LocalStat, r: RemoteStat): boolean {
  if (l.size !== r.size) return false;
  return !!l.md5 && l.md5 === r.md5;
}

/** 1 曲のファイルをどうするか。local・remote・recs の鍵は正規化したパス（小文字） */
export function planSong(local: ReadonlyMap<string, LocalStat>, remote: ReadonlyMap<string, RemoteStat>, recs: Readonly<Record<string, BaseRec>>, o: PlanOptions): Act[] {
  const out: Act[] = [];
  const keys = new Set([...local.keys(), ...remote.keys(), ...Object.keys(recs)]);
  /** 両方で変わった（中身が違う） */
  const both = (key: string, l: LocalStat, r: RemoteStat, firstFile: boolean) => {
    if (kindOf(key) === 'play') {
      const group = scoreGroupOf(key)!;
      out.push(isScoreIni(key) ? { op: 'merge', key, path: l.path, remote: r, group } : { op: 'ghost', key, path: l.path, remote: r, group });
      return;
    }
    const ans = o.answers?.get(key);
    if (ans) {
      out.push(ans === 'mine' ? { op: 'keepLocal', key, path: l.path, remote: r } : { op: 'keepRemote', key, path: l.path, remote: r });
      return;
    }
    if (o.clockOff) {
      out.push({ op: 'ask', key, path: l.path, remote: r, why: 'clock' });
      return;
    }
    // 新しい方。同じ時刻なら Drive の方
    if (l.mtime > r.time) {
      // 初めて合わせる曲で、この PC の版がほかの PC の作るファイルを置きかえるときは聞く
      if (firstFile && (o.first || o.asked?.has(key))) out.push({ op: 'ask', key, path: l.path, remote: r, why: 'first' });
      else out.push({ op: 'keepLocal', key, path: l.path, remote: r });
    } else out.push({ op: 'keepRemote', key, path: l.path, remote: r });
  };
  for (const key of [...keys].sort()) {
    const l = local.get(key);
    const r = remote.get(key);
    const rec = recs[key];
    const play = kindOf(key) === 'play';
    if (!rec) {
      if (l && !r) out.push({ op: 'up', key, path: l.path, why: 'new' });
      else if (!l && r) out.push({ op: 'down', key, path: r.path, remote: r, why: 'new' });
      else if (l && r) {
        if (sameContent(l, r)) out.push({ op: 'same', key, path: l.path, remote: r });
        else both(key, l, r, true);
      }
      continue;
    }
    if (l && r) {
      const lc = changedSince(l, rec);
      const rc = r.md5 !== rec.md5;
      if (!lc && !rc) out.push({ op: 'same', key, path: l.path, remote: r });
      else if (lc && !rc) {
        if (sameContent(l, r)) out.push({ op: 'same', key, path: l.path, remote: r });
        else out.push({ op: 'up', key, path: l.path, id: r.id, why: 'changed' });
      } else if (!lc && rc) out.push({ op: 'down', key, path: l.path, remote: r, why: 'changed' });
      else if (sameContent(l, r)) out.push({ op: 'same', key, path: l.path, remote: r });
      else both(key, l, r, false);
    } else if (l && !r) {
      // Drive で消えた（ほかの PC で消した）
      if (changedSince(l, rec) || play) out.push({ op: 'up', key, path: l.path, why: play ? 'restore' : 'new' });
      else out.push({ op: 'delete', key, path: l.path });
    } else if (!l && r) {
      // この PC で消えた
      if (r.md5 !== rec.md5 || play) out.push({ op: 'down', key, path: r.path, remote: r, why: play ? 'restore' : 'new' });
      else out.push({ op: 'trash', key, path: r.path, remote: r });
    } else out.push({ op: 'drop', key });
  }
  if (!o.open) return out;
  // 開いている曲：この PC の作るファイルを書きかえる・消すことは、保存したとき・「取り込む」まで待つ
  return out.map((a) => {
    if (kindOf(a.op === 'drop' ? a.key : a.path) === 'play') return a;
    if (a.op === 'down' || a.op === 'keepRemote' || a.op === 'delete' || (a.op === 'ask' && a.why === 'clock')) return { op: 'wait', key: a.key, path: a.path, ...('remote' in a ? { remote: a.remote } : {}) };
    return a;
  });
}
