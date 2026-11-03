// 右クリックのメニュー。何を右クリックしたかで中身を変える（store/ctxMenu）。
// - チップ：ベロシティ（強・中・弱、±、スライダー、ホイール）・HHオープン/クローズ・レーン・種類・コピー・削除
// - 何もない所：グリッドの切り替え（ボタン1回）・ここから再生・ループ・貼り付け
// - 小節番号・✨ の列：小節の操作。ループの帯：ループの操作。END：曲の終わりの決め方
// 一度で済む操作（強・中・弱、レーン、グリッド、コマンド）は押すと閉じる。±・スライダー・ホイールは開いたまま微調整できる。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { toMeasure } from '../dtx/base36';
import { fracToString } from '../dtx/fraction';
import { CH, DRUM_LANES, drumChannel, type Chip, type ChipKind, type DtxDoc } from '../dtx/model';
import { fittingGrid, GRID_DIVS, onGrid, type Pos } from '../edit/ops';
import { useInputSettings } from '../input/settings';
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
import { nudgeVel, setVelOf, velStep, VEL_PRESET_NAMES } from '../store/velocity';
import { openSectionEditor } from './ChartCanvas';
import { promptDialog } from './dialogs';
import { channelName, chipBpmLabel } from './format';
import { songEndM } from './hooks';
import { Icon } from './icons';

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
      let left = menu.x + 2;
      let top = menu.y + 2;
      if (left + r.width > window.innerWidth - 8) left = Math.max(8, menu.x - r.width - 2);
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - r.height);
      setAt((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [menu.x, menu.y]);
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
      className={`ctx-menu ${menu.kind === 'chips' ? 'wide' : ''}`}
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
    title: `小節 ${toMeasure(pos.m)} の BPM`,
    body: 'この位置からのBPMを入力してください（#BPMzz と ch08 で書き出します）。',
    value: chipBpmLabel(cur),
    ok: '決定',
  });
  const bpm = v ? Number(v) : NaN;
  if (Number.isFinite(bpm) && bpm > 0) placeBpmChange(pos, bpm);
}

// ---- チップ -------------------------------------------------------------------

const KINDS: [ChipKind, string, string][] = [
  ['normal', '通常', ''],
  ['hidden', '不可視', '叩く必要はあるが見えないチップ'],
  ['nochip', '音だけ', '空打ちしたときに鳴る音（チップは出ない）'],
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
        <b className="ellipsis">{one ? channelName(one.ch) : `${chips.length} 個のチップ`}</b>
        <span className="ctx-head-sub mono ellipsis">{one ? `${toMeasure(one.m)} · ${fracToString(one.f)}` : laneSummary(chips)}</span>
        {drums.length > 0 && (
          <button className="ib tiny" onClick={() => hear(drumIds, anchor, true)} title="音を聴く" aria-label="音を聴く">
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
              <span>レーンを変える</span>
              <span className="ctx-dim">同じ時刻のまま・音もそのレーンに</span>
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
                    title={`${def.name}${on && lanes.size === 1 ? '（今のレーン）' : 'へ移す'}`}
                    onClick={() => moveTo(lane)}
                  >
                    {def.key}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="ctx-row">
            <span className="ctx-row-label">種類</span>
            <div className="ctx-tri">
              {KINDS.map(([k, label, tip]) => (
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
      {isBpm && <Item label="BPM を変える…" hint="ダブルクリック" onClick={then(() => void askBpm({ m: one!.m, f: one!.f }))} />}
      {extras.map((it, i) => (
        <ExtraItem key={i} it={it} />
      ))}
      {(isBpm || extras.length > 0) && <Sep />}
      <Item
        label="コピー"
        hint="Ctrl+C"
        onClick={then(() => {
          useEditor.setState({ selection: [...ids] });
          copySelection();
        })}
      />
      <Item
        label="切り取り"
        hint="Ctrl+X"
        onClick={then(() => {
          useEditor.setState({ selection: [...ids] });
          cutSelection();
        })}
      />
      <Item icon={Icon.trash(13)} danger label={chips.length > 1 ? `${chips.length} 個を削除` : '削除'} hint={isBpm ? 'Delete' : 'ダブルクリック・Delete'} onClick={then(() => deleteChips(ids))} />
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
    <div className="ctx-sec" ref={box} title={`ホイールでも ±${step}（Shift で 1 ずつ）`}>
      <div className="ctx-sec-title">
        <span>ベロシティ</span>
        <span className="ctx-vel-val mono">{same ? avg : `~${avg}`}</span>
      </div>
      <div className="ctx-tri">
        {VEL_PRESET_NAMES.map((name, i) => (
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
        <button className="ctx-step" onClick={(e) => nudge(-(e.shiftKey ? 1 : step))} title={`-${step}（Shift で -1）`} aria-label="弱く">
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
          aria-label="ベロシティ"
        />
        <button className="ctx-step" onClick={(e) => nudge(e.shiftKey ? 1 : step)} title={`+${step}（Shift で +1）`} aria-label="強く">
          {Icon.plus(12)}
        </button>
      </div>
    </div>
  );
}

// ---- 何もない所 ----------------------------------------------------------------

/** グリッドのボタンの並び（左ほど粗い）。3連は 8分の3連（1/12）から */
const GRID_ROWS: { label: string; divs: number[] }[] = [
  { label: '通常', divs: [4, 8, 16, 32, 64, 192] },
  { label: '3連', divs: [12, 24, 48, 96] },
  { label: '5・7連', divs: [20, 40, 28] },
];

const GRID_NAME: Record<number, string> = {
  4: '4分',
  8: '8分',
  12: '8分の3連',
  16: '16分',
  20: '16分の5連',
  24: '16分の3連',
  28: '16分の7連',
  32: '32分',
  40: '32分の5連',
  48: '32分の3連',
  64: '64分',
  96: '64分の3連',
  192: 'いちばん細かい',
};

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
    const v = await promptDialog({ title: 'グリッドの細かさ', body: '全音符をいくつに分けるか（1〜192）。5連の16分なら 20、7連なら 28、6連なら 24。', value: String(div), ok: '決定' });
    const n = Math.round(Number(v));
    if (v && n >= 1 && n <= 192) setView({ div: n });
  };
  return (
    <div className="ctx-sec">
      <div className="ctx-sec-title">
        <span>
          グリッド <b className="mono ctx-cur">1/{div}</b>
        </span>
        <span className="ctx-dim" title="[ と ] でも1段ずつ変えられます">
          <kbd>[</kbd> <kbd>]</kbd>
        </span>
      </div>
      {GRID_ROWS.map((row) => (
        <div className="ctx-grid-row" key={row.label}>
          <span className="rl">{row.label}</span>
          {row.divs.map((d) => (
            <button
              key={d}
              className={`ctx-grid-btn mono ${div === d ? 'on' : ''} ${hint === d ? 'fit' : ''}`}
              title={`1/${d}（${GRID_NAME[d]}）${hint === d ? '。この小節のチップが全部乗ります' : ''}`}
              onClick={() => pick(d)}
            >
              {d}
            </button>
          ))}
          {row === GRID_ROWS[GRID_ROWS.length - 1] && (
            <button className="link-btn ctx-custom" onClick={() => void custom()} title="好きな数で分ける（6連なら 24 など）">
              {(GRID_DIVS as readonly number[]).includes(div) ? '任意…' : `任意 ${div}…`}
            </button>
          )}
        </div>
      ))}
      {hint !== null && (
        <div className="ctx-fit-note">
          <span className="fit-dot" />
          小節 {toMeasure(m)} のチップは 1/{hint} なら全部乗ります
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
      <Item icon={Icon.play(11)} label="ここから再生" hint="▶ をここに" onClick={then(() => void playFrom(menu.beat))} />
      <Item icon={Icon.loop(12)} label={`小節 ${toMeasure(m)} をループ`} onClick={then(() => loopMeasure(m))} />
      <Item label={clip ? `ここに貼り付け（${clip} 個）` : 'ここに貼り付け'} hint="Ctrl+V" disabled={!clip} title={clip ? undefined : 'コピーしたチップがありません'} onClick={then(() => paste(menu.beat))} />
      <Item
        label={`小節 ${toMeasure(m)} のチップを選ぶ`}
        hint={inMeasure.length ? `${inMeasure.length} 個` : undefined}
        disabled={!inMeasure.length}
        onClick={then(() => useEditor.setState({ selection: inMeasure }))}
      />
      {menu.col === 'bpm' && <Item label="ここに BPM 変化を置く…" hint="ダブルクリック" onClick={then(() => void askBpm(menu.pos))} />}
    </>
  );
}

// ---- 小節番号・✨ の列 -----------------------------------------------------------

function deleteMeasureWithToast(m: number) {
  const r = deleteMeasures(m, 1);
  toast(`小節 ${toMeasure(m)} を削除しました（チップ ${r.removed} 個${r.kept ? `、BPM変化・BGMの開始 ${r.kept} 個は次の小節の頭へ移動` : ''}）。Ctrl+Z で戻せます`, 'ok', 6000);
}

function MeasureMenu({ m }: { m: number }) {
  const doc = useEditor((s) => s.doc);
  const genOpen = useMeasureGen((s) => s.open && s.from === m && s.to === m);
  const ids = drumIdsIn(doc, m);
  const tempo = tempoOf(doc);
  return (
    <>
      <div className="ctx-head">
        <b>小節 {toMeasure(m)}</b>
        <span className="ctx-head-sub">{ids.length ? `チップ ${ids.length} 個` : '空の小節'}</span>
      </div>
      <Item icon={Icon.sparkle(12)} label={genOpen ? 'AI の生成をやめる' : 'この小節を AI で生成'} hint="✨" onClick={then(() => openMeasureGen(m))} />
      <Item icon={Icon.play(11)} label="この小節から再生" onClick={then(() => void playFrom(tempo.measureStart(m)))} />
      <Item icon={Icon.loop(12)} label="この小節をループ" onClick={then(() => loopMeasure(m))} />
      <Item label="この小節のチップを選ぶ" hint={ids.length ? `${ids.length} 個` : undefined} disabled={!ids.length} onClick={then(() => useEditor.setState({ selection: ids }))} />
      <Item label="セクション名を付ける…" hint="ダブルクリック" onClick={then(() => openSectionEditor(m))} />
      <Sep />
      <Item label="前の小節をこの小節に写す" disabled={m === 0} title="この小節のドラムを、前の小節と同じにします（Ctrl+D は ▶ の小節）" onClick={then(() => duplicatePrevMeasure(m))} />
      <Item label="この小節の前に 1 小節入れる" onClick={then(() => insertMeasures(m))} />
      <Item label="この小節を削除して詰める" danger onClick={then(() => deleteMeasureWithToast(m))} />
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
          label={loop ? 'ループを消す' : `${mark!.side === 'a' ? 'A' : 'B'} の印を消す`}
          onClick={then(() => setLoop(null))}
        />
      )}
      {loop && <Item icon={Icon.loop(12)} label={loop.on ? 'ループを止める（範囲は残す）' : 'ループをオンにする'} hint="/" onClick={then(() => setLoop({ ...loop, on: !loop.on }))} />}
      {(loop || mark) && <Sep />}
      <Item label={`小節 ${toMeasure(m)} をループ`} onClick={then(() => loopMeasure(m))} />
      <Item label="ここを A（始まり）にする" onClick={then(() => setLoopPoint('a', beat))} />
      <Item label="ここを B（終わり）にする" onClick={then(() => setLoopPoint('b', beat))} />
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
        <b>曲の終わり（END）</b>
        <span className="ctx-head-sub mono">小節 {toMeasure(songEndM(doc))}</span>
      </div>
      <Item
        label={auto ? '原曲の鳴り終わりに合わせる' : '自動（最後のチップのすぐ後）に戻す'}
        hint="ダブルクリック"
        disabled={doc.endMeasure === undefined}
        onClick={then(resetSongEnd)}
      />
      <Item label="最後のチップのすぐ後にする" onClick={then(songEndAtLastChip)} />
      <Item label="▶ の所にする" onClick={then(songEndAtCursor)} />
    </>
  );
}
