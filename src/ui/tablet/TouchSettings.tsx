// 設定の「タッチ操作」「入力パッド」と、iPad では電子ドラムをつなげないことの知らせ（承認されたデザインの設定（縦）のとおり）
import { useEffect, useRef, useState } from 'react';
import { tr } from '../../i18n';
import { engine } from '../../audio/engine';
import { iosName, IS_IOS, KIT_DEFAULT, setPenMode, setTouchPrefs, useDevice, type OneFinger, type PadLayout, type PanelSide, type PlaceMode, type UiMode, type UiScale } from '../../store/device';
import type { PadMode } from '../../store/pads';
import { Icon } from '../icons';
import { kitSlot, padColor, padKey, padName } from './Pads';

/** 1行：左に名前と説明、右に操作 */
function Row({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-row-text">
        <b>{title}</b>
        {sub && <span className="lbl">{sub}</span>}
      </span>
      <span className="set-row-ctl">{children}</span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="set-block">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Seg<T extends string>({ value, items, onChange, label }: { value: T; items: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg set-seg" role="radiogroup" aria-label={label}>
      {items.map(([k, text]) => (
        <button key={k} role="radio" aria-checked={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`set-switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

export function TouchSettings() {
  const d = useDevice();
  return (
    <div className="settings-col set-touch">
      <h2>{tr('タッチ操作', 'Touch')}</h2>
      <Block title={tr('画面', 'Screen')}>
        <Row
          title={tr('画面のモード', 'Layout mode')}
          sub={
            d.phoneScreen
              ? tr('自動：スマホならスマホ用、指で使うタブレットならタブレット用の画面にします（この端末はスマホです）', 'Auto: the phone layout on phones, the tablet layout on touch tablets (this is a phone)')
              : d.touchDevice
                ? tr('自動：指で使う端末ならタブレット用の画面にします（この端末は指で使う端末です）', 'Auto: use the tablet layout on touch-first devices (this is one)')
                : tr('自動：指で使う端末ならタブレット用の画面にします（この端末はマウスで使う端末です）', 'Auto: use the tablet layout on touch-first devices (this one uses a mouse)')
          }
        >
          <Seg<UiMode>
            value={d.uiMode}
            label={tr('画面のモード', 'Layout mode')}
            items={[
              ['auto', tr('自動', 'Auto')],
              // スマホの画面はスマホ（と、それを選んだとき）だけ出す。PC・iPad の設定の並びは変えない
              ...(d.phoneScreen || d.uiMode === 'phone' ? ([['phone', tr('スマホ', 'Phone')]] as [UiMode, string][]) : []),
              ['tablet', tr('タブレット', 'Tablet')],
              ['desktop', tr('デスクトップ', 'Desktop')],
            ]}
            onChange={(v) => setTouchPrefs({ uiMode: v })}
          />
        </Row>
        {d.tablet && !d.phone && (
          <>
            <Row title={tr('文字とボタンの大きさ', 'Text and button size')}>
              <Seg<UiScale>
                value={d.uiScale}
                label={tr('文字とボタンの大きさ', 'Text and button size')}
                items={[
                  ['normal', tr('標準', 'Normal')],
                  ['large', tr('大きめ', 'Large')],
                ]}
                onChange={(v) => setTouchPrefs({ uiScale: v })}
              />
            </Row>
            <Row title={tr('パネルの位置', 'Panel side')} sub={tr('左手で操作するなら左へ', 'Choose left if you use your left hand')}>
              <Seg<PanelSide>
                value={d.panelSide}
                label={tr('パネルの位置', 'Panel side')}
                items={[
                  ['right', tr('右', 'Right')],
                  ['left', tr('左', 'Left')],
                ]}
                onChange={(v) => setTouchPrefs({ panelSide: v })}
              />
            </Row>
          </>
        )}
      </Block>
      {d.tablet ? (
        <>
          <Block title={tr('指の操作', 'Fingers')}>
            {d.phone && (
              <Row
                title={tr('置き方', 'How to place')}
                sub={
                  d.placeMode === 'bubble'
                    ? tr('吹き出し：触れると指の上にレーンと位置が出て、動かして合わせ、離すと置く。触れてすぐなぞるとスクロール', 'Bubble: touch to see the lane and position above your finger, move to adjust, release to place. A quick swipe scrolls')
                    : tr('すぐ置く：触れた所にすぐ置く（タブレットと同じ）', 'Instant: places right where you touch (same as on tablets)')
                }
              >
                <Seg<PlaceMode>
                  value={d.placeMode}
                  label={tr('置き方', 'How to place')}
                  items={[
                    ['bubble', tr('吹き出し', 'Bubble')],
                    ['instant', tr('すぐ置く', 'Instant')],
                  ]}
                  onChange={(v) => setTouchPrefs({ placeMode: v })}
                />
              </Row>
            )}
            <Row title={tr('1本指でなぞったとき', 'One-finger drag')} sub={tr('「置く」のとき。2本指ならいつでもスクロール', 'With Place. Two fingers always scroll')}>
              <Seg<OneFinger>
                value={d.oneFinger}
                label={tr('1本指でなぞったとき', 'One-finger drag')}
                items={[
                  ['scroll', tr('スクロール', 'Scroll')],
                  ['select', tr('範囲選択', 'Select')],
                ]}
                onChange={(v) => setTouchPrefs({ oneFinger: v })}
              />
            </Row>
            <Row title={tr('長押しの長さ', 'Long-press time')} sub={tr('短くするとメニューが早く出ます', 'Shorter opens menus sooner')}>
              <span className="set-slider">
                <input
                  type="range"
                  min={200}
                  max={800}
                  step={50}
                  value={d.longPressMs}
                  onChange={(e) => setTouchPrefs({ longPressMs: Number(e.target.value) })}
                  aria-label={tr('長押しの長さ', 'Long-press time')}
                />
                <span className="mono lbl">{(d.longPressMs / 1000).toFixed(2)} s</span>
              </span>
            </Row>
            <Row title={tr('2本指タップで元に戻す・3本指タップでやり直す', 'Two-finger tap to undo, three to redo')}>
              <Switch on={d.tapUndo} onChange={(v) => setTouchPrefs({ tapUndo: v })} label={tr('元に戻すジェスチャ', 'Undo gestures')} />
            </Row>
            <Row title={tr('ダブルタップで消す', 'Double-tap to delete')}>
              <Switch on={d.dblTapDelete} onChange={(v) => setTouchPrefs({ dblTapDelete: v })} label={tr('ダブルタップで消す', 'Double-tap to delete')} />
            </Row>
          </Block>
          {!d.phone && (
            <Block title="Apple Pencil">
              <Row
                title={tr('ペンで置く・選ぶ、指はスクロールだけ', 'Pencil places and selects; fingers only scroll')}
                sub={
                  d.pen
                    ? tr('いまはオンです。誤タッチで置いてしまうのを防ぎます', "It's on now. Prevents accidental placing")
                    : tr('ペンを使ったら自動でオン。誤タッチで置いてしまうのを防ぎます', 'Turns on when a Pencil is used. Prevents accidental placing')
                }
              >
                <Switch
                  on={d.penAuto}
                  onChange={(v) => {
                    setTouchPrefs({ penAuto: v });
                    if (!v) setPenMode(false);
                  }}
                  label="Apple Pencil"
                />
              </Row>
            </Block>
          )}
        </>
      ) : (
        <p className="lbl" style={{ lineHeight: 1.7 }}>
          {tr(
            'タブレット用の画面では、指の操作（長押しのメニュー・2本指で元に戻す など）と Apple Pencil の設定がここに出ます。',
            'In the tablet layout, finger settings (long-press menus, two-finger undo and so on) and Apple Pencil settings appear here.',
          )}
        </p>
      )}
    </div>
  );
}

/** キットの並び：2つを順にタップすると入れ替わる */
function KitOrder() {
  const order = useDevice((s) => s.kitOrder);
  const [pick, setPick] = useState<number | null>(null);
  const tap = (i: number) => {
    if (pick === null) {
      setPick(i);
      return;
    }
    if (pick !== i) {
      const next = [...order];
      [next[pick], next[i]] = [next[i], next[pick]];
      setTouchPrefs({ kitOrder: next });
    }
    setPick(null);
  };
  const isDefault = order.every((k, i) => k === KIT_DEFAULT[i]);
  return (
    <div className="set-kit">
      <div className="set-kit-grid" role="group" aria-label={tr('キットの並び', 'Kit layout')}>
        {order.map((k, i) => {
          const [lane, alt] = kitSlot(k);
          return (
            <button key={k} className={`set-kit-pad ${pick === i ? 'on' : ''}`} style={{ color: padColor(lane, alt) }} onClick={() => tap(i)} title={padName(lane, alt)} aria-pressed={pick === i}>
              {padKey(lane, alt)}
            </button>
          );
        })}
      </div>
      <span className="set-kit-note">
        <span className="lbl">
          {pick === null
            ? tr('2つを順にタップすると入れ替わります。上段シンバル、中段は手、下段は足とフロアタム。', 'Tap two pads in turn to swap them. Cymbals on top, hands in the middle, feet and floor tom at the bottom.')
            : tr('入れ替える相手をタップしてください（同じのをもう一度でやめる）', 'Tap the pad to swap with (tap the same one again to cancel)')}
        </span>
        {!isDefault && (
          <button className="btn small" onClick={() => setTouchPrefs({ kitOrder: [...KIT_DEFAULT] })}>
            {tr('初めの並びに戻す', 'Reset the layout')}
          </button>
        )}
      </span>
    </div>
  );
}

/** パッドの遅れを測る：クリックが12回鳴り、最初の4回で拍をつかんで残りの8回に合わせて叩く */
function PadLatencyTest() {
  const [st, setSt] = useState<{ clicks: number[]; taps: number[]; running: boolean; result: number | null; failed: boolean }>({ clicks: [], taps: [], running: false, result: null, failed: false });
  const ref = useRef(st);
  ref.current = st;
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const start = () => {
    const ctx = engine.ensure();
    void ctx.resume();
    const t0 = ctx.currentTime + 0.6;
    const clicks: number[] = [];
    for (let i = 0; i < 12; i++) {
      const when = t0 + i * 0.5;
      engine.clickAt(when, i % 4 === 0);
      clicks.push(when);
    }
    // 音の時刻（AudioContext）を performance.now() に直す（スピーカーまでの遅れはブラウザが分かる分を足す）
    const ts = ctx.getOutputTimestamp?.();
    const perfOf = (when: number) =>
      ts && ts.contextTime !== undefined && ts.performanceTime ? ts.performanceTime + (when - ts.contextTime) * 1000 : performance.now() + (when - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
    setSt({ clicks: clicks.map(perfOf), taps: [], running: true, result: null, failed: false });
    timer.current = window.setTimeout(finish, (12 * 0.5 + 1.2) * 1000);
  };
  const finish = () => {
    const t = ref.current;
    const diffs: number[] = [];
    for (const tap of t.taps) {
      let best = Infinity;
      for (const c of t.clicks.slice(4)) if (Math.abs(tap - c) < Math.abs(best)) best = tap - c;
      if (Math.abs(best) < 200) diffs.push(best);
    }
    diffs.sort((a, b) => a - b);
    const result = diffs.length >= 4 ? Math.max(0, Math.round(diffs[Math.floor(diffs.length / 2)])) : null;
    if (result !== null) setTouchPrefs({ padLatencyMs: result });
    setSt({ ...t, running: false, result, failed: result === null });
  };
  return (
    <div className="set-measure">
      {st.running ? (
        <button
          className="set-tap"
          onPointerDown={(e) => {
            e.preventDefault();
            const at = e.timeStamp || performance.now();
            setSt((t) => ({ ...t, taps: [...t.taps, at] }));
          }}
        >
          <b>TAP</b>
          <span className="lbl">{tr(`${st.taps.length} 回`, `${st.taps.length} taps`)}</span>
        </button>
      ) : (
        <button className="btn" onClick={start}>
          {Icon.metronome(16)} {tr('測る', 'Measure')}
        </button>
      )}
      {st.result !== null && <span className="lbl ok-text">{tr(`${st.result} ms にしました`, `Set to ${st.result} ms`)}</span>}
      {st.failed && <span className="lbl">{tr('うまく測れませんでした。もう一度どうぞ。', "Couldn't measure it. Please try again.")}</span>}
    </div>
  );
}

export function PadSettings() {
  const d = useDevice();
  return (
    <div className="settings-col set-touch">
      <h2>{tr('入力パッド', 'Pads')}</h2>
      <Block title={tr('パッド', 'Pads')}>
        <Row title={tr('並び', 'Layout')} sub={tr('キット＝大きな12個（パネル）、レーン＝譜面の下にレーンと同じ並び', 'Kit = 12 big pads in the panel; Lanes = under the chart, lined up with lanes')}>
          <Seg<PadLayout>
            value={d.padLayout}
            label={tr('パッドの並び', 'Pad layout')}
            items={[
              ['kit', tr('キット', 'Kit')],
              ['lane', tr('レーン', 'Lanes')],
            ]}
            onChange={(v) => setTouchPrefs({ padLayout: v })}
          />
        </Row>
        <KitOrder />
        <Row title={tr('パッドを叩いたとき（はじめ）', 'When you hit a pad (default)')} sub={tr('パッドを開いた最初の入れ方。パネルの上でいつでも変えられます', 'How the pads start out. You can switch any time at the top of the panel')}>
          <Seg<PadMode>
            value={d.padStart}
            label={tr('パッドを叩いたとき（はじめ）', 'When you hit a pad (default)')}
            items={[
              ['aud', tr('試し打ち', 'Audition')],
              ['step', tr('ステップ', 'Step')],
              ['rec', tr('録音', 'Record')],
            ]}
            onChange={(v) => setTouchPrefs({ padStart: v })}
          />
        </Row>
      </Block>
      <Block title={tr('ステップ入力', 'Step input')}>
        <Row title={tr('置いたら次へ進む', 'Advance after placing')} sub={tr('グリッド1つ分 ▶ を進めます', 'Moves ▶ forward by one grid step')}>
          <Switch on={d.stepAdvance} onChange={(v) => setTouchPrefs({ stepAdvance: v })} label={tr('置いたら次へ進む', 'Advance after placing')} />
        </Row>
        <Row title={tr('同時に押したパッドは同じ位置に置く', 'Pads hit together go to the same spot')} sub={tr('指を全部離したときに進みます', 'Advances when all fingers lift')}>
          <Switch on={d.stepChord} onChange={(v) => setTouchPrefs({ stepChord: v })} label={tr('同時押し', 'Chords')} />
        </Row>
      </Block>
      <Block title={tr('録音', 'Recording')}>
        <Row title={tr('パッドの遅れの補正', 'Pad latency')} sub={tr('画面に触れてから音が鳴るまでの遅れ。キーボードとは別に覚えます', 'Delay from touch to sound. Stored separately from the keyboard')}>
          <span className="set-slider">
            <input type="range" min={0} max={120} step={1} value={d.padLatencyMs} onChange={(e) => setTouchPrefs({ padLatencyMs: Number(e.target.value) })} aria-label={tr('パッドの遅れの補正', 'Pad latency')} />
            <span className="mono lbl">{d.padLatencyMs} ms</span>
          </span>
        </Row>
        <Row title={tr('クリックに合わせて叩いて測る', 'Measure by tapping to a click')} sub={tr('クリックが12回鳴ります。最初の4回で拍をつかみ、残りの8回に合わせて叩くと自動で決めます', 'A click plays 12 times. Get the beat during the first 4, then tap along with the other 8 and it is set automatically')}>
          <PadLatencyTest />
        </Row>
        <Row title={tr('カウントイン', 'Count-in')} sub={tr('録音の前に1小節クリック', 'One bar of clicks before recording')}>
          <Switch on={d.countIn} onChange={(v) => setTouchPrefs({ countIn: v })} label={tr('カウントイン', 'Count-in')} />
        </Row>
      </Block>
    </div>
  );
}

/** iPad では電子ドラム（Web MIDI）をつなげない */
export function MidiUnavailableNote() {
  return (
    <section className="set-warn">
      <span className="set-warn-icon">{Icon.info(20)}</span>
      <span className="set-warn-text">
        <b>{IS_IOS ? iosName(tr('この iPad のブラウザでは電子ドラムをつなげません', "This iPad browser can't connect e-drums")) : tr('このブラウザでは電子ドラムをつなげません', "This browser can't connect e-drums")}</b>
        <span className="lbl">
          {IS_IOS
            ? iosName(
                tr(
                  'iPad の Safari（ほかのブラウザも同じ仕組み）は Web MIDI に対応していません。画面のパッドかキーボードで入力してください。PC の Chrome・Edge ならこのまま使えます。プロファイルはこのブラウザに残っています。',
                  'Safari on iPad (and other iPad browsers, which use the same engine) does not support Web MIDI. Use the on-screen pads or a keyboard. Chrome or Edge on a PC works as before. Your profiles stay saved in this browser.',
                ),
              )
            : tr(
                'このブラウザは Web MIDI に対応していません。画面のパッドかキーボードで入力してください。Chrome・Edge ならつなげます。',
                "This browser doesn't support Web MIDI. Use the on-screen pads or a keyboard. Chrome or Edge can connect.",
              )}
        </span>
      </span>
    </section>
  );
}
