// 特殊ノーツ（クラップなど）の音を譜面に登録する。種類かどうかは音で決まるので（dtx/kinds）、
// ある種類の音にしたい WAV が種類と読めなければ、同じファイル・音量・パンでその種類のラベルを付けた番号を探すか作る（スネアのリムと同じ。edit/rim）。
import type { Draft } from 'immer';
import { toBase36x2 } from '../dtx/base36';
import type { DtxDoc } from '../dtx/model';
import { kindLabel, kindOfSound, specialWavsOf } from '../dtx/kinds';
import { freeWavNumber, setField, setFieldComment } from './ops';

/**
 * WAV 番号 no の音を、種類 kind の音として鳴らす番号。no がもうその種類ならそのまま。
 * そうでなければ同じファイル・音量・パンで種類のラベルの番号を探すか作る。ラベルを付けても種類にならない音
 * （ファイル名がはっきりスネアなど）や、番号が足りないときは null
 */
export function kindWavFor(d: Draft<DtxDoc>, no: number, kind: string): number | null {
  const sp = specialWavsOf(d);
  if (sp.get(no) === kind) return no;
  const z = toBase36x2(no);
  const path = d.fields['WAV' + z];
  const label = kindLabel(kind);
  if (path === undefined || !label || kindOfSound(path, label) !== kind) return null;
  const same = (k: string, n: number) => (d.fields[k + z] ?? '') === (d.fields[k + toBase36x2(n)] ?? '');
  for (const [n, k] of sp) {
    if (k === kind && (d.fields['WAV' + toBase36x2(n)] ?? '').toLowerCase() === path.toLowerCase() && same('VOLUME', n) && same('PAN', n)) return n;
  }
  const nn = freeWavNumber(d as DtxDoc);
  if (nn === null) return null;
  const nz = toBase36x2(nn);
  setField(d, 'WAV' + nz, path);
  setFieldComment(d, 'WAV' + nz, label);
  for (const k of ['VOLUME', 'PAN']) if (d.fields[k + z] !== undefined) setField(d, k + nz, d.fields[k + z]);
  return nn;
}

/** ファイルを種類 kind の音として新しい WAV 番号に登録する（ラベルを付ける）。番号が足りなければ null */
export function addKindWav(d: Draft<DtxDoc>, file: string, kind: string): number | null {
  const no = freeWavNumber(d as DtxDoc);
  if (no === null) return null;
  const z = toBase36x2(no);
  setField(d, 'WAV' + z, file);
  const label = kindLabel(kind);
  if (label) setFieldComment(d, 'WAV' + z, label);
  return no;
}

/** ファイル file を鳴らす、種類 kind の WAV 番号（ベロシティ違いより、そのままの音）。無ければ null */
export function findKindWav(doc: Pick<DtxDoc, 'fields' | 'header'>, file: string, kind: string): number | null {
  const sp = specialWavsOf(doc);
  let hit: number | null = null;
  for (const [n, k] of sp) {
    if (k !== kind) continue;
    const z = toBase36x2(n);
    if ((doc.fields['WAV' + z] ?? '').toLowerCase() !== file.toLowerCase()) continue;
    if (hit === null || (doc.fields['VOLUME' + z] === undefined && doc.fields['VOLUME' + toBase36x2(hit)] !== undefined)) hit = n;
  }
  return hit;
}
