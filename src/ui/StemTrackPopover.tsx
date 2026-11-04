// ステムのトラックの名前と種類を変える小窓。下のトラック・ステムの画面の ✎（名前のダブルクリック・右クリックでも）から開く。
import { tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { STEM_KINDS, stemKindInfo } from '../audio/stems';
import { useSidecar } from '../store/sidecar';
import { renameStem, setStemKind, stemGuessFromFile } from '../store/stems';

const W = 304;
/** 小窓の高さの目安（下に入らなければ上に出す） */
const H_EST = 240;

/** anchor: 開いたトラックの見出しの位置 */
export function StemTrackPopover({ file, anchor, onClose }: { file: string; anchor: DOMRect; onClose: () => void }) {
  const t = useSidecar((s) => s.stems.find((x) => x.file === file) ?? null);
  const [name, setName] = useState(t?.name ?? '');
  const typed = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ name, onClose });
  latest.current = { name, onClose };

  // 種類を変えて名前が変わったら、まだ打っていなければ欄も合わせる
  const current = t?.name ?? '';
  useEffect(() => {
    if (!typed.current) setName(current);
  }, [current]);

  /** 打った名前を決める（決定・Enter・外をクリック） */
  const commit = () => {
    if (typed.current && latest.current.name.trim()) renameStem(file, latest.current.name);
    typed.current = false;
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        commitRef.current();
        latest.current.onClose();
      }
    };
    // Esc は打った名前を捨てて閉じる（ステムの画面の「Esc で戻る」より先に受ける）
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current.onClose();
    };
    // 開いたクリックで閉じないように少し待つ
    const tm = window.setTimeout(() => window.addEventListener('pointerdown', away, true), 0);
    window.addEventListener('keydown', key, true);
    return () => {
      window.clearTimeout(tm);
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);

  if (!t) return null;
  const info = stemKindInfo(t.kind);
  const guess = stemGuessFromFile(file);
  const showGuess = !!guess && (guess.name !== t.name || guess.kind !== t.kind);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8));
  const pos = anchor.bottom + 4 + H_EST <= window.innerHeight ? { top: anchor.bottom + 4 } : { bottom: Math.max(8, window.innerHeight - anchor.top + 4) };

  return createPortal(
    <div
      ref={ref}
      className="popover stem-pop"
      style={{ position: 'fixed', left, width: W, ...pos }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={tr('トラックの名前と種類', 'Track name and type')}
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <b>{tr('トラックの名前と種類', 'Track name and type')}</b>
        <span className="grow" />
        <button className="ib" style={{ width: 24, height: 24 }} onClick={onClose} aria-label={tr('閉じる', 'Close')} title={tr('閉じる（Esc）', 'Close (Esc)')}>
          ✕
        </button>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
          onClose();
        }}
      >
        <span className="dot" style={{ background: info.color, width: 10, height: 10, flex: 'none' }} />
        <input
          ref={input}
          className="field"
          style={{ height: 28 }}
          value={name}
          maxLength={40}
          placeholder={tr('名前（例: ドラム）', 'Name (e.g. Drums)')}
          aria-label={tr('トラックの名前', 'Track name')}
          onChange={(e) => {
            typed.current = true;
            setName(e.target.value);
          }}
        />
        <button className="btn small primary" type="submit" disabled={!name.trim()}>
          {tr('決定', 'OK')}
        </button>
      </form>
      <div className="lbl" style={{ margin: '10px 0 5px' }}>
        {tr('種類', 'Type')}
      </div>
      <div className="chip-wrap">
        {STEM_KINDS.map((k) => (
          <button
            key={k.kind}
            className={`tag ${t.kind === k.kind ? 'on' : ''}`}
            style={{ ['--c' as string]: k.color }}
            aria-pressed={t.kind === k.kind}
            onClick={() => setStemKind(file, k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
        {tr(
          '種類は色と、聞こえ方（ゲームと同じ・ドラムだけ）、BGM用（ドラム抜き）の書き出しに使います。ドラムの音が入ったトラックは「ドラム」にしてください。',
          'The type sets the color, the listening modes (Like the game, Drums only), and the BGM export (without drums). Set any track that contains the drums to “Drums”.',
        )}
      </p>
      <div className="stem-pop-file">
        <span className="mono ellipsis" title={t.file}>
          {t.file.replace(/^stems\//, '')}
        </span>
        {showGuess && (
          <button
            className="link-btn"
            title={tr('ファイル名から種類と名前を決め直す', 'Set the type and name again from the file name')}
            onClick={() => {
              setStemKind(file, guess.kind);
              renameStem(file, guess.name);
              typed.current = false;
            }}
          >
            {tr('ファイル名から付け直す（', 'Reset from file name (')}
            {guess.name}
            {guess.kind !== t.kind ? ` · ${stemKindInfo(guess.kind).label}` : ''}
            {tr('）', ')')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
