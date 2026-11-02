import { useEffect, useRef } from 'react';
import { DRUM_LANES, drumChannel } from '../dtx/model';
import { supportsDirectWrite } from '../fs/folder';
import { docStats, tempoOf } from '../store/derived';
import { isDirty, playFrom, setCursorBeat, setView, useEditor } from '../store/editor';
import { formatTime } from './format';
import { songLength, usePlayBeat, useSoundsVersion } from './hooks';

/** 曲全体のシークバー（ノーツの密度つき）と状態の表示 */
export function Footer() {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  const dirty = useEditor(isDirty);
  const savedAt = useEditor((s) => s.savedAt);
  const missing = useEditor((s) => s.missingWavs);
  useSoundsVersion();
  const stats = docStats(doc);
  const length = songLength(doc);

  const where = folder?.dir
    ? `${folder.name}/${meta.fileName}（曲フォルダに直接保存）`
    : supportsDirectWrite()
      ? `${meta.fileName}（保存するときに曲フォルダを選びます）`
      : `${meta.fileName}（ダウンロードで保存）`;

  return (
    <footer className="footer">
      <SeekBar length={length} />
      <div className="status">
        <span>
          ノーツ <b>{stats.notes.toLocaleString()}</b>
        </span>
        <span>
          小節 <b>{stats.measures}</b>
        </span>
        <span>
          WAV <b>{stats.wavCount}</b>
        </span>
        <span>
          長さ <b>{formatTime(length, false)}</b>
        </span>
        {missing.length > 0 && <span className="pill warn">見つからない音 {missing.length}</span>}
        <span className="grow" />
        <span className="ellipsis" style={{ color: dirty ? 'var(--amber)' : 'var(--mute)' }}>
          {dirty ? '未保存の変更あり' : savedAt ? '保存済み' : '変更なし'} · {where}
        </span>
        <span className="pill" title="保存するときの文字コード（NXが読める形式）">
          Shift_JIS
        </span>
      </div>
    </footer>
  );
}

function SeekBar({ length }: { length: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const playing = useEditor((s) => s.playing);
  const dragging = useRef(false);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.floor(r.width * dpr)) {
        c.width = Math.floor(r.width * dpr);
        c.height = Math.floor(r.height * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width;
      const H = r.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0B0E13';
      ctx.fillRect(0, 6, W, H - 12);
      const tempo = tempoOf(doc);
      const len = Math.max(length, 1);
      // ノーツの密度（1秒ごと）
      const bins = Math.max(1, Math.floor(W / 3));
      const counts = new Array(bins).fill(0);
      const colors: number[][] = Array.from({ length: bins }, () => new Array(10).fill(0));
      for (const ch of doc.chips) {
        const d = drumChannel(ch.ch);
        if (!d || d.kind !== 'normal') continue;
        const sec = tempo.beatToSec(tempo.beatOf(ch.m, ch.f));
        const i = Math.min(bins - 1, Math.floor((sec / len) * bins));
        counts[i]++;
        colors[i][d.lane]++;
      }
      const max = Math.max(4, ...counts);
      for (let i = 0; i < bins; i++) {
        if (!counts[i]) continue;
        let best = 0;
        for (let k = 1; k < 10; k++) if (colors[i][k] > colors[i][best]) best = k;
        const h = Math.max(2, ((H - 14) * counts[i]) / max);
        ctx.fillStyle = DRUM_LANES[best].color + '99';
        ctx.fillRect((i * W) / bins, H - 7 - h, Math.max(1, W / bins - 1), h);
      }
      const x = (tempo.beatToSec(Math.max(0, beat)) / len) * W;
      ctx.fillStyle = playing ? '#FFB547' : '#4CC2FF';
      ctx.fillRect(Math.round(x) - 1, 2, 2, H - 4);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [doc, length, beat, playing]);

  const seek = (clientX: number, commit: boolean) => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    const sec = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * Math.max(length, 1);
    const s = useEditor.getState();
    const tempo = tempoOf(s.doc);
    const b = tempo.secToBeat(sec);
    setCursorBeat(b);
    const viewBeats = 8;
    setView({ scrollBeat: Math.max(-1, b - viewBeats / 2), follow: true });
    if (commit && s.playing) void playFrom(b);
  };

  return (
    <div className="seek">
      <canvas
        ref={ref}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
          seek(e.clientX, false);
        }}
        onPointerMove={(e) => dragging.current && seek(e.clientX, false)}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          seek(e.clientX, true);
        }}
        aria-label="シークバー"
      />
    </div>
  );
}
