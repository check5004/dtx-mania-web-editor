// 小さな線画アイコン（外部ライブラリを使わない）
import type { ReactNode } from 'react';

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icon = {
  play: (s?: number) => (
    <Svg size={s}>
      <path d="M5 3.2v9.6L12.8 8z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  pause: (s?: number) => (
    <Svg size={s}>
      <rect x="4" y="3" width="2.8" height="10" rx=".6" fill="currentColor" stroke="none" />
      <rect x="9.2" y="3" width="2.8" height="10" rx=".6" fill="currentColor" stroke="none" />
    </Svg>
  ),
  stop: (s?: number) => (
    <Svg size={s}>
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  ),
  toStart: (s?: number) => (
    <Svg size={s}>
      <path d="M4 3.5v9" />
      <path d="M12.5 3.8v8.4L6.5 8z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  cursorPlay: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 8h3" strokeDasharray="1.5 1.5" />
      <path d="M7 3.5v9L13.5 8z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  undo: (s?: number) => (
    <Svg size={s}>
      <path d="M5.5 4 2.5 7l3 3" />
      <path d="M2.8 7h6.7a3.5 3.5 0 0 1 0 7H7" />
    </Svg>
  ),
  redo: (s?: number) => (
    <Svg size={s}>
      <path d="m10.5 4 3 3-3 3" />
      <path d="M13.2 7H6.5a3.5 3.5 0 0 0 0 7H9" />
    </Svg>
  ),
  save: (s?: number) => (
    <Svg size={s}>
      <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7" />
      <path d="M2.8 11.5v1.7h10.4v-1.7" />
    </Svg>
  ),
  folder: (s?: number) => (
    <Svg size={s}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </Svg>
  ),
  metronome: (s?: number) => (
    <Svg size={s}>
      <path d="M6 2.5h4l2.5 11h-9z" />
      <path d="M8 11 11.5 4.5" />
    </Svg>
  ),
  plus: (s?: number) => (
    <Svg size={s}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  minus: (s?: number) => (
    <Svg size={s}>
      <path d="M3 8h10" />
    </Svg>
  ),
  follow: (s?: number) => (
    <Svg size={s}>
      <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />
      <path d="M3 13h10" />
    </Svg>
  ),
  speaker: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
    </Svg>
  ),
  trash: (s?: number) => (
    <Svg size={s}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
    </Svg>
  ),
  file: (s?: number) => (
    <Svg size={s}>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </Svg>
  ),
  home: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 7.5 8 3l5.5 4.5V13h-11z" />
    </Svg>
  ),
  warn: (s?: number) => (
    <Svg size={s}>
      <path d="M8 2.5 14 13H2z" />
      <path d="M8 6.5v3M8 11.2v.1" />
    </Svg>
  ),
  info: (s?: number) => (
    <Svg size={s}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.2v4M8 5v.1" />
    </Svg>
  ),
  loop: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 7.5a4 4 0 0 1 4-4h6M10.5 1.5l2 2-2 2M13.5 8.5a4 4 0 0 1-4 4h-6M5.5 14.5l-2-2 2-2" />
    </Svg>
  ),
  back: (s?: number) => (
    <Svg size={s}>
      <path d="M10 3 5 8l5 5" />
    </Svg>
  ),
  gear: (s?: number) => (
    <Svg size={s}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </Svg>
  ),
  tap: (s?: number) => (
    <Svg size={s}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  ),
  midi: (s?: number) => (
    <Svg size={s}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="5" cy="7" r=".7" fill="currentColor" />
      <circle cx="8" cy="5.5" r=".7" fill="currentColor" />
      <circle cx="11" cy="7" r=".7" fill="currentColor" />
    </Svg>
  ),
  bars: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 13.5h11" />
      <path d="M4 11.5V9M7 11.5V5M10 11.5V7.5M13 11.5V3.5" strokeWidth="2" />
    </Svg>
  ),
  speakerOff: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
      <path d="m10.5 6 3.5 4M14 6l-3.5 4" />
    </Svg>
  ),
  chart: (s?: number) => (
    <Svg size={s}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5 10h2M9 6.5h2M5 6.5h1.5M9 10h2" strokeWidth="1.8" />
    </Svg>
  ),
  chartOff: (s?: number) => (
    <Svg size={s}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M3.5 12.5 12.5 3.5" />
    </Svg>
  ),
  sliders: (s?: number) => (
    <Svg size={s}>
      <path d="M4 2.5v11M8 2.5v11M12 2.5v11" />
      <rect x="2.5" y="8.5" width="3" height="2.2" rx=".6" fill="currentColor" />
      <rect x="6.5" y="4.5" width="3" height="2.2" rx=".6" fill="currentColor" />
      <rect x="10.5" y="10" width="3" height="2.2" rx=".6" fill="currentColor" />
    </Svg>
  ),
  download: (s?: number) => (
    <Svg size={s}>
      <path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2" />
      <path d="M2.8 12.2v1.3h10.4v-1.3" />
    </Svg>
  ),
  wave: (s?: number) => (
    <Svg size={s}>
      <path d="M2 8h1.5M4.5 5v6M7 3v10M9.5 6v4M12 4.5v7M14 8h.5" />
    </Svg>
  ),
  library: (s?: number) => (
    <Svg size={s}>
      <path d="M3 2.8v10.4M6 2.8v10.4" />
      <path d="m8.8 3.4 2.6-.7 2.4 9.8-2.6.7z" />
    </Svg>
  ),
  sparkle: (s?: number) => (
    <Svg size={s}>
      <path d="M8 1.8 9.5 6 13.8 7.5 9.5 9 8 13.2 6.5 9 2.2 7.5 6.5 6z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  search: (s?: number) => (
    <Svg size={s}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.3 3.3" />
    </Svg>
  ),
  star: (s?: number, filled = false) => (
    <Svg size={s}>
      <path d="m8 2.2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4-2.9-2.8 4-.6z" fill={filled ? 'currentColor' : 'none'} />
    </Svg>
  ),
  eye: (s?: number) => (
    <Svg size={s}>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  ),
  close: (s?: number) => (
    <Svg size={s}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  ),
  chevronDown: (s?: number) => (
    <Svg size={s}>
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </Svg>
  ),
  chevronRight: (s?: number) => (
    <Svg size={s}>
      <path d="m6.5 4.5 3.5 3.5-3.5 3.5" />
    </Svg>
  ),
  layers: (s?: number) => (
    <Svg size={s}>
      <path d="M8 2.5 14 5.5 8 8.5 2 5.5z" />
      <path d="m2 8.3 6 3 6-3M2 11 8 14l6-3" />
    </Svg>
  ),
  drum: (s?: number) => (
    <Svg size={s}>
      <ellipse cx="8" cy="5.5" rx="5.5" ry="2.2" />
      <path d="M2.5 5.5v5c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-5" />
    </Svg>
  ),
};
