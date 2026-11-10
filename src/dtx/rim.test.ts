import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { CH, SD_RIM, laneChannel, laneVoice, SD_LANE, voiceChannel, voiceLane, drumChannel } from './model';
import { chipAlt, chipVoice, isRimChip, isRimSound, looksLikeRim, rimWavs } from './rim';
import { parseDtx } from './parse';
import { mostUsedWav } from '../edit/ops';
import { findWavByFile, rimWavFor } from '../edit/rim';
import { velOfWav, wavVariant } from '../edit/velocity';

describe('リムの音の見分け方', () => {
  it('名前（ラベル・ファイル名）', () => {
    for (const s of ['037_Rimshot.ogg', '038_Snare_rimclick.ogg', 'Snare Rim', 'SE1 Side Stick', 'SnareRim.wav', 'SDRim.wav', 'sdrim.wav', 'rim.wav', 'dtxweb_std_rim.wav', 'XStick.wav', 'sd_xstick.ogg', 'Cross Stick', 'crossstick', 'side_stick.wav', 'リム', 'クローズドリム', 'サイドスティック', 'TR-808 Rim Shot']) {
      expect(looksLikeRim(s), s).toBe(true);
    }
    for (const s of ['039_Snare.ogg', 'SD Snare Drum 1', 'prime.wav', 'trim.wav', 'Crimson.wav', 'Hi-Hat Closed', 'Right Crash Mute', 'Tambourine', '37.ogg', 'Snare']) {
      expect(looksLikeRim(s), s).toBe(false);
    }
  });

  it('ラベルがあればラベル、無ければファイル名で決める', () => {
    expect(isRimSound('37.ogg', 'SE1 Side Stick')).toBe(true);
    expect(isRimSound('038_Snare_rimclick.ogg', 'Snare Rim')).toBe(true);
    // 作者がスネアと書いた音はリムにしない（オープンのリムショットをスネアの強打に使うなど）
    expect(isRimSound('040_Snare_rim.ogg', 'Snare')).toBe(false);
    expect(isRimSound('040_Snare_rim.ogg', null)).toBe(true);
    expect(isRimSound('dtxweb_std_rim.wav', null)).toBe(true);
    expect(isRimSound('039_Snare.ogg', null)).toBe(false);
    // スネアの音をリムとして使う（エディタがラベル「Snare Rim」を付けた番号）
    expect(isRimSound('039_Snare.ogg', 'Snare Rim')).toBe(true);
  });

  it('ラベルが古いまま、はっきり別の楽器のファイルを入れた定義はリムにしない', () => {
    expect(isRimSound('036_Kick.ogg', 'Snare Rim')).toBe(false);
    expect(isRimSound('BYB-PHIHAT.ogg', 'Snare Rim')).toBe(false);
    expect(isRimSound('047_HighMidTom.ogg', 'Snare Rim')).toBe(false);
    expect(isRimSound('049_CrashCymbal01.ogg', 'Snare Rim')).toBe(false);
  });
});

describe('リムのチップ', () => {
  const text = [
    '#WAV02: 039_Snare.ogg\t;Snare',
    '#WAV0W: 038_Snare_rimclick.ogg\t;Snare Rim',
    '#WAV0X: 37.ogg\t;SE1 Side Stick',
    '#WAV0Y: 036_Kick.ogg\t;Snare Rim',
    '#00112: 020W0X02',
    '#00161: 0W',
    '#00113: 0W',
    '#00132: 0W',
  ].join('\n');
  const { doc } = parseDtx(text);

  it('スネアのレーンでリムの音のチップだけがリム', () => {
    expect([...rimWavs(doc)].sort()).toEqual([32, 33]);
    const sd = doc.chips.filter((c) => c.ch === CH.SD);
    expect(sd.map((c) => isRimChip(doc, c))).toEqual([false, true, true, false]);
    expect(sd.map((c) => chipAlt(doc, c))).toEqual([false, true, true, false]);
    expect(sd.map((c) => chipVoice(doc, c))).toEqual([CH.SD, SD_RIM, SD_RIM, CH.SD]);
    // SE・ほかのレーンのチップはリムにしない
    const se = doc.chips.find((c) => c.ch === 0x61)!;
    expect(isRimChip(doc, se)).toBe(false);
    const bd = doc.chips.find((c) => c.ch === CH.BD)!;
    expect(chipVoice(doc, bd)).toBe(CH.BD);
    // 不可視のスネアのチップもリム
    const hidden = doc.chips.find((c) => c.ch === 0x32)!;
    expect(isRimChip(doc, hidden)).toBe(true);
  });

  it('スネアのレーンの2種目はリム（チャンネルはスネアのまま、音の番号は SD_RIM）', () => {
    expect(laneChannel(SD_LANE, true)).toBe(CH.SD);
    expect(laneVoice(SD_LANE, true)).toBe(SD_RIM);
    expect(laneVoice(SD_LANE, false)).toBe(CH.SD);
    expect(voiceChannel(SD_RIM)).toBe(CH.SD);
    expect(voiceLane(SD_RIM)).toEqual({ lane: SD_LANE, alt: true });
    // スネアのチャンネルは2種目にならない（リムかは音で見る）
    expect(drumChannel(CH.SD)?.alt).toBe(false);
    expect(laneVoice(1, true)).toBe(CH.HHO);
    expect(laneChannel(1, true)).toBe(CH.HHO);
  });
});

describe('リムの音のベロシティ違い', () => {
  const { doc } = parseDtx(['#WAV02: 039_Snare.ogg', '#WAV0W: 039_Snare.ogg\t;Snare Rim', '#00112: 0W02'].join('\n'));

  it('リムのベロシティ違いはリム（ラベルを写す）、スネアのベロシティ違いはスネア', () => {
    const next = produce(doc, (d) => {
      d.chips[0].v = wavVariant(d, 32, 50);
      d.chips[1].v = wavVariant(d, 2, 50);
    });
    const [rim, sd] = next.chips;
    expect(rim.v).not.toBe(32);
    expect(sd.v).not.toBe(2);
    expect(rim.v).not.toBe(sd.v);
    expect(isRimChip(next, rim)).toBe(true);
    expect(isRimChip(next, sd)).toBe(false);
    expect(velOfWav(next.fields, rim.v)).toBe(50);
  });

  it('いちばん使う音は、スネアとリムで別に数える', () => {
    const used = mostUsedWav(doc);
    expect(used.get(CH.SD)).toBe(2);
    expect(used.get(SD_RIM)).toBe(32);
  });
});

describe('リムの音の番号を探す・作る', () => {
  it('スネアの音をリムに選んだら、同じファイルでラベル「Snare Rim」の番号を作る（2回目からはそれを使う）', () => {
    const { doc } = parseDtx(['#WAV02: 039_Snare.ogg', '#VOLUME02: 80', '#00112: 02'].join('\n'));
    let first = 0;
    const next = produce(doc, (d) => {
      first = rimWavFor(d, 2);
    });
    expect(first).not.toBe(2);
    expect(rimWavs(next).has(first)).toBe(true);
    expect(next.fields['VOLUME' + first.toString(36).toUpperCase().padStart(2, '0')]).toBe('80');
    let again = 0;
    produce(next, (d) => {
      again = rimWavFor(d, 2);
    });
    expect(again).toBe(first);
    // はっきり別の楽器の音はリムにしない（番号を作り続けない）
    const kick = parseDtx('#WAV01: 036_Kick.ogg').doc;
    let k = 0;
    produce(kick, (d) => {
      k = rimWavFor(d, 1);
    });
    expect(k).toBe(1);
  });

  it('キットのファイルの番号は、リムかどうかが同じものだけ', () => {
    const { doc } = parseDtx(['#WAV02: kit_sd.wav', '#WAV03: kit_sd.wav\t;Snare Rim'].join('\n'));
    expect(findWavByFile(doc, 'kit_sd.wav', false)).toBe(2);
    expect(findWavByFile(doc, 'kit_sd.wav', true)).toBe(3);
    expect(findWavByFile(doc, 'other.wav', true)).toBeNull();
  });
});
