// おまかせで準備のあと、エディタの上に出す「準備ができました」の帯。
// できた物・できなかった物を並べ、テンポだけはもう一度クリックと一緒に聴いて直せる。閉じればいつもの画面。
// PC・iPad は譜面の上の真ん中、iPhone は譜面の上の端いっぱい（聴くボタンを大きく、直すボタンは 4 つ並べる）
import { tr } from '../i18n';
import { isDiskFolder } from '../fs/folder';
import { useDevice } from '../store/device';
import { openTempo, useEditor } from '../store/editor';
import { localPlace } from '../store/localSongs';
import { dismissSetup, measureLabel, stepLabel, tempoSummary, useSetup } from '../app/setup';
import { simpleHead } from '../app/setupTempo';
import { Icon } from './icons';
import { TempoButtons, TempoPad } from './SetupProgress';

/** 帯を出すか（準備が終わって、その譜面を開いている） */
export function useSetupReady(): boolean {
  return useSetup((s) => s.status === 'done' && !!s.ready);
}

export function SetupReady() {
  const show = useSetupReady();
  const phone = useDevice((s) => s.phone);
  const tablet = useDevice((s) => s.tablet);
  const steps = useSetup((s) => s.steps);
  const ready = useSetup((s) => s.ready);
  const diff = useSetup((s) => s.difficulty);
  const folder = useEditor((s) => s.folder);
  // テンポを直したら書き直す
  useSetup((s) => s.steps.find((x) => x.id === 'tempo')?.chip);
  if (!show || !ready) return null;
  const done = steps.filter((s) => s.state === 'done');
  const failed = steps.filter((s) => s.state === 'fail');
  const tempo = steps.find((s) => s.id === 'tempo');
  const head = tempoSummary();
  const from = measureLabel(tempo?.state === 'done' && head ? head.m : 1);
  return (
    <section className={`setup-ready ${phone ? 'phone' : tablet ? 'tablet' : ''}`} aria-label={tr('準備ができました', 'Ready')}>
      <div className="setup-ready-head">
        <span className="setup-ready-ok">{Icon.check(15)}</span>
        <div className="setup-ready-title">
          <b>{tr('準備ができました', 'All set')}</b>
          <span>
            {phone
              ? tr(`${diff} · ${from} 小節から打ち込めます`, `${diff} · Start from measure ${from}`)
              : tr(`${diff} の譜面を作りました。下の ${from} 小節から打ち込めます`, `Made the ${diff} chart. Start placing notes from measure ${from} below`)}
          </span>
        </div>
        <button className={`setup-x ${phone ? '' : 'small'}`} onClick={dismissSetup} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
          {Icon.close(14)}
        </button>
      </div>
      <div className="setup-ready-chips">
        {done.map((s) => (
          <span key={s.id} className="setup-rchip" title={s.note}>
            <span className="ok">✓</span>
            {s.chip || stepLabel(s.id)}
          </span>
        ))}
        <span className={`setup-rchip ${ready.saved ? '' : 'fail'}`}>
          <span className={ready.saved ? 'ok' : 'ng'}>{ready.saved ? '✓' : '!'}</span>
          {ready.saved
            ? isDiskFolder(folder)
              ? tr('曲フォルダに保存', 'Saved to the song folder')
              : tr(`${localPlace()}に保存`, `Saved in ${localPlace()}`)
            : tr('まだ保存していません（上の「保存」で）', 'Not saved yet (use Save above)')}
        </span>
      </div>
      {failed.length > 0 && (
        <div className="setup-ready-fails">
          {failed.map((s) => (
            <div key={s.id} className="setup-ready-fail">
              {Icon.warn(13)}
              <span>
                <b>{stepLabel(s.id)}</b>
                {s.note ? tr(`：${s.note}`, `: ${s.note}`) : ''}
              </span>
            </div>
          ))}
          <span className="lbl">{tr('できなかった物は、あとでエディタからやり直せます', 'You can redo these from the editor later')}</span>
        </div>
      )}
      <div className="setup-ready-tempo">
        {tempo?.state === 'done' ? (
          <>
            <span className="setup-ready-q">{tr('テンポは合っていますか？', 'Is the tempo right?')}</span>
            {phone ? <TempoPad band /> : <TempoButtons compact />}
          </>
        ) : (
          <span className="setup-ready-q">{tempo ? tr('テンポは自動で決められませんでした', "The tempo couldn't be set automatically") : tr('テンポはまだ合わせていません', 'The tempo is not set yet')}</span>
        )}
        {!phone && <span className="grow" />}
        <button className={phone ? 'link-btn' : 'btn ghost'} onClick={openTempo}>
          {simpleHead() || !tempo ? tr('テンポ合わせを開く', 'Open Tempo') : tr('テンポ合わせで直す', 'Fix it in Tempo')}
        </button>
      </div>
    </section>
  );
}
