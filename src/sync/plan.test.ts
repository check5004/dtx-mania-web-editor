import { describe, expect, it } from 'vitest';
import { needsMd5, planSong, type Act, type BaseRec, type LocalStat, type RemoteStat } from './plan';

const L = (path: string, md5: string, mtime = 100, size = 10): LocalStat => ({ path, md5, mtime, size });
const R = (path: string, md5: string, time = 100, size = 10): RemoteStat => ({ id: `id-${path}`, path, md5, size, time });
const B = (path: string, md5: string, mtime = 100, size = 10): BaseRec => ({ id: `id-${path}`, path, md5, mtime, size });

function plan(local: LocalStat[], remote: RemoteStat[], recs: BaseRec[], o: Parameters<typeof planSong>[3] = { first: false }) {
  const acts = planSong(new Map(local.map((l) => [l.path.toLowerCase(), l])), new Map(remote.map((r) => [r.path.toLowerCase(), r])), Object.fromEntries(recs.map((r) => [r.path.toLowerCase(), r])), o);
  return Object.fromEntries(acts.map((a: Act) => [a.key, a.op === 'ask' ? `ask:${a.why}` : a.op]));
}

describe('1 曲のファイルをどうするか（3 つを比べる）', () => {
  it('片方だけ変わった・足した物はそちらに合わせる', () => {
    expect(
      plan(
        [L('same.dtx', 'A'), L('mine.dtx', 'B2', 200), L('theirs.dtx', 'C'), L('new-here.ogg', 'N')],
        [R('same.dtx', 'A'), R('mine.dtx', 'B'), R('theirs.dtx', 'C2'), R('new-there.ogg', 'M')],
        [B('same.dtx', 'A'), B('mine.dtx', 'B'), B('theirs.dtx', 'C')],
      ),
    ).toEqual({ 'same.dtx': 'same', 'mine.dtx': 'up', 'theirs.dtx': 'down', 'new-here.ogg': 'up', 'new-there.ogg': 'down' });
  });
  it('両方で直した作るファイルは新しい方（同じ時刻なら Drive）', () => {
    expect(
      plan(
        [L('adv.dtx', 'X1', 500), L('ext.dtx', 'Y1', 300), L('bsc.dtx', 'Z1', 300)],
        [R('adv.dtx', 'X2', 400), R('ext.dtx', 'Y2', 600), R('bsc.dtx', 'Z2', 300)],
        [B('adv.dtx', 'X0'), B('ext.dtx', 'Y0'), B('bsc.dtx', 'Z0')],
      ),
    ).toEqual({ 'adv.dtx': 'keepLocal', 'ext.dtx': 'keepRemote', 'bsc.dtx': 'keepRemote' });
  });
  it('両方で同じ中身になったら記録だけ', () => {
    expect(plan([L('a.dtx', 'S', 200)], [R('a.dtx', 'S', 300)], [B('a.dtx', 'OLD')])).toEqual({ 'a.dtx': 'same' });
  });
  it('両方で遊んだ成績はまとめる（ゴーストは節を取った方から）', () => {
    expect(
      plan(
        [L('mstr.dtx.score.ini', 'S1', 200), L('mstr.dtx.hiscore.dr.ghost', 'G1', 200)],
        [R('mstr.dtx.score.ini', 'S2', 300), R('mstr.dtx.hiscore.dr.ghost', 'G2', 300)],
        [B('mstr.dtx.score.ini', 'S0'), B('mstr.dtx.hiscore.dr.ghost', 'G0')],
      ),
    ).toEqual({ 'mstr.dtx.score.ini': 'merge', 'mstr.dtx.hiscore.dr.ghost': 'ghost' });
  });
  it('この PC で消した作るファイルは Drive でもゴミ箱へ、ほかの PC で消した物はこの PC でも消す（前のままなら）', () => {
    expect(
      plan(
        [L('gone-there.ogg', 'A'), L('edited-here.ogg', 'B2', 300)],
        [R('gone-here.ogg', 'C'), R('edited-there.ogg', 'D2', 300)],
        [B('gone-there.ogg', 'A'), B('edited-here.ogg', 'B'), B('gone-here.ogg', 'C'), B('edited-there.ogg', 'D'), B('both-gone.ogg', 'E')],
      ),
    ).toEqual({ 'gone-there.ogg': 'delete', 'edited-here.ogg': 'up', 'gone-here.ogg': 'trash', 'edited-there.ogg': 'down', 'both-gone.ogg': 'drop' });
  });
  it('成績は消さない（消えていたら取り直す・送り直す）', () => {
    expect(plan([L('a.dtx.score.ini', 'S')], [R('b.dtx.score.ini', 'T')], [B('a.dtx.score.ini', 'S'), B('b.dtx.score.ini', 'T')])).toEqual({ 'a.dtx.score.ini': 'up', 'b.dtx.score.ini': 'down' });
  });
  it('初めて合わせる曲：Drive の版が新しければ取る（控えへ）、この PC の版が新しければ聞く', () => {
    expect(plan([L('old.dtx', 'A', 100), L('newer.dtx', 'B', 900), L('same.dtx', 'C')], [R('old.dtx', 'A2', 500), R('newer.dtx', 'B2', 500), R('same.dtx', 'C')], [], { first: true })).toEqual({
      'old.dtx': 'keepRemote',
      'newer.dtx': 'ask:first',
      'same.dtx': 'same',
    });
    // 答えたら、その通りに
    const acts = planSong(new Map([['newer.dtx', L('newer.dtx', 'B', 900)]]), new Map([['newer.dtx', R('newer.dtx', 'B2', 500)]]), {}, { first: true, answers: new Map([['newer.dtx', 'theirs']]) });
    expect(acts[0].op).toBe('keepRemote');
  });
  it('PC の時計がずれていたら、両方で直した物は決めずに聞く', () => {
    expect(plan([L('a.dtx', 'X1', 500)], [R('a.dtx', 'X2', 400)], [B('a.dtx', 'X0')], { first: false, clockOff: true })).toEqual({ 'a.dtx': 'ask:clock' });
  });
  it('開いている曲は、この PC の作るファイルを書きかえない（成績は合わせる）', () => {
    expect(
      plan(
        [L('mstr.dtx', 'A'), L('ext.dtx', 'B2', 300), L('mstr.dtx.score.ini', 'S')],
        [R('mstr.dtx', 'A2'), R('ext.dtx', 'B'), R('mstr.dtx.score.ini', 'S2')],
        [B('mstr.dtx', 'A'), B('ext.dtx', 'B'), B('mstr.dtx.score.ini', 'S')],
        { first: false, open: true },
      ),
    ).toEqual({ 'mstr.dtx': 'wait', 'ext.dtx': 'up', 'mstr.dtx.score.ini': 'down' });
  });
  it('MD5 は大きさで分からないときだけ計算する', () => {
    const rec = B('a.ogg', 'M', 100, 10);
    expect(needsMd5({ path: 'a.ogg', size: 10, mtime: 100 }, undefined, rec)).toBe(false); // 記録と同じ
    expect(needsMd5({ path: 'a.ogg', size: 10, mtime: 200 }, R('a.ogg', 'M2', 100, 10), rec)).toBe(true);
    expect(needsMd5({ path: 'a.ogg', size: 12, mtime: 200 }, R('a.ogg', 'M2', 100, 11), rec)).toBe(false); // 大きさが違えば違う
    expect(needsMd5({ path: 'a.ogg', size: 12, mtime: 200 }, R('a.ogg', 'M2', 100, 12), undefined)).toBe(true); // 初めて：同じ大きさ
    expect(needsMd5({ path: 'a.ogg', size: 12, mtime: 200 }, R('a.ogg', 'M2', 100, 9), undefined)).toBe(false);
  });
  it('MD5 を計算しなくても、大きさが違えば両方で変わったとみる', () => {
    const acts = planSong(new Map([['a.ogg', { path: 'a.ogg', size: 12, mtime: 300 }]]), new Map([['a.ogg', R('a.ogg', 'M2', 200, 11)]]), { 'a.ogg': B('a.ogg', 'M', 100, 10) }, { first: false });
    expect(acts[0].op).toBe('keepLocal');
  });
});
