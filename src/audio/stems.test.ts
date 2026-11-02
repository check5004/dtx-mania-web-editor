import { describe, expect, it } from 'vitest';
import { parseSidecar, serializeSidecar, emptySidecar } from '../store/sidecar';
import { detectStemKind, stemDisplayName, stemFilePath } from './stems';

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
  });
});
