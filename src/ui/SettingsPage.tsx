// 設定画面: 電子ドラム（MIDI）、キーボード、入力の遅れの補正。ブラウザに保存する。
import { useEffect, useRef, useState } from 'react';
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
import { goBack, openPage, useEditor } from '../store/editor';
import { AiSettings } from './AiSettings';
import { Icon } from './icons';

type Section = 'midi' | 'keys' | 'lanes' | 'latency' | 'velocity' | 'ai';

const TARGETS: { t: LaneTarget; key: string; name: string; color: string }[] = DRUM_LANES.flatMap((l, i) => {
  const main = { t: { lane: i, alt: false }, key: l.key, name: l.mainName, color: l.color };
  if (l.alt === undefined || !l.altName) return [main];
  return [main, { t: { lane: i, alt: true }, key: l.key === 'HH' ? 'HHO' : 'LBD', name: l.altName, color: l.altColor ?? l.color }];
});

export function SettingsPage() {
  const [sec, setSec] = useState<Section>(() => (useEditor.getState().settingsSection as Section | undefined) ?? 'midi');
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
  return (
    <div className="tempo-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={goBack}>
          {Icon.back(14)} {useEditor.getState().returnPage && useEditor.getState().returnPage !== 'chart' ? '戻る' : 'エディタに戻る'}
        </button>
        <div className="vsep" />
        <h1>設定</h1>
        <span className="lbl">このブラウザに保存します</span>
      </header>
      <div className="settings-body">
        <nav className="settings-nav">
          {(
            [
              ['midi', '電子ドラム（MIDI）'],
              ['keys', 'キーボード'],
              ['lanes', 'レーンの並び'],
              ['latency', '入力の遅れの補正'],
              ['velocity', 'ベロシティ'],
              ['ai', 'AI（OpenRouter）'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={sec === k ? 'on' : ''} onClick={() => setSec(k)}>
              {label}
            </button>
          ))}
          <button className="sub" onClick={() => openPage('guideline')} title="手元の曲から作る、レベルの基準">
            難易度ガイドライン
          </button>
        </nav>
        <main className="settings-main scroll">
          {sec === 'midi' && <MidiSettings />}
          {sec === 'keys' && <KeySettings />}
          {sec === 'lanes' && <LaneOrderSettings />}
          {sec === 'latency' && <LatencySettings />}
          {sec === 'velocity' && <VelocitySettings />}
          {sec === 'ai' && <AiSettings />}
        </main>
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
      <h2>電子ドラム（MIDI）</h2>
      <div className="card row" style={{ flexWrap: 'wrap' }}>
        {Icon.midi(16)}
        <span className="grow">
          {midi.status === 'on'
            ? `${midi.inputs.map((i) => i.name).join('、')} を接続中`
            : midi.status === 'none'
              ? 'MIDI機器が見つかりません。USBでつないでから「つなぐ」を押してください。'
              : midi.status === 'unsupported'
                ? 'このブラウザは Web MIDI に対応していません（Chrome・Edge などで使えます）。'
                : midi.status === 'denied'
                  ? 'MIDIの利用が許可されませんでした。アドレスバーのサイト設定から許可してください。'
                  : 'まだつないでいません。'}
        </span>
        {midi.status !== 'unsupported' && (
          <button className="btn small primary" onClick={() => void enableMidi()}>
            {midi.status === 'on' ? 'もう一度探す' : '電子ドラムをつなぐ'}
          </button>
        )}
      </div>
      {midi.last && (
        <div className="lbl">
          最後に来たノート: <span className="mono">{midi.last.note}</span>（{noteName(midi.last.note)}）ベロシティ <span className="mono">{midi.last.velocity}</span> →{' '}
          {midi.last.target ? TARGETS.find((x) => x.t.lane === midi.last!.target!.lane && x.t.alt === midi.last!.target!.alt)?.name : '割り当てなし'}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <span className="lbl">プロファイル（機器ごと・モードごと）</span>
          <select className="field" style={{ width: 220, height: 28 }} value={st.profileId} onChange={(e) => useInputSettings.setState({ profileId: e.target.value })}>
            {st.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={() => addProfile(prof)}>
            複製
          </button>
          <button className="btn small" onClick={() => addProfile()}>
            新しいプロファイル
          </button>
          <button className="btn small ghost danger" onClick={() => removeProfile(prof.id)} disabled={st.profiles.length <= 1}>
            削除
          </button>
        </div>
        <label className="row" style={{ marginBottom: 10 }}>
          <span className="lbl" style={{ width: 60 }}>
            名前
          </span>
          <input className="field" style={{ height: 28, maxWidth: 320 }} value={prof.name} onChange={(e) => updateProfile(prof.id, { name: e.target.value })} />
        </label>
        <label className="row" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={prof.ignoreVelocity} onChange={(e) => updateProfile(prof.id, { ignoreVelocity: e.target.checked })} style={{ marginTop: 3 }} />
          <span>
            ベロシティを無視して、すべて最大で入力する
            <br />
            <span className="lbl">叩いたベロシティに関係なく、試し打ちの音を最大の音量で鳴らします（DTXのチップにはベロシティがありません）。</span>
          </span>
        </label>
        <label className="slider-row" style={{ gridTemplateColumns: '150px minmax(0,1fr) 36px', marginTop: 8 }}>
          <span className="lbl">これより弱い入力は無視</span>
          <input type="range" min={0} max={60} value={prof.minVelocity} onChange={(e) => updateProfile(prof.id, { minVelocity: Number(e.target.value) })} />
          <span className="mono lbl">{prof.minVelocity}</span>
        </label>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="map-grid">
          <thead>
            <tr>
              <th>レーン</th>
              <th>名前</th>
              <th>割り当て（ノート番号）</th>
              <th>最後のベロシティ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {TARGETS.map((x) => {
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
                          <button onClick={() => setNote(prof.id, n, null)} aria-label={`ノート ${n} を外す`}>
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
                      {learning ? 'パッドを叩いて…' : '覚える'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="lbl">1つのレーンに複数のノートを割り当てられます（ボウ・エッジ・リムなど）。「覚える」を押してからパッドを叩くと追加します。</p>

      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          ハイハットのクローズ／オープンの判定
          <span className="grow" />
          <span className="lbl">
            今のペダル: CC4 = <span className="mono">{midi.pedal}</span> → {midi.pedal >= prof.hhClosedAt ? 'クローズ' : 'オープン'}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="row">
            <input type="radio" checked={prof.hhMode === 'note'} onChange={() => updateProfile(prof.id, { hhMode: 'note' })} />
            ノート番号で決める（上の割り当てのまま。多くの電子ドラムはオープンとクローズで別のノートを送ります）
          </label>
          <label className="row">
            <input type="radio" checked={prof.hhMode === 'pedal'} onChange={() => updateProfile(prof.id, { hhMode: 'pedal' })} />
            叩いた瞬間のペダル（CC4）で決める
          </label>
          {prof.hhMode === 'pedal' && (
            <label className="slider-row" style={{ gridTemplateColumns: '130px minmax(0,1fr) 50px' }}>
              <span className="lbl">クローズとみなす値</span>
              <input type="range" min={1} max={127} value={prof.hhClosedAt} onChange={(e) => updateProfile(prof.id, { hhClosedAt: Number(e.target.value) })} />
              <span className="mono lbl">{prof.hhClosedAt} 以上</span>
            </label>
          )}
          <p className="lbl" style={{ margin: 0 }}>
            HHパッドを叩いた瞬間のペダルの状態で、HH（ch11）かHHオープン（ch18）に振り分けます。ペダルを踏んだ音（44番）は左ペダル（ch1B）に入ります。
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
      <h2>キーボード</h2>
      <p className="lbl">キー入力モードと録音で使うレーンの割り当てです。マウス入力のときは試し打ちになります。</p>
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
          初期の割り当てに戻す
        </button>
        {capture !== null && <span className="lbl">割り当てるキーを押してください（Escでやめる）</span>}
      </div>
      <p className="lbl" style={{ lineHeight: 1.8 }}>
        <kbd>Shift</kbd>＋キーで HHオープン・左バスドラム。<kbd>↑</kbd>
        <kbd>↓</kbd> でカーソル移動、<kbd>[</kbd> <kbd>]</kbd> でグリッド変更、<kbd>Enter</kbd> でカーソルの小節の候補をまとめて採用、<kbd>Ctrl</kbd>＋<kbd>D</kbd> で前の小節を複製。
      </p>
    </div>
  );
}

const LANE_PRESETS: { name: string; order: number[] }[] = [
  { name: 'NXの標準（LC HH LP SD HT BD LT FT CY RD）', order: DEFAULT_LANE_ORDER },
  { name: 'ライドを右シンバルの左に（… FT RD CY）', order: [0, 1, 2, 3, 4, 5, 6, 7, 9, 8] },
  { name: '左ペダルをスネアの右に（LC HH SD LP …）', order: [0, 1, 3, 2, 4, 5, 6, 7, 8, 9] },
  { name: '左右反転', order: [...DEFAULT_LANE_ORDER].reverse() },
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
      <h2>レーンの並び</h2>
      <p className="lbl">譜面のレーンを左からどの順に並べるかです。NXのレーンの表示設定に合わせると、ゲームと同じ見た目で書けます。DTXの中身（チャンネル）は変わりません。</p>
      <div className="card">
        <div className="lane-order">
          {order.map((lane, slot) => {
            const l = DRUM_LANES[lane];
            return (
              <div key={l.key} className={`lane-slot ${pick === slot ? 'on' : ''}`}>
                <button
                  className="lane-slot-name mono"
                  style={{ color: l.color }}
                  title="クリックで選び、もう一つのレーンをクリックすると入れ替えます"
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
                  <button className="ib tiny" onClick={() => move(slot, -1)} disabled={slot === 0} aria-label={`${l.name}を左へ`}>
                    ‹
                  </button>
                  <button className="ib tiny" onClick={() => move(slot, 1)} disabled={slot === 9} aria-label={`${l.name}を右へ`}>
                    ›
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="lbl" style={{ margin: '10px 0 0' }}>レーン名をクリックして、もう一つのレーン名をクリックすると入れ替わります。‹ › で一つずつ動かせます。</p>
      </div>
      <div className="card">
        <b style={{ fontSize: 13 }}>よく使う並び</b>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {LANE_PRESETS.map((p) => {
            const on = p.order.every((v, i) => order[i] === v);
            return (
              <button key={p.name} className={`btn small ${on ? 'primary' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => setLaneOrder(p.order)}>
                {on ? '✓ ' : ''}
                {p.name}
              </button>
            );
          })}
        </div>
        <p className="lbl" style={{ margin: '10px 0 0' }}>NXの設定画面の並びと違うときは、上で並べ替えてください。</p>
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
      <h2>ベロシティ</h2>
      <p className="lbl" style={{ lineHeight: 1.7 }}>
        DTXには音ごとのベロシティが無いので、ベロシティは「同じ音で #VOLUME だけ違う WAV」として書き出します（例: snare.wav のベロシティ100は #WAV07、ベロシティ35は #WAV0F）。保存した譜面はそのまま NX で遊べます。
      </p>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          置くベロシティ（操作バーの 強・中・弱、キー 1・2・3）
        </div>
        <div className="row" style={{ gap: 14 }}>
          {['強', '中', '弱'].map((name, i) => (
            <label key={name} className="row" style={{ gap: 6 }}>
              <span>{name}</span>
              <input className="field mono" style={{ width: 64 }} type="number" min={1} max={100} value={presets[i]} onChange={(e) => setPreset(i, e.target.value)} />
            </label>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0' }}>
          Alt を押しながら置くと「弱」になります。初期値は 100・70・35 です。
        </p>
      </div>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          ベロシティの刻み
        </div>
        <div className="seg">
          {(
            [
              [5, '5刻み（おすすめ）'],
              [10, '10刻み'],
              [1, 'まとめない'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={step === v ? 'on' : ''} onClick={() => useInputSettings.setState({ velStep: v })}>
              {label}
            </button>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
          ベロシティを刻みにまとめると、使う WAV 番号が少なくて済みます。WAV 番号は 01〜ZZ の 1295 個までです。
        </p>
      </div>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          電子ドラムのベロシティの変換
        </div>
        <div className="seg">
          {(
            [
              ['soft', 'やわらかめ'],
              ['normal', '標準'],
              ['hard', 'かため'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={curve === v ? 'on' : ''} onClick={() => useInputSettings.setState({ velCurve: v })}>
              {label}
            </button>
          ))}
        </div>
        <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
          叩いたベロシティ（0〜127）を 1〜100 にするときのカーブです。やわらかめは弱く叩いても強めに入ります。電子ドラムの設定で「ベロシティを無視」をオンにすると、すべて 100 で入ります。
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
      <h2>入力の遅れの補正</h2>
      <p className="lbl" style={{ lineHeight: 1.7 }}>
        録音で置いた位置が、いつも少し後ろ（または前）にずれるときに合わせます。スピーカーまでの遅れはブラウザが分かる分を自動で引いているので、ここでは残りのずれを補正します。
      </p>
      <div className="card row">
        <span className="lbl" style={{ width: 120 }}>
          録音の補正
        </span>
        <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: latency - 1 })}>
          −1
        </button>
        <span className="mono" style={{ fontSize: 18, fontWeight: 700, width: 90, textAlign: 'center' }}>
          {latency >= 0 ? '+' : ''}
          {latency} ms
        </span>
        <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: latency + 1 })}>
          ＋1
        </button>
        <span className="grow" />
        <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: 0 })}>
          0 に戻す
        </button>
      </div>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          測定
        </div>
        <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.7 }}>
          クリックが16回鳴ります。最初の4回で拍をつかみ、残りに合わせて何かのキーか電子ドラムを叩いてください。
        </p>
        <div className="row">
          <button className="btn small primary" onClick={start} disabled={test.running}>
            {test.running ? `測定中…（${test.taps.length} 回）` : '測定を始める'}
          </button>
          {test.result !== null && (
            <>
              <span>
                ずれ <b className="mono">{test.result > 0 ? '+' : ''}{test.result} ms</b>
              </span>
              <button className="btn small" onClick={() => useInputSettings.setState({ latencyMs: test.result! })}>
                この値にする
              </button>
            </>
          )}
          {!test.running && test.result === null && test.taps.length > 0 && <span className="lbl">うまく測れませんでした。もう一度どうぞ。</span>}
        </div>
      </div>
    </div>
  );
}
