import { sameMeasures } from '../assist/similar';
import type { BgmFilter } from '../audio/engine';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { fracToString } from '../dtx/fraction';
import { bgaChannel, CH, DRUM_LANES, drumChannel } from '../dtx/model';
import { applySimilar, clearSimilarPin, setBandFilter, setSpecGain, setSpecMode, setWaveMode, useAssist } from '../store/assist';
import type { SpecMode } from '../audio/spectro';
import { SPEC_ZONES } from './specColors';
import { docStats, tempoOf, wavPath, wavVel } from '../store/derived';
import { useInputSettings } from '../input/settings';
import { setSelectionVel, toggleVelMode, VEL_PRESET_NAMES } from '../store/velocity';
import { useState } from 'react';
import { deleteMeasures, deleteSelection, insertMeasures, openPage, setMeasureLength, setKind, setSelectionWav, toast, useEditor } from '../store/editor';
import { judgeCurrent, useAiLevel } from '../store/aiLevel';
import { makeCandidates, openPhrase } from '../store/phrase';
import { AMOUNT, setCompleteSettings, useComplete, type CompleteAmount } from '../store/complete';
import { drumStatusText, setDrumsEnabled, useDrums } from '../store/drums';
import { ADTOF } from '../transcribe/model';
import { NO_KEY_TITLE, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { formatUsd } from '../ai/tasks';
import { chipBpmLabel, formatLevel, meterLabel, parseMeter } from './format';
import { adoptLevel, gotoIssue, issuesOf, levelOf, setShowIssues, useCheck } from '../store/check';
import { promptDialog } from './dialogs';
import { usePlayBeat } from './hooks';
import { visibleBeats } from './ChartCanvas';
import { Icon } from './icons';
import { ReferenceCard } from './ReferenceCard';
import { SourceCard } from './SourceCard';

export function RightPanel() {
  return (
    <aside className="right-panel scroll">
      <SourceCard />
      <ReferenceCard />
      <AssistCard />
      <CompleteCard />
      <SelectionCard />
      <MeasureCard />
      <CheckCard />
      <StatsCard />
      <NoticeCard />
    </aside>
  );
}

function channelName(ch: number): string {
  const d = drumChannel(ch);
  if (d) return d.name;
  if (ch === CH.BGM) return 'BGM';
  if (ch === CH.BPM || ch === CH.BPM_EX) return 'BPM変化';
  if (ch === CH.FILLIN) return 'フィルイン区間';
  if (ch === CH.FILLIN_SOUND) return 'フィルインの音';
  const b = bgaChannel(ch);
  if (b) return b.name;
  return `SE（ch ${ch.toString(16).toUpperCase()}）`;
}

function SelectionCard() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const ids = new Set(selection);
  const chips = selection.length ? doc.chips.filter((c) => ids.has(c.id)) : [];
  const drums = chips.filter((c) => drumChannel(c.ch));
  const wavs = Object.keys(doc.fields)
    .filter((k) => /^WAV[0-9A-Z]{2}$/.test(k))
    .map((k) => parseInt(k.slice(3), 36))
    .sort((a, b) => a - b);

  if (chips.length === 0) {
    return (
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          操作のしかた
        </div>
        <div className="lbl" style={{ lineHeight: 1.9, color: 'var(--text3)' }}>
          <div>クリック … チップを置く</div>
          <div>
            <kbd>Shift</kbd>+クリック … HHオープン／左バスドラム
          </div>
          <div>右クリック（ドラッグ） … 消す</div>
          <div>空いた所をドラッグ … 範囲を選ぶ</div>
          <div>チップをドラッグ／<kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> … 動かす</div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>C</kbd>／<kbd>V</kbd> … コピー／カーソル位置に貼り付け
          </div>
          <div>小節番号の列・波形をクリック … 再生を始める位置（▶）</div>
          <div>左端の A・B の帯をドラッグ … ループの範囲</div>
          <div>
            <kbd>I</kbd> <kbd>O</kbd> … 今の位置を A・B に（両方決めるとループ）、<kbd>/</kbd> … ループのオン・オフ
          </div>
          <div>
            <kbd>Ctrl</kbd>+ホイール … ズーム、<kbd>[</kbd> <kbd>]</kbd> … グリッド
          </div>
          <div>
            <kbd>Tab</kbd> … 点線の続き（TAB補完）を入れる
          </div>
        </div>
      </div>
    );
  }
  const one = chips.length === 1 ? chips[0] : null;
  const kinds = new Set(drums.map((c) => drumChannel(c.ch)!.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  const vset = new Set(drums.map((c) => c.v));
  const v = vset.size === 1 ? [...vset][0] : null;
  const color = one && drumChannel(one.ch) ? DRUM_LANES[drumChannel(one.ch)!.lane].color : 'var(--accent)';

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="dot" style={{ background: color, width: 10, height: 10 }} />
        <span style={{ fontWeight: 600 }}>{one ? channelName(one.ch) : `${chips.length} 個のチップ`}</span>
        {one && <span className="lbl mono">ch {one.ch.toString(16).toUpperCase().padStart(2, '0')}</span>}
        <span className="grow" />
        <button className="ib" style={{ width: 28, height: 28 }} onClick={deleteSelection} title="削除（Delete）">
          {Icon.trash(14)}
        </button>
      </div>
      <div className="form-grid">
        {one && (
          <>
            <span className="lbl">位置</span>
            <span className="mono">
              小節 {toMeasure(one.m)} · {fracToString(one.f)}
            </span>
          </>
        )}
        {drums.length > 0 && (
          <>
            <span className="lbl">WAV</span>
            <select className="field mono" style={{ height: 28, fontSize: 12 }} value={v ?? ''} onChange={(e) => setSelectionWav(Number(e.target.value))}>
              {v === null && <option value="">（いろいろ）</option>}
              {v !== null && doc.fields['WAV' + toBase36x2(v)] === undefined && <option value={v}>{toBase36x2(v)}（未定義）</option>}
              {wavs.map((n) => (
                <option key={n} value={n}>
                  {toBase36x2(n)} {wavPath(doc, n)}
                </option>
              ))}
            </select>
            <span className="lbl">種類</span>
            <div className="seg">
              {(
                [
                  ['normal', '通常'],
                  ['hidden', '不可視'],
                  ['nochip', '音だけ'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} title={k === 'hidden' ? '叩く必要はあるが見えないチップ' : k === 'nochip' ? '空打ちしたときに鳴る音（チップは出ない）' : ''}>
                  {label}
                </button>
              ))}
            </div>
            <VelRow chips={drums} />
          </>
        )}
        {one && (one.ch === CH.BPM || one.ch === CH.BPM_EX) && (
          <>
            <span className="lbl">BPM</span>
            <span className="mono">{chipBpmLabel(tempoOf(doc).bpmAt(tempoOf(doc).beatOf(one.m, one.f)))}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** 選んだチップのベロシティ（スライダーと強・中・弱） */
function VelRow({ chips }: { chips: { v: number }[] }) {
  const doc = useEditor((s) => s.doc);
  const presets = useInputSettings((s) => s.velPresets);
  const vals = chips.map((c) => wavVel(doc, c.v));
  const same = vals.every((x) => x === vals[0]);
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length));
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? avg;
  return (
    <>
      <span className="lbl">ベロシティ</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="vel-row">
          <span className="mono" style={{ fontSize: 12 }}>
            {same || drag !== null ? shown : `~${avg}`}
          </span>
          <input
            type="range"
            min={1}
            max={100}
            value={shown}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={() => {
              if (drag !== null) setSelectionVel(drag);
              setDrag(null);
            }}
            onKeyUp={() => {
              if (drag !== null) setSelectionVel(drag);
              setDrag(null);
            }}
            aria-label="選んだチップのベロシティ"
          />
          <button className="ib" style={{ width: 26, height: 26 }} onClick={() => toggleVelMode(true)} title="ベロシティの編集（V）" aria-label="ベロシティの編集">
            {Icon.bars(14)}
          </button>
        </div>
        <div className="seg small" style={{ display: 'flex' }}>
          {VEL_PRESET_NAMES.map((name, i) => (
            <button key={name} style={{ flex: 1 }} className={same && vals[0] === presets[i] ? 'on' : ''} onClick={() => setSelectionVel(presets[i])}>
              {name} <span className="mono lbl">{presets[i]}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

const METERS: [string, number][] = [
  ['4/4', 1],
  ['3/4', 0.75],
  ['2/4', 0.5],
  ['5/4', 1.25],
  ['6/4', 1.5],
  ['7/8', 0.875],
  ['6/8', 0.75],
  ['5/8', 0.625],
];

function MeasureCard() {
  const doc = useEditor((s) => s.doc);
  const beat = usePlayBeat();
  const tempo = tempoOf(doc);
  const { m } = tempo.locate(Math.max(0, beat));
  const cur = tempo.barLen(m);
  const own = doc.barLengths[m];
  const apply = (len: number) => setMeasureLength(m, len);
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        小節 <span className="mono">{toMeasure(m)}</span>
        <span className="lbl">（カーソル位置）</span>
      </div>
      <div className="form-grid">
        <span className="lbl">拍子</span>
        <select
          className="field mono"
          style={{ height: 28 }}
          value={METERS.find(([, v]) => v === cur)?.[0] ?? 'other'}
          onChange={async (e) => {
            if (e.target.value === 'custom') {
              const v = await promptDialog({
                title: `小節 ${toMeasure(m)} の拍子`,
                body: '「7/8」「13/16」のような拍子か、4/4 を 1 とした長さ（0.875 など）を入れてください。',
                value: meterLabel(cur),
                ok: '変える',
              });
              const len = v ? parseMeter(v) : null;
              if (len) apply(len);
              else if (v) toast('拍子として読めませんでした', 'error');
              return;
            }
            const hit = METERS.find(([k]) => k === e.target.value);
            if (hit) apply(hit[1]);
          }}
        >
          {!METERS.some(([, v]) => v === cur) && <option value="other">{meterLabel(cur)}</option>}
          {METERS.map(([k]) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
          <option value="custom">ほかの拍子…</option>
        </select>
        <span className="lbl">BPM</span>
        <span className="mono">{chipBpmLabel(tempo.bpmAt(tempo.measureStart(m)))}</span>
      </div>
      <p className="lbl" style={{ margin: '8px 0 0' }}>
        {own !== undefined ? `この小節で長さを ${own} に変えています（#${toMeasure(m)}02）。` : '拍子を変えると、この小節だけが変わります（次の小節は元に戻します）。'}
      </p>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn small ghost" onClick={() => insertMeasures(m)} title="この小節の前に空の小節を1つ入れます（後ろはずれます）">
          {Icon.plus(12)} 前に1小節挿入
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            const r = deleteMeasures(m);
            toast(`小節 ${toMeasure(m)} を削除しました（チップ ${r.removed} 個）。Ctrl+Z で戻せます`, 'ok');
          }}
          title="この小節を消して後ろを詰めます"
        >
          この小節を削除
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <span className="ai-spark">{Icon.sparkle(12)}</span>
        <button className="btn small grow" onClick={() => phraseNow('fill')} title="選んだ範囲（なければカーソルの小節）にフィルの候補を3つ点線で出します">
          フィルの候補
        </button>
        <button className="btn small grow" onClick={() => phraseNow('rhythm')} title="選んだ範囲（なければカーソルの小節）にリズムの候補を3つ点線で出します">
          リズムの候補
        </button>
      </div>
    </div>
  );
}

function phraseNow(kind: 'fill' | 'rhythm') {
  openPhrase();
  void makeCandidates(kind);
}

const BANDS: [BgmFilter, string, string][] = [
  ['all', '全体', '原曲をそのまま'],
  ['low', '低域', 'キックが聴きやすい（〜160Hz）'],
  ['mid', '中域', 'スネア・タムが聴きやすい（200〜3500Hz）'],
  ['high', '高域', 'ハイハット・シンバルが聴きやすい（5000Hz〜）'],
];

const SPEC_MODE_UI: [SpecMode, string, string][] = [
  ['drum', 'ドラム強調', '伸びる音（ベース・声・和音）を引いて、叩いた音だけを光らせます。光った帯の下の端が叩いた瞬間です。'],
  ['attack', 'アタック', '音の立ち上がりだけを出します。細かい連打や、シンバルが鳴り続ける中の刻みを数えるときに。'],
  ['raw', 'そのまま', '音の大きさをそのまま出します。シンバルの伸び（オープン・クラッシュ）の長さを見るときに。'],
];

/** 原曲の列を波形かスペクトルにする。スペクトルの見せ方・明るさ・色の見方 */
function SpecControls() {
  const a = useAssist();
  return (
    <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <div className="row">
        <span className="lbl">譜面の右の原曲の列</span>
        <span className="grow" />
        <div className="seg small">
          <button className={a.waveMode === 'wave' ? 'on' : ''} onClick={() => setWaveMode('wave')}>
            波形
          </button>
          <button className={a.waveMode === 'spec' ? 'on' : ''} onClick={() => setWaveMode('spec')} title="ドラムの帯域ごとに色分けしたスペクトル">
            スペクトル
          </button>
        </div>
      </div>
      {a.waveMode === 'spec' && (
        <>
          <div className="seg" style={{ display: 'flex' }}>
            {SPEC_MODE_UI.map(([k, label, tip]) => (
              <button key={k} className={a.specMode === k ? 'on' : ''} style={{ flex: 1 }} title={tip} onClick={() => setSpecMode(k)}>
                {label}
              </button>
            ))}
          </div>
          <span className="lbl">{SPEC_MODE_UI.find(([k]) => k === a.specMode)?.[2]}</span>
          <label className="slider-row" title="スペクトルの明るさ。小さな音を見たいときは上げる">
            <span className="lbl">明るさ</span>
            <input type="range" min={0.5} max={2.5} step={0.1} value={a.specGain} onChange={(e) => setSpecGain(Number(e.target.value))} />
            <span className="mono lbl">{Math.round(a.specGain * 100)}</span>
          </label>
          <div className="row" style={{ flexWrap: 'wrap', gap: '4px 10px' }}>
            {SPEC_ZONES.filter((z) => z.key !== 'mid').map((z) => (
              <span key={z.key} className="row lbl" style={{ gap: 4 }} title={z.tip}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: z.color, flex: 'none' }} />
                {z.key === 'body' ? 'タム・スネアの胴' : z.label}
              </span>
            ))}
          </div>
          <span className="lbl">列の見出しの帯域をクリックすると、原曲をその帯域だけで聴けます。</span>
        </>
      )}
    </div>
  );
}

function measureRange(from: number, to: number, tempo: ReturnType<typeof tempoOf>): string {
  const a = tempo.locate(from).m;
  const b = tempo.locate(Math.max(from, to - 1e-6)).m;
  return a === b ? toMeasure(a) : `${toMeasure(a)}–${toMeasure(b)}`;
}

function AssistCard() {
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.view.scrollBeat);
  useEditor((s) => s.view.pxPerBeat);
  const cursor = useEditor((s) => s.cursorBeat);
  usePlayBeat();
  const a = useAssist();
  const tempo = tempoOf(doc);
  const vis = visibleBeats();
  const cm = tempo.locate(Math.max(0, cursor)).m;
  const same = sameMeasures(doc, cm);
  const pin = a.similarPin;

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <span style={{ fontWeight: 700 }}>耳コピアシスト</span>
        <span className="grow" />
        <span className="lbl mono">{measureRange(vis.from, vis.to, tempo)} を表示中</span>
      </div>
      {a.status === 'loading' && (
        <div style={{ marginBottom: 10 }}>
          <div className="lbl" style={{ marginBottom: 4 }}>
            原曲を解析中… {Math.round(a.progress * 100)}%（{a.src?.name}）
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(a.progress * 100)}%` }} />
          </div>
        </div>
      )}
      {(a.status === 'nosource' || a.status === 'none') && (
        <div className="notice info" style={{ marginBottom: 10 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{Icon.info(14)}</span>
          <span>原曲（BGMチップ ch01）が鳴らせないため、波形と原曲の打点は出ません。曲フォルダを開くか、テンポ合わせ画面で原曲を選んでください。</span>
        </div>
      )}
      {a.status === 'error' && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{Icon.warn(14)}</span>
          <span>原曲を解析できませんでした: {a.error}</span>
        </div>
      )}
      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          原曲を聴く帯域
        </div>
        <div className="seg" style={{ display: 'flex' }}>
          {BANDS.map(([k, label, tip]) => (
            <button key={k} className={a.bandFilter === k ? 'on' : ''} style={{ flex: 1 }} title={tip} onClick={() => setBandFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <SpecControls />
      {pin ? (
        <div className="similar-box pinned">
          <span style={{ fontSize: 12 }}>
            小節 <b className="mono">{toMeasure(pin.base)}</b> を直しました。直す前に同じだった小節:
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--amber)' }}>
            {pin.targets.map(toMeasure).join(' · ')}
          </span>
          <div className="row">
            <button className="btn small primary" onClick={() => applySimilar()}>
              {pin.targets.length} 小節にまとめて反映
            </button>
            <button className="btn small ghost" onClick={clearSimilarPin}>
              やめる
            </button>
          </div>
        </div>
      ) : same.length > 0 ? (
        <div className="similar-box">
          <span style={{ fontSize: 12 }}>
            <b className="mono">{toMeasure(cm)}</b> と同じパターンの小節（{same.length}）
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
            {same.slice(0, 16).map(toMeasure).join(' · ')}
            {same.length > 16 ? ' …' : ''}
          </span>
          <span className="lbl">この小節を直すと、ほかの小節にもまとめて反映できます。</span>
        </div>
      ) : null}
      <label className="row lbl" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={a.audioCols} onChange={(e) => useAssist.setState({ audioCols: e.target.checked })} />
        譜面の右に原曲の打点と波形（スペクトル）を出す
      </label>
      {a.audioCols && (
        <label className="slider-row" style={{ marginTop: 6, gridTemplateColumns: '68px minmax(0, 1fr) 36px' }} title="上げると弱い音も打点として出します（関係ない音も増えます）">
          <span className="lbl">打点の感度</span>
          <input type="range" min={0} max={1} step={0.05} value={a.sensitivity} onChange={(e) => useAssist.setState({ sensitivity: Number(e.target.value) })} />
          <span className="mono lbl">{Math.round(a.sensitivity * 100)}</span>
        </label>
      )}
      <DrumModelRow />
    </div>
  );
}

/** ドラムの採譜モデルを使うか・進み具合 */
function DrumModelRow() {
  const d = useDrums();
  const text = drumStatusText(d);
  return (
    <div style={{ marginTop: 8 }}>
      <label
        className="row lbl"
        title={`原曲からドラムの5種（BD・SD・タム・HH・シンバル）の打点を聞き取ります。初回だけモデル（2.2MB）を Hugging Face から、動かす部分（約4MB）をこのサイトから読み込みます。音はこのブラウザの外に出しません。モデル: ${ADTOF.credit}・${ADTOF.license}`}
      >
        <input type="checkbox" checked={d.enabled} onChange={(e) => setDrumsEnabled(e.target.checked)} />
        ドラムの採譜モデルで打点を聞き取る
      </label>
      {d.enabled && d.status === 'loading' && (
        <div style={{ marginTop: 4 }}>
          <div className="lbl" style={{ marginBottom: 4 }}>
            {text}
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round((d.stage === 'run' ? d.progress : 0) * 100)}%` }} />
          </div>
        </div>
      )}
      {d.enabled && d.status === 'error' && (
        <div className="notice" style={{ marginTop: 6 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{Icon.warn(14)}</span>
          <span>{text}。低・中・高の3帯域の打点を出しています。</span>
        </div>
      )}
      {d.enabled && d.status === 'ready' && <div className="lbl" style={{ marginTop: 2, lineHeight: 1.6 }}>原曲の打点を5種で出し、TAB補完の候補選びと照合にも使っています。</div>}
    </div>
  );
}

const AUDIO_NOTE: Record<string, string> = {
  ready: '原曲の聞こえ方も使って予測しています（2番のサビ＝1番のサビ など）。',
  loading: '原曲の聞こえ方を調べています…',
  error: '原曲の聞こえ方を調べられませんでした。譜面だけで予測します。',
  none: '原曲が無いので、譜面だけで予測します。',
};

function CompleteCard() {
  const c = useComplete();
  const drumsReady = useDrums((d) => d.enabled && d.status === 'ready');
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <span style={{ fontWeight: 700 }}>TAB補完</span>
        <span className="grow" />
        <label className="row lbl" style={{ gap: 6 }}>
          <input type="checkbox" checked={c.enabled} onChange={(e) => setCompleteSettings({ enabled: e.target.checked })} />
          使う
        </label>
      </div>
      <p className="lbl" style={{ margin: 0, lineHeight: 1.7 }}>
        チップを置くと、その先の空いた小節に続きを点線で出します。この曲でもう打った小節を写すので、打つほど当たります。
      </p>
      {c.enabled && (
        <>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <span className="lbl">先まで</span>
            <div className="seg small" style={{ display: 'flex' }}>
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className={c.ahead === n ? 'on' : ''} style={{ flex: 1 }} onClick={() => setCompleteSettings({ ahead: n })}>
                  {n}小節
                </button>
              ))}
            </div>
            <span className="lbl">出す量</span>
            <div className="seg small" style={{ display: 'flex' }}>
              {(Object.keys(AMOUNT) as CompleteAmount[]).map((k) => (
                <button key={k} className={c.amount === k ? 'on' : ''} style={{ flex: 1 }} title={AMOUNT[k].tip} onClick={() => setCompleteSettings({ amount: k })}>
                  {AMOUNT[k].label}
                </button>
              ))}
            </div>
          </div>
          <div className="lbl" style={{ marginTop: 8, lineHeight: 1.9, color: 'var(--text3)' }}>
            <div>
              <kbd>Tab</kbd> … まとめて入れる、<kbd>Shift</kbd>+<kbd>Tab</kbd> … 1小節だけ
            </div>
            <div>
              <kbd>Alt</kbd>+<kbd>]</kbd> <kbd>[</kbd> … 次・前の候補（点線が無いときはカーソルの所に出す）
            </div>
            <div>
              <kbd>Esc</kbd> … 消す。<span style={{ color: '#FF9F43' }}>オレンジの枠</span> … 原曲でその音が聞こえない所（バスドラム・スネア・タム）
            </div>
          </div>
          <p className="lbl" style={{ margin: '6px 0 0' }}>
            {c.audio === 'ready' && drumsReady ? '原曲の聞こえ方と、採譜したドラム（バスドラム・スネア・タム）との合い方も使って予測しています。' : AUDIO_NOTE[c.audio]}
          </p>
        </>
      )}
    </div>
  );
}

function CheckCard() {
  const doc = useEditor((s) => s.doc);
  const show = useCheck((s) => s.showIssues);
  const [open, setOpen] = useState(false);
  const issues = issuesOf(doc);
  const lv = levelOf(doc);
  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.length - errors;
  const cur = doc.fields['DLEVEL'];
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        確かめる
      </div>
      <div className="check-level">
        <div>
          <div className="lbl">推定レベル（機械的な目安）</div>
          <div className="check-lv mono">{lv ? lv.level.toFixed(2) : '—'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="lbl">曲情報のLv</div>
          <div className="mono" style={{ fontSize: 15 }}>
            {formatLevel(cur)}
          </div>
          {lv && (
            <button className="link-btn" onClick={() => adoptLevel(lv.level)} title="#DLEVEL に書きます（Ctrl+Z で戻せます）">
              これにする
            </button>
          )}
        </div>
      </div>
      {lv ? (
        <div className="check-facts lbl">
          平均 {lv.avgNps.toFixed(1)} 打/秒 · 最も密な2秒 {lv.peakNps.toFixed(1)} 打/秒 · 最大同時 {lv.maxChord} · 速い連打 {Math.round(lv.fastRatio * 100)}%
        </div>
      ) : (
        <div className="check-facts lbl">チップが8個以上になると出します。</div>
      )}
      <AiLevelRow mech={lv?.level ?? null} />
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <b style={{ fontSize: 12.5 }}>無理な配置</b>
        {issues.length === 0 ? (
          <span className="lbl" style={{ color: 'var(--ok)' }}>
            見つかりません
          </span>
        ) : (
          <>
            {errors > 0 && <span className="issue-badge error">叩けない {errors}</span>}
            {warns > 0 && <span className="issue-badge warn">難しい {warns}</span>}
          </>
        )}
        <span className="grow" />
        <label className="row lbl" style={{ gap: 4 }} title="譜面の左端と、かかわるチップに印を出します">
          <input type="checkbox" checked={show} onChange={(e) => setShowIssues(e.target.checked)} />
          譜面に印
        </label>
      </div>
      {issues.length > 0 && (
        <>
          <div className="issue-list">
            {(open ? issues : issues.slice(0, 4)).map((is, i) => (
              <button key={i} className={`issue-row ${is.level}`} onClick={() => gotoIssue(is)}>
                <span className="mono">{toMeasure(is.m)}</span>
                <span>{is.message}</span>
              </button>
            ))}
          </div>
          {issues.length > 4 && (
            <button className="link-btn" onClick={() => setOpen(!open)}>
              {open ? '閉じる' : `ほか ${issues.length - 4} 件を見る`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AiLevelRow({ mech }: { mech: number | null }) {
  const doc = useEditor((s) => s.doc);
  const st = useAiLevel();
  const hasKey = useHasAiKey();
  const cost = useAi(() => taskCostEstimate('level'));
  const r = st.result;
  const stale = r && st.doc !== doc;
  return (
    <div className="ai-level">
      <div className="row" style={{ gap: 8 }}>
        <span className="ai-spark">{Icon.sparkle(13)}</span>
        <b style={{ fontSize: 12.5 }}>AIのレベル判定</b>
        <span className="grow" />
        {r && <span className={`ai-conf ${r.confidence}`}>{r.confidence === 'high' ? '自信度 高' : r.confidence === 'medium' ? '自信度 中' : '自信度 低'}</span>}
        <button
          className="btn small"
          disabled={!hasKey || st.loading || !mech}
          onClick={() => void judgeCurrent()}
          title={hasKey ? `ガイドラインと似た譜面を物差しに判定します（1回 約 ${formatUsd(cost)}）` : NO_KEY_TITLE}
        >
          {st.loading ? '判定中…' : r ? '判定し直す' : 'AIで判定'}
        </button>
      </div>
      {!hasKey && (
        <div className="lbl" style={{ marginTop: 4 }}>
          {NO_KEY_TITLE}。いまは機械的な推定だけ出しています。
        </div>
      )}
      {st.error && <div className="ai-err">{st.error}</div>}
      {r && (
        <div style={{ marginTop: 6, opacity: stale ? 0.6 : 1 }}>
          <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
            <span className="check-lv mono" style={{ fontSize: 20 }}>
              {r.level.toFixed(2)}
            </span>
            {mech !== null && <span className="lbl">計算 {mech.toFixed(2)}</span>}
            <span className="grow" />
            <button className="link-btn" onClick={() => adoptLevel(r.level)} title="#DLEVEL に書きます（Ctrl+Z で戻せます）">
              これにする
            </button>
          </div>
          <ul className="ai-reasons">
            {r.reasons.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
            {r.hardest && <li>難所: {r.hardest}</li>}
            {r.gap && <li>計算との違い: {r.gap}</li>}
          </ul>
          <div className="lbl">
            {stale ? '判定のあとに譜面が変わりました · ' : ''}似た譜面 {r.nearCount} 曲で比較 · {formatUsd(r.cost)}
            {r.nearCount === 0 && (
              <>
                {' '}
                · <button className="link-btn" onClick={() => openPage('guideline')}>手元の曲を集計すると精度が上がります</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatsCard() {
  const doc = useEditor((s) => s.doc);
  const st = docStats(doc);
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        レーン別のノーツ
        <span className="grow" />
        <span className="mono lbl">合計 {st.notes}</span>
      </div>
      <div className="stat-grid">
        {DRUM_LANES.map((l, i) => (
          <div key={l.key} className="stat-cell">
            <small style={{ color: l.color }}>{l.key}</small>
            {st.perLane[i]}
          </div>
        ))}
      </div>
    </div>
  );
}

function NoticeCard() {
  const meta = useEditor((s) => s.meta);
  const missing = useEditor((s) => s.missingWavs);
  const doc = useEditor((s) => s.doc);
  const folder = useEditor((s) => s.folder);
  const items: { level: 'warn' | 'info'; text: string }[] = [];
  if (meta.encodingNote) items.push({ level: 'warn', text: meta.encodingNote });
  if (meta.hasRandom) items.push({ level: 'info', text: '#RANDOM/#IF の分岐があります。分岐の中のチップは表示・編集できませんが、保存してもそのまま残ります。' });
  if (!folder) items.push({ level: 'info', text: '曲フォルダを開いていないため、原曲や曲フォルダの音は鳴りません。チップの音は内蔵キットで鳴ります。' });
  if (missing.length > 0) {
    const names = missing.slice(0, 6).map((n) => `${toBase36x2(n)} ${wavPath(doc, n) ?? ''}`);
    items.push({ level: 'warn', text: `見つからない・読めない音が ${missing.length} 個あります: ${names.join('、')}${missing.length > 6 ? ' …' : ''}（MP3以外の形式やファイル名を確認してください）` });
  }
  for (const w of meta.warnings.slice(0, 6)) items.push({ level: 'warn', text: `${w.line}行目: ${w.message}` });
  if (meta.warnings.length > 6) items.push({ level: 'warn', text: `ほかに ${meta.warnings.length - 6} 件の注意があります` });
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it, i) => (
        <div key={i} className={`notice ${it.level === 'info' ? 'info' : ''}`}>
          <span style={{ flex: 'none', marginTop: 1 }}>{it.level === 'info' ? Icon.info(14) : Icon.warn(14)}</span>
          <span>{it.text}</span>
        </div>
      ))}
    </div>
  );
}
