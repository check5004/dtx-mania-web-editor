// BGA（画像）と動画：#BMP・#AVI の一覧、置くときのレイヤー、譜面の BGA 列の表示。
import { tr } from '../i18n';
import { create } from 'zustand';
import { parseBase36x2, toBase36x2, toMeasure } from '../dtx/base36';
import { bgaChannel, BGA_CHANNELS, type DtxDoc } from '../dtx/model';
import { opPlace, setField, type Pos } from '../edit/ops';
import { findFile, type FolderFile } from '../fs/folder';
import { useDevice } from './device';
import { edit, toast, useEditor } from './editor';

export type MaterialKind = 'bmp' | 'avi';

export interface Material {
  kind: MaterialKind;
  no: number;
  /** ヘッダのキー（BMP0A・BMPTEX0A・AVI01 など） */
  key: string;
  path: string;
  /** 使っているチップの数 */
  uses: number;
}

export const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp)$/i;
export const MOVIE_EXT = /\.(avi|mp4|webm|mpe?g|wmv|m4v|mov)$/i;

interface BgaState {
  /** 置くときに使う素材 */
  kind: MaterialKind;
  no: number | null;
  /** 画像を置くレイヤー（チャンネル） */
  layer: number;
  /** 動画のチャンネル（54 か 5A） */
  movieCh: number;
  /** 譜面に BGA 列を出す（BGA が無い曲でも） */
  show: boolean;
  /** 列を広げてサムネイルを出す */
  wide: boolean;
}

export const useBga = create<BgaState>(() => ({ kind: 'bmp', no: null, layer: 0x04, movieCh: 0x54, show: false, wide: false }));

const hasCache = new WeakMap<DtxDoc, boolean>();

/** BGA・動画のチップか定義がある曲か */
export function hasBga(doc: DtxDoc): boolean {
  let v = hasCache.get(doc);
  if (v === undefined) {
    v = doc.chips.some((c) => bgaChannel(c.ch)) || Object.keys(doc.fields).some((k) => /^(BMP|BMPTEX|AVI|BGA)[0-9A-Z]{2}$/.test(k));
    hasCache.set(doc, v);
  }
  return v;
}

/** BGA の列を出すか。スマホは譜面の幅が足りないので、表示メニューで出したときだけ */
export function bgaVisible(): boolean {
  if (useDevice.getState().phone) return useBga.getState().show;
  return useBga.getState().show || hasBga(useEditor.getState().doc);
}

const matCache = new WeakMap<DtxDoc, Material[]>();

export function materials(doc: DtxDoc): Material[] {
  let v = matCache.get(doc);
  if (v) return v;
  const uses = new Map<string, number>();
  for (const c of doc.chips) {
    const b = bgaChannel(c.ch);
    if (!b) continue;
    const k = `${b.movie ? 'avi' : 'bmp'}:${c.v}`;
    uses.set(k, (uses.get(k) ?? 0) + 1);
  }
  v = [];
  for (const [key, path] of Object.entries(doc.fields)) {
    const m = /^(BMP|BMPTEX|AVI)([0-9A-Z]{2})$/.exec(key);
    if (!m) continue;
    const kind: MaterialKind = m[1] === 'AVI' ? 'avi' : 'bmp';
    const no = parseBase36x2(m[2]);
    if (no <= 0) continue;
    v.push({ kind, no, key, path, uses: uses.get(`${kind}:${no}`) ?? 0 });
  }
  v.sort((a, b) => a.no - b.no || a.key.localeCompare(b.key));
  matCache.set(doc, v);
  return v;
}

export function materialFile(path: string): FolderFile | undefined {
  const s = useEditor.getState();
  return findFile(s.folder, path, s.doc.fields['PATH_WAV'] ?? '');
}

function freeNo(doc: DtxDoc, kind: MaterialKind): number | null {
  const keys = kind === 'avi' ? ['AVI', 'AVIPAN'] : ['BMP', 'BMPTEX', 'BGA', 'BGAPAN'];
  for (let n = 1; n < 36 * 36; n++) {
    const z = toBase36x2(n);
    if (keys.some((k) => doc.fields[k + z] !== undefined)) continue;
    return n;
  }
  return null;
}

/** 曲フォルダのファイルを #BMP / #AVI に登録する */
export function addMaterials(kind: MaterialKind, paths: string[]): number {
  const s = useEditor.getState();
  const have = new Set(materials(s.doc).filter((m) => m.kind === kind).map((m) => m.path.toLowerCase()));
  const todo = paths.filter((p) => !have.has(p.toLowerCase()));
  if (!todo.length) return 0;
  let first: number | null = null;
  let n = 0;
  const what = kind === 'avi' ? tr('動画', 'video') : tr('画像', 'image');
  edit(tr(`${what}を${todo.length}個登録`, `Add ${todo.length} ${what}${todo.length === 1 ? '' : 's'}`), (d) => {
    for (const p of todo) {
      const no = freeNo(d as DtxDoc, kind);
      if (no === null) break;
      setField(d, (kind === 'avi' ? 'AVI' : 'BMP') + toBase36x2(no), p);
      first ??= no;
      n++;
    }
  });
  if (first !== null) useBga.setState({ kind, no: first, show: true });
  return n;
}

export function removeMaterial(key: string) {
  edit(tr(`#${key} を削除`, `Delete #${key}`), (d) => setField(d, key, undefined));
}

export function setMaterialPath(key: string, path: string) {
  edit(tr(`#${key} を変更`, `Change #${key}`), (d) => setField(d, key, path || undefined));
}

/** 置くときの素材を選ぶ */
export function pickMaterial(kind: MaterialKind, no: number) {
  useBga.setState({ kind, no, show: true });
}

/** BGA 列のその位置に、選んでいる素材を置く */
export function placeBga(pos: Pos) {
  const st = useBga.getState();
  if (st.no === null) {
    toast(tr('左の「画像」タブで、置く画像か動画を選んでください', 'Choose an image or video to place in the Images tab on the left'), 'info', 5000);
    useEditor.setState({ leftTab: 'bga' });
    return;
  }
  const ch = st.kind === 'avi' ? st.movieCh : st.layer;
  const name = BGA_CHANNELS.find((b) => b.ch === ch)?.name ?? '';
  let id = 0;
  const what = `${st.kind === 'avi' ? 'AVI' : 'BMP'}${toBase36x2(st.no)}`;
  edit(tr(`${name}に ${what} を置く（${toMeasure(pos.m)}）`, `Place ${what} on ${name} (${toMeasure(pos.m)})`), (d) => {
    id = opPlace(d, ch, pos, st.no!);
  });
  useEditor.setState({ selection: [id] });
}

/** チップのラベル（レイヤー番号と素材の番号） */
export function bgaChipLabel(ch: number, v: number): string {
  const b = bgaChannel(ch);
  if (!b) return '';
  const layer = b.movie ? (ch === 0x5a ? 'M+' : 'M') : String(((BGA_CHANNELS.findIndex((x) => x.ch === ch) % 8) + 1)) + (b.swap ? '′' : '');
  return `${layer}·${toBase36x2(v)}`;
}

/** その時刻に見えている BGA（レイヤーごとの最後の画像）と動画。プレビュー用 */
export function bgaAt(doc: DtxDoc, beatOf: (m: number, f: { n: number; d: number }) => number, beat: number): { layers: (Material | null)[]; movie: { m: Material; startBeat: number } | null } {
  const mats = materials(doc);
  const byKey = new Map(mats.map((m) => [`${m.kind}:${m.no}`, m]));
  const layers: (Material | null)[] = new Array(8).fill(null);
  const layerBeat: number[] = new Array(8).fill(-Infinity);
  let movie: { m: Material; startBeat: number } | null = null;
  for (const c of doc.chips) {
    const b = bgaChannel(c.ch);
    if (!b) continue;
    const at = beatOf(c.m, c.f);
    if (at > beat) continue;
    const mat = byKey.get(`${b.movie ? 'avi' : 'bmp'}:${c.v}`) ?? null;
    if (b.movie) {
      if (!movie || at >= movie.startBeat) movie = mat ? { m: mat, startBeat: at } : null;
      continue;
    }
    const li = BGA_CHANNELS.findIndex((x) => x.ch === c.ch) % 8;
    if (at >= layerBeat[li]) {
      layerBeat[li] = at;
      layers[li] = mat;
    }
  }
  return { layers, movie };
}
