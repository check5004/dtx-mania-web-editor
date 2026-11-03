// 音声ファイルのタグ（曲名・アーティスト・アルバム・年・ジャンル・BPM・埋め込みジャケット）を読む。
// MP3 の ID3v2/ID3v1、OGG/Opus と FLAC の Vorbis コメント、M4A の iTunes 形式、WAV の LIST INFO に対応。
// 日本の MP3 には「文字コード ISO-8859-1」と書いて実は Shift_JIS のタグが多いので、日本語として読めればそちらを使う。

export interface AudioPicture {
  mime: string;
  data: Uint8Array;
}

export interface AudioTags {
  format: 'id3v2' | 'id3v1' | 'vorbis' | 'flac' | 'mp4' | 'riff';
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: string;
  genre?: string;
  bpm?: number;
  track?: string;
  picture?: AudioPicture;
}

/** タグとして意味のある項目があるか */
export function hasTagInfo(t: AudioTags | null | undefined): t is AudioTags {
  return !!t && !!(t.title || t.artist || t.album || t.year || t.genre || t.picture);
}

// ---- 文字列 ------------------------------------------------------------------------

const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

/** ISO-8859-1 と書かれたバイト列。日本語の Shift_JIS として読めればそちらにする */
export function decodeLegacy(b: Uint8Array): string {
  let ascii = true;
  for (const x of b) if (x >= 0x80) ascii = false;
  if (ascii) return new TextDecoder('latin1').decode(b);
  try {
    const s = new TextDecoder('shift_jis', { fatal: true }).decode(b);
    if (JA.test(s)) return s;
  } catch {
    // Shift_JIS ではない
  }
  try {
    // UTF-8 をそのまま入れるソフトもある
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

function decodeUtf16(b: Uint8Array, bigEndianDefault: boolean): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  return new TextDecoder(bigEndianDefault ? 'utf-16be' : 'utf-16le').decode(b);
}

/** ID3 の文字コード番号でバイト列を読む */
function decodeId3Text(enc: number, b: Uint8Array): string {
  if (enc === 1) return decodeUtf16(b, false);
  if (enc === 2) return decodeUtf16(b, true);
  if (enc === 3) return new TextDecoder('utf-8').decode(b);
  return decodeLegacy(b);
}

/** 終端（NUL）までの位置。UTF-16 は2バイトの NUL */
function nulEnd(b: Uint8Array, from: number, wide: boolean): number {
  if (wide) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  for (let i = from; i < b.length; i++) if (b[i] === 0) return i;
  return b.length;
}

/** 複数の値（NUL 区切り）の最初だけ、前後の空白を取る */
const firstValue = (s: string) => s.split('\u0000').map((x) => x.trim()).find((x) => x !== '') ?? '';

const yearOf = (s: string | undefined) => (s ? (/(?:1[89]|20)\d{2}/.exec(s)?.[0] ?? '') : '');

/** ID3v1 のジャンル番号（0〜79 の標準） */
const V1_GENRES =
  'Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|Pop|R&B|Rap|Reggae|Rock|Techno|Industrial|Alternative|Ska|Death Metal|Pranks|Soundtrack|Euro-Techno|Ambient|Trip-Hop|Vocal|Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|AlternRock|Bass|Soul|Punk|Space|Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|Electronic|Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New Wave|Psychedelic|Rave|Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|Hard Rock'.split(
    '|',
  );

/** 「(17)」「17」「(17)Rock」のような ID3 のジャンルを名前にする */
export function genreName(raw: string): string {
  const s = raw.trim();
  const m = /^\((\d+)\)\s*(.*)$/.exec(s);
  if (m) return m[2].trim() || V1_GENRES[Number(m[1])] || '';
  if (/^\d+$/.test(s)) return V1_GENRES[Number(s)] ?? '';
  return s;
}

function clean(t: AudioTags): AudioTags {
  const out: AudioTags = { format: t.format };
  for (const k of ['title', 'artist', 'album', 'albumArtist', 'genre', 'track'] as const) {
    const v = t[k]?.replace(/\u0000/g, '').trim();
    if (v) out[k] = v;
  }
  const y = yearOf(t.year);
  if (y) out.year = y;
  if (t.bpm && Number.isFinite(t.bpm) && t.bpm > 20 && t.bpm < 1000) out.bpm = Math.round(t.bpm * 100) / 100;
  if (t.picture && t.picture.data.length > 64) out.picture = t.picture;
  return out;
}

// ---- ID3v2 ------------------------------------------------------------------------

const syncsafe = (b: Uint8Array, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be24 = (b: Uint8Array, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** 0xFF 0x00 → 0xFF（非同期化を戻す） */
function unsync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/** ID3v2 のタグ全体の長さ（ヘッダ10バイトを含む）。ID3v2 で始まらなければ 0 */
export function id3v2Size(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  return 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
}

const ID3_MAP: Record<string, keyof AudioTags> = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TPE2: 'albumArtist',
  TP2: 'albumArtist',
  TALB: 'album',
  TAL: 'album',
  TYER: 'year',
  TYE: 'year',
  TDRC: 'year',
  TDRL: 'year',
  TORY: 'year',
  TDOR: 'year',
  TCON: 'genre',
  TCO: 'genre',
  TBPM: 'bpm',
  TBP: 'bpm',
  TRCK: 'track',
  TRK: 'track',
};

export function parseId3v2(b: Uint8Array): AudioTags | null {
  if (id3v2Size(b) === 0) return null;
  const ver = b[3];
  if (ver < 2 || ver > 4) return null;
  const flags = b[5];
  const end = Math.min(b.length, 10 + syncsafe(b, 6));
  let body = b.subarray(10, end);
  if (ver < 4 && flags & 0x80) body = unsync(body);
  let p = 0;
  if (flags & 0x40 && ver >= 3) {
    // 拡張ヘッダを飛ばす
    p = ver === 4 ? syncsafe(body, 0) : be32(body, 0) + 4;
  }
  const t: AudioTags = { format: 'id3v2' };
  const pics: { type: number; pic: AudioPicture }[] = [];
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  const validId = (o: number) => {
    for (let i = 0; i < idLen; i++) {
      const c = body[o + i];
      if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
    }
    return true;
  };
  while (p + hdrLen <= body.length) {
    if (body[p] === 0) break; // 埋め草
    if (!validId(p)) break;
    const id = String.fromCharCode(...body.subarray(p, p + idLen));
    let size: number;
    if (ver === 2) size = be24(body, p + 3);
    else if (ver === 3) size = be32(body, p + 4);
    else {
      size = syncsafe(body, p + 4);
      // 同期安全でない長さを書くソフトがある。次の枠の名前で見分ける
      const plain = be32(body, p + 4);
      if (plain !== size && !validId(p + hdrLen + size) && validId(p + hdrLen + plain)) size = plain;
    }
    const fflags = ver === 2 ? 0 : (body[p + 8] << 8) | body[p + 9];
    let data = body.subarray(p + hdrLen, Math.min(body.length, p + hdrLen + size));
    p += hdrLen + size;
    if (ver === 3) {
      if (fflags & 0x00c0) continue; // 圧縮・暗号化
      if (fflags & 0x0020) data = data.subarray(1);
    } else if (ver === 4) {
      if (fflags & 0x000c) continue;
      if (fflags & 0x0040) data = data.subarray(1);
      if (fflags & 0x0001) data = data.subarray(4);
      if (fflags & 0x0002 || flags & 0x80) data = unsync(data);
    }
    if (data.length === 0) continue;
    const key = ID3_MAP[id];
    if (key) {
      const v = firstValue(decodeId3Text(data[0], data.subarray(1)));
      if (!v) continue;
      if (key === 'bpm') t.bpm = Number(v.replace(',', '.'));
      else if (key === 'genre') t.genre = genreName(v);
      else if (key === 'year') t.year = t.year && (id === 'TDRL' || id === 'TORY' || id === 'TDOR') ? t.year : v;
      else (t as unknown as Record<string, string>)[key] = v;
      continue;
    }
    if (id === 'APIC' || id === 'PIC') {
      const enc = data[0];
      let o = 1;
      let mime: string;
      if (id === 'PIC') {
        const fmt = String.fromCharCode(...data.subarray(1, 4)).toUpperCase();
        mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
        o = 4;
      } else {
        const e = nulEnd(data, 1, false);
        mime = new TextDecoder('latin1').decode(data.subarray(1, e)).toLowerCase() || 'image/jpeg';
        if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
        o = e + 1;
      }
      const type = data[o++];
      const wide = enc === 1 || enc === 2;
      o = nulEnd(data, o, wide) + (wide ? 2 : 1);
      const img = data.subarray(o);
      if (img.length > 64) pics.push({ type, pic: { mime: sniffMime(img) ?? mime, data: img.slice() } });
    }
  }
  const front = pics.find((x) => x.type === 3) ?? pics[0];
  if (front) t.picture = front.pic;
  return clean(t);
}

/** 先頭のバイトから画像の種類を見る（タグの MIME が間違っていることがある） */
export function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

// ---- ID3v1 ------------------------------------------------------------------------

export function parseId3v1(tail: Uint8Array): AudioTags | null {
  if (tail.length < 128) return null;
  const b = tail.subarray(tail.length - 128);
  if (b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return null;
  const field = (from: number, len: number) => {
    const s = b.subarray(from, from + len);
    const e = nulEnd(s, 0, false);
    return decodeLegacy(s.subarray(0, e)).replace(/\s+$/, '');
  };
  const g = b[127];
  return clean({
    format: 'id3v1',
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    year: field(93, 4),
    genre: g < V1_GENRES.length ? V1_GENRES[g] : undefined,
  });
}

// ---- Vorbis コメント（OGG・Opus・FLAC） ---------------------------------------------------

function base64Bytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** FLAC の PICTURE ブロック（METADATA_BLOCK_PICTURE と同じ形） */
function parseFlacPicture(b: Uint8Array): { type: number; pic: AudioPicture } | null {
  if (b.length < 32) return null;
  const type = be32(b, 0);
  let o = 4;
  const ml = be32(b, o);
  o += 4;
  const mime = new TextDecoder('latin1').decode(b.subarray(o, o + ml));
  o += ml;
  const dl = be32(b, o);
  o += 4 + dl + 16;
  const len = be32(b, o);
  o += 4;
  const data = b.subarray(o, o + len);
  if (data.length < 64) return null;
  return { type, pic: { mime: sniffMime(data) ?? (mime || 'image/jpeg'), data: data.slice() } };
}

/** Vorbis コメントの本体（vendor から） */
export function parseVorbisComment(b: Uint8Array, format: 'vorbis' | 'flac'): AudioTags {
  const t: AudioTags = { format };
  const pics: { type: number; pic: AudioPicture }[] = [];
  let o = 0;
  const vl = le32(b, o);
  o += 4 + vl;
  const n = le32(b, o);
  o += 4;
  const utf8 = new TextDecoder('utf-8');
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const len = le32(b, o);
    o += 4;
    const raw = b.subarray(o, o + len);
    o += len;
    const eq = raw.indexOf(0x3d);
    if (eq <= 0) continue;
    const k = new TextDecoder('latin1').decode(raw.subarray(0, eq)).toUpperCase();
    if (k === 'METADATA_BLOCK_PICTURE' || k === 'COVERART') {
      const bytes = base64Bytes(new TextDecoder('latin1').decode(raw.subarray(eq + 1)));
      if (!bytes) continue;
      if (k === 'COVERART') pics.push({ type: 3, pic: { mime: sniffMime(bytes) ?? 'image/jpeg', data: bytes } });
      else {
        const p = parseFlacPicture(bytes);
        if (p) pics.push(p);
      }
      continue;
    }
    const v = utf8.decode(raw.subarray(eq + 1)).trim();
    if (!v) continue;
    if (k === 'TITLE') t.title ??= v;
    else if (k === 'ARTIST') t.artist ??= v;
    else if (k === 'ALBUM') t.album ??= v;
    else if (k === 'ALBUMARTIST' || k === 'ALBUM ARTIST') t.albumArtist ??= v;
    else if (k === 'DATE' || k === 'YEAR' || k === 'ORIGINALDATE') t.year ??= v;
    else if (k === 'GENRE') t.genre ??= v;
    else if (k === 'BPM' || k === 'TEMPO') t.bpm ??= Number(v.replace(',', '.'));
    else if (k === 'TRACKNUMBER') t.track ??= v;
  }
  const front = pics.find((x) => x.type === 3) ?? pics[0];
  if (front) t.picture = front.pic;
  return t;
}

/** OGG（Vorbis・Opus）の先頭から、2つめのパケット（コメント）を組み立てて読む */
export function parseOgg(b: Uint8Array): AudioTags | null {
  const isPage = (p: number) => b[p] === 0x4f && b[p + 1] === 0x67 && b[p + 2] === 0x67 && b[p + 3] === 0x53;
  if (!isPage(0)) return null;
  const packets: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  const join = (list: Uint8Array[]) => {
    const out = new Uint8Array(list.reduce((a, c) => a + c.length, 0));
    let q = 0;
    for (const c of list) {
      out.set(c, q);
      q += c.length;
    }
    return out;
  };
  let serial = -1;
  let p = 0;
  while (p + 27 <= b.length && packets.length < 2 && isPage(p)) {
    const sn = le32(b, p + 14);
    const nseg = b[p + 26];
    const table = b.subarray(p + 27, p + 27 + nseg);
    let o = p + 27 + nseg;
    if (serial === -1) serial = sn;
    for (const seg of table) {
      if (sn === serial && packets.length < 2) {
        parts.push(b.subarray(o, o + seg));
        if (seg < 255) {
          packets.push(join(parts));
          parts = [];
        }
      }
      o += seg;
    }
    p = o;
  }
  // 大きな埋め込み画像でパケットが途中で切れていても、読めたところまで使う
  const comment = packets[1] ?? (packets.length === 1 && parts.length ? join(parts) : undefined);
  if (!comment || comment.length < 8) return null;
  const head = new TextDecoder('latin1').decode(comment.subarray(0, 8));
  let body: Uint8Array;
  if (comment[0] === 3 && head.slice(1, 7) === 'vorbis') body = comment.subarray(7);
  else if (head === 'OpusTags') body = comment.subarray(8);
  else return null;
  try {
    return clean(parseVorbisComment(body, 'vorbis'));
  } catch {
    return null;
  }
}

export function parseFlac(b: Uint8Array): AudioTags | null {
  if (!(b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43)) return null;
  let p = 4;
  let t: AudioTags = { format: 'flac' };
  let pic: { type: number; pic: AudioPicture } | null = null;
  while (p + 4 <= b.length) {
    const h = b[p];
    const type = h & 0x7f;
    const len = be24(b, p + 1);
    const data = b.subarray(p + 4, p + 4 + len);
    if (type === 4) t = { ...parseVorbisComment(data, 'flac'), picture: t.picture };
    else if (type === 6) {
      const x = parseFlacPicture(data);
      if (x && (!pic || x.type === 3)) pic = x;
    }
    p += 4 + len;
    if (h & 0x80) break;
  }
  if (!t.picture && pic) t.picture = pic.pic;
  return clean(t);
}

// ---- MP4（M4A） --------------------------------------------------------------------

/** moov の中身から iTunes 形式のタグを読む */
export function parseMp4Moov(moov: Uint8Array): AudioTags {
  const t: AudioTags = { format: 'mp4' };
  const atoms = (b: Uint8Array, from: number, to: number) => {
    const out: { type: string; start: number; end: number }[] = [];
    let p = from;
    while (p + 8 <= to) {
      let size = be32(b, p);
      const type = new TextDecoder('latin1').decode(b.subarray(p + 4, p + 8));
      let hdr = 8;
      if (size === 1) {
        size = be32(b, p + 12) + be32(b, p + 8) * 2 ** 32;
        hdr = 16;
      } else if (size === 0) size = to - p;
      if (size < hdr) break;
      out.push({ type, start: p + hdr, end: Math.min(to, p + size) });
      p += size;
    }
    return out;
  };
  const find = (list: { type: string; start: number; end: number }[], type: string) => list.find((a) => a.type === type);
  const udta = find(atoms(moov, 0, moov.length), 'udta');
  if (!udta) return t;
  const meta = find(atoms(moov, udta.start, udta.end), 'meta');
  if (!meta) return t;
  // meta は version/flags の4バイトのあとに子が続く（付いていないファイルもある）
  let metaKids = atoms(moov, meta.start + 4, meta.end);
  if (!find(metaKids, 'ilst')) metaKids = atoms(moov, meta.start, meta.end);
  const ilst = find(metaKids, 'ilst');
  if (!ilst) return t;
  const utf8 = new TextDecoder('utf-8');
  for (const item of atoms(moov, ilst.start, ilst.end)) {
    const data = find(atoms(moov, item.start, item.end), 'data');
    if (!data || data.end - data.start < 8) continue;
    const kind = be32(moov, data.start) & 0xffffff;
    const v = moov.subarray(data.start + 8, data.end);
    const text = () => (kind === 1 ? utf8.decode(v).trim() : '');
    switch (item.type) {
      case '©nam':
        t.title = text();
        break;
      case '©ART':
        t.artist = text();
        break;
      case 'aART':
        t.albumArtist = text();
        break;
      case '©alb':
        t.album = text();
        break;
      case '©day':
        t.year = text();
        break;
      case '©gen':
        t.genre = text();
        break;
      case 'gnre':
        if (v.length >= 2) t.genre = V1_GENRES[((v[0] << 8) | v[1]) - 1];
        break;
      case 'tmpo':
        if (v.length >= 2) t.bpm = (v[0] << 8) | v[1];
        break;
      case 'covr':
        if (v.length > 64) t.picture = { mime: sniffMime(v) ?? (kind === 14 ? 'image/png' : 'image/jpeg'), data: v.slice() };
        break;
    }
  }
  return t;
}

// ---- WAV（RIFF） -------------------------------------------------------------------

export function parseRiffInfo(list: Uint8Array): AudioTags {
  const t: AudioTags = { format: 'riff' };
  let p = 4; // 'INFO'
  while (p + 8 <= list.length) {
    const id = new TextDecoder('latin1').decode(list.subarray(p, p + 4));
    const len = le32(list, p + 4);
    const v = decodeLegacy(list.subarray(p + 8, p + 8 + len).filter((x) => x !== 0)).trim();
    if (id === 'INAM') t.title = v;
    else if (id === 'IART') t.artist = v;
    else if (id === 'IPRD') t.album = v;
    else if (id === 'ICRD') t.year = v;
    else if (id === 'IGNR') t.genre = v;
    p += 8 + len + (len & 1);
  }
  return t;
}

// ---- ファイルから ---------------------------------------------------------------------

async function bytesOf(f: Blob, from: number, to: number): Promise<Uint8Array> {
  return new Uint8Array(await f.slice(Math.max(0, from), Math.min(f.size, to)).arrayBuffer());
}

const MAX_TAG = 24 * 1024 * 1024;

/** 足りない項目を後ろのタグで埋める */
function merge(a: AudioTags | null, b: AudioTags | null): AudioTags | null {
  if (!a) return b;
  if (!b) return a;
  return { ...b, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== '')), format: a.format } as AudioTags;
}

/** 音声ファイルのタグを読む。読めなければ null（エラーにはしない） */
export async function readAudioTags(f: Blob): Promise<AudioTags | null> {
  try {
    const head = await bytesOf(f, 0, 64 * 1024);
    const s4 = new TextDecoder('latin1').decode(head.subarray(0, 4));
    // MP3（ID3v2 は先頭、ID3v1 は末尾）
    const v2size = id3v2Size(head);
    let v2: AudioTags | null = null;
    if (v2size > 0) v2 = parseId3v2(v2size <= head.length ? head : await bytesOf(f, 0, Math.min(v2size, MAX_TAG)));
    if (v2size > 0 || /\.mp3$/i.test((f as File).name ?? '') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
      const v1 = f.size >= 128 ? parseId3v1(await bytesOf(f, f.size - 128, f.size)) : null;
      const m = merge(v2, v1);
      if (m) return m;
    }
    if (s4 === 'OggS') return parseOgg(await bytesOf(f, 0, Math.min(f.size, 2 * 1024 * 1024)));
    if (s4 === 'fLaC') {
      // メタデータブロックは先頭に集まっている。画像が大きいと長くなる
      const b = await bytesOf(f, 0, Math.min(f.size, MAX_TAG));
      return parseFlac(b);
    }
    if (s4 === 'RIFF') return await readRiff(f);
    if (new TextDecoder('latin1').decode(head.subarray(4, 8)) === 'ftyp') return await readMp4(f);
    return null;
  } catch {
    return null;
  }
}

async function readMp4(f: Blob): Promise<AudioTags | null> {
  let p = 0;
  for (let i = 0; i < 64 && p + 8 <= f.size; i++) {
    const h = await bytesOf(f, p, p + 16);
    let size = be32(h, 0);
    const type = new TextDecoder('latin1').decode(h.subarray(4, 8));
    let hdr = 8;
    if (size === 1) {
      size = be32(h, 12) + be32(h, 8) * 2 ** 32;
      hdr = 16;
    } else if (size === 0) size = f.size - p;
    if (size < hdr) return null;
    if (type === 'moov') {
      if (size > MAX_TAG * 2) return null;
      return clean(parseMp4Moov(await bytesOf(f, p + hdr, p + size)));
    }
    p += size;
  }
  return null;
}

async function readRiff(f: Blob): Promise<AudioTags | null> {
  let p = 12;
  let out: AudioTags | null = null;
  for (let i = 0; i < 200 && p + 8 <= f.size; i++) {
    const h = await bytesOf(f, p, p + 12);
    const id = new TextDecoder('latin1').decode(h.subarray(0, 4));
    const len = le32(h, 4);
    if (id === 'LIST' && new TextDecoder('latin1').decode(h.subarray(8, 12)) === 'INFO' && len < 1024 * 1024) {
      out = merge(out, parseRiffInfo(await bytesOf(f, p + 8, p + 8 + len)));
    } else if ((id === 'id3 ' || id === 'ID3 ') && len < MAX_TAG) {
      out = merge(parseId3v2(await bytesOf(f, p + 8, p + 8 + len)), out);
    }
    p += 8 + len + (len & 1);
  }
  return out ? clean(out) : null;
}
