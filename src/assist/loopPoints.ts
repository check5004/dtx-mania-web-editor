// ループの A・B を1つずつ決める。片方だけの間はループにしない（もう片方を決めたときに範囲になる）。
// 上のバーの A・B、I・O キー、帯のドラッグで共通に使う。位置は拍（曲頭 = 0）で持つ。

export interface LoopBeats {
  on: boolean;
  /** 拍（曲頭=0） */
  a: number;
  b: number;
}

/** 片方の端だけ決めたとき（A だけ・B だけ） */
export interface LoopMark {
  side: 'a' | 'b';
  beat: number;
}

/** ループの範囲（両方決まったとき）か、片方だけの印。同時には持たない */
export interface LoopPoints {
  loop: LoopBeats | null;
  mark: LoopMark | null;
}

const EPS = 1e-6;

/**
 * A か B を置いたあと。もう片方があって範囲になれば、その範囲のループ（オン）にする。
 * もう片方が無いとき・範囲にならないとき（A が B 以降、B が A 以前）は、置いた方だけを残す。
 * もう片方を勝手に作ったり動かしたりはしない。
 */
export function placeLoopPoint(cur: LoopPoints, side: 'a' | 'b', beat: number): LoopPoints {
  const at = Math.max(0, beat);
  const loop = cur.loop && cur.loop.b > cur.loop.a ? cur.loop : null;
  const other = loop ? (side === 'a' ? loop.b : loop.a) : cur.mark && cur.mark.side !== side ? cur.mark.beat : null;
  if (other !== null) {
    const a = side === 'a' ? at : other;
    const b = side === 'a' ? other : at;
    if (b - a > EPS) return { loop: { on: true, a, b }, mark: null };
  }
  return { loop: null, mark: { side, beat: at } };
}

/** 帯のどこを掴んだか（A・B の印・片方だけの印・範囲の中・空いた所） */
export type LoopGrab = 'new' | 'a' | 'b' | 'move' | 'mark';

/**
 * tol: 線からこれだけ近ければ掴む（拍）。
 * tab: 線の外側に出ている印の長さ（拍）。A の印は線の前（曲頭の側）、B の印は線の後ろに出ている。
 */
export function grabLoop(cur: LoopPoints, beat: number, tol: number, tab = tol): LoopGrab {
  const near = (x: number, side: 'a' | 'b') => {
    const d = beat - x;
    if (Math.abs(d) <= tol) return true;
    return (side === 'a' ? d <= 0 : d >= 0) && Math.abs(d) <= tab;
  };
  const l = cur.loop;
  if (!l || l.b <= l.a) return cur.mark && near(cur.mark.beat, cur.mark.side) ? 'mark' : 'new';
  const nearA = near(l.a, 'a');
  const nearB = near(l.b, 'b');
  if (nearA && (!nearB || Math.abs(beat - l.a) <= Math.abs(beat - l.b))) return 'a';
  if (nearB) return 'b';
  if (beat > l.a && beat < l.b) return 'move';
  return 'new';
}
