// 「キーが要ります」：キーが無いときの AI のボタン（薄く・鍵の印・押すと説明）と、その説明の吹き出し。
// 吹き出しは押したボタンの近く（スマホは下からのシート）に出し、AI を使う準備（案内）へつなぐ。
import { tr } from '../../i18n';
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { aiFeature, costText, type AiFeatureId } from '../../ai/features';
import { taskCostEstimate, useHasAiKey } from '../../store/ai';
import { closeKeyGate, openAiGuide, openKeyGate, useKeyGate } from '../../store/aiGuide';
import { useDevice } from '../../store/device';
import { Icon } from '../icons';
import './aiGuide.css';

/** キーが無くて押せない AI のボタンにかざしたときの説明 */
export const lockedTitle = () => tr('OpenRouter のキーが要ります（押すと説明）', 'Needs an OpenRouter key (click for details)');

/** 鍵の印 */
export function KeyMark({ size = 11 }: { size?: number }) {
  return (
    <span className="nk-key" aria-hidden="true">
      {Icon.key(size)}
    </span>
  );
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  feature: AiFeatureId;
  onClick: () => void;
  children: ReactNode;
  /** 鍵の印の大きさ */
  keySize?: number;
};

/**
 * AI に頼むボタン。キーがあればふつうのボタン、無ければ薄くして鍵の印を付け、押すと「キーが要ります」の説明を出す
 * （押せないボタンにすると、指の端末ではわけが分からないので、押せるままにする）。
 */
export function AiButton({ feature, onClick, children, className = '', title, disabled, keySize, ...rest }: ButtonProps) {
  const hasKey = useHasAiKey();
  if (hasKey)
    return (
      <button {...rest} className={className} title={title} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  return (
    // 押すと説明が開くので、aria-disabled にはしない（読み上げでは「キーが要ります」の説明つきのボタン）
    <button {...rest} className={`${className} needs-key`} aria-haspopup="dialog" title={lockedTitle()} onClick={(e) => openKeyGate(feature, e.currentTarget)}>
      {children}
      <KeyMark size={keySize} />
    </button>
  );
}

/** 「AI を使うには」のリンク（キーが無いときの説明の文の後ろに置く）。押すと説明の吹き出し */
export function KeyGateLink({ feature, label }: { feature: AiFeatureId; label?: string }) {
  return (
    <button className="link-btn nk-link" onClick={(e) => openKeyGate(feature, e.currentTarget)}>
      <KeyMark />
      {label ?? tr('AI を使うには', 'How to use AI')}
    </button>
  );
}

/** 「キーが要ります」の吹き出し（App に 1 つ置く） */
export function KeyGateHost() {
  const feature = useKeyGate((s) => s.feature);
  const rect = useKeyGate((s) => s.rect);
  const hasKey = useHasAiKey();
  const phone = useDevice((s) => s.phone);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number; above: boolean } | null>(null);

  // キーが入ったら閉じる（案内でキーを入れたとき）
  useEffect(() => {
    if (hasKey) closeKeyGate();
  }, [hasKey]);

  // 押したボタンの下（入らなければ上）に、画面からはみ出さないように置く
  useLayoutEffect(() => {
    const el = ref.current;
    if (!feature || !el || phone) return setPos(null);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!rect) return setPos({ left: (vw - w) / 2, top: Math.max(12, (vh - h) / 2), arrow: -1, above: false });
    const cx = rect.left + rect.width / 2;
    const left = Math.max(10, Math.min(vw - w - 10, cx - w / 2));
    const below = rect.top + rect.height + 10;
    const above = below + h > vh - 10 && rect.top - 10 - h > 10;
    const top = above ? rect.top - 10 - h : Math.max(10, Math.min(vh - h - 10, below));
    setPos({ left, top, arrow: Math.max(16, Math.min(w - 16, cx - left)), above });
  }, [feature, rect, phone]);

  // 外を押す・Esc・画面の大きさが変わる・後ろが動く（押したボタンから離れる）と閉じる
  useEffect(() => {
    if (!feature) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeKeyGate();
    };
    const scroll = (e: Event) => {
      if (!phone && ref.current && !ref.current.contains(e.target as Node)) closeKeyGate();
    };
    // スマホの下からのシートは、アドレスバーの出入り（resize）では閉じない
    const resize = () => !phone && closeKeyGate();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeKeyGate();
      }
    };
    // 開いたときの押下（同じ押下）で閉じないよう、次の回から聞く
    const t = window.setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [feature, phone]);

  if (!feature) return null;
  const f = aiFeature(feature);
  const cost = taskCostEstimate(f.task);
  const body = (
    <>
      <div className="kg-head">
        <span className="kg-icon">{Icon.key(15)}</span>
        <b className="grow">{tr('OpenRouter のキーが要ります', 'Needs an OpenRouter key')}</b>
        <button className="ib tiny" onClick={closeKeyGate} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
          {Icon.close(13)}
        </button>
      </div>
      <div className="kg-feat">
        <span className="ai-spark">{Icon.sparkle(12)}</span>
        <b>{f.locked}</b>
      </div>
      <p className="kg-does">{f.withKey}</p>
      <dl className="kg-dl">
        {f.withoutKey && (
          <>
            <dt>{tr('キーが無くても', 'Without a key')}</dt>
            <dd>{f.withoutKey}</dd>
          </>
        )}
        <dt>{tr('1 回の目安', 'Per use')}</dt>
        <dd className="mono-num">{costText(cost)}</dd>
      </dl>
      <div className="kg-actions">
        <button className="btn small primary" onClick={() => openAiGuide('about', feature)}>
          {Icon.sparkle(12)}
          {tr('AI を使う準備（約 5 分）', 'Set up AI (about 5 min)')}
        </button>
        <button className="btn small ghost" onClick={() => openAiGuide('paste', feature)}>
          {tr('キーを持っている', 'I have a key')}
        </button>
      </div>
    </>
  );
  if (phone)
    return (
      <div className="kg-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && closeKeyGate()}>
        <div ref={ref} className="kg kg-sheet" role="dialog" aria-modal="true" aria-label={tr('OpenRouter のキーが要ります', 'Needs an OpenRouter key')}>
          {body}
        </div>
      </div>
    );
  return (
    <div
      ref={ref}
      className={`kg ${pos?.above ? 'above' : ''}`}
      role="dialog"
      aria-label={tr('OpenRouter のキーが要ります', 'Needs an OpenRouter key')}
      style={pos ? { left: pos.left, top: pos.top, ['--kg-arrow' as string]: `${pos.arrow}px` } : { visibility: 'hidden', left: 0, top: 0 }}
      data-arrow={pos && pos.arrow >= 0 ? 'on' : undefined}
    >
      {body}
    </div>
  );
}
