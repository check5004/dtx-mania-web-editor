// 設定画面: 言語、電子ドラム（MIDI）、キーボード、入力の遅れの補正、AI、アプリ（追加・オフライン・更新）。ブラウザに保存する。
import { tr, pl, isJa, LANG_NAMES } from '../i18n';
import { useLang } from '../i18n/useLang';
import { Fragment, useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { DRUM_LANES } from '../dtx/model';
import { enableMidi, startLearn, useMidi } from '../input/midi';
import {
  activeProfile,
  addProfile,
  DEFAULT_KEYS,
  keyLabel,
  noteName,
  removeProfile,
  DEFAULT_LANE_ORDER,
  setKey,
  setLaneOrder,
  setNote,
  updateProfile,
  useInputSettings,
  type LaneTarget,
} from '../input/settings';
import { iosName, IS_IOS, NO_MIDI, useDevice } from '../store/device';
import { goBack, openPage, useEditor } from '../store/editor';
import { velPresetNames } from '../store/velocity';
import { AiSettings } from './AiSettings';
import { AudioCheck } from './AudioCheck';
import { Icon } from './icons';
import { LangSwitch } from './LangSwitch';
import { MidiUnavailableNote, PadSettings, TouchSettings } from './tablet/TouchSettings';
import { padKey } from './tablet/Pads';
import { AppSettings } from './pwa/AppSettings';
import { DriveSettings } from './DriveUi';

type Section = 'lang' | 'touch' | 'pads' | 'midi' | 'keys' | 'lanes' | 'latency' | 'sound' | 'velocity' | 'ai' | 'drive' | 'app';

/** MIDI の割り当て先（名前は今の言語で） */
const targets = (): { t: LaneTarget; key: string; name: string; color: string }[] =>
  DRUM_LANES.flatMap((l, i) => {
    const main = { t: { lane: i, alt: false }, key: l.key, name: l.mainName, color: l.color };
    if (l.alt === undefined || !l.altName) return [main];
    return [main, { t: { lane: i, alt: true }, key: padKey(i, true), name: l.altName, color: l.altColor ?? l.color }];
  });

export function SettingsPage() {
  const tablet = useDevice((s) => s.tablet);
  const phone = useDevice((s) => s.phone);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.capturing')) goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      startLearn(null);
    };
  }, []);
  return phone ? <PhoneSettings /> : <WideSettings tablet={tablet} />;
}

/** PC・タブレット：左に項目、右に中身 */
function WideSettings({ tablet }: { tablet: boolean }) {
  const [sec, setSec] = useState<Section>(() => (useEditor.getState().settingsSection as Section | undefined) ?? (tablet ? 'touch' : 'midi'));
  return (
    <div className="tempo-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={goBack}>
          {Icon.back(14)} {useEditor.getState().returnPage && useEditor.getState().returnPage !== 'chart' ? tr('戻る', 'Back') : tr('エディタに戻る', 'Back to editor')}
        </button>
        <div className="vsep" />
        <h1>{tr('設定', 'Settings')}</h1>
        <span className="lbl">{tr('このブラウザに保存します', 'Saved in this browser')}</span>
      </header>
      <div className="settings-body">
        <nav className="settings-nav">
          {navItems(tablet).map(([k, label]) => (
            <Fragment key={k}>
              <button className={sec === k ? 'on' : ''} onClick={() => setSec(k)}>
                {label}
                {k === 'midi' && NO_MIDI && <span className="set-nav-warn">{Icon.info(16)}</span>}
              </button>
              {/* AI の下に付ける（難易度生成のレベルの基準） */}
              {k === 'ai' && (
                <button className="sub" onClick={() => openPage('guideline')} title={tr('手元の曲から作る、レベルの基準', 'Level guidelines built from your local songs')}>
                  {tr('難易度ガイドライン', 'Difficulty guidelines')}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
        <main className="settings-main scroll">
          <SectionBody sec={sec} />
        </main>
      </div>
    </div>
  );
}

function SectionBody({ sec }: { sec: Section }) {
  return (
    <>
      {sec === 'lang' && <LanguageSettings />}
      {sec === 'touch' && <TouchSettings />}
      {sec === 'pads' && <PadSettings />}
      {sec === 'midi' && <MidiSettings />}
      {sec === 'keys' && <KeySettings />}
      {sec === 'lanes' && <LaneOrderSettings />}
      {sec === 'latency' && <LatencySettings />}
      {sec === 'sound' && <AudioCheck />}
      {sec === 'velocity' && <VelocitySettings />}
      {sec === 'ai' && <AiSettings />}
      {sec === 'drive' && <DriveSettings />}
      {sec === 'app' && <AppSettings />}
    </>
  );
}

/** スマホ：項目の一覧から 1 つずつ開く（承認されたデザインの設定のとおり）。電子ドラムは MIDI が無いブラウザでは押せない */
function PhoneSettings() {
  const [sec, setSec] = useState<Section | null>(() => (useEditor.getState().settingsSection as Section | undefined) ?? null);
  const lang = useLang();
  const place = useDevice((s) => s.placeMode);
  const names = new Map(navItems(true));
  const row = (k: Section, value = '', sub = '') => {
    const off = k === 'midi' && NO_MIDI;
    return (
      <button key={k} className={`ps-row ${off ? 'off' : ''}`} onClick={() => setSec(k)} disabled={off}>
        <span className="ps-row-text">
          <span className="ellipsis">{names.get(k)}</span>
          {sub && <span className="lbl ellipsis">{sub}</span>}
        </span>
        {value && <span className="lbl ps-row-val ellipsis">{value}</span>}
        {!off && <span className="ps-chev">{Icon.chevronRight(18)}</span>}
      </button>
    );
  };
  if (sec) {
    return (
      <div className="tempo-page ps-page">
        <header className="ps-head">
          <button className="p-btn sm" onClick={() => setSec(null)}>
            {Icon.back(16)}
            <span>{tr('設定', 'Settings')}</span>
          </button>
          <b className="ellipsis">{names.get(sec)}</b>
        </header>
        <main className="settings-main scroll ps-main">
          <SectionBody sec={sec} />
        </main>
      </div>
    );
  }
  return (
    <div className="tempo-page ps-page">
      <header className="ps-head">
        <button className="p-btn sm" onClick={goBack}>
          {Icon.back(16)}
          <span>{useEditor.getState().returnPage && useEditor.getState().returnPage !== 'chart' ? tr('戻る', 'Back') : tr('エディタ', 'Editor')}</span>
        </button>
        <span className="ps-title">
          <b>{tr('設定', 'Settings')}</b>
          <span className="lbl ellipsis">{tr('このブラウザに保存します', 'Saved in this browser')}</span>
        </span>
      </header>
      <main className="scroll ps-list">
        <div className="ps-group">
          {row('lang', LANG_NAMES[lang])}
          {row('touch', place === 'instant' ? tr('すぐ置く', 'Instant') : tr('吹き出し', 'Bubble'))}
          {row('pads')}
          {row('keys')}
          {row('midi', '', NO_MIDI ? (IS_IOS ? iosName(tr('iPad のブラウザは MIDI をつなげません', 'iPad browsers cannot use MIDI')) : tr('このブラウザは MIDI をつなげません', 'This browser cannot use MIDI')) : '')}
          {row('lanes')}
        </div>
        <div className="ps-group">
          {row('latency')}
          {row('sound')}
          {row('velocity')}
        </div>
        <div className="ps-group">
          {row('ai')}
          <button className="ps-row" onClick={() => openPage('guideline')}>
            <span className="ps-row-text">
              <span className="ellipsis">{tr('難易度ガイドライン', 'Difficulty guidelines')}</span>
            </span>
            <span className="lbl ps-row-val ellipsis">{tr('横向きで開く', 'Landscape')}</span>
            <span className="ps-chev">{Icon.chevronRight(18)}</span>
          </button>
          {row('drive')}
          {row('app')}
        </div>
        {NO_MIDI && <p className="lbl ps-note">{tr('電子ドラムをつなぐ・曲フォルダを開くは PC の Chrome・Edge で使えます。', 'E-drums and song folders work in Chrome or Edge on a PC.')}</p>}
      </main>
    </div>
  );
}

/** 左の項目。タブレットではタッチ操作・入力パッドを上に（デスクトップではタッチ操作を下に。入力パッドはタブレットの画面だけ） */
function navItems(tablet: boolean): [Section, string][] {
  // 言語はどちらの言語の画面でも見つけられるように、両方の名前を出す i18n-ignore
  const lang: [Section, string] = ['lang', tr('言語（Language）', 'Language (言語)')];
  const touch: [Section, string] = ['touch', tr('タッチ操作', 'Touch')];
  const rest: [Section, string][] = [
    ['midi', tr('電子ドラム（MIDI）', 'Electronic drums (MIDI)')],
    ['keys', tr('キーボード', 'Keyboard')],
    ['lanes', tr('レーンの並び', 'Lane order')],
    ['latency', tr('入力の遅れの補正', 'Input latency')],
    ['sound', tr('音の出力', 'Audio output')],
    ['velocity', tr('ベロシティ', 'Velocity')],
  ];
  const ai: [Section, string] = ['ai', tr('AI（OpenRouter）', 'AI (OpenRouter)')];
  const app: [Section, string] = ['app', tr('アプリとして使う', 'Use as an app')];
  const drive: [Section, string] = ['drive', 'Google Drive'];
  if (tablet) {
    const [midi, keys, ...others] = rest;
    return [lang, touch, ['pads', tr('入力パッド', 'Pads')], keys, midi, ...others, ai, drive, app];
  }
  return [lang, ...rest, touch, ai, drive, app];
}

function LanguageSettings() {
  return (
    <div className="settings-col">
      <h2>{tr('言語', 'Language')}</h2>
      <div className="card">
        <LangSwitch />
        <p className="lbl" style={{ margin: '10px 0 0', lineHeight: 1.7 }}>
          {tr(
            '画面の文字と、AI が返す文（曲情報のメモ、難易度生成の方針や判定の理由、フレーズの名前など）をこの言語にします。保存した譜面・曲名・ファイル名は変わりません。',
            "Sets the language for the screens and for the text the AI writes for you (song info notes, plans and level reasons in the difficulty generator, phrase names, and so on). Saved charts, song titles and file names don't change.",
          )}
        </p>
      </div>
    </div>
  );
}

function MidiSettings() {
  const midi = useMidi();
  const st = useInputSettings();
  const prof = activeProfile();
  const notesFor = (t: LaneTarget) =>
    Object.entries(prof.notes)
      .filter(([, v]) => v.lane === t.lane && v.alt === t.alt)
      .map(([k]) => Number(k))
      .sort((a, b) => a - b);
  const lastFor = (t: LaneTarget) => (midi.last?.target && midi.last.target.lane === t.lane && midi.last.target.alt === t.alt ? midi.last.velocity : null);

  return (
    <div className="settings-col">
      <h2>{tr('電子ドラム（MIDI）', 'Electronic drums (MIDI)')}</h2>
      {NO_MIDI && <MidiUnavailableNote />}
      <div className="card row" style={{ flexWrap: 'wrap' }}>
        {Icon.midi(16)}
        <span className="grow">
          {midi.status === 'on'
            ? tr(`${midi.inputs.map((i) => i.name).join('、')} を接続中`, `Connected: ${midi.inputs.map((i) => i.name).join(', ')}`)
            : midi.status === 'none'
              ? tr('MIDI機器が見つかりません。USBでつないでから「つなぐ」を押してください。', 'No MIDI device found. Connect it over USB, then press "Connect".')
              : midi.status === 'unsupported'
                ? tr('このブラウザは Web MIDI に対応していません（Chrome・Edge などで使えます）。', "This browser doesn't support Web MIDI (it works in Chrome, Edge and others).")
                : midi.status === 'denied'
                  ? tr('MIDIの利用が許可されませんでした。アドレスバーのサイト設定から許可してください。', "MIDI access wasn't allowed. Allow it from the site settings in the address bar.")
                  : tr('まだつないでいません。', 'Not connected yet.')}
        </span>
        {midi.status !== 'unsupported' && (
          <button className="btn small primary" onClick={() => void enableMidi()}>
            {midi.status === 'on' ? tr('もう一度探す', 'Search again') : tr('電子ドラムをつなぐ', 'Connect')}
          </button>
        )}
      </div>
      {midi.last && (
        <div className="lbl">
          {tr('最後に来たノート: ', 'Last note: ')}
          <span className="mono">{midi.last.note}</span> ({noteName(midi.last.note)}) {tr('ベロシティ', 'velocity')} <span className="mono">{midi.last.velocity}</span> →{' '}
          {midi.last.target ? targets().find((x) => x.t.lane === midi.last!.target!.lane && x.t.alt === midi.last!.target!.alt)?.name : tr('割り当てなし', 'Not assigned')}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <span className="lbl">{tr('プロファイル（機器ごと・モードごと）', 'Profile (per device or mode)')}</span>
          <select className="field" style={{ width: 220, height: 28 }} value={st.profileId} onChange={(e) => useInputSettings.setState({ profileId: e.target.value })}>
            {st.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={() => addProfile(prof)}>
            {tr('複製', 'Duplicate')}
          </button>
          <button className="btn small" onClick={() => addProfile()}>
            {tr('新しいプロファイル', 'New profile')}
          </button>
          <button className="btn small ghost danger" onClick={() => removeProfile(prof.id)} disabled={st.profiles.length <= 1}>
            {tr('削除', 'Delete')}
          </button>
        </div>
        <label className="row" style={{ marginBottom: 10 }}>
          <span className="lbl" style={{ width: 60 }}>
            {tr('名前', 'Name')}
          </span>
          <input className="field" style={{ height: 28, maxWidth: 320 }} value={prof.name} onChange={(e) => updateProfile(prof.id, { name: e.target.value })} />
        </label>
        <label className="row" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={prof.ignoreVelocity} onChange={(e) => updateProfile(prof.id, { ignoreVelocity: e.target.checked })} style={{ marginTop: 3 }} />
          <span>
            {tr('ベロシティを無視して、すべて最大で入力する', 'Ignore velocity and enter every hit at maximum')}
            <br />
            <span className="lbl">
              {tr(
                '叩いたベロシティに関係なく、試し打ちの音を最大の音量で鳴らします（DTXのチップにはベロシティがありません）。',
                'Plays test hits at full volume no matter how hard you hit (DTX chips have no velocity).',
              )}
            </span>
          </span>
        </label>
        <label className="slider-row" style={{ gridTemplateColumns: '150px minmax(0,1fr) 36px', marginTop: 8 }}>
          <span className="lbl">{tr('これより弱い入力は無視', 'Ignore hits softer than')}</span>
          <input type="range" min={0} max={60} value={prof.minVelocity} onChange={(e) => updateProfile(prof.id, { minVelocity: Number(e.target.value) })} />
          <span className="mono lbl">{prof.minVelocity}</span>
        </label>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="map-grid">
          <thead>
            <tr>
              <th>{tr('レーン', 'Lane')}</th>
              <th>{tr('名前', 'Name')}</th>
              <th>{tr('割り当て（ノート番号）', 'Assigned notes')}</th>
              <th>{tr('最後のベロシティ', 'Last velocity')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {targets().map((x) => {
              const learning = midi.learn && midi.learn.lane === x.t.lane && midi.learn.alt === x.t.alt;
              const v = lastFor(x.t);
              return (
                <tr key={x.key}>
                  <td className="mono" style={{ color: x.color, fontWeight: 700 }}>
                    {x.key}
                  </td>
                  <td>{x.name}</td>
                  <td>
                    <div className="chip-wrap">
                      {notesFor(x.t).map((n) => (
                        <span key={n} className="note-chip">
                          <span className="mono">{n}</span>
                          <span className="lbl">{noteName(n)}</span>
                          <button onClick={() => setNote(prof.id, n, null)} aria-label={tr(`ノート ${n} を外す`, `Remove note ${n}`)}>
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {v !== null && (
                      <span className="vel">
                        <span style={{ width: `${(v / 127) * 100}%` }} />
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className={`btn small ${learning ? 'primary' : ''}`} onClick={() => startLearn(learning ? null : x.t)}>
                      {learning ? tr('パッドを叩いて…', 'Hit a pad…') : tr('覚える', 'Learn')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="lbl">{tr('1つのレーンに複数のノートを割り当てられます（ボウ・エッジ・リムなど）。「覚える」を押してからパッドを叩くと追加します。', 'You can assign several notes to one lane (bow, edge, rim, and so on). Press "Learn", then hit a pad to add it.')}</p>

      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('ハイハットのクローズ／オープンの判定', 'Hi-hat closed/open detection')}
          <span className="grow" />
          <span className="lbl">
            {tr('今のペダル: ', 'Pedal now: ')}CC4 = <span className="mono">{midi.pedal}</span> → {midi.pedal >= prof.hhClosedAt ? tr('クローズ', 'closed') : tr('オープン', 'open')}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="row">
            <input type="radio" checked={prof.hhMode === 'note'} onChange={() => updateProfile(prof.id, { hhMode: 'note' })} />
            {tr('ノート番号で決める（上の割り当てのまま。多くの電子ドラムはオープンとクローズで別のノートを送ります）', 'By note number (as assigned above; most electronic kits send different notes for open and closed)')}
          </label>
          <label className="row">
            <input type="radio" checked={prof.hhMode === 'pedal'} onChange={() => updateProfile(prof.id, { hhMode: 'pedal' })} />
            {tr('叩いた瞬間のペダル（CC4）で決める', 'By the pedal position (CC4) at the moment of the hit')}
          </label>
          {prof.hhMode === 'pedal' && (
            <label className="slider-row" style={{ gridTemplateColumns: '130px minmax(0,1fr) 50px' }}>
              <span className="lbl">{tr('クローズとみなす値', 'Closed at')}</span>
              <input type="range" min={1} max={127} value={prof.hhClosedAt} onChange={(e) => updateProfile(prof.id, { hhClosedAt: Number(e.target.value) })} />
              <span className="mono lbl">{tr(`${prof.hhClosedAt} 以上`, `${prof.hhClosedAt}+`)}</span>
            </label>
          )}
          <p className="lbl" style={{ margin: 0 }}>
            {tr(
              'HHパッドを叩いた瞬間のペダルの状態で、HH（ch11）かHHオープン（ch18）に振り分けます。ペダルを踏んだ音（44番）は左ペダル（ch1B）に入ります。',
              'Each HH pad hit goes to HH (ch11) or HH open (ch18) depending on the pedal at that moment. Pedal chicks (note 44) go to the left pedal (ch1B).',
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function KeySettings() {
  const keys = useInputSettings((s) => s.keys);
  const [capture, setCapture] = useState<number | null>(null);
  useEffect(() => {
    if (capture === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Escape' && !['ShiftLeft', 'ShiftRight', 'Space', 'Enter', 'BracketLeft', 'BracketRight'].includes(e.code) && !e.code.startsWith('Arrow')) setKey(e.code, capture);
      setCapture(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture]);
  const keyOf = (lane: number) => Object.entries(keys).find(([, v]) => v === lane)?.[0];
  return (
    <div className={`settings-col ${capture !== null ? 'capturing' : ''}`}>
      <h2>{tr('キーボード', 'Keyboard')}</h2>
      <p className="lbl">{tr('キー入力モードと録音で使うレーンの割り当てです。マウス入力のときは試し打ちになります。', 'Lane keys for Keys input mode and recording. In Mouse mode they play test hits.')}</p>
      <div className="key-grid">
        {DRUM_LANES.map((l, i) => {
          const k = keyOf(i);
          return (
            <button key={l.key} className={`key-cell ${capture === i ? 'on' : ''}`} onClick={() => setCapture(capture === i ? null : i)}>
              <span className="mono" style={{ color: l.color, fontWeight: 700 }}>
                {l.key}
              </span>
              <span className="key-cap">{capture === i ? '…' : k ? keyLabel(k) : '—'}</span>
              <span className="lbl">{l.name}</span>
            </button>
          );
        })}
      </div>
      <div className="row">
        <button className="btn small" onClick={() => useInputSettings.setState({ keys: { ...DEFAULT_KEYS } })}>
          {tr('初期の割り当てに戻す', 'Reset to defaults')}
        </button>
        {capture !== null && <span className="lbl">{tr('割り当てるキーを押してください（Escでやめる）', 'Press the key to assign (Esc to cancel)')}</span>}
      </div>
      {isJa() ? (
        <p className="lbl" style={{ lineHeight: 1.8 }}>
          <kbd>Shift</kbd>＋キーで HHオープン・左バスドラム。<kbd>↑</kbd>
          <kbd>↓</kbd> でカーソル移動、<kbd>[</kbd> <kbd>]</kbd> でグリッド変更、<kbd>Ctrl</kbd>＋<kbd>D</kbd> で前の小節を複製。
        </p>
      ) : (
        <p className="lbl" style={{ lineHeight: 1.8 }}>
          <kbd>Shift</kbd>+key for HH open and left bass drum. <kbd>↑</kbd> <kbd>↓</kbd> move the cursor, <kbd>[</kbd> <kbd>]</kbd> change the grid, and <kbd>Ctrl</kbd>+<kbd>D</kbd>{' '}
          duplicates the previous measure.
        </p>
      )}
    </div>
  );
}

const lanePresets = (): { id: string; name: string; order: number[] }[] => [
  { id: 'nx', name: tr('NXの標準（LC HH LP SD HT BD LT FT CY RD）', 'NX default (LC HH LP SD HT BD LT FT CY RD)'), order: DEFAULT_LANE_ORDER },
  { id: 'ride', name: tr('ライドを右シンバルの左に（… FT RD CY）', 'Ride left of the right cymbal (… FT RD CY)'), order: [0, 1, 2, 3, 4, 5, 6, 7, 9, 8] },
  { id: 'lp', name: tr('左ペダルをスネアの右に（LC HH SD LP …）', 'Left pedal right of the snare (LC HH SD LP …)'), order: [0, 1, 3, 2, 4, 5, 6, 7, 8, 9] },
  { id: 'mirror', name: tr('左右反転', 'Mirrored'), order: [...DEFAULT_LANE_ORDER].reverse() },
];

function LaneOrderSettings() {
  const order = useInputSettings((s) => s.laneOrder);
  const [pick, setPick] = useState<number | null>(null);
  const move = (slot: number, d: number) => {
    const to = slot + d;
    if (to < 0 || to > 9) return;
    const next = [...order];
    [next[slot], next[to]] = [next[to], next[slot]];
    setLaneOrder(next);
  };
  return (
    <div className="settings-col">
      <h2>{tr('レーンの並び', 'Lane order')}</h2>
      <p className="lbl">
        {tr(
          '譜面のレーンを左からどの順に並べるかです。NXのレーンの表示設定に合わせると、ゲームと同じ見た目で書けます。DTXの中身（チャンネル）は変わりません。',
          "The left-to-right order of the chart's lanes. Match NX's lane display setting to chart with the same look as the game. The DTX contents (channels) don't change.",
        )}
      </p>
      <div className="card">
        <div className="lane-order">
          {order.map((lane, slot) => {
            const l = DRUM_LANES[lane];
            return (
              <div key={l.key} className={`lane-slot ${pick === slot ? 'on' : ''}`}>
                <button
                  className="lane-slot-name mono"
                  style={{ color: l.color }}
                  title={tr('クリックで選び、もう一つのレーンをクリックすると入れ替えます', 'Click to select, then click another lane to swap them')}
                  onClick={() => {
                    if (pick === null) return setPick(slot);
                    if (pick !== slot) {
                      const next = [...order];
                      [next[slot], next[pick]] = [next[pick], next[slot]];
                      setLaneOrder(next);
                    }
                    setPick(null);
                  }}
                >
                  {l.key}
                </button>
                <span className="lbl">{l.name}</span>
                <div className="row" style={{ gap: 2 }}>
                  <button className="ib tiny" onClick={() => move(slot, -1)} disabled={slot === 0} aria-label={tr(`${l.name}を左へ`, `Move ${l.name} left`)}>
                    ‹
                  </button>
                  <button className="ib tiny" onClick={() => move(slot, 1)} disabled={slot === 9} aria-label={tr(`${l.name}を右へ`, `Move ${l.name} right`)}>
                    ›
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="lbl" style={{ margin: '10px 0 0' }}>
          {tr('レーン名をクリックして、もう一つのレーン名をクリックすると入れ替わります。‹ › で一つずつ動かせます。', 'Click a lane name, then another, to swap them. ‹ › move a lane one step.')}
        </p>
      </div>
      <div className="card">
        <b style={{ fontSize: 13 }}>{tr('よく使う並び', 'Common orders')}</b>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {lanePresets().map((p) => {
            const on = p.order.every((v, i) => order[i] === v);
            return (
              <button key={p.id} className={`btn small ${on ? 'primary' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => setLaneOrder(p.order)}>
                {on ? '✓ ' : ''}
                {p.name}
              </button>
            );
          })}
        </div>
        <p className="lbl" style={{ margin: '10px 0 0' }}>{tr('NXの設定画面の並びと違うときは、上で並べ替えてください。', "If it doesn't match the order in NX's settings, rearrange it above.")}</p>
      </div>
    </div>
  );
}

function VelocitySettings() {
  const presets = useInputSettings((s) => s.velPresets);
  const step = useInputSettings((s) => s.velStep);
  const curve = useInputSettings((s) => s.velCurve);
  const setPreset = (i: number, v: string) => {
    const n = Math.max(1, Math.min(100, Math.round(Number(v) || 0)));
    const next = [...presets] as [number, number, number];
    next[i] = n;
    useInputSettings.setState({ velPresets: next });
  };
  return (
    <div className="settings-col">
      <h2>{tr('ベロシティ', 'Velocity')}</h2>
      <p className="lbl" style={{ lineHeight: 1.7 }}>
        {tr(
          'DTXには音ごとのベロシティが無いので、ベロシティは「同じ音で #VOLUME だけ違う WAV」として書き出します（例: snare.wav のベロシティ100は #WAV07、ベロシティ35は #WAV0F）。保存した譜面はそのまま NX で遊べます。',
          "DTX has no per-note velocity, so velocity is saved as WAVs that share a sound but differ in #VOLUME (e.g. snare.wav at velocity 100 is #WAV07, and at velocity 35 is #WAV0F). Saved charts play as is in NX.",
        )}
      </p>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('置くベロシティ（操作バーの 強・中・弱、キー 1・2・3）', 'Placing velocity (Hard, Mid and Soft in the toolbar, keys 1, 2, 3)')}
        </div>
        <div className="row" style={{ gap: 14 }}>
          {velPresetNames().map((name, i) => (
            <label key={name} className="row" style={{ gap: 6 }}>
              <span>{name}</span>
              <input className="field mono" style={{ width: 64 }} type="number" min={1} max={100} value={presets[i]} onChange={(e) => setPreset(i, e.target.value)} />
            </label>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0' }}>
          {tr('Alt を押しながら置くと「弱」になります。初期値は 100・70・35 です。', 'Hold Alt while placing for "Soft". The defaults are 100, 70 and 35.')}
        </p>
      </div>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('ベロシティの刻み', 'Velocity steps')}
        </div>
        <div className="seg">
          {(
            [
              [5, tr('5刻み（おすすめ）', 'Steps of 5 (recommended)')],
              [10, tr('10刻み', 'Steps of 10')],
              [1, tr('まとめない', "Don't round")],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={step === v ? 'on' : ''} onClick={() => useInputSettings.setState({ velStep: v })}>
              {label}
            </button>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
          {tr('ベロシティを刻みにまとめると、使う WAV 番号が少なくて済みます。WAV 番号は 01〜ZZ の 1295 個までです。', 'Rounding velocity to steps uses fewer WAV numbers. There are 1295 WAV numbers, from 01 to ZZ.')}
        </p>
      </div>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('電子ドラムのベロシティの変換', 'Electronic drum velocity curve')}
        </div>
        <div className="seg">
          {(
            [
              ['soft', tr('やわらかめ', 'Soft')],
              ['normal', tr('標準', 'Normal')],
              ['hard', tr('かため', 'Hard')],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={curve === v ? 'on' : ''} onClick={() => useInputSettings.setState({ velCurve: v })}>
              {label}
            </button>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
          {tr(
            '叩いたベロシティ（0〜127）を 1〜100 にするときのカーブです。やわらかめは弱く叩いても強めに入ります。電子ドラムの設定で「ベロシティを無視」をオンにすると、すべて 100 で入ります。',
            'The curve that maps hit velocity (0–127) to 1–100. Soft enters fairly strong values even for light hits. Turn on "Ignore velocity" in the electronic drum settings to enter everything at 100.',
          )}
        </p>
      </div>
    </div>
  );
}

function LatencySettings() {
  const latency = useInputSettings((s) => s.latencyMs);
  const [test, setTest] = useState<{ clicks: number[]; taps: number[]; running: boolean; result: number | null }>({ clicks: [], taps: [], running: false, result: null });
  const testRef = useRef(test);
  testRef.current = test;

  const start = () => {
    const ctx = engine.ensure();
    void ctx.resume();
    const t0 = ctx.currentTime + 0.6;
    const clicks: number[] = [];
    // 0.5秒ごとに16回（最初の4回は合わせるための準備）
    for (let i = 0; i < 16; i++) {
      const when = t0 + i * 0.5;
      engine.clickAt(when, i % 4 === 0);
      clicks.push(when);
    }
    // ctx の時刻を performance.now() に直す
    const ts = ctx.getOutputTimestamp?.();
    const perfOf = (when: number) =>
      ts && ts.contextTime !== undefined && ts.performanceTime ? ts.performanceTime + (when - ts.contextTime) * 1000 : performance.now() + (when - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
    setTest({ clicks: clicks.map(perfOf), taps: [], running: true, result: null });
    window.setTimeout(() => finish(), (16 * 0.5 + 1.2) * 1000);
  };

  const finish = () => {
    const t = testRef.current;
    const diffs: number[] = [];
    for (const tap of t.taps) {
      let best = Infinity;
      for (const c of t.clicks.slice(4)) if (Math.abs(tap - c) < Math.abs(best)) best = tap - c;
      if (Math.abs(best) < 200) diffs.push(best);
    }
    diffs.sort((a, b) => a - b);
    const result = diffs.length >= 4 ? Math.round(diffs[Math.floor(diffs.length / 2)]) : null;
    setTest({ ...t, running: false, result });
  };

  useEffect(() => {
    if (!test.running) return;
    const onTap = (e: KeyboardEvent | PointerEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.repeat) return;
        e.preventDefault();
      }
      setTest((t) => ({ ...t, taps: [...t.taps, e.timeStamp || performance.now()] }));
    };
    const offMidi = useMidi.subscribe((s, p) => {
      if (s.last && s.last !== p.last) setTest((t) => ({ ...t, taps: [...t.taps, s.last!.at] }));
    });
    window.addEventListener('keydown', onTap);
    return () => {
      window.removeEventListener('keydown', onTap);
      offMidi();
    };
  }, [test.running]);

  return (
    <div className="settings-col">
      <h2>{tr('入力の遅れの補正', 'Input latency')}</h2>
      <p className="lbl" style={{ lineHeight: 1.7 }}>
        {tr(
          '録音で置いた位置が、いつも少し後ろ（または前）にずれるときに合わせます。スピーカーまでの遅れはブラウザが分かる分を自動で引いているので、ここでは残りのずれを補正します。',
          'Use this when recorded hits always land a little late (or early). Output latency that the browser knows about is already subtracted automatically; this corrects whatever is left.',
        )}
      </p>
      <div className="card row">
        <span className="lbl" style={{ width: 120 }}>
          {tr('録音の補正', 'Recording offset')}
        </span>
        <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: latency - 1 })}>
          −1
        </button>
        <span className="mono" style={{ fontSize: 18, fontWeight: 700, width: 90, textAlign: 'center' }}>
          {latency >= 0 ? '+' : ''}
          {latency} ms
        </span>
        <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: latency + 1 })}>
          +1
        </button>
        <span className="grow" />
        <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: 0 })}>
          {tr('0 に戻す', 'Reset to 0')}
        </button>
      </div>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('測定', 'Measure')}
        </div>
        <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.7 }}>
          {tr(
            'クリックが16回鳴ります。最初の4回で拍をつかみ、残りに合わせて何かのキーか電子ドラムを叩いてください。',
            'A click plays 16 times. Get the beat during the first 4, then hit any key or drum pad along with the rest.',
          )}
        </p>
        <div className="row">
          <button className="btn small primary" onClick={start} disabled={test.running}>
            {test.running ? tr(`測定中…（${test.taps.length} 回）`, `Measuring… (${test.taps.length} ${pl(test.taps.length, 'hit')})`) : tr('測定を始める', 'Start measuring')}
          </button>
          {test.result !== null && (
            <>
              <span>
                {tr('ずれ', 'Offset')}{' '}
                <b className="mono">
                  {test.result > 0 ? '+' : ''}
                  {test.result} ms
                </b>
              </span>
              <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: test.result! })}>
                {tr('この値にする', 'Use this value')}
              </button>
            </>
          )}
          {!test.running && test.result === null && test.taps.length > 0 && <span className="lbl">{tr('うまく測れませんでした。もう一度どうぞ。', "Couldn't measure it. Please try again.")}</span>}
        </div>
      </div>
    </div>
  );
}
