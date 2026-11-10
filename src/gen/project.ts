// 同じ曲のほかの難易度の譜面（別の DTX ファイル）を、いま開いている譜面と同じ時間の並び・WAV 番号の上に写す。
// AI難易度生成で、曲に既にある難易度を並べて比べる・聴く・それを元に下の難易度を作るときに使う。
// - 写すのはドラムのチップだけ。BGM・SE・テンポ・BGA は開いている譜面のもの（同じ曲なので原曲は同じ）
// - 位置は秒で合わせる（原曲の頭＝最初の BGM チップを基準に）。同じ所に来るなら小節と位置はそのまま使う
//   （手元の曲でも、難易度ごとに BPM の書き方が少し違うものがある）
// - 音は、同じファイル・同じ音量・同じパンの WAV 番号に付け替える。無ければ空いている番号に足す
//   （作者は難易度ごとに #VOLUME を変えていることがある。写す譜面どうしで同じ表を使い、番号がぶつからないようにする）
//   スネアのリムは音で決まるので、リムの音かどうかも同じものに付け替え、足すときはラベル（「Snare Rim」など）も写す
import { parseNxNumber, toBase36x2 } from '../dtx/base36';
import { frac } from '../dtx/fraction';
import { CH, drumChannel, type Chip, type DtxDoc } from '../dtx/model';
import { ORIGIN_KEY } from '../dtx/origin';
import { isRimSound, wavLabel } from '../dtx/rim';
import { buildTempoMap, type TempoMap } from '../dtx/timing';
import { setField, setFieldComment } from '../edit/ops';

function numField(fields: Record<string, string>, keys: string[], def: number): number {
  for (const k of keys) {
    const raw = fields[k];
    if (raw === undefined) continue;
    const neg = raw.trim().startsWith('-');
    const v = parseNxNumber(raw.trim().replace(/^[-+]/, ''));
    if (v !== null) return neg ? -v : v;
  }
  return def;
}

interface WavDef {
  path: string;
  volume: number;
  pan: number;
  /** リムの音か（ラベルかファイル名で決まる） */
  rim: boolean;
  /** ラベル（WAV の行のコメント） */
  label: string | null;
}

function wavDef(doc: DtxDoc, no: number): WavDef | null {
  const z = toBase36x2(no);
  const path = doc.fields['WAV' + z];
  if (path === undefined) return null;
  const label = wavLabel(doc, no);
  return { path, volume: numField(doc.fields, ['VOLUME' + z, 'WAVVOL' + z], 100), pan: numField(doc.fields, ['PAN' + z, 'WAVPAN' + z], 0), rim: isRimSound(path, label), label };
}

const keyOf = (w: WavDef) => `${w.path.replace(/\\/g, '/').toLowerCase()}|${Math.round(w.volume)}|${Math.round(w.pan)}${w.rim ? '|rim' : ''}`;

/** 最初の BGM チップの秒（無ければ 0） */
function bgmSec(doc: DtxDoc, t: TempoMap): number {
  let best = Infinity;
  for (const c of doc.chips) if (c.ch === CH.BGM) best = Math.min(best, t.beatOf(c.m, c.f));
  return best === Infinity ? 0 : t.beatToSec(best);
}

/** 写すときの WAV 番号の表（開いている譜面の定義＋写す譜面のために足した定義） */
class WavPool {
  private byKey = new Map<string, number>();
  private taken = new Set<number>();
  private next = 1;
  /** 足した定義（番号 → 定義） */
  readonly added = new Map<number, WavDef>();

  constructor(base: DtxDoc) {
    for (const k of Object.keys(base.fields)) {
      const m = /^(WAV|VOLUME|WAVVOL|PAN|WAVPAN)([0-9A-Z]{2})$/.exec(k);
      if (!m) continue;
      const no = parseInt(m[2], 36);
      this.taken.add(no);
      if (m[1] !== 'WAV') continue;
      const w = wavDef(base, no);
      if (w && !this.byKey.has(keyOf(w))) this.byKey.set(keyOf(w), no);
    }
    for (const c of base.chips) if (c.ch !== CH.BPM && c.ch !== CH.BPM_EX) this.taken.add(c.v);
  }

  numberFor(w: WavDef): number | null {
    const hit = this.byKey.get(keyOf(w));
    if (hit !== undefined) return hit;
    while (this.next < 36 * 36 && this.taken.has(this.next)) this.next++;
    if (this.next >= 36 * 36) return null;
    const no = this.next;
    this.taken.add(no);
    this.byKey.set(keyOf(w), no);
    this.added.set(no, w);
    return no;
  }
}

/** 小節の中の位置（1/384 小節に丸める。NX の分解能） */
function locate(t: TempoMap, beat: number): { m: number; f: Chip['f'] } {
  let { m } = t.locate(Math.max(0, beat));
  const start = t.measureStart(m);
  const len = t.measureBeats(m);
  let n = Math.round(((beat - start) / len) * 384);
  if (n >= 384) {
    m += 1;
    n = 0;
  }
  return { m, f: frac(Math.max(0, n), 384) };
}

/**
 * others の譜面を base の上に写す。戻り値は base の写しで、ドラムのチップだけが others のもの。
 * #DLEVEL は写した譜面のもの。印（#DTXE_ORIGIN）は持ち越さない（作った譜面には書き出すときに付け直す）
 */
export function projectCharts(base: DtxDoc, others: readonly DtxDoc[]): DtxDoc[] {
  const bt = buildTempoMap(base);
  const bBgm = bgmSec(base, bt);
  const pool = new WavPool(base);
  return others.map((o) => {
    const ot = buildTempoMap(o);
    const oBgm = bgmSec(o, ot);
    const out: DtxDoc = structuredClone(base);
    out.chips = out.chips.filter((c) => !drumChannel(c.ch));
    const used = new Set<number>();
    const seen = new Set<string>();
    for (const c of o.chips) {
      if (!drumChannel(c.ch)) continue;
      const sec = ot.beatToSec(ot.beatOf(c.m, c.f)) - oBgm + bBgm;
      const beat = bt.secToBeat(sec);
      const pos = Math.abs(bt.beatOf(c.m, c.f) - beat) < 1e-4 ? { m: c.m, f: c.f } : locate(bt, beat);
      const w = wavDef(o, c.v);
      const v = w ? (pool.numberFor(w) ?? c.v) : c.v;
      // 同じチャンネル・同じ所に2つは置かない（秒で合わせて丸めたときに重なることがある）
      const r = frac(pos.f.n, pos.f.d);
      const key = `${c.ch}:${pos.m}:${r.n}/${r.d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      used.add(v);
      out.chips.push({ id: out.nextId++, ch: c.ch, m: pos.m, f: { n: pos.f.n, d: pos.f.d }, v });
    }
    // 足した WAV の定義（この譜面で使うものだけ）
    for (const [no, w] of pool.added) {
      if (!used.has(no)) continue;
      const z = toBase36x2(no);
      setField(out, 'WAV' + z, w.path);
      if (w.label) setFieldComment(out, 'WAV' + z, w.label);
      if (Math.round(w.volume) !== 100) setField(out, 'VOLUME' + z, String(Math.round(w.volume)));
      if (Math.round(w.pan) !== 0) setField(out, 'PAN' + z, String(Math.round(w.pan)));
    }
    setField(out, 'DLEVEL', o.fields['DLEVEL']);
    setField(out, ORIGIN_KEY, undefined);
    return out;
  });
}
