// 参照映像（YouTube）。譜面の再生に合わせて動く。音は原曲ファイルを鳴らすのが基本。
import { tr, pl, isJa } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { useAssist } from '../store/assist';
import { bgmSource } from '../store/derived';
import { IS_IOS, useDevice } from '../store/device';
import { useEditor } from '../store/editor';
import { setYoutube, useSidecar } from '../store/sidecar';
import { Icon } from './icons';
import { destroyPlayer, mountPlayer, setListen, useYt, youtubeId } from './youtube';
import { alignBlocker, cancelAutoAlign, keepStartOffset, setAutoOnLoad, startAutoAlign, undoAutoAlign, useYtAlign } from './ytAlign';
import { canCaptureTab } from '../audio/tabCapture';

export function ReferenceCard() {
  const yt = useSidecar((s) => s.youtube);
  const st = useYt();
  const srcName = useAssist((s) => s.src?.name);
  const hasBgm = useEditor((s) => bgmSource(s.doc) !== null);
  const [url, setUrl] = useState('');
  const autoOnLoad = useYtAlign((a) => a.autoOnLoad);
  const tablet = useDevice((s) => s.tablet);
  const box = useRef<HTMLDivElement>(null);
  const id = yt ? youtubeId(yt.url) : null;

  useEffect(() => {
    if (!id || !box.current || st.hidden) return;
    void mountPlayer(box.current, id);
    return () => destroyPlayer();
  }, [id, st.hidden]);

  if (!yt) {
    return (
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('参照映像（YouTube）', 'Reference video (YouTube)')}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!youtubeId(url)) return;
            setYoutube({ url: url.trim(), offset: 0 });
            // 原曲があれば、そのまま自動で合わせる（共有の確認は、押した直後でないと出せない）
            if (autoOnLoad && !alignBlocker()) void startAutoAlign();
          }}
        >
          <input className="field" style={{ height: 28 }} placeholder={tr('YouTubeのURL', 'YouTube URL')} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn small" type="submit" disabled={!youtubeId(url)}>
            {tr('読み込む', 'Load')}
          </button>
        </form>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
          {tr(
            '演奏動画などを譜面の再生に合わせて動かします。音は原曲ファイルを鳴らし、YouTubeは消音します（切り替えもできます）。',
            'Plays a video (a drum cover, for example) in sync with the chart. You hear the original audio file and YouTube is muted (you can switch).',
          )}
        </p>
        {canCaptureTab() && (
          <>
            <label className="row lbl" style={{ marginTop: 8, gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoOnLoad} onChange={(e) => setAutoOnLoad(e.target.checked)} />
              {tr('読み込んだら原曲とのずれを自動で合わせる', 'Sync with the original automatically after loading')}
            </label>
            {autoOnLoad && (
              <p className="lbl" style={{ margin: '4px 0 0 20px', lineHeight: 1.6, color: 'var(--dim)' }}>
                {tr(
                  'YouTubeの音を何か所か聞いて、MVの前置きや効果音を避けて曲の所どうしを比べます。ブラウザが「このタブを共有」の確認を出すので「共有」を押してください。',
                  'Listens to the YouTube audio in a few places and compares them with the song, skipping MV intros and sound effects. Your browser will ask to "Share this tab"; click "Share".',
                )}
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  const offset = yt.offset;
  const nudge = (d: number) => setYoutube({ ...yt, offset: Math.round((offset + d) * 1000) / 1000 });

  return (
    <div className="card" style={{ padding: 10 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="section-title">{tr('参照映像', 'Reference video')}</span>
        <span className="lbl">{st.error ? '' : st.ready ? tr('同期中', 'Synced') : tr('読み込み中…', 'Loading…')}</span>
        <span className="grow" />
        <button className="btn small ghost" style={{ height: 22 }} onClick={() => useYt.setState({ hidden: !st.hidden })}>
          {st.hidden ? tr('映像を出す', 'Show video') : tr('映像を隠す', 'Hide video')}
        </button>
        <button
          className="ib"
          style={{ width: 24, height: 24 }}
          title={tr('参照映像を外す', 'Remove the reference video')}
          aria-label={tr('参照映像を外す', 'Remove the reference video')}
          onClick={() => {
            setListen('file');
            setYoutube(null);
          }}
        >
          {Icon.trash(13)}
        </button>
      </div>
      {!st.hidden && (
        <div className="yt-box">
          <div ref={box} />
          {st.error && (
            <div className="yt-error">
              {st.error}
              <a href={yt.url} target="_blank" rel="noreferrer">
                {tr('YouTubeで開く', 'Open on YouTube')}
              </a>
            </div>
          )}
        </div>
      )}
      {!id && (
        <div className="notice" style={{ marginTop: 8 }}>
          {tr('URLから動画を見つけられませんでした。', "Couldn't find a video in that URL.")}
        </div>
      )}
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row">
          <span className="lbl">{tr('聴く音源', 'Listen to')}</span>
          <span className="grow" />
          <div className="seg small">
            <button
              className={st.listen === 'file' && hasBgm ? 'on' : ''}
              onClick={() => setListen('file')}
              disabled={!hasBgm}
              title={hasBgm ? undefined : tr('原曲の音声ファイルが無いので、YouTubeの音を聴きます', "There's no original audio file, so you hear YouTube")}
            >
              {tr('音声ファイル', 'Audio file')}
            </button>
            <button className={st.listen === 'youtube' || !hasBgm ? 'on' : ''} onClick={() => setListen('youtube')} disabled={!st.ready}>
              YouTube
            </button>
          </div>
        </div>
        {tablet ? (
          // タブレット：Shift が無いので 0.1 秒と 0.01 秒のボタンを並べる
          <div className="row t-yt-offset">
            <span className="grow" title={tr('映像が音より遅れて見えるときは ＋ に', 'Use + when the video looks late compared with the audio')}>
              {tr('映像のずれ', 'Video offset')}{' '}
              <b className="mono">
                {offset >= 0 ? '+' : '−'}
                {Math.abs(offset).toFixed(2)} s
              </b>
            </span>
            {(
              [
                [-0.1, '−.1'],
                [-0.01, '−.01'],
                [0.01, '+.01'],
                [0.1, '+.1'],
              ] as const
            ).map(([d, label]) => (
              <button
                key={label}
                className="t-ib boxed mono"
                onClick={() => nudge(d)}
                aria-label={d < 0 ? tr(`${Math.abs(d)} 秒早める`, `Earlier by ${Math.abs(d)} s`) : tr(`${d} 秒遅らせる`, `Later by ${d} s`)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <div className="row">
            <span className="lbl" title={tr('映像が音より遅れて見えるときは ＋ に', 'Use + when the video looks late compared with the audio')}>
              {tr('YouTubeとのずれ', 'YouTube offset')}
            </span>
            <span className="grow" />
            <button className="ib" style={{ width: 24, height: 24, borderColor: 'var(--line3)' }} onClick={(e) => nudge(e.shiftKey ? -0.1 : -0.01)} title={tr('10ms（Shiftで100ms）早める', 'Earlier by 10 ms (100 ms with Shift)')}>
              −
            </button>
            <span className="mono" style={{ fontSize: 12, minWidth: 64, padding: '0 2px', textAlign: 'center', whiteSpace: 'nowrap' }}>
              {offset >= 0 ? '+' : '−'}
              {Math.abs(offset).toFixed(3)} s
            </span>
            <button className="ib" style={{ width: 24, height: 24, borderColor: 'var(--line3)' }} onClick={(e) => nudge(e.shiftKey ? 0.1 : 0.01)} title={tr('10ms（Shiftで100ms）遅らせる', 'Later by 10 ms (100 ms with Shift)')}>
              {tr('＋', '+')}
            </button>
          </div>
        )}
        <AutoAlign />
        <div className="lbl" style={{ lineHeight: 1.6, padding: '7px 9px', borderRadius: 7, background: '#151A21' }}>
          {srcName
            ? tr(`波形と原曲の打点は音声ファイル（${srcName}）から作っています。`, `The waveform and the detected hits come from the audio file (${srcName}). `)
            : tr('波形と原曲の打点は音声ファイルから作ります。', 'The waveform and the detected hits come from the audio file. ')}
          {tr(
            'YouTubeは映像と音の確認用です。ずれは作業ファイル（.dtxe.json）に保存します。',
            'YouTube is only for checking by eye and ear. The offset is saved in the work file (.dtxe.json).',
          )}
        </div>
      </div>
    </div>
  );
}

const kindNote = (k: 'const' | 'drift' | 'edit'): string =>
  ({
    const: '',
    drift: tr(
      'テンポが少しずつ違う動画（ライブ版など）と判断し、所ごとに合わせてなめらかにつないでいます。違うときは「一定にする」で、曲の最初で合わせたずれのままにできます。',
      'This looks like a video whose tempo drifts a little (a live version, for example), so it is synced place by place and joined smoothly. If that\'s wrong, use "Keep constant" to keep the offset found at the start of the song.',
    ),
    edit: tr(
      '途中で編集が違う動画（ゲームサイズ・MVの編集など）と判断し、飛ぶ所で切り替えています。違うときは「一定にする」で、曲の最初で合わせたずれのままにできます。',
      'This looks like a video edited differently partway (a short version or an MV edit, for example), so the offset switches where it jumps. If that\'s wrong, use "Keep constant" to keep the offset found at the start of the song.',
    ),
  })[k];

/** 所ごとの差をやめて、曲の最初のずれのままにするボタン */
function KeepStartButton() {
  return (
    <button className="btn small ghost" style={{ height: 22 }} onClick={keepStartOffset}
      title={tr('所ごとの差を使わず、曲の最初の所で合わせたずれのまま一定にします', 'Ignore the place-by-place differences and keep the offset found at the start of the song')}
    >
      {tr('一定にする', 'Keep constant')}
    </button>
  );
}

/** 自動で合わせる（ボタン・進み具合・結果） */
function AutoAlign() {
  const yt = useSidecar((s) => s.youtube);
  const st = useYtAlign();
  const ready = useYt((s) => s.ready);
  const hasBgm = useEditor((s) => bgmSource(s.doc) !== null);
  if (!yt) return null;
  if (!canCaptureTab()) {
    return (
      <div className="lbl" style={{ lineHeight: 1.6, color: 'var(--dim)' }}>
        {IS_IOS
          ? tr('iPad では自動合わせ（タブの音の共有）が使えません。音を聞き比べて ± で合わせます。', 'Auto-sync (tab audio sharing) is not available on iPad. Match the offset by ear with ±.')
          : tr('原曲とのずれを自動で合わせるのは Chrome・Edge で使えます（このタブの音を聞き取るため）。', 'Automatic sync with the original works in Chrome and Edge (it needs to listen to this tab).')}
      </div>
    );
  }
  const busy = st.phase !== 'idle' && st.phase !== 'done' && st.phase !== 'failed';
  if (busy) {
    const p = st.phase === 'asking' ? 0.03 : st.phase === 'prep' ? 0.08 : st.phase === 'calib' ? 0.14 : Math.min(0.95, 0.14 + (st.probe / 4) * 0.8);
    return (
      <div className="notice info" style={{ flexDirection: 'column', gap: 6 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="grow" style={{ lineHeight: 1.5 }}>
            {st.note}
          </span>
          <button className="btn small ghost" style={{ height: 22 }} onClick={() => cancelAutoAlign()}>
            {tr('やめる', 'Stop')}
          </button>
        </div>
        <div className="progress" style={{ height: 3 }}>
          <div style={{ width: `${Math.round(p * 100)}%` }} />
        </div>
        {st.phase === 'asking' && (
          <span style={{ color: 'var(--text3)', lineHeight: 1.5 }}>
            {tr(
              '「タブの音声も共有する」はオンのままにしてください。合わせているあいだ（30秒〜1分ほど）は音が止まります。',
              'Leave "Also share tab audio" turned on. Playback pauses while syncing (about 30 seconds to a minute).',
            )}
          </span>
        )}
      </div>
    );
  }
  const last = st.phase === 'done' && st.last && st.last.url === yt.url ? st.last : null;
  if (last) {
    const d = last.dec;
    const off = yt.offset;
    const fmt = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3)}`;
    // 所ごとに合わせたときは、曲の中でのずれの幅を出す
    const offs = (yt.anchors ?? []).map((x) => off + x.d);
    const range = offs.length >= 2 ? `${fmt(Math.min(...offs))}${tr('〜', ' to ')}${fmt(Math.max(...offs))} s` : null;
    const undo = (
      <button className="btn small ghost" style={{ height: 22, flex: 'none' }} onClick={undoAutoAlign}
        title={tr('自動で合わせる前のずれに戻します', 'Go back to the offset from before the automatic sync')}
      >
        {tr('元に戻す', 'Undo')}
      </button>
    );
    const note = (t: string) => <span style={{ color: 'var(--text3)', lineHeight: 1.5 }}>{t}</span>;
    return (
      <div className="notice info" style={{ flexDirection: 'column', gap: 4 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="grow" style={{ lineHeight: 1.5 }}>
            {tr('自動で合わせました：', 'Synced automatically: ')}
            <span className="mono">{range ?? `${fmt(off)} s`}</span>
            {range ? tr('（所ごと）', ' (place by place)') : ''}
            {d.kind === 'const' && d.support >= 2
              ? tr(`（${d.support}か所で一致）`, ` (${d.support} places agree)`)
              : d.conf < 0.6
                ? tr('（自信は低め）', ' (low confidence)')
                : ''}
          </span>
          {!range && undo}
        </div>
        {range && kindNote(d.kind) && note(kindNote(d.kind))}
        {!range &&
          d.doubt.length > 0 &&
          note(
            isJa()
              ? `${d.doubt.length}か所で曲の別の所に似た結果が出ましたが、${d.support >= 2 ? `ほかの${d.support}か所がそろっているので、ずれは` : 'ずれを変えるほどの根拠がないので、'}一定のままにしました。`
              : `${d.doubt.length} ${pl(d.doubt.length, 'place')} matched a different part of the song, but ${d.support >= 2 ? `the other ${d.support} places agree, so` : "that wasn't enough to change it, so"} the offset was kept constant.`,
          )}
        {!last.precise &&
          note(
            tr(
              '音が届くまでの遅れを測れなかったので、数十ミリ秒ずれることがあります（± で直せます）。',
              "Couldn't measure the audio output delay, so it may be off by a few tens of milliseconds (fix it with ±).",
            ),
          )}
        {range && (
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <KeepStartButton />
            {undo}
          </div>
        )}
      </div>
    );
  }
  const blocker = hasBgm ? null : tr('原曲の音声ファイルを置くと、自動で合わせられます', 'Add the original audio file to sync automatically');
  return (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
      <span className="lbl grow" style={{ lineHeight: 1.5, color: st.phase === 'failed' ? 'var(--amber)' : undefined }}>
        {st.phase === 'failed' && st.error
          ? st.error
          : blocker
            ? blocker
            : yt.auto
              ? tr('自動で合わせ済み', 'Synced automatically') +
                (yt.anchors?.length ? (yt.auto.kind === 'drift' ? tr('（所ごと・ライブ）', ' (place by place, live)') : tr('（所ごと・編集違い）', ' (place by place, different edit)')) : '')
              : tr('YouTubeの音を聞いて、原曲とのずれを自動で合わせます', 'Listens to the YouTube audio and syncs it with the original automatically')}
      </span>
      {!!yt.anchors?.length && st.phase !== 'failed' && <KeepStartButton />}
      <button
        className={'btn small' + (yt.auto || st.phase === 'failed' ? ' ghost' : ' primary')}
        style={{ height: 24, flex: 'none' }}
        disabled={!ready || !!blocker}
        title={ready ? tr('ブラウザが「このタブを共有」の確認を出します', 'Your browser will ask to "Share this tab"') : tr('動画の読み込みを待っています', 'Waiting for the video to load')}
        onClick={() => void startAutoAlign()}
      >
        {yt.auto || st.phase === 'failed' ? (st.phase === 'failed' ? tr('もう一度', 'Try again') : tr('合わせ直す', 'Sync again')) : tr('自動で合わせる', 'Sync automatically')}
      </button>
    </div>
  );
}
