import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures, drumNotes } from './features';
import { crashStarts, DEFAULT_KEEP, describePolicy, detectFills, generateToTarget, LADDER, MAX_RUNG, simplify, type SectionPlan } from './simplify';

const chip = (id: number, ch: number, m: number, n = 0, d = 1) => ({ id, ch, m, f: { n, d }, v: 1 });

/** 16ビート：HH 16分、BD 1・3拍と16分の裏、SD 2・4拍とゴースト、4小節目ごとにタムのフィル、頭にクラッシュ */
function song(measures = 8, bpm = 150): DtxDoc {
  const chips = [];
  let id = 1;
  for (let m = 0; m < measures; m++) {
    const fill = m % 4 === 3;
    for (let k = 0; k < 16; k++) {
      const inFill = fill && k >= 8;
      if (!inFill) {
        if (!(k === 0 && m % 4 === 0)) chips.push(chip(id++, CH.HHC, m, k, 16));
        if (k === 0 || k === 8 || k === 11) chips.push(chip(id++, CH.BD, m, k, 16));
        if (k === 4 || k === 12) chips.push(chip(id++, CH.SD, m, k, 16));
        if (k === 7 || k === 14) chips.push(chip(id++, CH.SD, m, k, 16)); // ゴースト
      } else {
        const tom = k < 10 ? CH.SD : k < 12 ? CH.HT : k < 14 ? CH.LT : CH.FT;
        chips.push(chip(id++, tom, m, k, 16));
        if (k % 4 === 0) chips.push(chip(id++, CH.BD, m, k, 16));
      }
    }
    if (m % 4 === 0) chips.push(chip(id++, CH.CY, m, 0, 1));
  }
  return { ...emptyDoc(), fields: { BPM: String(bpm) }, chips, nextId: id };
}

const sections: SectionPlan[] = [
  { name: 'A', from: 0, to: 3, shift: 0 },
  { name: 'B', from: 4, to: 7, shift: 0 },
];

function at(doc: DtxDoc, m: number, ch: number): number[] {
  const t = buildTempoMap(doc);
  return drumNotes(doc, t)
    .filter((n) => n.m === m && n.ch === ch)
    .map((n) => n.inBeat);
}

describe('特徴', () => {
  it('16ビートとタム回しを見つける', () => {
    const f = chartFeatures(song());
    expect(f.has.hh16).toBe(true);
    expect(f.has.tom16).toBe(true);
    expect(f.has.leftPedal).toBe(false);
    expect(f.feel).toBe('16');
    expect(f.bpm).toBe(150);
  });
  it('フィルは小節の後半から', () => {
    const d = song();
    const fills = detectFills(drumNotes(d));
    expect([...fills.keys()].sort()).toEqual([3, 7]);
    expect(fills.get(3)).toBe(2);
  });
});

describe('簡略化', () => {
  it('段0はそのまま', () => {
    const d = song();
    const r = simplify({ doc: d, rung: 0, sections, keep: DEFAULT_KEEP });
    expect(r.notesAfter).toBe(r.notesBefore);
  });
  it('ADVANCED相当：HHは8分、ゴーストは消える、バックビートと1拍目は残る', () => {
    const r = simplify({ doc: song(), rung: 4, sections, keep: DEFAULT_KEEP });
    expect(at(r.doc, 1, CH.HHC)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(at(r.doc, 1, CH.SD)).toEqual([1, 3, 3.5]);
    expect(at(r.doc, 1, CH.BD)).toEqual([0, 2]);
    // フィルは8分に
    const fillToms = drumNotes(r.doc).filter((n) => n.m === 3 && n.inBeat >= 2 && n.ch !== CH.BD);
    expect(fillToms.map((n) => n.inBeat)).toEqual([2, 2.5, 3, 3.5]);
    // セクション頭のクラッシュ
    expect(at(r.doc, 4, CH.CY)).toEqual([0]);
  });
  it('BASIC相当：HHは4分、スネアは2・4拍', () => {
    const r = simplify({ doc: song(), rung: 6, sections, keep: DEFAULT_KEEP });
    expect(at(r.doc, 1, CH.HHC)).toEqual([0, 1, 2, 3]);
    expect(at(r.doc, 1, CH.SD)).toEqual([1, 3]);
    // 同時は2つまで（守るものは別）
    const t = buildTempoMap(r.doc);
    const ns = drumNotes(r.doc, t);
    const counts = new Map<number, number>();
    for (const n of ns) counts.set(Math.round(n.beat * 96), (counts.get(Math.round(n.beat * 96)) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });
  it('2・4拍にスネアが無いグルーヴでは、裏拍のスネアをバックビートとして残す', () => {
    // 実曲（ブレス・ユア・ブレス MASTER）の形：SD は16分の 3・6・9・11・14、BD は4分、ライドは4分
    const chips = [];
    let id = 1;
    for (let m = 0; m < 4; m++) {
      for (const k of [0, 4, 8, 12]) chips.push(chip(id++, CH.BD, m, k, 16), chip(id++, CH.RD, m, k, 16));
      for (const k of [3, 6, 9, 11, 14]) chips.push(chip(id++, CH.SD, m, k, 16));
      for (const k of [2, 6, 10, 14]) chips.push(chip(id++, CH.LP, m, k, 16));
    }
    const d: DtxDoc = { ...emptyDoc(), fields: { BPM: '152' }, chips, nextId: id };
    const sec = [{ name: 'A', from: 0, to: 3, shift: 0 }];
    // 人が作った BASIC と同じく、2拍目の裏と4拍目の裏だけ残る（拍で 1.5 と 3.5）
    expect(at(simplify({ doc: d, rung: 8, sections: sec, keep: DEFAULT_KEEP }).doc, 1, CH.SD)).toEqual([1.5, 3.5]);
    expect(at(simplify({ doc: d, rung: 6, sections: sec, keep: { ...DEFAULT_KEEP, backbeat: false } }).doc, 1, CH.SD)).toEqual([1.5, 3.5]);
    // ふつうの8ビートは今までどおり2・4拍
    expect(at(simplify({ doc: song(), rung: 8, sections, keep: DEFAULT_KEEP }).doc, 1, CH.SD)).toEqual([1, 3]);
  });
  it('同じ中身の小節は同じ結果', () => {
    const r = simplify({ doc: song(), rung: 5, sections, keep: DEFAULT_KEEP });
    const pat = (m: number) =>
      drumNotes(r.doc)
        .filter((n) => n.m === m)
        .map((n) => `${n.ch}@${n.inBeat}`)
        .join(',');
    expect(pat(1)).toBe(pat(5));
    expect(pat(2)).toBe(pat(6));
  });
  it('左バスドラムは右へ寄せる（同じ時刻なら1つ）', () => {
    const d: DtxDoc = { ...emptyDoc(), fields: { BPM: '120' }, chips: [chip(1, CH.LBD, 0, 1, 4), chip(2, CH.BD, 0, 0, 4), chip(3, CH.LBD, 0, 0, 4)], nextId: 9 };
    const r = simplify({ doc: d, rung: 4, sections: [], keep: DEFAULT_KEEP });
    expect(r.fate.get(1)).toEqual({ kind: 'moved', ch: CH.BD });
    expect(r.fate.get(3)?.kind).toBe('removed');
    expect(r.doc.chips.map((c) => c.ch).sort()).toEqual([CH.BD, CH.BD]);
  });
  it('手で直したものはそのとおり', () => {
    const d = song();
    const ghost = d.chips.find((c) => c.ch === CH.SD && c.m === 1 && c.f.n === 7)!;
    const r = simplify({ doc: d, rung: 6, sections, keep: DEFAULT_KEEP, overrides: new Map([[ghost.id, 'keep']]) });
    expect(r.fate.get(ghost.id)?.kind).toBe('kept');
  });
  it('目標のレベル帯まで段を動かす', () => {
    const d = song(16, 170);
    const g = generateToTarget({ doc: d, sections, keep: DEFAULT_KEEP }, 0, { min: 3.5, max: 4.6 });
    expect(g.level).toBeLessThanOrEqual(4.6);
    expect(g.tries.length).toBeGreaterThan(1);
    expect(g.rung).toBeGreaterThan(0);
  });
  it('段のあいだに目標があるときは4小節のうち何小節かだけ次の段にする', () => {
    const d = song(16, 170);
    // 段ごとのレベルを測って、差の大きい隣り合う段のあいだを狙う
    const lv = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => generateToTarget({ doc: d, sections, keep: DEFAULT_KEEP }, r, { min: 0, max: 99 }, 1).level);
    let r = 0;
    for (let i = 1; i < 8; i++) if (lv[i] - lv[i + 1] > lv[r] - lv[r + 1]) r = i;
    const mid = (lv[r] + lv[r + 1]) / 2;
    const g = generateToTarget({ doc: d, sections, keep: DEFAULT_KEEP }, r, { min: mid - 0.05, max: mid + 0.05 });
    expect(g.rung).toBe(r);
    expect(g.ease).toBeGreaterThan(0);
    expect(Math.abs(g.level - mid)).toBeLessThan(Math.min(lv[r] - mid, mid - lv[r + 1]));
  });
});

/**
 * 左右のシンバルを使う8ビート（作者の譜面によくある使い方）：右は4小節ごとの頭、左は2小節目の頭と食い、
 * 6小節目は左で8分の刻み。HH 8分（シンバルの所は抜く）、BD 1・3拍、SD 2・4拍
 */
function cymbalSong(): DtxDoc {
  const crash = new Map<string, number>();
  const put = (m: number, k: number, ch: number) => crash.set(`${m}:${k}`, ch);
  put(0, 0, CH.CY);
  put(2, 0, CH.LC); // 4小節ごとの頭ではない頭
  put(3, 7, CH.LC); // 食い：最後の8分の裏で、次の小節の頭にクラッシュが無い
  put(5, 3, CH.LC); // 裏のアクセント（食いではない）
  for (let k = 0; k < 8; k++) put(6, k, CH.LC); // 左で8分の刻み
  put(7, 0, CH.CY);
  const chips = [];
  let id = 1;
  for (let m = 0; m < 8; m++) {
    for (let k = 0; k < 8; k++) {
      chips.push(chip(id++, crash.get(`${m}:${k}`) ?? CH.HHC, m, k, 8));
      if (k === 0 || k === 4) chips.push(chip(id++, CH.BD, m, k, 8));
      if (k === 2 || k === 6) chips.push(chip(id++, CH.SD, m, k, 8));
    }
  }
  return { ...emptyDoc(), fields: { BPM: '140' }, chips, nextId: id };
}

/** 左右のシンバルを入れ替える */
function mirrorCymbals(doc: DtxDoc): DtxDoc {
  const sw = (ch: number) => (ch === CH.LC ? CH.CY : ch === CH.CY ? CH.LC : ch);
  return { ...doc, chips: doc.chips.map((c) => ({ ...c, ch: sw(c.ch) })) };
}

describe('左右のシンバル（同じ重さで扱う）', () => {
  const sec: SectionPlan[] = [{ name: 'A', from: 0, to: 7, shift: 0 }];
  const run = (rung: number, doc = cymbalSong()) => simplify({ doc, rung, sections: sec, keep: DEFAULT_KEEP });

  it('左シンバルは、いちばん易しい段でも右へ寄せない', () => {
    const d = cymbalSong();
    const lc = d.chips.filter((c) => c.ch === CH.LC).map((c) => c.id);
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      const r = run(rung, d);
      expect(lc.map((id) => r.fate.get(id)?.kind)).not.toContain('moved');
      expect(r.doc.chips.filter((c) => c.ch === CH.LC).length).toBeGreaterThan(0);
    }
    for (const p of LADDER) expect(describePolicy(p)).not.toContain('左シンバル');
  });

  it('小節の頭のクラッシュは、4小節ごとの頭でなくても残す', () => {
    const r = run(MAX_RUNG);
    expect(at(r.doc, 0, CH.CY)).toEqual([0]);
    expect(at(r.doc, 2, CH.LC)).toEqual([0]);
    expect(at(r.doc, 7, CH.CY)).toEqual([0]);
  });

  it('食い（最後の8分の裏で、次の頭にクラッシュが無い）は残し、ほかの裏のクラッシュは易しい段で消す', () => {
    expect([...crashStarts(drumNotes(cymbalSong()))].length).toBe(5);
    for (const rung of [6, 8, MAX_RUNG]) {
      const r = run(rung);
      expect(at(r.doc, 3, CH.LC)).toEqual([3.5]);
      expect(at(r.doc, 5, CH.LC)).toEqual([]);
    }
    // ADVANCED あたりまでは裏のアクセントも残る
    expect(at(run(4).doc, 5, CH.LC)).toEqual([1.5]);
  });

  it('シンバルの刻みは、段6・7 では4分で残し、もっと易しい段では頭だけ', () => {
    expect(at(run(6).doc, 6, CH.LC)).toEqual([0, 1, 2, 3]);
    expect(at(run(7).doc, 6, CH.LC)).toEqual([0, 1, 2, 3]);
    expect(at(run(8).doc, 6, CH.LC)).toEqual([0]);
  });

  it('フィルの終わりの食いのクラッシュは、易しい段でも残す', () => {
    const chips = [];
    let id = 1;
    for (let m = 0; m < 3; m++) {
      for (let k = 0; k < 16; k += 2) {
        const fill = m === 1 && k >= 8;
        if (!fill) chips.push(chip(id++, CH.HHC, m, k, 16));
        if (k === 0 || k === 8) chips.push(chip(id++, CH.BD, m, k, 16));
        if (!fill && (k === 4 || k === 12)) chips.push(chip(id++, CH.SD, m, k, 16));
      }
    }
    // 1小節目の後半はタム回し、最後の8分の裏で左のクラッシュ（次の小節の頭にはクラッシュなし）
    for (const k of [8, 9, 10, 11, 12, 13]) chips.push(chip(id++, k < 10 ? CH.SD : k < 12 ? CH.HT : CH.LT, 1, k, 16));
    chips.push(chip(id++, CH.LC, 1, 14, 16), chip(id++, CH.BD, 1, 14, 16));
    const d: DtxDoc = { ...emptyDoc(), fields: { BPM: '140' }, chips, nextId: id };
    expect(detectFills(drumNotes(d)).has(1)).toBe(true);
    const r = simplify({ doc: d, rung: MAX_RUNG, sections: [{ name: 'A', from: 0, to: 2, shift: 0 }], keep: DEFAULT_KEEP });
    expect(at(r.doc, 1, CH.LC)).toEqual([3.5]);
  });

  it('左右を入れ替えた譜面は、左右を入れ替えた結果になる', () => {
    const key = (doc: DtxDoc, swap: boolean) =>
      drumNotes(doc)
        .filter((n) => n.ch === CH.LC || n.ch === CH.CY)
        .map((n) => `${n.m}:${n.inBeat}:${swap ? (n.ch === CH.LC ? 'R' : 'L') : n.ch === CH.LC ? 'L' : 'R'}`)
        .sort();
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      expect(key(run(rung, mirrorCymbals(cymbalSong())).doc, true)).toEqual(key(run(rung).doc, false));
    }
  });
});
