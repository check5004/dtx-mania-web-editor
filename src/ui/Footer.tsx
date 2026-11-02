import { useEffect, useRef } from 'react';
import { drumChannel } from '../dtx/model';
import { supportsDirectWrite } from '../fs/folder';
import { useAssist } from '../store/assist';
import { bgmSource, docStats, tempoOf } from '../store/derived';
import { sectionColor, useSidecar } from '../store/sidecar';
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

const SEC_H = 15;
const WAVE_H = 30;
const DENS_H = 9;

function SeekBar({ length }: { length: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const playing = useEditor((s) => s.playing);
  const data = useAssist((s) => s.data);
  const loop = useAssist((s) => s.loop);
  const sections = useSidecar((s) => s.sections);
  const colors = useSidecar((s) => s.sectionColors);
  const dragging = useRef(false);
  const cache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.floor(r.width * dpr) || c.height !== Math.floor(r.height * dpr)) {
        c.width = Math.floor(r.width * dpr);
        c.height = Math.floor(r.height * dpr);
      }
      const W = r.width;
      const H = r.height;
      const tempo = tempoOf(doc);
      const len = Math.max(length, 1);
      const bgm = bgmSource(doc);
      const key = [doc, W, H, len, data, bgm?.sec, sections, colors, dpr];
      // 動かない部分（波形・密度・セクション）は覚えておく
      if (!cache.current || cache.current.key.some((v, i) => v !== key[i])) {
        const off = cache.current?.canvas ?? document.createElement('canvas');
        off.width = c.width;
        off.height = c.height;
        const ctx = off.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const waveTop = SEC_H + 3;
        const densTop = waveTop + WAVE_H + 2;
        ctx.fillStyle = '#0B0E13';
        ctx.fillRect(0, waveTop, W, WAVE_H);
        ctx.fillRect(0, densTop, W, DENS_H);
        // セクション
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        if (sections.length === 0) {
          ctx.fillStyle = '#151A21';
          ctx.fillRect(0, 0, W, SEC_H);
          ctx.fillStyle = '#5F6978';
          ctx.fillText('セクション: 小節番号をダブルクリックで付けられます', 6, SEC_H / 2 + 1);
        } else {
          const firstX = (tempo.beatToSec(tempo.measureStart(sections[0].m)) / len) * W;
          if (firstX > 2) {
            ctx.fillStyle = '#151A21';
            ctx.fillRect(0, 0, firstX - 2, SEC_H);
          }
          sections.forEach((sc, i) => {
            const x0 = (tempo.beatToSec(tempo.measureStart(sc.m)) / len) * W;
            const x1 = i + 1 < sections.length ? (tempo.beatToSec(tempo.measureStart(sections[i + 1].m)) / len) * W : W;
            const col = sectionColor(sc.name, colors);
            ctx.fillStyle = col + '55';
            ctx.beginPath();
            ctx.roundRect(x0, 0, Math.max(2, x1 - x0 - 2), SEC_H, 3);
            ctx.fill();
            ctx.fillStyle = col;
            ctx.fillRect(x0, 0, 2, SEC_H);
            ctx.save();
            ctx.beginPath();
            ctx.rect(x0, 0, Math.max(0, x1 - x0 - 4), SEC_H);
            ctx.clip();
            ctx.fillStyle = '#E7EBF1';
            ctx.fillText(sc.name, x0 + 5, SEC_H / 2 + 1);
            ctx.restore();
          });
        }
        // 原曲の波形
        if (data && bgm) {
          const pr = data.peakRate;
          const n = data.peaks.length;
          ctx.fillStyle = '#5D7189';
          const mid = waveTop + WAVE_H / 2;
          for (let x = 0; x < W; x++) {
            const t0 = (x / W) * len - bgm.sec;
            const t1 = ((x + 1) / W) * len - bgm.sec;
            let i0 = Math.floor(t0 * pr);
            let i1 = Math.ceil(t1 * pr);
            if (i1 < 0 || i0 >= n) continue;
            i0 = Math.max(0, i0);
            i1 = Math.min(n - 1, i1);
            let m = 0;
            for (let i = i0; i <= i1; i++) if (data.peaks[i] > m) m = data.peaks[i];
            const h = Math.max(1, m * (WAVE_H / 2 - 1));
            ctx.fillRect(x, mid - h, 1, h * 2);
          }
        } else {
          ctx.fillStyle = '#5F6978';
          ctx.fillText('原曲の波形（原曲を読み込むと出ます）', 6, waveTop + WAVE_H / 2);
        }
        // 譜面の密度
        const bins = Math.max(1, Math.floor(W / 3));
        const counts = new Array(bins).fill(0);
        for (const ch of doc.chips) {
          const d = drumChannel(ch.ch);
          if (!d || d.kind !== 'normal') continue;
          const sec = tempo.beatToSec(tempo.beatOf(ch.m, ch.f));
          counts[Math.max(0, Math.min(bins - 1, Math.floor((sec / len) * bins)))]++;
        }
        const max = Math.max(4, ...counts);
        ctx.fillStyle = 'rgba(76,194,255,.55)';
        for (let i = 0; i < bins; i++) {
          if (!counts[i]) continue;
          const h = Math.max(1.5, (DENS_H * counts[i]) / max);
          ctx.fillRect((i * W) / bins, densTop + DENS_H - h, Math.max(1, W / bins - 1), h);
        }
        cache.current = { key, canvas: off };
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(cache.current.canvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // ループ
      if (loop && loop.b > loop.a) {
        const xa = (tempo.beatToSec(loop.a) / len) * W;
        const xb = (tempo.beatToSec(loop.b) / len) * W;
        ctx.fillStyle = loop.on ? 'rgba(255,199,104,.22)' : 'rgba(255,199,104,.08)';
        ctx.fillRect(xa, SEC_H + 3, Math.max(2, xb - xa), H - SEC_H - 3);
        ctx.fillStyle = loop.on ? '#FFC768' : 'rgba(255,199,104,.5)';
        ctx.fillRect(xa, SEC_H + 3, 1, H - SEC_H - 3);
        ctx.fillRect(xb - 1, SEC_H + 3, 1, H - SEC_H - 3);
      }
      const x = (tempo.beatToSec(Math.max(0, beat)) / len) * W;
      ctx.fillStyle = playing ? '#FFB547' : '#4CC2FF';
      ctx.fillRect(Math.round(x) - 1, SEC_H + 1, 2, H - SEC_H - 1);
      ctx.beginPath();
      ctx.roundRect(Math.round(x) - 4, 0, 9, SEC_H, 2);
      ctx.fill();
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [doc, length, beat, playing, data, loop, sections, colors]);

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
    <div className="seek-row">
      <div className="seek-time mono">
        <span>{formatTime(tempoOf(doc).beatToSec(Math.max(0, beat)))}</span>
        <span className="lbl">/ {formatTime(length)}</span>
      </div>
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
          aria-label="シークバー（セクション・原曲の波形・譜面の密度）"
        />
      </div>
      <div className="seek-legend hide-narrow">
        <span>
          <i style={{ background: '#5D7189' }} />
          原曲の波形
        </span>
        <span>
          <i style={{ background: '#4CC2FF' }} />
          譜面の密度
        </span>
      </div>
    </div>
  );
}
