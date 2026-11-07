// テンポ合わせ画面: 原曲の波形の上で「小節の頭」を合わせて、BPMと原曲（BGMチップ）の位置を決める。
import { tr, isJa } from '../i18n';
import { useLang } from '../i18n/useLang';
import { useEffect, useRef } from 'react';
import { combinedOdf } from '../audio/analysis';
import { engine } from '../audio/engine';
import { BGM_DIV, normalizeAnchors, type PlanResult } from '../assist/tempoPlan';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { useAssist } from '../store/assist';
import { bgmSource, wavPath } from '../store/derived';
import { useDevice } from '../store/device';
import { toast, useEditor } from '../store/editor';
import { useCanvas } from './hooks';
import {
  applyTempo,
  bpmText,
  canApplyTempo,
  chooseBgm,
  initTempo,
  leaveTempo,
  measureTime,
  nudgeFirst,
  planBgmSec,
  planResult,
  playAudioSec,
  playPlan,
  putAnchor,
  removeAnchor,
  resetToEstimate,
  setPlanBpm,
  setStart,
  setView,
  shiftAnchors,
  stopPlan,
  tap,
  tempoDiff,
  tempoReflect,
  useTempo,
} from '../store/tempoUi';
import { chipBpmLabel, formatTime } from './format';
import { Icon } from './icons';

const COL = {
  bg: '#0B0E13',
  wave: '#5D7189',
  odf: 'rgba(255,199,104,.28)',
  measure: 'rgba(231,235,241,.5)',
  beat: 'rgba(231,235,241,.14)',
  anchor: '#4CC2FF',
  cand: '#FFB547',
  ghost: '#FF6B72',
  text: '#A3ADBB',
  play: '#FFB547',
};

function fmtSec(t: number): string {
  return `${t.toFixed(3)} s`;
}

export function TempoPage() {
  const doc = useEditor((s) => s.doc);
  const status = useAssist((s) => s.status);
  const progress = useAssist((s) => s.progress);
  const data = useAssist((s) => s.data);
  const srcName = useAssist((s) => s.src?.name);
  const ui = useTempo();
  const tablet = useDevice((s) => s.tablet);
  const r = planResult();
  const bgm = bgmSource(doc);
  const anchors = normalizeAnchors(ui.plan.anchors);
  const first = anchors[0];
  // 案がエディタ（譜面）に入っているか（未反映・反映済み）
  const reflect = tempoReflect();

  useEffect(() => {
    initTempo();
  }, [doc, data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = useTempo.getState().view;
      const len = v.to - v.from;
      if (e.key === ' ') {
        e.preventDefault();
        if (useTempo.getState().playing) stopPlan();
        else playPlan(v.from);
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        tap();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const d = (e.key === 'ArrowRight' ? 1 : -1) * len * (e.shiftKey ? 0.9 : 0.25);
        setView({ from: v.from + d, to: v.to + d });
      } else if (e.key === '+' || e.key === '=' || e.key === '-') {
        e.preventDefault();
        const f = e.key === '-' ? 1.4 : 1 / 1.4;
        const c = (v.from + v.to) / 2;
        setView({ from: c - (len * f) / 2, to: c + (len * f) / 2 });
      } else if (e.key === 'Escape') {
        // 1小節目の頭を選んでいるときは、それをやめるだけ。反映していない案があれば、反映するか聞いてから戻る
        if (useTempo.getState().pickStart) useTempo.setState({ pickStart: false });
        else if (!document.querySelector('.modal-back')) void leaveTempo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stopPlan();
    };
  }, []);

  const wavs = Object.keys(doc.fields)
    .filter((k) => /^WAV[0-9A-Z]{2}$/.test(k))
    .map((k) => parseInt(k.slice(3), 36))
    .sort((a, b) => a - b);
  const duration = data?.duration ?? 0;

  return (
    <div className="tempo-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={() => void leaveTempo()}>
          {Icon.back(14)} {tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        {/* タブレットは題と説明を2段に（縦でもボタンが1行に収まるように） */}
        <div className={tablet ? 'tempo-title' : undefined} style={tablet ? undefined : { display: 'contents' }}>
          <span className="tempo-h1">
            <h1>{tr('テンポと開始位置', 'Tempo & start position')}</h1>
            {reflect === 'pending' && (
              <span className="reflect-chip pending" title={tr('この案は、まだエディタの譜面に入っていません。右上の「エディタに反映」で入ります', 'This plan is not in the editor’s chart yet. Press “Apply to editor” at the top right')}>
                {tr('未反映', 'Not applied')}
              </span>
            )}
          </span>
          <span className="lbl ellipsis" style={{ minWidth: 0 }}>
            {srcName ? `${srcName} · ${formatTime(duration, false)}` : tr('原曲なし', 'No original audio')}
            {status === 'loading' && tr(` · 解析中 ${Math.round(progress * 100)}%`, ` · analyzing ${Math.round(progress * 100)}%`)}
            {status === 'ready' && ui.beats.length > 0 && tr(' · 拍の位置を推定済み', ' · beat positions estimated')}
            {ui.fromEstimate && tr(' · 推定から作った案です', ' · this plan comes from the estimate')}
          </span>
        </div>
        <span className="grow" />
        <button
          className={`btn small ${ui.playing ? 'on-amber' : ''}`}
          onClick={() => (ui.playing ? stopPlan() : playPlan(ui.view.from))}
          disabled={!bgm}
          title={tr('拡大している所からクリック付きで再生（Space）', 'Play with a click from the zoomed area (Space)')}
        >
          {ui.playing ? Icon.stop(14) : Icon.play(14)} {ui.playing ? tr('停止', 'Stop') : tr('確認再生', 'Check playback')}
        </button>
        {!tablet && (
          <button className="btn small" onClick={tap} title={tr('曲に合わせて T キーを4回以上たたく', 'Tap the T key 4 or more times along with the song')}>
            {Icon.tap(14)} {tr('タップでBPMを測る（T）', 'Tap tempo (T)')}
            {ui.tapBpm ? `: ${ui.tapBpm}` : ''}
          </button>
        )}
        <button className="btn small" onClick={resetToEstimate} disabled={!data}>
          {tr('推定をやり直す', 'Re-estimate')}
        </button>
        {/* まとめて入れる画面の右上の端は「エディタに反映」。反映すると「✓ エディタに反映済み」になる（画面はそのまま） */}
        <button
          className={`btn small ${reflect === 'applied' ? 'reflected' : reflect === 'pending' ? 'primary' : ''}`}
          onClick={() => applyTempo()}
          disabled={!canApplyTempo() || reflect === 'applied'}
          title={
            reflect === 'applied'
              ? tr('この案はエディタの譜面に入っています', 'This plan is in the editor’s chart')
              : tr('案の BPM と原曲（BGM）の開始位置を、エディタの譜面に入れます（元に戻すで戻せます）', 'Puts the plan’s BPM and the start of the original (BGM) into the editor’s chart (you can undo it)')
          }
        >
          {reflect === 'applied' ? (
            <>
              {/* 幅が狭い（タブレットの縦）ときは短く */}
              <span className="label-long">{tr('✓ エディタに反映済み', '✓ In the editor')}</span>
              <span className="label-short">{tr('✓ 反映済み', '✓ Applied')}</span>
            </>
          ) : (
            tr('エディタに反映', 'Apply to editor')
          )}
        </button>
      </header>

      {!bgm ? (
        <div className="tempo-empty">
          <div className="card" style={{ maxWidth: 520 }}>
            <div className="section-title" style={{ marginBottom: 8 }}>
              {tr('原曲（BGM）を選んでください', 'Choose the original audio (BGM)')}
            </div>
            <p className="lbl" style={{ lineHeight: 1.7, margin: '0 0 10px' }}>
              {tr(
                'この譜面には原曲を鳴らすチップ（ch01）がありません。WAVリストの中から原曲を選ぶと、波形を解析してBPMと曲の始まりを合わせられます。',
                "This chart has no chip that plays the original (ch01). Choose the original from the WAV list to analyze its waveform and line up the BPM and the start of the song.",
              )}
            </p>
            {wavs.length ? (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {wavs.map((n) => (
                  <button key={n} className="btn small" onClick={() => chooseBgm(n)}>
                    {toBase36x2(n)} {wavPath(doc, n)}
                  </button>
                ))}
              </div>
            ) : (
              <div className="notice info">{tr('WAVが登録されていません。曲フォルダを開くか、左の「WAV」タブで原曲のファイルを登録してください。', 'No WAVs are defined. Open a song folder, or add the original audio file on the "WAV" tab on the left.')}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="tempo-body">
          <main className="tempo-main scroll">
            <section className="tempo-card">
              <div className="row" style={{ marginBottom: 8 }}>
                <h2>{tr('曲全体のテンポマップ', 'Tempo map of the whole song')}</h2>
                <span className="grow" />
                <span className="legend">
                  <i className="dia" style={{ background: COL.anchor }} />
                  {tr('確定アンカー', 'Anchors')}
                </span>
                <span className="legend">
                  <i className="dia" style={{ border: `1.5px solid ${COL.cand}` }} />
                  {tablet ? tr('推定の候補（タップで確定）', 'Suggested (tap to set)') : tr('推定の候補（クリックで確定）', 'Suggested (click to set)')}
                </span>
              </div>
              <Overview r={r} />
            </section>
            <section className="tempo-card">
              <div className="row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
                <h2>
                  {tr('拡大', 'Zoom')} <span className="mono lbl">{zoomLabel(r, ui.view)}</span>
                </h2>
                <span className="grow" />
                <label className="row lbl" style={{ gap: 6 }}>
                  <input type="checkbox" checked={ui.ghostGrid} onChange={(e) => useTempo.setState({ ghostGrid: e.target.checked })} />
                  {tr(`アンカーなしの拍線（BPM ${chipBpmLabel(ui.plan.bpm)} 固定）を重ねる`, `Overlay beat lines without anchors (fixed BPM ${chipBpmLabel(ui.plan.bpm)})`)}
                </label>
              </div>
              <Zoom r={r} />
              <ZoomStats r={r} />
              <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
                {tablet
                  ? tr(
                      '小節線のつまみをドラッグして、その小節の頭を原曲に合わせます（アンカー）。アンカーが2つ以上あると、間のBPMを計算して小節の頭でBPMを変えます。ピンチで拡大、なぞるか2本指で左右に移動。アンカーは長押しで外せます。',
                      'Drag a bar-line knob to line up the start of that measure with the original (an anchor). With 2 or more anchors, the BPM between them is calculated and changed at measure starts. Pinch to zoom; swipe or use two fingers to move sideways. Long-press an anchor to remove it.',
                    )
                  : tr(
                      '小節線をドラッグすると、その小節の頭を原曲に合わせます（アンカー）。アンカーが2つ以上あると、間のBPMを計算して小節の頭でBPMを変えます。右クリックでアンカーを外す。ホイールで拡大、Shift+ホイールか ← → で移動。',
                      'Drag a bar line to line up the start of that measure with the original (an anchor). With 2 or more anchors, the BPM between them is calculated and changed at measure starts. Right-click to remove an anchor. Wheel to zoom; Shift+wheel or ← → to move.',
                    )}
              </p>
            </section>
          </main>
          <aside className="tempo-side scroll">
            <section className="card">
              <div className="section-title" style={{ marginBottom: 8 }}>
                {tr(`開始位置（${first ? toMeasure(first.m) : '001'}小節の頭）`, `Start position (start of measure ${first ? toMeasure(first.m) : '001'})`)}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {[-0.01, -0.001].map((d) => (
                  <button key={d} className="btn small" onClick={() => nudgeFirst(d)} disabled={!first}>
                    {d * 1000}
                  </button>
                ))}
                <span className="mono grow" style={{ textAlign: 'center', fontSize: 22, fontWeight: 700 }}>
                  {first ? fmtSec(first.t) : '—'}
                </span>
                {[0.001, 0.01].map((d) => (
                  <button key={d} className="btn small" onClick={() => nudgeFirst(d)} disabled={!first}>
                    +{d * 1000}
                  </button>
                ))}
              </div>
              {tablet && (
                <div className="lbl" style={{ textAlign: 'center', fontSize: 12, marginTop: -4 }}>
                  {tr('ボタンは ms 単位', 'Buttons move by ms')}
                </div>
              )}
              <div className="tempo-note">
                {r.bgm ? (
                  <>
                    {isJa() ? (
                      <>
                        DTXへの書き出し: BGMチップ（ch01）を <span className="mono">{toMeasure(r.bgm.m)}</span>小節の{' '}
                        <span className="mono">
                          {r.bgm.n}/{BGM_DIV}
                        </span>{' '}
                        に置く
                      </>
                    ) : (
                      <>
                        Saved to DTX: the BGM chip (ch01) goes in measure <span className="mono">{toMeasure(r.bgm.m)}</span> at{' '}
                        <span className="mono">
                          {r.bgm.n}/{BGM_DIV}
                        </span>
                      </>
                    )}
                    <br />
                    <span className="lbl">
                      {tr('誤差', 'Error')} <span className="mono">{r.bgm.errMs.toFixed(1)} ms</span>
                      {first &&
                        first.m > 0 &&
                        tr(
                          ` · ${first.m === 1 ? toMeasure(0) : `${toMeasure(0)}〜${toMeasure(first.m - 1)}`}小節は前奏・空き`,
                          ` · ${first.m === 1 ? `measure ${toMeasure(0)} is` : `measures ${toMeasure(0)}–${toMeasure(first.m - 1)} are`} intro or empty`,
                        )}
                    </span>
                  </>
                ) : first ? (
                  <>
                    <span style={{ color: 'var(--amber)' }}>{tr('原曲の始まりから遠すぎて、BGMチップを置けません。', "It's too far from the start of the original to place the BGM chip.")}</span>
                    <button className="btn small" style={{ marginTop: 6 }} onClick={() => shiftAnchors(r.shift)}>
                      {tr(`小節番号を ${r.shift} 個うしろにする`, `Move measure numbers ${r.shift} later`)}
                    </button>
                  </>
                ) : (
                  tablet
                    ? tr('拡大した波形の上で、1小節目の頭をタップしてください。', 'Tap the start of measure 1 on the zoomed waveform.')
                    : tr('拡大した波形の上で、1小節目の頭をクリックしてください。', 'Click the start of measure 1 on the zoomed waveform.')
                )}
              </div>
              <button className={`btn small ${ui.pickStart ? 'primary' : ''}`} style={{ justifyContent: 'center' }} onClick={() => useTempo.setState({ pickStart: !ui.pickStart })}>
                {tablet
                  ? ui.pickStart
                    ? tr('波形をタップ…（もう一度押すとやめる）', 'Tap the waveform… (press again to cancel)')
                    : tr('波形の1小節目の頭をタップして指定', 'Tap the start of measure 1 on the waveform')
                  : ui.pickStart
                    ? tr('波形をクリック…（Escでやめる）', 'Click the waveform… (Esc to cancel)')
                    : tr('波形上で1小節目の頭をクリックして指定', 'Click the start of measure 1 on the waveform')}
              </button>
            </section>
            <BpmCard />
            {tablet && <TapCard />}
            <section className="card">
              <div className="row" style={{ marginBottom: 8 }}>
                <div className="section-title grow">{tr('変化点とDTXへの書き出し', 'Changes and what is saved to DTX')}</div>
                <span className="scope-tag chart" title={tr('反映すると譜面（DTX）が変わり、ゲームでもこのテンポになります', 'Applying changes the chart (DTX), so the game uses this tempo too')}>
                  {tr('譜面', 'Chart')}
                </span>
              </div>
              <TempoDiffRows r={r} pending={reflect === 'pending'} />
              <div className="map-table">
                {r.segs.map((s, i) => (
                  <div key={s.m} className="map-row">
                    <span className="mono lbl">{toMeasure(s.m)}</span>
                    <span className="mono" style={{ fontWeight: 600, color: i === 0 ? 'var(--text)' : 'var(--amber)' }}>
                      {chipBpmLabel(s.bpm)}
                    </span>
                    <span className="col">
                      <span className="mono">{i === 0 ? `#BPM ${chipBpmLabel(s.bpm)}` : `#BPMzz ${chipBpmLabel(s.bpm)} · #${toMeasure(s.m)}08`}</span>
                      <span className="lbl">
                        {s.src === 'base'
                          ? tr('選んだBPM', 'Chosen BPM')
                          : i === 0
                            ? tr('曲頭（最初のアンカーの区間から計算）', 'Song start (calculated from the first anchor span)')
                            : tr('アンカーから計算', 'Calculated from anchors')}
                      </span>
                    </span>
                  </div>
                ))}
                {r.bgm && (
                  <div className="map-row">
                    <span className="mono lbl">{toMeasure(r.bgm.m)}</span>
                    <span className="mono" style={{ color: 'var(--ok)' }}>
                      BGM
                    </span>
                    <span className="col">
                      <span className="mono">
                        #{toMeasure(r.bgm.m)}01 · {r.bgm.n}/{BGM_DIV}
                      </span>
                      <span className="lbl">{tr('原曲を鳴らし始める位置', 'Where the original starts playing')}</span>
                    </span>
                  </div>
                )}
              </div>
              <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
                {tablet
                  ? tr(
                      '「エディタに反映」で、譜面の BPM と BGM の位置が変わります（BPM変化チップは置き直します。譜面で2本指タップすると戻せます）。アンカーは作業ファイル（.dtxe.json）に残ります。',
                      '“Apply to editor” changes the BPM and the BGM position in the chart (BPM change chips are placed again; a two-finger tap on the chart undoes it). Anchors are kept in the work file (.dtxe.json).',
                    )
                  : tr(
                      '「エディタに反映」で、譜面の BPM と BGM の位置が変わります（BPM変化チップは置き直します。Ctrl+Z で戻せます）。アンカーは作業ファイル（.dtxe.json）に残ります。',
                      '“Apply to editor” changes the BPM and the BGM position in the chart (BPM change chips are placed again; Ctrl+Z undoes it). Anchors are kept in the work file (.dtxe.json).',
                    )}
              </p>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

/** エディタの譜面と案のちがい（左がエディタの譜面、右が案）。この画面で作った案が譜面とちがう所に「未反映」 */
function TempoDiffRows({ r, pending }: { r: PlanResult; pending: boolean }) {
  const doc = useEditor((s) => s.doc);
  const d = tempoDiff(doc, r);
  const mark = (on: boolean) => (on && pending ? <span className="reflect-chip pending">{tr('未反映', 'Not applied')}</span> : <span />);
  const count = (n: number) => (n > 0 ? tr(`${n} か所`, String(n)) : tr('なし', 'None'));
  const arrow = (cur: string, next: string) => (
    <>
      <span className="lbl">{cur}</span> → <b>{next}</b>
    </>
  );
  const sec = (t: number) => tr(`${t.toFixed(3)} 秒`, `${t.toFixed(3)} s`);
  return (
    <div className="tempo-diff" title={tr('左がエディタの譜面、右がこの案です', 'Left: the editor’s chart. Right: this plan')}>
      <span className="lbl">{tr('曲頭の BPM', 'BPM at the start')}</span>
      <span className="mono">{d.bpm.changed ? arrow(bpmText(d.bpm.cur), bpmText(d.bpm.next)) : bpmText(d.bpm.cur)}</span>
      {mark(d.bpm.changed)}
      <span className="lbl">{tr('途中の BPM の変化', 'Later BPM changes')}</span>
      <span className="mono">
        {!d.changes.changed ? (
          count(d.changes.cur)
        ) : d.changes.cur !== d.changes.next ? (
          arrow(count(d.changes.cur), count(d.changes.next))
        ) : (
          <b>{tr(`${count(d.changes.next)}（位置か値が変わる）`, `${count(d.changes.next)} (moved or changed)`)}</b>
        )}
      </span>
      {mark(d.changes.changed)}
      {d.bgm && (
        <>
          <span className="lbl">{tr('原曲の開始位置', 'Start of the original')}</span>
          <span className="mono">{d.bgm.changed && d.bgm.next !== null ? arrow(sec(d.bgm.cur), sec(d.bgm.next)) : sec(d.bgm.cur)}</span>
          {mark(d.bgm.changed)}
        </>
      )}
    </div>
  );
}

function zoomLabel(r: PlanResult, v: { from: number; to: number }): string {
  const off = planBgmSec(r);
  const a = r.tempo.locate(Math.max(0, r.tempo.secToBeat(v.from + off))).m;
  const b = r.tempo.locate(Math.max(0, r.tempo.secToBeat(v.to + off))).m;
  return `${toMeasure(a)}–${toMeasure(b)}`;
}

function BpmCard() {
  const data = useAssist((s) => s.data);
  const plan = useTempo((s) => s.plan);
  const tapBpm = useTempo((s) => s.tapBpm);
  const multi = normalizeAnchors(plan.anchors).length >= 2;
  const cands = data?.tempo ?? [];
  const best = cands[0]?.score || 1;
  const rows: { bpm: number; note: string; conf: string; good: boolean }[] = cands.slice(0, 4).map((c) => ({
    bpm: Math.round(c.bpm * 100) / 100,
    note: c.kind === 'best' ? tr('いちばん合う', 'Best match') : c.kind === 'half' ? tr('半分', 'Half') : c.kind === 'double' ? tr('倍', 'Double') : tr('ほかの候補', 'Other'),
    conf: c.score / best > 0.85 ? tr('高', 'high') : c.score / best > 0.6 ? tr('中', 'medium') : tr('低', 'low'),
    good: c.score / best > 0.85,
  }));
  if (tapBpm) rows.push({ bpm: tapBpm, note: tr('タップで測った値', 'Tapped'), conf: '', good: false });
  return (
    <section className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        {tr('BPMの推定結果', 'BPM estimates')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((c, i) => {
          const on = Math.abs(plan.bpm - c.bpm) < 0.005;
          return (
            <button key={i} className={`cand-row ${on ? 'on' : ''}`} onClick={() => setPlanBpm(c.bpm)}>
              <span className="radio" />
              <span className="mono" style={{ fontSize: 15, fontWeight: 700, width: 70 }}>
                {chipBpmLabel(c.bpm)}
              </span>
              <span className="lbl grow">{c.note}</span>
              <span className="lbl" style={{ color: c.good ? 'var(--ok)' : undefined }}>
                {c.conf && tr(`確からしさ ${c.conf}`, `confidence ${c.conf}`)}
              </span>
            </button>
          );
        })}
        {rows.length === 0 && <div className="lbl">{tr('原曲の解析が終わると候補が出ます。', 'Candidates appear once the original is analyzed.')}</div>}
        <label className="row">
          <span className="lbl">{tr('BPMを入力', 'Enter BPM')}</span>
          <input
            className="field mono"
            style={{ height: 28, width: 100 }}
            type="number"
            step="0.01"
            min={20}
            max={999}
            key={plan.bpm}
            defaultValue={plan.bpm}
            onBlur={(e) => setPlanBpm(Number(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setPlanBpm(Number((e.target as HTMLInputElement).value));
            }}
          />
        </label>
      </div>
      <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
        {tr('倍・半分の取り違えは自動では決めきれないので、確認再生して耳で選んでください。', "Double/half mix-ups can't be settled automatically, so use check playback and choose by ear.")}
        {multi &&
          tr(
            ' アンカーが2つ以上あるときは、アンカーの間から計算したBPMを使います（ここで選んだ値は拍線の重ね表示と推定に使います）。',
            ' With 2 or more anchors, the BPM calculated between anchors is used (the value chosen here is used for the beat-line overlay and suggestions).',
          )}
      </p>
    </section>
  );
}

/** タブレット: 大きな TAP（押した瞬間に数える） */
function TapCard() {
  const tapBpm = useTempo((s) => s.tapBpm);
  const n = useTempo((s) => s.taps.length);
  return (
    <section className="card tap-card">
      <div className="section-title" style={{ alignSelf: 'stretch' }}>
        {tr('タップでBPMを測る', 'Tap tempo')}
      </div>
      <button
        className="tap-big"
        onPointerDown={(e) => {
          e.preventDefault();
          tap();
        }}
        onClick={(e) => {
          // キーボードで押したとき（指・マウスは押した瞬間に数えている）
          if (e.detail === 0) tap();
        }}
        aria-label={tr('タップでBPMを測る', 'Tap tempo')}
      >
        <b>TAP</b>
        <span className="mono">{tapBpm ? chipBpmLabel(tapBpm) : '—'}</span>
        <span className="lbl">{tr(`${n}回`, `${n} taps`)}</span>
      </button>
      <div className="lbl" style={{ textAlign: 'center', fontSize: 12 }}>
        {tr('曲を流しながら拍に合わせて4回以上叩きます', 'Play the song and tap along with the beat 4 or more times')}
      </div>
    </section>
  );
}

// ---- 曲全体 ---------------------------------------------------------------------

const LABEL_W = 64;
const OV = { ruler: 16, bpm: 56, anch: 22, wave: 44, gap: 6 };

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string | null, stroke: string | null) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** 推定の候補: 8小節ごとの小節の頭の近くにある強拍で、案から 10ms 以上ずれているもの */
function candidates(r: PlanResult, downbeats: number[], from: number, to: number, every: number): { m: number; t: number; diff: number }[] {
  if (!downbeats.length) return [];
  const anchors = new Set(useTempo.getState().plan.anchors.map((a) => a.m));
  const out: { m: number; t: number; diff: number }[] = [];
  const off = planBgmSec(r);
  const m0 = Math.max(0, r.tempo.locate(Math.max(0, r.tempo.secToBeat(from + off))).m);
  const m1 = r.tempo.locate(Math.max(0, r.tempo.secToBeat(to + off))).m + 1;
  let j = 0;
  for (let m = m0; m <= m1; m++) {
    if (every > 1 && m % every !== 1) continue;
    if (anchors.has(m)) continue;
    const t = measureTime(m, r);
    const beat = 60 / Math.max(30, r.tempo.bpmAt(r.tempo.measureStart(m)));
    while (j < downbeats.length && downbeats[j] < t - beat * 0.5) j++;
    if (j >= downbeats.length) break;
    const d = downbeats[j];
    if (Math.abs(d - t) <= beat * 0.4 && Math.abs(d - t) > 0.01) out.push({ m, t: d, diff: d - t });
  }
  return out;
}

function Overview({ r }: { r: PlanResult }) {
  const data = useAssist((s) => s.data);
  const ui = useTempo();
  const lang = useLang();
  const dragging = useRef(false);
  const bgmWav = bgmSource(useEditor.getState().doc)?.wav;
  const total = Math.max(data?.duration ?? (bgmWav !== undefined ? engine.duration(bgmWav) : 0), 30);
  const H = OV.ruler + OV.bpm + OV.anch + OV.wave + OV.gap * 3;
  const ref = useCanvas(
    (ctx, w) => {
      const W = w - LABEL_W;
      const X = (t: number) => LABEL_W + (t / total) * W;
      ctx.clearRect(0, 0, w, H);
      ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COL.text;
      ctx.textAlign = 'left';
      const rows = [
        [tr('小節', 'Measure'), 0, OV.ruler],
        ['BPM', OV.ruler + OV.gap, OV.bpm],
        [tr('アンカー', 'Anchors'), OV.ruler + OV.bpm + OV.gap * 2, OV.anch],
        [tr('波形', 'Wave'), OV.ruler + OV.bpm + OV.anch + OV.gap * 3, OV.wave],
      ] as const;
      ctx.font = '11px system-ui, sans-serif';
      for (const [label, y, h] of rows) ctx.fillText(label, 0, y + h / 2);
      ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
      // 小節の目盛り
      const lastM = r.tempo.locate(Math.max(0, r.tempo.secToBeat(total + planBgmSec(r)))).m;
      const step = lastM > 160 ? 32 : lastM > 64 ? 16 : 8;
      for (let m = 0; m <= lastM; m += step) {
        const x = X(measureTime(m, r));
        if (x < LABEL_W) continue;
        ctx.fillStyle = COL.text;
        ctx.fillText(toMeasure(m), x + 2, OV.ruler / 2);
        ctx.fillStyle = '#1C222B';
        ctx.fillRect(x, OV.ruler, 1, H - OV.ruler);
      }
      // BPM
      const by = OV.ruler + OV.gap;
      ctx.fillStyle = COL.bg;
      ctx.fillRect(LABEL_W, by, W, OV.bpm);
      const bpms = r.segs.map((s) => s.bpm);
      const lo = Math.min(...bpms) - 8;
      const hi = Math.max(...bpms) + 8;
      const Y = (b: number) => by + OV.bpm - 6 - ((b - lo) / (hi - lo)) * (OV.bpm - 12);
      ctx.strokeStyle = '#FFC768';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      r.segs.forEach((s, i) => {
        const x0 = Math.max(LABEL_W, X(i === 0 ? 0 : measureTime(s.m, r)));
        const x1 = i + 1 < r.segs.length ? X(measureTime(r.segs[i + 1].m, r)) : LABEL_W + W;
        if (i === 0) ctx.moveTo(x0, Y(s.bpm));
        else ctx.lineTo(x0, Y(s.bpm));
        ctx.lineTo(x1, Y(s.bpm));
      });
      ctx.stroke();
      r.segs.forEach((s, i) => {
        const x = Math.max(LABEL_W + 2, X(i === 0 ? 0 : measureTime(s.m, r)) + 2);
        const label = chipBpmLabel(s.bpm);
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = '#1E1A12';
        ctx.fillRect(x, Y(s.bpm) - 15, tw, 13);
        ctx.fillStyle = '#FFC768';
        ctx.fillText(label, x + 4, Y(s.bpm) - 8);
      });
      // アンカーと候補
      const ay = OV.ruler + OV.bpm + OV.gap * 2 + OV.anch / 2;
      for (const c of candidates(r, ui.downbeats, 0, total, 8)) diamond(ctx, X(c.t), ay, 5, null, COL.cand);
      for (const a of normalizeAnchors(ui.plan.anchors)) diamond(ctx, X(a.t), ay, 6, COL.anchor, null);
      // 波形
      const wy = OV.ruler + OV.bpm + OV.anch + OV.gap * 3;
      ctx.fillStyle = COL.bg;
      ctx.fillRect(LABEL_W, wy, W, OV.wave);
      if (data) {
        ctx.fillStyle = COL.wave;
        const pr = data.peakRate;
        for (let x = 0; x < W; x++) {
          const i0 = Math.floor((x / W) * total * pr);
          const i1 = Math.min(data.peaks.length - 1, Math.floor(((x + 1) / W) * total * pr));
          let m = 0;
          for (let i = i0; i <= i1; i++) if (data.peaks[i] > m) m = data.peaks[i];
          const hh = Math.max(0.5, m * (OV.wave / 2 - 2));
          ctx.fillRect(LABEL_W + x, wy + OV.wave / 2 - hh, 1, hh * 2);
        }
      }
      // 拡大している範囲
      const vx0 = X(ui.view.from);
      const vx1 = X(ui.view.to);
      ctx.fillStyle = 'rgba(76,194,255,.12)';
      ctx.fillRect(vx0, wy, Math.max(3, vx1 - vx0), OV.wave);
      ctx.strokeStyle = COL.anchor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx0 + 0.75, wy + 0.75, Math.max(3, vx1 - vx0) - 1.5, OV.wave - 1.5);
      const p = playAudioSec();
      if (p !== null) {
        ctx.fillStyle = COL.play;
        ctx.fillRect(X(p), OV.ruler, 2, H - OV.ruler);
      }
    },
    [r, ui, data, total, lang],
    ui.playing,
  );

  const seek = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - LABEL_W;
    const W = rect.width - LABEL_W;
    if (x < 0) return;
    const t = (x / W) * total;
    const v = useTempo.getState().view;
    const len = v.to - v.from;
    setView({ from: t - len / 2, to: t + len / 2 });
  };

  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height: H, display: 'block', cursor: 'pointer', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none' }}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const ay = OV.ruler + OV.bpm + OV.gap * 2;
        const touchLike = e.pointerType !== 'mouse';
        if (y >= ay - (touchLike ? 6 : 0) && y < ay + OV.anch + (touchLike ? 6 : 0)) {
          // 候補をクリックで確定（指は広めに）
          const W = rect.width - LABEL_W;
          const x = e.clientX - rect.left;
          const tol = touchLike ? 14 : 7;
          const hit = candidates(r, useTempo.getState().downbeats, 0, total, 8).find((c) => Math.abs(LABEL_W + (c.t / total) * W - x) < tol);
          if (hit) {
            putAnchor(hit.m, hit.t);
            return;
          }
        }
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => dragging.current && seek(e)}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      aria-label={tr('曲全体のテンポマップ', 'Tempo map of the whole song')}
    />
  );
}

// ---- 拡大 -----------------------------------------------------------------------

const ZH_DESK = 220;
const Z_TOP_DESK = 30;
/** タブレット: 背を高くして、上の段に小節線のつまみを並べる */
const ZH_TAB = 300;
const Z_TOP_TAB = 44;
const KY = 20;
const KNOB_R = 13;

type ZDrag =
  | { kind: 'anchor'; m: number; t: number; moved: boolean; x0: number; touch: boolean }
  | { kind: 'pan'; x0: number; from: number; to: number; pick: boolean; moved: boolean }
  | null;

/** 小節線のつまみ（タブレット） */
function knob(ctx: CanvasRenderingContext2D, x: number, label: string, anchor: boolean, active: boolean) {
  if (active) {
    ctx.beginPath();
    ctx.arc(x, KY, KNOB_R + 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(231,235,241,.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, KY, KNOB_R, 0, Math.PI * 2);
  ctx.fillStyle = anchor ? COL.anchor : '#273140';
  ctx.fill();
  ctx.strokeStyle = anchor ? '#A8E1FF' : 'rgba(231,235,241,.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = anchor ? '#06121C' : '#E7EBF1';
  ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, KY + 0.5);
}

function Zoom({ r }: { r: PlanResult }) {
  const lang = useLang();
  const data = useAssist((s) => s.data);
  const ui = useTempo();
  const tablet = useDevice((s) => s.tablet);
  const ZH = tablet ? ZH_TAB : ZH_DESK;
  const Z_TOP = tablet ? Z_TOP_TAB : Z_TOP_DESK;
  const drag = useRef<ZDrag>(null);
  const hover = useRef<{ x: number; m: number | null } | null>(null);
  /** 触れている指（pointerId → x）と2本指の拡大・移動 */
  const pts = useRef(new Map<number, number>());
  const pinch = useRef<{ d0: number; c0: number; from: number; to: number } | null>(null);
  const lpTimer = useRef(0);
  const lastType = useRef('mouse');
  const odfRef = useRef<{ data: unknown; odf: Float32Array } | null>(null);
  if (data && odfRef.current?.data !== data) odfRef.current = { data, odf: combinedOdf(data.odf) };

  const geo = (w: number) => {
    const v = useTempo.getState().view;
    const W = w;
    const X = (t: number) => ((t - v.from) / (v.to - v.from)) * W;
    const T = (x: number) => v.from + (x / W) * (v.to - v.from);
    return { v, W, X, T };
  };

  /** 見えている小節の頭（原曲の秒） */
  const measuresIn = (from: number, to: number) => {
    const off = planBgmSec(r);
    const m0 = Math.max(0, r.tempo.locate(Math.max(0, r.tempo.secToBeat(from + off))).m);
    const m1 = r.tempo.locate(Math.max(0, r.tempo.secToBeat(to + off))).m + 1;
    const out: { m: number; t: number }[] = [];
    for (let m = m0; m <= m1; m++) out.push({ m, t: measureTime(m, r) });
    return out;
  };

  const ref = useCanvas(
    (ctx, w) => {
      const { v, W, X } = geo(w);
      ctx.clearRect(0, 0, w, ZH);
      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, W, ZH);
      const mid = Z_TOP + (ZH - Z_TOP) / 2;
      // 波形と打点の強さ
      if (data) {
        const pr = data.peakRate;
        ctx.fillStyle = COL.wave;
        for (let x = 0; x < W; x++) {
          const t0 = v.from + (x / W) * (v.to - v.from);
          const t1 = v.from + ((x + 1) / W) * (v.to - v.from);
          let i0 = Math.floor(t0 * pr);
          let i1 = Math.ceil(t1 * pr);
          if (i1 < 0 || i0 >= data.peaks.length) continue;
          i0 = Math.max(0, i0);
          i1 = Math.min(data.peaks.length - 1, Math.max(i0, i1));
          let m = 0;
          for (let i = i0; i <= i1; i++) if (data.peaks[i] > m) m = data.peaks[i];
          const hh = Math.max(0.5, m * ((ZH - Z_TOP) / 2 - 6));
          ctx.fillRect(x, mid - hh, 1, hh * 2);
        }
        const odf = odfRef.current!.odf;
        const fr = data.frameRate;
        ctx.fillStyle = COL.odf;
        for (let x = 0; x < W; x++) {
          const t0 = v.from + (x / W) * (v.to - v.from);
          const t1 = v.from + ((x + 1) / W) * (v.to - v.from);
          let i0 = Math.floor(t0 * fr);
          let i1 = Math.ceil(t1 * fr);
          if (i1 < 0 || i0 >= odf.length) continue;
          i0 = Math.max(0, i0);
          i1 = Math.min(odf.length - 1, Math.max(i0, i1));
          let m = 0;
          for (let i = i0; i <= i1; i++) if (odf[i] > m) m = odf[i];
          const hh = Math.min(1, m / 1.6) * 60;
          ctx.fillRect(x, ZH - hh, 1, hh);
        }
      }
      // 推定の拍（下の小さな印）
      ctx.fillStyle = 'rgba(255,181,71,.7)';
      for (const b of ui.beats) {
        if (b < v.from || b > v.to) continue;
        ctx.fillRect(X(b) - 0.5, ZH - 8, 1, 8);
      }
      // アンカーなしの拍線（BPM 固定）
      const anchors = normalizeAnchors(ui.plan.anchors);
      if (ui.ghostGrid && anchors.length) {
        const beat = 60 / ui.plan.bpm;
        const a0 = anchors[0].t;
        ctx.strokeStyle = 'rgba(255,107,114,.65)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        const k0 = Math.ceil((v.from - a0) / beat);
        const k1 = Math.floor((v.to - a0) / beat);
        if (k1 - k0 < 400) {
          for (let k = k0; k <= k1; k++) {
            const x = Math.round(X(a0 + k * beat)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, Z_TOP + (k % 4 === 0 ? 0 : 20));
            ctx.lineTo(x, ZH);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
      }
      // 推定の候補（強拍）。タブレットはつまみの段に置き、つまみを上に重ねる
      if (tablet) {
        for (const c of candidates(r, ui.downbeats, v.from, v.to, 1)) diamond(ctx, X(c.t), KY, 7, null, COL.cand);
      }
      // 案の小節線と拍線
      const ms = measuresIn(v.from, v.to);
      const d = drag.current;
      const active = d?.kind === 'anchor' && d.touch ? d.m : null;
      ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let i = 0; i < ms.length; i++) {
        const { m, t } = ms[i];
        const beats = r.tempo.measureBeats(m);
        const tNext = measureTime(m + 1, r);
        for (let b = 1; b < beats - 1e-9; b++) {
          const x = Math.round(X(t + ((tNext - t) * b) / beats)) + 0.5;
          if (x < 0 || x > W) continue;
          ctx.fillStyle = COL.beat;
          ctx.fillRect(x, Z_TOP + 20, 1, ZH - Z_TOP - 20);
        }
        const x = Math.round(X(t));
        if (x < -20 || x > W + 20) continue;
        const isAnchor = anchors.some((a) => a.m === m);
        const hov = hover.current?.m === m;
        ctx.fillStyle = isAnchor ? COL.anchor : hov ? '#FFFFFF' : COL.measure;
        if (tablet) {
          ctx.fillRect(x - 1, KY, 2, ZH - KY);
          knob(ctx, x, toMeasure(m), isAnchor, active === m);
          ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          continue;
        }
        ctx.fillRect(x - 1, Z_TOP, 2, ZH - Z_TOP);
        ctx.fillStyle = COL.text;
        ctx.fillText(toMeasure(m), x + 4, 10);
        if (isAnchor) {
          diamond(ctx, x, Z_TOP + 2, 7, COL.anchor, null);
        }
      }
      // 推定の候補（強拍）
      if (!tablet) {
        for (const c of candidates(r, ui.downbeats, v.from, v.to, 1)) {
          const x = X(c.t);
          diamond(ctx, x, Z_TOP + 2, 5, null, COL.cand);
        }
      }
      // 区間のBPM
      ctx.textAlign = 'center';
      const by = tablet ? Z_TOP + 10 : 22;
      r.segs.forEach((s, i) => {
        const a = i === 0 ? -Infinity : measureTime(s.m, r);
        const b = i + 1 < r.segs.length ? measureTime(r.segs[i + 1].m, r) : Infinity;
        const xa = Math.max(0, X(a));
        const xb = Math.min(W, X(b));
        if (xb - xa < 60) return;
        const label = `BPM ${chipBpmLabel(s.bpm)}${s.src === 'anchor' ? tr('（アンカーから計算）', ' (from anchors)') : ''}`;
        if (tablet) {
          // 小節線をまたいでも読めるよう下地を敷く
          const tw = ctx.measureText(label).width + 10;
          ctx.fillStyle = 'rgba(11,14,19,.85)';
          ctx.fillRect((xa + xb) / 2 - tw / 2, by - 8, tw, 16);
        }
        ctx.fillStyle = s.src === 'anchor' && r.segs.length > 1 ? '#FFC768' : '#C9D1DC';
        ctx.fillText(label, (xa + xb) / 2, by);
      });
      // 再生位置
      const p = playAudioSec();
      if (p !== null) {
        ctx.fillStyle = COL.play;
        ctx.fillRect(X(p) - 1, 0, 2, ZH);
        if (p > v.to) setView({ from: p - (v.to - v.from) * 0.1, to: p + (v.to - v.from) * 0.9 });
      }
      if (ui.pickStart && hover.current) {
        ctx.fillStyle = COL.anchor;
        ctx.fillRect(hover.current.x - 1, 0, 2, ZH);
      }
    },
    [r, ui, data, lang, tablet],
    ui.playing,
  );

  /** x に近い小節線（tol px 以内） */
  const nearestMeasure = (x: number, w: number, tol: number): number | null => {
    const { v, X } = geo(w);
    let best: number | null = null;
    let bd = tol;
    for (const { m, t } of measuresIn(v.from, v.to)) {
      const d = Math.abs(X(t) - x);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  };
  /** 小節線をつかめる幅: タブレットはつまみの段を広く */
  const tolAt = (y: number) => (tablet ? (y < Z_TOP ? 20 : 12) : 7);

  /** 打点の山に吸いつける（±25ms） */
  const snapTime = (t: number, alt: boolean): number => {
    if (alt || !data || !odfRef.current) return t;
    const odf = odfRef.current.odf;
    const fr = data.frameRate;
    const c = Math.round(t * fr);
    const rad = Math.round(0.025 * fr);
    let bi = -1;
    let bv = 0;
    for (let i = Math.max(1, c - rad); i <= Math.min(odf.length - 2, c + rad); i++) {
      if (odf[i] > bv && odf[i] >= odf[i - 1] && odf[i] >= odf[i + 1]) {
        bv = odf[i];
        bi = i;
      }
    }
    return bi >= 0 && bv > 0.15 ? bi / fr : t;
  };

  const redraw = () => useTempo.setState({});
  const clearLp = () => {
    if (lpTimer.current) window.clearTimeout(lpTimer.current);
    lpTimer.current = 0;
  };
  /** 長押しでアンカーを外す（元に戻せる） */
  const holdToRemove = (m: number, t: number) => {
    clearLp();
    lpTimer.current = window.setTimeout(
      () => {
        lpTimer.current = 0;
        const d = drag.current;
        if (d?.kind !== 'anchor' || d.moved || d.m !== m) return;
        drag.current = null;
        const before = useTempo.getState().plan.anchors.length;
        removeAnchor(m);
        if (useTempo.getState().plan.anchors.length < before) {
          toast(tr(`${toMeasure(m)}小節のアンカーを外しました`, `Removed the anchor at measure ${toMeasure(m)}`), 'info', 5000, {
            label: tr('元に戻す', 'Undo'),
            run: () => putAnchor(m, t),
          });
        } else {
          toast(tr('最後のアンカーは外せません', "The last anchor can't be removed"), 'warn');
          redraw();
        }
      },
      Math.max(550, useDevice.getState().longPressMs + 200),
    );
  };

  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height: ZH, display: 'block', borderRadius: 8, touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
      onWheel={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const { v, T } = geo(rect.width);
        const len = v.to - v.from;
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = ((e.shiftKey ? e.deltaY : e.deltaX) / rect.width) * len;
          setView({ from: v.from + d, to: v.to + d });
          return;
        }
        const at = T(e.clientX - rect.left);
        const f = Math.exp(e.deltaY * 0.0015);
        setView({ from: at - (at - v.from) * f, to: at + (v.to - at) * f });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // 指の長押しは pointer 側で扱う（ここで外すと二重になる）
        if (lastType.current !== 'mouse') return;
        const rect = e.currentTarget.getBoundingClientRect();
        const m = nearestMeasure(e.clientX - rect.left, rect.width, tolAt(e.clientY - rect.top));
        if (m !== null) removeAnchor(m);
      }}
      onPointerDown={(e) => {
        lastType.current = e.pointerType;
        const touchLike = e.pointerType !== 'mouse';
        if (!touchLike && e.button !== 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const { v, T, X } = geo(rect.width);
        e.currentTarget.setPointerCapture(e.pointerId);
        if (touchLike) {
          pts.current.set(e.pointerId, x);
          if (pts.current.size >= 2) {
            // 2本目の指: ピンチで拡大、2本指で左右に移動
            clearLp();
            drag.current = null;
            if (pts.current.size === 2) {
              const [a, b] = [...pts.current.values()];
              pinch.current = { d0: Math.max(10, Math.abs(a - b)), c0: (a + b) / 2, from: v.from, to: v.to };
            }
            redraw();
            return;
          }
        }
        if (useTempo.getState().pickStart) {
          // 指は離したときに決める（2本指の拡大と分ける）
          if (touchLike) drag.current = { kind: 'pan', x0: x, from: v.from, to: v.to, pick: true, moved: false };
          else setStart(snapTime(T(x), e.altKey));
          return;
        }
        // 候補の強拍をクリックで確定
        if (y < Z_TOP + (tablet ? 0 : 14)) {
          const hit = candidates(r, useTempo.getState().downbeats, v.from, v.to, 1).find((c) => Math.abs(X(c.t) - x) < (tablet ? 14 : 7));
          if (hit && !(tablet && nearestMeasure(x, rect.width, KNOB_R) !== null)) {
            putAnchor(hit.m, hit.t);
            return;
          }
        }
        const m = nearestMeasure(x, rect.width, tolAt(y));
        if (m !== null) {
          const t = measureTime(m, r);
          drag.current = { kind: 'anchor', m, t, moved: false, x0: x, touch: touchLike };
          if (touchLike) {
            if (normalizeAnchors(useTempo.getState().plan.anchors).some((a) => a.m === m)) holdToRemove(m, t);
            redraw();
          }
          return;
        }
        drag.current = { kind: 'pan', x0: x, from: v.from, to: v.to, pick: false, moved: false };
      }}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, x);
        const pz = pinch.current;
        if (pz) {
          if (pts.current.size < 2) return;
          const [a, b] = [...pts.current.values()];
          const len0 = pz.to - pz.from;
          const len = (len0 * pz.d0) / Math.max(10, Math.abs(a - b));
          const at = pz.from + (pz.c0 / rect.width) * len0;
          const from = at - ((a + b) / 2 / rect.width) * len;
          setView({ from, to: from + len });
          return;
        }
        const d = drag.current;
        if (!d) {
          if (e.pointerType !== 'mouse') return;
          const m = useTempo.getState().pickStart ? null : nearestMeasure(x, rect.width, tolAt(e.clientY - rect.top));
          hover.current = { x, m };
          e.currentTarget.style.cursor = useTempo.getState().pickStart ? 'crosshair' : m !== null ? 'ew-resize' : 'grab';
          redraw();
          return;
        }
        if (d.kind === 'pan') {
          if (!d.moved && e.pointerType !== 'mouse' && Math.abs(x - d.x0) < 8) return;
          d.moved = true;
          const dt = ((d.x0 - x) / rect.width) * (d.to - d.from);
          setView({ from: d.from + dt, to: d.to + dt });
          return;
        }
        if (!d.moved && Math.abs(x - d.x0) > (d.touch ? 6 : 2)) {
          d.moved = true;
          clearLp();
        }
        if (!d.moved) return;
        const { T } = geo(rect.width);
        // 指はつかんだ所からの動きだけ足す（指の太さで線が跳ねないように）
        const t = d.touch ? d.t + (T(x) - T(d.x0)) : T(x);
        putAnchor(d.m, snapTime(t, e.altKey));
      }}
      onPointerUp={(e) => {
        clearLp();
        pts.current.delete(e.pointerId);
        if (pinch.current) {
          if (pts.current.size < 2) pinch.current = null;
          drag.current = null;
          return;
        }
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const { T } = geo(rect.width);
        if (d.kind === 'pan') {
          if (d.pick && !d.moved) setStart(snapTime(T(d.x0), false));
          return;
        }
        if (!d.moved) {
          // クリックだけなら今の位置でアンカーを確定（指のタップは指の位置へずらさない）
          if (d.touch) putAnchor(d.m, d.t);
          else putAnchor(d.m, snapTime(T(e.clientX - rect.left), e.altKey));
        }
        if (d.touch) redraw();
      }}
      onPointerCancel={(e) => {
        clearLp();
        pts.current.delete(e.pointerId);
        if (pts.current.size < 2) pinch.current = null;
        drag.current = null;
        redraw();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        hover.current = null;
        redraw();
      }}
      aria-label={tr('拡大した原曲の波形と小節線', 'Zoomed waveform of the original with bar lines')}
    />
  );
}

function ZoomStats({ r }: { r: PlanResult }) {
  const ui = useTempo();
  const tablet = useDevice((s) => s.tablet);
  const v = ui.view;
  const anchors = normalizeAnchors(ui.plan.anchors);
  // 案の拍と推定の拍の最大のずれ（見えている範囲）
  let maxDiff: number | null = null;
  if (ui.beats.length) {
    const off = planBgmSec(r);
    const b0 = Math.ceil(r.tempo.secToBeat(Math.max(0, v.from + off)));
    const b1 = Math.floor(r.tempo.secToBeat(Math.max(0, v.to + off)));
    let j = 0;
    for (let b = b0; b <= b1 && b - b0 < 400; b++) {
      const t = r.tempo.beatToSec(b) - off;
      while (j + 1 < ui.beats.length && ui.beats[j + 1] <= t) j++;
      const near = [ui.beats[j], ui.beats[j + 1]].filter((x) => x !== undefined) as number[];
      const d = Math.min(...near.map((x) => Math.abs(x - t)));
      const beatLen = 60 / r.tempo.bpmAt(b);
      if (d < beatLen * 0.3) maxDiff = Math.max(maxDiff ?? 0, d);
    }
  }
  let drift: number | null = null;
  let driftM = 0;
  if (anchors.length) {
    const off = planBgmSec(r);
    const m = r.tempo.locate(Math.max(0, r.tempo.secToBeat(v.to + off))).m;
    const t = measureTime(m, r);
    const beatsFromA0 = r.tempo.measureStart(m) - r.tempo.measureStart(anchors[0].m);
    const ghost = anchors[0].t + (beatsFromA0 * 60) / ui.plan.bpm;
    drift = (ghost - t) * 1000;
    driftM = m;
  }
  return (
    <div className="row lbl" style={{ marginTop: 8, gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
      {maxDiff !== null && (
        <span>
          {tr('推定の拍との最大のずれ', 'Max offset from estimated beats')}{' '}
          <span className="mono" style={{ color: maxDiff < 0.015 ? 'var(--ok)' : 'var(--amber)' }}>
            {Math.round(maxDiff * 1000)} ms
          </span>
        </span>
      )}
      {ui.ghostGrid && drift !== null && Math.abs(drift) >= 5 && (
        <span>
          {tr(`BPM固定だと ${toMeasure(driftM)} の頭で`, `With a fixed BPM, measure ${toMeasure(driftM)} starts`)}{' '}
          <span className="mono" style={{ color: '#FF8A8F' }}>
            {drift > 0 ? '+' : ''}
            {Math.round(drift)} ms
          </span>{' '}
          {tr('ずれる（赤の点線）', 'off (red dotted line)')}
        </span>
      )}
      <span>
        {tr('アンカー', 'Anchors')} <span className="mono">{anchors.length}</span>
        {tr(' 個', '')}
      </span>
      <span className="grow" />
      {!tablet && (
        <span>
          <kbd>Space</kbd> {tr('確認再生', 'check playback')} <kbd>T</kbd> {tr('タップ', 'tap')} <kbd>←</kbd>
          <kbd>→</kbd> {tr('移動', 'move')}
        </span>
      )}
    </div>
  );
}
