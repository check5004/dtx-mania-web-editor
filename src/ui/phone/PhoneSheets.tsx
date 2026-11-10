// スマホ版の下のタブの中身：パッド（キット 4×3 と、ステップ・録音の右の列）とトラック（ミキサー）。
// ほかのタブ（音・原曲・耳コピ・確かめる）はタブレットのパネルの中身をそのまま使う（tablet/Panels）
import { useEffect } from 'react';
import { tr } from '../../i18n';
import { useAssist } from '../../store/assist';
import { setTouchPrefs, useDevice } from '../../store/device';
import { openPage, useEditor } from '../../store/editor';
import { clearAtCursor, padModeOf, setPadMode, stepBack, stepRest, toggleRecording } from '../../store/pads';
import { useSidecar } from '../../store/sidecar';
import { useStems } from '../../store/stems';
import { toggleVelMode } from '../../store/velocity';
import { Icon } from '../icons';
import { useTrackRows } from '../Tracks';
import { VelocityPanel } from '../VelocityPanel';
import { KitPad, ModeSeg } from '../tablet/Pads';
import { GridPick, StrengthPick, TrackLine } from './PhoneParts';

/** パッドを初めて開いたか（設定の「パッドを叩いたとき（はじめ）」にするのは最初の 1 回だけ） */
let padsOpened = false;

/** 右の列：ステップ（休み・戻る・消す）、録音（録音・カウントイン） */
function SideColumn() {
  const mode = padModeOf(useAssist((s) => s.inputMode));
  const playing = useEditor((s) => s.playing);
  const countIn = useDevice((s) => s.countIn);
  if (mode === 'step') {
    return (
      <div className="p-pad-side">
        <button className="p-side-btn" onClick={stepRest} aria-label={tr('休み（置かずに1グリッド進む）', 'Rest (move on one grid step without placing)')}>
          {Icon.arrowUp(18)}
          <span>{tr('休み', 'Rest')}</span>
        </button>
        <button className="p-side-btn" onClick={stepBack} aria-label={tr('1グリッド戻る', 'Back one grid step')}>
          {Icon.arrowDown(18)}
          <span>{tr('戻る', 'Back')}</span>
        </button>
        <button className="p-side-btn danger" onClick={clearAtCursor} aria-label={tr('▶ の所のチップを消す', 'Delete the chips at ▶')}>
          {Icon.trash(18)}
          <span>{tr('消す', 'Clear')}</span>
        </button>
      </div>
    );
  }
  if (mode === 'rec') {
    return (
      <div className="p-pad-side">
        <button className={`p-side-btn rec ${playing ? 'on' : ''}`} onClick={toggleRecording} aria-label={playing ? tr('録音を止める', 'Stop recording') : tr('録音を始める', 'Start recording')}>
          <span className="rec-dot" />
          <span>{playing ? tr('止める', 'Stop') : tr('録音', 'Rec')}</span>
        </button>
        <button className={`p-side-btn ${countIn ? 'on' : ''}`} onClick={() => setTouchPrefs({ countIn: !countIn })} aria-pressed={countIn} aria-label={tr('カウントイン（録音の前に1小節クリック）', 'Count-in (one bar of clicks before recording)')}>
          {Icon.metronome(18)}
          <span>{countIn ? tr('1小節', '1 bar') : tr('なし', 'Off')}</span>
        </button>
      </div>
    );
  }
  return null;
}

/** パッドのシート（縦）・パネル（横）。見出しは試し打ち・ステップ・録音と、縦ではグリッドと強さ（横は左の列にある） */
export function PhonePads({ land = false }: { land?: boolean }) {
  const order = useDevice((s) => s.kitOrder);
  const mode = padModeOf(useAssist((s) => s.inputMode));
  useEffect(() => {
    if (padsOpened) return;
    padsOpened = true;
    setPadMode(useDevice.getState().padStart);
  }, []);
  return (
    <div className={`p-pads ${land ? 'land' : ''} mode-${mode}`}>
      <div className="p-pads-head">
        <ModeSeg />
        {!land && (
          <>
            <span className="grow" />
            <GridPick look="chip" dir="up-end" />
            <StrengthPick look="chip" dir="up-end" />
          </>
        )}
      </div>
      <div className="p-pads-body">
        <div className="p-kit">
          {order.map((k) => (
            <KitPad key={k} order={order} k={k} />
          ))}
        </div>
        <SideColumn />
      </div>
      {mode === 'aud' && <p className="p-note">{tr('押した瞬間に鳴らすだけです。譜面は変えません。', 'Just plays the sound the moment you press. The chart does not change.')}</p>}
    </div>
  );
}

/** トラックのシート：譜面の音・原曲・SE・ステムのミキサー */
export function PhoneTracks() {
  const rows = useTrackRows();
  const stems = useSidecar((s) => s.stems.length);
  useStems((s) => s.version);
  return (
    <div className="p-trk">
      <div className="p-sheet-head">
        <h2 className="ellipsis">{tr('トラック', 'Tracks')}</h2>
        <button className="p-btn sm" onClick={() => openPage('stems')}>
          <span>{tr('ステムとミックス', 'Stems & mix')}</span>
          {Icon.chevronRight(14)}
        </button>
      </div>
      {rows.map((r) => (
        <TrackLine key={r.id} row={r} analysis />
      ))}
      <p className="p-note">
        {tr('M ミュート · S ソロ · ◎ 解析（波形・原曲の打点・BPM推定）に使う音', 'M mute · S solo · ◎ the audio used for analysis (waveform, hits, BPM estimate)')}
        {stems === 0 && tr('。ステムは「ステムとミックス」で足せます', '. Add stems from “Stems & mix”')}
      </p>
    </div>
  );
}

/** ベロシティの編集（譜面の右にベロシティのレーンを出しているとき） */
export function PhoneVelocity() {
  return (
    <div className="p-velpane">
      <div className="p-sheet-head">
        <h2 className="ellipsis">{tr('ベロシティの道具', 'Velocity tools')}</h2>
        <button className="p-btn sm" onClick={() => toggleVelMode(false)}>
          {tr('終わる', 'Done')}
        </button>
      </div>
      <VelocityPanel />
    </div>
  );
}
