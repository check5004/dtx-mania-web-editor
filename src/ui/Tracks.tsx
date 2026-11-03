// 下のトラック：DTM の音声トラックのように、原曲・ステム・譜面の音を1本ずつ並べる。
// トラックごとにミュート・ソロ・音量、解析元、譜面の右の列にスペクトルを出すチェック。上の帯はループとセクション。
import { useEffect, useRef, useState } from 'react';
import { computePeaks, stemKindInfo } from '../audio/stems';
import { engine } from '../audio/engine';
import { DRUM_LANES, drumChannel } from '../dtx/model';
import { pickBgmFile } from '../app/fileActions';
import { beginLoopDrag, dragLoop, endLoopDrag, LOOP_DIV, setLoop, setSpecSource, setWaveMode, useAssist, type LoopDrag } from '../store/assist';
import { bgmSource, tempoOf, wavPath } from '../store/derived';
import { openPage, playFrom, setCursorBeat, setView, useEditor } from '../store/editor';
import { maxTracksH, SEEK_CLOSED_H, togglePanel, useLayout } from '../store/layout';
import { sectionColor, useSidecar, type StemTrack } from '../store/sidecar';
import {
  anySolo,
  chooseAnalysisStem,
  effectiveAnalysisStem,
  importStems,
  PEAK_RATE,
  setChartTrack,
  setOrigTrack,
  soloOnly,
  stemAudible,
  stemPeaks,
  trackAudio,
  updateStem,
  useStems,
} from '../store/stems';
import { formatTime } from './format';
import { usePlayBeat, useSoundsVersion } from './hooks';
import { Icon } from './icons';

/** トラックの見出しの幅 */
export const HEAD_W = 344;
const RULER_H = SEEK_CLOSED_H;
const LOOP_H = 12;
const SEC_H = 14;
const SEC_TOP = LOOP_H + 2;
const ROW_MIN = 24;
const ROW_MAX = 64;

const ORIG_COLOR = '#8FA3BC';
const CHART_COLOR = '#4CC2FF';

/** 曲の長さが分からない空の譜面でも、シークバーで動けるように2分ぶん取っておく */
const seekLength = (length: number) => (length > 0.5 ? length : 120);

const pct = (v: number) => Math.round(v * 100);

type Row =
  | { type: 'orig'; id: 'orig'; name: string; sub: string; color: string; state: 'ready' | 'none' | 'missing' | 'loading' }
  | { type: 'stem'; id: string; name: string; sub: string; color: string; t: StemTrack }
  | { type: 'chart'; id: 'chart'; name: string; sub: string; color: string };

/** 並べるトラック：譜面の音・原曲（ステムがあるときは原曲のファイルが読めたときだけ）・ステム */
function useRows(): Row[] {
  const doc = useEditor((s) => s.doc);
  const loading = useEditor((s) => s.loading);
  const stems = useSidecar((s) => s.stems);
  const status = useStems((s) => s.status);
  useStems((s) => s.version);
  useSoundsVersion();
  // 譜面の音をいちばん上に（トラックが多くて下に隠れても、編集している音はいつも見える）
  const rows: Row[] = [{ type: 'chart', id: 'chart', name: '譜面の音', sub: '置いたチップのドラム', color: CHART_COLOR }];
  const bgm = bgmSource(doc);
  const origBuf = bgm ? engine.buffer(bgm.wav) : null;
  const origFile = bgm ? ((wavPath(doc, bgm.wav) ?? '').split(/[\\/]/).pop() ?? '') : '';
  if (origBuf || stems.length === 0) {
    rows.push({
      type: 'orig',
      id: 'orig',
      name: '原曲',
      sub: origFile || '音声ファイルなし',
      color: ORIG_COLOR,
      state: origBuf ? 'ready' : !bgm ? 'none' : loading ? 'loading' : 'missing',
    });
  }
  for (const t of stems) {
    const st = status[t.file];
    rows.push({
      type: 'stem',
      id: t.file,
      name: t.name,
      sub: `${t.file.replace(/^stems\//, '')}${st === 'missing' ? ' · 見つかりません' : st === 'error' ? ' · 読めません' : st === 'loading' ? ' · 読み込み中…' : ''}`,
      color: stemKindInfo(t.kind).color,
      t,
    });
  }
  return rows;
}

/** トラックが鳴るか（ミュート・ソロ・曲の音をまとめて消しているか） */
function rowAudible(r: Row): boolean {
  const a = engine.audible();
  if (r.type === 'orig') return a.orig;
  if (r.type === 'chart') return a.chart;
  return a.song && stemAudible(r.t);
}

// 原曲の波形（ステムはステムの読み込みで作る）
const origPeaks = new Map<string, Float32Array>();
function peaksOfOrig(): Float32Array | null {
  const bgm = bgmSource(useEditor.getState().doc);
  const got = bgm ? engine.buffer(bgm.wav) : null;
  if (!got) return null;
  let p = origPeaks.get(got.key);
  if (!p) {
    p = computePeaks(got.buf, PEAK_RATE);
    origPeaks.clear();
    origPeaks.set(got.key, p);
  }
  return p;
}

// ---- 操作（シーク・ループ） --------------------------------------------------------

type SeekDrag = { type: 'seek' } | { type: 'loop'; ld: LoopDrag; x0: number } | null;

/** 上の帯とトラックの両方で使う、クリックで再生を始める位置・ループの端のドラッグ */
function useSeekPointer(length: number, ruler: boolean) {
  const drag = useRef<SeekDrag>(null);
  const geomAt = (c: HTMLCanvasElement, clientX: number, clientY: number) => {
    const r = c.getBoundingClientRect();
    const sec = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * seekLength(length);
    const tempo = tempoOf(useEditor.getState().doc);
    return { beat: tempo.secToBeat(sec), y: clientY - r.top, x: clientX - r.left, w: r.width };
  };
  /** A・B の線の近く（どの段でも掴める） */
  const nearHandle = (x: number, w: number): boolean => {
    const l = useAssist.getState().loop;
    if (!l || l.b <= l.a) return false;
    const tempo = tempoOf(useEditor.getState().doc);
    const len = seekLength(length);
    const xa = (tempo.beatToSec(l.a) / len) * w;
    const xb = (tempo.beatToSec(l.b) / len) * w;
    return Math.abs(x - xa) <= 6 || Math.abs(x - xb) <= 6 || (ruler && ((x >= xa - 12 && x < xa) || (x > xb && x <= xb + 12)));
  };
  const beatTol = (w: number) => {
    const tempo = tempoOf(useEditor.getState().doc);
    const secPerPx = seekLength(length) / Math.max(1, w);
    return tempo.secToBeat(secPerPx * 8) - tempo.secToBeat(0);
  };
  const inBand = (y: number) => ruler && y < LOOP_H + 1;
  const seek = (c: HTMLCanvasElement, clientX: number, commit: boolean) => {
    const { beat: b } = geomAt(c, clientX, 0);
    setCursorBeat(b);
    setView({ scrollBeat: Math.max(-1, b - 4), follow: true });
    if (commit && useEditor.getState().playing) void playFrom(b);
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = e.currentTarget;
      const g = geomAt(c, e.clientX, e.clientY);
      if (e.button === 2) {
        if (inBand(g.y)) setLoop(null);
        return;
      }
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      if (inBand(g.y) || nearHandle(g.x, g.w)) {
        drag.current = { type: 'loop', ld: beginLoopDrag(g.beat, beatTol(g.w)), x0: e.clientX };
        // 線を掴んだのに範囲の外と判定されたら、近い方の端にする
        const ld = drag.current.ld;
        if (!inBand(g.y) && (ld.mode === 'new' || ld.mode === 'move')) {
          const l = useAssist.getState().loop!;
          ld.mode = Math.abs(g.beat - l.a) < Math.abs(g.beat - l.b) ? 'a' : 'b';
        }
        return;
      }
      drag.current = { type: 'seek' };
      seek(c, e.clientX, false);
    },
    onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = e.currentTarget;
      const d = drag.current;
      const g = geomAt(c, e.clientX, e.clientY);
      if (!d) {
        c.style.cursor = nearHandle(g.x, g.w) ? 'ew-resize' : inBand(g.y) ? 'crosshair' : 'pointer';
        return;
      }
      if (d.type === 'seek') seek(c, e.clientX, false);
      else dragLoop(d.ld, g.beat, LOOP_DIV, Math.abs(e.clientX - d.x0) > 3);
    },
    onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.type === 'seek') seek(e.currentTarget, e.clientX, true);
      else endLoopDrag(d.ld);
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

/** canvas の大きさを合わせて描く（ResizeObserver で描き直す） */
function useDraw(ref: React.RefObject<HTMLCanvasElement | null>, draw: (ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number) => void, deps: unknown[]) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.floor(r.width * dpr) || c.height !== Math.floor(r.height * dpr)) {
        c.width = Math.floor(r.width * dpr);
        c.height = Math.floor(r.height * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current(ctx, r.width, r.height, dpr);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** ループ（範囲と A・B の線）・再生を始める位置（▶）・再生位置を上に重ねる */
function drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, length: number, top: number, opts: { tabs: boolean; cursor: number; beat: number; playing: boolean }) {
  const doc = useEditor.getState().doc;
  const tempo = tempoOf(doc);
  const len = seekLength(length);
  const loop = useAssist.getState().loop;
  const xOf = (b: number) => (tempo.beatToSec(Math.max(0, b)) / len) * W;
  if (loop && loop.b > loop.a) {
    const xa = xOf(loop.a);
    const xb = xOf(loop.b);
    const on = loop.on;
    ctx.fillStyle = on ? 'rgba(255,199,104,.14)' : 'rgba(255,199,104,.05)';
    ctx.fillRect(xa, top, Math.max(2, xb - xa), H - top);
    const col = on ? '#FFC768' : 'rgba(255,199,104,.55)';
    if (opts.tabs) {
      ctx.fillStyle = on ? 'rgba(255,199,104,.45)' : 'rgba(255,199,104,.16)';
      ctx.fillRect(xa, 0, Math.max(2, xb - xa), LOOP_H);
    }
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(xa), 0, 1, H);
    ctx.fillRect(Math.round(xb) - 1, 0, 1, H);
    if (opts.tabs) {
      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tab = (x: number, label: string) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.roundRect(x, 0, 12, LOOP_H, 2);
        ctx.fill();
        ctx.fillStyle = '#1A1408';
        ctx.fillText(label, x + 6, LOOP_H / 2 + 0.5);
      };
      // A は線の左、B は線の右（重ならない）
      tab(xa - 12, 'A');
      tab(xb, 'B');
      ctx.textAlign = 'left';
    }
  }
  // 再生を始める位置（▶）
  const xc = Math.round(xOf(opts.cursor));
  ctx.fillStyle = '#4CC2FF';
  ctx.globalAlpha = opts.playing ? 0.55 : 1;
  ctx.fillRect(xc - 1, top, 2, H - top);
  if (opts.tabs) {
    ctx.beginPath();
    ctx.moveTo(xc - 5, top);
    ctx.lineTo(xc + 5, top);
    ctx.lineTo(xc, top + 7);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (opts.playing) {
    const x = Math.round(xOf(opts.beat));
    ctx.fillStyle = '#FFB547';
    ctx.fillRect(x - 1, top, 2, H - top);
  }
}

// ---- パネル -----------------------------------------------------------------------

/** M・S・音量・チェックを触ったあとも Space で再生できるように、フォーカスを外す */
export function releaseFocus(e: React.PointerEvent<HTMLElement>) {
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && e.currentTarget.contains(a) && a.tagName !== 'SELECT') a.blur();
}

export function TrackPanel({ length }: { length: number }) {
  const open = useLayout((s) => s.seekOpen);
  const tracksH = useLayout((s) => s.tracksH);
  const [winH, setWinH] = useState(() => window.innerHeight);
  useEffect(() => {
    const h = () => setWinH(window.innerHeight);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  void winH;
  const height = open ? Math.min(tracksH, maxTracksH()) : RULER_H;
  const rows = useRows();
  const bodyH = Math.max(0, height - RULER_H - 1);
  const rowH = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor(bodyH / Math.max(1, rows.length))));
  return (
    <div className="tracks" style={{ height }} onPointerUp={releaseFocus}>
      <div className="tracks-top" style={{ height: RULER_H }}>
        <Corner length={length} open={open} />
        <Ruler length={length} />
      </div>
      {open && (
        <div className="tracks-body scroll" style={{ height: bodyH }}>
          <div className="tracks-grid" style={{ gridTemplateColumns: `${HEAD_W}px minmax(0, 1fr)`, minHeight: '100%' }}>
            <div className="tracks-heads">
              {rows.map((r) => (
                <TrackHead key={r.id} row={r} h={rowH} />
              ))}
            </div>
            <Lanes rows={rows} rowH={rowH} length={length} />
          </div>
        </div>
      )}
    </div>
  );
}

function Corner({ length, open }: { length: number; open: boolean }) {
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const stems = useSidecar((s) => s.stems);
  const busy = useStems((s) => s.busy);
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="tracks-corner" style={{ width: HEAD_W }}>
      <button className="ib tiny" onClick={() => togglePanel('seek')} title={open ? 'トラックを閉じる（上の境目をドラッグで高さを変えられます）' : 'トラックを開く'} aria-expanded={open}>
        {open ? Icon.chevronDown(14) : Icon.chevronUp(14)}
      </button>
      <span className="mono t-now">{formatTime(tempoOf(doc).beatToSec(Math.max(0, beat)))}</span>
      <span className="mono lbl">/ {formatTime(length)}</span>
      <span className="grow" />
      {busy ? (
        <span className="lbl ellipsis" title={busy}>
          {busy}
        </span>
      ) : (
        <>
          <button className="link-btn" onClick={() => file.current?.click()} title="ステム（ドラム・ベース・ボーカルなどに分けた音）を読み込んでトラックにする">
            {Icon.plus(12)} ステム
          </button>
          {stems.length > 0 && (
            <button className="link-btn" onClick={() => openPage('stems')} title="ステムとミックスの画面（頭のずれ・パン・書き出し）">
              {Icon.layers(12)}
            </button>
          )}
        </>
      )}
      <input
        ref={file}
        type="file"
        multiple
        accept="audio/*,.ogg,.wav,.mp3,.flac,.m4a,.opus"
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void importStems(files);
        }}
      />
    </div>
  );
}

/** 上の帯：ループ（A–B）とセクション */
function Ruler({ length }: { length: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const cursor = useEditor((s) => s.cursorBeat);
  const playing = useEditor((s) => s.playing);
  const loop = useAssist((s) => s.loop);
  const sections = useSidecar((s) => s.sections);
  const colors = useSidecar((s) => s.sectionColors);
  const cache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);
  const handlers = useSeekPointer(length, true);
  useDraw(
    ref,
    (ctx, W, H, dpr) => {
      const len = seekLength(length);
      const tempo = tempoOf(doc);
      const key = [doc, W, H, len, sections, colors, dpr];
      if (!cache.current || cache.current.key.some((v, i) => v !== key[i])) {
        const off = cache.current?.canvas ?? document.createElement('canvas');
        off.width = Math.floor(W * dpr);
        off.height = Math.floor(H * dpr);
        const c = off.getContext('2d')!;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, H);
        c.fillStyle = '#0A0D11';
        c.fillRect(0, 0, W, LOOP_H);
        c.font = '10px system-ui, sans-serif';
        c.textBaseline = 'middle';
        c.fillStyle = '#4E4532';
        c.fillText('A–B ループ: ここをドラッグ', 6, LOOP_H / 2 + 1);
        if (sections.length === 0) {
          c.fillStyle = '#151A21';
          c.fillRect(0, SEC_TOP, W, SEC_H);
          c.fillStyle = '#5F6978';
          c.fillText('セクション: 小節番号をダブルクリックで付けられます', 6, SEC_TOP + SEC_H / 2 + 1);
        } else {
          const firstX = (tempo.beatToSec(tempo.measureStart(sections[0].m)) / len) * W;
          if (firstX > 2) {
            c.fillStyle = '#151A21';
            c.fillRect(0, SEC_TOP, firstX - 2, SEC_H);
          }
          sections.forEach((sc, i) => {
            const x0 = (tempo.beatToSec(tempo.measureStart(sc.m)) / len) * W;
            const x1 = i + 1 < sections.length ? (tempo.beatToSec(tempo.measureStart(sections[i + 1].m)) / len) * W : W;
            const col = sectionColor(sc.name, colors);
            c.fillStyle = col + '55';
            c.beginPath();
            c.roundRect(x0, SEC_TOP, Math.max(2, x1 - x0 - 2), SEC_H, 3);
            c.fill();
            c.fillStyle = col;
            c.fillRect(x0, SEC_TOP, 2, SEC_H);
            c.save();
            c.beginPath();
            c.rect(x0, SEC_TOP, Math.max(0, x1 - x0 - 4), SEC_H);
            c.clip();
            c.fillStyle = '#E7EBF1';
            c.fillText(sc.name, x0 + 5, SEC_TOP + SEC_H / 2 + 1);
            c.restore();
          });
        }
        cache.current = { key, canvas: off };
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(cache.current.canvas, 0, 0);
      ctx.restore();
      drawOverlay(ctx, W, H, length, SEC_TOP, { tabs: true, cursor, beat, playing });
    },
    [doc, length, beat, cursor, playing, loop, sections, colors],
  );
  return (
    <canvas
      ref={ref}
      className="tracks-ruler"
      {...handlers}
      aria-label="ループの帯とセクション。クリックで再生を始める位置、上の帯のドラッグでループの範囲"
      title="クリック: 再生を始める位置（▶）/ 上の帯をドラッグ: ループ（A–B）の範囲、A・B の印をドラッグで端を動かす / 右クリック（上の帯）: ループを消す"
    />
  );
}

/** トラックの波形（原曲・ステム）と譜面の音（レーンごとの色の印） */
function Lanes({ rows, rowH, length }: { rows: Row[]; rowH: number; length: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useEditor((s) => s.doc);
  const mix = useEditor((s) => s.mix);
  const beat = usePlayBeat();
  const cursor = useEditor((s) => s.cursorBeat);
  const playing = useEditor((s) => s.playing);
  const loop = useAssist((s) => s.loop);
  const sections = useSidecar((s) => s.sections);
  const stems = useSidecar((s) => s.stems);
  const version = useStems((s) => s.version);
  const sounds = useSoundsVersion();
  const cache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);
  const handlers = useSeekPointer(length, false);
  const H = rows.length * rowH;
  const audible = rows.map(rowAudible).join('');
  useDraw(
    ref,
    (ctx, W, Hc, dpr) => {
      const len = seekLength(length);
      const tempo = tempoOf(doc);
      const bgm = bgmSource(doc);
      const at = bgm?.sec ?? 0;
      const key = [doc, W, Hc, len, rowH, rows.map((r) => r.id).join('|'), audible, sections, stems, version, sounds, dpr];
      if (!cache.current || cache.current.key.some((v, i) => v !== key[i])) {
        const off = cache.current?.canvas ?? document.createElement('canvas');
        off.width = Math.floor(W * dpr);
        off.height = Math.floor(Hc * dpr);
        const c = off.getContext('2d')!;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, Hc);
        c.fillStyle = '#090B0F';
        c.fillRect(0, 0, W, Hc);
        const secPerPx = len / Math.max(1, W);
        rows.forEach((r, i) => {
          const top = i * rowH;
          c.fillStyle = i % 2 ? '#0D1116' : '#0B0E13';
          c.fillRect(0, top, W, rowH);
          c.fillStyle = '#161B22';
          c.fillRect(0, top + rowH - 1, W, 1);
          const on = rowAudible(r);
          c.globalAlpha = on ? 0.9 : 0.28;
          if (r.type === 'chart') {
            // レーンごとの色の印（上が左シンバル、下がライド）
            const pad = 3;
            const laneH = (rowH - pad * 2) / DRUM_LANES.length;
            for (const ch of doc.chips) {
              const d = drumChannel(ch.ch);
              if (!d || d.kind !== 'normal') continue;
              const x = (tempo.beatToSec(tempo.beatOf(ch.m, ch.f)) / len) * W;
              c.fillStyle = DRUM_LANES[d.lane]?.color ?? CHART_COLOR;
              c.fillRect(Math.floor(x), top + pad + d.lane * laneH, 1.5, Math.max(1, laneH - 0.5));
            }
          } else {
            const peaks = r.type === 'orig' ? peaksOfOrig() : stemPeaks(r.id);
            if (peaks) {
              c.fillStyle = r.color;
              const mid = top + rowH / 2;
              const amp = rowH / 2 - 3;
              for (let x = 0; x < W; x++) {
                const t0 = x * secPerPx - at;
                const t1 = t0 + secPerPx;
                let i0 = Math.floor(t0 * PEAK_RATE);
                let i1 = Math.ceil(t1 * PEAK_RATE);
                if (i1 < 0 || i0 >= peaks.length) continue;
                i0 = Math.max(0, i0);
                i1 = Math.min(peaks.length - 1, Math.max(i0, i1));
                let mx = 0;
                for (let k = i0; k <= i1; k++) if (peaks[k] > mx) mx = peaks[k];
                const h = Math.max(0.5, mx * amp);
                c.fillRect(x, mid - h, 1, h * 2);
              }
            } else {
              c.globalAlpha = 1;
              c.font = '11px system-ui, sans-serif';
              c.textBaseline = 'middle';
              c.fillStyle = '#5F6978';
              const msg =
                r.type === 'orig'
                  ? r.state === 'loading'
                    ? '読み込み中…'
                    : r.state === 'missing'
                      ? '原曲のファイルが曲フォルダに見つかりません'
                      : '原曲（音声ファイル）を読み込むと波形が出ます。ステムだけでも使えます（「＋ステム」）'
                  : '読み込み中…';
              c.fillText(msg, 8, top + rowH / 2);
            }
          }
          c.globalAlpha = 1;
        });
        // セクションの区切り
        c.fillStyle = 'rgba(231,235,241,.08)';
        for (const sc of sections) {
          const x = Math.round((tempo.beatToSec(tempo.measureStart(sc.m)) / len) * W);
          c.fillRect(x, 0, 1, Hc);
        }
        cache.current = { key, canvas: off };
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(cache.current.canvas, 0, 0);
      ctx.restore();
      drawOverlay(ctx, W, Hc, length, 0, { tabs: false, cursor, beat, playing });
    },
    [doc, length, beat, cursor, playing, loop, sections, stems, version, sounds, rowH, rows.length, audible, mix],
  );
  return (
    <canvas
      ref={ref}
      className="tracks-lanes"
      style={{ height: H }}
      {...handlers}
      aria-label="トラックの波形。クリックで再生を始める位置、A・B の線をドラッグでループの端"
      title="クリック: 再生を始める位置（▶）/ A・B の線をドラッグ: ループの端を動かす"
    />
  );
}

// ---- トラックの見出し --------------------------------------------------------------

function TrackHead({ row, h }: { row: Row; h: number }) {
  const mix = useEditor((s) => s.mix);
  useSidecar((s) => s.analysisStem);
  useSidecar((s) => s.stems);
  const waveMode = useAssist((s) => s.waveMode);
  const specSource = useAssist((s) => s.specSource);
  const srcKey = useAssist((s) => s.src?.key ?? null);
  const tall = h >= 42;
  const on = rowAudible(row);
  const solo = anySolo();

  if (row.type === 'orig' && row.state !== 'ready') {
    return (
      <div className="trk off" style={{ height: h, borderLeftColor: row.color }}>
        <div className="trk-name">
          <b>{row.name}</b>
          {tall && <span className="sub ellipsis">{row.state === 'missing' ? `${row.sub} · 見つかりません` : row.state === 'loading' ? '読み込み中…' : 'まだありません'}</span>}
        </div>
        <button className="btn small" onClick={pickBgmFile} title="原曲（音声ファイル）を読み込む。曲フォルダにコピーして BGM（#WAV・ch01）に登録します">
          {Icon.plus(13)} 原曲を読み込む
        </button>
      </div>
    );
  }

  // 解析元（波形・原曲の打点・候補チップ・BPM推定に使う音）
  const eff = effectiveAnalysisStem();
  const isAnalysis = row.type === 'stem' ? eff?.file === row.id : row.type === 'orig' ? eff === null : false;
  const audio = row.type !== 'chart' ? trackAudio(row.id) : null;
  const specOn = !!audio && waveMode === 'spec' && (specSource ? specSource === audio.key : audio.key === srcKey);

  const muted = row.type === 'orig' ? mix.origMute : row.type === 'chart' ? mix.drumMute : row.t.mute;
  const soloed = row.type === 'orig' ? mix.origSolo : row.type === 'chart' ? mix.drumSolo : row.t.solo;
  const gain = row.type === 'orig' ? mix.bgm : row.type === 'chart' ? mix.drums : row.t.gain;
  const maxGain = row.type === 'stem' ? 1.5 : 1;
  const defGain = row.type === 'orig' ? 0.8 : row.type === 'chart' ? 0.9 : 1;
  const set = (p: { gain?: number; mute?: boolean; solo?: boolean }) => {
    if (row.type === 'orig') setOrigTrack(p);
    else if (row.type === 'chart') setChartTrack(p);
    else updateStem(row.id, p);
  };
  const why = !on && !muted ? (solo && !soloed ? '（他のトラックがソロ）' : mix.bgmMute && row.type !== 'chart' ? '（曲の音をまとめて消しています）' : '') : '';

  return (
    <div className={`trk ${on ? '' : 'off'}`} style={{ height: h, borderLeftColor: row.color }} title={why ? `鳴っていません${why}` : undefined}>
      <div className="trk-name">
        <b className="ellipsis">{row.name}</b>
        {tall && (
          <span className="sub ellipsis" title={row.sub}>
            {row.sub}
          </span>
        )}
      </div>
      {row.type !== 'chart' ? (
        <button
          className={`radio-btn small ${isAnalysis ? 'on' : ''}`}
          onClick={() => {
            if (row.type === 'orig') chooseAnalysisStem(null);
            else chooseAnalysisStem(isAnalysis && !eff?.auto ? null : row.id);
          }}
          title={
            isAnalysis
              ? '解析元：波形・原曲の打点・候補チップ・BPM推定をこのトラックから作っています'
              : '解析元にする（波形・原曲の打点・候補チップ・BPM推定をこのトラックから作る）'
          }
          aria-label={`${row.name}を解析元にする`}
          aria-pressed={isAnalysis}
        />
      ) : (
        <span className="radio-pad" />
      )}
      <button className={`ms m ${muted ? 'on' : ''}`} onClick={() => set({ mute: !muted })} aria-label={`${row.name}をミュート`} title={`ミュート${row.type === 'chart' ? '（Alt+2）' : ''}`}>
        M
      </button>
      <button
        className={`ms s ${soloed ? 'on' : ''}`}
        onClick={(e) => (e.altKey ? soloOnly(row.id) : set({ solo: !soloed }))}
        aria-label={`${row.name}をソロ`}
        title="ソロ（Alt+クリックでこのトラックだけ）"
      >
        S
      </button>
      <input
        type="range"
        className="trk-vol"
        min={0}
        max={maxGain}
        step={0.01}
        value={gain}
        style={{ accentColor: row.color }}
        onChange={(e) => set({ gain: Number(e.target.value) })}
        onDoubleClick={() => set({ gain: defGain })}
        aria-label={`${row.name}の音量`}
        title={`${row.name}の音量（ダブルクリックで ${pct(defGain)} に戻す）`}
      />
      <span className="mono trk-v">{pct(gain)}</span>
      {row.type !== 'chart' ? (
        <label className={`trk-spec ${specOn ? 'on' : ''}`} title="譜面の右の列にこのトラックのスペクトルを出す（外すと波形に戻ります）">
          <input
            type="checkbox"
            checked={specOn}
            disabled={!audio}
            onChange={(e) => {
              if (e.target.checked && audio) {
                useAssist.setState({ audioCols: true });
                setSpecSource(audio);
              } else {
                setSpecSource(null);
                setWaveMode('wave');
              }
            }}
          />
          スペクトル
        </label>
      ) : (
        <span className="trk-spec pad" />
      )}
    </div>
  );
}
