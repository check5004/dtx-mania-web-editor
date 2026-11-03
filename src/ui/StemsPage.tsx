// ステムとミックスの画面：トラックを縦に並べた DTM 風の再生、解析元の選択、書き出しと DTX への登録。
import { tr, pl } from '../i18n';
import { useLang } from '../i18n/useLang';
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
import { SeparatePanel } from './SeparatePanel';
import { closeSeparationPanel, useSeparate } from '../store/separate';

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
  const sepOpen = useSeparate((s) => s.panelOpen);
  const sepPhase = useSeparate((s) => s.phase);
  // ステムが無いときは、分解がいちばんの入り口なので出しておく
  const showSep = sepOpen || sepPhase !== 'idle' || stems.length === 0;

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
          {Icon.back(14)} {tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        <h1>{tr('ステムとミックス', 'Stems & mix')}</h1>
        <span className="lbl ellipsis" style={{ minWidth: 0 }}>
          {doc.fields['TITLE'] || tr('無題', 'Untitled')} · {tr(`ステム ${stems.length}本`, `${stems.length} ${pl(stems.length, 'stem')}`)}
          {stems.length ? ` · ${formatTime(stemsDuration(), false)}` : ''}
          {sr ? ` · ${(sr / 1000).toFixed(1)} kHz` : ''}
          {busy ? ` · ${busy}` : ''}
        </span>
        <span className="grow" />
        <span className="lbl hide-narrow">{tr('再生位置・ループはエディタと共通です', 'Playback position and loop are shared with the editor')}</span>
        {!showSep && (
          <button
            className="btn small"
            onClick={() => useSeparate.setState({ panelOpen: true })}
            title={tr('原曲をブラウザの中でドラムとドラム抜き（または楽器ごと）に分ける', 'Split the original into drums and no-drums (or per instrument) inside the browser')}
          >
            {Icon.layers(14)} {tr('原曲から分解', 'Split the original')}
          </button>
        )}
        <button className="btn small" onClick={() => fileInput.current?.click()}>
          {Icon.plus(14)} {tr('ステムを追加', 'Add stems')}
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
          {showSep && <SeparatePanel onClose={stems.length ? closeSeparationPanel : undefined} />}
          <div className="stems-grid">
            <div className="stems-list">
              <div className="stems-list-head" style={{ height: RULER_H }}>
                <b>{tr('トラック', 'Tracks')}</b>
                <span className="grow" />
                <span className="lbl">{tr('M ミュート · S ソロ · ◉ 解析に使う', 'M mute · S solo · ◉ use for analysis')}</span>
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
              <b>{tr('ここにファイルをまとめてドロップしてステムを追加', 'Drop files here to add stems')}</b>
              <span className="lbl" style={{ display: 'block', marginTop: 4 }}>
                {tr(
                  'ステム分離ソフトで作ったファイルを読み込みます（上の「原曲から分解」ならブラウザの中で作れます）。ファイル名の drums・ドラム・Dr・(No Drums)・bass・vocals・弦楽器 などから種類と名前を自動で決め（名前と種類はトラックの ✎ で変えられます）、長さとサンプリングレートの違いを確かめます。ファイルは曲フォルダの stems/ にコピーし、作業ファイル（.dtxe.json）に記録します。NXはこのフォルダを読まないので、遊ぶときの邪魔になりません。分ける前の原曲は、譜面画面の右のパネルの「原曲」から読み込みます（ステムだけでも、ドラムか最初のトラックから波形を作ります）。',
                  'Loads files made with stem separation software ("Split the original" above can make them inside the browser). The type and name are set automatically from words in the file name such as drums, Dr, (No Drums), bass, vocals or strings (change them with ✎ on each track), and differences in length and sample rate are checked. Files are copied to stems/ in the song folder and recorded in the work file (.dtxe.json). NX doesn\'t read this folder, so it won\'t get in the way when you play. Load the unsplit original from "Original" in the right panel of the chart screen (with stems only, the waveform is made from the drums or the first track).',
                )}
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
      <button className="ib" title={tr('曲の頭へ。▶ を曲の頭に置きます', 'To the start. Puts ▶ at the start of the song')} onClick={goToStart}>
        {Icon.toStart()}
      </button>
      <button
        className="play-btn"
        onClick={togglePlay}
        title={
          playing
            ? tr('停止（Space）。次はまた ▶ から再生します（表示は止めた所のまま）', 'Stop (Space). Playback starts from ▶ again next time (the view stays where you stopped)')
            : tr('▶ の位置から再生（Space）。止めると再生位置は ▶ に戻ります', 'Play from ▶ (Space). Stopping returns the playback position to ▶')
        }
        aria-label={playing ? tr('停止', 'Stop') : tr('再生', 'Play')}
      >
        {playing ? Icon.stop(18) : Icon.play(18)}
      </button>
      <button
        className="ib"
        onClick={togglePause}
        title={tr('ここで止める（Shift+Space）。止めた所に ▶ を移すので、次はそこから続けて再生します', 'Stop here (Shift+Space). Moves ▶ to where you stopped, so playback continues from there next time')}
        aria-label={tr('ここで止める', 'Stop here')}
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
            ? tr(
                'ループのオン・オフ（範囲は譜面画面の左端・下の波形・全体図の「A・B」の帯をドラッグして決めます）',
                'Loop on/off (set the range by dragging the A–B strip at the left edge of the chart screen, the waveform below, or the overview)',
              )
            : loopMark
              ? tr(
                  `${loopMark.side === 'a' ? 'A（始まり）' : 'B（終わり）'}だけ決めています。譜面画面で${loopMark.side === 'a' ? ' B（O）' : ' A（I）'}も決めるとループします`,
                  `Only ${loopMark.side === 'a' ? 'A (start)' : 'B (end)'} is set. Set ${loopMark.side === 'a' ? 'B (O)' : 'A (I)'} on the chart screen too to loop`,
                )
              : tr('ループ再生（範囲が無ければ今の小節）', 'Loop playback (the current measure if no range is set)')
        }
      >
        {Icon.loop(14)} {tr('ループ', 'Loop')} {loopLabel && <span className="mono">{loopLabel}</span>}
      </button>
      <div className="vsep" />
      <span className="lbl">{tr('聞こえ方', 'Listen')}</span>
      <div className="seg">
        {LISTEN_PRESETS.map((p) => (
          <button key={p.id} className={listen === p.id ? 'on' : ''} disabled={p.id === 'drums' && !hasDrums} onClick={() => setListen(p.id)} title={stems.length ? p.hint : p.hintNoStems}>
            {p.label}
          </button>
        ))}
      </div>
      <span className="grow" />
      <span className="lbl">{tr('ズーム', 'Zoom')}</span>
      <div className="seg small">
        {(
          [
            ['all', tr('曲全体', 'Whole song')],
            [16, tr('16小節', '16 bars')],
            [4, tr('4小節', '4 bars')],
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
          <b className="ellipsis" style={{ fontSize: 13.5 }} onDoubleClick={openPop} title={tr(`${t.name}（ダブルクリックで名前と種類を変える）`, `${t.name} (double-click to change the name and type)`)}>
            {t.name}
          </b>
          <button
            className={`ib trk-edit ${pop ? 'open' : ''}`}
            onClick={openPop}
            title={tr('名前と種類を変える（名前のダブルクリック・右クリックでも）', 'Change the name and type (or double-click or right-click the name)')}
            aria-label={tr(`${t.name}の名前と種類を変える`, `Change the name and type of ${t.name}`)}
          >
            {Icon.pencil(12)}
          </button>
        </span>
        <button className="ib tiny" onClick={() => setOpen(!open)} title={tr('種類・頭のずれ・削除', 'Type, start offset, remove')} aria-expanded={open}>
          {Icon.gear(13)}
        </button>
        <span className="grow" />
        <button
          className={`radio-btn ${analysis === t.file ? 'on' : ''}`}
          onClick={() => chooseAnalysisStem(analysis === t.file && !eff?.auto ? null : t.file)}
          title={
            analysis === t.file && eff?.auto
              ? tr('原曲のファイルが無いので、このトラックから波形・原曲の打点を作っています（クリックで固定）', 'There is no original file, so the waveform and hits are made from this track (click to pin it)')
              : tr('波形・原曲の打点・BPM推定をこのトラックから作る', 'Make the waveform, hits and BPM estimate from this track')
          }
          aria-label={tr(`${t.name}を解析に使う`, `Use ${t.name} for analysis`)}
          aria-pressed={analysis === t.file}
        />
        <button className={`ms m ${t.mute ? 'on' : ''}`} onClick={() => updateStem(t.file, { mute: !t.mute })} aria-label={tr(`${t.name}をミュート`, `Mute ${t.name}`)}>
          M
        </button>
        <button className={`ms s ${t.solo ? 'on' : ''}`} onClick={(e) => (e.altKey ? soloOnly(t.file) : updateStem(t.file, { solo: !t.solo }))} aria-label={tr(`${t.name}をソロ`, `Solo ${t.name}`)} title={tr('ソロ（Alt+クリックでこのトラックだけ）', 'Solo (Alt+click for this track only)')}>
          S
        </button>
      </div>
      {open ? (
        <div className="track-edit">
          <select className="field" value={t.kind} onChange={(e) => setStemKind(t.file, e.target.value as StemTrack['kind'])} aria-label={tr(`${t.name}の種類`, `Type of ${t.name}`)}>
            {STEM_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <label className="row lbl" style={{ gap: 4 }} title={tr('頭のずれ（ミリ秒）。正なら遅らせます', 'Start offset (milliseconds). Positive delays it')}>
            {tr('ずれ', 'Offset')}
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
            title={tr('このステムを外す（ファイルは消しません）', "Remove this stem (the file isn't deleted)")}
            onClick={async () => {
              if (
                await confirmDialog({
                  title: tr(`${t.name}を外しますか？`, `Remove ${t.name}?`),
                  body: tr('曲フォルダの stems/ のファイルは消さずに残します。', 'The file in stems/ in the song folder is kept.'),
                  ok: tr('外す', 'Remove'),
                  danger: true,
                })
              )
                removeStem(t.file);
            }}
          >
            {Icon.trash(13)}
          </button>
        </div>
      ) : (
        <div className="track-file mono ellipsis" title={t.file}>
          {t.file.replace(/^stems\//, '')}
          {status === 'missing' && <span style={{ color: 'var(--danger)' }}> · {tr('見つかりません', 'not found')}</span>}
          {status === 'error' && <span style={{ color: 'var(--danger)' }}> · {tr('読めません', "can't read")}</span>}
          {status === 'loading' && <span> · {tr('読み込み中…', 'loading…')}</span>}
          {t.offsetMs !== 0 && (
            <span>
              {' '}
              · {tr('ずれ', 'offset')} {t.offsetMs} ms
            </span>
          )}
        </div>
      )}
      <div className="row track-knobs">
        <input type="range" min={0} max={1.5} step={0.01} value={t.gain} style={{ accentColor: info.color }} onChange={(e) => updateStem(t.file, { gain: Number(e.target.value) })} aria-label={tr(`${t.name}の音量`, `Volume of ${t.name}`)} />
        <span className="mono lbl" style={{ width: 52 }}>
          {db(t.gain)}
        </span>
        <span className="lbl">{tr('パン', 'Pan')}</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={t.pan}
          className="pan"
          onChange={(e) => updateStem(t.file, { pan: Number(e.target.value) })}
          onDoubleClick={() => updateStem(t.file, { pan: 0 })}
          aria-label={tr(`${t.name}のパン`, `Pan of ${t.name}`)}
        />
        <span className="mono lbl" style={{ width: 22 }} title={comparePan ? tr('聴き比べ中は左に振ります', 'Panned left while comparing') : undefined}>
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
        <b style={{ fontSize: 13.5, whiteSpace: 'nowrap' }}>{tr('譜面の音', 'Chart sounds')}</b>
        <span className="pill" style={{ height: 18, fontSize: 10 }} title={tr('エディタで置いたチップの音。参考に鳴らすだけで、書き出しには含めません', "Sounds of the chips placed in the editor. They play for reference only and aren't exported")}>
          {tr('参考・書き出さない', 'Reference · not exported')}
        </span>
        <span className="grow" />
        <button
          className={`ms m ${mix.drumMute ? 'on' : ''}`}
          onClick={() => setChartTrack({ mute: !mix.drumMute })}
          aria-label={tr('譜面の音をミュート', 'Mute chart sounds')}
        >
          M
        </button>
        <button
          className={`ms s ${soloChart ? 'on' : ''}`}
          onClick={(e) => (e.altKey ? soloOnly('chart') : setChartTrack({ solo: !soloChart }))}
          aria-label={tr('譜面の音をソロ', 'Solo chart sounds')}
        >
          S
        </button>
      </div>
      <div className="track-file mono ellipsis">
        {meta.fileName} · {toMeasure(tempo.locate(Math.max(0, beat)).m)} / {toMeasure(lastM)}
        {tr(' 小節まで', ' measures')}
      </div>
      <div className="row track-knobs">
        <input type="range" min={0} max={1} step={0.01} value={mix.drums} onChange={(e) => setMix({ drums: Number(e.target.value) })} aria-label={tr('譜面の音の音量', 'Chart sound volume')} />
        <span className="mono lbl" style={{ width: 52 }}>
          {db(mix.drums)}
        </span>
        <span className="lbl">{tr('パン', 'Pan')}</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={mix.drumPan}
          className="pan"
          onChange={(e) => setMix({ drumPan: Number(e.target.value) })}
          onDoubleClick={() => setMix({ drumPan: 0 })}
          aria-label={tr('譜面の音のパン', 'Chart sound pan')}
        />
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
  const lang = useLang();
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
      const key = [doc, W, H, win.from, win.to, version, stems, sections, colors, analysis, dpr, audible, lang];
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
          const note =
            analysis === t.file
              ? tr('解析元: 波形・原曲の打点・BPM推定に使います', 'Analysis source: used for the waveform, hits and BPM estimate')
              : (() => {
                  const inf = stemInfo(t.file);
                  return inf && inf.shortBy > 0.01
                    ? tr(`他より ${inf.shortBy.toFixed(2)} 秒短い → 末尾を無音で埋めてそろえます`, `${inf.shortBy.toFixed(2)} s shorter than the others → the end is padded with silence`)
                    : '';
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
        c.fillText(tr('譜面の密度（エディタで置いたチップ）', 'Chart density (chips placed in the editor)'), 10, top + 13);
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
    [doc, stems, sections, colors, analysis, version, loop, loopMark, playing, beat, win, H, audible, mix, lang],
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
        aria-label={tr('ステムの波形（クリックで再生位置を動かす）', 'Stem waveforms (click to move the playback position)')}
      />
    </div>
  );
}

// ---- 書き出し -------------------------------------------------------------------

const modes = (): { id: ExportMode; title: string; body: string; badge?: string }[] => [
  {
    id: 'bgm',
    title: tr('BGM用（ドラム抜き）', 'For BGM (no drums)'),
    badge: tr('おすすめ', 'Recommended'),
    body: tr('ドラム以外を1本にまとめます。NXでは譜面のドラム音が鳴るので、BGMはドラム抜きが基本です。', 'Mixes everything except the drums into one file. NX plays the chart\'s drum sounds, so BGM usually has no drums.'),
  },
  { id: 'all', title: tr('全部を1本に', 'Everything in one file'), body: tr('原曲と同じ音になります。試聴用（#PREVIEW）や確認に。', 'Sounds the same as the original. For the preview (#PREVIEW) or checking.') },
  { id: 'selected', title: tr('選んだステムを1本に', 'Selected stems in one file'), body: tr('下で選んだステムだけをまとめます。', 'Mixes only the stems you select below.') },
  { id: 'each', title: tr('選んだステムを1本ずつ', 'Each selected stem separately'), body: tr('ステムごとに別のファイルにします。DTXには登録しません。', "Writes a separate file for each stem. They aren't added to the DTX.") },
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
  const bgmM = bgm ? tempoOf(doc).locate(bgm.beat).m : 1;
  const bgmOff = bgm ? (bgm.sec - tempoOf(doc).beatToSec(tempoOf(doc).measureStart(bgmM))).toFixed(3) : '';
  const bgmAt = bgm ? tr(`${toMeasure(bgmM)}小節 +${bgmOff} 秒`, `measure ${toMeasure(bgmM)} +${bgmOff} s`) : tr('001小節', 'measure 001');
  const outName = mode === 'each' ? `${name.replace(/\{(名前|name)\}/g, '…')}.${format}` : name;
  const canRun = !busy && included.length > 0 && !!r && dur > 0.1 && name.trim() !== '';
  const summary =
    mode === 'bgm'
      ? tr(`ドラム以外の ${included.length}本 → ${outName}`, `${included.length} non-drum ${pl(included.length, 'stem')} → ${outName}`)
      : mode === 'all'
        ? tr(`全部の ${included.length}本 → ${outName}`, `All ${included.length} ${pl(included.length, 'stem')} → ${outName}`)
        : mode === 'selected'
          ? tr(`選んだ ${included.length}本 → ${outName}`, `${included.length} selected ${pl(included.length, 'stem')} → ${outName}`)
          : tr(`${included.length}本を別々のファイルに（${outName}）`, `${included.length} ${pl(included.length, 'stem')} as separate files (${outName})`);
  const run = async () => {
    const targets = mode === 'each' ? included.map((t) => `${name.replace(/\{(名前|name)\}/g, t.name)}.${format}`) : [name];
    const exists = targets.filter(fileExists);
    if (exists.length) {
      const ok = await confirmDialog({
        title: tr(`${exists.join('、')} を上書きしますか？`, `Overwrite ${exists.join(', ')}?`),
        body: tr('曲フォルダに同じ名前のファイルがあります。', 'A file with the same name is already in the song folder.'),
        ok: tr('上書き', 'Overwrite'),
        danger: true,
      });
      if (!ok) return;
    }
    await exportStems({ mode, include, useTrackSettings: useTrack, normalize, range: mode === 'bgm' ? 'song' : range, format, fileName: name, register });
  };

  if (stems.length === 0) {
    return (
      <aside className="stems-export scroll">
        <div className="section-title">{tr('書き出し', 'Export')}</div>
        <p className="lbl" style={{ lineHeight: 1.7 }}>
          {tr('ステムを読み込むと、BGM用（ドラム抜き）などを書き出してDTXに登録できます。', 'Once stems are loaded, you can export files such as a no-drums BGM and add them to the DTX.')}
        </p>
      </aside>
    );
  }

  return (
    <aside className="stems-export">
      <div className="scroll stems-export-body">
        <div className="row" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 15 }}>{tr('書き出し', 'Export')}</b>
          <span className="grow" />
          <span className="lbl">{tr('曲フォルダに保存', 'Saved to the song folder')}</span>
        </div>
        <div className="mode-cards">
          {modes().map((m) => (
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
            <b style={{ fontSize: 12.5 }}>{tr('含めるステム', 'Stems to include')}</b>
            <span className="grow" />
            <span className="mono lbl">
              {included.length} / {stems.length}
              {tr('本', '')}
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
            {tr('トラックの音量とパンをそのまま使う', "Use each track's volume and pan")}
          </label>
          <label className="row lbl" style={{ marginTop: 4 }}>
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
            {tr('音割れしないよう全体を下げる（ピーク −1 dB）', 'Lower the overall level to avoid clipping (peak −1 dB)')}
          </label>
        </div>

        <div className="card export-card">
          <div className="kv">
            <span className="lbl">{tr('範囲', 'Range')}</span>
            <div className="seg full small">
              {(
                [
                  ['song', tr('曲全体', 'Whole song')],
                  ['loop', tr('ループ範囲', 'Loop range')],
                  ['selection', tr('選択範囲', 'Selection')],
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
            <p className="lbl note">{tr('BGMは曲全体を書き出します（譜面と同じ所から鳴らすため）。', 'BGM is exported for the whole song (so it plays from the same point as the chart).')}</p>
          ) : range !== 'song' ? (
            <p className="lbl note">{tr('前後を1秒ずつフェードします。', 'Fades 1 second at each end.')}</p>
          ) : null}
          <div className="kv">
            <span className="lbl">{tr('形式', 'Format')}</span>
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
            {format === 'ogg'
              ? tr('OGG Vorbis 品質6（約192 kbps）· 44.1 kHz。NXで読めて容量が小さい形式です。', 'OGG Vorbis quality 6 (about 192 kbps) · 44.1 kHz. NX can read it, and files are small.')
              : tr('WAV 16bit · 44.1 kHz。音質は落ちませんが容量が大きくなります。', "WAV 16-bit · 44.1 kHz. No quality loss, but files are large.")}
          </p>
          <div className="kv">
            <span className="lbl">{tr('ファイル名', 'File name')}</span>
            <input className="field mono" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {mode === 'each' && <p className="lbl note">{tr('{名前} はステムの名前になります（例: stems_ドラム.ogg）。', '{name} becomes the stem name (e.g. stems_Drums.ogg).')}</p>}
          <div className="kv" style={{ alignItems: 'flex-start' }}>
            <span className="lbl" style={{ paddingTop: 4 }}>
              {tr('DTXへの登録', 'Add to DTX')}
            </span>
            <div style={{ flex: 1 }}>
              {mode === 'bgm' && (
                <p className="lbl" style={{ margin: '4px 0 0', lineHeight: 1.6, color: 'var(--text2)' }}>
                  {tr(
                    `BGMとして登録（#WAV${bgm ? toBase36x2(bgm.wav) : '01'} · ch01）。開始位置はテンポ画面で決めた位置（${bgmAt}）に置きます。`,
                    `Added as BGM (#WAV${bgm ? toBase36x2(bgm.wav) : '01'} · ch01). It starts at the position set on the Tempo page (${bgmAt}).`,
                  )}
                </p>
              )}
              {mode === 'all' && (
                <label className="row lbl" style={{ marginTop: 4 }}>
                  <input type="checkbox" checked={previewReg} onChange={(e) => setPreviewReg(e.target.checked)} />
                  {tr('選曲画面の試聴（#PREVIEW）にする', 'Use as the song select preview (#PREVIEW)')}
                </label>
              )}
              {mode === 'selected' && (
                <select className="field" value={selReg} onChange={(e) => setSelReg(e.target.value as typeof selReg)}>
                  <option value="none">{tr('登録しない', "Don't add")}</option>
                  <option value="bgm">{tr('BGMとして登録', 'Add as BGM')}</option>
                  <option value="preview">{tr('選曲画面の試聴（#PREVIEW）にする', 'Use as the song select preview (#PREVIEW)')}</option>
                </select>
              )}
              {mode === 'each' && (
                <p className="lbl" style={{ margin: '4px 0 0' }}>
                  {tr('登録しません。', "Not added to the DTX.")}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="stems-export-foot">
        <div className="lbl" style={{ color: 'var(--text2)', lineHeight: 1.6 }}>
          {summary} · {formatTime(dur, false)} · {tr('約', '~')}
          {((bytes * files) / 1e6).toFixed(1)} MB
          {register === 'bgm'
            ? tr(` · BGM（#WAV${bgm ? toBase36x2(bgm.wav) : '01'}）に登録`, ` · added as BGM (#WAV${bgm ? toBase36x2(bgm.wav) : '01'})`)
            : register === 'preview'
              ? tr(' · #PREVIEW に設定', ' · set as #PREVIEW')
              : ''}
        </div>
        <button className="btn primary big" disabled={!canRun} onClick={() => void run()}>
          {Icon.download(15)} {busy ?? tr('書き出す', 'Export')}
        </button>
      </div>
    </aside>
  );
}
