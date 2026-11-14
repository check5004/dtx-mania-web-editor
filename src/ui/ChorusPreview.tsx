// 曲情報の「プレビュー音（#PREVIEW）」の下：今の試聴を聴く ▶ と「サビから作る」。
// サビを探して（src/store/chorus.ts）候補と曲の部分を見せ、選んだ所を試し聴きして、切り出したファイルを試聴にする。
import { useEffect, useMemo, useState } from 'react';
import type { ChorusPick } from '../audio/chorus';
import { toMeasure } from '../dtx/base36';
import { tr } from '../i18n';
import { toggleAudition, useAudition, useStopAuditionOnClose } from '../store/audition';
import {
  barLength,
  barRange,
  CHORUS_PREVIEW_FILE,
  defaultBarCount,
  drumlessOnlyText,
  fallbackBar,
  fileHasDrums,
  findSongChorus,
  makeChorusPreview,
  renderChorusClip,
  useChorus,
  type ChorusRange,
  type SongChorus,
} from '../store/chorus';
import { fileBuffer, useEditor } from '../store/editor';
import { isDrumlessName } from '../separate/names';
import { useStems } from '../store/stems';
import { AuditionProgress } from './Audition';
import { Icon } from './icons';

const fmt = (sec: number) => {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** 今の試聴を聴く ▶ と「サビから作る」 */
export function PreviewTools({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const k = `pv:${value}`;
  const on = useAudition((s) => s.key === k);
  // ドラム抜きの音を試聴にしていたら知らせる（選曲画面でドラムが鳴らない）。名前（曲_drumless.ogg など）で分からなくても、
  // ステムがあれば音で比べる（前の版で、原曲の名前のまま書き出したドラム抜き・ドラム抜きから作った試聴）
  const [heard, setHeard] = useState<{ value: string; drums: boolean | null } | null>(null);
  const stemsVersion = useStems((s) => s.version);
  const v = value.trim();
  useEffect(() => {
    if (!v || isDrumlessName(v)) return;
    let live = true;
    void fileHasDrums(v).then((drums) => {
      if (live) setHeard({ value: v, drums });
    });
    return () => {
      live = false;
    };
  }, [v, stemsVersion]);
  const drumless = !!v && (isDrumlessName(v) || (heard?.value === v && heard.drums === false));
  return (
    <>
      {drumless && (
        <div className="lbl chorus-warn">
          {Icon.warn(11)}{' '}
          {tr(
            '今の試聴はドラム抜きの音なので、選曲画面でドラムが鳴りません。「サビから作る…」で、ドラムも入った曲の音から作り直せます。',
            "The current preview has no drums, so the song select screen plays it without drums. Use \"Make from the chorus…\" to remake it from the song audio with drums.",
          )}
        </div>
      )}
      <div className="row pv-tools">
        {value && (
          <button
            type="button"
            className={`btn small ghost aud-btn ${on ? 'on' : ''}`}
            onClick={() =>
              void toggleAudition(k, async () => {
                const buf = await fileBuffer(value);
                return buf ? { buf } : null;
              })
            }
            title={tr('今の試聴を聴く（選曲画面ではこれが頭から繰り返し鳴ります）', 'Play the current preview (the song select screen loops it from the start)')}
          >
            {on ? Icon.stop(11) : Icon.play(11)} {on ? tr('止める', 'Stop') : tr('聴く', 'Play')}
          </button>
        )}
        <button
          type="button"
          className={`btn small ${open ? 'on' : ''}`}
          aria-expanded={open}
          onClick={() => {
            if (!open) void findSongChorus();
            setOpen(!open);
          }}
          title={tr('曲のサビを探して、そこを切り出した試聴を作ります', 'Find the chorus of the song and make a preview cut from it')}
        >
          {Icon.sparkle(12)} {tr('サビから作る…', 'Make from the chorus…')}
        </button>
      </div>
      {open && <ChorusPanel onClose={() => setOpen(false)} />}
    </>
  );
}

interface Sel {
  /** found.bars の番号 */
  bar: number;
  /** 小節の数 */
  n: number;
}

const kindLabel = (k: SongChorus['audio']['kind']) =>
  ({
    full: tr('完全な原曲', 'full original'),
    chart: tr('BGM と長い SE をゲームと同じに足した音', 'BGM plus long SE sounds, as the game plays them'),
    stems: tr('ステムを全部足した音', 'all stems mixed'),
    bgmStems: tr('ドラム抜きの BGM とドラムのステムを足した音', 'the BGM without drums plus the drum stems'),
    game: tr('BGM に譜面のドラムの音をゲームと同じに足した音', "the BGM plus the chart's drum sounds, as the game plays them"),
    bgm: tr('ドラム抜きの原曲', 'original without drums'),
  })[k];

/** 曲の部分の色（サビの印は青。ほかは出てきた順に） */
const PART_COLORS = ['#3b4656', '#6b5b95', '#4f7a5a', '#8a6a3f', '#6f4e5f', '#3f6f7a', '#7a7a45', '#5a5f8a'];

function ChorusPanel({ onClose }: { onClose: () => void }) {
  const st = useChorus();
  const doc = useEditor((s) => s.doc);
  const found = st.status === 'ready' ? st.found : null;
  // ドラム抜きの音しか無い：探して聴けるが、試聴にはしない
  const blocked = found?.audio.kind === 'bgm';
  const [sel, setSel] = useState<Sel | null>(null);
  const [made, setMade] = useState<string | null>(null);
  useStopAuditionOnClose('chorus:');
  // テンポ・原曲が変わったら探し直す（同じなら前の答えのまま）
  useEffect(() => {
    void findSongChorus();
  }, [doc]);
  // 見つかったら、サビの頭から約 15 秒（4 小節単位）
  useEffect(() => {
    if (!found || !found.bars.length) {
      setSel(null);
      return;
    }
    const bar = found.best ? found.best.bar : fallbackBar(found);
    setSel({ bar, n: defaultBarCount(found, bar) });
  }, [found]);
  const range: ChorusRange | null = useMemo(() => {
    if (!found) return null;
    if (sel && found.bars.length) return barRange(found, sel.bar, sel.n);
    const start = found.best?.start ?? Math.max(20, found.duration * 0.3);
    return { start, end: Math.min(found.duration, start + 15) };
  }, [found, sel]);
  const off = found?.audio.offset ?? 0;
  const auditionKey = range ? `chorus:${range.start.toFixed(3)}:${range.end.toFixed(3)}` : 'chorus:';
  const playing = useAudition((s) => s.key === auditionKey);
  const firstBar = found ? Math.max(0, found.bars.findIndex((t) => t >= 0)) : 0;
  const choose = (p: ChorusPick) => found && found.bars.length && setSel({ bar: p.bar, n: sel?.n ?? defaultBarCount(found, p.bar) });
  const pickAt = (t: number) => {
    if (!found || !found.bars.length) return;
    let best = firstBar;
    found.bars.forEach((b, i) => {
      if (b >= 0 && Math.abs(b - t) < Math.abs(found.bars[best] - t)) best = i;
    });
    setSel({ bar: best, n: sel?.n ?? defaultBarCount(found, best) });
  };
  const where = (p: { start: number; bar: number }) => (found?.grid === 'chart' && p.bar < 3600 ? tr(`小節 ${toMeasure(p.bar)} · ${fmt(p.start + off)}`, `Measure ${toMeasure(p.bar)} · ${fmt(p.start + off)}`) : fmt(p.start + off));
  // 部分に、出てきた順の文字（A, B, C…）と色を付ける
  const letters = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of found?.parts ?? []) if (!m.has(p.label)) m.set(p.label, m.size);
    return m;
  }, [found]);
  const cands: { key: string; label: string; pick: ChorusPick }[] = found
    ? [
        ...(found.best ? [{ key: 'best', label: tr('サビ', 'Chorus'), pick: found.best }] : []),
        ...found.repeats.slice(0, 3).map((p, i) => ({ key: `rep${i}`, label: tr(`サビ（${i + 2}回目）`, `Chorus (#${i + 2})`), pick: p })),
        ...found.others.map((p, i) => ({ key: `oth${i}`, label: tr('ほかの候補', 'Another candidate'), pick: p })),
      ]
    : [];
  const nOptions = found && sel ? [4, 8, 12, 16].map((n) => ({ n, sec: n * barLength(found, sel.bar) })) : [];
  return (
    <div className="chorus-panel" role="region" aria-label={tr('サビから試聴を作る', 'Make a preview from the chorus')}>
      <div className="row chorus-head">
        <b className="grow">{tr('サビから試聴を作る', 'Make a preview from the chorus')}</b>
        <button type="button" className="ib" onClick={onClose} title={tr('閉じる', 'Close')} aria-label={tr('閉じる', 'Close')}>
          {Icon.close(12)}
        </button>
      </div>
      <p className="lbl chorus-note">
        {tr(
          `DTXMania は試聴のファイルを頭から繰り返し鳴らすだけなので、選んだ所を切り出したファイル（${CHORUS_PREVIEW_FILE}）を作って #PREVIEW に入れます。`,
          `DTXMania just loops the preview file from its start, so this cuts the part you choose into a file (${CHORUS_PREVIEW_FILE}) and sets it as #PREVIEW.`,
        )}
      </p>
      {st.status === 'loading' && (
        <div className="chorus-loading" aria-live="polite">
          <div className="progress">
            <div style={{ width: `${Math.round(st.progress * 100)}%` }} />
          </div>
          <span className="lbl">{st.step || tr('サビを探しています…', 'Finding the chorus…')}</span>
        </div>
      )}
      {st.status === 'error' && (
        <div className="row chorus-error">
          <span className="grow">{st.error}</span>
          <button type="button" className="btn small" onClick={() => void findSongChorus({ force: true })}>
            {Icon.refresh(11)} {tr('もう一度', 'Retry')}
          </button>
        </div>
      )}
      {found && range && (
        <>
          <div className="lbl chorus-src">
            {tr('曲の音：', 'Song audio: ')}
            <span className="ellipsis" title={found.audio.label}>
              {found.audio.label}
            </span>
            {tr(`（${kindLabel(found.audio.kind)}）`, ` (${kindLabel(found.audio.kind)})`)}
          </div>
          {blocked && (
            <div className="lbl chorus-warn">
              {Icon.warn(11)} {drumlessOnlyText()}
            </div>
          )}
          {found.audio.maybeDrumless && (
            <div className="lbl chorus-warn">
              {Icon.info(11)}{' '}
              {tr(
                `${found.audio.label} は、DTXMania の曲ではドラム抜きの BGM によく付ける名前です。ドラムが入っていなければ、完全な原曲（ドラム入り）かステムを読み込んでから作ってください。`,
                `${found.audio.label} is a name DTXMania songs often use for a BGM without drums. If it has no drums, load the full original (with drums) or the stems first.`,
              )}
            </div>
          )}
          {found.grid === 'audio' && (
            <div className="lbl chorus-warn">
              {Icon.info(11)}{' '}
              {tr(
                '譜面の小節線が曲の音に合っていないので、小節は曲の音から推定しました（テンポを合わせると正確になります）。',
                "The chart's bar lines don't match the song audio, so the bars were estimated from the audio (set the tempo for better results).",
              )}
            </div>
          )}
          {!found.best && (
            <div className="lbl chorus-warn">
              {Icon.warn(11)} {tr('サビがはっきりしませんでした。前奏の後の所にしています。下の帯から選べます。', "The chorus wasn't clear, so the part after the intro is selected. Pick another part on the strip below.")}
            </div>
          )}
          <div
            className="chorus-strip"
            title={tr('曲の部分（同じに聞こえる所は同じ文字。青がサビ）。押すとそこから', 'Song sections (same letter = sounds the same, blue = chorus). Click to start there')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              pickAt(((e.clientX - r.left) / Math.max(1, r.width)) * found.duration);
            }}
          >
            {found.parts.map((p, i) => {
              const li = letters.get(p.label) ?? 0;
              return (
                <span
                  key={i}
                  className={`chorus-part ${p.chorus ? 'chorus' : ''}`}
                  style={{ left: `${(p.start / found.duration) * 100}%`, width: `${((p.end - p.start) / found.duration) * 100}%`, background: p.chorus ? undefined : PART_COLORS[li % PART_COLORS.length] }}
                >
                  {String.fromCharCode(65 + (li % 26))}
                </span>
              );
            })}
            <span className="chorus-sel" style={{ left: `${(range.start / found.duration) * 100}%`, width: `${((range.end - range.start) / found.duration) * 100}%` }} />
          </div>
          {cands.length > 0 && (
            <div className="chorus-cands">
              {cands.map((c) => {
                const on = sel?.bar === c.pick.bar;
                return (
                  <button key={c.key} type="button" className={`btn small chorus-cand ${on ? 'on' : ''} ${c.key === 'best' ? 'best' : ''}`} aria-pressed={on} onClick={() => choose(c.pick)}>
                    <span>{c.label}</span>
                    <span className="mono lbl">{where(c.pick)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {sel && found.bars.length > 0 && (
            <div className="row chorus-adjust">
              <span className="seg small">
                <button type="button" disabled={sel.bar <= firstBar} onClick={() => setSel({ ...sel, bar: Math.max(firstBar, sel.bar - 1) })} title={tr('1 小節前から', 'Start one bar earlier')}>
                  {Icon.chevronLeft(11)} {tr('1小節', '1 bar')}
                </button>
                <button type="button" disabled={sel.bar >= found.bars.length - 2} onClick={() => setSel({ ...sel, bar: Math.min(found.bars.length - 2, sel.bar + 1) })} title={tr('1 小節あとから', 'Start one bar later')}>
                  {tr('1小節', '1 bar')} {Icon.chevronRight(11)}
                </button>
              </span>
              <span className="seg small" role="group" aria-label={tr('長さ', 'Length')}>
                {nOptions.map((o) => (
                  <button key={o.n} type="button" className={sel.n === o.n ? 'on' : ''} onClick={() => setSel({ ...sel, n: o.n })} title={tr(`${o.n} 小節（約 ${Math.round(o.sec)} 秒）`, `${o.n} bars (about ${Math.round(o.sec)} s)`)}>
                    {tr(`${o.n}小節`, `${o.n} bars`)}
                  </button>
                ))}
              </span>
            </div>
          )}
          <div className="lbl mono chorus-range">
            {found.grid === 'chart' && sel ? tr(`小節 ${toMeasure(Math.min(3599, sel.bar))} から `, `From measure ${toMeasure(Math.min(3599, sel.bar))}: `) : ''}
            {fmt(range.start + off)}〜{fmt(range.end + off)}
            {tr(`（${(range.end - range.start).toFixed(1)} 秒・終わりはフェードアウト）`, ` (${(range.end - range.start).toFixed(1)} s, fades out at the end)`)}
          </div>
          <div className="row chorus-actions">
            <button
              type="button"
              className={`btn small aud-btn ${playing ? 'on' : ''}`}
              style={{ position: 'relative' }}
              onClick={() =>
                void toggleAudition(auditionKey, async () => {
                  try {
                    return { buf: await renderChorusClip(range, undefined, { listen: true }) };
                  } catch {
                    return null;
                  }
                })
              }
            >
              {playing ? Icon.stop(11) : Icon.play(11)} {playing ? tr('止める', 'Stop') : tr('試し聴き', 'Listen')}
              <AuditionProgress k={auditionKey} />
            </button>
            <button
              type="button"
              className="btn small primary"
              disabled={st.making || blocked}
              onClick={() =>
                void makeChorusPreview(range).then((r) => {
                  if (r) setMade(r.file);
                })
              }
              title={tr('選んだ所を切り出して試聴のファイルを作り、#PREVIEW に入れます（同じ試聴だったほかの難易度にも）', 'Cut the chosen part into a preview file and set it as #PREVIEW (also in other difficulties that had the same preview)')}
            >
              {st.making ? tr('作っています…', 'Making…') : tr('ここを試聴にする', 'Use this as the preview')}
            </button>
            {made && !st.making && <span className="reflect-chip ok">{tr(`✓ ${made} を試聴にしました`, `✓ ${made} is now the preview`)}</span>}
          </div>
        </>
      )}
    </div>
  );
}
