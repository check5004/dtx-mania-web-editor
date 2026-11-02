// DTXテキストへの書き出し。ヘッダは読み込んだ順に、チップは小節ごとに最小の分割数で書き出す。
import { toBase36x2, toHex2, toMeasure } from './base36';
import { cmp, lcm } from './fraction';
import { CH, type Chip, type DtxDoc, type HeaderLine } from './model';

/** 1行の分割数の上限。これを超える組み合わせは行を分ける（NXは1小節384分割で読む） */
const MAX_LINE_DIVISION = 1920;

export function formatBarLength(x: number): string {
  const s = String(x);
  if (s.length <= 10) return s;
  return String(Number(x.toFixed(6)));
}

export function headerLineText(line: HeaderLine, fields: Record<string, string>): string | null {
  if (line.kind === 'raw') return line.text;
  const value = fields[line.key];
  if (value === undefined) return null; // 削除された
  if (line.orig && line.orig.value === value) return line.orig.text;
  const sep = line.sep === '' ? (value === '' ? '' : ' ') : line.sep.startsWith(':') ? ': ' : line.sep;
  return `#${line.name}${sep}${value}${line.comment !== null ? ` ;${line.comment}` : ''}`;
}

interface LineBucket {
  den: number;
  chips: Chip[];
}

/** 同じ小節・チャンネルのチップを、位置の重なりと分割数の上限を守って行に振り分ける */
export function packChipLines(chips: Chip[]): LineBucket[] {
  const sorted = [...chips].sort((a, b) => cmp(a.f, b.f) || a.id - b.id);
  const lines: LineBucket[] = [];
  for (const c of sorted) {
    let placed = false;
    for (const ln of lines) {
      const den = lcm(ln.den, c.f.d);
      if (den > MAX_LINE_DIVISION) continue;
      if (ln.chips.some((o) => o.f.n === c.f.n && o.f.d === c.f.d)) continue;
      ln.den = den;
      ln.chips.push(c);
      placed = true;
      break;
    }
    if (!placed) lines.push({ den: c.f.d, chips: [c] });
  }
  return lines;
}

function lineData(ch: number, bucket: LineBucket): string {
  const slots: string[] = new Array(bucket.den).fill('00');
  for (const c of bucket.chips) {
    const idx = (c.f.n * bucket.den) / c.f.d;
    slots[idx] = ch === CH.BPM ? toHex2(c.v) : toBase36x2(c.v);
  }
  return slots.join('');
}

export function serializeChips(doc: Pick<DtxDoc, 'chips' | 'barLengths'>): string[] {
  const out: string[] = [];
  const byMeasure = new Map<number, Map<number, Chip[]>>();
  for (const c of doc.chips) {
    let mm = byMeasure.get(c.m);
    if (!mm) byMeasure.set(c.m, (mm = new Map()));
    let list = mm.get(c.ch);
    if (!list) mm.set(c.ch, (list = []));
    list.push(c);
  }
  const measures = new Set<number>([...byMeasure.keys(), ...Object.keys(doc.barLengths).map(Number)]);
  for (const m of [...measures].sort((a, b) => a - b)) {
    const bl = doc.barLengths[m];
    if (bl !== undefined) out.push(`#${toMeasure(m)}02: ${formatBarLength(bl)}`);
    const mm = byMeasure.get(m);
    if (!mm) continue;
    for (const ch of [...mm.keys()].sort((a, b) => a - b)) {
      for (const bucket of packChipLines(mm.get(ch)!)) {
        out.push(`#${toMeasure(m)}${toHex2(ch)}: ${lineData(ch, bucket)}`);
      }
    }
  }
  return out;
}

export function serializeHeader(doc: Pick<DtxDoc, 'header' | 'fields'>): string[] {
  const out: string[] = [];
  for (const line of doc.header) {
    const t = headerLineText(line, doc.fields);
    if (t !== null) out.push(t);
  }
  return out;
}

/** DTXテキストを作る（改行は CRLF） */
export function serializeDtx(doc: DtxDoc): string {
  const head = serializeHeader(doc);
  while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
  const chips = serializeChips(doc);
  const all = chips.length > 0 ? [...head, '', ...chips] : head;
  return all.join('\r\n') + '\r\n';
}

