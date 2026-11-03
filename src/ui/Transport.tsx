import { tr } from '../i18n';
import { toMeasure } from '../dtx/base36';
import { GRID_DIVS, gridLabel } from '../edit/ops';
import { setInputMode, setLoop, setLoopPoint, setSpeed, toggleLoop, useAssist, type InputMode } from '../store/assist';
import { tempoOf } from '../store/derived';
import { currentBeat, goToStart, openTempo, playFrom, setCursorBeat, setView, togglePause, togglePlay, useEditor } from '../store/editor';
import { useInputSettings } from '../input/settings';
import { setPreset, toggleVelMode, useVel, velPresetNames } from '../store/velocity';
import { useMidi } from '../input/midi';
import { chipBpmLabel, formatPosition, formatTime, meterLabel } from './format';
import { usePlayBeat } from './hooks';
import { Icon } from './icons';
import { promptDialog } from './dialogs';
import { TapTempoButton } from './TapTempoPanel';
import { FlamButton } from './FlamControl';

/** 譜面の表示を ▶ の所へ（エディタの譜面。ほかの画面は自分の表示を動かす関数を渡す） */
function showInChart(beat: number) {
  setView({ scrollBeat: Math.max(-0.5, beat - 2), follow: true });
}

/**
 * ⏮・▶/■・⏸・再生位置。エディタと AI難易度生成で共通（止めると ▶ に戻る・Shift+Space はここで止める）。
 * show: 小節番号を入れて移動したときに表示を動かす関数。where: ▶ をほかにどこで置けるか（位置の箱の説明）
 */
export function PlayControls({ show = showInChart, where = tr('譜面の小節番号の列・波形・下のシークバー', 'the measure-number column, the waveform or the seek bar below') }: { show?: (beat: number) => void; where?: string }) {
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  return (
    <>
      <button className="ib" title={tr('曲の頭へ（Home）。▶ を曲の頭に置きます', 'Go to start (Home). Moves ▶ to the start of the song')} onClick={goToStart}>
        {Icon.toStart()}
      </button>
      <button
        className="play-btn"
        onClick={togglePlay}
        title={
          playing
            ? tr('停止（Space / F7）。次はまた ▶ から再生します（譜面の表示は止めた所のまま）', 'Stop (Space / F7). Playback starts from ▶ again next time (the chart view stays where you stopped)')
            : tr('▶ の位置から再生（Space / F6）。止めると再生位置は ▶ に戻ります', 'Play from ▶ (Space / F6). Stopping returns the playhead to ▶')
        }
        aria-label={playing ? tr('停止', 'Stop') : tr('再生', 'Play')}
      >
        {playing ? Icon.stop(18) : Icon.play(18)}
      </button>
      <button
        className="ib"
        onClick={togglePause}
        title={tr('ここで止める（Shift+Space）。止めた所に ▶ を移すので、次はそこから続けて再生します', 'Stop here (Shift+Space). Moves ▶ to where you stopped, so playback continues from there next time')}
        aria-label={tr('ここで止める', 'Stop here')}
        disabled={!playing}
      >
        {Icon.pause()}
      </button>
      <button
        className="pos-box"
        title={tr(`再生を始める位置（▶）。クリックで小節番号を入れて移動。${where}をクリックしても置けます`, `Playback start (▶). Click to jump to a measure number. You can also set it by clicking ${where}`)}
        onClick={async () => {
          const v = await promptDialog({
            title: tr('再生を始める位置', 'Playback start position'),
            body: tr('小節番号を入れてください（例: 012）。', 'Enter a measure number (e.g. 012).'),
            value: toMeasure(tempo.locate(Math.max(0, beat)).m),
            ok: tr('移動', 'Go'),
          });
          if (!v) return;
          const t = v.trim().toUpperCase();
          const m = /^[0-9A-Z]{3}$/.test(t) && /[A-Z]/.test(t) ? parseInt(t[0], 36) * 100 + parseInt(t.slice(1), 10) : parseInt(t, 10);
          if (!Number.isFinite(m) || m < 0 || m >= 3600) return;
          const b = tempo.measureStart(m);
          setCursorBeat(b);
          show(b);
          if (playing) void playFrom(b);
        }}
      >
        <span className="pos-main">{formatPosition(tempo, beat)}</span>
        <span className="pos-sub">{formatTime(tempo.beatToSec(Math.max(0, beat)))}</span>
      </button>
    </>
  );
}

/** ループ再生（A–B）。エディタと AI難易度生成で共通 */
export function LoopControls() {
  const doc = useEditor((s) => s.doc);
  const tempo = tempoOf(doc);
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const short = (b: number) => {
    const { m } = tempo.locate(Math.max(0, b));
    const rel = Math.max(0, b - tempo.measureStart(m));
    const beatNo = Math.floor(rel + 1e-6) + 1;
    const frac = rel - Math.floor(rel + 1e-6);
    return `${toMeasure(m)}.${beatNo}${frac > 1e-3 ? '+' : ''}`;
  };
  // ループの範囲の表示。A だけ・B だけのときは、決まっていない方を「?」にする
  const half = loop ? null : loopMark;
  const rangeText = loop ? `${short(loop.a)}–${short(loop.b)}` : half ? (half.side === 'a' ? `${short(half.beat)}–?` : `?–${short(half.beat)}`) : '—';
  const rangeTip = loop
    ? tr('ループの範囲（A–B）', 'Loop range (A–B)')
    : half
      ? half.side === 'a'
        ? tr('A（始まり）だけ決めています。B（O）を押すとループします', 'Only A (start) is set. Press B (O) to loop')
        : tr('B（終わり）だけ決めています。A（I）を押すとループします', 'Only B (end) is set. Press A (I) to loop')
      : tr('ループの範囲はまだありません。A（I）と B（O）を1つずつ決めるとループします', 'No loop range yet. Set A (I) and B (O) to loop');
  const clearLabel = loop ? tr('ループの範囲を消す', 'Clear loop range') : half ? tr(`${half.side === 'a' ? 'A' : 'B'} を消す`, `Clear ${half.side === 'a' ? 'A' : 'B'}`) : null;

  return (
    <div className="loop-ctl" role="group" aria-label={tr('ループ再生', 'Loop playback')}>
      <button
        className={`loop-toggle ${loop?.on ? 'on' : ''}`}
        onClick={toggleLoop}
        aria-pressed={!!loop?.on}
        title={
          loop
            ? tr(
                'ループ再生のオン・オフ（/）。範囲は譜面の左端・下の波形・右の全体図の「A・B」の帯をドラッグして変えられます',
                'Loop playback on/off (/). Change the range by dragging the "A·B" strip at the left edge of the chart, on the waveform below, or in the overview on the right',
              )
            : half
              ? tr(`ループ再生（/）。${half.side === 'a' ? 'B（O）' : 'A（I）'}を決めるとループします`, `Loop playback (/). Set ${half.side === 'a' ? 'B (O)' : 'A (I)'} to start looping`)
              : tr(
                  'ループ再生（/）。範囲が無いときは今の小節（チップを選んでいればその小節）をループします。譜面の左端の帯をドラッグしても作れます',
                  'Loop playback (/). Without a range, loops the current measure (or the measures of the selected chips). You can also drag on the strip at the left edge of the chart',
                )
        }
      >
        {Icon.loop(14)}
        {tr('ループ', 'Loop')}
      </button>
      <button
        className={`ab-btn ${half?.side === 'b' ? 'next' : ''}`}
        onClick={() => setLoopPoint('a')}
        title={half?.side === 'b' ? tr('今の位置を A（ループの始まり）にしてループする（I）', 'Set A (loop start) here and start looping (I)') : tr('今の位置を A（ループの始まり）にする（I）。B も決めるとループします', 'Set A (loop start) here (I). Set B too to loop')}
      >
        A
      </button>
      <span className={`ab-range mono ${loop?.on ? 'on' : half ? 'half' : ''}`} title={rangeTip}>
        {rangeText}
      </span>
      <button
        className={`ab-btn ${half?.side === 'a' ? 'next' : ''}`}
        onClick={() => setLoopPoint('b')}
        title={half?.side === 'a' ? tr('今の位置を B（ループの終わり）にしてループする（O）', 'Set B (loop end) here and start looping (O)') : tr('今の位置を B（ループの終わり）にする（O）。A も決めるとループします', 'Set B (loop end) here (O). Set A too to loop')}
      >
        B
      </button>
      {clearLabel && (
        <button className="ib" style={{ width: 20, height: 24 }} onClick={() => setLoop(null)} title={clearLabel} aria-label={clearLabel}>
          ✕
        </button>
      )}
    </div>
  );
}

/** 再生の速さ。再生中なら今の位置から鳴らし直す（▶ は動かさない） */
export function SpeedControl() {
  const speed = useAssist((s) => s.speed);
  const stretching = useAssist((s) => s.stretching);
  const changeSpeed = (v: number) => {
    setSpeed(v);
    if (useEditor.getState().playing) void playFrom(currentBeat(), { keepStart: true });
  };
  return (
    <label className="row" style={{ gap: 6 }} title={tr('再生の速さ。原曲は音程を変えずに遅くします', 'Playback speed. The original audio slows down without changing pitch')}>
      <span className="lbl tlabel">{tr('速度', 'Speed')}</span>
      <select className={`field mono ${speed < 1 ? 'speed-slow' : ''}`} style={{ width: 74 }} value={speed} onChange={(e) => changeSpeed(Number(e.target.value))}>
        {[1, 0.75, 0.5, 0.25].map((v) => (
          <option key={v} value={v}>
            {v * 100}%
          </option>
        ))}
      </select>
      {stretching && <span className="lbl">{tr('準備中…', 'Preparing…')}</span>}
    </label>
  );
}

/** 再生位置を追いかける（エディタと共通の設定） */
export function FollowToggle() {
  const follow = useEditor((s) => s.view.follow);
  return (
    <button className={`ib ${follow ? 'on' : ''}`} onClick={() => setView({ follow: !follow })} title={tr('再生位置を追いかける', 'Follow playback')}>
      {Icon.follow()}
    </button>
  );
}

export function Transport() {
  const doc = useEditor((s) => s.doc);
  const div = useEditor((s) => s.view.div);
  const loading = useEditor((s) => s.loading);
  const velPreset = useVel((s) => s.preset);
  const velMode = useVel((s) => s.mode);
  const velPresets = useInputSettings((s) => s.velPresets);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const { m } = tempo.locate(beat);
  const inputMode = useAssist((s) => s.inputMode);
  const midi = useMidi((s) => s.status);
  const midiName = useMidi((s) => s.inputs[0]?.name ?? '');

  return (
    <div className="transport">
      <PlayControls />
      <div className="vsep" />
      <div className="row" style={{ gap: 4 }}>
        <button className="tbox tempo-link" title={tr('原曲に合わせてBPMと曲の始まりを決める画面を開く', 'Open the screen for setting the BPM and song start to match the original audio')} onClick={openTempo}>
          <span className="lbl">{tr('BPM · 拍子', 'BPM · Meter')}</span>
          <span className="row" style={{ gap: 8 }}>
            <span className="v">
              {chipBpmLabel(tempo.bpmAt(Math.max(0, beat)))} · {meterLabel(tempo.barLen(m))}
            </span>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>{tr('テンポ合わせ', 'Match tempo')}</span>
          </span>
        </button>
        <TapTempoButton />
      </div>
      <div className="vsep" />
      <LoopControls />
      <SpeedControl />
      <div className="vsep" />
      <label className="row" title={tr('置く位置の細かさ（[ と ] でも変えられます）。ズームは Ctrl+ホイール', 'How finely chips snap ([ and ] also change it). Zoom with Ctrl+Wheel')}>
        <span className="lbl tlabel">{tr('グリッド', 'Grid')}</span>
        <select
          className="field mono"
          style={{ width: 92 }}
          value={div}
          onChange={async (e) => {
            if (e.target.value !== 'custom') return setView({ div: Number(e.target.value) });
            const v = await promptDialog({
              title: tr('グリッドの細かさ', 'Grid resolution'),
              body: tr('全音符をいくつに分けるか（1〜192）。5連の16分なら 20、7連なら 28、6連なら 24。', 'How many parts to divide a whole note into (1–192). 16th-note quintuplets: 20, septuplets: 28, sextuplets: 24.'),
              value: String(div),
              ok: tr('決定', 'OK'),
            });
            const n = Math.round(Number(v));
            if (v && n >= 1 && n <= 192) setView({ div: n });
          }}
        >
          {(GRID_DIVS as readonly number[]).includes(div) ? null : <option value={div}>{gridLabel(div)}</option>}
          {GRID_DIVS.map((d) => (
            <option key={d} value={d}>
              {gridLabel(d)}
            </option>
          ))}
          <option value="custom">{tr('任意の分割…', 'Custom…')}</option>
        </select>
      </label>
      <FlamButton />
      <div className="vsep" />
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl tlabel">{tr('入力', 'Input')}</span>
        <div className="seg small" role="radiogroup" aria-label={tr('入力方法', 'Input method')}>
          {inputModes().map(([k, label, color, tip]) => (
            <button key={k} role="radio" aria-checked={inputMode === k} className={inputMode === k ? 'on' : ''} onClick={() => setInputMode(k)} title={tip}>
              <span className="mode-dot" style={{ background: color }} />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="vsep" />
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl">{tr('ベロシティ', 'Velocity')}</span>
        <div className="seg small vel-seg" role="radiogroup" aria-label={tr('置くベロシティ', 'Velocity for new chips')}>
          {velPresetNames().map((name, i) => (
            <button
              key={name}
              role="radio"
              aria-checked={velPreset === i}
              className={velPreset === i ? 'on' : ''}
              onClick={() => setPreset(i as 0 | 1 | 2)}
              title={tr(
                `置くベロシティ: ${name}（${velPresets[i]}）。キー ${i + 1}。Alt を押しながら置くと「弱」`,
                `Velocity for new chips: ${name} (${velPresets[i]}). Key ${i + 1}. Hold Alt while placing to use "${velPresetNames()[2]}"`,
              )}
            >
              <span className="vel-mark" style={{ height: [12, 8, 5][i] }} />
              {name}
            </button>
          ))}
        </div>
        <button className={`ib ${velMode ? 'on' : ''}`} onClick={() => toggleVelMode()} title={tr('ベロシティの編集（V）', 'Edit velocity (V)')} aria-pressed={velMode}>
          {Icon.bars()}
        </button>
      </div>
      <div className="vsep" />
      <FollowToggle />
      <span className="grow" />
      {loading && <span className="pill">{loading}</span>}
      {midi === 'on' && (
        <span className="pill ok" title={midiName}>
          {tr('MIDI 接続中', 'MIDI connected')}
        </span>
      )}
    </div>
  );
}

const inputModes = (): [InputMode, string, string, string][] => [
  ['mouse', tr('マウス', 'Mouse'), '#8B95A4', tr('クリックでチップを置く', 'Click to place chips')],
  ['key', tr('キー', 'Keys'), '#4CC2FF', tr('キーボードでカーソル位置に置く（A S Z D G F H J K L、Shift で HHオープン/左バスドラム）', 'Place chips at the cursor with the keyboard (A S Z D G F H J K L; Shift for HH open / left bass drum)')],
  ['rec', tr('録音', 'Rec'), '#FF5A61', tr('再生しながらキーボードや電子ドラムで叩いて記録する（グリッドに吸着）', 'Record by playing along on the keyboard or e-drums (snaps to the grid)')],
];
