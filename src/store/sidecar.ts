// 作業ファイル（.dtxe.json）の中身。DTXには書けない補助情報（セクションのメモ、YouTube、拍アンカー）。
// NX はこのファイルを読まないので、無くても譜面は遊べる。
import { withTr } from '../i18n';
import { create } from 'zustand';
import { renameOldOtherStems } from '../audio/stemNames';
import { drumChannel, isSeChannel } from '../dtx/model';

export interface SectionMark {
  /** この小節から始まる */
  m: number;
  name: string;
}

export interface TempoAnchor {
  /** 小節番号（この小節の頭） */
  m: number;
  /** 原曲の中の時刻（秒） */
  t: number;
}

export type StemKind = 'drums' | 'bass' | 'vocals' | 'guitar' | 'piano' | 'other';

/** ステム（原曲を楽器ごとに分けた音）。ファイルは曲フォルダの stems/ に置く */
export interface StemTrack {
  /** 曲フォルダからの相対パス（stems/drums.wav など）。トラックの id も兼ねる */
  file: string;
  name: string;
  kind: StemKind;
  /** 音量（1 = そのまま） */
  gain: number;
  /** パン（-1 左 〜 1 右） */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** 頭のずれ（ミリ秒）。正なら遅らせる */
  offsetMs: number;
}

export type ListenPreset = 'all' | 'game' | 'drums' | 'compare' | 'custom';

/** 聴くための音量（DTX や書き出しには影響しない） */
export interface SavedMix {
  bgm: number;
  drums: number;
  bgmMute: boolean;
  drumMute: boolean;
  metronome: boolean;
  click: number;
  clickBarOnly: boolean;
  listen: ListenPreset;
  /** 原曲のトラックのミュート（無ければ、ステムがあるときは消す） */
  origMute?: boolean;
  /** 原曲・譜面の音のトラックのソロ */
  origSolo?: boolean;
  drumSolo?: boolean;
  /** SE のトラックの音量・ミュート・ソロ */
  se?: number;
  seMute?: boolean;
  seSolo?: boolean;
}

/** 参照映像（YouTube）。動画の秒 = 原曲の秒 + offset（anchors があればその所の差 d を足す） */
export interface YoutubeRef {
  url: string;
  offset: number;
  /** 所ごとのずれの差（ライブのテンポ違い・編集違いのとき。自動で合わせたときだけ） */
  anchors?: { a: number; d: number }[];
  /** 自動で合わせた結果（const = ずれは一定、drift = 少しずつ変わる、edit = 途中で飛ぶ） */
  auto?: { kind: 'const' | 'drift' | 'edit'; conf: number; at: number };
}

/**
 * 自動で入れた小節（TAB補完・小節の生成・フレーズ候補・似た小節へのまとめての反映）と、入れたときのドラムの中身の印。
 * 中身が印のままなら「自動で入れたまま作者が確かめていない小節」として、AI の手本にしない（store/provenance）
 */
export interface AutoMark {
  m: number;
  sig: string;
}

/**
 * 特殊ノーツ（クラップ・タンバリンなど）の種類の決め。決まった種類（id が clap など）は行き先・キーなどだけ、
 * 自分で作った種類は名前・3 文字・色・ラベルも持つ（見分けるのはラベルが同じ音だけ。dtx/kinds）
 */
export interface SpecialDef {
  id: string;
  name?: string;
  code?: string;
  color?: string;
  label?: string;
  /** 行き先（ドラムのチャンネル）か「自動で鳴らす」。無ければ置いてあるチップから決める */
  dest?: number | 'auto';
  /** 自動で鳴らすときの SE のチャンネル */
  se?: number;
  /** 置くキー（KeyboardEvent.code。null は割り当てない） */
  key?: string | null;
  /** 電子ドラムのノート（null は割り当てない） */
  midi?: number | null;
  /** 決まった種類を特殊ノーツにしない（種類の設定の「特殊ノーツをやめる」） */
  off?: boolean;
}

export interface SpecialSide {
  /** 開いたときに分けない（お知らせの「元に戻す」）。譜面の音の見分け（置く音・キット）は変わらない */
  off?: boolean;
  kinds: SpecialDef[];
}

export interface SidecarData {
  sections: SectionMark[];
  /** セクション名 → 色（同じ名前は同じ色） */
  sectionColors: Record<string, string>;
  youtube: YoutubeRef | null;
  /** テンポ合わせ画面の拍アンカー */
  anchors: TempoAnchor[];
  stems: StemTrack[];
  /** 解析（波形・原曲の打点・BPM推定）に使うステム。null なら原曲（BGM） */
  analysisStem: string | null;
  mix: SavedMix | null;
  /** 自動で入れた小節 */
  auto: AutoMark[];
  /**
   * 完全な原曲（ステムに分ける前の、ドラムも入った原曲。曲フォルダの中のパス）。BGM をドラム抜きにしても、
   * 分け直す・試聴にする・曲を直すときのために覚えておく（無ければ null）
   */
  fullMix: string | null;
  /** 特殊ノーツの種類の決め（無ければ null。曲の音のものなので、同じ曲の別の難易度へも持っていく） */
  special: SpecialSide | null;
}

export interface SidecarState extends SidecarData {
  /** 保存していない変更があるか */
  dirty: boolean;
  /** 保存のあとに変えたもの（未保存の変更として見せる） */
  changed: (keyof SidecarData)[];
  /** 読み込み直すたびに増える（曲ごとの設定を当て直す合図） */
  loadSeq: number;
}

export const emptySidecar = (): SidecarData => ({ sections: [], sectionColors: {}, youtube: null, anchors: [], stems: [], analysisStem: null, mix: null, auto: [], fullMix: null, special: null });

export const useSidecar = create<SidecarState>(() => ({ ...emptySidecar(), dirty: false, changed: [], loadSeq: 0 }));

/** セクション名の候補。name は今の言語の名前。色はどちらの言語の名前でも同じ（names で引く） */
type SectionPreset = { name: string; names: readonly [string, string]; color: string };
const preset = (names: readonly [string, string], color: string): SectionPreset => withTr({ name: '', names, color }, { name: names });
export const SECTION_PRESETS: SectionPreset[] = [
  preset(['イントロ', 'Intro'], '#8B95A4'),
  preset(['Aメロ', 'Verse'], '#4FA3E0'),
  preset(['Bメロ', 'Pre-chorus'], '#A08CF0'),
  preset(['Cメロ', 'Bridge'], '#5BD69A'),
  preset(['サビ', 'Chorus'], '#F0965A'),
  preset(['落ちサビ', 'Quiet chorus'], '#D8B07A'),
  preset(['ラスサビ', 'Final chorus'], '#FF8A3D'),
  preset(['間奏', 'Interlude'], '#D6C85A'),
  preset(['ソロ', 'Solo'], '#E57BC4'),
  preset(['ブレイク', 'Break'], '#6FC2D0'),
  preset(['アウトロ', 'Outro'], '#8B95A4'),
];

export const SECTION_COLORS = ['#8B95A4', '#4FA3E0', '#A08CF0', '#5BD69A', '#F0965A', '#FF8A3D', '#D6C85A', '#E57BC4', '#6FC2D0', '#EF5350'];

export function sectionColor(name: string, colors: Record<string, string> = useSidecar.getState().sectionColors): string {
  const own = colors[name];
  if (own) return own;
  const p = SECTION_PRESETS.find((x) => x.names.includes(name));
  if (p) return p.color;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SECTION_COLORS[h % SECTION_COLORS.length];
}

/** 小節 m が入っているセクション */
export function sectionAt(sections: SectionMark[], m: number): SectionMark | null {
  let cur: SectionMark | null = null;
  for (const s of sections) {
    if (s.m <= m) cur = s;
    else break;
  }
  return cur;
}

const set = useSidecar.setState;
const get = useSidecar.getState;

/** 作業ファイルの中身を変える（保存していない変更になり、何を変えたかを覚える） */
export function updateSidecar(p: Partial<SidecarData>) {
  touch(p);
}

function touch(p: Partial<SidecarData>) {
  const keys = Object.keys(p) as (keyof SidecarData)[];
  const was = get().changed;
  set({ ...p, dirty: true, changed: keys.every((k) => was.includes(k)) ? was : [...was, ...keys.filter((k) => !was.includes(k))] });
}

export function loadSidecar(d: SidecarData | null) {
  set({ ...emptySidecar(), ...(d ?? {}), dirty: false, changed: [], loadSeq: get().loadSeq + 1 });
}

/**
 * 読み込んだ作業ファイルが、曲フォルダへ保存していない変更（自動保存の控え。分けたステムなど）だったとき：
 * その欄を保存していない変更にする（保存するまで「未保存」と出し、次の自動保存でも控えを曲フォルダの作業ファイルより優先する）
 */
export function markSidecarUnsaved(keys: readonly (keyof SidecarData)[]) {
  if (!keys.length) return;
  const was = get().changed;
  set({ dirty: true, changed: [...was, ...keys.filter((k) => !was.includes(k))] });
}

/** 2つの作業ファイルで違う欄（聴く音量は数えない。saved が無ければ空と比べる） */
export function sidecarDiff(saved: SidecarData | null, next: SidecarData): (keyof SidecarData)[] {
  const base = saved ?? emptySidecar();
  return (Object.keys(next) as (keyof SidecarData)[]).filter((k) => k !== 'mix' && JSON.stringify(base[k]) !== JSON.stringify(next[k]));
}

/** ステムのファイルが同じか（並びは問わない） */
export function sameStemFiles(a: readonly StemTrack[], b: readonly StemTrack[]): boolean {
  if (a.length !== b.length) return false;
  const fb = new Set(b.map((t) => t.file));
  return a.every((t) => fb.has(t.file));
}

/**
 * 同じ曲（原曲の音が同じ）の別の難易度へ切り替えるときに使う作業ファイル。
 * 切り替え先に作業ファイルが無い（AI難易度生成で作った譜面・作業ファイルを作っていない譜面）ときは、今の中身をそのまま使う。
 * 作業ファイルがあっても、ステム（と解析に使うステム）・参照映像が無ければ今のものを使う（譜面ごとではなく、曲の音のもの）。
 * こうしないと、切り替えるたびにステムを外して読み直し、波形・原曲の打点・スペクトルを作り直して、再生も鳴らし直す
 */
export function sameSongSidecar(next: SidecarData | null): SidecarData {
  const cur = sidecarData();
  // 自動で入れた小節の印は譜面ごと（別の難易度へは持っていかない）
  if (!next) return { ...cur, auto: [] };
  const out = { ...next };
  if (out.stems.length === 0 && cur.stems.length > 0) {
    out.stems = cur.stems;
    out.analysisStem = cur.analysisStem;
  }
  if (!out.youtube && cur.youtube) out.youtube = cur.youtube;
  if (!out.fullMix && cur.fullMix) out.fullMix = cur.fullMix;
  if (!out.special && cur.special) out.special = cur.special;
  return out;
}

/**
 * 同じ曲の別の難易度へ切り替えるときに読み込む作業ファイル。聴く設定（ミックス、ステムのミュート・ソロ）は今のまま引き継ぐ。
 * 再生を止めずに切り替えるので、鳴らす譜面のほかは聞こえ方を変えない（ステムのファイルが同じときに使う。違えば聴く設定の既定も違う）
 */
export function withListening(next: SidecarData | null): SidecarData {
  const cur = get();
  const d = next ?? emptySidecar();
  const now = new Map(cur.stems.map((t) => [t.file, t]));
  return {
    ...d,
    mix: cur.mix ?? d.mix,
    stems: d.stems.map((t) => {
      const c = now.get(t.file);
      return c && (c.mute !== t.mute || c.solo !== t.solo) ? { ...t, mute: c.mute, solo: c.solo } : t;
    }),
  };
}

export function markSidecarSaved() {
  set({ dirty: false, changed: [] });
}

export function sidecarData(): SidecarData {
  const s = get();
  return { sections: s.sections, sectionColors: s.sectionColors, youtube: s.youtube, anchors: s.anchors, stems: s.stems, analysisStem: s.analysisStem, mix: s.mix, auto: s.auto, fullMix: s.fullMix, special: s.special };
}

/** 書く中身が無いか（聴く音量だけなら、作業ファイルを新しく作るほどではない） */
export function sidecarIsEmpty(d: SidecarData = sidecarData()): boolean {
  return d.sections.length === 0 && Object.keys(d.sectionColors).length === 0 && !d.youtube && d.anchors.length === 0 && d.stems.length === 0 && d.auto.length === 0 && !d.fullMix && !d.special;
}

/** 特殊ノーツの種類の決めを書き換える */
export function setSpecialSide(special: SpecialSide | null) {
  touch({ special });
}

/** 自動で入れた小節の印を書き換える */
export function setAutoMarks(auto: AutoMark[]) {
  touch({ auto });
}

/** ステムを書き換える（音量・パン・ずれは保存する変更、ミュート・ソロは聴くためだけなので quiet） */
export function setStems(stems: StemTrack[], opts: { quiet?: boolean } = {}) {
  if (opts.quiet) set({ stems });
  else touch({ stems });
}

export function setAnalysisStem(file: string | null) {
  touch({ analysisStem: file });
}

/** 完全な原曲（ドラムの入った原曲）を覚える。同じなら何もしない */
export function setFullMix(path: string | null) {
  if ((get().fullMix ?? null) === path) return;
  touch({ fullMix: path });
}

/** 聴く音量を覚える（保存するまで書かないが、未保存の変更とは数えない） */
export function rememberMix(mix: SavedMix) {
  set({ mix });
}

export function setSection(m: number, name: string | null) {
  const rest = get().sections.filter((s) => s.m !== m);
  const next = name ? [...rest, { m, name }] : rest;
  touch({ sections: next.sort((a, b) => a.m - b.m) });
}

export function renameSection(m: number, name: string) {
  touch({ sections: get().sections.map((s) => (s.m === m ? { ...s, name } : s)) });
}

export function setSectionColor(name: string, color: string) {
  touch({ sectionColors: { ...get().sectionColors, [name]: color } });
}

/** 前のセクションとつなげる（この区切りを消す） */
export function removeSection(m: number) {
  setSection(m, null);
}

/** 参照映像を変える。動画が替わったら、前の動画で自動で合わせた結果（所ごとの差）は捨てる */
export function setYoutube(y: YoutubeRef | null) {
  const cur = get().youtube;
  if (y && cur && y.url !== cur.url && y.anchors === cur.anchors) y = { url: y.url, offset: y.offset };
  touch({ youtube: y });
}

export function setAnchors(anchors: TempoAnchor[]) {
  touch({ anchors: [...anchors].sort((a, b) => a.m - b.m) });
}

// ---- ファイル -------------------------------------------------------------------

export function sidecarName(dtxName: string): string {
  return dtxName.replace(/\.dtx$/i, '') + '.dtxe.json';
}

export function serializeSidecar(d: SidecarData): string {
  return JSON.stringify({ app: 'DTX Web Editor', version: 1, ...d }, null, 2) + '\n';
}

export function parseSidecar(text: string): SidecarData | null {
  try {
    const j = JSON.parse(text) as Partial<SidecarData>;
    const out = emptySidecar();
    if (Array.isArray(j.sections)) out.sections = j.sections.filter((s) => s && Number.isFinite(s.m) && typeof s.name === 'string').map((s) => ({ m: Math.trunc(s.m), name: s.name }));
    out.sections.sort((a, b) => a.m - b.m);
    if (j.sectionColors && typeof j.sectionColors === 'object') {
      for (const [k, v] of Object.entries(j.sectionColors)) if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out.sectionColors[k] = v;
    }
    if (j.youtube && typeof j.youtube.url === 'string') {
      const y: YoutubeRef = { url: j.youtube.url, offset: Number(j.youtube.offset) || 0 };
      const an = (j.youtube as Partial<YoutubeRef>).anchors;
      if (Array.isArray(an)) {
        const ok = an.filter((x) => x && Number.isFinite(x.a) && Number.isFinite(x.d)).map((x) => ({ a: x.a, d: x.d }));
        if (ok.length) y.anchors = ok.sort((p, q) => p.a - q.a);
      }
      const au = (j.youtube as Partial<YoutubeRef>).auto;
      if (au && (au.kind === 'const' || au.kind === 'drift' || au.kind === 'edit') && Number.isFinite(au.conf)) y.auto = { kind: au.kind, conf: Number(au.conf), at: Number(au.at) || 0 };
      out.youtube = y;
    }
    if (Array.isArray(j.anchors)) out.anchors = j.anchors.filter((a) => a && Number.isFinite(a.m) && Number.isFinite(a.t)).map((a) => ({ m: Math.trunc(a.m), t: a.t }));
    if (Array.isArray(j.stems)) {
      const kinds: StemKind[] = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'];
      const n = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def);
      out.stems = j.stems
        .filter((t) => t && typeof t.file === 'string' && t.file)
        .map((t) => ({
          file: t.file,
          name: typeof t.name === 'string' ? t.name : t.file.split('/').pop()!,
          kind: kinds.includes(t.kind) ? t.kind : 'other',
          gain: n(t.gain, 1, 0, 2),
          pan: n(t.pan, 0, -1, 1),
          mute: !!t.mute,
          solo: !!t.solo,
          offsetMs: n(t.offsetMs, 0, -60000, 60000),
        }));
      // 前の版で種類が分からず「その他」になっていたステムは、ファイル名から付け直す
      out.stems = renameOldOtherStems(out.stems);
    }
    if (typeof j.analysisStem === 'string' && out.stems.some((t) => t.file === j.analysisStem)) out.analysisStem = j.analysisStem;
    if (typeof j.fullMix === 'string' && j.fullMix.trim()) out.fullMix = j.fullMix;
    if (j.special && typeof j.special === 'object') out.special = parseSpecial(j.special);
    if (Array.isArray(j.auto)) {
      const seen = new Set<number>();
      for (const a of j.auto) {
        if (!a || !Number.isFinite(a.m) || a.m < 0 || typeof a.sig !== 'string' || !a.sig || a.sig.length > 32) continue;
        const m = Math.trunc(a.m);
        if (seen.has(m)) continue;
        seen.add(m);
        out.auto.push({ m, sig: a.sig });
      }
      out.auto.sort((a, b) => a.m - b.m);
    }
    if (j.mix && typeof j.mix === 'object') {
      const m = j.mix as Partial<SavedMix>;
      const v = (x: unknown, def: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1.5, x)) : def);
      const listens: ListenPreset[] = ['all', 'game', 'drums', 'compare', 'custom'];
      out.mix = {
        bgm: v(m.bgm, 0.8),
        drums: v(m.drums, 0.9),
        bgmMute: !!m.bgmMute,
        drumMute: !!m.drumMute,
        metronome: !!m.metronome,
        click: v(m.click, 0.5),
        clickBarOnly: !!m.clickBarOnly,
        listen: listens.includes(m.listen as ListenPreset) ? (m.listen as ListenPreset) : 'all',
      };
      const b = (x: unknown) => (typeof x === 'boolean' ? x : undefined);
      if (b(m.origMute) !== undefined) out.mix.origMute = b(m.origMute);
      if (b(m.origSolo) !== undefined) out.mix.origSolo = b(m.origSolo);
      if (b(m.drumSolo) !== undefined) out.mix.drumSolo = b(m.drumSolo);
      if (typeof m.se === 'number') out.mix.se = Math.min(1, v(m.se, 1));
      if (b(m.seMute) !== undefined) out.mix.seMute = b(m.seMute);
      if (b(m.seSolo) !== undefined) out.mix.seSolo = b(m.seSolo);
    }
    return out;
  } catch {
    return null;
  }
}

/** 作業ファイルの特殊ノーツの決め（読めない欄は捨てる） */
function parseSpecial(j: Partial<SpecialSide>): SpecialSide | null {
  const kinds: SpecialDef[] = [];
  const seen = new Set<string>();
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
  if (Array.isArray(j.kinds)) {
    for (const k of j.kinds as Partial<SpecialDef>[]) {
      const id = k && str(k.id, 40);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const d: SpecialDef = { id };
      const name = str(k.name, 60);
      if (name) d.name = name;
      const code = str(k.code, 3);
      if (code) d.code = code.toUpperCase();
      if (typeof k.color === 'string' && /^#[0-9a-f]{6}$/i.test(k.color)) d.color = k.color;
      const label = str(k.label, 60);
      if (label && !/[;\r\n]/.test(label)) d.label = label;
      // 行き先はドラムの通常チャンネル、自動で鳴らすのは SE のチャンネルだけ
      if (k.dest === 'auto' || (typeof k.dest === 'number' && drumChannel(k.dest)?.kind === 'normal')) d.dest = k.dest;
      if (typeof k.se === 'number' && isSeChannel(k.se)) d.se = k.se;
      if (k.key === null || (typeof k.key === 'string' && /^[A-Za-z0-9]{1,20}$/.test(k.key))) d.key = k.key;
      if (k.midi === null || (typeof k.midi === 'number' && Number.isInteger(k.midi) && k.midi >= 0 && k.midi < 128)) d.midi = k.midi;
      if (k.off === true) d.off = true;
      kinds.push(d);
    }
  }
  if (!kinds.length && !j.off) return null;
  return { ...(j.off ? { off: true } : {}), kinds };
}
