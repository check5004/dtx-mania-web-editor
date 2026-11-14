// 「DTXMania の曲」の 1 曲の BGM を読んで、ドラムが入っているかを調べる（決まりは bgm.ts）。
// 読むのは、その曲のいちばん上の譜面 1 つと BGM の音 1 つだけ。どこにも送らない。結果は store.ts がこのブラウザに覚える。
import { normPath } from '../fs/folder';
import { decodeForSeparation } from '../separate/client';
import { isDrumlessName } from '../separate/names';
import { transcribe } from '../transcribe/client';
import { drumHits } from '../transcribe/peaks';
import { chartSigOf, checkFits, checkReusable, countBdSd, drumsByCount, listenWindows, perMinute, type BgmCheck } from './bgm';
import { fileAt } from './check';
import { bgmRefOf, decodeHead } from './parse';
import type { LibChart } from './scan';

/** 採譜に渡す音の速さ（ADTOF と同じ。分解の読み込みも 44.1kHz なので作り直さない） */
const SR = 44100;

/** BGM の音を聞いて、バスドラム・スネアの打点の 1 分あたりの数を出す（3 か所を採譜。採譜のモデルは初めてだけ読み込む） */
async function listen(file: File): Promise<number> {
  const audio = await decodeForSeparation(await file.arrayBuffer());
  const wins = listenWindows(audio.duration);
  let count = 0;
  for (const w of wins) {
    const a = Math.floor(w.from * SR);
    const b = Math.min(audio.left.length, Math.floor(w.to * SR));
    if (b <= a) continue;
    const data = await transcribe([audio.left.subarray(a, b), audio.right.subarray(a, b)], SR);
    count += countBdSd(drumHits(data, 0.5), (b - a) / SR);
  }
  return perMinute(count, wins);
}

/**
 * 1 曲の BGM を調べる。chart はいちばん上の譜面。prev（前の結果）が同じ譜面・同じ BGM のファイルのものなら、音は聞かずにそれを返す。
 * dir は読める曲のフォルダ（許可があること）
 */
export async function checkBgm(dir: FileSystemDirectoryHandle, chart: LibChart, prev?: BgmCheck): Promise<BgmCheck> {
  const head = { chart: chart.file, chartSig: chartSigOf(chart) };
  // BGM のファイル（譜面が前と同じなら決め直さない）
  let path = '';
  let name = '';
  if (checkFits(prev, chart)) {
    path = prev.path;
    name = prev.name;
  } else {
    const fh = await fileAt(dir, chart.file);
    if (!fh) return { ...head, path: '', name: '', sig: '', state: 'error' };
    const ref = bgmRefOf(decodeHead(new Uint8Array(await (await fh.getFile()).arrayBuffer()), true));
    if (!ref) return { ...head, path: '', name: '', sig: '', state: 'none' };
    // 譜面がサブフォルダにあれば、音はその譜面のフォルダから
    const slash = chart.file.lastIndexOf('/');
    const base = slash > 0 ? chart.file.slice(0, slash) : '';
    name = ref.name.split('/').pop() ?? ref.name;
    const keys = ref.keys.map((k) => (base ? normPath(`${base}/${k}`) : k));
    path = keys[0];
    for (const k of keys) {
      if (await fileAt(dir, k)) {
        path = k;
        break;
      }
    }
  }
  if (!path) return { ...head, path: '', name: '', sig: '', state: 'none' };
  const bh = await fileAt(dir, path);
  if (!bh) return { ...head, path, name, sig: '', state: 'missing' };
  const file = await bh.getFile();
  const sig = `${file.size}:${file.lastModified}`;
  if (checkReusable(prev, path, sig)) return { ...prev, ...head };
  if (isDrumlessName(name)) return { ...head, path, name, sig, state: 'named' };
  try {
    const perMin = Math.round((await listen(file)) * 10) / 10;
    return { ...head, path, name, sig, state: drumsByCount(perMin) ? 'drums' : 'clean', perMin };
  } catch {
    return { ...head, path, name, sig, state: 'error' };
  }
}
