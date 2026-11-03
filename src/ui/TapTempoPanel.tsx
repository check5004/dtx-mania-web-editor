// 曲に合わせてクリック（T キー）してBPMと小節の頭を合わせる小窓。
import { tr, pl, isJa } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { bgmSource } from '../store/derived';
import { currentBeat, openTempo, playFrom, setMix, stop, useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';
import { applyTapAlign, applyTapBpm, canAlign, clearTaps, currentTapBpm, openTap, tapAt, useTap } from '../store/tapTempo';
import { Icon } from './icons';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

/** イベントの時刻（おかしければ今） */
function eventTime(e: { timeStamp: number }): number {
  const now = performance.now();
  return e.timeStamp > 0 && Math.abs(now - e.timeStamp) < 1000 ? e.timeStamp : now;
}

/** 同じキー入力を二度数えない */
const handled = new WeakSet<Event>();

/** 譜面の画面で T キーを押したら小窓を開いて叩く（小窓が開いていなくても使える） */
export function tapKey(e: KeyboardEvent): boolean {
  if (e.code !== 'KeyT' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTyping(e)) return false;
  if (handled.has(e)) return true;
  handled.add(e);
  if (!useTap.getState().open) openTap(true);
  tapAt(eventTime(e));
  return true;
}

export function TapTempoButton() {
  const open = useTap((s) => s.open);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} className={`btn small tap-btn ${open ? 'on' : ''}`} title={tr('曲に合わせてクリック（T キー）してBPMを測り、小節の頭を合わせる', 'Click along with the song (or press T) to measure the BPM and line up the downbeats')}
        onClick={() => openTap(!open)}
      >
        {Icon.tap(14)}
        <span style={{ fontSize: 11 }}>{tr('BPMタップ', 'Tap BPM')}</span>
      </button>
      {open && <TapTempoPanel anchor={ref} />}
    </>
  );
}

function TapTempoPanel({ anchor }: { anchor: React.RefObject<HTMLButtonElement | null> }) {
  const s = useTap();
  const playing = useEditor((st) => st.playing);
  const page = useEditor((st) => st.page);
  const meta = useEditor((st) => st.meta);
  const metronome = useEditor((st) => st.mix.metronome);
  const hasBgm = useEditor((st) => bgmSource(st.doc) !== null);
  const hasYt = useSidecar((st) => st.youtube !== null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [flash, setFlash] = useState(0);
  const firstMeta = useRef(meta);

  useEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 388)),
        top: r.bottom + 6,
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  // 別の譜面・別の画面になったら閉じる
  useEffect(() => {
    if (page !== 'chart' || meta !== firstMeta.current) {
      clearTaps();
      openTap(false);
    }
  }, [page, meta]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        openTap(false);
        return;
      }
      if (tapKey(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setFlash((n) => n + 1);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  const bpm = currentTapBpm(s);
  const align = canAlign(s);
  const source = hasBgm ? tr('原曲', 'the original') : hasYt ? 'YouTube' : null;

  return createPortal(
    <div className="popover tap-panel" style={{ position: 'fixed', left: pos.left, top: pos.top, width: 380 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>{tr('曲に合わせてBPMを測る', 'Measure the BPM along with the song')}</b>
        <span className="grow" />
        <button className="ib" style={{ width: 24, height: 24 }} onClick={() => openTap(false)} aria-label={tr('閉じる', 'Close')} title={tr('閉じる（Esc）', 'Close (Esc)')}>
          ✕
        </button>
      </div>
      <button
        className="tap-pad"
        onPointerDown={(e) => {
          e.preventDefault();
          tapAt(eventTime(e));
          setFlash((n) => n + 1);
        }}
      >
        {flash > 0 && <span key={flash} className="tap-ring" />}
        <span className="tap-pad-main">
          {s.taps.length === 0 ? tr('拍に合わせてここをクリック', 'Click here on the beat') : tr(`${s.taps.length} 回`, `${s.taps.length} ${pl(s.taps.length, 'tap')}`)}
        </span>
        <span className="lbl">{tr('T キーでも叩けます', 'You can also press T')}</span>
      </button>
      <div className="tap-result">
        {bpm !== null && s.fit ? (
          <>
            <span className="tap-bpm mono">{bpm}</span>
            <span className="lbl">BPM</span>
            <span className="grow" />
            <span className="lbl mono" title={tr('測った値・誤差の目安・叩いた位置のばらつき', 'Measured value, rough error, and how much your taps varied')}>
              {s.fit.bpm.toFixed(2)} ±{Math.max(0.01, s.fit.errBpm).toFixed(2)} · {tr('ばらつき', 'spread')} {Math.round(s.fit.jitterMs)}ms
            </span>
          </>
        ) : (
          <span className="lbl">
            {s.taps.length === 0
              ? tr('4回以上叩くとBPMが出ます。叩くほど正確になります。', 'Tap 4 or more times to get the BPM. More taps make it more accurate.')
              : tr(`あと ${4 - s.taps.length} 回`, `${4 - s.taps.length} more`)}
          </span>
        )}
      </div>
      <div className="row" style={{ gap: 10, marginBottom: 8 }}>
        <label className="row" style={{ gap: 6 }} title={tr('測った値が整数に近ければ整数にします', 'Rounds to a whole number when the result is close to one')}>
          <input type="checkbox" checked={s.round} onChange={(e) => useTap.setState({ round: e.target.checked })} />
          <span className="lbl">{tr('整数にそろえる', 'Round to whole BPM')}</span>
        </label>
        <span className="grow" />
        <button className={`btn small ghost ${metronome ? 'on' : ''}`} onClick={() => setMix({ metronome: !metronome })} title={tr('譜面のグリッドに合わせてクリック音を鳴らす', 'Play a click on the chart grid')}>
          {Icon.metronome(14)} {tr('クリック音', 'Click')}
        </button>
      </div>
      {playing ? (
        s.synced &&
        source && (
          <div className="row tap-first">
            <span className="lbl">{tr('最初に叩いたのは', 'My first tap was beat')}</span>
            <div className="seg small">
              {[1, 2, 3, 4].map((b) => (
                <button key={b} className={s.firstBeat === b ? 'on' : ''} onClick={() => useTap.setState({ firstBeat: b })}>
                  {b}
                </button>
              ))}
            </div>
            {isJa() && <span className="lbl">拍目</span>}
          </div>
        )
      ) : (
        <div className="notice info tap-hint">
          {source ? (
            <>
              {isJa() ? (
                <>
                  {source}を再生しながら叩くと、BPMと一緒に<b>小節の頭</b>
                  も合わせられます。
                </>
              ) : (
                <>
                  Tap while {source} plays to line up the <b>downbeats</b> along with the BPM.
                </>
              )}
              <button className="btn small" style={{ marginLeft: 6 }} onClick={() => void playFrom(currentBeat())}>
                {Icon.play(12)} {tr('再生', 'Play')}
              </button>
            </>
          ) : (
            <>
              {tr(
                '原曲もYouTubeも無いので、BPMだけ測れます（曲は別のプレーヤーで流してください）。',
                "There's no original or YouTube video, so only the BPM can be measured (play the song in another player).",
              )}
            </>
          )}
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        <button
          className="btn small primary"
          disabled={!align}
          onClick={applyTapAlign}
          title={
            align
              ? tr('測ったBPMにして、最初の1拍目を小節の頭に合わせます', 'Sets the measured BPM and puts the first downbeat at the start of a measure')
              : tr('再生しながら4回以上叩くと使えます', 'Available after 4 or more taps during playback')
          }
        >
          {tr('BPMと小節の頭を合わせる', 'Set BPM and downbeat')}
        </button>
        <button className="btn small" disabled={bpm === null} onClick={applyTapBpm} title={tr('小節の位置は変えずにBPMだけ変えます', 'Changes only the BPM, not where the measures start')}>
          {tr('BPMだけ反映', 'BPM only')}
        </button>
        <span className="grow" />
        <button className="btn small ghost" disabled={s.taps.length === 0} onClick={clearTaps}>
          {tr('やり直す', 'Reset')}
        </button>
      </div>
      <p className="lbl" style={{ margin: '10px 0 0', lineHeight: 1.6 }}>
        {tr(
          '2.5秒あけると測り直しになります。反映すると再生は同じ所から続くので、クリック音で合っているか確かめられます。',
          'A 2.5-second pause starts over. After applying, playback continues from the same place, so you can check it with the click.',
        )}
        {hasBgm && (
          <>
            {' '}
            {tr('BPMが途中で変わる曲や細かい調整は', 'For songs whose BPM changes, or for fine-tuning, use the ')}
            <button
              className="linkish"
              onClick={() => {
                stop();
                openTap(false);
                openTempo();
              }}
            >
              {tr('テンポ合わせ画面', 'Tempo screen')}
            </button>
            {tr('で。', '.')}
          </>
        )}
      </p>
    </div>,
    document.body,
  );
}
