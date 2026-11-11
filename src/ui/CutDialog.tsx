// 音を切り出す画面（ステム・原曲から、チップを置いた所の音を WAV にして使う）。中身は store/cut、鳴り始め・切り方は audio/cut。
// 左：どこから切り出すか（元と候補）、真ん中：波形と切り方・整え方、右：聴いて確かめる・ほかの音の混ざり・重ねてきれいにする、
// 下：ファイル名・保存先・ライブラリ・使い道。狭い画面では 2 列・1 列（スマホは全画面）にする。
import { useEffect, useMemo, useRef, useState } from 'react';
import { tr, pl } from '../i18n';
import { CUT_GAP_MS, CUT_SHIFT_MAX_MS, cutPcm, msToSamples, pcmLength, slicePcm, lowShareDb, minMax, wavSize, type Pcm } from '../audio/cut';
import { downmix } from '../audio/dsp';
import { kindColor } from '../dtx/kinds';
import { voiceColor } from '../dtx/model';
import { isDrumlessName } from '../separate/names';
import { stopAudition, toggleAudition, useAudition, type AuditionSound } from '../store/audition';
import {
  applyCut,
  applyRecut,
  auditionOf,
  candSound,
  chipsOfFile,
  closeCut,
  cutCandidates,
  cutKey,
  CUT_TAG,
  cutSources,
  cutUseOptions,
  defaultCutName,
  defaultUse,
  finishPcm,
  isPhone,
  joinPcm,
  nameFits,
  rangeOf,
  recommendStack,
  renderWithCut,
  sortCands,
  sourcePcm,
  splitThenReturn,
  stackCut,
  tagName,
  useCut,
  useKey,
  useName,
  useSourcesVersion,
  voiceCode,
  voiceLabel,
  wavName,
  type CandSound,
  type CutCand,
  type CutOpen,
  type CutSettings,
  type CutUse,
} from '../store/cut';
import { useDevice } from '../store/device';
import type { CutRecipe } from '../store/sidecar';
import { useEditor } from '../store/editor';
import { tagLabel } from '../store/library';
import { specialKinds } from '../store/specialLayout';
import { formatTime } from './format';
import { Icon } from './icons';

export function CutDialogHost() {
  const open = useCut((s) => s.open);
  if (!open) return null;
  return <CutDialog key={open.seq} open={open} />;
}

/** 試聴のボタン（文字つき）。鳴っている間は ■ */
function ListenButton({ k, label, load, disabled }: { k: string; label: string; load: () => AuditionSound | null | Promise<AuditionSound | null>; disabled?: boolean }) {
  const on = useAudition((s) => s.key === k);
  return (
    <button type="button" className={`btn cut-listen ${on ? 'on' : ''}`} disabled={disabled} onClick={() => void toggleAudition(k, load)} aria-pressed={on}>
      {on ? Icon.stop(12) : Icon.play(12)}
      <span className="ellipsis">{label}</span>
    </button>
  );
}

function Dots({ n }: { n: number }) {
  return (
    <span className="cut-dots" title={tr(`きれいさ ${n} / 5`, `Cleanliness ${n} / 5`)} aria-label={tr(`きれいさ ${n} / 5`, `Cleanliness ${n} / 5`)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

/** 同時に鳴る音の札（BD・SD など） */
function OverTags({ over }: { over: readonly number[] }) {
  if (!over.length) return <span className="lbl">{tr('重なりなし', 'Nothing else')}</span>;
  return (
    <>
      {over.map((v) => {
        const c = voiceColor(v) === '#8B95A4' ? kindColorOfVoice(v) : voiceColor(v);
        return (
          <span key={v} className="cut-tg mono" style={{ color: c, background: `${c}22` }} title={voiceLabel(v)}>
            {voiceCode(v)}
          </span>
        );
      })}
      <span className="lbl">{tr('と同時', 'at once')}</span>
    </>
  );
}

function kindColorOfVoice(v: number): string {
  const k = specialKinds(useEditor.getState().doc).find((x) => x.voice === v);
  return k ? kindColor(k.id) : '#8B95A4';
}

const DEF_LEN = 300;

/** 切り始めをずらした分（±0 ms・+3 ms・−2 ms） */
function shiftText(ms: number): string {
  return ms === 0 ? '±0 ms' : `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`;
}

function CutDialog({ open }: { open: CutOpen }) {
  const doc = useEditor((s) => s.doc);
  const soundsVer = useEditor((s) => s.soundsVersion);
  const folder = useEditor((s) => s.folder);
  const ver = useSourcesVersion();
  const phone = useDevice((s) => s.phone);
  const target = open.target;
  const title = doc.fields['TITLE'] ?? '';

  // 元
  const sources = useMemo(() => cutSources(), [ver, soundsVer, doc]);
  const [srcPick, setSrcPick] = useState<string | null>(open.src ?? null);
  const src = sources.find((s) => s.id === srcPick) ?? sources[0] ?? null;
  const pcm = useMemo(() => (src ? sourcePcm(src.id) : null), [src?.id, ver, soundsVer]);

  // 候補
  const cands = useMemo(() => cutCandidates(doc, target, open.sec ?? null), [doc, target, open.sec]);
  const sounds = useMemo(() => {
    const m = new Map<string, CandSound>();
    if (pcm) for (const c of cands) m.set(c.key, candSound(doc, pcm, c, target.type === 'free' ? open.searchMs : undefined));
    return m;
  }, [pcm, cands, doc, target.type, open.searchMs]);
  const order = useMemo(() => sortCands(cands, sounds), [cands, sounds]);
  const [selKey, setSelKey] = useState<string | null>(open.chip != null ? `c${open.chip}` : null);
  const cur = order.find((c) => c.key === selKey) ?? order[0] ?? null;
  const curSound = cur ? sounds.get(cur.key) : undefined;
  const [showAll, setShowAll] = useState(false);

  // 切り方・整え方
  const [view, setView] = useState<'zoom' | 'wide'>('zoom');
  // 切り出した音を直すときは、前の切り方から
  const redo = open.redo ?? null;
  const rc = redo?.recipe ?? null;
  const [lenMode, setLenMode] = useState<'auto' | 'hand'>(rc && rc.lenMs !== null ? 'hand' : 'auto');
  const [lenMs, setLenMs] = useState(rc?.lenMs ?? DEF_LEN);
  const [fadeMs, setFadeMs] = useState(rc?.fadeMs ?? 40);
  const [align, setAlign] = useState(rc?.align ?? true);
  const [startMs, setStartMs] = useState(rc?.startMs ?? 0);
  const [lowCut, setLowCut] = useState(rc?.lowCut ?? true);
  const [normalize, setNormalize] = useState(rc?.normalize ?? true);
  const [mono, setMono] = useState(rc?.mono ?? false);
  const set: CutSettings = useMemo(
    () => ({ align, startMs, lenMs: lenMode === 'hand' ? lenMs : null, shape: { lowCut, normalize, mono, fadeMs } }),
    [align, startMs, lenMode, lenMs, lowCut, normalize, mono, fadeMs],
  );

  // 重ねる（null は 1 か所）。直すときは前に重ねた所（どれも残っていれば）
  const [picks, setPicks] = useState<string[] | null>(() => {
    if (!rc?.stack) return null;
    const keys = rc.stack.map((sec) => cands.find((c) => Math.abs(c.sec - sec) < 0.03)?.key).filter((k): k is string => !!k);
    return keys.length >= 2 ? keys : null;
  });
  const [stackNote, setStackNote] = useState<string | null>(null);

  // 使い道・名前・ライブラリ
  const uses = useMemo(() => cutUseOptions(doc), [doc]);
  const [useSel, setUseSel] = useState<string>(useKey(defaultUse(target)));
  const useOpt = uses.find((u) => u.key === useSel) ?? uses.find((u) => u.key === 'wav')!;
  const use: CutUse = useOpt.use;
  const [name, setName] = useState(() => defaultCutName(defaultUse(target), target));
  const [nameTouched, setNameTouched] = useState(false);
  const [lib, setLib] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!nameTouched) setName(defaultCutName(use, target));
    // 使い道を変えたら、まだ手で変えていない名前を合わせる
  }, [useSel]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1 か所
  const range = pcm && curSound ? rangeOf(pcm, curSound, set) : null;
  const single = useMemo(() => (pcm && range ? cutPcm(pcm, range.start, range.end, set.shape) : null), [pcm, range?.start, range?.end, set]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (pcm && range ? cutPcm(pcm, range.start, range.end, { ...set.shape, normalize: false }) : null), [pcm, range?.start, range?.end, set]); // eslint-disable-line react-hooks/exhaustive-deps

  // 重ねた音（1 つ目は選んでいる所）
  const stackList = useMemo(() => {
    if (!picks) return [];
    const first = cur && picks.includes(cur.key) ? cur.key : picks[0];
    return [first, ...picks.filter((k) => k !== first)].filter((k) => sounds.has(k));
  }, [picks, cur, sounds]);
  const stack = useMemo(() => (pcm && stackList.length >= 2 ? stackCut(pcm, stackList.map((k) => ({ s: sounds.get(k)! })), set) : null), [pcm, stackList, sounds, set]);
  const stacked = useMemo(() => (stack ? finishPcm(stack.pcm, set.shape, true) : null), [stack, set]);
  const result: Pcm | null = picks ? (stacked ?? single) : single;

  // 使い道で音が替わるチップ（この音で鳴らすときに替える）。直すときは、そのファイルの音のチップ
  const swapIds = useMemo(() => {
    if (redo) return new Set<number>(chipsOfFile(doc, redo.file));
    const u = use.type === 'wav' || use.type === 'newKind' ? target : use;
    const ids = new Set<number>();
    if (u.type === 'free') {
      if (cur?.chip != null) ids.add(cur.chip);
      return ids;
    }
    const all = cutCandidates(doc, u.type === 'kind' ? { type: 'kind', id: u.id } : { type: 'voice', voice: u.voice });
    for (const c of all) if (c.chip !== null) ids.add(c.chip);
    if (cur?.chip != null && target.type !== 'free') ids.add(cur.chip);
    return ids;
  }, [use, target, doc, cur?.chip, redo]);

  // Esc：試聴していれば止め、していなければ閉じる（ほかのダイアログが上にあれば何もしない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelectorAll('.modal-back').length > 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (!stopAudition()) closeCut();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const targetName = target.type === 'free' ? '' : useName(target);
  const headUse = use.type === 'wav' ? tr('WAV に足す', 'Add to the WAV list') : use.type === 'newKind' ? tr('新しい特殊ノーツにする', 'Make a new special note') : tr(`${useName(use)}の音にする`, `Use as the ${useName(use)} sound`);
  const fixedName = wavName(name);
  const nameBad = !nameFits(fixedName, use, target);
  const nameMsg = !name.trim()
    ? tr('ファイル名を入れてください', 'Enter a file name')
    : nameBad
      ? use.type === 'kind' || (use.type !== 'voice' && target.type === 'kind')
        ? tr(`この名前だと${useName(use.type === 'kind' ? use : target)}の音と分かりません（ほかの楽器の名前が入っています）`, `With this name it won't be read as ${useName(use.type === 'kind' ? use : target)} (it names another instrument)`)
        : tr('この名前だとほかの音（リム・特殊ノーツ）と読まれます', 'With this name it would be read as another sound (rim or a special note)')
      : fixedName !== name.trim()
        ? tr(`「${fixedName}」で保存します`, `Saved as "${fixedName}"`)
        : null;

  /** 切り始めを ms ずらす（±100 ms まで） */
  const nudgeStart = (d: number) => setStartMs((v) => Math.max(-CUT_SHIFT_MAX_MS, Math.min(CUT_SHIFT_MAX_MS, Math.round(v + d))));

  /** いまの作り方（あとで直すために作業ファイルに残す） */
  const recipeNow = (): Omit<CutRecipe, 'file'> | undefined => {
    if (!src || !cur) return undefined;
    const stackSecs = picks && stack ? stackList.map((k) => order.find((c) => c.key === k)?.sec).filter((x): x is number => x !== undefined) : [];
    return {
      src: src.id,
      target,
      sec: cur.sec,
      ...(target.type === 'free' && open.searchMs ? { searchMs: open.searchMs } : {}),
      ...(stackSecs.length >= 2 ? { stack: stackSecs } : {}),
      align,
      startMs,
      lenMs: lenMode === 'hand' ? lenMs : null,
      fadeMs,
      lowCut,
      normalize,
      mono,
    };
  };

  const apply = async () => {
    if (!result || busy) return;
    setBusy(true);
    stopAudition();
    try {
      const recipe = recipeNow();
      if (redo) {
        if (recipe && (await applyRecut({ pcm: result, file: redo.file, recipe }))) closeCut();
        return;
      }
      const t = tagName(use.type === 'wav' || use.type === 'newKind' ? target : use);
      const done = await applyCut({
        pcm: result,
        name: fixedName,
        use,
        target,
        library: lib,
        tags: [t, title, CUT_TAG].filter((x): x is string => !!x),
        from: src ? (src.id === 'orig' ? tr('原曲', 'the original') : src.name) : '',
        recipe,
      });
      if (done !== null) closeCut();
    } finally {
      setBusy(false);
    }
  };

  const enterStack = () => {
    if (!pcm) return;
    const rec = recommendStack(pcm, order, sounds, set, cur?.key ?? null);
    if (rec.length < 2) {
      setPicks(cur ? [cur.key] : []);
      setStackNote(
        phone
          ? tr(
              '鳴り方の似た所が見つかりませんでした（演奏ごとに音が少しずつ違うようです）。1 か所から切り出すのがおすすめです。下の一覧で選んで重ねることもできます。',
              'No places with a similar sound were found (each hit seems a little different). Extracting from one place is recommended. You can still tick places in the list below to stack them.',
            )
          : tr(
              '鳴り方の似た所が見つかりませんでした（演奏ごとに音が少しずつ違うようです）。1 か所から切り出すのがおすすめです。左の一覧で選んで重ねることもできます。',
              "No places with a similar sound were found (each hit seems a little different). Extracting from one place is recommended. You can still tick places on the left to stack them.",
            ),
      );
    } else {
      setPicks(rec);
      setStackNote(null);
    }
  };

  const togglePick = (k: string) => {
    setPicks((p) => (p ? (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]) : [k]));
  };

  // 初めは上から 8 か所。右クリックした所（選んでいる所）がその中に無ければ、下に足して見せる
  const top = showAll || picks ? order : order.slice(0, 8);
  const visible = cur && !top.includes(cur) ? [...top, cur] : top;
  const hidden = order.length - visible.length;
  const hiddenBusy = order.filter((c) => c.cls === 3 && !visible.includes(c)).length;
  const rank = new Map(order.map((c, i) => [c.key, i + 1]));
  const m = cur ? cur.m : 0;
  const mm = (x: number) => String(x).padStart(3, '0');
  const kb = result ? Math.max(1, Math.round(wavSize(result) / 1024)) : 0;
  const noSources = sources.length === 0;
  const stemsReady = sources.some((s) => s.id !== 'orig');
  const autoLen = range && pcm ? Math.round(((range.end - range.start) / pcm.sr) * 1000) : 0;

  // 中身の部品（PC・iPad は左・真ん中・右の 3 列と下の欄、スマホは波形を上に止めて、ほかを下でスクロール）
  const ready = !!(cur && pcm && curSound && range && shown);
  /** どこから切り出すか：元の選び方と説明 */
  const srcPart = (
    <>
      <div className="cut-colh">{tr('どこから切り出すか', 'Where to extract from')}</div>
      <select className="field" value={src?.id ?? ''} onChange={(e) => setSrcPick(e.target.value)} aria-label={tr('切り出す元', 'Source')}>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id === 'orig' ? tr(`原曲（${s.file.split(/[\\/]/).pop()}）`, `Original (${s.file.split(/[\\/]/).pop()})`) : s.drums ? tr(`ドラム（ステム）${s.file}`, `Drums (stem) ${s.file}`) : tr(`${s.name}（${s.file}）`, `${s.name} (${s.file})`)}
          </option>
        ))}
      </select>
      <div className={`lbl cut-src-note ${src && src.id !== 'orig' && src.drums ? '' : 'warn'}`}>
        {!src
          ? ''
          : src.id === 'orig'
            ? isDrumlessName(src.file)
              ? tr('原曲はドラム抜きなので、ドラムの音はほとんど入っていません。', 'The original has no drums, so drum sounds are mostly missing.')
              : tr(
                  '原曲からでも切り出せますが、ベースや声が混ざります（ドラム抜きの BGM なら、ドラムの音は入っていません）。',
                  'You can extract from the original, but bass and vocals get mixed in (a drumless BGM has no drum sounds in it).',
                )
            : src.drums
              ? tr('ベースや歌が混ざらないので、原曲より きれいに取れます。', 'No bass or vocals mixed in, so it comes out cleaner than from the original.')
              : tr('ドラムのステムではありません。ドラムの音は小さいかもしれません。', 'Not the drum stem. Drum sounds may be quiet in it.')}
      </div>
      {!stemsReady && (
        <div className="cut-split">
          <b>{tr('ステムに分けると混ざりません', 'Split into stems to keep it clean')}</b>
          {phone ? (
            <span className="lbl">{tr('ステムに分けると、ドラムだけの音から選べます（PC・タブレットで分けられます）。', 'With stems you can pick from the drums alone (split them on a PC or tablet).')}</span>
          ) : (
            <>
              <span className="lbl">{tr('分けるのはこの曲で一度だけ。終わるとここに戻ります。', 'You only split a song once. When it finishes you come back here.')}</span>
              <button className="btn small" onClick={splitThenReturn} disabled={isPhone()}>
                {Icon.layers(13)} {tr('ステムに分解…', 'Split into stems…')}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
  /** 切り出す所の一覧（候補） */
  const listPart = (
    <>
      <div className="cut-listh">
        {picks ? (
          <>
            <b>{tr('重ねる所', 'Places to stack')}</b>
            <span className="mono lbl">
              {stackList.length} / {order.length}
            </span>
            <span className="grow" />
            <button className="btn small" onClick={enterStack}>
              {tr('おすすめを選ぶ', 'Pick recommended')}
            </button>
          </>
        ) : (
          <>
            <b className="ellipsis">{target.type === 'free' ? tr('選んだ所', 'The place you picked') : tr(`${targetName}を置いた所`, `Where ${targetName} is placed`)}</b>
            <span className="mono lbl">{order.length}</span>
            <span className="grow" />
            {order.length > 1 && <span className="lbl">{tr('重なりの少ない順', 'Least overlap first')}</span>}
          </>
        )}
      </div>
      <div className="cut-cands" role="listbox" aria-label={tr('切り出す所', 'Places to extract')}>
        {visible.map((c) => {
          const s = sounds.get(c.key);
          const on = cur?.key === c.key;
          const picked = !!picks?.includes(c.key);
          return (
            <div
              key={c.key}
              className={`cut-cand ${on ? 'on' : ''}`}
              role="option"
              aria-selected={on}
              tabIndex={0}
              onClick={() => setSelKey(c.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelKey(c.key);
                }
              }}
            >
              {picks ? (
                <input
                  type="checkbox"
                  checked={picked}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => togglePick(c.key)}
                  aria-label={tr(`${c.pos} を重ねる`, `Stack ${c.pos}`)}
                />
              ) : (
                <span className="cut-rank mono">{rank.get(c.key)}</span>
              )}
              <svg width="64" height="28" aria-hidden="true" className="cut-mini">
                <path d={s?.wave ?? 'M0,14 L64,14'} fill={on ? '#4CC2FF' : '#5B6B80'} />
              </svg>
              <span className="cut-cand-main">
                <span className="cut-cand-l1">
                  <b className="mono">{c.pos}</b>
                  <Dots n={s?.dots ?? c.dots} />
                </span>
                <span className="cut-cand-l2">
                  <OverTags over={c.over} />
                </span>
              </span>
              <CandPlay c={c} s={s} pcm={pcm} set={set} onPress={() => setSelKey(c.key)} />
            </div>
          );
        })}
        {order.length === 0 && (
          <p className="lbl cut-none">
            {phone
              ? tr(
                  `${targetName}のチップがまだありません。譜面の右の原曲の列（打点・波形）を長押しすると、ほかの所から切り出せます。`,
                  `There are no ${targetName} chips yet. Long-press the original-audio column (hits and waveform) on the right of the chart to extract from another place.`,
                )
              : tr(
                  `${targetName}のチップがまだありません。下のトラックの波形を右クリックすると、ほかの所から切り出せます。`,
                  `There are no ${targetName} chips yet. Right-click the waveform in the tracks below to extract from another place.`,
                )}
          </p>
        )}
      </div>
      {hidden > 0 && (
        <button className="link-btn cut-more" onClick={() => setShowAll(true)}>
          {hiddenBusy > 0
            ? tr(`ほか ${hidden} か所（ほかの音と同時の ${hiddenBusy} か所を含む）`, `${hidden} more (including ${hiddenBusy} with other sounds)`)
            : tr(`ほか ${hidden} か所`, `${hidden} more`)}
        </button>
      )}
      <p className="lbl cut-left-note">
        {picks
          ? tr(
              '「おすすめを選ぶ」は、ほかのチップと重ならない所・バスドラムとだけ重なる所から、鳴り方の似たものを選びます。',
              '"Pick recommended" chooses places with a similar sound among those with no other chips or only the bass drum.',
            )
          : tr(
              '譜面でほかのチップと同時の所は、その音も混ざります。バスドラムだけなら「低い音を弱める」でほぼ取れます。',
              'Where other chips are placed at the same time, their sound gets mixed in. If it is only the bass drum, "Reduce low end" removes most of it.',
            )}
      </p>
    </>
  );
  /** 波形（見出し・拡大の波形・全体・重ねたときの比べ） */
  const wavePart =
    cur && pcm && curSound && range && shown ? (
      <>
        <div className="cut-mainh">
          {picks && stack ? (
            <>
              <b>{tr(`${stackList.length} か所を重ねた音`, `${stackList.length} places stacked`)}</b>
              <span className="lbl">{tr('鳴り始めでそろえて平均（ずれは 1 ms 以内に合わせる）', 'Aligned at the onset and averaged (within 1 ms)')}</span>
            </>
          ) : (
            <>
              <b className="mono">{cur.pos}</b>
              <span className="mono lbl">{formatTime(curSound.onset.found ? cur.sec + (curSound.onset.at - curSound.at) / pcm.sr : cur.sec)}</span>
              <span className="lbl">{tr('の所', '')}</span>
            </>
          )}
          <span className="grow" />
          {!(picks && stack) && (
            <div className="seg" role="group" aria-label={tr('波形の見え方', 'Waveform view')}>
              <button className={view === 'wide' ? 'on' : ''} onClick={() => setView('wide')}>
                {tr('前後 1 秒', '±1 s')}
              </button>
              <button className={view === 'zoom' ? 'on' : ''} onClick={() => setView('zoom')}>
                {tr('拡大', 'Zoom')}
              </button>
            </div>
          )}
        </div>
        {picks && stack ? (
          <StackWave parts={stack.parts} shifts={stack.shifts} out={stack.pcm} fadeMs={fadeMs} />
        ) : (
          <CutWave
            p={pcm}
            start={range.start}
            end={range.end}
            head={curSound.onset.found ? curSound.onset.at : curSound.at}
            next={range.next}
            nextName={cur.next ? cur.next.voices.map(voiceLabel).join(tr('・', ', ')) : ''}
            shown={shown}
            fadeMs={fadeMs}
            wide={view === 'wide'}
            onLen={(ms) => {
              setLenMode('hand');
              setLenMs(ms);
            }}
            shift={startMs}
            onShift={setStartMs}
          />
        )}
        {!(picks && stack) && <Overview p={pcm} head={curSound.onset.found ? curSound.onset.at : curSound.at} start={range.start} end={range.end} />}
        {picks && stack && (
          <div className="cut-stats">
            <div className="cut-stat">
              <span className="lbl">{tr(`1 か所だけ（${stackList[0] ? (order.find((c) => c.key === stackList[0])?.pos ?? '') : ''}）`, `One place (${order.find((c) => c.key === stackList[0])?.pos ?? ''})`)}</span>
              <b className="mono">{tr(`ほかの音 ${Math.round(stack.single)} dB`, `Other sounds ${Math.round(stack.single)} dB`)}</b>
            </div>
            <div className="cut-stat on">
              <span className="lbl">{tr(`${stackList.length} か所を重ねた音`, `${stackList.length} places stacked`)}</span>
              <b className="mono">{tr(`ほかの音 ${Math.round(stack.stacked)} dB`, `Other sounds ${Math.round(stack.stacked)} dB`)}</b>
            </div>
          </div>
        )}
      </>
    ) : null;
  /** 切り方・整え方 */
  const ctlPart =
    cur && pcm && curSound && range && shown ? (
      <div className="cut-ctl">
        <span className="lbl">{tr('切り始め', 'Start')}</span>
        <div className="cut-ctl-row cut-shift">
          <div className="cut-nudge" role="group" aria-label={tr('切り始めをずらす', 'Shift the start')}>
            <button type="button" className="btn" onClick={() => nudgeStart(-1)} aria-label={tr('1 ms 前へ', '1 ms earlier')} title={tr('1 ms 前へ', '1 ms earlier')}>
              −
            </button>
            <span className="mono cut-val">{shiftText(startMs)}</span>
            <button type="button" className="btn" onClick={() => nudgeStart(1)} aria-label={tr('1 ms 後ろへ', '1 ms later')} title={tr('1 ms 後ろへ', '1 ms later')}>
              +
            </button>
          </div>
          {startMs !== 0 && (
            <button type="button" className="btn small ghost" onClick={() => setStartMs(0)}>
              {tr('0 に戻す', 'Reset')}
            </button>
          )}
          <span className="lbl cut-shift-note">
            {align ? tr('鳴り始めの 2 ms 前から', 'From 2 ms before the onset') : tr('チップの時刻から', 'From the chip time')}
            {tr('。波形の左の青い線もドラッグできます', '. You can also drag the left blue line')}
          </span>
        </div>
        <span className="lbl">{tr('長さ', 'Length')}</span>
        <div className="cut-ctl-row">
          <div className="seg">
            <button className={lenMode === 'auto' ? 'on' : ''} onClick={() => setLenMode('auto')}>
              {tr('自動', 'Auto')}
            </button>
            <button
              className={lenMode === 'hand' ? 'on' : ''}
              onClick={() => {
                if (lenMode !== 'hand') setLenMs(Math.max(40, autoLen || DEF_LEN));
                setLenMode('hand');
              }}
            >
              {tr('手で', 'Manual')}
            </button>
          </div>
          {lenMode === 'hand' ? (
            <>
              <input type="range" min={40} max={1000} step={5} value={lenMs} onChange={(e) => setLenMs(Number(e.target.value))} aria-label={tr('長さ', 'Length')} className="cut-range" />
              <span className="mono cut-val">{lenMs} ms</span>
            </>
          ) : (
            <>
              <span className="mono cut-val">{picks && stack ? Math.round((pcmLength(stack.pcm) / pcm.sr) * 1000) : autoLen} ms</span>
              <span className="lbl ellipsis">
                {picks && stack
                  ? tr('いちばん短い所（次の音の手前）にそろえる', 'Matched to the shortest place (before the next sound)')
                  : range.next !== null
                    ? tr(`次の音の ${CUT_GAP_MS} ms 手前まで`, `Up to ${CUT_GAP_MS} ms before the next sound`)
                    : tr('次の音が無いので 1 秒まで', 'No next sound, so up to 1 s')}
              </span>
            </>
          )}
        </div>
        <span className="lbl">{tr('フェードアウト', 'Fade out')}</span>
        <div className="cut-ctl-row">
          <input type="range" min={0} max={200} step={5} value={fadeMs} onChange={(e) => setFadeMs(Number(e.target.value))} aria-label={tr('フェードアウト', 'Fade out')} className="cut-range" />
          <span className="mono cut-val">{fadeMs} ms</span>
        </div>
        <span className="lbl">{tr('整える', 'Clean up')}</span>
        <div className="cut-checks">
          {!picks && (
            <label className="cut-ck">
              <input type="checkbox" checked={align} onChange={(e) => setAlign(e.target.checked)} />
              {tr('鳴り始めにそろえる（2 ms 前から）', 'Start at the onset (2 ms before)')}
            </label>
          )}
          <label className="cut-ck">
            <input type="checkbox" checked={lowCut} onChange={(e) => setLowCut(e.target.checked)} />
            {tr('低い音を弱める（150 Hz より下。バスドラムの混ざりを減らす）', 'Reduce low end (below 150 Hz, less bass drum)')}
          </label>
          <label className="cut-ck">
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
            {tr('音量をそろえる（いちばん大きい所を −1 dB）', 'Normalize (peak at −1 dB)')}
          </label>
        </div>
        <span className="lbl">{tr('チャンネル', 'Channels')}</span>
        <div className="cut-ctl-row">
          <div className="seg">
            <button className={!mono ? 'on' : ''} onClick={() => setMono(false)}>
              {tr('ステレオ', 'Stereo')}
            </button>
            <button className={mono ? 'on' : ''} onClick={() => setMono(true)}>
              {tr('モノラル', 'Mono')}
            </button>
          </div>
        </div>
      </div>
    ) : null;
  const nonePart = <p className="lbl cut-none">{pcm ? tr('切り出す所を選んでください。', 'Pick a place to extract.') : tr('元の音を読み込んでいます…', 'Loading the audio…')}</p>;
  /** 聴いて確かめる・ほかの音の混ざり・重ねてきれいにする */
  const listenPart = (
    <>
      <div className="cut-colh">{tr('聴いて確かめる', 'Listen to check')}</div>
      <ListenButton k={cutKey('result')} label={picks && stack ? tr('重ねた音', 'Stacked sound') : tr('切り出した音', 'Extracted sound')} load={() => auditionOf(result)} disabled={!result} />
      {picks && stack ? (
        <ListenButton k={cutKey('compare')} label={tr('1 か所だけの音と聴き比べ', 'Compare with one place')} load={() => (single && stacked ? auditionOf(joinPcm(single, stacked)) : null)} disabled={!single || !stacked} />
      ) : (
        <ListenButton
          k={cutKey('orig')}
          label={tr('元の所（前後 1 秒）', 'The original spot (±1 s)')}
          load={() => (pcm && curSound ? auditionOf(slicePcm(pcm, curSound.at - pcm.sr, curSound.at + pcm.sr)) : null)}
          disabled={!pcm || !curSound}
        />
      )}
      <ListenButton
        k={cutKey('song')}
        label={tr(`この音で ${mm(m)}〜${mm(m + 1)} を鳴らす`, `Play ${mm(m)}–${mm(m + 1)} with this sound`)}
        load={async () => {
          if (!result) return null;
          const buf = await renderWithCut(doc, result, swapIds, m);
          return buf ? { buf } : null;
        }}
        disabled={!result || !cur}
      />
      {cur && curSound && pcm && (
        <Mix
          cur={cur}
          s={curSound}
          orig={src?.id === 'orig'}
          lowCut={lowCut}
          result={result}
          stack={picks ? stack : null}
          stackPicks={stackList.map((k) => order.find((c) => c.key === k)).filter((c): c is CutCand => !!c)}
          nextMs={range && range.next !== null ? Math.round(((range.next - (curSound.onset.found ? curSound.onset.at : curSound.at)) / pcm.sr) * 1000) : null}
          hand={lenMode === 'hand' && !!range && range.next !== null && range.end > range.next - msToSamples(pcm.sr, CUT_GAP_MS)}
        />
      )}
      <div className="cut-stack-card">
        <b>
          {tr('重ねてきれいにする', 'Stack to clean up')}
          {picks && <span className="mono lbl"> {tr(`${stackList.length} か所`, `${stackList.length} ${pl(stackList.length, 'place')}`)}</span>}
        </b>
        {picks ? (
          <>
            <span className="lbl">
              {stackNote ??
                (phone
                  ? tr('下の一覧のチェックで、重ねる所を増やしたり減らしたりできます。', 'Tick places in the list below to add or remove them.')
                  : tr('左の一覧のチェックで、重ねる所を増やしたり減らしたりできます。', 'Tick places in the list on the left to add or remove them.'))}
            </span>
            <button
              className="btn small"
              onClick={() => {
                setPicks(null);
                setStackNote(null);
              }}
            >
              {tr('1 か所に戻す', 'Back to one place')}
            </button>
          </>
        ) : (
          <>
            <span className="lbl">{tr('同じ音を何か所か重ねて平均すると、毎回は鳴っていない音（ハイハットの残りなど）が小さくなります。', 'Averaging the same sound from several places makes sounds that are not there every time (hi-hat tails and so on) quieter.')}</span>
            <button className="btn small" onClick={enterStack} disabled={!pcm || order.length < 2}>
              {Icon.layers(13)} {tr('重ねる所を選ぶ…', 'Choose places to stack…')}
            </button>
          </>
        )}
      </div>
    </>
  );
  /** ファイル名 */
  const namePart = (
    <label className="cut-ff cut-name">
      <span className="lbl">{tr('ファイル名', 'File name')}</span>
      <input
        className={`field mono ${nameBad || !name.trim() ? 'bad' : ''}`}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNameTouched(true);
        }}
        spellCheck={false}
      />
    </label>
  );
  /** 保存先 */
  const wherePart = (
    <div className="cut-ff cut-where">
      <span className="lbl">{tr('保存先', 'Saved to')}</span>
      <span className="mono ellipsis">
        {folder ? tr('曲フォルダ', 'Song folder') : tr('曲フォルダ（保存のとき）', 'Song folder (on save)')} · WAV 16bit {result ? `${(result.sr / 1000).toFixed(1).replace(/\.0$/, '')}kHz` : ''} {mono ? tr('モノラル', 'mono') : tr('ステレオ', 'stereo')}
        {kb ? ` · ${kb} KB` : ''}
      </span>
    </div>
  );
  /** ライブラリにも入れる */
  const libPart = (
    <div className="cut-ff cut-lib">
      <label className="cut-ck">
        <input type="checkbox" checked={lib} onChange={(e) => setLib(e.target.checked)} />
        {tr('ライブラリにも入れる', 'Also add to the library')}
      </label>
      {lib && (
        <span className="cut-tags">
          {[tagName(use.type === 'wav' || use.type === 'newKind' ? target : use), title, CUT_TAG]
            .filter((x): x is string => !!x)
            .map((t) => (
              <span key={t} className="cut-tag ellipsis">
                {tagLabel(t)}
              </span>
            ))}
        </span>
      )}
    </div>
  );
  /** 使い道 */
  const usePart = (
    <label className="cut-ff cut-use">
      <span className="lbl">{tr('使い道', 'Use')}</span>
      <select className="field" value={useOpt.key} onChange={(e) => setUseSel(e.target.value)}>
        {uses.some((u) => u.group === 'kind') && (
          <optgroup label={tr('特殊ノーツの音にする', 'As a special note sound')}>
            {uses
              .filter((u) => u.group === 'kind')
              .map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
          </optgroup>
        )}
        {uses
          .filter((u) => u.group === 'new')
          .map((u) => (
            <option key={u.key} value={u.key}>
              {u.label}
            </option>
          ))}
        <optgroup label={tr('レーンの音にする', 'As a lane sound')}>
          {uses
            .filter((u) => u.group === 'voice')
            .map((u) => (
              <option key={u.key} value={u.key}>
                {u.label}
              </option>
            ))}
        </optgroup>
        {uses
          .filter((u) => u.group === 'wav')
          .map((u) => (
            <option key={u.key} value={u.key}>
              {u.label}
            </option>
          ))}
      </select>
    </label>
  );
  /** やめる */
  const cancelBtn = (
    <button className="btn ghost" onClick={() => closeCut()} disabled={busy}>
      {tr('やめる', 'Cancel')}
    </button>
  );
  /** 切り出して使う（直すときは「作り直す」） */
  const applyBtn = (
    <button className="btn primary" onClick={() => void apply()} disabled={!result || busy || (!redo && (nameBad || !name.trim()))}>
      {Icon.extract(14)} {redo ? tr('作り直す', 'Remake') : tr('切り出して使う', 'Extract and use')}
    </button>
  );
  /** 直すファイル（直すとき。ファイル名と使い道の代わり） */
  const redoPart = redo ? (
    <div className="cut-ff cut-redo">
      <span className="lbl">{tr('作り直すファイル', 'File to remake')}</span>
      <span className="mono ellipsis cut-redo-file" title={redo.file}>
        {redo.file}
      </span>
    </div>
  ) : null;
  /** 直すときの説明（何が替わるか・作り方が残っていないとき） */
  const redoNote = redo ? (
    <div className="cut-foot-note lbl">
      {swapIds.size > 0
        ? tr(`同じファイルに書き直すので、この音のチップ ${swapIds.size} 個がみな新しい音で鳴ります。`, `The same file is rewritten, so all ${swapIds.size} ${pl(swapIds.size, 'chip')} with this sound play the new sound.`)
        : tr('同じファイルに書き直すので、この音を使う所はみな新しい音になります。', 'The same file is rewritten, so everything that uses this sound gets the new sound.')}
      {tr('「元に戻す」で前の音に戻せます。', ' Undo brings back the old sound.')}
      {!rc && tr('切り方が残っていない音（前の版で切り出した音）なので、初めの切り方から開いています。', ' Its settings were not kept (made with an older version), so it opens with the default settings.')}
    </div>
  ) : null;
  /** 使い道の説明（ファイル名がだめなときはその知らせ） */
  const notePart = (
    <div className={`cut-foot-note lbl ${nameMsg && (nameBad || !name.trim()) ? 'warn' : ''}`}>
      {nameMsg && (nameBad || !name.trim()) ? nameMsg : <UseNote use={use} count={useOpt.count} now={useOpt.now} note={nameMsg} />}
    </div>
  );

  return (
    <div className="modal-back cut-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && closeCut()}>
      <div className={`cut-dlg ${picks ? 'stacking' : ''} ${redo ? 'redo' : ''}`} role="dialog" aria-modal="true" aria-label={redo ? tr('切り出した音を直す', 'Edit the extracted sound') : tr('音を切り出す', 'Extract a sound')}>
        <div className="cut-head">
          <span className="cut-head-ic">{redo ? Icon.pencil(16) : Icon.extract(16)}</span>
          <b>{redo ? tr('切り出した音を直す', 'Edit the extracted sound') : tr('音を切り出す', 'Extract a sound')}</b>
          <span className="lbl ellipsis cut-head-sub">
            {redo ? redo.file : headUse}
            {title ? ` · ${title}` : ''}
          </span>
          <span className="grow" />
          {!phone && <span className="lbl cut-esc">{tr('Esc で閉じる', 'Esc to close')}</span>}
          <button className="ib" onClick={() => closeCut()} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
            {Icon.close(16)}
          </button>
        </div>

        {noSources ? (
          <div className="cut-empty">
            <p>{tr('切り出す元の音がありません。原曲を読み込むか、ステムを足してください（下のトラックの「＋」）。', 'There is no audio to extract from. Load the original or add stems (the "+" in the tracks below).')}</p>
            <button className="btn" onClick={() => closeCut()}>
              {tr('閉じる', 'Close')}
            </button>
          </div>
        ) : phone ? (
          // スマホ：波形はいつも上に見せ、切り方・元・聴く・ファイル名は下でスクロール（横は波形を左、ほかを右）
          <div className="cut-pbody">
            <div className="cut-pwave">{ready ? wavePart : nonePart}</div>
            <div className="cut-pscroll">
              <div className="cut-col cut-psec">{srcPart}</div>
              {ctlPart && <div className="cut-col cut-psec">{ctlPart}</div>}
              <div className="cut-col cut-psec">{listenPart}</div>
              <div className="cut-col cut-psec">{listPart}</div>
              <div className="cut-col cut-psec cut-pfile">
                {redo ? (
                  <>
                    {wherePart}
                    {redoNote}
                  </>
                ) : (
                  <>
                    {namePart}
                    {libPart}
                    {notePart}
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="cut-body">
            {/* ---- 左：どこから切り出すか ---- */}
            <div className="cut-col cut-left">
              {srcPart}
              {listPart}
            </div>

            {/* ---- 真ん中：波形と切り方 ---- */}
            <div className="cut-col cut-main">
              {ready ? (
                <>
                  {wavePart}
                  {ctlPart}
                </>
              ) : (
                nonePart
              )}
            </div>

            {/* ---- 右：聴いて確かめる ---- */}
            <div className="cut-col cut-right">{listenPart}</div>
          </div>
        )}

        {!noSources && !phone && (
          <div className="cut-foot">
            {redo ? (
              <>
                {redoPart}
                {wherePart}
              </>
            ) : (
              <>
                {namePart}
                {wherePart}
                {libPart}
              </>
            )}
            <span className="grow" />
            {!redo && usePart}
            <div className="cut-btns">
              {cancelBtn}
              {applyBtn}
            </div>
            {redo ? redoNote : notePart}
          </div>
        )}
        {!noSources && phone && (
          <div className="cut-foot cut-pfoot">
            {redo ? redoPart : usePart}
            {applyBtn}
          </div>
        )}
      </div>
    </div>
  );
}

/** 使い道の説明（何が替わるか） */
function UseNote({ use, count, now, note }: { use: CutUse; count: number; now?: string; note: string | null }) {
  const extra = note ? ` ${note}` : '';
  if (use.type === 'wav') return <>{tr('WAV の一覧に足すだけで、チップの音は変えません。', 'Only adds it to the WAV list; chips keep their sound.') + extra}</>;
  if (use.type === 'newKind') return <>{tr('足す種類を選んでから、その種類の音にします。', 'Pick the kind to add, then it becomes that kind’s sound.') + extra}</>;
  const what = useName(use);
  const head =
    count > 0
      ? tr(
          `${what} ${count} 個がこの音で鳴ります。弱く置いた所は、新しい音でも弱いまま（#VOLUME の違いを写す）。`,
          `${count} ${what} ${pl(count, 'chip')} will play this sound. Soft hits stay soft (the #VOLUME differences are kept).`,
        )
      : tr(`これから置く${what}の音になります。`, `It becomes the sound for ${what} chips you place from now on.`);
  const keep = now ? tr(`元の ${now} は WAV の一覧に残るので、いつでも戻せます。`, ` The old ${now} stays in the WAV list, so you can switch back.`) : tr('元の音は WAV の一覧に残ります（Ctrl+Z でも戻せます）。', ' The old sound stays in the WAV list (Ctrl+Z also undoes it).');
  return <>{head + keep + extra}</>;
}

/** 候補の ▶（その所から今の切り方で切った音） */
function CandPlay({ c, s, pcm, set, onPress }: { c: CutCand; s: CandSound | undefined; pcm: Pcm | null; set: CutSettings; onPress: () => void }) {
  const k = cutKey(`cand:${c.key}`);
  const on = useAudition((st) => st.key === k);
  return (
    <button
      type="button"
      className={`ib tiny cut-cand-play ${on ? 'on' : ''}`}
      disabled={!pcm || !s}
      onClick={(e) => {
        e.stopPropagation();
        onPress();
        void toggleAudition(k, () => {
          if (!pcm || !s) return null;
          const r = rangeOf(pcm, s, set);
          return auditionOf(cutPcm(pcm, r.start, r.end, set.shape));
        });
      }}
      aria-label={on ? tr(`${c.pos} を止める`, `Stop ${c.pos}`) : tr(`${c.pos} を聴く`, `Listen to ${c.pos}`)}
      title={on ? tr('止める', 'Stop') : tr('この所から切った音を聴く', 'Listen to the sound cut from here')}
    >
      {on ? Icon.stop(10) : Icon.play(10)}
    </button>
  );
}

/** ほかの音の混ざり（メーターと、確かめた点） */
function Mix({
  cur,
  s,
  orig,
  lowCut,
  result,
  stack,
  stackPicks,
  nextMs,
  hand,
}: {
  cur: CutCand;
  s: CandSound;
  orig: boolean;
  lowCut: boolean;
  result: Pcm | null;
  stack: ReturnType<typeof stackCut> | null;
  stackPicks: CutCand[];
  nextMs: number | null;
  hand: boolean;
}) {
  const checks: { ok: boolean; text: string }[] = [];
  let score = 0;
  const low = result ? Math.round(lowShareDb(result)) : 0;
  if (stack) {
    const gain = Math.round(stack.single - stack.stacked);
    checks.push({ ok: true, text: tr(`毎回は鳴っていない音（ハイハットの残りなど）は ${gain} dB 小さく`, `Sounds that aren't there every time (hi-hat tails…) are ${gain} dB quieter`) });
    if (stackPicks.some((c) => c.cls === 1)) checks.push({ ok: lowCut, text: lowCut ? tr(`バスドラムは低い音を弱めて ${low} dB`, `Bass drum reduced with the low cut: ${low} dB`) : tr('バスドラムと同時の所があります（「低い音を弱める」で減らせます）', 'Some places have the bass drum (use "Reduce low end")') });
    checks.push({ ok: false, text: tr('毎回いっしょに鳴る音は残ります（スネアと同時の所を選ぶと、スネアも入る）', 'Sounds that play every time stay (pick places with the snare and the snare stays too)') });
    if (stack.sim < 0.35) checks.push({ ok: false, text: tr('鳴り方が所ごとに違うので、重ねると音がぼやけます（1 か所がおすすめ）', 'The hits sound different from place to place, so stacking blurs them (one place is better)') });
    score = Math.max(0, (stack.stacked + 40) / 40) + (stack.sim < 0.35 ? 0.4 : 0) + (orig ? 0.3 : 0);
  } else {
    if (!s.onset.found) {
      checks.push({ ok: false, text: tr('鳴り始めが見つかりません（チップの時刻から切ります）', 'No onset found (cut from the chip time)') });
      score += 0.5;
    } else if (s.pre < -30) checks.push({ ok: true, text: tr(`鳴り始めの前は静か（${Math.round(s.pre)} dB）`, `Quiet before the onset (${Math.round(s.pre)} dB)`) });
    else {
      checks.push({ ok: false, text: tr(`鳴り始めの前にもほかの音（${Math.round(s.pre)} dB）`, `Other sounds before the onset too (${Math.round(s.pre)} dB)`) });
      score += s.pre > -20 ? 0.25 : 0.1;
    }
    if (cur.cls === 0) checks.push({ ok: true, text: tr('ほかのチップと重なっていない', 'No other chips at the same time') });
    else if (cur.cls === 1) {
      checks.push({ ok: lowCut, text: lowCut ? tr(`バスドラムと同時。低い音を弱めて ${low} dB`, `With the bass drum. Low cut brings it to ${low} dB`) : tr('バスドラムと同時（「低い音を弱める」で減らせます）', 'With the bass drum (use "Reduce low end")') });
      score += lowCut ? 0.12 : 0.3;
    } else {
      checks.push({ ok: false, text: tr(`${cur.over.map(voiceLabel).join('・')}と同時（その音も入ります）`, `With ${cur.over.map(voiceLabel).join(', ')} (their sound gets in too)`) });
      score += cur.cls === 2 ? 0.3 : 0.55;
    }
    if (nextMs === null) checks.push({ ok: true, text: tr('次の音はありません（長くても 1 秒）', 'No next sound (1 s at most)') });
    else if (hand) {
      checks.push({ ok: false, text: tr(`次の音（${nextMs} ms）より長く切っています（次の音も入ります）`, `Longer than the next sound (${nextMs} ms), so it gets in too`) });
      score += 0.2;
    } else if (nextMs < 80) {
      checks.push({ ok: false, text: tr(`次の音まで ${nextMs} ms（短めに切れます）`, `${nextMs} ms to the next sound (comes out short)`) });
      score += 0.1;
    } else checks.push({ ok: true, text: tr(`次の音まで ${nextMs} ms（その手前で止める）`, `${nextMs} ms to the next sound (stops before it)`) });
    if (orig) {
      checks.push({ ok: false, text: tr('原曲からなので、ベースや声も入ります', 'From the original, so bass and vocals get in too') });
      score += 0.3;
    }
  }
  const level = score < 0.15 ? 0 : score < 0.35 ? 1 : score < 0.6 ? 2 : 3;
  const names = [tr('とても少ない', 'Very little'), tr('少ない', 'Little'), tr('やや多い', 'Some'), tr('多い', 'A lot')];
  return (
    <div className="cut-mix">
      <div className="cut-colh">{tr('ほかの音の混ざり', 'Other sounds mixed in')}</div>
      <div className="cut-meter-row">
        <div className="cut-meter" aria-hidden="true">
          <i className={`l${level}`} style={{ width: `${Math.round(Math.max(0.08, 1 - Math.min(1, score)) * 100)}%` }} />
        </div>
        <b className={`cut-level l${level}`}>{names[level]}</b>
      </div>
      {checks.map((c, i) => (
        <span key={i} className={`cut-check ${c.ok ? 'ok' : 'warn'}`}>
          <span className="cut-check-ic">{c.ok ? '✓' : '△'}</span>
          {c.text}
        </span>
      ))}
    </div>
  );
}

// ---- 波形 ------------------------------------------------------------------------------------

/** canvas の幅に合わせて描く */
function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);
  // 高さも見る（スマホの横は、波形の高さが画面に合わせて変わる）
  const [hh, setHh] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setW(el.clientWidth);
      setHh(el.clientHeight);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || w <= 0) return;
    const h = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.floor(w * dpr);
    el.height = Math.floor(h * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, h);
  }, [w, hh, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/** 帯（上下の形）を描く：x の from〜to を cols 列で */
function band(ctx: CanvasRenderingContext2D, x: Float32Array, from: number, to: number, x0: number, x1: number, mid: number, half: number, scale: number) {
  const cols = Math.max(1, Math.round(x1 - x0));
  const { lo, hi } = minMax(x, from, to, cols);
  ctx.beginPath();
  ctx.moveTo(x0, mid);
  for (let i = 0; i < cols; i++) ctx.lineTo(x0 + i, mid - Math.min(half, Math.max(0.5, hi[i] * scale * half)));
  for (let i = cols - 1; i >= 0; i--) ctx.lineTo(x0 + i, mid + Math.min(half, Math.max(0.5, -lo[i] * scale * half)));
  ctx.closePath();
  ctx.fill();
}

const FONT = "11px 'IBM Plex Sans JP', system-ui, sans-serif";

function CutWave({
  p,
  start,
  end,
  head,
  next,
  nextName,
  shown,
  fadeMs,
  wide,
  onLen,
  shift,
  onShift,
}: {
  p: Pcm;
  start: number;
  end: number;
  head: number;
  next: number | null;
  nextName: string;
  shown: Pcm;
  fadeMs: number;
  wide: boolean;
  onLen: (ms: number) => void;
  /** 切り始めをずらした分（ms） */
  shift: number;
  onShift: (ms: number) => void;
}) {
  const sr = p.sr;
  // ずらす前の切り始め（左の線をドラッグしたら、ここからの ms にする）
  const base = start - msToSamples(sr, shift);
  // 見る所は、ずらす前の切り始めから（ドラッグの間に見る所が動かないように）
  const from = wide ? head - sr : Math.min(base, start) - msToSamples(sr, 40);
  const to = wide ? head + sr : Math.max(from + msToSamples(sr, 300), Math.max(end, next ?? 0) + msToSamples(sr, 80));
  const drag = useRef<'start' | 'end' | null>(null);
  const ref = useCanvas(
    (ctx, w, h) => {
      const xOf = (s: number) => ((s - from) / (to - from)) * w;
      ctx.fillStyle = '#0B0E13';
      ctx.fillRect(0, 0, w, h);
      const axisH = 18;
      const H = h - axisH;
      const nch = p.ch.length;
      const lane = H / nch;
      // 目盛り（鳴り始めから）
      const step = wide ? 250 : 100;
      ctx.font = FONT;
      ctx.textBaseline = 'alphabetic';
      // 切り始めの名前（次の音の名前と重なるときは、次の音の名前を 2 行目に）
      const startLabel = shift !== 0 ? tr(`切り始め ${shiftText(shift)}`, `Start ${shiftText(shift)}`) : tr('鳴り始め', 'Onset');
      const sx = xOf(start) + 6;
      const sw = ctx.measureText(startLabel).width;
      for (let t = Math.ceil(((from - head) / sr) * (1000 / step)) * step; t <= ((to - head) / sr) * 1000; t += step) {
        const x = xOf(head + msToSamples(sr, t));
        ctx.fillStyle = '#161B22';
        ctx.fillRect(Math.round(x), 0, 1, H);
        ctx.fillStyle = '#8B95A4';
        ctx.fillText(`${t > 0 ? '+' : ''}${t}ms`, x + 3, h - 5);
      }
      ctx.fillStyle = '#0F1318';
      ctx.fillRect(0, H, w, axisH);
      // 選んだ範囲
      ctx.fillStyle = 'rgba(76,194,255,0.07)';
      ctx.fillRect(xOf(start), 0, xOf(end) - xOf(start), H);
      // 大きさは見ている所のいちばん大きい所に合わせる
      let peak = 1e-6;
      for (const x of p.ch) for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) peak = Math.max(peak, Math.abs(x[i]));
      const scale = 0.95 / peak;
      p.ch.forEach((x, c) => {
        const mid = lane * c + lane / 2;
        ctx.fillStyle = '#1E242D';
        ctx.fillRect(0, Math.round(mid), w, 1);
        ctx.fillStyle = '#3B4554';
        band(ctx, x, from, to, 0, w, mid, lane / 2 - 4, scale);
        // 切った音（整えたもの。大きさは元のまま）
        const y = shown.ch[Math.min(c, shown.ch.length - 1)];
        const a = Math.max(0, xOf(start));
        const b = Math.min(w, xOf(end));
        if (b > a + 1) {
          ctx.fillStyle = '#4CC2FF';
          const s0 = Math.max(0, Math.round(((a / w) * (to - from) + from) - start));
          const s1 = Math.min(y.length, Math.round(((b / w) * (to - from) + from) - start));
          band(ctx, y, s0, s1, a, b, mid, lane / 2 - 4, scale);
        }
        ctx.fillStyle = '#8B95A4';
        if (nch > 1) ctx.fillText(c === 0 ? 'L' : 'R', 6, lane * c + 14);
      });
      // フェードの所
      const fx = xOf(end - msToSamples(sr, fadeMs));
      if (fadeMs > 0 && xOf(end) - fx > 2) {
        const g = ctx.createLinearGradient(fx, 0, xOf(end), 0);
        g.addColorStop(0, 'rgba(11,14,19,0)');
        g.addColorStop(1, 'rgba(11,14,19,0.55)');
        ctx.fillStyle = g;
        ctx.fillRect(fx, 0, xOf(end) - fx, H);
      }
      // 次の音
      if (next !== null && next >= from && next <= to) {
        const x = xOf(next);
        ctx.strokeStyle = '#FFD54F';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 16);
        ctx.lineTo(x + 0.5, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#FFD54F';
        const label = nextName ? tr(`次の音（${nextName}）`, `Next (${nextName})`) : tr('次の音', 'Next sound');
        const tw = ctx.measureText(label).width;
        const nx = x + 6 + tw > w ? x - tw - 6 : x + 6;
        ctx.fillText(label, nx, nx < sx + sw + 8 && nx + tw > sx - 4 ? 27 : 12);
      }
      // ずらしたときは、鳴り始め（ずらす前の所）を点線で
      if (shift !== 0 && head >= from && head <= to) {
        const x = xOf(head);
        ctx.strokeStyle = '#8B95A4';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 16);
        ctx.lineTo(x + 0.5, H);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 始めと終わり
      ctx.fillStyle = '#4CC2FF';
      ctx.fillRect(xOf(start), 0, 3, H);
      ctx.fillRect(xOf(end) - 3, 0, 3, H);
      ctx.fillText(startLabel, sx, 12);
      if (fadeMs > 0) {
        const label = tr(`フェード ${fadeMs} ms →`, `Fade ${fadeMs} ms →`);
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = '#A3ADBB';
        ctx.fillText(label, Math.max(xOf(start) + 70, xOf(end) - tw - 8), H - 8);
      }
    },
    [p, start, end, head, next, nextName, shown, fadeMs, wide, from, to, shift],
  );
  const sampleAt = (clientX: number, el: HTMLCanvasElement) => {
    const r = el.getBoundingClientRect();
    return from + ((clientX - r.left) / Math.max(1, r.width)) * (to - from);
  };
  const msAt = (clientX: number, el: HTMLCanvasElement) => Math.max(40, Math.min(1000, Math.round(((sampleAt(clientX, el) - start) / sr) * 1000 / 5) * 5));
  const shiftAt = (clientX: number, el: HTMLCanvasElement) => Math.max(-CUT_SHIFT_MAX_MS, Math.min(CUT_SHIFT_MAX_MS, Math.round(((sampleAt(clientX, el) - base) / sr) * 1000)));
  /** 押した所に近い線（左の切り始め・右の終わり）。どちらも遠ければ null */
  const lineAt = (clientX: number, el: HTMLCanvasElement): 'start' | 'end' | null => {
    const r = el.getBoundingClientRect();
    const xOf = (s: number) => ((s - from) / (to - from)) * r.width + r.left;
    const tol = useDevice.getState().tablet ? 16 : 7;
    const ds = Math.abs(clientX - xOf(start));
    const de = Math.abs(clientX - xOf(end));
    if (ds > tol && de > tol) return null;
    return ds < de ? 'start' : 'end';
  };
  return (
    <canvas
      ref={ref}
      className="cut-wave"
      role="img"
      aria-label={tr('切り出す所の波形。左の青い線をドラッグすると切り始め、右の青い線で長さを変えられます', 'Waveform of the cut. Drag the left blue line to move the start, the right one to change the length')}
      onPointerDown={(e) => {
        const line = lineAt(e.clientX, e.currentTarget);
        if (!line) return;
        drag.current = line;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current === 'end') onLen(msAt(e.clientX, e.currentTarget));
        else if (drag.current === 'start') onShift(shiftAt(e.clientX, e.currentTarget));
        else e.currentTarget.style.cursor = lineAt(e.clientX, e.currentTarget) ? 'ew-resize' : 'default';
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );
}

/** 全体の中のどこか（−0.4 秒〜＋1.2 秒） */
function Overview({ p, head, start, end }: { p: Pcm; head: number; start: number; end: number }) {
  const sr = p.sr;
  const from = head - msToSamples(sr, 400);
  const to = head + msToSamples(sr, 1200);
  const ref = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = '#0F1318';
      ctx.fillRect(0, 0, w, h);
      const x = downmix(slicePcm(p, from, to).ch);
      let peak = 1e-6;
      for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
      ctx.fillStyle = '#5B6B80';
      band(ctx, x, 0, x.length, 0, w, h / 2, h / 2 - 2, 1 / peak);
      const xOf = (s: number) => ((s - from) / (to - from)) * w;
      ctx.fillStyle = 'rgba(76,194,255,0.18)';
      ctx.fillRect(xOf(start), 1, xOf(end) - xOf(start), h - 2);
      ctx.strokeStyle = '#4CC2FF';
      ctx.strokeRect(xOf(start) + 0.5, 1.5, xOf(end) - xOf(start) - 1, h - 3);
    },
    [p, head, start, end],
  );
  return <canvas ref={ref} className="cut-over" aria-hidden="true" />;
}

/** 重ねた音：1 か所ずつ（薄く）と重ねた音（青） */
function StackWave({ parts, shifts, out, fadeMs }: { parts: Pcm[]; shifts: number[]; out: Pcm; fadeMs: number }) {
  const ref = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = '#0B0E13';
      ctx.fillRect(0, 0, w, h);
      const axisH = 18;
      const H = h - axisH;
      const len = pcmLength(out);
      if (!len) return;
      const sr = out.sr;
      const mid = H / 2;
      const y = downmix(out.ch);
      let peak = 1e-6;
      for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
      const scale = 0.95 / peak;
      ctx.font = FONT;
      for (let t = 0; t <= (len / sr) * 1000; t += 100) {
        const x = (msToSamples(sr, t) / len) * w;
        ctx.fillStyle = '#161B22';
        ctx.fillRect(Math.round(x), 0, 1, H);
        ctx.fillStyle = '#8B95A4';
        ctx.fillText(`${t > 0 ? '+' : ''}${t}ms`, x + 3, h - 5);
      }
      ctx.fillStyle = '#0F1318';
      ctx.fillRect(0, H, w, axisH);
      ctx.fillStyle = 'rgba(139,149,164,0.18)';
      parts.forEach((pt, i) => {
        const m = downmix(pt.ch);
        const sh = Math.max(0, shifts[i] ?? 0);
        band(ctx, m, sh, sh + len, 0, w, mid, H / 2 - 6, scale);
      });
      ctx.fillStyle = '#4CC2FF';
      band(ctx, y, 0, len, 0, w, mid, H / 2 - 6, scale);
      ctx.fillStyle = '#8B95A4';
      ctx.fillText(tr(`1 か所ずつ（${parts.length}）`, `Each place (${parts.length})`), 8, 14);
      ctx.fillStyle = '#4CC2FF';
      ctx.fillText(tr('重ねた音', 'Stacked'), 8, 30);
      if (fadeMs > 0) {
        ctx.fillStyle = '#A3ADBB';
        const label = tr(`フェード ${fadeMs} ms →`, `Fade ${fadeMs} ms →`);
        ctx.fillText(label, Math.max(80, w - ctx.measureText(label).width - 8), H - 8);
      }
    },
    [parts, shifts, out, fadeMs],
  );
  return <canvas ref={ref} className="cut-wave" role="img" aria-label={tr('重ねた音の波形', 'Waveform of the stacked sound')} />;
}
