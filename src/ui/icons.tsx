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
  /** エフェクト（フィルターのカーブ） */
  fx: (s?: number) => (
    <Svg size={s}>
      <path d="M2 5h4.2c2.6 0 3.6 6.5 8 6.5" />
      <circle cx="6.2" cy="5" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  ),
  /** 切って聴く（丸に斜線） */
  ban: (s?: number) => (
    <Svg size={s}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
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
  video: (s?: number) => (
    <Svg size={s}>
      <rect x="1.8" y="3.8" width="8.8" height="8.4" rx="1.5" />
      <path d="m10.6 7 3.6-2.2v6.4L10.6 9z" />
    </Svg>
  ),
  wave: (s?: number) => (
    <Svg size={s}>
      <path d="M2 8h1.5M4.5 5v6M7 3v10M9.5 6v4M12 4.5v7M14 8h.5" />
    </Svg>
  ),
  /** スペクトル（縦が音の高さ、横が時間の濃淡の帯） */
  spectrum: (s?: number) => (
    <Svg size={s}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M4.5 5.5h2.5M9 5.5h2.5M4.5 8h1.5M7.5 8h4M4.5 10.5h5M11 10.5h.5" strokeWidth="1.6" />
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
  pencil: (s?: number) => (
    <Svg size={s}>
      <path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.2.7.7-3.2z" />
      <path d="M9.2 4.3l2.5 2.5" />
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
  chevronUp: (s?: number) => (
    <Svg size={s}>
      <path d="m4.5 9.5 3.5-3.5 3.5 3.5" />
    </Svg>
  ),
  screen: (s?: number) => (
    <Svg size={s}>
      <rect x="3.5" y="1.8" width="9" height="12.4" rx="1.4" />
      <path d="M6 5.5h1.6M9.2 8h1.6M6 10.5h1.6M3.5 12h9" />
    </Svg>
  ),
  history: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2.5 2.5v2.6h2.6M8 5v3.2l2 1.3" />
    </Svg>
  ),
  chevronRight: (s?: number) => (
    <Svg size={s}>
      <path d="m6.5 4.5 3.5 3.5-3.5 3.5" />
    </Svg>
  ),
  chevronLeft: (s?: number) => (
    <Svg size={s}>
      <path d="m9.5 4.5-3.5 3.5 3.5 3.5" />
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
  /** フラム：ほんの少しずれた2つのチップ（下の弱い1打目と上の2打目） */
  flam: (s?: number) => (
    <Svg size={s}>
      <rect x="2" y="9" width="12" height="3.6" rx="1.2" fill="currentColor" stroke="none" opacity=".45" />
      <rect x="2" y="4.2" width="12" height="3.6" rx="1.2" fill="currentColor" stroke="none" />
    </Svg>
  ),
  // ---- タブレット版 ----
  menu: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </Svg>
  ),
  grid: (s?: number) => (
    <Svg size={s}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </Svg>
  ),
  /** レーンのパッド（縦に並んだ細い枠） */
  lanes: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 13.5h11" />
      <rect x="3" y="5" width="2.4" height="6" rx=".6" />
      <rect x="6.8" y="5" width="2.4" height="6" rx=".6" />
      <rect x="10.6" y="5" width="2.4" height="6" rx=".6" />
      <path d="M4.2 3v1.4M8 3v1.4M11.8 3v1.4" />
    </Svg>
  ),
  cloud: (s?: number) => (
    <Svg size={s}>
      <path d="M4.7 12.6h6.9a2.8 2.8 0 0 0 .4-5.57 4 4 0 0 0-7.6-.9A3.25 3.25 0 0 0 4.7 12.6Z" />
    </Svg>
  ),
  storage: (s?: number) => (
    <Svg size={s}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
      <path d="M2.5 9.4h11M5 11.3h.1M7.2 11.3h.1" />
    </Svg>
  ),
  db: (s?: number) => (
    <Svg size={s}>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </Svg>
  ),
  ear: (s?: number) => (
    <Svg size={s}>
      <path d="M4.5 6.2a3.5 3.5 0 1 1 7 0c0 1.9-1.6 2.6-2.2 3.8-.5 1-.4 3-2.3 3-1 0-1.6-.6-1.8-1.3" />
      <path d="M6.6 6.3a1.4 1.4 0 1 1 2.6.8c-.3.4-.9.7-.9 1.4" />
    </Svg>
  ),
  checkCircle: (s?: number) => (
    <Svg size={s}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
    </Svg>
  ),
  check: (s?: number) => (
    <Svg size={s}>
      <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
    </Svg>
  ),
  /** 選ぶ道具：点線の四角と矢印 */
  selectBox: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 9V2.5H9" strokeDasharray="1.6 1.6" />
      <path d="M7.5 7.5l5.7 2.2-2.4.9-.9 2.4z" fill="currentColor" />
    </Svg>
  ),
  zoomIn: (s?: number) => (
    <Svg size={s}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.4 10.4 3.1 3.1M5 7h4M7 5v4" />
    </Svg>
  ),
  zoomOut: (s?: number) => (
    <Svg size={s}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.4 10.4 3.1 3.1M5 7h4" />
    </Svg>
  ),
  arrowUp: (s?: number) => (
    <Svg size={s}>
      <path d="M8 13V3M4 7l4-4 4 4" />
    </Svg>
  ),
  arrowDown: (s?: number) => (
    <Svg size={s}>
      <path d="M8 3v10M4 9l4 4 4-4" />
    </Svg>
  ),
  arrowLeft: (s?: number) => (
    <Svg size={s}>
      <path d="M13 8H3M7 4 3 8l4 4" />
    </Svg>
  ),
  arrowRight: (s?: number) => (
    <Svg size={s}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Svg>
  ),
  copy: (s?: number) => (
    <Svg size={s}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
      <path d="M10.5 5.5V3.9c0-.8-.6-1.4-1.4-1.4H3.9c-.8 0-1.4.6-1.4 1.4v5.2c0 .8.6 1.4 1.4 1.4h1.6" />
    </Svg>
  ),
  cut: (s?: number) => (
    <Svg size={s}>
      <circle cx="4.5" cy="11.5" r="2" />
      <circle cx="11.5" cy="11.5" r="2" />
      <path d="M6 10 12 2.5M10 10 4 2.5" />
    </Svg>
  ),
  /** 音を切り出す（波形の一部を括弧で取る。クリップボードの「切り取り」のはさみと分ける） */
  extract: (s?: number) => (
    <Svg size={s}>
      <path d="M4.2 2.8H2.5v10.4h1.7M11.8 2.8h1.7v10.4h-1.7" />
      <path d="M5.8 8h.4M7.3 5.2v5.6M8.9 3.8v8.4M10.4 6.3v3.4" />
    </Svg>
  ),
  paste: (s?: number) => (
    <Svg size={s}>
      <rect x="3.5" y="3" width="9" height="11" rx="1.4" />
      <path d="M6 3V2h4v1M6 7h4M6 10h4" />
    </Svg>
  ),
  dots: (s?: number) => (
    <Svg size={s}>
      <circle cx="3.5" cy="8" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".9" fill="currentColor" />
    </Svg>
  ),
  share: (s?: number) => (
    <Svg size={s}>
      <path d="M5.5 6H4.2c-.7 0-1.2.5-1.2 1.2v5.6c0 .7.5 1.2 1.2 1.2h7.6c.7 0 1.2-.5 1.2-1.2V7.2c0-.7-.5-1.2-1.2-1.2h-1.3" />
      <path d="M8 9.5V1.8M5.5 4.2 8 1.8l2.5 2.4" />
    </Svg>
  ),
  zip: (s?: number) => (
    <Svg size={s}>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M7 2v1.5M7 5v1.5M7 8v1.5" />
      <rect x="6.2" y="10" width="1.6" height="2" rx=".4" />
    </Svg>
  ),
  /** 上下左右の矢印（スクロール・動かす） */
  move: (s?: number) => (
    <Svg size={s}>
      <path d="M8 1.8v12.4M1.8 8h12.4" />
      <path d="M6.2 3.6 8 1.8l1.8 1.8M6.2 12.4 8 14.2l1.8-1.8M3.6 6.2 1.8 8l1.8 1.8M12.4 6.2 14.2 8l-1.8 1.8" />
    </Svg>
  ),
  /** 指（長押し） */
  hand: (s?: number) => (
    <Svg size={s}>
      <path d="M6 8.5V3.2a1 1 0 0 1 2 0V7.5" />
      <path d="M8 7V5.6a1 1 0 0 1 2 0V7.5M10 6.4a1 1 0 0 1 2 0v3.4c0 2.4-1.6 4.2-4 4.2-1.6 0-2.6-.8-3.4-2L3.2 9.6a1 1 0 0 1 1.6-1.2L6 9.7" />
    </Svg>
  ),
  plusMinus: (s?: number) => (
    <Svg size={s}>
      <path d="M8 2.5v6M5 5.5h6M5 12.5h6" />
    </Svg>
  ),
  /** 開いた本（説明書） */
  book: (s?: number) => (
    <Svg size={s}>
      <path d="M8 4.3C6.7 3.3 4.8 2.9 2.5 3v9c2.3-.1 4.2.3 5.5 1.3 1.3-1 3.2-1.4 5.5-1.3V3c-2.3-.1-4.2.3-5.5 1.3z" />
      <path d="M8 4.3v9" />
    </Svg>
  ),
  /** 箱（DTXMania の BOX） */
  box: (s?: number) => (
    <Svg size={s}>
      <path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11z" />
      <path d="M2.5 5 8 7.5 13.5 5M8 7.5v6" />
    </Svg>
  ),
  /** 守る（ほかのフォルダには書かない） */
  shield: (s?: number) => (
    <Svg size={s}>
      <path d="M8 2 13.3 4v4c0 3-2.3 5.5-5.3 6-3-.5-5.3-3-5.3-6V4z" />
      <path d="m5.7 8 1.7 1.7 3-3.3" />
    </Svg>
  ),
  /** 読み直す */
  refresh: (s?: number) => (
    <Svg size={s}>
      <path d="M13 7.5A5 5 0 1 0 11.6 11" />
      <path d="M13 3v4.5H8.5" />
    </Svg>
  ),
  /** GitHub のマーク（Primer Octicons の mark-github、MIT。GitHub へのリンクにだけ使う） */
  github: (s?: number) => (
    <Svg size={s}>
      <path
        fill="currentColor"
        stroke="none"
        d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
      />
    </Svg>
  ),
};
