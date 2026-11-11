// スマホの AI 難易度生成：作る難易度の目標レベル（めやす）を「− 値 ＋」で変える。
// 縦は並べた譜面の上に、作る難易度を帯で並べる（作る設定を開かなくても見えて、その場で変えられる）。
// 横は左の列の難易度のカードの中。値を押せば数字のキーボードで打てる（キーボードが出ても画面は縮めない：store/device）
import { useEffect, useRef, useState } from 'react';
import { tr } from '../../i18n';
import type { Difficulty } from '../../gen/simplify';
import { SLOTS } from '../../gen/targets';
import { toast } from '../../store/editor';
import { belowSource, columnDoc, isPassing, knownLevels, setEnabled, setListen, setTarget, shownLevel, slotLabel, stairIssues, useGen, type DiffState } from '../../store/gen';
import { Icon } from '../icons';

const round1 = (x: number) => Math.round(x * 10) / 10;

/** これ以上動かせないわけ（めやすは開いている譜面・残す既存の譜面から 0.3 離す。1.0〜9.9） */
function capNote(d: Difficulty, up: boolean): string {
  const g = useGen.getState();
  const known = knownLevels(g);
  const i = SLOTS.indexOf(d);
  const near = up ? SLOTS.slice(0, i).filter((s) => known[s] !== undefined).pop() : SLOTS.slice(i + 1).find((s) => known[s] !== undefined);
  if (near) {
    const lv = known[near]!.toFixed(2);
    const name = slotLabel(g, near);
    return up
      ? tr(`${d} のめやすは、上の ${name}（Lv ${lv}）より 0.3 低い所までです`, `The ${d} aim stays at least 0.3 below ${name} above it (Lv ${lv})`)
      : tr(`${d} のめやすは、下の ${name}（Lv ${lv}）より 0.3 高い所までです`, `The ${d} aim stays at least 0.3 above ${name} below it (Lv ${lv})`);
  }
  return up ? tr('めやすは 9.9 までです', 'The aim goes up to 9.9') : tr('めやすは 1.0 からです', 'The aim starts at 1.0');
}

/** めやすを 0.1 動かす。動かせなかったら false（わけを出す） */
function stepAim(d: Difficulty, dir: 1 | -1): boolean {
  const before = useGen.getState().diffs[d].target.center;
  const want = round1(before + dir * 0.1);
  if (want >= 1 && want <= 9.9) setTarget(d, want);
  const after = useGen.getState().diffs[d].target.center;
  if (Math.abs(after - before) > 0.001) return true;
  toast(capNote(d, dir > 0), 'info', 2600);
  return false;
}

/** 押すと 1 回、押し続けると 0.45 秒後から続けて（動かせなくなったら止める） */
function useRepeat(fn: () => boolean) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const st = useRef({ t: 0, iv: 0, repeated: false });
  const stop = () => {
    window.clearTimeout(st.current.t);
    window.clearInterval(st.current.iv);
    st.current.t = 0;
    st.current.iv = 0;
  };
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      stop();
      st.current.repeated = false;
      st.current.t = window.setTimeout(() => {
        st.current.repeated = true;
        if (!fnRef.current()) return;
        st.current.iv = window.setInterval(() => {
          if (!fnRef.current()) stop();
        }, 90);
      }, 450);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onClick: () => {
      // 押し続けて動かしたあとの click は数えない
      if (st.current.repeated) {
        st.current.repeated = false;
        return;
      }
      fnRef.current();
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

/** めやすの数字。押すと数字のキーボードで打てる（打ち終えたら決める。空のままなら変えない） */
function AimInput({ ds }: { ds: DiffState }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = useRef(false);
  const shown = ds.target.center.toFixed(1);
  const commit = (text: string | null) => {
    setDraft(null);
    if (text === null || cancel.current) {
      cancel.current = false;
      return;
    }
    // 打たずに離れたら変えない（自動のめやすを手で決めた値にしない）
    if (text.trim() === shown) return;
    const v = Number(text.trim().replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(v)) return;
    const want = round1(v);
    setTarget(ds.diff, want);
    const got = useGen.getState().diffs[ds.diff].target.center;
    if (Math.abs(got - Math.max(1, Math.min(9.9, want))) > 0.05) toast(capNote(ds.diff, want > got), 'info', 3000);
  };
  return (
    <input
      className={`pg-aim-input mono ${ds.manual !== null ? 'manual' : ''}`}
      type="text"
      inputMode="decimal"
      enterKeyHint="done"
      autoComplete="off"
      value={draft ?? shown}
      onFocus={(e) => {
        setDraft(shown);
        const el = e.currentTarget;
        window.setTimeout(() => el.select(), 0);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancel.current = true;
          e.currentTarget.blur();
        }
      }}
      aria-label={tr(`${ds.diff} のめやす（目標レベル）`, `${ds.diff} aim (target level)`)}
      title={tr('めやす（目標レベル）。押すと数字で打てます。幅はその ±1 で、隣の難易度とは重ねません', 'Aim (target level). Tap to type a number. The range is ±1 around it and never overlaps the neighbors')}
    />
  );
}

/** めやすの「− 値 ＋」（押し続けると続けて動く） */
export function AimStepper({ ds }: { ds: DiffState }) {
  const down = useRepeat(() => stepAim(ds.diff, -1));
  const up = useRepeat(() => stepAim(ds.diff, 1));
  return (
    <span className="pg-aim" onClick={(e) => e.stopPropagation()}>
      <button className="pg-aim-btn" {...down} aria-label={tr(`${ds.diff} のめやすを 0.1 下げる`, `Lower the ${ds.diff} aim by 0.1`)}>
        {Icon.minus(16)}
      </button>
      <AimInput ds={ds} />
      <button className="pg-aim-btn" {...up} aria-label={tr(`${ds.diff} のめやすを 0.1 上げる`, `Raise the ${ds.diff} aim by 0.1`)}>
        {Icon.plus(16)}
      </button>
    </span>
  );
}

/** 縦：作る難易度ごとの目標の帯（チェック・名前・作ったレベル／めやすの − 値 ＋） */
export function TargetStrip() {
  const below = useGen((s) => belowSource(s).join(','));
  if (!below) return null;
  return (
    <div className="pg-strip" role="group" aria-label={tr('作る難易度と目標レベル', 'Difficulties to make and target levels')}>
      {(below.split(',') as Difficulty[]).map((d) => (
        <TargetChip key={d} d={d} />
      ))}
    </div>
  );
}

function TargetChip({ d }: { d: Difficulty }) {
  const g = useGen();
  const ds = g.diffs[d];
  const chart = g.charts[d];
  const on = g.listen === d;
  const busy = ds.status === 'planning' || ds.status === 'building' || ds.status === 'judging';
  const lv = ds.enabled && ds.result ? shownLevel(ds) : null;
  const st = lv !== null ? stairIssues(g, d) : null;
  const ok = lv !== null && isPassing(ds) && st !== null && st.denser.length + st.thinner.length === 0;
  const open = () => {
    if (columnDoc(g, d)) setListen(d);
    else if (ds.enabled) toast(tr(`${d} はまだ作っていません（下の「まとめて作る」で作ります）`, `${d} hasn't been made yet (use “Generate all” below)`), 'info', 2400);
  };
  return (
    <div className={`pg-chip ${on ? 'on' : ''} ${ds.enabled ? '' : 'off'}`} onClick={open} role="button" tabIndex={-1} aria-pressed={on}>
      <div className="pg-chip-head">
        <input
          type="checkbox"
          checked={ds.enabled}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEnabled(d, e.target.checked)}
          aria-label={chart ? tr(`${d} を作り直す（外すと曲にある譜面を残す）`, `Remake ${d} (uncheck to keep the chart in the song)`) : tr(`${d} を作る`, `Make ${d}`)}
        />
        <b className="pg-chip-name mono">{d === 'EXTREME' ? 'EXT' : d === 'ADVANCED' ? 'ADV' : 'BSC'}</b>
        <span className="grow" />
        {busy ? (
          <span className="pg-chip-lv lbl">{tr('作成中…', 'Making…')}</span>
        ) : lv !== null ? (
          <b className={`pg-chip-lv mono ${ok ? 'ok' : 'warn'}`} title={ok ? tr('作ったレベル（検証OK）。下の数字はめやす（目標）', 'Level made (checks passed). The number below is the aim (target)') : tr('作ったレベル（要確認）。下の数字はめやす（目標）', 'Level made (needs review). The number below is the aim (target)')}>
            Lv {lv.toFixed(2)}
          </b>
        ) : !ds.enabled && chart ? (
          <b className="pg-chip-lv mono" title={tr('曲にある譜面のレベル', 'Level of the chart in the song')}>
            Lv {chart.level.toFixed(2)}
          </b>
        ) : ds.enabled ? (
          <span className="pg-chip-lv lbl">{tr('めやす', 'Aim')}</span>
        ) : null}
      </div>
      {ds.enabled ? (
        <AimStepper ds={ds} />
      ) : (
        <span className="pg-chip-off lbl">{chart ? tr('曲にある譜面を残す', 'Keep the song’s chart') : tr('作らない', 'Not made')}</span>
      )}
    </div>
  );
}
