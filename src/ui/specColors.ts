// スペクトルの色。周波数の帯でドラムのレーンの色に寄せる（キック=紫、タム・スネアの胴=橙、
// その他の楽器が多い中域=灰青、スネアの響き=黄、ハイハット・シンバル=水色）。明るさが音の大きさ。
import { withTr } from '../i18n';
import { SPEC_F_HI, SPEC_F_LO, binFreq } from '../audio/spectro';

/** 帯域の目安（列の見出しと色の切れ目に使う） */
export interface SpecZone {
  key: 'kick' | 'body' | 'mid' | 'snare' | 'metal';
  /** 見出し */
  label: string;
  /** 短い見出し（列が狭いとき） */
  short: string;
  from: number;
  to: number;
  color: string;
  /** その帯を聴く（原曲を聴く帯域のフィルタ） */
  listen: 'low' | 'mid' | 'high';
  tip: string;
}

// 見出しと説明は言語で変わる（withTr のゲッター）
const zone = (z: Omit<SpecZone, 'label' | 'short' | 'tip'>, label: [string, string], short: [string, string], tip: [string, string]): SpecZone =>
  withTr(z as SpecZone, { label, short, tip });

export const SPEC_ZONES: readonly SpecZone[] = [
  zone({ key: 'kick', from: SPEC_F_LO, to: 120, color: '#A48CFF', listen: 'low' }, ['キック', 'Kick'], ['BD', 'BD'], ['キック（バスドラム）の胴鳴り。〜120Hz', 'Kick (bass drum) body. Up to 120 Hz']),
  zone({ key: 'body', from: 120, to: 400, color: '#FF9A3C', listen: 'mid' }, ['胴', 'Body'], ['胴', 'Bd'], ['タム・スネアの胴鳴り。120〜400Hz（ベースも重なる）', 'Tom and snare body. 120–400 Hz (bass overlaps here too)']),
  zone({ key: 'mid', from: 400, to: 1600, color: '#7F93AD', listen: 'mid' }, ['中', 'Mid'], ['中', 'Mid'], ['声・ギターが多い帯。400〜1600Hz（ドラムは目立ちにくい）', 'Mostly vocals and guitar. 400–1600 Hz (drums stand out less here)']),
  zone({ key: 'snare', from: 1600, to: 5000, color: '#FFD54F', listen: 'mid' }, ['スネア', 'Snare'], ['SD', 'SD'], ['スネアの響き・アタック。1.6〜5kHz', 'Snare ring and attack. 1.6–5 kHz']),
  zone({ key: 'metal', from: 5000, to: SPEC_F_HI, color: '#4FC3F7', listen: 'high' }, ['HH・シンバル', 'HH/cymbals'], ['HH', 'HH'], [
    'ハイハット・シンバル・ライド。5kHz〜。短い線＝クローズ、長く伸びる＝オープン・クラッシュ',
    'Hi-hat, cymbals and ride. 5 kHz and up. Short lines = closed, long trails = open or crash',
  ]),
];

const BG: [number, number, number] = [11, 14, 19];

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** 周波数の色（帯の境目はなめらかにつなぐ） */
function zoneColor(f: number): [number, number, number] {
  const lf = Math.log(f);
  // 帯の真ん中（対数）を色の基準点にして、隣どうしを補間する
  const pts = SPEC_ZONES.map((z) => ({ x: (Math.log(Math.max(z.from, SPEC_F_LO)) + Math.log(z.to)) / 2, c: hex(z.color) }));
  // キックは低い方いっぱいまで同じ色
  pts[0].x = Math.log(70);
  if (lf <= pts[0].x) return pts[0].c;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (lf <= pts[i + 1].x) {
      const t = (lf - pts[i].x) / (pts[i + 1].x - pts[i].x);
      // 帯の中は色を保ち、境目の近くで切り替える
      const s = t < 0.3 ? 0 : t > 0.7 ? 1 : (t - 0.3) / 0.4;
      const a = pts[i].c;
      const b = pts[i + 1].c;
      return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
    }
  }
  return pts[pts.length - 1].c;
}

/**
 * 段 × 値（0〜255）→ RGBA の表。
 * gain: 明るさ（1 が標準）。dimMid: 声やギターが多い中域を少し暗くする（ドラム強調・アタックのとき）
 */
export function zoneLut(bins: number, fLo = SPEC_F_LO, fHi = SPEC_F_HI, opts: { gain?: number; dimMid?: boolean } = {}): Uint8ClampedArray {
  const gain = opts.gain ?? 1;
  const mid = SPEC_ZONES.find((z) => z.key === 'mid')!;
  const out = new Uint8ClampedArray(bins * 256 * 4);
  for (let b = 0; b < bins; b++) {
    const f = binFreq(b, bins, fLo, fHi);
    const c = zoneColor(f);
    // 中域は帯の真ん中ほど暗く（境目はなめらかに）
    let dim = 1;
    if (opts.dimMid) {
      const p = (Math.log(f) - Math.log(mid.from)) / (Math.log(mid.to) - Math.log(mid.from));
      if (p > 0 && p < 1) dim = 1 - 0.4 * Math.sin(Math.PI * p);
    }
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, (v / 255) * gain) * dim;
      const g = Math.pow(t, 0.85);
      // 強いところは白に寄せて光らせる
      const w = t > 0.72 ? ((t - 0.72) / 0.28) * 0.6 : 0;
      const o = (b * 256 + v) * 4;
      for (let k = 0; k < 3; k++) {
        const col = BG[k] + (c[k] - BG[k]) * g;
        out[o + k] = col + (255 - col) * w;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
