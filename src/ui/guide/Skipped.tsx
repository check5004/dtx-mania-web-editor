// 難易度ガイドラインの「物差しに入れていない譜面」：わけごとの数と中身。エディタなので、このアプリで作った・直している譜面は
// 物差しにしない（楯さん 2026-11-14「無視すべき曲・難易度データに注意」）。手で戻せるものは戻せる。BOX ごとに入れる・入れないも選べる。
import { tr, pl } from '../../i18n';
import { useMemo, useState } from 'react';
import { SKIP_WHYS, type Ruler, type SkipWhy, type Skipped } from '../../guide/ruler';
import { boxCounts } from '../../nxlib/view';
import { setBoxOff, setExcluded, setIncluded, useGuideline, type ChartEntry } from '../../store/guideline';
import { useNxLib } from '../../nxlib/store';
import { Icon } from '../icons';

export function whyName(w: SkipWhy): string {
  switch (w) {
    case 'work':
      return tr('このエディタで直している譜面', 'Charts you work on in this editor');
    case 'ai':
      return tr('AI難易度生成で作った譜面', 'Charts made by the AI generator');
    case 'nolevel':
      return tr('レベルが書いていない譜面', 'Charts with no level');
    case 'nodrums':
      return tr('ドラムの譜面でない', 'Not drum charts');
    case 'dup':
      return tr('同じ曲がほかにもある', 'Same song elsewhere');
    case 'box':
      return tr('外した BOX の曲', 'Songs in BOXes you left out');
    case 'manual':
      return tr('手で外した譜面', 'Charts you left out by hand');
  }
}

function whyHelp(w: SkipWhy): string {
  switch (w) {
    case 'work':
      return tr(
        '作業ファイル（譜面の名前.dtxe.json）がある譜面。レベルは自分で付けたものなので入れません。仕上がった譜面は「入れる」で入れられます。',
        'Charts with a work file (chart name.dtxe.json). You set their levels yourself, so they are left out. Use “Count it” for a finished chart.',
      );
    case 'ai':
      return tr(
        '#DTXE_ORIGIN の印がある譜面。AI が作った譜面のレベルを、AI の手本にしないためです（手で直したあとも入れません）。',
        'Charts with the #DTXE_ORIGIN mark. AI-made levels are not used as examples for the AI (even after hand edits).',
      );
    case 'nolevel':
      return tr('#DLEVEL が無い・0 の譜面。物差しはレベルが分かる譜面だけで作ります。', 'Charts with no #DLEVEL (or 0). The ruler only uses charts with a known level.');
    case 'nodrums':
      return tr(
        'ドラムのチップが無い・とても少ない譜面と、.dtx でない譜面（ギター・ベースだけの譜面など）。',
        'Charts with no or very few drum chips, and charts that are not .dtx (guitar- or bass-only charts and so on).',
      );
    case 'dup':
      return tr('曲名とアーティストが同じ曲は、1 つだけ数えます（同じ譜面を二重に数えないため）。', 'Songs with the same title and artist are counted once (so the same chart is not counted twice).');
    case 'box':
      return tr('下の「BOX を選ぶ」で外した BOX の曲（練習用・ネタ曲の BOX など）。', 'Songs in BOXes you turned off under “Choose BOXes” (practice or joke BOXes, for example).');
    case 'manual':
      return tr('「レベルが外れていそうな譜面」などで外した譜面。「戻す」で物差しに戻ります。', 'Charts you left out, for example from “Levels that look off”. “Put back” returns them.');
  }
}

const SHOW = 40;

export function SkippedCard({ r, onSong }: { r: Ruler; onSong?: (songId: string) => void }) {
  const [open, setOpen] = useState<SkipWhy | null>(null);
  const [boxes, setBoxes] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<SkipWhy, Skipped[]>();
    for (const s of r.skipped) {
      const g = m.get(s.why);
      if (g) g.push(s);
      else m.set(s.why, [s]);
    }
    return m;
  }, [r.skipped]);
  // 入れたエディタの譜面（「入れない」に戻せるように、このエディタで直している譜面の中に出す）
  const included = useMemo(() => r.use.filter((c) => c.work && c.include), [r.use]);
  const total = r.skipped.length;
  return (
    <section className="gp-skip" id="gp-skip" aria-labelledby="gp-skip-h">
      <div className="row" style={{ gap: 6 }}>
        <h3 id="gp-skip-h">{tr('物差しに入れていない譜面', 'Charts not in the ruler')}</h3>
        <span className="grow" />
        <span className="lbl mono">{total.toLocaleString()}</span>
      </div>
      <p className="lbl gp-skip-lead">
        {tr('エディタなので、自分で作った・直している譜面や AI の譜面は物差しにしません。', 'This is an editor, so charts you made or are editing, and AI-made charts, are not used as the ruler.')}
      </p>
      <div className="gp-skip-list">
        {SKIP_WHYS.map((w) => {
          const g = groups.get(w) ?? [];
          const extra = w === 'work' ? included.length : 0;
          // BOX は、DTXMania の曲を使っているときはいつも出す（BOX を選べるように）
          if (g.length === 0 && extra === 0 && !(w === 'box' && r.nx)) return null;
          const on = open === w;
          return (
            <div key={w} className={`gp-skip-g ${on ? 'on' : ''}`}>
              <button className="gp-skip-row" onClick={() => setOpen(on ? null : w)} aria-expanded={on}>
                <span className={`gp-why ${w}`} />
                <span className="grow ellipsis">{whyName(w)}</span>
                <span className="mono">{g.length.toLocaleString()}</span>
                {on ? Icon.chevronUp(12) : Icon.chevronDown(12)}
              </button>
              {on && (
                <div className="gp-skip-in">
                  <p className="lbl">{whyHelp(w)}</p>
                  {w === 'box' && (
                    <button className="btn small" onClick={() => setBoxes((b) => !b)} aria-expanded={boxes}>
                      {Icon.box(13)} {tr('BOX を選ぶ', 'Choose BOXes')}
                    </button>
                  )}
                  {w === 'box' && boxes && <BoxPicker />}
                  {g.slice(0, SHOW).map((s) => (
                    <SkipItem key={s.key} s={s} onSong={onSong} />
                  ))}
                  {w === 'work' &&
                    included.map((c) => (
                      <div key={c.id} className="gp-skip-item">
                        <span className="grow ellipsis">
                          {c.song} <span className="lbl">{c.label}</span>
                        </span>
                        <span className="mono lbl">{c.level?.toFixed(2)}</span>
                        <span className="gp-in">{tr('入れた', 'Counted')}</span>
                        <button className="btn tiny" onClick={() => void setIncluded(c.id, false)}>
                          {tr('入れない', "Don't count")}
                        </button>
                      </div>
                    ))}
                  {g.length > SHOW && <div className="lbl">{tr(`ほか ${g.length - SHOW} 譜面`, `${g.length - SHOW} more`)}</div>}
                </div>
              )}
            </div>
          );
        })}
        {total === 0 && included.length === 0 && <div className="lbl">{tr('入れていない譜面はありません。', 'Every chart is counted.')}</div>}
      </div>
    </section>
  );
}

function SkipItem({ s, onSong }: { s: Skipped; onSong?: (songId: string) => void }) {
  const e: ChartEntry | undefined = s.entry;
  return (
    <div className="gp-skip-item">
      <span className="grow ellipsis" title={`${s.song} ${s.label}`}>
        {s.song || tr('曲名なし', 'Untitled')} <span className="lbl">{s.label}</span>
      </span>
      <span className="mono lbl">{s.level !== null && s.level > 0 ? s.level.toFixed(2) : '—'}</span>
      {s.why === 'work' && e && (
        <button className="btn tiny" onClick={() => void setIncluded(e.id, true)} title={tr('仕上がった譜面なら、物差しに入れる', 'Count it in the ruler if the chart is finished')}>
          {tr('入れる', 'Count it')}
        </button>
      )}
      {s.why === 'manual' && e && (
        <button className="btn tiny" onClick={() => void setExcluded(e.id, false)}>
          {tr('戻す', 'Put back')}
        </button>
      )}
      {s.songId && onSong && (
        <button className="ib tiny" onClick={() => onSong(s.songId!)} title={tr('曲の一覧でこの曲を見る', 'See this song in the song list')} aria-label={tr('曲の一覧でこの曲を見る', 'See this song in the song list')}>
          {Icon.chevronRight(12)}
        </button>
      )}
    </div>
  );
}

/** BOX ごとに物差しに入れる・入れない（DTXMania の曲） */
function BoxPicker() {
  const boxes = useNxLib((s) => s.boxes);
  const songs = useNxLib((s) => s.songs);
  const off = useGuideline((s) => s.settings.boxesOff);
  const counts = useMemo(() => boxCounts(songs), [songs]);
  const offSet = new Set(off);
  if (boxes.length === 0) return <div className="lbl">{tr('BOX がありません。', 'There are no BOXes.')}</div>;
  return (
    <div className="gp-boxes scroll" role="group" aria-label={tr('物差しに入れる BOX', 'BOXes in the ruler')}>
      {boxes.map((b) => {
        const on = !offSet.has(b.key);
        return (
          <label key={b.key} className="gp-box" style={{ paddingLeft: 6 + b.depth * 12 }}>
            <input type="checkbox" checked={on} onChange={() => setBoxOff(b.key, on)} />
            <span className="grow ellipsis">{b.title}</span>
            <span className="lbl mono">{tr(`${counts.get(b.key) ?? 0} 曲`, `${counts.get(b.key) ?? 0} ${pl(counts.get(b.key) ?? 0, 'song')}`)}</span>
          </label>
        );
      })}
    </div>
  );
}
