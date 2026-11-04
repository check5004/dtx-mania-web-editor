// 試聴の ▶／■ ボタンと、鳴っている間の進み具合（store/audition）。
import { tr } from '../i18n';
import type { CSSProperties, ReactNode } from 'react';
import { toggleAudition, useAudition, type AuditionSound } from '../store/audition';
import { Icon } from './icons';

/** 試聴のボタン。鳴っている間は ■（押すと止める） */
export function AuditionButton({
  k,
  load,
  label,
  size = 11,
  className = 'ib',
  style,
  idleIcon,
  onPress,
}: {
  /** 試聴の名前（store/audition の key） */
  k: string;
  load: () => AuditionSound | null | Promise<AuditionSound | null>;
  /** 何の音か（「〜を試聴」「〜を止める」に使う） */
  label: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** 止まっているときのアイコン（省くと ▶） */
  idleIcon?: ReactNode;
  /** 押したときに一緒にすること（行を選ぶなど） */
  onPress?: () => void;
}) {
  const on = useAudition((s) => s.key === k);
  return (
    <button
      type="button"
      className={`${className} aud-btn ${on ? 'on' : ''}`}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        onPress?.();
        void toggleAudition(k, load);
      }}
      title={on ? tr('止める（Esc）', 'Stop (Esc)') : tr('試聴', 'Preview')}
      aria-label={on ? tr(`${label}を止める`, `Stop ${label}`) : tr(`${label}を試聴`, `Preview ${label}`)}
      aria-pressed={on}
    >
      {on ? Icon.stop(size) : (idleIcon ?? Icon.play(size))}
    </button>
  );
}

/** 試聴の進み具合の細い線（親は position: relative）。鳴っていなければ何も出さない */
export function AuditionProgress({ k }: { k: string }) {
  const st = useAudition((s) => (s.key === k ? s : null));
  if (!st) return null;
  return (
    <span className="aud-bar" aria-hidden="true">
      {st.since > 0 && st.duration > 0 && <i key={st.since} style={{ animationDuration: `${st.duration}s` }} />}
    </span>
  );
}
