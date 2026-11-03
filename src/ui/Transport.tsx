import { toMeasure } from '../dtx/base36';
import { GRID_DIVS, gridLabel } from '../edit/ops';
import { setInputMode, setLoop, setLoopPoint, setSpeed, toggleLoop, useAssist, type InputMode } from '../store/assist';
import { tempoOf } from '../store/derived';
import { currentBeat, goToStart, openTempo, playFrom, setCursorBeat, setView, togglePause, togglePlay, useEditor } from '../store/editor';
import { useInputSettings } from '../input/settings';
import { setPreset, toggleVelMode, useVel, VEL_PRESET_NAMES } from '../store/velocity';
import { useMidi } from '../input/midi';
import { chipBpmLabel, formatPosition, formatTime, meterLabel } from './format';
import { usePlayBeat } from './hooks';
import { Icon } from './icons';
import { promptDialog } from './dialogs';
import { TapTempoButton } from './TapTempoPanel';

export function Transport() {
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const div = useEditor((s) => s.view.div);
  const follow = useEditor((s) => s.view.follow);
  const loading = useEditor((s) => s.loading);
  const velPreset = useVel((s) => s.preset);
  const velMode = useVel((s) => s.mode);
  const velPresets = useInputSettings((s) => s.velPresets);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const { m } = tempo.locate(beat);
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const speed = useAssist((s) => s.speed);
  const inputMode = useAssist((s) => s.inputMode);
  const stretching = useAssist((s) => s.stretching);
  const midi = useMidi((s) => s.status);
  const midiName = useMidi((s) => s.inputs[0]?.name ?? '');

  const short = (b: number) => {
    const { m } = tempo.locate(Math.max(0, b));
    const rel = Math.max(0, b - tempo.measureStart(m));
    const beatNo = Math.floor(rel + 1e-6) + 1;
    const frac = rel - Math.floor(rel + 1e-6);
    return `${toMeasure(m)}.${beatNo}${frac > 1e-3 ? '+' : ''}`;
  };
  const changeSpeed = (v: number) => {
    setSpeed(v);
    if (useEditor.getState().playing) void playFrom(currentBeat(), { keepStart: true });
  };
  // ループの範囲の表示。A だけ・B だけのときは、決まっていない方を「?」にする
  const half = loop ? null : loopMark;
  const rangeText = loop ? `${short(loop.a)}–${short(loop.b)}` : half ? (half.side === 'a' ? `${short(half.beat)}–?` : `?–${short(half.beat)}`) : '—';
  const rangeTip = loop
    ? 'ループの範囲（A–B）'
    : half
      ? half.side === 'a'
        ? 'A（始まり）だけ決めています。B（O）を押すとループします'
        : 'B（終わり）だけ決めています。A（I）を押すとループします'
      : 'ループの範囲はまだありません。A（I）と B（O）を1つずつ決めるとループします';
  const clearLabel = loop ? 'ループの範囲を消す' : half ? `${half.side === 'a' ? 'A' : 'B'} を消す` : null;

  return (
    <div className="transport">
      <button className="ib" title="曲の頭へ（Home）。▶ を曲の頭に置きます" onClick={goToStart}>
        {Icon.toStart()}
      </button>
      <button
        className="play-btn"
        onClick={togglePlay}
        title={playing ? '停止（Space / F7）。再生位置は ▶ に戻ります' : '▶ の位置から再生（Space / F6）。止めると ▶ に戻ります'}
        aria-label={playing ? '停止' : '再生'}
      >
        {playing ? Icon.stop(18) : Icon.play(18)}
      </button>
      <button
        className="ib"
        onClick={togglePause}
        title="ここで止める（Shift+Space）。止めた所に ▶ を移すので、次はそこから続けて再生します"
        aria-label="ここで止める"
        disabled={!playing}
      >
        {Icon.pause()}
      </button>
      <button
        className="pos-box"
        title="再生を始める位置（▶）。クリックで小節番号を入れて移動。譜面の小節番号の列・波形・下のシークバーをクリックしても置けます"
        onClick={async () => {
          const v = await promptDialog({ title: '再生を始める位置', body: '小節番号を入れてください（例: 012）。', value: toMeasure(tempo.locate(Math.max(0, beat)).m), ok: '移動' });
          if (!v) return;
          const t = v.trim().toUpperCase();
          const m = /^[0-9A-Z]{3}$/.test(t) && /[A-Z]/.test(t) ? parseInt(t[0], 36) * 100 + parseInt(t.slice(1), 10) : parseInt(t, 10);
          if (!Number.isFinite(m) || m < 0 || m >= 3600) return;
          const b = tempo.measureStart(m);
          setCursorBeat(b);
          setView({ scrollBeat: Math.max(-0.5, b - 2), follow: true });
          if (playing) void playFrom(b);
        }}
      >
        <span className="pos-main">{formatPosition(tempo, beat)}</span>
        <span className="pos-sub">{formatTime(tempo.beatToSec(Math.max(0, beat)))}</span>
      </button>
      <div className="vsep" />
      <div className="row" style={{ gap: 4 }}>
        <button className="tbox tempo-link" title="原曲に合わせてBPMと曲の始まりを決める画面を開く" onClick={openTempo}>
          <span className="lbl">BPM · 拍子</span>
          <span className="row" style={{ gap: 8 }}>
            <span className="v">
              {chipBpmLabel(tempo.bpmAt(Math.max(0, beat)))} · {meterLabel(tempo.barLen(m))}
            </span>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>テンポ合わせ</span>
          </span>
        </button>
        <TapTempoButton />
      </div>
      <div className="vsep" />
      <div className="loop-ctl" role="group" aria-label="ループ再生">
        <button
          className={`loop-toggle ${loop?.on ? 'on' : ''}`}
          onClick={toggleLoop}
          aria-pressed={!!loop?.on}
          title={
            loop
              ? 'ループ再生のオン・オフ（/）。範囲は譜面の左端・下の波形・右の全体図の「A・B」の帯をドラッグして変えられます'
              : half
                ? `ループ再生（/）。${half.side === 'a' ? 'B（O）' : 'A（I）'}を決めるとループします`
                : 'ループ再生（/）。範囲が無いときは今の小節（チップを選んでいればその小節）をループします。譜面の左端の帯をドラッグしても作れます'
          }
        >
          {Icon.loop(14)}
          ループ
        </button>
        <button
          className={`ab-btn ${half?.side === 'b' ? 'next' : ''}`}
          onClick={() => setLoopPoint('a')}
          title={half?.side === 'b' ? '今の位置を A（ループの始まり）にしてループする（I）' : '今の位置を A（ループの始まり）にする（I）。B も決めるとループします'}
        >
          A
        </button>
        <span className={`ab-range mono ${loop?.on ? 'on' : half ? 'half' : ''}`} title={rangeTip}>
          {rangeText}
        </span>
        <button
          className={`ab-btn ${half?.side === 'a' ? 'next' : ''}`}
          onClick={() => setLoopPoint('b')}
          title={half?.side === 'a' ? '今の位置を B（ループの終わり）にしてループする（O）' : '今の位置を B（ループの終わり）にする（O）。A も決めるとループします'}
        >
          B
        </button>
        {clearLabel && (
          <button className="ib" style={{ width: 20, height: 24 }} onClick={() => setLoop(null)} title={clearLabel} aria-label={clearLabel}>
            ✕
          </button>
        )}
      </div>
      <label className="row" style={{ gap: 6 }} title="再生の速さ。原曲は音程を変えずに遅くします">
        <span className="lbl tlabel">速度</span>
        <select className={`field mono ${speed < 1 ? 'speed-slow' : ''}`} style={{ width: 74 }} value={speed} onChange={(e) => changeSpeed(Number(e.target.value))}>
          {[1, 0.75, 0.5, 0.25].map((v) => (
            <option key={v} value={v}>
              {v * 100}%
            </option>
          ))}
        </select>
        {stretching && <span className="lbl">準備中…</span>}
      </label>
      <div className="vsep" />
      <label className="row" title="置く位置の細かさ（[ と ] でも変えられます）。ズームは Ctrl+ホイール">
        <span className="lbl tlabel">グリッド</span>
        <select
          className="field mono"
          style={{ width: 92 }}
          value={div}
          onChange={async (e) => {
            if (e.target.value !== 'custom') return setView({ div: Number(e.target.value) });
            const v = await promptDialog({ title: 'グリッドの細かさ', body: '全音符をいくつに分けるか（1〜192）。5連の16分なら 20、7連なら 28、6連なら 24。', value: String(div), ok: '決定' });
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
          <option value="custom">任意の分割…</option>
        </select>
      </label>
      <div className="vsep" />
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl tlabel">入力</span>
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
      <div className="row" style={{ gap: 6 }}>
        <span className="lbl">ベロシティ</span>
        <div className="seg small vel-seg" role="radiogroup" aria-label="置くベロシティ">
          {VEL_PRESET_NAMES.map((name, i) => (
            <button
              key={name}
              role="radio"
              aria-checked={velPreset === i}
              className={velPreset === i ? 'on' : ''}
              onClick={() => setPreset(i as 0 | 1 | 2)}
              title={`置くベロシティ: ${name}（${velPresets[i]}）。キー ${i + 1}。Alt を押しながら置くと「弱」`}
            >
              <span className="vel-mark" style={{ height: [12, 8, 5][i] }} />
              {name}
            </button>
          ))}
        </div>
        <button className={`ib ${velMode ? 'on' : ''}`} onClick={() => toggleVelMode()} title="ベロシティの編集（V）" aria-pressed={velMode}>
          {Icon.bars()}
        </button>
      </div>
      <div className="vsep" />
      <button className={`ib ${follow ? 'on' : ''}`} onClick={() => setView({ follow: !follow })} title="再生位置を追いかける">
        {Icon.follow()}
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
