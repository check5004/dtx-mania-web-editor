// 聴く音量とミックス：上のバーのマスター（全体の音量・曲の音と譜面の音のミュート・クリック）と、「ミックス」で開くパネル。
// トラックごとの音量・ミュート・ソロは下のトラックで変える。ここの音量は聴くためのもの。DTX の #VOLUME や書き出しには影響しない。
import { useEffect, useRef, useState } from 'react';
import { DRUM_LANES } from '../dtx/model';
import { clearMuteSolo, toggleMute, toggleSolo, useAssist } from '../store/assist';
import { openPage, setMix, useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';
import { LISTEN_PRESETS, leaveListenPreset, setListen, toggleBgmMute, toggleDrumMute, useStems } from '../store/stems';
import { Icon } from './icons';
import { releaseFocus } from './Tracks';

const pct = (v: number) => Math.round(v * 100);

/** 上のバーのマスター：全体の音量、曲の音（原曲・ステム）と譜面の音をまとめてミュート、クリック、ミックスのパネル */
export function MasterMixer() {
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
    <div className="master" ref={wrap} role="group" aria-label="マスター" onPointerUp={releaseFocus}>
      <button
        className={`ib ${mix.masterMute ? 'muted' : ''}`}
        onClick={() => setMix({ masterMute: !mix.masterMute })}
        title={mix.masterMute ? '音を出す' : 'すべての音を消す'}
        aria-pressed={mix.masterMute}
      >
        {mix.masterMute ? Icon.speakerOff(16) : Icon.speaker(16)}
      </button>
      <input
        type="range"
        className="master-vol"
        min={0}
        max={1}
        step={0.01}
        value={mix.master}
        onChange={(e) => setMix({ master: Number(e.target.value), masterMute: false })}
        onDoubleClick={() => setMix({ master: 0.9 })}
        aria-label="マスターの音量"
        title={`マスターの音量 ${pct(mix.master)}（すべての音。ダブルクリックで 90 に戻す）。トラックごとの音量は下のトラックで変えます`}
      />
      <button className={`ib mixer-click ${mix.metronome ? 'on' : ''}`} onClick={() => setMix({ metronome: !mix.metronome })} title={`クリック（メトロノーム）${mix.metronome ? 'を止める' : 'を鳴らす'}`} aria-pressed={mix.metronome}>
        {Icon.metronome(15)}
      </button>
      <button
        className={`btn small mixer-open ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`ミックス（聞こえ方${preset && listen !== 'all' ? `: ${preset.label}` : ''}・曲の音と譜面の音をまとめて消す・レーンのミュートとソロ・クリックの音量）`}
      >
        {Icon.sliders(14)}
        {groupMuted && <i className="mute-dot" title={mix.bgmMute ? '曲の音を消しています（Alt+1）' : '譜面の音を消しています（Alt+2）'} />}
        {Icon.chevronDown(12)}
      </button>
      {open && <MixPopover onClose={() => setOpen(false)} />}
    </div>
  );
}

function MixPopover({ onClose }: { onClose: () => void }) {
  const mix = useEditor((s) => s.mix);
  const previewOnPlace = useEditor((s) => s.previewOnPlace);
  const stems = useSidecar((s) => s.stems);
  const listen = useStems((s) => s.listen);
  const mute = useAssist((s) => s.mute);
  const solo = useAssist((s) => s.solo);
  const has = stems.length > 0;
  const hasDrums = stems.some((t) => t.kind === 'drums');
  const preset = LISTEN_PRESETS.find((p) => p.id === listen);
  const hint = preset ? (has ? preset.hint : preset.hintNoStems) : 'M・Sで個別に変えています。';
  return (
    <div className="mix-pop down" role="dialog" aria-label="ミックス">
      <div className="mix-head">
        <b>ミックス</b>
        <span className="grow" />
        <button
          className="link-btn"
          onClick={() => {
            onClose();
            openPage('stems');
          }}
        >
          ステム画面で開く {Icon.chevronRight(12)}
        </button>
        <button className="ib" onClick={onClose} title="閉じる">
          {Icon.close(14)}
        </button>
      </div>
      <div className="lbl" style={{ marginBottom: 6 }}>
        聞こえ方
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
        <span className="t">まとめて消す</span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className={`btn small mute-tg ${mix.bgmMute ? 'muted' : ''}`} onClick={toggleBgmMute} aria-pressed={mix.bgmMute} title="原曲・ステムのトラックをまとめてミュート（トラックごとの設定はそのまま）">
          {Icon.wave(14)} 曲の音 <span className="key">Alt+1</span>
        </button>
        <button className={`btn small mute-tg ${mix.drumMute ? 'muted' : ''}`} onClick={toggleDrumMute} aria-pressed={mix.drumMute} title="譜面の音をミュート（下のトラックの「譜面の音」の M と同じ）">
          {mix.drumMute ? Icon.chartOff(14) : Icon.drum(14)} 譜面の音 <span className="key">Alt+2</span>
        </button>
      </div>

      <p className="mix-hint" style={{ marginTop: 10 }}>
        原曲・ステム・譜面の音のトラックごとの音量・ミュート・ソロは、下のトラックで変えられます{has ? `（ステム ${stems.length}本）` : ''}。
      </p>

      <div className="mix-sec">
        <span className="t">譜面の音・レーン</span>
        <span className="grow" />
        {(mute.length > 0 || solo.length > 0) && (
          <button className="link-btn" onClick={clearMuteSolo}>
            解除
          </button>
        )}
        <span className="lbl">押すとミュート · Alt+押すとソロ</span>
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
              onClick={(e) => {
                if (e.altKey) toggleSolo(i);
                else toggleMute(i);
                leaveListenPreset();
              }}
              title={`${l.name}：押すとミュート、Alt+押すとソロ`}
            >
              {l.key}
            </button>
          );
        })}
      </div>

      <div className="mix-sec">
        <span className="t">クリック</span>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <label className="row lbl" style={{ gap: 6 }}>
          <input type="checkbox" checked={mix.metronome} onChange={(e) => setMix({ metronome: e.target.checked })} />
          鳴らす
        </label>
        <input type="range" min={0} max={1} step={0.01} value={mix.click} onChange={(e) => setMix({ click: Number(e.target.value) })} style={{ flex: 1 }} aria-label="クリックの音量" />
        <span className="mono lbl" style={{ width: 26, textAlign: 'right' }}>
          {pct(mix.click)}
        </span>
        <label className="row lbl" style={{ gap: 6 }}>
          <input type="checkbox" checked={mix.clickBarOnly} onChange={(e) => setMix({ clickBarOnly: e.target.checked })} />
          小節の頭だけ
        </label>
      </div>
      <label className="row lbl" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={previewOnPlace} onChange={(e) => useEditor.setState({ previewOnPlace: e.target.checked })} />
        チップを置いたときに音を鳴らす
      </label>
      <p className="mix-note">ここと下のトラックは聴くための音量です。DTXの音量（#VOLUME）や書き出しには影響しません。書き出すときのミックスはステム画面で決めます。</p>
    </div>
  );
}
