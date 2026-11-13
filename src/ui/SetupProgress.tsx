// おまかせで準備の間の画面（終わった物から結果を出す）と、続けられなかったときの知らせ。
// テンポが決まったら、待つ間にクリックと一緒に聴いて直せる（直した分はすぐ譜面に入る。src/app/setupTempo.ts）。
// iPhone は下から出るシート（波形は出さず、大きなボタンで聴いて直す）
import { useEffect, useState } from 'react';
import { tr } from '../i18n';
import { IS_IOS } from '../platform';
import { useAssist } from '../store/assist';
import { useDevice } from '../store/device';
import { useEditor } from '../store/editor';
import { bpmText, playAudioSec, useTempo } from '../store/tempoUi';
import { cancelSetup, dismissSetup, measureLabel, stepLabel, useSetup, type SetupStep, type SetupStepId } from '../app/setup';
import { scaleTempo, shiftHead, simpleHead, toggleListen } from '../app/setupTempo';
import { confirmDialog } from './dialogs';
import { Grip, PhoneBody } from './SetupSheet';
import { useCanvas } from './hooks';
import { Icon } from './icons';
import { usePreimage } from './TopBar';

export function SetupHost() {
  const status = useSetup((s) => s.status);
  if (status === 'running') return <SetupProgress />;
  if (status === 'error') return <SetupFailed />;
  return null;
}

/** かかった時間（0:38） */
export function elapsed(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** まだ始めていない項目の説明 */
export function waitNote(id: SetupStepId, steps: SetupStep[]): string {
  const has = (x: SetupStepId) => steps.some((s) => s.id === x);
  switch (id) {
    case 'video':
      return tr('OGG にして原曲に。動画は背景動画にも', 'Saved as OGG for the original. The video becomes the background movie');
    case 'stems':
      return tr('ステムを読み込み、ドラム以外を合わせて BGM に', 'Loads the stems and mixes the non-drum stems into the BGM');
    case 'info':
      return tr('タグと iTunes で探します', 'Searches the tags and iTunes');
    case 'tempo':
      return tr('BPM と曲の始まりを見つけます（数秒）', 'Finds the BPM and where the song starts (a few seconds)');
    case 'preview':
      return tr('サビを探して試聴を作ります（数秒）', 'Finds the chorus and makes the preview (a few seconds)');
    case 'separate':
      return IS_IOS ? tr('ドラムとドラム抜きに分けます（10 分を超えることも）', 'Splits into drums and no drums (can take over 10 min)') : tr('ドラムとドラム抜きに分けます（数分）', 'Splits into drums and no drums (a few minutes)');
    case 'drums':
      return has('separate')
        ? tr('分けたドラムから拾います（十数秒）', 'Picks them up from the split drums (about 10–20 s)')
        : has('stems')
          ? tr('ドラムのステムから拾います（十数秒）', 'Picks them up from the drum stems (about 10–20 s)')
          : tr('原曲から拾います（十数秒）', 'Picks them up from the original (about 10–20 s)');
  }
}

/** 1 秒ごとに描き直す（経過の時間） */
export function useNow(on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

function StepIcon({ state }: { state: SetupStep['state'] }) {
  return (
    <span className={`setup-p-icon ${state}`} aria-hidden="true">
      {state === 'done' ? Icon.check(13) : state === 'fail' ? Icon.warn(13) : state === 'skip' ? '–' : null}
    </span>
  );
}

export function StepItem({ s, steps, next, now }: { s: SetupStep; steps: SetupStep[]; next: boolean; now: number }) {
  const run = s.state === 'run';
  const pct = s.progress !== null ? `${Math.round(s.progress * 100)}%` : '';
  const stateText = { wait: tr('これから', 'waiting'), run: tr('進めています', 'in progress'), done: tr('できました', 'done'), skip: tr('飛ばしました', 'skipped'), fail: tr('できませんでした', 'failed') }[s.state];
  return (
    <li className={`setup-p-step ${s.state}`} aria-label={`${stepLabel(s.id)}: ${stateText}`}>
      <StepIcon state={s.state} />
      <span className="setup-p-text">
        <span className="setup-p-line">
          <b>{stepLabel(s.id)}</b>
          {run && <span className="setup-p-note">{s.note}</span>}
        </span>
        {!run && <span className="setup-p-note">{s.state === 'wait' ? waitNote(s.id, steps) : s.note}</span>}
        {run && s.progress !== null && (
          <span className="setup-p-bar">
            <span style={{ width: pct }} />
          </span>
        )}
      </span>
      <span className="setup-p-time">
        {s.state === 'done' || s.state === 'fail' ? (
          elapsed(s.sec)
        ) : run ? (
          <>
            {pct && <span className="pct">{pct}</span>}
            <span>{tr(`経過 ${elapsed((now - s.t0) / 1000)}`, `${elapsed((now - s.t0) / 1000)} elapsed`)}</span>
          </>
        ) : next ? (
          tr('次', 'Next')
        ) : (
          ''
        )}
      </span>
    </li>
  );
}

/** 準備をやめる（20 秒より長く進めていたら確かめる） */
export async function askCancel(t0: number) {
  if (Date.now() - t0 > 20_000) {
    const ok = await confirmDialog({
      title: tr('準備をやめますか？', 'Stop setting up?'),
      body: tr('ここまでの分も残さずに、ホームに戻ります。', "Nothing made so far is kept, and you go back to the home screen."),
      ok: tr('やめる', 'Stop'),
      cancel: tr('続ける', 'Keep going'),
      danger: true,
    });
    if (!ok) return;
  }
  cancelSetup();
}

function SetupProgress() {
  const phone = useDevice((s) => s.phone);
  const tablet = useDevice((s) => s.tablet);
  const steps = useSetup((s) => s.steps);
  const title = useEditor((s) => s.doc.fields['TITLE']) || useSetup.getState().title;
  const artist = useEditor((s) => s.doc.fields['ARTIST']);
  const art = usePreimage();
  const now = useNow();
  const [t0] = useState(() => Date.now());
  const finished = steps.filter((s) => s.state === 'done' || s.state === 'fail' || s.state === 'skip').length;
  const nextId = steps.find((s) => s.state === 'wait')?.id;
  const tempoDone = steps.some((s) => s.id === 'tempo' && s.state === 'done');
  return (
    <div className="modal-back setup-back">
      <div className={`modal setup-sheet setup-progress ${phone ? 'phone' : tablet ? 'tablet' : ''}`} role="dialog" aria-modal="true" aria-label={tr('準備しています', 'Setting up')}>
        {phone && <Grip />}
        <div className="setup-p-head">
          <span className="setup-p-art">{art ? <img src={art} alt="" /> : Icon.wave(22)}</span>
          <div className="grow">
            <h2>{tr('準備しています', 'Setting up')}</h2>
            <span className="setup-p-sub">{[title, artist, tr('終わるとエディタが開きます', 'The editor opens when it’s done')].filter(Boolean).join(' · ')}</span>
          </div>
          {!phone && (
            <span className="setup-p-count">
              {finished} / {steps.length}
            </span>
          )}
        </div>
        <PhoneBody phone={phone}>
          <ol className="setup-p-steps" aria-label={tr('進み具合', 'Progress')}>
            {steps.map((s) => (
              <StepItem key={s.id} s={s} steps={steps} next={s.id === nextId} now={now} />
            ))}
          </ol>
          {tempoDone && <TempoCheck phone={phone} />}
          {phone && IS_IOS && (
            <p className="setup-pwarn">
              {Icon.info(14)}
              <span>{tr('画面を消したり、ほかのアプリに切り替えると止まることがあります', 'Turning off the screen or switching to another app can stop it')}</span>
            </p>
          )}
        </PhoneBody>
        {phone ? (
          <div className="setup-pfoot">
            <button className="btn setup-pstop" onClick={() => void askCancel(t0)}>
              {tr('やめる', 'Stop')}
            </button>
          </div>
        ) : (
          <div className="setup-foot">
            <span className="setup-foot-note">
              {IS_IOS
                ? tr(
                    '画面をつけたまま、このアプリを開いておいてください（ほかのアプリに移ると止まることがあります）。やめると、まだ何も作らずにホームに戻ります',
                    'Keep the screen on and this app open (switching to another app can stop it). Stopping goes back to the home screen without making anything',
                  )
                : tr('この画面のままお待ちください。やめると、まだ何も作らずにホームに戻ります', 'Please wait on this screen. Stopping goes back to the home screen without making anything')}
            </span>
            <button className="btn setup-big ghost" onClick={() => void askCancel(t0)}>
              {tr('やめる', 'Stop')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const WAVE = { played: '#4f7f9c', ahead: '#33414f', idle: '#4f7f9c', beat: '#1e242d', bar: '#3a4452', head: '#4cc2ff', label: '#8b95a4', play: '#ffb547' };

/** 決めたテンポの拍と小節の線を、曲の頭のあたりの波形に重ねる（聴いている間は再生の位置を追う） */
export function TempoWave({ height = 92 }: { height?: number }) {
  const plan = useTempo((s) => s.plan);
  const playing = useTempo((s) => s.playing);
  const data = useAssist((s) => s.data);
  const ref = useCanvas(
    (c, w, h) => {
      c.clearRect(0, 0, w, h);
      const head = simpleHead();
      if (!head) return;
      const beat = 60 / head.bpm;
      const span = 15.5 * beat;
      let from = head.t - 3.5 * beat;
      const p = playing ? playAudioSec() : null;
      if (p !== null) {
        // 右の端まで来たら 3 小節先へめくる
        for (let i = 0; i < 200 && p > from + span - beat; i++) from += 12 * beat;
        for (let i = 0; i < 200 && p < from; i++) from -= 12 * beat;
      }
      const pad = 8;
      const W = w - pad * 2;
      const X = (t: number) => pad + ((t - from) / span) * W;
      const top = 20;
      const mid = top + (h - top) / 2;
      const amp = (h - top) / 2 - 6;
      // 波形（4px の棒を 2px あけて並べる）
      if (data) {
        const pr = data.peakRate;
        for (let x = pad; x + 4 <= pad + W; x += 6) {
          const t0 = from + ((x - pad) / W) * span;
          const t1 = from + ((x + 6 - pad) / W) * span;
          const i0 = Math.max(0, Math.floor(t0 * pr));
          const i1 = Math.min(data.peaks.length - 1, Math.floor(t1 * pr));
          let m = 0;
          for (let i = i0; i <= i1; i++) if (data.peaks[i] > m) m = data.peaks[i];
          const hh = Math.max(1.5, m * amp);
          c.fillStyle = p === null ? WAVE.idle : t0 <= p ? WAVE.played : WAVE.ahead;
          if (c.roundRect) {
            c.beginPath();
            c.roundRect(x, mid - hh, 4, hh * 2, 2);
            c.fill();
          } else c.fillRect(x, mid - hh, 4, hh * 2);
        }
      }
      // 拍と小節の線
      c.font = '11px "JetBrains Mono", ui-monospace, monospace';
      c.textBaseline = 'middle';
      const k0 = Math.ceil((from - head.t) / beat);
      for (let k = k0; head.t + k * beat <= from + span; k++) {
        const x = Math.round(X(head.t + k * beat));
        const down = ((k % 4) + 4) % 4 === 0;
        c.fillStyle = k === 0 ? WAVE.head : down ? WAVE.bar : WAVE.beat;
        c.fillRect(x, top - 2, 1, h - top + 2);
        if (down) {
          const m = head.m + k / 4;
          if (m < 0) continue;
          const label = k === 0 ? `${measureLabel(m)}  ${tr('曲の頭', 'song start')}` : measureLabel(m);
          // 右の端で切れる番号は書かない
          if (x + 4 + c.measureText(label).width > w - 2) continue;
          c.fillStyle = k === 0 ? WAVE.head : WAVE.label;
          c.fillText(label, x + 4, 10);
        }
      }
      if (p !== null) {
        c.fillStyle = WAVE.play;
        c.fillRect(Math.round(X(p)), 0, 2, h);
      }
    },
    [plan, data, playing],
    playing,
  );
  return <canvas ref={ref} className="setup-wave" style={{ height }} aria-label={tr('曲の頭のあたりの波形と、拍の線', 'Waveform around the song start with the beat lines')} />;
}

/** テンポを聴いて直すボタン（準備中の画面・エディタの帯） */
export function TempoButtons({ compact }: { compact?: boolean }) {
  const playing = useTempo((s) => s.playing);
  const plan = useTempo((s) => s.plan);
  const head = simpleHead();
  return (
    <>
      <button className={`btn setup-listen ${playing ? 'on' : ''}`} onClick={toggleListen} aria-pressed={playing}>
        {playing ? Icon.pause(12) : Icon.play(12)}
        {playing ? tr('クリックと聴いています', 'Listening with clicks') : tr('クリックと聴く', 'Listen with clicks')}
      </button>
      {!compact && (
        <span className="setup-bpm">
          <b>{bpmText(plan.bpm)}</b>
          <span>BPM</span>
        </span>
      )}
      {head && (
        <>
          <button className="btn mono" onClick={() => scaleTempo(2)} title={tr('BPM を 2 倍に', 'Double the BPM')}>
            ×2
          </button>
          <button className="btn mono" onClick={() => scaleTempo(0.5)} title={tr('BPM を半分に', 'Halve the BPM')}>
            ÷2
          </button>
          {!compact && <span className="setup-sep" />}
          <button className="btn" onClick={() => shiftHead(-1)} title={tr('曲の頭（小節の頭）を 1 拍前にずらす', 'Move the song start (top of the measure) one beat earlier')}>
            {Icon.arrowLeft(14)}
            {compact ? tr('1 拍', '1 beat') : tr('頭を 1 拍前に', 'Start 1 beat earlier')}
          </button>
          <button className="btn" onClick={() => shiftHead(1)} title={tr('曲の頭（小節の頭）を 1 拍後ろにずらす', 'Move the song start (top of the measure) one beat later')}>
            {compact ? tr('1 拍', '1 beat') : tr('頭を 1 拍後ろに', 'Start 1 beat later')}
            {Icon.arrowRight(14)}
          </button>
        </>
      )}
    </>
  );
}

/** iPhone：大きな「クリックと聴く」と、その下に 4 つのボタン（band はエディタの帯。BPM はボタンの中に） */
export function TempoPad({ band }: { band?: boolean }) {
  const playing = useTempo((s) => s.playing);
  const plan = useTempo((s) => s.plan);
  const head = simpleHead();
  const bpm = bpmText(plan.bpm);
  return (
    <>
      <div className="setup-tpad-listen">
        <button className={`btn setup-listen wide ${playing ? 'on' : ''}`} onClick={toggleListen} aria-pressed={playing}>
          {playing ? Icon.pause(12) : Icon.play(12)}
          {band
            ? playing
              ? tr(`聴いています（${bpm} BPM）`, `Listening (${bpm} BPM)`)
              : tr(`クリックと聴く（${bpm} BPM）`, `Listen with clicks (${bpm} BPM)`)
            : playing
              ? tr('クリックと聴いています', 'Listening with clicks')
              : tr('クリックと聴く', 'Listen with clicks')}
        </button>
        {!band && (
          <span className="setup-bpm">
            <b>{bpm}</b>
            <span>BPM</span>
          </span>
        )}
      </div>
      {head && (
        <div className="setup-tpad">
          <button className="btn mono" onClick={() => scaleTempo(2)} aria-label={tr('BPM を 2 倍に', 'Double the BPM')}>
            ×2
          </button>
          <button className="btn mono" onClick={() => scaleTempo(0.5)} aria-label={tr('BPM を半分に', 'Halve the BPM')}>
            ÷2
          </button>
          <button className="btn" onClick={() => shiftHead(-1)} aria-label={tr('曲の頭を 1 拍前にずらす', 'Move the song start one beat earlier')}>
            {Icon.arrowLeft(13)}
            {tr('1 拍', '1 beat')}
          </button>
          <button className="btn" onClick={() => shiftHead(1)} aria-label={tr('曲の頭を 1 拍後ろにずらす', 'Move the song start one beat later')}>
            {tr('1 拍', '1 beat')}
            {Icon.arrowRight(13)}
          </button>
        </div>
      )}
    </>
  );
}

function TempoCheck({ phone }: { phone: boolean }) {
  if (phone)
    return (
      <section className="setup-tempo" aria-label={tr('テンポを聴いて確かめる', 'Check the tempo by ear')}>
        <b>{tr('待つ間に、テンポを聴いて確かめる', 'While you wait, check the tempo by ear')}</b>
        <TempoPad />
        <span className="lbl">{tr('クリックが曲の拍と曲の頭に合っていれば OK。直した分はそのまま譜面に入ります', 'OK if the clicks match the beat and the song start. Changes go straight into the chart')}</span>
      </section>
    );
  return (
    <section className="setup-tempo" aria-label={tr('テンポを聴いて確かめる', 'Check the tempo by ear')}>
      <div className="setup-sub-h">
        <b>{tr('待つ間に、テンポを聴いて確かめる', 'While you wait, check the tempo by ear')}</b>
        <span>{tr('クリックが曲の拍と曲の頭に合っていれば OK', 'OK if the clicks match the beat and the song start')}</span>
      </div>
      <TempoWave />
      <div className="setup-tempo-row">
        <TempoButtons />
      </div>
      <span className="lbl">{tr('直した分はそのまま譜面に入ります。細かいずれはエディタのテンポ合わせで', 'Changes go straight into the chart. Fine-tune small offsets in Tempo in the editor')}</span>
    </section>
  );
}

function SetupFailed() {
  const error = useSetup((s) => s.error);
  return (
    <div className="modal-back setup-back">
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{tr('準備できませんでした', "Couldn't set it up")}</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{error}</p>
        <div className="modal-actions">
          <button className="btn primary" autoFocus onClick={dismissSetup}>
            {tr('閉じる', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
