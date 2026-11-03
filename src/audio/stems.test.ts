import { describe, expect, it } from 'vitest';
import { parseSidecar, serializeSidecar, emptySidecar } from '../store/sidecar';
import { detectStemKind, guessStems, isKindLabel, stemDisplayName, stemFilePath, uniqueStemName } from './stems';
import { renameOldOtherStems } from './stemNames';
import type { StemTrack } from '../store/sidecar';

const names = (files: string[], o = {}) => guessStems(files, o).map((g) => `${g.kind}:${g.name}`);

describe('ステム', () => {
  it('ファイル名から種類を決める', () => {
    expect(detectStemKind('drums.wav')).toBe('drums');
    expect(detectStemKind('Neon Skyline (Drums).wav')).toBe('drums');
    expect(detectStemKind('song_bass.flac')).toBe('bass');
    expect(detectStemKind('vocals.ogg')).toBe('vocals');
    expect(detectStemKind('song (Instrumental).wav')).toBe('other');
    expect(detectStemKind('guitar-L.wav')).toBe('guitar');
    expect(detectStemKind('piano.mp3')).toBe('piano');
    expect(detectStemKind('other.wav')).toBe('other');
    expect(detectStemKind('foo.wav')).toBe('other');
    // 濁点が分かれた名前（Mac・Google ドライブの zip）でも分かる
    expect(detectStemKind('back number - 水平線_ドラム_mixed.mp3'.normalize('NFD'))).toBe('drums');
    expect(detectStemKind('back number - 水平線_ベース_mixed.mp3'.normalize('NFD'))).toBe('bass');
    expect(detectStemKind('back number - 水平線_ボーカル1_mixed.mp3'.normalize('NFD'))).toBe('vocals');
    expect(detectStemKind('back number - 水平線_その他_mixed.mp3'.normalize('NFD'))).toBe('other');
  });

  it('ファイル名の書き方がいろいろでも種類が分かる', () => {
    const kind = (f: string) => detectStemKind(f);
    // 半角カナ・全角英字・ひらがな・大文字・略語
    expect(['ﾄﾞﾗﾑ.wav', 'ＤＲＵＭＳ.wav', 'どらむ.wav', 'DRUM.WAV', 'Drums.wav', 'ドラムス.wav', '01_Dr.wav', 'drumkit.wav'].map(kind)).toEqual(Array(8).fill('drums'));
    // 濁点だけの文字（゛）が付いた名前
    expect(kind('ト\u309Bラム.wav')).toBe('drums');
    // パーツごとのステムもドラム（BassDrum はベースではない）
    expect(['BassDrum.wav', 'Kick In.wav', 'snare_top.wav', 'HiHat.wav', 'Overheads.wav', 'Toms.wav', 'perc.wav', 'バスドラ.wav'].map(kind)).toEqual(Array(8).fill('drums'));
    expect(['02_Ba.wav', 'Bass Guitar.wav', 'Synth Bass.wav', 'シンセベース.wav'].map(kind)).toEqual(Array(4).fill('bass'));
    expect(['04_Vo.wav', 'Lead Vox.wav', 'BGV.wav', 'ヴォーカル.wav', 'コーラス.wav'].map(kind)).toEqual(Array(5).fill('vocals'));
    expect(['03_Gt1.wav', 'エレキギター.wav', 'アコギ.wav'].map(kind)).toEqual(Array(3).fill('guitar'));
    expect(['Keys.wav', 'E.Piano.wav', 'ピアノ.wav'].map(kind)).toEqual(Array(3).fill('piano'));
    // 「ドラム抜き」はドラムではない（BGM用の書き出しで外されると困る）
    expect(['1_Song_(No Drums).wav', 'song_no_drum.mp3', 'Drumless.wav', 'ドラム抜き.wav', 'ドラムなし.mp3'].map(kind)).toEqual(Array(5).fill('other'));
    // 曲名に楽器の語があっても、後ろに付いた楽器で決める
    expect(kind('Drum and Bass Song (Vocals).wav')).toBe('vocals');
    expect(kind('歌うたいのバラッド_ドラム.mp3')).toBe('drums');
    // 別の語の一部は楽器にしない
    expect(['カスタム.wav', 'Tomorrow.wav', 'bassoon.wav', 'install.wav'].map(kind)).toEqual(Array(4).fill('other'));
  });

  it('まとめて読み込むと、共通の部分を除いた残りを名前にする', () => {
    const zip = ['ベース', 'ドラム', '弦楽器', 'ボーカル1', 'その他'].map((s) => `back number - 水平線_${s}_mixed.mp3`.normalize('NFD'));
    expect(names(zip)).toEqual(['bass:ベース', 'drums:ドラム', 'other:弦楽器', 'vocals:ボーカル1', 'other:その他']);
    // 1つずつ読み込んでも同じ
    expect(zip.map((f) => names([f])[0])).toEqual(['bass:ベース', 'drums:ドラム', 'other:弦楽器', 'vocals:ボーカル1', 'other:その他']);
    // あとから足したファイルは、もうあるステムと見比べる
    const rest = zip.filter((_, i) => i !== 2).map((f) => `stems/${f.normalize('NFC')}`);
    expect(names([zip[2]], { existing: rest, taken: ['ベース', 'ドラム', 'ボーカル1', 'その他'] })).toEqual(['other:弦楽器']);
    // 分離ソフトの名前
    expect(names(['drums.wav', 'bass.wav', 'other.wav', 'vocals.wav'])).toEqual(['drums:ドラム', 'bass:ベース', 'other:その他', 'vocals:ボーカル']);
    expect(names(['vocals.wav', 'accompaniment.wav'])).toEqual(['vocals:ボーカル', 'other:伴奏']);
    expect(names(['1_Song Title_(Drums).wav', '1_Song Title_(No Drums).wav', '1_Song Title_(Instrumental).wav'])).toEqual(['drums:ドラム', 'other:ドラム抜き', 'other:インスト']);
    expect(names(['Song-Lead Vocals.mp3', 'Song-Backing Vocals.mp3', 'Song-drums.mp3'])).toEqual(['vocals:リードボーカル', 'vocals:コーラス', 'drums:ドラム']);
    // 表に無い語はファイル名に書いてあるまま
    expect(names(['Song_Gt Lead_mix.wav', 'Song_Gt Rhythm_mix.wav'])).toEqual(['guitar:Gt Lead', 'guitar:Gt Rhythm']);
    // 曲名の頭の略語（Dr.）は楽器ではない
    expect(names(['Dr. Stone - drums.wav', 'Dr. Stone - bass.wav'])).toEqual(['drums:ドラム', 'bass:ベース']);
    // 同じ名前になれば番号を付ける
    expect(names(['drums.wav', 'Drums 2.wav', 'drum.wav'])).toEqual(['drums:ドラム', 'drums:ドラム2', 'drums:ドラム3']);
    // 楽器の語が無ければ、曲名・アーティスト名と _mixed などを除いたファイル名
    expect(names(['back number - 水平線_Lead_mixed.mp3'], { hints: ['水平線', 'back number'] })).toEqual(['other:Lead']);
  });

  it('名前を重ねない・種類のままの名前か見分ける', () => {
    expect(uniqueStemName('ドラム', ['ドラム', 'ドラム2'])).toBe('ドラム3');
    expect(uniqueStemName('ボーカル1', ['ボーカル1'])).toBe('ボーカル1-2');
    expect(uniqueStemName('Drums', ['drums'])).toBe('Drums2');
    expect(['その他', 'その他2', 'ドラム', 'ボーカル1-2'].every(isKindLabel)).toBe(true);
    expect(['弦楽器', 'Lead', 'キック', 'ドラム抜き'].some(isKindLabel)).toBe(false);
  });

  it('前の版で「その他」になったステムを付け直す（自分で付けた名前は変えない）', () => {
    const zip = ['ベース', 'ドラム', '弦楽器', 'ボーカル1', 'その他'].map((s) => `stems/back number - 水平線_${s}_mixed.mp3`.normalize('NFD'));
    const st = (file: string, name: string, kind: StemTrack['kind'] = 'other'): StemTrack => ({ file, name, kind, gain: 1, pan: 0, mute: false, solo: false, offsetMs: 0 });
    const old = [st(zip[0], 'その他'), st(zip[1], 'その他2'), st(zip[2], 'ストリングス'), st(zip[3], 'その他4'), st(zip[4], 'その他5')];
    const fixed = renameOldOtherStems(old);
    expect(fixed.map((t) => `${t.kind}:${t.name}`)).toEqual(['bass:ベース', 'drums:ドラム', 'other:ストリングス', 'vocals:ボーカル1', 'other:その他']);
    expect(fixed[0]).toMatchObject({ gain: 1, file: zip[0] });
    // 付け直すものが無ければそのまま
    const ok = [st('stems/drums.wav', 'ドラム', 'drums')];
    expect(renameOldOtherStems(ok)).toBe(ok);
    // 作業ファイルを読むときに直る
    const back = parseSidecar(serializeSidecar({ ...emptySidecar(), stems: old }))!;
    expect(back.stems.map((t) => t.name)).toEqual(['ベース', 'ドラム', 'ストリングス', 'ボーカル1', 'その他']);
  });

  it('表示名とファイルの置き場所は重ならないようにする', () => {
    expect(stemDisplayName('drums', [])).toBe('ドラム');
    expect(stemDisplayName('drums', ['ドラム'])).toBe('ドラム2');
    expect(stemFilePath('drums.wav', [])).toBe('stems/drums.wav');
    expect(stemFilePath('drums.wav', ['stems/Drums.wav'])).toBe('stems/drums_2.wav');
    expect(stemFilePath('a/b:c.wav', [])).toBe('stems/a_b_c.wav');
  });

  it('作業ファイルにステムとミックスを書いて読める', () => {
    const d = {
      ...emptySidecar(),
      stems: [{ file: 'stems/drums.wav', name: 'ドラム', kind: 'drums' as const, gain: 0.8, pan: -0.2, mute: false, solo: true, offsetMs: 12 }],
      analysisStem: 'stems/drums.wav',
      mix: { bgm: 0.7, drums: 0.6, bgmMute: true, drumMute: false, metronome: true, click: 0.3, clickBarOnly: true, listen: 'compare' as const },
    };
    const back = parseSidecar(serializeSidecar(d))!;
    expect(back.stems).toEqual(d.stems);
    expect(back.analysisStem).toBe('stems/drums.wav');
    expect(back.mix).toEqual(d.mix);
    // 壊れた値は直して読む
    const bad = parseSidecar(JSON.stringify({ stems: [{ file: 'x.wav', kind: 'kazoo', gain: 9 }], analysisStem: 'nope' }))!;
    expect(bad.stems[0]).toMatchObject({ kind: 'other', gain: 2, pan: 0 });
    expect(bad.analysisStem).toBeNull();
    // 原曲・譜面の音のトラックのミュート・ソロ（前の作業ファイルには無い）
    const withTracks = { ...d, mix: { ...d.mix, origMute: true, origSolo: false, drumSolo: true } };
    expect(parseSidecar(serializeSidecar(withTracks))!.mix).toEqual(withTracks.mix);
    expect(back.mix!.origMute).toBeUndefined();
    // SE のトラック（音量・ミュート・ソロ。前の作業ファイルには無い）
    const withSe = { ...d, mix: { ...d.mix, se: 0.4, seMute: true, seSolo: false } };
    expect(parseSidecar(serializeSidecar(withSe))!.mix).toEqual(withSe.mix);
    expect(back.mix!.se).toBeUndefined();
  });
});
