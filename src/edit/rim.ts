// リムの音を譜面に登録する（WAV 番号を探す・足す）。リムかどうかは音で決まるので（dtx/rim）、
// スネアの音とリムの音は同じファイルでも別の WAV 番号にし、リムの方にはラベル「Snare Rim」を付ける。
import type { Draft } from 'immer';
import { toBase36x2 } from '../dtx/base36';
import type { DtxDoc } from '../dtx/model';
import { isRimSound, RIM_LABEL, rimWavsOf, wavLabel } from '../dtx/rim';
import { freeWavNumber, setField, setFieldComment } from './ops';

type Doc = Pick<DtxDoc, 'fields' | 'header'>;

/**
 * ファイル file を鳴らす WAV 番号（リムの音かが rim と同じものだけ）。
 * ベロシティ違い（#VOLUME 付き）より、そのままの音を選ぶ。無ければ null
 */
export function findWavByFile(doc: Doc, file: string, rim: boolean, rims: ReadonlySet<number> = rimWavsOf(doc)): number | null {
  let hit: number | null = null;
  for (const [k, v] of Object.entries(doc.fields)) {
    if (!/^WAV[0-9A-Z]{2}$/.test(k) || v.toLowerCase() !== file.toLowerCase()) continue;
    const no = parseInt(k.slice(3), 36);
    if (rims.has(no) !== rim) continue;
    if (hit === null || (doc.fields['VOLUME' + k.slice(3)] === undefined && doc.fields['VOLUME' + toBase36x2(hit)] !== undefined)) hit = no;
  }
  return hit;
}

/** ファイルを新しい WAV 番号に登録する。リムの音ならラベル「Snare Rim」を付ける。番号が足りなければ null */
export function addWav(d: Draft<DtxDoc>, file: string, rim: boolean): number | null {
  const no = freeWavNumber(d as DtxDoc);
  if (no === null) return null;
  const z = toBase36x2(no);
  setField(d, 'WAV' + z, file);
  if (rim) setFieldComment(d, 'WAV' + z, RIM_LABEL);
  return no;
}

/**
 * WAV 番号 no の音をリムとして鳴らす番号。no がリムの音ならそのまま。
 * そうでなければ（スネアの音などを選んだとき）、同じファイル・音量・パンでラベル「Snare Rim」の番号を探すか作る。
 * 番号が足りなければ no のまま
 */
export function rimWavFor(d: Draft<DtxDoc>, no: number): number {
  const rims = rimWavsOf(d);
  if (rims.has(no)) return no;
  const z = toBase36x2(no);
  const path = d.fields['WAV' + z];
  // ラベルを付けてもリムにならない音（ファイル名がはっきりほかの楽器）は、そのまま鳴らす（番号を作り続けない）
  if (path === undefined || !isRimSound(path, RIM_LABEL)) return no;
  const same = (k: string, n: number) => (d.fields[k + z] ?? '') === (d.fields[k + toBase36x2(n)] ?? '');
  for (const r of rims) {
    if ((d.fields['WAV' + toBase36x2(r)] ?? '').toLowerCase() === path.toLowerCase() && same('VOLUME', r) && same('PAN', r)) return r;
  }
  const nn = addWav(d, path, true);
  if (nn === null) return no;
  const nz = toBase36x2(nn);
  for (const k of ['VOLUME', 'PAN']) if (d.fields[k + z] !== undefined) setField(d, k + nz, d.fields[k + z]);
  return nn;
}

/** WAV 番号 to に from のラベルを写す（ベロシティ違いを足したとき。リムのラベルが落ちないように） */
export function copyWavLabel(d: Draft<DtxDoc>, from: number, to: number) {
  const label = wavLabel(d as DtxDoc, from);
  if (label) setFieldComment(d, 'WAV' + toBase36x2(to), label);
}
