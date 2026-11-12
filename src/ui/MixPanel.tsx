// 聴く音量とミックス：上のバーのマスター（全体の音量・曲の音と譜面の音のミュート・クリック）と、「ミックス」で開くパネル。
// トラックごとの音量・ミュート・ソロは下のトラックで変える。ここの音量は聴くためのもの。DTX の #VOLUME や書き出しには影響しない。
import { tr, pl } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { DRUM_LANES } from '../dtx/model';
import type { Mix } from '../audio/engine';
import { clearMuteSolo, toggleMute, toggleSolo, useAssist } from '../store/assist';
import { useDevice } from '../store/device';
import { openPage, setMix, useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';
import { LISTEN_PRESETS, leaveListenPreset, setListen, soloOnly, toggleBgmMute, toggleDrumMute, useStems } from '../store/stems';
import { Icon } from './icons';
import { releaseFocus, rowAudible, setTrack, silentWhy, trackMix, useTrackRows, type TrackRow } from './Tracks';

const pct = (v: number) => Math.round(v * 100);

/**
 * 上のバーのマスター：全体の音量、曲の音（原曲・SE・ステム）と譜面の音をまとめてミュート、クリック、ミックスのパネル。
 * 幅が足りないとき（タブレットの縦など）：noVolume でマスターの音量をミックスの小窓へ移し、iconOnly でミックスをアイコンだけにする
 */
export function MasterMixer({ noVolume = false, iconOnly = false }: { noVolume?: boolean; iconOnly?: boolean } = {}) {
  const mix = useEditor((s) => s.mix);
  const listen = useStems((s) => s.listen);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const preset = LISTEN_PRESETS.find((p) => p.id === listen);
  const groupMuted = mix.bgmMute || mix.drumMute;
  return (
    <div className="master" ref={wrap} role="group" aria-label={tr('マスター', 'Master')} onPointerUp={releaseFocus}>
      <button
        className={`ib ${mix.masterMute ? 'muted' : ''}`}
        onClick={() => setMix({ masterMute: !mix.masterMute })}
        title={mix.masterMute ? tr('音を出す', 'Unmute') : tr('すべての音を消す', 'Mute everything')}
        aria-pressed={mix.masterMute}
      >
        {mix.masterMute ? Icon.speakerOff(16) : Icon.speaker(16)}
      </button>
      {!noVolume && <MasterVolume />}
      <button className={`ib mixer-click ${mix.metronome ? 'on' : ''}`} onClick={() => setMix({ metronome: !mix.metronome })} title={mix.metronome ? tr('クリック（メトロノーム）を止める', 'Turn the click (metronome) off') : tr('クリック（メトロノーム）を鳴らす', 'Turn the click (metronome) on')} aria-pressed={mix.metronome}>
        {Icon.metronome(15)}
      </button>
      <button
        className={`btn small mixer-open ${open ? 'on' : ''} ${iconOnly ? 'icon' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={tr('ミックス', 'Mix')}
        title={tr(
          `ミックス（${noVolume ? 'マスターの音量・' : ''}聞こえ方${preset && listen !== 'all' ? `: ${preset.label}` : ''}・曲の音と譜面の音をまとめて消す・レーンのミュートとソロ・クリックの音量）`,
          `Mix (${noVolume ? 'master volume, ' : ''}listening mode${preset && listen !== 'all' ? `: ${preset.label}` : ''}, mute the song or chart sounds, lane mute and solo, click volume)`,
        )}
      >
        {Icon.sliders(14)}
        {groupMuted && <i className="mute-dot" title={mix.bgmMute ? tr('曲の音を消しています（Alt+1）', 'Song audio is muted (Alt+1)') : tr('譜面の音を消しています（Alt+2）', 'Chart sounds are muted (Alt+2)')} />}
        {!iconOnly && Icon.chevronDown(12)}
      </button>
      {open && <MixPopover onClose={() => setOpen(false)} withMaster={noVolume} />}
    </div>
  );
}

/** マスターの音量のつまみ（上のバー・幅が足りないときはミックスの小窓の中） */
function MasterVolume() {
  const master = useEditor((s) => s.mix.master);
  return (
    <input
      type="range"
      className="master-vol"
      min={0}
      max={1}
      step={0.01}
      value={master}
      onChange={(e) => setMix({ master: Number(e.target.value), masterMute: false })}
      onDoubleClick={() => setMix({ master: 0.9 })}
      aria-label={tr('マスターの音量', 'Master volume')}
      title={tr(
        `マスターの音量 ${pct(master)}（すべての音。ダブルクリックで 90 に戻す）。トラックごとの音量は下のトラックで変えます`,
        `Master volume ${pct(master)} (all sound; double-click to reset to 90). Change each track's volume in the tracks below`,
      )}
    />
  );
}

/** 指でレーンをソロにする長押しの長さ（ミリ秒） */
const SOLO_HOLD_MS = 450;

function MixPopover({ onClose, withMaster = false }: { onClose: () => void; withMaster?: boolean }) {
  // 指で使う端末（タブレット・スマホ）：Alt が無いので、レーンのソロは長押し
  const touch = useDevice((s) => s.tablet);
  const hold = useRef<{ timer: number; fired: boolean }>({ timer: 0, fired: false });
  const mix = useEditor((s) => s.mix);
  const previewOnPlace = useEditor((s) => s.previewOnPlace);
  const stems = useSidecar((s) => s.stems);
  const listen = useStems((s) => s.listen);
  const mute = useAssist((s) => s.mute);
  const solo = useAssist((s) => s.solo);
  const has = stems.length > 0;
  const hasDrums = stems.some((t) => t.kind === 'drums');
  const preset = LISTEN_PRESETS.find((p) => p.id === listen);
  const hint = preset ? (has ? preset.hint : preset.hintNoStems) : tr('M・Sで個別に変えています。', 'Changed individually with M and S.');
  return (
    <div className="mix-pop down" role="dialog" aria-label={tr('ミックス', 'Mix')}>
      <div className="mix-head">
        <b>{tr('ミックス', 'Mix')}</b>
        <span className="grow" />
        <button
          className="link-btn"
          onClick={() => {
            onClose();
            openPage('stems');
          }}
        >
          {tr('ステム画面で開く', 'Open in Stems')} {Icon.chevronRight(12)}
        </button>
        <button className="ib" onClick={onClose} title={tr('閉じる', 'Close')}>
          {Icon.close(14)}
        </button>
      </div>
      {withMaster && (
        <div className="row mix-master" style={{ gap: 10, marginBottom: 10 }}>
          <span className="lbl">{tr('マスター', 'Master')}</span>
          <MasterVolume />
          <span className="mono lbl" style={{ width: 26, textAlign: 'right' }}>
            {pct(mix.master)}
          </span>
        </div>
      )}
      <div className="lbl" style={{ marginBottom: 6 }}>
        {tr('聞こえ方', 'Listening mode')}
      </div>
      <div className="seg full">
        {LISTEN_PRESETS.map((p) => (
          <button key={p.id} className={listen === p.id ? 'on' : ''} disabled={p.id === 'drums' && !hasDrums} onClick={() => setListen(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="mix-hint">{hint}</p>

      <div className="mix-sec">
        <span className="t">{tr('まとめて消す', 'Mute groups')}</span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className={`btn small mute-tg ${mix.bgmMute ? 'muted' : ''}`} onClick={toggleBgmMute} aria-pressed={mix.bgmMute} title={tr('原曲・SE・ステムのトラックをまとめてミュート（トラックごとの設定はそのまま）', 'Mute the original, SE and stem tracks together (each track keeps its own settings)')}>
          {Icon.wave(14)} {tr('曲の音', 'Song audio')} <span className="key">Alt+1</span>
        </button>
        <button className={`btn small mute-tg ${mix.drumMute ? 'muted' : ''}`} onClick={toggleDrumMute} aria-pressed={mix.drumMute} title={tr('譜面の音をミュート（下のトラックの「譜面の音」の M と同じ）', 'Mute the chart sounds (same as M on the "Chart" track below)')}>
          {mix.drumMute ? Icon.chartOff(14) : Icon.drum(14)} {tr('譜面の音', 'Chart sounds')} <span className="key">Alt+2</span>
        </button>
      </div>

      <p className="mix-hint" style={{ marginTop: 10 }}>
        {tr(
          `原曲・SE・ステム・譜面の音のトラックごとの音量・ミュート・ソロは、下のトラックで変えられます${has ? `（ステム ${stems.length}本）` : ''}。`,
          `Change the volume, mute and solo of each track (original, SE, stems, chart sounds) in the tracks below${has ? ` (${stems.length} ${pl(stems.length, 'stem')})` : ''}.`,
        )}
      </p>

      <div className="mix-sec">
        <span className="t">{tr('譜面の音・レーン', 'Chart sounds by lane')}</span>
        <span className="grow" />
        {(mute.length > 0 || solo.length > 0) && (
          <button className="link-btn" onClick={clearMuteSolo}>
            {tr('解除', 'Reset')}
          </button>
        )}
        <span className="lbl">{touch ? tr('押すとミュート · 長押しでソロ', 'Tap to mute · long-press to solo') : tr('押すとミュート · Alt+押すとソロ', 'Click to mute · Alt+click to solo')}</span>
      </div>
      <div className="lane-ms">
        {DRUM_LANES.map((l, i) => {
          const m = mute.includes(i) || mix.drumMute;
          const so = solo.includes(i);
          const silent = m || (solo.length > 0 && !so);
          return (
            <button
              key={l.key}
              className={`${silent ? 'off' : ''} ${so ? 'solo' : ''}`}
              style={{ color: silent ? undefined : l.color }}
              onPointerDown={(e) => {
                // 指・ペンは Alt が無いので、長押しでソロ
                if (e.pointerType === 'mouse') return;
                window.clearTimeout(hold.current.timer);
                hold.current = {
                  fired: false,
                  timer: window.setTimeout(() => {
                    hold.current.fired = true;
                    toggleSolo(i);
                    leaveListenPreset();
                  }, SOLO_HOLD_MS),
                };
              }}
              onPointerUp={() => window.clearTimeout(hold.current.timer)}
              onPointerLeave={() => window.clearTimeout(hold.current.timer)}
              onPointerCancel={() => window.clearTimeout(hold.current.timer)}
              onContextMenu={(e) => e.preventDefault()}
              onClick={(e) => {
                if (hold.current.fired) {
                  hold.current.fired = false;
                  return;
                }
                if (e.altKey) toggleSolo(i);
                else toggleMute(i);
                leaveListenPreset();
              }}
              title={touch ? tr(`${l.name}：押すとミュート、長押しでソロ`, `${l.name}: tap to mute, long-press to solo`) : tr(`${l.name}：押すとミュート、Alt+押すとソロ`, `${l.name}: click to mute, Alt+click to solo`)}
            >
              {l.key}
            </button>
          );
        })}
      </div>

      <div className="mix-sec">
        <span className="t">{tr('クリック', 'Click')}</span>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <label className="row lbl" style={{ gap: 6 }}>
          <input type="checkbox" checked={mix.metronome} onChange={(e) => setMix({ metronome: e.target.checked })} />
          {tr('鳴らす', 'On')}
        </label>
        <input type="range" min={0} max={1} step={0.01} value={mix.click} onChange={(e) => setMix({ click: Number(e.target.value) })} style={{ flex: 1 }} aria-label={tr('クリックの音量', 'Click volume')} />
        <span className="mono lbl" style={{ width: 26, textAlign: 'right' }}>
          {pct(mix.click)}
        </span>
        <label className="row lbl" style={{ gap: 6 }}>
          <input type="checkbox" checked={mix.clickBarOnly} onChange={(e) => setMix({ clickBarOnly: e.target.checked })} />
          {tr('小節の頭だけ', 'Downbeats only')}
        </label>
      </div>
      <label className="row lbl" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={previewOnPlace} onChange={(e) => useEditor.setState({ previewOnPlace: e.target.checked })} />
        {tr('チップを置いた・動かしたときに音を鳴らす', 'Play the sound when placing or moving a chip')}
      </label>
      <p className="mix-note">
        {tr(
          'ここと下のトラックは聴くための音量です。DTXの音量（#VOLUME）や書き出しには影響しません。書き出すときのミックスはステム画面で決めます。',
          "These volumes (here and in the tracks below) are only for listening. They don't change the DTX volume (#VOLUME) or exports. Set the export mix on the Stems screen.",
        )}
      </p>
    </div>
  );
}

/**
 * トラックごとの音量を横に並べた列（下のトラックの見出しと同じ M・S・音量）。
 * 下のトラックが無い画面（AI難易度生成）で、譜面の音と原曲・ステムの釣り合いを変えるのに使う
 */
export function TrackMixStrip() {
  const rows = useTrackRows();
  const mix = useEditor((s) => s.mix);
  useStems((s) => s.version);
  useSidecar((s) => s.stems);
  return (
    <div className="mix-strip" role="group" aria-label={tr('トラックの音量', 'Track volumes')} onPointerUp={releaseFocus}>
      <span
        className="lbl mix-strip-t"
        title={tr(
          'トラックごとの音量（聴くためのもの。DTXの音量（#VOLUME）や書き出しには影響しません）。Alt+1 で曲の音（原曲・SE・ステム）、Alt+2 で譜面の音をまとめて消します',
          "Volume per track (for listening only; doesn't change the DTX volume (#VOLUME) or exports). Alt+1 mutes the song audio (original, SE, stems), Alt+2 mutes the chart sounds",
        )}
      >
        {Icon.sliders(13)} {tr('音量', 'Volume')}
      </span>
      {rows.map((row) => (
        <MixChip key={row.id} row={row} mix={mix} />
      ))}
    </div>
  );
}

function MixChip({ row, mix }: { row: TrackRow; mix: Mix }) {
  if (row.type === 'orig' && row.state !== 'ready') {
    return (
      <div className="mix-chip off" style={{ borderLeftColor: row.color }}>
        <b className="ellipsis">{row.name}</b>
        <span className="lbl">{row.state === 'missing' ? tr('見つかりません', 'Not found') : row.state === 'loading' ? tr('読み込み中…', 'Loading…') : tr('まだありません', 'None yet')}</span>
      </div>
    );
  }
  const on = rowAudible(row);
  const { muted, soloed, gain, maxGain, defGain } = trackMix(row, mix);
  const why = silentWhy(row, mix, on, muted, soloed);
  return (
    <div className={`mix-chip ${on ? '' : 'off'}`} style={{ borderLeftColor: row.color }} title={why ? tr(`鳴っていません${why}`, `Not playing${why}`) : tr(`${row.name}：${row.sub}`, `${row.name}: ${row.sub}`)}>
      <b className="ellipsis">{row.name}</b>
      {(row.type === 'orig' || row.type === 'se') && <span className="mix-chip-sub ellipsis">{row.sub}</span>}
      <button
        className={`ms m ${muted ? 'on' : ''}`}
        onClick={() => setTrack(row, { mute: !muted })}
        aria-label={tr(`${row.name}をミュート`, `Mute ${row.name}`)}
        aria-pressed={muted}
        title={`${tr('ミュート', 'Mute')}${row.type === 'chart' ? tr('（Alt+2）', ' (Alt+2)') : ''}`}
      >
        M
      </button>
      <button
        className={`ms s ${soloed ? 'on' : ''}`}
        onClick={(e) => (e.altKey ? soloOnly(row.id) : setTrack(row, { solo: !soloed }))}
        aria-label={tr(`${row.name}をソロ`, `Solo ${row.name}`)}
        aria-pressed={soloed}
        title={tr('ソロ（Alt+クリックでこのトラックだけ）', 'Solo (Alt+click for this track only)')}
      >
        S
      </button>
      <input
        type="range"
        className="trk-vol"
        min={0}
        max={maxGain}
        step={0.01}
        value={gain}
        style={{ accentColor: row.color }}
        onChange={(e) => setTrack(row, { gain: Number(e.target.value) })}
        onDoubleClick={() => setTrack(row, { gain: defGain })}
        aria-label={tr(`${row.name}の音量`, `${row.name} volume`)}
        title={tr(`${row.name}の音量（ダブルクリックで ${pct(defGain)} に戻す）`, `${row.name} volume (double-click to reset to ${pct(defGain)})`)}
      />
      <span className="mono trk-v">{pct(gain)}</span>
    </div>
  );
}
