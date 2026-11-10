// 動画から音を取り出している間に、画面の真ん中に出す様子（やめるボタン付き）。中身は src/store/videoExtract.ts
import { useEffect } from 'react';
import { tr } from '../i18n';
import { useVideoExtract } from '../store/videoExtract';

export function VideoExtractHost() {
  const job = useVideoExtract((s) => s.job);
  useEffect(() => {
    if (!job) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      job.cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [job]);
  if (!job) return null;
  const pct = job.phase === 'encode' ? Math.round(job.progress * 100) : 0;
  return (
    <div className="modal-back">
      <div className="modal video-extract" role="dialog" aria-modal="true" aria-live="polite">
        <h2>{tr('動画から音を取り出しています', 'Taking the audio out of the video')}</h2>
        <p className="ellipsis" title={job.name}>
          {job.name}
        </p>
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
        <p className="lbl" style={{ margin: '8px 0 0' }}>
          {job.phase === 'read'
            ? tr('動画を読んでいます…', 'Reading the video…')
            : tr(`音だけのファイル（OGG）にしています… ${pct}%`, `Making an audio-only file (OGG)… ${pct}%`)}
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={job.cancel}>
            {tr('やめる', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
