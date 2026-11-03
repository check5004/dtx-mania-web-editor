// 作業ファイル（.dtxe.json）の中身。DTXには書けない補助情報（セクションのメモ、YouTube、拍アンカー）。
// NX はこのファイルを読まないので、無くても譜面は遊べる。
import { create } from 'zustand';

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
}

export interface SidecarData {
  sections: SectionMark[];
  /** セクション名 → 色（同じ名前は同じ色） */
  sectionColors: Record<string, string>;
  youtube: { url: string; offset: number } | null;
  /** テンポ合わせ画面の拍アンカー */
  anchors: TempoAnchor[];
  stems: StemTrack[];
  /** 解析（波形・原曲の打点・BPM推定）に使うステム。null なら原曲（BGM） */
  analysisStem: string | null;
  mix: SavedMix | null;
}

export interface SidecarState extends SidecarData {
  /** 保存していない変更があるか */
  dirty: boolean;
  /** 読み込み直すたびに増える（曲ごとの設定を当て直す合図） */
  loadSeq: number;
}

export const emptySidecar = (): SidecarData => ({ sections: [], sectionColors: {}, youtube: null, anchors: [], stems: [], analysisStem: null, mix: null });

export const useSidecar = create<SidecarState>(() => ({ ...emptySidecar(), dirty: false, loadSeq: 0 }));

export const SECTION_PRESETS: { name: string; color: string }[] = [
  { name: 'イントロ', color: '#8B95A4' },
  { name: 'Aメロ', color: '#4FA3E0' },
  { name: 'Bメロ', color: '#A08CF0' },
  { name: 'Cメロ', color: '#5BD69A' },
  { name: 'サビ', color: '#F0965A' },
  { name: '落ちサビ', color: '#D8B07A' },
  { name: 'ラスサビ', color: '#FF8A3D' },
  { name: '間奏', color: '#D6C85A' },
  { name: 'ソロ', color: '#E57BC4' },
  { name: 'ブレイク', color: '#6FC2D0' },
  { name: 'アウトロ', color: '#8B95A4' },
];

export const SECTION_COLORS = ['#8B95A4', '#4FA3E0', '#A08CF0', '#5BD69A', '#F0965A', '#FF8A3D', '#D6C85A', '#E57BC4', '#6FC2D0', '#EF5350'];

export function sectionColor(name: string, colors: Record<string, string> = useSidecar.getState().sectionColors): string {
  const own = colors[name];
  if (own) return own;
  const p = SECTION_PRESETS.find((x) => x.name === name);
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

function touch(p: Partial<SidecarData>) {
  set({ ...p, dirty: true });
}

export function loadSidecar(d: SidecarData | null) {
  set({ ...emptySidecar(), ...(d ?? {}), dirty: false, loadSeq: get().loadSeq + 1 });
}

export function markSidecarSaved() {
  set({ dirty: false });
}

export function sidecarData(): SidecarData {
  const s = get();
  return { sections: s.sections, sectionColors: s.sectionColors, youtube: s.youtube, anchors: s.anchors, stems: s.stems, analysisStem: s.analysisStem, mix: s.mix };
}

/** 書く中身が無いか（聴く音量だけなら、作業ファイルを新しく作るほどではない） */
export function sidecarIsEmpty(d: SidecarData = sidecarData()): boolean {
  return d.sections.length === 0 && Object.keys(d.sectionColors).length === 0 && !d.youtube && d.anchors.length === 0 && d.stems.length === 0;
}

/** ステムを書き換える（音量・パン・ずれは保存する変更、ミュート・ソロは聴くためだけなので quiet） */
export function setStems(stems: StemTrack[], opts: { quiet?: boolean } = {}) {
  if (opts.quiet) set({ stems });
  else touch({ stems });
}

export function setAnalysisStem(file: string | null) {
  touch({ analysisStem: file });
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

export function setYoutube(y: { url: string; offset: number } | null) {
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
    if (j.youtube && typeof j.youtube.url === 'string') out.youtube = { url: j.youtube.url, offset: Number(j.youtube.offset) || 0 };
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
    }
    if (typeof j.analysisStem === 'string' && out.stems.some((t) => t.file === j.analysisStem)) out.analysisStem = j.analysisStem;
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
    }
    return out;
  } catch {
    return null;
  }
}
