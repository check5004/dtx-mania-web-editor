import { describe, expect, it } from 'vitest';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { chartFeatures, drumNotes } from './features';
import { crashStarts, DEFAULT_KEEP, describePolicy, detectFills, generateToTarget, levelOfDoc, MAX_RUNG, policyFor, simplify, type SectionPlan } from './simplify';
import { metricOf, rungOf, stepOrder, STEP_KEYS } from './reduce';
import { keptIds } from './stairs';

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

const pattern = (doc: DtxDoc, m: number) =>
  drumNotes(doc)
    .filter((n) => n.m === m)
    .map((n) => `${n.ch}@${n.inBeat}`)
    .join(',');

describe('簡略化', () => {
  it('段0はそのまま', () => {
    const d = song();
    const r = simplify({ doc: d, rung: 0, sections, keep: DEFAULT_KEEP });
    expect(r.notesAfter).toBe(r.notesBefore);
  });
  it('16分を省いた段：刻みは8分、ゴーストとバスドラムの16分は消え、バックビートと1拍目は残る。フィルは8分に', () => {
    const r = simplify({ doc: song(), rung: rungOf('fill16'), sections, keep: DEFAULT_KEEP });
    expect(at(r.doc, 1, CH.HHC)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(at(r.doc, 1, CH.SD)).toEqual([1, 3, 3.5]);
    expect(at(r.doc, 1, CH.BD)).toEqual([0, 2]);
    const fillToms = drumNotes(r.doc).filter((n) => n.m === 3 && n.inBeat >= 2 && n.ch !== CH.BD);
    expect(fillToms.map((n) => n.inBeat)).toEqual([2, 2.5, 3, 3.5]);
    // セクション頭のクラッシュ
    expect(at(r.doc, 4, CH.CY)).toEqual([0]);
  });
  it('刻みの8分とスネアの8分の裏まで省いた段：刻みは4分、スネアは2・4拍、同時打ちは2つまで', () => {
    const r = simplify({ doc: song(), rung: rungOf('snare8p'), sections, keep: DEFAULT_KEEP });
    expect(at(r.doc, 1, CH.HHC)).toEqual([0, 1, 2, 3]);
    expect(at(r.doc, 1, CH.SD)).toEqual([1, 3]);
    const counts = new Map<number, number>();
    for (const n of drumNotes(r.doc)) counts.set(Math.round(n.beat * 96), (counts.get(Math.round(n.beat * 96)) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
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
    expect(at(simplify({ doc: d, rung: MAX_RUNG, sections: sec, keep: DEFAULT_KEEP }).doc, 1, CH.SD)).toEqual([1.5, 3.5]);
    // 必ず残すものに入れなくても、8分のシンコペーション（次の拍に続かない裏の一打）は最後の段まで残す
    expect(at(simplify({ doc: d, rung: rungOf('snare8s') - 1, sections: sec, keep: { ...DEFAULT_KEEP, backbeat: false } }).doc, 1, CH.SD)).toEqual([1.5, 3.5]);
    // ふつうの8ビートは2・4拍
    expect(at(simplify({ doc: song(), rung: MAX_RUNG, sections, keep: DEFAULT_KEEP }).doc, 1, CH.SD)).toEqual([1, 3]);
  });
  it('左バスドラムは右へ寄せる（同じ時刻なら1つ）', () => {
    const d: DtxDoc = { ...emptyDoc(), fields: { BPM: '120' }, chips: [chip(1, CH.LBD, 0, 1, 4), chip(2, CH.BD, 0, 0, 4), chip(3, CH.LBD, 0, 0, 4)], nextId: 9 };
    const r = simplify({ doc: d, rung: rungOf('leftFoot', true), sections: [], keep: DEFAULT_KEEP });
    expect(r.fate.get(1)).toEqual({ kind: 'moved', ch: CH.BD });
    expect(r.fate.get(3)?.kind).toBe('removed');
    expect(r.doc.chips.map((c) => c.ch).sort()).toEqual([CH.BD, CH.BD]);
    // その前の段では左のまま
    expect(simplify({ doc: d, rung: rungOf('leftFoot', true) - 1, sections: [], keep: DEFAULT_KEEP }).fate.get(1)).toEqual({ kind: 'kept' });
  });
  it('手で直したものはそのとおり', () => {
    const d = song();
    const ghost = d.chips.find((c) => c.ch === CH.SD && c.m === 1 && c.f.n === 7)!;
    const r = simplify({ doc: d, rung: MAX_RUNG, sections, keep: DEFAULT_KEEP, overrides: new Map([[ghost.id, 'keep']]) });
    expect(r.fate.get(ghost.id)?.kind).toBe('kept');
  });
  it('目標のレベル帯まで段を動かす（セクションの役割が無ければ、曲全体を同じ段に）', () => {
    const d = song(16, 170);
    const g = generateToTarget({ doc: d, sections, keep: DEFAULT_KEEP }, { min: 3.5, max: 4.6 });
    expect(g.level).toBeLessThanOrEqual(4.6);
    expect(g.tries.length).toBeGreaterThan(1);
    expect(g.rung).toBeGreaterThan(0);
    expect(g.ease).toBe(0);
  });
  it('セクションの役割があるときだけ、段のあいだの目標には静かなセクションから次の段を当てる（山場はそのまま）', () => {
    const d = song(16, 170);
    const roles: SectionPlan[] = [
      { name: 'A', from: 0, to: 7, shift: 1 },
      { name: 'B', from: 8, to: 15, shift: -1 },
    ];
    // 段ごとのレベルを測って、差の大きい隣り合う段のあいだを狙う
    const lv = Array.from({ length: MAX_RUNG + 1 }, (_, r) => levelOfDoc(simplify({ doc: d, rung: r, sections: roles, keep: DEFAULT_KEEP }).doc));
    let r = 0;
    for (let i = 1; i < MAX_RUNG; i++) if (lv[i] - lv[i + 1] > lv[r] - lv[r + 1]) r = i;
    const mid = (lv[r] + lv[r + 1]) / 2;
    const target = { min: mid - 0.05, max: mid + 0.05 };
    const g = generateToTarget({ doc: d, sections: roles, keep: DEFAULT_KEEP }, target);
    expect(g.rung).toBe(r);
    expect(g.ease).toBeGreaterThan(0);
    expect(Math.abs(g.level - mid)).toBeLessThan(Math.min(lv[r] - mid, mid - lv[r + 1]));
    const cur = simplify({ doc: d, rung: r, sections: roles, keep: DEFAULT_KEEP }).doc;
    const next = simplify({ doc: d, rung: r + 1, sections: roles, keep: DEFAULT_KEEP }).doc;
    for (let m = 0; m < 8; m++) expect(pattern(g.doc, m)).toBe(pattern(next, m));
    for (let m = 8; m < 16; m++) expect(pattern(g.doc, m)).toBe(pattern(cur, m));
    // 役割が無ければ、同じ目標でも段だけで合わせる
    expect(generateToTarget({ doc: d, sections, keep: DEFAULT_KEEP }, target).ease).toBe(0);
  });
});

describe('曲全体で一貫して省く（楯さんの指摘: 目立つバスドラムまで削る・場所によって削る楽器が違う）', () => {
  it('省く順番は1本で、どの種類も1回だけ。速い曲は刻みの8分の裏をバスドラムの8分より先に、遅い曲は後に', () => {
    for (const slow of [false, true]) {
      const order = stepOrder(slow);
      expect([...order].sort()).toEqual([...STEP_KEYS].sort());
    }
    expect(rungOf('time8')).toBeLessThan(rungOf('kick8p'));
    expect(rungOf('time8', true)).toBeGreaterThan(rungOf('kick8s', true));
    expect(rungOf('time8', true)).toBeLessThan(rungOf('snare8p', true));
  });

  it('拍の強さ：小節の頭 > 3拍目 > 2・4拍 > 8分の裏 > 16分の裏', () => {
    const m = (inBeat: number, mBeats = 4) => metricOf({ inBeat, mBeats });
    expect([0, 2, 1, 3, 0.5, 2.5, 0.25, 1.75, 1 / 3, 1 / 6, 0.125].map((x) => m(x))).toEqual([4, 3, 2, 2, 1, 1, 0, 0, 1, 0, -1]);
    // 3拍子の小節には「真ん中の拍」は無い
    expect(m(1, 3)).toBe(2);
  });

  it('同じ中身の小節は、どの段でも同じ結果（同じ役割の音は、曲のどこにあっても同じ扱い）', () => {
    const d = song();
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      const r = simplify({ doc: d, rung, sections, keep: DEFAULT_KEEP });
      for (const m of [0, 1, 2, 3]) expect(pattern(r.doc, m + 4), `段 ${rung} の小節 ${m}`).toBe(pattern(r.doc, m));
    }
  });

  it('どの段も、ひとつ前の段の音の一部だけ（段を進めて、省いた音が戻ることはない）', () => {
    const roles: SectionPlan[] = [
      { name: 'A', from: 0, to: 3, shift: 1 },
      { name: 'B', from: 4, to: 7, shift: 0 },
    ];
    for (const doc of [song(), cymbalSong(), kimeSong()]) {
      let prev: Set<number> | null = null;
      for (let rung = 0; rung <= MAX_RUNG; rung++) {
        for (let ease = 0; ease <= 2; ease++) {
          if (rung === MAX_RUNG && ease) continue;
          const kept = keptIds(simplify({ doc, rung, ease, sections: roles, keep: DEFAULT_KEEP }).fate);
          if (prev) for (const id of kept) expect(prev.has(id), `段 ${rung}+${ease}`).toBe(true);
          prev = kept;
        }
      }
    }
  });

  /**
   * キメのある8ビート（140BPM）：HH 8分、BD 1・3拍と3拍目の裏（2.5）、SD 2・4拍。
   * 0小節目の頭はクラッシュ＋バスドラム＋スネア、1小節目の最後の8分の裏は食いのクラッシュ＋バスドラム（2小節目の頭にクラッシュなし）、
   * 3小節目の2拍目の裏はキメのクラッシュ＋バスドラム
   */
  function kimeSong(): DtxDoc {
    const chips = [];
    let id = 1;
    for (let m = 0; m < 4; m++) {
      for (let k = 0; k < 8; k++) {
        const crash = (m === 0 && k === 0) || (m === 1 && k === 7) || (m === 3 && k === 3);
        chips.push(chip(id++, crash ? CH.CY : CH.HHC, m, k, 8));
        if (k === 0 || k === 4 || k === 5 || crash) chips.push(chip(id++, CH.BD, m, k, 8));
        if (k === 2 || k === 6 || (m === 0 && k === 0)) chips.push(chip(id++, CH.SD, m, k, 8));
      }
    }
    return { ...emptyDoc(), fields: { BPM: '140' }, chips, nextId: id };
  }
  const sec: SectionPlan[] = [{ name: 'A', from: 0, to: 3, shift: 0 }];
  const runKime = (rung: number) => simplify({ doc: kimeSong(), rung, sections: sec, keep: DEFAULT_KEEP }).doc;

  it('小節の頭と食いのクラッシュに合わせたバスドラムは、どの段でも残す', () => {
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      const d = runKime(rung);
      expect(at(d, 1, CH.BD), `段 ${rung}`).toContain(3.5);
      expect(at(d, 1, CH.CY), `段 ${rung}`).toEqual([3.5]);
      for (const m of [0, 1, 2, 3]) expect(at(d, m, CH.BD)[0], `段 ${rung}`).toBe(0);
    }
  });

  it('ほかのキメ（裏のクラッシュとバスドラム）は「キメ」の段まで、クラッシュといっしょに残す', () => {
    expect(at(runKime(rungOf('kime') - 1), 3, CH.BD)).toContain(1.5);
    expect(at(runKime(rungOf('kime') - 1), 3, CH.CY)).toEqual([1.5]);
    expect(at(runKime(rungOf('kime')), 3, CH.BD)).not.toContain(1.5);
    expect(at(runKime(rungOf('kime')), 3, CH.CY)).toEqual([]);
  });

  it('バスドラムの8分の裏は、曲のどこでも同じ段で省く', () => {
    const before = runKime(rungOf('kick8p') - 1);
    const after = runKime(rungOf('kick8p'));
    for (const m of [0, 1, 2, 3]) {
      expect(at(before, m, CH.BD)).toContain(2.5);
      expect(at(after, m, CH.BD)).not.toContain(2.5);
    }
  });

  it('同時打ちを2つにする段でも、キメ（クラッシュ＋バスドラム＋スネア）は3つのまま残す', () => {
    const d = runKime(rungOf('chord'));
    expect(drumNotes(d).filter((n) => n.m === 0 && n.inBeat === 0).length).toBe(3);
  });

  it('4つ打ちの2・4拍（バスドラム＋スネア＋ハイハット）は、同時打ちを2つにする段でハイハットを抜き、バスドラムを残す', () => {
    const chips = [];
    let id = 1;
    for (let m = 0; m < 4; m++) {
      for (let k = 0; k < 8; k++) {
        chips.push(chip(id++, CH.HHC, m, k, 8));
        if (k % 2 === 0) chips.push(chip(id++, CH.BD, m, k, 8));
        if (k === 2 || k === 6) chips.push(chip(id++, CH.SD, m, k, 8));
      }
    }
    const d: DtxDoc = { ...emptyDoc(), fields: { BPM: '128' }, chips, nextId: id };
    const r = simplify({ doc: d, rung: rungOf('chord', true), sections: sec, keep: DEFAULT_KEEP }).doc;
    expect(at(r, 1, CH.BD)).toEqual([0, 1, 2, 3]);
    expect(at(r, 1, CH.SD)).toEqual([1, 3]);
    expect(at(r, 1, CH.HHC)).toEqual([0, 0.5, 1.5, 2, 2.5, 3.5]);
    // その前の段では3つ同時のまま（作者の譜面でも、EXTREME では3つ同時を残す）
    expect(at(simplify({ doc: d, rung: rungOf('chord', true) - 1, sections: sec, keep: DEFAULT_KEEP }).doc, 1, CH.HHC)).toContain(1);
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
    for (let rung = 0; rung <= MAX_RUNG; rung++) expect(describePolicy(policyFor(rung))).not.toContain('左シンバル');
  });

  it('小節の頭のクラッシュは、4小節ごとの頭でなくても残す', () => {
    const r = run(MAX_RUNG);
    expect(at(r.doc, 0, CH.CY)).toEqual([0]);
    expect(at(r.doc, 2, CH.LC)).toEqual([0]);
    expect(at(r.doc, 7, CH.CY)).toEqual([0]);
  });

  it('食い（最後の8分の裏で、次の頭にクラッシュが無い）はどの段でも残し、ほかの裏のクラッシュは「キメ」の段で消す', () => {
    expect([...crashStarts(drumNotes(cymbalSong()))].length).toBe(5);
    for (const rung of [rungOf('kime'), MAX_RUNG]) {
      const r = run(rung);
      expect(at(r.doc, 3, CH.LC)).toEqual([3.5]);
      expect(at(r.doc, 5, CH.LC)).toEqual([]);
    }
    // その前の段までは裏のアクセントも残る
    for (const rung of [rungOf('time8'), rungOf('kime') - 1]) expect(at(run(rung).doc, 5, CH.LC)).toEqual([1.5]);
    expect(at(run(rungOf('kime') - 1).doc, 3, CH.LC)).toEqual([3.5]);
  });

  it('シンバルの刻みは、ハイハットと同じ細かさ（8分 → 4分 → 1・3拍）で、同じ段で粗くする', () => {
    expect(at(run(rungOf('time8') - 1).doc, 6, CH.LC)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(at(run(rungOf('time8')).doc, 6, CH.LC)).toEqual([0, 1, 2, 3]);
    expect(at(run(rungOf('time8')).doc, 1, CH.HHC)).toEqual([0, 1, 2, 3]);
    expect(at(run(rungOf('time24') - 1).doc, 6, CH.LC)).toEqual([0, 1, 2, 3]);
    expect(at(run(rungOf('time24')).doc, 6, CH.LC)).toEqual([0, 2]);
    expect(at(run(rungOf('time24')).doc, 1, CH.HHC)).toEqual([0, 2]);
    expect(at(run(MAX_RUNG).doc, 6, CH.LC)).toEqual([0, 2]);
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

describe('楽器・奏法を置き換えない（易しくするのは間引くことだけ）', () => {
  const sec: SectionPlan[] = [{ name: 'A', from: 0, to: 3, shift: 0 }];

  /** 8分の刻みの8ビート。ride なら刻みはライド、そうでなければ HH で、2拍目の頭と4拍目の裏はオープンHH */
  function groove(ride: boolean): DtxDoc {
    const chips = [];
    let id = 1;
    for (let m = 0; m < 4; m++) {
      for (let k = 0; k < 8; k++) {
        chips.push(chip(id++, ride ? CH.RD : k === 2 || k === 7 ? CH.HHO : CH.HHC, m, k, 8));
        if (k === 0 || k === 4) chips.push(chip(id++, CH.BD, m, k, 8));
        if (k === 2 || k === 6) chips.push(chip(id++, CH.SD, m, k, 8));
      }
    }
    return { ...emptyDoc(), fields: { BPM: '140' }, chips, nextId: id };
  }
  const rideSong = () => groove(true);
  const hhSong = () => groove(false);

  it('ライドはどの段でもライドのまま、ハイハットと同じ細かさまで残す', () => {
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      const r = simplify({ doc: rideSong(), rung, sections: sec, keep: DEFAULT_KEEP });
      expect(r.doc.chips.some((c) => c.ch === CH.HHC)).toBe(false);
    }
    expect(at(simplify({ doc: rideSong(), rung: rungOf('time8'), sections: sec, keep: DEFAULT_KEEP }).doc, 1, CH.RD)).toEqual([0, 1, 2, 3]);
    expect(at(simplify({ doc: rideSong(), rung: rungOf('time24'), sections: sec, keep: DEFAULT_KEEP }).doc, 1, CH.RD)).toEqual([0, 2]);
  });

  it('オープンHHはどの段でもオープンのまま。「オープンHHのアクセント」を必ず残すなら8分の位置も残す', () => {
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      const r = simplify({ doc: hhSong(), rung, sections: sec, keep: DEFAULT_KEEP });
      expect(at(r.doc, 1, CH.HHC)).not.toContain(1);
    }
    const r6 = simplify({ doc: hhSong(), rung: rungOf('time8'), sections: sec, keep: DEFAULT_KEEP });
    expect(at(r6.doc, 1, CH.HHO)).toEqual([1]);
    expect(at(r6.doc, 1, CH.HHC)).toEqual([0, 2, 3]);
    // 必ず残すもの「オープンHHのアクセント」では、4拍目の裏も残る
    expect(at(simplify({ doc: hhSong(), rung: rungOf('time8'), sections: sec, keep: { ...DEFAULT_KEEP, openHH: true } }).doc, 1, CH.HHO)).toEqual([1, 3.5]);
  });

  it('チップのレーンを変えるのは、左バスドラムを右バスドラムへ寄せるときだけ', () => {
    // 全部の楽器を使う4小節（ツーバス・左足HH・ライド・オープンHH・左右のシンバル・タムのフィル）
    const chips = [];
    let id = 1;
    for (let m = 0; m < 4; m++) {
      for (let k = 0; k < 16; k++) {
        const fill = m === 3 && k >= 8;
        if (!fill) chips.push(chip(id++, m >= 2 ? (k % 2 === 0 ? CH.RD : CH.HHC) : k % 8 === 6 ? CH.HHO : CH.HHC, m, k, 16));
        if (k % 4 === 0) chips.push(chip(id++, CH.BD, m, k, 16));
        if (k % 4 === 2) chips.push(chip(id++, CH.LBD, m, k, 16));
        if (k === 4 || k === 12) chips.push(chip(id++, fill ? CH.LT : CH.SD, m, k, 16), chip(id++, CH.LP, m, k, 16));
        if (fill) chips.push(chip(id++, k < 12 ? CH.HT : CH.FT, m, k, 16));
      }
      chips.push(chip(id++, m % 2 ? CH.LC : CH.CY, m, 0, 1));
    }
    const d: DtxDoc = { ...emptyDoc(), fields: { BPM: '150' }, chips, nextId: id };
    const chOf = new Map(d.chips.map((c) => [c.id, c.ch]));
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      for (let ease = 0; ease <= 2; ease++) {
        const r = simplify({ doc: d, rung, ease, sections: sec, keep: DEFAULT_KEEP });
        for (const [id, f] of r.fate) if (f.kind === 'moved') expect([chOf.get(id), f.ch]).toEqual([CH.LBD, CH.BD]);
      }
    }
  });
});
