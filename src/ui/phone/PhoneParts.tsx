// スマホ版の小さな部品（承認されたデザイン「スマホ」の実寸）。縦と横の両方で使う
// グリッド・強さの小窓、難易度 ▼、再生の速さ、音量の小窓、▶ の位置
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tr } from '../../i18n';
import { switchDifficulty } from '../../app/fileActions';
import { ORIGIN_KEY, originOf } from '../../dtx/origin';
import { gridLabel } from '../../edit/ops';
import { setSpeed, useAssist } from '../../store/assist';
import { markDismissPress } from '../../store/ctxMenu';
import { tempoOf } from '../../store/derived';
import { openPhoneTab } from '../../store/device';
import { currentBeat, openPage, playFrom, setMix, setView, toast, useEditor } from '../../store/editor';
import { glowsDiff, useGlowDiffs } from '../../store/glow';
import { useSidecar } from '../../store/sidecar';
import { analysisMark, chooseAnalysisStem, soloOnly, useStems } from '../../store/stems';
import { setPreset, useVel, velPresetNames } from '../../store/velocity';
import { useInputSettings } from '../../input/settings';
import { pickBgmFile } from '../../app/fileActions';
import { promptDialog } from '../dialogs';
import { formatPosition, formatTime } from '../format';
import { usePlayBeat } from '../hooks';
import { Icon } from '../icons';
import { OriginBadge } from '../OriginBadge';
import { abbrDiff } from '../TopBar';
import { askMeasureJump } from '../Transport';
import { releaseFocus, rowAudible, setTrack, silentWhy, trackMix, useTrackRows, type TrackRow } from '../Tracks';

/** 小窓を出す向き：up（下の帯から上へ）・right（横の左の道具から右へ）・left（横の右の帯から左へ）・down（上のバーから下へ） */
export type PopDir = 'up' | 'up-end' | 'right' | 'left' | 'down';

/** 時刻（分:秒.1/100 秒） */
export function time2(sec: number): string {
  return formatTime(sec).slice(0, -1);
}

/** 押すと開く小窓。外を押すか Esc で閉じる（閉じるために譜面を押しても、置いたり選んだりしない） */
function usePop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      setOpen(false);
      markDismissPress(e.timeStamp);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

// ---- グリッド ---------------------------------------------------------------------------

/** グリッドの選び方（デザインの 4 列：1/4〜1/48 と任意） */
const PHONE_DIVS = [4, 8, 12, 16, 24, 32, 48];

export async function askCustomGrid() {
  const div = useEditor.getState().view.div;
  const v = await promptDialog({
    title: tr('グリッドの細かさ', 'Grid resolution'),
    body: tr('全音符をいくつに分けるか（1〜192）。5連の16分なら 20、7連なら 28、6連なら 24。', 'How many parts to divide a whole note into (1–192). 16th quintuplets: 20, septuplets: 28, sextuplets: 24.'),
    value: String(div),
    ok: tr('決定', 'OK'),
  });
  const n = Math.round(Number(v));
  if (v && n >= 1 && n <= 192) setView({ div: n });
}

/** グリッドのボタンの並び（4 列）。押したら onPick */
export function GridOptions({ onPick }: { onPick?: () => void }) {
  const div = useEditor((s) => s.view.div);
  return (
    <div className="p-grid-opts">
      {PHONE_DIVS.map((d) => (
        <button
          key={d}
          className={`p-gridbtn mono ${div === d ? 'on' : ''}`}
          onClick={() => {
            setView({ div: d });
            onPick?.();
          }}
          aria-pressed={div === d}
        >
          {gridLabel(d)}
        </button>
      ))}
      <button
        className={`p-gridbtn ${PHONE_DIVS.includes(div) ? '' : 'on'}`}
        onClick={() => {
          onPick?.();
          void askCustomGrid();
        }}
      >
        {PHONE_DIVS.includes(div) ? tr('任意…', 'Custom…') : tr(`任意 ${div}…`, `Custom ${div}…`)}
      </button>
    </div>
  );
}

/**
 * グリッドのボタン。look: tool（道具の帯・左の道具：大きな 1/16 と「グリッド」）・chip（シートの見出し：1/16 ▼）
 */
export function GridPick({ look, dir }: { look: 'tool' | 'rail' | 'chip'; dir: PopDir }) {
  const div = useEditor((s) => s.view.div);
  const { open, setOpen, ref } = usePop();
  return (
    <div className="p-popwrap" ref={ref}>
      {look === 'chip' ? (
        <button className={`p-btn sm p-chipbtn ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={tr('グリッド', 'Grid')} title={tr('置く位置の細かさ（グリッド）', 'How finely chips snap (grid)')}>
          <span className="mono">{gridLabel(div)}</span>
          {Icon.chevronDown(12)}
        </button>
      ) : (
        <button className={`p-pt ${look === 'rail' ? 'rail' : ''} ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} title={tr('置く位置の細かさ（グリッド）', 'How finely chips snap (grid)')}>
          <b className="mono p-pt-val">{gridLabel(div)}</b>
          <span>{tr('グリッド', 'Grid')}</span>
        </button>
      )}
      {open && (
        <div className={`p-pop p-grid-pop dir-${dir}`} role="dialog" aria-label={tr('グリッド', 'Grid')}>
          <div className="p-pop-title">
            {tr('グリッド', 'Grid')} <b className="mono">{gridLabel(div)}</b>
          </div>
          <GridOptions onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// ---- 強さ（置くベロシティ） -------------------------------------------------------------------

export function StrengthPick({ look, dir }: { look: 'tool' | 'rail' | 'chip'; dir: PopDir }) {
  const preset = useVel((s) => s.preset);
  const vals = useInputSettings((s) => s.velPresets);
  const names = velPresetNames();
  const { open, setOpen, ref } = usePop();
  return (
    <div className="p-popwrap" ref={ref}>
      {look === 'chip' ? (
        <button className={`p-btn sm p-chipbtn p-vel ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={tr('置く強さ', 'Velocity for new chips')} title={tr('置く強さ', 'Velocity for new chips')}>
          <b>{names[preset]}</b>
          {Icon.chevronDown(12)}
        </button>
      ) : (
        <button className={`p-pt ${look === 'rail' ? 'rail' : ''} ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={tr('置く強さ', 'Velocity for new chips')} title={tr(`置く強さ: ${names[preset]}（${vals[preset]}）`, `Velocity for new chips: ${names[preset]} (${vals[preset]})`)}>
          <b className="p-pt-val p-vel">{names[preset]}</b>
          <span>{tr('強さ', 'Vel.')}</span>
        </button>
      )}
      {open && (
        <div className={`p-pop p-strength-pop dir-${dir}`} role="menu" aria-label={tr('置く強さ', 'Velocity for new chips')}>
          {names.map((n, i) => (
            <button
              key={n}
              role="menuitemradio"
              aria-checked={preset === i}
              className={`p-mi ${preset === i ? 'on' : ''}`}
              onClick={() => {
                setPreset(i as 0 | 1 | 2);
                setOpen(false);
              }}
            >
              <b>{n}</b>
              <span className="grow" />
              <span className="mono p-mi-sub">{vals[i]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 難易度 ▼ ---------------------------------------------------------------------------

/** 難易度の切り替え（易しい順）と「AI で難易度を作る…」 */
export function DiffMenu({ dir }: { dir: PopDir }) {
  const meta = useEditor((s) => s.meta);
  const doc = useEditor((s) => s.doc);
  const mark = doc.fields[ORIGIN_KEY];
  const chips = doc.chips;
  const ownOrigin = useMemo(() => (mark === undefined ? 'human' : originOf({ chips, fields: { [ORIGIN_KEY]: mark } })), [mark, chips]);
  const glowDiffs = useGlowDiffs();
  const { open, setOpen, ref } = usePop();
  const cur = meta.siblings.find((sb) => sb.file.toLowerCase() === meta.fileName.toLowerCase());
  const label = cur ? abbrDiff(cur.label) : 'DTX';
  return (
    <div className="p-popwrap p-diff" ref={ref}>
      <button className={`p-btn sm p-diff-btn ${glowDiffs?.length ? 'glow' : ''} ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={tr('難易度を切り替える', 'Switch difficulty')}>
        <span className="mono">{label}</span>
        {Icon.chevronDown(14)}
      </button>
      {open && (
        <div className={`p-pop p-diff-pop dir-${dir}`} role="menu" aria-label={tr('難易度', 'Difficulty')}>
          {meta.siblings.map((sb) => {
            const on = sb.file.toLowerCase() === meta.fileName.toLowerCase();
            const origin = on ? ownOrigin : (sb.origin ?? 'human');
            return (
              <button
                key={sb.file}
                role="menuitemradio"
                aria-checked={on}
                className={`p-mi ${on ? 'on' : ''} ${glowsDiff(glowDiffs, sb.file) ? 'glow' : ''}`}
                onClick={() => {
                  setOpen(false);
                  if (!on) void switchDifficulty(sb.file);
                }}
              >
                <span className="p-mi-text">
                  <b className="mono ellipsis">{sb.label}</b>
                  <span className="p-mi-sub mono ellipsis">{sb.file}</span>
                </span>
                <OriginBadge origin={origin} tab />
                <span className="p-ck">{on ? Icon.check(18) : null}</span>
              </button>
            );
          })}
          {meta.siblings.length > 0 && <div className="p-sep" />}
          <button
            className="p-mi amber"
            onClick={() => {
              setOpen(false);
              openPage('ai');
            }}
          >
            {Icon.sparkle(18)}
            <span>{tr('AI で難易度を作る…', 'Make difficulties with AI…')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- 再生の速さ ---------------------------------------------------------------------------

/** 再生の速さ（▼ で選ぶ。端末の選び方の小窓を使う） */
export function SpeedPick({ compact = false }: { compact?: boolean }) {
  const speed = useAssist((s) => s.speed);
  const stretching = useAssist((s) => s.stretching);
  return (
    <label className={`p-btn sm p-speed ${compact ? 'compact' : ''} ${speed < 1 ? 'slow' : ''}`} title={tr('再生の速さ。原曲は音程を変えずに遅くします', 'Playback speed. The original slows down without changing pitch')}>
      <select
        value={speed}
        onChange={(e) => {
          setSpeed(Number(e.target.value));
          if (useEditor.getState().playing) void playFrom(currentBeat(), { keepStart: true });
        }}
        aria-label={tr('再生の速さ', 'Playback speed')}
      >
        {[1, 0.75, 0.5, 0.25].map((v) => (
          <option key={v} value={v}>
            {v * 100}%
          </option>
        ))}
      </select>
      <span className="mono">{stretching ? '…' : `${speed * 100}%`}</span>
      {!compact && Icon.chevronDown(12)}
    </label>
  );
}

// ---- ▶ の位置 ---------------------------------------------------------------------------

/** 再生の位置（小節.拍.位置と時刻）。押すと小節番号を入れて移動 */
export function PosBox({ center = false }: { center?: boolean }) {
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  return (
    <button className={`p-pos ${center ? 'center' : ''}`} onClick={() => void askMeasureJump(beat)} title={tr('再生を始める位置（▶）。押すと小節番号を入れて移動', 'Playback start (▶). Tap to jump to a measure number')}>
      <span className="p-pos-main mono">{formatPosition(tempo, beat)}</span>
      <span className="p-pos-sub mono">{time2(tempo.beatToSec(Math.max(0, beat)))}</span>
    </button>
  );
}

// ---- 音量の小窓 -------------------------------------------------------------------------

const pct = (v: number) => Math.round(v * 100);

/** スライダー（6px の溝に色の付いた量、26px のつまみ） */
export function PRange({ value, max, color, label, onChange, onReset }: { value: number; max: number; color: string; label: string; onChange: (v: number) => void; onReset?: () => void }) {
  return (
    <input
      type="range"
      className="p-range"
      min={0}
      max={max}
      step={0.01}
      value={value}
      style={{ ['--c' as string]: color, ['--p' as string]: `${Math.round((value / max) * 1000) / 10}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={onReset}
      aria-label={label}
    />
  );
}

/** 1 本のトラックの行（M・S・音量。原曲とステムは解析に使う ◎ も） */
export function TrackLine({ row, analysis = false, sub = true }: { row: TrackRow; analysis?: boolean; sub?: boolean }) {
  const mix = useEditor((s) => s.mix);
  if (row.type === 'orig' && row.state !== 'ready') {
    return (
      <div className="p-trk-row off" style={{ ['--c' as string]: row.color }}>
        <span className="p-trk-bar" />
        <span className="p-trk-name">
          <b className="ellipsis">{row.name}</b>
          <span className="mono ellipsis">{row.state === 'missing' ? tr('見つかりません', 'Not found') : row.state === 'loading' ? tr('読み込み中…', 'Loading…') : tr('まだありません', 'None yet')}</span>
        </span>
        <span className="grow" />
        {row.state !== 'loading' && (
          <button className="p-btn sm" onClick={pickBgmFile}>
            {Icon.plus(14)}
            <span>{tr('原曲を読み込む', 'Load original')}</span>
          </button>
        )}
      </div>
    );
  }
  const on = rowAudible(row);
  const { muted, soloed, gain, maxGain, defGain } = trackMix(row, mix);
  const why = silentWhy(row, mix, on, muted, soloed);
  const mark = analysis && (row.type === 'stem' || row.type === 'orig') ? analysisMark(row.id) : null;
  const isAnalysis = !!mark?.on;
  return (
    <div className={`p-trk-row ${on ? '' : 'off'}`} style={{ ['--c' as string]: row.color }} title={why ? tr(`鳴っていません${why}`, `Not playing${why}`) : undefined} onPointerUp={releaseFocus}>
      <span className="p-trk-bar" />
      <span className="p-trk-name">
        <b className="ellipsis">
          {row.name}
          {row.type === 'orig' && <i className="p-tag amber">BGM</i>}
          {row.type === 'stem' && <i className="p-tag">{tr('エディタだけ', 'Editor only')}</i>}
        </b>
        {sub && <span className="mono ellipsis">{row.sub}</span>}
      </span>
      <button className={`p-ms m ${muted ? 'on' : ''}`} onClick={() => setTrack(row, { mute: !muted })} aria-pressed={muted} aria-label={tr(`${row.name}をミュート`, `Mute ${row.name}`)}>
        M
      </button>
      <button className={`p-ms s ${soloed ? 'on' : ''}`} onClick={() => setTrack(row, { solo: !soloed })} onDoubleClick={() => soloOnly(row.id)} aria-pressed={soloed} aria-label={tr(`${row.name}をソロ`, `Solo ${row.name}`)}>
        S
      </button>
      <PRange value={gain} max={maxGain} color={row.color} label={tr(`${row.name}の音量`, `${row.name} volume`)} onChange={(v) => setTrack(row, { gain: v })} onReset={() => setTrack(row, { gain: defGain })} />
      <span className="p-trk-v mono">{pct(gain)}</span>
      {analysis &&
        (row.type === 'orig' || row.type === 'stem' ? (
          <button
            className={`p-radio ${isAnalysis ? 'on' : ''}`}
            onClick={() => chooseAnalysisStem(mark?.next ?? null)}
            aria-pressed={isAnalysis}
            aria-label={tr(`${row.name}を解析元にする（波形・原曲の打点・BPM推定）`, `Use ${row.name} as the analysis source (waveform, hits, BPM estimate)`)}
            title={tr('解析元（波形・原曲の打点・BPM推定に使う音）', 'Analysis source (the audio used for the waveform, hits and BPM estimate)')}
          >
            <i />
          </button>
        ) : (
          <span className="p-radio-pad" />
        ))}
    </div>
  );
}

/** メトロノームを鳴らす・止める（再生の帯・横の右の列）。音量は 🔊 の「メトロノーム」の行 */
export function MetronomeButton({ boxed = false }: { boxed?: boolean }) {
  const on = useEditor((s) => s.mix.metronome);
  return (
    <button
      className={`p-ib p-metro ${boxed ? 'boxed sq' : ''} ${on ? 'on' : ''}`}
      onClick={() => {
        setMix({ metronome: !on });
        // 止まっているときは鳴らないので、オンにしたことを知らせる
        if (!on && !useEditor.getState().playing) toast(tr('メトロノームをオンにしました。再生すると鳴ります（音量は 🔊）', 'Metronome on. It plays with playback (volume in 🔊)'), 'info', 2200);
      }}
      aria-pressed={on}
      aria-label={tr('メトロノーム', 'Metronome')}
      title={on ? tr('メトロノームを止める', 'Turn the metronome off') : tr('メトロノームを鳴らす（譜面の拍に合わせてクリック）', 'Turn the metronome on (clicks on the beat)')}
    >
      {Icon.metronome(boxed ? 18 : 20)}
    </button>
  );
}

/** メトロノームの行（音量の小窓）。左のボタンで鳴らす・止める */
function ClickLine() {
  const mix = useEditor((s) => s.mix);
  const on = mix.metronome;
  return (
    <div className={`p-trk-row p-metro-row ${on ? '' : 'off'}`} style={{ ['--c' as string]: '#5F6978' }}>
      <span className="p-trk-bar" />
      <span className="p-trk-name">
        <b className="ellipsis">{tr('メトロノーム', 'Metronome')}</b>
      </span>
      <button className={`p-ms p-ms-onoff ${on ? 'on' : ''}`} onClick={() => setMix({ metronome: !on })} aria-pressed={on} aria-label={tr('メトロノームを鳴らす', 'Play the metronome')}>
        {Icon.metronome(15)}
        <span>{on ? tr('オン', 'On') : tr('オフ', 'Off')}</span>
      </button>
      <PRange value={mix.click} max={1} color="#8B95A4" label={tr('メトロノームの音量', 'Metronome volume')} onChange={(v) => setMix({ click: v, metronome: true })} />
      <span className="p-trk-v mono">{pct(mix.click)}</span>
    </div>
  );
}

/** 再生の帯の 🔊：原曲・譜面の音・SE・クリックの音量（聴くための音量。譜面には入らない） */
export function VolumeButton({ dir, boxed = false }: { dir: PopDir; boxed?: boolean }) {
  const mix = useEditor((s) => s.mix);
  const { open, setOpen, ref } = usePop();
  return (
    <div className="p-popwrap" ref={ref}>
      <button className={`p-ib ${boxed ? 'boxed sm' : ''} ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={tr('音量', 'Volume')} title={tr('音量（聴くための音量）', 'Volume (for listening)')}>
        {mix.masterMute ? Icon.speakerOff(boxed ? 18 : 21) : Icon.speaker(boxed ? 18 : 21)}
      </button>
      {open && <VolumePop dir={dir} onClose={() => setOpen(false)} />}
    </div>
  );
}

function VolumePop({ dir, onClose }: { dir: PopDir; onClose: () => void }) {
  const rows = useTrackRows();
  const stems = useSidecar((s) => s.stems.length);
  useStems((s) => s.version);
  const order = { orig: 0, chart: 1, se: 2, stem: 3 } as const;
  const shown = rows.filter((r) => r.type !== 'stem').sort((a, b) => order[a.type] - order[b.type]);
  const box = useRef<HTMLDivElement>(null);
  // 画面の上にはみ出すなら、下の帯の上ぎりぎりまでに縮めてスクロール
  const [maxH, setMaxH] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 8) setMaxH(r.height + r.top - 8);
  }, []);
  return (
    <div className={`p-pop p-vol-pop dir-${dir}`} role="dialog" aria-label={tr('音量', 'Volume')} ref={box} style={maxH ? { maxHeight: maxH, overflowY: 'auto' } : undefined}>
      <div className="p-vol-head">
        <b>{tr('音量', 'Volume')}</b>
        <span className="lbl grow ellipsis">{tr('聴くための音量（譜面には入りません）', 'For listening (not saved into the chart)')}</span>
        <button className="p-ib sm" onClick={onClose} aria-label={tr('閉じる', 'Close')}>
          {Icon.close(18)}
        </button>
      </div>
      {shown.map((r) => (
        <TrackLine key={r.id} row={r} sub={false} />
      ))}
      <ClickLine />
      <button
        className="p-prow accent"
        onClick={() => {
          onClose();
          openPhoneTab('trk');
        }}
      >
        {Icon.sliders(20)}
        <span>{stems ? tr(`トラックを開く（ステム ${stems} 本）`, `Open tracks (${stems} stems)`) : tr('トラックを開く', 'Open tracks')}</span>
        <span className="k">{Icon.chevronRight(18)}</span>
      </button>
    </div>
  );
}
