// 原曲の解析とスロー再生用の伸長を、画面を止めないように別スレッドで行う。
import { tr, setLang, type Lang } from '../i18n';
import { alignFeatures, buildRefIndex, PROBE_SEC, ALIGN_FPS, probeFine, probeLocal, searchProbe, type AlignFeat, type RefIndex } from './align';
import { analyzeAudio } from './analysis';
import { findChorusAuto, type ChorusGrid } from './chorus';
import { computeFrameFeatures, type FrameFeatures } from './features';
import { renderSpectro, spectroDb, spectroZones, type SpecMode } from './spectro';
import { wsola } from './stretch';

export type WorkerRequest =
  /** エラーの文の言語（ワーカーは画面の言語を知らないので、作ったときと切り替えたときに知らせる） */
  | { id: number; type: 'lang'; lang: Lang }
  | { id: number; type: 'load'; key: string; channels: Float32Array[]; sr: number }
  | { id: number; type: 'analyze'; key: string }
  | { id: number; type: 'spectro'; key: string; mode: SpecMode }
  /** ドラム強調のスペクトルの帯ごとの明るさ（AI に渡す） */
  | { id: number; type: 'zones'; key: string; zones: { from: number; to: number }[] }
  | { id: number; type: 'features'; key: string }
  /** サビを探す（曲情報の「サビから作る」）。grid は譜面の小節の頭と拍（曲の音の秒。無ければ音から推定） */
  | { id: number; type: 'chorus'; key: string; grid: ChorusGrid | null }
  /** スロー再生用に伸ばす。音は伸ばす所（from〜to サンプル目）の前後を少し足したものを毎回渡す（ワーカーに音を残さない） */
  | { id: number; type: 'stretch'; channels: Float32Array[]; sr: number; rate: number; from: number; to: number }
  /** BPM の候補だけ（新しい譜面を作る前に原曲から推定する。音はワーカーに残さない） */
  | { id: number; type: 'tempo'; channels: Float32Array[]; sr: number }
  | { id: number; type: 'alignRef'; key: string }
  | { id: number; type: 'alignProbe'; key: string; pcm: Float32Array; sr: number }
  | { id: number; type: 'alignLocal'; key: string; probe: number; v: number; os: number[]; fine?: boolean };

const store = new Map<string, { channels: Float32Array[]; sr: number }>();
/** スペクトルの dB（見せ方を変えるときに測り直さない）。2曲ぶん */
const specCache = new Map<string, ReturnType<typeof spectroDb>>();

/** サビを探すための特徴（小節を変えて探し直すときに測り直さない）。2曲ぶん */
const chorusFeat = new Map<string, { feat: FrameFeatures; duration: number }>();

/** YouTube との自動合わせに使う原曲の特徴（1曲ぶん） */
let alignRef: { key: string; idx: RefIndex } | null = null;
/** 聞き取った音の特徴（あとで切れ目の所を細かく比べるため。番号ごと、新しいものを少し） */
const alignProbes = new Map<number, AlignFeat>();
let alignSeq = 0;

function alignIndex(key: string, src: { channels: Float32Array[]; sr: number }, progress?: (p: number) => void): RefIndex {
  if (alignRef?.key === key) return alignRef.idx;
  const feat = alignFeatures(src.channels, src.sr, progress);
  const idx = buildRefIndex(feat, PROBE_SEC * ALIGN_FPS);
  alignRef = { key, idx };
  alignProbes.clear();
  return idx;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === 'lang') {
    setLang(req.lang, false);
    return;
  }
  try {
    if (req.type === 'load') {
      // 古い曲は捨てる（2曲まで持つ）
      store.delete(req.key);
      specCache.delete(req.key);
      chorusFeat.delete(req.key);
      store.set(req.key, { channels: req.channels, sr: req.sr });
      while (store.size > 7) store.delete(store.keys().next().value!);
      post({ id: req.id, ok: true });
      return;
    }
    if (req.type === 'stretch') {
      const r = wsola(req.channels, req.sr, req.rate, req.from, req.to);
      post({ id: req.id, ok: true, result: { channels: r.channels, fromSample: r.fromSample, sr: req.sr } }, r.channels.map((c) => c.buffer as ArrayBuffer));
      return;
    }
    if (req.type === 'tempo') {
      post({ id: req.id, ok: true, result: analyzeAudio(req.channels, req.sr).tempo });
      return;
    }
    const src = store.get(req.key);
    if (!src) throw new Error(tr('音声がまだ読み込まれていません', "The audio isn't loaded yet"));
    if (req.type === 'analyze') {
      const r = analyzeAudio(src.channels, src.sr, (p) => post({ id: req.id, progress: p }));
      const transfer = [r.peaks.buffer, ...Object.values(r.odf).map((a) => a.buffer), ...Object.values(r.env).map((a) => a.buffer)];
      post({ id: req.id, ok: true, result: r }, transfer as Transferable[]);
      return;
    }
    if (req.type === 'spectro' || req.type === 'zones') {
      let db = specCache.get(req.key);
      if (!db) {
        db = spectroDb(src.channels, src.sr, (p) => post({ id: req.id, progress: p * 0.8 }));
        specCache.set(req.key, db);
        while (specCache.size > 2) specCache.delete(specCache.keys().next().value!);
      }
      const sp = renderSpectro(db.db, db.frames, db.fHi, req.type === 'zones' ? 'drum' : req.mode);
      const r = req.type === 'zones' ? spectroZones(sp, req.zones) : sp;
      post({ id: req.id, ok: true, result: r }, [r.data.buffer as ArrayBuffer]);
      return;
    }
    if (req.type === 'features') {
      const r = computeFrameFeatures(src.channels, src.sr, (p) => post({ id: req.id, progress: p }));
      const duration = (src.channels[0]?.length ?? 0) / src.sr;
      post({ id: req.id, ok: true, result: { frames: r, duration } }, [r.chroma.buffer, r.bands.buffer, r.flux.buffer] as Transferable[]);
      return;
    }
    if (req.type === 'chorus') {
      let f = chorusFeat.get(req.key);
      if (!f) {
        f = { feat: computeFrameFeatures(src.channels, src.sr, (p) => post({ id: req.id, progress: p * 0.85 })), duration: (src.channels[0]?.length ?? 0) / src.sr };
        chorusFeat.set(req.key, f);
        while (chorusFeat.size > 2) chorusFeat.delete(chorusFeat.keys().next().value!);
      }
      post({ id: req.id, progress: 0.9 });
      post({ id: req.id, ok: true, result: findChorusAuto(f.feat, f.duration, req.grid) });
      return;
    }
    if (req.type === 'alignRef') {
      alignIndex(req.key, src, (p) => post({ id: req.id, progress: p }));
      post({ id: req.id, ok: true, result: null });
      return;
    }
    if (req.type === 'alignProbe') {
      const idx = alignIndex(req.key, src);
      const feat = alignFeatures([req.pcm], req.sr);
      const r = searchProbe(idx, feat);
      const probe = ++alignSeq;
      alignProbes.set(probe, feat);
      while (alignProbes.size > 16) alignProbes.delete(alignProbes.keys().next().value!);
      post({ id: req.id, ok: true, result: { ...r, probe } }, r.zc ? [r.zc.buffer as ArrayBuffer] : []);
      return;
    }
    if (req.type === 'alignLocal') {
      const idx = alignIndex(req.key, src);
      const feat = alignProbes.get(req.probe);
      if (!feat) throw new Error(tr('聞き取った音がもうありません', 'The captured audio is no longer available'));
      const r = req.fine ? { local: probeFine(idx.feat, feat, req.v, req.os), floor: 0 } : probeLocal(idx.feat, feat, req.v, req.os);
      post({ id: req.id, ok: true, result: r }, r.local.map((x) => x.sim.buffer as ArrayBuffer));
      return;
    }
  } catch (err) {
    post({ id: req.id, ok: false, error: (err as Error).message });
  }
};
