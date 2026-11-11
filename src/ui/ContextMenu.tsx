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
import { CH, chipColor, DRUM_LANES, drumChannel, isSeChannel, voiceName, type Chip, type ChipKind, type DtxDoc } from '../dtx/model';
import { kindCode, SPECIAL_PRESETS } from '../dtx/kinds';
import { chipAlt, rimWavs } from '../dtx/rim';
import { fittingGrid, GRID_DIVS, onGrid, type Pos } from '../edit/ops';
import { keyLabel, useInputSettings } from '../input/settings';
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
  playFrom,
  previewWav,
  relaneChips,
  resetSongEnd,
  setCursorBeat,
  setKind,
  setView,
  songEndAtCursor,
  songEndAtLastChip,
  toast,
  useEditor,
} from '../store/editor';
import { openMeasureGen, useMeasureGen } from '../store/measureGen';
import { openPhrase } from '../store/phrase';
import { nudgeVel, setVelOf, velStep, velPresetNames } from '../store/velocity';
import { placeSongBpm } from '../store/songSync';
import { makeChipsSpecial, openKindSettings, pickNewKind, placeSpecial, setChipsAuto, unmakeSpecial } from '../store/special';
import { chipSpecialKind, destCode, specialKind, specialKinds, specialLayout, type SpecialLayout } from '../store/specialLayout';
import { canCutChip, cutSources, cutSpotAt, openCutAtChip, openCutAtSpot } from '../store/cut';
import { useSidecar } from '../store/sidecar';
import { addCurve, applyTemplate, deletePoint, FX_SHAPES, openFx, removeCurve, setPointShape, shapeName, templateNote, typeName, valueText } from '../store/fx';
import { FX_COLORS, pointBeat, sortPoints } from '../fx/model';
import { FX_TEMPLATES, type FxTemplate, type FxTemplateId } from '../fx/templates';
import { openSectionEditor } from './ChartCanvas';
import { promptDialog } from './dialogs';
import { channelName, chipBpmLabel, chipName, formatPosition, formatTime, meterLabel } from './format';
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
  // スマホは下からのシート（指の右に出す場所が無い）
  const sheet = useDevice((s) => s.phone);
  const pressedIn = useRef(false);
  // 画面からはみ出さないように（右が足りなければマウスの左、下が足りなければ上へずらす）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || sheet) return;
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
  }, [menu.x, menu.y, menu.touch, sheet]);
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
  const body =
    menu.kind === 'chips' ? (
      <ChipMenu ids={menu.ids} anchor={menu.anchor} seq={menu.seq} />
    ) : menu.kind === 'space' ? (
      <SpaceMenu menu={menu} />
    ) : menu.kind === 'measure' ? (
      <MeasureMenu m={menu.m} />
    ) : menu.kind === 'loop' ? (
      <LoopMenu beat={menu.beat} />
    ) : menu.kind === 'tracks' ? (
      <TracksMenu rows={menu.rows} />
    ) : menu.kind === 'wave' ? (
      <WaveMenu menu={menu} />
    ) : menu.kind === 'fx' ? (
      <FxMenu menu={menu} />
    ) : (
      <EndMenu />
    );
  if (sheet) {
    // 下からのシート：後ろを暗くし（押すと閉じる）、つまみと ✕ を付ける。
    // 長押しで開くと、離した指の下にシートの項目が来て、ブラウザがそこを「クリック」することがある。
    // シートの中で押し始めたクリックだけを受ける（キーボードのクリックは detail が 0）
    return (
      <>
        <div className="ctx-back" aria-hidden="true" />
        <div
          ref={ref}
          className={`ctx-menu touch sheet k-${menu.kind}`}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDownCapture={() => {
            pressedIn.current = true;
          }}
          onClickCapture={(e) => {
            if (pressedIn.current || e.detail === 0) return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="ctx-grab">
            <i />
          </div>
          <button className="ctx-x" onClick={() => closeCtxMenu()} aria-label={tr('閉じる', 'Close')}>
            {Icon.close(20)}
          </button>
          <div className="ctx-sheet-body">{body}</div>
        </div>
      </>
    );
  }
  return (
    <div
      ref={ref}
      className={`ctx-menu ${menu.kind === 'chips' || menu.kind === 'tracks' ? 'wide' : ''} ${menu.touch ? 'touch' : ''}`}
      role="menu"
      style={{ left: at?.left ?? menu.x, top: at?.top ?? menu.y, visibility: at ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {body}
    </div>
  );
}

// ---- 部品 ---------------------------------------------------------------------

/** キーボードのショートカットの文字か（スマホでは出さない） */
const isKeyHint = (h: string) => /^(Ctrl|Alt|Shift|Delete|Esc|F\d|\[|\]|[A-Z]$|\/$)/.test(h);

function Item({ icon, label, hint, onClick, disabled, danger, title }: { icon?: ReactNode; label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }) {
  const showHint = hint && !(useDevice.getState().phone && isKeyHint(hint));
  return (
    <button className={`ctx-item ${danger ? 'danger' : ''}`} role="menuitem" disabled={disabled} onClick={onClick} title={title}>
      <span className="ctx-ic">{icon}</span>
      <span className="ctx-label">{label}</span>
      {showHint && <span className="key">{hint}</span>}
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

/** 小節のドラムのチップ（特殊ノーツも） */
function drumIdsIn(doc: DtxDoc, m: number): number[] {
  return chipViews(doc)
    .filter((v) => (v.col >= 0 || v.sp !== undefined) && v.c.m === m)
    .map((v) => v.c.id);
}

function loopMeasure(m: number) {
  const t = tempoOf(useEditor.getState().doc);
  setLoop({ on: true, a: t.measureStart(m), b: t.measureStart(m + 1) });
}

/** 鳴らして聴けるチップか（ドラムと、自動で鳴らす SE） */
const audible = (ch: number) => !!drumChannel(ch) || isSeChannel(ch);

/** チップの音を鳴らす（「チップを置いた・動かしたときに音を鳴らす」を切っていれば鳴らさない） */
function hear(ids: readonly number[], anchor: number, force = false) {
  const s = useEditor.getState();
  if (!force && !s.previewOnPlace) return;
  const want = new Set(ids);
  const c = s.doc.chips.find((x) => x.id === anchor && want.has(x.id) && audible(x.ch)) ?? s.doc.chips.find((x) => want.has(x.id) && audible(x.ch));
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
  if (Number.isFinite(bpm) && bpm > 0) placeSongBpm(pos, bpm);
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
  // 特殊ノーツ（クラップなど）のチップは、レーン・HHオープン・種類（不可視など）の操作の代わりに特殊ノーツの操作を出す
  const lay = specialLayout(doc);
  const spOf = (c: Chip) => chipSpecialKind(lay, c);
  const spChips = chips.filter((c) => spOf(c) !== undefined);
  const spIds = spChips.map((c) => c.id);
  const drums = chips.filter((c) => drumChannel(c.ch) && spOf(c) === undefined);
  const drumIds = drums.map((c) => c.id);
  // ベロシティ・試聴はドラムと特殊ノーツ（自動で鳴らすチップも）
  const velIds = chips.filter((c) => drumChannel(c.ch) || spOf(c) !== undefined).map((c) => c.id);
  const one = chips.length === 1 ? chips[0] : null;
  const oneSp = one ? spOf(one) : undefined;
  const oneKind = oneSp ? lay.kinds.find((k) => k.id === oneSp) : undefined;
  const lanes = new Set(drums.map((c) => drumChannel(c.ch)!.lane));
  const kinds = new Set(drums.map((c) => drumChannel(c.ch)!.kind));
  const altLanes = [...lanes].filter((l) => DRUM_LANES[l].alt !== undefined).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const oneInfo = one ? drumChannel(one.ch) : undefined;
  // 2種目（HHオープン・左バスドラム・スネアのリム。リムは音で見分ける）
  const rims = rimWavs(doc);
  const isAlt = (c: Chip) => chipAlt(doc, c, rims);
  const color = oneKind ? oneKind.color : oneInfo && one ? chipColor(oneInfo.lane, isAlt(one)) : one ? '#8B95A4' : 'var(--accent)';
  const isBpm = one && (one.ch === CH.BPM || one.ch === CH.BPM_EX);
  const extras = chipMenuExtras(ids);
  // 音を切り出す（右クリックしたチップの所から。ドラムの通常チップ・特殊ノーツ）
  const anchorChip = chips.find((c) => c.id === anchor) ?? one;
  const cutAt = anchorChip && canCutChip(doc, anchorChip) ? anchorChip : null;
  // 特殊ノーツにできるチップ（ドラムの通常チップ・自動で鳴らす SE で、まだ特殊ノーツでないもの）
  const makeIds = chips.filter((c) => (drumChannel(c.ch)?.kind === 'normal' || isSeChannel(c.ch)) && spOf(c) === undefined).map((c) => c.id);

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
        {oneKind ? <span className="ctx-sp-pill" style={{ ['--c' as string]: oneKind.color }} /> : <span className="dot" style={{ background: color, width: 10, height: 10, flex: 'none' }} />}
        <b className="ellipsis">{oneKind ? oneKind.name : one ? chipName(doc, one) : tr(`${chips.length} 個のチップ`, `${chips.length} ${pl(chips.length, 'chip')}`)}</b>
        {oneKind && one && (
          <span className="ctx-sp-dest mono" title={isSeChannel(one.ch) ? tr('自動で鳴らす（叩かない）', 'Plays automatically (not hit)') : tr(`ゲームでは${voiceName(one.ch)}のチップ`, `A ${voiceName(one.ch)} chip in the game`)}>
              →{isSeChannel(one.ch) ? destCode('auto') : destCode(one.ch)}
          </span>
        )}
        <span className="ctx-head-sub mono ellipsis">{one ? `${toMeasure(one.m)} · ${fracToString(one.f)}` : laneSummary(chips, lay)}</span>
        {velIds.length > 0 && (
          <button className="ib tiny" onClick={() => hear(velIds, anchor, true)} title={tr('音を聴く', 'Listen')} aria-label={tr('音を聴く', 'Listen')}>
            {Icon.speaker(13)}
          </button>
        )}
      </div>
      {velIds.length > 0 && (
        <>
          <VelBlock ids={velIds} anchor={anchor} group={`ctx-vel-${seq}`} />
          <Sep />
        </>
      )}
      {drums.length > 0 && !useDevice.getState().phone && (
        <>
          <FxTemplateBlock ids={drumIds} />
          <Sep />
        </>
      )}
      {spChips.length > 0 && <SpecialChipBlock chips={spChips} ids={spIds} lay={lay} anchor={anchor} />}
      {drums.length > 0 && (
        <>
          {altLanes.map((lane) => {
            const def = DRUM_LANES[lane];
            const inLane = drums.filter((c) => drumChannel(c.ch)!.lane === lane);
            const nAlt = inLane.filter(isAlt).length;
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
        </>
      )}
      {makeIds.length > 0 && <MakeSpecialBlock ids={makeIds} doc={doc} />}
      {cutAt && (
        <Item
          icon={Icon.extract(12)}
          label={tr('この所の音を切り出す…', 'Extract the sound here…')}
          disabled={cutSources().length === 0}
          title={cutSources().length === 0 ? tr('切り出す元（原曲・ステム）がありません', 'There is no audio to extract from (original or stems)') : tr('ステムや原曲から、この所の音を WAV にして使う', 'Make the sound here into a WAV from the stems or the original, and use it')}
          onClick={then(() => openCutAtChip(cutAt.id))}
        />
      )}
      {(drums.length > 0 || makeIds.length > 0 || cutAt) && <Sep />}
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

/**
 * 特殊ノーツのチップの操作：種類を変える（いちばん左はふつうのチップに戻す）・＋で種類を足す、
 * このチップを叩く（行き先のレーン）か自動で鳴らすか
 */
function SpecialChipBlock({ chips, ids, lay, anchor }: { chips: Chip[]; ids: number[]; lay: SpecialLayout; anchor: number }) {
  const kindIds = new Set(chips.map((c) => chipSpecialKind(lay, c)!));
  const kinds = lay.kinds;
  const oneKind = kindIds.size === 1 ? kinds.find((k) => kindIds.has(k.id)) : undefined;
  const autoN = chips.filter((c) => isSeChannel(c.ch)).length;
  // ふつうのチップに戻すときのレーン：レーンのチップはそのレーン、自動のチップは行き先のレーン
  const backCh = new Set(
    chips.map((c) => {
      if (!isSeChannel(c.ch)) return c.ch;
      const k = kinds.find((x) => x.id === chipSpecialKind(lay, c));
      return k && k.dest !== 'auto' ? k.dest : -1;
    }),
  );
  const noLane = backCh.has(-1);
  const backName = backCh.size === 1 && !noLane ? voiceName([...backCh][0]) : tr('ふつうのチップ', 'Normal chip');
  const destLess = [...kindIds].every((id) => kinds.find((k) => k.id === id)?.dest === 'auto');
  const hitLabel = oneKind && oneKind.dest !== 'auto' ? tr(`叩く（${destCode(oneKind.dest)}）`, `Hit (${destCode(oneKind.dest)})`) : tr('叩く', 'Hit');
  const toKind = (id: string) => {
    closeCtxMenu();
    if (kindIds.size === 1 && kindIds.has(id)) return;
    if (makeChipsSpecial(ids, id)) hear(ids, anchor);
  };
  const toPlain = () => {
    closeCtxMenu();
    if (unmakeSpecial(ids)) hear(ids, anchor);
  };
  const addKind = async () => {
    closeCtxMenu();
    const id = await pickNewKind();
    if (id) makeChipsSpecial(ids, id);
  };
  const setAuto = (auto: boolean) => {
    closeCtxMenu();
    setChipsAuto(ids, auto);
  };
  return (
    <>
      <div className="ctx-sec">
        <div className="ctx-sec-title">
          <span>{tr('特殊ノーツ', 'Special note')}</span>
          <span className="ctx-dim">{tr('同じ時刻のまま・音もその種類に', 'Same timing · uses that kind\'s sound')}</span>
        </div>
        <div className="ctx-kinds">
          <button
            className="ctx-kind plain"
            disabled={noLane}
            onClick={toPlain}
            title={
              noLane
                ? tr('行き先が「自動で鳴らす」の種類は、ふつうのチップに戻すレーンがありません（種類の設定で行き先を選んでください）', 'Kinds that play automatically have no lane to go back to (choose a destination in the kind settings)')
                : tr(`特殊ノーツをやめて、ふつうの${backName}のチップにする（音も${backName}の音に）`, `Stop being a special note and become a normal ${backName} chip (with the ${backName} sound)`)
            }
          >
            {backName}
          </button>
          {kinds.map((k) => (
            <button
              key={k.id}
              className={`ctx-kind ${kindIds.size === 1 && kindIds.has(k.id) ? 'on' : kindIds.has(k.id) ? 'some' : ''}`}
              style={{ ['--c' as string]: k.color }}
              onClick={() => toKind(k.id)}
              title={k.dest === 'auto' ? tr(`${k.name}にする（自動で鳴らす）`, `Make it ${k.name} (plays automatically)`) : tr(`${k.name}にする（${voiceName(k.dest)}へ）`, `Make it ${k.name} (to ${voiceName(k.dest)})`)}
            >
              <span className="sp" />
              {k.name}
            </button>
          ))}
          <button className="ctx-kind add" onClick={() => void addKind()} title={tr('特殊ノーツの種類を足す', 'Add a kind of special note')} aria-label={tr('特殊ノーツの種類を足す', 'Add a kind of special note')}>
            {Icon.plus(12)}
          </button>
        </div>
      </div>
      <div className="ctx-row">
        <span className="ctx-row-label wide">{chips.length === 1 ? tr('このチップ', 'This chip') : tr('選んだチップ', 'Selected')}</span>
        <div className="ctx-tri two">
          <button
            className={autoN === 0 ? 'on' : ''}
            disabled={destLess && autoN === chips.length}
            title={destLess ? tr('行き先が「自動で鳴らす」の種類です。叩くには種類の設定で行き先のレーンを選んでください', 'This kind plays automatically. Choose a lane in its settings to make it playable') : tr('ゲームで行き先のレーンのチップとして叩く', 'Hit it in the game as a chip on the destination lane')}
            onClick={() => setAuto(false)}
          >
            {hitLabel}
          </button>
          <button className={autoN === chips.length ? 'on' : ''} title={tr('叩かずに、BGM と同じように自動で鳴らす', 'Plays automatically like the BGM; not hit')} onClick={() => setAuto(true)}>
            {tr('自動で鳴らす', 'Auto-play')}
          </button>
        </div>
      </div>
      <Sep />
    </>
  );
}

/** ふつうのチップを特殊ノーツにする（行き先のレーンへ動く）。＋ 新しく… で種類を足して、それにする */
function MakeSpecialBlock({ ids, doc }: { ids: number[]; doc: DtxDoc }) {
  const have = specialKinds(doc);
  // まだ種類が無い譜面では、決まった種類（クラップ・タンバリン・カウベル・シェイカー）を並べる
  const list = have.length ? have.map((k) => ({ id: k.id, name: k.name, color: k.color })) : SPECIAL_PRESETS.map((p) => ({ id: p.id, name: p.name, color: p.color }));
  const make = (id: string) => {
    closeCtxMenu();
    if (makeChipsSpecial(ids, id)) hear(ids, ids[0]);
  };
  const makeNew = async () => {
    closeCtxMenu();
    const id = await pickNewKind();
    if (id) makeChipsSpecial(ids, id);
  };
  return (
    <div className="ctx-sec">
      <div className="ctx-sec-title">
        <span>{tr('特殊ノーツにする', 'Make it a special note')}</span>
        <span className="ctx-dim">{tr('行き先のレーンへ動く', 'Moves to its destination lane')}</span>
      </div>
      <div className="ctx-kinds">
        {list.map((k) => (
          <button key={k.id} className="ctx-kind" style={{ ['--c' as string]: k.color }} onClick={() => make(k.id)} title={tr(`${k.name}にする（同じ時刻のまま）`, `Make it ${k.name} (same timing)`)}>
            <span className="sp" />
            {k.name}
          </button>
        ))}
        <button className="ctx-kind add wide" onClick={() => void makeNew()}>
          {tr('＋ 新しく…', '+ New…')}
        </button>
      </div>
    </div>
  );
}

/** 何個のチップか（レーンごと。特殊ノーツは種類ごと。多い順に3つまで） */
function laneSummary(chips: Chip[], lay: SpecialLayout): string {
  const count = new Map<string, number>();
  for (const c of chips) {
    const d = drumChannel(c.ch);
    const sp = chipSpecialKind(lay, c);
    const k = sp ? kindCode(sp) : d ? DRUM_LANES[d.lane].key : channelName(c.ch);
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

// ---- エフェクト --------------------------------------------------------------------

/** テンプレートの小さな絵 */
function FxIcon({ t }: { t: FxTemplate }) {
  const pts = t.icon.map(([x, y]) => `${2 + x * 32},${3 + y * 10}`).join(' ');
  return (
    <svg width="36" height="16" viewBox="0 0 36 16" aria-hidden="true" className="ctx-fx-ic">
      <polyline points={pts} fill="none" stroke={FX_COLORS[t.type]} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 選んだチップのメニューのエフェクト：テンプレートでカーブを引く（選んだチップで決まるのは時間の範囲だけ）。
 * 下にテンプレートの説明（マウスを乗せたもの）と「エフェクトの編集を開く」
 */
function FxTemplateBlock({ ids }: { ids: number[] }) {
  const [hover, setHover] = useState<FxTemplateId>('close');
  const doc = useEditor((s) => s.doc);
  const want = new Set(ids);
  const ms = doc.chips.filter((c) => want.has(c.id)).map((c) => c.m);
  const range = ms.length ? `${toMeasure(Math.min(...ms))}${Math.max(...ms) !== Math.min(...ms) ? `〜${toMeasure(Math.max(...ms))}` : ''}` : '';
  return (
    <>
      <div className="ctx-sec ctx-fx">
        <div className="ctx-sec-title">
          <span className="ctx-fx-title">
            {Icon.fx(12)} {tr('エフェクト', 'Effect')}
          </span>
          <span className="ctx-dim mono">{tr(`${range} 小節に`, `measures ${range}`)}</span>
        </div>
        <div className="ctx-fx-grid">
          {FX_TEMPLATES.map((t) => (
            <button
              key={t.id}
              className={`ctx-fx-tile ${t.type === 'hicut' ? '' : 'wide'} ${hover === t.id ? 'hover' : ''}`}
              style={{ ['--c' as string]: FX_COLORS[t.type] }}
              onPointerEnter={() => setHover(t.id)}
              onFocus={() => setHover(t.id)}
              onClick={then(() => void applyTemplate(t.id, ids))}
            >
              <FxIcon t={t} />
              <span>{t.name}</span>
            </button>
          ))}
        </div>
        <div className="ctx-fx-note">{templateNote(hover, ids)}</div>
      </div>
      <Item icon={Icon.fx(12)} label={tr('エフェクトの編集を開く', 'Open the effect editor')} hint="E" onClick={then(() => openFx(true))} />
    </>
  );
}

/** エフェクトの列の右クリック：点なら形・消す、何もない所ならカーブを足す */
function FxMenu({ menu }: { menu: Extract<CtxMenu, { kind: 'fx' }> }) {
  const side = useSidecar((s) => s.fx);
  const doc = useEditor((s) => s.doc);
  const c = menu.curveId ? side?.curves.find((x) => x.id === menu.curveId) : undefined;
  const at = menu.point;
  const p = c && at !== null ? sortPoints(c.points)[at] : undefined;
  if (c && p && at !== null) {
    const tempo = tempoOf(doc);
    return (
      <>
        <div className="ctx-head">
          <span className="dot" style={{ background: FX_COLORS[c.type], width: 10, height: 10, flex: 'none' }} />
          <b>{typeName(c.type)}</b>
          <span className="ctx-head-sub mono ellipsis">
            {formatPosition(tempo, pointBeat(tempo, p))} · {valueText(c.type, p.v)}
          </span>
        </div>
        <div className="ctx-sec">
          <div className="ctx-sec-title">
            <span>{tr('次の点まで', 'To the next point')}</span>
          </div>
          <div className="ctx-fx-shapes">
            {FX_SHAPES.map((sh) => (
              <button key={sh} className={(p.s ?? 'smooth') === sh ? 'on' : ''} onClick={then(() => setPointShape(c.id, at, sh))}>
                {shapeName(sh)}
              </button>
            ))}
          </div>
        </div>
        <Sep />
        <Item icon={Icon.trash(13)} danger label={tr('この点を消す', 'Delete this point')} hint="Delete" onClick={then(() => deletePoint(c.id, at))} />
        <Item danger label={tr('このカーブを消す', 'Delete this curve')} onClick={then(() => removeCurve(c.id))} />
      </>
    );
  }
  return (
    <>
      <div className="ctx-head">
        <span className="ctx-fx-title">{Icon.fx(12)}</span>
        <b>{tr('エフェクト', 'Effect')}</b>
      </div>
      {(['hicut', 'locut', 'pitch'] as const).map((t) => (
        <Item key={t} icon={<span className="dot" style={{ background: FX_COLORS[t], width: 8, height: 8 }} />} label={tr(`${typeName(t)}のカーブを足す`, `Add a ${typeName(t).toLowerCase()} curve`)} onClick={then(() => void addCurve(t))} />
      ))}
      <Sep />
      <Item label={tr('エフェクトの編集を閉じる', 'Close the effect editor')} hint="E" onClick={then(() => openFx(false))} />
    </>
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
  // スマホ：BPM の列・ループの帯が無いので、BPM 変化と A・B もここから
  const phone = useDevice((s) => s.phone);
  const tablet = useDevice((s) => s.tablet);
  const m = menu.pos.m;
  const inMeasure = drumIdsIn(doc, m);
  const extras = menu.col === 'lane' && menu.lane !== undefined ? laneMenuExtras({ lane: menu.lane, alt: !!menu.alt, pos: menu.pos }) : [];
  // 特殊ノーツ：種類の列ならその種類、行き先のレーンに重ねて見せているときは、そのレーン（自動の種類は BGM の列）が行き先の種類
  const lay = specialLayout(doc);
  const spHere = menu.col === 'sp' && menu.sp ? specialKind(doc, menu.sp) : undefined;
  const spOver =
    lay.on && !lay.cols
      ? lay.kinds.filter((k) => (menu.col === 'lane' && menu.lane !== undefined && k.dest !== 'auto' && drumChannel(k.dest)?.lane === menu.lane) || (menu.col === 'bgm' && k.dest === 'auto'))
      : [];
  const spList = spHere ? [spHere] : spOver;
  const place = (id: string, auto = false) => () => {
    closeCtxMenu();
    placeSpecial(id, menu.pos, { auto, select: true, preview: true });
  };
  return (
    <>
      {(phone || spHere) && (
        <div className="ctx-head">
          {spHere && <span className="ctx-sp-pill" style={{ ['--c' as string]: spHere.color }} />}
          <b className="mono">{formatPosition(tempoOf(doc), menu.beat)}</b>
          <span className="ctx-head-sub">{spHere ? tr(`${spHere.name}の列`, `${spHere.name} column`) : tr('何もない所', 'Empty spot')}</span>
        </div>
      )}
      {phone ? <PhoneGridPicker /> : <GridPicker m={m} />}
      {(extras.length > 0 || spList.length > 0) && <Sep />}
      {spHere && (
        <>
          <Item
            icon={<span className="ctx-sp-pill" style={{ ['--c' as string]: spHere.color }} />}
            label={tr(`ここに${spHere.name}を置く`, `Place ${spHere.name} here`)}
            hint={tablet ? tr('タップ', 'Tap') : tr('クリック', 'Click')}
            onClick={place(spHere.id)}
          />
          {spHere.dest !== 'auto' && <Item label={tr('自動で鳴らして置く', 'Place as auto-play')} hint={tr('叩かない', 'Not hit')} onClick={place(spHere.id, true)} />}
        </>
      )}
      {extras.map((it, i) => (
        <ExtraItem key={i} it={it} />
      ))}
      {spOver.map((k) => (
        <Item
          key={k.id}
          icon={<span className="ctx-sp-pill" style={{ ['--c' as string]: k.color }} />}
          label={tr(`ここに${k.name}を置く`, `Place ${k.name} here`)}
          hint={k.key && !phone ? keyLabel(k.key) : undefined}
          onClick={place(k.id)}
        />
      ))}
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
      {phone && (
        <>
          <Item icon={<b className="ctx-ab">A</b>} label={tr('ここを A（始まり）にする', 'Set A (start) here')} onClick={then(() => setLoopPoint('a', menu.beat))} />
          <Item icon={<b className="ctx-ab">B</b>} label={tr('ここを B（終わり）にする', 'Set B (end) here')} onClick={then(() => setLoopPoint('b', menu.beat))} />
        </>
      )}
      {(menu.col === 'bpm' || phone) && (
        <Item
          icon={phone ? Icon.metronome(18) : undefined}
          label={tr('ここに BPM 変化を置く…', 'Place a BPM change here…')}
          hint={phone ? undefined : useDevice.getState().tablet ? tr('タップ', 'Tap') : dblHint()}
          onClick={then(() => void askBpm(menu.pos))}
        />
      )}
      {spList.length > 0 && <Sep />}
      {spList.map((k) => (
        <Item key={k.id} icon={Icon.gear(13)} label={tr(`${k.name}の設定…`, `${k.name} settings…`)} onClick={then(() => openKindSettings(k.id, menu.x, menu.y))} />
      ))}
    </>
  );
}

/** スマホのグリッド：4 列のボタン（1/4〜1/48 と任意） */
function PhoneGridPicker() {
  const div = useEditor((s) => s.view.div);
  const divs = [4, 8, 12, 16, 24, 32, 48];
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
  return (
    <div className="ctx-sec">
      <div className="ctx-sec-title">
        <span>
          {tr('グリッド', 'Grid')} <b className="mono ctx-cur">1/{div}</b>
        </span>
      </div>
      <div className="ctx-grid4">
        {divs.map((d) => (
          <button
            key={d}
            className={`ctx-grid-btn mono ${div === d ? 'on' : ''}`}
            onClick={() => {
              closeCtxMenu();
              setView({ div: d });
            }}
          >
            1/{d}
          </button>
        ))}
        <button className={`ctx-grid-btn ${divs.includes(div) ? '' : 'on'}`} onClick={() => void custom()}>
          {divs.includes(div) ? tr('任意…', 'Custom…') : tr(`任意 ${div}…`, `Custom ${div}…`)}
        </button>
      </div>
    </div>
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
  const phone = useDevice((s) => s.phone);
  const ids = drumIdsIn(doc, m);
  const tempo = tempoOf(doc);
  const chipsText = ids.length ? tr(`チップ ${ids.length} 個`, `${ids.length} ${pl(ids.length, 'chip')}`) : tr('空の小節', 'Empty measure');
  return (
    <>
      <div className="ctx-head">
        <b>{tr(`小節 ${toMeasure(m)}`, `Measure ${toMeasure(m)}`)}</b>
        <span className="ctx-head-sub">{phone ? `${meterLabel(tempo.barLen(m))} · BPM ${chipBpmLabel(tempo.bpmAt(tempo.measureStart(m) + 1e-6))} · ${chipsText}` : chipsText}</span>
      </div>
      <Item icon={Icon.sparkle(phone ? 18 : 12)} label={genOpen ? tr('AI の生成をやめる', 'Stop AI generation') : tr('この小節を AI で生成', 'Generate this measure with AI')} hint={phone ? undefined : '✨'} onClick={then(() => openMeasureGen(m))} />
      {phone && (
        <Item
          label={tr('フィル・リズムの候補…', 'Fill and groove ideas…')}
          onClick={then(() => {
            setCursorBeat(tempo.measureStart(m));
            openPhrase();
          })}
        />
      )}
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

// ---- 下のトラックの波形（原曲・ステム） ------------------------------------------------

function WaveMenu({ menu }: { menu: Extract<CtxMenu, { kind: 'wave' }> }) {
  const stems = useSidecar((s) => s.stems);
  const spot = cutSpotAt(menu.sec, menu.tol);
  const name = menu.src === 'orig' ? tr('原曲', 'Original') : (stems.find((t) => t.file === menu.src)?.name ?? menu.src);
  return (
    <>
      <div className="ctx-head">
        <b className="ellipsis">{name}</b>
        <span className="ctx-head-sub mono">{formatTime(spot.sec)}</span>
      </div>
      <Item icon={Icon.extract(12)} label={tr('ここの音を切り出す…', 'Extract the sound here…')} hint={spot.pos} onClick={then(() => openCutAtSpot(menu.src, spot, menu.tol))} />
      <Item
        icon={Icon.play(11)}
        label={tr('ここから再生', 'Play from here')}
        onClick={then(() => {
          setCursorBeat(menu.beat);
          void playFrom(menu.beat);
        })}
      />
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
