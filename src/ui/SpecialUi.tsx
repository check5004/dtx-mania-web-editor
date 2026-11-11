// 特殊ノーツ（クラップ・タンバリンなど）の画面：種類の設定（列の見出し・右クリック・左のキットから開く小さな画面）と、
// 左のキットの「特殊ノーツ」の欄。操作は store/special、種類の一覧は store/specialLayout。
import { tr, pl } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toBase36x2, toMeasure } from '../dtx/base36';
import { SPECIAL_COLORS } from '../dtx/kinds';
import { voiceColor } from '../dtx/model';
import { wavLabel } from '../dtx/rim';
import { startLearnKind, useMidi } from '../input/midi';
import { keyLabel } from '../input/settings';
import { NO_MIDI, useDevice } from '../store/device';
import { currentKitFile, fileBuffer, toast, useEditor, wavAuditionSound } from '../store/editor';
import { useSidecar } from '../store/sidecar';
import {
  changeKindDest,
  closeKindSettings,
  kindKeyOk,
  kindSoundChoices,
  kindSoundNo,
  laneOfKey,
  openKindSettings,
  pickNewKind,
  selectKindChips,
  setKindKitSound,
  setKindSound,
  stopKind,
  updateKind,
  useSpecialUi,
} from '../store/special';
import { destCode, destName, SPECIAL_DESTS, specialKind, specialKinds, type SpecialKind } from '../store/specialLayout';
import { openCutForKind } from '../store/cut';
import { AuditionButton, AuditionProgress } from './Audition';
import { Icon } from './icons';

// ---- 種類の設定 ---------------------------------------------------------------------------

/** 譜面の画面に 1 つだけ置く（右クリックのメニューと同じ所） */
export function SpecialPopoverHost() {
  const pop = useSpecialUi((s) => s.pop);
  // 譜面の画面を離れたら閉じる
  useEffect(() => () => closeKindSettings(), []);
  if (!pop) return null;
  return <KindPopover key={pop.id} id={pop.id} x={pop.x} y={pop.y} />;
}

/** General MIDI の打楽器の名前（電子ドラムのノートを選ぶとき） */
const GM_DRUMS: Record<number, string> = {
  35: 'Acoustic Bass Drum',
  36: 'Bass Drum 1',
  37: 'Side Stick',
  38: 'Acoustic Snare',
  39: 'Hand Clap',
  40: 'Electric Snare',
  41: 'Low Floor Tom',
  42: 'Closed Hi-Hat',
  43: 'High Floor Tom',
  44: 'Pedal Hi-Hat',
  45: 'Low Tom',
  46: 'Open Hi-Hat',
  47: 'Low-Mid Tom',
  48: 'Hi-Mid Tom',
  49: 'Crash Cymbal 1',
  50: 'High Tom',
  51: 'Ride Cymbal 1',
  52: 'Chinese Cymbal',
  53: 'Ride Bell',
  54: 'Tambourine',
  55: 'Splash Cymbal',
  56: 'Cowbell',
  57: 'Crash Cymbal 2',
  58: 'Vibraslap',
  59: 'Ride Cymbal 2',
  60: 'Hi Bongo',
  61: 'Low Bongo',
  62: 'Mute Hi Conga',
  63: 'Open Hi Conga',
  64: 'Low Conga',
  65: 'High Timbale',
  66: 'Low Timbale',
  67: 'High Agogo',
  68: 'Low Agogo',
  69: 'Cabasa',
  70: 'Maracas',
  71: 'Short Whistle',
  72: 'Long Whistle',
  73: 'Short Guiro',
  74: 'Long Guiro',
  75: 'Claves',
  76: 'Hi Wood Block',
  77: 'Low Wood Block',
  78: 'Mute Cuica',
  79: 'Open Cuica',
  80: 'Mute Triangle',
  81: 'Open Triangle',
};

/** チップのある小節（026〜071） */
const spanText = (k: SpecialKind) => (k.firstM === k.lastM ? toMeasure(k.firstM) : `${toMeasure(k.firstM)}〜${toMeasure(k.lastM)}`);

/** ファイルの音を試聴するときの音 */
async function fileSound(path: string) {
  const buf = await fileBuffer(path);
  return buf ? { buf } : null;
}

/** 種類の音の試聴（譜面の WAV、無ければキットの音） */
function kindAudition(k: SpecialKind) {
  const no = kindSoundNo(k.id);
  if (no !== null) return wavAuditionSound(no);
  const file = currentKitFile(k.voice);
  return file ? fileSound(file) : null;
}

function KindPopover({ id, x, y }: { id: string; x: number; y: number }) {
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.laneWav);
  useSidecar((s) => s.special);
  const phone = useDevice((s) => s.phone);
  const k = specialKind(doc, id);
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const gone = !k;
  useEffect(() => {
    if (gone) closeKindSettings();
  }, [gone]);
  // 画面からはみ出さないように（右が足りなければ左へ、下が足りなければ上へ）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || phone) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      let left = x + 4;
      let top = y + 4;
      if (left + r.width > window.innerWidth - 8) left = Math.max(8, x - r.width - 4);
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - r.height);
      setAt((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y, phone]);
  // 外を押す・Esc で閉じる（確かめのダイアログ・お知らせ・メニューの中は外にしない）
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!ref.current || ref.current.contains(t as Node)) return;
      if (t?.closest?.('.modal-back, .toasts, .ctx-menu, .ctx-back')) return;
      closeKindSettings();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-back')) return;
      e.preventDefault();
      e.stopPropagation();
      closeKindSettings();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
  if (!k) return null;
  const custom = !k.preset;
  const body = (
    <>
      <div className="sp-pop-head">
        <span className="sp-pill big" style={{ ['--c' as string]: k.color }} />
        {custom ? (
          <>
            <input
              className="field sp-name"
              defaultValue={k.name}
              aria-label={tr('名前', 'Name')}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== k.name && updateKind(k.id, { name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <input
              className="field mono sp-code"
              defaultValue={k.code}
              maxLength={3}
              style={{ color: k.color }}
              aria-label={tr('列の見出し（3 文字）', 'Column label (3 letters)')}
              title={tr('列の見出しの 3 文字（英字と数字）', 'The 3-letter column label (letters and digits)')}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim().toUpperCase() !== k.code && updateKind(k.id, { code: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </>
        ) : (
          <>
            <b className="sp-name-text grow">{k.name}</b>
            <span className="mono sp-code-text" style={{ color: k.color }}>
              {k.code}
            </span>
          </>
        )}
        <button className="ib ghost" onClick={() => closeKindSettings()} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
          {Icon.close(14)}
        </button>
      </div>
      <div className="sp-pop-colors">
        <span className="lbl sp-lbl">{tr('色', 'Color')}</span>
        {SPECIAL_COLORS.map((c) => (
          <button
            key={c}
            className={`sp-swatch ${c.toLowerCase() === k.color.toLowerCase() ? 'on' : ''}`}
            style={{ background: c }}
            onClick={() => updateKind(k.id, { color: c })}
            aria-label={tr(`色 ${c}`, `Color ${c}`)}
          />
        ))}
        <span className="grow" />
        <span className="lbl">{tr('エディタの中だけの色', 'Editor-only color')}</span>
      </div>
      <DestSection k={k} />
      <SoundSection k={k} />
      <InputSection k={k} />
      <div className="sp-pop-sec sp-pop-foot">
        <span className="sub grow">
          {k.count > 0 ? (
            <>
              <b className="mono">{k.count}</b> {tr('個', pl(k.count, 'chip'))}
              {k.firstM >= 0 && ` · ${tr(`${spanText(k)} 小節`, `${k.firstM === k.lastM ? 'measure' : 'measures'} ${spanText(k)}`)}`}
              {k.autoCount > 0 && tr(`（自動 ${k.autoCount}）`, ` (${k.autoCount} auto)`)}
            </>
          ) : (
            tr('まだ置いていません', 'None placed yet')
          )}
        </span>
        <button
          className="btn small"
          disabled={k.count === 0}
          onClick={() => {
            selectKindChips(k.id);
            closeKindSettings();
          }}
        >
          {tr('この列を全部選ぶ', 'Select all of them')}
        </button>
        <button className="btn small ghost danger" onClick={() => void stopKind(k.id)}>
          {tr('特殊ノーツをやめる…', 'Stop special notes…')}
        </button>
      </div>
    </>
  );
  if (phone) {
    return (
      <>
        <div className="ctx-back sp-back" aria-hidden="true" />
        <div ref={ref} className="sp-pop sheet" role="dialog" aria-label={tr(`${k.name}の設定`, `${k.name} settings`)}>
          <div className="ctx-grab">
            <i />
          </div>
          {body}
        </div>
      </>
    );
  }
  return (
    <div
      ref={ref}
      className="sp-pop"
      role="dialog"
      aria-label={tr(`${k.name}の設定`, `${k.name} settings`)}
      style={{
        left: at?.left ?? x,
        top: at?.top ?? y,
        visibility: at ? 'visible' : 'hidden',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {body}
    </div>
  );
}

/** 行き先：12 のレーンと「自動で鳴らす」 */
function DestSection({ k }: { k: SpecialKind }) {
  const lanes = k.count - k.autoCount;
  return (
    <div className="sp-pop-sec">
      <div className="sp-sec-title">
        <b>{tr('行き先', 'Destination')}</b>
        <span className="lbl">{tr('ゲームでどのレーンに出すか', 'Which lane it uses in the game')}</span>
      </div>
      <div className="sp-dests">
        {SPECIAL_DESTS.map((d) => {
          const on = k.dest === d.ch;
          return (
            <button key={d.ch} className={`sp-dest mono ${on ? 'on' : ''}`} style={{ ['--c' as string]: voiceColor(d.ch) }} title={destName(d.ch)} onClick={() => void changeKindDest(k.id, d.ch)}>
              {d.code}
            </button>
          );
        })}
      </div>
      <button className={`sp-dest auto ${k.dest === 'auto' ? 'on' : ''}`} onClick={() => void changeKindDest(k.id, 'auto')}>
        {Icon.speaker(13)}
        {tr('自動で鳴らす（叩かない・BGM と同じ扱い）', 'Play automatically (not hit, like the BGM)')}
      </button>
      <div className="sub sp-note">
        {k.dest === 'auto'
          ? tr(
              `ゲームでは叩かずに、BGM と同じように自動で鳴ります。${lanes > 0 ? `レーンに置いてある ${lanes} 個も自動で鳴らすにします。` : ''}`,
              `In the game it is not hit; it plays automatically like the BGM.${lanes > 0 ? ` The ${lanes} on lanes become auto-play too.` : ''}`,
            )
          : tr(
              `ゲームでは${destName(k.dest)}のチップになり、${destName(k.dest)}を叩くと${k.name}が鳴ります。${k.count ? `行き先を変えると、置いてある ${lanes} 個も動きます（重なる所は確かめてから）。` : ''}${k.autoCount ? `自動で鳴らすチップ ${k.autoCount} 個はそのままです。` : ''}`,
              `In the game it becomes a ${destName(k.dest)} chip, and hitting the ${destName(k.dest)} plays the ${k.name}.${k.count ? ` Changing it moves the ${lanes} placed too (you confirm overlaps first).` : ''}${k.autoCount ? ` The ${k.autoCount} auto-play ${pl(k.autoCount, 'chip')} stay as they are.` : ''}`,
            )}
      </div>
    </div>
  );
}

/** 音：譜面の音（その種類の音・ラベルを付ければその種類と読める音）か標準の音（キット） */
function SoundSection({ k }: { k: SpecialKind }) {
  const fields = useEditor((s) => s.doc.fields);
  const no = kindSoundNo(k.id);
  const kit = currentKitFile(k.voice);
  const choices = kindSoundChoices(k.id);
  const value = no !== null ? String(no) : 'kit';
  const path = no !== null ? fields['WAV' + toBase36x2(no)] : undefined;
  const label = no !== null ? wavLabel(useEditor.getState().doc, no) : null;
  return (
    <div className="sp-pop-sec">
      <div className="sp-sec-title">
        <b>{tr('音', 'Sound')}</b>
        <span className="lbl">{tr('これから置くチップの音', 'For chips you place from now on')}</span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <select
          className="field mono grow"
          value={value}
          aria-label={tr(`${k.name}の音`, `${k.name} sound`)}
          onChange={(e) => {
            if (e.target.value === 'kit') setKindKitSound(k.id);
            else setKindSound(k.id, Number(e.target.value));
          }}
        >
          {(no === null || kit) && (
            <option value="kit" disabled={!kit}>
              {kit ? tr(`標準の音: ${kit.replace(/^dtxweb_|^lib_/, '')}`, `Built-in: ${kit.replace(/^dtxweb_|^lib_/, '')}`) : tr('（音がありません）', '(no sound)')}
            </option>
          )}
          {choices.map((c) => (
            <option key={c.no} value={c.no}>
              {toBase36x2(c.no)} {c.path}
              {fields['VOLUME' + toBase36x2(c.no)] ? tr(`（ベロシティ ${fields['VOLUME' + toBase36x2(c.no)]}）`, ` (velocity ${fields['VOLUME' + toBase36x2(c.no)]})`) : ''}
            </option>
          ))}
        </select>
        <AuditionButton k={`sp:${k.id}`} load={() => kindAudition(k)} label={tr(`${k.name}の音`, `${k.name} sound`)} size={14} idleIcon={Icon.speaker(14)} style={{ width: 30, height: 30 }} />
        <AuditionProgress k={`sp:${k.id}`} />
      </div>
      <button
        className="btn small sp-cut-btn"
        onClick={() => {
          closeKindSettings();
          openCutForKind(k.id);
        }}
        title={tr(`ステム（無ければ原曲）から${k.name}の音を切り出して、この種類の音にします`, `Extract the ${k.name} sound from the stems (or the original) and use it for this kind`)}
      >
        {Icon.extract(13)} {tr('ステムから切り出す…', 'Extract from stems…')}
      </button>
      <div className="lbl sp-note">
        {path === undefined
          ? tr(
              `置くと、譜面に「;${k.label}」のラベルを付けた #WAV を足します（作業ファイルが無くても${k.name}と分かります）。`,
              `Placing one adds a #WAV labeled ";${k.label}" (recognized as ${k.name} even without the work file).`,
            )
          : label
            ? tr(
                `譜面には「#WAV${toBase36x2(no!)} ${path} ;${label}」のラベルで残るので、作業ファイルが無くても${k.name}と分かります。`,
                `The chart keeps it as "#WAV${toBase36x2(no!)} ${path} ;${label}", so it is recognized as ${k.name} even without the work file.`,
              )
            : tr(
                `ファイル名（${path}）で${k.name}と分かるので、作業ファイルが無くても${k.name}のままです。`,
                `The file name (${path}) marks it as ${k.name}, so it stays ${k.name} even without the work file.`,
              )}
      </div>
      {!kit && choices.length === 0 && (
        <div className="lbl sp-note warn">
          {tr('譜面にこの種類と読める音がありません。WAV のタブで音を足し、ここで選んでください。', 'The chart has no sound this kind can use. Add one on the WAV tab, then pick it here.')}
        </div>
      )}
    </div>
  );
}

/** 入力：キー（キー入力・録音）と電子ドラムのノート */
function InputSection({ k }: { k: SpecialKind }) {
  const [capture, setCapture] = useState(false);
  const learning = useMidi((s) => s.learnKind === k.id);
  useEffect(() => () => startLearnKind(null), []);
  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setCapture(false);
      if (e.key === 'Escape') return;
      if (!kindKeyOk(e.code)) {
        toast(tr(`${keyLabel(e.code)} はほかの操作に使うキーです`, `${keyLabel(e.code)} is used for something else`), 'warn');
        return;
      }
      updateKind(k.id, { key: e.code });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture, k.id]);
  const lane = k.key ? laneOfKey(k.key) : null;
  const notes = Array.from({ length: 128 }, (_, n) => n);
  // スマホはキーボードで置かないので、キーの行は出さない
  const phone = useDevice((s) => s.phone);
  return (
    <div className="sp-pop-sec">
      <b className="sp-sec-title">{tr('入力', 'Input')}</b>
      {!phone && (
        <div className="row sp-in">
          <span className="lbl sp-lbl">{tr('キー', 'Key')}</span>
          <button
            className={`kbd sp-key ${capture ? 'on' : ''}`}
            onClick={() => setCapture(!capture)}
            title={tr('押してから、使うキーを押す（Esc でやめる）', 'Click, then press the key to use (Esc cancels)')}
          >
            {capture ? tr('キーを押して…', 'Press a key…') : k.key ? keyLabel(k.key) : tr('なし', 'None')}
          </button>
          {k.key && !capture && (
            <button className="ib ghost tiny" onClick={() => updateKind(k.id, { key: null })} title={tr('キーを外す', 'Remove the key')} aria-label={tr('キーを外す', 'Remove the key')}>
              {Icon.close(11)}
            </button>
          )}
          <span className="lbl grow">
            {lane ? tr(`${lane}のキーでもあります（この曲では${k.name}が先）`, `Also the ${lane} key (${k.name} wins in this song)`) : tr('キー入力・録音のとき', 'For key input and recording')}
          </span>
        </div>
      )}
      <div className="row sp-in">
        <span className="lbl sp-lbl">MIDI</span>
        <select
          className="field mono grow"
          value={k.midi === null ? '' : String(k.midi)}
          aria-label={tr('電子ドラムのノート', 'Drum pad note')}
          onChange={(e) =>
            updateKind(k.id, {
              midi: e.target.value === '' ? null : Number(e.target.value),
            })
          }
        >
          <option value="">{tr('なし', 'None')}</option>
          {notes.map((n) => (
            <option key={n} value={n}>
              {n}
              {GM_DRUMS[n] ? ` ${GM_DRUMS[n]}` : ''}
            </option>
          ))}
        </select>
        {!NO_MIDI && (
          <button className={`btn small ${learning ? 'primary' : ''}`} onClick={() => startLearnKind(learning ? null : k.id)}>
            {learning ? tr('パッドを叩いて…', 'Hit a pad…') : tr('叩いて覚える', 'Learn')}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- 左のキットの「特殊ノーツ」 -----------------------------------------------------------

/** 左のキットのタブ（iPad・スマホは音のパネル）に出す欄 */
export function SpecialKitSection() {
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.laneWav);
  useSidecar((s) => s.special);
  const focus = useSpecialUi((s) => s.focus);
  const ref = useRef<HTMLDivElement>(null);
  // お知らせの「設定を開く」で、この欄まで動かす
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focus]);
  const kinds = specialKinds(doc);
  const off = !!useSidecar.getState().special?.off;
  return (
    <div ref={ref} className="sp-kit">
      <div className="section-title row" style={{ marginTop: 10 }}>
        <span>{tr('特殊ノーツ', 'Special notes')}</span>
        {kinds.length > 0 && <span className="lbl">{kinds.length}</span>}
        <span className="grow" />
        <button className="btn small ghost sp-add" onClick={() => void addAndOpen()}>
          {Icon.plus(12)} {tr('足す', 'Add')}
        </button>
      </div>
      <p className="lbl" style={{ margin: '-2px 0 2px', lineHeight: 1.6 }}>
        {off
          ? tr('この曲では特殊ノーツに分けていません（表示のメニューで分け直せます）。', 'Special notes are not split out in this song (turn it back on from the View menu).')
          : tr(
              'クラップなど、ドラムのレーンに無い音。エディタでは種類ごとに分けて見せ、ゲームでは「行き先」のレーンに出ます。',
              'Sounds like claps that have no drum lane. The editor shows each kind separately; in the game they use the destination lane.',
            )}
      </p>
      {kinds.map((k) => (
        <KitKindCard key={k.id} k={k} />
      ))}
      {kinds.length === 0 && (
        <button className="btn small sp-add-wide" onClick={() => void addAndOpen()}>
          {Icon.plus(12)} {tr('特殊ノーツを足す', 'Add a special note')}
        </button>
      )}
      <p className="lbl" style={{ margin: 0, lineHeight: 1.6 }}>
        {tr('カウベル・シェイカー・効果音なども。キー入力では Q W E R で置けます。', 'Cowbells, shakers, effects and more. In key input, Q W E R place them.')}
      </p>
    </div>
  );
}

async function addAndOpen() {
  const id = await pickNewKind();
  if (id) openKindSettings(id);
}

function KitKindCard({ k }: { k: SpecialKind }) {
  const fields = useEditor((s) => s.doc.fields);
  const no = kindSoundNo(k.id);
  const kit = currentKitFile(k.voice);
  const choices = kindSoundChoices(k.id);
  return (
    <div className="sp-card" style={{ ['--c' as string]: k.color }}>
      <div className="sp-card-head">
        <span className="sp-pill" style={{ ['--c' as string]: k.color }} />
        <b className="ellipsis">{k.name}</b>
        <span className="lbl">{tr(`${k.count} 個`, `${k.count}`)}</span>
        <span className="grow" />
        <button
          className="ib tiny ghost"
          onClick={(e) => openKindSettings(k.id, e.clientX, e.clientY)}
          title={tr(`${k.name}の設定`, `${k.name} settings`)}
          aria-label={tr(`${k.name}の設定`, `${k.name} settings`)}
        >
          {Icon.gear(13)}
        </button>
      </div>
      <div className="sp-card-grid">
        <span className="lbl">{tr('行き先', 'Lane')}</span>
        <select
          className="field"
          value={String(k.dest)}
          aria-label={tr(`${k.name}の行き先`, `${k.name} destination`)}
          style={{ color: k.dest === 'auto' ? undefined : voiceColor(k.dest) }}
          onChange={(e) => void changeKindDest(k.id, e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
        >
          {SPECIAL_DESTS.map((d) => (
            <option key={d.ch} value={d.ch}>
              {d.code} {destName(d.ch)}
            </option>
          ))}
          <option value="auto">{destName('auto')}</option>
        </select>
        <span className="lbl">{tr('音', 'Sound')}</span>
        <div className="row" style={{ gap: 5, minWidth: 0 }}>
          <select
            className="field mono grow"
            value={no !== null ? String(no) : 'kit'}
            aria-label={tr(`${k.name}の音`, `${k.name} sound`)}
            onChange={(e) => {
              if (e.target.value === 'kit') setKindKitSound(k.id);
              else setKindSound(k.id, Number(e.target.value));
            }}
          >
            {(no === null || kit) && (
              <option value="kit" disabled={!kit}>
                {kit ? tr(`標準: ${kit.replace(/^dtxweb_|^lib_/, '')}`, `Built-in: ${kit.replace(/^dtxweb_|^lib_/, '')}`) : tr('（音がありません）', '(no sound)')}
              </option>
            )}
            {choices.map((c) => (
              <option key={c.no} value={c.no}>
                {toBase36x2(c.no)} {c.path}
                {fields['VOLUME' + toBase36x2(c.no)] ? tr(`（ベロシティ ${fields['VOLUME' + toBase36x2(c.no)]}）`, ` (velocity ${fields['VOLUME' + toBase36x2(c.no)]})`) : ''}
              </option>
            ))}
          </select>
          <AuditionButton k={`sp:${k.id}`} load={() => kindAudition(k)} label={tr(`${k.name}の音`, `${k.name} sound`)} size={13} idleIcon={Icon.speaker(13)} style={{ width: 26, height: 26 }} />
          <AuditionProgress k={`sp:${k.id}`} />
          <button
            className="ib tiny ghost"
            onClick={() => openCutForKind(k.id)}
            title={tr(`ステムから${k.name}の音を切り出す…`, `Extract the ${k.name} sound from the stems…`)}
            aria-label={tr(`ステムから${k.name}の音を切り出す`, `Extract the ${k.name} sound from the stems`)}
          >
            {Icon.extract(13)}
          </button>
        </div>
      </div>
      {k.dest !== 'auto' && (
        <div className="lbl sp-card-note">
          {tr(`ゲームでは${destCode(k.dest)}のチップ`, `A ${destCode(k.dest)} chip in the game`)}
          {k.autoCount > 0 && tr(`・自動 ${k.autoCount} 個`, ` · ${k.autoCount} auto`)}
          {k.elsewhere > 0 && tr(`・ほかのレーンに ${k.elsewhere} 個`, ` · ${k.elsewhere} on other lanes`)}
        </div>
      )}
    </div>
  );
}
