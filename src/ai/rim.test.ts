// AI の格子と採譜の下書きで、スネアのリム（RM）をスネアと分けて扱う
import { describe, expect, it } from 'vitest';
import { CH } from '../dtx/model';
import { parseDtx } from '../dtx/parse';
import { buildTempoMap } from '../dtx/timing';
import { draftFromHits, learnStyle, styleLines } from '../assist/draft';
import { buildContext, decodeCandidates, enforcePlayable, measureGrid, phrasePrompt, ruleCandidates } from './phrase';
import { frac } from '../dtx/fraction';

// 小節 0〜2: バラードのクロススティック（2・4拍目がリム）。小節 1 だけ 4拍目をスネアで締める
const text = [
  '#BPM: 120',
  '#WAV01: bd.wav',
  '#WAV02: 039_Snare.ogg\t;Snare',
  '#WAV0W: 039_Snare.ogg\t;Snare Rim',
  '#00013: 01000100',
  '#00012: 000W000W',
  '#00113: 01000100',
  '#00112: 000W0002',
  '#00213: 01000100',
  '#00212: 000W000W',
].join('\n');
const { doc } = parseDtx(text);
const tempo = buildTempoMap(doc);

describe('AI の格子のリム', () => {
  it('スネアのレーンでリムの音のチップは RM の行', () => {
    expect(measureGrid(doc, tempo, 0).lines).toEqual(['RM: ----|x---|----|x---', 'BD: x---|----|x---|----']);
    expect(measureGrid(doc, tempo, 1).lines).toEqual(['SD: ----|----|----|x---', 'RM: ----|x---|----|----', 'BD: x---|----|x---|----']);
  });

  it('プロンプトに RM の説明（スネアと入れ替えない）', () => {
    const ctx = buildContext(doc, tempo, { kind: 'fill', from: 3, to: 3, instruction: '', targetLevel: null, onsets: null, offsetSec: 0 });
    const p = phrasePrompt(ctx);
    expect(p.system).toContain('RM=スネアのリム');
    expect(p.system).toContain('入れ替えないでください');
    expect(p.user).toContain('RM: ----|x---|----|x---');
  });

  it('AI の答えの RM はスネアのチャンネルでリムの印', () => {
    const c = decodeCandidates({ candidates: [{ name: 'a', reason: 'b', measures: [{ index: 0, lanes: [{ lane: 'RM', steps: '----|x---|----|x---' }, { lane: 'SD', steps: 'x---|----|----|----' }] }] }] }, { from: 3, to: 3 }, tempo);
    const notes = c[0].notes.map((n) => `${n.ch}${n.rim ? 'r' : ''}@${n.f.n}/${n.f.d}`).sort();
    expect(notes).toEqual([`${CH.SD}@0/1`, `${CH.SD}r@1/4`, `${CH.SD}r@3/4`].sort());
  });

  it('同じ位置のスネアとリムは1つだけ（同じ太鼓）', () => {
    const r = enforcePlayable([
      { ch: CH.SD, m: 0, f: frac(0), rim: true },
      { ch: CH.SD, m: 0, f: frac(0) },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].rim).toBe(true);
  });

  it('キーが無いときの複製もリムのまま', () => {
    const c = ruleCandidates(doc, tempo, { from: 3, to: 3, onsets: null, offsetSec: 0, lastMeasure: 2 });
    const prev = c.find((x) => x.source === 'prev')!;
    expect(prev.notes.filter((n) => n.ch === CH.SD).map((n) => n.rim)).toEqual([true, true]);
  });
});

describe('採譜の下書きのリム', () => {
  const hit = (m: number, step: number) => ({ t: tempo.beatToSec(tempo.measureStart(m) + step / 4), cls: 'SD' as const, s: 0.9 });

  it('前後の小節で作者がリムで書いている位置はリム', () => {
    const style = learnStyle(doc, tempo, 3, 3);
    const notes = draftFromHits([hit(3, 4), hit(3, 12)], tempo, 3, 3, style);
    expect(notes.map((n) => [n.ch, !!n.rim])).toEqual([
      [CH.SD, true],
      [CH.SD, true],
    ]);
    // 作者がスネアを書いていない位置（1拍目）は、リムだけの曲でもないのでスネア
    expect(draftFromHits([hit(3, 0)], tempo, 3, 3, style)[0].rim).toBeUndefined();
    expect(styleLines(style)).toContain('スネアとリム: SD 17%・RM 83%');
  });

  it('リムを書いていない曲では、いつもスネア', () => {
    const plain = parseDtx(['#BPM: 120', '#WAV02: 039_Snare.ogg', '#00012: 00020002'].join('\n')).doc;
    const t = buildTempoMap(plain);
    const notes = draftFromHits([{ t: t.beatToSec(t.measureStart(1) + 1), cls: 'SD', s: 0.9 }], t, 1, 1, learnStyle(plain, t, 1, 1));
    expect(notes.map((n) => n.rim)).toEqual([undefined]);
  });
});
