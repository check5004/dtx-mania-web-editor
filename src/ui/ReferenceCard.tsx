// 参照映像（YouTube）。譜面の再生に合わせて動く。音は原曲ファイルを鳴らすのが基本。
import { useEffect, useRef, useState } from 'react';
import { useAssist } from '../store/assist';
import { bgmSource } from '../store/derived';
import { useEditor } from '../store/editor';
import { setYoutube, useSidecar } from '../store/sidecar';
import { Icon } from './icons';
import { destroyPlayer, mountPlayer, setListen, useYt, youtubeId } from './youtube';
import { alignBlocker, cancelAutoAlign, setAutoOnLoad, startAutoAlign, undoAutoAlign, useYtAlign } from './ytAlign';
import { canCaptureTab } from '../audio/tabCapture';

export function ReferenceCard() {
  const yt = useSidecar((s) => s.youtube);
  const st = useYt();
  const srcName = useAssist((s) => s.src?.name);
  const hasBgm = useEditor((s) => bgmSource(s.doc) !== null);
  const [url, setUrl] = useState('');
  const autoOnLoad = useYtAlign((a) => a.autoOnLoad);
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
          参照映像（YouTube）
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
          <input className="field" style={{ height: 28 }} placeholder="YouTubeのURL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn small" type="submit" disabled={!youtubeId(url)}>
            読み込む
          </button>
        </form>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
          演奏動画などを譜面の再生に合わせて動かします。音は原曲ファイルを鳴らし、YouTubeは消音します（切り替えもできます）。
        </p>
        {canCaptureTab() && (
          <>
            <label className="row lbl" style={{ marginTop: 8, gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoOnLoad} onChange={(e) => setAutoOnLoad(e.target.checked)} />
              読み込んだら原曲とのずれを自動で合わせる
            </label>
            {autoOnLoad && (
              <p className="lbl" style={{ margin: '4px 0 0 20px', lineHeight: 1.6, color: 'var(--dim)' }}>
                YouTubeの音を何か所か聞いて、MVの前置きや効果音を避けて曲の所どうしを比べます。ブラウザが「このタブを共有」の確認を出すので「共有」を押してください。
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
        <span className="section-title">参照映像</span>
        <span className="lbl">{st.error ? '' : st.ready ? '同期中' : '読み込み中…'}</span>
        <span className="grow" />
        <button className="btn small ghost" style={{ height: 22 }} onClick={() => useYt.setState({ hidden: !st.hidden })}>
          {st.hidden ? '映像を出す' : '映像を隠す'}
        </button>
        <button
          className="ib"
          style={{ width: 24, height: 24 }}
          title="参照映像を外す"
          aria-label="参照映像を外す"
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
                YouTubeで開く
              </a>
            </div>
          )}
        </div>
      )}
      {!id && <div className="notice" style={{ marginTop: 8 }}>URLから動画を見つけられませんでした。</div>}
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row">
          <span className="lbl">聴く音源</span>
          <span className="grow" />
          <div className="seg small">
            <button
              className={st.listen === 'file' && hasBgm ? 'on' : ''}
              onClick={() => setListen('file')}
              disabled={!hasBgm}
              title={hasBgm ? undefined : '原曲の音声ファイルが無いので、YouTubeの音を聴きます'}
            >
              音声ファイル
            </button>
            <button className={st.listen === 'youtube' || !hasBgm ? 'on' : ''} onClick={() => setListen('youtube')} disabled={!st.ready}>
              YouTube
            </button>
          </div>
        </div>
        <div className="row">
          <span className="lbl" title="映像が音より遅れて見えるときは ＋ に">
            YouTubeとのずれ
          </span>
          <span className="grow" />
          <button className="ib" style={{ width: 24, height: 24, borderColor: 'var(--line3)' }} onClick={(e) => nudge(e.shiftKey ? -0.1 : -0.01)} title="10ms（Shiftで100ms）早める">
            −
          </button>
          <span className="mono" style={{ fontSize: 12, minWidth: 64, padding: '0 2px', textAlign: 'center', whiteSpace: 'nowrap' }}>
            {offset >= 0 ? '+' : '−'}
            {Math.abs(offset).toFixed(3)} s
          </span>
          <button className="ib" style={{ width: 24, height: 24, borderColor: 'var(--line3)' }} onClick={(e) => nudge(e.shiftKey ? 0.1 : 0.01)} title="10ms（Shiftで100ms）遅らせる">
            ＋
          </button>
        </div>
        <AutoAlign />
        <div className="lbl" style={{ lineHeight: 1.6, padding: '7px 9px', borderRadius: 7, background: '#151A21' }}>
          {srcName ? `波形と原曲の打点は音声ファイル（${srcName}）から作っています。` : '波形と原曲の打点は音声ファイルから作ります。'}
          YouTubeは映像と音の確認用です。ずれは作業ファイル（.dtxe.json）に保存します。
        </div>
      </div>
    </div>
  );
}

const KIND_NOTE = {
  const: '',
  drift: 'テンポが少しずつ違う動画（ライブ版など）なので、所ごとに合わせてなめらかにつないでいます。',
  edit: '途中で編集が違う所があります（ゲームサイズ・MVの編集など）。所ごとに合わせ、飛ぶ所で切り替えます。',
} as const;

/** 自動で合わせる（ボタン・進み具合・結果） */
function AutoAlign() {
  const yt = useSidecar((s) => s.youtube);
  const st = useYtAlign();
  const ready = useYt((s) => s.ready);
  const hasBgm = useEditor((s) => bgmSource(s.doc) !== null);
  if (!yt) return null;
  if (!canCaptureTab()) {
    return <div className="lbl" style={{ lineHeight: 1.6, color: 'var(--dim)' }}>原曲とのずれを自動で合わせるのは Chrome・Edge で使えます（このタブの音を聞き取るため）。</div>;
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
            やめる
          </button>
        </div>
        <div className="progress" style={{ height: 3 }}>
          <div style={{ width: `${Math.round(p * 100)}%` }} />
        </div>
        {st.phase === 'asking' && <span style={{ color: 'var(--text3)', lineHeight: 1.5 }}>「タブの音声も共有する」はオンのままにしてください。合わせているあいだ（30秒〜1分ほど）は音が止まります。</span>}
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
    const range = offs.length >= 2 ? `${fmt(Math.min(...offs))}〜${fmt(Math.max(...offs))} s` : null;
    return (
      <div className="notice info" style={{ flexDirection: 'column', gap: 4 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="grow" style={{ lineHeight: 1.5 }}>
            自動で合わせました：
            <span className="mono">{range ?? `${fmt(off)} s`}</span>
            {range ? '（所ごと）' : ''}
            {d.kind === 'const' && d.support >= 2 ? `（${d.support}か所で一致）` : d.conf < 0.6 ? '（自信は低め）' : ''}
          </span>
          <button className="btn small ghost" style={{ height: 22 }} onClick={undoAutoAlign} title="自動で合わせる前のずれに戻します">
            元に戻す
          </button>
        </div>
        {KIND_NOTE[d.kind] && <span style={{ color: 'var(--text3)', lineHeight: 1.5 }}>{KIND_NOTE[d.kind]}</span>}
        {!last.precise && <span style={{ color: 'var(--text3)', lineHeight: 1.5 }}>音が届くまでの遅れを測れなかったので、数十ミリ秒ずれることがあります（± で直せます）。</span>}
      </div>
    );
  }
  const blocker = hasBgm ? null : '原曲の音声ファイルを置くと、自動で合わせられます';
  return (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
      <span className="lbl grow" style={{ lineHeight: 1.5, color: st.phase === 'failed' ? 'var(--amber)' : undefined }}>
        {st.phase === 'failed' && st.error
          ? st.error
          : blocker
            ? blocker
            : yt.auto
              ? `自動で合わせ済み${yt.auto.kind === 'drift' ? '（所ごと・ライブ）' : yt.auto.kind === 'edit' ? '（所ごと・編集違い）' : ''}`
              : 'YouTubeの音を聞いて、原曲とのずれを自動で合わせます'}
      </span>
      <button
        className={'btn small' + (yt.auto || st.phase === 'failed' ? ' ghost' : ' primary')}
        style={{ height: 24, flex: 'none' }}
        disabled={!ready || !!blocker}
        title={ready ? 'ブラウザが「このタブを共有」の確認を出します' : '動画の読み込みを待っています'}
        onClick={() => void startAutoAlign()}
      >
        {yt.auto || st.phase === 'failed' ? (st.phase === 'failed' ? 'もう一度' : '合わせ直す') : '自動で合わせる'}
      </button>
    </div>
  );
}
