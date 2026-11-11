// エフェクトのテンプレート（チップを選んで右クリック → エフェクト）。選んだチップで決まるのは時間の範囲だけで、
// その範囲にカーブの点を置く（かかるかどうかは、ほかのカーブと同じく時間とレーンで決まる）。
// a: 最初のチップの拍、b: 最後のチップの拍、end: b の次のグリッド（ここで元に戻す）
import { withTr } from '../i18n';
import { FX_HI, FX_LO, type FxShape, type FxType } from './model';

export type FxTemplateId = 'close' | 'open' | 'dip' | 'hold' | 'locut' | 'pitch';

export interface FxTemplate {
  id: FxTemplateId;
  type: FxType;
  name: string;
  /** 小さな絵（x は時間 0〜1、y は 0 が「かけない」側・1 が深くかけた側） */
  icon: readonly (readonly [number, number])[];
}

const t = (id: FxTemplateId, type: FxType, icon: FxTemplate['icon'], name: readonly [string, string]): FxTemplate => withTr({ id, type, icon } as FxTemplate, { name });

/** 並べる順（右クリックのメニュー・右のパネル） */
export const FX_TEMPLATES: readonly FxTemplate[] = [
  t('close', 'hicut', [[0, 0], [0.35, 0.05], [0.7, 0.35], [1, 1]], ['だんだんこもる', 'Gradually muffle']),
  t('open', 'hicut', [[0, 1], [0.35, 0.95], [0.7, 0.65], [1, 0]], ['だんだん開く', 'Gradually open']),
  t('dip', 'hicut', [[0, 0], [0.5, 1], [1, 0]], ['こもって戻る', 'Muffle and back']),
  t('hold', 'hicut', [[0, 1], [1, 1]], ['ずっとこもる', 'Stay muffled']),
  t('locut', 'locut', [[0, 0], [0.35, 0.05], [0.7, 0.35], [1, 1]], ['低い音をだんだん削る（ローカット）', 'Gradually cut the lows (low cut)']),
  t('pitch', 'pitch', [[0, 0], [0.25, 0], [0.25, 0.25], [0.5, 0.25], [0.5, 0.5], [0.75, 0.5], [0.75, 0.75], [1, 0.75], [1, 1]], ['音をだんだん高く（ピッチ）', 'Gradually raise the pitch']),
];

export const templateById = new Map(FX_TEMPLATES.map((x) => [x.id, x]));

/** こもらせる先（ハイカット）・削る所（ローカット）・上げる高さ（ピッチ、半音） */
export const TEMPLATE_HICUT = 800;
export const TEMPLATE_LOCUT = 300;
export const TEMPLATE_PITCH = 12;

export interface TemplatePoint {
  beat: number;
  v: number;
  s?: FxShape;
}

/** テンプレートの点（拍で）。mid は a と b のあいだのグリッド（こもって戻るの底） */
export function templatePoints(id: FxTemplateId, a: number, b: number, end: number, mid = (a + b) / 2): TemplatePoint[] {
  const one = b - a < 1e-6;
  switch (id) {
    case 'close':
      return one
        ? [{ beat: a, v: TEMPLATE_HICUT, s: 'hold' }, { beat: end, v: FX_HI }]
        : [{ beat: a, v: FX_HI, s: 'slow' }, { beat: b, v: TEMPLATE_HICUT, s: 'hold' }, { beat: end, v: FX_HI }];
    case 'open':
      return one ? [{ beat: a, v: TEMPLATE_HICUT, s: 'slow' }, { beat: end, v: FX_HI }] : [{ beat: a, v: TEMPLATE_HICUT, s: 'slow' }, { beat: b, v: FX_HI }];
    case 'dip':
      return one || mid <= a + 1e-6 || mid >= b - 1e-6
        ? [{ beat: a, v: TEMPLATE_HICUT, s: 'hold' }, { beat: end, v: FX_HI }]
        : [{ beat: a, v: FX_HI }, { beat: mid, v: TEMPLATE_HICUT }, { beat: b, v: FX_HI }];
    case 'hold':
      return [{ beat: a, v: TEMPLATE_HICUT, s: 'hold' }, { beat: end, v: FX_HI }];
    case 'locut':
      return one
        ? [{ beat: a, v: TEMPLATE_LOCUT, s: 'hold' }, { beat: end, v: FX_LO }]
        : [{ beat: a, v: FX_LO, s: 'slow' }, { beat: b, v: TEMPLATE_LOCUT, s: 'hold' }, { beat: end, v: FX_LO }];
    case 'pitch':
      return one ? [{ beat: a, v: TEMPLATE_PITCH, s: 'hold' }, { beat: end, v: 0 }] : [{ beat: a, v: 0 }, { beat: b, v: TEMPLATE_PITCH, s: 'hold' }, { beat: end, v: 0 }];
  }
}
