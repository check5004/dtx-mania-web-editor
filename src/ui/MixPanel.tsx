// 聴く音量とミックス：再生バーの右に常設する音量と、「ステム」ボタンで開くミックスのパネル。
// ここの音量は聴くためのもの。DTX の #VOLUME や書き出しには影響しない。
import { useEffect, useRef, useState } from 'react';
import { stemKindInfo } from '../audio/stems';
import { DRUM_LANES } from '../dtx/model';
import { clearMuteSolo, toggleMute, toggleSolo, useAssist } from '../store/assist';
import { openPage, setMix, useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';
import { LISTEN_PRESETS, leaveListenPreset, setListen, toggleBgmMute, toggleDrumMute, updateStem, useStems } from '../store/stems';
import { Icon } from './icons';

const pct = (v: number) => Math.round(v * 100);

/** 再生バーの右の音量（原曲・譜面の音・クリック・ミックスのパネル） */
export function FooterMixer() {
  const mix = useEditor((s) => s.mix);
  const stems = useSidecar((s) => s.stems);
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
  return (
    <div className="mixer" ref={wrap}>
      <VolumeKnob
        label="原曲"
        title={stems.length ? '原曲（全ステムの合計）' : '原曲'}
        value={mix.bgm}
        muted={mix.bgmMute}
        icon={mix.bgmMute ? Icon.speakerOff(15) : Icon.speaker(15)}
        onToggle={toggleBgmMute}
        onChange={(v) => setMix({ bgm: v })}
        keyHint="Alt+1"
      />
      <VolumeKnob
        label="譜面の音"
        title="譜面の音（置いたチップのドラム）"
        value={mix.drums}
        muted={mix.drumMute}
        icon={mix.drumMute ? Icon.chartOff(15) : Icon.drum(15)}
        onToggle={toggleDrumMute}
        onChange={(v) => setMix({ drums: v })}
        keyHint="Alt+2"
      />
      <button
        className={`ib mixer-click ${mix.metronome ? 'on' : ''}`}
        onClick={() => setMix({ metronome: !mix.metronome })}
        title={`クリック（メトロノーム）${mix.metronome ? 'を止める' : 'を鳴らす'}`}
        aria-pressed={mix.metronome}
      >
        {Icon.metronome(15)}
      </button>
      <button className={`btn small mixer-open ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title="ミックス（ステム・レーンのミュートとソロ・クリックの音量）">
        {stems.length ? (
          <>
            ステム <b className="mono">{stems.length}</b>
          </>
        ) : (
          'ミックス'
        )}
        {Icon.chevronDown(13)}
      </button>
      {open && <MixPopover onClose={() => setOpen(false)} />}
    </div>
  );
}

function VolumeKnob(p: {
  label: string;
  title: string;
  value: number;
  muted: boolean;
  icon: React.ReactNode;
  keyHint: string;
  onToggle: () => void;
  onChange: (v: number) => void;
}) {
  return (
    <div className={`vol ${p.muted ? 'muted' : ''}`}>
      <button className="ib" onClick={p.onToggle} title={`${p.title}を${p.muted ? '鳴らす' : 'ミュート'}（${p.keyHint}）`} aria-pressed={p.muted}>
        {p.icon}
      </button>
      <div className="vol-body">
        <div className="vol-top">
          <span>{p.label}</span>
          <span className="mono">{p.muted ? 'M' : pct(p.value)}</span>
        </div>
        <input type="range" min={0} max={1} step={0.01} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} aria-label={`${p.title}の音量`} />
      </div>
    </div>
  );
}

function MixPopover({ onClose }: { onClose: () => void }) {
  const mix = useEditor((s) => s.mix);
  const previewOnPlace = useEditor((s) => s.previewOnPlace);
  const stems = useSidecar((s) => s.stems);
  const analysis = useSidecar((s) => s.analysisStem);
  const listen = useStems((s) => s.listen);
  const status = useStems((s) => s.status);
  const mute = useAssist((s) => s.mute);
  const solo = useAssist((s) => s.solo);
  const has = stems.length > 0;
  const hasDrums = stems.some((t) => t.kind === 'drums');
  const anySolo = stems.some((t) => t.solo);
  const preset = LISTEN_PRESETS.find((p) => p.id === listen);
  const hint = preset ? (has ? preset.hint : preset.hintNoStems) : 'M・Sで個別に変えています。';
  return (
    <div className="mix-pop" role="dialog" aria-label="ミックス">
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
        <span className="t">{has ? `原曲・ステム ${stems.length}本` : '原曲'}</span>
        <span className="grow" />
        <span className="lbl">M ミュート · S ソロ</span>
      </div>
      {has ? (
        stems.map((t) => {
          const info = stemKindInfo(t.kind);
          const off = t.mute || (anySolo && !t.solo);
          return (
            <div key={t.file} className="stem-row" style={{ opacity: off ? 0.45 : 1 }}>
              <i className="dot" style={{ background: info.color }} />
              <span className="name">{t.name}</span>
              <span className="file mono ellipsis" title={t.file}>
                {t.file.split('/').pop()}
                {analysis === t.file ? ' · 解析元' : ''}
                {listen === 'compare' && t.kind === 'drums' ? ' · 左' : ''}
                {status[t.file] === 'missing' ? ' · 見つかりません' : status[t.file] === 'loading' ? ' · 読み込み中' : ''}
              </span>
              <button className={`ms m ${t.mute ? 'on' : ''}`} onClick={() => updateStem(t.file, { mute: !t.mute })} aria-label={`${t.name}をミュート`}>
                M
              </button>
              <button className={`ms s ${t.solo ? 'on' : ''}`} onClick={() => updateStem(t.file, { solo: !t.solo })} aria-label={`${t.name}をソロ`}>
                S
              </button>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.01}
                value={t.gain}
                style={{ accentColor: info.color }}
                onChange={(e) => updateStem(t.file, { gain: Number(e.target.value) })}
                aria-label={`${t.name}の音量`}
              />
              <span className="mono v">{pct(t.gain)}</span>
            </div>
          );
        })
      ) : (
        <div className="mix-empty">
          ステム（ドラム・ベース・ボーカルなどに分けた音）を読み込むと、楽器ごとに鳴らし分けられます。
          <button
            className="btn small"
            onClick={() => {
              onClose();
              openPage('stems');
            }}
          >
            {Icon.layers(14)} ステムを読み込む
          </button>
        </div>
      )}

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
      <p className="mix-note">ここは聴くための音量です。DTXの音量（#VOLUME）や書き出しには影響しません。書き出すときのミックスはステム画面で決めます。</p>
    </div>
  );
}
