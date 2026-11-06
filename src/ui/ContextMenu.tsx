// 右クリックのメニュー。何を右クリックしたかで中身を変える（store/ctxMenu）。
// - チップ：ベロシティ（強・中・弱、±、スライダー、ホイール）・HHオープン/クローズ・レーン・種類・コピー・削除
// - 何もない所：グリッドの切り替え（ボタン1回）・ここから再生・ループ・貼り付け
// - 小節番号・✨ の列：小節の操作。ループの帯：ループの操作。END：曲の終わりの決め方
// - 下のトラックの上の境目・角（PC）：止まる高さ（閉じる・1本・細く・標準・ゆったり）
// 一度で済む操作（強・中・弱、レーン、グリッド、コマンド）は押すと閉じる。±・スライダー・ホイールは開いたまま微調整できる。
import { tr, pl } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { toMeasure } from '../dtx/base36';
import { fracToString } from '../dtx/fraction';
import { CH, DRUM_LANES, drumChannel, type Chip, type ChipKind, type DtxDoc } from '../dtx/model';
import { fittingGrid, GRID_DIVS, onGrid, type Pos } from '../edit/ops';
import { useInputSettings } from '../input/settings';
import { useDevice } from '../store/device';
import { maxTracksH, SEEK_CLOSED_H, useLayout } from '../store/layout';
import { DESK_TRACK_STOPS, deskStopHeight } from '../store/sheetSnap';
import { setLoop, setLoopPoint, useAssist } from '../store/assist';
import { chipMenuExtras, closeCtxMenu, dismissCtxMenu, laneMenuExtras, useCtxMenu, type CtxItem, type CtxMenu } from '../store/ctxMenu';
import { chipViews, tempoOf, wavVel } from '../store/derived';
import {
  autoEndMeasure,
  copySelection,
  cutSelection,
  deleteChips,
  deleteMeasures,
  duplicatePrevMeasure,
  insertMeasures,
  paste,
  placeBpmChange,
  playFrom,
  previewWav,
  relaneChips,
  resetSongEnd,
  setKind,
  setView,
  songEndAtCursor,
  songEndAtLastChip,
  toast,
  useEditor,
} from '../store/editor';
import { openMeasureGen, useMeasureGen } from '../store/measureGen';
import { nudgeVel, setVelOf, velStep, velPresetNames } from '../store/velocity';
import { openSectionEditor } from './ChartCanvas';
import { promptDialog } from './dialogs';
import { channelName, chipBpmLabel } from './format';
import { songEndM } from './hooks';
import { Icon } from './icons';
import { currentTrackStop, setTrackStop, trackStopLabel, trackStopNote } from './Splitter';

/** タブレットでは「ダブルタップ」、PC では「ダブルクリック」 */
const dblHint = () => (useDevice.getState().tablet ? tr('ダブルタップ', 'Double-tap') : tr('ダブルクリック', 'Double-click'));

/** 譜面の画面に1つだけ置く */
export function ContextMenuHost() {
  const menu = useCtxMenu((s) => s.menu);
  // 譜面の画面を離れたら閉じる（戻ったときに古いメニューが出ないように）
  useEffect(() => () => void closeCtxMenu(), []);
  if (!menu) return null;
  return <Frame key={menu.seq} menu={menu} />;
}

function Frame({ menu }: { menu: CtxMenu }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // 画面からはみ出さないように（右が足りなければマウスの左、下が足りなければ上へずらす）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      // 指の長押し：指で隠れないように指の右（右端なら左）に出す。真下には出さない
      const gap = menu.touch ? 36 : 2;
      let left = menu.x + gap;
      let top = menu.touch ? menu.y - 30 : menu.y + 2;
      if (left + r.width > window.innerWidth - 8) left = Math.max(8, menu.x - r.width - gap);
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - r.height);
      if (top < 8) top = 8;
      setAt((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [menu.x, menu.y, menu.touch]);
  useEffect(() => {
    // 外を押したら閉じる。閉じるための押下は譜面に効かせない（ChartCanvas が dismissedBy で見分ける）
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismissCtxMenu(e.timeStamp);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeCtxMenu();
    };
    const close = () => void closeCtxMenu();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, []);
  return (
    <div
      ref={ref}
      className={`ctx-menu ${menu.kind === 'chips' || menu.kind === 'tracks' ? 'wide' : ''} ${menu.touch ? 'touch' : ''}`}
      role="menu"
      style={{ left: at?.left ?? menu.x, top: at?.top ?? menu.y, visibility: at ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === 'chips' ? (
        <ChipMenu ids={menu.ids} anchor={menu.anchor} seq={menu.seq} />
      ) : menu.kind === 'space' ? (
        <SpaceMenu menu={menu} />
      ) : menu.kind === 'measure' ? (
        <MeasureMenu m={menu.m} />
      ) : menu.kind === 'loop' ? (
        <LoopMenu beat={menu.beat} />
      ) : menu.kind === 'tracks' ? (
        <TracksMenu rows={menu.rows} />
      ) : (
        <EndMenu />
      )}
    </div>
  );
}

// ---- 部品 ---------------------------------------------------------------------

function Item({ icon, label, hint, onClick, disabled, danger, title }: { icon?: ReactNode; label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }) {
  return (
    <button className={`ctx-item ${danger ? 'danger' : ''}`} role="menuitem" disabled={disabled} onClick={onClick} title={title}>
      <span className="ctx-ic">{icon}</span>
      <span className="ctx-label">{label}</span>
      {hint && <span className="key">{hint}</span>}
    </button>
  );
}

function ExtraItem({ it }: { it: CtxItem }) {
  return (
    <Item
      label={it.label}
      hint={it.hint}
      disabled={it.disabled}
      onClick={() => {
        if (!it.keepOpen) closeCtxMenu();
        it.run();
      }}
    />
  );
}

const Sep = () => <div className="ctx-sep" />;

/** 押したら閉じてから実行する（ダイアログを出す操作などのため、先に閉じる） */
const then = (fn: () => void) => () => {
  closeCtxMenu();
  fn();
};

function drumIdsIn(doc: DtxDoc, m: number): number[] {
  return chipViews(doc)
    .filter((v) => v.col >= 0 && v.c.m === m)
    .map((v) => v.c.id);
}

function loopMeasure(m: number) {
  const t = tempoOf(useEditor.getState().doc);
  setLoop({ on: true, a: t.measureStart(m), b: t.measureStart(m + 1) });
}

/** チップの音を鳴らす（「チップを置いたときに音を鳴らす」を切っていれば鳴らさない） */
function hear(ids: readonly number[], anchor: number, force = false) {
  const s = useEditor.getState();
  if (!force && !s.previewOnPlace) return;
  const want = new Set(ids);
  const c = s.doc.chips.find((x) => x.id === anchor && drumChannel(x.ch)) ?? s.doc.chips.find((x) => want.has(x.id) && drumChannel(x.ch));
  if (c) previewWav(c.v);
}

async function askBpm(pos: Pos) {
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const cur = tempo.bpmAt(tempo.beatOf(pos.m, pos.f));
  const v = await promptDialog({
    title: tr(`小節 ${toMeasure(pos.m)} の BPM`, `BPM at measure ${toMeasure(pos.m)}`),
    body: tr('この位置からのBPMを入力してください（#BPMzz と ch08 で書き出します）。', 'Enter the BPM from this position on (written as #BPMzz and ch08).'),
    value: chipBpmLabel(cur),
    ok: tr('決定', 'OK'),
  });
  const bpm = v ? Number(v) : NaN;
  if (Number.isFinite(bpm) && bpm > 0) placeBpmChange(pos, bpm);
}

// ---- チップ -------------------------------------------------------------------

const chipKinds = (): [ChipKind, string, string][] => [
  ['normal', tr('通常', 'Normal'), ''],
  ['hidden', tr('不可視', 'Invisible'), tr('叩く必要はあるが見えないチップ', 'A chip you still have to hit, but it is not shown')],
  ['nochip', tr('音だけ', 'Sound only'), tr('空打ちしたときに鳴る音（チップは出ない）', 'Sound played when hitting the pad with no chip (no chip appears)')],
];

function ChipMenu({ ids, anchor, seq }: { ids: number[]; anchor: number; seq: number }) {
  const doc = useEditor((s) => s.doc);
  const order = useInputSettings((s) => s.laneOrder);
  const want = new Set(ids);
  const chips = doc.chips.filter((c) => want.has(c.id));
  const gone = chips.length === 0;
  // 消した・元に戻したなどで対象が無くなったら閉じる
  useEffect(() => {
    if (gone) closeCtxMenu();
  }, [gone]);
  if (gone) return null;
  const drums = chips.filter((c) => drumChannel(c.ch));
  const drumIds = drums.map((c) => c.id);
  const one = chips.length === 1 ? chips[0] : null;
  const lanes = new Set(drums.map((c) => drumChannel(c.ch)!.lane));
  const kinds = new Set(drums.map((c) => drumChannel(c.ch)!.kind));
  const altLanes = [...lanes].filter((l) => DRUM_LANES[l].alt !== undefined).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const color = one && drumChannel(one.ch) ? DRUM_LANES[drumChannel(one.ch)!.lane].color : one ? '#8B95A4' : 'var(--accent)';
  const isBpm = one && (one.ch === CH.BPM || one.ch === CH.BPM_EX);
  const extras = chipMenuExtras(ids);

  const moveTo = (lane: number) => {
    const moving = drums.filter((c) => drumChannel(c.ch)!.lane !== lane).map((c) => c.id);
    closeCtxMenu();
    if (!moving.length) return;
    relaneChips(moving, lane, 'main');
    hear(drumIds, anchor);
  };

  return (
    <>
      <div className="ctx-head">
        <span className="dot" style={{ background: color, width: 10, height: 10, flex: 'none' }} />
        <b className="ellipsis">{one ? channelName(one.ch) : tr(`${chips.length} 個のチップ`, `${chips.length} ${pl(chips.length, 'chip')}`)}</b>
        <span className="ctx-head-sub mono ellipsis">{one ? `${toMeasure(one.m)} · ${fracToString(one.f)}` : laneSummary(chips)}</span>
        {drums.length > 0 && (
          <button className="ib tiny" onClick={() => hear(drumIds, anchor, true)} title={tr('音を聴く', 'Listen')} aria-label={tr('音を聴く', 'Listen')}>
            {Icon.speaker(13)}
          </button>
        )}
      </div>
      {drums.length > 0 && (
        <>
          <VelBlock ids={drumIds} anchor={anchor} group={`ctx-vel-${seq}`} />
          <Sep />
          {altLanes.map((lane) => {
            const def = DRUM_LANES[lane];
            const inLane = drums.filter((c) => drumChannel(c.ch)!.lane === lane);
            const nAlt = inLane.filter((c) => drumChannel(c.ch)!.alt).length;
            const state = nAlt === 0 ? 'main' : nAlt === inLane.length ? 'alt' : null;
            const set = (alt: 'main' | 'alt') => {
              closeCtxMenu();
              if (state === alt) return;
              relaneChips(
                inLane.map((c) => c.id),
                lane,
                alt,
              );
              hear(drumIds, anchor);
            };
            return (
              <div className="ctx-pair" key={lane}>
                <button className={state === 'main' ? 'on' : ''} onClick={() => set('main')}>
                  {def.mainName}
                </button>
                <button className={state === 'alt' ? 'on' : ''} onClick={() => set('alt')}>
                  {def.altName}
                </button>
              </div>
            );
          })}
          <div className="ctx-sec">
            <div className="ctx-sec-title">
              <span>{tr('レーンを変える', 'Change lane')}</span>
              <span className="ctx-dim">{tr('同じ時刻のまま・音もそのレーンに', 'Same timing · uses that lane\'s sound')}</span>
            </div>
            <div className="ctx-lanes">
              {order.map((lane) => {
                const def = DRUM_LANES[lane];
                const on = lanes.has(lane);
                return (
                  <button
                    key={lane}
                    className={`ctx-lane ${on ? (lanes.size === 1 ? 'on' : 'some') : ''}`}
                    style={{ ['--c' as string]: def.color }}
                    title={on && lanes.size === 1 ? tr(`${def.name}（今のレーン）`, `${def.name} (current lane)`) : tr(`${def.name}へ移す`, `Move to ${def.name}`)}
                    onClick={() => moveTo(lane)}
                  >
                    {def.key}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="ctx-row">
            <span className="ctx-row-label">{tr('種類', 'Type')}</span>
            <div className="ctx-tri">
              {chipKinds().map(([k, label, tip]) => (
                <button
                  key={k}
                  className={kinds.size === 1 && kinds.has(k) ? 'on' : ''}
                  title={tip || undefined}
                  onClick={() => {
                    closeCtxMenu();
                    if (!(kinds.size === 1 && kinds.has(k))) setKind(k, drumIds);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Sep />
        </>
      )}
      {isBpm && <Item label={tr('BPM を変える…', 'Change BPM…')} hint={dblHint()} onClick={then(() => void askBpm({ m: one!.m, f: one!.f }))} />}
      {extras.map((it, i) => (
        <ExtraItem key={i} it={it} />
      ))}
      {(isBpm || extras.length > 0) && <Sep />}
      <Item
        label={tr('コピー', 'Copy')}
        hint="Ctrl+C"
        onClick={then(() => {
          useEditor.setState({ selection: [...ids] });
          copySelection();
        })}
      />
      <Item
        label={tr('切り取り', 'Cut')}
        hint="Ctrl+X"
        onClick={then(() => {
          useEditor.setState({ selection: [...ids] });
          cutSelection();
        })}
      />
      <Item
        icon={Icon.trash(13)}
        danger
        label={chips.length > 1 ? tr(`${chips.length} 個を削除`, `Delete ${chips.length}`) : tr('削除', 'Delete')}
        hint={isBpm ? 'Delete' : useDevice.getState().tablet ? tr('ダブルタップ', 'Double-tap') : tr('ダブルクリック・Delete', 'Double-click / Delete')}
        onClick={then(() => deleteChips(ids))}
      />
    </>
  );
}

/** 何個のチップか（レーンごと。多い順に3つまで） */
function laneSummary(chips: Chip[]): string {
  const count = new Map<string, number>();
  for (const c of chips) {
    const d = drumChannel(c.ch);
    const k = d ? DRUM_LANES[d.lane].key : channelName(c.ch);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]);
  return top
    .slice(0, 3)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ') + (top.length > 3 ? ' …' : '');
}

/** ベロシティ：強・中・弱（押したら閉じる）、±・スライダー・ホイール（開いたまま） */
function VelBlock({ ids, anchor, group }: { ids: number[]; anchor: number; group: string }) {
  const doc = useEditor((s) => s.doc);
  const presets = useInputSettings((s) => s.velPresets);
  const step = useInputSettings((s) => s.velStep);
  const want = new Set(ids);
  const vals = doc.chips.filter((c) => want.has(c.id)).map((c) => wavVel(doc, c.v));
  const same = vals.every((v) => v === vals[0]);
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length));
  const box = useRef<HTMLDivElement>(null);
  const nudge = (d: number) => {
    if (nudgeVel(ids, d, group)) hear(ids, anchor);
  };
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;
  // ホイールで ±（Shift で 1 ずつ）。メニューの上なのでページはスクロールさせない
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY || e.deltaX;
      if (!dy) return;
      nudgeRef.current((dy < 0 ? 1 : -1) * (e.shiftKey ? 1 : velStep()));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const min = step > 1 ? step : 1;
  return (
    <div className="ctx-sec" ref={box} title={tr(`ホイールでも ±${step}（Shift で 1 ずつ）`, `The wheel also changes it by ±${step} (Shift: by 1)`)}>
      <div className="ctx-sec-title">
        <span>{tr('ベロシティ', 'Velocity')}</span>
        <span className="ctx-vel-val mono">{same ? avg : `~${avg}`}</span>
      </div>
      <div className="ctx-tri">
        {velPresetNames().map((name, i) => (
          <button
            key={name}
            className={same && avg === presets[i] ? 'on' : ''}
            onClick={() => {
              closeCtxMenu();
              setVelOf(ids, presets[i], group);
              hear(ids, anchor);
            }}
          >
            {name} <span className="mono">{presets[i]}</span>
          </button>
        ))}
      </div>
      <div className="ctx-slider">
        <button className="ctx-step" onClick={(e) => nudge(-(e.shiftKey ? 1 : step))} title={tr(`-${step}（Shift で -1）`, `-${step} (Shift: -1)`)} aria-label={tr('弱く', 'Softer')}>
          {Icon.minus(12)}
        </button>
        <input
          type="range"
          min={min}
          max={100}
          step={step > 1 ? step : 1}
          value={Math.max(min, avg)}
          onChange={(e) => setVelOf(ids, Number(e.target.value), group)}
          onPointerUp={() => hear(ids, anchor)}
          onKeyUp={() => hear(ids, anchor)}
          aria-label={tr('ベロシティ', 'Velocity')}
        />
        <button className="ctx-step" onClick={(e) => nudge(e.shiftKey ? 1 : step)} title={tr(`+${step}（Shift で +1）`, `+${step} (Shift: +1)`)} aria-label={tr('強く', 'Harder')}>
          {Icon.plus(12)}
        </button>
      </div>
    </div>
  );
}

// ---- 何もない所 ----------------------------------------------------------------

/** グリッドのボタンの並び（左ほど粗い）。3連は 8分の3連（1/12）から */
const gridRows = (): { key: string; label: string; divs: number[] }[] => [
  { key: 'even', label: tr('通常', 'Even'), divs: [4, 8, 16, 32, 64, 192] },
  { key: 'tri', label: tr('3連', 'Triplet'), divs: [12, 24, 48, 96] },
  { key: 'odd', label: tr('5・7連', '5 & 7'), divs: [20, 40, 28] },
];

function gridName(d: number): string {
  const names: Record<number, [string, string]> = {
    4: ['4分', 'quarter'],
    8: ['8分', '8th'],
    12: ['8分の3連', '8th triplet'],
    16: ['16分', '16th'],
    20: ['16分の5連', '16th quintuplet'],
    24: ['16分の3連', '16th triplet'],
    28: ['16分の7連', '16th septuplet'],
    32: ['32分', '32nd'],
    40: ['32分の5連', '32nd quintuplet'],
    48: ['32分の3連', '32nd triplet'],
    64: ['64分', '64th'],
    96: ['64分の3連', '64th triplet'],
    192: ['いちばん細かい', 'finest'],
  };
  const n = names[d];
  return n ? tr(n[0], n[1]) : '';
}

/** 小節のチップのうち、今のグリッドに乗らないものがあれば、全部が乗る一番粗いグリッド */
export function gridHint(doc: DtxDoc, m: number, div: number): number | null {
  const bl = tempoOf(doc).barLenFrac(m);
  const fs = doc.chips.filter((c) => c.m === m && drumChannel(c.ch)).map((c) => c.f);
  if (fs.length === 0 || fs.every((f) => onGrid(f, div, bl))) return null;
  return fittingGrid(fs, bl);
}

function GridPicker({ m }: { m: number }) {
  const div = useEditor((s) => s.view.div);
  const doc = useEditor((s) => s.doc);
  const hint = gridHint(doc, m, div);
  const pick = (d: number) => {
    closeCtxMenu();
    setView({ div: d });
  };
  const custom = async () => {
    closeCtxMenu();
    const v = await promptDialog({
      title: tr('グリッドの細かさ', 'Grid resolution'),
      body: tr('全音符をいくつに分けるか（1〜192）。5連の16分なら 20、7連なら 28、6連なら 24。', 'How many parts to divide a whole note into (1–192). 16th-note quintuplets: 20, septuplets: 28, sextuplets: 24.'),
      value: String(div),
      ok: tr('決定', 'OK'),
    });
    const n = Math.round(Number(v));
    if (v && n >= 1 && n <= 192) setView({ div: n });
  };
  const rows = gridRows();
  return (
    <div className="ctx-sec">
      <div className="ctx-sec-title">
        <span>
          {tr('グリッド', 'Grid')} <b className="mono ctx-cur">1/{div}</b>
        </span>
        <span className="ctx-dim" title={tr('[ と ] でも1段ずつ変えられます', '[ and ] also step through them')}>
          <kbd>[</kbd> <kbd>]</kbd>
        </span>
      </div>
      {rows.map((row) => (
        <div className="ctx-grid-row" key={row.key}>
          <span className="rl">{row.label}</span>
          {row.divs.map((d) => (
            <button
              key={d}
              className={`ctx-grid-btn mono ${div === d ? 'on' : ''} ${hint === d ? 'fit' : ''}`}
              title={tr(`1/${d}（${gridName(d)}）${hint === d ? '。この小節のチップが全部乗ります' : ''}`, `1/${d} (${gridName(d)})${hint === d ? '. Every chip in this measure fits on it' : ''}`)}
              onClick={() => pick(d)}
            >
              {d}
            </button>
          ))}
          {row === rows[rows.length - 1] && (
            <button className="link-btn ctx-custom" onClick={() => void custom()} title={tr('好きな数で分ける（6連なら 24 など）', 'Divide by any number (e.g. 24 for sextuplets)')}>
              {(GRID_DIVS as readonly number[]).includes(div) ? tr('任意…', 'Custom…') : tr(`任意 ${div}…`, `Custom ${div}…`)}
            </button>
          )}
        </div>
      ))}
      {hint !== null && (
        <div className="ctx-fit-note">
          <span className="fit-dot" />
          {tr(`小節 ${toMeasure(m)} のチップは 1/${hint} なら全部乗ります`, `All chips in measure ${toMeasure(m)} fit on 1/${hint}`)}
        </div>
      )}
    </div>
  );
}

function SpaceMenu({ menu }: { menu: Extract<CtxMenu, { kind: 'space' }> }) {
  const doc = useEditor((s) => s.doc);
  const clip = useEditor((s) => s.clipboard.length);
  const m = menu.pos.m;
  const inMeasure = drumIdsIn(doc, m);
  const extras = menu.col === 'lane' && menu.lane !== undefined ? laneMenuExtras({ lane: menu.lane, alt: !!menu.alt, pos: menu.pos }) : [];
  return (
    <>
      <GridPicker m={m} />
      {extras.length > 0 && (
        <>
          <Sep />
          {extras.map((it, i) => (
            <ExtraItem key={i} it={it} />
          ))}
        </>
      )}
      <Sep />
      <Item icon={Icon.play(11)} label={tr('ここから再生', 'Play from here')} hint={tr('▶ をここに', 'Moves ▶ here')} onClick={then(() => void playFrom(menu.beat))} />
      <Item icon={Icon.loop(12)} label={tr(`小節 ${toMeasure(m)} をループ`, `Loop measure ${toMeasure(m)}`)} onClick={then(() => loopMeasure(m))} />
      <Item
        label={clip ? tr(`ここに貼り付け（${clip} 個）`, `Paste here (${clip})`) : tr('ここに貼り付け', 'Paste here')}
        hint="Ctrl+V"
        disabled={!clip}
        title={clip ? undefined : tr('コピーしたチップがありません', 'No copied chips')}
        onClick={then(() => paste(menu.beat))}
      />
      <Item
        label={tr(`小節 ${toMeasure(m)} のチップを選ぶ`, `Select chips in measure ${toMeasure(m)}`)}
        hint={inMeasure.length ? String(inMeasure.length) : undefined}
        disabled={!inMeasure.length}
        onClick={then(() => useEditor.setState({ selection: inMeasure }))}
      />
      {menu.col === 'bpm' && <Item label={tr('ここに BPM 変化を置く…', 'Place a BPM change here…')} hint={useDevice.getState().tablet ? tr('タップ', 'Tap') : dblHint()} onClick={then(() => void askBpm(menu.pos))} />}
    </>
  );
}

// ---- 小節番号・✨ の列 -----------------------------------------------------------

function deleteMeasureWithToast(m: number) {
  const r = deleteMeasures(m, 1);
  toast(
    tr(
      `小節 ${toMeasure(m)} を削除しました（チップ ${r.removed} 個${r.kept ? `、BPM変化・BGMの開始 ${r.kept} 個は次の小節の頭へ移動` : ''}）。Ctrl+Z で戻せます`,
      `Deleted measure ${toMeasure(m)} (${r.removed} ${pl(r.removed, 'chip')}${r.kept ? `; moved ${r.kept} BPM-change/BGM-start ${pl(r.kept, 'chip')} to the start of the next measure` : ''}). Ctrl+Z to undo.`,
    ),
    'ok',
    6000,
  );
}

function MeasureMenu({ m }: { m: number }) {
  const doc = useEditor((s) => s.doc);
  const genOpen = useMeasureGen((s) => s.open && s.from === m && s.to === m);
  const ids = drumIdsIn(doc, m);
  const tempo = tempoOf(doc);
  return (
    <>
      <div className="ctx-head">
        <b>{tr(`小節 ${toMeasure(m)}`, `Measure ${toMeasure(m)}`)}</b>
        <span className="ctx-head-sub">{ids.length ? tr(`チップ ${ids.length} 個`, `${ids.length} ${pl(ids.length, 'chip')}`) : tr('空の小節', 'Empty measure')}</span>
      </div>
      <Item icon={Icon.sparkle(12)} label={genOpen ? tr('AI の生成をやめる', 'Stop AI generation') : tr('この小節を AI で生成', 'Generate this measure with AI')} hint="✨" onClick={then(() => openMeasureGen(m))} />
      <Item icon={Icon.play(11)} label={tr('この小節から再生', 'Play from this measure')} onClick={then(() => void playFrom(tempo.measureStart(m)))} />
      <Item icon={Icon.loop(12)} label={tr('この小節をループ', 'Loop this measure')} onClick={then(() => loopMeasure(m))} />
      <Item label={tr('この小節のチップを選ぶ', 'Select chips in this measure')} hint={ids.length ? String(ids.length) : undefined} disabled={!ids.length} onClick={then(() => useEditor.setState({ selection: ids }))} />
      <Item label={tr('セクション名を付ける…', 'Name a section…')} hint={useDevice.getState().tablet ? undefined : dblHint()} onClick={then(() => openSectionEditor(m))} />
      <Sep />
      <Item
        label={tr('前の小節をこの小節に写す', 'Copy the previous measure here')}
        disabled={m === 0}
        title={tr('この小節のドラムを、前の小節と同じにします（Ctrl+D は ▶ の小節）', 'Makes the drums in this measure the same as the previous one (Ctrl+D does it for the ▶ measure)')}
        onClick={then(() => duplicatePrevMeasure(m))}
      />
      <Item label={tr('この小節の前に 1 小節入れる', 'Insert a measure before this one')} onClick={then(() => insertMeasures(m))} />
      <Item label={tr('この小節を削除して詰める', 'Delete this measure and close the gap')} danger onClick={then(() => deleteMeasureWithToast(m))} />
    </>
  );
}

// ---- ループの帯 -----------------------------------------------------------------

function LoopMenu({ beat }: { beat: number }) {
  const loop = useAssist((s) => s.loop);
  const mark = useAssist((s) => s.loopMark);
  const doc = useEditor((s) => s.doc);
  const m = tempoOf(doc).locate(Math.max(0, beat)).m;
  return (
    <>
      {(loop || mark) && (
        <Item
          icon={Icon.close(11)}
          label={loop ? tr('ループを消す', 'Clear loop') : tr(`${mark!.side === 'a' ? 'A' : 'B'} の印を消す`, `Clear the ${mark!.side === 'a' ? 'A' : 'B'} mark`)}
          onClick={then(() => setLoop(null))}
        />
      )}
      {loop && (
        <Item
          icon={Icon.loop(12)}
          label={loop.on ? tr('ループを止める（範囲は残す）', 'Turn loop off (keep the range)') : tr('ループをオンにする', 'Turn loop on')}
          hint="/"
          onClick={then(() => setLoop({ ...loop, on: !loop.on }))}
        />
      )}
      {(loop || mark) && <Sep />}
      <Item label={tr(`小節 ${toMeasure(m)} をループ`, `Loop measure ${toMeasure(m)}`)} onClick={then(() => loopMeasure(m))} />
      <Item label={tr('ここを A（始まり）にする', 'Set A (start) here')} onClick={then(() => setLoopPoint('a', beat))} />
      <Item label={tr('ここを B（終わり）にする', 'Set B (end) here')} onClick={then(() => setLoopPoint('b', beat))} />
    </>
  );
}

// ---- 曲の終わり（END） ------------------------------------------------------------

function EndMenu() {
  const doc = useEditor((s) => s.doc);
  const auto = autoEndMeasure(doc) !== null;
  return (
    <>
      <div className="ctx-head">
        <b>{tr('曲の終わり（END）', 'Song end (END)')}</b>
        <span className="ctx-head-sub mono">{tr(`小節 ${toMeasure(songEndM(doc))}`, `Measure ${toMeasure(songEndM(doc))}`)}</span>
      </div>
      <Item
        label={auto ? tr('原曲の鳴り終わりに合わせる', 'Match where the original audio ends') : tr('自動（最後のチップのすぐ後）に戻す', 'Back to automatic (right after the last chip)')}
        hint={useDevice.getState().tablet ? undefined : tr('ダブルクリック', 'Double-click')}
        disabled={doc.endMeasure === undefined}
        onClick={then(resetSongEnd)}
      />
      <Item label={tr('最後のチップのすぐ後にする', 'Right after the last chip')} onClick={then(songEndAtLastChip)} />
      <Item label={tr('▶ の所にする', 'At ▶')} onClick={then(songEndAtCursor)} />
    </>
  );
}

// ---- 下のトラックの高さ（PC） --------------------------------------------------------

function TracksMenu({ rows }: { rows: number }) {
  const l = useLayout();
  const maxH = maxTracksH();
  const cur = currentTrackStop(l, rows, maxH);
  return (
    <>
      <div className="ctx-head">
        <b>{tr('下のトラックの高さ', 'Height of the bottom tracks')}</b>
      </div>
      {DESK_TRACK_STOPS.map((s) => {
        // 画面に入らない高さも選べる（入るところまで。窓を高くすればその高さに）
        const fits = s === 'closed' || deskStopHeight(s, rows, SEEK_CLOSED_H) <= maxH;
        return (
          <button key={s} className={`ctx-item ctx-stop ${cur === s ? 'on' : ''}`} role="menuitemradio" aria-checked={cur === s} onClick={then(() => setTrackStop(s, rows))}>
            <span className="ctx-ic">{cur === s ? Icon.check(12) : null}</span>
            <span className="ctx-label">{trackStopLabel(s)}</span>
            <span className="ctx-stop-note">{fits ? trackStopNote(s) : tr('画面に入るところまで', 'As tall as fits')}</span>
          </button>
        );
      })}
      <div className="ctx-note">
        {tr('上の境目をドラッグしても、この高さで止まります（Alt を押しながらなら自由な高さ。境目を選んで ↑↓ キーでも）', 'Dragging the edge above also stops at these heights (hold Alt for any height, or focus the edge and use ↑↓)')}
      </div>
    </>
  );
}
