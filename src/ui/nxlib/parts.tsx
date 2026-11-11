// 「DTXMania の曲」の画面で使う小さな部品（難易度の枠・小さい画像・点検の名前・日時）。
import { tr, locale } from '../../i18n';
import type { LibCheck, LibSong, SlotKey } from '../../nxlib/scan';
import { SLOT_KEYS, checkLevel } from '../../nxlib/scan';
import { addableSlots, chartIn, levelText, warnCount } from '../../nxlib/view';
import { Icon } from '../icons';

export const SLOT_CLASS: Record<SlotKey, string> = { BSC: 'bsc', ADV: 'adv', EXT: 'ext', MAS: 'mas' };
export const SLOT_COLOR: Record<SlotKey, string> = { BSC: '#8dbbff', ADV: '#ffc768', EXT: '#ff8e98', MAS: '#c9a9ff' };

/** 更新の日時（今日 21:32・昨日 23:40・11/09・2024/11/09） */
export function updText(t: number): string {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const hm = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return tr(`今日 ${hm}`, `Today ${hm}`);
  if (diff === 1) return tr(`昨日 ${hm}`, `Yesterday ${hm}`);
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(locale(), { month: '2-digit', day: '2-digit' });
  return d.toLocaleDateString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 点検の短い名前（一覧の印） */
export function checkLabel(c: LibCheck): string {
  switch (c.kind) {
    case 'nosetdef':
      return tr('set.def なし', 'No set.def');
    case 'setdef-missing':
      return tr(`譜面が見つからない ${c.n ?? 1}`, `${c.n ?? 1} ${c.n === 1 || !c.n ? 'chart' : 'charts'} missing`);
    case 'missing':
      return tr(`見つからない ${c.n ?? 1}`, `${c.n ?? 1} missing`);
    case 'badname':
      return tr(`読めない名前 ${c.n ?? 1}`, `${c.n ?? 1} unreadable ${c.n === 1 ? 'name' : 'names'}`);
    case 'dup':
      return tr(`同じ曲がもう ${c.n ?? 1} つ`, `${c.n ?? 1} more of the same song`);
    case 'nopreview':
      return tr('試聴なし', 'No preview');
    case 'noimage':
      return tr('画像なし', 'No image');
    case 'nodrums':
      return tr('ドラムなし', 'No drums');
  }
}

export interface Pill {
  k: 'edit' | 'ai' | 'drive' | 'draft' | 'warn' | 'info';
  label: string;
  title?: string;
}

/** 一覧の行の印。issues なら点検を 1 つずつ（「点検のある曲」でしぼりこんだとき） */
export function songPills(s: LibSong, draft: boolean, issues: boolean): Pill[] {
  if (issues) return s.checks.map((c) => ({ k: checkLevel(c.kind) === 'warn' ? 'warn' : 'info', label: checkLabel(c) }));
  const out: Pill[] = [];
  if (s.edited) out.push({ k: 'edit', label: tr('エディタ', 'Editor'), title: tr('このアプリで直した（作業ファイルがある）', 'Edited in this app (has a work file)') });
  if (s.charts.some((c) => c.head.ai)) out.push({ k: 'ai', label: 'AI', title: tr('AI難易度生成で作った難易度がある', 'Has a difficulty made by the AI generator') });
  if (s.drive?.state === 'linked') out.push({ k: 'drive', label: 'Drive', title: tr('Google Drive にも保存している', 'Also saved on Google Drive') });
  if (draft) out.push({ k: 'draft', label: tr('未保存', 'Unsaved'), title: tr('保存していない続きがある', 'Has unsaved changes') });
  const w = warnCount(s);
  if (w) out.push({ k: 'warn', label: tr(`点検 ${w}`, `${w} ${w === 1 ? 'issue' : 'issues'}`) });
  else {
    const info = s.checks.find((c) => c.kind === 'nodrums') ?? s.checks.find((c) => c.kind === 'noimage');
    if (info) out.push({ k: 'info', label: checkLabel(info) });
  }
  return out;
}

/** 一覧の行の小さい画像（無ければ曲名の 1 文字目） */
export function Thumb({ s, url, className = 'nx-thumb' }: { s: LibSong; url?: string; className?: string }) {
  return <span className={className}>{url && s.image ? <img src={url} alt="" draggable={false} /> : <span className="nx-ph">{[...(s.title || '?')][0]}</span>}</span>;
}

/**
 * 難易度の 4 つの枠。押すとその難易度を開く。空いた枠の ＋（いちばん上の譜面より下だけ）は AI難易度生成。
 * small はホームのカードの小さい枠
 */
export function SlotChips({ s, onOpen, onAdd, small }: { s: LibSong; onOpen?: (k: SlotKey) => void; onAdd?: (k: SlotKey) => void; small?: boolean }) {
  const add = new Set(addableSlots(s));
  return (
    <span className={`nx-chips ${small ? 'small' : ''}`}>
      {SLOT_KEYS.map((k) => {
        const c = chartIn(s, k);
        const lab = k;
        if (c && small) {
          return (
            <span key={k} className={`nx-dc ${SLOT_CLASS[k]}`}>
              <span className="t">{lab}</span>
              <span className="v">{levelText(c.head.level)}</span>
            </span>
          );
        }
        if (c) {
          const t = tr(`${c.label || lab} ${levelText(c.head.level)} を開く（${c.file}）`, `Open ${c.label || lab} ${levelText(c.head.level)} (${c.file})`);
          return (
            <button
              key={k}
              type="button"
              className={`nx-dc ${SLOT_CLASS[k]}`}
              title={t}
              aria-label={t}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onOpen?.(k);
              }}
            >
              <span className="t">{lab}</span>
              <span className="v">{levelText(c.head.level)}</span>
              {c.head.ai && <span className="spark">{Icon.sparkle(9)}</span>}
            </button>
          );
        }
        if (add.has(k) && small) {
          return (
            <span key={k} className="nx-dc add">
              <span className="t">{lab}</span>
              {Icon.plus(10)}
            </span>
          );
        }
        if (add.has(k)) {
          const t = tr(`${lab} を AI難易度生成で作る`, `Make ${lab} with the AI generator`);
          return (
            <button
              key={k}
              type="button"
              className="nx-dc add"
              title={t}
              aria-label={t}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onAdd?.(k);
              }}
            >
              <span className="t">{lab}</span>
              {Icon.plus(12)}
            </button>
          );
        }
        return (
          <span key={k} className="nx-dc none" aria-hidden="true">
            <span className="t">{lab}</span>
            <span className="v">—</span>
          </span>
        );
      })}
    </span>
  );
}
