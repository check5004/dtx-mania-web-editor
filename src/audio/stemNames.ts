// ステムのファイル名から、種類（ドラム・ベース…）とトラックの名前を決める。
// 分離ソフト（Demucs・UVR・Moises など）や人が付けたいろいろな名前に合わせる：
//   drums.wav・Song (Drums).wav・1_Song_(No Drums).wav・曲_ドラム_mixed.mp3・ﾄﾞﾗﾑ.wav・01_Dr.wav・BassDrum.wav
// まとめて読み込んだときは、どのファイルにも付いている部分（曲名・_mixed など）を除いた残りを名前にする
// （back number - 水平線_弦楽器_mixed.mp3 → 弦楽器）。
import { tr, withTr } from '../i18n';
import type { StemKind, StemTrack } from '../store/sidecar';

type KindInfo = { kind: StemKind; label: string; labels: readonly [string, string]; color: string };
const kindInfo = (kind: StemKind, labels: readonly [string, string], color: string) => withTr({ kind, labels, color } as KindInfo, { label: labels });

/** 種類と、その名前（label は画面の言語。labels は日本語と英語） */
export const STEM_KINDS: KindInfo[] = [
  kindInfo('drums', ['ドラム', 'Drums'], '#F0965A'),
  kindInfo('bass', ['ベース', 'Bass'], '#A08CF0'),
  kindInfo('vocals', ['ボーカル', 'Vocals'], '#5BD69A'),
  kindInfo('guitar', ['ギター', 'Guitar'], '#4FA3E0'),
  kindInfo('piano', ['ピアノ', 'Piano'], '#E57BC4'),
  kindInfo('other', ['その他', 'Other'], '#D6C85A'),
];

export function stemKindInfo(kind: StemKind) {
  return STEM_KINDS.find((k) => k.kind === kind) ?? STEM_KINDS[STEM_KINDS.length - 1];
}

// ---- 文字をそろえる ---------------------------------------------------------------

/** 見せる形：分かれた濁点（Mac・Google ドライブの zip）・半角カナ・全角英数をそろえる */
// i18n-ignore-start
export function tidyName(s: string): string {
  return s.replace(/゛/g, '゙').replace(/゜/g, '゚').normalize('NFKC');
}

const kata = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

interface Folded {
  /** 比べる形：英字は小文字、ひらがなはカタカナ、camelCase の境目（SongDrums）に空白 */
  s: string;
  /** s の各文字の、見せる形での位置（最後に長さ） */
  at: number[];
}

function fold(t: string): Folded {
  let s = '';
  const at: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    const up = c >= 65 && c <= 90;
    if (up && i > 0) {
      const p = t.charCodeAt(i - 1);
      if (p >= 97 && p <= 122) {
        s += ' ';
        at.push(i);
      }
    }
    s += String.fromCharCode(up ? c + 32 : c >= 0x3041 && c <= 0x3096 ? c + 0x60 : c);
    at.push(i);
  }
  at.push(t.length);
  return { s, at };
}

// 区切り（ー はカタカナの一部なので入れない）
const SEP = String.raw`\s_\-.,()\[\]{}【】「」『』〔〕〈〉《》・/\\+&~〜'"!#@;=|–—―`;
const TOKEN = new RegExp(`[^${SEP}]+`, 'g');
const ONLY_SEP_DIGITS = new RegExp(`^[${SEP}\\d]*$`);
const AFTER_WORD = new RegExp(`^[${SEP}]*(\\d{1,2})?[${SEP}]*$`);
const TRAILING_NUM = /^[ _-]?(\d{1,2})(?!\d)/;
// i18n-ignore-end

// ---- 楽器の名前の表 -----------------------------------------------------------------

interface Word {
  re: RegExp;
  kind: StemKind;
  /** 名前の日本語と英語（null ならファイル名に書いてあるまま） */
  label: readonly [string, string] | null;
  /** 短くて別の意味もある略語（Dr・Ba・Vo など）。ほかに当たる語が無いときだけ使う */
  weak: boolean;
  /** 曲の音ではない（メトロノーム・クリック）。BGM にも試聴にも混ぜない */
  guide?: boolean;
}

const B = '(?<![a-z])';
const E = '(?![a-z])';
/** 英語の語（前後が英字でない） */
const en = (src: string, kind: StemKind, label: readonly [string, string], weak = false): Word => ({ re: new RegExp(`${B}(?:${src})${E}`, 'g'), kind, label, weak });
/** 英語の語の頭（drums・drumkit・vocals のように後ろに英字が続いてよい） */
const head = (src: string, kind: StemKind, label: readonly [string, string]): Word => ({ re: new RegExp(`${B}(?:${src})[a-z]*`, 'g'), kind, label, weak: false });
/** 日本語の語（後ろに続くカタカナも含める：ドラムス・ドラムセット）。ひらがなで書いてもよい。照合に使う i18n-ignore */
const ja = (src: string, kind: StemKind, label: readonly [string, string] | null = null, weak = false): Word => ({ re: new RegExp(`(?:${kata(src)})[ァ-ヺー]*`, 'g'), kind, label, weak });

// 日本語のファイル名の語（照合に使うので訳さない） i18n-ignore-start
const WORDS: Word[] = [
  // 曲の音ではないもの（Moises などが出すメトロノーム・クリック）
  { ...en('metronomes?|click[ _-]?tracks?|clicks?|count[ _-]?ins?', 'other', ['メトロノーム', 'Metronome']), guide: true },
  { ...ja('メトロノーム|クリック|カウント', 'other'), guide: true },
  // 「〜抜き」はその楽器ではない（ドラム抜きの BGM など）
  en('(?:no|without|minus)[ _-]?drums?|drum[ _-]?less|nodrums?', 'other', ['ドラム抜き', 'No drums']),
  ja('ドラム(?:抜き?|ぬき|なし|無し?|レス|オフ)|ノードラム', 'other'),
  en('(?:no|without|minus|off)[ _-]?(?:vocals?|vox)|vocal[ _-]?less|novocals?', 'other', ['ボーカル抜き', 'No vocals']),
  ja('(?:ボーカル|ヴォーカル)(?:抜き?|ぬき|なし|無し?|レス|オフ)|オフ[ _-]?(?:ボーカル|ヴォーカル)', 'other'),
  en('(?:no|without|minus)[ _-]?bass|bass[ _-]?less|nobass', 'other', ['ベース抜き', 'No bass']),
  ja('ベース(?:抜き?|ぬき|なし|無し?|レス)', 'other'),
  // ドラム（キック・スネアなど、パーツごとのステムもドラム）
  en('bass[ _-]?drums?', 'drums', ['キック', 'Kick']),
  head('kick', 'drums', ['キック', 'Kick']),
  en('bd|kd', 'drums', ['キック', 'Kick'], true),
  head('snare', 'drums', ['スネア', 'Snare']),
  en('rim[ _-]?(?:clicks?|shots?)|cross[ _-]?sticks?', 'drums', ['リム', 'Rim']),
  en('sd|snr', 'drums', ['スネア', 'Snare'], true),
  en('hi[ _-]?hats?', 'drums', ['ハイハット', 'Hi-hat']),
  en('hh|hats?', 'drums', ['ハイハット', 'Hi-hat'], true),
  head('cymbal', 'drums', ['シンバル', 'Cymbals']),
  en('toms|(?:floor|rack|hi|mid|low)[ _-]?toms?', 'drums', ['タム', 'Toms']),
  en('tom', 'drums', ['タム', 'Toms'], true),
  en('overheads?|ohs', 'drums', ['オーバーヘッド', 'Overheads']),
  head('perc', 'drums', ['パーカッション', 'Percussion']),
  head('drum', 'drums', ['ドラム', 'Drums']),
  en('drs?|kits?', 'drums', ['ドラム', 'Drums'], true),
  ja('バスドラム|バスドラ|ベースドラム|キック|スネア|ハイハット|シンバル|パーカッション|打楽器|太鼓|ドラム', 'drums'),
  { re: /(?<![ァ-ヺー])タム(?![ァ-ヺー])/g, kind: 'drums', label: null, weak: true },
  // ベース
  en('bass[ _-]?guitars?|contra[ _-]?bass|double[ _-]?bass', 'bass', ['ベース', 'Bass']),
  { re: /(?<![a-z])bass(?!oon)[a-z]*/g, kind: 'bass', label: ['ベース', 'Bass'], weak: false },
  en('ba|bs', 'bass', ['ベース', 'Bass'], true),
  ja('ベースギター|エレキベース|ウッドベース|シンセベース|ベース', 'bass'),
  // ボーカル
  en('(?:lead|main|ld)[ _-]?(?:vocals?|vox|voc)', 'vocals', ['リードボーカル', 'Lead vocals']),
  en('(?:backing|back|backup|bg)[ _-]?(?:vocals?|vox|voc)|bgvs?|bvox|harmon(?:y|ies)|choirs?|chorus', 'vocals', ['コーラス', 'Backing vocals']),
  en('a[ _-]?cap+el+a', 'vocals', ['アカペラ', 'A cappella']),
  head('vocal', 'vocals', ['ボーカル', 'Vocals']),
  en('vox|voc|voices?|singing|singer', 'vocals', ['ボーカル', 'Vocals']),
  en('vo|vc', 'vocals', ['ボーカル', 'Vocals'], true),
  en('rap', 'vocals', ['ラップ', 'Rap'], true),
  ja('リードボーカル|メインボーカル|コーラス|ハモリ|アカペラ|ボーカル|ヴォーカル|ボイス|ヴォイス|歌', 'vocals'),
  ja('うた|声|ラップ', 'vocals', null, true),
  // ギター
  head('guitar', 'guitar', ['ギター', 'Guitar']),
  en('gtrs?', 'guitar', ['ギター', 'Guitar']),
  en('gts?', 'guitar', ['ギター', 'Guitar'], true),
  ja('エレキギター|アコースティックギター|アコギ|エレアコ|エレキ|ギター', 'guitar'),
  // ピアノ・キーボード
  en('e[ _.-]?pianos?|electric[ _-]?pianos?|rhodes|wurli(?:tzer)?', 'piano', ['エレピ', 'E. piano']),
  head('piano', 'piano', ['ピアノ', 'Piano']),
  en('keys|keyboards?|kbd', 'piano', ['キーボード', 'Keys']),
  en('organs?', 'piano', ['オルガン', 'Organ']),
  en('pno|pf|key', 'piano', ['ピアノ', 'Piano'], true),
  ja('ピアノ|キーボード|鍵盤|エレピ|オルガン', 'piano'),
  // その他（ストリングス・ブラス・シンセなどもここ）
  en('others?', 'other', ['その他', 'Other']),
  en('rest|misc', 'other', ['その他', 'Other'], true),
  en('accompaniments?|accomp', 'other', ['伴奏', 'Accompaniment']),
  en('inst(?:rumentals?|s)?|instr', 'other', ['インスト', 'Instrumental']),
  en('karaoke', 'other', ['カラオケ', 'Karaoke']),
  en('strings?', 'other', ['ストリングス', 'Strings']),
  en('violins?|violas?', 'other', ['バイオリン', 'Violin']),
  en('cellos?', 'other', ['チェロ', 'Cello']),
  en('orchestral?|orch', 'other', ['オーケストラ', 'Orchestra']),
  en('brass|horns?|trumpets?|trombones?', 'other', ['ブラス', 'Brass']),
  en('sax(?:ophones?)?', 'other', ['サックス', 'Sax']),
  en('winds?|woodwinds?|flutes?|clarinets?', 'other', ['管楽器', 'Winds']),
  head('synth', 'other', ['シンセ', 'Synth']),
  en('s?fx|effects?|sound[ _-]?effects?', 'other', ['効果音', 'SFX']),
  en('se', 'other', ['効果音', 'SFX'], true),
  ja('その他|伴奏|インスト|カラオケ|オケ|弦楽器|ストリングス|バイオリン|ヴァイオリン|チェロ|オーケストラ|管楽器|金管|木管|ブラス|ホーン|サックス|トランペット|フルート|シンセ|効果音|エフェクト', 'other'),
  ja('弦', 'other', null, true),
];
// i18n-ignore-end

interface Hit {
  a: number;
  b: number;
  w: Word;
}

/** 楽器の語を探す（重なったら長いほう、同じ長さなら表の前のほう） */
function findWords(s: string): Hit[] {
  const hits: Hit[] = [];
  WORDS.forEach((w) => {
    for (const m of s.matchAll(w.re)) if (m[0].length) hits.push({ a: m.index!, b: m.index! + m[0].length, w });
  });
  hits.sort((p, q) => q.b - q.a - (p.b - p.a) || WORDS.indexOf(p.w) - WORDS.indexOf(q.w));
  const kept: Hit[] = [];
  for (const h of hits) if (!kept.some((k) => k.a < h.b && h.a < k.b)) kept.push(h);
  return kept.sort((p, q) => p.a - q.a);
}

/** 決め手の語：最後に出てくるもの（曲名は前、楽器は後ろに付くことが多い）。略語はほかに無いときだけ */
function pick(hits: Hit[]): Hit | null {
  const strong = hits.filter((h) => !h.w.weak);
  const use = strong.length ? strong : hits;
  return use.length ? use[use.length - 1] : null;
}

/** 語が楽器の語か（strong: はっきり楽器、weak: Dr・Gt などの略語） */
function wordClass(tok: string): 'strong' | 'weak' | null {
  const hits = findWords(tok);
  return hits.some((h) => !h.w.weak) ? 'strong' : hits.length ? 'weak' : null;
}

// ---- 名前を決める -----------------------------------------------------------------

interface Prep {
  tidy: string;
  f: Folded;
  toks: { s: string; a: number; b: number }[];
}

function prep(fileName: string): Prep {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[a-z0-9]{1,5}$/i, '');
  const tidy = tidyName(base);
  const f = fold(tidy);
  const toks = [...f.s.matchAll(TOKEN)].map((m) => ({ s: m[0], a: m.index!, b: m.index! + m[0].length }));
  return { tidy, f, toks };
}

/**
 * どのファイルにも同じに付いている、頭の語の数と終わりの語の数。楽器の語は残す。
 * 略語（Dr・Gt）は、残りにはっきりした楽器の語があるときだけ除く（Dr. Stone - drums は除き、Song_Gt Lead は残す）
 */
function commonEnds(list: Prep[]): [number, number] {
  const min = Math.min(...list.map((p) => p.toks.length));
  const strip = (at: (p: Prep) => number, rest: (p: Prep, i: number) => Prep['toks']) => {
    const s = list[0].toks[at(list[0])].s;
    if (!list.every((p) => p.toks[at(p)].s === s)) return false;
    const c = wordClass(s);
    if (c === 'strong') return false;
    return c === null || list.every((p) => rest(p, at(p)).some((t) => wordClass(t.s) === 'strong'));
  };
  let L = 0;
  while (
    L < min - 1 &&
    strip(
      () => L,
      (p, i) => p.toks.slice(i + 1),
    )
  )
    L++;
  let T = 0;
  while (
    L + T < min - 1 &&
    strip(
      (p) => p.toks.length - 1 - T,
      (p, i) => p.toks.slice(L, i),
    )
  )
    T++;
  return [L, T];
}

/** 同じ分け方で作ったファイルらしいか（頭か終わりの語が同じ） */
function related(p: Prep, q: Prep): boolean {
  if (!p.toks.length || !q.toks.length || p.f.s === q.f.s) return false;
  return p.toks[0].s === q.toks[0].s || p.toks[p.toks.length - 1].s === q.toks[q.toks.length - 1].s;
}

/** 語の名前（表の名前か、書いてあるまま）とすぐ後ろの番号（ボーカル1・Vocals 2） */
function wordName(p: Prep, off: number, h: Hit, num: boolean): string {
  const label = h.w.label ? tr(h.w.label[0], h.w.label[1]) : p.tidy.slice(p.f.at[off + h.a], p.f.at[off + h.b]);
  const n = num ? TRAILING_NUM.exec(p.f.s.slice(off + h.b)) : null;
  return label + (n ? String(Number(n[1])) : '');
}

const NOISE = /^(?:mixed|mix|mixdown|stems?|tracks?|master(?:ed)?|final|separated|split|extracted|isolated|h?t?demucs(?:_ft|_6s)?|spleeter|uvr|mdx(?:net)?|output|audio|copy|コピー|\d{1,3})$/;

/** 楽器の語が無いときの名前：ファイル名から曲名・アーティスト名と _mixed などを除く */
function plainName(p: Prep, hints: string[]): string {
  let s = p.tidy;
  for (const h of hints) {
    const t = tidyName(h).trim();
    if (t.length >= 2) s = s.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  const toks = s.split(new RegExp(`[${SEP}]+`)).filter(Boolean);
  const kept = toks.filter((t) => !NOISE.test(t.toLowerCase()));
  return (kept.length ? kept : toks).join(' ').trim() || p.tidy.trim() || tr('ステム', 'Stem');
}

/** 決め手の語から種類（と、曲の音ではないか） */
const fromWord = (w: Word | undefined, name: string): StemGuess => ({ kind: w?.kind ?? 'other', name, known: !!w, ...(w?.guide ? { guide: true } : {}) });

function guessOne(p: Prep, others: Prep[], hints: string[]): StemGuess {
  const whole = pick(findWords(p.f.s));
  if (others.length && p.toks.length) {
    const [L, T] = commonEnds([p, ...others]);
    if (L + T > 0) {
      // 共通の部分を除いた残り（水平線_ドラム_mixed → ドラム）
      const pa = p.toks[L].a;
      const pb = p.toks[p.toks.length - 1 - T].b;
      const sub = p.f.s.slice(pa, pb);
      const h = pick(findWords(sub));
      if (h && ONLY_SEP_DIGITS.test(sub.slice(0, h.a)) && AFTER_WORD.test(sub.slice(h.b))) return fromWord(h.w, wordName(p, pa, h, true));
      const text = p.tidy
        .slice(p.f.at[pa], p.f.at[pb])
        .replace(new RegExp(`^\\d{1,3}[${SEP}]+(?=\\S)`), '')
        .replace(/\s+/g, ' ')
        .trim();
      return fromWord((h ?? whole)?.w, text || plainName(p, hints));
    }
  }
  if (whole) return fromWord(whole.w, wordName(p, 0, whole, true));
  return fromWord(undefined, plainName(p, hints));
}

export interface StemGuess {
  kind: StemKind;
  name: string;
  /** 楽器の語から決めた（false：知らない名前なので「その他」にした） */
  known: boolean;
  /** 曲の音ではない（メトロノーム・クリック）。BGM にも試聴にも混ぜない */
  guide?: boolean;
}

export interface GuessOptions {
  /** もう読み込んであるステムのファイル（共通の部分を見つけるのに使う） */
  existing?: string[];
  /** もう使っている名前（重なれば番号を付ける） */
  taken?: string[];
  /** 曲名・アーティスト名（楽器の語が無いとき、名前から除く） */
  hints?: string[];
}

/** ファイル名から種類と名前を決める（まとめて読み込むファイルを一度に渡す） */
export function guessStems(fileNames: string[], o: GuessOptions = {}): StemGuess[] {
  const items = fileNames.map(prep);
  const pool = [...items, ...(o.existing ?? []).map(prep)];
  const taken = [...(o.taken ?? [])];
  const hints = (o.hints ?? []).filter(Boolean);
  return items.map((p) => {
    const g = guessOne(
      p,
      pool.filter((q) => q !== p && related(p, q)),
      hints,
    );
    g.name = uniqueStemName(g.name, taken);
    taken.push(g.name);
    return g;
  });
}

/** ファイル名から種類を決める */
export function detectStemKind(fileName: string): StemKind {
  return guessStems([fileName])[0].kind;
}

/** ほかのトラックと重ならない名前（重なれば ドラム2・ボーカル1-2 のように番号を付ける） */
export function uniqueStemName(name: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const sep = /\d$/.test(name) ? '-' : '';
  for (let i = 2; ; i++) if (!used.has(`${name}${sep}${i}`.toLowerCase())) return `${name}${sep}${i}`;
}

/** 表示名（種類のラベル。同じ種類が2本目以降なら番号を付ける） */
export function stemDisplayName(kind: StemKind, existing: string[]): string {
  return uniqueStemName(stemKindInfo(kind).label, existing);
}

/** 種類のラベルをそのまま使った名前か（その他・ドラム2・Drums2 など。どちらの言語でも。種類を変えたら名前も変えてよい） */
export function isKindLabel(name: string): boolean {
  return STEM_KINDS.some((k) => k.labels.some((l) => new RegExp(`^${l}\\d*(?:-\\d+)?$`).test(name)));
}

/**
 * 前の版で種類が分からず「その他」「その他2」…になっていたステムを、ファイル名から付け直す
 * （Mac・Google ドライブの zip の「ドラム」が読めなかった v0.10.1 まで。弦楽器のように表に無い語も名前にする）。
 * 自分で付けた名前は変えない。
 */
export function renameOldOtherStems(stems: StemTrack[]): StemTrack[] {
  const old = stems.filter((t) => t.kind === 'other' && /^その他\d*$/.test(t.name));
  if (!old.length) return stems;
  const rest = stems.filter((t) => !old.includes(t));
  const g = guessStems(
    old.map((t) => t.file),
    { existing: rest.map((t) => t.file), taken: rest.map((t) => t.name) },
  );
  return stems.map((t) => {
    const i = old.indexOf(t);
    return i < 0 ? t : { ...t, kind: g[i].kind, name: g[i].name };
  });
}

export interface StemFilePlan {
  /** 原曲（ステムに分ける前の音）らしいファイルの番号。無ければ null */
  original: number | null;
  /** ファイルごとの種類と名前（original の所は null） */
  items: (StemGuess | null)[];
  /** ステムとして扱うか（楽器の語から 2 種類以上見分けられた。メトロノームなどは数えない） */
  isStems: boolean;
  /** 曲名の案：原曲のファイル名、無ければステムの名前に共通の頭（Moises の「曲.m4a_ドラム_mixed」の「曲」）。分からなければ空 */
  title: string;
}

/** 名前の頭に付いた元のファイルの拡張子（Moises の「曲.m4a_ドラム」） */
const AUDIO_TOKEN = /^(?:m4a|mp3|wav|flac|ogg|opus|aac|aiff?|mp4|mov|webm)$/;

/** ステムの名前に共通の頭（曲名）。拡張子・_mixed などは除く */
function sharedTitle(fileNames: string[]): string {
  const list = fileNames.map(prep).filter((p) => p.toks.length);
  if (list.length < 2) return '';
  const [L] = commonEnds(list);
  const p = list[0];
  let n = L;
  while (n > 0 && (AUDIO_TOKEN.test(p.toks[n - 1].s) || NOISE.test(p.toks[n - 1].s))) n--;
  if (!n) return '';
  // 頭のかっこ（【MV】曲）から、最後の語のすぐ後ろの閉じかっこまで
  const end = p.f.at[p.toks[n - 1].b];
  const close = /^[)）\]】」』〕〉》]*/.exec(p.tidy.slice(end))![0].length;
  return p.tidy.slice(0, end + close).trim();
}

/**
 * まとめて入れた音のファイルが、分けてあるステム（Moises などの書き出し）かを見る。
 * 原曲が一緒にあれば見つける（楽器の語が無く、ほかの 2 本以上がその名前で始まる。Moises：曲.m4a と 曲.m4a_ドラム_mixed.mp3）
 */
export function planStemFiles(fileNames: string[], o: GuessOptions = {}): StemFilePlan {
  const base = (f: string) =>
    tidyName((f.split(/[\\/]/).pop() ?? f).replace(/\.[a-z0-9]{1,5}$/i, ''))
      .toLowerCase()
      .trim();
  const bases = fileNames.map(base);
  let original: number | null = null;
  let most = 1;
  bases.forEach((b, i) => {
    if (b.length < 2 || guessStems([fileNames[i]])[0].known) return;
    const n = bases.filter((x, j) => j !== i && x.length > b.length && x.startsWith(b)).length;
    if (n > most) {
      most = n;
      original = i;
    }
  });
  const rest = fileNames.map((f, i) => ({ f, i })).filter((x) => x.i !== original);
  const guesses = guessStems(
    rest.map((x) => x.f),
    o,
  );
  const items: (StemGuess | null)[] = fileNames.map(() => null);
  rest.forEach((x, k) => (items[x.i] = guesses[k]));
  const kinds = new Set(guesses.filter((g) => g.known && !g.guide).map((g) => g.kind));
  const title = original !== null ? prep(fileNames[original]).tidy.trim() : sharedTitle(rest.map((x) => x.f));
  return { original, items, isStems: kinds.size >= 2, title };
}
