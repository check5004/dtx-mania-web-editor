// アプリのアイコンの絵（スネアのヘッドから 5 本のレーンが奥へ伸び、チップが降りてくる）。
// scripts/make-pwa-images.mjs（PWA のアイコン・ファビコン・iPad の起動画面）と
// scripts/readme/（README の図）が使う。絵を変えたら node scripts/make-pwa-images.mjs で作り直す。
//
// - iconSvg({ mode }) … 512×512 の SVG
//     'any'      角丸のタイル（まわりは透明）。public/icons/icon.svg・icon-192/512.png・起動画面
//     'full'     全面（角丸なし）。iOS の apple-touch-icon（角は iOS が丸める）
//     'maskable' 全面の地に、絵を内側 80% の円に収める（Android・Chrome が丸や角丸に切り抜く）
// - MARK_SVG … 16〜32px 用の小さい版（ヘッドとレーン 3 本）。ファビコンと画面左上のロゴ
// - iconParts() … 地（bg）と絵（fg）を分けて返す（README のアニメーションで使う）

/** レーン（下端＝ヘッドの上、上端＝奥）。色はレーンの色（src/dtx/model.ts の DRUM_LANES） */
export const ICON_LANES = [
  { key: 'LC', color: '#FF5C8A', b: [116, 164], t: [190, 210] },
  { key: 'HH', color: '#4FC3F7', b: [172, 220], t: [214, 234] },
  { key: 'SD', color: '#FFD54F', b: [232, 280], t: [246, 266] },
  { key: 'BD', color: '#9C84E0', b: [292, 340], t: [278, 298] },
  { key: 'CY', color: '#42A5F5', b: [348, 396], t: [302, 322] },
];
/** レーンの上端・下端の y */
export const LANE_TOP = 30;
export const LANE_BOTTOM = 344;

const lerp = (a, b, t) => a + (b - a) * t;
const depth = (s) => 1 - Math.pow(1 - s, 1.7);
/** 時間 s（0＝ヘッドに当たる、1＝いちばん奥）→ y。奥ほど詰まって見える */
export const chipY = (s) => LANE_BOTTOM - (LANE_BOTTOM - LANE_TOP) * depth(s);
const laneAt = (lane, y) => {
  const u = (LANE_BOTTOM - y) / (LANE_BOTTOM - LANE_TOP);
  return [lerp(lane.b[0], lane.t[0], u), lerp(lane.b[1], lane.t[1], u)];
};
/** レーン li の時間 s にあるチップの形（path の d） */
export function chipPath(li, s, inset = 0.1) {
  const lane = ICON_LANES[li];
  const y0 = chipY(s);
  const y1 = y0 - lerp(20, 6, depth(s));
  const [a0, a1] = laneAt(lane, y0);
  const [b0, b1] = laneAt(lane, y1);
  const w0 = (a1 - a0) * inset;
  const w1 = (b1 - b0) * inset;
  const f = (v) => v.toFixed(1);
  return `M${f(a0 + w0)} ${f(y0)} L${f(a1 - w0)} ${f(y0)} L${f(b1 - w1)} ${f(y1)} L${f(b0 + w1)} ${f(y1)} Z`;
}
/** レーン li の時間 s にあるチップの中心と大きさ（README のアニメーションで、チップを動かすのに使う） */
export function chipBox(li, s, inset = 0.1) {
  const lane = ICON_LANES[li];
  const y0 = chipY(s);
  const h = lerp(20, 6, depth(s));
  const [a0, a1] = laneAt(lane, y0);
  const [b0, b1] = laneAt(lane, y0 - h);
  const w0 = (a1 - a0) * inset;
  const w1 = (b1 - b0) * inset;
  return { cx: (a0 + a1 + b0 + b1) / 4, cy: y0 - h / 2, w: (a1 - a0 - 2 * w0 + (b1 - b0 - 2 * w1)) / 2, h };
}
/** 8 ビート（HH の 8 分、SD の 2・4 拍、BD、クラッシュ）。[レーン, 時間] */
export const ICON_NOTES = [
  [1, 0.125], [3, 0.125],
  [1, 0.25], [2, 0.25],
  [1, 0.375], [3, 0.375], [4, 0.36],
  [1, 0.5], [3, 0.5], [0, 0.5],
  [1, 0.625], [2, 0.625],
  [1, 0.75], [3, 0.82],
  [1, 0.875], [4, 0.875],
];

export const ICON_DEFS = `<defs>
  <linearGradient id="ic-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B2536"/><stop offset="1" stop-color="#06080C"/></linearGradient>
  <radialGradient id="ic-glow" cx="0.5" cy="0.68" r="0.52"><stop offset="0" stop-color="#4CC2FF" stop-opacity="0.42"/><stop offset="0.6" stop-color="#5B6BF0" stop-opacity="0.12"/><stop offset="1" stop-color="#4CC2FF" stop-opacity="0"/></radialGradient>
  <linearGradient id="ic-shell" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#173F66"/><stop offset="0.22" stop-color="#3FA9EE"/><stop offset="0.38" stop-color="#C6ECFF"/><stop offset="0.5" stop-color="#6FB8FF"/><stop offset="0.78" stop-color="#7A62D8"/><stop offset="1" stop-color="#2B1F62"/></linearGradient>
  <linearGradient id="ic-hoop" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5E6673"/><stop offset="0.3" stop-color="#F7F9FB"/><stop offset="0.55" stop-color="#B9C1CB"/><stop offset="0.8" stop-color="#E9EDF2"/><stop offset="1" stop-color="#555D69"/></linearGradient>
  <radialGradient id="ic-head" cx="0.5" cy="0.35" r="0.75"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.65" stop-color="#E6ECF3"/><stop offset="1" stop-color="#AEBBCB"/></radialGradient>
  <linearGradient id="ic-fade" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.7"/><stop offset="0.75" stop-color="#fff" stop-opacity="0.1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <mask id="ic-beam-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="url(#ic-fade)"/></mask>
  <linearGradient id="ic-gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <radialGradient id="ic-flash" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.35" stop-color="#FFF1B8" stop-opacity="0.85"/><stop offset="1" stop-color="#FFD54F" stop-opacity="0"/></radialGradient>
  <filter id="ic-blur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
  <filter id="ic-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="16" stdDeviation="16" flood-color="#000" flood-opacity="0.65"/></filter>
</defs>`;

const chipMarkup = (li, s) => {
  const d = chipPath(li, s);
  return `<path d="${d}" fill="${ICON_LANES[li].color}"/><path d="${d}" fill="url(#ic-gloss)"/>`;
};

/** レーン（光の帯） */
export const ICON_BEAMS = `<g mask="url(#ic-beam-mask)" opacity="0.62">${ICON_LANES.map(
  (l) => `<path d="M${l.b[0]} ${LANE_BOTTOM} L${l.b[1]} ${LANE_BOTTOM} L${l.t[1]} ${LANE_TOP} L${l.t[0]} ${LANE_TOP} Z" fill="${l.color}"/>`,
).join('')}</g>`;

/** スネア（胴・ラグ・フープ・ヘッド） */
export const ICON_DRUM = `<g filter="url(#ic-shadow)">
  <path d="M92 352 L92 420 A164 50 0 0 0 420 420 L420 352 Z" fill="url(#ic-shell)"/>
  <g fill="url(#ic-hoop)"><rect x="118" y="376" width="13" height="42" rx="6"/><rect x="180" y="388" width="13" height="42" rx="6"/><rect x="250" y="392" width="13" height="42" rx="6"/><rect x="320" y="388" width="13" height="42" rx="6"/><rect x="382" y="376" width="13" height="42" rx="6"/></g>
  <path d="M88 414 A168 52 0 0 0 424 414 L424 430 A168 52 0 0 1 88 430 Z" fill="url(#ic-hoop)"/>
  <ellipse cx="256" cy="352" rx="168" ry="52" fill="url(#ic-hoop)"/>
  <ellipse cx="256" cy="350" rx="155" ry="44" fill="url(#ic-head)"/>
</g>
<path d="M90 360 A166 50 0 0 0 422 360" fill="none" stroke="#4CC2FF" stroke-width="10" opacity="0.55" filter="url(#ic-blur)"/>
<path d="M92 360 A164 49 0 0 0 420 360" fill="none" stroke="#9BE1FF" stroke-width="3" opacity="0.9"/>`;

/** ヘッドに当たった光 */
export const ICON_HIT = `<g>
  <ellipse cx="256" cy="349" rx="118" ry="32" fill="none" stroke="#FFFFFF" stroke-width="2.5" opacity="0.35"/>
  <ellipse cx="256" cy="348" rx="86" ry="23" fill="none" stroke="#FFE7A0" stroke-width="3" opacity="0.6"/>
  <ellipse cx="256" cy="347" rx="70" ry="19" fill="url(#ic-flash)"/>
  <ellipse cx="256" cy="346" rx="26" ry="7" fill="#FFD54F"/>
  <g stroke="#FFF3C4" stroke-width="5" stroke-linecap="round"><line x1="256" y1="292" x2="256" y2="318"/><line x1="208" y1="304" x2="222" y2="322"/><line x1="304" y1="304" x2="290" y2="322"/><line x1="170" y1="326" x2="190" y2="334"/><line x1="342" y1="326" x2="322" y2="334"/></g>
</g>`;

/** 地と絵を分けて返す（fg は 512×512 の座標） */
export function iconParts({ chips = true } = {}) {
  const bg = `<rect width="512" height="512" fill="url(#ic-bg)"/><rect width="512" height="512" fill="url(#ic-glow)"/>`;
  const fg = `${ICON_BEAMS}${chips ? `<g>${ICON_NOTES.map(([li, s]) => chipMarkup(li, s)).join('')}</g>` : ''}${ICON_DRUM}${ICON_HIT}`;
  return { bg, fg };
}

/** 512×512 のアイコンの SVG */
export function iconSvg({ mode = 'any' } = {}) {
  const { bg, fg } = iconParts();
  const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">';
  if (mode === 'full') return `${open}${ICON_DEFS}${bg}${fg}</svg>\n`;
  if (mode === 'maskable') {
    // 絵の芯を円の中心に寄せて 80% に。いちばん外の点も半径 0.4×512 の円の内側に入る
    return `${open}${ICON_DEFS}${bg}<g transform="translate(256 256) scale(0.8) translate(-256 -252)">${fg}</g></svg>\n`;
  }
  // any: 角丸のタイル。縁に薄い線を入れて、暗い所に置いても形が分かるようにする
  return `${open}${ICON_DEFS}<clipPath id="ic-tile"><rect x="16" y="16" width="480" height="480" rx="108"/></clipPath>
<g clip-path="url(#ic-tile)"><g transform="translate(16 16) scale(0.9375)">${bg}${fg}</g></g>
<rect x="17" y="17" width="478" height="478" rx="107" fill="none" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="2"/></svg>\n`;
}

/** 16〜32px 用の小さい版（64×64）。ファビコンと画面左上のロゴ */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs>
  <linearGradient id="mk-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D2839"/><stop offset="1" stop-color="#07090D"/></linearGradient>
  <linearGradient id="mk-shell" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2C7FC4"/><stop offset="0.35" stop-color="#8FDBFF"/><stop offset="0.6" stop-color="#5B8DF0"/><stop offset="1" stop-color="#5A44B8"/></linearGradient>
  <linearGradient id="mk-fade" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <mask id="mk-m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="url(#mk-fade)"/></mask>
</defs>
<rect width="64" height="64" rx="14" fill="url(#mk-bg)"/>
<g mask="url(#mk-m)" opacity="0.7"><path d="M15 41 L24 41 L28 6 L25 6 Z" fill="#4FC3F7"/><path d="M27.5 41 L36.5 41 L33.5 6 L30.5 6 Z" fill="#FFD54F"/><path d="M40 41 L49 41 L39 6 L36 6 Z" fill="#9C84E0"/></g>
<rect x="17.5" y="30" width="7" height="4" rx="1.2" fill="#4FC3F7"/>
<rect x="28.5" y="19" width="6" height="3.5" rx="1.1" fill="#FFD54F"/>
<rect x="39.5" y="24" width="6.5" height="3.6" rx="1.1" fill="#9C84E0"/>
<rect x="22" y="14" width="5" height="3" rx="1" fill="#4FC3F7"/>
<path d="M10 44 V52 A22 6.5 0 0 0 54 52 V44 Z" fill="url(#mk-shell)"/>
<ellipse cx="32" cy="44" rx="22" ry="6.5" fill="#E9EEF4"/>
<ellipse cx="32" cy="43.6" rx="19" ry="5" fill="#FFFFFF"/>
<ellipse cx="32" cy="43.6" rx="7" ry="2" fill="#FFD54F"/>
<rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.3" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="1.5"/>
</svg>
`;
