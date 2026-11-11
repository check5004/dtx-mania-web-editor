// 特殊ノーツを黙って消さない：ほかの操作（置く・動かす・貼り付け・フレーズ・小節の生成など）で、同じレーンの同じ時刻に
// チップが来て消えた特殊ノーツを、元の所が空いていれば元のまま、空いていなければ自動で鳴らす（SE）にして戻す。
// 消すための操作（Delete・小節の削除など）は store/editor の edit に replace を渡して、ここを通さない。
import { produceWithPatches, type Patch } from 'immer';
import { toBase36x2 } from '../dtx/base36';
import { drumChannel, isSeChannel, type Chip, type DtxDoc } from '../dtx/model';
import { specialWavs } from '../dtx/kinds';
import { conflictKey } from '../edit/ops';
import { SE_CHANNELS, specialLayout } from './specialLayout';

export interface KeptSpecials {
  doc: DtxDoc;
  redo: Patch[];
  undo: Patch[];
  /** 自動で鳴らすにした数（種類の id → 数） */
  auto: Map<string, number>;
}

const posKey = (ch: number, c: Pick<Chip, 'm' | 'f'>) => `${conflictKey(ch)}@${c.m}:${c.f.n}/${c.f.d}`;
const atKey = (c: Pick<Chip, 'm' | 'f'>) => `${c.m}:${c.f.n}/${c.f.d}`;

/** prev から next への変更で消えた特殊ノーツを戻した譜面と、そのパッチ。戻すものが無ければ null */
export function keepSpecials(prev: DtxDoc, next: DtxDoc): KeptSpecials | null {
  if (prev.chips === next.chips) return null;
  const lay = specialLayout(prev);
  if (!lay.on) return null;
  const wav = lay.wav;
  const cand = prev.chips.filter((c) => wav.has(c.v) && (isSeChannel(c.ch) || drumChannel(c.ch)?.kind === 'normal'));
  if (cand.length === 0) return null;
  const now = new Set<number>();
  for (const c of next.chips) now.add(c.id);
  const lost = cand.filter((c) => !now.has(c.id));
  if (lost.length === 0) return null;
  const nextWav = specialWavs(next);
  const taken = new Set(next.chips.map((c) => posKey(c.ch, c)));
  const same = new Set<string>();
  for (const c of next.chips) {
    const k = nextWav.get(c.v);
    if (k) same.add(`${k}@${atKey(c)}`);
  }
  const seOf = new Map(lay.kinds.map((k) => [k.id, k.se]));
  const add: Chip[] = [];
  const auto = new Map<string, number>();
  for (const c of lost) {
    const kind = wav.get(c.v)!;
    const at = `${kind}@${atKey(c)}`;
    // 同じ時刻に同じ種類の音がもうある（写した・置き直した）・音の定義が消えた
    if (same.has(at) || next.fields['WAV' + toBase36x2(c.v)] === undefined) continue;
    let ch = c.ch;
    if (taken.has(posKey(ch, c))) {
      const free = [seOf.get(kind) ?? SE_CHANNELS[0], ...SE_CHANNELS].find((x) => !taken.has(posKey(x, c)));
      if (free === undefined) continue;
      ch = free;
      if (!isSeChannel(c.ch)) auto.set(kind, (auto.get(kind) ?? 0) + 1);
    }
    taken.add(posKey(ch, c));
    same.add(at);
    add.push({ id: c.id, ch, m: c.m, f: { n: c.f.n, d: c.f.d }, v: c.v });
  }
  if (add.length === 0) return null;
  const [doc, redo, undo] = produceWithPatches(next, (d) => {
    for (const c of add) d.chips.push(c);
  });
  return { doc, redo, undo, auto };
}
