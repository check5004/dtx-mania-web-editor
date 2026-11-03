// ステムとミックスの画面：トラックを縦に並べた DTM 風の再生、解析元の選択、書き出しと DTX への登録。
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { STEM_KINDS, stemKindInfo } from '../audio/stems';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { drumChannel } from '../dtx/model';
import { toggleLoop, useAssist } from '../store/assist';
import { bgmSource, tempoOf } from '../store/derived';
import { backToChart, goToStart, playFrom, setCursorBeat, setMix, togglePause, togglePlay, useEditor } from '../store/editor';
import { sectionColor, useSidecar, type StemTrack } from '../store/sidecar';
import {
  chooseAnalysisStem,
  effectiveAnalysisStem,
  defaultExportName,
  exportRangeSec,
  exportStems,
  fileExists,
  importStems,
  LISTEN_PRESETS,
  PEAK_RATE,
  removeStem,
  setChartTrack,
  setListen,
  setStemKind,
  soloOnly,
  stemAudible,
  stemInfo,
  stemPeaks,
  stemsDuration,
  updateStem,
  useStems,
  type ExportMode,
  type ExportOptions,
  type ExportRange,
} from '../store/stems';
import { confirmDialog } from './dialogs';
import { formatPosition, formatTime } from './format';
import { useCanvas, usePlayBeat, useSongSpan } from './hooks';
import { Icon } from './icons';
import { StemTrackPopover } from './StemTrackPopover';

const RULER_H = 40;
const ROW_H = 96;

type Zoom = 'all' | 16 | 4;

const db = (g: number) => (g <= 0.0001 ? '−∞ dB' : `${g >= 1 ? '+' : ''}${(20 * Math.log10(g)).toFixed(1)} dB`.replace('+0.0', '0.0').replace('-', '−'));
const panLabel = (p: number) => (Math.abs(p) < 0.05 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 10)}`);

export function StemsPage() {
  const doc = useEditor((s) => s.doc);
  const stems = useSidecar((s) => s.stems);
  const busy = useStems((s) => s.busy);
  useStems((s) => s.version);
  const span = useSongSpan(doc);
  const fileInput = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [zoom, setZoom] = useState<Zoom>('all');

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-back')) backToChart();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const total = Math.max(span, stemsDuration() + (bgmSource(doc)?.sec ?? 0), 10);
  const sr = stems.length ? stemInfo(stems[0].file)?.sampleRate : undefined;

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(false);
    void importStems([...e.dataTransfer.files]);
  };

  return (
    <div className="stems-page" onDragOver={(e) => (e.preventDefault(), e.stopPropagation(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={drop}>
      <header className="tempo-head">
        <button className="btn small ghost" onClick={backToChart}>
          {Icon.back(14)} エディタに戻る
        </button>
        <div className="vsep" />
        <h1>ステムとミックス</h1>
        <span className="lbl ellipsis" style={{ minWidth: 0 }}>
          {doc.fields['TITLE'] || '無題'} · ステム {stems.length}本{stems.length ? ` · ${formatTime(stemsDuration(), false)}` : ''}
          {sr ? ` · ${(sr / 1000).toFixed(1)} kHz` : ''}
          {busy ? ` · ${busy}` : ''}
        </span>
        <span className="grow" />
        <span className="lbl hide-narrow">再生位置・ループはエディタと共通です</span>
        <button className="btn small" onClick={() => fileInput.current?.click()}>
          {Icon.plus(14)} ステムを追加
        </button>
        <input
          ref={fileInput}
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
      </header>
      <StemsTransport zoom={zoom} setZoom={setZoom} />
      <div className="stems-body">
        <div className="stems-main scroll">
          <div className="stems-grid">
            <div className="stems-list">
              <div className="stems-list-head" style={{ height: RULER_H }}>
                <b>トラック</b>
                <span className="grow" />
                <span className="lbl">M ミュート · S ソロ · ◉ 解析に使う</span>
              </div>
              {stems.map((t) => (
                <TrackHead key={t.file} t={t} />
              ))}
              <ChartHead />
            </div>
            <Lanes total={total} zoom={zoom} />
          </div>
          <div
            className={`stems-drop ${drag ? 'over' : ''}`}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && fileInput.current?.click()}
          >
            <span className="ic">{Icon.wave(22)}</span>
            <span>
              <b>ここにファイルをまとめてドロップしてステムを追加</b>
              <span className="lbl" style={{ display: 'block', marginTop: 4 }}>
                ステム分離ソフトで作ったファイルを読み込みます。ファイル名の drums・ドラム・Dr・(No Drums)・bass・vocals・弦楽器 などから種類と名前を自動で決め（名前と種類はトラックの ✎ で変えられます）、長さとサンプリングレートの違いを確かめます。ファイルは曲フォルダの stems/
                にコピーし、作業ファイル（.dtxe.json）に記録します。NXはこのフォルダを読まないので、遊ぶときの邪魔になりません。分ける前の原曲は、譜面画面の右のパネルの「原曲」から読み込みます（ステムだけでも、ドラムか最初のトラックから波形を作ります）。
              </span>
            </span>
          </div>
        </div>
        <ExportPanel />
      </div>
    </div>
  );
}

function StemsTransport({ zoom, setZoom }: { zoom: Zoom; setZoom: (z: Zoom) => void }) {
  const doc = useEditor((s) => s.doc);
  const playing = useEditor((s) => s.playing);
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const listen = useStems((s) => s.listen);
  const stems = useSidecar((s) => s.stems);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const hasDrums = stems.some((t) => t.kind === 'drums');
  const markM = loopMark ? toMeasure(tempo.locate(loopMark.beat).m) : '';
  const loopLabel = loop
    ? `${toMeasure(tempo.locate(loop.a).m)}–${toMeasure(tempo.locate(Math.max(loop.a, loop.b - 1e-6)).m)}`
    : loopMark
      ? loopMark.side === 'a'
        ? `${markM}–?`
        : `?–${markM}`
      : null;
  return (
    <div className="transport">
      <button className="ib" title="曲の頭へ。▶ を曲の頭に置きます" onClick={goToStart}>
        {Icon.toStart()}
      </button>
      <button
        className="play-btn"
        onClick={togglePlay}
        title={playing ? '停止（Space）。次はまた ▶ から再生します（表示は止めた所のまま）' : '▶ の位置から再生（Space）。止めると再生位置は ▶ に戻ります'}
        aria-label={playing ? '停止' : '再生'}
      >
        {playing ? Icon.stop(18) : Icon.play(18)}
      </button>
      <button
        className="ib"
        onClick={togglePause}
        title="ここで止める（Shift+Space）。止めた所に ▶ を移すので、次はそこから続けて再生します"
        aria-label="ここで止める"
        disabled={!playing}
      >
        {Icon.pause()}
      </button>
      <div className="pos-box">
        <span className="pos-main">{formatPosition(tempo, beat)}</span>
        <span className="pos-sub">{formatTime(tempo.beatToSec(Math.max(0, beat)))}</span>
      </div>
      <button
        className={`btn small loop-btn ${loop?.on ? 'on' : ''}`}
        onClick={toggleLoop}
        title={
          loop
            ? 'ループのオン・オフ（範囲は譜面画面の左端・下の波形・全体図の「A・B」の帯をドラッグして決めます）'
            : loopMark
              ? `${loopMark.side === 'a' ? 'A（始まり）' : 'B（終わり）'}だけ決めています。譜面画面で${loopMark.side === 'a' ? ' B（O）' : ' A（I）'}も決めるとループします`
              : 'ループ再生（範囲が無ければ今の小節）'
        }
      >
        {Icon.loop(14)} ループ {loopLabel && <span className="mono">{loopLabel}</span>}
      </button>
      <div className="vsep" />
      <span className="lbl">聞こえ方</span>
      <div className="seg">
        {LISTEN_PRESETS.map((p) => (
          <button key={p.id} className={listen === p.id ? 'on' : ''} disabled={p.id === 'drums' && !hasDrums} onClick={() => setListen(p.id)} title={stems.length ? p.hint : p.hintNoStems}>
            {p.label}
          </button>
        ))}
      </div>
      <span className="grow" />
      <span className="lbl">ズーム</span>
      <div className="seg small">
        {(
          [
            ['all', '曲全体'],
            [16, '16小節'],
            [4, '4小節'],
          ] as const
        ).map(([z, label]) => (
          <button key={z} className={zoom === z ? 'on' : ''} onClick={() => setZoom(z)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TrackHead({ t }: { t: StemTrack }) {
  useSidecar((s) => s.analysisStem);
  useStems((s) => s.version);
  const eff = effectiveAnalysisStem();
  const analysis = eff?.file ?? null;
  const listen = useStems((s) => s.listen);
  const comparePan = listen === 'compare' && t.kind === 'drums';
  const status = useStems((s) => s.status[t.file]);
  useEditor((s) => s.mix);
  const [open, setOpen] = useState(false);
  // 名前と種類を変える小窓
  const [pop, setPop] = useState<DOMRect | null>(null);
  const openPop = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget.closest('.track-head');
    if (el) setPop(el.getBoundingClientRect());
  };
  const info = stemKindInfo(t.kind);
  const off = !stemAudible(t);
  return (
    <div
      className="track-head"
      style={{ height: ROW_H, borderLeftColor: info.color, opacity: off ? 0.6 : 1 }}
      onContextMenu={(e) => {
        e.preventDefault();
        openPop(e);
      }}
    >
      <div className="row" style={{ gap: 6 }}>
        <span className="trk-title">
          <b className="ellipsis" style={{ fontSize: 13.5 }} onDoubleClick={openPop} title={`${t.name}（ダブルクリックで名前と種類を変える）`}>
            {t.name}
          </b>
          <button className={`ib trk-edit ${pop ? 'open' : ''}`} onClick={openPop} title="名前と種類を変える（名前のダブルクリック・右クリックでも）" aria-label={`${t.name}の名前と種類を変える`}>
            {Icon.pencil(12)}
          </button>
        </span>
        <button className="ib tiny" onClick={() => setOpen(!open)} title="種類・頭のずれ・削除" aria-expanded={open}>
          {Icon.gear(13)}
        </button>
        <span className="grow" />
        <button
          className={`radio-btn ${analysis === t.file ? 'on' : ''}`}
          onClick={() => chooseAnalysisStem(analysis === t.file && !eff?.auto ? null : t.file)}
          title={
            analysis === t.file && eff?.auto
              ? '原曲のファイルが無いので、このトラックから波形・原曲の打点を作っています（クリックで固定）'
              : '波形・原曲の打点・BPM推定をこのトラックから作る'
          }
          aria-label={`${t.name}を解析に使う`}
          aria-pressed={analysis === t.file}
        />
        <button className={`ms m ${t.mute ? 'on' : ''}`} onClick={() => updateStem(t.file, { mute: !t.mute })} aria-label={`${t.name}をミュート`}>
          M
        </button>
        <button className={`ms s ${t.solo ? 'on' : ''}`} onClick={(e) => (e.altKey ? soloOnly(t.file) : updateStem(t.file, { solo: !t.solo }))} aria-label={`${t.name}をソロ`} title="ソロ（Alt+クリックでこのトラックだけ）">
          S
        </button>
      </div>
      {open ? (
        <div className="track-edit">
          <select className="field" value={t.kind} onChange={(e) => setStemKind(t.file, e.target.value as StemTrack['kind'])} aria-label={`${t.name}の種類`}>
            {STEM_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <label className="row lbl" style={{ gap: 4 }} title="頭のずれ（ミリ秒）。正なら遅らせます">
            ずれ
            <input
              className="field mono"
              type="number"
              step={1}
              defaultValue={t.offsetMs}
              style={{ width: 70 }}
              onBlur={(e) => updateStem(t.file, { offsetMs: Math.round(Number(e.target.value) || 0) })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            ms
          </label>
          <button
            className="ib tiny"
            title="このステムを外す（ファイルは消しません）"
            onClick={async () => {
              if (await confirmDialog({ title: `${t.name}を外しますか？`, body: '曲フォルダの stems/ のファイルは消さずに残します。', ok: '外す', danger: true })) removeStem(t.file);
            }}
          >
            {Icon.trash(13)}
          </button>
        </div>
      ) : (
        <div className="track-file mono ellipsis" title={t.file}>
          {t.file.replace(/^stems\//, '')}
          {status === 'missing' && <span style={{ color: 'var(--danger)' }}> · 見つかりません</span>}
          {status === 'error' && <span style={{ color: 'var(--danger)' }}> · 読めません</span>}
          {status === 'loading' && <span> · 読み込み中…</span>}
          {t.offsetMs !== 0 && <span> · ずれ {t.offsetMs} ms</span>}
        </div>
      )}
      <div className="row track-knobs">
        <input type="range" min={0} max={1.5} step={0.01} value={t.gain} style={{ accentColor: info.color }} onChange={(e) => updateStem(t.file, { gain: Number(e.target.value) })} aria-label={`${t.name}の音量`} />
        <span className="mono lbl" style={{ width: 52 }}>
          {db(t.gain)}
        </span>
        <span className="lbl">パン</span>
        <input type="range" min={-1} max={1} step={0.05} value={t.pan} className="pan" onChange={(e) => updateStem(t.file, { pan: Number(e.target.value) })} onDoubleClick={() => updateStem(t.file, { pan: 0 })} aria-label={`${t.name}のパン`} />
        <span className="mono lbl" style={{ width: 22 }} title={comparePan ? '聴き比べ中は左に振ります' : undefined}>
          {comparePan ? 'L10' : panLabel(t.pan)}
        </span>
      </div>
      {pop && <StemTrackPopover file={t.file} anchor={pop} onClose={() => setPop(null)} />}
    </div>
  );
}

function ChartHead() {
  const mix = useEditor((s) => s.mix);
  const meta = useEditor((s) => s.meta);
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const lastM = Math.max(0, ...doc.chips.map((c) => c.m));
  const soloChart = mix.drumSolo;
  return (
    <div className="track-head" style={{ height: ROW_H, borderLeftColor: 'var(--accent)' }}>
      <div className="row" style={{ gap: 6 }}>
        <b style={{ fontSize: 13.5, whiteSpace: 'nowrap' }}>譜面の音</b>
        <span className="pill" style={{ height: 18, fontSize: 10 }} title="エディタで置いたチップの音。参考に鳴らすだけで、書き出しには含めません">
          参考・書き出さない
        </span>
        <span className="grow" />
        <button
          className={`ms m ${mix.drumMute ? 'on' : ''}`}
          onClick={() => setChartTrack({ mute: !mix.drumMute })}
          aria-label="譜面の音をミュート"
        >
          M
        </button>
        <button
          className={`ms s ${soloChart ? 'on' : ''}`}
          onClick={(e) => (e.altKey ? soloOnly('chart') : setChartTrack({ solo: !soloChart }))}
          aria-label="譜面の音をソロ"
        >
          S
        </button>
      </div>
      <div className="track-file mono ellipsis">
        {meta.fileName} · {toMeasure(tempo.locate(Math.max(0, beat)).m)} / {toMeasure(lastM)} 小節まで
      </div>
      <div className="row track-knobs">
        <input type="range" min={0} max={1} step={0.01} value={mix.drums} onChange={(e) => setMix({ drums: Number(e.target.value) })} aria-label="譜面の音の音量" />
        <span className="mono lbl" style={{ width: 52 }}>
          {db(mix.drums)}
        </span>
        <span className="lbl">パン</span>
        <input type="range" min={-1} max={1} step={0.05} value={mix.drumPan} className="pan" onChange={(e) => setMix({ drumPan: Number(e.target.value) })} onDoubleClick={() => setMix({ drumPan: 0 })} aria-label="譜面の音のパン" />
        <span className="mono lbl" style={{ width: 22 }}>
          {panLabel(mix.drumPan)}
        </span>
      </div>
    </div>
  );
}

/** トラックの波形（曲全体か、再生位置のまわりの数小節） */
function Lanes({ total, zoom }: { total: number; zoom: Zoom }) {
  const doc = useEditor((s) => s.doc);
  const stems = useSidecar((s) => s.stems);
  const sections = useSidecar((s) => s.sections);
  const colors = useSidecar((s) => s.sectionColors);
  useSidecar((s) => s.analysisStem);
  const version = useStems((s) => s.version);
  const analysis = effectiveAnalysisStem()?.file ?? null;
  const loop = useAssist((s) => s.loop);
  const loopMark = useAssist((s) => s.loopMark);
  const playing = useEditor((s) => s.playing);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const anchor = bgmSource(doc)?.sec ?? 0;
  const mix = useEditor((s) => s.mix);
  const audible = stems.map((t) => (stemAudible(t) ? 1 : 0)).join('');
  const dragging = useRef(false);

  // 見せる範囲（秒）。ズーム中は再生位置の入っている数小節（ページ送り）。
  // 止めても表示は止めた所のまま。止めている間に ▶ を動かしたら ▶ の所を見せる
  const cursor = useEditor((s) => s.cursorBeat);
  const playM = tempo.locate(Math.max(0, beat)).m;
  const [curM, setCurM] = useState(playM);
  useEffect(() => {
    if (playing) setCurM(playM);
  }, [playing, playM]);
  useEffect(() => {
    const s = useEditor.getState();
    if (!s.playing) setCurM(tempoOf(s.doc).locate(Math.max(0, cursor)).m);
  }, [cursor]);
  const page = zoom === 'all' ? 0 : curM - (curM % zoom);
  const win = useMemo(() => {
    if (zoom === 'all') return { from: 0, to: total };
    return { from: tempo.beatToSec(tempo.measureStart(page)), to: tempo.beatToSec(tempo.measureStart(page + zoom)) };
  }, [zoom, total, tempo, page]);

  const H = RULER_H + ROW_H * (stems.length + 1);
  const cache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);

  const ref = useCanvas(
    (ctx, W) => {
      const dpr = window.devicePixelRatio || 1;
      const X = (sec: number) => ((sec - win.from) / (win.to - win.from)) * W;
      const key = [doc, W, H, win.from, win.to, version, stems, sections, colors, analysis, dpr, audible];
      if (!cache.current || cache.current.key.some((v, i) => v !== key[i])) {
        const off = cache.current?.canvas ?? document.createElement('canvas');
        off.width = Math.floor(W * dpr);
        off.height = Math.floor(H * dpr);
        const c = off.getContext('2d')!;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, H);
        // セクションと小節番号
        c.font = '10.5px system-ui, sans-serif';
        c.textBaseline = 'middle';
        sections.forEach((sc, i) => {
          const x0 = X(tempo.beatToSec(tempo.measureStart(sc.m)));
          const x1 = i + 1 < sections.length ? X(tempo.beatToSec(tempo.measureStart(sections[i + 1].m))) : W;
          if (x1 < 0 || x0 > W) return;
          const col = sectionColor(sc.name, colors);
          c.fillStyle = col + '55';
          c.beginPath();
          c.roundRect(x0 + 1, 3, Math.max(2, x1 - x0 - 3), 15, 3);
          c.fill();
          c.save();
          c.beginPath();
          c.rect(x0, 0, Math.max(0, x1 - x0 - 4), 20);
          c.clip();
          c.fillStyle = '#E7EBF1';
          c.fillText(sc.name, x0 + 6, 11);
          c.restore();
        });
        const secPerPx = (win.to - win.from) / W;
        const startM = tempo.locate(Math.max(0, tempo.secToBeat(win.from))).m;
        const mPx = (tempo.beatToSec(tempo.measureStart(startM + 1)) - tempo.beatToSec(tempo.measureStart(startM))) / secPerPx;
        const step = [1, 2, 4, 8, 16, 32, 64].find((k) => k * mPx >= 40) ?? 128;
        c.font = '10px "JetBrains Mono", ui-monospace, monospace';
        for (let m = startM; m < 3600; m++) {
          const sec = tempo.beatToSec(tempo.measureStart(m));
          if (sec > win.to) break;
          const x = Math.round(X(sec));
          if (m % step === 0) {
            c.fillStyle = '#2C3440';
            c.fillRect(x, RULER_H - 18, 1, H - RULER_H + 18);
            c.fillStyle = '#5F6978';
            c.fillText(toMeasure(m), x + 3, RULER_H - 9);
          } else if (mPx >= 6) {
            c.fillStyle = '#171C23';
            c.fillRect(x, RULER_H, 1, H - RULER_H);
          }
        }
        // トラック
        stems.forEach((t, i) => {
          const top = RULER_H + i * ROW_H;
          const info = stemKindInfo(t.kind);
          c.fillStyle = i % 2 ? '#0D1116' : '#0B0E13';
          c.fillRect(0, top, W, ROW_H);
          c.fillStyle = '#1E242D';
          c.fillRect(0, top + ROW_H - 1, W, 1);
          const peaks = stemPeaks(t.file);
          const off = !stemAudible(t);
          if (peaks) {
            c.fillStyle = info.color;
            c.globalAlpha = off ? 0.3 : 0.9;
            const mid = top + ROW_H / 2 + 6;
            const amp = ROW_H / 2 - 14;
            for (let x = 0; x < W; x++) {
              const t0 = win.from + x * secPerPx - anchor;
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
            c.globalAlpha = 1;
          }
          const note = analysis === t.file ? '解析元: 波形・原曲の打点・BPM推定に使います' : (() => {
            const inf = stemInfo(t.file);
            return inf && inf.shortBy > 0.01 ? `他より ${inf.shortBy.toFixed(2)} 秒短い → 末尾を無音で埋めてそろえます` : '';
          })();
          if (note) {
            c.font = '11px system-ui, sans-serif';
            c.fillStyle = analysis === t.file ? '#CBB8FF' : '#FFC768';
            c.fillText(note, 10, top + 13);
          }
        });
        // 譜面の密度
        const top = RULER_H + stems.length * ROW_H;
        c.fillStyle = '#0B0E13';
        c.fillRect(0, top, W, ROW_H);
        c.font = '11px system-ui, sans-serif';
        c.fillStyle = '#8B95A4';
        c.fillText('譜面の密度（エディタで置いたチップ）', 10, top + 13);
        const bins = Math.max(1, Math.floor(W / 4));
        const counts = new Array(bins).fill(0);
        for (const ch of doc.chips) {
          const d = drumChannel(ch.ch);
          if (!d || d.kind !== 'normal') continue;
          const x = X(tempo.beatToSec(tempo.beatOf(ch.m, ch.f)));
          if (x < 0 || x >= W) continue;
          counts[Math.min(bins - 1, Math.floor((x / W) * bins))]++;
        }
        const max = Math.max(4, ...counts);
        c.fillStyle = 'rgba(76,194,255,.75)';
        for (let i = 0; i < bins; i++) {
          if (!counts[i]) continue;
          const h = Math.max(2, ((ROW_H - 30) * counts[i]) / max);
          c.fillRect((i * W) / bins, top + ROW_H - 6 - h, Math.max(1, W / bins - 1), h);
        }
        cache.current = { key, canvas: off };
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(cache.current.canvas, 0, 0);
      ctx.restore();
      // ループ
      if (loop && loop.b > loop.a) {
        const xa = X(tempo.beatToSec(loop.a));
        const xb = X(tempo.beatToSec(loop.b));
        ctx.fillStyle = loop.on ? 'rgba(255,199,104,.12)' : 'rgba(255,199,104,.05)';
        ctx.fillRect(xa, RULER_H, Math.max(2, xb - xa), H - RULER_H);
        ctx.fillStyle = loop.on ? '#FFC768' : 'rgba(255,199,104,.5)';
        ctx.fillRect(xa, RULER_H - 18, 1.5, H);
        ctx.fillRect(xb - 1.5, RULER_H - 18, 1.5, H);
      } else if (loopMark) {
        // A だけ・B だけ：もう片方を決めるまでループしないので点線
        const x = X(tempo.beatToSec(loopMark.beat)) - (loopMark.side === 'b' ? 1.5 : 0);
        ctx.strokeStyle = '#FFC768';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 0.75, RULER_H - 18);
        ctx.lineTo(x + 0.75, H);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 譜面の音を消しているとき
      if (!engine.audible().chart) {
        ctx.fillStyle = 'rgba(11,14,19,.55)';
        ctx.fillRect(0, RULER_H + stems.length * ROW_H, W, ROW_H);
      }
      const x = X(tempo.beatToSec(Math.max(0, beat)));
      ctx.fillStyle = playing ? '#FFB547' : '#4CC2FF';
      ctx.fillRect(Math.round(x) - 1, RULER_H - 18, 2, H);
    },
    [doc, stems, sections, colors, analysis, version, loop, loopMark, playing, beat, win, H, audible, mix],
  );

  const seek = (clientX: number, commit: boolean) => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    const sec = win.from + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (win.to - win.from);
    const b = tempoOf(useEditor.getState().doc).secToBeat(sec);
    setCursorBeat(b);
    if (commit && useEditor.getState().playing) void playFrom(b);
  };

  return (
    <div className="stems-lanes">
      <canvas
        ref={ref}
        style={{ width: '100%', height: H, display: 'block', cursor: 'pointer' }}
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
        aria-label="ステムの波形（クリックで再生位置を動かす）"
      />
    </div>
  );
}

// ---- 書き出し -------------------------------------------------------------------

const MODES: { id: ExportMode; title: string; body: string; badge?: string }[] = [
  { id: 'bgm', title: 'BGM用（ドラム抜き）', badge: 'おすすめ', body: 'ドラム以外を1本にまとめます。NXでは譜面のドラム音が鳴るので、BGMはドラム抜きが基本です。' },
  { id: 'all', title: '全部を1本に', body: '原曲と同じ音になります。試聴用（#PREVIEW）や確認に。' },
  { id: 'selected', title: '選んだステムを1本に', body: '下で選んだステムだけをまとめます。' },
  { id: 'each', title: '選んだステムを1本ずつ', body: 'ステムごとに別のファイルにします。DTXには登録しません。' },
];

function defaultInclude(mode: ExportMode, stems: StemTrack[]): string[] {
  if (mode === 'bgm') return stems.filter((t) => t.kind !== 'drums').map((t) => t.file);
  return stems.map((t) => t.file);
}

function ExportPanel() {
  const stems = useSidecar((s) => s.stems);
  const busy = useStems((s) => s.busy);
  const doc = useEditor((s) => s.doc);
  const loop = useAssist((s) => s.loop);
  const selection = useEditor((s) => s.selection);
  const [mode, setMode] = useState<ExportMode>('bgm');
  const [include, setInclude] = useState<string[]>(() => defaultInclude('bgm', stems));
  const [useTrack, setUseTrack] = useState(true);
  const [normalize, setNormalize] = useState(true);
  const [range, setRange] = useState<ExportRange>('song');
  const [format, setFormat] = useState<'ogg' | 'wav'>('ogg');
  const [name, setName] = useState(() => defaultExportName('bgm', 'ogg'));
  const [previewReg, setPreviewReg] = useState(true);
  const [selReg, setSelReg] = useState<'bgm' | 'preview' | 'none'>('none');
  const stemKey = stems.map((t) => t.file).join('|');
  useEffect(() => {
    setInclude(defaultInclude(mode, stems));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, stemKey]);
  useEffect(() => {
    setName(defaultExportName(mode, format));
    if (mode === 'bgm') setRange('song');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => {
    setName((n) => (mode === 'each' ? n : n.replace(/\.(ogg|wav)$/i, '') + (format === 'ogg' ? '.ogg' : '.wav')));
  }, [format, mode]);

  const included = stems.filter((t) => include.includes(t.file));
  const r = exportRangeSec(mode === 'bgm' ? 'song' : range);
  const dur = r ? Math.max(0, r.to - r.from) : 0;
  const bytes = format === 'ogg' ? dur * 24000 : dur * 44100 * 4;
  const files = mode === 'each' ? included.length : 1;
  const register: ExportOptions['register'] = mode === 'bgm' ? 'bgm' : mode === 'all' ? (previewReg ? 'preview' : 'none') : mode === 'selected' ? selReg : 'none';
  const bgm = bgmSource(doc);
  const bgmAt = bgm ? `${toMeasure(tempoOf(doc).locate(bgm.beat).m)}小節 +${(bgm.sec - tempoOf(doc).beatToSec(tempoOf(doc).measureStart(tempoOf(doc).locate(bgm.beat).m))).toFixed(3)} 秒` : '001小節';
  const outName = mode === 'each' ? `${name.replace(/\{名前\}/g, '…')}.${format}` : name;
  const canRun = !busy && included.length > 0 && !!r && dur > 0.1 && name.trim() !== '';
  const summary =
    mode === 'bgm'
      ? `ドラム以外の ${included.length}本 → ${outName}`
      : mode === 'all'
        ? `全部の ${included.length}本 → ${outName}`
        : mode === 'selected'
          ? `選んだ ${included.length}本 → ${outName}`
          : `${included.length}本を別々のファイルに（${outName}）`;
  const run = async () => {
    const targets = mode === 'each' ? included.map((t) => `${name.replace(/\{名前\}/g, t.name)}.${format}`) : [name];
    const exists = targets.filter(fileExists);
    if (exists.length) {
      const ok = await confirmDialog({ title: `${exists.join('、')} を上書きしますか？`, body: '曲フォルダに同じ名前のファイルがあります。', ok: '上書き', danger: true });
      if (!ok) return;
    }
    await exportStems({ mode, include, useTrackSettings: useTrack, normalize, range: mode === 'bgm' ? 'song' : range, format, fileName: name, register });
  };

  if (stems.length === 0) {
    return (
      <aside className="stems-export scroll">
        <div className="section-title">書き出し</div>
        <p className="lbl" style={{ lineHeight: 1.7 }}>
          ステムを読み込むと、BGM用（ドラム抜き）などを書き出してDTXに登録できます。
        </p>
      </aside>
    );
  }

  return (
    <aside className="stems-export">
      <div className="scroll stems-export-body">
        <div className="row" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 15 }}>書き出し</b>
          <span className="grow" />
          <span className="lbl">曲フォルダに保存</span>
        </div>
        <div className="mode-cards">
          {MODES.map((m) => (
            <button key={m.id} className={`mode-card ${mode === m.id ? 'on' : ''}`} onClick={() => setMode(m.id)} aria-pressed={mode === m.id}>
              <span className={`radio-dot ${mode === m.id ? 'on' : ''}`} />
              <span>
                <b>{m.title}</b>
                {m.badge && <span className="badge-ok">{m.badge}</span>}
                <span className="d">{m.body}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="card export-card">
          <div className="row" style={{ marginBottom: 8 }}>
            <b style={{ fontSize: 12.5 }}>含めるステム</b>
            <span className="grow" />
            <span className="mono lbl">
              {included.length} / {stems.length}本
            </span>
          </div>
          <div className="inc-grid">
            {stems.map((t) => (
              <label key={t.file} className="row lbl inc">
                <input
                  type="checkbox"
                  checked={include.includes(t.file)}
                  disabled={mode === 'all'}
                  onChange={(e) => setInclude(e.target.checked ? [...include, t.file] : include.filter((f) => f !== t.file))}
                />
                <i className="stem-dot" style={{ background: stemKindInfo(t.kind).color }} />
                <span style={{ color: 'var(--text2)' }}>{t.name}</span>
              </label>
            ))}
          </div>
          <label className="row lbl" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={useTrack} onChange={(e) => setUseTrack(e.target.checked)} />
            トラックの音量とパンをそのまま使う
          </label>
          <label className="row lbl" style={{ marginTop: 4 }}>
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
            音割れしないよう全体を下げる（ピーク −1 dB）
          </label>
        </div>

        <div className="card export-card">
          <div className="kv">
            <span className="lbl">範囲</span>
            <div className="seg full small">
              {(
                [
                  ['song', '曲全体'],
                  ['loop', 'ループ範囲'],
                  ['selection', '選択範囲'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={range === id ? 'on' : ''}
                  disabled={mode === 'bgm' ? id !== 'song' : id === 'loop' ? !loop : id === 'selection' ? selection.length === 0 : false}
                  onClick={() => setRange(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {mode === 'bgm' ? (
            <p className="lbl note">BGMは曲全体を書き出します（譜面と同じ所から鳴らすため）。</p>
          ) : range !== 'song' ? (
            <p className="lbl note">前後を1秒ずつフェードします。</p>
          ) : null}
          <div className="kv">
            <span className="lbl">形式</span>
            <div className="seg full small">
              <button className={format === 'ogg' ? 'on' : ''} onClick={() => setFormat('ogg')}>
                OGG
              </button>
              <button className={format === 'wav' ? 'on' : ''} onClick={() => setFormat('wav')}>
                WAV
              </button>
            </div>
          </div>
          <p className="lbl note">
            {format === 'ogg' ? 'OGG Vorbis 品質6（約192 kbps）· 44.1 kHz。NXで読めて容量が小さい形式です。' : 'WAV 16bit · 44.1 kHz。音質は落ちませんが容量が大きくなります。'}
          </p>
          <div className="kv">
            <span className="lbl">ファイル名</span>
            <input className="field mono" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {mode === 'each' && <p className="lbl note">{'{名前}'} はステムの名前になります（例: stems_ドラム.ogg）。</p>}
          <div className="kv" style={{ alignItems: 'flex-start' }}>
            <span className="lbl" style={{ paddingTop: 4 }}>
              DTXへの登録
            </span>
            <div style={{ flex: 1 }}>
              {mode === 'bgm' && (
                <p className="lbl" style={{ margin: '4px 0 0', lineHeight: 1.6, color: 'var(--text2)' }}>
                  BGMとして登録（#WAV{bgm ? toBase36x2(bgm.wav) : '01'} · ch01）。開始位置はテンポ画面で決めた位置（{bgmAt}）に置きます。
                </p>
              )}
              {mode === 'all' && (
                <label className="row lbl" style={{ marginTop: 4 }}>
                  <input type="checkbox" checked={previewReg} onChange={(e) => setPreviewReg(e.target.checked)} />
                  選曲画面の試聴（#PREVIEW）にする
                </label>
              )}
              {mode === 'selected' && (
                <select className="field" value={selReg} onChange={(e) => setSelReg(e.target.value as typeof selReg)}>
                  <option value="none">登録しない</option>
                  <option value="bgm">BGMとして登録</option>
                  <option value="preview">選曲画面の試聴（#PREVIEW）にする</option>
                </select>
              )}
              {mode === 'each' && (
                <p className="lbl" style={{ margin: '4px 0 0' }}>
                  登録しません。
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="stems-export-foot">
        <div className="lbl" style={{ color: 'var(--text2)', lineHeight: 1.6 }}>
          {summary} · {formatTime(dur, false)} · 約 {((bytes * files) / 1e6).toFixed(1)} MB
          {register === 'bgm' ? ` · BGM（#WAV${bgm ? toBase36x2(bgm.wav) : '01'}）に登録` : register === 'preview' ? ' · #PREVIEW に設定' : ''}
        </div>
        <button className="btn primary big" disabled={!canRun} onClick={() => void run()}>
          {Icon.download(15)} {busy ?? '書き出す'}
        </button>
      </div>
    </aside>
  );
}
