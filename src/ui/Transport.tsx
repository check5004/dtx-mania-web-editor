import { toMeasure } from '../dtx/base36';
import { GRID_DIVS, gridLabel } from '../edit/ops';
import { setInputMode, setLoop, setSpeed, useAssist, type InputMode } from '../store/assist';
import { tempoOf } from '../store/derived';
import { currentBeat, openTempo, playFrom, setCursorBeat, setMix, setView, stop, togglePlay, useEditor, zoom } from '../store/editor';
import { useMidi } from '../input/midi';
import { chipBpmLabel, formatPosition, formatTime, meterLabel } from './format';
import { usePlayBeat } from './hooks';
import { Icon } from './icons';

export function Transport() {
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const div = useEditor((s) => s.view.div);
  const follow = useEditor((s) => s.view.follow);
  const px = useEditor((s) => s.view.pxPerBeat);
  const metronome = useEditor((s) => s.mix.metronome);
  const loading = useEditor((s) => s.loading);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const { m } = tempo.locate(beat);
  const loop = useAssist((s) => s.loop);
  const speed = useAssist((s) => s.speed);
  const inputMode = useAssist((s) => s.inputMode);
  const stretching = useAssist((s) => s.stretching);
  const midi = useMidi((s) => s.status);
  const midiName = useMidi((s) => s.inputs[0]?.name ?? '');

  const loopLabel = (() => {
    if (!loop) return null;
    const ma = tempo.locate(loop.a).m;
    const mb = tempo.locate(Math.max(loop.a, loop.b - 1e-6)).m;
    return ma === mb ? toMeasure(ma) : `${toMeasure(ma)}–${toMeasure(mb)}`;
  })();
  const toggleLoop = () => {
    if (loop) {
      setLoop({ ...loop, on: !loop.on });
      return;
    }
    const at = tempo.locate(Math.max(0, currentBeat())).m;
    setLoop({ on: true, a: tempo.measureStart(at), b: tempo.measureStart(at + 1) });
  };
  const changeSpeed = (v: number) => {
    setSpeed(v);
    if (useEditor.getState().playing) void playFrom(currentBeat());
  };

  return (
    <div className="transport">
      <button
        className="ib"
        title="曲の頭へ"
        onClick={() => {
          setCursorBeat(0);
          setView({ scrollBeat: -0.5 });
          if (playing) void playFrom(0);
        }}
      >
        {Icon.toStart()}
      </button>
      <button className="play-btn" onClick={togglePlay} title={playing ? '停止（Space）' : 'カーソル位置から再生（Space / F6）'}>
        {playing ? Icon.pause(18) : Icon.play(18)}
      </button>
      <button className="ib" onClick={stop} title="停止（F7）" disabled={!playing}>
        {Icon.stop()}
      </button>
      <div className="pos-box">
        <span className="pos-main">{formatPosition(tempo, beat)}</span>
        <span className="pos-sub">{formatTime(tempo.beatToSec(Math.max(0, beat)))}</span>
      </div>
      <div className="vsep" />
      <button className="tbox tempo-link" title="原曲に合わせてBPMと曲の始まりを決める画面を開く" onClick={openTempo}>
        <span className="lbl">BPM · 拍子</span>
        <span className="row" style={{ gap: 8 }}>
          <span className="v">
            {chipBpmLabel(tempo.bpmAt(Math.max(0, beat)))} · {meterLabel(tempo.barLen(m))}
          </span>
          <span style={{ fontSize: 11, color: 'var(--accent)' }}>テンポ合わせ</span>
        </span>
      </button>
      <div className="vsep" />
      <div className="row" style={{ gap: 2 }}>
        <button
          className={`btn small loop-btn ${loop?.on ? 'on' : ''}`}
          onClick={toggleLoop}
          title={loop ? 'ループのオン・オフ（範囲は小節番号の列を Shift+ドラッグで変えられます）' : 'カーソルの小節をループする（小節番号の列を Shift+ドラッグで範囲指定）'}
        >
          {Icon.loop(14)}
          ループ {loopLabel && <span className="mono">{loopLabel}</span>}
        </button>
        {loop && (
          <button className="ib" style={{ width: 22, height: 26 }} onClick={() => setLoop(null)} title="ループを解除" aria-label="ループを解除">
            ✕
          </button>
        )}
      </div>
      <div className="row" style={{ gap: 6 }} title="原曲の音程を変えずに遅くする">
        <span className="lbl">速度</span>
        <div className="seg small">
          {[0.25, 0.5, 0.75, 1].map((v) => (
            <button key={v} className={`mono ${speed === v ? 'on' : ''}`} onClick={() => changeSpeed(v)}>
              {v * 100}%
            </button>
          ))}
        </div>
        {stretching && <span className="lbl">準備中…</span>}
      </div>
      <div className="vsep" />
      <label className="row" title="置く位置の細かさ（[ と ] でも変えられます）">
        <span className="lbl">グリッド</span>
        <select className="field mono" style={{ width: 118 }} value={div} onChange={(e) => setView({ div: Number(e.target.value) })}>
          {GRID_DIVS.map((d) => (
            <option key={d} value={d}>
              {gridLabel(d)}
            </option>
          ))}
        </select>
      </label>
      <div className="row" style={{ gap: 2 }}>
        <span className="lbl" style={{ marginRight: 6 }}>
          ズーム
        </span>
        <button className="ib" onClick={() => zoom(0.8)} title="縮小（Ctrl+ホイール）">
          {Icon.minus()}
        </button>
        <span className="mono lbl" style={{ width: 34, textAlign: 'center' }}>
          {Math.round((px / 48) * 100)}%
        </span>
        <button className="ib" onClick={() => zoom(1.25)} title="拡大（Ctrl+ホイール）">
          {Icon.plus()}
        </button>
      </div>
      <div className="vsep" />
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl">入力</span>
        <div className="seg small" role="radiogroup" aria-label="入力方法">
          {INPUT_MODES.map(([k, label, color, tip]) => (
            <button key={k} role="radio" aria-checked={inputMode === k} className={inputMode === k ? 'on' : ''} onClick={() => setInputMode(k)} title={tip}>
              <span className="mode-dot" style={{ background: color }} />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="vsep" />
      <button className={`ib ${follow ? 'on' : ''}`} onClick={() => setView({ follow: !follow })} title="再生位置を追いかける">
        {Icon.follow()}
      </button>
      <button className={`ib ${metronome ? 'on' : ''}`} onClick={() => setMix({ metronome: !metronome })} title="メトロノーム">
        {Icon.metronome()}
      </button>
      <span className="grow" />
      {loading && <span className="pill">{loading}</span>}
      {midi === 'on' && (
        <span className="pill ok" title={midiName}>
          MIDI 接続中
        </span>
      )}
    </div>
  );
}

const INPUT_MODES: [InputMode, string, string, string][] = [
  ['mouse', 'マウス', '#8B95A4', 'クリックでチップを置く'],
  ['key', 'キー', '#4CC2FF', 'キーボードでカーソル位置に置く（A S Z D G F H J K L、Shift で HHオープン/左バスドラム）'],
  ['rec', '録音', '#FF5A61', '再生しながらキーボードや電子ドラムで叩いて記録する（グリッドに吸着）'],
];
