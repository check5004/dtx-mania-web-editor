// NX 風の落下プレビュー。上から落ちてくるチップが判定ラインに重なる時刻に鳴る（再生中は再生位置、止まっているときはカーソル位置）。
import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { toMeasure } from '../dtx/base36';
import { CH, DRUM_LANES, drumChannel } from '../dtx/model';
import { useInputSettings } from '../input/settings';
import { bgaAt } from '../store/bga';
import { tempoOf } from '../store/derived';
import { togglePlay, useEditor } from '../store/editor';
import { togglePreview, usePreview } from '../store/preview';
import { formatLevel } from './format';
import { Icon } from './icons';
import { thumb, useThumbs } from './thumbs';

/** NX のレーンの太さ（だいたいの比） */
const LANE_W: Record<string, number> = { LC: 1.35, HH: 1, LP: 1, SD: 1.1, HT: 1, BD: 1.3, LT: 1, FT: 1.1, CY: 1.35, RD: 0.85 };
const CYMBAL = new Set(['LC', 'CY', 'RD']);

interface Note {
  sec: number;
  lane: number;
  ch: number;
}

const noteCache = new WeakMap<object, { notes: Note[]; bars: { sec: number; m: number }[]; beats: number[] }>();

function notesOf(doc: ReturnType<typeof useEditor.getState>['doc']) {
  let v = noteCache.get(doc);
  if (v) return v;
  const t = tempoOf(doc);
  const notes: Note[] = [];
  for (const c of doc.chips) {
    const d = drumChannel(c.ch);
    if (!d || d.kind !== 'normal') continue;
    notes.push({ sec: t.beatToSec(t.beatOf(c.m, c.f)), lane: d.lane, ch: c.ch });
  }
  notes.sort((a, b) => a.sec - b.sec);
  const lastSec = notes.length ? notes[notes.length - 1].sec + 4 : 8;
  const bars: { sec: number; m: number }[] = [];
  const beats: number[] = [];
  for (let m = 0; m < 3600; m++) {
    const b0 = t.measureStart(m);
    const s0 = t.beatToSec(b0);
    if (s0 > lastSec) break;
    bars.push({ sec: s0, m });
    const n = t.measureBeats(m);
    for (let k = 1; k < n - 1e-6; k++) beats.push(t.beatToSec(b0 + k));
  }
  v = { notes, bars, beats };
  noteCache.set(doc, v);
  return v;
}

function lowerBound(arr: { sec: number }[], sec: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].sec < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function NxPreview({ full = false }: { full?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const speed = usePreview((s) => s.speed);
  const bgaOn = usePreview((s) => s.bga);
  useThumbs((s) => s.ver);

  useEffect(() => {
    const canvas = cv.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let lastSec: number | null = null;
    const flash = new Map<number, number>();
    const resize = () => {
      const r = wrap.current!.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      w = Math.max(1, Math.floor(r.width));
      h = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap.current!);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = useEditor.getState();
      const doc = s.doc;
      const t = tempoOf(doc);
      const playing = engine.playing;
      const now = engine.heardSec() ?? t.beatToSec(Math.max(0, s.cursorBeat));
      const p = usePreview.getState();
      const { notes, bars, beats } = notesOf(doc);
      const order = useInputSettings.getState().laneOrder;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);

      // 背景の BGA（レイヤー1〜の最後の画像を重ねる）
      if (p.bga) {
        const bg = bgaAt(doc, (m, f) => t.beatOf(m, f), t.secToBeat(now));
        for (const mat of bg.layers) {
          if (!mat) continue;
          const img = thumb(mat.path);
          if (!img) continue;
          const sc = Math.max(w / img.width, h / img.height);
          ctx.globalAlpha = 0.45;
          ctx.drawImage(img, (w - img.width * sc) / 2, (h - img.height * sc) / 2, img.width * sc, img.height * sc);
          ctx.globalAlpha = 1;
        }
        if (bg.movie) {
          ctx.fillStyle = 'rgba(179,157,219,.8)';
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(`🎬 ${bg.movie.m.path}`, w - 10, h - 10);
        }
      }

      // レーン
      const total = order.reduce((a, l) => a + LANE_W[DRUM_LANES[l].key], 0);
      const laneArea = Math.min(w - 24, full ? Math.min(760, h * 1.05) : w - 24);
      const unit = laneArea / total;
      const x0 = (w - laneArea) / 2;
      const judgeY = Math.round(h * (full ? 0.86 : 0.84));
      const pxPerSec = (h * 0.42 * p.speed) / 1;
      const xs: { x: number; w: number }[] = new Array(10);
      let x = x0;
      for (const l of order) {
        const lw = LANE_W[DRUM_LANES[l].key] * unit;
        xs[l] = { x, w: lw };
        x += lw;
      }
      ctx.fillStyle = 'rgba(8,10,14,.82)';
      ctx.fillRect(x0, 0, laneArea, h);
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      for (let i = 0; i <= order.length; i++) {
        const xx = i < order.length ? xs[order[i]].x : x0 + laneArea;
        ctx.fillRect(Math.round(xx), 0, 1, h);
      }

      // 判定ラインより下（叩いた音の光）
      const secAtY = (y: number) => now + (judgeY - y) / pxPerSec;
      const topSec = secAtY(-20);
      const botSec = secAtY(h + 20);

      // 小節線・拍線
      for (const b of beats) {
        if (b < botSec || b > topSec) continue;
        const y = judgeY - (b - now) * pxPerSec;
        ctx.fillStyle = 'rgba(255,255,255,.06)';
        ctx.fillRect(x0, Math.round(y), laneArea, 1);
      }
      ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'right';
      for (let i = Math.max(0, lowerBound(bars, botSec) - 1); i < bars.length && bars[i].sec <= topSec; i++) {
        const y = judgeY - (bars[i].sec - now) * pxPerSec;
        ctx.fillStyle = 'rgba(255,255,255,.22)';
        ctx.fillRect(x0, Math.round(y), laneArea, 1);
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.fillText(toMeasure(bars[i].m), x0 - 4, y + 3);
      }

      // 叩いた瞬間の光
      if (playing && lastSec !== null && now > lastSec && now - lastSec < 0.25) {
        for (let i = lowerBound(notes, lastSec); i < notes.length && notes[i].sec <= now; i++) flash.set(notes[i].lane, performance.now());
      }
      lastSec = playing ? now : null;
      const nowMs = performance.now();
      for (const [lane, at] of flash) {
        const a = 1 - (nowMs - at) / 180;
        if (a <= 0) {
          flash.delete(lane);
          continue;
        }
        const { x: lx, w: lw } = xs[lane];
        const grd = ctx.createLinearGradient(0, judgeY - 140, 0, judgeY);
        grd.addColorStop(0, 'rgba(255,255,255,0)');
        grd.addColorStop(1, DRUM_LANES[lane].color + Math.round(a * 140).toString(16).padStart(2, '0'));
        ctx.fillStyle = grd;
        ctx.fillRect(lx + 1, judgeY - 140, lw - 1, 140);
      }

      // 判定ライン
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(x0, judgeY - 1, laneArea, 3);
      ctx.fillStyle = 'rgba(76,194,255,.35)';
      ctx.fillRect(x0, judgeY + 2, laneArea, 6);

      // チップ（判定ラインに届いたら消えて光る。ラインより下には描かない）
      const start = lowerBound(notes, now);
      for (let i = start; i < notes.length; i++) {
        const n = notes[i];
        if (n.sec > topSec) break;
        const y = judgeY - (n.sec - now) * pxPerSec;
        const def = DRUM_LANES[n.lane];
        const { x: lx, w: lw } = xs[n.lane];
        const color = n.ch === CH.HHO || n.ch === CH.LBD ? (def.altColor ?? def.color) : def.color;
        const ch = CYMBAL.has(def.key) ? 9 : def.key === 'BD' ? 10 : 8;
        const cx0 = lx + 3;
        const cw = lw - 6;
        const grd = ctx.createLinearGradient(0, y - ch / 2, 0, y + ch / 2);
        grd.addColorStop(0, '#FFFFFF');
        grd.addColorStop(0.35, color);
        grd.addColorStop(1, color);
        ctx.fillStyle = grd;
        ctx.beginPath();
        const r = CYMBAL.has(def.key) ? ch / 2 : 2;
        ctx.roundRect(cx0, y - ch / 2, cw, ch, r);
        ctx.fill();
        if (n.ch === CH.HHO) {
          ctx.strokeStyle = '#0B0E13';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(lx + lw / 2, y, 2.6, 0, Math.PI * 2);
          ctx.stroke();
        } else if (n.ch === CH.LBD) {
          ctx.fillStyle = 'rgba(11,14,19,.6)';
          ctx.fillRect(lx + lw / 2 - 1, y - ch / 2 + 1, 2, ch - 2);
        }
      }

      // レーン名
      ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const l of order) {
        ctx.fillStyle = DRUM_LANES[l].color;
        ctx.fillText(DRUM_LANES[l].key, xs[l].x + xs[l].w / 2, judgeY + 22);
      }

      // 情報
      const { m } = t.locate(Math.max(0, t.secToBeat(now)));
      ctx.textAlign = 'left';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#E7EBF1';
      ctx.fillText(doc.fields['TITLE'] || '無題', 10, 18);
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = '#A3ADBB';
      ctx.fillText(`BPM ${Math.round(t.bpmAt(t.secToBeat(now)) * 10) / 10}  #${toMeasure(m)}`, 10, 34);
      ctx.textAlign = 'right';
      ctx.fillText(`Lv ${formatLevel(doc.fields['DLEVEL'])}  ${notes.length} notes`, w - 10, 18);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [full]);

  return (
    <div className={`nx-preview ${full ? 'full' : ''}`}>
      <div className="nx-head row">
        <b>NX風プレビュー</b>
        <span className="grow" />
        <label className="row lbl" style={{ gap: 6 }} title="落ちてくる速さ（NX のハイスピード）">
          速さ
          <input type="range" min={0.5} max={4} step={0.25} value={speed} onChange={(e) => usePreview.setState({ speed: Number(e.target.value) })} style={{ width: 90 }} />
          <span className="mono">×{speed.toFixed(2)}</span>
        </label>
        <label className="row lbl" style={{ gap: 4 }}>
          <input type="checkbox" checked={bgaOn} onChange={(e) => usePreview.setState({ bga: e.target.checked })} />
          BGA
        </label>
        <button className="ib tiny" onClick={() => togglePreview(full ? 'side' : 'full')} title={full ? '右のパネルに戻す' : '全画面（Shift+P）'}>
          {full ? '⤡' : '⤢'}
        </button>
        <button className="ib tiny" onClick={() => usePreview.setState({ mode: 'off' })} aria-label="閉じる" title="閉じる（P）">
          ✕
        </button>
      </div>
      <div ref={wrap} className="nx-canvas" onDoubleClick={togglePlay}>
        <canvas ref={cv} aria-label="NX風プレビュー" />
      </div>
      <div className="nx-foot lbl">
        {Icon.play(11)} Space で再生・停止。止めているときはカーソルの位置を出します。見た目は NX に寄せた目安で、最終確認は NX で行ってください。
      </div>
    </div>
  );
}
