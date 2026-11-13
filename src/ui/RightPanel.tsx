import { tr, pl, isJa } from '../i18n';
import { iosName, oggUnsupported } from '../platform';
import { sameMeasures } from '../assist/similar';
import type { BgmFilter } from '../audio/engine';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { fracToString } from '../dtx/fraction';
import { CH, chipColor, DRUM_LANES, drumChannel } from '../dtx/model';
import { chipAlt } from '../dtx/rim';
import { applySimilar, clearSimilarPin, setBandFilter, setSpecGain, setSpecMode, setWaveMode, useAssist } from '../store/assist';
import type { SpecMode } from '../audio/spectro';
import { SPEC_ZONES } from './specColors';
import { docStats, tempoOf, wavPath, wavVel } from '../store/derived';
import { useInputSettings } from '../input/settings';
import { setSelectionVel, toggleVelMode, velPresetNames } from '../store/velocity';
import { useState } from 'react';
import { deleteMeasures, deleteSelection, insertMeasures, openPage, setMeasureLength, setKind, setSelectionWav, toast, useEditor } from '../store/editor';
import { judgeCurrent, useAiLevel } from '../store/aiLevel';
import { makeCandidates, openPhrase } from '../store/phrase';
import { openMeasureGen } from '../store/measureGen';
import { AMOUNT, setCompleteSettings, useComplete, type CompleteAmount } from '../store/complete';
import { drumStatusText, setDrumsEnabled, useDrums } from '../store/drums';
import { ADTOF } from '../transcribe/model';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { formatUsd } from '../ai/tasks';
import { chipBpmLabel, chipName, formatLevel, meterLabel, parseMeter } from './format';
import { adoptLevel, gotoIssue, issuesOf, levelOf, setShowIssues, useCheck } from '../store/check';
import { levelToField } from '../check/level';
import { promptDialog } from './dialogs';
import { usePlayBeat } from './hooks';
import { visibleBeats } from './ChartCanvas';
import { Icon } from './icons';
import { useDevice } from '../store/device';
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
      <HelpCard />
    </aside>
  );
}

/** 操作のしかたの中身 */
function HelpBody() {
  return (
    <>
      {isJa() ? (
      <div className="lbl" style={{ lineHeight: 1.9, color: 'var(--text3)' }}>
        <div>クリック … チップを置く</div>
        <div>
          <kbd>Shift</kbd>+クリック … HHオープン／左バスドラム／リム
        </div>
        <div>ダブルクリック … 消す（右ボタンでなぞるとまとめて消す）</div>
        <div>右クリック … メニュー（チップならベロシティ・レーン・削除、何もない所ならグリッド）</div>
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
      ) : (
        <div className="lbl" style={{ lineHeight: 1.9, color: 'var(--text3)' }}>
          <div>Click … place a chip</div>
          <div>
            <kbd>Shift</kbd>+click … HH open / left bass drum / rim
          </div>
          <div>Double-click … delete (drag with the right button to delete several)</div>
          <div>Right-click … menu (on a chip: velocity, lane, delete; on an empty spot: grid)</div>
          <div>Drag on an empty spot … box-select</div>
          <div>
            Drag chips / <kbd>↑</kbd>
            <kbd>↓</kbd>
            <kbd>←</kbd>
            <kbd>→</kbd> … move
          </div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>V</kbd> … copy / paste at the cursor
          </div>
          <div>Click the measure-number column or the waveform … playback start (▶)</div>
          <div>Drag the A·B strip at the left edge … loop range</div>
          <div>
            <kbd>I</kbd> <kbd>O</kbd> … set A / B here (loops once both are set), <kbd>/</kbd> … loop on/off
          </div>
          <div>
            <kbd>Ctrl</kbd>+wheel … zoom, <kbd>[</kbd> <kbd>]</kbd> … grid
          </div>
          <div>
            <kbd>Tab</kbd> … accept the dotted suggestion (Tab completion)
          </div>
        </div>
      )}
    </>
  );
}

const HELP_KEY = 'dtxe.helpCard';

/** 操作のしかた（いつも同じ説明なので、右のパネルのいちばん下に置き、畳める。畳んだかはブラウザに覚える） */
function HelpCard() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(HELP_KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(HELP_KEY, open ? 'closed' : 'open');
    } catch {
      // 覚えられなくても動く
    }
  };
  return (
    <div className="card help-card">
      <button className="help-card-head section-title" onClick={toggle} aria-expanded={open}>
        <span className="grow">{tr('操作のしかた', 'How to edit')}</span>
        <span className="lbl">{open ? tr('畳む', 'Hide') : tr('開く', 'Show')}</span>
      </button>
      {open && <HelpBody />}
    </div>
  );
}

export function SelectionCard() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const ids = new Set(selection);
  const chips = selection.length ? doc.chips.filter((c) => ids.has(c.id)) : [];
  const drums = chips.filter((c) => drumChannel(c.ch));
  const wavs = Object.keys(doc.fields)
    .filter((k) => /^WAV[0-9A-Z]{2}$/.test(k))
    .map((k) => parseInt(k.slice(3), 36))
    .sort((a, b) => a - b);

  // 何も選んでいなければ出さない（操作のしかたはパネルのいちばん下の HelpCard）
  if (chips.length === 0) return null;
  const one = chips.length === 1 ? chips[0] : null;
  const kinds = new Set(drums.map((c) => drumChannel(c.ch)!.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  const vset = new Set(drums.map((c) => c.v));
  const v = vset.size === 1 ? [...vset][0] : null;
  const oneInfo = one ? drumChannel(one.ch) : undefined;
  const color = oneInfo && one ? chipColor(oneInfo.lane, chipAlt(doc, one)) : 'var(--accent)';

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="dot" style={{ background: color, width: 10, height: 10 }} />
        <span style={{ fontWeight: 600 }}>{one ? chipName(doc, one) : tr(`${chips.length} 個のチップ`, `${chips.length} ${pl(chips.length, 'chip')}`)}</span>
        {one && <span className="lbl mono">ch {one.ch.toString(16).toUpperCase().padStart(2, '0')}</span>}
        <span className="grow" />
        <button className="ib" style={{ width: 28, height: 28 }} onClick={deleteSelection} title={tr('削除（Delete）', 'Delete (Delete)')}>
          {Icon.trash(14)}
        </button>
      </div>
      <div className="form-grid">
        {one && (
          <>
            <span className="lbl">{tr('位置', 'Position')}</span>
            <span className="mono">
              {tr('小節', 'Measure')} {toMeasure(one.m)} · {fracToString(one.f)}
            </span>
          </>
        )}
        {drums.length > 0 && (
          <>
            <span className="lbl">WAV</span>
            <select className="field mono" style={{ height: 28, fontSize: 12 }} value={v ?? ''} onChange={(e) => setSelectionWav(Number(e.target.value))}>
              {v === null && <option value="">{tr('（いろいろ）', '(mixed)')}</option>}
              {v !== null && doc.fields['WAV' + toBase36x2(v)] === undefined && (
                <option value={v}>
                  {toBase36x2(v)}
                  {tr('（未定義）', ' (undefined)')}
                </option>
              )}
              {wavs.map((n) => (
                <option key={n} value={n}>
                  {toBase36x2(n)} {wavPath(doc, n)}
                </option>
              ))}
            </select>
            <span className="lbl">{tr('種類', 'Type')}</span>
            <div className="seg">
              {(
                [
                  ['normal', tr('通常', 'Normal')],
                  ['hidden', tr('不可視', 'Invisible')],
                  ['nochip', tr('音だけ', 'Sound only')],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={kind === k ? 'on' : ''}
                  onClick={() => setKind(k)}
                  title={k === 'hidden' ? tr('叩く必要はあるが見えないチップ', 'A chip you still have to hit, but it is not shown') : k === 'nochip' ? tr('空打ちしたときに鳴る音（チップは出ない）', 'Sound played when hitting the pad with no chip (no chip appears)') : ''}
                >
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
      <span className="lbl">{tr('ベロシティ', 'Velocity')}</span>
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
            aria-label={tr('選んだチップのベロシティ', 'Velocity of the selected chips')}
          />
          <button className="ib" style={{ width: 26, height: 26 }} onClick={() => toggleVelMode(true)} title={tr('ベロシティの編集（V）', 'Edit velocity (V)')} aria-label={tr('ベロシティの編集', 'Edit velocity')}>
            {Icon.bars(14)}
          </button>
        </div>
        <div className="seg small" style={{ display: 'flex' }}>
          {velPresetNames().map((name, i) => (
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

export function MeasureCard() {
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
        {tr('小節', 'Measure')} <span className="mono">{toMeasure(m)}</span>
        <span className="lbl">{tr('（カーソル位置）', '(at the cursor)')}</span>
      </div>
      <div className="form-grid">
        <span className="lbl">{tr('拍子', 'Meter')}</span>
        <select
          className="field mono"
          style={{ height: 28 }}
          value={METERS.find(([, v]) => v === cur)?.[0] ?? 'other'}
          onChange={async (e) => {
            if (e.target.value === 'custom') {
              const v = await promptDialog({
                title: tr(`小節 ${toMeasure(m)} の拍子`, `Meter of measure ${toMeasure(m)}`),
                body: tr('「7/8」「13/16」のような拍子か、4/4 を 1 とした長さ（0.875 など）を入れてください。', 'Enter a meter like "7/8" or "13/16", or a length where 4/4 = 1 (e.g. 0.875).'),
                value: meterLabel(cur),
                ok: tr('変える', 'Change'),
              });
              const len = v ? parseMeter(v) : null;
              if (len) apply(len);
              else if (v) toast(tr('拍子として読めませんでした', "Couldn't read that as a meter"), 'error');
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
          <option value="custom">{tr('ほかの拍子…', 'Other meter…')}</option>
        </select>
        <span className="lbl">BPM</span>
        <span className="mono">{chipBpmLabel(tempo.bpmAt(tempo.measureStart(m)))}</span>
      </div>
      <p className="lbl" style={{ margin: '8px 0 0' }}>
        {own !== undefined
          ? tr(`この小節で長さを ${own} に変えています（#${toMeasure(m)}02）。`, `This measure's length is changed to ${own} (#${toMeasure(m)}02).`)
          : tr('拍子を変えると、この小節だけが変わります（次の小節は元に戻します）。', 'Changing the meter affects only this measure (the next measure goes back to the previous meter).')}
      </p>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn small ghost" onClick={() => insertMeasures(m)} title={tr('この小節の前に空の小節を1つ入れます（後ろはずれます）', 'Insert one empty measure before this one (everything after it shifts)')}>
          {Icon.plus(12)} {tr('前に1小節挿入', 'Insert measure before')}
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            const r = deleteMeasures(m);
            toast(tr(`小節 ${toMeasure(m)} を削除しました（チップ ${r.removed} 個）。Ctrl+Z で戻せます`, `Deleted measure ${toMeasure(m)} (${r.removed} ${pl(r.removed, 'chip')}). Ctrl+Z to undo.`), 'ok');
          }}
          title={tr('この小節を消して後ろを詰めます', 'Delete this measure and close the gap')}
        >
          {tr('この小節を削除', 'Delete this measure')}
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <span className="ai-spark">{Icon.sparkle(12)}</span>
        <button
          className="btn small grow"
          onClick={() => openMeasureGen(m)}
          title={tr(
            'この小節のドラムの案を作ります（AI・採譜・写す）。譜面の小節線の左の ✨ や Alt+G と同じ。入れるまで譜面は変わりません',
            "Make drum ideas for this measure (AI, transcription, copy). Same as the ✨ left of the bar line or Alt+G. The chart doesn't change until you insert one",
          )}
        >
          {tr('この小節をAIで生成', 'Generate this measure with AI')}
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <span className="ai-spark" style={{ visibility: 'hidden' }}>{Icon.sparkle(12)}</span>
        <button className="btn small grow" onClick={() => phraseNow('fill')} title={tr('選んだ範囲（なければカーソルの小節）にフィルの候補を3つ点線で出します', 'Show 3 fill suggestions as dotted chips in the selection (or the cursor measure)')}>
          {tr('フィルの候補', 'Fill ideas')}
        </button>
        <button className="btn small grow" onClick={() => phraseNow('rhythm')} title={tr('選んだ範囲（なければカーソルの小節）にリズムの候補を3つ点線で出します', 'Show 3 groove suggestions as dotted chips in the selection (or the cursor measure)')}>
          {tr('リズムの候補', 'Groove ideas')}
        </button>
      </div>
    </div>
  );
}

function phraseNow(kind: 'fill' | 'rhythm') {
  openPhrase();
  void makeCandidates(kind);
}

const bands = (): [BgmFilter, string, string][] => [
  ['all', tr('全体', 'Full'), tr('原曲をそのまま', 'The original as is')],
  ['low', tr('低域', 'Low'), tr('キックが聴きやすい（〜160Hz）', 'Easier to hear the kick (up to 160 Hz)')],
  ['mid', tr('中域', 'Mid'), tr('スネア・タムが聴きやすい（200〜3500Hz）', 'Easier to hear the snare and toms (200–3500 Hz)')],
  ['high', tr('高域', 'High'), tr('ハイハット・シンバルが聴きやすい（5000Hz〜）', 'Easier to hear the hi-hat and cymbals (5000 Hz and up)')],
];

const specModeUi = (): [SpecMode, string, string][] => [
  [
    'drum',
    tr('ドラム強調', 'Drum focus'),
    tr(
      '伸びる音（ベース・声・和音）を引いて、叩いた音だけを光らせます。光った帯の下の端が叩いた瞬間です。',
      'Subtracts sustained sounds (bass, vocals, chords) so only hits light up. The bottom edge of a lit band is the moment of the hit.',
    ),
  ],
  [
    'attack',
    tr('アタック', 'Attack'),
    tr('音の立ち上がりだけを出します。細かい連打や、シンバルが鳴り続ける中の刻みを数えるときに。', 'Shows only note onsets. Useful for counting fast rolls, or steady hits under a ringing cymbal.'),
  ],
  [
    'raw',
    tr('そのまま', 'Raw'),
    tr('音の大きさをそのまま出します。シンバルの伸び（オープン・クラッシュ）の長さを見るときに。', 'Shows loudness as is. Useful for seeing how long cymbals ring (open hi-hat, crash).'),
  ],
];

/** 原曲の列を波形かスペクトルにする。スペクトルの見せ方・明るさ・色の見方 */
function SpecControls() {
  const a = useAssist();
  return (
    <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <div className="row">
        <span className="lbl">{tr('譜面の右の原曲の列', 'Original column right of the chart')}</span>
        <span className="grow" />
        <div className="seg small">
          <button className={a.waveMode === 'wave' ? 'on' : ''} onClick={() => setWaveMode('wave')}>
            {tr('波形', 'Wave')}
          </button>
          <button className={a.waveMode === 'spec' ? 'on' : ''} onClick={() => setWaveMode('spec')} title={tr('ドラムの帯域ごとに色分けしたスペクトル', 'Spectrum colored by drum frequency band')}>
            {tr('スペクトル', 'Spectrum')}
          </button>
        </div>
      </div>
      {a.waveMode === 'spec' && (
        <>
          <div className="seg" style={{ display: 'flex' }}>
            {specModeUi().map(([k, label, tip]) => (
              <button key={k} className={a.specMode === k ? 'on' : ''} style={{ flex: 1 }} title={tip} onClick={() => setSpecMode(k)}>
                {label}
              </button>
            ))}
          </div>
          <span className="lbl">{specModeUi().find(([k]) => k === a.specMode)?.[2]}</span>
          <label className="slider-row" title={tr('スペクトルの明るさ。小さな音を見たいときは上げる', 'Spectrum brightness. Raise it to see quiet sounds')}>
            <span className="lbl">{tr('明るさ', 'Brightness')}</span>
            <input type="range" min={0.5} max={2.5} step={0.1} value={a.specGain} onChange={(e) => setSpecGain(Number(e.target.value))} />
            <span className="mono lbl">{Math.round(a.specGain * 100)}</span>
          </label>
          <div className="row" style={{ flexWrap: 'wrap', gap: '4px 10px' }}>
            {SPEC_ZONES.filter((z) => z.key !== 'mid').map((z) => (
              <span key={z.key} className="row lbl" style={{ gap: 4 }} title={z.tip}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: z.color, flex: 'none' }} />
                {z.key === 'body' ? tr('タム・スネアの胴', 'Tom/snare body') : z.label}
              </span>
            ))}
          </div>
          <span className="lbl">{tr('列の見出しの帯域をクリックすると、原曲をその帯域だけで聴けます。', 'Click a band in the column header to hear only that band of the original.')}</span>
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

export function AssistCard() {
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
        <span style={{ fontWeight: 700 }}>{tr('耳コピアシスト', 'Transcription assist')}</span>
        <span className="grow" />
        <span className="lbl mono">{tr(`${measureRange(vis.from, vis.to, tempo)} を表示中`, `Showing ${measureRange(vis.from, vis.to, tempo)}`)}</span>
      </div>
      {a.status === 'loading' && (
        <div style={{ marginBottom: 10 }}>
          <div className="lbl" style={{ marginBottom: 4 }}>
            {tr(`原曲を解析中… ${Math.round(a.progress * 100)}%（${a.src?.name ?? ''}）`, `Analyzing the original… ${Math.round(a.progress * 100)}% (${a.src?.name ?? ''})`)}
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(a.progress * 100)}%` }} />
          </div>
        </div>
      )}
      {(a.status === 'nosource' || a.status === 'none') && (
        <div className="notice info" style={{ marginBottom: 10 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{Icon.info(14)}</span>
          <span>
            {tr(
              '原曲（BGMチップ ch01）が鳴らせないため、波形と原曲の打点は出ません。曲フォルダを開くか、テンポ合わせ画面で原曲を選んでください。',
              "The original (BGM chip, ch01) can't be played, so the waveform and detected hits aren't shown. Open the song folder, or pick the original on the tempo screen.",
            )}
          </span>
        </div>
      )}
      {a.status === 'error' && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <span style={{ flex: 'none', marginTop: 1 }}>{Icon.warn(14)}</span>
          <span>{tr(`原曲を解析できませんでした: ${a.error}`, `Couldn't analyze the original: ${a.error}`)}</span>
        </div>
      )}
      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {tr('原曲を聴く帯域', 'Listen to a band of the original')}
        </div>
        <div className="seg" style={{ display: 'flex' }}>
          {bands().map(([k, label, tip]) => (
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
            {isJa() ? (
              <>
                小節 <b className="mono">{toMeasure(pin.base)}</b> を直しました。直す前に同じだった小節:
              </>
            ) : (
              <>
                You edited measure <b className="mono">{toMeasure(pin.base)}</b>. Measures that matched it before the edit:
              </>
            )}
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--amber)' }}>
            {pin.targets.map(toMeasure).join(' · ')}
          </span>
          <div className="row">
            <button className="btn small primary" onClick={() => applySimilar()}>
              {tr(`${pin.targets.length} 小節にまとめて反映`, `Apply to all ${pin.targets.length}`)}
            </button>
            <button className="btn small ghost" onClick={clearSimilarPin}>
              {tr('やめる', 'Cancel')}
            </button>
          </div>
        </div>
      ) : same.length > 0 ? (
        <div className="similar-box">
          <span style={{ fontSize: 12 }}>
            {isJa() ? (
              <>
                <b className="mono">{toMeasure(cm)}</b> と同じパターンの小節（{same.length}）
              </>
            ) : (
              <>
                Measures with the same pattern as <b className="mono">{toMeasure(cm)}</b> ({same.length})
              </>
            )}
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
            {same.slice(0, 16).map(toMeasure).join(' · ')}
            {same.length > 16 ? ' …' : ''}
          </span>
          <span className="lbl">{tr('この小節を直すと、ほかの小節にもまとめて反映できます。', 'Edit this measure and you can apply the change to the others in one go.')}</span>
        </div>
      ) : null}
      <label className="row lbl" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={a.audioCols} onChange={(e) => useAssist.setState({ audioCols: e.target.checked })} />
        {tr('譜面の右に原曲の打点と波形（スペクトル）を出す', 'Show detected hits and the waveform (spectrum) of the original right of the chart')}
      </label>
      {a.audioCols && (
        <label className="slider-row" style={{ marginTop: 6, gridTemplateColumns: '68px minmax(0, 1fr) 36px' }} title={tr('上げると弱い音も打点として出します（関係ない音も増えます）', 'Higher values also detect quiet hits (and more unrelated sounds)')}>
          <span className="lbl">{tr('打点の感度', 'Sensitivity')}</span>
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
        title={tr(
          `原曲からドラムの5種（BD・SD・タム・HH・シンバル）の打点を聞き取ります。初回だけモデル（2.2MB）を Hugging Face から、動かす部分（約4MB）をこのサイトから読み込みます。音はこのブラウザの外に出しません。モデル: ${ADTOF.credit}・${ADTOF.license}`,
          `Detects hits of 5 drum classes (BD, SD, toms, HH, cymbals) in the original. The first time, it downloads the model (2.2 MB) from Hugging Face and the runtime (about 4 MB) from this site. The audio never leaves this browser. Model: ${ADTOF.creditEn}, ${ADTOF.license}`,
        )}
      >
        <input type="checkbox" checked={d.enabled} onChange={(e) => setDrumsEnabled(e.target.checked)} />
        {tr('ドラムの採譜モデルで打点を聞き取る', 'Detect hits with the drum transcription model')}
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
          <span>{tr(`${text}。低・中・高の3帯域の打点を出しています。`, `${text}. Showing hits from the 3 bands (low, mid, high) instead.`)}</span>
        </div>
      )}
      {d.enabled && d.status === 'ready' && (
        <div className="lbl" style={{ marginTop: 2, lineHeight: 1.6 }}>
          {tr('原曲の打点を5種で出し、TAB補完の候補選びと照合にも使っています。', 'Shows hits in 5 classes and also uses them to pick and check Tab completion suggestions.')}
        </div>
      )}
    </div>
  );
}

const audioNote = (k: string): string =>
  ({
    ready: tr('原曲の聞こえ方も使って予測しています（2番のサビ＝1番のサビ など）。', 'Also uses how the original sounds to predict (e.g. 2nd chorus = 1st chorus).'),
    loading: tr('原曲の聞こえ方を調べています…', 'Analyzing how the original sounds…'),
    error: tr('原曲の聞こえ方を調べられませんでした。譜面だけで予測します。', "Couldn't analyze the original. Predicting from the chart alone."),
    none: tr('原曲が無いので、譜面だけで予測します。', 'No original audio, so predicting from the chart alone.'),
  })[k] ?? '';

export function CompleteCard() {
  const c = useComplete();
  const drumsReady = useDrums((d) => d.enabled && d.status === 'ready');
  // スマホはキーボードが無いので、キーの案内の代わりに譜面の下の帯の使い方を出す
  const phone = useDevice((d) => d.phone);
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <span style={{ fontWeight: 700 }}>{tr('TAB補完', 'Tab completion')}</span>
        <span className="grow" />
        <label className="row lbl" style={{ gap: 6 }}>
          <input type="checkbox" checked={c.enabled} onChange={(e) => setCompleteSettings({ enabled: e.target.checked })} />
          {tr('使う', 'On')}
        </label>
      </div>
      <p className="lbl" style={{ margin: 0, lineHeight: 1.7 }}>
        {tr(
          'チップを置くと、その先の空いた小節に続きを点線で出します。この曲でもう打った小節を写すので、打つほど当たります。',
          'As you place chips, a continuation appears as dotted chips in the empty measures ahead. It copies measures you already wrote in this song, so it gets better the more you write.',
        )}
      </p>
      {c.enabled && (
        <>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <span className="lbl">{tr('先まで', 'Look ahead')}</span>
            <div className="seg small" style={{ display: 'flex' }}>
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className={c.ahead === n ? 'on' : ''} style={{ flex: 1 }} onClick={() => setCompleteSettings({ ahead: n })}>
                  {tr(`${n}小節`, `${n} ${pl(n, 'bar')}`)}
                </button>
              ))}
            </div>
            <span className="lbl">{tr('出す量', 'Amount')}</span>
            <div className="seg small" style={{ display: 'flex' }}>
              {(Object.keys(AMOUNT) as CompleteAmount[]).map((k) => (
                <button key={k} className={c.amount === k ? 'on' : ''} style={{ flex: 1 }} title={AMOUNT[k].tip} onClick={() => setCompleteSettings({ amount: k })}>
                  {AMOUNT[k].label}
                </button>
              ))}
            </div>
          </div>
          {phone ? (
            <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.7, color: 'var(--text3)' }}>
              {tr(
                '点線が出ると、譜面の下の端に帯が出ます。帯の「入れる」（全部入れる・1小節だけ）で入れ、‹ › で前・次の候補、× で消します。',
                'When dotted chips appear, a strip shows at the bottom of the chart. "Insert" (Insert all, Just one) adds them, ‹ › switches ideas and × dismisses them.',
              )}{' '}
              <span style={{ color: '#FF9F43' }}>{tr('オレンジの枠', 'Orange outline')}</span>
              {tr(' … 原曲でその音が聞こえない所（バスドラム・スネア・タム）', " … that sound isn't heard in the original there (bass drum, snare, toms)")}
            </p>
          ) : isJa() ? (
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
          ) : (
            <div className="lbl" style={{ marginTop: 8, lineHeight: 1.9, color: 'var(--text3)' }}>
              <div>
                <kbd>Tab</kbd> … accept all, <kbd>Shift</kbd>+<kbd>Tab</kbd> … accept one measure
              </div>
              <div>
                <kbd>Alt</kbd>+<kbd>]</kbd> <kbd>[</kbd> … next / previous suggestion (shows one at the cursor if there are none)
              </div>
              <div>
                <kbd>Esc</kbd> … dismiss. <span style={{ color: '#FF9F43' }}>Orange outline</span> … that sound isn't heard in the original there (bass drum, snare, toms)
              </div>
            </div>
          )}
          <p className="lbl" style={{ margin: '6px 0 0' }}>
            {c.audio === 'ready' && drumsReady
              ? tr('原曲の聞こえ方と、採譜したドラム（バスドラム・スネア・タム）との合い方も使って予測しています。', 'Also uses how the original sounds and how well it matches the transcribed drums (bass drum, snare, toms).')
              : audioNote(c.audio)}
          </p>
        </>
      )}
    </div>
  );
}

/** レベルを曲情報の Lv（#DLEVEL）に反映するボタン。もう同じなら「✓ 反映済み」 */
function AdoptLevel({ level, cur }: { level: number; cur: string | undefined }) {
  if (cur === levelToField(level)) {
    return (
      <span className="reflect-chip ok" title={tr('曲情報の Lv（#DLEVEL）は、この値です', 'The Lv in song info (#DLEVEL) is this value')}>
        {tr('✓ 反映済み', '✓ Applied')}
      </span>
    );
  }
  return (
    <button className="link-btn" onClick={() => adoptLevel(level)} title={tr('曲情報の Lv（#DLEVEL）に反映します（Ctrl+Z で戻せます）', 'Sets it as the Lv in song info (#DLEVEL). Ctrl+Z to undo')}>
      {tr('Lv に反映', 'Set as Lv')}
    </button>
  );
}

export function CheckCard() {
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
        {tr('確かめる', 'Checks')}
      </div>
      <div className="check-level">
        <div>
          <div className="lbl">{tr('推定レベル（機械的な目安）', 'Estimated level (computed guide)')}</div>
          <div className="check-lv mono">{lv ? lv.level.toFixed(2) : '—'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="lbl">{tr('曲情報のLv', 'Lv in song info')}</div>
          <div className="mono" style={{ fontSize: 15 }}>
            {formatLevel(cur)}
          </div>
          {lv && <AdoptLevel level={lv.level} cur={cur} />}
        </div>
      </div>
      {lv ? (
        <div className="check-facts lbl">
          {tr(
            `平均 ${lv.avgNps.toFixed(1)} 打/秒 · 最も密な2秒 ${lv.peakNps.toFixed(1)} 打/秒 · 最大同時 ${lv.maxChord} · 速い連打 ${Math.round(lv.fastRatio * 100)}%`,
            `Avg ${lv.avgNps.toFixed(1)} hits/s · densest 2 s ${lv.peakNps.toFixed(1)} hits/s · max chord ${lv.maxChord} · fast runs ${Math.round(lv.fastRatio * 100)}%`,
          )}
        </div>
      ) : (
        <div className="check-facts lbl">{tr('チップが8個以上になると出します。', 'Shown once there are 8 or more chips.')}</div>
      )}
      <AiLevelRow mech={lv?.level ?? null} />
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <b style={{ fontSize: 12.5 }}>{tr('無理な配置', 'Unplayable spots')}</b>
        {issues.length === 0 ? (
          <span className="lbl" style={{ color: 'var(--ok)' }}>
            {tr('見つかりません', 'None found')}
          </span>
        ) : (
          <>
            {errors > 0 && (
              <span className="issue-badge error">
                {tr('叩けない', 'Unplayable')} {errors}
              </span>
            )}
            {warns > 0 && (
              <span className="issue-badge warn">
                {tr('難しい', 'Hard')} {warns}
              </span>
            )}
          </>
        )}
        <span className="grow" />
        <label className="row lbl" style={{ gap: 4 }} title={tr('譜面の左端と、かかわるチップに印を出します', 'Marks them at the left edge of the chart and on the chips involved')}>
          <input type="checkbox" checked={show} onChange={(e) => setShowIssues(e.target.checked)} />
          {tr('譜面に印', 'Mark in chart')}
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
              {open ? tr('閉じる', 'Close') : tr(`ほか ${issues.length - 4} 件を見る`, `Show ${issues.length - 4} more`)}
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
        <b style={{ fontSize: 12.5 }}>{tr('AIのレベル判定', 'AI level rating')}</b>
        <span className="grow" />
        {r && (
          <span className={`ai-conf ${r.confidence}`}>
            {r.confidence === 'high' ? tr('自信度 高', 'High confidence') : r.confidence === 'medium' ? tr('自信度 中', 'Medium confidence') : tr('自信度 低', 'Low confidence')}
          </span>
        )}
        <button
          className="btn small"
          disabled={!hasKey || st.loading || !mech}
          onClick={() => void judgeCurrent()}
          title={hasKey ? tr(`ガイドラインと似た譜面を物差しに判定します（1回 約 ${formatUsd(cost)}）`, `Rates the level against the guidelines and similar charts (about ${formatUsd(cost)} per run)`) : noKeyTitle()}
        >
          {st.loading ? tr('判定中…', 'Rating…') : r ? tr('判定し直す', 'Rate again') : tr('AIで判定', 'Rate with AI')}
        </button>
      </div>
      {!hasKey && (
        <div className="lbl" style={{ marginTop: 4 }}>
          {tr(`${noKeyTitle()}。いまは機械的な推定だけ出しています。`, `${noKeyTitle()}. Only the computed estimate is shown for now.`)}
        </div>
      )}
      {st.error && <div className="ai-err">{st.error}</div>}
      {r && (
        <div style={{ marginTop: 6, opacity: stale ? 0.6 : 1 }}>
          <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
            <span className="check-lv mono" style={{ fontSize: 20 }}>
              {r.level.toFixed(2)}
            </span>
            {mech !== null && <span className="lbl">{tr(`計算 ${mech.toFixed(2)}`, `Computed ${mech.toFixed(2)}`)}</span>}
            <span className="grow" />
            <AdoptLevel level={r.level} cur={doc.fields['DLEVEL']} />
          </div>
          <ul className="ai-reasons">
            {r.reasons.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
            {r.hardest && <li>{tr(`難所: ${r.hardest}`, `Hardest part: ${r.hardest}`)}</li>}
            {r.gap && <li>{tr(`計算との違い: ${r.gap}`, `Vs. computed: ${r.gap}`)}</li>}
          </ul>
          <div className="lbl">
            {stale ? tr('判定のあとに譜面が変わりました · ', 'The chart changed after rating · ') : ''}
            {tr(`似た譜面 ${r.nearCount} 曲で比較`, `Compared with ${r.nearCount} similar ${pl(r.nearCount, 'chart')}`)} · {formatUsd(r.cost)}
            {r.nearCount === 0 && (
              <>
                {' '}
                ·{' '}
                <button className="link-btn" onClick={() => openPage('guideline')}>
                  {tr('手元の曲を集計すると精度が上がります', 'Analyzing your own songs makes it more accurate')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StatsCard() {
  const doc = useEditor((s) => s.doc);
  const st = docStats(doc);
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 8 }}>
        {tr('レーン別のノーツ', 'Notes per lane')}
        <span className="grow" />
        <span className="mono lbl">{tr(`合計 ${st.notes}`, `Total ${st.notes}`)}</span>
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

export function NoticeCard() {
  const meta = useEditor((s) => s.meta);
  const missing = useEditor((s) => s.missingWavs);
  const doc = useEditor((s) => s.doc);
  const folder = useEditor((s) => s.folder);
  const items: { level: 'warn' | 'info'; text: string }[] = [];
  if (meta.encodingNote) items.push({ level: 'warn', text: meta.encodingNote });
  if (meta.hasRandom)
    items.push({
      level: 'info',
      text: tr(
        '#RANDOM/#IF の分岐があります。分岐の中のチップは表示・編集できませんが、保存してもそのまま残ります。',
        "This chart has #RANDOM/#IF branches. Chips inside them can't be shown or edited, but they are kept as is when saving.",
      ),
    });
  if (!folder)
    items.push({
      level: 'info',
      text: tr(
        '曲フォルダを開いていないため、原曲や曲フォルダの音は鳴りません。チップの音は内蔵キットで鳴ります。',
        "No song folder is open, so the original and the folder's sounds won't play. Chips play with the built-in kit.",
      ),
    });
  if (missing.length > 0 && oggUnsupported() && missing.some((n) => /\.ogg$/i.test(wavPath(doc, n) ?? '')))
    items.push({
      level: 'warn',
      text: iosName(
        tr(
          'この Safari は OGG の音を読めません（iPadOS・Safari 18.4 以降で読めます）。新しくするか、Chrome をお使いください。',
          "This version of Safari can't read OGG audio (iPadOS/Safari 18.4 or later can). Update it or use Chrome.",
        ),
      ),
    });
  if (missing.length > 0) {
    const names = missing.slice(0, 6).map((n) => `${toBase36x2(n)} ${wavPath(doc, n) ?? ''}`);
    items.push({
      level: 'warn',
      text: tr(
        `見つからない・読めない音が ${missing.length} 個あります: ${names.join('、')}${missing.length > 6 ? ' …' : ''}（MP3以外の形式やファイル名を確認してください）`,
        `${missing.length} ${pl(missing.length, 'sound')} missing or unreadable: ${names.join(', ')}${missing.length > 6 ? ' …' : ''} (check the file names and formats)`,
      ),
    });
  }
  for (const w of meta.warnings.slice(0, 6)) items.push({ level: 'warn', text: tr(`${w.line}行目: ${w.message}`, `Line ${w.line}: ${w.message}`) });
  if (meta.warnings.length > 6) items.push({ level: 'warn', text: tr(`ほかに ${meta.warnings.length - 6} 件の注意があります`, `${meta.warnings.length - 6} more ${pl(meta.warnings.length - 6, 'warning')}`) });
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
