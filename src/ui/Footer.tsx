import { useEffect, useRef } from 'react';
import { drumChannel } from '../dtx/model';
import { supportsDirectWrite } from '../fs/folder';
import { beginLoopDrag, dragLoop, endLoopDrag, LOOP_DIV, setLoop, useAssist, type LoopDrag } from '../store/assist';
import { SEEK_CLOSED_H, togglePanel, useLayout } from '../store/layout';
import { HSplitter } from './Splitter';
import { bgmSource, docStats, tempoOf } from '../store/derived';
import { sectionColor, useSidecar } from '../store/sidecar';
import { isDirty, playFrom, setCursorBeat, setView, useEditor } from '../store/editor';
import { formatTime } from './format';
import { FooterMixer } from './MixPanel';
import { stemsActive, useStems } from '../store/stems';
import { usePlayBeat, useSongLength, useSoundsVersion } from './hooks';

/** 曲全体のシークバー（ノーツの密度つき）と状態の表示 */
export function Footer() {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  const dirty = useEditor(isDirty);
  const savedAt = useEditor((s) => s.savedAt);
  const missingAll = useEditor((s) => s.missingWavs);
  useStems((s) => s.version);
  useSoundsVersion();
  // ステムを鳴らしているときは、書き出す予定の BGM が無いのは問題にしない
  const anchor = stemsActive() ? bgmSource(doc)?.wav : undefined;
  const missing = missingAll.filter((n) => n !== anchor);
  const stats = docStats(doc);
  const length = useSongLength(doc);

  const where = folder?.dir
    ? `${folder.name}/${meta.fileName}（曲フォルダに直接保存）`
    : supportsDirectWrite()
      ? `${meta.fileName}（保存するときに曲フォルダを選びます）`
      : `${meta.fileName}（ダウンロードで保存）`;

  return (
    <footer className="footer">
      <HSplitter />
      <SeekBar length={length} />
      <div className="status">
        <span className="legend hide-narrow">
          <i style={{ background: '#5D7189' }} />
          原曲の波形
        </span>
        <span className="legend hide-narrow">
          <i style={{ background: '#4CC2FF' }} />
          譜面の密度
        </span>
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

/** 曲の長さが分からない空の譜面でも、シークバーで動けるように2分ぶん取っておく */
const seekLength = (length: number) => (length > 0.5 ? length : 120);

const LOOP_H = 12;
const SEC_H = 14;
const DENS_H = 9;

/** シークバーの段（上から ループの帯・セクション・原曲の波形・譜面の密度）。波形を閉じたら上の2段だけ */
function rows(H: number) {
  const loopTop = 0;
  const secTop = LOOP_H + 2;
  const waveTop = secTop + SEC_H + 3;
  const densTop = H - DENS_H;
  const waveH = Math.max(0, densTop - 2 - waveTop);
  return { loopTop, secTop, waveTop, waveH, densTop, full: waveH >= 8 };
}

type SeekDrag = { type: 'seek' } | { type: 'loop'; ld: LoopDrag; x0: number } | null;

function SeekBar({ length }: { length: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const cursor = useEditor((s) => s.cursorBeat);
  const playing = useEditor((s) => s.playing);
  const data = useAssist((s) => s.data);
  const srcName = useAssist((s) => s.src?.name);
  const loop = useAssist((s) => s.loop);
  const sections = useSidecar((s) => s.sections);
  const colors = useSidecar((s) => s.sectionColors);
  const seekOpen = useLayout((s) => s.seekOpen);
  const seekH = useLayout((s) => s.seekH);
  const drag = useRef<SeekDrag>(null);
  const cache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);
  const height = seekOpen ? seekH : SEEK_CLOSED_H;

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
      const R = rows(H);
      const tempo = tempoOf(doc);
      const len = seekLength(length);
      const bgm = bgmSource(doc);
      const key = [doc, W, H, len, data, bgm?.sec, sections, colors, dpr, srcName];
      // 動かない部分（波形・密度・セクション）は覚えておく
      if (!cache.current || cache.current.key.some((v, i) => v !== key[i])) {
        const off = cache.current?.canvas ?? document.createElement('canvas');
        off.width = c.width;
        off.height = c.height;
        const ctx = off.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        // ループの帯
        ctx.fillStyle = '#0A0D11';
        ctx.fillRect(0, R.loopTop, W, LOOP_H);
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#4E4532';
        ctx.fillText('A–B ループ: ここをドラッグ', 6, R.loopTop + LOOP_H / 2 + 1);
        // セクション
        if (sections.length === 0) {
          ctx.fillStyle = '#151A21';
          ctx.fillRect(0, R.secTop, W, SEC_H);
          ctx.fillStyle = '#5F6978';
          ctx.fillText('セクション: 小節番号をダブルクリックで付けられます', 6, R.secTop + SEC_H / 2 + 1);
        } else {
          const firstX = (tempo.beatToSec(tempo.measureStart(sections[0].m)) / len) * W;
          if (firstX > 2) {
            ctx.fillStyle = '#151A21';
            ctx.fillRect(0, R.secTop, firstX - 2, SEC_H);
          }
          sections.forEach((sc, i) => {
            const x0 = (tempo.beatToSec(tempo.measureStart(sc.m)) / len) * W;
            const x1 = i + 1 < sections.length ? (tempo.beatToSec(tempo.measureStart(sections[i + 1].m)) / len) * W : W;
            const col = sectionColor(sc.name, colors);
            ctx.fillStyle = col + '55';
            ctx.beginPath();
            ctx.roundRect(x0, R.secTop, Math.max(2, x1 - x0 - 2), SEC_H, 3);
            ctx.fill();
            ctx.fillStyle = col;
            ctx.fillRect(x0, R.secTop, 2, SEC_H);
            ctx.save();
            ctx.beginPath();
            ctx.rect(x0, R.secTop, Math.max(0, x1 - x0 - 4), SEC_H);
            ctx.clip();
            ctx.fillStyle = '#E7EBF1';
            ctx.fillText(sc.name, x0 + 5, R.secTop + SEC_H / 2 + 1);
            ctx.restore();
          });
        }
        if (R.full) {
          ctx.fillStyle = '#0B0E13';
          ctx.fillRect(0, R.waveTop, W, R.waveH);
          ctx.fillRect(0, R.densTop, W, DENS_H);
          // 原曲の波形
          if (data && bgm) {
            const pr = data.peakRate;
            const n = data.peaks.length;
            ctx.fillStyle = '#5D7189';
            const mid = R.waveTop + R.waveH / 2;
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
              const h = Math.max(1, m * (R.waveH / 2 - 1));
              ctx.fillRect(x, mid - h, 1, h * 2);
            }
            if (srcName && R.waveH >= 20) {
              ctx.fillStyle = 'rgba(11,14,19,.75)';
              const label = `波形: ${srcName}`;
              const tw = ctx.measureText(label).width + 10;
              ctx.fillRect(W - tw - 4, R.waveTop + 2, tw, 14);
              ctx.fillStyle = '#8B95A4';
              ctx.fillText(label, W - tw + 1, R.waveTop + 9);
            }
          } else {
            ctx.fillStyle = '#5F6978';
            ctx.fillText('原曲の波形（右のパネルの「原曲」から音声ファイルを読み込むと出ます）', 6, R.waveTop + R.waveH / 2);
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
            ctx.fillRect((i * W) / bins, R.densTop + DENS_H - h, Math.max(1, W / bins - 1), h);
          }
        }
        cache.current = { key, canvas: off };
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(cache.current.canvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const xOf = (b: number) => (tempo.beatToSec(Math.max(0, b)) / len) * W;
      // ループ（帯に範囲と A・B の印、下の段に線）
      if (loop && loop.b > loop.a) {
        const xa = xOf(loop.a);
        const xb = xOf(loop.b);
        const on = loop.on;
        ctx.fillStyle = on ? 'rgba(255,199,104,.16)' : 'rgba(255,199,104,.06)';
        ctx.fillRect(xa, R.secTop, Math.max(2, xb - xa), H - R.secTop);
        ctx.fillStyle = on ? 'rgba(255,199,104,.45)' : 'rgba(255,199,104,.16)';
        ctx.fillRect(xa, R.loopTop, Math.max(2, xb - xa), LOOP_H);
        const col = on ? '#FFC768' : 'rgba(255,199,104,.55)';
        ctx.fillStyle = col;
        ctx.fillRect(Math.round(xa), R.loopTop, 1, H);
        ctx.fillRect(Math.round(xb) - 1, R.loopTop, 1, H);
        ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tab = (x: number, label: string) => {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.roundRect(x, R.loopTop, 12, LOOP_H, 2);
          ctx.fill();
          ctx.fillStyle = '#1A1408';
          ctx.fillText(label, x + 6, R.loopTop + LOOP_H / 2 + 0.5);
        };
        // A は線の左、B は線の右（重ならない）
        tab(xa - 12, 'A');
        tab(xb, 'B');
        ctx.textAlign = 'left';
      }
      // 再生を始める位置（▶）
      const xc = Math.round(xOf(cursor));
      ctx.fillStyle = '#4CC2FF';
      ctx.globalAlpha = playing ? 0.55 : 1;
      ctx.fillRect(xc - 1, R.secTop, 2, H - R.secTop);
      ctx.beginPath();
      ctx.moveTo(xc - 5, R.secTop);
      ctx.lineTo(xc + 5, R.secTop);
      ctx.lineTo(xc, R.secTop + 7);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // 再生位置
      if (playing) {
        const x = Math.round(xOf(beat));
        ctx.fillStyle = '#FFB547';
        ctx.fillRect(x - 1, R.secTop, 2, H - R.secTop);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [doc, length, beat, cursor, playing, data, srcName, loop, sections, colors, height]);

  const geomAt = (clientX: number, clientY: number) => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    const sec = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * seekLength(length);
    const tempo = tempoOf(useEditor.getState().doc);
    return { beat: tempo.secToBeat(sec), y: clientY - r.top, x: clientX - r.left, w: r.width, h: r.height, tempo };
  };
  /** A・B の線の近く（どの段でも掴める） */
  const nearHandle = (x: number, w: number): boolean => {
    const l = useAssist.getState().loop;
    if (!l || l.b <= l.a) return false;
    const tempo = tempoOf(useEditor.getState().doc);
    const len = seekLength(length);
    const xa = (tempo.beatToSec(l.a) / len) * w;
    const xb = (tempo.beatToSec(l.b) / len) * w;
    return Math.abs(x - xa) <= 6 || Math.abs(x - xb) <= 6 || (x >= xa - 12 && x < xa) || (x > xb && x <= xb + 12);
  };
  const beatTol = (w: number) => {
    const tempo = tempoOf(useEditor.getState().doc);
    const secPerPx = seekLength(length) / Math.max(1, w);
    return tempo.secToBeat(secPerPx * 8) - tempo.secToBeat(0);
  };

  const seek = (clientX: number, commit: boolean) => {
    const { beat: b } = geomAt(clientX, 0);
    const s = useEditor.getState();
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
        <button className="link-btn seek-toggle" onClick={() => togglePanel('seek')} title={seekOpen ? '下の波形を閉じる（上の境目をドラッグで高さを変えられます）' : '下の波形を開く'}>
          {seekOpen ? '波形を閉じる ▾' : '波形を開く ▴'}
        </button>
      </div>
      <div className="seek" style={{ height }}>
        <canvas
          ref={ref}
          style={{ width: '100%', height: '100%', display: 'block' }}
          onPointerDown={(e) => {
            const g = geomAt(e.clientX, e.clientY);
            if (e.button === 2) {
              if (g.y < LOOP_H + 1) setLoop(null);
              return;
            }
            if (e.button !== 0) return;
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            if (g.y < LOOP_H + 1 || nearHandle(g.x, g.w)) {
              drag.current = { type: 'loop', ld: beginLoopDrag(g.beat, beatTol(g.w)), x0: e.clientX };
              // 線を掴んだのに範囲の外と判定されたら、近い方の端にする
              const ld = drag.current.ld;
              if (g.y >= LOOP_H + 1 && (ld.mode === 'new' || ld.mode === 'move')) {
                const l = useAssist.getState().loop!;
                ld.mode = Math.abs(g.beat - l.a) < Math.abs(g.beat - l.b) ? 'a' : 'b';
              }
              return;
            }
            drag.current = { type: 'seek' };
            seek(e.clientX, false);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            const g = geomAt(e.clientX, e.clientY);
            if (!d) {
              (e.target as HTMLCanvasElement).style.cursor = g.y < LOOP_H + 1 ? (nearHandle(g.x, g.w) ? 'ew-resize' : 'crosshair') : nearHandle(g.x, g.w) ? 'ew-resize' : 'pointer';
              return;
            }
            if (d.type === 'seek') seek(e.clientX, false);
            else dragLoop(d.ld, g.beat, LOOP_DIV, Math.abs(e.clientX - d.x0) > 3);
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (!d) return;
            if (d.type === 'seek') seek(e.clientX, true);
            else endLoopDrag(d.ld);
          }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="シークバー（ループの帯・セクション・原曲の波形・譜面の密度）。クリックで再生を始める位置、上の帯のドラッグでループの範囲"
          title="クリック: 再生を始める位置（▶）/ 上の帯をドラッグ: ループ（A–B）の範囲、A・B の印をドラッグで端を動かす / 右クリック（上の帯）: ループを消す"
        />
      </div>
      <FooterMixer />
    </div>
  );
}
