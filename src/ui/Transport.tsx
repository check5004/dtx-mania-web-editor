import { GRID_DIVS, gridLabel } from '../edit/ops';
import { tempoOf } from '../store/derived';
import { playFrom, setCursorBeat, setMix, setView, stop, togglePlay, useEditor, zoom } from '../store/editor';
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
      <div className="tbox" title="カーソル位置のBPMと拍子">
        <span className="lbl">BPM · 拍子</span>
        <span className="v">
          {chipBpmLabel(tempo.bpmAt(Math.max(0, beat)))} · {meterLabel(tempo.barLen(m))}
        </span>
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
      <button className={`ib ${follow ? 'on' : ''}`} onClick={() => setView({ follow: !follow })} title="再生位置を追いかける">
        {Icon.follow()}
      </button>
      <button className={`ib ${metronome ? 'on' : ''}`} onClick={() => setMix({ metronome: !metronome })} title="メトロノーム">
        {Icon.metronome()}
      </button>
      <span className="grow" />
      {loading && <span className="pill">{loading}</span>}
      <span className="lbl hide-narrow" style={{ whiteSpace: 'nowrap' }}>
        <kbd>F5</kbd> 最初から <kbd>F6</kbd> カーソルから <kbd>F7</kbd> 停止
      </span>
    </div>
  );
}
