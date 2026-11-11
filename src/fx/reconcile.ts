// 譜面のチップの音を、カーブに合わせた「かけた音」にそろえる。かかるかどうかは時間とレーンだけで決まるので、
// どの編集のあとにも（置く・動かす・貼り付け・録音・MIDI・カーブを変える）ここを通し、かかる所のチップはかけた音に、
// 外れたチップは元の音にする。同じ音・同じ強さ・同じかけ方のチップは同じ WAV 番号を使う。
// - かけた音の #WAV の前の行に「;fx 元の音 かけ方」を書く（開き直したときに、どの音をどうかけたかが分かる）
// - 使わなくなったかけた音の #WAV と、その行は消す（読み込んだ譜面にあったものも。かけた音はいつでも作り直せる）
import { produceWithPatches, type Draft, type Patch } from 'immer';
import { toBase36x2 } from '../dtx/base36';
import { CH, drumChannel, isSeChannel, type DtxDoc, type HeaderLine } from '../dtx/model';
import type { TempoMap } from '../dtx/timing';
import { freeWavNumber, setField, setFieldComment } from '../edit/ops';
import { pruneVariants, usedWavs, wavPanOf, wavVolumeOf } from '../edit/velocity';
import { curveBeats, fxLineText, fxPath, parseFxLine, specText, type FxSide, type FxSpec } from './model';
import { chipSpec, type PlanEnv } from './plan';

export interface FxInfo {
  /** 元の音（#WAV に書くパス） */
  orig: string;
  spec: FxSpec;
}

const WAV_KEY = /^WAV[0-9A-Z]{2}$/;
const lower = (p: string) => p.trim().replace(/\\/g, '/').toLowerCase();

/** 譜面の「;fx」の行から、かけた音のパス（小文字）→ 元の音とかけ方 */
export function fxInfosOf(doc: Pick<DtxDoc, 'header'>): Map<string, FxInfo> {
  const out = new Map<string, FxInfo>();
  for (const h of doc.header) {
    if (h.kind !== 'raw') continue;
    const p = parseFxLine(h.text);
    if (p) out.set(lower(fxPath(p.orig, p.spec)), p);
  }
  return out;
}

/** 譜面にかけた音の #WAV があるか（パス小文字の集まりで） */
export function fxWavNumbers(doc: Pick<DtxDoc, 'fields'>, infos: ReadonlyMap<string, FxInfo>): Map<number, FxInfo> {
  const out = new Map<number, FxInfo>();
  if (!infos.size) return out;
  for (const [k, v] of Object.entries(doc.fields)) {
    if (!WAV_KEY.test(k)) continue;
    const info = infos.get(lower(v));
    if (info) out.set(parseInt(k.slice(3), 36), info);
  }
  return out;
}

export interface ReconcileEnv {
  side: FxSide;
  tempo: TempoMap;
  /** レーンの key（HH・SD など）→ レーンの番号 */
  laneIndex(key: string): number;
  /** 元の音の鳴っている長さ（秒。分からなければ 0）。ch はチップのチャンネル */
  soundSec(orig: string, ch: number): number;
  /** 譜面の行のほかに覚えている、かけた音（パス小文字 → 元の音とかけ方） */
  known?: ReadonlyMap<string, FxInfo>;
}

export interface Reconciled {
  doc: DtxDoc;
  redo: Patch[];
  undo: Patch[];
  /** 新しく使い始めた、かけた音（パス小文字 → 元の音とかけ方） */
  made: Map<string, FxInfo>;
  /** 音を替えたチップの数 */
  changed: number;
  /** WAV 番号が足りず、替えられなかったチップの数 */
  full: number;
}

interface Want {
  index: number;
  path: string;
  key: string;
  vol: number;
  pan: number;
  label: string | null;
  info: FxInfo | null;
}

function labelsOf(header: readonly HeaderLine[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (const h of header) if (h.kind === 'field' && WAV_KEY.test(h.key)) out.set(parseInt(h.key.slice(3), 36), h.comment?.trim() || null);
  return out;
}

const idKey = (pathLower: string, vol: number, pan: number, label: string | null) => `${pathLower}|${vol}|${pan}|${(label ?? '').toLowerCase()}`;

/**
 * 「;fx」の行の並びを直す必要があるか：かけた音のパスごとに 1 行、そのパスの最初の #WAV の直前に。
 * fxDefined はかけた音のパス（小文字）→ 情報（今の譜面に #WAV があるもの）
 */
function linesNeedFix(header: readonly HeaderLine[], fields: Record<string, string>, fxDefined: ReadonlyMap<string, FxInfo>, removed: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  const firstWav = new Map<string, number>();
  header.forEach((h, i) => {
    if (h.kind !== 'field' || !WAV_KEY.test(h.key) || removed.has(h.key)) return;
    const p = fields[h.key];
    if (p === undefined) return;
    const k = lower(p);
    if (fxDefined.has(k) && !firstWav.has(k)) firstWav.set(k, i);
  });
  for (let i = 0; i < header.length; i++) {
    const h = header[i];
    if (h.kind !== 'raw') continue;
    const p = parseFxLine(h.text);
    if (!p) continue;
    const k = lower(fxPath(p.orig, p.spec));
    if (seen.has(k) || !firstWav.has(k)) return true;
    // 直後の行がそのパスの最初の #WAV
    if (firstWav.get(k) !== i + 1) return true;
    seen.add(k);
  }
  return [...firstWav.keys()].some((k) => !seen.has(k));
}

/** 「;fx」の行を作り直す（パスごとに 1 行、最初の #WAV の直前に） */
function rewriteLines(d: Draft<DtxDoc>, fxDefined: ReadonlyMap<string, FxInfo>) {
  for (let i = d.header.length - 1; i >= 0; i--) {
    const h = d.header[i];
    if (h.kind === 'raw' && parseFxLine(h.text)) d.header.splice(i, 1);
  }
  const done = new Set<string>();
  for (let i = 0; i < d.header.length; i++) {
    const h = d.header[i];
    if (h.kind !== 'field' || !WAV_KEY.test(h.key)) continue;
    const p = d.fields[h.key];
    if (p === undefined) continue;
    const k = lower(p);
    const info = fxDefined.get(k);
    if (!info || done.has(k)) continue;
    done.add(k);
    d.header.splice(i, 0, { kind: 'raw', text: fxLineText(info.orig, info.spec) });
    i++;
  }
}

/**
 * 譜面のチップの音をカーブ（env.side）に合わせる。直すものが無ければ null。
 * 返すパッチは doc からのもの（編集のパッチのうしろに足せば、Ctrl+Z 1 回で一緒に戻る）
 */
export function reconcileFx(doc: DtxDoc, env: ReconcileEnv): Reconciled | null {
  const infos = fxInfosOf(doc);
  if (env.known) for (const [k, v] of env.known) if (!infos.has(k)) infos.set(k, v);
  const curves = env.side.curves.filter((c) => c.points.length > 0).map((c) => curveBeats(c, env.tempo, env.laneIndex));
  const fxNos = fxWavNumbers(doc, infos);
  if (!curves.length && !fxNos.size) return null;
  const plan: PlanEnv = { tempo: env.tempo, side: env.side, curves };
  const fields = doc.fields;
  const labels = labelsOf(doc.header);

  // いまの WAV 番号（パス・強さ・パン・ラベルが同じなら同じ音）
  const index = new Map<string, number>();
  const nos = Object.keys(fields)
    .filter((k) => WAV_KEY.test(k))
    .map((k) => parseInt(k.slice(3), 36))
    .sort((a, b) => a - b);
  for (const no of nos) {
    const key = idKey(lower(fields['WAV' + toBase36x2(no)]), Math.round(wavVolumeOf(fields, no)), Math.round(wavPanOf(fields, no)), labels.get(no) ?? null);
    if (!index.has(key)) index.set(key, no);
  }

  const wants: Want[] = [];
  const count = new Map<number, number>();
  for (let i = 0; i < doc.chips.length; i++) {
    const c = doc.chips[i];
    if (c.ch === CH.BPM || c.ch === CH.BPM_EX) continue;
    count.set(c.v, (count.get(c.v) ?? 0) + 1);
    const drum = drumChannel(c.ch);
    if (!drum && c.ch !== CH.BGM && !isSeChannel(c.ch)) continue;
    const path = fields['WAV' + toBase36x2(c.v)];
    if (path === undefined) continue;
    const info = infos.get(lower(path)) ?? null;
    let want: string;
    let spec: FxSpec | null = null;
    if (!drum) {
      // BGM・SE のチップは加工しない（かけた音になっていれば元の音へ）
      if (!info) continue;
      want = info.orig;
    } else {
      const orig = info ? info.orig : path;
      if (curves.length) spec = chipSpec(plan, drum.lane, env.tempo.beatOf(c.m, c.f), env.side.tails ? env.soundSec(orig, c.ch) : 0);
      want = spec ? fxPath(orig, spec) : orig;
      if (spec && info && specText(spec) === specText(info.spec) && lower(info.orig) === lower(orig)) want = path;
    }
    if (lower(want) === lower(path)) continue;
    const vol = Math.round(wavVolumeOf(fields, c.v));
    const pan = Math.round(wavPanOf(fields, c.v));
    const label = labels.get(c.v) ?? null;
    wants.push({ index: i, path: want, key: idKey(lower(want), vol, pan, label), vol, pan, label, info: spec ? { orig: info ? info.orig : path, spec } : null });
  }

  // 替えたあとに使われなくなる、かけた音の #WAV
  const after = new Map(count);
  for (const w of wants) {
    const v = doc.chips[w.index].v;
    after.set(v, (after.get(v) ?? 1) - 1);
  }
  const rawUsed = usedWavs({ chips: [], header: doc.header });
  const removed = new Set<string>();
  for (const [no] of fxNos) {
    if ((after.get(no) ?? 0) > 0 || rawUsed.has(no)) continue;
    // これから使う同じ音（同じパス・強さ・パン・ラベル）の番号なら残す
    if (wants.some((w) => index.get(w.key) === no)) continue;
    removed.add('WAV' + toBase36x2(no));
  }
  const fxDefined = new Map<string, FxInfo>();
  for (const [no, info] of fxNos) if (!removed.has('WAV' + toBase36x2(no))) fxDefined.set(lower(fields['WAV' + toBase36x2(no)]), info);
  for (const w of wants) if (w.info) fxDefined.set(lower(w.path), w.info);
  if (!wants.length && !removed.size && !linesNeedFix(doc.header, fields, fxDefined, removed)) return null;

  const made = new Map<string, FxInfo>();
  let changed = 0;
  let full = 0;
  const [next, redo, undo] = produceWithPatches(doc, (d) => {
    const fresh = new Map<string, number>();
    for (const w of wants) {
      let no = index.get(w.key) ?? fresh.get(w.key);
      if (no === undefined) {
        const n = freeWavNumber(d as DtxDoc);
        if (n === null) {
          full++;
          continue;
        }
        const z = toBase36x2(n);
        setField(d, 'WAV' + z, w.path);
        if (w.vol !== 100) setField(d, 'VOLUME' + z, String(w.vol));
        if (w.pan !== 0) setField(d, 'PAN' + z, String(w.pan));
        if (w.label) setFieldComment(d, 'WAV' + z, w.label);
        fresh.set(w.key, n);
        no = n;
      }
      if (w.info) made.set(lower(w.path), w.info);
      d.chips[w.index].v = no;
      changed++;
    }
    for (const k of removed) {
      const z = k.slice(3);
      for (const f of ['WAV', 'VOLUME', 'WAVVOL', 'PAN', 'WAVPAN']) if (d.fields[f + z] !== undefined) setField(d, f + z, undefined);
    }
    // 外へ動かして元の音に戻したチップのために作った強さ違いのうち、使わなくなったもの
    if (changed) pruneVariants(d);
    const defined = new Map<string, FxInfo>();
    for (const [k, v] of Object.entries(d.fields)) {
      if (!WAV_KEY.test(k)) continue;
      const info = fxDefined.get(lower(v)) ?? made.get(lower(v));
      if (info) defined.set(lower(v), info);
    }
    if (linesNeedFix(d.header as HeaderLine[], d.fields, defined, new Set())) rewriteLines(d, defined);
  });
  if (!redo.length) return null;
  return { doc: next, redo, undo, made, changed, full };
}
