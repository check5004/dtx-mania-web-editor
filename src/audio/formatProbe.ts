// 音声の形式を、このブラウザの decodeAudioData で読めるか確かめる（設定の「音の出力」）。
// 曲の音はほとんど OGG（Vorbis）。Safari は 18.4 より前は OGG を読めない。docs/safari.md
// 中身は 0.1 秒の 440Hz（ffmpeg で作った小さなファイル）。
import { engine } from './engine';

// i18n-ignore-start
const OGG_VORBIS =
  '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' +
  'OAEAjySJomRZoihZliiKpui6omi6rqRppqlpnmlammeapmmqsimarixpmmlanmaamqeZpmiarmuapqyKpinLpmrKsmmasuy6sm27rmzbomnKsmmasmyapiy7sqvbruzquqRZpql5nmlqnmeapmrKsmmarqt5nmp6' +
  'nmiqniiqqmqqqq2qqixbnmeamuippieKqmqqpq2aqirLpqrasmmqtmyqqm27quz6sm3rummqsm2qpi2bqmrbruzqsizbui9pmmlqnmeamueZpmmasmyaqitbnqeaniiqquaJpmqqqiybpqrKlueZqieKquqJnmua' +
  'qirLpmraqmmatmyqqi2bpirLrm37vuvKsm6qqmybqmrrpmrKsmzLvu/Kqu6KpinLpqrasmmqsi3bsu/Lsqz7omnKsmmqsm2qqi7Lsm0bs2z7umiasm2qpi2bqirbsi37uizbuu/Krm+rqqzrsi37uu76rnDrujC8' +
  'smz7qqz6uivbum/rMtv2fUTTlGVTNW3bVFVZdmXZ9mXb9n3RNG1bVVVbNk3VtmVZ9n1Ztm1hNE3ZNlVV1k3VtG1Zlm1htmXhdmXZt2Vb9nXXlXVf133j12Xd5rqy7cuyrfuqq/q27vvCcOuu8AoAABhwAAAIMKEM' +
  'FBqyEgCIAgAAjGGMMQiNUs45B6FRyjnnIGTOQQghlcw5CCGUkjkHoZSUMucglJJSCKGUlFoLIZSUUmsFAAAUOAAABNigKbE4QKEhKwGAVAAAg+NYlueZomrasmNJnieKqqmqtu1IlueJommqqm1bnieKpqmqruvr' +
  'mueJommqquvqumiapqmqruu6ui6aoqmqquu6sq6bpqqqriu7suzrpqqqquvKriz7wqq6rivLsm3rwrCqruvKsmzbtm/cuq7rvu/7wpGt67ou/MIxDEcBAOAJDgBABTasjnBSNBZYaMhKACADAIAwBiGDEEIGIYSQ' +
  'UkohpZQSAAAw4AAAEGBCGSg0ZEUAECcAABhDKaSUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJIKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKqaSUUkoppZRSSimllFJKKaWU' +
  'UkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWU' +
  'UkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKZVSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRS' +
  'SimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUgoAkIpwAJB6MKEMFBqyEgBIBQAAjFFKKcacgxAx5hhj0EkoKWLMOcYclJJS5RyEEFJpLbfKOQghpNRSbZlzUlqL' +
  'MeYYM+ekpBRbzTmHUlKLseaaa+6ktFZrrjXnWlqrNdecc825tBZrrjnXnHPLMdecc8455xhzzjnnnHPOBQDgNDgAgB7YsDrCSdFYYKEhKwGAVAAAAhmlGHPOOegQUow55xyEECKFGHPOOQghVIw55xx0EEKoGHPM' +
  'OQghhJA55xyEEEIIIXMOOugghBBCBx2EEEIIoZTOQQghhBBKKCGEEEIIIYQQOgghhBBCCCGEEEIIIYRSSgghhBBCCaGUUAAAYIEDAECADasjnBSNBRYashIAAAIAgByWoFLOhEGOQY8NQcpRMw1CTDnRmWJOajMV' +
  'U5A5EJ10EhlqQdleMgsAAIAgACDABBAYICj4QgiIMQAAQYjMEAmFVbDAoAwaHOYBwANEhEQAkJigSLu4gC4DXNDFXQdCCEIQglgcQAEJODjhhife8IQbnKBTVOogAAAAAAAMAOABAOCgACIimquwuMDI0Njg6PAI' +
  'AAAAAAAWAPgAADg+gIiI5iosLjAyNDY4OjwCAAAAAAAAAACAgIAAAAAAAEAAAACAgE9nZ1MABDoRAAAAAAAAYz2BtgIAAAB9Yea3BhgsHh8gRXTh5bf+9b+cQPB6K6/YXnwxPhqNBrouAdp5XoO75HXEAuekCiAh' +
  'CgAAAAAAAAAI3BMAyfG//9cse1hONdUHbHt9vRgAHno+lbuUdrMJTm4VsBrA718KAAAAAAAAAACobzMAHno+1buUebMNTm5VcFIAAAAAAAAAAOgNAADA458mAN553q27lPmwC5wUcFIAAAAAAAAAADhvAC5mBO7c' +
  'LQUA3gheht0F0ivi1w0HOMUBD08kgEQBAAB4vCOd+oRTvEnU9g3dZrgVKortjFecUiZlsva69rr2uvasPMvTymn1IQA0JoAF';

const OGG_OPUS =
  'T2dnUwACAAAAAAAAAABeyLbZAAAAAEHblbMBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAF7IttkBAAAAZzWIqwE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZj' +
  'NjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAT4EwAAAAAAAF7IttkCAAAAAYRKLAYzLSgpIRRIgi63bFa39AAB5c2d7Rqm6QXqFZBnYqQLkptcTJU3EEPryGUs8PyDMNiH21kInX4kEqBIpIhXrJiFA1wmCZPn0jAIBRG9' +
  'gFmHyICwK0fsWCaKq82dGUl2s6aTevgoephInBtSUUUArOMPxbifySZ8fLu402Ur1ZxYYDbUSiBnzd+/zyuvbFvZSJwbUlbOH+oRQROwZGn/HVtWAJUlLQKPhrgiyVbOuXsxbTnlNTufSbBInBufdZz8STO/Qf+3' +
  'kP8asY+xSkakHHCcLQpPNQD2DkRIBerF8BHniBbohWhmkXTo6NS7wA==';

const MP3 =
  'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAACwABoaGhoaGhoaGhoaGhoaGhoaGhojo6Ojo6Ojo6Ojo6Ojo6Ojo6O' +
  'jo60tLS0tLS0tLS0tLS0tLS0tLS0tNra2tra2tra2tra2tra2tra2tra//////////////////////////8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAMGAAAAAAAAAsA9ZMBtAAAAAAD/+xDEAAAEdBNVVJCA' +
  'MKYJrzcaIAIAAa05QAABWTo9UFAIBgkB8HwfB8oCAIBhEHwf1Ag7E4f4g3AEk/bAYDgcDgAAAAAAKIkqmRRkCOkCSBaj94UB8BMb8CKUL6gaEvwkDSoKABgwAP/7EsQCg8VYHSAd4AAomwPjQa9oTMwJALxABIYA' +
  '4Hhn7vamYwOWYcQRJgwAfmBCBgYFIExgXgPFmrSVh5gghmT5xLRhfiimq9Sian4ophhAzHPemfSmaPGbjmJCuJTgm76qMNDjDh0x0//7EMQDg8UEHxgN+yJArYRigb9sSIM+gzCvG+NQzhw06xtDCeBtNcwCBm6o' +
  'dX5rBsmloc/X9CRBiYiZscG7xpiXDtHBX1wb/A7hiahPnCMhniMZmfmZPBiwsweMU+Af+r6KMKETDxwx//sSxAMDxQAfGA37IkC0BCQCvAAFo7M9hjCmHJNNvms0uBvzCXBwNJEBBG8mdvhrhM1ng3+v6HZEIApg' +
  'PgLmAsC4YMQbRpRMKmgSPeYgIVZg+gXmAqCCYHIGJgagYg0AGL28FI0BIgEC//sQxAKABPw7SBmjgACQhaDDnmAAGC8LCjIInhXB8mWsMWMlNv3IilnHB2N5vJkAREWZhUFfljwswAOAFQxjtE1PET4BaLyT4TYy' +
  'n6dQ1W6kiAQkJA1Bo99Z3iJMQU1FMy4xMDCqqqo=';
// i18n-ignore-end

function bytesOf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** 0.1 秒の 440Hz の WAV（16bit・モノラル・44.1kHz） */
function wavBytes(): ArrayBuffer {
  const sr = 44100;
  const n = Math.round(sr * 0.1);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 8000), true);
  return buf;
}

export interface FormatResult {
  /** 形式の名前（画面にそのまま出す） */
  name: string;
  ok: boolean;
}

/** OGG（Vorbis・Opus）・MP3・WAV を読めるか */
export async function probeFormats(): Promise<FormatResult[]> {
  const list: [string, () => ArrayBuffer][] = [
    ['OGG Vorbis', () => bytesOf(OGG_VORBIS)],
    ['OGG Opus', () => bytesOf(OGG_OPUS)],
    ['MP3', () => bytesOf(MP3)],
    ['WAV', wavBytes],
  ];
  const out: FormatResult[] = [];
  for (const [name, make] of list) {
    let ok = false;
    try {
      const buf = await engine.decodeAudio(make());
      ok = buf.duration > 0.05;
    } catch {
      ok = false;
    }
    out.push({ name, ok });
  }
  return out;
}
