// 無理な配置の警告：手が3本いる同時打ち、足が足りない同時打ち、同じレーンの速すぎる連打（フラムは除く）。
import { tr } from '../i18n';
import { CH, drumChannel, type DtxDoc } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { FLAM_MAX_SEC, flamPairStarts } from '../edit/flam';

export type IssueKind = 'hands' | 'feet' | 'leftFoot' | 'hhBoth' | 'fast';

export interface Issue {
  kind: IssueKind;
  /** 重さ：error は叩けない、warn は難しい */
  level: 'error' | 'warn';
  sec: number;
  beat: number;
  m: number;
  ids: number[];
  message: string;
}

/** 手で叩くレーン（DRUM_LANES の番号）: LC HH SD HT LT FT CY RD */
const HAND_LANES = new Set([0, 1, 3, 4, 6, 7, 8, 9]);
const LANE_KEYS = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY', 'RD'];

export interface IssueOptions {
  /** 同時とみなす幅（秒） */
  chordSec: number;
  /** 手のレーンで、これより短い間隔の連打は警告（秒） */
  handFastSec: number;
  /** 右足（BD）の連打 */
  footFastSec: number;
  /** 左足（LP・LBD） */
  leftFootFastSec: number;
}

export const DEFAULT_ISSUE_OPTIONS: IssueOptions = { chordSec: 0.012, handFastSec: 0.045, footFastSec: 0.075, leftFootFastSec: 0.09 };

interface Note {
  id: number;
  ch: number;
  lane: number;
  sec: number;
  beat: number;
  m: number;
}

export function findIssues(doc: DtxDoc, tempo: TempoMap, opt: IssueOptions = DEFAULT_ISSUE_OPTIONS): Issue[] {
  const notes: Note[] = [];
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    const beat = tempo.beatOf(c.m, c.f);
    notes.push({ id: c.id, ch: c.ch, lane: d.lane, sec: tempo.beatToSec(beat), beat, m: c.m });
  }
  notes.sort((a, b) => a.sec - b.sec);
  const out: Issue[] = [];
  const push = (kind: IssueKind, level: Issue['level'], group: Note[], message: string) =>
    out.push({ kind, level, sec: group[0].sec, beat: group[0].beat, m: group[0].m, ids: group.map((n) => n.id), message });

  // 同時打ち
  for (let i = 0; i < notes.length; ) {
    let j = i + 1;
    while (j < notes.length && notes[j].sec - notes[i].sec <= opt.chordSec) j++;
    const g = notes.slice(i, j);
    i = j;
    if (g.length < 2) continue;
    const hands = [...new Set(g.filter((n) => HAND_LANES.has(n.lane)).map((n) => n.lane))];
    if (hands.length > 2) {
      push('hands', 'error', g.filter((n) => HAND_LANES.has(n.lane)), tr(`手が${hands.length}本いる同時打ち（${hands.map((l) => LANE_KEYS[l]).join('・')}）`, `Needs ${hands.length} hands at once (${hands.map((l) => LANE_KEYS[l]).join(', ')})`));
    }
    const chs = new Set(g.map((n) => n.ch));
    const feet = [CH.BD, CH.LBD, CH.LP].filter((c) => chs.has(c));
    if (feet.length > 2) push('feet', 'error', g.filter((n) => feet.includes(n.ch as never)), tr('足が3本いる同時打ち（BD・LBD・LP）', 'Needs 3 feet at once (BD, LBD, LP)'));
    else if (chs.has(CH.LBD) && chs.has(CH.LP)) push('leftFoot', 'error', g.filter((n) => n.ch === CH.LBD || n.ch === CH.LP), tr('左足で2つ同時（左ペダルと左バスドラム）', 'Two left-foot notes at once (left pedal and left bass drum)'));
    if (chs.has(CH.HHC) && chs.has(CH.HHO)) push('hhBoth', 'warn', g.filter((n) => n.ch === CH.HHC || n.ch === CH.HHO), tr('HHクローズとHHオープンが同時', 'Closed and open hi-hat at the same time'));
  }

  // 同じ手足の速すぎる連打（HH は開閉を同じ、左足は LP と LBD を同じとみなす）
  const limbOf = (n: Note): string | null => {
    if (n.ch === CH.BD) return 'rf';
    if (n.ch === CH.LBD || n.ch === CH.LP) return 'lf';
    return HAND_LANES.has(n.lane) ? `h${n.lane}` : null;
  };
  // フラム（手のレーンの、前後から離れたすばやい2打）は両手で叩くので連打の警告にしない
  const flams = new Set<string>();
  {
    const byLimb = new Map<string, Note[]>();
    for (const n of notes) {
      const limb = limbOf(n);
      if (!limb || !limb.startsWith('h')) continue;
      let a = byLimb.get(limb);
      if (!a) byLimb.set(limb, (a = []));
      a.push(n);
    }
    for (const list of byLimb.values()) {
      for (const i of flamPairStarts(list.map((n) => n.sec), FLAM_MAX_SEC)) flams.add(`${list[i].id}:${list[i + 1].id}`);
    }
  }
  const last = new Map<string, Note>();
  const reported = new Set<string>();
  for (const n of notes) {
    const limb = limbOf(n);
    if (!limb) continue;
    const prev = last.get(limb);
    last.set(limb, n);
    if (!prev) continue;
    const dt = n.sec - prev.sec;
    if (dt <= opt.chordSec) continue;
    if (flams.has(`${prev.id}:${n.id}`)) continue;
    const lim = limb === 'rf' ? opt.footFastSec : limb === 'lf' ? opt.leftFootFastSec : opt.handFastSec;
    if (dt >= lim) continue;
    // 続く連打は1つの警告にまとめる
    const key = `${limb}:${prev.id}`;
    if (reported.has(key)) {
      const lastIssue = out[out.length - 1];
      if (lastIssue?.kind === 'fast' && lastIssue.ids.includes(prev.id)) {
        lastIssue.ids.push(n.id);
        reported.add(`${limb}:${n.id}`);
        continue;
      }
    }
    reported.add(`${limb}:${n.id}`);
    const ms = Math.round(dt * 1000);
    const what =
      limb === 'rf' ? tr('バスドラム（右足）', 'Bass drum (right foot)') : limb === 'lf' ? tr('左足（左ペダル・左バスドラム）', 'Left foot (left pedal, left bass drum)') : LANE_KEYS[n.lane];
    const hint = limb === 'rf' ? tr('。左バスドラムに振り分けると楽になります', '. Moving some to the left bass drum makes it easier') : '';
    const message = tr(`${what}の連打が速すぎます（${ms}ミリ秒間隔）${hint}`, `${what} repeats too fast (${ms} ms apart)${hint}`);
    out.push({ kind: 'fast', level: 'warn', sec: prev.sec, beat: prev.beat, m: prev.m, ids: [prev.id, n.id], message });
  }
  out.sort((a, b) => a.sec - b.sec || (a.level === 'error' ? -1 : 1));
  return out;
}
