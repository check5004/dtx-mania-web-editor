// 参照映像（YouTube）。譜面の再生に合わせて動く。音は原曲ファイルを鳴らすのが基本。
import { useEffect, useRef, useState } from 'react';
import { useAssist } from '../store/assist';
import { setYoutube, useSidecar } from '../store/sidecar';
import { Icon } from './icons';
import { destroyPlayer, mountPlayer, setListen, useYt, youtubeId } from './youtube';

export function ReferenceCard() {
  const yt = useSidecar((s) => s.youtube);
  const st = useYt();
  const srcName = useAssist((s) => s.src?.name);
  const [url, setUrl] = useState('');
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
            if (youtubeId(url)) setYoutube({ url: url.trim(), offset: 0 });
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
            <button className={st.listen === 'file' ? 'on' : ''} onClick={() => setListen('file')}>
              音声ファイル
            </button>
            <button className={st.listen === 'youtube' ? 'on' : ''} onClick={() => setListen('youtube')} disabled={!st.ready}>
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
          <span className="mono" style={{ fontSize: 12, width: 64, textAlign: 'center' }}>
            {offset >= 0 ? '+' : '−'}
            {Math.abs(offset).toFixed(3)} s
          </span>
          <button className="ib" style={{ width: 24, height: 24, borderColor: 'var(--line3)' }} onClick={(e) => nudge(e.shiftKey ? 0.1 : 0.01)} title="10ms（Shiftで100ms）遅らせる">
            ＋
          </button>
        </div>
        <div className="lbl" style={{ lineHeight: 1.6, padding: '7px 9px', borderRadius: 7, background: '#151A21' }}>
          {srcName ? `波形と候補チップは音声ファイル（${srcName}）から作っています。` : '波形と候補チップは音声ファイルから作ります。'}
          YouTubeは映像と音の確認用です。ずれは作業ファイル（.dtxe.json）に保存します。
        </div>
      </div>
    </div>
  );
}
