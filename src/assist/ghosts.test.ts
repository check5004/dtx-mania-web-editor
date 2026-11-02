import { describe, expect, it } from 'vitest';
import { analyzeAudio } from '../audio/analysis';
import { eightBeat, synth } from '../audio/testSignal';
import { frac } from '../dtx/fraction';
import { CH, emptyDoc, type DtxDoc } from '../dtx/model';
import { buildTempoMap } from '../dtx/timing';
import { classifyEvents, detectEvents, placeGhosts, type GhostLane } from './ghosts';

const SR = 44100;
const hits = eightBeat(120, 8, 0.5);
const data = analyzeAudio([synth(hits, SR, 18)], SR);
const all: Record<GhostLane, boolean> = { BD: true, SD: true, HH: true, CY: true };

function doc120(): DtxDoc {
  const d = emptyDoc();
  d.fields['BPM'] = '120';
  return d;
}

// 原曲の 0.5 秒（最初の小節頭）が譜面の小節001の頭（2.0秒）に来るよう、BGM は 1.5 秒から鳴らす
const OFFSET = 1.5;

describe('候補チップ', () => {
  const classified = classifyEvents(detectEvents(data, 0.5));

  it('キックはバスドラム、スネアはスネア、ハイハットはハイハットの候補になる', () => {
    const doc = doc120();
    const g = placeGhosts(classified, doc, buildTempoMap(doc), { offsetSec: OFFSET, div: 16, lanes: all, dismissed: new Set() });
    const at = (lane: GhostLane) => g.filter((x) => x.ghostLane === lane).map((x) => `${x.pos.m}:${x.pos.f.n}/${x.pos.f.d}`);
    const bd = at('BD');
    const sd = at('SD');
    // 1小節に3つのキック（1拍目・3拍目・3拍目裏）
    expect(bd.length).toBe(8 * 3);
    for (let m = 1; m <= 8; m++) {
      expect(bd).toContain(`${m}:0/1`);
      expect(bd).toContain(`${m}:1/2`);
      expect(bd).toContain(`${m}:5/8`);
      expect(sd).toContain(`${m}:1/4`);
      expect(sd).toContain(`${m}:3/4`);
    }
    // キックの中域への漏れはスネアにしない
    expect(sd.length).toBe(8 * 2);
    // ハイハットとシンバル（4小節ごとのクラッシュ）
    const hh = at('HH');
    const cy = at('CY');
    expect(cy).toContain('1:0/1');
    expect(cy).toContain('5:0/1');
    // キックと重なるハイハットをシンバルと間違えない
    expect(cy.length).toBeLessThanOrEqual(3);
    expect(hh.length + cy.length).toBeGreaterThanOrEqual(8 * 8 * 0.85);
  });

  it('置いてあるチップと捨てた候補は出さない', () => {
    const doc = doc120();
    doc.chips.push({ id: doc.nextId++, ch: CH.BD, m: 1, f: frac(0), v: 1 });
    doc.chips.push({ id: doc.nextId++, ch: CH.HT, m: 1, f: frac(1, 4), v: 1 });
    const tempo = buildTempoMap(doc);
    const g = placeGhosts(classified, doc, tempo, { offsetSec: OFFSET, div: 16, lanes: all, dismissed: new Set(['BD:1:1/2']) });
    const keys = new Set(g.map((x) => x.key));
    expect(keys.has('BD:1:0/1')).toBe(false);
    // タムを置いた所のスネア候補も「置いてある」とみなす
    expect(keys.has('SD:1:1/4')).toBe(false);
    expect(keys.has('BD:1:1/2')).toBe(false);
    expect(keys.has('BD:1:5/8')).toBe(true);
  });

  it('レーンを絞れる', () => {
    const doc = doc120();
    const g = placeGhosts(classified, doc, buildTempoMap(doc), { offsetSec: OFFSET, div: 16, lanes: { ...all, HH: false, CY: false }, dismissed: new Set() });
    expect(g.every((x) => x.ghostLane === 'BD' || x.ghostLane === 'SD')).toBe(true);
  });
});
