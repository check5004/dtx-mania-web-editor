// NX（Shift_JIS で譜面を読む）で読めるファイル名か・読める名前の作り方。曲フォルダのファイルを「?」になった名前からも見つける。
import { describe, expect, it } from 'vitest';
import { sjisRoundTrip } from '../dtx/encoding';
import { findFile, folderFromFiles } from './folder';
import { isNxSafeName, isNxSafePath, nxSafeBase, nxSafeName, nxSafePath } from './nxName';

describe('NX で読めるファイル名', () => {
  it('Shift_JIS で書けて同じ文字に戻る名前だけを読める名前とみなす', () => {
    expect(isNxSafeName('bgm.ogg')).toBe(true);
    expect(isNxSafeName('ドラム抜き①.ogg')).toBe(true);
    expect(isNxSafeName('Love♡song.ogg')).toBe(false);
    expect(isNxSafeName('Café.ogg')).toBe(false);
    expect(isNxSafeName('🥁.ogg')).toBe(false);
    // 「〜」は「～」になって書かれるので、曲フォルダのファイルとは別の名前になる
    expect(isNxSafeName('A〜B.ogg')).toBe(false);
    // 「;」から先はコメント、前後の空白は落とされる、Windows で使えない文字・最後の点
    expect(isNxSafeName('a;b.ogg')).toBe(false);
    expect(isNxSafeName(' bgm.ogg')).toBe(false);
    expect(isNxSafeName('a?.ogg')).toBe(false);
    expect(isNxSafeName('bgm.')).toBe(false);
    expect(isNxSafePath('stems/bgm_drums.ogg')).toBe(true);
    expect(isNxSafePath('曲♡/bgm.ogg')).toBe(false);
  });

  it('書けない文字は見た目の近い文字か「_」にし、拡張子は残す', () => {
    expect(nxSafeName('bgm.ogg')).toBe('bgm.ogg');
    expect(nxSafeName('Love♡song.ogg')).toBe('Love_song.ogg');
    expect(nxSafeName('Café Olé.ogg')).toBe('Cafe Ole.ogg');
    expect(nxSafeName('A〜B.ogg')).toBe('A～B.ogg');
    expect(nxSafeName('Straße.wav')).toBe('Strasse.wav');
    expect(nxSafeName('a♡♡♡b.ogg')).toBe('a_b.ogg');
    expect(nxSafeName('a_♡b.ogg')).toBe('a_b.ogg');
    expect(nxSafeName('x;y.ogg')).toBe('x_y.ogg');
    expect(nxSafeName(' 前後 .ogg')).toBe('前後.ogg');
    // 名前が何も残らなければ fallback
    expect(nxSafeName('♡♡.ogg', 'preview')).toBe('preview.ogg');
    // Windows で使えない名前
    expect(nxSafeName('con.ogg')).toBe('con_.ogg');
    // 直した名前は、書いて読み戻しても同じ
    for (const n of ['Love♡song.ogg', 'Café.ogg', 'A〜B.ogg', '🥁 drums.ogg']) {
      const safe = nxSafeName(n);
      expect(isNxSafeName(safe)).toBe(true);
      expect(sjisRoundTrip(safe)).toBe(safe);
    }
    expect(nxSafePath('曲♡/bgm♡.ogg')).toBe('曲_/bgm_.ogg');
  });

  it('名前の頭（ステムの名前のもと）は、最後の「_」を付けない', () => {
    expect(nxSafeBase('Love♡', 'bgm')).toBe('Love');
    expect(nxSafeBase('A♡B', 'bgm')).toBe('A_B');
    expect(nxSafeBase('♡', 'bgm')).toBe('bgm');
    expect(nxSafeBase('song_', 'bgm')).toBe('song_');
  });
});

describe('「?」になった名前から曲フォルダのファイルを見つける', () => {
  const folder = () => folderFromFiles([new File(['a'], 'Love♡song.ogg'), new File(['b'], 'A〜B.ogg'), new File(['c'], 'bgm.ogg')], 'song');

  it('Shift_JIS で書いた名前（書けない文字は「?」、「〜」は「～」）でも、同じファイルが1つだけなら見つける', () => {
    const f = folder();
    expect(findFile(f, 'Love?song.ogg')?.name).toBe('Love♡song.ogg');
    expect(findFile(f, 'love?SONG.ogg')?.name).toBe('Love♡song.ogg');
    expect(findFile(f, 'A～B.ogg')?.name).toBe('A〜B.ogg');
    expect(findFile(f, 'bgm.ogg')?.name).toBe('bgm.ogg');
    // ASCII だけの別の名前は見つけない
    expect(findFile(f, 'bgm2.ogg')).toBeUndefined();
    expect(findFile(f, 'Love_song.ogg')).toBeUndefined();
  });

  it('Mac・iPad で作った名前（濁点が別の文字）も見つける', () => {
    const f = folderFromFiles([new File(['a'], 'ガイド.ogg'.normalize('NFD'))], 'song');
    expect(findFile(f, 'ガイド.ogg')?.size).toBe(1);
  });

  it('書ける名前に変えたあとのファイル（「?」が「_」）も、前の名前のまま残った譜面から見つける', () => {
    const f = folderFromFiles([new File(['a'], 'Love_song.ogg')], 'song');
    expect(findFile(f, 'Love?song.ogg')?.name).toBe('Love_song.ogg');
    // 開いている間は、前の名前（書けない文字のまま）からも
    expect(findFile(f, 'Love♡song.ogg')).toBeUndefined();
    f.renamed = new Map([['love♡song.ogg', 'Love_song.ogg']]);
    expect(findFile(f, 'Love♡song.ogg')?.name).toBe('Love_song.ogg');
  });

  it('どれか分からない（2つ以上ある）ときは選ばない', () => {
    const f = folderFromFiles([new File(['a'], 'a♡.ogg'), new File(['b'], 'a♥.ogg')], 'song');
    expect(findFile(f, 'a?.ogg')).toBeUndefined();
  });
});
