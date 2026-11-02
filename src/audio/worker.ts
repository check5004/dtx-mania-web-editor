// 原曲の解析とスロー再生用の伸長を、画面を止めないように別スレッドで行う。
import { analyzeAudio, computeSpectrogram } from './analysis';
import { wsola } from './stretch';

export type WorkerRequest =
  | { id: number; type: 'load'; key: string; channels: Float32Array[]; sr: number }
  | { id: number; type: 'analyze'; key: string }
  | { id: number; type: 'spectro'; key: string }
  | { id: number; type: 'stretch'; key: string; rate: number; from: number; to: number };

const store = new Map<string, { channels: Float32Array[]; sr: number }>();

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'load') {
      // 古い曲は捨てる（2曲まで持つ）
      store.delete(req.key);
      store.set(req.key, { channels: req.channels, sr: req.sr });
      while (store.size > 7) store.delete(store.keys().next().value!);
      post({ id: req.id, ok: true });
      return;
    }
    const src = store.get(req.key);
    if (!src) throw new Error('音声がまだ読み込まれていません');
    if (req.type === 'analyze') {
      const r = analyzeAudio(src.channels, src.sr, (p) => post({ id: req.id, progress: p }));
      const transfer = [r.peaks.buffer, ...Object.values(r.odf).map((a) => a.buffer), ...Object.values(r.env).map((a) => a.buffer)];
      post({ id: req.id, ok: true, result: r }, transfer as Transferable[]);
      return;
    }
    if (req.type === 'spectro') {
      const r = computeSpectrogram(src.channels, src.sr);
      post({ id: req.id, ok: true, result: r }, [r.data.buffer as ArrayBuffer]);
      return;
    }
    if (req.type === 'stretch') {
      const r = wsola(src.channels, src.sr, req.rate, req.from * src.sr, req.to * src.sr);
      post({ id: req.id, ok: true, result: { channels: r.channels, fromSec: r.fromSample / src.sr, sr: src.sr } }, r.channels.map((c) => c.buffer as ArrayBuffer));
      return;
    }
  } catch (err) {
    post({ id: req.id, ok: false, error: (err as Error).message });
  }
};
