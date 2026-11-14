// 同期の記録の決まり（聞いていることは、いちばん新しい記録にだけ・1 曲だけの同期・何も無い同期・続く失敗）
import { describe, expect, it } from 'vitest';
import { addRun, type LogEntry } from './runlog';
import { emptyReport, type Ask, type RunReport } from './types';

const NOW = Date.parse('2026-11-14T03:00:00Z');
const gone = (id: string, lib: string): Ask => ({ id: `g:${id}`, kind: 'gone', title: lib, driveId: id, lib: lib.toLowerCase() });
const fileAsk = (song: string, lib: string, path: string): Ask => ({ id: `f:${song}:${path}`, kind: 'file', why: 'first', title: lib, lib, path, local: { time: 1, size: 1 }, remote: { time: 2, size: 2 } });
const run = (at: number, p: Partial<RunReport> = {}): RunReport => ({ at, pc: '作るPC', why: 'timer', songs: [], asks: [], ...p });
const sent = (lib: string) => ({ ...emptyReport(lib.split('/').pop()!, lib, 'd1', 'here'), sent: ['a.dtx'] });

describe('同期の記録', () => {
  it('聞いているだけの同期は、5 分ごとに記録を足さない（聞いていることが変わったときだけ映す）', () => {
    const asks = [gone('d1', 'Rock/Song A'), gone('d2', 'Rock/Song B')];
    let log: LogEntry[] = [run(NOW - 3600_000, { songs: [sent('Rock/Song C')] })];
    log = addRun(log, run(NOW - 600_000, { asks }), { now: NOW })!;
    expect(log).toHaveLength(1);
    expect(log[0].asks.map((a) => a.id)).toEqual(['g:d1', 'g:d2']);
    // 同じことを聞くだけ：変えない
    expect(addRun(log, run(NOW - 300_000, { asks }), { now: NOW })).toBeNull();
    // 答えた（聞くことが減った）
    log = addRun(log, run(NOW, { asks: asks.slice(1) }), { now: NOW })!;
    expect(log).toHaveLength(1);
    expect(log[0].asks.map((a) => a.id)).toEqual(['g:d2']);
    // 何も無い
    log = addRun(log, run(NOW + 1, {}), { now: NOW })!;
    expect(log[0].asks).toEqual([]);
    expect(addRun(log, run(NOW + 2, {}), { now: NOW })).toBeNull();
  });

  it('記録がまだ無くて、聞いていることだけ：1 件足す', () => {
    const log = addRun([], run(NOW, { asks: [gone('d1', 'Rock/Song A')] }), { now: NOW })!;
    expect(log).toHaveLength(1);
    expect(log[0].asks).toHaveLength(1);
    expect(addRun([], run(NOW, {}), { now: NOW })).toBeNull();
  });

  it('何かあった同期は新しい記録に。聞いていることは、いちばん新しい記録にだけ', () => {
    let log: LogEntry[] = [run(NOW - 600_000, { songs: [sent('Rock/Song C')], asks: [gone('d1', 'Rock/Song A')] })];
    log = addRun(log, run(NOW, { songs: [sent('Rock/Song D')], asks: [gone('d1', 'Rock/Song A')] }), { now: NOW })!;
    expect(log).toHaveLength(2);
    expect(log[0].asks).toHaveLength(1);
    expect(log[1].asks).toEqual([]);
  });

  it('保存したときの 1 曲だけの同期は、ほかの曲で聞いていることを消さない', () => {
    const asks = [gone('d1', 'Rock/Song A'), fileAsk('d3', 'Rock/Song B', 'b.dtx')];
    let log: LogEntry[] = [run(NOW - 600_000, { asks })];
    // ほかの曲を保存した（送った）
    log = addRun(log, run(NOW - 300_000, { why: 'save', songs: [sent('Pop/Song E')] }), { only: true, now: NOW })!;
    expect(log).toHaveLength(2);
    expect(log[0].asks.map((a) => a.id)).toEqual(['g:d1', 'f:d3:b.dtx']);
    expect(log[1].asks).toEqual([]);
    // 何も変わらなかった 1 曲だけの同期
    expect(addRun(log, run(NOW - 200_000, { why: 'save' }), { only: true, now: NOW })).toBeNull();
    // 聞いていた曲（Song B）を保存した：その曲の分は今回の物に（もう聞かない）
    log = addRun(log, run(NOW, { why: 'save', songs: [sent('Rock/Song B')] }), { only: true, now: NOW })!;
    expect(log[0].asks.map((a) => a.id)).toEqual(['g:d1']);
  });

  it('途中で止まった同期は聞いていることを残し、同じ失敗が続いたら 1 件に', () => {
    const asks = [gone('d1', 'Rock/Song A')];
    let log: LogEntry[] = [run(NOW - 600_000, { songs: [sent('Rock/Song C')], asks })];
    log = addRun(log, run(NOW - 60_000, { error: 'Google Drive がいっぱいです' }), { now: NOW })!;
    expect(log).toHaveLength(2);
    expect(log[0].asks).toEqual(asks);
    log = addRun(log, run(NOW - 40_000, { error: 'Google Drive がいっぱいです' }), { now: NOW })!;
    log = addRun(log, run(NOW - 20_000, { error: 'Google Drive がいっぱいです' }), { now: NOW })!;
    expect(log).toHaveLength(2);
    expect(log[0].at).toBe(NOW - 20_000);
    expect(log[0].asks).toEqual(asks);
    // 違う失敗は別に残す
    log = addRun(log, run(NOW, { error: 'network' }), { now: NOW })!;
    expect(log).toHaveLength(3);
  });

  it('30 日より古い記録は消す・下見は残さない', () => {
    const log: LogEntry[] = [run(NOW - 31 * 86_400_000, { songs: [sent('Rock/Old')] })];
    expect(addRun(log, run(NOW, { songs: [sent('Rock/New')] }), { now: NOW })!.map((l) => l.at)).toEqual([NOW]);
    expect(addRun(log, run(NOW, { songs: [sent('Rock/New')], dry: true }), { now: NOW })).toBeNull();
  });
});
